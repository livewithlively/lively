// 중앙 박스 — 세션 작업 디렉터리(@box_dir) 파일 API. 익스플로러/업로드/다운로드/미리보기용.
// 게이트: canAttach(소유자 OR 초대된 멤버) — 터미널을 열 수 있으면 셸로 어차피 그 폴더를 만질 수 있으므로 동일 권한.
// 봉쇄: 모든 경로를 @box_dir 내부로 realpath 검증(.. 탈출 차단).
//
// 공유 루트 브라우저(#1291 v2 · 트랙 C): 위 세션 스코프 API 와 달리 `/browse*` 는 **세션과 무관한 공유 워크스페이스**를
//  통째로 연다 — 지금까지 게이트가 auth 뿐이라 대시보드에서 클릭 두 번이면 조직 전체의 파일을 목록·다운로드·삭제할 수
//  있었다. 여기에 경로 단위 공개범위(shared-folder-store)를 건다. 거부는 **404**(존재 은닉 — 403 은 "거기 뭔가 있다"를
//  알려주는 오라클이다). 세션 스코프(`/sessions/:id/*`)는 이미 canAttach 로 닫혀 있으므로 중복해서 걸지 않는다.
import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { sessionOrBearer } from "../auth/http-auth.js";
import type { BearerVerifier } from "../auth/bearer.js";
import type { LivelyUser } from "../context.js";
import { wrap, HttpError } from "../http/rest-util.js";
import { viewerOf } from "../capabilities/principal.js";
import { canAttach, sessionDir, resolveRootPath, rootRelOf, sessionOsUser, userOsUser } from "./terminal-sessions.js";
import { memberLs, memberStat, memberMkdir, memberMv, memberRm, memberReadTo, type LsEntry } from "./terminal-member-fs.js";
import { receiveUpload, uploadError, nfcPath } from "./upload-file.js";
import { nodeCanAttach, nodeRpc } from "../node/registry.js";
import { folderVariants } from "../project/project-fs.js";
import {
  sharedFolderGate, renameSharedFolderAclPrefix, restrictedProjectFolders, projectFolderOf,
  type SharedFolderGate,
} from "../v6/shared-folder-store.js";

const MAX_UPLOAD = 50 * 1024 * 1024; // 50MB
// 인라인 미리보기 상한 — 프로젝트 파일 라우트(project-routes.ts MAX_PREVIEW)와 **같은 값**이어야 한다(#1436):
//  공유 링크는 root+path 하나로 공유/개인/프로젝트 폴더를 똑같이 가리키는데, 같은 파일이 어느 라우트를 타는지에
//  따라 "미리보기엔 너무 큽니다"가 갈리면 링크를 받은 사람에게는 그게 그냥 고장으로 보인다.
//  (종전 2MB 는 대시보드 위젯 미리보기만 염두에 둔 값이라 5MB PDF 보고서조차 링크로 열리지 않았다.)
const MAX_PREVIEW = 25 * 1024 * 1024; // 25MB
const userOf = (req: express.Request): LivelyUser => (req.auth?.extra ?? {}) as unknown as LivelyUser;
const idOf = (u: LivelyUser): string => u.userId || u.email || "";

// @box_dir 기준 안전 경로 해소(+ 접근권한 확인). rel 의 .. 탈출은 거부.
async function resolveInSession(req: express.Request, requireFile: boolean, canonical = false): Promise<{ base: string; abs: string }> {
  const id = req.params.id;
  if (!(await canAttach(id, idOf(userOf(req))))) throw new HttpError(403, "세션 접근 권한이 없습니다");
  const base = path.resolve(await sessionDir(id));
  const raw = canonical ? nfcPath(req.query.path) : String(req.query.path ?? "");   // 생성만 NFC 정본(#1278b)
  const rel = raw.replace(/^[/\\]+/, "");
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new HttpError(400, "허용 경로를 벗어났습니다");
  if (requireFile && (rel === "" || abs === base)) throw new HttpError(400, "파일 경로가 필요합니다");
  return { base, abs };
}

// 노드 세션 파일 릴레이(#875) — ?node= 면 게이트웨이가 nodeCanAttach 로 인가(정책=게이트웨이, 실행=노드 F7)하고 nodeId 반환.
//  중앙 세션이면 null(로컬 fs 경로). 거부 코드: 4410 gone→404 · 4462 offline→503 · 그 외 no-access→403.
async function nodeFor(req: express.Request): Promise<string | null> {
  const nodeId = String(req.query.node ?? "").trim();
  if (!nodeId) return null;
  const v = await nodeCanAttach(nodeId, req.params.id, idOf(userOf(req)));
  if (!v.ok) throw new HttpError(v.code === 4410 ? 404 : v.code === 4462 ? 503 : 403, v.reason);
  return nodeId;
}
const NODE_FS_CHUNK = 256 * 1024; // base64 하면 ~341KB < ws maxPayload(1MB). 파일 바이트를 이 크기로 청크.

// 경로 공개범위를 태우는 루트 — 'personal' 은 애초에 멤버별로 갈린 폴더라 잠글 대상이 없다(비파괴).
const SHARED_ROOT_KEY = "shared";

export function registerTerminalFiles(app: express.Express, verifier: BearerVerifier): void {
  const auth = sessionOrBearer(verifier); // 세션 쿠키(웹 로그인) OR bearer(에이전트) — 둘 다 수용

  // 이 요청의 **열람 신원**(#1291). MCP·REST 어댑터가 쓰는 규칙(capabilities/principal.viewerOf)을 그대로 쓴다 —
  //  사람과 그 사람의 AI 가 같은 답을 받아야 하기 때문이다(admin 도 우회하지 않는다: v2 정책).
  //  ⚠ idOf(email 폴백)와 다르다: grant 는 org_member.id 로 걸리므로 여기서 email 로 흘리면 대조가 어긋난다.
  const viewerFor = (req: express.Request): string | null => viewerOf(userOf(req));

  // 공유 루트 요청이면 경로 게이트를, 아니면 null(=검사 없음)을 준다. 목록처럼 여러 번 물을 자리는
  //  이 게이트를 **한 번만** 만들어 항목마다 동기로 물어본다(항목마다 DB 를 때리지 않게).
  const browseGate = async (req: express.Request): Promise<SharedFolderGate | null> =>
    (String(req.query.root ?? "") === SHARED_ROOT_KEY ? await sharedFolderGate(viewerFor(req)) : null);

  // 안 보이는 경로는 **404**로 막는다 — 403 은 "거기 뭔가 있다"를 알려주는 오라클이라 존재 자체를 숨기지 못한다.
  const assertBrowseVisible = (gate: SharedFolderGate | null, base: string, abs: string): void => {
    if (gate && !gate.ok(path.relative(base, abs))) throw new HttpError(404, "경로를 찾을 수 없습니다");
  };

  // 루트 브라우즈용 경로 해소(+접근 osUser). requireSub=true 면 루트 자체(base)는 거부(대상 경로 필요).
  //  경로 봉쇄(루트 내부, .. 탈출 거부)는 resolveRootPath 가 이미 건다. 공개범위 게이트는 여기서 함께 건다(#1291) —
  //  rename·삭제·다운로드·업로드가 전부 이 함수를 지나므로, 새 라우트가 늘어도 게이트가 빠지지 않는다.
  //  canonical=true 는 **생성 경로 전용** — 저장 이름을 NFC 정본으로 통일한다(#1278b).
  //  읽기·삭제에 켜면 예전에 NFD 로 저장된 파일에 접근할 수 없게 되므로 절대 켜지 않는다.
  async function resolveBrowse(req: express.Request, requireSub: boolean, canonical = false): Promise<{ base: string; abs: string; osUser: string | null }> {
    const u = userOf(req);
    const raw = String(req.query.path ?? "");
    const { base, abs } = await resolveRootPath(u, String(req.query.root ?? ""), canonical ? nfcPath(raw) : raw);
    if (requireSub && abs === base) throw new HttpError(400, "대상 경로가 필요합니다");
    assertBrowseVisible(await browseGate(req), base, abs);
    const osUser = await userOsUser(u);
    return { base, abs, osUser };
  }

  // 생성폼 폴더 탐색 + 공유 폴더 브라우저(세션 무관) — 허용 루트 내부 목록. 격리 멤버면 그 uid 로(개인 루트=멤버 홈 700).
  //  dirs = 폴더명(하위호환: 생성폼 폴더 피커·대시보드 박스). items = 폴더+파일(type·size, 대시보드 폴더 브라우저 #672).
  app.get("/api/ui/terminal/browse", auth, wrap(async (req, res) => {
    const u = userOf(req);
    const { base, abs } = await resolveRootPath(u, String(req.query.root ?? ""), String(req.query.path ?? ""));
    // 공개범위(#1291) — ①이 폴더 자체가 안 보이면 404(존재 은닉) ②목록은 안 보이는 하위 항목을 빼고 준다.
    //  게이트를 여기서 한 번만 만들어 항목마다 재사용한다(수백 항목 × DB 왕복 방지).
    const gate = await browseGate(req);
    assertBrowseVisible(gate, base, abs);
    const restrictedProjects = gate ? await restrictedProjectFolders() : new Set<string>();
    const osUser = await userOsUser(u);
    const items: Array<{ name: string; type: "dir" | "file"; size: number; mtime: number; locked?: boolean }> = [];
    if (osUser) {
      await memberMkdir(osUser, base).catch(() => { /* 루트 없으면 생성 */ });
      let entries: LsEntry[] = [];
      try { entries = await memberLs(osUser, abs); } catch { entries = []; }
      for (const e of entries) if (!e.name.startsWith(".")) items.push({ name: e.name, type: e.type, size: e.size, mtime: e.mtime });
    } else {
      await fsp.mkdir(base, { recursive: true }).catch(() => { /* 개인 루트 없으면 생성 */ });
      let entries: fs.Dirent[] = [];
      try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { entries = []; }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const isDir = e.isDirectory();
        let size = 0, mtime = 0;
        try { const st = await fsp.stat(path.join(abs, e.name)); mtime = Math.floor(st.mtimeMs); if (!isDir) size = st.size; } catch { /* skip */ }
        items.push({ name: e.name, type: isDir ? "dir" : "file", size, mtime });
      }
    }
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    const rel = path.relative(base, abs);
    // 공개범위 필터 + 🔒 배지(#1291). 필터는 **목록에서 빼는** 방식이다 — 이름만 남기면 그 자체가 정보다.
    //  locked 는 접근 여부가 아니라 "전원 공개가 아님"을 뜻한다(내가 대상이라 보이지만 남에겐 안 보이는 폴더).
    //  두 축을 합친다: 일반 폴더는 ACL 체인, project/<id>·legacy-project/<id> 는 그 프로젝트의 공개범위.
    let visible = items;
    if (gate) {
      const relOf = (name: string): string => (rel ? `${rel}/${name}` : name);
      visible = items.filter((i) => gate.ok(relOf(i.name)));
      for (const i of visible) {
        const r = relOf(i.name);
        //  프로젝트 축은 **조상 프로젝트**로 판정한다(ACL 축이 조상 체인을 보는 것과 같은 규칙) — 잠긴 프로젝트
        //  폴더 '안'을 들여다볼 때도 여기가 전원 공개가 아님이 계속 보여야 한다.
        const pf = projectFolderOf(r);
        const inProject = !!pf && folderVariants(pf).some((v) => restrictedProjects.has(v));
        if (inProject || gate.restricted(r)) i.locked = true;
      }
    }
    const dirs = visible.filter((i) => i.type === "dir").map((i) => i.name);
    res.setHeader("Cache-Control", "no-store");
    res.json({ root: req.query.root, path: rel, parent: rel ? (path.dirname(rel) === "." ? "" : path.dirname(rel)) : null, dirs, items: visible });
  }));
  // 생성폼·브라우저에서 새 폴더 만들기(세션 무관). 격리 멤버면 그 uid 로(생성 폴더 소유자=멤버).
  app.post("/api/ui/terminal/browse/mkdir", auth, wrap(async (req, res) => {
    const u = userOf(req);
    const { base, abs } = await resolveRootPath(u, String(req.query.root ?? ""), nfcPath(req.query.path));   // 폴더 이름도 NFC 정본(#1278b)
    // 안 보이는 폴더 안에는 못 만든다(#1291) — 여기를 열어두면 mkdir 의 성공/실패가 그대로 존재 오라클이 되고,
    //  잠긴 폴더 안에 파일을 밀어 넣는 우회 경로가 열린다. 거부는 목록과 같은 404.
    assertBrowseVisible(await browseGate(req), base, abs);
    const osUser = await userOsUser(u);
    if (osUser) await memberMkdir(osUser, abs);
    else await fsp.mkdir(abs, { recursive: true, mode: 0o700 });
    res.json({ ok: true });
  }));
  // ── 공유 폴더 브라우저 CRUD(#672) — 루트 내부 파일/폴더 이름변경·삭제·다운로드·업로드. ──
  //  게이트: browse/mkdir 과 동일(auth 만) — 이 루트는 셸(터미널)로 이미 rw 가능하므로 UI CRUD 가 새 권한경계를 열지 않는다.
  //  이름변경 — 같은 폴더 안에서만(to 는 파일명 1개, 경로 구분자 금지). 대상 존재 시 409(덮어쓰기 방지).
  app.post("/api/ui/terminal/browse/rename", auth, wrap(async (req, res) => {
    const { base, abs, osUser } = await resolveBrowse(req, true);
    const toName = nfcPath(req.query.to).trim();   // 새 이름도 NFC 정본(#1278b)
    if (!toName || toName.includes("/") || toName.includes("\\") || toName === "." || toName === "..") throw new HttpError(400, "새 이름이 올바르지 않습니다");
    const toAbs = path.resolve(path.dirname(abs), toName);
    if (toAbs !== base && !toAbs.startsWith(base + path.sep)) throw new HttpError(400, "허용 경로를 벗어났습니다");
    if (osUser) {
      if (await memberStat(osUser, toAbs)) throw new HttpError(409, "같은 이름이 이미 있습니다");
      await memberMv(osUser, abs, toAbs);
    } else {
      if (fs.existsSync(toAbs)) throw new HttpError(409, "같은 이름이 이미 있습니다");
      await fsp.rename(abs, toAbs);
    }
    // 공개범위 ACL 도 같이 옮긴다(#1291). 이걸 빼먹으면 **이름만 바꿔도 잠금이 풀린다**(ACL 이 옛 경로에 남아 고아가
    //  되고 새 경로는 규칙이 없어 open). fail-open 방향이라 절대 놓치면 안 되는 동기화다. 파일 rename 이어도
    //  경로 prefix 규칙은 같아서 그냥 호출한다(해당 행이 없으면 0건 no-op).
    //  ⚠ 셸에서 `mv` 로 옮기면 여기 안 걸린다 — 그 구멍은 §4.7 OS 강제와 함께 닫는다. best-effort(실패해도 rename 은 이미 끝났다).
    if (String(req.query.root ?? "") === SHARED_ROOT_KEY) {
      await renameSharedFolderAclPrefix(path.relative(base, abs), path.relative(base, toAbs))
        .catch((e) => console.warn("[browse] 공개범위 경로 동기화 실패:", (e as Error)?.message ?? e));
    }
    res.json({ ok: true });
  }));
  // 삭제(파일/폴더 재귀). 루트 자체는 거부.
  app.delete("/api/ui/terminal/browse", auth, wrap(async (req, res) => {
    const { abs, osUser } = await resolveBrowse(req, true);
    if (osUser) await memberRm(osUser, abs);
    else await fsp.rm(abs, { recursive: true, force: true });
    res.json({ ok: true });
  }));
  // 미리보기/다운로드(?download=1). 격리 멤버면 그 uid 로 stat+cat.
  app.get("/api/ui/terminal/browse/file", auth, wrap(async (req, res) => {
    const { abs, osUser } = await resolveBrowse(req, true);
    const download = req.query.download === "1";
    const setDl = (): void => {
      res.setHeader("Cache-Control", "no-store");
      if (download) res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
    };
    if (osUser) {
      const st = await memberStat(osUser, abs);
      if (!st) throw new HttpError(404, "파일 없음");
      if (!st.file) throw new HttpError(400, "파일이 아닙니다");
      if (!download && st.size > MAX_PREVIEW) throw new HttpError(413, "미리보기엔 너무 큽니다 — 다운로드하세요");
      setDl();
      await memberReadTo(osUser, abs, res).catch((e) => { if (!res.headersSent) throw new HttpError(500, "읽기 실패"); res.destroy(e as Error); });
      return;
    }
    let st: fs.Stats;
    try { st = await fsp.stat(abs); } catch { throw new HttpError(404, "파일 없음"); }
    if (!st.isFile()) throw new HttpError(400, "파일이 아닙니다");
    if (!download && st.size > MAX_PREVIEW) throw new HttpError(413, "미리보기엔 너무 큽니다 — 다운로드하세요");
    setDl();
    fs.createReadStream(abs).pipe(res);
  }));
  // 업로드(raw 스트림 → 임시파일 → rename). 격리 멤버면 그 uid 로 써서 파일 소유자=멤버(세션 셸이 이후 편집 가능).
  //  취소·끊김이면 목적지는 손대지 않는다 — 덮어쓰기 업로드를 끊어도 원본이 살아있다(#797 — upload-file.ts).
  app.put("/api/ui/terminal/browse/file", auth, wrap(async (req, res) => {
    const { abs, osUser } = await resolveBrowse(req, true, true);   // 생성 → NFC 정본(#1278b)
    try { await receiveUpload(req, abs, MAX_UPLOAD, osUser); }
    catch (e) { const he = uploadError(e); if (!he) return; throw he; } // he=null → 업로드 취소, 응답할 상대가 없다
    res.json({ ok: true });
  }));

  // 디렉터리 목록(숨김 제외). 격리 세션(#524)은 멤버 uid 로(게이트웨이가 700 홈 못 읽으므로).
  app.get("/api/ui/terminal/sessions/:id/ls", auth, wrap(async (req, res) => {
    const nodeId = await nodeFor(req);
    if (nodeId) { // 노드 세션 — 노드 로컬 fs 목록 릴레이(#875)
      const d = await nodeRpc(nodeId, "fsLs", { id: req.params.id, sub: String(req.query.path ?? ""), user: { userId: idOf(userOf(req)) } });
      res.setHeader("Cache-Control", "no-store"); res.json(d); return;
    }
    const { base, abs } = await resolveInSession(req, false);
    const osUser = await sessionOsUser(req.params.id);
    const items: Array<{ name: string; type: "dir" | "file"; size: number; mtime: number }> = [];
    if (osUser) {
      let entries;
      try { entries = await memberLs(osUser, abs); } catch { throw new HttpError(404, "디렉터리 없음"); }
      for (const e of entries) { if (!e.name.startsWith(".")) items.push({ name: e.name, type: e.type, size: e.size, mtime: e.mtime }); }
    } else {
      let entries: fs.Dirent[];
      try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { throw new HttpError(404, "디렉터리 없음"); }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const isDir = e.isDirectory();
        let size = 0, mtime = 0;
        try { const st = await fsp.stat(path.join(abs, e.name)); mtime = Math.floor(st.mtimeMs); if (!isDir) size = st.size; } catch { /* skip */ }
        items.push({ name: e.name, type: isDir ? "dir" : "file", size, mtime });
      }
    }
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    const rel = path.relative(base, abs);
    // 공유 링크 좌표(#1436) — 이 세션 작업폴더가 공유/개인 루트의 어디인지. 세션 파일 탐색기가 [🔗 링크 복사]로
    //  **세션과 무관한** 주소(#/f?root=…&path=…)를 만들 수 있게. 좌표를 못 잡으면(원격 노드·루트 밖·남의 개인
    //  폴더) 아예 안 싣는다 → 프론트는 그 자리에 버튼을 그리지 않는다(죽은 링크를 만들지 않는 편이 낫다).
    const coord = await rootRelOf(userOf(req), abs).catch(() => null);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      path: rel, parent: rel ? (path.dirname(rel) === "." ? "" : path.dirname(rel)) : null, items,
      ...(coord ? { shareRoot: coord.root, sharePath: coord.rel } : {}),
    });
  }));

  // 미리보기/다운로드. 격리 세션(#524)은 멤버 uid 로 stat+cat.
  app.get("/api/ui/terminal/sessions/:id/file", auth, wrap(async (req, res) => {
    const nodeId = await nodeFor(req);
    if (nodeId) { // 노드 세션 — 청크 base64 read 릴레이(#875). len=0 로 크기 프리체크 후 스트리밍.
      const rel = String(req.query.path ?? ""); const download = req.query.download === "1";
      const u = { userId: idOf(userOf(req)) };
      const head = await nodeRpc<{ size: number }>(nodeId, "fsRead", { id: req.params.id, path: rel, offset: 0, len: 0, user: u });
      if (head.size == null) throw new HttpError(404, "파일 없음");
      if (!download && head.size > MAX_PREVIEW) throw new HttpError(413, "미리보기엔 너무 큽니다 — 다운로드하세요");
      res.setHeader("Cache-Control", "no-store");
      if (download) res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(rel))}`);
      for (let offset = 0; offset < head.size;) {
        const r = await nodeRpc<{ data?: string; eof?: boolean }>(nodeId, "fsRead", { id: req.params.id, path: rel, offset, len: NODE_FS_CHUNK, user: u });
        if (r.data) res.write(Buffer.from(r.data, "base64"));
        offset += NODE_FS_CHUNK;
        if (r.eof) break;
      }
      res.end(); return;
    }
    const { abs } = await resolveInSession(req, true);
    const osUser = await sessionOsUser(req.params.id);
    const download = req.query.download === "1";
    const setDl = (): void => {
      res.setHeader("Cache-Control", "no-store");
      if (download) res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
    };
    if (osUser) {
      const st = await memberStat(osUser, abs);
      if (!st) throw new HttpError(404, "파일 없음");
      if (!st.file) throw new HttpError(400, "파일이 아닙니다");
      if (!download && st.size > MAX_PREVIEW) throw new HttpError(413, "미리보기엔 너무 큽니다 — 다운로드하세요");
      setDl();
      await memberReadTo(osUser, abs, res).catch((e) => { if (!res.headersSent) throw new HttpError(500, "읽기 실패"); res.destroy(e as Error); });
      return;
    }
    let st: fs.Stats;
    try { st = await fsp.stat(abs); } catch { throw new HttpError(404, "파일 없음"); }
    if (!st.isFile()) throw new HttpError(400, "파일이 아닙니다");
    if (!download && st.size > MAX_PREVIEW) throw new HttpError(413, "미리보기엔 너무 큽니다 — 다운로드하세요");
    setDl();
    fs.createReadStream(abs).pipe(res);
  }));

  // 새 폴더 생성. 격리 세션은 멤버 uid 로(생성 파일 소유자=멤버).
  app.post("/api/ui/terminal/sessions/:id/mkdir", auth, wrap(async (req, res) => {
    const nodeId = await nodeFor(req);
    if (nodeId) { await nodeRpc(nodeId, "fsMkdir", { id: req.params.id, sub: String(req.query.path ?? ""), user: { userId: idOf(userOf(req)) } }); res.json({ ok: true }); return; }
    const { abs } = await resolveInSession(req, true, true);   // 생성 → NFC 정본(#1278b)
    const osUser = await sessionOsUser(req.params.id);
    if (osUser) await memberMkdir(osUser, abs);
    else await fsp.mkdir(abs, { recursive: true });
    res.json({ ok: true });
  }));

  // 업로드(raw 스트림 → 임시파일 → rename). content-type 무관(express.json 은 json 만 소비하므로 스트림 보존).
  //  격리 세션은 멤버 uid 로 써서 파일 소유자가 멤버가 되게 한다(그래야 세션 셸이 이후 편집 가능).
  app.put("/api/ui/terminal/sessions/:id/file", auth, wrap(async (req, res) => {
    const nodeId = await nodeFor(req);
    if (nodeId) { // 노드 세션 — 본문을 모아 청크 base64 write 릴레이(#875). 순차 청크(offset 0=truncate, 이후 append).
      const rel = String(req.query.path ?? ""); if (!rel) throw new HttpError(400, "파일 경로가 필요합니다");
      const u = { userId: idOf(userOf(req)) };
      const bufs: Buffer[] = []; let total = 0; let over = false;
      await new Promise<void>((resolve, reject) => {
        req.on("data", (c: Buffer) => { total += c.length; if (total > MAX_UPLOAD) { over = true; req.destroy(); return; } bufs.push(c); });
        req.on("end", () => resolve()); req.on("error", reject);
      });
      if (over) throw new HttpError(413, "파일이 너무 큽니다");
      const bodyBuf = Buffer.concat(bufs);
      let offset = 0;
      do {
        const slice = bodyBuf.subarray(offset, offset + NODE_FS_CHUNK);
        await nodeRpc(nodeId, "fsWrite", { id: req.params.id, path: rel, offset, data: slice.toString("base64"), user: u });
        offset += NODE_FS_CHUNK;
      } while (offset < bodyBuf.length);
      res.json({ ok: true, path: rel }); return;
    }
    const { abs } = await resolveInSession(req, true, true);   // 생성 → NFC 정본(#1278b)
    const osUser = await sessionOsUser(req.params.id);
    try { await receiveUpload(req, abs, MAX_UPLOAD, osUser); }
    catch (e) { const he = uploadError(e); if (!he) return; throw he; } // he=null → 업로드 취소, 응답할 상대가 없다
    res.json({ ok: true, path: abs }); // abs = 세션 작업폴더 기준 절대경로(드롭 업로드가 입력창에 꽂아 cwd 무관하게 찾게)
  }));
}

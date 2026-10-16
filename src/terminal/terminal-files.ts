// 중앙 박스 — 세션 작업 디렉터리(@box_dir) 파일 API. 익스플로러/업로드/다운로드/미리보기용.
// 게이트: canAttach(소유자 OR 초대된 멤버) — 터미널을 열 수 있으면 셸로 어차피 그 폴더를 만질 수 있으므로 동일 권한.
// 봉쇄: 모든 경로를 @box_dir 내부로 봉쇄한다 — ① 글자 판정(.. 탈출 차단) ② **심링크를 해소한 뒤** 접두 재판정(#3668 T1,
//  path-jail.ts). ②가 없으면 세션이 자기 폴더에 심어 둔 링크(`ln -s <바깥> x`)로 `?path=x/...` 가 그냥 통과한다
//  — read 는 cat, ls 는 statSync 라 **둘 다 링크를 따라간다**(따라가는 것 자체는 #1744 의 설계 의도다).
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
import { assertNotAppFolderMount } from "./app-folder-guard.js";   // #4684 — `.lively/apps` 는 세션 앱 폴더 자리
import { viewerOf } from "../capabilities/principal.js";
import { canAttach, sessionDir, resolveRootPath, rootRelOf, sessionOsUser, userOsUser } from "./terminal-sessions.js";
import { resolveSessionDir } from "../sessions/session-desired.js";
import { memberLs, memberStat, memberMkdir, memberMv, memberRm, memberReadTo, memberPathProbe, memberNodeJson, type LsEntry } from "./terminal-member-fs.js";
import { isConfined, probeLocal } from "./path-jail.js";   // #3668 T1 — 심링크를 해소한 뒤 접두를 본다
import { isInAppFolder } from "../files/app-jail.js";   // #4673 — 앱 폴더 주소는 그 앱 폴더 안에서만
import { receiveUpload, uploadError, nfcPath } from "./upload-file.js";
import {
  supersedeLocalPath, localRootForBrowse, parseLocalExternalId, LOCAL_SYSTEM,
  countActiveLocalUnder, stampTrashedLocalPath, getTrashedFile, reviveTrashedFile, fileTrashBatchRemaining,
  newRootTrashStamp, trashStampRoot, heldPathOf, fileTrashBatchCleanup, normalizeLocalRel, localRootKey, FILE_TRASH_DIR,
} from "../ingest/local-file.js";
import { finishUpload, type UploadCoord } from "../ingest/upload-finish.js";
import { uploadEntryOf } from "../ingest/upload-entry.js";   // #4233: 들어온 길(세션 헤더가 있으면 AI 가 만든 파일)   // #3787 D: 업로드 마무리(그룹 rw·자료·좌표·도장)는 한 자리
import { projectOffsetOfSessionDir, projectRelForUpload } from "./node-upload-coord.js";   // #3787 — 노드 세션 업로드의 게이트웨이 좌표
import { executionSessionProject } from "../v6/execution-session-store.js";
import { getProjectRow } from "../v6/project-store.js";
import { projectStorage, type ProjectStorage } from "../project/project-storage.js";   // #4064 — 노드 업로드 정본의 자리
import { getSource } from "../v6/source-store.js";   // #1631 — 자료 원본 창구의 공개범위(자료 상세와 같은 판정)
import { canSeeSource, deleteSource } from "../v6/source-store.js";   // #3778 — 파일 휴지통(개인·공유 폴더)의 공개범위·완전 삭제
import { purgeDeleted } from "../v6/trash-store.js";
import { auditOrgContent } from "../v6/content-audit.js";
import { nodeCanAttach, nodeRpc, isSelfNode, isSessionHostNode } from "../node/registry.js";
import { relayNodeId, sameTmuxCoordinate, isBoxSessionRow } from "../node/self-node.js";   // #2592 — 셀프 노드 좌표는 릴레이 지시가 아니다(중앙 경로로 접는다) · #3745/#3870 — 박스 세션엔 세션 호스트 좌표도 같은 tmux 다
import { getSessionState } from "../sessions/session-state.js";
import { folderVariants, grantSharedGroupWrite } from "../project/project-fs.js";
import {
  sharedFolderGate, renameSharedFolderAclPrefix, restrictedProjectFolders, projectFolderOf, isProjectContainerPath, isProjectFolderOrAncestor,
  type SharedFolderGate,
} from "../v6/shared-folder-store.js";
import { settleFileMove } from "../files/file-move.js";   // #4688 — 이름 바꾸기 뒤 자료 좌표 + «옛 경로 → 새 경로»
import { followMoves, normalizeMovePath } from "../files/file-move-core.js";
import { SHARED_MOVE_SCOPE, personalMoveScope, findFileMove } from "../v6/file-move-store.js";
import { APPS_ROOT_KEY } from "./catalog.js";
import { readableAppFoldersFor, appConsentNeeded, appTitleFor, fileViewSourceAt } from "../files/files-live.js";   // #4673 — 앱 폴더는 그 앱에 동의한 구성원만 · #4672 자료 보기
import { appIdOfLink, buildFileInfo } from "../files/file-view.js";   // #4672 — 링크 하나의 정보 · 속한 곳 · 자료
import { sameNameScope, rankSameName, findSameNameLocal, SAME_NAME_JS, SAME_NAME_LIMITS, type SameNameFound } from "../files/same-name.js";
import { projectFolderOfCoord, projectIdForSessionCoord } from "../project/folder-bind.js";
import { logger } from "../log.js";

// 업로드 상한(#1870) — 종전 50MB 는 화면 녹화·데이터셋이 걸렸다. receiveUpload 가 임시파일로 **스트리밍**하므로
//  (RAM 상주 없음, upload-file.ts) 상한을 올려도 메모리 위험이 없다. project-routes.ts MAX_UPLOAD 와 같은 값이어야 한다.
const MAX_UPLOAD = 1024 * 1024 * 1024; // 1GB
// ⚠ 노드 세션 릴레이(아래 PUT 의 ?node= 분기)만은 예외 — 본문을 통째로 RAM 에 모아 ws 청크로 중계하므로
//  거기까지 1GB 로 열면 게이트웨이 메모리가 업로드 하나에 잡아먹힌다. 그 경로는 종전 상한을 유지한다.
const NODE_RELAY_MAX = 50 * 1024 * 1024; // 50MB
// 인라인 미리보기 상한 — 프로젝트 파일 라우트(project-routes.ts MAX_PREVIEW)와 **같은 값**이어야 한다(#1436):
//  공유 링크는 root+path 하나로 공유/개인/프로젝트 폴더를 똑같이 가리키는데, 같은 파일이 어느 라우트를 타는지에
//  따라 "미리보기엔 너무 큽니다"가 갈리면 링크를 받은 사람에게는 그게 그냥 고장으로 보인다.
//  (종전 2MB 는 대시보드 위젯 미리보기만 염두에 둔 값이라 5MB PDF 보고서조차 링크로 열리지 않았다.)
const MAX_PREVIEW = 25 * 1024 * 1024; // 25MB
// 디렉터리 한 칸 읽기(로컬 fs) — **심링크를 따라가** 실효 종류를 정한다(#1744).
//  dirent.isDirectory() 는 링크에 대해 언제나 false 라, 그대로 두면 폴더를 가리키는 링크(세션 폴더의 ./project 가 그
//  대표)가 목록에 '파일'로 나와 탐색기에서 들어갈 수 없었다 — 눌러도 미리보기만 열렸다. stat 은 링크를 따라가므로
//  그 결과로 type 을 정하고, link/linkTarget 을 함께 실어 화면이 '링크'임을 표시하고 목적지를 말할 수 있게 한다.
//  끊어진 링크는 stat 이 던져 종전대로 file(크기 0)로 남는다 — 목록에서 사라지지 않는 편이 낫다.
//  ⚠ 격리 멤버 경로는 같은 규칙을 memberLs(LS_JS)가 자기 uid 로 수행한다 — 한쪽만 고치면 두 목록이 어긋난다.
export interface FsListItem { name: string; type: "dir" | "file"; size: number; mtime: number; link?: boolean; linkTarget?: string }
export async function readDirItems(abs: string): Promise<FsListItem[]> {
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const items: FsListItem[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const link = e.isSymbolicLink();
    let isDir = e.isDirectory(); let size = 0; let mtime = 0; let linkTarget = "";
    const full = path.join(abs, e.name);
    try { const st = await fsp.stat(full); mtime = Math.floor(st.mtimeMs); if (link) isDir = st.isDirectory(); if (!isDir) size = st.size; } catch { /* 끊어진 링크·권한 — 아는 만큼만 */ }
    if (link) { try { linkTarget = await fsp.readlink(full); } catch { /* 읽을 수 없으면 목적지는 생략 */ } }
    items.push({ name: e.name, type: isDir ? "dir" : "file", size, mtime, ...(link ? { link: true, linkTarget } : {}) });
  }
  return items;
}

// 심링크 봉쇄(#3668 T1) — 해소는 **op 가 실제로 도는 자리**에서 한다(격리면 멤버 uid, 아니면 게이트웨이 로컬 fs).
//  게이트웨이가 직접 realpath 를 부르면 격리 홈(700)은 못 읽고 매니지드에선 그 경로가 시야에 아예 없다(path-jail.ts 머리말).
//  거부 문구·코드는 글자 판정과 같다 — 사람에게는 같은 사건이고, 어느 관문에 걸렸는지는 알려 줄 값이 아니다.
async function assertJailed(base: string, abs: string, osUser: string | null, app?: string): Promise<void> {
  const probe = osUser ? (b: string, t: string) => memberPathProbe(osUser, b, t) : probeLocal;
  const ok = app ? await isInAppFolder(base, app, abs, probe) : await isConfined(base, abs, probe);
  if (!ok) throw new HttpError(400, "허용 경로를 벗어났습니다");
}

// 파일 한 개를 응답으로 — 미리보기(상한 MAX_PREVIEW) 또는 내려받기(?download=1). 격리 멤버면 그 uid 로 stat+cat.
//  브라우즈(root·path)와 자료 원본(자료 id, #1631)이 같은 한 벌을 지난다 — 상한·Content-Disposition·no-store 가 갈리지 않게.
async function sendFile(res: express.Response, abs: string, osUser: string | null, download: boolean): Promise<void> {
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
}

const userOf = (req: express.Request): LivelyUser => (req.auth?.extra ?? {}) as unknown as LivelyUser;
const idOf = (u: LivelyUser): string => u.userId || u.email || "";

// @box_dir 기준 안전 경로 해소(+ 접근권한 확인). rel 의 .. 탈출은 거부.
async function resolveInSession(req: express.Request, requireFile: boolean, canonical = false): Promise<{ base: string; abs: string; osUser: string | null }> {
  const id = req.params.id;
  if (!(await canAttach(id, idOf(userOf(req))))) throw new HttpError(403, "세션 접근 권한이 없습니다");
  // desired(DB) 우선 · tmux 폴백 — 이 값이 **파일 샌드박스의 base** 다. tmux 가 안 잡히면 홈으로 넓어지므로
  //  DB 가 답할 수 있으면 DB 가 답해야 한다(공유 게이트웨이는 그 tmux 서버 문맥 밖에 있다).
  const base = path.resolve(await resolveSessionDir(id, () => sessionDir(id)));
  const raw = canonical ? nfcPath(req.query.path) : String(req.query.path ?? "");   // 생성만 NFC 정본(#1278b)
  const rel = raw.replace(/^[/\\]+/, "");
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new HttpError(400, "허용 경로를 벗어났습니다");
  if (requireFile && (rel === "" || abs === base)) throw new HttpError(400, "파일 경로가 필요합니다");
  // 파일 op 를 내릴 uid 를 여기서 한 번 구해 **봉쇄 판정과 op 가 같은 자리를 보게** 한다(라우트가 다시 묻지 않는다).
  const osUser = await sessionOsUser(req.params.id);
  await assertJailed(base, abs, osUser);
  return { base, abs, osUser };
}

/**
 * 노드 세션 업로드가 **게이트웨이 정본**으로 갈 자리인가(#3787). 못 잡으면 null → 종전대로 릴레이.
 *  판정은 DB 한 줄(이 세션의 프로젝트)과 좌표 규약뿐이다 — 노드에 아무것도 묻지 않는다(왕복 0).
 *  ⚠ 세션 작업폴더는 **노드 로컬 경로**(윈도우면 `C:\…`)라 게이트웨이 fs 로 풀면 안 된다. 규약으로만 접는다.
 */
async function gatewayUploadForNodeSession(sessionId: string, memberId: string, rel: string)
  : Promise<{ store: ProjectStorage; base: string; rel: string; nodeAbs: string; coord: UploadCoord } | null> {
  try {
    if (!memberId) return null;
    const cur = await executionSessionProject(sessionId, memberId);
    const pid = Number(cur?.project_id || 0);
    if (!Number.isInteger(pid) || pid <= 0) return null;          // 프로젝트 세션이 아니다
    const dir = await resolveSessionDir(sessionId, async () => "");
    const offset = projectOffsetOfSessionDir(dir, pid);
    if (offset === null) return null;                             // cwd 가 그 프로젝트 폴더가 아니다
    const projRel = projectRelForUpload(offset, rel);
    if (!projRel) return null;
    const row = await getProjectRow(pid);
    if (!row?.folder) return null;
    //  정본의 자리는 프로젝트 저장소가 정한다(#4064) — 매니지드면 멤버 저장소(동기화 매니페스트가 읽는 바로 그 자리).
    //  게이트웨이 로컬에 쓰면 매니페스트가 못 봐서 노드로 영영 안 내려간다.
    const store = await projectStorage(row.folder, { memberId }, { id: pid, name: row.name });
    const base = store.base;
    //  노드에서의 절대경로 — 드롭 UI 가 입력창에 꽂을 값. 세션 cwd + 드롭 rel 을 **그 노드의 구분자로** 잇는다.
    const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
    const nodeAbs = dir.replace(/[\\/]+$/, "") + sep + String(rel).replace(/^[\\/]+/, "").split(/[\\/]/).join(sep);
    return { store, base, rel: projRel, nodeAbs, coord: { root: { kind: "project", id: pid }, base, folder: row.folder, channelFallback: row.name } };
  } catch { return null; }
}

/**
 * 세션 작업폴더의 절대경로 → **알려진 좌표**(#3787 D). 못 잡으면 null(좌표를 지어내지 않는다).
 *  세션 cwd 는 언제나 개인·공유 루트 안이므로(실측 2026-09-14: 534/534) 이 역함수가 거의 항상 답한다.
 *  ⚠ 노드 세션에는 쓰지 않는다 — 그 바이트는 멤버 PC 에 있어 게이트웨이가 읽을 수 없다(자료 등록은 push 훅이 한다).
 */
async function sessionUploadCoord(u: LivelyUser, abs: string): Promise<UploadCoord | null> {
  try {
    const c = await rootRelOf(u, abs);
    if (!c) return null;
    const { base } = await resolveRootPath(u, c.root, "");
    return await localRootForBrowse(c.root, u, base, abs);
  } catch { return null; }
}

// 노드 세션 파일 릴레이(#875) — ?node= 면 게이트웨이가 nodeCanAttach 로 인가(정책=게이트웨이, 실행=노드 F7)하고 nodeId 반환.
//  중앙 세션이면 null(로컬 fs 경로). 거부 코드: 4410 gone→404 · 4462 offline→503 · 그 외 no-access→403.
async function nodeFor(req: express.Request): Promise<string | null> {
  //  #2592 — 셀프 노드 좌표는 접는다(relayNodeId): 그 파일은 이 박스의 fs 에 그대로 있어 로컬 경로가 정답이다.
  //
  //  ★ #3870 — **박스(중앙) 세션에 붙은 «선언된 세션 호스트» 좌표도 같은 «한 바퀴»다.** #3745 가 세션 DELETE
  //   에서 이미 내린 판정인데 파일 op 만 빠져 있었다 — 그래서 매니지드 세션의 업로드·목록이 전부 죽어 있었다
  //   (2026-09-12 실측, 세션 box-wonjoon-jang-d3a3e7e3 @ sesshost-lively-46e3-i-0a9831a1d88d435be):
  //     `?node=<sesshost>` → PUT /file 500 `internal_error` · GET /ls 404 「디렉터리 없음」
  //     `?node=` 없음      → 둘 다 200 (같은 파일, 같은 경로)
  //   화면은 좌표를 지어내지 않는다 — 세션 호스트가 그 테넌트의 세션을 통째로 스냅샷에 실어 목록 행에 좌표가
  //   붙고(nodeSessionsFor), 터미널 액자는 그 값을 `&node=` 로 그대로 싣는다(web/standalone/terminal.ts sUrl).
  //   ⚠ **caps 는 이 축을 못 가른다.** 세션 호스트도 같은 에이전트 번들이라 `fsLs/fsWrite` 를 광고하지만,
  //    그 세션은 컨테이너 안에 살아 노드 프로세스의 fs 에 없다 — 광고는 참이고 실행이 거짓이라 500 만 남는다.
  //   접으면 아래 로컬 경로(resolveInSession → 격리 멤버 uid)가 종전대로 답한다. 멤버 PC 노드(선언 없음)는
  //   이 변경의 밖이다 — 그 파일은 정말 그 컴퓨터에만 있으므로 릴레이가 유일한 길이다.
  const desired = await getSessionState(req.params.id).catch(() => undefined);
  const boxRow = isBoxSessionRow(desired);   // 행이 **있고** 노드가 없다 = 이 게이트웨이가 만든 세션
  const nodeId = relayNodeId(req.query.node as string | undefined,
    sameTmuxCoordinate({ boxRow, isSelf: isSelfNode, isSessionHost: isSessionHostNode }));
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
  //  앱 폴더(#4673)는 같은 모양의 게이트로 «그 앱에 동의한 구성원» 을 가린다 — 맨 위(목록 자리)는 열고, 그 아래는 첫 마디(앱 id)가
  //   읽을 수 있는 앱일 때만. 신원 없는 요청은 앱 폴더를 아예 못 본다(앱 동의는 사람마다라 «특권 = 전부 통과» 가 없다).
  const browseGate = async (req: express.Request): Promise<SharedFolderGate | null> => {
    const root = String(req.query.root ?? "");
    if (root === SHARED_ROOT_KEY) return sharedFolderGate(viewerFor(req));
    if (root !== APPS_ROOT_KEY) return null;
    const viewer = viewerFor(req);
    const readable = viewer ? await readableAppFoldersFor({ member: viewer, scopes: userOf(req).scopes ?? [] }) : new Set<string>();
    //  앱 주체(앱 세션 토큰)는 이 자리에서 제 앱 폴더만 — 권한표(#4671 ③)의 «앱은 제 앱 폴더만». 앱 서버 토큰은 이 라우트에 오지 못한다(sessionOrBearer 가 403).
    const appId = userOf(req).appId;
    if (appId) for (const id of [...readable]) if (id !== appId) readable.delete(id);
    const ok = (rel: string): boolean => { const first = String(rel ?? "").split(/[\\/]/)[0] ?? ""; return first === "" || readable.has(first); };
    //  앱 폴더는 통째로 보이거나 안 보인다 — 그 안에 따로 못 보는 하위 자리가 없다(hiddenWithin 은 빈 목록).
    return { ok, restricted: () => false, subtreeOk: ok, hiddenWithin: () => [] };
  };
  // 앱 폴더는 웹에서 쓰지 않는다(#4671 ③ — 앱 폴더는 그 앱이 쓴다. 세션 셸은 앱을 붙여 `.lively/apps/<앱>/` 에서 고친다).
  //  올리기 · 폴더 만들기 · 이름 바꾸기 · 지우기 전부 이 한 줄을 먼저 지난다.
  const assertBrowseWritable = (req: express.Request): void => {
    if (String(req.query.root ?? "") === APPS_ROOT_KEY) throw new HttpError(403, "앱 폴더는 그 앱이 씁니다 — 웹에서는 보고 내려받기만 할 수 있습니다");
  };

  // 안 보이는 경로는 **404**로 막는다 — 403 은 "거기 뭔가 있다"를 알려주는 오라클이라 존재 자체를 숨기지 못한다.
  const assertBrowseVisible = (gate: SharedFolderGate | null, base: string, abs: string): void => {
    if (gate && !gate.ok(path.relative(base, abs))) throw new HttpError(404, "경로를 찾을 수 없습니다");
  };

  // 루트 브라우즈용 경로 해소(+접근 osUser). requireSub=true 면 루트 자체(base)는 거부(대상 경로 필요).
  //  경로 봉쇄는 두 겹이다 — 글자 판정(루트 내부, .. 탈출 거부)은 resolveRootPath 가, **심링크 해소 뒤 재판정**은
  //  여기 assertJailed 가 건다(#3668 T1). 공개범위 게이트도 여기서 함께 건다(#1291) —
  //  목록·rename·삭제·다운로드·업로드가 전부 이 함수를 지나므로, 새 라우트가 늘어도 셋 중 무엇도 빠지지 않는다.
  //  canonical=true 는 **생성 경로 전용** — 저장 이름을 NFC 정본으로 통일한다(#1278b).
  //  읽기·삭제에 켜면 예전에 NFD 로 저장된 파일에 접근할 수 없게 되므로 절대 켜지 않는다.
  async function resolveBrowse(req: express.Request, requireSub: boolean, canonical = false): Promise<{ base: string; abs: string; osUser: string | null; gate: SharedFolderGate | null }> {
    const u = userOf(req);
    const raw = String(req.query.path ?? "");
    const { base, abs } = await resolveRootPath(u, String(req.query.root ?? ""), canonical ? nfcPath(raw) : raw);
    if (requireSub && abs === base) throw new HttpError(400, "대상 경로가 필요합니다");
    //  게이트는 **한 번만** 만들어 돌려준다 — 목록처럼 항목마다 물어야 하는 자리가 이 값을 그대로 재사용한다.
    const gate = await browseGate(req);
    assertBrowseVisible(gate, base, abs);
    const osUser = await userOsUser(u);
    //  #3668 T1 — 링크를 해소한 뒤 다시 본다. 앱 폴더 주소(#4673)는 그 앱 폴더 안에서만 연다(files/app-jail — 서명 주소와 같은 판정).
    const appSeg = String(req.query.root ?? "") === APPS_ROOT_KEY && abs !== base ? path.relative(base, abs).split(path.sep)[0] : "";
    await assertJailed(base, abs, osUser, appSeg || undefined);
    return { base, abs, osUser, gate };
  }

  // 생성폼 폴더 탐색 + 공유 폴더 브라우저(세션 무관) — 허용 루트 내부 목록. 격리 멤버면 그 uid 로(개인 루트=멤버 홈 700).
  //  dirs = 폴더명(하위호환: 생성폼 폴더 피커·대시보드 박스). items = 폴더+파일(type·size, 대시보드 폴더 브라우저 #672).
  app.get("/api/ui/terminal/browse", auth, wrap(async (req, res) => {
    // 공개범위(#1291)·경로 봉쇄는 resolveBrowse 가 한 자리에서 건다 — ①이 폴더 자체가 안 보이면 404(존재 은닉)
    //  ②목록은 안 보이는 하위 항목을 빼고 준다. 게이트는 한 번만 만들어 항목마다 재사용한다(수백 항목 × DB 왕복 방지).
    const { base, abs, osUser, gate } = await resolveBrowse(req, false);
    //  🔒 배지(프로젝트 공개범위 · 공유 폴더 ACL)는 공유 자리의 말이다 — 앱 폴더(#4673)는 목록에서 빼는 것으로 끝난다.
    const restrictedProjects = gate && String(req.query.root ?? "") === SHARED_ROOT_KEY ? await restrictedProjectFolders() : new Set<string>();
    const items: Array<FsListItem & { locked?: boolean }> = [];
    if (osUser) {
      await memberMkdir(osUser, base).catch(() => { /* 루트 없으면 생성 */ });
      let entries: LsEntry[] = [];
      try { entries = await memberLs(osUser, abs); } catch { entries = []; }
      for (const e of entries) if (!e.name.startsWith(".")) items.push({ name: e.name, type: e.type, size: e.size, mtime: e.mtime, ...(e.link ? { link: true, linkTarget: e.linkTarget || "" } : {}) });
    } else {
      await fsp.mkdir(base, { recursive: true }).catch(() => { /* 개인 루트 없으면 생성 */ });
      try { items.push(...await readDirItems(abs)); } catch { /* 못 읽으면 빈 목록 */ }
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
    // 안 보이는 폴더 안에는 못 만든다(#1291) — 여기를 열어두면 mkdir 의 성공/실패가 그대로 존재 오라클이 되고,
    //  잠긴 폴더 안에 파일을 밀어 넣는 우회 경로가 열린다. 거부는 목록과 같은 404. 폴더 이름도 NFC 정본(#1278b).
    assertBrowseWritable(req);
    assertNotAppFolderMount(req.query.path);
    const { abs, osUser } = await resolveBrowse(req, false, true);
    if (osUser) await memberMkdir(osUser, abs);
    else await fsp.mkdir(abs, { recursive: true, mode: 0o700 });
    res.json({ ok: true });
  }));
  // ── 공유 폴더 브라우저 CRUD(#672) — 루트 내부 파일/폴더 이름변경·삭제·다운로드·업로드. ──
  //  게이트: browse/mkdir 과 동일(auth 만) — 이 루트는 셸(터미널)로 이미 rw 가능하므로 UI CRUD 가 새 권한경계를 열지 않는다.
  //  이름변경 — 같은 폴더 안에서만(to 는 파일명 1개, 경로 구분자 금지). 대상 존재 시 409(덮어쓰기 방지).
  app.post("/api/ui/terminal/browse/rename", auth, wrap(async (req, res) => {
    assertBrowseWritable(req);
    const { base, abs, osUser } = await resolveBrowse(req, true);
    const toName = nfcPath(req.query.to).trim();   // 새 이름도 NFC 정본(#1278b)
    if (!toName || toName.includes("/") || toName.includes("\\") || toName === "." || toName === "..") throw new HttpError(400, "새 이름이 올바르지 않습니다");
    const toAbs = path.resolve(path.dirname(abs), toName);
    if (toAbs !== base && !toAbs.startsWith(base + path.sep)) throw new HttpError(400, "허용 경로를 벗어났습니다");
    assertNotAppFolderMount(path.relative(base, abs), path.relative(base, toAbs));
    const rootKey = String(req.query.root ?? "");
    //  #4688 — 프로젝트의 폴더 자리(`project` · `legacy-project` · 그 아래 `<id>` · DB 에 적힌 프로젝트 폴더와 그 조상)는 여기서 이름을
    //   바꾸지 않는다 — 프로젝트 폴더 · 자료 좌표 · 공개범위 판정이 그 경로를 기준으로 한다(isProjectContainerPath 머리말). 그 안의 파일·폴더는 된다.
    if (rootKey === SHARED_ROOT_KEY) {
      const fromRel = path.relative(base, abs), toRel = path.relative(base, toAbs);
      if (isProjectContainerPath(fromRel) || isProjectContainerPath(toRel) || await isProjectFolderOrAncestor(fromRel) || await isProjectFolderOrAncestor(toRel)) {
        throw new HttpError(400, "프로젝트 폴더는 여기서 이름을 바꿀 수 없어요");
      }
    }
    //  자료 좌표는 옮기기 **전에** 푼다(지우기와 같은 순서) — 공유 루트 아래 project/<id>/… 는 프로젝트 좌표로 접힌다(같은 파일 = 같은 자료).
    //   새 이름은 같은 폴더 안이라 같은 좌표 루트다(프로젝트 폴더 자리는 위에서 막았다) — 새 자리도 이 좌표의 기준으로 푼다.
    const loc = await localRootForBrowse(rootKey, userOf(req), base, abs).catch(() => null);
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
    if (rootKey === SHARED_ROOT_KEY) {
      await renameSharedFolderAclPrefix(path.relative(base, abs), path.relative(base, toAbs))
        .catch((e) => console.warn("[browse] 공개범위 경로 동기화 실패:", (e as Error)?.message ?? e));
    }
    //  #4688 — 같은 자리에서 자료가 새 이름으로 이어지고 «옛 경로 → 새 경로» 가 남는다(옛 링크가 새 자리로 열린다 — 아래 browse/moved).
    //   기록의 자리: 공유 루트는 하나 · 개인 폴더는 주인별(root=personal 링크는 여는 사람 자신의 폴더로 풀린다). 실패는 남기고 삼킨다.
    const scope = rootKey === SHARED_ROOT_KEY ? SHARED_MOVE_SCOPE : loc?.root.kind === "personal" ? personalMoveScope(loc.root.member) : null;
    const local = loc
      ? { root: loc.root, fromRel: path.relative(loc.base, abs), toRel: path.relative(loc.base, toAbs), folder: loc.folder, channelFallback: loc.channelFallback }
      : null;
    await settleFileMove({ scope, fromPath: path.relative(base, abs), toPath: path.relative(base, toAbs), local, by: viewerFor(req) });
    res.json({ ok: true });
  }));
  // ── 파일 휴지통(#3778 후속 — 개인·공유 폴더) ──────────────────────────────────────────────────────────
  //  프로젝트 파일 삭제(project-routes.ts DELETE :id/file)와 **같은 규칙**: 자료가 달린 경로는 지우지 않고 그 루트의 숨김 자리
  //  (`.lively/trash/<batch>/`)로 옮기고 도장을 찍는다 → 휴지통 ▸ 자료 탭에서 되살린다. 자료가 하나도 없는 경로(압축·영상·빈 폴더)는
  //  종전대로 바로 지운다. 목록(GET browse)은 점으로 시작하는 이름을 건너뛰므로 보관 자리는 화면에 서지 않는다.
  //  격리 멤버면 그 uid 로, 아니면 게이트웨이 로컬 fs 로 — 이 파일의 다른 op 와 같은 한 쌍.
  const fsExists = async (osUser: string | null, abs: string): Promise<boolean> =>
    (osUser ? !!(await memberStat(osUser, abs)) : fs.existsSync(abs));
  const fsMkdirp = async (osUser: string | null, abs: string): Promise<void> => {
    if (osUser) await memberMkdir(osUser, abs); else await fsp.mkdir(abs, { recursive: true, mode: 0o700 });
  };
  const fsMove = async (osUser: string | null, from: string, to: string): Promise<void> => {
    if (osUser) await memberMv(osUser, from, to); else await fsp.rename(from, to);
  };
  const fsRemove = async (osUser: string | null, abs: string): Promise<void> => {
    if (osUser) await memberRm(osUser, abs); else await fsp.rm(abs, { recursive: true, force: true });
  };
  /** base 안의 상대경로 → 절대경로. 글자 판정(.. 탈출 거부)만 — 심링크 재판정은 부르는 쪽이 assertJailed 로 건다. */
  const inBase = (base: string, rel: string): string => {
    const abs = path.resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + path.sep)) throw new HttpError(400, "허용 경로를 벗어났습니다");
    return abs;
  };

  // 삭제(파일/폴더 재귀). 루트 자체는 거부. 응답 trashed = 휴지통으로 간 자료 수(0 = 바로 지워진 것) — 화면이 그 숫자로 말을 가른다.
  app.delete("/api/ui/terminal/browse", auth, wrap(async (req, res) => {
    assertBrowseWritable(req);
    const { base, abs, osUser } = await resolveBrowse(req, true);
    //  좌표는 **지우기 전에** 푼다 — 공유 루트 아래 project/<id>/… 는 프로젝트 좌표로 접힌다(같은 파일 = 같은 자료, 보관 자리도 그 프로젝트 폴더 안).
    const loc = await localRootForBrowse(String(req.query.root ?? ""), userOf(req), base, abs).catch(() => null);
    const rel = loc ? normalizeLocalRel(path.relative(loc.base, abs)) : "";
    //  보관 자리 자체(.lively/…)를 지우라는 요청은 휴지통으로 돌리지 않는다 — 자기 안으로 옮기는 꼴이 된다.
    const live = loc && rel && rel.split("/")[0] !== ".lively" ? await countActiveLocalUnder(loc.root, rel).catch(() => 0) : 0;
    if (loc && live > 0) {
      const stamp = newRootTrashStamp(loc.root, rel, viewerFor(req));
      const heldAbs = inBase(loc.base, stamp.held_rel);
      await fsMkdirp(osUser, path.dirname(heldAbs));
      //  공유·프로젝트 자리의 보관 폴더는 **다른 사람도** 되살릴 수 있어야 한다 — 만든 폴더부터 루트 직전까지 그룹 rw(업로드와 같은 규칙).
      //   개인 루트는 uid 로 격리된 자리라 절대 열지 않는다. 실패해도 삭제는 간다(그때는 지운 사람만 되살릴 수 있다).
      if (loc.root.kind !== "personal") await grantSharedGroupWrite(path.dirname(heldAbs), loc.base, "dir").catch(() => { /* 비치명 */ });
      await fsMove(osUser, abs, heldAbs);
      //  도장은 옮긴 **뒤에**, 그리고 도장이 실패하거나 0건이면(그새 자료가 사라진 경합) **옮긴 것을 되돌린다** — 도장 없는 보관 파일은
      //   휴지통에 안 서서 «지운 것도 아니고 되살릴 수도 없는» 채로 숨는다(프로젝트 라우트와 같은 규칙).
      let n = 0; let stampErr: unknown = null;
      try { n = await stampTrashedLocalPath(loc.root, rel, stamp); } catch (e) { stampErr = e; }
      if (n > 0) { res.json({ ok: true, trashed: n, batch: stamp.batch }); return; }
      await fsMove(osUser, heldAbs, abs);
      await fsRemove(osUser, path.dirname(heldAbs)).catch(() => { /* 빈 묶음 폴더 — 비치명 */ });
      if (stampErr) throw new HttpError(500, "휴지통으로 보내지 못했어요 — 파일은 그대로 있습니다. 잠시 뒤 다시 시도해 주세요");
    }
    await fsRemove(osUser, abs);
    // 자료 전파(#1881) — 그 경로(폴더면 하위 전부)의 자료를 superseded 로.
    try { if (loc) await supersedeLocalPath(loc.root, path.relative(loc.base, abs)); }
    catch (e) { console.warn(`[local-ingest] 삭제 전파 실패 ${abs}: ${(e as Error)?.message ?? e}`); }
    res.json({ ok: true, trashed: 0 });
  }));

  //  되살리기 / 완전 삭제 — 대상은 자료 id(휴지통 화면의 한 줄 = 자료 한 건). 좌표는 요청이 아니라 **도장**에서 푼다.
  //   · 개인 폴더: 도장의 주인이 나일 때만(남의 개인 폴더는 없는 것과 같은 404).
  //   · 공유 폴더: 폴더 공개범위 게이트(목록·삭제와 같은 것)를 원래 자리로 다시 지난다.
  //   · 프로젝트 좌표로 접힌 것은 여기 대상이 아니다 — 프로젝트 라우트(file-trash/*)가 그 프로젝트의 파일 권한으로 다룬다.
  //   둘 다 자료 공개범위(canSeeSource)도 함께 지난다 — 안 보이는 자료는 되살릴 수도 지울 수도 없다.
  const trashedBrowseFile = async (req: express.Request) => {
    const u = userOf(req);
    const sourceId = Number((req.body as { source_id?: unknown } | undefined)?.source_id);
    if (!Number.isInteger(sourceId) || sourceId <= 0) throw new HttpError(400, "source_id 가 필요합니다");
    const gone = (): HttpError => new HttpError(404, "휴지통에 없는 자료예요");
    const row = await getTrashedFile(sourceId);
    const root = row ? trashStampRoot(row.stamp) : null;
    if (!row || !root || root.kind === "project") throw gone();
    const viewer = viewerFor(req);
    if (!viewer || !(await canSeeSource(sourceId, viewer))) throw gone();
    const rootKey = root.kind;   // 'personal' | 'shared' — 브라우즈의 root 와 같은 말
    const { base, abs: toAbs } = await resolveRootPath(u, rootKey, row.path);
    const mine = await localRootForBrowse(rootKey, u, base, base);
    if (!mine || localRootKey(mine.root) !== localRootKey(root)) throw gone();   // 남의 개인 폴더
    assertBrowseVisible(rootKey === SHARED_ROOT_KEY ? await sharedFolderGate(viewer) : null, base, toAbs);
    const osUser = await userOsUser(u);
    const heldAbs = inBase(base, heldPathOf(row.stamp, row.path));
    await assertJailed(base, heldAbs, osUser);
    return { base, toAbs, heldAbs, osUser, row };
  };

  app.post("/api/ui/terminal/browse/trash/restore", auth, wrap(async (req, res) => {
    const { base, toAbs, heldAbs, osUser, row } = await trashedBrowseFile(req);
    if (!(await fsExists(osUser, heldAbs))) throw new HttpError(410, "보관해 둔 파일이 없어요 — 폴더에서 직접 지워졌을 수 있습니다");
    if (await fsExists(osUser, toAbs)) throw new HttpError(409, "원래 자리에 같은 이름의 파일이 이미 있어요 — 그 파일의 이름을 바꾼 뒤 다시 되돌려 주세요");
    await fsMkdirp(osUser, path.dirname(toAbs));
    await assertJailed(base, path.dirname(toAbs), osUser);   // 그새 부모가 링크로 바뀌었으면 밖으로 옮기지 않는다
    await fsMove(osUser, heldAbs, toAbs);
    await reviveTrashedFile(row.id);
    //  보관 묶음 치우기 — **되살리기는 아무것도 없애지 않는다**: 파일 하나짜리 묶음일 때만(fileTrashBatchCleanup). 실패해도 되살리기는 끝났다.
    if (fileTrashBatchCleanup("restore", row.stamp, row.path, await fileTrashBatchRemaining(row.stamp.batch).catch(() => 1)) === "remove") {
      await fsRemove(osUser, inBase(base, path.posix.join(FILE_TRASH_DIR, row.stamp.batch))).catch(() => { /* 비치명 */ });
    }
    res.json({ ok: true, restored: true, id: row.id, path: row.path });
  }));

  app.post("/api/ui/terminal/browse/trash/purge", auth, wrap(async (req, res) => {
    const { base, heldAbs, osUser, row } = await trashedBrowseFile(req);
    const ctx = { actor: viewerFor(req), source: "web" };
    await fsRemove(osUser, heldAbs).catch(() => { /* 이미 없으면 지울 것이 없다 */ });
    //  자료 행도 남기지 않는다 — 삭제(감사 before) → 그 스냅샷 본문 비우기 → «누가 언제 파기했다» 한 줄(프로젝트 파일 파기와 같은 원칙, #1850).
    await deleteSource(row.id, ctx);
    const scrubbed = await purgeDeleted("source", String(row.id));
    await auditOrgContent("source", String(row.id), "purge", null, { scrubbed_rows: scrubbed }, ctx);
    if (fileTrashBatchCleanup("purge", row.stamp, row.path, await fileTrashBatchRemaining(row.stamp.batch).catch(() => 1)) === "remove") {
      await fsRemove(osUser, inBase(base, path.posix.join(FILE_TRASH_DIR, row.stamp.batch))).catch(() => { /* 비치명 */ });
    }
    res.json({ ok: true, purged: true, id: row.id });
  }));

  // ── 옛 링크 풀기(#4688) — 웹·API 로 이름을 바꾸거나 옮긴 파일·폴더의 옛 경로 → 지금 자리 ─────────────────────────
  //  링크 착지 화면(web/filepage)이 «찾을 수 없음» 을 그리기 전에 부른다. 답은 {root, path, moved} 하나 — 화면은 그 자리 링크로 넘긴다.
  //  · 옛 경로부터 지금 판정을 지난다(resolveBrowse) — 안 보이는 경로는 404 이고, 기록이 있는지도 말하지 않는다.
  //  · 옛 경로에 지금 실제로 무엇이 있으면 그것이 이긴다(moved:false — 따라가지 않는다. 옛 자리에 새 파일이 생긴 경우).
  //  · 기록을 따라 닿은 자리를 **이 사람 기준으로 다시 판정**한다 — 안 보이면 없는 것과 같은 404. 단계 상한은 file-move-core.
  //  · 개인 폴더 기록은 주인별이라 root=personal 은 여는 사람 자신의 기록만 따라간다(링크가 그 사람 폴더로 풀리는 것과 같다).
  //  · 셸 `mv` 로 옮긴 것은 기록이 없어 404 그대로다 — 같은 이름 후보를 보여 주는 화면은 #4672(자료 보기).
  app.get("/api/ui/terminal/browse/moved", auth, wrap(async (req, res) => {
    const rootKey = String(req.query.root ?? "");
    if (rootKey !== SHARED_ROOT_KEY && rootKey !== "personal") throw new HttpError(404, "옮긴 기록이 없습니다");
    const { base, abs, osUser, gate } = await resolveBrowse(req, true);
    const rel = normalizeMovePath(path.relative(base, abs));
    if (!rel) throw new HttpError(404, "옮긴 기록이 없습니다");
    res.setHeader("Cache-Control", "no-store");
    if (await fsExists(osUser, abs)) { res.json({ root: rootKey, path: rel, moved: false }); return; }
    const mine = rootKey === SHARED_ROOT_KEY ? null : await localRootForBrowse(rootKey, userOf(req), base, base);
    const scope = rootKey === SHARED_ROOT_KEY ? SHARED_MOVE_SCOPE : mine?.root.kind === "personal" ? personalMoveScope(mine.root.member) : null;
    if (!scope) throw new HttpError(404, "옮긴 기록이 없습니다");
    const hit = await followMoves(rel, {
      lookup: (p, since) => findFileMove(scope, p, since),
      exists: async (p) => {
        let at: string;
        try { at = inBase(base, p); await assertJailed(base, at, osUser); } catch { return false; }   // 링크로 바깥을 가리키면 없는 것
        return fsExists(osUser, at);
      },
      visible: (p) => !gate || gate.ok(p),
    });
    if (!hit) throw new HttpError(404, "옮긴 기록이 없습니다");
    res.json({ root: rootKey, path: hit.path, moved: true, from: rel, hops: hit.hops });
  }));

  // ── 자료 보기(#4672) — 링크(#/f?root=&path=) 하나가 가리키는 자리의 정보 · 속한 곳 · 자료 ─────────────────────────────
  //  자료 보기 화면(web/filepage)이 미리보기와 함께 부른다. 판정은 목록 · 내려받기와 같은 한 벌(resolveBrowse — 안 보이면 404, 존재 은닉)이고
  //  없는 자리도 **같은 몸**의 404 다(code file_not_found). 그때 화면은 «옛 링크 풀기»(browse/moved) → «같은 이름 후보»(browse/similar) 순으로 묻는다.
  //  code 가 없는 404(이 라우트가 없는 옛 게이트웨이)를 받은 화면만 부모 목록으로 다시 본다. 모양은 files/file-view.
  //  · 앱 폴더는 하나가 다르다(#4671 ③ 결정 1 «동의하지 않은 사람에게는 동의 안내») — 그 앱이 이 사람의 앱 찾기에 서고 켜져 있는데 아직 동의하지
  //    않았으면 403 app_consent_required + 그 앱(id · 이름). 판정에서 떨어진 **뒤에만** 묻고 파일은 보지 않는다 — 그 자리에 파일이 있는지는
  //    새지 않는다. 묻는 앱은 접은 경로의 첫 마디가 앱 id 꼴일 때만(files/file-view appIdOfLink). 앱 주체(앱 세션 토큰)는 안내를 받지 않는다 — 제 앱 폴더만 보는 자리다.
  app.get("/api/ui/terminal/browse/info", auth, wrap(async (req, res) => {
    const rootKey = String(req.query.root ?? "");
    const u = userOf(req);
    const viewer = viewerFor(req);
    const notFound = (): HttpError => new HttpError(404, "경로를 찾을 수 없습니다", { body: { code: "file_not_found" } });
    let at: Awaited<ReturnType<typeof resolveBrowse>>;
    try { at = await resolveBrowse(req, false); }
    catch (e) {
      if (!(e instanceof HttpError) || e.status !== 404) throw e;
      const appId = rootKey === APPS_ROOT_KEY && viewer && !u.appId ? appIdOfLink(String(req.query.path ?? "")) : "";
      const need = appId && viewer ? await appConsentNeeded(viewer, u.scopes ?? [], appId) : null;
      if (need) throw new HttpError(403, `앱 「${need.title}」 사용에 동의한 사람만 이 앱 폴더를 볼 수 있어요`, { body: { code: "app_consent_required", app: need } });
      throw notFound();
    }
    const { base, abs, osUser, gate } = at;
    const info = await buildFileInfo(rootKey, base, abs, {
      stat: async (p) => {
        if (osUser) return memberStat(osUser, p);
        try { const s = await fsp.stat(p); return { file: s.isFile(), dir: s.isDirectory(), size: s.size, mtime: Math.floor(s.mtimeMs) }; }
        catch { return null; }
      },
      //  프로젝트 폴더 좌표(project/<x> · legacy-project/<x>)의 프로젝트 — 이 사람이 볼 수 있을 때만(세션 소속 판정과 같은 함수).
      //   링크의 꼴이 먼저고, 그 폴더를 정확히 가진 프로젝트가 없을 때만 반대 꼴을 본다 — 끝난 프로젝트는 폴더가 legacy-project/ 로 옮겨지는데
      //   DB folder 가 옛 꼴일 수 있다(게이트 · 🔒 이 folderVariants 로 보는 것과 같은 너그러움). folder 는 링크의 꼴로 준다(화면의 위치 줄).
      projectAt: async (rel) => {
        const folder = projectFolderOfCoord(SHARED_ROOT_KEY, rel);
        if (!folder) return null;
        for (const v of folderVariants(folder)) {
          const id = await projectIdForSessionCoord(SHARED_ROOT_KEY, v, viewer);
          const row = id ? await getProjectRow(id) : undefined;
          if (row) return { id: Number(row.id), name: String(row.name ?? ""), folder };
        }
        return null;
      },
      appTitle: async (id) => {
        if (!viewer) return null;
        try { return await appTitleFor(viewer, u.scopes ?? [], id); }
        catch (err) { logger.warn({ err, app: id }, "자료 보기 — 앱 이름을 읽지 못했다(앱 id 로 보인다)"); return null; }
      },
      //  🔒 과 같은 뜻 — 목록(GET browse)이 배지를 다는 규칙 그대로: 공유 폴더 공개범위(조상 포함) 또는 그 자리가 든 프로젝트의 공개범위.
      locked: async (rel) => {
        if (!gate) return false;
        if (gate.restricted(rel)) return true;
        const pf = projectFolderOf(rel);
        if (!pf) return false;
        const restricted = await restrictedProjectFolders();
        return folderVariants(pf).some((v) => restricted.has(v));
      },
      sourceAt: async (p) => {
        try {
          const loc = await localRootForBrowse(rootKey, u, base, p);
          return loc ? await fileViewSourceAt(loc.root, normalizeLocalRel(path.relative(loc.base, p)), viewer) : null;
        } catch (err) { logger.warn({ err, root: rootKey }, "자료 보기 — 자료 요약을 읽지 못했다(자료 칸 없이 보인다)"); return null; }
      },
    });
    if (!info) throw notFound();
    res.setHeader("Cache-Control", "no-store");
    res.json(info);
  }));

  // ── 같은 이름 후보(#4672) — 링크의 자리에 아무것도 없을 때 그 근처에서 이름이 꼭 같은 파일·폴더 ──────────────────────────────
  //  «옛 링크 풀기»(browse/moved)가 기록을 못 찾았을 때(셸 `mv` 는 서버가 모른다) 자료 보기 화면이 부른다. 넘기지는 않는다 — 후보로만 보인다.
  //  · 받은 링크의 경로부터 판정을 지난다(resolveBrowse). 못 보는 자리의 링크는 «볼 수 있는데 근처에 같은 이름이 없는 자리» 와 같은 답(빈 목록)이다 —
  //    정보(browse/info)가 둘을 같은 404 로 답하는 것과 같은 자세. 답은 items 하나뿐이다(잘림 · 범위 같은 덧말을 싣지 않는다).
  //  · 그 자리에 지금 무엇이 있으면 후보가 없다(빈 목록 — 화면은 그것을 연다).
  //  · 찾는 범위는 그 경로가 든 덩어리 하나(프로젝트 폴더 · 앱 폴더 · 맨 위 폴더 — files/same-name sameNameScope)이고 걷는 양 · 시간에 상한이 있다.
  //  · 이 사람이 못 보는 하위 자리(숨은 프로젝트 폴더 · 막힌 공유 폴더 — gate.hiddenWithin)에는 들어가지 않고, 찾은 후보도 하나하나 다시 판정한다.
  //    찾는 일은 이 사람의 uid 로 한다.
  app.get("/api/ui/terminal/browse/similar", auth, wrap(async (req, res) => {
    const rootKey = String(req.query.root ?? "");
    res.setHeader("Cache-Control", "no-store");
    const none = (): void => { res.json({ items: [] }); };
    let at: Awaited<ReturnType<typeof resolveBrowse>>;
    try { at = await resolveBrowse(req, true); }
    catch (e) { if (e instanceof HttpError && e.status === 404) { none(); return; } throw e; }
    const { base, abs, osUser, gate } = at;
    const rel = normalizeMovePath(path.relative(base, abs));
    if (!rel || await fsExists(osUser, abs)) { none(); return; }
    const scope = sameNameScope(rootKey, rel);
    let scopeAbs: string;
    try {
      scopeAbs = inBase(base, scope);
      await assertJailed(base, scopeAbs, osUser, rootKey === APPS_ROOT_KEY && scope ? scope.split("/")[0] : undefined);
    } catch { none(); return; }   // 범위가 링크로 바깥을 가리키면 찾지 않는다
    const skip = (gate?.hiddenWithin(scope) ?? []).map((h) => (scope ? h.slice(scope.length + 1) : h));
    const name = path.basename(abs);
    let found: SameNameFound = { hits: [], truncated: false };
    try {
      found = osUser
        ? (await memberNodeJson<SameNameFound | null>(osUser, SAME_NAME_JS, { base: scopeAbs, name, skip, ...SAME_NAME_LIMITS },
          { timeoutMs: SAME_NAME_LIMITS.maxMs + 5000 })) ?? found
        : await findSameNameLocal(scopeAbs, name, SAME_NAME_LIMITS, skip);
    } catch (err) { logger.warn({ err, root: rootKey }, "같은 이름 후보를 찾지 못했다(후보 없이 보인다)"); }
    //  답에는 싣지 않는 «상한에 닿아 멈춤» 을 운영 쪽에서는 본다 — 시간 · 양 상한이 실제로 얼마나 닿는지(JuiceFS 위에서) 재는 자리.
    if (found.truncated) logger.info({ root: rootKey, scope, hits: found.hits.length, skipped: skip.length }, "같은 이름 후보 — 상한에 닿아 멈췄다");
    const seen = found.hits.map((h) => ({ ...h, path: scope ? `${scope}/${h.path}` : h.path })).filter((h) => !gate || gate.ok(h.path));
    res.json({ items: rankSameName(seen, rel) });
  }));
  // 미리보기/다운로드(?download=1). 격리 멤버면 그 uid 로 stat+cat.
  app.get("/api/ui/terminal/browse/file", auth, wrap(async (req, res) => {
    const { abs, osUser } = await resolveBrowse(req, true);
    await sendFile(res, abs, osUser, req.query.download === "1");
  }));
  // 자료(올린 파일)의 원본 — **자료 id 로** 연다(#1631). 개인 폴더 업로드를 «팀원 모두» 로 올린 자료(share=team)는 올린 사람이
  //  아닌 사람도 목록·원문에서 보는데, 브라우즈 API(root=personal)는 **보는 사람 자기** 개인 폴더로 풀려 동료에게는 «파일 없음»
  //  이거나 같은 이름의 자기 파일이 열렸다. 여기서는 좌표를 요청(root·path)이 아니라 자료 행(external_id)에서 풀고, 공개범위는
  //  자료 상세와 같은 판정(getSource — 안 보이면 없는 자료와 같은 404)을 지난다. MCP source_artifact 와 같은 규칙이다.
  //  ⚠ 개인 폴더 파일만 연다 — 읽기는 **올린 사람의 OS 사용자**로(격리 모드), 심링크 봉쇄도 브라우즈와 같이 건다.
  //   공유·프로젝트 폴더는 브라우즈 API 가 누구에게나 같은 자리를 가리키고 폴더 공개범위 게이트까지 지나므로 그쪽을 쓴다.
  app.get("/api/ui/sources/:id/original", auth, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, "자료 없음");
    //  신원 없는 요청(viewer=null)은 공개범위를 건너뛰는 특권 경로다 — 원본 바이트를 올린 사람 권한으로 내보내는 자리라 여기서 직접 막는다
    //   (인증 계층은 userId 없는 신원을 들이지 않지만 그 보장은 다른 파일에 있다 — 격리 보안 리뷰 제안).
    const viewer = viewerFor(req);
    if (!viewer) throw new HttpError(404, "자료 없음");
    const src = await getSource(id, viewer);
    const loc = src && src.external_system === LOCAL_SYSTEM ? parseLocalExternalId(String(src.external_id ?? "")) : null;
    if (!loc || loc.root.kind !== "personal") throw new HttpError(404, "자료 없음");
    const owner = { userId: loc.root.member, email: "", scopes: [], projects: [] } as unknown as LivelyUser;
    const osUser = await userOsUser(owner);
    const { base, abs } = await resolveRootPath(owner, "personal", loc.rel, osUser);
    if (abs === base) throw new HttpError(404, "자료 없음");
    await assertJailed(base, abs, osUser);
    await sendFile(res, abs, osUser, req.query.download === "1");
  }));
  // 업로드(raw 스트림 → 임시파일 → rename). 격리 멤버면 그 uid 로 써서 파일 소유자=멤버(세션 셸이 이후 편집 가능).
  //  취소·끊김이면 목적지는 손대지 않는다 — 덮어쓰기 업로드를 끊어도 원본이 살아있다(#797 — upload-file.ts).
  app.put("/api/ui/terminal/browse/file", auth, wrap(async (req, res) => {
    assertBrowseWritable(req);
    assertNotAppFolderMount(req.query.path);
    const { base, abs, osUser } = await resolveBrowse(req, true, true);   // 생성 → NFC 정본(#1278b)
    try { await receiveUpload(req, abs, MAX_UPLOAD, osUser); }
    catch (e) { const he = uploadError(e, MAX_UPLOAD); if (!he) return; throw he; } // he=null → 업로드 취소, 응답할 상대가 없다
    //  (#4007) share=team 질의는 폐기했다 — 개인 루트 업로드를 더는 «올린 사람만» 으로 잠그지 않으므로 풀 잠금이 없다.
    //   옛 클라이언트가 계속 붙여 보내도 무해하다(읽는 곳이 없다). 이유는 ingest/local-file.ts 의 #4007 주석에.
    const u = userOf(req);
    // 좌표 해석만 여기 남고 **마무리는 공용 한 자리**(finishUpload) — 프로젝트 업로드 라우트와 같은 함수다(#3787 D).
    //  종전엔 여기와 project-routes 가 각자 마무리를 적어, 한쪽엔 그룹 rw 가 없고 다른 쪽엔 skipped 가 없었다.
    const coord = await localRootForBrowse(String(req.query.root ?? ""), u, base, abs)
      .catch((e) => { console.warn(`[local-ingest] 좌표 해석 실패 ${abs}: ${(e as Error)?.message ?? e}`); return null; });
    res.json(await finishUpload({ coord, abs, osUser, uploader: { id: viewerFor(req), name: u?.email ?? null }, entry: uploadEntryOf(req.headers) }));
  }));

  // 디렉터리 목록(숨김 제외). 격리 세션(#524)은 멤버 uid 로(게이트웨이가 700 홈 못 읽으므로).
  app.get("/api/ui/terminal/sessions/:id/ls", auth, wrap(async (req, res) => {
    const nodeId = await nodeFor(req);
    if (nodeId) { // 노드 세션 — 노드 로컬 fs 목록 릴레이(#875)
      const d = await nodeRpc(nodeId, "fsLs", { id: req.params.id, sub: String(req.query.path ?? ""), user: { userId: idOf(userOf(req)) } });
      res.setHeader("Cache-Control", "no-store"); res.json(d); return;
    }
    const { base, abs, osUser } = await resolveInSession(req, false);
    const items: FsListItem[] = [];
    if (osUser) {
      let entries;
      try { entries = await memberLs(osUser, abs); } catch { throw new HttpError(404, "디렉터리 없음"); }
      for (const e of entries) { if (!e.name.startsWith(".")) items.push({ name: e.name, type: e.type, size: e.size, mtime: e.mtime, ...(e.link ? { link: true, linkTarget: e.linkTarget || "" } : {}) }); }
    } else {
      try { items.push(...await readDirItems(abs)); } catch { throw new HttpError(404, "디렉터리 없음"); }
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
    const { abs, osUser } = await resolveInSession(req, true);
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
    assertNotAppFolderMount(req.query.path);
    const nodeId = await nodeFor(req);
    if (nodeId) { await nodeRpc(nodeId, "fsMkdir", { id: req.params.id, sub: String(req.query.path ?? ""), user: { userId: idOf(userOf(req)) } }); res.json({ ok: true }); return; }
    const { abs, osUser } = await resolveInSession(req, true, true);   // 생성 → NFC 정본(#1278b)
    if (osUser) await memberMkdir(osUser, abs);
    else await fsp.mkdir(abs, { recursive: true });
    res.json({ ok: true });
  }));

  // 업로드(raw 스트림 → 임시파일 → rename). content-type 무관(express.json 은 json 만 소비하므로 스트림 보존).
  //  격리 세션은 멤버 uid 로 써서 파일 소유자가 멤버가 되게 한다(그래야 세션 셸이 이후 편집 가능).
  app.put("/api/ui/terminal/sessions/:id/file", auth, wrap(async (req, res) => {
    assertNotAppFolderMount(req.query.path);
    const nodeId = await nodeFor(req);
    if (nodeId) { // 노드 세션 — 본문을 모아 청크 base64 write 릴레이(#875). 순차 청크(offset 0=truncate, 이후 append).
      const rel = String(req.query.path ?? ""); if (!rel) throw new HttpError(400, "파일 경로가 필요합니다");
      const u = { userId: idOf(userOf(req)) };
      const bufs: Buffer[] = []; let total = 0; let over = false;
      await new Promise<void>((resolve, reject) => {
        req.on("data", (c: Buffer) => { total += c.length; if (total > NODE_RELAY_MAX) { over = true; req.destroy(); return; } bufs.push(c); });
        req.on("end", () => resolve()); req.on("error", reject);
      });
      if (over) throw new HttpError(413, "파일이 너무 큽니다(개인 PC 노드 세션 업로드는 50MB까지 — 큰 파일은 그 PC에서 직접 넣어주세요)");
      const bodyBuf = Buffer.concat(bufs);
      let offset = 0;
      // ★ #3870 — 노드가 돌려준 **절대경로**를 그대로 싣는다(종전엔 버리고 상대경로 `rel` 로 답했다).
      //  이 응답의 용처가 그 차이를 만든다: 드롭·붙여넣기 업로드는 받은 `path` 를 **입력창에 꽂아** 그 안에서
      //  도는 에이전트가 읽게 한다(web/standalone/terminal.ts dropFileToAgent). 에이전트의 cwd 는 세션 루트와
      //  다를 수 있어(프로젝트 하위 폴더에서 뜬 하네스) 상대경로는 «파일이 없다» 가 된다 — 로컬 경로 분기가
      //  절대경로(`abs`)를 주는 이유가 정확히 그것이고, 노드 분기만 그 약속을 어기고 있었다(agent.ts fsWrite 는
      //  이미 `{ ok, path: abs }` 를 돌려준다 — 게이트웨이가 그걸 읽지 않았을 뿐이다).
      // ★ #3787 — **게이트웨이가 정본을 먼저 쓴다.** 이 요청의 바이트는 브라우저 → 게이트웨이 → 노드로 흐르므로
      //  게이트웨이 손에 이미 있다(노드에서 «만들어진» 파일과 반대다 — 그건 못 읽어서 push 훅이 필요하다).
      //  종전엔 릴레이만 하고 자기 사본을 안 써서, 중앙에 닿는 길이 push 훅 하나뿐이었다 → **하네스가 안 돌면
      //  영영 안 왔다**(실측 2026-09-14: 윈도우 노드 크레딧 소진 중 드롭한 파일이 몇 시간 로컬에만 있었다).
      //  노드 배달은 **pull 이 한다** — 여기서 같이 릴레이하면 fsWrite 가 mtime 을 못 맞춰 두 사본의 mtime 이
      //  갈리고, 원장 기준선이 없어 다음 pull 이 «공통 조상 없는 두 판본» 으로 보고 영구 거짓 충돌을 만든다.
      //  드롭은 경로를 입력창에 꽂을 뿐이고 사람이 엔터를 치므로, project-pull-turn 이 모델보다 먼저 받아둔다.
      const gw = await gatewayUploadForNodeSession(req.params.id, idOf(userOf(req)), rel);
      if (gw) {
        const absGw = path.resolve(gw.base, gw.rel);
        if (absGw === gw.base || !absGw.startsWith(gw.base + path.sep)) throw new HttpError(400, "허용 경로를 벗어났습니다");
        if (!(await gw.store.confined(absGw))) throw new HttpError(400, "허용 경로를 벗어났습니다");   // 링크 해소 뒤 재판정(#3668 T1)
        await gw.store.writeBuffer(absGw, bodyBuf);
        const fin = await finishUpload({ coord: gw.coord, abs: absGw, osUser: gw.store.osUser, uploader: { id: viewerFor(req), name: userOf(req)?.email ?? null }, entry: uploadEntryOf(req.headers) });
        // path 는 **노드에서의 절대경로**로 답한다 — 드롭 UI 가 이 값을 입력창에 꽂고, 그 안의 에이전트는 노드에 산다.
        //  (아직 안 내려왔을 수 있지만 그게 맞는 경로다. 없으면 주입 훅이 «이 컴퓨터에 없습니다» 로 크게 말한다.)
        res.json({ ...fin, path: gw.nodeAbs, delivery: "pull" }); return;
      }
      // 좌표를 못 잡는 세션(개인 폴더·프로젝트 밖) — 게이트웨이에 둘 자리가 없다. 종전대로 릴레이만.
      let nodeAbs = "";
      do {
        const slice = bodyBuf.subarray(offset, offset + NODE_FS_CHUNK);
        const r = await nodeRpc<{ path?: string }>(nodeId, "fsWrite", { id: req.params.id, path: rel, offset, data: slice.toString("base64"), user: u });
        if (r?.path) nodeAbs = String(r.path);
        offset += NODE_FS_CHUNK;
      } while (offset < bodyBuf.length);
      res.json({ ok: true, path: nodeAbs || rel }); return;   // 구 노드가 경로를 안 주면 종전대로 상대경로
    }
    const { abs, osUser } = await resolveInSession(req, true, true);   // 생성 → NFC 정본(#1278b)
    try { await receiveUpload(req, abs, MAX_UPLOAD, osUser); }
    catch (e) { const he = uploadError(e, MAX_UPLOAD); if (!he) return; throw he; } // he=null → 업로드 취소, 응답할 상대가 없다
    // #3787 D — 이 라우트는 **좌표를 고르지 않는다**. 바이트는 세션 작업폴더(= 이미 정해진 자리)에 놓이고,
    //  그 자리가 알려진 루트 안이면 마무리는 다른 업로드 입구와 **같은 함수**를 지난다(자료 등록·좌표 ref·도장).
    //  종전엔 여기만 `{ok,path}` 로 끝나서, 세션에 드롭한 파일은 다음 push 훅이 돌 때까지 자료가 되지 않았다.
    //  좌표를 못 잡으면(루트 밖) 종전 그대로 경로만 — 지어내지 않는다.
    const u = userOf(req);
    const coord = await sessionUploadCoord(u, abs);
    res.json({ ...await finishUpload({ coord, abs, osUser, uploader: { id: viewerFor(req), name: u?.email ?? null }, entry: uploadEntryOf(req.headers) }), path: abs });
    // path = 세션 작업폴더 기준 절대경로(드롭 업로드가 입력창에 꽂아 cwd 무관하게 찾게) — finishUpload 와 같은 값이지만 계약으로 못 박는다.
  }));
}

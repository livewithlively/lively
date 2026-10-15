import { strict as assert } from "node:assert";
import test from "node:test";
import { RateWindow } from "./app-chat-send.js";
import { PROJECT_FILES_PER_MINUTE, PROJECT_FILE_READ_MAX, declaredExts, declaredWorkspaceExts, extOf, listProjectFiles, normalizeRelPath, readProjectFile, type ProjectFilesDeps, type ProjectFileEntry, type WorkspaceFileEntry } from "./app-project-files.js";
import { PROJECT_FILES_TOOL, WORKSPACE_FILES_TOOL, parseAppManifest } from "./manifest.js";
import { memberAppViolations } from "./member-app.js";
import type { OrgApp, AppGrantRow } from "../org/store/apps.js";
import type { SessionAppRow } from "./session-apps.js";

// ── 앱 화면 → 붙은 세션의 프로젝트 자료 읽기 (#4592) ──────────────────────────────────
//  이게 틀리면: 선언 안 한 앱이 프로젝트 파일을 읽는다 · 동의 없는 앱이 읽는다 · 남의 세션의 프로젝트를 읽는다 · 뗀 앱이 계속 읽는다 ·
//  가려진 프로젝트의 파일이 앱으로 샌다 · 선언하지 않은 종류(.env · .json)를 경로를 지어내 읽는다 · `..` 로 폴더 밖을 읽는다 ·
//  목록이 최신순이 아니라 «방금 만든 파일» 이 밑에 깔린다.

const declared = { permissions: { tools: ["store_query", PROJECT_FILES_TOOL], project_files: ["html", "htm"] } };
const app = (over: Partial<OrgApp> = {}): OrgApp => ({
  id: "deck-edit", title: "장표 수정", version: "1.1.0", manifest: declared, source: { kind: "builtin" }, content_hash: null,
  status: "active", enabled: true, installed_by: null, installed_at: "", updated_at: "", updated_by: null, edit_mode: "all", edit_members: [],
  builtin_version: null, current_version_no: null, visibility: "all", published_version_no: null, published_at: null, published_by: null, draft_by: null, made_by: null, owner_member: null, build_session: null, origin_app_id: null, ...over,
});
const grant = (tools: string[] = ["store_*", PROJECT_FILES_TOOL]): AppGrantRow => ({ app_id: "deck-edit", member_id: "alice", scopes: [], tools, granted_at: "", granted_by: null, revoked_at: null });
const row = (appId: string): SessionAppRow => ({ session_id: "box-a", app_id: appId, member_id: "alice", attached_at: "" });
const T = Date.parse("2026-10-07T09:00:00.000Z");
const FILES: ProjectFileEntry[] = [
  { path: "기획안/옛 시안.html", mtime: T - 86_400_000, size: 20_480 },
  { path: "out/새 제안서.html", mtime: T, size: 4096 },
  { path: "out/덱.HTM", mtime: T - 1000, size: 3_700_000 },
  { path: "메모.md", mtime: T + 5000, size: 10 },
  { path: "data/secrets.json", mtime: T + 9000, size: 10 },
  { path: "README", mtime: T + 9500, size: 10 },
];
interface World { app: OrgApp | null; grant: AppGrantRow | null; owner: string | null; attached: string[]; project: { id: number; folder: string } | null; canSee: boolean; files: ProjectFileEntry[]; truncated: boolean; content: Record<string, string>; big?: number }
function deps(over: Partial<World> = {}): ProjectFilesDeps & { reads: string[]; manifests: number } {
  const w: World = { app: app(), grant: grant(), owner: "alice", attached: ["deck-edit"], project: { id: 4577, folder: "project/4577" }, canSee: true, files: FILES, truncated: false,
    content: { "out/새 제안서.html": "<html><body>제안</body></html>" }, ...over };
  const out = {
    reads: [] as string[], manifests: 0,
    getApp: async () => w.app,
    getGrant: async () => w.grant,
    sessionOwner: async () => w.owner,
    listAttached: async () => w.attached.map(row),
    projectOfSession: async () => w.project,
    canSeeProject: async () => w.canSee,
    manifest: async () => { out.manifests++; return { files: w.files, truncated: w.truncated }; },
    readText: async (_p: unknown, _m: string, rel: string) => {
      out.reads.push(rel);
      if (w.big) return { tooBig: w.big };
      return rel in w.content ? { content: w.content[rel], size: w.content[rel].length, mtime: T } : null;
    },
    now: () => 1_000_000,
    tenant: () => "t1",
  };
  return out;
}
const q = (over: Partial<{ member: string; sessionId: string; ext: unknown; limit: unknown }> = {}) => ({ appId: "deck-edit", sessionId: over.sessionId ?? "box-a", member: over.member ?? "alice", ext: over.ext, limit: over.limit });
const rq = (path: unknown, over: Partial<{ member: string; sessionId: string }> = {}) => ({ appId: "deck-edit", sessionId: over.sessionId ?? "box-a", member: over.member ?? "alice", path });
const status = async (p: Promise<unknown>): Promise<number | "ok"> => { try { await p; return "ok"; } catch (e) { return (e as { status?: number }).status ?? -1; } };
const message = async (p: Promise<unknown>): Promise<string> => { try { await p; return ""; } catch (e) { return (e as { message?: string }).message ?? ""; } };
const fresh = () => new RateWindow(PROJECT_FILES_PER_MINUTE);

test("F1 목록 — 선언한 확장자(html · htm)만, 최신순, 이름 · 크기 · 시각과 함께", async () => {
  const r = await listProjectFiles(q(), deps(), fresh());
  assert.equal(r.project_id, 4577);
  assert.deepEqual(r.files.map((f) => f.path), ["out/새 제안서.html", "out/덱.HTM", "기획안/옛 시안.html"]);
  assert.deepEqual(r.files[0], { path: "out/새 제안서.html", name: "새 제안서.html", size: 4096, mtime: "2026-10-07T09:00:00.000Z" });
  assert.equal(r.truncated, false);
});

test("F2 요청한 확장자는 선언한 것 안에서만 — 선언 밖(json · md)을 요청해도 안 나온다", async () => {
  assert.deepEqual((await listProjectFiles(q({ ext: ["htm"] }), deps(), fresh())).files.map((f) => f.path), ["out/덱.HTM"]);
  assert.deepEqual((await listProjectFiles(q({ ext: "html,json" }), deps(), fresh())).files.map((f) => f.path), ["out/새 제안서.html", "기획안/옛 시안.html"]);
  assert.deepEqual((await listProjectFiles(q({ ext: ["json", "md"] }), deps(), fresh())).files, []);
  assert.deepEqual((await listProjectFiles(q({ ext: [".HTML"] }), deps(), fresh())).files.length, 2, "점 · 대문자는 다듬는다");
});

test("F3 limit — 기본 200 · 최대 500 · 넘치면 truncated", async () => {
  const many = Array.from({ length: 700 }, (_, i) => ({ path: `d/${i}.html`, mtime: T - i, size: 1 }));
  const a = await listProjectFiles(q(), deps({ files: many }), fresh());
  assert.equal(a.files.length, 200); assert.equal(a.truncated, true); assert.equal(a.files[0].path, "d/0.html");
  assert.equal((await listProjectFiles(q({ limit: 9999 }), deps({ files: many }), fresh())).files.length, 500);
  assert.equal((await listProjectFiles(q({ limit: 3 }), deps({ files: many }), fresh())).files.length, 3);
  assert.equal((await listProjectFiles(q({ limit: 0 }), deps({ files: many }), fresh())).files.length, 200, "0 · 이상한 값은 기본");
  assert.equal((await listProjectFiles(q(), deps({ truncated: true }), fresh())).truncated, true, "저장소가 잘랐으면 그대로 알린다");
});

test("F4 선언 없음 → 403 — project_files 를 선언하지 않은 앱은 목록도 내용도 못 본다(도구 이름만 적어도 안 된다)", async () => {
  const noDecl = app({ manifest: { permissions: { tools: ["store_query"] } } });
  const toolOnly = app({ manifest: { permissions: { tools: [PROJECT_FILES_TOOL] } } });
  const extOnly = app({ manifest: { permissions: { tools: ["store_query"], project_files: ["html"] } } });
  for (const a of [noDecl, toolOnly, extOnly]) {
    const d = deps({ app: a });
    assert.equal(await status(listProjectFiles(q(), d, fresh())), 403);
    assert.equal(await status(readProjectFile(rq("out/새 제안서.html"), d, fresh())), 403);
    assert.equal(d.manifests, 0); assert.equal(d.reads.length, 0);
  }
});

test("F5 동의 없음 → 403 · 예전 범위 동의 → 403 「다시 동의」(호스트가 그 문구로 동의 창을 띄운다)", async () => {
  assert.equal(await status(listProjectFiles(q(), deps({ grant: null }), fresh())), 403);
  const old = deps({ grant: grant(["store_query", "store_insert"]) });
  assert.equal(await status(listProjectFiles(q(), old, fresh())), 403);
  assert.match(await message(listProjectFiles(q(), old, fresh())), /다시 동의\(grant\)/);
  assert.equal(old.manifests, 0);
});

test("F6 세션 주인이 아니면 403 · 세션이 없으면 404 · 세션 id 가 없으면 400", async () => {
  assert.equal(await status(listProjectFiles(q(), deps({ owner: "bob" }), fresh())), 403);
  assert.equal(await status(listProjectFiles(q(), deps({ owner: null }), fresh())), 404);
  assert.equal(await status(listProjectFiles(q({ sessionId: " " }), deps(), fresh())), 400);
});

test("F7 그 세션에 붙어 있지 않으면 403 — 뗀 앱은 못 읽는다", async () => {
  const d = deps({ attached: ["memo"] });
  assert.equal(await status(listProjectFiles(q(), d, fresh())), 403);
  assert.equal(await status(readProjectFile(rq("out/새 제안서.html"), d, fresh())), 403);
  assert.equal(d.manifests + d.reads.length, 0);
});

test("F8 프로젝트 없는 세션 · 가려진 프로젝트 → 빈 목록(오류 아님) · 읽기는 404", async () => {
  for (const w of [{ project: null }, { canSee: false }, { project: { id: 9, folder: "" } }] as Array<Partial<World>>) {
    const d = deps(w);
    assert.deepEqual(await listProjectFiles(q(), d, fresh()), { project_id: null, files: [], truncated: false });
    assert.equal(await status(readProjectFile(rq("out/새 제안서.html"), d, fresh())), 404);
    assert.equal(d.manifests + d.reads.length, 0, "가려진 프로젝트의 저장소는 열지도 않는다");
  }
});

test("F9 읽기 — 내용 · 크기 · 시각", async () => {
  const d = deps();
  assert.deepEqual(await readProjectFile(rq("/out/새 제안서.html"), d, fresh()), { path: "out/새 제안서.html", content: "<html><body>제안</body></html>", size: 28, mtime: "2026-10-07T09:00:00.000Z" });
  assert.deepEqual(d.reads, ["out/새 제안서.html"]);
});

test("F10 선언하지 않은 확장자는 경로를 알아도 못 읽는다 → 403 · 저장소에 닿지 않는다", async () => {
  const d = deps();
  for (const p of ["data/secrets.json", "메모.md", "README", "out/덱.html.bak", "a/b.HTMLX"]) assert.equal(await status(readProjectFile(rq(p), d, fresh())), 403, p);
  assert.equal(d.reads.length, 0);
});

test("F11 경로 — `..` · 빈 마디 · 숨김 마디 · 역슬래시 · NUL 은 400 · 저장소에 닿지 않는다", async () => {
  const d = deps();
  for (const p of ["../x.html", "a/../../x.html", "a//b.html", "./a.html", ".git/x.html", "a/.env.html", "a\\b.html", "a\0.html", "", "/", null, undefined, "x".repeat(1100) + ".html"]) {
    assert.equal(await status(readProjectFile(rq(p), d, fresh())), 400, String(p).slice(0, 20));
  }
  assert.equal(d.reads.length, 0);
  assert.equal(normalizeRelPath("//a/b c.html"), "a/b c.html");
});

test("F12 없는 파일 → 404 · 너무 큰 파일 → 413", async () => {
  assert.equal(await status(readProjectFile(rq("out/없는.html"), deps(), fresh())), 404);
  assert.equal(await status(readProjectFile(rq("out/새 제안서.html"), deps({ big: PROJECT_FILE_READ_MAX + 1 }), fresh())), 413);
});

test("F13 빈도 — (테넌트 · 사람 · 앱) 분당 상한을 넘으면 429 · 채팅 빈도와 따로 센다", async () => {
  const d = deps(); const rate = new RateWindow(3);
  for (let i = 0; i < 3; i++) assert.equal(await status(listProjectFiles(q(), d, rate)), "ok");
  assert.equal(await status(listProjectFiles(q(), d, rate)), 429);
  assert.equal(await status(readProjectFile(rq("out/새 제안서.html"), d, rate)), 429, "목록과 읽기가 한 창을 쓴다");
  assert.equal(rate.take("t1\0alice\0deck-edit", 1_000_000), true, "세션에 글 보내기의 열쇠는 다른 창이다");
});

test("F14 꺼진 앱 → 409 · 없는 앱 → 404", async () => {
  assert.equal(await status(listProjectFiles(q(), deps({ app: null }), fresh())), 404);
  assert.equal(await status(listProjectFiles(q(), deps({ app: app({ enabled: false }) }), fresh())), 409);
});

test("M1 매니페스트 — project_files 를 선언하면 app_project_files 도구가 따라붙는다 · 기본은 빈 배열(못 읽는다)", () => {
  const base = { id: "x-app", title: "X", version: "1.0.0" };
  const a = parseAppManifest({ ...base, permissions: { project_files: ["html", "htm"] } });
  assert.deepEqual(a.permissions.project_files, ["html", "htm"]);
  assert.ok(a.permissions.tools.includes(PROJECT_FILES_TOOL));
  const b = parseAppManifest({ ...base });
  assert.deepEqual(b.permissions.project_files, []);
  assert.ok(!b.permissions.tools.includes(PROJECT_FILES_TOOL));
  assert.deepEqual(declaredExts({ manifest: a } as unknown as OrgApp), ["html", "htm"]);
});

test("M2 매니페스트 — 확장자는 점 없이 소문자 · 숫자 1~8자, 8개까지. 와일드카드 · 경로 · 대문자는 거부", () => {
  const base = { id: "x-app", title: "X", version: "1.0.0" };
  for (const bad of [["*"], [".html"], ["HTML"], ["a/b"], [""], ["toolongext"], Array.from({ length: 9 }, (_, i) => "e" + i)]) {
    assert.throws(() => parseAppManifest({ ...base, permissions: { project_files: bad } }), /매니페스트|확장자|project_files/, JSON.stringify(bad));
  }
});

test("M3 구성원이 저장하는 앱도 선언할 수 있다(동의가 관문이다) — 빌트인 「장표 수정」을 워크스페이스 판으로 저장해도 막히지 않는다", () => {
  const m = parseAppManifest({ id: "x-app", title: "X", version: "1.0.0", permissions: { project_files: ["html"], chat_send: true } });
  assert.deepEqual(memberAppViolations(m), []);
});

test("extOf — 마지막 점 뒤 · 소문자 · 점으로 시작하는 이름은 확장자 없음", () => {
  assert.equal(extOf("a/b/C.HTML"), "html");
  assert.equal(extOf("a/b.tar.gz"), "gz");
  assert.equal(extOf("README"), "");
  assert.equal(extOf(".env"), "");
  assert.equal(extOf("a.b/README"), "");
});

// ── 전체 자료 (#4629) — scope 'all' 은 붙은 세션의 프로젝트 밖을 본다. 제 선언 · 제 동의로만 열린다 ─────────────────
//  이게 틀리면: 프로젝트 자료에만 동의한 사람의 앱이 다른 프로젝트의 파일을 읽는다 · 가려진 프로젝트의 파일이 목록이나 내용으로 샌다 ·
//  앱이 project_id 를 지어내 좁은 동의로 넓은 곳을 읽는다 · 옛 호스트의 답(붙은 프로젝트 목록)을 전체로 잘못 쓴다.
const wideDecl = { permissions: { tools: ["store_query", PROJECT_FILES_TOOL, WORKSPACE_FILES_TOOL], project_files: ["html", "htm"], workspace_files: ["html"] } };
const wideGrant = () => grant(["store_*", PROJECT_FILES_TOOL, WORKSPACE_FILES_TOOL]);
const INDEX: WorkspaceFileEntry[] = [
  { project_id: 3625, project_name: "지원사업", path: "덱/리뉴얼.html", mtime: T, size: 3_800_000, session: "box-a" },
  { project_id: 4577, project_name: "세일즈", path: "out/새 제안서.html", mtime: T - 10, size: 4096, session: "box-z" },
  { project_id: 9000, project_name: "잠긴 프로젝트", path: "비밀.html", mtime: T - 20, size: 10 },
  { project_id: 3625, project_name: "지원사업", path: "덱/메모.htm", mtime: T - 30, size: 10 },
];
function wide(over: Partial<World> & { index?: WorkspaceFileEntry[]; hidden?: number[]; made?: string[] } = {}) {
  const d = deps({ app: app({ manifest: wideDecl }), grant: wideGrant(), ...over });
  const asked: Array<{ exts: string[]; q: string; limit: number }> = [];
  const hidden = over.hidden ?? [9000];
  return Object.assign(d, {
    asked,
    canSeeProject: async (id: number) => !hidden.includes(id),
    workspaceIndex: async (_m: string, exts: string[], o: { q: string; limit: number }) => { asked.push({ exts, ...o }); return (over.index ?? INDEX).slice(0, o.limit); },
    projectById: async (id: number) => (id === 3625 || id === 9000 ? { id, folder: "project/" + id } : null),
    sessionMade: async () => over.made ?? [],
    readText: async (p: { id: number }, _m: string, rel: string) => { d.reads.push(p.id + ":" + rel); return { content: "<html>" + p.id + "</html>", size: 10, mtime: T }; },
  });
}

test("W1 전체 자료 목록 — 볼 수 있는 프로젝트의 선언한 확장자만 · 줄마다 프로젝트 · 이 세션이 만든 것 표시 · scope 를 되돌려 준다", async () => {
  const d = wide();
  const r = await listProjectFiles({ ...q(), scope: "all" }, d, fresh());
  assert.equal(r.scope, "all");
  assert.equal(r.project_id, 4577, "붙은 세션의 프로젝트는 그대로 알려 준다");
  assert.deepEqual(r.files.map((f) => f.project_id + ":" + f.path), ["3625:덱/리뉴얼.html", "4577:out/새 제안서.html"], "가려진 프로젝트(9000) · 선언 밖 확장자(htm)는 없다");
  assert.deepEqual(r.files[0], { path: "덱/리뉴얼.html", name: "리뉴얼.html", size: 3_800_000, mtime: "2026-10-07T09:00:00.000Z", project_id: 3625, project_name: "지원사업", from_session: true });
  assert.equal(r.files[1].from_session, undefined, "다른 세션이 만든 것에는 표시가 없다");
  assert.deepEqual(d.asked[0].exts, ["html"]);
  assert.equal(d.manifests, 0, "프로젝트마다 폴더를 훑지 않는다");
});

test("W2 전체 자료는 제 선언 · 제 동의로만 — 프로젝트 자료에만 동의했으면 403 「다시 동의」, 선언이 없으면 403", async () => {
  const narrowGrant = wide({ grant: grant() });
  assert.equal(await status(listProjectFiles({ ...q(), scope: "all" }, narrowGrant, fresh())), 403);
  assert.match(await message(listProjectFiles({ ...q(), scope: "all" }, narrowGrant, fresh())), /다시 동의|grant/);
  assert.equal(narrowGrant.asked.length, 0);
  assert.equal(await status(readProjectFile({ ...rq("덱/리뉴얼.html"), projectId: 3625 }, narrowGrant, fresh())), 403);
  assert.equal(narrowGrant.reads.length, 0);
  const noDecl = wide({ app: app() });   // project_files 만 선언한 앱
  assert.equal(await status(listProjectFiles({ ...q(), scope: "all" }, noDecl, fresh())), 403);
  assert.equal(await status(readProjectFile({ ...rq("덱/리뉴얼.html"), projectId: 3625 }, noDecl, fresh())), 403);
  //  좁은 쪽은 종전대로 된다
  assert.equal(await status(listProjectFiles(q(), narrowGrant, fresh())), "ok");
});

test("W3 전체 자료 읽기 — 지목한 프로젝트에서 읽는다 · 가려진 프로젝트 · 없는 프로젝트는 404(같은 답) · 선언 밖 확장자 403", async () => {
  const d = wide();
  const r = await readProjectFile({ ...rq("덱/리뉴얼.html"), projectId: 3625 }, d, fresh());
  assert.equal(r.content, "<html>3625</html>");
  assert.deepEqual(d.reads, ["3625:덱/리뉴얼.html"]);
  assert.equal(await status(readProjectFile({ ...rq("비밀.html"), projectId: 9000 }, d, fresh())), 404);
  assert.equal(await status(readProjectFile({ ...rq("x.html"), projectId: 1234 }, d, fresh())), 404);
  assert.equal(await status(readProjectFile({ ...rq("덱/메모.htm"), projectId: 3625 }, d, fresh())), 403, "workspace_files 에는 htm 이 없다");
  assert.equal(await status(readProjectFile({ ...rq("../x.html"), projectId: 3625 }, d, fresh())), 400);
  for (const bad of ["abc", -1, 1.5, 0]) assert.equal(await status(readProjectFile({ ...rq("a.html"), projectId: bad }, d, fresh())), 400, String(bad));
  assert.deepEqual(d.reads, ["3625:덱/리뉴얼.html"], "막힌 것은 저장소에 닿지 않는다");
});

test("W4 전체 자료도 세션에 붙은 화면에서만 — 남의 세션 · 뗀 앱은 종전과 같은 답", async () => {
  assert.equal(await status(listProjectFiles({ ...q(), scope: "all" }, wide({ owner: "bob" }), fresh())), 403);
  assert.equal(await status(listProjectFiles({ ...q(), scope: "all" }, wide({ attached: [] }), fresh())), 403);
  assert.equal(await status(readProjectFile({ ...rq("덱/리뉴얼.html"), projectId: 3625 }, wide({ attached: [] }), fresh())), 403);
  //  프로젝트 없는 세션에서도 전체 자료는 선다
  const r = await listProjectFiles({ ...q(), scope: "all" }, wide({ project: null }), fresh());
  assert.equal(r.project_id, null); assert.equal(r.files.length, 2);
});

test("W5 찾는 말 · limit · 넘침 — q 는 색인으로 간다(100자) · limit+1 을 물어 넘쳤는지 안다 · 모르는 scope 는 400", async () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ project_id: 3625, project_name: "P", path: `d/${i}.html`, mtime: T - i, size: 1 }));
  const d = wide({ index: many });
  const r = await listProjectFiles({ ...q({ limit: 50 }), scope: "all", q: "  덱 리뉴얼  " }, d, fresh());
  assert.equal(r.files.length, 50); assert.equal(r.truncated, true);
  assert.deepEqual(d.asked[0], { exts: ["html"], q: "덱 리뉴얼", limit: 51 });
  assert.equal((await listProjectFiles({ ...q(), scope: "all" }, wide(), fresh())).truncated, false);
  assert.equal(await status(listProjectFiles({ ...q(), scope: "everything" }, wide(), fresh())), 400);
});

test("W6 프로젝트 자료 목록에도 «이 세션이 만든 것» 표시 — 색인이 아는 경로에만 · 색인을 못 읽어도 목록은 선다", async () => {
  const r = await listProjectFiles(q(), wide({ made: ["out/덱.HTM"] }), fresh());
  assert.deepEqual(r.files.map((f) => [f.path, f.from_session === true]), [["out/새 제안서.html", false], ["out/덱.HTM", true], ["기획안/옛 시안.html", false]]);
  assert.equal(r.scope, undefined, "좁은 목록에는 scope 가 없다(옛 답과 같은 꼴)");
  const broken = Object.assign(wide(), { sessionMade: async () => { throw new Error("색인 없음"); } });
  assert.equal((await listProjectFiles(q(), broken, fresh())).files.length, 3);
});

test("W7 매니페스트 — workspace_files 를 선언하면 app_workspace_files 가 따라붙는다 · 기본은 빈 배열 · 구성원 앱도 선언할 수 있다", () => {
  const base = { id: "x-app", title: "X", version: "1.0.0" };
  const a = parseAppManifest({ ...base, permissions: { workspace_files: ["html"] } });
  assert.ok(a.permissions.tools.includes(WORKSPACE_FILES_TOOL));
  assert.ok(!a.permissions.tools.includes(PROJECT_FILES_TOOL), "넓은 쪽을 선언했다고 좁은 쪽이 따라오지 않는다");
  assert.deepEqual(declaredWorkspaceExts({ manifest: a } as unknown as OrgApp), ["html"]);
  const b = parseAppManifest({ ...base, permissions: { project_files: ["html"] } });
  assert.deepEqual(b.permissions.workspace_files, []);
  assert.ok(!b.permissions.tools.includes(WORKSPACE_FILES_TOOL));
  assert.throws(() => parseAppManifest({ ...base, permissions: { workspace_files: ["*"] } }));
  assert.deepEqual(memberAppViolations(a), []);
});

test("W8 가려진 프로젝트의 줄이 limit 을 채워도 «넘쳤다» 고 하지 않는다 · 붙은 프로젝트가 가려져 있으면 그 id 도 알려 주지 않는다", async () => {
  const hiddenRows = Array.from({ length: 3 }, (_, i) => ({ project_id: 9000, project_name: "잠긴 프로젝트", path: `비밀${i}.html`, mtime: T - i, size: 10 }));
  const r = await listProjectFiles({ ...q({ limit: 2 }), scope: "all" }, wide({ index: hiddenRows }), fresh());
  assert.deepEqual(r.files, []);
  assert.equal(r.truncated, false, "걸러진 줄 수로 가려진 파일이 있다는 것이 새면 안 된다");
  const h = await listProjectFiles({ ...q(), scope: "all" }, wide({ project: { id: 9000, folder: "project/9000" } }), fresh());
  assert.equal(h.project_id, null);
  assert.equal(h.files.length, 2, "보이는 프로젝트의 파일은 그대로 나온다");
});

test("W9 project_id 는 양의 정수뿐 — 배열 · 숫자 아닌 글은 400, 저장소에 닿지 않는다", async () => {
  const d = wide();
  for (const bad of [[3625], "3625abc", "1e2x", {}, true]) assert.equal(await status(readProjectFile({ ...rq("덱/리뉴얼.html"), projectId: bad }, d, fresh())), 400, JSON.stringify(bad));
  assert.equal(d.reads.length, 0);
});

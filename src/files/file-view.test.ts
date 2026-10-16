// 자료 보기(#4672) — 정보 모양(사양 표 D, 가짜 의존) + 배선(F — 새 셸 라우터 · 클래식 진입 · 화면 흐름을 소스에서). DB · 화면 불요.
//  사양(태스크 #4672): 링크는 워크스페이스 안 «자료 보기» 로 열린다 — 미리보기 · 정보(종류 · 크기 · 위치 · 주소 · 볼 수 있는 사람 · 자료) ·
//   속한 프로젝트/앱으로 가기 · 내려받기. 안 보이면 «찾을 수 없음». 앱 폴더는 동의한 사람만(아니면 동의 안내). 옛 링크는 새 자리로,
//   기록 없이 사라진 경로는 같은 이름 후보. 끝단(실제 판정 · 자료 행 · 후보)은 src/files/file-view.pg-test.mjs 가 실 Postgres 로 잰다.
//   실행: npm run build && node --test dist/files/file-view.test.js
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { buildFileInfo, addressOfLink, topFolderOf, type FileInfoDeps, type FileViewSource } from "./file-view.js";

const ROOT = path.resolve(new URL("../../", import.meta.url).pathname.replace("/dist/", "/"));
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const before = (body: string, a: string, b: string, why: string): void => {
  const i = body.indexOf(a), j = body.indexOf(b);
  assert.ok(i >= 0, `없다: ${a}`);
  assert.ok(j >= 0, `없다: ${b}`);
  assert.ok(i < j, why);
};

const SRC: FileViewSource = { id: 7, title: "a.md", entry: "upload", uploaderId: "m1", uploaderName: "m1@x", createdAt: "2026-10-16T00:00:00.000Z", knowledge: [] };

/** 가짜 의존 — 무엇을 물었는지 적는다(물으면 안 되는 것을 물었는지 본다). */
function deps(over: Partial<FileInfoDeps> & { statOf?: Record<string, { file: boolean; dir: boolean; size: number; mtime?: number }> } = {}) {
  const asked: string[] = [];
  const d: FileInfoDeps = {
    stat: async (abs) => { asked.push("stat"); return over.statOf ? (over.statOf[abs] ?? null) : { file: true, dir: false, size: 12, mtime: 1700000000000 }; },
    projectAt: async (rel) => { asked.push("projectAt:" + rel); return null; },
    appTitle: async (id) => { asked.push("appTitle:" + id); return null; },
    locked: async (rel) => { asked.push("locked:" + rel); return false; },
    sourceAt: async () => { asked.push("sourceAt"); return null; },
    ...over,
  };
  return { d, asked };
}

// ── D. 정보 모양 ──────────────────────────────────────────────────────────────
test("D1 그 자리에 아무것도 없으면 null(부르는 쪽 404 — 안 보이는 것과 같은 답) · 파일도 폴더도 아닌 것도", async () => {
  assert.equal(await buildFileInfo("shared", "/b", "/b/x.md", deps({ statOf: {} }).d), null);
  assert.equal(await buildFileInfo("shared", "/b", "/b/x", deps({ statOf: { "/b/x": { file: false, dir: false, size: 0 } } }).d), null);
});

test("D2 프로젝트 폴더 파일 — 그 프로젝트(볼 수 있을 때) · 주소 · 크기 · 고친 때 · 자료", async () => {
  const { d, asked } = deps({
    projectAt: async (rel) => (rel.startsWith("project/12/") ? { id: 12, name: "설계", folder: "project/12" } : null),
    sourceAt: async () => SRC,
  });
  const info = await buildFileInfo("shared", "/b", "/b/project/12/docs/a.md", d);
  assert.deepEqual(info, {
    root: "shared", path: "project/12/docs/a.md", name: "a.md", type: "file", size: 12, mtime: 1700000000000,
    address: "shared/project/12/docs/a.md", place: { kind: "project", id: 12, name: "설계", folder: "project/12" }, locked: false, source: SRC,
  });
  assert.ok(asked.includes("locked:project/12/docs/a.md"), "잠김 여부를 묻지 않았다");
});

test("D3 프로젝트를 못 보면(또는 없는 프로젝트) 프로젝트라고 말하지 않는다 — 맨 위 폴더로", async () => {
  const info = await buildFileInfo("shared", "/b", "/b/project/12/a.md", deps().d);
  assert.deepEqual(info?.place, { kind: "folder", folder: "project" });
});

test("D4 그 밖 공유 폴더 — 맨 위 파일은 자리 자신(\"\") · 맨 위 폴더는 그 이름 · 깊은 파일은 맨 위 폴더", async () => {
  assert.deepEqual((await buildFileInfo("shared", "/b", "/b/a.md", deps().d))?.place, { kind: "folder", folder: "" });
  const dir = deps({ statOf: { "/b/팀자료": { file: false, dir: true, size: 4096 } } }).d;
  assert.deepEqual((await buildFileInfo("shared", "/b", "/b/팀자료", dir))?.place, { kind: "folder", folder: "팀자료" });
  assert.deepEqual((await buildFileInfo("shared", "/b", "/b/팀자료/x/y.md", deps().d))?.place, { kind: "folder", folder: "팀자료" });
  assert.equal(topFolderOf("", true), "");
});

test("D5 앱 폴더 파일 — 그 앱(이름 · 못 읽으면 id) · 주소 apps/… · 자료는 묻지도 않는다(앱 폴더 파일은 자료가 아니다)", async () => {
  const named = deps({ appTitle: async (id) => (id === "crm" ? "고객 관리" : null) });
  const a = await buildFileInfo("apps", "/t/apps", "/t/apps/crm/out/a.png", named.d);
  assert.deepEqual({ place: a?.place, address: a?.address, source: a?.source, locked: a?.locked },
    { place: { kind: "app", id: "crm", name: "고객 관리" }, address: "apps/crm/out/a.png", source: null, locked: false });
  assert.ok(!named.asked.includes("sourceAt"), "앱 폴더 파일의 자료를 물었다");
  assert.ok(!named.asked.some((x) => x.startsWith("locked:")), "앱 폴더에 공유 폴더 잠김을 물었다");
  const unnamed = await buildFileInfo("apps", "/t/apps", "/t/apps/crm/a.png", deps().d);
  assert.deepEqual(unnamed?.place, { kind: "app", id: "crm", name: "crm" });
});

test("D6 앱 폴더 자리 자신 — 폴더 · 주소 'apps' · 앱이 아니다", async () => {
  const d = deps({ statOf: { "/t/apps": { file: false, dir: true, size: 0 } } }).d;
  const info = await buildFileInfo("apps", "/t/apps", "/t/apps", d);
  assert.deepEqual({ type: info?.type, path: info?.path, name: info?.name, address: info?.address, place: info?.place },
    { type: "dir", path: "", name: "", address: "apps", place: { kind: "folder", folder: "" } });
});

test("D7 개인 폴더 — 주소 없음 · 잠김 묻지 않음(false) · 자료는 묻는다", async () => {
  const { d, asked } = deps({ sourceAt: async () => SRC });
  const info = await buildFileInfo("personal", "/h/box", "/h/box/uploads/a.png", d);
  assert.deepEqual({ place: info?.place, address: info?.address, locked: info?.locked, source: info?.source },
    { place: { kind: "personal" }, address: null, locked: false, source: SRC });
  assert.ok(!asked.some((x) => x.startsWith("locked:")));
});

test("D8 폴더 — 크기 0 · 자료를 묻지 않는다 · 공유 자리 자신은 잠김을 묻지 않는다", async () => {
  const sd = deps({ statOf: { "/b/x": { file: false, dir: true, size: 4096, mtime: 5 }, "/b": { file: false, dir: true, size: 4096 } } });
  const info = await buildFileInfo("shared", "/b", "/b/x", sd.d);
  assert.deepEqual({ type: info?.type, size: info?.size, source: info?.source }, { type: "dir", size: 0, source: null });
  assert.ok(!sd.asked.includes("sourceAt"));
  const rootInfo = await buildFileInfo("shared", "/b", "/b", sd.d);
  assert.deepEqual({ path: rootInfo?.path, locked: rootInfo?.locked, address: rootInfo?.address }, { path: "", locked: false, address: "shared" });
  assert.ok(!sd.asked.includes("locked:"), "자리 자신의 잠김을 물었다");
});

test("D9 잠김 — 공유 폴더 공개범위가 참이면 locked", async () => {
  const info = await buildFileInfo("shared", "/b", "/b/hr/a.md", deps({ locked: async (rel) => rel.startsWith("hr") }).d);
  assert.equal(info?.locked, true);
});

test("D10 고친 때가 없는 stat 은 0 · 점 마디가 든 자리는 주소가 없다", async () => {
  const info = await buildFileInfo("shared", "/b", "/b/.lively/x.md", deps({ statOf: { "/b/.lively/x.md": { file: true, dir: false, size: 3 } } }).d);
  assert.deepEqual({ mtime: info?.mtime, address: info?.address }, { mtime: 0, address: null });
  assert.equal(addressOfLink("personal", "a.md"), null);
  assert.equal(addressOfLink("shared", "a/.x/b"), null);
  assert.equal(addressOfLink("apps", "Bad_Id/x"), null, "앱 id 규칙을 벗어난 앱 폴더는 주소가 없다");
  assert.equal(addressOfLink("shared", ""), "shared");
});

// ── F. 배선(소스) ─────────────────────────────────────────────────────────────
test("F1 새 셸 라우터 — 'f' 는 자료 보기(renderFileView)를 셸 안에 그린다 · 클래식 액자 표엔 없다 · 활성 키 · 레일은 자료", () => {
  const main = read("web/v2/main.ts");
  const render = main.slice(main.indexOf("async function renderRoute"), main.indexOf("\nfunction markActive"));
  const fb = render.slice(render.indexOf("} else if (page === 'f') {"), render.indexOf("} else if (page === 'taxonomy') {"));
  assert.ok(fb.length > 0 && render.indexOf("} else if (page === 'f') {") >= 0, "라우터에 'f' 갈래가 없다");
  assert.match(fb, /renderFileView\(tab\.center, params, \{/, "자료 보기를 그리지 않는다");
  assert.match(fb, /sourceHref: \(id\) => '#\/sources\/' \+ id/, "자료 앱 문이 없다");
  assert.match(fb, /consent: \(appId, title\) => ensureAppGrant\(appId, title\)/, "앱 동의 창을 꽂지 않았다");
  assert.match(fb, /openApp: /, "앱 열기 문을 꽂지 않았다");
  assert.match(fb, /isCurrent: \(\) => tab\.seq === seq,/, "탭마다 본창이 따로인데 주소로 «아직 이 자리인가» 를 잰다(다른 탭을 보는 사이 굳는다)");
  const rr = fb.slice(fb.indexOf("replaceRoute: (hash) => {"), fb.indexOf("sourceHref:"));
  assert.ok(rr.length > 0, "옛 링크 넘기기를 그 탭의 주소로 하지 않는다");
  before(rr, "if (tab.seq !== seq) return;", "tab.route = hash;", "늦게 온 답이 다른 화면이 된 탭의 주소를 바꾼다");
  before(rr, "if (tabsApi?.current() === tab) {", "location.replace(", "보고 있지 않은 탭의 넘기기가 주소창(다른 탭)을 바꾼다");
  assert.match(rr, /else \{ tab\.rendered = false; tabsApi\?\.routed\(tab\); \}/, "보고 있지 않은 탭은 돌아올 때 새 자리로 그려야 한다");
  before(render, "} else if (page === 'f') {", "} else if (CLASSIC_PAGES[page]) {", "클래식 액자 갈래가 먼저 서면 'f' 가 액자로 간다");
  const apps = read("web/v2/apps.ts");
  const classic = apps.slice(apps.indexOf("export const CLASSIC_PAGES"), apps.indexOf("};", apps.indexOf("export const CLASSIC_PAGES")));
  assert.doesNotMatch(classic, /\bf:\s*'/, "클래식 액자 표에 'f' 가 남아 있다(셸이 그리지 않고 액자에 싣는다)");
  assert.match(main, /cur\.segs\[0\] === 'sources' \|\| cur\.segs\[0\] === 'f' \? 'sources'/, "사이드바가 자료의 나무로 바뀌지 않는다");
  const surf = read("web/v2/shell-surfaces.ts");
  assert.match(surf, /\n\s*f: \{ kind: "app", appId: "sources"/, "대장에 자료 앱의 화면으로 적혀 있지 않다");
  assert.match(surf, /if \(page === "f"\) return "sources";/, "레일의 자료가 켜지지 않는다");
});

test("F2 클래식 진입 — 새 셸이 실은 액자 안이면 셸 창의 주소를 옮긴다(액자 안에 두 번째 화면을 세우지 않는다)", () => {
  const fp = read("web/filepage.ts");
  const entry = fp.slice(fp.indexOf("async function renderFilePage"), fp.indexOf("function renderFileView"));
  before(entry, "document.body.classList.contains('embed')", "await paintFileView(", "액자 확인보다 먼저 그린다");
  assert.match(entry, /top\.location\.hash = location\.hash; return;/, "셸 창으로 넘기지 않는다");
});

test("F3 화면 흐름 — 정보 → (403 동의 안내) → 없으면 옛 링크 풀기 먼저 → 넘김(replace) → 같은 이름 후보 → 찾을 수 없음", () => {
  const fp = read("web/filepage.ts");
  const paint = fp.slice(fp.indexOf("async function paintFileView"), fp.indexOf("// ── 위치(브레드크럼)"));
  before(paint, "api('/api/ui/terminal/browse/info?' + browseQs(root, rel))", "await movedTo(root, rel)", "정보보다 옛 링크를 먼저 묻는다");
  assert.match(paint, /e\.status === 403 && e\.body && e\.body\.code === 'app_consent_required'/, "앱 동의 안내 갈래가 없다");
  before(paint, "showConsent(", "await movedTo(", "동의 안내를 «찾을 수 없음» 흐름보다 먼저 가른다");
  before(paint, "await movedTo(root, rel)", "location.replace(fileLinkHash(root, to))", "넘기기 전에 기록을 묻지 않는다");
  before(paint, "location.replace(fileLinkHash(root, to))", "await sameNameNear(root, rel)", "기록이 있는데도 후보를 먼저 찾는다");
  before(paint, "if (env.replaceRoute) env.replaceRoute(fileLinkHash(root, to));", "else location.replace(fileLinkHash(root, to));", "셸이 준 넘기기를 안 쓴다");
  assert.match(paint, /const current = env\.isCurrent \?\? \(\(\): boolean => location\.hash === startHash\);/, "셸이 준 «아직 이 자리인가» 를 안 쓴다");
  assert.doesNotMatch(paint, /location\.hash !== startHash/, "주소 비교가 남아 있다 — 새 셸의 탭은 주소로 재면 굳는다");
  before(paint, "await sameNameNear(root, rel)", "이 링크의 대상을 찾을 수 없어요", "후보 없이 안내만 그린다");
  assert.match(fp, /api\('\/api\/ui\/terminal\/browse\/similar\?' \+ browseQs\(root, rel\)\)/, "같은 이름 후보를 서버에 묻지 않는다");
});

test("F4 서버 라우트 — 정보 · 후보가 판정(resolveBrowse)을 먼저 지나고, 동의 안내는 판정에서 떨어진 뒤에만 묻는다", () => {
  const tf = read("src/terminal/terminal-files.ts");
  const info = tf.slice(tf.indexOf('app.get("/api/ui/terminal/browse/info"'), tf.indexOf('app.get("/api/ui/terminal/browse/similar"'));
  before(info, "try { at = await resolveBrowse(req, false); }", "appConsentNeeded(", "판정 전에 앱 동의를 묻는다");
  before(info, "e.status === 404 && rootKey === APPS_ROOT_KEY", "appConsentNeeded(", "앱 폴더 밖에서도 동의를 묻는다");
  assert.match(info, /!u\.appId/, "앱 주체에게도 동의 안내를 낸다");
  before(info, "const { base, abs, osUser, gate } = at;", "buildFileInfo(", "판정을 지나지 않은 자리의 정보를 만든다");
  const sim = tf.slice(tf.indexOf('app.get("/api/ui/terminal/browse/similar"'), tf.indexOf("// 미리보기/다운로드(?download=1)"));
  before(sim, "await resolveBrowse(req, true)", "findSameNameLocal(", "받은 경로를 판정하기 전에 찾는다");
  before(sim, "await fsExists(osUser, abs)", "sameNameScope(", "지금 있는 자리에도 후보를 찾는다");
  assert.match(sim, /\.filter\(\(h\) => !gate \|\| gate\.ok\(h\.path\)\)/, "후보를 이 사람 기준으로 다시 판정하지 않는다");
  assert.match(sim, /memberNodeJson<SameNameFound \| null>\(osUser, SAME_NAME_JS,/, "격리 멤버면 그 uid 로 찾지 않는다");
});

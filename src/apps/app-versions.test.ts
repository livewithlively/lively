// 앱 판(#4600, 「장표 수정 앱」 #4592) — 순수 판정과 파일 묶음 재구성의 엣지 표(사양 표 S5 가운데 DB 없이 못박을 수 있는 행).
//  이게 틀리면: 보관 규칙이 새면 원본 판이 지워져 「원본으로」 가 사라진다 · 덮어쓰기 판정이 새면 부팅 시딩이 사람이 고친 판을
//  릴리스 원본으로 되돌린다 · 묶음 재구성이 새면 app_pull 이 세션 스크립트(bin/)를 빠뜨려 AI 가 올리기 방법을 잃는다.
//  실 DB 흐름(판 1·2 생성 · revert · 시더 건너뛰기)은 scripts/app-versions.itest.mjs(docker pg, 수동).
import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  APP_VERSION_KEEP, APP_VERSION_TOTAL_MAX_BYTES, entriesOfManifest, filesFromStored, filesToInline, hasPackageDir, isOverrideSource, isTextPath,
  newTablesForOverride, originOfCurrent, overlayFiles, overrideSourceMeta, readPackageDir, seedShouldSkipOverride, versionsToPrune,
  versionsToPruneForQuota, PACKAGE_FILE_MAX_BYTES,
} from "./app-versions.js";
import { isBuiltinSource } from "./store-ddl.js";
import { shouldRetireBuiltin } from "./seed.js";
import { editDenial } from "./member-app.js";
import { parseAppManifest } from "./manifest.js";
import type { OrgApp } from "../org/store/apps.js";

// ── 덮어쓰기 출처 ──────────────────────────────────────────────────────────────
test("[V1] 덮어쓴 빌트인은 kind 'builtin' 을 유지한다 — 데이터 표 스키마가 isBuiltinSource 로 갈리기 때문", () => {
  const meta = overrideSourceMeta({ kind: "inline", files: 2, bytes: 1234 }, "deck-edit");
  assert.equal(meta.kind, "builtin");
  assert.equal(meta.overrides_builtin, true);
  assert.equal(meta.builtin_id, "deck-edit");
  assert.equal(meta.files, 2, "스테이지 메타(파일 수·바이트)는 살린다");
  assert.equal(isBuiltinSource(meta), true, "스키마 판정은 빌트인 그대로");
  assert.equal(isOverrideSource(meta), true);
});

test("[V2] 덮어쓰기 판정 — 릴리스 그대로 · 세션이 만든 앱 · 빈 값은 전부 false", () => {
  assert.equal(isOverrideSource({ kind: "builtin" }), false);
  assert.equal(isOverrideSource({ kind: "inline", overrides_builtin: true }), false, "kind 가 inline 이면 덮어쓰기가 아니라 워크스페이스 앱이다");
  assert.equal(isOverrideSource({ kind: "builtin", overrides_builtin: "yes" }), false, "참 그대로만");
  for (const s of [null, undefined, {}, "builtin"]) assert.equal(isOverrideSource(s), false, JSON.stringify(s));
});

test("[V3] 판의 origin — 릴리스 그대로면 builtin, 덮어썼거나 워크스페이스 앱이면 member", () => {
  assert.equal(originOfCurrent({ kind: "builtin" }), "builtin");
  assert.equal(originOfCurrent({ kind: "builtin", overrides_builtin: true }), "member");
  assert.equal(originOfCurrent({ kind: "inline" }), "member");
});

// ── 보관 규칙 ───────────────────────────────────────────────────────────────────
test("[V4] 구성원 판은 최신 20개만 남기고 원본 판은 세지도 지우지도 않는다", () => {
  assert.equal(APP_VERSION_KEEP, 20);
  const rows = [{ version_no: 1, origin: "builtin" }];
  for (let i = 2; i <= 25; i++) rows.push({ version_no: i, origin: "member" });
  const prune = versionsToPrune(rows);
  assert.deepEqual(prune.sort((a, b) => a - b), [2, 3, 4, 5], "구성원 판 24개 가운데 오래된 4개");
  assert.ok(!prune.includes(1), "원본 판 1 은 보관 수 밖이어도 안 지운다");
});

test("[V5] 보관 수 안이면 아무것도 안 지운다 · 순서가 섞여 있어도 번호로 판정한다", () => {
  assert.deepEqual(versionsToPrune([{ version_no: 3, origin: "member" }, { version_no: 1, origin: "builtin" }, { version_no: 2, origin: "member" }]), []);
  const shuffled = [5, 2, 4, 1, 3].map((n) => ({ version_no: n, origin: "member" }));
  assert.deepEqual(versionsToPrune(shuffled, 2).sort((a, b) => a - b), [1, 2, 3]);
});

test("[V15] 워크스페이스 총량 상한 — 오래된 구성원 판부터 합이 상한 아래가 될 때까지, 지금 서빙 중인 판은 건너뛴다(앱 불문)", () => {
  assert.equal(APP_VERSION_TOTAL_MAX_BYTES, 64 * 1024 * 1024);
  const rows = [
    { app_id: "a", version_no: 2, bytes: 30, is_current: false },
    { app_id: "b", version_no: 5, bytes: 30, is_current: true },     // 지금 서빙 중 — 건너뛴다
    { app_id: "a", version_no: 3, bytes: 30, is_current: false },
    { app_id: "b", version_no: 6, bytes: 30, is_current: false },
  ];
  assert.deepEqual(versionsToPruneForQuota(rows, 120, 70), [{ app_id: "a", version_no: 2 }, { app_id: "a", version_no: 3 }], "120 → 90 → 60 ≤ 70 에서 멈춘다");
  assert.deepEqual(versionsToPruneForQuota(rows, 60, 70), [], "상한 안이면 아무것도 안 지운다");
  assert.deepEqual(versionsToPruneForQuota(rows, 1000, 70).map((v) => `${v.app_id}:${v.version_no}`), ["a:2", "a:3", "b:6"], "모자라도 서빙 중인 판은 끝까지 안 지운다");
});

test("[V16] 덮어쓴 빌트인이 새로 선언한 표만 관문을 지난다 — 릴리스에 있던 표는 그대로", () => {
  const release = { data: { tables: [{ name: "notes" }, { name: "tags" }] } };
  assert.deepEqual(newTablesForOverride(release, ["notes", "tags", "comments"]), ["comments"]);
  assert.deepEqual(newTablesForOverride(release, ["notes"]), []);
  assert.deepEqual(newTablesForOverride(null, ["a", "b"]), ["a", "b"], "릴리스 매니페스트를 모르면 전부 새 표로 본다(보수적)");
  assert.deepEqual(newTablesForOverride({ data: {} }, []), []);
});

// ── 시더 · 은퇴 ────────────────────────────────────────────────────────────────
test("[V6] 시더는 덮어쓴 빌트인만 건너뛴다 — 릴리스 그대로·미설치·워크스페이스 앱은 종전 경로", () => {
  assert.equal(seedShouldSkipOverride({ source: { kind: "builtin", overrides_builtin: true } }), true);
  assert.equal(seedShouldSkipOverride({ source: { kind: "builtin" } }), false);
  assert.equal(seedShouldSkipOverride({ source: { kind: "inline" } }), false);
  assert.equal(seedShouldSkipOverride(null), false);
  assert.equal(seedShouldSkipOverride(undefined), false);
});

test("[V7] 은퇴 회수는 덮어쓴 빌트인을 지우지 않는다 — 사람이 고쳐 쓰는 그 워크스페이스의 판", () => {
  const none = new Set<string>();
  assert.equal(shouldRetireBuiltin("hello", none, { source: { kind: "builtin" } }), true, "릴리스 그대로는 종전처럼 회수");
  assert.equal(shouldRetireBuiltin("hello", none, { source: { kind: "builtin", overrides_builtin: true } }), false);
});

// ── 고치기 권한(member-app.ts 바뀐 규칙) ───────────────────────────────────────
const base = { id: "deck-edit", title: "장표 수정", version: "1.0.0", ui: { pages: [{ key: "main", title: "장표 수정", entry: "ui/index.html" }] },
  data: { tables: [{ name: "docs", columns: [{ name: "doc", type: "text" }] }] } };
const app = (over: Partial<OrgApp> = {}): OrgApp => ({
  id: "deck-edit", title: "장표 수정", version: "1.0.0", manifest: base, source: { kind: "builtin" }, content_hash: null,
  status: "active", enabled: true, installed_by: null, installed_at: "", updated_at: "", updated_by: null,
  edit_mode: "all", edit_members: [], builtin_version: "1.0.0", current_version_no: null, ...over,
});
const bob = { userId: "bob", scopes: ["memory"] };

test("[V8] 화면·데이터만으로 된 빌트인은 구성원이 고칠 수 있다(기본 전원) · 지정한 사람만이면 그 규칙", () => {
  assert.equal(editDenial(app(), bob, parseAppManifest(base)), null);
  assert.equal(editDenial(app({ source: { kind: "builtin", overrides_builtin: true } }), bob, parseAppManifest(base)), null, "덮어쓴 뒤에도 같은 규칙");
  assert.ok(editDenial(app({ edit_mode: "members", edit_members: ["carol"] }), bob, parseAppManifest(base)));
});

test("[V9] 셸 렌더러 같은 화면·데이터 밖 선언이 있는 빌트인은 종전처럼 못 고친다 — 메시지가 «기본 앱» 을 말한다", () => {
  const why = editDenial(app({ id: "browser", title: "웹 브라우저" }), bob, parseAppManifest({ ...base, id: "browser", system: { renderer: "browser" } }));
  assert.ok(why && why.includes("기본 앱"), why ?? "(null)");
});

// ── 파일 묶음 재구성 ───────────────────────────────────────────────────────────
test("[V10] DB 재구성 — 매니페스트는 lively-app.json 으로, 화면은 매니페스트 entry 경로로. 선언 없는 page_key 는 버린다", () => {
  const files = filesFromStored(base, [{ page_key: "main", html: "<p>hi</p>" }, { page_key: "ghost", html: "x" }]);
  assert.deepEqual(files.map((f) => f.path), ["lively-app.json", "ui/index.html"]);
  assert.equal(JSON.parse(files[0].content).id, "deck-edit");
  assert.equal(files[1].content, "<p>hi</p>");
  assert.deepEqual(entriesOfManifest({ ui: { pages: [{ key: "a", entry: "./ui/a.html" }], widgets: [{ key: "w", entry: "ui/w.html" }] } }).map((e) => e.kind), ["page", "widget"]);
  assert.deepEqual(entriesOfManifest({}), [], "모양이 없어도 던지지 않는다");
});

test("[V11] 덮기 — 같은 경로는 위가 이기고 그 밖은 아래 차례 그대로(bin/ 이 남는다)", () => {
  const folder = [{ path: "lively-app.json", content: "old" }, { path: "bin/deck-push.mjs", content: "#!" }, { path: "ui/index.html", content: "old-ui" }];
  const out = overlayFiles(folder, [{ path: "ui/index.html", content: "new-ui" }, { path: "lively-app.json", content: "new" }, { path: "ui/extra.html", content: "e" }]);
  assert.deepEqual(out.map((f) => [f.path, f.content]), [["lively-app.json", "new"], ["bin/deck-push.mjs", "#!"], ["ui/index.html", "new-ui"], ["ui/extra.html", "e"]]);
});

test("[V12] 패키지 폴더 읽기 — bin/ 포함 재귀 · 글 파일은 utf8 · 그 밖은 base64 · 숨김·node_modules 제외 · 폴더 없으면 없다고 한다", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "app-pkg-"));
  try {
    mkdirSync(path.join(dir, "bin"), { recursive: true });
    mkdirSync(path.join(dir, "ui"), { recursive: true });
    mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(path.join(dir, "lively-app.json"), JSON.stringify(base));
    writeFileSync(path.join(dir, "ui", "index.html"), "<!doctype html>한글");
    writeFileSync(path.join(dir, "bin", "deck-push.mjs"), "console.log(1)");
    writeFileSync(path.join(dir, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]));
    writeFileSync(path.join(dir, ".DS_Store"), "x");
    writeFileSync(path.join(dir, "node_modules", "x", "index.js"), "x");
    assert.equal(await hasPackageDir(dir), true);
    const files = await readPackageDir(dir);
    assert.deepEqual(files.map((f) => f.path), ["bin/deck-push.mjs", "icon.png", "lively-app.json", "ui/index.html"]);
    const png = files.find((f) => f.path === "icon.png")!;
    assert.equal(png.encoding, "base64");
    assert.deepEqual([...Buffer.from(png.content, "base64")], [0x89, 0x50, 0x4e, 0x47, 0, 255]);
    assert.equal(files.find((f) => f.path === "ui/index.html")!.content, "<!doctype html>한글");
    assert.equal(files.find((f) => f.path === "ui/index.html")!.encoding, undefined);
    // 되돌려 넣는 모양(inline) — base64 표식이 살아 있어야 바이너리가 안 깨진다
    const inline = filesToInline(files);
    assert.equal(inline.find((f) => f.path === "icon.png")!.encoding, "base64");
    assert.equal("encoding" in inline.find((f) => f.path === "lively-app.json")!, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(await hasPackageDir(path.join(tmpdir(), "no-such-app-pkg-" + Date.now())), false);
});

test("[V13] 파일 하나가 상한을 넘으면 400 — 되돌려 넣을 수 없는 묶음은 내려주지 않는다", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "app-pkg-big-"));
  try {
    writeFileSync(path.join(dir, "lively-app.json"), "{}");
    writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(PACKAGE_FILE_MAX_BYTES + 1));
    let status: unknown = "ok";
    try { await readPackageDir(dir); } catch (e) { status = (e as { status?: number }).status; }
    assert.equal(status, 400);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("[V14] 글 파일 판정은 확장자로 — 화면·스크립트·문서는 글, 그림·글꼴은 아니다", () => {
  for (const p of ["ui/index.html", "lively-app.json", "bin/x.mjs", "README.md", "a.svg"]) assert.equal(isTextPath(p), true, p);
  for (const p of ["icon.png", "font.woff2", "x.bin", "noext"]) assert.equal(isTextPath(p), false, p);
});

test("[W1] 새 능력 셋이 등록돼 있고 scope 가 없다(구성원 누구나) · app_save 가 note 를 받는다", async () => {
  const { appCapabilities } = await import("../capabilities/apps.js");
  for (const name of ["app_pull", "app_versions", "app_revert"]) {
    const cap = appCapabilities.find((c) => c.name === name);
    assert.ok(cap, `${name} 등록`);
    assert.equal(cap!.scope, null, `${name} scope`);
    assert.equal(cap!.expose.mcp, true, `${name} MCP 노출`);
  }
  const save = appCapabilities.find((c) => c.name === "app_save")!;
  assert.ok("note" in save.input, "app_save 입력에 note");
});

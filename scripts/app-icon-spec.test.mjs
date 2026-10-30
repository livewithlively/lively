// #4769 구성원 앱의 아이콘 선언 — 매니페스트 icon { path, color, color_dark? } 가 서버 검사 · 화면 등록 · 그리기까지 한 줄로 이어진다.
//  사양 · 엣지 표(spec-failfirst — 스크래치 spec.md 의 표 그대로):
//   S1 서버 파서: 맞는 선언은 그대로 통과 · color_dark 없어도 통과 · icon 칸이 없어도 통과
//   S2 서버 파서: path 에 " 나 < 는 거부 · 2000자 통과 · 2001자 거부 · 색이 #RRGGBB 가 아니면 거부 · 모르는 칸(strict) 거부
//   S3 appIconSpecOf(저장된 매니페스트): 문자열 · null · 없음은 null(던지지 않는다) · color_dark 만 틀리면 그 칸만 뺀다 · path 양끝 공백은 뗀다
//   W1 화면 등록: `app-<id>` 이름 · iconPath(이름) = path · 같은 선언 두 번이면 <style> 하나 · 표의 이름(wiki)은 덮지 못한다
//   W2 화면 등록: 틀린 선언은 null · installedAppFace 는 기본 그림(liv · term) · 앱 id 가 비면 null
//   W3 색 토큰: <style> 에 라이트 · 명시 다크 · 시스템 다크 셋 · 다크 색이 없으면 라이트 색 · 다른 색으로 다시 등록하면 새 색
//   W4 appGlassMarkup(등록한 이름) = 그 그림 + 그 색 토큰 · 등록 안 한 app-… 은 apps 로
//   W5 앱 id 글자 정리(영문 소문자 · 숫자 · 하이픈) · B 기본 그림(builtinAppIcon)은 종전 그대로
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) pass++; else { fail++; console.log("  FAIL " + name + (extra == null ? "" : " → " + JSON.stringify(extra).slice(0, 300))); } };
const HASH = "M9.5 3.5 7.5 20.5 M16.5 3.5l-2 17 M4 9h17 M3 15h17";

// ── 서버 파서(src/apps/manifest.ts) — 빌드 산출(dist)로 읽는다(zod 를 끼고 돈다). dist 가 없으면 S 검사는 실패로 센다(건너뛰면 통과한 척이 된다).
const distManifest = join(root, "dist/apps/manifest.js");
if (existsSync(distManifest)) {
  const mani = await import(distManifest);
  const base = { id: "talk", title: "팀 채널", version: "0.1.0", ui: { pages: [{ key: "main", entry: "ui/index.html", title: "팀 채널" }] } };
  const parse = (icon) => { try { return { ok: true, m: mani.parseAppManifest(icon === undefined ? base : { ...base, icon }) }; } catch (e) { return { ok: false, e: String((e && e.message) || e) }; } };
  const good = parse({ path: HASH, color: "#118E6E", color_dark: "#3EDCAB" });
  ok(good.ok && good.m.icon && good.m.icon.path === HASH && good.m.icon.color === "#118E6E" && good.m.icon.color_dark === "#3EDCAB", "S1 맞는 선언은 그대로 통과", good);
  const noDark = parse({ path: HASH, color: "#118E6E" });
  ok(noDark.ok && noDark.m.icon && noDark.m.icon.color_dark === undefined, "S1b color_dark 없어도 통과");
  ok(parse(undefined).ok && parse(undefined).m.icon === undefined, "S1c icon 칸이 없어도 통과");
  ok(!parse({ path: 'M1 1"onload="x', color: "#118E6E" }).ok, 'S2a path 에 " 는 거부');
  ok(!parse({ path: "M1 1<svg>", color: "#118E6E" }).ok, "S2b path 에 < 는 거부");
  ok(parse({ path: "M".repeat(2000), color: "#118E6E" }).ok, "S2c path 2000자는 통과(경계)");
  ok(!parse({ path: "M".repeat(2001), color: "#118E6E" }).ok, "S2d path 2001자는 거부(경계+1)");
  ok(!parse({ path: "M1 1", color: "red" }).ok && !parse({ path: "M1 1", color: "#12345" }).ok && !parse({ path: "M1 1", color: "#1234567" }).ok, "S2e 색은 #RRGGBB 만");
  ok(!parse({ path: "M1 1", color: "#118E6E", glyph: "hash" }).ok, "S2f 모르는 칸(strict)은 거부");
  const spec = mani.appIconSpecOf;
  ok(typeof spec === "function" && spec({ icon: "hash" }) === null && spec({ icon: null }) === null && spec({}) === null && spec(null) === null, "S3a 문자열 · null · 없음은 null(던지지 않는다)");
  const d = spec({ icon: { path: "M1 1", color: "#118E6E", color_dark: "zzz" } });
  ok(d && d.color === "#118E6E" && d.color_dark === undefined, "S3b color_dark 만 틀리면 그 칸만 뺀다", d);
  ok(spec({ icon: { path: "  M1 1 \n", color: "#118E6E" } })?.path === "M1 1", "S3c path 양끝 공백은 뗀다");
} else {
  ok(false, "S0 서버 파서 검사에 dist/apps/manifest.js 가 필요하다 — npm run build 뒤 다시");
}

// ── 화면(web/lib/icon-paths.ts · web/v2/glass-icon.ts) — ts 를 옮겨 가짜 문서 위에서 읽는다 ──
const transpile = (src) => ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const styles = new Map();
globalThis.document = {
  head: { append: (el) => { styles.set(el.id, el); } },
  getElementById: (id) => styles.get(id) || null,
  createElement: (tag) => ({ tag, id: "", textContent: "" }),
  createElementNS: (_ns, tag) => ({ tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, innerHTML: "" }),
};
const pathsUrl = "data:text/javascript;base64," + Buffer.from(transpile(readFileSync(join(root, "web/lib/icon-paths.ts"), "utf8"))).toString("base64");
const paths = await import(pathsUrl);
const glassSrc = readFileSync(join(root, "web/v2/glass-icon.ts"), "utf8").replace("'../lib/icon-paths.js'", JSON.stringify(pathsUrl));
const glass = await import("data:text/javascript;base64," + Buffer.from(transpile(glassSrc)).toString("base64"));

const name = glass.registerAppIcon("talk", { path: HASH, color: "#118E6E", color_dark: "#3EDCAB" });
ok(name === "app-talk" && paths.iconPath("app-talk") === HASH, "W1 등록하면 app-<id> 이름 · iconPath 가 그 그림", { name, d: paths.iconPath("app-talk") });
const before = styles.get("v2-app-icon-app-talk") && styles.get("v2-app-icon-app-talk").textContent;
glass.registerAppIcon("talk", { path: HASH, color: "#118E6E", color_dark: "#3EDCAB" });
ok(styles.size === 1 && styles.get("v2-app-icon-app-talk").textContent === before, "W1b 같은 선언 두 번이면 <style> 하나");
const wikiBefore = paths.iconPath("wiki");
paths.registerIconPath("wiki", "M0 0");
ok(paths.iconPath("wiki") === wikiBefore && wikiBefore !== "M0 0", "W1c 표의 이름(wiki)은 등록으로 덮지 못한다");
ok(glass.registerAppIcon("bad", { path: 'M1 1" onload="x', color: "#118E6E" }) === null && glass.registerAppIcon("bad2", { path: "M1 1", color: "red" }) === null && glass.registerAppIcon("bad3", { path: "M".repeat(2001), color: "#118E6E" }) === null, "W2a 틀린 선언은 null");
ok(glass.installedAppFace({ id: "bad", hasUi: true, icon: { path: 'M1 1"', color: "#118E6E" } }) === "liv" && glass.installedAppFace({ id: "x", hasUi: false, icon: null }) === "term" && glass.installedAppFace({ id: "talk2", hasUi: true, icon: { path: HASH, color: "#118E6E" } }) === "app-talk2", "W2a installedAppFace: 틀리면 기본 그림 · 맞으면 등록한 이름");
ok(glass.registerAppIcon("", { path: HASH, color: "#118E6E" }) === null, "W2b 앱 id 가 비면 null");
const st = styles.get("v2-app-icon-app-talk").textContent;
ok(/:root\{--gi-c-app-talk:#118E6E\}/.test(st) && /:root\[data-theme="dark"\]\{--gi-c-app-talk:#3EDCAB\}/.test(st) && /@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\)\{--gi-c-app-talk:#3EDCAB\}\}/.test(st), "W3 색 토큰 <style> — 라이트 · 명시 다크 · 시스템 다크", st);
glass.registerAppIcon("solo", { path: "M1 1", color: "#AABBCC" });
ok(/:root\[data-theme="dark"\]\{--gi-c-app-solo:#AABBCC\}/.test(styles.get("v2-app-icon-app-solo").textContent), "W3b 다크 색이 없으면 라이트 색");
glass.registerAppIcon("solo", { path: "M1 1", color: "#112233" });
ok(/:root\{--gi-c-app-solo:#112233\}/.test(styles.get("v2-app-icon-app-solo").textContent) && styles.size === 3, "W3c 다른 색으로 다시 등록하면 새 색(같은 <style>)");
const mk = glass.appGlassMarkup("app-talk");
ok(mk.includes(`d="${HASH}"`) && mk.includes("var(--gi-c-app-talk)"), "W4 appGlassMarkup(등록한 이름) 이 그 그림 · 그 색 토큰", mk);
ok(glass.appGlassMarkup("app-nope").includes("var(--gi-c-apps)") && !glass.appGlassMarkup("app-nope").includes("app-nope"), "W4b 등록 안 한 app-… 이름은 apps 로");
ok(glass.appIconName("Talk/2 x") === "app-talk-2-x", "W5 앱 id 글자 정리", glass.appIconName("Talk/2 x"));
ok(glass.builtinAppIcon("talk", true) === "liv" && glass.builtinAppIcon("talk", false) === "term" && glass.builtinAppIcon("browser", false) === "web" && glass.builtinAppIcon("inbox", true) === "bell", "B 기본 그림은 종전 그대로");

console.log(`app-icon-spec: ${pass} 통과 · ${fail} 실패`);
if (fail) process.exit(1);

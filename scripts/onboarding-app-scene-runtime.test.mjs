#!/usr/bin/env node
// 처음 설정 «앱으로 이어 하기» 장면(#5060 후속, 원준님 2026-10-28 «최대한 앱에서 시작하게») — 런타임.
//
//  사양·엣지 표: <스크래치패드>/spec-app-scene.md — 행마다 단언 하나 이상.
//   A1 브라우저·맥 → 이름 다음 = 앱 장면 · «앱 받기 (Mac)»        A2 윈도우 → «(Windows)»
//   A3 리눅스(받을 앱 없음) → 앱 장면 건너뜀                       A4 앱 안 → 건너뜀 · desktop_seen 1회
//   A5 앱 안 · 남은 자리 = 앱 장면 → 파일 올리기부터               A6 [앱 받기] → 제스처 안에서 내려받기 · 두 걸음 안내 · 누른 시각 저장
//   A7 desktop_seen_at ≥ 누른 시각 → 접힌다 · [여기서 계속] → 파일 올리기
//   A8 desktop_seen_at 이 누르기 전(옛 값) → 접지 않는다           A9 [웹에서 계속] → 파일 올리기 · 떠난 뒤 묻기 0
//   A9′ 기다리는 중 [← 이전]으로 떠나도 묻기 0(감시를 직접 멈추지 않는 길 — 장면 검사가 지킨다)
//   A10 앱 안 대기열은 beforeunload 를 걸지 않는다
//  단언은 부작용으로 — 보낸 요청(경로·몸)·내려받기 앵커 클릭(누른 그 순간인가)·그려진 장면(그 장면에만 있는 요소)·beforeunload 건 횟수.
//  fail-first(2026-10-28 · 신규 장면이라 mutation 8발 — 각각 그 행만 빨갛다): 앱 안에서도 앱 장면 → A4·A5 · 리눅스에도 → A3 ·
//   이어 열 때 landOn 빼기 → A5 · 접힘에서 시각 비교 빼기 → A8 · 떠나도 묻기 → A9′ · desktop_seen 안 보냄 → A4 ·
//   앱 안 beforeunload → A10 · 받기 주소를 미리 안 물음 → A6. 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";
const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 처음 설정 앱 장면 런타임 검증 미실행"); process.exit(0); }
const CSS = ["01-base.css", "41-onboarding.css"].map((f) => path.join(ROOT, "public/styles", f)).filter(existsSync);
const bundle = buildSync({
  stdin: { contents: "export { renderOnboarding } from './web/v2/onboarding.ts'; export { bgUploadAdd } from './web/v2/bg-upload.ts';", resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "OB", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

async function PAGE_MAIN() {
  const R = { errors: [] };
  window.addEventListener("error", (e) => R.errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => R.errors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
  //  서버 흉내 — 받은 요청을 적는다. SEEN = GET /api/ui/me/welcome 이 줄 desktop_seen_at · PROGRESS = 남은 자리.
  let SEEN = null, PROGRESS = null;
  const reqs = [];
  window.fetch = async (url, init) => {
    const u = new URL(String(url), location.href);
    const method = String((init && init.method) || "GET").toUpperCase();
    let body = null; try { body = init && init.body ? JSON.parse(String(init.body)) : null; } catch (_) { /* 빈 몸 */ }
    reqs.push({ method, path: u.host === location.host ? u.pathname : u.host + u.pathname, body });
    if (u.host === "api.github.com") return J({ assets: [{ name: "Lively-0.1.400-universal.dmg", browser_download_url: "https://dl.example/Lively.dmg" }] });
    if (u.pathname === "/api/ui/me/welcome" && method === "GET") return J({ progress: PROGRESS, desktop_seen_at: SEEN });
    if (u.pathname === "/api/ui/me/ai-accounts") return J({ accounts: [] });
    return J({ ok: true });
  };
  window.confirm = () => true; window.alert = () => {}; window.open = () => null;
  localStorage.setItem("lively_ui_token", "t");
  //  내려받기 — 앵커 클릭을 가로채 적는다(실제로 떠나지 않게). 누른 그 순간(제스처 안)이었나를 inClick 으로 잰다.
  let inClick = false; const downloads = [];
  const oClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { downloads.push({ href: this.href, sync: inClick }); };
  const press = (el) => { inClick = true; try { el.click(); } finally { inClick = false; } };
  //  beforeunload 를 건 횟수.
  let unloadGuards = 0;
  const oAdd = window.addEventListener.bind(window);
  window.addEventListener = (t, f, o) => { if (t === "beforeunload") unloadGuards++; return oAdd(t, f, o); };
  const setOs = (ua, platform) => {
    Object.defineProperty(navigator, "userAgent", { get: () => ua, configurable: true });
    Object.defineProperty(navigator, "platform", { get: () => platform, configurable: true });
  };
  const MAC = ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/150", "MacIntel"];
  const WIN = ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150", "Win32"];
  const LNX = ["Mozilla/5.0 (X11; Linux x86_64) Chrome/150", "Linux x86_64"];
  const OB = (new Function(document.getElementById("src").textContent + "\n;return OB;"))();
  let cur = null;
  const mount = ({ os, desktop = false, saved = null, scene = null }) => {
    if (cur) { try { cur.destroy(); } catch (_) { /* 앞 판 */ } }
    setOs(...os);
    if (desktop) window.livelyDesktop = { platform: "darwin", appVersion: "0.1.400" }; else delete window.livelyDesktop;
    sessionStorage.removeItem("lively-ob-v2");
    if (saved) sessionStorage.setItem("lively-ob-v2", JSON.stringify(saved));
    history.replaceState(null, "", scene ? "?scene=" + scene : location.pathname);
    const old = document.getElementById("root"); const host = document.createElement("div"); host.id = "root"; old.replaceWith(host);
    cur = OB.renderOnboarding(host, {});
    return host;
  };
  const walkToAfterName = async (host) => {
    await sleep(400);
    host.querySelector("#introGo")?.click(); await sleep(200);
    const n = host.querySelector("#nameIn"); if (n) n.value = "민";
    host.querySelector("#nameGo")?.click(); await sleep(300);
  };
  const sceneOf = (host) => host.dataset.scene || "";

  //  A1 — 브라우저·맥
  let host = mount({ os: MAC });
  await walkToAfterName(host);
  R.a1 = { scene: sceneOf(host), btn: host.querySelector("#appGet")?.textContent || "" };
  //  A6 — [앱 받기]
  await sleep(100);   // 받기 주소(깃허브 API)를 미리 물어 둘 틈 — 사람이 장면을 보고 누르기까지의 시간
  reqs.length = 0;
  press(host.querySelector("#appGet"));
  await sleep(1500);   // 진행 저장은 묶어서 보낸다(onboarding PUSH_MS 800) — 그보다 길게
  const prog = reqs.filter((r) => r.path === "/api/ui/me/welcome/progress").pop();
  R.a6 = { downloads: downloads.slice(), steps: host.querySelectorAll("#appBody .ob-ins").length, appAt: prog && prog.body && prog.body.state && prog.body.state.appAt || null };
  //  A8 — 옛 값(누르기 전) → 접지 않는다
  SEEN = new Date(Date.parse(R.a6.appAt || new Date().toISOString()) - 60_000).toISOString();
  await sleep(4000);
  R.a8 = { folded: !!host.querySelector("#appHere"), waiting: !!host.querySelector("#appWeb2") };
  //  A7 — 앱에서 열렸다 → 접힌다 · [여기서 계속]
  SEEN = new Date(Date.parse(R.a6.appAt || new Date().toISOString()) + 1000).toISOString();
  await sleep(7000);
  R.a7 = { folded: !!host.querySelector("#appHere") };
  host.querySelector("#appHere")?.click(); await sleep(300);
  R.a7.after = sceneOf(host);
  SEEN = null;

  //  A9 — [웹에서 계속] → 파일 올리기 · 떠난 뒤 묻기 0
  host = mount({ os: MAC, saved: { scene: "desktop", name: "민", nameSet: true, trail: ["intro", "name"], appAt: new Date().toISOString() } });
  await sleep(500);
  host.querySelector("#appWeb2")?.click(); await sleep(200);
  const before = reqs.filter((r) => r.method === "GET" && r.path === "/api/ui/me/welcome").length;
  await sleep(10000);
  R.a9 = { scene: sceneOf(host), asksAfter: reqs.filter((r) => r.method === "GET" && r.path === "/api/ui/me/welcome").length - before };

  //  A9′ — 기다리는 중 [← 이전]
  host = mount({ os: MAC, saved: { scene: "desktop", name: "민", nameSet: true, trail: ["intro", "name"], appAt: new Date().toISOString() } });
  await sleep(500);
  document.getElementById("obBack")?.click(); await sleep(200);
  const before2 = reqs.filter((r) => r.method === "GET" && r.path === "/api/ui/me/welcome").length;
  await sleep(10000);
  R.a9b = { scene: sceneOf(host), asksAfter: reqs.filter((r) => r.method === "GET" && r.path === "/api/ui/me/welcome").length - before2 };

  //  A2 — 윈도우
  host = mount({ os: WIN, scene: "desktop" });
  await sleep(300);
  R.a2 = { btn: host.querySelector("#appGet")?.textContent || "" };

  //  A3 — 리눅스
  host = mount({ os: LNX });
  await walkToAfterName(host);
  R.a3 = { scene: sceneOf(host) };

  //  A4 — 앱 안(처음부터)
  reqs.length = 0;
  host = mount({ os: MAC, desktop: true });
  await walkToAfterName(host);
  R.a4 = { scene: sceneOf(host), seen: reqs.filter((r) => r.path === "/api/ui/me/liv-profile" && r.body && r.body.desktop_seen === true).length };

  //  A5 — 앱 안 · 서버에 남은 자리 = 앱 장면
  PROGRESS = { at: new Date().toISOString(), scene: "desktop", state: { scene: "desktop", name: "민", nameSet: true, trail: ["intro", "name"] } };
  host = mount({ os: MAC, desktop: true });
  await sleep(3500);
  R.a5 = { scene: sceneOf(host) };
  PROGRESS = null;

  //  A10 — 앱 안 대기열
  const g0 = unloadGuards;
  OB.bgUploadAdd([{ file: new File(["x"], "a.md"), rel: "a.md" }]);
  await sleep(200);
  R.a10 = { guards: unloadGuards - g0 };

  HTMLAnchorElement.prototype.click = oClick;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const page = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out" style="position:fixed;left:-9999px">PENDING</pre><div id="root"></div>
<script type="text/plain" id="src">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;

const dom = await dumpDom(chrome, { html: page, serve: true, prefix: "ob-app-", virtualTimeBudget: 120000, timeoutMs: 90000, args: ["--window-size=1200,900"], copy: CSS });
const res = readOut(dom);
assert.ok(res.text !== null, `결과를 못 받았다 — ${res.out}`);
const R = JSON.parse(res.text);
assert.ok(!R.fatal, R.fatal);

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${String(e.message).split("\n")[0]}`); }
};
t("A1 브라우저·맥 — 이름 다음은 앱 장면", () => {
  assert.equal(R.a1.scene, "desktop", `이름 다음 장면: ${R.a1.scene}`);
  assert.match(R.a1.btn, /앱 받기 \(Mac\)/, R.a1.btn);
});
t("A2 윈도우 — «앱 받기 (Windows)»", () => { assert.match(R.a2.btn, /앱 받기 \(Windows\)/, R.a2.btn); });
t("A3 리눅스 — 받을 앱이 없으면 앱 장면을 건너뛴다", () => { assert.equal(R.a3.scene, "upload"); });
t("A4 앱 안 — 앱 장면을 건너뛰고 desktop_seen 을 한 번 남긴다", () => {
  assert.equal(R.a4.scene, "upload", `★ 앱 안에서 «앱 받기» 를 보인다: ${R.a4.scene}`);
  assert.equal(R.a4.seen, 1, `desktop_seen 요청 수: ${R.a4.seen}`);
});
t("A5 앱 안 · 남은 자리 = 앱 장면 → 파일 올리기부터", () => { assert.equal(R.a5.scene, "upload", `★ 앱에서 이어 연 자리: ${R.a5.scene}`); });
t("A6 [앱 받기] — 누른 그 자리에서 내려받기 · 두 걸음 안내 · 누른 시각 저장", () => {
  assert.equal(R.a6.downloads.length, 1, `내려받기 수: ${JSON.stringify(R.a6.downloads)}`);
  assert.equal(R.a6.downloads[0].href, "https://dl.example/Lively.dmg", "★ 설치 파일이 아니라 다른 곳을 연다(받기 주소를 미리 못 물었다)");
  assert.equal(R.a6.downloads[0].sync, true, "★ 누른 순간(제스처) 밖에서 받는다 — 브라우저가 막는다");
  assert.equal(R.a6.steps, 2, "받기·로그인 두 걸음 안내가 없다");
  assert.ok(R.a6.appAt, "누른 시각을 진행에 안 남긴다 — 새로고침하면 대기 안내를 잃고, 접힘 판정의 기준도 없다");
});
t("A7 앱에서 열리면 접힌다 · [여기서 계속] → 파일 올리기", () => {
  assert.equal(R.a7.folded, true, "★ 앱에서 이어 하는데 브라우저 탭이 계속 기다린다(같은 처음 설정을 두 곳에서)");
  assert.equal(R.a7.after, "upload");
});
t("A8 누르기 전의 옛 앱 표식으로는 접지 않는다", () => {
  assert.equal(R.a8.folded, false, "★ 예전에 앱을 연 적만 있어도 접힌다");
  assert.equal(R.a8.waiting, true);
});
t("A9 [웹에서 계속] → 파일 올리기 · 떠난 뒤 묻기 0", () => {
  assert.equal(R.a9.scene, "upload");
  assert.equal(R.a9.asksAfter, 0, `★ 장면을 떠났는데 계속 묻는다: ${R.a9.asksAfter}`);
});
t("A9′ 기다리는 중 [← 이전]으로 떠나도 묻기 0", () => {
  assert.equal(R.a9b.scene, "name", `배선 — 이전 장면으로 안 갔다: ${R.a9b.scene}`);
  assert.equal(R.a9b.asksAfter, 0, `★ 장면을 떠났는데 계속 묻는다: ${R.a9b.asksAfter}`);
});
t("A10 앱 안 대기열은 탭 닫기 경고를 걸지 않는다", () => {
  assert.equal(R.a10.guards, 0, "★ Electron 에서 닫기·종료가 조용히 막힌다");
});
t("화면 오류 0", () => { assert.deepEqual(R.errors, []); });
console.log(`onboarding-app-scene-runtime.test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

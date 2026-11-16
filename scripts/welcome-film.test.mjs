#!/usr/bin/env node
// 소개 영상(#5550, 원준님 2026-11-16 «리니어는 온보딩하면 맨 처음에 온보딩 영상 띄워 주잖아») — 인사 장면 · 재생기 · 자산.
//
//  엣지 표 — 행마다 단언 하나 이상.
//   F1 인사 장면 = 영상이 선다(소리 없음 · 인라인 · 자산 주소는 문서 기준 상대경로) · [계속하기]는 처음부터 눌린다
//   F2 [계속하기] → 이름 장면 · 떠난 영상은 멈추고 주소를 놓는다(떼어 낸 영상은 스스로 멈추지 않는다)
//   F3 영상을 못 읽으면 그 자리에 종전 그림이 선다 · 넓힌 칸도 되돌린다 · [계속하기]는 그대로 눌린다
//   F4 «움직임 줄이기» 면 스스로 틀지 않는다
//   F5 다시 보기 창 — 한 번에 하나 · Esc 로 닫히고 영상을 놓는다
//   S1 자산이 있고(mp4 · 포스터), 영상은 머리(moov)가 앞에 있어 받는 대로 튼다 · 크기 상한
//   S2 사용 가이드 첫 화면에 다시 보는 문이 있다 · 프리뷰가 mp4 를 영상 타입으로 준다
//  크롬이 없는 면에서는 런타임 행(F1~F5)을 조용히 건너뛴다(종료코드 0) — 정적 행(S1·S2)은 늘 돈다.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";
const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const read = (f) => readFileSync(path.join(ROOT, f), "utf8");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}\n     ${String(e.message).split("\n")[0]}`); }
};

// ── 정적 ──
t("S1 자산 — mp4 · 포스터가 있고, 영상은 moov 가 mdat 앞(받는 대로 재생) · 12MB 아래", () => {
  const mp4 = path.join(ROOT, "public/media/welcome-film.mp4"), poster = path.join(ROOT, "public/media/welcome-film-poster.jpg");
  assert.ok(existsSync(mp4), "public/media/welcome-film.mp4 가 없다 — node scripts/welcome-film/render.mjs");
  assert.ok(existsSync(poster), "포스터가 없다");
  const size = statSync(mp4).size;
  assert.ok(size > 200_000, `영상이 너무 작다(${size}바이트) — 굽다 만 파일`);
  assert.ok(size < 12 * 1048576, `영상이 12MB 를 넘는다(${(size / 1048576).toFixed(1)}MB) — 이미지 · 저장소가 그만큼 무거워진다`);
  const buf = readFileSync(mp4);
  assert.equal(buf.subarray(4, 8).toString("latin1"), "ftyp", "mp4 가 아니다");
  const moov = buf.indexOf(Buffer.from("moov")), mdat = buf.indexOf(Buffer.from("mdat"));
  assert.ok(moov > 0 && mdat > 0 && moov < mdat, "★ moov 가 뒤에 있다(+faststart 없이 구웠다) — 다 받을 때까지 안 튼다");
  assert.equal(readFileSync(poster).subarray(0, 2).toString("hex"), "ffd8", "포스터가 JPEG 가 아니다");
});
t("S2 다시 보는 문 · 프리뷰의 영상 타입 · 원본 도구", () => {
  const guide = read("web/guide/app.ts");
  assert.match(guide, /class: 'gd-film'[^\n]*onclick: \(\) => openWelcomeFilm\(\)/, "사용 가이드 첫 화면에 «소개 영상 보기» 가 없다");
  assert.match(read("src/preview/routes.ts"), /"\.mp4": "video\/mp4"/, "프리뷰가 mp4 를 영상 타입으로 주지 않는다 — 미리 보기에서 영상이 안 뜬다");
  const wf = read("web/v2/welcome-film.ts");
  assert.match(wf, /src: 'media\/welcome-film\.mp4'/, "영상 주소가 문서 기준 상대경로가 아니다 — 프리뷰(/preview/<id>/ui/)에서 깨진다");
  assert.ok(!/from '\.\/(apps|rail|shell-prefs|side)\.js'/.test(wf), "재생기가 셸을 문다 — 사용 가이드(클래식 번들)가 셸 전부를 끌고 온다");
  for (const f of ["film.html", "film.css", "film.js", "engine.js", "render.mjs", "gen-assets.mjs"]) assert.ok(existsSync(path.join(ROOT, "scripts/welcome-film", f)), `원본 도구가 없다: ${f}`);
});

// ── 런타임 ──
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 런타임 행(F1~F5)을 건너뜁니다(CHROME_BIN 으로 지정)"); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
const CSS = ["01-base.css", "41-onboarding.css"].map((f) => path.join(ROOT, "public/styles", f)).filter(existsSync);
const bundle = buildSync({
  stdin: { contents: "export { renderOnboarding } from './web/v2/onboarding.ts'; export { mountWelcomeFilm, openWelcomeFilm } from './web/v2/welcome-film.ts';", resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "OB", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;

async function PAGE_MAIN() {
  const R = { errors: [] };
  window.addEventListener("error", (e) => { if (e.message) R.errors.push(String(e.message)); });
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const J = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  window.fetch = async (url) => (new URL(String(url), location.href).pathname === "/api/ui/me/welcome" ? J({ progress: null }) : J({ ok: true }));
  localStorage.setItem("lively_ui_token", "t");
  //  영상은 실제로 틀지 않는다 — play/pause 를 부른 횟수와 떠날 때 주소를 놓았는지만 잰다(파일이 없는 면이라 그대로 두면 곧 error 가 난다).
  let plays = 0, pauses = 0;
  HTMLMediaElement.prototype.play = function () { plays++; return Promise.resolve(); };
  HTMLMediaElement.prototype.pause = function () { pauses++; };
  HTMLMediaElement.prototype.load = function () { /* 받으러 가지 않는다 */ };
  let reduce = false;
  const oMM = window.matchMedia.bind(window);
  window.matchMedia = (q) => (/prefers-reduced-motion/.test(q) ? { matches: reduce, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : oMM(q));
  const OB = (new Function(document.getElementById("src").textContent + "\n;return OB;"))();
  let cur = null;
  const mount = () => {
    if (cur) { try { cur.destroy(); } catch (_) { /* 앞 판 */ } }
    sessionStorage.removeItem("lively-ob-v2");
    history.replaceState(null, "", "?scene=intro");
    const old = document.getElementById("root"); const host = document.createElement("div"); host.id = "root"; old.replaceWith(host);
    cur = OB.renderOnboarding(host, {});
    return host;
  };

  // F1
  plays = 0;
  let host = mount();
  let v = host.querySelector("video.wf-v");
  R.f1 = {
    scene: host.dataset.scene, film: !!host.querySelector("#qcol .ob-in-film .wf"), wide: host.querySelector("#qcol").classList.contains("ob-has-film"),
    src: v && v.getAttribute("src"), poster: v && v.getAttribute("poster"), muted: !!(v && v.muted), inline: !!(v && v.playsInline),
    controls: !!(v && v.controls), plays, go: !!host.querySelector("#introGo") && !host.querySelector("#introGo").disabled, art: !!host.querySelector(".ob-in-art"),
  };
  // F2
  pauses = 0;
  host.querySelector("#introGo").click(); await sleep(50);
  R.f2 = { scene: host.dataset.scene, pauses, srcLeft: v.getAttribute("src"), film: !!host.querySelector(".wf"), wide: host.querySelector("#qcol").classList.contains("ob-has-film") };
  // F3
  host = mount();
  v = host.querySelector("video.wf-v");
  v.dispatchEvent(new Event("error")); await sleep(20);
  R.f3 = { film: !!host.querySelector(".wf"), art: !!host.querySelector(".ob-in-art"), wide: host.querySelector("#qcol").classList.contains("ob-has-film"), slot: !!host.querySelector("#introFilm") };
  host.querySelector("#introGo").click(); await sleep(50);
  R.f3.after = host.dataset.scene;
  // F4
  reduce = true; plays = 0;
  host = mount();
  R.f4 = { plays, big: !!host.querySelector(".wf:not(.is-playing) .wf-big") };
  reduce = false;
  // F5
  if (cur) { cur.destroy(); cur = null; }
  OB.openWelcomeFilm(); OB.openWelcomeFilm();
  const m = document.querySelectorAll(".wf-modal");
  const mv = document.querySelector(".wf-modal video");
  R.f5 = { count: m.length, dialog: m[0] && m[0].getAttribute("role"), video: !!mv };
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(20);
  R.f5.afterEsc = document.querySelectorAll(".wf-modal").length; R.f5.srcLeft = mv && mv.getAttribute("src");

  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const page = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out" style="position:fixed;left:-9999px">PENDING</pre><div id="root"></div>
<script type="text/plain" id="src">${bundle.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;
const dom = await dumpDom(chrome, { html: page, serve: true, prefix: "ob-film-", virtualTimeBudget: 60000, timeoutMs: 90000, args: ["--window-size=1200,900"], copy: CSS });
const res = readOut(dom);
assert.ok(res.text !== null, `결과를 못 받았다 — ${res.out}`);
const R = JSON.parse(res.text);
assert.ok(!R.fatal, R.fatal);

t("F1 인사 장면에 영상이 선다 — 소리 없음 · 인라인 · 상대경로 · [계속하기]는 처음부터", () => {
  assert.equal(R.f1.scene, "intro");
  assert.equal(R.f1.film, true, "★ 인사 장면에 영상이 없다");
  assert.equal(R.f1.art, false, "영상과 종전 그림이 함께 선다");
  assert.equal(R.f1.wide, true, "칸을 넓히지 않았다 — 영상이 560px 칸에 갇힌다");
  assert.equal(R.f1.src, "media/welcome-film.mp4"); assert.equal(R.f1.poster, "media/welcome-film-poster.jpg");
  assert.equal(R.f1.muted, true, "★ 소리가 켜져 있다 — 브라우저가 자동 재생을 막는다"); assert.equal(R.f1.inline, true, "아이폰에서 전체 화면으로 튄다");
  assert.equal(R.f1.controls, false, "브라우저 기본 조작줄이 함께 선다");
  assert.equal(R.f1.plays, 1, `스스로 튼 횟수: ${R.f1.plays}`);
  assert.equal(R.f1.go, true, "★ [계속하기]가 없거나 막혀 있다 — 영상을 다 봐야 넘어간다");
});
t("F2 [계속하기] → 이름 · 떠난 영상은 멈추고 주소를 놓는다", () => {
  assert.equal(R.f2.scene, "name");
  assert.ok(R.f2.pauses >= 1, "★ 떠난 영상을 멈추지 않는다 — 안 보이는 데서 계속 돈다");
  assert.equal(R.f2.srcLeft, null, "떠난 영상이 주소를 쥐고 있다(받기가 계속된다)");
  assert.equal(R.f2.film, false); assert.equal(R.f2.wide, false, "이름 장면까지 칸이 넓다");
});
t("F3 영상을 못 읽으면 종전 그림 — 처음 설정은 그대로 간다", () => {
  assert.equal(R.f3.film, false, "★ 깨진 영상 칸이 그대로 선다");
  assert.equal(R.f3.art, true, "★ 종전 그림으로 되돌아가지 않는다(빈 자리)");
  assert.equal(R.f3.wide, false); assert.equal(R.f3.slot, false);
  assert.equal(R.f3.after, "name", "영상이 깨지면 [계속하기]가 죽는다");
});
t("F4 «움직임 줄이기» — 스스로 틀지 않고 재생 단추가 선다", () => { assert.equal(R.f4.plays, 0, `★ 스스로 튼 횟수: ${R.f4.plays}`); assert.equal(R.f4.big, true); });
t("F5 다시 보기 창 — 하나만 · Esc 로 닫히고 영상을 놓는다", () => {
  assert.equal(R.f5.count, 1, `창 수: ${R.f5.count}`); assert.equal(R.f5.dialog, "dialog"); assert.equal(R.f5.video, true);
  assert.equal(R.f5.afterEsc, 0, "Esc 로 안 닫힌다"); assert.equal(R.f5.srcLeft, null, "닫은 뒤에도 영상이 주소를 쥐고 있다");
});
t("런타임 오류 없음", () => { assert.deepEqual(R.errors, []); });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

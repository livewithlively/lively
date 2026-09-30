// #4523 — 곁칸 [뷰어]의 시안(HTML) 미리보기가 새로 서도(새로고침 · 세션 갈아탔다 돌아옴 · 살아 있는 미리보기) 보던 자리에서 시작한다.
//
//  왜 진짜 크롬·진짜 휠인가: 격리 프레임(불투명 오리진)의 스크롤은 부모가 못 읽고 못 쓴다 — 자리는 문서 쪽 스크립트
//   (frame-bridge withScrollKeeper)가 스크롤 **이벤트**로 적고 다리로 되돌린다. 창 흉내로는 아무것도 잴 수 없고,
//   스크립트의 scrollTo 로 굴리면 «사람의 손»(wheel)과 «되돌리는 중»을 가를 수 없다. 그래서 CDP 로 휠을 굴린다.
//   ⚠ 구식 헤드리스(--dump-dom)는 가상 시간으로 돌아 postMessage 왕복 도중에 DOM 을 떠 버린다(실측) — headless=new + CDP.
//   ⚠ 프레임 로드·다리 왕복은 **조건으로 기다린다**(고정 대기는 CI 리눅스에서 앞 장면을 집는다 — side-files-finder 의 교훈).
//
//  빌드 산출물(public/app/lib/frame-bridge.js)을 그대로 싣는다 — 시험하는 코드가 곧 서빙되는 코드다.
//  fail-first(2026-10-01): 스크립트를 빼고 srcdoc 만 두면(변경 전 뷰어) 재생성·새로고침·옆 띠 행이 전부 0 으로 빨갛다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome } from "./headless-chrome.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = findChrome();
const BRIDGE = path.join(root, "public/app/lib/frame-bridge.js");
if (!chrome || typeof WebSocket === "undefined") {
  console.log("skip  크롬(또는 WebSocket 전역)이 없어 건너뜁니다(CHROME_BIN 으로 지정) — 보던 자리 런타임 검증 미실행");
  process.exit(0);
}
assert.ok(existsSync(BRIDGE), "public/app/lib/frame-bridge.js 가 없다 — 빌드(node scripts/build-web.mjs) 먼저");
//  SCROLL_KEEP=off — 스크립트를 붙이지 않는다(변경 전 뷰어와 같다). fail-first 재현용.
const KEEP = process.env.SCROLL_KEEP !== "off";

// ── 시험 문서 셋 ──────────────────────────────────────────────────────────────────────────────
const DOCS = {
  // 창이 구르는 보통 문서
  win: `<!doctype html><html><body><div style="height:6000px">tall</div></body></html>`,
  // 칸이 구르는 문서(덱·앱 꼴 보고서) + 아래 옆으로 넘기는 작은 띠(캐러셀)
  box: `<!doctype html><html><body style="margin:0;overflow:hidden"><header style="height:30px">hdr</header>`
    + `<main id="m" style="height:330px;overflow:auto"><div style="height:6000px">deck</div></main>`
    + `<div id="car" style="height:40px;overflow-x:auto;white-space:nowrap"><span style="display:inline-block;width:3000px">carousel</span></div></body></html>`,
  // 스크립트가 늦게 그리는 문서 — 처음엔 짧아서 곧바로는 못 간다
  late: `<!doctype html><html><body><div id="c">loading</div><script>setTimeout(function(){document.getElementById('c').style.height='6000px'},700)<\/script></body></html>`,
};
// 자리 재기 — 문서 쪽 탐침(시험 전용). 칸 문서는 #m 의 자리를 잰다.
const PROBE = `<script>addEventListener('message',function(e){if(e.data&&e.data.probe){var m=document.getElementById('m');`
  + `parent.postMessage({probe:1,y:m?m.scrollTop:scrollY,h:m?m.scrollHeight:document.documentElement.scrollHeight},'*')}})<\/script>`;
// 시험 페이지 — 뷰어가 하는 일 그대로: htmlFrame 과 같은 sandbox · withScrollKeeper · attachFrameBridge(파일 이름 공간)
//  ⚠ 페이지 스크립트에 문서 글을 심을 땐 `</` 를 끊는다 — 안 그러면 문서 속 </script> 가 이 페이지의 스크립트를 닫는다.
const js = (v) => JSON.stringify(v).replace(/<\//g, "<\\/");
const PAGE = `<!doctype html><html><body style="margin:0"><div id="wrap" style="width:600px;height:400px"></div>
<script type="module">
import { attachFrameBridge, withScrollKeeper } from '/frame-bridge.js';
const DOCS = ${js(DOCS)};
const PROBE = ${js(PROBE)};
const KEEP = ${JSON.stringify(KEEP)};
const kind = new URLSearchParams(location.search).get('kind');
let frame = null, off = () => {};
window.mk = () => {
  off(); if (frame) frame.remove();
  frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals');
  frame.style.cssText = 'width:600px;height:400px;border:0';
  frame.srcdoc = KEEP ? withScrollKeeper(DOCS[kind] + PROBE) : DOCS[kind] + PROBE;
  off = attachFrameBridge(frame, '4523:' + kind + '.html');
  document.getElementById('wrap').append(frame);
};
window.probe = () => new Promise((res) => {
  const h = (e) => { if (frame && e.source === frame.contentWindow && e.data && e.data.probe) { removeEventListener('message', h); res(e.data); } };
  addEventListener('message', h);
  try { frame.contentWindow.postMessage({ probe: 1 }, '*'); } catch (_) { res(null); }
  setTimeout(() => { removeEventListener('message', h); res(null); }, 1000);
});
mk();
window.ready = true;
</script></body></html>`;

const srv = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x");
  if (u.pathname === "/p.html") { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return r.end(PAGE); }
  if (u.pathname === "/frame-bridge.js") { r.writeHead(200, { "content-type": "text/javascript" }); return r.end(readFileSync(BRIDGE)); }
  r.writeHead(404); r.end();
});
await new Promise((res) => srv.listen(0, "127.0.0.1", res));
const origin = "http://127.0.0.1:" + srv.address().port;

const dir = mkdtempSync(path.join(tmpdir(), "scroll-keep-"));
const child = spawn(chrome, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  // ⚠ 맥에서 새 프로필 크롬이 «키체인» 모달을 사람 화면에 띄우지 않게(headless-chrome.mjs 와 같은 이유)
  "--use-mock-keychain", "--password-store=basic", "--disable-background-networking", "--disable-component-update",
  "--disable-sync", "--disable-default-apps", "--disable-extensions", "--mute-audio", "--disable-breakpad",
  `--user-data-dir=${path.join(dir, "profile")}`, "--remote-debugging-port=0", "--window-size=1000,800", "about:blank",
], { env: { ...process.env, HOME: dir }, stdio: ["ignore", "ignore", "ignore"] });

let pass = 0;
const ok = (cond, name, info) => { assert.ok(cond, name + "  " + JSON.stringify(info)); pass++; console.log(`ok  ${name}  ${JSON.stringify(info)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws = null;
try {
  const pf = path.join(dir, "profile", "DevToolsActivePort");
  for (let i = 0; i < 200 && !existsSync(pf); i++) await sleep(50);
  assert.ok(existsSync(pf), "크롬 디버깅 포트가 안 열렸다");
  const port = readFileSync(pf, "utf8").split("\n")[0];
  let targets = [];
  for (let i = 0; i < 40 && !targets.some((t) => t.type === "page"); i++) {
    targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => []);
    if (!targets.some((t) => t.type === "page")) await sleep(100);
  }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const cdp = (method, params = {}) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression) => (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  /** 조건이 설 때까지(상한 ms) — 선 값 또는 마지막 값을 돌려준다. */
  const until = async (fn, pred, ms = 5000) => { const t0 = Date.now(); let v; do { v = await fn(); if (pred(v)) return v; await sleep(80); } while (Date.now() - t0 < ms); return v; };
  const y = async () => (await ev("probe()"))?.y;
  const ready = async () => assert.equal(await until(() => ev("window.ready === true"), (v) => v === true), true, "시험 페이지가 안 섰다");
  const tall = () => until(() => ev("probe()"), (v) => v && v.h > 3000);   // 문서가 다 섰다(늦게 그리는 문서 포함)
  const wheel = async ({ dy = 0, dx = 0, x = 300, yy = 200 }) => {
    for (let i = 0; i < Math.ceil(Math.abs(dy || dx) / 100); i++) {
      await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x, y: yy, deltaX: Math.sign(dx) * 100, deltaY: Math.sign(dy) * 100 });
      await sleep(15);
    }
  };
  //  휠 이벤트가 전부 스크롤로 이어진다고 믿지 않는다(실측: 1500 을 굴렸는데 1300 에 선 판이 있었다) — 목표를 넘을 때까지
  //   더 굴리고, 두 번 연달아 같은 값이 나올 때(멈춤) 그 자리를 돌려준다.
  const stable = async () => { let a = await y(); for (let i = 0; i < 40; i++) { await sleep(120); const b = await y(); if (b === a) return b; a = b; } return a; };
  const rollTo = async (min, opt = {}) => {
    for (let i = 0; i < 30 && !((await y()) >= min); i++) await wheel({ dy: 300, ...opt });
    return stable();
  };
  /** 적힌 자리(저장소 표) — 휠을 멈추고 250ms 뒤에 적힌다. 스크립트가 없으면(off) 아무것도 안 적힌다 → 짧게만 기다린다. */
  const stored = (kind) => ev(`(JSON.parse(localStorage.getItem('lv.fpPos.v1')||'{}')['4523:${kind}.html']||{}).y`);
  const settle = (kind, v) => until(() => stored(kind), (s) => s === v, KEEP ? 5000 : 600);
  await cdp("Page.enable");

  let n = 0;
  for (const kind of ["win", "box", "late"]) {
    await cdp("Page.navigate", { url: `${origin}/p.html?kind=${kind}` }); await ready(); await tall();
    const y0 = await rollTo(1500);
    assert.ok(y0 >= 1500, `${kind}: 휠이 문서를 굴리지 못했다(관측 장치 고장) y0=${y0}`);
    await settle(kind, y0);
    ok((await stored(kind)) === y0, `R${++n} ${kind}: 휠로 굴린 자리를 파일 이름 공간에 적는다`, { y0 });
    await ev("mk()");
    const y1 = await until(y, (v) => v === y0);
    ok(y1 === y0, `R${++n} ${kind}: 프레임이 새로 서면(세션 갈아탔다 돌아옴·다시 펴기) 보던 자리`, { y0, y1 });
    await cdp("Page.reload"); await sleep(100); await ready();
    const y2 = await until(y, (v) => v === y0);
    ok(y2 === y0, `R${++n} ${kind}: 페이지 새로고침 뒤에도 보던 자리`, { y0, y2 });
    await ev("document.getElementById('wrap').hidden = true"); await sleep(200);
    await ev("document.getElementById('wrap').hidden = false");
    const yh = await until(y, (v) => v === y2);
    ok(yh === y2, `R${++n} ${kind}: 숨겼다(곁칸 다른 탭) 보여도 보던 자리`, { y2, yh });
    for (let i = 0; i < 10 && (await y()) !== 0; i++) await wheel({ dy: -8000 });
    assert.equal(await stable(), 0, `${kind}: 맨 위로 못 올렸다(관측 장치 고장)`);
    await settle(kind, 0);
    await ev("mk()"); await tall(); await sleep(400);
    const y3 = await y();
    ok(y3 === 0, `R${++n} ${kind}: 맨 위로 올려 두면 새로 서도 맨 위(옛 자리로 끌려가지 않는다)`, { y3 });
  }
  // 옆 띠(캐러셀)를 굴려도 본문 자리를 덮지 않는다 — 창 높이 절반 미만의 칸은 적지 않는다
  await cdp("Page.navigate", { url: `${origin}/p.html?kind=box` }); await ready(); await tall();
  const b0 = await rollTo(1200);
  await settle("box", b0);
  await wheel({ dx: 600, yy: 380 }); await sleep(500);
  await ev("mk()");
  const b1 = await until(y, (v) => v === b0);
  ok(b1 === b0, `R${++n} box: 옆 띠를 굴려도 본문 자리가 남는다`, { b0, b1 });
  // 사람의 손이 이긴다 — 늦게 그리는 문서를 되돌리는 도중 사람이 굴리면 되돌리기를 멈춘다(끌어당기지 않는다)
  if (KEEP) {
    await cdp("Page.navigate", { url: `${origin}/p.html?kind=late` }); await ready(); await tall();
    const far = await rollTo(3000);
    await settle("late", far);
    await ev("mk()"); await sleep(150);               // 아직 짧다(700ms 뒤에 선다) — 되돌리는 중
    await wheel({ dy: 200 });                         // 사람이 먼저 굴린다
    await tall(); await sleep(900);
    const mine = await y();
    ok(mine !== far, `R${++n} late: 되돌리는 도중 사람이 굴리면 되돌리기를 멈춘다`, { far, mine });
  }
} finally {
  try { ws?.close(); } catch (_) { /* noop */ }
  child.kill("SIGKILL");
  srv.close();
  await new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once("close", r)));
  for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break; } catch (_) { await sleep(200); } }
}
console.log(`\n${pass} passed`);

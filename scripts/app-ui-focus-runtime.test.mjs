#!/usr/bin/env node
// 크게 보기(앱 UI 덮개)를 열면 초점이 덮개로 온다 — 진짜 크롬 · 진짜 키 런타임 회귀 테스트 (#4480, 2026-10-16 운영 실측)
//
// 신고 · 실측: 세션 화면에서 크게 보기를 열고 Esc 를 치면 닫히지 않았다. 세션 화면의 초점은 터미널 액자(iframe.sc-term-frame —
//  xterm 의 숨은 textarea)에 있는데, 덮개(body 의 층)를 열어도 초점은 그대로 뒤에 숨은 액자에 남았다. 키는 초점이 있는 문서로 가므로
//  Esc 는 셸(document 의 keydown → uiKey)에 닿지 않고 터미널 문서로 갔다(운영: 덮개를 연 뒤 activeElement 가 IFRAME.sc-term-frame).
//  초점이 터미널에 남은 채 크게 보기가 서는 길: 터미널 안의 셸 링크(#/full/…)를 누르면 터미널 문서가 부모 주소만 바꾼다
//   (web/standalone/terminal.ts openLinkFromTerminal → window.parent.location.hash). 셸의 단추 · 링크를 마우스로 눌러 열면
//   누르는 순간 초점이 셸로 와서 생기지 않는다(격리 리뷰 실측). 그 길에서 덮개가 보이는 터미널 위에 서면 친 글자도 뒤의 터미널 입력칸으로 간다.
// 고친 것: openAppUi 가 덮개를 붙인 뒤 초점을 덮개로 옮긴다(tabIndex -1 · focus) — 테두리는 그리지 않는다(40-v2.css .v2-appui-ov:focus).
//
// 왜 진짜 크롬 · CDP 키인가: 합성 이벤트(dispatchEvent)는 보낸 자리로만 간다 — «키가 어느 문서로 가는가» 는 브라우저의 초점 경로가 정한다.
//  CDP Input.dispatchKeyEvent 는 사람의 키처럼 초점이 있는 문서로 간다. 시험하는 코드는 실제 web/v2/app-ui.ts 를 묶은 것이다.
//
// 장면(터미널 흉내 = 같은 출처 iframe 안의 textarea · 그 문서가 받은 키를 적는다):
//  T0 (관측 장치) 터미널 textarea 를 마우스로 누르면 초점이 그 액자 안 textarea 에 선다
//  F1 덮개를 열면 document.activeElement 가 덮개다 · 덮개에 테두리가 없다
//  F2 Esc 로 닫힌다 — 닫기 뒷일(onClose)이 한 번 돌고, 터미널 문서는 Esc 를 받지 않는다
//  F3 덮개가 열린 동안 친 글자가 뒤의 터미널로 가지 않는다
//  F4 터미널이 든 칸을 숨긴 뒤 열어도(셸이 크게 보기 탭을 켜며 세션 탭을 숨기는 꼴 — 운영에서 본 모양) Esc 로 닫힌다
//  F5 다시 열면 또 덮개에 초점 · 닫기 단추를 마우스로 눌러도 닫힌다(onClose 두 번째)
//  ⚠ 키는 덮개를 열고 **처음 치는 키**로 잰다 — 덮개 안에 앱 액자(sandbox iframe)가 붙으면 크롬은 그 뒤 첫 키만 종전 초점(터미널)으로 보내고
//   곧이어 키보드 초점을 셸 문서로 옮긴다(격리 리뷰 실측 · 까닭은 확인하지 않았다). 다른 키 뒤에 친 Esc 는 고치기 전에도 셸로 가서 거짓 초록이 난다.
//   그래서 F2 · F3 은 저마다 새로 열고 첫 키를 친다.
// fail-first(2026-10-16): 고치기 전 트리(SRC_ROOT)로 돌리면 F1 의 초점 · F2 · F3 · F4 · F5 가 빨갛다 — 초점이 터미널에 남아 Esc 와 친 글자가
//  터미널 문서로 가고 덮개가 남는다. T0 와 F1 의 테두리 단언은 종전에도 초록이다(테두리 단언은 CSS 한 줄을 지킨다 — 그 줄만 빼면 빨갛다).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
//  SRC_ROOT — 다른 트리로 묶어 본다(fail-first). 그 폴더엔 web/ 와 public/styles/ 만 있으면 된다(node_modules 불필요 —
//   예: git archive <커밋> web public/styles | tar -x -C <폴더>).
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const chrome = findChrome();
if (!chrome || typeof WebSocket === "undefined") {
  console.log("skip  크롬(또는 WebSocket 전역)이 없어 건너뜁니다(CHROME_BIN 으로 지정) — 크게 보기 초점 런타임 검증 미실행");
  process.exit(0);
}

const bundle = (await build({
  stdin: { contents: "export { openAppUi, closeAppUi } from './web/v2/app-ui.ts';", resolveDir: SRC_ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "AUI", write: false, platform: "browser", target: "es2020", logLevel: "silent",
})).outputFiles[0].text;
const CSS = ["01-base.css", "03-components.css", "40-v2.css"].map((f) => readFileSync(path.join(SRC_ROOT, "public/styles", f), "utf8")).join("\n");
//  페이지 스크립트에 싣는 글은 `</` 를 끊는다 — 묶음 · 스타일 속 </script> · </style> 가 바깥 태그를 닫지 않게.
const safe = (s) => s.replace(/<\/(script|style)/gi, "<\\/$1");

const PAGE = `<!doctype html><html data-theme="light"><meta charset="utf-8"><style>${safe(CSS)}</style><body>
<div id="pane"><iframe id="term" class="sc-term-frame" src="/term.html" style="width:600px;height:220px;border:0"></iframe></div>
<script>${safe(bundle)}</script>
<script>window.__closed = 0; window.ready = true;</script></body></html>`;
//  터미널 흉내 — xterm 처럼 숨은 입력칸 하나 · 이 문서가 받은 키를 모두 적는다(잡는 단계에서)
const TERM = `<!doctype html><meta charset="utf-8"><body style="margin:0"><textarea id="t" style="width:560px;height:180px"></textarea>
<script>window.__keys = []; addEventListener('keydown', function (e) { window.__keys.push(e.key); }, true);</script></body>`;
const APP_UI = { html: "<!doctype html><html><body><h1>메모</h1><input id=\"i\"></body></html>", title: "메모", page_key: "main" };

const srv = http.createServer((q, r) => {
  const u = new URL(q.url, "http://x");
  if (u.pathname === "/p.html") { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return r.end(PAGE); }
  if (u.pathname === "/term.html") { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return r.end(TERM); }
  if (u.pathname === "/api/ui/apps/memo/ui") { r.writeHead(200, { "content-type": "application/json" }); return r.end(JSON.stringify(APP_UI)); }
  r.writeHead(404, { "content-type": "application/json" }); r.end("{}");
});
await new Promise((res) => srv.listen(0, "127.0.0.1", res));
const origin = "http://127.0.0.1:" + srv.address().port;

const dir = mkdtempSync(path.join(tmpdir(), "appui-focus-"));
const child = spawn(chrome, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  // ⚠ 맥에서 새 프로필 크롬이 «키체인» 모달을 사람 화면에 띄우지 않게(headless-chrome.mjs 와 같은 이유)
  "--use-mock-keychain", "--password-store=basic", "--disable-background-networking", "--disable-component-update",
  "--disable-sync", "--disable-default-apps", "--disable-extensions", "--mute-audio", "--disable-breakpad",
  `--user-data-dir=${path.join(dir, "profile")}`, "--remote-debugging-port=0", "--window-size=1000,800", "about:blank",
], { env: { ...process.env, HOME: dir }, stdio: ["ignore", "ignore", "ignore"] });

let pass = 0, fail = 0;
//  장면 단언은 멈추지 않고 센다 — fail-first 에서 빨간 줄이 다 보이게. 관측 장치(assert)는 곧바로 멈춘다.
const ok = (cond, name, info) => { if (cond) { pass++; console.log(`ok  ${name}  ${JSON.stringify(info)}`); } else { fail++; console.error(`FAIL  ${name}  ${JSON.stringify(info)}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws = null;
try {
  const pf = path.join(dir, "profile", "DevToolsActivePort");
  //  기동 대기는 넉넉히(30초) — 병렬 러너에서 다른 크롬 시험과 겹치면 늦게 뜬다(frame-scroll-keep 과 같은 까닭).
  for (let i = 0; i < 600 && !existsSync(pf); i++) await sleep(50);
  assert.ok(existsSync(pf), "크롬 디버깅 포트가 30초 안에 안 열렸다");
  const port = readFileSync(pf, "utf8").split("\n")[0];
  let targets = [];
  for (let i = 0; i < 150 && !targets.some((t) => t.type === "page"); i++) {
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
  const until = async (fn, pred, ms = 5000) => { const t0 = Date.now(); let v; do { v = await fn(); if (pred(v)) return v; await sleep(60); } while (Date.now() - t0 < ms); return v; };
  const click = async (x, y) => {
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const key = async (k) => {
    if (k === "Escape") {
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    } else {
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, text: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: "Key" + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
    }
    await sleep(120);
  };
  //  지금 초점 · 덮개 · 터미널 문서가 받은 키 · 입력칸 글
  const STATE = `(() => { const a = document.activeElement, ov = document.querySelector('.v2-appui-ov'), t = document.getElementById('term');
    const td = t && t.contentDocument; const ta = td && td.getElementById('t');
    return { active: a === ov && ov ? 'overlay' : a ? (a.id || a.tagName) : null, inner: td && td.activeElement ? (td.activeElement.id || td.activeElement.tagName) : null,
      overlay: !!ov, outline: ov ? getComputedStyle(ov).outlineStyle : null, termKeys: t && t.contentWindow ? t.contentWindow.__keys.slice() : null,
      termText: ta ? ta.value : null, closed: window.__closed }; })()`;
  const st = () => ev(STATE);
  const load = async () => {
    await cdp("Page.navigate", { url: `${origin}/p.html` });
    assert.equal(await until(() => ev("window.ready === true && !!document.getElementById('term').contentDocument && !!document.getElementById('term').contentDocument.getElementById('t')"), (v) => v === true), true, "시험 페이지가 안 섰다");
  };
  const focusTerm = async () => {
    const r = await ev(`(() => { const b = document.getElementById('term').getBoundingClientRect(); return { x: b.left + 100, y: b.top + 60 }; })()`);
    await click(r.x, r.y);
    return until(st, (s) => s.active === "term" && s.inner === "t", 3000);
  };
  const open = async () => {
    const r = await ev(`AUI.openAppUi('memo', { title: '메모', onClose: () => { window.__closed++; } })`);
    assert.equal(r, true, "openAppUi 가 덮개를 못 열었다(관측 장치 고장)");
    return until(st, (s) => s.overlay && s.active === "overlay", 1500);
  };
  await cdp("Page.enable");

  // T0 · F1 · F2 — 보이는 터미널에 초점이 있는 채 열고, 첫 키로 Esc
  await load();
  const s0 = await focusTerm();
  ok(s0.active === "term" && s0.inner === "t", "T0 터미널을 누르면 초점이 그 액자 안 입력칸에 선다(관측 장치)", s0);
  const s1 = await open();
  ok(s1.active === "overlay", "F1 덮개를 열면 초점이 덮개로 온다", { active: s1.active, inner: s1.inner });
  ok(s1.outline === "none", "F1 초점이 간 덮개에 테두리가 없다", { outline: s1.outline });
  await key("Escape");
  const s2 = await until(st, (s) => !s.overlay, 1500);
  ok(!s2.overlay && s2.closed === 1 && !s2.termKeys.includes("Escape"), "F2 Esc 로 닫힌다 · 닫기 뒷일 한 번 · 터미널은 Esc 를 받지 않는다", { overlay: s2.overlay, closed: s2.closed, termKeys: s2.termKeys });

  // F3 — 새로 열고 첫 키로 글자
  await load();
  await focusTerm();
  await open();
  await key("x");
  const s3 = await st();
  ok(s3.termText === "" && s3.termKeys.length === 0, "F3 덮개가 열린 동안 친 글자가 뒤의 터미널로 가지 않는다", { termText: s3.termText, termKeys: s3.termKeys });

  // F4 — 터미널이 든 칸을 숨긴 뒤 연다(셸이 크게 보기 탭을 켜며 세션 탭을 숨기는 꼴)
  await load();
  await focusTerm();
  await ev("document.getElementById('pane').hidden = true");
  await sleep(150);
  const s4 = await open();
  await key("Escape");
  const s5 = await until(st, (s) => !s.overlay, 1500);
  ok(s4.active === "overlay" && !s5.overlay && s5.closed === 1, "F4 터미널 칸을 숨긴 뒤 열어도 초점은 덮개 · Esc 로 닫힌다", { opened: s4.active, overlay: s5.overlay, closed: s5.closed, termKeys: s5.termKeys });

  // F5 — 다시 열어도 덮개에 초점 · 닫기 단추를 마우스로
  await ev("document.getElementById('pane').hidden = false");
  await focusTerm();
  const s6 = await open();
  const b = await ev(`(() => { const x = [...document.querySelectorAll('.v2-appui-h button')].find((y) => (y.textContent || '').trim() === '닫기'); if (!x) return null; const r = x.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  assert.ok(b, "닫기 단추가 없다(관측 장치 고장)");
  await click(b.x, b.y);
  const s7 = await until(st, (s) => !s.overlay, 1500);
  ok(s6.active === "overlay" && !s7.overlay && s7.closed === 2, "F5 다시 열어도 초점은 덮개 · 닫기 단추로도 닫힌다(뒷일 두 번째)", { opened: s6.active, overlay: s7.overlay, closed: s7.closed });
} finally {
  try { ws?.close(); } catch (_) { /* noop */ }
  child.kill("SIGKILL");
  srv.close();
  await new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once("close", r)));
  //  크롬 본체만 죽이면 남은 보조 프로세스가 지운 프로필 폴더를 다시 만드는 판이 있었다(빈 폴더 · 격리 리뷰 실측 5회 중 2회) — 잠깐 쉬고 지운다.
  await sleep(300);
  for (let i = 0; i < 5; i++) { try { rmSync(dir, { recursive: true, force: true }); break; } catch (_) { await sleep(200); } }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

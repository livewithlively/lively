#!/usr/bin/env node
// 말을 보낸 직후의 세션 화면 — **하네스가 그릴 때까지 대화창에 머물다가, 그린 순간 터미널로 넘긴다**(#4794, 런타임).
//
//  신고(상민님 2026-10-16): «대화창에서 프롬프트 보냈을 때 터미널로 넘어가는데, 터미널 화면으로 이동하고 실제 하네스 안에
//   내용이 보이기까지 2~3초 동안 빈 터미널 화면이 보인다 — 하네스 안에 내용이 보이게 되는 순간 넘기는 게 낫다.»
//  고침: 세션 화면(web/session-chat.ts termWarm)은 firstPrompt 를 들고 열리면 대화창을 보인 채 터미널 액자를 대화창 자리에
//   숨겨(visibility:hidden · inert) 먼저 붙이고, 액자(web/standalone/terminal.ts watchFirstPaint)가 «처음 그렸다»
//   (lively-term-painted)를 알리면 그때 넘긴다. 숨은 액자는 붙자마자 초점을 가져가지 않는다(frameHiddenNow).
//
//  엣지 표(행마다 장면 하나):
//   W1 말을 보내 연 화면 · 하네스가 0.8초 뒤 그린다 → 그리기 전엔 대화창(액자는 숨어 붙어 있음 · 대화창과 같은 크기 · 초점은 입력칸)
//      · 그린 뒤 터미널(숨김 걷힘 · 터미널에 초점) · 넘긴 때는 그린 때 뒤, 0.3초 남짓 안
//   W2 그냥 연 화면(firstPrompt 없음) → 종전처럼 처음부터 터미널(숨겨 붙이기 없음)
//   W3 하네스가 끝내 안 그린다(공백만 계속 온다) → 5초에도 대화창 · 상한(12초) 뒤 터미널(종전 화면으로 물러남)
//   W4 숨겨 붙이는 중 사람이 [⋯ ▸ 보기 ▸ 터미널로] → 곧바로 터미널(초점도) · 그 뒤 신호가 와도 그대로
//   W5 숨겨 붙이는 중 입력칸에 글을 쓰고 있다 → 그려도 화면을 뺏지 않는다(대화창 · 글 그대로 · 초점 그대로) · 다음 목록 갱신도 안 뺏는다
//   W6 숨겨 붙이는 중 액자가 «박스 없음» → 액자를 걷고 대화창(터미널로 안 넘어감)
//   W7 숨겨 붙이는 중 목록 갱신이 «살아 있다» 를 다시 줘도 넘기지 않는다 → 그린 뒤에 넘긴다
//   W8 그린 뒤 스피너처럼 쉬지 않고 다시 그린다 → 멎기를 끝없이 기다리지 않는다(처음 그린 때부터 1.5초 상한)
//   W9 말을 보내 열었는데 터미널이 없다(멈춘 행) → 숨겨 붙이기 없음 · 대화창(종전)
//   W10 말을 보내 열 때 목록 행이 한 틱 늦어 터미널이 없었다 → 갱신으로 터미널이 생기면 곧바로 넘기지 않고 숨겨 붙인다 · 그린 뒤 넘긴다
//   W11 대화가 본자리인 화면(chatHome — 리브 탭도 첫 지시를 들고 온다) · 첫 지시 → 숨겨 붙이기 없음(대화창 · 액자 없음)
//   W12 못 간 글을 들고 온 화면(draft) · 첫 지시 → 숨겨 붙이기 없음 · 글은 입력칸에
//   W13 관측 못 한 행(observed:false) · 첫 지시 → 숨겨 붙이기 없음
//   W14 숨겨 붙이는 중 화면이 부서진다(destroy) → 상한이 지나도 아무 일 없음(오류 없음)
//   W15 숨은 탭(display:none)에서 열렸다가 보인다 → 숨은 액자가 그때 대화창 자리·크기로 맞춰진다 · 그린 뒤 넘긴다
//       ⚠ 이 헤드리스(--dump-dom · 가상 시간)는 그리기 단계를 안 돌려 requestAnimationFrame 도 ResizeObserver 도 한 번도 안 뜬다
//        (실측 2026-10-16: rAF 0회 · RO 0회 — display:none → flex 로 보여도). 그래서 이 장면만 가짜 RO 를 끼워, 대화창 칸을 지켜보는지와
//        그 콜백이 자리를 다시 맞추는지 · 끝나면 끊는지를 잰다(진짜 브라우저에선 탭이 보이는 순간 RO 가 뜬다).
//   W16 숨겨 붙이는 중 액자가 «끝났다»(status end) → 기다리지 않고 곧바로 터미널(그 배너를 봐야 한다)
//   W17 사람이 이 화면 밖(다른 입력칸)에 초점을 두고 있다 → 그려서 넘기되 초점은 빼앗지 않는다
//   W18 숨겨 붙이는 중 연결 오류(status err) → 넘기지 않되 머리줄 칩으로는 보인다
//   W19 숨겨 붙이는 중 목록 갱신이 «대화가 본자리»(대화 런타임 — chatHome)를 알려 온다 → 숨겨 붙이기를 접고 그려도 넘기지 않는다
//  순수 판정(«그렸나» · 기다릴 시간 · «숨었나» 의 액자 밖)은 노드 시험 term-first-paint.test.mjs 가 맡는다.
//
//  가짜는 «서버» 와 «하네스 출력» 뿐이다. 세션 화면은 실제 모듈(web/session-chat.ts)을, 액자는 실제 터미널 모듈
//   (web/standalone/terminal.ts — watchFirstPaint · frameHiddenNow)과 실제 xterm(public/vendor)을 같은 출처(http)로 싣는다.
//   file:// 로는 액자·셸의 출처가 갈려 postMessage 를 잴 수 없다(headless-chrome.mjs serve 머리말).
//  fail-first: `SRC_ROOT=<옛 트리>`(web/ · public/styles · public/vendor/xterm 이 있는 곳)로 옛 코드를 물린다.
//  크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSync } from "esbuild";
import { dumpDom, findChrome, readOut } from "./headless-chrome.mjs";

const ROOT = process.env.SRC_ROOT || path.resolve(import.meta.dirname, "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 보낸 뒤 터미널 넘기기 런타임 검증 미실행"); process.exit(0); }

const CSS = ["01-base.css", "03-components.css", "36-chat.css", "38-chat-tui.css"].map((f) => path.join(ROOT, "public/styles", f)).filter(existsSync);
const XTERM = ["xterm.min.js", "xterm.min.css"].map((f) => path.join(ROOT, "public/vendor/xterm", f));
for (const f of XTERM) if (!existsSync(f)) { console.error(`FAIL  vendored xterm 없음: ${f}`); process.exit(1); }
const sc = buildSync({
  stdin: { contents: "export { mountSessionChat } from './web/session-chat.ts';", resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "iife", globalName: "SC", write: false, platform: "browser", target: "es2020", logLevel: "silent",
}).outputFiles[0].text;
const tm = buildSync({
  entryPoints: [path.join(ROOT, "web/standalone/terminal.ts")], bundle: true, format: "iife", globalName: "TM", write: false,
  platform: "browser", target: "es2020", define: { TERMJS_BUILD: JSON.stringify("test") }, logLevel: "silent",
}).outputFiles[0].text;

//  가짜 터미널 페이지 — 실제 모듈의 두 함수를 terminal.ts boot() 가 거는 자리 그대로 건다(나머지 boot 는 소켓·서버가 필요해 뺀다).
//   주소: frame.html?session=<id>&embed=1 [&ink=<ms> 그 뒤 하네스가 그린다] [&spin=1 그린 뒤 쉬지 않고 다시 그림]
//         [&blank=1 공백만 계속] [&gone=<ms> 그 뒤 «박스 없음»] [&end=<ms> 그 뒤 «끝났다»(status end)] [&err=<ms> 그 뒤 연결 오류(status err)]
//   test-* 메시지는 이 시험이 재는 관측(때 · 크기 · 초점)이다 — 세션 화면은 모르는 종류라 버린다.
const FRAME = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="xterm.min.css">
<style>html,body{margin:0;height:100%;overflow:hidden}#h{position:absolute;inset:0}</style><div id="h"></div>
<script src="xterm.min.js"></script><script src="tm.js"></script>
<script>
(function () {
  var q = new URLSearchParams(location.search);
  var id = q.get('session');
  var say = function (o) { try { parent.postMessage(Object.assign({ id: id }, o), location.origin); } catch (_) {} };
  var term = new Terminal({ cols: 80, rows: 24, fontSize: 13 });
  term.open(document.getElementById('h'));
  TM.__injectRefsForTest({ term: term });
  if (TM.watchFirstPaint) TM.watchFirstPaint();                       // boot() 가 term.onData 다음에 거는 자리
  var hidden = TM.frameHiddenNow ? TM.frameHiddenNow() : false;        // onopen 의 초점 가드 — 옛 판엔 없다(늘 초점)
  if (!hidden) term.focus();
  say({ type: 'test-boot', hidden: hidden, w: innerWidth, h: innerHeight, at: Date.now() });
  say({ type: 'lively-term-status', text: '연결됨', cls: 'ok', paneShell: false });
  window.addEventListener('message', function (ev) {                  // 종전 setupEmbedBridge 의 'focus' 명령과 같은 동작
    if (ev.source !== parent) return;
    var m = ev.data;
    if (m && m.type === 'lively-term' && m.cmd === 'focus') { term.focus(); say({ type: 'test-focused', at: Date.now() }); }
  });
  term.write('\\x1b[2J\\x1b[H');                                       // 하네스가 뜨기 전의 빈 pane
  if (q.get('blank')) setInterval(function () { term.write('\\x1b[H   \\r\\n  \\x1b[K'); }, 200);
  var ink = Number(q.get('ink') || -1);
  if (ink >= 0) setTimeout(function () {
    say({ type: 'test-ink', at: Date.now() });
    term.write('\\x1b[?1049h\\x1b[H\\u256d\\u2500\\u2500\\u2500\\u256e\\r\\n\\u2502 Welcome to Claude Code \\u2502\\r\\n\\u2570\\u2500\\u2500\\u2500\\u256f\\r\\n> ');
    if (q.get('spin')) { var i = 0; setInterval(function () { term.write('\\x1b[6;1H' + '|/-\\\\'.charAt(i++ % 4)); }, 100); }
  }, ink);
  var end = Number(q.get('end') || -1);
  if (end >= 0) setTimeout(function () { say({ type: 'lively-term-status', text: '세션 종료됨', cls: 'end' }); }, end);
  var err = Number(q.get('err') || -1);
  if (err >= 0) setTimeout(function () { say({ type: 'lively-term-status', text: '연결 끊김 — 재연결 중…', cls: 'err' }); }, err);
  var gone = Number(q.get('gone') || -1);
  if (gone >= 0) setTimeout(function () { parent.postMessage({ type: 'lively-term-gone', id: id, restorable: true, canRestore: true }, location.origin); }, gone);
})();
</script>`;

async function PAGE_MAIN() {
  const R = {};
  const pageErrors = [];
  window.addEventListener("error", (e) => pageErrors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => pageErrors.push("rej: " + String(e.reason && e.reason.message || e.reason)));
  const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
  const J = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { "content-type": "application/json" } });
  window.fetch = async (url) => {
    const u = new URL(String(url), location.href);
    if (/\/transcript$/.test(u.pathname)) return new Response("", { status: 200, headers: { "content-type": "text/plain" } });
    if (/\/outbox$/.test(u.pathname)) return J({ items: [] });
    return J({ error: "no" }, 404);
  };
  localStorage.setItem("lively_ui_token", "t");
  const SC = (new Function(document.getElementById("src").textContent + "\n;return SC;"))();
  //  액자가 보낸 시험 관측(때 · 크기 · 초점).
  const fx = {};
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (!m || typeof m.type !== "string" || !m.type.startsWith("test-")) return;
    (fx[m.id] ||= {})[m.type] = m;
  });
  const row = (id, alive) => ({ id, label: "세션", live: true, alive, node: null, owned: true, stateKey: alive ? "idle" : "restorable", stateLabel: alive ? "대기" : "중단됨",
    projectId: null, projectName: "", raw: alive ? { harness: "claude", chatMode: "tmux", agentState: "idle" } : { harness: "claude", chatMode: "tmux", restorable: true } });
  const mount = (id, frameQ, opts, alive = true, rawExtra = null, hidden = false) => {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:0;top:0;width:1000px;height:700px;flex-direction:column;background:#fff;display:" + (hidden ? "none" : "flex");
    document.body.append(box);
    const t0 = Date.now();
    const r0 = row(id, alive);
    if (rawExtra) Object.assign(r0.raw, rawExtra);
    const h = SC.mountSessionChat(box, r0, Object.assign({
      terminalSrc: (t) => (t.live && t.alive ? `frame.html?session=${encodeURIComponent(t.id)}&embed=1&${frameQ}` : null),
      onResumed: () => {},
    }, opts || {}));
    const wrap = box.querySelector(".sc-wrap");
    const chat = box.querySelector(".sc-chat");
    const th = box.querySelector(".sc-term");
    //  넘긴 때 — 터미널 모드가 처음 선 때(25ms 간격으로 본다)
    let termAt = 0;
    const iv = setInterval(() => { if (!termAt && wrap.classList.contains("sc-mode-term")) termAt = Date.now(); }, 25);
    const snap = () => {
      const fr = th.querySelector("iframe");
      const a = document.activeElement;
      return {
        term: wrap.classList.contains("sc-mode-term"), warm: wrap.classList.contains("sc-term-warm"),
        chatShown: !chat.hidden, termHidden: th.hidden, inert: th.hasAttribute("inert"), vis: getComputedStyle(th).visibility,
        inlineBox: !!(th.style.top || th.style.height), frame: !!fr,
        chip: (() => { const c = box.querySelector(".sc-termstat"); return c && !c.hidden ? c.textContent : null; })(),
        focus: a && fr && a === fr ? "frame" : a && a.classList && a.classList.contains("livc-input") ? "input" : a ? a.tagName.toLowerCase() : "",
      };
    };
    const geo = () => { const c = chat.getBoundingClientRect(), t = th.getBoundingClientRect(); return { chat: [Math.round(c.top), Math.round(c.height), Math.round(c.width)], term: [Math.round(t.top), Math.round(t.height), Math.round(t.width)] }; };
    return {
      box, h, snap, geo, t0, termAt: () => (termAt ? termAt - t0 : 0), fx: () => fx[id] || {},
      input: () => box.querySelector("textarea.livc-input"),
      done: () => { clearInterval(iv); try { h.destroy(); } catch (_) { /* 이미 */ } box.remove(); },
    };
  };
  try {
    // W1 — 말을 보내 연 화면 · 0.8초 뒤 그린다
    {
      const v = mount("box-w1", "ink=800", { firstPrompt: "첫 지시 — 하네스 띄워서 이걸 해 줘" });
      await sleep(450);
      R.w1 = { before: v.snap(), geo: v.geo(), boot: v.fx()["test-boot"] || null };
      await sleep(1600);
      R.w1.after = v.snap();
      R.w1.termAt = v.termAt();
      const ink = v.fx()["test-ink"];
      R.w1.inkAt = ink ? ink.at - v.t0 : null;
      R.w1.focused = !!v.fx()["test-focused"];
      v.done();
    }
    // W2 — 그냥 연 화면
    {
      const v = mount("box-w2", "ink=800", {});
      await sleep(200);
      R.w2 = { at200: v.snap() };
      v.done();
    }
    // W3 — 끝내 안 그린다(공백만)
    {
      const v = mount("box-w3", "blank=1", { firstPrompt: "첫 지시" });
      await sleep(5000);
      R.w3 = { at5s: v.snap() };
      await sleep(8000);
      R.w3.at13s = v.snap();
      R.w3.termAt = v.termAt();
      v.done();
    }
    // W4 — 숨겨 붙이는 중 사람이 [⋯ ▸ 보기 ▸ 터미널로]
    {
      const v = mount("box-w4", "ink=1500", { firstPrompt: "첫 지시" });
      await sleep(400);
      const more = document.querySelector('button[aria-label="더 보기"]');
      if (more) more.click();
      await sleep(150);
      const go = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "터미널로");
      R.w4 = { menu: !!more, btn: !!go };
      if (go) go.click();
      await sleep(150);
      R.w4.afterPick = v.snap();
      R.w4.focused = !!v.fx()["test-focused"];
      await sleep(2200);
      R.w4.afterInk = v.snap();
      R.w4.ink = !!v.fx()["test-ink"];
      v.done();
    }
    // W5 — 입력칸에 쓰는 중
    {
      const v = mount("box-w5", "ink=900", { firstPrompt: "첫 지시" });
      await sleep(300);
      const inp = v.input();
      inp.focus(); inp.value = "추가로 이것도"; inp.dispatchEvent(new Event("input"));
      await sleep(1700);
      R.w5 = { after: v.snap(), value: inp.value, ink: !!v.fx()["test-ink"] };
      v.h.update(row("box-w5", true));                                   // 다음 목록 갱신(20초 주기)
      await sleep(200);
      R.w5.afterUpdate = v.snap();
      v.done();
    }
    // W6 — 숨겨 붙이는 중 «박스 없음»
    {
      const v = mount("box-w6", "gone=500&ink=900", { firstPrompt: "첫 지시" });
      await sleep(1800);
      R.w6 = { after: v.snap(), termAt: v.termAt() };
      v.done();
    }
    // W7 — 목록 갱신이 «살아 있다» 를 다시 줘도
    {
      const v = mount("box-w7", "ink=1200", { firstPrompt: "첫 지시" });
      await sleep(300);
      v.h.update(row("box-w7", true));
      await sleep(200);
      R.w7 = { afterUpdate: v.snap() };
      await sleep(1800);
      R.w7.after = v.snap();
      v.done();
    }
    // W8 — 그린 뒤 쉬지 않고 다시 그린다
    {
      const v = mount("box-w8", "ink=500&spin=1", { firstPrompt: "첫 지시" });
      await sleep(3500);
      const ink = v.fx()["test-ink"];
      R.w8 = { after: v.snap(), termAt: v.termAt(), inkAt: ink ? ink.at - v.t0 : null };
      v.done();
    }
    // W9 — 말을 보내 열었는데 터미널이 없다(멈춘 행)
    {
      const v = mount("box-w9", "ink=300", { firstPrompt: "첫 지시" }, false);
      await sleep(900);
      R.w9 = { after: v.snap(), termAt: v.termAt() };
      v.done();
    }
    // W10 — 열 때 행이 늦었다(터미널 없음) → 갱신으로 생긴다
    {
      const v = mount("box-w10", "ink=600", { firstPrompt: "첫 지시" }, false);
      await sleep(300);
      R.w10 = { atOpen: v.snap() };
      v.h.update(row("box-w10", true));
      await sleep(300);
      R.w10.afterUpdate = v.snap();
      await sleep(2200);
      R.w10.after = v.snap();
      const ink = v.fx()["test-ink"];
      R.w10.inkAt = ink ? ink.at - v.t0 : null;
      R.w10.termAt = v.termAt();
      v.done();
    }
    // W11 — 대화가 본자리인 화면
    {
      const v = mount("box-w11", "ink=300", { firstPrompt: "첫 지시", chatHome: true });
      await sleep(1200);
      R.w11 = { after: v.snap(), termAt: v.termAt() };
      v.done();
    }
    // W12 — 못 간 글을 들고 온 화면
    {
      const v = mount("box-w12", "ink=300", { firstPrompt: "첫 지시", draft: "못 간 글" });
      await sleep(1200);
      R.w12 = { after: v.snap(), termAt: v.termAt(), value: v.input() ? v.input().value : null };
      v.done();
    }
    // W13 — 관측 못 한 행
    {
      const v = mount("box-w13", "ink=300", { firstPrompt: "첫 지시" }, true, { observed: false });
      await sleep(1200);
      R.w13 = { after: v.snap(), termAt: v.termAt() };
      v.done();
    }
    // W14 — 숨겨 붙이는 중 부서진다
    {
      const v = mount("box-w14", "ink=2000", { firstPrompt: "첫 지시" });
      await sleep(400);
      R.w14 = { before: v.snap() };
      const errs0 = pageErrors.length;
      const wrapEl = v.box.querySelector(".sc-wrap");
      v.done();
      R.w14.warmAfterDestroy = wrapEl.classList.contains("sc-term-warm");   // 부서질 때 곧바로 걷혔나(상한 타이머를 남기지 않았나)
      await sleep(13000);
      R.w14.newErrors = pageErrors.slice(errs0);
    }
    // W15 — 숨은 탭에서 열렸다가 보인다(가짜 RO — 머리말 ⚠)
    {
      const RealRO = window.ResizeObserver;
      const fakes = [];
      window.ResizeObserver = class { constructor(cb) { this.cb = cb; this.els = []; this.dead = false; fakes.push(this); } observe(el) { this.els.push(el); } unobserve() {} disconnect() { this.dead = true; } };
      try {
        const v = mount("box-w15", "ink=1500", { firstPrompt: "첫 지시" }, true, null, true);
        await sleep(400);
        R.w15 = { hiddenSnap: v.snap(), hiddenGeo: v.geo() };
        v.box.style.display = "flex";
        const chatEl = v.box.querySelector(".sc-chat");
        R.w15.watchesChat = fakes.some((f) => !f.dead && f.els.includes(chatEl));
        for (const f of fakes) if (!f.dead) f.cb([]);               // 탭이 보이는 순간 진짜 브라우저가 부르는 자리
        await sleep(100);
        R.w15.shownSnap = v.snap(); R.w15.geo = v.geo();
        await sleep(2500);
        R.w15.after = v.snap();
        const mine = fakes.filter((f) => f.els.includes(chatEl));      // 대화창 칸을 지켜보는 것(숨겨 붙이기의 것) — 다른 부품의 RO 는 제 몫이다
        R.w15.watchers = mine.length;
        R.w15.disconnected = mine.length > 0 && mine.every((f) => f.dead);
        v.done();
      } finally { window.ResizeObserver = RealRO; }
    }
    // W16 — 숨겨 붙이는 중 «끝났다»
    {
      const v = mount("box-w16", "end=500", { firstPrompt: "첫 지시" });
      await sleep(2200);
      const boot = v.fx()["test-boot"];
      R.w16 = { after: v.snap(), termAt: v.termAt(), endAt: boot ? boot.at - v.t0 + 500 : null };
      v.done();
    }
    // W17 — 이 화면 밖에 초점
    {
      const outside = document.createElement("input");
      outside.id = "outside-input"; outside.style.cssText = "position:fixed;right:0;bottom:0;width:120px";
      document.body.append(outside);
      const v = mount("box-w17", "ink=900", { firstPrompt: "첫 지시" });
      await sleep(300);
      outside.focus();
      await sleep(1800);
      R.w17 = { after: v.snap(), focusedFrame: !!v.fx()["test-focused"], active: document.activeElement === outside ? "outside" : (document.activeElement ? document.activeElement.tagName : "") };
      v.done(); outside.remove();
    }
    // W18 — 숨겨 붙이는 중 연결 오류
    {
      const v = mount("box-w18", "err=500", { firstPrompt: "첫 지시" });
      await sleep(2200);
      R.w18 = { after: v.snap() };
      v.done();
    }
    // W19 — 숨겨 붙이는 중 «대화가 본자리» 를 뒤늦게 안다
    {
      const v = mount("box-w19", "ink=900", { firstPrompt: "첫 지시" });
      await sleep(300);
      const r19 = row("box-w19", true); r19.raw.runtimeMode = "chat";
      v.h.update(r19);
      await sleep(200);
      R.w19 = { afterUpdate: v.snap() };
      await sleep(1600);
      R.w19.after = v.snap(); R.w19.ink = !!v.fx()["test-ink"]; R.w19.termAt = v.termAt();
      v.done();
    }
  } catch (e) { R.err = String(e && e.stack || e); }
  R.pageErrors = pageErrors;
  document.getElementById("out").textContent = JSON.stringify(R) + "ENDRESULT";
}

const files = mkdtempSync(path.join(tmpdir(), "term-warm-src-"));
const write = (name, text) => { const f = path.join(files, name); writeFileSync(f, text); return f; };
const page = `<!doctype html><html data-theme="light"><meta charset="utf-8">
${CSS.map((f) => `<link rel="stylesheet" href="${path.basename(f)}">`).join("")}
<style>html,body{margin:0}</style><div id="toasts"></div><pre id="out" style="position:fixed;left:-9999px">PENDING</pre>
<script type="text/plain" id="src">${sc.replace(/<\/script/gi, "<\\/script")}</script>
<script>(${PAGE_MAIN.toString()})().catch(function (e) { document.getElementById('out').textContent = JSON.stringify({ fatal: String(e && e.stack || e) }) + 'ENDRESULT'; });</script>`;
let dom;
try {
  dom = await dumpDom(chrome, {
    html: page, serve: true, prefix: "term-warm-", virtualTimeBudget: 120000, args: ["--window-size=1200,900"],
    copy: [...CSS, ...XTERM, write("frame.html", FRAME), write("tm.js", tm)],
  });
} finally { rmSync(files, { recursive: true, force: true }); }
const res = readOut(dom);
if (res.text === null) { console.error(`FAIL  페이지가 결과를 안 냈다(out=${JSON.stringify(res.out)}): ${dom.slice(0, 400)}`); process.exit(1); }
const R = JSON.parse(res.text);
if (process.env.DEBUG) console.log(JSON.stringify(R, null, 1));

let pass = 0, fail = 0;
const Js = (v) => JSON.stringify(v);
const check = (cond, n, got) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL  ${n} :: 실제 ${Js(got)}`); } };
if (R.fatal || R.err) { fail++; console.error(`FAIL  페이지가 던졌다: ${String(R.fatal || R.err).split("\n").slice(0, 3).join(" | ")}`); }
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

const w1 = R.w1 || {};
const b1 = w1.before || {};
check(!b1.term && b1.warm && b1.chatShown && b1.frame && !b1.termHidden && b1.inert && b1.vis === "hidden",
  "W1 그리기 전 — 대화창이 보이고 터미널 액자는 숨은 채 붙어 있다(visibility:hidden · inert)", b1);
const g1 = w1.geo || { chat: [], term: [] };
check(g1.chat.length === 3 && g1.chat.every((x, i) => near(x, g1.term[i])) && !!w1.boot && near(w1.boot.w, g1.chat[2]) && near(w1.boot.h, g1.chat[1]),
  "W1 숨은 액자는 대화창과 같은 자리·같은 크기다(넘길 때 크기가 안 바뀐다)", { geo: g1, frame: w1.boot && [w1.boot.w, w1.boot.h] });
check(!!w1.boot && w1.boot.hidden === true && b1.focus === "input",
  "W1 숨은 액자는 붙자마자 초점을 가져가지 않는다 — 초점은 대화창 입력칸", { boot: w1.boot, focus: b1.focus });
const a1 = w1.after || {};
check(a1.term && !a1.warm && !a1.chatShown && !a1.termHidden && !a1.inert && a1.vis === "visible" && !a1.inlineBox,
  "W1 그린 뒤 — 터미널로 넘어갔다(숨김·inert·임시 자리 걷힘)", a1);
check(w1.inkAt != null && w1.termAt > 0 && w1.termAt >= w1.inkAt && w1.termAt - w1.inkAt <= 700,
  "W1 넘긴 때 = 하네스가 그린 뒤 · 멎기를 조금(0.3초) 기다린 만큼만 늦게", { inkAt: w1.inkAt, termAt: w1.termAt });
check(w1.focused && a1.focus === "frame", "W1 넘긴 뒤 터미널에 초점(바로 칠 수 있다)", { focused: w1.focused, focus: a1.focus });

const w2 = (R.w2 || {}).at200 || {};
check(w2.term && !w2.warm && w2.frame && !w2.inert, "W2 그냥 연 화면은 종전처럼 처음부터 터미널(숨겨 붙이기 없음)", w2);

const w3 = R.w3 || {};
check((w3.at5s || {}).warm && !(w3.at5s || {}).term, "W3 공백만 오면 «그렸다» 가 아니다 — 5초에도 대화창", w3.at5s);
check((w3.at13s || {}).term && !(w3.at13s || {}).warm && w3.termAt >= 11500 && w3.termAt <= 13000,
  "W3 끝내 안 그리면 상한(12초) 뒤 종전처럼 터미널로", { at13s: w3.at13s, termAt: w3.termAt });

const w4 = R.w4 || {};
check(w4.menu && w4.btn && (w4.afterPick || {}).term && !(w4.afterPick || {}).warm && w4.focused && (w4.afterPick || {}).focus === "frame",
  "W4 숨겨 붙이는 중 사람이 [터미널로] → 곧바로 터미널 · 초점도 터미널(숨어 붙을 때 못 잡은 초점)", w4);
check(w4.ink && (w4.afterInk || {}).term && !(w4.afterInk || {}).warm, "W4 그 뒤 신호가 와도 그대로 터미널", w4.afterInk);

const w5 = R.w5 || {};
const a5 = w5.after || {};
check(w5.ink && !a5.term && !a5.warm && a5.chatShown && a5.termHidden && w5.value === "추가로 이것도" && a5.focus === "input",
  "W5 입력칸에 쓰는 중이면 그려도 화면을 뺏지 않는다(대화창 · 글 · 초점 그대로)", w5);
check(!(w5.afterUpdate || {}).term && (w5.afterUpdate || {}).chatShown, "W5 그 뒤 목록 갱신도 쓰던 대화창을 터미널로 안 가져간다(대화창을 고른 것으로 친다)", w5.afterUpdate);

const w6 = R.w6 || {};
const a6 = w6.after || {};
check(!a6.term && !a6.frame && !a6.warm && a6.chatShown && !w6.termAt,
  "W6 숨겨 붙이는 중 «박스 없음» → 액자를 걷고 대화창(터미널로 안 넘어감)", w6);

const w7 = R.w7 || {};
check((w7.afterUpdate || {}).warm && !(w7.afterUpdate || {}).term, "W7 목록 갱신이 «살아 있다» 를 다시 줘도 그리기 전엔 넘기지 않는다", w7.afterUpdate);
check((w7.after || {}).term && !(w7.after || {}).warm, "W7 그린 뒤에는 넘긴다", w7.after);

const w8 = R.w8 || {};
check((w8.after || {}).term && w8.inkAt != null && w8.termAt - w8.inkAt >= 1300 && w8.termAt - w8.inkAt <= 2200,
  "W8 쉬지 않고 다시 그려도 처음 그린 때부터 1.5초 상한에 넘긴다", { inkAt: w8.inkAt, termAt: w8.termAt });

const w9 = R.w9 || {};
const a9 = w9.after || {};
check(!a9.term && !a9.warm && !a9.frame && a9.chatShown && !w9.termAt, "W9 터미널이 없는 화면은 숨겨 붙이기 없이 대화창(종전)", w9);

const w10 = R.w10 || {};
check(!(w10.atOpen || {}).frame && !(w10.atOpen || {}).term && (w10.afterUpdate || {}).warm && (w10.afterUpdate || {}).frame && !(w10.afterUpdate || {}).term,
  "W10 열 때 터미널이 없었으면 — 갱신으로 생길 때 곧바로 넘기지 않고 숨겨 붙인다", w10);
check((w10.after || {}).term && w10.inkAt != null && w10.termAt >= w10.inkAt, "W10 그린 뒤에 넘긴다", { inkAt: w10.inkAt, termAt: w10.termAt, after: w10.after });

const noWarm = (x) => !!x && !x.term && !x.warm && !x.frame && x.chatShown;
check(noWarm((R.w11 || {}).after) && !(R.w11 || {}).termAt, "W11 대화가 본자리인 화면(chatHome)은 첫 지시가 있어도 숨겨 붙이지 않는다", R.w11);
check(noWarm((R.w12 || {}).after) && !(R.w12 || {}).termAt && (R.w12 || {}).value === "못 간 글", "W12 못 간 글을 들고 온 화면은 숨겨 붙이지 않는다 · 글은 입력칸에", R.w12);
check(noWarm((R.w13 || {}).after) && !(R.w13 || {}).termAt, "W13 관측 못 한 행(observed:false)은 숨겨 붙이지 않는다", R.w13);
const w14 = R.w14 || {};
check((w14.before || {}).warm && w14.warmAfterDestroy === false && Array.isArray(w14.newErrors) && !w14.newErrors.length, "W14 숨겨 붙이는 중 부서지면 그 자리에서 걷힌다(상한 타이머를 남기지 않는다) · 오류 0", w14);
const w15 = R.w15 || {};
const g15 = w15.geo || { chat: [], term: [] };
check((w15.hiddenSnap || {}).warm && w15.watchesChat && (w15.shownSnap || {}).warm && !(w15.shownSnap || {}).term && g15.chat.length === 3 && g15.chat[1] > 100 && g15.chat.every((x, i) => near(x, g15.term[i])),
  "W15 숨은 탭에서 열렸다 보이면(대화창 칸의 크기 변화) 숨은 액자가 그때 대화창 자리·크기로 맞춰진다", { watches: w15.watchesChat, hiddenGeo: w15.hiddenGeo, shown: w15.shownSnap, geo: g15 });
check((w15.after || {}).term && !(w15.after || {}).warm && w15.disconnected === true, "W15 그린 뒤 넘긴다 · 대화창 칸 지켜보기는 끊는다", { after: w15.after, watchers: w15.watchers, disconnected: w15.disconnected });
const w16 = R.w16 || {};
check((w16.after || {}).term && !(w16.after || {}).warm && w16.endAt != null && w16.termAt >= w16.endAt - 50 && w16.termAt <= w16.endAt + 400,
  "W16 액자가 «끝났다» 고 하면 기다리지 않고 그 자리에서 터미널로(배너를 보게)", w16);
const w17 = R.w17 || {};
check((w17.after || {}).term && !w17.focusedFrame && w17.active === "outside", "W17 이 화면 밖에 초점이 있으면 넘기되 초점은 빼앗지 않는다", w17);
const w18 = R.w18 || {};
check((w18.after || {}).warm && !(w18.after || {}).term && /재연결/.test(String((w18.after || {}).chip || "")), "W18 연결 오류는 넘기지 않되 머리줄 칩으로 보인다", w18.after);

const w19 = R.w19 || {};
check(!(w19.afterUpdate || {}).warm && !(w19.afterUpdate || {}).term && w19.ink && !(w19.after || {}).term && !w19.termAt,
  "W19 숨겨 붙이는 중 «대화가 본자리» 를 알게 되면 접고 · 그려도 터미널로 안 넘긴다", w19);

check(!(R.pageErrors || []).length, "E 페이지 오류 없음", R.pageErrors);
console.log(`\nterm-warm-runtime: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);

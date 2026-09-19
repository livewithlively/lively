#!/usr/bin/env node
// 대화창 «위로 더» 자동 불러오기 — **런타임** 테스트 (#3778, 원준 2026-09-19)
//
// 사양: 사람이 위로 스크롤하면 단추 없이 이전 대화가 이어 붙는다. 꼭대기에서 멈추거나 누를 일이 없어야 한다.
//  · 맨 위 표지가 화면 위 두 장(목록 높이 200%) 안에 들어오면 부른다 — 꼭대기에 닿기 **전에**
//  · 붙인 뒤에도 그 거리 안이면 이어서 부른다 · 처음에 닿으면 멈춘다 · 한 번에 하나
//  · 실패하면 그 자리에서 되묻지 않는다 — 떠났다 돌아오거나 [다시 시도] 로 다시 · 가려진 목록에선 안 부른다
//  · 위에 끼우는 동안 보던 줄이 화면에서 움직이지 않는다(가운데든 꼭대기 0 이든)
//
// 왜 헤드리스 크롬 + DevTools 프로토콜인가:
//  판정의 몸통이 IntersectionObserver 와 실제 스크롤 위치다. 이 레포의 다른 런타임 테스트가 쓰는 `--headless=old --dump-dom`
//  에서는 **관찰자가 한 번도 안 불린다**(실측 2026-09-19: rAF 도 IO 도 0회 — 렌더 단계가 안 돈다). 거기서 이 테스트를 돌리면
//  «아무것도 안 불렀다» 는 판정이 전부 거짓 초록이 된다. 그래서 `--headless=new` 를 원격 디버깅으로 몰고, 스크롤은
//  Input.dispatchMouseEvent(mouseWheel) — 사람의 휠과 같은 입력 — 으로 낸다. W1(관찰자가 실제로 불린다)이 그 전제를 잰다.
//
// 대상은 web/lib/older-autoload.ts **그 파일 자체**다(컴파일해 페이지에 싣는다). 가짜는 «서버» 쪽뿐 — 부르면 일정 지연 뒤
//  위에 항목 n 개를 끼우고 표지를 새로 그린다(web/session-chat.ts loadOlder 와 같은 순서: 끼우기 → olderBar → watch).
// 크롬이 없는 면에서는 조용히 건너뛴다(종료코드 0).
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 건너뜁니다(CHROME_BIN 으로 지정) — 런타임 자동 불러오기 검증 미실행"); process.exit(0); }
if (typeof WebSocket !== "function") { console.log("skip  이 node 에 WebSocket 이 없어 건너뜁니다(node 22+)"); process.exit(0); }

const dir = mkdtempSync(path.join(tmpdir(), "older-rt-"));
execFileSync(path.join(ROOT, "node_modules/.bin/tsc"),
  [path.join(ROOT, "web/lib/older-autoload.ts"), "--outDir", dir, "--module", "esnext", "--target", "es2022", "--lib", "es2022,dom", "--skipLibCheck"],
  { stdio: "inherit" });
//  file:// 에서는 ES 모듈을 못 읽는다(출처 null) — export 만 떼어 클래식 스크립트로 싣는다.
const LIB = readFileSync(path.join(dir, "older-autoload.js"), "utf8").replace(/^export /gm, "");

const SC_H = 400, ITEM_H = 60;
const PAGE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0} body{padding:40px}
/* web/styles 35-liv.css .livc-list 와 같은 뼈대 — 아래에서 쌓이는 flex 열, 첫 자식이 남는 공백을 위로 민다 */
#sc{position:relative;height:${SC_H}px;width:360px;overflow:auto;display:flex;flex-direction:column;padding:20px 22px 8px;box-sizing:border-box}
#sc > :first-child{margin-top:auto}
.it{flex:none;height:${ITEM_H}px;box-sizing:border-box;border-bottom:1px solid #ccc}
.bar{flex:none;height:32px}
</style><pre id="out"></pre><script>${LIB}</script><script>
var T = (function () {
  var H = null;
  function item(i) { var d = document.createElement('div'); d.className = 'it'; d.setAttribute('data-i', i); d.textContent = '#' + i; return d; }
  function mk(o) {
    if (H && H.loader) H.loader.destroy();
    var old = document.getElementById('sc'); if (old) old.remove();
    var sc = document.createElement('div'); sc.id = 'sc'; if (o.hidden) sc.style.display = 'none';
    document.body.insertBefore(sc, document.getElementById('out'));
    H = { sc: sc, o: o, calls: 0, inflight: 0, maxInflight: 0, callTops: [], lowest: o.total - o.initial, bar: null, loader: null, failing: !!o.failing, stalls: o.stalls || 0 };
    for (var i = H.lowest; i < o.total; i++) sc.appendChild(item(i));
    if (H.lowest > 0) { H.bar = mkBar(); sc.prepend(H.bar); }
    // 자리부터 잡고 나서 지켜본다 — 로더가 보는 첫 상태가 시나리오의 상태여야 한다
    if (!o.hidden) {
      if (o.start === 'bottom') sc.scrollTop = sc.scrollHeight;
      else if (o.start === 'top') sc.scrollTop = 0;
      else if (typeof o.start === 'number') sc.scrollTop = barEdge() + o.start;   // 표지 아랫변에서 o.start px 아래가 화면 윗변
    }
    H.loader = olderLoader(sc, load);
    H.loader.watch(H.bar);
    return snap();
  }
  function mkBar() { var b = document.createElement('div'); b.className = 'bar'; b.textContent = '불러오는 중…'; return b; }
  function barEdge() { return H.bar ? H.bar.offsetTop + H.bar.offsetHeight : 0; }
  function placeBar() {
    if (H.bar) H.bar.remove();
    if (H.lowest <= 0) { H.bar = null; H.loader.watch(null); return; }
    H.bar = mkBar(); H.sc.prepend(H.bar); H.loader.watch(H.bar);
  }
  function load() {
    var h = H;
    h.calls++; h.inflight++; h.maxInflight = Math.max(h.maxInflight, h.inflight); h.callTops.push(Math.round(h.sc.scrollTop));
    return new Promise(function (res) {
      setTimeout(function () {
        if (h.failing) { h.inflight--; res(false); return; }
        if (h.stalls > 0) { h.stalls--; h.inflight--; res(true); return; }   // 서버가 제자리 응답 — 붙인 것 없이 같은 표지로 성공
        var n = Math.min(h.o.chunk, h.lowest);
        prependKeepingView(h.sc, function () {
          for (var k = 0; k < n; k++) { h.lowest--; h.sc.insertBefore(item(h.lowest), h.bar ? h.bar.nextSibling : h.sc.firstChild); }
          placeBar();
        });
        if (h.o.lateMs) setTimeout(function () { h.inflight--; res(true); }, h.o.lateMs);   // 표지를 바꾼 뒤에도 한참 더 돈다
        else { h.inflight--; res(true); }
      }, h.o.latency || 60);
    });
  }
  function firstVisible() {
    var top = H.sc.getBoundingClientRect().top, its = H.sc.querySelectorAll('.it');
    for (var k = 0; k < its.length; k++) if (its[k].getBoundingClientRect().top >= top) return +its[k].getAttribute('data-i');
    return -1;
  }
  function topOf(i) { var e = H.sc.querySelector('[data-i="' + i + '"]'); return e ? e.getBoundingClientRect().top - H.sc.getBoundingClientRect().top : null; }
  function snap() {
    return { calls: H.calls, maxInflight: H.maxInflight, callTops: H.callTops.slice(), scrollTop: Math.round(H.sc.scrollTop), scrollH: H.sc.scrollHeight,
      lowest: H.lowest, bar: !!H.bar, barDist: H.bar ? Math.round(H.sc.scrollTop - barEdge()) : null, first: firstVisible() };
  }
  function ioProbe() {
    return new Promise(function (res) {
      var box = document.createElement('div'); box.style.cssText = 'height:10px'; document.body.append(box);
      var io = new IntersectionObserver(function () { io.disconnect(); box.remove(); res(true); });
      io.observe(box); setTimeout(function () { res(false); }, 1500);
    });
  }
  return {
    mk: mk, snap: snap, firstVisible: firstVisible, topOf: topOf, ioProbe: ioProbe,
    scrollTo: function (v) { H.sc.scrollTop = v === 'bottom' ? H.sc.scrollHeight : v; return snap(); },
    hide: function (b) { H.sc.style.display = b ? 'none' : 'flex'; return snap(); },
    fail: function (b) { H.failing = b; },
    retry: function () { H.loader.retry(); },
    destroy: function () { H.loader.destroy(); },
    center: function () { var r = H.sc.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; },
  };
})();
</script>`;
writeFileSync(path.join(dir, "page.html"), PAGE);

// ── 크롬 + DevTools 프로토콜 ──────────────────────────────────────────────────
const proc = spawn(chrome, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--use-mock-keychain", "--password-store=basic",   // 맥 세션에서 키체인 모달이 사람 화면에 뜨지 않게(scripts/headless-chrome.mjs 와 같은 이유)
  "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps", "--disable-extensions",
  "--mute-audio", "--no-pings", "--disable-breakpad", "--disable-crash-reporter",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
  "--window-size=900,800", `--user-data-dir=${path.join(dir, "profile")}`, "--remote-debugging-port=0",
  `file://${path.join(dir, "page.html")}`,
], { env: { ...process.env, HOME: dir }, stdio: ["ignore", "ignore", "pipe"] });
const closed = new Promise((r) => proc.once("close", r));
let pass = 0, fail = 0;
const ok = (cond, label, detail) => { if (cond) { pass++; console.log("ok   " + label); } else { fail++; console.log("FAIL " + label + "  ← " + detail); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws = null;
try {
  const wsUrl = await new Promise((resolve, reject) => {
    let err = "";
    const t = setTimeout(() => reject(new Error("크롬이 20초 안에 디버깅 주소를 안 냈다\n" + err.slice(0, 600))), 20_000);
    proc.stderr.on("data", (b) => { err += b; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
    proc.on("error", reject);
  });
  const port = new URL(wsUrl).port;
  let page = null;
  for (let i = 0; i < 50 && !page; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = list.find((t) => t.type === "page" && String(t.url).startsWith("file:"));
    if (!page) await sleep(100);
  }
  if (!page) throw new Error("페이지 대상을 못 찾았다");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let seq = 0; const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expr) => {
    const d = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (d.result?.exceptionDetails) throw new Error("페이지 오류: " + JSON.stringify(d.result.exceptionDetails).slice(0, 400));
    return d.result?.result?.value;
  };
  for (let i = 0; i < 50; i++) { if (await ev("typeof T === 'object' && typeof olderLoader === 'function'")) break; await sleep(100); }
  const wheel = async (dy) => {
    const c = await ev("T.center()");
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: c.x, y: c.y, deltaX: 0, deltaY: dy });
  };
  const S = () => ev("T.snap()");
  /** 조건이 설 때까지(상한 ms) — 고정 대기 대신. 상한에 걸리면 그 순간의 상태로 판정한다(판정은 호출자가). */
  const until = async (pred, maxMs) => { const t0 = Date.now(); let v = await S(); while (!pred(v) && Date.now() - t0 < maxMs) { await sleep(80); v = await S(); } return v; };
  /** calls 가 quietMs 동안 안 바뀔 때까지 — «더 안 부른다» 를 재는 자리. */
  const settle = async (quietMs, maxMs) => { const t0 = Date.now(); let v = await S(), at = Date.now(); while (Date.now() - t0 < maxMs) { await sleep(80); const n = await S(); if (n.calls !== v.calls) at = Date.now(); v = n; if (Date.now() - at >= quietMs) break; } return v; };
  const BIG = { total: 400, initial: 60, chunk: 20 };          // 60줄 = 3600px — 바닥에서 표지는 한참 위
  const TINY = { total: 400, initial: 3, chunk: 4 };           // 화면을 못 채운다

  // ── W) 배선 — 관측 장치가 살아 있나 ────────────────────────────────────────
  ok(await ev("T.ioProbe()") === true, "W1 이 크롬에서 IntersectionObserver 가 실제로 불린다(안 불리면 아래 «0번» 판정이 전부 거짓 초록)", "관찰자 콜백 0회");
  await ev(`T.mk(${JSON.stringify({ ...BIG, start: "bottom" })})`);
  const w0 = (await S()).scrollTop; await wheel(-300); await sleep(400); const w1 = (await S()).scrollTop;
  ok(w1 < w0, "W2 휠 입력이 실제로 목록을 올린다", `scrollTop ${w0} → ${w1}`);

  // ── S2 · 경계 S1b/S2b — 언제 부르나 ─────────────────────────────────────
  await ev(`T.mk(${JSON.stringify({ ...BIG, start: "bottom" })})`); await sleep(500);
  let s = await S();
  ok(s.calls === 0, "S2 바닥에서 읽는 중(표지가 멀다)엔 안 부른다", `calls=${s.calls} barDist=${s.barDist}`);
  await ev(`T.mk(${JSON.stringify({ ...BIG, start: Math.round(SC_H * 1.9), latency: 2000 })})`); await sleep(500);
  s = await S();
  ok(s.calls === 1, "S1b 경계 — 표지가 화면 위 1.9장 거리면 부른다(누르지 않아도)", `calls=${s.calls} barDist=${s.barDist}`);
  await ev(`T.mk(${JSON.stringify({ ...BIG, start: Math.round(SC_H * 2.1), latency: 2000 })})`); await sleep(500);
  s = await S();
  ok(s.calls === 0, "S2b 경계 — 2.1장 거리면 아직 안 부른다", `calls=${s.calls} barDist=${s.barDist}`);

  // ── S1w — 사람의 휠로: 꼭대기에 닿기 전에 불렀고, 이음새를 지나 계속 올라간다 ───────────
  await ev(`T.mk(${JSON.stringify({ ...BIG, start: "bottom", latency: 120 })})`);
  for (let i = 0; i < 60 && (await S()).calls === 0; i++) { await wheel(-240); await sleep(50); }
  s = await S();
  ok(s.calls >= 1 && s.callTops[0] > 0, "S1w 휠로 올리면 꼭대기(0)에 닿기 전에 부른다", `calls=${s.calls} 부른 순간 scrollTop=${s.callTops[0]}`);
  for (let i = 0; i < 30; i++) { await wheel(-240); await sleep(50); }
  await sleep(300); s = await S();
  ok(s.first >= 0 && s.first < 340, "S1w 이음새(처음 열린 창의 맨 윗줄 #340)를 지나 더 옛 줄까지 계속 올라간다", `지금 맨 윗줄 #${s.first} · calls=${s.calls}`);
  ok(s.maxInflight === 1, "S5 한 번에 하나만 돈다(휠)", `maxInflight=${s.maxInflight}`);

  // ── S3 · S4 — 화면이 찰 때까지 이어서, 처음에 닿으면 멈춤 ────────────────────
  await ev(`T.mk(${JSON.stringify({ ...TINY, start: "bottom" })})`);
  s = await settle(600, 6000);
  const s3a = s.calls; await sleep(400); const s3b = (await S()).calls;
  ok(s.calls >= 3 && (s.barDist === null || s.barDist >= SC_H * 2 - 2), "S3 붙인 뒤에도 그 거리 안이면 이어서 부른다 — 표지가 두 장 밖으로 나갈 때까지",
    `calls=${s.calls} barDist=${s.barDist}`);
  ok(s3a === s3b, "S3 두 장 밖으로 나가면 멈춘다(더 안 부른다)", `${s3a} → ${s3b}`);
  ok(s.maxInflight === 1, "S5 한 번에 하나만 돈다(연쇄)", `maxInflight=${s.maxInflight}`);
  await ev(`T.mk(${JSON.stringify({ total: 10, initial: 2, chunk: 3, start: "bottom" })})`);
  s = await until((v) => v.lowest === 0, 4000); const s4 = s.calls; await sleep(400);
  ok(s.lowest === 0 && !s.bar && s4 === 3 && (await S()).calls === 3, "S4 처음에 닿으면(표지 없음) 더 안 부른다 — 8줄을 3줄씩 = 정확히 3번", `calls=${s.calls} lowest=${s.lowest} bar=${s.bar}`);

  // ── S6 · S7 · S8 — 실패 ─────────────────────────────────────────────────
  await ev(`T.mk(${JSON.stringify({ ...BIG, start: "top", failing: true })})`); await sleep(700);
  s = await S();
  ok(s.calls === 1, "S6 실패하면 그 자리에 머물러도 다시 안 부른다(폭주 금지)", `calls=${s.calls}`);
  await ev("T.scrollTo('bottom')"); await sleep(300); await ev("T.scrollTo(0)"); await sleep(500);
  s = await S();
  ok(s.calls === 2, "S7 그 자리를 떠났다 돌아오면 한 번 다시 부른다", `calls=${s.calls}`);
  await ev("T.retry()"); await sleep(300);
  s = await S();
  ok(s.calls === 3, "S8 [다시 시도] 는 곧바로 부른다", `calls=${s.calls}`);
  ok(s.maxInflight === 1, "S5 한 번에 하나만 돈다(실패)", `maxInflight=${s.maxInflight}`);

  // ── S9 — 가려진 목록 ─────────────────────────────────────────────────────
  await ev(`T.mk(${JSON.stringify({ ...BIG, start: "top", hidden: true })})`); await sleep(500);
  s = await S();
  ok(s.calls === 0, "S9 목록이 가려져 있으면(터미널 보기) 안 부른다", `calls=${s.calls}`);
  await ev("T.hide(false)"); await ev("T.scrollTo(0)"); await sleep(500);
  s = await S();
  ok(s.calls >= 1, "S9 다시 보이면 부른다", `calls=${s.calls}`);

  // ── S10 — 보던 자리 ─────────────────────────────────────────────────────
  for (const [id, start, desc] of [["S10a", Math.round(SC_H * 0.5), "가운데(표지가 화면 반 장 위)"], ["S10b", "top", "꼭대기(scrollTop 0)"]]) {
    await ev(`T.mk(${JSON.stringify({ ...BIG, start, latency: 250 })})`);
    const f = await ev("T.firstVisible()"); const before = await ev(`T.topOf(${f})`);
    await sleep(900);
    s = await S(); const after = await ev(`T.topOf(${f})`);
    ok(s.calls >= 1 && before !== null && after !== null && Math.abs(after - before) <= 1,
      `${id} 위에 끼우는 동안 보던 줄(#${f})이 제자리 — ${desc}`, `before=${before} after=${after} calls=${s.calls} scrollTop=${s.scrollTop}`);
  }

  // ── S11 — 도는 중에 표지가 바뀜 ─────────────────────────────────────────
  await ev(`T.mk(${JSON.stringify({ ...TINY, start: "bottom", lateMs: 250 })})`);
  s = await until((v) => v.calls >= 3, 6000);
  ok(s.calls >= 3, "S11 표지를 새로 그린 뒤에도 한참 더 도는 로드 — 끝나면 새 표지로 이어 간다(멈추지 않는다)", `calls=${s.calls} barDist=${s.barDist}`);
  ok(s.maxInflight === 1, "S5 한 번에 하나만 돈다(표지가 도는 중에 바뀜)", `maxInflight=${s.maxInflight}`);

  // ── S13 — 서버가 제자리 응답(같은 표지로 성공) ───────────────────────────
  await ev(`T.mk(${JSON.stringify({ ...BIG, start: "top", stalls: 2 })})`);
  s = await until((v) => v.calls >= 3 && v.lowest < 340, 4000);
  ok(s.calls >= 3 && s.lowest < 340, "S13 제자리 응답(붙인 것 없이 같은 표지) 뒤에도 다시 묻고 이어 간다 — 두 번 막히고 세 번째에 붙는다", `calls=${s.calls} lowest=${s.lowest}`);

  // ── S12 — 치운 뒤 ───────────────────────────────────────────────────────
  await ev(`T.mk(${JSON.stringify({ ...BIG, start: "bottom" })})`); await ev("T.destroy()"); await ev("T.scrollTo(0)"); await sleep(500);
  s = await S();
  ok(s.calls === 0, "S12 destroy() 뒤에는 안 부른다", `calls=${s.calls}`);
  //  도는 중에 치웠다(세션 화면을 닫음) — 늦게 끝난 로드가 표지를 새로 그려 watch 를 불러도 다시 걸리지 않는다
  //   (chunk 2 = 120px — 붙인 뒤에도 새 표지가 부르는 거리 안에 남게 해야 «다시 걸렸다면 불렀을» 상황이 된다)
  await ev(`T.mk(${JSON.stringify({ ...BIG, chunk: 2, start: "top", latency: 300 })})`); await sleep(120); await ev("T.destroy()"); await sleep(900);
  s = await S();
  ok(s.calls === 1, "S12b 도는 중에 destroy() — 끝난 로드가 새 표지를 걸어도 더 안 부른다", `calls=${s.calls} lowest=${s.lowest}`);
} catch (e) {
  fail++; console.log("FAIL 하네스가 끝까지 못 갔다 — " + (e?.message || e));
} finally {
  try { ws?.close(); } catch { /* 이미 닫혔다 */ }
  try { proc.kill("SIGKILL"); } catch { /* 이미 끝났다 */ }
  await Promise.race([closed, sleep(3000)]);
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) { console.log(`note  임시 디렉터리를 못 지웠습니다(${e.code}) — ${dir}`); }
}
console.log(`\n${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);

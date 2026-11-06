// #5398 — codex 실시간 층(web/session-codex-live.ts)도 **그 세션 화면이 보일 때만** 스트림을 쥐고, 다시 붙을 때(hello) 따라잡는다.
//  실행으로 잰다: 컴파일된 public/app 모듈 + 가짜 브라우저(문서 보임 · IntersectionObserver · ResizeObserver · 최소 DOM · fetch 스트림).
//
//  왜: 평문 http(HTTP/1.1)는 같은 주소에 연결이 6개뿐이고 모든 탭이 함께 쓴다. codex 세션 화면은 세션 상태 통로 말고도
//   이 층의 스트림(/codex-chat/events)을 하나 더 쥔다 — 숨은 화면이 쥐고 있으면 새로 연 세션이 «연결 준비 중…» 에 선다.
//   세션 상태 통로(session-events.ts)는 scripts/session-stream-shown.test.mjs 가 잰다. 이 파일은 같은 규칙의 codex 판이다.
//
//  사양 표(행마다 시험 하나 이상):
//   K1  보이는 화면 → 연결 1                         K2  문서가 숨으면 → 0 · 숨은 동안 다시 안 붙음
//   K3  다시 보이면 → 백오프 없이 곧바로 붙음          K4  셸이 화면을 숨기면(상자 없음) → 0 · 다시 보이면 곧바로 1
//   K5  hello 마다 글자 미리보기를 걷고 파일을 읽게 한다(poke) — 끊긴 동안의 조각을 이어 붙이지 않는다
//   K6  hello.approvals(지금 걸린 승인 전부)에 없는 카드는 접고, 답을 보내는 중인 카드는 남긴다
//   K7  hello 에 approvals 칸이 없으면(옛 서버) 카드를 하나도 안 접는다
//   K8  백오프 도중 숨었다 다시 보이면 남은 백오프를 기다리지 않는다
//   K9  숨김 · 다시 보임이 한 틱에 와도 곧바로 다시 붙는다
//   K10 화면을 닫으면 연결 0 · 그 뒤 보임이 바뀌어도 요청 0 · 듣개와 관찰이 남지 않는다
//  수정 전 코드로 빨강을 보려면 CODEX_LIVE_JS 로 대상 모듈을 갈아 끼운다.
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_JS = process.env.CODEX_LIVE_JS || join(root, "public/app/session-codex-live.js");
let pass = 0;
const SOFT = process.env.SOFT_FAIL === "1";
let fails = 0;
const fail = (e) => { if (!SOFT) throw e; fails++; console.log(`not ok  ${e.message.split("\n")[0]}`); };
const ok = (cond, name, detail) => { try { assert.ok(cond, detail ? `${name}\n  ${detail}` : name); pass++; console.log(`ok  ${name}`); } catch (e) { fail(e); } };
const eq = (got, want, name) => { try { assert.deepEqual(got, want, `${name}\n  기대 ${JSON.stringify(want)}\n  실제 ${JSON.stringify(got)}`); pass++; console.log(`ok  ${name}`); } catch (e) { fail(e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return Date.now() - t0; await sleep(5); }
  return fn() ? Date.now() - t0 : -1;
}

// ── 최소 DOM — el()(web/lib/dom.ts)이 쓰는 만큼 ───────────────────────────────────
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.nodeType = 1; this.children = []; this.parentElement = null;
    this.attrs = new Map(); this._text = ""; this.listeners = {}; this.dataset = {}; this.hidden = false; this.className = ""; this.style = {};
    const self = this;
    this.classList = {
      add: (...c) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); self.className = [...s].join(" "); },
      remove: (...c) => { self.className = self.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(" "); },
      contains: (c) => self.className.split(/\s+/).includes(c),
      toggle: (c, on) => { const has = self.classList.contains(c); const want = on === undefined ? !has : !!on; if (want && !has) self.classList.add(c); if (!want && has) self.classList.remove(c); return want; },
    };
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { for (const c of this.children) c.parentElement = null; this.children = []; this._text = String(v); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); if (k === "hidden") this.hidden = true; if (k === "class") this.className = String(v); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); if (k === "hidden") this.hidden = false; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  append(...ns) { for (const n of ns) { if (n == null) continue; if (n.parentElement) n.remove(); n.parentElement = this; this.children.push(n); } }
  insertBefore(n, ref) { if (n.parentElement) n.remove(); n.parentElement = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); }
  remove() { const p = this.parentElement; if (!p) return; p.children = p.children.filter((c) => c !== this); this.parentElement = null; }
  replaceChildren(...ns) { for (const c of this.children) c.parentElement = null; this.children = []; this._text = ""; this.append(...ns); }
  querySelectorAll(sel) {
    const cls = sel.startsWith(".") ? sel.slice(1) : null;
    const out = [];
    const walk = (n) => { for (const c of n.children || []) { if (c.nodeType === 1 && cls && c.classList.contains(cls)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
class FakeText { constructor(s) { this.nodeType = 3; this.textContent = String(s); this.parentElement = null; this.children = []; }
  remove() { const p = this.parentElement; if (!p) return; p.children = p.children.filter((c) => c !== this); this.parentElement = null; } }

// ── 가짜 브라우저 ──────────────────────────────────────────────────────────────
const store = new Map([["lively_ui_token", "tok"]]);
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const docL = new Map();
const doc = {
  visibilityState: "visible",
  get hidden() { return this.visibilityState === "hidden"; },
  addEventListener(t, fn) { if (!docL.has(t)) docL.set(t, new Set()); docL.get(t).add(fn); },
  removeEventListener(t, fn) { docL.get(t)?.delete(fn); },
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (s) => new FakeText(s),
};
globalThis.document = doc;
globalThis.window = globalThis;
globalThis.location = { origin: "http://x", pathname: "/ui/", search: "", hash: "", protocol: "http:" };
function setDocHidden(h) { doc.visibilityState = h ? "hidden" : "visible"; for (const fn of [...(docL.get("visibilitychange") ?? [])]) fn(); }
const visListeners = () => docL.get("visibilitychange")?.size ?? 0;

const observers = new Set();
class FakeObs {
  constructor(cb) { this.cb = cb; this.targets = new Set(); observers.add(this); }
  observe(t) { this.targets.add(t); }
  unobserve(t) { this.targets.delete(t); }
  disconnect() { this.targets.clear(); observers.delete(this); }
}
globalThis.IntersectionObserver = class extends FakeObs {};
globalThis.ResizeObserver = class extends FakeObs {};
function screen(rendered = true) { return { isConnected: true, rendered, getClientRects() { return this.rendered ? [{ width: 1, height: 1 }] : []; } }; }
function setRendered(el, r) { el.rendered = r; for (const o of [...observers]) if (o.targets.has(el)) o.cb([{ target: el, isIntersecting: r }]); }

//  fetch — codex 통로는 끊을 때까지 열린 스트림이다. 붙을 때마다 서버처럼 hello 를 먼저 준다(시험이 그 모양을 정한다).
const open = new Map();
const requests = [];
let seq = 0;
let helloNext = () => ({ kind: "hello", running: false, approvals: [] });
const enc = new TextEncoder();
globalThis.fetch = async (url, init = {}) => {
  if (!/\/codex-chat\/events(\?|$)/.test(String(url))) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  const id = ++seq;
  requests.push(String(url));
  const signal = init.signal;
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  let ctrl;
  const body = new ReadableStream({ start(c) { ctrl = c; } });
  const entry = { push: (ev) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`)), end: () => { open.delete(id); try { ctrl.close(); } catch { /* 닫힘 */ } } };
  open.set(id, entry);
  signal?.addEventListener("abort", () => { open.delete(id); try { ctrl.error(new DOMException("aborted", "AbortError")); } catch { /* 닫힘 */ } });
  queueMicrotask(() => { try { entry.push(helloNext()); } catch { /* 닫힘 */ } });
  return { ok: true, status: 200, body };
};
const last = () => [...open.values()].at(-1);

const { mountCodexLive } = await import(pathToFileURL(LIVE_JS).href);

/** 화면 한 벌을 붙인다. */
function mount(anchor) {
  const list = new FakeNode("div");
  const dock = new FakeNode("div");
  const st = { pokes: 0, states: [] };
  const live = mountCodexLive({
    sessionId: "cx", view: { list, scroll() {} }, dock, liveTurn: () => null,
    poke: () => { st.pokes++; }, onState: (s) => st.states.push(s), onSettled: () => {}, anchor,
  });
  return { live, list, dock, st };
}

// ── 배선 ─────────────────────────────────────────────────────────────────────
{
  const a = screen(true);
  const m = mount(a);
  ok((await until(() => open.size === 1)) >= 0, "배선: 가짜 fetch 가 codex 통로 요청을 받아 연결 하나를 쥔다");
  ok(/\/api\/ui\/terminal\/sessions\/cx\/codex-chat\/events/.test(requests.at(-1)), "배선: 요청 주소가 그 세션의 codex 통로다", requests.at(-1));
  m.live.destroy();
  ok((await until(() => open.size === 0, 300)) >= 0, "배선: 화면을 닫으면 쥔 연결이 풀린다");
}

// ── K1 · K2 · K3 — 브라우저 탭이 숨었다 돌아온다 ────────────────────────────────
{
  const a = screen(true);
  const m = mount(a);
  ok((await until(() => open.size === 1)) >= 0, "K1 보이는 화면 → 연결 1");
  setDocHidden(true);
  ok((await until(() => open.size === 0, 300)) >= 0, "K2★ 문서가 숨으면 codex 통로도 놓는다", `열린 연결 ${open.size}`);
  const before = requests.length;
  await sleep(300);
  eq(requests.length - before, 0, "K2 숨은 동안은 다시 붙지 않는다");
  setDocHidden(false);
  const ms = await until(() => open.size === 1, 900);
  ok(ms >= 0 && ms < 400, "K3 다시 보이면 백오프 없이 곧바로 붙는다", `걸린 시간 ${ms}ms`);
  m.live.destroy();
  await sleep(30);
}

// ── K4 — 셸이 세션 화면을 숨겼다 다시 보인다(문서는 보이는 채) ────────────────────────
{
  const a = screen(true);
  const m = mount(a);
  await until(() => open.size === 1);
  setRendered(a, false);
  ok((await until(() => open.size === 0, 300)) >= 0, "K4★ 셸이 그 세션 화면을 숨기면 문서가 보이는 채로도 놓는다", `열린 연결 ${open.size}`);
  setRendered(a, true);
  const ms = await until(() => open.size === 1, 900);
  ok(ms >= 0 && ms < 400, "K4 그 화면이 다시 보이면 곧바로 붙는다", `걸린 시간 ${ms}ms`);
  m.live.destroy();
  await sleep(30);
}

// ── K5 · K6 · K7 — hello 의 따라잡기 ────────────────────────────────────────────
{
  const a = screen(true);
  const m = mount(a);
  await until(() => open.size === 1);
  await sleep(30);
  //  K5 — 턴 도중 글자 조각이 미리보기에 쌓였다.
  last().push({ kind: "status", running: true });
  last().push({ kind: "delta", text: "앞부분 글자" });
  await until(() => m.list.querySelectorAll(".cxl-typing").length === 1, 300);
  eq(m.list.querySelectorAll(".cxl-typing").length, 1, "K5(배선) 글자 조각이 미리보기로 그려졌다");
  //  K6 — 승인 둘이 걸렸고, 그중 B 는 사람이 답을 보내는 중이다.
  last().push({ kind: "approval", id: "A", title: "명령을 실행할까요?", detail: "ls", kindHint: "command" });
  last().push({ kind: "approval", id: "B", title: "파일을 고칠까요?", detail: "a.ts", kindHint: "patch" });
  await until(() => m.live.waiting() === 2, 300);
  eq(m.live.waiting(), 2, "K6(배선) 승인 카드 둘이 섰다");
  const cardB = m.dock.querySelectorAll(".cxl-ask").find((c) => c.getAttribute("aria-label") === "파일을 고칠까요?");
  cardB.classList.add("is-busy");          // 답을 보내는 중(answer() 가 하는 일)
  //  숨었다 돌아온다 — 그사이 서버에선 A 도 B 도 닫혔다(다시 붙을 때 hello 의 걸린 목록은 빈 목록).
  const pokes0 = m.st.pokes;
  helloNext = () => ({ kind: "hello", running: true, approvals: [] });
  setDocHidden(true);
  await until(() => open.size === 0, 300);
  setDocHidden(false);
  await until(() => open.size === 1, 900);
  await sleep(50);
  eq(m.list.querySelectorAll(".cxl-typing").length, 0, "K5★ 다시 붙으면(hello) 끊긴 동안 못 받은 조각 앞의 미리보기를 걷는다 — 앞뒤가 빠진 글을 잇지 않는다");
  ok(m.st.pokes > pokes0, "K5 hello 에 파일을 지금 읽게 한다(poke) — 그동안 떨어진 완성본을 따라잡는다", `poke ${pokes0}→${m.st.pokes}`);
  const cardA = m.dock.querySelectorAll(".cxl-ask").find((c) => c.getAttribute("aria-label") === "명령을 실행할까요?");
  ok(!!cardA && cardA.classList.contains("is-done"), "K6★ hello 의 걸린 목록에 없는 승인(A)은 «닫힘» 으로 접는다 — 끊긴 동안 닫혔다");
  ok(!cardB.classList.contains("is-done"), "K6 답을 보내는 중인 카드(B)는 목록에 없어도 건드리지 않는다(고른 라벨을 «닫힘» 으로 덮지 않는다)");
  eq(m.live.waiting(), 1, "K6 기다리는 승인 수가 접은 만큼 준다(머리줄 배지가 읽는 값)");
  //  K7 — 옛 서버: hello 에 approvals 칸이 없다. 새 승인 C 를 세우고 다시 붙는다.
  last().push({ kind: "approval", id: "C", title: "권한을 허용할까요?", detail: "x", kindHint: "permission" });
  await until(() => m.live.waiting() === 2, 300);
  helloNext = () => ({ kind: "hello", running: false });
  setRendered(a, false);
  await until(() => open.size === 0, 300);
  setRendered(a, true);
  await until(() => open.size === 1, 900);
  await sleep(50);
  const cardC = m.dock.querySelectorAll(".cxl-ask").find((c) => c.getAttribute("aria-label") === "권한을 허용할까요?");
  ok(!!cardC && !cardC.classList.contains("is-done"), "K7 hello 에 걸린 목록이 없으면(옛 서버) 카드를 접지 않는다 — 모르면 지우지 않는다");
  m.live.destroy();
  helloNext = () => ({ kind: "hello", running: false, approvals: [] });
  await sleep(30);
}

// ── K8 — 백오프 도중 숨었다 다시 보이면 기다리지 않는다 ─────────────────────────────
{
  const a = screen(true);
  const m = mount(a);
  await until(() => open.size === 1);
  last().end();                            // 서버가 닫았다 — 보이는 채라 백오프(1초)에 든다
  await sleep(150);
  setDocHidden(true);
  await sleep(50);
  setDocHidden(false);
  const ms = await until(() => open.size === 1, 1500);
  ok(ms >= 0 && ms < 400, "K8★ 백오프 도중 숨었다 다시 보이면 남은 백오프를 기다리지 않고 곧바로 붙는다", `다시 보인 뒤 ${ms}ms`);
  m.live.destroy();
  await sleep(30);
}

// ── K9 — 숨김과 다시 보임이 한 틱에 ───────────────────────────────────────────────
{
  const a = screen(true);
  const m = mount(a);
  await until(() => open.size === 1);
  const before = requests.length;
  setDocHidden(true);
  setDocHidden(false);
  const ms = await until(() => open.size === 1 && requests.length > before, 1500);
  ok(ms >= 0 && ms < 400, "K9 숨김 · 다시 보임이 한 틱에 와도 백오프 없이 곧바로 다시 붙는다", `걸린 시간 ${ms}ms`);
  m.live.destroy();
  await sleep(30);
}

// ── K10 — 화면을 닫는다 ─────────────────────────────────────────────────────────
{
  const baseL = visListeners();
  const a = screen(true);
  const m = mount(a);
  await until(() => open.size === 1);
  m.live.destroy();
  ok((await until(() => open.size === 0, 300)) >= 0, "K10 화면을 닫으면 연결을 놓는다");
  const before = requests.length;
  setDocHidden(true); setDocHidden(false);
  setRendered(a, false); setRendered(a, true);
  await sleep(200);
  eq([open.size, requests.length - before], [0, 0], "K10 닫힌 뒤엔 보임이 바뀌어도 다시 붙지 않는다");
  eq(visListeners(), baseL, "K10 닫힌 뒤엔 문서 듣개가 남지 않는다");
  ok(![...observers].some((o) => o.targets.has(a)), "K10 닫힌 뒤엔 요소 관찰(IO · RO)이 남지 않는다");
}

console.log(`\n${pass}건 통과${fails ? ` · ${fails}건 실패` : ""}`);
process.exit(fails ? 1 : 0);

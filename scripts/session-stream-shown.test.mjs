// #5398 — 세션 상태 통로는 **그 세션 화면이 보일 때만** 연결을 쥔다. 실행으로 잰다(컴파일된 public/app 모듈 + 가짜 브라우저).
//
//  왜(상민님 2026-11-02 신고): 평문 http(HTTP/1.1)에서 크롬은 같은 주소에 연결을 6개까지만 열고, 그 주소의 모든 탭이
//   이 한도를 함께 쓴다. 세션 화면마다 끊지 않는 스트림(/events)을 쥐고 있으면 새로 연 세션의 터미널 첫 요청(/api/ui/me)이
//   대기열에서 영영 안 나와 «연결 준비 중…» 에 선다. 스트림이 자리를 쥐는 경우는 둘이다 —
//   ① 브라우저 탭이 숨었다  ② 셸이 세션 화면을 숨겼다(왼쪽 목록에서 연 세션은 DOM 째로 남는다 — v2/tabs.ts).
//   ②는 브라우저 탭 하나로도 6개를 채운다.
//
//  사양 표(행마다 시험 하나 이상):
//   S1  보이는 구독 하나 → 연결 1                      S2  문서가 숨으면 → 연결 0 · 숨은 동안 다시 안 붙음
//   S3  문서가 다시 보이면 → 백오프 없이 곧바로 붙음    S4  셸이 화면을 숨기면(상자 없음, 문서는 보임) → 0
//   S5  그 화면이 다시 보이면 → 곧바로 붙음              S6  숨은 채 구독 → 요청 0 · 보이는 순간 붙음
//   S7  ★ 세션 8개 중 하나만 보임 → 연결 1 · 바꾸면 바뀐 세션 1   S8  같은 세션 구독 둘(숨김·보임) → 1 · 아무도 안 보면 0
//   S9  열린 동안 사건은 두 구독 모두에게              S10 보이는 구독이 떠나 숨은 구독만 남음 → 그 자리에서 0
//   S11 마지막 구독이 떠남 → 닫히고 되살아나지 않음    S12 화면 요소 없이 구독 → 문서만 본다
//   S13 보이는 채 서버가 닫음 → 백오프(곧바로 되묻지 않음)
//   S14 ★ 백오프 도중 숨었다 다시 보임 → 백오프를 기다리지 않고 곧바로 붙음(격리 리뷰 지적)
//   S15 숨김과 다시 보임이 한 틱에 → 1초 백오프 없이 곧바로 붙음
//   W1  isShown 판정 표 · W2 바뀔 때만 알림 · stop 뒤 듣개 0 · W3 IO 없음 · 문서 없음에서 안 던짐
//   W4  화면 밖에서 숨었다 다시 그려짐(IO 는 말이 없다) → RO 신호로 알아챔
//   A1–A6 다시 붙었을 때 접을 승인 카드 고르기(staleAskIds)
//  관측은 **가짜 fetch 가 쥔 열린 응답의 수**(= 브라우저가 쥔 연결)와 요청 기록으로 한다 — 문구가 아니라 부작용이다.
//  수정 전 코드로 빨강을 보려면 SESSION_EVENTS_JS 로 대상 모듈을 갈아 끼운다(그 모듈의 옛 서명대로 세 번째 인자는 무시된다).
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVENTS_JS = process.env.SESSION_EVENTS_JS || join(root, "public/app/session-events.js");
const SHOWN_JS = join(root, "public/app/lib/shown.js");
const SURFACE_JS = join(root, "public/app/session-surface-view.js");
let pass = 0;
//  SOFT_FAIL=1 — 첫 빨강에서 멈추지 않고 전부 적는다(수정 전 코드로 어느 행이 빨개지는지 한 번에 볼 때). 끝에 종료코드 1.
const SOFT = process.env.SOFT_FAIL === "1";
let fails = 0;
const fail = (e) => { if (!SOFT) throw e; fails++; console.log(`not ok  ${e.message.split("\n")[0]}`); };
const ok = (cond, name, detail) => { try { assert.ok(cond, detail ? `${name}\n  ${detail}` : name); pass++; console.log(`ok  ${name}`); } catch (e) { fail(e); } };
const eq = (got, want, name) => { try { assert.deepEqual(got, want, `${name}\n  기대 ${JSON.stringify(want)}\n  실제 ${JSON.stringify(got)}`); pass++; console.log(`ok  ${name}`); } catch (e) { fail(e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 조건이 설 때까지 기다린다(상한 ms). 섰으면 걸린 시간, 아니면 -1. */
async function until(fn, ms = 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return Date.now() - t0; await sleep(5); }
  return fn() ? Date.now() - t0 : -1;
}

// ── 가짜 브라우저 ──────────────────────────────────────────────────────────────
const store = new Map([["lively_ui_token", "tok"]]);   // 토큰만 있다(워크스페이스 표 등 다른 키는 없다)
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const docL = new Map();   // 이벤트 이름 → 듣개 집합
const doc = {
  visibilityState: "visible",
  get hidden() { return this.visibilityState === "hidden"; },
  addEventListener(t, fn) { if (!docL.has(t)) docL.set(t, new Set()); docL.get(t).add(fn); },
  removeEventListener(t, fn) { docL.get(t)?.delete(fn); },
};
globalThis.document = doc;
globalThis.window = globalThis;
globalThis.location = { origin: "http://x", pathname: "/ui/", search: "", hash: "", protocol: "http:" };
function setDocHidden(h) {
  doc.visibilityState = h ? "hidden" : "visible";
  for (const fn of [...(docL.get("visibilitychange") ?? [])]) fn();
}
const visListeners = () => docL.get("visibilitychange")?.size ?? 0;

//  IntersectionObserver — 시험이 요소의 상자를 켜고 끄면 그 요소를 지켜보는 관찰자에게 알린다(브라우저가 하는 일).
const observers = new Set();
class FakeIO {
  constructor(cb) { this.cb = cb; this.targets = new Set(); observers.add(this); }
  observe(t) { this.targets.add(t); }
  unobserve(t) { this.targets.delete(t); }
  disconnect() { this.targets.clear(); observers.delete(this); }
}
globalThis.IntersectionObserver = FakeIO;
//  ResizeObserver — 상자 크기가 바뀌면(0 ↔ 실제 크기) 알린다. 화면 안팎과 상관없다.
const resizers = new Set();
class FakeRO {
  constructor(cb) { this.cb = cb; this.targets = new Set(); resizers.add(this); }
  observe(t) { this.targets.add(t); }
  unobserve(t) { this.targets.delete(t); }
  disconnect() { this.targets.clear(); resizers.delete(this); }
}
globalThis.ResizeObserver = FakeRO;
/** 화면 밖에서 숨기거나 다시 그린다 — IO 는 «밖 → 밖» 이라 말이 없고 RO 만 알린다. */
function setRenderedOffscreen(el, r) {
  el.rendered = r;
  for (const ro of [...resizers]) if (ro.targets.has(el)) ro.cb([{ target: el }]);
}
/** 세션 화면의 바깥 틀 — rendered 가 거짓이면 상자가 없다(셸이 숨긴 탭: display:none 조상). */
function screen(rendered = true) { return { isConnected: true, rendered, getClientRects() { return this.rendered ? [{ width: 1, height: 1 }] : []; } }; }
function setRendered(el, r) {
  el.rendered = r;
  for (const io of [...observers]) if (io.targets.has(el)) io.cb([{ target: el, isIntersecting: r }]);
}

//  fetch — 세션 상태 통로(/events)의 응답 몸통은 끊을 때까지 열려 있는 스트림이다. 열린 것을 센다(= 브라우저가 쥔 연결).
//   그 밖의 요청(core.js 가 불러올 때 묻는 설정 등)은 곧바로 끝나는 평범한 응답이다 — 세지 않는다.
const open = new Map();   // 요청 번호 → { url, push, end }
const requests = [];      // /events 요청만
let seq = 0;
const enc = new TextEncoder();
globalThis.fetch = async (url, init = {}) => {
  if (!/\/events(\?|$)/.test(String(url))) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  const id = ++seq;
  requests.push(String(url));
  const signal = init.signal;
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  let ctrl;
  const body = new ReadableStream({ start(c) { ctrl = c; } });
  const entry = {
    url: String(url),
    push: (ev) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`)),
    end: () => { open.delete(id); try { ctrl.close(); } catch { /* 이미 닫힘 */ } },
  };
  open.set(id, entry);
  signal?.addEventListener("abort", () => { open.delete(id); try { ctrl.error(new DOMException("aborted", "AbortError")); } catch { /* 이미 닫힘 */ } });
  return { ok: true, status: 200, body };
};
const openSessions = () => [...open.values()].map((e) => decodeURIComponent(e.url.replace(/^.*\/sessions\//, "").replace(/\/events.*$/, ""))).sort();
const settle = () => sleep(30);

const { onSessionEvents } = await import(pathToFileURL(EVENTS_JS).href);
const { isShown, watchShown } = await import(pathToFileURL(SHOWN_JS).href);
const { staleAskIds } = await import(pathToFileURL(SURFACE_JS).href);

// ── 배선 — 관측 장치가 죽어 있으면 아래가 전부 헛통과다 ─────────────────────────
{
  const a = screen(true);
  const off = onSessionEvents("wire", () => {}, { anchor: a });
  ok((await until(() => open.size === 1)) >= 0, "배선: 가짜 fetch 가 세션 상태 통로 요청을 받아 연결 하나를 쥔다");
  ok(/\/api\/ui\/terminal\/sessions\/wire\/events(\?|$)/.test(requests.at(-1)), "배선: 요청 주소가 그 세션의 /events 다", requests.at(-1));
  off();
  ok((await until(() => open.size === 0, 300)) >= 0, "배선: 해지하면 쥔 연결이 풀린다(가짜 fetch 가 끊김을 본다)");
}

// ── S1 · S2 · S3 — 브라우저 탭이 숨었다 돌아온다 ─────────────────────────────────
{
  const a = screen(true);
  const off = onSessionEvents("s1", () => {}, { anchor: a });
  ok((await until(() => open.size === 1)) >= 0, "S1 보이는 세션 화면 하나 → 연결 1");
  setDocHidden(true);
  ok((await until(() => open.size === 0, 300)) >= 0, "S2★ 브라우저 탭이 숨으면 그 연결을 놓는다 — 같은 주소의 다른 탭이 쓸 자리를 비운다", `열린 연결 ${open.size}`);
  const before = requests.length;
  await sleep(300);
  eq(requests.length - before, 0, "S2 숨은 동안은 다시 붙지 않는다(백오프로 되붙어 자리를 다시 쥐지 않는다)");
  setDocHidden(false);
  const ms = await until(() => open.size === 1, 900);
  ok(ms >= 0 && ms < 500, "S3★ 다시 보이면 기다림 없이 곧바로 붙는다 — 사람이 지금 보고 있다", `걸린 시간 ${ms}ms(-1 = 900ms 안에 안 붙음)`);
  off();
  await settle();
}

// ── S4 · S5 — 셸이 세션 화면을 숨겼다 다시 보인다(문서는 내내 보인다) ────────────────
{
  const a = screen(true);
  const off = onSessionEvents("s4", () => {}, { anchor: a });
  await until(() => open.size === 1);
  setRendered(a, false);
  ok((await until(() => open.size === 0, 300)) >= 0, "S4★ 셸이 그 세션 화면을 숨기면(문서는 보이는 채) 연결을 놓는다 — 탭 하나로도 6개가 차는 자리다", `열린 연결 ${open.size}`);
  setRendered(a, true);
  const ms = await until(() => open.size === 1, 900);
  ok(ms >= 0 && ms < 500, "S5 그 화면이 다시 보이면 곧바로 붙는다", `걸린 시간 ${ms}ms`);
  off();
  await settle();
}

// ── S6 — 숨은 채로 구독 ──────────────────────────────────────────────────────────
{
  const a = screen(false);
  const before = requests.length;
  const off = onSessionEvents("s6", () => {}, { anchor: a });
  await sleep(150);
  eq(requests.length - before, 0, "S6 안 보이는 화면으로 구독하면 아직 붙지 않는다");
  setRendered(a, true);
  ok((await until(() => open.size === 1, 500)) >= 0, "S6 보이는 순간 붙는다");
  off();
  await settle();
}

// ── S7 — ★ 세션 8개를 열고 하나만 보인다 ─────────────────────────────────────────
{
  const ids = Array.from({ length: 8 }, (_, i) => `t${i}`);
  const screens = ids.map((_, i) => screen(i === 0));
  const offs = ids.map((id, i) => onSessionEvents(id, () => {}, { anchor: screens[i] }));
  await until(() => open.size >= 1);
  await sleep(100);
  eq(openSessions(), ["t0"], "S7★ 세션 8개를 열어도 보이는 세션 하나만 연결을 쥔다(종전: 8개 — HTTP/1.1 한도 6을 넘는다)");
  //  셸이 다른 세션을 켠다 — 보던 것은 숨고 새것이 보인다.
  setRendered(screens[0], false);
  setRendered(screens[5], true);
  await until(() => openSessions().join() === "t5", 500);
  eq(openSessions(), ["t5"], "S7 보이는 세션을 바꾸면 연결도 그 세션으로 옮겨 간다(여전히 1)");
  offs.forEach((f) => f());
  await settle();
}

// ── S8 · S9 · S10 · S11 — 같은 세션의 구독 둘 ─────────────────────────────────────
{
  const shown = screen(true);
  const hidden = screen(false);
  const gotA = [];
  const gotB = [];
  const offA = onSessionEvents("s8", (e) => gotA.push(e), { anchor: hidden });
  const offB = onSessionEvents("s8", (e) => gotB.push(e), { anchor: shown });
  await until(() => open.size === 1);
  await sleep(50);
  eq(open.size, 1, "S8 같은 세션의 구독 둘(숨김 하나 · 보임 하나) → 연결은 하나다(둘이 아니다)");
  [...open.values()][0].push({ t: "transcript.grew", size: 10 });
  await until(() => gotA.length && gotB.length, 300);
  eq([gotA.length, gotB.length], [1, 1], "S9 연결이 열려 있는 동안 사건은 두 구독 모두에게 간다");
  setRendered(shown, false);
  ok((await until(() => open.size === 0, 300)) >= 0, "S8 보이던 쪽이 숨어 아무도 안 보면 연결을 놓는다");
  setRendered(hidden, true);
  ok((await until(() => open.size === 1, 500)) >= 0, "S8 숨어 있던 쪽이 보이면 다시 붙는다");
  //  S10 — 지금 보이는 구독(A)을 해지하고 숨은 구독(B)만 남긴다.
  offA();
  ok((await until(() => open.size === 0, 300)) >= 0, "S10 보이는 구독이 떠나고 숨은 구독만 남으면 그 자리에서 놓는다", `열린 연결 ${open.size}`);
  //  S11 — 마지막 구독이 떠난다.
  offB();
  await settle();
  const before = requests.length;
  setRendered(shown, true);
  setDocHidden(true); setDocHidden(false);
  await sleep(200);
  eq([open.size, requests.length - before], [0, 0], "S11 마지막 구독이 떠나면 닫히고, 그 뒤 보이게 해도 되살아나지 않는다");
}

// ── S12 — 새 옵션 부재: 화면 요소 없이 구독 ───────────────────────────────────────
{
  const off = onSessionEvents("s12", () => {});
  ok((await until(() => open.size === 1)) >= 0, "S12 요소 없이 구독하면 문서만 본다 — 보이면 붙는다");
  setDocHidden(true);
  ok((await until(() => open.size === 0, 300)) >= 0, "S12 문서가 숨으면 놓는다");
  setDocHidden(false);
  ok((await until(() => open.size === 1, 500)) >= 0, "S12 문서가 보이면 다시 붙는다");
  off();
  await settle();
}

// ── S13 — 경계: 보이는 채 서버가 닫으면 종전대로 백오프 ──────────────────────────────
{
  const a = screen(true);
  const off = onSessionEvents("s13", () => {}, { anchor: a });
  await until(() => open.size === 1);
  const before = requests.length;
  [...open.values()][0].end();
  await sleep(300);
  eq(requests.length - before, 0, "S13 보이는 채 서버가 닫으면 곧바로 되묻지 않는다(백오프 — 게이트웨이 재기동 중 폭주 방지)");
  ok((await until(() => open.size === 1, 1500)) >= 0, "S13 백오프(1초) 뒤에는 다시 붙는다");
  off();
  await settle();
}

// ── S14 — ★ 백오프 도중 숨었다 다시 보이면 기다리지 않는다(격리 리뷰 지적) ─────────────────
{
  const a = screen(true);
  const off = onSessionEvents("s14", () => {}, { anchor: a });
  await until(() => open.size === 1);
  [...open.values()][0].end();             // 서버가 닫았다 — 보이는 채라 백오프(1초)에 든다
  await sleep(150);
  setDocHidden(true);
  await sleep(50);
  setDocHidden(false);
  const ms = await until(() => open.size === 1, 1500);
  ok(ms >= 0 && ms < 400, "S14★ 백오프 도중 숨었다 다시 보이면 남은 백오프를 기다리지 않고 곧바로 붙는다", `다시 보인 뒤 ${ms}ms(백오프가 남았다면 ~800ms)`);
  off();
  await settle();
}

// ── S15 — 숨김과 다시 보임이 한 틱에 ─────────────────────────────────────────────
{
  const a = screen(true);
  const off = onSessionEvents("s15", () => {}, { anchor: a });
  await until(() => open.size === 1);
  const before = requests.length;
  setDocHidden(true);
  setDocHidden(false);                     // 같은 틱 — 끊은 시도의 마무리보다 «다시 보임» 이 먼저 지나간다
  const ms = await until(() => open.size === 1 && requests.length > before, 1500);
  ok(ms >= 0 && ms < 400, "S15 숨김 · 다시 보임이 한 틱에 와도 백오프(1초) 없이 곧바로 다시 붙는다", `걸린 시간 ${ms}ms`);
  off();
  await settle();
}

// ── W1 · W2 · W3 — 보임 판정 ─────────────────────────────────────────────────────
{
  const a = screen(true);
  eq(isShown(a), true, "W1 문서가 보이고 상자가 있으면 보인다");
  setDocHidden(true);
  eq(isShown(a), false, "W1 문서가 숨으면 안 보인다(상자가 있어도)");
  eq(isShown(null), false, "W1 요소가 없어도 문서가 숨으면 안 보인다");
  setDocHidden(false);
  eq(isShown(null), true, "W1 요소가 없으면 문서만 본다");
  a.rendered = false;
  eq(isShown(a), false, "W1 상자가 없으면(display:none 조상) 안 보인다");
  const detached = { isConnected: false, getClientRects: () => [{}] };
  eq(isShown(detached), false, "W1 문서에서 떨어진 요소는 안 보인다");

  const b = screen(true);
  const seen = [];
  const baseL = visListeners();
  const w = watchShown(b, (v) => seen.push(v));
  setDocHidden(false);                      // 바뀐 것 없음 — 알리지 않는다
  setRendered(b, true);                     // 바뀐 것 없음
  setRendered(b, false);
  setRendered(b, false);                    // 같은 값 두 번
  setDocHidden(true);                       // 이미 안 보임 — 바뀐 것 없음
  setDocHidden(false);
  setRendered(b, true);
  eq(seen, [false, true], "W2 보임이 바뀔 때만 알린다(같은 값을 두 번 알리지 않는다)");
  w.stop(); w.stop();
  eq(visListeners(), baseL, "W2 stop() 뒤엔 문서 듣개가 남지 않는다(두 번 불러도 된다)");
  ok(![...observers].some((io) => io.targets.has(b)), "W2 stop() 뒤엔 요소 관찰도 남지 않는다");

  //  W3 — 새 헬퍼가 기대는 것이 없는 환경: IntersectionObserver 가 없는 브라우저 · 문서가 없는 곳(노드).
  delete globalThis.IntersectionObserver;
  const c = screen(true);
  const seenC = [];
  let wc = null;
  let threwIO = null;
  try { wc = watchShown(c, (v) => seenC.push(v)); } catch (e) { threwIO = e; }
  ok(threwIO === null && !!wc, "W3 IntersectionObserver 가 없어도 던지지 않는다", String(threwIO));
  setDocHidden(true); setDocHidden(false);
  eq(seenC, [false, true], "W3 IntersectionObserver 가 없으면 문서 신호로만 다시 잰다");
  wc.stop();
  globalThis.IntersectionObserver = FakeIO;
  const savedDoc = globalThis.document;
  globalThis.document = undefined;
  eq(isShown(c), true, "W3 문서가 없으면(노드) 늘 보인다고 본다 — 던지지 않는다");
  let threw = null;
  try { const wd = watchShown(c, () => {}); wd.stop(); } catch (e) { threw = e; }
  globalThis.document = savedDoc;
  ok(threw === null, "W3 문서가 없어도 watchShown · stop 이 던지지 않는다", String(threw));
}

// ── W4 — 화면 밖에서 숨었다 다시 그려짐: IO 는 말이 없고 RO 가 알린다 ────────────────────
{
  const d = screen(true);
  const seenD = [];
  const wd = watchShown(d, (v) => seenD.push(v));
  setRenderedOffscreen(d, false);
  setRenderedOffscreen(d, true);
  eq(seenD, [false, true], "W4 화면 밖에서 숨었다 다시 그려져도(IO 무응답) 상자 크기 신호(RO)로 알아챈다");
  wd.stop();
  ok(![...resizers].some((ro) => ro.targets.has(d)), "W4 stop() 뒤엔 크기 관찰도 남지 않는다");
}

// ── A1–A6 — 다시 붙었을 때 접을 카드 고르기(순수) ──────────────────────────────────
{
  const cards = [["a", false], ["b", false], ["c", true]];
  eq(staleAskIds(cards, ["a"]), ["b"], "A1 걸린 목록에 없는 카드는 접는다 · A2 목록에 있는 카드는 남긴다");
  eq(staleAskIds([["c", true]], []), [], "A3 답을 보내는 중인 카드는 목록에 없어도 남긴다(고른 라벨을 «닫힘» 으로 덮지 않는다)");
  eq(staleAskIds(cards, []), ["a", "b"], "A4 빈 목록 → 보내는 중이 아닌 카드는 전부 접는다(끊긴 동안 다 닫혔다)");
  eq([staleAskIds(cards, undefined), staleAskIds(cards, null), staleAskIds(cards, { a: 1 })], [[], [], []],
    "A5 목록이 없으면(그 칸이 없는 옛 서버) 아무것도 접지 않는다 — 모르면 지우지 않는다");
  eq(staleAskIds([["7", false], ["8", false]], [7]), ["8"], "A6 id 는 글자로 견준다(서버가 숫자로 보내도 같은 카드)");
  eq(staleAskIds([], ["x"]), [], "A 화면에 카드가 없으면 접을 것도 없다");
}

console.log(`\n${pass}건 통과${fails ? ` · ${fails}건 실패` : ""}`);
process.exit(fails ? 1 : 0);

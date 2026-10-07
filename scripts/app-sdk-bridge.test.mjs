// 앱 SDK 다리 — chat.send · prefs · onPrefsOpen (#4594 · #4601) 사양 표 S2
//
//  ① 앱 화면 주입 문자열(web/v2/app-ui-runtime.ts APP_RUNTIME_JS)을 **소스에서 꺼내** vm 에서 돌린다 — 빌드 없이 돈다.
//   (문자열은 백틱 하나로 감싼 템플릿 리터럴이고 안에 백틱이 없다는 것이 그 파일의 규약이다.)
//  ② 호스트 다리(web/v2/app-ui.ts)는 **컴파일된 모듈(public/app/v2/app-ui.js)을 실제로 돌린다** — 가짜 iframe(contentWindow) 과 message 사건으로:
//   ev.source 검사 · 세션 id 가 앱의 params 가 아니라 띄운 쪽(opts)에서 오는지 · 사람이 누른 동작이 아니면 거부 · 멈춘 세션(409 draft)의 입력칸 폴백.
//   (빌드가 없으면 ② 는 건너뛰고 그 사실을 적는다 — CI 의 run-tests --build 가 돈다.)
//  이게 틀리면: 앱이 `lively.chat.send` 를 불러도 호스트에 아무 메시지가 안 가거나, 앱이 남의 세션 id 를 말해 거기로 보내거나, 앱 코드가 저 혼자
//   타이머로 세션에 글을 넣거나, 설정이 저장 안 되거나, ⋯ 메뉴의 「표시 설정」이 앱에 닿지 않는다.
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

function runtimeSource() {
  const src = read("web/v2/app-ui-runtime.ts");
  const m = /export const APP_RUNTIME_JS = `([\s\S]*?)`;\s*$/m.exec(src);
  assert.ok(m, "APP_RUNTIME_JS 템플릿 리터럴을 찾아야 한다");
  return m[1];
}

/** 앱 화면 하나를 흉내 낸 vm — parent.postMessage 를 모으고, 호스트의 답·알림은 메시지 청취자로 넣는다. */
function boot() {
  const posted = [];
  const listeners = { message: [], keydown: [] };
  const win = { addEventListener: (type, fn) => { (listeners[type] || (listeners[type] = [])).push(fn); } };
  const ctx = vm.createContext({ window: win, parent: { postMessage: (m) => posted.push(m) }, setTimeout, Promise, Error, Object, String });
  vm.runInContext(runtimeSource(), ctx);
  const deliver = (data) => { for (const fn of listeners.message) fn({ data }); };
  return { lively: win.lively, posted, deliver };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

let pass = 0;
//  vm 안에서 만든 객체는 다른 realm 의 Object 라 deepStrictEqual 이 프로토타입에서 갈린다 — JSON 으로 평평하게 해 비교한다.
const plain = (v) => JSON.parse(JSON.stringify(v));
const eq = (a, b, name) => { assert.deepStrictEqual(plain(a), plain(b), name); pass++; };
const ok = (v, name) => { assert.ok(v, name); pass++; };

// ══ S2-1 chat.send → 다리 메서드 chat/send(글만 — mark 같은 뜻 없는 인자는 없다) ══
{
  const { lively, posted, deliver } = boot();
  ok(lively && lively.chat && typeof lively.chat.send === "function", "S2-1 lively.chat.send 가 있다");
  const p = lively.chat.send("[장표 수정] 판 3 (묶음 #1)");
  const req = posted.find((m) => m.method === "chat/send");
  ok(req, "S2-1 chat/send 요청이 부모로 간다");
  eq(req.params, { text: "[장표 수정] 판 3 (묶음 #1)" }, "S2-1 글만 실린다");
  deliver({ jsonrpc: "2.0", id: req.id, result: { sent: true, session: "box-a", transport: "outbox" } });
  eq(await p, { sent: true, session: "box-a", transport: "outbox" }, "S2-1 호스트의 답이 그대로 resolve");
  lively.chat.send(123);
  eq(posted.filter((m) => m.method === "chat/send").pop().params, { text: "123" }, "S2-1b 글은 문자열로 보낸다");
}

// ══ S2-2 거부는 Error + code ══
{
  const { lively, posted, deliver } = boot();
  const p = lively.chat.send("x");
  const req = posted.find((m) => m.method === "chat/send");
  deliver({ jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "붙은 세션이 없습니다" } });
  let caught = null;
  try { await p; } catch (e) { caught = e; }
  ok(caught instanceof Error && caught.code === -32602 && /붙은 세션/.test(caught.message), "S2-2 붙은 세션이 없으면 -32602 로 reject");
}

// ══ S2-3 prefs.get / prefs.set ══
{
  const { lively, posted, deliver } = boot();
  ok(lively.prefs && typeof lively.prefs.get === "function" && typeof lively.prefs.set === "function", "S2-3 lively.prefs.get/set 이 있다");
  const pg = lively.prefs.get();
  const rg = posted.find((m) => m.method === "prefs/get");
  ok(rg, "S2-3 prefs/get 요청");
  deliver({ jsonrpc: "2.0", id: rg.id, result: { prefs: { layout: "rows" } } });
  eq(await pg, { layout: "rows" }, "S2-3 get 은 prefs 객체만 돌려준다");
  const ps = lively.prefs.set({ font: "l", layout: null });
  const rs = posted.find((m) => m.method === "prefs/set");
  eq(rs.params, { patch: { font: "l", layout: null } }, "S2-3 set 은 patch 를 그대로(null 포함) 보낸다");
  deliver({ jsonrpc: "2.0", id: rs.id, result: { prefs: { font: "l" } } });
  eq(await ps, { font: "l" }, "S2-3 set 은 병합 뒤 전체를 돌려준다");
}

// ══ S2-4 onPrefsOpen — 호스트 알림 ui/notifications/prefs-open ══
{
  const { lively, posted, deliver } = boot();
  let opened = 0;
  const off = lively.ui.onPrefsOpen(() => { opened++; });
  ok(posted.some((m) => m.method === "ui/subscribe" && m.params.topic === "prefs-open"), "S2-4 구독하면 호스트에 ui/subscribe {topic:'prefs-open'} 한 번");
  deliver({ jsonrpc: "2.0", method: "ui/notifications/prefs-open", params: {} });
  await tick();
  eq(opened, 1, "S2-4 알림이 오면 콜백");
  off();
  deliver({ jsonrpc: "2.0", method: "ui/notifications/prefs-open", params: {} });
  await tick();
  eq(opened, 1, "S2-4 해제하면 더 안 온다");
  let data = 0; lively.store.onChange(() => { data++; });
  deliver({ jsonrpc: "2.0", method: "ui/notifications/data-changed", params: { table: "notes" } });
  await tick();
  eq(data, 1, "S2-4b data-changed 는 종전대로");
}

// ══ S2-5 이름이 양쪽에서 같다(소스) · d.ts · 403 동의 재시도가 그 분기 안에 있다 ══
{
  const host = read("web/v2/app-ui.ts");
  const branch = (host.split("msg.method === 'chat/send'")[1] || "").split("msg.method === 'prefs/get'")[0];
  ok(branch.length > 0, "S2-5 app-ui.ts 가 chat/send 를 받는다");
  ok(/msg\.method === 'prefs\/get'/.test(host) && /msg\.method === 'prefs\/set'/.test(host), "S2-5 app-ui.ts 가 prefs/get · prefs/set 을 받는다");
  ok(/\/chat-send'/.test(branch) && /session_id: sid/.test(branch), "S2-5 chat/send 는 /api/ui/apps/:id/chat-send 로, 세션은 opts 의 sid 로 간다");
  ok(/ensureAppGrant\(appId/.test(branch) && /동의\|grant/.test(branch), "S2-5 403 「동의」 면 그 자리에서 동의 창 → 1회 재시도(tools/call 과 같은 규칙)");
  ok(/putIntoSession\(\[sid\]/.test(branch) && /draft_text/.test(branch), "S2-5 멈춘 세션(409 draft)이면 표식 붙은 draft_text 를 그 세션 입력칸에 넣어 둔다");
  ok(/userActivation/.test(branch), "S2-5 사람이 누른 동작(userActivation)에서만 보낸다");
  const dts = read("apps/sdk/lively-app.d.ts");
  ok(/chat:\s*\{[\s\S]*send\(text: string\)/.test(dts) && /prefs:\s*\{[\s\S]*\bget[<(][\s\S]*\bset[<(]/.test(dts) && /onPrefsOpen\(/.test(dts), "S2-5 d.ts 에 chat.send(text) · prefs.get/set · ui.onPrefsOpen");
  const chat = read("web/session-chat.ts");
  ok(/lively:compose-draft/.test(chat) && /putIntoSession/.test(chat), "S2-5 세션 화면이 compose-draft(⋯ 메뉴 「AI에게 고치기」)를 받아 입력칸에 넣는다");
  const manifest = read("src/apps/manifest.ts");
  ok(/chat_send: z\.boolean\(\)\.default\(false\)/.test(manifest) && /CHAT_SEND_TOOL = "app_chat_send"/.test(manifest), "S2-5 매니페스트 permissions.chat_send(기본 false) → app_chat_send");
  const consent = read("web/v2/app-session.ts");
  ok(/chatSend: perm\.chat_send === true/.test(consent) && /세션에 글 보내기/.test(consent), "S2-5 동의 창에 「세션에 글 보내기」 줄이 선다");
}

// ══ S2-6~9 호스트 다리를 **실제로** 돌린다(컴파일된 app-ui.js + 가짜 iframe) ══
const built = join(root, "public/app/v2/app-ui.js");
if (!existsSync(built)) {
  console.log("app-sdk-bridge: public/app/v2/app-ui.js 없음 — 호스트 실행 시험(S2-6~9)은 건너뜀(빌드 뒤 돈다)");
} else {
  //  셸 전역 — session-app-pane.test.mjs 와 같은 가짜 DOM. el() 이 만드는 요소는 속성·자식만 받으면 된다.
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const winListeners = [];
  const mkEl = (tag) => {
    const n = { tagName: String(tag).toUpperCase(), nodeType: 1, style: {}, attrs: {}, children: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; }, hasAttribute(k) { return k in this.attrs; }, removeAttribute(k) { delete this.attrs[k]; },
      append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); return c; }, prepend() {}, remove() {}, replaceChildren() {},
      addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [], focus() {}, closest: () => null };
    if (tag === "iframe") n.contentWindow = { postMessage: (m) => replies.push(m) };
    return n;
  };
  const toastsEl = mkEl("div");   // toast() 가 붙는 자리
  globalThis.document = {
    hidden: false, addEventListener() {}, removeEventListener() {},
    createElement: mkEl, createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    body: Object.assign(mkEl("body"), {}), documentElement: Object.assign(mkEl("html"), {}), head: mkEl("head"),
    querySelector: () => null, querySelectorAll: () => [], getElementById: (id) => (id === "toasts" ? toastsEl : null), contains: () => true,
  };
  globalThis.window = globalThis;
  globalThis.addEventListener = (t, fn) => { if (t === "message") winListeners.push(fn); };
  globalThis.removeEventListener = (t, fn) => { const i = winListeners.indexOf(fn); if (i >= 0) winListeners.splice(i, 1); };
  globalThis.dispatchEvent = () => true;
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  globalThis.location = { origin: "http://x", pathname: "/ui/", search: "", hash: "", href: "http://x/ui/" };
  //  node 의 globalThis.navigator 는 getter 뿐이라 대입이 안 된다 — defineProperty 로 바꿔 끼운다(실 브라우저의 userActivation 모양).
  Object.defineProperty(globalThis, "navigator", { value: { userActivation: { isActive: true } }, configurable: true, writable: true });
  globalThis.open = () => null;
  let replies = [];
  const fetches = [];
  let plan = {};       // url 부분문자열 → 응답 { status, json }
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    fetches.push({ url: u, body: init && init.body ? JSON.parse(init.body) : null });
    const hit = Object.entries(plan).find(([k]) => u.includes(k));
    const r = hit ? hit[1] : { status: 200, json: {} };
    return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: { get: () => null }, json: async () => r.json };
  };
  const { mountAppUiFrame } = await import(built);
  const { registerSessionInput } = await import(join(root, "public/app/v2/sess-input.js"));

  async function mount(opts) {
    plan = { "/ui": { status: 200, json: { html: "<!doctype html><p>앱</p>" } } };
    const f = await mountAppUiFrame("deck-edit", opts);
    replies = [];
    const win = f.root.contentWindow;
    const fire = (data, source = win) => { for (const fn of winListeners.slice()) fn({ source, data }); };
    return { f, win, fire };
  }
  const lastReply = () => replies[replies.length - 1];
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

  // S2-6 세션 id 는 띄운 쪽(opts)의 것 — 앱 params 의 session_id 는 무시
  {
    const { fire } = await mount({ sessionId: "box-mine", title: "장표 수정" });
    plan = { "/chat-send": { status: 200, json: { app_id: "deck-edit", sent: true, session: "box-mine", transport: "outbox" } } };
    fetches.length = 0;
    fire({ jsonrpc: "2.0", id: 1, method: "chat/send", params: { text: "안녕", session_id: "box-victim" } });
    await settle();
    const call = fetches.find((x) => x.url.includes("/chat-send"));
    ok(call, "S2-6 호스트가 /api/ui/apps/deck-edit/chat-send 를 부른다");
    eq(call.body, { session_id: "box-mine", text: "안녕" }, "S2-6 세션은 opts 의 것 · 앱이 말한 session_id 는 버린다 · mark 없음");
    eq(lastReply(), { jsonrpc: "2.0", id: 1, result: { sent: true, session: "box-mine", transport: "outbox" } }, "S2-6 앱에는 sent:true 와 그 세션");
  }
  // S2-7 ev.source 가 이 프레임이 아니면 무시
  {
    const { fire } = await mount({ sessionId: "box-mine" });
    fetches.length = 0;
    fire({ jsonrpc: "2.0", id: 2, method: "chat/send", params: { text: "x" } }, { postMessage() {} });
    await settle();
    eq([fetches.length, replies.length], [0, 0], "S2-7 다른 창에서 온 chat/send 는 부르지도 답하지도 않는다");
  }
  // S2-8 사람이 누른 동작이 아니면 거부 · 붙은 세션이 없으면 거부
  {
    const { fire } = await mount({ sessionId: "box-mine" });
    globalThis.navigator.userActivation.isActive = false;
    fetches.length = 0;
    fire({ jsonrpc: "2.0", id: 3, method: "chat/send", params: { text: "x" } });
    await settle();
    eq(fetches.length, 0, "S2-8 거부면 서버를 부르지 않는다");
    ok(lastReply() && lastReply().error && lastReply().error.code === -32001 && /사람이 누른 동작/.test(lastReply().error.message), "S2-8 userActivation 아니면 -32001");
    globalThis.navigator.userActivation.isActive = true;
    const { fire: fire2 } = await mount({});
    fire2({ jsonrpc: "2.0", id: 4, method: "chat/send", params: { text: "x" } });
    await settle();
    ok(lastReply() && lastReply().error && lastReply().error.code === -32602, "S2-8b 붙은 세션이 없는 화면은 -32602");
  }
  // S2-9 멈춘 세션(409 draft) — 세션 화면이 떠 있으면 입력칸에 draft_text 를 넣고 draft:true, 안 떠 있으면 draft:false
  {
    const { fire } = await mount({ sessionId: "box-mine" });
    plan = { "/chat-send": { status: 409, json: { error: "세션이 멈춰 있어 보내지 못했습니다", draft: true, session: "box-mine", draft_text: "(앱 「장표 수정」에서 보냄)\n안녕" } } };
    fire({ jsonrpc: "2.0", id: 5, method: "chat/send", params: { text: "안녕" } });
    await settle();
    eq(lastReply(), { jsonrpc: "2.0", id: 5, result: { sent: false, session: "box-mine", draft: false } }, "S2-9 세션 화면이 없으면 못 넣었다고 말한다(draft:false)");
    const put = [];
    const off = registerSessionInput(() => ["box-mine"], (t) => { put.push(t); return true; });
    fire({ jsonrpc: "2.0", id: 6, method: "chat/send", params: { text: "안녕" } });
    await settle();
    eq(put, ["(앱 「장표 수정」에서 보냄)\n안녕"], "S2-9 세션 화면이 떠 있으면 표식 붙은 draft_text 가 그 입력칸에 들어간다");
    eq(lastReply(), { jsonrpc: "2.0", id: 6, result: { sent: false, session: "box-mine", draft: true } }, "S2-9 draft:true");
    off();
  }
  // S2-10 prefs 다리 — GET 은 /prefs · set 은 POST {patch}
  {
    const { fire } = await mount({ sessionId: "box-mine" });
    plan = { "/prefs": { status: 200, json: { app_id: "deck-edit", prefs: { layout: "rows" } } } };
    fetches.length = 0;
    fire({ jsonrpc: "2.0", id: 7, method: "prefs/set", params: { patch: { layout: "rows" } } });
    await settle();
    const call = fetches.find((x) => x.url.includes("/prefs"));
    eq(call && call.body, { patch: { layout: "rows" } }, "S2-10 prefs/set → POST /prefs {patch}");
    eq(lastReply(), { jsonrpc: "2.0", id: 7, result: { prefs: { layout: "rows" } } }, "S2-10 앱에는 prefs 만");
  }
}

console.log(`app-sdk-bridge: ${pass} 단언 통과`);

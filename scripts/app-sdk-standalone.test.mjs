// 앱 SDK 맨몸(standalone) — #4482 앱 v2-3 «새 탭 · 폰에서도 같은 SDK». 사양 표 D(S1~S17).
//
//  앱 주소(<앱>-<워크스페이스>.lvly.app)를 새 탭 · 폰 홈 화면으로 열면 감싸는 라이블리 화면이 없다(parent === window). 그때 SDK
//   (web/v2/app-ui-runtime.ts APP_RUNTIME_JS)는 postMessage 다리 대신 **같은 주소의 /_lively/*** 를 fetch 로 부른다.
//  주입 문자열을 소스에서 꺼내 vm 에서 돌린다(빌드 없이 돈다 — app-sdk-bridge.test.mjs 와 같은 방식).
//  이게 틀리면: 새 탭에서 연 앱이 표를 못 읽거나(다리로 보내 «라이블리 화면 안에서만» 으로 실패), 세션 기능이 조용히 빈 답을 주거나,
//   동의 · 로그인이 끊긴 탭이 끝없이 왕복하거나, ⌘K 를 앱이 못 받거나, 제 창에 postMessage 를 쏘아 앱의 메시지 청취자를 어지럽힌다.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
function runtimeSource() {
  const src = readFileSync(join(root, "web/v2/app-ui-runtime.ts"), "utf8");
  const m = /export const APP_RUNTIME_JS = `([\s\S]*?)`;\s*$/m.exec(src);
  assert.ok(m, "APP_RUNTIME_JS 템플릿 리터럴을 찾아야 한다");
  return m[1];
}

let pass = 0;
const plain = (v) => JSON.parse(JSON.stringify(v));
const eq = (a, b, name) => { assert.deepStrictEqual(plain(a), plain(b), name); pass++; console.log(`ok  ${name}`); };
const ok = (v, name) => { assert.ok(v, name); pass++; console.log(`ok  ${name}`); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

/**
 * 맨몸 앱 문서 하나 — window.parent === window · https 주소. fetch 는 표(routes)로 답한다: (메서드, 경로) → { status, json }.
 *  sessionStorage · location.assign/reload · window.open · document 의 visibilitychange 를 흉내 낸다(관측 = 호출 기록).
 */
function bootAlone(routes, opts = {}) {
  const fetched = [];
  const posted = [];
  const nav = { assigned: [], reloads: 0, opened: [] };
  const store = new Map();
  const listeners = {};
  const docListeners = {};
  const doc = {
    visibilityState: "visible",
    addEventListener: (t, fn) => { (docListeners[t] || (docListeners[t] = [])).push(fn); },
    hasFocus: () => true,
    documentElement: { style: { setProperty() {} } },
  };
  const win = {
    addEventListener: (t, fn) => { (listeners[t] || (listeners[t] = [])).push(fn); },
    postMessage: (m) => posted.push(m),
    open: (u, target, features) => { nav.opened.push({ u, target, features }); return opts.popupBlocked ? null : {}; },
  };
  win.parent = win;
  const location = {
    protocol: opts.protocol || "https:", pathname: opts.pathname || "/c/42", search: opts.search ?? "?page=main", hash: opts.hash ?? "#t",
    assign: (u) => nav.assigned.push(u), reload: () => { nav.reloads++; },
  };
  const fetchFn = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    fetched.push({ url, method, body: init.body === undefined ? undefined : JSON.parse(init.body), headers: init.headers, credentials: init.credentials });
    const r = routes(method, url, init.body === undefined ? undefined : JSON.parse(init.body)) || { status: 404, json: { error: "없음" } };
    if (r.reject) throw r.reject;   // #4848 서버에 닿지 못함(fetch 의 TypeError)
    //  답 머리(retry-after 등 — #4848) · JSON 이 아닌 본문(HTML 413 등)도 흉내 낸다.
    const hdrs = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => hdrs[String(k).toLowerCase()] ?? null },
      text: async () => (r.text !== undefined ? r.text : r.json === undefined ? "" : JSON.stringify(r.json)) };
  };
  //  #4848 쉬는 시간 — opts.timers 를 주면 SDK 의 setTimeout 이 기다리지 않고 곧바로 돌며 쉰 시간(ms)을 적는다(관측 = 적힌 값).
  const timerFn = opts.timers ? (fn, ms) => { opts.timers.push(ms); setImmediate(fn); return 0; } : setTimeout;
  const sessionStorage = opts.storageThrows
    ? { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); } }
    : { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  const ctx = vm.createContext({
    window: win, parent: win, location, fetch: fetchFn, sessionStorage, document: doc, URLSearchParams, setTimeout: timerFn, Promise, Error, Object, String,
  });
  vm.runInContext(runtimeSource(), ctx);
  const fireDoc = (t) => { for (const fn of docListeners[t] || []) fn({}); };
  return { lively: win.lively, fetched, posted, nav, store, listeners, doc, fireDoc };
}

const ME = { member: { id: "alice", name: "앨리스", email: "a@x.io" }, workspace: { slug: "lively-46e3" }, app: { id: "talk", variant: "pub", title: "톡" }, session: null,
  consent_url: "https://lively-46e3.app.lvly.io/ui/#/app-grant/talk?v=pub" };
const NEXT = encodeURIComponent("/c/42?page=main#t");
const baseRoutes = (over = {}) => (method, url, body) => {
  const k = `${method} ${url}`;
  if (k in over) return typeof over[k] === "function" ? over[k](body) : over[k];
  if (k === "GET /_lively/me") return { status: 200, json: ME };
  if (k === "POST /_lively/tools/store_query") return { status: 200, json: { rows: [{ id: 1, text: body.table }] } };
  if (k === "POST /_lively/tools/store_insert") return { status: 200, json: { row: { id: 2 } } };
  if (k === "POST /_lively/tools/file_url") return { status: 200, json: { url: "https://lively-46e3.app.lvly.io/api/files/s/tok", method: body.method } };
  if (k === "GET /_lively/prefs") return { status: 200, json: { app_id: "talk", prefs: { side_w: 240 } } };
  if (k === "POST /_lively/prefs") return { status: 200, json: { app_id: "talk", prefs: { ...body.patch } } };
  return undefined;
};

// ══ S1 맨몸을 알아본다 · ready 는 /_lively/me 로 · 할 수 있는 것을 말한다 ══
{
  const { lively, fetched, posted } = bootAlone(baseRoutes());
  ok(lively && lively.standalone === true, "S1 lively.standalone");
  const r = await lively.ready;
  eq(fetched[0], { url: "/_lively/me", method: "GET", headers: { accept: "application/json" }, credentials: "same-origin" }, "S1 ready → GET /_lively/me(같은 주소 · 쿠키)");
  eq({ app: lively.app, session: lively.session, page: lively.page }, { app: "talk", session: null, page: "main" }, "S1 앱 id 는 me 에서 · 세션 없음 · 화면 키는 주소의 ?page");
  eq(r.capabilities, { tools: true, menu: false, chrome: false, expand: false, files_all: false, chat: false, me: true, grant: true, standalone: true }, "S1 할 수 있는 것");
  eq(posted, [], "S1 제 창에 postMessage 를 쏘지 않는다(배선 — 관측 장치가 살아 있음은 S17 이 본다)");
}

// ══ S2 표 · 도구 · 개인 설정 · 앱 폴더는 /_lively/* 로 ══
{
  const { lively, fetched } = bootAlone(baseRoutes());
  await lively.ready;
  eq(await lively.store.query("notes", { match: { done: false }, limit: 5 }), [{ id: 1, text: "notes" }], "S2 store.query → rows");
  eq(fetched.at(-1), { url: "/_lively/tools/store_query", method: "POST", body: { table: "notes", match: { done: false }, limit: 5 },
    headers: { accept: "application/json", "content-type": "application/json" }, credentials: "same-origin" }, "S2 POST /_lively/tools/store_query · JSON 본문");
  await lively.store.insert("notes", { text: "a" });
  eq(fetched.at(-1).url, "/_lively/tools/store_insert", "S2 store.insert");
  eq(await lively.prefs.get(), { side_w: 240 }, "S2 prefs.get → GET /_lively/prefs");
  eq(await lively.prefs.set({ side_w: 300 }), { side_w: 300 }, "S2 prefs.set → POST /_lively/prefs");
  eq(fetched.at(-1).body, { patch: { side_w: 300 } }, "S2 prefs.set 본문 {patch}");
  const u = await lively.files.url("apps/talk/a.png", { method: "PUT" });
  ok(u.url.includes("/api/files/s/") && fetched.at(-1).url === "/_lively/tools/file_url", "S2 files.url → file_url 도구");
  eq(fetched.at(-1).body, { address: "apps/talk/a.png", method: "PUT" }, "S2 files.url 인자");
  await lively.tools.call("whoami/../x", {}).catch(() => null);
  eq(fetched.at(-1).url, "/_lively/tools/whoami%2F..%2Fx", "S2 도구 이름은 경로 한 칸으로 인코딩(경로를 넘나들지 못한다)");
}

// ══ S3 · S4 세션에 붙는 기능 · 호스트 기능은 분명히 실패한다(빈 답이 아니라) — fetch 도 안 한다 ══
{
  const { lively, fetched } = bootAlone(baseRoutes());
  await lively.ready;
  const n = fetched.length;
  for (const [name, p, code] of [
    ["chat.send", lively.chat.send("hi"), -32602], ["files.list", lively.files.list({ ext: ["html"] }), -32602], ["files.read", lively.files.read("a.html"), -32602],
    ["ui.chrome", lively.ui.chrome({ head: false }), -32601], ["ui.openMenu", lively.ui.openMenu([{ id: "a", label: "A" }], { x: 1, y: 1 }), -32601], ["ui.expand", lively.ui.expand(), -32601],
  ]) {
    const e = await p.then(() => null, (x) => x);
    ok(e && e.code === code, `S3/S4 ${name} → ${code}`);
    ok(e.status === null && e.reason === null, `S3/S4 ${name} 서버까지 안 간 거절은 status · reason 이 null(#4848 — 다리와 같은 모양)`);
  }
  eq(fetched.length, n, "S3/S4 서버에 묻지 않는다");
}

// ══ S5 새 창은 SDK 가 바로 연다(맨 위 페이지라 팝업이 된다) · http(s) 만 ══
{
  const { lively, nav } = bootAlone(baseRoutes());
  eq(await lively.ui.openExternal("https://example.com/a"), { opened: true }, "S5 openExternal → 열림");
  eq(nav.opened, [{ u: "https://example.com/a", target: "_blank", features: "noopener" }], "S5 _blank · noopener 로");
  const e = await lively.ui.openExternal("javascript:alert(1)").then(() => null, (x) => x);
  ok(e && e.code === -32602 && nav.opened.length === 1, "S5 http(s) 아니면 거부 · 창 안 엶");
  const { lively: L2 } = bootAlone(baseRoutes(), { popupBlocked: true });
  eq(await L2.ui.openExternal("https://example.com/b"), { opened: false }, "S5 팝업이 막히면 opened:false");
}

// ══ S6 · S7 동의 필요(403 consent_required) — 처음 한 번은 라이블리 동의 화면으로 · 10분 안 두 번째는 실패 ══
{
  const consent = { status: 403, json: { error: "앱 'talk' 사용 동의(grant)가 없습니다", code: "consent_required", consent_url: ME.consent_url } };
  const { lively, nav, store } = bootAlone(baseRoutes({ "POST /_lively/tools/store_query": consent }));
  await lively.ready;
  let settled = false;
  lively.store.query("notes", {}).then(() => { settled = true; }, () => { settled = true; });
  await settle();
  eq(nav.assigned, [ME.consent_url + "&next=" + NEXT], "S6 동의 화면으로 · 돌아올 자리(next)를 붙인다");
  ok(!settled, "S6 이동하는 동안 약속은 풀리지 않는다(앱이 실패 화면을 그리지 않게)");
  ok(store.has("lively.consent"), "S6 이 탭이 한 번 갔다는 표지");
  const e = await lively.store.query("notes", {}).then(() => null, (x) => x);
  ok(e && e.code === -32001 && e.status === 403 && e.consentUrl === ME.consent_url, "S7 10분 안 두 번째는 실패(-32001 · consentUrl 실음)");
  ok(e.reason === "consent_required" && e.message === consent.json.error, "S7 짧은 코드는 서버의 code(#4848 C10) · 글은 서버 글 그대로");
  eq(nav.assigned.length, 1, "S7 다시 이동하지 않는다(끝없는 왕복 금지)");
}

// ══ S7b 못 가는 동의 주소(https 아님 · 없음)는 «한 번» 몫을 쓰지 않는다 — 다음의 맞는 주소는 간다(격리 리뷰 11) ══
{
  let n = 0;
  const { lively, nav } = bootAlone(baseRoutes({ "POST /_lively/tools/store_query": () => (++n === 1
    ? { status: 403, json: { error: "동의 없음", code: "consent_required", consent_url: "javascript:alert(1)" } }
    : { status: 403, json: { error: "동의 없음", code: "consent_required", consent_url: ME.consent_url } }) }));
  await lively.ready;
  const e = await lively.store.query("notes", {}).then(() => null, (x) => x);
  ok(e && e.code === -32001 && nav.assigned.length === 0, "S7b https 아닌 동의 주소로는 가지 않고 실패");
  lively.store.query("notes", {}).catch(() => null);
  await settle();
  eq(nav.assigned.length, 1, "S7b 다음의 맞는 동의 주소로는 간다(앞의 실패가 10분 몫을 쓰지 않았다)");
}

// ══ S8 · S9 앱 주소 로그인이 끝났다(401 login_required) — 한 번 다시 연다 · 1분 안 두 번째는 실패 ══
{
  const { lively, nav } = bootAlone(baseRoutes({ "POST /_lively/tools/store_query": { status: 401, json: { error: "login_required" } } }));
  await lively.ready;
  lively.store.query("notes", {}).catch(() => null);
  await settle();
  eq(nav.reloads, 1, "S8 다시 열기(앞단이 라이블리 로그인을 거쳐 돌려보낸다)");
  const e = await lively.store.query("notes", {}).then(() => null, (x) => x);
  ok(e && e.status === 401, "S9 1분 안 두 번째는 실패");
  eq(nav.reloads, 1, "S9 다시 열지 않는다");
}

// ══ S10 저장소가 막힌 브라우저 — 표지를 못 남기면 이동 · 다시 열기를 하지 않고 실패(끝없는 왕복 금지) ══
{
  const consent = { status: 403, json: { error: "동의 없음", code: "consent_required", consent_url: ME.consent_url } };
  const { lively, nav } = bootAlone(baseRoutes({
    "POST /_lively/tools/store_query": consent, "POST /_lively/tools/store_insert": { status: 401, json: { error: "login_required" } },
  }), { storageThrows: true });
  await lively.ready;
  const a = await lively.store.query("notes", {}).then(() => null, (x) => x);
  const b = await lively.store.insert("notes", {}).then(() => null, (x) => x);
  ok(a && a.status === 403 && b && b.status === 401, "S10 둘 다 실패로 받는다");
  eq({ assigned: nav.assigned.length, reloads: nav.reloads }, { assigned: 0, reloads: 0 }, "S10 이동 · 다시 열기 0");
}

// ══ S11 그 밖의 실패 — 상태 코드 → JSON-RPC 코드 · 글은 서버의 error · body · status 를 싣는다 ══
{
  const { lively } = bootAlone(baseRoutes({
    "POST /_lively/tools/store_sql": { status: 400, json: { error: "검사기가 거부: DROP" } },
    "POST /_lively/tools/store_sql_batch": { status: 413, json: { error: "너무 큽니다" } },
    "POST /_lively/tools/store_tables": { status: 404, json: { error: "없는 API" } },
    "POST /_lively/tools/store_delete": { status: 429, json: { error: "너무 잦습니다", retry_after_ms: 300 } },
    "POST /_lively/tools/store_update": { status: 502, json: undefined },
    "POST /_lively/tools/whoami": { status: 403, json: { error: "권한 밖" } },
  }));
  const a = await lively.store.sql("drop table x").then(() => null, (x) => x);
  ok(a && a.code === -32602 && a.message === "검사기가 거부: DROP" && a.status === 400, "S11 400 → -32602 · 서버 글");
  ok(a.reason === null, "S11 짧은 코드 꼴이 아닌 글만 있으면 reason 은 null — 지어내지 않는다(#4848 C9)");
  const b = await lively.tools.call("store_sql_batch", {}).then(() => null, (x) => x);
  ok(b && b.code === -32602 && b.status === 413, "S11 413 → -32602");
  const c = await lively.tools.call("store_tables", {}).then(() => null, (x) => x);
  ok(c && c.code === -32601 && c.status === 404, "S11 404 → -32601");
  const d = await lively.store["delete"]("notes", { id: 1 }).then(() => null, (x) => x);
  ok(d && d.code === -32000 && d.status === 429 && d.body.retry_after_ms === 300, "S11 429 → -32000 · body 를 실어 준다(retry_after_ms)");
  const e = await lively.store.update("notes", { id: 1 }, { done: true }).then(() => null, (x) => x);
  ok(e && e.code === -32000 && /502/.test(e.message), "S11 본문 없는 502 → 상태가 든 글");
  const f = await lively.tools.call("whoami", {}).then(() => null, (x) => x);
  ok(f && f.code === -32001 && f.status === 403, "S11 동의 아닌 403 → -32001 · 이동 없음");
}

// ══ S12 ⌘K · 글 상자 신호는 맨몸에서 가로채지 않는다(앱의 것이다) ══
{
  const { listeners, posted } = bootAlone(baseRoutes());
  ok(!(listeners.keydown || []).length, "S12 keydown 을 잡지 않는다 — ⌘K 는 앱이 쓴다(셸 통합검색이 없다)");
  ok(!(listeners.blur || []).length && posted.length === 0, "S12 글 상자 신호(ui/typing)를 보내지 않는다");
}

// ══ S13 바깥 변경 — 화면이 숨었다 다시 보이면 onChange 를 한 번 ══
{
  const { lively, doc, fireDoc, posted } = bootAlone(baseRoutes());
  const seen = [];
  lively.store.onChange((ev) => seen.push(ev));
  lively.ui.onPrefsOpen(() => seen.push("prefs"));
  eq(posted, [], "S13 구독(ui/subscribe)을 제 창에 쏘지 않는다");
  fireDoc("visibilitychange");                 // 보이는 채로 — 아무것도 아님
  doc.visibilityState = "hidden"; fireDoc("visibilitychange");
  doc.visibilityState = "visible"; fireDoc("visibilitychange");
  fireDoc("visibilitychange");                 // 이미 보이는 채로 또 — 한 번만
  eq(seen, [{ source: "visibility" }], "S13 숨었다 보일 때 한 번");
}

// ══ S14 lively.me() — 맨몸이면 /_lively/me(세션은 늘 null) ══
{
  const { lively, fetched } = bootAlone(baseRoutes());
  const m = await lively.me();
  ok(m.member.id === "alice" && m.session === null && fetched.at(-1).url === "/_lively/me", "S14 me → /_lively/me · session null");
}

// ══ S15 lively.requestConsent() — me 의 consent_url 로 · 없으면 실패 ══
{
  const { lively, nav } = bootAlone(baseRoutes());
  lively.requestConsent();
  await settle();
  eq(nav.assigned, [ME.consent_url + "&next=" + NEXT], "S15 requestConsent → 동의 화면(next 붙임)");
  const { lively: L2, nav: nav2 } = bootAlone(baseRoutes({ "GET /_lively/me": { status: 200, json: { ...ME, consent_url: null } } }));
  const e = await L2.requestConsent().then(() => null, (x) => x);
  ok(e && e.code === -32000 && nav2.assigned.length === 0, "S15 consent_url 이 없으면 실패 · 이동 없음");
}

// ══ S15b 돌아올 자리(next) — CP 로그인 왕복의 해시 글자 집합 안(!'()* 도 인코딩) · 길면 / ══
{
  const consent = { status: 403, json: { error: "동의 없음", code: "consent_required", consent_url: ME.consent_url } };
  const a = bootAlone(baseRoutes({ "POST /_lively/tools/store_query": consent }), { pathname: "/a(b)!*'c", search: "?q=1 2", hash: "" });
  a.lively.store.query("notes", {}).catch(() => null);
  await settle();
  const n1 = a.nav.assigned[0].split("&next=")[1];
  ok(/^[A-Za-z0-9/_\-.?=&%+~:@,]*$/.test(n1) && !/[!'()*]/.test(n1), "S15b next 는 로그인 왕복이 받는 글자만(!'()* 도 인코딩)");
  eq(decodeURIComponent(n1), "/a(b)!*'c?q=1 2", "S15b 풀면 그 자리");
  const b = bootAlone(baseRoutes({ "POST /_lively/tools/store_query": consent }), { pathname: "/" + "x".repeat(400) });
  b.lively.store.query("notes", {}).catch(() => null);
  await settle();
  eq(b.nav.assigned[0].split("&next=")[1], "%2F", "S15b 길면(300자 넘음) 첫 화면(/)으로 — 로그인 왕복의 512자 안에 들게");
}

// ══ S16 맨몸이어도 앱 주소가 아니면(파일로 연 문서 등) 종전처럼 «라이블리 화면 안에서만» ══
{
  const { lively, fetched } = bootAlone(baseRoutes(), { protocol: "file:" });
  ok(lively.standalone === false, "S16 standalone 아님");
  const e = await lively.store.query("notes").then(() => null, (x) => x);
  ok(e && e.code === -32601, "S16 -32601");
  eq(fetched.length, 0, "S16 fetch 하지 않는다");
}

// ══ S17 라이블리 안(감싼 화면)은 종전 다리 — me · requestConsent 도 다리로 · fetch 0 ══
{
  const posted = [];
  let fetches = 0;
  const win = { addEventListener() {} };
  const par = { postMessage: (m) => posted.push(m) };
  win.parent = par;
  const ctx = vm.createContext({ window: win, parent: par, location: { protocol: "https:" }, fetch: () => { fetches++; return Promise.reject(new Error("no")); },
    setTimeout, Promise, Error, Object, String });
  vm.runInContext(runtimeSource(), ctx);
  const L = win.lively;
  ok(L.standalone === false, "S17 standalone 아님");
  L.me(); L.requestConsent(); L.store.query("notes");
  eq(posted.map((m) => m.method), ["ui/initialize", "ui/me", "ui/grant", "tools/call"], "S17 다리 메서드로");
  eq(fetches, 0, "S17 fetch 0");
}

// ══ S18 #4848 본문 거절 — 짧은 코드(e.reason) · 사람이 읽을 글 · 붐빔(503 busy)은 retry-after 만큼 쉬고 한 번만 다시 ══
//  앞단(lvly-cloud appfront)은 본문을 다 받기 전에 거절하면 503 {error:"busy"}(retry-after: 5) · 408 {error:"body_timeout"} · 413 {error:"body_too_large"},
//   코어는 413 {error:"본문이 너무 큽니다(1MB 까지)", code:"body_too_large"} · 400 {…, code:"bad_body"} 를 준다. 앱은 글이 아니라 reason 으로 가른다.
const korean = (s) => typeof s === "string" && /[가-힣]/.test(s);
{
  //  (C1) 붐빔 → retry-after(2초)만큼 쉬고 한 번 다시 → 그 답으로 풀린다 · 같은 요청 · 앱이 넘긴 객체를 곧바로 고쳐도 다시 보낸 본문은 첫 번째와 같다
  const timers = [];
  let n = 0;
  const { lively, fetched } = bootAlone(baseRoutes({ "POST /_lively/tools/store_insert": () => (++n === 1
    ? { status: 503, json: { error: "busy" }, headers: { "Retry-After": "2" } }
    : { status: 200, json: { row: { id: 9 } } }) }), { timers });
  await lively.ready;
  const before = fetched.length;
  const row = { text: "a" };
  const p = lively.store.insert("notes", row);
  row.text = "고친 값";
  eq(await p, { row: { id: 9 } }, "S18 C1 붐빔 뒤 한 번 다시 보내 그 답으로 풀린다");
  const sent = fetched.slice(before);
  eq(sent.length, 2, "S18 C1 두 번 보냈다");
  eq(sent[1], sent[0], "S18 C1 같은 메서드 · 경로 · 본문 · 머리");
  eq(sent[0].body, { table: "notes", row: { text: "a" } }, "S18 C1 본문은 부른 때의 것(다시 보낼 때 새로 만들지 않는다)");
  ok(timers.length === 1 && timers[0] >= 2000 && timers[0] < 2500, `S18 C1 retry-after(2초)만큼 쉬었다 + ¼ 안 흩뿌림(${timers})`);
}
{
  //  (C2) 또 붐비면 실패 — reason busy · status 503 · 셋째는 없다 · 글은 사람이 읽을 말(짧은 코드 그대로가 아니다)
  const timers = [];
  const { lively, fetched } = bootAlone(baseRoutes({ "POST /_lively/tools/store_insert": { status: 503, json: { error: "busy" }, headers: { "retry-after": "5" } } }), { timers });
  await lively.ready;
  const before = fetched.length;
  const e = await lively.store.insert("notes", { text: "a" }).then(() => null, (x) => x);
  ok(e && e.reason === "busy" && e.status === 503 && e.code === -32000, "S18 C2 또 붐비면 reason busy · 503 · -32000 으로 실패");
  ok(e.message !== "busy" && korean(e.message), `S18 C2 글은 사람이 읽을 말(${e.message})`);
  eq(fetched.length - before, 2, "S18 C2 다시 보내기는 한 번뿐(셋째 없음)");
  eq(timers.length, 1, "S18 C2 한 번만 쉬었다");
}
{
  //  (C3) 쉬는 시간 — retry-after 없음 · 숫자 아님 · 음수는 5초, 30초 넘음은 30초, 0 은 곧바로, 소수는 그대로
  for (const [ra, lo, hi] of [[undefined, 5000, 6000], ["abc", 5000, 6000], ["-3", 5000, 6000], ["  ", 5000, 6000], ["999", 30000, 31000], ["0", 0, 1], ["1.5", 1500, 1875]]) {
    const timers = [];
    let n = 0;
    const { lively } = bootAlone(baseRoutes({ "POST /_lively/prefs": () => (++n === 1
      ? { status: 503, json: { error: "busy" }, headers: ra === undefined ? {} : { "retry-after": ra } }
      : { status: 200, json: { prefs: { k: 1 } } }) }), { timers });
    eq(await lively.prefs.set({ k: 1 }), { k: 1 }, `S18 C3 retry-after ${JSON.stringify(ra)} — 다시 보내 풀린다`);
    ok(timers.length === 1 && timers[0] >= lo && timers[0] < hi, `S18 C3 retry-after ${JSON.stringify(ra)} → ${timers[0]}ms ∈ [${lo}, ${hi})`);
  }
}
{
  //  (C4) busy 가 아닌 503 은 다시 보내지 않는다 — 다른 짧은 코드 · JSON 이 아닌 503(HTML)
  for (const [route, reason] of [[{ status: 503, json: { error: "app_server_stopped" }, headers: { "retry-after": "1" } }, "app_server_stopped"],
    [{ status: 503, text: "<html>잠시 이용할 수 없습니다</html>", headers: { "retry-after": "10" } }, null]]) {
    const timers = [];
    const { lively, fetched } = bootAlone(baseRoutes({ "POST /_lively/tools/store_insert": route }), { timers });
    await lively.ready;
    const before = fetched.length;
    const e = await lively.store.insert("notes", {}).then(() => null, (x) => x);
    ok(e && e.status === 503 && e.reason === reason, `S18 C4 503 ${reason} → reason ${reason}`);
    eq([fetched.length - before, timers.length], [1, 0], `S18 C4 503 ${reason} 은 다시 보내지 않는다`);
  }
}
{
  //  (C5 · C6 · C7 · C8 · C14) 408 · 413(앞단 · 코어 · HTML) — 짧은 코드 · 사람이 읽을 글 · 다시 보내지 않는다 · 붐빔 뒤 둘째가 413 이면 그 실패로
  const cases = [
    ["C5 408 앞단", { status: 408, json: { error: "body_timeout" } }, "body_timeout", -32000],
    ["C6 413 앞단", { status: 413, json: { error: "body_too_large" } }, "body_too_large", -32602],
    ["C7 413 코어", { status: 413, json: { error: "본문이 너무 큽니다(1MB 까지)", code: "body_too_large" } }, "body_too_large", -32602],
    ["C8 413 HTML", { status: 413, text: "<html><body>Payload Too Large</body></html>" }, "body_too_large", -32602],
    ["bad_body 코어", { status: 400, json: { error: "본문을 JSON 으로 읽지 못했습니다", code: "bad_body" } }, "bad_body", -32602],
  ];
  for (const [name, route, reason, code] of cases) {
    const timers = [];
    const { lively, fetched } = bootAlone(baseRoutes({ "POST /_lively/tools/store_sql": route }), { timers });
    await lively.ready;
    const before = fetched.length;
    const e = await lively.store.sql("insert into t values ($1)", ["x"]).then(() => null, (x) => x);
    ok(e && e.reason === reason && e.status === route.status && e.code === code, `S18 ${name} → reason ${reason} · ${route.status} · ${code}`);
    ok(korean(e.message) && e.message !== reason && e.message !== (route.json && route.json.error), `S18 ${name} 글은 SDK 의 사람이 읽을 말로 바뀐다(${e.message})`);
    eq([fetched.length - before, timers.length], [1, 0], `S18 ${name} 다시 보내지 않는다`);
  }
  let n = 0;
  const timers = [];
  const { lively, fetched } = bootAlone(baseRoutes({ "POST /_lively/tools/store_sql": () => (++n === 1
    ? { status: 503, json: { error: "busy" }, headers: { "retry-after": "1" } } : { status: 413, json: { error: "body_too_large" } }) }), { timers });
  await lively.ready;
  const before = fetched.length;
  const e = await lively.store.sql("select 1").then(() => null, (x) => x);
  ok(e && e.reason === "body_too_large" && e.status === 413 && fetched.length - before === 2, "S18 C14 붐빔 뒤 둘째가 413 이면 그 실패로(다시 보내기는 한 번)");
}
{
  //  (C15) 서버가 제 글을 준 413(코드 없음 — 개인 설정 16KB · 파일 읽기 8MB · 결과 상한)은 «1MB» 로 짐작하지 않는다 — reason null · 서버 글 그대로(격리 리뷰 B1)
  for (const text of ["설정이 너무 큽니다(16KB 까지)", "파일이 너무 큽니다(9MB > 8MB)", "결과가 상한(5MB)을 넘었습니다 — LIMIT·OFFSET 으로 나눠 읽으세요. 쓰기였다면 취소했습니다"]) {
    const { lively } = bootAlone(baseRoutes({ "POST /_lively/prefs": { status: 413, json: { error: text } } }));
    const e = await lively.prefs.set({ big: 1 }).then(() => null, (x) => x);
    ok(e && e.status === 413 && e.reason === null && e.message === text && e.code === -32602, `S18 C15 413 «${text.slice(0, 12)}…» → reason null · 서버 글 그대로`);
  }
}
{
  //  (C16) 코어 모양의 busy(code 를 싣는다)는 다시 보내지 않는다 — 다시 보내기는 앞단의 모양({error:"busy"})일 때만(격리 리뷰 N1)
  for (const route of [{ status: 503, json: { error: "지금 바쁩니다", code: "busy" }, headers: { "retry-after": "1" } },
    { status: 503, json: { error: "busy", code: "other_busy" }, headers: { "retry-after": "1" } }]) {
    const timers = [];
    const { lively, fetched } = bootAlone(baseRoutes({ "POST /_lively/tools/store_insert": route }), { timers });
    await lively.ready;
    const before = fetched.length;
    const e = await lively.store.insert("notes", {}).then(() => null, (x) => x);
    ok(e && e.status === 503 && e.reason === route.json.code, `S18 C16 ${JSON.stringify(route.json)} → reason ${route.json.code}`);
    eq([fetched.length - before, timers.length], [1, 0], `S18 C16 ${JSON.stringify(route.json)} 은 다시 보내지 않는다`);
  }
}
{
  //  (C17) 서버에 닿지 못함(fetch 의 TypeError) — 같은 모양의 실패: code -32000 · status · reason null · 원래 오류는 cause(격리 리뷰 N2)
  const boom = new TypeError("Failed to fetch");
  const { lively } = bootAlone(baseRoutes({ "POST /_lively/tools/store_insert": { reject: boom } }));
  await lively.ready;
  const e = await lively.store.insert("notes", {}).then(() => null, (x) => x);
  ok(e && e.code === -32000 && e.status === null && e.reason === null && e.cause === boom && korean(e.message), `S18 C17 끊김 → -32000 · null · null · cause(${e && e.message})`);
}

console.log(`\n${pass} passed`);

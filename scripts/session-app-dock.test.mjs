// #4225 — 세션 오른쪽 앱 칸: «AI 가 세션에서 쓴 것이 사람이 보는 앱 화면에 곧바로» 의 두 고리.
//  S5 앱 SDK(앱 화면 안) — lively.store.onChange 구독·알림 전달·해지 · 대기 중인 호출과 섞여도 안 깨짐 · lively.session
//  S6 웹 실시간 스트림 — 앱 사건은 앱 칸으로만(사이드바를 다시 읽지 않는다), 세션 사건은 종전대로 사이드바로
//  사양 표는 스크래치패드 spec.md(S5·S6) — 아래 이름의 번호가 그 행이다.
//
//  ⚠ 컴파일 결과(public/app)를 그대로 쓴다 — SDK 는 문자열이라 VM 에서 가짜 창으로 돌리고(앱 iframe 과 같은 조건: window·parent 뿐),
//   live-sync 는 가짜 fetch 스트림을 먹인다. 관측은 전부 부작용(부모에게 보낸 메시지 · 불린 콜백 수)이다.
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };
const eq = (got, want, name) => { assert.deepEqual(got, want, `${name}: ${JSON.stringify(want)} 여야 하는데 ${JSON.stringify(got)}`); pass++; console.log(`ok  ${name}`); };
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── 브라우저 흉내(live-sync·core 를 불러오기 전에 심는다) ──
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const docListeners = new Map();
globalThis.document = {
  hidden: false,
  addEventListener: (t, fn) => docListeners.set(t, fn), removeEventListener() {},
  createElement: () => ({ style: {}, setAttribute() {}, append() {}, addEventListener() {} }),
  body: { append() {}, classList: { add() {}, remove() {}, toggle() {} } },
  documentElement: { classList: { add() {}, remove() {}, toggle() {} }, style: {} },
  querySelector: () => null, getElementById: () => null,
};
globalThis.window = globalThis;
globalThis.location = { origin: "http://x", pathname: "/ui/", search: "", hash: "" };

// ══ S5 앱 SDK ══════════════════════════════════════════════════════════════
{
  const { APP_RUNTIME_JS } = await import(join(root, "public/app/v2/app-ui-runtime.js"));
  const posted = [];
  const listeners = [];
  const win = { addEventListener: (t, fn) => { if (t === "message") listeners.push(fn); } };
  const ctx = vm.createContext({ window: win, parent: { postMessage: (m) => posted.push(m) }, setTimeout, Promise, Error, Object, String });
  vm.runInContext(APP_RUNTIME_JS, ctx);
  const deliver = (data) => { for (const fn of listeners) fn({ data }); };
  const L = win.lively;
  ok(L && typeof L.store.onChange === "function", "S5 SDK 가 lively.store.onChange 를 낸다");

  // S5-6 ready 응답의 session → lively.session
  const init = posted.find((m) => m.method === "ui/initialize");
  deliver({ jsonrpc: "2.0", id: init.id, result: { app: "crm", page: "main", session: "box-a" } });
  await L.ready;
  eq(L.session, "box-a", "S5-6 붙은 세션 id 가 lively.session 에 선다");

  // S5-1 첫 구독 → ui/subscribe {topic:data} 1회(id 없는 알림) · S5-2 두 번째는 추가 알림 없음
  const got1 = [], got2 = [];
  const off1 = L.store.onChange((ev) => got1.push(ev));
  L.store.onChange((ev) => got2.push(ev));
  const subs = posted.filter((m) => m.method === "ui/subscribe");
  eq(subs.map((m) => ({ id: m.id, topic: m.params.topic })), [{ id: undefined, topic: "data" }], "S5-1·2 구독 알림은 첫 등록에 한 번, 답을 기다리지 않는다(id 없음)");

  // S5-3 호스트 알림 → 등록한 콜백 전부, payload 그대로
  deliver({ jsonrpc: "2.0", method: "ui/notifications/data-changed", params: { table: "contacts", op: "insert", source: "mcp" } });
  eq([got1.length, got2.length, got1[0] && got1[0].table], [1, 1, "contacts"], "S5-3 알림이 두 콜백에 그대로 간다");

  // S5-4 해지 후 알림 → 해지한 콜백은 안 불린다
  off1();
  deliver({ jsonrpc: "2.0", method: "ui/notifications/data-changed", params: { table: "contacts" } });
  eq([got1.length, got2.length], [1, 2], "S5-4 해지한 콜백은 더 안 불린다");

  // S5-5 대기 중인 호출 사이에 알림이 끼어도 응답은 제 호출로
  const p = L.tools.call("store_query", { table: "contacts" });
  const call = posted[posted.length - 1];
  deliver({ jsonrpc: "2.0", method: "ui/notifications/data-changed", params: {} });
  deliver({ jsonrpc: "2.0", id: call.id, result: { rows: [{ id: 7 }] } });
  eq(await p, { rows: [{ id: 7 }] }, "S5-5 알림이 끼어도 대기 중인 호출은 제 응답으로 풀린다");
}

// ══ S6 웹 실시간 스트림 분기 ═══════════════════════════════════════════════
{
  const { TOKEN_KEY } = await import(join(root, "public/app/core.js"));
  localStorage.setItem(TOKEN_KEY, "tok");
  let push = null, finish = null;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    const body = new ReadableStream({ start(c) { push = (s) => c.enqueue(new TextEncoder().encode(s)); finish = () => c.close(); } });
    return { status: 200, ok: true, body };
  };
  const { startLiveSync, onAppEvent } = await import(join(root, "public/app/v2/live-sync.js"));
  let changes = 0;
  const apps = [];
  const off = onAppEvent((ev) => apps.push(ev));
  startLiveSync(() => { changes++; });
  for (let i = 0; i < 20 && !push; i++) await tick();
  ok(fetches === 1 && push, "S6 스트림에 붙었다(배선 — 아래가 vacuous 가 아니다)");

  const app = (k) => `event: app\ndata: ${JSON.stringify({ type: "app", kind: k, app_id: "crm", session: "box-a", table: "contacts", op: "insert", source: "mcp" })}\n\n`;
  const sess = `event: session\ndata: ${JSON.stringify({ type: "session", id: "box-a", phase: "idle" })}\n\n`;

  push(app("data")); await tick(); await tick();
  eq([apps.length, apps[0] && apps[0].kind, changes], [1, "data", 0], "S6-1 앱 사건은 앱 칸으로만 — 사이드바를 다시 읽지 않는다");
  push(sess); await tick(); await tick();
  eq([apps.length, changes], [1, 1], "S6-2 세션 사건은 종전대로 사이드바를 다시 읽게 한다");
  push(app("attach") + sess); await tick(); await tick();
  eq([apps.length, changes], [2, 2], "S6-3 섞여 오면 앱 칸 + 사이드바 한 번");
  off();
  push(app("detach")); await tick(); await tick();
  eq(apps.length, 2, "S6 해지한 청취자는 더 안 받는다");
  document.hidden = true;            // 끊긴 뒤 다시 붙지 않게(재연결은 보이는 화면에서만)
  finish(); await tick();
}

// ══ 배선 — 앱 칸이 세션 부품에 실제로 서고, 스트림을 실제로 듣는다 ═══════════════
{
  const read = (p) => readFileSync(join(root, p), "utf8");
  const PARTS = read("web/v2/panes-parts.ts");
  const DOCK = read("web/v2/session-app-dock.ts");
  ok(/^\s*const dock = createSessionAppDock\(stage,/m.test(PARTS) && /^\s*root\.append\(dock\.row\);/m.test(PARTS), "세션 부품이 세션 화면 옆 앱 칸 줄을 붙인다");
  ok(/^\s*dock\.setSession\(/m.test(PARTS), "보는 세션이 바뀌면 앱 칸도 그 세션으로 바뀐다");
  ok(/^\s*const offLive = onAppEvent\(/m.test(DOCK), "앱 칸이 실시간 앱 사건을 듣는다");
}

console.log(`\n${pass} passed`);
process.exit(0);

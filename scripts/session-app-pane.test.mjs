// #4225 — 세션에 붙은 앱(곁칸의 탭): «AI 가 세션에서 쓴 것이 사람이 보는 앱 화면에 곧바로» 의 고리들.
//  S5 앱 SDK(앱 화면 안) — lively.store.onChange 구독·알림 전달·해지 · 대기 중인 호출과 섞여도 안 깨짐 · lively.session
//  S6 웹 실시간 스트림 — 앱 사건은 앱 탭으로만(사이드바를 다시 읽지 않는다), 세션 사건은 종전대로 사이드바로
//  S9 붙은 목록 비교 — 곁칸 탭을 «켤지»(새로 붙음) · S10 곁칸 배선(저장 안 함 · × = 떼기 · 세션 바뀌면 다시 봄 · [+] 에 없음)
//  사양 표는 스크래치패드 spec.md — 아래 이름의 번호가 그 행이다.
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

// ══ S9 붙은 목록 비교 — 곁칸 탭을 켤지(새로 붙음) ══════════════════════════════════
{
  const { attachedDiff } = await import(join(root, "public/app/v2/session-app-pane.js"));
  eq(attachedDiff(null, ["a"]), { added: [], changed: true }, "S9-1 첫 판 — 바뀜이지만 새로 붙음은 없다(열자마자 탭을 뺏지 않는다)");
  eq(attachedDiff(["a"], ["a"]), { added: [], changed: false }, "S9-2 그대로 — 안 바뀜");
  eq(attachedDiff(["a"], ["a", "b"]), { added: ["b"], changed: true }, "S9-3 하나 더 붙음 — 새로 붙음 [b]");
  eq(attachedDiff(["a", "b"], ["a"]), { added: [], changed: true }, "S9-4 하나 뗌 — 바뀜 · 새로 붙음 없음");
  eq(attachedDiff([], ["a"]), { added: ["a"], changed: true }, "S9-5 빈 목록에서 붙음 — 새로 붙음 [a]");
  const { sessAppTabTitle } = await import(join(root, "public/app/v2/session-app-pane.js"));
  eq([sessAppTabTitle([{ title: "메모" }]), sessAppTabTitle([{ title: "a" }, { title: "b" }])], ["메모", "앱 2개"], "S9-6 탭 이름 — 하나면 그 앱 이름, 여럿이면 «앱 n개»(탭을 한 번도 안 켜도)");
}

// ══ S10 곁칸 배선 — 줄 맨 앞의 실제 코드만 인정한다(주석 속 이름으로 통과하지 않게) ══════════════
{
  const read = (p) => readFileSync(join(root, p), "utf8");
  const PARTS = read("web/v2/panes-parts.ts");
  const PANES = read("web/v2/panes.ts");
  const PANE = read("web/v2/session-app-pane.ts");
  ok(/^const DERIVED_TABS: ReadonlySet<string> = new Set\(\[SESSAPP_TAB\]\);/m.test(PANES), "S10-1 붙은 앱 탭은 배치에 저장하지 않는 탭이다");
  ok(/^\s*lay = stripDerived\(lay\);/m.test(PANES) && /^\s*const saved = stripDerived\(lay\);/m.test(PANES), "S10-1 배치를 읽을 때도 쓸 때도 걷는다");
  ok(/^\s*for \(const pane of panes\.values\(\)\) \{ const p = pane\.parts\.get\(key\); if \(p\?\.onTabClose\) \{ p\.onTabClose\(\); return; \} \}/m.test(PANES), "S10-2 탭의 × 는 부품의 뜻(떼기)을 먼저 따른다");
  ok(/onTabClose: \(\) => \{/.test(PANE) && /detachAppFromSession\(s, cur\.app_id\)/.test(PANE), "S10-2 붙은 앱 탭의 × = 이 세션에서 떼기");
  const announce = (PANES.match(/function announceSession\(sid: string \| null\): void \{[\s\S]*?\n  \}/) || [""])[0];
  ok(/^\s*syncSessApps\(\);$/m.test(announce), "S10-3 세션이 바뀌면 붙은 목록을 다시 본다");
  ok(/^\s*syncSessApps\(\);\s+\/\/ #4225/m.test(PANES), "S10-3 첫 그림 뒤 붙은 목록을 본다");
  ok(/\{ type: 'sessapp', name: '붙은 앱', icon: 'apps', pickable: false,/.test(PARTS) && /^\s*if \(type === 'sessapp'\) return sessAppPart\(ctx\);/m.test(PARTS), "S10-4 붙은 앱 탭은 [+] 에 없고(pickable:false) 부품으로 선다");
  ok(!/createSessionAppDock|pn-appdock/.test(PARTS), "옛 «세션 옆 앱 칸» 은 세션 부품에서 걷혔다");
  const moveFn = (PANES.match(/function moveTab\(key: TabKey, from: Zone, to: Zone\): void \{[\s\S]*?\n  \}/) || [""])[0];
  ok(/^\s*dropTab\(from, key\);$/m.test(moveFn) && !/removeTab\(/.test(moveFn), "S10-5 탭 옮기기는 닫기가 아니다 — 붙은 앱 탭을 다른 칸으로 옮겨도 떼지 않는다(dropTab)");
  const syncFn = (PANES.match(/function syncSessApps\(\): void \{[\s\S]*?\n  \}/) || [""])[0];
  ok(/\{ const z = zoneOf\(SESSAPP_TAB\); if \(z\) dropTab\(z, SESSAPP_TAB\); \}/.test(syncFn), "S10-6 세션이 바뀌면 옛 세션의 앱 탭부터 걷는다(새 목록이 오기 전 남의 앱 탭이 안 남게)");
  ok(/^\s*ctx\.paneRoot\(\)\.dispatchEvent\(new CustomEvent\(SHOW_SESSAPP_EVT, \{ detail: \{ app_id: a\.id \} \}\)\);/m.test(PARTS)
    && /^\s*wrap\.addEventListener\(SHOW_SESSAPP_EVT, onShowSessApp\);/m.test(PANES), "S10-8 이미 붙은 앱을 다시 누르면 그 탭을 켠다(«새로 붙음» 이 없어도)");
  ok(/^\s*tabTitles\.set\(SESSAPP_TAB, sessAppTabTitle\(apps\)\);/m.test(PANES), "S10-9 탭 이름은 셸이 목록으로 먼저 건다(부품이 서기 전에도 앱 이름)");
  ok(PANES.indexOf("let sessAppOff") > 0 && PANES.indexOf("let sessAppOff") < PANES.indexOf("function announceSession"), "S10-7 구독 상태는 announceSession 보다 먼저 선언된다(TDZ)");
  ok(/^\s*const offLive = onAppEvent\(/m.test(PANE), "앱 탭이 실시간 앱 사건(데이터 변경)을 듣는다");
}

console.log(`\n${pass} passed`);
process.exit(0);

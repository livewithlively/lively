// 앱 SDK 다리 — chat.send · prefs · onPrefsOpen (#4594 · #4601) 사양 표 S2
//
//  앱 화면 주입 문자열(web/v2/app-ui-runtime.ts APP_RUNTIME_JS)을 **소스에서 꺼내** vm 에서 실제로 돌린다 — 빌드 없이 돈다.
//   (문자열은 백틱 하나로 감싼 템플릿 리터럴이고 안에 백틱이 없다는 것이 그 파일의 규약이다.)
//  이게 틀리면: 앱이 `lively.chat.send` 를 불러도 호스트에 아무 메시지가 안 가거나, 설정이 저장 안 되거나, ⋯ 메뉴의 「표시 설정」이
//   앱에 닿지 않는다. 호스트 쪽(app-ui.ts)은 그 메서드 이름을 **받는 분기가 있는지**를 소스로 못박는다(이름이 어긋나면 양쪽이 조용히 어긋난다).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
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
  const win = {
    addEventListener: (type, fn) => { (listeners[type] || (listeners[type] = [])).push(fn); },
  };
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

// ══ S2-1 chat.send → 다리 메서드 chat/send ══
{
  const { lively, posted, deliver } = boot();
  ok(lively && lively.chat && typeof lively.chat.send === "function", "S2-1 lively.chat.send 가 있다");
  const p = lively.chat.send("[장표 수정] 판 3 (묶음 #1)", { mark: "deck" });
  const req = posted.find((m) => m.method === "chat/send");
  ok(req, "S2-1 chat/send 요청이 부모로 간다");
  eq(req.params, { text: "[장표 수정] 판 3 (묶음 #1)", mark: "deck" }, "S2-1 글과 표식이 그대로 실린다");
  deliver({ jsonrpc: "2.0", id: req.id, result: { sent: true, session: "box-a", transport: "outbox" } });
  eq(await p, { sent: true, session: "box-a", transport: "outbox" }, "S2-1 호스트의 답이 그대로 resolve");
  //  옵션 없이도 · 글은 문자열로
  lively.chat.send(123);
  eq(posted.filter((m) => m.method === "chat/send").pop().params.text, "123", "S2-1b 글은 문자열로 보낸다");
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
  //  기존 data-changed 구독은 그대로
  let data = 0; lively.store.onChange(() => { data++; });
  deliver({ jsonrpc: "2.0", method: "ui/notifications/data-changed", params: { table: "notes" } });
  await tick();
  eq(data, 1, "S2-4b data-changed 는 종전대로");
}

// ══ S2-5 호스트(app-ui.ts)에 받는 분기가 있다 · 타입 선언이 같은 이름을 적는다 ══
{
  const host = read("web/v2/app-ui.ts");
  ok(/msg\.method === 'chat\/send'/.test(host), "S2-5 app-ui.ts 가 chat/send 를 받는다");
  ok(/msg\.method === 'prefs\/get'/.test(host) && /msg\.method === 'prefs\/set'/.test(host), "S2-5 app-ui.ts 가 prefs/get · prefs/set 을 받는다");
  ok(/\/chat-send'/.test(host), "S2-5 chat/send 는 /api/ui/apps/:id/chat-send 로 간다");
  ok(/lively:compose-draft/.test(host), "S2-5 멈춘 세션(409 draft)이면 입력칸에 넣어 두는 신호를 보낸다");
  const dts = read("apps/sdk/lively-app.d.ts");
  ok(/chat:\s*\{[\s\S]*send\(/.test(dts) && /prefs:\s*\{[\s\S]*\bget[<(][\s\S]*\bset[<(]/.test(dts) && /onPrefsOpen\(/.test(dts), "S2-5 d.ts 에 chat.send · prefs.get/set · ui.onPrefsOpen");
  const chat = read("web/session-chat.ts");
  ok(/lively:compose-draft/.test(chat), "S2-5 세션 화면이 compose-draft 를 받아 입력칸에 넣는다");
}

console.log(`app-sdk-bridge: ${pass} 단언 통과`);

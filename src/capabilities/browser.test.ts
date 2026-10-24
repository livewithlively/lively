import { strict as assert } from "node:assert";
import test from "node:test";
import { browserCapabilities } from "./browser.js";
import { browserRelay, relayKey, NO_HOST_MESSAGE, type BrowserCmd } from "../browser/relay.js";
import { HttpError } from "./rest-util.js";
import type { LivelyUser } from "../context.js";
import type { Capability } from "./types.js";

// ── 브라우저 툴 (#4993) — 사양·엣지 표 C 행 ───────────────────────────────────
//  싱글턴 중계(browserRelay)에 가짜 화면을 붙여, 툴이 무엇을 밀었는지(op·session·args)와 어떤 오류를 냈는지만 본다.

const cap = (name: string): Capability => {
  const c = browserCapabilities.find((x) => x.name === name);
  assert.ok(c, `${name} 이 없다`);
  return c!;
};
const alice = { userId: "alice", email: "", scopes: [], projects: ["*"] } as LivelyUser;
const status = (e: unknown) => (e instanceof HttpError ? e.status : -1);

/** 가짜 화면 — 받은 명령을 기록하고, 정해 둔 답을 바로 돌려준다. */
function host(id: string, answer: (c: BrowserCmd) => { ok: boolean; result?: unknown; error?: string } = () => ({ ok: true, result: { done: true } })) {
  const key = relayKey(null, "alice");
  const got: BrowserCmd[] = [];
  const detach = browserRelay.attach({
    id, key, end: () => {},
    push: (_ev, data) => {
      const c = data as BrowserCmd;
      got.push(c);
      setImmediate(() => browserRelay.reply(key, id, { id: c.id, ...answer(c) }));
      return true;
    },
  });
  return { got, detach };
}

test("C5 앱 토큰·앱 서버 주체는 모든 브라우저 툴이 403 — 화면에 아무것도 안 밀린다", async () => {
  const h = host("host-cap-c5");
  try {
    for (const c of browserCapabilities) {
      for (const u of [{ ...alice, appId: "app-x" }, { ...alice, appServer: true }]) {
        await assert.rejects(c.handler({ url: "https://x.test", action: "click", x: 1, y: 1, ref: "e1", value: "v", code: "1", message: "m" }, u as LivelyUser, { session: "box-s-12345678" }),
          (e: unknown) => status(e) === 403, `${c.name} 이 앱 주체를 막지 않았다`);
      }
    }
    assert.equal(h.got.length, 0, "앱 주체의 명령이 화면에 밀렸다");
  } finally { h.detach(); }
});

test("C6 화면 없음 — 툴은 409 + 안내 문구 · browser_status 는 오류가 아니라 connected:false", async () => {
  assert.equal(browserRelay.hostsFor(relayKey(null, "alice")).length, 0);
  await assert.rejects(cap("browser_navigate").handler({ url: "https://x.test" }, alice, {}),
    (e: unknown) => status(e) === 409 && (e as Error).message === NO_HOST_MESSAGE);
  await assert.rejects(cap("browser_screenshot").handler({}, alice, {}), (e: unknown) => status(e) === 409);
  const st = await cap("browser_status").handler({}, alice, {}) as Record<string, unknown>;
  assert.equal(st.connected, false);
  assert.equal(st.message, NO_HOST_MESSAGE);
});

test("C1·C2 browser_status — 화면이 있으면 그 세션의 탭 목록을 물어 합친다", async () => {
  const h = host("host-cap-c2", (c) => ({ ok: true, result: c.op === "tabs" ? { tabs: [{ tab: "1", url: "https://x.test/" }], session_visible: true } : null }));
  try {
    const st = await cap("browser_status").handler({}, alice, { session: "box-s-12345678" }) as Record<string, unknown>;
    assert.equal(st.connected, true);
    assert.deepEqual(st.tabs, [{ tab: "1", url: "https://x.test/" }]);
    assert.equal(h.got.length, 1);
    assert.equal(h.got[0].op, "tabs");
    assert.equal(h.got[0].session, "box-s-12345678");
    assert.deepEqual(h.got[0].args, { action: "list" });
  } finally { h.detach(); }
});

test("C3·C4 입력 검증 — 모자란 인자는 화면에 보내기 전에 400", async () => {
  const h = host("host-cap-c4");
  try {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["browser_navigate", {}],
      ["browser_act", { action: "click" }],
      ["browser_act", { action: "click", x: 10 }],
      ["browser_act", { action: "hover", y: 10 }],
      ["browser_act", { action: "double_click" }],
      ["browser_act", { action: "right_click" }],
      ["browser_act", { action: "drag", x: 1, y: 1 }],
      ["browser_act", { action: "drag", to_x: 5, to_y: 5 }],
      ["browser_act", { action: "type" }],
      ["browser_act", { action: "key" }],
    ];
    for (const [name, input] of bad) {
      await assert.rejects(cap(name).handler(input, alice, {}), (e: unknown) => status(e) === 400, `${name} ${JSON.stringify(input)} 를 받았다`);
    }
    assert.equal(h.got.length, 0, "검증에 걸린 명령이 화면에 밀렸다");
    // 경계 — 꼭 필요한 것만 있으면 통과한다
    const good: Array<[string, Record<string, unknown>]> = [
      ["browser_navigate", { action: "back" }],
      ["browser_act", { action: "click", ref: "e3" }],
      ["browser_act", { action: "click", x: 0, y: 0 }],
      ["browser_act", { action: "drag", ref: "e3", to_x: 5, to_y: 5 }],
      ["browser_act", { action: "scroll" }],
      ["browser_act", { action: "wait", ms: 0 }],
    ];
    for (const [name, input] of good) await cap(name).handler(input, alice, {});
    assert.equal(h.got.length, good.length);
  } finally { h.detach(); }
});

test("C7 명령엔 부른 세션이 실리고 안 준 인자는 빠진다 · 세션 밖 호출은 session=null", async () => {
  const h = host("host-cap-c7");
  try {
    await cap("browser_act").handler({ action: "type", text: "안녕", ref: "e2", x: undefined, tab: undefined }, alice, { session: "box-s-12345678" });
    assert.equal(h.got[0].op, "act");
    assert.equal(h.got[0].session, "box-s-12345678");
    assert.deepEqual(h.got[0].args, { action: "type", text: "안녕", ref: "e2" });
    assert.ok(!("x" in h.got[0].args) && !("tab" in h.got[0].args), "안 준 인자가 실렸다");
    await cap("browser_handoff").handler({ message: "로그인해 주세요" }, alice, {});
    assert.equal(h.got[1].session, null);
    assert.equal(h.got[1].args.wait_seconds, 300, "기다림 기본값이 실리지 않았다");
    await cap("browser_tabs").handler({}, alice, {});
    assert.deepEqual(h.got[2].args, { action: "list" }, "탭 기본 동작이 list 가 아니다");
  } finally { h.detach(); }
});

test("C8 화면의 실패 답은 툴 오류(502)로 그 문구 그대로", async () => {
  const h = host("host-cap-c8", () => ({ ok: false, error: "ref e9 를 찾지 못했습니다 — browser_read 로 다시 읽으세요" }));
  try {
    await assert.rejects(cap("browser_act").handler({ action: "click", ref: "e9" }, alice, {}),
      (e: unknown) => status(e) === 502 && (e as Error).message === "ref e9 를 찾지 못했습니다 — browser_read 로 다시 읽으세요");
  } finally { h.detach(); }
});

test("C9 읽기 툴은 쓰기가 아니다(읽기전용 세션에서도 보인다) · 조작 툴은 쓰기다", () => {
  const reads = ["browser_status", "browser_screenshot", "browser_read", "browser_text", "browser_console"];
  for (const c of browserCapabilities) {
    if (reads.includes(c.name)) assert.equal(c.mutates, false, `${c.name} 이 쓰기로 분류됐다`);
    else assert.notEqual(c.mutates, false, `${c.name} 이 읽기로 분류됐다`);
  }
  assert.ok(cap("browser_screenshot").mcpContent && cap("browser_act").mcpContent, "그림을 낼 툴에 조각 훅이 없다");
});

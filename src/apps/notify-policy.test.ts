// #1891 앱 알림 — 사양·엣지 표(N1~N21)는 스크래치패드 spec-notify.md. 아래 이름의 번호가 그 행이다(행 하나도 안 빠지게).
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  NOTIFY_DEDUPE_COOLDOWN_MS, NOTIFY_TITLE_MAX,
  decideNotifyAllowed, normalizeNotification, pickAwaitingTransitions, safeHref, shouldSuppressDuplicate,
} from "./notify-policy.js";

const allow = (patch: Partial<Parameters<typeof decideNotifyAllowed>[0]> = {}) =>
  decideNotifyAllowed({ appId: "ai-session", declaresNotifications: true, hasActiveGrant: true, ...patch });

// ── A. 누가 쏠 수 있나 ──

test("N1 권한 선언과 활성 grant 가 둘 다 있으면 허용한다", () => {
  assert.equal(allow(), null);
});

test("N2 매니페스트에 권한 선언이 없으면 거부한다 — grant 가 있어도", () => {
  assert.equal(allow({ declaresNotifications: false }), "notify-permission-missing");
});

test("N3 활성 grant 가 없으면 거부한다 — 동의 없이 남의 이름으로 알림을 띄우지 않는다", () => {
  assert.equal(allow({ hasActiveGrant: false }), "notify-grant-missing");
});

test("N4 앱 신원이 없으면 거부한다 — 알림은 앱이 보내는 것이다", () => {
  assert.equal(allow({ appId: null }), "notify-app-required");
  assert.equal(allow({ appId: "" }), "notify-app-required");
  assert.equal(allow({ appId: undefined }), "notify-app-required");
});

// ── B. 내용 ──

test("N5 제목이 공백뿐이면 거부한다", () => {
  for (const bad of ["", "   ", "\n\t "]) {
    const r = normalizeNotification({ title: bad });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.denial, "notify-title-required");
  }
});

test("N6 제목이 상한을 넘으면 자른다 — 길다고 알림이 안 오면 더 나쁘다", () => {
  const r = normalizeNotification({ title: "가".repeat(NOTIFY_TITLE_MAX + 50) });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.title.length, NOTIFY_TITLE_MAX);
});

test("N7 제목이 정확히 상한이면 그대로 통과한다", () => {
  const exact = "가".repeat(NOTIFY_TITLE_MAX);
  const r = normalizeNotification({ title: exact });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.title, exact);
});

test("N8 우리 화면 안의 상대경로 href 는 보존한다", () => {
  assert.equal(safeHref("#/s/box-yoon-abc"), "#/s/box-yoon-abc");
  assert.equal(safeHref("/ui/app/v2/x"), "/ui/app/v2/x");
  assert.equal(safeHref("  #/inbox  "), "#/inbox");
});

test("N9 ★외부·스킴상대·javascript href 는 버리되 알림 자체는 살린다", () => {
  for (const bad of ["https://evil.tld", "http://evil.tld", "javascript:alert(1)", "//evil.tld", "data:text/html,x", "mailto:a@b.c"]) {
    assert.equal(safeHref(bad), null, `${bad} 는 통과하면 안 된다`);
  }
  const r = normalizeNotification({ title: "끝났어요", href: "https://evil.tld" });
  assert.equal(r.ok, true, "href 가 나빠도 알림은 살아야 한다");
  if (r.ok) { assert.equal(r.value.href, null); assert.equal(r.value.title, "끝났어요"); }
});

test("N10 개행·탭·제어문자는 공백 한 칸으로 접힌다 — OS 배너가 깨지지 않게", () => {
  const r = normalizeNotification({ title: "작업\n\n끝\t났어요", body: "줄1\r\n줄2" });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.title, "작업 끝 났어요");
    assert.equal(r.value.body, "줄1 줄2");
  }
});

test("N11 body 가 없으면 빈 문자열이 아니라 null 이다", () => {
  const r = normalizeNotification({ title: "제목" });
  assert.equal(r.ok, true);
  if (r.ok) { assert.equal(r.value.body, null); assert.equal(r.value.dedupeKey, null); }
});

// ── C. 중복 억제 ──

test("N12 같은 key 를 쿨다운 안에 다시 쏘면 억제한다", () => {
  assert.equal(shouldSuppressDuplicate("k", 1_000, 1_000 + NOTIFY_DEDUPE_COOLDOWN_MS - 1), true);
});

test("N13 쿨다운이 정확히 지났으면 허용한다(경계는 '지났으면 통과')", () => {
  assert.equal(shouldSuppressDuplicate("k", 1_000, 1_000 + NOTIFY_DEDUPE_COOLDOWN_MS), false);
});

test("N14 dedupe_key 가 없으면 억제하지 않는다 — 호출자가 원하지 않았다", () => {
  assert.equal(shouldSuppressDuplicate(null, 1_000, 1_001), false);
});

test("N15 직전 발송 기록이 없으면(다른 key) 억제하지 않는다", () => {
  assert.equal(shouldSuppressDuplicate("other", null, 1_001), false);
});

// ── D. awaiting 전이 ──

const T = (prev: Array<[string, boolean]>, obs: Array<[string, boolean]>) =>
  pickAwaitingTransitions(new Map(prev), obs.map(([id, awaiting]) => ({ id, awaiting })));

test("N16 awaiting 으로 전이하면 알린다", () => {
  const r = T([["s1", false]], [["s1", true]]);
  assert.deepEqual(r.notify, ["s1"]);
  assert.equal(r.next.get("s1"), true);
});

test("N17 awaiting 이 유지되는 동안은 다시 알리지 않는다 — 폴링마다 울리면 알림을 꺼 버린다", () => {
  const r = T([["s1", true]], [["s1", true]]);
  assert.deepEqual(r.notify, []);
});

test("N18 awaiting 이 풀리는 것은 알림이 아니다", () => {
  const r = T([["s1", true]], [["s1", false]]);
  assert.deepEqual(r.notify, []);
  assert.equal(r.next.get("s1"), false);
});

test("N19 풀렸다가 다시 서면 그건 새 전이다 — 두 번 알린다", () => {
  let state = new Map<string, boolean>();
  const step = (awaiting: boolean) => {
    const r = pickAwaitingTransitions(state, [{ id: "s1", awaiting }]);
    state = r.next;
    return r.notify;
  };
  assert.deepEqual(step(true), ["s1"]);
  assert.deepEqual(step(false), []);
  assert.deepEqual(step(true), ["s1"]);
});

test("N20 ★관측에서 사라진 세션은 알림도 아니고 상태도 지우지 않는다 — 지우면 다시 보일 때 중복 알림", () => {
  const r = T([["s1", true], ["s2", false]], [["s2", false]]);   // s1 이 이번 관측에 없다
  assert.deepEqual(r.notify, []);
  assert.equal(r.next.get("s1"), true, "s1 의 awaiting 기억이 남아 있어야 한다");
  // 그 다음 관측에 s1 이 awaiting 인 채로 돌아와도 새 전이가 아니다.
  const again = pickAwaitingTransitions(r.next, [{ id: "s1", awaiting: true }]);
  assert.deepEqual(again.notify, [], "잠깐 안 보였다고 같은 대기를 다시 알리면 안 된다");
});

test("N21 처음 보는 세션이 이미 awaiting 이면 알린다 — 사용자가 놓친 알림이다", () => {
  const r = T([], [["새세션", true]]);
  assert.deepEqual(r.notify, ["새세션"]);
});

// ── 파생 규칙(#1891, dev 실측으로 발견) ────────────────────────────────────
// 앱 토큰의 도구 allowlist 가 비면 lively 툴이 0개라, 알림 권한만 선언한 앱이 정작 app_notify 를
// 못 부른다(403 "앱 권한 밖"). 그래서 매니페스트 파서가 notifications → app_notify 를 파생한다.
// 이 규칙이 사라지면 알림 기능 전체가 조용히 죽는다 — 권한은 있는데 도구가 없어서.

test("N22 ★notifications:true 는 app_notify 도구를 함의한다 — 없으면 알림이 통째로 막힌다", async () => {
  const { parseAppManifest } = await import("./manifest.js");
  const m = parseAppManifest({
    id: "notify-app", title: "알림 앱", version: "1.0.0",
    permissions: { notifications: true },
  });
  assert.ok(m.permissions.tools.includes("app_notify"), "app_notify 가 도구 allowlist 에 파생돼야 한다");
});

test("N23 알림 권한이 없으면 app_notify 도 파생되지 않는다", async () => {
  const { parseAppManifest } = await import("./manifest.js");
  const m = parseAppManifest({ id: "plain", title: "그냥 앱", version: "1.0.0" });
  assert.equal(m.permissions.notifications, false);
  assert.ok(!m.permissions.tools.includes("app_notify"));
});

test("N24 이미 적어 둔 도구 목록에 중복으로 넣지 않는다", async () => {
  const { parseAppManifest } = await import("./manifest.js");
  const m = parseAppManifest({
    id: "both", title: "둘 다", version: "1.0.0",
    permissions: { notifications: true, tools: ["app_notify", "knowledge_get"] },
  });
  assert.deepEqual(m.permissions.tools.filter((t: string) => t === "app_notify").length, 1);
});

// ── 빌트인 vs 서드파티 (2026-08-26 dev 실측으로 뒤집힌 규칙) ────────────────
// grant 가 답하는 질문은 "**남의 앱**이 내 이름으로 행동해도 되나" 다. ai-session 은 남의 앱이 아니라
// 지금 내가 쓰는 화면 자체다. 게다가 동의 창은 런치패드로 앱을 열 때만 뜨는데 세션은 그 경로로 열리지
// 않아, 아무도 ai-session grant 를 가진 적이 없었다 → 알림 이력이 한 사람에게만 쌓였다(기능이 반쯤 죽음).

test("N25 ★빌트인은 grant 없이도 알림을 보낸다 — 제품 자신에게 동의를 받지 않는다", () => {
  assert.equal(decideNotifyAllowed({
    appId: "ai-session", declaresNotifications: true, hasActiveGrant: false, isBuiltin: true,
  }), null);
});

test("N26 ★서드파티는 그대로 grant 를 요구한다(fail-closed 유지)", () => {
  assert.equal(decideNotifyAllowed({
    appId: "someone-app", declaresNotifications: true, hasActiveGrant: false, isBuiltin: false,
  }), "notify-grant-missing");
  // isBuiltin 을 아예 안 주면(구 호출부) 서드파티로 본다 — 안전한 기본값.
  assert.equal(decideNotifyAllowed({
    appId: "someone-app", declaresNotifications: true, hasActiveGrant: false,
  }), "notify-grant-missing");
});

test("N27 빌트인이어도 권한 선언이 없으면 거부한다 — 빌트인은 grant 면제이지 권한 면제가 아니다", () => {
  assert.equal(decideNotifyAllowed({
    appId: "browser", declaresNotifications: false, hasActiveGrant: true, isBuiltin: true,
  }), "notify-permission-missing");
});

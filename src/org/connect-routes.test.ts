// 외부 앱 연결 «길» 판정(org/connect-routes.ts) — 사양 R1~R18(#4970 — 설계 지식 onboarding-single-flow-connect-in-own-ai-4970 의 «길» 절).
//  실행: npm run build && node dist/org/connect-routes.test.js
import assert from "node:assert/strict";
import { decideRoutes, type AppRouteFacts, type RouteState } from "./connect-routes.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

type App = NonNullable<AppRouteFacts["app"]>;
const app = (o: Partial<App> = {}): App => ({ ready: true, heldBy: "workspace", canRegister: false, canCollect: false, meConnected: false, collecting: false, ...o });
const ai = (mine: NonNullable<AppRouteFacts["ai"]>["mine"], policy: NonNullable<AppRouteFacts["ai"]>["policy"] = "allowed") => ({ aiApp: "slack", policy, mine });
const token = (o: Partial<NonNullable<AppRouteFacts["token"]>> = {}) => ({ canCollect: true, meConnected: false, collecting: false, ...o });
/** 길 상태들 · 권하는 길의 종류 · 앞의 막힌 길 종류들 */
const view = (f: AppRouteFacts): { states: RouteState[]; rec: string | null; blocked: string[] } => {
  const d = decideRoutes(f);
  return { states: d.routes.map((r) => r.state), rec: d.recommended >= 0 ? d.routes[d.recommended]!.kind : null, blocked: d.blocked_before.map((i) => d.routes[i]!.kind) };
};

t("R1 매니지드 슬랙·라이블리 앱 준비 중·Claude 미연결 → 추천 ai · 앞에 «준비 중» app", () => {
  assert.deepEqual(view({ app: app({ ready: false, heldBy: "lively", canRegister: true }), ai: ai(null) }),
    { states: ["preparing", "connect"], rec: "ai", blocked: ["app"] });
});

t("R2 셀프호스트 슬랙·관리자·앱 미등록 → 추천 app(앱 등록은 지금 할 수 있는 일)", () => {
  assert.deepEqual(view({ app: app({ ready: false, canRegister: true }), ai: ai(null) }),
    { states: ["register", "connect"], rec: "app", blocked: [] });
});

t("R3 셀프호스트 슬랙·일반 구성원·앱 미등록 → 추천 ai · 앞에 «관리자에게 요청» app", () => {
  assert.deepEqual(view({ app: app({ ready: false }), ai: ai(null) }),
    { states: ["ask_admin", "connect"], rec: "ai", blocked: ["app"] });
});

t("R4 셀프호스트 리니어·일반 구성원·앱 미등록(다른 길 없음) → 추천은 막힌 app 그대로 · 앞의 막힌 길 없음", () => {
  assert.deepEqual(view({ app: app({ ready: false }) }), { states: ["ask_admin"], rec: "app", blocked: [] });
});

t("R5 앱 준비·남의 연결로 수집 중 → app «모으는 중» · 내가 미연결이어도 다시 연결하라고 안 한다", () => {
  assert.deepEqual(view({ app: app({ collecting: true }), ai: ai(null) }).states[0], "collecting");
  assert.equal(view({ app: app({ collecting: true }), ai: ai(null) }).rec, "app");
});

t("R6 ★ 라이블리 앱이 모으는 중이면 Claude 커넥터가 연결돼 있어도 app — 같은 자료를 두 길로 모으지 않는다", () => {
  assert.equal(view({ app: app({ collecting: true }), ai: ai("connected") }).rec, "app");
});

t("R7 ★ 앱은 준비됐지만 아무도 안 모음 · 내 Claude 슬랙 연결됨 → 추천 ai(이미 연결된 길 먼저 — A)", () => {
  assert.deepEqual(view({ app: app(), ai: ai("connected") }), { states: ["connect", "connected"], rec: "ai", blocked: [] });
});

t("R8 Claude 커넥터 다시 로그인 필요(needs-auth · failed) → ai «다시 연결» · 권하는 길", () => {
  for (const m of ["needs-auth", "failed"] as const) {
    const v = view({ app: app({ ready: false, heldBy: "lively" }), ai: ai(m) });
    assert.equal(v.states[1], "reconnect", m);
    assert.equal(v.rec, "ai", m);
  }
});

t("R9 정책 blocked·unknown(못 읽음) → ai «꺼짐» — 권하지 않는다(fail-closed) · 왜 꺼졌는지는 따로 싣는다", () => {
  for (const p of ["blocked", "unknown"] as const) {
    const v = view({ app: app({ ready: false, heldBy: "lively" }), ai: ai("connected", p) });
    assert.equal(v.states[1], "off", p);
    assert.equal(decideRoutes({ ai: ai("connected", p) }).routes[0]!.off_reason, p, `${p}: 관리자가 껐나 · 못 읽었나`);
    assert.equal(v.rec, "app", `${p}: 막힌 길만 남으면 첫 길`);
    assert.deepEqual(v.blocked, [], p);
  }
});

t("R10 깃허브 셀프호스트·일반 구성원·앱 미등록 → 추천 token · 앞에 «관리자에게 요청» app", () => {
  assert.deepEqual(view({ app: app({ ready: false }), token: token() }), { states: ["ask_admin", "connect"], rec: "token", blocked: ["app"] });
});

t("R11 깃허브 개인 토큰으로 모으는 중 → 추천 token(앱이 준비돼 있어도)", () => {
  assert.equal(view({ app: app(), token: token({ meConnected: true, collecting: true }) }).rec, "token");
});

t("R12 토큰 앱(깃랩)·미연결 → token «연결» 하나", () => {
  assert.deepEqual(view({ token: token() }), { states: ["connect"], rec: "token", blocked: [] });
  assert.deepEqual(view({ token: token({ meConnected: true, canCollect: false }) }).states, ["ask_admin"]);
});

t("R13 앱 준비·연결됐는데 수집 꺼짐 → 켤 수 있으면 «범위 정하기», 없으면 «관리자에게 요청»", () => {
  assert.deepEqual(view({ app: app({ meConnected: true, canCollect: true }) }).states, ["set_scope"]);
  assert.deepEqual(view({ app: app({ meConnected: true, canCollect: false }) }).states, ["ask_admin"]);
});

t("R14 (새 칸이 빈 경우) 내 커넥터 기록이 없음·못 읽음(null) · 끊음(removed) · 확인 중(pending·unknown) → ai «연결»", () => {
  for (const m of [null, "removed", "pending", "unknown"] as const) assert.equal(view({ ai: ai(m) }).states[0], "connect", String(m));
});

t("R15 (경계) 길이 하나도 없으면 추천 -1 · 모두 막히면 첫 길 · 앞의 막힌 길 없음", () => {
  const none = decideRoutes({});
  assert.deepEqual([none.routes.length, none.recommended, none.blocked_before], [0, -1, []]);
  assert.deepEqual(view({ app: app({ ready: false, heldBy: "lively" }), ai: ai(null, "blocked") }), { states: ["preparing", "off"], rec: "app", blocked: [] });
});

t("R16 배포 차이는 heldBy 하나 — 같은 사실이면 heldBy 만 바꿔 준비 중 ↔ 앱 등록·관리자에게", () => {
  assert.deepEqual(view({ app: app({ ready: false, heldBy: "lively", canRegister: true }) }).states, ["preparing"]);
  assert.deepEqual(view({ app: app({ ready: false, heldBy: "workspace", canRegister: true }) }).states, ["register"]);
  assert.deepEqual(view({ app: app({ ready: false, heldBy: "workspace", canRegister: false }) }).states, ["ask_admin"]);
  //  앱이 준비되면 heldBy 는 판정에 안 들어간다 — 매니지드·셀프호스트가 같은 길을 간다.
  for (const heldBy of ["lively", "workspace"] as const) assert.deepEqual(view({ app: app({ heldBy, meConnected: true, canCollect: true }) }).states, ["set_scope"], heldBy);
});

t("R17 ai 길은 그 커넥터의 앱 키를 싣는다(구글 = 지메일)", () => {
  const d = decideRoutes({ ai: { aiApp: "gmail", policy: "allowed", mine: null } });
  assert.equal(d.routes[0]!.ai_app, "gmail");
});

t("R18 서버에 Claude 로그인이 없으면(마지막 확인 not-logged-in) ai 길에 «로그인부터» — 연결할 때만", () => {
  const needs = (mine: NonNullable<AppRouteFacts["ai"]>["mine"], login: boolean | null, policy: NonNullable<AppRouteFacts["ai"]>["policy"] = "allowed") =>
    decideRoutes({ ai: { aiApp: "slack", policy, mine, login } }).routes[0]!.needs ?? null;
  assert.equal(needs(null, false), "claude_login", "연결 전 · 로그인 없음");
  assert.equal(needs("needs-auth", false), "claude_login", "다시 연결 · 로그인 없음");
  assert.equal(needs("connected", false), null, "이미 연결됨이면 할 일을 늘리지 않는다");
  assert.equal(needs(null, null), null, "모르면(확인한 적 없음) 말하지 않는다");
  assert.equal(needs(null, true), null);
  assert.equal(needs(null, false, "blocked"), null, "꺼진 길엔 붙이지 않는다");
  //  추천은 그대로 — 로그인은 그 길의 첫 걸음일 뿐 길을 막지 않는다.
  const d = decideRoutes({ app: app({ ready: false, heldBy: "lively" }), ai: { aiApp: "slack", policy: "allowed", mine: null, login: false } });
  assert.equal(d.routes[d.recommended]!.kind, "ai");
});

console.log(`connect-routes.test: ${pass} ok`);

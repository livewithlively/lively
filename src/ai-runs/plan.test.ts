// 앱 AI 실행 — 순수 판정 엣지 표 P1~P14(#4488 앱 v2-9 · 사양 spec.md). 실행: npm run build && node dist/ai-runs/plan.test.js
//  이게 틀리면: 작업별 설정이 앱별에 밀리거나, 구독이 남의 요청을 처리하거나(#4423), 단발이 컨테이너로 가거나, 스키마 어긋남을 맞음으로 읽는다.
import assert from "node:assert/strict";
import {
  accountSetRefusal, executorFor, extractJson, judgeOutput, overDailyBudget, parseAccountSettings, resolveAccount, runKindOf, runStatusOfJob, schemaInputError,
  schemaInstruction, seatShared, serviceSeatChange, serviceSeatConsented, subscriptionRefusal, validateJsonSchema, waitSecOf, WAIT_MAX_SEC,
  type AiAccountSettings, type ServiceSeat,
} from "./plan.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

// ── P1~P4 실행 계정 — 작업별 > 앱별 > 워크스페이스 기본값 > API 키 · 잡값은 버림 ──
{
  const s = parseAccountSettings({
    default: { kind: "subscription", member: "alice" }, default_model: "claude-opus-5-5",
    apps: { crm: { default: { kind: "api_key" }, jobs: { summarize: { kind: "subscription", member: "bob" }, "bad name!": { kind: "api_key" } } }, junk: 5 },
    garbage: true,
  });
  assert.deepEqual(s.default, { kind: "subscription", member: "alice" });
  assert.equal(s.default_model, "claude-opus-5-5");
  assert.deepEqual(Object.keys(s.apps!.crm!.jobs!), ["summarize"], "이름 꼴 밖 작업은 버린다");
  assert.equal(s.apps!.junk, undefined);
  assert.deepEqual(resolveAccount(s, "crm", "summarize", true), { account: { kind: "subscription", member: "bob" }, from: "job" });
  assert.deepEqual(resolveAccount(s, "crm", "other", true), { account: { kind: "api_key" }, from: "app" });
  assert.deepEqual(resolveAccount(s, "talk", null, true), { account: { kind: "subscription", member: "alice" }, from: "workspace" });
  assert.deepEqual(resolveAccount({}, "talk", null, true), { account: { kind: "api_key" }, from: "api_key" });
  assert.equal(resolveAccount({}, "talk", null, false), null, "설정도 키도 없으면 실행 계정 없음");
  assert.deepEqual(parseAccountSettings({ default: { kind: "subscription" } }), {}, "구성원 없는 구독은 버린다");
  assert.deepEqual(parseAccountSettings({ default_model: "-x" }), {}, "플래그 꼴 모델은 버린다");
  assert.deepEqual(parseAccountSettings(null), {});
  ok("P1~P4 실행 계정 — 작업별 > 앱별 > 워크스페이스 > API 키 · 잡값은 버림");
}

// ── P5~P6 작업 종류 · 실행 자리 ──
{
  assert.equal(runKindOf({}), "single");
  assert.equal(runKindOf({ files: [] }), "single");
  assert.equal(runKindOf({ files: ["a.md"] }), "agent");
  assert.equal(runKindOf({ project_id: 3 }), "agent");
  assert.equal(runKindOf({ cwd: "x" }), "agent");
  assert.equal(runKindOf({ agent: true }), "agent");
  assert.equal(executorFor("single", { kind: "api_key" }), "proxy", "단발 + API 키만 프록시");
  assert.equal(executorFor("single", { kind: "subscription", member: "a" }), "job");
  assert.equal(executorFor("agent", { kind: "api_key" }), "job");
  assert.equal(executorFor("agent", { kind: "subscription", member: "a" }), "job");
  ok("P5~P6 작업 종류 · 실행 자리 표(§3-E)");
}

// ── P7 구독 선(#4423 · 상민 2026-10-19) — 본인(어느 길이든) · 그 사람 세션에 초대받은 사람(그 세션에서) · 사람이 아니면 거절 ──
{
  const sub = { kind: "subscription" as const, member: "alice" };
  const alice = { member: "alice", kind: "member" as const }, bob = { member: "bob", kind: "member" as const };
  assert.equal(subscriptionRefusal({ kind: "api_key" }, bob, null), null, "API 키는 누구 요청이든");
  assert.equal(subscriptionRefusal(sub, alice, null), null, "본인 — 세션 매임 없이(앱 화면 · 도구 · REST 모두)");
  assert.equal(subscriptionRefusal(sub, alice, { owner: "carol", participant: true, human: true }), null, "본인이면 매인 세션이 남의 것이어도 본인");
  assert.match(subscriptionRefusal(sub, { member: "alice", kind: "app_server" }, null)!, /앱 서버/, "앱 서버 대리는 거절");
  assert.match(subscriptionRefusal(sub, { member: "alice", kind: "app_server" }, { owner: "alice", participant: true, human: true })!, /앱 서버/);
  assert.match(subscriptionRefusal(sub, bob, null)!, /초대받은 사람/, "남 — 세션 매임 없음");
  assert.equal(subscriptionRefusal(sub, bob, { owner: "alice", participant: true, human: true }), null, "남 — alice 세션에 초대받아 그 세션에서 보냄");
  assert.match(subscriptionRefusal(sub, bob, { owner: "alice", participant: false, human: true })!, /초대받은 사람/, "alice 세션이지만 들어갈 수 없는 사람");
  assert.match(subscriptionRefusal(sub, bob, { owner: "carol", participant: true, human: true })!, /초대받은 사람/, "남의(carol) 세션에 초대받은 것은 alice 구독과 무관");
  assert.match(subscriptionRefusal(sub, bob, { owner: null, participant: false, human: false })!, /사람이 보는 세션/, "없는 세션 — 확인할 수 없으면 막는다");
  assert.match(subscriptionRefusal(sub, alice, { owner: null, participant: false, human: false })!, /사람이 보는 세션/, "본인이라도 매인 세션을 모르면 막는다(fail-closed)");
  assert.match(subscriptionRefusal(sub, bob, { owner: "bob", participant: true, human: true })!, /초대받은 사람/, "제 세션에서 남의 구독을 고르면 거절");
  //  사람 세션이 아닌 곳(위탁·크론 헤드리스 task · 상시 managed · 앱 · 로그인)에 매인 요청은 본인 토큰이라도 거절 — 격리 리뷰 blocking 1.
  assert.match(subscriptionRefusal(sub, alice, { owner: "alice", participant: true, human: false })!, /사람이 보는 세션/, "본인 토큰의 위탁 세션");
  assert.match(subscriptionRefusal(sub, bob, { owner: "alice", participant: true, human: false })!, /사람이 보는 세션/, "초대받은 사람이라도 기계 세션이면");
  assert.equal(subscriptionRefusal({ kind: "api_key" }, alice, { owner: "alice", participant: true, human: false }), null, "API 키는 기계 세션이어도 된다");
  ok("P7 구독 선 — 본인(어느 길이든) · 구독 주인 세션에 초대받은 사람 · 사람 아니면 거절 · 세션 주인이 구독 주인이어야 · 기계 세션은 거절");
}

// ── P8 실행 계정 설정 권한 — 누구의 구독(본인만) × 어느 자리(워크스페이스 = 관리자 · 앱 = 관리자/책임자) ──
{
  const ws = { appId: null, appOwner: false };
  const mine = { appId: "crm", appOwner: true };
  const theirs = { appId: "crm", appOwner: false };
  assert.match(accountSetRefusal({ kind: "subscription", member: "alice" }, { member: "root", admin: true }, ws)!, /본인만/, "관리자도 남의 구독은 못 건다");
  assert.equal(accountSetRefusal({ kind: "subscription", member: "root" }, { member: "root", admin: true }, ws), null, "관리자가 자기 구독을 워크스페이스 기본값으로");
  assert.match(accountSetRefusal({ kind: "subscription", member: "alice" }, { member: "alice", admin: false }, ws)!, /관리자만/, "구성원은 워크스페이스 기본값을 못 바꾼다(남의 AI 실행을 막는 길)");
  assert.equal(accountSetRefusal({ kind: "subscription", member: "alice" }, { member: "alice", admin: false }, mine), null, "자기가 책임자인 앱에는 자기 구독을 건다");
  assert.match(accountSetRefusal({ kind: "subscription", member: "alice" }, { member: "alice", admin: false }, theirs)!, /책임자만/, "남의 앱은 못 건다");
  assert.equal(accountSetRefusal({ kind: "api_key" }, { member: "root", admin: true }, ws), null);
  assert.equal(accountSetRefusal({ kind: "api_key" }, { member: "alice", admin: false }, mine), null, "책임자는 제 앱을 API 키로 돌린다");
  assert.match(accountSetRefusal({ kind: "api_key" }, { member: "alice", admin: false }, ws)!, /관리자만/);
  assert.match(accountSetRefusal(null, { member: "alice", admin: false }, theirs)!, /책임자만/);
  assert.equal(accountSetRefusal(null, { member: "root", admin: true }, theirs), null);
  ok("P8 설정 권한 — 남의 구독 금지 · 워크스페이스 기본값은 관리자 · 앱은 관리자/책임자");
}

// ── P15 공용 시트(#5081 · 상민 2026-10-28) — 엣지 표 A1~A9 · B · C · H1(스크래치 spec.md) ──
{
  const NOW = "2026-10-28T00:00:00.000Z";
  const root = { member: "root", admin: true }, x = { member: "x", admin: false }, bob = { member: "bob", admin: false };
  const tx = { member: "x", exists: true, active: true, human: true, admin: false };
  const next = (r: ReturnType<typeof serviceSeatChange>): ServiceSeat | null => { assert.ok("next" in r, JSON.stringify(r)); return r.next; };
  const refused = (r: ReturnType<typeof serviceSeatChange>, status: number, re: RegExp): void => {
    assert.ok("refusal" in r, JSON.stringify(r)); assert.equal(r.status, status); assert.match(r.refusal, re);
  };
  const settingsOf = (seat: ServiceSeat | null): AiAccountSettings => (seat ? { service_seats: { x: seat } } : {});
  //  A1 관리자 승인 → 승인 줄만 · 아직 꺼짐 / A2 그 뒤 본인 동의 → 켜짐
  const a1 = next(serviceSeatChange(undefined, root, tx, true, NOW));
  assert.deepEqual(a1, { admin: { by: "root", at: NOW } });
  assert.equal(serviceSeatConsented(settingsOf(a1), "x"), false, "A1 승인만으로는 꺼짐");
  const a2 = next(serviceSeatChange(a1!, x, tx, true, NOW));
  assert.deepEqual(a2, { admin: { by: "root", at: NOW }, member: { at: NOW } });
  assert.equal(serviceSeatConsented(settingsOf(a2), "x"), true, "A2 둘 다 있으면 켜짐");
  //  A3 순서 무관 — 본인 동의 먼저
  const a3 = next(serviceSeatChange(next(serviceSeatChange(undefined, x, tx, true, NOW))!, root, tx, true, NOW));
  assert.equal(serviceSeatConsented(settingsOf(a3), "x"), true, "A3 본인 동의 → 관리자 승인 순서도 켜짐");
  //  A4 관리자 아닌 남 — 켜기도 끄기도 403
  refused(serviceSeatChange(a2!, bob, tx, true, NOW), 403, /관리자와 그 계정 본인만/);
  refused(serviceSeatChange(a2!, bob, tx, false, NOW), 403, /관리자와 그 계정 본인만/);
  //  A5 대상이 관리자 권한 · A6 비활성 · 사람 아님 · 없음
  refused(serviceSeatChange(undefined, root, { ...tx, admin: true }, true, NOW), 409, /관리자 권한/);
  refused(serviceSeatChange(undefined, root, { ...tx, active: false }, true, NOW), 409, /활성 사람 구성원/);
  refused(serviceSeatChange(undefined, root, { ...tx, human: false }, true, NOW), 409, /활성 사람 구성원/);
  refused(serviceSeatChange(undefined, root, { ...tx, exists: false }, true, NOW), 404, /구성원 없음/);
  //  A7 끄기 — 관리자든 본인이든 줄째 지운다(다시 켜려면 둘 다 새로)
  assert.equal(next(serviceSeatChange(a2!, root, tx, false, NOW)), null);
  assert.equal(next(serviceSeatChange(a2!, x, tx, false, NOW)), null);
  //  A8 본인 동의만 → 꺼짐
  assert.equal(serviceSeatConsented(settingsOf(next(serviceSeatChange(undefined, x, tx, true, NOW))), "x"), false, "A8 본인 동의만으로는 꺼짐");
  //  A9 관리자가 제 계정을 — 관리자 권한이라 지정 자체가 안 된다(혼자 켜는 길 없음)
  refused(serviceSeatChange(undefined, root, { member: "root", exists: true, active: true, human: true, admin: true }, true, NOW), 409, /관리자 권한/);

  //  H1 설정 해석 — 깨진 조각 · 빈 이름은 버리고, 한쪽만 있는 줄은 남긴다(대기 상태를 잃지 않게)
  const parsed = parseAccountSettings({ service_seats: {
    ok: { admin: { by: "root", at: NOW }, member: { at: NOW } }, half: { member: { at: NOW } }, badAdmin: { admin: { by: "", at: NOW } },
    noAt: { admin: { by: "root" } }, " ": { member: { at: NOW } }, junk: 5,
  } });
  assert.deepEqual(Object.keys(parsed.service_seats!).sort(), ["half", "ok"]);
  assert.equal(serviceSeatConsented(parsed, "ok"), true);
  assert.equal(serviceSeatConsented(parsed, "half"), false);
  assert.equal(serviceSeatConsented(parsed, "nobody"), false, "지정 없음 — 꺼짐");
  assert.equal(parseAccountSettings({ service_seats: { a: { junk: 1 } } }).service_seats, undefined, "남는 줄이 없으면 칸째 없다");

  //  B — 구독 선 + 공용 시트(seatShared · subscriptionRefusal)
  const sub = { kind: "subscription" as const, member: "seat" };
  const on = { consented: true, active: true, admin: false };
  const terms = (requesterActive: boolean, facts = on) => ({ facts, requesterActive });
  const alice = { member: "alice", kind: "member" as const }, srv = { member: "alice", kind: "app_server" as const };
  assert.equal(seatShared(on), true);
  assert.equal(seatShared({ ...on, consented: false }), false);
  assert.equal(seatShared({ ...on, active: false }), false);
  assert.equal(seatShared({ ...on, admin: true }), false, "관리자 계정은 공용으로 쓰지 않는다");
  assert.equal(seatShared(null), false);
  assert.match(subscriptionRefusal(sub, alice, null, null)!, /초대받은 사람/, "B1 지정 없음 — 남의 요청은 종전대로 403");
  assert.equal(subscriptionRefusal(sub, alice, null, terms(true)), null, "B2 켜짐 · 활성 구성원 · 세션 없음 → 받는다");
  assert.equal(subscriptionRefusal(sub, alice, { owner: "carol", participant: false, human: true }, terms(true)), null, "B2 남의 사람 세션에 매여도(시트 주인과 무관) 받는다");
  assert.match(subscriptionRefusal(sub, alice, null, terms(false))!, /활성 구성원이 보낸 요청에만/, "B3 보낸 사람이 활성 구성원 아님");
  assert.equal(subscriptionRefusal(sub, srv, null, terms(true)), null, "B4 앱 서버 + 사람 신원 → 받는다");
  assert.match(subscriptionRefusal(sub, { member: "app-server:t:crm", kind: "app_server" }, null, terms(false))!, /활성 구성원이 보낸 요청에만/, "B5 사람 신원 없는 앱 서버");
  assert.match(subscriptionRefusal(sub, srv, null, null)!, /앱 서버/, "B6 지정 없음 · 앱 서버 → 종전대로 403");
  assert.match(subscriptionRefusal(sub, alice, { owner: "alice", participant: true, human: false }, terms(true))!, /사람이 보는 세션/, "B7 기계 세션");
  assert.match(subscriptionRefusal(sub, alice, { owner: null, participant: false, human: false }, terms(true))!, /사람이 보는 세션/, "B7 모르는 세션");
  const adminSeat = terms(true, { ...on, admin: true });
  assert.match(subscriptionRefusal(sub, alice, null, adminSeat)!, /관리자 권한이 있어 공용으로 쓰지 않습니다/, "B9 시트가 관리자 — 까닭을 붙인다");
  assert.match(subscriptionRefusal(sub, srv, null, adminSeat)!, /관리자 권한이 있어/, "B9 앱 서버 쪽 문장에도");
  assert.equal(subscriptionRefusal(sub, { member: "seat", kind: "member" }, null, adminSeat), null, "B9 시트 계정 본인은 종전대로 본인");
  assert.match(subscriptionRefusal(sub, alice, null, terms(true, { ...on, active: false }))!, /초대받은 사람/, "B10 시트 비활성 → 공용 아님 · 종전 거절");
  assert.doesNotMatch(subscriptionRefusal(sub, alice, null, terms(true, { ...on, active: false }))!, /관리자 권한/);
  assert.equal(subscriptionRefusal({ kind: "api_key" }, srv, null, terms(false)), null, "API 키는 공용 시트 판정과 무관");

  //  C — 실행 계정으로 공용 시트를 거는 사람(관리자는 어느 자리든 · 앱 책임자는 못 건다)
  const ws = { appId: null, appOwner: false }, mine = { appId: "crm", appOwner: true };
  const seatAcct = { kind: "subscription" as const, member: "seat" };
  assert.equal(accountSetRefusal(seatAcct, root, ws, true), null, "C1 관리자가 켜진 시트를 워크스페이스 기본값으로");
  assert.equal(accountSetRefusal(seatAcct, root, mine, true), null, "C1 관리자가 앱 자리에도");
  assert.match(accountSetRefusal(seatAcct, root, ws, false)!, /본인만/, "C2 안 켜진 남의 구독은 관리자도 못 건다");
  assert.match(accountSetRefusal(seatAcct, { member: "alice", admin: false }, mine, true)!, /관리자만/, "C3 앱 책임자는 공용 시트를 못 건다");
  assert.equal(accountSetRefusal({ kind: "subscription", member: "alice" }, { member: "alice", admin: false }, mine, false), null, "C4 제 구독을 제 앱에(종전)");
  assert.equal(accountSetRefusal(seatAcct, { member: "seat", admin: false }, { appId: "crm", appOwner: true }, true), null, "시트 본인은 제 앱에 제 구독(종전)");
  ok("P15 공용 시트 — 두 동의(순서 무관 · 한쪽 거두면 둘 다) · 관리자 계정 불가 · 구성원 누구나(앱 서버 사람 대리 포함) · 남는 거절 · 거는 사람은 관리자");
}

// ── P9~P11 JSON 꺼내기 · 스키마 검사 · 판정 · 스키마 입력 ──
{
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('결과입니다:\n{"a":"}{","b":[1,2]}\n끝'), { a: "}{", b: [1, 2] }, "문자열 안 괄호를 건너뛴다");
  assert.deepEqual(extractJson("[1,2]"), [1, 2]);
  assert.equal(extractJson("그냥 글"), undefined);
  assert.equal(extractJson('{"a":1'), undefined);
  const schema = { type: "object", required: ["title", "tags"], additionalProperties: false,
    properties: { title: { type: "string", minLength: 1 }, tags: { type: "array", items: { type: "string" }, maxItems: 3 }, n: { type: ["integer", "null"] }, k: { enum: ["a", "b"] } } };
  assert.deepEqual(validateJsonSchema({ title: "t", tags: ["x"], n: null, k: "a" }, schema), []);
  const errs = validateJsonSchema({ title: "", tags: ["x", 1, "y", "z"], n: 1.5, k: "c", extra: 1 }, schema);
  assert.ok(errs.some((e) => e.includes("$.title")) && errs.some((e) => e.includes("$.tags[1]")) && errs.some((e) => e.includes("$.tags: 항목이 3개 이하"))
    && errs.some((e) => e.includes("$.n")) && errs.some((e) => e.includes("$.k")) && errs.some((e) => e.includes("$.extra")), errs.join(" | "));
  assert.deepEqual(validateJsonSchema({ title: "t" }, schema), ["$.tags: 필수 칸 없음"]);
  assert.deepEqual(validateJsonSchema("x", { anyOf: [{ type: "number" }, { type: "string" }] }), []);
  assert.equal(validateJsonSchema(5, { anyOf: [{ type: "string" }, { type: "boolean" }] }).length, 1);
  assert.deepEqual(validateJsonSchema(null, { type: "string", nullable: true }), []);
  assert.deepEqual(validateJsonSchema({ anything: 1 }, "not a schema"), [], "스키마가 아니면 검사 안 함");
  assert.deepEqual(validateJsonSchema(3, { type: "number", minimum: 3, maximum: 3 }), [], "경계값은 맞음");
  assert.equal(validateJsonSchema(4, { type: "number", maximum: 3 }).length, 1);
  const j1 = judgeOutput('{"title":"a","tags":[]}', schema);
  assert.ok(j1.ok && j1.json !== undefined);
  const j2 = judgeOutput("글만", schema);
  assert.ok(!j2.ok && j2.errors[0] === "JSON 을 찾지 못함");
  assert.ok(judgeOutput("아무 글", null).ok, "스키마 없으면 늘 맞음");
  assert.equal(schemaInputError(undefined), null);
  assert.match(schemaInputError([])!, /객체/);
  assert.match(schemaInputError({ x: "a".repeat(40_000) })!, /너무 큽니다/);
  assert.match(schemaInstruction({ type: "object" }), /JSON \*\*하나만\*\*/);
  ok("P9~P11 JSON 꺼내기(울타리 · 앞뒤 글 · 문자열 안 괄호) · 스키마 부분집합 · 경계값 · 입력 검사");
}

// ── P12~P14 하루 상한 · 작업 상태 → 실행 상태 · wait ──
{
  assert.equal(overDailyBudget(10, 0), false, "0 = 끔");
  assert.equal(overDailyBudget(10, 10), true, "사용 = 상한은 넘은 것");
  assert.equal(overDailyBudget(9, 10), false);
  assert.equal(runStatusOfJob("queued"), "queued");
  assert.equal(runStatusOfJob("starting"), "running");
  assert.equal(runStatusOfJob("running"), "running");
  assert.equal(runStatusOfJob("done"), "done");
  assert.equal(runStatusOfJob("timeout"), "failed");
  assert.equal(runStatusOfJob("failed"), "failed");
  assert.equal(runStatusOfJob("canceled"), "canceled");
  assert.equal(waitSecOf(undefined), 0);
  assert.equal(waitSecOf("abc"), 0);
  assert.equal(waitSecOf(-1), 0);
  assert.equal(waitSecOf(3.7), 3);
  assert.equal(waitSecOf(999), WAIT_MAX_SEC, "앞단 무응답 30초 안으로 접는다");
  assert.equal(WAIT_MAX_SEC < 30, true);
  ok("P12~P14 하루 상한 · 작업 상태 대응 · wait 접기");
}

console.log(`ai-runs plan.test: ${pass} passed`);

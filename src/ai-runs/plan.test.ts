// 앱 AI 실행 — 순수 판정 엣지 표 P1~P14(#4488 앱 v2-9 · 사양 spec.md). 실행: npm run build && node dist/ai-runs/plan.test.js
//  이게 틀리면: 작업별 설정이 앱별에 밀리거나, 구독이 남의 요청을 처리하거나(#4423), 단발이 컨테이너로 가거나, 스키마 어긋남을 맞음으로 읽는다.
import assert from "node:assert/strict";
import {
  accountSetRefusal, executorFor, extractJson, judgeOutput, overDailyBudget, parseAccountSettings, resolveAccount, runKindOf, runStatusOfJob, schemaInputError,
  schemaInstruction, subscriptionRefusal, validateJsonSchema, waitSecOf, WAIT_MAX_SEC,
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
  assert.equal(subscriptionRefusal(sub, alice, { owner: "carol", participant: true }), null, "본인이면 매인 세션이 남의 것이어도 본인");
  assert.match(subscriptionRefusal(sub, { member: "alice", kind: "app_server" }, null)!, /앱 서버/, "앱 서버 대리는 거절");
  assert.match(subscriptionRefusal(sub, { member: "alice", kind: "app_server" }, { owner: "alice", participant: true })!, /앱 서버/);
  assert.match(subscriptionRefusal(sub, bob, null)!, /초대받은 사람/, "남 — 세션 매임 없음");
  assert.equal(subscriptionRefusal(sub, bob, { owner: "alice", participant: true }), null, "남 — alice 세션에 초대받아 그 세션에서 보냄");
  assert.match(subscriptionRefusal(sub, bob, { owner: "alice", participant: false })!, /초대받은 사람/, "alice 세션이지만 들어갈 수 없는 사람");
  assert.match(subscriptionRefusal(sub, bob, { owner: "carol", participant: true })!, /초대받은 사람/, "남의(carol) 세션에 초대받은 것은 alice 구독과 무관");
  assert.match(subscriptionRefusal(sub, bob, { owner: null, participant: false })!, /초대받은 사람/, "없는 세션");
  assert.match(subscriptionRefusal(sub, bob, { owner: "bob", participant: true })!, /초대받은 사람/, "제 세션에서 남의 구독을 고르면 거절");
  ok("P7 구독 선 — 본인(어느 길이든) · 구독 주인 세션에 초대받은 사람 · 사람 아니면 거절 · 세션 주인이 구독 주인이어야");
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

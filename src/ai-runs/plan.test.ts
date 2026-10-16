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

// ── P7 구독 선(#4423) — 본인 · 앱 화면 · 사람만 ──
{
  const sub = { kind: "subscription" as const, member: "alice" };
  assert.equal(subscriptionRefusal({ kind: "api_key" }, { member: "bob", kind: "member" }, "mcp"), null, "API 키는 누구 요청이든");
  assert.equal(subscriptionRefusal(sub, { member: "alice", kind: "member" }, "app-ui"), null);
  assert.equal(subscriptionRefusal(sub, { member: "alice", kind: "member" }, "app-front"), null);
  assert.match(subscriptionRefusal(sub, { member: "bob", kind: "member" }, "app-ui")!, /본인이 보낸 요청에만/);
  assert.match(subscriptionRefusal(sub, { member: "alice", kind: "app_server" }, "app-ui")!, /앱 서버/);
  assert.match(subscriptionRefusal(sub, { member: "alice", kind: "member" }, "mcp")!, /앱 화면에서 사람이 보낸/);
  assert.match(subscriptionRefusal(sub, { member: "alice", kind: "member" }, undefined)!, /앱 화면/);
  ok("P7 구독 선 — 본인 · 앱 화면(app-ui/app-front) · 사람만");
}

// ── P8 실행 계정 설정 권한 — 구독은 본인만 · API 키·해제는 관리자 ──
{
  assert.equal(accountSetRefusal({ kind: "subscription", member: "alice" }, { member: "alice", admin: false }), null);
  assert.match(accountSetRefusal({ kind: "subscription", member: "alice" }, { member: "root", admin: true })!, /본인만/);
  assert.equal(accountSetRefusal({ kind: "api_key" }, { member: "root", admin: true }), null);
  assert.match(accountSetRefusal({ kind: "api_key" }, { member: "alice", admin: false })!, /관리자만/);
  assert.match(accountSetRefusal(null, { member: "alice", admin: false })!, /관리자만/);
  assert.equal(accountSetRefusal(null, { member: "root", admin: true }), null);
  ok("P8 설정 권한 — 관리자도 남의 구독을 못 건다");
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

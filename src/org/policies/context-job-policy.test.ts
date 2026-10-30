// 맥락관리 잡 실행 신원(#4012 T1 · #3994 D1) — 값 해석·출처 전수. 사양 엣지 표 A·B 의 모든 행.
//
//  왜 이 파일이 있나: 이 값이 틀리면 **사람이 안 보는 자리에서 도는 잡이 엉뚱한 사람의 자격으로 돈다**
//   (과금·귀속이 사람 손을 떠난다). 특히 «지웠다»(명시적 null) 와 «안 건드렸다»(키 부재) 를 뭉개면
//   관리탭에서 실행 멤버를 끈 순간 env 시드가 되살아나 **사람이 끈 것이 안 꺼진다** — A5 가 그 행이다.
import { strict as assert } from "node:assert";
import {
  normalizeContextJobPolicy, resolveContextJobPolicy, contextJobPolicySource,
  DEFAULT_CONTEXT_JOB_POLICY,
} from "./context-job-policy.js";

const ENV = "LIVELY_CONTEXT_JOB_RUNNER";
const withEnv = <T>(v: string | undefined, fn: () => T): T => {
  const old = process.env[ENV];
  if (v === undefined) delete process.env[ENV]; else process.env[ENV] = v;
  try { return fn(); } finally { if (old === undefined) delete process.env[ENV]; else process.env[ENV] = old; }
};
const who = (raw: unknown): string | null => normalizeContextJobPolicy(raw).runner_member;
const SEED = "seed-member";
const BAD_SEED = "bad value with spaces";

// ── A. 값 해석 ──
// A1 미설정 = 종전 동작(잡 params > created_by). 여기서 뭔가를 만들어 내면 안 된다.
withEnv(undefined, () => {
  assert.equal(who({}), null, "A1 빈 객체는 미설정");
  assert.deepEqual(resolveContextJobPolicy({}), DEFAULT_CONTEXT_JOB_POLICY, "A1 기본값과 같다");
});
// A2 env 시드는 **DB 에 키가 없을 때만** 채운다(구박스 호환).
withEnv(SEED, () => assert.equal(who({}), SEED, "A2 키 부재면 env 시드"));
// A3 시드도 같은 잣대 — 모양이 아니면 안 쓴다.
withEnv(BAD_SEED, () => assert.equal(who({}), null, "A3 잡값 시드는 미설정으로 접는다"));
// A4 DB 가 시드를 이긴다.
withEnv(SEED, () => assert.equal(who({ runner_member: "sangmin-yoon" }), "sangmin-yoon", "A4 DB 우선"));
// ★ A5 «지웠다» — 명시적 null 은 시드로 되살아나면 안 된다. 이 스킬의 '새 변수가 비었을 때' 행.
withEnv(SEED, () => assert.equal(who({ runner_member: null }), null, "A5 지운 것은 시드로 안 되살린다"));
// A6 빈 문자열도 «비웠다».
withEnv(SEED, () => assert.equal(who({ runner_member: "" }), null, "A6 빈 문자열 = 비움"));
// A7 앞뒤 공백은 다듬는다(관리탭 붙여넣기).
withEnv(undefined, () => assert.equal(who({ runner_member: "  sangmin-yoon  " }), "sangmin-yoon", "A7 다듬기"));
// A8 잡값은 신원 자리에 못 앉는다.
withEnv(undefined, () => {
  for (const [label, v] of [
    ["공백낀", "has space"], ["제어문자", "bad\nline"], ["숫자", 42], ["객체", { id: "x" }],
    ["선행대시", "-leading"], ["과길이", "a".repeat(200)], ["공백뿐", "   "], ["불리언", true],
  ] as Array<[string, unknown]>) {
    assert.equal(who({ runner_member: v }), null, `A8 ${label} 거부`);
  }
});
// A9 구 DB(컬럼 부재) — raw 자체가 null/undefined.
withEnv(undefined, () => {
  assert.equal(who(null), null, "A9 null raw");
  assert.equal(who(undefined), null, "A9 undefined raw");
  assert.equal(who("문자열"), null, "A9 객체가 아닌 raw");
});
// A10 컬럼 부재는 «지움» 이 아니다 — 시드가 채운다.
withEnv(SEED, () => assert.equal(who(null), SEED, "A10 컬럼 부재 + 시드 → 시드"));
// A11 이메일도 받는다(memberOwner 가 해소).
withEnv(undefined, () => assert.equal(who({ runner_member: "sangmin.yoon@lvly.io" }), "sangmin.yoon@lvly.io", "A11 이메일"));

// ── B. 출처(관리 UI 안내) ──
withEnv(SEED, () => {
  assert.equal(contextJobPolicySource({ runner_member: "x" }), "db", "B1 값이 있으면 db");
  assert.equal(contextJobPolicySource({ runner_member: null }), "db", "B2 지운 것도 관리탭이 정한 상태");
  assert.equal(contextJobPolicySource({}), "env", "B3 키 부재 + 유효 시드 → env");
});
withEnv(undefined, () => assert.equal(contextJobPolicySource({}), "default", "B4 시드 없음 → default"));
withEnv(BAD_SEED, () => assert.equal(contextJobPolicySource({}), "default", "B5 못 쓰는 시드는 출처로도 안 센다"));

console.log("✓ context-job-policy — 우선순위·지움 구분·잡값 방어 (A1~A11 · B1~B5)");

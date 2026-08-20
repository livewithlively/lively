// 정책 노브 배관 잠금(#1675 리뷰 후속) — **노브를 추가하면 저장 경로까지 반드시 잇게** 강제한다.
//
// 왜 필요한가(실측): #1675 가 정책 노브 4개(pressure_swap_pct · keep_failed_sessions ·
//  failed_session_ttl_min · auth_fail_stop_cron)를 추가하면서 `definePolicy` 선언과 관리탭 UI 는 고쳤는데
//  **capability 의 REST 입력 검증부를 못 고쳤다.** 그 층은 필드를 화이트리스트로 하나씩 옮겨 담고, zod 는
//  미선언 하위 키를 strip 한다 — 결과는 **관리탭이 200 을 받고 "저장됨" 토스트를 띄우는데 값은 사라지는**
//  상태였다. 정책의 절반(스왑 축)은 그래서 env 로만 켤 수 있었고, 코드 리뷰 전까지 아무도 몰랐다.
//
// 같은 실수를 다시 하지 못하게, 이 테스트가 **정책 타입의 키 목록**을 그 층의 소스와 대조한다.
//  (레포 선례: scheduler/cron-action-allowlist.test.ts 가 DB CHECK 와 액션 레지스트리를 같은 방식으로 잠근다.)
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DELEGATE_POLICY } from "./delegate-policy.js";
import { DEFAULT_SESSION_RECLAIM_POLICY } from "../../sessions/session-reclaim-policy.js";

// dist/org/policies/*.test.js → 레포 루트
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const capPath = path.join(root, "src", "capabilities", "delivery", "runtime-config.ts");
const src = fs.readFileSync(capPath, "utf8");

// 배선 단언 — 엉뚱한 파일을 읽고 조용히 통과하지 않게(vacuous 방지).
assert.ok(src.includes("session_reclaim_policy"), "runtime-config capability 를 못 찾았다(테스트가 대상을 잃음)");
assert.ok(src.includes("delegate_policy"), "delegate_policy 처리부를 못 찾았다");

/** 그 정책 블록의 본문만 잘라낸다 — 다른 정책 블록의 같은 이름 필드에 속지 않기 위해. */
function blockOf(policyKey: string): string {
  const start = src.indexOf(`if (input.${policyKey} !== undefined) {`);
  assert.ok(start > 0, `capability 에 ${policyKey} 입력 처리 블록이 없다`);
  const end = src.indexOf(`patch.${policyKey} = patchIn;`, start);
  assert.ok(end > start, `${policyKey} 블록의 끝(patch 대입)을 못 찾았다`);
  return src.slice(start, end);
}

/** zod 스키마에서 그 정책의 z.object 본문. */
function zodOf(policyKey: string): string {
  const start = src.indexOf(`${policyKey}: z.object({`);
  assert.ok(start > 0, `zod 스키마에 ${policyKey} 가 없다`);
  const end = src.indexOf("}).optional()", start);
  assert.ok(end > start, `${policyKey} zod 블록의 끝을 못 찾았다`);
  return src.slice(start, end);
}

const TARGETS: Array<{ key: string; knobs: string[] }> = [
  { key: "session_reclaim_policy", knobs: Object.keys(DEFAULT_SESSION_RECLAIM_POLICY) },
  { key: "delegate_policy", knobs: Object.keys(DEFAULT_DELEGATE_POLICY) },
];
for (const { key: policyKey, knobs } of TARGETS) {
  const validate = blockOf(policyKey);
  const zod = zodOf(policyKey);
  for (const knob of knobs) {
    assert.ok(validate.includes(knob),
      `${policyKey}.${knob} 가 capability 검증부에 없다 — 관리탭에서 저장해도 값이 조용히 버려진다`
      + ` (src/capabilities/delivery/runtime-config.ts 의 그 블록에 필드를 추가하라)`);
    assert.ok(zod.includes(knob),
      `${policyKey}.${knob} 가 zod 스키마에 없다 — 미선언 하위 키는 strip 되어 요청이 200 인데 값이 사라진다`);
  }
}

console.log("policy-knob-wiring.test: ok (정책 노브 ↔ 저장 경로 배관 잠금)");

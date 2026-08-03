// 크론 액션 허용목록 정합 잠금(#1419) — DB 제약(CRON_ACTION_ALLOWLIST)과 화면 드롭다운(CRON_ACTIONS)이
//  같은 집합을 가리키는지. DB 무의존 순수 대조.
//  실행: npm run build && node dist/scheduler/cron-action-allowlist.test.js
//
//  왜 이 테스트가 있나 — **실제로 어긋났었다.**
//   #1419 T5 가 관리기를 만들면서 CRON_ACTIONS 에 'run_managers' 를 추가했는데 org_cron 의 CHECK 제약을
//   안 고쳤다. 증상: [설정 ▸ 자동화 ▸ 스케줄] 드롭다운에 '관리기 실행'이 **보이는데**, 고르고 저장하면
//   제약 위반으로 실패한다. 즉 관리기 4종에 자동 실행 경로가 아예 없었다.
//   조용한 이유: 실패가 크론을 **저장할 때만** 나고, 그때까지는 화면·코드·문서 어디서도 모순이 안 보인다.
//   (T5 의 요구는 '4종 전부 실동작'이었고 수동 실행은 됐으니 통과한 것처럼 보였다.)
//
//  방향을 둘 다 본다:
//   · 레지스트리에 있는데 허용목록에 없다 → 위 사고(저장 실패). 가장 위험하다.
//   · 허용목록에 있는데 레지스트리에 없다 → 죽은 액션. 그 값으로 저장된 잡은 스케줄러가 실행할 수
//     없어 매 틱 조용히 넘어간다(잡은 'enabled' 인데 아무 일도 안 하는 상태).
import assert from "node:assert/strict";
import { CRON_ACTION_ALLOWLIST } from "../org/schema/sessions-infra.js";
import { CRON_ACTIONS } from "./registry.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const allow = new Set<string>(CRON_ACTION_ALLOWLIST);
const registry = new Set(CRON_ACTIONS.map((a) => a.key));

t("레지스트리의 모든 액션이 DB 허용목록에 있다 — 없으면 저장이 제약 위반으로 실패한다", () => {
  const missing = [...registry].filter((k) => !allow.has(k));
  assert.deepEqual(missing, [],
    `화면은 제공하는데 DB 가 거부하는 액션: ${missing.join(", ")} — sessions-infra.ts 의 CRON_ACTION_ALLOWLIST 에 추가하라`);
});

t("허용목록에 죽은 액션이 없다 — 실행기가 없으면 잡이 조용히 아무 일도 안 한다", () => {
  const dead = [...allow].filter((k) => !registry.has(k));
  assert.deepEqual(dead, [],
    `DB 는 허용하는데 실행기가 없는 액션: ${dead.join(", ")} — registry.ts 에 추가하거나 허용목록에서 빼라`);
});

t("허용목록에 중복이 없다", () => {
  // 중복은 CHECK 문자열만 길어지고 아무 효과가 없다 — 손으로 관리하던 흔적이 남았다는 신호다.
  assert.equal(allow.size, CRON_ACTION_ALLOWLIST.length,
    "CRON_ACTION_ALLOWLIST 에 중복 키가 있다");
});

t("관리기 실행이 실제로 등록 가능하다 [#1419 T5 회귀]", () => {
  // 위 두 단언의 특수 사례를 이름으로 못박는다 — 이 키가 다시 빠지면 무엇이 깨지는지 바로 읽히게.
  assert.ok(allow.has("run_managers"), "run_managers 가 DB 허용목록에 없다 — 관리기를 크론에 등록할 수 없다");
  assert.ok(registry.has("run_managers"), "run_managers 실행기가 없다");
});

console.log(`\n${pass} passed`);

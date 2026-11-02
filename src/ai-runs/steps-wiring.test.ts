// 도구 호출 단계(org_agent_job.steps)의 운영 배선과 롤 창 규칙.
//  ① 배선 — 읽기 의존(jobSteps)은 필수라 줄이 빠지면 빌드가 막지만, 같은 꼴의 다른 함수로 잘못 이으면 타입 검사도 서비스 시험도 초록인 채 단계가 안 보인다(effort-wiring.test 와 같은 꼴).
//  ② 롤 창 — 매니지드 롤은 새 게이트웨이를 먼저 띄우고 공용 DB 마이그레이션을 맨 끝에 돌린다. 이 칸이 COLS · 박동 · 끝내기 문장에 들어가면 그 몇 분 동안 작업 행의
//   모든 읽기 · 쓰기가 깨진다. 칸 쓰기 · 읽기의 실제 길과 칸이 없을 때는 실 PG(agent-jobs store.pg-test I5)가 본다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string): string => readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
let pass = 0;
const t = (name: string, fn: () => void): void => { try { fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; } pass++; console.log(`ok  ${name}`); };

t("SW1 실행 보기의 단계는 작업 행의 단계 읽기로 잇는다", () => {
  assert.match(read("ai-runs/live.ts"), /jobSteps: async \(jobId\) => \(await import\("\.\.\/agent-jobs\/store\.js"\)\)\.agentJobSteps\(jobId\),/);
});

t("SW2 단계 칸은 COLS 와 박동 · 끝내기 문장 밖이다 · 쓰기와 읽기는 같은 칸(STEPS_COL)이다 · 마이그레이션이 같은 이름의 칸을 만든다", () => {
  const store = read("agent-jobs/store.ts");
  const cols = /const COLS = `([^`]*)`/.exec(store)?.[1];
  assert.ok(cols, "COLS 를 못 찾았다 — 시험 전제 붕괴");
  assert.doesNotMatch(cols, /\bsteps\b/);
  const fn = (name: string): string => {
    const at = store.indexOf(`export async function ${name}(`);
    assert.ok(at >= 0, `${name} 를 못 찾았다 — 시험 전제 붕괴`);
    return store.slice(at, store.indexOf("\n}\n", at));
  };
  assert.doesNotMatch(fn("tickAgentJob"), /\bsteps\b/);
  assert.doesNotMatch(fn("finishAgentJob"), /\bsteps\b/);
  assert.match(store, /export const STEPS_COL = "steps";/);
  assert.match(store, /UPDATE org_agent_job SET \$\{STEPS_COL\}=\$2::jsonb, updated_at=now\(\) WHERE id=\$1 AND status='running'/);
  assert.match(store, /SELECT \$\{STEPS_COL\} AS s FROM org_agent_job WHERE id=\$1/);
  assert.match(read("org/schema/sessions-infra.ts"), /ALTER TABLE org_agent_job ADD COLUMN IF NOT EXISTS steps JSONB/);
});

console.log(`steps-wiring.test: ${pass} passed`);

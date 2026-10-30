// «라이블리 MCP 만»(ai.mcp_only)의 운영 배선 — 값을 읽는 의존은 필수라(타입 검사) 줄이 빠지면 빌드가 막지만, 같은 꼴(Promise<boolean>)의 다른 함수로
//  잘못 이으면 타입 검사도 서비스 시험도 초록인 채 그 작업들이 내장 도구를 연 채 돈다(격리 리뷰 — 예: agentJobSharedSeat 로 이음).
//  그래서 배선 줄을 소스에서 직접 본다(instructions-wiring.test 와 같은 꼴). 칸 쓰기 · 읽기의 실제 길은 실 PG agent-jobs store.pg-test 가 본다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string): string => readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
let pass = 0;
const t = (name: string, fn: () => void): void => { try { fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; } pass++; console.log(`ok  ${name}`); };

t("MW1 접수 — AI 실행의 «MCP 만» 읽기는 부른 사람(주소)의 판에서 읽는 함수(resolveJobMcpOnly)로 배선된다", () => {
  assert.match(read("ai-runs/live.ts"), /mcpOnly: async \(app, who, job\) => \(await import\("\.\.\/apps\/app-job-mcp-only\.js"\)\)\.resolveJobMcpOnly\(app, who, job\),/);
});

t("MW2 형식 재시도 · 이어받기 — 원래 작업 행의 «MCP 만» 칸을 읽는 함수로 배선된다", () => {
  assert.match(read("ai-runs/live.ts"), /jobMcpOnly: async \(jobId\) => \(await import\("\.\.\/agent-jobs\/store\.js"\)\)\.agentJobMcpOnly\(jobId\),/);
});

t("MW3 판 부트 · 사람이 보내는 작업의 이어받기 — 작업 행의 «MCP 만» 칸을 읽는 함수로 배선된다", () => {
  assert.match(read("agent-jobs/live.ts"), /jobMcpOnly: async \(job\) => \(await import\("\.\/store\.js"\)\)\.agentJobMcpOnly\(job\.id\),/);
});

t("MW4 작업 행 — 쓰기는 MCP 만일 때 그 칸에 true, 읽기는 같은 칸(MCP_ONLY_COL)이다", () => {
  const store = read("agent-jobs/store.ts");
  assert.match(store, /export const MCP_ONLY_COL = "mcp_only";/);
  assert.match(store, /\$\{mcpOnly \? `, \$\{MCP_ONLY_COL\}` : ""\}/);
  assert.match(store, /SELECT \$\{MCP_ONLY_COL\} AS m FROM org_agent_job WHERE id=\$1/);
});

console.log(`# ${pass} pass`);

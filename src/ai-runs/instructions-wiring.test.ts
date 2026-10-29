// 앱 판 지시(#5082)의 운영 배선 — 세 의존이 선택 항목이라(시험이 «배선이 없으면 지시 없음» 을 정상으로 본다) 운영 배선 줄이 빠지면
//  기능 전체가 조용히 꺼진다: 지시도 잠금도 없이 작업 폴더의 CLAUDE.md 를 읽는다(격리 리뷰 — 줄을 지워도 모든 시험이 초록이었다).
//  그래서 배선 줄을 소스에서 직접 본다(auth/http-auth-gate.test G6 과 같은 꼴). 실제 길은 실 PG app-bundles D14 · EC2 끝단이 본다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string): string => readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
let pass = 0;
const t = (name: string, fn: () => void): void => { try { fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; } pass++; console.log(`ok  ${name}`); };

t("W1 접수 — AI 실행의 지시 읽기는 부른 사람(주소)의 판에서 읽는 함수(resolveJobInstructions)로 배선된다", () => {
  assert.match(read("ai-runs/live.ts"), /instructions: async \(app, who, job\) => \(await import\("\.\.\/apps\/app-job-instructions\.js"\)\)\.resolveJobInstructions\(app, who, job\),/);
});

t("W2 형식 재시도 — 원래 작업 행의 지시를 읽는 함수로 배선된다", () => {
  assert.match(read("ai-runs/live.ts"), /jobInstructions: async \(jobId\) => \(await import\("\.\.\/agent-jobs\/store\.js"\)\)\.agentJobAppInstructions\(jobId\),/);
});

t("W3 판 부트 — 판이 받는 시스템 지시는 작업 행에 실린 글이다", () => {
  assert.match(read("agent-jobs/live.ts"), /jobSystem: async \(job\) => \(await import\("\.\/store\.js"\)\)\.agentJobAppInstructions\(job\.id\),/);
});

t("W4 접수가 지시를 작업 행으로 넘긴다 — 접수 매핑(agentJobOfRun)과 작업 행 쓰기(insertAgentJob)", () => {
  assert.match(read("ai-runs/service.ts"), /sharedSeat: j\.sharedSeat, appInstructions: j\.appInstructions,/);
  assert.match(read("ai-runs/live.ts"), /svc\.enqueueAgentJob\(ai\.agentJobOfRun\(j, \{/);
  assert.match(read("agent-jobs/store.ts"), /const instr = typeof j\.appInstructions === "string" && j\.appInstructions !== "" \? j\.appInstructions : null;/);
});

console.log(`# ${pass} pass`);

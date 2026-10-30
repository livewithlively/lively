// 작업별 라이블리 도구 허용 목록(ai.tools)의 운영 배선 — 값을 읽는 의존은 필수라(타입 검사) 줄이 빠지면 빌드가 막지만, 같은 꼴(Promise<string[] | null>)의
//  다른 함수로 잘못 이으면 타입 검사도 서비스 시험도 초록인 채 그 작업들이 앱 동의 전체로 돈다. 판이 뜬 뒤의 두 길(토큰 굽기 · /mcp 도구 목록)도
//  live 배선이라 서비스 시험이 닿지 않는다. 그래서 배선 줄을 소스에서 직접 본다(mcp-only-wiring.test 와 같은 꼴).
//  칸 쓰기 · 읽기와 토큰 상한의 실제 길은 실 PG(agent-jobs store.pg-test · org/store token-revoke.pg-test)가 본다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string): string => readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
let pass = 0;
const t = (name: string, fn: () => void): void => { try { fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; } pass++; console.log(`ok  ${name}`); };

t("TW1 접수 — AI 실행의 허용 목록 읽기는 부른 사람(주소)의 판에서 읽는 함수(resolveJobTools)로 배선된다", () => {
  assert.match(read("ai-runs/live.ts"), /toolAllowlist: async \(app, who, job\) => \(await import\("\.\.\/apps\/app-job-tools\.js"\)\)\.resolveJobTools\(app, who, job\),/);
});

t("TW2 형식 재시도 · 이어받기 — 원래 작업 행의 허용 목록 칸을 읽는 함수로 배선된다", () => {
  assert.match(read("ai-runs/live.ts"), /jobToolAllowlist: async \(jobId\) => \(await import\("\.\.\/agent-jobs\/store\.js"\)\)\.agentJobToolAllowlist\(jobId\),/);
});

t("TW3 판 부트 · 사람이 보내는 작업의 이어받기 — 작업 행의 허용 목록 칸을 읽는 함수로 배선된다", () => {
  assert.match(read("agent-jobs/live.ts"), /jobToolAllowlist: async \(job\) => \(await import\("\.\/store\.js"\)\)\.agentJobToolAllowlist\(job\.id\),/);
});

t("TW4 토큰 굽기 — 상한이 앱 토큰 발급에 실리고, 앱 아닌 작업에 실려 있으면 굽지 않는다", () => {
  const live = read("agent-jobs/live.ts");
  assert.match(live, /mintMcpToken: async \(job, \{ toolCeiling \}\) => \{/);
  assert.match(live, /mintAppToken\(who, job\.app_id, "agent-job", \{ \.\.\.jobAppTokenOpts\(job, ttlSec, shared\), toolCeiling \}\)/);
  assert.match(live, /if \(toolCeiling != null\) throw new Error\(/);
  assert.match(read("apps/principal.ts"), /\.\.\.\(opts\.toolCeiling != null \? \{ toolCeiling: opts\.toolCeiling \} : \{\}\),/);
});

t("TW5 /mcp — 토큰의 상한이 도구 목록(buildServer)에 넘어간다 · 검증한 상한이 사람(LivelyUser)에 실린다", () => {
  assert.match(read("boot/mcp-transport.ts"), /buildServer\(overrides, alwaysLoad, harness, readOnly, incognito, appId, user\?\.toolCeiling \?\? null\)/);
  assert.match(read("org/store/tokens.ts"), /\.\.\.\(toolCeiling != null \? \{ toolCeiling \} : \{\}\),/);
  //  bearer 는 검증 결과를 펼쳐(…identity) 사람으로 옮긴다 — 칸을 하나씩 고르는 꼴로 바뀌면 상한이 빠진다.
  assert.match(read("auth/bearer.ts"), /const \{ clientId, resource, expiresAt, appId, \.\.\.identity \} = dbUser;/);
  assert.match(read("auth/bearer.ts"), /\.\.\.identity, tokenSource: "db"/);
});

t("TW6 작업 행 — 쓰기는 목록이 있을 때 그 칸에, 읽기는 같은 칸(TOOL_ALLOWLIST_COL)이다", () => {
  const store = read("agent-jobs/store.ts");
  assert.match(store, /export const TOOL_ALLOWLIST_COL = "tool_allowlist";/);
  assert.match(store, /\$\{toolsRef \? `, \$\{TOOL_ALLOWLIST_COL\}` : ""\}/);
  assert.match(store, /\$\{toolsRef \? `, \$\{toolsRef\}::jsonb` : ""\}/);
  assert.match(store, /SELECT \$\{TOOL_ALLOWLIST_COL\} AS t FROM org_agent_job WHERE id=\$1/);
});

console.log(`# ${pass} pass`);

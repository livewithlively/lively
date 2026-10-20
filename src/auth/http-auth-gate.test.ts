// 앱 주체 문(#4483 · #4891) — 어느 토큰을 어느 길에서 받나. 사람 홈 없는 작업 AI 의 토큰(앱 서버 급 주체)은 능력 API · /mcp 에서만 받고
//  그 밖(터미널 · 파일 · 웹 라우트 — 사람 이름으로 세션을 열거나 파일 · 계정을 만지는 길)은 거부한다. 무조건 통과 도구(EXEMPT)도 꺼진다.
//  판정은 순수 함수(appPrincipalGate) 표로, 문을 어디에 어떤 갈래로 달았나는 소스로 잰다(문 하나가 빠지면 그 길이 열린다).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import type { LivelyUser } from "../context.js";
import { appPrincipalGate, type AppPrincipalGateMode } from "./http-auth.js";
import { appServerUserId } from "../apps/app-server-id.js";
import { APP_TOOL_EXEMPT, decideAppTool } from "../apps/principal.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  try { fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++; console.log(`ok  ${name}`);
};

const TENANT = "0a1b2c3d-0000-4000-8000-000000000001";
const who = (o: Partial<LivelyUser>): LivelyUser => ({ userId: "alice", email: "", scopes: ["context"], projects: ["*"], ...o });
const raw = who({ userId: appServerUserId(TENANT, "crm"), appId: "crm", scopes: [] });   // 멤버 없는 앱 서버 토큰
const jobAi = who({ appId: "crm", appServer: true });                                    // #4891 앱 서버 급 토큰
const appSession = who({ appId: "crm" });                                                // 앱 세션 토큰(사람 홈 있는 자리)
const human = who({});
const MODES: AppPrincipalGateMode[] = ["cap", "mcp", "deny"];

t("G1 앱 서버 토큰 — 능력 API 에서만 사람 신원으로 바꾸고(resolve) /mcp · 그 밖은 거부", () => {
  assert.deepEqual(MODES.map((m) => appPrincipalGate(raw, m)), ["resolve", "deny", "deny"]);
});

t("G2 앱 서버 급 주체(홈 없는 작업 AI) — 능력 API · /mcp 는 그대로(앱 도구 게이트가 지킨다) · 그 밖(세션 · 파일 · 계정 길)은 거부", () => {
  assert.deepEqual(MODES.map((m) => appPrincipalGate(jobAi, m)), ["next", "next", "deny"]);
});

t("G3 앱 세션 토큰 · 사람 · 신원 없음은 어느 문에서도 그대로(무회귀)", () => {
  for (const u of [appSession, human, undefined]) assert.deepEqual(MODES.map((m) => appPrincipalGate(u, m)), ["next", "next", "next"], JSON.stringify(u));
});

t("G4 문 배선 — /mcp 는 mcp 갈래 · /install 은 deny · 능력 REST 만 cap · 그 밖 sessionOrBearer 는 deny", () => {
  const SRC = readFileSync(new URL("../../src/auth/http-auth.ts", import.meta.url), "utf8");
  const mcp = SRC.slice(SRC.indexOf("export function bearerWithResourceMetadata("), SRC.indexOf("export function sessionOrBearer("));
  assert.match(mcp, /export function bearerWithResourceMetadata\(verifier: BearerVerifier, mode: AppPrincipalGateMode = "mcp"\)/);
  assert.match(mcp, /const gate = appServerGate\(mode\);/);
  const IDX = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
  assert.match(IDX, /app\.get\("\/install", bearerWithResourceMetadata\(verifier, "deny"\),/);
  assert.equal(IDX.split("bearerWithResourceMetadata(verifier").length - 1, 2, "/mcp(기본 mcp) 하나 · /install(deny) 하나");
  const sob = SRC.slice(SRC.indexOf("export function sessionOrBearer("));
  assert.match(sob, /const gate = appServerGate\(opts\.appServer === true \? "cap" : "deny"\);/);
  //  능력 REST 마운트 하나만 cap 을 단다(web.ts authCap) — 소스 전체(시험 제외)를 훑어 다른 자리가 appServer:true 로 열면 빨개진다(증분 재검토).
  const root = new URL("../../src/", import.meta.url);
  const hits: string[] = [];
  const walk = (dir: URL): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { walk(new URL(`${e.name}/`, dir)); continue; }
      if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
      const f = new URL(e.name, dir);
      if (/sessionOrBearer\([^)]*appServer:\s*true/.test(readFileSync(f, "utf8"))) hits.push(f.pathname.replace(root.pathname, ""));
    }
  };
  walk(root);
  assert.deepEqual(hits, ["web.ts"], JSON.stringify(hits));
  const WEB = readFileSync(new URL("../../src/web.ts", import.meta.url), "utf8");
  assert.equal(WEB.split("sessionOrBearer(verifier, { appServer: true })").length - 1, 1);
});

t("G5 무조건 통과 도구(EXEMPT)는 앱 서버 급 주체에 꺼진다 — 동의에 없으면 거부 · 앱 세션 토큰은 종전대로 통과", () => {
  const exempt = [...APP_TOOL_EXEMPT][0]!;
  assert.ok(exempt, "EXEMPT 목록이 비었다(관측 장치 확인)");
  assert.equal(decideAppTool("crm", [], exempt, !jobAi.appServer), false);
  assert.equal(decideAppTool("crm", [], exempt, !appSession.appServer), true);
});

t("G6 표시가 토큰까지 가는 사슬 — 작업 AI 토큰 옵션(plan.jobAppTokenOpts) → 앱 토큰 발급(principal.mintAppToken) → 토큰 저장(tokens.mintToken) · 접수 매핑(ai-runs agentJobOfRun)", () => {
  const read = (rel: string): string => readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
  assert.match(read("agent-jobs/live.ts"), /const t = await mintAppToken\(seat, job\.app_id, "agent-job", jobAppTokenOpts\(job, ttlSec\)\);/);
  assert.match(read("apps/principal.ts"), /\.\.\.\(opts\.appServerPrincipal === true \? \{ appServerPrincipal: true \} : \{\}\),/);
  const tok = read("org/store/tokens.ts");
  assert.match(tok, /input\.followMemberScopes === true, input\.appServerPrincipal === true\]/);
  assert.match(tok, /\.\.\.\(appServer \? \{ appServer: true as const \} : \{\}\),/);
  assert.match(read("ai-runs/live.ts"), /svc\.enqueueAgentJob\(ai\.agentJobOfRun\(j, \{/);
});

console.log(`# ${pass} pass`);

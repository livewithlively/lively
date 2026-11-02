// 생각 깊이(effort — 하네스 `claude -p --effort`)의 입력 표면과 운영 배선.
//  ① 입력 — MCP 는 SDK 가 z.object(input) 로 거르고, REST 는 어댑터의 enum 가드(capabilities/index.restMounts)가 거른다. 두 길 모두 다섯 값 밖이면
//   핸들러 전에 400 이어야 한다(서비스의 검사는 그 밖의 길까지 보는 한 겹 더 — service.test effort E1).
//  ② 배선 — 값을 읽는 의존은 필수라(타입 검사) 줄이 빠지면 빌드가 막지만, 같은 꼴(Promise<Effort | null>)의 다른 함수로 잘못 이으면 타입 검사도
//   서비스 시험도 초록인 채 그 작업들이 말없이 기본 깊이로 돈다. 그래서 배선 줄을 소스에서 직접 본다(tool-allowlist-wiring.test 와 같은 꼴).
//   칸 쓰기 · 읽기의 실제 길과 롤 창은 실 PG(agent-jobs store.pg-test · ai-runs store.pg-test)가 본다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { HttpError } from "../http-error.js";
import { EFFORT_LEVELS } from "../agent-jobs/runner.js";
import { aiRunCapabilities } from "../capabilities/ai-runs.js";
import { restMounts } from "../capabilities/index.js";
import { HARNESSES } from "../terminal/catalog.js";

const read = (rel: string): string => readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
let pass = 0;
const t = (name: string, fn: () => void): void => { try { fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; } pass++; console.log(`ok  ${name}`); };

const cap = aiRunCapabilities.find((c) => c.name === "app_ai_run");
assert.ok(cap, "app_ai_run 능력이 없다 — 시험 전제 붕괴");
const BAD: unknown[] = ["ultra", "HIGH", "Max", " high", "high ", "", "--dangerously-skip-permissions", 3, true, null];

t("EI0 다섯 값은 claude 하네스 카탈로그(세션 폼 · 위탁의 플래그 화이트리스트)의 --effort 선택지와 같다 — 하네스가 값을 늘려 한쪽만 고치면 빨개진다", () => {
  const claude = HARNESSES.find((h) => h.key === "claude");
  const choices = claude?.flags.find((f) => f.name === "--effort")?.choices?.filter((c) => c !== "");   // 빈 값 = 그 폼의 «자동»(인자 없음)
  assert.deepEqual(choices, [...EFFORT_LEVELS]);
});

t("EI1 MCP 입력 — app_ai_run 의 effort 는 다섯 값만 받는다(생략 가능 · 그 밖은 SDK 의 z.object 검사가 핸들러 전에 거절)", () => {
  const schema = z.object(cap!.input as z.ZodRawShape);
  for (const effort of EFFORT_LEVELS) {
    const r = schema.safeParse({ prompt: "x", effort });
    assert.ok(r.success, `${effort}: ${JSON.stringify(r.error?.issues)}`);
    assert.equal((r.data as { effort?: string }).effort, effort);
  }
  assert.ok(schema.safeParse({ prompt: "x" }).success, "생략은 받는다");
  for (const bad of BAD) assert.ok(!schema.safeParse({ prompt: "x", effort: bad }).success, `거절해야 한다: ${JSON.stringify(bad)}`);
});

t("EI2 REST 입력(POST /api/ui/ai-runs) — 다섯 값 밖은 400(필드 이름 · 허용값 다섯을 밝힌다) · 다섯 값은 핸들러 입력에 그대로 · 생략 · 빈 글 · null 은 안 준 것", () => {
  const found = restMounts().find((m) => m.cap.name === "app_ai_run" && m.mount.paths.includes("/api/ui/ai-runs"));
  assert.ok(found, "app_ai_run 의 REST 마운트가 없다 — 시험 전제 붕괴");
  const parse = (body: Record<string, unknown>): Record<string, unknown> =>
    found!.mount.parse({ method: "POST", path: "/api/ui/ai-runs", originalUrl: "/api/ui/ai-runs", headers: {}, params: {}, query: {}, body } as never);
  for (const bad of ["ultra", "HIGH", " high", "--x", 3]) {
    let err: unknown = null;
    try { parse({ prompt: "x", effort: bad }); } catch (e) { err = e; }
    assert.ok(err instanceof HttpError, `거절되지 않았다: ${JSON.stringify(bad)} → ${String(err)}`);
    assert.equal(err.status, 400, err.message);
    assert.match(err.message, /effort/);
    for (const v of EFFORT_LEVELS) assert.ok(err.message.includes(v), `허용값 ${v} 가 글에 없다: ${err.message}`);
  }
  for (const effort of EFFORT_LEVELS) assert.equal(parse({ prompt: "x", effort }).effort, effort, "핸들러 입력에 그대로 실린다(REST 의 키 목록 AI_RUN_KEYS)");
  assert.ok(!("effort" in parse({ prompt: "x" })), "생략은 싣지 않는다");
  for (const none of ["", null]) assert.doesNotThrow(() => parse({ prompt: "x", effort: none }), `${JSON.stringify(none)} 은 REST 의 생략 관례 — 서비스가 안 준 것으로 읽는다`);
});

t("EI3 앱 주소(/_lively/ai/runs) — 본문의 effort 를 app_ai_run 으로 넘긴다(앱 화면 · 새 탭의 SDK 가 같은 깊이를 줄 수 있게)", () => {
  assert.match(read("apps/app-front-api.ts"), /name: "app_ai_run", args: pick\(b, \[[^\]]*"effort"[^\]]*\]\)/);
});

t("EW1 이어받기 · 형식 재시도 — AI 실행의 작업 행 깊이 읽기는 원래 작업 행의 effort 칸을 읽는 함수로 배선된다", () => {
  assert.match(read("ai-runs/live.ts"), /jobEffort: async \(jobId\) => \(await import\("\.\.\/agent-jobs\/store\.js"\)\)\.agentJobEffort\(jobId\),/);
});

t("EW2 판 부트 · 사람이 보내는 작업의 이어받기 — 작업 행의 effort 칸을 읽는 함수로 배선되고, 읽은 값이 하네스 인자로 간다", () => {
  assert.match(read("agent-jobs/live.ts"), /jobEffort: async \(job\) => \(await import\("\.\/store\.js"\)\)\.agentJobEffort\(job\.id\),/);
  const svc = read("agent-jobs/service.ts");
  assert.match(svc, /effort = await d\.jobEffort\(booted\);/);
  assert.match(svc, /argv: claudeJobArgv\(\{ model: booted\.model, effort, /);
  assert.match(svc, /effort = await d\.jobEffort\(prev\);/);
});

t("EW3 작업 행 — 쓰기는 값이 있을 때 그 칸에, 읽기는 같은 칸(EFFORT_COL)이다 · 마이그레이션이 같은 이름의 칸을 만든다", () => {
  const store = read("agent-jobs/store.ts");
  assert.match(store, /export const EFFORT_COL = "effort";/);
  assert.match(store, /\$\{effortRef \? `, \$\{EFFORT_COL\}` : ""\}/);
  assert.match(store, /\$\{effortRef \? `, \$\{effortRef\}` : ""\}/);
  assert.match(store, /SELECT \$\{EFFORT_COL\} AS e FROM org_agent_job WHERE id=\$1/);
  assert.match(read("org/schema/sessions-infra.ts"), /ALTER TABLE org_agent_job ADD COLUMN IF NOT EXISTS effort TEXT/);
});

t("EW4 실행 행 — 쓰기는 값이 있을 때 그 칸에, 보기 · 목록은 같은 칸(RUN_EFFORT_COL)이다 · 마이그레이션이 같은 이름의 칸을 만든다", () => {
  const store = read("ai-runs/store.ts");
  assert.match(store, /export const RUN_EFFORT_COL = "effort";/);
  assert.match(store, /\$\{effortRef \? `, \$\{RUN_EFFORT_COL\}` : ""\}/);
  assert.match(store, /SELECT \$\{RUN_EFFORT_COL\} AS e FROM org_app_ai_run WHERE id=\$1/);
  assert.match(store, /\[`r\.\$\{RUN_SHARED_SEAT_COL\}`, `r\.\$\{RUN_EFFORT_COL\}`\]/);
  assert.match(read("org/schema/ai-runs.ts"), /ALTER TABLE org_app_ai_run ADD COLUMN IF NOT EXISTS effort TEXT/);
});

console.log(`# ${pass} pass`);

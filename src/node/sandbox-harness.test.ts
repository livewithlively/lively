// 샌드박스 판의 실행 하네스 — 로그인 프로브 없이 저장된 자격으로 고른다 (#4052 끝단 확인 후속 2). 사양 엣지 표 S.
//
//  실측 2026-09-17(CP 운영 조회): 사람이 한 번도 안 들어온 새 워크스페이스(sangmin-yoon-37de)에 «AI 로그인 (antigravity)»
//  세션이 둘 떠 «일하는 중» 이었고 관리 서버는 그 테넌트를 재우지 못했다(절전 «busy»). 생성 시각이 분류 잡 실행 직후였다 —
//  enqueueHeadlessTask → resolveHeadlessHarness → memberUsableHarnesses 의 **로그인 프로브**가 멤버 자리에 세션을 띄운 것이다.
//  샌드박스 판은 대화형 로그인이 아니라 저장된 헤드리스 자격으로 돌므로 그 프로브는 쓸모가 없다.
//  단언은 문구가 아니라 고른 하네스 · 자격 조회 호출 · 배선으로 한다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveSandboxHarness } from "./headless-harness.js";
import { SANDBOX_CREDS } from "./sandbox-credentials.js";

const creds = (have: string[]) => {
  const calls: Array<[string, string]> = [];
  const fn = async (member: string, harness: string): Promise<boolean> => { calls.push([member, harness]); return have.includes(harness); };
  return { fn, calls };
};

// ── 고르기 ────────────────────────────────────────────────────────────────────
test("H1 ★ 자격이 없으면 claude — 배정이 no_credential 로 끝나고 멤버에게 알린다(종전과 같은 끝)", async () => {
  assert.equal(await resolveSandboxHarness("m1", null, creds([]).fn), "claude");
});
test("H2 ★ codex 자격만 있으면 codex — 대화형 로그인과 무관하게 자격이 있는 쪽", async () => {
  assert.equal(await resolveSandboxHarness("m1", null, creds(["codex"]).fn), "codex");
});
test("H3 둘 다 있으면 claude 우선", async () => {
  assert.equal(await resolveSandboxHarness("m1", null, creds(["codex", "claude"]).fn), "claude");
});
test("H4 claude 만 있으면 claude", async () => {
  assert.equal(await resolveSandboxHarness("m1", undefined, creds(["claude"]).fn), "claude");
});
test("H5 명시가 유효하면 그대로 — 자격은 묻지 않는다(없으면 배정이 no_credential 로 말한다)", async () => {
  const c = creds([]);
  assert.equal(await resolveSandboxHarness("m1", "codex", c.fn), "codex");
  assert.equal(c.calls.length, 0);
});
test("H6 명시가 헤드리스 불가면 던진다(종전 규칙 그대로 — 조용히 바꾸지 않는다)", async () => {
  await assert.rejects(resolveSandboxHarness("m1", "opencode", creds(["claude"]).fn), /opencode/);
});
test("H7 공백뿐인 명시는 명시 없음", async () => {
  assert.equal(await resolveSandboxHarness("m1", "   ", creds(["codex"]).fn), "codex");
});
test("H8 자격 조회가 던지면 그 하네스만 «자격 없음» — 전체는 던지지 않는다(잡이 멈추지 않게)", async () => {
  const half = async (_m: string, h: string): Promise<boolean> => { if (h === "claude") throw new Error("db down"); return h === "codex"; };
  assert.equal(await resolveSandboxHarness("m1", null, half), "codex");
  const all = async (): Promise<boolean> => { throw new Error("db down"); };
  assert.equal(await resolveSandboxHarness("m1", null, all), "claude");
});
test("H9 묻는 대상 = 샌드박스 자격 표의 하네스 전부 · 멤버 id 그대로", async () => {
  const c = creds([]);
  await resolveSandboxHarness("sangmin-yoon", null, c.fn);
  assert.deepEqual(c.calls, Object.keys(SANDBOX_CREDS).map((h) => ["sangmin-yoon", h]));
  assert.deepEqual(Object.keys(SANDBOX_CREDS).sort(), ["claude", "codex"], "표가 바뀌면 이 시험의 전제도 다시 본다");
});

// ── 배선 ──────────────────────────────────────────────────────────────────────
const read = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const code = (s: string): string => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const fnBody = (rel: string, head: string): string => {
  const s = code(read(rel));
  const i = s.indexOf(head);
  assert.ok(i >= 0, `${rel} 에서 ${head} 를 찾았다`);
  return s.slice(i, s.indexOf("\n}\n", i));
};

test("W1 ★ 샌드박스 판 하네스 선택은 로그인 프로브를 부르지 않는다(세션을 띄우는 길이 없다)", () => {
  const body = fnBody("src/node/headless-harness.ts", "export async function resolveSandboxHarness(");
  assert.ok(!/memberUsableHarnesses|aiLoginCheck|ensureHarnessSeat|resolveHeadlessHarness/.test(body), "프로브 경로를 타지 않는다");
  assert.match(body, /pickHeadlessHarness\(\{ loggedIn: withCred \}\)/, "고르기 규칙은 종전과 같은 순수 함수");
});
test("W2 ★ 접수 — 샌드박스로 갈 맥락 잡은 자격으로, 그 밖은 종전(로그인 프로브)으로", () => {
  const body = fnBody("src/scheduler/actions/_headless.ts", "export async function enqueueHeadlessTask(");
  assert.match(body, /const sandboxed = isContextJob\(\{ exec_profile: o\.execProfile \?\? null \}\) && sandboxAvailable\(\);/);
  assert.match(body, /harness = sandboxed\s*\? await resolveSandboxHarness\(o\.requester, o\.harness \?\? null\)\s*: await resolveHeadlessHarness\(o\.requester, o\.harness \?\? null\);/);
  assert.equal((body.match(/resolveHeadlessHarness\(/g) || []).length, 1, "프로브 경로 호출은 비샌드박스 갈래 한 곳뿐");
});
test("W3 배정과 같은 술어 — 스케줄러도 sandboxAvailable·isContextJob 으로 샌드박스 판을 가른다", () => {
  assert.match(code(read("src/node/task-scheduler.ts")), /const sandboxJob = sandboxAvailable\(\) && isContextJob\(t\);/);
});
test("W4 증류·분류·관리 액션이 맥락 잡 표지를 싣는다(안 실으면 위 갈래를 못 탄다)", () => {
  for (const f of ["distill", "classify"]) assert.match(code(read(`src/scheduler/actions/${f}.ts`)), /execProfile: "context"/, f);
  assert.match(code(read("src/scheduler/actions/manage.ts")), /execProfile: o\.repo \? null : "context"/);
});

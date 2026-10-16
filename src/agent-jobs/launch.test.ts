// 작업 컨테이너를 띄우고 걷는 자리(launch.ts)의 순수한 부분 — 브로커 tmux 인자 계약 · 비밀 가리기 · 걷기의 마지막 자리 (#4490).
//  행 번호(L·K)는 지식 agent-job-container-research-4490 의 엣지 표다. tmux 실행은 바꿔 끼운 실행기로 본다(부른 argv · 던진 것).
import assert from "node:assert/strict";
import { jobTmuxArgv, redactSecret, killJobContainer } from "./launch.js";
import { BOOT_SOURCE, JOB_BOOT_ENV, JOB_ID_ENV } from "./runner.js";
import { outcomeToError, sessionGoneResult } from "../terminal/tmux-route.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  try { await fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++;
  console.log(`ok  ${name}`);
};

/**
 * 브로커가 tmux argv 를 받는 규칙(lvly-cloud control/src/sessionbroker.ts validateTmuxArgv) — 여기 옮겨 적어 계약으로 고정한다.
 *  인자 64개 이하 · 문자열 · 하나 4,096자 이하 · NUL 없음 · 첫 인자가 옵션(`-`)이 아니다. 어기면 판이 아예 안 뜬다.
 */
function brokerAccepts(args: unknown): string | null {
  if (!Array.isArray(args) || !args.length) return "비었다";
  if (args.length > 64) return `인자 ${args.length}개`;
  for (const a of args) {
    if (typeof a !== "string") return "문자열이 아니다";
    if (a.length > 4096) return `인자 ${a.length}자`;
    if (a.includes("\0")) return "NUL";
  }
  return String(args[0]).startsWith("-") ? `옵션으로 시작: ${args[0]}` : null;
}

const SECRET = "bootSecret_AbC-123";
const base = { sessionId: "job-7-0123abcd", jobId: 7, bootSecret: SECRET, cwd: "/work/apps/memo", tz: "Asia/Seoul", slug: "acme-1234", locale: "C.UTF-8", boxSpawn: "/usr/local/bin/box-spawn" };

await t("L1 판 argv 는 브로커 규칙을 지킨다(64개 · 4,096자 · NUL · 첫 인자) — 부트 원문 그대로 한 인자", () => {
  const a = jobTmuxArgv(base);
  assert.equal(brokerAccepts(a), null);
  assert.equal(a[0], "new-session");
  assert.equal(a[a.indexOf("-s") + 1], "job-7-0123abcd");
  assert.equal(a[a.length - 1], BOOT_SOURCE, "부트는 node -e 의 한 인자다");
  assert.deepEqual(a.slice(a.indexOf(base.boxSpawn), a.indexOf(base.boxSpawn) + 5), [base.boxSpawn, "--cwd", "/work/apps/memo", "node", "-e"]);
});

await t("L2 부트 비밀은 env(-e) 한 자리에만 — 명령줄 다른 곳에 새지 않는다 · 작업 id · 기계 세션 표식", () => {
  const a = jobTmuxArgv(base);
  const hits = a.map((x, i) => [x, i] as const).filter(([x]) => x.includes(SECRET));
  assert.equal(hits.length, 1);
  assert.equal(hits[0]![0], `${JOB_BOOT_ENV}=${SECRET}`);
  assert.equal(a[hits[0]![1] - 1], "-e");
  assert.ok(a.includes(`${JOB_ID_ENV}=7`));
  assert.ok(a.includes("LIVELY_SESSION_KIND=task"), "훅이 사람 세션 일을 하지 않게");
});

await t("L3 비밀 가리기 — 실패 문장에 몇 번 나와도 다 가린다 · 빈 비밀이면 그대로", () => {
  assert.equal(redactSecret(`Command failed: tmux -e ${JOB_BOOT_ENV}=${SECRET} x ${SECRET}`, SECRET), `Command failed: tmux -e ${JOB_BOOT_ENV}=*** x ***`);
  assert.equal(redactSecret("그대로", ""), "그대로");
});

await t("K1 걷기의 마지막 자리 — `job-` 꼴이 아니면 tmux 를 부르지 않고 던진다(사람 세션 · 빈 값 · 옵션 모양)", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<unknown> => { calls.push(args); return ""; };
  for (const bad of ["box-alice-1", "", "-t", "job-0-0123abcd", "job-7-0123ABCD", "job-7-0123abcd;x", "job-7"]) {
    await assert.rejects(killJobContainer(bad, run, () => false), /작업 세션 id 꼴이 아니다/, bad);
  }
  assert.deepEqual(calls, [], "한 번도 부르지 않았다");
});

await t("K2 걷기 — kill-session 한 번 · 이미 없다는 확답(중계의 `can't find session`)은 조용히 걷힘", async () => {
  const sid = "job-7-0123abcd";
  const calls: string[][] = [];
  await killJobContainer(sid, async (args) => { calls.push(args); return ""; });
  assert.deepEqual(calls, [["kill-session", "-t", sid]]);
  const gone = outcomeToError(sessionGoneResult(sid, `lvly-s-acme-1234-${sid}`));
  await killJobContainer(sid, async () => { throw gone; });     // 기본 판정(tmux-exec.isSessionGoneError)이 확답으로 읽는다
});

await t("K3 걷기 — 확답이 아닌 실패(중계 시간 초과 · 목록을 못 봄 · 브로커 오류)는 던진다(부르는 쪽이 다시 걷는다)", async () => {
  const sid = "job-7-0123abcd";
  const timedOut = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", stderr: "" });
  const unobserved = outcomeToError({ code: 1, stdout: "", stderr: "브로커 세션 목록 조회 실패(못 봤다): socket hang up" });
  const broker = outcomeToError({ code: 1, stdout: "", stderr: "코어 직접 경로 실행 오류(못 봤다): 503" });
  for (const e of [timedOut, unobserved, broker]) {
    await assert.rejects(killJobContainer(sid, async () => { throw e; }), (x: unknown) => x === e);
  }
});

console.log(`# ${pass} pass`);

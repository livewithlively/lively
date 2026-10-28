// 작업 컨테이너를 띄우고 걷는 자리(launch.ts)의 순수한 부분 — 브로커 tmux 인자 계약 · 비밀 가리기 · 걷기의 마지막 자리 (#4490).
//  행 번호(L·K)는 지식 agent-job-container-research-4490 의 엣지 표다. tmux 실행은 바꿔 끼운 실행기로 본다(부른 argv · 던진 것).
import assert from "node:assert/strict";
import { jobTmuxArgv, redactSecret, killJobContainer, stepFailure, launchJobContainer, jobEnsureRequest, homelessEnsureMismatch, JobLaunchError, type LaunchStep } from "./launch.js";
import { readFileSync } from "node:fs";
import { HOMELESS_OS_USER } from "./plan.js";
import { BOOT_SOURCE, JOB_BOOT_ENV, JOB_ID_ENV } from "./runner.js";
import { outcomeToError, sessionGoneResult } from "../terminal/tmux-route.js";
import { sessionPaneArgv } from "../terminal/session-tmux.js";

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

await t("L1b 판 명령 꼬리는 사람 세션의 판 argv(sessionPaneArgv)와 같은 꼴 — 사람 세션 규약이 바뀌면 여기서 먼저 빨개진다", () => {
  const a = jobTmuxArgv(base);
  const tail = sessionPaneArgv(base.cwd, ["node", "-e", BOOT_SOURCE]);
  assert.deepEqual(a.slice(-tail.length).slice(1), tail.slice(1), "box-spawn 뒤 꼴(--cwd · 작업 폴더 · 명령)이 같다");
  assert.equal(a[a.length - tail.length], base.boxSpawn, "box-spawn 자리(시험은 경로를 바꿔 끼운다)");
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

await t("F1 확보 단계의 실패는 전부 일시(transient) — 대기열로 되돌려 다시 한다(시도 상한까지) · 문장에 단계와 사유", () => {
  const steps: LaunchStep[] = ["os-user", "workdir", "ensure", "home", "memory", "pane"];
  for (const step of steps) {
    const e = stepFailure(step, new Error("노드 자리 없음"));
    assert.ok(e instanceof JobLaunchError, step);
    assert.equal(e.transient, true, `${step} 는 일시`);
    assert.match(e.message, /노드 자리 없음$/, step);
  }
  assert.equal(stepFailure("ensure", "").message, "작업 컨테이너를 확보하지 못했습니다");
});

await t("F2 다시 해도 안 될 것(세션 id 없음 · 실행 계정 없음)은 일시가 아니다 — 그 작업을 바로 끝낸다", async () => {
  const base = { id: 7, app_id: null, project_id: 1, cwd: "/work/shared/project/1" } as never;
  await assert.rejects(launchJobContainer({ ...(base as object), session_id: null, account_member: "alice" } as never, "x"),
    (e: unknown) => e instanceof JobLaunchError && e.transient === false && /세션 id/.test(e.message));
  await assert.rejects(launchJobContainer({ ...(base as object), session_id: "job-7-0123abcd", account_member: null } as never, "x"),
    (e: unknown) => e instanceof JobLaunchError && e.transient === false && /실행 계정/.test(e.message));
});

await t("H1 확보 요청(#4891) — 홈 없는 작업은 homeless:true · 전용 계정 · 앱 폴더 · 붙일 앱 없음 / 사람 자리는 종전 꼴(homeless 칸 없음 · 프로젝트 작업이면 앱을 붙인다)", () => {
  const mem = { memMb: 2048, memRequestMb: 768 };
  const homeless = jobEnsureRequest({ session_id: "job-7-0123abcd", cwd: "/work/apps/crm", app_id: "crm", project_id: null, homeless: true }, { osUser: HOMELESS_OS_USER, ...mem });
  assert.deepEqual(homeless, { sessionId: "job-7-0123abcd", osUser: "box_lvly_job", cwd: "/work/apps/crm", memMb: 2048, memRequestMb: 768, tmux: "inside", homeless: true });
  const seat = jobEnsureRequest({ session_id: "job-8-0123abcd", cwd: "/work/apps/crm", app_id: "crm", project_id: null, homeless: false }, { osUser: "box_alice", ...mem });
  assert.ok(!("homeless" in seat) && !("apps" in seat) && !("fresh" in seat), JSON.stringify(seat));
  const proj = jobEnsureRequest({ session_id: "job-9-0123abcd", cwd: "/work/shared/project/3", app_id: "crm", project_id: 3, homeless: false }, { osUser: "box_alice", ...mem });
  assert.deepEqual(proj.apps, ["crm"]);
  assert.ok(!("homeless" in proj));
});

await t("H2 홈 없는 작업의 조건은 부수효과 앞 — 구독 · 프로젝트 폴더 · 다른 앱 폴더 · 앱 없음이면 일시가 아닌 실패(OS 계정 · 브로커를 부르지 않는다)", async () => {
  const base = { id: 7, session_id: "job-7-0123abcd", requester: "alice", account_member: null, account_kind: "api_key", app_id: "crm", project_id: null, cwd: "/work/apps/crm", homeless: true };
  const rows: Array<[Record<string, unknown>, RegExp]> = [
    [{ account_kind: "subscription", account_member: "alice" }, /API 키 실행만/],
    [{ project_id: 3, cwd: "/work/shared/project/3" }, /프로젝트 폴더/],
    [{ cwd: "/work/apps/other" }, /그 앱 폴더/],
    [{ app_id: null }, /앱 작업만/],
  ];
  for (const [o, re] of rows) {
    await assert.rejects(launchJobContainer({ ...base, ...o } as never, "x"),
      (e: unknown) => e instanceof JobLaunchError && e.transient === false && re.test(e.message), JSON.stringify(o));
  }
});

await t("H3 옛 브로커 대비 — 홈 없이 만들라고 했는데 그 답(homeless:true)이 없으면 거절 사유 · 사람 자리 확보는 그 칸을 안 본다", () => {
  assert.match(homelessEnsureMismatch(true, { container: "lvly-s-x-slot-1", created: true }) ?? "", /홈 없는 작업 컨테이너를 모른다\(lvly-s-x-slot-1\)/);
  assert.match(homelessEnsureMismatch(true, { container: "c", homeless: "true" }) ?? "", /모른다/, "정확히 true 만");
  assert.equal(homelessEnsureMismatch(true, { container: "c", homeless: true }), null);
  assert.equal(homelessEnsureMismatch(false, { container: "c" }), null);
  assert.equal(homelessEnsureMismatch(false, { container: "c", homeless: true }), null);
});

await t("H4 띄우기 배선 — 판정은 OS 계정 · 확보 앞 · 확보 뒤 곧바로 옛 브로커 거절(일시) · 멤버 홈 준비는 사람 자리만 · 그 뒤에 판", () => {
  const SRC = readFileSync(new URL("../../src/agent-jobs/launch.ts", import.meta.url), "utf8");
  const body = SRC.slice(SRC.indexOf("export async function launchJobContainer("), SRC.indexOf("type TmuxRun ="));
  assert.ok(body.length > 500, "본문을 못 잘랐다(관측 장치 확인)");
  const at = (needle: string): number => { const i = body.indexOf(needle); assert.ok(i > 0, `못 찾았다: ${needle}`); return i; };
  const seq = [
    "const homelessWhy = homelessJobRefusal(job);",
    "const user = homeless ? null : await accountUser(seat);",
    "made = await ensureSessionContainerViaRelay(sessionEnsureArgv(slug), jobEnsureRequest(job, { osUser, memMb, memRequestMb }));",
    "const skew = homelessEnsureMismatch(homeless, made);",
    "if (skew) throw stepFailure(\"ensure\", skew);",
    "await prepareMemberHome(user, { osUser, sessionId: sid });",
    "await tmux(argv);",
  ].map(at);
  for (let k = 1; k < seq.length; k++) assert.ok(seq[k] > seq[k - 1], `순서가 틀렸다(${k})`);
  assert.equal(body.split("prepareMemberHome(").length - 1, 1, "멤버 홈 준비는 한 자리");
  assert.equal(body.split("ensureMemberOsUser(").length - 1, 1, "OS 계정 준비는 한 자리");
  assert.match(body, /if \(user\) \{\n\s*const \{ ensureMemberOsUser \}/, "OS 계정 준비는 사람 자리만");
  assert.match(body, /if \(user\) \{\n\s*const \{ prepareMemberHome \} = await import\(/, "멤버 홈 준비는 사람 자리만");
});

console.log(`# ${pass} pass`);

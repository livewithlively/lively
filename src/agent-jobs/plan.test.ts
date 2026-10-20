// 작업 컨테이너 판정(순수) — 자리 주기 · 감시 · 시간 상한 · 판 보고 → 상태 · 보고 거르기 · 이름 (#4490)
//  행 번호(C·S·T·F·P·ID)는 지식 agent-job-container-research-4490 의 엣지 표다. 표의 행마다 시나리오가 최소 하나다.
import assert from "node:assert/strict";
import {
  planClaims, sweepDecision, timeoutSecOf, finalOutcome, parseRunnerReport, jobSessionId, appFolderCwd, projectFolderCwd,
  convIdOf, parseBootFailure, bootFailureError, homelessJobRefusal, HOMELESS_OS_USER, JOB_SESSION_ID_RE, TIMEOUT_GRACE_SEC, RESULT_TEXT_MAX, TAIL_MAX,
  type RunnerReport, type SweepFacts,
} from "./plan.js";
import { memberSlug, osUsername } from "../terminal/terminal-isolation.js";
import { DEFAULT_AGENT_JOB_POLICY as P } from "../org/policies/agent-job-policy.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  try { fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++;
  console.log(`ok  ${name}`);
};

const q = (id: number, who: string | null) => ({ id, account_member: who });

// ── 자리 주기 ────────────────────────────────────────────────────────────────
t("C1 상한 2 · 도는 것 0 · 대기 A·A·B → 먼저 온 둘(A, A)", () => {
  assert.deepEqual(planClaims([], [q(1, "a"), q(2, "a"), q(3, "b")], { max_running: 2, max_running_per_member: 2 }), [1, 2]);
});
t("C2 사람당 1 · 대기 A·A·B → A 하나 건너뛰고 B", () => {
  assert.deepEqual(planClaims([], [q(1, "a"), q(2, "a"), q(3, "b")], { max_running: 2, max_running_per_member: 1 }), [1, 3]);
});
t("C3 도는 것 = 상한 → 0건 · 넘은 경우도 0건", () => {
  assert.deepEqual(planClaims([q(9, "x"), q(8, "y")], [q(1, "a")], { max_running: 2, max_running_per_member: 2 }), []);
  assert.deepEqual(planClaims([q(9, "x"), q(8, "y"), q(7, "z")], [q(1, "a")], { max_running: 2, max_running_per_member: 2 }), []);
});
t("C4 도는 것 1(A) · 사람당 1 · 대기 A·B → B", () => {
  assert.deepEqual(planClaims([q(9, "a")], [q(1, "a"), q(2, "b")], { max_running: 3, max_running_per_member: 1 }), [2]);
});
t("C5 대기 0 → 0건", () => {
  assert.deepEqual(planClaims([], [], { max_running: 2, max_running_per_member: 2 }), []);
});
t("C6 실행 계정 없음(null) 은 사람당 상한과 무관 — 워크스페이스 상한만", () => {
  assert.deepEqual(planClaims([q(9, null)], [q(1, null), q(2, null), q(3, null)], { max_running: 3, max_running_per_member: 1 }), [1, 2]);
});

// ── 감시 ─────────────────────────────────────────────────────────────────────
const NOW = 10_000_000_000;
const base = (o: Partial<SweepFacts>): SweepFacts => ({
  status: "queued", createdAt: NOW, claimedAt: null, startedAt: null, lastTickAt: null, timeoutSec: 900, cancelRequested: false, ...o,
});
const MIN = 60_000;
t("S1 대기 중 취소 요청 → canceled · 걷기 없음", () => {
  assert.deepEqual(sweepDecision(base({ cancelRequested: true }), NOW, P), { act: "end", status: "canceled", error: "대기 중에 취소했습니다", kill: false });
});
t("S2·S3 대기 시간 — 상한 정확히는 그대로, 넘으면 failed(걷기 없음)", () => {
  assert.deepEqual(sweepDecision(base({ createdAt: NOW - P.queue_wait_min * MIN }), NOW, P), { act: "none" });
  const a = sweepDecision(base({ createdAt: NOW - P.queue_wait_min * MIN - 1 }), NOW, P);
  assert.equal(a.act, "end");
  assert.ok(a.act === "end" && a.status === "failed" && a.kill === false && /30분/.test(a.error));
});
t("S4 띄우는 중 — 시작 상한 정확히는 그대로, 넘으면 failed + 걷기", () => {
  assert.deepEqual(sweepDecision(base({ status: "starting", claimedAt: NOW - P.start_timeout_sec * 1000 }), NOW, P), { act: "none" });
  const a = sweepDecision(base({ status: "starting", claimedAt: NOW - P.start_timeout_sec * 1000 - 1 }), NOW, P);
  assert.ok(a.act === "end" && a.status === "failed" && a.kill === true, JSON.stringify(a));
  //  판이 실패를 알렸다면 그 사유로 이미 끝났다(#4829) — 여기 오는 것은 판이 게이트웨이에 한 번도 못 닿은 경우다.
  assert.ok(a.act === "end" && /180초 안에 시작하지 못했습니다 — 컨테이너가 뜨지 않았거나 게이트웨이에 닿지 못했습니다/.test(a.error), a.act === "end" ? a.error : "");
});
t("S5 띄우는 중인데 자리 받은 시각이 없으면 접수 시각으로 잰다", () => {
  assert.equal(sweepDecision(base({ status: "starting", claimedAt: null, createdAt: NOW - P.start_timeout_sec * 1000 - 1 }), NOW, P).act, "end");
  assert.equal(sweepDecision(base({ status: "starting", claimedAt: null, createdAt: NOW - 1000 }), NOW, P).act, "none");
});
t("S6 도는 중 — 마지막 박동이 silent 정확히는 그대로, 넘으면 failed + 걷기", () => {
  const run = { status: "running" as const, startedAt: NOW - 5 * MIN, claimedAt: NOW - 6 * MIN };
  assert.deepEqual(sweepDecision(base({ ...run, lastTickAt: NOW - P.silent_sec * 1000 }), NOW, P), { act: "none" });
  const a = sweepDecision(base({ ...run, lastTickAt: NOW - P.silent_sec * 1000 - 1 }), NOW, P);
  assert.ok(a.act === "end" && a.status === "failed" && a.kill === true && /응답하지 않/.test(a.error), JSON.stringify(a));
});
t("S7 도는 중인데 박동이 한 번도 없으면 시작 시각으로 잰다", () => {
  assert.equal(sweepDecision(base({ status: "running", startedAt: NOW - P.silent_sec * 1000 - 1, lastTickAt: null }), NOW, P).act, "end");
  assert.equal(sweepDecision(base({ status: "running", startedAt: NOW - 1000, lastTickAt: null }), NOW, P).act, "none");
});
t("S8 시작 + 상한 + 여유를 넘으면 timeout + 걷기 — 박동이 최근이어도", () => {
  const startedAt = NOW - (900 + TIMEOUT_GRACE_SEC) * 1000 - 1;
  const a = sweepDecision(base({ status: "running", startedAt, lastTickAt: NOW - 1000, timeoutSec: 900 }), NOW, P);
  assert.ok(a.act === "end" && a.status === "timeout" && a.kill === true, JSON.stringify(a));
  assert.equal(sweepDecision(base({ status: "running", startedAt: startedAt + 2, lastTickAt: NOW - 1000, timeoutSec: 900 }), NOW, P).act, "none");
});
t("S10 재기동 직후 — 듣기 시작한 지 silent 정확히는 그대로, 넘으면 끊김(그 전의 침묵은 세지 않는다)", () => {
  //  실행 상한은 넉넉히(4시간) — 여기선 무응답 판정만 본다.
  const run = { status: "running" as const, startedAt: NOW - 3_600_000, lastTickAt: NOW - 600_000, timeoutSec: 4 * 3600 };
  assert.deepEqual(sweepDecision(base({ ...run, listeningSince: NOW - P.silent_sec * 1000 }), NOW, P), { act: "none" });
  assert.equal(sweepDecision(base({ ...run, listeningSince: NOW - P.silent_sec * 1000 - 1 }), NOW, P).act, "end");
  //  모르면(null) 접지 않는다 — 종전대로 마지막 박동으로 잰다.
  assert.equal(sweepDecision(base({ ...run, listeningSince: null }), NOW, P).act, "end");
  //  듣기 시작이 마지막 박동보다 앞이면 박동이 기준이다.
  assert.deepEqual(sweepDecision(base({ ...run, lastTickAt: NOW - 1000, listeningSince: NOW - 3_000_000 }), NOW, P), { act: "none" });
});
t("S11 대기 상한 — 마지막 띄우기 실패 사유가 있으면 문장에 붙인다(없으면 그대로)", () => {
  const a = sweepDecision(base({ createdAt: NOW - P.queue_wait_min * MIN - 1, lastError: "띄우기 실패 — 노드 자리 없음" }), NOW, P);
  assert.equal(a.act, "end");
  assert.match((a as { error: string }).error, /마지막 띄우기 실패: 띄우기 실패 — 노드 자리 없음$/);
  const b = sweepDecision(base({ createdAt: NOW - P.queue_wait_min * MIN - 1 }), NOW, P);
  assert.doesNotMatch((b as { error: string }).error, /마지막 띄우기 실패/);
});
t("S9 끝난 작업은 아무것도 안 한다", () => {
  for (const status of ["done", "failed", "timeout", "canceled"] as const) {
    assert.deepEqual(sweepDecision(base({ status, createdAt: 0, cancelRequested: true }), NOW, P), { act: "none" });
  }
});

// ── 실행 시간 ────────────────────────────────────────────────────────────────
t("T1·T2·T3 실행 시간 — 없으면 기본 · 최대보다 크면 최대 · 0·음수·문자는 기본", () => {
  assert.equal(timeoutSecOf(undefined, P), P.default_timeout_min * 60);
  assert.equal(timeoutSecOf(P.max_timeout_min + 1, P), P.max_timeout_min * 60);
  assert.equal(timeoutSecOf(P.max_timeout_min, P), P.max_timeout_min * 60);
  assert.equal(timeoutSecOf(1, P), 60);
  for (const bad of [0, -5, "30", NaN, null]) assert.equal(timeoutSecOf(bad, P), P.default_timeout_min * 60, String(bad));
});

// ── 판 보고 → 상태 ──────────────────────────────────────────────────────────
const rep = (o: Partial<RunnerReport>): RunnerReport => ({
  exit_code: 0, signal: null, stopped: null, conversation_id: null, model: null, result: null, stderr_tail: "", tail: "", ...o,
});
const res = (o: Partial<NonNullable<RunnerReport["result"]>>) => ({ text: "답", is_error: false, subtype: "success", num_turns: 1, duration_ms: 1, cost_usd: 0, usage: null, ...o });
t("F1·F2 판이 끊었으면 그 사유가 이긴다(답이 있어도)", () => {
  assert.equal(finalOutcome(rep({ stopped: "canceled", result: res({}) })).status, "canceled");
  assert.equal(finalOutcome(rep({ stopped: "timeout", result: res({}) })).status, "timeout");
});
t("F3 result 가 오류 아니면 done — 종료코드가 1 이어도", () => {
  assert.deepEqual(finalOutcome(rep({ exit_code: 1, result: res({}) })), { status: "done", error: null });
});
t("F4 result 없음 + stderr «Not logged in» → AI 연결 필요", () => {
  const o = finalOutcome(rep({ exit_code: 1, stderr_tail: "Invalid API key · Please run /login" }));
  assert.equal(o.status, "failed");
  assert.match(o.error ?? "", /AI 연결 필요/);
});
t("F5 result 가 오류면 failed(subtype 과 문장)", () => {
  const o = finalOutcome(rep({ result: res({ is_error: true, subtype: "error_max_turns", text: "max turns" }) }));
  assert.equal(o.status, "failed");
  assert.match(o.error ?? "", /error_max_turns/);
});
t("F4b 고치던 파일 경로에 login 이 있어도 «AI 연결 필요» 로 읽지 않는다(맨 /login 은 자격 신호가 아니다)", () => {
  const o = finalOutcome(rep({ exit_code: 1, stderr_tail: "Error: cannot edit src/pages/login.tsx — permission denied" }));
  assert.equal(o.status, "failed");
  assert.doesNotMatch(o.error ?? "", /AI 연결 필요/);
  assert.match(o.error ?? "", /login\.tsx/);
  assert.match(finalOutcome(rep({ exit_code: 1, stderr_tail: "Please run /login" })).error ?? "", /AI 연결 필요/);
});
t("F6 result 없음 · 자격과 무관한 stderr → failed(종료코드 · stderr 꼬리)", () => {
  const o = finalOutcome(rep({ exit_code: 137, signal: "SIGKILL", stderr_tail: "a\nb\nsegfault" }));
  assert.equal(o.status, "failed");
  assert.match(o.error ?? "", /137/);
  assert.match(o.error ?? "", /segfault/);
});

// ── 보고 거르기 ──────────────────────────────────────────────────────────────
t("P2 DB 칸이 받지 않는 값 — 글의 NUL 은 빼고 · 종료코드는 INT 범위 정수만", () => {
  const r = parseRunnerReport({ model: "m\u0000x", tail: "a\u0000b", stderr_tail: "\u0000e", result: { text: "답\u0000", is_error: false } });
  assert.equal(r.model, "mx");
  assert.equal(r.tail, "ab");
  assert.equal(r.stderr_tail, "e");
  assert.equal(r.result?.text, "답");
  //  짝 없는 서로게이트(답이 상한에서 잘리며 이모지 한 쌍이 갈라진 것) — jsonb 가 거절하므로 U+FFFD 로. 온전한 쌍은 그대로.
  const cut = parseRunnerReport({ result: { text: "가".repeat(RESULT_TEXT_MAX - 1) + "😀", is_error: false } }).result?.text ?? "";
  assert.equal(cut.length, RESULT_TEXT_MAX);
  assert.equal(cut.at(-1), "\uFFFD", "잘려 남은 반쪽은 U+FFFD");
  assert.equal(parseRunnerReport({ model: "a\uDC00b\uD83D" }).model, "a\uFFFDb\uFFFD");
  assert.equal(parseRunnerReport({ model: "웃음😀" }).model, "웃음😀", "온전한 쌍은 그대로");
  for (const bad of [1.5, 1e12, -2147483649, 2147483648, Number.NaN]) assert.equal(parseRunnerReport({ exit_code: bad }).exit_code, null, String(bad));
  for (const ok of [0, 1, 137, -2, 2147483647, -2147483648]) assert.equal(parseRunnerReport({ exit_code: ok }).exit_code, ok, String(ok));
});
t("P1 판 보고는 칸마다 거르고 자른다 — 대화 id 모양 · 긴 글 · usage 의 문자열·중첩 · 모르는 stopped", () => {
  const r = parseRunnerReport({
    exit_code: "0", signal: 9, stopped: "exploded", conversation_id: "../../etc/passwd", model: "m".repeat(500),
    result: { text: "x".repeat(RESULT_TEXT_MAX + 50), is_error: "yes", subtype: 1, num_turns: "3", usage: { input_tokens: 5, note: "hi", nested: { a: 1 }, ["bad key!"]: 2 } },
    stderr_tail: 7, tail: "t".repeat(TAIL_MAX + 10),
  });
  assert.equal(r.exit_code, null);
  assert.equal(r.signal, null);
  assert.equal(r.stopped, null);
  assert.equal(r.conversation_id, null);
  assert.equal(r.model?.length, 120);
  assert.equal(r.result?.text?.length, RESULT_TEXT_MAX);
  assert.equal(r.result?.is_error, false);
  assert.equal(r.result?.subtype, null);
  assert.equal(r.result?.num_turns, null);
  assert.deepEqual(r.result?.usage, { input_tokens: 5 });
  assert.equal(r.stderr_tail, "");
  assert.equal(r.tail.length, TAIL_MAX);
  assert.deepEqual(parseRunnerReport(null), { exit_code: null, signal: null, stopped: null, conversation_id: null, model: null, result: null, stderr_tail: "", tail: "" });
  const uuid = "0A1B2C3D-0000-4000-8000-000000000000";
  assert.equal(convIdOf(uuid), uuid.toLowerCase());
});

// ── 이름 · 자리 ──────────────────────────────────────────────────────────────
t("ID1 작업 세션 id 는 job-<id>-<8hex> — box- 로 시작하지 않는다(사람 목록·MCP 세션 신원 밖)", () => {
  const sid = jobSessionId(17, "0a1b2c3d");
  assert.equal(sid, "job-17-0a1b2c3d");
  assert.ok(JOB_SESSION_ID_RE.test(sid));
  assert.ok(!sid.startsWith("box-"));
  assert.ok(/^[a-z0-9][a-z0-9_-]{0,62}$/.test(sid), "브로커 세션 id 규칙 안");
  for (const [id, hex] of [[0, "0a1b2c3d"], [1.5, "0a1b2c3d"], [17, "0A1B2C3D"], [17, "0a1b2c3"], [17, "../x"]] as const) {
    assert.throws(() => jobSessionId(id as number, hex as string), `${id} ${hex}`);
  }
});
t("ID2 앱 폴더·프로젝트 폴더 경로 — 규칙 밖 id 면 경로를 만들지 않는다", () => {
  assert.equal(appFolderCwd("memo"), "/work/apps/memo");
  assert.equal(projectFolderCwd(4478), "/work/shared/project/4478");
  for (const bad of ["", "a", "Memo", "../x", "a/b", "-x", "x".repeat(33)]) assert.throws(() => appFolderCwd(bad), bad);
  for (const bad of [0, -1, 1.5, NaN]) assert.throws(() => projectFolderCwd(bad), String(bad));
});

t("BF1 시작 실패 보고 거르기(#4829) — 판은 작업 AI 와 같은 uid 라 칸마다 거른다: 단계 둘 · 상태 0..999 정수 · 한 줄 300자", () => {
  assert.deepEqual(parseBootFailure({ stage: "runner", status: 0, message: "본체 깨짐" }), { stage: "runner", status: 0, message: "본체 깨짐" });
  assert.deepEqual(parseBootFailure({ stage: "boot", status: 503, message: "  바쁨\n\t둘째 줄\r\n" }), { stage: "boot", status: 503, message: "바쁨 둘째 줄" });
  assert.deepEqual(parseBootFailure({ stage: "rm -rf", status: 999, message: "a\u0000b" }), { stage: "boot", status: 999, message: "ab" }, "모르는 단계는 boot · NUL 은 뺀다");
  for (const bad of [1000, -1, 1.5, "503", NaN, null]) assert.equal(parseBootFailure({ status: bad }).status, null, String(bad));
  assert.deepEqual(parseBootFailure(null), { stage: "boot", status: null, message: "" });
  assert.deepEqual(parseBootFailure("x"), { stage: "boot", status: null, message: "" });
  assert.equal(parseBootFailure({ message: { x: 1 } }).message, "", "글이 아니면 버린다");
  assert.equal(parseBootFailure({ message: "가".repeat(500) }).message.length, 300);
  assert.equal(parseBootFailure({ message: "a".repeat(299) + "\ud83d\ude00" }).message, "a".repeat(299) + "\ufffd", "자르다 남은 외톨이 서로게이트는 고친다(jsonb)");
});

t("BF2 시작 실패 문장 — 본체 · 응답이 닿지 않은 부트(도는 중 401) · 읽지 못한 응답(200) · 게이트웨이에 못 닿음 · 그 밖의 상태", () => {
  const f = (o: Partial<ReturnType<typeof parseBootFailure>>) => ({ stage: "boot" as const, status: null, message: "", ...o });
  assert.equal(bootFailureError(f({ stage: "runner", status: 0, message: "본체 깨짐" }), "running"), "작업 컨테이너의 실행기가 시작하자마자 멈췄습니다: 본체 깨짐");
  assert.equal(bootFailureError(f({ stage: "runner" }), "running"), "작업 컨테이너의 실행기가 시작하자마자 멈췄습니다");
  //  도는 중인데 부트가 401 — 게이트웨이는 시작을 받았고(부트 비밀을 지웠다) 응답만 판에 못 닿았다. «비밀이 틀렸다» 가 아니다.
  assert.equal(bootFailureError(f({ status: 401, message: '{"error":"작업 비밀이 맞지 않습니다"}' }), "running"),
    "작업 컨테이너가 시작 응답을 받지 못했습니다(게이트웨이는 시작을 받았지만 응답이 컨테이너에 닿지 않았습니다)");
  assert.equal(bootFailureError(f({ status: 401, message: "no" }), "starting"), "작업 컨테이너가 게이트웨이에서 시작 응답을 받지 못했습니다(401): no");
  //  200 인데 JSON 이 아니다 — 응답은 받았으니 «받지 못했다» 가 아니라 «읽지 못했다».
  assert.equal(bootFailureError(f({ status: 200, message: "응답이 JSON 이 아닙니다" }), "starting"), "작업 컨테이너가 게이트웨이의 시작 응답을 읽지 못했습니다: 응답이 JSON 이 아닙니다");
  assert.equal(bootFailureError(f({ status: 0, message: "connect ECONNREFUSED" }), "starting"), "작업 컨테이너가 게이트웨이에 닿지 못했습니다: connect ECONNREFUSED");
  assert.equal(bootFailureError(f({ status: null }), "starting"), "작업 컨테이너가 게이트웨이에 닿지 못했습니다");
  assert.equal(bootFailureError(f({ status: 503, message: "busy" }), "starting"), "작업 컨테이너가 게이트웨이에서 시작 응답을 받지 못했습니다(503): busy");
  assert.ok(bootFailureError(f({ status: 502, message: "x".repeat(300) }), "starting").length <= 600);
});

t("HL1 홈 없는 작업의 조건(#4891) — API 키 · 앱 작업 · 프로젝트 없음 · 작업 폴더가 그 앱 폴더 / 홈 없는 작업이 아니면 판정에 안 걸린다", () => {
  type J = { homeless?: boolean; account_kind: string; app_id: string | null; project_id: number | null; cwd: string };
  const ok: J = { homeless: true, account_kind: "api_key", app_id: "crm", project_id: null, cwd: "/work/apps/crm" };
  assert.equal(homelessJobRefusal(ok), null);
  const rows: Array<[Partial<J>, RegExp]> = [
    [{ account_kind: "subscription" }, /API 키 실행만/],
    [{ app_id: null }, /앱 작업만/],
    [{ app_id: "Bad_Id" }, /앱 작업만/],
    [{ project_id: 3, cwd: "/work/shared/project/3" }, /프로젝트 폴더/],
    [{ cwd: "/work/apps/other" }, /그 앱 폴더/],
    [{ cwd: "/work/apps/crm/sub" }, /그 앱 폴더/],
    [{ cwd: "/work/apps" }, /그 앱 폴더/],
  ];
  for (const [o, re] of rows) assert.match(homelessJobRefusal({ ...ok, ...o }) ?? "", re, JSON.stringify(o));
  //  홈 없는 작업이 아니면(사람 자리) 무엇이든 null — 종전 작업은 이 판정을 안 탄다.
  assert.equal(homelessJobRefusal({ ...ok, homeless: false, account_kind: "subscription", project_id: 3, cwd: "/work/shared/project/3" }), null);
  assert.equal(homelessJobRefusal({ ...ok, homeless: undefined, app_id: null }), null);
});

t("HL2 전용 계정 이름은 어떤 구성원 계정과도 겹치지 않는다 — 구성원 slug 엔 `_` 가 없다(memberSlug) · 브로커 이름 규칙(box_ + SAFE)은 지킨다", () => {
  assert.equal(HOMELESS_OS_USER, "box_lvly_job");
  for (const id of ["lvly_job", "LVLY_JOB", "lvly job", "lvly-job", "_lvly_job_", "box_lvly_job", "job"]) {
    assert.notEqual(osUsername(memberSlug(id)), HOMELESS_OS_USER, id);
  }
  assert.ok(/^box_/.test(HOMELESS_OS_USER) && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(HOMELESS_OS_USER.replace(/^box_/, "")));
});

console.log(`# ${pass} pass`);

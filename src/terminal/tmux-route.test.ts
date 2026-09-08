// tmux 해석기 (#2600 T2 (d) d2) — 스크래치패드 spec-d2.md 엣지 표 S1~S13 (순수 부분).
//
// 명제: 이 모듈은 브로커 `/lvly/tmux` 와 **같은 답**을 낸다(그림자 대조의 근거) — 단 «못 봤다» 한 자리만 의도적으로 다르다(S13).
//  단언은 답의 내용(계획·병합 결과·문구)으로 한다. 문구는 코어 소비자(`isSessionGoneError`·`isNoTmuxServer`)가 읽는 것이라
//  바이트 단위로 고정한다.
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyExecOutcome, isServerWideList, mergeFanout, outcomeToError, planTmux, runPlan, sessionContainerName,
  sessionGoneResult, tmuxSessionOf, TMUX_NO_SERVER, TMUX_UNOBSERVED, type SessionRow, type TmuxOutcome,
} from "./tmux-route.js";
import { isNoTmuxServer, isSessionGoneError } from "./tmux-exec.js";

const SLUG = "acme-1a2b";
const row = (sid: string, inside = true): SessionRow => ({ sid, container: sessionContainerName(SLUG, sid), inside });
const A = row("box-a-11111111"), B = row("box-b-22222222"), C = row("box-c-33333333");
const ok = (stdout: string): TmuxOutcome => ({ code: 0, stdout, stderr: "" });
//  gone 은 참일 때만 싣는다 — 실행기가 주는 세 칸엔 그 키가 없고, classifyExecOutcome 이 «그대로» 돌려주는지를 S6b 가 잰다.
const bad = (stderr: string, gone = false): TmuxOutcome => ({ code: 1, stdout: "", stderr, ...(gone ? { gone: true } : {}) });

// ── argv 읽기 — 브로커 tmuxSessionOf 와 같은 규칙 ─────────────────────────────

test("[S0] tmuxSessionOf — 코어가 실제로 보내는 모양 전부에서 동사·세션을 뽑는다", () => {
  const sid = "box-yoon-1a2b3c4d";
  assert.deepEqual(tmuxSessionOf(["set-option", "-t", sid, "@box_label", "라벨 -t 는 값이다"]), { verb: "set-option", ref: { kind: "session", sid } });
  assert.deepEqual(tmuxSessionOf(["-L", "x", "-f", "/dev/null", "has-session", "-t", sid]), { verb: "has-session", ref: { kind: "session", sid } });
  assert.deepEqual(tmuxSessionOf(["new-session", "-d", "-s", sid, "-c", "/tmp"]).ref, { kind: "session", sid });
  assert.deepEqual(tmuxSessionOf(["detach-client", "-s", sid]).ref, { kind: "session", sid });
  assert.deepEqual(tmuxSessionOf(["capture-pane", "-p", `-t${sid}`]).ref, { kind: "session", sid }, "붙여 쓴 -t<sid>");
  assert.deepEqual(tmuxSessionOf(["list-sessions", "-F", "#{session_name}"]), { verb: "list-sessions", ref: { kind: "none" } });
  assert.deepEqual(tmuxSessionOf(["kill-server"]), { verb: "kill-server", ref: { kind: "none" } });
  assert.equal(tmuxSessionOf(["has-session", "-t", "../x"]).ref.kind, "unparsed");
  assert.equal(tmuxSessionOf(["has-session", "-t"]).ref.kind, "unparsed", "-t 뒤에 값이 없다");
  assert.deepEqual(tmuxSessionOf([]), { verb: null, ref: { kind: "none" } });
});

// ── 계획 ──────────────────────────────────────────────────────────────────────

test("[S1] 지목 있음 · 그 세션이 있다(inside) → 그 컨테이너 하나", () => {
  assert.deepEqual(planTmux(SLUG, ["has-session", "-t", A.sid], [A, B]),
    { kind: "one", sid: A.sid, container: A.container, verb: "has-session" });
});

test("[S2] 지목 있음 · 없다(회수됨·옛 경로) → gone(«있었을 자리» 포함) — 컨테이너를 만들지 않는다", () => {
  const p = planTmux(SLUG, ["has-session", "-t", C.sid], [A, B]);
  assert.deepEqual(p, { kind: "gone", sid: C.sid, container: C.container, verb: "has-session" });
  //  표식 없는(inside:false) 잔재도 «없다» 다 — 팬아웃 대상이 아닌 것에 명령을 보내지 않는다.
  assert.equal(planTmux(SLUG, ["has-session", "-t", C.sid], [A, row(C.sid, false)]).kind, "gone");
});

test("[S3] 지목 없는 목록 동사 · 세션 셋 → 셋 전부(sid 순)에 팬아웃", () => {
  const p = planTmux(SLUG, ["list-sessions", "-F", "x"], [C, A, B]);
  assert.deepEqual(p, { kind: "fanout", containers: [A.container, B.container, C.container], verb: "list-sessions" });
});

test("[S4] 목록 동사 · 세션 0 → 빈 팬아웃(병합이 «서버 없음» 을 낸다)", () => {
  assert.deepEqual(planTmux(SLUG, ["list-sessions"], []), { kind: "fanout", containers: [], verb: "list-sessions" });
});

test("[S5] 목록 동사 · 표식 없는 잔재는 팬아웃 대상이 아니다", () => {
  const p = planTmux(SLUG, ["list-panes", "-a", "-F", "x"], [A, row("box-old-99999999", false), B]);
  assert.deepEqual(p, { kind: "fanout", containers: [A.container, B.container], verb: "list-panes" });
});

test("[S7] 지목 없는 **쓰기**(kill-server · set-option -g) → gone(null) — 브로커와 같은 답", () => {
  for (const args of [["kill-server"], ["set-option", "-g", "default-terminal", "xterm-256color"], ["start-server"]]) {
    const p = planTmux(SLUG, args, [A, B]);
    assert.equal(p.kind, "gone", `🔴 ${args[0]} 이 세션 컨테이너로 갔다`);
    assert.equal((p as { sid: string | null }).sid, null);
  }
  assert.equal(isServerWideList("kill-server", { kind: "none" }), false);
  assert.equal(isServerWideList("list-sessions", { kind: "none" }), true);
});

test("[S8] 형식 밖 지목 → gone(null) · 슬러그가 형식 밖이면 던진다(조용히 다른 이름을 만들지 않는다)", () => {
  assert.equal(planTmux(SLUG, ["has-session", "-t", "../x"], [A]).kind, "gone");
  assert.throws(() => planTmux("../etc", ["has-session", "-t", A.sid], []));
});

// ── 병합 ──────────────────────────────────────────────────────────────────────

test("[S9] 전부 0 → stdout 이어붙임(조각마다 개행 보장) · code 0", () => {
  const m = mergeFanout([ok("a\n"), ok("b"), ok(""), ok("c\n")]);
  assert.deepEqual(m, { code: 0, stdout: "a\nb\nc\n", stderr: "" });
});

test("[S10] 한 조각이 gone / «no server running» 이면 그 세션 0행, 나머지 병합", () => {
  assert.deepEqual(mergeFanout([ok("a\n"), bad("x", true), ok("c\n")]), { code: 0, stdout: "a\nc\n", stderr: "" });
  assert.deepEqual(mergeFanout([ok("a\n"), bad("no server running on /tmp/x"), ok("c\n")]), { code: 0, stdout: "a\nc\n", stderr: "" });
  assert.deepEqual(mergeFanout([bad("No such container: lvly-s-x")]), { code: 0, stdout: "", stderr: "" }, "전부 0행이어도 «봤다»(code 0 빈 목록)");
});

test("[S11] ★ 한 조각이 그 밖의 실패면 **통째로** 못 봤다 — 한 세션만 빼고 내보내면 산 세션이 죽은 것처럼 보인다", () => {
  const m = mergeFanout([ok("a\n"), bad("runsc exec timeout"), ok("c\n")]);
  assert.equal(m.code, 1);
  assert.equal(m.stdout, "", "🔴 부분 결과를 내보냈다");
  assert.match(m.stderr, /통째로 못 봤다/);
  assert.equal(isNoTmuxServer(outcomeToError(m)), false, "«서버 없음» 으로 위장하면 코어가 세션 0 으로 읽는다");
});

test("[S12] parts 0 · 관측함 → TMUX_NO_SERVER — 코어 isNoTmuxServer 가 «세션 0» 으로 읽는다", () => {
  assert.equal(mergeFanout([]), TMUX_NO_SERVER);
  assert.equal(isNoTmuxServer(outcomeToError(TMUX_NO_SERVER)), true);
});

test("[S13] ★★ parts 0 · 못 봤다(observed:false) → «세션 0» 이 **아니다** — isNoTmuxServer 가 거짓이어야 strict 호출이 던진다", () => {
  const m = mergeFanout([], false);
  assert.equal(m, TMUX_UNOBSERVED);
  assert.equal(m.code, 1);
  assert.equal(isNoTmuxServer(outcomeToError(m)), false, "🔴 «못 봤다» 를 «없다» 로 읽었다 — killEmptyTmuxServer 가 서버를 죽인다");
  //  아는 세션이 하나라도 있으면 못 본 틱이어도 그것으로 답한다(브로커 색인 규율과 같다).
  assert.equal(mergeFanout([ok("a\n")], false).code, 0);
});

// ── 문구 — 코어 소비자가 읽는 확답 ────────────────────────────────────────────

test("[S2b] sessionGoneResult 의 문구를 코어 isSessionGoneError 가 «끝났다» 로 확정한다 · «서버 없음» 으로 위장하지 않는다", () => {
  const g = sessionGoneResult("box-a-11111111", "lvly-s-x-box-a-11111111");
  const e = outcomeToError(g);
  assert.equal(isSessionGoneError(e, "/opt/homebrew/bin/tmux", false), true);
  assert.equal(isNoTmuxServer(e), false);
  assert.equal(e.code, 1); assert.equal(e.stdout, ""); assert.match(e.stderr, /^can't find session: box-a-11111111 /);
});

test("[S6b] classifyExecOutcome — runsc 가 «컨테이너 없음» 으로 실패하면 gone 으로 다듬고, 그 밖은 그대로", () => {
  const gone = classifyExecOutcome(bad("FetchSpec failed: loading container: file does not exist"), "box-a-11111111", "c");
  assert.equal(gone.gone, true); assert.match(gone.stderr, /can't find session/);
  const other = classifyExecOutcome(bad("can't find window: 0"), "box-a-11111111", "c");
  assert.equal(other.gone, undefined); assert.equal(other.stderr, "can't find window: 0");
  assert.deepEqual(classifyExecOutcome(ok("x"), null, null), ok("x"));
});

// ── 실행 조립 — 실행기 호출 로그로 단언(어디로·무엇을 보냈나) ─────────────────────

test("[R1] runPlan — one: 그 컨테이너에 `-L lvly-<slug> -f /dev/null` 접두로 한 번 · fanout: 컨테이너마다 · gone: 실행기 호출 0", async () => {
  const calls: Array<{ c: string; argv: string[] }> = [];
  const exec = async (c: string, argv: string[]): Promise<TmuxOutcome> => { calls.push({ c, argv }); return ok(`${c}\n`); };
  const one = await runPlan({ kind: "one", sid: A.sid, container: A.container, verb: "has-session" }, SLUG, ["has-session", "-t", A.sid], true, exec);
  assert.equal(one.code, 0);
  assert.deepEqual(calls, [{ c: A.container, argv: ["tmux", "-L", `lvly-${SLUG}`, "-f", "/dev/null", "has-session", "-t", A.sid] }]);
  calls.length = 0;
  const fan = await runPlan({ kind: "fanout", containers: [A.container, B.container], verb: "list-sessions" }, SLUG, ["list-sessions"], true, exec);
  assert.deepEqual(fan, { code: 0, stdout: `${A.container}\n${B.container}\n`, stderr: "" });
  assert.deepEqual(calls.map((x) => x.c), [A.container, B.container]);
  calls.length = 0;
  const gone = await runPlan({ kind: "gone", sid: null, container: null, verb: "kill-server" }, SLUG, ["kill-server"], true, exec);
  assert.equal(calls.length, 0, "🔴 갈 곳 없는 명령에 실행기가 불렸다");
  assert.equal(gone.code, 1); assert.match(gone.stderr, /can't find session: \?/);
});

test("[R2] runPlan — fanout 중 한 컨테이너가 runsc «없음» 으로 죽으면 그 세션 0행(gone 으로 다듬어 병합)", async () => {
  const exec = async (c: string): Promise<TmuxOutcome> => (c === B.container ? bad("loading container: file does not exist") : ok(`${c}\n`));
  const fan = await runPlan({ kind: "fanout", containers: [A.container, B.container], verb: "list-sessions" }, SLUG, ["list-sessions"], true, exec);
  assert.deepEqual(fan, { code: 0, stdout: `${A.container}\n`, stderr: "" });
});

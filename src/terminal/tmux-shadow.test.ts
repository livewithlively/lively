// tmux 그림자 대조(#2600 T2 (d) d3) — spec-d3.md 의 순수 행(E1·C1~C11·P1~P8·G1~G2) + 조립(O1~O5). 행마다 시험 하나.
import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";
import {
  shadowExecutable, foldOldError, classifyOutcome, compareExecuted, comparePlanned, shadowGate, shadowTmux,
  installShadowReporter, resetShadowStats, shadowStats, formatShadowSummary, SHADOW_MAX_INFLIGHT,
  type ShadowEngine, type ShadowReport, type OldOutcome,
} from "./tmux-shadow.js";
import { TMUX_UNOBSERVED, TMUX_NO_SERVER, sessionGoneResult, planTmux, type TmuxOutcome, type SessionRow } from "./tmux-route.js";

afterEach(() => { installShadowReporter(null); resetShadowStats(); });

const SLUG = "acme";
const A: SessionRow = { sid: "box-a-11111111", container: `lvly-s-${SLUG}-box-a-11111111`, inside: true };
const B: SessionRow = { sid: "box-b-22222222", container: `lvly-s-${SLUG}-box-b-22222222`, inside: true };
const ok = (stdout: string): OldOutcome => ({ code: 0, stdout, stderr: "" });
const bad = (stderr: string, code = 1): TmuxOutcome => ({ code, stdout: "", stderr });
const GONE_A = sessionGoneResult(A.sid, A.container);

// ── E1 읽기/쓰기 판정 ────────────────────────────────────────────────────────────────
test("[E1] 읽기 동사만 실행 — 목록·has-session·show-options · display-message/capture-pane 은 -p 가 있을 때만 · 쓰기는 전부 계획만", () => {
  for (const a of [["list-sessions", "-F", "x"], ["ls"], ["list-panes", "-a", "-F", "x"], ["list-windows", "-t", A.sid], ["list-clients", "-t", A.sid],
    ["has-session", "-t", A.sid], ["show-options", "-t", A.sid, "-v", "@x"], ["show-window-options", "-t", A.sid],
    ["display-message", "-p", "-t", A.sid, "#{pane_title}"], ["display-message", "-t", A.sid, "-p", "#{history_size}"], ["capture-pane", "-t", A.sid, "-p"],
    ["-L", "sock", "list-sessions"]]) {
    assert.equal(shadowExecutable(a), true, `🔴 읽기인데 실행 안 함: ${a.join(" ")}`);
  }
  for (const a of [["set-option", "-t", A.sid, "@x", "1"], ["set-window-option", "-t", A.sid, "x", "y"], ["kill-session", "-t", A.sid], ["kill-server"],
    ["send-keys", "-t", A.sid, "ls", "Enter"], ["new-session", "-d", "-s", A.sid], ["clear-history", "-t", A.sid], ["rename-session", "-t", A.sid, "z"],
    ["display-message", "-t", A.sid, "hello"], ["capture-pane", "-t", A.sid], ["set-option", "-t", A.sid, "@note", "-p"], []]) {
    assert.equal(shadowExecutable(a), false, `🔴 쓰기(또는 판정 불가)인데 실행: ${a.join(" ")}`);
  }
});

// ── fold ─────────────────────────────────────────────────────────────────────────────
test("[F1] execFile 거절 접기 — 종료코드가 숫자면 중계가 답한 것(그대로) · 아니면(타임아웃·ENOENT) spawnFailed", () => {
  assert.deepEqual(foldOldError(Object.assign(new Error("x"), { code: 1, stdout: "", stderr: "no server running\n" })), { code: 1, stdout: "", stderr: "no server running\n" });
  const t = foldOldError(Object.assign(new Error("Command failed: timeout"), { code: null, killed: true, stdout: "", stderr: "" }));
  assert.equal(t.spawnFailed, true); assert.equal(t.code, 1); assert.match(t.stderr, /중계 실패/);
  const n = foldOldError(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
  assert.equal(n.spawnFailed, true);
  assert.equal(classifyOutcome(t, "old"), "transport"); assert.equal(classifyOutcome(n, "old"), "transport");
});

test("[F2] 부류 — gone 은 «(session container … is gone)» 확답만(tmux 자신의 can't find 는 other) · 중계 die 는 old 전송 · fold 문구는 new 전송 · «통째로 못 봤다» 는 양쪽 fanoutfail", () => {
  assert.equal(classifyOutcome(GONE_A, "old"), "gone"); assert.equal(classifyOutcome(GONE_A, "new"), "gone");
  assert.equal(classifyOutcome(bad("can't find session: box-a-11111111\n"), "old"), "other", "🔴 tmux 자신의 can't find 를 브로커 gone 으로 읽었다");
  assert.equal(classifyOutcome(TMUX_NO_SERVER, "old"), "noserver");
  assert.equal(classifyOutcome(TMUX_UNOBSERVED, "new"), "unobserved");
  assert.equal(classifyOutcome(TMUX_UNOBSERVED, "old"), "other", "옛 경로엔 «못 봤다» 가 없다");
  assert.equal(classifyOutcome(bad("lvly tmux-relay: 브로커에 못 닿음(sock): connect ECONNREFUSED\n"), "old"), "transport");
  assert.equal(classifyOutcome(bad("lvly tmux-relay: 브로커에 못 닿음\n"), "new"), "other", "중계 문구는 코어 경로에 안 나온다");
  assert.equal(classifyOutcome(bad("브로커 세션 목록 조회 실패(못 봤다): connect ECONNREFUSED"), "new"), "transport");
  assert.equal(classifyOutcome(bad("broker exec-create 실패: 500: boom"), "new"), "transport");
  assert.equal(classifyOutcome(bad("세션 컨테이너 tmux 조회 실패(목록을 통째로 못 봤다): x"), "old"), "fanoutfail");
  assert.equal(classifyOutcome(bad("세션 컨테이너 tmux 조회 실패(목록을 통째로 못 봤다): x"), "new"), "fanoutfail", "🔴 «통째로 못 봤다)» 가 (못 봤다) 전송으로 잡혔다");
  assert.equal(classifyOutcome(ok("x"), "old"), "ok");
});

// ── C 실행 대조 ──────────────────────────────────────────────────────────────────────
test("[C1] 둘 다 0 · stdout 같음 → match", () => { assert.deepEqual(compareExecuted(ok("a\nb\n"), ok("a\nb\n")), { kind: "match" }); });
test("[C2] 둘 다 0 · 줄 집합 같고 순서만 → explained:order", () => { assert.deepEqual(compareExecuted(ok("b\na\n"), ok("a\nb\n")), { kind: "explained", why: "order" }); });
test("[C3] 둘 다 0 · 줄 집합 다름 → mismatch:stdout (줄 수·첫 다른 줄)", () => {
  const v = compareExecuted(ok("a\nb\n"), ok("a\nc\n"));
  assert.equal(v.kind, "mismatch"); assert.equal((v as { why: string }).why, "stdout"); assert.match((v as { detail: string }).detail, /old 2줄 · new 2줄 · 첫 다른 줄 "b"/);
  const w = compareExecuted(ok("a\nb\n"), ok("a\nb\nb\n"));
  assert.equal(w.kind, "mismatch", "🔴 중복 줄(다중집합)을 못 가른다");
});
test("[C4] old no server running · new 못 봤다 → explained:unobserved", () => { assert.deepEqual(compareExecuted(TMUX_NO_SERVER, TMUX_UNOBSERVED), { kind: "explained", why: "unobserved" }); });
test("[C5] old 중계 전송 실패 → explained:old-transport (new 가 무엇이든)", () => {
  const t = bad("lvly tmux-relay: 브로커 응답 없음(총 예산 20000ms 초과, 3회 시도): sock\n");
  assert.deepEqual(compareExecuted(t, ok("a\n")), { kind: "explained", why: "old-transport" });
  assert.deepEqual(compareExecuted({ ...bad(""), spawnFailed: true }, GONE_A), { kind: "explained", why: "old-transport" });
});
test("[C6] old ok · new 전송 실패 → explained:new-transport (503 사다리 부재가 여기 빈도로 보인다)", () => {
  assert.deepEqual(compareExecuted(ok("a\n"), bad("브로커 세션 목록 조회 실패(못 봤다): 503")), { kind: "explained", why: "new-transport" });
  assert.deepEqual(compareExecuted(GONE_A, bad("broker exec-start 실패: x")), { kind: "explained", why: "new-transport" });
});
test("[C7] 둘 다 gone 같은 문구 → match", () => { assert.deepEqual(compareExecuted(GONE_A, { ...GONE_A }), { kind: "match" }); });
test("[C8] 같은 부류 · 문구만 다름 → explained:text", () => {
  assert.deepEqual(compareExecuted(bad("no server running\n"), bad("no server running (exit-empty)")), { kind: "explained", why: "text" });
  assert.deepEqual(compareExecuted(bad("can't find session: x"), bad("can't find session: y")), { kind: "explained", why: "text" });
});
test("[C9] old ok · new 못 봤다 → mismatch:unobserved-vs-ok", () => {
  const v = compareExecuted(ok("a\n"), TMUX_UNOBSERVED);
  assert.equal(v.kind, "mismatch"); assert.equal((v as { why: string }).why, "unobserved-vs-ok");
});
test("[C10] 한쪽만 0(전송 아님) → mismatch:code", () => {
  const v = compareExecuted(ok("a\n"), GONE_A); assert.equal(v.kind, "mismatch"); assert.equal((v as { why: string }).why, "code");
  const w = compareExecuted(GONE_A, ok("a\n")); assert.equal(w.kind, "mismatch"); assert.equal((w as { why: string }).why, "code");
  const x = compareExecuted(TMUX_NO_SERVER, ok("")); assert.equal(x.kind, "mismatch", "🔴 «서버 없음» vs 빈 성공을 같다고 봤다 — 상위는 다르게 갈린다(isNoTmuxServer)");
});
test("[C11] 둘 다 비-0 · 부류 다름 → mismatch:class", () => {
  const v = compareExecuted(GONE_A, TMUX_NO_SERVER); assert.equal(v.kind, "mismatch"); assert.equal((v as { why: string }).why, "class");
  const w = compareExecuted(bad("no server running"), bad("세션 컨테이너 tmux 조회 실패(목록을 통째로 못 봤다): x")); assert.equal(w.kind, "mismatch");
});

// ── P 계획 대조(쓰기 동사) ─────────────────────────────────────────────────────────────
const plan = (args: string[], sessions: SessionRow[], observed = true) => planTmux(SLUG, args, sessions, observed);
test("[P1] old 브로커 gone(C) · plan gone 같은 C → match", () => {
  assert.deepEqual(comparePlanned(GONE_A, plan(["set-option", "-t", A.sid, "@x", "1"], [])), { kind: "match" });
});
test("[P2] old gone · plan one → mismatch:plan", () => {
  const v = comparePlanned(GONE_A, plan(["set-option", "-t", A.sid, "@x", "1"], [A])); assert.equal(v.kind, "mismatch"); assert.equal((v as { why: string }).why, "plan");
});
test("[P3] old reached(0 또는 tmux 자체 오류) · plan one → match", () => {
  assert.deepEqual(comparePlanned(ok(""), plan(["set-option", "-t", A.sid, "@x", "1"], [A])), { kind: "match" });
  assert.deepEqual(comparePlanned(bad("can't find session: box-a-11111111\n"), plan(["kill-session", "-t", A.sid], [A])), { kind: "match" }, "tmux 자신의 오류 = 컨테이너엔 닿았다");
  assert.deepEqual(comparePlanned(TMUX_NO_SERVER, plan(["set-option", "-t", A.sid, "@x", "1"], [A])), { kind: "match" }, "컨테이너 안 서버 부재 = 닿았다");
});
test("[P4] old reached · plan gone → mismatch:plan", () => {
  const v = comparePlanned(ok(""), plan(["set-option", "-t", A.sid, "@x", "1"], [B])); assert.equal(v.kind, "mismatch"); assert.equal((v as { why: string }).why, "plan");
  assert.match((v as { detail: string }).detail, new RegExp(A.container));
});
test("[P5] plan unobserved → explained:unobserved", () => {
  assert.deepEqual(comparePlanned(GONE_A, plan(["set-option", "-t", A.sid, "@x", "1"], [], false)), { kind: "explained", why: "unobserved" });
});
test("[P6] old 전송 실패 → explained:old-transport", () => {
  assert.deepEqual(comparePlanned(bad("lvly tmux-relay: x"), plan(["kill-session", "-t", A.sid], [A])), { kind: "explained", why: "old-transport" });
});
test("[P7] 지목 없는 쓰기(kill-server) — old gone(sid ?) · plan gone(null) → match · 컨테이너가 다르면 mismatch", () => {
  const p = plan(["kill-server"], [A]); assert.equal(p.kind, "gone");
  assert.deepEqual(comparePlanned(sessionGoneResult(null, null), p), { kind: "match" });
  const v = comparePlanned(sessionGoneResult(null, "lvly-s-acme-other"), p); assert.equal(v.kind, "mismatch");
});
test("[P8] 쓰기 동사 · 계획 fanout(있을 수 없지만) · old ok → match / old gone → mismatch", () => {
  const p = plan(["list-sessions"], [A]); assert.equal(p.kind, "fanout");
  assert.deepEqual(comparePlanned(ok("x"), p), { kind: "match" });
  assert.equal(comparePlanned(GONE_A, p).kind, "mismatch");
});

// ── G 게이트 ──────────────────────────────────────────────────────────────────────────
test("[G1·G2] 동시 상한 → skipped:inflight · 표본 밖 → skipped:sample · 표본 1 은 난수를 안 본다", () => {
  assert.deepEqual(shadowGate(1, SHADOW_MAX_INFLIGHT), { kind: "skipped", why: "inflight" });
  assert.equal(shadowGate(1, SHADOW_MAX_INFLIGHT - 1, () => { throw new Error("난수 호출"); }), null);
  assert.deepEqual(shadowGate(0.25, 0, () => 0.5), { kind: "skipped", why: "sample" });
  assert.equal(shadowGate(0.25, 0, () => 0.1), null);
  assert.deepEqual(shadowGate(0.25, 0, () => 0.25), { kind: "skipped", why: "sample" }, "경계 — rand < sample 만 견준다(0.25 는 밖 · P = 정확히 sample)");
});

// ── O 조립 ────────────────────────────────────────────────────────────────────────────
function engine(o: { sessions?: SessionRow[]; observed?: boolean; listErr?: string; out?: (c: string) => TmuxOutcome }): ShadowEngine & { execs: string[] } {
  const execs: string[] = [];
  return {
    execs,
    list: async () => { if (o.listErr) throw new Error(o.listErr); return { observed: o.observed ?? true, sessions: o.sessions ?? [] }; },
    exec: async (c) => { execs.push(c); return o.out ? o.out(c) : { code: 0, stdout: `${c}\n`, stderr: "" }; },
  };
}
const oldOk = (s: string): Promise<{ stdout: string }> => Promise.resolve({ stdout: s });
const oldFail = (e: object): Promise<{ stdout: string }> => Promise.reject(Object.assign(new Error("Command failed"), e));

test("[O1] 읽기 동사 — 실행 · 판정 · 통계 · 리포터 한 번", async () => {
  const e = engine({ sessions: [B, A] });
  const reps: ShadowReport[] = []; installShadowReporter((r) => reps.push(r));
  const v = await shadowTmux(["list-sessions", "-F", "x"], SLUG, 1, oldOk(`${A.container}\n${B.container}\n`), () => e);
  assert.deepEqual(v, { kind: "match" }); assert.deepEqual(e.execs, [A.container, B.container], "sid 순");
  assert.equal(reps.length, 1); assert.equal(reps[0]!.executed, true); assert.equal(reps[0]!.verb, "list-sessions"); assert.equal(reps[0]!.stats.compared, 1);
});
test("[O2] 쓰기 동사 — exec 0 · 계획 대조", async () => {
  const e = engine({ sessions: [A] });
  assert.deepEqual(await shadowTmux(["send-keys", "-t", A.sid, "rm -rf /", "Enter"], SLUG, 1, oldOk(""), () => e), { kind: "match" });
  assert.deepEqual(e.execs, [], "🔴 send-keys 가 두 번 들어갔다");
});
test("[O3] 목록 조회 실패 — 읽기·쓰기 모두 explained:new-transport (old 가 전송 실패면 old-transport 가 이긴다)", async () => {
  assert.deepEqual(await shadowTmux(["list-sessions"], SLUG, 1, oldOk("a\n"), () => engine({ listErr: "ECONNREFUSED" })), { kind: "explained", why: "new-transport" });
  assert.deepEqual(await shadowTmux(["set-option", "-t", A.sid, "@x", "1"], SLUG, 1, oldOk(""), () => engine({ listErr: "ECONNREFUSED" })), { kind: "explained", why: "new-transport" });
  assert.deepEqual(await shadowTmux(["set-option", "-t", A.sid, "@x", "1"], SLUG, 1, oldFail({ code: null, killed: true }), () => engine({ listErr: "x" })), { kind: "explained", why: "old-transport" });
});
test("[O4] 엔진을 못 만들면(https 허브 등) mismatch:internal — 조용히 묻지 않는다", async () => {
  const v = await shadowTmux(["list-sessions"], SLUG, 1, oldOk(""), () => { throw new Error("허브 URL 은 http 여야 한다"); });
  assert.equal(v.kind, "mismatch"); assert.equal((v as { why: string }).why, "internal"); assert.match((v as { detail: string }).detail, /http 여야/);
  assert.equal(shadowStats().mismatch.internal, 1);
});
test("[O5] old 가 거절해도(gone) 그림자는 절대 거절하지 않는다 · 같은 gone 이면 match", async () => {
  const v = await shadowTmux(["has-session", "-t", A.sid], SLUG, 1, oldFail({ code: 1, stdout: "", stderr: GONE_A.stderr }), () => engine({ sessions: [] }));
  assert.deepEqual(v, { kind: "match" });
});
test("[O6] 동시 상한 — 목록이 매달린 채 5번째는 skipped:inflight (요청 0)", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  let listCalls = 0;
  const slow: ShadowEngine = { list: async () => { listCalls++; await gate; return { observed: true, sessions: [] }; }, exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
  const inflight = Array.from({ length: SHADOW_MAX_INFLIGHT }, () => shadowTmux(["list-sessions"], SLUG, 1, oldOk(""), () => slow));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(await shadowTmux(["list-sessions"], SLUG, 1, oldOk(""), () => slow), { kind: "skipped", why: "inflight" });
  assert.equal(listCalls, SHADOW_MAX_INFLIGHT, "🔴 상한을 넘겨 목록을 또 불렀다");
  release(); await Promise.all(inflight);
  assert.equal(shadowStats().skipped.inflight, 1); assert.equal(shadowStats().compared, SHADOW_MAX_INFLIGHT);
  const after = await shadowTmux(["list-sessions"], SLUG, 1, oldOk(""), () => slow);
  assert.equal(after.kind, "mismatch", "풀리면 다시 견준다 — old 빈 성공 vs new «no server running» 은 code 불일치(C10)");
  assert.equal(listCalls, SHADOW_MAX_INFLIGHT + 1);
});
test("[S1] 요약 — 누적 카운터·mismatchTotal·경과분", () => {
  const s = shadowStats(); s.compared = 3; s.match = 1; s.explained.order = 1; s.mismatch.plan = 1; s.startedAt = Date.now() - 125_000;
  const f = formatShadowSummary(s);
  assert.equal(f.mismatchTotal, 1); assert.equal(f.sinceMin, 2); assert.deepEqual(f.explained, { order: 1 });
});

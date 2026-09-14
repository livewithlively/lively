// 아웃박스 걸음을 세션 호스트가 실행한다 — `runOutboxStep` (#2600 T2 d6 · #3773 PR1).
//
//  ── 무엇을 지키나 ──
//  이 걸음의 값어치는 «얼마나 했나» 를 **값으로** 돌려주는 데 있다. 오늘의 `sendKeys` op 는 던지므로, RPC 를 건너면
//   «한 글자도 안 쳤다» 와 «치다 멈췄다» 가 같은 오류 문자열이 된다. 값만 재면 우연히 통과하므로 «tmux 를 무엇으로
//   어떤 순서로 불렀나» 를 사건 기록으로 잰다 — 거절은 0번, 확인에서 멈춘 치기는 글자 0번이어야 한다.
//  «세션 없음» 판정은 가짜를 끼우지 않고 진짜(`isSessionGoneError`)를 쓴다 — 오류 모양만 tmux 처럼 만든다.
//  엣지 표는 스크래치패드 `d6/pr1/spec.md` 의 P1~P9(가지 행 포함).
import assert from "node:assert/strict";
import test from "node:test";
import { runOutboxStep, typedOutcomeOf, OUTBOX_KEYS_MAX_DOWN, type OutboxStepDeps } from "./outbox-host-step.js";
import { firstPromptStep, trustAcceptDowns, tailOf } from "./session-first-prompt.js";
import { injectFlushMs } from "./send-keys.js";
import { isSessionGoneError } from "./tmux-exec.js";

const ID = "box-a";

/** tmux 가 **답해서** «그런 세션 없음» 이라고 한 오류(execFile 모양). */
const goneErr = (): Error => Object.assign(new Error(`Command failed: tmux has-session -t ${ID}`), { code: 1, stderr: `can't find session: ${ID}\n` });
/** 무응답 — 시간 초과로 죽였다(닿았는지 모른다). */
const killedErr = (): Error => Object.assign(new Error(`Command failed: tmux has-session -t ${ID}`), { killed: true, signal: "SIGTERM", stderr: "" });

/** 가짜 호스트 — tmux 호출과 대기를 한 줄의 사건 기록으로 남긴다(무엇을 어떤 순서로 했나). */
function fakeHost(o: { fail?: (argv: string[]) => Error | null; pane?: string; paneCmd?: string } = {}) {
  const events: string[] = [];
  const deps: Partial<OutboxStepDeps> = {
    tmux: async (argv) => {
      events.push(argv[0] === "send-keys" ? `send-keys ${argv.slice(3).join(" ")}` : argv[0]);
      const err = o.fail?.(argv);
      if (err) throw err;
      if (argv[0] === "capture-pane") return o.pane ?? "";
      if (argv[0] === "display-message") return o.paneCmd ?? "claude\n";
      return "";
    },
    sleep: async (ms) => { events.push(`sleep ${ms}`); },
    bin: "tmux",
  };
  return { deps, events };
}
const isText = (argv: string[]): boolean => argv[0] === "send-keys" && argv.includes("-l");
const isKey = (key: string) => (argv: string[]): boolean => argv[0] === "send-keys" && argv[argv.length - 1] === key;

/** 거절이어야 하고, 그 판단은 tmux 를 한 번도 부르기 전에 끝나야 한다. */
async function rejectedWithoutTmux(args: unknown, what: string): Promise<void> {
  const h = fakeHost();
  const r = await runOutboxStep(args, h.deps);
  assert.equal("unsupported" in r && r.unsupported === true, true, `${what} 을 거절하지 않았다: ${JSON.stringify(r)}`);
  assert.deepEqual(h.events, [], `${what} 에 tmux 를 불렀다 — 거절은 «아무것도 안 했다» 여야 받는 쪽이 다시 할 수 있다`);
}

// ── 치기(type) ──────────────────────────────────────────────────────────────

test("★ P1 치기 — 세션 확인이 «세션 없음» 이면 none/gone, 글자는 한 번도 안 보낸다", async () => {
  const h = fakeHost({ fail: (a) => (a[0] === "has-session" ? goneErr() : null) });
  assert.deepEqual(await runOutboxStep({ step: "type", id: ID, text: "안녕" }, h.deps), { ok: false, typed: "none", reach: "gone" });
  assert.deepEqual(h.events, ["has-session"], "확인에서 멈췄는데 글자·Enter 가 나갔다 — none 은 «다시 쳐도 된다» 는 뜻이다");
});

test("★ P2 치기 — 세션 확인이 무응답(killed)이면 none/unknown — 모르는 것을 «없다» 로 올리지 않는다", async () => {
  const h = fakeHost({ fail: (a) => (a[0] === "has-session" ? killedErr() : null) });
  assert.deepEqual(await runOutboxStep({ step: "type", id: ID, text: "안녕" }, h.deps), { ok: false, typed: "none", reach: "unknown" });
  assert.deepEqual(h.events, ["has-session"]);
});

test("★ P3 치기 — 글자를 싣다 실패하면 partial/text 이고 Enter 는 누르지 않는다", async () => {
  const h = fakeHost({ fail: (a) => (isText(a) ? killedErr() : null) });
  assert.deepEqual(await runOutboxStep({ step: "type", id: ID, text: "안녕" }, h.deps), { ok: false, typed: "partial", at: "text" });
  assert.deepEqual(h.events, ["has-session", "send-keys -l 안녕"], "반쪽이 남았을 수 있는 입력칸에 Enter 를 눌렀다");
});

test("★ P4 치기 — Enter 가 실패하면 partial/enter", async () => {
  const h = fakeHost({ fail: (a) => (isKey("Enter")(a) ? killedErr() : null) });
  assert.deepEqual(await runOutboxStep({ step: "type", id: ID, text: "안녕" }, h.deps), { ok: false, typed: "partial", at: "enter" });
  assert.deepEqual(h.events, ["has-session", "send-keys -l 안녕", `sleep ${injectFlushMs(2)}`, "send-keys Enter"]);
});

test("P4a 치기 — 전부 되면 full · 확인 → 평탄화한 한 줄 → flush 대기 → Enter 순서(send-keys 규약 그대로)", async () => {
  const h = fakeHost();
  assert.deepEqual(await runOutboxStep({ step: "type", id: ID, text: "첫 줄\n  둘째 줄" }, h.deps), { ok: true, typed: "full" });
  const oneLine = "첫 줄 둘째 줄";
  assert.deepEqual(h.events, ["has-session", `send-keys -l ${oneLine}`, `sleep ${injectFlushMs(oneLine.length)}`, "send-keys Enter"]);
});

test("★ P4b 확인을 지난 뒤의 실패는 «세션 없음» 모양이어도 partial — none 으로 내리면 받는 쪽이 다시 쳐서 두 번 간다", async () => {
  assert.deepEqual(typedOutcomeOf("text", goneErr(), isSessionGoneError), { ok: false, typed: "partial", at: "text" });
  assert.deepEqual(typedOutcomeOf("enter", goneErr(), isSessionGoneError), { ok: false, typed: "partial", at: "enter" });
  assert.deepEqual(typedOutcomeOf("check", goneErr(), isSessionGoneError), { ok: false, typed: "none", reach: "gone" });
  assert.deepEqual(typedOutcomeOf("check", killedErr(), isSessionGoneError), { ok: false, typed: "none", reach: "unknown" });
  const h = fakeHost({ fail: (a) => (isKey("Enter")(a) ? goneErr() : null) });
  assert.deepEqual(await runOutboxStep({ step: "type", id: ID, text: "안녕" }, h.deps), { ok: false, typed: "partial", at: "enter" });
});

test("★ P5 치기 — 글이 비었거나 공백·개행뿐이면 거절, tmux 0회", async () => {
  for (const text of ["", "   ", "\n\t\n"]) await rejectedWithoutTmux({ step: "type", id: ID, text }, `빈 글 ${JSON.stringify(text)}`);
});

test("P5a 치기 — 글이 없거나 문자열이 아니면(새 값이 빔) 거절, tmux 0회", async () => {
  await rejectedWithoutTmux({ step: "type", id: ID }, "글 없음");
  await rejectedWithoutTmux({ step: "type", id: ID, text: 123 }, "숫자 글");
  await rejectedWithoutTmux({ step: "type", id: ID, text: null }, "null 글");
});

test("P5b 치기 — 한 글자(경계)도 full 이고 flush 는 send-keys 규약의 값을 쓴다", async () => {
  const h = fakeHost();
  assert.deepEqual(await runOutboxStep({ step: "type", id: ID, text: "x" }, h.deps), { ok: true, typed: "full" });
  assert.deepEqual(h.events, ["has-session", "send-keys -l x", `sleep ${injectFlushMs(1)}`, "send-keys Enter"]);
});

// ── 공통 거절 ───────────────────────────────────────────────────────────────

test("★ P6 모르는 걸음·걸음 없음·객체가 아닌 인자는 거절, tmux 0회 — 다른 칸이 멀쩡해도 짐작해 실행하지 않는다", async () => {
  const valid = { id: ID, text: "안녕", down: 1, enter: true };   // 걸음 이름만 틀렸다 — 짐작하면 무언가를 친다
  await rejectedWithoutTmux({ ...valid }, "걸음 없음");
  await rejectedWithoutTmux({ ...valid, step: "enter" }, "모르는 걸음");
  await rejectedWithoutTmux({ ...valid, step: "PEEK" }, "대문자 걸음");
  await rejectedWithoutTmux({ ...valid, step: 1 }, "숫자 걸음");
  for (const bad of [null, undefined, "peek", 42, []]) await rejectedWithoutTmux(bad, `인자 ${JSON.stringify(bad)}`);
});

test("★ P6a 세션 id 가 없거나 비었거나 문자열이 아니면(새 값이 빔) 세 걸음 모두 거절, tmux 0회", async () => {
  const steps: Array<Record<string, unknown>> = [{ step: "peek" }, { step: "keys", down: 1, enter: true }, { step: "type", text: "안녕" }];
  for (const s of steps) {
    await rejectedWithoutTmux({ ...s }, `${String(s.step)} id 없음`);
    for (const id of ["", "   ", 42, null]) await rejectedWithoutTmux({ ...s, id }, `${String(s.step)} id ${JSON.stringify(id)}`);
  }
});

// ── 누르기(keys) ────────────────────────────────────────────────────────────

test("★ P7 누르기 — 0칸·Enter 없음(경계)이면 ok 이고 세션 확인조차 안 한다(tmux 0회)", async () => {
  const h = fakeHost();
  assert.deepEqual(await runOutboxStep({ step: "keys", id: ID, down: 0, enter: false }, h.deps), { ok: true });
  assert.deepEqual(h.events, []);
});

test("P7a 누르기 — down·enter 가 없으면(새 값이 빔) 누를 것이 없다: ok, tmux 0회", async () => {
  const h = fakeHost();
  assert.deepEqual(await runOutboxStep({ step: "keys", id: ID }, h.deps), { ok: true });
  assert.deepEqual(h.events, []);
});

test("★ P8 누르기 — down 이 음수·소수·문자열·NaN·null·안전 정수 밖이거나 enter 가 불리언이 아니면 거절, tmux 0회", async () => {
  for (const down of [-1, 1.5, "1", NaN, null, 2 ** 53, Infinity]) {
    await rejectedWithoutTmux({ step: "keys", id: ID, down, enter: true }, `down ${String(down)}`);
  }
  for (const enter of ["true", 1, null]) {
    await rejectedWithoutTmux({ step: "keys", id: ID, down: 1, enter }, `enter ${String(enter)}`);
  }
});

test("P8a 누르기 — 확인 → 아래 n칸 → Enter 를 그 순서로, 시킨 만큼만", async () => {
  const a = fakeHost();
  assert.deepEqual(await runOutboxStep({ step: "keys", id: ID, down: 1, enter: true }, a.deps), { ok: true });
  assert.deepEqual(a.events, ["has-session", "send-keys Down", "send-keys Enter"]);
  const b = fakeHost();
  assert.deepEqual(await runOutboxStep({ step: "keys", id: ID, down: 2, enter: false }, b.deps), { ok: true });
  assert.deepEqual(b.events, ["has-session", "send-keys Down", "send-keys Down"], "Enter 를 안 시켰는데 눌렀다");
});

test("P8b 누르기 — 세션 확인이 «세션 없음» 이면 at=check·reach=gone, 키 0", async () => {
  const h = fakeHost({ fail: (a) => (a[0] === "has-session" ? goneErr() : null) });
  assert.deepEqual(await runOutboxStep({ step: "keys", id: ID, down: 1, enter: true }, h.deps), { ok: false, at: "check", reach: "gone" });
  assert.deepEqual(h.events, ["has-session"]);
});

test("★ P8c 누르기 — 아래로 내리다 실패하면 at=down 에서 멈추고 Enter 는 누르지 않는다(커서가 «No, exit» 에 있을 수 있다)", async () => {
  const h = fakeHost({ fail: (a) => (isKey("Down")(a) ? killedErr() : null) });
  assert.deepEqual(await runOutboxStep({ step: "keys", id: ID, down: 1, enter: true }, h.deps), { ok: false, at: "down" });
  assert.deepEqual(h.events, ["has-session", "send-keys Down"], "내리기가 실패했는데 Enter 를 눌렀다");
});

test("P8d 누르기 — Enter 가 실패하면 at=enter", async () => {
  const h = fakeHost({ fail: (a) => (isKey("Enter")(a) ? killedErr() : null) });
  assert.deepEqual(await runOutboxStep({ step: "keys", id: ID, down: 0, enter: true }, h.deps), { ok: false, at: "enter" });
  assert.deepEqual(h.events, ["has-session", "send-keys Enter"]);
});

//  #3773 PR1 후속 — 칸 하나가 tmux 호출 하나라, 상한 없는 `down` 한 요청이 호스트에서 끝나지 않는 루프가 됐다. 게이트웨이도 같은 상수를 넘지 않는다.
test("★ K1 누르기 상한 — down 이 정확히 상한이면 받는다: 확인 → 아래 상한 칸 → Enter", async () => {
  const h = fakeHost();
  assert.deepEqual(await runOutboxStep({ step: "keys", id: ID, down: OUTBOX_KEYS_MAX_DOWN, enter: true }, h.deps), { ok: true });
  assert.deepEqual(h.events, ["has-session", ...Array.from({ length: OUTBOX_KEYS_MAX_DOWN }, () => "send-keys Down"), "send-keys Enter"]);
});

test("★ K2 누르기 상한+1 — Enter 유무와 무관하게 거절, tmux 0", async () => {
  await rejectedWithoutTmux({ step: "keys", id: ID, down: OUTBOX_KEYS_MAX_DOWN + 1, enter: true }, `down ${OUTBOX_KEYS_MAX_DOWN + 1}`);
  await rejectedWithoutTmux({ step: "keys", id: ID, down: OUTBOX_KEYS_MAX_DOWN + 1, enter: false }, `Enter 없는 down ${OUTBOX_KEYS_MAX_DOWN + 1}`);
});

// ── 보기(peek) ──────────────────────────────────────────────────────────────

const transcript = (n: number): string[] => Array.from({ length: n }, (_, i) => `지난 대화 ${i + 1}`);
// Claude Code 입력창(하단) — 판정이 «떴다» 로 읽는 표식(`? for shortcuts`)이 마지막 줄에 있다.
const INPUT = ["╭──────────────────────────╮", "│ >                        │", "╰──────────────────────────╯", "  ? for shortcuts"];
// 현행(2.1.263) 신뢰 대화상자 — 커서가 «No, exit».
const TRUST = [
  "Quick safety check: Is this a project you created or one you trust?",
  "Claude Code'll be able to read, edit, and execute files here.",
  "❯ No, exit",
  "  Yes, I trust this folder",
  "Enter to confirm · Esc to cancel",
];

test("★ P9 보기 — 30줄 화면에서 마지막 14줄만 싣고, 그 꼬리로 한 판정이 원문 화면으로 한 판정과 같다", async () => {
  const screens = [
    { name: "입력창", lines: [...transcript(26), ...INPUT], harness: "claude", paneCmd: "claude", elapsedMs: 1000, trustOk: false, expect: "send" },
    { name: "신뢰 대화상자", lines: [...transcript(25), ...TRUST], harness: "claude", paneCmd: "claude", elapsedMs: 1000, trustOk: true, expect: "accept-trust" },
    { name: "부팅 중(표식 없음)", lines: transcript(30), harness: "claude", paneCmd: "claude", elapsedMs: 1000, trustOk: false, expect: "wait" },
    { name: "입력창 문구를 모르는 하네스", lines: transcript(30), harness: "other-harness", paneCmd: "node", elapsedMs: 7000, trustOk: false, expect: "send" },
  ];
  for (const s of screens) {
    assert.equal(s.lines.length, 30);
    const raw = s.lines.join("\n");
    const h = fakeHost({ pane: raw, paneCmd: `${s.paneCmd}\n` });
    const r = await runOutboxStep({ step: "peek", id: ID }, h.deps);
    assert.ok(r.ok && "pane" in r, `${s.name}: 보기가 실패했다 ${JSON.stringify(r)}`);
    assert.deepEqual(r.pane.split("\n"), s.lines.slice(-14), `${s.name}: 꼬리 14줄이 아니다`);
    assert.equal(r.paneCmd, s.paneCmd);
    assert.deepEqual(h.events, ["capture-pane", "display-message"]);
    const judge = (pane: string, paneCmd: string) =>
      firstPromptStep({ pane, harness: s.harness, paneCmd, elapsedMs: s.elapsedMs, maxMs: 20_000, trustOk: s.trustOk });
    assert.equal(judge(raw, s.paneCmd), s.expect, `${s.name}: 시험 화면이 의도한 판정을 안 낸다 — 아래 비교가 아무것도 안 잰다`);
    assert.equal(judge(r.pane, r.paneCmd), judge(raw, s.paneCmd), `${s.name}: 꼬리로 한 판정이 원문과 다르다`);
    assert.deepEqual(trustAcceptDowns(tailOf(r.pane)), trustAcceptDowns(tailOf(raw)), `${s.name}: 신뢰 대화상자 칸 수가 원문과 다르다`);
  }
});

test("P9a 보기 — 경계: 14줄은 그대로, 15줄은 첫 줄만 빠진다", async () => {
  const fourteen = transcript(14);
  const a = fakeHost({ pane: fourteen.join("\n") });
  const ra = await runOutboxStep({ step: "peek", id: ID }, a.deps);
  assert.ok(ra.ok && "pane" in ra);
  assert.equal(ra.pane, fourteen.join("\n"));
  const fifteen = transcript(15);
  const b = fakeHost({ pane: fifteen.join("\n") });
  const rb = await runOutboxStep({ step: "peek", id: ID }, b.deps);
  assert.ok(rb.ok && "pane" in rb);
  assert.deepEqual(rb.pane.split("\n"), fifteen.slice(1));
});

test("P9b 보기 — 화면이 비었으면(새 값이 빔) 빈 꼬리를 싣고 실패로 치지 않는다 · 판정은 원문과 같다(claude 는 기다린다)", async () => {
  for (const raw of ["", "\n\n   \n"]) {
    const h = fakeHost({ pane: raw, paneCmd: " claude \n" });
    const r = await runOutboxStep({ step: "peek", id: ID }, h.deps);
    assert.deepEqual(r, { ok: true, pane: "", paneCmd: "claude" }, `빈 화면 ${JSON.stringify(raw)}`);
    const judge = (pane: string) => firstPromptStep({ pane, harness: "claude", paneCmd: "claude", elapsedMs: 1000, maxMs: 20_000, trustOk: false });
    assert.equal(judge(r.ok && "pane" in r ? r.pane : "?"), judge(raw));
    assert.equal(judge(raw), "wait");
  }
});

test("P9c 보기 — 화면을 못 읽으면 닿았나만 답한다(확답이면 gone, 무응답이면 unknown)", async () => {
  const g = fakeHost({ fail: (a) => (a[0] === "capture-pane" ? goneErr() : null) });
  assert.deepEqual(await runOutboxStep({ step: "peek", id: ID }, g.deps), { ok: false, reach: "gone" });
  const k = fakeHost({ fail: (a) => (a[0] === "display-message" ? killedErr() : null) });
  assert.deepEqual(await runOutboxStep({ step: "peek", id: ID }, k.deps), { ok: false, reach: "unknown" });
});

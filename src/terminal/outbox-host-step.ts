// 아웃박스의 **한 걸음**을 세션 호스트가 실행한다 — 보기(peek)·누르기(keys)·치기(type) (#2600 T2 d6 · #3773).
//
// ── 왜 ──────────────────────────────────────────────────────────────────────────
// 아웃박스(첫 지시·대화 입력 배달 — `sessions/session-outbox.ts`)는 게이트웨이 tmux 를 직접 친다: 준비 판정의 화면·포그라운드
//  읽기(폴마다 둘) · 신뢰 대화상자 키 · send-keys. d6 완료 조건 «그 테넌트 게이트웨이 tmux 0» 에 남은 큰 자리가 이것이다.
//  같은 tmux 를 그 세션의 호스트는 자기 노드에서 바로 만진다.
//
// ── 판정은 여기 없다 ─────────────────────────────────────────────────────────────
// 호스트는 **보고·누르고·친다.** 입력창이 떴나(`firstPromptStep`)·«Yes» 까지 몇 칸인가(`trustAcceptDowns`)는 게이트웨이가
//  이 걸음이 돌려준 화면으로 판정한다. 판정을 호스트에 두면 화면 규칙이 두 번들에 한 판씩 산다 — 호스트 번들은 게이트웨이와
//  따로 갱신되므로(매니지드는 설치자 타이머, 멤버 PC 는 자가 갱신) 그 사이 두 판이 갈린다.
//  여기 남는 판정은 «세션에 닿았나»(`isSessionGoneError`) 하나다. 그건 tmux 오류의 필드(stderr·killed)를 가진 이 자리에서만
//  할 수 있다 — RPC 를 건너면 메시지 문자열만 남는다.
//
// ── 늘 값으로 답한다 ─────────────────────────────────────────────────────────────
// 실패도 던지지 않고 **어디서 멈췄나**를 돌려준다. 던지면 RPC 가 오류 문자열 하나가 되어 «한 글자도 안 쳤다»(다시 쳐도
//  된다)와 «치다 멈췄다»(다시 치면 두 번 간다)가 구별되지 않는다 — `send-keys.ts` 의 `SendKeysNotStarted` 가 프로세스 안에서
//  하던 구별을 RPC 너머까지 나르는 것이다. 거절(모르는 걸음·빈 id·빈 글·잘못된 칸 수)은 tmux 를 **한 번도 부르기 전에** 한다
//  — 그래야 받는 쪽이 «아무것도 안 했다» 를 믿고 제 경로로 다시 할 수 있다.
//
// ⚠ DB 를 import 하지 않는다 — 노드 번들에 실린다(`scripts/node-agent-allowed-modules.json`, 가드 S19b).
// ⚠ 키를 싣는 argv(tmux 키 이름·psmux 코드포인트)와 flush 지연은 `send-keys.ts` 의 계획 함수에서만 온다. 여기서 짓지 않는다.
import { TMUX_BIN } from "./catalog.js";
import { tmux, isSessionGoneError } from "./tmux-exec.js";
import { sendKeysPlan, sendKeyPlan, sendDownPlan, injectFlushMs } from "./send-keys.js";
import { tailOf } from "./session-first-prompt.js";

/** 걸음 이름 — 닫힌 목록이다. 여기 없는 이름은 거절한다(모르는 것을 짐작해 실행하지 않는다). */
const STEPS = ["peek", "keys", "type"] as const;

/** 게이트웨이가 시키는 걸음(검증을 지난 모양). 봉투는 노드 프로토콜의 `ReqMsg.args` 다. */
export type OutboxStepReq =
  | { step: "peek"; id: string }
  | { step: "keys"; id: string; down: number; enter: boolean }
  | { step: "type"; id: string; text: string };

/** 세션에 닿았나 — `gone` 은 tmux 가 **답해서** 없다고 했을 때뿐이고, 무응답·중계 끊김은 `unknown` 이다(#835·#2154). */
export type Reach = "gone" | "unknown";

export type PeekOutcome = { ok: true; pane: string; paneCmd: string } | { ok: false; reach: Reach };
/** 누르기 — `at` 은 멈춘 자리다. 세션 확인(`check`)에서 멈췄으면 아무 키도 안 갔으므로 닿았나(`reach`)를 함께 준다. */
export type KeysOutcome = { ok: true } | { ok: false; at: "check"; reach: Reach } | { ok: false; at: "down" | "enter" };
/** 치기 — `typed` 는 얼마나 쳤나: none(한 글자도 안 갔다) · partial(치다 멈췄다 — 입력칸에 반쪽이 남았을 수 있다) · full. */
export type TypeOutcome =
  | { ok: true; typed: "full" }
  | { ok: false; typed: "none"; reach: Reach }
  | { ok: false; typed: "partial"; at: "text" | "enter" };
/** 거절 — tmux 를 한 번도 부르지 않았다. `reason` 은 사람이 로그에서 읽을 사유다(분기에 쓰지 않는다). */
export type StepRejected = { ok: false; unsupported: true; reason: string };
export type OutboxStepOutcome = PeekOutcome | KeysOutcome | TypeOutcome | StepRejected;

/**
 * 걸음 인자를 읽는다(순수) — 모르면 **거절**한다(`{ unsupported: 사유 }`).
 *
 * ⚠ 받아 주는 쪽이 아니라 거절하는 쪽으로 기운다. 거절은 «아무것도 안 했다» 라 받는 쪽이 제 경로로 다시 할 수 있지만,
 *  잘못 읽고 누른 키는 되돌릴 수 없다(엉뚱한 선택지의 Enter · 반쪽 지시).
 *  · id 는 비지 않은 문자열이어야 한다 — `String(undefined)` 가 `"undefined"` 라는 세션을 찾게 두지 않는다.
 *  · keys 의 `down`·`enter` 는 **없으면** 0·false(누를 것이 없다)이고, 있으면 음이 아닌 정수·불리언이어야 한다 —
 *    `"1"` 을 1 로, `"true"` 를 참으로 읽지 않는다.
 *  · type 의 글이 공백뿐이면 거절한다 — `sendKeysToSession` 이 개행을 편 뒤 비면 «주입할 텍스트가 비어 있습니다» 로 던지는 것과 같은 뜻이다.
 */
export function parseOutboxStep(args: unknown): OutboxStepReq | { unsupported: string } {
  if (!args || typeof args !== "object") return { unsupported: "걸음 인자가 객체가 아니다" };
  const a = args as Record<string, unknown>;
  const step = a.step;
  if (typeof step !== "string" || !(STEPS as readonly string[]).includes(step)) return { unsupported: `모르는 걸음: ${String(step)}` };
  const id = a.id;
  if (typeof id !== "string" || !id.trim()) return { unsupported: "세션 id 가 비었다" };
  if (step === "peek") return { step, id };
  if (step === "keys") {
    const down = a.down === undefined ? 0 : a.down;
    const enter = a.enter === undefined ? false : a.enter;
    if (typeof down !== "number" || !Number.isSafeInteger(down) || down < 0) return { unsupported: "keys 의 down 은 0 이상의 정수여야 한다" };
    if (typeof enter !== "boolean") return { unsupported: "keys 의 enter 는 참·거짓이어야 한다" };
    return { step, id, down, enter };
  }
  const text = a.text;
  if (typeof text !== "string" || !text.trim()) return { unsupported: "칠 글이 비었다" };
  return { step: "type", id, text };
}

/**
 * 치기가 **어느 단계에서** 실패했나 → 얼마나 쳤나(순수).
 *  · check(세션 확인)에서 실패 = 한 글자도 안 갔다 → none. 닿았나는 tmux 오류로 가른다(`gone` — 호스트의 #835 판정).
 *  · 그 뒤(text·enter)의 실패 = 입력칸에 무엇이 남았는지 모른다 → partial. ⚠ 오류가 «세션 없음» 처럼 보여도 none 으로
 *    내리지 않는다 — 확인을 지난 뒤라 글자가 이미 갔을 수 있고, none 은 받는 쪽에게 «다시 쳐도 된다» 는 뜻이다.
 */
export function typedOutcomeOf(stage: "check" | "text" | "enter", err: unknown, gone: (e: unknown) => boolean): TypeOutcome {
  if (stage === "check") return { ok: false, typed: "none", reach: gone(err) ? "gone" : "unknown" };
  return { ok: false, typed: "partial", at: stage };
}

/** 시험 seam — 기본값은 전부 프로덕션 경로다(이 호스트의 tmux · #835 판정 · 실제 대기 · 이 호스트의 mux 바이너리). */
export interface OutboxStepDeps {
  tmux: (argv: string[]) => Promise<string>;
  gone: (err: unknown) => boolean;
  sleep: (ms: number) => Promise<void>;
  bin: string;
}

/** 걸음 하나를 실행한다 — **늘 resolve** 한다(거절·실패도 값이다). reject 는 RPC 전송 층의 몫이다. */
export async function runOutboxStep(args: unknown, deps: Partial<OutboxStepDeps> = {}): Promise<OutboxStepOutcome> {
  const req = parseOutboxStep(args);
  if ("unsupported" in req) return { ok: false, unsupported: true, reason: req.unsupported };
  const d: OutboxStepDeps = {
    tmux: deps.tmux ?? tmux,
    gone: deps.gone ?? ((err) => isSessionGoneError(err)),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    bin: deps.bin ?? TMUX_BIN,
  };
  if (req.step === "peek") return peekPane(req.id, d);
  if (req.step === "keys") return pressKeys(req, d);
  return typeText(req, d);
}

/** 보기 — 화면 꼬리와 포그라운드 명령. 준비 판정의 폴(`session-outbox` 의 waitReady)이 읽는 두 가지와 같다. */
async function peekPane(id: string, d: OutboxStepDeps): Promise<PeekOutcome> {
  try {
    const [pane, paneCmd] = await Promise.all([
      d.tmux(["capture-pane", "-t", id, "-p"]),
      d.tmux(["display-message", "-p", "-t", id, "#{pane_current_command}"]),
    ]);
    //  꼬리만 싣는다 — 판정(firstPromptStep·trustAcceptDowns)이 보는 것이 `tailOf` 이고 `tailOf` 는 두 번 걸어도 같다.
    //   위쪽 전사(과거 대화)는 판정에 안 쓰이니 실어 나를 이유가 없다.
    return { ok: true, pane: tailOf(pane).join("\n"), paneCmd: paneCmd.trim() };
  } catch (err) {
    return { ok: false, reach: d.gone(err) ? "gone" : "unknown" };
  }
}

/**
 * 누르기 — 세션 확인 → 아래로 `down` 칸 → (enter 면) Enter. **첫 실패에서 멈춘다**: 내리다 실패했는데 Enter 를 누르면 커서가
 *  선 엉뚱한 선택지(현행 Claude Code 신뢰 대화상자의 기본은 «No, exit» — `trustAcceptDowns` 머리말)가 눌린다.
 *  누를 것이 없으면(0칸·Enter 없음) 세션도 확인하지 않는다 — tmux 0.
 */
async function pressKeys(r: Extract<OutboxStepReq, { step: "keys" }>, d: OutboxStepDeps): Promise<KeysOutcome> {
  if (r.down === 0 && !r.enter) return { ok: true };
  let at: "check" | "down" | "enter" = "check";
  try {
    await d.tmux(["has-session", "-t", r.id]);
    at = "down";
    for (let i = 0; i < r.down; i++) for (const argv of sendDownPlan(r.id, d.bin)) await d.tmux(argv);
    at = "enter";
    if (r.enter) await d.tmux(sendKeyPlan(r.id, "Enter", d.bin));
    return { ok: true };
  } catch (err) {
    return at === "check" ? { ok: false, at, reach: d.gone(err) ? "gone" : "unknown" } : { ok: false, at };
  }
}

/**
 * 치기 — 세션 확인 → 글자(청크 순서 = 글자 순서) → flush 대기 → Enter. `sendKeysToSession` 과 같은 순서·같은 계획 함수이고,
 *  다른 점은 **어디서 멈췄나를 값으로 남긴다**는 것 하나다(`typedOutcomeOf`).
 */
async function typeText(r: Extract<OutboxStepReq, { step: "type" }>, d: OutboxStepDeps): Promise<TypeOutcome> {
  let stage: "check" | "text" | "enter" = "check";
  try {
    const plan = sendKeysPlan(r.id, r.text, d.bin);
    await d.tmux(["has-session", "-t", r.id]);
    stage = "text";
    for (const argv of plan.keys) await d.tmux(argv);
    await d.sleep(injectFlushMs(plan.oneLine.length));
    stage = "enter";
    await d.tmux(plan.enter);
    return { ok: true, typed: "full" };
  } catch (err) {
    return typedOutcomeOf(stage, err, d.gone);
  }
}

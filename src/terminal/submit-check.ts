// 제출 확인 (#4818) — Enter 를 누른 뒤 **입력칸에 우리 글이 그대로 남아 있나**를 화면으로 보고, 남아 있을 때만 Enter 를 더 누른다.
//
// ── 왜 ──────────────────────────────────────────────────────────────────────────────────────────────
//  아웃박스는 «치기 → 에코 15초 → (미확인이면) Enter 한 번 → 에코 15초» 였다. 화면은 보지 않았다. 실측(2026-10-16, Claude Code 2.1.301):
//   글과 Enter 가 한 덩어리로 읽히면 Enter 가 **글자 CR** 로 박히고, 다음 Enter 는 그 CR 을 «보이지 않는 글자» 로 지우며
//   «Removed 1 invisible character · review and press Enter to send» 만 띄우고 제출하지 않는다 — **세 번째** Enter 에서야 들어간다.
//   사람의 글에 보이지 않는 글자(U+200B 등)가 섞여 있어도 첫 Enter 가 같은 «검토 후 Enter» 로 멈춘다.
//   두 번이면 «입력칸에 글 + 빈 줄, 미제출» 로 멈춘다(상민님 신고 화면 · outbox-enter-became-newline 지식의 실패 화면과 같다).
//  거꾸로, 화면을 안 보고 누르는 Enter 는 **입력칸에 있는 무엇이든** 제출한다 — 사람이 쓰던 글, 위 화살표로 불려 나온 지난 지시.
//   그래서 «몇 번 누르나» 가 아니라 «우리 글이 아직 거기 있나» 로 누른다.
//
// ── 틀리는 방향 ─────────────────────────────────────────────────────────────────────────────────────
//  · 우리 글이 아니면(빈 칸·사람이 고친 글·예시 글) **안 누른다.** 대화상자(승인·질문)가 떠 있어도 안 누른다 — Enter 가 선택지를 고른다.
//  · 입력칸을 **못 알아보면**(화면을 못 읽음·판이 바뀌어 가로줄·«❯» 를 못 찾음) 종전대로 창 끝에 한 번 누른다(#1867 — 빈 폴더 세션의
//    첫 지시가 그 Enter 로 들어갔다). 모르는 화면에서 새로 더 누르지는 않는다.
//  · 한 박자(tick)에 **걸음 하나**(화면 보기 또는 Enter)만 한다 — 원격 호스트면 걸음 하나가 RPC 하나이고, 한 행이 «sending» 에 머무는
//    상한(session-outbox STALE_SENDING · outbox-exec.test E15)이 그 수를 센다.
//
// 순수 판정(inputHolds)은 표로 시험한다(submit-check.test.ts). 판정은 Claude Code 화면 문법만 안다 — 다른 하네스는 부르지 않는다.
import { captureOf, ruledInputText, screenAsks } from "./harness-io/stop-capture.js";

/** 입력칸이 지금 무엇을 들고 있나 — ours(우리 글 그대로) · empty(비었다 — 제출됐다) · other(다른 글) · dialog(대화상자) · unknown(입력칸을 못 찾음). */
export type InputHold = "ours" | "empty" | "other" | "dialog" | "unknown";

//  화면에 안 그려지거나 다르게 그려지는 글자 — 공백(줄 접힘·NBSP 포함)·제어·서식(U+200B·U+FEFF·방향 제어 …)·이체 선택자·한글 채움 문자.
//   Claude Code 가 붙여넣기에서 탭을 공백 넷으로 바꾸는 것도 공백을 다 지우면 같아진다.
const UNSEEN = /[\s\p{Cc}\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u115F\u1160\u3164\uFFA0]/gu;
/** 화면 대조용으로 편다 — 둘 다 같은 함수를 지나야 같다고 말할 수 있다. */
export const unseenStripped = (s: string): string => String(s ?? "").normalize("NFC").replace(UNSEEN, "");

/** 입력칸 위쪽이 잘려 꼬리만 보일 때 «우리 글» 로 쳐 주는 최소 길이 — 짧은 꼬리는 우연히 겹칠 수 있다. */
export const TAIL_MATCH_MIN = 24;

/**
 * 이 화면의 입력칸이 우리 글(`oneLine` — 실제로 친 한 줄)을 들고 있나(순수).
 *  ⚠ 맨글(-e 없는 capture-pane)을 받는다 — 빈 칸의 흐린 예시 글(«Try "…"»)도 글로 읽히지만 우리 글과 다르니 other 다(누르지 않는다).
 */
export function inputHolds(pane: string, oneLine: string): InputHold {
  const cap = captureOf(pane);
  if (screenAsks(cap)) return "dialog";
  const box = ruledInputText(cap);
  if (box === null) return "unknown";
  const seen = unseenStripped(box);
  if (!seen) return "empty";
  const ours = unseenStripped(oneLine);
  if (!ours) return "other";
  if (seen === ours) return "ours";
  if (seen.length >= TAIL_MATCH_MIN && ours.endsWith(seen)) return "ours";
  return "other";
}

/** 화면을 보는 최소 간격 — 한 박자에 걸음 하나. */
export const SUBMIT_POLL_MS = 1_000;
/** Enter 뒤 이만큼 지나도 우리 글이 입력칸에 있으면 제출이 안 된 것이다(바쁘지 않은 Claude Code 는 수십 ms 안에 입력칸을 비운다). */
export const SUBMIT_STUCK_MS = 1_500;
/** 한 행에 **더** 누르는 Enter 상한 — 글자 CR(1) → «검토 후 Enter»(2) → 한 번 더 여유(3). 창 끝 Enter 도 여기서 센다. */
export const SUBMIT_PRESS_MAX = 3;

export interface SubmitGuardIo {
  /** 화면 한 번 — 못 읽으면 ok:false */
  peek: () => Promise<{ ok: true; pane: string } | { ok: false }>;
  /** Enter 하나 — 실패는 삼킨다(다음 박자가 화면으로 다시 본다) */
  enter: () => Promise<void>;
  now: () => number;
}

export interface SubmitGuard {
  /** 한 박자 — 간격이 덜 찼으면 아무것도 안 한다. 누를 차례면 누르고, 아니면 화면을 본다(걸음 하나). */
  tick(): Promise<void>;
  /**
   * 에코 창 끝의 «미제출 방어 Enter» 를 누르나 — 종전엔 화면을 안 보고 눌렀다(needsSubmitRetry).
   *  우리 글이 남았거나(ours) 입력칸을 모르면(unknown·못 읽음 — 종전 그대로) 누른다. 비었거나·다른 글·대화상자면 안 누른다.
   */
  shouldPressAtWindowEnd(): boolean;
  /** Enter 하나(지킴이 몫으로 센다). */
  press(): Promise<void>;
  /** 이 지킴이가 더 누른 Enter 수 */
  presses(): number;
  /** 마지막으로 읽은 입력칸 — 못 읽었거나 누른 뒤 아직 안 봤으면 null */
  last(): InputHold | null;
}

/**
 * 제출 지킴이 — 치기(글 + Enter)가 끝난 **직후** 만든다. 부른 쪽이 박자(`tick`)를 준다(아웃박스는 에코 폴마다, 첫 지시는 제 폴마다).
 */
export function submitGuard(io: SubmitGuardIo, oneLine: string): SubmitGuard {
  let presses = 0;
  let last: InputHold | null = null;
  let lastEnterAt = io.now();   // 치기가 방금 Enter 를 눌렀다
  let lastActAt = io.now();
  let pressOwed = false;
  const press = async (): Promise<void> => {
    presses++;
    last = null;                 // 누른 뒤의 화면은 아직 모른다
    pressOwed = false;
    await io.enter().catch(() => { /* 다음 박자가 화면으로 다시 본다 */ });
    lastEnterAt = io.now();
  };
  return {
    async tick() {
      if (io.now() - lastActAt < SUBMIT_POLL_MS) return;
      lastActAt = io.now();
      if (pressOwed) { await press(); return; }
      const seen = await io.peek().catch(() => ({ ok: false as const }));
      last = seen.ok ? inputHolds(seen.pane, oneLine) : null;
      //  누르는 것은 **다음 박자**다 — 한 박자에 RPC 를 둘 쓰지 않는다(머리말).
      if (last === "ours" && io.now() - lastEnterAt >= SUBMIT_STUCK_MS && presses < SUBMIT_PRESS_MAX) pressOwed = true;
    },
    shouldPressAtWindowEnd() {
      if (presses >= SUBMIT_PRESS_MAX) return false;
      return last === null || last === "ours" || last === "unknown";
    },
    press,
    presses: () => presses,
    last: () => last,
  };
}

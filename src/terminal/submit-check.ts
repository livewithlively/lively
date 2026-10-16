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

//  ── 사람 눈에 안 보이는 것 — 화면 대조(여기 unseenStripped)·기록 대조(outbox-echo-scan echoComparable · web/lib/outbox-echo)가 **같은 집합**을 쓴다 ──
//  Claude Code 2.1.301 은 붙여넣은 글에서 터미널 제어열을 통째로 지우고(Bun.stripANSI) 제출하며 보이지 않는 글자를 지운다(번들의 숨은 글자
//   판정 — «Removed N invisible characters»). 우리 글엔 그대로 있으니 대조할 땐 **양쪽에서** 같은 것을 지운다. 하나라도 빠지면 그 글자가 든
//   지시는 화면이 «다른 글» 이 되고(지킴이가 안 눌러 입력칸에 남는다) 기록이 «미확인» 이 된다(#4852 격리 리뷰 — 한글 채움 문자 U+3164 · CGJ ·
//   ESC ( B · 8비트 CSI 가 빠져 있었고, 화면 대조는 ANSI 색 코드를 몰랐다).
//  ANSI_SEQ — 제어열: CSI(ESC [ · 8비트 9B) · 끈(OSC·DCS·SOS·PM·APC — BEL·ST 로 닫히거나, 안 닫혀 끝까지) · nF(ESC ( B 처럼 ESC + 중간 바이트
//   + 끝) · ESC + 한 글자. Bun.stripANSI 와 같게 지운다(색 코드·제목 바꾸기·문자집합 고르기·8비트 CSI 를 대조함).
//  HIDDEN_CHARS — Claude Code 의 숨은 글자 판정 ∪ 서식 글자(Unicode 17 Cf) ∪ 제어 글자 ∪ 이체 선택자(VS1~256) ∪ 한글 채움 문자. 대조는 양쪽에서
//   지우므로 Claude Code 가 남기는 글자를 더 지워도 맞는다 — 빠뜨리면 안 맞는다. 공백류는 뺀다(접기가 맡는다): 탭은 붙여넣기에서 공백 넷이 되고,
//   VT·FF·CR·NEL·U+2028·U+2029 는 Claude Code 가 **지우지 않고 줄바꿈으로 바꾼다**(그 번들의 숨은 글자 처리 nEe 실측 — 지우면 «세로 탭» 이 «세로탭» 이
//   돼 안 맞는다 · 격리 리뷰). NEL 은 `\s` 에 안 들어 접기 쪽에 따로 적는다. 집합은 모든 코드 포인트로 시험한다(submit-check.test U1~U4).
//  ⚠ u 플래그·`\p{…}` 없이 적는다(아스트랄 글자는 서로게이트 쌍): 브라우저 사본이 같은 글자를 쓰는데, `\p{…}` 는 크롬이 첫 사용에 ICU 자료를
//   불러 대화창이 크게 느려졌다(화면 런타임 시험 12초 → 55초 · 30초 상한에 걸림). 서버·브라우저의 ICU 판 차이로 두 판이 갈리지도 않는다.
// eslint-disable-next-line no-control-regex
export const ANSI_SEQ = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[ -/]+[0-~]|\x1b[0-~]/g;
// eslint-disable-next-line no-control-regex
export const HIDDEN_CHARS = /[\x00-\x08\x0e-\x1f\x7f-\u0084\u0086-\u009f\u00ad\u034f\u0600-\u0605\u061c\u06dd\u070f\u0890-\u0891\u08e2\u115f-\u1160\u17b4-\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb]|\ud804[\udc7f\udcbd\udccd]|\ud80d[\udc30-\udc3f]|\ud81b\udfe4|\ud82f[\udca0-\udca3]|\ud834[\udd73-\udd7a]|[\udb40-\udb43][\udc00-\udfff]/g;
/** (순수) 제어열과 보이지 않는 글자를 지운다 — 공백은 그대로 둔다(접을지 다 지울지는 부르는 쪽이 고른다). */
export const stripUnseen = (s: string): string => String(s ?? "").replace(ANSI_SEQ, "").replace(HIDDEN_CHARS, "");
/** 화면 대조용으로 편다 — 둘 다 같은 함수를 지나야 같다고 말할 수 있다. 공백(줄 접힘·NBSP 포함)도 다 지운다 — Claude Code 가 붙여넣기에서
 *  탭을 공백 넷으로 바꾸는 것도, 입력칸이 긴 글을 줄 끝에서 꺾어 그리는 것도 그러면 같아진다. */
export const unseenStripped = (s: string): string => stripUnseen(String(s ?? "").normalize("NFC")).replace(/[\s\x85]+/g, "");

/** 입력칸 위쪽이 잘려 꼬리만 보일 때 «우리 글» 로 쳐 주는 최소 길이 — 짧은 꼬리는 우연히 겹칠 수 있다. */
export const TAIL_MATCH_MIN = 24;

/**
 * Claude Code 가 입력칸에서 접어 그리는 표시(2.1.301 번들 `zZ`) — 글이 그 자리에 있지만 이 표시로만 보인다.
 *  · `[Pasted text #N]`·`[Pasted text #N +M lines]` — 한 번에 800자 넘게 들어온 글(붙여넣기 하나, 또는 한 번에 읽힌 긴 친 글).
 *    붙여넣기를 모르는 옛 호스트가 8KiB 씩 친 긴 글은 덩어리마다 하나씩 생긴다(`[Pasted text #1][Pasted text #2]` — 실측).
 *  · `[...Truncated text #N +M lines...]` — 입력이 1만 자를 넘으면 가운데를 접는다(앞 약 500자 · 뒤는 남긴다 — 12,000자 실측).
 *  공백을 다 지운 글(unseenStripped)에서 찾는다 — 표시도 글처럼 줄 끝에서 꺾여 그려질 수 있다.
 */
const COLLAPSED = /\[Pastedtext#\d+(?:\+\d+lines)?\]|\[\.\.\.Truncatedtext#\d+\+\d+lines\.\.\.\]/;
/** 그 접힘 문턱(2.1.301 `L3`) — 이보다 긴 우리 글이어야 접힌 표시가 든 입력칸을 우리 글로 친다. */
export const PASTE_COLLAPSE_UNITS = 800;

/** (순수) 접힌 표시가 든 입력칸이 우리 글인가 — 표시를 뺀 글 조각이 우리 글 안에 **차례대로** 있고, 첫 조각은 머리·끝 조각은 꼬리여야 한다
 *  (사람이 앞뒤에 덧붙인 글이면 아니다). 표시가 없으면 거짓 — 그 판정은 위의 그대로-같음이 한다.
 *  · 표시마다 무언가를 감췄어야 한다 — 우리 글 전부가 펼쳐져 있고 그 앞뒤에 표시가 붙었으면 그 표시는 사람이 붙여넣은 다른 글이다(격리 리뷰).
 *  · 보이는 조각은 비었거나 TAIL_MATCH_MIN 자 이상 — «OK[Pasted text #1]» 같은 짧은 조각은 사람 글과 우연히 겹친다. */
function collapsedOurs(seen: string, ours: string): boolean {
  const parts = seen.split(COLLAPSED);
  if (parts.length < 2) return false;
  if (parts.some((p) => p && p.length < TAIL_MATCH_MIN)) return false;
  const head = parts[0], tail = parts[parts.length - 1];
  if (!ours.startsWith(head) || !ours.endsWith(tail)) return false;
  let at = head.length;
  for (const mid of parts.slice(1, -1)) {
    const i = ours.indexOf(mid, at + 1);   // 앞 표시가 적어도 한 글자는 감췄다
    if (i < 0) return false;
    at = i + mid.length;
  }
  return ours.length - tail.length > at;   // 마지막 표시도 무언가를 감췄다 · 꼬리가 앞 조각과 겹치지 않는다
}

/**
 * 이 화면의 입력칸이 우리 글(`oneLine` — 실제로 친 한 줄)을 들고 있나(순수).
 *  ⚠ 맨글(-e 없는 capture-pane)을 받는다 — 빈 칸의 흐린 예시 글(«Try "…"»)도 글로 읽히지만 우리 글과 다르니 other 다(누르지 않는다).
 *  ★ 입력칸을 **먼저** 본다(격리 리뷰): 기본 권한 모드는 입력칸에 글이 있으면 꼬리 안내(«? for shortcuts»)를 감춘다(2.1.301
 *   `showHint = !suppressHint`). 그러면 대화상자 판정(screenAsks)이 «입력칸이 떴다» 는 근거를 못 찾아, «1. …» 로 시작하는 지시나 위에
 *   남은 «❯ 1.» 사람 말만으로 dialog 가 된다. 가로줄 둘 사이 «❯» 줄이 우리 글 그대로면 대화상자일 수 없다(대화상자가 뜨면 입력칸이 감춰지고,
 *   대화상자의 «❯» 줄은 선택지다). 우리 글이 아닐 때만 대화상자를 가린다.
 */
export function inputHolds(pane: string, oneLine: string): InputHold {
  const cap = captureOf(pane);
  const box = ruledInputText(cap);
  const ours = unseenStripped(oneLine);
  if (box !== null && ours) {
    const seen = unseenStripped(box);
    if (seen === ours || (seen.length >= TAIL_MATCH_MIN && ours.endsWith(seen))) return "ours";
    if (oneLine.length > PASTE_COLLAPSE_UNITS && collapsedOurs(seen, ours)) return "ours";
  }
  if (screenAsks(cap)) return "dialog";
  if (box === null) return "unknown";
  return unseenStripped(box) ? "other" : "empty";
}

/** 화면을 보는 최소 간격 — 한 박자에 걸음 하나. */
export const SUBMIT_POLL_MS = 1_000;
/** Enter 뒤 이만큼 지나도 우리 글이 입력칸에 있으면 제출이 안 된 것이다(바쁘지 않은 Claude Code 는 수십 ms 안에 입력칸을 비운다). */
export const SUBMIT_STUCK_MS = 1_500;
/** 한 행에 **더** 누르는 Enter 상한 — 글자 CR(1) → «검토 후 Enter»(2) → 한 번 더 여유(3). 창 끝 Enter 도 여기서 센다. */
export const SUBMIT_PRESS_MAX = 3;
/** 지킴이가 볼 화면 줄 수 — 세션 호스트의 보기는 기본 꼬리 14줄이라 긴 지시(≈10줄 넘게 접힘)면 입력칸 윗줄이 잘려 unknown 이 된다(격리 리뷰). */
export const SUBMIT_PEEK_LINES = 60;

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
   *  우리 글이 남았거나(ours) 입력칸을 모르면(unknown·못 읽음 — 종전 그대로) 누른다. 비었거나·다른 글·대화상자면 안 누른다. 상한을 채웠으면 안 누른다.
   */
  shouldPressAtWindowEnd(): boolean;
  /** 위 판단대로 창 끝 Enter 를 누른다(눌렀으면 참) — 상한·판단을 지킴이가 쥔다(부르는 쪽이 따로 묻지 않아도 된다). */
  pressAtWindowEnd(): Promise<boolean>;
  /** 이 지킴이가 더 누른 Enter 수 */
  presses(): number;
  /** 마지막으로 읽은 입력칸 — 못 읽었거나 누른 뒤 아직 안 봤으면 null */
  last(): InputHold | null;
}

export interface SubmitGuardOpts {
  /** 누를 차례에 **한 번 더 보고** 아직 우리 글일 때만 누른다(#4852) — 본 때와 누를 때 사이(한 박자 ≈ 1초)에 사람이 Enter 를 누르고 제 글을
   *  치기 시작했으면 그 글을 제출하지 않는다. 한 박자에 걸음이 둘이 되므로 RPC 상한을 세는 아웃박스는 쓰지 않는다(뒤에서 지키는 자리만 — watchSubmit). */
  confirmBeforePress?: boolean;
}

/**
 * 제출 지킴이 — 치기(글 + Enter)가 끝난 **직후** 만든다. 부른 쪽이 박자(`tick`)를 준다(아웃박스는 에코 폴마다, 첫 지시는 제 폴마다).
 */
export function submitGuard(io: SubmitGuardIo, oneLine: string, opts: SubmitGuardOpts = {}): SubmitGuard {
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
  const shouldPressAtWindowEnd = (): boolean => presses < SUBMIT_PRESS_MAX && (last === null || last === "ours" || last === "unknown");
  return {
    async tick() {
      if (io.now() - lastActAt < SUBMIT_POLL_MS) return;
      lastActAt = io.now();
      if (pressOwed) {
        if (presses >= SUBMIT_PRESS_MAX) { pressOwed = false; return; }
        if (opts.confirmBeforePress) {
          const again = await io.peek().catch(() => ({ ok: false as const }));
          last = again.ok ? inputHolds(again.pane, oneLine) : null;
          if (last !== "ours") { pressOwed = false; return; }   // 그새 비었거나(제출됐다) 사람이 바꿨다 — 다음 박자가 다시 본다
        }
        await press();
        return;
      }
      const seen = await io.peek().catch(() => ({ ok: false as const }));
      last = seen.ok ? inputHolds(seen.pane, oneLine) : null;
      //  누르는 것은 **다음 박자**다 — 한 박자에 RPC 를 둘 쓰지 않는다(머리말).
      if (last === "ours" && io.now() - lastEnterAt >= SUBMIT_STUCK_MS && presses < SUBMIT_PRESS_MAX) pressOwed = true;
    },
    shouldPressAtWindowEnd,
    async pressAtWindowEnd() {
      if (!shouldPressAtWindowEnd()) return false;
      await press();
      return true;
    },
    presses: () => presses,
    last: () => last,
  };
}

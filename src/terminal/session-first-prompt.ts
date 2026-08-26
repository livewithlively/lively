// 세션의 **첫 지시**를 하네스 입력창이 뜬 뒤에 넣는다 (#1719 홈 입력창).
//
//  왜 따로 있나: 홈에서 프롬프트를 치고 Enter 를 누르면 세션이 **막 뜨는 중**이다. 하네스(Claude Code)는 부팅에 수 초가
//  걸리고, 새 폴더면 그 앞에 **신뢰 대화상자**("Do you trust the files in this folder?")까지 뜬다. 그 사이에 send-keys 로
//  글자를 밀어 넣으면 ⓐ TUI 가 raw 모드로 바뀌기 전 tty 라인버퍼에 남거나 ⓑ 대화상자의 선택지로 흡수돼 **조용히 사라진다**.
//  그래서 '보이는 것'을 보고 넣는다 — 입력창이 화면에 그려진 뒤에만 텍스트를 넣고 제출한다.
//
//  판정은 순수 함수(firstPromptStep)로 떼어 표로 못박고, 실행부(injectFirstPrompt)는 그 판정을 폴링할 뿐이다.
//  실행부는 응답을 막지 않는다(createSession 이 `void` 로 띄운다) — 화면은 세션 대화창으로 먼저 가고,
//  거기서 대화 파일에 내 말이 나타나는 걸 따라간다(session-chat.ts). 못 넣으면 warn 로그만 남긴다 — 세션은 살아 있고,
//  사람이 대화창·터미널에서 다시 치면 된다(조용한 실패가 아니라 화면이 '아직 기록에 안 나타났다'고 말한다).
//
//  ⚠ 신뢰 대화상자 자동 수락은 **세션 전용 폴더일 때만**(라이블리가 방금 만든 빈 폴더 — 신뢰할 파일 자체가 없다).
//   사람이 고른 폴더는 그 사람의 판단이라 대신 누르지 않는다(대화창의 '확인 대기' 배너가 Enter 를 대신 눌러 준다).
import { SHELL_CMDS } from "./phase.js";
import { harnessIo } from "./harness-io/adapter.js";
import { tmux } from "./tmux-exec.js";
import { sendKeysToSession, sendKeyToSession } from "./send-keys.js";

export type FirstPromptStep = "wait" | "accept-trust" | "send" | "give-up";

// 하단 라이브 UI 영역만 본다(phase.ts detectAwaiting 과 같은 이유 — 전사(과거 대화)가 위에 남아 있다).
const TAIL_LINES = 14;
// Claude Code 입력창이 떠 있다는 표식(phase.ts INPUT_BOX 와 같은 문구 — 두 군데가 같은 화면을 본다).
const INPUT_BOX = /\b(auto|manual|plan|accept edits|bypass permissions) mode on\b|\? for shortcuts|shift\+tab to cycle/i;
// 새 폴더 신뢰 대화상자 — 하네스마다, 그리고 **버전마다** 문구가 다르다(기본 선택은 전부 'Yes'):
//  · Claude Code(구): "Do you trust the files in this folder?"
//  · Claude Code 2.1.245(현행, 실측 2026-08-25): "Quick safety check: Is this a project you created or one you trust?"
//    + 선택지 "❯ 1. Yes, I trust this folder"
//  · Antigravity: "Do you trust the contents of this project?" (실측 2026-08-18 — 종전 정규식이 못 잡아
//    ⓐ 세션 전용 폴더인데 자동 수락이 안 됐고 ⓑ 6초 뒤 '하네스가 떴다'로 오판해 첫 지시를 대화상자에 밀어 넣었다).
//  ⚠ 문구 하나만 알면 하네스가 문안을 바꾸는 순간 **첫 지시가 조용히 유실된다**(90초 give-up) — 실제로 그렇게 됐다
//   (2026-08-25 dev 노드 프로젝트 세션: 대화상자에서 멈춘 채 첫 지시가 통째로 사라졌다). 그래서 세 축으로 잡는다:
//   ①구 claude 문안 ②"is this a project you created/trust" ③**선택지 줄** `[❯>] N. Yes, … trust …`(문안이 바뀌어도
//   '기본 선택 Yes' 는 남는다). ③은 줄머리에 앵커돼 있어 본문이 trust 를 언급하는 것만으로는 안 걸린다(오탐 방지).
const TRUST_DIALOG = /trust the (files|contents) (in|of) this (folder|directory|project)|is this a project you (created|trust)|(^|\n)[ \t]*[❯>]?[ \t]*\d*\.?[ \t]*Yes,[^\n]*\btrust\b/i;
// 하네스가 아직 뜨는 중인데 화면에 아무 표식이 없을 때, 비-Claude 하네스에 쓰는 보수적 대기(입력창 문구를 모르는 하네스).
const OTHER_HARNESS_SETTLE_MS = 6000;

export function tailOf(pane: string, n = TAIL_LINES): string[] {
  return pane.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "").slice(-n);
}

/**
 * 지금 화면으로 무엇을 할지(순수).
 *  - give-up: 시간 초과(하네스가 로그인 화면 등에 멈춰 입력창이 영영 안 뜬다).
 *  - accept-trust: 신뢰 대화상자가 떠 있고 자동 수락이 허용된 자리(세션 전용 폴더) — Enter 로 기본 선택(Yes)을 고른다.
 *  - send: 입력창이 보인다(Claude) / 하네스가 포그라운드로 자리 잡고 충분히 지났다(그 밖의 하네스).
 *  - wait: 아직.
 */
export function firstPromptStep(i: { pane: string; harness: string; paneCmd: string; elapsedMs: number; maxMs: number; trustOk: boolean }): FirstPromptStep {
  if (i.elapsedMs > i.maxMs) return "give-up";
  const tail = tailOf(i.pane);
  const tailText = tail.join("\n");
  if (TRUST_DIALOG.test(tailText)) return i.trustOk ? "accept-trust" : "wait";
  // 하네스가 화면 판정을 선언했으면(#1719 계약 축 screen) 그것이 정본이다 — 휴리스틱보다 먼저.
  //  auth(로그인·인증 검증)에 넣으면 거부돼 사라지고(antigravity 실측 — "아직 인증 확인중" 거부), dialog 에 넣으면
  //  대화상자가 삼킨다. busy 는 큐잉 보장이 없으면 기다렸다 넣는다. 판정 불가(null)면 아래 폴백으로.
  const scr = harnessIo(i.harness)?.screen?.(tail) ?? null;
  if (scr === "ready") return "send";
  if (scr === "auth" || scr === "busy") return "wait";
  if (scr === "dialog") return "wait";                        // 신뢰 대화상자는 위에서 이미 갈랐다 — 그 밖의 대화상자는 대신 안 누른다
  if (i.harness === "claude") return tail.some((l) => INPUT_BOX.test(l)) ? "send" : "wait";
  // 그 밖의 하네스 — 입력창 문구를 모른다. 포그라운드가 셸이 아니게 된 뒤(하네스가 떴다) 조금 기다렸다 넣는다.
  const fg = (i.paneCmd || "").trim();
  if (!fg || SHELL_CMDS.has(fg)) return "wait";
  return i.elapsedMs >= OTHER_HARNESS_SETTLE_MS ? "send" : "wait";
}

/** pane 화면·포그라운드 명령을 한 번 읽는다(세션이 사라졌으면 throw). */
async function peek(id: string): Promise<{ pane: string; paneCmd: string }> {
  const [pane, paneCmd] = await Promise.all([
    tmux(["capture-pane", "-t", id, "-p"]),
    tmux(["display-message", "-p", "-t", id, "#{pane_current_command}"]),
  ]);
  return { pane, paneCmd: paneCmd.trim() };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 첫 지시를 넣는다 — 입력창이 뜰 때까지 폴링(0.4s)하고, 신뢰 대화상자면 수락하고, 뜨면 넣는다.
 *  maxMs 를 넘기면 포기한다(warn). 세션이 그새 사라져도(사용자가 닫음) 조용히 끝난다.
 *  ⚠ 자동 수락(trustOk)은 세션 전용 폴더에서만 참으로 넘긴다(파일 머리말).
 */
export async function injectFirstPrompt(id: string, harness: string, text: string, opts?: { maxMs?: number; pollMs?: number; trustOk?: boolean }): Promise<boolean> {
  const maxMs = opts?.maxMs ?? 90_000;
  const pollMs = opts?.pollMs ?? 400;
  const trustOk = opts?.trustOk ?? false;
  const t0 = Date.now();
  let acceptedTrust = false;
  for (;;) {
    let seen: { pane: string; paneCmd: string };
    try { seen = await peek(id); }
    catch { return false; }                                  // 세션이 사라졌다(닫힘·죽음) — 넣을 곳이 없다
    const step = firstPromptStep({ ...seen, harness, elapsedMs: Date.now() - t0, maxMs, trustOk });
    if (step === "give-up") { console.warn(`[terminal] 첫 지시를 넣지 못했다(${id}) — ${Math.round(maxMs / 1000)}초 안에 입력창이 안 떴다(로그인·오류 화면일 수 있다).`); return false; }
    if (step === "accept-trust" && !acceptedTrust) {
      // 기본 선택(Yes, proceed)을 Enter 로. 한 번만 — 같은 대화상자가 계속 보이면(안 닫힘) 텍스트를 넣지 않고 기다린다.
      await sendKeyToSession(id, "Enter").catch(() => { /* 다음 폴에서 다시 본다 */ });
      acceptedTrust = true;
      await sleep(pollMs);
      continue;
    }
    if (step === "send") {
      await sendKeysToSession(id, text);
      return true;
    }
    await sleep(pollMs);
  }
}

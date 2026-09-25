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
import { sendKeysToSession, sendKeyToSession, sendDownToSession } from "./send-keys.js";

export type FirstPromptStep = "wait" | "accept-trust" | "send" | "give-up";

// 하단 라이브 UI 영역만 본다(phase.ts detectAwaiting 과 같은 이유 — 전사(과거 대화)가 위에 남아 있다).
const TAIL_LINES = 14;
// Claude Code 입력창이 떠 있다는 표식(phase.ts INPUT_BOX 와 같은 문구 — 두 군데가 같은 화면을 본다).
const INPUT_BOX = /\b(auto|manual|plan|accept edits|bypass permissions) mode on\b|\? for shortcuts|shift\+tab to cycle/i;
// 새 폴더 신뢰 대화상자 — 하네스마다, 그리고 **버전마다** 문구가 다르다.
//  ⚠ 기본 선택도 버전마다 다르다 — 2.1.263 은 **«No, exit» 이 기본**이다(#3626 실측). 그래서 '기본을 Enter 로'
//   가 아니라 **화면에서 Yes 를 찾아 그리로 옮긴 뒤** 누른다(trustAcceptDowns).
//  · Claude Code(구): "Do you trust the files in this folder?"
//  · Claude Code 2.1.245(현행, 실측 2026-08-25): "Quick safety check: Is this a project you created or one you trust?"
//    + 선택지 "❯ 1. Yes, I trust this folder"
//  · Codex 0.153.4(실측 2026-09-24): "Do you trust the contents of this directory?" + "› 1. Yes, continue / 2. No, quit"
//    — 문안은 위 ①에 걸리지만 **커서 글자가 `›`** 라 선택지 판정(TRUST_OPTION)에 그 글자를 넣어야 눌러진다.
//  · Codex 0.157.0(실측 2026-09-25 — 하루 만에 판이 바뀌었다): "Folder access … **Trust this folder?**" +
//    "› 1. Trust and continue / 2. Back to Agent Command Center" + "enter continue · esc back".
//    문구도 선택지 낱말도 통째로 바뀐다 — 그래서 **낱말 두 벌(Yes·Trust / No·Back)** 을 다 받는다. 판이 또 바뀌면
//    선택지를 못 읽어 null 이 되고(아무것도 안 누름), 화면 판정(codex.screen)이 번호 메뉴 모양으로 대화상자를 잡는다.
//  · Antigravity: "Do you trust the contents of this project?" (실측 2026-08-18 — 종전 정규식이 못 잡아
//    ⓐ 세션 전용 폴더인데 자동 수락이 안 됐고 ⓑ 6초 뒤 '하네스가 떴다'로 오판해 첫 지시를 대화상자에 밀어 넣었다).
//  ⚠ 문구 하나만 알면 하네스가 문안을 바꾸는 순간 **첫 지시가 조용히 유실된다**(90초 give-up) — 실제로 그렇게 됐다
//   (2026-08-25 dev 노드 프로젝트 세션: 대화상자에서 멈춘 채 첫 지시가 통째로 사라졌다). 그래서 세 축으로 잡는다:
//   ①구 claude 문안 ②"is this a project you created/trust" ③**선택지 줄** `[❯>] N. Yes, … trust …`(문안이 바뀌어도
//   '기본 선택 Yes' 는 남는다). ③은 줄머리에 앵커돼 있어 본문이 trust 를 언급하는 것만으로는 안 걸린다(오탐 방지).
const TRUST_DIALOG = /trust the (files|contents) (in|of) this (folder|directory|project)|is this a project you (created|trust)|\bTrust this folder\b|(^|\n)[ \t]*[❯›>]?[ \t]*\d*[.)]?[ \t]*(Yes,[^\n]*\btrust\b|Trust and continue)/i;
// 하네스가 아직 뜨는 중인데 화면에 아무 표식이 없을 때, 비-Claude 하네스에 쓰는 보수적 대기(입력창 문구를 모르는 하네스).
const OTHER_HARNESS_SETTLE_MS = 6000;

// ── 얼마나 기다리나(injectFirstPrompt) ─────────────────────────────────────────────────────────────
//  부팅 창 — 이 안에서는 촘촘히(0.4s) 보고, 입력창을 **못 알아보는** 하네스의 추정 전송(아래 폴백)도 이 안에서만 한다.
export const FIRST_PROMPT_BOOT_MS = 90_000;
//  사람을 기다리는 창 — 입력창을 알아볼 수 있는 하네스는 이만큼 들고 있다가 뜨는 순간 넣는다.
//  🔴 왜 90초가 아닌가(실측 2026-09-22, 원준님 맥미니 노드 box-wonjoon-jang-676fd1b9): 새로 생긴 멤버 프로필
//   (CLAUDE_CONFIG_DIR 빈 폴더)에서 Claude Code 는 **첫 실행 안내**(글자 스타일 → 로그인 방법 → 로그인 → 보안 안내 →
//   bypass 경고)를 차례로 띄우고 전부 사람 입력을 기다린다. 사람이 그걸 넘기는 데 90초가 넘게 걸렸고, 그 사이 이 함수가
//   포기해 홈에서 [시키기]로 보낸 지시가 **통째로 사라졌다** — 사람에겐 «시켰는데 세션이 아무것도 안 한다» 로 보였다.
//   게이트웨이 경로(아웃박스)는 같은 이유로 이미 2시간을 든다(session-outbox NOT_READY_TTL_MS, #2154) — 노드 경로만
//   90초였다. 같은 교리를 쓴다: 지시를 들고 있는 목적이 바로 **사람이 화면을 넘기고 돌아올 때까지**다.
//  ⚠ 이 창이 길어도 **입력창이 보이기 전에는 절대 안 넣는다**(firstPromptStep 이 그대로 지킨다) — 기다림만 길어진다.
export const FIRST_PROMPT_HOLD_MS = 2 * 60 * 60_000;
//  부팅 창을 넘긴 뒤의 폴 간격 — 사람이 화면을 넘기면 2초 안에 들어간다. 2시간 × 0.4s 폴은 tmux 를 괜히 두드린다.
const HOLD_POLL_MS = 2_000;

// 신뢰 대화상자의 **선택지 줄** — `❯ No, exit` · `  Yes, I trust this folder` · 구판 `❯ 1. Yes, …` 를 함께 잡는다.
//  줄머리 앵커 + Yes/No 로 시작하는 것만 = 본문이 trust 를 언급하는 것만으로는 안 걸린다(TRUST_DIALOG 와 같은 교리).
//  ⚠ 커서 글자는 하네스마다 다르다 — claude `❯` · codex `›`(U+203A, 실측 2026-09-24) · 일부 판은 `>`.
//   codex 를 안 넣었더니 선택지 두 줄을 읽고도 «커서를 못 찾았다»(null)로 떨어져, 신뢰 대화상자에서 아무것도 안 눌렀다.
const TRUST_OPTION = /^[ \t]*([❯›>])?[ \t]*(\d+[.)])?[ \t]*(Yes|No|Trust|Back)\b(.*)$/i;

/**
 * 신뢰 대화상자에서 **«Yes» 까지 몇 칸 내려가야 하나** (순수) — 못 읽으면 `null`.
 *
 * 🔴 왜 세느냐 (#3626, 2026-09-07 실측): 종전엔 그냥 **Enter 한 방**이었고, 그 근거는 이 파일에 적혀 있던
 *  «기본 선택은 전부 Yes» 였다. 그 전제가 **현행 Claude Code 에서 뒤집혔다** — 2.1.263 의 화면은
 *
 *      ❯ No, exit
 *        Yes, I trust this folder
 *
 *  라 기본 선택이 **«No, exit»** 다(hammurabi 실측 캡처). 그래서 그 Enter 가 하네스를 **종료**시켰다.
 *  윈도우 노드엔 하네스 런처 폴백이 없어(catalog.harnessLaunchArgv) pane 이 통째로 사라지고, 화면의 부팅
 *  게이트가 그 죽음을 보고 복원으로 가 **인자 없는 `claude --resume`(후보 0건 피커)** 가 떴다
 *  (상민님 신고: 홈에서 [시키기] → «멈춰 있는 세션이에요» → «이어받기 세션을 열었어요» → 빈 피커).
 *
 * ⚠ **못 읽으면 아무것도 누르지 않는다**(null). 맹목적 Enter 는 이 사고의 원인이고, 잘못 누르는 것은
 *  안 누르는 것보다 나쁘다 — 안 누르면 대화상자가 남아 사람이 답할 수 있지만(대화창의 '확인 대기' 배너),
 *  잘못 누르면 세션이 죽는다. 문안·순서가 또 바뀌어도 이 함수는 **조용히 위험해지지 않는다**.
 * ⚠ 위로는 안 간다 — 랩어라운드를 보장하는 TUI 규약이 없다. 커서가 Yes 보다 아래면 null 이다.
 */
export function trustAcceptDowns(tail: string[]): number | null {
  const opts: Array<{ cursor: boolean; yes: boolean; text: string }> = [];
  for (const line of tail) {
    const m = TRUST_OPTION.exec(line);
    if (!m) continue;
    //  #4135 — 판마다 선택지 낱말이 다르다: claude·codex 0.153.4 는 «Yes/No», codex 0.157.0 은 «Trust and continue /
    //   Back to …». 수락은 Yes·Trust, 거절은 No·Back 이다(실측 2026-09-24·25).
    //  ⚠ 다만 Trust·Back 은 **본문에도 흔한 낱말**이다 — 0.157.0 의 설명문이 "Trust this folder? Codex can read…"
    //   로 시작한다. 그 줄을 선택지로 세면 커서보다 위에 «수락» 이 하나 생겨 판정이 null 이 되고(실측: 이 시험이
    //   빨간불이었다) 아무것도 못 누른다. 그래서 그 두 낱말은 **커서나 번호가 앞에 붙은 줄**에서만 선택지로 본다.
    //   Yes·No 는 종전 그대로 둔다(본문이 그 낱말로 시작하는 일은 드물고, 번호 없는 실측 화면이 있다 — V263).
    const marked = !!m[1] || !!m[2];
    const word = m[3];
    if (/^(trust|back)$/i.test(word) && !marked) continue;
    opts.push({ cursor: !!m[1], yes: /^(yes|trust)$/i.test(word), text: line.trim() });
  }
  if (opts.length < 2) return null;                       // 선택지를 못 읽었다
  const cursor = opts.findIndex((o) => o.cursor);
  const yes = opts.findIndex((o) => o.yes);
  if (cursor < 0 || yes < 0) return null;                 // 커서·Yes 중 하나를 못 찾았다
  return yes >= cursor ? yes - cursor : null;             // 위로 올라가야 하면 모른다고 답한다
}

export function tailOf(pane: string, n = TAIL_LINES): string[] {
  return pane.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "").slice(-n);
}

/**
 * 지금 화면으로 무엇을 할지(순수).
 *  - give-up: 시간 초과(하네스가 로그인 화면 등에 멈춰 입력창이 영영 안 뜬다).
 *  - accept-trust: 신뢰 대화상자가 떠 있고 자동 수락이 허용된 자리(세션 전용 폴더) — Enter 로 기본 선택(Yes)을 고른다.
 *  - send: 입력창이 보인다(Claude) / 하네스가 포그라운드로 자리 잡고 충분히 지났다(그 밖의 하네스).
 *  - wait: 아직.
 *
 *  `blindMaxMs` — 입력창을 **못 알아보는** 하네스(맨 아래 폴백: 포그라운드·경과 시간으로 추정)에 넣어도 되는 상한.
 *   이걸 넘기면 그 추정은 포기한다: 오래 지나서 포그라운드가 셸이 아닌 것은 «하네스가 떴다» 가 아니라 사람이 셸에서 딴
 *   프로그램을 켠 것일 수 있다. 입력창을 **알아보는** 하네스(claude · screen 판정)는 maxMs 까지 기다린다. 생략하면 제한 없음
 *   (아웃박스처럼 maxMs 가 원래 짧은 호출자).
 */
export function firstPromptStep(i: { pane: string; harness: string; paneCmd: string; elapsedMs: number; maxMs: number; trustOk: boolean; blindMaxMs?: number }): FirstPromptStep {
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
  if (i.blindMaxMs !== undefined && i.elapsedMs > i.blindMaxMs) return "give-up";
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

/** 신뢰 대화상자에 보낼 키 — 시험은 tmux 없이 이걸 바꿔 끼운다. */
export interface TrustKeys { down: (id: string, times: number) => Promise<void>; enter: (id: string) => Promise<void> }
/** 이 호스트의 tmux 로 누르는 키 — 아웃박스 실행 자리의 게이트웨이 칸도 같은 키를 쓴다(`sessions/outbox-exec`, #3773). */
export const TMUX_TRUST_KEYS: TrustKeys = { down: sendDownToSession, enter: (id) => sendKeyToSession(id, "Enter") };

/**
 * 신뢰 대화상자를 **화면을 읽고** 수락한다 — «Yes» 까지 내린 뒤 Enter (#3626 · #3949).
 *  첫 지시(`injectFirstPrompt`)와 아웃박스(`session-outbox` 의 준비 판정)가 **둘 다 이 함수**를 부른다.
 *  #3626 은 첫 지시 쪽만 고쳤는데, 게이트웨이에서 만든 세션의 첫 지시가 실제로 들어가는 곳은 아웃박스였고
 *  거기는 계속 맹목 Enter 를 눌렀다(#3949) — 같은 판단이 두 자리에 있으면 한쪽만 고쳐진다.
 *
 * @returns `accepted` — 키를 보냈다. 결과는 다음 폴에서 화면으로 본다(키 실패도 삼킨다 — 다음 폴이 다시 판단한다).
 *          `unreadable` — 선택지를 못 읽어 **아무것도 안 눌렀다**. 잘못 누르면 하네스가 꺼진다(trustAcceptDowns 머리말).
 */
export async function acceptTrustDialog(id: string, pane: string, keys: TrustKeys = TMUX_TRUST_KEYS): Promise<"accepted" | "unreadable"> {
  const downs = trustAcceptDowns(tailOf(pane));
  if (downs === null) return "unreadable";
  if (downs > 0) await keys.down(id, downs).catch(() => { /* 다음 폴에서 다시 본다 */ });
  await keys.enter(id).catch(() => { /* 다음 폴에서 다시 본다 */ });
  return "accepted";
}

/**
 * 첫 지시를 넣는다 — 입력창이 뜰 때까지 폴링하고, 신뢰 대화상자면 수락하고, 뜨면 넣는다.
 *  부팅 창(FIRST_PROMPT_BOOT_MS) 안에서는 0.4s, 그 뒤로는 사람이 첫 실행 안내·로그인을 넘기길 기다리며 2s 로 본다.
 *  maxMs(기본 FIRST_PROMPT_HOLD_MS)를 넘기면 포기한다(warn). 세션이 그새 사라져도(사용자가 닫음) 조용히 끝난다.
 *  ⚠ 자동 수락(trustOk)은 세션 전용 폴더에서만 참으로 넘긴다(파일 머리말).
 */
export async function injectFirstPrompt(id: string, harness: string, text: string, opts?: { maxMs?: number; pollMs?: number; trustOk?: boolean }): Promise<boolean> {
  const maxMs = opts?.maxMs ?? FIRST_PROMPT_HOLD_MS;
  const pollMs = opts?.pollMs ?? 400;
  const trustOk = opts?.trustOk ?? false;
  const t0 = Date.now();
  let acceptedTrust = false;
  let saidHolding = false;
  let saidUnreadable = false;
  for (;;) {
    let seen: { pane: string; paneCmd: string };
    try { seen = await peek(id); }
    catch { return false; }                                  // 세션이 사라졌다(닫힘·죽음) — 넣을 곳이 없다
    const elapsedMs = Date.now() - t0;
    const step = firstPromptStep({ ...seen, harness, elapsedMs, maxMs, trustOk, blindMaxMs: FIRST_PROMPT_BOOT_MS });
    if (step === "give-up") { console.warn(`[terminal] 첫 지시를 넣지 못했다(${id}) — ${Math.round(elapsedMs / 1000)}초 동안 입력창이 안 떴다(로그인·오류 화면일 수 있다).`); return false; }
    const booting = elapsedMs < FIRST_PROMPT_BOOT_MS;
    if (!booting && !saidHolding) {
      saidHolding = true;
      console.warn(`[terminal] 첫 지시 대기 중(${id}) — ${Math.round(FIRST_PROMPT_BOOT_MS / 1000)}초 안에 입력창이 안 떴다. 첫 실행 안내·로그인이 끝나 입력창이 뜨면 넣는다(최대 ${Math.round(maxMs / 60_000)}분).`);
    }
    if (step === "accept-trust" && !acceptedTrust) {
      //  ★ #3626 — **화면을 읽고** «Yes» 로 옮긴 뒤 Enter(acceptTrustDialog — 아웃박스와 같은 함수, #3949).
      //   기본 선택이 Yes 라는 전제는 틀렸다. 못 읽으면 **아무것도 안 누르고** 기다린다 — 잘못 누르면 하네스가 종료되고
      //   그 세션이 통째로 사라진다.
      if ((await acceptTrustDialog(id, seen.pane)) === "unreadable") {
        //  한 번만 말한다 — 이제 2시간을 기다리므로 폴마다 남기면 로그가 그 줄로 덮인다.
        if (!saidUnreadable) console.warn(`[terminal] 신뢰 대화상자의 선택지를 못 읽었다(${id}) — 대신 누르지 않는다(사람이 답할 수 있게 남긴다).`);
        saidUnreadable = true;
        await sleep(booting ? pollMs : HOLD_POLL_MS);
        continue;
      }
      acceptedTrust = true;
      await sleep(pollMs);
      continue;
    }
    if (step === "send") {
      await sendKeysToSession(id, text);
      return true;
    }
    await sleep(booting ? pollMs : HOLD_POLL_MS);
  }
}

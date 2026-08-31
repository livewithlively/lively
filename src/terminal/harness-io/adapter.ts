// 하네스 세션 I/O 어댑터 — 세션 대화창이 하네스와 말을 섞는 **모든 자리**를 한 인터페이스 뒤로 (#1719 #1746).
//
//  ── 왜 ──
//  세션 실행·복원·안내는 이미 표(catalog.ts HARNESSES)로 추상화돼 있고, 훅·자산 배선도 표(kit/hooks/harness-registry.mjs)다.
//  그런데 **대화창이 하네스와 닿는 축**(대화 파일이 어디 있나 · 그 파일을 어떻게 읽나 · 승인은 어떤 키냐)은 Claude 하드코딩 3곳
//  (terminal-transcript.ts 의 ~/.claude/projects 규약 · renderTranscript+session-chat.ts 의 claude jsonl 파서 · send-keys 의 Enter/Esc
//  의미)에 흩어져 있었다 — 그래서 비-Claude 세션은 새 화면에서 404→빈 화면이었다([[session-chat-harness-parity-gap-1719]]).
//  이 파일이 그 세 축을 하네스마다 **한 객체**로 답하게 한다. 새 하네스는 여기 한 항목 + 파서 한 파일이면 화면 코드 변경 0.
//
//  ── 축 ──
//   roots(homes, owner)          대화 파일이 사는 뿌리들 — 훅이 보고한 경로는 이 안에 있을 때만 믿는다(권한 상승 방지: 소유자가
//                                아무 경로나 보고해 게이트웨이 권한으로 읽히는 통로를 막는다). 규약 폴백의 탐색 뿌리이기도 하다.
//   filePattern                  대화 파일 이름 규약(보고 경로 검증).
//   pathFor(root, {cwd, convId}) 규약으로 경로를 만들 수 있으면(폴백) — 보고가 없을 때만. null 이면 규약 없음(보고 경로만).
//   parse(text, state)           원문(줄 경계 정렬된 ndjson 창) → 공통 ChatLine. **null = 이 하네스는 아직 화면으로 못 읽는다**(터미널만).
//   answer(action)               approve|deny|interrupt → 키. **null = 화면에서 대신 눌러줄 수 없다**(승인 UI 미실측). 있는 척하지 않는다.
//  ⚠ 축을 하나 늘리면 **모든 하네스가 그 축을 답해야 한다**(null 도 답이다) — 그게 '빠진 자리'를 없애는 방법이다(harness-registry 원칙).
//     계약 테스트(adapter.test.ts)가 catalog.ts HARNESSES 의 모든 key 가 여기 있는지 강제한다.
import type { ChatKey } from "../send-keys.js";
import type { ParseResult, ParseState } from "./chat-line.js";
import { claudeIo } from "./claude.js";
import { codexIo } from "./codex.js";
import { grokIo } from "./grok.js";
import { antigravityIo } from "./antigravity.js";

export type ChatAction = "approve" | "deny" | "interrupt";
export const CHAT_ACTIONS: readonly ChatAction[] = ["approve", "deny", "interrupt"];
export const isChatAction = (v: unknown): v is ChatAction => (CHAT_ACTIONS as readonly string[]).includes(String(v));

/**
 * 화면 판정(#1719 계약 축) — pane 하단(라이브 UI)이 지금 어떤 상태인가.
 *  · ready  = 입력창이 떠 있어 **텍스트를 넣어도 되는** 상태(하네스가 도는 중이어도 큐잉을 보장하면 ready)
 *  · busy   = 돌고 있고 **큐잉 보장이 없어** 기다렸다 넣어야 하는 상태
 *  · dialog = 사람의 선택을 기다리는 대화상자(신뢰·승인·질문) — 절대 텍스트를 넣지 않는다
 *  · auth   = 로그인·인증 검증 중 — 넣으면 거부되거나 사라진다(antigravity 실측 2026-08-18)
 *  · null   = 이 화면으로는 판정 불가(부팅·미지의 화면) — 호출자가 보수적으로 기다린다
 *  screen: null = **이 하네스는 화면 판정이 미실측**이라는 명시적 선언(있는 척 금지). 그 하네스는 폴백
 *  휴리스틱(포그라운드 관찰 + 정착 대기)을 타며, 실측이 생기면 여기에 채우고 계약 테스트에 표를 더한다.
 */
export type ScreenState = "ready" | "busy" | "dialog" | "auth";

export interface HarnessSessionAdapter {
  key: string;
  label: string;
  roots(homes: string[], owner: string): string[];
  filePattern: RegExp;
  pathFor: ((root: string, ctx: { cwd: string; convId: string }) => string | null) | null;
  /** 이 문자열이 **이 하네스의 대화 id 로 그럴듯한가**(#1719 후속). 훅 보고를 받는 쪽이 쓴다 — 세션 안에서 도는
   *  무엇이든 그 경로를 칠 수 있고 저장이 last-write-wins 라, 규약에 안 맞는 값 하나가 정본을 지운다(실측: 테스트가
   *  넣은 "s7" 이 살아 있는 세션 3개의 매핑을 덮었다). null = 규약을 모른다(판단 보류 — 종전대로 통과).
   *  ⚠ 읽기(pathFor·filePattern)는 느슨한 채로 둔다. 여기서 좁히는 건 **쓰기(보고)** 뿐이다. */
  convIdOk: ((id: string) => boolean) | null;
  parse: ((text: string, state: ParseState) => ParseResult) | null;
  answer: ((action: ChatAction) => ChatKey) | null;
  screen: ((tail: string[]) => ScreenState | null) | null;
}

// opencode: 단일 파일 계약 미확인(플러그인 event 스트림 → 파일로 떨구는 작업 선행, [[opencode-harness-spec-1519]] ⑤축) —
//  parse·pathFor 는 명시적 null(있는 척 금지). codex 는 codex.ts(rollout 파서 실측, #1759).
const opencodeIo: HarnessSessionAdapter = {
  key: "opencode", label: "OpenCode",
  roots: () => [],
  filePattern: /\.jsonl$/,
  pathFor: null, convIdOk: null, parse: null, answer: null,
  // 실측 2026-08-18(box-yoon-3e231912): 작업 중엔 상태바에 "esc interrupt"(1차 Esc 후엔 "esc again to interrupt"),
  // 준비되면 그 자리가 cwd 로 바뀌고 "ctrl+p commands" 는 늘 있다 — 그래서 busy 를 먼저 보고 ready 를 본다.
  screen: (tail) => {
    const s = tail.join("\n");
    if (/esc (again to )?interrupt/i.test(s)) return "busy";
    if (/ctrl\+p commands/i.test(s)) return "ready";
    return null;
  },
};
// 셸 세션 — AI 없음. 대화 파일도 승인도 없다.
const shellIo: HarnessSessionAdapter = {
  key: "shell", label: "셸", roots: () => [], filePattern: /$^/, pathFor: null, convIdOk: null, parse: null, answer: null, screen: null,
};

export const HARNESS_IO: readonly HarnessSessionAdapter[] = [claudeIo, codexIo, opencodeIo, antigravityIo, grokIo, shellIo];

/** 하네스 key → 어댑터. 모르는 key 는 null(호출자가 '못 읽는 하네스'로 다룬다 — claude 로 추측하지 않는다). */
export function harnessIo(key: string | null | undefined): HarnessSessionAdapter | null {
  const k = String(key || "").toLowerCase();
  return HARNESS_IO.find((a) => a.key === k) ?? null;
}

/**
 * 화면이 버튼·안내를 정직하게 그리기 위한 능력 요약 — 세션 행(SessionInfo.chat)에 실린다.
 *
 *  · read      대화 파일을 화면으로 읽을 수 있나(파서 있음)
 *  · answer    승인·중단을 화면에서 대신 눌러줄 수 있나(키 매핑 있음)
 *  · chatFirst **대화창을 그 세션의 기본 화면으로 삼아도 되나** (#2439 P0)
 *
 *  ★ chatFirst 는 지금 read 와 같은 값이지만 **일부러 따로 둔다.** read 는 «할 수 있나»(능력)이고
 *   chatFirst 는 «기본으로 삼나»(정책)다. 종전엔 그 정책이 화면에 하드코딩돼 있었고(web/session-chat.ts
 *   `harness === 'codex'`), 그래서 **살아 있는 claude 세션은 터미널이 기본, 멈춘 claude 세션은 대화창**이
 *   되어 같은 세션인데 상태에 따라 화면이 갈렸다(#2439 — "읽을 때 UX 와 세션 시작됐을 때 UX 가 너무 다르다").
 *   정책을 서버 한 곳으로 올리면 화면은 하네스를 몰라도 되고, 나중에 «읽을 수는 있지만 터미널이 기본»인
 *   하네스가 생겨도 여기 한 줄만 바뀐다.
 */
export interface ChatIoCaps { read: boolean; answer: boolean; chatFirst: boolean }
export function chatIoCaps(harnessKey: string | null | undefined): ChatIoCaps {
  const a = harnessIo(harnessKey);
  const read = !!a?.parse;
  //  대화를 읽을 수 있으면 대화창이 기본이다. 못 읽으면(opencode·shell) 대화창은 빈 화면이 되므로 터미널이 기본.
  return { read, answer: !!a?.answer, chatFirst: read };
}

/** 세션 기록(중앙 캡처)을 화면으로 **읽을 수 있는** 하네스 — session-share 의 선택지가 여기서 파생된다(#1695 §3 '못 지킬 켜기 금지'). */
export const READABLE_HARNESSES: readonly string[] = HARNESS_IO.filter((a) => !!a.parse).map((a) => a.key);

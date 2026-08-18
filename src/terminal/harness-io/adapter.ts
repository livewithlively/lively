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
import path from "node:path";
import type { ChatKey } from "../send-keys.js";
import type { ParseResult, ParseState } from "./chat-line.js";
import { claudeIo } from "./claude.js";
import { grokIo } from "./grok.js";
import { antigravityIo } from "./antigravity.js";

export type ChatAction = "approve" | "deny" | "interrupt";
export const CHAT_ACTIONS: readonly ChatAction[] = ["approve", "deny", "interrupt"];
export const isChatAction = (v: unknown): v is ChatAction => (CHAT_ACTIONS as readonly string[]).includes(String(v));

export interface HarnessSessionAdapter {
  key: string;
  label: string;
  roots(homes: string[], owner: string): string[];
  filePattern: RegExp;
  pathFor: ((root: string, ctx: { cwd: string; convId: string }) => string | null) | null;
  /** 훅 보고(매핑)가 아직 없을 때의 마지막 폴백 — 이 cwd 의 규약 디렉터리에서 **가장 최근 대화 파일**을 찾는다(#1719).
   *  어댑터가 자기 규약을 아는 만큼만 구현한다(claude: <루트>/<cwd 인코딩>/<uuid>.jsonl). null = 규약상 못 찾음(추측 금지 유지). */
  latest: ((roots: string[], cwd: string) => Promise<{ convId: string; file: string; size: number } | null>) | null;
  parse: ((text: string, state: ParseState) => ParseResult) | null;
  answer: ((action: ChatAction) => ChatKey) | null;
}

// 아직 파서·승인 실측이 없는 하네스 — 축을 **명시적으로 null** 로 답한다(있는 척 금지 · 목록에서 빠지지도 않는다).
//  · codex: 대화 파일 `~/.codex/sessions/<Y>/<M>/<D>/rollout-<ts>-<id>.jsonl` — 이름에 시각이 들어 규약으로 못 만든다(훅 보고 경로 필요,
//    Stop payload 의 transcript_path 유무가 지식 간 상충 — 실측 후). 파서 후속.
//  · opencode: 단일 파일 계약 미확인(플러그인 event 스트림 → 파일로 떨구는 작업 선행, [[opencode-harness-spec-1519]] ⑤축).
const codexIo: HarnessSessionAdapter = {
  key: "codex", label: "Codex",
  roots: (homes) => homes.map((h) => path.join(h, ".codex", "sessions")),
  filePattern: /^rollout-.*\.jsonl$/,
  pathFor: null, latest: null, parse: null, answer: null,
};
const opencodeIo: HarnessSessionAdapter = {
  key: "opencode", label: "OpenCode",
  roots: () => [],
  filePattern: /\.jsonl$/,
  pathFor: null, latest: null, parse: null, answer: null,
};
// 셸 세션 — AI 없음. 대화 파일도 승인도 없다.
const shellIo: HarnessSessionAdapter = {
  key: "shell", label: "셸", roots: () => [], filePattern: /$^/, pathFor: null, latest: null, parse: null, answer: null,
};

export const HARNESS_IO: readonly HarnessSessionAdapter[] = [claudeIo, codexIo, opencodeIo, antigravityIo, grokIo, shellIo];

/** 하네스 key → 어댑터. 모르는 key 는 null(호출자가 '못 읽는 하네스'로 다룬다 — claude 로 추측하지 않는다). */
export function harnessIo(key: string | null | undefined): HarnessSessionAdapter | null {
  const k = String(key || "").toLowerCase();
  return HARNESS_IO.find((a) => a.key === k) ?? null;
}

/** 화면이 버튼·안내를 정직하게 그리기 위한 능력 요약 — 세션 행(SessionInfo.chat)에 실린다. */
export interface ChatIoCaps { read: boolean; answer: boolean }
export function chatIoCaps(harnessKey: string | null | undefined): ChatIoCaps {
  const a = harnessIo(harnessKey);
  return { read: !!a?.parse, answer: !!a?.answer };
}

/** 세션 기록(중앙 캡처)을 화면으로 **읽을 수 있는** 하네스 — session-share 의 선택지가 여기서 파생된다(#1695 §3 '못 지킬 켜기 금지'). */
export const READABLE_HARNESSES: readonly string[] = HARNESS_IO.filter((a) => !!a.parse).map((a) => a.key);

// Claude Code 세션 I/O 어댑터 (#1746) — 공통 ChatLine 의 원조라 파서는 **통과**다. 경로 규약·승인 키만 여기 적는다.
//
//  · 대화 파일: <루트>/<cwd 인코딩>/<uuid>.jsonl — 루트 = 공유 ~/.claude/projects · 멤버 프로필(CLAUDE_CONFIG_DIR, #1014) ·
//    격리 홈(/home/box_<slug>/.claude, 리눅스). 규약 조각은 terminal-transcript.ts 가 소유한다(여기서 다시 적지 않는다).
//  · 승인: Claude Code 의 승인 대화상자는 Enter=기본 선택(승인) · Esc=거부. 중단(도는 턴 끊기)도 Esc.
//  · 파서: 한 줄이 그대로 ChatLine 의 상위집합이다 — JSON 으로 읽히는 줄은 그대로 넘긴다(깨진 줄만 버린다). 화면이 모르는 type
//    (summary·file-history-snapshot 등)은 화면이 무시한다. 여기서 골라내지 않는 이유: 화면이 이미 이 문법을 다 알고 있고, 고르면
//    나중에 화면이 쓰고 싶은 필드를 여기서 잘라먹는 자리가 생긴다. claude 가 형식을 바꾸는 날 이 함수가 번역기가 된다.
import path from "node:path";
import type { HarnessSessionAdapter } from "./adapter.js";
import { parseJsonLines, type ChatLine } from "./chat-line.js";
import { claudeTranscriptRoots, claudeProjectsDirName } from "../terminal-transcript.js";

const CONV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const claudeIo: HarnessSessionAdapter = {
  key: "claude", label: "Claude Code",
  roots: (homes, owner) => claudeTranscriptRoots(homes, owner),
  filePattern: /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/,
  pathFor: (root, { cwd, convId }) => (cwd && CONV_ID_RE.test(convId) ? path.join(root, claudeProjectsDirName(cwd), `${convId}.jsonl`) : null),
  // claude 의 대화 id 는 항상 UUID 다(대화 파일이 `<uuid>.jsonl`). 보고를 받을 때만 이 좁은 자를 댄다.
  convIdOk: (id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
  parse: (text, state) => ({ lines: parseJsonLines(text).filter((o) => !!o && typeof o === "object") as ChatLine[], state }),
  answer: (action) => (action === "approve" ? "Enter" : "Escape"),
  // 화면 판정(실측 규약 — session-first-prompt.ts·phase.ts 와 같은 문구): 입력창 푸터가 보이면 ready(돌고 있어도 큐잉 보장),
  //  신뢰·선택 대화상자는 dialog, 로그인 화면은 auth. 그 밖(부팅 스피너 등)은 null.
  screen: (tail) => {
    const t = tail.join("\n");
    if (/trust the (files|contents) (in|of) this (folder|directory|project)/i.test(t)) return "dialog";
    if (/Select login method|Welcome to Claude Code\b[\s\S]*login/i.test(t)) return "auth";
    if (tail.some((l) => /\b(auto|manual|plan|accept edits|bypass permissions) mode on\b|\? for shortcuts|shift\+tab to cycle/i.test(l))) return "ready";
    if (/Enter to select|↑\/↓ to navigate|Esc to cancel/i.test(t)) return "dialog";
    return null;
  },
};

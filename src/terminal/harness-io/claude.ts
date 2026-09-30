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
import { claudeTranscriptRoots, claudeProjectsDirName, claudeProjectsDirExact } from "../terminal-transcript.js";

const CONV_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const claudeIo: HarnessSessionAdapter = {
  key: "claude", label: "Claude Code",
  roots: (homes, owner) => claudeTranscriptRoots(homes, owner),
  filePattern: /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/,
  //  #3870 — 규약으로 정확히 못 짚는 폴더(200자 초과 · Claude Code 가 해시 꼬리를 붙인다)엔 **틀린 경로 대신 null**.
  //   틀린 경로를 내면 stat 이 빈손이라 «대화가 없다» 로 읽히고, 복원이 멀쩡한 대화를 버린다.
  pathFor: (root, { cwd, convId }) => (cwd && claudeProjectsDirExact(cwd) && CONV_ID_RE.test(convId) ? path.join(root, claudeProjectsDirName(cwd), `${convId}.jsonl`) : null),
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
  //  #4135 — 웹 터미널이 쓰는 화면 사실. 전부 이 레포가 이미 실측해 둔 것을 **한자리로 모은 것**이다:
  //   · appMouse — Claude Code 는 alt 화면에서 마우스를 쥔다(그래서 ⌘C↔^C 다리와 ⌥드래그가 필요하다, #972 #1117).
  //   · choiceNeedsEnter=false — 선택지는 숫자만으로 골라진다. 폰 키 줄이 Enter 를 **안 붙이는** 근거다(#4160).
  //   · pastePlaceholder — 여러 줄은 «[Pasted text +N lines]» 로 접힌다(자동 전송의 안착 확인이 이 표식을 본다).
  //   · startDialogRe — 신뢰 폴더·권한 경고. 정상 입력박스의 '⏵⏵ bypass permissions on' 과 구분하려고 대문자 'Bypass
  //     Permissions mode' 를 본다(둘을 섞으면 멀쩡한 입력창을 대화상자로 보고 영영 기다린다 — terminal.ts 머리말).
  term: {
    appMouse: true, choiceNeedsEnter: false, pastePlaceholder: true,
    startDialogRe: /trust (this|the) (folder|files)|Do you trust|Enter to confirm|❯\s*1\.\s|\bNo, exit\b|Bypass Permissions mode|accept the risk/i,
  },
};

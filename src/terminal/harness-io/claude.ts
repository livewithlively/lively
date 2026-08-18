// Claude Code 세션 I/O 어댑터 (#1746) — 공통 ChatLine 의 원조라 파서는 **통과**다. 경로 규약·승인 키만 여기 적는다.
//
//  · 대화 파일: <루트>/<cwd 인코딩>/<uuid>.jsonl — 루트 = 공유 ~/.claude/projects · 멤버 프로필(CLAUDE_CONFIG_DIR, #1014) ·
//    격리 홈(/home/box_<slug>/.claude, 리눅스). 규약 조각은 terminal-transcript.ts 가 소유한다(여기서 다시 적지 않는다).
//  · 승인: Claude Code 의 승인 대화상자는 Enter=기본 선택(승인) · Esc=거부. 중단(도는 턴 끊기)도 Esc.
//  · 파서: 한 줄이 그대로 ChatLine 의 상위집합이다 — JSON 으로 읽히는 줄은 그대로 넘긴다(깨진 줄만 버린다). 화면이 모르는 type
//    (summary·file-history-snapshot 등)은 화면이 무시한다. 여기서 골라내지 않는 이유: 화면이 이미 이 문법을 다 알고 있고, 고르면
//    나중에 화면이 쓰고 싶은 필드를 여기서 잘라먹는 자리가 생긴다. claude 가 형식을 바꾸는 날 이 함수가 번역기가 된다.
import fsp from "node:fs/promises";
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
  // 매핑(훅 보고)이 아직 없는 박스의 폴백 — 이 cwd 규약 폴더에서 mtime 최신 .jsonl. 같은 폴더에 여러 박스가 돌면
  //  남의(같은 소유자) 대화를 고를 수 있는 한계가 있지만, "방금 내가 친 세션"에선 최신 파일이 곧 그 대화다.
  //  매핑이 생기는 순간 라우트가 그것을 우선하므로(mapped ?? scan) 이 추측은 스스로 물러난다.
  latest: async (roots, cwd) => {
    if (!cwd) return null;
    let best: { convId: string; file: string; size: number; mtime: number } | null = null;
    for (const root of roots) {
      const dir = path.join(root, claudeProjectsDirName(cwd));
      let names: string[] = [];
      try { names = await fsp.readdir(dir); } catch { continue; }
      for (const name of names) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.test(name)) continue;
        const convId = name.replace(/\.jsonl$/, "");
        if (!CONV_ID_RE.test(convId)) continue;
        const file = path.join(dir, name);
        try {
          const st = await fsp.stat(file);
          if (!st.isFile() || st.size === 0) continue;
          if (!best || st.mtimeMs > best.mtime) best = { convId, file, size: st.size, mtime: st.mtimeMs };
        } catch { /* 지워지는 중 — 다음 파일 */ }
      }
    }
    return best ? { convId: best.convId, file: best.file, size: best.size } : null;
  },
  parse: (text, state) => ({ lines: parseJsonLines(text).filter((o) => !!o && typeof o === "object") as ChatLine[], state }),
  answer: (action) => (action === "approve" ? "Enter" : "Escape"),
};

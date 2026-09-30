// 💬 «내가 한 질문» 목록 — **하네스 무관** (#4135).
//
//  ── 무엇이 없었나 ──
//  터미널 화면의 💬 단추는 이 세션에서 사람이 던진 질문을 모아 보여 주고, 누르면 그 자리로 스크롤백을 거슬러 올라간다.
//  그런데 그 목록을 만드는 자리(terminal-transcript.sessionPrompts)는 **`~/.claude/projects/<cwd 인코딩>` 규약 전용**이다.
//  codex 의 기록은 `~/.codex/sessions/<Y>/<M>/<D>/rollout-<시각>-<id>.jsonl` 이라 cwd 로 폴더를 짚을 수 없다 — 그래서
//  codex 세션에서 이 단추는 **언제나 빈 목록**이었다(있는 기능이 조용히 반쪽).
//
//  ── 어떻게 ──
//  파일을 찾는 일과 읽는 일은 이미 하네스 축으로 정리돼 있다(resolveTranscript → 훅 보고 경로 1급 · 규약 폴백,
//  멤버 실행환경 중계 포함). 여기서는 그 결과를 **어댑터 파서**로 읽어 `user` 줄만 남긴다.
//  claude 는 종전 경로를 그대로 쓴다 — 그쪽은 «폴더의 대화 **전부**»(압축 전 파일·프로필 여러 벌)를 합치는 일을 하고,
//  그 값을 이 좁은 경로로 바꾸면 지금 매핑된 대화 한 벌로 **줄어든다**(무회귀 우선).
//
//  ⚠ 접근통제는 라우트(canAttach)가 한다 — 여기서는 파일만 읽는다.
//  ⚠ 실패는 빈 결과다(비치명). 목록이 안 뜨는 것이 화면이 죽는 것보다 낫다.
import { resolveTranscript } from "./transcript-locate.js";
import { readAlignedWindow } from "./harness-io/window.js";
import type { ChatLine } from "./harness-io/chat-line.js";
import type { Prompt } from "./terminal-transcript.js";

/** 한 번에 읽는 기록 꼬리 — 질문 목록은 «최근 것»이 쓸모다. 큰 파일을 통째로 들고 오지 않는다(중계 배포에선 왕복 비용). */
const TAIL_BYTES = 4 * 1024 * 1024;

/** ChatLine 의 사람 발화 → 글자. codex 는 문자열, 다른 파서는 블록 배열을 줄 수 있어 둘 다 받는다. */
function userText(line: ChatLine): string {
  const c: unknown = (line as { message?: { content?: unknown } }).message?.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : ""))
      .join("\n").trim();
  }
  return "";
}

/**
 * 비-claude 세션의 질문 목록. 못 찾거나 못 읽으면 `found:false` — 화면은 그대로 «기록을 아직 못 찾았어요» 를 말한다.
 * (claude 세션은 호출자가 종전 `sessionPrompts(cwd)` 로 보낸다 — 이 함수를 타지 않는다.)
 */
export async function sessionPromptsFromTranscript(id: string, limit = 300): Promise<{ prompts: Prompt[]; total: number; found: boolean }> {
  const t = await resolveTranscript(id);
  if (!t.ok) return { prompts: [], total: 0, found: false };
  const { file, size } = t.found;
  try {
    const text = await t.tfs.read(file, size, async (r) => {
      //  줄 경계에 맞춰 꼬리를 읽는다 — 반 토막 난 JSON 줄은 파서가 버리지만, 맞춰 읽으면 그 한 줄을 안 잃는다.
      const w = await readAlignedWindow(r, size, Math.max(0, size - TAIL_BYTES), size, true);
      return w.data.toString("utf8");
    });
    const { lines } = t.io.parse(text, {});
    const out: Prompt[] = [];
    for (const line of lines) {
      if (line.type !== "user") continue;
      if (line.isMeta || line.isSidechain) continue;   // 주입·서브에이전트 가지는 사람이 던진 질문이 아니다(화면도 숨긴다)
      const s = userText(line);
      if (!s) continue;
      //  author 는 «어느 멤버 프로필에서 온 질문인가» 다(claude 경로가 여러 홈을 훑어서 쓰는 값).
      //  여기는 이 세션의 대화 한 벌이라 출처가 하나다 — 빈 문자열로 둔다(화면이 이름표를 안 그린다).
      out.push({ text: s, ts: (line as { timestamp?: string }).timestamp || "", author: "" });
    }
    return { prompts: out.slice(-limit), total: out.length, found: true };
  } catch {
    return { prompts: [], total: 0, found: false };   // 비치명 — 목록만 비운다
  }
}

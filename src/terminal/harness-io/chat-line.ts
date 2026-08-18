// 공통 대화 이벤트(ChatLine) v1 — 세션 대화창(web/session-chat.ts)·중앙 세션 기록·리브가 **같은 것**을 소비한다(#1719 #1746).
//
//  ── 왜 ──
//  세션 대화창은 하네스가 디스크에 쓰는 대화 파일을 tail 해 말풍선으로 그린다. 그 파일의 스키마는 하네스마다 완전히 다르다
//  (claude jsonl · grok ACP updates.jsonl · antigravity step 로그 · codex rollout …). 화면이 그 차이를 알면 하네스가 늘 때마다
//  화면·중앙기록 뷰어·리브가 같이 흔들린다. 그래서 **서버의 하네스 어댑터(harness-io/*.ts)가 여기 정의한 한 가지 모양으로 번역**하고,
//  화면은 이 모양만 안다.
//
//  ── 모양 ──
//  이름과 구조는 Claude Code 트랜스크립트 한 줄과 **호환되게** 골랐다 — 화면(chat-view.ts)과 리브(liv-chat.ts, claude stream-json)가
//  이미 그 문법(assistant/user 메시지의 text·thinking·tool_use·tool_result 블록)을 그리고 있어서다. 그래서 claude 어댑터는 사실상
//  통과이고, 다른 하네스 어댑터가 이 모양으로 **올라온다**. 이건 "정본 = 지금의 claude 형식"이 아니라 "정본 = 여기 적힌 부분집합"이다 —
//  claude 가 형식을 바꾸면 claude 어댑터가 번역기가 된다(화면은 안 바뀐다).
//
//  ── 지키는 것 ──
//  · 한 줄 = 한 이벤트(ndjson). timestamp 는 ISO 8601.
//  · user 줄의 text 블록 = 사람 말. tool_result 블록만 있는 user 줄 = 도구 결과(사람 말 아님).
//  · assistant 줄 = AI 가 한 것(글·생각·도구 호출)을 블록으로.
//  · system 줄 = 턴의 마감(turn_duration)·중단(interrupted)·맥락 압축(compact). 화면이 상태점·구분선을 그리는 근거.
//  · 어댑터는 원문을 버리지 않는다 — 접을 뿐(tool_result content 는 원문 텍스트).
export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | Array<{ type: "text"; text: string }>; is_error?: boolean };

export interface ChatUserLine {
  type: "user";
  timestamp: string;
  message: { role: "user"; content: string | ChatBlock[] };
  isMeta?: boolean;                 // 사람이 친 말이 아닌 주입(화면이 숨긴다)
  isSidechain?: boolean;            // 서브에이전트 가지(화면이 숨긴다)
  permissionMode?: string;          // 이 턴의 권한 모드(있으면 화면 칩)
}
export interface ChatAssistantLine {
  type: "assistant";
  timestamp: string;
  message: { role: "assistant"; content: ChatBlock[]; model?: string; id?: string };
  isSidechain?: boolean;
  effort?: string;                  // 추론 강도(있으면 화면 칩)
}
export interface ChatSystemLine {
  type: "system";
  subtype: "turn_duration" | "interrupted" | "compact" | "stop_hook_summary";
  timestamp: string;
  durationMs?: number;              // turn_duration — 이 턴에 걸린 시간
  text?: string;                    // compact — 요약 본문(있으면 구분선을 펼쳐 보여준다)
}
export type ChatLine = ChatUserLine | ChatAssistantLine | ChatSystemLine;

/** 어댑터 파서의 이어 읽기 상태 — 모양은 어댑터마다 다르다(불투명). 창(window) 사이를 잇는 데만 쓴다. */
export type ParseState = Record<string, unknown>;
export interface ParseResult { lines: ChatLine[]; state: ParseState }

// ── 작은 도우미(어댑터 공용) ──
/** epoch(초·밀리초)·ISO·Date → ISO 문자열. 못 읽으면 빈 문자열(화면은 빈 timestamp 를 '시각 미상'으로 다룬다). */
export function isoOf(v: unknown): string {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : "";
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v;         // 초 단위(10자리)면 밀리초로
    return new Date(ms).toISOString();
  }
  if (typeof v === "string" && v.trim()) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
  }
  return "";
}

/** ndjson 한 덩이 → 파싱된 객체 배열(깨진 줄·빈 줄은 건너뛴다). 어댑터가 첫 단계로 쓴다. */
export function parseJsonLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 깨진 줄(쓰는 중이거나 잡음) — 건너뛴다 */ }
  }
  return out;
}

/** ChatLine 들 → ndjson 본문(끝 개행 포함). 라우트가 응답 본문으로 쓴다. 빈 배열이면 빈 문자열. */
export function toNdjson(lines: ChatLine[]): string {
  return lines.length ? lines.map((l) => JSON.stringify(l)).join("\n") + "\n" : "";
}

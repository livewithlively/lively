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
  subtype: "turn_duration" | "interrupted" | "compact" | "stop_hook_summary" | "error";
  timestamp: string;
  durationMs?: number;              // turn_duration — 이 턴에 걸린 시간
  text?: string;                    // compact — 요약 본문 · error — 사람이 다음에 할 일을 아는 한 문장
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

// ── 얇은 판(#1819) — 타임라인이 세션 **전체**를 볼 수 있게 ────────────────────────────────
//  타임라인(우패널)의 재료는 이 대화록인데, 대화창은 성능 때문에 꼬리 1.5MB 만 읽는다. 긴 세션에서는 그게
//  전체의 몇 %라, 타임라인이 "내가 시킨 것"의 대부분을 **알 수조차 없었다**(실측 #1819: 20.3MB 세션에서
//  질문 15개 중 14개가 창 밖 — 화면엔 2줄만 떴다).
//  그렇다고 20MB 를 브라우저로 보낼 수는 없다. 그래서 **덩치만 버린 같은 모양**을 만든다:
//    · 버리는 것 — 도구 결과 본문(제일 크다) · 도구 입력의 파일 내용 · 생각(thinking) · 화면이 안 보는 type
//    · 남기는 것 — 사람 말 · AI 가 한 말 · 어떤 도구를 무엇에 썼나 · 턴 마감
//  실측(같은 20.3MB 파일): 455KB = 2.24%, 44배. 모양은 ChatLine 그대로라 **화면의 분류 규칙을 그대로 쓴다**
//  (규칙을 서버에 또 적으면 두 벌이 갈라진다).
/** 도구 입력에서 남길 열쇠 — 화면의 분류기(web/session-trail.ts classifyToolUse)가 실제로 읽는 것만. */
const THIN_INPUT_KEYS = new Set(["file_path", "notebook_path", "command", "name", "title", "mode", "id", "status"]);
const THIN_TEXT_MAX = 600;       // 답 한 줄이면 충분하다(화면도 첫 문장만 쓴다)
const THIN_SAY_MAX = 4000;       // 사람 말은 '전문 보기'가 있어 조금 넉넉히
const THIN_CMD_MAX = 4000;       // Bash 는 명령 안쪽(heredoc·커밋 메시지)을 정규식으로 훑는다
const clip = (v: string, n: number): string => (v.length > n ? v.slice(0, n) : v);
/** 사람 말 전용 자르기 — **앞뒤를 함께** 남긴다 (#762, 원준 2026-09-04).
 *  ⚠ 앞만 남기면(clip) 「회의록 전사본 붙여넣기 + 그 아래 '정리해줘'」에서 **지시가 통째로 잘린다** —
 *   타임라인엔 전사 앞머리만 제목으로 서고 정작 시킨 말은 사라진다(신고된 그 화면). 사람은 붙여넣은 뒤에
 *   시키는 일이 많으므로 꼬리가 오히려 본론이다. 가운데만 버리고 그 사실을 한 줄로 남긴다. */
const clipEnds = (v: string, n: number): string => {
  if (v.length <= n) return v;
  const head = Math.floor(n * 0.55), tail = n - head - 40;
  return v.slice(0, head) + "\n…(가운데 " + (v.length - head - tail) + "자 줄임)…\n" + v.slice(v.length - tail);
};

function thinInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!THIN_INPUT_KEYS.has(k)) continue;
    out[k] = typeof v === "string" ? clip(v, k === "command" ? THIN_CMD_MAX : 400) : v;
  }
  return out;
}

/** ChatLine 한 줄 → 얇은 줄. 타임라인이 볼 것이 없으면 null(그 줄은 아예 안 보낸다). */
export function thinLine(line: ChatLine): ChatLine | null {
  const o = line as any;
  if (!o || typeof o !== "object") return null;
  if (o.type === "system") {
    // ⚠ error 는 **본문이 곧 내용**이라 얇은 줄에서도 text 를 남긴다 — 지우면 화면에 «오류» 라는 말만 남고
    //  이유가 사라진다(그 이유가 «로그인이 필요합니다» 라 더 그렇다).
    return {
      type: "system", subtype: o.subtype, timestamp: o.timestamp ?? "",
      ...(o.durationMs !== undefined ? { durationMs: o.durationMs } : {}),
      ...(o.subtype === "error" && typeof o.text === "string" ? { text: o.text } : {}),
    } as ChatLine;
  }
  if (o.type === "user") {
    const c = o.message?.content;
    const blocks: ChatBlock[] = [];
    if (typeof c === "string") { if (c.trim()) blocks.push({ type: "text", text: clipEnds(c, THIN_SAY_MAX) }); }
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && String(b.text ?? "").trim()) blocks.push({ type: "text", text: clipEnds(String(b.text), THIN_SAY_MAX) });
        // 도구 결과는 **본문을 버리고 성패만** 남긴다 — 화면은 실패 표시에만 쓴다(본문이 이 파일 덩치의 대부분이다).
        else if (b.type === "tool_result") blocks.push({ type: "tool_result", tool_use_id: String(b.tool_use_id ?? ""), content: "", ...(b.is_error ? { is_error: true } : {}) } as ChatBlock);
      }
    }
    if (!blocks.length) return null;
    const out: any = { type: "user", timestamp: o.timestamp ?? "", message: { role: "user", content: blocks } };
    if (o.uuid) out.uuid = o.uuid;
    if (o.isMeta) out.isMeta = true;
    if (o.isSidechain) out.isSidechain = true;
    return out as ChatLine;
  }
  if (o.type === "assistant") {
    const c = o.message?.content;
    const blocks: ChatBlock[] = [];
    if (Array.isArray(c)) {
      for (const b of c) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && String(b.text ?? "").trim()) blocks.push({ type: "text", text: clip(String(b.text), THIN_TEXT_MAX) });
        else if (b.type === "tool_use") blocks.push({ type: "tool_use", id: String(b.id ?? ""), name: String(b.name ?? ""), input: thinInput(b.input) });
        // thinking 은 버린다 — 타임라인이 안 쓴다.
      }
    }
    if (!blocks.length) return null;
    const out: any = { type: "assistant", timestamp: o.timestamp ?? "", message: { role: "assistant", content: blocks } };
    if (o.uuid) out.uuid = o.uuid;
    if (o.isSidechain) out.isSidechain = true;
    return out as ChatLine;
  }
  return null;                                  // summary·file-history-snapshot 등 — 타임라인이 안 본다
}

export function toThinNdjson(lines: ChatLine[]): string {
  const out: string[] = [];
  for (const l of lines) { const t = thinLine(l); if (t) out.push(JSON.stringify(t)); }
  return out.length ? out.join("\n") + "\n" : "";
}

/** 얇은 판이 한 번에 훑는 상한 — 이보다 큰 파일은 **꼬리부터** 이만큼만 본다(화면이 X-Log-From 으로 알아챈다). */
export const THIN_MAX_BYTES = 64 * 1024 * 1024;
/** 사슬(#2233 — 한 박스가 갈아탄 대화들) **전체**가 훑는 상한 — 지금 대화까지 포함한 총량이다.
 *  한 파일 상한과 같은 값으로 둔다: 사슬이 생겼다고 게이트웨이가 한 번에 파싱하는 양의 천장이 올라가면 안 된다
 *  (실측 참고: 대화 5개짜리 실제 박스가 36MB — 이 천장 안에 통째로 들어온다). 넘치면 최신 대화부터 담고 끊는다. */
export const THIN_CHAIN_MAX_BYTES = THIN_MAX_BYTES;

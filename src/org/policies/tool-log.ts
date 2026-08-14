// MCP 툴 호출 로그 적재 — 프로젝트 #318(MCP 호출 통계 대시보드)의 캡처 백엔드.
//  단일 진입점 logToolCall: src/server.ts 의 registerTool wrap(instrument)이 capability·db·dynamic 3경로의
//  모든 tools/call 마다 부른다. fire-and-forget INSERT — 요청 응답 경로를 막지 않고(await 안 함), 실패해도
//  호출 자체엔 영향 없음(fail-open, audit-log.ts 철학과 동일). 적재 대상 테이블은 mcp_call_log(src/org/schema.ts).
//
//  인자(args) 가공: redactDeep(시크릿 패턴 마스킹) → 큰 문자열 절단(MAX_STR) → 총 JSON 크기 캡(MAX_JSON).
//   knowledge_save body_md 같은 대형 페이로드는 잘려 들어가(통계용엔 충분), 시크릿 평문은 마스킹된다.
//
//  ⚠ 외부 통신 툴은 인자 '값'을 저장하지 않는다(#1082) — 아래 '외부 통신 툴 레지스트리' 참조.
import { itemsPool } from "../../db/client.js";
import { redactDeep, redactString } from "../ingest/redact.js";
import { scrubSqlLiterals } from "../../db/sql-scrub.js";
import { logger } from "../../log.js";

// ── 외부 통신 툴 레지스트리(#1082) ──────────────────────────────────────────────────────────
//  문제: 프록시 툴 인자에는 **조직 밖으로 나가는 본문**이 실린다(슬랙 DM 메시지, 메일 본문, 노션 페이지 내용).
//   redactDeep 은 토큰·키만 가리므로 그 본문은 평문으로 mcp_call_log 에 무기한 남고, admin 이면 관리탭에서 전부 읽혔다.
//   응답(상류에서 읽어온 것)은 pii_scrub 로 가리면서 요청(우리가 보낸 것)은 영구보관하던 비대칭을 없앤다.
//
//  왜 '필드 이름'으로 가리지 않는가 — 처음 안은 message·text 같은 본문성 키를 목록으로 관리하는 것이었으나 기각했다:
//   ① 같은 이름의 뜻이 툴마다 다르다(query 가 어떤 툴엔 식별자, 어떤 툴엔 사용자가 친 문장 그대로).
//   ② 목록 유지보수가 상류 릴리스 일정에 묶인다 — 상류가 스키마를 바꾼 뒤 우리가 따라잡기 전까지가 곧 유출 기간.
//   즉 **정책의 정확도를 외부가 정하는 값에 의존시키는 구조 자체**가 틀렸다. 그래서 인자를 해석하지 않는다.
//
//  대신 판정 근거는 우리가 정한 것만 쓴다 — 등록 경로가 자기 툴을 여기 직접 신고한다(mcp-proxy·dynamic-tools).
//   상류가 필드를 어떻게 바꾸든 정책은 그대로 선다. 예외(값도 저장)는 MCP 서버/툴 단위 토글이며, 그 단위 역시
//   우리가 등록한 것이라 외부 변경에 무효화되지 않는다.
export const EXT_PREFIX = "ext__"; // 프록시 툴 네임스페이스(SoT) — mcp-proxy.ts 의 NS 가 이 값을 쓴다.

const EXTERNAL_TOOLS = new Map<string, boolean>(); // 툴 이름 → logArgs(인자 값 저장 허용 여부)

/** 외부 통신 툴로 등록 — logArgs=false(기본)면 인자 값을 저장하지 않는다. 등록 경로가 서버/툴 설정을 그대로 넘긴다. */
export function markExternalTool(tool: string, logArgs: boolean): void {
  EXTERNAL_TOOLS.set(tool, logArgs);
}

/** 테스트 전용 — 레지스트리 초기화. */
export function resetExternalTools(): void {
  EXTERNAL_TOOLS.clear();
}

/**
 * 이 툴의 인자 값을 남길지 판정. "omit"=값 제거, "log"=값 저장(서버 토글 ON), null=외부 툴 아님(빌트인, 현행 유지).
 *  미등록 ext__* 를 omit 으로 접는 건 **백스톱**이다 — 등록 순서·경로 변경으로 신고가 빠져도 fail-closed 로 남게.
 *  (ext__ 접두는 상류가 아니라 우리가 붙이는 값이라, 이 백스톱은 외부 의존이 아니다.)
 */
export function externalArgsPolicy(tool: string): "log" | "omit" | null {
  const known = EXTERNAL_TOOLS.get(tool);
  if (known !== undefined) return known ? "log" : "omit";
  return tool.startsWith(EXT_PREFIX) ? "omit" : null;
}

export interface ToolCallRecord {
  tool: string;
  harness: string | null;
  actor: string | null;
  args: unknown;
  ok: boolean;
  error?: string | null;
  durationMs: number;
}

const MAX_STR = 500; // 인자 내 개별 문자열 값의 보존 상한(초과분은 절단 + 잔여 길이 표기)
const MAX_JSON = 16_384; // 가공 후 args JSON 직렬화 총 상한(초과 시 키 목록만 남기는 요약으로 대체)
const MAX_ERR = 2_000; // error 메시지 보존 상한
const MAX_KEYS = 50; // 값 미저장 시 남기는 최상위 키 개수 상한
const MAX_KEY_LEN = 64; // 키 이름 하나의 보존 상한(상류가 비정상적으로 긴 키를 쓰는 경우 방어)

/**
 * 값 없는 인자 요약(#1082) — 외부 통신 툴의 인자에서 **값을 일절 남기지 않는다.** 최상위 키 이름과 총 바이트만.
 *  중첩 객체·배열은 최상위 키만 남기므로 안쪽 값은 자동으로 전부 사라진다({payload:{text:"..."}} → keys:["payload"]).
 *  키 이름은 상류가 정하지만 **정책 판정에 쓰지 않는 단순 관측치**라, 이름이 바뀌어도 무효화될 정책이 없다.
 *  bytes 는 원본 기준(가공 전) — "얼마나 큰 걸 보냈나"는 남기되 "무엇을 보냈나"는 남기지 않는다.
 */
export function omitArgValues(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { __omitted: "external_tool_args" };
  try {
    out.bytes = Buffer.byteLength(JSON.stringify(raw ?? {}) ?? "", "utf8");
  } catch {
    // 순환참조 등 직렬화 불가 — 크기 표기를 포기하고 키만 남긴다.
  }
  if (Array.isArray(raw)) out.items = raw.length;
  else if (raw && typeof raw === "object") {
    out.keys = Object.keys(raw as Record<string, unknown>).slice(0, MAX_KEYS).map((k) => k.slice(0, MAX_KEY_LEN));
  }
  return out;
}

// 깊은 순회로 긴 문자열만 절단(redactDeep 이 이미 시크릿은 마스킹했다 가정). 구조(키/형태)는 보존한다.
function truncateStrings(v: unknown): unknown {
  if (typeof v === "string") {
    return v.length > MAX_STR ? `${v.slice(0, MAX_STR)}…(+${v.length - MAX_STR}자)` : v;
  }
  if (Array.isArray(v)) return v.map(truncateStrings);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = truncateStrings(val);
    return o;
  }
  return v;
}

// args → 저장 가능한 JSON 값. redact + 절단 + 총량 캡. 어떤 단계든 실패하면 안전한 플레이스홀더로 폴백.
export function capArgs(raw: unknown): unknown {
  if (raw == null) return {};
  let v: unknown;
  try {
    v = truncateStrings(redactDeep(raw));
  } catch {
    return { __note: "redact_failed" };
  }
  let json: string;
  try {
    json = JSON.stringify(v);
  } catch {
    return { __note: "stringify_failed" };
  }
  if (json.length > MAX_JSON) {
    const keys = v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v as object) : [];
    return { __truncated: true, bytes: json.length, keys };
  }
  return v ?? {};
}

// ── 실패 판정(#1653) ────────────────────────────────────────────────────────────────────────
//  MCP 툴은 실패를 **두 갈래**로 알린다: 예외를 던지거나, `{content, isError:true}` 를 **정상 반환**하거나.
//  프록시 계열(mcp-proxy·dynamic-tools)은 후자다 — 상류 403 도 예외가 아니라 isError:true 로 돌아온다.
//  그래서 "핸들러가 안 던졌으면 성공" 으로 적재하면 **커넥터가 전부 죽어 있어도 오류 수가 0** 으로 보인다
//  (실측: 2026-08-12 어니스트 구글 3종 전부 403 인데 mcp_call_log 는 ok=true·error=null).
//  이 판정 위에 상류 회귀 탐지를 얹으므로(#1657) 여기가 틀리면 탐지도 같이 눈이 먼다.
const NO_DETAIL = "(isError 로 실패를 알렸으나 에러 상세 없음)";

/** 핸들러가 정상 반환한 결과의 실패 여부 — 실패면 에러 텍스트, 성공이면 null. */
export function toolResultFailure(out: unknown): string | null {
  if (!out || typeof out !== "object" || Array.isArray(out)) return null; // 객체가 아니면 판정 불가 = 성공(무회귀)
  const r = out as { isError?: unknown; content?: unknown };
  if (r.isError !== true) return null; // SDK·mcp-proxy 와 같은 엄격 비교 — boolean true 만 실패로 본다
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const b of r.content) {
      const blk = b as { type?: unknown; text?: unknown } | null;
      if (blk && typeof blk === "object" && blk.type === "text" && typeof blk.text === "string" && blk.text) parts.push(blk.text);
    }
  }
  return parts.join("\n") || NO_DETAIL; // 텍스트 블록이 없어도(이미지 등) 실패 사실은 남긴다
}

/**
 * 저장될 error 문자열. #1653 이후 이 컬럼엔 예외 메시지뿐 아니라 **상류 응답 본문**(isError 반환분)이 들어온다.
 *  그래서 시크릿 마스킹을 태운다 — 상류 에러 본문에 우리가 보낸 자격이 에코되거나 상류 자신의 키가 섞일 수 있다.
 *
 *  ⚠ PII 스크럽(scrubPii)은 여기서 부르지 않는다. 두 가지 이유가 각각 독립으로 성립한다:
 *   ① 이미 걸렀다 — dynamic-tools·mcp-proxy 는 `pii_scrub` 가 켜진 경우 응답 텍스트를 스크럽한 **뒤**
 *      isError 결과에 담는다(dynamic-tools.ts · mcp-proxy.ts). 정책은 그 자리에서 이미 집행된다.
 *   ② 부르면 코어가 깨진다 — scrubPii 는 EE 경계라 미탑재 박스에서 **throw** 한다(pii-scrub.ts). 로그 적재는
 *      코어 기능이므로, 여기서 부르면 무료판의 외부 툴 에러가 전부 삼켜진다. 스크럽이 켜진 경로에서만
 *      호출한다는 그 파일의 fail-closed 계약을 지키는 것이기도 하다.
 *  인자(#1082)와 달리 통째로 버리지 않는 이유: '왜 깨졌나' 는 상류 회귀를 아는 유일한 단서다(#1657 이 소비).
 */
export function errorForLog(_tool: string, raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const t = String(raw);
  if (!t) return null;
  return redactString(t.slice(0, MAX_ERR * 2)).slice(0, MAX_ERR); // 마스킹 전 1차 절단 — 대형 본문에 정규식을 태우지 않게
}

// 한 건 적재(비동기, 호출자는 await 하지 않는다). 실패는 warn 로그만 남기고 삼킨다 — 통계 누락 ≠ 호출 실패.
/**
 * 이 툴 호출에 대해 **실제로 저장될 args 값**. 저장 직전 형태라 여기가 정책의 최종 관문이다(테스트 지점).
 *  · 외부 통신 툴 → 값 없는 요약. capArgs(절단·redact)를 태우지 않는 이유는 그 경로가 값을 '보존'하기 때문 —
 *    여기선 애초에 보존할 값이 없다. 남는 건 누가·언제·어떤 툴·성공여부(호출 행 자체)로 충분하다.
 *  · db_query → SQL 리터럴 스크럽(#705) 후 통상 가공. redactDeep(시크릿)만으론 PII 미포착이라 별도 처리.
 *  · 그 외(빌트인) → 현행 그대로(시크릿 마스킹 + 절단 + 총량 캡).
 */
export function argsForLog(tool: string, raw: unknown): unknown {
  if (externalArgsPolicy(tool) === "omit") return omitArgValues(raw);
  let args = raw;
  if (tool === "db_query" && args && typeof args === "object" && !Array.isArray(args)
      && typeof (args as Record<string, unknown>).sql === "string") {
    args = { ...(args as Record<string, unknown>), sql: scrubSqlLiterals((args as Record<string, unknown>).sql as string) };
  }
  return capArgs(args);
}

export function logToolCall(rec: ToolCallRecord): void {
  let argsJson: string;
  try {
    argsJson = JSON.stringify(argsForLog(rec.tool, rec.args));
  } catch {
    argsJson = "{}";
  }
  const error = errorForLog(rec.tool, rec.error);
  const durationMs = Number.isFinite(rec.durationMs) ? Math.round(rec.durationMs) : null;
  itemsPool
    .query(
      `INSERT INTO mcp_call_log(tool, harness, actor, args, ok, error, duration_ms)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
      [rec.tool, rec.harness, rec.actor, argsJson, rec.ok, error, durationMs],
    )
    .catch((err) => logger.warn({ err, tool: rec.tool }, "mcp_call_log INSERT 실패(무시)"));
}

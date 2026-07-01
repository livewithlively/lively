// MCP 툴 호출 로그 적재 — 프로젝트 #318(MCP 호출 통계 대시보드)의 캡처 백엔드.
//  단일 진입점 logToolCall: src/server.ts 의 registerTool wrap(instrument)이 capability·db·dynamic 3경로의
//  모든 tools/call 마다 부른다. fire-and-forget INSERT — 요청 응답 경로를 막지 않고(await 안 함), 실패해도
//  호출 자체엔 영향 없음(fail-open, audit-log.ts 철학과 동일). 적재 대상 테이블은 mcp_call_log(src/org/schema.ts).
//
//  인자(args) 가공: redactDeep(시크릿 패턴 마스킹) → 큰 문자열 절단(MAX_STR) → 총 JSON 크기 캡(MAX_JSON).
//   knowledge_save body_md 같은 대형 페이로드는 잘려 들어가(통계용엔 충분), 시크릿 평문은 마스킹된다.
import { itemsPool } from "../items/store.js";
import { redactDeep } from "./redact.js";
import { logger } from "../log.js";

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

// 한 건 적재(비동기, 호출자는 await 하지 않는다). 실패는 warn 로그만 남기고 삼킨다 — 통계 누락 ≠ 호출 실패.
export function logToolCall(rec: ToolCallRecord): void {
  let argsJson: string;
  try {
    argsJson = JSON.stringify(capArgs(rec.args));
  } catch {
    argsJson = "{}";
  }
  const error = rec.error ? String(rec.error).slice(0, MAX_ERR) : null;
  const durationMs = Number.isFinite(rec.durationMs) ? Math.round(rec.durationMs) : null;
  itemsPool
    .query(
      `INSERT INTO mcp_call_log(tool, harness, actor, args, ok, error, duration_ms)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
      [rec.tool, rec.harness, rec.actor, argsJson, rec.ok, error, durationMs],
    )
    .catch((err) => logger.warn({ err, tool: rec.tool }, "mcp_call_log INSERT 실패(무시)"));
}

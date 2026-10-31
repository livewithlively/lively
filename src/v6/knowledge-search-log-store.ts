// v6/knowledge-search-log-store.ts — 세션의 지식 찾기 기록(#5201). 호출 한 번에 한 줄 — 무엇을 찾았고 무엇이 나왔고 무엇을 열었나.
//
//  왜 — 검색 품질을 지금까지 맥 한 대의 세션 파일로만 쟀다. 0건 비율 · 찾기 뒤 열람률을 다른 사람 · 다른 워크스페이스에서도 재야 다음 판을 수치로 견준다.
//  누구의 것 — 세션(MCP · 세션 헤더를 실은 REST)이 부른 찾기만 남긴다(capabilities/knowledge/read.ts 가 가른다). 앱 토큰은 남기지 않는다 — 그 질문은 앱 사용자의 것이다.
//  누가 보나 — 이 표는 db_query 내장 소스 목록(ITEMS_CONTENT_TABLES)에 없어 기본 차단이다. 검색어는 그 사람이 찾던 것이다 — 비밀 값은 가려서 남긴다.
//  자동 소환 훅(recall · 옛 훅은 similar)은 사람 프롬프트 원문이 검색어라 글을 남기지 않는다 — 몇 건이 무엇이 나왔는지만 있으면 잴 수 있다.
//  쓰기 — 응답을 막지 않는다(기다리지 않는다 · 실패는 삼킨다).
import { itemsPool } from "../db/client.js";
import { redactString } from "../org/ingest/redact.js";

export const KNOWLEDGE_SEARCH_LOG_KEEP_DAYS = 90;
const NAMES_MAX = 10;
const TOOLS: ReadonlySet<string> = new Set(["search", "grep", "similar", "recall", "get"]);

export interface KnowledgeSearchLogInput {
  tool: "search" | "grep" | "similar" | "recall" | "get";
  member?: string | null;
  session?: string | null;
  route?: string | null;
  q?: string | null;
  names?: readonly string[];
  n?: number;
  ms?: number;
}

/** 한 줄 남긴다. 기다리지 않아도 된다 — 던지지 않는다. */
export async function logKnowledgeSearch(input: KnowledgeSearchLogInput): Promise<void> {
  if (!TOOLS.has(input.tool)) return;
  try {
    await itemsPool.query(
      `INSERT INTO knowledge_search_log(member, session_id, tool, route, q, names, n, ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [input.member ?? null, input.session ?? null, input.tool, input.route ?? null,
        input.q ? redactString(String(input.q)).replace(/\u0000/g, "").trim().slice(0, 200) : null,
        input.names ? input.names.slice(0, NAMES_MAX) : null,
        input.n ?? input.names?.length ?? null, input.ms != null ? Math.round(input.ms) : null]);
  } catch (e) {
    console.warn(`[knowledge-search-log] 기록 실패(무시): ${(e as Error)?.message}`);
  }
}

/** 묵은 기록을 지운다 — 세션 기록 보존 정리(session-log-reap, 6시간)에 얹혀 돈다. */
export async function reapKnowledgeSearchLog(days: number = KNOWLEDGE_SEARCH_LOG_KEEP_DAYS): Promise<number> {
  const r = await itemsPool.query(`DELETE FROM knowledge_search_log WHERE ts < now() - ($1 || ' days')::interval`, [String(Math.max(1, Math.round(days)))]);
  return r.rowCount ?? 0;
}

// 검색 공용 유틸 — grep 매처(정규식/토큰 AND)·스니펫 빌더·RRF 상수·임베딩 provider 접근자.
//  knowledge(#172)·project(#631)가 공유한다. 컬럼/테이블 불가지론(cols 인자·target 파라미터) — 특정 엔티티에 묶이지 않는다.
//  · grep 매처/스니펫은 순수(DB 불요) → 유닛테스트 가능(search-util.test.ts).
//  · activeEmbeddingProvider 만 DB(org_runtime_config)를 읽는다(무순환: embedding-provider 는 store 미import 유지 → 여기로 뺀다).
import { itemsPool } from "../db/client.js";
import { one } from "../db/client.js";
import { type EmbeddingProvider, resolveEmbeddingConfig, resolveEmbeddingProvider } from "./embedding-provider.js";

// ── grep 매처 — Claude Code(ripgrep) 직관에 맞춘 텍스트 매칭. "search"(의미검색)가 아니라 grep이다.
//  · 정규식 메타문자가 있고 유효한 패턴이면 → POSIX 정규식(`~*`, 대소문자 무시)으로 grep. 예: `벡터|vector`, `task_\w+`.
//  · 그 외(평문)면 → 공백으로 나눈 모든 토큰이 (어느 컬럼이든) 등장해야 매치(AND, 부분일치). 단일 토큰이면 단순 contains.
//  · LIKE 와일드카드(`%`/`_`)는 평문 토큰에서 리터럴로 이스케이프(grep 패리티 — `knowledge_x` 의 `_` 가 와일드카드로 새지 않게).
const REGEX_META = /[.*+?^${}()|[\]\\]/;
function likeEscape(s: string): string { return s.replace(/[\\%_]/g, "\\$&"); }
export type GrepPlan = { mode: "regex"; pattern: string; re: RegExp } | { mode: "tokens"; tokens: string[] };
export function parseGrep(qstr: string): GrepPlan {
  const t = (qstr ?? "").trim();
  if (REGEX_META.test(t)) {
    try { return { mode: "regex", pattern: t, re: new RegExp(t, "i") }; } catch { /* 깨진 정규식 → 토큰으로 폴백 */ }
  }
  const tokens = t.split(/\s+/).filter(Boolean);
  return { mode: "tokens", tokens: tokens.length ? tokens : [t] };
}
/**
 * 질의가 **그 자체로 식별자(정수 id)** 인가 — 맞으면 `<col> = $n` 술어를 돌려주고 params 에 숫자를 push 한다.
 * 아니면 null(호출부가 grep 만 쓴다).
 *
 * 왜 grep 컬럼에 `id::text` 를 얹지 않는가 — 그러면 부분일치가 된다. `1` 로 찾으면 1·10·100·1835 가 다 걸려
 * 목록이 쓰레기가 된다. **번호로 찾는다는 건 그 번호를 지목한다는 뜻**이므로 정확일치만 받는다.
 * 앞의 `#` 은 사람이 쓰는 표기라 벗겨 준다(`#1835` = `1835`). 32비트를 넘으면 id 가 아니다(int 컬럼).
 */
export function idEquals(col: string, q: string, params: unknown[]): string | null {
  const t = String(q ?? "").trim().replace(/^#/, "");
  if (!/^[0-9]{1,10}$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2147483647) return null;
  params.push(n);
  return `${col} = $${params.length}`;
}

// cols 중 어느 하나에 매치(OR). regex 는 패턴 1개, tokens 는 토큰마다 (cols OR) 를 AND 로 묶는다. params 에 push 하고 WHERE 절 문자열 반환.
export function grepWhere(cols: string[], plan: GrepPlan, params: unknown[]): string {
  const colsOr = (placeholder: string) => "(" + cols.map((c) => `${c} ${placeholder}`).join(" OR ") + ")";
  if (plan.mode === "regex") {
    params.push(plan.pattern);
    return colsOr(`~* $${params.length}`);
  }
  return plan.tokens.map((tok) => { params.push(`%${likeEscape(tok)}%`); return colsOr(`ILIKE $${params.length} ESCAPE '\\'`); }).join(" AND ");
}
// regex→token 폴백 공통화: plan 으로 쿼리하되 POSIX 가 정규식을 거부하면(JS 유효·POSIX 무효 드묾) 토큰모드로 1회 재시도 — 에이전트에 에러 누출 안 함.
export async function grepExec<T>(qstr: string, runWithPlan: (plan: GrepPlan) => Promise<T>): Promise<{ result: T; plan: GrepPlan }> {
  let plan = parseGrep(qstr);
  try { return { result: await runWithPlan(plan), plan }; }
  catch (e) {
    if (plan.mode !== "regex") throw e;          // 토큰 모드 실패는 진짜 에러
    plan = { mode: "tokens", tokens: qstr.trim().split(/\s+/).filter(Boolean) || [qstr] };
    return { result: await runWithPlan(plan), plan };  // POSIX 가 거부한 정규식 → 토큰 부분일치 폴백
  }
}

// ── grep 스니펫 — 매치 줄만 "L<n>: …" 로(ripgrep 식, 여러 매치 표시). ⚠ 검색 결과는 절대 본문 전문을 싣지 않는다
//  (전문 스프레드가 토큰 폭주로 응답 잘림을 유발했음). 본문은 snippet 으로만 보이고, 전문은 <getHint>(knowledge_get/project_get_v6).
const SNIP_MAX_LINES = 4;     // 결과당 표시할 매치 줄 상한(초과분은 "(+N matches)")
const SNIP_LINE_CHARS = 160;  // 줄당 트림 길이(매치 주변)

// 한 줄의 매치 시작 위치(없으면 -1). regex 는 줄 단위 exec, tokens 는 토큰 중 하나라도(OR) 등장하는 최좌단(트림 기준).
function grepLineAt(line: string, plan: GrepPlan): number {
  if (plan.mode === "regex") { const m = plan.re.exec(line); return m ? m.index : -1; }
  let at = -1;
  const lower = line.toLowerCase();
  for (const tok of plan.tokens) { const i = lower.indexOf(tok.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i; }
  return at;
}
// 한 줄을 매치 주변 SNIP_LINE_CHARS 자로 트림(탭→공백, 양끝 …).
function grepTrimLine(line: string, at: number): string {
  const s = line.replace(/\t/g, " ").trim();
  if (s.length <= SNIP_LINE_CHARS) return s;
  const start = Math.max(0, at - 48);
  const end = Math.min(s.length, start + SNIP_LINE_CHARS);
  return (start > 0 ? "…" : "") + s.slice(start, end).trim() + (end < s.length ? "…" : "");
}
// 본문에서 매치 줄들을 ripgrep 처럼 "L<n>: …". context>0 면 매치 줄 ±context 줄도 포함(-C 패리티,
//  비연속 그룹은 ⋯ 로 구분). 본문 매치가 0줄이면(제목만 매치 등) 앞부분 미리보기로 폴백.
//  getHint = 초과 매치 시 전문 조회 툴 힌트(knowledge_get / project_get_v6 등).
export function grepSnippet(body: string, plan: GrepPlan, context = 0, getHint = "knowledge_get"): string {
  if (!body) return "";
  const lines = body.split("\n");
  const hits: Array<{ i: number; at: number }> = [];
  for (let i = 0; i < lines.length; i++) { const at = grepLineAt(lines[i], plan); if (at >= 0) hits.push({ i, at }); }
  if (hits.length === 0) return body.slice(0, SNIP_LINE_CHARS).replace(/\s+/g, " ").trim();
  const ctx = Math.max(0, Math.min(context, 3));
  const atOf = new Map(hits.map(({ i, at }) => [i, at] as const));
  const shown = hits.slice(0, SNIP_MAX_LINES);
  const out: string[] = [];
  const emitted = new Set<number>();
  let prev = -1;
  for (const { i } of shown) {
    const lo = Math.max(0, i - ctx), hi = Math.min(lines.length - 1, i + ctx);
    if (prev >= 0 && lo > prev + 1) out.push("  ⋯");
    for (let j = lo; j <= hi; j++) {
      if (emitted.has(j)) continue;
      emitted.add(j);
      out.push(`L${j + 1}: ${grepTrimLine(lines[j], atOf.get(j) ?? 0)}`);
    }
    prev = hi;
  }
  if (hits.length > shown.length) out.push(`(+${hits.length - shown.length} matches) → ${getHint}`);
  return out.join("\n");
}

const PREVIEW_CHARS = 160; // 식별용 본문 미리보기 길이(쿼리 grep 아님 — similar/벡터-only 매치는 매치 토큰이 없다)
export function previewBody(body: string): string { return body.slice(0, PREVIEW_CHARS).replace(/\s+/g, " ").trim(); }

// ── RRF(Reciprocal Rank Fusion) 상수 — 하이브리드 검색(벡터 ∪ 렉시컬)에서 공유. ──
export const RRF_K = 60;         // RRF 상수(Azure 기본). Σ 1/(k+rank) — 두 채널 모두 상위면 가산.
export const HYBRID_CANDIDATES = 50; // 각 채널(렉시컬·벡터) 후보 수 → 융합 후 limit 로 컷.

// ── 임베딩 provider 접근자 — config 가 켜졌을 때만 provider, off(기본)면 null. org_runtime_config.embedding_config 직접 읽음(무순환). ──
//  off → null → 쓰기·검색 모두 no-op/렉시컬 폴백. 지식·프로젝트 스토어가 공유. 설계 [[vector-search-172-design-pluggable-seam-oss]].
export async function activeEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  try {
    const r = await one(itemsPool, `SELECT embedding_config FROM org_runtime_config WHERE id=1`);
    return resolveEmbeddingProvider(resolveEmbeddingConfig((r as { embedding_config?: unknown } | undefined)?.embedding_config));
  } catch {
    return null; // 설정 못 읽으면 안전하게 off
  }
}

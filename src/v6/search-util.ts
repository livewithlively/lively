// 검색 공용 유틸 — grep 매처(정규식/토큰 AND)·스니펫 빌더·RRF 상수·임베딩 provider 접근자.
//  knowledge(#172)·project(#631)가 공유한다. 컬럼/테이블 불가지론(cols 인자·target 파라미터) — 특정 엔티티에 묶이지 않는다.
//  · grep 매처/스니펫은 순수(DB 불요) → 유닛테스트 가능(search-util.test.ts).
//  · activeEmbeddingProvider 만 DB(org_runtime_config)를 읽는다(무순환: embedding-provider 는 store 미import 유지 → 여기로 뺀다).
import { itemsPool } from "../db/client.js";
import { one } from "../db/client.js";
import { type EmbeddingProvider, resolveEmbeddingConfig, resolveEmbeddingProvider } from "./embedding-provider.js";
import { type QueryTerm, parseQueryTerms, termPatterns } from "./query-terms.js";

// ── grep 매처 — Claude Code(ripgrep) 직관에 맞춘 텍스트 매칭. "search"(의미검색)가 아니라 grep이다.
//  · 정규식 메타문자가 있고 유효한 패턴이면 → POSIX 정규식(`~*`, 대소문자 무시)으로 grep. 예: `벡터|vector`, `task_\w+`.
//  · 그 외(평문)면 → 공백으로 나눈 모든 토큰이 (어느 컬럼이든) 등장해야 매치(AND, 부분일치). 단일 토큰이면 단순 contains.
//  · LIKE 와일드카드(`%`/`_`)는 평문 토큰에서 리터럴로 이스케이프(grep 패리티 — `knowledge_x` 의 `_` 가 와일드카드로 새지 않게).
const REGEX_META = /[.*+?^${}()|[\]\\]/;
export function likeEscape(s: string): string { return s.replace(/[\\%_]/g, "\\$&"); }   // 대화 검색(v6/conv-index-store.ts)도 같은 이스케이프를 쓴다
export type GrepPlan =
  | { mode: "regex"; pattern: string; re: RegExp }
  | { mode: "tokens"; tokens: string[] }
  //  plain(#4530) — 화면 검색(⌘K)이 사람이 친 글을 **글자 그대로** 찾는 모드. 정규식으로 읽지 않는다(«통합검색(⌘K)» 의 괄호가
  //   묶음이 되어 0건이던 것) · 낱말마다 «친 그대로 OR 조사를 뗀 꼴» 이 맞으면 맞음(«검색을» 이 «검색» 만 든 글과 맞는다) ·
  //   큰따옴표 구절은 통째로. 규칙 정본은 query-terms.ts. 에이전트 grep(knowledge_grep/project_grep)은 plain 을 줄 때만 이 모드다.
  | { mode: "plain"; terms: QueryTerm[] };
/** 화면용 글 그대로 계획(#4530) — 낱말이 하나도 안 나오면(공백뿐) 원문 한 덩어리를 그대로 찾는다. */
export function parsePlainGrep(qstr: string): GrepPlan {
  const terms = parseQueryTerms(qstr);
  if (terms.length) return { mode: "plain", terms };
  const t = String(qstr ?? "").trim().toLowerCase();
  return { mode: "plain", terms: [{ t, stem: t, quoted: false }] };
}
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

/**
 * 정확일치를 **정렬 맨 앞**에 세우는 ORDER BY 머리(뒤에 콤마까지 붙여 준다) — 아니면 "".
 *
 * 왜 WHERE 에 얹는 것(idEquals)만으로 모자란가 — 렉시컬 채널은 `updated_at DESC LIMIT n` 으로 자른다.
 * 번호가 맞은 행도 그 줄에 같이 서므로, 그 번호를 본문에 **인용한** 더 최근 행이 n 개를 넘으면 정작
 * 그 번호의 주인이 잘려 나간다(실측 2026-09-22: `2600` 으로 찾으면 #2600 을 언급한 태스크 8건만 오고
 * #2600 은 안 왔다). 지목한 것이 맞았으면 그건 검색이 아니라 호명이다 — 자르기 전에 맨 앞에 둔다.
 * kind='id' 는 idEquals 와 같은 규약(정수 · `#` 벗김), kind='name' 은 한 토큰 그대로(소문자) 정확일치.
 */
export function exactFirst(col: string, q: string, kind: "id" | "name", params: unknown[]): string {
  const t = String(q ?? "").trim();
  if (!t || /\s/.test(t)) return "";
  if (kind === "id") {
    const probe: unknown[] = [];
    if (!idEquals(col, t, probe)) return "";
    params.push(probe[0]);
  } else {
    params.push(t.toLowerCase());
  }
  return `(${col} = $${params.length}) DESC NULLS LAST, `;
}

// cols 중 어느 하나에 매치(OR). regex 는 패턴 1개, tokens 는 토큰마다 (cols OR) 를 AND 로 묶는다. params 에 push 하고 WHERE 절 문자열 반환.
export function grepWhere(cols: string[], plan: GrepPlan, params: unknown[]): string {
  const colsOr = (placeholder: string) => "(" + cols.map((c) => `${c} ${placeholder}`).join(" OR ") + ")";
  if (plan.mode === "regex") {
    params.push(plan.pattern);
    return colsOr(`~* $${params.length}`);
  }
  if (plan.mode === "plain") {
    //  낱말마다 «그대로 OR 조사 뗀 꼴» 을 컬럼 어디서든(OR) — 낱말끼리는 AND.
    return plan.terms.map((term) => "(" + termPatterns(term).map((pat) => { params.push(pat); return colsOr(`ILIKE $${params.length} ESCAPE '\\'`); }).join(" OR ") + ")").join(" AND ");
  }
  return plan.tokens.map((tok) => { params.push(`%${likeEscape(tok)}%`); return colsOr(`ILIKE $${params.length} ESCAPE '\\'`); }).join(" AND ");
}

/**
 * 제목(이름)에 모든 낱말이 든 것을 **글자 검색 정렬의 앞**에 세우는 ORDER BY 머리(콤마까지) — #4530.
 *
 * 왜 — 렉시컬 채널은 `updated_at DESC LIMIT n` 으로 자른다. 그래서 본문에 그 낱말이 한 번 스친 **최근** 문서들이 n 칸을 채우면
 *  제목이 곧 그 낱말인 문서가 잘렸다(실측 2026-10-01: 제목에 «배포» 가 든 지식이 139개인데 grep 8칸은 본문만 스친 최근 문서였다 ·
 *  «새 작업» 이 이름인 프로젝트 대신 본문에 그 말이 든 «UI 버그 해결» 이 1위). 같은 술어를 RRF 의 렉시컬 순위에도 쓴다.
 * col 은 NULL 일 수 있다(지식 title) — COALESCE 로 빈 글로 본다. 매처는 그 계획의 것(regex 는 같은 패턴 · tokens/plain 은 낱말 AND).
 */
export function titleFirst(col: string, plan: GrepPlan, params: unknown[]): string {
  const c = `COALESCE(${col}, '')`;
  let pred: string;
  if (plan.mode === "regex") { params.push(plan.pattern); pred = `${c} ~* $${params.length}`; }
  else if (plan.mode === "plain") {
    pred = plan.terms.map((term) => "(" + termPatterns(term).map((pat) => { params.push(pat); return `${c} ILIKE $${params.length} ESCAPE '\\'`; }).join(" OR ") + ")").join(" AND ");
  } else {
    pred = plan.tokens.map((tok) => { params.push(`%${likeEscape(tok)}%`); return `${c} ILIKE $${params.length} ESCAPE '\\'`; }).join(" AND ");
  }
  return `(${pred}) DESC, `;
}
// regex→token 폴백 공통화: plan 으로 쿼리하되 POSIX 가 정규식을 거부하면(JS 유효·POSIX 무효 드묾) 토큰모드로 1회 재시도 — 에이전트에 에러 누출 안 함.
export async function grepExec<T>(qstr: string, runWithPlan: (plan: GrepPlan) => Promise<T>, opts: { plain?: boolean } = {}): Promise<{ result: T; plan: GrepPlan }> {
  //  plain(#4530) 은 정규식이 없으니 폴백도 없다 — 실패는 진짜 에러다.
  if (opts.plain) { const p = parsePlainGrep(qstr); return { result: await runWithPlan(p), plan: p }; }
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
  if (plan.mode === "plain") {
    for (const term of plan.terms) {
      for (const w of term.stem !== term.t && term.stem.length >= 2 ? [term.t, term.stem] : [term.t]) {
        const i = w ? lower.indexOf(w) : -1;
        if (i >= 0 && (at < 0 || i < at)) at = i;
      }
    }
    return at;
  }
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
  return (await activeEmbedding())?.provider ?? null;
}
/** provider + 그 설정의 열쇠(질의 임베딩 기억의 열쇠 — 모델·차원·주소가 바뀌면 옛 벡터를 쓰지 않는다). off 면 null. */
export async function activeEmbedding(): Promise<{ provider: EmbeddingProvider; key: string } | null> {
  try {
    const r = await one(itemsPool, `SELECT embedding_config FROM org_runtime_config WHERE id=1`);
    const cfg = resolveEmbeddingConfig((r as { embedding_config?: unknown } | undefined)?.embedding_config);
    const provider = resolveEmbeddingProvider(cfg);
    return provider ? { provider, key: [cfg.provider, cfg.base_url ?? "", cfg.model ?? "", cfg.dimensions].join("|") } : null;
  } catch {
    return null; // 설정 못 읽으면 안전하게 off
  }
}

// ── 질의 임베딩 — 한 번만 · 짧게 기다린다 (#4530) ─────────────────────────────────────────────────
//  화면 검색(⌘K)은 글자를 칠 때마다 같은 질의를 지식·프로젝트의 의미검색·유사검색 네 곳에 동시에 던진다. 종전엔 네 곳이 각자
//  provider.embed 를 불러 **같은 글을 네 번** 임베딩했고, 기억이 없어 다시 쳐도 또 불렀다(2026-10-01 점검 46번).
//  게다가 질의도 백필과 같은 시간 상한(기본 300초)을 탔다 — 임베딩 백엔드가 느리면 검색 요청이 몇 분씩 매달렸다(42번).
//  그래서 질의 임베딩은 이 한 자리를 지난다:
//   · 같은 (설정 열쇠 · 글) 이면 10분 동안 기억한다(최근 256개). 실패는 기억하지 않는다.
//   · 같은 글이 동시에 오면 진행 중인 요청 하나를 나눠 쓴다.
//   · 질의는 20초만 기다린다(백필 상한 300초와 별개). 넘으면 «실패» 로 답하되 진행 중인 요청은 끊지 않는다 — 늦게라도 오면 기억해
//     둬서 다음 글자에 바로 쓴다. 6초로 두었다가 20초로 늘렸다(격리 리뷰): 이 상한은 화면만이 아니라 에이전트의 knowledge_similar ·
//     의미검색(rrf)도 탄다 — 느린 CPU 백엔드(셀프호스트)에서 첫 호출이 늘 «실패» 가 되면 안 된다. 화면(⌘K)은 이 상한과 무관하게
//     1.2초만 기다리고 늦은 결과를 제자리에 끼우므로 체감 속도는 이 값에 매이지 않는다.
//   · ⚠ 기억의 열쇠에 테넌트를 넣지 않는다 — 열쇠가 (provider · base_url · model · 차원 · 글) 이고, 같은 모델·같은 글이면 벡터가
//     같다(결정적). 한 테넌트의 기억이 다른 테넌트에 쓰여도 그 테넌트가 스스로 받았을 값과 같아 새는 것이 없다. 같은 주소·같은 모델
//     이름 뒤에 다른 모델을 두는 구성은 지원하지 않는다(그럴 땐 model 이름을 달리 적는다).
//  status: ok(벡터 있음) · off(임베딩 꺼짐) · failed(꺼진 건 아닌데 이번엔 못 얻었다 — 화면은 «없음» 과 다르게 말한다).
export type QueryEmbed = { vec: number[] | null; status: "ok" | "off" | "failed" };
export const QUERY_EMBED_TTL_MS = 10 * 60_000;
export const QUERY_EMBED_MAX = 256;
export const QUERY_EMBED_TIMEOUT_MS = 20_000;
const qeCache = new Map<string, { vec: number[]; at: number }>();
const qeInflight = new Map<string, Promise<number[] | null>>();
function qeRemember(key: string, vec: number[], nowMs: number): void {
  qeCache.delete(key);
  qeCache.set(key, { vec, at: nowMs });
  while (qeCache.size > QUERY_EMBED_MAX) { const oldest = qeCache.keys().next().value; if (oldest === undefined) break; qeCache.delete(oldest); }
}
/** 시험 전용 — 기억을 비운다. */
export function __resetQueryEmbedCache(): void { qeCache.clear(); qeInflight.clear(); }
export async function embedQuery(
  text: string,
  opts: { timeoutMs?: number; now?: () => number; source?: () => Promise<{ provider: EmbeddingProvider; key: string } | null> } = {},
): Promise<QueryEmbed> {
  const act = await (opts.source ?? activeEmbedding)();
  if (!act) return { vec: null, status: "off" };
  const t = String(text ?? "").slice(0, 8000);
  if (!t.trim()) return { vec: null, status: "failed" };
  const now = opts.now ?? Date.now;
  const key = act.key + "\u0001" + t;
  const hit = qeCache.get(key);
  if (hit && now() - hit.at < QUERY_EMBED_TTL_MS) { qeRemember(key, hit.vec, hit.at); return { vec: hit.vec, status: "ok" }; }
  let p = qeInflight.get(key);
  if (!p) {
    p = act.provider.embed([t])
      .then(([v]) => (Array.isArray(v) && v.length ? v : null), () => null)
      .then((v) => { if (v) qeRemember(key, v, now()); return v; })
      .finally(() => { qeInflight.delete(key); });
    qeInflight.set(key, p);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), opts.timeoutMs ?? QUERY_EMBED_TIMEOUT_MS); });
  try {
    const v = await Promise.race([p, timeout]);
    if (v === "timeout" || !v) return { vec: null, status: "failed" };
    return { vec: v, status: "ok" };
  } finally { if (timer) clearTimeout(timer); }
}

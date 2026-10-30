// v6/knowledge-lex.ts — 지식 낱말 색인의 규칙 한 벌(#5201 · 프로젝트 #5198). 글을 낱말로 나누고, 그 낱말로 BM25 점수를 내는 SQL 을 만든다.
//
//  ── 왜 앱에서 낱말을 만드나 ──
//   매니지드 RDS 에는 BM25 확장(pg_search · pg_textsearch)이 없고 내장 전문검색에는 한국어 설정이 없다. 구축형과 매니지드를 한 코드로 묶는
//   길은 앱이 낱말을 만들어 일반 표에 넣는 것뿐이다. 내장 ts_rank 는 드문 낱말의 무게(IDF)가 없어 BM25 를 대신하지 못한다(측정: 지식
//   research-1617-chunk-search-combination-2026-10-31).
//
//  ── 낱말 규칙(측정한 조합 그대로 — 바꾸면 다시 잰다) ──
//   · 영문·숫자 덩어리는 통째로 하나, 그 조각(`_ . - /` 와 낙타 표기로 나눈 것)도 각각 하나다. `src/v6/knowledge-store.ts` 는 store 로도 찾힌다.
//   · 한글 어절은 끝의 조사를 한 번 뗀 꼴 하나다(규칙은 화면 검색과 같은 stemKo).
//   · 그 밖의 글자(가나 · 한자 · 악센트 문자)는 덩어리째 하나다. 측정 코퍼스에는 거의 없지만 빼면 그 글자로는 낱말 채널이 아무것도 못 찾는다. 한글 자모는 뺀다.
//   판정 200+200 질의에서 조사 떼기는 형태소 분석(Kiwi)과 구간이 겹치거나 앞섰고, 의존성이 없다. 한 글자 낱말을 빼도 나아지지 않아 그대로 둔다.
//
//  순수 모듈이다(DB 무접촉). 색인 쓰기는 knowledge-lex-store.ts, 검색은 knowledge-search.ts 가 쓴다.
import { TENANT_DEFAULT_EXPR } from "../db/tenant-column.js";
import { stemKo } from "./query-terms.js";

const ASCII_RUN = /[A-Za-z0-9_][A-Za-z0-9_.\-/]*[A-Za-z0-9_]|[A-Za-z0-9_]/g;
const HANGUL_RUN = /[가-힣]+/g;
//  영문·숫자·한글을 뺀 나머지 글자 덩어리. 한글 자모는 뺀다 — «ㅇㅇ» · «ㄱㄱ» 는 드문 낱말이라 무게가 커서 대화체 질의의 1위를 뒤집는다(측정 규칙에도 없다).
const OTHER_RUN = /(?:(?![A-Za-z0-9_\p{Script=Hangul}])[\p{L}\p{M}])+/gu;
const PART_SPLIT = /[_.\-/]+/;
const CAMEL_SPLIT = /(?<=[a-z0-9])(?=[A-Z])/;

/**
 * 낱말 규칙의 판 — **규칙이 바뀌면 올린다**(이 파일의 규칙 · query-terms.ts 의 stemKo). 스윕이 옛 판으로 색인한 문서를 다시 만든다.
 *  안 올리면 색인은 옛 낱말, 질의는 새 낱말이라 조용히 안 맞는다.
 */
export const LEX_RULES_VERSION = 1;
/** 한 낱말 길이 상한 — 넘는 덩어리는 통째 낱말로 넣지 않는다(조각은 넣는다). 긴 주소 · 부호화 글이 색인을 부풀리고 B-tree 칸 상한을 넘지 않게. */
export const LEX_TERM_MAX = 64;
/**
 * 한 질의가 쓰는 낱말 상한(앞에서부터) — 긴 글을 붙여 넣어도 질의 하나가 색인 절반을 훑지 않게.
 *  사람 프롬프트 판정 200개(낱말 수 p90 187)에서 256개 대비 앞 32개의 nDCG@5 차이 구간이 0을 포함했다(BM25 [-0.002,+0.017] · 조각+BM25 [-0.010,+0.007]).
 */
export const LEX_QUERY_TERMS_MAX = 32;
/** 질의로 읽는 글자 상한 — q 는 길이 제한이 없다(MCP 입력 검증에서 튕기면 호출 기록이 안 남아 핸들러 쪽에서 자른다). 질의 임베딩과 같은 값이다. */
export const LEX_QUERY_CHARS_MAX = 8000;

/** 글 → 낱말(겹침 그대로 · 빈도를 세려면 그대로 쓴다). 소문자 · NFC 다. */
export function lexTokens(text: string): string[] {
  const t = String(text ?? "").normalize("NFC");
  const out: string[] = [];
  for (const m of t.matchAll(ASCII_RUN)) {
    const whole = m[0].toLowerCase();
    if (whole.length <= LEX_TERM_MAX) out.push(whole);
    for (const piece of m[0].split(PART_SPLIT)) {
      for (const part of piece.split(CAMEL_SPLIT)) {
        const p = part.toLowerCase();
        if (p && p !== whole && p.length <= LEX_TERM_MAX) out.push(p);
      }
    }
  }
  for (const m of t.matchAll(HANGUL_RUN)) {
    const w = stemKo(m[0]);
    if (w.length <= LEX_TERM_MAX) out.push(w);
  }
  for (const m of t.matchAll(OTHER_RUN)) {
    const w = m[0].toLowerCase();
    if (w.length <= LEX_TERM_MAX) out.push(w);
  }
  return out;
}

/** 지식 한 건이 색인에 들어가는 글 — 이름 · 제목 · 본문(이름은 사람이 옮겨 적는 열쇠라 빠지면 정확한 이름으로 못 찾는다). */
export function lexDocText(d: { name: string; title?: string | null; body_md?: string | null }): string {
  return `${d.name}\n${d.title ?? ""}\n${d.body_md ?? ""}`;
}

/** 낱말 → 빈도. */
export function lexTermFreq(tokens: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** 질의 → 낱말(겹침 없음 · 상한까지). 낱말이 하나도 안 나오면 빈 배열이다. */
export function lexQueryTerms(q: string): string[] {
  return [...new Set(lexTokens(String(q ?? "").slice(0, LEX_QUERY_CHARS_MAX)))].slice(0, LEX_QUERY_TERMS_MAX);
}

/**
 * 질의에 식별자(이슈 번호 · 파일 · 경로 · 뱀 · 낙타 표기 · 해시 · 상수)가 있나.
 *
 *  식별자 질의는 **섞지 않고 낱말 채널만 쓴다** — 뜻 벡터는 식별자를 못 찾는데(정답 문서 상위 10 적중 0.23) RRF 는 두 채널을 같은 무게로 합해
 *  못 찾는 쪽이 순위를 밀어낸다(식별자 200개 MRR: 섞으면 0.55, 낱말만 0.90). 에이전트 검색어 200개 판정에서도 분기한 쪽이 높았다(nDCG@5 +0.006~+0.037).
 */
//  ⚠ 파일 갈래 앞의 뒤돌아보기를 빼지 마라 — 없으면 영문 덩어리의 모든 시작 위치에서 끝까지 먹고 되돌아와 길이의 제곱이 된다(80K자 3.4초 · 이벤트 루프가 멈춘다).
const IDENTIFIER_RE = /#\d{2,}|(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+\.[a-z]{1,5}\b|\/[A-Za-z0-9_.-]+\/|\b[a-z]+_[a-z0-9_]+\b|\b[a-z]+[A-Z][a-zA-Z0-9]+\b|\b[0-9a-f]{7,40}\b|\b[A-Z][A-Z0-9_]{3,}\b/;
export function hasIdentifier(q: string): boolean {
  return IDENTIFIER_RE.test(String(q ?? "").slice(0, LEX_QUERY_CHARS_MAX));
}

//  BM25 상수 — 표준값 그대로 측정했다(k1=1.2 · b=0.75).
const K1 = 1.2;
const B = 0.75;

/**
 * BM25 점수를 내는 CTE 묶음(lv · lp · ls · ldf · bm). 마지막 `bm` 이 (name, score)다 — 낱말이 하나라도 맞은 문서만 나온다.
 *  WITH 뒤에 그대로 이어 붙인다. 수명 · 거르기는 호출부가 knowledge 와 이어 건다.
 *
 *  ⚠ vis(공개범위 술어 — knowledgeVisWhere, 별칭 k)를 **통계까지** 건다. 문서 수 · 평균 길이 · 낱말 빈도에 볼 수 없는 문서가 들어가면 그 사람이 받는 순서와 점수가
 *   «숨은 문서에 이 낱말이 있다» 에 따라 달라진다 — 공개 문서 둘을 잣대로 낱말 존재를 한 비트씩 물을 수 있다(격리 리뷰 재현). «그 단어가 든 문서가 3건 있다»
 *   는 것 자체가 새는 정보라 건수에 공개범위를 건 것(countKnowledgeGrep)과 같은 까닭이다. 그래서 통계는 사람마다 다르다.
 *  ⚠ tenant_id 를 직접 적는 까닭 — 표의 기본키가 (tenant_id, term, doc_id) 라 앞 칸을 주어야 인덱스를 탄다. 행 보안이 없는 단일 테넌트 배포에서도 같다.
 */
export function bm25Sql(terms: readonly string[], params: unknown[], vis: string): string {
  params.push([...terms]);
  const tp = `$${params.length}::text[]`;
  const docs = vis === "TRUE"
    ? `SELECT id, name, doc_len FROM knowledge_lex_doc WHERE tenant_id = ${TENANT_DEFAULT_EXPR}`
    : `SELECT d.id, d.name, d.doc_len FROM knowledge_lex_doc d JOIN knowledge k ON k.name = d.name WHERE d.tenant_id = ${TENANT_DEFAULT_EXPR} AND ${vis}`;
  return `lv AS MATERIALIZED (${docs}),
    lp AS MATERIALIZED (
      SELECT p.term, p.doc_id, p.tf FROM knowledge_lex_posting p JOIN lv ON lv.id = p.doc_id
       WHERE p.tenant_id = ${TENANT_DEFAULT_EXPR} AND p.term = ANY(${tp})
    ),
    ls AS (SELECT count(*)::float8 AS n, GREATEST(avg(doc_len), 1)::float8 AS avgdl FROM lv),
    ldf AS (SELECT term, count(*)::float8 AS df FROM lp GROUP BY term),
    bm AS (
      SELECT d.name,
             SUM(ln(1 + (s.n - f.df + 0.5) / (f.df + 0.5)) * p.tf * ${K1 + 1} / (p.tf + ${K1} * (1 - ${B} + ${B} * d.doc_len / s.avgdl)))::float8 AS score
        FROM lp p
        JOIN ldf f ON f.term = p.term
        JOIN lv d ON d.id = p.doc_id
       CROSS JOIN ls s
       GROUP BY d.name
    )`;
}

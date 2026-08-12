// 스키마 발견 실패를 정직한 안내로 바꾸는 힌트 조립(#1259) — 순수 모듈(라이브 스키마·DB 접속 불요).
//  배경(고객사 A 실박스 실측): table_default='deny' 소스에서 '존재하지 않는 테이블 이름'은 정책행이 없어
//  기본자세 deny 로 떨어지고 "허용되지 않은 테이블입니다(웹에서 허용 설정 필요)" 로 답했다 → 사용자·AI 가
//  오타를 권한 문제로 확신해 권한 확대 요청까지 에스컬레이션했다(example-ro 실패 177건 중 37건이 이 오진,
//  db 를 쓴 5명 전원이 밟음. 같은 뿌리인 'Unknown column' 37건·information_schema 차단 33건까지 60.5%).
//  → 여기서 '카탈로그에 없다'와 '정책상 차단'을 갈라 답하고, 유사 이름 후보를 제안한다.
//  ⚠ 후보는 allow 목록에서만 고른다 — deny 테이블을 후보에 넣으면 그 존재를 새로 노출하게 된다(통제 합의사항).
//  카탈로그 조회·캐시는 호출측(tools/db.ts)이 맡고, 이 모듈은 순수 함수와 문구 조립만 담당한다.

// 유사 후보는 '추측'이라는 걸 응답에 명시한다 — 이름이 비슷해도 전혀 다른 테이블일 수 있으므로,
//  후보를 그대로 믿고 쿼리를 짜지 말고 db_schema 로 컬럼을 확인하게 유도한다(맹신 방지).
export const SIMILAR_NAME_CAVEAT =
  "⚠ 후보는 이름 유사도만으로 고른 추측입니다 — 이름이 비슷해도 전혀 다른 테이블일 수 있습니다. " +
  "쓰기 전에 db_schema 로 컬럼을 확인하세요.";

function tokenize(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

// 편집거리 — 단어 내부 오타(글자 중복·누락·치환: knowledgee→knowledge)를 잡는다.
//  토큰 기반 신호로는 이 유형이 전혀 안 잡힌다(오타난 토큰은 다른 토큰이 되므로 교집합 0). 길이차가
//  크면 볼 필요 없으니 조기 포기(비용 상한).
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = cur;
  }
  return prev[b.length];
}

// 이름 유사도 — 신호 4개. 실측 실패 이름 14건 + 실 카탈로그 1133개로 ablation 해 '실제로 순위를 바꾸는'
//  신호만 남겼다(토큰 포함관계·접두일치 가점은 아래 셋과 중복이라 순위를 하나도 바꾸지 못해 뺐다).
//   · 공통 토큰 비율(Jaccard) — 주력. 빼면 14건 중 3건이 오답이 된다.
//   · 같은 말미 토큰 — i_repayment_deposit→b_repayment_deposit 처럼 접두만 틀린 경우의 결정타.
//   · 부분문자열 — 접두 규약 자체가 다른 경우(loan_→l_, p_bond→tb_lo_bond)를 구제.
//   · 편집거리 — **단어 내부 오타**. 위 세 신호는 '토큰이 남거나 빠진' 유형만 덮는다. 프리뷰 실환경
//     검증에서 knowledgee→knowledge 가 후보 0건으로 나와 이 유형이 별도 신호를 요구함이 드러났다
//     (대칭 부분문자열로도 시도했으나 d_deal_seq 가 깨지고 오타는 2/4 만 잡혀 편집거리를 택했다).
function similarity(query: string, candidate: string): number {
  const qt = tokenize(query);
  const ct = tokenize(candidate);
  if (qt.length === 0 || ct.length === 0) return 0;
  const qs = new Set(qt);
  const cs = new Set(ct);
  let inter = 0;
  for (const t of cs) if (qs.has(t)) inter++;
  let score = 0;
  if (inter > 0) {
    score += inter / (qs.size + cs.size - inter);
    if (qt[qt.length - 1] === ct[ct.length - 1]) score += 0.15;
  }
  const ql = query.toLowerCase();
  const cj = candidate.toLowerCase();
  // 3자 이하 토큰(d/tb/seq…)은 어디에나 있어 부분문자열 신호로 쓰면 무관한 이름이 쏟아진다 → 4자부터.
  if (qt.some((t) => t.length >= 4 && cj.includes(t))) score += 0.4;
  if (editDistance(ql, cj) <= 2) score += 0.6;
  return score;
}

// 이하는 후보로 내지 않는다 — 무관한 이름을 나열하면 오히려 오도한다(공통 토큰이 없으면 0점이라 여기서 걸린다).
const SIMILARITY_THRESHOLD = 0.45;

/**
 * query 와 이름이 유사한 후보를 점수순으로 돌려준다(자기 자신 제외, 임계 미달 제외).
 *  candidates 는 '조회가 허용된' 이름만 넘겨라 — deny 테이블의 존재를 노출하지 않기 위한 호출측 계약이다.
 */
export function suggestSimilarNames(query: string, candidates: readonly string[], limit = 5): string[] {
  const ql = query.toLowerCase();
  const scored: Array<{ name: string; score: number }> = [];
  for (const c of candidates) {
    if (c.toLowerCase() === ql) continue;
    const score = similarity(query, c);
    if (score >= SIMILARITY_THRESHOLD) scored.push({ name: c, score });
  }
  // 동점이면 짧은 이름 우선(군더더기 없는 쪽이 정답일 확률이 높다) → 이름순으로 결정론화.
  scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}

/** 카탈로그에 없는 테이블 — '권한 없음'이 아니라 '없음'이라고 답한다(+ 유사 후보 · 확인 경로). */
export function formatUnknownTable(source: string, table: string, suggestions: readonly string[]): string {
  const head = `Unknown table: ${table} — 소스 '${source}' 에 그런 테이블이 없습니다(권한 문제가 아닙니다).`;
  const lookup = `db_schema({source:'${source}', match:'<이름 일부>'}) 로 실제 이름을 확인하세요.`;
  if (suggestions.length === 0) return `${head} ${lookup}`;
  return `${head} 이름이 비슷한 테이블: ${suggestions.join(", ")}. ${SIMILAR_NAME_CAVEAT} 전체 목록은 ${lookup}`;
}

// 엔진별 '없는 컬럼' 에러에서 컬럼명을 뽑는다 — mysql: Unknown column 'x' in 'where clause' /
//  pg: column "x" does not exist · column t.x does not exist(수식이면 마지막 조각).
//  감사로그의 정규화된 형태('?')는 컬럼명이 아니므로 걸러낸다.
export function extractUnknownColumn(message: string): string | null {
  const m =
    /Unknown column '([^']+)'/i.exec(message) ??
    /column "([^"]+)" does not exist/i.exec(message) ??
    /column ([A-Za-z0-9_.]+) does not exist/i.exec(message);
  if (!m) return null;
  const raw = m[1].split(".").pop() ?? "";
  if (raw.length === 0 || raw === "?") return null;
  return raw;
}

/**
 * db_schema 목록의 이름 필터(#1259) — 공백으로 나눈 토큰을 **전부** 포함하는 이름만(AND, 대소문자 무시).
 *  테이블이 1000개대인 소스에서 전량 덤프는 실용적이지 않아 에이전트가 목록 조회를 회피하고 이름을
 *  추측하게 됐다(실측 원인). 빈 패턴은 필터하지 않는다(후방호환 — 종전처럼 전체 목록).
 */
export function filterTableNames(names: readonly string[], match: string | undefined): string[] {
  // 토큰이 없으면 every 가 전부 true → 자연히 전체 목록이 된다(별도 분기 불요).
  const terms = String(match ?? "").toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  return names.filter((n) => {
    const nl = n.toLowerCase();
    return terms.every((t) => nl.includes(t));
  });
}

const COLUMN_LIST_FULL_MAX = 12; // 이 이하면 전부 보여주는 게 가장 빠르다(실측: 막힌 테이블은 컬럼이 2개였다)

/**
 * '없는 컬럼' 에러에 그 쿼리가 참조한 테이블의 실제 컬럼을 실어준다 — 원인이 컬럼 이름임을 즉시 알 수 있게.
 *  columnsByTable 은 호출측이 카탈로그에서 채운다(참조 테이블만). 컬럼이 많으면 유사 후보로 좁힌다.
 */
export function annotateUnknownColumn(
  message: string,
  column: string,
  columnsByTable: ReadonlyMap<string, readonly string[]>,
): string {
  const parts: string[] = [];
  for (const [table, cols] of columnsByTable) {
    if (cols.length === 0) continue; // 카탈로그 조회가 빈 경우 — 알려줄 게 없다
    if (cols.some((c) => c.toLowerCase() === column.toLowerCase())) continue; // 이 테이블엔 있다 → 원인 아님
    if (cols.length <= COLUMN_LIST_FULL_MAX) {
      parts.push(`${table}: ${cols.join(", ")}`);
      continue;
    }
    const near = suggestSimilarNames(column, cols, 5);
    const shown = near.length > 0 ? near : cols.slice(0, COLUMN_LIST_FULL_MAX);
    parts.push(`${table}: ${shown.join(", ")} (전체 ${cols.length}개 — db_schema({table:'${table}'}))`);
  }
  if (parts.length === 0) {
    // #1642 여기 닿는 두 경우 모두 **다음 행동**을 알려준다 — 종전엔 원문만 돌려줘 호출자가 무엇을 할지 몰랐다.
    //  ① 카탈로그에서 컬럼을 못 얻음(권한·스키마 밖·이름 불일치) → cols 가 비어 위 루프가 전부 continue
    //  ② 참조 테이블이 **전부** 그 컬럼을 가짐 → 원인이 컬럼 부재가 아니라 **별칭 오해**다
    //     (실측 예: `SELECT x.amount … FROM d_charged_principal x` 의 x 가 가리키는 테이블이 딴 것)
    //  실측(고객사 40일): 컬럼오류 201건 중 41건이 이 자리에서 아무 안내 없이 원문만 받았다.
    const tables = [...columnsByTable.keys()];
    if (tables.length === 0) return message; // 참조 테이블조차 모르면 보탤 게 없다(원인을 삼키지 않는다)
    return `${message} — 참조한 테이블의 컬럼을 확인하세요: ${
      tables.map((t) => `db_schema({table:'${t}'})`).join(" · ")
    }. 별칭을 썼다면 그 별칭이 가리키는 테이블이 맞는지도 함께 보세요.`;
  }
  return `${message} — 참조한 테이블의 실제 컬럼 → ${parts.join(" / ")}`;
}

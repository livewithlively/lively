// 내 라이블리 사용 내역 데이터 접근(#1570) — 대시보드 위젯 '내 라이블리 사용 내역'이 소비하는 집계.
//  기존 tool-usage-store(#318, admin·툴별 호출 수)와 **같은 원천(mcp_call_log)을 쓰지만 질문이 다르다** —
//  그쪽은 "어떤 툴이 몇 번 불렸나"(운영 통계), 이쪽은 "**나에게 무슨 이득이 됐나**"(개인 서사).
//  #318 화면이 이미 있는데도 효용 체감이 0이었던 이유가 그 차이라, 집계 단위를 사람이 읽는 사건으로 잡는다.
//
//  ── 무엇을 '라이블리만 하는 일'로 세는가 ──
//   세션 안: 조직 지식 본문 열람(knowledge_get) · 조직 DB 조회(db_access_log) · 프로젝트 맥락 적재 ·
//            하네스를 넘나든 연속 작업(mcp_call_log.harness).
//   세션 밖: 커넥터 수집 실행 · 증류 · 자동 분류 · 내가 남긴 지식이 **남의 세션**에서 회수된 것.
//  ⚠ 회수(훅 자동주입)는 여기 안 잡힌다 — 훅은 REST(/api/ui/knowledge/similar)를 부르는데 logToolCall 은
//   server.ts 의 MCP registerTool wrap 에서만 돈다(REST 미기록). 그래서 이 집계의 '열람'은 **모델이 본문을
//   실제로 연 것**(knowledge_get)만이다. 주입됐지만 안 쓴 것은 애초에 데이터가 없어 과대계상되지 않는다.
//  ⚠ mcp_call_log 에 session_id 가 없다 — '이 세션에서'가 아니라 '이 기간에'로만 묶인다(#1570 후속 과제).
//  ⚠ 보관 정책(#1082, 기본 90일)이 이 표의 상한이다 — 그보다 긴 창은 값이 비어 보인다.
import { itemsPool } from "../db/client.js";
import { CANONICAL_HARNESS_IDS } from "./auth/agent-identity.js";

// 조회 필터 — interval=postgres interval 문자열(null=전체), actor=사람 축 식별자(mcp_call_log.actor).
//  ⚠ actor 는 '그 세션을 만든 사람'이 아니라 **게이트웨이에 접속한 토큰의 신원**이다. 공용 박스에서 도는
//   AI 세션은 그 박스 계정 하나로 전부 찍힌다(실측 2026-08-07: 이 게이트웨이 30일 8,519건 전량 단일 actor).
//   그래서 다른 계정으로 보면 텅 빌 수 있다. '팀 전체' 범위 전환을 넣었다가 반려됐다(사용자 결정 —
//   빈 이유를 설명하는 문구도 원치 않음). 지금은 항상 본인 것만이다.
export interface LivelyLogFilter {
  interval: string | null;
  actor: string;
}

const p = (f: LivelyLogFilter): unknown[] => [f.interval, f.actor];
const byActor = (col = "actor") => `${col} = $2`;

// 기간 조건 — 두 표가 시각 컬럼 이름이 달라(mcp_call_log.called_at / db_access_log.at) 인자로 받는다.
const inWindow = (col: string) => `($1::text IS NULL OR ${col} >= now() - $1::interval)`;

export interface LivelySummary {
  calls: number;          // 내 MCP 호출 전수
  tools: number;          // 서로 다른 툴 수
  knowledge_reads: number; // 조직 지식 본문 열람 횟수
  knowledge_titles: number; // 서로 다른 지식 수
  knowledge_saved: number;  // 내가 남긴 지식 수
  prev_knowledge_titles: number; // 직전 같은 길이 구간의 값(타일 증감 표시용, 전체 기간이면 0)
  prev_knowledge_saved: number;
  activities: number;       // 내가 기록한 작업 수
  harnesses: number;        // 내가 쓴 하네스 종류
  first_at: string | null;
  last_at: string | null;
}

// 요약 — 위젯 머리(브리핑 문장·타일)용. 전부 한 번의 스캔으로 뽑는다(FILTER 집계).
//  타일의 "지난주보다 +N" 을 위해 **직전 같은 길이 구간**(prev_*)도 같은 스캔에서 뽑는다 — WHERE 를 2×창으로
//  넓히고 FILTER 로 현재/직전을 가른다. 전체 기간(interval=null)이면 직전 구간이 정의되지 않아 prev_*=0.
export async function livelySummary(f: LivelyLogFilter): Promise<LivelySummary | undefined> {
  const CURR = `($1::text IS NULL OR called_at >= now() - $1::interval)`;
  const PREV = `($1::text IS NOT NULL AND called_at < now() - $1::interval)`;
  const r = await itemsPool.query(
    `SELECT count(*) FILTER (WHERE ${CURR})::int AS calls,
            count(DISTINCT tool) FILTER (WHERE ${CURR})::int AS tools,
            count(*) FILTER (WHERE ${CURR} AND tool = 'knowledge_get' AND ok)::int AS knowledge_reads,
            count(DISTINCT args->>'name') FILTER (WHERE ${CURR} AND tool = 'knowledge_get' AND ok)::int AS knowledge_titles,
            count(*) FILTER (WHERE ${CURR} AND tool = 'knowledge_save' AND ok)::int AS knowledge_saved,
            count(DISTINCT args->>'name') FILTER (WHERE ${PREV} AND tool = 'knowledge_get' AND ok)::int AS prev_knowledge_titles,
            count(*) FILTER (WHERE ${PREV} AND tool = 'knowledge_save' AND ok)::int AS prev_knowledge_saved,
            count(*) FILTER (WHERE ${CURR} AND tool = 'activity_log' AND ok)::int AS activities,
            count(DISTINCT harness) FILTER (WHERE ${CURR})::int AS harnesses,
            min(called_at) FILTER (WHERE ${CURR}) AS first_at,
            max(called_at) FILTER (WHERE ${CURR}) AS last_at
       FROM mcp_call_log
      WHERE ($1::text IS NULL OR called_at >= now() - ($1::interval * 2)) AND actor = $2`,
    p(f),
  );
  return r.rows[0];
}

// 유형별 구성 — 브리핑(A안)의 '활동 구성' 스택 바. 분류는 livelyEvents 와 같은 KIND_SQL 한 벌을 쓴다.
export async function livelyKindCounts(f: LivelyLogFilter): Promise<{ kind: string; calls: number }[]> {
  const r = await itemsPool.query(
    `SELECT ${KIND_SQL} AS kind, count(*)::int AS calls
       FROM mcp_call_log l
      WHERE ${inWindow("l.called_at")} AND ${byActor("l.actor")} AND l.tool NOT IN ('whoami','me')
      GROUP BY 1 ORDER BY calls DESC`,
    p(f),
  );
  return r.rows;
}

// ── ★ 본체: 시간순 작업 로그 ──────────────────────────────────────────────────────────────────
//  요구 원문(윤상민): "감사 기록을 쉬운 말로 보여주든 뭐든, 내가 최근에 작업하면서 라이블리가 어떤 작업을
//   했는지가 로그로 쭉 보이면 좋겠다." → 이 화면의 본체는 통계 요약이 아니라 **사건의 나열**이다.
//  번역(툴명 → 사람 말)은 화면 관심사라 web/dash/widget-lively-log.ts 가 한다. 여기서는 그 재료만 만든다:
//   시각 · 툴 · 분류(kind) · **대상 이름(label)** · 하네스 · 성공여부.
//  ⚠ label 은 args 에서 뽑되 **지식은 제목까지 조인**한다 — 소환키(name)는 사람이 읽는 이름이 아니다.
//  ⚠ 연속 중복 접기는 화면이 한다(같은 대상 반복 호출이 로그를 도배하므로). 여기서는 원본 순서를 지킨다.
export interface LivelyEvent {
  at: string;
  tool: string;
  kind: string;          // knowledge_read | knowledge_write | project | task | db | activity | infra | other
  label: string | null;  // 그 사건의 대상(지식 제목·프로젝트 이름·SQL 요약 …)
  ref: string | null;    // 대상이 실존 지식이면 그 소환키(name) — 화면이 #/k/<name> 링크를 건다
  harness: string | null;
  actor: string | null;
  ok: boolean;
}

// 툴 → 분류(kind). 화면이 색·아이콘을 고르고 필터 칩을 만드는 축이라 **SQL 에서 한 번에** 정한다
//  (프론트가 94종 툴 이름을 다시 파싱하면 규칙이 두 벌이 된다).
const KIND_SQL = `CASE
  WHEN l.tool IN ('knowledge_get','knowledge_search','knowledge_grep','knowledge_list','knowledge_graph') THEN 'knowledge_read'
  WHEN l.tool LIKE 'knowledge%' THEN 'knowledge_write'
  WHEN l.tool = 'activity_log' THEN 'activity'
  WHEN l.tool LIKE 'db_%' THEN 'db'
  WHEN l.tool LIKE 'task_%' THEN 'task'
  WHEN l.tool LIKE 'project%' THEN 'project'
  WHEN l.tool LIKE 'source%' OR l.tool LIKE 'category%' OR l.tool LIKE 'team%' THEN 'context'
  WHEN l.tool LIKE 'preview_env%' OR l.tool LIKE 'delegate%' OR l.tool LIKE 'workspace%'
       OR l.tool LIKE 'node%' OR l.tool LIKE 'session%' OR l.tool LIKE 'repo%' OR l.tool LIKE 'map_%' THEN 'infra'
  ELSE 'other' END`;

// args 에서 대상 이름 한 개 뽑기 — 툴마다 키가 달라 우선순위로 훑는다(없으면 null → 화면이 대상 없이 그린다).
//  ⚠ 값 전체를 넣지 않는다(로그가 본문 덤프가 되면 못 읽는다) — 화면 라벨로 쓸 만한 짧은 식별자만.
const LABEL_SQL = `COALESCE(
  k.title,                          -- 지식이면 제목(소환키가 아니라)
  l.args->>'name', l.args->>'title', l.args->>'key', l.args->>'id',
  l.args->>'text', l.args->>'q', l.args->>'query', l.args->>'pattern',
  l.args->>'summary', l.args->>'repo', l.args->>'source')`;

export async function livelyEvents(f: LivelyLogFilter, limit = 120, offset = 0): Promise<LivelyEvent[]> {
  const r = await itemsPool.query(
    `SELECT l.called_at AS at, l.tool, ${KIND_SQL} AS kind,
            left(${LABEL_SQL}, 200) AS label,
            k.name AS ref,
            l.harness, l.actor, l.ok
       FROM mcp_call_log l
       LEFT JOIN knowledge k ON k.name = l.args->>'name'
      WHERE ${inWindow("l.called_at")} AND ${byActor("l.actor")}
        AND l.tool NOT IN ('whoami','me')          -- 신원 확인은 사건이 아니라 배관이다
      ORDER BY l.called_at DESC
      LIMIT ${Number(limit) || 120} OFFSET ${Number(offset) || 0}`,
    p(f),
  );
  return r.rows;
}

// 로그 전체 건수(더보기 버튼이 '남았는지'를 알아야 한다).
export async function livelyEventCount(f: LivelyLogFilter): Promise<number> {
  const r = await itemsPool.query(
    `SELECT count(*)::int AS n FROM mcp_call_log l
      WHERE ${inWindow("l.called_at")} AND ${byActor("l.actor")} AND l.tool NOT IN ('whoami','me')`,
    p(f),
  );
  return Number(r.rows[0]?.n || 0);
}

export interface PendingSavedRow { name: string; title: string | null; updated_at: string }

// 새로 남긴 지식 중 **검토 대기**(lifecycle=pending) — pending 은 승인 전까지 검색·세션주입에서 격리되므로,
//  '남겼다'가 아직 '팀이 쓸 수 있다'가 아니다. 그 간극을 타일에서 바로 보이게 한다(#1570 후속 요청).
//  판정은 knowledge_save 호출 로그 × knowledge.lifecycle 현재값 — 이 기간에 내가 저장했고 지금도 pending 인 것.
export async function livelyPendingSaved(f: LivelyLogFilter, limit = 20): Promise<PendingSavedRow[]> {
  const r = await itemsPool.query(
    `SELECT DISTINCT k.name, k.title, k.updated_at
       FROM mcp_call_log l
       JOIN knowledge k ON k.name = l.args->>'name'
      WHERE ${inWindow("l.called_at")} AND ${byActor("l.actor")}
        AND l.tool = 'knowledge_save' AND l.ok AND k.lifecycle = 'pending'
      ORDER BY k.updated_at DESC
      LIMIT ${Number(limit) || 20}`,
    p(f),
  );
  return r.rows;
}

export interface KnowledgeReadRow {
  name: string; title: string | null; reads: number; author: string | null; last_at: string;
}

// ① 내가 근거로 쓴 조직 지식 — knowledge_get 의 args->>'name' 을 knowledge 로 조인해 제목·저자를 붙인다.
//  지워진 지식(조인 실패)도 남긴다 — 그때 실제로 읽었다는 사실은 유효하므로 title 만 null 로 둔다.
export async function livelyKnowledgeReads(f: LivelyLogFilter, limit = 8): Promise<KnowledgeReadRow[]> {
  const r = await itemsPool.query(
    `SELECT l.args->>'name' AS name,
            k.title,
            COALESCE(k.updated_by, k.author) AS author,
            count(*)::int AS reads,
            max(l.called_at) AS last_at
       FROM mcp_call_log l
       LEFT JOIN knowledge k ON k.name = l.args->>'name'
      WHERE ${inWindow("l.called_at")} AND l.actor = $2
        AND l.tool = 'knowledge_get' AND l.ok AND l.args->>'name' IS NOT NULL
      GROUP BY 1, 2, 3
      ORDER BY reads DESC, last_at DESC
      LIMIT ${Number(limit) || 8}`,
    p(f),
  );
  return r.rows;
}

export interface KnowledgeUsedRow {
  name: string; title: string | null; reads: number; readers: number; last_at: string;
}

// ② 내가 남긴 지식이 **남의 세션**에서 쓰인 것 — 라이블리 고유 루프(기록의 ROI)를 눈에 보이게 하는 자리.
//  '내 지식'의 판정은 knowledge.author/updated_by 가 아니라 **내 knowledge_save 호출 로그**로 한다 —
//  저자 컬럼은 채널마다 채우는 값이 달라(미러·자동 증류) 사람 축과 1:1 이 아니지만, 호출 로그의 actor 는
//  게이트웨이가 접속 신원으로 박은 값이라 흔들리지 않는다.
//  ⚠ 혼자 쓰는 조직에선 결과가 항상 0 이다(실측: 이 조직 knowledge_get 200건 전량 단일 actor).
//   그때 이 섹션은 빈 칸이 아니라 **아예 렌더되지 않아야 한다**(dash/shell.ts 의 off 원칙과 같은 이유).
export async function livelyKnowledgeUsedByOthers(f: LivelyLogFilter, limit = 5): Promise<KnowledgeUsedRow[]> {
  const r = await itemsPool.query(
    `WITH mine AS (
       SELECT DISTINCT args->>'name' AS name
         FROM mcp_call_log
        WHERE tool = 'knowledge_save' AND ok AND actor = $2 AND args->>'name' IS NOT NULL
     )
     SELECT l.args->>'name' AS name,
            k.title,
            count(*)::int AS reads,
            count(DISTINCT l.actor)::int AS readers,
            max(l.called_at) AS last_at
       FROM mcp_call_log l
       JOIN mine m ON m.name = l.args->>'name'
       LEFT JOIN knowledge k ON k.name = l.args->>'name'
      WHERE ${inWindow("l.called_at")} AND l.tool = 'knowledge_get' AND l.ok
        AND l.actor IS DISTINCT FROM $2
      GROUP BY 1, 2
      ORDER BY reads DESC, last_at DESC
      LIMIT ${Number(limit) || 5}`,
    p(f),
  );
  return r.rows;
}

export interface HarnessRow { harness: string | null; calls: number; last_at: string }

// ③ 내가 넘나든 하네스 — 같은 맥락을 클로드/코덱스 어디서 이어받았는지. 하네스 중립은 조립 스택이
//  재현하지 못하는 축이라(assembled-stack-vs-lively-1203) 2종 이상일 때만 의미가 있다.
//  ⚠ **캐노니컬 하네스만 센다**(CANONICAL_HARNESS_IDS). harness 컬럼은 식별 실패 시 UA 원문을 그대로
//   보존하므로 curl/8.7.1 · Google 같은 값이 섞이는데, 그걸 'AI 도구'로 세면 스크립트 한 번 돈 것이
//   도구가 되어 **화면이 거짓을 주장한다**. 실측(2026-08-07): 필터 전 6종 중 3종이 그런 UA 였다.
//   과소집계(아직 정규화 안 된 진짜 하네스가 빠짐)를 택한다 — 신뢰가 목적인 화면에서 과대집계가 더 비싸다.
export async function livelyHarnesses(f: LivelyLogFilter): Promise<HarnessRow[]> {
  const r = await itemsPool.query(
    `SELECT harness, count(*)::int AS calls, max(called_at) AS last_at
       FROM mcp_call_log
      WHERE ${inWindow("called_at")} AND actor = $2 AND harness = ANY($3::text[])
      GROUP BY harness
      ORDER BY calls DESC
      LIMIT 8`,
    [...p(f), CANONICAL_HARNESS_IDS],
  );
  return r.rows;
}

export interface DbAccessRow { source: string; queries: number; rows_read: number; tables: number }

// ④ 조직 DB 조회 — db_access_log 는 append-only 해시체인이라 여기 값은 감사 기록과 같은 원천이다.
//  'AI가 사내 DB 를 직접 봤다'는 라이블리 없이는 성립하지 않는 사건이라 세션 안 축의 핵심 항목이다.
export async function livelyDbAccess(f: LivelyLogFilter): Promise<DbAccessRow[]> {
  const r = await itemsPool.query(
    `SELECT source,
            count(*)::int AS queries,
            COALESCE(sum(row_count), 0)::int AS rows_read,
            count(DISTINCT t)::int AS tables
       FROM db_access_log
       LEFT JOIN LATERAL jsonb_array_elements_text(tables) AS t ON true
      WHERE ${inWindow("at")} AND user_id = $2 AND ok
      GROUP BY source
      ORDER BY queries DESC
      LIMIT 8`,
    p(f),
  );
  return r.rows;
}

export interface BackgroundWork {
  collector_runs: number;      // 커넥터 수집 실행 횟수
  collector_ok: number;        // 그중 성공
  sources_ingested: number;    // 새로 들어온 원본 자료
  distilled: number;           // 증류기가 처리한 자료
  classified: number;          // 자동 분류된 지식
  last_run_at: string | null;
}

// ⑤ 세션 밖 — 내가 자는 동안 라이블리가 한 일. **귀속 분쟁이 없는 유일한 축**이라(세션 안 작동은 하네스
//  공적과 구분되지 않지만 이건 100% 라이블리다) 저사용자에게도 값이 차는 자리다.
//  조직 단위 집계다(개인 필터 없음) — 수집·증류·분류는 사람이 아니라 조직에 일어나는 사건이므로.
export async function livelyBackgroundWork(f: LivelyLogFilter): Promise<BackgroundWork> {
  const win = [f.interval];
  const one = async (sql: string): Promise<Record<string, unknown>> => {
    try {
      const r = await itemsPool.query(sql, win);
      return r.rows[0] || {};
    } catch {
      return {}; // 그 기능을 안 쓰는 조직엔 표가 비어 있을 수 있다 — 위젯 전체를 죽이지 않는다
    }
  };
  const [run, src, dis, cls] = await Promise.all([
    one(`SELECT count(*)::int AS runs,
                count(*) FILTER (WHERE status = 'ok')::int AS ok,
                max(started_at) AS last_at
           FROM connector_run WHERE ${inWindow("started_at")}`),
    one(`SELECT count(*)::int AS n FROM source WHERE ${inWindow("created_at")}`),
    one(`SELECT count(*)::int AS n FROM org_distiller_seen WHERE ${inWindow("seen_at")}`),
    one(`SELECT count(*)::int AS n FROM org_classifier_seen WHERE ${inWindow("seen_at")}`),
  ]);
  return {
    collector_runs: Number(run.runs || 0),
    collector_ok: Number(run.ok || 0),
    sources_ingested: Number(src.n || 0),
    distilled: Number(dis.n || 0),
    classified: Number(cls.n || 0),
    last_run_at: (run.last_at as string) || null,
  };
}

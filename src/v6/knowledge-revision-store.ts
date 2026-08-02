// 지식 '수정' 검토 큐 스토어(#783) — knowledge_revision.
//
//  왜 별도 테이블인가: 신규 지식은 lifecycle='pending' 으로 격리하면 되지만(검색·주입이 이미 active 필터),
//   기존 active 지식의 '수정'은 그 수법이 안 통한다 — pending 으로 내리는 순간 이미 승인된 라이브 지식이
//   검색·세션주입에서 통째로 사라진다(런북이 사라지는 사고). 그래서 수정본을 본문과 분리해 여기서 검토한다.
//
//  두 모드(인입정책 action_update 가 결정 — org/ingest/ingest-policy.ts):
//   · staged  = 본문 미반영. 라이브는 옛 승인본 유지. 승인해야 적용, 반려하면 폐기.
//   · applied = 본문 이미 반영(라이브 유지). 사람은 사후에 diff 확인(ack) 또는 되돌리기(revert).
//
//  coalesce 불변식: (name) 당 pending 1행(부분 유니크 인덱스). 에이전트가 같은 지식을 반복 저장해도 큐는 1건 —
//   base_*(최초 수정 전 스냅샷)는 보존하고 new_*(최신 제안)만 갱신 → 사람은 '마지막 검토 이후 누적 변화'를 한 번에 본다.
//
//  진실 표시(diff 기준):
//   · staged  → 라이브 현재본 vs new_*   (승인이 실제로 바꿀 것)
//   · applied → base_*      vs 라이브 현재본 (에이전트가 이미 바꾼 것)
import { itemsPool } from "../db/client.js";
import { one, q } from "../db/client.js";
import type { WriteCtx } from "./content-audit.js";
import { upsertKnowledge, type KnowledgeRow } from "./knowledge-store.js";
import { knowledgeVisWhere } from "./knowledge-store.js";
import type { Viewer } from "./visibility.js";

export interface KnowledgeRevisionRow {
  id: number;
  name: string;
  mode: "staged" | "applied";
  status: "pending" | "approved" | "rejected";
  base_version: number | null;
  base_title: string | null;
  base_body_md: string | null;
  base_confidence: string | null;
  new_title: string | null;
  new_body_md: string;
  new_summary: string | null;
  new_type: string | null;
  proposed_by: string | null;
  actor_kind: string | null;
  agent: string | null;
  rule_id: number | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  edits: number;
}

const REV_SEL = `id, name, mode, status, base_version, base_title, base_body_md, base_confidence,
  new_title, new_body_md, new_summary, new_type, proposed_by, actor_kind, agent, rule_id, note,
  created_at, updated_at, reviewed_by, reviewed_at, edits`;

export interface ProposeRevisionInput {
  name: string;
  mode: "staged" | "applied";
  base: { version?: number | null; title?: string | null; body_md?: string | null; confidence?: string | null };
  next: { title?: string | null; body_md: string; summary?: string | null; type?: string | null };
  proposed_by?: string | null;
  actor_kind?: string | null;
  agent?: string | null;
  rule_id?: number | null;
  // #968 change_note — 제안자가 함께 낸 변경 요약·계기(1~2문장). 검토 카드·변화 기록이 이 문장을 그대로 보여준다.
  //  스키마의 note 컬럼(#783 때 만들어졌으나 미배선)을 이제 쓴다 — 마이그레이션 불요.
  note?: string | null;
}

// 수정 제안 적재 — (name) 당 pending 1행 coalesce. 기존 pending 이 있으면 new_* 만 갱신하고 base_* 는 보존(누적 diff).
export async function proposeRevision(input: ProposeRevisionInput): Promise<KnowledgeRevisionRow> {
  const r = await itemsPool.query(
    `INSERT INTO knowledge_revision(name, mode, status, base_version, base_title, base_body_md, base_confidence,
       new_title, new_body_md, new_summary, new_type, proposed_by, actor_kind, agent, rule_id, note)
     VALUES($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (name) WHERE status='pending' DO UPDATE SET
       mode=EXCLUDED.mode,
       new_title=EXCLUDED.new_title, new_body_md=EXCLUDED.new_body_md,
       new_summary=EXCLUDED.new_summary, new_type=EXCLUDED.new_type,
       proposed_by=EXCLUDED.proposed_by, actor_kind=EXCLUDED.actor_kind, agent=EXCLUDED.agent,
       rule_id=EXCLUDED.rule_id, updated_at=now(), edits=knowledge_revision.edits+1,
       note=COALESCE(EXCLUDED.note, knowledge_revision.note)
     RETURNING ${REV_SEL}`,
    [input.name, input.mode, input.base.version ?? null, input.base.title ?? null, input.base.body_md ?? null,
     input.base.confidence ?? null, input.next.title ?? null, input.next.body_md, input.next.summary ?? null,
     input.next.type ?? null, input.proposed_by ?? null, input.actor_kind ?? null, input.agent ?? null,
     input.rule_id ?? null, input.note ?? null]);
  return r.rows[0] as KnowledgeRevisionRow;
}

// 검토 큐 목록 — 대상 지식의 현재 상태(제목·카테고리·버전)를 조인. 본문은 제외(목록은 가볍게, 상세에서 diff).
//  diff 규모(±줄수)는 목록에서 바로 보여야 우선순위를 잡을 수 있어 서버가 계산해 준다.
export interface RevisionListItem {
  id: number; name: string; mode: string; status: string;
  title: string | null; category_key: string | null; category_name: string | null;
  type: string | null; proposed_by: string | null; actor_kind: string | null; agent: string | null;
  rule_id: number | null; edits: number; created_at: string; updated_at: string;
  knowledge_exists: boolean; conflict: boolean;
  added: number; removed: number;
  note: string | null;   // #968 change_note — 목록 행 부제로 요약 문장을 바로 보여준다(검토 화면)
}

// 줄 단위 증감 — 정확한 LCS 는 상세 diff(웹)에서. 목록용은 집합 근사(추가/삭제 줄 수)로 충분하고 O(n).
function lineDelta(before: string | null, after: string | null): { added: number; removed: number } {
  const b = (before ?? "").split("\n");
  const a = (after ?? "").split("\n");
  const bc = new Map<string, number>();
  for (const l of b) bc.set(l, (bc.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of a) {
    const n = bc.get(l) ?? 0;
    if (n > 0) bc.set(l, n - 1); else added++;
  }
  let removed = 0;
  for (const n of bc.values()) removed += n;
  return { added, removed };
}

export async function listRevisions(status = "pending", limit = 200): Promise<RevisionListItem[]> {
  // ⚠ 카테고리는 LATERAL LIMIT 1 — 평범한 JOIN 이면 (구 데이터의) 복수 카테고리 지식에서 큐 행이 중복된다.
  const rows = await q(itemsPool,
    `SELECT r.id, r.name, r.mode, r.status, r.base_version, r.base_body_md, r.new_body_md,
            r.proposed_by, r.actor_kind, r.agent, r.rule_id, r.edits, r.created_at, r.updated_at, r.note,
            k.title AS k_title, k.type AS k_type, k.version AS k_version, k.body_md AS k_body,
            cat.key AS category_key, cat.name AS category_name
       FROM knowledge_revision r
       LEFT JOIN knowledge k ON k.name = r.name
       LEFT JOIN LATERAL (
         SELECT c.key, c.name FROM knowledge_category kc JOIN category c ON c.id = kc.category_id
          WHERE kc.name = r.name AND kc.state <> 'rejected' ORDER BY kc.category_id LIMIT 1
       ) cat ON true
      WHERE r.status=$1
      ORDER BY r.updated_at DESC
      LIMIT $2`, [status, Math.min(Math.max(1, limit), 500)]) as Record<string, unknown>[];
  return rows.map((r) => {
    const exists = r.k_version != null;
    // staged: 승인이 바꿀 것 = 라이브 현재본 → 제안본. applied: 이미 바뀐 것 = 수정 전 → 라이브 현재본.
    const delta = r.mode === "staged"
      ? lineDelta(r.k_body as string | null, r.new_body_md as string)
      : lineDelta(r.base_body_md as string | null, r.k_body as string | null);
    return {
      id: Number(r.id), name: String(r.name), mode: String(r.mode), status: String(r.status),
      title: (r.k_title as string | null) ?? null,
      category_key: (r.category_key as string | null) ?? null,
      category_name: (r.category_name as string | null) ?? null,
      type: (r.k_type as string | null) ?? null,
      proposed_by: (r.proposed_by as string | null) ?? null,
      actor_kind: (r.actor_kind as string | null) ?? null,
      agent: (r.agent as string | null) ?? null,
      rule_id: r.rule_id == null ? null : Number(r.rule_id),
      edits: Number(r.edits ?? 1),
      note: (r.note as string | null) ?? null,
      created_at: String(r.created_at), updated_at: String(r.updated_at),
      knowledge_exists: exists,
      // staged 인데 라이브가 제안 이후 또 바뀜 → 승인 시 그 변경을 덮어쓴다(사람에게 경고).
      conflict: r.mode === "staged" && exists && r.base_version != null && Number(r.k_version) !== Number(r.base_version),
      added: delta.added, removed: delta.removed,
    };
  });
}

// 상세 — diff 렌더용 전문 3종(수정 전 base / 라이브 현재 / 제안 new).
export interface RevisionCurrent { title: string | null; body_md: string; version: number; lifecycle: string }
export async function getRevision(id: number): Promise<{ revision: KnowledgeRevisionRow; current: RevisionCurrent | null } | undefined> {
  const rev = await one(itemsPool, `SELECT ${REV_SEL} FROM knowledge_revision WHERE id=$1`, [id]) as KnowledgeRevisionRow | undefined;
  if (!rev) return undefined;
  const cur = await one(itemsPool,
    `SELECT title, body_md, version, lifecycle FROM knowledge WHERE name=$1`, [rev.name]) as RevisionCurrent | undefined;
  return { revision: rev, current: cur ?? null };
}

// 특정 지식의 검토 대기 수정 1건(있으면) — knowledge_get 이 "이 지식엔 검토 대기 수정이 있다"를 알리는 용도.
//  ⚠ fail-open: 스키마 마이그레이션은 listen 이후에 돈다(런북) → 부팅 직후 짧은 창엔 테이블이 아직 없을 수 있다.
//   그 창에서 knowledge_get(회수 진입점, 상시 로드 툴)이 통째로 500 나면 안 된다 → 조회 실패는 '대기 수정 없음'으로 삼킨다.
export async function pendingRevisionFor(name: string): Promise<KnowledgeRevisionRow | undefined> {
  try {
    return await one(itemsPool,
      `SELECT ${REV_SEL} FROM knowledge_revision WHERE name=$1 AND status='pending'`, [name]) as KnowledgeRevisionRow | undefined;
  } catch { return undefined; }
}

// #921 append 가드 — 이 지식에 '검토 대기 중인 staged 제안'이 있는가. 위 pendingRevisionFor 와 일부러 다른 함수다:
//  ⚠ fail-closed(에러를 삼키지 않는다). 배너 누락은 무해하지만, 여기서 조회가 조용히 비면 append 는 라이브 본문
//   위에 머지돼 저장되고 — 검토 대기 중인 수정이 승인되는 순간 그 append 가 통째로 덮인다(applyRevisionBody 는
//   new_body_md 로 전문 교체). 본문을 읽지 않는 호출자는 그걸 영영 모른다 → 조회 실패는 그냥 던진다.
//  mode='staged' 만 본다 — applied 는 라이브에 이미 반영돼 있어 append 가 그 위에 자연히 쌓인다.
export async function pendingStagedRevisionId(name: string): Promise<number | null> {
  const r = await one(itemsPool,
    `SELECT id FROM knowledge_revision WHERE name=$1 AND status='pending' AND mode='staged'`, [name]);
  return (r as { id?: number } | undefined)?.id ?? null;
}

// 검토 큐 카운트(#802) — 대시보드 알림·관리탭 nav 배지가 '몇 건인지'만 알기 위한 집계 1회.
//  왜 필요한가: 검토 큐 화면은 pending 지식 500건 + 리비전 500건을 본문째 긁는다(diff·중복경고에 본문이 필요).
//   숫자만 필요한 표면이 그걸 매번 긁으면 안 된다.
//  mine = 내 팀이 '오너'인 도메인 — 하루 ~11건이면 "전부 검토"는 부담이라 자기 도메인이 검토의 첫 진입점이다(#783 §9).
//   ownerCatIds 가 비면(팀·오너십 미설정) mine=0 — ANY(빈 배열)은 항상 false라 자연히 그렇게 된다.
//  ⚠ 신규(new)는 검토 큐 목록(listKnowledge lifecycle='pending')과 **같은 집합**을 센다 — is_folder 를 빼지 않는다.
//   게이트는 폴더를 안 태우므로(#783 §4) 실제로 폴더가 여기 낄 일은 없지만, 배지 N 과 큐 N 이 어긋나는 게 더 나쁘다.
export interface ReviewQueueCounts {
  new: number; edit: number; total: number;
  mine_new: number; mine_edit: number; mine_total: number;
}
// viewer(#1291) — 배지 숫자도 그 사람이 볼 수 있는 문서만 센다. 목록은 필터되는데 숫자만 전체면
//  "3건 대기"인데 열면 1건인 상태가 되고, 그 차이 자체가 '안 보이는 문서가 2건 있다'는 신호가 된다.
export async function reviewQueueCounts(ownerCatIds: number[] = [], viewer?: Viewer): Promise<ReviewQueueCounts> {
  const ids = (ownerCatIds || []).map(Number).filter((n) => Number.isFinite(n));
  const params: unknown[] = [ids];
  const visK = await knowledgeVisWhere(viewer, params);            // knowledge k 기준
  //  ⚠ 생성된 SQL 을 정규식으로 재-alias 하지 마라 — 술어 안에 k. 로 시작하는 다른 alias 가 생기는 순간
  //   조용히 깨진다. alias 를 인자로 받아 술어가 직접 자기 이름을 쓰게 한다.
  const visR = await knowledgeVisWhere(viewer, params, "kk");      // 리비전은 원본 지식(kk)으로 판정
  const r = await one(itemsPool, `
    SELECT
      (SELECT count(*)::int FROM knowledge k WHERE k.lifecycle='pending' AND ${visK}) AS n_new,
      (SELECT count(*)::int FROM knowledge_revision r
        WHERE r.status='pending' AND EXISTS(SELECT 1 FROM knowledge kk WHERE kk.name=r.name AND ${visR})) AS n_edit,
      (SELECT count(*)::int FROM knowledge k
        WHERE k.lifecycle='pending' AND ${visK} AND EXISTS (
          SELECT 1 FROM knowledge_category kc
           WHERE kc.name=k.name AND kc.state <> 'rejected' AND kc.category_id = ANY($1::int[]))) AS n_new_mine,
      (SELECT count(*)::int FROM knowledge_revision r
        WHERE r.status='pending'
          AND EXISTS(SELECT 1 FROM knowledge kk WHERE kk.name=r.name AND ${visR})
          AND EXISTS (
          SELECT 1 FROM knowledge_category kc
           WHERE kc.name=r.name AND kc.state <> 'rejected' AND kc.category_id = ANY($1::int[]))) AS n_edit_mine`,
    params) as Record<string, unknown> | undefined;
  const nNew = Number(r?.n_new ?? 0), nEdit = Number(r?.n_edit ?? 0);
  const mNew = Number(r?.n_new_mine ?? 0), mEdit = Number(r?.n_edit_mine ?? 0);
  return { new: nNew, edit: nEdit, total: nNew + nEdit, mine_new: mNew, mine_edit: mEdit, mine_total: mNew + mEdit };
}

// #968 카테고리별 검토 대기 카운트 — 검토 큐 사이드바(카테고리 트리)의 배지용.
//  집합은 reviewQueueCounts 와 동일(pending 지식 ∪ pending 리비전) — 배지 합계와 큐 총계가 어긋나면 안 된다.
//  카테고리는 목록과 같은 LATERAL LIMIT 1 규칙(단일 home) — key=null 은 미분류(주로 observed 미러).
export async function reviewQueueCountsByCategory(): Promise<{ key: string | null; n: number }[]> {
  const rows = await q(itemsPool, `
    SELECT cat.key, count(*)::int AS n FROM (
      SELECT k.name FROM knowledge k WHERE k.lifecycle='pending'
      UNION ALL
      SELECT r.name FROM knowledge_revision r WHERE r.status='pending'
    ) p
    LEFT JOIN LATERAL (
      SELECT c.key FROM knowledge_category kc JOIN category c ON c.id = kc.category_id
       WHERE kc.name = p.name AND kc.state <> 'rejected' ORDER BY kc.category_id LIMIT 1
    ) cat ON true
    GROUP BY cat.key ORDER BY n DESC`) as { key: string | null; n: number }[];
  return rows.map((r) => ({ key: r.key ?? null, n: Number(r.n) }));
}

// 리비전 본문을 지식에 적용 — upsertKnowledge 재사용(감사·버전업·재임베딩·facet 보존이 전부 거기 있다).
//  confidence 는 '누가 이 본문을 썼나'라 검토자(사람)로 덮지 않는다 — 제안자 기준으로 명시 전달(승인자는 감사 actor 에 남는다).
//  ⚠ summary/type 은 null 을 넘기면 기존 값이 지워진다(resolveUpsertFacets: 명시 우선) — 미제안(null)은 undefined 로 보존.
async function applyRevisionBody(rev: KnowledgeRevisionRow, ctx: WriteCtx): Promise<KnowledgeRow> {
  return upsertKnowledge({
    name: rev.name,
    title: rev.new_title ?? undefined,
    body_md: rev.new_body_md,
    summary: rev.new_summary ?? undefined,
    type: rev.new_type ?? undefined,
    confidence: rev.actor_kind === "ai" ? "ai" : "human",
  }, ctx);
}

// 승인 — staged: 제안 본문을 라이브에 적용 / applied: 이미 반영돼 있으니 확인(ack)만.
export async function approveRevision(id: number, ctx: WriteCtx): Promise<{ revision: KnowledgeRevisionRow; applied: boolean }> {
  const rev = await one(itemsPool, `SELECT ${REV_SEL} FROM knowledge_revision WHERE id=$1`, [id]) as KnowledgeRevisionRow | undefined;
  if (!rev) throw new Error(`수정 제안 #${id} 없음`);
  if (rev.status !== "pending") throw new Error(`이미 처리된 제안입니다(${rev.status})`);
  const exists = await one(itemsPool, `SELECT 1 FROM knowledge WHERE name=$1`, [rev.name]);
  if (!exists) throw new Error(`대상 지식 '${rev.name}' 이(가) 없습니다(삭제됨) — 반려하세요`);

  let applied = false;
  if (rev.mode === "staged") { await applyRevisionBody(rev, ctx); applied = true; }
  const after = await one(itemsPool,
    `UPDATE knowledge_revision SET status='approved', reviewed_by=$2, reviewed_at=now(), updated_at=now()
     WHERE id=$1 RETURNING ${REV_SEL}`, [id, ctx.actor ?? null]) as KnowledgeRevisionRow;
  return { revision: after, applied };
}

// 반려 — staged: 제안 폐기(라이브 무변) / applied: 라이브를 수정 전(base)으로 되돌림.
//  ⚠ applied 되돌리기는 '제안 시점의 base' 로 돌린다 — 그 뒤 사람이 손댄 게 있으면 함께 사라진다. UI 가 diff 로 보여준 뒤 확인받는다.
export async function rejectRevision(id: number, ctx: WriteCtx): Promise<{ revision: KnowledgeRevisionRow; reverted: boolean }> {
  const rev = await one(itemsPool, `SELECT ${REV_SEL} FROM knowledge_revision WHERE id=$1`, [id]) as KnowledgeRevisionRow | undefined;
  if (!rev) throw new Error(`수정 제안 #${id} 없음`);
  if (rev.status !== "pending") throw new Error(`이미 처리된 제안입니다(${rev.status})`);

  let reverted = false;
  if (rev.mode === "applied" && rev.base_body_md != null) {
    const exists = await one(itemsPool, `SELECT 1 FROM knowledge WHERE name=$1`, [rev.name]);
    if (exists) {
      await upsertKnowledge({
        name: rev.name,
        title: rev.base_title ?? undefined,
        body_md: rev.base_body_md,
        confidence: rev.base_confidence ?? undefined,
      }, ctx);
      reverted = true;
    }
  }
  const after = await one(itemsPool,
    `UPDATE knowledge_revision SET status='rejected', reviewed_by=$2, reviewed_at=now(), updated_at=now()
     WHERE id=$1 RETURNING ${REV_SEL}`, [id, ctx.actor ?? null]) as KnowledgeRevisionRow;
  return { revision: after, reverted };
}

// 지식 변경 이력(#1546) — org_content_audit 를 '문서 한 건의 시간축'으로 읽는 뷰.
//
//  왜 새 테이블이 없는가: 모든 지식 쓰기가 이미 org_content_audit 에 before/after **행 전문**을 남긴다
//   (upsertKnowledge → auditKnowledge, 스냅샷은 K_COLS 전체라 body_md 포함). 즉 전문 버전 이력은 이미
//   쌓여 있고 knowledge.version 카운터와 깊이도 일치한다 — 없던 건 '그걸 문서 축으로 읽는 창'뿐이다.
//   같은 감사로그를 축만 바꿔 읽는 선례가 이미 셋이다: trash-store(휴지통)·task-detail-store(태스크 피드)·
//   domainmap-store(도메인 should 변경). 이건 그 넷째다.
//
//  org_audit_list(org/store/audit.ts)와의 분업: 그쪽은 **관리자**가 '조직 전체의 관리 변경'을 훑는 축이라
//   scope='admin' 이고 행마다 before+after 전문을 통째로 싣는다. 여기는 **문서를 볼 수 있는 사람 누구나**가
//   '이 문서가 어떻게 변해왔나'를 보는 축이라 (a) 목록에서 본문을 빼고 (b) 지식 가시성으로 게이트한다.
//
//  ⚠ 가시성 판정은 **현재 knowledge 행** 기준이다(capability 층 canSeeKnowledge). 감사 스냅샷 안의 옛
//   visibility 로 판정하면, open 이었다가 members 로 잠긴 문서의 **과거 본문**이 지금 못 보는 사람에게 샌다.
//   (trash-store 는 반대로 before.visibility 를 쓴다 — 거긴 본체 행이 이미 없어서 물어볼 곳이 그것뿐이다.)
import { itemsPool } from "../db/client.js";
import { one } from "../db/client.js";
import { lineDelta } from "./knowledge-revision-store.js";

// 내용 변경 — 본문·제목이 실제로 바뀌는 op. 타임라인 기본 표시.
//  delete/restore 도 여기 둔다: 문서 생애의 큰 사건이라 '메타'로 접으면 안 된다(복원된 문서에서만 보인다).
export const CONTENT_OPS = ["insert", "update", "set_title", "delete", "restore"] as const;
// update 는 op 이름만으로 '내용 변경'이 못 된다(실측). 웹 에디터의 자동저장이 본문 무변경으로도 커밋해서
//  version 을 올리는데, 그게 그대로 '본문 수정'으로 잡히면 타임라인이 +0/−0 행으로 덮인다
//  (실측: 어떤 문서는 35개 버전 전부가 본문 무변경이었다). 그래서 update 만은 **실제로 뭔가 바뀌었는지**를
//  술어로 판정한다. body/title 비교는 SQL 에서 IS DISTINCT FROM 으로 — 줄 diff 를 돌릴 필요가 없다.
//  ⚠ 이 판정은 반드시 **SQL(WHERE)** 에 있어야 한다. JS 에서 사후 필터하면 total 과 반환 건수가 어긋나
//   페이지 하나가 3행만 나오고 has_more 는 true 인 상태가 된다(고전적 post-filter 페이지네이션 버그).
const UPDATE_CHANGED_SQL =
  `((a.before->>'body_md') IS DISTINCT FROM (a.after->>'body_md')
    OR (a.before->>'title') IS DISTINCT FROM (a.after->>'title'))`;
// 메타 변경 — 분류·핀·트리위치·표시설정·링크. 기본 숨김(opt-in).
//  왜 접는가(실측): 지식 감사 200행 표본에서 link_category 만 93건이었다. 안 접으면 타임라인이 분류 잡음으로
//  덮여 정작 '누가 본문을 고쳤나'가 안 보인다.
//  set_visibility(#1561)도 여기 둔다 — 접근통제 변경이라 중요도는 높지만 **본문이 안 바뀌므로** 내용 축에
//  섞으면 '누가 본문을 고쳤나'가 다시 흐려진다. 화면에서는 메타 중에서도 눈에 띄게 라벨링한다.
export const META_OPS = [
  "link_category", "unlink_category", "propose_category", "set_lifecycle", "set_wiki",
  "move", "set_props_ui", "set_visibility", "link_knowledge", "unlink_knowledge", "link_source", "unlink_source",
] as const;

// 이력이 읽는 감사 entity(#1562) — **한 문서의 이력이 두 entity 로 쪼개져 있다.**
//  항상-주입 섹션(규칙·페르소나)은 knowledge 행이면서 편집 경로가 둘이다: 관리탭 세션주입 모달
//  (updateSection → entity='org_section')과 위키 문서 페이지(upsertKnowledge → entity='knowledge').
//  같은 행을 고치는데 감사만 갈라져서, 어느 한쪽만 보면 그 문서 이력이 통째로 절반 거짓이 된다.
//  실측(2026-08-05 dev): org-defaults = org_section 4건 + knowledge 2건, context-ontology-guide = 9 + 2.
//   즉 entity='knowledge' 만 읽던 위키 이력 패널은 6건 중 2건 — 그것도 **최신 편집을 뺀 옛것만** 보여줬다.
//  → 그래서 화면을 하나 더 만드는 대신 조회를 합집합으로 둔다. 어느 화면에서 열든 같은 전체를 본다.
//  (일반 지식엔 아무 영향이 없다 — org_section 감사행은 섹션 이름으로만 존재한다.)
export const HISTORY_ENTITIES = ["knowledge", "org_section"];

export interface KnowledgeHistoryRow {
  audit_id: number;
  at: string;
  op: string;
  /** 이 행이 어느 감사 축에서 왔나 — 되돌리기 경로가 갈린다(org_section 은 지식 upsert 로 되돌리면 안 된다). */
  entity: string;
  kind: "content" | "meta";
  actor: string | null;
  actor_display: string | null;
  actor_kind: string | null;     // human | ai | system | connector | unknown | null
  channel: string | null;        // mcp | web | connector | cli | migration | unknown | null
  version_before: number | null;
  version_after: number | null;
  added: number;
  removed: number;
  title_before: string | null;
  title_after: string | null;
  title_changed: boolean;
  /** 분류 변경(#1563) — link/unlink/propose_category 행에서만 채워진다. 그 외 op 은 양쪽 null. */
  category_before: string | null;
  category_after: string | null;
}

export interface KnowledgeHistoryFilter {
  includeMeta?: boolean;
  limit?: number;
  offset?: number;
}

const asInt = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// 문서 1건의 변경 이력(최신순) + 총계.
//  ⚠ 본문(body_md)은 **반환하지 않는다** — added/removed 계산에만 쓰고 버린다. 선례: K_SEL_LIGHT(#1091,
//   knowledge-store.ts) — 목록에 본문을 실었다가 위키 홈 첫 화면이 ~4MB 였다. 이력도 같은 함정이다
//   (한 문서가 감사행 100건 × 본문 30KB 인 실측 사례가 있다). 전문은 아래 단건 조회로만 나간다.
export async function listKnowledgeHistory(
  name: string, f: KnowledgeHistoryFilter = {},
): Promise<{ rows: KnowledgeHistoryRow[]; total: number }> {
  const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 200);
  const offset = Math.min(Math.max(Number(f.offset) || 0, 0), 1_000_000);
  const ops = f.includeMeta ? [...CONTENT_OPS, ...META_OPS] : [...CONTENT_OPS];
  // 기본(내용만)에서는 무변경 update 를 뺀다 — includeMeta 면 그것도 '메타 변경'으로 함께 보여준다.
  const opFilter = f.includeMeta
    ? `a.op = ANY($2::text[])`
    : `a.op = ANY($2::text[]) AND (a.op <> 'update' OR ${UPDATE_CHANGED_SQL})`;
  const where = `WHERE a.entity = ANY($3::text[]) AND a.entity_key=$1 AND ${opFilter}`;
  const params: unknown[] = [name, ops, HISTORY_ENTITIES];

  const [rowsRes, countRes] = await Promise.all([
    itemsPool.query(
      `SELECT a.id, a.at, a.op, a.entity, a.actor, a.actor_kind, a.channel,
              a.before->>'body_md'  AS body_before,
              a.after ->>'body_md'  AS body_after,
              a.before->>'title'    AS title_before,
              a.after ->>'title'    AS title_after,
              a.before->>'version'  AS version_before,
              a.after ->>'version'  AS version_after,
              m.display_name AS actor_display,
              -- 분류 변경을 '무엇에서 무엇으로'로 보여주기 위한 이름 해소(#1563). 스냅샷엔 id 만 있고,
              --  이력은 옛 이름이 아니라 **지금 그 분류가 무엇인지**를 보여주는 편이 사람에게 쓸모 있다.
              --  category_id 키가 없는 op(본문 변경 등)에서는 ->> 가 NULL 이라 조인도 캐스팅도 안 탄다.
              cb.name AS category_before, ca.name AS category_after
         FROM org_content_audit a
         LEFT JOIN org_member m ON m.id = a.actor
         LEFT JOIN category cb ON cb.id = (a.before->>'category_id')::int
         LEFT JOIN category ca ON ca.id = (a.after ->>'category_id')::int
         ${where}
        ORDER BY a.at DESC, a.id DESC
        LIMIT $4 OFFSET $5`, [...params, limit, offset]),
    one(itemsPool, `SELECT count(*)::int AS total FROM org_content_audit a ${where}`, params),
  ]);

  const contentSet = new Set<string>(CONTENT_OPS);
  const rows = (rowsRes.rows as Record<string, unknown>[]).map((r) => {
    const op = String(r.op);
    const tb0 = (r.title_before as string | null) ?? null;
    const ta0 = (r.title_after as string | null) ?? null;
    // 무변경 update 는 '메타'로 표시한다(위 SQL 술어와 같은 판정) — includeMeta 로 켜서 볼 때
    //  '본문 수정 +0/−0' 이라는 거짓 라벨이 붙지 않게. 화면은 이 kind 로 라벨을 고른다.
    const noopUpdate = op === "update"
      && (r.body_before as string | null) === (r.body_after as string | null) && tb0 === ta0;
    // staged/applied 리비전 목록과 **같은 근사**를 쓴다(knowledge-revision-store.lineDelta) — 화면 두 곳이
    //  같은 변경에 다른 ±숫자를 보이면 그 자체가 버그로 읽힌다. 정확한 LCS 는 상세 diff(웹)가 담당.
    const d = lineDelta(r.body_before as string | null, r.body_after as string | null);
    const tb = tb0, ta = ta0;
    return {
      // ⚠ pg 드라이버는 bigint 를 **문자열**로 준다 — Number 정규화 없이 내보내면 프론트의 === 비교·Set.has 가
      //  조용히 전멸한다(#702 에서 실측으로 잡힌 함정, 같은 감사 id 를 쓰는 표면이라 여기도 동일).
      audit_id: Number(r.id),
      at: String(r.at),
      op,
      entity: String(r.entity),
      kind: (contentSet.has(op) && !noopUpdate ? "content" : "meta") as "content" | "meta",
      actor: (r.actor as string | null) ?? null,
      actor_display: (r.actor_display as string | null) ?? null,
      actor_kind: (r.actor_kind as string | null) ?? null,
      channel: (r.channel as string | null) ?? null,
      version_before: asInt(r.version_before),
      version_after: asInt(r.version_after),
      added: d.added, removed: d.removed,
      title_before: tb, title_after: ta,
      // insert 는 '제목이 생긴' 것이지 '바뀐' 것이 아니다 — before 가 통째로 없으므로 변경으로 세지 않는다.
      title_changed: op !== "insert" && op !== "restore" && tb !== ta,
      category_before: (r.category_before as string | null) ?? null,
      category_after: (r.category_after as string | null) ?? null,
    };
  });
  return { rows, total: Number((countRes as { total?: number } | undefined)?.total ?? 0) };
}

// 단건 전문 — diff 렌더용. 목록에서 **사람이 클릭한 행에서만** 당긴다.
//  name 을 함께 받아 WHERE 에 넣는다(audit_id 만으로 조회하면 남의 문서 감사행을 id 추측으로 열 수 있다 —
//  가시성 게이트는 name 을 기준으로 도는데 그 name 과 무관한 행을 돌려주면 게이트를 우회한 셈이 된다).
export interface KnowledgeHistoryEntry {
  audit_id: number; at: string; op: string; entity: string;
  actor: string | null; actor_display: string | null; actor_kind: string | null; channel: string | null;
  //  body_md 가 **null 일 수 있다**: 스냅샷 객체는 있는데 본문 키가 없는 op 이 있다(link_category 의 after 는
  //  `{category_id, state}` 다). 여기서 `?? ""` 로 뭉개면 화면이 '본문이 빈 버전'과 '이 op 은 본문을 안 남긴다'를
  //  구분 못 해, 분류 변경 행이 '이 시점에 문서가 처음 만들어졌습니다'로 표시된다(실측으로 잡힌 거짓말).
  before: { title: string | null; body_md: string | null } | null;
  after: { title: string | null; body_md: string | null } | null;
}
export async function getKnowledgeHistoryEntry(name: string, auditId: number): Promise<KnowledgeHistoryEntry | undefined> {
  const r = await one(itemsPool,
    `SELECT a.id, a.at, a.op, a.entity, a.actor, a.actor_kind, a.channel,
            a.before->>'title'   AS title_before,
            a.before->>'body_md' AS body_before,
            a.after ->>'title'   AS title_after,
            a.after ->>'body_md' AS body_after,
            (a.before IS NOT NULL) AS has_before,
            (a.after  IS NOT NULL) AS has_after,
            m.display_name AS actor_display
       FROM org_content_audit a
       LEFT JOIN org_member m ON m.id = a.actor
      WHERE a.entity = ANY($3::text[]) AND a.entity_key=$1 AND a.id=$2`,
    [name, auditId, HISTORY_ENTITIES]) as Record<string, unknown> | undefined;
  if (!r) return undefined;
  return {
    audit_id: Number(r.id),
    at: String(r.at),
    op: String(r.op),
    entity: String(r.entity),
    actor: (r.actor as string | null) ?? null,
    actor_display: (r.actor_display as string | null) ?? null,
    actor_kind: (r.actor_kind as string | null) ?? null,
    channel: (r.channel as string | null) ?? null,
    // insert 의 before, delete 의 after 는 통째로 null 이다 — 빈 문자열로 뭉개면 화면이 '내용 없는 버전'과
    //  '그 시점엔 문서가 없었음'을 구분 못 한다. null 을 그대로 흘린다.
    before: r.has_before ? { title: (r.title_before as string | null) ?? null, body_md: (r.body_before as string | null) ?? null } : null,
    after: r.has_after ? { title: (r.title_after as string | null) ?? null, body_md: (r.body_after as string | null) ?? null } : null,
  };
}

// 되돌리기(#1546) 대상 스냅샷 — 감사행의 before(또는 after) 지식 행 전문.
//  upsertKnowledge 입력으로 쓰려면 body_md 뿐 아니라 facet(injection·type·is_wiki…)이 다 필요해서
//  위 diff 용 조회(title/body 만)와 달리 **행 전체**를 준다. 역적용 자체는 capability 층이 undo.ts 의
//  knowledgeUpsertInput 으로 수행한다(스냅샷→upsert 매핑을 두 벌 두지 않는다).
//  ⚠ entity 를 함께 돌려준다(#1562) — 스냅샷의 **모양이 entity 마다 다르다.** org_section 스냅샷은
//   SECTION_COLS(name·body_md·version·sort·updated_at·updated_by)뿐이라 injection·provenance·type 이 없다.
//   그걸 지식 upsert 에 넘기면 그 facet 들이 기본값으로 덮여 **섹션이 항상-주입에서 조용히 빠진다**
//   (= 전 조직의 세션 프롬프트에서 그 규칙이 사라진다). 호출부가 entity 로 되돌리기 경로를 갈라야 한다.
export async function getKnowledgeSnapshot(
  name: string, auditId: number, direction: "before" | "after",
): Promise<{ op: string; entity: string; snapshot: Record<string, unknown> | null }> {
  const r = await one(itemsPool,
    `SELECT op, entity, before, after FROM org_content_audit
      WHERE entity = ANY($3::text[]) AND entity_key=$1 AND id=$2`,
    [name, auditId, HISTORY_ENTITIES]) as Record<string, unknown> | undefined;
  if (!r) throw new Error("이력 항목을 찾지 못했습니다");
  const snap = (direction === "before" ? r.before : r.after) as Record<string, unknown> | null;
  return { op: String(r.op), entity: String(r.entity), snapshot: snap ?? null };
}

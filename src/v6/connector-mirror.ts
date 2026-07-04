// v6 외부 미러 적재 — 커넥터(RawItem) → v6 knowledge/project. 구 knowledge-mirror.ts(→knowledge_unit) 대체.
//
//   v6 모델은 kind(R/K/H/W)를 폐기하고 직교축(injection/provenance)으로 분리했고, 외부 작업(구 W ku)은
//   1급 엔티티 project(level=task/subtask)로 흡수했다. 따라서 커넥터 미러는 **소스로 갈라** 적재한다:
//     · clickup task → project(level='task'|'subtask', provenance 개념 없음 — external_* 좌표 보유).
//     · notion(및 그 외 K류 미러) → knowledge(provenance='observed' — 외부 수집물 사실, 검색 소환).
//   분류는 ingest-classify.routeIngestV6 가 단일 결정(구 KIND_MAP 의 W=작업/그 외=지식 의미를 재사용 —
//   notion=K, slack=미정의=skip 그대로). v6 에는 kind 컬럼이 없으므로 W/K 라벨 자체는 미적재(라우팅에만 사용).
//
//   멱등(external idempotency): knowledge_external_uidx / project_external_uidx 부분유니크
//   (external_system, external_instance, external_id) ON CONFLICT upsert — 재싱크는 중복 없이 수렴(구 미러 동일).
//   external_instance 는 NULL→'' 정규화(부분 UNIQUE 갭 메움, pg NULL distinct 회피 — external-identity 중앙 helper).
//
//   🔴H1 redact — title/body/fields/raw 를 쓰기 **전** redactString/redactDeep(커넥터 원본 평문 토큰 마스킹).
//
//   ── 감사 노이즈 게이트(구 mirror 의 핵심 보존) — 미러는 고빈도(매 싱크 다수 행 UPDATE: status-sync 등)라
//      무조건 audit append 하면 org_content_audit 가 노이즈로 비대해진다. 따라서 **본문/제목 실변경 시에만**
//      org_content_audit 리비전을 남긴다. upsert 전에 기존 행을 읽어 비교하고, no-op 재싱크(last_synced_at-only)
//      는 audit 를 생략한다(행은 갱신, 이력은 무변). insert 는 항상 1건(v1). channel='connector',
//      actor='connector:<system>', actor_kind='connector'(채널 신뢰가 아닌 결정적 라벨).
//
//   ⚠ 비파괴·best-effort: 호출자(ingestItems)가 try/catch 로 격리(미러 실패가 인입을 깨면 안 됨 —
//      다음 싱크가 멱등 수렴). 같은 트랜잭션 client 공유(미러 쓰기와 audit append 원자적).
import type pg from "pg";
import { redactDeep, redactString } from "../org/redact.js";
// unitName/normalizeExternalInstance 는 external-identity 가 SoT(구 미러와 byte-identical 슬러그·정규화 공유).
import { unitName, normalizeExternalInstance } from "../org/external-identity.js";
import { routeIngestV6 } from "../org/ingest-classify.js";
import type { RawItem } from "../items/store.js";

// 정규 카테고리 → CHECK 유효 네이티브 status 투영(UI 호환). 역(네이티브→카테고리)=project-store.categoryOf.
//  네이티브 status CHECK 엔 canceled 가 없어 done 으로 투영 — 원본은 status_raw/status_category 에 보존(무손실).
function nativeStatusOf(category: string): string {
  switch (category) {
    case "done": return "done";
    case "canceled": return "done";
    case "started": return "in_progress";
    default: return "todo"; // backlog | unstarted
  }
}

// 필드별 3-way 머지(#6d). base=마지막 합의값, ours=현 DB, theirs=인입(ClickUp). null/undefined 정규화 비교.
//  theirs==base → ours(외부 불변, 우리 편집 보존) · ours==base → theirs(우리 불변, 외부 편집 채택) ·
//  양쪽 변경(충돌) → ours(우리 DB=master 최종 타이브레이크). base 미상(NULL)이면 ours≠theirs 시 ours(보수적).
function merge3<T>(base: T | null | undefined, ours: T | null | undefined, theirs: T | null | undefined): T | null {
  const b = base ?? null, o = ours ?? null, t = theirs ?? null;
  if (o === t) return o;   // 둘이 같음
  if (t === b) return o;   // theirs 불변 → ours 유지
  if (o === b) return t;   // ours 불변 → theirs 채택
  return o;                // 충돌 → ours(우리 DB 타이브레이크)
}

// 감사 append — entity 별 actor_kind='connector'/channel='connector' 고정. before/after 스냅샷은 JSON 직렬화.
//  같은 트랜잭션 client(미러 쓰기와 원자적). FK 없는 append-only 라 대상 행 삭제 후에도 이력 보존.
async function auditConnector(
  client: pg.PoolClient,
  entity: "knowledge" | "project" | "source",
  entityKey: string,
  op: "insert" | "update",
  before: unknown,
  after: unknown,
  actor: string,
): Promise<void> {
  await client.query(
    `INSERT INTO org_content_audit(entity, entity_key, op, before, after, actor, source, channel, actor_kind)
     VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,'connector','connector','connector')`,
    [entity, entityKey, op,
     before == null ? null : JSON.stringify(before),
     after == null ? null : JSON.stringify(after),
     actor],
  );
}

// notion(및 K류) → knowledge(observed) 멱등 upsert. 본문 실변경 시에만 audit. true=적재, false=skip.
async function mirrorKnowledgeV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  // 🔴H1 redact — 쓰기 전 평문 시크릿 마스킹.
  const title = it.title == null ? null : redactString(String(it.title));
  const body = redactString(String(it.body ?? ""));
  const baseFields = redactDeep(it.fields && typeof it.fields === "object" ? it.fields : {}) as Record<string, unknown>;
  // 구 미러처럼 원 item.type 을 fields._item_type 에 가산 보존(type 필터 무손실 복원용 — v6 에 kind 없음).
  const fields = { ...baseFields, _item_type: it.type };
  const raw = it.raw == null ? null : redactDeep(it.raw);
  const author = `connector:${system}`;
  // #551 아카이브 전파 — 원본이 아카이브/휴지통이면 lifecycle='archived'(기본 목록에서 숨고 보존). 아니면 active.
  const lifecycle = baseFields.archived === true || baseFields.in_trash === true ? "archived" : "active";
  // #551 형제 순서 — 커넥터가 sort 를 주면 반영, 없으면(타 커넥터) 기존값 유지(COALESCE).
  const sort = typeof it.sort === "number" && Number.isFinite(it.sort) ? Math.trunc(it.sort) : null;

  // ── 감사 노이즈 게이트 — external 좌표로 기존 행을 읽어 본문/제목 비교. insert=항상 1건, no-op 재싱크=audit 생략. ──
  const prev = await client.query(
    `SELECT name, title, body_md FROM knowledge
     WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
    [system, instance, externalId],
  );
  const prevRow = prev.rows[0] as { name: string; title: string | null; body_md: string } | undefined;
  const isInsert = !prevRow;
  const contentChanged = isInsert
    || (prevRow.title ?? null) !== (title ?? null)
    || (prevRow.body_md ?? "") !== (body ?? "");

  // 멱등 upsert — 외부 좌표(external_*) 부분유니크 ON CONFLICT. provenance='observed'(외부 수집물 사실),
  //  injection='recalled'(검색 소환 — 외부 미러는 always 주입 대상 아님), confidence='observed', source=system.
  //  name(PK)은 신규일 때만 슬러그 부여(external-identity.unitName SoT). 재싱크는 ON CONFLICT 가 같은 행을 잡으므로 name 충돌 없음.
  const name = prevRow?.name ?? unitName(system, externalId);
  const parentName = it.parent_external_id ? unitName(system, it.parent_external_id) : null;
  const r = await client.query(
    `INSERT INTO knowledge(
        name, title, body_md, injection, provenance, lifecycle, confidence, source,
        external_system, external_instance, external_id, external_url,
        occurred_at, last_synced_at, parent_external_id, parent_name,
        fields, raw, author, sort, updated_at, updated_by)
      VALUES($1,$2,$3,'recalled','observed',$14,'observed',$4,
             $4,$5,$6,$7,
             $8, now(), $9, $10,
             $11::jsonb, $12::jsonb, $13, COALESCE($15, 0), now(), $13)
     ON CONFLICT (external_system, external_instance, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET
        title=EXCLUDED.title, body_md=EXCLUDED.body_md,
        injection='recalled', provenance='observed', lifecycle=EXCLUDED.lifecycle, confidence='observed', source=EXCLUDED.source,
        external_url=EXCLUDED.external_url, occurred_at=EXCLUDED.occurred_at,
        last_synced_at=now(), parent_external_id=EXCLUDED.parent_external_id, parent_name=EXCLUDED.parent_name,
        fields=EXCLUDED.fields, raw=EXCLUDED.raw, sort=COALESCE($15, knowledge.sort),
        version=knowledge.version + 1, updated_at=now(), updated_by=EXCLUDED.updated_by
     RETURNING name`,
    [name, title, body, system,
     instance, externalId, it.provenance.external_url ?? null,
     it.occurred_at ?? null, it.parent_external_id ?? null, parentName,
     JSON.stringify(fields), raw == null ? null : JSON.stringify(raw), author,
     lifecycle, sort],
  );
  const finalName = (r.rows[0] as { name: string }).name;

  if (contentChanged) {
    const beforeSnap = isInsert ? null : { name: finalName, title: prevRow!.title, body_md: prevRow!.body_md };
    const afterSnap = { name: finalName, title, body_md: body, provenance: "observed", confidence: "observed", source: system, author };
    await auditConnector(client, "knowledge", finalName, isInsert ? "insert" : "update", beforeSnap, afterSnap, author);
  }
  return true;
}

// clickup task → project(level='project'|'task'|'subtask') 멱등 upsert. 본문 실변경 시에만 audit. true=적재, false=skip.
//  level: 커넥터가 it.level 로 위계 전달(ClickUp Task 깊이→우리 level: top-level Task=project, Subtask=task, 중첩 Subtask=subtask).
//   매핑 근거: 우리 project=추적항목(status/멤버 보유)이라 ClickUp Task 와 동형(List 아님). 단일 컨테이너 List 가 project-Task 들을 담는다.
//   it.level 부재(타 커넥터)면 parent 유무로 폴백(no-parent=project, 있으면 task).
//   ⚠ project.parent_id(내부 self-FK)는 v6 위계의 진실이나, 커넥터는 부모를 external_id 로만 안다.
//   배치 적재 순서가 부모 우선을 보장하지 않으므로(부모 task 행이 아직 없을 수 있음) 여기서 parent_id 를
//   결정적으로 채우지 않는다 → 같은 (external_system, external_instance, parent external_id)로 부모 project 가
//   이미 있으면 그 내부 id 로 parent_id 를 링크하고, 없으면 NULL 로 둔다(다음 싱크가 멱등 재방문 시 수렴 가능).
//   level 은 it.level(커넥터 깊이판정)로 결정 — parent_id 미해소여도 level 은 정확(위계 평탄화 회피).
async function mirrorProjectV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  // 🔴H1 redact — name(title)/description(body)/external_url 평문 시크릿 마스킹.
  const name = it.title == null ? "" : redactString(String(it.title));
  const description = it.body == null ? null : redactString(String(it.body));
  // 깊이 기반 level: 커넥터가 it.level 로 전달(ClickUp top_level_parent 로 판정). 폴백은 no-parent=project, 있으면 task.
  const level = it.level ?? (it.parent_external_id ? "task" : "project");

  // 부모 task 행(같은 외부 좌표계의 parent external_id) 내부 id 조회 — 있으면 parent_id 링크, 없으면 NULL.
  let parentId: number | null = null;
  if (it.parent_external_id) {
    const p = await client.query(
      `SELECT id FROM project WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
      [system, instance, it.parent_external_id],
    );
    parentId = (p.rows[0] as { id: number } | undefined)?.id ?? null;
  }

  // ── 기존 행 조회 — 3-way 머지 base(external_base) + 감사 스냅샷. ──
  const prev = await client.query(
    `SELECT id, name, description, status, status_category, external_base FROM project
     WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
    [system, instance, externalId],
  );
  const prevRow = prev.rows[0] as {
    id: number; name: string; description: string | null;
    status: string; status_category: string | null; external_base: Record<string, unknown> | null;
  } | undefined;
  const isInsert = !prevRow;

  const author = `connector:${system}`;
  const f = (it.fields ?? {}) as Record<string, unknown>;
  const statusRaw = f.status != null ? String(f.status) : null;
  const statusCategory = typeof f.status_category === "string" ? f.status_category : "unstarted";

  let id: number;
  let appliedName = name;
  let appliedDesc: string | null = description;
  let changed: boolean;

  if (isInsert) {
    // 최초 import — theirs 채택. external_base=theirs(다음 3-way 의 공통조상). status 3컬럼·담당자도 여기서만 시드(우리 DB=master).
    const baseJson = JSON.stringify({ name, description, status_category: statusCategory });
    const ins = await client.query(
      `INSERT INTO project(
          level, parent_id, name, description, status, status_raw, status_category, created_by,
          external_system, external_instance, external_id, external_url, external_base,
          created_at, updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,now(),now())
       RETURNING id`,
      [level, parentId, name, description, nativeStatusOf(statusCategory), statusRaw, statusCategory, author,
       system, instance, externalId, it.provenance.external_url ?? null, baseJson],
    );
    id = (ins.rows[0] as { id: number }).id;
    if (Array.isArray(f.assignees)) {
      const memberIds = [...new Set((f.assignees as Array<{ id?: unknown; email?: unknown }>)
        .map((a) => (a?.email ? String(a.email).trim().toLowerCase() : a?.id != null ? String(a.id) : ""))
        .filter(Boolean))];
      let asort = 0;
      for (const m of memberIds) {
        await client.query(
          `INSERT INTO task_assignee(task_id, member_id, sort) VALUES($1,$2,$3) ON CONFLICT (task_id, member_id) DO NOTHING`,
          [id, m, asort++]);
      }
    }
    changed = true;
  } else {
    // 기존 행 — 필드별 3-way 머지(base/ours/theirs). 충돌=ours(우리 DB master). 인바운드는 단일프로세스(스케줄러 락+배치 순차)라 SELECT→UPDATE TOCTOU 무시가능.
    id = prevRow!.id;
    const base = prevRow!.external_base ?? null;
    const mName = merge3(base?.name as string | undefined, prevRow!.name, name) ?? "";
    const mDesc = merge3(base?.description as string | null | undefined, prevRow!.description, description);
    const mCat = merge3(base?.status_category as string | undefined, prevRow!.status_category, statusCategory) ?? "unstarted";
    // status_category 가 ours 로 유지되면 네이티브 status 도 ours 보존(active↔in_progress 동일카테고리 진동 방지). theirs 채택 시만 재투영.
    const mStatus = mCat === (prevRow!.status_category ?? null) ? prevRow!.status : nativeStatusOf(mCat);
    const newBase = JSON.stringify({ name: mName, description: mDesc, status_category: mCat });
    await client.query(
      `UPDATE project SET
          level=$2, parent_id=COALESCE($3, parent_id),
          name=$4, description=$5, status=$6, status_category=$7,
          external_url=$8, external_base=$9::jsonb, updated_at=now()
        WHERE id=$1`,
      [id, level, parentId, mName, mDesc, mStatus, mCat, it.provenance.external_url ?? null, newBase]);
    appliedName = mName; appliedDesc = mDesc;
    // 수렴 — 머지결과가 theirs 와 다르면(우리값 우세) ClickUp 도 merged 로 끌어와야 다음 싱크 진동 안 함 → 아웃박스(같은 client, 원자적).
    if (mName !== name || (mDesc ?? null) !== (description ?? null) || mCat !== statusCategory) {
      await client.query(
        `INSERT INTO external_outbox(entity_id, system, op) VALUES($1,$2,'upsert')
         ON CONFLICT (system, entity_id) WHERE done_at IS NULL
         DO UPDATE SET op='upsert', updated_at=now(), attempts=0, last_error=NULL`,
        [id, system]);
    }
    changed = (mName !== (prevRow!.name ?? "")) || ((mDesc ?? null) !== (prevRow!.description ?? null)) || (mCat !== (prevRow!.status_category ?? null));
  }

  if (changed) {
    const beforeSnap = isInsert ? null : { id, name: prevRow!.name, description: prevRow!.description };
    const afterSnap = { id, level, name: appliedName, description: appliedDesc, external_system: system, external_id: externalId, created_by: author };
    await auditConnector(client, "project", String(id), isInsert ? "insert" : "update", beforeSnap, afterSnap, author);
  }
  return true;
}

// system → source.kind 매핑(표준 kind 준수 — SOURCE_KINDS). 그 외는 'other'(raw 에 system 보존).
function sourceKindOf(system: string): string {
  switch (system) {
    case "slack": return "slack";
    case "gmail": return "email";
    case "notion": return "notion_doc";
    case "clickup": return "clickup_doc";
    default: return "other"; // discord, gdrive 미정제 등
  }
}

// slack/gmail/discord message(및 미정제 raw) → source(자료) 멱등 upsert (#541). distill 이 여기서 지식을 증류(source→knowledge).
//  external 좌표(source_external_uidx) ON CONFLICT. 본문 실변경 시에만 audit(노이즈 게이트 — knowledge 미러와 동일).
//  🔴H1 redact — title/body/raw 평문 시크릿 마스킹. provenance=observed(외부 수집물). knowledge_search 에 자동 미포함(별 테이블).
async function mirrorSourceV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  const kind = sourceKindOf(system);
  const title = it.title == null ? null : redactString(String(it.title));
  const body = redactString(String(it.body ?? ""));
  const raw = it.raw == null ? null : redactDeep(it.raw);
  const author = `connector:${system}`;

  // ── 감사 노이즈 게이트 — external 좌표로 기존 행을 읽어 본문/제목 비교. no-op 재싱크(last_synced_at-only)는 audit 생략. ──
  const prev = await client.query(
    `SELECT id, title, body_md FROM source WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
    [system, instance, externalId],
  );
  const prevRow = prev.rows[0] as { id: number; title: string | null; body_md: string } | undefined;
  const isInsert = !prevRow;
  const contentChanged = isInsert
    || (prevRow.title ?? null) !== (title ?? null)
    || (prevRow.body_md ?? "") !== (body ?? "");

  const r = await client.query(
    `INSERT INTO source(
        kind, title, body_md, raw, provenance,
        external_system, external_instance, external_id, external_url,
        occurred_at, last_synced_at, author, updated_at, updated_by)
      VALUES($1,$2,$3,$4::jsonb,'observed',
             $5,$6,$7,$8,
             $9, now(), $10, now(), $10)
     ON CONFLICT (external_system, external_instance, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET
        kind=EXCLUDED.kind, title=EXCLUDED.title, body_md=EXCLUDED.body_md, raw=EXCLUDED.raw,
        external_url=EXCLUDED.external_url, occurred_at=EXCLUDED.occurred_at,
        last_synced_at=now(), updated_at=now(), updated_by=EXCLUDED.updated_by
     RETURNING id`,
    [kind, title, body, raw == null ? null : JSON.stringify(raw),
     system, instance, externalId, it.provenance.external_url ?? null,
     it.occurred_at ?? null, author],
  );
  const id = (r.rows[0] as { id: number }).id;

  if (contentChanged) {
    const beforeSnap = isInsert ? null : { id, title: prevRow!.title, body_md: prevRow!.body_md };
    const afterSnap = { id, kind, title, body_md: body, provenance: "observed", source: system, author };
    await auditConnector(client, "source", String(id), isInsert ? "insert" : "update", beforeSnap, afterSnap, author);
  }
  return true;
}

// ── 단일 RawItem → v6 적재(라우팅). ingestItems 의 트랜잭션 client 공유. ──
//  라우팅: routeIngestV6(system, type) → 'project'(clickup task) | 'knowledge'(notion 등 K류) | null(미정의=skip).
//  external_id 부재(이론상 불가)면 멱등키가 없어 skip. 적재 시 true, skip 시 false.
export async function mirrorExternalToV6(client: pg.PoolClient, it: RawItem): Promise<boolean> {
  const system = it.provenance.system;
  const externalId = it.provenance.external_id;
  if (!externalId) return false;
  const target = routeIngestV6(it.type, system);
  if (target === "project") return mirrorProjectV6(client, it, system, externalId);
  if (target === "knowledge") return mirrorKnowledgeV6(client, it, system, externalId);
  if (target === "source") return mirrorSourceV6(client, it, system, externalId); // slack/gmail message 등 → 자료(distill 대상)
  return false; // 라우팅 정의 밖 — 미러 skip(보수적, 임의 분류 금지).
}

// ════════ #551 노션 무손실 싱크 — run-sync 후처리(set 기반, 멱등) ════════
//  적재(ingestItems) 뒤에 run-sync 가 호출한다. 전부 SQL set 연산이라 재실행·부분실행 안전(수렴형).
type PgRunner = pg.Pool | pg.PoolClient;

/** fields.notion.links → knowledge_link 물질화. 커넥터 origin 링크만 재작성(사람 링크 불가침).
 *  타깃이 아직 미적재면 그 엣지는 이번엔 생략 — 매 싱크 전체 재계산이라 다음 run 에 자동 수렴. */
export async function materializeNotionLinks(db: PgRunner): Promise<number> {
  await db.query(`DELETE FROM knowledge_link WHERE origin='connector:notion'`);
  const r = await db.query(
    `INSERT INTO knowledge_link(from_name, to_name, relation, origin, created_at, updated_at)
     SELECT DISTINCT k.name, t.name, 'related', 'connector:notion', now(), now()
     FROM knowledge k
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.fields->'notion'->'links', '[]'::jsonb)) AS l(link)
     JOIN knowledge t
       ON t.external_system='notion'
      AND t.external_instance = k.external_instance
      AND t.external_id = l.link->>'target_external_id'
      AND t.name <> k.name
     WHERE k.external_system='notion'
     ON CONFLICT (from_name, to_name, relation) DO NOTHING`, // 같은 쌍의 사람(user) 링크가 이미 있으면 그대로 존중
  );
  return r.rowCount ?? 0;
}

/** 부모의 fields.notion.children_order → 자식 knowledge.sort 수렴.
 *  증분에서 부모만 변경돼도(자식 재정렬) 자식 행 재적재 없이 순서가 맞는다. updated_at 은 건드리지 않는다(노이즈 방지). */
export async function applyNotionChildrenOrder(db: PgRunner): Promise<number> {
  const r = await db.query(
    `UPDATE knowledge c SET sort = ord.idx
     FROM (
       SELECT p.external_instance AS inst, elem.value AS child_ext, (elem.ordinality - 1)::int AS idx
       FROM knowledge p,
            jsonb_array_elements_text(COALESCE(p.fields->'notion'->'children_order', '[]'::jsonb))
              WITH ORDINALITY AS elem(value, ordinality)
       WHERE p.external_system='notion'
     ) ord
     WHERE c.external_system='notion'
       AND c.external_instance = ord.inst
       AND c.external_id = ord.child_ext
       AND c.sort IS DISTINCT FROM ord.idx`,
  );
  return r.rowCount ?? 0;
}

/** full 싱크 스윕 — 이번 run(runStartIso 이후)에 관측되지 않은 notion 미러를 archived 로(원본 삭제/공유해제 전파).
 *  ⚠ 호출 조건: full 모드 + 커넥터 실패 0(부분 실패 run 에서 스윕하면 살아있는 페이지가 오탐 아카이브됨). */
export async function sweepNotionArchived(db: PgRunner, runStartIso: string): Promise<number> {
  const r = await db.query(
    `UPDATE knowledge SET lifecycle='archived', updated_at=now(), updated_by='connector:notion'
     WHERE external_system='notion' AND lifecycle='active'
       AND (last_synced_at IS NULL OR last_synced_at < $1::timestamptz)`,
    [runStartIso],
  );
  return r.rowCount ?? 0;
}

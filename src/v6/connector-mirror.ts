// v6 외부 미러 적재 — 커넥터(RawItem) → v6 knowledge/project/source + PM 계층(폴더·리스트·뷰·댓글·타임). 구 knowledge-mirror.ts(→knowledge_unit) 대체.
//
//   v6 모델은 kind(R/K/H/W)를 폐기하고 직교축(injection/provenance)으로 분리했고, 외부 작업(구 W ku)은
//   1급 엔티티 project(level=task/subtask)로 흡수했다. 따라서 커넥터 미러는 **소스로 갈라** 적재한다:
//     · clickup task → project(level='project'|'task'|'subtask' — external_* 좌표 보유).
//     · clickup space/folder → project_folder(중첩), list → project_list(+settings.statuses), view → project_view,
//       comment → task_comment, time → task_time_entry  (#541 무손실 이관).
//     · notion(및 그 외 K류 미러) → knowledge(provenance='observed'), slack/gmail message → source(자료).
//   분류는 ingest-classify.routeIngestV6 가 단일 결정.
//
//   멱등(external idempotency): 각 테이블의 external 부분유니크 ON CONFLICT upsert — 재싱크는 중복 없이 수렴.
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
//      다음 싱크가 멱등 수렴). item 단위 BEGIN/COMMIT — 한 태스크의 다중 테이블 쓰기(본체+태그+체크리스트+
//      필드+첨부)가 원자적으로 성립/철회된다(ingestItems 자체는 트랜잭션이 없음 — #541 확인).
//
//   ── 담당자(어사이니) 해소(#541) — ClickUp 유저 → org_member.id 3단 폴백(손실 0):
//      ① person_identity(system, external_id=email|숫자id) → person_id(=org_member.id 동기 계약) 가 org_member 에 실재하면 채택
//      ② org_member.email lower 매치
//      ③ raw email(소문자) 또는 숫자 id 문자열 그대로 — UI 는 미해소 id 를 raw+이니셜로 폴백 표시, 관리탭
//         'ClickUp 멤버 매핑'(org_member.identities)으로 사후 매핑하면 다음 싱크가 수렴.
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
//  양쪽 변경(충돌) → ours(우리 DB=master 최종 타이브레이크). base 미상(NULL)이면 ours==NULL 일 때만 theirs
//  (미설정 필드는 외부값 채택 — 레거시 행의 신규 필드 백필 경로).
function merge3<T>(base: T | null | undefined, ours: T | null | undefined, theirs: T | null | undefined): T | null {
  const b = base ?? null, o = ours ?? null, t = theirs ?? null;
  if (o === t) return o;   // 둘이 같음
  if (t === b) return o;   // theirs 불변 → ours 유지
  if (o === b) return t;   // ours 불변 → theirs 채택
  return o;                // 충돌 → ours(우리 DB 타이브레이크)
}

// 집합 3-way 머지(태그 등 이름 집합) — result = (ours − (base−theirs)) ∪ (theirs−base).
//  외부 추가는 들어오고, 외부 삭제는 우리가 재추가하지 않은 것만 빠진다. 충돌 없는 결정적 수렴.
function mergeSet(base: string[] | null | undefined, ours: string[], theirs: string[]): string[] {
  const b = new Set(base ?? []), t = new Set(theirs);
  const removedByThem = [...b].filter((x) => !t.has(x));
  const addedByThem = theirs.filter((x) => !b.has(x));
  const out = new Set(ours.filter((x) => !removedByThem.includes(x)));
  for (const x of addedByThem) out.add(x);
  return [...out];
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

// ════════════════════════════════════════════════════════════════════════════
// ── PM 계층·부속 미러(#541 무손실) — 공용 해소 헬퍼 ──
// ════════════════════════════════════════════════════════════════════════════

async function folderIdByExternal(client: pg.PoolClient, system: string, instance: string, externalId: string): Promise<number | null> {
  const r = await client.query(
    `SELECT id FROM project_folder WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
    [system, instance, externalId]);
  return (r.rows[0] as { id: number } | undefined)?.id ?? null;
}

async function listIdByExternal(client: pg.PoolClient, system: string, instance: string, externalId: string): Promise<number | null> {
  const r = await client.query(
    `SELECT id FROM project_list WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
    [system, instance, externalId]);
  return (r.rows[0] as { id: number } | undefined)?.id ?? null;
}

async function projectIdByExternal(client: pg.PoolClient, system: string, instance: string, externalId: string): Promise<number | null> {
  const r = await client.query(
    `SELECT id FROM project WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
    [system, instance, externalId]);
  return (r.rows[0] as { id: number } | undefined)?.id ?? null;
}

// ClickUp 유저 → member_id 해소(헤더 주석 3단 폴백). actor = {id?, email?, username?} shape(fields.assignees[]).
async function resolveMemberId(
  client: pg.PoolClient, system: string,
  actor: { id?: unknown; email?: unknown; username?: unknown } | null | undefined,
): Promise<string | null> {
  if (!actor) return null;
  const email = actor.email ? String(actor.email).trim().toLowerCase() : "";
  const extIds = [email, actor.id != null ? String(actor.id) : ""].filter(Boolean);
  if (extIds.length) {
    // ① person_identity(수동 매핑 포함) → org_member 실재 확인(자동 생성 person 슬러그 배제).
    const r = await client.query(
      `SELECT pi.person_id FROM person_identity pi JOIN org_member om ON om.id = pi.person_id
        WHERE pi.system=$1 AND pi.external_id = ANY($2::text[]) LIMIT 1`,
      [system, extIds]);
    const hit = (r.rows[0] as { person_id: string } | undefined)?.person_id;
    if (hit) return hit;
  }
  if (email) {
    // ② org_member.email 직접 매치.
    const r = await client.query(
      `SELECT id FROM org_member WHERE lower(email)=$1 AND email <> '' LIMIT 1`, [email]);
    const hit = (r.rows[0] as { id: string } | undefined)?.id;
    if (hit) return hit;
  }
  // ③ raw 폴백(손실 0 — UI 는 raw 표시, 매핑 후 다음 싱크가 수렴).
  return email || (actor.id != null ? String(actor.id) : null);
}

// ms epoch(문자열/숫자) → 'YYYY-MM-DD'(KST — 조직 표준시. 원본 ms 는 fields 백스톱에 병존).
function msToKstDate(ms?: unknown): string | null {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const kst = new Date(n + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

// ── space/folder → project_folder 멱등 upsert. 컨테이너는 theirs-wins(이름·메타 — ClickUp 이 자기 계층의 권위). ──
//  adopt-by-name: external 미매치 + 동명(external 없음) 네이티브 폴더가 있으면 좌표를 접붙인다(중복 컨테이너 방지 —
//  기존 배포처럼 네이티브 리스트/폴더가 먼저 있던 DB 에 커넥터를 켜는 업그레이드 경로).
async function mirrorPmFolderV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  const name = redactString(String(it.title ?? externalId));
  const f = (it.fields ?? {}) as Record<string, unknown>;
  const settingsPatch = redactDeep({ clickup: f }) as Record<string, unknown>;
  const raw = it.raw == null ? null : redactDeep(it.raw);
  const color = typeof f.color === "string" ? f.color : null;

  // 부모(스페이스) 해소 — folder 타입만. 스트림이 space 를 먼저 흘리므로 보통 즉시 해소.
  let parentId: number | null = null;
  if (it.type === "folder" && it.parent_external_id) {
    parentId = await folderIdByExternal(client, system, instance, it.parent_external_id);
  }

  const prev = await client.query(
    `SELECT id, settings FROM project_folder WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
    [system, instance, externalId]);
  let row = prev.rows[0] as { id: number; settings: Record<string, unknown> | null } | undefined;

  if (!row) {
    // adopt-by-name(1건 한정, 좌표 없는 네이티브만).
    const adopt = await client.query(
      `SELECT id, settings FROM project_folder WHERE external_id IS NULL AND name=$1 ORDER BY id LIMIT 1`, [name]);
    row = adopt.rows[0] as typeof row;
  }

  if (row) {
    const mergedSettings = { ...(row.settings ?? {}), ...settingsPatch };
    await client.query(
      `UPDATE project_folder SET name=$2, color=COALESCE($3, color), parent_id=$4, settings=$5::jsonb,
          external_system=$6, external_instance=$7, external_id=$8, updated_at=now()
        WHERE id=$1`,
      [row.id, name, color, parentId, JSON.stringify({ ...mergedSettings, _raw: raw }), system, instance, externalId]);
  } else {
    await client.query(
      `INSERT INTO project_folder(name, color, parent_id, settings, created_by, external_system, external_instance, external_id)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
      [name, color, parentId, JSON.stringify({ ...settingsPatch, _raw: raw }), `connector:${system}`, system, instance, externalId]);
  }
  return true;
}

// ── list → project_list 멱등 upsert + settings.statuses(#475 UI 계약) 이관. ──
//  settings 병합 규칙: 커넥터 소유 키(statusMode/statuses/clickup)만 갱신, 로컬 키(icon 등)는 보존.
async function mirrorPmListV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  const name = redactString(String(it.title ?? externalId));
  const f = (it.fields ?? {}) as Record<string, unknown>;
  const raw = it.raw == null ? null : redactDeep(it.raw);
  const statusDefs = Array.isArray(f.status_defs) ? (redactDeep(f.status_defs) as unknown[]) : [];

  // 부모 폴더(folder:... 또는 space:...) 해소.
  let folderId: number | null = null;
  if (it.parent_external_id) folderId = await folderIdByExternal(client, system, instance, it.parent_external_id);

  const prev = await client.query(
    `SELECT id, settings FROM project_list WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
    [system, instance, externalId]);
  let row = prev.rows[0] as { id: number; settings: Record<string, unknown> | null } | undefined;

  if (!row) {
    // adopt-by-name(좌표 없는 네이티브 동명 리스트 — 업그레이드 경로 중복 방지).
    const adopt = await client.query(
      `SELECT id, settings FROM project_list WHERE external_id IS NULL AND name=$1 ORDER BY id LIMIT 1`, [name]);
    row = adopt.rows[0] as typeof row;
  }

  const clickupMeta = redactDeep({
    content: f.content ?? null, orderindex: f.orderindex ?? null, archived: !!f.archived,
    task_count: f.task_count ?? null, start_date: f.start_date ?? null, due_date: f.due_date ?? null,
    space_id: f.space_id ?? null, space_name: f.space_name ?? null,
    folder_id: f.folder_id ?? null, folder_name: f.folder_name ?? null,
    override_statuses: !!f.override_statuses,
    field_defs: f.field_defs ?? [],
    _raw: raw,
  });

  if (row) {
    const merged: Record<string, unknown> = { ...(row.settings ?? {}), clickup: clickupMeta };
    if (statusDefs.length) { merged.statusMode = "custom"; merged.statuses = statusDefs; }
    await client.query(
      `UPDATE project_list SET name=$2, folder_id=$3, settings=$4::jsonb,
          external_system=$5, external_instance=$6, external_id=$7, updated_at=now()
        WHERE id=$1`,
      [row.id, name, folderId, JSON.stringify(merged), system, instance, externalId]);
  } else {
    const settings: Record<string, unknown> = { clickup: clickupMeta };
    if (statusDefs.length) { settings.statusMode = "custom"; settings.statuses = statusDefs; }
    await client.query(
      `INSERT INTO project_list(name, folder_id, settings, created_by, external_system, external_instance, external_id)
        VALUES($1,$2,$3::jsonb,$4,$5,$6,$7)`,
      [name, folderId, JSON.stringify(settings), `connector:${system}`, system, instance, externalId]);
  }
  return true;
}

// ── view → project_view 멱등 upsert. 스코프(list|space|folder)별 FK 해소. config 는 원형 보존. ──
async function mirrorPmViewV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  const name = redactString(String(it.title ?? externalId));
  const f = (it.fields ?? {}) as Record<string, unknown>;
  const scopeKind = String(f.scope_kind ?? "list");
  const viewType = String(f.view_type ?? "list");
  const config = redactDeep({ ...(f.config as Record<string, unknown> ?? {}), _raw: it.raw ?? null });

  let listId: number | null = null;
  let folderId: number | null = null;
  if (it.parent_external_id) {
    if (scopeKind === "list") listId = await listIdByExternal(client, system, instance, it.parent_external_id);
    else folderId = await folderIdByExternal(client, system, instance, it.parent_external_id);
  }
  if (listId == null && folderId == null) return false; // 스코프 미해소 — 다음 싱크 수렴(컨테이너가 먼저 적재되면 해소)

  await client.query(
    `INSERT INTO project_view(list_id, folder_id, name, type, config, created_by, external_system, external_instance, external_id)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
     ON CONFLICT (external_system, external_instance, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET list_id=EXCLUDED.list_id, folder_id=EXCLUDED.folder_id, name=EXCLUDED.name,
        type=EXCLUDED.type, config=EXCLUDED.config, updated_at=now()`,
    [listId, folderId, name, viewType, JSON.stringify(config), `connector:${system}`, system, instance, externalId]);
  return true;
}

// ── comment → task_comment 멱등 upsert(원시각 보존·답글 1단 해소·반응 미러). ──
async function mirrorPmCommentV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  const f = (it.fields ?? {}) as Record<string, unknown>;
  const taskExt = String(f.task_external_id ?? it.parent_external_id ?? "");
  if (!taskExt) return false;
  const taskId = await projectIdByExternal(client, system, instance, taskExt);
  if (taskId == null) return false; // 귀속 태스크 미적재 — 스트림 순서상 드묾, 다음 싱크 수렴

  const author = await resolveMemberId(client, system, f.author as { id?: unknown; email?: unknown } | null)
    ?? `connector:${system}`;
  const body = redactString(String(it.body ?? ""));
  const raw = it.raw == null ? null : redactDeep(it.raw);

  let replyTo: number | null = null;
  const replyExt = f.reply_to_external_id ? String(f.reply_to_external_id) : null;
  if (replyExt) {
    const r = await client.query(`SELECT id FROM task_comment WHERE external_id=$1`, [replyExt]);
    replyTo = (r.rows[0] as { id: number } | undefined)?.id ?? null;
  }

  const res = await client.query(
    `INSERT INTO task_comment(task_id, author, body, reply_to, created_at, external_id, raw)
      VALUES($1,$2,$3,$4,COALESCE($5::timestamptz, now()),$6,$7::jsonb)
     ON CONFLICT (external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET body=EXCLUDED.body, author=EXCLUDED.author, reply_to=COALESCE(EXCLUDED.reply_to, task_comment.reply_to), raw=EXCLUDED.raw
     RETURNING id`,
    [taskId, author, body, replyTo, it.occurred_at ?? null, externalId, raw == null ? null : JSON.stringify(raw)]);
  const commentId = (res.rows[0] as { id: number }).id;

  // 반응(이모지) 미러 — ClickUp reactions [{reaction, user}] → task_comment_reaction 멱등.
  const reactions = Array.isArray(f.reactions) ? f.reactions as Array<Record<string, unknown>> : [];
  for (const rx of reactions) {
    const emoji = typeof rx?.reaction === "string" ? rx.reaction : null;
    if (!emoji) continue;
    const member = await resolveMemberId(client, system, rx?.user as { id?: unknown; email?: unknown } | null) ?? "clickup";
    await client.query(
      `INSERT INTO task_comment_reaction(comment_id, emoji, member) VALUES($1,$2,$3)
       ON CONFLICT (comment_id, emoji, member) DO NOTHING`,
      [commentId, emoji, member]);
  }
  return true;
}

// ── time → task_time_entry 멱등 upsert. ──
async function mirrorPmTimeV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  const f = (it.fields ?? {}) as Record<string, unknown>;
  const taskExt = String(f.task_external_id ?? it.parent_external_id ?? "");
  if (!taskExt) return false;
  const taskId = await projectIdByExternal(client, system, instance, taskExt);
  if (taskId == null) return false;
  const member = typeof f.member === "string" ? f.member : null;
  const resolved = member ? await resolveMemberId(client, system, { email: member.includes("@") ? member : undefined, id: member.includes("@") ? undefined : member }) : null;

  await client.query(
    `INSERT INTO task_time_entry(task_id, member, started_at, ended_at, duration_seconds, note, source, external_id)
      VALUES($1,$2,$3,$4,$5,$6,'manual',$7)
     ON CONFLICT (external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET task_id=EXCLUDED.task_id, member=EXCLUDED.member, started_at=EXCLUDED.started_at,
        ended_at=EXCLUDED.ended_at, duration_seconds=EXCLUDED.duration_seconds, note=EXCLUDED.note`,
    [taskId, resolved ?? member, f.started_at ?? null, f.ended_at ?? null,
     f.duration_seconds ?? null, f.note == null ? null : redactString(String(f.note)), externalId]);
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// ── 태스크 부속 동기(#541) — mirrorProjectV6 가 호출. 모두 external 좌표 멱등. ──
// ════════════════════════════════════════════════════════════════════════════

// 태그 — task_tag(lower(name) upsert, color=bg) + task_tag_link 집합 3-way(base 는 external_base.tags).
//  집합 연산은 **lower 정규화 키**로(#541 리뷰) — task_tag 정체성이 lower(name) 유니크라, 케이스만 다른 표기를
//  구분하면 base 에 두 표기가 쌓여 싱크마다 링크 삭제/재추가로 진동한다. 표시 이름은 DB 기존 표기 우선.
async function syncMirrorTags(
  client: pg.PoolClient, taskId: number,
  baseTags: string[] | null, theirsTags: Array<{ name: string; fg?: string | null; bg?: string | null }>,
): Promise<string[]> {
  const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
  const cur = await client.query(
    `SELECT t.name FROM task_tag_link l JOIN task_tag t ON t.id=l.tag_id WHERE l.task_id=$1`, [taskId]);
  const oursOrig = (cur.rows as Array<{ name: string }>).map((r) => r.name);
  const ours = oursOrig.map(norm);
  const theirsOrig = theirsTags.map((t) => t.name).filter(Boolean);
  const theirs = theirsOrig.map(norm);
  const merged = mergeSet((baseTags ?? []).map(norm), ours, theirs);

  // 표시 이름/색: theirs 원문 → ours(DB 기존 표기)가 덮음(기존 태그 표기 보존).
  const displayOf = new Map<string, string>();
  for (const n of theirsOrig) displayOf.set(norm(n), n);
  for (const n of oursOrig) displayOf.set(norm(n), n);
  const colorOf = new Map(theirsTags.map((t) => [norm(t.name), t.bg ?? null]));

  for (const key of merged) {
    if (ours.includes(key)) continue;
    const tag = await client.query(
      `INSERT INTO task_tag(name, color) VALUES($1,$2)
       ON CONFLICT (lower(name)) DO UPDATE SET color=COALESCE(task_tag.color, EXCLUDED.color)
       RETURNING id`,
      [displayOf.get(key) ?? key, colorOf.get(key) ?? null]);
    await client.query(
      `INSERT INTO task_tag_link(task_id, tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [taskId, (tag.rows[0] as { id: number }).id]);
  }
  for (const key of ours) {
    if (merged.includes(key)) continue;
    await client.query(
      `DELETE FROM task_tag_link WHERE task_id=$1 AND tag_id=(SELECT id FROM task_tag WHERE lower(name)=$2)`,
      [taskId, key]);
  }
  return merged;
}

// 체크리스트 — external_id 멱등 upsert + 외부 소멸분 삭제(외부 키 있는 행만 — 로컬 체크리스트 불가침).
async function syncMirrorChecklists(
  client: pg.PoolClient, system: string, taskId: number,
  theirs: Array<{ external_id: string; name?: string | null; orderindex?: number | null;
    items?: Array<{ external_id: string; name?: string | null; resolved?: boolean; orderindex?: number | null;
      assignee?: { id?: unknown; email?: unknown } | null }> }>,
): Promise<void> {
  const keepCl = new Set<string>();
  for (const cl of theirs) {
    if (!cl?.external_id) continue;
    keepCl.add(cl.external_id);
    const r = await client.query(
      `INSERT INTO task_checklist(task_id, name, sort, external_id)
        VALUES($1,$2,$3,$4)
       ON CONFLICT (external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET task_id=EXCLUDED.task_id, name=EXCLUDED.name, sort=EXCLUDED.sort
       RETURNING id`,
      [taskId, redactString(String(cl.name ?? "")), Math.round(Number(cl.orderindex ?? 0)) || 0, cl.external_id]);
    const clId = (r.rows[0] as { id: number }).id;

    const keepItems = new Set<string>();
    for (const item of cl.items ?? []) {
      if (!item?.external_id) continue;
      keepItems.add(item.external_id);
      const assignee = await resolveMemberId(client, system, item.assignee ?? null);
      await client.query(
        `INSERT INTO task_checklist_item(checklist_id, name, done, assignee, sort, external_id)
          VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET checklist_id=EXCLUDED.checklist_id, name=EXCLUDED.name, done=EXCLUDED.done,
            assignee=EXCLUDED.assignee, sort=EXCLUDED.sort`,
        [clId, redactString(String(item.name ?? "")), !!item.resolved, assignee,
         Math.round(Number(item.orderindex ?? 0)) || 0, item.external_id]);
    }
    await client.query(
      `DELETE FROM task_checklist_item WHERE checklist_id=$1 AND external_id IS NOT NULL AND NOT (external_id = ANY($2::text[]))`,
      [clId, [...keepItems]]);
  }
  await client.query(
    `DELETE FROM task_checklist WHERE task_id=$1 AND external_id IS NOT NULL AND NOT (external_id = ANY($2::text[]))`,
    [taskId, [...keepCl]]);
}

// ClickUp 커스텀필드 타입 → 우리 task_field 타입(task-field-store FIELD_TYPES). 미지 타입은 text(+원본 config 보존).
function mapClickUpFieldType(t?: string | null): string {
  switch (t) {
    case "text": case "short_text": return "text";
    case "textarea": return "textarea";
    case "number": return "number";
    case "money": case "currency": return "money";
    case "date": return "date";
    case "drop_down": return "dropdown";
    case "labels": return "labels";
    case "checkbox": return "checkbox";
    case "url": return "website";
    case "email": return "email";
    case "phone": return "phone";
    case "emoji": case "rating": return "rating";
    case "manual_progress": return "progress";
    case "automatic_progress": return "progress_auto";
    case "tasks": case "list_relationship": return "relationship";
    case "location": return "location";
    default: return "text";
  }
}

// ClickUp type_config → 우리 config(dropdown/labels options=[{id,label,color}], money currency, rating max).
function mapClickUpFieldConfig(t: string | null | undefined, tc: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  const options = Array.isArray(tc?.options) ? tc!.options as Array<Record<string, unknown>> : [];
  if (t === "drop_down" || t === "labels") {
    cfg.options = options.map((o) => ({
      id: String(o.id ?? o.orderindex ?? o.name ?? ""),
      label: String(o.name ?? o.label ?? ""),
      color: (o.color as string | null) ?? null,
    }));
  }
  if (t === "money") cfg.currency = (tc?.currency_type as string) ?? "USD";
  if (t === "emoji" || t === "rating") cfg.max = Number(tc?.count ?? 5) || 5;
  cfg.clickup = { type: t ?? null, type_config: tc ?? null }; // 원본 정의 백스톱
  return cfg;
}

// ClickUp 필드값 → 우리 value(JSONB). 타입별 디코드, 실패는 원본 그대로(JSONB 수용 — 손실 0).
function mapClickUpFieldValue(t: string | null | undefined, value: unknown, tc: Record<string, unknown> | null | undefined): unknown {
  if (value === undefined || value === null) return null;
  try {
    const options = Array.isArray(tc?.options) ? tc!.options as Array<Record<string, unknown>> : [];
    const optId = (v: unknown): string | null => {
      const byId = options.find((o) => String(o.id) === String(v));
      if (byId) return String(byId.id);
      const byIdx = options.find((o) => Number(o.orderindex) === Number(v));
      return byIdx ? String(byIdx.id ?? byIdx.orderindex) : null;
    };
    switch (t) {
      case "drop_down": return optId(value) ?? value;
      case "labels": return Array.isArray(value) ? value.map((v) => optId(v) ?? String(v)) : value;
      case "checkbox": return value === true || value === "true";
      case "number": case "money": case "emoji": case "rating": {
        const n = Number(value); return Number.isFinite(n) ? n : value;
      }
      case "date": return msToKstDate(value) ?? value;
      case "users": return Array.isArray(value)
        ? (value as Array<Record<string, unknown>>).map((u) => String(u?.username ?? u?.email ?? u?.id ?? "")).filter(Boolean).join(", ")
        : value;
      case "manual_progress": case "automatic_progress": {
        const pc = (value as Record<string, unknown>)?.percent_complete ?? (value as Record<string, unknown>)?.current ?? value;
        const n = Number(pc); return Number.isFinite(n) ? Math.round(n) : value;
      }
      default: return typeof value === "string" ? value : value;
    }
  } catch { return value; }
}

// 커스텀필드 — 정의는 태스크의 **루트 프로젝트**에 복제 upsert((project_id, external_id) 멱등), 값은 이 행에.
//  값 부재 필드는 값 행 삭제(reconcile — ClickUp 에서 지운 값 수렴). 정의 삭제는 안 함(보수적 — 값만 사라짐).
async function syncMirrorCustomFields(
  client: pg.PoolClient, system: string, taskId: number, rootProjectId: number,
  theirs: Array<{ external_id: string; name?: string | null; type?: string | null;
    type_config?: Record<string, unknown> | null; value?: unknown; value_markdown?: string | null }>,
): Promise<void> {
  for (const cf of theirs) {
    if (!cf?.external_id) continue;
    const ftype = mapClickUpFieldType(cf.type);
    const config = redactDeep(mapClickUpFieldConfig(cf.type, cf.type_config ?? null));
    const r = await client.query(
      `INSERT INTO task_field(project_id, field_type, name, config, created_by, external_id)
        VALUES($1,$2,$3,$4::jsonb,$5,$6)
       ON CONFLICT (project_id, external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET name=EXCLUDED.name, config=EXCLUDED.config
       RETURNING id`,
      [rootProjectId, ftype, redactString(String(cf.name ?? cf.external_id)).slice(0, 120),
       JSON.stringify(config), `connector:${system}`, cf.external_id]);
    const fieldId = (r.rows[0] as { id: number }).id;

    const hasValue = cf.value !== undefined && cf.value !== null;
    if (hasValue) {
      const decoded = redactDeep(mapClickUpFieldValue(cf.type, cf.value, cf.type_config ?? null));
      await client.query(
        `INSERT INTO task_field_value(field_id, task_id, value) VALUES($1,$2,$3::jsonb)
         ON CONFLICT (field_id, task_id) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
        [fieldId, taskId, JSON.stringify(decoded)]);
    } else {
      await client.query(`DELETE FROM task_field_value WHERE field_id=$1 AND task_id=$2`, [fieldId, taskId]);
    }
  }
}

// 첨부 — external_id(네이티브)/(task_id,url)(인라인) 멱등 upsert + 외부 소멸분 삭제(clickup 소스 행만).
async function syncMirrorAttachments(
  client: pg.PoolClient, system: string, taskId: number,
  theirs: Array<{ external_id?: string | null; title?: string | null; url?: string | null; mimetype?: string | null;
    extension?: string | null; size?: number | null; thumbnail?: string | null; parent_type?: string | null;
    source?: string | null; raw?: unknown }>,
): Promise<void> {
  const keepExt: string[] = [];
  const keepUrls: string[] = [];
  for (const a of theirs) {
    const raw = a.raw == null ? null : redactDeep(a.raw);
    if (a.external_id) {
      keepExt.push(a.external_id);
      await client.query(
        `INSERT INTO task_attachment(task_id, external_id, title, url, mimetype, extension, size, source, thumbnail, parent_type, raw)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         ON CONFLICT (external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET task_id=EXCLUDED.task_id, title=EXCLUDED.title, url=EXCLUDED.url, mimetype=EXCLUDED.mimetype,
            extension=EXCLUDED.extension, size=EXCLUDED.size, thumbnail=EXCLUDED.thumbnail, raw=EXCLUDED.raw`,
        [taskId, a.external_id, a.title ?? null, a.url ?? null, a.mimetype ?? null, a.extension ?? null,
         a.size ?? null, a.source ?? system, a.thumbnail ?? null, a.parent_type ?? "tasks",
         raw == null ? null : JSON.stringify(raw)]);
    } else if (a.url) {
      keepUrls.push(a.url);
      await client.query(
        `INSERT INTO task_attachment(task_id, title, url, source, parent_type)
          VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (task_id, url) WHERE external_id IS NULL AND url IS NOT NULL
         DO UPDATE SET title=EXCLUDED.title`,
        [taskId, a.title ?? null, a.url, a.source ?? `${system}_inline`, a.parent_type ?? "task_inline"]);
    }
  }
  // 소멸 reconcile — 이 태스크의 clickup 계열 행 중 이번 수집에 없는 것 삭제(로컬/타소스 행 불가침).
  await client.query(
    `DELETE FROM task_attachment
      WHERE task_id=$1 AND source LIKE $2
        AND ((external_id IS NOT NULL AND NOT (external_id = ANY($3::text[])))
          OR (external_id IS NULL AND url IS NOT NULL AND NOT (url = ANY($4::text[]))))`,
    [taskId, `${system}%`, keepExt, keepUrls]);
}

// 의존성/링크 — 양측이 미러에 존재할 때 task_link 멱등 insert(+상호 역방향). 추가 전용(삭제는 raw 백스톱 기준 후속).
async function syncMirrorLinks(
  client: pg.PoolClient, system: string, instance: string, taskId: number, taskExt: string,
  dependencies: Array<Record<string, unknown>>, linked: Array<Record<string, unknown>>,
): Promise<void> {
  const put = async (from: number, to: number, type: string) => {
    await client.query(
      `INSERT INTO task_link(from_task, to_task, type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [from, to, type]);
  };
  for (const d of dependencies) {
    const a = String(d?.task_id ?? ""); const b = String(d?.depends_on ?? "");
    if (!a || !b) continue;
    const otherExt = a === taskExt ? b : b === taskExt ? a : null;
    if (!otherExt) continue;
    const otherId = await projectIdByExternal(client, system, instance, otherExt);
    if (otherId == null) continue;
    if (a === taskExt) { await put(taskId, otherId, "waiting_on"); await put(otherId, taskId, "blocking"); }
    else { await put(taskId, otherId, "blocking"); await put(otherId, taskId, "waiting_on"); }
  }
  for (const l of linked) {
    const otherExt = String(l?.task_id ?? l?.link_id ?? "");
    if (!otherExt || otherExt === taskExt) continue;
    const otherId = await projectIdByExternal(client, system, instance, otherExt);
    if (otherId == null) continue;
    await put(taskId, otherId, "linked"); await put(otherId, taskId, "linked");
  }
}

// clickup task → project(level='project'|'task'|'subtask') 멱등 upsert. 본문 실변경 시에만 audit. true=적재, false=skip.
//  level: 커넥터가 it.level 로 위계 전달(ClickUp Task 깊이→우리 level). it.level 부재(타 커넥터)면 parent 유무로 폴백.
//  #541 무손실: fields/raw 백스톱 + list_id/priority/dates/status_raw/assignee(3-way base 확장) +
//  부속(태그·체크리스트·커스텀필드·첨부·링크) 동기. 부모는 스트림 위상순서로 대부분 즉시 해소(+run-sync heal).
async function mirrorProjectV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  // 🔴H1 redact — name(title)/description(body)/external_url 평문 시크릿 마스킹.
  const name = it.title == null ? "" : redactString(String(it.title));
  const description = it.body == null ? null : redactString(String(it.body));
  const level = it.level ?? (it.parent_external_id ? "task" : "project");
  const author = `connector:${system}`;
  const f = (it.fields ?? {}) as Record<string, unknown>;
  const fieldsJson = redactDeep(f);
  const rawJson = it.raw == null ? null : redactDeep(it.raw);

  // ── theirs 값 도출 ──
  const statusCategory = typeof f.status_category === "string" ? f.status_category : "unstarted";
  const priorityLabel = (f.priority as Record<string, unknown> | null)?.label;
  const priority = typeof priorityLabel === "string" && ["urgent", "high", "normal", "low"].includes(priorityLabel) ? priorityLabel : null;
  const startDate = msToKstDate(f.start_date_ms);
  const dueDate = msToKstDate(f.due_date_ms);
  const listExt = f.list_id != null ? String(f.list_id) : null;

  // 소속 리스트 행(1쿼리) — list_id 해소 + status key 매핑(settings.statuses) 겸용. 스트림이 리스트를 먼저 흘리므로 보통 존재.
  const listRow = listExt
    ? ((await client.query(
        `SELECT id, settings FROM project_list WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
        [system, instance, listExt])).rows[0] as { id: number; settings: Record<string, unknown> | null } | undefined) ?? null
    : null;

  // status_raw = 리스트 settings.statuses 에서 **라벨 매치**로 key 채택(키 충돌 dedup(-2 접미) 정합 — #541 리뷰).
  //  리스트 미적재/라벨 미스매치면 슬러그 폴백(clickUpStatusKey 동형 — 자기일관).
  const statusLabel = f.status != null ? String(f.status) : null;
  let statusRaw: string | null = null;
  if (statusLabel) {
    const defs = Array.isArray((listRow?.settings as Record<string, unknown> | null)?.statuses)
      ? (listRow!.settings!.statuses as Array<{ key?: unknown; label?: unknown }>) : [];
    const hit = defs.find((s) => s && String(s.label ?? "") === statusLabel);
    statusRaw = hit?.key
      ? String(hit.key)
      : (statusLabel.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "status");
  }

  // 담당자 해소(3단 폴백) — theirs 를 member_id 배열로.
  const assigneesRaw = Array.isArray(f.assignees) ? f.assignees as Array<{ id?: unknown; email?: unknown }> : [];
  const theirsAssignees: string[] = [];
  for (const a of assigneesRaw) {
    const m = await resolveMemberId(client, system, a);
    if (m && !theirsAssignees.includes(m)) theirsAssignees.push(m);
  }
  const theirsAssigneeCol = theirsAssignees.length ? JSON.stringify(theirsAssignees) : null; // UI 규약(JSON 배열 문자열)

  // 부모 task 행 내부 id — 스트림이 부모 우선이라 보통 해소됨(미해소면 NULL → heal 패스 수렴).
  let parentId: number | null = null;
  if (it.parent_external_id) parentId = await projectIdByExternal(client, system, instance, it.parent_external_id);

  // ── 기존 행 조회 — 3-way 머지 base(external_base) + 감사 스냅샷. ──
  const prev = await client.query(
    `SELECT id, name, description, status, status_raw, status_category, priority, start_date, due_date,
            assignee, list_id, external_base
       FROM project
      WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
    [system, instance, externalId],
  );
  const prevRow = prev.rows[0] as {
    id: number; name: string; description: string | null;
    status: string; status_raw: string | null; status_category: string | null;
    priority: string | null; start_date: string | null; due_date: string | null;
    assignee: string | null; list_id: number | null;
    external_base: Record<string, unknown> | null;
  } | undefined;
  const isInsert = !prevRow;

  let id: number;
  let appliedName = name;
  let appliedDesc: string | null = description;
  let changed: boolean;
  const theirsTags = Array.isArray(f.tags) ? f.tags as Array<{ name: string; fg?: string | null; bg?: string | null }> : [];

  if (isInsert) {
    // 최초 import — theirs 채택. external_base=theirs(다음 3-way 의 공통조상). tags 는 lower 정규화 키(케이스 무시 집합).
    const listId = listRow?.id ?? null;
    const baseJson = JSON.stringify({
      name, description, status_category: statusCategory, status_raw: statusRaw,
      priority, start_date: startDate, due_date: dueDate, assignee: theirsAssigneeCol,
      list_ext: listExt, tags: theirsTags.map((t) => String(t.name).trim().toLowerCase()),
    });
    const ins = await client.query(
      `INSERT INTO project(
          level, parent_id, name, description, status, status_raw, status_category, created_by,
          priority, start_date, due_date, assignee, list_id,
          external_system, external_instance, external_id, external_url, external_base,
          fields, raw, created_at, updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20::jsonb,now(),now())
       RETURNING id`,
      [level, parentId, name, description, nativeStatusOf(statusCategory), statusRaw, statusCategory, author,
       priority, startDate, dueDate, theirsAssigneeCol, listId,
       system, instance, externalId, it.provenance.external_url ?? null, baseJson,
       JSON.stringify(fieldsJson), rawJson == null ? null : JSON.stringify(rawJson)],
    );
    id = (ins.rows[0] as { id: number }).id;
    let asort = 0;
    for (const m of theirsAssignees) {
      await client.query(
        `INSERT INTO task_assignee(task_id, member_id, sort) VALUES($1,$2,$3) ON CONFLICT (task_id, member_id) DO NOTHING`,
        [id, m, asort++]);
    }
    changed = true;
  } else {
    // 기존 행 — 필드별 3-way 머지(base/ours/theirs). 충돌=ours(우리 DB master). 인바운드는 단일프로세스(스케줄러 락+배치 순차)라 SELECT→UPDATE TOCTOU 무시가능.
    id = prevRow!.id;
    // ⚠ 아웃박스 pending 가드(#541) — 직전 머지가 ours 우세로 끝나 푸시 대기 중이면, 그 푸시가 나가기 전의
    //  theirs 는 '아직 우리 값을 못 받은 구값'이다. base=merged 시맨틱상 o==b 로 보여 theirs 를 재채택(핑퐁)하므로,
    //  pending 동안은 base 를 **theirs 로 가장** → merge3 전 필드가 t==b → ours 유지(theirs 채택 봉인). 푸시
    //  드레인 후 다음 싱크부터 정상 3-way 재개. (푸시는 merged 를 PUT 하므로 pending 중 ClickUp 편집도 어차피 덮인다 — 일관.)
    const pendingPush = await client.query(
      `SELECT 1 FROM external_outbox WHERE system=$1 AND entity_id=$2 AND done_at IS NULL LIMIT 1`,
      [system, prevRow!.id]);
    const hasPendingPush = (pendingPush.rowCount ?? 0) > 0;
    const base = hasPendingPush
      ? {
          name, description, status_category: statusCategory,
          status_raw: statusRaw, priority, start_date: startDate,
          due_date: dueDate, assignee: theirsAssigneeCol, list_ext: listExt,
          tags: theirsTags.map((t) => String(t.name).trim().toLowerCase()),
        } as Record<string, unknown>
      : (prevRow!.external_base ?? null);
    const mName = merge3(base?.name as string | undefined, prevRow!.name, name) ?? "";
    const mDesc = merge3(base?.description as string | null | undefined, prevRow!.description, description);
    const mCat = merge3(base?.status_category as string | undefined, prevRow!.status_category, statusCategory) ?? "unstarted";
    let mRaw = merge3(base?.status_raw as string | null | undefined, prevRow!.status_raw, statusRaw);
    // 레거시 라벨 정규화(#541 업그레이드 경로) — 구버전 미러는 status_raw 에 **원문 라벨**("to do")을 심었고,
    //  레거시 base(3키)엔 status_raw 가 없어 merge3 가 충돌→ours 로 라벨을 영구 고착시킨다. 같은 상태의 표기
    //  차이(라벨 vs 슬러그 키)는 로컬 편집이 아니므로 슬러그가 일치하면 키 표기로 수렴(진짜 상태 변경은 슬러그가 달라 보존).
    if (mRaw && statusRaw && mRaw !== statusRaw) {
      const slugOf = (s: string) => s.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "status";
      if (slugOf(mRaw) === statusRaw) mRaw = statusRaw;
    }
    const mPriority = merge3(base?.priority as string | null | undefined, prevRow!.priority, priority);
    const mStart = merge3(base?.start_date as string | null | undefined, prevRow!.start_date, startDate);
    const mDue = merge3(base?.due_date as string | null | undefined, prevRow!.due_date, dueDate);
    const mAssignee = merge3(base?.assignee as string | null | undefined, prevRow!.assignee, theirsAssigneeCol);
    // 리스트 좌표 — ours 를 external id 로 환산해 base/theirs 와 비교(로컬 이동 보존, 외부 이동 수렴).
    let oursListExt: string | null = null;
    if (prevRow!.list_id != null) {
      const r = await client.query(`SELECT external_id FROM project_list WHERE id=$1`, [prevRow!.list_id]);
      oursListExt = (r.rows[0] as { external_id: string | null } | undefined)?.external_id ?? `__local:${prevRow!.list_id}`;
    }
    const mListExt = merge3(base?.list_ext as string | null | undefined, oursListExt, listExt);
    let mListId: number | null = prevRow!.list_id;
    if (mListExt !== oursListExt) {
      mListId = mListExt && !mListExt.startsWith("__local:")
        ? (mListExt === listExt ? (listRow?.id ?? null) : await listIdByExternal(client, system, instance, mListExt))
        : null;
    }
    // status_category 가 ours 로 유지되면 네이티브 status 도 ours 보존(active↔in_progress 동일카테고리 진동 방지). theirs 채택 시만 재투영.
    const mStatus = mCat === (prevRow!.status_category ?? null) ? prevRow!.status : nativeStatusOf(mCat);

    // 태그 집합 3-way(부속이지만 base 에 함께 실림).
    await syncMirrorTags(client, id, (base?.tags as string[] | undefined) ?? null, theirsTags);

    // ── base 전진 규칙(#541 리뷰) — 필드가 **외부로 수렴하는 경로가 있는지**에 따라 갈린다: ──
    //  · 푸시 필드(name/desc/status_category/priority/dates — mkBody 에 실림): base=merged. 우리값 우세 시
    //    아웃박스 푸시가 ClickUp 을 merged 로 끌어와 base 가 실제 공통조상이 된다.
    //  · 미푸시 필드(status_raw/assignee/list_ext/tags): base=**theirs**. merged 로 전진하면 다음 싱크에
    //    ours==base·theirs≠base 가 되어 theirs 재채택 → 로컬 편집이 두 번째 싱크에 조용히 원복된다.
    //    theirs 를 기록하면 t==b 로 ours 가 안정 유지되고, 외부 실변경 시에만 채택/충돌 판정이 돈다.
    const newBase = JSON.stringify({
      name: mName, description: mDesc, status_category: mCat,
      priority: mPriority, start_date: mStart, due_date: mDue,
      status_raw: statusRaw, assignee: theirsAssigneeCol, list_ext: listExt,
      tags: theirsTags.map((t) => String(t.name).trim().toLowerCase()),
    });
    await client.query(
      `UPDATE project SET
          level=$2, parent_id=COALESCE($3, parent_id),
          name=$4, description=$5, status=$6, status_raw=$7, status_category=$8,
          priority=$9, start_date=$10, due_date=$11, assignee=$12, list_id=$13,
          external_url=$14, external_base=$15::jsonb,
          fields=$16::jsonb, raw=$17::jsonb, updated_at=now()
        WHERE id=$1`,
      [id, level, parentId, mName, mDesc, mStatus, mRaw, mCat,
       mPriority, mStart, mDue, mAssignee, mListId,
       it.provenance.external_url ?? null, newBase,
       JSON.stringify(fieldsJson), rawJson == null ? null : JSON.stringify(rawJson)]);
    appliedName = mName; appliedDesc = mDesc;

    // task_assignee 섀도 동기(머지 결과 기준 통째 교체 — project-store.syncTaskAssignees 시맨틱).
    const mergedAssignees: string[] = (() => {
      if (!mAssignee) return [];
      try { const arr = JSON.parse(mAssignee); return Array.isArray(arr) ? arr.filter(Boolean) : [String(mAssignee)]; }
      catch { return [String(mAssignee)]; }
    })();
    await client.query(`DELETE FROM task_assignee WHERE task_id=$1`, [id]);
    let asort = 0;
    for (const m of mergedAssignees) {
      await client.query(
        `INSERT INTO task_assignee(task_id, member_id, sort) VALUES($1,$2,$3) ON CONFLICT (task_id, member_id) DO NOTHING`,
        [id, m, asort++]);
    }

    // 수렴 — 머지결과가 theirs 와 다르면(우리값 우세) ClickUp 도 merged 로 끌어와야 다음 싱크 진동 안 함 → 아웃박스(같은 client, 원자적).
    //  priority/dates 포함(#541) — mkBody 가 싣는 필드는 전부: base=merged 규칙(위)의 전제가 '우세 시 반드시 푸시'이므로.
    if (mName !== name || (mDesc ?? null) !== (description ?? null) || mCat !== statusCategory
      || (mPriority ?? null) !== (priority ?? null) || (mStart ?? null) !== (startDate ?? null) || (mDue ?? null) !== (dueDate ?? null)) {
      await client.query(
        `INSERT INTO external_outbox(entity_id, system, op) VALUES($1,$2,'upsert')
         ON CONFLICT (system, entity_id) WHERE done_at IS NULL
         DO UPDATE SET op='upsert', updated_at=now(), attempts=0, last_error=NULL`,
        [id, system]);
    }
    changed = (mName !== (prevRow!.name ?? "")) || ((mDesc ?? null) !== (prevRow!.description ?? null)) || (mCat !== (prevRow!.status_category ?? null));
  }

  // ── 부속 동기(무손실) — 태그(insert 경로), 체크리스트, 커스텀필드, 첨부, 링크. 모두 멱등·best-effort 아님(트랜잭션 내). ──
  if (isInsert && theirsTags.length) {
    await syncMirrorTags(client, id, null, theirsTags);
  }
  const checklists = Array.isArray(f.checklists) ? f.checklists as Parameters<typeof syncMirrorChecklists>[3] : [];
  await syncMirrorChecklists(client, system, id, checklists);

  // 커스텀필드 — 정의는 루트 프로젝트에. 루트 = 자기 자신(project) 또는 top_level_parent/parent 해소.
  const customFields = Array.isArray(f.custom_fields) ? f.custom_fields as Parameters<typeof syncMirrorCustomFields>[4] : [];
  if (customFields.length) {
    let rootId: number | null = level === "project" ? id : null;
    if (rootId == null) {
      const rawTask = (it.raw ?? {}) as { top_level_parent?: string | null; parent?: string | null };
      const rootExt = rawTask.top_level_parent ?? rawTask.parent ?? it.parent_external_id ?? null;
      if (rootExt) rootId = await projectIdByExternal(client, system, instance, String(rootExt));
    }
    if (rootId != null) await syncMirrorCustomFields(client, system, id, rootId, customFields);
  }

  const attachments = Array.isArray(f.attachments) ? f.attachments as Parameters<typeof syncMirrorAttachments>[3] : [];
  await syncMirrorAttachments(client, system, id, attachments);

  const deps = Array.isArray(f.dependencies) ? f.dependencies as Array<Record<string, unknown>> : [];
  const linked = Array.isArray(f.linked_tasks) ? f.linked_tasks as Array<Record<string, unknown>> : [];
  if (deps.length || linked.length) await syncMirrorLinks(client, system, instance, id, externalId, deps, linked);

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

// ── 힐 패스(#541) — 스트림 순서 밖(부모 미변경 증분 등)으로 미해소된 parent_id/list_id 를 raw/fields 백스톱으로 일괄 수렴. ──
//  run-sync 가 인제스트 후 1회 호출. 멱등 · 커넥터 행(external_system=$1)만.
export async function healPmMirror(client: pg.PoolClient, system: string): Promise<{ parents: number; lists: number; statusKeys: number }> {
  const p = await client.query(
    `UPDATE project c SET parent_id = par.id
       FROM project par
      WHERE c.external_system=$1 AND c.parent_id IS NULL AND c.raw->>'parent' IS NOT NULL
        AND par.external_system=$1 AND par.external_instance=c.external_instance
        AND par.external_id = c.raw->>'parent' AND par.id <> c.id`,
    [system]);
  const l = await client.query(
    `UPDATE project c SET list_id = pl.id
       FROM project_list pl
      WHERE c.external_system=$1 AND c.list_id IS NULL AND c.level='project' AND c.fields->>'list_id' IS NOT NULL
        AND pl.external_system=$1 AND pl.external_instance=c.external_instance
        AND pl.external_id = c.fields->>'list_id'`,
    [system]);
  // 레거시 status_raw 라벨→키 일괄 정규화(#541 업그레이드) — 구버전 미러가 심은 원문 라벨("to do")을 소속 리스트
  //  settings.statuses 의 label 매치로 key("to-do")로 수렴. 재미러(증분 창) 밖의 옛 행도 UI 커스텀 상태 그룹에 즉시 합류.
  //  task/subtask 행은 list_id 가 없으므로 부모 체인(≤2단: subtask→task→project)으로 루트의 리스트를 해소.
  const s = await client.query(
    `UPDATE project c SET status_raw = st->>'key'
       FROM project_list pl, jsonb_array_elements(COALESCE(pl.settings->'statuses','[]'::jsonb)) st
      WHERE c.external_system=$1
        AND pl.id = COALESCE(c.list_id,
              (SELECT COALESCE(p1.list_id, p2.list_id)
                 FROM project p1 LEFT JOIN project p2 ON p2.id = p1.parent_id
                WHERE p1.id = c.parent_id))
        AND c.status_raw IS NOT NULL AND st->>'label' = c.status_raw AND st->>'key' <> c.status_raw`,
    [system]);
  return { parents: p.rowCount ?? 0, lists: l.rowCount ?? 0, statusKeys: s.rowCount ?? 0 };
}

// ── 단일 RawItem → v6 적재(라우팅). ingestItems 의 client 공유 — item 단위 BEGIN/COMMIT(다중 테이블 원자성). ──
//  라우팅: routeIngestV6(type, system) → project|knowledge|source|pm_* | null(미정의=skip).
//  external_id 부재(이론상 불가)면 멱등키가 없어 skip. 적재 시 true, skip 시 false.
export async function mirrorExternalToV6(client: pg.PoolClient, it: RawItem): Promise<boolean> {
  const system = it.provenance.system;
  const externalId = it.provenance.external_id;
  if (!externalId) return false;
  const target = routeIngestV6(it.type, system);
  if (target == null) return false; // 라우팅 정의 밖 — 미러 skip(보수적, 임의 분류 금지).

  await client.query("BEGIN");
  try {
    let ok = false;
    if (target === "project") ok = await mirrorProjectV6(client, it, system, externalId);
    else if (target === "knowledge") ok = await mirrorKnowledgeV6(client, it, system, externalId);
    else if (target === "source") ok = await mirrorSourceV6(client, it, system, externalId);
    else if (target === "pm_folder") ok = await mirrorPmFolderV6(client, it, system, externalId);
    else if (target === "pm_list") ok = await mirrorPmListV6(client, it, system, externalId);
    else if (target === "pm_view") ok = await mirrorPmViewV6(client, it, system, externalId);
    else if (target === "pm_comment") ok = await mirrorPmCommentV6(client, it, system, externalId);
    else if (target === "pm_time") ok = await mirrorPmTimeV6(client, it, system, externalId);
    await client.query("COMMIT");
    return ok;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err; // ingestItems 가 warn 격리 — 다음 싱크 멱등 수렴
  }
}

// ════════ #551 노션 무손실 싱크 — run-sync 후처리(set 기반, 멱등) ════════
//  적재(ingestItems) 뒤에 run-sync 가 호출한다. 전부 SQL set 연산이라 재실행·부분실행 안전(수렴형).
type PgRunner = pg.Pool | pg.PoolClient;

/** fields.notion.links → knowledge_link 물질화. 커넥터 origin 링크만 재작성(사람 링크 불가침).
 *  타깃이 아직 미적재면 그 엣지는 이번엔 생략 — 매 싱크 전체 재계산이라 다음 run 에 자동 수렴. */
export async function materializeNotionLinks(db: pg.Pool): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM knowledge_link WHERE origin='connector:notion'`);
    const r = await client.query(
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
    await client.query("COMMIT");
    return r.rowCount ?? 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** 부모의 fields.notion.children_order → 자식 knowledge.sort 수렴.
 *  증분에서 부모만 변경돼도(자식 재정렬) 자식 행 재적재 없이 순서가 맞는다. updated_at 은 건드리지 않는다(노이즈 방지). */
export async function applyNotionChildrenOrder(db: PgRunner): Promise<number> {
  const r = await db.query(
    `UPDATE knowledge c SET sort = ord.idx
     FROM (
       SELECT p.name AS pname, p.external_instance AS inst, elem.value AS child_ext, (elem.ordinality - 1)::int AS idx
       FROM knowledge p,
            jsonb_array_elements_text(COALESCE(p.fields->'notion'->'children_order', '[]'::jsonb))
              WITH ORDINALITY AS elem(value, ordinality)
       WHERE p.external_system='notion' AND p.lifecycle='active'
     ) ord
     WHERE c.external_system='notion'
       AND c.external_instance = ord.inst
       AND c.external_id = ord.child_ext
       AND c.parent_name = ord.pname   -- 현재 부모의 순서만 — 이동 전 부모(스테일/아카이브)의 children_order 이중 매치 차단
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

// ── notion 원장 스냅샷(#586 델타 증분) — 커넥터가 '이미 아는 것'과 대조해 변경분만 수집하게 한다. ──
//  원장 = knowledge.raw 의 last_edited_time 이 진실(노션 분 단위 절사 그대로 저장됨 — search 결과와 문자열 동등 비교 가능).
export interface NotionLedgerEntry {
  lastEdited: string | null;   // page/database 의 last_edited_time(ISO, 분 절사)
  /** 이 행을 마지막으로 적재한 시각 — 분 절사 동률 판정(같은 분 재편집 가시성)에 필요 */
  syncedAt: string | null;
  parentExt: string | null;    // 트리 부모 external id
  kind: string;                // page | db_row | database
  title: string;
  lifecycle: string;           // active | archived
  /** database 전용 — 저장된 data_sources 의 last_edited_time 최대값(스키마 변경 감지용) */
  dsEdited: string | null;
  /** database 전용 — linked 뷰 등 행 조회 미지원(가속 full 에서 무의미한 query 400 왕복 생략) */
  unsupported: boolean;
  /** body 가 참조하는 다운로드 자산 파일명들 — 가속 full 의 스킵 판정 시 디스크 존재 검사(자산 자가치유) */
  assets?: string[];
}
export interface NotionLedger {
  byId: Map<string, NotionLedgerEntry>;
  /** data_source id → 소유 database id (저장된 fields.notion.data_source_ids 역매핑) */
  dsToDb: Map<string, string>;
  /** 역링크: target ext id → 그걸 본문에서 참조하는 페이지들의 ext id — 개명 시 멘션 제목 캐시 재렌더용 */
  backlinks: Map<string, string[]>;
}

export async function loadNotionLedger(db: PgRunner): Promise<NotionLedger> {
  const r = await db.query(
    `SELECT external_id, title, lifecycle, parent_external_id, last_synced_at,
            fields->'notion'->>'kind' AS kind,
            fields->'notion'->>'unsupported' AS unsupported,
            COALESCE(raw->'page'->>'last_edited_time', raw->'database'->>'last_edited_time') AS last_edited,
            (SELECT max(ds->>'last_edited_time') FROM jsonb_array_elements(COALESCE(raw->'data_sources','[]'::jsonb)) AS ds) AS ds_edited,
            fields->'notion'->'data_source_ids' AS ds_ids
     FROM knowledge WHERE external_system='notion' AND external_id IS NOT NULL`);
  const byId = new Map<string, NotionLedgerEntry>();
  const dsToDb = new Map<string, string>();
  for (const row of r.rows as Array<Record<string, unknown>>) {
    const id = String(row.external_id);
    byId.set(id, {
      lastEdited: row.last_edited == null ? null : String(row.last_edited),
      syncedAt: row.last_synced_at == null ? null : new Date(row.last_synced_at as string | Date).toISOString(),
      parentExt: row.parent_external_id == null ? null : String(row.parent_external_id),
      kind: String(row.kind ?? "page"),
      title: String(row.title ?? ""),
      lifecycle: String(row.lifecycle ?? "active"),
      dsEdited: row.ds_edited == null ? null : String(row.ds_edited),
      unsupported: row.unsupported === "true",
    });
    if (Array.isArray(row.ds_ids)) {
      for (const ds of row.ds_ids as unknown[]) if (typeof ds === "string" && ds) dsToDb.set(ds, id);
    }
  }
  // body 가 참조하는 자산 파일명 — 가속 full 스킵 시 디스크 존재 검사용(없으면 그 페이지만 재수집해 자가치유).
  const ar = await db.query(
    `SELECT external_id, array_agg(DISTINCT m.f) AS files
     FROM knowledge, LATERAL (
       SELECT (regexp_matches(body_md, '/api/ui/notion-assets/([A-Za-z0-9._-]+)', 'g'))[1] AS f
     ) m
     WHERE external_system='notion' AND external_id IS NOT NULL AND body_md LIKE '%/api/ui/notion-assets/%'
     GROUP BY external_id`);
  for (const row of ar.rows as Array<{ external_id: string; files: string[] }>) {
    const led = byId.get(String(row.external_id));
    if (led && Array.isArray(row.files)) led.assets = row.files.map(String);
  }
  // 역링크 — 커넥터가 물질화한 링크만(본문에 실제 등장하는 참조 = 개명 시 재렌더 대상).
  const backlinks = new Map<string, string[]>();
  const bl = await db.query(
    `SELECT tk.external_id AS target_ext, fk.external_id AS from_ext
     FROM knowledge_link l
     JOIN knowledge fk ON fk.name = l.from_name AND fk.external_system='notion' AND fk.external_id IS NOT NULL
     JOIN knowledge tk ON tk.name = l.to_name AND tk.external_system='notion' AND tk.external_id IS NOT NULL
     WHERE l.origin = 'connector:notion'`);
  for (const row of bl.rows as Array<{ target_ext: string; from_ext: string }>) {
    const arr = backlinks.get(row.target_ext);
    if (arr) arr.push(row.from_ext); else backlinks.set(row.target_ext, [row.from_ext]);
  }
  return { byId, dsToDb, backlinks };
}

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

// 감사 append — entity 별 actor_kind='connector'/channel='connector' 고정. before/after 스냅샷은 JSON 직렬화.
//  같은 트랜잭션 client(미러 쓰기와 원자적). FK 없는 append-only 라 대상 행 삭제 후에도 이력 보존.
async function auditConnector(
  client: pg.PoolClient,
  entity: "knowledge" | "project",
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
        fields, raw, author, updated_at, updated_by)
      VALUES($1,$2,$3,'recalled','observed','active','observed',$4,
             $4,$5,$6,$7,
             $8, now(), $9, $10,
             $11::jsonb, $12::jsonb, $13, now(), $13)
     ON CONFLICT (external_system, external_instance, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET
        title=EXCLUDED.title, body_md=EXCLUDED.body_md,
        injection='recalled', provenance='observed', lifecycle='active', confidence='observed', source=EXCLUDED.source,
        external_url=EXCLUDED.external_url, occurred_at=EXCLUDED.occurred_at,
        last_synced_at=now(), parent_external_id=EXCLUDED.parent_external_id, parent_name=EXCLUDED.parent_name,
        fields=EXCLUDED.fields, raw=EXCLUDED.raw,
        version=knowledge.version + 1, updated_at=now(), updated_by=EXCLUDED.updated_by
     RETURNING name`,
    [name, title, body, system,
     instance, externalId, it.provenance.external_url ?? null,
     it.occurred_at ?? null, it.parent_external_id ?? null, parentName,
     JSON.stringify(fields), raw == null ? null : JSON.stringify(raw), author],
  );
  const finalName = (r.rows[0] as { name: string }).name;

  if (contentChanged) {
    const beforeSnap = isInsert ? null : { name: finalName, title: prevRow!.title, body_md: prevRow!.body_md };
    const afterSnap = { name: finalName, title, body_md: body, provenance: "observed", confidence: "observed", source: system, author };
    await auditConnector(client, "knowledge", finalName, isInsert ? "insert" : "update", beforeSnap, afterSnap, author);
  }
  return true;
}

// clickup task → project(level='task'|'subtask') 멱등 upsert. 본문 실변경 시에만 audit. true=적재, false=skip.
//  level: parent_external_id(부모 태스크)가 surfaced 되면 'subtask', 아니면 'task'.
//   ⚠ project.parent_id(내부 self-FK)는 v6 위계의 진실이나, 커넥터는 부모를 external_id 로만 안다.
//   배치 적재 순서가 부모 우선을 보장하지 않으므로(부모 task 행이 아직 없을 수 있음) 여기서 parent_id 를
//   결정적으로 채우지 않는다 → 같은 (external_system, external_instance, parent external_id)로 부모 project 가
//   이미 있으면 그 내부 id 로 parent_id 를 링크하고, 없으면 NULL 로 둔다(다음 싱크가 멱등 재방문 시 수렴 가능).
//   level 자체는 parent_external_id 유무로 결정(부모 미적재여도 subtask 로 표기 — 위계 평탄화 회피).
async function mirrorProjectV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  // 🔴H1 redact — name(title)/description(body)/external_url 평문 시크릿 마스킹.
  const name = it.title == null ? "" : redactString(String(it.title));
  const description = it.body == null ? null : redactString(String(it.body));
  const level = it.parent_external_id ? "subtask" : "task";

  // 부모 task 행(같은 외부 좌표계의 parent external_id) 내부 id 조회 — 있으면 parent_id 링크, 없으면 NULL.
  let parentId: number | null = null;
  if (it.parent_external_id) {
    const p = await client.query(
      `SELECT id FROM project WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
      [system, instance, it.parent_external_id],
    );
    parentId = (p.rows[0] as { id: number } | undefined)?.id ?? null;
  }

  // ── 감사 노이즈 게이트 — external 좌표로 기존 행을 읽어 name(제목)/description 비교. insert=1건, no-op=생략. ──
  const prev = await client.query(
    `SELECT id, name, description FROM project
     WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
    [system, instance, externalId],
  );
  const prevRow = prev.rows[0] as { id: number; name: string; description: string | null } | undefined;
  const isInsert = !prevRow;
  const contentChanged = isInsert
    || (prevRow.name ?? "") !== (name ?? "")
    || (prevRow.description ?? null) !== (description ?? null);

  // 멱등 upsert — 외부 좌표 부분유니크 ON CONFLICT. created_by='connector:<system>'. status 는 외부 상태를
  //  v6 2값(active/done)으로 정규화하지 않고(상태 매핑은 후속) 신규는 'active', 재싱크는 기존 status 보존.
  //  parent_id 는 위에서 해소(부모 미적재면 NULL — 평탄화 아님, level 은 subtask 유지). created_at 은 insert 만.
  const author = `connector:${system}`;
  const r = await client.query(
    `INSERT INTO project(
        level, parent_id, name, description, status, created_by,
        external_system, external_instance, external_id, external_url,
        created_at, updated_at)
      VALUES($1,$2,$3,$4,'active',$5,
             $6,$7,$8,$9,
             now(), now())
     ON CONFLICT (external_system, external_instance, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET
        level=EXCLUDED.level, parent_id=COALESCE(EXCLUDED.parent_id, project.parent_id),
        name=EXCLUDED.name, description=EXCLUDED.description,
        external_url=EXCLUDED.external_url, updated_at=now()
     RETURNING id`,
    [level, parentId, name, description, author,
     system, instance, externalId, it.provenance.external_url ?? null],
  );
  const id = (r.rows[0] as { id: number }).id;

  if (contentChanged) {
    const beforeSnap = isInsert ? null
      : { id: prevRow!.id, name: prevRow!.name, description: prevRow!.description };
    const afterSnap = { id, level, name, description, external_system: system, external_id: externalId, created_by: author };
    await auditConnector(client, "project", String(id), isInsert ? "insert" : "update", beforeSnap, afterSnap, author);
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
  return false; // 미정의 조합(구 KIND_MAP 미정의 = slack 등) — 미러 skip(보수적, 임의 분류 금지).
}

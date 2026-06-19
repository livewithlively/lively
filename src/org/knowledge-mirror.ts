// P-V3-3c — 커넥터/pm 적재 → knowledge_unit observed A/W 미러(라이브 듀얼라이트).
//
//   P-V3-3b 의 일회성 마이그(scripts/migrate-items-to-ku.mjs)를 **라이브 적재 경로**로 끌어올린다:
//   ingestItems 가 item 에 upsert 할 때마다 같은 트랜잭션에서 knowledge_unit 에 observed 미러를 함께 쓰고,
//   declareItemProject(커넥터 싱크·pm write-through 의 유일한 매핑 경로)가 knowledge_unit_project 미러를 함께 쓴다.
//   item(레거시·읽기경로 스냅샷)은 **그대로 보존** — 미러는 가산(additive). 신 활동이 ctx_* 표면에 즉시 표면화된다.
//
//   재사용(P-V3-3b 동치 — SQL byte 동등):
//     · KIND_MAP (type:system → A/W). 미정의 조합은 미러 skip(보수적 — 임의 분류 금지).
//     · unitName(슬러그) — `${system}-${external_id}`(소문자·영숫자/_/- 외 '-', 64자, 선두 영숫자 보장).
//     · external_instance NULL→'' 정규화(부분 UNIQUE 중복차단 갭 메움 — pg NULL distinct 회피).
//     · external 멱등키 ON CONFLICT(external_system, external_instance, external_id) DO UPDATE.
//     · 🔴H1 redact — fields/raw/title/body 를 쓰기 **전** redactDeep/redactString(커넥터 원본 평문 토큰 마스킹).
//
//   confidence='observed'(서버강제 아닌 직접 INSERT — 수집물 신뢰축, H2: 인덱스 영구제외·검토큐 제외·overview 별도).
//   source=system. lifecycle='active'. author/updated_by = 'connector:<system>'(저작 actor 와 구분).
//
//   ⚠ 비파괴·best-effort 경계: 미러 쓰기 실패가 item 적재(외부 계약·read-your-writes)를 깨면 안 된다 →
//     호출자(ingestItems)는 미러를 try/catch 로 감싸 logger.warn 만 하고 item 적재는 계속한다(미러는 다음 싱크가 수렴).
import type pg from "pg";
import { redactDeep, redactString } from "./redact.js";
import type { RawItem } from "../items/store.js";
// V4-P4(P4-dedup): dedup 정체성 키 도출 단일 출처. KIND_MAP·unitName·instance 정규화는
//  external-identity.ts 가 캐노니컬(migrate-items-to-ku.mjs 와 공유 — 복붙 2벌→1벌, byte-identical).
import { unitName, kindForSource, normalizeExternalInstance } from "./external-identity.js";
// V4-P4(P4-ingest): 인입 분류 게이트. 무키면 기계 폴백(kindForSource = 종전 KIND_MAP 동작과 byte-identical),
//  키 있으면 LLM 분류. **현 .env 무키 → 이 경로는 휴면이라 미러 kind 산출이 오늘과 100% 동일**.
import { classifyIngest } from "./ingest-classify.js";

export { unitName };

// (type, system) → kind 또는 null(미정의 조합 — 미러 skip). 노출(테스트·호출자가 분류 가능 판단용).
//  중앙 kindForSource(undefined 반환)를 기존 string|null 계약으로 normalize.
export function knowledgeKindFor(type: string, system: string): string | null {
  return kindForSource(type, system) ?? null;
}

// ── 단일 item(RawItem) → knowledge_unit observed 미러 upsert. ingestItems 의 트랜잭션 client 공유. ──
//  분류 불가(KIND_MAP 미정의) 조합은 false 반환(미러 안 함). 미러 성공 시 true.
//  external_id 부재(이론상 불가 — RawItem.provenance.external_id 필수)면 멱등키가 없어 skip.
export async function mirrorKnowledgeFromRawItem(client: pg.PoolClient, it: RawItem): Promise<boolean> {
  const system = it.provenance.system;
  const externalId = it.provenance.external_id;
  // V4-P4(P4-ingest): kind 산출을 classifyIngest 경유로 일원화. **무키(현 .env) = kindForSource(현 KIND_MAP)
  //  와 byte-identical** — 종전 knowledgeKindFor(it.type, system) 결과와 정확히 동일(아래 무키 분기는 즉시
  //  기계 폴백). 키 확보 시에만 LLM 이 kind 를 판단(area 제안은 별도 큐레이션, 미러 행은 미사용). area/classifiedBy
  //  는 미러 INSERT 가 confidence='observed' 를 직접 박으므로 라이브 미러 provenance 에 영향 없음.
  const classification = await classifyIngest({
    text: `${it.title ?? ""}\n${it.body ?? ""}`,
    source: `${it.type}:${system}`,
    externalSystem: system,
  });
  const kind = classification.kind;
  if (!kind || !externalId) return false;

  const name = unitName(system, externalId);
  // external_instance NULL→'' 정규화(부분 UNIQUE 중복차단 갭 메움). 중앙 helper(external-identity.ts).
  const instance = normalizeExternalInstance(it.provenance.instance);

  // 🔴H1 redact — 쓰기 전 평문 시크릿 마스킹.
  const title = it.title == null ? null : redactString(String(it.title));
  const body = redactString(String(it.body ?? ""));
  // item 폐기·ku 흡수: 원 item.type(message/task/change/doc/note)을 fields._item_type 에 가산 보존한다.
  //  type → kind 는 lossy(여러 type 이 한 kind 로 collapse 가능) — _item_type 은 ku 단독으로 type 필터를
  //  무손실 복원하기 위한 출처 보존(ctx_ls/ctx_grep 의 type 필터가 fields->>'_item_type' 로 동작). redact 무관(enum 토큰).
  const baseFields = redactDeep(it.fields && typeof it.fields === "object" ? it.fields : {}) as Record<string, unknown>;
  const fields = { ...baseFields, _item_type: it.type };
  const raw = it.raw == null ? null : redactDeep(it.raw);

  // parent_name = 부모 item 의 unitName(같은 system) — 스레드 자기참조 내부 PK 연결.
  const parentName = it.parent_external_id ? unitName(system, it.parent_external_id) : null;
  const author = `connector:${system}`;

  // ── 수정이력(작성자/리비전) 게이트 — 미러는 고빈도(매 싱크 다수 행 UPDATE)라 무조건 audit append 하면
  //  org_content_audit 가 노이즈로 비대해진다(last_synced_at-only 재싱크 포함). 따라서 **본문 실변경
  //  (body_md/title diff) 시에만** 리비전을 남긴다. upsert 전에 기존 행의 title/body 를 읽어 비교한다.
  //  존재하지 않으면(insert) → 리비전 1건(v1). 본문 동일(no-op 재싱크) → 리비전 생략(행은 last_synced_at 만 갱신).
  const prev = await client.query(
    `SELECT title, body_md FROM knowledge_unit WHERE name=$1`, [name],
  );
  const prevRow = prev.rows[0] as { title: string | null; body_md: string } | undefined;
  const isInsert = !prevRow;
  const contentChanged = isInsert
    || (prevRow.title ?? null) !== (title ?? null)
    || (prevRow.body_md ?? "") !== (body ?? "");

  await client.query(
    `INSERT INTO knowledge_unit(
        name, kind, title, body_md, lifecycle, confidence, source,
        external_system, external_instance, external_id, external_url,
        occurred_at, last_synced_at, parent_external_id, parent_name,
        fields, raw, author, updated_at, updated_by)
      VALUES($1,$2,$3,$4,'active','observed',$5,
             $5,$6,$7,$8,
             $9, now(), $10, $11,
             $12::jsonb, $13::jsonb, $14, now(), $14)
     ON CONFLICT (external_system, external_instance, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET
        kind=EXCLUDED.kind, title=EXCLUDED.title, body_md=EXCLUDED.body_md,
        lifecycle='active', confidence='observed', source=EXCLUDED.source,
        external_url=EXCLUDED.external_url, occurred_at=EXCLUDED.occurred_at,
        last_synced_at=now(), parent_external_id=EXCLUDED.parent_external_id, parent_name=EXCLUDED.parent_name,
        fields=EXCLUDED.fields, raw=EXCLUDED.raw,
        version=knowledge_unit.version + 1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [name, kind, title, body, system,
     instance, externalId, it.provenance.external_url ?? null,
     it.occurred_at ?? null, it.parent_external_id ?? null, parentName,
     JSON.stringify(fields), raw == null ? null : JSON.stringify(raw), author],
  );

  // ── 수정이력 리비전 append(본문 실변경 시에만 — 노이즈 게이트). channel='connector', actor='connector:<system>',
  //  actor_kind='connector'. after = 미러 행의 시점 스냅샷(title/body_md/kind/source 등 — redact 는 위에서 이미 적용).
  //  before 는 직전 행(있으면). 같은 트랜잭션 client 로 append(미러 쓰기와 원자적). FK 없음(append-only).
  if (contentChanged) {
    const beforeSnap = isInsert ? null : { name, title: prevRow!.title, body_md: prevRow!.body_md };
    const afterSnap = { name, kind, title, body_md: body, source: system, confidence: "observed", author };
    await client.query(
      `INSERT INTO org_content_audit(entity, entity_key, op, before, after, actor, source, channel, actor_kind)
       VALUES('knowledge_unit',$1,$2,$3::jsonb,$4::jsonb,$5,'connector','connector','connector')`,
      [name, isInsert ? "insert" : "update",
       beforeSnap == null ? null : JSON.stringify(beforeSnap), JSON.stringify(afterSnap), author],
    );
  }
  return true;
}

// ── declared/매핑 미러 — item_domain/item_project 쓰기와 짝으로 knowledge_unit_domain/_project 에 반영. ──
//  name = unitName(system, externalId)(미러 유닛의 캐노니컬 PK). 유닛 미러가 없는(분류 불가) 좌표면
//  knowledge_unit FK(name) 위반이 나므로, **유닛 존재를 전제로** 호출돼야 한다(커넥터 경로는 W=clickup 만
//  declare 하므로 항상 유닛 존재). 멱등 ON CONFLICT DO UPDATE.
export async function mirrorKnowledgeProject(
  client: pg.PoolClient,
  coord: { system: string; externalId: string },
  m: { repo: string; projectKey: string; mappedBy: string; confidence?: number | null; state?: string; evidence?: string | null },
): Promise<void> {
  const name = unitName(coord.system, coord.externalId);
  // 미러 유닛이 없으면(분류 불가 조합) FK 위반 — 조용히 skip(레거시 item 매핑은 보존됨).
  const exists = ((await client.query(`SELECT 1 FROM knowledge_unit WHERE name=$1`, [name])).rowCount ?? 0) > 0;
  if (!exists) return;
  await client.query(
    `INSERT INTO knowledge_unit_project(name, repo, project_key, mapped_by, confidence, state, evidence)
       VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (name, repo, project_key) DO UPDATE SET
       mapped_by=EXCLUDED.mapped_by, confidence=EXCLUDED.confidence, state=EXCLUDED.state, evidence=EXCLUDED.evidence`,
    [name, m.repo, m.projectKey, m.mappedBy ?? "declared", m.confidence ?? null, m.state ?? "confirmed", m.evidence ?? null],
  );
}

// supersede 미러 — 형제 declared 행 강등(리스트 이동 수렴)을 knowledge_unit_project 에도 반영.
//  현재 키가 아닌 declared 행을 state='rejected' 로(레거시 supersedeSiblingDeclaredProjects 와 동치).
export async function mirrorSupersedeSiblingProjects(
  client: pg.PoolClient,
  coord: { system: string; externalId: string },
  keepProjectKey: string,
  repo: string,
): Promise<void> {
  const name = unitName(coord.system, coord.externalId);
  await client.query(
    `UPDATE knowledge_unit_project SET state='rejected'
      WHERE name=$1 AND repo=$2 AND mapped_by='declared' AND project_key <> $3 AND state <> 'rejected'`,
    [name, repo, keepProjectKey],
  );
}

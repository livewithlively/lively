// 지식 미러(notion 등 K류 → knowledge) — #1313 R20 으로 connector-mirror.ts 에서 verbatim 이관.
//  external 좌표 upsert(mirrorKnowledgeV6) · domain-wiki name-키 upsert · domain-wiki 삭제 전파 스윕.
import type pg from "pg";
import { redactDeep, redactString } from "../../org/ingest/redact.js";
// unitName/normalizeExternalInstance 는 external-identity 가 SoT(구 미러와 byte-identical 슬러그·정규화 공유).
import { unitName, normalizeExternalInstance } from "../../org/ingest/external-identity.js";
import { classifyIngest } from "../../org/ingest/ingest-classify.js";
import type { RawItem } from "../../items/store.js";
import { resolveIngestPolicy } from "../../org/ingest/ingest-policy.js";
import { getIngestPolicyRules } from "../../org/ingest/ingest-policy-load.js";
import { auditConnector, auditLifecycleSweep } from "./mirror-common.js";
import { boundCollector } from "../../connectors/config.js";

/**
 * 수집기 '지식 직행'의 대상 분류 적용(#1419 T3) — output_config.target_category.
 *
 *  ⚠ **신규 삽입에만** 건다. 이 파일의 오랜 불변식이 "재싱크는 사람이 부여한 분류·핀을 지우지 않는다"이고,
 *   매 싱크마다 분류를 다시 박으면 사람이 옮겨 놓은 지식이 다음 싱크에 원위치로 끌려간다.
 *  mapped_by='rule'(사람도 LLM도 아닌 설정에서 온 것) · state='confirmed'(관리자가 명시한 값이라 제안이 아니다).
 *  분류 key 가 실재하지 않으면 조용히 넘어간다 — 오타 하나로 수집 전체를 멈추게 하지 않는다.
 */
async function applyCollectorTargetCategory(client: pg.PoolClient, name: string, isInsert: boolean): Promise<void> {
  if (!isInsert) return;
  const cfg = boundCollector()?.outputConfig;
  const key = typeof cfg?.target_category === "string" ? cfg.target_category.trim() : "";
  if (!key) return;
  try {
    await client.query(
      `INSERT INTO knowledge_category(name, category_id, mapped_by, state)
         SELECT $1, c.id, 'rule', 'confirmed' FROM category c WHERE c.key = $2
       ON CONFLICT (name, category_id) DO NOTHING`, [name, key]);
  } catch { /* 분류 연결 실패는 비치명 — 지식 자체는 이미 적재됐다(분류는 분류기가 나중에 붙일 수 있다) */ }
}

// notion(및 K류) → knowledge(observed) 멱등 upsert. 본문 실변경 시에만 audit. true=적재, false=skip.
//  #638 lifecycle: 신규는 인입정책(auto→active | confirm→pending | drop→skip), 재싱크는 사람 검토상태 보존(archived 전파만).
export async function mirrorKnowledgeV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  // 🔴H1 redact — 쓰기 전 평문 시크릿 마스킹.
  const title = it.title == null ? null : redactString(String(it.title));
  const body = redactString(String(it.body ?? ""));
  const baseFields = redactDeep(it.fields && typeof it.fields === "object" ? it.fields : {}) as Record<string, unknown>;
  // 구 미러처럼 원 item.type 을 fields._item_type 에 가산 보존(type 필터 무손실 복원용 — v6 에 kind 없음).
  const fields = { ...baseFields, _item_type: it.type };
  const raw = it.raw == null ? null : redactDeep(it.raw);
  const author = `connector:${system}`;
  // #551 아카이브 전파 — 원본이 아카이브/휴지통이면 lifecycle='archived'(기본 목록에서 숨고 보존). 신규 lifecycle 은 아래 정책으로.
  const isArchived = baseFields.archived === true || baseFields.in_trash === true;
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

  // #638 인입 허용선 정책 — 신규 삽입에만 평가(재싱크는 아래 ON CONFLICT CASE 가 사람 검토상태 보존).
  //  archived(원본 삭제/보관)는 정책 무관 전파. drop=미적재(return false). mirror 는 observed 고정.
  //  category/channel/sensitive 는 classifyIngest(area) 통합 시 확장 — 현재는 system·provenance 로 오너가 출처별 조절.
  let lifecycle: string;
  if (isArchived) lifecycle = "archived";
  else if (isInsert) {
    // #653 유키(ANTHROPIC_API_KEY) 시 classifyIngest 로 category(area)·민감 라벨 판정 → 4축 정책. 무키면 호출 안 함(system·provenance 축만, 오버헤드 0).
    let clsCategory: string | null = null, clsSensitive: string | null = null;
    if (process.env.ANTHROPIC_API_KEY) {
      try { const cls = await classifyIngest({ text: body, source: `${it.type}:${system}`, externalSystem: system }); clsCategory = cls.area; clsSensitive = cls.sensitive; }
      catch { /* 분류 실패 → null(system·provenance 축만으로 폴백) */ }
    }
    // #783 정책은 신규(create)/수정(update) 2축이 됐지만, 미러는 create 만 태운다 — 재싱크(update)는 원본이 진실이라
    //  게이트 대상이 아니다(아래 ON CONFLICT CASE 가 사람의 검토 상태를 보존하는 것으로 이미 충분).
    //  actor_kind='connector' 축은 두지 않는다 — 미러는 provenance='observed' 로 이미 결정론적으로 식별된다.
    const action = resolveIngestPolicy(
      { provenance: "observed", system, category: clsCategory, channel: null, sensitive: clsSensitive },
      await getIngestPolicyRules()).create;
    if (action === "drop") return false;   // 오너 정책상 이 출처는 위키화하지 않음(원본은 외부에 잔존)
    lifecycle = action === "confirm" ? "pending" : "active";
  } else lifecycle = "active"; // 재싱크: VALUES 미반영(ON CONFLICT CASE 가 기존 lifecycle 보존)

  // 멱등 upsert — 외부 좌표(external_*) 부분유니크 ON CONFLICT. provenance='observed'(외부 수집물 사실),
  //  injection='recalled'(검색 소환 — 외부 미러는 always 주입 대상 아님), confidence='observed', source=system.
  //  name(PK)은 신규일 때만 슬러그 부여(external-identity.unitName SoT). 재싱크는 ON CONFLICT 가 같은 행을 잡으므로 name 충돌 없음.
  //  #669 임베딩: 미러는 쓰기훅(embedKnowledgeBestEffort=knowledge_save 경로) 밖이라, 제목/본문 실변경($16) 시
  //   embedding_* 를 리셋해 pending(IS NULL) 풀로 되돌린다(신규 insert 는 어차피 NULL) → 게이트웨이 자동 pending
  //   백필(runAutoBackfillSweep)이 재임베딩. 리셋 없인 갱신분이 옛 텍스트의 스테일 벡터로 남아 백필이 영영 못 잡는다.
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
     ON CONFLICT (tenant_id, external_system, external_instance, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET
        title=EXCLUDED.title, body_md=EXCLUDED.body_md,
        injection='recalled', provenance='observed',
        -- #638 재싱크는 사람 검토상태(active/pending) 보존 — archived(원본 삭제/보관)만 전파, unarchive 는 active 복귀.
        lifecycle=CASE WHEN EXCLUDED.lifecycle='archived' THEN 'archived'
                       WHEN knowledge.lifecycle='archived' THEN 'active'
                       ELSE knowledge.lifecycle END,
        confidence='observed', source=EXCLUDED.source,
        external_url=EXCLUDED.external_url, occurred_at=EXCLUDED.occurred_at,
        last_synced_at=now(), parent_external_id=EXCLUDED.parent_external_id, parent_name=EXCLUDED.parent_name,
        fields=EXCLUDED.fields, raw=EXCLUDED.raw, sort=COALESCE($15, knowledge.sort),
        embedding_vector=CASE WHEN $16::boolean THEN NULL ELSE knowledge.embedding_vector END,
        embedding_model=CASE WHEN $16::boolean THEN NULL ELSE knowledge.embedding_model END,
        embedding_updated_at=CASE WHEN $16::boolean THEN NULL ELSE knowledge.embedding_updated_at END,
        version=knowledge.version + 1, updated_at=now(), updated_by=EXCLUDED.updated_by
     RETURNING name`,
    [name, title, body, system,
     instance, externalId, it.provenance.external_url ?? null,
     it.occurred_at ?? null, it.parent_external_id ?? null, parentName,
     JSON.stringify(fields), raw == null ? null : JSON.stringify(raw), author,
     lifecycle, sort, contentChanged],
  );
  const finalName = (r.rows[0] as { name: string }).name;
  await applyCollectorTargetCategory(client, finalName, isInsert);

  if (contentChanged) {
    const beforeSnap = isInsert ? null : { name: finalName, title: prevRow!.title, body_md: prevRow!.body_md };
    const afterSnap = { name: finalName, title, body_md: body, provenance: "observed", confidence: "observed", source: system, author, lifecycle };  // #638/#656 lifecycle 관측(insert 시 정확) — 검토 대시 auto/pending 집계용
    await auditConnector(client, "knowledge", finalName, isInsert ? "insert" : "update", beforeSnap, afterSnap, author);
  }
  return true;
}

// ── domain-wiki(마크다운 git 미러, #696) 전용 name-키 upsert ──────────────────────────
//  일반 커넥터는 external 좌표(external_system,instance,id) 로 멱등하지만 domain-wiki 는 **파일 basename
//  슬러그 = 지식 name** 이 자연 식별자다(파일 1개=주제 1개). 최초 수동이관이 이 규칙으로 name 을 부여했고
//  external 좌표는 비었다(NULL) — 그래서 external-좌표 upsert(mirrorKnowledgeV6)로는 기존 행을 못 잡고
//  같은 name 으로 재삽입 시 PK 충돌한다. 따라서 여기선 **ON CONFLICT (tenant_id, name)** 로 재싱크가 기존 행을 그대로
//  갱신(=채택, external 좌표도 이때 부여)하고 신규만 추가한다. name(PK)=external_id(슬러그).
//  ⚠ 보존 규칙: type(page-type)·is_wiki(핀)·parent_name·카테고리(knowledge_category)는 UPDATE 에서 건드리지
//  않는다 — 사람이 부여한 분류/핀을 재싱크가 지우지 않게(카테고리는 이 함수가 애초에 안 씀, notion 미러와 동일).
//  임베딩은 내용 변경 시 리셋(#669, 백필 재임베딩) — 쓰기루프 밖 유지.
export async function mirrorKnowledgeByNameV6(client: pg.PoolClient, it: RawItem, system: string, externalId: string): Promise<boolean> {
  const instance = normalizeExternalInstance(it.provenance.instance);
  const name = externalId;                                   // 슬러그 = name = external_id
  const title = it.title == null ? null : redactString(String(it.title));
  const body = redactString(String(it.body ?? ""));
  const baseFields = redactDeep(it.fields && typeof it.fields === "object" ? it.fields : {}) as Record<string, unknown>;
  const fields = { ...baseFields, _item_type: it.type };
  const raw = it.raw == null ? null : redactDeep(it.raw);
  const author = `connector:${system}`;
  const sort = typeof it.sort === "number" && Number.isFinite(it.sort) ? Math.trunc(it.sort) : null;

  // 감사 노이즈 게이트 — name 으로 기존 행 조회(제목/본문 실변경 시에만 audit).
  const prev = await client.query(`SELECT name, title, body_md FROM knowledge WHERE name=$1`, [name]);
  const prevRow = prev.rows[0] as { name: string; title: string | null; body_md: string } | undefined;
  const isInsert = !prevRow;
  const contentChanged = isInsert
    || (prevRow.title ?? null) !== (title ?? null)
    || (prevRow.body_md ?? "") !== (body ?? "");

  const r = await client.query(
    `INSERT INTO knowledge(
        name, title, body_md, injection, provenance, lifecycle, confidence, source,
        external_system, external_instance, external_id, external_url,
        occurred_at, last_synced_at, fields, raw, author, sort, updated_at, updated_by)
      VALUES($1,$2,$3,'recalled','observed','active','observed',$4,
             $4,$5,$6,$7,
             $8, now(), $9::jsonb, $10::jsonb, $11, COALESCE($12,0), now(), $11)
     ON CONFLICT (tenant_id, name) DO UPDATE SET
        title=EXCLUDED.title, body_md=EXCLUDED.body_md,
        injection='recalled', provenance='observed', confidence='observed', source=EXCLUDED.source,
        external_system=EXCLUDED.external_system, external_instance=EXCLUDED.external_instance,
        external_id=EXCLUDED.external_id, external_url=EXCLUDED.external_url,
        -- 재싱크: 사람 검토상태 보존. 아카이브(삭제 전파, sweepDomainWikiArchived)돼 있던 파일이 다시 나타나면 active 복귀.
        lifecycle=CASE WHEN knowledge.lifecycle='archived' THEN 'active' ELSE knowledge.lifecycle END,
        occurred_at=EXCLUDED.occurred_at, last_synced_at=now(),
        fields=EXCLUDED.fields, raw=EXCLUDED.raw, sort=COALESCE($12, knowledge.sort),
        embedding_vector=CASE WHEN $13::boolean THEN NULL ELSE knowledge.embedding_vector END,
        embedding_model=CASE WHEN $13::boolean THEN NULL ELSE knowledge.embedding_model END,
        embedding_updated_at=CASE WHEN $13::boolean THEN NULL ELSE knowledge.embedding_updated_at END,
        version=knowledge.version + 1, updated_at=now(), updated_by=EXCLUDED.updated_by
     RETURNING name`,
    [name, title, body, system, instance, externalId, it.provenance.external_url ?? null,
     it.occurred_at ?? null, JSON.stringify(fields), raw == null ? null : JSON.stringify(raw),
     author, sort, contentChanged],
  );
  const finalName = (r.rows[0] as { name: string }).name;
  await applyCollectorTargetCategory(client, finalName, isInsert);
  if (contentChanged) {
    const beforeSnap = isInsert ? null : { name: finalName, title: prevRow!.title, body_md: prevRow!.body_md };
    const afterSnap = { name: finalName, title, body_md: body, provenance: "observed", confidence: "observed", source: system, author, lifecycle: "active" };
    await auditConnector(client, "knowledge", finalName, isInsert ? "insert" : "update", beforeSnap, afterSnap, author);
  }
  return true;
}

/** domain-wiki 삭제 전파 — 이번 전량 싱크에서 관측 안 된(last_synced_at<runStart) 활성 domain-wiki 지식을 아카이브.
 *  repo 는 매 실행 전량 관측하므로 파일이 사라지면 그 행만 last_synced_at 이 안 갱신돼 걸린다. run-sync 가 호출.
 *  #1561 감사: notion 스윕과 같은 무감사 아카이브였다 — 같은 헬퍼로 op='set_lifecycle' 을 남긴다(둘이 갈라지면
 *  한쪽 커넥터의 아카이브만 이력에 보이는, 더 헷갈리는 상태가 된다). */
export async function sweepDomainWikiArchived(db: pg.Pool, runStartIso: string, instance: string): Promise<number> {
  //  ⚠ instance 필수(#1881 G9) — 종전엔 external_system='domain-wiki' 만 보고 전량을 훑었다. 위키 레포가 하나뿐일
  //   때는 맞았지만, 레포를 둘 붙이는 순간 **A 의 싱크가 B 의 지식을 전부 아카이브한다**(B 의 파일은 A 의 run 에서
  //   관측될 리 없으니 last_synced_at 이 안 갱신된다). 노션이 워크스페이스 다중화에서 먼저 밟은 자리라
  //   (sweepNotionArchived, #2000) 같은 방식으로 좁힌다 — 범위 없는 스윕은 애초에 부를 수 없게 막는다.
  if (!instance) throw new Error("sweepDomainWikiArchived: instance 가 비었습니다 — 범위 없는 스윕은 다른 위키 레포의 지식을 아카이브합니다");
  const r = await db.query(
    `UPDATE knowledge SET lifecycle='archived', updated_at=now(), updated_by='connector:domain-wiki'
     WHERE external_system='domain-wiki' AND external_instance=$2 AND lifecycle='active'
       AND (last_synced_at IS NULL OR last_synced_at < $1) RETURNING name`, [runStartIso, instance]);
  await auditLifecycleSweep(db, (r.rows as Array<{ name: string }>).map((x) => x.name),
    "connector:domain-wiki", "active", "archived");
  return r.rowCount ?? 0;
}

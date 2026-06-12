// Item store — DESIGN §5 canonical schema. 모든 소스(Slack/Discord/Notion…)가 여기로 정규화돼 들어온다.
// 별도 Postgres(ITEMS_DATABASE_URL). 도메인/프로젝트는 (repo, key) 소프트참조로 연결(domainmap 은 별 DB).
import pg from "pg";
import { resolveRepo } from "../domainmap/core/types.js";
import {
  loadCandidates,
  validateDomainKey,
  validateProjectKey,
  type Candidates,
} from "./mapping-candidates.js";
import { logger } from "../log.js";

export const itemsPool = new pg.Pool({ connectionString: process.env.ITEMS_DATABASE_URL });

// ── 커넥터가 뱉는 정규화 직전 레코드 (Connector SPI 의 출력 단위) ──
export interface RawItem {
  type: "message" | "task" | "change" | "doc" | "note";
  provenance: {
    category: "messenger" | "collab_tool" | "vcs" | "db" | string;
    system: string; // slack | discord | notion
    instance?: string; // 워크스페이스/사이트 식별자
    external_id: string; // system+instance 내 안정적 고유 id
    external_url?: string;
  };
  actor?: { external_id?: string; display_name?: string; email?: string; is_bot?: boolean };
  container_ref?: string; // 채널/DB/페이지 id
  parent_external_id?: string; // 스레드/서브태스크 부모의 external_id (같은 system+instance)
  title?: string;
  body?: string;
  occurred_at?: string; // ISO8601
  updated_at?: string;
  fields?: Record<string, unknown>;
  raw?: unknown;
}

export async function initItemSchema(): Promise<void> {
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS person(
      id TEXT PRIMARY KEY,
      display_name TEXT,
      identities JSONB DEFAULT '[]'::jsonb);

    CREATE TABLE IF NOT EXISTS item(
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      prov_category TEXT, prov_system TEXT NOT NULL, prov_instance TEXT,
      external_id TEXT NOT NULL, external_url TEXT,
      actor_id TEXT REFERENCES person(id),
      container_ref TEXT,
      parent_external_id TEXT,
      parent_id BIGINT REFERENCES item(id),
      title TEXT, body TEXT,
      occurred_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
      fields JSONB DEFAULT '{}'::jsonb, raw JSONB,
      UNIQUE(prov_system, prov_instance, external_id));
    CREATE INDEX IF NOT EXISTS item_type_idx     ON item(type);
    CREATE INDEX IF NOT EXISTS item_system_idx   ON item(prov_system);
    CREATE INDEX IF NOT EXISTS item_occurred_idx ON item(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS item_container_idx ON item(container_ref);

    CREATE TABLE IF NOT EXISTS item_domain(
      item_id BIGINT REFERENCES item(id) ON DELETE CASCADE,
      repo TEXT, domain_key TEXT, mapped_by TEXT, confidence REAL,
      PRIMARY KEY(item_id, repo, domain_key));
    CREATE TABLE IF NOT EXISTS item_project(
      item_id BIGINT REFERENCES item(id) ON DELETE CASCADE,
      repo TEXT, project_key TEXT, mapped_by TEXT, confidence REAL,
      PRIMARY KEY(item_id, repo, project_key));
    CREATE TABLE IF NOT EXISTS relation(
      from_item BIGINT, to_item BIGINT, type TEXT,
      PRIMARY KEY(from_item, to_item, type));
  `);

  // ── 매핑 가드레일 마이그레이션 (DESIGN §7.5/§10.5/§11) ──
  // state 컬럼: 'proposed'(규칙/LLM 제안) | 'confirmed'(사람 큐레이션 진실).
  // CREATE TABLE IF NOT EXISTS 는 기존 테이블에 컬럼을 추가하지 않으므로,
  // 매 부팅/CLI 실행마다 멱등하게 ADD COLUMN IF NOT EXISTS 로 따로 적용한다.
  // evidence 컬럼: llm 제안의 근거 인용(DESIGN §11) — write-path 가 영속화.
  // state CHECK 로 proposed|confirmed enum 을 DB 불변식으로 강제(아웃오브밴드 오타 state 차단).
  await itemsPool.query(`
    ALTER TABLE item_domain  ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'proposed';
    ALTER TABLE item_project ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'proposed';
    ALTER TABLE item_domain  ADD COLUMN IF NOT EXISTS evidence TEXT;
    ALTER TABLE item_project ADD COLUMN IF NOT EXISTS evidence TEXT;
    CREATE INDEX IF NOT EXISTS item_domain_state_idx  ON item_domain(state);
    CREATE INDEX IF NOT EXISTS item_project_state_idx ON item_project(state);
  `);
  // state enum CHECK — 3값(proposed|confirmed|rejected) 멱등 마이그레이션.
  // pg_get_constraintdef 프로브: 이미 'rejected' 포함이면 no-op(매 부팅 DROP/ADD 락 churn 회피),
  // 구 2값 CHECK 면 DROP 후 3값으로 재생성, fresh DB 면 바로 3값 생성.
  await itemsPool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='item_domain'::regclass AND conname='item_domain_state_chk'
                       AND pg_get_constraintdef(oid) LIKE '%rejected%') THEN
        ALTER TABLE item_domain DROP CONSTRAINT IF EXISTS item_domain_state_chk;
        ALTER TABLE item_domain ADD CONSTRAINT item_domain_state_chk CHECK (state IN ('proposed','confirmed','rejected'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='item_project'::regclass AND conname='item_project_state_chk'
                       AND pg_get_constraintdef(oid) LIKE '%rejected%') THEN
        ALTER TABLE item_project DROP CONSTRAINT IF EXISTS item_project_state_chk;
        ALTER TABLE item_project ADD CONSTRAINT item_project_state_chk CHECK (state IN ('proposed','confirmed','rejected'));
      END IF;
    END $$;
  `);
  // relation FK — from_item/to_item 이 item(id) 참조 + ON DELETE CASCADE(고아 relation 방지).
  // 기존 데이터에 댕글링 행이 있으면 NOT VALID 로 추가 후, 깨끗하면 VALIDATE 시도(실패해도 무시).
  await itemsPool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='relation_from_fk') THEN
        ALTER TABLE relation ADD CONSTRAINT relation_from_fk
          FOREIGN KEY (from_item) REFERENCES item(id) ON DELETE CASCADE NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='relation_to_fk') THEN
        ALTER TABLE relation ADD CONSTRAINT relation_to_fk
          FOREIGN KEY (to_item) REFERENCES item(id) ON DELETE CASCADE NOT VALID;
      END IF;
    END $$;
  `);

  // ── 영속 매핑 감사 로그 (domainmap change_log 대응물) ──
  // logger 전용이던 감사 이벤트를 DB 에 append-only 로 영속화: 'item_domain/item_project 의 모든 쓰기는
  // 검증 경로를 거쳤다'를 사후에 DB 만으로 입증 가능하게 한다(우회 SQL 쓰기는 감사행이 없어 드러남).
  // append-only 불변식: 이 테이블에 UPDATE/DELETE 하는 코드 경로를 만들지 않는다.
  // item FK 없음(의도) — 아이템이 지워져도 감사 이력은 남아야 한다.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS item_mapping_audit(
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      target TEXT NOT NULL CHECK (target IN ('domain','project')),
      item_id BIGINT NOT NULL,
      repo TEXT NOT NULL,
      key TEXT NOT NULL,
      mapped_by TEXT,
      action TEXT NOT NULL,
      state TEXT,
      confidence REAL,
      evidence TEXT,
      source TEXT,
      actor TEXT);
    CREATE INDEX IF NOT EXISTS item_mapping_audit_item_idx ON item_mapping_audit(item_id);
    CREATE INDEX IF NOT EXISTS item_mapping_audit_at_idx   ON item_mapping_audit(at DESC);
  `);

  // ── canonical identity (설계결정 2026-06-11 §0-6/7, DESIGN §5) ──
  // person = canonical 인물(사람/에이전트/시스템 1명당 1행, id 는 알려진 인물이면 사람이 읽는 슬러그).
  // person_identity = 소스별 신원(시스템×external_id 1행) — 구 per-source person 사일로의 대체.
  // person.identities JSONB 는 레거시로 보존만(읽기/쓰기 코드 경로 전부 제거; 파괴적 DROP 금지).
  await itemsPool.query(`
    ALTER TABLE person ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'human';
    CREATE TABLE IF NOT EXISTS person_identity(
      id BIGSERIAL PRIMARY KEY,
      person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
      system TEXT NOT NULL,
      instance TEXT,
      external_id TEXT NOT NULL,
      email TEXT,
      display_name TEXT,
      origin TEXT NOT NULL DEFAULT 'observed',
      state TEXT NOT NULL DEFAULT 'proposed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(system, external_id));
    CREATE INDEX IF NOT EXISTS person_identity_person_idx ON person_identity(person_id);
    CREATE INDEX IF NOT EXISTS person_identity_email_idx ON person_identity(lower(email));
  `);
  // person/person_identity enum CHECK — pg_get_constraintdef 프로브 멱등(state CHECK 와 동일 idiom).
  await itemsPool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='person'::regclass AND conname='person_kind_chk'
                       AND pg_get_constraintdef(oid) LIKE '%system%') THEN
        ALTER TABLE person DROP CONSTRAINT IF EXISTS person_kind_chk;
        ALTER TABLE person ADD CONSTRAINT person_kind_chk CHECK (kind IN ('human','agent','system'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='person_identity'::regclass AND conname='person_identity_origin_chk'
                       AND pg_get_constraintdef(oid) LIKE '%llm-proposed%') THEN
        ALTER TABLE person_identity DROP CONSTRAINT IF EXISTS person_identity_origin_chk;
        ALTER TABLE person_identity ADD CONSTRAINT person_identity_origin_chk CHECK (origin IN ('observed','email-join','manual','llm-proposed'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='person_identity'::regclass AND conname='person_identity_state_chk'
                       AND pg_get_constraintdef(oid) LIKE '%confirmed%') THEN
        ALTER TABLE person_identity DROP CONSTRAINT IF EXISTS person_identity_state_chk;
        ALTER TABLE person_identity ADD CONSTRAINT person_identity_state_chk CHECK (state IN ('proposed','confirmed'));
      END IF;
    END $$;
  `);
  // mapped_by enum CHECK — 'declared'(커넥터 싱크 전용 출처) 포함 4값. 아웃오브밴드 오타 차단.
  await itemsPool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='item_domain'::regclass AND conname='item_domain_mappedby_chk'
                       AND pg_get_constraintdef(oid) LIKE '%declared%') THEN
        ALTER TABLE item_domain DROP CONSTRAINT IF EXISTS item_domain_mappedby_chk;
        ALTER TABLE item_domain ADD CONSTRAINT item_domain_mappedby_chk CHECK (mapped_by IN ('rule','llm','manual','declared'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid='item_project'::regclass AND conname='item_project_mappedby_chk'
                       AND pg_get_constraintdef(oid) LIKE '%declared%') THEN
        ALTER TABLE item_project DROP CONSTRAINT IF EXISTS item_project_mappedby_chk;
        ALTER TABLE item_project ADD CONSTRAINT item_project_mappedby_chk CHECK (mapped_by IN ('rule','llm','manual','declared'));
      END IF;
    END $$;
  `);
  // ── 신원 감사 로그 (item_mapping_audit 대응물; append-only, FK 없음(의도) — 행 삭제 후에도 이력 보존) ──
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS person_identity_audit(
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      action TEXT NOT NULL,
      person_id TEXT,
      old_person_id TEXT,
      system TEXT,
      external_id TEXT,
      item_count INT,
      detail JSONB,
      source TEXT,
      actor TEXT);
    CREATE INDEX IF NOT EXISTS person_identity_audit_at_idx ON person_identity_audit(at DESC);
  `);

  // ── 커넥터 증분 커서 (phase B — ClickUp 등 폴링 커넥터의 상태 영속) ──
  // (system, instance) 당 1행. cursor 는 JSONB — 커넥터별 shape 확장 가능
  // (clickup: { tasks_max_updated_ms: <int> }). 멱등 CREATE IF NOT EXISTS — 두 번 실행 = no-op.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS connector_state(
      system TEXT NOT NULL,
      instance TEXT NOT NULL,
      cursor JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(system, instance));
  `);

  // ── pm 쓰기 감사 (phase B — pm_* op 단위 영속 감사) ──
  // logger 의 pm_write 라인은 stdout 리다이렉트 위치에 좌우(휘발 /tmp 였음) — '누가 어떤 op 를
  // 언제 무슨 파라미터로' 의 내구 진실은 이 테이블. item_mapping_audit idiom: append-only,
  // FK 없음(의도 — 대상 태스크/아이템이 사라져도 이력 보존). UPDATE/DELETE 코드 경로 금지.
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS pm_write_audit(
      id BIGSERIAL PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      action TEXT NOT NULL,
      by_user TEXT NOT NULL,
      source TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('ok','failed')),
      clickup_ok BOOLEAN,
      error TEXT,
      detail JSONB);
    CREATE INDEX IF NOT EXISTS pm_write_audit_at_idx ON pm_write_audit(at DESC);
  `);
}

// pm_* 쓰기 감사행 — pm.ts audited() 전용 writer(append-only). 실패해도 op 를 깨면 안 되는
// best-effort 는 **호출자** 책임(여기서 삼키면 호출자가 영속 실패를 구분 못 함).
export async function recordPmWriteAudit(entry: {
  action: string; by: string; source?: string; outcome: "ok" | "failed";
  clickupOk?: boolean; error?: string; detail?: Record<string, unknown>;
}): Promise<void> {
  await itemsPool.query(
    `INSERT INTO pm_write_audit(action, by_user, source, outcome, clickup_ok, error, detail)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [entry.action, entry.by, entry.source ?? null, entry.outcome,
     entry.clickupOk ?? null, entry.error ?? null, JSON.stringify(entry.detail ?? {})],
  );
}

// ── 커넥터 커서 읽기/쓰기 — run-sync 전용(증분 폴링의 단일 상태 저장소) ──
export async function getConnectorState(
  system: string, instance: string,
): Promise<Record<string, unknown> | null> {
  const r = await itemsPool.query(
    `SELECT cursor FROM connector_state WHERE system=$1 AND instance=$2`,
    [system, instance],
  );
  return (r.rows[0] as { cursor: Record<string, unknown> } | undefined)?.cursor ?? null;
}

export async function setConnectorState(
  system: string, instance: string, cursor: Record<string, unknown>,
): Promise<void> {
  await itemsPool.query(
    `INSERT INTO connector_state(system, instance, cursor) VALUES($1,$2,$3::jsonb)
     ON CONFLICT (system, instance) DO UPDATE SET cursor=EXCLUDED.cursor, updated_at=now()`,
    [system, instance, JSON.stringify(cursor)],
  );
}

// external_id 배치 → item id 조회(읽기 전용). ingestItems 는 카운트만 반환하고
// declareItemProject 는 itemId 를 받으므로, 싱크/에코 경로가 이 단일 SELECT 로 잇는다.
export async function getItemIdsByExternalIds(
  system: string, instance: string | null, externalIds: string[],
): Promise<Map<string, number>> {
  if (!externalIds.length) return new Map();
  const r = await itemsPool.query(
    `SELECT id, external_id FROM item
     WHERE prov_system=$1 AND prov_instance IS NOT DISTINCT FROM $2 AND external_id = ANY($3)`,
    [system, instance, externalIds],
  );
  return new Map((r.rows as { id: string | number; external_id: string }[])
    .map((row) => [row.external_id, Number(row.id)]));
}

// 감사 컨텍스트 — 쓰기 진입점(cli/mapper/mcp/web)이 자신을 표식. store 레벨에선 principal 을 알 수 없어
// 호출자가 명시적으로 전달한다(전역 mutable 금지 — MCP 동시 호출 안전).
export interface AuditCtx { source?: string; actor?: string }
function auditDefaults(a?: AuditCtx): { source: string; actor: string } {
  return {
    source: a?.source ?? "unknown",
    actor: a?.actor ?? process.env.USER ?? process.env.LOGNAME ?? "unknown",
  };
}

// ── 액터 해소 (canonical identity) ──
// person_identity(system, external_id) 룩업 → canonical person_id. 미스 시:
//  1) confirmed 신원과 이메일이 정확히 1명에게 매치되면 결정적 email-join(새 신원 행 + 감사).
//     조인 신원은 state='proposed' 로 착지 — 소스가 주장한 프로필 이메일 기반 자동 추론이라
//     curation 진실(confirmed)이 아니다(악의적 이메일 사칭 시 큐레이션에서 드러나야 함).
//     액터 해소 자체는 state 무관(1번 룩업이 state 필터 없음)이라 귀속은 정상 동작.
//  2) 아니면 자동 생성(슬러그 폴백 `${system}:${external_id}`, kind 는 봇 신호 기반) + observed 신원.
// 히트 시 새로 관측된 email/display_name 으로 신원 갱신(과거 '절대 갱신 안 됨' 버그 수정 —
// origin/state 는 건드리지 않음). 단, origin='manual'(바인딩 ground truth)은 보호:
// email 은 절대 덮지 않고(email-join 결정 키 드리프트 방지), display_name 은 NULL 일 때만 채운다.
// 배치 내 동일 액터는 Map 캐시로 1회만 해소.
async function resolveActor(
  client: pg.PoolClient,
  system: string,
  instance: string | null,
  actor: { external_id: string; display_name?: string; email?: string; is_bot?: boolean },
  cache: Map<string, string>,
): Promise<string> {
  const cacheKey = `${system}:${actor.external_id}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const newEmail = actor.email?.trim() || null;
  const newName = actor.display_name?.trim() || null;

  // 1) 신원 룩업.
  const hit = (await client.query(
    `SELECT id, person_id, email, display_name, origin FROM person_identity WHERE system=$1 AND external_id=$2`,
    [system, actor.external_id],
  )).rows[0] as { id: string; person_id: string; email: string | null; display_name: string | null; origin: string } | undefined;
  if (hit) {
    // manual 신원은 members/*.md 바인딩이 진실 — 관측치로 email 을 덮으면 잘못된 라벨(origin='manual')을
    // 단 채 ground truth 가 드리프트한다. email 은 스킵, display_name 은 비어 있을 때만 채움.
    const isManual = hit.origin === "manual";
    const effEmail = isManual ? null : newEmail;
    const effName = isManual && hit.display_name ? null : newName;
    if ((effEmail && effEmail !== hit.email) || (effName && effName !== hit.display_name)) {
      await client.query(
        `UPDATE person_identity SET email=COALESCE($1, email), display_name=COALESCE($2, display_name), updated_at=now() WHERE id=$3`,
        [effEmail, effName, hit.id],
      );
      await client.query(
        `INSERT INTO person_identity_audit(action, person_id, system, external_id, detail, source)
         VALUES('identity-updated',$1,$2,$3,$4::jsonb,'ingest')`,
        [hit.person_id, system, actor.external_id,
         JSON.stringify({
           old: { email: hit.email, display_name: hit.display_name },
           new: { email: effEmail ?? hit.email, display_name: effName ?? hit.display_name },
           origin: hit.origin,
           ...(isManual && newEmail && newEmail !== hit.email ? { skipped_observed_email: true } : {}),
         })],
      );
    }
    cache.set(cacheKey, hit.person_id);
    return hit.person_id;
  }

  // 2) 결정적 email-join — confirmed 신원과 정확히 1명 매치일 때만(0/2+ 는 자동 생성으로 폴스루).
  if (newEmail) {
    const matches = (await client.query(
      `SELECT DISTINCT person_id FROM person_identity WHERE lower(email)=lower($1) AND state='confirmed'`,
      [newEmail],
    )).rows as { person_id: string }[];
    if (matches.length === 1) {
      const personId = matches[0].person_id;
      const joined = (await client.query(
        `INSERT INTO person_identity(person_id, system, instance, external_id, email, display_name, origin, state)
         VALUES($1,$2,$3,$4,$5,$6,'email-join','proposed')
         ON CONFLICT (system, external_id) DO NOTHING
         RETURNING person_id`,
        [personId, system, instance, actor.external_id, newEmail, newName],
      )).rows[0] as { person_id: string } | undefined;
      if (joined) {
        await client.query(
          `INSERT INTO person_identity_audit(action, person_id, system, external_id, detail, source)
           VALUES('identity-email-joined',$1,$2,$3,$4::jsonb,'ingest')`,
          [personId, system, actor.external_id, JSON.stringify({ email: newEmail, display_name: newName })],
        );
        cache.set(cacheKey, personId);
        return personId;
      }
      // 경합으로 다른 트랜잭션이 먼저 만든 경우 — 룩업으로 폴백.
      const raced = (await client.query(
        `SELECT person_id FROM person_identity WHERE system=$1 AND external_id=$2`,
        [system, actor.external_id])).rows[0] as { person_id: string } | undefined;
      if (raced) { cache.set(cacheKey, raced.person_id); return raced.person_id; }
    }
  }

  // 3) 자동 생성 — 슬러그 폴백 + observed 신원(경합 안전 ON CONFLICT).
  const fallbackId = `${system}:${actor.external_id}`;
  const kind = actor.is_bot ? "agent" : "human";
  await client.query(
    `INSERT INTO person(id, display_name, kind) VALUES($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, person.display_name)`,
    [fallbackId, newName, kind],
  );
  const ins = (await client.query(
    `INSERT INTO person_identity(person_id, system, instance, external_id, email, display_name, origin, state)
     VALUES($1,$2,$3,$4,$5,$6,'observed','proposed')
     ON CONFLICT (system, external_id) DO UPDATE SET
       email = COALESCE(EXCLUDED.email, person_identity.email),
       display_name = COALESCE(EXCLUDED.display_name, person_identity.display_name),
       updated_at = now()
     RETURNING person_id, (xmax=0) AS inserted`,
    [fallbackId, system, instance, actor.external_id, newEmail, newName],
  )).rows[0] as { person_id: string; inserted: boolean };
  if (ins.inserted) {
    await client.query(
      `INSERT INTO person_identity_audit(action, person_id, system, external_id, detail, source)
       VALUES('identity-observed',$1,$2,$3,$4::jsonb,'ingest')`,
      [ins.person_id, system, actor.external_id,
       JSON.stringify({ email: newEmail, display_name: newName, kind })],
    );
  }
  cache.set(cacheKey, ins.person_id);
  return ins.person_id;
}

// 멱등 upsert: (prov_system, prov_instance, external_id) 가 키.
export async function ingestItems(items: RawItem[]): Promise<number> {
  const client = await itemsPool.connect();
  const actorCache = new Map<string, string>();
  let n = 0;
  try {
    for (const it of items) {
      let actorId: string | null = null;
      if (it.actor?.external_id) {
        actorId = await resolveActor(
          client, it.provenance.system, it.provenance.instance ?? null,
          { ...it.actor, external_id: it.actor.external_id }, actorCache,
        );
      }
      // container_ref 도 갱신(COALESCE — 새 값 부재 시 기존 보존): 태스크의 리스트 이동 등
      // 소스에서 컨테이너가 바뀌면 미러도 따라간다(툴 구조가 마스터). 과거엔 INSERT 시에만 기록돼
      // 이동 후 fields.list_id 와 container_ref 가 어긋나는 silent-stale 이 있었다.
      await client.query(
        `INSERT INTO item(type,prov_category,prov_system,prov_instance,external_id,external_url,
                          actor_id,container_ref,parent_external_id,title,body,occurred_at,updated_at,fields,raw)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)
         ON CONFLICT (prov_system,prov_instance,external_id) DO UPDATE SET
           title=EXCLUDED.title, body=EXCLUDED.body, external_url=EXCLUDED.external_url,
           container_ref=COALESCE(EXCLUDED.container_ref, item.container_ref),
           fields=EXCLUDED.fields, raw=EXCLUDED.raw, updated_at=COALESCE(EXCLUDED.updated_at, now())`,
        [it.type, it.provenance.category ?? null, it.provenance.system, it.provenance.instance ?? null,
         it.provenance.external_id, it.provenance.external_url ?? null, actorId, it.container_ref ?? null,
         it.parent_external_id ?? null, it.title ?? null, it.body ?? null,
         it.occurred_at ?? null, it.updated_at ?? null,
         JSON.stringify(it.fields ?? {}), it.raw != null ? JSON.stringify(it.raw) : null],
      );
      n++;
    }
  } finally {
    client.release();
  }
  return n;
}

// 부모 링크 해소: parent_external_id → parent_id (배치 후 1회 호출).
export async function resolveParents(): Promise<number> {
  const r = await itemsPool.query(`
    UPDATE item c SET parent_id = p.id
    FROM item p
    WHERE c.parent_id IS NULL AND c.parent_external_id IS NOT NULL
      AND p.prov_system = c.prov_system
      AND p.prov_instance IS NOT DISTINCT FROM c.prov_instance
      AND p.external_id = c.parent_external_id`);
  return r.rowCount ?? 0;
}

// (레거시 searchItems/getItem/unmappedItems 는 Stage① 에서 삭제 — MCP 도 웹과 동일한
//  canonical UI fn(searchItemsUi/getItemUi/unmappedItemsUi)을 capability 계층을 통해 공유한다.)

// ── 매핑 쓰기 경로 (단일 진실: MCP 툴·CLI·런북이 전부 이 함수를 공유) ──
// DESIGN §7.5/§10.5/§11 가드레일을 여기서 강제한다. 위반은 throw(SDK 가 isError:true 로 변환).

export type MappedBy = "rule" | "llm" | "manual" | "declared";
export interface ProposeResult {
  itemId: number;
  repo: string;
  key: string;
  mappedBy: string;
  state: string;
  action: "inserted" | "refreshed" | "skipped-confirmed" | "skipped-manual" | "skipped-rejected" | "skipped-provenance";
}

// provenance 우선순위 rule < llm < manual=declared. 재실행이 강한 출처를 약한 출처로 절대 강등하지 않는다.
// SQL CASE 로 mapped_by 강등 방지 — 들어온 출처가 기존보다 약하면 기존 mapped_by 유지.
// declared(커넥터 싱크 — 툴 구조가 진실)는 manual 과 동급 rank 3.
const PROVENANCE_RANK_SQL = `CASE WHEN mapped_by='manual' THEN 3 WHEN mapped_by='declared' THEN 3 WHEN mapped_by='llm' THEN 2 ELSE 1 END`;

// 공통 검증: repo 해소 → mapped_by 검증 → llm 근거 필수 → item 존재 → 후보 vocab 로드.
async function validateProposeBase(
  input: { itemId: number; mappedBy: MappedBy; repo?: string; evidence?: string },
  deps?: { candidates?: Candidates },
): Promise<{ repo: string; candidates: Candidates }> {
  const repo = resolveRepo(input.repo);
  if (!["rule", "llm", "manual"].includes(input.mappedBy)) {
    throw new Error(`mapped_by 는 rule|llm|manual 만 허용 (받은 값: ${input.mappedBy})`);
  }
  // LLM 제안은 반드시 근거(evidence) 동반 — DESIGN §11.
  if (input.mappedBy === "llm" && (!input.evidence || !input.evidence.trim())) {
    throw new Error("llm 매핑은 근거(evidence) 필수");
  }
  // 참조 item 존재 검증.
  const exists = (await itemsPool.query(`SELECT 1 FROM item WHERE id=$1`, [input.itemId])).rowCount ?? 0;
  if (!exists) throw new Error(`item ${input.itemId} 없음`);
  // 후보 vocab — domainmap 다운/404 는 검증 실패로 취급(조용한 write 금지).
  let candidates = deps?.candidates;
  if (!candidates) {
    try {
      candidates = await loadCandidates(repo);
    } catch (err) {
      throw new Error(`domainmap 후보 로드 실패(repo=${repo}): ${(err as Error).message}`);
    }
  }
  return { repo, candidates };
}

// item → domain 제안. 확정/수동 행은 절대 덮지 않는다(불변식: 조용한 손상 금지).
export async function proposeItemDomain(
  input: { itemId: number; domainKey: string; mappedBy: MappedBy; repo?: string; confidence?: number; evidence?: string },
  deps?: { candidates?: Candidates; audit?: AuditCtx },
): Promise<ProposeResult> {
  const { repo, candidates } = await validateProposeBase(input, deps);
  if (!validateDomainKey(candidates, input.domainKey)) {
    throw new Error(`domain_key ${input.domainKey} 검증 실패(repo=${repo})`);
  }
  // ON CONFLICT 의 WHERE 가 confirmed/manual 행 보호의 핵심(load-bearing).
  // + provenance 강등 방지: 들어온 출처 rank 가 기존 rank 이상일 때만 UPDATE(rule 이 llm 을 못 덮음).
  // 멀티도메인 보존 — 다른 domain_key 행은 건드리지 않음(DELETE 없음).
  // CTE: 매핑 upsert + 감사행 INSERT 를 한 스테이트먼트(=한 트랜잭션)로 — 감사 없는 쓰기 불가.
  const inRank = provenanceRank(input.mappedBy);
  const audit = auditDefaults(deps?.audit);
  const r = await itemsPool.query(
    `WITH up AS (
       INSERT INTO item_domain(item_id,repo,domain_key,mapped_by,confidence,state,evidence)
       VALUES($1,$2,$3,$4,$5,'proposed',$6)
       ON CONFLICT (item_id,repo,domain_key) DO UPDATE
         SET confidence=EXCLUDED.confidence, mapped_by=EXCLUDED.mapped_by, evidence=EXCLUDED.evidence
         WHERE item_domain.state='proposed' AND item_domain.mapped_by<>'manual'
           AND $7 >= (${PROVENANCE_RANK_SQL.replace(/mapped_by/g, "item_domain.mapped_by")})
       RETURNING (xmax=0) AS inserted, state
     )
     INSERT INTO item_mapping_audit(target,item_id,repo,key,mapped_by,action,state,confidence,evidence,source,actor)
     SELECT 'domain',$1,$2,$3,$4,
            CASE WHEN up.inserted THEN 'inserted' ELSE 'refreshed' END, up.state, $5,$6,$8,$9
     FROM up
     RETURNING (action='inserted') AS inserted, state`,
    [input.itemId, repo, input.domainKey, input.mappedBy, input.confidence ?? null,
     input.evidence ?? null, inRank, audit.source, audit.actor],
  );
  return await finishPropose(
    "item_domain_propose", "item_domain", "domain_key",
    input.itemId, repo, input.domainKey, input.mappedBy, r, audit,
  );
}

// item → project 제안. domain 과 동일 가드레일.
export async function proposeItemProject(
  input: { itemId: number; projectKey: string; mappedBy: MappedBy; repo?: string; confidence?: number; evidence?: string },
  deps?: { candidates?: Candidates; audit?: AuditCtx },
): Promise<ProposeResult> {
  const { repo, candidates } = await validateProposeBase(input, deps);
  if (!validateProjectKey(candidates, input.projectKey)) {
    throw new Error(`project_key ${input.projectKey} 검증 실패(repo=${repo})`);
  }
  const inRank = provenanceRank(input.mappedBy);
  const audit = auditDefaults(deps?.audit);
  const r = await itemsPool.query(
    `WITH up AS (
       INSERT INTO item_project(item_id,repo,project_key,mapped_by,confidence,state,evidence)
       VALUES($1,$2,$3,$4,$5,'proposed',$6)
       ON CONFLICT (item_id,repo,project_key) DO UPDATE
         SET confidence=EXCLUDED.confidence, mapped_by=EXCLUDED.mapped_by, evidence=EXCLUDED.evidence
         WHERE item_project.state='proposed' AND item_project.mapped_by<>'manual'
           AND $7 >= (${PROVENANCE_RANK_SQL.replace(/mapped_by/g, "item_project.mapped_by")})
       RETURNING (xmax=0) AS inserted, state
     )
     INSERT INTO item_mapping_audit(target,item_id,repo,key,mapped_by,action,state,confidence,evidence,source,actor)
     SELECT 'project',$1,$2,$3,$4,
            CASE WHEN up.inserted THEN 'inserted' ELSE 'refreshed' END, up.state, $5,$6,$8,$9
     FROM up
     RETURNING (action='inserted') AS inserted, state`,
    [input.itemId, repo, input.projectKey, input.mappedBy, input.confidence ?? null,
     input.evidence ?? null, inRank, audit.source, audit.actor],
  );
  return await finishPropose(
    "item_project_propose", "item_project", "project_key",
    input.itemId, repo, input.projectKey, input.mappedBy, r, audit,
  );
}

// ── 확정(proposed → confirmed) 쓰기 경로 ──
// 사람 큐레이션의 명시 행위: state='confirmed', mapped_by='manual'(사람 진실)로 못 박는다.
// 이후 매퍼/LLM 제안으로부터 영구 보호(ON CONFLICT WHERE 가 confirmed/manual 둘 다 막음).
// propose 와 동일 검증(repo·item 존재·key vocab) 공유 — free-form 쓰기 아님.
export interface ConfirmResult {
  itemId: number; repo: string; key: string; mappedBy: "manual"; state: "confirmed";
  action: "inserted" | "updated";
}

export async function confirmItemDomain(
  input: { itemId: number; domainKey: string; repo?: string; confidence?: number; evidence?: string },
  deps?: { candidates?: Candidates; audit?: AuditCtx },
): Promise<ConfirmResult> {
  const { repo, candidates } = await validateProposeBase({ ...input, mappedBy: "manual" }, deps);
  if (!validateDomainKey(candidates, input.domainKey)) {
    throw new Error(`domain_key ${input.domainKey} 검증 실패(repo=${repo})`);
  }
  const audit = auditDefaults(deps?.audit);
  const r = await itemsPool.query(
    `WITH up AS (
       INSERT INTO item_domain(item_id,repo,domain_key,mapped_by,confidence,state,evidence)
       VALUES($1,$2,$3,'manual',$4,'confirmed',$5)
       ON CONFLICT (item_id,repo,domain_key) DO UPDATE
         SET mapped_by='manual', state='confirmed',
             confidence=COALESCE(EXCLUDED.confidence, item_domain.confidence),
             evidence=COALESCE(EXCLUDED.evidence, item_domain.evidence)
       RETURNING (xmax=0) AS inserted
     )
     INSERT INTO item_mapping_audit(target,item_id,repo,key,mapped_by,action,state,confidence,evidence,source,actor)
     SELECT 'domain',$1,$2,$3,'manual',
            CASE WHEN up.inserted THEN 'confirm-inserted' ELSE 'confirm-updated' END,'confirmed',$4,$5,$6,$7
     FROM up
     RETURNING (action='confirm-inserted') AS inserted`,
    [input.itemId, repo, input.domainKey, input.confidence ?? null, input.evidence ?? null,
     audit.source, audit.actor],
  );
  const inserted = (r.rows[0] as { inserted: boolean }).inserted;
  logger.info({ audit: "item_domain_confirm", itemId: input.itemId, repo, key: input.domainKey, source: audit.source, actor: audit.actor });
  return { itemId: input.itemId, repo, key: input.domainKey, mappedBy: "manual", state: "confirmed", action: inserted ? "inserted" : "updated" };
}

export async function confirmItemProject(
  input: { itemId: number; projectKey: string; repo?: string; confidence?: number; evidence?: string },
  deps?: { candidates?: Candidates; audit?: AuditCtx },
): Promise<ConfirmResult> {
  const { repo, candidates } = await validateProposeBase({ ...input, mappedBy: "manual" }, deps);
  if (!validateProjectKey(candidates, input.projectKey)) {
    throw new Error(`project_key ${input.projectKey} 검증 실패(repo=${repo})`);
  }
  const audit = auditDefaults(deps?.audit);
  const r = await itemsPool.query(
    `WITH up AS (
       INSERT INTO item_project(item_id,repo,project_key,mapped_by,confidence,state,evidence)
       VALUES($1,$2,$3,'manual',$4,'confirmed',$5)
       ON CONFLICT (item_id,repo,project_key) DO UPDATE
         SET mapped_by='manual', state='confirmed',
             confidence=COALESCE(EXCLUDED.confidence, item_project.confidence),
             evidence=COALESCE(EXCLUDED.evidence, item_project.evidence)
       RETURNING (xmax=0) AS inserted
     )
     INSERT INTO item_mapping_audit(target,item_id,repo,key,mapped_by,action,state,confidence,evidence,source,actor)
     SELECT 'project',$1,$2,$3,'manual',
            CASE WHEN up.inserted THEN 'confirm-inserted' ELSE 'confirm-updated' END,'confirmed',$4,$5,$6,$7
     FROM up
     RETURNING (action='confirm-inserted') AS inserted`,
    [input.itemId, repo, input.projectKey, input.confidence ?? null, input.evidence ?? null,
     audit.source, audit.actor],
  );
  const inserted = (r.rows[0] as { inserted: boolean }).inserted;
  logger.info({ audit: "item_project_confirm", itemId: input.itemId, repo, key: input.projectKey, source: audit.source, actor: audit.actor });
  return { itemId: input.itemId, repo, key: input.projectKey, mappedBy: "manual", state: "confirmed", action: inserted ? "inserted" : "updated" };
}

// ── 선언(declared) 쓰기 경로 — 커넥터 싱크 전용 ──
// PM 툴의 구조적 사실(예: 태스크가 리스트/프로젝트에 속함)을 그대로 기록: mapped_by='declared',
// state='confirmed'(소스 구조 자체가 진실 — 설계결정 §1-②). 단일 마스터 원칙: 툴 구조가 마스터라
// ON CONFLICT 가 rejected/manual 행도 무조건 덮는다(감사행이 기록을 남김 — 이견은 PM 툴에서 고친다).
// 그런 덮어쓰기는 묻히지 않도록 별도 액션('overrode-rejected'/'overrode-manual')으로 반환·감사돼
// phase ③ 싱크 요약이 충돌로 표면화할 수 있다. 사람이 declared 매핑에 이견이 있으면
// 우리 스토어가 아니라 PM 툴의 구조를 바꿔야 한다(runbooks/map-items.md 참조).
// 불변식: 호출자는 커넥터 싱크 코드 경로뿐 — MCP propose(zod enum + llm-only 가드)에서 절대 도달 불가.
export interface DeclareResult {
  itemId: number; repo: string; key: string; mappedBy: "declared"; state: "confirmed";
  action: "inserted" | "updated" | "overrode-rejected" | "overrode-manual";
}

export async function declareItemProject(
  input: { itemId: number; projectKey: string; repo?: string; confidence?: number; evidence?: string },
  deps?: { candidates?: Candidates; audit?: AuditCtx },
): Promise<DeclareResult> {
  // 검증은 confirm 과 동일 경로 공유(repo·item 존재·key vocab) — mappedBy 인자는 검증 통과용.
  const { repo, candidates } = await validateProposeBase({ ...input, mappedBy: "manual" }, deps);
  if (!validateProjectKey(candidates, input.projectKey)) {
    throw new Error(`project_key ${input.projectKey} 검증 실패(repo=${repo})`);
  }
  const audit = deps?.audit?.source
    ? auditDefaults(deps.audit)
    : auditDefaults({ ...deps?.audit, source: "connector-sync" });
  // prev CTE 는 스테이트먼트 시작 스냅샷을 읽어(동일 쿼리 내 INSERT 효과 비가시) 덮기 전 상태를 포착 —
  // rejected/manual 덮어쓰기를 일반 'declared-updated' 와 구분된 감사 액션으로 남긴다.
  const r = await itemsPool.query(
    `WITH prev AS (
       SELECT state, mapped_by FROM item_project WHERE item_id=$1 AND repo=$2 AND project_key=$3
     ), up AS (
       INSERT INTO item_project(item_id,repo,project_key,mapped_by,confidence,state,evidence)
       VALUES($1,$2,$3,'declared',$4,'confirmed',$5)
       ON CONFLICT (item_id,repo,project_key) DO UPDATE
         SET mapped_by='declared', state='confirmed',
             confidence=COALESCE(EXCLUDED.confidence, item_project.confidence),
             evidence=COALESCE(EXCLUDED.evidence, item_project.evidence)
       RETURNING (xmax=0) AS inserted
     )
     INSERT INTO item_mapping_audit(target,item_id,repo,key,mapped_by,action,state,confidence,evidence,source,actor)
     SELECT 'project',$1,$2,$3,'declared',
            CASE WHEN up.inserted THEN 'declared-inserted'
                 WHEN prev.state='rejected' THEN 'declared-overrode-rejected'
                 WHEN prev.mapped_by='manual' THEN 'declared-overrode-manual'
                 ELSE 'declared-updated' END,'confirmed',$4,$5,$6,$7
     FROM up LEFT JOIN prev ON TRUE
     RETURNING action`,
    [input.itemId, repo, input.projectKey, input.confidence ?? null, input.evidence ?? null,
     audit.source, audit.actor],
  );
  const auditAction = (r.rows[0] as { action: string }).action;
  const action: DeclareResult["action"] = auditAction === "declared-inserted" ? "inserted"
    : auditAction === "declared-overrode-rejected" ? "overrode-rejected"
    : auditAction === "declared-overrode-manual" ? "overrode-manual"
    : "updated";
  const logFn = action.startsWith("overrode") ? logger.warn.bind(logger) : logger.info.bind(logger);
  logFn({ audit: "item_project_declare", itemId: input.itemId, repo, key: input.projectKey, action, source: audit.source, actor: audit.actor });
  return { itemId: input.itemId, repo, key: input.projectKey, mappedBy: "declared", state: "confirmed", action };
}

// ── 선언 매핑 형제 강등 — 리스트 간 이동 수렴(declared 단일 진실) ──
// 태스크가 ClickUp 에서 다른 리스트로 옮겨지면 옛 리스트의 declared 행은 더 이상 구조적 사실이
// 아니다. 같은 (item, repo)의 declared 행 중 현재 키가 아닌 것을 state='rejected' 로 강등해
// 한 아이템이 두 프로젝트에 confirmed 로 동시 등장하는 silent-wrong 을 막는다.
// mapped_by='declared' 행만 건드린다(manual/rule/llm 큐레이션의 멀티프로젝트 매핑은 보존).
// 멱등(이미 rejected/현재 키 = 0행). 되돌아오면 declareItemProject 가 rejected 를 도로 덮는다
// (action 'overrode-rejected' — 툴 구조가 마스터). CTE 로 강등+감사행이 한 스테이트먼트(원자).
// 불변식: 호출자는 커넥터 싱크(run-sync)와 pm 에코뿐 — 사람 큐레이션 경로에서 호출 금지.
export async function supersedeSiblingDeclaredProjects(
  input: { itemId: number; keepProjectKey: string; repo?: string },
  deps?: { audit?: AuditCtx },
): Promise<string[]> {
  const repo = resolveRepo(input.repo);
  const audit = auditDefaults(deps?.audit);
  const r = await itemsPool.query(
    `WITH up AS (
       UPDATE item_project SET state='rejected'
       WHERE item_id=$1 AND repo=$2 AND mapped_by='declared'
         AND project_key <> $3 AND state <> 'rejected'
       RETURNING project_key
     )
     INSERT INTO item_mapping_audit(target,item_id,repo,key,mapped_by,action,state,evidence,source,actor)
     SELECT 'project',$1,$2,up.project_key,'declared','declared-superseded','rejected',$4,$5,$6 FROM up
     RETURNING key`,
    [input.itemId, repo, input.keepProjectKey,
     `superseded by ${input.keepProjectKey} (컨테이너 이동 수렴)`, audit.source, audit.actor],
  );
  const demoted = (r.rows as { key: string }[]).map((x) => x.key);
  if (demoted.length) {
    logger.warn({
      audit: "item_project_declare_supersede", itemId: input.itemId, repo,
      kept: input.keepProjectKey, demoted, source: audit.source, actor: audit.actor,
    });
  }
  return demoted;
}

// ── 기각(→ rejected) 쓰기 경로 ──
// 사람 큐레이션의 명시 행위: state='rejected' 로 전이. proposed/confirmed 양쪽에서 허용
// (confirmed 기각도 사람 판단 — audit 가 커버). 기각 행은 rule/llm/manual 재제안을 영구 차단
// (ON CONFLICT 의 state='proposed' 술어 탈락 → skipped-rejected), 부활 경로는 confirm 뿐.
// 행의 mapped_by/confidence/evidence 는 보존(원제안 provenance 유지) — 기각 사유는 audit.evidence,
// 기각자는 audit.actor. loadCandidates 불호출: 존재하는 행 자체가 검증이며 domainmap 다운 중에도 기각 가능.
// 불변식: 호출자는 curate capability(사람 지시)와 propose-cli --reject 뿐 —
// mapping-run/mapping-extract(매퍼/rule 코드)는 절대 import 금지(rejected 를 쓰는 자동 경로 없음).
export interface RejectResult {
  itemId: number; repo: string; key: string; mappedBy: string;
  state: "rejected"; previousState: string;
  action: "rejected" | "already-rejected";
}

async function rejectMapping(
  table: "item_domain" | "item_project", keyCol: "domain_key" | "project_key",
  input: { itemId: number; key: string; repo?: string; reason?: string },
  deps?: { audit?: AuditCtx },
): Promise<RejectResult> {
  const repo = resolveRepo(input.repo);
  const target = table === "item_domain" ? "domain" : "project";
  const audit = auditDefaults(deps?.audit);
  // CTE 원자: previousState 캡처 + UPDATE + 감사행 INSERT 를 한 스테이트먼트로 — 사전 SELECT 와
  // UPDATE 사이 TOCTOU(동시 confirm/reject 시 stale previousState 기록, 0행 매치인데 action='rejected'
  // 보고 + 감사행 0개) 제거. old 셀프조인(UPDATE … FROM)은 같은 스냅샷의 갱신 전 행을 읽는다.
  const r = await itemsPool.query(
    `WITH up AS (
       UPDATE ${table} t SET state='rejected'
       FROM ${table} old
       WHERE t.item_id=$1 AND t.repo=$2 AND t.${keyCol}=$3 AND t.state <> 'rejected'
         AND old.item_id=t.item_id AND old.repo=t.repo AND old.${keyCol}=t.${keyCol}
       RETURNING old.state AS previous_state, old.mapped_by
     ),
     aud AS (
       INSERT INTO item_mapping_audit(target,item_id,repo,key,mapped_by,action,state,evidence,source,actor)
       SELECT $4,$1,$2,$3, up.mapped_by, 'rejected','rejected',$5,$6,$7 FROM up
     )
     SELECT previous_state, mapped_by FROM up`,
    [input.itemId, repo, input.key, target, input.reason ?? null, audit.source, audit.actor],
  );
  const hit = r.rows[0] as { previous_state: string; mapped_by: string } | undefined;
  if (!hit) {
    // 0행 = 행 부재 또는 이미 rejected — 종결 상태(rejected 는 confirm 으로만 이탈, 부재는 propose 로만
    // 생성)라 분류용 재조회가 안전하다. 멱등 already-rejected 는 audit 무기록 유지(의도된 비대칭):
    // finishPropose 의 skipped-* 는 자동 경로(rule/llm)의 차단 시도를 추적하지만, reject 시도 주체는
    // 사람 큐레이터뿐이라 무변경 재시도의 감사 가치가 없다.
    const cur = (await itemsPool.query(
      `SELECT state, mapped_by FROM ${table} WHERE item_id=$1 AND repo=$2 AND ${keyCol}=$3`,
      [input.itemId, repo, input.key],
    )).rows[0] as { state: string; mapped_by: string } | undefined;
    if (!cur || cur.state !== "rejected") {
      throw new Error(`매핑 없음 — item ${input.itemId} repo=${repo} key=${input.key}`); // '없음' 토큰 → REST 404
    }
    return {
      itemId: input.itemId, repo, key: input.key, mappedBy: cur.mapped_by,
      state: "rejected", previousState: "rejected", action: "already-rejected",
    };
  }
  logger.info({
    audit: `${table}_reject`, itemId: input.itemId, repo, key: input.key,
    previousState: hit.previous_state, source: audit.source, actor: audit.actor,
  });
  return {
    itemId: input.itemId, repo, key: input.key, mappedBy: hit.mapped_by,
    state: "rejected", previousState: hit.previous_state, action: "rejected",
  };
}

export async function rejectItemDomain(
  input: { itemId: number; domainKey: string; repo?: string; reason?: string },
  deps?: { audit?: AuditCtx },
): Promise<RejectResult> {
  return rejectMapping("item_domain", "domain_key",
    { itemId: input.itemId, key: input.domainKey, repo: input.repo, reason: input.reason }, deps);
}

export async function rejectItemProject(
  input: { itemId: number; projectKey: string; repo?: string; reason?: string },
  deps?: { audit?: AuditCtx },
): Promise<RejectResult> {
  return rejectMapping("item_project", "project_key",
    { itemId: input.itemId, key: input.projectKey, repo: input.repo, reason: input.reason }, deps);
}

function provenanceRank(by: MappedBy): number {
  return by === "manual" || by === "declared" ? 3 : by === "llm" ? 2 : 1;
}

// upsert 결과 해석 + 감사 로깅. 0행 = WHERE 가드로 보호된 행(throw 안 함).
// 0행 사유는 넷 — (a) state='rejected'(기각 행은 rule/llm/manual 재제안 영구 차단 — ON CONFLICT 의
// state='proposed' 술어에서 탈락, 부활은 confirm 경로만), (b) state='confirmed',
// (c) mapped_by='manual'(state='proposed'), (d) provenance 강등(예: rule 이 기존 llm 을 못 덮음).
// 실제 행을 재조회해 정확한 state/action 보고 — rejected 분기가 최우선(manual 분기보다 먼저).
// 감사: inserted/refreshed 는 CTE 가 이미 원자적으로 기록 — 여기선 skipped-* 만 별도 기록
// (보호로 매핑 무변경이므로 사후 기록이어도 '감사 없는 데이터 변경'은 발생 불가).
async function finishPropose(
  audit: string, table: "item_domain" | "item_project", keyCol: "domain_key" | "project_key",
  itemId: number, repo: string, key: string, mappedBy: string,
  r: pg.QueryResult, auditCtx: { source: string; actor: string },
): Promise<ProposeResult> {
  const target = table === "item_domain" ? "domain" : "project";
  if ((r.rowCount ?? 0) === 0) {
    // 보호된 행의 실제 state/mapped_by 를 읽어 정확히 분류(쿼리 1회 — 보호 경로에서만).
    const cur = (await itemsPool.query(
      `SELECT state, mapped_by FROM ${table} WHERE item_id=$1 AND repo=$2 AND ${keyCol}=$3`,
      [itemId, repo, key],
    )).rows[0] as { state: string; mapped_by: string } | undefined;
    const state = cur?.state ?? "proposed";
    // rejected → skipped-rejected(최우선); confirmed → skipped-confirmed; proposed+manual → skipped-manual;
    // 그 외(proposed+더 강한 provenance, 예: rule 이 기존 llm 을 못 덮음) → skipped-provenance.
    // 구버전은 이 마지막 분기를 skipped-confirmed 로 라벨링했으나 audit 행이 action='skipped-confirmed'
    // + state='proposed' 로 자기모순이라 분리(소비처 mapping-run/app.js 는 action 별 분기 없이 안전).
    const action = state === "rejected"
      ? "skipped-rejected" as const
      : state === "confirmed"
        ? "skipped-confirmed" as const
        : cur?.mapped_by === "manual"
          ? "skipped-manual" as const
          : "skipped-provenance" as const; // 매퍼/UI 는 모든 skipped-* 를 "건너뜀"으로 처리
    await itemsPool.query(
      `INSERT INTO item_mapping_audit(target,item_id,repo,key,mapped_by,action,state,source,actor)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [target, itemId, repo, key, mappedBy, action, state, auditCtx.source, auditCtx.actor],
    );
    logger.info({ audit, itemId, repo, key, mappedBy, action, existing: cur?.mapped_by, state });
    return { itemId, repo, key, mappedBy: cur?.mapped_by ?? mappedBy, state, action };
  }
  const row = r.rows[0] as { inserted: boolean; state: string };
  const action = row.inserted ? "inserted" : "refreshed";
  logger.info({ audit, itemId, repo, key, mappedBy, action });
  return { itemId, repo, key, mappedBy, state: row.state, action };
}

// relation 테이블 writer — D5/P4 'mentions'. from/to 는 item(id) FK(ON DELETE CASCADE)로
// 참조무결성 보장 — 댕글링/고아 행 불가, 존재하지 않는 id 면 INSERT 가 FK 위반으로 throw.
// 멱등(ON CONFLICT DO NOTHING). 현재 매퍼 내부 전용 — MCP 툴로 노출하려면 requireScope+검증 필수.
export async function addRelation(fromItem: number, toItem: number, type = "mentions"): Promise<boolean> {
  const r = await itemsPool.query(
    `INSERT INTO relation(from_item,to_item,type) VALUES($1,$2,$3)
     ON CONFLICT (from_item,to_item,type) DO NOTHING`,
    [fromItem, toItem, type],
  );
  return (r.rowCount ?? 0) > 0;
}

// ════════════════════════════════════════════════════════════════════
// ── canonical UI 읽기 fn — capability 계층(src/capabilities/*)을 통해
// 웹 REST 와 MCP 가 동일 페이로드를 공유한다(Stage①). 전부 read-only +
// 파라미터라이즈드 쿼리, limit/offset 은 클램프 후 숫자 보간(기존 컨벤션).
// rejected 행은 기본 제외(읽기 의미론) — includeRejected 옵션으로만 노출.
// ════════════════════════════════════════════════════════════════════

export interface UiCoverageRow {
  repo: string;
  domainItems: number; domainProposed: number; domainConfirmed: number;
  projectItems: number; projectProposed: number; projectConfirmed: number;
}
export interface UiStats {
  total: number;
  bySystem: { system: string; count: number }[];
  byType: { type: string; count: number }[];
  lastOccurredAt: string | null;
  threadReplies: number;
  recentDaily: { day: string; count: number }[];
  coverage: UiCoverageRow[];
}

// 개요 히어로/커버리지 카드용 통계 집계.
export async function uiStats(): Promise<UiStats> {
  // items 카운트는 살아있는 매핑(proposed|confirmed)만 — rejected-only 아이템은 '커버됨'이 아님.
  const coverageSql = (table: "item_domain" | "item_project") => `
    SELECT repo, count(DISTINCT item_id) FILTER (WHERE state IN ('proposed','confirmed'))::int AS items,
           count(DISTINCT item_id) FILTER (WHERE state='confirmed')::int AS confirmed,
           count(DISTINCT item_id) FILTER (WHERE state='proposed')::int AS proposed
    FROM ${table} GROUP BY repo`;
  const [head, bySystem, byType, daily, dom, proj] = await Promise.all([
    itemsPool.query(`SELECT count(*)::int AS total, max(occurred_at) AS last,
                            count(*) FILTER (WHERE parent_id IS NOT NULL)::int AS replies FROM item`),
    itemsPool.query(`SELECT prov_system AS system, count(*)::int AS count FROM item GROUP BY 1 ORDER BY 2 DESC`),
    itemsPool.query(`SELECT type, count(*)::int AS count FROM item GROUP BY 1 ORDER BY 2 DESC`),
    // 일자 키는 Asia/Seoul 고정 — 클라이언트(app.js 스파크라인)도 같은 TZ 로 키를 만들므로 서버 TZ 에 흔들리지 않음.
    itemsPool.query(`SELECT (occurred_at AT TIME ZONE 'Asia/Seoul')::date::text AS day, count(*)::int AS count
                     FROM item WHERE occurred_at >= now() - interval '14 days' GROUP BY 1 ORDER BY 1`),
    itemsPool.query(coverageSql("item_domain")),
    itemsPool.query(coverageSql("item_project")),
  ]);
  const cov = new Map<string, UiCoverageRow>();
  const blank = (repo: string): UiCoverageRow =>
    ({ repo, domainItems: 0, domainProposed: 0, domainConfirmed: 0, projectItems: 0, projectProposed: 0, projectConfirmed: 0 });
  for (const r of dom.rows as { repo: string; items: number; confirmed: number; proposed: number }[]) {
    const c = cov.get(r.repo) ?? blank(r.repo);
    c.domainItems = r.items; c.domainProposed = r.proposed; c.domainConfirmed = r.confirmed;
    cov.set(r.repo, c);
  }
  for (const r of proj.rows as { repo: string; items: number; confirmed: number; proposed: number }[]) {
    const c = cov.get(r.repo) ?? blank(r.repo);
    c.projectItems = r.items; c.projectProposed = r.proposed; c.projectConfirmed = r.confirmed;
    cov.set(r.repo, c);
  }
  const h = head.rows[0] as { total: number; last: Date | null; replies: number };
  return {
    total: h.total,
    lastOccurredAt: h.last ? new Date(h.last).toISOString() : null,
    threadReplies: h.replies,
    bySystem: bySystem.rows,
    byType: byType.rows,
    recentDaily: daily.rows,
    coverage: [...cov.values()].sort((a, b) => a.repo.localeCompare(b.repo)),
  };
}

// 매핑 테이블에 등장하는 repo 목록 — repo 셀렉터의 단일 소스(하드코딩 금지: 멀티레포 대응).
// rejected-only repo 는 제외(살아있는 매핑이 있는 repo 만).
export async function listMappingRepos(): Promise<string[]> {
  const r = await itemsPool.query(
    `SELECT DISTINCT repo FROM item_domain WHERE state <> 'rejected'
     UNION SELECT DISTINCT repo FROM item_project WHERE state <> 'rejected' ORDER BY 1`);
  return (r.rows as { repo: string }[]).map((x) => x.repo);
}

// 리스트 행 공통 SELECT — 스니펫(left 400) + 매핑 배지(json_agg). 'snippet'+body_length 로
// 정직하게 명명(기존 'body' 별칭 400자 절단 모호성 회피). 배지는 rejected 기본 제외.
const uiListSelect = (includeRejected = false) => {
  const dSt = includeRejected ? "" : ` AND d.state <> 'rejected'`;
  const pSt = includeRejected ? "" : ` AND pr.state <> 'rejected'`;
  return `
  SELECT i.id, i.type, i.prov_system AS system, i.container_ref, i.title,
         left(i.body, 400) AS snippet, length(i.body)::int AS body_length,
         i.external_url, i.occurred_at, i.parent_id, pe.display_name AS actor,
         (SELECT COALESCE(json_agg(json_build_object('repo', d.repo, 'key', d.domain_key, 'state', d.state, 'by', d.mapped_by)
                                   ORDER BY d.repo, d.domain_key), '[]'::json)
            FROM item_domain d WHERE d.item_id = i.id${dSt}) AS domains,
         (SELECT COALESCE(json_agg(json_build_object('repo', pr.repo, 'key', pr.project_key, 'state', pr.state, 'by', pr.mapped_by)
                                   ORDER BY pr.repo, pr.project_key), '[]'::json)
            FROM item_project pr WHERE pr.item_id = i.id${pSt}) AS projects
  FROM item i LEFT JOIN person pe ON pe.id = i.actor_id`;
};

export interface UiListParams {
  query?: string; type?: string; system?: string; repo?: string;
  domainKey?: string; projectKey?: string; since?: string; limit?: number; offset?: number;
  includeRejected?: boolean;
}

// 탐색 리스트 — searchItems 의 WHERE 빌더 패턴 + repo 스코프/offset 확장.
// repo 는 키와 함께면 EXISTS 내부 한정, 단독이면 '해당 repo 에 매핑이 있는 아이템'(no-op 방지 — 필터가
// 적용된 것처럼 보이는데 결과가 안 바뀌는 데이터 정직성 문제).
export async function searchItemsUi(p: UiListParams): Promise<unknown[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  const ph = (v: unknown) => { args.push(v); return `$${args.length}`; };
  if (p.query) { const q = ph(`%${p.query}%`); where.push(`(i.title ILIKE ${q} OR i.body ILIKE ${q})`); }
  if (p.type) where.push(`i.type = ${ph(p.type)}`);
  if (p.system) where.push(`i.prov_system = ${ph(p.system)}`);
  if (p.since) where.push(`i.occurred_at >= ${ph(p.since)}`);
  // 매핑 기반 필터(EXISTS)도 rejected 기본 제외 — 기각된 매핑이 domainKey/repo 필터에 매치되지 않게.
  const dSt = p.includeRejected ? "" : ` AND d.state <> 'rejected'`;
  const pSt = p.includeRejected ? "" : ` AND pr.state <> 'rejected'`;
  if (p.domainKey) {
    const keyPh = ph(p.domainKey);
    const repoCond = p.repo ? ` AND d.repo = ${ph(p.repo)}` : "";
    where.push(`EXISTS (SELECT 1 FROM item_domain d WHERE d.item_id=i.id AND d.domain_key=${keyPh}${repoCond}${dSt})`);
  }
  if (p.projectKey) {
    const keyPh = ph(p.projectKey);
    const repoCond = p.repo ? ` AND pr.repo = ${ph(p.repo)}` : "";
    where.push(`EXISTS (SELECT 1 FROM item_project pr WHERE pr.item_id=i.id AND pr.project_key=${keyPh}${repoCond}${pSt})`);
  }
  if (p.repo && !p.domainKey && !p.projectKey) {
    const repoPh = ph(p.repo); // 같은 플레이스홀더 재사용
    where.push(`(EXISTS (SELECT 1 FROM item_domain d WHERE d.item_id=i.id AND d.repo=${repoPh}${dSt})
      OR EXISTS (SELECT 1 FROM item_project pr WHERE pr.item_id=i.id AND pr.repo=${repoPh}${pSt}))`);
  }
  const limit = Math.min(Math.max(Math.trunc(p.limit ?? 30), 1), 100);
  const offset = Math.min(Math.max(Math.trunc(p.offset ?? 0), 0), 5000);
  const sql = `${uiListSelect(p.includeRejected)}
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY i.occurred_at DESC NULLS LAST
    LIMIT ${limit} OFFSET ${offset}`;
  return (await itemsPool.query(sql, args)).rows;
}

export interface UiInboxParams {
  missing?: "domain" | "project" | "either" | "both";
  repo?: string; system?: string; type?: string; since?: string; limit?: number; offset?: number;
}

// 큐레이션 inbox — repo 를 NOT EXISTS 내부 조건으로 스코프('그 repo 기준 미매핑').
// '매핑 있음' = state IN ('proposed','confirmed') 만 — rejected-only 아이템은 미매핑으로 inbox 복귀.
export async function unmappedItemsUi(p: UiInboxParams): Promise<{ count: number; rows: unknown[] }> {
  const where: string[] = [];
  const args: unknown[] = [];
  const ph = (v: unknown) => { args.push(v); return `$${args.length}`; };
  // 사용하는 분기에서만 ph() 호출(미사용 인자가 args 에 끼면 pg bind 에러).
  const LIVE = `state IN ('proposed','confirmed')`;
  const noDomain = () => p.repo
    ? `NOT EXISTS (SELECT 1 FROM item_domain d WHERE d.item_id=i.id AND d.repo=${ph(p.repo)} AND d.${LIVE})`
    : `NOT EXISTS (SELECT 1 FROM item_domain d WHERE d.item_id=i.id AND d.${LIVE})`;
  const noProject = () => p.repo
    ? `NOT EXISTS (SELECT 1 FROM item_project pr WHERE pr.item_id=i.id AND pr.repo=${ph(p.repo)} AND pr.${LIVE})`
    : `NOT EXISTS (SELECT 1 FROM item_project pr WHERE pr.item_id=i.id AND pr.${LIVE})`;
  const missing = p.missing ?? "either";
  if (missing === "domain") where.push(noDomain());
  else if (missing === "project") where.push(noProject());
  else if (missing === "both") where.push(`(${noDomain()} AND ${noProject()})`);
  else where.push(`(${noDomain()} OR ${noProject()})`); // either(기본)
  if (p.system) where.push(`i.prov_system = ${ph(p.system)}`);
  if (p.type) where.push(`i.type = ${ph(p.type)}`);
  if (p.since) where.push(`i.occurred_at >= ${ph(p.since)}`);
  const condition = where.join(" AND ");
  const limit = Math.min(Math.max(Math.trunc(p.limit ?? 20), 1), 100);
  const offset = Math.min(Math.max(Math.trunc(p.offset ?? 0), 0), 5000);
  const count = ((await itemsPool.query(
    `SELECT count(*)::int AS count FROM item i WHERE ${condition}`, args)).rows[0] as { count: number }).count;
  const rows = (await itemsPool.query(
    `${uiListSelect()}
     WHERE ${condition}
     ORDER BY i.occurred_at DESC NULLS LAST
     LIMIT ${limit} OFFSET ${offset}`, args)).rows;
  return { count, rows };
}

// 디테일(canonical) — raw JSONB 영구 제외 + SQL 단계 body 클램프(notion 100k~500k 본문이
// PG→node 로 통째로 안 넘어오게). 매핑은 rejected 기본 제외 — includeRejected 옵션으로만 노출.
export async function getItemUi(
  id: number, bodyLimit = 20000, opts?: { includeRejected?: boolean },
): Promise<{ item: Record<string, unknown>; domains: unknown[]; projects: unknown[] } | null> {
  const item = (await itemsPool.query(
    `SELECT i.id, i.type, i.prov_category, i.prov_system AS system, i.prov_instance, i.external_id, i.external_url,
            i.container_ref, i.parent_external_id, i.parent_id, i.title,
            left(i.body, $2) AS body, length(i.body)::int AS body_length,
            i.occurred_at, i.updated_at, i.fields, pe.display_name AS actor
     FROM item i LEFT JOIN person pe ON pe.id = i.actor_id WHERE i.id = $1`,
    [id, bodyLimit],
  )).rows[0] as Record<string, unknown> | undefined;
  if (!item) return null;
  const stCond = opts?.includeRejected ? "" : ` AND state <> 'rejected'`;
  const domains = (await itemsPool.query(
    `SELECT repo, domain_key, mapped_by, state, confidence, evidence FROM item_domain WHERE item_id=$1${stCond} ORDER BY repo, domain_key`,
    [id])).rows;
  const projects = (await itemsPool.query(
    `SELECT repo, project_key, mapped_by, state, confidence, evidence FROM item_project WHERE item_id=$1${stCond} ORDER BY repo, project_key`,
    [id])).rows;
  return { item, domains, projects };
}

export interface ThreadRow {
  id: number; parent_id: number | null; type: string; system: string;
  title: string | null; snippet: string | null; external_url: string | null;
  occurred_at: string | null; actor: string | null;
}

// 스레드 — 부모 체인(루트까지, depth 가드 20: 사이클/이상 데이터 방어) + 직계 답글. 스니펫만(풀바디 금지).
export async function getItemThread(id: number): Promise<{ ancestors: ThreadRow[]; children: ThreadRow[] }> {
  const ancestors = (await itemsPool.query(
    `WITH RECURSIVE up(id, parent_id, type, prov_system, title, body, external_url, occurred_at, actor_id, depth) AS (
       SELECT i.id, i.parent_id, i.type, i.prov_system, i.title, i.body, i.external_url, i.occurred_at, i.actor_id, 0
       FROM item i WHERE i.id = $1
       UNION ALL
       SELECT p.id, p.parent_id, p.type, p.prov_system, p.title, p.body, p.external_url, p.occurred_at, p.actor_id, up.depth + 1
       FROM item p JOIN up ON p.id = up.parent_id WHERE up.depth < 20)
     SELECT u.id, u.parent_id, u.type, u.prov_system AS system, u.title, left(u.body, 400) AS snippet,
            u.external_url, u.occurred_at, pe.display_name AS actor
     FROM up u LEFT JOIN person pe ON pe.id = u.actor_id
     WHERE u.id <> $1 ORDER BY u.depth DESC`, // 루트가 먼저 오도록
    [id])).rows as ThreadRow[];
  const children = (await itemsPool.query(
    `SELECT i.id, i.parent_id, i.type, i.prov_system AS system, i.title, left(i.body, 400) AS snippet,
            i.external_url, i.occurred_at, pe.display_name AS actor
     FROM item i LEFT JOIN person pe ON pe.id = i.actor_id
     WHERE i.parent_id = $1 ORDER BY i.occurred_at ASC NULLS LAST LIMIT 200`,
    [id])).rows as ThreadRow[];
  return { ancestors, children };
}

// 도메인/프로젝트 키별 아이템 수 — 도메인 페이지 카드의 "아이템 N건" grounding.
// rejected 제외(WHERE) — 기각만 남은 키는 목록에서 사라진다(응답 shape 무변경).
export async function mappingKeyCounts(repo: string): Promise<{
  domains: { key: string; count: number; confirmed: number }[];
  projects: { key: string; count: number; confirmed: number }[];
}> {
  const domains = (await itemsPool.query(
    `SELECT domain_key AS key, count(*)::int AS count, count(*) FILTER (WHERE state='confirmed')::int AS confirmed
     FROM item_domain WHERE repo=$1 AND state <> 'rejected' GROUP BY 1 ORDER BY 2 DESC`, [repo])).rows;
  const projects = (await itemsPool.query(
    `SELECT project_key AS key, count(*)::int AS count, count(*) FILTER (WHERE state='confirmed')::int AS confirmed
     FROM item_project WHERE repo=$1 AND state <> 'rejected' GROUP BY 1 ORDER BY 2 DESC`, [repo])).rows;
  return { domains, projects };
}

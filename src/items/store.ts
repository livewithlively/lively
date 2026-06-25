// Item store — DESIGN §5 canonical schema. 모든 소스(Slack/Discord/Notion…)가 여기로 정규화돼 들어온다.
// 별도 Postgres(ITEMS_DATABASE_URL). 도메인/프로젝트는 (repo, key) 소프트참조로 연결(domainmap 은 별 DB).
import pg from "pg";
import { logger } from "../log.js";
// v6 컷오버: 커넥터 미러는 v6 knowledge/project 로 적재한다(구 knowledge_unit 미러·테이블은 2026-06-24 제거됨).
//  소스로 갈라 적재: clickup task → project(level=task/subtask), notion 등 K류 → knowledge(observed).
//  멱등(external 부분유니크)·감사 노이즈 게이트·H1 redact 는 connector-mirror 내부에 이식돼 있다.
import {
  mirrorExternalToV6,
} from "../v6/connector-mirror.js";

// 통합 DB(P1): domainmap 엔진(itemsPool)도 이 풀을 공유한다 — withTx 장기점유 + 커넥터 ingest +
// activity_log 원자기록의 동시 부하를 감안해 max 명시(기본 10 → 20, 풀 고갈 방지).
export const itemsPool = new pg.Pool({ connectionString: process.env.ITEMS_DATABASE_URL, max: 20 });

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
  // ── item 폐기 컷오버: item/item_domain/item_project/relation/item_mapping_audit/item_legacy CREATE 제거. ──
  //  v6 knowledge 가 단일 캐노니컬 표면(initV6Schema 가 생성). 이 함수는 더 이상 item 물리 객체를
  //  만들지 않는다 → 재기동해도 드랍된 레거시 테이블이 되살아나지 않는다(drop-item-legacy.mjs 의 '스키마
  //  재생성 방지' 요건 충족). 보존(item 무관 보조층): person/person_identity(actor 신원), connector_state
  //  (증분 커서), pm_write_audit(pm op 감사). 라이브 드랍 전까지 기존 item 테이블/데이터는 비파괴로 남아 있다
  //  (이 코드가 안 만들 뿐 — 드랍은 drop-item-legacy.mjs 의 3중 잠금 경로로만).
  await itemsPool.query(`
    CREATE TABLE IF NOT EXISTS person(
      id TEXT PRIMARY KEY,
      display_name TEXT,
      identities JSONB DEFAULT '[]'::jsonb);
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
  // ── 신원 감사 로그 (append-only, FK 없음(의도) — 행 삭제 후에도 이력 보존) ──
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

// 멱등 upsert: (external_system, external_instance, external_id) 가 키 — v6 외부 미러(knowledge/project) 단독.
//  ── v6 컷오버: 커넥터/pm 인입은 mirrorExternalToV6 만 호출한다(item·knowledge_unit 무의존). 소스로 갈라
//     clickup task → project(level=task/subtask), notion 등 → knowledge(observed) 로 적재한다. person 신원
//     (resolveActor)은 created_by/author='connector:<system>' 와 별개 신원층이라 보존 — actor 정보가 있으면
//     person 에 계속 해소·적재한다(드랍 스크립트가 person 을 보존 대상으로 명시). 구 knowledge_unit 미러
//     (knowledge-mirror.ts)는 dead/parallel 로 보존(삭제 안 함 — 롤백/회귀 테스트 참조용). knowledge 의 parent
//     링크는 parent_name(자기참조)로 적재시 즉시 도출(구 resolveParents 별도 패스 불필요 — mirror 가 직접 채움). ──
export async function ingestItems(items: RawItem[]): Promise<number> {
  const client = await itemsPool.connect();
  const actorCache = new Map<string, string>();
  let n = 0;
  try {
    for (const it of items) {
      // person 신원 해소(ku.author 와 별개 신원층 — 보존). 결과는 person 테이블 적재로 끝(ku 미러는 author 슬러그 사용).
      if (it.actor?.external_id) {
        await resolveActor(
          client, it.provenance.system, it.provenance.instance ?? null,
          { ...it.actor, external_id: it.actor.external_id }, actorCache,
        );
      }
      // ── v6 외부 미러(단일 캐노니컬 쓰기). H1 redact 는 mirror 내부. 라우팅 불가 조합(slack 등)은 false(skip). ──
      //  clickup task → project(level=task/subtask), notion 등 → knowledge(observed). external 멱등 + 감사 게이트 내부.
      //  best-effort: 미러 실패가 인입(외부 계약·read-your-writes)을 깨면 안 되므로 try/catch 격리 —
      //  logger.warn 만 하고 다음 싱크가 멱등 수렴(external 멱등키 ON CONFLICT). 카운트는 인입 시도 단위.
      try {
        await mirrorExternalToV6(client, it);
      } catch (err) {
        logger.warn({ err, system: it.provenance.system, externalId: it.provenance.external_id },
          "v6 외부 미러 적재 실패(무시) — 다음 싱크가 수렴");
      }
      n++;
    }
  } finally {
    client.release();
  }
  return n;
}

// v6 컷오버: 구 resolveParents(parent_external_id→별도 패스) 제거 — parent_name 자기참조를 connector-mirror 가 적재 시점에 즉시 채운다.


// ════════════════════════════════════════════════════════════════════
// ── canonical UI 읽기 fn — capability 계층(src/capabilities/*)을 통해
// 웹 REST 와 MCP 가 동일 페이로드를 공유한다(Stage①). 전부 read-only +
// 파라미터라이즈드 쿼리, limit/offset 은 클램프 후 숫자 보간(기존 컨벤션).
// rejected 행은 기본 제외(읽기 의미론) — includeRejected 옵션으로만 노출.
// ════════════════════════════════════════════════════════════════════

export interface UiCoverageRow {
  repo: string;
  domainItems: number; domainProposed: number; domainConfirmed: number;
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

// 개요 히어로/커버리지 카드용 통계 집계 — v6 knowledge(provenance='observed' 외부미러) 기준. coverage 는 category=repo-free 라 빈 배열.
//  total/bySystem/byType/daily 는 observed 수집물(provenance='observed')만(저작물 R/K/H 제외 — 활동 통계 의미 보존).
//  type 은 fields._item_type(원 item.type 무손실 보존). threadReplies 는 parent_name 보유 수. coverage 는 v6에서 항상 빈 배열.
export async function uiStats(): Promise<UiStats> {
  // v6 컷오버(2026-06-24): observed 외부미러 통계 소스를 knowledge_unit → knowledge(provenance='observed')로 리포인트.
  const OBS = `provenance='observed'`;
  //  repo별 도메인 매핑 coverage 는 knowledge_unit_domain 폐기로 사라짐(category=repo-free) → 빈 coverage 유지.
  const [head, bySystem, byType, daily] = await Promise.all([
    itemsPool.query(`SELECT count(*)::int AS total, max(occurred_at) AS last,
                            count(*) FILTER (WHERE parent_name IS NOT NULL)::int AS replies
                     FROM knowledge WHERE ${OBS}`),
    itemsPool.query(`SELECT external_system AS system, count(*)::int AS count FROM knowledge WHERE ${OBS} GROUP BY 1 ORDER BY 2 DESC`),
    itemsPool.query(`SELECT fields->>'_item_type' AS type, count(*)::int AS count FROM knowledge WHERE ${OBS} GROUP BY 1 ORDER BY 2 DESC`),
    // 일자 키는 Asia/Seoul 고정 — 클라이언트(app.js 스파크라인)도 같은 TZ 로 키를 만들므로 서버 TZ 에 흔들리지 않음.
    itemsPool.query(`SELECT (occurred_at AT TIME ZONE 'Asia/Seoul')::date::text AS day, count(*)::int AS count
                     FROM knowledge WHERE ${OBS} AND occurred_at >= now() - interval '14 days' GROUP BY 1 ORDER BY 1`),
  ]);
  const h = head.rows[0] as { total: number; last: Date | null; replies: number };
  return {
    total: h.total,
    lastOccurredAt: h.last ? new Date(h.last).toISOString() : null,
    threadReplies: h.replies,
    bySystem: bySystem.rows,
    byType: byType.rows,
    recentDaily: daily.rows,
    coverage: [], // v6: category=repo-free → per-repo coverage 개념 없음(빈 배열)
  };
}

// v6 컷오버: 구 listMappingRepos(knowledge_unit_domain 기준 repo 목록) 제거 — category 는 repo-free라 개념 소멸. repo 목록은 listReposV6 단일 소스.


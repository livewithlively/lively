// v6 스키마 조각 — knowledge: 지식 본체와 그 정션. knowledge(구 knowledge_unit 대체)·knowledge_revision(#783
//  수정 검토 큐)·#335 항상-주입 섹션 시드·knowledge_category(단일-home 정션)·knowledge_publication(#976 발행
//  표식)·feed_target+category_feed(#976 아웃바운드 라우팅).
// #1313 R19c: 구 단일 initV6Schema(v6/schema.ts, ~1,270줄)에서 **verbatim 이동**한 조각 — DDL·시드 SQL 무변경.
//  실행(await) 순서는 v6/schema.ts 오케스트레이터가 소유한다(분할 전 시퀀스 그대로 — SCHEMA_SQL_LOG
//  스냅샷 diff 0 이 계약, scripts/schema-init.itest.mjs 헤더 참조). 블록을 옮기려면 그 증명을 다시 떠라.
import type { Pool } from "pg";
import { ensureCheck, redefineCheck } from "../../org/schema/ddl-util.js";

export async function initV6Knowledge(pool: Pool): Promise<void> {
  // ── 3) knowledge — 구 knowledge_unit 대체. kind(R/K/H/W) **폐기**(직교축으로 분리). ──
  //  injection=always(구 kind=R 규칙·페르소나 — 항상 주입, materialize 의 급소) | recalled(검색 소환).
  //  provenance=authored(저작) | observed(외부 미러 — 구 confidence='observed'). confidence 는 저작신뢰로 유지.
  //  외부좌표/스레드/원본보존 컬럼은 구 knowledge_unit 동형(커넥터 미러 흡수) — 구 테이블은 v6 드랍됨.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge(
      name TEXT PRIMARY KEY,
      title TEXT,
      body_md TEXT NOT NULL DEFAULT '',
      injection TEXT NOT NULL DEFAULT 'recalled',
      provenance TEXT NOT NULL DEFAULT 'authored',
      lifecycle TEXT NOT NULL DEFAULT 'active',
      supersedes TEXT,
      confidence TEXT NOT NULL DEFAULT 'human',
      source TEXT NOT NULL DEFAULT 'authored',
      external_system TEXT, external_instance TEXT, external_id TEXT, external_url TEXT,
      sync_state JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at TIMESTAMPTZ, last_synced_at TIMESTAMPTZ, as_of TIMESTAMPTZ,
      parent_external_id TEXT, parent_name TEXT,
      fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      raw JSONB,
      summary TEXT,
      author TEXT, source_ref TEXT,
      sort INT NOT NULL DEFAULT 0, version INT NOT NULL DEFAULT 1,
      is_wiki BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT);
    ${ensureCheck("knowledge", {
      knowledge_injection_chk: "injection IN ('always','recalled')",
      knowledge_provenance_chk: "provenance IN ('authored','observed')",
      knowledge_confidence_chk: "confidence IN ('ai','rule','human','observed')",
    })}
    -- lifecycle 단순화(2026-06-23): rejected 폐기 — 제거는 삭제(휴지통, 복원가능)로 통일. 가역 숨김(반려) 개념 삭제.
    --  기존 rejected 행은 active 복귀(비파괴). 제약은 redefine 이라 DROP+ADD(멱등). superseded 는 버전 교체 축이라 유지.
    -- archived 추가(2026-07-04 #551): 외부 미러의 원본 아카이브/휴지통/삭제 전파 자리 — 하드삭제 대신 보존(기본 목록에선 lifecycle='active' 필터로 숨음).
    -- pending 추가(2026-07-07 #638): 자동 인입(distill/mirror)이 인입정책상 human-confirm 대상일 때의 '검토 대기' 격리 상태.
    --  목록·검색·grep·벡터·similar·recall·always주입이 이미 lifecycle='active' 필터라 pending 은 자동 격리(라이브 노출 0). 승인=set_lifecycle(active).
    --  rejected(가역 숨김, 2026-06-23 폐기)와 성격 다름 — 그건 '판정 후 숨김', pending 은 '판정 전 대기'.
    UPDATE knowledge SET lifecycle='active' WHERE lifecycle='rejected';
    ${redefineCheck("knowledge", "knowledge_lifecycle_chk", "lifecycle IN ('active','pending','superseded','archived')")}
    -- WIKI 핀(2026-06-23): is_wiki=true 인 지식의 제목+메타만 가이드 위키섹션으로 항상-주입(본문 제외, 인덱스).
    --  injection(always/recalled)과 직교 — recalled 지식이되 인덱스엔 핀. 멱등 ADD COLUMN(기존 테이블 보강).
    ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS is_wiki BOOLEAN NOT NULL DEFAULT false;
    -- type(2026-06-30 #290): page-type facet — 엔터프라이즈 표준 합성(DITA Concept/Reference + Diátaxis How-to/Explanation + ADR Decision + LLM위키 Entity).
    --  6종: decision|concept|how-to|reference|research|entity. NULL 허용(미분류). 옛 kind(R/K/H/W)는 폐기 — 무관. 비파괴 ADD COLUMN.
    ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS type TEXT;
    ${ensureCheck("knowledge", { knowledge_type_chk: "type IS NULL OR type IN ('decision','concept','how-to','reference','research','entity')" })}
    CREATE INDEX IF NOT EXISTS knowledge_type_idx ON knowledge(type) WHERE type IS NOT NULL;
    -- created_at(2026-06-30 #290): 최초 작성 시점. 비파괴 ADD COLUMN(NULL) → 기존 행은 updated_at 으로 1회 백필(WHERE NULL, 멱등) → 이후 DEFAULT now().
    --  주의: 백필값은 '마지막 갱신' 기준 근사(편집된 지식은 실제 생성보다 늦을 수 있음 — 더 정확한 출처가 없음). 신규 INSERT 는 DEFAULT now(), ON CONFLICT 갱신은 created_at 미변경(보존).
    ALTER TABLE knowledge ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
    UPDATE knowledge SET created_at = updated_at WHERE created_at IS NULL;
    ALTER TABLE knowledge ALTER COLUMN created_at SET DEFAULT now();
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_external_uidx ON knowledge(external_system, external_instance, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS knowledge_injection_idx ON knowledge(injection);
    CREATE INDEX IF NOT EXISTS knowledge_wiki_idx ON knowledge(is_wiki) WHERE is_wiki;
    CREATE INDEX IF NOT EXISTS knowledge_provenance_idx ON knowledge(provenance);
    CREATE INDEX IF NOT EXISTS knowledge_lifecycle_idx ON knowledge(lifecycle);
    CREATE INDEX IF NOT EXISTS knowledge_parent_idx ON knowledge(parent_name);
  `);

  // ── knowledge_revision — 지식 '수정' 검토 큐(#783). 신규 지식은 lifecycle='pending' 으로 격리되지만, ──
  //  기존 active 지식의 수정은 그렇게 못 한다(pending 으로 내리면 이미 승인된 라이브 지식이 검색·주입에서 사라진다).
  //  그래서 수정은 본문과 분리된 이 테이블로 검토한다 — 인입정책 action_update(org_ingest_policy)가 mode 를 정한다:
  //   · mode='staged'  (action_update=stage)  = 본문 **미반영**. 승인해야 knowledge.body_md 에 적용(라이브는 옛 승인본 유지).
  //   · mode='applied' (action_update=review) = 본문 **이미 반영**(라이브 유지). 사람은 사후에 diff 를 보고 확인(ack) 또는 되돌리기(revert).
  //  base_* = 수정 전 스냅샷(diff 기준 + applied 되돌리기 원본), new_* = 에이전트가 제안/적용한 내용.
  //  coalesce: (name) 당 pending 1행 — 에이전트가 같은 지식을 5번 저장해도 큐는 1건(base 는 최초 것 보존, new 는 최신 갱신)
  //   → 큐 홍수 방지. 승인/반려로 pending 이 비워지면 다음 수정이 새 행을 연다.
  //  FK 없음(지식이 삭제돼도 검토 이력 보존 — org_content_audit 와 같은 원칙).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_revision(
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      base_version INT,
      base_title TEXT,
      base_body_md TEXT,
      base_confidence TEXT,
      new_title TEXT,
      new_body_md TEXT NOT NULL,
      new_summary TEXT,
      new_type TEXT,
      proposed_by TEXT,
      actor_kind TEXT,
      agent TEXT,
      rule_id BIGINT,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      edits INT NOT NULL DEFAULT 1);
    ${ensureCheck("knowledge_revision", {
      knowledge_revision_mode_chk: "mode IN ('staged','applied')",
      knowledge_revision_status_chk: "status IN ('pending','approved','rejected')",
    })}
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_revision_pending_uq ON knowledge_revision(name) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS knowledge_revision_status_idx ON knowledge_revision(status, updated_at DESC);
  `);

  // (#335) 항상-주입 섹션 N개화 — 정렬 시드 + 팀블록 위치 보존. 1회성: 두 기본 섹션이 모두 pristine(sort=0)일 때만 실행
  //  → 한 번 정렬(0,1)되면 조건 거짓이라 재실행 안 됨(관리자 재정렬·${team} 제거를 덮어쓰지 않음).
  await pool.query(`
    DO $$
    BEGIN
      IF (SELECT COUNT(*) FROM knowledge
            WHERE injection='always' AND lifecycle='active'
              AND name IN ('org-defaults','context-ontology-guide') AND sort=0) = 2 THEN
        UPDATE knowledge SET sort=0 WHERE name='org-defaults' AND injection='always';
        UPDATE knowledge SET sort=1 WHERE name='context-ontology-guide' AND injection='always';
        -- 팀블록 위치 보존 — 이전 조립은 org-defaults 직후 team 블록. org-defaults 말미에 \${team} 플레이스홀더로 시드(1회).
        UPDATE knowledge SET body_md = body_md || E'\n\n\${team}'
          WHERE name='org-defaults' AND injection='always' AND lifecycle='active' AND body_md NOT LIKE '%\${team}%';
      END IF;
    END $$;
  `);

  // ── 4) knowledge_category — 지식↔카테고리 정션(구 knowledge_unit_domain). #290 knowledge_category_single_uq 로 지식당 단일-home(0/1). 진짜 FK(같은 DB). ──
  //  빈 정션 = '카테고리 없음(general)' 허용(센티넬 행 회피). state/mapped_by enum 은 구 조인과 동일.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_category(
      name TEXT NOT NULL REFERENCES knowledge(name) ON DELETE CASCADE,
      category_id INT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
      mapped_by TEXT NOT NULL DEFAULT 'rule',
      confidence REAL,
      state TEXT NOT NULL DEFAULT 'proposed',
      evidence TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY(name, category_id));
    ${ensureCheck("knowledge_category", {
      knowledge_category_state_chk: "state IN ('proposed','confirmed','rejected')",
      knowledge_category_mappedby_chk: "mapped_by IN ('rule','llm','manual','declared')",
    })}
    CREATE INDEX IF NOT EXISTS knowledge_category_cat_idx ON knowledge_category(category_id);
    CREATE INDEX IF NOT EXISTS knowledge_category_state_idx ON knowledge_category(state);
  `);

  // ── 4b) knowledge_publication — 지식→외부 피드 발행표식(#976/#984). authored 지식을 외부 피드(노션 등)에 투영한 좌표. ──
  //  ⚠ external_*(인바운드 미러 좌표)와 **직교** — 여기 좌표는 '우리가 낸 사본의 위치(발행)'지 '출처'가 아니다.
  //   그래서 provenance 는 authored 로 유지되고(#984 결정), connector-mirror 의 observed 강제 경로에 애초에 안 걸린다
  //   (발행 대상 피드 DB 는 exclude_pages 로 인바운드 스코프에서 제외 → 재수집 자체가 없음). 미러 좌표 재사용 금지.
  //  멱등 좌표 = (name, system, target_id): 지식당·대상피드(DB)당 1행. content_hash 로 무변경 재푸시 skip.
  //  page_id = 발행된 노션 페이지 id(최초 create 성공 후 채움 — 이후 update). 지식 삭제 시 CASCADE(외부 삭제는 아웃박스 스냅샷으로, #976 후속).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_publication(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL REFERENCES knowledge(name) ON DELETE CASCADE,
      system TEXT NOT NULL,
      instance TEXT,
      target_id TEXT NOT NULL,
      page_id TEXT,
      url TEXT,
      content_hash TEXT,
      state TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      published_at TIMESTAMPTZ,
      published_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    ${ensureCheck("knowledge_publication", { knowledge_publication_state_chk: "state IN ('pending','published','failed')" })}
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_publication_uq ON knowledge_publication(name, system, target_id);
    CREATE INDEX IF NOT EXISTS knowledge_publication_name_idx ON knowledge_publication(name);
    CREATE INDEX IF NOT EXISTS knowledge_publication_page_idx ON knowledge_publication(system, page_id) WHERE page_id IS NOT NULL;
  `);

  // ── 4c) feed_target + category_feed — 위키 아웃바운드 라우팅(#976). 피드 목적지 레지스트리 + 카테고리↔피드 N:M. ──
  //  feed_target = 등록된 피드 목적지(노션 DB 1개 = target_id). data_source_id 는 2025-09-03 페이지 부모(해소 캐시).
  //   exclude_registered = 이 DB 를 exclude_pages 에 넣었는지(#984 — 안 넣으면 우리 발행물이 재수집돼 observed 로 뒤집힘).
  //  category_feed = 카테고리 N:M feed_target — 한 도메인이 여러 피드로, 한 피드가 여러 도메인을 받는다(발행 게이트 = 옵트인 매핑).
  //   drain 은 feed_target 별로 매핑된 카테고리의 active 정본 지식을 그 타깃에 발행(knowledge_publication 이 타깃별 1행으로 멱등).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feed_target(
      id SERIAL PRIMARY KEY,
      system TEXT NOT NULL,
      instance TEXT,
      target_id TEXT NOT NULL,
      data_source_id TEXT,
      parent_page_id TEXT,
      title TEXT,
      exclude_registered BOOLEAN NOT NULL DEFAULT false,
      all_categories BOOLEAN NOT NULL DEFAULT false,
      state TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    -- all_categories = 매핑 무시하고 모든 authored 정본 지식을 이 피드로(새 카테고리 자동 포함). 기존 테이블 비파괴 추가.
    ALTER TABLE feed_target ADD COLUMN IF NOT EXISTS all_categories BOOLEAN NOT NULL DEFAULT false;
    ${ensureCheck("feed_target", { feed_target_state_chk: "state IN ('active','paused')" })}
    -- (system, target_id) 유니크 — target_id(노션 DB id)는 전역 유니크라 instance 불요. instance 를 넣으면 NULL-distinct 로
    --  instance=NULL 일 때 유니크가 안 걸려 ON CONFLICT 가 안 터지고 upsert 가 항상 insert 가 된다(중복 등록).
    CREATE UNIQUE INDEX IF NOT EXISTS feed_target_uq ON feed_target(system, target_id);

    CREATE TABLE IF NOT EXISTS category_feed(
      category_id INT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
      feed_target_id INT NOT NULL REFERENCES feed_target(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(category_id, feed_target_id));
    CREATE INDEX IF NOT EXISTS category_feed_target_idx ON category_feed(feed_target_id);
  `);
}

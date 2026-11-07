// v6 스키마 조각 — graph-source(#290 분류·링크·자료 재설계): 카테고리 단일-home 유니크(⑭-a 소프트 보류)·
//  knowledge_link(지식 그래프 ⑭-b)·project_edge(⑭-b2)·source(자료층 ⑭-c)·knowledge_source(인용 ⑭-d).
//  모든 base 테이블 뒤(knowledge/project/*_category FK 의존) — 오케스트레이터 순서가 그 규약을 소유한다.
// #1313 R19c: 구 단일 initV6Schema(v6/schema.ts, ~1,270줄)에서 **verbatim 이동**한 조각 — DDL·시드 SQL 무변경.
//  실행(await) 순서는 v6/schema.ts 오케스트레이터가 소유한다(분할 전 시퀀스 그대로 — SCHEMA_SQL_LOG
//  스냅샷 diff 0 이 계약, scripts/schema-init.itest.mjs 헤더 참조). 블록을 옮기려면 그 증명을 다시 떠라.
import type { Pool } from "pg";
import { ensureCheck, softUniqueIndex } from "../../org/schema/ddl-util.js";

export async function initV6GraphSource(pool: Pool): Promise<void> {
  // ════════ #290(2026-06-30) 분류·링크·자료 재설계 — 모든 base 테이블 뒤(knowledge/project/*_category 의존). ════════

  // ── ⑭-a) knowledge_category·project_category 단일화 — 카테고리는 엔티티당 1개(또는 0=general). ──
  //  근거(#290): 단일=디시전 포싱 + 깨끗한 사이드바 트리(복수면 DAG) + 도메인 should/is 귀속 명확. 교차연결은 knowledge_link 가 흡수.
  //  전체 UNIQUE(name|project_id) — 0/1 만 허용. ⚠ 기존 복수매핑 잔존 시 생성 실패 → org_member_email idiom 처럼 **비치명적 보류**
  //  (scripts/290-single-and-source 가 단일화한 뒤 확정 생성, 이후 부팅은 IF NOT EXISTS no-op). 앱 쓰기경로도 single-mode(replace)로 강제.
  await softUniqueIndex(pool,
    `CREATE UNIQUE INDEX IF NOT EXISTS knowledge_category_single_uq ON knowledge_category(name)`,
    "[v6 schema] knowledge_category 단일 유니크 보류(기존 복수매핑 정리 후 적용)");
  await softUniqueIndex(pool,
    `CREATE UNIQUE INDEX IF NOT EXISTS project_category_single_uq ON project_category(project_id)`,
    "[v6 schema] project_category 단일 유니크 보류(기존 복수매핑 정리 후 적용)");

  // ── ⑭-b) knowledge_link — 지식↔지식 그래프(빠진 1급 프리미티브). category_edge idiom. ──
  //  relation=related(대칭)|refines|contradicts|depends_on(통제 어휘). 정션이 그래프뷰·백링크·recall 그래프의 쿼리 SoT
  //  (MediaWiki pagelinks·Notion relation 패턴). 지식 PK 가 name TEXT 라 from/to TEXT FK(CASCADE). no-self + (from,to,relation) 유니크.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_link(
      id SERIAL PRIMARY KEY,
      from_name TEXT NOT NULL REFERENCES knowledge(name) ON DELETE CASCADE,
      to_name TEXT NOT NULL REFERENCES knowledge(name) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'related',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now());
    ${ensureCheck("knowledge_link", {
      knowledge_link_relation_chk: "relation IN ('related','refines','contradicts','depends_on')",
      knowledge_link_noself_chk: "from_name <> to_name",
    })}
    CREATE UNIQUE INDEX IF NOT EXISTS knowledge_link_uq ON knowledge_link(from_name, to_name, relation);
    CREATE INDEX IF NOT EXISTS knowledge_link_from_idx ON knowledge_link(from_name);
    CREATE INDEX IF NOT EXISTS knowledge_link_to_idx ON knowledge_link(to_name);
    -- origin(2026-07-04 #551): 링크 생성 주체 — 'user'(사람/MCP) | 'connector:<system>'(커넥터가 노션 멘션/링크를 자동 물질화).
    --  커넥터는 자기 origin 링크만 삭제·재작성한다(사람이 만든 링크 불가침). 비파괴 ADD COLUMN(기존 행=user).
    ALTER TABLE knowledge_link ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'user';
    CREATE INDEX IF NOT EXISTS knowledge_link_origin_idx ON knowledge_link(origin) WHERE origin <> 'user';
  `);

  // ── ⑭-b2) project_edge — 프로젝트↔프로젝트 그래프(후속 관계 등, knowledge_link idiom). ──
  //  relation=follow_up(from 이 to 의 후속 = from 은 후속, to 는 선행)|supersedes|depends_on|related. 1차 UI 노출=follow_up.
  //  project PK 가 INT id 라 from/to INT FK(CASCADE). no-self + (from,to,relation) 유니크. parent_id(=task 위계)와 직교.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_edge(
      id SERIAL PRIMARY KEY,
      from_project_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      to_project_id INT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'follow_up',
      created_at TIMESTAMPTZ DEFAULT now(),
      created_by TEXT);
    ${ensureCheck("project_edge", {
      project_edge_relation_chk: "relation IN ('follow_up','supersedes','depends_on','related')",
      project_edge_noself_chk: "from_project_id <> to_project_id",
    })}
    CREATE UNIQUE INDEX IF NOT EXISTS project_edge_uq ON project_edge(from_project_id, to_project_id, relation);
    CREATE INDEX IF NOT EXISTS project_edge_from_idx ON project_edge(from_project_id);
    CREATE INDEX IF NOT EXISTS project_edge_to_idx ON project_edge(to_project_id);
  `);

  // ── ⑭-c) source — 자료층. raw 입력(이메일·슬랙·회의 전사록/minutes·외부 미러). knowledge 와 별도 테이블. ──
  //  ★별도 테이블 = recall(knowledge_search)이 자료를 **자동 미포함**(읽기경로 무수정). knowledge 의 미러/raw 컬럼이 귀속될 자리.
  //  kind=transcript|minutes|email|slack|notion_doc|clickup_doc|other. provenance=authored(우리 캡처)|observed(외부 미러).
  //  증류물(지식)은 knowledge_source 로 인용(카파시 source→wiki citation). name=선택적 슬러그(전사록 등 안정 키).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS source(
      id SERIAL PRIMARY KEY,
      name TEXT,
      kind TEXT NOT NULL DEFAULT 'other',
      title TEXT,
      body_md TEXT NOT NULL DEFAULT '',
      raw JSONB,
      fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      provenance TEXT NOT NULL DEFAULT 'observed',
      external_system TEXT, external_instance TEXT, external_id TEXT, external_url TEXT,
      parent_external_id TEXT,
      sync_state JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at TIMESTAMPTZ, last_synced_at TIMESTAMPTZ,
      author TEXT,
      lifecycle TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT);
    ${ensureCheck("source", {
      source_provenance_chk: "provenance IN ('authored','observed')",
      source_lifecycle_chk: "lifecycle IN ('active','superseded')",
    })}
    -- #735: 커넥터 구조화 메타(채널명·작성자·스레드 등) 보존용. 기존 배포 대상 ALTER(멱등).
    ALTER TABLE source ADD COLUMN IF NOT EXISTS fields JSONB NOT NULL DEFAULT '{}'::jsonb;
    -- #735 후속: 스레드/계층 링크(자료 간 관계) — 답글→스레드루트·자식페이지→부모. 전 커넥터가 RawItem.parent_external_id 로 방출.
    --  external 좌표(system,instance)+parent_external_id 로 조인해 "스레드 답글들"·"페이지 자식들"을 결정적 탐색(resolution 타이밍 무관).
    ALTER TABLE source ADD COLUMN IF NOT EXISTS parent_external_id TEXT;
    CREATE INDEX IF NOT EXISTS source_parent_idx ON source(external_system, external_instance, parent_external_id) WHERE parent_external_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS source_name_uq ON source(name) WHERE name IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS source_external_uidx ON source(external_system, external_instance, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS source_kind_idx ON source(kind);
    CREATE INDEX IF NOT EXISTS source_occurred_idx ON source(occurred_at DESC NULLS LAST);
    -- #1289 증류기 스코프 — 채널(container_name)·작성자(author_name)로 미증류 인박스를 가른다. 커넥터가 채운
    --  구조화 메타(#735 source.fields)가 그대로 필터 축이라 표현식 인덱스로 받는다(자료가 만 단위로 쌓이는 축).
    CREATE INDEX IF NOT EXISTS source_channel_idx ON source((fields->>'container_name'));
    CREATE INDEX IF NOT EXISTS source_author_idx  ON source((fields->>'author_name'));
  `);

  // ── ⑭-d) knowledge_source — 지식→자료 인용. relation=derived_from(증류)|cites(참조). recall 그래프가 tier 가로지르는 다리. ──
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_source(
      name TEXT NOT NULL REFERENCES knowledge(name) ON DELETE CASCADE,
      source_id INT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'derived_from',
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY(name, source_id, relation));
    ${ensureCheck("knowledge_source", { knowledge_source_relation_chk: "relation IN ('derived_from','cites')" })}
    CREATE INDEX IF NOT EXISTS knowledge_source_source_idx ON knowledge_source(source_id);
  `);
}

// org 스키마 조각 — registry: 지식유형/수집 ground-truth 데이터층. kind_registry(지식 종류 정의+시드)·
//  data_source(소스별 수집방식+시드) + 레거시 폐기 DROP(knowledge_unit·org_content·org_memory·org_project).
// #1313 R19b: 구 단일 initOrgSchema(org/schema.ts, ~1,500줄)에서 **verbatim 이동**한 조각 — DDL·시드 SQL 무변경.
//  실행(await) 순서는 org/schema.ts 오케스트레이터가 소유한다(분할 전 시퀀스 그대로 — SCHEMA_SQL_LOG
//  스냅샷 diff 0 이 계약, scripts/schema-init.itest.mjs 헤더 참조). 블록을 옮기려면 그 증명을 다시 떠라.
import type { Pool } from "pg";
import { ensureCheck } from "./ddl-util.js";

export async function initGroundTruthRegistries(pool: Pool): Promise<void> {
  // ════════ 지식유형/수집 ground-truth(데이터층) — kind_registry + data_source ════════
  // v6 컷오버(2026-06-24): 지식 본체는 v6 knowledge 테이블(src/v6/schema.ts)이 캐노니컬 — 구 knowledge_unit 통합스토어는 드랍됨.
  //  이 섹션은 #/learn ground-truth 용 별도 메타 테이블 2종(kind_registry=지식종류 정의, data_source=소스별 수집방식)만 시드한다.

  // ── kind_registry — 지식 종류 분류 + 주입 정책 메타. 12 kind 시드(아래). ──
  // injection_mode = 멤버 컨텍스트에 어떻게 노출되는가(enforced/always/recalled/manual/query/digest).
  //  domain_scoped = domainmap 도메인 귀속을 갖는 종류인지. cardinality = 한 종류당 한 단위(one)인지 다수(many)인지.
  // P-V3-2(D-GT): description 외에 **분류기준(criteria)·저장방식(storage)·전달방식(delivery)** 을 ground-truth 로
  //  채운다(비파괴 ADD COLUMN, 멱등). 런북(LLM)·웹(#/learn, 비개발자)이 여기서 렌더 → non-stale 단일 출처.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kind_registry(
      kind TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      injection_mode TEXT NOT NULL DEFAULT 'manual',
      audience TEXT,
      cardinality TEXT NOT NULL DEFAULT 'many',
      domain_scoped BOOLEAN NOT NULL DEFAULT false,
      description TEXT NOT NULL DEFAULT '',
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    -- P-V3-2: 분류기준/저장방식/전달방식(ground-truth 확장, 비파괴·멱등). description 과 함께 런북·웹이 렌더.
    ALTER TABLE kind_registry ADD COLUMN IF NOT EXISTS criteria TEXT NOT NULL DEFAULT '';
    ALTER TABLE kind_registry ADD COLUMN IF NOT EXISTS storage TEXT NOT NULL DEFAULT '';
    ALTER TABLE kind_registry ADD COLUMN IF NOT EXISTS delivery TEXT NOT NULL DEFAULT '';
    ${ensureCheck("kind_registry", {
      kind_registry_mode_chk: "injection_mode IN ('enforced','always','recalled','manual','query','digest')",
      kind_registry_card_chk: "cardinality IN ('one','many')",
    })}
  `);

  // ── data_source — 소스별 수집방식 레지스트리(ground-truth). 어떤 외부 시스템에서 무엇이 어떻게 수집되어 ──
  //  v6 knowledge 의 어느 kind 로 적재되는지를 비개발자도 읽도록 명문화. status=active(수집중) | dropped
  //  (수집중단, 커넥터 코드는 유지). collection_method = 수집 방식 설명(자유텍스트). into_kinds = 적재 kind 목록.
  //  시크릿 금지(토큰/URL 없음 — 시스템명·라벨·설명만). 시드는 아래(discord=dropped, notion/clickup/slack=active).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS data_source(
      system TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      collection_method TEXT NOT NULL DEFAULT '',
      cadence TEXT,
      into_kinds JSONB NOT NULL DEFAULT '[]'::jsonb,
      note TEXT,
      sort INT NOT NULL DEFAULT 0,
      version INT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT);
    ${ensureCheck("data_source", { data_source_status_chk: "status IN ('active','dropped')" })}
  `);

  // ── knowledge_unit 폐기(2026-06-24): v6 knowledge 컷오버 완료 — DROP. ──
  //  지식(기록)=knowledge, 섹션(규칙·페르소나)=knowledge injection='always', observed 통계=knowledge provenance='observed',
  //  도메인 active 카운트=knowledge_category 기준 집계. 임베딩(pgvector)·구 미러는 폐기.
  //  knowledge_unit_revision(뷰)·knowledge_unit_mapping_audit(구 item→domain 매핑 감사)·knowledge_unit_domain 동반 드랍.
  //  org_content_audit 의 entity='knowledge_unit' 이력행은 비파괴 보존(투영 뷰만 제거). kind_registry/data_source(별도 테이블)는 유지.
  await pool.query(`DROP VIEW IF EXISTS knowledge_unit_revision`);
  await pool.query(`DROP TABLE IF EXISTS knowledge_unit_mapping_audit`);
  await pool.query(`DROP TABLE IF EXISTS knowledge_unit_domain`);
  await pool.query(`DROP TABLE IF EXISTS knowledge_unit CASCADE`);

  // ── 고아 레거시 테이블 폐기(2026-06-24): org_content/org_memory→v6 knowledge 컷오버 완료, org_project→v6 project 대체. ──
  //  위(:25) 주석이 "폐기"라 선언했으나 실제 DROP문이 없어 DB에 잔존했다(라이브 read 0 — v6-migrate 스크립트만 참조).
  //  멱등 DROP 으로 스키마 자기정합·재빌드 안전성 확보. org_content_audit(감사 로그)는 별개라 유지.
  await pool.query(`DROP TABLE IF EXISTS org_content CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS org_memory CASCADE`);
  await pool.query(`DROP TABLE IF EXISTS org_project CASCADE`);

  // ── kind 캐노니컬 정의 시드(ground-truth) — label/injection_mode/domain_scoped/audience/sort 골격 + ──
  //  description(정의)·criteria(분류기준: 언제 이 kind 인가 + 인접 kind 구분)·storage(저장방식)·
  //  delivery(전달방식 = injection_mode 의 의미). 비개발자도 이해할 쉬운 한국어.
  //  멱등 정책: ON CONFLICT(kind) DO UPDATE — **정의 4필드(description/criteria/storage/delivery)는 코드가
  //  캐노니컬**이라 부팅 시마다 시드값으로 정렬한다. 웹 #/learn 은 읽기전용 렌더라 사용자가 정의를 편집하지
  //  않는다 → DO UPDATE 가 사람 편집을 덮을 위험 없음.
  //
  //  ⚠ V4-P2a(분류 재설계, 2026-06-18 v4 plan §1.A): 본질 kind = **R·K·H·W 4종만 시드**.
  //   - R(규칙/정책/페르소나)=강제, K(지식노트, A/D/F/M/L/Z 흡수)=회상, H(런북/절차)=회상, W(과업)=질의.
  //   - **A/D/F/G/S/M/L/Z 행은 P2a 에서 시드 제거 + 부팅 DELETE 로 정리**(데이터 흡수 *후*). 데이터 마이그
  //     (A/D/F/M/L/Z→K, S/G=domainmap federate 0행)는 scripts/v4-absorb-kinds.mjs 가 1회 수행. 이 시드+DELETE 가
  //     소스 캐노니컬이라 부팅마다 4kind 로 정렬·정리(스크립트 미실행 DB 도 시드는 4행, 데이터 흡수만 스크립트 의존).
  //   - injection_mode: R=enforced / K·H=recalled / W=query. materialize FALLBACK·web #/learn 은 라이브 registry 읽음.
  await pool.query(`
    INSERT INTO kind_registry(kind, label, injection_mode, domain_scoped, audience, cardinality, sort, description, criteria, storage, delivery) VALUES
      ('R','Rule/Policy/Persona','enforced',false,'context','many',10,
        '조직이 모든 AI 세션에 강제하는 규칙·정책·페르소나. "반드시/금지" 같은 행동 규범과 AI 의 말투·역할. 4 본질 종류 중 하나(R·K·H·W).',
        '"항상/반드시/절대" 지켜야 하는 강제 규범이면 R. 한 번 일어난 사실·방법 절차(H)·배경 지식(K)과 구분: R 은 위반하면 안 되는 명령형이다. 페르소나(AI 역할·말투)도 R.',
        '항상-주입 섹션 문서(injection=always)로 저장. 본문 전체가 보존된다.',
        '강제 주입(enforced): 맥락과 무관하게 모든 세션 컨텍스트 최상단에 전문이 그대로 들어간다(R 만 항상 주입).'),
      ('K','Knowledge note','recalled',false,'memory','many',20,
        '지식 노트 — 결정의 배경, 알게 된 것, 정리한 생각, 사실, 도메인 지식, 메모·링크까지 아우르는 일반 지식. 4 본질 종류 중 가장 큰 기본값(R·K·H·W). (구 A/D/F/M/L/Z 흡수.)',
        '강제 규범(R)·절차(H)·과업(W)이 아닌 거의 모든 저작 지식은 K. 배경·맥락·사실·도메인 지식·메모·외부 링크·산출물이 다 K 로 모인다(주제는 종류가 아니라 area=domain 으로 구분, 출처는 provenance 로 구분). 애매하면 K.',
        '지식 단위로 저장(제목+본문). 본문은 전문 보존, 검색 대상. 주제 귀속은 area(domain_key, product/business)로 단다.',
        '검색 회상(recalled): 인덱스(제목·요약)에 노출, 전문은 일에 맞춰 area+검색으로 그때 소환(on-demand).'),
      ('H','How-to/Runbook','recalled',true,'memory','many',50,
        '하우투·런북 — 무엇을 어떤 순서로 하는지의 재현 가능한 절차(예: 배포 방법, 동기화 실행법). AI 워크플로 표준화의 핵심 산물. 4 본질 종류 중 하나(R·K·H·W).',
        '"이렇게 한다"는 단계별 절차면 H. 배경 지식(K)과 구분: H 는 따라 하면 결과가 재현된다. 도메인 절차여도 H(area=domain 부여 가능).',
        '지식 단위로 저장(단계 목록 본문). 주제 귀속은 area(domain_key) 부여 가능.',
        '검색 회상(recalled): 인덱스에 노출, 필요할 때 area+검색으로 전문 소환(on-demand).'),
      ('W','과업(Task)','query',false,'memory','many',90,
        '과업·태스크 — PM 도구(ClickUp 등)의 태스크/이슈. 진행 상태·담당을 가진 일. 4 본질 종류 중 하나(R·K·H·W). (과업을 향한 개별 행위·진척은 별 엔티티 작업=activity.)',
        '진행 상태(미정/진행/완료)·담당을 가진 **과업/태스크**면 W. 절차 설명은 H, 정리된 지식은 K. 수집된 외부 활동/문서는 출처(provenance=observed)로 들어온 W/K 미러다.',
        '커넥터/pm_* 가 적재(external_id·상태). 과업 단위. 과업을 향한 개별 작업(activity)은 activity_* 가 별도 기록.',
        '질의 시(query): 필요할 때 조회(과업 현황 검색).')
    -- ⚠ 중재자를 **제약 이름**으로 적는다. 컬럼으로 적으면 배포 모드마다 달라진다:
    --  신규 설치에서는 이 문장이 tenant_id 컬럼이 생기기 **전에** 돌고(42703), 이미 테넌트화된
    --  DB 에서는 (kind) 가 인덱스와 안 맞는다(42P10). 제약 **이름**은 재작성해도 보존되므로
    --  (db/tenant-column.ts 가 이름을 유지한다) 두 모양 모두에 맞는 유일한 표기다.
    ON CONFLICT ON CONSTRAINT kind_registry_pkey DO UPDATE SET
      label=EXCLUDED.label, injection_mode=EXCLUDED.injection_mode, domain_scoped=EXCLUDED.domain_scoped,
      audience=EXCLUDED.audience, cardinality=EXCLUDED.cardinality, sort=EXCLUDED.sort,
      description=EXCLUDED.description, criteria=EXCLUDED.criteria, storage=EXCLUDED.storage, delivery=EXCLUDED.delivery,
      updated_at=now();
    -- V4-P2a: legacy kind 행 정리(흡수돼 ku 가 더는 쓰지 않음). 멱등 — 이미 없으면 no-op.
    --  A/D/F/M/L/Z=K 로 흡수, S/G=domainmap 파생(federated, ku kind 아님). 데이터 흡수가 선행돼야 안전(스크립트가 보장).
    DELETE FROM kind_registry WHERE kind IN ('A','D','F','G','S','M','L','Z');
  `);

  // ── data_source 시드(소스별 수집방식, 멱등 DO UPDATE — 정의 ground-truth). ──
  //  notion/clickup=active(KIND_MAP 정의 → 미러 적재), slack/discord=dropped(message:* 미정의 → 미러 skip, ku 0건).
  //  into_kinds 는 **실제 적재** kind 만(KIND_MAP 과 정합): clickup=[W], notion=[K], slack/discord=[](미적재).
  await pool.query(`
    INSERT INTO data_source(system, label, status, collection_method, cadence, into_kinds, sort, note) VALUES
      ('clickup','ClickUp','active',
        'ClickUp 커넥터가 리스트→프로젝트로 매핑하고, 태스크를 작업 단위로 가져온다. pm_* 툴로 태스크를 직접 쓰기도 한다.',
        '주기 동기화(run-sync)', '["W"]'::jsonb, 10,
        '프로젝트 provenance=initiative 와 연결. 태스크는 W kind 로 적재.'),
      ('notion','Notion','active',
        'Notion 커넥터가 지정한 페이지/데이터베이스의 문서를 가져온다.',
        '동기화(run-sync/backfill)', '["K"]'::jsonb, 20,
        '문서 본문은 지식(K)으로 수집(V4: 산출물 A 흡수). 외부수집은 provenance=observed. 시크릿은 적재 전 redact.'),
      ('slack','Slack','dropped',
        'Slack 커넥터가 메시지를 자료(source)로 적재한다(#541). distill 이 자료를 지식(K)으로 증류.',
        '주기 동기화(run-sync)', '[]'::jsonb, 30,
        'message → source(raw, provenance=observed). 관리탭 커넥터 설정에서 bot token 넣고 활성화. distill 이 source→knowledge.'),
      ('discord','Discord','dropped',
        'Discord 커넥터가 메시지를 자료(source)로 적재한다(#541). distill 이 자료를 지식(K)으로 증류.',
        '주기 동기화(run-sync)', '[]'::jsonb, 40,
        'message → source(raw). 관리탭 커넥터 설정에서 bot token 넣고 활성화.'),
      ('gmail','Gmail','dropped',
        'Gmail 커넥터가 메일을 자료(source)로 적재한다(#541, OAuth2 refresh-token). distill 이 지식으로 증류.',
        '주기 동기화(run-sync)', '[]'::jsonb, 50,
        'message → source(raw). 관리탭에서 Google OAuth(client_id/secret/refresh_token) 설정 후 활성화. scope gmail.readonly.'),
      ('gdrive','Google Drive','dropped',
        'Google Drive 커넥터가 문서를 지식(K)으로 적재한다(#541, OAuth2 refresh-token).',
        '주기 동기화(run-sync)', '["K"]'::jsonb, 60,
        'doc(정제 문서) → knowledge(observed). native 문서는 text/plain·csv export. 관리탭에서 Google OAuth 설정 후 활성화. scope drive.readonly.')
    ON CONFLICT ON CONSTRAINT data_source_pkey DO UPDATE SET
      label=EXCLUDED.label, status=EXCLUDED.status, collection_method=EXCLUDED.collection_method,
      cadence=EXCLUDED.cadence, into_kinds=EXCLUDED.into_kinds, sort=EXCLUDED.sort, note=EXCLUDED.note,
      updated_at=now();
  `);
}

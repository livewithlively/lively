// 스키마 init 직렬 체인 단일화(#1313 R17) — item→org→domainmap→v6 순서 규약의 **단일 출처**.
//  호출처 2곳: index.ts 부팅(boot/housekeeping.ts 'schemas' 스텝) · connectors/run-sync.ts(커넥터 CLI, quiet).
//  순서를 바꾸려면 여기 한 곳만 — 종전엔 두 곳에 복제돼 있었다(동일 순서 실측 후 단일화).
//
// (원문 — index.ts 부팅 체인에서 이사)
// 통합 DB(P0+P1): items/org/domainmap 이 한 DB(ITEMS_DATABASE_URL)에 병합됨. 세 init 을 **직렬** 체인으로
//  보장한다 — initV6Schema 의 activity_knowledge·project 정션이 knowledge/project/activity 를 FK 참조하므로
//  initOrgSchema·initDomainmapSchema 가 먼저 끝나야 한다(분리 .then 은 레이스 → FK 'relation does not exist').
//  (구 activity_ku_ref/activity_task→knowledge_unit FK 는 2026-06-24 v6 드랍됨.)
import { initItemSchema } from "../items/store.js";
import { initOrgSchema } from "../org/schema.js";
import { init as initDomainmapSchema } from "../domainmap/core/schema.js";
import { initActivitySchema } from "../activity/schema.js";
import { initV6Schema } from "../v6/schema.js";
import { ensureTenantColumn } from "../db/tenant-column.js";
import { logger } from "../log.js";

// 직렬 체인 — 멱등(부팅마다·단독 CLI 신규 DB 에서도 성립). quiet: run-sync CLI 는 종전대로 무로그(부팅 로그는 유지).
// v6 그린필드 스키마(category/knowledge/project + 정션) — 레거시 이후 직렬(FK 순서: category→knowledge/project→정션→activity·mapping·debt ALTER).
export async function initAllSchemas(opts?: { quiet?: boolean }): Promise<void> {
  // ★★ 스키마를 **소유하지 않는** 프로세스는 여기서 손을 뗀다(#1437 v1 5단계).
  //
  // 공유 게이트웨이는 DDL 권한이 없는 role 로 붙는다(RLS 를 우회하지 않으려면 비-슈퍼여야 하고,
  //  스키마 소유는 별도 마이그레이터 role 이 갖는다). 그 프로세스가 스키마 초기화를 시도하면
  //  `42501 permission denied for schema public` 로 **부팅이 실패한다** — 실측으로 밟았다.
  //
  // 스키마는 마이그레이터가 배포 절차에서 적용한다. 그러니 여기서 건너뛰는 건 "생략"이 아니라
  //  **소유권을 지키는 것**이다. ⚠ 대신 배포 절차가 마이그레이션을 반드시 돌려야 한다 —
  //  이 스위치를 켜 두고 마이그레이션을 안 돌리면 새 컬럼이 영영 안 생긴다.
  if (/^(1|true|yes)$/i.test(process.env.LIVELY_SKIP_SCHEMA_INIT || "")) {
    if (!opts?.quiet) logger.info("스키마 초기화 건너뜀 — 이 프로세스는 스키마를 소유하지 않는다(LIVELY_SKIP_SCHEMA_INIT)");
    return;
  }
  const note = (msg: string): void => { if (!opts?.quiet) logger.info(msg); };
  await initItemSchema();
  note("item schema ready");
  await initOrgSchema();
  note("org schema ready");
  await initDomainmapSchema();
  note("domainmap schema ready");
  // #1313 R23: activity/activity_touch/dash_watch + change_log.activity_id — 구 domainmap init 안에 있던 DDL 을
  //  적출(게이트웨이 전역 이벤트 레이어 ≠ 스캔 엔진). 자리는 domainmap **직후 · v6 이전** 고정:
  //  앞으로는 change_log(domainmap) 가, 뒤로는 activity_knowledge.activity_id(v6) 가 의존한다.
  await initActivitySchema();
  note("activity schema ready");
  await initV6Schema();
  note("v6 schema ready");
  // #1437 — `tenant_id` 와 복합 UNIQUE 보장. **모든 스키마가 만들어진 뒤**여야 한다(카탈로그를 읽으므로).
  //  단일 테넌트에서는 값이 상수라 동작이 달라지지 않는다 — SQL 방언을 하나로 유지하기 위한 것이다.
  const tc = await ensureTenantColumn();
  if (tc.ddl) note(`tenant column ready (테이블 ${tc.tables} · DDL ${tc.ddl})`);
}

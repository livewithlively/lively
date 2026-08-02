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
import { logger } from "../log.js";

// 직렬 체인 — 멱등(부팅마다·단독 CLI 신규 DB 에서도 성립). quiet: run-sync CLI 는 종전대로 무로그(부팅 로그는 유지).
// v6 그린필드 스키마(category/knowledge/project + 정션) — 레거시 이후 직렬(FK 순서: category→knowledge/project→정션→activity·mapping·debt ALTER).
export async function initAllSchemas(opts?: { quiet?: boolean }): Promise<void> {
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
}

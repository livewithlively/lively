// Context OS v6 스키마 — greenfield 온톨로지 재설계.
//  맥락(Context) = Category(분류축) + Knowledge(맥락의 기록) + Project(맥락의 변화).
//  컷오버 완료(2026-06-24): 레거시 domain/knowledge_unit/org_project 는 드랍됨 — v6 가 단일 캐노니컬.
//  단일 통합 DB(itemsPool). 신규 정션은 같은 DB라 **진짜 FK** 를 쓴다.
//  ⚠ 호출 순서: index.ts 직렬체인에서 initOrgSchema(kind_registry/data_source 등)·initDomainmapSchema(activity/
//   mapping/debt) **이후** 호출 — activity_knowledge.activity_id 와 activity/mapping/debt ALTER 가 그 테이블에 의존.
//  내부 FK 순서: category → knowledge/project → 정션(knowledge_category/project_*) → activity/mapping/debt ALTER.
//  멱등: CREATE TABLE IF NOT EXISTS · ADD COLUMN IF NOT EXISTS · CHECK 은 pg_constraint 프로브(기존 idiom 그대로).
//
// #1313 R19c: 구 1,270줄 단일 initV6Schema 를 관심사 조각(schema/*.ts)으로 분할 — 이 파일은 **오케스트레이터**다.
//  ⚠ await 순서는 분할 전 실행 시퀀스 그대로(SCHEMA_SQL_LOG 스냅샷 diff 0 으로 증명 — scripts/schema-init.itest.mjs
//   헤더 참조). v6 는 관심사 구획이 역사적으로도 연속이라 파일 7 = 진입점 7(org R19b 와 달리 재진입 없음).
//   재배열하려면 스냅샷 증명을 다시 떠라.
import { itemsPool } from "../db/client.js";
import { initV6CategoryTeam } from "./schema/category-team.js";
import { initV6Knowledge } from "./schema/knowledge.js";
import { initV6ProjectCore } from "./schema/project.js";
import { initV6ProjectOrg } from "./schema/project-org.js";
import { initV6TaskDetail } from "./schema/task-detail.js";
import { initV6GraphSource } from "./schema/graph-source.js";
import { initV6UiVis } from "./schema/ui-vis.js";

export async function initV6Schema(): Promise<string> {
  const pool = itemsPool;
  await initV6CategoryTeam(pool); // §1~2: category·category_edge·category_repo + team·team_member·team_category
  await initV6Knowledge(pool);    // §3~4: knowledge·revision(#783)·#335 시드·knowledge_category·publication·feed_target
  await initV6ProjectCore(pool);  // §5: project 본체 + 태스크 컬럼(§5b)·status 정규화(§5c)·assignee(§5d)·outbox(§5e)·백스톱(§5f~g)
  await initV6ProjectOrg(pool);   // §6~10: member·session(#905)·folder binding·list/folder/view + 정션·activity·레거시 ALTER
  await initV6TaskDetail(pool);   // §11·⑫·⑧: 태그·시간·체크리스트·의존성·커스텀필드·첨부·댓글
  await initV6GraphSource(pool);  // ⑭(#290): 단일-home 유니크·knowledge_link·project_edge·source·knowledge_source
  await initV6UiVis(pool);        // ⑮(#592) UI·⑬ 임베딩·멤버 개인화·가시성(#1291)
  return "initialized v6 schema";
}

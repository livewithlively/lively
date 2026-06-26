// 세션 훅 기본값 — 서버 단일 소스(2026-06-26).
//  세션종료(stop-writeback-gate) 기본 너지 문구. 관리자가 runtime-config.writeback_notice 로 덮어쓰지 않으면 이 값이 effective.
//  흐름: writeRuntimeBundle 이 (override || 이 기본값)을 .lively/hooks-config.json 에 항상 기록 → 멤버 훅이 그 값을 읽는다.
//  kit/hooks/stop-writeback-gate.mjs 의 REASON 은 config 부재(깨진 설치) 시의 오프라인 폴백일 뿐 — 이 텍스트와 동일하게 유지할 것.
//  웹 관리 UI(세션 주입 지도 ▸ 세션 종료)는 이 기본값을 노출해 '실제 값 표시 + 기본값으로 되돌리기'를 제공한다.
export const DEFAULT_WRITEBACK_NOTICE =
  "이 세션에서 파일 작업을 했지만 컨텍스트 스토어 기록이 없습니다. 마무리 전에 확인: " +
  "① 한 일을 작업(activity)으로 기록 — 이번 세션에 커밋했으면 activity_log(type='commit', commit_sha, repo, " +
  "touches=건드린 code_unit/data_entity, author_agent='어떤 AI'). 진척/결정/리뷰도 activity_log(type 맞게). " +
  "② should/is 재조정 — commit 작업이면 그 코드가 제품 카테고리(도메인)의 구조(is)를 바꿨는지 보고, 도메인 의도(should)가 " +
  "이번에 주입된 기획·대화 맥락으로 바뀌었으면 category_update(should=…)로 갱신(도메인間 새 의도 의존이 생겼으면 " +
  "category_edge_set). 바뀐 게 없으면 activity_log 의 should_review/is_review='checked_no_change' 로 '점검함·변화없음'을 " +
  "명시 기록(안 한 것과 구분). " +
  "③ 지속될 지식·결정·설계·런북은 knowledge_save 로 전문 기록 — injection(always=세션마다 항상 주입되는 규칙·페르소나 / " +
  "recalled=검색으로 소환) + provenance(authored=직접 저작 / observed=외부 관찰), 카테고리 연결은 knowledge_link_category, " +
  "대체된 옛 지식은 knowledge_set_lifecycle(superseded). 작업과는 activity_log 의 ku_refs(produced/references/decided)로 연결. " +
  "외부 원본은 복제 말고 미러+파생만. " +
  "진행한 태스크는 task_set_status_v6, 새 카테고리(도메인) 후보는 category_create(근거 포함). " +
  "④ 기록할 것이 없으면 그대로 다시 종료하면 됩니다(이 알림은 세션당 1회).";

// 세션 훅 기본값 — 너지 문구의 서버 '라이브 단일소스'(#270 재정립).
//  세션종료(stop-writeback-gate) 너지 전문. 어드민이 runtime-config.writeback_notice 로 덮어쓰지 않으면 이 값이 effective.
//  라이브 흐름: GET /api/ui/org/runtime-config 가 (override || 이 기본값)을 fold 해 서빙(delivery.ts) →
//    session-preload 가 매 세션 ~/.lively/hooks-config.json 에 기록 → 게이트가 그 값으로 너지. 설치 번들도 동일 fold(publish.ts:writeRuntimeBundle).
//  ⚠ kit/hooks/stop-writeback-gate.mjs 의 REASON 은 게이트웨이 영영 불가 시의 짧은 last-resort '스텁'일 뿐 — 이 전문과 동일할 필요 없다
//    (과거엔 동기화 요구였으나 #270 에서 라이브 단일소스로 이관 — 재설치 없이 이 값 수정만으로 다음 세션 반영).
//  웹 관리 UI(세션 주입 지도 ▸ 세션 종료)는 이 기본값을 노출해 '실제 값 표시 + 기본값으로 되돌리기'를 제공한다.
export const DEFAULT_WRITEBACK_NOTICE =
  "이 세션에서 파일 작업을 했거나 외부 툴에서 맥락을 끌어왔는데 컨텍스트 스토어 기록이 없습니다. 마무리 전에 확인: " +
  "① 한 일을 작업(activity)으로 기록 — type 은 그 작업의 성격(feature·fix·decision·docs·research·review·chore·other). " +
  "이번 세션에 커밋했으면 그 일의 성격을 type 으로 두고(예 type='feature'|'fix') commit_sha·repo·touches(건드린 code_unit/data_entity)를 함께 넘긴다 " +
  "— 커밋은 유형이 아니라 commit_sha 로 표현된다. author_agent 는 게이트웨이가 접속 신원으로 자동 식별하니 넘기지 않아도 된다. " +
  "이 세션이 특정 프로젝트(task) 안에서 진행됐다면 activity_log 에 project_id 를 넘겨 그 프로젝트에 진척을 연결한다. " +
  "② should/is 재조정 — 커밋한 작업이면 그 코드가 제품 카테고리(도메인)의 구조(is)를 바꿨는지 보고, 도메인 의도(should)가 " +
  "이번에 주입된 기획·대화 맥락으로 바뀌었으면 category_update(should=…)로 갱신(도메인間 새 의도 의존이 생겼으면 " +
  "category_edge_set). 바뀐 게 없으면 activity_log 의 should_review/is_review='checked_no_change' 로 '점검함·변화없음'을 " +
  "명시 기록(안 한 것과 구분). " +
  "③ 지속될 지식·결정·설계·런북은 knowledge_save 로 전문 기록 — injection(always=세션마다 항상 주입되는 규칙·페르소나 / " +
  "recalled=검색으로 소환) + provenance(authored=직접 저작 / observed=외부 관찰), 카테고리 연결은 knowledge_link_category, " +
  "대체된 옛 지식은 knowledge_set_lifecycle(superseded). 작업과는 activity_log 의 ku_refs(produced/references/decided)로 연결. " +
  "외부(노션·슬랙 등)에서 끌어온 자료 — 프록시(ext__*)나 외부 MCP 로 읽은 건 세션이 끝나면 그대로 증발한다(게이트웨이는 " +
  "무엇을 읽었는지 안 남긴다). 커넥터 미러가 이미 갖고 있으면(knowledge_search 로 먼저 확인) 중복 저장하지 말고, " +
  "미러 범위 밖이라 라이블리에 없으면(개인·미공유 페이지, 커넥터 없는 툴, 방금 쓴 것) source_save 로 원문을 자료로 남긴다. " +
  "원본을 지식으로 복제하지는 말고, 거기서 얻은 파생 인사이트만 knowledge_save 로 저작한다. " +
  "진행한 태스크/프로젝트는 상태 갱신(task_set_status_v6·project_set_status_v6), 쪼개진 후속 일은 task_create_v6 로 (하위)작업 신설, " +
  "이 세션이 만든 산출 지식은 project_link_knowledge_v6(produced)로 프로젝트에 연결(필요지식은 required). " +
  "새 카테고리(도메인) 후보는 category_create(근거 포함). " +
  "④ 기록할 것이 없으면 그대로 다시 종료하면 됩니다(이 알림은 세션당 1회).";

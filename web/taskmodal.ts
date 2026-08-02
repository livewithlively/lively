// taskmodal.ts — #1313 R56: 태스크 모달 **배럴**. 실물은 web/taskmodal/ 로 섹션 분할됐다(소비자 무수정).
//   util(리프 헬퍼) · composer(작성기) · tags(태그) · fields(필드 영역) · blocks(연결·체크리스트) ·
//   attachments(첨부) · activity(Activity 패널) · shell(모달 셸 — 주소·히스토리·스크롤 계약 + 좌측 조립).
//  ⚠ 소비자(main·projects·undo·dash/widget-tasks-review-log)는 계속 './taskmodal.js' 만 본다.
export { pjvtmComposerToolbar } from './taskmodal/composer.js';
export { PJV_TAG_NONE } from './taskmodal/tags.js';
export { pjvCloseTaskModalOnRoute, pjvOpenTaskModal, pjvRenderTaskRoute, pjvTaskModalRefreshIfRoute } from './taskmodal/shell.js';

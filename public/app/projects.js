// projects.ts — 프로젝트 화면(#/projects2)의 **재수출 배럴**. 로직 0줄 · 소유 심볼 0개.
//  12,607줄 몬스터를 R30~R36 으로 해체하고 남은 것이 이 통로다. 실체는 전부 web/projects/ 아래에 있다:
//   · board.ts            보드 조립부(라우터 진입 · 스코프/전체 보드 · 칸반 · 사이드바 트리 · 3층 헤더)  ← R36
//   · detail.ts           프로젝트 상세/모달 입구(detail-{meta,body,sections,tasks}.ts 를 중계)          ← R35
//   · sidebar·list-forms·project-form   좌측 트리 · 리스트/폴더 폼 · 새 프로젝트 폼                      ← R34
//   · selection·rows·timeline           다중선택/벌크 · 행·그룹 렌더러 · 타임라인(간트)                  ← R33
//   · columns·fields·filters            컬럼 시스템 · 커스텀 필드 · 필터/뷰 탭                           ← R32
//   · state·status·task-controls        보기 상태 싱글턴 · 상태 체계 · 태스크 인라인 컨트롤              ← R31
//   · popover·icons·files               팝오버 프리미티브 · 아이콘 · 파일/업로드                         ← R30
//
//  왜 배럴을 남기나 — 외부 소비자(main·undo·taskmodal/*·dashboard·dash/*)의 import 문을 캠페인 내내 **무변경**으로
//  두기 위해서다. 그래서 여기 이름은 전부 `export … from` 재수출이고, 값 복사(import 후 로컬 재수출)는 쓰지 않는다.
//  ⚠⚠ 특히 pjvTaskRow 는 소유 모듈의 몽키패치 IIFE 가 런타임에 바인딩을 교체하므로 `export … from` 체인이어야 한다
//   (값 복사로 바꾸면 패치 이전 함수가 굳어 태스크 제목 클릭이 죽는다). 가드: scripts/pjv-taskrow-monkeypatch.test.mjs
//  ⚠ web/projects/*.ts 가 이 파일을 되짚는 import(역방향 엣지)는 아직 남아 있다 — 소유는 이미 옮겨갔고 여기는
//   통로일 뿐이라, 그 줄들을 소유처 직결로 바꾸면 순환이 오히려 늘어난다(실측). scripts/check-imports.mjs
//   ALLOWED_CYCLES 주석에 실측치와 근거가 있다.
// ── R36: 보드 조립부 ──────────────────────────────────────────────────────────
//  renderProjectsV2 = 라우터 진입(web/main.ts). 나머지는 projects/{columns,filters,sidebar,rows,selection,
//  detail-meta,detail-tasks}.ts 와 taskmodal/fields.ts 가 되짚어 받는 보드 소유 심볼이다.
export { PJV_SUBTASK_BTNLABEL, pjvFolderDrag, pjvSaveProjMembers, pjvSavedViewMenu, pjvSetProjStatusCustom, pjvSideDrag, pjvSubtaskMenu, pjvSwitchRow, pjvTaskModalStatusField, renderProjectsV2, } from './projects/board.js';
// ── R35: 프로젝트 상세·모달 계열 ─────────────────────────────────────────────
//  ⚠ 문 하나로만 통한다: 상세 계열의 **입구인 projects/detail.ts 만** 물고 나머지 넷은 detail.ts 가 중계한다.
//   넷을 각각 물면 projects→(상세 4모듈)→projects/{rows,columns,fields,selection}→projects 경로가 문 수만큼
//   곱해져 elementary 순환이 배로 늘어난다(실측 105건 → 입구를 하나로 좁혀 35건).
export { buildWysiwygToolbar, companyTimelineSection, copyText, mdFromDom, mountBodyEditor, openLocalWorkModal, openProjectSessionForm, pjvAddTask, pjvCloseProjectModalOnRoute, pjvOpenProjectModal, pjvProjectModalOpen, pjvProjectModalRefreshIfRoute, pjvRowMore, pjvTaskRow, renderProjectV2Detail, uploadBodyFile, } from './projects/detail.js';
// ── taskmodal 중계 ───────────────────────────────────────────────────────────
//  projects/{rows,selection,timeline,detail-tasks,detail-body}.ts 가 이 셋을 여기서 받는다. 각 모듈이
//  './taskmodal.js' 를 직접 물면 projects↔taskmodal 순환에 가지가 그만큼 늘어난다(#1313 R33/R35).
export { PJV_TAG_NONE, pjvOpenTaskModal, pjvtmComposerToolbar } from './taskmodal.js';
// ── R30~R33: 리프·상태·컬럼 계열의 공개분 ────────────────────────────────────
//  공개범위 폼 프리미티브(compactPicker·memberPicker, #1291)는 리스트·스페이스와 **같은 컨트롤**을 공유폴더
//  모달(dashboard-home)이 쓴다 — 같은 개념(누가 보나)이 화면마다 다르게 생기면 규칙을 두 번 배워야 한다.
export { compactPicker, pjvPopover } from './projects/popover.js';
export { pjvCheckMini } from './projects/icons.js';
export { UP_CONFIRM, authDownload, authUpload, authUploadProgress, avatarColor, debounce, fileIconSvg, fileSortApply, fileSortBtn, fileSortLoad, fileSortSave, fmtDateTime, fmtFileDate, fmtFileDateFull, fmtSize, initials, memberPicker, openFileViewer, upControl, upDropZone, upIsAbort, upPrecheckOverwrite, upProgress, upSend, upToast, } from './projects/files.js';
// 태스크 모달이 닫히며 뒤 화면(프로젝트 상세)이 다시 그려질 때 보던 자리를 지키기 위한 것(#1233-1 · taskmodal closeModal).
export { pjvConsumeSkipRouteRender, pjvKeepScrollForNextRender, pjvReloadKeepScroll, pjvRestoreScroll, pjvScrollTopNow, pjvSkipNextRouteRender, } from './projects/state.js';
export { PJV_PRIORITY, PJV_PRIORITY_ORDER, PJV_STATUS_ORDER, PJV_TASK_STATUS, pjvFmtDate, pjvIsOverdue, pjvStatusIconStd, pjvStatusMeta, } from './projects/status.js';
export { pjvAssigneeControl, pjvAssigneeWrite, pjvAssignees, pjvDueControl, pjvPatchTask, pjvPriorityControl, pjvSaveTask, } from './projects/task-controls.js';
// pjvBoardFieldsCur·pjvHeadSortable 은 #1313 R36 에서 projects/columns.ts 로 내려갔다(읽는 쪽이 컬럼 헤더뿐이라
//  columns·fields 가 이 배럴을 되짚을 이유가 사라졌다). 외부 공개 표면은 그대로 유지한다.
export { pjvBoardFieldsCur, pjvGridTemplate, pjvHeadSortable } from './projects/columns.js';
export { pjvFieldControl } from './projects/fields.js';
export { openListForm, pjvFolderIsArchive, pjvFolderIsSpace } from './projects/list-forms.js';
export { openProjectV2Form } from './projects/project-form.js';

// dashboard-home.ts — '대시보드' 상위 탭(#/dashboard)의 **엔트리**. 구현은 전부 web/dash/ 로 나갔다(#1313 R41·R42·R43).
//  이 파일은 배럴이다: 소비자(main.ts 등)의 `from './dashboard-home.js'` 를 고치지 않기 위해 이름만 그대로 통과시킨다.
//  화면을 고치러 왔다면 dash/shell.ts(배치·인사줄·존·편집 모달) 아니면 dash/widget-*.ts(위젯 한 개)로 가라.
//   기반층: prefs(개인화 저장) · icons(SVG) · status(상태계) · resize(폭·높이) · chrome(위젯 공용 크롬)
//   위젯:   widget-projects* · widget-sessions* · widget-folders · widget-notifications · widget-tasks-review-log
export * from './dash/prefs.js';
export * from './dash/icons.js';
export * from './dash/status.js';
export * from './dash/resize.js';
export * from './dash/chrome.js';
export * from './dash/shell.js';
export * from './dash/widget-projects.js';
export * from './dash/widget-projects-popovers.js';
export * from './dash/widget-sessions.js';
export * from './dash/widget-sessions-popovers.js';
export * from './dash/widget-folders.js';
export * from './dash/widget-notifications.js';
export * from './dash/widget-tasks-review-log.js';
export * from './dash/widget-lively-log.js';

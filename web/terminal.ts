// terminal.ts — AI 세션 매니저(#/terminal) **배럴**. 로직은 여기 없다 — 실체는 terminal/{status-filter,select-bar,session-form,session-list,routes}.ts 이고
//  이 파일은 소비자(web/main.ts · dashboard-home.ts · projects.ts)의 import 경로를 고정하는 재수출만 한다(#1313 R54).
//  ⚠ 여기에 새 로직을 두지 마라 — 들어갈 자리는 아래 5모듈 중 하나다(각 파일 첫 줄에 역할·소비자·import 방향이 적혀 있다).

// ════════════════════════════════════════════════════════════════════
// 터미널 세션 매니저 (#/terminal) — 중앙 박스 경로 D: xterm.js + 서버 node-pty(tmux).
//  목록/생성폼/CRUD → REST(/api/ui/terminal/*), PTY 스트림 → WS(/terminal/ws, ticket 쿠키).
//  보기(폰트·크기·테마·커서)는 사용자별 localStorage 영속 + 실시간 적용. 보안: el()/textContent 만.
// ════════════════════════════════════════════════════════════════════
//  모듈 배치(의존은 아래→위 단방향):
//   status-filter → select-bar → session-form → session-list → routes
//   status-filter 상태 어휘·3축 필터 · select-bar 세션 URL·조건선택·열기 방식 · session-form 생성/수정 폼·노드 관리
//   session-list 프로젝트 트리·카드·질문검색 · routes #/terminal 진입(renderTerminal)·온보딩 투어

export { renderTerminal, startTerminalTour } from './terminal/routes.js';
export {
  openTermCreateForm,
  // '실행 설정' 기억(#673) — 프로젝트 탭 '웹에서 바로 열기' 폼도 같은 키를 읽고 써 두 폼이 기억을 공유한다(#req).
  termCreatePrefs,
  saveTermCreatePrefs,
  termAutoApprovePref,   // 체크박스 없는 원클릭 실행(대시보드 '만들고 Claude로 실행' 등)이 쓰는 자동 승인 기본값(#782)
} from './terminal/session-form.js';
export { openSessPrompts } from './terminal/session-list.js';
export { openGridPicker, openSessionSelectPicker } from './terminal/select-bar.js';

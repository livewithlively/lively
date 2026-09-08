// projects/detail.ts — #1313 R35: web/projects.ts 분해 ⑥.
//  프로젝트 상세 **페이지/모달의 조립부** — 상세 계열 4모듈을 불러 한 화면으로 세운다.
//   · Lively 둘러보기 데모(DEMO_PROJECT·renderProjectDemo·데모 카드 2종)
//   · 상세 모달 싱글턴(_pjvPmOpen·_pjvPmUrl) + 라우터 연동 3함수(pjvCloseProjectModalOnRoute·
//     pjvProjectModalOpen·pjvProjectModalRefreshIfRoute) + pjvOpenProjectModal
//   · 페이지 렌더러 renderProjectV2Detail (모달도 같은 렌더러를 모달 컨테이너에 호출한다)
//   · 미리보기 모달(openProjectPreviewModal, #1036)
//  ⚠ _pjvPmOpen·_pjvPmUrl 은 이 모듈이 **단독 소유**한다(항상 최대 1개). detail-meta.ts 의 엣지 칩 드릴인만
//   읽기 전용으로 import 한다 — 세터는 두지 않는다(닫기 경로가 mode 로 갈라져 있어 외부 쓰기는 곧 버그다).
//  이 파일은 상세 계열의 **입구**이기도 하다 — 배럴(projects.ts)은 여기 하나만 물고 형제 셋은 아래에서 중계한다.
import { api, applyReveal, el, errorNote, personFace, state, toast } from '../core.js';
import { skeleton } from '../learn.js';
import { projectBodyCommentRow, projectBodySection, projectKnowledgeSection } from './detail-body.js';
import { pjvProjMetaPanel } from './detail-meta.js';
import { openProjectSessionForm, openProjectSettings, projectFolderSection, projectTerminalSection, projectTimelineSection } from './detail-sections.js';
import { pjvTasksSection } from './detail-tasks.js';
import { pjvSelReset } from './selection.js';
import { clearSortCtx, consumeKeepScroll, pjvRestoreScroll } from './state.js';
import { pjvLoadStatusTemplates, pjvRegisterProjList, pjvSetStatusRegistry, pjvStatusReg } from './status.js';

// 프로젝트 상세(v2) #/projects2/p/:id — 헤더(이름·상태 토글·팀원) + 태스크▸하위 트리 + 필요/산출 지식.
//  renderProjectDetail 의 헤더 결을 따르되, 본문은 태스크 계층 + 지식 두 섹션(GET /api/ui/v6/projects/:id).
// ── Lively 둘러보기(#761) 전용 예시 프로젝트 — 실제 데이터 대신 '선행/후행·연결된 지식·과업'을 직관적으로 보여주는
//  큐레이팅된 상세 페이지. 실제 UI 컴포넌트(메타패널·본문·지식·태스크)를 그대로 재사용해 진짜처럼 보이되 내용만 고정.
//  라우트: #/projects2/p/__demo__ (아래 renderProjectV2Detail 상단 가드). 저장/생성 액션은 안 쓴다(투어는 취소로 끝).
const DEMO_PROJECT: any = {
  id: '__demo__', name: '새 요금제 ‘팀 플랜’ 출시', status: 'in_progress', list_id: null,
  body: '기존 개인 요금제에 여러 명이 함께 쓰는 ‘팀 플랜’을 새로 추가한다. 목표는 3개월 내 유료 전환율 +15%.',
  description: '기존 개인 요금제에 여러 명이 함께 쓰는 ‘팀 플랜’을 새로 추가한다. 목표는 3개월 내 유료 전환율 +15%.',
  members: [{ member_id: 'demo-me', display_name: '나' }, { member_id: 'demo-minji', display_name: '민지' }],
  edges: {
    // 선행(outgoing)=이 프로젝트가 뒤따르는 앞 일 · 후행(incoming)=이 프로젝트를 뒤따르는 뒤 일. 조사 → (출시) → 분석 흐름.
    outgoing: [{ project_id: 'demo-pre', project_name: '경쟁사 요금제 조사', relation: 'follow_up' }],
    incoming: [{ project_id: 'demo-post', project_name: '출시 후 전환율 분석', relation: 'follow_up' }],
  },
  knowledge: {
    required: [
      { name: 'demo-kn-price', title: '경쟁사 가격 비교 (2월 조사)' },
      { name: 'demo-kn-policy', title: '요금 정책 결정 로그' },
    ],
    produced: [],
  },
  tasks: [
    { id: 'demo-t1', name: '팀 플랜 가격·인원 정책 확정', status: 'done', subtasks: [] },
    { id: 'demo-t2', name: '결제 페이지에 팀 플랜 추가', status: 'in_progress', subtasks: [] },
    { id: 'demo-t3', name: '기존 고객에게 출시 안내 메일 발송', status: 'todo', subtasks: [] },
  ],
  fields: [], repos: [],
};

// 데모 세션 이름 프리필 — 세션 이름은 '프로젝트명'이 아니라 '이 세션이 하는 일'로 짓는 게 자연스럽다(투어가 가르치려는 것).
//  그래서 데모 '＋새 세션'(웹)의 이름은 프로젝트명(DEMO_PROJECT.name) 대신 이 예시로 프리필한다 — 데모 태스크 'demo-t3
//  기존 고객에게 출시 안내 메일 발송'과 같은 세계. ⚠ guide-tour.ts 의 sess-name 코치마크 예시와 반드시 일치시킨다.
const DEMO_SESSION_NAME = '출시 안내 메일 초안';

function renderProjectDemo(view) {
  const P = DEMO_PROJECT, members = P.members, noop = () => {};
  const meId = (state.me && (state.me.userId || state.me.email)) || 'demo-me';
  const backLink = el('a', { class: 'btn btn-ghost btn-sm', href: '#/projects2', text: '← 프로젝트' });
  const head = el('div', { class: 'page-head' }, backLink);
  const titleEl = el('h1', { class: 'proj-detail-title', text: P.name });
  const settingsBtn = el('button', { class: 'btn btn-sm btn-ghost', text: '⚙ 프로젝트 세부 설정',
    onclick: () => toast('둘러보기 예시라 여기선 생략돼요 — 실제 프로젝트에서 열 수 있어요.') });
  head.append(el('div', { class: 'proj-detail-titlebar' },
    el('div', { class: 'proj-detail-titlebox' }, titleEl),
    el('div', { class: 'proj-detail-actions' }, settingsBtn)));
  head.append(pjvProjMetaPanel(P, members, noop));
  view.replaceChildren(head,
    projectBodySection('__demo__', P, noop),
    projectKnowledgeSection('__demo__', P, noop),
    pjvTasksSection('__demo__', P.tasks, members, noop, []),
    demoFolderCard(),
    demoTerminalCard(members, meId));
  (document.getElementById('view') as any)?.focus?.();
}

// 데모 공유 폴더 — 파일 fetch 없이 '공유 폴더' 카드(제목·앵커는 실제와 동일 → 투어가 짚는다).
function demoFolderCard() {
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
  card.append(el('div', { class: 'card-head' }, el('h3', { text: '공유 폴더' }),
    el('div', { class: 'card-head-actions' },
      el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 폴더' }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 업로드' }))));
  const file = (ic, nm) => el('div', { class: 'proj-file-card' },
    el('div', { class: 'proj-file-card-ic', text: ic }),
    el('div', { class: 'proj-file-card-nm', text: nm }));
  card.append(el('div', { style: 'display:flex;gap:14px;flex-wrap:wrap;padding:6px 2px' },
    file('📊', '요금제_비교표.xlsx'), file('📄', '출시_공지_초안.docx'), file('🖼', '결제화면_시안.png')));
  return card;
}

// 데모 터미널 세션 — 실제 '＋ 새 세션' 드롭다운·만들기 팝업(openProjectSessionForm)을 그대로 열어 투어가 시연.
//  세션 목록은 fetch 없이 팀원 진열만. 만들기 팝업은 제출 안 하고 취소로 끝나므로 데모 id 여도 안전.
function demoTerminalCard(members, meId) {
  const card = el('div', { class: 'card proj-term-card', style: 'margin-bottom:18px' });
  // 실제 화면과 **같은 통합 모달**을 연다(#1145) — 종전엔 '내 PC / 웹' 드롭다운을 거쳤지만 그 선택은
  //  이제 모달 안(제목 줄 pill)에 있다. 데모도 실제와 같은 흐름이어야 투어가 거짓말을 하지 않는다.
  //  세션 이름은 프로젝트명이 아니라 '이 세션이 하는 일'로 프리필한다(#1009).
  const newBtn = el('button', { class: 'btn btn-ghost btn-sm', 'data-tour': 'proj-new-session', text: '＋ 새 세션' });
  newBtn.onclick = (e) => {
    e.stopPropagation();
    openProjectSessionForm('__demo__', () => {}, '/api/ui/v6/projects/', DEMO_SESSION_NAME, []);
  };
  card.append(el('div', { class: 'card-head' }, el('h3', { text: '터미널 세션' }), el('div', { class: 'card-head-actions' }, newBtn)));
  const person = (m) => el('div', { class: 'proj-person' },
    personFace(m.member_id, 'proj-avatar', m.display_name || m.member_id),
    el('div', { class: 'proj-person-name', text: m.display_name || m.member_id }),
    el('div', { class: 'proj-person-status empty', text: m.member_id === meId ? '✎ 상태 남기기' : '' }));
  card.append(el('div', { class: 'proj-people-grid' }, ...members.map(person)));
  return card;
}

// 프로젝트 상세 팝업 — 대시보드 '내 프로젝트' 행 클릭 시 페이지로 튀지 않고 모달로 연다. 상세를 **그대로**(축약 없이)
//  렌더하고 모달 안에서 스크롤한다: 페이지와 똑같은 renderProjectV2Detail 을 모달 컨테이너에 호출하므로 내용·편집·재렌더가 전부 동일.
//  페이지용 '← 프로젝트' 백링크만 모달에선 CSS 로 숨긴다(모달은 ✕·Esc·배경클릭으로 닫음). 닫을 때 호출자(대시보드) 갱신.
//  태스크 팝업(pjvOpenTaskModal)과 동일한 결. 상세가 등록하는 전역 paste 핸들러는 DOM 이탈 시 스스로 해제되므로 누수 없음.
// 지금 열린 프로젝트 모달(항상 최대 1개) — 네 곳이 쓴다:
//  ① 모달 안 선행/후속 칩이 이 모달을 닫고 그 프로젝트로 '교체'(드릴인, #804)
//  ② 라우트가 바뀌면 라우터가 닫는다(pjvCloseProjectModalOnRoute, #804) — 단 '자기 주소'면 살려둔다(#810)
//  ③ 모달이 소유한 URL(히스토리 항목)을 닫을 때 되돌린다(#808 — 아래 _pjvPmUrl)
//  ④ 위에 겹친 태스크 모달(#810)이 '내가 닫히면 라우터가 뒤 화면을 그릴까'를 판단할 때(pjvProjectModalOpen)
// 닫는 경로마다 URL·재렌더 처리가 달라 mode 로 구분한다(#808 — 옛 skipReload 불리언을 대체):
//  'user'  ✕·Esc·배경클릭   → 우리가 넣은 히스토리 항목을 pop(뒤로) → 원래 URL 복귀 + 라우터가 뒤 화면을 다시 그림
//  'route' 라우터가 닫음     → URL 은 이미 다른 곳으로 갔다 → 히스토리·재렌더 둘 다 손대지 않는다
//  'page'  '전체 페이지로 ↗' → 같은 URL 에서 페이지가 렌더된다 → 항목은 그대로 두고 재렌더는 라우터에 맡긴다
//  'swap'  선행/후속 드릴인  → 다음 모달이 같은 항목을 replaceState 로 이어받는다(히스토리가 안 쌓인다)
type PjvPmClose = 'user' | 'route' | 'page' | 'swap';

let _pjvPmOpen: { close: (mode?: PjvPmClose) => void; pageReload?: any; url: string; refresh: () => void } | null = null;

// 모달이 소유한 히스토리 항목(#808) — 열 때 push 한 '#/projects2/p/<id>'. ret = 그 직전 해시(닫으면 돌아갈 곳).
//  null = URL 을 소유하지 않음(push 실패했거나 이미 그 해시) → 닫을 때 히스토리를 건드리지 않는다.
let _pjvPmUrl: { ret: string } | null = null;

// 라우터(main.ts route())가 호출 — 모달은 document.body 에 얹혀 라우터가 존재를 모른다. 안 닫으면 새 페이지가
//  모달 뒤에 렌더돼 '클릭해도 아무 일 없는' 죽은 클릭이 된다(뒤로가기도 동일). 편집 중 본문은 모달이 닫히며 저장된다.
// #810 — 모달은 '자기 주소'를 소유한다(#808). 새 주소가 그 주소면 **살려둔다**: 위에 겹쳤던 태스크 모달을 닫고
//  이 모달의 주소로 되돌아온 경우다. true 를 돌려주면 라우터는 뒤 화면(보드·대시보드)도 다시 그리지 않는다 —
//  모달 뒤는 열었을 때 그대로여야 하니까.
function pjvCloseProjectModalOnRoute(): boolean {
  if (!_pjvPmOpen) return false;
  if (_pjvPmOpen.url === location.hash) return true;
  _pjvPmOpen.close('route');
  return false;
}

// 프로젝트 모달이 떠 있나 — 태스크 모달(#810)이 '내가 pop 하면 라우터가 뒤 화면을 다시 그릴지'를 판단할 때 쓴다.
//  떠 있으면 라우터는 그 모달을 살려두느라 아무것도 안 그리므로, 태스크 모달이 직접 pageReload 해야 한다.
function pjvProjectModalOpen(): boolean { return !!_pjvPmOpen; }

// 전역 실행취소(undo.ts) 처럼 '지금 화면'을 다시 그려야 할 때 — 이 모달이 주소의 주인이면 라우터는 안 도니(위 규칙)
//  모달 안을 직접 다시 그린다. 그리지 않으면 되돌린 결과가 화면에 안 보이는 조용한 스테일이 된다.
function pjvProjectModalRefreshIfRoute(): boolean {
  if (!_pjvPmOpen || _pjvPmOpen.url !== location.hash) return false;
  _pjvPmOpen.refresh();
  return true;
}

function pjvOpenProjectModal(projectId, pageReload?) {
  // 주소는 지금 보고 있는 것을 가리킨다(#808) — 모달이 뜨면 URL 도 그 프로젝트가 된다(복사·공유·북마크가 통하고,
  //  새로고침하면 같은 내용이 전체 페이지로 뜬다. 뒤로가기 = 모달 닫고 목록). pushState 는 hashchange 를 쏘지 않으므로
  //  (#541 스코프 딥링크가 이미 기대는 사실) 라우터가 돌지 않는다 — 돌면 #804 의 '라우트가 바뀌면 모달을 닫는다'가
  //  방금 연 모달을 닫아버리는 자충수가 된다.
  const url = '#/projects2/p/' + projectId;
  if (_pjvPmUrl) {
    // 드릴인 교체(선행/후속 칩) — 앞 모달이 이미 항목을 소유 중이니 늘리지 말고 갈아끼운다(뒤로가기 한 번 = 목록).
    try { history.replaceState(null, '', url); } catch (_) { /* noop */ }
  } else if (location.hash !== url) {
    const ret = location.hash || '#/';
    try { history.pushState(null, '', url); _pjvPmUrl = { ret }; } catch (_) { /* noop */ }
  }

  const back = el('div', { class: 'pjv-pm-back' });
  const box = el('div', { class: 'pjv-pm' });
  const bodyEl = el('div', { class: 'pjv-pm-body' });
  const fullLink = el('a', { class: 'btn btn-ghost btn-sm', href: url,
    text: '전체 페이지로 ↗', title: '이 프로젝트를 전체 페이지로 열기' });
  const closeBtn = el('button', { class: 'pjv-pm-x', type: 'button', title: '닫기 (Esc)', 'aria-label': '닫기', text: '✕' });
  box.append(el('div', { class: 'pjv-pm-head' }, fullLink, closeBtn), bodyEl);
  back.append(box);

  let closed = false;
  function closeModal(mode: PjvPmClose = 'user') {
    if (closed) return;
    closed = true;
    if (_pjvPmOpen && _pjvPmOpen.close === closeModal) _pjvPmOpen = null;
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('pjv-pm-open');
    back.remove();
    // URL 되돌리기(#808) — 우리가 넣은 항목을 pop 하면 원래 해시(보드·대시보드)로 돌아가고, 그 hashchange 로 라우터가
    //  뒤 화면을 새로 그린다 → pageReload(모달 안 수정을 목록에 반영)는 그 재렌더가 대신하므로 생략한다(이중 렌더·중복
    //  fetch 방지 — #804 가 라우터 close 에서 편 논리와 같다). 'route'(이미 다른 데로 이동)·'page'(같은 URL 에서 페이지가
    //  렌더됨)에서 히스토리를 되돌리면 사용자를 엉뚱한 곳으로 돌려보내게 된다 → 항목만 놓아준다. 'swap' 은 다음 모달이 이어받는다.
    let popped = false;
    if (mode === 'user') {
      if (_pjvPmUrl) { _pjvPmUrl = null; try { history.back(); popped = true; } catch (_) { /* noop */ } }
    } else if (mode !== 'swap') {
      _pjvPmUrl = null;
    }
    if (pageReload && mode === 'user' && !popped) pageReload(); // 모달 안에서 고친 내용이 대시보드 목록에 반영되도록
  }
  // Esc — 중첩 팝업(태스크 모달·팝오버·오버레이·블록에디터 팝업)이 떠 있으면 그쪽이 먼저 처리하고 이 모달은 유지.
  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (document.querySelector('.pjv-tm-back, .pjv-pop, .ov-back, .be-slash, .be-turnpop, .be-linkpop, .be-blockmenu, .be-mentionmenu')) return;
    closeModal();
  }
  back.addEventListener('mousedown', (e) => { if (e.target === back) closeModal(); }); // 배경 클릭
  closeBtn.onclick = (e) => { e.stopPropagation(); closeModal(); };
  // '전체 페이지로 ↗' — 모달을 닫고 같은 주소에서 전체 페이지를 그린다. URL 은 이미 이 프로젝트라(#808) 앵커를 그대로
  //  두면 해시가 안 바뀌어 hashchange 가 안 뜨고 → 라우터가 안 돌아 '눌러도 아무 일 없는' 죽은 클릭이 된다(#804 부류).
  //  라우터를 직접 깨운다(undo.ts rerenderRoute 와 같은 방식). ⌘/Ctrl/Shift/중클릭 은 브라우저 기본(새 탭) — 모달은 유지.
  fullLink.onclick = (e: any) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    closeModal('page'); // 라우터가 곧 그 페이지를 그리므로 재렌더는 생략. 히스토리 항목은 그대로(이제 페이지가 그 URL 의 주인)
    if (location.hash === url) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = url; // URL 동기화가 안 된 예외(pushState 실패 등) — 평소대로 해시 이동
  };
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  document.body.classList.add('pjv-pm-open');
  //  url = 이 모달이 소유한 주소(라우터가 '살려둘지' 판단 · #810), refresh = 모달 안만 다시 그리기(undo 등)
  _pjvPmOpen = { close: closeModal, pageReload, url, refresh: () => renderProjectV2Detail(bodyEl, String(projectId)) };

  renderProjectV2Detail(bodyEl, String(projectId)); // 페이지와 동일한 렌더러 → 내용 축약 없음
  return closeModal;
}

async function renderProjectV2Detail(view, idStr) {
  if (idStr === '__demo__') return renderProjectDemo(view); // Lively 둘러보기 전용 예시 프로젝트(#761)
  pjvSelReset(); // 화면 진입/재렌더 시 다중선택·하단 바 초기화
  clearSortCtx(); // 보드의 정렬/그룹 컨텍스트 잔존 차단(#541 리뷰 — 상세 헤더가 보드 리스트 설정을 오염)
  const id = Number(idStr);
  const V6_BASE = '/api/ui/v6/projects/'; // 파일/세션/타임라인/팀원 섹션이 v6 라우트로 연결되도록 base 주입
  const backLink = el('a', { class: 'btn btn-ghost btn-sm proj-detail-backlink', href: '#/projects2', text: '← 프로젝트' });
  const { y: keepY, host: keepHost } = consumeKeepScroll(); // 인라인 편집 재렌더·태스크 모달 닫기면 스켈레톤 스킵 + 스크롤 복원(#358·#1233)
  if (keepY == null) view.replaceChildren(skeleton('프로젝트를 불러오는 중'));
  let data: any;
  try { data = await api('/api/ui/v6/projects/' + id).then((d) => d && (d.project || d)); }
  catch (e) {
    view.replaceChildren(el('div', { class: 'page-head' }, backLink), errorNote(e, '프로젝트를 불러오지 못했습니다'));
    return;
  }
  if (!data) { view.replaceChildren(el('div', { class: 'page-head' }, backLink), el('div', { class: 'note', text: '프로젝트를 찾을 수 없습니다.' })); return; }
  const p = data;
  // #731 상세 뷰는 보드처럼 전체 리스트를 싣지 않아 상태 레지스트리가 비어있을 수 있다 → 이 프로젝트·태스크 상태칩이
  //  소속 리스트의 커스텀 상태(색·이름)를 쓰도록 리스트 레지스트리를 보강하고 프로젝트→리스트 매핑을 등록한다.
  pjvRegisterProjList(p.id, p.list_id);
  if (p.list_id != null && !pjvStatusReg.has(Number(p.list_id))) {
    try {
      const [ld] = await Promise.all([api('/api/ui/v6/project-lists'), pjvLoadStatusTemplates()]); // #729 스페이스 기본도 함께 로드
      pjvSetStatusRegistry((ld && ld.lists) || []);
    } catch (_) { /* 실패 시 네이티브 폴백 */ }
  }
  const members = p.members || [];
  const reload = () => renderProjectV2Detail(view, idStr);

  // 헤더 — 제목(이름+상태칩) 좌 / 액션(완료토글·삭제) 우 한 줄, 설명, 팀원 칩(아래 별도 행). 박스 높이·세로정렬 통일.
  // 뒤로가기 줄 — 여기에 [⚙ 프로젝트 세부 설정]도 함께 태운다(#1233: 제목 옆이 아니라 '← 프로젝트'와 같은 높이).
  //  모달로 뜰 땐 '← 프로젝트'만 숨고(모달엔 자체 닫기가 있다) 이 줄과 설정 버튼은 그대로 남는다.
  const backRow = el('div', { class: 'proj-detail-back' }, backLink);
  const head = el('div', { class: 'page-head' }, backRow);
  // 상태 토글(완료/재개)은 '프로젝트 세부 설정' 팝업으로 이관 — 헤더엔 상태칩만 둔다.
  // 프로젝트 세부 설정 — 우측 액션 슬롯. 상태(완료된 프로젝트로/재개)·규칙(터미널 AI 주입)·연결된 지식 팝업.
  const meId = (state.me && (state.me.userId || state.me.email)) || '';
  // 삭제·팀원 수정은 '프로젝트 세부 설정' 팝업으로 이관 — 헤더 우측 액션은 설정 버튼만(권한 경계는 백엔드 403).
  const settingsBtn = el('button', { class: 'btn btn-sm btn-ghost', text: '⚙ 프로젝트 세부 설정',
    onclick: () => openProjectSettings(id, p, reload, meId, V6_BASE) });
  // '내 컴퓨터에서 작업'은 헤더에서 빼고 터미널 세션의 '＋ 새 세션' 드롭다운으로 이관(내 컴퓨터 / 중앙 컴퓨터 선택) — projectTerminalSection.
  // (코멘트는 헤더 버튼이 아니라 본문↔태스크 사이의 '코멘트' 섹션이 진입점 — projectCommentsSection. 클릭=드로어.)
  // 제목줄 — 이름(클릭해 수정)+상태칩(좌), 세부설정(우).
  const titleEl = el('h1', { class: 'proj-detail-title proj-detail-title-edit', title: '클릭해 이름 수정', text: p.name });
  const editTitle = () => {
    // 인라인 편집 = 제목(h1)과 같은 폰트·위치의 '테두리 없는' 자동확장 textarea(#493). 이름이 길면 잘리지 않고
    //  가로 전체를 쓰고 여러 줄로 늘어난다(입력창 UI 가 어색하던 문제 해소 — 태스크 모달 제목과 동일 결).
    const inp = el('textarea', { class: 'proj-detail-title-input', rows: '1', maxlength: '200', spellcheck: 'false' });
    inp.value = p.name;
    const autoGrow = () => { inp.style.height = 'auto'; inp.style.height = inp.scrollHeight + 'px'; };
    titleEl.replaceWith(inp);
    autoGrow(); inp.focus(); if (inp.select) inp.select();
    inp.addEventListener('input', autoGrow);
    let fin = false;
    const done = async (save) => {
      if (fin) return; fin = true;
      const nv = inp.value.trim().replace(/\s+/g, ' '); inp.replaceWith(titleEl);
      if (save && nv && nv !== p.name) {
        try {
          await api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify({ name: nv }) }); p.name = nv; titleEl.textContent = nv;
          // 이 화면은 새 셸 안에서 **앱 프레임(iframe)** 으로 뜬다 — 셸의 사이드바·탭·문패는 다른 창이라
          //  여기서 고친 이름을 모르고 8초 폴링까지 옛 이름을 들고 있었다(#2579). 한 줄 알려 주면 그 순간 맞춘다.
          //  프레임 밖(단독 페이지)이면 parent === window 라 아무 데도 안 간다 — 해가 없다.
          try { window.parent?.postMessage({ type: 'lively:project-renamed', id: Number(id), name: nv }, location.origin); } catch (_) { /* 부모가 닫혔다 */ }
        }
        catch (e) { toast('이름 수정 실패 — ' + e.message, true); }
      }
    };
    // 한글(IME) 조합 중 Enter 는 조합 확정용 — 조합이 끝난 진짜 Enter 에서만 저장(#293 패턴). Enter=저장(줄바꿈 X), Esc=취소.
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && (e as any).keyCode !== 229) { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    inp.addEventListener('blur', () => done(true));
  };
  titleEl.onclick = editTitle;
  backRow.append(settingsBtn);   // '← 프로젝트'와 같은 줄 우측(#1233)
  head.append(el('div', { class: 'proj-detail-titlebar' },
    // 상태 배지(타이틀 오른쪽) 제거 — 아래 메타행의 상태 필드(클릭해 변경)와 중복이라 그쪽만 남긴다.
    el('div', { class: 'proj-detail-titlebox' }, titleEl)));
  // (본문은 헤더에서 빼고 태스크 위 '본문' 섹션으로 분리 — projectBodySection. 다른 섹션과 동일 위계.)
  // 팀원 칩 행(proj-team-row) 제거 — 아래 메타 패널의 '팀원' 필드와 중복이라 한 곳(메타)만 남긴다.
  // 클릭업식 메타데이터 패널 — 이름 바로 아래(태스크 박스 위). 상태·팀원·기간·우선순위·태그.
  head.append(pjvProjMetaPanel(p, members, reload));

  // 상세 본문 — 태스크(작업 위계)를 헤더 바로 아래 맨 위에 둔다(프로젝트의 핵심). 이어 공유 폴더 ·
  //  터미널 세션 · 작업 타임라인(org #/projects 템플릿과 동형, v6 데이터·라우트). 모든 섹션 v6 API base 연결.
  //  '필요/산출 지식'은 본문 바로 아래 '지식 흐름' 섹션으로 분리(#245) — 세부 설정 팝업에서 이관.
  // 후속/선행 프로젝트는 별도 박스(projectEdgesSection)를 없애고 상단 프로퍼티(pjvProjMetaPanel)로 이관(#359).
  // 본문+코멘트는 한 행으로 묶는다(#1233 — 접혀 있을 땐 본문 5 : 코멘트 2 로 나란히, 본문을 펼치거나 편집하면
  //  본문이 전폭을 쓰고 코멘트는 그 아래로 내려간다). 코멘트가 세로 순서에서 빠지므로 아래 섹션들이 그만큼 올라온다.
  // 터미널 세션 ↔ 공유 폴더 교환(#1233) — 터미널이 실제로 가장 자주 쓰이는데 2화면 아래에 있었다. '하위 태스크보다는
  //  아래'라는 위계는 지키면서 올릴 수 있는 자리가 태스크 바로 다음이다.
  view.replaceChildren(head,
    projectBodyCommentRow(id, p, reload, members),
    projectKnowledgeSection(id, p, reload),
    pjvTasksSection(id, p.tasks || [], members, reload, p.fields || []),
    projectTerminalSection(id, members, meId, V6_BASE, p.name, p),
    projectFolderSection(id, V6_BASE, p.folder),   // #1436 — p.folder = 공유 루트 기준 폴더 경로(공유 링크 좌표)
    projectTimelineSection(id, members, V6_BASE));
  // 인라인 편집 재렌더면 리빌 애니메이션 대신 스크롤 복원(전면 재애니메이션도 '새로고침'처럼 보임) (#358)
  if (keepY != null) pjvRestoreScroll(keepY, keepHost); else applyReveal(Array.from(view.children).slice(1));
}


// ── 세션 기록(#905 C1): 별도 섹션이 공간을 많이 먹어 → 터미널 섹션 헤더의 [📜 세션 기록] 버튼→모달로 이관
//  (openProjectSessionsModal, sessions.ts). 끝난 세션까지 남는 '이력', 인가는 서버(프로젝트 멤버). ──

// _pjvPmOpen 은 detail-meta.ts 의 선행/후속 칩 드릴인이 **읽기 전용**으로 가져간다(live binding — 사본 금지).
export { _pjvPmOpen, pjvCloseProjectModalOnRoute, pjvOpenProjectModal, pjvProjectModalOpen, pjvProjectModalRefreshIfRoute, renderProjectV2Detail };

// ── 상세 계열의 **입구**(#1313 R35) — 배럴(projects.ts)은 이 파일 하나만 물고 형제 셋은 여기서 중계한다.
//  넷을 배럴이 각각 물면 projects→(상세 4모듈)→projects/{rows,columns,fields,selection}→projects 경로가
//  문 수만큼 곱해져 elementary 순환이 배로 늘어난다(실측 105건 → 입구 하나로 좁혀 35건).
//  ⚠ pjvTaskRow 는 재수출 체인(detail-tasks → 여기 → projects.ts)으로만 흐른다. 값 복사 금지 —
//   소유 모듈의 몽키패치 IIFE 2개가 런타임에 교체하는 바인딩이라 사본은 패치 이전 함수를 굳힌다.
export { buildWysiwygToolbar, mdFromDom, mountBodyEditor, uploadBodyFile } from './detail-body.js';
export { companyTimelineSection, copyText, openLocalWorkModal, openProjectSessionForm } from './detail-sections.js';
export { pjvAddTask, pjvRowMore, pjvTaskRow } from './detail-tasks.js';
export { openProjectPreviewModal } from './detail-preview.js';

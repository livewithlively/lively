// dashboard-home.ts — '대시보드' 상위 탭(#/dashboard). 옛 '시작하기' 자리를 개편한 나만의 코크핏(#617).
//  1단계(현재): 3열 고정 프리셋 — 좌(내 프로젝트 + 팀 공유 폴더) · 중(최신 알림 + 내 AI 세션) · 우(팀 작업 로그).
//   풀스크린·페이지 스크롤 없음(body[data-route="dashboard"] 훅) — 넘치는 목록은 위젯 '안에서만' 스크롤.
//   위젯별 독립 로드·독립 실패: 한 위젯의 API 오류가 대시보드 전체를 죽이지 않는다.
//  2단계(예정): 위젯 레지스트리 + 12×12 {x,y,w,h} 편집 모드(추가/제거·드래그·리사이즈·사람별 저장) — 이 프리셋이 기본 배치가 된다.
//  §0.5 채색 예산: 채운 파란 버튼은 화면당 1개([+ 새 세션])뿐. 나머지는 무채 카드 + 작은 상태점·아웃라인 배지.
import { api, el, errorNote, relTime, state, sv, toast } from './core.js';
import { skeleton } from './learn.js';
// 작업 로그 전체 보기 팝업 = 회사 활동 피드 재사용. authUpload/Download·fmtSize = 공유 폴더 브라우저(#672)의 검증된 파일 프리미티브 재사용.
import { authDownload, authUpload, companyTimelineSection, fmtSize, openProjectV2Form } from './projects.js';
import { openTermCreateForm, startTerminalTour } from './terminal.js'; // 세션 생성 팝업·따라하기 투어를 대시보드에서 그대로 재사용(#req)

// 하네스 라벨 폴백(terminal config 의 harnesses 와 동일 키) — cfg 로드 실패 시에도 읽히게.
const DASH_HARNESS_LABEL = { claude: 'Claude Code', codex: 'Codex' };
// 작업 유형 → 점 톤/라벨 — 작업 현황(dashboard.ts ACT_TYPE_TONE)과 동일 매핑(성격축 8종).
const DASH_ACT_TONE = { feature: 'mint', fix: 'coral', decision: 'blue', docs: 'teal', research: 'violet', review: 'amber', chore: 'mut', other: 'mut' };
const DASH_ACT_LABEL = { feature: '기능', fix: '수정', decision: '결정', docs: '문서', research: '리서치', review: '검토', chore: '운영', other: '기타' };
// 최신 알림(⓪) — 프로젝트 필드 변경 이벤트(getTaskFeed event)의 한국어 라벨.
const DASH_FIELD_LABEL = { status: '상태', assignee: '담당', priority: '우선순위', due_date: '마감', start_date: '시작일', name: '이름', description: '내용' };
// 활동 유형 → 알림 동사(주어=사람). 팀 작업 활동을 '~했어요' 문장으로.
const DASH_ACT_VERB = { feature: '기능을 추가했어요', fix: '오류를 고쳤어요', decision: '결정을 남겼어요', docs: '문서를 정리했어요', research: '리서치를 진행했어요', review: '리뷰를 남겼어요', chore: '작업을 처리했어요', other: '작업했어요' };

// ── 최신 알림 사용자화(유형별 on/off) — 전용 알림 백엔드가 없어 대시보드-로컬(localStorage, 기기별). ──
//  카탈로그는 앱 전체 신호를 감사해 '나에 관한 알림'이 될 수 있는 것만 실배선(dead 토글 금지). 사소한 변경(상태·수정·필드)은 기본 off.
const DASH_NOTIF_PREF_KEY = 'dash_notif_prefs_v1';
const DASH_NOTIF_GROUPS = [
  { title: '나에 관한 것', items: [
    { key: 'mention', label: '멘션 (@나)', desc: '댓글에서 나를 언급할 때', on: true },
    { key: 'session_invite', label: 'AI 세션 초대', desc: '나를 초대한 터미널 세션', on: true },
  ] },
  { title: '내 프로젝트', items: [
    { key: 'comment', label: '새 댓글', desc: '내 프로젝트에 달린 댓글', on: true },
    { key: 'activity', label: '팀원 작업', desc: '기능·수정·결정·문서·리서치·리뷰', on: true },
    { key: 'created', label: '새 항목 추가', desc: '태스크·프로젝트가 새로 생김', on: true },
    { key: 'assign', label: '담당자 변경', desc: '담당자가 바뀔 때', on: true },
  ] },
  { title: '사소한 변경', items: [
    { key: 'chore', label: '운영·잡무 처리', desc: 'chore 유형 작업(빌드·정리 등)', on: false },
    { key: 'status', label: '상태 변경', desc: '예: 할 일 → 완료', on: false },
    { key: 'edit', label: '이름·내용 수정', desc: '제목·설명 편집', on: false },
    { key: 'field', label: '기타 필드 변경', desc: '마감·우선순위·시작일 등', on: false },
  ] },
  { title: '일정', items: [
    { key: 'due', label: '마감 임박·지남', desc: '7일 이내 또는 지난 마감', on: true },
  ] },
];
const DASH_NOTIF_DEFAULTS: Record<string, boolean> = (() => {
  const d: Record<string, boolean> = {};
  for (const g of DASH_NOTIF_GROUPS) for (const it of g.items) d[it.key] = it.on;
  return d;
})();
function dashNotifPrefs(): Record<string, boolean> {
  try { return { ...DASH_NOTIF_DEFAULTS, ...(JSON.parse(localStorage.getItem(DASH_NOTIF_PREF_KEY) || '{}') || {}) }; }
  catch { return { ...DASH_NOTIF_DEFAULTS }; }
}
function dashSaveNotifPrefs(p) { try { localStorage.setItem(DASH_NOTIF_PREF_KEY, JSON.stringify(p)); } catch { /* 저장 실패 무시 */ } }
// 필드 변경 이벤트 → 프리셋 유형 키.
function dashFieldPref(field) {
  if (field === 'status') return 'status';
  if (field === 'name' || field === 'description') return 'edit';
  if (field === 'assignee') return 'assign';
  return 'field';
}
// ── 알림 읽음 상태(인박스) — 읽은 알림 key 집합(기기별 localStorage). 피드엔 없는 '읽음/안읽음'이 알림다움의 핵심. ──
const DASH_NOTIF_READ_KEY = 'dash_notif_read_v1';
function dashNotifReadSet(): Set<string> { try { const a = JSON.parse(localStorage.getItem(DASH_NOTIF_READ_KEY) || '[]'); return new Set(Array.isArray(a) ? a : []); } catch { return new Set(); } }
function dashSaveNotifRead(set: Set<string>) { try { localStorage.setItem(DASH_NOTIF_READ_KEY, JSON.stringify([...set].slice(-300))); } catch { /* 저장 실패 무시 */ } }

async function renderMyDashboard(view) {
  // ── 셸 즉시 그리기(각 존은 스켈레톤) → 위젯별 병렬 로드 ──
  const sepEl = el('span', { text: ' · ' });              // 날짜와 요약 사이 구분점(요약 없으면 숨김)
  const summaryEl = el('span', { text: '불러오는 중…' }); // 인사줄 요약(프로젝트·세션 수) — 로드 후 갱신
  const obSlot = el('span');                              // 온보딩 칩 자리(완료면 빈 채로)

  const zoneNotif = dashZone('notif', '최신 알림');
  const zoneProj = dashZone('proj', '내 프로젝트');
  const zoneSess = dashZone('sess', '내 AI 세션');
  const zoneFold = dashZone('fold', '팀 공유 폴더');
  const zoneLog = dashZone('log', '팀 작업 로그');

  // mine=1(내 프로젝트)·리스트는 '내 프로젝트'와 '최신 알림' 두 위젯이 공유 — 한 번만 호출(각자 독립적으로 await·실패처리).
  const projectsP = api('/api/ui/v6/projects?mine=1').then((d) => (d && d.projects) || []);
  const listsP = api('/api/ui/v6/project-lists').then((d) => (d && d.lists) || []).catch(() => []);

  const strip = el('div', { class: 'dash-strip' },
    el('div', {},
      el('div', { class: 'dash-hi', text: greeting() + ', ' + myDisplayName() + '님' }),
      el('div', { class: 'dash-date' }, todayLabel(), sepEl, summaryEl)),
    el('div', { class: 'dash-acts' },
      obSlot,
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/projects2', text: '+ 새 프로젝트' }),
      el('a', { class: 'btn btn-primary btn-sm', href: '#/terminal', text: '+ 새 세션' })));

  // 3열 — 사람이 열 폭을 드래그로 조절(#req, 기기별 저장). 열 사이 핸들 2개 + 반응형(좁으면 세로 스택, CSS가 인라인 grid 무시).
  const colLeft = el('div', { class: 'dash-colleft' }, zoneProj.box, zoneFold.box);
  const colMid = el('div', { class: 'dash-colmid' }, zoneNotif.box, zoneSess.box);
  const colRight = zoneLog.box;
  const zonesEl = el('div', { class: 'dash-zones' }, colLeft, colMid, colRight);
  dashInitColResize(zonesEl);
  // #req R13 — 각 열 두 박스 사이 세로 높이 핸들(내 프로젝트↔팀 공유 폴더 · 최신 알림↔내 AI 세션).
  dashInitRowResize(colLeft, 'dash_rows_left_v1', [5, 1.5], true); // #req 팀 공유 폴더는 기본 auto(내용맞춤·스크롤 없음), 드래그하면 fr 전환
  dashInitRowResize(colMid, 'dash_rows_mid_v1', [5, 7]); // #req 기본: 최신 알림↓·내 AI 세션↑ (이미 조절해 저장한 사람은 유지)
  view.replaceChildren(el('div', { class: 'dash' }, strip, zonesEl));
  document.getElementById('view')!.focus?.();

  // ── 위젯별 독립 로드(실패는 그 존 안에만 errorNote) ──
  const counts: any = { projects: null, sessions: null }; // 인사줄 요약용(null=미집계 — 로드 실패 포함)
  const drawSummary = () => {
    const parts: string[] = [];
    if (counts.projects != null) parts.push('진행 중 프로젝트 ' + counts.projects);
    if (counts.sessions != null) parts.push('실행 중 세션 ' + counts.sessions);
    summaryEl.textContent = parts.join(' · ');
    sepEl.hidden = !parts.length; // 요약이 비면(양쪽 다 실패) 구분점도 숨김 — '날짜 · ' 꼬리 방지
  };
  fillNotifications(zoneNotif, projectsP);
  fillProjects(zoneProj, (n) => { counts.projects = n; drawSummary(); }, projectsP, listsP);
  fillSessions(zoneSess, (n) => { counts.sessions = n; drawSummary(); }, projectsP);
  fillFolders(zoneFold);
  fillActivity(zoneLog);
  fillOnboarding(obSlot);
}

// ── 인사 스트립 조각들 ──
function greeting() {
  const h = new Date().getHours();
  if (h < 5) return '늦은 밤이에요';
  if (h < 11) return '좋은 아침이에요';
  if (h < 17) return '좋은 오후예요';
  if (h < 22) return '좋은 저녁이에요';
  return '늦은 밤이에요';
}
function myDisplayName() {
  const me = state.me || {};
  return me.display_name || String(me.email || me.userId || '').split('@')[0] || '나';
}
function todayLabel() {
  return new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' });
}
// 온보딩 진행 칩 — 미완일 때만 표시(완료·실패면 조용히 생략). 클릭 → #/onboarding.
async function fillOnboarding(slot) {
  try {
    const s = await api('/api/ui/org/onboarding');
    if (!s || s.complete) return;
    slot.replaceChildren(el('a', { class: 'dash-ob', href: '#/onboarding', title: '온보딩 진행상황 보기' },
      el('span', { text: `온보딩 ${s.done}/${s.total}` }),
      el('span', { class: 'dash-ob-bar' }, el('span', { class: 'dash-ob-fill', style: 'width:' + (s.pct || 0) + '%' }))));
  } catch { /* 칩 없이 진행 */ }
}

// ── 존(위젯 카드) 공통 셸 — 헤더(제목·카운트·칩 슬롯·우상단 컨트롤) + 내부 스크롤 목록 ──
//  우상단 컨트롤(ctlEl)은 dashCtl 로 [⚙ 설정]+[액션] 을 채운다 — 5개 존 동일 배치·동일 스타일(#req 통일성).
function dashZone(key, title) {
  const countEl = el('span', { class: 'dash-wh-n' });
  const chipsEl = el('span', { class: 'dash-wh-chips' });
  const ctlEl = el('span', { class: 'dash-wh-ctl' });
  const body = el('div', { class: 'dash-wl' });
  body.append(skeleton('불러오는 중'));
  const box = el('section', { class: 'dash-zone dash-zone--' + key, 'aria-label': title },
    el('div', { class: 'dash-wh' },
      el('h4', { text: title }), countEl, chipsEl, ctlEl),
    body);
  // 칩이 실제로 넘칠 때만 우측 페이드(is-clipped) — 열 폭 리사이즈로 너비 바뀔 때도 재판정(#req '안 넘치면 안 흐리게').
  try { new ResizeObserver(() => dashUpdateChipClip(chipsEl)).observe(chipsEl); } catch { /* 미지원 무시 */ }
  return { box, body, countEl, chipsEl, ctlEl };
}
// 칩 컨테이너가 넘치면 .is-clipped(우측 페이드), 아니면 해제.
function dashUpdateChipClip(chipsEl) {
  if (chipsEl) chipsEl.classList.toggle('is-clipped', chipsEl.scrollWidth - chipsEl.clientWidth > 1);
}
// 위젯 헤더 우상단 통일 컨트롤 — 모든 존 동일: [⚙ 설정](설정 있을 때) + [액션](→ 딥링크 or ⤢ 모달). 둘 다 같은 아이콘버튼(dash-wh-btn).
//  opts = { gear?: {title, open(anchor)}, action?: {title, href? , onClick?} }  — href 있으면 딥링크(→), 없으면 모달 여는 버튼(⤢).
function dashCtl(zone, opts) {
  const ctl = zone.ctlEl; if (!ctl) return;
  const kids: any[] = [];
  if (opts.gear) {
    const g = el('button', { class: 'dash-wh-btn dash-wh-btn-gear', type: 'button', title: opts.gear.title, 'aria-label': opts.gear.title }, dashGearIcon());
    g.onclick = () => opts.gear.open(g);
    kids.push(g);
  }
  const a = opts.action;
  if (a) {
    if (a.href) kids.push(el('a', { class: 'dash-wh-btn dash-wh-btn-go', href: a.href, title: a.title, 'aria-label': a.title }, dashArrowIcon()));
    else { const b = el('button', { class: 'dash-wh-btn dash-wh-btn-go', type: 'button', title: a.title, 'aria-label': a.title }, dashExpandIcon()); b.onclick = a.onClick; kids.push(b); }
  }
  ctl.replaceChildren(...kids);
}
function dashChips(chipsEl, items, activeKey, onPick) {
  chipsEl.replaceChildren(...items.map(([key, label]) => el('button', {
    class: 'dash-chip' + (key === activeKey ? ' on' : ''), type: 'button',
    'aria-pressed': key === activeKey ? 'true' : 'false', text: label,
    onclick: () => { if (key !== activeKey) onPick(key); },
  })));
  dashUpdateChipClip(chipsEl); // 렌더 직후 넘침 판정(칩 수 변동 반영)
}
function dashEmpty(text) { return el('div', { class: 'dash-empty', text }); }

// ── ① 내 프로젝트 — mine=1(생성자 OR 팀원)를 '리스트 블럭(개요 카드)'으로(#622). ──
//  프로젝트 탭 폴더 개요(pjv-overview)와 동일한 카드 UI: 리스트별 블럭에 글리프·이름 · 'N개 프로젝트' · 상태 미니바.
//  블럭을 누르면 그 리스트로 진입(#/projects2/l/<id>) — 기존 프로젝트 탭에서 그 안의 프로젝트가 그대로 보인다.
async function fillProjects(zone, onCount, projectsP, listsP) {
  let projects, lists;
  try { [projects, lists] = await Promise.all([projectsP, listsP]); }
  catch (e) { onCount(null); zone.body.replaceChildren(errorNote(e, '내 프로젝트를 불러오지 못했습니다')); return; }

  const isDone = (p) => p.status === 'done' || p.status_category === 'done' || p.status_category === 'closed';
  onCount(projects.filter((p) => !isDone(p)).length);
  const listById = new Map<number, any>(lists.map((l) => [l.id, l]));
  // 상태 묶음(개요 미니바) — 프로젝트 탭 개요의 brk 와 동일 3버킷(할일·진행·완료).
  const brk = (arr) => ({ total: arr.length, done: arr.filter(isDone).length,
    prog: arr.filter((p) => !isDone(p) && p.status !== 'todo').length, todo: arr.filter((p) => p.status === 'todo').length });
  // 프로젝트 행 — 프로젝트 탭 리스트 행(pjv-trow-title-cell)과 동일 UI: 상태 아이콘(진행도 파이/체크) + 이름 + 태스크 수 + 세션 배지 + 태그.
  //  좁은 대시보드 폭이라 프로젝트 탭 표의 나머지 열(담당·마감·날짜·우선순위 등)은 생략하고 제목 셀만 그대로 차용. 클릭→프로젝트 상세.
  const dashProjRow = (p) => {
    const cell = el('div', { class: 'pjv-trow-title-cell' },
      // 상태 동그라미 = 클릭 시 상태 변경 메뉴(프로젝트 탭 pjvProjStatusDot 과 동일 동작, #req). 행 링크로 전파 안 되게 preventDefault.
      dashProjStatusControl(p, listById, () => draw()),
      el('span', { class: 'pjv-trow-title clickable' + (isDone(p) ? ' done' : ''), title: p.name, text: p.name }));
    // 하위태스크 아이콘 = 클릭 시 그 프로젝트의 태스크 목록 팝오버(#req). 표시 방식(진행중만/전체/완료·전체)은 ⚙ 개인화(#req).
    const chip = dashTaskChip(p);
    if (chip) {
      const tb = el('span', { class: 'pjv-trow-subcount pjv-subcount-ico dash-rowchip', role: 'button', tabindex: '0', title: chip.title + ' — 눌러서 보기' },
        dashSubtaskIcon(), el('span', { text: chip.text }));
      const openT = (e: any) => { e.preventDefault(); e.stopPropagation(); openProjTasksPopover(tb, p, reloadAll); };
      tb.addEventListener('click', openT);
      tb.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') openT(e); });
      cell.append(tb);
    }
    // 세션 배지 = 클릭 시 들어갈 세션 선택(#req) — 1개면 바로 열기, 여러 개면 팝아웃 선택.
    if (p.my_session_count) {
      const sb = el('span', { class: 'dash-badge dash-rowchip', role: 'button', tabindex: '0', title: '내 세션 ' + p.my_session_count + '개 — 들어갈 세션 선택', text: '세션 ' + p.my_session_count });
      const openS = (e: any) => { e.preventDefault(); e.stopPropagation(); openProjSessionsPicker(sb, p); };
      sb.addEventListener('click', openS);
      sb.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') openS(e); });
      cell.append(sb);
    }
    const tags = dashRowTags(p); if (tags) cell.append(tags);
    // #req 행 맨 뒤 '⋯' — 호버 시 노출, 삭제 등 관리 메뉴. 행 링크로 전파 안 되게 격리.
    const more = el('button', { class: 'dash-projrow-more', type: 'button', title: '프로젝트 관리', 'aria-label': '프로젝트 관리', text: '⋯' });
    more.addEventListener('click', (e: any) => { e.preventDefault(); e.stopPropagation(); openProjRowMenu(more, p, reloadAll); });
    return el('a', { class: 'dash-projrow2', href: '#/projects2/p/' + p.id }, cell, more);
  };
  // 리스트 그룹 — 프로젝트 탭 리스트 헤더(pjv-list-head: 캐럿·글리프·이름·개수, 접기/펼치기) + 행들. 미분류는 색점.
  // #req R19 — 목록 맨 밑 인라인 '+ 새 프로젝트'. 프로젝트 탭 보드 추가행(pjvProjAddRow)과 동일 클래스·톤(테두리 없는 인라인 입력).
  //  트리거(＋ 프로젝트) → 클릭 시 제목 셀(체크박스 자리·캐럿 자리·상태점 + 입력)로 펼침. Enter=생성 후 상세로, Esc=접기.
  const dashInlineAdd = (listId) => {
    const row = el('div', { class: 'pjv-addrow dash-addrow' });
    // 대시보드 프로젝트 행(dashProjRow)은 상태아이콘이 셀 맨앞(체크박스·캐럿 자리 없음) — 추가행도 동일하게 spacer/caret 없이 맞춰 ＋가 상태점과 같은 들여쓰기에 오게(#670).
    const trigger = el('button', { class: 'pjv-addrow-trigger', type: 'button' },
      el('span', { class: 'pjv-addrow-plus', text: '＋' }), el('span', { text: '프로젝트' }));
    const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '프로젝트 이름 입력 후 Enter (Esc 취소)', maxlength: '200', spellcheck: 'false', autocomplete: 'off' });
    const collapse = () => { row.classList.remove('editing'); row.replaceChildren(trigger); };
    // Enter — 프로젝트 탭과 동일한 설정 팝업(openProjectV2Form)로 이어감(#670). 이름 프리필 + 소속 리스트 프리필.
    //  stay:true → 생성 후 상세페이지로 튀지 않고(예전엔 #/projects2/p/id 로 이동 = '완전 새로운 창') 그 자리 대시보드 목록만 갱신 → 새 프로젝트가 목록 맨 아래에 자연스럽게.
    const submit = () => {
      const name = (input.value || '').trim();
      if (!name) { collapse(); return; }
      openProjectV2Form(reloadAll, { name, listId: listId || null, stay: true });
      collapse(); // 팝업이 흐름을 이어받으니 인라인 행은 접어 정리(reloadAll 이 어차피 다시 그림)
    };
    const expand = () => {
      row.classList.add('editing');
      row.replaceChildren(el('div', { class: 'pjv-trow-title-cell' },
        dashStatusIconSvg('active', '#94a3b8', 0), input));
      input.focus();
    };
    // 한글(IME) 조합 중 Enter 는 글자 확정용 — 그때 커밋하면 마지막 글자가 중복된 이름이 된다(프로젝트 탭 pjvProjAddRow 동형 가드).
    input.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' && !e.isComposing && (e as any).keyCode !== 229) { e.preventDefault(); submit(); } else if (e.key === 'Escape') { e.preventDefault(); collapse(); } });
    input.addEventListener('blur', () => { if (!(input.value || '').trim()) collapse(); });
    trigger.onclick = expand;
    collapse();
    return row;
  };
  const dashProjGroup = (listId, l, arr) => {
    const isUn = !listId;
    const body = el('div', { class: 'pjv-tgroup-body' });
    for (const p of arr) body.append(dashProjRow(p));
    body.append(dashInlineAdd(listId)); // 맨 밑 인라인 추가행
    let open = true;
    const caret = el('button', { class: 'pjv-tgroup-caret', type: 'button', text: '▾', 'aria-expanded': 'true' });
    const setOpen = (o) => { open = o; caret.textContent = o ? '▾' : '▸'; caret.setAttribute('aria-expanded', String(o)); body.hidden = !o; };
    caret.onclick = (e) => { e.stopPropagation(); setOpen(!open); };
    const dot = isUn
      ? el('span', { class: 'pjv-list-dot', style: 'background:' + ((l && l.color) || 'var(--muted-3)'), 'aria-hidden': 'true' })
      : el('span', { class: 'pjv-list-headglyph', 'aria-hidden': 'true' }, dashListGlyph(l));
    const head = el('div', { class: 'pjv-tgroup-head pjv-list-head' + (isUn ? ' pjv-list-head-un' : '') },
      el('div', { class: 'pjv-list-head-main' }, caret, dot,
        el('span', { class: 'pjv-tgroup-label', text: (l && l.name) || '미분류' }),
        el('span', { class: 'pjv-tgroup-count', text: String(arr.length) })));
    head.addEventListener('click', (e: any) => { if (e.target.closest('button')) return; setOpen(!open); });
    return el('div', { class: 'pjv-tgroup pjv-list-group' }, head, body);
  };

  // 리스트 블럭 카드 — pjv-overview 의 ovCard 와 동일 마크업. 클릭=이 리스트 '선택'(아래 목록을 그 리스트만으로 필터),
  //  드래그=개요 순서 변경(대시보드-로컬 저장). 선택된 카드는 강조(파란 링).
  let dragListId: any = null;
  const projBlock = (listId, l, arr) => {
    const b = brk(arr);
    const name = (l && l.name) || '미분류';
    const card = el('div', { class: 'pjv-ov-card dash-ov-card2' + (listId === selectedListId ? ' selected' : ''),
      role: 'button', tabindex: '0', title: name, draggable: 'true', 'data-list-id': String(listId) },
      el('div', { class: 'pjv-ov-card-head' }, dashListGlyph(l),
        el('span', { class: 'pjv-ov-card-name', text: name })),
      el('div', { class: 'pjv-ov-card-count', text: b.total + '개 프로젝트' }));
    const bar = el('div', { class: 'pjv-ov-bar' });
    const seg = (n, cls) => { if (n > 0) { const s = el('span', { class: 'pjv-ov-bar-seg ' + cls }); s.style.flex = String(n); bar.append(s); } };
    if (b.total) { seg(b.todo, 'todo'); seg(b.prog, 'prog'); seg(b.done, 'done'); } else bar.append(el('span', { class: 'pjv-ov-bar-seg empty' }));
    card.append(bar);
    // 개요 카드 클릭 = 선택(아래 목록을 그 리스트만으로 필터). 팝업은 중복이라 제거(#670) — 아래 dash-projlist 가 이미 선택 리스트를 그대로 보여줌.
    const pick = () => { if (selectedListId !== listId) { selectedListId = listId; draw(); } };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    // 드래그 순서 변경 — 대시보드-로컬(localStorage) 저장, 프로젝트 탭 리스트 순서와는 독립.
    //  커서가 카드 좌/우 절반 어디냐로 '앞/뒤' 삽입을 정하고, 삽입 지점(카드 사이 간격)에 세로 디바이더
    //  (.drop-before::before / .drop-after::after)를 띄워 '어디로 들어가는지'를 명확히 보여준다(맨 끝 삽입도 가능).
    const clearDrop = () => card.classList.remove('drop-before', 'drop-after');
    card.addEventListener('dragstart', (e: any) => { dragListId = listId; try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(listId)); } catch { /* */ } card.classList.add('drag-src'); });
    card.addEventListener('dragend', () => { dragListId = null; card.classList.remove('drag-src'); document.querySelectorAll('.dash-ov-card2.drop-before, .dash-ov-card2.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after')); });
    card.addEventListener('dragover', (e: any) => {
      if (dragListId == null || dragListId === listId) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      const after = (e.clientX - r.left) > r.width / 2; // 오른쪽 절반이면 이 카드 '뒤'로
      card.classList.toggle('drop-after', after);
      card.classList.toggle('drop-before', !after);
    });
    card.addEventListener('dragleave', clearDrop);
    card.addEventListener('drop', (e: any) => {
      e.preventDefault();
      const after = card.classList.contains('drop-after');
      clearDrop();
      if (dragListId == null || dragListId === listId) return;
      dashReorderList(currentOrder, dragListId, listId, after); draw();
    });
    // 이 개요 카드 숨기기(#671) — hover ✕. 기기별 저장·즉시 재렌더. 카드 선택/드래그로 새지 않게 이벤트 격리.
    const hideBtn = el('button', { class: 'dash-ov-hide', type: 'button', title: '이 카드 숨기기', 'aria-label': name + ' 개요 카드 숨기기', text: '✕' });
    hideBtn.addEventListener('mousedown', (e: any) => e.stopPropagation()); // 드래그 시작 방지
    hideBtn.addEventListener('click', (e: any) => { e.stopPropagation(); e.preventDefault(); const h = dashOvHidden(); h.add(Number(listId)); dashSaveOvHidden(h); draw(); });
    card.append(hideBtn);
    return card;
  };

  let mode = dashProjFilterDefault(); // 진행 중 | 전체 — 완료 프로젝트 포함 여부(기본값 ⚙ 개인화).
  let selectedListId: any;      // 선택된 리스트(아래 목록 필터). 기본=첫 리스트.
  let currentOrder: any[] = []; // 현재 표시 중인 리스트 순서(드래그 재정렬 기준).
  const draw = () => {
    const shown = mode === 'active' ? projects.filter((p) => !isDone(p)) : projects;
    zone.countEl.textContent = String(shown.length);
    dashChips(zone.chipsEl, [['active', '진행 중'], ['all', '전체']], mode, (k) => { mode = k; draw(); });
    if (!shown.length) { zone.body.replaceChildren(dashEmpty(mode === 'active' ? '진행 중인 내 프로젝트가 없어요.' : '내가 참여한 프로젝트가 없어요.')); return; }
    // 리스트별 묶음, 미분류(list_id 없음)는 맨 뒤 → 저장된 개요 순서 적용.
    const byList = new Map();
    for (const p of shown) { const k = p.list_id || 0; if (!byList.has(k)) byList.set(k, []); byList.get(k).push(p); }
    const base = [...lists.map((l) => l.id), ...(byList.has(0) ? [0] : [])]; // #req 프로젝트 없는(새로 추가한) 리스트도 개요에 노출
    currentOrder = dashApplyListOrder(base);
    // 숨긴 개요 카드 제외(#671). 선택된 리스트가 숨겨졌거나 사라졌으면 보이는 첫 카드로 폴백.
    const hiddenOv = dashOvHidden();
    const hideEmpty = dashHideEmptyLists(); // #req 빈 리스트(프로젝트 0개) 개요 카드 숨김 옵션
    const visibleOrder = currentOrder.filter((id) => !hiddenOv.has(Number(id)) && !(hideEmpty && !byList.has(id)));
    if (selectedListId === undefined || !byList.has(selectedListId) || hiddenOv.has(Number(selectedListId))) {
      selectedListId = visibleOrder.length ? visibleOrder[0] : currentOrder[0];
    }
    let gridEl;
    if (visibleOrder.length) {
      gridEl = el('div', { class: 'pjv-ov-grid dash-ov-grid' });
      for (const listId of visibleOrder) gridEl.append(projBlock(listId, listById.get(listId), byList.get(listId) || []));
      gridEl.append(dashListAddCard()); // #req R20 — 개요 맨 끝 '+ 새 리스트'
    } else {
      // 전부 숨김 — 그리드 대신 복원 힌트(선택된 리스트 목록은 아래에 그대로 유지).
      gridEl = el('div', { class: 'dash-ov-allhidden' },
        el('span', { text: '개요 카드를 모두 숨겼어요.' }),
        el('button', { class: 'dash-ov-restore', type: 'button', text: '다시 표시', onclick: () => { dashSaveOvHidden(new Set()); draw(); } }));
    }
    // 선택된 리스트의 프로젝트만 — 프로젝트 탭과 동일한 리스트 그룹(헤더+행). 강조된 카드가 곧 선택 표시.
    //  생성순(id 오름차순) — 새로 만든 프로젝트가 목록 '맨 아래'(추가행 바로 위)에 자연스럽게 붙게(#670). 예전 updated_at 내림차순은 새 프로젝트를 맨 위로 튀게 했음.
    const arr = (byList.get(selectedListId) || []).slice().sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    // #req R11.1/R19 — '+ 새 프로젝트'는 리스트 그룹 맨 밑 인라인 행(dashInlineAdd)으로 이동(프로젝트 탭과 동일).
    const listEl = el('div', { class: 'dash-projlist' }, dashProjGroup(selectedListId, listById.get(selectedListId), arr));
    zone.body.replaceChildren(gridEl, listEl);
  };
  // 프로젝트 변경(생성·삭제·이동·상태) 후 위젯 새로고침 — 최신 mine=1 재요청 후 재렌더.
  const reloadAll = async () => {
    try {
      const [pd, ld] = await Promise.all([
        api('/api/ui/v6/projects?mine=1').then((d) => (d && d.projects) || []),
        api('/api/ui/v6/project-lists').then((d) => (d && d.lists) || lists).catch(() => lists),
      ]);
      projects = pd; lists = ld;
      listById.clear(); for (const l of lists) listById.set(l.id, l); // 리스트 추가/변경 반영(같은 Map 참조 유지)
      onCount(projects.filter((p) => !isDone(p)).length);
    } catch { /* 실패 시 기존 데이터 유지 */ }
    draw();
  };
  // #req R20 — 개요 그리드 맨 끝 '+ 새 리스트' 카드: 클릭→그 자리 입력, Enter→리스트 생성(POST /project-lists) 후 새로고침.
  const dashListAddCard = () => {
    const card = el('div', { class: 'pjv-ov-card dash-ov-addcard', role: 'button', tabindex: '0', title: '새 리스트 추가' });
    const showBtn = () => card.replaceChildren(el('span', { class: 'dash-ov-add-plus', text: '+' }), el('span', { class: 'dash-ov-add-lbl', text: '새 리스트' }));
    const showInput = () => {
      let busy = false;
      const input = el('input', { class: 'dash-ov-add-input', type: 'text', placeholder: '리스트 이름 후 Enter', 'aria-label': '새 리스트 이름' });
      const submit = async () => {
        const name = (input.value || '').trim();
        if (busy) return;
        if (!name) { showBtn(); return; }
        busy = true; input.disabled = true;
        try { await api('/api/ui/v6/project-lists', { method: 'POST', body: JSON.stringify({ name }) }); toast('리스트를 추가했어요'); await reloadAll(); }
        catch (e: any) { toast('실패 — ' + (e && e.message || e), true); busy = false; input.disabled = false; input.focus(); }
      };
      input.addEventListener('keydown', (e: any) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } else if (e.key === 'Escape') { e.preventDefault(); showBtn(); } });
      input.addEventListener('blur', () => { if (!busy && !(input.value || '').trim()) showBtn(); });
      card.replaceChildren(input); input.focus();
    };
    card.addEventListener('click', (e: any) => { if (e.target.closest('input')) return; showInput(); });
    card.addEventListener('keydown', (e: any) => { if ((e.key === 'Enter' || e.key === ' ') && !card.querySelector('input')) { e.preventDefault(); showInput(); } });
    showBtn();
    return card;
  };
  // 헤더 ⚙ — 내 프로젝트 위젯 개인화 팝오버(#req): 태스크 수 표시 · 기본 필터 · 빈 리스트 숨김 · 개요 카드 표시/숨김.
  const openOvPrefs = (anchor) => {
    const panel = el('div', { class: 'dash-pop-panel' });
    panel.append(el('div', { class: 'dash-pop-head' },
      el('strong', { text: '내 프로젝트 설정' }),
      el('span', { class: 'dash-pop-sub', text: '이 기기에 저장돼요' })));
    // 세그먼트(라디오) 한 줄 — 선택 시 저장·재렌더·팝오버 갱신.
    const seg = (title, options, cur, onPick) => {
      panel.append(el('div', { class: 'dash-pop-gh', text: title }));
      const rowEl = el('div', { class: 'dash-pop-seg' });
      for (const [k, label] of options) {
        const b = el('button', { class: 'dash-pop-segbtn' + (k === cur ? ' on' : ''), type: 'button', text: label });
        b.onclick = () => { onPick(k); draw(); openOvPrefs(anchor); };
        rowEl.append(b);
      }
      panel.append(rowEl);
    };
    seg('태스크 수 표시', [['active', '진행 중만'], ['all', '전체'], ['progress', '완료·전체']], dashTaskCountMode(), (k) => dashSaveTaskCountMode(k));
    seg('기본 상태 필터', [['active', '진행 중'], ['all', '전체']], dashProjFilterDefault(), (k) => { dashSaveProjFilterDefault(k); mode = k; });
    // 빈 리스트 숨김 + 리스트별 개요 표시/숨김.
    panel.append(el('div', { class: 'dash-pop-gh', text: '개요 카드' }));
    const heCb = el('input', { type: 'checkbox' }); heCb.checked = dashHideEmptyLists();
    heCb.onchange = () => { dashSaveHideEmptyLists(heCb.checked); draw(); };
    panel.append(el('label', { class: 'dash-pop-row' }, heCb, el('span', { class: 'dash-pop-txt' }, el('span', { class: 'dash-pop-name', text: '빈 리스트(프로젝트 0개) 숨기기' }))));
    const hidden = dashOvHidden();
    if (!currentOrder.length) panel.append(el('div', { class: 'dash-pop-row', style: 'cursor:default' }, el('span', { class: 'dash-pop-desc', text: '표시할 리스트가 없어요.' })));
    for (const id of currentOrder) {
      const l = listById.get(id);
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !hidden.has(Number(id));
      cb.onchange = () => { const h = dashOvHidden(); if (cb.checked) h.delete(Number(id)); else h.add(Number(id)); dashSaveOvHidden(h); draw(); };
      panel.append(el('label', { class: 'dash-pop-row' }, cb,
        el('span', { class: 'dash-pop-txt' }, el('span', { class: 'dash-pop-name', text: (l && l.name) || '미분류' }))));
    }
    if (currentOrder.length) {
      const resetBtn = el('button', { class: 'dash-pop-reset', type: 'button', text: '개요 모두 표시' });
      resetBtn.onclick = () => { dashSaveOvHidden(new Set()); draw(); openOvPrefs(anchor); };
      panel.append(el('div', { class: 'dash-pop-foot' }, resetBtn));
    }
    dashPopover(anchor, panel);
  };
  dashCtl(zone, { gear: { title: '내 프로젝트 설정', open: openOvPrefs }, action: { href: '#/projects2', title: '프로젝트 탭으로' } });
  draw();
}
// 리스트 글리프 — 프로젝트 탭 사이드바(pjvListGlyph)와 동일: 이모지 아이콘 or 체크리스트 라인 아이콘.
function dashListGlyph(list) {
  const emoji = list && list.settings && list.settings.icon;
  if (emoji) return el('span', { class: 'pjv-side-listemoji', text: String(emoji) });
  const color = (list && list.color) || 'var(--muted-2)';
  const n = sv('svg', { class: 'pjv-side-listglyph', viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M4 7l1.6 1.6L8.4 5.6' }), sv('path', { d: 'M11 7h9' }),
    sv('path', { d: 'M4 15l1.6 1.6L8.4 13.6' }), sv('path', { d: 'M11 15h9' }));
  return n;
}
// ── 프로젝트 상태 아이콘(프로젝트 탭과 동일) — projects.ts 를 건드리지 않고 소형 동형 함수로 인라인(#619 재사용 원칙). ──
// 리스트 커스텀 상태 정의 정규화 + Active 버킷 진행도(frac) — pjvListStatusDefs/pjvAssignFracs 동형.
function dashListStatusDefs(list) {
  const s = list && list.settings;
  let defs;
  if (s && s.statusMode === 'custom' && Array.isArray(s.statuses) && s.statuses.length) {
    defs = s.statuses.filter((x) => x && x.key).map((x) => ({
      key: String(x.key), label: String(x.label || x.key), color: x.color || '#94a3b8',
      category: (x.category === 'done' || x.category === 'closed') ? x.category : 'active',
    }));
  } else {
    defs = [
      { key: 'todo', label: '할 일', color: '#94a3b8', category: 'active' },
      { key: 'active', label: '진행 중', color: '#f59e0b', category: 'active' },
      { key: 'done', label: '완료', color: '#22c55e', category: 'done' },
    ];
  }
  const act = defs.filter((d) => d.category === 'active');
  act.forEach((d, i) => { (d as any).frac = act.length > 0 ? i / act.length : 0; });
  return defs;
}
// 프로젝트 → 상태 def 해석 — status_raw 우선, 미스매치는 네이티브 status 로 흡수(pjvResolveProjStatus 동형).
function dashResolveStatus(p, defs) {
  const rawKey = p.status_raw || p.status;
  let d = defs.find((x) => x.key === rawKey);
  if (!d) {
    if (p.status === 'done') d = defs.find((x) => x.category === 'done') || defs.find((x) => x.category === 'closed');
    else d = defs.find((x) => x.category === 'active');
  }
  return d || defs[0];
}
// 상태 아이콘(SVG) — pjvStatusIcon 동형: Active=진행도 파이(frac=0→점선 빈 링='할일') · Done=색 링+체크 · Closed=꽉 찬 원+흰 체크.
function dashStatusIconSvg(category, color, frac?) {
  const c = color || 'var(--muted-3)';
  const R = 9, cx = 12, cy = 12;
  const svg = sv('svg', { class: 'pjv-status-ic', viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' });
  if (category === 'done' || category === 'closed') {
    const filled = category === 'closed';
    svg.append(sv('circle', { cx, cy, r: R, 'stroke-width': 2, style: 'fill:' + (filled ? c : 'none') + ';stroke:' + c }));
    svg.append(sv('path', { d: 'M7.7 12.3l2.7 2.7 5.9-6.2', 'stroke-width': 2.1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', style: 'fill:none;stroke:' + (filled ? '#fff' : c) }));
    return svg;
  }
  const f = Math.max(0, Math.min(0.995, frac || 0));
  if (f < 0.001) {
    svg.append(sv('circle', { cx, cy, r: R, 'stroke-width': 2, 'stroke-dasharray': '2.2 2.4', style: 'fill:none;stroke:' + c }));
  } else {
    svg.append(sv('circle', { cx, cy, r: R, 'stroke-width': 2, opacity: 0.3, style: 'fill:none;stroke:' + c }));
    const th = f * 2 * Math.PI;
    const ex = (cx + R * Math.sin(th)).toFixed(2), ey = (cy - R * Math.cos(th)).toFixed(2);
    const large = f > 0.5 ? 1 : 0;
    svg.append(sv('path', { d: 'M' + cx + ' ' + cy + 'L' + cx + ' ' + (cy - R) + 'A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + ex + ' ' + ey + 'Z', style: 'fill:' + c }));
  }
  return svg;
}
// 프로젝트 → 상태 아이콘. 리스트 커스텀 상태(있으면) 반영, 없으면 표준 3단계(pjvStatusIconStd 동형).
function dashProjStatusIcon(p, listById) {
  const l = p.list_id != null ? listById.get(p.list_id) : null;
  const s = l && l.settings;
  if (s && s.statusMode === 'custom' && Array.isArray(s.statuses) && s.statuses.length) {
    const def: any = dashResolveStatus(p, dashListStatusDefs(l));
    return dashStatusIconSvg(def.category, def.color, def.frac);
  }
  // 기본 3단계 색 — 프로젝트 탭 PJV_DEFAULT_STATUS_DEFS(상태 편집 창)와 동일 가족(#667): 회색 할일·주황 진행·초록 완료.
  if (p.status === 'done') return dashStatusIconSvg('done', '#22c55e');
  if (p.status === 'todo') return dashStatusIconSvg('active', '#94a3b8', 0);
  return dashStatusIconSvg('active', '#f59e0b', 0.5);
}
// ── 상태 변경(#req) — 대시보드 프로젝트 행에서 상태 동그라미 클릭 → 상태 메뉴. 프로젝트 탭 pjvProjStatusDot 동형(projects.ts 무수정, 인라인). ──
//  커스텀 상태 리스트면 그 상태들을(Active/Done/Closed 그룹), 아니면 표준 3단계(할 일·진행 중·완료). 선택 시 /status POST + 로컬 반영 + 재렌더.
// ⚠ 색은 dashProjStatusIcon 의 네이티브 폴백(#94a3b8 할일·#f59e0b 진행·#22c55e 완료)과 반드시 일치시킨다 —
//  행 아이콘과 팝아웃 메뉴가 같은 상태를 다른 색으로 보이던 버그(#req: '주황 아이콘 → 파랑 팝아웃') 원인이었다.
const DASH_NATIVE_STATUS = [
  { key: 'todo', label: '할 일', icon: () => dashStatusIconSvg('active', '#94a3b8', 0) },
  { key: 'in_progress', label: '진행 중', icon: () => dashStatusIconSvg('active', '#f59e0b', 0.5) },
  { key: 'done', label: '완료', icon: () => dashStatusIconSvg('done', '#22c55e') },
];
async function dashSetProjStatus(p, patch, redraw) {
  try {
    await api('/api/ui/v6/projects/' + p.id + '/status', { method: 'POST', body: JSON.stringify(patch) });
    p.status = patch.status;
    if ('status_raw' in patch) p.status_raw = patch.status_raw;
    toast(patch.status === 'done' ? '완료로 옮겼습니다' : '상태를 변경했습니다');
    redraw();
  } catch (e: any) { toast('실패 — ' + (e && e.message || e), true); }
}
function dashProjStatusControl(p, listById, redraw) {
  const l = p.list_id != null ? listById.get(p.list_id) : null;
  const s = l && l.settings;
  const custom = !!(s && s.statusMode === 'custom' && Array.isArray(s.statuses) && s.statuses.length);
  const btn = el('button', { class: 'dash-projstatus-btn', type: 'button', title: '상태 변경', 'aria-label': '상태 변경' }, dashProjStatusIcon(p, listById));
  btn.addEventListener('click', (e: any) => {
    e.preventDefault(); e.stopPropagation(); // 행 앵커(프로젝트 상세)로 전파 막기 — 메뉴만 연다.
    const menu = el('div', { class: 'pjv-menu dash-statusmenu' }); // dash-statusmenu = 카드 배경(기존 dashPopover 는 .dash-pop=위치만 부여)
    const close = dashPopover(btn, menu);
    if (custom) {
      const defs = dashListStatusDefs(l);
      const cur: any = dashResolveStatus(p, defs);
      for (const catKey of ['active', 'done', 'closed']) {
        for (const d of defs.filter((x) => x.category === catKey)) {
          const isCur = d.key === (cur && cur.key);
          const item = el('button', { class: 'pjv-menu-item' + (isCur ? ' sel' : ''), type: 'button' },
            dashStatusIconSvg(d.category, d.color, (d as any).frac), el('span', { text: d.label }));
          item.onclick = () => { close(); if (!isCur) dashSetProjStatus(p, { status: (d.category === 'done' || d.category === 'closed') ? 'done' : 'in_progress', status_raw: d.key }, redraw); };
          menu.append(item);
        }
      }
    } else {
      const curKey = p.status || 'todo';
      for (const st of DASH_NATIVE_STATUS) {
        const isCur = curKey === st.key;
        const item = el('button', { class: 'pjv-menu-item' + (isCur ? ' sel' : ''), type: 'button' }, st.icon(), el('span', { text: st.label }));
        item.onclick = () => { close(); if (!isCur) dashSetProjStatus(p, { status: st.key }, redraw); };
        menu.append(item);
      }
    }
  });
  return btn;
}
// 하위 태스크 아이콘 — 프로젝트 탭 pjvSubtaskIcon 동형(서브카운트 배지 안).
function dashSubtaskIcon() {
  const n = sv('svg', { class: 'pjv-subtask-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 7, cy: 6, r: 2.2 }), sv('circle', { cx: 17, cy: 17, r: 2.2 }), sv('path', { d: 'M7 8.2v5.6a2.6 2.6 0 0 0 2.6 2.6H14.6' }));
  return n;
}
// 프로젝트 태그 칩(비인터랙티브) — 프로젝트 탭 pjvRowTagsEl 와 동일 마크업, 최대 2 + "+N".
function dashRowTags(p) {
  const cur = (p.tags || []);
  if (!cur.length) return null;
  const wrap = el('span', { class: 'pjv-trow-tags' });
  for (const tg of cur.slice(0, 2)) wrap.append(el('span', { class: 'pjv-trow-tag', style: '--tag:' + (tg.color || 'var(--muted)'), title: tg.name },
    el('span', { class: 'pjv-trow-tag-name', text: tg.name })));
  if (cur.length > 2) wrap.append(el('span', { class: 'pjv-trow-tag-more', text: '+' + (cur.length - 2) }));
  return wrap;
}
// ── 개요 리스트 순서(드래그) — 대시보드-로컬(localStorage). 프로젝트 탭의 리스트 순서와는 독립. ──
const DASH_LIST_ORDER_KEY = 'dash_list_order_v1';
function dashListOrderSaved(): any[] { try { const a = JSON.parse(localStorage.getItem(DASH_LIST_ORDER_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
function dashSaveListOrder(order) { try { localStorage.setItem(DASH_LIST_ORDER_KEY, JSON.stringify(order)); } catch { /* 저장 실패 무시 */ } }
// 저장된 순서를 현재 리스트 집합(base)에 적용 — 저장분 먼저(그 순서대로), 새 리스트는 뒤에.
function dashApplyListOrder(base) {
  const saved = dashListOrderSaved();
  const head = saved.filter((id) => base.includes(id));
  const tail = base.filter((id) => !head.includes(id));
  return [...head, ...tail];
}
// dragId 를 targetId 앞(after=false)/뒤(after=true)로 이동 → 저장(현재 화면 밖 리스트 순서도 보존해 병합).
function dashReorderList(order, dragId, targetId, after?) {
  const arr = order.filter((id) => id !== dragId);
  const ti = arr.indexOf(targetId);
  const at = ti < 0 ? arr.length : ti + (after ? 1 : 0);
  arr.splice(at, 0, dragId);
  const saved = dashListOrderSaved();
  dashSaveListOrder([...arr, ...saved.filter((id) => !arr.includes(id))]);
}
// ── 개요 카드 표시/숨김(사용자화, #671) — 숨긴 리스트 id 집합을 대시보드-로컬(localStorage, 기기별)에 저장. ──
//  미분류(id 0)까지 개별 토글. 헤더 ⚙ 팝오버 체크박스 + 카드 hover ✕ 두 경로로 조작한다(리스트 순서와는 독립).
const DASH_OV_HIDDEN_KEY = 'dash_ov_hidden_v1';
function dashOvHidden(): Set<number> {
  try { const a = JSON.parse(localStorage.getItem(DASH_OV_HIDDEN_KEY) || '[]'); return new Set(Array.isArray(a) ? a.map(Number) : []); }
  catch { return new Set(); }
}
function dashSaveOvHidden(set: Set<number>) { try { localStorage.setItem(DASH_OV_HIDDEN_KEY, JSON.stringify([...set])); } catch { /* 저장 실패 무시 */ } }
// ── #req 내 프로젝트 위젯 개인화(기기별) — 태스크 수 표시 방식 · 기본 상태 필터 · 빈 리스트 숨김. ⚙ 팝오버에서 선택. ──
const DASH_TASKCOUNT_KEY = 'dash_taskcount_v1';   // 'active'(진행 중만·기본) | 'all'(전체) | 'progress'(완료/전체)
const DASH_PROJFILTER_KEY = 'dash_projfilter_v1'; // 'active'(진행 중·기본) | 'all'(전체) — 첫 진입 기본 필터
const DASH_HIDEEMPTY_KEY = 'dash_hide_empty_lists_v1'; // '1' 이면 프로젝트 0개 리스트 개요 카드 숨김
function dashTaskCountMode() { try { const v = localStorage.getItem(DASH_TASKCOUNT_KEY); return (v === 'all' || v === 'progress') ? v : 'active'; } catch { return 'active'; } }
function dashSaveTaskCountMode(v) { try { localStorage.setItem(DASH_TASKCOUNT_KEY, v); } catch { /* 무시 */ } }
function dashProjFilterDefault() { try { return localStorage.getItem(DASH_PROJFILTER_KEY) === 'all' ? 'all' : 'active'; } catch { return 'active'; } }
function dashSaveProjFilterDefault(v) { try { localStorage.setItem(DASH_PROJFILTER_KEY, v); } catch { /* 무시 */ } }
function dashHideEmptyLists() { try { return localStorage.getItem(DASH_HIDEEMPTY_KEY) === '1'; } catch { return false; } }
function dashSaveHideEmptyLists(on) { try { localStorage.setItem(DASH_HIDEEMPTY_KEY, on ? '1' : ''); } catch { /* 무시 */ } }
// 프로젝트 행 태스크 칩 텍스트/표시여부 — active=진행 중 태스크(전체−완료; 완료·닫힘은 native done 으로 집계됨).
function dashTaskChip(p) {
  const total = Number(p.task_count) || 0, done = Number(p.task_done_count) || 0, active = Math.max(0, total - done);
  const mode = dashTaskCountMode();
  if (mode === 'all') return total > 0 ? { text: String(total), title: total + '개 태스크' } : null;
  if (mode === 'progress') return total > 0 ? { text: done + '/' + total, title: '완료 ' + done + ' / 전체 ' + total } : null;
  return active > 0 ? { text: String(active), title: '진행 중 태스크 ' + active + '개 (완료·닫힘 제외)' } : null;
}
// ── 위젯별 기본 표시 설정(기기별 localStorage) — 헤더 ⚙ 통일 컨트롤이 읽고/쓴다. ──
const DASH_FOLD_VIEW_KEY = 'dash_fb_view_v1';    // 공유 폴더 브라우저 기본 뷰(icon|list)
const DASH_SESS_FILTER_KEY = 'dash_sess_filter_v1'; // 내 AI 세션 기본 필터(all|mine|invited|myproj)
const DASH_LOG_TYPE_KEY = 'dash_log_type_v1';   // 작업 로그 기본 유형 필터(''=전체 | feature·fix·… #req R14)
function dashFoldView() { try { return localStorage.getItem(DASH_FOLD_VIEW_KEY) === 'list' ? 'list' : 'icon'; } catch { return 'icon'; } }
function dashSaveFoldView(v) { try { localStorage.setItem(DASH_FOLD_VIEW_KEY, v === 'list' ? 'list' : 'icon'); } catch { /* 무시 */ } }
function dashSessFilter() { try { const v = localStorage.getItem(DASH_SESS_FILTER_KEY); return ['all', 'private', 'invited', 'myproj'].includes(v as string) ? v : 'all'; } catch { return 'all'; } }
function dashSaveSessFilter(v) { try { localStorage.setItem(DASH_SESS_FILTER_KEY, v); } catch { /* 무시 */ } }
function dashLogType() { try { return localStorage.getItem(DASH_LOG_TYPE_KEY) || ''; } catch { return ''; } }
function dashSaveLogType(v) { try { if (v) localStorage.setItem(DASH_LOG_TYPE_KEY, v); else localStorage.removeItem(DASH_LOG_TYPE_KEY); } catch { /* 무시 */ } }
// 폴더 기본 뷰 설정 팝오버(⚙) — 브라우저 열 때 initial 뷰가 됨.
// ── 열 폭 사용자화(#req) — .dash-zones 3열 사이 드래그 핸들 2개(fr 비율 기기별 저장). 반응형 스택 시 CSS 가 인라인 grid 무시. ──
const DASH_COLS_KEY = 'dash_cols_v1';
const DASH_COLS_DEFAULT = [5, 4, 3];
function dashCols(): number[] {
  try { const a = JSON.parse(localStorage.getItem(DASH_COLS_KEY) || 'null'); return Array.isArray(a) && a.length === 3 && a.every((n) => typeof n === 'number' && n > 0.5) ? a : DASH_COLS_DEFAULT.slice(); }
  catch { return DASH_COLS_DEFAULT.slice(); }
}
function dashSaveCols(a) { try { localStorage.setItem(DASH_COLS_KEY, JSON.stringify(a)); } catch { /* 무시 */ } }
function dashInitColResize(zonesEl) {
  const cols = dashCols();
  const HANDLE = 16, MIN_FR = 1.2; // 핸들 트랙 폭(px) · 열 최소 폭(fr, 붕괴 방지).
  const apply = () => { zonesEl.style.gridTemplateColumns = `minmax(0,${cols[0]}fr) ${HANDLE}px minmax(0,${cols[1]}fr) ${HANDLE}px minmax(0,${cols[2]}fr)`; };
  const kids = Array.from(zonesEl.children); // 스냅샷 [col0, col1, col2]
  const mkHandle = (idx) => {
    const h = el('div', { class: 'dash-col-handle', role: 'separator', 'aria-orientation': 'vertical', title: '열 폭 조절 (더블클릭=기본, ←/→ 미세조절)', tabindex: '0' }, el('span', { class: 'dash-col-grip' }));
    let startX = 0, w0 = 0, w1 = 0, dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      const rect = zonesEl.getBoundingClientRect();
      const content = Math.max(1, rect.width - 2 * HANDLE);
      const totalFr = cols[0] + cols[1] + cols[2];
      const dFr = ((e.clientX - startX) / content) * totalFr;
      let a = w0 + dFr, b = w1 - dFr;
      if (a < MIN_FR) { b -= (MIN_FR - a); a = MIN_FR; }
      if (b < MIN_FR) { a -= (MIN_FR - b); b = MIN_FR; }
      cols[idx] = a; cols[idx + 1] = b; apply();
    };
    const onUp = () => { if (!dragging) return; dragging = false; document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); document.body.classList.remove('dash-col-resizing'); dashSaveCols(cols); };
    h.addEventListener('pointerdown', (e: any) => { e.preventDefault(); dragging = true; startX = e.clientX; w0 = cols[idx]; w1 = cols[idx + 1]; document.body.classList.add('dash-col-resizing'); document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', onUp); });
    h.addEventListener('dblclick', () => { cols[0] = DASH_COLS_DEFAULT[0]; cols[1] = DASH_COLS_DEFAULT[1]; cols[2] = DASH_COLS_DEFAULT[2]; apply(); dashSaveCols(cols); });
    h.addEventListener('keydown', (e: any) => {
      const step = e.key === 'ArrowLeft' ? -0.3 : e.key === 'ArrowRight' ? 0.3 : 0; if (!step) return; e.preventDefault();
      const a = cols[idx] + step, b = cols[idx + 1] - step;
      if (a >= MIN_FR && b >= MIN_FR) { cols[idx] = a; cols[idx + 1] = b; apply(); dashSaveCols(cols); }
    });
    return h;
  };
  zonesEl.insertBefore(mkHandle(0), kids[1]); // col0 | H0 | col1 ...
  zonesEl.insertBefore(mkHandle(1), kids[2]); // ... col1 | H1 | col2
  apply();
}
// ── 박스 행 높이 사용자화(#req R13) — 한 열(2박스) 사이 세로 드래그 핸들 1개. 열 폭 리사이즈와 동일 UI(fr 비율·기기별 저장). ──
function dashPair(key, def): number[] { try { const a = JSON.parse(localStorage.getItem(key) || 'null'); return Array.isArray(a) && a.length === 2 && a.every((n) => typeof n === 'number' && n > 0.15) ? a : def.slice(); } catch { return def.slice(); } }
function dashSavePair(key, a) { try { localStorage.setItem(key, JSON.stringify(a)); } catch { /* 무시 */ } }
//  autoDefault=true — 저장값이 없으면 CSS 기본(예: 1fr/auto = 아래칸 내용맞춤·스크롤 없음)을 유지하고, 첫 드래그 때 비로소 fr 로 전환.
//  (팀 공유 폴더처럼 '한 줄 내용'인 칸이 고정 fr 로 잘려 스크롤바가 뜨던 문제 방지 — #req.)
function dashInitRowResize(colEl, storeKey, defaults, autoDefault?) {
  let saved: string | null = null; try { saved = localStorage.getItem(storeKey); } catch { /* */ }
  const rows = dashPair(storeKey, defaults);
  const HANDLE = 14, MIN_FR = 0.35;
  let frMode = !!saved || !autoDefault; // false = CSS 기본(auto) 유지 상태
  const apply = () => { colEl.style.gridTemplateRows = `minmax(0,${rows[0]}fr) ${HANDLE}px minmax(0,${rows[1]}fr)`; };
  const kids = Array.from(colEl.children); // [box0, box1] (핸들 삽입 전 스냅샷)
  // 현재(auto) 픽셀 높이를 fr 비율로 캡처 → 드래그 시작점(레이아웃 안 튀게).
  const captureFr = () => { const a = Math.max(1, (kids[0] as any).offsetHeight || 100); const b = Math.max(1, (kids[1] as any).offsetHeight || 60); const s = 12 / (a + b); rows[0] = a * s; rows[1] = b * s; frMode = true; };
  const h = el('div', { class: 'dash-row-handle', role: 'separator', 'aria-orientation': 'horizontal', title: '높이 조절 (더블클릭=기본, ↑/↓ 미세조절)', tabindex: '0' }, el('span', { class: 'dash-row-grip' }));
  let startY = 0, a0 = 0, b0 = 0, dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const rect = colEl.getBoundingClientRect();
    const content = Math.max(1, rect.height - HANDLE);
    const totalFr = rows[0] + rows[1];
    const dFr = ((e.clientY - startY) / content) * totalFr;
    let a = a0 + dFr, b = b0 - dFr;
    if (a < MIN_FR) { b -= (MIN_FR - a); a = MIN_FR; }
    if (b < MIN_FR) { a -= (MIN_FR - b); b = MIN_FR; }
    rows[0] = a; rows[1] = b; apply();
  };
  const onUp = () => { if (!dragging) return; dragging = false; document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); document.body.classList.remove('dash-row-resizing'); dashSavePair(storeKey, rows); };
  h.addEventListener('pointerdown', (e: any) => { e.preventDefault(); if (!frMode) captureFr(); dragging = true; startY = e.clientY; a0 = rows[0]; b0 = rows[1]; document.body.classList.add('dash-row-resizing'); document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', onUp); apply(); });
  h.addEventListener('dblclick', () => { try { localStorage.removeItem(storeKey); } catch { /* */ } rows[0] = defaults[0]; rows[1] = defaults[1]; if (autoDefault) { frMode = false; colEl.style.gridTemplateRows = ''; } else apply(); });
  h.addEventListener('keydown', (e: any) => { const s = e.key === 'ArrowUp' ? -0.3 : e.key === 'ArrowDown' ? 0.3 : 0; if (!s) return; e.preventDefault(); if (!frMode) captureFr(); const a = rows[0] + s, b = rows[1] - s; if (a >= MIN_FR && b >= MIN_FR) { rows[0] = a; rows[1] = b; apply(); dashSavePair(storeKey, rows); } });
  colEl.insertBefore(h, kids[1]);
  if (frMode) apply(); // 저장값 있거나 non-auto → 즉시 fr. auto 기본이면 CSS(1fr/auto) 그대로.
}
// ── 경량 모달(중앙 오버레이) — 배경/✕/Esc 로 닫힘. 공유 폴더 전체 보기 등. ──
function dashModal(title, content, wide?) {
  document.querySelectorAll('.dash-modal-ov').forEach((n) => n.remove());
  const closeBtn = el('button', { class: 'dash-modal-x', type: 'button', 'aria-label': '닫기', text: '✕' });
  const box = el('div', { class: 'dash-modal' + (wide ? ' dash-modal--wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('div', { class: 'dash-modal-head' }, el('strong', { text: title }), closeBtn),
    el('div', { class: 'dash-modal-body' }, content));
  const ov = el('div', { class: 'dash-modal-ov' }, box);
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  ov.addEventListener('mousedown', (e: any) => { if (e.target === ov) close(); });
  closeBtn.onclick = close;
  document.addEventListener('keydown', onKey, true);
  document.body.append(ov);
  return close;
}

// ── ② 내 AI 세션 — 내 것 + 초대받은 것 + '프로젝트에서 만든 세션' 통합(접속중 우선). ──
//  UI 는 터미널 탭의 세션 박스(term-row: 약간 푸른 카드)와 통일. 프로젝트 세션(@box_project)은 프로젝트 뱃지로 식별.
//  [열기] = 터미널 새 창. (세션 created 는 unix '초' → relTime 은 ms/ISO 기대라 ×1000 변환: 1970 표기 버그 수정.)
async function fillSessions(zone, onCount, projectsP?) {
  let sessions, cfg, projects;
  try {
    [sessions, cfg, projects] = await Promise.all([
      api('/api/ui/terminal/sessions').then((d) => (d && d.sessions) || []),
      api('/api/ui/terminal/config').catch(() => null), // 라벨 보강용 — 실패해도 폴백으로 진행
      (projectsP || Promise.resolve([])).catch(() => []),  // 프로젝트 세션의 프로젝트명 매핑용
    ]);
  } catch (e) { onCount(null); zone.body.replaceChildren(errorNote(e, '세션을 불러오지 못했습니다')); return; }

  // 프로젝트 탭에서 만든 '내 세션'도 포함 — /terminal/sessions 는 프로젝트 세션을 숨기므로(터미널 탭 전용 정책),
  //  내 프로젝트(my_session_count>0)별로 /projects/:id/sessions 를 받아 owned('내 세션')만 합친다(id 중복 제거).
  try {
    const withSess = (projects || []).filter((p) => Number(p.my_session_count) > 0);
    if (withSess.length) {
      const lists = await Promise.all(withSess.map((p) =>
        api('/api/ui/v6/projects/' + p.id + '/sessions').then((d) => (d && d.sessions) || []).catch(() => [])));
      const seen = new Set(sessions.map((s) => s.id));
      for (const arr of lists) for (const s of arr) {
        if (s.owned && !seen.has(s.id)) { seen.add(s.id); sessions.push(s); }
      }
    }
  } catch { /* 프로젝트 세션 병합 실패 → 기존 목록만 유지 */ }

  onCount(sessions.filter((s) => s.attached).length);
  const projName = new Map<any, string>((projects || []).map((p) => [p.id, p.name]));
  const memberName = (id) => {
    const m = ((cfg && cfg.members) || []).find((x) => x.id === id);
    return (m && m.name) || id || '';
  };
  // #req — 상대시간('3시간 전') 대신 실제 시각을 표기. 오늘이면 시:분만, 다른 날이면 '월 일 시:분'.
  const sessTime = (c) => {
    const n = Number(c); if (!n) return '';
    const d = new Date(n * 1000);
    const hm = d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? hm : d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' }) + ' ' + hm;
  };

  // 내가 할당된 프로젝트(=mine=1 응답) 안에서 만들어진 내 세션 판별(#req) — projName(내 프로젝트) 에 있는 projectId.
  const isMyProjectSess = (s) => { const pid = Number(s.projectId) || 0; return pid > 0 && projName.has(pid); };
  let mode = dashSessFilter(); // 전체 | 내 프로젝트 | 비공개 | 초대받음 (저장된 기본 필터)
  // 비공개 = 내 소유인데 초대가 없는(나만 보는) 세션(#req).
  const isPrivateSess = (s) => s.owned && !((s.invites || []).length);
  const draw = () => {
    const shown = sessions
      .filter((s) => mode === 'private' ? isPrivateSess(s) : mode === 'invited' ? !s.owned : mode === 'myproj' ? isMyProjectSess(s) : true)
      .sort((a, b) => (b.attached ? 1 : 0) - (a.attached ? 1 : 0) || (Number(b.created) || 0) - (Number(a.created) || 0));
    zone.countEl.textContent = String(shown.length);
    // #req 칩 순서: 전체 · 내 프로젝트(그런 세션 있을 때만) · 비공개 · 초대받음.
    const chips: any[] = [['all', '전체']];
    if (sessions.some(isMyProjectSess)) chips.push(['myproj', '내 프로젝트']);
    chips.push(['private', '비공개'], ['invited', '초대받음']);
    dashChips(zone.chipsEl, chips, mode, (k) => { mode = k; draw(); });
    if (!shown.length) {
      zone.body.replaceChildren(mode === 'invited' ? dashEmpty('초대받은 세션이 없어요.')
        : mode === 'myproj' ? dashEmpty('내 프로젝트에서 만든 세션이 없어요.')
        : dashSessionEmpty(cfg, reloadSessions)); // #req 세션 0개 첫 사용자 — 설명 + 따라하기/새 세션(대시보드서 바로)
      return;
    }
    const list = el('div', { class: 'dash-sess-list' });
    for (const s of shown) {
      // #req 카드 = 1열 제목 / 2열 생성시각·태그. [열기]·[⋮]는 우측에 '항상 보이는' 버튼(호버 반응 폐지).
      const tags = el('span', { class: 'dash-sess-tags' });
      if (s.attached) tags.append(el('span', { class: 'dash-badge live', text: '접속중' }));
      const pid = Number(s.projectId) || 0;
      if (pid) { const mine = projName.has(pid); tags.append(el('span', { class: 'dash-badge dash-badge-proj' + (mine ? ' dash-badge-proj-mine' : ''), title: (mine ? '내 프로젝트: ' : '프로젝트: ') + (projName.get(pid) || pid), text: projName.get(pid) || ('프로젝트 #' + pid) })); }
      if (s.owned) { if ((s.invites || []).length) tags.append(el('span', { class: 'dash-badge', text: '초대 ' + s.invites.length })); }
      else tags.append(el('span', { class: 'dash-badge', title: '소유: ' + memberName(s.owner), text: memberName(s.owner) + ' · 초대받음' }));
      // #req 하네스 태그 제거 · 순서 태그 → 시간.
      const info = el('div', { class: 'dash-sess-info' },
        el('div', { class: 'dash-sess-title' }, el('span', { class: 'dash-sess-name', title: s.label, text: s.label || '(이름 없음)' })),
        el('div', { class: 'dash-sess-sub' },
          tags,
          el('span', { class: 'dash-sess-when', text: sessTime(s.created) })));
      const openBtn = el('button', { class: 'dash-sess-open', type: 'button', text: '열기' });
      openBtn.onclick = () => window.open('/ui/terminal.html?session=' + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || ''), '_blank');
      const acts = el('div', { class: 'dash-sess-acts' }, openBtn);
      if (s.owned) { // 이름 수정·삭제는 소유자만(서버도 비소유 403 재검증).
        const moreBtn = el('button', { class: 'dash-sess-more', type: 'button', title: '세션 관리 (이름 수정·삭제)', 'aria-label': '세션 관리', text: '⋮' });
        moreBtn.onclick = () => openSessMenu(moreBtn, s, reloadSessions);
        acts.append(moreBtn);
      }
      list.append(el('div', { class: 'dash-sess-box' + (s.attached ? ' live' : '') }, info, acts));
    }
    // #req 세션이 있어도 대시보드에서 바로 새 세션 — 목록 맨 밑 '+ 새 세션'(팝업은 터미널과 동일 openTermCreateForm 재사용).
    list.append(el('div', { class: 'dash-sess-addrow' },
      el('button', { class: 'dash-sess-addbtn', type: 'button', 'data-tour': 'new-session', title: '새 세션 만들기',
        onclick: () => { if (cfg) openTermCreateForm(cfg, null, () => reloadSessions()); else location.hash = '#/terminal'; } },
        el('span', { class: 'dash-sess-addplus', text: '＋' }), el('span', { text: '새 세션' }))));
    zone.body.replaceChildren(list);
  };
  // 세션 변경(이름 수정·삭제) 후 새로고침 — base 세션 + 프로젝트 세션 재병합 후 재렌더.
  const reloadSessions = async () => {
    try {
      const d = await api('/api/ui/terminal/sessions'); sessions = (d && d.sessions) || [];
      const withSess = (projects || []).filter((p) => Number(p.my_session_count) > 0);
      if (withSess.length) {
        const arrs = await Promise.all(withSess.map((p) => api('/api/ui/v6/projects/' + p.id + '/sessions').then((d2) => (d2 && d2.sessions) || []).catch(() => [])));
        const seen = new Set(sessions.map((x) => x.id));
        for (const arr of arrs) for (const x of arr) if (x.owned && !seen.has(x.id)) { seen.add(x.id); sessions.push(x); }
      }
      onCount(sessions.filter((x) => x.attached).length);
    } catch { /* 유지 */ }
    draw();
  };
  // 헤더 우상단 통일 컨트롤 — ⚙(기본 세션 필터) + →(터미널 딥링크).
  dashCtl(zone, { gear: { title: '세션 표시 설정', open: (a) => dashChoicePopover(a, '기본 세션 필터', [['all', '전체'], ['myproj', '내 프로젝트'], ['private', '비공개'], ['invited', '초대받음']], mode, (k) => { dashSaveSessFilter(k); mode = k; draw(); }) }, action: { href: '#/terminal', title: '터미널로' } });
  draw();
}
// 세션 '⋯' 메뉴(#req R15) — 이름 수정(POST /sessions/:id {label}) · 삭제(DELETE /sessions/:id). 소유자만 노출.
function openSessMenu(anchor, s, onChange) {
  const panel = el('div', { class: 'dash-pop-panel' });
  let close = () => { /* dashPopover 반환값으로 대체 */ };
  const item = (label, danger, fn) => {
    const b = el('button', { class: 'dash-pop-opt' + (danger ? ' danger' : ''), type: 'button' }, el('span', { class: 'dash-pop-name', text: label }));
    b.onclick = () => { close(); fn(); }; panel.append(b);
  };
  item('이름 수정', false, async () => {
    const to = (prompt('세션 이름', s.label || '') || '').trim();
    if (!to || to === s.label) return;
    try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'POST', body: JSON.stringify({ label: to }) }); toast('이름을 바꿨어요'); onChange && onChange(); }
    catch (e: any) { toast('이름 변경 실패 — ' + (e && e.message || e), true); }
  });
  item('삭제', true, async () => {
    if (!confirm('세션 ‘' + (s.label || '(이름 없음)') + '’을(를) 삭제할까요?\n실행 중인 작업도 함께 종료됩니다 (되돌릴 수 없어요).')) return;
    try { await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'DELETE' }); toast('세션을 삭제했어요'); onChange && onChange(); }
    catch (e: any) { toast('삭제 실패 — ' + (e && e.message || e), true); }
  });
  close = dashPopover(anchor, panel);
}
// #req 따라하기 ① 단계 — 대시보드 맥락에 맞춘 문구·앵커. (②~⑦은 openTermCreateForm 폼이 동일해 그대로 재사용.)
//  이 카드의 [+ 새 세션]([data-tour="new-session"])을 가리키고, 클릭하면 폼이 대시보드 위로 떠 다음 단계로 이어짐.
function dashTourStep1() {
  return {
    target: '[data-tour="new-session"]',
    title: '① 새 세션 만들기',
    body: [el('p', { class: 'tour-p' }, '바로 옆 ', el('b', { text: '[+ 새 세션]' }), ' 을 눌러 주세요 — 세션 만들기 창이 이 대시보드 위에 바로 열려요.')],
    placement: 'bottom', advanceOn: 'click',
  };
}
// #req 세션 0개 첫 사용자 빈 상태 — 'AI 세션이 뭔지' 쉬운 설명 + 바로 시작(따라하기/새 세션). 팝업·투어 모두 대시보드에서.
function dashSessionEmpty(cfg, reloadSessions) {
  const startNew = () => { if (cfg) openTermCreateForm(cfg, null, () => reloadSessions && reloadSessions()); else location.hash = '#/terminal'; };
  return el('div', { class: 'dash-sess-empty' },
    el('div', { class: 'dash-sess-empty-ic' }, dashSessionIcon()),
    el('div', { class: 'dash-sess-empty-title', text: 'AI 세션으로 바로 시작해 보세요' }),
    el('div', { class: 'dash-sess-empty-desc', text: '터미널에서 Claude·Codex 같은 AI와 함께 코드·문서를 만드는 작업 공간이에요. 폴더를 고르고 세션을 열면 AI가 바로 일을 시작해요.' }),
    el('div', { class: 'dash-sess-empty-acts' },
      // 따라하기 = 온보딩 투어(startTerminalTour). ① 단계를 대시보드용으로 넘겨(버튼 위치·문구), 이후 폼 단계(②~⑦)는 동일 폼이라 그대로 이어짐.
      el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '🧭 따라하며 시작하기', title: '세션 만드는 법을 화면에서 한 단계씩 짚어드려요', onclick: () => startTerminalTour(dashTourStep1()) }),
      el('button', { class: 'btn btn-ghost btn-sm', 'data-tour': 'new-session', type: 'button', text: '+ 새 세션', title: '바로 새 세션 만들기', onclick: startNew })));
}

// ── ③ 팀 공유 폴더 — 공유 워크스페이스 루트의 폴더. 목록형→아이콘형(#621). ──
//  프로젝트 상세 '공유 폴더'와 동일한 아이콘 카드(proj-file-*): 맥 스타일 폴더 아이콘 + 이름 + '폴더'.
async function fillFolders(zone) {
  // '전체 보기' → 공유 폴더 브라우저 모달(하위 폴더 진입 + 파일 표시 + CRUD, #672). 넓은 모달로.
  const openBrowser = (startPath) => dashModal('팀 공유 폴더', dashFolderBrowser('shared', startPath || ''), true);
  let dirs: string[] = [];
  // 뷰(아이콘|목록)를 ⚙ 설정(dashFoldView, 전체보기와 공유)에 맞춰 렌더 — #670: 목록으로 바꾸면 대시보드 위젯도 목록으로.
  const paint = () => {
    if (!dirs.length) { zone.body.replaceChildren(dashEmpty('공유 워크스페이스에 폴더가 없어요.')); return; }
    if (dashFoldView() === 'list') {
      const list = el('div', { class: 'dash-fold-list' });
      for (const name of dirs) list.append(dashFolderRow(name, () => openBrowser(name)));
      zone.body.replaceChildren(list);
    } else {
      const grid = el('div', { class: 'proj-file-grid dash-fold-grid' });
      for (const name of dirs) {
        const card = dashFolderCard(name);
        card.classList.add('dash-fold-open');
        card.setAttribute('role', 'button'); card.setAttribute('tabindex', '0'); card.title = name + ' 열기';
        card.addEventListener('click', () => openBrowser(name));
        card.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBrowser(name); } });
        grid.append(card);
      }
      zone.body.replaceChildren(grid);
    }
  };
  // 헤더 우상단 통일 컨트롤 — ⚙(폴더 기본 뷰: 저장 후 위젯도 즉시 그 뷰로 재렌더) + ⤢(전체 보기 모달).
  const openPrefs = (anchor) => dashChoicePopover(anchor, '폴더 기본 뷰', [['icon', '아이콘'], ['list', '목록']], dashFoldView(), (v) => { dashSaveFoldView(v); paint(); });
  dashCtl(zone, { gear: { title: '폴더 기본 뷰 설정', open: openPrefs }, action: { onClick: () => openBrowser(''), title: '공유 폴더 전체 보기 · 파일 관리' } });
  let data;
  try { data = await api('/api/ui/terminal/browse?root=shared&path='); }
  catch (e) { zone.body.replaceChildren(errorNote(e, '공유 폴더를 불러오지 못했습니다')); return; }
  dirs = (data && data.dirs) || [];
  zone.countEl.textContent = String(dirs.length);
  paint();
}
// 공유 폴더 목록 행(#670) — 아이콘 카드 대신 컴팩트 리스트. 폴더 아이콘 + 굵은 이름 + hover 시 슬라이드 셰브런.
function dashFolderRow(name, onOpen) {
  const row = el('div', { class: 'dash-fold-row', role: 'button', tabindex: '0', title: name + ' 열기' },
    el('span', { class: 'dash-fold-row-ic', 'aria-hidden': 'true' }, dashFolderThumb()),
    el('span', { class: 'dash-fold-row-nm', text: name }),
    el('span', { class: 'dash-fold-row-go', 'aria-hidden': 'true', text: '›' }));
  row.addEventListener('click', onOpen);
  row.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } });
  return row;
}
// 공유 폴더 아이콘 카드 — 박스·브라우저 공용. 프로젝트 상세 공유 폴더(proj-file-*)와 동일.
function dashFolderCard(name) {
  return el('div', { class: 'proj-file-card', title: name },
    el('div', { class: 'proj-file-card-ic' }, dashFolderThumb()),
    el('div', { class: 'proj-file-card-nm', text: name }),
    el('div', { class: 'proj-file-card-sz', text: '폴더' }));
}
// ── 공유 폴더 브라우저(#672) — 전체 보기 모달 안의 파일 탐색기: 브레드크럼 하위 진입 + 파일 표시 + CRUD. ──
//  루트 브라우즈 API(/api/ui/terminal/browse[/file])만 쓴다 — 공유 워크스페이스는 셸(터미널)로 이미 rw 라 UI CRUD 가 권한을 넓히지 않는다.
//  파일 프리미티브(authUpload/Download·fmtSize)는 프로젝트 탭 파일함에서 검증된 것을 그대로 재사용.
function dashFolderBrowser(root, startPath) {
  const container = el('div', { class: 'dash-fb' });
  let curPath = startPath || '';
  const qp = (p) => 'root=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(p);
  const relOf = (name) => (curPath ? curPath + '/' : '') + name;
  const busy = (on) => { if (on) container.setAttribute('aria-busy', 'true'); else container.removeAttribute('aria-busy'); };

  const load = async () => {
    container.replaceChildren(el('div', { class: 'dash-fb-load' }, skeleton('불러오는 중')));
    let data;
    try { data = await api('/api/ui/terminal/browse?' + qp(curPath)); }
    catch (e) { busy(false); container.replaceChildren(errorNote(e, '폴더를 불러오지 못했습니다')); return; }
    curPath = data.path || '';
    render(data);
    busy(false); // 새 상태 렌더 완료 → 진행중 표시 해제(성공 경로에서도 반드시 — 안 그러면 pointer-events:none 이 남아 잠김).
  };
  const newFolder = async () => {
    const name = (prompt('새 폴더 이름') || '').trim();
    if (!name) return;
    busy(true);
    try { await api('/api/ui/terminal/browse/mkdir?' + qp(relOf(name)), { method: 'POST' }); await load(); }
    catch (e) { toast('폴더 생성 실패 — ' + e.message, true); busy(false); }
  };
  const uploadFiles = () => {
    const inp = el('input', { type: 'file', multiple: 'true' });
    inp.onchange = async () => {
      const files = Array.from(inp.files || []); if (!files.length) return;
      busy(true);
      try { for (const f of files) await authUpload('/api/ui/terminal/browse/file?' + qp(relOf((f as any).name)), f); await load(); }
      catch (e) { toast('업로드 실패 — ' + e.message, true); busy(false); }
    };
    inp.click();
  };
  const renameItem = async (name) => {
    const to = (prompt('새 이름', name) || '').trim();
    if (!to || to === name) return;
    busy(true);
    try { await api('/api/ui/terminal/browse/rename?' + qp(relOf(name)) + '&to=' + encodeURIComponent(to), { method: 'POST' }); await load(); }
    catch (e) { toast('이름 변경 실패 — ' + e.message, true); busy(false); }
  };
  const deleteItem = async (name, isDir) => {
    if (!confirm((isDir ? '폴더' : '파일') + ' ‘' + name + '’' + (isDir ? ' 및 그 안의 모든 내용' : '') + '을(를) 삭제할까요? 되돌릴 수 없어요.')) return;
    busy(true);
    try { await api('/api/ui/terminal/browse?' + qp(relOf(name)), { method: 'DELETE' }); await load(); }
    catch (e) { toast('삭제 실패 — ' + e.message, true); busy(false); }
  };
  const download = (name) => authDownload('/api/ui/terminal/browse/file?download=1&' + qp(relOf(name)), name);

  // 파일 미리보기 — 클릭 시 다운로드 대신 타입별 렌더(이미지·PDF·텍스트/코드[json 정렬])를 브라우저 안(제자리)에 표시.
  //  browse/file 은 download 없이 인라인 서빙(2MB 미리보기 상한) → 이미지·PDF 는 blob(타입 재지정), 텍스트는 text.
  const showPreview = async (rel, name) => {
    const ext = dashFileExt(name);
    const viewUrl = '/api/ui/terminal/browse/file?' + qp(rel);
    const dlUrl = '/api/ui/terminal/browse/file?download=1&' + qp(rel);
    const bar = el('div', { class: 'dash-fp-bar' },
      el('button', { class: 'dash-fb-btn', type: 'button', text: '← 뒤로', onclick: () => load() }),
      el('span', { class: 'dash-fp-name', title: name, text: name }),
      el('span', { class: 'dash-fb-spacer' }),
      el('button', { class: 'dash-fb-btn', type: 'button', text: '⬇ 다운로드', onclick: () => authDownload(dlUrl, name) }));
    const stage = el('div', { class: 'dash-fp-stage' }, el('div', { class: 'dash-fp-load' }, skeleton('불러오는 중')));
    container.replaceChildren(bar, stage);
    const fail = (msg) => stage.replaceChildren(el('div', { class: 'dash-fp-msg' }, msg));
    const big = (res) => res.status === 413;
    try {
      if (DASH_PREVIEW_IMG.includes(ext)) {
        const res = await dashAuthFetch(viewUrl);
        if (!res.ok) return fail(big(res) ? '이미지가 커서 미리보기할 수 없어요 — 다운로드하세요.' : '미리보기를 불러오지 못했어요 (' + res.status + ')');
        const img = el('img', { class: 'dash-fp-img', alt: name });
        img.src = URL.createObjectURL(new Blob([await res.blob()], { type: DASH_IMG_MIME[ext] || 'application/octet-stream' }));
        stage.replaceChildren(img);
      } else if (ext === 'pdf') {
        const res = await dashAuthFetch(viewUrl);
        if (!res.ok) return fail(big(res) ? 'PDF가 커서 미리보기할 수 없어요 — 다운로드하세요.' : '미리보기를 불러오지 못했어요 (' + res.status + ')');
        const frame = el('iframe', { class: 'dash-fp-pdf', title: name });
        frame.src = URL.createObjectURL(new Blob([await res.blob()], { type: 'application/pdf' }));
        stage.replaceChildren(frame);
      } else if (DASH_PREVIEW_TEXT.includes(ext) || !ext) {
        const res = await dashAuthFetch(viewUrl);
        if (!res.ok) return fail(big(res) ? '파일이 커서 미리보기할 수 없어요 — 다운로드하세요.' : '미리보기를 불러오지 못했어요 (' + res.status + ')');
        let text = await res.text();
        if (ext === 'json') { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 원문 유지 */ } }
        const pre = el('pre', { class: 'dash-fp-code' + (DASH_PREVIEW_CODE.has(ext) ? ' is-code' : '') });
        pre.textContent = text;
        stage.replaceChildren(pre);
      } else {
        fail('이 형식(' + (ext || '알 수 없음') + ')은 미리보기를 지원하지 않아요. 다운로드해 확인하세요.');
      }
    } catch (e) { fail('미리보기 실패 — ' + ((e && e.message) || e)); }
  };

  // 액션 버튼(다운로드·이름변경·삭제) — 아이콘/목록 두 뷰 공용.
  const act = (icon, title, danger, onClick) => {
    const b = el('button', { class: 'dash-fb-act' + (danger ? ' danger' : ''), type: 'button', title, 'aria-label': title }, icon);
    b.addEventListener('click', (e: any) => { e.stopPropagation(); onClick(); });
    return b;
  };
  const mkActions = (it, isDir) => {
    const actions = el('div', { class: 'dash-fb-actions' });
    if (!isDir) actions.append(act(dashDownloadIcon(), '다운로드', false, () => download(it.name)));
    actions.append(act(dashRenameIcon(), '이름 바꾸기', false, () => renameItem(it.name)));
    actions.append(act(dashTrashIcon(), '삭제', true, () => deleteItem(it.name, isDir)));
    return actions;
  };
  const openItem = (it, isDir) => { if (isDir) { curPath = relOf(it.name); load(); } else showPreview(relOf(it.name), it.name); };
  // 아이콘(카드) 뷰 항목 — 맥 데스크탑 아이콘 톤.
  const fbCard = (it) => {
    const isDir = it.type === 'dir';
    const card = el('div', { class: 'proj-file-card dash-fb-card', title: it.name, role: 'button', tabindex: '0' },
      el('div', { class: 'proj-file-card-ic' }, isDir ? dashFolderThumb() : dashFileThumb(it.name)),
      el('div', { class: 'proj-file-card-nm', text: it.name }),
      el('div', { class: 'proj-file-card-sz', text: isDir ? '폴더' : fmtSize(it.size) }));
    card.addEventListener('click', (e: any) => { if (e.target.closest('.dash-fb-actions')) return; openItem(it, isDir); });
    card.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openItem(it, isDir); } });
    card.append(mkActions(it, isDir));
    return card;
  };
  // 목록(Finder 리스트) 뷰 항목 — 작은 아이콘 · 이름 · 크기 · hover 액션.
  const fbRow = (it) => {
    const isDir = it.type === 'dir';
    const row = el('div', { class: 'dash-fb-row' + (isDir ? ' is-dir' : ''), title: it.name, role: 'button', tabindex: '0' },
      el('span', { class: 'dash-fb-row-ic' }, isDir ? dashFolderThumb() : dashFileThumb(it.name)),
      el('span', { class: 'dash-fb-row-nm', text: it.name }),
      // 폴더는 반복되던 '폴더' 텍스트 대신 hover 셰브런(열기), 파일은 크기(#670).
      isDir ? el('span', { class: 'dash-fb-row-go', 'aria-hidden': 'true', text: '›' }) : el('span', { class: 'dash-fb-row-sz', text: fmtSize(it.size) }),
      mkActions(it, isDir));
    row.addEventListener('click', (e: any) => { if (e.target.closest('.dash-fb-actions')) return; openItem(it, isDir); });
    row.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openItem(it, isDir); } });
    return row;
  };
  let viewMode = dashFoldView(); // 'icon' | 'list' — 기기별 저장(⚙ 폴더 기본 뷰와 공유).
  let curData: any = null;       // 마지막 로드 데이터(뷰 토글 시 재요청 없이 재렌더).
  const render = (data) => {
    if (data) curData = data;
    data = curData || { items: [] };
    // 브레드크럼(루트 → 하위 진입 경로).
    const crumb = el('div', { class: 'dash-fb-crumb' },
      el('button', { class: 'dash-fb-seg', type: 'button', text: '공유 워크스페이스', onclick: () => { curPath = ''; load(); } }));
    let acc = '';
    for (const seg of (curPath ? curPath.split('/') : [])) {
      acc = acc ? acc + '/' + seg : seg; const p = acc;
      crumb.append(el('span', { class: 'dash-fb-sep', text: '/' }), el('button', { class: 'dash-fb-seg', type: 'button', text: seg, onclick: () => { curPath = p; load(); } }));
    }
    // 뷰 토글(아이콘/목록) — 사람이 직접 선택, 기기별 저장, 즉시 재렌더(재요청 없이).
    const mkSeg = (mode, label, icon) => {
      const b = el('button', { class: 'dash-fb-vbtn' + (viewMode === mode ? ' on' : ''), type: 'button', title: label, 'aria-label': label, 'aria-pressed': viewMode === mode ? 'true' : 'false' }, icon);
      b.onclick = () => { if (viewMode === mode) return; viewMode = mode; dashSaveFoldView(mode); render(null); };
      return b;
    };
    const viewSeg = el('div', { class: 'dash-fb-viewseg', role: 'group', 'aria-label': '보기 방식' },
      mkSeg('icon', '아이콘 보기', dashViewIconIcon()), mkSeg('list', '목록 보기', dashViewListIcon()));
    // 도구모음 — [뷰토글] · 상위로 · (스페이서) · 새 폴더 · 파일 올리기.
    const tools = el('div', { class: 'dash-fb-tools' },
      viewSeg,
      (curPath ? el('button', { class: 'dash-fb-btn', type: 'button', text: '⬆ 상위', onclick: () => { curPath = data.parent || ''; load(); } }) : null),
      el('span', { class: 'dash-fb-spacer' }),
      el('button', { class: 'dash-fb-btn', type: 'button', text: '＋ 새 폴더', onclick: newFolder }),
      el('button', { class: 'dash-fb-btn primary', type: 'button', text: '⬆ 파일 올리기', onclick: uploadFiles }));
    const items = (data.items || []);
    let body;
    if (!items.length) { body = el('div', { class: 'proj-file-grid dash-fb-grid' }, dashEmpty('이 폴더가 비어 있어요.')); }
    else if (viewMode === 'list') { body = el('div', { class: 'dash-fb-list' }); for (const it of items) body.append(fbRow(it)); }
    else { body = el('div', { class: 'proj-file-grid dash-fb-grid' }); for (const it of items) body.append(fbCard(it)); }
    container.replaceChildren(crumb, tools, body);
  };
  load();
  return container;
}
// ── 파일 미리보기 헬퍼(#672 후속) — 인증 fetch + 타입별 확장자 집합. browse/file 은 Content-Type 미설정이라 blob 은 클라에서 재지정. ──
const DASH_TOKEN_KEY = 'lively_ui_token';
function dashAuthFetch(url) { const t = localStorage.getItem(DASH_TOKEN_KEY); return fetch(url, { headers: t ? { Authorization: 'Bearer ' + t } : {} }); }
function dashFileExt(name) { const i = String(name || '').lastIndexOf('.'); return i >= 0 ? String(name).slice(i + 1).toLowerCase() : ''; }
const DASH_IMG_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };
const DASH_PREVIEW_IMG = Object.keys(DASH_IMG_MIME);
const DASH_PREVIEW_TEXT = ['txt', 'md', 'markdown', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'zsh', 'html', 'htm', 'css', 'scss', 'sass', 'yaml', 'yml', 'toml', 'ini', 'conf', 'csv', 'tsv', 'xml', 'sql', 'java', 'go', 'rs', 'c', 'cc', 'cpp', 'h', 'hpp', 'rb', 'php', 'lua', 'r', 'kt', 'swift', 'log', 'env', 'gitignore', 'dockerfile', 'makefile'];
const DASH_PREVIEW_CODE = new Set(['json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'zsh', 'html', 'htm', 'css', 'scss', 'sass', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml', 'sql', 'java', 'go', 'rs', 'c', 'cc', 'cpp', 'h', 'hpp', 'rb', 'php', 'lua', 'r', 'kt', 'swift', 'dockerfile', 'makefile']);
// 파일 타입 아이콘 — 프로젝트 상세 공유 폴더 docIcon 동형(#619 인라인 원칙: projects.ts 안 건드림). 흰 페이지+접힘+색 띠+라벨.
const DASH_FILE_META: Record<string, [string, string]> = {
  pdf: ['PDF', 'ft-pdf'], doc: ['DOC', 'ft-word'], docx: ['DOC', 'ft-word'], hwp: ['HWP', 'ft-word'], hwpx: ['HWP', 'ft-word'],
  ppt: ['PPT', 'ft-ppt'], pptx: ['PPT', 'ft-ppt'], key: ['KEY', 'ft-ppt'],
  xls: ['XLS', 'ft-xls'], xlsx: ['XLS', 'ft-xls'], csv: ['CSV', 'ft-xls'],
  zip: ['ZIP', 'ft-zip'], tar: ['TAR', 'ft-zip'], gz: ['GZ', 'ft-zip'], rar: ['RAR', 'ft-zip'], '7z': ['7Z', 'ft-zip'],
  mp3: ['MP3', 'ft-av'], wav: ['WAV', 'ft-av'], m4a: ['M4A', 'ft-av'], flac: ['FLAC', 'ft-av'],
  mp4: ['MP4', 'ft-av'], mov: ['MOV', 'ft-av'], webm: ['WEBM', 'ft-av'], mkv: ['MKV', 'ft-av'],
  md: ['MD', 'ft-txt'], txt: ['TXT', 'ft-txt'], rtf: ['RTF', 'ft-txt'],
};
function dashFileThumb(name) {
  const i = String(name || '').lastIndexOf('.');
  const ext = i >= 0 ? name.slice(i + 1).toLowerCase() : '';
  const meta = DASH_FILE_META[ext] || [(ext.toUpperCase().slice(0, 4) || 'FILE'), 'ft-generic'];
  const n = sv('svg', { class: 'ft ft-file ' + meta[1], viewBox: '0 0 40 48', fill: 'none', 'aria-hidden': 'true' });
  n.append(sv('path', { class: 'ft-page', d: 'M6 2.5h17.5L34 13v30.5a2.5 2.5 0 0 1-2.5 2.5h-25A2.5 2.5 0 0 1 4 43.5V5A2.5 2.5 0 0 1 6 2.5z' }));
  n.append(sv('path', { class: 'ft-fold', d: 'M23.5 2.5V11a2 2 0 0 0 2 2H34z' }));
  n.append(sv('rect', { class: 'ft-band', x: 4, y: 29, width: 30, height: 12, rx: 2.5 }));
  const t = sv('text', { class: 'ft-label', x: 19, y: 37.8, 'text-anchor': 'middle' }); t.textContent = meta[0];
  n.append(t);
  return n;
}
function dashDownloadIcon() {
  const n = sv('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M12 4v10' }), sv('path', { d: 'M8 11l4 4 4-4' }), sv('path', { d: 'M5 19h14' }));
  return n;
}
function dashRenameIcon() {
  const n = sv('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M14.5 5.5l4 4' }), sv('path', { d: 'M4 20l1-4L16 5l3 3L8 19z' }));
  return n;
}
function dashTrashIcon() {
  const n = sv('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M4 7h16' }), sv('path', { d: 'M9 7V4h6v3' }), sv('path', { d: 'M6 7l1 13h10l1-13' }), sv('path', { d: 'M10 11v6M14 11v6' }));
  return n;
}
// 맥 스타일 폴더 아이콘 — 프로젝트 상세 공유 폴더의 folderThumb 과 동일(ft ft-folder; 색은 styles.css).
function dashFolderThumb() {
  const n = sv('svg', { class: 'ft ft-folder', viewBox: '0 0 48 40', fill: 'none', 'aria-hidden': 'true' });
  n.append(sv('path', { class: 'ft-folder-tab', d: 'M4 9a3 3 0 0 1 3-3h10.5l4 4H4z' }));
  n.append(sv('path', { class: 'ft-folder-body', d: 'M4 12a3 3 0 0 1 3-3h34a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z' }));
  return n;
}

// ── ④ 팀 작업 로그 — 회사 전체 활동 피드(유형점 + 요약 + 사람·AI·상대시간). 팀원 칩 필터. ──
//  헤더 '전체 보기'·행 클릭 = 전체 작업 로그 팝업(유형 필터·전체 목록·더보기). 별도 작업 로그 페이지는 폐지(#609 이관본도 팝업으로 통합).
function openWorklogPopup() { dashModal('작업 로그', companyTimelineSection()); }
async function fillActivity(zone) {
  let rows, people;
  try {
    [rows, people] = await Promise.all([
      api('/api/ui/activity/list?limit=60').then((d) => (Array.isArray(d) ? d : (d && d.rows) || [])),
      api('/api/ui/dash/people').then((d) => (d && d.people) || []).catch(() => []),
    ]);
  } catch (e) { zone.body.replaceChildren(errorNote(e, '작업 로그를 불러오지 못했습니다')); return; }

  const nameOf = (pid) => {
    if (!pid) return '';
    const m = people.find((x) => x.author_person === pid);
    return (m && m.display_name) || pid;
  };
  // #req R14 — 팀원(인물) 필터 제거 → '팀이 한 작업의 성격(유형)'으로 필터. 유형 = feature·fix·decision·docs·research·review·chore·other.
  const TYPE_ORDER = ['feature', 'fix', 'decision', 'docs', 'research', 'review', 'chore', 'other'];
  const typesPresent = TYPE_ORDER.filter((t) => rows.some((a) => (a.type || 'other') === t));
  const typeOpts: any[] = [['', '전체'], ...typesPresent.map((t) => [t, DASH_ACT_LABEL[t] || t])];
  let typeF = dashLogType(); // 저장된 기본 유형 필터(없거나 무효면 전체)
  if (typeF && !typesPresent.includes(typeF)) typeF = '';
  // #req 유형이 많아 칩으로 다 늘어놓으면 헤더가 넘침 → 헤더엔 '현재 선택 ▾' 드롭다운 하나만(1행 유지).
  const openTypeMenu = (anchor) => {
    const panel = el('div', { class: 'dash-pop-panel' });
    panel.append(el('div', { class: 'dash-pop-head' }, el('strong', { text: '유형 필터' })));
    let closeM = () => { /* 대체됨 */ };
    for (const [k, label] of typeOpts) {
      const b = el('button', { class: 'dash-pop-opt' + (k === typeF ? ' sel' : ''), type: 'button' }, el('span', { class: 'dash-pop-name', text: label }), k === typeF ? el('span', { class: 'dash-pop-check', text: '✓' }) : null);
      b.onclick = () => { closeM(); typeF = k; draw(); };
      panel.append(b);
    }
    closeM = dashPopover(anchor, panel);
  };
  // 헤더 우상단 통일 컨트롤 — ⚙(기본 유형 필터 저장) + ⤢(전체 작업 로그 모달).
  dashCtl(zone, { gear: { title: '작업 로그 표시 설정', open: (a) => dashChoicePopover(a, '기본 유형 필터', typeOpts, typeF, (k) => { dashSaveLogType(k); typeF = k; draw(); }) }, action: { onClick: openWorklogPopup, title: '전체 작업 로그 보기' } });
  const draw = () => {
    const shown = typeF ? rows.filter((a) => (a.type || 'other') === typeF) : rows;
    zone.countEl.textContent = String(shown.length);
    const curLabel = (typeOpts.find(([k]) => k === typeF) || ['', '전체'])[1];
    const dd = el('button', { class: 'dash-chip dash-chip-dd' + (typeF ? ' on' : ''), type: 'button', 'aria-haspopup': 'true', title: '작업 유형 필터' },
      el('span', { text: curLabel }), el('span', { class: 'dash-chip-caret', 'aria-hidden': 'true', text: '▾' }));
    dd.onclick = () => openTypeMenu(dd);
    zone.chipsEl.replaceChildren(dd);
    if (!shown.length) { zone.body.replaceChildren(dashEmpty(typeF ? '이 유형의 작업이 없어요.' : '아직 기록된 작업이 없어요.')); return; }
    zone.body.replaceChildren(...shown.map((a) => {
      const when = a.committed_at || a.created_at;
      const sub = [nameOf(a.author_person), a.author_agent, when ? relTime(when) : '']
        .filter(Boolean).join(' · ');
      return el('div', { class: 'dash-row dash-row--log', role: 'button', tabindex: '0', onclick: openWorklogPopup },
        el('span', { class: 'dash-dot tn-' + (DASH_ACT_TONE[a.type] || 'mut'), title: DASH_ACT_LABEL[a.type] || a.type || '' }),
        el('span', { class: 'dash-nm' },
          el('span', { class: 'dash-nm-line', title: a.summary || a.title || '', text: a.summary || a.title || '(제목 없음)' }),
          el('span', { class: 'dash-sub', text: sub })));
    }));
  };
  draw();
}

// ── ⓪ 최신 알림 — '나에 관한' 개인 인박스(팀 작업 로그와 별개). 전용 알림 백엔드가 없어(감사) 기존 API 합성:
//  활동(activity/list) · 댓글/멘션/필드변경(프로젝트별 getTaskFeed, 상위 K) · 다가오는 마감 · 나를 초대한 AI 세션.
//  내 행위는 빼고 '남이 한 것·내가 알아야 할 것'만 최신순. 유형별 on/off 는 헤더 '알림 설정'(dashNotifPrefs, 기기별 저장).
//  각 알림은 '누가·무엇을·언제'가 한눈에 — 행위자 아바타 + 유형 뱃지 + 동사형 문장 + 상대시간(#알림 UX).
async function fillNotifications(zone, projectsP) {
  const meId = (state.me && (state.me.userId || state.me.email)) || '';
  const myName = myDisplayName();
  let projects;
  try { projects = await projectsP; }
  catch (e) { zone.body.replaceChildren(errorNote(e, '알림을 불러오지 못했습니다')); return; }
  const people = await api('/api/ui/dash/people').then((d) => (d && d.people) || []).catch(() => []);
  const nameOf = (pid) => { if (!pid) return ''; const m = people.find((x) => x.author_person === pid); return (m && m.display_name) || pid; };
  const projById = new Map<any, any>(projects.map((p) => [p.id, p]));
  const myIds = new Set(projects.map((p) => p.id));

  // 댓글·변경 피드는 최근 갱신 상위 K개 프로젝트만(과다 요청 방지 — 활동은 대개 최근 프로젝트에 몰림).
  const K = 12;
  const topIds = projects.slice()
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, K).map((p) => p.id);

  const [acts, feeds, sess, scfg] = await Promise.all([
    api('/api/ui/activity/list?limit=100').then((d) => (Array.isArray(d) ? d : (d && d.rows) || [])).catch(() => []),
    Promise.all(topIds.map((id) =>
      api('/api/ui/v6/projects/' + id + '/comments')
        .then((d) => ({ id, feed: (d && d.feed) || [] })).catch(() => ({ id, feed: [] })))),
    api('/api/ui/terminal/sessions').then((d) => (d && d.sessions) || []).catch(() => []), // 세션 초대용
    api('/api/ui/terminal/config').catch(() => null),
  ]);
  const memberName = (id) => { const m = ((scfg && scfg.members) || []).find((x) => x.id === id); return (m && m.name) || id || ''; };

  const items: any[] = [];
  // (1) 활동 — 내 프로젝트 + 내가 아닌 사람. 동사형 문장(누가 ~했어요) + 상세는 summary.
  for (const a of acts) {
    if (!myIds.has(a.project_id) || (a.author_person && a.author_person === meId)) continue;
    items.push({ ts: a.committed_at || a.created_at, kind: 'act', pref: a.type === 'chore' ? 'chore' : 'activity', tone: DASH_ACT_TONE[a.type] || 'mut',
      verb: DASH_ACT_VERB[a.type] || '작업했어요', snippet: a.summary || a.title || '',
      actorPerson: a.author_person, agent: a.author_agent, who: nameOf(a.author_person) || a.author_agent || '누군가',
      pid: a.project_id, proj: projById.get(a.project_id)?.name || '' });
  }
  // (2) 프로젝트 피드 — 댓글/멘션/새항목/필드변경. 내가 한 건 제외.
  for (const { id, feed } of feeds) {
    const pname = projById.get(id)?.name || '';
    for (const f of feed) {
      if (f.actor && f.actor === meId) continue;
      const who = f.display_name || nameOf(f.actor) || '누군가';
      const base = { ts: f.ts, actorPerson: f.actor, who, pid: id, proj: pname };
      if (f.kind === 'comment') {
        const body = String(f.body || '').replace(/\s+/g, ' ').trim();
        const mentioned = !!myName && (body.includes('@' + myName) || (!!meId && body.includes('@' + meId)));
        items.push({ ...base, kind: mentioned ? 'mention' : 'comment', pref: mentioned ? 'mention' : 'comment',
          verb: mentioned ? '나를 언급했어요' : '댓글을 남겼어요', snippet: body || '(내용 없음)' });
      } else if (f.kind === 'event' && f.field === 'created') {
        items.push({ ...base, kind: 'created', pref: 'created', verb: '새로 만들었어요', snippet: '' });
      } else if (f.kind === 'event' && f.field) {
        items.push({ ...base, kind: 'update', pref: dashFieldPref(f.field), verb: eventLabel(f), snippet: '' });
      }
    }
  }
  // (3) 세션 초대 — 나를 초대한(내가 소유 아님) AI 세션. created 를 시각으로.
  for (const s of sess) {
    if (s.owned) continue;
    items.push({ ts: s.created ? new Date((Number(s.created) || 0) * 1000).toISOString() : '', kind: 'invite', pref: 'session_invite',
      verb: 'AI 세션에 초대했어요', snippet: s.label || '(이름 없음)', who: memberName(s.owner) || '누군가', actorPerson: s.owner,
      sid: s.id, label: s.label });
  }

  // (4) 다가오는/지난 마감 — 마감일 있는 미완 프로젝트(7일 이내 or 지남).
  const due = projects
    .map((p) => ({ p, n: dueInDays(p.due_date) }))
    .filter((x) => x.n != null && x.p.status !== 'done' && (x.n as number) <= 7)
    .sort((a, b) => (a.n as number) - (b.n as number));

  items.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  for (const it of items) it.key = it.kind + '|' + (it.pid || it.sid || '') + '|' + (it.ts || '');

  // 헤더 우상단 통일 컨트롤 — ⚙(알림 설정) + →(작업 로그 딥링크). render 는 아래 const 로 정의(클릭 시점엔 초기화 완료).
  dashCtl(zone, { gear: { title: '알림 설정', open: (a) => openNotifPrefs(a, render) }, action: { href: '#/projects2/worklog', title: '작업 로그 탭으로' } });

  // 프리셋으로 걸러 렌더 + 읽음/안읽음(인박스). 설정·모두읽음 변경 시 재렌더(재요청 없이).
  const render = () => {
    const prefs = dashNotifPrefs();
    const read = dashNotifReadSet();
    const feedItems = items.filter((it) => prefs[it.pref]).slice(0, 24);
    const dueShown = prefs.due ? due : [];
    const unread = feedItems.filter((it) => !read.has(it.key));
    // 헤더: 안 읽음 수 뱃지(있으면) + '모두 읽음' 액션.
    zone.countEl.replaceChildren(unread.length
      ? el('span', { class: 'dash-ntf-unreadn', text: String(unread.length) + ' 안 읽음' })
      : (feedItems.length ? el('span', { class: 'dash-ntf-alldone', text: '다 읽음' }) : el('span')));
    if (unread.length) {
      const markBtn = el('button', { class: 'dash-ntf-markall', type: 'button', text: '모두 읽음' });
      markBtn.onclick = () => { const s = dashNotifReadSet(); feedItems.forEach((it) => s.add(it.key)); dashSaveNotifRead(s); render(); };
      zone.chipsEl.replaceChildren(markBtn);
    } else zone.chipsEl.replaceChildren();
    if (!dueShown.length && !feedItems.length) {
      zone.body.replaceChildren(dashEmpty(items.length || due.length
        ? '표시할 알림이 없어요. ⚙에서 유형을 켜 보세요.'
        : '새 알림이 없어요. 내 프로젝트에 활동·댓글·멘션이 생기면 여기 모여요.'));
      return;
    }
    const frag: any[] = [];
    if (dueShown.length) {
      frag.push(el('div', { class: 'dash-ghead', text: '다가오는 마감' }));
      for (const { p, n } of dueShown) frag.push(dashDueRow(p, n as number));
    }
    if (feedItems.length) {
      if (dueShown.length) frag.push(el('div', { class: 'dash-ghead', text: '알림' }));
      for (const it of feedItems) frag.push(notifRow(it, !read.has(it.key)));
    }
    zone.body.replaceChildren(...frag);
  };
  render();
}

// 알림 한 줄 — [유형 타일] [행위자(굵게)+동사 ·시간] / [프로젝트·스니펫] · 안읽음이면 파란 점. 클릭 시 읽음 처리.
function notifRow(it, unread) {
  const time = it.ts ? relTime(it.ts) : '';
  const head = el('span', { class: 'dash-ntf-head' },
    el('b', { class: 'dash-ntf-who', text: it.who + (it.actorPerson ? '님' : '') }),
    el('span', { text: (it.actorPerson ? '이 ' : ' · ') + it.verb }));
  const metaBits = [it.proj, it.snippet].filter(Boolean).join(' · ');
  const main = el('span', { class: 'dash-ntf-main' },
    el('span', { class: 'dash-ntf-line' }, head, el('span', { class: 'dash-ntf-time', text: time })),
    metaBits ? el('span', { class: 'dash-ntf-sub', title: metaBits, text: metaBits }) : null);
  const href = it.kind === 'invite' ? '#/terminal' : '#/projects2/p/' + it.pid;
  const row = el('a', { class: 'dash-ntf' + (unread ? ' unread' : ''), href },
    dashNotifTile(it), main,
    unread ? el('span', { class: 'dash-ntf-udot', title: '안 읽음', 'aria-label': '안 읽음' }) : null);
  row.addEventListener('click', () => { const s = dashNotifReadSet(); s.add(it.key); dashSaveNotifRead(s); });
  return row;
}
// 마감 알림 — 시계 타일(임박=앰버·지남=코럴) + 프로젝트(굵게) + 마감 라벨 + D-뱃지. (마감은 상시 리마인더라 읽음 대상 아님)
function dashDueRow(p, n) {
  const overdue = n < 0;
  const badge = overdue ? '지남' : (n === 0 ? 'D-day' : 'D-' + n);
  return el('a', { class: 'dash-ntf dash-ntf--due', href: '#/projects2/p/' + p.id },
    el('span', { class: 'dash-ntf-tile ' + (overdue ? 't-coral' : 't-amber') }, dashClockIcon()),
    el('span', { class: 'dash-ntf-main' },
      el('span', { class: 'dash-ntf-line' },
        el('b', { class: 'dash-ntf-who', title: p.name, text: p.name }),
        el('span', { class: 'dash-ntf-dbadge' + (overdue ? ' overdue' : ''), text: badge })),
      el('span', { class: 'dash-ntf-sub', text: '마감 ' + dueLabel(n) })));
}
// 유형 타일 — 라운드 스퀘어(앱 아이콘 톤) + 유형색 글리프. 피드의 둥근 점과 명확히 구분되는 '알림' 시그니처.
function dashNotifTile(it) {
  const kind = it.kind;
  let cls, glyph;
  if (kind === 'mention') { cls = 't-blue'; glyph = el('span', { class: 'dash-ntf-glyph', text: '@' }); }
  else if (kind === 'comment') { cls = 't-teal'; glyph = dashCommentIcon(); }
  else if (kind === 'invite') { cls = 't-indigo'; glyph = dashSessionIcon(); }
  else if (kind === 'created') { cls = 't-mint'; glyph = el('span', { class: 'dash-ntf-glyph', text: '＋' }); }
  else if (kind === 'act') { cls = 'tn-' + (it.tone || 'mut'); glyph = dashSparkIcon(); }
  else if (it.pref === 'assign') { cls = 't-violet'; glyph = dashPersonIcon(); } // 담당자 변경
  else { cls = 't-slate'; glyph = el('span', { class: 'dash-ntf-glyph', text: '✎' }); } // 상태·이름·필드 변경
  return el('span', { class: 'dash-ntf-tile ' + cls }, glyph);
}
function dashGearIcon() {
  const n = sv('svg', { class: 'dash-gear', viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 12, cy: 12, r: 3 }),
    sv('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }));
  return n;
}
function dashClockIcon() {
  const n = sv('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 12, cy: 12, r: 9 }), sv('path', { d: 'M12 7v5l3 2' }));
  return n;
}
function dashCommentIcon() {
  const n = sv('svg', { viewBox: '0 0 24 24', width: 9, height: 9, fill: 'currentColor', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z' }));
  return n;
}
function dashSessionIcon() {
  const n = sv('svg', { viewBox: '0 0 24 24', width: 9, height: 9, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M5 7l4 5-4 5' }), sv('path', { d: 'M13 17h6' }));
  return n;
}
// 활동(커밋·기능 등) — 번개 글리프.
function dashSparkIcon() {
  const n = sv('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'currentColor', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M13 2 4.5 13.5H11l-1 8.5L19.5 10H13z' }));
  return n;
}
// 담당자 변경 — 사람 글리프.
function dashPersonIcon() {
  const n = sv('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 12, cy: 8, r: 3.4 }), sv('path', { d: 'M5.5 20a6.5 6.5 0 0 1 13 0' }));
  return n;
}

// ── 알림 사용자화 팝업 — 유형 체크박스(그룹별), 기기별 저장, 변경 즉시 재렌더 ──
function openNotifPrefs(anchor, onChange) {
  const prefs = dashNotifPrefs();
  const panel = el('div', { class: 'dash-pop-panel' });
  panel.append(el('div', { class: 'dash-pop-head' },
    el('strong', { text: '표시할 알림' }),
    el('span', { class: 'dash-pop-sub', text: '이 기기에 저장돼요' })));
  for (const g of DASH_NOTIF_GROUPS) {
    panel.append(el('div', { class: 'dash-pop-gh', text: g.title }));
    for (const it of g.items) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!prefs[it.key];
      cb.onchange = () => { prefs[it.key] = cb.checked; dashSaveNotifPrefs(prefs); onChange(); };
      panel.append(el('label', { class: 'dash-pop-row' }, cb,
        el('span', { class: 'dash-pop-txt' },
          el('span', { class: 'dash-pop-name', text: it.label }),
          el('span', { class: 'dash-pop-desc', text: it.desc }))));
    }
  }
  dashPopover(anchor, panel);
}
// 경량 팝오버 — anchor 아래 고정 배치, 바깥클릭·Esc 로 닫힘.
function dashPopover(anchor, panel) {
  document.querySelectorAll('.dash-pop').forEach((n) => n.remove());
  panel.classList.add('dash-pop');
  document.body.append(panel);
  const r = anchor.getBoundingClientRect();
  const pw = panel.offsetWidth || 260;
  panel.style.left = Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8)) + 'px';
  panel.style.top = (r.bottom + 6) + 'px';
  const close = () => { panel.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); };
  const onDoc = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  setTimeout(() => { document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); }, 0);
  return close;
}
// 중첩 서브메뉴 — dashPopover 와 달리 부모 팝오버(.dash-pop)를 지우지 않는다(팝오버 안 항목의 상태 메뉴 등). 위(z-90)에 뜬다.
function dashSubMenu(anchor, panel) {
  document.querySelectorAll('.dash-submenu').forEach((n) => n.remove()); // 다른 서브메뉴만 정리
  panel.classList.add('dash-submenu');
  document.body.append(panel);
  const r = anchor.getBoundingClientRect();
  const pw = panel.offsetWidth || 180;
  panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8)) + 'px';
  panel.style.top = (r.bottom + 4) + 'px';
  const close = () => { panel.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); };
  const onDoc = (e) => { if (!panel.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  setTimeout(() => { document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); }, 0);
  return close;
}
// 단일 선택 팝오버 — [제목] + 라디오형 옵션 목록. 선택 시 닫고 onPick(key). 위젯 ⚙(기본값 설정) 공용.
function dashChoicePopover(anchor, title, options, current, onPick) {
  const panel = el('div', { class: 'dash-pop-panel' });
  panel.append(el('div', { class: 'dash-pop-head' }, el('strong', { text: title }), el('span', { class: 'dash-pop-sub', text: '이 기기에 저장돼요' })));
  let close = () => { /* dashPopover 반환값으로 대체됨 */ };
  for (const [k, label] of options) {
    const row = el('button', { class: 'dash-pop-opt' + (k === current ? ' sel' : ''), type: 'button' },
      el('span', { class: 'dash-pop-name', text: label }),
      k === current ? el('span', { class: 'dash-pop-check', text: '✓' }) : null);
    row.onclick = () => { close(); onPick(k); };
    panel.append(row);
  }
  close = dashPopover(anchor, panel);
}
// 태스크 상태 점 색 — 네이티브 팔레트와 통일(#req 상태색 일관: 회색 할일·주황 진행·초록 완료).
function dashTaskDot(t) {
  const c = t.status_category || t.status;
  if (c === 'done' || c === 'closed') return '#22c55e';
  return t.status === 'todo' ? '#94a3b8' : '#f59e0b';
}
// 하위태스크 아이콘 클릭 → 그 프로젝트의 태스크 목록 팝오버(#req). 클릭 시 프로젝트 상세로.
// #req 프로젝트 행 '⋯' 관리 메뉴 — 삭제(POST /projects/:id/delete). onChanged=위젯 새로고침.
function openProjRowMenu(anchor, p, onChanged) {
  const panel = el('div', { class: 'dash-pop-panel' });
  let close = () => { /* 대체됨 */ };
  const del = el('button', { class: 'dash-pop-opt danger', type: 'button' }, el('span', { class: 'dash-pop-name', text: '삭제' }));
  del.onclick = async () => {
    close();
    if (!confirm('프로젝트 ‘' + (p.name || '') + '’을(를) 삭제할까요?\n하위 태스크·세션 연결 포함 되돌릴 수 없어요.')) return;
    try { await api('/api/ui/v6/projects/' + p.id + '/delete', { method: 'POST', body: '{}' }); toast('프로젝트를 삭제했어요'); onChanged && onChanged(); }
    catch (e: any) { toast('삭제 실패 — ' + (e && e.message || e), true); }
  };
  panel.append(del);
  close = dashPopover(anchor, panel);
}
// 태스크 native 상태 3단계(할 일·진행 중·완료) — 색은 프로젝트 상태 아이콘과 통일.
const DASH_TASK_STATUS = [
  { key: 'todo', label: '할 일', mk: () => dashStatusIconSvg('active', '#94a3b8', 0) },
  { key: 'in_progress', label: '진행 중', mk: () => dashStatusIconSvg('active', '#f59e0b', 0.5) },
  { key: 'done', label: '완료', mk: () => dashStatusIconSvg('done', '#22c55e') },
];
function dashTaskStatusIcon(t) {
  if (t.status === 'done' || t.status_category === 'done' || t.status_category === 'closed') return dashStatusIconSvg('done', '#22c55e');
  if (t.status === 'todo') return dashStatusIconSvg('active', '#94a3b8', 0);
  return dashStatusIconSvg('active', '#f59e0b', 0.5);
}
// 태스크 상태 아이콘 = 클릭 시 상태 변경 메뉴(#req). 태스크는 native(todo|in_progress|done) — POST /tasks/:id {status}(프로젝트 탭과 동일).
function dashTaskStatusControl(t, onChanged) {
  const btn = el('button', { class: 'dash-taskstatus-btn', type: 'button', title: '상태 변경', 'aria-label': '상태 변경' }, dashTaskStatusIcon(t));
  btn.addEventListener('click', (e: any) => {
    e.preventDefault(); e.stopPropagation();
    const cur = (t.status === 'done' || t.status_category === 'done' || t.status_category === 'closed') ? 'done' : (t.status || 'todo');
    const menu = el('div', { class: 'dash-statusmenu' });
    const close = dashSubMenu(btn, menu); // 부모 팝오버(.dash-pop)를 안 닫는 중첩 메뉴
    for (const st of DASH_TASK_STATUS) {
      const isCur = cur === st.key;
      const item = el('button', { class: 'pjv-menu-item' + (isCur ? ' sel' : ''), type: 'button' }, st.mk(), el('span', { text: st.label }));
      item.onclick = async () => { close(); if (isCur) return; try { await api('/api/ui/v6/tasks/' + t.id, { method: 'POST', body: JSON.stringify({ status: st.key }) }); toast('상태를 변경했어요'); onChanged && onChanged(); } catch (e2: any) { toast('실패 — ' + (e2 && e2.message || e2), true); } };
      menu.append(item);
    }
  });
  return btn;
}
async function openProjTasksPopover(anchor, p, onWidgetChanged) {
  const panel = el('div', { class: 'dash-pop-panel dash-listpop' });
  const mode = dashTaskCountMode();
  panel.append(el('div', { class: 'dash-pop-head' }, el('strong', { title: p.name, text: p.name }), el('span', { class: 'dash-pop-sub', text: mode === 'active' ? '진행 중 태스크' : '태스크' })));
  const box = el('div', { class: 'dash-listpop-body' }); box.append(skeleton('불러오는 중'));
  panel.append(box);
  dashPopover(anchor, panel);
  const isTaskDone = (t) => t.status === 'done' || t.status_category === 'done' || t.status_category === 'closed';
  const load = async () => {
    let d;
    try { d = await api('/api/ui/v6/projects/' + p.id); } // ⚠ 응답은 { project: {...tasks} } — d.project.tasks
    catch (e: any) { box.replaceChildren(errorNote(e, '태스크를 불러오지 못했습니다')); return; }
    let tasks = (d && (d.project ? d.project.tasks : d.tasks)) || [];
    if (mode === 'active') tasks = tasks.filter((t) => !isTaskDone(t)); // 칩(진행 중만)과 일치 — 할 일도 active 포함
    if (!tasks.length) { box.replaceChildren(el('div', { class: 'dash-pop-desc', text: mode === 'active' ? '진행 중인 태스크가 없어요.' : '태스크가 없어요.' })); return; }
    const onChanged = () => { load(); onWidgetChanged && onWidgetChanged(); }; // 상태 바꾸면 목록 재로드 + 위젯 새로고침(칩 수)
    box.replaceChildren(...tasks.map((t) => el('div', { class: 'dash-listpop-row dash-listpop-task', title: t.name || '' },
      dashTaskStatusControl(t, onChanged),
      el('a', { class: 'dash-listpop-nm', href: '#/projects2/p/' + p.id, text: t.name || '(제목 없음)' }))));
  };
  load();
}
// 세션 배지 클릭 → 들어갈 세션 선택(#req). 1개면 바로 열기, 여러 개면 팝아웃 선택.
async function openProjSessionsPicker(anchor, p) {
  let sess: any[];
  // #req 버그수정 — /terminal/sessions 는 프로젝트 세션을 숨긴다(터미널 탭 정책). 프로젝트 세션은 /projects/:id/sessions 에서 받고 내 것(owned)만.
  try { const d = await api('/api/ui/v6/projects/' + p.id + '/sessions'); sess = ((d && d.sessions) || []).filter((s) => s.owned); }
  catch { toast('세션을 불러오지 못했습니다', true); return; }
  const openSess = (s) => window.open('/ui/terminal.html?session=' + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || ''), '_blank');
  if (!sess.length) { toast('이 프로젝트의 내 세션이 없어요.'); return; }
  if (sess.length === 1) { openSess(sess[0]); return; }
  const panel = el('div', { class: 'dash-pop-panel dash-listpop' });
  panel.append(el('div', { class: 'dash-pop-head' }, el('strong', { title: p.name, text: p.name }), el('span', { class: 'dash-pop-sub', text: '들어갈 세션' })));
  let close = () => { /* 아래에서 대체 */ };
  for (const s of sess.sort((a, b) => (b.attached ? 1 : 0) - (a.attached ? 1 : 0))) {
    const row = el('button', { class: 'dash-listpop-row', type: 'button', title: s.label || '' },
      el('span', { class: 'dash-listpop-dot', style: 'background:' + (s.attached ? '#22c55e' : '#94a3b8') }),
      el('span', { class: 'dash-listpop-nm', text: s.label || '(이름 없음)' }),
      s.attached ? el('span', { class: 'dash-listpop-live', text: '접속중' }) : null);
    row.onclick = () => { close(); openSess(s); };
    panel.append(row);
  }
  close = dashPopover(anchor, panel);
}
// ── R11.1 새 프로젝트 만들기 — 경량 모달(이름 입력 + 현재 리스트에 생성). POST /api/ui/v6/projects. ──
function dashCreateProject(listId, listById, onDone) {
  const l = listId ? listById.get(listId) : null;
  const input = el('input', { class: 'dash-cp-input', type: 'text', placeholder: '새 프로젝트 이름', 'aria-label': '새 프로젝트 이름' });
  const err = el('div', { class: 'dash-cp-err' });
  const submitBtn = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '만들기' });
  const submit = async () => {
    const name = (input.value || '').trim();
    if (!name) { input.focus(); return; }
    submitBtn.disabled = true; err.textContent = '';
    try {
      await api('/api/ui/v6/projects', { method: 'POST', body: JSON.stringify({ name, list_id: listId || undefined }) });
      toast('프로젝트를 만들었어요'); close(); onDone && onDone();
    } catch (e: any) { err.textContent = '실패 — ' + (e && e.message || e); submitBtn.disabled = false; }
  };
  submitBtn.onclick = submit;
  input.addEventListener('keydown', (e: any) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  const form = el('div', { class: 'dash-cp' },
    el('div', { class: 'dash-cp-where', text: l ? '리스트: ' + (l.name || '미분류') : '미분류(리스트 없음)' }),
    input, err, el('div', { class: 'dash-cp-foot' }, submitBtn));
  const close = dashModal('새 프로젝트', form);
  setTimeout(() => input.focus(), 30);
}
// ── R10+R11 리스트 프로젝트 팝업 — 그 리스트의 프로젝트를 프로젝트 탭식으로(상태·체크박스·벌크·새 프로젝트). 대시보드 네이티브 경량. ──
async function openListProjectsModal(listId, listById, onChanged) {
  const l = listId ? listById.get(listId) : null;
  const title = (l && l.name) || '미분류';
  const body = el('div', { class: 'dash-lpm' });
  const close = dashModal(title + ' · 프로젝트', body, true);
  const isDone = (p) => p.status === 'done' || p.status_category === 'done' || p.status_category === 'closed';
  const selected = new Set<number>();
  let projs: any[] = [];
  const notify = () => { onChanged && onChanged(); };
  const reload = async () => {
    body.replaceChildren(el('div', { class: 'dash-lpm-load' }, skeleton('불러오는 중')));
    try { const d = await api('/api/ui/v6/projects?mine=1'); projs = ((d && d.projects) || []).filter((p) => (p.list_id || 0) === (listId || 0)); }
    catch (e) { body.replaceChildren(errorNote(e, '프로젝트를 불러오지 못했습니다')); return; }
    const ids = new Set(projs.map((p) => p.id)); for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
    render();
  };
  const bulk = async (fn, okMsg) => {
    const ids = [...selected]; if (!ids.length) return;
    let failed = 0;
    for (const id of ids) { try { await fn(id); } catch { failed++; } }
    toast(failed ? (okMsg + ' (' + failed + '건 실패)') : okMsg, !!failed);
    selected.clear(); await reload(); notify();
  };
  const bar = el('div', { class: 'dash-bulkbar', hidden: true });
  const openMoveMenu = (anchor) => {
    const panel = el('div', { class: 'dash-pop-panel' });
    panel.append(el('div', { class: 'dash-pop-head' }, el('strong', { text: '리스트로 이동' })));
    let closeM = () => { /* 아래 대체 */ };
    const opt = (lid, label) => { const b = el('button', { class: 'dash-pop-opt', type: 'button' }, el('span', { class: 'dash-pop-name', text: label })); b.onclick = () => { closeM(); bulk((id) => api('/api/ui/v6/projects/' + id + '/list', { method: 'POST', body: JSON.stringify({ list_id: lid }) }), '리스트를 옮겼어요'); }; panel.append(b); };
    for (const x of listById.values()) opt(x.id, x.name || '(이름 없음)');
    opt(null, '미분류');
    closeM = dashPopover(anchor, panel);
  };
  const renderBar = () => {
    const n = selected.size; bar.hidden = n === 0; if (!n) return;
    bar.replaceChildren(
      el('span', { class: 'dash-bulkbar-n', text: n + '개 선택' }),
      el('button', { class: 'dash-bulkbar-btn', type: 'button', text: '완료로', onclick: () => bulk((id) => api('/api/ui/v6/projects/' + id + '/status', { method: 'POST', body: JSON.stringify({ status: 'done' }) }), '완료로 옮겼어요') }),
      el('button', { class: 'dash-bulkbar-btn', type: 'button', text: '리스트 이동', onclick: (e: any) => openMoveMenu(e.currentTarget) }),
      el('button', { class: 'dash-bulkbar-btn danger', type: 'button', text: '삭제', onclick: () => { if (confirm(n + '개 프로젝트를 삭제할까요? 되돌릴 수 없어요.')) bulk((id) => api('/api/ui/v6/projects/' + id + '/delete', { method: 'POST', body: '{}' }), '삭제했어요'); } }),
      el('button', { class: 'dash-bulkbar-x', type: 'button', title: '선택 해제', 'aria-label': '선택 해제', text: '✕', onclick: () => { selected.clear(); render(); } }));
  };
  const render = () => {
    const head = el('div', { class: 'dash-lpm-head' },
      el('span', { class: 'dash-lpm-count', text: projs.length + '개 프로젝트' }),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '+ 새 프로젝트', onclick: () => dashCreateProject(listId, listById, () => { reload(); notify(); }) }));
    const list = el('div', { class: 'dash-lpm-list' });
    if (!projs.length) list.append(dashEmpty('이 리스트에 프로젝트가 없어요.'));
    for (const p of projs) {
      const cb = el('input', { type: 'checkbox', 'aria-label': p.name + ' 선택' }); cb.checked = selected.has(p.id);
      const row = el('div', { class: 'dash-lpm-row' + (selected.has(p.id) ? ' sel' : '') });
      cb.onchange = () => { if (cb.checked) selected.add(p.id); else selected.delete(p.id); row.classList.toggle('sel', cb.checked); renderBar(); };
      row.append(
        el('label', { class: 'dash-lpm-check' }, cb),
        dashProjStatusControl(p, listById, () => { reload(); notify(); }),
        el('a', { class: 'dash-lpm-nm' + (isDone(p) ? ' done' : ''), href: '#/projects2/p/' + p.id, title: p.name, text: p.name || '(제목 없음)', onclick: () => close() }),
        (() => { const c = dashTaskChip(p); return c ? el('span', { class: 'dash-lpm-meta', title: c.title, text: '태스크 ' + c.text }) : null; })(),
        p.my_session_count ? el('span', { class: 'dash-badge', text: '세션 ' + p.my_session_count }) : null);
      list.append(row);
    }
    body.replaceChildren(head, list, bar);
    renderBar();
  };
  reload();
}
// 딥링크 화살표(→) 아이콘 — 헤더 통일 액션버튼(다른 탭으로 이동).
function dashArrowIcon() {
  const n = sv('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M5 12h13' }), sv('path', { d: 'M13 6l6 6-6 6' }));
  return n;
}
// 확장(⤢) 아이콘 — 헤더 통일 액션버튼(모달 '전체 보기').
function dashExpandIcon() {
  const n = sv('svg', { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M8 3H5a2 2 0 0 0-2 2v3' }), sv('path', { d: 'M16 3h3a2 2 0 0 1 2 2v3' }),
    sv('path', { d: 'M21 16v3a2 2 0 0 1-2 2h-3' }), sv('path', { d: 'M3 16v3a2 2 0 0 0 2 2h3' }));
  return n;
}
// 폴더 브라우저 뷰 토글 아이콘 — 아이콘(그리드) / 목록(라인).
function dashViewIconIcon() {
  const n = sv('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('rect', { x: 4, y: 4, width: 7, height: 7, rx: 1.5 }), sv('rect', { x: 13, y: 4, width: 7, height: 7, rx: 1.5 }),
    sv('rect', { x: 4, y: 13, width: 7, height: 7, rx: 1.5 }), sv('rect', { x: 13, y: 13, width: 7, height: 7, rx: 1.5 }));
  return n;
}
function dashViewListIcon() {
  const n = sv('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M8 6h12' }), sv('path', { d: 'M8 12h12' }), sv('path', { d: 'M8 18h12' }),
    sv('path', { d: 'M4 6h.01' }), sv('path', { d: 'M4 12h.01' }), sv('path', { d: 'M4 18h.01' }));
  return n;
}
// 필드 변경 이벤트 → 한국어 한 줄.
function eventLabel(f) {
  const lbl = DASH_FIELD_LABEL[f.field] || f.label || f.field || '항목';
  if (f.field === 'status' && f.to) return `상태를 '${f.to}'(으)로 변경`;
  if (f.field === 'name') return '이름을 바꿨어요';
  if (f.field === 'description') return '내용을 수정했어요';
  if (f.field === 'assignee') return '담당자를 바꿨어요';
  if (f.to) return `${lbl} 변경 → ${f.to}`;
  return `${lbl} 변경`;
}
// 마감까지 일수(자정 기준, 음수=지남). 없으면 null.
function dueInDays(dateStr) {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  if (isNaN(+d)) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((+d - +today) / 86400000);
}
function dueLabel(n) { return n < 0 ? Math.abs(n) + '일 지남' : (n === 0 ? '오늘' : n + '일 뒤'); }

export {
  renderMyDashboard,
};

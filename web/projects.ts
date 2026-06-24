// projects.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { TOKEN_KEY, api, applyReveal, el, errorNote, lifecycleDot, relTime, safeHref, selectFilter, state, sv, toast } from './core.js';
import { SPACE_LABEL, knInjectChip, knProvChip, knSideItem, spaceSubBar } from './knowledge.js';
import { activityTimelineRow } from './dashboard.js';
import { overlayBox, skeleton, skeletonRows } from './learn.js';
import { teamRow } from './terminal.js';
import { field, overlay } from './admin.js';
import { PJV_TAG_NONE, pjvOpenTaskModal } from './taskmodal.js';


// ════════════════════════════════════════════
// 프로젝트(v2) #/projects2 — 맥락 = 카테고리 + 지식 + 프로젝트 중 '프로젝트'(= 맥락의 *변화*).
//  지식 탭과 대칭인 하위 탭: [대시보드 · 작업 현황 · 사업 · 제품 · 시스템].
//   · 대시보드 = 프로젝트 보드(level='project' 카드, 진행중/완료)
//   · 작업 현황 = 기존 #/dash(사람×AI 작업현황)를 하위 탭으로 흡수(renderDashboard 재사용)
//   · 사업·제품·시스템 = 카테고리(space)로 프로젝트를 훑는 2분할(지식 탭의 renderKnowledgeSpace 패턴 재사용)
//  데이터: GET /api/ui/v6/projects(보드·space목록)·/:id(상세) + POST .../status,/tasks,/members,/category,/knowledge,
//   POST /api/ui/v6/tasks/:id/status, GET /api/ui/categories(사이드바). (백엔드 projects-v6 — 이미 구현됨.)
// ════════════════════════════════════════════
const PJV_STATUS_LABEL = { active: '진행 중', done: '완료' };

// 프로젝트 하위 탭 바 — spaceSubBar(#/projects2)로 사업·제품·시스템 칩을 만들고, 앞에 대시보드·작업 현황을 끼운다.
//  지식 탭의 knowledgeSubBar 와 같은 짜임(.sub-cats/.sub-cat). active ∈ {dashboard,activity,business,product,system}.
function projectSubBar(active) {
  const bar = spaceSubBar('#/projects2', SPACE_LABEL[active] ? active : '');
  // 앞쪽에 대시보드·작업 현황 칩을 끼워 넣는다(space 칩보다 먼저).
  const lead = [['dashboard', '대시보드', '#/projects2/dashboard']];
  const refNode = bar.firstChild;
  for (const [key, label, href] of lead) {
    const on = key === active;
    bar.insertBefore(el('a', { class: 'sub-cat' + (on ? ' active' : ''), href,
      role: 'tab', 'aria-selected': on ? 'true' : 'false', text: label }), refNode);
  }
  return bar;
}

// 프로젝트(v2) 진입 — sub ∈ {dashboard, activity, business, product, system}.
async function renderProjectsV2(view, sub, params) {
  if (SPACE_LABEL[sub]) return renderProjectV2Space(view, sub, params);
  return renderProjectV2Board(view);
}

// 대시보드 — 프로젝트 보드(level='project'). 진행 중/완료 두 섹션 + [+ 새 프로젝트] + [선택→일괄삭제].
//  선택 모드: 내가 만든(created_by==나) 프로젝트만 체크 가능 — 진행 중·완료에 걸쳐 여러 개를 골라 한 번에 삭제.
async function renderProjectV2Board(view) {
  view.replaceChildren(projectSubBar('dashboard'), skeleton('프로젝트를 불러오는 중'));
  const head = el('div', { class: 'page-head' },
    el('h1', {}, '프로', el('span', { class: 'accent', text: '젝트' })),
  );

  let projects: any;
  try {
    projects = await api('/api/ui/v6/projects?mine=1').then((d) => (d && d.projects) || []);
  } catch (e) {
    view.replaceChildren(head, projectSubBar('dashboard'), errorNote(e, '프로젝트를 불러오지 못했습니다'));
    return;
  }

  const reload = () => renderProjectV2Board(view);
  const meId = (state.me && (state.me.userId || state.me.email)) || '';
  // 삭제 가능 = 내가 만든 것(서버 actor=userId||email 파생과 동일 규칙). 서버도 403 으로 재검증.
  const canDelete = (p) => !!meId && p.created_by != null && String(p.created_by) === String(meId);
  const deletable = projects.filter(canDelete);
  const active = projects.filter((p) => p.status !== 'done');
  const done = projects.filter((p) => p.status === 'done');
  const OPTS_BASE = { statusBase: '/api/ui/v6/projects/', detailBase: '#/projects2/p/' };

  // 선택(일괄삭제) 상태 — 리페치 없이 로컬 재페인트. ids = 선택된 프로젝트 id 집합.
  const sel = { mode: false, ids: new Set() };
  const headActions = el('div', { class: 'card-head-actions' });
  const bulkBar = el('div', { class: 'bulk-bar', hidden: true });
  const sectionsBox = el('div', {});

  function repaintBulk() {
    if (!sel.mode) { bulkBar.hidden = true; bulkBar.replaceChildren(); return; }
    const n = sel.ids.size;
    const allOn = deletable.length > 0 && deletable.every((p) => sel.ids.has(p.id));
    const allBtn = el('button', { class: 'btn btn-ghost btn-sm', text: allOn ? '전체 해제' : '전체 선택',
      onclick: () => { if (allOn) sel.ids.clear(); else deletable.forEach((p) => sel.ids.add(p.id)); repaint(); } });
    const delBtn = el('button', { class: 'btn btn-sm btn-danger', text: '선택 삭제', disabled: n === 0,
      onclick: () => bulkDelete(delBtn) });
    bulkBar.hidden = false;
    bulkBar.replaceChildren(
      el('span', { class: 'bulk-bar-count', text: n ? n + '개 선택됨' : '삭제할 프로젝트를 고르세요' }),
      el('div', { class: 'bulk-bar-actions' }, allBtn, delBtn));
  }

  function repaint() {
    // 헤더 우측 — 선택모드 토글(삭제 가능한 프로젝트가 있을 때만) + 새 프로젝트.
    const newBtn = el('button', { class: 'btn btn-primary', text: '+ 새 프로젝트', onclick: () => openProjectV2Form(reload) });
    if (sel.mode) {
      const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => { sel.mode = false; sel.ids.clear(); repaint(); } });
      headActions.replaceChildren(cancelBtn, newBtn);
    } else {
      const selectBtn = deletable.length
        ? el('button', { class: 'btn btn-ghost', text: '선택', title: '여러 프로젝트를 골라 한 번에 삭제', onclick: () => { sel.mode = true; repaint(); } })
        : null;
      headActions.replaceChildren(selectBtn, newBtn);
    }
    const opts = Object.assign({}, OPTS_BASE,
      { select: sel.mode ? { ids: sel.ids, canSelect: canDelete, onToggle: repaintBulk } : null });
    sectionsBox.replaceChildren(
      projectSection('진행 중', active, '아직 진행 중인 프로젝트가 없습니다. ‘+ 새 프로젝트’로 시작하세요.', reload, false, opts),
      projectSection('완료', done, '완료한 프로젝트가 아직 없습니다.', reload, true, opts),
    );
    repaintBulk();
  }

  async function bulkDelete(btn) {
    const ids = [...sel.ids];
    if (!ids.length) return;
    if (!confirm(ids.length + '개 프로젝트를 삭제할까요?\n\n각 프로젝트와 그 작업(태스크·하위)이 함께 사라집니다(되돌릴 수 없음). 연결된 지식은 보존됩니다.')) return;
    btn.disabled = true;
    // 병렬 삭제 — 일부 실패해도 나머지는 진행(성공/실패 건수 보고). 서버가 비소유분은 403.
    const results = await Promise.allSettled(
      ids.map((pid) => api('/api/ui/v6/projects/' + pid + '/delete', { method: 'POST' })));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.length - ok;
    toast(fail ? (ok + '개 삭제 · ' + fail + '개 실패') : (ok + '개 프로젝트를 삭제했습니다'), fail > 0);
    sel.mode = false; sel.ids.clear();
    reload();
  }

  view.replaceChildren(
    head,
    projectSubBar('dashboard'),
    el('div', { class: 'card-head', style: 'margin: 6px 0 14px' },
      el('div', {},
        el('span', { class: 'eyebrow', text: '내 프로젝트' }),
        el('p', { class: 'sub', style: 'margin: 5px 0 0', text: '내가 속한 프로젝트 — 진행 중과 완료.' })),
      headActions),
    bulkBar,
    sectionsBox,
    el('div', { class: 'card-head', style: 'margin: 24px 0 14px' },
      el('div', {},
        el('span', { class: 'eyebrow', text: '회사 전체' }),
        el('p', { class: 'sub', style: 'margin: 5px 0 0', text: '회사에서 지금 진행 중인 모든 작업.' }))),
    companyTimelineSection(),
  );
  repaint();
}

// 보드 한 섹션(진행 중 / 완료) — 카드 + 개수 배지 + 타일 그리드. renderProjects 의 projectSection 짜임 재사용.
function pjvBoardTile(p) {
  const isDone = p.status === 'done';
  const tile = el('div', { class: 'project-tile' + (isDone ? ' done' : ''),
    role: 'link', tabindex: '0', onclick: () => { location.hash = '#/projects2/p/' + p.id; } });
  tile.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') location.hash = '#/projects2/p/' + p.id; });
  tile.append(el('div', { class: 'project-tile-name', text: p.name }));
  if (p.description) tile.append(el('div', { class: 'project-tile-desc', text: p.description }));
  const mc = Number(p.member_count != null ? p.member_count : (p.members ? p.members.length : 0)) || 0;
  const when = isDone ? (p.completed_at || p.updated_at) : (p.updated_at || p.created_at);
  tile.append(el('div', { class: 'project-tile-foot' },
    el('span', { class: 'project-tile-meta', text: (isDone ? '완료 ' : '갱신 ') + (when ? relTime(when) : '') }),
    el('span', { class: 'pjv-tile-badge' },
      el('span', { class: 'pill-state' + (isDone ? '' : ' confirmed'), text: PJV_STATUS_LABEL[p.status] || p.status }),
      mc ? el('span', { class: 'pjv-tile-members', text: '👤 ' + mc }) : null)));
  return tile;
}

// space 뷰(사업·제품·시스템) — 좌(카테고리 사이드바)/우(프로젝트 목록) 2분할. renderKnowledgeSpace 와 같은 패턴.
async function renderProjectV2Space(view, space, params) {
  const f = (state.projects2 = state.projects2 || { space, category: '', status: '' });
  if (f.space !== space) { f.space = space; f.category = ''; }
  if (params && params.has('category')) f.category = params.get('category') || '';
  if (params && params.has('status')) f.status = params.get('status') || '';

  view.replaceChildren(projectSubBar(space), skeleton('프로젝트를 불러오는 중'));
  const head = el('div', { class: 'page-head' },
    el('h1', {}, '프로', el('span', { class: 'accent', text: '젝트' })),
  );

  // 좌측 카테고리 사이드바(이 space 의 카테고리 + '전체'). 지식 탭의 knSideItem 재사용.
  const side = el('aside', { class: 'browse-side' });
  let cats: any[] = [];
  try {
    cats = await api('/api/ui/categories?' + new URLSearchParams({ space })).then((d) => (d && d.categories) || []);
  } catch (_) { /* graceful: 사이드바 생략(목록은 계속) */ }
  function buildSide() {
    const nav = el('nav', { class: 'browse-tree', 'aria-label': '카테고리' });
    nav.append(knSideItem('전체', '', f.category === ''));
    for (const c of cats) nav.append(knSideItem(c.name || c.key, String(c.id), String(f.category) === String(c.id)));
    side.replaceChildren(el('div', { class: 'eyebrow', text: '카테고리' }), nav);
  }
  buildSide();

  // 상단 필터 — 상태 select(전체/진행 중/완료).
  const statusSel = selectFilter([['', '전체 상태'], ['active', '진행 중'], ['done', '완료']], f.status);
  statusSel.setAttribute('aria-label', '상태');
  const listBox = el('div', { class: 'list-box browse-list' });
  const foot = el('div', { class: 'list-foot' });

  function syncHash() {
    const p = new URLSearchParams();
    if (f.category) p.set('category', f.category);
    if (f.status) p.set('status', f.status);
    const qs = p.toString();
    history.replaceState(null, '', '#/projects2/' + space + (qs ? '?' + qs : ''));
  }
  async function refetch() {
    listBox.replaceChildren(skeletonRows(4));
    foot.replaceChildren();
    try {
      const p = new URLSearchParams({ space });
      if (f.category) p.set('category', f.category);
      if (f.status) p.set('status', f.status);
      const projects = await api('/api/ui/v6/projects?' + p.toString()).then((d) => (d && d.projects) || []);
      if (!projects.length) {
        listBox.replaceChildren(el('div', { class: 'empty', text: '조건에 맞는 프로젝트가 없습니다. 필터를 넓혀 보세요.' }));
      } else {
        listBox.replaceChildren(...projects.map(pjvProjectRow));
      }
      foot.replaceChildren(el('span', { class: 'caption', text: projects.length + '건' }));
    } catch (e) {
      listBox.replaceChildren(errorNote(e, '프로젝트를 불러오지 못했습니다'));
    }
  }

  statusSel.addEventListener('change', () => { f.status = statusSel.value; syncHash(); refetch(); });
  side.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-cat-val]');
    if (!item) return;
    ev.preventDefault();
    f.category = item.dataset.catVal || '';
    buildSide(); syncHash(); refetch();
  });

  const filterBar = el('div', { class: 'filter-bar browse-filter' }, statusSel);
  const layout = el('div', { class: 'browse-layout' },
    side,
    el('section', { class: 'browse-main' }, filterBar, listBox, foot),
  );
  view.replaceChildren(head, projectSubBar(space), layout);
  applyReveal([layout]);
  refetch();
}

// 프로젝트 한 행(목록) — 이름(상세 링크) + 상태 칩 + 갱신시각. 지식 탭 knRow 와 같은 .row 짜임.
function pjvProjectRow(p) {
  const isDone = p.status === 'done';
  const when = isDone ? (p.completed_at || p.updated_at) : (p.updated_at || p.created_at);
  const row = el('div', { class: 'row', role: 'link', tabindex: '0' },
    el('div', { class: 'row-title', text: p.name }),
    el('div', { class: 'row-meta' },
      el('span', { class: 'pill-state' + (isDone ? '' : ' confirmed'), text: PJV_STATUS_LABEL[p.status] || p.status }),
      '  ', relTime(when)),
  );
  const go = () => { location.hash = '#/projects2/p/' + p.id; };
  row.addEventListener('click', go);
  row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
  return row;
}

// 새 프로젝트(v2) 폼 — 이름(필수)·설명(선택)·팀원. 생성 후 상세로 이동. memberPicker 재사용.
function openProjectV2Form(reload) {
  const nameIn = el('input', { type: 'text', placeholder: '프로젝트 이름 (예: 6월 데모데이 준비)', maxlength: '200' });
  const descIn = el('textarea', { rows: '3', placeholder: '간단한 설명 (선택)', maxlength: '5000' });
  const picker = memberPicker([], { includeMe: true });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '만들기' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox('새 프로젝트',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '설명 (선택)' }), descIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '함께하는 팀원' }), picker.box),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => nameIn.focus(), 0);
  const go = async () => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      const r = await api('/api/ui/v6/projects', { method: 'POST', body: JSON.stringify({
        name, description: descIn.value.trim() || undefined, members: picker.getSelected(),
      }) });
      back.remove();
      toast('프로젝트를 만들었습니다');
      const np = r && (r.project || r);
      if (np && np.id) location.hash = '#/projects2/p/' + np.id;
      else if (reload) reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

// 프로젝트 상세(v2) #/projects2/p/:id — 헤더(이름·상태 토글·팀원) + 태스크▸하위 트리 + 필요/산출 지식.
//  renderProjectDetail 의 헤더 결을 따르되, 본문은 태스크 계층 + 지식 두 섹션(GET /api/ui/v6/projects/:id).
async function renderProjectV2Detail(view, idStr) {
  const id = Number(idStr);
  const V6_BASE = '/api/ui/v6/projects/'; // 파일/세션/타임라인/팀원 섹션이 v6 라우트로 연결되도록 base 주입
  const backLink = el('a', { class: 'btn btn-ghost btn-sm', href: '#/projects2', text: '← 프로젝트' });
  view.replaceChildren(skeleton('프로젝트를 불러오는 중'));
  let data: any;
  try { data = await api('/api/ui/v6/projects/' + id).then((d) => d && (d.project || d)); }
  catch (e) {
    view.replaceChildren(el('div', { class: 'page-head' }, backLink), errorNote(e, '프로젝트를 불러오지 못했습니다'));
    return;
  }
  if (!data) { view.replaceChildren(el('div', { class: 'page-head' }, backLink), el('div', { class: 'note', text: '프로젝트를 찾을 수 없습니다.' })); return; }
  const p = data;
  const members = p.members || [];
  const isDone = p.status === 'done';
  const reload = () => renderProjectV2Detail(view, idStr);

  // 헤더 — 제목(이름+상태칩) 좌 / 액션(완료토글·삭제) 우 한 줄, 설명, 팀원 칩(아래 별도 행). 박스 높이·세로정렬 통일.
  const head = el('div', { class: 'page-head' },
    el('div', { class: 'proj-detail-back' }, backLink));
  // 상태 토글(완료/재개)은 '프로젝트 세부 설정' 팝업으로 이관 — 헤더엔 상태칩만 둔다.
  // 프로젝트 세부 설정 — 우측 액션 슬롯. 상태(완료된 프로젝트로/재개)·규칙(터미널 AI 주입)·연결된 지식 팝업.
  const meId = (state.me && (state.me.userId || state.me.email)) || '';
  // 삭제·팀원 수정은 '프로젝트 세부 설정' 팝업으로 이관 — 헤더 우측 액션은 설정 버튼만(권한 경계는 백엔드 403).
  const settingsBtn = el('button', { class: 'btn btn-sm btn-ghost', text: '⚙ 프로젝트 세부 설정',
    onclick: () => openProjectSettings(id, p, reload, meId, V6_BASE) });
  // 제목줄 — 이름+상태칩(좌), 세부설정(우).
  head.append(el('div', { class: 'proj-detail-titlebar' },
    el('div', { class: 'proj-detail-titlebox' },
      el('h1', { class: 'proj-detail-title' }, p.name),
      el('span', { class: 'pill-state' + (isDone ? '' : ' confirmed'), text: PJV_STATUS_LABEL[p.status] || p.status })),
    el('div', { class: 'proj-detail-actions' }, settingsBtn)));
  if (p.description) head.append(el('p', { class: 'sub proj-detail-desc', text: p.description }));
  // 팀원 — 칩 행(액션과 분리) + 팀원 수정 버튼. 없으면 흐린 안내.
  const teamRow = el('div', { class: 'proj-team-row' });
  if (members.length) {
    for (const m of members) teamRow.append(el('span', { class: 'proj-team-chip' },
      el('span', { class: 'proj-team-ava', style: 'background:' + avatarColor(m.member_id), text: initials(m.display_name || m.member_id) }),
      el('span', { text: m.display_name || (m.member_id + (m.role ? ' · ' + m.role : '')) })));
  } else {
    teamRow.append(el('span', { class: 'admin-hint', text: '아직 팀원이 없어요' }));
  }
  head.append(teamRow);

  // 상세 본문 — 태스크(작업 위계)를 헤더 바로 아래 맨 위에 둔다(프로젝트의 핵심). 이어 공유 폴더 ·
  //  터미널 세션 · 작업 타임라인(org #/projects 템플릿과 동형, v6 데이터·라우트). 모든 섹션 v6 API base 연결.
  //  '연결된 지식'은 헤더의 '프로젝트 세부 설정' 팝업으로 이동(규칙과 함께). 페이지 본문에선 제외.
  view.replaceChildren(head,
    pjvTasksSection(id, p.tasks || [], members, reload, p.fields || []),
    projectFolderSection(id, V6_BASE),
    projectTerminalSection(id, members, meId, V6_BASE),
    projectTimelineSection(id, members, V6_BASE));
  applyReveal(Array.from(view.children).slice(1));
}

// ── 프로젝트 세부 설정 팝업 — 상태 · 팀원 · 터미널 규칙 · 연결 지식 · 삭제. 헤더 '⚙ 프로젝트 세부 설정'에서 연다. ──
//  (삭제·팀원 수정을 헤더에서 여기로 이관 — 헤더는 제목/상태칩/설정 버튼만.)
function openProjectSettings(id, p, reload, meId, base) {
  const B = base || '/api/ui/v6/projects/';
  const back = overlayBox('프로젝트 세부 설정', el('div', { class: 'proj-settings' }));
  const box = back.querySelector('.ov-box'); if (box) box.classList.add('ov-box-wide');
  const closeAndReload = () => { back.remove(); reload(); };  // 변경하면 팝업 닫고 상세 재렌더
  back.querySelector('.proj-settings').append(
    projectStatusBlock(id, p, closeAndReload),
    projectMembersBlock(id, p, closeAndReload, B),
    projectRulesBlock(id),
    projectRefsBlock(id, B),
    projectKnowledgeBlock(id, p.knowledge || { required: [], produced: [] }),
    projectDangerBlock(id, p, meId, back));
}

// 팀원 블록 — 현재 팀원 칩 + '팀원 수정'(멀티선택 오버레이). 저장 시 설정 팝업 닫고 상세 재렌더.
function projectMembersBlock(id, p, closeAndReload, base) {
  const members = p.members || [];
  const chips = el('div', { class: 'proj-team-row' });
  if (members.length) {
    for (const m of members) chips.append(el('span', { class: 'proj-team-chip' },
      el('span', { class: 'proj-team-ava', style: 'background:' + avatarColor(m.member_id), text: initials(m.display_name || m.member_id) }),
      el('span', { text: m.display_name || (m.member_id + (m.role ? ' · ' + m.role : '')) })));
  } else {
    chips.append(el('span', { class: 'admin-hint', text: '아직 팀원이 없어요' }));
  }
  return el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: '팀원' }),
    el('p', { class: 'ps-block-hint', text: '이 프로젝트를 함께 보고 작업할 팀원이에요.' }),
    chips,
    el('div', { class: 'ps-rules-actions' },
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '팀원 수정',
        onclick: () => openMembersEdit(id, members.map((m) => m.member_id), closeAndReload, base) })));
}

// 삭제 블록 — 작성자 본인만 노출(서버도 403 재검증). 확인 후 삭제 → 팝업 닫고 목록으로.
function projectDangerBlock(id, p, meId, back) {
  const isMine = !!meId && p.created_by != null && String(p.created_by) === String(meId);
  if (!isMine) {
    return el('section', { class: 'ps-block' },
      el('h3', { class: 'ps-block-title', text: '프로젝트 삭제' }),
      el('p', { class: 'ps-block-hint', text: '프로젝트는 작성자만 삭제할 수 있어요.' }));
  }
  const delBtn = el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: '프로젝트 삭제' });
  delBtn.onclick = async () => {
    if (!confirm('프로젝트 ‘' + p.name + '’을(를) 삭제할까요?\n\n프로젝트와 그 작업(태스크·하위)이 함께 사라집니다(되돌릴 수 없음). 연결된 지식은 보존됩니다.')) return;
    delBtn.disabled = true;
    try {
      await api('/api/ui/v6/projects/' + id + '/delete', { method: 'POST' });
      toast('프로젝트를 삭제했습니다');
      back.remove();
      location.hash = '#/projects2';
    } catch (e) { toast('실패 — ' + e.message, true); delBtn.disabled = false; }
  };
  return el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: '프로젝트 삭제' }),
    el('p', { class: 'ps-block-hint', text: '프로젝트와 그 안의 모든 태스크가 영구 삭제됩니다(되돌릴 수 없음). 연결된 지식은 보존돼요.' }),
    el('div', { class: 'ps-rules-actions' }, delBtn));
}

// 상태 블록 — 진행 중 ↔ 완료 토글. (구 헤더 '완료로 표시' 버튼을 여기로 이관, 라벨 '완료된 프로젝트로'.)
function projectStatusBlock(id, p, afterStatus) {
  const isDone = p.status === 'done';
  const btn = el('button', { class: 'btn btn-sm btn-ghost', text: isDone ? '진행 중으로' : '완료된 프로젝트로' });
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await api('/api/ui/v6/projects/' + id + '/status', { method: 'POST', body: JSON.stringify({ status: isDone ? 'active' : 'done' }) });
      toast(isDone ? '진행 중으로 옮겼습니다' : '완료된 프로젝트로 옮겼습니다');
      afterStatus();
    } catch (e) { toast('실패 — ' + e.message, true); btn.disabled = false; }
  };
  return el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: '프로젝트 상태' }),
    el('p', { class: 'ps-block-hint', text: isDone ? '지금 완료된 프로젝트입니다. 다시 진행 중으로 되돌릴 수 있어요.' : '지금 진행 중입니다. 끝났으면 완료된 프로젝트로 옮기세요.' }),
    btn);
}

// 규칙 블록 — 프로젝트 폴더의 CLAUDE.md 를 읽어 편집·저장. 이 프로젝트 터미널 세션의 Claude 가 그 파일을 자동 로드(강제주입).
function projectRulesBlock(id) {
  const url = '/api/ui/v6/projects/' + id + '/file?path=' + encodeURIComponent('CLAUDE.md');
  const ta = el('textarea', { class: 'ps-rules-ta', rows: '8', disabled: '',
    placeholder: '이 프로젝트에서 AI가 지켰으면 하는 걸 편하게 적으세요. 예)\n· 새로 만들기 전에 비슷한 게 이미 있는지 먼저 찾아본다.\n· 큰 변경이나 삭제는 진행하기 전에 꼭 먼저 물어본다.\n· 자료를 만들 땐 근거와 출처를 같이 적는다.\n· 안 되는 건 안 된다고 솔직히 말한다.' });
  const status = el('span', { class: 'ps-save-status admin-hint', text: '불러오는 중…' });
  const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: '규칙 저장', disabled: '' });
  (async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    try { const res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); ta.value = splitClaudeMd(res.ok ? await res.text() : '').manual; }
    catch (_) { ta.value = ''; }
    ta.disabled = false; saveBtn.disabled = false; status.textContent = '';
  })();
  saveBtn.onclick = async () => {
    saveBtn.disabled = true; status.textContent = '저장 중…';
    try {
      // 참고 파일 자동 블록(LIVELY:REFS)은 보존 — 현재 CLAUDE.md 를 다시 읽어 관리 블록만 떼어 재결합한다.
      const token = localStorage.getItem(TOKEN_KEY);
      let cur = '';
      try { const r = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); cur = r.ok ? await r.text() : ''; } catch (_) { /* */ }
      await authUpload(url, new Blob([joinClaudeMd(ta.value, splitClaudeMd(cur).managed)]));
      status.textContent = '저장됨 · 다음 세션부터 적용'; toast('프로젝트 규칙을 저장했습니다');
    }
    catch (e) { status.textContent = ''; toast('저장 실패 — ' + e.message, true); }
    saveBtn.disabled = false;
  };
  return el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: '프로젝트 규칙' }),
    el('p', { class: 'ps-block-hint', text: '이 프로젝트에서 터미널 세션을 열면, 여기 적은 규칙이 그 AI(Claude)에게 자동으로 주입됩니다. (프로젝트 폴더의 CLAUDE.md 로 저장)' }),
    ta,
    el('div', { class: 'ps-rules-actions' }, saveBtn, status));
}

// ── 참고 파일(CLAUDE.md 자동 등록) — 수동 규칙과 한 파일에서 공존하되 영역을 분리(마커로 구분, 서로 보존). ──
const PS_REF_DIR = '참고자료';
const PS_REF_START = '<!-- LIVELY:REFS:START (자동 관리 — 직접 수정하지 마세요) -->';
const PS_REF_END = '<!-- LIVELY:REFS:END -->';
// CLAUDE.md 를 (사람이 쓴 수동 규칙) / (참고 파일 자동 블록)으로 분리.
function splitClaudeMd(text) {
  const t = String(text || '');
  const s = t.indexOf(PS_REF_START), e = t.indexOf(PS_REF_END);
  if (s >= 0 && e > s) {
    const manual = (t.slice(0, s) + t.slice(e + PS_REF_END.length)).replace(/\n{3,}/g, '\n\n').trim();
    return { manual, managed: t.slice(s, e + PS_REF_END.length) };
  }
  return { manual: t.trim(), managed: '' };
}
// 참고 파일 목록 → CLAUDE.md 관리 블록(없으면 빈 문자열).
function buildRefsBlock(files) {
  if (!files || !files.length) return '';
  const lines = files.map((f) => '- `' + PS_REF_DIR + '/' + f.name + '`').join('\n');
  return PS_REF_START + '\n## 📎 참고 파일 (필수)\n'
    + '작업을 시작하기 전에 아래 파일들을 **반드시 먼저 읽고** 그 내용을 따르세요. 작업 내내 이 자료를 기준으로 삼습니다.\n'
    + lines + '\n' + PS_REF_END;
}
// 수동 규칙 + 관리 블록 결합(규칙 먼저, 참고 블록 끝).
function joinClaudeMd(manual, managed) {
  const m = String(manual || '').trim();
  if (!managed) return m ? m + '\n' : '';
  return (m ? m + '\n\n' : '') + managed + '\n';
}

// 참고 파일 블록 — 프로젝트 폴더 참고자료/ 에 파일 업로드 → CLAUDE.md 관리 블록에 자동 등록되어,
//  이 프로젝트 터미널 세션 AI 가 매번 작업 전 반드시 읽도록 강제(수동 규칙과 공존, 영역 보존).
function projectRefsBlock(id, base) {
  const B = base || '/api/ui/v6/projects/';
  const claudeUrl = B + id + '/file?path=' + encodeURIComponent('CLAUDE.md');
  const listsUrl = B + id + '/files?path=' + encodeURIComponent(PS_REF_DIR);
  const refPath = (name) => B + id + '/file?path=' + encodeURIComponent(PS_REF_DIR + '/' + name);
  const listEl = el('div', { class: 'ps-refs-list' });
  const status = el('span', { class: 'ps-save-status admin-hint' });
  const fileInput = el('input', { type: 'file', multiple: true, style: 'display:none' });
  const uploadBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 파일 올리기', onclick: () => fileInput.click() });

  async function fetchFiles() {
    try { const d = await api(listsUrl); return ((d && d.items) || []).filter((x) => x.type === 'file'); }
    catch (_) { return []; } // 폴더 없음 = 아직 파일 없음
  }
  function paint(files) {
    if (!files.length) { listEl.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '아직 참고 파일이 없어요. 올리면 매 터미널 세션에서 AI가 작업 전 반드시 읽습니다.' })); return; }
    listEl.replaceChildren(...files.map((f) => el('div', { class: 'ps-refs-row' },
      el('span', { class: 'ps-refs-ic' }, fileIconSvg(f.name, false)),
      el('span', { class: 'ps-refs-nm', text: f.name, title: f.name }),
      el('span', { class: 'ps-refs-sz', text: fmtSize(f.size) }),
      el('button', { class: 'proj-file-iconbtn danger', type: 'button', title: '삭제', text: '✕', onclick: () => removeRef(f.name) }))));
  }
  async function reload() { paint(await fetchFiles()); }
  // 참고자료/ 현재 목록을 CLAUDE.md 관리 블록으로 재생성(수동 규칙 보존).
  async function sync() {
    const files = await fetchFiles();
    const token = localStorage.getItem(TOKEN_KEY);
    let cur = '';
    try { const r = await fetch(claudeUrl, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); cur = r.ok ? await r.text() : ''; } catch (_) { /* */ }
    await authUpload(claudeUrl, new Blob([joinClaudeMd(splitClaudeMd(cur).manual, buildRefsBlock(files))]));
  }
  fileInput.onchange = async () => {
    const files: any[] = Array.from(fileInput.files || []); fileInput.value = '';
    if (!files.length) return;
    status.textContent = '올리는 중…';
    try {
      for (const f of files) await authUpload(refPath(f.name), f);
      await sync();
      status.textContent = '올림 · 다음 세션부터 적용'; toast('참고 파일을 추가했습니다');
    } catch (e) { status.textContent = ''; toast('업로드 실패 — ' + e.message, true); }
    reload();
  };
  async function removeRef(name) {
    if (!confirm('참고 파일 ‘' + name + '’을(를) 삭제할까요?')) return;
    try { await api(refPath(name), { method: 'DELETE' }); await sync(); toast('삭제했습니다'); }
    catch (e) { toast('삭제 실패 — ' + e.message, true); }
    reload();
  }
  reload();
  return el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: '참고 파일' }),
    el('p', { class: 'ps-block-hint', text: '여기 올린 파일은 이 프로젝트에서 터미널 세션을 열 때마다 AI가 작업 전 반드시 읽도록 강제됩니다. (프로젝트 폴더의 참고자료/ 에 저장 · CLAUDE.md 에 자동 등록)' }),
    listEl, fileInput,
    el('div', { class: 'ps-rules-actions' }, uploadBtn, status));
}

// 지식 블록 — 필요 지식(고르기/자동/해제 가능) + 산출 지식(표시). 변경 후 v6 상세 GET 으로 재조회해 재페인트.
function projectKnowledgeBlock(id, knowledge) {
  const knName = (k) => k.name || k.knowledge_name;
  let cur = { required: knowledge.required || [], produced: knowledge.produced || [] };
  const reqBox = el('div', { class: 'ps-kn-list' });
  const prodBox = el('div', { class: 'ps-kn-list' });

  function paintList(boxEl, list, emptyText, removable) {
    if (!list.length) { boxEl.replaceChildren(el('div', { class: 'pjv-kn-empty', text: emptyText })); return; }
    boxEl.replaceChildren(...list.map((k) => {
      const name = knName(k);
      const row = el('div', { class: 'row pjv-kn-row ps-kn-row' },
        el('a', { class: 'row-title', href: '#/k/' + encodeURIComponent(name), text: k.title || name }),
        el('div', { class: 'row-meta' },
          k.injection ? knInjectChip(k.injection) : null,
          k.provenance ? el('span', {}, ' ', knProvChip(k.provenance)) : null,
          k.lifecycle ? el('span', {}, '  ', lifecycleDot(k.lifecycle)) : null));
      if (removable) row.append(el('button', { class: 'proj-file-iconbtn danger', type: 'button', title: '연결 해제', text: '✕',
        onclick: async (ev) => { ev.preventDefault();
          try { await api('/api/ui/v6/projects/' + id + '/knowledge', { method: 'POST', body: JSON.stringify({ name, relation: 'required', unlink: true }) }); toast('연결을 해제했습니다'); refresh(); }
          catch (e) { toast('해제 실패 — ' + e.message, true); } } }));
      return row;
    }));
  }
  async function refresh() {
    try { const d = await api('/api/ui/v6/projects/' + id).then((r) => r && (r.project || r));
      cur = { required: (d.knowledge || {}).required || [], produced: (d.knowledge || {}).produced || [] }; } catch (_) { /* keep */ }
    paintList(reqBox, cur.required, '이 프로젝트가 참고할 지식을 골라 연결하세요.', true);
    paintList(prodBox, cur.produced, '이 프로젝트가 만들어 낸 지식이 아직 없습니다.', false);
  }
  const reqHead = el('div', { class: 'ps-kn-head' },
    el('div', { class: 'sec-label', text: '필요 지식' }),
    el('div', { class: 'ps-kn-acts' },
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 필요 지식 고르기',
        onclick: () => openKnowledgePicker(id, 'required', cur.required.map(knName), refresh) }),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '✨ 자동으로 고르기', title: '곧 제공됩니다',
        onclick: () => toast('자동 고르기는 곧 제공됩니다', false) })));
  paintList(reqBox, cur.required, '이 프로젝트가 참고할 지식을 골라 연결하세요.', true);
  paintList(prodBox, cur.produced, '이 프로젝트가 만들어 낸 지식이 아직 없습니다.', false);
  return el('section', { class: 'ps-block' },
    el('h3', { class: 'ps-block-title', text: '연결된 지식' }),
    el('div', { class: 'ps-kn-group' }, reqHead, reqBox),
    el('div', { class: 'ps-kn-group' }, el('div', { class: 'sec-label', text: '산출 지식' }), prodBox));
}

// 필요 지식 고르기 — ctx_grep 검색 → '연결'로 POST :id/knowledge. 이미 연결된 건 후보에서 제외.
function openKnowledgePicker(id, relation, linkedNames, onLinked) {
  const linked = new Set(linkedNames || []);
  const searchIn = el('input', { type: 'search', class: 'proj-file-search', placeholder: '지식 제목·내용으로 검색…' });
  const results = el('div', { class: 'ps-kn-pick-results' }, el('span', { class: 'admin-hint', text: '검색어를 입력하세요.' }));
  overlayBox('필요 지식 고르기', el('div', { class: 'ps-kn-pick' }, searchIn, results));
  setTimeout(() => searchIn.focus(), 0);
  const run = debounce(async () => {
    const q = searchIn.value.trim();
    if (!q) { results.replaceChildren(el('span', { class: 'admin-hint', text: '검색어를 입력하세요.' })); return; }
    results.replaceChildren(el('span', { class: 'admin-hint', text: '검색 중…' }));
    let matches: any;
    try { matches = await api('/api/ui/ctx/grep?query=' + encodeURIComponent(q) + '&limit=20').then((d) => (d && d.matches) || []); }
    catch (e) { results.replaceChildren(errorNote(e, '검색하지 못했습니다')); return; }
    const cand = matches.filter((m) => !linked.has(m.name));
    if (!cand.length) { results.replaceChildren(el('div', { class: 'pjv-kn-empty', text: '결과가 없거나 모두 이미 연결됨.' })); return; }
    results.replaceChildren(...cand.map((m) => {
      const addBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 연결' });
      addBtn.onclick = async () => {
        addBtn.disabled = true;
        try { await api('/api/ui/v6/projects/' + id + '/knowledge', { method: 'POST', body: JSON.stringify({ name: m.name, relation }) });
          linked.add(m.name); addBtn.textContent = '연결됨'; toast('연결했습니다'); if (onLinked) onLinked(); }
        catch (e) { addBtn.disabled = false; toast('연결 실패 — ' + e.message, true); }
      };
      return el('div', { class: 'ps-kn-pick-row' },
        el('div', { class: 'ps-kn-pick-main' },
          el('div', { class: 'row-title', text: m.title || m.name }),
          el('div', { class: 'admin-hint ps-kn-pick-snip', text: (m.snippet || '').slice(0, 90) })),
        addBtn);
    }));
  }, 300);
  searchIn.addEventListener('input', run);
}

// ════════════════════════════════════════════
// 태스크(클릭업형 리스트뷰) — 상태 그룹(할 일/진행 중/완료) + 컬럼(담당자·마감일·우선순위) + 인라인 편집.
//  상위 태스크만 상태로 그룹핑하고, 하위는 부모 아래 중첩(자기 상태는 점으로 표시하되 재그룹 안 함 — 클릭업 동형).
//  모든 필드 편집은 POST /api/ui/v6/tasks/:id(task_update_v6) 패치 — 변경 후 reload()로 재페인트(기존 토글과 동일).
// ════════════════════════════════════════════
const PJV_TASK_STATUS = {
  todo:        { label: '할 일',   bucket: 'todo',        glyph: '',  cls: 'todo' },
  in_progress: { label: '진행 중', bucket: 'in_progress', glyph: '◐', cls: 'inprog' },
  done:        { label: 'Closed',  bucket: 'done',        glyph: '✓', cls: 'done' },
};
const PJV_STATUS_ORDER = ['todo', 'in_progress', 'done'];
// 레거시 'active'(구 토글)·클릭업 미러 적재값을 'todo' 버킷으로 흡수. 그 외 미지정도 todo.
function pjvStatusMeta(s) {
  if (s === 'done') return PJV_TASK_STATUS.done;
  if (s === 'in_progress') return PJV_TASK_STATUS.in_progress;
  return PJV_TASK_STATUS.todo;
}
const PJV_PRIORITY = {
  urgent: { label: '긴급', cls: 'urgent' },
  high:   { label: '높음', cls: 'high' },
  normal: { label: '보통', cls: 'normal' },
  low:    { label: '낮음', cls: 'low' },
};
const PJV_PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low'];

function pjvFmtDate(d) {
  if (!d) return '';
  const p = String(d).split('-');
  return p.length === 3 ? (Number(p[1]) + '/' + Number(p[2])) : String(d);
}
function pjvTodayStr() {
  const n = new Date(); const z = (x) => String(x).padStart(2, '0');
  return n.getFullYear() + '-' + z(n.getMonth() + 1) + '-' + z(n.getDate());
}
function pjvIsOverdue(t) { return t.due_date && t.status !== 'done' && t.due_date < pjvTodayStr(); }

// 인라인 편집용 경량 팝오버 — 앵커 아래 위치, 바깥클릭/ESC 로 닫힘. body 에 1개만(기존 것 제거). 닫기함수 반환.
function pjvPopover(anchor, content) {
  document.querySelectorAll('.pjv-pop').forEach((n) => n.remove());
  const pop = el('div', { class: 'pjv-pop' }, content);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  pop.style.top = (r.bottom + window.scrollY + 4) + 'px';
  const left = Math.min(r.left + window.scrollX, window.scrollX + vw - pop.offsetWidth - 10);
  pop.style.left = Math.max(8, left) + 'px';
  const close = () => {
    pop.remove();
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDoc = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  return close;
}

// 필드 패치 — task_update_v6 호출 후 전체 재페인트. 실패 시 토스트.
async function pjvPatchTask(taskId, patch, reload) {
  try {
    await api('/api/ui/v6/tasks/' + taskId, { method: 'POST', body: JSON.stringify(patch) });
    reload();
  } catch (e) { toast('수정 실패 — ' + e.message, true); }
}

// 상태 점(클릭→메뉴: 할 일/진행 중/완료).
function pjvStatusControl(t, reload) {
  const meta = pjvStatusMeta(t.status);
  const btn = el('button', { class: 'pjv-status-dot ' + meta.cls, type: 'button',
    title: '상태: ' + meta.label, 'aria-label': '상태 ' + meta.label },
    meta.glyph ? el('span', { class: 'pjv-status-glyph', text: meta.glyph }) : null);
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    for (const key of PJV_STATUS_ORDER) {
      const m = PJV_TASK_STATUS[key];
      const sel = meta.bucket === key;
      const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' },
        el('span', { class: 'pjv-status-dot sm ' + m.cls }, m.glyph ? el('span', { class: 'pjv-status-glyph', text: m.glyph }) : null),
        el('span', { text: m.label }));
      item.onclick = () => { close(); if (!sel) pjvPatchTask(t.id, { status: key }, reload); };
      menu.append(item);
    }
  };
  return btn;
}

// 담당자(아바타/이니셜, 클릭→프로젝트 팀원 선택 + '담당 없음').
// 빈 상태 회색 라인 아이콘(클릭업식) — 담당자=사람＋ · 마감일=달력＋ · 우선순위=깃발. 색은 CSS(.pjv-cell-ico).
function pjvIcon(kind) {
  const svg = (...kids) => sv('svg', { class: 'pjv-cell-ico', viewBox: '0 0 24 24', width: '17', height: '17',
    fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, ...kids);
  if (kind === 'assignee') { // 사람 + (담당자 지정)
    return svg(
      sv('circle', { cx: '9.5', cy: '8', r: '3.4' }),
      sv('path', { d: 'M3.7 19a5.8 5.8 0 0 1 11.6 0' }),
      sv('path', { d: 'M18.8 13.6v4.6M16.5 15.9h4.6' }));
  }
  if (kind === 'due') { // 달력 + (마감일 지정)
    return svg(
      sv('rect', { x: '3.3', y: '5', width: '17.4', height: '15.2', rx: '2.4' }),
      sv('path', { d: 'M3.3 9.3h17.4' }),
      sv('path', { d: 'M8 2.8v3.6M16 2.8v3.6' }),
      sv('path', { d: 'M12 12.2v4.6M9.7 14.5h4.6' }));
  }
  return svg( // 깃발 (우선순위)
    sv('path', { d: 'M6 20.5V4' }),
    sv('path', { d: 'M6 4.7h10.3l-2.4 3.3 2.4 3.3H6z' }));
}

// 담당자 다중 지정 — assignee 컬럼에 JSON 배열(["yoon","jang"]) 저장. 단일 문자열("yoon")은 레거시로 하위호환.
//  서버는 assignee 를 검증없이 문자열 그대로 저장하고 SQL 필터도 없어, 배열 직렬화만으로 다중이 된다(조인테이블 불요).
function pjvAssignees(t) {
  const a = t && t.assignee;
  if (a == null) return [];
  if (Array.isArray(a)) return a.filter(Boolean);
  const s = String(a).trim();
  if (!s) return [];
  if (s[0] === '[') { try { const arr = JSON.parse(s); return Array.isArray(arr) ? arr.filter(Boolean) : [s]; } catch (_) { return [s]; } }
  return [s];
}
function pjvAssigneeWrite(ids) {
  const a = [...new Set((ids || []).filter(Boolean))];
  return a.length ? JSON.stringify(a) : null;
}
// 저장만(전체 reload 없이) — 다중 토글 중 메뉴를 닫지 않으려고 낙관적 갱신 + 백그라운드 저장.
function pjvSaveTask(taskId, patch) {
  return api('/api/ui/v6/tasks/' + taskId, { method: 'POST', body: JSON.stringify(patch) }).catch((e) => toast('수정 실패 — ' + e.message, true));
}

// 담당자 셀(다중) — 페이스파일 아바타(최대 3 + N) / 빈 아이콘. 메뉴=팀원 토글(체크 유지, 닫지 않음) + 담당 없음.
function pjvAssigneeControl(t, members, apply) {
  const nameOf = (id) => { const m = members.find((x) => x.member_id === id); return m ? (m.display_name || m.member_id) : id; };
  const btn = el('button', { class: 'pjv-cell-btn', type: 'button', title: '담당자' });
  function render() {
    const ids = pjvAssignees(t);
    btn.className = 'pjv-cell-btn' + (ids.length ? '' : ' empty');
    if (ids.length) {
      const faces = el('span', { class: 'pjv-asg-faces' });
      for (const id of ids.slice(0, 3)) faces.append(el('span', { class: 'pjv-ava', style: 'background:' + avatarColor(id), title: nameOf(id), text: initials(nameOf(id)) }));
      if (ids.length > 3) faces.append(el('span', { class: 'pjv-ava pjv-ava-more', text: '+' + (ids.length - 3) }));
      btn.replaceChildren(faces);
    } else {
      btn.replaceChildren(pjvIcon('assignee'));
    }
  }
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu pjv-asg-menu' });
    pjvPopover(btn, menu);
    const setIds = (ids) => { t.assignee = pjvAssigneeWrite(ids); render(); apply({ assignee: t.assignee }); rebuild(); };
    const none = el('button', { class: 'pjv-menu-item', type: 'button' },
      el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '담당 없음' }));
    none.onclick = (ev) => { ev.stopPropagation(); setIds([]); };
    const itemsBox = el('div', {});
    menu.append(none, itemsBox);
    function rebuild() {
      const ids = pjvAssignees(t);
      none.className = 'pjv-menu-item' + (!ids.length ? ' sel' : '');
      itemsBox.replaceChildren(...members.map((m) => {
        const on = ids.includes(m.member_id);
        const item = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' },
          el('span', { class: 'pjv-ava', style: 'background:' + avatarColor(m.member_id), text: initials(m.display_name || m.member_id) }),
          el('span', { class: 'pjv-asg-mname', text: m.display_name || m.member_id }),
          el('span', { class: 'pjv-asg-check', text: on ? '✓' : '' }));
        item.onclick = (ev) => { ev.stopPropagation(); const c = pjvAssignees(t); setIds(c.includes(m.member_id) ? c.filter((x) => x !== m.member_id) : [...c, m.member_id]); };
        return item;
      }));
      if (!members.length) itemsBox.append(el('div', { class: 'pjv-menu-empty', text: '팀원을 먼저 추가하세요' }));
    }
    rebuild();
  };
  render();
  return btn;
}

// 마감일(YYYY-MM-DD, 표시는 m/d). 클릭→날짜입력 + 지우기.
function pjvDueControl(t, apply) {
  const overdue = pjvIsOverdue(t);
  const btn = el('button', { class: 'pjv-cell-btn' + (t.due_date ? '' : ' empty'), type: 'button', title: '마감일' });
  btn.append(t.due_date
    ? el('span', { class: 'pjv-due-text' + (overdue ? ' overdue' : ''), text: pjvFmtDate(t.due_date) })
    : pjvIcon('due'));
  btn.onclick = (e) => {
    e.stopPropagation();
    const input = el('input', { type: 'date', class: 'pjv-date-input', value: t.due_date || '' });
    const wrap = el('div', { class: 'pjv-menu pjv-date-pop' }, input,
      t.due_date ? el('button', { class: 'pjv-menu-item danger', type: 'button', text: '마감일 지우기',
        onclick: () => { close(); apply({ due_date: null }); } }) : null);
    const close = pjvPopover(btn, wrap);
    setTimeout(() => { input.focus(); if (input.showPicker) { try { input.showPicker(); } catch (_) { /* noop */ } } }, 0);
    input.onchange = () => { const v = input.value || null; close(); apply({ due_date: v }); };
  };
  return btn;
}

// 우선순위(깃발, 색상). 클릭→긴급/높음/보통/낮음/없음.
function pjvPriorityControl(t, apply) {
  const m = t.priority ? PJV_PRIORITY[t.priority] : null;
  const btn = el('button', { class: 'pjv-cell-btn' + (m ? '' : ' empty'), type: 'button', title: '우선순위' });
  btn.append(m
    ? el('span', { class: 'pjv-flag ' + m.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' }), el('span', { class: 'pjv-flag-label', text: m.label }))
    : pjvIcon('priority'));
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    for (const key of PJV_PRIORITY_ORDER) {
      const pm = PJV_PRIORITY[key];
      const sel = t.priority === key;
      const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' },
        el('span', { class: 'pjv-flag ' + pm.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' })),
        el('span', { text: pm.label }));
      item.onclick = () => { close(); if (!sel) apply({ priority: key }); };
      menu.append(item);
    }
    const none = el('button', { class: 'pjv-menu-item' + (!t.priority ? ' sel' : ''), type: 'button' },
      el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
    none.onclick = () => { close(); if (t.priority) apply({ priority: null }); };
    menu.append(none);
  };
  return btn;
}

// 닫힌(완료=Closed) 항목 표시 상태 — 클릭업 'Closed' 토글. 세션 동안 유지(reload 무관). 기본 숨김.
const pjvClosedView = { tasks: false, subtasks: false };

// 하위 태스크 표시 모드(클릭업 Subtasks 버튼) — collapsed(접힘·기본) / expanded(펼침) / separate(분리·하위를 최상위 행으로).
const pjvSubtaskMode = { mode: 'collapsed' };
const PJV_SUBTASK_OPTS = [
  { key: 'collapsed', label: '접힘', hint: '기본 (하위는 캐럿으로 펼침)' },
  { key: 'expanded', label: '펼침', hint: '모든 하위를 펼쳐서 표시' },
  { key: 'separate', label: '분리', hint: '하위를 별도 행으로 표시' },
];
const PJV_SUBTASK_BTNLABEL = { collapsed: '하위 태스크', expanded: '펼침', separate: '분리' };
// 하위 태스크 아이콘(클릭업식) — 좌상단 노드 → 꺾인 가지 → 우하단 노드.
function pjvSubtaskIcon() {
  const n = sv('svg', { class: 'pjv-subtask-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 7, cy: 6, r: 2.2 }), sv('circle', { cx: 17, cy: 17, r: 2.2 }), sv('path', { d: 'M7 8.2v5.6a2.6 2.6 0 0 0 2.6 2.6H14.6' }));
  return n;
}
// Subtasks 버튼 메뉴 — 접힘/펼침/분리. 선택 시 모드 변경 후 onChange(재렌더).
function pjvSubtaskMenu(anchor, onChange) {
  const pop = el('div', { class: 'pjv-menu pjv-subtask-pop' });
  const close = pjvPopover(anchor, pop);
  pop.append(el('div', { class: 'pjv-subtask-pop-head', text: '하위 태스크 표시' }));
  for (const o of PJV_SUBTASK_OPTS) {
    const sel = pjvSubtaskMode.mode === o.key;
    const item = el('button', { class: 'pjv-menu-item pjv-subtask-item' + (sel ? ' sel' : ''), type: 'button' },
      el('span', { class: 'pjv-subtask-item-main' },
        el('span', { class: 'pjv-subtask-item-label', text: o.label }),
        el('span', { class: 'pjv-subtask-item-hint', text: o.hint })),
      sel ? el('span', { class: 'pjv-subtask-check', text: '✓' }) : null);
    item.onclick = () => { close(); if (pjvSubtaskMode.mode !== o.key) { pjvSubtaskMode.mode = o.key; onChange(); } };
    pop.append(item);
  }
}

// 체크-원 아이콘(Closed 버튼용).
function pjvCheckCircle() {
  const n = sv('svg', { class: 'pjv-closed-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 12, cy: 12, r: 9 }));
  n.append(sv('path', { d: 'M8.5 12.3l2.4 2.4 4.6-5' }));
  return n;
}
// 토글 스위치 행(라벨 + iOS식 스위치). after() = 상태 반영 후 재렌더.
function pjvSwitchRow(label, getOn, setOn, after) {
  const sw = el('button', { class: 'pjv-switch' + (getOn() ? ' on' : ''), type: 'button', role: 'switch', 'aria-checked': getOn() ? 'true' : 'false' }, el('span', { class: 'pjv-switch-knob' }));
  sw.onclick = (e) => { e.stopPropagation(); const nv = !getOn(); setOn(nv); sw.classList.toggle('on', nv); sw.setAttribute('aria-checked', nv ? 'true' : 'false'); after(); };
  return el('div', { class: 'pjv-closed-row' }, el('span', { class: 'pjv-closed-row-label', text: label }), sw);
}

// ════════════════════════════════════════════════════════════════════════════
// 커스텀 필드(클릭업형 "+ 컬럼 추가") — 우선순위 옆 (+) 로 형식을 지정해 컬럼을 추가하고, 각 태스크에 값을 채운다.
//  백엔드 task_field/task_field_value(루트 프로젝트 단위 정의 + 태스크별 값). FIELD_TYPES 는 store 의 것과 1:1.
//  아이콘은 우리 서비스 톤(단색 라인, currentColor, 형태로 구분 — 컬러 이모지 금지)으로 직접 제작.
// ════════════════════════════════════════════════════════════════════════════

// 옵션(드롭다운/라벨) 색 팔레트 — 차분한 톤(채도 절제). 추가 순서대로 라운드로빈.
const PJV_FIELD_PALETTE = ['#6b7cff', '#2bb3a3', '#e6913a', '#e0688e', '#9268d6', '#3f9ae0', '#56b877', '#dd6450', '#7f8aa3'];
// 통화 — 금액 필드. 기본 원화.
const PJV_CURRENCIES = {
  KRW: { symbol: '₩', label: '원 (₩)' }, USD: { symbol: '$', label: '달러 ($)' },
  EUR: { symbol: '€', label: '유로 (€)' }, JPY: { symbol: '¥', label: '엔 (¥)' },
};
// 필드 형식 정의 — key 는 백엔드 field_type 과 동일. w=컬럼 px 폭, config=설정 단계 종류(옵션/통화/별점/진행률).
const PJV_FIELD_TYPES = [
  { key: 'text',     label: '텍스트',       desc: '한 줄 텍스트',       w: 150 },
  { key: 'textarea', label: '긴 텍스트',     desc: '여러 줄 메모',       w: 180 },
  { key: 'number',   label: '숫자',         desc: '정수·소수',         w: 104 },
  { key: 'money',    label: '금액',         desc: '통화 단위 숫자',     w: 120, config: 'money' },
  { key: 'date',     label: '날짜',         desc: '날짜 선택',         w: 108 },
  { key: 'dropdown', label: '드롭다운',      desc: '옵션 1개 선택',      w: 148, config: 'options' },
  { key: 'labels',   label: '라벨',         desc: '옵션 여러 개 선택',   w: 184, config: 'options' },
  { key: 'checkbox', label: '체크박스',      desc: '예 / 아니오',        w: 86 },
  { key: 'website',  label: '웹사이트',      desc: 'URL 링크',          w: 156 },
  { key: 'email',    label: '이메일',       desc: '메일 주소',         w: 168 },
  { key: 'phone',    label: '전화',         desc: '전화번호',          w: 148 },
  { key: 'rating',   label: '별점',         desc: '별 점수',           w: 128, config: 'rating' },
  { key: 'progress', label: '진행률',       desc: '0–100% 막대',       w: 136, config: 'progress' },
  { key: 'tshirt',   label: '티셔츠 사이즈',  desc: 'XS–XXL',           w: 104 },
  { key: 'location', label: '위치',         desc: '장소·주소',         w: 156 },
  { key: 'files',     label: '파일',         desc: '공유 폴더에서 선택',  w: 150 },
  { key: 'relationship', label: '관계',      desc: '태스크 연결',        w: 184 },
  { key: 'progress_auto', label: '진행률(자동)', desc: '하위 완료율 자동',  w: 136 },
];
const PJV_FIELD_BY_KEY = Object.fromEntries(PJV_FIELD_TYPES.map((f) => [f.key, f]));
const PJV_TSHIRT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

// 라인 아이콘 글리프(24x24, currentColor) — 형태만으로 형식을 구분(파일 아이콘 idiom 과 동일 톤).
const PJV_FIELD_ICON_PATHS = {
  text:     [['polyline', { points: '5 7 5 4 19 4 19 7' }], ['line', { x1: 12, y1: 4, x2: 12, y2: 20 }], ['line', { x1: 9, y1: 20, x2: 15, y2: 20 }]],
  textarea: [['line', { x1: 4, y1: 6, x2: 20, y2: 6 }], ['line', { x1: 4, y1: 11, x2: 20, y2: 11 }], ['line', { x1: 4, y1: 16, x2: 13, y2: 16 }]],
  number:   [['line', { x1: 9.5, y1: 4, x2: 7.5, y2: 20 }], ['line', { x1: 16.5, y1: 4, x2: 14.5, y2: 20 }], ['line', { x1: 4, y1: 9, x2: 20, y2: 9 }], ['line', { x1: 4, y1: 15, x2: 20, y2: 15 }]],
  money:    [['line', { x1: 12, y1: 3, x2: 12, y2: 21 }], ['path', { d: 'M16 6.8H10.1a2.85 2.85 0 0 0 0 5.7h3.8a2.85 2.85 0 0 1 0 5.7H8' }]],
  date:     [['rect', { x: 3, y: 5, width: 18, height: 16, rx: 2.5 }], ['line', { x1: 3, y1: 9.5, x2: 21, y2: 9.5 }], ['line', { x1: 8, y1: 3, x2: 8, y2: 7 }], ['line', { x1: 16, y1: 3, x2: 16, y2: 7 }]],
  dropdown: [['rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.5 }], ['polyline', { points: '8.5 10 12 13.5 15.5 10' }]],
  labels:   [['path', { d: 'M3.6 12.4 11 5a2 2 0 0 1 1.42-.6H19A1.4 1.4 0 0 1 20.4 5.8v6.6a2 2 0 0 1-.6 1.42l-7.4 7.4a1.55 1.55 0 0 1-2.2 0l-6.6-6.6a1.55 1.55 0 0 1 0-2.2Z' }], ['circle', { cx: 16, cy: 8, r: 1.25 }]],
  checkbox: [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 3.5 }], ['polyline', { points: '8.4 12.4 11 15 16 9.4' }]],
  website:  [['circle', { cx: 12, cy: 12, r: 9 }], ['line', { x1: 3, y1: 12, x2: 21, y2: 12 }], ['path', { d: 'M12 3c2.6 2.7 2.6 15.3 0 18' }], ['path', { d: 'M12 3c-2.6 2.7-2.6 15.3 0 18' }]],
  email:    [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }], ['polyline', { points: '4 7.5 12 13 20 7.5' }]],
  phone:    [['path', { d: 'M6.5 3h3l1.6 4.2-2.3 1.5a11 11 0 0 0 4.9 4.9l1.5-2.3 4.2 1.6v3a2 2 0 0 1-2.1 2A15.5 15.5 0 0 1 4.5 5.1 2 2 0 0 1 6.5 3Z' }]],
  rating:   [['path', { d: 'M12 4.3l2.34 4.74 5.23.76-3.78 3.69.89 5.2L12 16.9l-4.68 2.46.89-5.2-3.78-3.69 5.23-.76Z' }]],
  progress: [['rect', { x: 3, y: 9, width: 18, height: 6, rx: 3 }], ['path', { d: 'M6.2 12h6', 'stroke-width': 3.2, 'stroke-linecap': 'round' }]],
  tshirt:   [['path', { d: 'M8.2 3.5 4 6.5l2.1 3.2 1.9-1.1V19a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V8.6l1.9 1.1L20 6.5l-4.2-3a2.4 2.4 0 0 1-3.8 1.4 2.4 2.4 0 0 1-3.8-1.4Z' }]],
  location: [['path', { d: 'M12 21s-6.4-5.3-6.4-10.4A6.4 6.4 0 0 1 18.4 10.6C18.4 15.7 12 21 12 21Z' }], ['circle', { cx: 12, cy: 10.4, r: 2.3 }]],
  files:    [['path', { d: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48' }]],
  relationship: [['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }], ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }]],
  progress_auto: [['path', { d: 'M5.5 17.5a8 8 0 1 1 13 0' }], ['path', { d: 'M12 13l3.4-3.4' }]],
};
function pjvFieldIcon(key, cls?) {
  const node = sv('svg', { class: 'pjv-ficon' + (cls ? ' ' + cls : ''), viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  for (const [t, a] of (PJV_FIELD_ICON_PATHS[key] || PJV_FIELD_ICON_PATHS.text)) node.append(sv(t, a));
  return node;
}
function pjvPlusIcon() {
  const n = sv('svg', { class: 'pjv-addcol-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 12, cy: 12, r: 9 }), sv('line', { x1: 12, y1: 8, x2: 12, y2: 16 }), sv('line', { x1: 8, y1: 12, x2: 16, y2: 12 }));
  return n;
}
function pjvStarGlyph(on) {
  const n = sv('svg', { class: 'pjv-fstar-ic', viewBox: '0 0 24 24', fill: on ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('path', { d: 'M12 4.3l2.34 4.74 5.23.76-3.78 3.69.89 5.2L12 16.9l-4.68 2.46.89-5.2-3.78-3.69 5.23-.76Z' }));
  return n;
}
function pjvCheckGlyph(on) {
  const n = sv('svg', { class: 'pjv-fcheck-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('rect', { x: 4, y: 4, width: 16, height: 16, rx: 4 }));
  if (on) n.append(sv('polyline', { points: '8.4 12.4 11 15 16 9' }));
  return n;
}
function pjvOptChip(o) {
  return el('span', { class: 'pjv-fopt', style: '--opt:' + (o.color || PJV_FIELD_PALETTE[0]) },
    el('span', { class: 'pjv-fopt-dot' }), el('span', { class: 'pjv-fopt-label', text: o.label }));
}
function pjvCheckMini(on) {
  const n = sv('svg', { class: 'pjv-check-mini' + (on ? ' on' : ''), viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('rect', { x: 4, y: 4, width: 16, height: 16, rx: 4 }));
  if (on) n.append(sv('polyline', { points: '8.4 12.4 11 15 16 9' }));
  return n;
}

// 그리드 템플릿 — 기본(이름·담당자·마감·우선순위) + 커스텀 필드 폭들 + 더보기. thead/행/추가행에 인라인 적용.
function pjvGridTemplate(fields) {
  const extra = (fields || []).map((f) => ((PJV_FIELD_BY_KEY[f.field_type] && PJV_FIELD_BY_KEY[f.field_type].w) || 130) + 'px').join(' ');
  return 'minmax(0, 1fr) 96px 92px 112px' + (extra ? ' ' + extra : '') + ' 34px';
}
function pjvHasFieldValue(v) {
  return !(v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0));
}
function pjvUrlText(v) { return String(v).replace(/^https?:\/\//i, '').replace(/\/$/, ''); }

// 값 표시 노드(읽기) — 타입별. 셀 버튼 안에 들어간다.
function pjvFieldDisplay(field, value) {
  const type = field.field_type;
  const cfg = field.config || {};
  if (type === 'dropdown') {
    const o = (cfg.options || []).find((x) => x.id === value);
    return o ? pjvOptChip(o) : el('span', { class: 'pjv-fval', text: String(value) });
  }
  if (type === 'labels') {
    const opts = cfg.options || [];
    const wrap = el('span', { class: 'pjv-flabels' });
    for (const id of (Array.isArray(value) ? value : [])) {
      const o = opts.find((x) => x.id === id);
      wrap.append(o ? pjvOptChip(o) : el('span', { class: 'pjv-fval', text: String(id) }));
    }
    return wrap;
  }
  if (type === 'money') {
    const c = PJV_CURRENCIES[cfg.currency] || PJV_CURRENCIES.KRW;
    const n = Number(value);
    return el('span', { class: 'pjv-fval', text: c.symbol + (Number.isFinite(n) ? n.toLocaleString('ko-KR') : String(value)) });
  }
  if (type === 'number') {
    const n = Number(value);
    return el('span', { class: 'pjv-fval', text: Number.isFinite(n) ? n.toLocaleString('ko-KR') : String(value) });
  }
  if (type === 'date') return el('span', { class: 'pjv-fval', text: pjvFmtDate(value) });
  if (type === 'progress') {
    const pct = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    return el('span', { class: 'pjv-fprog' },
      el('span', { class: 'pjv-fprog-track' }, el('span', { class: 'pjv-fprog-fill', style: 'width:' + pct + '%' })),
      el('span', { class: 'pjv-fprog-num', text: pct + '%' }));
  }
  if (type === 'files') {
    const arr = Array.isArray(value) ? value : [];
    return el('span', { class: 'pjv-ffiles' }, pjvFieldIcon('files', 'pjv-fmini'),
      el('span', { class: 'pjv-fval', text: arr.length === 1 ? arr[0].name : arr.length + '개' }));
  }
  if (type === 'relationship') {
    const arr = Array.isArray(value) ? value : [];
    const w = el('span', { class: 'pjv-frel' });
    for (const r of arr.slice(0, 2)) w.append(el('span', { class: 'pjv-rel-chip', text: r.name || ('#' + r.id), title: r.name }));
    if (arr.length > 2) w.append(el('span', { class: 'pjv-rel-more', text: '+' + (arr.length - 2) }));
    return w;
  }
  if (type === 'tshirt') return el('span', { class: 'pjv-fsize', text: String(value) });
  if (type === 'website') return el('span', { class: 'pjv-fval pjv-flink', text: pjvUrlText(value) });
  return el('span', { class: 'pjv-fval', text: String(value) }); // text/textarea/email/phone/location
}

// 한 셀의 컨트롤 — 낙관적 로컬 갱신 + 백그라운드 저장(전체 reload 없이 부드럽게). 옵션 추가 등 정의 변경은 reload.
function pjvFieldControl(t, field, reload) {
  let value = (t.field_values || {})[field.id];
  value = value === undefined ? null : value;
  const cell = el('span', { class: 'pjv-fcell-wrap' });
  const persist = (v) => {
    const prev = value; value = v;
    render();
    api('/api/ui/v6/tasks/' + t.id + '/fields/' + field.id, { method: 'POST', body: JSON.stringify({ value: v }) })
      .then(() => { (t.field_values || (t.field_values = {}))[field.id] = v; })
      .catch((e) => { value = prev; render(); toast('수정 실패 — ' + e.message, true); });
  };
  function render() { cell.replaceChildren(pjvFieldInner(t, field, value, persist, reload)); }
  render();
  return cell;
}

// 셀 내부 — 인라인 상호작용(체크박스·별점)은 셀 자체가 컨트롤, 그 외는 값 버튼(클릭→팝오버 편집기).
function pjvFieldInner(t, field, value, persist, reload) {
  const type = field.field_type;
  if (type === 'checkbox') {
    const on = value === true;
    const btn = el('button', { class: 'pjv-fcheck' + (on ? ' on' : ''), type: 'button', title: field.name, 'aria-pressed': on ? 'true' : 'false' }, pjvCheckGlyph(on));
    btn.onclick = (e) => { e.stopPropagation(); persist(!on); };
    return btn;
  }
  if (type === 'rating') {
    const max = Math.max(1, Math.min(10, Number(field.config && field.config.max) || 5));
    const cur = Number(value) || 0;
    const wrap = el('span', { class: 'pjv-frating', title: field.name });
    for (let i = 1; i <= max; i++) {
      const on = i <= cur;
      const star = el('button', { class: 'pjv-fstar' + (on ? ' on' : ''), type: 'button', 'aria-label': i + '점' }, pjvStarGlyph(on));
      star.onclick = (e) => { e.stopPropagation(); persist(i === cur ? null : i); };
      wrap.append(star);
    }
    return wrap;
  }
  if (type === 'progress_auto') {
    const pct = pjvAutoProgress(t);
    if (pct === null) return el('span', { class: 'pjv-cell-btn empty', title: '하위 태스크가 없어요(자동 진행률)', style: 'cursor:default' }, el('span', { class: 'pjv-cell-ph', text: '—' }));
    return el('span', { class: 'pjv-fprog', title: '하위 태스크 ' + pct + '% 완료(자동)' },
      el('span', { class: 'pjv-fprog-track' }, el('span', { class: 'pjv-fprog-fill', style: 'width:' + pct + '%' })),
      el('span', { class: 'pjv-fprog-num', text: pct + '%' }));
  }
  const has = pjvHasFieldValue(value);
  const btn = el('button', { class: 'pjv-cell-btn' + (has ? '' : ' empty'), type: 'button', title: field.name },
    has ? pjvFieldDisplay(field, value) : el('span', { class: 'pjv-cell-ph', text: '＋' }));
  btn.onclick = (e) => {
    e.stopPropagation();
    if (type === 'dropdown') return pjvFieldDropdownEditor(btn, t, field, value, persist, reload);
    if (type === 'labels') return pjvFieldLabelsEditor(btn, t, field, value, persist, reload);
    if (type === 'date') return pjvFieldDateEditor(btn, value, persist);
    if (type === 'progress') return pjvFieldProgressEditor(btn, value, persist);
    if (type === 'files') return pjvFieldFilesEditor(btn, t, field, value, persist);
    if (type === 'relationship') return pjvFieldRelEditor(btn, t, field, value, persist);
    if (type === 'tshirt') return pjvFieldTshirtEditor(btn, value, persist);
    if (type === 'textarea') return pjvFieldTextareaEditor(btn, field, value, persist);
    return pjvFieldTextEditor(btn, field, value, persist);
  };
  return btn;
}

// 텍스트류 편집기(text/number/money/website/email/phone/location) — 입력 + 저장/지우기. Enter 저장.
function pjvFieldTextEditor(anchor, field, value, persist) {
  const type = field.field_type;
  const itype = (type === 'number' || type === 'money') ? 'number' : type === 'website' ? 'url' : type === 'email' ? 'email' : type === 'phone' ? 'tel' : 'text';
  const input = el('input', { type: itype, class: 'pjv-field-input', value: value == null ? '' : String(value),
    placeholder: (PJV_FIELD_BY_KEY[type] && PJV_FIELD_BY_KEY[type].desc) || '',
    inputmode: (type === 'number' || type === 'money') ? 'decimal' : null });
  const coerce = (v) => {
    if (type === 'number' || type === 'money') { const n = Number(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : undefined; }
    return v;
  };
  const save = () => {
    const raw = input.value.trim();
    if (raw === '') { close(); persist(null); return; }
    const out = coerce(raw);
    if (out === undefined) { toast('숫자를 입력하세요', true); return; }
    close(); persist(out);
  };
  const actions = el('div', { class: 'pjv-fe-actions' },
    el('button', { class: 'pjv-fe-btn primary', type: 'button', text: '저장', onclick: save }),
    (type === 'website' && pjvHasFieldValue(value)) ? el('a', { class: 'pjv-fe-btn', href: safeHref(String(value)) || '#', target: '_blank', rel: 'noopener', text: '열기 ↗' }) : null,
    pjvHasFieldValue(value) ? el('button', { class: 'pjv-fe-btn danger', type: 'button', text: '지우기', onclick: () => { close(); persist(null); } }) : null);
  const close = pjvPopover(anchor, el('div', { class: 'pjv-field-editor' }, input, actions));
  setTimeout(() => { input.focus(); if (input.select) input.select(); }, 0);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
}

// 긴 텍스트 편집기 — textarea + 저장/지우기. Cmd/Ctrl+Enter 저장.
function pjvFieldTextareaEditor(anchor, field, value, persist) {
  const ta = el('textarea', { class: 'pjv-field-textarea', rows: '4', placeholder: '여러 줄 메모', maxlength: '4000' });
  ta.value = value == null ? '' : String(value);
  const save = () => { const v = ta.value.trim(); close(); persist(v === '' ? null : v); };
  const actions = el('div', { class: 'pjv-fe-actions' },
    el('button', { class: 'pjv-fe-btn primary', type: 'button', text: '저장', onclick: save }),
    pjvHasFieldValue(value) ? el('button', { class: 'pjv-fe-btn danger', type: 'button', text: '지우기', onclick: () => { close(); persist(null); } }) : null);
  const close = pjvPopover(anchor, el('div', { class: 'pjv-field-editor wide' }, ta, actions));
  setTimeout(() => { ta.focus(); }, 0);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } });
}

// 날짜 편집기 — 마감일과 동형(YYYY-MM-DD).
function pjvFieldDateEditor(anchor, value, persist) {
  const input = el('input', { type: 'date', class: 'pjv-date-input', value: typeof value === 'string' ? value : '' });
  const wrap = el('div', { class: 'pjv-menu pjv-date-pop' }, input,
    pjvHasFieldValue(value) ? el('button', { class: 'pjv-menu-item danger', type: 'button', text: '지우기', onclick: () => { close(); persist(null); } }) : null);
  const close = pjvPopover(anchor, wrap);
  setTimeout(() => { input.focus(); if (input.showPicker) { try { input.showPicker(); } catch (_) { /* noop */ } } }, 0);
  input.onchange = () => { const v = input.value || null; close(); persist(v); };
}

// 진행률 편집기 — 슬라이더 + 숫자(0–100).
function pjvFieldProgressEditor(anchor, value, persist) {
  const cur = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const range = el('input', { type: 'range', class: 'pjv-prog-range', min: '0', max: '100', step: '5', value: String(cur) });
  const num = el('input', { type: 'number', class: 'pjv-prog-num-input', min: '0', max: '100', value: String(cur) });
  range.oninput = () => { num.value = range.value; };
  num.oninput = () => { const n = Math.max(0, Math.min(100, Number(num.value) || 0)); range.value = String(n); };
  const save = () => { const n = Math.max(0, Math.min(100, Math.round(Number(num.value) || 0))); close(); persist(n === 0 ? null : n); };
  const wrap = el('div', { class: 'pjv-field-editor pjv-prog-editor' },
    el('div', { class: 'pjv-prog-row' }, range, el('span', { class: 'pjv-prog-pct' }, num, el('span', { text: '%' }))),
    el('div', { class: 'pjv-fe-actions' },
      el('button', { class: 'pjv-fe-btn primary', type: 'button', text: '저장', onclick: save }),
      pjvHasFieldValue(value) ? el('button', { class: 'pjv-fe-btn danger', type: 'button', text: '지우기', onclick: () => { close(); persist(null); } }) : null));
  const close = pjvPopover(anchor, wrap);
}

// 티셔츠 사이즈 — 고정 옵션(XS–XXL) 메뉴.
function pjvFieldTshirtEditor(anchor, value, persist) {
  const menu = el('div', { class: 'pjv-menu' });
  const close = pjvPopover(anchor, menu);
  for (const s of PJV_TSHIRT_SIZES) {
    const sel = value === s;
    const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-fsize', text: s }));
    item.onclick = () => { close(); persist(sel ? null : s); };
    menu.append(item);
  }
  const none = el('button', { class: 'pjv-menu-item' + (value == null ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
  none.onclick = () => { close(); if (value != null) persist(null); };
  menu.append(none);
}

// 하위 태스크 완료율(자동) — 진행률(자동) 필드용. 하위 없으면 null. (클릭업 Progress Auto 의 하위 기반 버전)
function pjvAutoProgress(t) {
  const subs = (t && t.subtasks) || [];
  if (!subs.length) return null;
  const done = subs.filter((s) => s.status === 'done').length;
  return Math.round((done / subs.length) * 100);
}

// 파일 필드 — 공유 폴더에서 선택(참조). 업로드가 아니라 프로젝트 공유폴더의 기존 파일을 골라 연결한다.
//  값=[{name, path, size}](path=공유폴더 상대경로). 연결 해제해도 실제 파일은 안 지워진다(참조만 끊음).
function pjvFieldFilesEditor(anchor, t, field, value, persist) {
  let selected = Array.isArray(value) ? value.slice() : [];
  const B = '/api/ui/v6/projects/' + field.project_id;
  const wrap = el('div', { class: 'pjv-field-editor pjv-files-editor' });
  const close = pjvPopover(anchor, wrap);
  let curPath = '';
  let curData: any = null;
  const chips = el('div', { class: 'pjv-files-selected' });
  const crumb = el('div', { class: 'pjv-files-crumb' });
  const rowsBox = el('div', { class: 'pjv-files-browser' });
  const renderChips = () => {
    chips.replaceChildren(el('span', { class: 'pjv-files-sel-label', text: '연결된 파일 ' + selected.length + '개' }));
    for (const s of selected) {
      chips.append(el('span', { class: 'pjv-rel-chip removable' },
        el('button', { class: 'pjv-chip-dl', type: 'button', title: '다운로드', text: '↓', onclick: () => authDownload(B + '/file?download=1&path=' + encodeURIComponent(s.path), s.name) }),
        el('span', { class: 'pjv-files-name', text: s.name, title: s.path }),
        el('button', { class: 'pjv-rel-x', type: 'button', title: '연결 해제', text: '✕', onclick: () => { selected = selected.filter((x) => x.path !== s.path); persist(selected.length ? selected.slice() : null); renderChips(); refreshRows(); } })));
    }
  };
  const refreshRows = () => {
    rowsBox.replaceChildren();
    const items = (curData && curData.items) || [];
    if (!items.length) { rowsBox.append(el('div', { class: 'pjv-files-empty', text: '빈 폴더예요' })); return; }
    for (const it of items) {
      const childPath = curPath ? curPath + '/' + it.name : it.name;
      if (it.type === 'dir') {
        rowsBox.append(el('button', { class: 'pjv-files-row dir', type: 'button', onclick: () => { curPath = childPath; load(); } },
          fileIconSvg(it.name, true), el('span', { class: 'pjv-files-name', text: it.name }), el('span', { class: 'pjv-files-chev', text: '›' })));
      } else {
        const on = selected.some((x) => x.path === childPath);
        const row = el('button', { class: 'pjv-files-row file' + (on ? ' on' : ''), type: 'button' },
          pjvCheckMini(on), fileIconSvg(it.name, false), el('span', { class: 'pjv-files-name', text: it.name }), el('span', { class: 'pjv-files-size', text: fmtSize(it.size) }));
        row.onclick = () => {
          if (on) selected = selected.filter((x) => x.path !== childPath);
          else selected.push({ name: it.name, path: childPath, size: it.size });
          persist(selected.length ? selected.slice() : null);
          renderChips(); refreshRows();
        };
        rowsBox.append(row);
      }
    }
  };
  const renderCrumb = () => {
    crumb.replaceChildren(el('button', { class: 'pjv-files-crumb-btn', type: 'button', text: '루트', onclick: () => { curPath = ''; load(); } }));
    let acc = '';
    for (const p of (curPath ? curPath.split('/') : [])) {
      acc = acc ? acc + '/' + p : p; const target = acc;
      crumb.append(el('span', { class: 'pjv-files-crumb-sep', text: '/' }), el('button', { class: 'pjv-files-crumb-btn', type: 'button', text: p, onclick: () => { curPath = target; load(); } }));
    }
  };
  const load = async () => {
    rowsBox.replaceChildren(el('div', { class: 'pjv-files-empty', text: '불러오는 중…' }));
    try { curData = await api(B + '/files?path=' + encodeURIComponent(curPath)); }
    catch (e) { curData = { items: [] }; renderCrumb(); rowsBox.replaceChildren(el('div', { class: 'pjv-files-empty', text: '공유 폴더를 불러오지 못했어요' })); return; }
    renderCrumb(); refreshRows();
  };
  wrap.append(el('div', { class: 'pjv-files-head2', text: '공유 폴더에서 파일 선택' }), chips, crumb, rowsBox);
  renderChips(); load();
}

// 관계(태스크 연결) 필드 — 같은 프로젝트의 다른 태스크를 검색해 연결. 값=[{id, name}]. (link-targets 재활용)
function pjvFieldRelEditor(anchor, t, field, value, persist) {
  let linked = Array.isArray(value) ? value.slice() : [];
  const B = '/api/ui/v6/projects/' + field.project_id;
  const chips = el('div', { class: 'pjv-rel-chips' });
  const results = el('div', { class: 'pjv-rel-results' });
  const search = el('input', { type: 'text', class: 'pjv-field-input', placeholder: '연결할 태스크 검색…' });
  let timer: any = null;
  const renderChips = () => {
    chips.replaceChildren();
    if (!linked.length) { chips.append(el('span', { class: 'pjv-files-empty', text: '연결된 태스크가 없어요' })); return; }
    for (const r of linked) {
      chips.append(el('span', { class: 'pjv-rel-chip removable' }, el('span', { text: r.name || ('#' + r.id) }),
        el('button', { class: 'pjv-rel-x', type: 'button', title: '연결 해제', text: '✕', onclick: () => { linked = linked.filter((x) => x.id !== r.id); persist(linked.length ? linked.slice() : null); renderChips(); doSearch(); } })));
    }
  };
  const doSearch = async () => {
    let targets: any[] = [];
    try { const d = await api(B + '/link-targets?exclude=' + t.id + '&q=' + encodeURIComponent(search.value.trim())); targets = (d && d.targets) || []; }
    catch (e) { results.replaceChildren(el('div', { class: 'pjv-files-empty', text: '검색 실패' })); return; }
    const avail = targets.filter((x) => !linked.some((l) => l.id === x.id));
    results.replaceChildren();
    if (!avail.length) { results.append(el('div', { class: 'pjv-files-empty', text: '결과가 없어요' })); return; }
    for (const x of avail) {
      const row = el('button', { class: 'pjv-rel-result', type: 'button' },
        el('span', { class: 'pjv-rel-result-name', text: x.name }), el('span', { class: 'pjv-rel-add', text: '＋ 연결' }));
      row.onclick = () => { linked.push({ id: x.id, name: x.name }); persist(linked.slice()); renderChips(); doSearch(); };
      results.append(row);
    }
  };
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(doSearch, 220); };
  const wrap = el('div', { class: 'pjv-field-editor pjv-rel-editor' }, chips, search, results);
  const close = pjvPopover(anchor, wrap);
  renderChips(); doSearch();
  setTimeout(() => search.focus(), 0);
}

// 드롭다운 편집기 — 옵션 1개 선택 + 없음 + 즉석 옵션 추가.
function pjvFieldDropdownEditor(anchor, t, field, value, persist, reload) {
  const menu = el('div', { class: 'pjv-menu' });
  const close = pjvPopover(anchor, menu);
  for (const o of (field.config && field.config.options) || []) {
    const sel = value === o.id;
    const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' }, pjvOptChip(o));
    item.onclick = () => { close(); persist(sel ? null : o.id); };
    menu.append(item);
  }
  const none = el('button', { class: 'pjv-menu-item' + (value == null ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
  none.onclick = () => { close(); if (value != null) persist(null); };
  menu.append(none);
  menu.append(pjvAddOptionRow(field, async (opt) => {
    close();
    try { await api('/api/ui/v6/tasks/' + t.id + '/fields/' + field.id, { method: 'POST', body: JSON.stringify({ value: opt.id }) }); } catch (_) { /* noop */ }
    reload();
  }));
}

// 라벨 편집기 — 옵션 여러 개(토글, 즉시 저장·셀 실시간 갱신, 팝오버 유지) + 즉석 옵션 추가.
function pjvFieldLabelsEditor(anchor, t, field, value, persist, reload) {
  const selected = Array.isArray(value) ? value.slice() : [];
  const menu = el('div', { class: 'pjv-menu' });
  const close = pjvPopover(anchor, menu);
  for (const o of (field.config && field.config.options) || []) {
    const item = el('button', { class: 'pjv-menu-item' + (selected.includes(o.id) ? ' sel' : ''), type: 'button' }, pjvCheckMini(selected.includes(o.id)), pjvOptChip(o));
    item.onclick = () => {
      const on = selected.includes(o.id);
      if (on) selected.splice(selected.indexOf(o.id), 1); else selected.push(o.id);
      item.classList.toggle('sel', !on);
      item.replaceChildren(pjvCheckMini(!on), pjvOptChip(o));
      persist(selected.length ? selected.slice() : null);
    };
    menu.append(item);
  }
  menu.append(pjvAddOptionRow(field, async (opt) => {
    close();
    try { await api('/api/ui/v6/tasks/' + t.id + '/fields/' + field.id, { method: 'POST', body: JSON.stringify({ value: [...selected, opt.id] }) }); } catch (_) { /* noop */ }
    reload();
  }));
}

// 즉석 옵션 추가 행 — 입력 + Enter. 필드 config 에 옵션 추가 후 onAdded(opt) 콜백.
function pjvAddOptionRow(field, onAdded) {
  const inp = el('input', { type: 'text', class: 'pjv-opt-add-input', placeholder: '＋ 옵션 추가', maxlength: '40' });
  const row = el('div', { class: 'pjv-opt-add' }, inp);
  inp.onclick = (e) => e.stopPropagation();
  inp.addEventListener('keydown', async (e) => {
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    const label = inp.value.trim(); if (!label) return;
    inp.disabled = true;
    try { onAdded(await pjvAddFieldOption(field, label)); }
    catch (err) { toast('옵션 추가 실패 — ' + err.message, true); inp.disabled = false; }
  });
  return row;
}
async function pjvAddFieldOption(field, label) {
  const opts = (field.config && field.config.options) || [];
  const opt = { id: 'o' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), label: label.slice(0, 40), color: PJV_FIELD_PALETTE[opts.length % PJV_FIELD_PALETTE.length] };
  const config = Object.assign({}, field.config, { options: [...opts, opt] });
  await api('/api/ui/v6/fields/' + field.id, { method: 'POST', body: JSON.stringify({ config }) });
  return opt;
}

// ── 컬럼 헤더(커스텀 필드) — 아이콘 + 이름 + ⋯ 메뉴(이름변경/옵션편집/삭제) ──
function pjvColumnHead(field, projectId, reload) {
  const cell = el('div', { class: 'pjv-tcell pjv-thcol' },
    pjvFieldIcon(field.field_type, 'pjv-thcol-ic'),
    el('span', { class: 'pjv-thcol-name', text: field.name, title: field.name }));
  const menuBtn = el('button', { class: 'pjv-thcol-menu', type: 'button', text: '⋯', 'aria-label': field.name + ' 컬럼 설정' });
  menuBtn.onclick = (e) => { e.stopPropagation(); pjvColumnMenu(menuBtn, field, projectId, reload); };
  cell.append(menuBtn);
  return cell;
}
function pjvColumnMenu(anchor, field, projectId, reload) {
  const menu = el('div', { class: 'pjv-menu' });
  const close = pjvPopover(anchor, menu);
  const mk = (label, fn, danger?) => { const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label })); b.onclick = () => { close(); fn(); }; return b; };
  menu.append(mk('이름 변경', () => pjvRenameColumn(anchor, field, reload)));
  const meta = PJV_FIELD_BY_KEY[field.field_type];
  if (meta && meta.config === 'options') menu.append(mk('옵션 편집', () => pjvEditColumnOptions(field, reload)));
  menu.append(mk('컬럼 삭제', () => pjvDeleteColumn(field, reload), true));
}
function pjvRenameColumn(anchor, field, reload) {
  const input = el('input', { type: 'text', class: 'pjv-rename-input', value: field.name, maxlength: '120' });
  const close = pjvPopover(anchor, el('div', { class: 'pjv-menu pjv-rename-pop' }, input));
  input.onkeydown = async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); const v = input.value.trim(); close();
    if (v && v !== field.name) {
      try { await api('/api/ui/v6/fields/' + field.id, { method: 'POST', body: JSON.stringify({ name: v }) }); reload(); }
      catch (err) { toast('수정 실패 — ' + err.message, true); }
    }
  };
  setTimeout(() => { input.focus(); input.select(); }, 0);
}
function pjvEditColumnOptions(field, reload) {
  const ob = pjvOptionsBuilder((field.config && field.config.options) || []);
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const back = overlayBox('옵션 편집 · ' + field.name,
    el('div', { class: 'field' }, ob.el),
    el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
  saveBtn.onclick = async () => {
    const options = ob.get();
    if (!options.length) { toast('옵션을 1개 이상 두세요', true); return; }
    saveBtn.disabled = true;
    const config = Object.assign({}, field.config, { options });
    try { await api('/api/ui/v6/fields/' + field.id, { method: 'POST', body: JSON.stringify({ config }) }); back.remove(); reload(); }
    catch (e) { toast('저장 실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
}
function pjvDeleteColumn(field, reload) {
  if (!confirm("'" + field.name + "' 컬럼을 삭제할까요?\n\n이 컬럼의 모든 값이 함께 사라집니다.")) return;
  (async () => {
    try { await api('/api/ui/v6/fields/' + field.id + '/delete', { method: 'POST', body: JSON.stringify({}) }); toast('컬럼을 삭제했어요'); reload(); }
    catch (e) { toast('삭제 실패 — ' + e.message, true); }
  })();
}

// ── 옵션 빌더(생성/편집 공용) — 색 점(클릭=색 순환)·라벨·삭제 + 추가. 기존 id 보존(값 깨짐 방지). ──
function pjvOptionsBuilder(initial) {
  const rows = el('div', { class: 'pjv-optb-rows' });
  const data: any[] = [];
  const addRow = (o) => {
    o = o || {};
    const item = { id: o.id || null, label: o.label || '', color: o.color || PJV_FIELD_PALETTE[data.length % PJV_FIELD_PALETTE.length] };
    data.push(item);
    let ci = Math.max(0, PJV_FIELD_PALETTE.indexOf(item.color));
    const dot = el('button', { class: 'pjv-optb-dot', type: 'button', style: '--opt:' + item.color, title: '색상 변경' });
    dot.onclick = () => { ci = (ci + 1) % PJV_FIELD_PALETTE.length; item.color = PJV_FIELD_PALETTE[ci]; dot.style.setProperty('--opt', item.color); };
    const inp = el('input', { type: 'text', class: 'pjv-optb-input', value: item.label, placeholder: '옵션 이름', maxlength: '40' });
    inp.oninput = () => { item.label = inp.value; };
    const rm = el('button', { class: 'pjv-optb-rm', type: 'button', text: '✕', title: '삭제' });
    const rowEl = el('div', { class: 'pjv-optb-row' }, dot, inp, rm);
    rm.onclick = () => { const i = data.indexOf(item); if (i >= 0) data.splice(i, 1); rowEl.remove(); };
    rows.append(rowEl);
  };
  (initial && initial.length ? initial : [{}, {}]).forEach(addRow);
  const addBtn = el('button', { class: 'pjv-optb-add', type: 'button', text: '＋ 옵션 추가', onclick: () => addRow(null) });
  return {
    el: el('div', { class: 'pjv-optb' }, rows, addBtn),
    get: () => data.filter((d) => d.label.trim()).map((d) => ({
      id: d.id || ('o' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)),
      label: d.label.trim().slice(0, 40), color: d.color,
    })),
  };
}

// ── (+) 컬럼 추가 버튼 + Fields 패널(클릭업형: 검색 · 새로 만들기/기존 항목 탭 · 형식 목록 · 설정 폼) ──
function pjvAddColumnButton(projectId, reload) {
  const btn = el('button', { class: 'pjv-addcol-btn', type: 'button', title: '컬럼 추가', 'aria-label': '컬럼 추가' }, pjvPlusIcon());
  btn.onclick = (e) => { e.stopPropagation(); pjvOpenFieldsPanel(btn, projectId, reload); };
  return btn;
}
function pjvOpenFieldsPanel(anchor, projectId, reload) {
  const panel = el('div', { class: 'pjv-fields-panel' });
  const close = pjvPopover(anchor, panel);
  let catalog: any = null;
  const showPicker = (tab) => {
    tab = tab || 'new';
    const search = el('input', { type: 'text', class: 'pjv-fields-search', placeholder: '필드 검색…' });
    const tNew = el('button', { class: 'pjv-fields-tab' + (tab === 'new' ? ' on' : ''), type: 'button', text: '새로 만들기', onclick: () => showPicker('new') });
    const tExist = el('button', { class: 'pjv-fields-tab' + (tab === 'existing' ? ' on' : ''), type: 'button', text: '기존 항목', onclick: () => showPicker('existing') });
    const list = el('div', { class: 'pjv-fields-list' });
    panel.replaceChildren(
      el('div', { class: 'pjv-fields-head' }, el('span', { class: 'pjv-fields-title', text: '필드' })),
      search, el('div', { class: 'pjv-fields-tabs' }, tNew, tExist), list);
    const renderNew = () => {
      const qs = search.value.trim().toLowerCase();
      const matches = PJV_FIELD_TYPES.filter((f) => !qs || f.label.toLowerCase().includes(qs) || f.desc.toLowerCase().includes(qs) || f.key.includes(qs));
      list.replaceChildren();
      if (!matches.length) { list.append(el('div', { class: 'pjv-fields-empty', text: '일치하는 형식이 없어요' })); return; }
      list.append(el('div', { class: 'pjv-fields-sec', text: '필드 형식' }));
      for (const f of matches) {
        const row = el('button', { class: 'pjv-field-opt', type: 'button' },
          el('span', { class: 'pjv-field-opt-ic' }, pjvFieldIcon(f.key)),
          el('span', { class: 'pjv-field-opt-tx' }, el('span', { class: 'pjv-field-opt-name', text: f.label }), el('span', { class: 'pjv-field-opt-desc', text: f.desc })));
        row.onclick = () => panel.replaceChildren(pjvFieldConfigForm(projectId, f, reload, close, () => showPicker('new')));
        list.append(row);
      }
    };
    const renderExisting = async () => {
      list.replaceChildren(el('div', { class: 'pjv-fields-empty', text: '불러오는 중…' }));
      if (catalog === null) { try { catalog = await api('/api/ui/v6/projects/' + projectId + '/field-catalog').then((d) => d.fields || []); } catch (_) { catalog = []; } }
      const qs = search.value.trim().toLowerCase();
      const matches = catalog.filter((c) => !qs || String(c.name).toLowerCase().includes(qs));
      list.replaceChildren();
      if (!matches.length) { list.append(el('div', { class: 'pjv-fields-empty', text: '다른 프로젝트에 만든 필드가 없어요' })); return; }
      for (const c of matches) {
        const meta = PJV_FIELD_BY_KEY[c.field_type];
        const row = el('button', { class: 'pjv-field-opt', type: 'button' },
          el('span', { class: 'pjv-field-opt-ic' }, pjvFieldIcon(c.field_type)),
          el('span', { class: 'pjv-field-opt-tx' }, el('span', { class: 'pjv-field-opt-name', text: c.name }), el('span', { class: 'pjv-field-opt-desc', text: meta ? meta.label : c.field_type })));
        row.onclick = () => pjvCreateField(projectId, { field_type: c.field_type, name: c.name, config: c.config || {} }, reload, close);
        list.append(row);
      }
    };
    search.oninput = () => { tab === 'new' ? renderNew() : renderExisting(); };
    (tab === 'new' ? renderNew : renderExisting)();
    setTimeout(() => search.focus(), 0);
  };
  showPicker('new');
}
// 형식 선택 후 설정 폼 — 이름 + (옵션/통화/별점) 설정 → 만들기.
function pjvFieldConfigForm(projectId, f, reload, close, back) {
  const wrap = el('div', { class: 'pjv-fcfg' });
  wrap.append(el('div', { class: 'pjv-fcfg-head' },
    el('button', { class: 'pjv-fcfg-back', type: 'button', text: '←', title: '뒤로', onclick: back }),
    el('span', { class: 'pjv-fcfg-ic' }, pjvFieldIcon(f.key)),
    el('span', { class: 'pjv-fcfg-title', text: f.label })));
  const nameIn = el('input', { type: 'text', class: 'pjv-fcfg-name', value: f.label, maxlength: '120', placeholder: '필드 이름' });
  wrap.append(el('label', { class: 'pjv-fcfg-lbl', text: '이름' }), nameIn);
  let getConfig: any = () => ({});
  if (f.config === 'options') {
    const ob = pjvOptionsBuilder([]);
    wrap.append(el('label', { class: 'pjv-fcfg-lbl', text: '옵션' }), ob.el);
    getConfig = () => ({ options: ob.get() });
  } else if (f.config === 'money') {
    const sel = el('select', { class: 'pjv-fcfg-sel' });
    for (const [code, c] of Object.entries(PJV_CURRENCIES)) sel.append(el('option', { value: code, text: c.label }));
    sel.value = 'KRW';
    wrap.append(el('label', { class: 'pjv-fcfg-lbl', text: '통화' }), sel);
    getConfig = () => ({ currency: sel.value, symbol: PJV_CURRENCIES[sel.value].symbol });
  } else if (f.config === 'rating') {
    const sel = el('select', { class: 'pjv-fcfg-sel' });
    for (const n of [3, 5, 10]) sel.append(el('option', { value: String(n), text: n + '점 만점' }));
    sel.value = '5';
    wrap.append(el('label', { class: 'pjv-fcfg-lbl', text: '별 개수' }), sel);
    getConfig = () => ({ max: Number(sel.value) });
  }
  const createBtn = el('button', { class: 'pjv-fcfg-create', type: 'button', text: '만들기' });
  createBtn.onclick = () => {
    const name = nameIn.value.trim() || f.label;
    const config = getConfig();
    if (f.config === 'options' && (!config.options || !config.options.length)) { toast('옵션을 1개 이상 추가하세요', true); return; }
    pjvCreateField(projectId, { field_type: f.key, name, config }, reload, close);
  };
  wrap.append(el('div', { class: 'pjv-fcfg-actions' }, createBtn, el('button', { class: 'pjv-fcfg-cancel', type: 'button', text: '취소', onclick: back })));
  setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
  return wrap;
}
async function pjvCreateField(projectId, payload, reload, close) {
  try { await api('/api/ui/v6/projects/' + projectId + '/fields', { method: 'POST', body: JSON.stringify(payload) }); if (close) close(); toast('컬럼을 추가했어요'); reload(); }
  catch (e) { toast('컬럼 추가 실패 — ' + e.message, true); }
}

// 더블클릭 → 하위 태스크 인라인 생성(클릭업식). 같은 행에 입력칸 1개만, Enter=생성, Esc/빈 blur=취소.
function pjvShowInlineSubtask(projectId, parentTask, subBox, reload) {
  const existing = subBox.querySelector('.pjv-subadd');
  if (existing) { const i = existing.querySelector('input'); if (i) i.focus(); return; }
  const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '하위 태스크 이름 입력 후 Enter (Esc 취소)', maxlength: '200' });
  const row = el('div', { class: 'pjv-subadd' }, input);
  subBox.append(row);
  setTimeout(() => input.focus(), 0);
  let busy = false;
  input.addEventListener('blur', () => { if (!input.value.trim()) row.remove(); });
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { input.value = ''; row.remove(); return; }
    if (e.key !== 'Enter') return;
    const name = input.value.trim(); if (!name || busy) return;
    busy = true; input.disabled = true;
    try { await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({ name, parent_task_id: parentTask.id }) }); reload(); }
    catch (err) { toast('추가 실패 — ' + err.message, true); input.disabled = false; busy = false; }
  });
}

// 태스크 섹션 — [태스크 N개][Closed 토글] 헤더 + 컬럼헤더 + 상태 그룹(할 일/진행 중/Closed). 클릭업식 리스트뷰.
//  할 일·진행 중은 비어도 항상 표시(인라인 추가행). Closed(완료) 그룹은 기본 숨김 — 헤더의 Closed 토글로만 노출.
//  fields = 커스텀 필드 정의(루트 프로젝트). 컬럼 헤더·각 행에 필드 셀을 끼우고 grid-template 을 동적으로.
function pjvTasksSection(projectId, tasks, members, reload, fields) {
  fields = fields || [];
  const card = el('div', { class: 'card pjv-tasks-card', style: 'margin-bottom:18px' });

  // Closed 토글 버튼 — 누르면 태스크/하위태스크 popover. 활성(노출 중) 시 파란 강조.
  const closedBtn = el('button', { class: 'pjv-closed-btn', type: 'button', title: '닫힌(완료) 항목 표시' },
    pjvCheckCircle(), el('span', { text: 'Closed' }));
  const syncBtn = () => closedBtn.classList.toggle('active', pjvClosedView.tasks || pjvClosedView.subtasks);
  syncBtn();

  // 본문 — Closed 토글 시 서버 재요청 없이 즉시 재렌더(이미 받은 tasks 를 필터).
  const body = el('div', { class: 'pjv-tasks-body' });
  const renderGroups = () => {
    body.replaceChildren();
    if (!tasks.length) {
      body.append(el('div', { class: 'pjv-empty-hint' },
        el('b', { text: '아직 태스크가 없어요.' }),
        ' 아래 ', el('span', { class: 'pjv-empty-chip', text: '＋ 태스크' }),
        ' 를 눌러 이름을 적고 Enter — 첫 할 일을 추가하세요.'));
    }
    // 별도 컬럼헤더 행 없음 — 컬럼 라벨은 첫(맨 위) 그룹 헤더에 합친다(withCols).
    const buckets = { todo: [], in_progress: [], done: [] };
    const sep = pjvSubtaskMode.mode === 'separate';
    for (const t of tasks) {
      buckets[pjvStatusMeta(t.status).bucket].push(t);
      if (sep) for (const s of (t.subtasks || [])) {
        if (!pjvClosedView.subtasks && s.status === 'done') continue;
        buckets[pjvStatusMeta(s.status).bucket].push(s);
      }
    }
    let firstShown = true;
    for (const key of ['in_progress', 'todo', 'done']) { // 진행 중을 할 일 위로(기본 레이아웃)
      if (key === 'done' && !pjvClosedView.tasks) continue; // Closed 그룹은 토글 시에만 노출
      body.append(pjvStatusGroup(projectId, key, buckets[key], members, reload, fields, firstShown));
      firstShown = false;
    }
  };

  // Closed 버튼 = 직접 토글. 한 번 누르면 닫힌(완료) 태스크가 보이고 버튼이 활성(파란) 상태, 다시 누르면 숨김.
  //  하위 닫힘 항목도 함께 따라오게 묶는다(Closed = '닫힌 것 보기' 한 동작).
  closedBtn.onclick = (e) => {
    e.stopPropagation();
    const nv = !pjvClosedView.tasks;
    pjvClosedView.tasks = nv;
    pjvClosedView.subtasks = nv;
    syncBtn();
    renderGroups();
  };

  // 좌상단 하위 태스크(Subtasks) 버튼 — 접힘/펼침/분리. 활성(펼침·분리) 시 파란 강조. (Closed 는 우측 유지)
  const subtaskBtn = el('button', { class: 'pjv-subtask-btn', type: 'button', title: '하위 태스크 표시 방식' },
    pjvSubtaskIcon(), el('span', { class: 'pjv-subtask-btn-label', text: PJV_SUBTASK_BTNLABEL[pjvSubtaskMode.mode] }));
  const syncSubBtn = () => {
    subtaskBtn.classList.toggle('active', pjvSubtaskMode.mode !== 'collapsed');
    const lbl = subtaskBtn.querySelector('.pjv-subtask-btn-label');
    if (lbl) lbl.textContent = PJV_SUBTASK_BTNLABEL[pjvSubtaskMode.mode];
  };
  syncSubBtn();
  subtaskBtn.onclick = (e) => { e.stopPropagation(); pjvSubtaskMenu(subtaskBtn, () => { syncSubBtn(); renderGroups(); }); };
  card.append(el('div', { class: 'card-head' },
    el('div', { class: 'pjv-tasks-head-left' }, el('h2', { text: '태스크' }), subtaskBtn),
    el('div', { class: 'card-head-actions' },
      closedBtn)));
  card.append(body);
  renderGroups();
  return card;
}

// 상태 그룹 — head(캐럿·점·라벨·개수) + body(행들 + 인라인 추가행). 완료 그룹엔 추가행 없음.
// withCols=true 면(첫 그룹) 별도 컬럼헤더 행 대신 이 그룹 헤더에 컬럼 라벨(담당자/마감일/우선순위+커스텀)을 합쳐 컬럼 위에 정렬한다.
function pjvStatusGroup(projectId, key, list, members, reload, fields, withCols) {
  const m = PJV_TASK_STATUS[key];
  const body = el('div', { class: 'pjv-tgroup-body' });
  for (const t of list) body.append(pjvTaskRow(projectId, t, members, reload, 0, fields));
  const countEl = el('span', { class: 'pjv-tgroup-count', text: String(list.length) });
  if (key !== 'done') body.append(pjvAddRow(projectId, key, members, reload, body, countEl, fields));

  let gopen = true;
  const gcaret = el('button', { class: 'pjv-tgroup-caret', type: 'button', text: '▾', 'aria-expanded': 'true' });
  gcaret.onclick = () => {
    gopen = !gopen; gcaret.textContent = gopen ? '▾' : '▸';
    gcaret.setAttribute('aria-expanded', gopen ? 'true' : 'false'); body.hidden = !gopen;
  };
  const dot = el('span', { class: 'pjv-status-dot sm ' + m.cls }, m.glyph ? el('span', { class: 'pjv-status-glyph', text: m.glyph }) : null);
  const labelEl = el('span', { class: 'pjv-tgroup-label', text: m.label });

  let head: any;
  if (withCols) {
    // 컬럼 라벨을 행 그리드에 맞춰 헤더에 합침(별도 thead 없음). 좌측 첫 칸 = 그룹 라벨.
    head = el('div', { class: 'pjv-tgroup-head pjv-tgroup-head-cols ' + m.cls },
      el('div', { class: 'pjv-trow-title-cell' }, dot, labelEl, countEl, gcaret),
      el('div', { class: 'pjv-tcell pjv-colhead', text: '담당자' }),
      el('div', { class: 'pjv-tcell pjv-colhead', text: '마감일' }),
      el('div', { class: 'pjv-tcell pjv-colhead', text: '우선순위' }),
      ...(fields || []).map((f) => pjvColumnHead(f, projectId, reload)),
      el('div', { class: 'pjv-tcell pjv-tcell-add' }, pjvAddColumnButton(projectId, reload)));
    head.style.gridTemplateColumns = pjvGridTemplate(fields);
  } else {
    head = el('div', { class: 'pjv-tgroup-head ' + m.cls }, dot, labelEl, countEl, gcaret);
  }
  return el('div', { class: 'pjv-tgroup' }, head, body);
}

// 인라인 추가행(클릭업식) — 클릭→입력칸, Enter=생성(연속 추가 위해 입력 유지·낙관적 삽입), Esc/빈 blur=접기.
//  생성은 그 그룹 상태로(todo 외엔 생성 후 status 패치). 모달 없이 그 자리에서 바로.
function pjvAddRow(projectId, status, members, reload, body, countEl, fields) {
  const row = el('div', { class: 'pjv-addrow' });
  let indentParent: any = null; // Tab 들여쓰기 — 바로 위 상위태스크의 하위로 만들 때 그 부모 {id,name}. Shift+Tab 으로 해제.
  const trigger = el('button', { class: 'pjv-addrow-trigger', type: 'button' },
    el('span', { class: 'pjv-addrow-plus', text: '＋' }), el('span', { text: '태스크' }));
  const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '태스크 이름 입력 후 Enter (Esc 취소)', maxlength: '200' });
  // 생성 전 드래프트 — 담당자·마감·우선순위를 미리 지정해 생성 직후 한 번에 적용(클릭업식). 셀은 행과 동일.
  const draft = { assignee: null, due_date: null, priority: null };
  const cAssignee = el('div', { class: 'pjv-tcell' });
  const cDue = el('div', { class: 'pjv-tcell' });
  const cPriority = el('div', { class: 'pjv-tcell' });
  const setDraft = (p) => { Object.assign(draft, p); paintCells(); setTimeout(() => { if (row.classList.contains('editing')) input.focus(); }, 0); };
  function paintCells() {
    cAssignee.replaceChildren(pjvAssigneeControl(draft, members, (p) => { Object.assign(draft, p); }));
    cDue.replaceChildren(pjvDueControl(draft, setDraft));
    cPriority.replaceChildren(pjvPriorityControl(draft, setDraft));
  }
  const collapse = () => { row.classList.remove('editing'); draft.assignee = draft.due_date = draft.priority = null; indentParent = null; row.replaceChildren(trigger); };
  // 추가행 제목 칸 — 실제 태스크 행과 동일 구조(캐럿 자리 + 상태 동그라미 + 입력)로 그린다. 들여쓰면 paddingLeft 22px(하위 위치)
  //  + 상태 동그라미는 todo(점선). 안 들여쓰면 그룹 상태 동그라미. → 입력 텍스트·동그라미가 행과 픽셀 단위로 정확히 일치.
  const statusDotPlaceholder = (st) => {
    const meta = pjvStatusMeta(st);
    return el('span', { class: 'pjv-status-dot ' + meta.cls, 'aria-hidden': 'true' },
      meta.glyph ? el('span', { class: 'pjv-status-glyph', text: meta.glyph }) : null);
  };
  const buildTitleCell = () => {
    const tc = el('div', { class: 'pjv-trow-title-cell' },
      el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' }),
      statusDotPlaceholder(indentParent ? 'todo' : status),
      input);
    if (indentParent) tc.style.paddingLeft = '22px';
    return tc;
  };
  // 펼침: 태스크 행과 동일한 그리드 — 이름 입력 + 담당자·마감·우선순위 드래프트 셀(생성 시 적용). 커스텀 필드는 생성 후 행에서.
  const expand = () => {
    row.classList.add('editing');
    row.style.gridTemplateColumns = pjvGridTemplate(fields);
    paintCells();
    row.replaceChildren(
      buildTitleCell(),
      cAssignee, cDue, cPriority,
      ...(fields || []).map(() => el('div', { class: 'pjv-tcell' })),
      el('div', { class: 'pjv-tcell pjv-tcell-add' }));
    input.focus();
  };
  trigger.onclick = expand;
  // Tab 들여쓰기 시각화 — 제목 칸을 한 단 들이고(하위 느낌) 안내문을 부모 이름으로 바꾼다.
  const applyIndent = () => {
    const old = row.querySelector('.pjv-trow-title-cell');
    if (old) old.replaceWith(buildTitleCell()); // 캐럿+동그라미+들여쓰기까지 하위태스크 행과 동일하게 다시 그림
    input.placeholder = indentParent
      ? ('“' + (indentParent.name || '상위 태스크') + '” 의 하위 — 이름 입력 후 Enter (Shift+Tab 해제)')
      : '태스크 이름 입력 후 Enter (Esc 취소)';
    input.focus();
  };
  let busy = false;
  // 생성 — Enter(keepOpen=연속추가) 또는 바깥클릭. 생성 후 드래프트(담당자·마감·우선순위)를 한 번에 패치.
  const commit = async (keepOpen) => {
    if (busy) return;
    const name = input.value.trim();
    if (!name) { if (!keepOpen) collapse(); return; }
    busy = true; input.disabled = true;
    if (indentParent) {
      // Tab 들여쓰기 — 위 상위태스크의 하위로 생성. 생성 후 reload 로 중첩 반영(부모 caret·하위수 갱신).
      try { await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({ name, parent_task_id: indentParent.id }) }); reload(); }
      catch (err) { toast('하위 추가 실패 — ' + err.message, true); input.disabled = false; busy = false; }
      return;
    }
    try {
      const created = await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({ name }) }).then((d) => d && d.task);
      if (created && status !== 'todo') {
        await api('/api/ui/v6/tasks/' + created.id, { method: 'POST', body: JSON.stringify({ status }) }).catch(() => {});
      }
      const patch: any = {};
      if (draft.assignee) patch.assignee = draft.assignee;
      if (draft.due_date) patch.due_date = draft.due_date;
      if (draft.priority) patch.priority = draft.priority;
      if (created && Object.keys(patch).length) {
        await api('/api/ui/v6/tasks/' + created.id, { method: 'POST', body: JSON.stringify(patch) }).catch(() => {});
      }
      const t = Object.assign({ priority: null, assignee: null, due_date: null }, created, patch, { status, subtasks: [], field_values: {} });
      body.insertBefore(pjvTaskRow(projectId, t, members, reload, 0, fields), row);
      if (countEl) countEl.textContent = String((parseInt(countEl.textContent, 10) || 0) + 1);
      const card = row.closest('.pjv-tasks-card');
      const hint = card && card.querySelector('.pjv-empty-hint');
      if (hint) hint.remove();
      input.value = ''; input.disabled = false; busy = false;
      draft.assignee = draft.due_date = draft.priority = null; paintCells();
      if (keepOpen) input.focus(); else collapse();
    } catch (err) { toast('추가 실패 — ' + err.message, true); input.disabled = false; busy = false; }
  };
  // 바깥클릭(=커밋) 가드 — 셀 팝오버 편집 중이거나 행 내부 포커스면 보류(드래프트 설정 중 조기 생성 방지).
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (busy || !row.classList.contains('editing')) return;
      if (document.querySelector('.pjv-pop')) return;        // 셀 팝오버 편집 중
      if (row.contains(document.activeElement)) return;       // 행 내부 포커스(셀 버튼 등)
      commit(false);
    }, 130);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; collapse(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) { if (indentParent) { indentParent = null; applyIndent(); input.focus(); } return; }
      // 들여쓰기 — 바로 위 상위태스크를 부모로(클릭업식). 위에 (상위)태스크가 없으면 무시.
      const prev = row.previousElementSibling;
      const pid = prev && prev.dataset ? prev.dataset.taskId : null;
      if (pid && prev.dataset.taskLevel !== 'subtask') { indentParent = { id: Number(pid), name: prev.dataset.taskName || '' }; applyIndent(); input.focus(); }
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
  });
  collapse();
  return row;
}

// 행 오른쪽 끝 ⋯ 더보기 메뉴(클릭업식) — 하위 태스크 추가(상위만)·이름 변경·삭제.
function pjvRowMore(projectId, t, depth, reload, onAddSub) {
  const btn = el('button', { class: 'pjv-trow-more', type: 'button', title: '더보기', 'aria-label': '태스크 작업' , text: '⋯' });
  btn.onclick = (e) => {
    e.stopPropagation();
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(btn, menu);
    const mkItem = (label, onPick, danger?) => {
      const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label }));
      b.onclick = () => { close(); onPick(); };
      return b;
    };
    if (depth === 0 && onAddSub) menu.append(mkItem('하위 태스크 추가', onAddSub));
    menu.append(mkItem('이름 변경', () => pjvRenameTask(btn, t, reload)));
    menu.append(mkItem('삭제', () => pjvDeleteTask(t, reload), true));
  };
  return btn;
}

// 이름 변경 — 앵커 아래 인라인 입력 팝오버. Enter 저장 / Esc·바깥클릭 취소.
function pjvRenameTask(anchor, t, reload) {
  const cur = t.name || t.title || '';
  const input = el('input', { type: 'text', class: 'pjv-rename-input', value: cur, maxlength: '200' });
  const close = pjvPopover(anchor, el('div', { class: 'pjv-menu pjv-rename-pop' }, input));
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const v = input.value.trim(); close(); if (v && v !== cur) pjvPatchTask(t.id, { name: v }, reload); }
  };
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

// 삭제 — 확인 후 task_delete_v6. 하위 동반 삭제 경고. #/trash 복원 가능.
function pjvDeleteTask(t, reload) {
  const nm = t.name || t.title || '이 태스크';
  const nSub = (t.subtasks || []).length;
  const msg = "'" + nm + "' 태스크를 삭제할까요?" + (nSub ? '\n\n하위 ' + nSub + '개도 함께 삭제됩니다.' : '') + '\n\n#/trash 에서 복원할 수 있습니다.';
  if (!confirm(msg)) return;
  (async () => {
    try {
      await api('/api/ui/v6/tasks/' + t.id + '/delete', { method: 'POST', body: JSON.stringify({}) });
      toast('삭제했습니다 — #/trash 에서 복원 가능');
      reload();
    } catch (e) { toast('삭제 실패 — ' + e.message, true); }
  })();
}

// 태스크 한 행 — [캐럿][상태점] 제목 [하위수] | 담당자 | 마감일 | 우선순위 | [⋯]. 하위는 중첩(상위만 하위 추가 가능).
function pjvTaskRow(projectId, t, members, reload, depth, fields) {
  depth = depth || 0;
  fields = fields || [];
  // 닫힌(완료) 하위는 Closed>하위태스크 토글 시에만 노출(클릭업 동형). separate 모드면 하위는 최상위 행으로 빠져 중첩 X.
  const allSubs = t.subtasks || [];
  const subsVisible = pjvClosedView.subtasks ? allSubs : allSubs.filter((s) => s.status !== 'done');
  const subs = pjvSubtaskMode.mode === 'separate' ? [] : subsVisible;
  const isDone = t.status === 'done';
  const wrap = el('div', { class: 'pjv-trow-wrap', 'data-task-id': t.id, 'data-task-name': t.name || t.title || '', 'data-task-level': t.level || 'task' });

  let open = false;
  const caret = subs.length
    ? el('button', { class: 'pjv-trow-caret', type: 'button', 'aria-expanded': 'false', text: '▸' })
    : el('span', { class: 'pjv-trow-caret empty', 'aria-hidden': 'true' });

  // el() 로 구성 — null 자식을 건너뛴다(네이티브 .append(null) 은 "null" 텍스트를 삽입하므로 금지).
  // 태그 칩(클릭업식) — 이름 옆에 최대 2개 + 나머지는 "+N". 색은 태그 색.
  const ttags = t.tags || [];
  const tagsEl = ttags.length ? el('span', { class: 'pjv-trow-tags' },
    ...ttags.slice(0, 2).map((tg) => el('span', { class: 'pjv-trow-tag', style: '--tag:' + (tg.color || PJV_TAG_NONE), title: tg.name, text: tg.name })),
    ttags.length > 2 ? el('span', { class: 'pjv-trow-tag-more', text: '+' + (ttags.length - 2) }) : null) : null;
  const titleCell = el('div', { class: 'pjv-trow-title-cell' },
    caret, pjvStatusControl(t, reload),
    el('span', { class: 'pjv-trow-title' + (isDone ? ' done' : ''), text: t.name || t.title || '(제목 없음)' }),
    subs.length ? el('span', { class: 'pjv-trow-subcount', title: subs.length + '개 하위', text: String(subs.length) }) : null,
    tagsEl);
  if (depth) titleCell.style.paddingLeft = (depth * 22) + 'px';

  // 하위 영역 — 하위 행도 pjvTaskRow 재귀라 담당자·마감일·우선순위·커스텀필드까지 상위와 완전 동일하게 동작.
  const subBox = el('div', { class: 'pjv-trow-subs' });
  subBox.hidden = true;
  if (subs.length && depth < 4) {
    for (const s of subs) subBox.append(pjvTaskRow(projectId, s, members, reload, depth + 1, fields));
    caret.onclick = () => {
      open = !open; caret.textContent = open ? '▾' : '▸';
      caret.setAttribute('aria-expanded', open ? 'true' : 'false'); subBox.hidden = !open;
    };
    // 펼침 모드 — 모든 하위를 처음부터 펼쳐 보여준다(개별 caret 으로 다시 접을 수 있음).
    if (pjvSubtaskMode.mode === 'expanded') { open = true; subBox.hidden = false; caret.textContent = '▾'; caret.setAttribute('aria-expanded', 'true'); }
  }

  // ⋯메뉴 '하위 태스크 추가'(상위 depth 0 만) → 부모 아래 인라인 입력행 펼치고 포커스. 모달/박스 없음.
  let subAddRow: any = null;
  const startAddSub = () => {
    subBox.hidden = false; open = true;
    if (caret.tagName === 'BUTTON') { caret.textContent = '▾'; caret.setAttribute('aria-expanded', 'true'); }
    if (!subAddRow) {
      const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '하위 태스크 이름 입력 후 Enter (Esc 취소)', maxlength: '200' });
      const tcell = el('div', { class: 'pjv-trow-title-cell' }, input);
      tcell.style.paddingLeft = ((depth + 1) * 22) + 'px';
      subAddRow = el('div', { class: 'pjv-addrow editing pjv-subaddrow' }, tcell,
        el('div', { class: 'pjv-tcell' }), el('div', { class: 'pjv-tcell' }), el('div', { class: 'pjv-tcell' }),
        ...fields.map(() => el('div', { class: 'pjv-tcell' })),
        el('div', { class: 'pjv-tcell pjv-tcell-add' }));
      subAddRow.style.gridTemplateColumns = pjvGridTemplate(fields);
      let busy = false;
      const remove = () => { if (subAddRow) { subAddRow.remove(); subAddRow = null; } };
      const commit = async () => {
        if (busy) return; const name = input.value.trim();
        if (!name) { remove(); return; }
        busy = true; input.disabled = true;
        try {
          await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({ name, parent_task_id: t.id }) });
          reload();
        } catch (err) { toast('하위 추가 실패 — ' + err.message, true); input.disabled = false; busy = false; }
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { input.value = ''; remove(); }
        else if (e.key === 'Enter') { e.preventDefault(); commit(); }
      });
      subBox.append(subAddRow);
    }
    const inp = subAddRow.querySelector('input'); if (inp) inp.focus();
  };

  const moreBtn = pjvRowMore(projectId, t, depth, reload, (depth === 0 && t.level !== 'subtask') ? startAddSub : null);

  const rowEl = el('div', { class: 'pjv-trow' },
    titleCell,
    el('div', { class: 'pjv-tcell' }, pjvAssigneeControl(t, members, (p) => pjvSaveTask(t.id, p))),
    el('div', { class: 'pjv-tcell' }, pjvDueControl(t, (p) => pjvPatchTask(t.id, p, reload))),
    el('div', { class: 'pjv-tcell' }, pjvPriorityControl(t, (p) => pjvPatchTask(t.id, p, reload))),
    ...fields.map((f) => el('div', { class: 'pjv-tcell pjv-fcell' }, pjvFieldControl(t, f, reload))),
    el('div', { class: 'pjv-tcell pjv-tcell-add' }, moreBtn));
  rowEl.style.gridTemplateColumns = pjvGridTemplate(fields);
  wrap.append(rowEl);
  wrap.append(subBox);
  return wrap;
}

// 태스크/하위 추가 폼 — 이름(필수)·설명(선택). parentTaskId 있으면 하위로 생성(parent_task_id).
function pjvAddTask(projectId, parentTaskId, reload) {
  const nameIn = el('input', { type: 'text', placeholder: parentTaskId ? '하위 태스크 이름' : '태스크 이름', maxlength: '200' });
  const descIn = el('textarea', { rows: '2', placeholder: '설명 (선택)', maxlength: '4000' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '추가' });
  const back = overlayBox(parentTaskId ? '하위 태스크 추가' : '새 태스크',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '설명 (선택)' }), descIn),
    el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
  setTimeout(() => nameIn.focus(), 0);
  const go = async () => {
    const name = nameIn.value.trim();
    if (!name) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      await api('/api/ui/v6/projects/' + projectId + '/tasks', { method: 'POST', body: JSON.stringify({
        name, description: descIn.value.trim() || undefined,
        parent_task_id: parentTaskId != null ? parentTaskId : undefined,
      }) });
      back.remove();
      toast(parentTaskId ? '하위 태스크를 추가했습니다' : '태스크를 추가했습니다');
      reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

// 필요 지식 / 산출 지식 — 두 섹션. 각 행은 지식 상세(#/k/:name)로 링크.
function companyTimelineSection() {
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
  const body = el('div', {});
  const st = { type: '' };
  let members: any[] = [];
  let acts: any[] = [];
  let shown = 6;
  const nameOf = (pid) => { const m = members.find((x) => x.id === pid); return (m && m.display_name) || pid || '—'; };
  const TYPES = [['', '전체'], ['commit', '커밋'], ['comment', '코멘트'], ['decision', '결정'], ['status_change', '상태 변경'], ['review', '검토']];
  const chipsBar = el('div', { class: 'proj-tl-filter' });
  const paintChips = () => chipsBar.replaceChildren(...TYPES.map(([v, label]) =>
    el('button', { class: 'proj-tl-chip' + (st.type === v ? ' active' : ''), text: label, onclick: () => { st.type = v; paintChips(); load(); } })));
  paintChips();
  card.append(chipsBar, body);
  api('/api/ui/dash/members').then((d) => { members = (d && d.members) || []; if (acts.length) render(); }).catch(() => {});
  load();
  return card;

  async function load() {
    body.replaceChildren(skeletonRows(4));
    try {
      const qs = '?limit=200' + (st.type ? '&type=' + encodeURIComponent(st.type) : '');
      acts = await api('/api/ui/activity/list' + qs).then((d) => (Array.isArray(d) ? d : (d && d.rows) || []));
    } catch (e) { body.replaceChildren(errorNote(e, '작업을 불러오지 못했습니다')); return; }
    shown = 6;
    render();
  }
  function render() {
    if (!acts.length) { body.replaceChildren(el('div', { class: 'empty', text: '아직 기록된 작업이 없습니다.' })); return; }
    const list = el('div', { class: 'proj-tl-list' }, ...acts.slice(0, shown).map(actRow));
    body.replaceChildren(list);
    if (acts.length > shown) {
      body.append(el('button', { class: 'btn btn-ghost btn-sm proj-tl-more',
        text: '＋ ' + (acts.length - shown) + '개 더 보기', onclick: () => { shown += 10; render(); } }));
    }
  }
  function actRow(a) { return activityTimelineRow(a, nameOf); }
}

// 한 섹션(진행 중 / 완료) — 카드 + 개수 배지 + 행 리스트(비었으면 안내).
function projectSection(label, list, emptyText, reload, done, opts) {
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' },
    el('div', { class: 'card-head' },
      el('h3', { class: 'project-sec-title' }, label,
        el('span', { class: 'project-count', text: String(list.length) }))));
  if (!list.length) { card.append(el('div', { class: 'empty', text: emptyText })); return card; }
  card.append(el('div', { class: 'project-grid' + (done ? ' done' : '') }, ...list.map((p) => projectTile(p, reload, opts))));
  return card;
}

// 프로젝트 타일 카드 — 이름·설명·팀원 아바타(facepile)·메타 + 상태 토글. 카드 클릭=상세.
//  opts.statusBase / opts.detailBase 로 v1(/api/ui/projects, #/projects)·v6(/api/ui/v6/projects, #/projects2/p) 공용.
function projectTile(p, reload, opts) {
  const statusBase = (opts && opts.statusBase) || '/api/ui/projects/';
  const detailBase = (opts && opts.detailBase) || '#/projects/';
  const select = opts && opts.select;             // 선택(일괄삭제) 모드 — 있으면 클릭=체크 토글, 상태 토글 숨김.
  const selectable = !!select && select.canSelect(p); // 내가 만든 것만 선택 가능.
  const isDone = p.status === 'done';
  const tile = el('div', { class: 'project-tile' + (isDone ? ' done' : '') + (select ? ' select-mode' : '') });

  if (select && selectable) {
    tile.classList.add('selectable');
    const cb = el('span', { class: 'project-tile-check', 'aria-hidden': 'true' });
    const apply = (on) => { tile.classList.toggle('selected', on); cb.textContent = on ? '✓' : ''; tile.setAttribute('aria-checked', on ? 'true' : 'false'); };
    apply(select.ids.has(p.id));
    tile.append(cb);
    tile.setAttribute('role', 'checkbox');
    tile.setAttribute('tabindex', '0');
    const toggle = () => { const on = !select.ids.has(p.id); if (on) select.ids.add(p.id); else select.ids.delete(p.id); apply(on); select.onToggle(); };
    tile.addEventListener('click', toggle);
    tile.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
  } else if (select) {
    // 선택 모드지만 내 프로젝트 아님 — 선택 불가(흐리게), 클릭은 상세로.
    tile.classList.add('not-selectable');
    tile.addEventListener('click', () => { location.hash = detailBase + p.id; });
  } else {
    // 완료 카드는 비활성 느낌 — 전체클릭 대신 아래 '보기' 버튼으로 접근. 활성 카드만 전체클릭=상세.
    if (!isDone) tile.addEventListener('click', () => { location.hash = detailBase + p.id; });
  }

  tile.append(el('div', { class: 'project-tile-name', text: p.name }));
  if (p.description) tile.append(el('div', { class: 'project-tile-desc', text: p.description }));

  const members = p.members || [];
  if (members.length) {
    const faces = el('div', { class: 'project-tile-faces' });
    for (const m of members.slice(0, 5)) {
      faces.append(el('span', { class: 'project-face', style: 'background:' + avatarColor(m.member_id), title: m.display_name || m.member_id, text: initials(m.display_name || m.member_id) }));
    }
    if (members.length > 5) faces.append(el('span', { class: 'project-face more', text: '+' + (members.length - 5) }));
    tile.append(faces);
  }

  const when = isDone ? (p.completed_at || p.updated_at) : (p.updated_at || p.created_at);
  const meta = el('div', { class: 'project-tile-meta', text: (isDone ? '완료 ' : '갱신 ') + (when ? relTime(when) : '') });
  const foot = el('div', { class: 'project-tile-foot' }, meta);
  if (!select) {
    // 비선택 모드만 상태 토글 노출 — 선택 모드에선 카드 클릭(=체크)과 충돌 방지 위해 숨김.
    const changeStatus = async (ev, status, okMsg) => {
      ev.stopPropagation();
      const btn = ev.currentTarget; btn.disabled = true;
      try {
        await api(statusBase + p.id + '/status', { method: 'POST', body: JSON.stringify({ status }) });
        toast(okMsg); reload();
      } catch (e) { toast('실패 — ' + e.message, true); btn.disabled = false; }
    };
    if (isDone) {
      // 완료 카드 — '보기'(상세 접근) + '진행 중으로'(재개). 둘 다 ghost(파란 강조 없음, 비활성 톤 유지).
      const viewBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '보기',
        onclick: (ev) => { ev.stopPropagation(); location.hash = detailBase + p.id; } });
      const reBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '진행 중으로',
        onclick: (ev) => changeStatus(ev, 'active', '진행 중으로 옮겼습니다') });
      foot.append(el('div', { class: 'project-tile-acts' }, viewBtn, reBtn));
    } else {
      const toggle = el('button', { class: 'btn btn-sm btn-primary', text: '완료',
        onclick: (ev) => changeStatus(ev, 'done', '완료로 표시했습니다') });
      foot.append(toggle);
    }
  } else if (!selectable) {
    foot.append(el('span', { class: 'project-tile-mine-no', text: '내 프로젝트 아님' }));
  }
  tile.append(foot);
  return tile;
}

// 팀원 선택 위젯 — 이름 검색으로 하나씩 추가(클릭), 선택된 사람은 칩으로(× 제거). 생성·수정 공용.
//  동기 반환(즉시 로딩표시) + 비동기 채움. getSelected() 가 현재 선택 id 배열.
function memberPicker(preselected, opts?) {
  const selected = new Set(preselected || []);
  let all: any[] = [];
  const chips = el('div', { class: 'proj-mp-chips' });
  const searchIn = el('input', { type: 'text', class: 'proj-mp-search', placeholder: '이름으로 검색해 추가…' });
  const results = el('div', { class: 'proj-mp-results' }, el('span', { class: 'admin-hint', text: '불러오는 중…' }));
  const box = el('div', { class: 'proj-mp' }, chips, searchIn, results);

  function paintChips() {
    const sel = all.filter((m) => selected.has(m.id));
    if (!sel.length) { chips.replaceChildren(el('span', { class: 'admin-hint', text: '아직 선택된 팀원이 없어요.' })); return; }
    chips.replaceChildren(...sel.map((m) => el('span', { class: 'proj-mp-chip' },
      el('span', { text: m.display_name || m.id }),
      el('button', { class: 'proj-mp-chip-x', type: 'button', text: '×', onclick: () => { selected.delete(m.id); paintChips(); paintResults(); } }))));
  }
  function paintResults() {
    if (!all.length) { results.replaceChildren(el('span', { class: 'admin-hint', text: '등록된 사람 구성원이 없습니다.' })); return; }
    const q = searchIn.value.trim().toLowerCase();
    const cand = all.filter((m) => !selected.has(m.id) && (!q || (m.display_name || m.id).toLowerCase().includes(q)));
    if (!cand.length) { results.replaceChildren(el('div', { class: 'proj-mp-empty', text: q ? '일치하는 사람이 없어요.' : '추가할 수 있는 사람을 모두 골랐어요.' })); return; }
    results.replaceChildren(...cand.map((m) => el('div', { class: 'proj-mp-row', onclick: () => { selected.add(m.id); searchIn.value = ''; paintChips(); paintResults(); searchIn.focus(); } },
      el('span', { class: 'proj-mp-ava', style: 'background:' + avatarColor(m.id), text: initials(m.display_name || m.id) }),
      el('span', { class: 'proj-mp-name', text: m.display_name || m.id }),
      el('span', { class: 'proj-mp-add', text: '＋ 추가' }))));
  }
  searchIn.addEventListener('input', paintResults);
  api('/api/ui/dash/members').then((d) => {
    all = (d && d.members) || [];
    // 생성 폼 기본값: 나(생성자)를 디폴트 선택 — 활성 구성원 목록에 실제 있을 때만(유령 id 방지). ×로 해제 가능.
    if (opts && opts.includeMe) {
      const meId = state.me && state.me.userId;
      if (meId && all.some((m) => m.id === meId)) selected.add(meId);
    }
    paintChips(); paintResults();
  })
    .catch(() => results.replaceChildren(el('span', { class: 'admin-hint', text: '팀원 목록을 불러오지 못했습니다.' })));
  return { box, getSelected: () => [...selected] };
}

// 새 프로젝트 오버레이 폼 — 이름(필수)·설명(선택)·팀원. 생성 시 폴더 자동 생성 + 새 전용 페이지로 이동.
async function authDownload(url, filename) {
  const token = localStorage.getItem(TOKEN_KEY);
  let res: any;
  try { res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); }
  catch (e) { toast('다운로드 실패 — ' + e.message, true); return; }
  if (!res.ok) { toast('다운로드 실패 (' + res.status + ')', true); return; }
  const blob = await res.blob();
  const a = el('a', { href: URL.createObjectURL(blob), download: filename || 'download' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
// 인증 fetch 업로드(PUT raw 스트림). 파일 본문 그대로 — Content-Type 비워 서버가 스트림으로 받음.
async function authUpload(url, file) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(url, { method: 'PUT', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: file });
  if (!res.ok) { let m = ''; try { m = (await res.json()).error; } catch (_) { /* */ } throw new Error(m || ('업로드 실패 (' + res.status + ')')); }
}
// 진행률 콜백 업로드 — fetch 는 업로드 progress 가 없어 XHR 사용. onProgress(pct 0~100).
function authUploadProgress(url, file, onProgress) {
  return new Promise<void>((resolve, reject) => {
    const token = localStorage.getItem(TOKEN_KEY);
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable && onProgress) onProgress((ev.loaded / ev.total) * 100); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else { let m = ''; try { m = JSON.parse(xhr.responseText).error; } catch (_) { /* */ } reject(new Error(m || ('업로드 실패 (' + xhr.status + ')'))); }
    };
    xhr.onerror = () => reject(new Error('네트워크 오류'));
    xhr.send(file);
  });
}
function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}
function fileExt(name) { const i = String(name || '').lastIndexOf('.'); return i >= 0 ? name.slice(i + 1).toLowerCase() : ''; }
// 클립보드 붙여넣기 이미지 → 업로드용 File(고유 이름). File.name 은 read-only 라 새 File 로 감싼다.
//  같은 시각 다중 붙여넣기 충돌 방지로 날짜-시각(+ms 2자리, 다중이면 순번). 공유폴더는 유니코드 보존이라 한글 이름 OK.
function pastedImageFile(blob, seq) {
  const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/tiff': 'tiff' };
  const ext = extMap[blob.type] || (String(blob.type).split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  const ts = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + p(d.getMilliseconds()).slice(0, 2);
  const name = '붙여넣기-' + ts + (seq ? '-' + (seq + 1) : '') + '.' + ext;
  try { return new File([blob], name, { type: blob.type }); }
  catch (_) { try { blob.name = name; } catch (_2) { /* File.name read-only */ } return blob; }
}

// 붙여넣기 전 이름 지정 + 동작 안내 팝업 — 클립보드 이미지를 공유 폴더로 올리기 전에 띄운다.
//  단일: [이름][.확장자(고정 태그)]. 다중: 공통 베이스명 + 각 파일에 -1,-2…와 원래 확장자. 확인 시 onConfirm(files).
//  확장자를 입력칸 밖 고정 태그로 둬, 타이핑 중 확장자가 지워지는 것을 구조적으로 막는다.
function openPasteDialog(imgs, destLabel, onConfirm) {
  const multi = imgs.length > 1;
  const defName = pastedImageFile(imgs[0], 0).name;            // 기존 자동이름 규칙 재사용
  const ext0 = fileExt(defName);
  const stem0 = ext0 ? defName.slice(0, defName.length - ext0.length - 1) : defName;
  const nameIn = el('input', { type: 'text', value: stem0, maxlength: '120', placeholder: '파일 이름' });

  const action = el('p', { class: 'paste-action' },
    '클립보드의 ', el('b', { text: '이미지 ' + imgs.length + '개' }),
    ' 를 ', el('b', { text: destLabel }), ' 에 업로드합니다.');

  const nameRow = el('div', { class: 'paste-name-row' }, nameIn,
    multi ? null : el('span', { class: 'paste-ext', text: '.' + (ext0 || 'png') }));
  const hint = multi
    ? el('p', { class: 'admin-hint', text: '각 파일 이름 뒤에 -1, -2 … 와 원래 확장자가 붙습니다.' })
    : null;

  const saveBtn = el('button', { class: 'btn btn-primary', text: multi ? (imgs.length + '개 올리기') : '올리기' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox('붙여넣기',
    action,
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameRow, hint),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0); // 확장자는 입력칸 밖이라 전체선택해도 안전

  const go = () => {
    let stem = nameIn.value.trim().replace(/[/\\]/g, '-').replace(/^\.+/, '').replace(/\s+/g, ' ').trim();
    if (!stem) stem = stem0;
    const files = imgs.map((b, i) => {
      const ext = fileExt(pastedImageFile(b, 0).name) || 'png';
      const nm = (multi ? stem + '-' + (i + 1) : stem) + '.' + ext;
      try { return new File([b], nm, { type: b.type }); }
      catch (_) { try { b.name = nm; } catch (_2) { /* read-only */ } return b; }
    });
    back.remove();
    onConfirm(files);
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}
const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
function iconFor(name) {
  const e = fileExt(name);
  if (IMG_EXTS.includes(e)) return '🖼️';
  if (['md', 'txt', 'rtf', 'csv'].includes(e)) return '📝';
  if (e === 'pdf') return '📕';
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(e)) return '🗜️';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(e)) return '🎬';
  if (['mp3', 'wav', 'flac', 'm4a'].includes(e)) return '🎵';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'json', 'html', 'css', 'java', 'go', 'rs', 'c', 'cpp', 'rb', 'php', 'yml', 'yaml', 'toml'].includes(e)) return '📄';
  return '📄';
}

// 공유 폴더 단색 라인 아이콘 — 컬러 이모지 대신(calm 예산: 색이 아니라 형태로 구분).
//  currentColor 를 상속하므로 색·획굵기는 CSS(.fic)에서 통제. 확장자→형태만 매핑(타입은 파일명 확장자가 이미 말해줌).
function fileKind(name) {
  const e = fileExt(name);
  if (IMG_EXTS.includes(e)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(e)) return 'video';
  if (['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'].includes(e)) return 'audio';
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(e)) return 'archive';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'json', 'html', 'css', 'java', 'go', 'rs', 'c', 'cpp', 'rb', 'php', 'yml', 'yaml', 'toml'].includes(e)) return 'code';
  return 'file';
}
const FILE_ICON_GLYPHS = {
  dir:     [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
  file:    [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }], ['polyline', { points: '14 3 14 8 19 8' }], ['line', { x1: 9, y1: 13, x2: 15, y2: 13 }], ['line', { x1: 9, y1: 16.5, x2: 15, y2: 16.5 }]],
  image:   [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['circle', { cx: 8.5, cy: 9.5, r: 1.5 }], ['polyline', { points: '21 16 15.5 11 5 20' }]],
  video:   [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['polygon', { points: '10 8.5 16 12 10 15.5 10 8.5' }]],
  audio:   [['path', { d: 'M9 17V5l10-2v12' }], ['circle', { cx: 6, cy: 17, r: 3 }], ['circle', { cx: 16, cy: 15, r: 3 }]],
  archive: [['rect', { x: 4, y: 4, width: 16, height: 4, rx: 1 }], ['path', { d: 'M5.5 8v10a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8' }], ['line', { x1: 10.5, y1: 12, x2: 13.5, y2: 12 }]],
  code:    [['polyline', { points: '15 7 20 12 15 17' }], ['polyline', { points: '9 7 4 12 9 17' }]],
};
// 파일/폴더 단색 라인 아이콘 — 동시 리팩터가 이 함수 정의를 지우고 호출처(공유폴더 참조목록·파일 필드·설정 참고파일)는
//  남겨 ReferenceError(fileIconSvg is not defined)가 났다. fileKind·FILE_ICON_GLYPHS(둘 다 생존)에 기반해 복구.
function fileIconSvg(name, isDir) {
  const kind = isDir ? 'dir' : fileKind(name);
  const node = sv('svg', { class: 'fic fic-' + kind, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  for (const [t, a] of (FILE_ICON_GLYPHS[kind] || FILE_ICON_GLYPHS.file)) node.append(sv(t as any, a));
  return node;
}
function fileThumb(id, it, rel, base) {
  if (it.type === 'dir') return folderThumb();
  const ext = fileExt(it.name);
  if (IMG_EXTS.includes(ext)) return imageThumb(id, rel, base, it.name);
  return docIcon(ext);
}
// 폴더 — 맥 느낌 소프트 블루(두 톤).
function folderThumb() {
  const n = sv('svg', { class: 'ft ft-folder', viewBox: '0 0 48 40', fill: 'none', 'aria-hidden': 'true' });
  n.append(sv('path', { class: 'ft-folder-tab', d: 'M4 9a3 3 0 0 1 3-3h10.5l4 4H4z' }));
  n.append(sv('path', { class: 'ft-folder-body', d: 'M4 12a3 3 0 0 1 3-3h34a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z' }));
  return n;
}
// 타입별 파일 라벨/색 — 동시 리팩터가 이 const 정의를 지우고 docIcon 의 사용처만 남겨 공유 폴더 파일 아이콘이
//  ReferenceError(FILE_TYPE_META is not defined)로 깨졌다(→ '폴더를 불러오지 못했습니다'). 사용처 바로 위에 복구.
const FILE_TYPE_META = {
  pdf: { label: 'PDF', cls: 'ft-pdf' },
  doc: { label: 'DOC', cls: 'ft-word' }, docx: { label: 'DOC', cls: 'ft-word' }, hwp: { label: 'HWP', cls: 'ft-word' }, hwpx: { label: 'HWP', cls: 'ft-word' },
  ppt: { label: 'PPT', cls: 'ft-ppt' }, pptx: { label: 'PPT', cls: 'ft-ppt' }, key: { label: 'KEY', cls: 'ft-ppt' },
  xls: { label: 'XLS', cls: 'ft-xls' }, xlsx: { label: 'XLS', cls: 'ft-xls' }, csv: { label: 'CSV', cls: 'ft-xls' },
  zip: { label: 'ZIP', cls: 'ft-zip' }, tar: { label: 'TAR', cls: 'ft-zip' }, gz: { label: 'GZ', cls: 'ft-zip' }, rar: { label: 'RAR', cls: 'ft-zip' }, '7z': { label: '7Z', cls: 'ft-zip' },
  mp3: { label: 'MP3', cls: 'ft-av' }, wav: { label: 'WAV', cls: 'ft-av' }, m4a: { label: 'M4A', cls: 'ft-av' }, flac: { label: 'FLAC', cls: 'ft-av' },
  mp4: { label: 'MP4', cls: 'ft-av' }, mov: { label: 'MOV', cls: 'ft-av' }, webm: { label: 'WEBM', cls: 'ft-av' }, mkv: { label: 'MKV', cls: 'ft-av' },
  md: { label: 'MD', cls: 'ft-txt' }, txt: { label: 'TXT', cls: 'ft-txt' }, rtf: { label: 'RTF', cls: 'ft-txt' },
};
// 타입별 색 문서 아이콘 — 흰 페이지 + 접힌 모서리 + 색 띠 + 라벨(PDF/DOC/PPT/XLS …).
function docIcon(ext) {
  const meta = FILE_TYPE_META[ext] || { label: (String(ext || '').toUpperCase().slice(0, 4) || 'FILE'), cls: 'ft-generic' };
  const n = sv('svg', { class: 'ft ft-file ' + meta.cls, viewBox: '0 0 40 48', fill: 'none', 'aria-hidden': 'true' });
  n.append(sv('path', { class: 'ft-page', d: 'M6 2.5h17.5L34 13v30.5a2.5 2.5 0 0 1-2.5 2.5h-25A2.5 2.5 0 0 1 4 43.5V5A2.5 2.5 0 0 1 6 2.5z' }));
  n.append(sv('path', { class: 'ft-fold', d: 'M23.5 2.5V11a2 2 0 0 0 2 2H34z' }));
  n.append(sv('rect', { class: 'ft-band', x: 4, y: 29, width: 30, height: 12, rx: 2.5 }));
  const t = sv('text', { class: 'ft-label', x: 19, y: 37.8, 'text-anchor': 'middle' }); t.textContent = meta.label;
  n.append(t);
  return n;
}
// 이미지 — 실제 썸네일. 파일 API 가 Bearer 인증이라 <img src> 직접 불가 → blob fetch 후 objectURL. 보일 때 지연 로드.
function imageThumb(id, rel, base, name) {
  const wrap = el('div', { class: 'ft ft-img' });
  const img = el('img', { alt: name });
  wrap.append(img);
  (wrap as any)._loadThumb = async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    const url = (base || '/api/ui/projects/') + id + '/file?path=' + encodeURIComponent(rel);
    try {
      const res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
      if (!res.ok) { wrap.classList.add('ft-img-err'); return; }
      img.src = URL.createObjectURL(await res.blob());
      wrap.classList.add('loaded');
    } catch (_) { wrap.classList.add('ft-img-err'); }
  };
  thumbObserve(wrap);
  return wrap;
}
// 지연 로드 — 화면(+여유 200px)에 들어올 때 _loadThumb() 1회. IntersectionObserver 없으면 즉시.
let _thumbObserver: any = null;
function thumbObserve(wrap) {
  if (typeof IntersectionObserver === 'undefined') { if ((wrap as any)._loadThumb) (wrap as any)._loadThumb(); return; }
  if (!_thumbObserver) {
    _thumbObserver = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { _thumbObserver.unobserve(e.target); if ((e.target as any)._loadThumb) (e.target as any)._loadThumb(); }
    }, { rootMargin: '200px' });
  }
  _thumbObserver.observe(wrap);
}

// 텍스트로 열어 편집 가능한 확장자(화이트리스트). 그 외 바이너리(docx/xlsx/zip 등)는 textarea 로 열면 깨지므로 다운로드.
const TEXT_EXTS = ['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs',
  'py', 'sh', 'bash', 'zsh', 'rb', 'go', 'rs', 'c', 'cc', 'cpp', 'h', 'hpp', 'java', 'kt', 'swift', 'php',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'xml', 'svg', 'yml', 'yaml', 'toml', 'ini', 'conf', 'env',
  'sql', 'vue', 'svelte', 'r', 'lua', 'pl', 'dart', 'gradle', 'properties', 'gitignore', 'dockerfile'];

// 파일 뷰어 — 이미지=미리보기, PDF=내장 뷰어(iframe), 텍스트=편집·저장, 그 외 바이너리=다운로드 안내.
async function openFileViewer(id, rel, name, reload, base) {
  const B = base || '/api/ui/projects/';
  const token = localStorage.getItem(TOKEN_KEY);
  const url = B + id + '/file?path=' + encodeURIComponent(rel);
  const ext = fileExt(name);
  const isImg = IMG_EXTS.includes(ext);
  const isPdf = ext === 'pdf';
  const isText = TEXT_EXTS.includes(ext);
  const footer = (back, extra?) => el('div', { class: 'ov-actions' },
    ...(extra || []),
    el('button', { class: 'btn btn-ghost', text: '다운로드', onclick: () => authDownload(url + '&download=1', name) }),
    el('button', { class: 'btn btn-ghost', text: '닫기', onclick: () => back.remove() }));

  // 미리보기 미지원 바이너리 — 다운로드만(fetch 생략).
  if (!isImg && !isPdf && !isText) {
    const back = overlayBox(name, el('p', { class: 'admin-hint', text: '미리보기를 지원하지 않는 형식이에요. 다운로드해서 확인하세요.' }));
    back.querySelector('.ov-box').append(footer(back));
    return;
  }
  let res: any;
  try { res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); }
  catch (_) { toast('파일을 열지 못했습니다', true); return; }
  if (res.status === 413) {
    const back = overlayBox(name, el('p', { class: 'admin-hint', text: '미리보기엔 너무 큰 파일이에요. 다운로드해서 확인하세요.' }));
    back.querySelector('.ov-box').append(footer(back));
    return;
  }
  if (!res.ok) { toast('파일을 열지 못했습니다 (' + res.status + ')', true); return; }
  const blob = await res.blob();

  if (isImg) {
    const back = overlayBox(name, el('img', { class: 'proj-file-img', src: URL.createObjectURL(blob), alt: name }));
    back.querySelector('.ov-box').append(footer(back));
    return;
  }
  if (isPdf) {
    // blob 에 MIME 이 없으면 iframe 이 PDF 를 텍스트로 표시(원시 %PDF 바이트 노출) — application/pdf 로 강제 후 네이티브 뷰어 렌더.
    const pdfBlob = blob.type === 'application/pdf' ? blob : new Blob([await blob.arrayBuffer()], { type: 'application/pdf' });
    const back = overlayBox(name, el('iframe', { class: 'proj-file-pdf', src: URL.createObjectURL(pdfBlob) }));
    const box = back.querySelector('.ov-box'); box.classList.add('ov-box-wide'); box.append(footer(back));
    return;
  }
  // 텍스트 — 편집/저장
  const ta = el('textarea', { class: 'proj-file-edit' }); ta.value = await blob.text();
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const back = overlayBox(name, ta);
  back.querySelector('.ov-box').append(footer(back, [saveBtn]));
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try { await authUpload(url, new Blob([ta.value])); toast('저장했습니다'); back.remove(); if (reload) reload(); }
    catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  };
}

// 공유 폴더 아이콘 카드(맥 데스크탑 느낌) — 폴더는 onDir(rel), 파일은 뷰어 팝업. 섹션·전체보기 팝업 공용.
function projFileCardEl(id, it, rel, onDir, reload, base, select) {
  const isDir = it.type === 'dir';
  const c = el('div', { class: 'proj-file-card' + (select ? ' select-mode' : ''), title: it.name },
    el('div', { class: 'proj-file-card-ic' }, fileThumb(id, it, rel, base)),
    el('div', { class: 'proj-file-card-nm', text: it.name }),
    el('div', { class: 'proj-file-card-sz', text: isDir ? '폴더' : fmtSize(it.size) }));
  if (select) {
    // 선택 모드 — 카드 클릭 = 체크 토글(열기/진입 대신). 파일·폴더 모두 골라 일괄 삭제 가능.
    const ids = select.ids;
    const on0 = ids.has(rel);
    if (on0) c.classList.add('selected');
    const cb = el('span', { class: 'proj-file-check', 'aria-hidden': 'true', text: on0 ? '✓' : '' });
    c.append(cb);
    c.setAttribute('role', 'checkbox'); c.setAttribute('tabindex', '0'); c.setAttribute('aria-checked', on0 ? 'true' : 'false');
    const toggle = () => { const v = !ids.has(rel); if (v) ids.add(rel); else ids.delete(rel); c.classList.toggle('selected', v); cb.textContent = v ? '✓' : ''; c.setAttribute('aria-checked', v ? 'true' : 'false'); select.onToggle(); };
    c.onclick = toggle;
    c.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
  } else {
    c.onclick = isDir ? () => onDir(rel) : () => openFileViewer(id, rel, it.name, reload, base);
  }
  return c;
}
function projUpCardEl(onClick) {
  return el('div', { class: 'proj-file-card', onclick: onClick },
    el('div', { class: 'proj-file-card-ic', text: '↩' }), el('div', { class: 'proj-file-card-nm', text: '상위 폴더' }));
}

// 전체 보기 목록의 한 행 — [아이콘][이름][크기][호버 시 액션 아이콘]. 폴더는 진입, 파일은 뷰어.
function projFileRowEl(id, it, rel, onDir, reload, base) {
  const B = base || '/api/ui/projects/';
  const isDir = it.type === 'dir';
  const acts = el('div', { class: 'proj-file-lacts' },
    fileIconBtn('✎', '이름변경', (ev) => { ev.stopPropagation(); renameEntry(id, rel, it.name, isDir, reload, B); }),
    isDir ? null : fileIconBtn('↓', '다운로드', (ev) => { ev.stopPropagation(); authDownload(B + id + '/file?download=1&path=' + encodeURIComponent(rel), it.name); }),
    fileIconBtn('✕', '삭제', (ev) => { ev.stopPropagation(); deleteEntry(id, rel, it.name, isDir, reload, B); }, true));
  const row = el('div', { class: 'proj-file-lrow' },
    el('span', { class: 'proj-file-lic' }, fileThumb(id, it, rel, B)),
    el('span', { class: 'proj-file-lnm' + (isDir ? ' is-dir' : ''), text: it.name, title: it.name }),
    el('span', { class: 'proj-file-lsz', text: isDir ? '' : fmtSize(it.size) }),
    acts);
  row.onclick = isDir ? () => onDir(rel) : () => openFileViewer(id, rel, it.name, reload, B);
  return row;
}
function fileIconBtn(glyph, title, onclick, danger?) {
  return el('button', { class: 'proj-file-iconbtn' + (danger ? ' danger' : ''), title, type: 'button', text: glyph, onclick });
}
// 파일/폴더 이름 변경(같은 폴더 안).
function renameEntry(id, rel, name, isDir, reload, base) {
  const B = base || '/api/ui/projects/';
  const nameIn = el('input', { type: 'text', value: name, maxlength: '120' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const back = overlayBox('이름 변경',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '새 이름' }), nameIn),
    el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
  setTimeout(() => {
    nameIn.focus();
    // 파일은 확장자(.png 등)를 뺀 본문만 선택 — 타이핑 시 확장자가 통째로 지워지는 것 방지(Finder/VS Code 동작).
    const dot = name.lastIndexOf('.');
    if (!isDir && dot > 0) nameIn.setSelectionRange(0, dot);
    else nameIn.select();
  }, 0);
  const go = async () => {
    const nm = nameIn.value.trim();
    if (!nm || nm === name) { back.remove(); return; }
    saveBtn.disabled = true;
    try { await api(B + id + '/rename', { method: 'POST', body: JSON.stringify({ path: rel, name: nm }) }); back.remove(); toast('이름을 변경했습니다'); reload(); }
    catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}
// 파일/폴더 삭제(폴더는 내용까지). 확인 후.
async function deleteEntry(id, rel, name, isDir, reload, base) {
  const B = base || '/api/ui/projects/';
  if (!confirm((isDir ? '폴더' : '파일') + ' ‘' + name + '’을(를) 삭제할까요?' + (isDir ? '\n\n폴더 안 내용도 함께 삭제됩니다(되돌릴 수 없음).' : '\n\n되돌릴 수 없습니다.'))) return;
  try { await api(B + id + '/file?path=' + encodeURIComponent(rel), { method: 'DELETE' }); toast('삭제했습니다'); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}

// 공유 폴더 '전체 보기' — 넓은 팝업에 일반 파일 목록(행 단위)으로 전부 표시. 폴더 탐색·파일 열기 가능.
function openFolderGrid(id, startPath, base) {
  const B = base || '/api/ui/projects/';
  const st = { path: startPath || '', q: '' };
  const searchIn = el('input', { type: 'search', class: 'proj-file-search', placeholder: '파일 검색…' });
  searchIn.addEventListener('input', debounce(() => { st.q = searchIn.value.trim(); load(); }, 300));
  const fileInput = el('input', { type: 'file', multiple: '', style: 'display:none' });
  fileInput.addEventListener('change', async () => { await uploadHere(fileInput.files); fileInput.value = ''; });
  const mkdirBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 폴더', onclick: () => mkdirHere() });
  const uploadBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 업로드', onclick: () => fileInput.click() });
  const crumb = el('div', { class: 'proj-file-crumb' });
  const listBox = el('div', { class: 'proj-file-llist' });
  const back = overlayBox('공유 폴더 — 전체 보기',
    el('div', { class: 'proj-fg-head' }, searchIn, el('div', { class: 'proj-fg-actions' }, mkdirBtn, uploadBtn, fileInput)),
    crumb, listBox);
  const box = back.querySelector('.ov-box'); if (box) box.classList.add('ov-box-wide');
  const join = (a, b) => (a ? a + '/' + b : b);
  load();

  async function uploadHere(files) {
    const arr: any[] = Array.from(files || []); if (!arr.length) return;
    if (arr.length > 1) toast(arr.length + '개 업로드 중…');
    let ok = 0;
    for (const f of arr) {
      try { await authUpload(B + id + '/file?path=' + encodeURIComponent((st.path ? st.path + '/' : '') + f.name), f); ok += 1; }
      catch (e) { toast(f.name + ' 실패 — ' + e.message, true); }
    }
    if (ok) toast(ok + '개 업로드 완료'); st.q = ''; searchIn.value = ''; load();
  }
  function mkdirHere() {
    const nameIn = el('input', { type: 'text', placeholder: '폴더 이름', maxlength: '80' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '만들기' });
    const b2 = overlayBox('새 폴더',
      el('p', { class: 'admin-hint', text: (st.path ? '“' + st.path + '” 안에' : '루트에') + ' 새 폴더를 만듭니다.' }),
      el('div', { class: 'field' }, el('label', { class: 'field-label', text: '폴더 이름' }), nameIn),
      el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => b2.remove() })));
    setTimeout(() => nameIn.focus(), 0);
    const go = async () => {
      const nm = nameIn.value.trim(); if (!nm) { nameIn.focus(); return; }
      saveBtn.disabled = true;
      try { await api(B + id + '/folder?path=' + encodeURIComponent((st.path ? st.path + '/' : '') + nm), { method: 'POST' }); b2.remove(); toast('폴더를 만들었습니다'); load(); }
      catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
    };
    saveBtn.onclick = go; nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }
  async function load() {
    listBox.replaceChildren(skeletonRows(5));
    const qs = st.q ? ('?q=' + encodeURIComponent(st.q)) : ('?path=' + encodeURIComponent(st.path));
    let data: any;
    try { data = await api(B + id + '/files' + qs); }
    catch (e) { listBox.replaceChildren(errorNote(e, '폴더를 불러오지 못했습니다')); return; }
    if (data.search !== undefined) {
      crumb.replaceChildren(el('span', { text: '“' + data.search + '” 검색 — ' + data.items.length + '건' }));
      const rows = (data.items || []).map((it) => projFileRowEl(id, it, it.path, (t) => { st.q = ''; searchIn.value = ''; st.path = t; load(); }, load, B));
      listBox.replaceChildren(...(rows.length ? rows : [el('div', { class: 'empty', text: '일치하는 파일이 없어요.' })]));
      return;
    }
    crumb.replaceChildren(
      el('span', { class: 'proj-crumb-link', text: '⌂ 루트', onclick: () => { st.path = ''; load(); } }),
      data.path ? el('span', { text: ' / ' + data.path }) : null);
    const rows: any[] = [];
    if (data.path) rows.push(el('div', { class: 'proj-file-lrow', onclick: () => { st.path = data.parent || ''; load(); } },
      el('span', { class: 'proj-file-lic', text: '↩' }), el('span', { class: 'proj-file-lnm', text: '상위 폴더' }),
      el('span', { class: 'proj-file-lsz' }), el('span', { class: 'proj-file-lacts' })));
    for (const it of (data.items || [])) rows.push(projFileRowEl(id, it, join(st.path, it.name), (t) => { st.path = t; load(); }, load, B));
    listBox.replaceChildren(...(rows.length ? rows : [el('div', { class: 'empty', text: '빈 폴더입니다.' })]));
  }
}
function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
// 타임라인용 날짜시간 — '몇 시간 전' 대신 절대 날짜·시각(연도는 올해가 아니면만 표기).
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const yr = d.getFullYear() !== new Date().getFullYear() ? (d.getFullYear() + '. ') : '';
  return yr + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ── 상세 ① 공유 폴더 — 프로젝트 폴더 탐색 + 업로드/다운로드 + 검색. ──
function projectFolderSection(id, base) {
  const B = base || '/api/ui/projects/';
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
  const body = el('div', {});
  const st = { path: '', q: '' };
  let lastData: any = null;   // 마지막 서버 응답(업로드 중 그리드 즉시 재구성용)
  const uploading: any[] = [];  // 업로드 중 파일 [{ name, pct, pctEl, fill }]
  const searchIn = el('input', { type: 'search', placeholder: '파일 검색…', class: 'proj-file-search' });
  searchIn.addEventListener('input', debounce(() => { st.q = searchIn.value.trim(); load(); }, 300));
  const fileInput = el('input', { type: 'file', multiple: '', style: 'display:none' });
  fileInput.addEventListener('change', () => { uploadFiles(fileInput.files); fileInput.value = ''; });
  const uploadBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 업로드', onclick: () => fileInput.click() });
  const allBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '전체 보기', onclick: () => openFolderGrid(id, st.path, B) });
  const mkdirBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 폴더', onclick: () => openMkdir() });
  // 선택(일괄삭제) 모드 — 카드 뷰에서 여러 항목을 골라 한 번에 삭제. ids = 선택된 rel(상대경로) 집합.
  const sel = { mode: false, ids: new Set() };
  let lastPairs: any[] = [];
  const selectBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '선택', title: '여러 항목을 골라 한 번에 삭제', onclick: () => toggleSelMode() });
  const selBar = el('div', { class: 'bulk-bar', hidden: true });
  card.append(el('div', { class: 'card-head' }, el('h3', { text: '공유 폴더' }),
    el('div', { class: 'card-head-actions' }, searchIn, allBtn, mkdirBtn, uploadBtn, selectBtn, fileInput)));
  card.append(selBar);
  card.append(body);
  // 드래그앤드롭 업로드 — 카드 위로 파일을 끌어다 놓으면 현재 폴더에 올림(여러 개 동시 가능).
  let dragDepth = 0;
  const hasFiles = (ev) => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
  card.addEventListener('dragenter', (ev) => { if (hasFiles(ev)) { ev.preventDefault(); dragDepth++; card.classList.add('drop-active'); } });
  card.addEventListener('dragover', (ev) => { if (hasFiles(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; } });
  card.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) card.classList.remove('drop-active'); });
  card.addEventListener('drop', (ev) => { ev.preventDefault(); dragDepth = 0; card.classList.remove('drop-active'); if (ev.dataTransfer.files && ev.dataTransfer.files.length) uploadFiles(ev.dataTransfer.files); });
  // 클립보드 이미지 붙여넣기 — 프로젝트 상세에서 (텍스트 입력칸이 아닌 곳에) 붙여넣으면 현재 공유 폴더로 업로드.
  //  card 가 DOM 에서 사라지면(다른 화면 이동) 다음 paste 때 스스로 해제(언마운트 훅이 없어 누수 방지용 self-clean).
  const onPaste = (ev) => {
    if (!document.body.contains(card)) { document.removeEventListener('paste', onPaste); return; }
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return; // 텍스트 편집 중 붙여넣기는 방해 않음
    const items = (ev.clipboardData && ev.clipboardData.items) || [];
    const imgs: any[] = [];
    for (const it of items) { if (it.kind === 'file' && String(it.type || '').startsWith('image/')) { const b = it.getAsFile(); if (b) imgs.push(b); } }
    if (!imgs.length) return; // 이미지가 없으면 평소 붙여넣기 동작 유지
    ev.preventDefault();
    const dest = '공유 폴더' + (st.path ? ' / ' + st.path : '');
    openPasteDialog(imgs, dest, (files) => uploadFiles(files));
  };
  document.addEventListener('paste', onPaste);
  load();
  return card;

  // 선택 모드 토글 — 켜면 카드가 체크박스로, 끄면 선택 해제 + 헤드 버튼 라벨 전환.
  function toggleSelMode(on?) {
    sel.mode = on != null ? on : !sel.mode;
    if (!sel.mode) sel.ids.clear();
    selectBtn.classList.toggle('active', sel.mode);
    selectBtn.textContent = sel.mode ? '선택 취소' : '선택';
    paintSelBar();
    if (lastData) render(lastData);
  }
  function paintSelBar() {
    if (!sel.mode) { selBar.hidden = true; selBar.replaceChildren(); return; }
    const n = sel.ids.size, total = lastPairs.length;
    const allOn = total > 0 && n >= total;
    const allBtn2 = el('button', { class: 'btn btn-ghost btn-sm', text: allOn ? '전체 해제' : '전체 선택',
      onclick: () => { if (allOn) sel.ids.clear(); else lastPairs.forEach((p) => sel.ids.add(p.rel)); paintSelBar(); if (lastData) render(lastData); } });
    const delB = el('button', { class: 'btn btn-sm btn-danger', text: '선택 삭제', disabled: n === 0, onclick: () => bulkDeleteSel() });
    selBar.hidden = false;
    selBar.replaceChildren(
      el('span', { class: 'bulk-bar-count', text: n ? n + '개 선택됨' : '삭제할 항목을 고르세요' }),
      el('div', { class: 'bulk-bar-actions' }, allBtn2, delB));
  }
  async function bulkDeleteSel() {
    const rels: any[] = [...sel.ids];
    if (!rels.length) return;
    if (!confirm(rels.length + '개 항목을 삭제할까요?\n\n폴더는 안의 내용까지 함께 삭제됩니다(되돌릴 수 없음).')) return;
    // 병렬 삭제 — 일부 실패해도 나머지 진행(성공/실패 집계).
    const results = await Promise.allSettled(rels.map((rel) =>
      api(B + id + '/file?path=' + encodeURIComponent(rel), { method: 'DELETE' })));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.length - ok;
    toast(fail ? (ok + '개 삭제 · ' + fail + '개 실패') : (ok + '개 삭제했습니다'), fail > 0);
    toggleSelMode(false);
    load();
  }

  // 여러 파일 업로드 — 그리드에 '업로드 중 카드'(비활성 아이콘 + 실시간 %) 띄우고 순차 전송.
  async function uploadFiles(files) {
    const arr: any[] = Array.from(files || []);
    if (!arr.length) return;
    const items = arr.map((f) => ({ name: f.name, pct: 0 }));
    uploading.push(...items);
    if (lastData) render(lastData); // 업로드 카드 즉시 표시(load 기다리지 않음)
    let ok = 0, fail = 0;
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i], u = items[i];
      const target = (st.path ? st.path + '/' : '') + f.name;
      try {
        await authUploadProgress(B + id + '/file?path=' + encodeURIComponent(target), f,
          (pct) => { u.pct = pct; updateUpCard(u); });
        u.pct = 100; updateUpCard(u); ok += 1;
      } catch (e) { fail += 1; toast(f.name + ' 실패 — ' + e.message, true); }
    }
    uploading.length = 0;
    if (ok) toast(ok + '개 업로드 완료' + (fail ? (' · ' + fail + '개 실패') : ''));
    st.q = ''; searchIn.value = '';
    load();
  }
  function uploadingCard(u) {
    const pctEl = el('div', { class: 'proj-up-pct', text: Math.round(u.pct) + '%' });
    const fill = el('div', { class: 'proj-up-bar-fill', style: 'width:' + u.pct + '%' });
    u.pctEl = pctEl; u.fill = fill;
    return el('div', { class: 'proj-file-card uploading', title: u.name },
      el('div', { class: 'proj-up-icwrap' },
        el('div', { class: 'proj-file-card-ic', text: iconFor(u.name) }),
        el('div', { class: 'proj-up-overlay' }, pctEl)),
      el('div', { class: 'proj-file-card-nm', text: u.name }),
      el('div', { class: 'proj-up-bar' }, fill));
  }
  function updateUpCard(u) {
    if (u.pctEl) u.pctEl.textContent = Math.round(u.pct) + '%';
    if (u.fill) u.fill.style.width = u.pct + '%';
  }
  // 현재 폴더 안에 하위 폴더 생성.
  function openMkdir() {
    const nameIn = el('input', { type: 'text', placeholder: '폴더 이름', maxlength: '80' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '만들기' });
    const back = overlayBox('새 폴더',
      el('p', { class: 'admin-hint', text: (st.path ? '“' + st.path + '” 안에' : '루트에') + ' 새 폴더를 만듭니다.' }),
      el('div', { class: 'field' }, el('label', { class: 'field-label', text: '폴더 이름' }), nameIn),
      el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
    setTimeout(() => nameIn.focus(), 0);
    const go = async () => {
      const nm = nameIn.value.trim();
      if (!nm) { nameIn.focus(); toast('폴더 이름을 입력하세요', true); return; }
      const target = (st.path ? st.path + '/' : '') + nm;
      saveBtn.disabled = true;
      try { await api(B + id + '/folder?path=' + encodeURIComponent(target), { method: 'POST' }); back.remove(); toast('폴더를 만들었습니다'); st.q = ''; searchIn.value = ''; load(); }
      catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
    };
    saveBtn.onclick = go;
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }

  async function load() {
    body.replaceChildren(skeletonRows(3));
    try {
      const qs = st.q ? ('?q=' + encodeURIComponent(st.q)) : ('?path=' + encodeURIComponent(st.path));
      render(await api(B + id + '/files' + qs));
    } catch (e) { body.replaceChildren(errorNote(e, '폴더를 불러오지 못했습니다')); }
  }
  function render(data) {
    lastData = data;
    const frag: any[] = [];
    let pairs: any; // { it, rel }
    if (data.search !== undefined) {
      frag.push(el('div', { class: 'proj-file-crumb', text: '“' + data.search + '” 검색 — ' + data.items.length + '건' }));
      pairs = data.items.map((it) => ({ it, rel: it.path }));
      if (!data.items.length) frag.push(el('div', { class: 'empty', text: '일치하는 파일이 없습니다.' }));
    } else {
      const crumb = el('div', { class: 'proj-file-crumb' },
        el('span', { class: 'proj-crumb-link', text: '⌂ 루트', onclick: () => { st.path = ''; load(); } }));
      if (data.path) crumb.append(el('span', { text: ' / ' + data.path }));
      frag.push(crumb);
      pairs = data.items.map((it) => ({ it, rel: join(st.path, it.name) }));
      if (!data.items.length && !data.path) frag.push(el('div', { class: 'empty', text: '빈 폴더입니다. ‘＋ 업로드’로 파일을 올려 보세요.' }));
    }
    const cards: any[] = [];
    for (const u of uploading) cards.push(uploadingCard(u)); // 업로드 중 카드 먼저(비활성 + 실시간 %)
    lastPairs = pairs;
    const enterDir = (t) => { sel.ids.clear(); st.q = ''; searchIn.value = ''; st.path = t; load(); };
    if (data.search === undefined && data.path) cards.push(projUpCardEl(() => enterDir(data.parent || '')));
    const selCtl = sel.mode ? { ids: sel.ids, onToggle: paintSelBar } : null;
    for (const { it, rel } of pairs) cards.push(projFileCardEl(id, it, rel, enterDir, load, B, selCtl));
    if (cards.length) frag.push(el('div', { class: 'proj-file-grid' }, ...cards));
    body.replaceChildren(...frag);
    if (sel.mode) paintSelBar();
  }
  function join(a, b) { return a ? a + '/' + b : b; }
}

// 이니셜 아바타 — 이름 첫 글자(한글 1자 / 영문 1~2자). 이름 기반 파스텔 배경.
function initials(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  if (/[가-힣]/.test(s[0])) return s.slice(0, 1);
  const parts = s.split(/\s+/);
  if (parts.length >= 2 && parts[1][0]) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}
function avatarColor(seed) {
  const s = String(seed || ''); let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return 'hsl(' + h + ', 50%, 60%)';
}

// ── 상세 ② 터미널 세션 — 팀원 프로필(아바타) 그리드 → 클릭 시 그 사람 세션 펼침(페이지 내). 본인은 상태메시지 공유. ──
function projectTerminalSection(id, members, meId, base) {
  const B = base || '/api/ui/projects/';
  const card = el('div', { class: 'card proj-term-card', style: 'margin-bottom:18px' });
  const body = el('div', {});
  const newBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 세션', onclick: () => openProjectSessionForm(id, load, B) });
  card.append(el('div', { class: 'card-head' }, el('h3', { text: '터미널 세션' }), el('div', { class: 'card-head-actions' }, newBtn)));
  card.append(body);
  let sessions: any[] = [];
  let selected: any = null;
  let dragId: any = null;
  const ppl = () => (members && members.length ? members : []);
  const ownerName = (oid) => { const m = ppl().find((x) => x.member_id === oid); return (m && m.display_name) || oid; };
  load();
  return card;

  async function load() {
    body.replaceChildren(skeletonRows(2));
    try { sessions = await api(B + id + '/sessions').then((d) => (d && d.sessions) || []); }
    catch (e) { body.replaceChildren(errorNote(e, '세션을 불러오지 못했습니다')); return; }
    render();
  }
  function render() {
    if (!ppl().length) { body.replaceChildren(el('div', { class: 'empty', text: '팀원이 없습니다. 위 ‘팀원 수정’으로 추가하면 여기에 프로필이 생깁니다.' })); return; }
    const grid = el('div', { class: 'proj-people-grid' }, ...ppl().map(personCircle));
    const panel = el('div', { class: 'proj-people-panel' });
    if (selected) renderPanel(panel);
    body.replaceChildren(grid, panel);
  }
  function personCircle(m) {
    const isMe = m.member_id === meId;
    const cnt = sessions.filter((s) => s.owner === m.member_id).length;
    const avatar = el('div', { class: 'proj-avatar', style: 'background:' + avatarColor(m.member_id) },
      el('span', { text: initials(m.display_name || m.member_id) }));
    if (cnt) avatar.append(el('span', { class: 'proj-avatar-badge', text: String(cnt) }));
    const hasStatus = !!m.status_message;
    const status = el('div', { class: 'proj-person-status' + (isMe ? ' me' : '') + (hasStatus ? ' filled' : ' empty'),
      text: hasStatus ? m.status_message : (isMe ? '✎ 상태 남기기' : '') });
    if (isMe && hasStatus) status.append(el('span', { class: 'proj-status-pen', text: ' ✎' }));
    if (isMe) { status.title = '클릭해서 상태 메시지 수정'; status.onclick = (ev) => { ev.stopPropagation(); editStatus(m); }; }
    const wrap = el('div', { class: 'proj-person' + (selected === m.member_id ? ' active' : '') },
      avatar, el('div', { class: 'proj-person-name', text: m.display_name || m.member_id }), status);
    wrap.onclick = () => { selected = (selected === m.member_id ? null : m.member_id); render(); };
    // 드래그앤드롭으로 진열 순서 조절(짧게 누르면 선택, 끌면 재배치).
    wrap.draggable = true;
    wrap.addEventListener('dragstart', (ev) => { dragId = m.member_id; wrap.classList.add('dragging'); ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', m.member_id); } catch (_) { /* */ } });
    wrap.addEventListener('dragend', () => { dragId = null; wrap.classList.remove('dragging'); });
    wrap.addEventListener('dragover', (ev) => { if (dragId && dragId !== m.member_id) { ev.preventDefault(); wrap.classList.add('drop-target'); } });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-target'));
    wrap.addEventListener('drop', (ev) => { ev.preventDefault(); wrap.classList.remove('drop-target'); if (dragId && dragId !== m.member_id) reorder(dragId, m.member_id); });
    return wrap;
  }
  function reorder(fromId, toId) {
    const list = ppl();
    const fromIdx = list.findIndex((x) => x.member_id === fromId);
    const toIdx = list.findIndex((x) => x.member_id === toId);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    render();
    api(B + id + '/members', { method: 'POST', body: JSON.stringify({ members: list.map((x) => x.member_id) }) })
      .then(() => toast('순서를 저장했습니다'))
      .catch((e) => toast('순서 저장 실패 — ' + e.message, true));
  }
  function renderPanel(panel) {
    const m = ppl().find((x) => x.member_id === selected);
    const mine = sessions.filter((s) => s.owner === selected);
    const head = el('div', { class: 'proj-panel-head' },
      el('b', { text: (m && m.display_name) || selected }), ' 의 세션 ',
      el('span', { class: 'proj-panel-cnt', text: String(mine.length) }));
    // ＋ 새 세션 버튼은 카드 헤더 우상단에 항상 있으므로 패널에선 중복 제거(같은 동작).
    panel.append(head);
    if (!mine.length) { panel.append(el('div', { class: 'empty', text: selected === meId ? '아직 만든 세션이 없어요. ‘＋ 새 세션’으로 시작하세요.' : '아직 만든 세션이 없습니다.' })); return; }
    panel.append(el('div', { class: 'proj-sess-list' }, ...mine.map(sessRow)));
  }
  function sessRow(s) {
    const acts: any[] = [];
    if (s.owned) acts.push(
      el('button', { class: 'btn btn-ghost btn-sm', text: '이름변경', onclick: () => openSessionRename(s, load) }),
      el('button', { class: 'btn btn-ghost btn-sm', text: '삭제', onclick: () => removeSession(s, load) }));
    acts.push(el('button', { class: 'btn btn-primary btn-sm', text: '입장', onclick: () => window.open('/ui/terminal.html?session=' + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || ''), '_blank') }));
    return el('div', { class: 'proj-sess-row' },
      el('div', { class: 'proj-sess-main' },
        el('div', { class: 'proj-sess-name' }, (s.label || s.id),
          s.attached ? el('span', { class: 'proj-sess-live', text: '● 사용 중' }) : null),
        el('div', { class: 'proj-sess-meta', text: (s.harness || 'shell') + ' · 만든이 ' + ownerName(s.owner) })),
      el('div', { class: 'proj-sess-acts' }, ...acts));
  }
  function editStatus(m) {
    const input = el('input', { type: 'text', value: m.status_message || '', placeholder: '현재 상태 (예: 결제 모듈 작업 중)', maxlength: '200' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    const back = overlayBox('내 상태 메시지',
      el('p', { class: 'admin-hint', text: '프로필 밑에 보이는 ‘현재 상태’예요 — 팀원에게 지금 무엇을 하는지 공유됩니다.' }),
      el('div', { class: 'field' }, input),
      el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
    setTimeout(() => input.focus(), 0);
    const go = async () => {
      saveBtn.disabled = true;
      try {
        const r = await api('/api/ui/me/status', { method: 'POST', body: JSON.stringify({ message: input.value.trim() }) });
        m.status_message = r.status_message;
        back.remove(); toast('상태를 저장했습니다'); render();
      } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
    };
    saveBtn.onclick = go;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  }
}

// 새 프로젝트 세션 오버레이 — 터미널 탭과 같은 정보(실행기·모델 등 플래그·자동승인). 폴더는 프로젝트 폴더 고정,
//  공개범위는 '팀원 공동'(별도 입력 없음). 생성 후 새 탭 입장.
async function openProjectSessionForm(id, reload, base) {
  const B = base || '/api/ui/projects/';
  let cfg: any;
  try { cfg = await api('/api/ui/terminal/config'); }
  catch (e) { toast('세션 설정을 불러오지 못했습니다 — ' + e.message, true); return; }
  const harnesses = cfg.harnesses || [];
  const nameIn = el('input', { type: 'text', placeholder: '세션 이름 (예: 개발, 빌드)', maxlength: '80' });
  const harnessSel = el('select', {}, ...harnesses.map((h) => el('option', { value: h.key, text: h.label })));
  const flagsBox = el('div', {});
  const autoCb = el('input', { type: 'checkbox' });
  const autoRow = el('label', { class: 'proj-sess-auto' }, autoCb, el('span', { text: ' 자동 승인 — 매번 권한 확인 없이 실행' }));
  function renderFlags() {
    const h = harnesses.find((x) => x.key === harnessSel.value) || {};
    flagsBox.replaceChildren();
    for (const f of (h.flags || [])) {
      let ctrl: any;
      if (f.type === 'select') ctrl = el('select', { 'data-flag': f.name }, ...(f.choices || []).map((c) => el('option', { value: c, text: c || '(기본)' })));
      else if (f.type === 'bool') ctrl = el('input', { type: 'checkbox', 'data-flag': f.name });
      else ctrl = el('input', { type: 'text', 'data-flag': f.name });
      flagsBox.append(el('div', { class: 'field', style: 'margin-top:12px' },
        el('label', { class: 'field-label', text: f.label }), ctrl, f.desc ? el('div', { class: 'caption', text: f.desc }) : null));
    }
    autoRow.style.display = h.hasAutoApprove ? '' : 'none';
  }
  harnessSel.addEventListener('change', renderFlags);
  renderFlags();
  const saveBtn = el('button', { class: 'btn btn-primary', text: '만들고 입장' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox('새 터미널 세션',
    el('p', { class: 'admin-hint', text: '이 프로젝트 폴더에서 시작하는 공동 세션입니다 — 프로젝트 팀원만 보고 입장할 수 있어요.' }),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '실행' }), harnessSel),
    flagsBox,
    el('div', { style: 'margin-top:10px' }, autoRow),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => nameIn.focus(), 0);
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    const flags = {};
    for (const ctrl of flagsBox.querySelectorAll('[data-flag]')) {
      const k = ctrl.getAttribute('data-flag');
      const v = ctrl.type === 'checkbox' ? (ctrl.checked ? 'true' : '') : ctrl.value;
      if (v) flags[k] = v;
    }
    try {
      const r = await api(B + id + '/sessions', { method: 'POST', body: JSON.stringify({
        label: nameIn.value.trim(), harness: harnessSel.value, flags, autoApprove: autoCb.checked,
      }) });
      back.remove();
      toast('세션을 만들었습니다');
      if (r && r.session && r.session.id) window.open('/ui/terminal.html?session=' + encodeURIComponent(r.session.id) + '&label=' + encodeURIComponent(r.session.label || ''), '_blank');
      reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
}

// 세션 이름 변경 오버레이 — 기존 터미널 세션 API 재사용(소유자만, 서버가 강제).
function openSessionRename(s, reload) {
  const nameIn = el('input', { type: 'text', value: s.label || '', placeholder: '세션 이름', maxlength: '80' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox('세션 이름 변경',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  setTimeout(() => nameIn.focus(), 0);
  const go = async () => {
    const label = nameIn.value.trim();
    if (!label) { nameIn.focus(); toast('이름을 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'POST', body: JSON.stringify({ label }) });
      back.remove(); toast('이름을 변경했습니다'); reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}
// 세션 삭제 — 확인 후 tmux 세션 종료(소유자만). 실행 중 작업도 종료됨.
async function removeSession(s, reload) {
  if (!confirm('세션 ‘' + (s.label || s.id) + '’을(를) 삭제할까요?\n\n실행 중인 작업이 함께 종료됩니다(되돌릴 수 없음).')) return;
  try {
    await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'DELETE' });
    toast('세션을 삭제했습니다'); reload();
  } catch (e) { toast('실패 — ' + e.message, true); }
}

// ── 상세 ③ 작업 타임라인 — 팀원 activity + 사람별 필터(전체/팀원 칩). ──
function projectTimelineSection(id, members, base) {
  const B = base || '/api/ui/projects/';
  const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
  const body = el('div', {});
  const st = { person: '' };
  const nameOf = (pid) => { const m = (members || []).find((x) => x.member_id === pid); return (m && m.display_name) || pid || '—'; };
  const chipsBar = el('div', { class: 'proj-tl-filter' });
  function paintChips() {
    const mk = (label, person) => el('button',
      { class: 'proj-tl-chip' + (st.person === person ? ' active' : ''), text: label,
        onclick: () => { st.person = person; paintChips(); load(); } });
    chipsBar.replaceChildren(mk('전체', ''), ...(members || []).map((m) => mk(m.display_name || m.member_id, m.member_id)));
  }
  paintChips();
  card.append(
    el('div', { class: 'card-head' }, el('h3', { text: '작업 타임라인' })),
    el('p', { class: 'proj-tl-note' },
      el('span', { class: 'proj-tl-note-ic', text: 'ⓘ' }),
      el('span', {}, '여기엔 ', el('b', { text: 'AI와 함께 남긴 작업' }),
        '이 자동으로 모여요 (AI 밖에서 진행한 모든 작업은 빠질 수 있어요). ',
        el('b', { text: '확실하게 진행이 된 일을 위주로' }),
        ' 회사 업무 진행의 큰 맥락을 확인하는 용도로 사용해주세요.')),
    chipsBar, body);
  load();
  return card;

  async function load() {
    body.replaceChildren(skeletonRows(3));
    try {
      const qs = st.person ? ('?author_person=' + encodeURIComponent(st.person)) : '';
      const acts = await api(B + id + '/activity' + qs).then((d) => (d && d.activities) || []);
      if (!acts.length) { body.replaceChildren(el('div', { class: 'empty', text: st.person ? '이 팀원의 작업 기록이 없습니다.' : '아직 이 프로젝트 팀원의 작업 기록이 없습니다.' })); return; }
      renderActs(acts);
    } catch (e) { body.replaceChildren(errorNote(e, '타임라인을 불러오지 못했습니다')); }
  }
  // 5개까지 보이고 나머지는 '더 보기'로 펼침(끝없이 길어지지 않게).
  function renderActs(acts) {
    const LIMIT = 5;
    const list = el('div', { class: 'proj-tl-list' });
    for (const a of acts.slice(0, LIMIT)) list.append(actRow(a));
    body.replaceChildren(list);
    if (acts.length > LIMIT) {
      const rest = acts.slice(LIMIT);
      const moreBtn = el('button', { class: 'btn btn-ghost btn-sm proj-tl-more', text: '＋ ' + rest.length + '개 더 보기' });
      moreBtn.onclick = () => { for (const a of rest) list.append(actRow(a)); moreBtn.remove(); };
      body.append(moreBtn);
    }
  }
  function actRow(a) { return activityTimelineRow(a, nameOf); }
}

// 팀원 수정 오버레이 — 현재 팀원 미리 체크된 멀티선택 → 통째 교체 저장.
function openMembersEdit(projectId, current, reload, base) {
  const B = base || '/api/ui/projects/';
  const picker = memberPicker(current || []);
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
  const back = overlayBox('팀원 수정',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '함께하는 팀원' }), picker.box),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      await api(B + projectId + '/members', { method: 'POST', body: JSON.stringify({ members: picker.getSelected() }) });
      back.remove();
      toast('팀원을 저장했습니다');
      reload();
    } catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
}

// ── 태스크 행 제목 클릭 → 상세 모달 배선(몽키패치) ──
//  동시 리팩터되는 pjvTaskRow 를 인플레이스 편집하지 않고 감싼다(append-only, 그쪽 작업 무손상).
//  pjvTaskRow(projectId, t, members, reload, depth, fields[, …]) 의 인자 위치만 의존(t=1, reload=3) — 가변인자 보존.
(function () {
  if (typeof pjvTaskRow !== 'function' || (pjvTaskRow as any).__tmWrapped) return;
  const _origPjvTaskRow = pjvTaskRow;
  // @ts-ignore 의도적 몽키패치 — function 선언을 런타임에서 재할당(JS 합법·동작 보존). TS 만 막아서 무시.
  pjvTaskRow = function (this: any, ...args: any[]) {
    const node = _origPjvTaskRow.apply(this, args as any);
    try {
      const t = args[1], reload = args[3];
      const titleEl = node && node.querySelector ? node.querySelector('.pjv-trow-title') : null;
      if (titleEl && t && t.id != null && !titleEl.dataset.tmWired) {
        titleEl.dataset.tmWired = '1';
        titleEl.classList.add('clickable');
        titleEl.title = '상세 열기';
        titleEl.addEventListener('click', function (e) { e.stopPropagation(); pjvOpenTaskModal(t.id, reload); });
      }
    } catch (_) { /* 구조 달라도 무해 */ }
    return node;
  };
  (pjvTaskRow as any).__tmWrapped = true;
})();

// ── 태스크 제목: 클릭=상세 모달 / 더블클릭=하위 태스크 추가(클릭업식). 위 모달 배선과 공존하도록 감싼다(append-only). ──
//  같은 click 을 행의 캡처 단계에서 가로채 단일/더블 구분 — 위 래퍼의 제목 click(모달)을 stopImmediatePropagation 으로
//  눌러두고: 1회=240ms 뒤 모달, 2회=하위 태스크 인라인 추가. depth 0(태스크)만. 셀/컨트롤 클릭은 그대로 통과.
(function () {
  if (typeof pjvTaskRow !== 'function' || (pjvTaskRow as any).__cfDblWrapped) return;
  const _inner = pjvTaskRow;
  // @ts-ignore 의도적 몽키패치 — function 선언을 런타임에서 재할당(JS 합법·동작 보존). TS 만 막아서 무시.
  pjvTaskRow = function (this: any, ...args: any[]) {
    const node = _inner.apply(this, args as any);
    try {
      const projectId = args[0], t = args[1], reload = args[3], depth = args[4] || 0;
      if (depth === 0 && node && node.querySelector) {
        const rowEl = node.querySelector('.pjv-trow');
        const titleEl = node.querySelector('.pjv-trow-title');
        const subBox = node.querySelector('.pjv-trow-subs');
        if (rowEl && titleEl && subBox && t && t.id != null && !rowEl.dataset.cfDbl) {
          rowEl.dataset.cfDbl = '1';
          titleEl.title = '클릭: 상세 열기 · 더블클릭: 하위 태스크 추가';
          let clicks = 0, timer: any = null;
          rowEl.addEventListener('click', function (e) {
            if (!e.target.closest('.pjv-trow-title')) return; // 제목 클릭만 가로챔(셀/컨트롤은 통과)
            e.stopImmediatePropagation(); e.preventDefault();
            clicks++;
            if (clicks === 1) {
              timer = setTimeout(function () { clicks = 0; if (typeof pjvOpenTaskModal === 'function') pjvOpenTaskModal(t.id, reload); }, 240);
            } else {
              clearTimeout(timer); clicks = 0;
              subBox.hidden = false;
              const car = rowEl.querySelector('.pjv-trow-caret');
              if (car && car.tagName === 'BUTTON') { car.textContent = '▾'; car.setAttribute('aria-expanded', 'true'); }
              pjvShowInlineSubtask(projectId, t, subBox, reload);
            }
          }, true); // 캡처 — 제목 자체 click(모달) 리스너보다 먼저
        }
      }
    } catch (_) { /* 구조 달라도 무해 */ }
    return node;
  };
  (pjvTaskRow as any).__cfDblWrapped = true;
})();

export {
  PJV_PRIORITY,
  PJV_PRIORITY_ORDER,
  PJV_STATUS_ORDER,
  PJV_TASK_STATUS,
  authDownload,
  authUpload,
  avatarColor,
  debounce,
  fileIconSvg,
  fmtDateTime,
  fmtSize,
  initials,
  openFileViewer,
  pjvAssigneeControl,
  pjvAssignees,
  pjvAssigneeWrite,
  pjvCheckMini,
  pjvDueControl,
  pjvFmtDate,
  pjvIsOverdue,
  pjvPatchTask,
  pjvPopover,
  pjvPriorityControl,
  pjvSaveTask,
  pjvStatusMeta,
  renderProjectV2Detail,
  renderProjectsV2,
};

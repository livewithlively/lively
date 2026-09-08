// admin-teams.ts — #1405 W3: admin-members.ts 분할 ①.
//  관리탭 '팀(부서)' 패널 — 목록·보기·편집. 구성원 패널과 데이터도 화면도 겹치지 않는 독립 덩어리다.
import { api, busy, cardHead, el, errorNote, state, toast, uiText } from './core.js';
import { field, skeleton } from './ui-primitives.js';
import { sectionHead } from './admin-widgets.js';

// ── 팀 — 구성원을 팀(스쿼드)으로 묶고, 팀이 카테고리를 '소유'한다(표면화·주입의 '우리 팀' 기준). ──
//  오너십 배정 자체는 [카테고리(분류 체계)] 화면(카테고리별 오너 드롭다운)에서. 여기선 팀 CRUD + 팀원(역할) + 소유 현황.
//  ★오너십 = 우선순위이지 접근제한이 아니다. 편집은 context 스코프(canContext).
const TEAM_ROLE_OPTS = [
  ['lead', '리드'], ['pm', 'PO/PM'], ['dev', '개발'], ['design', '디자인'], ['member', '멤버'],
];

const TEAM_ROLE_LABEL = Object.fromEntries(TEAM_ROLE_OPTS);

async function teamsPanel(detail, data, opts: any = {}) {
  const canEdit = state.admin.canContext;
  busy(detail, el('div', { class: 'card' }, skeleton('팀을 불러오는 중')));
  let teams;
  try { teams = ((await api('/api/ui/teams')) || {}).teams || []; }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '팀을 불러오지 못했습니다'))); return; }

  // 처음 들어오면 **맨 위 팀이 골라져 있다** — 빈 오른쪽 패널에 '왼쪽에서 고르세요'를 띄우던 걸 대체(사용자 요구).
  const sel = state.admin.teamSel ?? (teams.length ? teams[0].id : null);
  const listCol = el('div', { class: 'admin-sublist' });
  const newTeamBtn = canEdit ? el('button', { class: 'btn btn-ghost btn-sm', text: '+ 새 팀',
    onclick: () => { state.admin.teamSel = '__new__'; state.admin.teamEditing = true; teamsPanel(detail, data); } }) : null;
  for (const t of teams) {
    listCol.append(el('div', { class: 'mini-row' + (String(t.id) === String(sel) ? ' sel' : ''),
      onclick: () => { state.admin.teamSel = t.id; state.admin.teamEditing = false; teamsPanel(detail, data, opts); } },
      el('div', { class: 'mini-title', text: (t.name || t.key) }),
      el('div', { class: 'mini-meta', text: (t.member_count || 0) + '명 · 카테고리 ' + (t.category_count || 0) + '개' })));
  }
  if (!teams.length) listCol.append(el('div', { class: 'mini-meta' }, ...uiText('아직 팀이 없습니다.')));

  const right = el('div', {});
  // 팀이 하나도 없으면(첫 사용) 바로 생성 폼을 연다 — 빈 패널에서 '구성원이 안 보인다'는 혼선 제거(팀원 picker 가 폼 안에 있으므로).
  const wantCreate = sel === '__new__' || (sel == null && teams.length === 0 && canEdit);
  if (wantCreate && canEdit) {
    teamForm(right, { key: '', name: '', description: '', body_md: '', lead_member_id: '', members: [], categories: [] }, data, detail, true);
  } else if (sel != null && sel !== '__new__') {
    right.append(skeleton('팀 정보를 불러오는 중'));
    api('/api/ui/teams/' + sel).then((r) => {
      const team = r && r.team;
      if (!team) { right.replaceChildren(el('p', { class: 'admin-hint' }, ...uiText('팀을 찾을 수 없습니다.'))); return; }
      if (state.admin.teamEditing && canEdit) teamForm(right, team, data, detail, false);
      else teamView(right, team, data, detail);
    }).catch((e) => right.replaceChildren(errorNote(e, '팀 정보를 불러오지 못했습니다')));
  } else {
    right.classList.add('admin-col-center');
    right.append(el('p', { class: 'admin-hint' }, ...uiText(canEdit ? '왼쪽에서 팀을 고르거나 [+ 새 팀]을 누르세요.' : '읽기 전용 — 편집은 context 권한이 필요합니다.')));
  }

  // 제목은 다른 탭과 같게 카드 밖 sectionHead 로(카드 안 sectionTitle 은 .card h2=17px 라 제목이 작아 보였다, #req).
  // ⚠ replaceChildren 에 null 을 그대로 넘기면 DOM 이 **"null" 글자**로 렌더한다(el 과 달리 안 걸러진다 —
  //  wikiCategoriesPanel 에 같은 함정이 주석으로 남아 있다). 배열로 모아 filter(Boolean) 한다.
  detail.replaceChildren(...[
    // 합친 화면(구성원·팀)의 가로탭 안에서는 제목을 다시 그리지 않는다 — 페이지 제목이 이미 위에 있다(#1085).
    opts.embedded ? null : sectionHead('팀', '구성원을 팀으로 묶고, 팀이 맡는 카테고리를 정합니다. 팀이 맡은 카테고리는 팀원의 화면과 AI 세션에 먼저 나옵니다.', { key: 'team' }),
    el('div', { class: 'card' },
      cardHead('팀 목록과 담당 카테고리', '팀이 맡은 카테고리는 팀원의 화면과 AI 세션에 먼저 나옵니다.', null, newTeamBtn),
      el('div', { class: 'admin-two admin-two-cols' }, listCol, right)),
  ].filter(Boolean));
}

// 팀 보기(수정 전 읽기 요약).
function teamView(root, team, data, detail) {
  const canEdit = state.admin.canContext;
  const roRow = (label, value) => field(label, el('div', { class: 'admin-ro', text: value || '—' }));
  const memberName = (id) => { const m = (data.members || []).find((x) => x.id === id); return m ? (m.display_name || m.id) : id; };
  const owned = (team.categories || []).filter((c) => c.relation === 'owner');
  const stake = (team.categories || []).filter((c) => c.relation !== 'owner');
  const kids: any[] = [
    el('div', { class: 'member-read-head' }, el('h3', { text: team.name || team.key }),
      team.state === 'archived' ? el('span', { class: 'pill', text: '보관됨' }) : null),
    roRow('키(슬러그)', team.key),
    roRow('설명', team.description),
    roRow('리드', team.lead_member_id ? memberName(team.lead_member_id) : ''),
    field('팀원', el('div', { class: 'admin-ro admin-ro-pre', text:
      (team.members && team.members.length) ? team.members.map((m) => (m.display_name || m.member_id) + ' (' + (TEAM_ROLE_LABEL[m.role] || m.role) + ')').join('\n') : '—' })),
    field('소유 카테고리', el('div', { class: 'admin-ro admin-ro-pre', text: owned.length ? owned.map((c) => (c.name || c.key)).join('\n') : '— ([카테고리(분류 체계)]에서 배정)' })),
  ];
  if (stake.length) kids.push(field('이해관계 카테고리', el('div', { class: 'admin-ro admin-ro-pre', text: stake.map((c) => (c.name || c.key)).join('\n') })));
  if (team.body_md && team.body_md.trim()) kids.push(field('팀 charter (AI 세션 주입)', el('div', { class: 'admin-ro admin-ro-pre', text: team.body_md.trim() })));
  if (canEdit) kids.push(el('div', { class: 'admin-actions' },
    el('button', { class: 'btn btn-primary', text: '수정', onclick: () => { state.admin.teamEditing = true; teamsPanel(detail, data); } })));
  root.replaceChildren(...kids);
}

// 팀 수정/생성 폼.
function teamForm(root, team, data, detail, isNew) {
  const keyIn = el('input', { type: 'text', value: team.key || '', placeholder: '키(영문 슬러그, 예: product-core)' });
  const nameIn = el('input', { type: 'text', value: team.name || '', placeholder: '팀 이름(예: 프로덕트 코어)' });
  const descIn = el('input', { type: 'text', value: team.description || '', placeholder: '한 줄 설명(선택)' });
  const bodyTa = el('textarea', { rows: '4', placeholder: '팀 charter — 이 팀 AI 세션 첫머리에 주입될 팀 규칙/컨벤션(선택)' });
  bodyTa.value = team.body_md || '';
  // 팀원 — 멤버별 체크 + 역할 select(역할에 '리드' 포함 → 별도 리드 필드 불필요, 역할에서 파생). 기존 멤버는 체크/역할 프리필.
  const existing: any = {}; (team.members || []).forEach((m) => { existing[m.member_id] = m.role || 'member'; });
  const memberRows: any[] = [];
  const membersWrap = el('div', { class: 'team-members-wrap' });
  for (const m of (data.members || [])) {
    if ((m.kind || 'human') !== 'human') continue;
    const chk = el('input', { type: 'checkbox' });
    chk.checked = existing[m.id] != null;
    const roleSel = el('select', { class: 'team-role-sel' }, ...TEAM_ROLE_OPTS.map(([rk, rl]) => el('option', { value: rk, text: rl })));
    roleSel.value = existing[m.id] || 'member';
    memberRows.push({ id: m.id, chk, roleSel });
    membersWrap.append(el('label', { class: 'team-member-opt' }, chk, el('span', { class: 'team-member-name', text: ' ' + (m.display_name || m.id) }), roleSel));
  }

  const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '만들기' : '저장' });
  saveBtn.addEventListener('click', async () => {
    const key = keyIn.value.trim().toLowerCase();
    if (!key) { toast('키(슬러그)를 입력하세요', true); return; }
    saveBtn.disabled = true;
    try {
      let teamId = team.id;
      const members = memberRows.filter((r) => r.chk.checked).map((r) => ({ member_id: r.id, role: r.roleSel.value }));
      // 리드 = 역할이 '리드'인 팀원에서 파생(별도 필드 없음). 여럿이면 첫 번째.
      const leadM = members.find((m) => m.role === 'lead');
      const payload = { key, name: nameIn.value.trim(), description: descIn.value.trim(), body_md: bodyTa.value, lead_member_id: leadM ? leadM.member_id : null };
      if (isNew) { const r = await api('/api/ui/teams', { method: 'POST', body: JSON.stringify(payload) }); teamId = r && r.team && r.team.id; }
      else await api('/api/ui/teams/' + team.id, { method: 'POST', body: JSON.stringify(payload) });
      if (teamId) await api('/api/ui/teams/' + teamId + '/members', { method: 'POST', body: JSON.stringify({ members }) });
      toast('저장됨');
      state.admin.teamSel = teamId; state.admin.teamEditing = false;
      teamsPanel(detail, data);
    } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  });

  const actions = el('div', { class: 'admin-actions' }, saveBtn,
    el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => { state.admin.teamEditing = false; if (isNew) state.admin.teamSel = null; teamsPanel(detail, data); } }));
  if (!isNew) actions.append(el('button', { class: 'btn-text', text: '삭제',
    onclick: async () => {
      if (!confirm("팀 '" + (team.name || team.key) + "'을(를) 삭제할까요? (카테고리 오너십이 해제됩니다 — 카테고리 자체는 남습니다)")) return;
      try { await api('/api/ui/teams/' + team.id + '/delete', { method: 'POST' }); toast('삭제됨'); state.admin.teamSel = null; state.admin.teamEditing = false; teamsPanel(detail, data); }
      catch (e) { toast(e.message, true); }
    } }));

  root.replaceChildren(
    field('키 (슬러그 · 영문)', keyIn), field('팀 이름', nameIn), field('설명', descIn),
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '팀원 (체크 + 역할 · 리드는 역할에서 지정)' }), membersWrap),
    field('팀 charter (AI 세션 주입 · 선택)', bodyTa),
    actions);
}

export { teamsPanel };

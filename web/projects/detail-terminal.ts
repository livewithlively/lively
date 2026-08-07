// projects/detail-terminal.ts — #1405 W1: detail-sections.ts 분할 ③.
//  프로젝트 상세 ② '터미널 세션' 섹션 + 세션 생성/이름변경/삭제 폼.
//  ⚠ watchProvision 의 폴링 타이머는 이 모듈이 소유한다(노드가 DOM 에서 빠지면 스스로 멈춘다).
//  본문은 원문 그대로 옮겼다(verbatim).
import { api, appUrl, el, errorNote, personFace, relTime, toast } from '../core.js';
import { overlayBox, skeletonRows } from '../learn.js';
import { openProjectSessionsModal } from '../sessions.js';
import { openTermCreateForm } from '../terminal.js';
import { openProjectPreviewModal } from './detail-preview.js';
import { pjvMemberDirectory } from './task-controls.js';

// ── 상세 ② 터미널 세션 — 팀원 프로필(아바타) 그리드 → 클릭 시 그 사람 세션 펼침(페이지 내). 본인은 상태메시지 공유. ──
function projectTerminalSection(id, members, meId, base, projectName, project?) {
  const B = base || '/api/ui/projects/';
  const projectRepos = (project && project.repos) || [];
  const card = el('div', { class: 'card proj-term-card', style: 'margin-bottom:18px' });
  const body = el('div', {});
  // '＋ 새 세션' — 대시보드와 **같은 모달**을 연다(#1145 안 1). 종전엔 드롭다운으로 '내 PC / 웹'을 먼저 고른
  //  뒤에야 (그것도 서로 다른) 모달이 떴다 — 경로마다 다른 폼이 뜨는 게 이 프로젝트가 없애려던 바로 그 문제다.
  //  이제 웹/내 PC 는 그 모달 **맨 위 2택**이고, 프로젝트 맥락(폴더 고정·가시성)은 opts.project 로 넘긴다.
  const newBtn = el('button', { class: 'btn btn-ghost btn-sm', 'data-tour': 'proj-new-session', text: '＋ 새 세션' });
  newBtn.dataset.tour = 'proj-new-session';
  newBtn.onclick = async (e) => {
    e.stopPropagation();
    newBtn.disabled = true;
    try {
      const cfg = await api('/api/ui/terminal/config');
      openTermCreateForm(cfg, null, () => load(), { project: { id, name: projectName, base: B } });
    } catch (err: any) { toast('세션 설정을 불러오지 못했습니다 — ' + ((err && err.message) || err), true); }
    finally { newBtn.disabled = false; }
  };
  // 세션 기록(#905 C1) — 끝난 세션 포함 중앙 대화록. 공간 아끼려 섹션 대신 여기 버튼→모달.
  const sessLogBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '📜 세션 기록' });
  sessLogBtn.addEventListener('click', () => openProjectSessionsModal(id, projectName));
  // 미리보기(#1036) — 작업 화면을 따로 띄워 본다. 세션 기록과 같은 이유로 섹션이 아니라 버튼→모달
  //  (상세 페이지는 이미 길다). 관련 레포가 없는 프로젝트에는 아예 두지 않는다.
  const previewBtn = projectRepos.length
    ? el('button', { class: 'btn btn-ghost btn-sm', title: '작업 중인 화면을 따로 띄워 확인', text: '🖥 미리보기' }) : null;
  if (previewBtn) previewBtn.addEventListener('click', () => openProjectPreviewModal(id, projectName, projectRepos));
  card.append(el('div', { class: 'card-head' }, el('h3', { text: '터미널 세션' }),
    el('div', { class: 'card-head-actions' }, ...(previewBtn ? [previewBtn] : []), sessLogBtn, newBtn)));
  card.append(body);
  let sessions: any[] = [];
  let selected: any = null;
  let dragId: any = null;
  let autoPicked = false;              // '내 세션 펼침'은 첫 렌더 1회만 — 사용자가 접으면 그 뜻을 존중한다
  const guestNames: Record<string, string> = {}; // 팀원 아닌 세션 주인의 표시명(구성원 디렉터리에서)
  const team = () => (members && members.length ? members : []);
  // 이 섹션에 그릴 사람 = 팀원 ∪ 세션 주인(#1088).
  //  프로젝트 세션은 팀원 배정과 무관하게 로그인한 전원이 열고 볼 수 있는데(#452), 예전엔 그리드를 **팀원으로만**
  //  그려서 (a) 팀원이 한 명도 없는 프로젝트에선 세션이 통째로 안 보이고, (b) 팀원 아닌 사람이 연 세션은
  //  어느 칸에도 안 잡혀 목록에서 사라졌다. 세션 주인을 뒤에 붙여 '연 사람은 반드시 보이게' 한다.
  const ppl = () => {
    const seen = new Set(team().map((x) => x.member_id));
    const guests: any[] = [];
    for (const s of sessions) {
      if (!s.owner || seen.has(s.owner)) continue;
      seen.add(s.owner);
      guests.push({ member_id: s.owner, display_name: guestNames[s.owner] || s.owner, guest: true });
    }
    return [...team(), ...guests];
  };
  const ownerName = (oid) => { const m = team().find((x) => x.member_id === oid); return (m && m.display_name) || guestNames[oid] || oid; };
  load();
  return card;

  async function load() {
    body.replaceChildren(skeletonRows(2));
    try { sessions = await api(B + id + '/sessions').then((d) => (d && d.sessions) || []); }
    catch (e) { body.replaceChildren(errorNote(e, '세션을 불러오지 못했습니다')); return; }
    // 팀원 아닌 주인이 섞여 있으면 이름을 구성원 디렉터리에서 채운다(1회 캐시). 실패해도 id 로 그린다.
    const known = new Set(team().map((x) => x.member_id));
    if (sessions.some((s) => s.owner && !known.has(s.owner))) {
      try { for (const m of await pjvMemberDirectory()) if (m && m.id) guestNames[m.id] = m.display_name || m.id; }
      catch (_) { /* 디렉터리 조회 실패 — id 로 표시 */ }
    }
    render();
  }
  function render() {
    const people = ppl();
    if (!people.length) { body.replaceChildren(el('div', { class: 'empty', text: '아직 이 프로젝트의 세션이 없습니다. 위 ‘＋ 새 세션’으로 시작하면 여기에 프로필이 생깁니다.' })); return; }
    if (selected && !people.some((x) => x.member_id === selected)) selected = null; // 펼쳐둔 사람이 사라짐(세션 종료·팀원 제외) → 빈 패널 대신 접는다
    // 내가 연 세션이 있으면 첫 렌더에서 내 칸을 펼쳐 준다 — '열었는데 목록이 안 보인다'의 마지막 한 클릭(#1088).
    if (!autoPicked) { autoPicked = true; if (!selected && sessions.some((s) => s.owner === meId)) selected = meId; }
    const grid = el('div', { class: 'proj-people-grid' }, ...people.map(personCircle));
    const panel = el('div', { class: 'proj-people-panel' });
    if (selected) renderPanel(panel);
    body.replaceChildren(grid, panel);
  }
  function personCircle(m) {
    const isMe = m.member_id === meId;
    const cnt = sessions.filter((s) => s.owner === m.member_id).length;
    const avatar = personFace(m.member_id, 'proj-avatar', m.display_name || m.member_id);
    if (cnt) avatar.append(el('span', { class: 'proj-avatar-badge', text: String(cnt) }));
    const hasStatus = !m.guest && !!m.status_message;
    // 상태 메시지는 팀원만(비팀원은 서버가 403) — 대신 '팀원 아님'을 적어 팀에 추가된 것처럼 읽히지 않게 한다.
    const canEditStatus = isMe && !m.guest;
    const status = el('div', { class: 'proj-person-status' + (canEditStatus ? ' me' : '') + (m.guest ? ' guest' : hasStatus ? ' filled' : ' empty'),
      text: m.guest ? '팀원 아님' : hasStatus ? m.status_message : (canEditStatus ? '✎ 상태 남기기' : '') });
    if (canEditStatus && hasStatus) status.append(el('span', { class: 'proj-status-pen', text: ' ✎' }));
    if (canEditStatus) { status.title = '클릭해서 상태 메시지 수정'; status.onclick = (ev) => { ev.stopPropagation(); editStatus(m); }; }
    const wrap = el('div', { class: 'proj-person' + (selected === m.member_id ? ' active' : '') },
      avatar, el('div', { class: 'proj-person-name', text: m.display_name || m.member_id }), status);
    wrap.onclick = () => { selected = (selected === m.member_id ? null : m.member_id); render(); };
    // 드래그앤드롭으로 진열 순서 조절(짧게 누르면 선택, 끌면 재배치). 순서는 팀원 명단이라 비팀원 칸은 제외한다
    //  (끌어서 놓으면 팀원으로 저장돼 버린다 — 보기만 하는 칸이 팀 편집을 유발하면 안 된다).
    wrap.draggable = !m.guest;
    if (!m.guest) {
      wrap.addEventListener('dragstart', (ev) => { dragId = m.member_id; wrap.classList.add('dragging'); ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', m.member_id); } catch (_) { /* */ } });
      wrap.addEventListener('dragend', () => { dragId = null; wrap.classList.remove('dragging'); });
      wrap.addEventListener('dragover', (ev) => { if (dragId && dragId !== m.member_id) { ev.preventDefault(); wrap.classList.add('drop-target'); } });
      wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-target'));
      wrap.addEventListener('drop', (ev) => { ev.preventDefault(); wrap.classList.remove('drop-target'); if (dragId && dragId !== m.member_id) reorder(dragId, m.member_id); });
    }
    return wrap;
  }
  function reorder(fromId, toId) {
    const list = team();
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
    acts.push(el('button', { class: 'btn btn-ghost btn-sm', text: 'ℹ 정보', onclick: () => openSessionInfo(s) }));  // 세션 메타 팝업(#480 요청2)
    // 노드 세션(#905 C4)은 &node= 로 입장해야 게이트웨이가 그 노드로 attach 를 릴레이한다.
    const openQ = appUrl('/ui/terminal.html?session=') + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || '') + (s.node ? '&node=' + encodeURIComponent(s.node.id) : '');
    acts.push(el('button', { class: 'btn btn-primary btn-sm', text: '입장', onclick: () => window.open(openQ, '_blank') }));
    return el('div', { class: 'proj-sess-row' },
      el('div', { class: 'proj-sess-main' },
        el('div', { class: 'proj-sess-name' }, (s.label || s.id),
          s.attached ? el('span', { class: 'proj-sess-live', text: '● 사용 중' }) : null),
        el('div', { class: 'proj-sess-meta', text: (s.harness || 'shell') + ' · 만든이 ' + ownerName(s.owner) + (s.node ? ' · 🖥 ' + (s.node.name || s.node.id) + (s.node.online ? '' : ' (끊김)') : '') })),
      el('div', { class: 'proj-sess-acts' }, ...acts));
  }
  // 세션 메타 팝업(#480 요청2) — 목록이 이미 담아 보내는 값만으로 구성(추가 백엔드 없음). 실시간 상태는 미포함(요청).
  function openSessionInfo(s) {
    const HARNESS_LABEL = { claude: 'Claude Code', codex: 'Codex', shell: '셸 (에이전트 없음)' };
    const model = (s.flags && (s.flags['--model'] || s.flags['-m'])) || '';
    const harnessTxt = (HARNESS_LABEL[s.harness] || s.harness || 'shell') + (model ? ' · ' + model : '');
    const inviteNames = (s.invites || []).map(ownerName);
    const rows: any[] = [
      ['이름', s.label || s.id],
      ['종류', harnessTxt],
      ...(s.node ? [['실행 노드', '🖥 ' + (s.node.name || s.node.id) + (s.node.online ? '' : ' — 연결 끊김')]] : []),  // #905 C4
      ['자동 승인', s.autoApprove ? '켜짐 — 권한 확인 없이 실행' : '꺼짐'],
      ['사용 중', s.attached ? '예 — 지금 열려 있음' : '아니오'],
      ['만든이', ownerName(s.owner)],
      ['만든 시각', s.created ? (new Date(s.created * 1000).toLocaleString('ko-KR') + ' · ' + relTime(s.created * 1000)) : '—'],
      ['작업 폴더', s.dir || '—'],
      ['공개 범위', inviteNames.length ? ('초대: ' + inviteNames.join(', ')) : '비공개 — 프로젝트 세션은 팀원 공용'],
      ['세션 ID', s.id],
    ];
    const rowEl = (kv) => el('div', { style: 'display:flex;gap:10px;padding:7px 0;border-bottom:1px solid rgba(127,127,127,.12)' },
      el('div', { style: 'flex:0 0 92px;color:var(--muted,#888);font-size:13px', text: kv[0] }),
      el('div', { style: 'flex:1;min-width:0;word-break:break-all', text: kv[1] }));
    const enterBtn = el('button', { class: 'btn btn-primary', text: '입장',
      onclick: () => window.open(appUrl('/ui/terminal.html?session=') + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || '') + (s.node ? '&node=' + encodeURIComponent(s.node.id) : ''), '_blank') });
    const back = overlayBox('세션 정보 — ' + (s.label || s.id),
      el('div', {}, ...rows.map(rowEl)),
      el('div', { class: 'ov-actions' }, enterBtn, el('button', { class: 'btn btn-ghost', text: '닫기', onclick: () => back.remove() })));
  }
  function editStatus(m) {
    const input = el('input', { type: 'text', value: m.status_message || '', placeholder: '현재 상태 (예: 결제 모듈 작업 중)', maxlength: '200' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    const back = overlayBox('내 상태 메시지',
      el('p', { class: 'admin-hint', text: '이 프로젝트에서의 ‘현재 상태’예요 — 이 프로젝트 팀원에게만 보이고, 다른 프로젝트엔 영향을 주지 않아요.' }),
      el('div', { class: 'field' }, input),
      el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
    setTimeout(() => input.focus(), 0);
    const go = async () => {
      saveBtn.disabled = true;
      try {
        const r = await api(base + id + '/my-status', { method: 'POST', body: JSON.stringify({ message: input.value.trim() }) });
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
// 프로젝트 세션 만들기 — **대시보드와 같은 모달**로 위임한다(#1145 안 1).
//  종전엔 여기에 자체 폼이 있었다(레포 선택·워크트리·경로·브랜치·노드·실행설정). 그 폼이 사라진 이유:
//   · 레포·워크트리는 사람이 세션 만들기 전에 정할 일이 아니다 — 코드가 필요해진 순간 세션이 스스로
//     워크트리를 뜬다(lively_local_repo_worktree, #918). 미리 받기는 #1180 이후 기다리지도 않는다.
//   · 경로마다 다른 폼이 뜨는 것 자체가 #1145 가 없애려던 문제였다.
//  시그니처는 그대로 두어 호출부(목록 '내 세션' 셀·대시보드 위젯·데모)를 건드리지 않는다.
async function openProjectSessionForm(id, reload, base, projectName, _projectRepos?) {
  let cfg: any;
  try { cfg = await api('/api/ui/terminal/config'); }
  catch (e: any) { toast('세션 설정을 불러오지 못했습니다 — ' + ((e && e.message) || e), true); return; }
  openTermCreateForm(cfg, null, () => reload && reload(), {
    project: { id, name: projectName, base: base || '/api/ui/v6/projects/' },
  });
}

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
      // 노드 세션(#905 C4)은 node 를 함께 보내야 편집이 그 노드에 릴레이된다(안 보내면 게이트웨이 로컬 편집→소유권 오판 403).
      await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'POST', body: JSON.stringify({ label, node: (s.node && s.node.id) || undefined }) });
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
    // 노드 세션(#905 C4)은 ?node= 로 삭제를 그 노드에 위임한다(터미널 탭과 동일).
    await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + (s.node ? '?node=' + encodeURIComponent(s.node.id) : ''), { method: 'DELETE' });
    toast('세션을 삭제했습니다'); reload();
  } catch (e) { toast('실패 — ' + e.message, true); }
}

export { openProjectSessionForm, projectTerminalSection };

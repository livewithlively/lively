// projects/detail-terminal.ts — #1405 W1: detail-sections.ts 분할 ③.
//  프로젝트 상세 ② '터미널 세션' 섹션 + 세션 생성/이름변경/삭제 폼.
//  ⚠ watchProvision 의 폴링 타이머는 이 모듈이 소유한다(노드가 DOM 에서 빠지면 스스로 멈춘다).
//  본문은 원문 그대로 옮겼다(verbatim).
import { api, appUrl, busy, el, errorNote, personFace, relTime, toast } from '../core.js';
import { field } from '../admin.js';
import { overlayBox, skeletonRows } from '../learn.js';
import { openProjectSessionsModal } from '../sessions.js';
import { saveTermCreatePrefs, termCreatePrefs } from '../terminal.js';
import { openProjectPreviewModal } from './detail-preview.js';
import { pjvPopover } from './popover.js';
import { pjvMemberDirectory } from './task-controls.js';
import { openLocalWorkModal } from './detail-local-work.js';
// #1582 — 세션 종료 확인창·완료 토스트는 전 화면 공용 정의 하나만 쓴다(AI 세션 탭·대시보드와 같은 말).
import { confirmSessionEnd, endedToast } from '../session-actions.js';
// ── 상세 ② 터미널 세션 — 팀원 프로필(아바타) 그리드 → 클릭 시 그 사람 세션 펼침(페이지 내). 본인은 상태메시지 공유. ──
function projectTerminalSection(id, members, meId, base, projectName, project) {
    const B = base || '/api/ui/projects/';
    const projectRepos = (project && project.repos) || [];
    const card = el('div', { class: 'card proj-term-card', style: 'margin-bottom:18px' });
    const body = el('div', {});
    // '＋ 새 세션' — 곧장 폼이 아니라 드롭다운으로 '어디서 작업할지' 먼저 고른다.
    //  · 내 컴퓨터에서 작업 — 내 PC 터미널 실행 명령을 안내(openLocalWorkModal). 웹은 원격 PC를 스트리밍하지 않음.
    //  · 중앙 컴퓨터에서 작업 — 중앙(박스)에서 공동 세션을 바로 생성(openProjectSessionForm). 관련 레포가 기본값.
    const newBtn = el('button', { class: 'btn btn-ghost btn-sm', 'data-tour': 'proj-new-session', text: '＋ 새 세션' });
    newBtn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu pjv-sess-menu' });
        const close = pjvPopover(newBtn, menu, { align: 'right' }); // 우상단 '＋ 새 세션' 버튼 아래 우측정렬(#481 위치 어색 수정)
        const mkItem = (icon, label, desc, fn) => {
            const item = el('button', { class: 'pjv-menu-item', type: 'button' }, icon ? el('span', { class: 'pjv-sess-ico', text: icon }) : null, el('span', { style: 'display:flex;flex-direction:column;gap:1px;min-width:0' }, el('span', { text: label }), desc ? el('span', { class: 'caption', text: desc }) : null));
            item.onclick = (ev) => { ev.stopPropagation(); close(); fn(); };
            return item;
        };
        const localItem = mkItem('💻', '내 PC에서 열기', '개발자용 · 직접 설치해 실행', () => openLocalWorkModal(id, project || { id, name: projectName, repos: projectRepos }));
        const webItem = mkItem('☁️', '웹에서 바로 열기', '설치 불필요 · 팀 공용', () => openProjectSessionForm(id, load, B, projectName, projectRepos));
        webItem.dataset.tour = 'sess-web'; // Lively 둘러보기(#761) 앵커 — 이 항목을 눌러 만들기 창을 띄운다
        menu.append(localItem, webItem);
    };
    // 세션 기록(#905 C1) — 끝난 세션 포함 중앙 대화록. 공간 아끼려 섹션 대신 여기 버튼→모달.
    const sessLogBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '📜 세션 기록' });
    sessLogBtn.addEventListener('click', () => openProjectSessionsModal(id, projectName));
    // 미리보기(#1036) — 작업 화면을 따로 띄워 본다. 세션 기록과 같은 이유로 섹션이 아니라 버튼→모달
    //  (상세 페이지는 이미 길다). 관련 레포가 없는 프로젝트에는 아예 두지 않는다.
    const previewBtn = projectRepos.length
        ? el('button', { class: 'btn btn-ghost btn-sm', title: '작업 중인 화면을 따로 띄워 확인', text: '🖥 미리보기' }) : null;
    if (previewBtn)
        previewBtn.addEventListener('click', () => openProjectPreviewModal(id, projectName, projectRepos));
    card.append(el('div', { class: 'card-head' }, el('h3', { text: '터미널 세션' }), el('div', { class: 'card-head-actions' }, ...(previewBtn ? [previewBtn] : []), sessLogBtn, newBtn)));
    card.append(body);
    let sessions = [];
    let selected = null;
    let dragId = null;
    let autoPicked = false; // '내 세션 펼침'은 첫 렌더 1회만 — 사용자가 접으면 그 뜻을 존중한다
    const guestNames = {}; // 팀원 아닌 세션 주인의 표시명(구성원 디렉터리에서)
    const team = () => (members && members.length ? members : []);
    // 이 섹션에 그릴 사람 = 팀원 ∪ 세션 주인(#1088).
    //  프로젝트 세션은 팀원 배정과 무관하게 로그인한 전원이 열고 볼 수 있는데(#452), 예전엔 그리드를 **팀원으로만**
    //  그려서 (a) 팀원이 한 명도 없는 프로젝트에선 세션이 통째로 안 보이고, (b) 팀원 아닌 사람이 연 세션은
    //  어느 칸에도 안 잡혀 목록에서 사라졌다. 세션 주인을 뒤에 붙여 '연 사람은 반드시 보이게' 한다.
    const ppl = () => {
        const seen = new Set(team().map((x) => x.member_id));
        const guests = [];
        for (const s of sessions) {
            if (!s.owner || seen.has(s.owner))
                continue;
            seen.add(s.owner);
            guests.push({ member_id: s.owner, display_name: guestNames[s.owner] || s.owner, guest: true });
        }
        return [...team(), ...guests];
    };
    const ownerName = (oid) => { const m = team().find((x) => x.member_id === oid); return (m && m.display_name) || guestNames[oid] || oid; };
    load();
    return card;
    async function load() {
        busy(body, skeletonRows(2));
        try {
            sessions = await api(B + id + '/sessions').then((d) => (d && d.sessions) || []);
        }
        catch (e) {
            body.replaceChildren(errorNote(e, '세션을 불러오지 못했습니다'));
            return;
        }
        // 팀원 아닌 주인이 섞여 있으면 이름을 구성원 디렉터리에서 채운다(1회 캐시). 실패해도 id 로 그린다.
        const known = new Set(team().map((x) => x.member_id));
        if (sessions.some((s) => s.owner && !known.has(s.owner))) {
            try {
                for (const m of await pjvMemberDirectory())
                    if (m && m.id)
                        guestNames[m.id] = m.display_name || m.id;
            }
            catch (_) { /* 디렉터리 조회 실패 — id 로 표시 */ }
        }
        render();
    }
    function render() {
        const people = ppl();
        if (!people.length) {
            body.replaceChildren(el('div', { class: 'empty', text: '아직 이 프로젝트의 세션이 없습니다. 위 ‘＋ 새 세션’으로 시작하면 여기에 프로필이 생깁니다.' }));
            return;
        }
        if (selected && !people.some((x) => x.member_id === selected))
            selected = null; // 펼쳐둔 사람이 사라짐(세션 종료·팀원 제외) → 빈 패널 대신 접는다
        // 내가 연 세션이 있으면 첫 렌더에서 내 칸을 펼쳐 준다 — '열었는데 목록이 안 보인다'의 마지막 한 클릭(#1088).
        if (!autoPicked) {
            autoPicked = true;
            if (!selected && sessions.some((s) => s.owner === meId))
                selected = meId;
        }
        const grid = el('div', { class: 'proj-people-grid' }, ...people.map(personCircle));
        const panel = el('div', { class: 'proj-people-panel' });
        if (selected)
            renderPanel(panel);
        body.replaceChildren(grid, panel);
    }
    function personCircle(m) {
        const isMe = m.member_id === meId;
        const cnt = sessions.filter((s) => s.owner === m.member_id).length;
        const avatar = personFace(m.member_id, 'proj-avatar', m.display_name || m.member_id);
        if (cnt)
            avatar.append(el('span', { class: 'proj-avatar-badge', text: String(cnt) }));
        const hasStatus = !m.guest && !!m.status_message;
        // 상태 메시지는 팀원만(비팀원은 서버가 403) — 대신 '팀원 아님'을 적어 팀에 추가된 것처럼 읽히지 않게 한다.
        const canEditStatus = isMe && !m.guest;
        const status = el('div', { class: 'proj-person-status' + (canEditStatus ? ' me' : '') + (m.guest ? ' guest' : hasStatus ? ' filled' : ' empty'),
            text: m.guest ? '팀원 아님' : hasStatus ? m.status_message : (canEditStatus ? '✎ 상태 남기기' : '') });
        if (canEditStatus && hasStatus)
            status.append(el('span', { class: 'proj-status-pen', text: ' ✎' }));
        if (canEditStatus) {
            status.title = '클릭해서 상태 메시지 수정';
            status.onclick = (ev) => { ev.stopPropagation(); editStatus(m); };
        }
        const wrap = el('div', { class: 'proj-person' + (selected === m.member_id ? ' active' : '') }, avatar, el('div', { class: 'proj-person-name', text: m.display_name || m.member_id }), status);
        wrap.onclick = () => { selected = (selected === m.member_id ? null : m.member_id); render(); };
        // 드래그앤드롭으로 진열 순서 조절(짧게 누르면 선택, 끌면 재배치). 순서는 팀원 명단이라 비팀원 칸은 제외한다
        //  (끌어서 놓으면 팀원으로 저장돼 버린다 — 보기만 하는 칸이 팀 편집을 유발하면 안 된다).
        wrap.draggable = !m.guest;
        if (!m.guest) {
            wrap.addEventListener('dragstart', (ev) => { dragId = m.member_id; wrap.classList.add('dragging'); ev.dataTransfer.effectAllowed = 'move'; try {
                ev.dataTransfer.setData('text/plain', m.member_id);
            }
            catch (_) { /* */ } });
            wrap.addEventListener('dragend', () => { dragId = null; wrap.classList.remove('dragging'); });
            wrap.addEventListener('dragover', (ev) => { if (dragId && dragId !== m.member_id) {
                ev.preventDefault();
                wrap.classList.add('drop-target');
            } });
            wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-target'));
            wrap.addEventListener('drop', (ev) => { ev.preventDefault(); wrap.classList.remove('drop-target'); if (dragId && dragId !== m.member_id)
                reorder(dragId, m.member_id); });
        }
        return wrap;
    }
    function reorder(fromId, toId) {
        const list = team();
        const fromIdx = list.findIndex((x) => x.member_id === fromId);
        const toIdx = list.findIndex((x) => x.member_id === toId);
        if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx)
            return;
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
        const head = el('div', { class: 'proj-panel-head' }, el('b', { text: (m && m.display_name) || selected }), ' 의 세션 ', el('span', { class: 'proj-panel-cnt', text: String(mine.length) }));
        // ＋ 새 세션 버튼은 카드 헤더 우상단에 항상 있으므로 패널에선 중복 제거(같은 동작).
        panel.append(head);
        if (!mine.length) {
            panel.append(el('div', { class: 'empty', text: selected === meId ? '아직 만든 세션이 없어요. ‘＋ 새 세션’으로 시작하세요.' : '아직 만든 세션이 없습니다.' }));
            return;
        }
        panel.append(el('div', { class: 'proj-sess-list' }, ...mine.map(sessRow)));
    }
    function sessRow(s) {
        const acts = [];
        if (s.owned)
            acts.push(el('button', { class: 'btn btn-ghost btn-sm', text: '이름변경', onclick: () => openSessionRename(s, load) }), el('button', { class: 'btn btn-ghost btn-sm', title: '이 세션을 끝냅니다 — 작업 폴더·파일은 그대로, 대화록은 세션 기록에 남습니다', text: '종료', onclick: () => removeSession(s, load) }));
        acts.push(el('button', { class: 'btn btn-ghost btn-sm', text: 'ℹ 정보', onclick: () => openSessionInfo(s) })); // 세션 메타 팝업(#480 요청2)
        // 노드 세션(#905 C4)은 &node= 로 입장해야 게이트웨이가 그 노드로 attach 를 릴레이한다.
        const openQ = appUrl('/ui/terminal.html?session=') + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || '') + (s.node ? '&node=' + encodeURIComponent(s.node.id) : '');
        acts.push(el('button', { class: 'btn btn-primary btn-sm', text: '입장', onclick: () => window.open(openQ, '_blank') }));
        return el('div', { class: 'proj-sess-row' }, el('div', { class: 'proj-sess-main' }, el('div', { class: 'proj-sess-name' }, (s.label || s.id), s.attached ? el('span', { class: 'proj-sess-live', text: '● 사용 중' }) : null), el('div', { class: 'proj-sess-meta', text: (s.harness || 'shell') + ' · 만든이 ' + ownerName(s.owner) + (s.node ? ' · 🖥 ' + (s.node.name || s.node.id) + (s.node.online ? '' : ' (끊김)') : '') })), el('div', { class: 'proj-sess-acts' }, ...acts));
    }
    // 세션 메타 팝업(#480 요청2) — 목록이 이미 담아 보내는 값만으로 구성(추가 백엔드 없음). 실시간 상태는 미포함(요청).
    function openSessionInfo(s) {
        const HARNESS_LABEL = { claude: 'Claude Code', codex: 'Codex', shell: '셸 (에이전트 없음)' };
        const model = (s.flags && (s.flags['--model'] || s.flags['-m'])) || '';
        const harnessTxt = (HARNESS_LABEL[s.harness] || s.harness || 'shell') + (model ? ' · ' + model : '');
        const inviteNames = (s.invites || []).map(ownerName);
        const rows = [
            ['이름', s.label || s.id],
            ['종류', harnessTxt],
            ...(s.node ? [['실행 노드', '🖥 ' + (s.node.name || s.node.id) + (s.node.online ? '' : ' — 연결 끊김')]] : []), // #905 C4
            ['자동 승인', s.autoApprove ? '켜짐 — 권한 확인 없이 실행' : '꺼짐'],
            ['사용 중', s.attached ? '예 — 지금 열려 있음' : '아니오'],
            ['만든이', ownerName(s.owner)],
            ['만든 시각', s.created ? (new Date(s.created * 1000).toLocaleString('ko-KR') + ' · ' + relTime(s.created * 1000)) : '—'],
            ['작업 폴더', s.dir || '—'],
            ['공개 범위', inviteNames.length ? ('초대: ' + inviteNames.join(', ')) : '비공개 — 프로젝트 세션은 팀원 공용'],
            ['세션 ID', s.id],
        ];
        const rowEl = (kv) => el('div', { style: 'display:flex;gap:10px;padding:7px 0;border-bottom:1px solid rgba(127,127,127,.12)' }, el('div', { style: 'flex:0 0 92px;color:var(--muted,#888);font-size:13px', text: kv[0] }), el('div', { style: 'flex:1;min-width:0;word-break:break-all', text: kv[1] }));
        const enterBtn = el('button', { class: 'btn btn-primary', text: '입장',
            onclick: () => window.open(appUrl('/ui/terminal.html?session=') + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(s.label || '') + (s.node ? '&node=' + encodeURIComponent(s.node.id) : ''), '_blank') });
        const back = overlayBox('세션 정보 — ' + (s.label || s.id), el('div', {}, ...rows.map(rowEl)), el('div', { class: 'ov-actions' }, enterBtn, el('button', { class: 'btn btn-ghost', text: '닫기', onclick: () => back.remove() })));
    }
    function editStatus(m) {
        const input = el('input', { type: 'text', value: m.status_message || '', placeholder: '현재 상태 (예: 결제 모듈 작업 중)', maxlength: '200' });
        const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
        const back = overlayBox('내 상태 메시지', el('p', { class: 'admin-hint', text: '이 프로젝트에서의 ‘현재 상태’예요 — 이 프로젝트 팀원에게만 보이고, 다른 프로젝트엔 영향을 주지 않아요.' }), el('div', { class: 'field' }, input), el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
        setTimeout(() => input.focus(), 0);
        const go = async () => {
            saveBtn.disabled = true;
            try {
                const r = await api(base + id + '/my-status', { method: 'POST', body: JSON.stringify({ message: input.value.trim() }) });
                m.status_message = r.status_message;
                back.remove();
                toast('상태를 저장했습니다');
                render();
            }
            catch (e) {
                toast('실패 — ' + e.message, true);
                saveBtn.disabled = false;
            }
        };
        saveBtn.onclick = go;
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter')
            go(); });
    }
}
// 새 프로젝트 세션 오버레이 — 터미널 탭과 같은 정보(실행기·모델 등 플래그·자동승인). 폴더는 프로젝트 폴더 고정,
//  공개범위는 '팀원 공동'(별도 입력 없음). 생성 후 새 탭 입장.
async function openProjectSessionForm(id, reload, base, projectName, projectRepos) {
    const B = base || '/api/ui/projects/';
    let cfg;
    try {
        cfg = await api('/api/ui/terminal/config');
    }
    catch (e) {
        toast('세션 설정을 불러오지 못했습니다 — ' + e.message, true);
        return;
    }
    const harnesses = cfg.harnesses || [];
    const prefs = termCreatePrefs(); // 이전 '실행 설정'(터미널 탭 새 세션과 같은 기억 — #673/#req) 프리필
    const nameIn = el('input', { type: 'text', value: projectName || '', placeholder: '세션 이름 (예: 개발, 빌드)', maxlength: '80' });
    const harnessSel = el('select', { class: 'term-input' }, ...harnesses.map((h) => el('option', { value: h.key, text: h.label })));
    const flagsBox = el('div', { class: 'term-flags' });
    const autoCb = el('input', { type: 'checkbox' });
    // #782: 자동 승인 기본 해제(옛 #480 의 '기본 켬' 철회) — 켠 적이 있는 사람만 그 선택이 이어진다(사용자별 기억).
    autoCb.checked = prefs.autoApprove === true;
    const autoRow = el('label', { class: 'proj-sess-auto' }, autoCb, el('span', { text: ' 자동 승인 — 파일 수정·명령 실행을 매번 묻지 않고 바로 진행 (신뢰하는 작업에만)' }));
    // '실행 설정' — 터미널 탭 새 세션 팝업의 프리셋 UI 그대로(#req — 같은 term-preset-* 컴포넌트/요약줄).
    //  요약줄이 프리필 값(하네스·모델·effort)을 그대로 보여주므로 기본 '접힘'(#req 후속 — 터미널 탭과 동일), 클릭으로 펼침.
    const presetSum = el('div', { class: 'term-preset-sum' });
    const presetChev = el('span', { class: 'term-preset-chev' });
    const presetToggle = el('button', { class: 'term-preset-toggle', type: 'button' }, presetSum, presetChev);
    const presetBody = el('div', { class: 'term-preset-body' }, field('실행 (AI)', harnessSel), flagsBox, el('div', { style: 'margin-top:10px' }, autoRow));
    let presetOpen = false; // 기본 접힘(#req 후속) — 프리필 값이 요약줄에 이미 보여 펼칠 필요가 없다.
    const applyPreset = () => { presetBody.style.display = presetOpen ? '' : 'none'; presetChev.textContent = presetOpen ? '▴' : '▾'; };
    presetToggle.onclick = () => { presetOpen = !presetOpen; applyPreset(); };
    const harnessOf = () => harnesses.find((x) => x.key === harnessSel.value) || {};
    function presetSummary() {
        const h = harnessOf();
        const parts = [h.label || harnessSel.value];
        for (const f of (h.flags || [])) {
            if (f.name !== '--model' && f.name !== '--effort')
                continue;
            const c = flagsBox.querySelector('[data-flag="' + f.name + '"]');
            parts.push((f.name === '--model' ? '모델 ' : 'effort ') + ((c && c.value) || '기본'));
        }
        presetSum.replaceChildren(el('b', { text: '실행 설정' }), document.createTextNode(' · ' + parts.join(' · ')));
    }
    function renderFlags() {
        const h = harnessOf();
        flagsBox.replaceChildren();
        for (const f of (h.flags || [])) {
            let ctrl;
            if (f.type === 'select')
                ctrl = el('select', { class: 'term-input', 'data-flag': f.name }, ...(f.choices || []).map((c) => el('option', { value: c, text: c || '(기본)' })));
            else if (f.type === 'bool')
                ctrl = el('input', { type: 'checkbox', 'data-flag': f.name });
            else
                ctrl = el('input', { class: 'term-input', type: 'text', 'data-flag': f.name, placeholder: f.desc || '' });
            const saved = prefs.flags && prefs.flags[f.name]; // 이전 설정 프리필(#673/#req)
            if (saved != null) {
                if (ctrl.type === 'checkbox')
                    ctrl.checked = !!saved;
                else
                    ctrl.value = saved;
            }
            ctrl.addEventListener('change', presetSummary);
            flagsBox.append(el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: f.label }), ctrl, f.desc ? el('div', { class: 'caption', text: f.desc }) : null));
        }
        autoRow.style.display = h.hasAutoApprove ? '' : 'none';
        presetSummary();
    }
    harnessSel.addEventListener('change', renderFlags);
    if (prefs.harness && harnesses.some((h) => h.key === prefs.harness))
        harnessSel.value = prefs.harness; // 이전 하네스 프리필
    renderFlags();
    applyPreset();
    // ── 레포에서 작업 (선택, 여러 개) — '내 컴퓨터에서 작업'(work.mjs)과 동일 수준: 박스가 각 레포를 준비(입력 경로에
    //  없으면 레지스트리 clone_url 로 clone)한다. 워크트리면 project/<id>/<repo> 격리 폴더(브랜치 project/<id>). 세션은
    //  프로젝트 폴더에서 열리고 — 워크트리는 그 하위라 접근됨, 비워크트리 클론은 add-dir(.claude/settings.local.json)로 접근. ──
    const boxPathKey = (repo) => 'lively:boxpath:' + repo; // 박스 경로 기억(로컬PC 경로와 별개 키)
    const savedBoxPath = (repo) => { try {
        return repo ? (localStorage.getItem(boxPathKey(repo)) || '') : '';
    }
    catch (_) {
        return '';
    } };
    const cloneRepoNames = [];
    const reposWrap = el('div', {});
    let rrows = [];
    const fillRepoSel = (sel) => {
        const cur = sel.value;
        sel.replaceChildren(el('option', { value: '', text: '— 코드 저장소 선택 —' }));
        cloneRepoNames.forEach((n) => sel.append(el('option', { value: n, text: n })));
        if (cloneRepoNames.includes(cur))
            sel.value = cur;
    };
    const addRepoRow = (initRepo = '') => {
        const sel = el('select', {});
        const pathInp = el('input', { type: 'text', placeholder: '코드를 둘 위치 (비워두면 자동 — 보통 안 건드려도 돼요)' });
        const wtChk = el('input', { type: 'checkbox' });
        wtChk.checked = true;
        const branchInp = el('input', { type: 'text', value: 'project/' + id });
        const rmBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '✕' });
        fillRepoSel(sel);
        if (initRepo)
            sel.value = initRepo;
        pathInp.value = savedBoxPath(sel.value);
        const branchWrap = el('div', { class: 'field', style: 'margin-top:6px' }, el('label', { class: 'field-label', text: '작업 공간 이름 (자동 · 보통 그대로 두세요)' }), branchInp);
        const pathField = el('div', { class: 'field' }, el('label', { class: 'field-label', text: '코드 저장 위치 (선택)' }), pathInp);
        // 워크트리(격리) 체크 — 기본 화면에선 숨기고 '고급 설정' 안으로 넣는다. 기본값은 체크(권장)라 안 열어도 워크트리로 준비됨.
        const wtRow = el('label', { class: 'proj-sess-auto', style: 'margin-top:2px' }, wtChk, el('span', { text: ' 워크트리 — 다른 작업과 안 섞임 (권장)' }));
        // 고급 설정 — 워크트리·경로·작업공간 이름을 하나의 토글로 접어둔다(기본 닫힘, 중첩 없음). 기본 화면엔 저장소 선택만.
        const advBox = el('div', { style: 'display:none;margin-top:8px' }, wtRow, pathField, branchWrap);
        const advToggle = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '▸ 고급 설정' });
        let advOpen = false;
        advToggle.onclick = () => { advOpen = !advOpen; advBox.style.display = advOpen ? '' : 'none'; advToggle.textContent = (advOpen ? '▾' : '▸') + ' 고급 설정'; };
        const branchVis = () => { branchWrap.style.display = wtChk.checked ? '' : 'none'; };
        const ro = { sel, pathInp, wtChk, branchInp };
        rrows.push(ro);
        sel.addEventListener('change', () => { pathInp.value = savedBoxPath(sel.value); }); // 레포 바꾸면 그 레포의 마지막 경로로
        pathInp.addEventListener('change', () => { if (sel.value && pathInp.value.trim()) {
            try {
                localStorage.setItem(boxPathKey(sel.value), pathInp.value.trim());
            }
            catch (_) { /* */ }
        } });
        wtChk.addEventListener('change', branchVis);
        const rowEl = el('section', { class: 'ps-block', style: 'border:1px solid rgba(127,127,127,.18);border-radius:8px;padding:10px;margin-top:8px' }, el('div', { style: 'display:flex;gap:8px;align-items:center' }, sel, rmBtn), el('div', { style: 'margin-top:8px' }, advToggle), advBox);
        ro.el = rowEl;
        rmBtn.onclick = () => { rowEl.remove(); rrows = rrows.filter((r) => r !== ro); };
        branchVis();
        reposWrap.append(rowEl);
    };
    const addRepoBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '+ 레포 추가', onclick: () => addRepoRow() });
    try {
        const rr = await api('/api/ui/repos');
        ((rr && rr.domainmapRepos) || []).forEach((it) => { if (it && it.name)
            cloneRepoNames.push(it.name); });
    }
    catch (_) { /* graceful: 레포 없음 */ }
    // 이 프로젝트의 관련 레포를 기본 행으로(있으면) — 없으면 빈 채로 '+ 레포 추가' 안내.
    (projectRepos || []).filter((n) => cloneRepoNames.includes(n)).forEach((n) => addRepoRow(n));
    // 실행 위치(#905 C4) — 기본 중앙 박스. 등록된 노드를 고르면 그 노드에서 레포 provision + 세션 생성.
    //  usable=1 = **내가 등록한 노드 ∪ 관리자가 공유로 지정한 노드**(#1540 — 서버의 provision 게이트와 같은 술어라
    //  목록에 보이면 반드시 열린다). provision 능력 없는 구 번들·오프라인 노드는 disabled 로 이유를 보인다.
    let usableNodes = [];
    try {
        usableNodes = (await api('/api/ui/nodes?usable=1')).nodes || [];
    }
    catch (_) { /* graceful: 노드 없음 */ }
    const nodeSel = el('select', { class: 'term-input' }, el('option', { value: '', text: '중앙 컴퓨터 (기본)' }), ...usableNodes.map((n) => {
        const caps = Array.isArray(n.agent_caps) ? n.agent_caps : [];
        const suffix = caps.indexOf('provision') < 0 ? ' — 에이전트 업데이트 필요' : (!n.online ? ' — 오프라인' : '');
        // 공유 노드는 '남의 컴퓨터일 수 있다'가 고를 때 중요한 정보라 라벨에 함께 보인다(종류보다 앞).
        const scope = n.shared ? ' (공유)' : (n.kind === 'worker' ? ' (워커)' : '');
        const o = el('option', { value: n.id, text: '🖥 ' + (n.name || n.id) + scope + suffix });
        if (suffix)
            o.disabled = true;
        return o;
    }));
    const nodeField = el('div', { class: 'field', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '실행 위치' }), nodeSel, el('div', { class: 'caption', text: '기본은 중앙 컴퓨터입니다. 등록된 워커/멤버 노드를 고르면 그 노드에서 레포를 받아 세션을 엽니다(provision 지원 노드만 고를 수 있어요).' }));
    const saveBtn = el('button', { class: 'btn btn-primary', 'data-tour': 'sess-create', text: '만들고 입장' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', 'data-tour': 'sess-cancel', text: '취소', onclick: () => back.remove() });
    // 옛 '▸ 고급 설정 (실행기·모델·자동 승인)' 접이 토글 폐기(#req) — 터미널 탭과 동일한 '실행 설정' 프리셋을
    //  기본 펼침으로 바로 노출(presetToggle + presetBody 위에서 구성). 이전 설정 프리필이라 대부분 그대로 만들면 된다.
    const back = overlayBox('새 터미널 세션', el('p', { class: 'admin-hint', text: '이 프로젝트 폴더에서 시작하는 공동 세션입니다 — 프로젝트 팀원만 보고 입장할 수 있어요.' }), el('div', { class: 'field', 'data-tour': 'sess-name' }, el('label', { class: 'field-label', text: '이름' }), nameIn), ...(usableNodes.length ? [nodeField] : []), el('div', { class: 'field', 'data-tour': 'sess-repos', style: 'margin-top:12px' }, el('label', { class: 'field-label', text: '코드 저장소 미리 받기 (선택 — 대개 필요 없어요)' }), el('div', { class: 'caption', text: '코드 작업이어도 고를 필요 없어요 — 세션이 코드가 필요해지면 스스로 가져옵니다(프로젝트에 연결된 저장소가 없어도 후보를 찾아 물어봐요). 큰 저장소라 받는 데 오래 걸려서 세션 시작 전에 미리 받아두고 싶을 때만 쓰세요.' }), reposWrap, el('div', { style: 'margin-top:8px' }, addRepoBtn)), el('div', { class: 'term-preset proj-sess-preset', style: 'margin-top:12px' }, presetToggle, presetBody), el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
    setTimeout(() => nameIn.focus(), 0);
    saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        const flags = {};
        for (const ctrl of flagsBox.querySelectorAll('[data-flag]')) {
            const k = ctrl.getAttribute('data-flag');
            const v = ctrl.type === 'checkbox' ? (ctrl.checked ? 'true' : '') : ctrl.value;
            if (v)
                flags[k] = v;
        }
        saveTermCreatePrefs({ harness: harnessSel.value, flags, autoApprove: autoCb.checked }); // 다음 생성 때 기본값(터미널 탭과 공유 — #673/#req, 자동 승인은 #782)
        try {
            // 선택한 레포(들)를 먼저 provision(clone/worktree + 비워크트리 add-dir). node 를 고르면 그 노드에서, 아니면 중앙 박스에서.
            //  세션도 같은 node 로 열어야 provision 된 폴더에서 열린다(node 없으면 중앙 — 무회귀).
            const node = nodeSel.value || undefined;
            const specs = rrows.map((r) => ({ name: r.sel.value, path: r.pathInp.value.trim(), worktree: r.wtChk.checked, branch: r.branchInp.value.trim() })).filter((s) => s.name);
            // #1180 — 레포 준비를 **기다리지 않는다**. clone 은 분 단위일 수 있는데 그동안 브라우저 요청을 붙들고
            //  사람을 세워두는 건 그 자체가 나쁜 경험이고 프록시 타임아웃 위험도 있다. 시작만 시키고 세션을 바로 연다.
            //  세션 cwd 는 레포가 아니라 프로젝트 폴더라(#918) 워크트리가 뒤늦게 생겨도 안전하고, 그 사이 세션엔
            //  마커(repos_pending)→프리로드가 "받는 중 · 직접 clone 금지"를 알린다(#1155 레일 재사용).
            //  ⚠ 시작 자체의 실패(노드 오프라인·권한 등)는 여기서 그대로 throw 되어 아래 catch 로 간다 — 그건 알아야 한다.
            if (specs.length) {
                saveBtn.textContent = node ? '노드에 레포 준비 요청 중…' : '레포 준비 시작 중…';
                await api(B + id + '/provision', { method: 'POST', body: JSON.stringify({ repos: specs, node, async: true }) });
            }
            saveBtn.textContent = node ? '노드에서 세션 여는 중…' : '세션 여는 중…';
            const r = await api(B + id + '/sessions', { method: 'POST', body: JSON.stringify({
                    label: nameIn.value.trim(), harness: harnessSel.value, flags, autoApprove: autoCb.checked, node,
                }) });
            back.remove();
            toast(specs.length ? ('세션을 만들었습니다 · 레포 ' + specs.length + '개는 백그라운드에서 준비 중입니다') : '세션을 만들었습니다');
            if (specs.length)
                watchProvision(B, id, node, reload); // 완료·실패를 폴링해 알려준다(페이지가 열려 있는 동안)
            // 노드 세션(#905 C4)은 &node= 로 열어야 게이트웨이가 그 노드로 attach WS 를 릴레이한다(public/terminal.js).
            if (r && r.session && r.session.id)
                window.open(appUrl('/ui/terminal.html?session=') + encodeURIComponent(r.session.id) + '&label=' + encodeURIComponent(r.session.label || '') + (node ? '&node=' + encodeURIComponent(node) : ''), '_blank');
            reload();
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            saveBtn.disabled = false;
            saveBtn.textContent = '만들고 입장';
        }
    };
}
// 비동기 provision 진행 감시(#1180) — 세션은 이미 열렸고, 여기선 **알림만** 한다(화면을 막지 않는다).
//  페이지를 닫으면 폴링도 끝난다 — 그래도 결과는 잃지 않는다: 완료/실패는 프로젝트 폴더 마커에 남고,
//  그 세션의 AI 는 시작 시 주입으로, 사람은 다음 진입 때 목록으로 본다. 이 폴링은 '지금 보고 있는 사람'에게만 주는 편의다.
function watchProvision(B, id, node, reload) {
    const url = B + id + '/provision/status' + (node ? '?node=' + encodeURIComponent(node) : '');
    const started = Date.now();
    const CAP_MS = 10 * 60 * 1000; // 10분이면 대형 레포 첫 clone 도 끝난다 — 넘으면 조용히 손 뗀다(서버는 계속 진행)
    const tick = async () => {
        if (Date.now() - started > CAP_MS)
            return;
        let st;
        try {
            st = await api(url);
        }
        catch (_) {
            return;
        } // 네트워크·로그아웃 — 조용히 중단(알림용 폴링일 뿐)
        if (!st || st.state === 'running') {
            setTimeout(tick, 3000);
            return;
        }
        if (!st.known)
            return; // 실행 주체가 재시작돼 기억 상실 — 다음 진입 때 다시 시도하면 된다
        if (st.state === 'error') {
            toast('레포 준비를 시작하지 못했습니다 — ' + (st.error || '알 수 없는 오류'), true);
            return;
        }
        const failed = Array.isArray(st.failed) ? st.failed : [];
        if (failed.length)
            toast('레포 ' + failed.length + '개를 준비하지 못했습니다(' + failed.map((f) => f.name).join(', ') + ') — 열린 세션 안에서 복구 방법을 안내합니다.', true);
        else
            toast('레포 준비 완료 — 세션에서 바로 쓸 수 있어요');
        if (typeof reload === 'function')
            reload();
    };
    setTimeout(tick, 1500);
}
// 세션 이름 변경 오버레이 — 기존 터미널 세션 API 재사용(소유자만, 서버가 강제).
function openSessionRename(s, reload) {
    const nameIn = el('input', { type: 'text', value: s.label || '', placeholder: '세션 이름', maxlength: '80' });
    const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
    const back = overlayBox('세션 이름 변경', el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameIn), el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
    setTimeout(() => nameIn.focus(), 0);
    const go = async () => {
        const label = nameIn.value.trim();
        if (!label) {
            nameIn.focus();
            toast('이름을 입력하세요', true);
            return;
        }
        saveBtn.disabled = true;
        try {
            // 노드 세션(#905 C4)은 node 를 함께 보내야 편집이 그 노드에 릴레이된다(안 보내면 게이트웨이 로컬 편집→소유권 오판 403).
            await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'POST', body: JSON.stringify({ label, node: (s.node && s.node.id) || undefined }) });
            back.remove();
            toast('이름을 변경했습니다');
            reload();
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            saveBtn.disabled = false;
        }
    };
    saveBtn.onclick = go;
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter')
        go(); });
}
// 세션 종료 — 확인 후 tmux 세션 종료(소유자만). 실행 중 작업도 함께 끝난다.
//  #1582 — '삭제' + 브라우저 confirm + "되돌릴 수 없음" 이었다. 셋 다 사실과 어긋나 고쳤다: 이 동작은 작업
//  폴더·파일·대화록을 지우지 않고(killSession 은 tmux 와 desired-state 만 건드린다), 확인창은 AI 세션 탭·
//  대시보드와 **같은 공용 정의**를 쓴다. 근거는 session-actions.ts 헤더.
async function removeSession(s, reload) {
    if (!await confirmSessionEnd({ title: '‘' + (s.label || s.id) + '’ 세션을 종료할까요?', sessions: [s] }))
        return;
    try {
        // 노드 세션(#905 C4)은 ?node= 로 종료를 그 노드에 위임한다(터미널 탭과 동일).
        await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + (s.node ? '?node=' + encodeURIComponent(s.node.id) : ''), { method: 'DELETE' });
        toast(await endedToast(1, [s]));
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
export { openProjectSessionForm, projectTerminalSection };

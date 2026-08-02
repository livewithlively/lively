// projects/detail-sections.ts — #1313 R35: web/projects.ts 분해 ⑥.
//  프로젝트 상세의 **부속 섹션·모달** 한 벌 —
//   · 세부 설정 팝업(openProjectSettings) + 규칙(projectRulesBlock)·삭제(projectDangerBlock)
//   · 내 컴퓨터에서 작업(openLocalWorkModal·renderLocalWorkCommand·copyText)
//   · 전체 작업 로그(companyTimelineSection) · 공유 폴더(projectFolderSection)
//   · 터미널 세션(projectTerminalSection) + 세션 폼(openProjectSessionForm)·provision 폴링(watchProvision)
//   · 작업 타임라인(projectTimelineSection)
//  ⚠ watchProvision 의 폴링 타이머는 이 모듈이 소유한다(노드가 DOM 에서 빠지면 스스로 멈춘다).
import { api, el, errorNote, toast } from '../core.js';
import { activityTimelineRow } from '../activity-view.js';
import { overlayBox, skeletonRows } from '../learn.js';
import { memberPicker } from './files.js';
import { compactPicker } from './popover.js';
import { repoPicker } from './project-form.js';
import { pjvMemberDirectory } from './task-controls.js';
// ── 프로젝트 세부 설정 팝업 — 팀원 · 분류 · 레포 · 규칙 · 삭제. 헤더 '⚙ 프로젝트 세부 설정'에서 연다. ──
//  (필요/산출 지식은 본문 아래 '지식 흐름' 섹션으로 이관 — #245.)
//  (참고 파일 블록 제거 — 본문 '공유 폴더' 브라우저와 중복이라 거기로 일원화 — #246.)
//  (상태 블록 제거 — 상세 메타 패널의 상태 필드(pjvProjStatusPill, 클릭해 3단계 변경) + 대시보드·목록·일괄바와
//   중복이고 모달 토글은 2단계뿐이라 더 약했다 — #246.)
//  (삭제·팀원 수정을 헤더에서 여기로 이관 — 헤더는 제목/상태칩/설정 버튼만.)
// 세부 설정 = 새 프로젝트 폼과 같은 결로 통일(#473 후속) — 카테고리·레포·팀원을 컴팩트 피커(요약 칩 + ▾) 한 줄씩으로.
//  블록마다 저장 버튼을 두지 않고, 상세 메타 패널처럼 '바꾸면 그 자리서 자동 저장'(피커 onChange, 로드시 첫 fire 는 건너뜀 + 디바운스).
//  이름·설명은 프로젝트 화면에서 바로 편집(제목 클릭·본문 섹션)하므로 여기서 뺀다. 규칙·삭제는 유지.
function openProjectSettings(id, p, reload, meId, base) {
    const B = base || '/api/ui/v6/projects/';
    const back = overlayBox('프로젝트 세부 설정', el('div', { class: 'proj-settings' }));
    const box = back.querySelector('.ov-box');
    if (box)
        box.classList.add('ov-box-wide');
    // 컴팩트 필드 + 자동저장 — 사용자가 값을 바꿀 때만(로드 완료의 첫 onChange 는 저장 아님) 짧게 디바운스해 현재 선택 전체를 POST.
    let dirty = false; // 무언가 저장됐으면 팝업 닫힐 때 상세를 한 번 재렌더(헤더·메타 반영).
    const autoField = (label, makePicker, opts, postFn, savedMsg) => {
        let ready = false;
        let timer = null;
        let field;
        const doSave = async () => {
            try {
                await postFn();
                dirty = true;
                toast(savedMsg);
            }
            catch (e) {
                toast(savedMsg.replace('저장됨', '저장 실패') + ' — ' + e.message, true);
            }
        };
        field = compactPicker(label, makePicker, Object.assign({}, opts, { onChange: () => {
                if (!ready) {
                    ready = true;
                    return;
                } // 로드 완료 시 첫 onChange = 현재값 반영일 뿐, 저장 아님
                if (timer)
                    clearTimeout(timer);
                timer = setTimeout(doSave, 500);
            } }));
        return field;
    };
    // 카테고리(도메인)는 소속 리스트에서 상속(#541 후속) — 여기선 읽기전용 표시, 변경은 리스트 설정에서.
    const inheritedCat = ((p.categories) || [])[0];
    const catRow = el('div', { class: 'cf-row' }, el('span', { class: 'cf-label', text: '카테고리' }), el('div', { class: 'cf-summary ps-cat-inherit' }, inheritedCat
        ? el('span', { class: 'ps-cat-chip', text: (inheritedCat.name || inheritedCat.key) })
        : el('span', { class: 'ps-cat-none', text: '미분류' }), el('span', { class: 'ps-cat-inherit-hint', text: '소속 리스트에서 상속 — 리스트 설정에서 변경' })));
    const repoField = autoField('관련 레포', (onChange) => repoPicker((p.repos) || [], { onChange }), { emptyText: '선택 안 함' }, () => api(B + id + '/repos', { method: 'POST', body: JSON.stringify({ repos: repoField.getSelected() }) }), '관련 레포 저장됨');
    const memberField = autoField('팀원', (onChange) => memberPicker(((p.members) || []).map((m) => m.member_id), { onChange }), { emptyText: '나만 참여', avatars: true, maxChips: 6 }, () => api(B + id + '/members', { method: 'POST', body: JSON.stringify({ members: memberField.getSelected() }) }), '팀원 저장됨');
    // 어떤 경로로 닫히든(닫기·배경·Esc) dirty 면 상세 재렌더 — overlayBox 는 콜백이 없어 back 분리를 감지.
    if (typeof MutationObserver !== 'undefined') {
        const obs = new MutationObserver(() => { if (!back.isConnected) {
            obs.disconnect();
            if (dirty)
                reload();
        } });
        obs.observe(document.body, { childList: true });
    }
    back.querySelector('.proj-settings').append(el('section', { class: 'ps-block' }, el('h3', { class: 'ps-block-title', text: '분류 · 연결' }), el('p', { class: 'ps-block-hint', text: '바꾸면 바로 저장돼요. (이름·설명은 프로젝트 화면에서 제목/본문을 눌러 바로 고칠 수 있어요.)' }), el('div', { class: 'ps-meta' }, catRow, repoField.row, memberField.row)), projectRulesBlock(id), 
    // (필요/산출 지식 블록은 본문 아래 '지식 흐름' 섹션 projectKnowledgeSection 으로 이관 — #245.)
    // (참고 파일 블록은 본문 '공유 폴더' 섹션으로 일원화 — #246. 상태 블록은 메타 패널 상태 필드로 일원화 — #246.)
    projectDangerBlock(id, p, meId, back));
}
// 팀원 블록 — 현재 팀원 칩 + '팀원 수정'(멀티선택 오버레이). 저장 시 설정 팝업 닫고 상세 재렌더.
// (팀원·카테고리·관련레포 블록 제거 — #473 후속. 세부 설정은 새 프로젝트 폼과 같은 컴팩트 피커 + 자동저장으로 openProjectSettings 에 인라인.)
// 삭제 블록 — 작성자 본인만 노출(서버도 403 재검증). 확인 후 삭제 → 팝업 닫고 목록으로.
function projectDangerBlock(id, p, meId, back) {
    // 삭제 전원 개방(#280) — 인증된 누구나(서버도 인증만 요구). 삭제는 #/trash 에서 복원 가능.
    const delBtn = el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: '프로젝트 삭제' });
    delBtn.onclick = async () => {
        if (!confirm('프로젝트 ‘' + p.name + '’을(를) 삭제할까요?\n\n프로젝트와 그 작업(태스크·하위)이 함께 사라집니다(되돌릴 수 없음). 연결된 지식은 보존됩니다.'))
            return;
        delBtn.disabled = true;
        try {
            await api('/api/ui/v6/projects/' + id + '/delete', { method: 'POST' });
            toast('프로젝트를 삭제했습니다');
            back.remove();
            location.hash = '#/projects2';
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            delBtn.disabled = false;
        }
    };
    return el('section', { class: 'ps-block' }, el('h3', { class: 'ps-block-title', text: '프로젝트 삭제' }), el('p', { class: 'ps-block-hint', text: '프로젝트와 그 안의 모든 태스크가 영구 삭제됩니다(되돌릴 수 없음). 연결된 지식은 보존돼요.' }), el('div', { class: 'ps-rules-actions' }, delBtn));
}
// (상태 블록 제거 — #246. 상태 변경은 상세 메타 패널의 상태 필드(pjvProjStatusPill, 클릭→할 일/진행 중/완료 3단계)
//  + 대시보드 보드·목록 뷰·행 ⋯ 메뉴·일괄작업 바 어디서든 가능. 모달 토글은 2단계뿐이라 더 약했고 중복이었다.)
// 규칙 블록 — 프로젝트 AGENTS.md 의 '규칙' 영역만 편집(나머지 digest 는 서버가 자동 생성). /rules 엔드포인트로 로드/저장.
//  AGENTS.md 는 Codex 가 네이티브 로드, CLAUDE.md 는 `@AGENTS.md` 한 줄로 Claude Code 가 끌어옴(서버가 함께 관리).
function projectRulesBlock(id) {
    const url = '/api/ui/v6/projects/' + id + '/rules';
    const ta = el('textarea', { class: 'ps-rules-ta', rows: '8', disabled: '',
        placeholder: '이 프로젝트에서 AI가 지켰으면 하는 걸 편하게 적으세요. 예)\n· 새로 만들기 전에 비슷한 게 이미 있는지 먼저 찾아본다.\n· 큰 변경이나 삭제는 진행하기 전에 꼭 먼저 물어본다.\n· 자료를 만들 땐 근거와 출처를 같이 적는다.\n· 안 되는 건 안 된다고 솔직히 말한다.' });
    const status = el('span', { class: 'ps-save-status admin-hint', text: '불러오는 중…' });
    const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: '규칙 저장', disabled: '' });
    (async () => {
        try {
            const d = await api(url);
            ta.value = (d && d.rules) || '';
        }
        catch (_) {
            ta.value = '';
        }
        ta.disabled = false;
        saveBtn.disabled = false;
        status.textContent = '';
    })();
    saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        status.textContent = '저장 중…';
        try {
            await api(url, { method: 'POST', body: JSON.stringify({ rules: ta.value }) });
            status.textContent = '저장됨 · 다음 세션부터 적용';
            toast('프로젝트 규칙을 저장했습니다');
        }
        catch (e) {
            status.textContent = '';
            toast('저장 실패 — ' + e.message, true);
        }
        saveBtn.disabled = false;
    };
    return el('section', { class: 'ps-block' }, el('h3', { class: 'ps-block-title', text: '프로젝트 규칙' }), el('p', { class: 'ps-block-hint', text: '이 프로젝트에서 터미널 세션을 열면, 여기 적은 규칙이 그 AI에게 자동으로 주입됩니다. (프로젝트 폴더의 AGENTS.md 규칙 영역으로 저장)' }), ta, el('div', { class: 'ps-rules-actions' }, saveBtn, status));
}
// 전체 작업 로그(대시보드 ④ 의 ⤢ 팝업) — 회사 전체 활동 피드 + 유형 칩 필터.
//  #852: 예전엔 200건을 받아 놓고도 **6개만** 그리고 '＋N개 더 보기'로 10개씩 늘렸다 —
//  큰 팝업을 열었는데 여섯 줄만 보이니 "한 번에 좀 보여 달라"가 됐다. 이제 받은 만큼 **다 그리고**
//  모달 안에서 스크롤로 읽는다(행 상세는 펼칠 때 만드는 lazy 라 수백 행이어도 가볍다).
//  더 과거는 #709 표준(limit/offset)으로 이어 붙인다.
const CTL_PAGE = 200;
function companyTimelineSection() {
    const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
    const body = el('div', {});
    const st = { type: '' };
    let members = [];
    let acts = [];
    let atEnd = false; // 마지막 페이지까지 받음 → '더 불러오기' 숨김
    const nameOf = (pid) => { const m = members.find((x) => x.id === pid); return (m && m.display_name) || pid || '—'; };
    const TYPES = [['', '전체'], ['feature', '기능'], ['fix', '수정'], ['decision', '결정'], ['docs', '문서'], ['research', '리서치'], ['review', '검토'], ['chore', '운영'], ['other', '기타']];
    const chipsBar = el('div', { class: 'proj-tl-filter' });
    const paintChips = () => chipsBar.replaceChildren(...TYPES.map(([v, label]) => el('button', { class: 'proj-tl-chip' + (st.type === v ? ' active' : ''), text: label, onclick: () => { st.type = v; paintChips(); load(); } })));
    paintChips();
    card.append(chipsBar, body);
    api('/api/ui/dash/members').then((d) => { members = (d && d.members) || []; if (acts.length)
        render(); }).catch(() => { });
    load();
    return card;
    async function load(more) {
        if (!more) {
            acts = [];
            atEnd = false;
            body.replaceChildren(skeletonRows(6));
        }
        try {
            const qs = '?limit=' + CTL_PAGE + '&offset=' + acts.length + (st.type ? '&type=' + encodeURIComponent(st.type) : '');
            const got = await api('/api/ui/activity/list' + qs).then((d) => (Array.isArray(d) ? d : (d && d.rows) || []));
            if (got.length < CTL_PAGE)
                atEnd = true; // 덜 왔다 = 마지막 페이지
            acts = acts.concat(got);
        }
        catch (e) {
            body.replaceChildren(errorNote(e, '작업을 불러오지 못했습니다'));
            return;
        }
        render();
    }
    function render() {
        if (!acts.length) {
            body.replaceChildren(el('div', { class: 'empty', text: '아직 기록된 작업이 없습니다.' }));
            return;
        }
        body.replaceChildren(el('div', { class: 'proj-tl-count', text: acts.length + '개' + (atEnd ? '' : '+') + ' · 작업을 누르면 상세가 펼쳐집니다' }), el('div', { class: 'proj-tl-list' }, ...acts.map(actRow)));
        if (!atEnd) {
            const more = el('button', { class: 'btn btn-ghost btn-sm proj-tl-more', text: '이전 작업 더 불러오기' });
            more.onclick = () => { more.disabled = true; more.textContent = '불러오는 중…'; load(true); };
            body.append(more);
        }
    }
    function actRow(a) { return activityTimelineRow(a, nameOf); }
}
// ── 상세 ③ 작업 타임라인 — 이 프로젝트의 activity + 사람별 필터(전체 + 사람 칩). ──
//  사람 축은 터미널 세션 섹션과 같다(#1088): 팀원 명단이 아니라 **실제로 이 프로젝트에 작업을 남긴 사람**.
//  팀원 아닌 사람의 작업도 목록엔 있었지만 이름이 표시명 대신 id('jang')로 뜨고 칩으로 좁힐 수도 없었다.
function projectTimelineSection(id, members, base) {
    const B = base || '/api/ui/projects/';
    const card = el('div', { class: 'card', style: 'margin-bottom:18px' });
    const body = el('div', {});
    const st = { person: '' };
    const guestNames = {}; // 팀원 아닌 작성자의 표시명(구성원 디렉터리에서)
    let guests = []; // 이 타임라인에 실제로 등장한 팀원 아닌 사람
    const team = () => members || [];
    const nameOf = (pid) => { const m = team().find((x) => x.member_id === pid); return (m && m.display_name) || guestNames[pid] || pid || '—'; };
    const chipsBar = el('div', { class: 'proj-tl-filter' });
    function paintChips() {
        const mk = (label, person) => el('button', { class: 'proj-tl-chip' + (st.person === person ? ' active' : ''), text: label,
            onclick: () => { st.person = person; paintChips(); load(); } });
        chipsBar.replaceChildren(mk('전체', ''), ...team().map((m) => mk(m.display_name || m.member_id, m.member_id)), ...guests.map((p) => mk(nameOf(p), p)));
    }
    paintChips();
    card.append(el('div', { class: 'card-head' }, el('h3', { text: '작업 타임라인' })), el('p', { class: 'proj-tl-note' }, el('span', { class: 'proj-tl-note-ic', text: 'ⓘ' }), el('span', {}, '여기엔 ', el('b', { text: '이 프로젝트에 연결된 작업' }), '이 모여요 — 이 프로젝트의 터미널 세션에서 AI와 함께 진행했거나, 이 프로젝트로 직접 기록된 작업입니다(다른 프로젝트의 작업은 섞이지 않아요). ', el('b', { text: '확실하게 진행이 된 일을 위주로' }), ' 프로젝트 진행의 큰 맥락을 확인하는 용도로 사용해주세요.')), chipsBar, body);
    load();
    return card;
    async function load() {
        body.replaceChildren(skeletonRows(3));
        try {
            const qs = st.person ? ('?author_person=' + encodeURIComponent(st.person)) : '';
            const acts = await api(B + id + '/activity' + qs).then((d) => (d && d.activities) || []);
            // 사람 칩은 **전체 목록**일 때만 다시 만든다 — 필터 결과로 칩을 깎으면 한 사람을 고른 순간 나머지가 사라진다.
            if (!st.person)
                await syncGuests(acts);
            if (!acts.length) {
                body.replaceChildren(el('div', { class: 'empty', text: st.person ? '이 사람의 작업 기록이 없습니다.' : '아직 이 프로젝트의 작업 기록이 없습니다.' }));
                return;
            }
            renderActs(acts);
        }
        catch (e) {
            body.replaceChildren(errorNote(e, '타임라인을 불러오지 못했습니다'));
        }
    }
    // 팀원 아닌 작성자를 추려 칩에 세운다. 이름은 구성원 디렉터리(1회 캐시)에서, 없으면 id 그대로.
    async function syncGuests(acts) {
        const known = new Set(team().map((x) => x.member_id));
        const found = [];
        for (const a of acts) {
            const p = a.author_person;
            if (p && !known.has(p)) {
                known.add(p);
                found.push(p);
            }
        }
        if (found.some((p) => !guestNames[p])) {
            try {
                for (const m of await pjvMemberDirectory())
                    if (m && m.id)
                        guestNames[m.id] = m.display_name || m.id;
            }
            catch (_) { /* 디렉터리 조회 실패 — id 로 표시 */ }
        }
        guests = found;
        paintChips();
    }
    // 5개까지 보이고 나머지는 '더 보기'로 펼침(끝없이 길어지지 않게).
    function renderActs(acts) {
        const LIMIT = 5;
        const list = el('div', { class: 'proj-tl-list' });
        for (const a of acts.slice(0, LIMIT))
            list.append(actRow(a));
        body.replaceChildren(list);
        if (acts.length > LIMIT) {
            const rest = acts.slice(LIMIT);
            const moreBtn = el('button', { class: 'btn btn-ghost btn-sm proj-tl-more', text: '＋ ' + rest.length + '개 더 보기' });
            moreBtn.onclick = () => { for (const a of rest)
                list.append(actRow(a)); moreBtn.remove(); };
            body.append(moreBtn);
        }
    }
    function actRow(a) { return activityTimelineRow(a, nameOf); }
}
// 팀원 수정 오버레이 — 현재 팀원 미리 체크된 멀티선택 → 통째 교체 저장.
// (openMembersEdit 제거 — #473 후속. 팀원 편집은 세부 설정의 '팀원' 컴팩트 피커에서 인라인 자동저장.)
export { companyTimelineSection, openProjectSettings, projectTimelineSection };
export { copyText, openLocalWorkModal } from './detail-local-work.js';
export { projectFolderSection } from './detail-folder.js';
export { openProjectSessionForm, projectTerminalSection } from './detail-terminal.js';

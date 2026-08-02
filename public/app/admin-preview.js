// admin-preview.ts — 미리보기 환경 패널 (#1313 R37, admin.ts 에서 verbatim 분리).
//  ⚠ 폴링 타이머(previewPollTimer)는 **이 모듈이 소유**한다 — 패널 재진입 때 이전 타이머를 clearTimeout 하는
//   계약이 있어서, 타이머 변수와 그걸 세우고 지우는 코드가 갈라지면 안 된다(ESM import 바인딩은 재할당 불가).
import { api, cardHead, el, errorNote, memberCombo, relTime, toast, uiText } from './core.js';
import { overlayBox, skeleton } from './ui-primitives.js';
import { psBlock, psInputStyle, sectionHead } from './admin-widgets.js';
// ── 미리보기 — 작업 중인 화면을 운영 화면·남의 작업과 분리해 따로 띄워 본다. ──
//  사람이 고르는 건 '무엇을 미리볼지'(프로젝트·레포)뿐이고, 작업 폴더 준비·빌드는 서버가 알아서 한다(비동기).
//  대개는 AI 가 작업 중 자동으로 만들어 쓰고, 이 화면은 그것을 **보고·열고·끄는** 창구다.
const PREVIEW_STATUS_TEXT = { running: '실행 중', preparing: '준비 중…', error: '문제 있음', stopped: '꺼짐' };
let previewPollTimer = null;
async function previewEnvsPanel(detail, data) {
    const reload = () => previewEnvsPanel(detail, data);
    if (previewPollTimer) {
        clearTimeout(previewPollTimer);
        previewPollTimer = null;
    }
    detail.replaceChildren(el('div', { class: 'card' }, skeleton('미리보기를 불러오는 중')));
    let envs;
    try {
        const r = await api('/api/ui/preview-envs');
        envs = (r && r.envs) || [];
    }
    catch (e) {
        detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '미리보기 목록을 불러오지 못했습니다')));
        return;
    }
    const rows = el('div', { class: 'wikicat-rows' });
    if (!envs.length) {
        rows.append(el('div', { class: 'wikicat-empty', text: '아직 만든 미리보기가 없습니다. 보통은 AI 가 화면을 확인해야 할 때 자동으로 만들어 쓰고, 직접 만들려면 오른쪽 위 ‘+ 미리보기 만들기’를 누르세요.' }));
    }
    for (const p of envs) {
        const statusText = PREVIEW_STATUS_TEXT[p.status] || (p.status || '알 수 없음');
        const where = [
            p.project_name || (p.project_id ? '프로젝트 #' + p.project_id : null),
            p.repo,
            p.kind === 'stage' ? '여러 작업을 합쳐서 봄' : null,
        ].filter(Boolean).join(' · ');
        const mainKids = [
            el('span', { class: 'wikicat-name', text: p.label || p.id }),
            where ? el('span', { class: 'wikicat-key', text: where }) : null,
            el('span', { class: 'dm-tag', text: p.enabled ? statusText : '꺼둠' }),
            p.last_error ? el('span', { class: 'wikicat-should' }, el('span', { class: 'wikicat-should-label', text: '안내' }), p.last_error) : null,
        ].filter(Boolean);
        const acts = [
            (p.status === 'running') ? el('a', { class: 'btn btn-primary btn-sm', href: '/preview/' + encodeURIComponent(p.id) + '/ui/', target: '_blank', text: '화면 열기 ↗' }) : null,
            (p.status !== 'preparing') ? el('button', { class: 'btn btn-ghost btn-sm', text: p.status === 'running' ? '새로 만들기' : '띄우기', onclick: () => previewEnsure(p.id, reload) }) : null,
            (p.status === 'running' || p.status === 'preparing') ? el('button', { class: 'btn btn-ghost btn-sm', text: '끄기', onclick: () => previewStop(p.id, reload) }) : null,
            el('button', { class: 'btn btn-ghost btn-sm', text: '설정', onclick: () => openPreviewEnvForm(p, reload) }),
            el('button', { class: 'btn btn-ghost btn-sm btn-ghost-danger', text: '삭제', onclick: () => previewDelete(p.id, reload) }),
        ].filter(Boolean);
        rows.append(el('div', { class: 'wikicat-row' }, el('div', { class: 'wikicat-row-main' }, ...mainKids), el('div', { class: 'wikicat-row-acts' }, ...acts)));
    }
    const head = el('div', { class: 'wikicat-grouphead' }, el('span', { class: 'wikicat-grouptitle', text: '미리보기' }), el('span', { class: 'wikicat-groupcount', text: String(envs.length) }), el('button', { class: 'btn btn-ghost btn-sm wikicat-add', text: '+ 미리보기 만들기', onclick: () => openPreviewEnvForm(null, reload) }));
    const card = el('div', { class: 'card' }, cardHead('만들어 둔 미리보기', '항목 하나 = 작업 브랜치 하나를 따로 띄운 화면입니다. AI 세션이 화면 확인이 필요할 때 스스로 만들기도 합니다. [띄우기]로 켜고 [화면 열기]로 보며, 다 봤으면 [끄기](주소는 남고 프로세스만 내려감) 또는 [삭제]. 운영 화면(:8080)에는 영향을 주지 않습니다.'), el('div', { class: 'wikicat' }, el('div', { class: 'wikicat-group' }, head, rows)));
    // 제목·설명은 card 밖 상단으로 — 관리탭 다른 섹션과 같은 자리(#1010).
    detail.replaceChildren(sectionHead('미리보기', '아직 반영하지 않은 작업 화면을 운영 화면과 따로 띄워 확인하는 곳입니다. 항목 하나가 작업 하나이고, 만들어진 주소를 팀원에게 보내 확인받을 수 있습니다.'), card);
    // 준비 중인 게 있으면 잠시 뒤 자동으로 다시 확인한다(사람이 새로고침하지 않아도 되게).
    if (envs.some((x) => x.status === 'preparing')) {
        previewPollTimer = setTimeout(() => { if (document.body.contains(detail))
            reload(); }, 5000);
    }
}
async function openPreviewEnvForm(p, reload) {
    const isNew = !p;
    // 고를 것들을 미리 읽어 둔다 — 사용자가 아이디·경로를 '타이핑'하지 않아도 되게.
    let projects = [], repos = [], profiles = [];
    try {
        const r = await api('/api/ui/v6/projects');
        projects = (r && r.projects) || [];
    }
    catch { /* 목록 못 읽어도 폼은 뜬다 */ }
    try {
        const r = await api('/api/ui/repos');
        repos = (r && r.domainmapRepos) || [];
    }
    catch { /* 위와 동일 */ }
    try {
        const r = await api('/api/ui/stack-profiles');
        profiles = (r && r.profiles) || [];
    }
    catch { /* 고급에서만 쓴다 */ }
    // ── 기본: 무엇을 미리볼까 (이 셋만 채우면 된다) ──
    const projListId = 'prevproj-' + Math.random().toString(36).slice(2, 8);
    const projList = el('datalist', { id: projListId });
    const projLabel = (x) => x.name + ' #' + x.id;
    for (const x of projects.slice(0, 500))
        projList.append(el('option', { value: projLabel(x) }));
    const projInp = el('input', { type: 'text', style: psInputStyle, list: projListId, placeholder: '프로젝트 이름으로 검색' });
    if (p && p.project_id) {
        const f = projects.find((x) => x.id === p.project_id);
        projInp.value = f ? projLabel(f) : ('#' + p.project_id);
    }
    const pickProjectId = () => {
        const v = String(projInp.value || '').trim();
        const m = v.match(/#(\d+)\s*$/);
        if (m)
            return Number(m[1]);
        const byName = projects.find((x) => x.name === v);
        return byName ? byName.id : null;
    };
    const repoSel = el('select', { style: psInputStyle });
    repoSel.append(el('option', { value: '', text: '— 고르세요 —' }));
    const repoNames = repos.map((r) => r.name).filter(Boolean);
    if (p && p.repo && !repoNames.includes(p.repo))
        repoNames.unshift(p.repo);
    for (const n of repoNames)
        repoSel.append(el('option', { value: n, text: n, ...((p && p.repo === n) ? { selected: true } : {}) }));
    const labelInp = el('input', { type: 'text', style: psInputStyle, value: (p && p.label) || '', placeholder: '비우면 자동으로 지어집니다' });
    // ── 고급(보통 그대로 두면 된다) ──
    const kindSel = el('select', { style: psInputStyle });
    for (const k of [['work', '내 작업 하나만 본다 (기본)'], ['stage', '여러 작업을 합쳐서 본다']])
        kindSel.append(el('option', { value: k[0], text: k[1], ...((p ? p.kind === k[0] : k[0] === 'work') ? { selected: true } : {}) }));
    const backingSel = el('select', { style: psInputStyle });
    for (const b of [['shared-proxy', '화면만 따로 띄운다 (기본·가장 가벼움)'], ['throwaway', '전용 서버까지 새로 띄운다'], ['existing-ref', '이미 떠 있는 주소로 연결한다']])
        backingSel.append(el('option', { value: b[0], text: b[1], ...((p ? p.backing_mode === b[0] : b[0] === 'shared-proxy') ? { selected: true } : {}) }));
    const stackSel = el('select', { style: psInputStyle });
    stackSel.append(el('option', { value: '', text: '자동 — 이 레포에 맞는 설정을 씁니다' }));
    for (const sp of profiles)
        stackSel.append(el('option', { value: sp.id, text: sp.label || sp.id, ...((p && p.stack_profile === sp.id) ? { selected: true } : {}) }));
    const backingRefInp = el('input', { type: 'text', style: psInputStyle, value: (p && p.backing_ref) || '', placeholder: 'http://localhost:8081' });
    const owner = memberCombo({ value: (p && p.owner_member) || '', placeholder: '구성원 선택 (선택 사항)' });
    const wtInp = el('input', { type: 'text', style: psInputStyle, value: (p && p.worktree_path) || '', placeholder: '비워 두면 자동으로 만듭니다' });
    const ttlInp = el('input', { type: 'number', style: psInputStyle, value: (p && p.ttl_idle_sec) || '', placeholder: '0 = 계속 켜둠' });
    // 합쳐서 볼 작업(브랜치) — 외워서 타이핑하지 않고 **고른다**. 레포를 고르면 그 레포의 브랜치를 최근 순으로 읽어 온다.
    const picked = new Set((p && Array.isArray(p.member_branches)) ? p.member_branches : []);
    let branchOpts = [], branchState = 'idle', branchRepo = '';
    const branchFilter = el('input', { type: 'search', style: psInputStyle + ';margin-bottom:6px', placeholder: '브랜치 검색' });
    const branchList = el('div', { style: 'max-height:210px;overflow:auto;border:1px solid rgba(127,127,127,.22);border-radius:6px;padding:4px' });
    const baseRefSel = el('select', { style: psInputStyle });
    const hintRow = (t) => el('div', { class: 'ps-block-hint', style: 'padding:6px 4px' }, ...uiText(t));
    function renderBranchList() {
        const q = branchFilter.value.trim().toLowerCase();
        if (!branchRepo) {
            branchList.replaceChildren(hintRow('먼저 위에서 코드 저장소를 골라 주세요.'));
            return;
        }
        if (branchState === 'loading') {
            branchList.replaceChildren(hintRow('브랜치를 불러오는 중…'));
            return;
        }
        if (branchState === 'error') {
            branchList.replaceChildren(hintRow('브랜치를 불러오지 못했습니다 — 저장소 연결을 확인해 주세요.'));
            return;
        }
        const names = branchOpts.map((b) => b.name);
        const extra = [...picked].filter((n) => !names.includes(n)).map((n) => ({ name: n, missing: true })); // 저장돼 있지만 지금 목록에 없는 것
        const rows = [...extra, ...branchOpts].filter((b) => !q || b.name.toLowerCase().includes(q));
        if (!rows.length) {
            branchList.replaceChildren(hintRow(q ? '검색 결과가 없습니다.' : '이 저장소에 브랜치가 없습니다.'));
            return;
        }
        branchList.replaceChildren(...rows.slice(0, 300).map((b) => {
            const cb = el('input', { type: 'checkbox', ...(picked.has(b.name) ? { checked: true } : {}) });
            cb.onchange = () => { if (cb.checked)
                picked.add(b.name);
            else
                picked.delete(b.name); };
            const meta = [b.missing ? '지금 목록에 없음' : null, b.updated_at ? relTime(b.updated_at) : null, b.author].filter(Boolean).join(' · ');
            return el('label', { class: 'inline', style: 'display:flex;gap:8px;align-items:center;padding:4px 6px;border-radius:4px;cursor:pointer' }, cb, el('span', { style: 'flex:1;min-width:0' }, el('span', { class: 'mono', style: 'font-size:12px', text: b.name }), meta ? el('span', { class: 'ps-block-hint', style: 'margin:0 0 0 8px;display:inline' }, ...uiText(meta)) : null));
        }));
    }
    function renderBaseRef() {
        const cur = baseRefSel.value || (p && p.base_ref) || '';
        baseRefSel.replaceChildren(el('option', { value: '', text: '기본 — origin/main' }));
        const seen = new Set(['']);
        for (const b of branchOpts) {
            const v = 'origin/' + b.name;
            if (seen.has(v))
                continue;
            seen.add(v);
            baseRefSel.append(el('option', { value: v, text: v }));
        }
        if (cur && !seen.has(cur))
            baseRefSel.append(el('option', { value: cur, text: cur })); // 저장된 값이 목록에 없어도 유지
        baseRefSel.value = cur;
    }
    async function loadBranches() {
        const repo = repoSel.value.trim();
        if (!repo || repo === branchRepo) {
            renderBranchList();
            return;
        }
        branchRepo = repo;
        branchState = 'loading';
        branchOpts = [];
        renderBranchList();
        try {
            const r = await api('/api/ui/repos/' + encodeURIComponent(repo) + '/branches');
            branchOpts = (r && r.branches) || [];
            branchState = 'ok';
        }
        catch (_) {
            branchState = 'error';
        }
        renderBranchList();
        renderBaseRef();
    }
    branchFilter.addEventListener('input', renderBranchList);
    // 브랜치는 '여러 작업을 합쳐서 본다'일 때만 필요하다 — 그때(또는 저장소를 바꿀 때)만 읽는다.
    repoSel.addEventListener('change', () => { if (kindSel.value === 'stage')
        void loadBranches(); });
    kindSel.addEventListener('change', () => { if (kindSel.value === 'stage')
        void loadBranches(); });
    renderBranchList();
    renderBaseRef();
    if (p && p.kind === 'stage' && repoSel.value)
        void loadBranches();
    const triggerSel = el('select', { style: psInputStyle });
    for (const t of [['manual', '내가 누를 때만 다시 합친다 (기본)'], ['auto', '작업이 바뀌면 자동으로 다시 합친다']])
        triggerSel.append(el('option', { value: t[0], text: t[1], ...((p && p.merge_trigger === t[0]) ? { selected: true } : {}) }));
    const enabledChk = el('input', { type: 'checkbox', ...((p ? p.enabled : true) ? { checked: true } : {}) });
    const noteInp = el('input', { type: 'text', style: psInputStyle, value: (p && p.note) || '' });
    const advanced = el('details', { class: 'ps-block' }, el('summary', { style: 'cursor:pointer;font-weight:600;padding:6px 0', text: '고급 설정 — 보통은 그대로 두면 됩니다' }), psBlock('보는 방식', '여러 사람의 작업을 한 화면에서 함께 보려면 바꾸세요.', kindSel), psBlock('어떻게 띄울까', '기본은 화면만 따로 띄웁니다. 서버 동작까지 확인해야 하면 전용 서버를, 이미 띄워 둔 게 있으면 그 주소를 쓰세요.', backingSel), psBlock('실행 설정', '‘전용 서버까지 새로 띄운다’일 때 어떤 방식으로 띄울지. 비우면 이 레포에 맞는 설정을 자동으로 씁니다.', stackSel), psBlock('연결할 주소', '‘이미 떠 있는 주소로 연결한다’일 때만 씁니다.', backingRefInp), psBlock('합쳐서 볼 작업들', '이 저장소의 작업(브랜치) 중 함께 볼 것을 고르세요. 서로 충돌하는 작업은 자동으로 빼고 나머지를 합칩니다.', el('div', {}, branchFilter, branchList)), psBlock('합치는 기준', '이 기준 위에 위에서 고른 작업들을 얹습니다.', baseRefSel), psBlock('다시 합치는 시점', '', triggerSel), psBlock('담당자', '이 미리보기의 주인(참고용).', owner.el), psBlock('작업 폴더 경로', '직접 지정할 때만 씁니다. 비우면 프로젝트에 맞춰 자동으로 만듭니다.', wtInp), psBlock('안 보면 자동으로 끄기 (초)', '이 시간 동안 아무도 열지 않으면 자동으로 끕니다. 0이면 계속 켜둡니다.', ttlInp), psBlock('사용', '', el('label', { class: 'inline' }, enabledChk, el('span', { text: ' 이 미리보기를 사용합니다' }))), psBlock('메모', '', noteInp), ...(p ? [psBlock('주소', '팀원에게 이 주소를 보내면 됩니다.', el('div', { class: 'mono', text: '/preview/' + p.id + '/' }))] : []));
    const saveBtn = el('button', { class: 'btn btn-primary btn-sm', text: isNew ? '만들고 띄우기' : '저장' });
    const form = el('div', { class: 'proj-settings' }, psBlock('어떤 작업을 미리볼까요?', '작업 중인 프로젝트를 고르세요. 필요한 작업 폴더가 없으면 자동으로 만들어 줍니다.', projInp), projList, psBlock('어느 코드 저장소인가요?', '', repoSel), psBlock('이름 (선택)', '목록에서 알아보기 쉬운 이름. 비우면 자동으로 지어집니다.', labelInp), advanced, el('div', { class: 'ps-rules-actions' }, saveBtn));
    const back = overlayBox(isNew ? '미리보기 만들기' : '미리보기 설정', form);
    const boxw = back.querySelector('.ov-box');
    if (boxw)
        boxw.classList.add('ov-box-wide');
    saveBtn.onclick = async () => {
        const kind = kindSel.value, backing_mode = backingSel.value;
        const repo = repoSel.value.trim();
        const project_id = pickProjectId();
        const branches = kind === 'stage' ? [...picked] : [];
        if (!repo) {
            toast('어느 코드 저장소를 볼지 골라 주세요', true);
            return;
        }
        if (kind === 'work' && !project_id && !wtInp.value.trim()) {
            toast('어떤 작업을 미리볼지(프로젝트) 골라 주세요', true);
            return;
        }
        if (kind === 'stage' && !branches.length) {
            toast('합쳐서 볼 작업을 한 개 이상 골라 주세요 (고급 설정)', true);
            return;
        }
        if (kind === 'work' && backing_mode === 'existing-ref' && !backingRefInp.value.trim()) {
            toast('연결할 주소를 입력해 주세요 (고급 설정)', true);
            return;
        }
        const body = {
            ...(p ? { id: p.id } : {}), kind, backing_mode, repo, project_id,
            label: labelInp.value.trim() || null, owner_member: owner.value() || null,
            worktree_path: wtInp.value.trim() || null, ttl_idle_sec: ttlInp.value ? Number(ttlInp.value) : null,
            enabled: enabledChk.checked, note: noteInp.value.trim() || null,
            stack_profile: stackSel.value || null, backing_ref: backingRefInp.value.trim() || null,
            ...(kind === 'stage' ? { member_branches: branches, base_ref: baseRefSel.value.trim() || null, merge_trigger: triggerSel.value } : {}),
        };
        saveBtn.disabled = true;
        try {
            const saved = await api('/api/ui/preview-envs', { method: 'POST', body: JSON.stringify(body) });
            const id = (saved && saved.env && saved.env.id) || (p && p.id);
            if (isNew && id) {
                // 만들자마자 준비를 시작한다 — 사람이 '띄우기'를 한 번 더 누르지 않아도 되게.
                await api('/api/ui/preview-envs/' + encodeURIComponent(id) + '/ensure', { method: 'POST' }).catch(() => { });
                toast('만들었습니다 — 화면을 준비하고 있습니다');
            }
            else
                toast('저장했습니다');
            back.remove();
            reload();
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            saveBtn.disabled = false;
        }
    };
}
async function previewEnsure(id, reload) {
    try {
        const r = await api('/api/ui/preview-envs/' + encodeURIComponent(id) + '/ensure', { method: 'POST' });
        const s = r && r.status;
        if (s === 'running')
            toast('준비됐습니다 — ‘화면 열기’로 확인하세요');
        else if (s === 'preparing')
            toast('준비를 시작했습니다 — 끝나면 목록에 자동으로 표시됩니다');
        else
            toast((r && r.error) || '띄우지 못했습니다', true);
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
async function previewStop(id, reload) {
    try {
        await api('/api/ui/preview-envs/' + encodeURIComponent(id) + '/stop', { method: 'POST' });
        toast('껐습니다');
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
async function previewDelete(id, reload) {
    if (!confirm('이 미리보기를 삭제할까요?\n작업 폴더와 코드는 그대로 남습니다.'))
        return;
    try {
        await api('/api/ui/preview-envs/' + encodeURIComponent(id) + '/delete', { method: 'POST' });
        toast('삭제했습니다');
        reload();
    }
    catch (e) {
        toast('실패 — ' + e.message, true);
    }
}
export { previewEnvsPanel, };

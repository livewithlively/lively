// projects/detail-local-work.ts — #1405 W1: detail-sections.ts 분할 ①.
//  '내 컴퓨터에서 작업' 모달 한 벌 — 레포·경로·워크트리·하네스를 고르면 `lively run <id> …` 한 줄을 만들어 준다.
//   · openLocalWorkModal(폼) · renderLocalWorkCommand(명령 렌더) · copyText(클립보드 폴백)
//  본문은 원문 그대로 옮겼다(verbatim) — 바뀐 건 파일 경계와 import/export 뿐.
import { api, el, toast } from '../core.js';
import { overlayBox } from '../learn.js';
// ── '내 컴퓨터에서 작업' 모달 — 담당자가 본인 PC에서 이 프로젝트를 작업하도록 시작 명령을 만들어 준다. ──
//  웹은 원격 PC 터미널을 보지 않는다(스트리밍 X). 각자 자기 PC에서 터미널을 열어 쓰고, 웹은 '어떻게 시작하는지'만
//  쉽고 상세히 안내한다. 모달에서 레포·경로·워크트리·하네스를 고르면 `node ~/.lively/work.mjs <id> …` 한 줄을
//  로컬에서 만들어 준다(renderLocalWorkCommand) — work.mjs 가 공유폴더 pull·레포·.lively 마커·실행까지 자동.
function openLocalWorkModal(id, p, opts) {
    const form = el('div', { class: 'proj-settings lw' });
    const back = overlayBox('💻 내 컴퓨터에서 작업 — ' + p.name, form);
    const box = back.querySelector('.ov-box');
    if (box)
        box.classList.add('ov-box-wide');
    const inputStyle = 'width:100%;padding:6px 8px;font:inherit;box-sizing:border-box';
    const block = (title, hint, ...controls) => el('section', { class: 'ps-block' }, el('h3', { class: 'ps-block-title', text: title }), hint ? el('p', { class: 'ps-block-hint', text: hint }) : null, ...controls);
    // 하네스
    const harnessSel = el('select', { style: inputStyle });
    harnessSel.append(el('option', { value: 'claude', text: 'Claude Code' }), el('option', { value: 'codex', text: 'Codex' }));
    if (opts && opts.harness && ['claude', 'codex'].includes(opts.harness))
        harnessSel.value = opts.harness; // '클로드로 실행' 기본값 선주입
    // 모델 · 자동승인 — 웹 터미널 카탈로그(/api/ui/terminal/config) 재사용(하네스별 모델·autoApprove 동일 규칙).
    const modelSel = el('select', { style: inputStyle });
    const modelBlock = block('모델', '비우면 하네스 기본 모델.', modelSel);
    const autoChk = el('input', { type: 'checkbox' });
    if (opts)
        autoChk.checked = !!opts.autoApprove; // '클로드로 실행' 기본값 선주입
    const autoBlock = el('section', { class: 'ps-block' }, el('h3', { class: 'ps-block-title', text: '자동 승인' }), el('label', { style: 'display:flex;gap:8px;align-items:center;cursor:pointer' }, autoChk, el('span', { text: '권한 확인 건너뛰기 (claude --dangerously-skip-permissions / codex --yolo) — 내 PC에서 실행되니 주의' })));
    const harnessCat = {}; // {claude:{models:[...],hasAuto}, codex:{...}}
    const updateModels = () => {
        const cat = harnessCat[harnessSel.value] || { models: [], hasAuto: true };
        const cur = modelSel.value;
        modelSel.replaceChildren(el('option', { value: '', text: '기본' }));
        (cat.models || []).forEach((m) => { if (m)
            modelSel.append(el('option', { value: m, text: m })); });
        if ((cat.models || []).includes(cur))
            modelSel.value = cur;
        autoBlock.style.display = cat.hasAuto === false ? 'none' : '';
        regen();
    };
    harnessSel.addEventListener('change', updateModels);
    const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
    const pathKey = (repo) => 'lively:workpath:' + repo;
    const savedPath = (repo) => { try {
        return repo ? (localStorage.getItem(pathKey(repo)) || '') : '';
    }
    catch (_) {
        return '';
    } };
    modelSel.addEventListener('change', () => regen());
    autoChk.addEventListener('change', () => regen());
    // ── 레포 N개(반복 행) — 각 행: 레포 선택 + 내 PC 경로 + 워크트리/브랜치. cloneUrlByRepo 로 git 주소 채움. ──
    const cloneUrlByRepo = {};
    const reposWrap = el('div', {});
    let rows = [];
    const repoNames = () => Object.keys(cloneUrlByRepo);
    const fillSel = (sel) => {
        const cur = sel.value;
        sel.replaceChildren(el('option', { value: '', text: '— 코드 저장소 선택 —' }));
        repoNames().forEach((n) => sel.append(el('option', { value: n, text: n })));
        if (repoNames().includes(cur))
            sel.value = cur;
    };
    const addRow = (initRepo = '') => {
        const sel = el('select', { style: inputStyle });
        const pathInp = el('input', { type: 'text', style: inputStyle, placeholder: '예) ~/dev/<레포> · Windows: C:\\Users\\..\\<레포> (비우면 기본 경로에 clone)' });
        const wtChk = el('input', { type: 'checkbox' });
        wtChk.checked = !(opts && opts.worktree === false); // '클로드로 실행' 기본값 선주입
        const branchInp = el('input', { type: 'text', style: inputStyle, value: (opts && opts.branch) || ('project/' + id) });
        const rmBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '✕ 제거' });
        fillSel(sel);
        if (initRepo)
            sel.value = initRepo;
        pathInp.value = savedPath(sel.value);
        const branchWrap = el('div', { style: 'margin-top:6px' }, el('p', { class: 'ps-block-hint', style: 'margin:0 0 2px', text: '브랜치' }), branchInp);
        const branchVis = () => { branchWrap.style.display = wtChk.checked ? '' : 'none'; };
        const rowObj = { sel, pathInp, wtChk, branchInp };
        rows.push(rowObj);
        sel.addEventListener('change', () => { pathInp.value = savedPath(sel.value); regen(); });
        pathInp.addEventListener('input', () => regen());
        pathInp.addEventListener('change', () => { if (sel.value && pathInp.value.trim()) {
            try {
                localStorage.setItem(pathKey(sel.value), pathInp.value.trim());
            }
            catch (_) { /* */ }
        } regen(); });
        wtChk.addEventListener('change', () => { branchVis(); regen(); });
        branchInp.addEventListener('input', () => regen());
        const rowEl = el('section', { class: 'ps-block', style: 'border:1px solid rgba(127,127,127,.18);border-radius:8px;padding:10px;margin-top:8px' }, el('div', { style: 'display:flex;gap:8px;align-items:center' }, sel, rmBtn), el('div', { style: 'margin-top:6px' }, el('p', { class: 'ps-block-hint', style: 'margin:0 0 2px', text: '내 PC 경로' }), pathInp), el('label', { style: 'display:flex;gap:8px;align-items:center;cursor:pointer;margin-top:6px' }, wtChk, el('span', { text: '워크트리 생성 (전용 브랜치로 격리)' })), branchWrap);
        rowObj.el = rowEl;
        rmBtn.onclick = () => { rowEl.remove(); rows = rows.filter((r) => r !== rowObj); regen(); };
        branchVis();
        reposWrap.append(rowEl);
        regen();
    };
    const addRepoBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '+ 레포 추가', onclick: () => addRow() });
    // 카탈로그(모델·자동승인) 로드
    (async () => {
        try {
            const cfg = await api('/api/ui/terminal/config');
            ((cfg && cfg.harnesses) || []).forEach((h) => { const mf = (h.flags || []).find((f) => f.name === '--model'); harnessCat[h.key] = { models: (mf && mf.choices) || [], hasAuto: !!h.hasAutoApprove }; });
        }
        catch (_) { /* graceful */ }
        updateModels();
        if (opts && opts.model && (harnessCat[harnessSel.value] || { models: [] }).models.includes(opts.model)) {
            modelSel.value = opts.model;
            regen();
        } // '클로드로 실행' 기본값 선주입
    })();
    // 레포 목록(git 주소 포함) 로드 → 행 셀렉트 채움 + 기본 1행.
    (async () => {
        try {
            const r = await api('/api/ui/repos');
            ((r && r.domainmapRepos) || []).forEach((it) => { if (it && it.name)
                cloneUrlByRepo[it.name] = it.clone_url || ''; });
        }
        catch (_) { /* graceful: 레포 없음 */ }
        rows.forEach((ro) => fillSel(ro.sel));
        if (!rows.length) {
            // 이 프로젝트에 매핑된 레포(관련 레포)를 기본 행으로 — 없으면 레포가 하나뿐일 때만 자동 선택. (opts.repos = '클로드로 실행' 기본값 선주입)
            const pre = ((opts && opts.repos) || (p && p.repos) || []).filter((n) => repoNames().includes(n));
            if (pre.length)
                pre.forEach((n) => addRow(n));
            else
                addRow(repoNames().length === 1 ? repoNames()[0] : '');
        }
        regen();
    })();
    // ── 명령 — 입력이 바뀔 때마다 자동 재생성(live). 0레포=공유폴더만 / 1=가독 플래그 / N=--repos base64. ──
    const guideWrap = el('div', { class: 'lw-guide' });
    function regen() {
        const parts = [id, '--harness ' + harnessSel.value];
        if (modelSel.value)
            parts.push('--model ' + modelSel.value);
        if (autoChk.checked)
            parts.push('--auto-approve');
        const specs = rows.map((r) => ({ name: r.sel.value, path: r.pathInp.value.trim(), worktree: r.wtChk.checked, branch: r.branchInp.value.trim(), gitUrl: r.sel.value ? (cloneUrlByRepo[r.sel.value] || '') : '' })).filter((s) => s.name);
        let hasUrl = true;
        if (specs.length === 1) {
            const s = specs[0];
            if (s.path)
                parts.push('--repo-path ' + q(s.path));
            if (s.worktree) {
                parts.push('--worktree');
                if (s.branch)
                    parts.push('--branch ' + q(s.branch));
            }
            if (s.gitUrl)
                parts.push('--git-url ' + q(s.gitUrl));
            else
                hasUrl = false;
        }
        else if (specs.length > 1) {
            const json = JSON.stringify(specs);
            parts.push('--repos ' + q(btoa(unescape(encodeURIComponent(json))))); // base64(UTF-8 JSON) — N레포 안전 인코딩
            hasUrl = specs.every((s) => !!s.gitUrl);
        }
        renderLocalWorkCommand(guideWrap, parts.join(' '), { repo: specs.length ? specs[0].name : '', hasUrl, multi: specs.length > 1 });
    }
    form.append(el('p', { class: 'ps-block-hint', text: '값을 바꾸면 아래 명령이 자동으로 갱신됩니다. 내 PC 터미널에 붙여넣어 실행하세요 — 한 번 실행하면 공유 폴더·코드 준비·실행까지 자동, 재실행해도 안전(늘 이 명령으로 접속).' }), block('AI 코딩 에이전트', '내 PC에서 사용할 하네스를 고르세요.', harnessSel), modelBlock, autoBlock, block('사용할 레포 (여러 개 가능)', '코드 레포를 선택하고 내 PC 경로를 적으세요. 비개발자는 레포 행을 모두 제거하면 공유 폴더만 받습니다.', reposWrap, el('div', { style: 'margin-top:8px' }, addRepoBtn)), guideWrap);
    regen();
}
// 클립보드 복사 — http(비보안 컨텍스트)에선 navigator.clipboard 가 막히므로 execCommand 폴백 + 수동선택 안내.
function copyText(text) {
    const fallback = () => {
        try {
            const t = document.createElement('textarea');
            t.value = text;
            t.style.position = 'fixed';
            t.style.top = '-1000px';
            t.style.opacity = '0';
            document.body.appendChild(t);
            t.focus();
            t.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(t);
            toast(ok ? '복사됨' : '복사 실패 — 명령을 직접 드래그해 복사하세요', !ok);
        }
        catch (_) {
            toast('복사 실패 — 명령을 직접 드래그해 복사하세요', true);
        }
    };
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => toast('복사됨'), fallback);
            return;
        }
    }
    catch (_) { /* */ }
    fallback();
}
// 만든 명령을 렌더 — #864 부터 **한 줄**이다(`lively run <프로젝트번호> …`).
//  종전엔 OS별로 두 벌을 보여줬다: `node ~/.lively/work.mjs …` 와 `node "$env:USERPROFILE\.lively\work.mjs" …`.
//  갈라진 이유는 오직 홈 경로 표기(윈도우 셸은 ~ 를 확장하지 않는다)였는데, CLI 가 PATH 에 있으니 그 문제가 사라졌다.
//  엔진은 그대로 work.mjs — `lively run` 이 인자를 그대로 넘긴다.
function renderLocalWorkCommand(wrap, argStr, info) {
    const cmd = 'lively run ' + argStr;
    const copyBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '복사' });
    copyBtn.onclick = () => copyText(cmd);
    const notes = ['내 PC 터미널에 붙여넣어 실행하세요 (Mac · Windows 동일).'];
    if (info && info.repo && !info.hasUrl)
        notes.push('※ 이 레포는 git 주소 미설정 — --git-url 없음. 입력 경로에 레포가 이미 있어야 함(없으면 관리탭 ▸ 레포(git) 관리에서 git 주소 연결).');
    // #1155 — 종전엔 레포 준비가 실패하면 이 명령으로는 세션을 아예 못 띄웠다. 이제 뜨고, 실패 사실이 세션에도 전달된다.
    if (info && info.repo)
        notes.push('※ 레포를 못 가져와도(자격·네트워크 등) 세션은 시작됩니다 — 무엇이 왜 실패했는지 터미널과 AI 세션에 함께 안내되고, 세션 안에서 `lively repo worktree <레포>` 로 복구할 수 있어요.');
    notes.push("※ 'lively: command not found' 가 나오면 아직 라이블리를 설치하지 않은 거예요 — [사용 가이드 ▸ 내 AI 세션 생성] 을 먼저 따라 하세요.");
    notes.push('복사가 안 되면(보안 컨텍스트 아님) 명령을 직접 드래그해 복사하세요.');
    wrap.replaceChildren(el('div', { style: 'margin-top:14px;border-top:1px solid rgba(127,127,127,.18);padding-top:12px' }, el('h3', { class: 'ps-block-title', text: '내 PC에서 실행' }), el('div', { style: 'display:flex;gap:8px;align-items:flex-start;margin-top:8px' }, el('pre', { style: 'flex:1;margin:0;padding:8px 10px;background:rgba(127,127,127,.1);border-radius:6px;overflow:auto;font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-all;line-height:1.5;user-select:all' }, el('code', { text: cmd })), copyBtn), ...notes.map((n) => el('p', { class: 'ps-block-hint', text: n }))));
}
export { copyText, openLocalWorkModal };

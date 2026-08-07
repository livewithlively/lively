// terminal/session-form.ts — 세션 **생성·수정 폼**과 그 부속: 실행 설정 기억(#673/#782) · 초대 피커 · 노드 관리 · 로그인 배너/프로필 안내.
//  소비자: terminal/{session-list,routes}.ts + 프로젝트·대시보드 탭(배럴 terminal.ts 경유).
//  import 방향: select-bar(아래층)만 본다. 목록 재렌더는 routes.ts 를 직접 import 하지 않고 아래 훅으로 부른다(순환 방지).
import { api, appUrl, el, infoPop, personFace, state, toast, visAxisOn } from '../core.js';
import { field, overlay } from '../admin.js';
import { isTourActive } from '../tour.js';
import { termUrl } from './select-bar.js';
// ── 목록 재렌더 훅 — 폼·다이얼로그가 끝난 뒤 세션 목록을 다시 그리는 통로 ──
//  renderTerminal(terminal/routes.ts)을 여기서 import 하면 routes→session-form→routes 순환이 된다(게이트가 막는다).
//  대신 routes.ts 가 로드 시 setTerminalRerender(renderTerminal) 로 자기를 등록하고, 아래 폼들은 종전과 똑같이
//  renderTerminal(view) 를 부른다 — 그 이름이 이 파일 안에서 훅으로 해소될 뿐 호출부는 한 글자도 바뀌지 않았다.
let _renderTerminal = () => { };
export function setTerminalRerender(fn) { _renderTerminal = fn; }
function renderTerminal(view) { _renderTerminal(view); }
// 새 세션 폼 '실행 설정' 기억(#673) — 마지막으로 쓴 하네스 + 플래그(모델·effort) + 자동 승인(#782)을 저장해 다음 생성 때 복원.
//  #782 키를 사용자별로 나눈다 — 한 브라우저를 여러 계정이 쓰면 남이 켠 자동 승인이 내 기본값이 되면 안 된다.
//  옛 전역 키는 내 키가 없을 때만 폴백으로 읽어 하네스·모델 기억을 잇는다(자동 승인은 그 시절 저장하지 않았으므로 항상 꺼진 채 시작).
const TERM_CREATE_PREFS_KEY = 'lively_term_create_prefs';
const termCreatePrefsKey = () => TERM_CREATE_PREFS_KEY + '::' + ((state.me && (state.me.userId || state.me.email)) || 'anon');
function termCreatePrefs() {
    try {
        const raw = localStorage.getItem(termCreatePrefsKey()) || localStorage.getItem(TERM_CREATE_PREFS_KEY) || '{}';
        const p = JSON.parse(raw);
        return (p && typeof p === 'object') ? p : {};
    }
    catch (_) {
        return {};
    }
}
function saveTermCreatePrefs(p) { try {
    localStorage.setItem(termCreatePrefsKey(), JSON.stringify(p));
}
catch (_) { /* noop */ } }
// 자동 승인(--dangerously-skip-permissions)의 기본값 — 기본은 꺼짐, 내가 마지막으로 켰을 때만 켠 채로 복원(#782).
function termAutoApprovePref() { return termCreatePrefs().autoApprove === true; }
// 작업자(작성자) = 로그인 사용자. 서버가 토큰으로 owner 를 강제하므로 표시 전용(타인 선택 불가).
function memberName(cfg, id) {
    const m = ((cfg && cfg.members) || []).find((x) => x.id === id);
    return (m && m.name) || id || '';
}
// 구성원 격리(#524) — 이 세션의 claude 가 '내 격리 계정(box_)'으로 뜨는지 안내. box_ 격리가 #346 멀티프로필을 대체.
//  게이트웨이는 box_ 700 홈을 못 읽어 '로그인됨' 여부를 알 수 없으므로(격리의 본질), 로그인 안내를 상시 노출.
function profileNoteEl(cfg) {
    const os = (cfg && cfg.os) || {};
    if (os.ready) {
        const who = os.osUser || 'box_…';
        if (os.provisioned && os.loggedIn)
            return el('div', { class: 'caption', text: '🔐 내 AI 세션은 내 격리 계정(' + who + ')으로 실행됩니다 — 자격증명이 구성원 간 격리됩니다.' });
        if (os.provisioned)
            return el('div', { class: 'caption', text: '🔐 내 격리 계정(' + who + ') · Claude 로그인 전입니다 — 세션에서  claude  실행 후 /login (한 번만).' });
        return el('div', { class: 'caption', text: '🔐 첫 세션을 열면 내 격리 계정(' + who + ')이 자동 생성돼 격리 실행됩니다. 세션에서  claude  실행 후 /login 하세요.' });
    }
    // 격리 인프라 미설치 = 비격리(공유) — 레거시 #346 멀티프로필 안내(폴백).
    const p = (cfg && cfg.profile) || {};
    if (!p.multiprofile)
        return null;
    if (p.active)
        return el('div', { class: 'caption', text: '🔐 이 AI 세션은 내 Claude 계정(프로필 로그인됨)으로 실행됩니다.' });
    // '내 프로필'이라 부르면 우상단 [내 프로필](표시이름·아바타 편집)과 겹쳐 엉뚱한 데를 누르게 된다 —
    //  여기서 말하는 건 AI 가 돌아가는 격리 계정(관리탭 [구성원 ▸ AI 실행 계정])이다. 그 이름으로 부른다(#837).
    if (p.provisioned)
        return el('div', { class: 'caption', text: '⚠ 내 AI 실행 계정이 아직 로그인 안 돼 공유 계정으로 실행됩니다 — 상단 [내 계정 로그인] 버튼으로 한 번 로그인하세요.' });
    return el('div', { class: 'caption', text: '⚠ 공유 계정으로 실행됩니다(구성원 격리 미설치). 박스에서 deploy/linux/install-isolation.sh 실행 시 구성원별 격리가 켜집니다.' });
}
// 최초 로그인 세션 — loginProfile 로 게이트를 우회해 내 프로필 dir 로 claude 를 띄운다(닭-달걀 해소). 새 탭으로 열어 로그인.
async function openLoginSession(view) {
    try {
        const out = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify({
                label: '내 계정 로그인', rootKey: 'personal', subpath: '', harness: 'claude', flags: {}, autoApprove: false, loginProfile: true,
            }) });
        toast('로그인 터미널을 열었습니다 — 뜨는 claude 에서 로그인을 진행하세요');
        if (out && out.session)
            window.open(appUrl('/ui/terminal.html?session=') + encodeURIComponent(out.session.id) + '&label=' + encodeURIComponent(out.session.label || ''), '_blank');
        renderTerminal(view);
    }
    catch (e) {
        toast('로그인 터미널 열기 실패 — ' + e.message, true);
    }
}
// 상단 '내 계정 로그인' 버튼 — 개인 claude 세션을 열어 거기서 로그인. box_ 격리면 그 세션이 내 격리 계정(box_)으로
//  떠서 로그인이 box_ 홈에 저장돼 이후 내 세션에 재사용된다. 게이트웨이가 box_ 로그인 여부를 못 봐서(격리) 상시 노출.
function loginBannerEl(cfg, view) {
    const os = (cfg && cfg.os) || {};
    if (os.ready) {
        if (os.loggedIn)
            return null; // 이미 로그인됨(box_ creds 존재) → 버튼 숨김
        return el('div', { class: 'card' }, el('button', { class: 'btn btn-primary btn-sm', text: '🔑 내 계정 로그인', onclick: () => openLoginSession(view) }), el('span', { class: 'caption', text: '  처음 한 번 — 개인 세션을 열어 claude 에서 /login (이후 내가 만드는 세션은 내 격리 계정으로 뜹니다).' }));
    }
    // 레거시 비격리(#346): 프로필 프로비저닝됐지만 미로그인일 때만.
    const p = (cfg && cfg.profile) || {};
    if (!p.multiprofile || !p.provisioned || p.loggedIn)
        return null;
    return el('div', { class: 'card' }, el('div', { class: 'caption', text: '⚠ 내 Claude 계정이 아직 로그인되지 않았습니다. 한 번 로그인하면 이후 내가 만드는 세션은 내 계정으로 뜹니다.' }), el('button', { class: 'btn btn-primary', text: '내 계정 로그인', onclick: () => openLoginSession(view) }));
}
// 라벨 옆 ⓘ 로 설명을 접는 필드(#1145) — 회색 캡션을 한 줄 더 늘리면 폼만 길어지고 정작 안 읽힌다.
//  관리탭 카드 제목(cardHead)과 같은 infoPop 이라 '이 아이콘은 설명'이라는 감각이 화면 사이에서 이어진다.
//  본문은 .hint-pop-text 가 white-space:pre-line 이라 \n 이 그대로 줄바꿈되고, **강조** 는 uiText 가 굵게 만든다.
function fieldInfo(label, tip, control) {
    return el('div', { class: 'field' }, el('div', { class: 'field-label-row' }, el('label', { class: 'field-label', text: label }), infoPop(tip)), control);
}
// 새 세션 — 기본 비공개. 초대 피커에서 멤버를 고르면 그 사람도 보고 열 수 있다.
// onCreated(out) — 있으면 생성 후 그걸 호출(대시보드에서 재사용: 세션 위젯 새로고침). 없으면 터미널 뷰 재렌더.
function openTermCreateForm(cfg, view, onCreated) {
    const roots = cfg.roots || [];
    const harnesses = cfg.harnesses || [];
    const prefs = termCreatePrefs();
    const labelI = el('input', { class: 'term-input', type: 'text', placeholder: '예: 랜딩 카피 수정' });
    // #853 작업 위치 = 공유/개인 2택 → 드롭다운 대신 세그먼트 토글(둘 중 하나를 명확히 고르게). 아래 '폴더'는 이 안의 하위 폴더.
    let rootKey = (roots[0] && roots[0].key) || 'personal';
    const rootBtns = {};
    const rootDesc = { shared: '팀과 함께 쓰는 폴더', personal: '나만 쓰는 폴더' };
    const rootIco = { shared: '👥', personal: '🔒' };
    // #853 작업 위치 = 2택 선택 카드(.mode-card 언어) — 아이콘·제목·부제 + 라디오 점. 진한 파란블록 대신 연한 강조.
    const rootSeg = el('div', { class: 'term-seg' }, ...roots.map((r) => {
        const b = el('button', { class: 'term-seg-btn', type: 'button' }, el('span', { class: 'term-seg-ico', text: rootIco[r.key] || '📁' }), el('span', { class: 'term-seg-txt' }, el('span', { class: 'term-seg-lbl', text: r.label }), rootDesc[r.key] ? el('span', { class: 'term-seg-sub', text: rootDesc[r.key] }) : null), el('span', { class: 'term-seg-check' }));
        b.onclick = () => { if (rootKey === r.key)
            return; rootKey = r.key; for (const k in rootBtns)
            rootBtns[k].classList.toggle('active', k === rootKey); pickerPath = ''; paintPicker(); }; // #869 노드 모드면 원격경로 유지(paintPicker), 폴더 모드면 loadPicker
        rootBtns[r.key] = b;
        return b;
    }));
    if (rootBtns[rootKey])
        rootBtns[rootKey].classList.add('active');
    const pickerBox = el('div', { class: 'term-picker' });
    let pickerPath = '';
    // 실행 위치(#869) — 기본 중앙 컴퓨터. 후보는 **내가 등록한 노드 + 관리자가 공유로 지정한 노드**(#1540, 서버 필터).
    //  공유 노드는 남의 컴퓨터일 수 있으니 라벨에 표시한다. 오프라인 노드는 비활성(에이전트가 게이트웨이에
    //  연결돼 있어야 생성 가능 — 서버도 409 재검증).
    const nodes = cfg.nodes || [];
    const nodeSel = el('select', { class: 'term-input' }, el('option', { value: '' }, '중앙 컴퓨터 (기본)'), ...nodes.map((n) => {
        const o = el('option', { value: n.id }, '🖥 ' + (n.name || n.id) + (n.shared ? ' (공유)' : '') + (n.online ? '' : ' — 오프라인'));
        if (!n.online)
            o.disabled = true;
        return o;
    }));
    // 노드 폴더는 원격이라 게이트웨이 browse 로 못 훑는다(v1) — 루트(공유/개인) 기준 하위 경로를 직접 입력.
    const remoteSubI = el('input', { class: 'term-input', type: 'text', placeholder: '노드의 선택한 루트 기준 하위 경로 (비우면 루트)' });
    const paintPicker = () => {
        if (nodeSel.value)
            pickerBox.replaceChildren(remoteSubI, el('div', { class: 'caption', text: '노드 로컬 경로 — 노드 머신의 선택한 루트(공유/개인 워크스페이스) 기준입니다.' }));
        else
            loadPicker();
    };
    nodeSel.addEventListener('change', paintPicker);
    const harnessSel = el('select', { class: 'term-input' }, ...harnesses.map((h) => el('option', { value: h.key }, h.label)));
    const inviteBox = buildInvitePicker(cfg, new Set()); // 기본 비공개(아무도 선택 안 됨)
    // 한 줄 배치(#1145)는 인라인으로도 못 박는다 — styles 는 브라우저가 오래 캐시해 클래스 규칙만으로는
    //  '새 JS + 옛 CSS' 조합에서 레이아웃이 무너진다(실측). 클래스(.term-preset-row)는 그대로 두되 값은 여기서 확정.
    const flagsBox = el('div', { class: 'term-flags', style: 'display:flex;gap:10px;flex-wrap:wrap;flex:2 1 240px;min-width:0' });
    // 자동 승인은 기본 꺼짐이되, 내가 지난번에 켰다면 켠 채로 복원한다(#782 — 사용자별 기억).
    //  (#673 의 'git 워크트리에서 작업' 체크박스는 #918 에서 제거 — 서버측 근거가 사라졌다: terminal-sessions 참조.)
    const autoCb = el('input', { type: 'checkbox' });
    autoCb.checked = prefs.autoApprove === true;
    const autoWrap = el('label', { class: 'term-auto' }, autoCb, el('span', { text: ' 자동 승인 — 확인 없이 바로 실행해 빨라요. 공유 폴더에선 꺼 두는 걸 권해요.' }));
    // 라이블리 모드(#1007+) — 이 세션이 라이블리와 얼마나 상호작용하나. 기본 일반, prefs 에 기억하지 않음(매번 명시 — 보안 모드라 의도적).
    //  claude-code 만 동작(codex 는 정적 헤더 → renderFlags 에서 숨김). '어디서 실행할까요'(rootSeg)와 같은 term-seg 선택 카드로 통일 —
    //  체크박스용 term-auto 에 얹은 인라인 <select> 는 라벨이 줄바꿈되고 카드 UI 와 이질적이었다(디자인 통일 요청).
    let modeVal = 'normal';
    const modeOpts = [
        { key: 'normal', lbl: '일반', sub: '라이블리 읽기·쓰기' },
        { key: 'readonly', lbl: '읽기전용', sub: '읽되 쓰지 않음 · 기밀 작업' },
        { key: 'incognito', lbl: '인코그니토', sub: '라이블리 전혀 안 씀 · 클린룸' },
    ];
    const modeBtns = {};
    // 아이콘 없이 텍스트(제목·부제) + 라디오만 — 카드 구조·정렬은 term-seg 그대로(요청: 이모지 아이콘 제거).
    const modeSeg = el('div', { class: 'term-seg' }, ...modeOpts.map((m) => {
        const b = el('button', { class: 'term-seg-btn', type: 'button' }, el('span', { class: 'term-seg-txt' }, el('span', { class: 'term-seg-lbl', text: m.lbl }), el('span', { class: 'term-seg-sub', text: m.sub })), el('span', { class: 'term-seg-check' }));
        b.onclick = () => { if (modeVal === m.key)
            return; modeVal = m.key; for (const k in modeBtns)
            modeBtns[k].classList.toggle('active', k === modeVal); };
        modeBtns[m.key] = b;
        return b;
    }));
    modeBtns[modeVal].classList.add('active');
    const modeField = el('div', { 'data-tour': 'mode' }, field('라이블리 모드', modeSeg));
    // 기록 범위(#1291 v2) — 이 세션의 AI 가 **내 승인 없이** 만들 수 있는 맥락의 최대 공개범위.
    //  모드(읽기전용/인코그니토)와 직교한다: 모드는 '쓰나 마나', 이건 '쓴다면 누구에게 보이게'.
    //  기본은 '자동' — 실행 위치 폴더를 따른다(프로젝트 폴더면 그 프로젝트 범위, 그 밖은 전체 공개).
    let writeVisVal = '';
    const writeVisOpts = [
        { v: '', t: '자동', d: '실행 위치 따름 — 프로젝트 폴더면 그 프로젝트' },
        { v: 'open', t: '전체 공개', d: '조직 전체가 봄' },
        { v: 'audience', t: '프로젝트 범위', d: '그 프로젝트를 볼 수 있는 사람만' },
        { v: 'private', t: '나만', d: '나만 봄' },
    ];
    const writeVisBtns = [];
    // 카드 언어는 '라이블리 모드'(modeSeg)와 **같은 클래스**를 쓴다(#1145) — 종전의 term-seg-item/-t/-d/.on 은
    //  CSS 에 정의가 아예 없어 스타일이 하나도 안 먹었다(맨 버튼 4개). 4택이라 term-seg--wrap 으로 2×2 로 접는다.
    const writeVisSeg = el('div', { class: 'term-seg term-seg--wrap' }, ...writeVisOpts.map((o) => {
        const b = el('button', { class: 'term-seg-btn', type: 'button' }, el('span', { class: 'term-seg-txt' }, el('span', { class: 'term-seg-lbl', text: o.t }), el('span', { class: 'term-seg-sub', text: o.d })), el('span', { class: 'term-seg-check' }));
        b.onclick = (e) => {
            e.preventDefault();
            if (writeVisVal === o.v)
                return;
            writeVisVal = o.v;
            writeVisBtns.forEach((c, i) => c.classList.toggle('active', writeVisOpts[i].v === writeVisVal));
        };
        if (o.v === writeVisVal)
            b.classList.add('active');
        writeVisBtns.push(b);
        return b;
    }));
    const writeVisField = el('div', {}, fieldInfo('기록 범위', '이 세션의 AI 가 **내 승인 없이** 남길 수 있는 기록의 최대 공개 범위입니다.\n\n· **자동** — 실행 폴더를 따릅니다. 프로젝트 폴더면 그 프로젝트 범위, 그 밖은 전체 공개.\n· **전체 공개** — 조직 누구나 봅니다.\n· **프로젝트 범위** — 그 프로젝트를 볼 수 있는 사람만 봅니다.\n· **나만** — 나만 볼 수 있게 남깁니다.\n\n「라이블리 모드」가 **쓸지 말지**를 정한다면, 이건 **쓴다면 누구에게 보이게**를 정합니다.', writeVisSeg));
    // '실행 설정'(하네스·모델·effort) — 접이식 프리셋으로 묶어 세로를 아끼고, 이전 설정을 기억한다(#673). 기본 접힘.
    const presetSum = el('div', { class: 'term-preset-sum' });
    const presetChev = el('span', { class: 'term-preset-chev', text: '▾' });
    const presetToggle = el('button', { class: 'term-preset-toggle', type: 'button', 'data-tour': 'preset' }, presetSum, presetChev);
    // 실행(AI)·모델·추론강도는 짧은 드롭다운 셋 — 각자 한 줄을 차지할 이유가 없어 한 줄에 나란히 둔다(#1145).
    const presetBody = el('div', { class: 'term-preset-body', 'data-tour': 'model' }, el('div', { class: 'term-preset-row', style: 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start' }, el('div', { 'data-tour': 'harness', style: 'flex:1 1 120px;min-width:0' }, field('실행 (AI)', harnessSel)), flagsBox), profileNoteEl(cfg));
    let presetOpen = false;
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
            // 접힌 요약줄도 드롭다운과 같은 말로 — 라벨은 '추론강도', 빈 값은 '(자동)'.
            parts.push((f.name === '--model' ? '모델 ' : '추론강도 ') + ((c && c.value) || '자동'));
        }
        presetSum.replaceChildren(el('b', { text: '실행 설정' }), document.createTextNode(' · ' + parts.join(' · ')));
    }
    function renderFlags() {
        const h = harnessOf();
        flagsBox.replaceChildren();
        for (const f of (h.flags || [])) {
            let ctrl;
            // 빈 값 = 그 플래그를 아예 안 넘김(하네스가 알아서) — '기본'보다 '자동'이 그 뜻에 가깝다(#1145).
            if (f.type === 'select')
                ctrl = el('select', { class: 'term-input', 'data-flag': f.name }, ...(f.choices || []).map((c) => el('option', { value: c }, c || '(자동)')));
            else if (f.type === 'bool')
                ctrl = el('input', { type: 'checkbox', 'data-flag': f.name });
            else
                ctrl = el('input', { class: 'term-input', type: 'text', 'data-flag': f.name, placeholder: f.desc || '' });
            const saved = prefs.flags && prefs.flags[f.name]; // 이전 설정 복원(#673)
            if (saved != null) {
                if (ctrl.type === 'checkbox')
                    ctrl.checked = !!saved;
                else
                    ctrl.value = saved;
            }
            ctrl.addEventListener('change', presetSummary);
            // 폭도 인라인으로 — 모델·추론강도가 실행(AI)과 같은 줄에서 균등하게 나뉘도록(옛 CSS 캐시에도 안전).
            flagsBox.append(el('div', { class: 'field', style: 'flex:1 1 110px;min-width:0;margin:8px 0 0' }, el('label', { class: 'field-label', text: f.label }), ctrl, f.desc ? el('div', { class: 'caption', text: f.desc }) : null));
        }
        autoWrap.style.display = h.hasAutoApprove ? '' : 'none';
        //  기록 범위 축이 꺼져 있으면 아예 안 보인다(#1291) — 고른 값이 강제되지 않는 컨트롤을 남기지 않는다.
        writeVisField.style.display = (h.key === 'claude' && visAxisOn('session_cap')) ? '' : 'none'; // 모드와 같은 이유(MCP 헤더 레일이 claude 만)
        modeField.style.display = h.key === 'claude' ? '' : 'none'; // 라이블리 모드는 claude-code 만 동작(codex 정적 헤더·shell 무 MCP) — 안 되는 하네스엔 안 보여 오해 방지(#1007+)
        presetSummary();
    }
    harnessSel.addEventListener('change', renderFlags);
    if (prefs.harness && harnesses.some((h) => h.key === prefs.harness))
        harnessSel.value = prefs.harness; // 이전 하네스 복원
    renderFlags();
    applyPreset();
    // 작업 폴더 = 선택한 루트(공유/개인) 안을 드롭다운으로 재귀 탐색.
    async function loadPicker() {
        pickerBox.replaceChildren(el('div', { class: 'caption', text: '폴더 불러오는 중…' }));
        let data;
        try {
            data = await api('/api/ui/terminal/browse?root=' + encodeURIComponent(rootKey) + '&path=' + encodeURIComponent(pickerPath));
        }
        catch (e) {
            pickerBox.replaceChildren(el('div', { class: 'caption', text: '폴더를 불러오지 못했습니다: ' + e.message }));
            return;
        }
        pickerPath = data.path || '';
        const rootLabel = (roots.find((r) => r.key === rootKey) || {}).label || rootKey;
        const crumb = el('div', { class: 'term-crumb' }, el('a', { class: 'crumb', text: rootLabel, onclick: () => { pickerPath = ''; loadPicker(); } }));
        let acc = '';
        for (const seg of (pickerPath ? pickerPath.split('/') : [])) {
            acc = acc ? acc + '/' + seg : seg;
            const p = acc;
            crumb.append(el('span', { class: 'crumb-sep', text: ' / ' }), el('a', { class: 'crumb', text: seg, onclick: () => { pickerPath = p; loadPicker(); } }));
        }
        const parentPath = data.parent; // '' = 루트로, null = 이미 루트(상위 없음)
        const sel = el('select', { class: 'term-input', onchange: () => {
                const v = sel.value;
                sel.value = '';
                if (v === '__up__') {
                    pickerPath = parentPath || '';
                    loadPicker();
                    return;
                }
                if (v === '__new__') {
                    newPickerFolder();
                    return;
                }
                if (v) {
                    pickerPath = (pickerPath ? pickerPath + '/' : '') + v;
                    loadPicker();
                }
            } }, el('option', { value: '' }, data.dirs.length ? '하위 폴더로 이동…' : '(하위 폴더 없음)'), (pickerPath ? el('option', { value: '__up__' }, '⬆ 상위 폴더로') : null), ...data.dirs.map((d) => el('option', { value: d }, '📁 ' + d)), el('option', { value: '__new__' }, '＋ 새 폴더 만들기…'));
        // #853 '여기서 AI 실행' 배너 — 지금 고른 위치/폴더에서 세션이 시작된다는 걸 직관적으로.
        const runHere = el('div', { class: 'term-runhere' }, el('span', { class: 'term-runhere-ic', text: '▶' }), el('span', { class: 'term-runhere-txt' }, document.createTextNode('이 폴더에서 AI 실행 · '), el('b', { text: rootLabel }), document.createTextNode(pickerPath ? ' / ' + pickerPath : '')));
        pickerBox.replaceChildren(crumb, sel, runHere);
    }
    async function newPickerFolder() {
        const name = prompt('새 폴더 이름');
        if (!name || !name.trim())
            return;
        const rel = (pickerPath ? pickerPath + '/' : '') + name.trim();
        try {
            await api('/api/ui/terminal/browse/mkdir?root=' + encodeURIComponent(rootKey) + '&path=' + encodeURIComponent(rel), { method: 'POST' });
            pickerPath = rel;
            loadPicker();
        }
        catch (e) {
            toast('폴더 생성 실패 — ' + e.message, true);
        }
    }
    loadPicker();
    // 폼 순서(#673) — 무엇(이름) → 어디(폴더) → 어떻게(실행 옵션 체크박스 · 실행 설정 프리셋) → 누구(초대는 맨 아래).
    //  온보딩 투어(#517)의 data-tour 앵커도 이 순서에 맞춘다: label → node → folder → options → preset → invite → create.
    const back = overlay('새 세션', el('div', { 'data-tour': 'label' }, field('이름', labelI)), el('div', { 'data-tour': 'node' }, fieldInfo('실행 위치', 'AI 가 실제로 돌아가는 컴퓨터입니다.\n\n· **중앙 컴퓨터**(기본) — 내 노트북을 꺼도 세션은 계속 실행됩니다.\n· **내 PC** — 노드로 등록해 두었다면 골라서 그 컴퓨터에서 실행합니다.', nodeSel)), // #869 중앙 컴퓨터/등록 노드 — 항상 노출: 투어 ③'실행 위치' 스텝의 대상(#req). 등록 노드가 없으면 '중앙 컴퓨터(기본)' 한 줄만 보인다(submit 값은 기존과 동일 '').
    // #853 작업 위치(공유/개인 토글) + 그 안의 폴더를 한 블록으로 — '이 폴더에서 AI를 실행한다'는 직관.
    el('div', { 'data-tour': 'folder' }, fieldInfo('어디서 실행할까요', 'AI 는 폴더 하나를 정해 그 안에서 일합니다.\n\n· 여기서 고른 폴더가 이 세션의 **작업 공간**이 됩니다.\n· 그 안의 파일과 하위 폴더는 AI 가 **자유롭게 열어 봅니다**.\n· 「공유 워크스페이스」는 팀과 함께 쓰는 폴더, 「개인 폴더」는 나만 쓰는 폴더입니다.', el('div', { class: 'term-loc' }, rootSeg, el('div', { class: 'term-loc-folder' }, pickerBox)))), modeField, // 라이블리 모드 — '어디서 실행할까요'와 같은 카드 언어로, 그 아래 독립 필드(#1007+ 디자인 통일)
    writeVisField, // 기록 범위(#1291 v2) — 모드와 직교(쓰나 마나 vs 쓴다면 누구에게)
    el('div', { class: 'term-checks', 'data-tour': 'options' }, autoWrap), presetToggle, presetBody, el('div', { 'data-tour': 'invite' }, field('초대 (비우면 나만 보는 비공개 세션)', inviteBox.box)), el('div', { class: 'ov-actions' }, el('button', { class: 'btn btn-primary', 'data-tour': 'create', text: '생성하기', onclick: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            const fromTour = isTourActive(); // 클릭 순간(투어 종료 전)에 캡처 — 따라하기면 완료 안내를 새 터미널 탭에 띄운다(#673)
            const flags = {};
            for (const c of flagsBox.querySelectorAll('[data-flag]'))
                flags[c.dataset.flag] = (c.type === 'checkbox') ? c.checked : c.value;
            const nodeId = nodeSel.value || ''; // #869 노드면 원격 경로(remoteSubI), 아니면 로컬 폴더(pickerPath)
            const mode = modeVal; // #1007+ 라이블리 모드 → readOnly/incognito 불리언(서버 CreateInput)
            const payload = { label: labelI.value, rootKey, subpath: nodeId ? remoteSubI.value.trim() : pickerPath, harness: harnessSel.value, flags, autoApprove: autoCb.checked, readOnly: mode === 'readonly', incognito: mode === 'incognito', writeVis: writeVisVal || undefined, invites: inviteBox.selected(), node: nodeId || undefined };
            try {
                const out = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify(payload) });
                saveTermCreatePrefs({ harness: harnessSel.value, flags, autoApprove: autoCb.checked }); // 이 설정을 다음 생성 때 기본값으로 기억(#673, 자동 승인은 #782)
                back.remove();
                toast('세션 생성됨');
                if (out && out.session)
                    window.open(termUrl(out.session.id, out.session.label, nodeId, fromTour ? '&welcome=1' : ''), '_blank');
                if (onCreated)
                    onCreated(out);
                else
                    renderTerminal(view);
            }
            catch (e) {
                btn.disabled = false;
                toast('생성 실패 — ' + e.message, true);
            }
        } })));
}
// 노드 관리(#869) — 내 PC·서버를 노드로 연결(상태·추가안내·토큰회전·활성토글·삭제). 등록 자체는 그 머신에서
//  `lively node --daemon` 이 self-register 하므로, 여기선 '추가하는 법' 안내 + 이미 붙은 노드의 관리를 제공한다.
function openNodeManager(view) {
    const body = el('div', {});
    const back = overlay('🖥 노드 관리', body);
    const gw = location.origin;
    const codeStyle = 'background:var(--bg-subtle,#0d1117);color:#c9d1d9;padding:10px 12px;border-radius:8px;white-space:pre;overflow-x:auto;font-size:12px;line-height:1.6;margin:6px 0';
    async function load() {
        body.replaceChildren(el('div', { class: 'caption', text: '노드를 불러오는 중…' }));
        let nodes = [];
        try {
            nodes = (await api('/api/ui/nodes')).nodes || [];
        }
        catch (e) {
            body.replaceChildren(el('div', { class: 'caption', text: '노드를 불러오지 못했습니다: ' + e.message }));
            return;
        }
        // '내 PC를 노드로 추가하는 법' — 접이식. lively node 가 self-register 하므로 웹 등록 폼 대신 안내.
        const cmd = 'curl -fsSL ' + gw + '/cli | sh\nlively login\nlively node --daemon        # 부팅·로그인마다 자동 연결';
        const codeEl = el('pre', { style: codeStyle, text: cmd });
        const howBody = el('div', { style: 'display:none' }, el('div', { class: 'caption', text: '내 PC·서버(macOS·Linux)를 노드로 붙이면 그 머신의 터미널 세션을 여기서 만들고 관리하며, 위탁 워커로도 씁니다. 붙인 노드는 기본적으로 나만 쓸 수 있고, 관리자가 공유 노드로 지정한 노드만 조직 전체가 함께 씁니다.' }), codeEl, el('div', {}, el('button', { class: 'btn btn-ghost btn-sm', text: '명령 복사', onclick: () => { try {
                navigator.clipboard.writeText(cmd).then(() => toast('명령 복사됨')).catch(() => toast('복사 실패', true));
            }
            catch (_) {
                toast('복사 실패', true);
            } } }), el('span', { class: 'caption', text: '  tmux 는 없으면 자동 설치됩니다. 등록되면 아래 목록에 나타납니다(새로고침).' })));
        const howToggle = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 내 PC를 노드로 추가하는 법',
            onclick: () => { howBody.style.display = howBody.style.display === 'none' ? '' : 'none'; } });
        const list = el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-top:10px' });
        if (!nodes.length)
            list.append(el('div', { class: 'caption', text: '아직 등록된 노드가 없습니다 — 위 안내대로 추가하세요.' }));
        // ⚠ 공유 지정 버튼은 여기 없다(#1558) — 이미 연결된 컴퓨터를 나중에 공유로 올리는 경로 자체를 없앴다.
        //  공유 컴퓨터는 [설정 ▸ 컴퓨터(노드)]에서 그 목적으로 **등록**한다. 여기선 공유 여부를 배지로 보여만 준다.
        for (const n of nodes) {
            const badge = el('span', { class: 'tsess-badge' + (n.online ? '' : ' danger'),
                text: n.online ? '🟢 연결됨 · 세션 ' + (n.sessions || 0) : '⦿ 끊김' });
            const acts = el('div', { style: 'display:flex;gap:6px;margin-left:auto' }, el('button', { class: 'btn btn-ghost btn-sm', text: n.enabled === false ? '활성화' : '비활성',
                title: n.enabled === false ? '다시 연결 허용' : '연결 차단(다음 재연결부터 거부)', onclick: () => toggle(n) }), el('button', { class: 'btn btn-ghost btn-sm', text: '토큰 회전',
                title: '현재 토큰 폐기 — 유출 대응. 그 머신에서 lively node --daemon 재실행이 필요합니다.', onclick: () => rotate(n) }), el('button', { class: 'btn btn-sm btn-danger', text: '삭제', onclick: () => del(n) }));
            list.append(el('div', { class: 'card', style: 'display:flex;align-items:center;gap:10px;padding:10px 12px' }, el('span', { text: '🖥' }), el('div', { style: 'min-width:0' }, el('div', { style: 'font-weight:600' }, document.createTextNode((n.name || n.id) + ' '), el('span', { class: 'caption', text: n.kind === 'worker' ? '워커' : '멤버' }), 
            // 공유 여부는 '누가 이 컴퓨터를 쓸 수 있나'라서 종류(워커/멤버)보다 중요하다 — 배지로 눈에 걸리게.
            //  이모지는 쓰지 않는다(디자인 시스템: 아이콘 스타일 혼용 금지) — 관리탭 [컴퓨터(노드)]와 같은 표기.
            ...(n.shared ? [document.createTextNode(' '), el('span', { class: 'dm-tag', text: '공유' })] : [])), el('div', { class: 'caption', text: n.id })), badge, acts));
        }
        body.replaceChildren(el('div', {}, howToggle, howBody), el('div', { style: 'margin-top:8px;font-weight:600' }, document.createTextNode('내 노드 '), el('button', { class: 'btn btn-ghost btn-sm', text: '↻', title: '새로고침', onclick: () => load() })), list, 
        // 이 모달은 '내 컴퓨터를 붙이고 관리하는' 자리다. 조직 전체 노드와 공유 지정은 관리탭이 정본이므로
        //  거기로 안내한다(같은 일을 두 화면에서 각자 설명하지 않게 — 입구가 둘이면 어느 쪽이 맞는지 모른다).
        el('div', { class: 'caption', style: 'margin-top:10px' }, '조직 전체의 컴퓨터 목록과 공유 지정은 [설정 ▸ 컴퓨터(노드)]에 있습니다.'));
    }
    async function del(n) {
        if (!confirm('노드 "' + (n.name || n.id) + '" 를 삭제할까요?\n접속 열쇠가 해제되고 그 머신의 노드 연결이 끊깁니다(다시 붙이려면 lively node --daemon 재실행).'))
            return;
        try {
            await api('/api/ui/nodes/' + encodeURIComponent(n.id), { method: 'DELETE' });
            toast('노드 삭제됨');
            load();
            renderTerminal(view);
        }
        catch (e) {
            toast('삭제 실패 — ' + e.message, true);
        }
    }
    async function toggle(n) {
        try {
            await api('/api/ui/nodes/' + encodeURIComponent(n.id) + '/enable', { method: 'POST', body: JSON.stringify({ enabled: n.enabled === false }) });
            toast(n.enabled === false ? '활성화됨' : '비활성화됨');
            load();
        }
        catch (e) {
            toast('변경 실패 — ' + e.message, true);
        }
    }
    async function rotate(n) {
        if (!confirm('노드 "' + (n.name || n.id) + '" 의 토큰을 회전할까요?\n현재 토큰이 폐기돼 연결이 끊기고, 그 머신에서 lively node --daemon 을 다시 실행해야 합니다.'))
            return;
        try {
            await api('/api/ui/nodes/' + encodeURIComponent(n.id) + '/rotate', { method: 'POST', body: '{}' });
            toast('토큰 회전됨 — 그 머신에서 lively node --daemon 재실행');
            load();
        }
        catch (e) {
            toast('회전 실패 — ' + e.message, true);
        }
    }
    load();
    return back;
}
// 세션 수정 — 이름·초대 멤버만 변경 가능(소유자만, 서버가 강제). 작업폴더·하네스·모델·자동승인은
//  생성 시 실행 명령에 박혀(돌고 있는 LLM/셸 프로세스) 사후 변경 불가 → '현재값'을 비활성으로 보여주고
//  왜 못 바꾸는지(닫고 새로 켜야 함) 안내한다. "기능 미구현"이 아니라 "구조상 고정"임을 분명히.
function openTermEdit(s, cfg, view) {
    const harnesses = (cfg && cfg.harnesses) || [];
    const harness = harnesses.find((h) => h.key === s.harness) || {};
    // ── 변경 가능 ──
    const labelI = el('input', { class: 'term-input', type: 'text', value: s.label });
    const inviteBox = buildInvitePicker(cfg, new Set(s.invites || []));
    // ── 생성 시 고정(비활성 표시) ──
    const ro = (val) => el('input', { class: 'term-input', type: 'text', value: val, disabled: '' });
    const author = memberName(cfg, s.owner) || s.owner || '?';
    const flagFields = (harness.flags || []).map((f) => {
        const raw = (s.flags && s.flags[f.name] != null) ? String(s.flags[f.name]) : '';
        const shown = f.type === 'bool' ? (raw ? '켜짐' : '꺼짐') : (raw || '(기본)');
        return field(f.label, ro(shown));
    });
    const autoShown = harness.hasAutoApprove ? (s.autoApprove ? '켜짐 (위험)' : '꺼짐') : '해당 없음';
    const lockNote = el('div', { class: 'term-lock-note' }, el('span', { text: '🔒 작업 폴더 · 하네스 · 모델 · 자동 승인은 세션을 처음 켤 때 정해집니다. 바꾸려면 실행 중인 LLM(또는 셸)을 닫고 새로 켜야 하므로 여기서는 수정할 수 없습니다 — 바꾸려면 새 세션을 만드세요.' }));
    const back = overlay('세션 수정', field('이름', labelI), field('초대 (선택한 멤버만 이 세션을 보고 열 수 있음 · 비우면 비공개)', inviteBox.box), lockNote, field('작업자', ro(author)), field('작업 폴더', ro(s.dir || '(기본)')), field('하네스', ro(harness.label || s.harness || '?')), flagFields, field('자동 승인', ro(autoShown)), el('div', { class: 'ov-actions' }, el('button', { class: 'btn btn-primary', text: '저장', onclick: async (ev) => {
            ev.currentTarget.disabled = true;
            try {
                await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id), { method: 'POST', body: JSON.stringify({ label: labelI.value, invites: inviteBox.selected(), node: (s.node && s.node.id) || undefined }) });
                back.remove();
                toast('수정됨');
                renderTerminal(view);
            }
            catch (e) {
                ev.currentTarget.disabled = false;
                toast('수정 실패 — ' + e.message, true);
            }
        } })));
}
// 초대 멤버 피커(#673) — 긴 행 목록 대신 '검색해 추가 → 칩' 타입어헤드. 세로로 여러 이름을 항상 보여줄 이유가 없어,
//  기본은 칩(선택된 사람)만 보이고, 검색창을 누르면 드롭다운(absolute 오버레이라 폼 높이를 안 늘림)이 후보를 보여준다.
//  나(state.me) 제외한 구성원이 후보. current(Set)=초기 선택, selected()=고른 id 배열. 생성·수정 폼이 공유한다.
function buildInvitePicker(cfg, current) {
    const meId = (state.me && state.me.userId) || '';
    const others = (cfg.members || []).filter((m) => m.id !== meId);
    const selected = new Set([...current].filter((id) => others.some((m) => m.id === id))); // 유령 id 방지
    const label = (m) => (m.name || m.id) + (m.kind === 'agent' ? ' (AI)' : '');
    const chips = el('div', { class: 'proj-mp-chips' });
    const searchIn = el('input', { type: 'text', class: 'proj-mp-search', placeholder: '이름으로 검색해 추가…' });
    const menu = el('div', { class: 'proj-mp-menu', hidden: '' });
    const box = el('div', { class: 'proj-mp' }, chips, el('div', { class: 'proj-mp-ta' }, searchIn, menu));
    function paintChips() {
        // 아무도 안 고른 상태의 '비우면 비공개' 안내는 두지 않는다(#1145) — 필드 라벨이 이미 같은 말을 한다.
        //  이때 chips 를 **빈 채로 남기면** 그 div 의 gap·min-height 가 그대로 남아 라벨과 검색창 사이에 빈 띠가 생긴다
        //  (사용자 신고). 그러니 내용이 없을 땐 요소 자체를 접는다. '고를 사람이 아예 없다'만은 라벨이 못 하는 말이라 남긴다.
        chips.style.display = '';
        if (!selected.size) {
            if (others.length) {
                chips.replaceChildren();
                chips.style.display = 'none';
            }
            else
                chips.replaceChildren(el('span', { class: 'proj-mp-hint', text: '초대할 다른 구성원이 없습니다 — 비공개 세션이 됩니다.' }));
            return;
        }
        chips.replaceChildren(...[...selected].map((id) => {
            const m = others.find((x) => x.id === id) || { id, name: id };
            return el('span', { class: 'proj-mp-chip' }, personFace(m.id, 'proj-mp-ava proj-mp-ava-sm', m.name), el('span', { class: 'proj-mp-chip-name', text: label(m) }), el('button', { class: 'proj-mp-chip-x', type: 'button', 'aria-label': '초대 제거', text: '×', onclick: () => { selected.delete(id); paintChips(); } }));
        }));
    }
    function closeMenu() { menu.hidden = true; menu.replaceChildren(); }
    function openMenu() {
        const q = searchIn.value.trim().toLowerCase();
        const cand = others.filter((m) => !selected.has(m.id) && (!q || (m.name || m.id).toLowerCase().includes(q))).slice(0, 8);
        if (!cand.length) {
            menu.replaceChildren(el('div', { class: 'proj-mp-empty', text: others.length ? '일치하는 사람이 없어요.' : '초대할 구성원이 없어요.' }));
            menu.hidden = false;
            return;
        }
        menu.replaceChildren(...cand.map((m) => el('div', { class: 'proj-mp-row', role: 'button',
            // mousedown+preventDefault: 클릭 전 blur 로 메뉴가 닫혀 클릭이 씹히는 걸 막는다.
            onmousedown: (e) => { e.preventDefault(); selected.add(m.id); searchIn.value = ''; paintChips(); openMenu(); searchIn.focus(); } }, personFace(m.id, 'proj-mp-ava', m.name), el('span', { class: 'proj-mp-name', text: label(m) }), el('span', { class: 'proj-mp-add', text: '＋ 추가' }))));
        menu.hidden = false;
    }
    searchIn.addEventListener('focus', openMenu);
    searchIn.addEventListener('input', openMenu);
    searchIn.addEventListener('blur', () => setTimeout(closeMenu, 120));
    paintChips();
    return { box, selected: () => [...selected] };
}
// ── 위층·배럴이 쓰는 것만 재수출(profileNoteEl·openLoginSession·buildInvitePicker 는 이 파일 안에서 닫힌다). ──
export { memberName, termCreatePrefs, saveTermCreatePrefs, termAutoApprovePref, loginBannerEl, openTermCreateForm, openNodeManager, openTermEdit, };

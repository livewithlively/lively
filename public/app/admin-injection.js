// admin-injection.ts — [세션 주입] 지도 패널 (#1313 R39, admin.ts 에서 분리).
//  ⚠ 이 파일의 내부 구조는 **의도적으로 그대로 뒀다**. injectionMap 안의 조립 함수 대부분은 지역
//   rc(runtimeConfig) · hooks · canEdit · data 를 클로저로 캡처한다. 그 캡처를 인자로 펴는 일(진짜 승격)은
//   **별도 항목**이다 — 이동과 같은 커밋에서 하면 "옮기기만 했다"를 diff 로 확인할 수 없게 된다.
//   이번엔 **캡처가 하나도 없는 조각만** 모듈 최상위로 올렸다(동작이 안 바뀜이 자명한 범위):
//     HANDLED · jump · momentBlock · previewExpander · guideKey · SECTION_HINT · subPieceRow.
//   나머지(saveRuntime·momentToggle·guideInjectToggle·customList·listEditor·pullToolsEditor·writebackEditor·
//   openGuideViewer·openSectionEditor·reloadSections·orderedSections·moveSection·deleteSectionUi·paintSections)는
//   캡처를 그대로 유지한 채 injectionMap 안에 남는다.
import { api, busy, el, errorNote, renderMarkdown, state, toast, uiText } from './core.js';
import { field, overlay } from './ui-primitives.js';
import { sectionHead } from './admin-widgets.js';
// 변경 이력(#1562) — 위키 문서 패널을 그대로 쓴다. 섹션은 knowledge 행이라 같은 엔드포인트가 덮고,
//  서버가 org_section 축 감사까지 합쳐 준다(관리탭에서 한 편집과 위키에서 한 편집이 한 타임라인에 온다).
import { openKnHistory } from './wiki-history.js';
// 위 3시점(SessionStart·PostToolUse·Stop) — 이 목록 밖의 이벤트는 '기타 이벤트' 블록으로 모은다.
const HANDLED = ['SessionStart', 'PostToolUse', 'Stop'];
// 딥링크 — 정식 편집 집으로 이동(섹션 / WIKI 탭). tab 을 주면 그 화면의 서브탭까지 맞춘다.
//  (#837 병합 후 필요해졌다: '커스텀 훅 편집 →'이 [스킬·훅] 화면엔 가지만 **스킬 탭**에 떨어지면
//   사용자는 훅을 못 찾는다 — 링크가 가리킨 곳과 도착지가 달라진다.)
const jump = (label, hash, tab) => el('button', { class: 'btn btn-ghost btn-sm', text: label, onclick: () => {
        if (tab) {
            state.admin.tab = state.admin.tab || {};
            state.admin.tab[tab.section] = tab.key;
        }
        location.hash = hash;
    } });
function momentBlock(title, when, toggleEl, ...children) {
    return el('div', { class: 'inj-moment' }, el('div', { class: 'inj-moment-head' }, el('div', { class: 'inj-moment-h' }, el('h3', { class: 'inj-moment-title', text: title }), el('div', { class: 'admin-hint inj-sub' }, ...uiText(when))), toggleEl || el('span', {})), ...children.filter(Boolean));
}
// ── 훅 주입 미리보기(V4-P5 J절) — 설치된 3 세션 훅이 각자 세션에 실제로 주입하는 최종 메시지를 보여준다. ──
//  데이터 출처: GET /api/ui/org/hooks/preview (scope null = 인증만, REST 전용). 읽기 전용.
//  보안: 모든 데이터 텍스트는 textContent(el text:)/renderMarkdown(createElement+textContent) 로만 — innerHTML 데이터주입 0.
//  드리프트 정직성: 서버가 fidelity(exact/approximate)와 source 를 함께 주므로 그대로 표기(근사면 사유 명시).
// 실제 주입 전문 미리보기(SessionStart) — 게이트웨이 조립물(byte-identical) 펼침.
function previewExpander() {
    const box = el('div', { class: 'inj-preview' });
    box.style.display = 'none';
    const btn = el('button', { class: 'btn btn-ghost btn-sm', text: '실제 주입되는 전문 미리보기 ▾' });
    let loaded = false, open = false;
    btn.addEventListener('click', async () => {
        open = !open;
        box.style.display = open ? 'block' : 'none';
        btn.textContent = open ? '미리보기 접기 ▴' : '실제 주입되는 전문 미리보기 ▾';
        if (open && !loaded) {
            loaded = true;
            busy(box, el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));
            try {
                const r = await api('/api/ui/org/hooks/preview');
                const sp = ((r && r.hooks) || []).find((h) => h.id === 'session-preload');
                box.replaceChildren(sp && sp.message
                    ? el('div', { class: 'md-rendered admin-md-box', style: 'max-height:340px; overflow:auto' }, renderMarkdown(sp.message))
                    : el('p', { class: 'admin-hint' }, ...uiText('미리볼 내용이 없습니다.')));
            }
            catch (e) {
                box.replaceChildren(errorNote(e, '미리보기를 불러오지 못했습니다(서버 재시작 후 제공)'));
            }
        }
    });
    return el('div', {}, el('div', { class: 'admin-actions' }, btn), box);
}
// 세션 시작 조각(#335) — 항상-주입 '섹션 문서'(injection='always' 행)를 N개 관리(추가/편집/삭제/재정렬). sort 순으로 조립.
//  실제 순서(publish.ts): 조직 헤더(자동) → [섹션들 sort 순]. 각 섹션 본문의 ${team}/${categories}/${wiki} 는 매 세션 실데이터로 치환.
const guideKey = 'context-ontology-guide';
const SECTION_HINT = {
    'org-defaults': '회사 배경 + 항상 지킬 규칙 + AI 말투 (회사 소개·규칙·성격)',
    // #1245 — 제품 소유(잠금): 본문은 코드 단일 출처라 편집 불가, 릴리스마다 자동 갱신. org 는 주입 여부만 정한다.
    'context-ontology-guide': 'LLM 이 라이블리 시스템(맥락·카테고리·프로젝트·지식) 사용법을 이해하는 핵심 문서 — 제품이 관리하며 업데이트마다 자동 갱신됩니다. 편집 불가, 주입 여부만 선택.',
};
const subPieceRow = (token, label, sub, btn) => el('div', { class: 'inj-piece inj-subpiece' }, el('code', { class: 'inj-token', text: token }), el('div', { class: 'inj-piece-body' }, el('div', { class: 'inj-piece-label', text: label }), sub ? el('div', { class: 'admin-hint inj-sub' }, ...uiText(sub)) : null), btn || el('span', {}));
// ── 런타임 · 훅 (훅 on/off · work-roots · 너지 문구) — admin 전용 ──
// 섹션(org-defaults·context-ontology-guide) 편집은 WIKI 지식 페이지(#/k/<name>)로 일원화(2026-06-26) — 모달 editSectionModal 폐기.
//  이 섹션들은 injection=always knowledge 레코드라 WIKI 상세에서 직접 편집(openKnowledgeEditor). 섹션단위 미리보기도 불필요(허브 통합 미리보기로 충분).
// ════════════════════════════════════════════════════════════════════
// 세션 주입 지도(2026-06-26) — 구 '훅' 그룹(개요·런타임 토글·주입 미리보기)을 흡수한 단일 허브.
//  AI가 매 세션 자동으로 [무엇을·언제] 받고 수행하나를 주입 시점(SessionStart·PostToolUse·Stop·기타)별로 모은다.
//  맥락 조각의 편집은 정식 집(규칙·소개 섹션 / WIKI 탭)으로 딥링크 — 새 진실 출처를 만들지 않는다(맥락의 집은 그대로).
//  여기서 인라인 편집하는 건 '전달' 설정뿐: 시점 ON/OFF · writeback 너지 · work-roots · 기록인정 툴.
//  allowlist(SSRF) 는 'AI 도구'·'DB 데이터소스' 화면 안(allowlistCard)으로, 임의 코드 훅은 '커스텀 훅'으로 분리.
// ════════════════════════════════════════════════════════════════════
function injectionMap(detail, data) {
    const rc = data.runtimeConfig; // admin 만 non-null. 없으면 토글/편집 숨기고 딥링크+미리보기만.
    const canEdit = !!data.canEdit && !!rc;
    const hooks = (rc && rc.hooks) || {};
    const orgHooks = data.orgHooks || [];
    const customFor = (ev) => orgHooks.filter((h) => h.event === ev);
    // 런타임 설정 부분 저장 — 서버가 patch 병합(제공 필드만 갱신)하므로 바뀐 것만 보낸다.
    async function saveRuntime(patch, okMsg) {
        const r = await api('/api/ui/org/runtime-config', { method: 'POST', body: JSON.stringify(patch) });
        if (r && r.runtimeConfig)
            data.runtimeConfig = r.runtimeConfig;
        toast(okMsg || '저장됨 — 구성원 다음 세션부터 반영');
    }
    // 시점 ON/OFF — hooks JSON 전체를 보내 다른 시점 값 보존. label 을 주면 '주입' 외 토글(예: 자동 업데이트)에도 쓴다.
    function momentToggle(hookKey, label, onMsg, offMsg) {
        const chk = el('input', { type: 'checkbox' });
        chk.checked = hooks[hookKey] !== false;
        chk.disabled = !canEdit;
        chk.addEventListener('change', async () => {
            try {
                await saveRuntime({ hooks: { ...hooks, [hookKey]: chk.checked } }, chk.checked ? (onMsg || '주입 켜짐') : (offMsg || '주입 꺼짐'));
                hooks[hookKey] = chk.checked;
            }
            catch (e) {
                toast(e.message, true);
                chk.checked = hooks[hookKey] !== false;
            }
        });
        return el('label', { class: 'admin-check inj-toggle' }, chk, label || ' 주입 켜기');
    }
    // #1245 — 제품 소유 가이드(context-ontology-guide) 주입 토글. 본문은 코드 단일 출처(편집 불가)라 org 는 이것만 정한다.
    //  상태 소스: runtimeConfig(admin) 우선, 없으면 org_sections 의 injectOntologyGuide(read-only 표시용).
    function guideInjectToggle() {
        const cur = (rc ? rc.inject_ontology_guide : data.injectOntologyGuide) !== false;
        const chk = el('input', { type: 'checkbox' });
        chk.checked = cur;
        chk.disabled = !canEdit;
        chk.addEventListener('change', async () => {
            try {
                await saveRuntime({ inject_ontology_guide: chk.checked }, chk.checked ? '가이드 주입 켜짐 — 구성원 다음 세션부터' : '가이드 주입 꺼짐 — AI 가 라이블리 사용법(맥락·카테고리·지식 기록) 안내를 받지 못합니다');
                if (rc)
                    rc.inject_ontology_guide = chk.checked;
                data.injectOntologyGuide = chk.checked;
            }
            catch (e) {
                toast(e.message, true);
                chk.checked = !chk.checked;
            }
        });
        return el('label', { class: 'admin-check inj-toggle', title: '이 가이드를 매 세션 주입할지 여부' }, chk, ' 주입 켜기');
    }
    // 커스텀 훅 요약(읽기 전용) + 편집 딥링크.
    function customList(ev) {
        const list = customFor(ev);
        const wrap = el('div', { class: 'inj-custom' });
        if (list.length)
            wrap.append(el('div', { class: 'admin-hint' }, ...uiText('커스텀 훅')));
        for (const h of list)
            wrap.append(el('div', { class: 'inj-custom-row' }, el('span', { class: 'mini-title', text: h.id }, h.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null), el('span', { class: 'mini-meta', text: (h.harness || 'all') + (h.matcher ? ' · ' + h.matcher : '') })));
        wrap.append(el('div', { class: 'admin-actions' }, jump(list.length ? '커스텀 ' + ev + ' 훅 편집 →' : '+ 커스텀 ' + ev + ' 훅', '#/system/agent-assets', { section: 'agent-assets', key: 'hooks' })));
        return wrap;
    }
    // 줄 단위 텍스트리스트 인라인 편집(work-roots / write_tools). hint 를 주면 라벨 아래 보조 설명으로 분리.
    function listEditor(labelText, initial, fieldKey, ph, hint) {
        const ta = el('textarea', { rows: '3', placeholder: ph || '' });
        ta.value = (initial || []).join('\n');
        ta.disabled = !canEdit;
        const btn = el('button', { class: 'btn btn-primary btn-sm', text: '저장' });
        if (!canEdit)
            btn.disabled = true;
        const st = el('span', { class: 'admin-status' });
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                await saveRuntime({ [fieldKey]: ta.value.split('\n').map((l) => l.trim()).filter(Boolean) });
                st.textContent = '저장됨';
            }
            catch (e) {
                toast(e.message, true);
            }
            btn.disabled = false;
        });
        return field(labelText, el('div', {}, hint ? el('p', { class: 'admin-hint', style: 'margin:0 0 4px' }, ...uiText(hint)) : null, ta, el('div', { class: 'admin-actions' }, btn, st)));
    }
    // #906/#959 pull_tools 전용 편집기 — 게이트웨이 프록시 MCP는 '+추가' 칩(org_mcp tools_snapshot에서 발견)으로,
    //  자체설치 MCP는 그 툴이름 prefix(예: mcp__notion__)를 textarea에 직접. session-preload 가 비-lively prefix로
    //  work-flag matcher를 세션마다 동적 배선(#959)하므로 자체설치도 커버된다 — 게이트웨이 강제 설치 불필요.
    //  textarea = 전체 pull_tools 의 편집 가능한 단일 소스. 칩은 prefix 를 '추가'만(제거는 textarea에서).
    function pullToolsEditor() {
        const proxyServers = (data.mcpServers || []).filter((s) => s.mode === 'proxy' && s.enabled !== false);
        const ta = el('textarea', { rows: '3', placeholder: 'mcp__lively__ext__   (비우면 이 기능 꺼짐)' });
        ta.value = ((rc && rc.pull_tools) || []).join('\n');
        ta.disabled = !canEdit;
        const addPrefix = (p) => {
            const lines = ta.value.split('\n').map((l) => l.trim()).filter(Boolean);
            if (lines.includes(p)) {
                toast(p + ' 는 이미 있습니다');
                return;
            }
            lines.push(p);
            ta.value = lines.join('\n');
            toast(p + ' 추가됨 — [저장]으로 확정');
        };
        const chips = el('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin:4px 0' });
        chips.append(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '+ 전체 프록시 (mcp__lively__ext__)', onclick: () => addPrefix('mcp__lively__ext__') }));
        for (const s of proxyServers) {
            const n = (s.tools_snapshot || []).length;
            chips.append(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '+ ' + s.name + (n ? ' (' + n + '개)' : ''), onclick: () => addPrefix('mcp__lively__ext__' + s.name + '__') }));
        }
        const btn = el('button', { class: 'btn btn-primary btn-sm', text: '저장' });
        if (!canEdit)
            btn.disabled = true;
        const st = el('span', { class: 'admin-status' });
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                await saveRuntime({ pull_tools: ta.value.split('\n').map((l) => l.trim()).filter(Boolean) });
                st.textContent = '저장됨';
            }
            catch (e) {
                toast(e.message, true);
            }
            btn.disabled = false;
        });
        return field('외부 인입 툴(pull_tools) — 외부 맥락을 가져온 세션에 기록 너지', el('div', {}, el('p', { class: 'admin-hint', style: 'margin:0 0 4px' }, ...uiText('이 MCP 툴 prefix 로 시작하는 툴을 쓰면 "외부 맥락을 가져왔다"로 보고, 라이블리에 기록 없이 세션을 끝내면 너지합니다. 비우면 이 기능이 꺼집니다.')), canEdit ? el('p', { class: 'admin-hint', style: 'margin:0 0 4px' }, ...uiText('아래 버튼으로 게이트웨이에 등록된 외부 MCP(프록시)를 추가하세요. 게이트웨이 밖의 자체설치 MCP(예: 구성원이 직접 붙인 Notion MCP)는 그 툴이름 prefix(예: mcp__notion__)를 아래 칸에 직접 적으면 세션 시작 훅이 자동으로 매처를 배선해 커버합니다(#959) — 게이트웨이에 다시 설치할 필요 없습니다.')) : null, canEdit ? chips : null, ta, el('div', { class: 'admin-actions' }, btn, st)));
    }
    // 세션종료 너지 문구 — 기본값(서버 단일소스 data.writebackNoticeDefault)을 실제로 보여준다(숨은 파일 기본값 X).
    //  비우거나 기본값과 같게 저장하면 null(=기본값 사용)로 저장 → DB 는 'override 있음/없음'만 들고, 화면엔 항상 effective 값이 보임.
    function writebackEditor() {
        const def = (data.writebackNoticeDefault || '').trim();
        const cur = (rc && rc.writeback_notice) || '';
        const ta = el('textarea', { rows: '12', placeholder: def });
        ta.value = cur || def;
        ta.disabled = !canEdit;
        const btn = el('button', { class: 'btn btn-primary btn-sm', text: '저장' });
        if (!canEdit)
            btn.disabled = true;
        const resetBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '기본값으로 되돌리기' });
        if (!canEdit)
            resetBtn.disabled = true;
        const st = el('span', { class: 'admin-status', text: cur ? '커스텀 너지 사용 중' : '기본값 사용 중' });
        resetBtn.addEventListener('click', () => { ta.value = def; st.replaceChildren(...uiText('기본값을 불러왔어요 — [저장]으로 확정')); });
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            const v = ta.value.trim();
            const payload = (!v || v === def) ? null : v; // 비었거나 기본값과 동일 → null(기본값 사용)
            try {
                await saveRuntime({ writeback_notice: payload });
                if (rc)
                    rc.writeback_notice = payload;
                st.textContent = payload ? '저장됨 · 커스텀 너지' : '저장됨 · 기본값 사용';
            }
            catch (e) {
                toast(e.message, true);
            }
            btn.disabled = false;
        });
        return field('세션 종료 너지 문구 — 기본값이 채워져 있음(비우거나 기본값과 같으면 기본값 사용)', el('div', {}, ta, el('div', { class: 'admin-actions' }, btn, resetBtn, st)));
    }
    // ── 블록 조립 ── (섹션 조각의 상수·순수 조립기 guideKey·SECTION_HINT·subPieceRow 는 모듈 최상위)
    // #1245 — 제품 소유 가이드 읽기 전용 뷰어. 본문은 sectionsPayload 가 항상 코드 기본값으로 채워 보낸다(실주입과 동일).
    function openGuideViewer(name) {
        const cur = (data.sections && data.sections[name]) || { body_md: '' };
        overlay('제품 가이드 · ' + name + ' (읽기 전용)', el('div', { class: 'mem-modal' }, el('p', { class: 'admin-hint' }, ...uiText('제품이 소유하는 가이드입니다 — 본문은 코드가 단일 출처라 편집할 수 없고, 라이블리 업데이트(릴리스)마다 자동으로 최신이 됩니다. 주입 여부만 목록의 토글로 선택하세요.')), el('div', { class: 'md-rendered admin-md-box', style: 'max-height:420px; overflow:auto' }, renderMarkdown(cur.body_md || '')), 
        // 잠금 섹션도 **이력은 연다** — 편집이 막혀 있다고 '어떻게 변해왔나'까지 가릴 이유는 없다(실측: 이 문서에도
        //  9건의 변경이 쌓여 있다). 되돌리기는 canEdit=false 로 버튼을 안 띄우고, 서버도 409 로 막는다.
        el('div', { class: 'admin-actions' }, historyBtn(name, cur, false))));
    }
    // '변경 이력' 버튼 — 위키 문서의 이력 패널을 그대로 연다(#1562).
    //  섹션은 편집 경로가 둘이라(관리탭 모달 · 위키 문서 페이지) 감사가 두 축으로 갈라져 있었는데, 서버가 그
    //  둘을 합쳐 주므로 어느 화면에서 열든 같은 전체 타임라인이 나온다.
    function historyBtn(name, cur, canRevert) {
        return el('button', {
            class: 'btn btn-ghost btn-sm', type: 'button', text: '↺ 변경 이력',
            onclick: () => openKnHistory(name, {
                canEdit: canRevert,
                currentVersion: Number(cur.version) || null,
                onReverted: () => { reloadSections(); },
            }),
        });
    }
    // 섹션 본문 편집/생성 모달 — overlay + textarea. 저장 → POST /api/ui/org/section.
    function openSectionEditor(name, opts) {
        opts = opts || {};
        const isNew = !!opts.isNew;
        if (!isNew && name === guideKey) {
            openGuideViewer(name);
            return;
        } // #1245 — 잠금 섹션은 편집기 대신 뷰어(서버도 409 로 차단)
        const cur = (data.sections && data.sections[name]) || { body_md: '' };
        const nameIn = el('input', { type: 'text', value: name || '', placeholder: '섹션 키 (소문자·숫자·하이픈, 예: company-policy)' });
        if (!isNew)
            nameIn.disabled = true;
        const ta = el('textarea', { class: 'mem-edit-ta', rows: '18', placeholder: 'markdown 본문 — ${team}/${categories}/${wiki} 치환 가능' });
        ta.value = cur.body_md || '';
        const st = el('span', { class: 'admin-status' });
        const saveBtn = el('button', { class: 'btn btn-primary', text: isNew ? '추가' : '저장' });
        const root = el('div', { class: 'mem-modal' }, isNew ? field('섹션 키', nameIn) : null, name === guideKey ? el('p', { class: 'admin-hint' }, ...uiText('⚠ 시스템 가이드 — LLM 이 라이블리 사용법을 이해하는 핵심 문서입니다. 대폭 수정·삭제 시 AI 가 시스템 사용법을 잃을 수 있어요.')) : null, field('본문 (markdown)', ta), 
        // 기존 섹션에만 이력 — 아직 만들지 않은 문서에는 되돌아갈 버전이 없다.
        el('div', { class: 'admin-actions' }, saveBtn, isNew ? null : historyBtn(name, cur, canEdit), st));
        const back = overlay(isNew ? '섹션 추가' : ('섹션 편집 · ' + name), root);
        saveBtn.onclick = async () => {
            const section = (isNew ? nameIn.value : name).trim().toLowerCase();
            if (!section) {
                toast('섹션 키를 입력하세요', true);
                return;
            }
            saveBtn.disabled = true;
            st.textContent = '저장 중…';
            try {
                await api('/api/ui/org/section', { method: 'POST', body: JSON.stringify({ section, body_md: ta.value }) });
                toast('저장됨 — 구성원 다음 세션부터 반영');
                back.remove();
                await reloadSections();
            }
            catch (e) {
                toast('저장 실패 — ' + e.message, true);
                saveBtn.disabled = false;
                st.textContent = '';
            }
        };
    }
    async function reloadSections() {
        try {
            const r = await api('/api/ui/org');
            if (r && r.sections)
                data.sections = r.sections;
        }
        catch (_) { /* 유지 */ }
        paintSections();
    }
    function orderedSections() {
        return Object.entries(data.sections || {}).map(([name, s]) => ({ name, ...s }))
            .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || a.name.localeCompare(b.name));
    }
    async function moveSection(i, dir) {
        const entries = orderedSections();
        const j = i + dir;
        if (j < 0 || j >= entries.length)
            return;
        const order = entries.map((e) => e.name);
        [order[i], order[j]] = [order[j], order[i]];
        try {
            await api('/api/ui/org/sections/order', { method: 'POST', body: JSON.stringify({ order }) });
            await reloadSections();
        }
        catch (e) {
            toast(e.message, true);
        }
    }
    async function deleteSectionUi(s) {
        // #1245 — 가이드 행 삭제는 이제 무영향(본문은 코드 소유·행 무시)이라 특수 경고 불요. 가이드 행엔 삭제 버튼 자체를 안 그린다.
        if (!confirm("'" + s.name + "' 섹션을 삭제할까요?\n\n매 세션 주입에서 사라집니다(휴지통에서 복원 가능)."))
            return;
        try {
            await api('/api/ui/org/section/delete', { method: 'POST', body: JSON.stringify({ section: s.name }) });
            toast('삭제됨');
            await reloadSections();
        }
        catch (e) {
            toast(e.message, true);
        }
    }
    const sectionsWrap = el('div', { class: 'inj-pieces' });
    function paintSections() {
        const entries = orderedSections();
        const rows = entries.map((s, i) => {
            const isGuide = s.name === guideKey;
            const acts = [];
            if (isGuide) {
                // #1245 — 제품 소유(잠금): 편집·삭제 없음. [보기] + 주입 토글만. 재정렬(▲▼)은 실제 DB 행이 있을 때만
                //  의미가 있다(행 없으면 말미 렌더라 sort 대상이 없다 — sections/order 가 만질 행도 없다).
                const view = el('button', { class: 'btn btn-ghost btn-sm', text: '보기' });
                view.onclick = () => openGuideViewer(s.name);
                if (canEdit && (s.version || 0) > 0) {
                    const up = el('button', { class: 'btn btn-ghost btn-sm', text: '▲', title: '위로' });
                    up.disabled = i === 0;
                    up.onclick = () => moveSection(i, -1);
                    const down = el('button', { class: 'btn btn-ghost btn-sm', text: '▼', title: '아래로' });
                    down.disabled = i === entries.length - 1;
                    down.onclick = () => moveSection(i, +1);
                    acts.push(up, down);
                }
                acts.push(view, guideInjectToggle());
            }
            else if (canEdit) {
                const up = el('button', { class: 'btn btn-ghost btn-sm', text: '▲', title: '위로' });
                up.disabled = i === 0;
                up.onclick = () => moveSection(i, -1);
                const down = el('button', { class: 'btn btn-ghost btn-sm', text: '▼', title: '아래로' });
                down.disabled = i === entries.length - 1;
                down.onclick = () => moveSection(i, +1);
                const ed = el('button', { class: 'btn btn-ghost btn-sm', text: '편집' });
                ed.onclick = () => openSectionEditor(s.name, {});
                const del = el('button', { class: 'btn btn-ghost btn-sm', text: '삭제' });
                del.onclick = () => deleteSectionUi(s);
                acts.push(up, down, ed, del);
            }
            return el('div', { class: 'inj-piece' }, el('span', { class: 'inj-n', text: String(i + 1) }), el('div', { class: 'inj-piece-body' }, el('div', { class: 'inj-piece-label' }, s.name, isGuide ? el('span', { class: 'pill', title: '제품 소유 — 코드 단일 출처, 업데이트마다 자동 갱신 (편집 불가)', text: ' 제품 소유 · 자동 갱신' }) : null), el('div', { class: 'admin-hint inj-sub', text: SECTION_HINT[s.name] || ('v' + (s.version || 1) + ' · 갱신 ' + (s.updated_by || '—')) })), el('div', { class: 'admin-actions' }, ...acts));
        });
        sectionsWrap.replaceChildren(...rows, canEdit ? el('div', { class: 'admin-actions inj-add' }, el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 섹션 추가', onclick: () => openSectionEditor('', { isNew: true }) })) : el('span', {}), el('div', { class: 'inj-subpieces' }, el('div', { class: 'admin-hint inj-sub' }, ...uiText('└ 각 섹션 본문의 ${ } 자리에 매 세션 실제 데이터로 자동 채워짐(편집 불가):')), subPieceRow('${team}', '우리 팀', '보는 구성원의 팀·소유 카테고리 프리앰블 — 자동', null), subPieceRow('${categories}', '카테고리 지도', '전 카테고리(주제) 목록 — 자동', null), subPieceRow('${wiki}', 'WIKI 인덱스 핀', '핀(is_wiki)한 지식의 제목·소환키만(본문 제외) — 자동', jump('WIKI 인덱스 →', '#/knowledge?indexed=1'))));
    }
    paintSections();
    const ssBlock = momentBlock('세션 시작 — SessionStart', '세션이 시작될 때 조직 컨텍스트를 자동으로 주입합니다 — 맨 위 조직 헤더(자동) 다음에 아래 섹션 문서들이 sort 순으로 조립됩니다. 추가/편집/삭제/재정렬 가능.', momentToggle('session_preload'), sectionsWrap, previewExpander(), customList('SessionStart'));
    const ptuBlock = momentBlock('작업 중 — PostToolUse', '도구 사용 후 라이블리 작업 세션인지 플래그를 남긴다(주입 없음 · 종료 너지 판정에 사용).', momentToggle('work_flag', ' 감지 켜기', '감지 켜짐', '감지 꺼짐'), canEdit ? listEditor('work-roots — 이 폴더에서 켠 세션을 라이블리 작업으로 인식 (줄당 절대경로)', rc.work_roots, 'work_roots', '/Users/you/repo') : null, canEdit ? listEditor('기록 인정 툴(write_tools) — 이 lively 툴을 사용한 세션에는 종료 너지를 보내지 않습니다 · 비우면 기본 목록 사용', rc.write_tools, 'write_tools', 'knowledge_save') : null, 
    // #906 — write_tools 와 시맨틱이 반대(비우면 끔)라 라벨에 명시. 값이 곧 on/off + 범위다.
    pullToolsEditor(), customList('PostToolUse'));
    const stopBlock = momentBlock('세션 종료 — Stop', '작업했는데 기록이 없으면(조건 충족 시 1회) 기록을 권하는 너지 문구를 표시합니다.', momentToggle('stop_writeback_gate', ' 너지 켜기', '너지 켜짐', '너지 꺼짐'), canEdit ? writebackEditor() : null, customList('Stop'));
    // 키트 자동 업데이트(#858) — 주입이 아니라 '전달' 축이지만, 발화 시점이 세션 시작이라 같은 지도에 둔다.
    //  켜져 있으면 구성원은 업데이트 명령을 손으로 돌릴 필요가 없다(새 훅·배선까지 자동으로 따라온다).
    const updBlock = momentBlock('키트 자동 업데이트 — SessionStart(백그라운드)', '구성원 컴퓨터의 라이블리 키트(훅 코드·연결 설정)를 게이트웨이 최신본과 동기화합니다. 세션 시작 시 버전만 비교하고, 다르면 백그라운드로 내려받아 재설치합니다 → 다음 세션부터 적용(현재 세션은 방해하지 않음). 회사 맥락·스킬은 이 토글과 무관하게 매 세션 자동으로 적용됩니다.', momentToggle('self_update', ' 자동 업데이트 켜기', '자동 업데이트 켜짐 — 구성원 다음 세션부터', '자동 업데이트 꺼짐 — 구성원이 직접 업데이트 명령을 실행해야 합니다'), el('p', { class: 'admin-hint inj-sub' }, ...uiText('끄면 훅 코드·연결 설정 변경이 구성원에게 전달되지 않습니다(구성원이 [내 AI 세션 생성] 화면의 업데이트 명령을 직접 실행해야 함). 구성원 개인이 끄려면 환경변수 LIVELY_NO_AUTO_UPDATE=1 을 설정합니다.')));
    // 기타 이벤트 — 위 3시점 외 커스텀 훅.
    const otherHooks = orgHooks.filter((h) => !HANDLED.includes(h.event));
    const otherBlock = el('div', { class: 'inj-moment' }, el('div', { class: 'inj-moment-head' }, el('div', { class: 'inj-moment-h' }, el('h3', { class: 'inj-moment-title', text: '기타 이벤트' }), el('div', { class: 'admin-hint inj-sub' }, ...uiText('UserPromptSubmit · Pre/PostToolUse 매처 · SubagentStop · Notification 등 — 코드로 정의하는 커스텀 훅.')))), otherHooks.length
        ? el('div', { class: 'inj-custom' }, ...otherHooks.map((h) => el('div', { class: 'inj-custom-row' }, el('span', { class: 'mini-title', text: h.id }, h.enabled === false ? el('span', { class: 'pill', text: '비활성' }) : null), el('span', { class: 'mini-meta', text: h.event + ' · ' + (h.harness || 'all') }))))
        : null, el('div', { class: 'admin-actions' }, jump((data.orgHooks || []).length ? '커스텀 훅 전체 관리 →' : '+ 커스텀 훅 정의', '#/system/agent-assets', { section: 'agent-assets', key: 'hooks' })));
    // 바깥 박스 제거(#req): 각 .inj-moment 가 이미 테두리 있는 '구획'이라 .card 하나로 더 감싸면 박스-속-박스다.
    //  me-logins 처럼 제목(sectionHead)은 박스 밖, 구획들은 스택(admin-stack)으로 바로 나열한다.
    detail.replaceChildren(sectionHead('세션 주입', '이 조직의 AI가 매 세션을 시작할 때 무엇을 자동으로 읽는지 정합니다.'), el('div', { class: 'admin-stack' }, !rc ? el('p', { class: 'admin-hint' }, ...uiText('※ 주입 시점 ON/OFF·너지 편집은 관리자만 가능합니다. 아래는 보기 전용 + 편집 위치로의 이동만 동작합니다.')) : null, el('div', { class: 'inj-moments' }, ssBlock, ptuBlock, stopBlock, updBlock, otherBlock)));
}
export { injectionMap, };

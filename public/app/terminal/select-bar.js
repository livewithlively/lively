// terminal/select-bar.ts — 고른 세션을 **여는** 길: 단독 터미널 URL(termUrl) · 하단 바의 '조건으로 선택' 팝오버 · '어떻게 열까'(각 탭/그리드) 팝업.
//  소비자: terminal/{session-form,session-list,routes}.ts + 대시보드 '내 AI 세션'(배럴 terminal.ts 경유 — 두 벌 만들지 않는다).
//  import 방향: status-filter(아래층)만 본다 — session-form·session-list·routes 는 보지 않는다.
import { anchoredPopover, appUrl, el, toast } from '../core.js';
import { overlay } from '../admin.js';
import { sessAgeDays, sessDead, sessSinceMidnight, sessState } from './status-filter.js';
// 단독 터미널 페이지 URL — 노드 세션(#869)은 &node= 로 WS 릴레이 대상을 지정한다.
function termUrl(id, label, nodeId, extra) {
    return appUrl('/ui/terminal.html?session=') + encodeURIComponent(id) + '&label=' + encodeURIComponent(label || '')
        + (nodeId ? '&node=' + encodeURIComponent(nodeId) : '') + (extra || '');
}
// 여러 세션을 한 탭 그리드로(#745) — n개에 맞는 배치 후보(격자·가로·세로·2열·3열). cols*rows>=n 인 것만.
function gridLayouts(n) {
    const out = [];
    const seen = new Set();
    const add = (cols, rows, label) => { const k = cols + 'x' + rows; if (cols >= 1 && rows >= 1 && cols * rows >= n && !seen.has(k)) {
        seen.add(k);
        out.push({ cols, rows, label });
    } };
    const sq = Math.ceil(Math.sqrt(n));
    add(sq, Math.ceil(n / sq), '격자'); // 정사각형에 가깝게
    add(n, 1, '가로 한 줄');
    add(1, n, '세로 한 줄');
    add(2, Math.ceil(n / 2), '2열');
    if (n >= 6)
        add(3, Math.ceil(n / 3), '3열');
    return out.slice(0, 5);
}
// ── 조건으로 선택(#1150) — 하단 플로팅 바에서 상태·시간·범위 조건으로 세션을 한 번에 고른다 ──────────
//  왜: 상단 필터는 목록을 '좁힌다'. 그래서 "전체를 보면서 방치된 것만 골라 종료" 같은 동선이 안 됐다.
//  여기선 목록을 그대로 둔 채 **선택만** 한다. 축은 AI 세션 탭 뷰 필터(TSESS_VIEWS)와 같은 말·같은 정의를 쓴다.
//  대시보드 '내 AI 세션' 바도 이 함수를 그대로 재사용한다(두 벌 만들지 않는다) — 상태 판정(sessState)이 양쪽 동일하다.
const SESSPICK_MODE_KEY = 'lively_sesspick_mode_v1';
function sessPickMode() { try {
    return localStorage.getItem(SESSPICK_MODE_KEY) === 'add' ? 'add' : 'replace';
}
catch {
    return 'replace';
} }
function saveSessPickMode(v) { try {
    localStorage.setItem(SESSPICK_MODE_KEY, v);
}
catch { /* noop */ } }
// opts = { candidates: 고를 수 있는 세션[](소유한 것), shown: 지금 필터에 걸린 세션[], selected: Set<id>, apply(Set<id>) }
export function openSessionSelectPicker(anchor, opts) {
    const cands = opts.candidates || [];
    const shownIds = new Set((opts.shown || []).map((s) => s.id));
    const st = (s) => sessState(s);
    const online = (s) => ['busy', 'waiting', 'idle'].includes(st(s));
    // 묶음 항목('도는 세션 전부'·'끝남')은 그 안의 상태가 2종 이상 있을 때만 — 한 종류뿐이면 바로 위 항목과 개수가 같아 군더더기다.
    const kinds = (ks) => new Set(cands.map(st).filter((k) => ks.includes(k))).size;
    const groups = [
        { title: null, items: [{ label: '보이는 것 전부', hint: '지금 화면(필터 결과)에 있는 내 세션 전부', match: (s) => shownIds.has(s.id) }] },
        { title: '상태', items: [
                { label: '확인 필요', hint: '내 승인·선택을 기다리는 세션', match: (s) => st(s) === 'waiting' },
                { label: '작업 중', hint: '지금 돌고 있는 세션', match: (s) => st(s) === 'busy' },
                { label: '대기 중', hint: '살아 있고 안 바쁜 세션', match: (s) => st(s) === 'idle' },
                ...(kinds(['busy', 'waiting', 'idle']) > 1 ? [{ label: '도는 세션 전부', hint: '작업 중 · 확인 필요 · 대기 중', match: online }] : []),
                { label: '중단됨·종료됨', hint: '끊겼거나 내가 종료한 세션 — 열면 대화를 이어받는다', match: (s) => !!s.restorable },
                ...(kinds(['exited', 'restorable']) > 1 ? [{ label: '끝남', hint: 'AI 가 더 안 도는 세션(셸로 돌아감 · 중단됨 · 종료됨)', match: sessDead }] : []),
            ] },
        { title: '시간', items: [
                { label: '오늘 작업', hint: '자정 이후에 작업한 세션', match: sessSinceMidnight },
                { label: '최근 7일', hint: '이번 주에 작업한 세션', match: (s) => sessAgeDays(s) < 7 },
                { label: '방치 7일+', hint: '일주일 넘게 아무 작업이 없는(아직 살아 있는) 세션 — 정리 후보', match: (s) => sessAgeDays(s) >= 7 && !sessDead(s) },
            ] },
        { title: '범위', items: [
                { label: '프로젝트 세션만', match: (s) => !!(Number(s.projectId) || 0) },
                { label: '개인 세션만', match: (s) => !(Number(s.projectId) || 0) },
            ] },
    ];
    let mode = sessPickMode();
    const panel = el('div', { class: 'dash-pop-panel selpick' });
    let close = () => { };
    const render = () => {
        const rows = [
            el('div', { class: 'dash-pop-head' }, el('strong', { text: '조건으로 선택' }), el('span', { class: 'dash-pop-sub', text: '보이는 내 세션 ' + cands.length + '개' })),
        ];
        // 선택 방식 — 바꾸기(교체) / 추가(합집합). 이 기기에 기억해 다음에 열 때도 같은 방식.
        const seg = el('div', { class: 'selpick-seg' });
        for (const [k, label, hint] of [['replace', '바꾸기', '고른 조건으로 선택을 교체합니다'], ['add', '추가', '지금 선택에 더합니다']]) {
            const b = el('button', { class: 'selpick-segbtn' + (mode === k ? ' on' : ''), type: 'button', title: hint, text: label });
            b.onclick = () => { mode = k; saveSessPickMode(k); paint(); };
            seg.append(b);
        }
        rows.push(el('div', { class: 'selpick-segrow' }, el('span', { class: 'selpick-seglbl', text: '선택 방식' }), seg));
        for (const g of groups) {
            const items = g.items.map((it) => ({ it, ids: cands.filter(it.match).map((s) => s.id) })).filter((x) => x.ids.length);
            if (!items.length)
                continue;
            if (g.title)
                rows.push(el('div', { class: 'dash-pop-gh', text: g.title }));
            for (const { it, ids } of items) {
                const all = ids.every((id) => opts.selected.has(id)); // 이 묶음이 이미 전부 선택돼 있나 → ✓ + 다시 누르면 해제
                const b = el('button', { class: 'dash-pop-opt' + (all ? ' sel' : ''), type: 'button', title: it.hint || it.label }, el('span', { class: 'dash-pop-name', text: it.label }), el('span', { class: 'selpick-n' }, all ? el('span', { class: 'dash-pop-check', text: '✓' }) : null, el('span', { text: String(ids.length) })));
                b.onclick = () => {
                    const next = new Set(all || mode === 'add' ? opts.selected : []);
                    if (all)
                        ids.forEach((id) => next.delete(id));
                    else
                        ids.forEach((id) => next.add(id));
                    close();
                    opts.apply(next);
                };
                rows.push(b);
            }
        }
        panel.replaceChildren(...rows);
    };
    const paint = () => render();
    render();
    close = anchoredPopover(anchor, panel);
}
// 열기 방식 선택 팝업 — '따로(세션마다 탭 하나)' 또는 '함께(한 탭 그리드 배치)'. items = [{id,label,node}].
//  대시보드 '내 AI 세션' 일괄 바도 이 함수를 재사용한다(#870 — 두 벌 만들지 않는다). 내부 의존(overlay·gridLayouts·el)은 이 모듈 스코프에서 해소된다.
//  #1146 — 종전엔 그리드 배치만 골랐다(버튼도 '그리드로 열기'). 여러 개를 각자 탭으로 여는 길이 없어 방식 축을 앞에 세웠다.
export function openGridPicker(items) {
    const n = items.length;
    const container = el('div', { class: 'tgrid-pick' });
    const back = overlay(n + '개 세션 열기 — 어떻게 열까요?', container);
    const openGrid = (cols, rows) => {
        const ids = items.map((x) => x.id).join(',');
        const labels = encodeURIComponent(JSON.stringify(items.map((x) => x.label || '')));
        const nodes = items.map((x) => x.node || '').join(','); // 세션별 실행 노드(#869) — 그리드 셀 iframe 이 &node= 로 전달
        window.open(appUrl('/ui/terminal-grid.html?sessions=') + encodeURIComponent(ids) + '&labels=' + labels + '&nodes=' + encodeURIComponent(nodes) + '&cols=' + cols + '&rows=' + rows, '_blank');
        back.remove();
    };
    // #1146 각각 새 탭 — 세션당 탭 하나. 클릭(사용자 제스처) 안에서 **동기로 연속** window.open 해야 브라우저가 허용한다
    //  (await·setTimeout 을 끼우면 제스처가 끊겨 전부 차단된다). 그래도 막히면 몇 개가 막혔는지 알려준다.
    const openTabs = () => {
        let blocked = 0;
        for (const it of items) {
            if (!window.open(termUrl(it.id, it.label, it.node), '_blank'))
                blocked++;
        }
        back.remove();
        if (blocked)
            toast(blocked + '개 탭이 브라우저 팝업 차단에 막혔어요 — 주소창의 팝업 차단을 이 사이트에 허용한 뒤 다시 시도하세요', true);
        else
            toast(n + '개 탭으로 열었어요');
    };
    // 탭 도식 — 위 탭 스트립 + 아래 본문(브라우저 창 하나에 탭 여러 개). 그리드 미리보기와 같은 크기라 나란히 읽힌다.
    const tabsPrev = el('div', { class: 'tgrid-prev tgrid-prev--tabs' }, el('span', { class: 'tgrid-tabbar' }, ...Array.from({ length: Math.min(n, 4) }, (_, i) => el('span', { class: 'tgrid-tab' + (i === 0 ? ' on' : '') }))), el('span', { class: 'tgrid-tabbody' }));
    container.append(el('div', { class: 'tgrid-gh', text: '따로 — 세션마다 탭 하나' }), el('div', { class: 'tgrid-opts' }, el('button', { class: 'tgrid-opt', type: 'button', title: '고른 세션을 각각 새 탭으로 엽니다 (창 사이를 오가며 볼 때)', onclick: openTabs }, tabsPrev, el('div', { class: 'tgrid-opt-lbl', text: '각각 새 탭' }), el('div', { class: 'tgrid-opt-dim', text: n + '개 탭' }))), el('div', { class: 'tgrid-gh', text: '함께 — 한 탭에 나란히' }));
    const grids = el('div', { class: 'tgrid-opts' });
    for (const L of gridLayouts(n)) {
        const preview = el('div', { class: 'tgrid-prev', style: 'grid-template-columns:repeat(' + L.cols + ',1fr);grid-template-rows:repeat(' + L.rows + ',1fr)' });
        for (let i = 0; i < L.cols * L.rows; i++)
            preview.append(el('span', { class: 'tgrid-prev-cell' + (i < n ? ' on' : '') }));
        grids.append(el('button', { class: 'tgrid-opt', type: 'button', title: '한 탭 안에 ' + L.cols + '×' + L.rows + ' 로 나란히 (한눈에 볼 때)', onclick: () => openGrid(L.cols, L.rows) }, preview, el('div', { class: 'tgrid-opt-lbl', text: L.label }), el('div', { class: 'tgrid-opt-dim', text: L.cols + '×' + L.rows })));
    }
    container.append(grids);
}
// ── 위층이 쓰는 것 재수출(openSessionSelectPicker·openGridPicker 는 위에서 이미 export). ──
export { termUrl };

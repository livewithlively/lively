// projects/columns.ts — #1313 R32: web/projects.ts 분해 ③ (컬럼 시스템).
//  그리드 트랙(pjvGridTemplate/pjvProjGridTemplate) · 열 순서 드래그(#611) · 이름칸/컬럼 폭 드래그(#483/#666) ·
//  기본 컬럼 정의(PJV_STD_COLS) · 리스트 레지스트리(pjvListById) · 숨김/표시 컬럼(#541/#710).
//  ⚠ 컬럼 표시 설정은 **이중 영속**이다 — 리스트 스코프면 그 리스트의 settings(서버·전체 구성원 공유),
//   리스트 밖(전체·폴더·모달)이면 per-user localStorage(pjv:hiddenCols|shownCols:<surface>).
//   갈림길은 전부 pjvListOf(listId) 한 곳이라 두 경로가 같이 산다 — 그래서 pjvListById/pjvListOf 도 여기 동거한다.
//  ⚠ #1313 R36 — 예전엔 pjvBoardFieldsCur(현재 보드의 커스텀 필드)와 컬럼 정렬(pjvHeadSortable)을 배럴
//   (../projects.js)에서 되짚어 받았고, 그게 columns→projects 역방향 엣지의 유일한 사유였다. 보드 조립부가
//   projects/board.ts 로 나가며 **읽는 쪽이 여기뿐인** 둘을 이 모듈로 내렸다 — 이제 이 파일은 배럴을 물지 않는다.
//    · pjvBoardFieldsCur: 값을 세우는 쪽은 여전히 보드 렌더(board.ts)다. ESM import 바인딩은 재할당할 수 없으므로
//      **setBoardFieldsCur 세터**로만 통째 교체한다(R31 규약 — setFavListCache 와 같은 결).
//    · 컬럼 정렬(#541): 저장(localStorage)·헤더 클릭 바인딩만 여기 있고, **비교자**(pjvColSortCmp·pjvManualCmp)는
//      행 렌더러의 것이라 projects/rows.ts 에 남는다(보드가 양쪽에서 각각 받는다).
import { api, el, toast } from '../core.js';
import { pjvPopover } from './popover.js';
import { PJV_FIELD_BY_KEY } from './fields.js';
import { pjvBoardView, pjvReloadKeepScroll, pjvSortCtx } from './state.js'; // #1313 R31 — 보드 상태 싱글턴/스크롤 보존/정렬 컨텍스트는 state.js 소유(배럴 우회 = 역방향 엣지 아님)
// 현재 보드의 커스텀 필드(anchor board.fields, #710 확장) — 커스텀 컬럼의 리스트별 숨김 재조정(pjvApplyHiddenCols)·
//  되살리기 패널이 참조한다. 현재값을 세우는 쪽은 보드 렌더(board.ts 의 pjvProjectListBoard) — 세터 경유.
let pjvBoardFieldsCur = [];
function setBoardFieldsCur(v) { pjvBoardFieldsCur = v; }
// 그리드 템플릿 — 기본(이름·담당자·마감·우선순위) + 커스텀 필드 폭들 + 더보기. thead/행/추가행에 인라인 적용.
function pjvGridTemplate(fields) {
    // 제목 floor(--pjv-name-min, 180px) + 메타 minmax(0,W). 제목칸 폭은 CSS 변수 — 열 경계 드래그(#483)로 키우거나,
    //  좁은 태스크 모달의 하위태스크 표(#497)에서 컨테이너가 값을 덮어써 이름칸을 넓힌다. 메타는 좁아지면 제목 대신 먼저 준다(#339).
    //  커스텀 필드 폭도 CSS 변수(#666) — 컬럼 헤더 경계 드래그(pjvColResizeHandle)로 조절 가능.
    const extra = (fields || []).map((f) => 'minmax(0, var(' + pjvColWVar('f:' + f.id) + ', ' + ((PJV_FIELD_BY_KEY[f.field_type] && PJV_FIELD_BY_KEY[f.field_type].w) || 130) + 'px))').join(' ');
    return 'minmax(var(--pjv-name-min, 180px), 1fr) minmax(0, var(--pjv-w-assignee, 96px)) minmax(0, var(--pjv-w-due, 92px)) minmax(0, var(--pjv-w-priority, 112px))' + (extra ? ' ' + extra : '') + ' 34px';
}
// 프로젝트 목록 전용 — 우선순위 뒤 '내 세션'(80px) 컬럼 추가. 태스크 박스(pjvGridTemplate)엔 없음.
// 리스트별 커스텀 필드(#607/D) — 선택 리스트에서 보일 필드만: 그 리스트 전용(list_id===listId) + 전역(list_id 없음).
//  listId 없으면(폴더·전체 스코프) 전역 필드만. 필드는 list_id 를 백엔드에서 함께 내려준다(getBoardFields).
function pjvFieldsForList(fields, listId) {
    if (!Array.isArray(fields))
        return [];
    return fields.filter((f) => f.list_id == null || String(f.list_id) === String(listId));
}
function pjvProjGridTemplate(fields) {
    // 제목 = minmax(제목최소, 1fr) — 그 이하로 안 줄고(#607), 컬럼이 적으면 1fr 로 남은 폭을 채운다. 최소 폭은 --pjv-name-min(기본 넉넉히).
    //  메타(팀원·마감·…·커스텀)는 고정 폭(pjvColTrackFor) — 좁아도 안 찌그러지고, 다 못 담으면 컨테이너가 가로 스크롤(#607).
    //  컬럼 순서(#611): 저장된 열 순서(기본 키 + 커스텀 'f:id')대로 트랙을 깐다. 시작일·생성일·갱신일은 기본 폭 0(숨김).
    const order = pjvColOrderList('proj', fields);
    const tracks = order.map((k) => pjvColTrackFor(k, fields)).join(' ');
    // 테이블 뷰(#1067)는 맨 앞에 **행 번호 컬럼**을 하나 더 깐다 — ClickUp Table 의 number row.
    //  행/헤더 모두 이 함수를 쓰므로 트랙만 늘리면 정렬이 저절로 맞는다(행 컴포넌트는 안 건드림 — 번호 칸은 CSS ::before).
    const num = pjvBoardView.table ? '38px ' : '';
    return num + 'minmax(var(--pjv-name-min, 240px), 1fr) ' + (tracks ? tracks + ' ' : '') + '34px';
}
// ── 열 순서 드래그 재정렬(#611) — 컬럼 헤더를 잡아 좌우로 끌어 순서를 바꾼다. 기본 열(팀원·마감·…)·커스텀 필드 모두 대상. ──
//  키(기본=team/due/…, 커스텀='f:'+id) 리스트를 컬럼 폭·숨김과 같은 결로 사용자별 localStorage 에 저장. 헤더·행·그리드가 이 순서를
//  CSS order + 그리드 트랙으로 함께 반영해, 행 DOM 구조(셀 생성 순서)는 그대로 두고 화면 순서만 바꾼다. 드롭 위치는 대상 헤더 좌/우 세로선.
const pjvColDrag = { id: null };
function pjvColOrderKey(surface) { return 'pjv:colOrder:' + surface; }
function pjvGetColOrderSaved(surface) { try {
    return JSON.parse(localStorage.getItem(pjvColOrderKey(surface)) || 'null');
}
catch (_) {
    return null;
} }
function pjvSetColOrder(surface, keys) { try {
    localStorage.setItem(pjvColOrderKey(surface), JSON.stringify(keys));
}
catch (_) { /* noop */ } }
// 자연 키 순서 = 기본 컬럼(PJV_STD_COLS) + 커스텀 필드('f:'+id). 제목/추가는 고정이라 제외.
function pjvColKeysNatural(surface, fields) {
    return [...((PJV_STD_COLS[surface] || []).map((c) => c.key)), ...((fields || []).map((f) => 'f:' + f.id))];
}
// 저장 순서를 자연 키에 적용 — 저장 안 된(새로 생긴) 키는 자연 순서로 뒤에. 저장 없으면 자연 순서 그대로(무영향).
function pjvColOrderList(surface, fields) {
    const natural = pjvColKeysNatural(surface, fields);
    const saved = pjvGetColOrderSaved(surface);
    if (!saved || !saved.length)
        return natural;
    const nat = new Set(natural);
    const ordered = saved.filter((k) => nat.has(k));
    const seen = new Set(ordered);
    for (const k of natural)
        if (!seen.has(k))
            ordered.push(k);
    return ordered;
}
// 키 → 그리드 트랙 문자열 — 고정 폭(안 찌그러짐, #607). 기본=CSS 폭 변수(숨김은 0), 커스텀=타입별 기본 폭.
//  다 담을 폭이 모자라면 컬럼을 줄이는 대신 컨테이너(.pjv-board-scroll)가 가로 스크롤한다.
function pjvColTrackFor(key, fields) {
    const STD = { team: '--pjv-w-team, 96px', assignee: '--pjv-w-assignee, 120px', due: '--pjv-w-due, 92px', start: '--pjv-w-start, 0px', created: '--pjv-w-created, 0px', updated: '--pjv-w-updated, 0px', priority: '--pjv-w-priority, 112px', sess: '--pjv-w-sess, 80px' };
    if (STD[key])
        return 'var(' + STD[key] + ')';
    const f = (fields || []).find((x) => 'f:' + x.id === key);
    const w = (f && PJV_FIELD_BY_KEY[f.field_type] && PJV_FIELD_BY_KEY[f.field_type].w) || 130;
    return 'var(' + pjvColWVar(key) + ', ' + w + 'px)'; // 커스텀 필드도 변수 트랙(#666) — 폭 드래그 조절 대상
}
// 헤더/행에 열 순서 적용 — [data-col] 셀에 CSS order 부여(제목=0·추가=끝 고정). DOM 순서는 안 건드림(기본 순서면 order 가 DOM 순서와 같아 무영향).
function pjvApplyColOrder(rowEl, surface, fields) {
    const order = pjvColOrderList(surface, fields);
    const idx = new Map(order.map((k, i) => [k, i + 1])); // 제목(0) 다음부터
    const title = rowEl.querySelector(':scope > .pjv-trow-title-cell');
    if (title)
        title.style.order = '0';
    for (const cell of Array.from(rowEl.children)) {
        const k = cell.getAttribute && cell.getAttribute('data-col');
        if (k != null && idx.has(k))
            cell.style.order = String(idx.get(k));
    }
    const add = rowEl.querySelector(':scope > .pjv-tcell-add');
    if (add)
        add.style.order = String(order.length + 1);
}
// 컬럼 헤더 행에 드래그 재정렬 배선 — headEl 안 [data-col] 헤더 셀을 잡아 좌우로 끌어 순서 변경. 드롭 시 새 순서 저장 후 재렌더.
function pjvWireColReorder(headEl, surface, fields, reload) {
    const cells = Array.from(headEl.children).filter((c) => c.getAttribute && c.getAttribute('data-col'));
    if (cells.length < 2)
        return;
    const clearMarks = () => cells.forEach((c) => c.classList.remove('pjv-col-drop-before', 'pjv-col-drop-after'));
    for (const cell of cells) {
        const key = cell.getAttribute('data-col');
        cell.setAttribute('draggable', 'true');
        cell.classList.add('pjv-col-draggable');
        cell.addEventListener('dragstart', (ev) => {
            const t = ev.target;
            if (t && t.closest && t.closest('.pjv-thcol-menu, button, input, .pjv-col-resize')) {
                ev.preventDefault();
                return;
            } // 메뉴/버튼/폭핸들에서 시작한 건 취소(클릭·정렬·폭조절 유지)
            pjvColDrag.id = key;
            cell.classList.add('pjv-col-drag-src');
            try {
                ev.dataTransfer.effectAllowed = 'move';
                ev.dataTransfer.setData('text/plain', 'col:' + key);
            }
            catch (_) { /* */ }
        });
        cell.addEventListener('dragend', () => { pjvColDrag.id = null; cell.classList.remove('pjv-col-drag-src'); clearMarks(); });
        const markSide = (ev) => {
            if (pjvColDrag.id == null || pjvColDrag.id === key)
                return false;
            ev.preventDefault();
            try {
                ev.dataTransfer.dropEffect = 'move';
            }
            catch (_) { /* */ }
            const r = cell.getBoundingClientRect();
            const after = ev.clientX > r.left + r.width / 2;
            clearMarks();
            cell.classList.add(after ? 'pjv-col-drop-after' : 'pjv-col-drop-before');
            return after;
        };
        cell.addEventListener('dragover', markSide);
        cell.addEventListener('dragleave', (ev) => { if (!cell.contains(ev.relatedTarget))
            cell.classList.remove('pjv-col-drop-before', 'pjv-col-drop-after'); });
        cell.addEventListener('drop', (ev) => {
            if (pjvColDrag.id == null) {
                clearMarks();
                return;
            }
            const after = markSide(ev);
            ev.preventDefault();
            ev.stopPropagation();
            const dragged = pjvColDrag.id;
            pjvColDrag.id = null;
            clearMarks();
            if (dragged === key)
                return;
            const order = pjvColOrderList(surface, fields);
            const from = order.indexOf(dragged);
            if (from < 0)
                return;
            order.splice(from, 1);
            let to = order.indexOf(key);
            if (to < 0)
                return;
            if (after)
                to += 1;
            order.splice(to, 0, dragged);
            pjvSetColOrder(surface, order);
            toast('열 순서를 저장했습니다');
            pjvReloadKeepScroll(reload); // 새 순서로 재렌더 + 스크롤 보존
        });
    }
}
// 이름(제목) 컬럼 폭 조절(#483) — 헤더 제목칸 오른쪽 경계에 얹는 드래그 핸들. 끌면 --pjv-name-min 을 키우고(메타 컬럼이
//  그만큼 자동으로 줄어듦), 값은 가장 가까운 .pjv-tasks-card 의 dataset.nameKey 로 localStorage 에 저장돼 새로고침 후에도 유지.
//  더블클릭 = 기본값으로 리셋. 프로젝트 목록·프로젝트 상세의 태스크 리스트(=하위 태스크 포함) 헤더에 공용으로 붙인다.
function pjvNameResizeHandle() {
    const h = el('div', { class: 'pjv-col-resize', title: '드래그하여 이름 칸 너비 조절 (더블클릭: 기본값)', 'aria-hidden': 'true' });
    h.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const card = h.closest('.pjv-tasks-card');
        const titleCell = h.closest('.pjv-trow-title-cell');
        if (!card || !titleCell)
            return;
        const startX = e.clientX;
        const startW = titleCell.getBoundingClientRect().width;
        const cardW = card.getBoundingClientRect().width;
        const maxW = Math.max(200, cardW - 200); // 메타 컬럼용 최소 여백 확보(음수/과대 방지)
        document.body.classList.add('pjv-col-resizing');
        const onMove = (ev) => {
            let w = startW + (ev.clientX - startX);
            w = Math.max(140, Math.min(maxW, w));
            card.style.setProperty('--pjv-name-min', Math.round(w) + 'px');
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.classList.remove('pjv-col-resizing');
            const key = card.dataset.nameKey;
            const cur = card.style.getPropertyValue('--pjv-name-min');
            if (key && cur) {
                try {
                    localStorage.setItem(key, cur.trim());
                }
                catch (_) { /* noop */ }
            }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
    h.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const card = h.closest('.pjv-tasks-card');
        if (!card)
            return;
        card.style.removeProperty('--pjv-name-min');
        if (card.dataset.nameKey) {
            try {
                localStorage.removeItem(card.dataset.nameKey);
            }
            catch (_) { /* noop */ }
        }
    });
    return h;
}
// 카드 생성 시 1회 — 저장 키 지정 + 저장된 이름칸 폭 복원(#483).
function pjvInitNameResize(card, key) {
    card.dataset.nameKey = key;
    try {
        const w = localStorage.getItem(key);
        if (w)
            card.style.setProperty('--pjv-name-min', w.indexOf('px') >= 0 ? w : (w + 'px'));
    }
    catch (_) { /* noop */ }
}
// ── 모든 컬럼 폭 드래그 조절(#666) — 이름칸(#483)의 일반화: 기본/커스텀 컬럼 헤더 우측 경계 드래그. ──
//  폭은 그리드 트랙의 CSS 변수(기본=PJV_STD_COL_VAR, 커스텀='--pjv-w-f-<id>')를 카드 스코프에서 조절하고,
//  per-surface localStorage(pjv:colW:proj|task — 숨김/순서와 같은 결)에 {컬럼키: 'NNpx'} 로 저장. 더블클릭=기본 폭.
function pjvColWVar(colKey) {
    if (PJV_STD_COL_VAR[colKey])
        return PJV_STD_COL_VAR[colKey];
    return '--pjv-w-' + String(colKey).replace(/[^a-zA-Z0-9_-]+/g, '-'); // 'f:12'→--pjv-w-f-12, 'f:cu:x'→--pjv-w-f-cu-x
}
function pjvColWKey(surface) { return 'pjv:colW:' + surface; }
function pjvGetColW(surface) { try {
    return JSON.parse(localStorage.getItem(pjvColWKey(surface)) || '{}') || {};
}
catch (_) {
    return {};
} }
function pjvSetColW(surface, colKey, px) {
    try {
        const m = pjvGetColW(surface);
        if (px == null)
            delete m[colKey];
        else
            m[colKey] = px;
        localStorage.setItem(pjvColWKey(surface), JSON.stringify(m));
    }
    catch (_) { /* noop */ }
}
// 카드 생성 시 1회 — 저장된 컬럼 폭 복원. 숨긴 기본 컬럼(폭 0)은 건너뛴다(폭 적용이 숨김을 풀면 안 됨).
//  pjvApplyHiddenCols 뒤에 불러 defaultHidden 컬럼의 '켬 폭'(92px)을 저장 폭이 덮어쓴다.
function pjvApplyColWidths(card, surface, listId) {
    const lid = listId != null ? listId : (card && card.dataset.colList) || null; // #710 현재 리스트 스코프
    const m = pjvGetColW(surface);
    for (const colKey of Object.keys(m)) {
        if (!pjvStdColVisible(surface, colKey, lid))
            continue; // 리스트별 숨김(기본·커스텀)이면 저장폭이 되살리지 않게
        card.style.setProperty(pjvColWVar(colKey), m[colKey]);
    }
}
// 컬럼 헤더용 폭 핸들 — 이름칸 pjvNameResizeHandle 과 동일 결(class 공유: 열 재정렬 dragstart 가드가 핸들을 무시).
function pjvColResizeHandle(colKey) {
    const h = el('div', { class: 'pjv-col-resize pjv-col-resize-col', title: '드래그하여 컬럼 너비 조절 (더블클릭: 기본값)', 'aria-hidden': 'true' });
    h.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const card = h.closest('.pjv-tasks-card');
        const cell = h.closest('.pjv-tcell');
        if (!card || !cell)
            return;
        const surface = card.dataset.colSurface || 'proj';
        const varName = pjvColWVar(colKey);
        const startX = e.clientX;
        const startW = cell.getBoundingClientRect().width;
        document.body.classList.add('pjv-col-resizing');
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            window.removeEventListener('blur', onUp);
            document.body.classList.remove('pjv-col-resizing');
            const cur = card.style.getPropertyValue(varName);
            if (cur)
                pjvSetColW(surface, colKey, cur.trim());
        };
        const onMove = (ev) => {
            if (ev.buttons === 0) {
                onUp();
                return;
            } // 창 밖에서 손 뗀 경우 등 mouseup 유실 방지
            let w = startW + (ev.clientX - startX);
            w = Math.max(56, Math.min(560, w));
            card.style.setProperty(varName, Math.round(w) + 'px');
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        window.addEventListener('blur', onUp);
    });
    h.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const card = h.closest('.pjv-tasks-card');
        if (!card)
            return;
        card.style.removeProperty(pjvColWVar(colKey));
        pjvSetColW(card.dataset.colSurface || 'proj', colKey, null);
    });
    return h;
}
// ── 기본(내장) 컬럼 숨기기/보이기 — 팀원·마감일·우선순위·(내 세션)도 커스텀 필드처럼 호버 ⋯로 숨길 수 있게(#req). ──
//  숨김은 폭 CSS 변수를 0 으로 만들어 컬럼을 접는다(행 그리드는 gap:0 이라 흔적 없이 사라짐 — 셀/그리드 구조는 안 건드림).
//  surface: 'proj'(팀원·마감·우선·세션) | 'task'(담당자·마감·우선). 값은 localStorage 에 저장돼 유지, Fields 패널에서 되살린다.
const PJV_STD_COLS = {
    proj: [
        { key: 'team', label: '팀원' }, { key: 'due', label: '마감일' },
        // #541 빌트인 컬럼(ClickUp 뷰 패리티) — 기본 숨김(defaultHidden): 켠 사람/뷰에만 보임.
        { key: 'start', label: '시작일', defaultHidden: true }, { key: 'created', label: '생성일', defaultHidden: true }, { key: 'updated', label: '갱신일', defaultHidden: true },
        { key: 'priority', label: '우선순위' }, { key: 'sess', label: '내 세션' }
    ],
    task: [{ key: 'assignee', label: '담당자' }, { key: 'due', label: '마감일' }, { key: 'priority', label: '우선순위' }],
};
const PJV_STD_COL_VAR = { team: '--pjv-w-team', assignee: '--pjv-w-assignee', due: '--pjv-w-due', start: '--pjv-w-start', created: '--pjv-w-created', updated: '--pjv-w-updated', priority: '--pjv-w-priority', sess: '--pjv-w-sess' };
const PJV_STD_COL_W = { start: '92px', created: '92px', updated: '92px' }; // defaultHidden 컬럼을 켤 때 부여할 폭
function pjvHiddenColsKey(surface) { return 'pjv:hiddenCols:' + surface; }
// ── #710 리스트별 컬럼 표시/숨김(팀 공유) ─────────────────────────────────────
//  리스트 스코프(선택 리스트)에선 컬럼 숨김을 그 리스트의 settings(hiddenCols/shownCols)를 단일 출처로 읽고 쓴다
//  → 서버 저장이라 **전체 구성원이 같은 컬럼 구성을 본다**(리스트마다 다르게). 리스트 밖 스코프(전체·폴더·비사이드바
//  상태/평면)는 예전대로 per-user localStorage(pjv:hiddenCols|shownCols:<surface>). #607/D 결정(리스트별 커스텀=백엔드
//  공유)의 시야 확장 — 거기선 필드 '정의'를, 여기선 필드 '표시'를 리스트 단위로. listId 없으면(=null/'') 보드 전역.
const pjvListById = new Map();
function pjvSetListRegistry(lists) { pjvListById.clear(); for (const l of (lists || []))
    if (l && l.id != null)
        pjvListById.set(Number(l.id), l); }
function pjvListOf(listId) { return listId == null || listId === '' ? null : (pjvListById.get(Number(listId)) || null); }
function pjvColSetFromList(list, key) { const a = list && list.settings && list.settings[key]; return new Set((Array.isArray(a) ? a : []).filter((x) => typeof x === 'string')); }
// 리스트 settings 의 컬럼 집합을 낙관적으로 갱신(같은 렌더의 후속 읽기·다른 뷰가 즉시 반영) + 서버 저장(얕은 병합, 공유).
function pjvPersistListColSet(list, key, arr) {
    list.settings = list.settings || {};
    list.settings[key] = arr;
    api('/api/ui/v6/project-lists/' + list.id + '/settings', { method: 'POST', body: JSON.stringify({ settings: { [key]: arr } }) })
        .catch((e) => toast('컬럼 표시 설정 저장 실패 — ' + (e && e.message || e), true));
}
function pjvGetHiddenCols(surface, listId) {
    const l = pjvListOf(listId);
    if (l)
        return pjvColSetFromList(l, 'hiddenCols');
    try {
        return new Set(JSON.parse(localStorage.getItem(pjvHiddenColsKey(surface)) || '[]'));
    }
    catch (_) {
        return new Set();
    }
}
function pjvSetHiddenCols(surface, set, listId) {
    const l = pjvListOf(listId);
    if (l) {
        pjvPersistListColSet(l, 'hiddenCols', [...set]);
        return;
    }
    try {
        localStorage.setItem(pjvHiddenColsKey(surface), JSON.stringify([...set]));
    }
    catch (_) { /* noop */ }
}
// 기본숨김(defaultHidden) 컬럼의 '명시 켬' 저장 — hidden-set 과 별도(#541).
function pjvShownColsKey(surface) { return 'pjv:shownCols:' + surface; }
function pjvGetShownCols(surface, listId) {
    const l = pjvListOf(listId);
    if (l)
        return pjvColSetFromList(l, 'shownCols');
    try {
        return new Set(JSON.parse(localStorage.getItem(pjvShownColsKey(surface)) || '[]'));
    }
    catch (_) {
        return new Set();
    }
}
function pjvSetShownCols(surface, set, listId) {
    const l = pjvListOf(listId);
    if (l) {
        pjvPersistListColSet(l, 'shownCols', [...set]);
        return;
    }
    try {
        localStorage.setItem(pjvShownColsKey(surface), JSON.stringify([...set]));
    }
    catch (_) { /* noop */ }
}
function pjvStdColVisible(surface, key, listId) {
    const def = (PJV_STD_COLS[surface] || []).find((c) => c.key === key);
    return def && def.defaultHidden ? pjvGetShownCols(surface, listId).has(key) : !pjvGetHiddenCols(surface, listId).has(key);
}
// 저장된 숨김 컬럼을 폭 0 으로 적용(surface·리스트별, #710). 카드 생성 시 1회 + 리스트 전환마다 renderArea 가 재호출하므로
//  **완전 재조정**: 보여야 할 컬럼은 var 를 지워 기본폭으로 되돌린다(이전 리스트가 남긴 0/켬폭 잔존 제거). 저장폭 복원은 뒤이어
//  pjvApplyColWidths. dataset.colList 에 현재 스코프를 새겨 두면 컬럼 ⋯/되살리기 토글이 그 스코프로 읽고 쓴다(카드 파생 스코프).
//  모달 하위태스크 표에는 적용하지 않는다(되살릴 UI가 없어서). listId 없으면 보드 전역(per-user localStorage).
function pjvApplyHiddenCols(card, surface, listId) {
    card.dataset.colSurface = surface;
    card.dataset.colList = listId != null && listId !== '' ? String(listId) : '';
    const hidden = pjvGetHiddenCols(surface, listId);
    const shown = pjvGetShownCols(surface, listId);
    for (const c of PJV_STD_COLS[surface]) {
        const v = PJV_STD_COL_VAR[c.key];
        if (!v)
            continue;
        if (c.defaultHidden) {
            if (shown.has(c.key))
                card.style.setProperty(v, PJV_STD_COL_W[c.key] || '92px');
            else
                card.style.removeProperty(v); // 기본숨김 & 미켬 → 기본(0폭) 복귀
        }
        else if (hidden.has(c.key)) {
            card.style.setProperty(v, '0px');
        }
        else {
            card.style.removeProperty(v); // 보임 → 기본폭 복귀(리스트 전환 잔존 제거; 저장폭은 pjvApplyColWidths 가 다시 얹음)
        }
    }
    // #710 확장 — 커스텀 필드 컬럼도 리스트별 숨김(hidden-set 의 'f:<id>' 키). 프로젝트 보드(캐시된 board.fields)만.
    //  전환마다 재조정: 숨김이면 폭 0, 아니면 var 제거(기본폭 복귀·저장폭은 pjvApplyColWidths 가 다시). 태스크 보드(surface='task')는
    //  그 보드 필드가 board.fields 와 달라(프로젝트 task_field) 커스텀 숨김 미지원 — 건너뜀(회귀 없음).
    if (surface === 'proj')
        for (const f of pjvBoardFieldsCur) {
            const cv = pjvColWVar('f:' + f.id);
            if (hidden.has('f:' + f.id))
                card.style.setProperty(cv, '0px');
            else
                card.style.removeProperty(cv);
        }
}
// 컬럼 보이기/숨기기 토글 — 저장 + 해당 카드의 폭 변수 즉시 반영(리로드 없이 접힘/펼침). 기본 컬럼·커스텀 필드('f:<id>' 키) 공용(#710).
//  스코프(#710): 명시 listId > 카드의 현재 리스트(dataset.colList, pjvApplyHiddenCols 가 새김) > 보드 전역.
//  리스트 스코프면 그 리스트 settings 에 저장돼 전체 구성원에게 공유된다.
function pjvSetStdColVisible(surface, key, visible, card, listId) {
    const lid = listId != null && listId !== '' ? listId : ((card && card.dataset.colList) || null);
    const def = (PJV_STD_COLS[surface] || []).find((c) => c.key === key);
    if (def && def.defaultHidden) {
        const sh = pjvGetShownCols(surface, lid);
        if (visible)
            sh.add(key);
        else
            sh.delete(key);
        pjvSetShownCols(surface, sh, lid);
        if (card) {
            if (visible)
                card.style.setProperty(PJV_STD_COL_VAR[key], PJV_STD_COL_W[key] || '92px');
            else
                card.style.removeProperty(PJV_STD_COL_VAR[key]);
        }
        return;
    }
    const s = pjvGetHiddenCols(surface, lid);
    if (visible)
        s.delete(key);
    else
        s.add(key);
    pjvSetHiddenCols(surface, s, lid);
    if (card) {
        const cv = pjvColWVar(key);
        if (visible)
            card.style.removeProperty(cv);
        else
            card.style.setProperty(cv, '0px');
    } // pjvColWVar: 기본 키→고정 var, 'f:<id>'→커스텀 var(#710)
}
// 기본 컬럼 헤더 — 라벨 + 호버 ⋯(숨기기). 커스텀 필드 헤더(pjvColumnHead)와 같은 클래스/결.
function pjvStdColHead(surface, key, label) {
    const nameEl = el('span', { class: 'pjv-thcol-name', text: label, title: label });
    if (surface === 'proj' && key !== 'sess')
        pjvHeadSortable(nameEl, key); // 클릭 정렬(#541) — 내 세션 제외
    const cell = el('div', { class: 'pjv-tcell pjv-colhead pjv-stdcol', 'data-col': key }, nameEl); // data-col: 열 순서 드래그(#611)
    const menuBtn = el('button', { class: 'pjv-thcol-menu', type: 'button', text: '⋯', 'aria-label': label + ' 컬럼 옵션' });
    menuBtn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu' });
        const close = pjvPopover(menuBtn, menu);
        const hide = el('button', { class: 'pjv-menu-item', type: 'button' }, el('span', { text: '이 컬럼 숨기기' }));
        hide.onclick = () => { close(); const card = cell.closest('.pjv-tasks-card'); pjvSetStdColVisible(surface, key, false, card); };
        menu.append(hide, el('div', { class: 'pjv-menu-hint', text: '되살리기: 컬럼 추가(＋) → 기본 컬럼' }));
    };
    cell.append(menuBtn);
    cell.append(pjvColResizeHandle(key)); // 컬럼 폭 드래그(#666) — 헤더 우측 경계
    return cell;
}
// Fields(컬럼 추가) 패널의 '기본 컬럼' 섹션 — 각 기본 컬럼의 보임/숨김 토글(되살리기 진입점).
//  스코프(#710): 카드의 현재 리스트(dataset.colList)면 그 리스트만·전체 구성원 공유, 없으면 보드 전역(per-user).
function pjvDefaultColsSection(surface, card) {
    const lid = (card && card.dataset.colList) || null;
    const list = pjvListOf(lid);
    const sec = el('div', { class: 'pjv-fields-defcols' });
    sec.append(el('div', { class: 'pjv-fields-sec', text: '기본 컬럼' + (list ? ' · 이 리스트' : '') }));
    for (const c of PJV_STD_COLS[surface]) {
        const row = el('button', { class: 'pjv-defcol-row', type: 'button' });
        const toggle = el('span', { class: 'pjv-defcol-toggle', 'aria-hidden': 'true' });
        const paint = (on) => { toggle.classList.toggle('on', on); row.setAttribute('aria-pressed', String(on)); };
        paint(pjvStdColVisible(surface, c.key, lid)); // 기본숨김(defaultHidden)=shown-set 기준(#541); 리스트 스코프면 그 리스트 기준(#710)
        row.append(el('span', { class: 'pjv-defcol-name', text: c.label }), toggle);
        row.onclick = () => { const on = !toggle.classList.contains('on'); pjvSetStdColVisible(surface, c.key, on, card); paint(on); };
        sec.append(row);
    }
    if (list)
        sec.append(el('div', { class: 'pjv-menu-hint', text: '이 리스트에만 적용 · 전체 구성원 공유' }));
    return sec;
}
// Fields 패널 '커스텀 필드' 섹션(#710 확장) — 이 스코프의 커스텀 필드 표시/숨김 토글(헤더 ⋯ '이 컬럼 숨기기'의 되살리기 진입점).
//  프로젝트 보드 전용(pjvBoardFieldsCur = board.fields). 스코프는 카드의 dataset.colList(기본 컬럼 섹션과 동일 규칙). 필드 없으면 null.
function pjvCustomColsSection(card, reload) {
    const lid = (card && card.dataset.colList) || null;
    const fields = pjvFieldsForList(pjvBoardFieldsCur, lid); // 이 리스트 스코프의 커스텀 필드(#607/D 전역+리스트전용)
    if (!fields.length)
        return null;
    const list = pjvListOf(lid);
    const sec = el('div', { class: 'pjv-fields-defcols' });
    sec.append(el('div', { class: 'pjv-fields-sec', text: '커스텀 필드' + (list ? ' · 이 리스트' : '') }));
    for (const f of fields) {
        const key = 'f:' + f.id;
        const row = el('button', { class: 'pjv-defcol-row', type: 'button' });
        const toggle = el('span', { class: 'pjv-defcol-toggle', 'aria-hidden': 'true' });
        const paint = (on) => { toggle.classList.toggle('on', on); row.setAttribute('aria-pressed', String(on)); };
        paint(pjvStdColVisible('proj', key, lid)); // 커스텀 키도 hidden-set 기준(#710)
        row.append(el('span', { class: 'pjv-defcol-name', text: f.name || key }), toggle);
        row.onclick = () => { const on = !toggle.classList.contains('on'); pjvSetStdColVisible('proj', key, on, card); paint(on); };
        sec.append(row);
    }
    if (list)
        sec.append(el('div', { class: 'pjv-menu-hint', text: '이 리스트에만 적용 · 전체 구성원 공유' }));
    return sec;
}
// ── 그룹 내 컬럼 정렬(#541) — 헤더 클릭 3-state(오름→내림→해제). 기본값 = ClickUp 뷰 sorting.fields[0]. ──
//  key: 'name'|'team'|'due'|'start'|'created'|'updated'|'priority'|'cu:<externalId>'. 저장값 {key,dir} | {off:true}(뷰 기본도 끔).
const PJV_CU_SORT_MAP = { name: 'name', assignee: 'team', assignees: 'team', dueDate: 'due', due_date: 'due', duedate: 'due', startDate: 'start', start_date: 'start', dateCreated: 'created', date_created: 'created', dateUpdated: 'updated', date_updated: 'updated', priority: 'priority' };
function pjvColSortStoreKey(listId) { return 'pjv:colSort:' + (listId == null ? 'all' : listId); }
function pjvGetColSort(selList, cu) {
    try {
        const v = JSON.parse(localStorage.getItem(pjvColSortStoreKey(selList && selList.id)) || 'null');
        if (v && v.off)
            return null;
        if (v && v.key)
            return { key: v.key, dir: v.dir === -1 ? -1 : 1 };
    }
    catch (_) { /* noop */ }
    const s = cu && Array.isArray(cu.view_sorting) ? cu.view_sorting[0] : null;
    if (s && s.field) {
        const k = PJV_CU_SORT_MAP[String(s.field)] || ('cu:' + s.field);
        return { key: k, dir: (s.dir === -1 || s.dir === 'desc') ? -1 : 1, fromView: true };
    }
    return null;
}
function pjvSetColSort(selList, v) {
    try {
        if (v == null)
            localStorage.removeItem(pjvColSortStoreKey(selList && selList.id));
        else
            localStorage.setItem(pjvColSortStoreKey(selList && selList.id), JSON.stringify(v));
    }
    catch (_) { /* noop */ }
}
// 컬럼 헤더 클릭 정렬(#541) — 라벨 클릭 시 오름→내림→해제 순환. pjvSortCtx(현재 리스트 스코프)가 있을 때만.
function pjvHeadSortable(labelEl, colKey) {
    if (!pjvSortCtx)
        return;
    const ctx = pjvSortCtx;
    const cur = ctx.colSort;
    if (cur && cur.key === colKey)
        labelEl.append(el('span', { class: 'pjv-sort-ind', text: cur.dir === -1 ? '↓' : '↑', 'aria-hidden': 'true' }));
    labelEl.classList.add('pjv-sortable'); // 커서/호버 어포던스는 실제 리스너가 붙은 헤더만(#541 리뷰 — 거짓 어포던스 방지)
    labelEl.title = '클릭해서 정렬 (오름 → 내림 → 해제)';
    labelEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const now = ctx.colSort;
        let next;
        if (!now || now.key !== colKey)
            next = { key: colKey, dir: 1 };
        else if (now.dir === 1)
            next = { key: colKey, dir: -1 };
        else
            next = { off: true }; // 해제 — 뷰 기본 정렬(view_sorting)까지 끄는 명시 off(다음 클릭이 덮어씀).
        pjvSetColSort(ctx.selList, next);
        ctx.rerender();
    });
}
export { PJV_CU_SORT_MAP, PJV_STD_COLS, PJV_STD_COL_VAR, PJV_STD_COL_W, pjvApplyColOrder, pjvApplyColWidths, pjvApplyHiddenCols, pjvBoardFieldsCur, pjvColResizeHandle, pjvColSortStoreKey, pjvCustomColsSection, pjvDefaultColsSection, pjvFieldsForList, pjvGetColSort, pjvGetShownCols, pjvGridTemplate, pjvHeadSortable, pjvInitNameResize, pjvNameResizeHandle, pjvProjGridTemplate, pjvSetColSort, pjvSetListRegistry, pjvSetStdColVisible, pjvStdColHead, pjvWireColReorder, setBoardFieldsCur, };

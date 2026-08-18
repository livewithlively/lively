// editor/table.ts — #1685 표 즉시 편집.
//  표는 parse.ts 가 `raw` 블록(마크다운 원문 보존)으로 잘라 두는데, 예전엔 그 미리보기를 클릭하면 통째로
//  textarea 원문 편집으로 바뀌었다 — 셀 한 칸 고치려고 파이프 정렬을 손으로 맞춰야 했다.
//  여기서는 같은 raw 블록을 **셀이 곧 편집칸인 표**로 그린다:
//   · 셀 = contenteditable — renderInline 으로 그린 서식 위에서 바로 타이핑(인라인 마크는 inlineDomToMd 로 역직렬화).
//   · 입력할 때마다 모델 → 마크다운으로 되돌려 block._raw 를 갱신 — 저장·히스토리 스냅샷 계약(raw 는 md 문자열)은 그대로다.
//   · 행/열 추가·삭제·정렬은 컨트롤 바(표 hover 시 노출). 원문을 직접 만지고 싶으면 MD 칩이 여전히 textarea 를 연다.
//  ⚠ 보안 불변식: 텍스트는 전부 textContent/renderInline 경유(innerHTML 금지) — 붙여넣기도 평문만 받는다.
//  마크다운 ↔ 셀 모델 변환은 lib/table-md.ts(순수·의존 0, 렌더러와 공유)가 맡고 여기는 DOM·상호작용만 다룬다.
import { el, renderInline } from '../core.js';
import { parseTableMd, tableToMd } from '../lib/table-md.js';
import { inlineDomToMd } from './serialize.js';
const ALIGN_CSS = { l: 'left', c: 'center', r: 'right' };
// 편집 가능한 표 DOM. onEdit 은 '셀 내용이 바뀌었다'(구조 변경 포함)를 마크다운으로 알린다.
//  onStructure 는 행/열 추가·삭제처럼 히스토리에서 한 스텝으로 남아야 하는 변경(호출자가 markDirty 로 스냅)을 구분한다.
export function buildTableEditor(md, hooks) {
    const parsed = parseTableMd(md);
    if (!parsed)
        return null;
    const model = parsed;
    const wrap = el('div', { class: 'be-tablewrap' });
    const emit = (structural) => (structural ? hooks.onStructure : hooks.onEdit)(tableToMd(model));
    // 셀 좌표: r = -1 이 헤더 행. 포커스 셀을 기억해 '행/열 삭제'가 어디를 지울지 정한다.
    let focus = { r: 0, c: 0 };
    function cellMd(r, c) { return r < 0 ? (model.head[c] || '') : ((model.rows[r] || [])[c] || ''); }
    function setCellMd(r, c, v) { if (r < 0)
        model.head[c] = v;
    else
        model.rows[r][c] = v; }
    function makeCell(r, c) {
        const tag = r < 0 ? 'th' : 'td';
        const cell = el(tag, { class: 'be-tcell', contenteditable: 'true', spellcheck: 'false' });
        cell.dataset.r = String(r);
        cell.dataset.c = String(c);
        if (ALIGN_CSS[model.align[c]])
            cell.style.textAlign = ALIGN_CSS[model.align[c]];
        for (const n of renderInline(cellMd(r, c)))
            cell.append(n);
        cell.addEventListener('focus', () => { focus = { r, c }; wrap.dataset.col = String(c); });
        cell.addEventListener('input', (e) => {
            e.stopPropagation(); // 에디터 input 훅(마크다운 단축 변환·멘션)은 .be-text 전용이다
            setCellMd(r, c, inlineDomToMd(cell).replace(/\n/g, ' '));
            emit(false);
        });
        // 붙여넣기는 평문만 — 표 셀에 남의 HTML 이 들어오면 렌더러의 textContent 불변식 밖으로 샌다.
        cell.addEventListener('paste', (e) => {
            const text = (e.clipboardData || window.clipboardData)?.getData('text/plain');
            if (text == null)
                return;
            e.preventDefault();
            e.stopPropagation();
            document.execCommand('insertText', false, String(text).replace(/\r?\n/g, ' '));
        });
        cell.addEventListener('keydown', (e) => {
            // 에디터 전역 키핸들러는 셀 안에서 작동하면 안 된다 — Backspace 는 raw 블록을 통째로 지우고(keys.ts 래퍼 분기),
            //  ⌘A 는 블록 범위 선택으로 번진다. 문서 수준 단축키(저장 ⌘S · 실행취소 ⌘Z/⌘⇧Z/Ctrl+Y)만 통과시킨다 —
            //  표 내용은 raw 블록의 md 로 히스토리에 담기므로 ⌘Z 는 에디터 스택이 정상적으로 되돌린다.
            const k = (e.key || '').toLowerCase();
            if (!((e.metaKey || e.ctrlKey) && (k === 's' || k === 'z' || k === 'y')))
                e.stopPropagation();
            if (e.key === 'Tab') {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                if (r >= 0 && r === model.rows.length - 1) {
                    addRow();
                    return;
                } // 마지막 행에서 Enter = 행 추가
                moveTo(r + 1, c);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                cell.blur();
            }
        });
        return cell;
    }
    function paint() {
        const table = el('table', { class: 'md-table be-table' });
        const headerEmpty = model.head.every((c) => !String(c).trim());
        // 헤더가 비어도 편집하려면 칸이 있어야 한다 — thead 는 늘 그리되 '빈 헤더' 표시만 남긴다(#551 무손실 유지).
        const thead = el('thead');
        const htr = el('tr');
        for (let c = 0; c < model.align.length; c++)
            htr.append(makeCell(-1, c));
        thead.append(htr);
        table.append(thead);
        if (headerEmpty)
            table.classList.add('be-table-nohead');
        const tbody = el('tbody');
        for (let r = 0; r < model.rows.length; r++) {
            const tr = el('tr');
            for (let c = 0; c < model.align.length; c++)
                tr.append(makeCell(r, c));
            tbody.append(tr);
        }
        table.append(tbody);
        wrap.replaceChildren(table, controls());
    }
    function cellEl(r, c) {
        return wrap.querySelector('.be-tcell[data-r="' + r + '"][data-c="' + c + '"]');
    }
    function moveTo(r, c) {
        const t = cellEl(r, c);
        if (!t)
            return;
        t.focus();
        const range = document.createRange();
        range.selectNodeContents(t);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }
    // Tab 이동 — 행 끝에서 다음 행으로 넘어가고, 표 끝에서 한 번 더 누르면 행이 늘어난다(노션 감각).
    function step(dir) {
        const cols = model.align.length;
        let r = focus.r, c = focus.c + dir;
        if (c >= cols) {
            c = 0;
            r++;
        }
        if (c < 0) {
            c = cols - 1;
            r--;
        }
        if (r < -1)
            return;
        if (r >= model.rows.length) {
            addRow();
            return;
        }
        moveTo(r, c);
    }
    function addRow() {
        model.rows.push(Array.from({ length: model.align.length }, () => ''));
        emit(true);
        paint();
        moveTo(model.rows.length - 1, 0);
    }
    function addCol() {
        model.head.push('');
        model.align.push('');
        for (const r of model.rows)
            r.push('');
        emit(true);
        paint();
        moveTo(focus.r, model.align.length - 1);
    }
    function delRow() {
        if (focus.r < 0 || model.rows.length <= 1)
            return; // 헤더와 마지막 한 행은 남긴다
        model.rows.splice(focus.r, 1);
        emit(true);
        paint();
        moveTo(Math.min(focus.r, model.rows.length - 1), focus.c);
    }
    function delCol() {
        if (model.align.length <= 1)
            return;
        const c = focus.c;
        model.head.splice(c, 1);
        model.align.splice(c, 1);
        for (const r of model.rows)
            r.splice(c, 1);
        emit(true);
        paint();
        moveTo(focus.r, Math.min(c, model.align.length - 1));
    }
    function cycleAlign() {
        const order = ['', 'c', 'r', 'l'];
        const c = focus.c;
        model.align[c] = order[(order.indexOf(model.align[c]) + 1) % order.length];
        emit(true);
        paint();
        moveTo(focus.r, c);
    }
    function controls() {
        const bar = el('div', { class: 'be-tctl', contenteditable: 'false' });
        const btn = (label, title, fn) => {
            const b = el('button', { class: 'be-tctl-b', type: 'button', title, text: label });
            // mousedown 에서 막아야 셀 blur 전에 focus 좌표가 살아 있다(어느 행/열을 지울지의 근거).
            b.addEventListener('mousedown', (e) => e.preventDefault());
            b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
            return b;
        };
        bar.append(btn('＋행', '아래에 행 추가 (표 끝에서 Tab·Enter 도 같은 동작)', addRow), btn('＋열', '오른쪽에 열 추가', addCol), btn('행 삭제', '커서가 있는 행 삭제', delRow), btn('열 삭제', '커서가 있는 열 삭제', delCol), btn('정렬', '커서가 있는 열의 정렬 바꾸기 (기본 → 가운데 → 오른쪽 → 왼쪽)', cycleAlign));
        return bar;
    }
    paint();
    return wrap;
}

// block-editor.ts — #657 노션형 블록 에디터(WYSIWYG). 지식 본문(markdown)을 블록 단위로 직접 편집한다.
//  · 저장 포맷은 그대로 markdown(body_md) — 에이전트/MCP/기존 렌더러와 완전 호환(파스↔직렬화 왕복).
//  · 지원 블록: 문단·제목1-3·글머리/번호/할일 목록(들여쓰기)·인용·콜아웃·코드·구분선·이미지(인라인).
//    표·토글·수식 등 에디터가 구조적으로 못 다루는 마크다운은 'raw 블록'(렌더 미리보기 + 원문 편집)으로 무손실 보존.
//  · 입력 UX: '/' 슬래시 메뉴, 마크다운 단축(#·-·1.·[]·>·```·---), 선택 시 인라인 서식 툴바(굵게/기울임/…/링크),
//    ⋮⋮ 드래그 재정렬, ＋ 블록 추가, Enter 분할·Backspace 병합, Tab 들여쓰기. 한국어 IME 조합 가드(#505 동형).
//  · 보안 불변식 유지: innerHTML 금지 — 모든 DOM 은 el/renderInline/renderMarkdown(전부 textContent 기반)로만.
//  순환 import 금지: core/learn/page-decor 만 import (knowledge-doc/knowledge-edit/category-home 이 이 모듈을 쓴다).
import { api, el, renderCollection, renderInline, renderMarkdown, safeHref, toast } from './core.js';
import { overlayBox } from './learn.js';
import { openEmojiPicker } from './page-decor.js';
// ── 블록 데이터 모델 ──
//  { type, text?, level?, indent?, checked?, lang?, icon?, color? } — text 는 inline-markdown(개행 = 소프트 브레이크).
//  #657n 중첩 블록(노션 패리티): toggle { summary, children:[블록…] } · columns { cols:[[블록…],…] }
//  — notion-md ::: 방언(:::toggle / :::columns>:::column)으로 무손실 직렬화, 파스 실패는 raw 폴백.
const TEXTY = new Set(['p', 'h', 'bullet', 'numbered', 'todo', 'quote', 'callout', 'toggle']);
const LISTY = new Set(['bullet', 'numbered', 'todo']);
const CALLOUT_COLORS = ['default', 'gray', 'yellow', 'green', 'red', 'purple'];
// ════════════════════════════════════════════
// §1 markdown → 블록 파서 — core.renderMarkdown 의 블록 규칙과 1:1(같은 문법을 블록 데이터로).
// ════════════════════════════════════════════
function mdToBlocks(md) {
    const out = [];
    const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
    const isTableSep = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.indexOf('-') >= 0;
    const contOpen = (l) => /^:::\s*[a-zA-Z_-]/.test(l);
    const contClose = (l) => l.trim() === ':::';
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '') {
            i++;
            continue;
        }
        // 코드 펜스 ``` / ~~~
        const fence = /^(```|~~~)(.*)$/.exec(line);
        if (fence) {
            const marker = fence[1];
            const code = [];
            i++;
            while (i < lines.length && lines[i].trimEnd() !== marker && !lines[i].startsWith(marker)) {
                code.push(lines[i]);
                i++;
            }
            if (i < lines.length)
                i++;
            out.push({ type: 'code', lang: (fence[2] || '').trim(), text: code.join('\n') });
            continue;
        }
        // ::: 컨테이너 — callout(중첩 없음)·toggle(내용 재귀)·columns(:::column 재귀)는 1급 블록(#657n),
        //  그 외(synced/toc/미지)와 파스 실패는 raw 로 무손실 보존.
        const cont = /^:::\s*([a-zA-Z_-]+)\s*(.*)$/.exec(line);
        if (cont) {
            const rawLines = [line];
            const body = [];
            let depth = 1, nested = false, inFence = false, closed = false;
            i++;
            while (i < lines.length && depth > 0) {
                const l = lines[i];
                if (/^(```|~~~)/.test(l))
                    inFence = !inFence;
                else if (!inFence && contOpen(l)) {
                    depth++;
                    nested = true;
                }
                else if (!inFence && contClose(l)) {
                    depth--;
                    if (depth === 0) {
                        rawLines.push(l);
                        i++;
                        closed = true;
                        break;
                    }
                }
                rawLines.push(l);
                body.push(l);
                i++;
            }
            if (cont[1] === 'callout' && closed && !nested) {
                const attrs = {};
                for (const tok of String(cont[2] || '').split(/\s+/)) {
                    const m = /^([a-zA-Z_-]+)=(.*)$/.exec(tok);
                    if (m)
                        attrs[m[1]] = m[2];
                }
                const color = String(attrs.color || '').replace(/_background$/, '').replace(/[^a-z]/g, '') || 'default';
                out.push({ type: 'callout', icon: attrs.icon || '💡', color: CALLOUT_COLORS.includes(color) ? color : 'default', text: body.join('\n') });
            }
            else if ((cont[1] === 'toggle' || cont[1] === 'template') && closed) {
                // 토글 — 요약(선두 attr 토큰 제외한 rest, renderContainer 동일 규칙) + 내용 재귀 파스. template 은 노션 미러 방언.
                let summary = '';
                for (const tok of String(cont[2] || '').split(/\s+/)) {
                    if (!tok)
                        continue;
                    if (!summary && /^[a-zA-Z_-]+=/.test(tok))
                        continue;
                    summary += (summary ? ' ' : '') + tok;
                }
                out.push({ type: 'toggle', summary, children: body.join('\n').trim() ? mdToBlocks(body.join('\n')) : [] });
            }
            else if (cont[1] === 'columns' && closed) {
                const cols = parseColumns(body);
                if (cols && cols.length)
                    out.push({ type: 'columns', cols });
                else
                    out.push({ type: 'raw', text: rawLines.join('\n') });
            }
            else if (cont[1] === 'collection' && closed) {
                // #657w 라이브 컬렉션 — 본문 없는 설정 컨테이너. attrs 만 블록 데이터로.
                const attrs = {};
                for (const tok of String(cont[2] || '').split(/\s+/)) {
                    const m = /^([a-zA-Z_-]+)=(.*)$/.exec(tok);
                    if (m)
                        attrs[m[1]] = m[2];
                }
                out.push({ type: 'collection', attrs });
            }
            else {
                out.push({ type: 'raw', text: rawLines.join('\n') });
            }
            continue;
        }
        if (contClose(line)) {
            out.push({ type: 'raw', text: line });
            i++;
            continue;
        }
        // 수식 $$…$$ — raw 보존.
        if (line.trim() === '$$') {
            let close = -1;
            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].trim() === '$$') {
                    close = j;
                    break;
                }
            }
            if (close >= 0) {
                out.push({ type: 'raw', text: lines.slice(i, close + 1).join('\n') });
                i = close + 1;
            }
            else {
                out.push({ type: 'raw', text: line });
                i++;
            }
            continue;
        }
        // 표 — raw 보존(렌더 미리보기 + 원문 편집).
        if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
            const tbl = [line, lines[i + 1]];
            i += 2;
            while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') >= 0) {
                tbl.push(lines[i]);
                i++;
            }
            out.push({ type: 'raw', text: tbl.join('\n') });
            continue;
        }
        // 제목
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) {
            out.push({ type: 'h', level: Math.min(h[1].length, 6), text: h[2].trim() });
            i++;
            continue;
        }
        // 구분선
        if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            out.push({ type: 'divider' });
            i++;
            continue;
        }
        // 인용(연속 줄 = 한 블록)
        if (/^\s*>\s?/.test(line)) {
            const quote = [];
            while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
                quote.push(lines[i].replace(/^\s*>\s?/, ''));
                i++;
            }
            out.push({ type: 'quote', text: quote.join('\n') });
            continue;
        }
        // 리스트 — 항목 1개 = 블록 1개(indent 유지). 이어지는 들여쓴 평문 줄은 직전 항목에 합류(렌더러와 동일).
        const bulletRe = /^(\s*)([-*+])\s+(.*)$/;
        const orderedRe = /^(\s*)(\d+)[.)]\s+(.*)$/;
        if (bulletRe.test(line) || orderedRe.test(line)) {
            while (i < lines.length) {
                const l = lines[i];
                const bm = bulletRe.exec(l);
                const om = bm ? null : orderedRe.exec(l);
                if (bm || om) {
                    const m = bm || om;
                    const indent = Math.min(Math.floor(m[1].replace(/\t/g, '  ').length / 2), 4);
                    let text = m[3];
                    let checked = null;
                    if (bm) {
                        const cb = /^\[( |x|X)\]\s+(.*)$/.exec(text);
                        if (cb) {
                            checked = cb[1] !== ' ';
                            text = cb[2];
                        }
                    }
                    out.push({ type: checked != null ? 'todo' : (om ? 'numbered' : 'bullet'), indent, checked: !!checked, text });
                    i++;
                    continue;
                }
                if (l.trim() !== '' && /^\s+/.test(l) && out.length && LISTY.has(out[out.length - 1].type)) {
                    out[out.length - 1].text += ' ' + l.trim();
                    i++;
                    continue;
                }
                break;
            }
            continue;
        }
        // 문단 — 다음 블록 경계 전까지(줄바꿈은 소프트 브레이크로 보존).
        const para = [];
        while (i < lines.length) {
            const l = lines[i];
            if (l.trim() === '')
                break;
            if (/^(#{1,6})\s+/.test(l) || /^(```|~~~)/.test(l) || /^\s*>\s?/.test(l) ||
                /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l) || /^(\s*)([-*+])\s+/.test(l) ||
                /^(\s*)(\d+)[.)]\s+/.test(l) || contOpen(l) || contClose(l) || l.trim() === '$$' ||
                (l.indexOf('|') >= 0 && lines[i + 1] != null && isTableSep(lines[i + 1])))
                break;
            para.push(l);
            i++;
        }
        // 이스케이프 해제는 renderInline 이 렌더 시 처리 — 파서는 원문 유지(직렬화가 재이스케이프).
        // #657w 페이지 카드 승격 — '내부 링크뿐인 줄'은 pagecard 블록으로 분리(core renderMarkdown 과 동일 규칙).
        let buf = [];
        const flushBuf = () => { if (buf.length) {
            out.push({ type: 'p', text: buf.join('\n') });
            buf = [];
        } };
        for (const l of para) {
            const pc = /^\s*\[([^\]\n]+)\]\(#\/k\/([^)\s]+)\)\s*$/.exec(l);
            if (pc) {
                flushBuf();
                let nm = pc[2];
                try {
                    nm = decodeURIComponent(pc[2]);
                }
                catch (_) { /* 인코딩 오류 — 원문 유지 */ }
                out.push({ type: 'pagecard', name: nm, label: pc[1] });
            }
            else
                buf.push(l);
        }
        flushBuf();
    }
    if (!out.length)
        out.push({ type: 'p', text: '' });
    return out;
}
// :::columns 본문 → 컬럼별 블록 배열(본문이 :::column 컨테이너로만 구성돼야 성립 — 아니면 null=raw 폴백).
function parseColumns(lines) {
    const cols = [];
    const contOpen = (l) => /^:::\s*[a-zA-Z_-]/.test(l);
    const contClose = (l) => l.trim() === ':::';
    let i = 0;
    while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') {
            i++;
            continue;
        }
        if (!/^:::\s*column(\s|$)/.test(l))
            return null;
        const body = [];
        let depth = 1, inFence = false, closed = false;
        i++;
        while (i < lines.length && depth > 0) {
            const s = lines[i];
            if (/^(```|~~~)/.test(s))
                inFence = !inFence;
            else if (!inFence && contOpen(s))
                depth++;
            else if (!inFence && contClose(s)) {
                depth--;
                if (depth === 0) {
                    i++;
                    closed = true;
                    break;
                }
            }
            body.push(s);
            i++;
        }
        if (!closed)
            return null;
        cols.push(body.join('\n').trim() ? mdToBlocks(body.join('\n')) : []);
    }
    return cols;
}
// ════════════════════════════════════════════
// §2 블록 → markdown 직렬화 — 왕복 보존이 목표(리스트 마커 '-'·번호 재부여 정도의 정규화만).
// ════════════════════════════════════════════
// 평문 텍스트 노드 이스케이프 — 다음 로드에서 인라인 마크로 오파싱될 문자만 최소로(모두 renderInline 이스케이프 목록 내).
//  ZWSP(U+200B)는 인라인 변환의 캐럿 패딩(마크 지속 차단) 잔재 — 직렬화에서 제거.
function escInline(s) {
    return String(s)
        .replace(/\u200B/g, '')
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\*/g, '\\*')
        .replace(/~~/g, '\\~~')
        .replace(/\+\+/g, '\\++')
        .replace(/\[/g, '\\[');
}
// 문단 줄이 블록 문법으로 재파싱되지 않게 줄머리만 이스케이프.
function escLineStart(l) {
    if (/^(#{1,6})\s/.test(l))
        return '\\' + l;
    if (/^(\s*)([-*+])\s/.test(l))
        return l.replace(/([-*+])/, '\\$1');
    if (/^(\s*)(\d+)([.)])\s/.test(l))
        return l.replace(/([.)])/, '\\$1');
    if (/^>/.test(l))
        return '\\' + l;
    if (/^\|/.test(l))
        return '\\' + l;
    if (/^(-{3,}|_{3,})\s*$/.test(l))
        return '\\' + l;
    return l;
}
// 인라인 DOM → markdown. renderInline 의 역함수(strong/em/del/u/mark/code/a/img/br).
function inlineDomToMd(node) {
    let out = '';
    for (const c of node.childNodes) {
        if (c.nodeType === 3) {
            out += escInline(c.textContent);
            continue;
        }
        if (c.nodeType !== 1)
            continue;
        const tag = c.tagName;
        if (tag === 'BR') {
            out += '\n';
            continue;
        }
        if (tag === 'IMG') {
            const src = c.dataset && c.dataset.mdSrc ? c.dataset.mdSrc : (c.getAttribute('src') || '');
            out += '![' + String(c.getAttribute('alt') || '').replace(/\]/g, '') + '](' + src + ')';
            continue;
        }
        const inner = inlineDomToMd(c);
        if (tag === 'A') {
            out += '[' + inner + '](' + (c.getAttribute('href') || '') + ')';
            continue;
        }
        if (tag === 'CODE') {
            out += '`' + c.textContent.replace(/`/g, '').replace(/\u200B/g, '') + '`';
            continue;
        }
        if (!inner)
            continue; // 빈 마크는 버림
        if (tag === 'STRONG' || tag === 'B')
            out += '**' + inner + '**';
        else if (tag === 'EM' || tag === 'I')
            out += '*' + inner + '*';
        else if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE')
            out += '~~' + inner + '~~';
        else if (tag === 'U')
            out += '++' + inner + '++';
        else if (tag === 'MARK')
            out += '==' + inner + '==';
        else
            out += inner; // span 등 미지 요소는 투명(내용만)
    }
    return out;
}
function blocksToMd(blocks) {
    const chunks = [];
    let i = 0;
    while (i < blocks.length) {
        const b = blocks[i];
        if (LISTY.has(b.type)) {
            // 연속 리스트 블록 = 한 run(항목 사이 빈 줄 없음). 번호는 (indent별) 재부여.
            const lines = [];
            const counters = [];
            let j = i;
            while (j < blocks.length && LISTY.has(blocks[j].type)) {
                const it = blocks[j];
                const d = Math.min(it.indent || 0, 4);
                counters.length = d + 1; // 더 깊은 카운터 리셋
                let marker = '-';
                if (it.type === 'numbered') {
                    counters[d] = (counters[d] || 0) + 1;
                    marker = counters[d] + '.';
                }
                else
                    counters[d] = 0;
                const text = String(it.text || '').replace(/\n+/g, ' ');
                lines.push('  '.repeat(d) + marker + ' ' + (it.type === 'todo' ? (it.checked ? '[x] ' : '[ ] ') : '') + text);
                j++;
            }
            chunks.push(lines.join('\n'));
            i = j;
            continue;
        }
        switch (b.type) {
            case 'p':
                chunks.push(String(b.text || '').split('\n').map(escLineStart).join('\n'));
                break;
            case 'h':
                chunks.push('#'.repeat(Math.min(Math.max(b.level || 1, 1), 6)) + ' ' + String(b.text || '').replace(/\n+/g, ' '));
                break;
            case 'quote':
                chunks.push(String(b.text || '').split('\n').map((l) => '> ' + l).join('\n'));
                break;
            case 'callout': {
                const attrs = ' icon=' + (b.icon || '💡') + (b.color && b.color !== 'default' ? ' color=' + b.color + '_background' : '');
                chunks.push(':::callout' + attrs + '\n' + String(b.text || '') + '\n:::');
                break;
            }
            case 'code': {
                const body = String(b.text || '');
                const marker = body.includes('```') ? '~~~' : '```';
                chunks.push(marker + (b.lang || '') + '\n' + body + '\n' + marker);
                break;
            }
            case 'toggle': {
                const inner = blocksToMd(b.children || []);
                const sum = String(b.summary || '').replace(/\n+/g, ' ').trim();
                chunks.push(':::toggle' + (sum ? ' ' + sum : '') + '\n' + (inner ? inner + '\n' : '') + ':::');
                break;
            }
            case 'columns': {
                // 실질 1열 이하로 줄면 컨테이너를 벗겨 평범한 블록 흐름으로(노션의 컬럼 해체와 동일).
                const cols = (b.cols || []).filter((c) => Array.isArray(c) && blocksToMd(c) !== '');
                if (!cols.length)
                    break;
                if (cols.length === 1) {
                    chunks.push(blocksToMd(cols[0]));
                    break;
                }
                chunks.push(':::columns\n' + cols.map((c) => ':::column\n' + blocksToMd(c) + '\n:::').join('\n') + '\n:::');
                break;
            }
            case 'pagecard':
                // 순수 md 링크 한 줄 — 어떤 소비자에게도 평범한 링크로 안전 강등(#657w).
                chunks.push('[' + String(b.label || b.name || '').replace(/[\[\]]/g, ' ').trim() + '](#/k/' + encodeURIComponent(b.name || '') + ')');
                break;
            case 'collection': {
                const a = b.attrs || {};
                let line = ':::collection';
                if (a.category)
                    line += ' category=' + a.category;
                if (a.type)
                    line += ' type=' + a.type;
                line += ' limit=' + Math.min(Math.max(Number(a.limit) || 5, 1), 12);
                if (a.view === 'cards')
                    line += ' view=cards';
                if (a.sort === 'title')
                    line += ' sort=title';
                chunks.push(line + '\n:::');
                break;
            }
            case 'divider':
                chunks.push('---');
                break;
            case 'raw':
                chunks.push(String(b.text || '').replace(/\n+$/, ''));
                break;
            default:
                chunks.push(String(b.text || ''));
        }
        i++;
    }
    return chunks.filter((c) => c !== '').join('\n\n');
}
// ════════════════════════════════════════════
// §3 캐럿/선택 헬퍼
// ════════════════════════════════════════════
function caretRange() {
    const s = window.getSelection();
    return s && s.rangeCount ? s.getRangeAt(0) : null;
}
function caretAtStart(box) {
    const r = caretRange();
    if (!r || !r.collapsed || !box.contains(r.startContainer))
        return false;
    const pre = document.createRange();
    pre.selectNodeContents(box);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().length === 0;
}
function caretAtEnd(box) {
    const r = caretRange();
    if (!r || !r.collapsed || !box.contains(r.endContainer))
        return false;
    const post = document.createRange();
    post.selectNodeContents(box);
    post.setStart(r.endContainer, r.endOffset);
    return post.toString().length === 0;
}
function placeCaret(box, atStart) {
    const r = document.createRange();
    r.selectNodeContents(box);
    r.collapse(atStart);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
}
// 캐럿 이후 내용을 잘라내 반환(블록 분할용).
function extractAfterCaret(box) {
    const r = caretRange();
    const rest = document.createRange();
    rest.selectNodeContents(box);
    rest.setStart(r.endContainer, r.endOffset);
    return rest.extractContents();
}
function insertText(str) { document.execCommand('insertText', false, str); }
// ════════════════════════════════════════════
// §4 에디터 본체
// ════════════════════════════════════════════
export function createBlockEditor(opts = {}) {
    const root = el('div', { class: 'be', 'data-ph': opts.placeholder || "내용을 입력하세요. '/' 를 누르면 블록 메뉴가 열립니다." });
    let dirty = false;
    let composing = false;
    // #657z 실행취소 — 브라우저 네이티브 undo 는 구조 변경(드래그·전환·삭제·컬럼…)을 모른다 →
    //  에디터가 마크다운 스냅샷 스택을 직접 소유(⌘Z/⌘⇧Z·Ctrl+Y). 타이핑은 유휴 600ms 로 묶고,
    //  구조 연산은 setTimeout(0) 코얼레싱으로 '한 연산 = 한 스텝'(복합 연산도 동기 프레임 끝 상태 1장).
    let histLock = false;
    const markDirty = () => { dirty = true; if (!histLock)
        snapSoon(); if (opts.onChange)
        opts.onChange(); }; // 구조 변경 — 즉시 스냅샷(프레임 단위 코얼레싱)
    const markDirtyType = () => { dirty = true; if (!histLock)
        snapLater(); if (opts.onChange)
        opts.onChange(); }; // 타이핑 — 유휴 600ms 버스트 단위
    // ── 블록 DOM 생성 ──
    function textDiv(cls, mdText, ph) {
        const t = el('div', { class: 'be-text ' + cls, contenteditable: 'true', ...(ph ? { 'data-ph': ph } : {}) });
        loadInline(t, mdText || '');
        return t;
    }
    // inline md → DOM (개행 = <br>). renderInline 재사용(보안 렌더 단일 소스).
    function loadInline(box, mdText) {
        box.replaceChildren();
        const lns = String(mdText).split('\n');
        lns.forEach((l, idx) => {
            if (idx > 0)
                box.append(el('br'));
            for (const n of renderInline(l))
                box.append(n);
        });
    }
    function makeBlock(d) {
        const block = el('div', { class: 'be-block', 'data-type': d.type });
        const handle = el('button', { class: 'be-handle', type: 'button', tabindex: '-1', draggable: 'true',
            title: '드래그해서 이동', text: '⋮⋮' });
        const add = el('button', { class: 'be-addbtn', type: 'button', tabindex: '-1', title: '아래에 블록 추가', text: '＋' });
        block.append(el('div', { class: 'be-gutter', contenteditable: 'false' }, add, handle));
        const main = el('div', { class: 'be-main' });
        block.append(main);
        switch (d.type) {
            case 'h': {
                const lvl = Math.min(Math.max(d.level || 1, 1), 6);
                block.dataset.level = String(lvl);
                main.append(textDiv('be-h be-h' + Math.min(lvl, 4), d.text, '제목 ' + Math.min(lvl, 4))); // #730 H4 시각 구분(h5·h6 은 h4 스타일 공유)
                break;
            }
            case 'bullet':
            case 'numbered':
            case 'todo': {
                block.dataset.indent = String(Math.min(d.indent || 0, 4));
                const row = el('div', { class: 'be-li' });
                if (d.type === 'todo') {
                    block.dataset.checked = d.checked ? '1' : '';
                    const cb = el('input', { type: 'checkbox', class: 'be-check', tabindex: '-1' });
                    cb.checked = !!d.checked;
                    row.append(el('span', { class: 'be-li-lead', contenteditable: 'false' }, cb));
                }
                else {
                    row.append(el('span', { class: 'be-li-lead be-marker', contenteditable: 'false', text: d.type === 'numbered' ? '1.' : '•' }));
                }
                row.append(textDiv('be-litext' + (d.type === 'todo' && d.checked ? ' be-done' : ''), d.text, '목록'));
                main.append(row);
                break;
            }
            case 'quote':
                main.append(el('div', { class: 'be-quote' }, textDiv('be-qtext', d.text, '인용')));
                break;
            case 'callout': {
                block.dataset.icon = d.icon || '💡';
                block.dataset.color = d.color || 'default';
                const ic = el('button', { class: 'be-callout-ic', type: 'button', contenteditable: 'false',
                    title: '아이콘 변경', text: d.icon || '💡' });
                ic.onclick = () => openEmojiPicker(ic, { onPick: (em) => { ic.textContent = em; block.dataset.icon = em; markDirty(); } });
                const paint = el('button', { class: 'be-callout-paint', type: 'button', contenteditable: 'false', title: '배경색', text: '🎨' });
                paint.onclick = () => openCalloutColors(paint, block);
                main.append(el('div', { class: 'be-callout md-callout-' + (d.color || 'default') }, ic, textDiv('be-ctext', d.text, '콜아웃 내용'), paint));
                break;
            }
            case 'code': {
                block.dataset.lang = d.lang || '';
                const langIn = el('input', { class: 'be-code-lang', type: 'text', placeholder: 'lang', value: d.lang || '',
                    spellcheck: 'false' });
                langIn.addEventListener('input', () => { block.dataset.lang = langIn.value.trim(); markDirtyType(); });
                const codeBox = el('div', { class: 'be-text be-code', contenteditable: 'true', spellcheck: 'false' });
                codeBox.textContent = d.text || '';
                main.append(el('div', { class: 'be-codewrap' }, codeBox, langIn));
                break;
            }
            case 'pagecard': {
                // #657w 페이지 카드 — 문서 스마트 링크(클릭=이동, 드래그·메뉴·삭제는 블록 공통).
                block.dataset.name = d.name || '';
                block.dataset.label = d.label || d.name || '';
                main.append(el('a', { class: 'md-pagecard be-pagecard', contenteditable: 'false', tabindex: '0',
                    href: '#/k/' + encodeURIComponent(d.name || '') }, el('span', { class: 'md-pagecard-ic', 'aria-hidden': 'true', text: '📄' }), el('span', { class: 'md-pagecard-title', text: d.label || d.name || '' }), el('span', { class: 'md-pagecard-arrow', 'aria-hidden': 'true', text: '↗' })));
                addRowDelete(block);
                break;
            }
            case 'collection': {
                // #657w 라이브 컬렉션 — 설정(⚙)형 블록. 미리보기 = core renderCollection(읽기 뷰와 동일 렌더).
                const a = d.attrs || {};
                block.dataset.cat = a.category || '';
                block.dataset.ktype = a.type || '';
                block.dataset.limit = String(Math.min(Math.max(Number(a.limit) || 5, 1), 12));
                block.dataset.view = a.view === 'cards' ? 'cards' : 'list';
                block.dataset.ksort = a.sort === 'title' ? 'title' : 'updated';
                const wrap = el('div', { class: 'be-collection', contenteditable: 'false', tabindex: '0' });
                paintCollection(block, wrap);
                main.append(wrap);
                addRowDelete(block);
                break;
            }
            case 'divider':
                main.append(el('div', { class: 'be-div', tabindex: '0', role: 'separator' }, el('hr')));
                addRowDelete(block);
                break;
            case 'raw': {
                block._raw = String(d.text || '');
                const view = el('div', { class: 'be-raw-view md-rendered', title: '클릭해서 마크다운 원문 편집' });
                view.append(renderMarkdown(block._raw));
                const chip = el('span', { class: 'be-raw-chip', text: 'MD' });
                const wrap = el('div', { class: 'be-raw', tabindex: '0' }, chip, view);
                view.addEventListener('click', () => openRawEditor(block, wrap));
                main.append(wrap);
                addRowDelete(block);
                break;
            }
            case 'toggle': {
                // #657n 토글 — 요약(텍스트) + 접히는 자식 블록 스택(중첩 에디터 영역, 재귀 makeBlock).
                block.dataset.open = '1';
                const caret = el('button', { class: 'be-toggle-caret', type: 'button', contenteditable: 'false',
                    title: '접기/펼치기', text: '▾' });
                const kids = el('div', { class: 'be-togglekids' });
                const children = (d.children && d.children.length) ? d.children : [{ type: 'p', text: '' }];
                for (const c of children)
                    kids.append(makeBlock(c));
                caret.onclick = () => {
                    const open = block.dataset.open !== '1';
                    block.dataset.open = open ? '1' : '';
                    caret.textContent = open ? '▾' : '▸';
                };
                main.append(el('div', { class: 'be-toggle' }, el('div', { class: 'be-toggle-row' }, caret, textDiv('be-togglesum', d.summary || '', '토글 제목')), kids));
                break;
            }
            case 'columns': {
                // #657n 컬럼 — 블록을 나란히(노션 드래그 레이아웃). __shell=드래그 조립용(빈 컬럼 채움 생략).
                const colsWrap = el('div', { class: 'be-cols' });
                const cols = (d.cols && d.cols.length) ? d.cols : [[], []];
                for (const col of cols) {
                    const colEl = el('div', { class: 'be-col' });
                    const items = (col && col.length) ? col : (d.__shell ? [] : [{ type: 'p', text: '' }]);
                    for (const c of items)
                        colEl.append(makeBlock(c));
                    colsWrap.append(colEl);
                }
                main.append(colsWrap);
                break;
            }
            default: // p
                main.append(textDiv('be-p', d.text, "내용 입력 · '/' 블록 메뉴"));
        }
        return block;
    }
    // 구분선/raw/카드/컬렉션 블록 hover ✕ 삭제 버튼.
    function addRowDelete(block) {
        const x = el('button', { class: 'be-block-x', type: 'button', title: '블록 삭제', text: '✕' });
        x.onclick = () => deleteBlock(block);
        block.append(x);
    }
    // #657w 컬렉션 미리보기 + ⚙ 설정 — 헤더(요약 라벨·설정)와 라이브 목록(renderCollection — 읽기 뷰와 동일).
    const COLL_TYPE_LABEL = { decision: '결정', concept: '개념', 'how-to': 'How-to', reference: '참조', research: '리서치', entity: '엔티티' };
    function collAttrsOf(block) {
        return {
            category: block.dataset.cat || undefined,
            type: block.dataset.ktype || undefined,
            limit: Number(block.dataset.limit) || 5,
            view: block.dataset.view === 'cards' ? 'cards' : 'list',
            sort: block.dataset.ksort === 'title' ? 'title' : 'updated',
        };
    }
    function paintCollection(block, wrap) {
        const a = collAttrsOf(block);
        const label = (a.category ? '분류 ' + a.category : '전체') + (a.type ? ' · ' + (COLL_TYPE_LABEL[a.type] || a.type) : '')
            + ' · ' + a.limit + '개' + (a.sort === 'title' ? ' · 제목순' : ' · 최신순');
        const gear = el('button', { class: 'be-coll-gear', type: 'button', title: '컬렉션 조건 설정', text: '⚙ 설정' });
        gear.onclick = () => openCollectionConfig(block, wrap, gear);
        wrap.replaceChildren(el('div', { class: 'be-coll-head' }, el('span', { class: 'be-coll-chip', text: '▤ 컬렉션' }), el('span', { class: 'be-coll-label', text: label }), gear), renderCollection(a));
    }
    function openCollectionConfig(block, wrap, anchor) {
        const old = document.querySelector('.be-collpop');
        if (old) {
            old.remove();
            return;
        }
        const catSel = el('select', { class: 'be-collpop-sel' }, el('option', { value: '', text: '전체 카테고리' }));
        api('/api/ui/categories').then((d) => {
            for (const c of (d && d.categories) || [])
                catSel.append(el('option', { value: c.key, text: c.name || c.key }));
            catSel.value = block.dataset.cat || '';
        }).catch(() => { });
        const typeSel = el('select', { class: 'be-collpop-sel' }, el('option', { value: '', text: '전체 유형' }));
        for (const [v, label] of Object.entries(COLL_TYPE_LABEL))
            typeSel.append(el('option', { value: v, text: label }));
        typeSel.value = block.dataset.ktype || '';
        const limitSel = el('select', { class: 'be-collpop-sel' }, ...[3, 5, 8, 12].map((n) => el('option', { value: String(n), text: n + '개' })));
        limitSel.value = String(Number(block.dataset.limit) || 5);
        const viewSel = el('select', { class: 'be-collpop-sel' }, el('option', { value: 'list', text: '목록' }), el('option', { value: 'cards', text: '카드' }));
        viewSel.value = block.dataset.view === 'cards' ? 'cards' : 'list';
        const sortSel = el('select', { class: 'be-collpop-sel' }, el('option', { value: 'updated', text: '최신순' }), el('option', { value: 'title', text: '제목순' }));
        sortSel.value = block.dataset.ksort === 'title' ? 'title' : 'updated';
        const row = (label, node) => el('div', { class: 'be-collpop-row' }, el('span', { class: 'be-collpop-k', text: label }), node);
        const pop = el('div', { class: 'be-collpop' }, row('분류', catSel), row('유형', typeSel), row('개수', limitSel), row('보기', viewSel), row('정렬', sortSel));
        const close = () => { pop.remove(); document.removeEventListener('mousedown', onDoc, true); };
        const applyNow = () => {
            block.dataset.cat = catSel.value;
            block.dataset.ktype = typeSel.value;
            block.dataset.limit = limitSel.value;
            block.dataset.view = viewSel.value;
            block.dataset.ksort = sortSel.value;
            paintCollection(block, wrap);
            markDirty();
        };
        for (const s of [catSel, typeSel, limitSel, viewSel, sortSel])
            s.addEventListener('change', applyNow);
        document.body.append(pop);
        const r = anchor.getBoundingClientRect();
        pop.style.left = Math.max(8, Math.min(r.left - 120, window.innerWidth - 268)) + 'px';
        pop.style.top = (r.bottom + 6) + 'px';
        const onDoc = (ev) => { if (!pop.contains(ev.target) && ev.target !== anchor)
            close(); };
        setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
    }
    // #657w 페이지 카드 삽입 피커 — 문서 검색 오버레이(빈 검색=최근).
    function promptPageCard(block) {
        const qIn = el('input', { type: 'search', placeholder: '문서 검색(제목·본문)' });
        const results = el('div', { class: 'list-box', style: 'max-height:320px; overflow:auto; margin-top:10px;' });
        const back = overlayBox('페이지 카드 삽입', el('p', { class: 'admin-hint', text: '문서를 카드로 배치합니다 — 처음 보는 사람에게 핵심 문서를 안내할 때 좋아요.' }), el('div', { class: 'field' }, el('label', { class: 'field-label', text: '문서' }), qIn), results);
        const pick = (e) => {
            back.remove();
            const data = { type: 'pagecard', name: e.name, label: e.title || e.name };
            const cur = blockData(block);
            const empty = block.dataset.type === 'p' && !String(cur.text || '').trim();
            let nb;
            if (empty) {
                nb = makeBlock(data);
                block.replaceWith(nb);
                ensureOne();
                renumber();
                markDirty();
            }
            else
                nb = insertBlockAfter(block, data);
            focusBlock(insertBlockAfter(nb, { type: 'p', text: '' }));
        };
        let t = null;
        async function search() {
            const q = qIn.value.trim();
            results.replaceChildren(el('div', { class: 'empty', text: '불러오는 중…' }));
            try {
                const url = q ? ('/api/ui/knowledge/search?' + new URLSearchParams({ q, limit: '12', mode: 'names' }))
                    : ('/api/ui/knowledge?' + new URLSearchParams({ limit: '12', orderBy: 'updated_at', injection: 'recalled' }));
                const r = await api(url);
                const entries = ((r && r.entries) || [])
                    .filter((e) => !String(e.name || '').startsWith('category-home-') && !e.is_folder);
                if (!entries.length) {
                    results.replaceChildren(el('div', { class: 'empty', text: '결과 없음' }));
                    return;
                }
                results.replaceChildren(...entries.map((e) => el('div', { class: 'row', role: 'button', tabindex: '0', style: 'cursor:pointer',
                    onclick: () => pick(e) }, el('div', { class: 'row-title', text: (e.icon || '📄') + ' ' + (e.title || e.name) }))));
            }
            catch (_) {
                results.replaceChildren(el('div', { class: 'empty', text: '검색 실패' }));
            }
        }
        qIn.addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 250); });
        setTimeout(() => { qIn.focus(); search(); }, 0);
    }
    // raw 블록 — 원문 textarea 편집(블러/⌘Enter 커밋).
    function openRawEditor(block, wrap) {
        if (wrap.querySelector('.be-raw-ta'))
            return;
        const ta = el('textarea', { class: 'be-raw-ta', spellcheck: 'false' });
        ta.value = block._raw;
        const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(Math.max(ta.scrollHeight + 4, 60), 480) + 'px'; };
        ta.addEventListener('input', grow);
        const commit = () => {
            block._raw = ta.value;
            const view = el('div', { class: 'be-raw-view md-rendered', title: '클릭해서 마크다운 원문 편집' });
            view.append(renderMarkdown(ta.value));
            view.addEventListener('click', () => openRawEditor(block, wrap));
            ta.replaceWith(view);
            markDirty();
        };
        ta.addEventListener('blur', commit);
        ta.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                ta.blur();
            }
            e.stopPropagation(); // 에디터 전역 키핸들러(Enter 분할 등)와 충돌 방지
        });
        const view = wrap.querySelector('.be-raw-view');
        if (view)
            view.replaceWith(ta);
        grow();
        ta.focus();
    }
    function openCalloutColors(anchor, block) {
        const old = document.querySelector('.be-colorpop');
        if (old) {
            old.remove();
            return;
        }
        const pop = el('div', { class: 'be-colorpop' });
        for (const c of CALLOUT_COLORS) {
            const b = el('button', { class: 'be-colordot md-callout-' + c, type: 'button', title: c });
            b.onclick = () => {
                const box = block.querySelector('.be-callout');
                box.className = 'be-callout md-callout-' + c;
                block.dataset.color = c;
                pop.remove();
                markDirty();
            };
            pop.append(b);
        }
        anchor.parentElement.append(pop);
        const onDoc = (ev) => { if (!pop.contains(ev.target) && ev.target !== anchor) {
            pop.remove();
            document.removeEventListener('mousedown', onDoc, true);
        } };
        setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
    }
    // ── 블록 접근/데이터 ──
    const blockEls = () => Array.from(root.children).filter((n) => n.classList && n.classList.contains('be-block'));
    const blockOf = (node) => {
        let n = node && node.nodeType === 3 ? node.parentElement : node;
        while (n && n !== root) {
            if (n.classList && n.classList.contains('be-block'))
                return n;
            n = n.parentElement;
        }
        return null;
    };
    const textElOf = (block) => block.querySelector('.be-text');
    const prevTextBlock = (block) => { let p = block.previousElementSibling; return p; };
    const nextTextBlock = (block) => { let n = block.nextElementSibling; return n; };
    function blockData(block) {
        const type = block.dataset.type;
        const t = textElOf(block);
        switch (type) {
            case 'h': return { type, level: Number(block.dataset.level) || 1, text: t ? inlineDomToMd(t) : '' };
            case 'bullet':
            case 'numbered':
                return { type, indent: Number(block.dataset.indent) || 0, text: t ? inlineDomToMd(t) : '' };
            case 'todo':
                return { type, indent: Number(block.dataset.indent) || 0, checked: block.dataset.checked === '1', text: t ? inlineDomToMd(t) : '' };
            case 'quote':
            case 'callout':
                return { type, icon: block.dataset.icon, color: block.dataset.color, text: t ? inlineDomToMd(t) : '' };
            case 'code': {
                const codeBox = block.querySelector('.be-code');
                return { type, lang: block.dataset.lang || '', text: codeBox ? codeBox.innerText.replace(/\u200B/g, '').replace(/\n$/, '') : '' };
            }
            case 'divider': return { type };
            case 'pagecard': return { type, name: block.dataset.name || '', label: block.dataset.label || '' };
            case 'collection': return { type, attrs: collAttrsOf(block) };
            case 'raw': {
                const ta = block.querySelector('.be-raw-ta');
                return { type, text: ta ? ta.value : (block._raw || '') };
            }
            case 'toggle': {
                const sum = block.querySelector(':scope > .be-main > .be-toggle > .be-toggle-row > .be-text');
                const kids = block.querySelector(':scope > .be-main > .be-toggle > .be-togglekids');
                return { type, summary: sum ? inlineDomToMd(sum) : '', children: kids ? childBlocksOf(kids) : [] };
            }
            case 'columns': {
                const cols = Array.from(block.querySelectorAll(':scope > .be-main > .be-cols > .be-col'));
                return { type, cols: cols.map((c) => childBlocksOf(c)) };
            }
            default: return { type: 'p', text: t ? inlineDomToMd(t) : '' };
        }
    }
    // 컨테이너(togglekids/col)의 직계 블록 데이터 — toggle/columns 재귀 직렬화용.
    function childBlocksOf(container) {
        return Array.from(container.children)
            .filter((n) => n.classList && n.classList.contains('be-block'))
            .map((n) => blockData(n));
    }
    // 번호 목록 재부여 + 글머리 글리프(깊이별 • ◦ ▪) + 들여쓰기 패딩 — 컨테이너(루트/토글/컬럼) 스코프별로.
    function renumberIn(scope) {
        const counters = [];
        for (const b of Array.from(scope.children).filter((n) => n.classList && n.classList.contains('be-block'))) {
            const type = b.dataset.type;
            if (!LISTY.has(type)) {
                counters.length = 0;
                continue;
            }
            const d = Math.min(Number(b.dataset.indent) || 0, 4);
            counters.length = d + 1;
            const row = b.querySelector('.be-li');
            if (row)
                row.style.paddingLeft = (d * 26) + 'px';
            const marker = b.querySelector('.be-marker');
            if (type === 'numbered') {
                counters[d] = (counters[d] || 0) + 1;
                if (marker)
                    marker.textContent = counters[d] + '.';
            }
            else {
                counters[d] = 0;
                if (marker)
                    marker.textContent = ['•', '◦', '▪', '▹', '·'][d] || '•';
            }
        }
    }
    function renumber() {
        renumberIn(root);
        root.querySelectorAll('.be-togglekids, .be-col').forEach((c) => renumberIn(c));
    }
    // #657n 구조 정규화 — 빈 컬럼 정리(1열 이하면 해체), 빈 토글엔 빈 문단 채움. 컨테이너 간 이동/삭제 뒤 호출.
    function normalizeStructure() {
        root.querySelectorAll('.be-block[data-type="columns"]').forEach((cb) => {
            const colsWrap = cb.querySelector(':scope > .be-main > .be-cols');
            if (!colsWrap)
                return;
            const cols = Array.from(colsWrap.children).filter((c) => c.classList.contains('be-col'));
            const hasBlock = (c) => Array.from(c.children).some((n) => n.classList && n.classList.contains('be-block'));
            const nonEmpty = cols.filter(hasBlock);
            if (nonEmpty.length <= 1) {
                // 해체 — 남은 블록을 컬럼 자리에 펼치고 컨테이너 제거(노션 동일).
                let anchor = cb;
                nonEmpty.forEach((c) => Array.from(c.children).forEach((n) => {
                    if (n.classList && n.classList.contains('be-block')) {
                        anchor.after(n);
                        anchor = n;
                    }
                }));
                cb.remove();
            }
            else {
                cols.forEach((c) => { if (!hasBlock(c))
                    c.remove(); });
            }
        });
        root.querySelectorAll('.be-togglekids').forEach((k) => {
            if (!Array.from(k.children).some((n) => n.classList && n.classList.contains('be-block'))) {
                k.append(makeBlock({ type: 'p', text: '' }));
            }
        });
        ensureOne();
        renumber();
    }
    // 블록 복제(⌘D)·이동(⌘⇧↑↓)·삭제 — 핸들 메뉴/단축키 공용.
    function duplicateBlock(block) {
        const nb = makeBlock(blockData(block));
        block.after(nb);
        renumber();
        markDirty();
        focusBlock(nb, false);
    }
    function moveBlockDir(block, dir) {
        const sib = dir < 0 ? block.previousElementSibling : block.nextElementSibling;
        if (!sib || !sib.classList.contains('be-block'))
            return;
        if (dir < 0)
            sib.before(block);
        else
            sib.after(block);
        renumber();
        markDirty();
        const t = textElOf(block);
        if (t)
            t.focus();
    }
    function deleteBlock(block) {
        const nb = nextTextBlock(block) || prevTextBlock(block);
        block.remove();
        normalizeStructure();
        markDirty();
        if (nb && nb.isConnected)
            focusBlock(nb, false);
    }
    function ensureOne() {
        if (!blockEls().length)
            root.append(makeBlock({ type: 'p', text: '' }));
        root.classList.toggle('be-empty', isEmptyNow());
        // 에디터가 통째로 빈 상태(유일한 빈 문단) — 그 블록에 에디터 수준 안내 플레이스홀더를 얹는다(포커스 없이도 노출).
        const bs = blockEls();
        if (bs.length === 1 && bs[0].dataset.type === 'p' && opts.placeholder) {
            const t = textElOf(bs[0]);
            if (t)
                t.dataset.ph = opts.placeholder;
        }
    }
    function isEmptyNow() {
        const bs = blockEls();
        return bs.length === 1 && bs[0].dataset.type === 'p' && !(textElOf(bs[0]) || { textContent: '' }).textContent;
    }
    function focusBlock(block, atStart = true) {
        const t = textElOf(block);
        if (t) {
            t.focus();
            placeCaret(t, atStart);
            return;
        }
        const focusable = block.querySelector('.be-div, .be-raw, .be-pagecard, .be-collection');
        if (focusable)
            focusable.focus();
    }
    // 타입 변환 — 인라인 내용 보존(문단↔제목↔목록↔인용↔콜아웃), 코드/구분선/이미지는 내용 규칙에 맞게.
    //  토글 → 다른 유형은 자식을 밖(아래)으로 펼쳐 데이터 유실 방지(#657n).
    function convertBlock(block, to) {
        const cur = blockData(block);
        const baseText = cur.text !== undefined ? cur.text : (cur.summary || '');
        const data = { ...to, text: to.text !== undefined ? to.text : (baseText || '') };
        const nb = makeBlock(data);
        block.replaceWith(nb);
        if (cur.type === 'toggle' && to.type !== 'toggle' && Array.isArray(cur.children) && cur.children.length) {
            let anchor = nb;
            for (const c of cur.children) {
                const cb = makeBlock(c);
                anchor.after(cb);
                anchor = cb;
            }
        }
        ensureOne();
        renumber();
        markDirty();
        focusBlock(nb, false);
        return nb;
    }
    function insertBlockAfter(block, data) {
        const nb = makeBlock(data);
        if (block)
            block.after(nb);
        else
            root.append(nb);
        ensureOne();
        renumber();
        markDirty();
        return nb;
    }
    // 토글 전환(공용) — 슬래시 '/토글' 과 마크다운 '> '(노션: > = 토글) 둘 다 사용. 현재 텍스트를 요약으로 옮기고 빈 자식 1개.
    function toToggleBlock(b, summaryText) {
        const nb = makeBlock({ type: 'toggle', summary: String(summaryText || '').replace(/\n+/g, ' '), children: [{ type: 'p', text: '' }] });
        b.replaceWith(nb);
        ensureOne();
        renumber();
        markDirty();
        const sum = nb.querySelector('.be-togglesum');
        if (sum) {
            sum.focus();
            placeCaret(sum, false);
        }
        return nb;
    }
    // ════════ 슬래시 메뉴 ════════
    const SLASH_ITEMS = [
        { k: 'text', ic: '¶', label: '텍스트', hint: '일반 문단', kw: 'text plain 텍스트 문단 본문', apply: (b) => convertBlock(b, { type: 'p' }) },
        { k: 'h1', ic: 'H1', label: '제목 1', hint: '큰 섹션 제목', kw: 'h1 # heading title 제목 헤딩 대제목', apply: (b) => convertBlock(b, { type: 'h', level: 1 }) },
        { k: 'h2', ic: 'H2', label: '제목 2', hint: '중간 제목', kw: 'h2 ## heading 제목 소제목', apply: (b) => convertBlock(b, { type: 'h', level: 2 }) },
        { k: 'h3', ic: 'H3', label: '제목 3', hint: '작은 제목', kw: 'h3 ### heading 제목', apply: (b) => convertBlock(b, { type: 'h', level: 3 }) },
        { k: 'bullet', ic: '•', label: '글머리 기호 목록', hint: '- 목록', kw: 'bullet list ul unordered 목록 글머리 리스트 점', apply: (b) => convertBlock(b, { type: 'bullet', indent: 0 }) },
        { k: 'numbered', ic: '1.', label: '번호 매기기 목록', hint: '1. 2. 3.', kw: 'numbered ordered ol list 번호 목록 리스트 숫자', apply: (b) => convertBlock(b, { type: 'numbered', indent: 0 }) },
        { k: 'todo', ic: '☑', label: '할 일 목록', hint: '체크박스', kw: 'todo [] checkbox check task 할일 체크 체크박스 체크리스트', apply: (b) => convertBlock(b, { type: 'todo', indent: 0, checked: false }) },
        { k: 'toggle', ic: '▸', label: '토글', hint: '접고 펼치는 블록', kw: 'toggle > collapse details 토글 접기 펼치기 드롭다운', apply: (b) => {
                const cur = blockData(b);
                toToggleBlock(b, String(cur.text !== undefined ? cur.text : (cur.summary || '')));
            } },
        { k: 'columns', ic: '⫴', label: '2열 컬럼', hint: '블록을 나란히 — 드래그로도 생성', kw: 'columns column 컬럼 열 나란히 레이아웃 layout 분할', apply: (b) => {
                const cur = blockData(b);
                const hasText = String(cur.text !== undefined ? cur.text : (cur.summary || '')).trim();
                const nb = makeBlock({ type: 'columns', cols: [[hasText ? cur : { type: 'p', text: '' }], [{ type: 'p', text: '' }]] });
                b.replaceWith(nb);
                ensureOne();
                renumber();
                markDirty();
                const ft = nb.querySelector('.be-col .be-text');
                if (ft) {
                    ft.focus();
                    placeCaret(ft, false);
                }
            } },
        { k: 'quote', ic: '❝', label: '인용', hint: '인용 블록', kw: 'quote " blockquote 인용 인용구 블록쿼트', apply: (b) => convertBlock(b, { type: 'quote' }) },
        { k: 'callout', ic: '💡', label: '콜아웃', hint: '아이콘 강조 상자', kw: 'callout note 콜아웃 강조 배너 안내 노트', apply: (b) => convertBlock(b, { type: 'callout', icon: '💡', color: 'default' }) },
        { k: 'code', ic: '</>', label: '코드', hint: '코드 블록', kw: 'code ``` snippet codeblock 코드 소스 코드블록', apply: (b) => convertBlock(b, { type: 'code', lang: '' }) },
        { k: 'equation', ic: '∑', label: '수식', hint: 'LaTeX 블록 수식($$)', kw: 'equation math latex tex formula 수식 수학 공식', apply: (b) => {
                const cur = blockData(b);
                const tmpl = '$$\n\n$$';
                let nb;
                if (b.dataset.type === 'p' && !String(cur.text || '').trim())
                    nb = convertBlock(b, { type: 'raw', text: tmpl });
                else
                    nb = insertBlockAfter(b, { type: 'raw', text: tmpl });
                const wrap = nb.querySelector('.be-raw');
                if (wrap)
                    openRawEditor(nb, wrap);
            } },
        { k: 'divider', ic: '—', label: '구분선', hint: '수평선', kw: 'divider --- hr line rule separator 구분선 나누기 수평선', apply: (b) => {
                const cur = blockData(b);
                if (!String(cur.text || '').trim()) {
                    const nb = convertBlock(b, { type: 'divider', text: undefined });
                    const p = insertBlockAfter(nb, { type: 'p', text: '' });
                    focusBlock(p);
                }
                else {
                    const d = insertBlockAfter(b, { type: 'divider' });
                    const p = insertBlockAfter(d, { type: 'p', text: '' });
                    focusBlock(p);
                }
            } },
        { k: 'pagecard', ic: '🔗', label: '페이지 카드', hint: '문서를 카드로 배치', kw: 'page card link 페이지 카드 문서 링크 smart 스마트', apply: (b) => promptPageCard(b) },
        { k: 'collection', ic: '▤', label: '컬렉션 (라이브 목록)', hint: '조건에 맞는 문서 자동 목록', kw: 'collection database view live 컬렉션 목록 라이브 데이터베이스 자동 최신', apply: (b) => {
                const cur = blockData(b);
                const data = { type: 'collection', attrs: { limit: 5, view: 'list', sort: 'updated' } };
                let nb;
                const empty = b.dataset.type === 'p' && !String(cur.text || '').trim();
                if (empty) {
                    nb = makeBlock(data);
                    b.replaceWith(nb);
                    ensureOne();
                    renumber();
                    markDirty();
                }
                else
                    nb = insertBlockAfter(b, data);
                const gear = nb.querySelector('.be-coll-gear');
                if (gear)
                    setTimeout(() => gear.click(), 0); // 삽입 즉시 조건 설정 열기
            } },
        { k: 'image', ic: '🖼', label: '이미지', hint: 'URL 로 삽입', kw: 'image picture 이미지 사진 그림', apply: (b) => promptImage(b) },
        { k: 'table', ic: '▦', label: '표', hint: '마크다운 표(원문 편집)', kw: 'table 표 테이블', apply: (b) => {
                const tmpl = '| 열 1 | 열 2 |\n| --- | --- |\n|  |  |';
                const cur = blockData(b);
                let nb;
                if (!String(cur.text || '').trim())
                    nb = convertBlock(b, { type: 'raw', text: tmpl });
                else
                    nb = insertBlockAfter(b, { type: 'raw', text: tmpl });
                const wrap = nb.querySelector('.be-raw');
                if (wrap)
                    openRawEditor(nb, wrap);
            } },
        // ── #730 확장: 제목4 · 미디어(업로드/링크) · 인라인 삽입 · 서식 ──
        { k: 'h4', ic: 'H4', label: '제목 4', hint: '더 작은 제목', kw: 'h4 #### heading 제목 소제목', apply: (b) => convertBlock(b, { type: 'h', level: 4 }) },
        { k: 'imageup', ic: '📤', label: '이미지 업로드', hint: '내 기기에서 올리기', kw: 'image upload file photo 이미지 업로드 사진 그림 파일', up: true, apply: (b) => pickAndUploadFile(b, true) },
        { k: 'attach', ic: '📎', label: '첨부 파일', hint: '파일 올려 링크로', kw: 'attachment file upload download 첨부 파일 업로드 다운로드', up: true, apply: (b) => pickAndUploadFile(b, false) },
        { k: 'bookmark', ic: '🔖', label: '북마크 / 링크 카드', hint: '웹 주소를 링크로', kw: 'bookmark link url web embed 북마크 링크 주소 웹 카드 임베드', apply: (b) => insertLinkAtBlock(b, true) },
        { k: 'link', ic: '🔗', label: '링크', hint: '하이퍼링크 삽입', kw: 'link url hyperlink 링크 주소 하이퍼링크', apply: (b) => insertLinkAtBlock(b, false) },
        { k: 'mppage', ic: '@', label: '페이지 멘션', hint: '다른 지식 문서 링크', kw: 'mention page link doc 멘션 페이지 문서 링크 지식 앳', apply: (b) => { const t = textElOf(b); if (t) {
                t.focus();
                insertText('[[');
                syncMention(t);
            } } },
        { k: 'date', ic: '📅', label: '오늘 날짜', hint: 'YYYY-MM-DD', kw: 'date today time now 날짜 오늘 시간', apply: (b) => { const t = textElOf(b); if (t) {
                t.focus();
                insertText(beToday());
                markDirty();
            } } },
        { k: 'bold', ic: 'B', label: '굵게', hint: '**굵게**', kw: 'bold strong 굵게 볼드 강조', apply: () => { document.execCommand('bold'); markDirty(); } },
        { k: 'italic', ic: '𝑖', label: '기울임', hint: '*기울임*', kw: 'italic em 기울임 이탤릭', apply: () => { document.execCommand('italic'); markDirty(); } },
        { k: 'underline', ic: 'U̲', label: '밑줄', hint: '++밑줄++', kw: 'underline 밑줄', apply: () => { document.execCommand('underline'); markDirty(); } },
        { k: 'strike', ic: 'S̶', label: '취소선', hint: '~~취소선~~', kw: 'strike strikethrough 취소선 지움', apply: () => { document.execCommand('strikeThrough'); markDirty(); } },
        { k: 'icode', ic: '</>', label: '인라인 코드', hint: '`코드`', kw: 'code inline mono 코드 인라인 모노', apply: () => wrapOrInsertInline('code') },
        { k: 'highlight', ic: '🖍', label: '형광펜', hint: '==강조==', kw: 'highlight mark 형광펜 강조 마커 하이라이트', apply: () => wrapOrInsertInline('mark') },
        { k: 'clearfmt', ic: '⌫', label: '서식 지우기', hint: '선택 서식 제거', kw: 'clear format remove clean 서식 지우기 초기화 제거', apply: () => { document.execCommand('removeFormat'); document.execCommand('unlink'); markDirty(); } },
    ];
    // #764 슬래시 항목 단축키 표기 — 마크다운 프리픽스(줄머리 '# ' 등)와 키보드 단축을 메뉴 우측 kbd 로.
    const _isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
    const _MOD = _isMac ? '⌘' : 'Ctrl+';
    const _SFT = _isMac ? '⇧' : 'Shift+';
    const SLASH_SC = {
        h1: '#', h2: '##', h3: '###', h4: '####',
        bullet: '-', numbered: '1.', todo: '[]', toggle: '>', quote: '"', code: '```', divider: '---',
        bold: _MOD + 'B', italic: _MOD + 'I', underline: _MOD + 'U', icode: _MOD + 'E', highlight: _MOD + _SFT + 'H',
    };
    SLASH_ITEMS.forEach((it) => { if (SLASH_SC[it.k])
        it.sc = SLASH_SC[it.k]; });
    // #730 슬래시 카테고리(클릭업/노션식 섹션 그룹핑). k → 카테고리.
    const SLASH_CAT = {
        text: 'basic', h1: 'basic', h2: 'basic', h3: 'basic', h4: 'basic',
        bullet: 'list', numbered: 'list', todo: 'list', toggle: 'list',
        quote: 'block', callout: 'block', divider: 'block', code: 'block', equation: 'block', columns: 'block', table: 'block', pagecard: 'block', collection: 'block',
        image: 'media', imageup: 'media', attach: 'media', bookmark: 'media',
        link: 'inline', mppage: 'inline', date: 'inline',
        bold: 'format', italic: 'format', underline: 'format', strike: 'format', icode: 'format', highlight: 'format', clearfmt: 'format',
    };
    const SLASH_CAT_ORDER = [['basic', '기본'], ['list', '목록'], ['block', '블록'], ['media', '미디어'], ['inline', '인라인'], ['format', '서식']];
    const slashCatIndex = (k) => { const c = SLASH_CAT[k] || 'block'; const i = SLASH_CAT_ORDER.findIndex(([kk]) => kk === c); return i < 0 ? 99 : i; };
    let slash = null; // { block, anchorNode, anchorOffset, menu, items, sel, typed }
    function openSlashMenu(block, typed) {
        closeSlashMenu();
        const r = caretRange();
        const menu = el('div', { class: 'be-slash', role: 'menu' });
        document.body.append(menu);
        slash = { block, menu, sel: 0, typed, query: '',
            anchorNode: r ? r.startContainer : null, anchorOffset: r ? r.startOffset : 0 };
        paintSlash();
        positionSlash(block);
    }
    function positionSlash(block) {
        if (!slash)
            return;
        const r = caretRange();
        let rect = r ? r.getBoundingClientRect() : null;
        if (!rect || (!rect.width && !rect.height && !rect.top))
            rect = block.getBoundingClientRect();
        const m = slash.menu;
        const h = Math.min(m.scrollHeight || 320, 320);
        m.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 320)) + 'px';
        m.style.top = (rect.bottom + 6 + h > window.innerHeight ? Math.max(8, rect.top - h - 6) : rect.bottom + 6) + 'px';
    }
    function slashCandidates() {
        const q = (slash.query || '').trim().toLowerCase();
        // 업로드형 명령(up)은 uploadFile 콜백이 있을 때만 노출. 카테고리 순서로 정렬(그룹 헤더용).
        return SLASH_ITEMS
            .filter((it) => (!it.up || !!opts.uploadFile) && (!q || it.label.toLowerCase().includes(q) || it.kw.includes(q) || it.k.includes(q)))
            .slice().sort((a, b) => slashCatIndex(a.k) - slashCatIndex(b.k));
    }
    function paintSlash() {
        if (!slash)
            return;
        const items = slashCandidates();
        slash.items = items;
        if (slash.sel >= items.length)
            slash.sel = Math.max(0, items.length - 1);
        if (!items.length) {
            slash.menu.replaceChildren(el('div', { class: 'be-slash-empty', text: '결과 없음' }));
            return;
        }
        const kids = [];
        let lastCat = '';
        items.forEach((it, idx) => {
            const cat = SLASH_CAT[it.k] || 'block';
            if (cat !== lastCat) {
                lastCat = cat;
                const found = SLASH_CAT_ORDER.find(([k]) => k === cat);
                kids.push(el('div', { class: 'be-slash-head', text: found ? found[1] : '블록' }));
            }
            const row = el('button', { class: 'be-slash-item' + (idx === slash.sel ? ' on' : ''), type: 'button', role: 'menuitem' }, el('span', { class: 'be-slash-ic', text: it.ic }), el('span', { class: 'be-slash-label', text: it.label }), el('span', { class: 'be-slash-hint', text: it.hint }), it.sc ? el('kbd', { class: 'be-slash-sc', text: it.sc }) : null);
            row.addEventListener('mousedown', (e) => e.preventDefault()); // 포커스/선택 유지
            row.onclick = () => applySlash(it);
            kids.push(row);
        });
        slash.menu.replaceChildren(...kids);
        const onEl = slash.menu.querySelector('.be-slash-item.on');
        if (onEl && onEl.scrollIntoView)
            onEl.scrollIntoView({ block: 'nearest' });
    }
    function closeSlashMenu() {
        if (!slash)
            return;
        slash.menu.remove();
        slash = null;
    }
    // '/query' 텍스트 제거 후 항목 적용.
    function applySlash(item) {
        const s = slash;
        closeSlashMenu();
        if (!s)
            return;
        if (s.typed && s.anchorNode && s.anchorNode.nodeType === 3) {
            // '/'(anchorOffset-1)부터 캐럿까지 삭제 — 같은 텍스트 노드 내 타이핑 가정(조합 포함).
            try {
                const node = s.anchorNode;
                const from = Math.max(0, s.anchorOffset - 1);
                const to = from + 1 + (s.query || '').length;
                node.textContent = node.textContent.slice(0, from) + node.textContent.slice(Math.min(to, node.textContent.length));
                const t = textElOf(s.block);
                if (t) {
                    t.focus();
                    const rr = document.createRange();
                    rr.setStart(node, Math.min(from, node.textContent.length));
                    rr.collapse(true);
                    const ss = window.getSelection();
                    ss.removeAllRanges();
                    ss.addRange(rr);
                }
            }
            catch (_) { /* 노드가 바뀐 드문 경우 — 텍스트 잔존만(기능은 계속) */ }
        }
        item.apply(s.block);
    }
    // 슬래시 쿼리 재계산(input 마다) — '/' 뒤 텍스트. '/' 가 사라졌으면 닫기.
    function syncSlashQuery() {
        if (!slash)
            return;
        const n = slash.anchorNode;
        if (!n || n.nodeType !== 3 || !root.contains(n)) {
            closeSlashMenu();
            return;
        }
        const txt = n.textContent || '';
        const from = Math.max(0, slash.anchorOffset - 1);
        if (txt[from] !== '/') {
            closeSlashMenu();
            return;
        }
        const r = caretRange();
        if (!r || r.startContainer !== n) {
            closeSlashMenu();
            return;
        }
        slash.query = txt.slice(from + 1, r.startOffset);
        if (/\s/.test(slash.query)) {
            closeSlashMenu();
            return;
        } // 공백 = 메뉴 포기(노션 동일)
        paintSlash();
        positionSlash(slash.block);
    }
    // ════════ [[ 페이지 멘션 — 노션 @링크/옵시디언 [[]] 동형(#657t). 다른 지식으로의 인라인 링크. ════════
    //  타이핑 중 '[[' 감지 → 지식 검색 메뉴 → 선택 시 '[[쿼리' 를 <a href="#/k/이름">제목</a> 로 치환.
    //  직렬화는 기존 A 브랜치([제목](#/k/이름)) — renderInline 의 내부 앵커(safeHref '#')와 왕복 호환.
    let mention = null; // { block, node, from(''[[' 시작 오프셋), query, menu, items, sel, timer }
    function closeMention() {
        if (!mention)
            return;
        clearTimeout(mention.timer);
        mention.menu.remove();
        mention = null;
    }
    function paintMention() {
        if (!mention)
            return;
        const items = mention.items || [];
        if (mention.sel >= items.length)
            mention.sel = Math.max(0, items.length - 1);
        mention.menu.replaceChildren(el('div', { class: 'be-slash-head', text: '페이지 링크' }), ...(!items.length ? [el('div', { class: 'be-slash-empty', text: mention.query ? '결과 없음' : '검색어를 입력하세요' })]
            : items.map((it, idx) => {
                const row = el('button', { class: 'be-slash-item' + (idx === mention.sel ? ' on' : ''), type: 'button' }, el('span', { class: 'be-slash-ic', text: it.icon || '📄' }), el('span', { class: 'be-slash-label', text: it.title || it.name }));
                row.addEventListener('mousedown', (e) => e.preventDefault());
                row.onclick = () => applyMention(it);
                return row;
            })));
        const r = caretRange();
        let rect = r ? r.getBoundingClientRect() : mention.block.getBoundingClientRect();
        if (!rect.width && !rect.height && !rect.top)
            rect = mention.block.getBoundingClientRect();
        const h = Math.min(mention.menu.scrollHeight || 280, 280);
        mention.menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 320)) + 'px';
        mention.menu.style.top = (rect.bottom + 6 + h > window.innerHeight ? Math.max(8, rect.top - h - 6) : rect.bottom + 6) + 'px';
    }
    function scheduleMentionSearch() {
        if (!mention)
            return;
        clearTimeout(mention.timer);
        mention.timer = setTimeout(async () => {
            if (!mention)
                return;
            const q = mention.query.trim();
            try {
                const url = q
                    ? '/api/ui/knowledge/search?' + new URLSearchParams({ q, limit: '8', mode: 'names', injection: 'recalled' })
                    : '/api/ui/knowledge?' + new URLSearchParams({ limit: '8', orderBy: 'updated_at', injection: 'recalled' });
                const r = await api(url);
                if (!mention)
                    return;
                mention.items = ((r && r.entries) || []).filter((e) => !String(e.name || '').startsWith('category-home-'));
                mention.sel = 0;
                paintMention();
            }
            catch (_) { /* 검색 실패 — 이전 결과 유지 */ }
        }, 250);
    }
    // input 마다 — 캐럿 앞 '[[쿼리' 프로브. 없으면 닫기, 있으면 열기/갱신.
    function syncMention(target) {
        const r = caretRange();
        if (!r || !r.collapsed || r.startContainer.nodeType !== 3) {
            closeMention();
            return;
        }
        const node = r.startContainer;
        const upto = (node.textContent || '').slice(0, r.startOffset);
        const m = /\[\[([^\[\]\n]{0,40})$/.exec(upto);
        if (!m) {
            closeMention();
            return;
        }
        const block = blockOf(target);
        if (!block) {
            closeMention();
            return;
        }
        if (!mention) {
            const menu = el('div', { class: 'be-slash be-mention', role: 'menu' });
            document.body.append(menu);
            mention = { block, node, menu, items: [], sel: 0, query: '', timer: null };
        }
        mention.block = block;
        mention.node = node;
        mention.from = r.startOffset - m[1].length - 2; // '[[' 시작
        if (mention.query !== m[1] || !mention.items.length) {
            mention.query = m[1];
            scheduleMentionSearch();
        }
        paintMention();
    }
    // 선택 — '[[쿼리' 삭제 후 <a> + ZWSP 삽입(마크 지속 차단 패딩과 동일 수법).
    function applyMention(it) {
        const m = mention;
        closeMention();
        if (!m)
            return;
        try {
            const node = m.node;
            const r = caretRange();
            const to = r && r.startContainer === node ? r.startOffset : (m.from + 2 + m.query.length);
            node.textContent = node.textContent.slice(0, m.from) + node.textContent.slice(to);
            const a = el('a', { class: 'md-link', href: '#/k/' + encodeURIComponent(it.name), text: it.title || it.name });
            const after = node.splitText(Math.min(m.from, node.textContent.length));
            node.parentNode.insertBefore(a, after);
            const pad = document.createTextNode('\u200B');
            node.parentNode.insertBefore(pad, after);
            const s = window.getSelection();
            const nr = document.createRange();
            nr.setStart(pad, 1);
            nr.collapse(true);
            s.removeAllRanges();
            s.addRange(nr);
            markDirty();
        }
        catch (_) {
            toast('링크 삽입 실패 — 다시 시도해 주세요', true);
        }
    }
    function promptImage(block) {
        const urlIn = el('input', { type: 'text', placeholder: 'https://… 이미지 주소', style: 'width:100%' });
        const altIn = el('input', { type: 'text', placeholder: '설명(alt, 선택)', style: 'width:100%' });
        const goBtn = el('button', { class: 'btn btn-primary', text: '삽입' });
        const back = overlayBox('이미지 삽입', el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이미지 URL' }), urlIn), el('div', { class: 'field', style: 'margin-top:10px' }, el('label', { class: 'field-label', text: '설명' }), altIn), el('div', { class: 'ov-actions' }, goBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
        setTimeout(() => urlIn.focus(), 0);
        const go = () => {
            const u = urlIn.value.trim();
            if (!safeHref(u) || !/^https?:\/\//i.test(u)) {
                toast('https:// 로 시작하는 이미지 URL 을 입력하세요', true);
                return;
            }
            back.remove();
            const md = '![' + altIn.value.trim().replace(/\]/g, '') + '](' + u + ')';
            const cur = blockData(block);
            let nb;
            if (!String(cur.text || '').trim())
                nb = convertBlock(block, { type: 'p', text: md });
            else
                nb = insertBlockAfter(block, { type: 'p', text: md });
            focusBlock(nb, false);
        };
        goBtn.onclick = go;
        urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing)
            go(); });
    }
    // ── #730 파일/이미지/링크/서식 삽입 헬퍼 (슬래시·붙여넣기·드롭 공용) ──
    function beToday() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
    // 마크다운 조각을 현재 블록에 넣는다(빈 문단이면 대체, 아니면 아래 새 블록). promptImage 와 동일 결.
    function insertMdBlock(block, md) {
        const cur = blockData(block);
        let nb;
        if (block.dataset.type === 'p' && !String(cur.text || '').trim())
            nb = convertBlock(block, { type: 'p', text: md });
        else
            nb = insertBlockAfter(block, { type: 'p', text: md });
        focusBlock(nb, false);
        return nb;
    }
    // 업로드된 이미지들을 순차로 넣는다(플레이스홀더 → 업로드 → 이미지 md 로 교체).
    async function insertUploadedImages(block, files) {
        if (!opts.uploadFile)
            return;
        let anchor = block;
        for (let i = 0; i < files.length; i++) {
            const cur = blockData(anchor);
            const empty = i === 0 && anchor.dataset.type === 'p' && !String(cur.text || '').trim();
            const ph = empty ? convertBlock(anchor, { type: 'p', text: '⬆︎ 이미지 업로드 중…' }) : insertBlockAfter(anchor, { type: 'p', text: '⬆︎ 이미지 업로드 중…' });
            anchor = ph;
            markDirty();
            try {
                const url = await opts.uploadFile(files[i]);
                anchor = convertBlock(ph, { type: 'p', text: url ? '![](' + url + ')' : '(이미지 업로드 실패)' });
            }
            catch (_) {
                anchor = convertBlock(ph, { type: 'p', text: '(이미지 업로드 실패)' });
            }
            markDirty();
        }
        focusBlock(anchor, false);
        if (opts.onChange)
            opts.onChange();
    }
    // 파일 선택 → 업로드 → 이미지면 ![](), 아니면 [📎 파일명](url) 링크.
    function pickAndUploadFile(block, asImage) {
        if (!opts.uploadFile)
            return;
        const inp = el('input', { type: 'file', accept: asImage ? 'image/*' : '', style: 'position:fixed;left:-9999px' });
        document.body.append(inp);
        inp.addEventListener('change', async () => {
            const f = inp.files && inp.files[0];
            inp.remove();
            if (!f)
                return;
            if (asImage) {
                await insertUploadedImages(block, [f]);
                return;
            }
            const ph = insertMdBlock(block, '⬆︎ 첨부 업로드 중…');
            try {
                const url = await opts.uploadFile(f);
                convertBlock(ph, { type: 'p', text: url ? '[📎 ' + f.name.replace(/[[\]]/g, '') + '](' + url + ')' : '(첨부 업로드 실패)' });
            }
            catch (_) {
                convertBlock(ph, { type: 'p', text: '(첨부 업로드 실패)' });
            }
            markDirty();
            if (opts.onChange)
                opts.onChange();
        });
        inp.click();
    }
    // 링크/북마크 — 선택이 있으면 그 선택에 링크(툴바 팝오버), 없으면 주소·표시텍스트를 물어 인라인 링크 삽입.
    function insertLinkAtBlock(block, bookmark) {
        const r = caretRange();
        if (r && !r.collapsed) {
            openLinkPop();
            return;
        }
        const urlIn = el('input', { type: 'text', placeholder: 'https://…', style: 'width:100%' });
        const txtIn = el('input', { type: 'text', placeholder: bookmark ? '표시 이름(선택)' : '표시할 텍스트(선택)', style: 'width:100%' });
        const goBtn = el('button', { class: 'btn btn-primary', text: '삽입' });
        const back = overlayBox(bookmark ? '링크 카드' : '링크 삽입', el('div', { class: 'field' }, el('label', { class: 'field-label', text: '주소' }), urlIn), el('div', { class: 'field', style: 'margin-top:10px' }, el('label', { class: 'field-label', text: '표시 텍스트' }), txtIn), el('div', { class: 'ov-actions' }, goBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
        setTimeout(() => urlIn.focus(), 0);
        const go = () => {
            const u = urlIn.value.trim();
            if (!safeHref(u) || !/^(https?:\/\/|#\/)/i.test(u)) {
                toast('https:// 또는 #/… 주소를 입력하세요', true);
                return;
            }
            back.remove();
            const label = (txtIn.value.trim() || u).replace(/[[\]]/g, '');
            insertMdBlock(block, (bookmark ? '🔖 ' : '') + '[' + label + '](' + u + ')');
            markDirty();
            if (opts.onChange)
                opts.onChange();
        };
        goBtn.onclick = go;
        urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing)
            go(); });
    }
    // 인라인 마크(code/mark) — 선택이 있으면 감싸고, 없으면 빈 래퍼를 넣고 그 안에 캐럿(다음 타이핑이 안에 들어감).
    function wrapOrInsertInline(tag) {
        const r = caretRange();
        if (r && !r.collapsed) {
            toggleWrap(tag);
            markDirty();
            return;
        }
        if (!r)
            return;
        const wrap = el(tag, tag === 'code' ? { class: 'md-code' } : (tag === 'mark' ? { class: 'md-mark' } : {}));
        wrap.append(document.createTextNode('​'));
        try {
            r.insertNode(wrap);
            const s = window.getSelection();
            const nr = document.createRange();
            nr.setStart(wrap.firstChild, 1);
            nr.collapse(true);
            s.removeAllRanges();
            s.addRange(nr);
        }
        catch (_) { /* 경계 드문 케이스 */ }
        markDirty();
    }
    // ════════ 인라인 서식 툴바 ════════
    const tools = el('div', { class: 'be-tools', hidden: true });
    document.body.append(tools);
    const toolBtn = (label, title, fn, cls) => {
        const b = el('button', { class: 'be-tool' + (cls ? ' ' + cls : ''), type: 'button', title });
        b.append(typeof label === 'string' ? document.createTextNode(label) : label);
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.onclick = () => { fn(); markDirty(); positionTools(); };
        return b;
    };
    // 선택을 tag 로 감싸기/풀기(간단 토글) — execCommand 미지원 마크(code/mark)용.
    function toggleWrap(tag) {
        const r = caretRange();
        if (!r || r.collapsed)
            return;
        let n = r.commonAncestorContainer;
        if (n.nodeType === 3)
            n = n.parentElement;
        const existing = n && n.closest ? n.closest(tag) : null;
        if (existing && root.contains(existing)) {
            const parent = existing.parentNode;
            while (existing.firstChild)
                parent.insertBefore(existing.firstChild, existing);
            parent.removeChild(existing);
            return;
        }
        try {
            const frag = r.extractContents();
            const wrap = el(tag, tag === 'code' ? { class: 'md-code' } : (tag === 'mark' ? { class: 'md-mark' } : {}));
            wrap.append(frag);
            r.insertNode(wrap);
            const s = window.getSelection();
            s.removeAllRanges();
            const nr = document.createRange();
            nr.selectNodeContents(wrap);
            s.addRange(nr);
        }
        catch (_) { /* 경계 걸친 드문 케이스 — no-op */ }
    }
    // 링크 — 노션형 인라인 팝오버(입력 + 적용/해제). window.prompt 금지(#657t).
    //  선택 레인지를 저장해 두고 input 포커스로 선택이 사라져도 적용 시 복원 후 execCommand.
    function openLinkPop() {
        const r0 = caretRange();
        if (!r0 || r0.collapsed)
            return;
        const saved = r0.cloneRange();
        const old = document.querySelector('.be-linkpop');
        if (old) {
            old.remove();
            return;
        }
        let n = r0.commonAncestorContainer;
        if (n.nodeType === 3)
            n = n.parentElement;
        const existing = n && n.closest ? n.closest('a') : null;
        const input = el('input', { class: 'be-linkpop-in', type: 'text', spellcheck: 'false',
            placeholder: '주소 붙여넣기 (https://… 또는 #/k/문서명)',
            value: existing ? (existing.getAttribute('href') || '') : '' });
        const close = () => { pop.remove(); document.removeEventListener('mousedown', onDoc, true); };
        const restoreSel = () => { const s = window.getSelection(); s.removeAllRanges(); s.addRange(saved); };
        const apply = () => {
            const url = input.value.trim();
            if (!url) {
                restoreSel();
                document.execCommand('unlink');
                close();
                markDirty();
                return;
            }
            const safe = safeHref(url);
            if (!safe) {
                toast('허용되지 않는 URL 입니다', true);
                input.focus();
                return;
            }
            restoreSel();
            document.execCommand('createLink', false, safe);
            close();
            markDirty();
        };
        const applyBtn = el('button', { class: 'be-linkpop-btn', type: 'button', text: '적용' });
        applyBtn.onclick = apply;
        const unlinkBtn = existing ? el('button', { class: 'be-linkpop-btn be-linkpop-un', type: 'button', text: '해제',
            onclick: () => { restoreSel(); document.execCommand('unlink'); close(); markDirty(); } }) : null;
        const pop = el('div', { class: 'be-linkpop' }, input, applyBtn, unlinkBtn);
        document.body.append(pop);
        const rect = saved.getBoundingClientRect();
        pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 330)) + 'px';
        pop.style.top = (rect.bottom + 8) + 'px';
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                apply();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                close();
            }
            e.stopPropagation();
        });
        const onDoc = (ev) => { if (!pop.contains(ev.target))
            close(); };
        setTimeout(() => { document.addEventListener('mousedown', onDoc, true); input.focus(); }, 0);
    }
    // 전환 드롭다운(툴바 좌측) — 현재 블록 유형 라벨 + 리스트(노션 'Text ∨' 동형).
    const TURN_LABEL = { p: '텍스트', h1: '제목 1', h2: '제목 2', h3: '제목 3', h4: '제목 4',
        bullet: '글머리 목록', numbered: '번호 목록', todo: '할 일', quote: '인용', callout: '콜아웃', code: '코드', toggle: '토글' };
    const curTypeKey = (block) => {
        const t = block.dataset.type;
        return t === 'h' ? 'h' + Math.min(Number(block.dataset.level) || 1, 4) : t;
    };
    let toolsBlock = null; // 현재 선택이 속한 블록(전환 대상)
    const turnLabel = el('span', { class: 'be-turn-label', text: '텍스트' });
    const turnBtn = el('button', { class: 'be-tool be-tool-turn', type: 'button', title: '블록 유형 전환' }, turnLabel, el('span', { class: 'be-turn-caret', 'aria-hidden': 'true', text: '⌄' }));
    turnBtn.addEventListener('mousedown', (e) => e.preventDefault());
    turnBtn.onclick = () => {
        const old = document.querySelector('.be-turnpop');
        if (old) {
            old.remove();
            return;
        }
        if (!toolsBlock)
            return;
        const block = toolsBlock;
        const pop = el('div', { class: 'be-turnpop' });
        const close = () => { pop.remove(); document.removeEventListener('mousedown', onDoc, true); };
        for (const it of SLASH_ITEMS) {
            if (!['text', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'toggle', 'quote', 'callout', 'code'].includes(it.k))
                continue;
            const cur = curTypeKey(block) === (it.k === 'text' ? 'p' : it.k);
            const b = el('button', { class: 'be-turnpop-item' + (cur ? ' on' : ''), type: 'button' }, el('span', { class: 'be-slash-ic', text: it.ic }), el('span', { text: it.label }), cur ? el('span', { class: 'be-turnpop-check', text: '✓' }) : null);
            b.addEventListener('mousedown', (e) => e.preventDefault());
            b.onclick = () => { close(); it.apply(block); };
            pop.append(b);
        }
        document.body.append(pop);
        const r = turnBtn.getBoundingClientRect();
        pop.style.left = Math.max(8, r.left) + 'px';
        pop.style.top = (r.bottom + 6) + 'px';
        const onDoc = (ev) => { if (!pop.contains(ev.target) && ev.target !== turnBtn)
            close(); };
        setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
    };
    const markBtns = {};
    const addTool = (key, label, title, fn, cls) => {
        const b = toolBtn(label, title, fn, cls);
        markBtns[key] = b;
        return b;
    };
    tools.append(turnBtn, el('span', { class: 'be-tools-sep', 'aria-hidden': 'true' }), addTool('b', 'B', '굵게 — ⌘B', () => document.execCommand('bold'), 'be-tool-b'), addTool('i', 'i', '기울임 — ⌘I', () => document.execCommand('italic'), 'be-tool-i'), addTool('u', 'U', '밑줄 — ⌘U', () => document.execCommand('underline'), 'be-tool-u'), addTool('s', 'S', '취소선', () => document.execCommand('strikeThrough'), 'be-tool-s'), addTool('code', '</>', '인라인 코드 — ⌘E', () => toggleWrap('code'), 'be-tool-code'), addTool('mark', '형광', '하이라이트 — ⌘⇧H', () => toggleWrap('mark'), 'be-tool-mark'), el('span', { class: 'be-tools-sep', 'aria-hidden': 'true' }), addTool('a', '링크', '링크 걸기', () => openLinkPop(), 'be-tool-link'));
    function positionTools() {
        const s = window.getSelection();
        if (!s || !s.rangeCount || s.isCollapsed) {
            tools.hidden = true;
            return;
        }
        const r = s.getRangeAt(0);
        const anc = r.commonAncestorContainer;
        const ancEl = anc.nodeType === 3 ? anc.parentElement : anc;
        const t = ancEl && ancEl.closest ? ancEl.closest('.be-text') : null;
        if (!t || !root.contains(t) || t.classList.contains('be-code')) {
            tools.hidden = true;
            return;
        }
        const rect = r.getBoundingClientRect();
        if (!rect.width && !rect.height) {
            tools.hidden = true;
            return;
        }
        // 활성 마크 상태 + 현재 블록 유형 라벨(노션 'Text ∨').
        toolsBlock = blockOf(t);
        if (toolsBlock)
            turnLabel.textContent = TURN_LABEL[curTypeKey(toolsBlock)] || '텍스트';
        const on = (sel) => !!(ancEl && ancEl.closest && ancEl.closest(sel));
        markBtns.b.classList.toggle('on', on('b, strong'));
        markBtns.i.classList.toggle('on', on('i, em'));
        markBtns.u.classList.toggle('on', on('u'));
        markBtns.s.classList.toggle('on', on('s, del, strike'));
        markBtns.code.classList.toggle('on', on('code'));
        markBtns.mark.classList.toggle('on', on('mark'));
        markBtns.a.classList.toggle('on', on('a'));
        tools.hidden = false;
        const w = tools.offsetWidth || 300;
        tools.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - 8)) + 'px';
        tools.style.top = Math.max(8, rect.top - tools.offsetHeight - 9) + 'px';
    }
    const onSelChange = () => {
        if (!root.isConnected) {
            document.removeEventListener('selectionchange', onSelChange);
            tools.remove();
            closeSlashMenu();
            closeMention();
            return;
        }
        requestAnimationFrame(positionTools);
    };
    document.addEventListener('selectionchange', onSelChange);
    // ════════ 키 입력 ════════
    root.addEventListener('compositionstart', () => { composing = true; }, true);
    root.addEventListener('compositionend', () => { composing = false; setTimeout(syncSlashQuery, 0); }, true);
    root.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
            if (opts.onSaveShortcut) {
                e.preventDefault();
                opts.onSaveShortcut();
            }
            return;
        }
        const target = e.target;
        if (target.classList && (target.classList.contains('be-raw-ta') || target.classList.contains('be-code-lang')))
            return;
        // #657z 실행취소 — 에디터가 소유(⌘Z 취소 / ⌘⇧Z·Ctrl+Y 재실행). 네이티브 undo 는 구조 변경을 모른다.
        if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
            e.preventDefault();
            if (composing || e.isComposing || e.keyCode === 229)
                return;
            if (e.shiftKey)
                histRedo();
            else
                histUndo();
            return;
        }
        if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'y' || e.key === 'Y')) {
            e.preventDefault();
            if (composing || e.isComposing || e.keyCode === 229)
                return;
            histRedo();
            return;
        }
        // 구조 키 직전 — 진행 중 타이핑 버스트를 별도 undo 스텝으로 확정(타이핑↔Enter 분할이 한 스텝으로 뭉치지 않게).
        if (!e.isComposing && e.keyCode !== 229 && (e.key === 'Enter' || e.key === 'Tab' || e.metaKey || e.ctrlKey))
            histFlushTyping();
        const block = blockOf(target);
        if (!block)
            return;
        // 블록 단축(#657n) — ⌘D 복제 · ⌘⇧↑/↓ 이동(노션 동일).
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'd' || e.key === 'D')) {
            e.preventDefault();
            duplicateBlock(block);
            return;
        }
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            moveBlockDir(block, e.key === 'ArrowUp' ? -1 : 1);
            return;
        }
        // [[ 멘션 메뉴 열림 — 방향키/Enter/Esc 는 메뉴가 소비(#657t).
        if (mention) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const n = mention.items ? mention.items.length : 0;
                if (n) {
                    mention.sel = (mention.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
                    paintMention();
                }
                return;
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && !composing && e.keyCode !== 229) {
                e.preventDefault();
                const it = mention.items && mention.items[mention.sel];
                if (it)
                    applyMention(it);
                else
                    closeMention();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                closeMention();
                return;
            }
        }
        // 슬래시 메뉴 열림 — 방향키/Enter/Esc 는 메뉴가 소비.
        if (slash) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const n = slash.items ? slash.items.length : 0;
                if (n) {
                    slash.sel = (slash.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
                    paintSlash();
                }
                return;
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && !composing && e.keyCode !== 229) {
                e.preventDefault();
                const it = slash.items && slash.items[slash.sel];
                if (it)
                    applySlash(it);
                else
                    closeSlashMenu();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                closeSlashMenu();
                return;
            }
        }
        const type = block.dataset.type;
        const t = textElOf(block);
        // 구분선/raw/카드/컬렉션 래퍼에 포커스가 있을 때 — Backspace/Enter.
        const wrapType = type === 'divider' || type === 'raw' || type === 'pagecard' || type === 'collection';
        if (!target.classList.contains('be-text')) {
            if ((e.key === 'Backspace' || e.key === 'Delete') && wrapType) {
                e.preventDefault();
                const pb = prevTextBlock(block);
                block.remove();
                normalizeStructure();
                markDirty();
                if (pb && pb.isConnected)
                    focusBlock(pb, false);
                return;
            }
            if (e.key === 'Enter' && wrapType) {
                e.preventDefault();
                focusBlock(insertBlockAfter(block, { type: 'p', text: '' }));
                return;
            }
            return;
        }
        if (!t)
            return;
        // '/' — 슬래시 메뉴. 임의 위치에서 열림(단어 중간·끝 포함) — 쿼리에 공백 들어오면 syncSlashQuery 가 자동으로 닫는다.
        if (e.key === '/' && !composing && !slash) {
            setTimeout(() => {
                const rr = caretRange();
                if (!rr)
                    return;
                openSlashMenu(block, true);
                if (slash) {
                    slash.anchorNode = rr.startContainer;
                    slash.anchorOffset = rr.startOffset;
                }
            }, 0);
            return;
        }
        if (e.isComposing || e.keyCode === 229)
            return; // IME 조합 중 — 구조 조작 금지(#505)
        // 코드 블록 — Enter=개행, Tab=스페이스2, 그 외 기본.
        if (type === 'code' && target.classList.contains('be-code')) {
            if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                insertText('\n');
                markDirtyType();
                return;
            }
            if (e.key === 'Tab') {
                e.preventDefault();
                insertText('  ');
                markDirtyType();
                return;
            }
            if (e.key === 'Backspace' && caretAtStart(t) && !t.textContent) {
                e.preventDefault();
                convertBlock(block, { type: 'p', text: '' });
                return;
            }
            return;
        }
        // 서식 단축키(⌘E 코드 / ⌘⇧H 하이라이트) — B/I/U 는 브라우저 기본(execCommand 동형 결과).
        if ((e.metaKey || e.ctrlKey) && (e.key === 'e' || e.key === 'E')) {
            e.preventDefault();
            toggleWrap('code');
            markDirty();
            return;
        }
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'h' || e.key === 'H')) {
            e.preventDefault();
            toggleWrap('mark');
            markDirty();
            return;
        }
        if (e.key === 'Enter') {
            if (e.shiftKey) {
                e.preventDefault();
                document.execCommand('insertLineBreak');
                markDirtyType();
                return;
            }
            e.preventDefault();
            const plain = t.textContent || '';
            // 토글 요약에서 Enter — 열려 있으면 첫 자식으로(노션 동일), 접혀 있으면 아래 새 문단.
            if (type === 'toggle') {
                const kids = block.querySelector(':scope > .be-main > .be-toggle > .be-togglekids');
                if (block.dataset.open === '1' && kids) {
                    let first = Array.from(kids.children).find((n) => n.classList && n.classList.contains('be-block'));
                    if (!first) {
                        first = makeBlock({ type: 'p', text: '' });
                        kids.append(first);
                    }
                    focusBlock(first, true);
                }
                else {
                    focusBlock(insertBlockAfter(block, { type: 'p', text: '' }));
                }
                markDirty();
                return;
            }
            // 빈 리스트 항목 → 문단으로(들여쓰기 있으면 한 단 내어쓰기) — 노션 동일.
            if (LISTY.has(type) && !plain) {
                const ind = Number(block.dataset.indent) || 0;
                if (ind > 0) {
                    block.dataset.indent = String(ind - 1);
                    renumber();
                    markDirty();
                }
                else
                    convertBlock(block, { type: 'p', text: '' });
                return;
            }
            // 인용/콜아웃 — 마지막 빈 줄에서 Enter = 블록 탈출, 그 외 = 줄바꿈.
            if (type === 'quote' || type === 'callout') {
                if (caretAtEnd(t) && (plain === '' || /\n$/.test(inlineDomToMd(t)) || t.lastChild && t.lastChild.tagName === 'BR')) {
                    if (t.lastChild && t.lastChild.tagName === 'BR')
                        t.removeChild(t.lastChild);
                    focusBlock(insertBlockAfter(block, { type: 'p', text: '' }));
                }
                else {
                    document.execCommand('insertLineBreak');
                }
                markDirty();
                return;
            }
            // 분할 — 캐럿 뒤 내용을 새 블록으로. 리스트는 같은 유형 지속, 제목 뒤엔 문단.
            const tail = extractAfterCaret(t);
            const nType = LISTY.has(type) ? type : 'p';
            const nb = insertBlockAfter(block, {
                type: nType,
                indent: Number(block.dataset.indent) || 0,
                checked: false,
                text: '',
            });
            const nt = textElOf(nb);
            nt.replaceChildren(tail);
            // 앞뒤 잔여 <br> 정리(분할 지점이 줄 경계였을 때).
            if (t.lastChild && t.lastChild.tagName === 'BR')
                t.removeChild(t.lastChild);
            if (nt.firstChild && nt.firstChild.tagName === 'BR')
                nt.removeChild(nt.firstChild);
            renumber();
            markDirty();
            focusBlock(nb, true);
            return;
        }
        if (e.key === 'Backspace') {
            const r = caretRange();
            if (r && !r.collapsed)
                return; // 범위 삭제는 기본
            if (!caretAtStart(t))
                return;
            e.preventDefault();
            if (LISTY.has(type)) {
                const ind = Number(block.dataset.indent) || 0;
                if (ind > 0) {
                    block.dataset.indent = String(ind - 1);
                    renumber();
                    markDirty();
                    return;
                }
                convertBlock(block, { type: 'p' });
                const nb = blockOf(window.getSelection().anchorNode);
                if (nb)
                    focusBlock(nb, true);
                return;
            }
            if (type === 'h' || type === 'quote' || type === 'callout' || type === 'toggle') {
                // 토글은 convertBlock 이 자식을 밖으로 펼쳐 보존한다(#657n).
                const nb = convertBlock(block, { type: 'p' });
                focusBlock(nb, true);
                return;
            }
            // 문단 — 이전 블록과 병합. 토글 첫 자식이면 요약으로 캐럿 이동(컨테이너 경계).
            const prev = prevTextBlock(block);
            if (!prev) {
                const kidsWrap = block.parentElement;
                if (kidsWrap && kidsWrap.classList.contains('be-togglekids')) {
                    const tb = blockOf(kidsWrap);
                    const sum = tb && tb.querySelector('.be-togglesum');
                    if (sum) {
                        sum.focus();
                        placeCaret(sum, false);
                    }
                }
                return;
            }
            const ptype = prev.dataset.type;
            if (ptype === 'divider') {
                prev.remove();
                ensureOne();
                renumber();
                markDirty();
                return;
            }
            if (ptype === 'raw' || ptype === 'code') {
                focusBlock(prev, false);
                return;
            }
            const pt = textElOf(prev);
            if (!pt)
                return;
            const hadContent = !!t.childNodes.length;
            placeCaretJunctionMerge(pt, t);
            block.remove();
            ensureOne();
            renumber();
            markDirty();
            if (!hadContent)
                placeCaret(pt, false);
            return;
        }
        if (e.key === 'Delete') {
            const r = caretRange();
            if (r && !r.collapsed)
                return;
            if (!caretAtEnd(t))
                return;
            const next = nextTextBlock(block);
            if (!next)
                return;
            const ntype = next.dataset.type;
            if (ntype === 'divider') {
                e.preventDefault();
                next.remove();
                ensureOne();
                renumber();
                markDirty();
                return;
            }
            const nt = textElOf(next);
            if (!nt)
                return;
            e.preventDefault();
            placeCaretJunctionMerge(t, nt);
            next.remove();
            ensureOne();
            renumber();
            markDirty();
            return;
        }
        if (e.key === 'Tab') {
            e.preventDefault();
            if (LISTY.has(type)) {
                const ind = Number(block.dataset.indent) || 0;
                block.dataset.indent = String(Math.max(0, Math.min(4, ind + (e.shiftKey ? -1 : 1))));
                renumber();
                markDirty();
            }
            return;
        }
        // 블록 경계 화살표 이동.
        if (e.key === 'ArrowUp' && caretAtStart(t)) {
            const prev = prevTextBlock(block);
            if (prev) {
                e.preventDefault();
                focusBlock(prev, false);
            }
            return;
        }
        if (e.key === 'ArrowDown' && caretAtEnd(t)) {
            const next = nextTextBlock(block);
            if (next) {
                e.preventDefault();
                focusBlock(next, true);
            }
            return;
        }
        if (e.key === 'ArrowLeft' && caretAtStart(t)) {
            const prev = prevTextBlock(block);
            if (prev && textElOf(prev)) {
                e.preventDefault();
                focusBlock(prev, false);
            }
            return;
        }
        if (e.key === 'ArrowRight' && caretAtEnd(t)) {
            const next = nextTextBlock(block);
            if (next && textElOf(next)) {
                e.preventDefault();
                focusBlock(next, true);
            }
            return;
        }
    });
    // ── input: 마크다운 단축 변환 + 인라인 페어 변환 + 슬래시 쿼리 + dirty ──
    root.addEventListener('input', (e) => {
        const target = e.target;
        if (target.classList && (target.classList.contains('be-raw-ta') || target.classList.contains('be-code-lang'))) {
            markDirtyType();
            return;
        }
        markDirtyType();
        //  #764 단어 단위 실행취소 — 공백·구두점 입력 시 직전 타이핑 버스트를 히스토리 1스텝으로 확정(노션 감각).
        //  IME 조합 중엔 건너뛴다(조합 종료 후의 공백만 경계로).
        if (!composing && !e.isComposing && e.inputType === 'insertText' && e.data && /[\s.,;:!?)\]}"'、。]/.test(e.data))
            histFlushTyping();
        if (slash) {
            syncSlashQuery();
            return;
        }
        if (target.classList.contains('be-text') && !target.classList.contains('be-code'))
            syncMention(target); // [[ 멘션(조합 중 갱신 허용)
        if (composing || e.isComposing)
            return;
        const block = blockOf(target);
        if (!block || !target.classList.contains('be-text') || target.classList.contains('be-code'))
            return;
        const type = block.dataset.type;
        const txt = target.textContent || '';
        // 블록 단축(내용이 프리픽스뿐일 때) — p 에서 변환, 리스트에선 '[] '로 할일 전환.
        if (type === 'p') {
            let m;
            if ((m = /^(#{1,6})\s$/.exec(txt))) {
                convertBlock(block, { type: 'h', level: m[1].length, text: '' });
                return;
            }
            if (/^([-*+])\s$/.test(txt)) {
                convertBlock(block, { type: 'bullet', indent: 0, text: '' });
                return;
            }
            if (/^(\d+)[.)]\s$/.test(txt)) {
                convertBlock(block, { type: 'numbered', indent: 0, text: '' });
                return;
            }
            if (/^\[( |x)?\]\s$/.test(txt)) {
                convertBlock(block, { type: 'todo', indent: 0, checked: /x/.test(txt), text: '' });
                return;
            }
            if (/^>\s$/.test(txt)) {
                toToggleBlock(block, '');
                return;
            } // 노션: > = 토글
            if (/^"\s$/.test(txt)) {
                convertBlock(block, { type: 'quote', text: '' });
                return;
            } // 노션: " = 인용
            if (txt === '```') {
                convertBlock(block, { type: 'code', lang: '', text: '' });
                return;
            }
            if (txt === '---') {
                const nb = convertBlock(block, { type: 'divider', text: undefined });
                focusBlock(insertBlockAfter(nb, { type: 'p', text: '' }));
                return;
            }
        }
        else if (type === 'bullet' && /^\[( |x)?\]\s$/.test(txt)) {
            convertBlock(block, { type: 'todo', indent: Number(block.dataset.indent) || 0, checked: /x/.test(txt), text: '' });
            return;
        }
        // 인라인 페어 변환 — 캐럿 앞이 **…**·`…`·~~…~~·==…==·++…++·*…* 로 끝나면 실서식으로.
        inlinePairConvert(target);
    });
    function inlinePairConvert(t) {
        const r = caretRange();
        if (!r || !r.collapsed || r.startContainer.nodeType !== 3)
            return;
        const node = r.startContainer;
        if (node.parentElement && node.parentElement.closest('code, a'))
            return; // 코드/링크 안은 원문 유지
        const upto = (node.textContent || '').slice(0, r.startOffset);
        // lead=true → 그룹1은 선행 경계문자(치환 대상 아님), inner=그룹2. 노션 인라인 서식 페어 전부.
        const rules = [
            [/\*\*([^*\n]+)\*\*$/, 'strong', false],
            [/`([^`\n]+)`$/, 'code', false],
            [/~~([^~\n]+)~~$/, 'del', false],
            [/==([^=\n]+)==$/, 'mark', false],
            [/\+\+([^+\n]+)\+\+$/, 'u', false],
            [/(^|[^~])~([^~\s\n](?:[^~\n]*[^~\s\n])?)~$/, 'del', true], // 노션: 단일 ~ 취소선(~~ 규칙 뒤에 둬 이중이 우선)
            [/(^|[\s(가-힣])\*([^*\s\n](?:[^*\n]*[^*\s\n])?)\*$/, 'em', true],
        ];
        for (const [re, tag, lead] of rules) {
            const m = re.exec(upto);
            if (!m)
                continue;
            const inner = lead ? m[2] : m[1];
            const mdLen = (lead ? m[0].length - (m[1] ? m[1].length : 0) : m[0].length);
            const from = r.startOffset - mdLen;
            const wrap = el(tag === 'code' ? 'code' : tag, tag === 'code' ? { class: 'md-code' } : (tag === 'mark' ? { class: 'md-mark' } : {}), inner);
            const after = node.splitText(r.startOffset);
            node.textContent = (node.textContent || '').slice(0, from);
            node.parentNode.insertBefore(wrap, after);
            // 캐럿 패딩 — 마크 바로 뒤 빈 경계는 브라우저가 이어지는 타이핑을 마크 '안'으로 넣는다(볼드 지속).
            //  ZWSP 텍스트 노드를 끼우고 그 뒤에 캐럿 → 다음 타이핑이 마크 밖 평문. 직렬화(escInline)가 ZWSP 제거.
            const pad = document.createTextNode('\u200B');
            node.parentNode.insertBefore(pad, after);
            const s = window.getSelection();
            const nr = document.createRange();
            nr.setStart(pad, 1);
            nr.collapse(true);
            s.removeAllRanges();
            s.addRange(nr);
            markDirty();
            return;
        }
    }
    // 병합 — front 끝에 back 의 자식들을 옮기고 캐럿을 접합점(자식 인덱스 경계)에.
    function placeCaretJunctionMerge(front, back) {
        front.focus();
        const idx = front.childNodes.length;
        while (back.firstChild)
            front.appendChild(back.firstChild);
        const s = window.getSelection();
        const nr = document.createRange();
        nr.setStart(front, Math.min(idx, front.childNodes.length));
        nr.collapse(true);
        s.removeAllRanges();
        s.addRange(nr);
    }
    // ── 체크박스/추가 버튼/빈 영역 클릭 ──
    root.addEventListener('change', (e) => {
        const cb = e.target;
        if (!cb.classList || !cb.classList.contains('be-check'))
            return;
        const block = blockOf(cb);
        block.dataset.checked = cb.checked ? '1' : '';
        const t = textElOf(block);
        if (t)
            t.classList.toggle('be-done', cb.checked);
        markDirty();
    });
    root.addEventListener('click', (e) => {
        const add = e.target.closest ? e.target.closest('.be-addbtn') : null;
        if (add) {
            const block = blockOf(add);
            const nb = insertBlockAfter(block, { type: 'p', text: '' });
            focusBlock(nb);
            openSlashMenu(nb, false);
            return;
        }
        // ⋮⋮ 클릭 = 블록 메뉴(전환·복제·이동·삭제) — 드래그 직후 클릭은 무시(#657n, 노션 동일).
        const h = e.target.closest ? e.target.closest('.be-handle') : null;
        if (h) {
            if (justDragged)
                return;
            const block = blockOf(h);
            openBlockMenu(block, h);
            return;
        }
        // 에디터 안 내부 링크(#/k/… 멘션 등) 클릭 = 이동(노션 멘션 동일). 외부 링크는 기본(캐럿).
        const link = e.target.closest ? e.target.closest('a[href]') : null;
        if (link && root.contains(link)) {
            const href = link.getAttribute('href') || '';
            if (href.startsWith('#/')) {
                e.preventDefault();
                location.hash = href;
                return;
            }
        }
        if (e.target === root) { // 본문 아래 여백 클릭 → 마지막 블록(비면 그거, 아니면 새 문단)
            const bs = blockEls();
            const last = bs[bs.length - 1];
            const lt = last ? textElOf(last) : null;
            if (last && lt && last.dataset.type === 'p' && !lt.textContent)
                focusBlock(last, false);
            else
                focusBlock(insertBlockAfter(last || null, { type: 'p', text: '' }));
        }
    });
    // ── 붙여넣기 — 마크다운/여러 줄이면 블록으로 파싱해 삽입, 한 줄이면 평문 삽입 ──
    root.addEventListener('paste', (e) => {
        const target = e.target;
        if (target.classList && (target.classList.contains('be-raw-ta') || target.classList.contains('be-code-lang')))
            return;
        const block = blockOf(target);
        if (!block || !target.classList || !target.classList.contains('be-text'))
            return;
        // #730 이미지 붙여넣기 — 클립보드에 이미지 파일이 있고 업로더가 있으면 인라인 삽입(첨부로 새지 않음).
        const cd = e.clipboardData || window.clipboardData;
        if (opts.uploadFile && cd) {
            const imgs = [];
            for (const it of (cd.items || [])) {
                if (it.kind === 'file' && /^image\//.test(it.type || '')) {
                    const f = it.getAsFile();
                    if (f)
                        imgs.push(f);
                }
            }
            if (!imgs.length)
                for (const f of (cd.files || [])) {
                    if (/^image\//.test(f.type || ''))
                        imgs.push(f);
                }
            const plain = cd.getData ? (cd.getData('text/plain') || '') : '';
            if (imgs.length && !plain.trim()) {
                e.preventDefault();
                insertUploadedImages(block, imgs);
                return;
            }
        }
        const text = (e.clipboardData || window.clipboardData).getData('text/plain');
        if (text == null)
            return;
        e.preventDefault();
        if (block.dataset.type === 'code') {
            insertText(text);
            markDirty();
            return;
        }
        const hasBlockMd = /\n/.test(text) || /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|:::|\|)/.test(text.trim());
        if (!hasBlockMd) {
            insertText(text);
            markDirty();
            return;
        }
        const parsed = mdToBlocks(text);
        // 첫 파싱 블록이 문단이면 현재 캐럿에 인라인로 잇고, 나머지는 새 블록으로.
        let rest = parsed;
        if (parsed[0] && parsed[0].type === 'p' && TEXTY.has(block.dataset.type)) {
            const r = caretRange();
            if (r) {
                const frag = document.createDocumentFragment();
                String(parsed[0].text || '').split('\n').forEach((l, idx) => {
                    if (idx > 0)
                        frag.append(el('br'));
                    for (const n of renderInline(l))
                        frag.append(n);
                });
                r.deleteContents();
                r.insertNode(frag);
                placeCaret(target, false);
            }
            rest = parsed.slice(1);
        }
        let anchor = block;
        for (const d of rest)
            anchor = insertBlockAfter(anchor, d);
        renumber();
        markDirty();
        if (rest.length)
            focusBlock(anchor, false);
    });
    // ── #730 이미지 드롭 — 파일을 에디터에 끌어다 놓으면 인라인 삽입(업로더 있을 때만) ──
    root.addEventListener('dragover', (e) => {
        if (opts.uploadFile && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
            e.preventDefault();
        }
    });
    root.addEventListener('drop', (e) => {
        if (!opts.uploadFile || !e.dataTransfer)
            return;
        const files = Array.from(e.dataTransfer.files || []).filter((f) => /^image\//.test(f.type || ''));
        if (!files.length)
            return;
        e.preventDefault();
        const block = blockOf(e.target) || blockEls()[blockEls().length - 1];
        if (block)
            insertUploadedImages(block, files);
    });
    // ── 블록 메뉴(⋮⋮ 클릭) — 전환(단순 텍스트 블록) + 복제/이동/삭제. 노션 핸들 메뉴 동형(#657n). ──
    function openBlockMenu(block, anchor) {
        const old = document.querySelector('.be-blockmenu');
        if (old) {
            old.remove();
            return;
        }
        const type = block.dataset.type;
        const menu = el('div', { class: 'be-blockmenu', role: 'menu' });
        const close = () => { menu.remove(); document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey, true); };
        if (['p', 'h', 'bullet', 'numbered', 'todo', 'quote', 'callout', 'code'].includes(type)) {
            menu.append(el('div', { class: 'be-bm-head', text: '전환' }));
            const grid = el('div', { class: 'be-bm-grid' });
            for (const it of SLASH_ITEMS) {
                if (!['text', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'toggle', 'columns', 'quote', 'callout', 'code'].includes(it.k))
                    continue;
                const b = el('button', { class: 'be-bm-turn', type: 'button', title: it.label, text: it.ic });
                b.addEventListener('mousedown', (ev) => ev.preventDefault());
                b.onclick = () => { close(); it.apply(block); };
                grid.append(b);
            }
            menu.append(grid, el('div', { class: 'be-bm-hr' }));
        }
        const item = (ic, label, fn, danger) => {
            const b = el('button', { class: 'be-bm-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { class: 'be-bm-ic', 'aria-hidden': 'true', text: ic }), el('span', { text: label }));
            b.onclick = () => { close(); fn(); };
            return b;
        };
        menu.append(item('⧉', '복제 — ⌘D', () => duplicateBlock(block)), item('↑', '위로 이동 — ⌘⇧↑', () => moveBlockDir(block, -1)), item('↓', '아래로 이동 — ⌘⇧↓', () => moveBlockDir(block, 1)), item('✕', '삭제', () => deleteBlock(block), true));
        document.body.append(menu);
        const r = anchor.getBoundingClientRect();
        const mh = menu.offsetHeight || 220;
        menu.style.left = Math.max(8, Math.min(r.left - 6, window.innerWidth - 246)) + 'px';
        menu.style.top = (r.bottom + 6 + mh > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
        const onDoc = (ev) => { if (!menu.contains(ev.target))
            close(); };
        const onKey = (ev) => { if (ev.key === 'Escape') {
            ev.stopPropagation();
            close();
        } };
        setTimeout(() => { document.addEventListener('mousedown', onDoc, true); document.addEventListener('keydown', onKey, true); }, 0);
    }
    // ── 드래그 — 위/아래 재정렬 + 좌/우 엣지 드롭 = 컬럼 생성(노션 시그니처 레이아웃, #657n). ──
    //  타깃은 elementFromPoint 로(중첩 컨테이너 안 블록도 정타깃). 컬럼 생성은 최상위 블록 간에만(중첩 컬럼 금지).
    let dragging = null;
    let justDragged = false;
    root.addEventListener('dragstart', (e) => {
        const h = e.target.closest ? e.target.closest('.be-handle') : null;
        if (!h) {
            e.preventDefault();
            return;
        }
        dragging = blockOf(h);
        if (!dragging)
            return;
        histFlushTyping(); // 드래그 직전 타이핑 버스트 확정 — undo 가 드래그만 되돌리도록
        justDragged = true;
        dragging.classList.add('be-dragging');
        e.dataTransfer.effectAllowed = 'move';
        try {
            e.dataTransfer.setData('text/plain', '');
            e.dataTransfer.setDragImage(dragging, 24, 12);
        }
        catch (_) { /* noop */ }
    });
    const DROP_CLASSES = ['be-drop-above', 'be-drop-below', 'be-drop-left', 'be-drop-right'];
    const clearDrop = () => root.querySelectorAll('.' + DROP_CLASSES.join(', .')).forEach((n) => n.classList.remove(...DROP_CLASSES));
    function dropTargetAt(e) {
        const under = document.elementFromPoint(e.clientX, e.clientY);
        let target = under && under.closest ? under.closest('.be-block') : null;
        if (target && (!root.contains(target) || target === dragging || dragging.contains(target) || target.contains(dragging)))
            target = null;
        if (target)
            return target;
        // 여백 폴백 — 루트 직계 블록을 Y 로 스캔(기존 동작).
        let fb = null;
        for (const b of blockEls()) {
            if (b === dragging || b.contains(dragging))
                continue;
            const r = b.getBoundingClientRect();
            if (e.clientY < r.top + r.height / 2)
                return b;
            fb = b;
        }
        return fb;
    }
    root.addEventListener('dragover', (e) => {
        if (!dragging)
            return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearDrop();
        const target = dropTargetAt(e);
        if (!target)
            return;
        const r = target.getBoundingClientRect();
        // 좌/우 엣지 = 컬럼 생성 힌트 — 루트 직계 + 양쪽 다 컬럼 아님일 때만.
        const EDGE = Math.min(72, Math.max(28, r.width * 0.16));
        const canCol = target.parentElement === root && target.dataset.type !== 'columns' && dragging.dataset.type !== 'columns';
        if (canCol && e.clientX < r.left + EDGE) {
            target.classList.add('be-drop-left');
            return;
        }
        if (canCol && e.clientX > r.right - EDGE) {
            target.classList.add('be-drop-right');
            return;
        }
        target.classList.add(e.clientY < r.top + r.height / 2 ? 'be-drop-above' : 'be-drop-below');
    });
    root.addEventListener('drop', (e) => {
        if (!dragging)
            return;
        e.preventDefault();
        const t = root.querySelector('.' + DROP_CLASSES.join(', .'));
        if (t && t !== dragging) {
            if (t.classList.contains('be-drop-left') || t.classList.contains('be-drop-right')) {
                // 컬럼 생성 — 새 컨테이너에 [드래그, 타깃](왼쪽 드롭) 또는 [타깃, 드래그] 순으로 실 DOM 이동.
                const left = t.classList.contains('be-drop-left');
                const shell = makeBlock({ type: 'columns', cols: [[], []], __shell: true });
                t.before(shell);
                const cols = shell.querySelectorAll(':scope > .be-main > .be-cols > .be-col');
                cols[0].append(left ? dragging : t);
                cols[1].append(left ? t : dragging);
            }
            else if (t.classList.contains('be-drop-above')) {
                t.before(dragging);
            }
            else {
                t.after(dragging);
            }
            normalizeStructure();
            markDirty();
        }
        clearDrop();
    });
    root.addEventListener('dragend', () => {
        if (dragging)
            dragging.classList.remove('be-dragging');
        dragging = null;
        clearDrop();
        setTimeout(() => { justDragged = false; }, 50); // 드래그 직후 handle click 오발 방지
    });
    // ════════ #657z 실행취소 히스토리 ════════
    // 마크다운 스냅샷 스택 — 네이티브 undo 가 모르는 구조 변경(드래그·전환·삭제·컬럼·컬렉션 설정…)까지
    //  ⌘Z/⌘⇧Z(Ctrl+Y) 한 계층으로 되돌린다. 라운드트립이 무손실이라 스냅샷 = 마크다운으로 충분.
    //  · 구조 변경: markDirty → snapSoon(setTimeout 0) — 복합 연산도 동기 프레임 끝 상태 1장 = 1스텝.
    //  · 타이핑: markDirtyType → snapLater(600ms) — 버스트 단위 1스텝. 구조 키(Enter/Tab/⌘조합) 직전
    //    histFlushTyping 으로 버스트를 확정해 "타이핑 → Enter 분할"이 두 스텝으로 남는다(노션 동일 감각).
    //  raw 블록 textarea 내부는 네이티브 undo(stopPropagation), 커밋 시점만 스택에 잡힌다.
    const HIST_MAX = 100;
    const hist = [];
    let histPos = -1;
    let histTimerT = null; // 타이핑 디바운스
    let histTimerS = null; // 구조 코얼레싱
    const editorMd = () => blocksToMd(blockEls().map(blockData));
    function captureFocus() {
        const s = window.getSelection();
        if (!s || !s.rangeCount)
            return null;
        const r = s.getRangeAt(0);
        const sc = r.startContainer;
        const eln = sc.nodeType === 3 ? sc.parentElement : sc;
        const t = eln && eln.closest ? eln.closest('.be-text') : null;
        if (!t || !root.contains(t))
            return null;
        const b = blockOf(t);
        if (!b)
            return null;
        const idx = Array.from(root.querySelectorAll('.be-block')).indexOf(b);
        if (idx < 0)
            return null;
        const pre = document.createRange();
        pre.selectNodeContents(t);
        try {
            pre.setEnd(r.startContainer, r.startOffset);
        }
        catch {
            return { idx, off: 0 };
        }
        return { idx, off: pre.toString().length };
    }
    function restoreFocus(f) {
        const bs = Array.from(root.querySelectorAll('.be-block'));
        if (!bs.length)
            return;
        const b = bs[Math.max(0, Math.min(f ? f.idx : bs.length - 1, bs.length - 1))];
        const t = textElOf(b);
        if (!t) {
            focusBlock(b, false);
            return;
        }
        t.focus();
        let remain = f ? f.off : (t.textContent || '').length;
        const w = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
        let n = w.nextNode();
        while (n) {
            const len = (n.textContent || '').length;
            if (remain <= len) {
                const nr = document.createRange();
                nr.setStart(n, remain);
                nr.collapse(true);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(nr);
                return;
            }
            remain -= len;
            n = w.nextNode();
        }
        placeCaret(t, false);
    }
    function snapNow() {
        if (histLock)
            return;
        if (composing) {
            snapLater();
            return;
        } // IME 조합 중 상태는 담지 않는다 — 종료 후로 미룸
        clearTimeout(histTimerT);
        histTimerT = null;
        clearTimeout(histTimerS);
        histTimerS = null;
        const md = editorMd();
        if (histPos >= 0 && hist[histPos].md === md)
            return;
        hist.length = histPos + 1; // redo 꼬리 절단
        hist.push({ md, focus: captureFocus() });
        if (hist.length > HIST_MAX)
            hist.shift();
        histPos = hist.length - 1;
    }
    function snapSoon() { if (histLock || histTimerS)
        return; histTimerS = setTimeout(() => { histTimerS = null; snapNow(); }, 0); }
    function snapLater() { if (histLock)
        return; clearTimeout(histTimerT); histTimerT = setTimeout(() => { histTimerT = null; snapNow(); }, 600); }
    function histFlushTyping() { if (histTimerT && !composing)
        snapNow(); }
    function resetHistory() {
        clearTimeout(histTimerT);
        histTimerT = null;
        clearTimeout(histTimerS);
        histTimerS = null;
        hist.length = 0;
        hist.push({ md: editorMd(), focus: null });
        histPos = 0;
    }
    function applyHistory(pos) {
        if (pos < 0 || pos >= hist.length)
            return;
        const h = hist[pos];
        histLock = true;
        try {
            closeSlashMenu();
            closeMention();
            //  #764 부분 패치 — 블록 개수가 같으면 '달라진 블록만' 교체해 나머지 DOM·캐럿·스크롤을 보존한다.
            //  (전체 replaceChildren 은 매 undo 마다 문서 전체를 다시 그려 깜빡임·캐럿튐을 유발) 구조 변경(개수 상이)은 안전하게 전체 재구성.
            const target = mdToBlocks(h.md);
            const cur = blockEls();
            if (target.length > 0 && cur.length === target.length) {
                for (let k = 0; k < target.length; k++) {
                    const tMd = blocksToMd([target[k]]);
                    const cMd = blocksToMd([blockData(cur[k])]);
                    if (cMd !== tMd)
                        cur[k].replaceWith(makeBlock(target[k]));
                }
            }
            else {
                root.replaceChildren(...target.map(makeBlock));
            }
            ensureOne();
            renumber();
        }
        finally {
            histLock = false;
        }
        histPos = pos;
        try {
            restoreFocus(h.focus);
        }
        catch { /* 캐럿 복원은 최선노력 */ }
        dirty = true; // 되돌린 상태도 자동저장 대상
        if (opts.onChange)
            opts.onChange();
    }
    function histUndo() { histFlushTyping(); if (histPos > 0)
        applyHistory(histPos - 1); }
    function histRedo() { if (histPos < hist.length - 1)
        applyHistory(histPos + 1); }
    // ── 로드/공개 API ──
    function load(md) {
        closeSlashMenu();
        root.replaceChildren(...mdToBlocks(md || '').map(makeBlock));
        ensureOne();
        renumber();
    }
    load(opts.initial || '');
    resetHistory();
    return {
        el: root,
        getMarkdown: () => blocksToMd(blockEls().map(blockData)),
        setMarkdown: (md) => {
            // 사용자가 이미 만지던 에디터라면(히스토리 2스텝↑ 또는 미저장 편집) 교체를 undo 가능한 1스텝으로 남긴다 — 대문 템플릿 적용 등.
            const live = hist.length > 1 || dirty;
            if (live)
                snapNow();
            load(md);
            if (live)
                snapNow();
            else
                resetHistory();
            dirty = false;
        },
        isDirty: () => dirty,
        resetDirty: () => { dirty = false; },
        isEmpty: () => isEmptyNow(),
        focusEnd: () => { const bs = blockEls(); if (bs.length)
            focusBlock(bs[bs.length - 1], false); },
        destroy: () => {
            clearTimeout(histTimerT);
            clearTimeout(histTimerS);
            document.removeEventListener('selectionchange', onSelChange);
            tools.remove();
            closeSlashMenu();
            closeMention();
            for (const sel of ['.be-blockmenu', '.be-turnpop', '.be-linkpop']) {
                const n = document.querySelector(sel);
                if (n)
                    n.remove();
            }
        },
    };
}
export { mdToBlocks, blocksToMd, inlineDomToMd };

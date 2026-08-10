// editor/serialize.ts — 블록 → markdown 직렬화(#1313 R58 — block-editor.ts §2 verbatim 적출).
//  inlineDomToMd 만 DOM 노드를 인자로 받고(문서 전역 API 는 안 씀), 나머지는 순수 함수.
//  왕복(parse↔serialize) 계약은 scripts/block-editor-roundtrip.test.mjs 가 고정한다.
import { LISTY } from './model.js';
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
                //  시작 번호(#1581) — run 첫 항목의 it.start 를 존중(이후는 +1). 화면 마커(blocks.ts renumber)와 같은 규칙이라
                //  '보이는 번호 = 저장되는 번호'가 유지된다.
                if (it.type === 'numbered') {
                    counters[d] = counters[d] ? counters[d] + 1 : Math.max(1, Number(it.start) || 1);
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
export { escInline, escLineStart, inlineDomToMd, blocksToMd };

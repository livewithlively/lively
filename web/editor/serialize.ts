// editor/serialize.ts — 블록 → markdown 직렬화(#1313 R58 — block-editor.ts §2 verbatim 적출).
//  inlineDomToMd 만 DOM 노드를 인자로 받고(문서 전역 API 는 안 씀), 나머지는 순수 함수.
//  왕복(parse↔serialize) 계약은 scripts/block-editor-roundtrip.test.mjs 가 고정한다.
import { LISTY } from './model.js';

// ════════════════════════════════════════════
// §2 블록 → markdown 직렬화 — 왕복 보존이 목표(리스트 마커 '-'·번호 재부여 정도의 정규화만).
// ════════════════════════════════════════════
// [[위키링크]] 문법 — 서버 src/v6/wikilink.ts RE_WIKI 와 **같은 식**이어야 한다(왕복 골든이 source 일치를 검사).
//  renderInline 은 [[…]] 를 링크로 만들지 않으니 에디터 안에선 평문 텍스트로 산다. 그 평문의 '[' 까지 이스케이프하면
//  저장본이 \[\[…]] 가 되어 서버가 위키링크로 못 센다 — 웹에서 한 번 고치면 문서의 자동 연결이 전부 끊겼다(#4419).
const RE_WIKI = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;

function escText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\*/g, '\\*')
    .replace(/~~/g, '\\~~')
    .replace(/\+\+/g, '\\++')
    .replace(/\[/g, '\\[');
}
// 평문 텍스트 이스케이프 — 다음 로드에서 인라인 마크로 오파싱될 문자만 최소로(모두 renderInline 이스케이프 목록 내).
//  위키링크 토큰은 겉 괄호 '[[' ']]' 만 원형으로 두고 안쪽은 같은 규칙으로 이스케이프한다
//  (문서 이름·제목엔 이스케이프 대상 문자가 없어 실제로는 토큰 전체가 원형 그대로 나간다).
//  ZWSP(U+200B)는 인라인 변환의 캐럿 패딩(마크 지속 차단) 잔재 — 직렬화에서 제거(위키링크 판정 전에).
function escInline(s: string): string {
  const t = String(s).replace(/\u200B/g, '');
  let out = '';
  let last = 0;
  for (const m of t.matchAll(RE_WIKI)) {
    out += escText(t.slice(last, m.index)) + '[[' + escText(m[0].slice(2, -2)) + ']]';
    last = (m.index as number) + m[0].length;
  }
  return out + escText(t.slice(last));
}
// 문단 줄이 블록 문법으로 재파싱되지 않게 줄머리만 이스케이프.
function escLineStart(l: string): string {
  if (/^(#{1,6})\s/.test(l)) return '\\' + l;
  if (/^(\s*)([-*+])\s/.test(l)) return l.replace(/([-*+])/, '\\$1');
  if (/^(\s*)(\d+)([.)])\s/.test(l)) return l.replace(/([.)])/, '\\$1');
  if (/^>/.test(l)) return '\\' + l;
  if (/^\|/.test(l)) return '\\' + l;
  if (/^(-{3,}|_{3,})\s*$/.test(l)) return '\\' + l;
  return l;
}

// renderInline 이 [[…]] 로 그린 지식 링크(data-wiki-*) → 원문 [[…]]. 링크로 그렸다고 [라벨](#/k/…) 로 저장하면
//  문서를 열기만 해도 본문이 바뀌고(저장 왕복 깨짐) 서버가 세는 위키링크 문법에서 벗어난다(#4419 와 같은 결과).
//  라벨을 고쳤으면 [[대상|새 라벨]], 라벨을 비웠으면 링크를 지운 것으로 본다. 주소를 바꾼 링크는 호출부가 일반 링크로 둔다.
//  라벨 안에 건 서식(굵게 등)은 저장되지 않는다 — 비교가 글자(textContent)라 위키링크 문법에 서식 자리가 없다.
function wikiAnchorToMd(a: any): string {
  const label = String(a.textContent || '').replace(/\u200B/g, '');
  if (label === a.dataset.wikiLabel) return a.dataset.wikiRaw;
  if (!label.trim()) return '';
  return '[[' + a.dataset.wikiTarget + '|' + label.replace(/[[\]\n`]/g, '') + ']]';
}

// 인라인 DOM → markdown. renderInline 의 역함수(strong/em/del/u/mark/code/a/img/br).
//  이웃한 텍스트 노드는 이어 붙인 뒤 한 번에 이스케이프한다 — 편집하면 텍스트 노드가 쪼개지는데('[[' | 'name]]'),
//  노드별로 보면 경계에 걸친 위키링크·'~~'·'++' 를 못 알아본다.
function inlineDomToMd(node: any): string {
  let out = '';
  let text = '';
  const flush = () => { if (text) { out += escInline(text); text = ''; } };
  for (const c of node.childNodes) {
    if (c.nodeType === 3) { text += c.textContent; continue; }
    if (c.nodeType !== 1) continue;
    flush();
    const tag = c.tagName;
    if (tag === 'BR') { out += '\n'; continue; }
    if (tag === 'IMG') {
      const src = c.dataset && c.dataset.mdSrc ? c.dataset.mdSrc : (c.getAttribute('src') || '');
      out += '![' + String(c.getAttribute('alt') || '').replace(/\]/g, '') + '](' + src + ')';
      continue;
    }
    if (tag === 'A' && c.dataset && c.dataset.wikiRaw && c.getAttribute('href') === c.dataset.wikiHref) {
      out += wikiAnchorToMd(c);
      continue;
    }
    const inner = inlineDomToMd(c);
    if (tag === 'A') { out += '[' + inner + '](' + (c.getAttribute('href') || '') + ')'; continue; }
    if (tag === 'CODE') { out += '`' + c.textContent.replace(/`/g, '').replace(/\u200B/g, '') + '`'; continue; }
    if (!inner) continue;   // 빈 마크는 버림
    if (tag === 'STRONG' || tag === 'B') out += '**' + inner + '**';
    else if (tag === 'EM' || tag === 'I') out += '*' + inner + '*';
    else if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') out += '~~' + inner + '~~';
    else if (tag === 'U') out += '++' + inner + '++';
    else if (tag === 'MARK') out += '==' + inner + '==';
    else out += inner;   // span 등 미지 요소는 투명(내용만)
  }
  flush();
  return out;
}

function blocksToMd(blocks: any[]): string {
  const chunks: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (LISTY.has(b.type)) {
      // 연속 리스트 블록 = 한 run(항목 사이 빈 줄 없음). 번호는 (indent별) 재부여.
      const lines: string[] = [];
      const counters: number[] = [];
      let j = i;
      while (j < blocks.length && LISTY.has(blocks[j].type)) {
        const it = blocks[j];
        const d = Math.min(it.indent || 0, 4);
        counters.length = d + 1;   // 더 깊은 카운터 리셋
        let marker = '-';
        //  시작 번호(#1581) — run 첫 항목의 it.start 를 존중(이후는 +1). 화면 마커(blocks.ts renumber)와 같은 규칙이라
        //  '보이는 번호 = 저장되는 번호'가 유지된다.
        if (it.type === 'numbered') { counters[d] = counters[d] ? counters[d] + 1 : Math.max(1, Number(it.start) || 1); marker = counters[d] + '.'; }
        else counters[d] = 0;
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
        if (!cols.length) break;
        if (cols.length === 1) { chunks.push(blocksToMd(cols[0])); break; }
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
        if (a.category) line += ' category=' + a.category;
        if (a.type) line += ' type=' + a.type;
        line += ' limit=' + Math.min(Math.max(Number(a.limit) || 5, 1), 12);
        if (a.view === 'cards') line += ' view=cards';
        if (a.sort === 'title') line += ' sort=title';
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

export { RE_WIKI, escInline, escLineStart, inlineDomToMd, blocksToMd };

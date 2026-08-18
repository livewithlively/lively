// editor/parse.ts — markdown → 블록 파서(#1313 R58 — block-editor.ts §1 verbatim 적출).
//  순수 함수(DOM 무관) — 러너의 왕복 골든 테스트(scripts/block-editor-roundtrip.test.mjs)가 컴파일 산출물을 직접 import 한다.
import { CALLOUT_COLORS, LISTY } from './model.js';

// ════════════════════════════════════════════
// §1 markdown → 블록 파서 — core.renderMarkdown 의 블록 규칙과 1:1(같은 문법을 블록 데이터로).
// ════════════════════════════════════════════
function mdToBlocks(md: string): any[] {
  const out: any[] = [];
  const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
  const isTableSep = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.indexOf('-') >= 0;
  const contOpen = (l) => /^:::\s*[a-zA-Z_-]/.test(l);
  const contClose = (l) => l.trim() === ':::';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    // 코드 펜스 ``` / ~~~
    const fence = /^(```|~~~)(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1];
      const code: string[] = [];
      i++;
      while (i < lines.length && lines[i].trimEnd() !== marker && !lines[i].startsWith(marker)) { code.push(lines[i]); i++; }
      if (i < lines.length) i++;
      out.push({ type: 'code', lang: (fence[2] || '').trim(), text: code.join('\n') });
      continue;
    }

    // ::: 컨테이너 — callout(중첩 없음)·toggle(내용 재귀)·columns(:::column 재귀)는 1급 블록(#657n),
    //  그 외(synced/toc/미지)와 파스 실패는 raw 로 무손실 보존.
    const cont = /^:::\s*([a-zA-Z_-]+)\s*(.*)$/.exec(line);
    if (cont) {
      const rawLines = [line];
      const body: string[] = [];
      let depth = 1, nested = false, inFence = false, closed = false;
      i++;
      while (i < lines.length && depth > 0) {
        const l = lines[i];
        if (/^(```|~~~)/.test(l)) inFence = !inFence;
        else if (!inFence && contOpen(l)) { depth++; nested = true; }
        else if (!inFence && contClose(l)) { depth--; if (depth === 0) { rawLines.push(l); i++; closed = true; break; } }
        rawLines.push(l); body.push(l);
        i++;
      }
      if (cont[1] === 'callout' && closed && !nested) {
        const attrs: any = {};
        for (const tok of String(cont[2] || '').split(/\s+/)) {
          const m = /^([a-zA-Z_-]+)=(.*)$/.exec(tok);
          if (m) attrs[m[1]] = m[2];
        }
        const color = String(attrs.color || '').replace(/_background$/, '').replace(/[^a-z]/g, '') || 'default';
        out.push({ type: 'callout', icon: attrs.icon || '💡', color: CALLOUT_COLORS.includes(color) ? color : 'default', text: body.join('\n') });
      } else if ((cont[1] === 'toggle' || cont[1] === 'template') && closed) {
        // 토글 — 요약(선두 attr 토큰 제외한 rest, renderContainer 동일 규칙) + 내용 재귀 파스. template 은 노션 미러 방언.
        let summary = '';
        for (const tok of String(cont[2] || '').split(/\s+/)) {
          if (!tok) continue;
          if (!summary && /^[a-zA-Z_-]+=/.test(tok)) continue;
          summary += (summary ? ' ' : '') + tok;
        }
        out.push({ type: 'toggle', summary, children: body.join('\n').trim() ? mdToBlocks(body.join('\n')) : [] });
      } else if (cont[1] === 'columns' && closed) {
        const cols = parseColumns(body);
        if (cols && cols.length) out.push({ type: 'columns', cols });
        else out.push({ type: 'raw', text: rawLines.join('\n') });
      } else if (cont[1] === 'collection' && closed) {
        // #657w 라이브 컬렉션 — 본문 없는 설정 컨테이너. attrs 만 블록 데이터로.
        const attrs: any = {};
        for (const tok of String(cont[2] || '').split(/\s+/)) {
          const m = /^([a-zA-Z_-]+)=(.*)$/.exec(tok);
          if (m) attrs[m[1]] = m[2];
        }
        out.push({ type: 'collection', attrs });
      } else {
        out.push({ type: 'raw', text: rawLines.join('\n') });
      }
      continue;
    }
    if (contClose(line)) { out.push({ type: 'raw', text: line }); i++; continue; }

    // 수식 $$…$$ — raw 보존.
    if (line.trim() === '$$') {
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) { if (lines[j].trim() === '$$') { close = j; break; } }
      if (close >= 0) { out.push({ type: 'raw', text: lines.slice(i, close + 1).join('\n') }); i = close + 1; }
      else { out.push({ type: 'raw', text: line }); i++; }
      continue;
    }

    // 표 — raw 보존(렌더 미리보기 + 원문 편집).
    if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const tbl = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') >= 0) { tbl.push(lines[i]); i++; }
      out.push({ type: 'raw', text: tbl.join('\n') });
      continue;
    }

    // 제목
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out.push({ type: 'h', level: Math.min(h[1].length, 6), text: h[2].trim() }); i++; continue; }

    // 구분선
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push({ type: 'divider' }); i++; continue; }

    // 인용(연속 줄 = 한 블록)
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
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
          const m: any = bm || om;
          const indent = Math.min(Math.floor(m[1].replace(/\t/g, '  ').length / 2), 4);
          let text = m[3];
          let checked: any = null;
          if (bm) {
            const cb = /^\[( |x|X)\]\s+(.*)$/.exec(text);
            if (cb) { checked = cb[1] !== ' '; text = cb[2]; }
          }
          // 번호 목록은 원문의 시작 번호를 실어 보낸다(#1581) — `2.` 로 시작한 목록이 다시 열 때 1 로 돌아가지 않게.
          //  단 **시퀀스가 새로 시작하는 항목에만** 심는다(renumber 의 카운터 리셋 조건과 같은 판정: 앞이 목록이 아니거나,
          //  더 얕은 항목 뒤라 이 깊이의 카운터가 없는 경우). 이어지는 항목에까지 남기면 앞 항목을 지웠을 때
          //  옛 번호가 시작값으로 되살아난다.
          const prevIt: any = out.length ? out[out.length - 1] : null;
          const runStart = !prevIt || !LISTY.has(prevIt.type) || (prevIt.indent || 0) < indent;
          out.push({ type: checked != null ? 'todo' : (om ? 'numbered' : 'bullet'), indent, checked: !!checked,
            ...(om && runStart ? { start: Number(om[2]) } : {}), text });
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
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') break;
      if (/^(#{1,6})\s+/.test(l) || /^(```|~~~)/.test(l) || /^\s*>\s?/.test(l) ||
          /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l) || /^(\s*)([-*+])\s+/.test(l) ||
          /^(\s*)(\d+)[.)]\s+/.test(l) || contOpen(l) || contClose(l) || l.trim() === '$$' ||
          (l.indexOf('|') >= 0 && lines[i + 1] != null && isTableSep(lines[i + 1]))) break;
      para.push(l);
      i++;
    }
    // 이스케이프 해제는 renderInline 이 렌더 시 처리 — 파서는 원문 유지(직렬화가 재이스케이프).
    // #657w 페이지 카드 승격 — '내부 링크뿐인 줄'은 pagecard 블록으로 분리(core renderMarkdown 과 동일 규칙).
    let buf: string[] = [];
    const flushBuf = () => { if (buf.length) { out.push({ type: 'p', text: buf.join('\n') }); buf = []; } };
    for (const l of para) {
      const pc = /^\s*\[([^\]\n]+)\]\(#\/k\/([^)\s]+)\)\s*$/.exec(l);
      if (pc) {
        flushBuf();
        let nm = pc[2];
        try { nm = decodeURIComponent(pc[2]); } catch (_) { /* 인코딩 오류 — 원문 유지 */ }
        out.push({ type: 'pagecard', name: nm, label: pc[1] });
      } else buf.push(l);
    }
    flushBuf();
  }
  if (!out.length) out.push({ type: 'p', text: '' });
  return out;
}

// :::columns 본문 → 컬럼별 블록 배열(본문이 :::column 컨테이너로만 구성돼야 성립 — 아니면 null=raw 폴백).
function parseColumns(lines: string[]): any[][] | null {
  const cols: any[][] = [];
  const contOpen = (l) => /^:::\s*[a-zA-Z_-]/.test(l);
  const contClose = (l) => l.trim() === ':::';
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim() === '') { i++; continue; }
    if (!/^:::\s*column(\s|$)/.test(l)) return null;
    const body: string[] = [];
    let depth = 1, inFence = false, closed = false;
    i++;
    while (i < lines.length && depth > 0) {
      const s = lines[i];
      if (/^(```|~~~)/.test(s)) inFence = !inFence;
      else if (!inFence && contOpen(s)) depth++;
      else if (!inFence && contClose(s)) { depth--; if (depth === 0) { i++; closed = true; break; } }
      body.push(s);
      i++;
    }
    if (!closed) return null;
    cols.push(body.join('\n').trim() ? mdToBlocks(body.join('\n')) : []);
  }
  return cols;
}

export { mdToBlocks, parseColumns };

// editor/render.ts — 블록 DOM 생성 + 카드/컬렉션/raw 미리보기(#1313 R58 — block-editor.ts '블록 DOM 생성' 절 verbatim 적출).
//  보안 불변식 유지: innerHTML 금지 — 모든 DOM 은 el/renderInline/renderMarkdown(전부 textContent 기반)로만.
import { api, el, renderCollection, renderInline, renderMarkdown } from '../core.js';
import { overlayBox } from '../learn.js';
import { openEmojiPicker } from '../page-decor.js';
import { CALLOUT_COLORS } from './model.js';
import type { EditorCtx } from './context.js';

export function createRender(ctx: EditorCtx) {
  // 늦은 바인딩 별칭(context.ts 참조) — 다른 모듈이 ctx 에 나중에 채우므로 호출 시점에 해석한다.
  const markDirty = () => ctx.markDirty();
  const markDirtyType = () => ctx.markDirtyType();
  const deleteBlock = (block: HTMLElement) => ctx.deleteBlock(block);
  const blockData = (block: HTMLElement) => ctx.blockData(block);
  const ensureOne = () => ctx.ensureOne();
  const renumber = () => ctx.renumber();
  const insertBlockAfter = (block: HTMLElement | null, data: any) => ctx.insertBlockAfter(block, data);
  const focusBlock = (block: HTMLElement, atStart?: boolean) => ctx.focusBlock(block, atStart);

  // ── 블록 DOM 생성 ──
  function textDiv(cls: string, mdText: string, ph?: string) {
    const t = el('div', { class: 'be-text ' + cls, contenteditable: 'true', ...(ph ? { 'data-ph': ph } : {}) });
    loadInline(t, mdText || '');
    return t;
  }
  // inline md → DOM (개행 = <br>). renderInline 재사용(보안 렌더 단일 소스).
  function loadInline(box: HTMLElement, mdText: string) {
    box.replaceChildren();
    const lns = String(mdText).split('\n');
    lns.forEach((l, idx) => {
      if (idx > 0) box.append(el('br'));
      for (const n of renderInline(l)) box.append(n);
    });
  }

  function makeBlock(d: any): HTMLElement {
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
        main.append(textDiv('be-h be-h' + Math.min(lvl, 4), d.text, '제목 ' + Math.min(lvl, 4)));   // #730 H4 시각 구분(h5·h6 은 h4 스타일 공유)
        break;
      }
      case 'bullet': case 'numbered': case 'todo': {
        block.dataset.indent = String(Math.min(d.indent || 0, 4));
        const row = el('div', { class: 'be-li' });
        if (d.type === 'todo') {
          block.dataset.checked = d.checked ? '1' : '';
          const cb: any = el('input', { type: 'checkbox', class: 'be-check', tabindex: '-1' });
          cb.checked = !!d.checked;
          row.append(el('span', { class: 'be-li-lead', contenteditable: 'false' }, cb));
        } else {
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
        main.append(el('div', { class: 'be-callout md-callout-' + (d.color || 'default') },
          ic, textDiv('be-ctext', d.text, '콜아웃 내용'), paint));
        break;
      }
      case 'code': {
        block.dataset.lang = d.lang || '';
        const langIn = el('input', { class: 'be-code-lang', type: 'text', placeholder: 'lang', value: d.lang || '',
          spellcheck: 'false' }) as HTMLInputElement;
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
          href: '#/k/' + encodeURIComponent(d.name || '') },
          el('span', { class: 'md-pagecard-ic', 'aria-hidden': 'true', text: '📄' }),
          el('span', { class: 'md-pagecard-title', text: d.label || d.name || '' }),
          el('span', { class: 'md-pagecard-arrow', 'aria-hidden': 'true', text: '↗' })));
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
        (block as any)._raw = String(d.text || '');
        const view = el('div', { class: 'be-raw-view md-rendered', title: '클릭해서 마크다운 원문 편집' });
        view.append(renderMarkdown((block as any)._raw));
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
        for (const c of children) kids.append(makeBlock(c));
        caret.onclick = () => {
          const open = block.dataset.open !== '1';
          block.dataset.open = open ? '1' : '';
          caret.textContent = open ? '▾' : '▸';
        };
        main.append(el('div', { class: 'be-toggle' },
          el('div', { class: 'be-toggle-row' }, caret, textDiv('be-togglesum', d.summary || '', '토글 제목')),
          kids));
        break;
      }
      case 'columns': {
        // #657n 컬럼 — 블록을 나란히(노션 드래그 레이아웃). __shell=드래그 조립용(빈 컬럼 채움 생략).
        const colsWrap = el('div', { class: 'be-cols' });
        const cols = (d.cols && d.cols.length) ? d.cols : [[], []];
        for (const col of cols) {
          const colEl = el('div', { class: 'be-col' });
          const items = (col && col.length) ? col : (d.__shell ? [] : [{ type: 'p', text: '' }]);
          for (const c of items) colEl.append(makeBlock(c));
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
  function addRowDelete(block: HTMLElement) {
    const x = el('button', { class: 'be-block-x', type: 'button', title: '블록 삭제', text: '✕' });
    x.onclick = () => deleteBlock(block);
    block.append(x);
  }

  // #657w 컬렉션 미리보기 + ⚙ 설정 — 헤더(요약 라벨·설정)와 라이브 목록(renderCollection — 읽기 뷰와 동일).
  const COLL_TYPE_LABEL: Record<string, string> = { decision: '결정', concept: '개념', 'how-to': 'How-to', reference: '참조', research: '리서치', entity: '엔티티' };
  function collAttrsOf(block: HTMLElement) {
    return {
      category: block.dataset.cat || undefined,
      type: block.dataset.ktype || undefined,
      limit: Number(block.dataset.limit) || 5,
      view: block.dataset.view === 'cards' ? 'cards' : 'list',
      sort: block.dataset.ksort === 'title' ? 'title' : 'updated',
    };
  }
  function paintCollection(block: HTMLElement, wrap: HTMLElement) {
    const a = collAttrsOf(block);
    const label = (a.category ? '분류 ' + a.category : '전체') + (a.type ? ' · ' + (COLL_TYPE_LABEL[a.type] || a.type) : '')
      + ' · ' + a.limit + '개' + (a.sort === 'title' ? ' · 제목순' : ' · 최신순');
    const gear = el('button', { class: 'be-coll-gear', type: 'button', title: '컬렉션 조건 설정', text: '⚙ 설정' });
    gear.onclick = () => openCollectionConfig(block, wrap, gear);
    wrap.replaceChildren(
      el('div', { class: 'be-coll-head' },
        el('span', { class: 'be-coll-chip', text: '▤ 컬렉션' }),
        el('span', { class: 'be-coll-label', text: label }),
        gear),
      renderCollection(a));
  }
  function openCollectionConfig(block: HTMLElement, wrap: HTMLElement, anchor: HTMLElement) {
    const old = document.querySelector('.be-collpop');
    if (old) { old.remove(); return; }
    const catSel = el('select', { class: 'be-collpop-sel' }, el('option', { value: '', text: '전체 카테고리' })) as HTMLSelectElement;
    api('/api/ui/categories').then((d) => {
      for (const c of (d && d.categories) || []) catSel.append(el('option', { value: c.key, text: c.name || c.key }));
      catSel.value = block.dataset.cat || '';
    }).catch(() => { /* 목록 실패 — 전체만 */ });
    const typeSel = el('select', { class: 'be-collpop-sel' }, el('option', { value: '', text: '전체 유형' })) as HTMLSelectElement;
    for (const [v, label] of Object.entries(COLL_TYPE_LABEL)) typeSel.append(el('option', { value: v, text: label }));
    typeSel.value = block.dataset.ktype || '';
    const limitSel = el('select', { class: 'be-collpop-sel' },
      ...[3, 5, 8, 12].map((n) => el('option', { value: String(n), text: n + '개' }))) as HTMLSelectElement;
    limitSel.value = String(Number(block.dataset.limit) || 5);
    const viewSel = el('select', { class: 'be-collpop-sel' },
      el('option', { value: 'list', text: '목록' }), el('option', { value: 'cards', text: '카드' })) as HTMLSelectElement;
    viewSel.value = block.dataset.view === 'cards' ? 'cards' : 'list';
    const sortSel = el('select', { class: 'be-collpop-sel' },
      el('option', { value: 'updated', text: '최신순' }), el('option', { value: 'title', text: '제목순' })) as HTMLSelectElement;
    sortSel.value = block.dataset.ksort === 'title' ? 'title' : 'updated';
    const row = (label: string, node: any) => el('div', { class: 'be-collpop-row' },
      el('span', { class: 'be-collpop-k', text: label }), node);
    const pop = el('div', { class: 'be-collpop' },
      row('분류', catSel), row('유형', typeSel), row('개수', limitSel), row('보기', viewSel), row('정렬', sortSel));
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
    for (const s of [catSel, typeSel, limitSel, viewSel, sortSel]) s.addEventListener('change', applyNow);
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left - 120, window.innerWidth - 268)) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
    const onDoc = (ev: any) => { if (!pop.contains(ev.target) && ev.target !== anchor) close(); };
    setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
  }

  // #657w 페이지 카드 삽입 피커 — 문서 검색 오버레이(빈 검색=최근).
  function promptPageCard(block: HTMLElement) {
    const qIn = el('input', { type: 'search', placeholder: '문서 검색(제목·본문)' }) as HTMLInputElement;
    const results = el('div', { class: 'list-box', style: 'max-height:320px; overflow:auto; margin-top:10px;' });
    const back = overlayBox('페이지 카드 삽입',
      el('p', { class: 'admin-hint', text: '문서를 카드로 배치합니다 — 처음 보는 사람에게 핵심 문서를 안내할 때 좋아요.' }),
      el('div', { class: 'field' }, el('label', { class: 'field-label', text: '문서' }), qIn), results);
    const pick = (e: any) => {
      back.remove();
      const data = { type: 'pagecard', name: e.name, label: e.title || e.name };
      const cur = blockData(block);
      const empty = block.dataset.type === 'p' && !String(cur.text || '').trim();
      let nb: HTMLElement;
      if (empty) { nb = makeBlock(data); block.replaceWith(nb); ensureOne(); renumber(); markDirty(); }
      else nb = insertBlockAfter(block, data);
      focusBlock(insertBlockAfter(nb, { type: 'p', text: '' }));
    };
    let t: any = null;
    async function search() {
      const q = qIn.value.trim();
      results.replaceChildren(el('div', { class: 'empty', text: '불러오는 중…' }));
      try {
        const url = q ? ('/api/ui/knowledge/search?' + new URLSearchParams({ q, limit: '12', mode: 'names' }))
          : ('/api/ui/knowledge?' + new URLSearchParams({ limit: '12', orderBy: 'updated_at', injection: 'recalled' }));
        const r = await api(url);
        const entries = (((r && r.entries) || []) as any[])
          .filter((e) => !String(e.name || '').startsWith('category-home-') && !e.is_folder);
        if (!entries.length) { results.replaceChildren(el('div', { class: 'empty', text: '결과 없음' })); return; }
        results.replaceChildren(...entries.map((e) => el('div', { class: 'row', role: 'button', tabindex: '0', style: 'cursor:pointer',
          onclick: () => pick(e) },
          el('div', { class: 'row-title', text: (e.icon || '📄') + ' ' + (e.title || e.name) }))));
      } catch (_) { results.replaceChildren(el('div', { class: 'empty', text: '검색 실패' })); }
    }
    qIn.addEventListener('input', () => { clearTimeout(t); t = setTimeout(search, 250); });
    setTimeout(() => { qIn.focus(); search(); }, 0);
  }

  // raw 블록 — 원문 textarea 편집(블러/⌘Enter 커밋).
  function openRawEditor(block: HTMLElement, wrap: HTMLElement) {
    if (wrap.querySelector('.be-raw-ta')) return;
    const ta = el('textarea', { class: 'be-raw-ta', spellcheck: 'false' }) as HTMLTextAreaElement;
    ta.value = (block as any)._raw;
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(Math.max(ta.scrollHeight + 4, 60), 480) + 'px'; };
    ta.addEventListener('input', grow);
    const commit = () => {
      (block as any)._raw = ta.value;
      const view = el('div', { class: 'be-raw-view md-rendered', title: '클릭해서 마크다운 원문 편집' });
      view.append(renderMarkdown(ta.value));
      view.addEventListener('click', () => openRawEditor(block, wrap));
      ta.replaceWith(view);
      markDirty();
    };
    ta.addEventListener('blur', commit);
    ta.addEventListener('keydown', (e: any) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); ta.blur(); }
      e.stopPropagation();   // 에디터 전역 키핸들러(Enter 분할 등)와 충돌 방지
    });
    const view = wrap.querySelector('.be-raw-view');
    if (view) view.replaceWith(ta);
    grow();
    ta.focus();
  }

  function openCalloutColors(anchor: HTMLElement, block: HTMLElement) {
    const old = document.querySelector('.be-colorpop');
    if (old) { old.remove(); return; }
    const pop = el('div', { class: 'be-colorpop' });
    for (const c of CALLOUT_COLORS) {
      const b = el('button', { class: 'be-colordot md-callout-' + c, type: 'button', title: c });
      b.onclick = () => {
        const box = block.querySelector('.be-callout')!;
        box.className = 'be-callout md-callout-' + c;
        block.dataset.color = c;
        pop.remove();
        markDirty();
      };
      pop.append(b);
    }
    anchor.parentElement!.append(pop);
    const onDoc = (ev: any) => { if (!pop.contains(ev.target) && ev.target !== anchor) { pop.remove(); document.removeEventListener('mousedown', onDoc, true); } };
    setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
  }

  return { makeBlock, collAttrsOf, promptPageCard, openRawEditor };
}

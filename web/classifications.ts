// classifications.ts — #1102 분류 검토 대기(#/knowledge/classifications).
//  분류기(knowledge_propose_category)가 미분류 지식에 건 제안(mapped_by='llm', state='proposed')을
//  사람이 한 화면에서 확정·재분류·반려한다. '미분류 인박스'(knowledge_unmapped)의 다음 단계다.
//
//  설계는 검토 큐(review.ts)와 쌍둥이 — 같은 인지비용 최소화 원칙, 같은 손놀림(j/k·Enter·a/r·x):
//   · 신뢰도 낮은순으로 이미 정렬돼 온다(가장 의심스러운 것 먼저) — 위에서부터 훑어 내려가면 된다.
//   · 근거(evidence)는 접혀 있다 — 제자리에서 펼쳐 본다(페이지 이동 0).
//   · 확정은 한 번에(일괄) — 재분류/반려는 대상이 필요하거나 파괴적이라 건별로만.
//  쓰기는 검토 큐와 달리 전용 엔드포인트가 없다 — 기존 지식↔카테고리 연결(POST …/category)을 재사용한다:
//   확정   = { category_id: 제안값,  state: 'confirmed' }
//   재분류 = { category_id: 다른값,  state: 'confirmed' }
//   반려   = { category_id: 제안값,  unlink: true }        (연결을 지워 미분류 인박스로 되돌림)
import { api, busy, cardHead, el, errorNote, relTime, toast } from './core.js';
import { skeleton } from './learn.js';
import { KN_TYPE_LABEL, SPACE_LABEL } from './wiki-data.js';
import { rqEnsureStyles } from './review.js';   // .rq-*(행·칩·일괄바·빈상태) 재사용 — 검토 큐와 한 몸으로 보이게

type ClsItem = {
  key: string; name: string; title: string; type: string | null;
  categoryId: number; catKey: string; catName: string; space: string;
  confidence: number | null; evidence: string | null; at: string;
};

// 모듈 전역 UI 상태(review.ts rqUi 동형) — 탭을 떠났다 와도 필터·펼침·선택이 보존된다.
const clsUi: { space: string; cat: string; lowOnly: boolean; sel: Set<string>; open: Set<string>; cur: number } = {
  space: '', cat: '', lowOnly: false, sel: new Set(), open: new Set(), cur: 0,
};
let clsKeys: AbortController | null = null;

// 분류 검토 전용 CSS 1회 주입 — 공통 골격은 rqEnsureStyles(.rq-*), 여기선 신뢰도 pill·근거·제안 카테고리 칩만.
//  톤은 검토 큐의 배지 토큰을 그대로 재사용(hi=신규/민트 · lo=수정/노트앰버) — 두 표면이 같은 색 규칙을 쓰게.
function clsEnsureStyles(): void {
  if (document.getElementById('cls-styles')) return;
  document.head.appendChild(el('style', {
    id: 'cls-styles',
    text: `
.cls-count{margin:2px 0 12px;font-size:12.5px;color:var(--ink-sub)}
.cls-count b{color:var(--ink);font-weight:800;font-variant-numeric:tabular-nums}
.cls-count span+span{color:var(--muted)}
.cls-conf{flex:none;font-size:11px;font-weight:800;padding:2px 8px;border-radius:6px;border:1px solid var(--line);
  font-variant-numeric:tabular-nums;min-width:42px;text-align:center}
.cls-conf.hi{background:var(--bg-success);border-color:var(--mint-soft,#7FE0C4);color:var(--mint-deep)}
.cls-conf.mid{background:var(--bg-tint);border-color:var(--line);color:var(--ink-sub)}
.cls-conf.lo{background:var(--bg-note);border-color:var(--line-note);color:var(--ink-note)}
.cls-conf.na{background:var(--bg-tint);border-color:var(--line);color:var(--muted-2)}
.cls-cat{flex:none;display:inline-flex;align-items:center;gap:5px;max-width:240px;padding:2px 9px;
  border:1px solid var(--line);border-radius:999px;background:var(--bg-tint);color:var(--ink-sub);
  font-size:11.5px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.cls-cat .sp{color:var(--muted-2);font-weight:700}
.cls-ev{padding:0 12px 9px 40px;font-size:12px;color:var(--muted-head);cursor:pointer;
  overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.cls-ev:hover{color:var(--ink-sub)}
.cls-ev .lbl{color:var(--muted-2);font-weight:700;margin-right:6px}
.cls-ev-full{margin:0;font-size:12.5px;line-height:1.6;color:var(--ink-sub);white-space:pre-wrap;word-break:break-word}
.cls-ev-none{color:var(--muted-2);font-style:italic}
`,
  }));
}

// ── 셸 — '검토 큐'(renderReviewQueue)와 같은 wk-plainpad + 위키로 돌아가는 링크(사이드바 없는 보조 표면). ──
//  라우터는 #/knowledge/* 를 모두 knowledge 탭으로 두므로(main.ts setActiveTab) 새 nav 탭은 없다.
export async function renderClassificationReview(view: HTMLElement): Promise<void> {
  const host = el('div', {});
  const back = el('div', { class: 'wk-src-filters', style: 'justify-content:flex-end' },
    el('a', { class: 'wk-sec-act', href: '#/knowledge', text: '← 위키' }));
  view.replaceChildren(el('div', { class: 'wk-plainpad' }, back, host));
  await classificationPanel(host);
}

async function classificationPanel(detail: HTMLElement): Promise<void> {
  clsEnsureStyles(); rqEnsureStyles();
  busy(detail, el('div', { class: 'card' }, skeleton('제안된 분류를 불러오는 중')));

  let entries: any[] = [];
  try {
    const r = await api('/api/ui/knowledge/classifications?' + new URLSearchParams({ limit: '200' }));
    entries = (r && r.entries) || [];
  } catch (e) {
    detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '제안된 분류를 불러오지 못했습니다'))); return;
  }

  // 서버가 신뢰도 낮은순(NULL 최우선)으로 정렬해 준다 — 그 순서를 그대로 평면 목록으로 쓴다(가장 검토 필요한 것 먼저).
  const items: ClsItem[] = entries.map((e: any): ClsItem => ({
    key: e.name + ':' + e.category_id, name: e.name, title: e.title || e.name, type: e.type || null,
    categoryId: Number(e.category_id), catKey: e.category_key || '',
    catName: e.category_name || e.category_key || '미분류', space: e.space || '',
    confidence: e.confidence == null ? null : Number(e.confidence),
    evidence: e.evidence || null, at: e.updated_at,
  }));

  const listBox = el('div', {});
  const bulkBox = el('div', {});
  const countEl = el('div', { class: 'cls-count' });
  const chips = el('span', { style: 'display:flex;gap:6px' });   // paint 가 채운다(on 상태 반영)

  // 필터 적용 후 실제 보이는 것들(키보드 커서·일괄 확정의 대상).
  const visible = (): ClsItem[] => items.filter((i) =>
    (!clsUi.space || i.space === clsUi.space)
    && (!clsUi.cat || i.catKey === clsUi.cat)
    && (!clsUi.lowOnly || i.confidence == null || i.confidence < 0.5));

  // 낮은 신뢰도(<50% 또는 미측정) — 칩·통계에서 공유하는 판정.
  const isLow = (i: ClsItem): boolean => i.confidence == null || i.confidence < 0.5;

  const chipEls = () => [el('button', {
    class: 'rq-chip' + (clsUi.lowOnly ? ' on' : ''), text: '낮은 신뢰도만',
    title: '신뢰도 50% 미만(또는 미측정)만 봅니다 — 가장 검토가 필요한 것.',
    onclick: () => { clsUi.lowOnly = !clsUi.lowOnly; clsUi.cur = 0; paint(); },
  })];

  // 카테고리 필터 옵션 — 현재 space 안에 실제로 남아 있는 카테고리만(space 바꾸면 좁아지고, 다 처리하면 사라진다).
  const catSel = el('select', { class: 'rq-sel', style: 'width:auto;min-width:170px' }) as HTMLSelectElement;
  function rebuildCatSel(): void {
    const seen = new Map<string, string>();   // key → 표시명(space · 이름)
    for (const it of items) {
      if (clsUi.space && it.space !== clsUi.space) continue;
      if (it.catKey && !seen.has(it.catKey)) seen.set(it.catKey, (SPACE_LABEL[it.space] || it.space || '') + ' · ' + it.catName);
    }
    if (clsUi.cat && !seen.has(clsUi.cat)) clsUi.cat = '';   // 필터로 사라진 카테고리 선택은 해제
    catSel.replaceChildren(el('option', { value: '', text: '모든 카테고리' }),
      ...[...seen].map(([k, label]) => el('option', { value: k, text: label })));
    catSel.value = clsUi.cat;
  }
  catSel.onchange = () => { clsUi.cat = catSel.value; clsUi.cur = 0; paint(); };

  const spaceSel = el('select', { class: 'rq-sel', style: 'width:auto;min-width:120px' }) as HTMLSelectElement;
  for (const [v, t] of [['', '모든 영역'], ['business', SPACE_LABEL.business], ['product', SPACE_LABEL.product], ['system', SPACE_LABEL.system]] as [string, string][]) {
    spaceSel.append(el('option', { value: v, text: t }));
  }
  spaceSel.value = clsUi.space;
  spaceSel.onchange = () => { clsUi.space = spaceSel.value; clsUi.cat = ''; clsUi.cur = 0; paint(); };

  // 처리된 항목을 목록에서 즉시 제거(전체 리로드 없이 — 스크롤·펼침 상태 보존). review.ts drop 동형.
  const drop = (key: string): void => {
    const i = items.findIndex((x) => x.key === key);
    if (i >= 0) items.splice(i, 1);
    clsUi.sel.delete(key); clsUi.open.delete(key);
    paint();
  };

  const paint = (): void => {
    const vis = visible();
    if (clsUi.cur >= vis.length) clsUi.cur = Math.max(0, vis.length - 1);
    listBox.replaceChildren(renderList(vis, paint, drop));
    bulkBox.replaceChildren(...(clsUi.sel.size ? [bulkBar(items, paint, drop)] : []));
    chips.replaceChildren(...chipEls());
    rebuildCatSel();
    const low = items.filter(isLow).length;
    countEl.replaceChildren(
      el('span', {}, '총 ', el('b', { text: String(items.length) }), '건 대기'),
      low ? el('span', { text: ` · 신뢰도 낮음(<50%) ${low}건` }) : null,
      el('span', { text: ' · 신뢰도 낮은순' }));
  };

  const card = el('div', { class: 'card' },
    cardHead('분류 검토 대기', '분류기가 제안한 카테고리를 확정·재분류·반려합니다. 신뢰도 낮은순(가장 의심스러운 것 먼저)으로 정렬돼 있습니다.'),
    countEl,
    el('div', { class: 'rq-bar' }, chips, spaceSel, catSel,
      el('span', { class: 'rq-kbd' },
        el('b', { text: 'j/k' }), el('span', { text: ' 이동 · ' }),
        el('b', { text: 'Enter' }), el('span', { text: ' 근거 · ' }),
        el('b', { text: 'a' }), el('span', { text: ' 확정 · ' }),
        el('b', { text: 'r' }), el('span', { text: ' 반려 · ' }),
        el('b', { text: 'x' }), el('span', { text: ' 선택' }))),
    listBox,
    bulkBox);
  detail.replaceChildren(card);
  paint();
  installKeys(listBox, visible, paint, drop);
}

// 평면 목록 — 서버가 신뢰도 낮은순으로 준 순서 그대로(그룹핑하면 그 순서가 깨진다).
function renderList(vis: ClsItem[], paint: () => void, drop: (k: string) => void): any {
  const rows = el('div', { class: 'rq-rows' });
  if (!vis.length) {
    rows.append(el('div', { class: 'rq-empty', text: '검토할 제안 분류가 없습니다 — 분류기가 제안한 것이 모두 처리됐습니다.' }));
    return rows;
  }
  vis.forEach((it, idx) => rows.append(renderRow(it, idx, paint, drop)));
  return rows;
}

function renderRow(it: ClsItem, idx: number, paint: () => void, drop: (k: string) => void) {
  const isOpen = clsUi.open.has(it.key);
  const chk = el('input', {
    type: 'checkbox', class: 'rq-chk', ...(clsUi.sel.has(it.key) ? { checked: true } : {}),
    title: '선택(일괄 확정)',
    onclick: (e: any) => {
      e.stopPropagation();
      if (clsUi.sel.has(it.key)) clsUi.sel.delete(it.key); else clsUi.sel.add(it.key);
      paint();
    },
  });

  // 신뢰도 — 검토자가 가장 먼저 보는 신호. <50% 노트앰버(주의) · ≥80% 민트(무난) · 그 사이 중립 · 미측정 '—'.
  const pct = it.confidence == null ? null : Math.round(it.confidence * 100);
  const level = it.confidence == null ? 'na' : it.confidence < 0.5 ? 'lo' : it.confidence >= 0.8 ? 'hi' : 'mid';
  const conf = el('span', {
    class: 'cls-conf ' + level, text: pct == null ? '—' : pct + '%',
    title: pct == null ? '분류기 신뢰도 미측정' : '분류기 신뢰도 ' + pct + '%',
  });

  // 제목 = 문서 상세 링크(행 펼침과 겹치지 않게 클릭 전파 차단).
  //  경로는 #/k/<name> — 코드베이스 전역의 '지식 문서 열기' 정주소(wiki-data·wiki-doc·dashboard 등 전부 이걸 쓴다).
  //  (review.ts 만 #/knowledge/<name> 을 쓰는데, 그건 renderWiki 가 모르는 sub 라 위키 홈으로 떨어진다 — 문서로 안 감.)
  const titleLink = el('a', {
    class: 'rq-title', href: '#/k/' + encodeURIComponent(it.name), text: it.title,
    title: '문서 열기', onclick: (e: any) => e.stopPropagation(),
  });

  const cat = el('span', { class: 'cls-cat', title: (SPACE_LABEL[it.space] || it.space || '') + ' · ' + (it.catKey || '') },
    el('span', { class: 'sp', text: SPACE_LABEL[it.space] || it.space || '—' }),
    el('span', { text: it.catName }));

  const meta = el('span', { class: 'rq-meta' },
    cat,
    it.type ? el('span', { text: KN_TYPE_LABEL[it.type] || it.type }) : null,
    el('span', { text: relTime(it.at) }));

  const acts = el('span', { class: 'rq-acts' },
    el('button', { class: 'btn btn-ghost btn-sm', text: '✓ 확정', title: '제안된 카테고리로 확정',
      onclick: (e: any) => { e.stopPropagation(); void confirmOne(it, drop); } }),
    el('button', { class: 'btn btn-ghost btn-sm', text: '↻ 재분류', title: '다른 카테고리로 바꿔 확정',
      onclick: (e: any) => { e.stopPropagation(); openReclassifyPicker(e.currentTarget, it, drop); } }),
    el('button', { class: 'btn btn-ghost btn-sm', text: '✕ 반려', title: '분류를 취소하고 미분류 인박스로 되돌림',
      onclick: (e: any) => { e.stopPropagation(); void rejectOne(it, drop); } }));

  const main = el('div', {
    class: 'rq-row-main',
    onclick: () => { if (clsUi.open.has(it.key)) clsUi.open.delete(it.key); else clsUi.open.add(it.key); clsUi.cur = idx; paint(); },
  }, chk, conf, titleLink, meta, acts);

  const row = el('div', { class: 'rq-row' + (clsUi.cur === idx ? ' cur' : ''), 'data-key': it.key }, main);
  // 근거 — 닫히면 한 줄 미리보기, 펼치면 전문(제자리, 페이지 이동 0). 근거가 없으면 펼침에서만 안내한다.
  if (isOpen) {
    row.append(el('div', { class: 'rq-exp' },
      it.evidence
        ? el('p', { class: 'cls-ev-full', text: it.evidence })
        : el('p', { class: 'cls-ev-full cls-ev-none', text: '분류기가 근거를 남기지 않았습니다.' })));
  } else if (it.evidence) {
    row.append(el('div', {
      class: 'cls-ev', title: '펼쳐서 전체 근거 보기',
      onclick: () => { clsUi.open.add(it.key); clsUi.cur = idx; paint(); },
    }, el('span', { class: 'lbl', text: '근거' }), el('span', { text: it.evidence })));
  }
  return row;
}

// ── 재분류 피커 — openKnMetaPicker(wiki-data) 패턴 복제. 단 저장 대상이 카테고리 id 라 로컬로 둔다(그 함수는 key 기반). ──
//  space(사업/제품/시스템)별로 묶어 보여주고, 현재 제안 카테고리엔 표식을 단다. 고르면 즉시 재분류(=다른 카테고리로 확정) 쓰기.
function openReclassifyPicker(anchor: HTMLElement, it: ClsItem, drop: (k: string) => void): void {
  const old = document.querySelector('.kn-metapop');
  if (old) { old.remove(); return; }   // 열려 있으면 토글로 닫기(openKnMetaPicker 관례)
  const pop = el('div', { class: 'kn-metapop', role: 'menu' });
  const close = () => { pop.remove(); document.removeEventListener('mousedown', onDoc, true); };
  pop.append(el('div', { class: 'kn-metapop-note', text: '불러오는 중…' }));
  api('/api/ui/categories').then((d: any) => {
    const cats = (d && d.categories) || [];
    const parts: any[] = [];
    for (const sp of ['business', 'product', 'system']) {
      const inSp = cats.filter((c: any) => c.space === sp);
      if (!inSp.length) continue;
      parts.push(el('div', { class: 'kn-metapop-head', text: SPACE_LABEL[sp] }));
      for (const c of inSp) {
        const on = Number(c.id) === it.categoryId;   // 현재 제안 = 이미 걸린 카테고리
        const b = el('button', { class: 'kn-metapop-item' + (on ? ' on' : ''), type: 'button' },
          el('span', { text: c.name || c.key }),
          on ? el('span', { class: 'kn-metapop-check', 'aria-hidden': 'true', text: '✓ 현재 제안' }) : null);
        b.onclick = () => { close(); void reclassifyOne(it, Number(c.id), drop); };
        parts.push(b);
      }
    }
    pop.replaceChildren(...(parts.length ? parts : [el('div', { class: 'kn-metapop-note', text: '카테고리가 없습니다' })]));
  }).catch(() => pop.replaceChildren(el('div', { class: 'kn-metapop-note', text: '목록을 불러오지 못했습니다' })));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 260)) + 'px';
  pop.style.top = (r.bottom + 4) + 'px';
  const onDoc = (ev: any) => { if (!pop.contains(ev.target)) close(); };
  setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
}

// ── 쓰기 액션 — 전부 기존 지식↔카테고리 연결(POST …/category)의 재사용(전용 벌크 엔드포인트 없음). ──
async function confirmOne(it: ClsItem, drop: (k: string) => void): Promise<void> {
  try {
    await api('/api/ui/knowledge/' + encodeURIComponent(it.name) + '/category',
      { method: 'POST', body: JSON.stringify({ category_id: it.categoryId, state: 'confirmed' }) });
    toast('확정 — 분류를 확정했습니다');
    drop(it.key);
  } catch (e: any) { toast('실패 — ' + e.message, true); }
}

async function reclassifyOne(it: ClsItem, categoryId: number, drop: (k: string) => void): Promise<void> {
  try {
    await api('/api/ui/knowledge/' + encodeURIComponent(it.name) + '/category',
      { method: 'POST', body: JSON.stringify({ category_id: categoryId, state: 'confirmed' }) });
    toast(categoryId === it.categoryId ? '확정했습니다' : '재분류 — 다른 카테고리로 확정했습니다');
    drop(it.key);
  } catch (e: any) { toast('실패 — ' + e.message, true); }
}

async function rejectOne(it: ClsItem, drop: (k: string) => void): Promise<void> {
  if (!confirm('이 제안을 반려할까요? 카테고리 연결을 지우고 미분류 인박스로 되돌립니다(지식 본문은 그대로).')) return;
  try {
    await api('/api/ui/knowledge/' + encodeURIComponent(it.name) + '/category',
      { method: 'POST', body: JSON.stringify({ category_id: it.categoryId, unlink: true }) });
    toast('반려 — 미분류로 되돌렸습니다');
    drop(it.key);
  } catch (e: any) { toast('실패 — ' + e.message, true); }
}

// ── 일괄 확정(확정 전용) — review.ts bulkBar 동형. 재분류·반려는 대상/파괴적이라 건별로만 둔다. ──
function bulkBar(items: ClsItem[], paint: () => void, drop: (k: string) => void) {
  const n = clsUi.sel.size;
  const go = el('button', { class: 'btn btn-primary btn-sm', text: `선택 ${n}건 확정` }) as HTMLButtonElement;
  go.onclick = async () => {
    if (!confirm(`${n}건을 제안된 카테고리로 확정할까요?`)) return;
    go.disabled = true;
    const keys = [...clsUi.sel];
    let ok = 0, fail = 0;
    for (const key of keys) {
      const it = items.find((x) => x.key === key);
      if (!it) continue;
      try {
        await api('/api/ui/knowledge/' + encodeURIComponent(it.name) + '/category',
          { method: 'POST', body: JSON.stringify({ category_id: it.categoryId, state: 'confirmed' }) });
        ok++; drop(key);
      } catch { fail++; }
    }
    toast(fail ? `${ok}건 확정 · ${fail}건 실패` : `${ok}건을 확정했습니다`, !!fail);
    paint();
  };
  return el('div', { class: 'rq-bulk' },
    el('b', { text: `${n}건 선택됨` }),
    go,
    el('span', { style: 'font-size:11.5px;color:var(--muted)', text: '재분류·반려는 건별로' }),
    el('button', { class: 'btn btn-ghost btn-sm', text: '선택 해제', onclick: () => { clsUi.sel.clear(); paint(); } }));
}

// ── 키보드 — 손이 마우스로 안 떠나게(review.ts installKeys 동형). 입력창 안에서는 절대 가로채지 않는다. ──
function installKeys(listBox: any, visible: () => ClsItem[], paint: () => void, drop: (k: string) => void): void {
  if (clsKeys) clsKeys.abort();
  clsKeys = new AbortController();
  const inEditable = (t: any): boolean => {
    const e = (t && t.nodeType === 1 ? t : document.activeElement) as HTMLElement | null;
    return !!(e && e.closest && e.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], .be, .xterm'));
  };
  document.addEventListener('keydown', (e: any) => {
    if (!document.body.contains(listBox)) { clsKeys?.abort(); clsKeys = null; return; }   // 다른 탭으로 이동 → 자가 해제
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (inEditable(e.target)) return;
    const vis = visible();
    if (!vis.length) return;
    const cur = () => vis[Math.min(clsUi.cur, vis.length - 1)];
    const move = (d: number) => {
      clsUi.cur = Math.max(0, Math.min(vis.length - 1, clsUi.cur + d));
      paint();
      const node = listBox.querySelector('.rq-row.cur');
      if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const it = cur(); if (!it) return;
      if (clsUi.open.has(it.key)) clsUi.open.delete(it.key); else clsUi.open.add(it.key);
      paint(); return;
    }
    if (e.key === 'x') { e.preventDefault(); const it = cur(); if (!it) return; if (clsUi.sel.has(it.key)) clsUi.sel.delete(it.key); else clsUi.sel.add(it.key); paint(); return; }
    if (e.key === 'a') { e.preventDefault(); const it = cur(); if (it) void confirmOne(it, drop); return; }
    if (e.key === 'r') { e.preventDefault(); const it = cur(); if (it) void rejectOne(it, drop); return; }
    if (e.key === 'Escape' && clsUi.sel.size) { e.preventDefault(); clsUi.sel.clear(); paint(); }
  }, { signal: clsKeys.signal });
}

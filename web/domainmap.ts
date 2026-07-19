// domainmap.ts — 도메인 맵 재설계 (#185). 의존 흐름 그래프(pan/zoom·노드 드래그) + 드릴다운 드로어 + should 엣지 CRUD.
//  레이어(의도 should / 실제 is / 대조) × 관점(PO / 개발자) + 횡단 토글.
//  조작: 배경 드래그=이동, 휠=확대축소, 노드 드래그=위치 이동('위치 저장'=조직 공유), 노드 클릭=상세 드로어.
//  should 엣지·relation 은 드로어에서 CRUD(category-edges API). 도메인(노드) CRUD 는 관리탭('카테고리 설정')으로 링크 — 중복 X.
//  데이터: GET /api/ui/domainmap/map → { domains(layout_x/y 포함), edges:{should(id 포함),is}, ... }.
import { api, el, errorNote, fmtNum, loadRepos, pageHead, state } from './core.js';
import { skeleton } from './learn.js';

const SVGNS = 'http://www.w3.org/2000/svg';
function sv(tag: string, attrs: Record<string, any>, ...kids: any[]): any {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) { if (attrs[k] == null) continue; if (k === 'text') e.textContent = String(attrs[k]); else e.setAttribute(k, String(attrs[k])); }
  for (const c of kids) if (c) e.appendChild(c);
  return e;
}
const clamp = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v;
const NODE_W = 178, NODE_H = 60, COL_GAP = 224, ROW_GAP = 116, PAD = 42, BAND_GAP = 88;
const K_MIN = 0.25, K_MAX = 3;

// ── 배치: 저장 좌표(layout_x/y) 전부 있으면 그대로, 아니면 방향성 자동 레이어(DFS back-edge 제거 후 longest-path) ──
function layout(domains: any[], edges: any[]) {
  const pos = new Map<number, { x: number; y: number }>();
  if (domains.length && domains.every((d) => d.layout_x != null && d.layout_y != null)) {
    domains.forEach((d) => pos.set(d.id, { x: d.layout_x, y: d.layout_y }));
    return { pos };
  }
  const core = domains.filter((d) => !d.cross_cutting);
  const cross = domains.filter((d) => d.cross_cutting);
  const coreIds = new Set(core.map((d) => d.id));
  const E = edges.filter((e) => coreIds.has(e.from) && coreIds.has(e.to) && e.from !== e.to);
  const adj = new Map<number, number[]>(); core.forEach((d) => adj.set(d.id, []));
  for (const e of E) adj.get(e.from)!.push(e.to);
  const st = new Map<number, number>(); const back = new Set<string>();
  const visit = (root: number) => {
    const path: Array<{ n: number; i: number }> = [{ n: root, i: 0 }]; st.set(root, 1);
    while (path.length) {
      const top = path[path.length - 1]; const kids = adj.get(top.n)!;
      if (top.i < kids.length) { const v = kids[top.i++]; const s = st.get(v) || 0; if (s === 1) back.add(top.n + '>' + v); else if (s === 0) { st.set(v, 1); path.push({ n: v, i: 0 }); } }
      else { st.set(top.n, 2); path.pop(); }
    }
  };
  for (const d of core) if (!st.get(d.id)) visit(d.id);
  const DAG = E.filter((e) => !back.has(e.from + '>' + e.to));
  const layer = new Map<number, number>(); core.forEach((d) => layer.set(d.id, 0));
  for (let i = 0; i < core.length; i++) {
    let changed = false;
    for (const e of DAG) { const nl = layer.get(e.from)! + 1; if (nl > layer.get(e.to)!) { layer.set(e.to, nl); changed = true; } }
    if (!changed) break;
  }
  const cols = new Map<number, any[]>();
  for (const d of core) { const L = layer.get(d.id) || 0; if (!cols.has(L)) cols.set(L, []); cols.get(L)!.push(d); }
  let maxRows = 0; cols.forEach((arr) => { maxRows = Math.max(maxRows, arr.length); });
  const coreH = Math.max(1, maxRows) * ROW_GAP;
  cols.forEach((arr, L) => { const y0 = PAD + (coreH - arr.length * ROW_GAP) / 2; arr.forEach((d, i) => pos.set(d.id, { x: PAD + L * COL_GAP + NODE_W / 2, y: y0 + i * ROW_GAP + NODE_H / 2 })); });
  const bandY = PAD + coreH + BAND_GAP;
  cross.forEach((d, i) => pos.set(d.id, { x: PAD + i * (NODE_W + 30) + NODE_W / 2, y: bandY + NODE_H / 2 }));
  return { pos };
}

function clipEnds(a: any, b: any) {
  const hw = NODE_W / 2, hh = NODE_H / 2;
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  const cl = (c: any, sx: number, sy: number) => { const tx = sx !== 0 ? hw / Math.abs(sx) : 1e9, ty = sy !== 0 ? hh / Math.abs(sy) : 1e9; const t = Math.min(tx, ty); return { x: c.x + sx * t, y: c.y + sy * t }; };
  const s = cl(a, ux, uy), e = cl(b, -ux, -uy);
  const gap = 8; // 화살표가 노드에 파묻히지 않게 to 끝을 살짝 앞에서 끊음(방향 강조)
  const ex = e.x - ux * gap, ey = e.y - uy * gap;
  return { x1: s.x, y1: s.y, x2: ex, y2: ey, mx: (s.x + ex) / 2, my: (s.y + ey) / 2 };
}

async function renderDomainmap(view: any, params: any) {
  view.replaceChildren(skeleton('도메인 맵을 불러오는 중'));
  const repos = await loadRepos();
  let repo = (params && params.get('repo')) || state.dmRepo || repos[0];
  if (repos.length && !repos.includes(repo)) repo = repos[0];
  state.dmRepo = repo;
  const mapUrl = '/api/ui/domainmap/map?' + new URLSearchParams({ repo: repo || 'product', limit: '200' });

  let data: any;
  try { data = await api(mapUrl); }
  catch (e) { view.replaceChildren(pageHead('도메인 맵', '도메인 간 의존과 should·is·debt.', [], '맵'), errorNote(e, '도메인 맵을 불러오지 못했습니다')); return; }

  const domains: any[] = data.domains || [];
  const byId = new Map<number, any>(domains.map((d) => [d.id, d]));
  let edges: any[] = [], hasIs = false;
  function normalize(d: any) {
    const sE: any[] = (d.edges && d.edges.should) || [];
    const iE: any[] = (d.edges && d.edges.is) || [];
    const relOf = new Map<string, string>(), wOf = new Map<string, number>(), idOf = new Map<string, number>();
    const sK = new Set(sE.map((e) => { const k = e.from_category_id + '>' + e.to_category_id; relOf.set(k, e.relation); idOf.set(k, e.id); return k; }));
    const iK = new Set(iE.map((e) => { const k = e.from_category_id + '>' + e.to_category_id; wOf.set(k, e.weight); return k; }));
    edges = [...new Set([...sK, ...iK])].map((k) => {
      const [f, t] = k.split('>').map(Number); const should = sK.has(k), is = iK.has(k);
      return { key: k, from: f, to: t, should, is, sev: should && is ? 'ok' : (should ? 'should_no_is' : 'is_no_should'), rel: relOf.get(k), weight: wOf.get(k), edgeId: idOf.get(k) };
    }).filter((e) => byId.has(e.from) && byId.has(e.to));
    hasIs = iE.length > 0;
  }
  normalize(data);
  const LO = layout(domains, edges);

  // 뷰 상태
  let layer: 'both' | 'should' | 'is' = 'both';
  let mode: 'po' | 'dev' = 'po';
  let showCross = false; let sel: number | null = null; let dirty = false;
  const detailCache: Record<number, any> = {};
  const vw = { k: 1, tx: 0, ty: 0 }; let fitted = false;
  let gViewport: any = null, stageInner: any = null;

  const head = pageHead('도메인 맵', '도메인이 어떤 순서로 의존을 흘려보내는지, 의도(should)와 실제 코드(is)의 어긋남을 봅니다. 배경 드래그=이동·휠=확대축소·노드 드래그=위치 이동.', [], '맵');

  function activeEdges() {
    return edges.filter((e) => {
      if (!showCross && (byId.get(e.from)?.cross_cutting || byId.get(e.to)?.cross_cutting)) return false;
      if (layer === 'should') return e.should;
      if (layer === 'is') return e.is;
      return true;
    });
  }
  function visibleNodes() { return domains.filter((d) => showCross || !d.cross_cutting); }
  function sevClass(e: any) { if (e.sev === 'ok') return 'ok'; if (e.sev === 'is_no_should') return 'viol'; return hasIs ? 'warn' : 'pending'; }
  function nodeGap(id: number) {
    let v: string | null = null;
    for (const e of activeEdges()) { if (e.from !== id && e.to !== id) continue; const s = sevClass(e); if (s === 'viol') v = 'viol'; else if (s === 'warn' && v !== 'viol') v = 'warn'; }
    return v;
  }

  function applyTransform() { if (gViewport) gViewport.setAttribute('transform', `translate(${vw.tx.toFixed(1)} ${vw.ty.toFixed(1)}) scale(${vw.k.toFixed(4)})`); }
  function zoomAt(sx: number, sy: number, f: number) { const k2 = clamp(vw.k * f, K_MIN, K_MAX); vw.tx = sx - (sx - vw.tx) * (k2 / vw.k); vw.ty = sy - (sy - vw.ty) * (k2 / vw.k); vw.k = k2; applyTransform(); }
  function nodeBounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const d of visibleNodes()) { const p = LO.pos.get(d.id); if (!p) continue; x0 = Math.min(x0, p.x - NODE_W / 2); y0 = Math.min(y0, p.y - NODE_H / 2); x1 = Math.max(x1, p.x + NODE_W / 2); y1 = Math.max(y1, p.y + NODE_H / 2); }
    if (x0 === Infinity) return { x0: 0, y0: 0, x1: 800, y1: 500 };
    return { x0, y0, x1, y1 };
  }
  function fitAll() {
    if (!stageInner) return;
    const W = stageInner.clientWidth || 900, H = stageInner.clientHeight || 560, m = 54;
    const b = nodeBounds(); const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
    const k = clamp(Math.min((W - m * 2) / Math.max(1, bw), (H - m * 2) / Math.max(1, bh)), K_MIN, 1.15);
    vw.k = k; vw.tx = W / 2 - (b.x0 + b.x1) / 2 * k; vw.ty = H / 2 - (b.y0 + b.y1) / 2 * k; applyTransform();
  }

  function draw() { view.replaceChildren(head, buildControls(), buildCanvas()); }

  async function reload() { try { data = await api(mapUrl); normalize(data); } catch (_) { /* keep */ } draw(); }

  // ── 컨트롤 ──
  function seg(label: string, opts: Array<[string, string]>, cur: string, on: (v: any) => void) {
    const box = el('div', { class: 'dmx-seg', role: 'group', 'aria-label': label });
    for (const [v, t] of opts) { const b = el('button', { type: 'button', 'aria-pressed': String(cur === v), text: t }); b.addEventListener('click', () => on(v)); box.append(b); }
    return box;
  }
  function buildControls() {
    const bar = el('div', { class: 'dmx-controls' },
      seg('레이어', [['both', '대조'], ['should', '의도 · should'], ['is', '실제 · is']], layer, (v) => { layer = v; draw(); }),
      seg('관점', [['po', 'PO 관점'], ['dev', '개발자 관점']], mode, (v) => { mode = v; draw(); }));
    const crossWrap = el('label', { class: 'dmx-toggle' });
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement; cb.checked = showCross;
    cb.addEventListener('change', () => { showCross = cb.checked; draw(); });
    crossWrap.append(cb, el('span', { class: 'dmx-switch', 'aria-hidden': 'true' }), document.createTextNode('횡단 도메인'));
    bar.append(crossWrap);
    if (dirty) { const sb = el('button', { class: 'dmx-save-btn', type: 'button', text: '⤓ 위치 저장' }); sb.addEventListener('click', saveLayout); bar.append(sb); }
    const legend = el('div', { class: 'dmx-legend' });
    if (layer !== 'should') legend.append(lg('ok', '일치'));
    if (layer !== 'is') legend.append(lg(hasIs ? 'warn' : 'pending', hasIs ? '선언만 (should)' : 'is 측정 전'));
    if (layer !== 'should' && hasIs) legend.append(lg('viol', '코드만 (is)'));
    bar.append(legend);
    bar.append(el('a', { class: 'dmx-mng-btn', href: '#/system/wiki-categories', title: '도메인(카테고리) 추가·이름·범위는 관리탭에서', text: '도메인 관리 ↗' }));
    return bar;
  }
  function lg(cls: string, txt: string) { return el('span', { class: 'dmx-lg dmx-lg-' + cls }, el('i', {}), document.createTextNode(txt)); }

  // ── 캔버스(뷰포트 pan/zoom·노드드래그 + 드로어) ──
  function buildCanvas() {
    const canvas = el('div', { class: 'dmx-canvas' });
    canvas.append(el('div', { class: 'dmx-canvas-head' },
      el('span', { class: 'dmx-ch-t', text: layer === 'should' ? '의도한 의존 (should)' : layer === 'is' ? '실제 코드 의존 (is)' : '의도 · 실제 대조' }),
      el('span', { class: 'dmx-ch-s', text: fmtNum(visibleNodes().length) + ' 도메인 · ' + fmtNum(activeEdges().length) + ' 의존' })));
    if (!hasIs && layer !== 'should') canvas.append(el('div', { class: 'dmx-note' }, el('strong', { text: '실제(is) 의존은 아직 측정 전입니다.' }), document.createTextNode(' 코드 스캔(refresh)이 import 를 수집하면 실선(실제 의존)과 괴리 판정이 표시됩니다.')));
    stageInner = el('div', { class: 'dmx-stage-inner' });
    const svg = sv('svg', { class: 'dmx-graph', role: 'img', 'aria-label': '도메인 의존 흐름 그래프' });
    gViewport = sv('g', { class: 'dmx-viewport' });
    buildGraphInto(gViewport); svg.appendChild(gViewport); stageInner.append(svg);
    const zc = el('div', { class: 'dmx-zoom-ctrl' });
    zc.append(zbtn('+', '확대', () => zoomAt(stageInner.clientWidth / 2, stageInner.clientHeight / 2, 1.3)),
      zbtn('−', '축소', () => zoomAt(stageInner.clientWidth / 2, stageInner.clientHeight / 2, 1 / 1.3)),
      zbtn('맞춤', '전체 맞춤', () => fitAll()));
    stageInner.append(zc); stageInner.append(buildPanel()); canvas.append(stageInner);
    wire(stageInner);
    requestAnimationFrame(() => { if (!fitted) { fitAll(); fitted = true; } else applyTransform(); });
    return canvas;
  }
  function zbtn(t: string, title: string, on: () => void) { const b = el('button', { class: 'dmx-zbtn', type: 'button', title, text: t }); b.addEventListener('click', on); return b; }
  function redrawGraph() { if (!gViewport) return; while (gViewport.firstChild) gViewport.removeChild(gViewport.firstChild); buildGraphInto(gViewport); }

  function buildGraphInto(g: any) {
    const defs = sv('defs', {});
    for (const [id, col] of [['ok', 'var(--dmx-ok)'], ['warn', 'var(--dmx-warn)'], ['viol', 'var(--dmx-viol)'], ['pending', 'var(--dmx-pending)']] as any)
      defs.appendChild(sv('marker', { id: 'dmx-ah-' + id, markerWidth: 14, markerHeight: 12, refX: 11.5, refY: 5.5, orient: 'auto', markerUnits: 'userSpaceOnUse' }, sv('path', { d: 'M0,0.5 L12,5.5 L0,10.5 L3,5.5 Z', fill: col })));
    g.appendChild(defs);
    const gEdge = sv('g', {}), gNode = sv('g', {}), gLabel = sv('g', {});
    const act = activeEdges();
    const neighbor = (id: number) => sel != null && act.some((e) => (e.from === sel && e.to === id) || (e.to === sel && e.from === id));
    for (const e of act) {
      const a = LO.pos.get(e.from)!, b = LO.pos.get(e.to)!; if (!a || !b) continue;
      const p = clipEnds(a, b); const s = sevClass(e);
      const hot = sel != null && (e.from === sel || e.to === sel); const dim = sel != null && !hot;
      gEdge.appendChild(sv('line', { class: 'dmx-edge dmx-e-' + s + (hot ? ' hot' : '') + (dim ? ' dim' : ''), x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, 'marker-end': `url(#dmx-ah-${s})` }));
      if (hot) {
        const lbl = mode === 'dev' && e.is ? ('×' + fmtNum(e.weight || 0)) : (e.rel || '');
        if (lbl) {
          const w = lbl.length * 10.5 + 16; const gg = sv('g', {});
          gg.appendChild(sv('rect', { x: p.mx - w / 2, y: p.my - 11, width: w, height: 21, rx: 6, fill: 'var(--dmx-surface)', stroke: 'var(--dmx-line2)', 'stroke-width': 1 }));
          gg.appendChild(sv('text', { class: 'dmx-elabel', x: p.mx, y: p.my + 4, 'text-anchor': 'middle', text: lbl }));
          gLabel.appendChild(gg);
        }
      }
    }
    for (const d of visibleNodes()) {
      const p = LO.pos.get(d.id)!; if (!p) continue;
      const dim = sel != null && sel !== d.id && !neighbor(d.id);
      const nd = sv('g', { class: 'dmx-node' + (d.cross_cutting ? ' cross' : '') + (sel === d.id ? ' active' : '') + (dim ? ' dim' : ''), tabindex: 0, role: 'button', 'data-id': d.id, 'aria-label': d.name || d.key });
      nd.appendChild(sv('rect', { class: 'dmx-box', x: p.x - NODE_W / 2, y: p.y - NODE_H / 2, width: NODE_W, height: NODE_H, rx: 11 }));
      nd.appendChild(sv('rect', { class: 'dmx-stripe', x: p.x - NODE_W / 2, y: p.y - NODE_H / 2, width: 5, height: NODE_H, rx: 2 }));
      nd.appendChild(sv('text', { class: 'dmx-nm', x: p.x - NODE_W / 2 + 17, y: p.y - 5, text: d.name || d.key }));
      nd.appendChild(sv('text', { class: 'dmx-ky', x: p.x - NODE_W / 2 + 17, y: p.y + 15, text: d.key }));
      const gap = nodeGap(d.id);
      if (gap) nd.appendChild(sv('circle', { class: 'dmx-gapdot dmx-g-' + gap, cx: p.x + NODE_W / 2 - 13, cy: p.y - NODE_H / 2 + 13, r: 5 }));
      nd.addEventListener('keydown', (ev: any) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); select(d.id); } });
      gNode.appendChild(nd);
    }
    g.appendChild(gEdge); g.appendChild(gNode); g.appendChild(gLabel);
  }

  // ── 입력: 휠 줌 · 배경 팬 · 노드 드래그/클릭 ──
  function wire(stg: any) {
    stg.addEventListener('wheel', (e: WheelEvent) => { e.preventDefault(); const r = stg.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(1.0015, -e.deltaY)); }, { passive: false });
    let m: '' | 'pan' | 'node' = '', sx = 0, sy = 0, moved = 0, ptx = 0, pty = 0, downId: number | null = null, dragging = false;
    const findId = (t: any): number | null => { const g = t.closest && t.closest('.dmx-node'); return g ? Number(g.getAttribute('data-id')) : null; };
    stg.addEventListener('dragstart', (e: Event) => e.preventDefault());
    stg.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      if ((e.target as any).closest('.dmx-zoom-ctrl') || (e.target as any).closest('.dmx-panel')) return;
      e.preventDefault();
      const r = stg.getBoundingClientRect(); sx = e.clientX - r.left; sy = e.clientY - r.top; moved = 0; dragging = false;
      downId = findId(e.target);
      if (downId != null) m = 'node'; else { m = 'pan'; ptx = vw.tx; pty = vw.ty; }
      try { stg.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
      stg.classList.add('dragging');
    });
    stg.addEventListener('pointermove', (e: PointerEvent) => {
      if (!m) return; const r = stg.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
      moved += Math.abs(cx - sx) + Math.abs(cy - sy);
      if (m === 'pan') { vw.tx = ptx + (cx - sx); vw.ty = pty + (cy - sy); applyTransform(); }
      else if (m === 'node' && downId != null && moved > 5) { LO.pos.set(downId, { x: (cx - vw.tx) / vw.k, y: (cy - vw.ty) / vw.k }); dragging = true; dirty = true; redrawGraph(); }
    });
    const end = (e: PointerEvent) => {
      if (m === 'node' && downId != null) { if (dragging) draw(); else if (moved <= 5) select(downId); }
      m = ''; downId = null; dragging = false; stg.classList.remove('dragging');
      try { stg.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
    };
    stg.addEventListener('pointerup', end); stg.addEventListener('pointercancel', end);
  }

  // ── 위치 저장(조직 공유) ──
  async function saveLayout() {
    const positions = domains.map((d) => { const p = LO.pos.get(d.id); return p ? { id: d.id, x: Math.round(p.x), y: Math.round(p.y) } : null; }).filter(Boolean);
    try { await api('/api/ui/domainmap/layout', { method: 'POST', body: JSON.stringify({ positions }) }); dirty = false; draw(); }
    catch (e) { alert('위치 저장 실패: ' + ((e as Error).message || e)); }
  }

  // ── should 엣지 CRUD (relation 포함) ──
  async function upsertEdge(fromId: number, toId: number, relation: string) {
    await api('/api/ui/category-edges', { method: 'POST', body: JSON.stringify({ from_category_id: fromId, to_category_id: toId, relation: relation || undefined }) });
    await reload();
  }
  async function deleteEdge(edgeId: number) {
    if (edgeId == null) return;
    await api('/api/ui/category-edges/' + edgeId + '/delete', { method: 'POST' });
    await reload();
  }

  // ── 드릴다운 드로어 (상세 + should 의존 CRUD) ──
  function buildPanel() {
    const panel = el('div', { class: 'dmx-panel' + (sel != null ? ' open' : '') });
    if (sel == null) return panel;
    const d = byId.get(sel)!; const det = detailCache[sel];
    const outs = edges.filter((e) => e.from === sel); const ins = edges.filter((e) => e.to === sel);
    const outShould = edges.filter((e) => e.from === sel && e.should);
    const gaps = [...outs, ...ins].filter((e) => sevClass(e) !== 'ok');
    const close = el('button', { class: 'dmx-panel-close', type: 'button', 'aria-label': '닫기', text: '✕' });
    close.addEventListener('click', () => { sel = null; draw(); });
    panel.append(close, el('div', { class: 'dmx-ph' },
      el('div', { class: 'dmx-pk', text: d.key }), el('div', { class: 'dmx-pn', text: d.name || d.key }),
      el('div', { class: 'dmx-ptags' }, d.cross_cutting ? el('span', { class: 'dmx-tag cross', text: '횡단' }) : el('span', { class: 'dmx-tag sp', text: '제품 도메인' }), (gaps.length && hasIs) ? el('span', { class: 'dmx-tag debt', text: '괴리 ' + gaps.length }) : null)));

    const should = el('div', { class: 'dmx-axis should' }, el('h4', { text: '의도 · should' }));
    should.append(el('p', { text: (d.should && d.should.trim()) ? d.should : '아직 설정되지 않았습니다.' }));
    if (mode === 'po' && d.description && d.description !== d.should) should.append(el('div', { class: 'dmx-bd', text: d.description }));
    panel.append(should);

    // ── 나가는 의존(should) CRUD ──
    const dep = el('div', { class: 'dmx-axis deps' }, el('h4', {}, document.createTextNode('나가는 의존 · should'), el('span', { class: 'dmx-h4-hint', text: '의도한 결합' })));
    if (outShould.length) for (const e of outShould) {
      const row = el('div', { class: 'dmx-dep-row' },
        el('span', { class: 'dmx-dep-to', text: '→ ' + (byId.get(e.to)?.name || byId.get(e.to)?.key || e.to) }),
        el('button', { class: 'dmx-dep-rel', type: 'button', title: '관계 문구 편집', text: e.rel || '관계 미정' }),
        el('button', { class: 'dmx-dep-del', type: 'button', 'aria-label': '삭제', title: '의존 삭제', text: '✕' }));
      (row.children[1] as HTMLElement).addEventListener('click', () => {
        const nv = prompt('관계 문구 (예: 심사 호출)', e.rel || ''); if (nv == null) return;
        upsertEdge(e.from, e.to, nv.trim()).catch((err) => alert('저장 실패: ' + (err.message || err)));
      });
      (row.children[2] as HTMLElement).addEventListener('click', () => {
        if (e.edgeId == null) { alert('스캔(is) 엣지는 여기서 지울 수 없습니다.'); return; }
        if (!confirm((byId.get(e.to)?.name || e.to) + ' 로의 의존을 삭제할까요?')) return;
        deleteEdge(e.edgeId).catch((err) => alert('삭제 실패: ' + (err.message || err)));
      });
      dep.append(row);
    } else dep.append(el('div', { class: 'dmx-muted', text: '나가는 의존이 없습니다.' }));

    // 추가 폼
    const others = domains.filter((x) => x.id !== sel && !outShould.some((e) => e.to === x.id));
    if (others.length) {
      const selEl = el('select', { class: 'dmx-add-to' }) as HTMLSelectElement;
      selEl.append(el('option', { value: '', text: '대상 도메인…' }));
      for (const o of others) selEl.append(el('option', { value: String(o.id), text: o.name || o.key }));
      const relEl = el('input', { class: 'dmx-add-rel', type: 'text', placeholder: '관계 문구 (예: 정산)', maxlength: '64' }) as HTMLInputElement;
      const addBtn = el('button', { class: 'dmx-add-btn', type: 'button', text: '+ 의존 추가' });
      addBtn.addEventListener('click', () => {
        const to = Number(selEl.value); if (!to) { selEl.focus(); return; }
        upsertEdge(sel!, to, relEl.value.trim()).catch((err) => alert('추가 실패: ' + (err.message || err)));
      });
      dep.append(el('div', { class: 'dmx-add-form' }, selEl, relEl, addBtn));
    }
    panel.append(dep);

    // is 구조
    const is = el('div', { class: 'dmx-axis is' }, el('h4', { text: '구조 · is' }));
    if (mode === 'dev') {
      if (!det) is.append(el('div', { class: 'dmx-loading', text: '코드 매핑 불러오는 중…' }));
      else if (det.error) is.append(errorNote(det.error, '상세를 불러오지 못했습니다'));
      else {
        const units = (det.code_units || []).filter((u: any) => u.state !== 'removed');
        is.append(el('div', { class: 'dmx-metric' }, m2(fmtNum(units.length), '코드유닛'), m2(fmtNum(d.repos || 0), '레포'), m2(fmtNum(outs.filter((e) => e.is).length), 'is 의존')));
        const ul = el('ul', { class: 'dmx-repos' });
        for (const u of units.slice(0, 16)) ul.append(el('li', { title: u.path, text: u.path || u.label }));
        if (units.length) is.append(ul);
        if (units.length > 16) is.append(el('div', { class: 'dmx-more', text: '… 외 ' + fmtNum(units.length - 16) + '개' }));
      }
    } else {
      is.append(el('p', { class: 'dmx-muted' }, el('strong', { text: fmtNum(d.units || 0) }), document.createTextNode(' 코드유닛'),
        d.entities ? document.createTextNode(' · ' + fmtNum(d.entities) + ' 엔티티') : null as any,
        document.createTextNode(' · 나가는 의존 ' + fmtNum(outs.length) + ' · 들어오는 ' + fmtNum(ins.length))));
    }
    panel.append(is);

    const debt = el('div', { class: 'dmx-axis debt' }, el('h4', { text: '괴리 · debt' }));
    if (!hasIs) debt.append(el('div', { class: 'dmx-muted', text: '실제(is) 측정 전이라 의존 괴리는 아직 판정할 수 없습니다.' }));
    else if (!gaps.length) debt.append(el('div', { class: 'dmx-muted', text: '표면화된 의존 괴리가 없습니다.' }));
    else for (const e of gaps) debt.append(el('div', { class: 'dmx-gapline' },
      el('span', { class: 'dmx-gd dmx-g-' + (e.sev === 'is_no_should' ? 'viol' : 'warn') }),
      el('span', {}, el('b', { text: (byId.get(e.from)?.name || e.from) + ' → ' + (byId.get(e.to)?.name || e.to) }), document.createTextNode(e.sev === 'should_no_is' ? ' — 선언됐으나 코드 미확인' : ' — 코드에 있으나 선언 없음'))));
    panel.append(debt);
    return panel;
  }
  function m2(v: string, label: string) { return el('div', {}, el('b', { text: v }), el('span', { text: label })); }

  async function select(id: number) {
    sel = sel === id ? null : id;
    if (sel != null && mode === 'dev' && !detailCache[sel]) {
      try { detailCache[sel] = await api('/api/ui/domainmap/' + encodeURIComponent(repo || 'product') + '/domain/' + sel); }
      catch (e) { detailCache[sel] = { error: String((e as Error).message || e) }; }
    }
    draw();
  }

  draw();
}

export { renderDomainmap };

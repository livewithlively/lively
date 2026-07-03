// domainmap.ts — 도메인 맵 재설계 (프로젝트 #185).
//  기존 리스트 뷰를 폐기하고 **의존 흐름 그래프 + 드릴다운**으로 전면 교체.
//  두 직교 축:
//   · 레이어축(엣지) = 의도(should) / 실제(is) / 대조(겹침·괴리색)  — 무엇을 보는가
//   · 관점축(패널)   = PO / 개발자                                   — 누구를 위한 밀도인가
//  데이터: GET /api/ui/domainmap/map → { domains, debts, edges:{should,is}, ... }  (domainmap-store.productDomainmapView)
//   드릴다운: GET /api/ui/domainmap/product/domain/:id → { domain, code_units[], data_entities[], debts[] }
//  괴리는 프론트에서 should∖is(선언만)·is∖should(코드만) 차집합으로 유도. is 가 비면 '아직 측정 안 됨'으로 정직 표기(거짓 괴리 방지).
import { api, el, errorNote, fmtNum, loadRepos, pageHead, state } from './core.js';
import { skeleton } from './learn.js';
const SVGNS = 'http://www.w3.org/2000/svg';
// SVG 노드 생성 헬퍼 — el() 은 HTML 전용이라 SVG 는 createElementNS 로. text 속성은 textContent 로 특수처리(빈 라벨 버그 방지).
function sv(tag, attrs, ...kids) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) {
        if (attrs[k] == null)
            continue;
        if (k === 'text')
            e.textContent = String(attrs[k]);
        else
            e.setAttribute(k, String(attrs[k]));
    }
    for (const c of kids)
        if (c)
            e.appendChild(c);
    return e;
}
const NODE_W = 150, NODE_H = 46, COL_GAP = 178, ROW_GAP = 92, PAD = 34, BAND_GAP = 74;
// ── 방향성 레이어 배치 ──
//  union(should∪is) 엣지의 방향으로 각 노드의 열(depth)을 계산(longest-path, 사이클 안전 relaxation).
//  횡단(cross_cutting)은 레이어링에서 제외해 하단 밴드에 따로 둔다(모두와 연결돼 흐름을 왜곡하므로).
//  배치는 union 고정 — 레이어 토글로 엣지만 숨겨도 노드가 흔들리지 않는다.
function layout(domains, edges) {
    const core = domains.filter((d) => !d.cross_cutting);
    const cross = domains.filter((d) => d.cross_cutting);
    const coreIds = new Set(core.map((d) => d.id));
    const E = edges.filter((e) => coreIds.has(e.from) && coreIds.has(e.to) && e.from !== e.to);
    // 사이클이 레이어를 무한정 늘리지 않도록 DFS back-edge 를 떨궈 DAG 로 레이어링(흐름 방향 우선).
    const adj = new Map();
    core.forEach((d) => adj.set(d.id, []));
    for (const e of E)
        adj.get(e.from).push(e.to);
    const st = new Map(); // 0 방문전 · 1 스택 · 2 완료
    const back = new Set();
    const visit = (root) => {
        const path = [{ n: root, i: 0 }];
        st.set(root, 1);
        while (path.length) {
            const top = path[path.length - 1];
            const kids = adj.get(top.n);
            if (top.i < kids.length) {
                const v = kids[top.i++];
                const s = st.get(v) || 0;
                if (s === 1)
                    back.add(top.n + '>' + v); // 스택 안 → back-edge(사이클 폐합)
                else if (s === 0) {
                    st.set(v, 1);
                    path.push({ n: v, i: 0 });
                }
            }
            else {
                st.set(top.n, 2);
                path.pop();
            }
        }
    };
    for (const d of core)
        if (!st.get(d.id))
            visit(d.id);
    const DAG = E.filter((e) => !back.has(e.from + '>' + e.to));
    const layer = new Map();
    core.forEach((d) => layer.set(d.id, 0));
    // longest-path 레이어링 — DAG 라 사이클 없이 수렴.
    for (let i = 0; i < core.length; i++) {
        let changed = false;
        for (const e of DAG) {
            const nl = layer.get(e.from) + 1;
            if (nl > layer.get(e.to)) {
                layer.set(e.to, nl);
                changed = true;
            }
        }
        if (!changed)
            break;
    }
    // 열별 그룹핑 → 좌표. 같은 열 노드는 세로 분산(가운데 정렬).
    const cols = new Map();
    let maxL = 0;
    for (const d of core) {
        const L = layer.get(d.id) || 0;
        maxL = Math.max(maxL, L);
        if (!cols.has(L))
            cols.set(L, []);
        cols.get(L).push(d);
    }
    let maxRows = 0;
    cols.forEach((arr) => { maxRows = Math.max(maxRows, arr.length); });
    const pos = new Map();
    const coreH = Math.max(1, maxRows) * ROW_GAP;
    cols.forEach((arr, L) => {
        const colH = arr.length * ROW_GAP;
        const y0 = PAD + (coreH - colH) / 2;
        arr.forEach((d, i) => {
            pos.set(d.id, { x: PAD + L * COL_GAP + NODE_W / 2, y: y0 + i * ROW_GAP + NODE_H / 2, cross: false });
        });
    });
    // 횡단 밴드 — core 아래 한 줄로 나열.
    const bandY = PAD + coreH + BAND_GAP;
    cross.forEach((d, i) => {
        pos.set(d.id, { x: PAD + i * (NODE_W + 28) + NODE_W / 2, y: bandY + NODE_H / 2, cross: true });
    });
    const width = Math.max((maxL + 1) * COL_GAP, cross.length * (NODE_W + 28)) + PAD * 2;
    const height = bandY + (cross.length ? NODE_H + PAD : PAD - BAND_GAP + PAD);
    return { pos, width, height, hasCross: cross.length > 0, bandY };
}
// 노드 박스 경계로 선분 끝점 클리핑(중심→중심 선을 박스 가장자리에서 자름) — 화살표가 박스에 안 파묻히게.
function clipEnds(a, b) {
    const hw = NODE_W / 2, hh = NODE_H / 2;
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    const cl = (c, sx, sy) => {
        const tx = sx !== 0 ? hw / Math.abs(sx) : 1e9, ty = sy !== 0 ? hh / Math.abs(sy) : 1e9;
        const t = Math.min(tx, ty);
        return { x: c.x + sx * t, y: c.y + sy * t };
    };
    const s = cl(a, ux, uy), e = cl(b, -ux, -uy);
    return { x1: s.x, y1: s.y, x2: e.x, y2: e.y, mx: (s.x + e.x) / 2, my: (s.y + e.y) / 2 };
}
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// ════════════════════════════════════════════
// 도메인 맵(#/domainmap) — 의존 흐름 그래프 + 드릴다운.
// ════════════════════════════════════════════
async function renderDomainmap(view, params) {
    view.replaceChildren(skeleton('도메인 맵을 불러오는 중'));
    const repos = await loadRepos();
    let repo = (params && params.get('repo')) || state.dmRepo || repos[0];
    if (repos.length && !repos.includes(repo))
        repo = repos[0];
    state.dmRepo = repo;
    let data;
    try {
        data = await api('/api/ui/domainmap/map?' + new URLSearchParams({ repo: repo || 'product', limit: '200' }));
    }
    catch (e) {
        view.replaceChildren(pageHead('도메인 맵', '도메인 간 의존과 should·is·debt.', [], '맵'), errorNote(e, '도메인 맵을 불러오지 못했습니다'));
        return;
    }
    // ── 정규화 ──
    const domains = data.domains || [];
    const byId = new Map(domains.map((d) => [d.id, d]));
    const sE = (data.edges && data.edges.should) || [];
    const iE = (data.edges && data.edges.is) || [];
    const relOf = new Map();
    const weightOf = new Map();
    const sK = new Set(sE.map((e) => { relOf.set(e.from_category_id + '>' + e.to_category_id, e.relation); return e.from_category_id + '>' + e.to_category_id; }));
    const iK = new Set(iE.map((e) => { weightOf.set(e.from_category_id + '>' + e.to_category_id, e.weight); return e.from_category_id + '>' + e.to_category_id; }));
    const edges = [...new Set([...sK, ...iK])].map((k) => {
        const [f, t] = k.split('>').map(Number);
        const should = sK.has(k), is = iK.has(k);
        return { key: k, from: f, to: t, should, is, sev: should && is ? 'ok' : (should ? 'should_no_is' : 'is_no_should'), rel: relOf.get(k), weight: weightOf.get(k) };
    }).filter((e) => byId.has(e.from) && byId.has(e.to));
    const hasIs = iE.length > 0;
    const LO = layout(domains, edges);
    // ── 뷰 상태 ──
    let layer = 'both';
    let mode = 'po';
    let showCross = false;
    let sel = null;
    const detailCache = {};
    const head = pageHead('도메인 맵', '도메인이 어떤 순서로 의존을 흘려보내는지, 설계 의도(should)와 실제 코드(is)가 어디서 어긋나는지를 한 화면에서 봅니다.', [], '맵');
    // 활성 엣지(레이어 토글 반영) — 배치는 union 고정, 표시만 필터.
    function activeEdges() {
        return edges.filter((e) => {
            if (!showCross && (byId.get(e.from)?.cross_cutting || byId.get(e.to)?.cross_cutting))
                return false;
            if (layer === 'should')
                return e.should;
            if (layer === 'is')
                return e.is;
            return true;
        });
    }
    function visibleNodes() { return domains.filter((d) => showCross || !d.cross_cutting); }
    // 엣지 심각도를 CSS/마커 토큰(ok·warn·viol·pending)으로 매핑 — should_no_is→warn, is_no_should→viol.
    //  대조 뷰에서 is 미측정(hasIs=false)이면 should_no_is 를 '괴리(warn)'가 아니라 pending(측정 전)으로 낮춘다.
    function sevClass(e) {
        if (e.sev === 'ok')
            return 'ok';
        if (e.sev === 'is_no_should')
            return 'viol';
        return hasIs ? 'warn' : 'pending'; // should_no_is
    }
    function nodeGap(id) {
        let v = null;
        for (const e of activeEdges()) {
            if (e.from !== id && e.to !== id)
                continue;
            const s = sevClass(e); // ok·warn·viol·pending
            if (s === 'viol')
                v = 'viol';
            else if (s === 'warn' && v !== 'viol')
                v = 'warn';
        }
        return v;
    }
    function draw() {
        view.replaceChildren(head, buildControls(), buildStage(), buildLower());
    }
    // ── 컨트롤 바 ──
    function seg(label, opts, cur, on) {
        const box = el('div', { class: 'dmx-seg', role: 'group', 'aria-label': label });
        for (const [v, t] of opts) {
            const b = el('button', { type: 'button', 'aria-pressed': String(cur === v), text: t });
            b.addEventListener('click', () => { on(v); });
            box.append(b);
        }
        return box;
    }
    function buildControls() {
        const layerSeg = seg('레이어', [['both', '대조'], ['should', '의도 · should'], ['is', '실제 · is']], layer, (v) => { layer = v; draw(); });
        const modeSeg = seg('관점', [['po', 'PO 관점'], ['dev', '개발자 관점']], mode, (v) => { mode = v; draw(); });
        const crossWrap = el('label', { class: 'dmx-toggle' });
        const cb = el('input', { type: 'checkbox' });
        cb.checked = showCross;
        cb.addEventListener('change', () => { showCross = cb.checked; draw(); });
        crossWrap.append(cb, el('span', { class: 'dmx-switch', 'aria-hidden': 'true' }), document.createTextNode('횡단 도메인'));
        const legend = el('div', { class: 'dmx-legend' });
        if (layer !== 'should')
            legend.append(lg('ok', '일치'));
        if (layer !== 'is')
            legend.append(lg(hasIs ? 'warn' : 'pending', hasIs ? '선언만 (should)' : 'is 측정 전'));
        if (layer !== 'should' && hasIs)
            legend.append(lg('viol', '코드만 (is)'));
        const bar = el('div', { class: 'dmx-controls' }, layerSeg, modeSeg, crossWrap, legend);
        if (repos.length > 1) {
            const s = el('select', { class: 'dmx-repo' });
            for (const r of repos)
                s.append(el('option', { value: r, text: r }));
            s.value = repo;
            s.addEventListener('change', () => { state.dmRepo = s.value; location.hash = '#/domainmap?repo=' + encodeURIComponent(s.value); });
            bar.append(el('div', { class: 'dmx-repo-wrap' }, el('span', { class: 'dmx-repo-lbl', text: '레포' }), s));
        }
        return bar;
    }
    function lg(cls, txt) {
        return el('span', { class: 'dmx-lg dmx-lg-' + cls }, el('i', {}), document.createTextNode(txt));
    }
    // ── 스테이지: 그래프 + 드릴다운 패널 ──
    function buildStage() {
        return el('div', { class: 'dmx-stage' }, buildGraph(), buildPanel());
    }
    function buildGraph() {
        const wrap = el('div', { class: 'dmx-canvas' });
        const hd = el('div', { class: 'dmx-canvas-head' }, el('span', { class: 'dmx-ch-t', text: layer === 'should' ? '의도한 의존 (should)' : layer === 'is' ? '실제 코드 의존 (is)' : '의도 · 실제 대조' }), el('span', { class: 'dmx-ch-s', text: fmtNum(visibleNodes().length) + ' 도메인 · ' + fmtNum(activeEdges().length) + ' 의존' }));
        wrap.append(hd);
        // is 미측정 안내(실제/대조 뷰) — 거짓 괴리 방지.
        if (!hasIs && layer !== 'should') {
            wrap.append(el('div', { class: 'dmx-note' }, el('strong', { text: '실제(is) 의존은 아직 측정 전입니다.' }), document.createTextNode(' 코드 스캔(refresh)이 import 를 수집하면 실선과 괴리가 채워집니다. 지금은 의도(should)만 신뢰할 수 있습니다.')));
        }
        const scroll = el('div', { class: 'dmx-svg-scroll' });
        const svg = sv('svg', { class: 'dmx-graph', viewBox: `0 0 ${Math.round(LO.width)} ${Math.round(LO.height)}`, role: 'img', 'aria-label': '도메인 의존 흐름 그래프' });
        // 화살표 마커(색상별)
        const defs = sv('defs', {});
        for (const [id, col] of [['ok', 'var(--dmx-ok)'], ['warn', 'var(--dmx-warn)'], ['viol', 'var(--dmx-viol)'], ['pending', 'var(--dmx-pending)']]) {
            defs.appendChild(sv('marker', { id: 'dmx-ah-' + id, markerWidth: 8, markerHeight: 8, refX: 6.5, refY: 3, orient: 'auto', markerUnits: 'userSpaceOnUse' }, sv('path', { d: 'M0,0 L7,3 L0,6 Z', fill: col })));
        }
        svg.appendChild(defs);
        const gEdge = sv('g', {}), gLabel = sv('g', {}), gNode = sv('g', {});
        const act = activeEdges();
        const neighbor = (id) => sel != null && act.some((e) => (e.from === sel && e.to === id) || (e.to === sel && e.from === id));
        for (const e of act) {
            const a = LO.pos.get(e.from), b = LO.pos.get(e.to);
            if (!a || !b)
                continue;
            const p = clipEnds(a, b);
            const s = sevClass(e);
            const hot = sel != null && (e.from === sel || e.to === sel);
            const dim = sel != null && !hot;
            const cls = 'dmx-edge dmx-e-' + s + (hot ? ' hot' : '') + (dim ? ' dim' : '');
            gEdge.appendChild(sv('line', { class: cls, x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, 'marker-end': `url(#dmx-ah-${s})` }));
            if (hot) {
                const lbl = mode === 'dev' && e.is ? ('×' + fmtNum(e.weight || 0)) : (e.rel || '');
                if (lbl) {
                    const w = lbl.length * 6.4 + 10;
                    const g = sv('g', {});
                    g.appendChild(sv('rect', { x: p.mx - w / 2, y: p.my - 8, width: w, height: 15, rx: 4, fill: 'var(--dmx-surface)', stroke: 'var(--dmx-line2)', 'stroke-width': 1 }));
                    g.appendChild(sv('text', { class: 'dmx-elabel', x: p.mx, y: p.my + 2.5, 'text-anchor': 'middle', text: lbl }));
                    gLabel.appendChild(g);
                }
            }
        }
        for (const d of visibleNodes()) {
            const p = LO.pos.get(d.id);
            if (!p)
                continue;
            const dim = sel != null && sel !== d.id && !neighbor(d.id);
            const g = sv('g', { class: 'dmx-node' + (d.cross_cutting ? ' cross' : '') + (sel === d.id ? ' active' : '') + (dim ? ' dim' : ''), tabindex: 0, role: 'button', 'data-id': d.id, 'aria-label': d.name || d.key });
            g.appendChild(sv('rect', { class: 'dmx-box', x: p.x - NODE_W / 2, y: p.y - NODE_H / 2, width: NODE_W, height: NODE_H, rx: 9 }));
            g.appendChild(sv('rect', { class: 'dmx-stripe', x: p.x - NODE_W / 2, y: p.y - NODE_H / 2, width: 4, height: NODE_H, rx: 2 }));
            g.appendChild(sv('text', { class: 'dmx-nm', x: p.x - NODE_W / 2 + 14, y: p.y - 2, text: d.name || d.key }));
            g.appendChild(sv('text', { class: 'dmx-ky', x: p.x - NODE_W / 2 + 14, y: p.y + 13, text: d.key }));
            const gap = nodeGap(d.id);
            if (gap)
                g.appendChild(sv('circle', { class: 'dmx-gapdot dmx-g-' + gap, cx: p.x + NODE_W / 2 - 11, cy: p.y - NODE_H / 2 + 11, r: 4 }));
            g.addEventListener('click', () => { select(d.id); });
            g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                select(d.id);
            } });
            gNode.appendChild(g);
        }
        svg.appendChild(gEdge);
        svg.appendChild(gLabel);
        svg.appendChild(gNode);
        scroll.append(svg);
        wrap.append(scroll);
        return wrap;
    }
    // ── 드릴다운 패널 ──
    function buildPanel() {
        const panel = el('div', { class: 'dmx-panel' });
        if (sel == null) {
            panel.append(el('div', { class: 'dmx-empty', text: '도메인을 클릭하면 should · is · debt 상세가 열립니다.' }));
            return panel;
        }
        const d = byId.get(sel);
        const det = detailCache[sel];
        const outs = edges.filter((e) => e.from === sel);
        const ins = edges.filter((e) => e.to === sel);
        const gaps = [...outs, ...ins].filter((e) => sevClass(e) !== 'ok');
        const tags = el('div', { class: 'dmx-ptags' }, d.cross_cutting ? el('span', { class: 'dmx-tag cross', text: '횡단' }) : el('span', { class: 'dmx-tag sp', text: '제품 도메인' }), (gaps.length && hasIs) ? el('span', { class: 'dmx-tag debt', text: '괴리 ' + gaps.length }) : null);
        panel.append(el('div', { class: 'dmx-ph' }, el('div', { class: 'dmx-pk', text: d.key }), el('div', { class: 'dmx-pn', text: d.name || d.key }), tags));
        // should
        const should = el('div', { class: 'dmx-axis should' }, el('h4', { text: '의도 · should' }));
        should.append(el('p', { text: (d.should && d.should.trim()) ? d.should : '아직 설정되지 않았습니다.' }));
        if (mode === 'po' && d.description && d.description !== d.should)
            should.append(el('div', { class: 'dmx-bd', text: d.description }));
        panel.append(should);
        // is
        const is = el('div', { class: 'dmx-axis is' }, el('h4', { text: '구조 · is' }));
        if (mode === 'dev') {
            if (!det)
                is.append(el('div', { class: 'dmx-loading', text: '코드 매핑 불러오는 중…' }));
            else if (det.error)
                is.append(errorNote(det.error, '상세를 불러오지 못했습니다'));
            else {
                const units = (det.code_units || []).filter((u) => u.state !== 'removed');
                const ul = el('ul', { class: 'dmx-repos' });
                for (const u of units.slice(0, 14))
                    ul.append(el('li', { title: u.path, text: u.path || u.label }));
                is.append(el('div', { class: 'dmx-metric' }, m(fmtNum(units.length), '코드유닛'), m(fmtNum(d.repos || 0), '레포'), m(fmtNum(outs.filter((e) => e.is).length), 'is 의존')));
                if (units.length)
                    is.append(ul);
                if (units.length > 14)
                    is.append(el('div', { class: 'dmx-more', text: '… 외 ' + fmtNum(units.length - 14) + '개' }));
            }
        }
        else {
            is.append(el('p', { class: 'dmx-muted' }, el('strong', { text: fmtNum(d.units || 0) }), document.createTextNode(' 코드유닛'), d.entities ? document.createTextNode(' · ' + fmtNum(d.entities) + ' 엔티티') : null, document.createTextNode(' · 나가는 의존 ' + fmtNum(outs.length) + ' · 들어오는 ' + fmtNum(ins.length))));
        }
        panel.append(is);
        // debt (엣지 괴리)
        const debt = el('div', { class: 'dmx-axis debt' }, el('h4', { text: '괴리 · debt' }));
        if (!hasIs)
            debt.append(el('div', { class: 'dmx-muted', text: '실제(is) 측정 전이라 의존 괴리는 아직 판정할 수 없습니다.' }));
        else if (!gaps.length)
            debt.append(el('div', { class: 'dmx-muted', text: '표면화된 의존 괴리가 없습니다.' }));
        else
            for (const e of gaps) {
                const s = e.sev;
                debt.append(el('div', { class: 'dmx-gapline' }, el('span', { class: 'dmx-gd dmx-g-' + (s === 'is_no_should' ? 'viol' : 'warn') }), el('span', {}, el('b', { text: (byId.get(e.from)?.name || e.from) + ' → ' + (byId.get(e.to)?.name || e.to) }), document.createTextNode(s === 'should_no_is' ? ' — 선언됐으나 코드 미확인' : ' — 코드에 있으나 선언 없음'))));
            }
        panel.append(debt);
        return panel;
    }
    function m(v, label) { return el('div', {}, el('b', { text: v }), el('span', { text: label })); }
    // ── 하단: 의존 괴리 요약 리스트 ──
    function buildLower() {
        const wrap = el('div', { class: 'dmx-lower' });
        const gaps = edges.filter((e) => e.sev !== 'ok');
        const showGap = hasIs ? gaps : [];
        const h = el('div', { class: 'dmx-lower-head' }, el('h3', { text: 'should ↔ is 의존 괴리' }), el('span', { class: 'dmx-c', text: hasIs ? String(showGap.length) + '건' : 'is 측정 전' }));
        wrap.append(h);
        if (!hasIs) {
            wrap.append(el('p', { class: 'dmx-hint', text: '실제(is) 의존이 수집되면 선언(should)과의 차집합으로 괴리가 여기 쌓입니다. 지금은 의도 뷰만 신뢰하세요.' }));
            return wrap;
        }
        if (!showGap.length) {
            wrap.append(el('p', { class: 'dmx-hint', text: '선언과 코드가 일치합니다 — 표면화된 괴리 없음.' }));
            return wrap;
        }
        const grid = el('div', { class: 'dmx-dgrid' });
        for (const e of showGap) {
            const viol = e.sev === 'is_no_should';
            grid.append(el('div', { class: 'dmx-dcard ' + (viol ? 'viol' : 'warn') }, el('div', { class: 'dmx-dt' }, el('span', { class: 'dmx-sev', text: e.sev }), el('span', { text: (byId.get(e.from)?.name || e.from) + ' → ' + (byId.get(e.to)?.name || e.to) })), el('div', { class: 'dmx-why', text: viol ? '코드엔 이 의존이 있는데 경계 선언이 없음 — 문서 안 된 결합(경계 침범 후보).' : '경계엔 선언됐는데 코드 import 가 확인되지 않음 — 의도된 결합이 누락됐거나 다른 도메인을 경유.' })));
        }
        wrap.append(grid);
        return wrap;
    }
    async function select(id) {
        sel = sel === id ? null : id;
        if (sel != null && mode === 'dev' && !detailCache[sel]) {
            try {
                detailCache[sel] = await api('/api/ui/domainmap/' + encodeURIComponent(repo || 'product') + '/domain/' + sel);
            }
            catch (e) {
                detailCache[sel] = { error: String(e.message || e) };
            }
        }
        draw();
    }
    draw();
}
export { renderDomainmap };

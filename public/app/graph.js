// graph.ts — 지식 아틀라스(standalone 풀스크린 그래프, #290).
//  앱 셸/core.js 비의존. 자체 fetch·렌더·물리. 데이터가 "클러스터 지배적"(7 도메인, 링크 희소)이라
//  링크 거미줄이 아니라 "도메인 영토 지도"로 그린다 — 카테고리=영역(territory), 지식=점.
//  팬·줌은 지도처럼, 라벨은 줌/호버에 따라 적응적으로(겹침 컬링), 색은 카테고리에 매핑.
// 토큰 키만 leaf 모듈 lib/net.ts 에서 받는다(R29a) — 레포에 정의를 1곳으로 모으기 위함이고,
//  net.ts 는 우리 모듈 import 0 인 leaf 라 이 페이지가 **여전히 core.js 를 안 끌어온다**(자족 성질 유지).
import { TOKEN_KEY } from './lib/net.js';
const SVG_NS = 'http://www.w3.org/2000/svg';
// ── 미니 DOM 헬퍼(core.js 와 동형, 자족) ──
//  ⚠ 이 파일은 graph.html 이 단독으로 로드한다(core.js 를 안 끌어온다) — 그래서 core.ts 의 자동완성 차단
//    규칙(#1250)을 여기에 **복제**해 둔다. 한쪽만 고치면 이 페이지에 구멍이 생긴다.
function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs)
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null)
                continue;
            if (k === 'class')
                n.className = v;
            else if (k === 'text')
                n.textContent = v;
            else if (k.startsWith('on'))
                n.addEventListener(k.slice(2), v);
            else
                n.setAttribute(k, v);
        }
    // autocomplete 를 명시하지 않은 입력칸 = 자격증명 칸이 아니다 → 브라우저·패스워드매니저 자동완성에서 뺀다.
    if ((tag === 'input' || tag === 'textarea') && !n.hasAttribute('autocomplete')) {
        n.setAttribute('autocomplete', 'off');
        n.setAttribute('data-1p-ignore', '');
        n.setAttribute('data-lpignore', 'true');
        n.setAttribute('data-bwignore', 'true');
        n.setAttribute('data-protonpass-ignore', 'true');
    }
    for (const c of kids.flat(Infinity)) {
        if (c != null)
            n.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
}
function sv(name, attrs, ...kids) {
    const n = document.createElementNS(SVG_NS, name);
    if (attrs)
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null)
                continue;
            if (k === 'text')
                n.textContent = v;
            else
                n.setAttribute(k, v);
        }
    for (const c of kids.flat(Infinity)) {
        if (c != null)
            n.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
}
async function api(path) {
    const token = localStorage.getItem(TOKEN_KEY);
    const headers = {};
    if (token)
        headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(path, { headers });
    if (res.status === 401) {
        const e = new Error('인증이 필요합니다');
        e.status = 401;
        throw e;
    }
    let data = null;
    try {
        data = await res.json();
    }
    catch (_) { /* noop */ }
    if (!res.ok) {
        const e = new Error((data && data.error) || ('요청 실패 (' + res.status + ')'));
        e.status = res.status;
        throw e;
    }
    return data;
}
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
// ── 팔레트 — 카테고리 key → 색. space(제품/사업/시스템)로 색 계열을 나눠 공간이 의미를 갖게. ──
const SPACE_ORDER = ['product', 'business', 'system'];
const SPACE_LABEL = { product: '제품', business: '사업', system: '시스템' };
const CAT_COLOR = {
    'canonical-context-store': '#16C79A', // 컨텍스트 저장소 — 브랜드 에메랄드(이 제품의 본거지)
    'workflow-standardization': '#3B82F6', // AI 워크플로우 표준화 — 블루
    'domain-cartography': '#22D3EE', // 도메인 맵 — 시안
    'market-competition': '#F59E0B', // 시장·경쟁 — 앰버
    'gtm': '#FB7185', // GTM — 로즈코랄
    'brand': '#E879F9', // 브랜드 — 푸시아
    'org': '#8B5CF6', // 조직 — 바이올렛
};
function hashColor(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++)
        h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 62% 60%)`;
}
const catColor = (key) => key && CAT_COLOR[key] || (key ? hashColor(key) : '#94A3B8');
const NO_CAT = '__none__';
// ── 물리 상수(자체 force-directed) ──
const REP = 2700; // 노드 간 반발(전하)
const REP_CUT2 = 380 * 380; // 반발 컷오프(거리²)
const GRAV = 0.09; // 자기 영역 앵커로의 인력
const LINK_REST = 74, LINK_K = 0.045;
const FRICTION = 0.6; // 속도 유지율
const ALPHA_DECAY = 0.017, ALPHA_MIN = 0.004;
const COLL_ITERS = 2, COLL_PAD = 4;
const TERR_PAD = 30; // 영역 외곽 패딩
const LABEL_K = 1.15; // 이 줌배율 이상에서 노드 라벨 후보(이하면 영역 이름만)
const K_MIN = 0.12, K_MAX = 6;
const rad = (count) => 24 + Math.sqrt(count) * 15; // 영역 반경(노드 수)
const nodeR = (deg) => 4.5 + Math.sqrt(deg) * 2.6; // 노드 반경(연결차수)
const regionFont = (count) => clamp(13 + Math.sqrt(count) * 2.4, 14, 30);
// ── 상태 ──
const root = document.getElementById('atlas-root');
const view = { k: 1, tx: 0, ty: 0 };
let NODES = [], LINKS = [], CATS = [];
const byName = new Map();
const adj = new Map();
let svg, gViewport, gGrid, gHulls, gLinks, gNodes, gRegion, gNlab, stage;
let hoverName = null, soloCat = null, query = '';
let alpha = 0, running = false, dragNode = null;
main();
async function main() {
    let data;
    try {
        data = await api('/api/ui/knowledge-graph?limit=1000');
    }
    catch (e) {
        renderState(e && e.status === 401 ? 'auth' : 'error', e);
        return;
    }
    const nodes = (data && data.nodes) || [], edges = (data && data.edges) || [];
    if (!nodes.length) {
        renderState('empty');
        return;
    }
    build(nodes, edges);
}
// ── 빌드 ──
function build(nodes, edges) {
    NODES = nodes.map((n) => ({
        name: n.name, title: n.title || n.name, cat: n.category || NO_CAT,
        catName: n.category_name || n.category || '미분류', space: n.space || 'system',
        deg: 0, x: 0, y: 0, vx: 0, vy: 0, r: 5, color: catColor(n.category),
    }));
    for (const n of NODES)
        byName.set(n.name, n);
    // 링크 — 양끝이 모두 노드셋에 있을 때만. 차수·인접 집계.
    LINKS = [];
    for (const e of edges) {
        const a = byName.get(e.from_name), b = byName.get(e.to_name);
        if (!a || !b || a === b)
            continue;
        LINKS.push({ a, b, relation: e.relation });
        a.deg++;
        b.deg++;
        if (!adj.has(a.name))
            adj.set(a.name, new Set());
        if (!adj.has(b.name))
            adj.set(b.name, new Set());
        adj.get(a.name).add(b.name);
        adj.get(b.name).add(a.name);
    }
    for (const n of NODES)
        n.r = nodeR(n.deg);
    // 카테고리 묶기 + space 순 정렬(공간 배치·범례 순서).
    const cmap = new Map();
    for (const n of NODES) {
        if (!cmap.has(n.cat))
            cmap.set(n.cat, { key: n.cat, name: n.catName, space: n.space, color: n.color, nodes: [] });
        cmap.get(n.cat).nodes.push(n);
    }
    CATS = [...cmap.values()].sort((a, b) => (SPACE_ORDER.indexOf(a.space) - SPACE_ORDER.indexOf(b.space)) || (b.nodes.length - a.nodes.length));
    layoutAnchors();
    initPositions();
    buildScene();
    wire();
    // 정착 — 모션 줄이면 즉시 수렴, 아니면 애니메이션으로 "영토가 피어나는" 진입.
    if (reducedMotion()) {
        for (let i = 0; i < 140; i++)
            force();
        updateGeometry();
        fitInitial();
        paint();
    }
    else {
        updateGeometry();
        fitInitial();
        paint();
        alpha = 1;
        ensureRunning();
    }
}
// 영역 앵커를 큰 링에 배치 — 인접 반경 합에 비례한 간격(겹침 방지), space 순.
function layoutAnchors() {
    const n = CATS.length;
    if (n === 1) {
        CATS[0].ax = 0;
        CATS[0].ay = 0;
        return;
    }
    const segs = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
        const s = rad(CATS[i].nodes.length) + rad(CATS[(i + 1) % n].nodes.length) + 90;
        segs.push(s);
        total += s;
    }
    const R = Math.max(340, total / (Math.PI * 2));
    let acc = 0;
    for (let i = 0; i < n; i++) {
        const ang = (acc / total) * Math.PI * 2 - Math.PI / 2;
        CATS[i].ax = Math.cos(ang) * R;
        CATS[i].ay = Math.sin(ang) * R;
        acc += segs[i];
    }
}
// 노드 초기 위치 — 자기 앵커 둘레 황금각 나선(결정적, 무작위 없음).
function initPositions() {
    for (const c of CATS) {
        const arr = c.nodes, base = rad(arr.length) * 0.62;
        arr.forEach((nd, i) => {
            const a = i * 2.399963229728653; // 황금각
            const rr = base * Math.sqrt((i + 0.5) / arr.length);
            nd.ax = c.ax;
            nd.ay = c.ay; // 앵커(인력 목표)
            nd.x = c.ax + Math.cos(a) * rr;
            nd.y = c.ay + Math.sin(a) * rr;
            nd.vx = 0;
            nd.vy = 0;
        });
    }
}
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// ── 물리 한 틱 ──
function force() {
    const a = alpha;
    // 앵커 인력(영역 중력)
    for (const n of NODES) {
        n.vx += (n.ax - n.x) * GRAV * a;
        n.vy += (n.ay - n.y) * GRAV * a;
    }
    // 반발(전하) — O(n²), 130 노드라 충분.
    for (let i = 0; i < NODES.length; i++) {
        const ni = NODES[i];
        for (let j = i + 1; j < NODES.length; j++) {
            const nj = NODES[j];
            let dx = nj.x - ni.x, dy = nj.y - ni.y, d2 = dx * dx + dy * dy;
            if (d2 > REP_CUT2 || d2 === 0) {
                if (d2 === 0) {
                    dx = (i - j) * 0.01 + 0.1;
                    dy = 0.1;
                    d2 = dx * dx + dy * dy;
                }
                else
                    continue;
            }
            const d = Math.sqrt(d2), m = REP * a / d2, ux = dx / d, uy = dy / d;
            ni.vx -= ux * m;
            ni.vy -= uy * m;
            nj.vx += ux * m;
            nj.vy += uy * m;
        }
    }
    // 링크 스프링
    for (const l of LINKS) {
        const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, d = Math.hypot(dx, dy) || 1;
        const f = (d - LINK_REST) * LINK_K * a, ux = dx / d, uy = dy / d;
        l.a.vx += ux * f;
        l.a.vy += uy * f;
        l.b.vx -= ux * f;
        l.b.vy -= uy * f;
    }
    // 적분 + 마찰(드래그 중 노드는 고정)
    for (const n of NODES) {
        if (n === dragNode) {
            n.x = n.fx;
            n.y = n.fy;
            n.vx = 0;
            n.vy = 0;
            continue;
        }
        n.vx *= FRICTION;
        n.vy *= FRICTION;
        n.x += n.vx;
        n.y += n.vy;
    }
    // 충돌 — 노드끼리 최소거리 확보(겹침=라벨 겹침의 근원).
    for (let it = 0; it < COLL_ITERS; it++) {
        for (let i = 0; i < NODES.length; i++) {
            const ni = NODES[i];
            for (let j = i + 1; j < NODES.length; j++) {
                const nj = NODES[j];
                const dx = nj.x - ni.x, dy = nj.y - ni.y, min = ni.r + nj.r + COLL_PAD;
                const d2 = dx * dx + dy * dy;
                if (d2 >= min * min || d2 === 0)
                    continue;
                const d = Math.sqrt(d2), push = (min - d) / 2, ux = dx / d, uy = dy / d;
                if (ni !== dragNode) {
                    ni.x -= ux * push;
                    ni.y -= uy * push;
                }
                if (nj !== dragNode) {
                    nj.x += ux * push;
                    nj.y += uy * push;
                }
            }
        }
    }
    alpha += (0 - alpha) * ALPHA_DECAY;
}
// ── 기하 갱신(월드 좌표) — 노드 점·링크·영역 패스. ──
function updateGeometry() {
    for (const n of NODES) {
        n.elDot.setAttribute('cx', n.x.toFixed(1));
        n.elDot.setAttribute('cy', n.y.toFixed(1));
    }
    for (const l of LINKS) {
        l.elLine.setAttribute('x1', l.a.x.toFixed(1));
        l.elLine.setAttribute('y1', l.a.y.toFixed(1));
        l.elLine.setAttribute('x2', l.b.x.toFixed(1));
        l.elLine.setAttribute('y2', l.b.y.toFixed(1));
    }
    for (const c of CATS) {
        let cx = 0, cy = 0;
        for (const n of c.nodes) {
            cx += n.x;
            cy += n.y;
        }
        cx /= c.nodes.length;
        cy /= c.nodes.length;
        c.cx = cx;
        c.cy = cy;
        let d = null, topY = cy;
        if (c.nodes.length >= 3) {
            let h = convexHull(c.nodes);
            if (h.length >= 3) {
                h = h.map((v) => { const dx = v.x - cx, dy = v.y - cy, L = Math.hypot(dx, dy) || 1; return { x: v.x + dx / L * TERR_PAD, y: v.y + dy / L * TERR_PAD }; });
                d = smoothClosed(h);
                topY = Math.min(...h.map((v) => v.y));
            }
        }
        if (!d) {
            let r = TERR_PAD + 8;
            for (const n of c.nodes)
                r = Math.max(r, Math.hypot(n.x - cx, n.y - cy) + TERR_PAD);
            d = circlePath(cx, cy, r);
            topY = cy - r;
        }
        c.topY = topY;
        c.elHalo.setAttribute('d', d);
        c.elFill.setAttribute('d', d);
    }
}
// ── 페인트(스크린 좌표) — 뷰 변환 + 라벨 적응 표시(겹침 컬링) + dim 상태. ──
function paint() {
    gViewport.setAttribute('transform', `translate(${view.tx.toFixed(2)} ${view.ty.toFixed(2)}) scale(${view.k.toFixed(4)})`);
    gGrid.style.opacity = String(clamp((160 * view.k - 26) / 46, 0, 1)); // 격자 화면간격이 좁아지면 페이드
    const W = root.clientWidth, H = root.clientHeight;
    const toScreen = (x, y) => [x * view.k + view.tx, y * view.k + view.ty];
    const hoverSet = hoverName ? new Set([hoverName, ...(adj.get(hoverName) || [])]) : null;
    // 영역 이름(스크린) — 항상(7개). solo/검색 시 비대상 영역 흐리게.
    for (const c of CATS) {
        const [sx, sy] = toScreen(c.cx, c.topY);
        const f = regionFont(c.nodes.length);
        // 개수는 경계선 바로 위 고정, 이름은 그 위로(글자 클수록 더 위) — 작은 영역에서도 겹치지 않게.
        c.elName.setAttribute('x', sx.toFixed(1));
        c.elName.setAttribute('y', (sy - 15 - f * 0.55).toFixed(1));
        c.elName.setAttribute('font-size', f.toFixed(1));
        c.elCount.setAttribute('x', sx.toFixed(1));
        c.elCount.setAttribute('y', (sy - 10).toFixed(1));
        const muted = (soloCat && c.key !== soloCat) ? true : false;
        c.elTerr.classList.toggle('muted', muted);
        c.elName.parentNode.classList.toggle('muted', muted);
    }
    // 노드 dim(검색/solo) + 호버 강조. 점 크기는 화면 기준 안정(과확대 시 비대화 방지) — Obsidian 류.
    const sizeK = clamp(view.k, 0.7, 2.2) / view.k;
    for (const n of NODES) {
        const dim = (query && !n._match) || (soloCat && n.cat !== soloCat);
        n.elNd.classList.toggle('dim', !!dim);
        n.elNd.classList.toggle('hot', hoverName === n.name || !!(hoverSet && hoverSet.has(n.name) && hoverName !== n.name));
        const bump = hoverName === n.name ? 3 / view.k : 0;
        n.elDot.setAttribute('r', (n.r * sizeK + bump).toFixed(2));
    }
    for (const l of LINKS)
        l.elLine.classList.toggle('hot', !!(hoverSet && (l.a.name === hoverName || l.b.name === hoverName)));
    // 노드 라벨 — 우선순위 + 겹침 컬링. 강제표시: 호버집합/검색매치. 그 외 줌≥LABEL_K 일 때 후보.
    const placed = [];
    const overlaps = (b) => placed.some((p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);
    const labelBox = (n, fontPx) => {
        const [sx, sy] = toScreen(n.x, n.y);
        const off = n.r * view.k + 5;
        const w = Math.min(n.title.length, 22) * fontPx * 0.62 + 4;
        return [sx + off, sy - fontPx * 0.7, sx + off + w, sy + fontPx * 0.7];
    };
    const placeLabel = (n, strong) => {
        const fontPx = strong ? 13 : 12;
        const b = labelBox(n, fontPx);
        const lab = n.elLab;
        if (b[2] > 0 && b[0] < W && b[3] > 0 && b[1] < H && !overlaps(b)) {
            const [sx, sy] = toScreen(n.x, n.y);
            const off = n.r * view.k + 5;
            lab.setAttribute('x', (sx + off).toFixed(1));
            lab.setAttribute('y', (sy + fontPx * 0.36).toFixed(1));
            lab.setAttribute('font-size', String(fontPx));
            lab.classList.add('show');
            lab.classList.toggle('strong', strong);
            lab.classList.remove('dim');
            placed.push(b);
            return true;
        }
        lab.classList.remove('show', 'strong');
        return false;
    };
    for (const n of NODES)
        n.elLab.classList.remove('show', 'strong', 'dim');
    // 1) 강제표시(호버 집합) — 항상, 우선 배치.
    if (hoverSet)
        for (const n of NODES)
            if (hoverSet.has(n.name))
                placeLabel(n, n.name === hoverName);
    // 2) 검색 매치.
    if (query) {
        for (const n of NODES)
            if (n._match && !(hoverSet && hoverSet.has(n.name)))
                placeLabel(n, true);
    }
    // 3) 일반 — 줌 충분 시. 우선순위: solo 대상 > 차수 > 영역 큰 순.
    else if (view.k >= LABEL_K || soloCat) {
        const cand = NODES.filter((n) => !(hoverSet && hoverSet.has(n.name)) && (!soloCat || n.cat === soloCat));
        cand.sort((p, q) => (q.deg - p.deg) || (q.r - p.r) || (p.name < q.name ? -1 : 1));
        const cap = soloCat ? 9999 : 70; // 과도한 라벨 방지(컬링이 추가로 솎음)
        let shown = 0;
        for (const n of cand) {
            if (shown >= cap)
                break;
            if (placeLabel(n, false))
                shown++;
        }
    }
    // dim 상태 노드의 라벨은 가리기.
    for (const n of NODES)
        if (n.elNd.classList.contains('dim'))
            n.elLab.classList.remove('show', 'strong');
    const pct = document.getElementById('atlas-pct');
    if (pct)
        pct.textContent = Math.round(view.k * 100) + '%';
}
// ── 렌더 루프 ──
function ensureRunning() { if (!running) {
    running = true;
    requestAnimationFrame(loop);
} }
function loop() { force(); updateGeometry(); paint(); if (alpha > ALPHA_MIN)
    requestAnimationFrame(loop);
else
    running = false; }
function reheat(a = 0.45) { alpha = Math.max(alpha, a); ensureRunning(); }
// ── 그래티큘(좌표 격자) — 월드 공간 고정 격자. 5칸마다 굵은 선(major). 뷰 변환으로 팬·줌. ──
function buildGrid() {
    const E = 5200, S = 160;
    for (let i = -Math.round(E / S); i <= Math.round(E / S); i++) {
        const v = i * S, major = i % 5 === 0, cls = 'grid-l' + (major ? ' grid-major' : '');
        gGrid.append(sv('line', { class: cls, x1: v, y1: -E, x2: v, y2: E }));
        gGrid.append(sv('line', { class: cls, x1: -E, y1: v, x2: E, y2: v }));
    }
}
// ── 장면 구성(요소 1회 생성, 이후 속성만 갱신) ──
function buildScene() {
    svg = sv('svg', { xmlns: SVG_NS });
    gViewport = sv('g', { class: 'viewport' });
    gGrid = sv('g', { class: 'grid' });
    gHulls = sv('g', { class: 'hulls' });
    gLinks = sv('g', { class: 'links' });
    gNodes = sv('g', { class: 'nodes' });
    gViewport.append(gGrid, gHulls, gLinks, gNodes);
    buildGrid();
    const gOverlay = sv('g', { class: 'overlay' });
    gRegion = sv('g', { class: 'regions' });
    gNlab = sv('g', { class: 'nlabels' });
    gOverlay.append(gRegion, gNlab);
    svg.append(gViewport, gOverlay);
    for (const c of CATS) {
        c.elHalo = sv('path', { class: 'terr-halo', stroke: c.color, 'stroke-width': '13', opacity: '0.13' });
        c.elFill = sv('path', { class: 'terr-fill', fill: c.color, 'fill-opacity': '0.07', stroke: c.color, 'stroke-opacity': '0.5', 'stroke-width': '1.5' });
        c.elTerr = sv('g', { class: 'terr' });
        c.elTerr.append(c.elHalo, c.elFill);
        gHulls.append(c.elTerr);
        c.elName = sv('text', { class: 'rlab-name', 'text-anchor': 'middle', fill: c.color, text: c.name });
        c.elCount = sv('text', { class: 'rlab-count', 'text-anchor': 'middle', 'font-size': '11', text: String(c.nodes.length) });
        const rg = sv('g', { class: 'rlab' });
        rg.append(c.elName, c.elCount);
        gRegion.append(rg);
    }
    for (const l of LINKS) {
        l.elLine = sv('line', { class: 'lk' });
        gLinks.append(l.elLine);
    }
    for (const n of NODES) {
        n.elDot = sv('circle', { class: 'nd-dot', r: n.r.toFixed(1), fill: n.color });
        n.elNd = sv('g', { class: 'nd' });
        n.elNd.append(n.elDot);
        gNodes.append(n.elNd);
        n.elLab = sv('text', { class: 'nlab', text: n.title.length > 24 ? n.title.slice(0, 23) + '…' : n.title });
        gNlab.append(n.elLab);
        n.elNd.addEventListener('mouseenter', () => { if (!dragNode) {
            hoverName = n.name;
            paint();
        } });
        n.elNd.addEventListener('mouseleave', () => { if (hoverName === n.name && !dragNode) {
            hoverName = null;
            paint();
        } });
    }
    stage = el('div', { class: 'atlas-stage' }, svg);
    root.replaceChildren(stage, topBar(), legend(), zoomBox());
}
// ── 상단 바 ──
function topBar() {
    const input = el('input', { type: 'search', placeholder: '지식 검색…', 'aria-label': '지식 검색', autocomplete: 'off', spellcheck: 'false' });
    const clr = el('button', { class: 'clr', type: 'button', 'aria-label': '검색 지우기', text: '✕', style: 'display:none' });
    const run = (v) => {
        query = v.trim().toLowerCase();
        clr.style.display = query ? '' : 'none';
        for (const n of NODES)
            n._match = query ? (n.title.toLowerCase().includes(query) || n.name.toLowerCase().includes(query)) : false;
        paint(); // 제자리 강조(매 타자마다 화면 이동 안 함 — 산만함 방지). Enter 로 매치에 맞춤.
    };
    input.addEventListener('input', () => run(input.value));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const m = NODES.filter((n) => n._match);
            if (m.length) {
                const b = bbox(m.map((n) => ({ x: n.x, y: n.y, pad: 60 })));
                fitToBox(b.x0, b.y0, b.x1, b.y1, true);
            }
        }
    });
    clr.addEventListener('click', () => { input.value = ''; run(''); input.focus(); });
    window.__atlasSearch = input;
    return el('div', { class: 'atlas-top' }, el('div', { class: 'atlas-cartouche' }, el('div', { class: 'cart-eyebrow', text: 'LIVELY · CONTEXT' }), el('h1', { text: '지식 아틀라스' }), el('div', { class: 'cart-stat', text: NODES.length + ' 지식 · ' + CATS.length + ' 도메인' })), el('div', { class: 'atlas-spacer' }), el('div', { class: 'atlas-search' }, el('span', { class: 'mag', text: '🔎' }), input, clr), el('button', { class: 'atlas-btn', type: 'button', title: '이 창 닫기', onclick: () => window.close() }, el('span', { class: 'ic', text: '✕' }), '닫기'));
}
// ── 범례(좌하단, space 그룹) — 클릭=영역 단독 강조 토글. ──
function legend() {
    const box = el('div', { class: 'atlas-legend' }, el('h2', { text: '도메인' }));
    const bySpace = new Map();
    for (const c of CATS) {
        if (!bySpace.has(c.space))
            bySpace.set(c.space, []);
        bySpace.get(c.space).push(c);
    }
    for (const sp of SPACE_ORDER) {
        const list = bySpace.get(sp);
        if (!list)
            continue;
        const grp = el('div', { class: 'leg-space' }, el('div', { class: 'leg-space-h', text: SPACE_LABEL[sp] || sp }));
        for (const c of list) {
            const rowBtn = el('button', { class: 'leg-row', type: 'button', 'data-cat': c.key }, el('span', { class: 'leg-swatch', style: `background:${c.color};color:${c.color}` }), el('span', { class: 'leg-name', text: c.name }), el('span', { class: 'leg-count', text: String(c.nodes.length) }));
            rowBtn.addEventListener('click', () => {
                soloCat = soloCat === c.key ? null : c.key;
                for (const b of box.querySelectorAll('.leg-row')) {
                    b.classList.toggle('solo', b.dataset.cat === soloCat);
                    b.classList.toggle('off', !!soloCat && b.dataset.cat !== soloCat);
                }
                if (soloCat)
                    fitToBox(c.ax - rad(c.nodes.length) * 1.6, c.ay - rad(c.nodes.length) * 1.6, c.ax + rad(c.nodes.length) * 1.6, c.ay + rad(c.nodes.length) * 1.6, true);
                paint();
            });
            grp.append(rowBtn);
        }
        box.append(grp);
    }
    return box;
}
// ── 줌 컨트롤(우하단) ──
function zoomBox() {
    const pct = el('div', { class: 'zoom-pct', id: 'atlas-pct', text: '100%' });
    const cluster = el('div', { class: 'zoom-cluster' }, el('button', { type: 'button', 'aria-label': '확대', title: '확대', text: '+', onclick: () => zoomBy(1.25) }), el('button', { type: 'button', 'aria-label': '축소', title: '축소', text: '−', onclick: () => zoomBy(1 / 1.25) }), el('button', { class: 'zoom-fit', type: 'button', title: '전체 맞춤', text: '맞춤', onclick: () => fit(true) }));
    return el('div', { class: 'atlas-zoom' }, pct, cluster);
}
// ── 뷰 조작 ──
function zoomAt(sx, sy, factor) {
    const k2 = clamp(view.k * factor, K_MIN, K_MAX);
    view.tx = sx - (sx - view.tx) * (k2 / view.k);
    view.ty = sy - (sy - view.ty) * (k2 / view.k);
    view.k = k2;
    paint();
}
function zoomBy(factor) { zoomAt(root.clientWidth / 2, root.clientHeight / 2, factor); }
function bbox(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
        const pad = p.pad || 0;
        x0 = Math.min(x0, p.x - pad);
        y0 = Math.min(y0, p.y - pad);
        x1 = Math.max(x1, p.x + pad);
        y1 = Math.max(y1, p.y + pad);
    }
    return { x0, y0, x1, y1 };
}
function fitToBox(x0, y0, x1, y1, animate) {
    const W = root.clientWidth, H = root.clientHeight, m = 72;
    const k = clamp(Math.min((W - m * 2) / Math.max(1, x1 - x0), (H - m * 2) / Math.max(1, y1 - y0)), K_MIN, K_MAX);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const target = { k, tx: W / 2 - cx * k, ty: H / 2 - cy * k };
    if (animate && !reducedMotion())
        animateView(target);
    else {
        view.k = target.k;
        view.tx = target.tx;
        view.ty = target.ty;
        paint();
    }
}
function fit(animate) { const b = bbox(NODES.map((n) => ({ x: n.x, y: n.y, pad: n.r + 16 }))); fitToBox(b.x0, b.y0, b.x1, b.y1, animate); }
function fitInitial() { const b = bbox(CATS.map((c) => ({ x: c.ax, y: c.ay, pad: rad(c.nodes.length) + 56 }))); fitToBox(b.x0, b.y0, b.x1, b.y1, false); }
function animateView(target) {
    const s0 = { ...view }, t0 = performance.now(), dur = 420;
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const step = (now) => {
        const p = clamp((now - t0) / dur, 0, 1), e = ease(p);
        view.k = s0.k + (target.k - s0.k) * e;
        view.tx = s0.tx + (target.tx - s0.tx) * e;
        view.ty = s0.ty + (target.ty - s0.ty) * e;
        paint();
        if (p < 1)
            requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}
// ── 입력 배선(휠 줌·배경 팬·노드 드래그·클릭·키보드·리사이즈) ──
function wire() {
    stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = stage.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(1.0015, -e.deltaY));
    }, { passive: false });
    let mode = '', sx = 0, sy = 0, moved = 0, panTx = 0, panTy = 0, downNode = null;
    const findNode = (t) => { const g = t.closest && t.closest('.nd'); if (!g)
        return null; return NODES.find((n) => n.elNd === g) || null; };
    // 네이티브 드래그앤드롭(✕ no-drop 커서로 팬이 멈추던 버그) 차단.
    stage.addEventListener('dragstart', (e) => e.preventDefault());
    stage.addEventListener('pointerdown', (e) => {
        if (e.button !== 0)
            return;
        e.preventDefault(); // 네이티브 텍스트 선택·드래그 시작 억제 → 항상 팬으로
        const r = stage.getBoundingClientRect();
        sx = e.clientX - r.left;
        sy = e.clientY - r.top;
        moved = 0;
        downNode = findNode(e.target);
        if (downNode) {
            mode = 'node';
            dragNode = null;
        }
        else {
            mode = 'pan';
            panTx = view.tx;
            panTy = view.ty;
        }
        try {
            stage.setPointerCapture(e.pointerId);
        }
        catch (_) { /* 합성 이벤트 등 — 무시 */ }
        stage.classList.add('dragging');
    });
    stage.addEventListener('pointermove', (e) => {
        if (!mode)
            return;
        const r = stage.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
        moved += Math.abs(cx - sx) + Math.abs(cy - sy);
        if (mode === 'pan') {
            view.tx = panTx + (cx - sx);
            view.ty = panTy + (cy - sy);
            paint();
        }
        else if (mode === 'node') {
            if (!dragNode && moved > 4) {
                dragNode = downNode;
                hoverName = downNode.name;
            }
            if (dragNode) {
                dragNode.fx = (cx - view.tx) / view.k;
                dragNode.fy = (cy - view.ty) / view.k;
                reheat(0.4);
            }
        }
    });
    const end = (e) => {
        if (mode === 'node' && downNode && moved <= 4)
            openDetail(downNode.name); // 클릭(거의 안 움직임)
        if (dragNode) {
            dragNode.fx = undefined;
            dragNode.fy = undefined;
        }
        mode = '';
        dragNode = null;
        downNode = null;
        stage.classList.remove('dragging');
        try {
            stage.releasePointerCapture(e.pointerId);
        }
        catch (_) { /* noop */ }
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    window.addEventListener('keydown', (e) => {
        const inSearch = document.activeElement === window.__atlasSearch;
        if (e.key === '/' && !inSearch) {
            e.preventDefault();
            window.__atlasSearch.focus();
        }
        else if (e.key === 'Escape') {
            if (inSearch) {
                window.__atlasSearch.value = '';
                window.__atlasSearch.dispatchEvent(new Event('input'));
                window.__atlasSearch.blur();
            }
        }
        else if (!inSearch && (e.key === '+' || e.key === '=')) {
            e.preventDefault();
            zoomBy(1.25);
        }
        else if (!inSearch && (e.key === '-' || e.key === '_')) {
            e.preventDefault();
            zoomBy(1 / 1.25);
        }
        else if (!inSearch && e.key === '0') {
            e.preventDefault();
            fit(true);
        }
    });
    let rT = 0;
    window.addEventListener('resize', () => { clearTimeout(rT); rT = window.setTimeout(paint, 80); });
}
function openDetail(name) {
    // 새 탭에서 지식 상세를 연다 — 아틀라스 창은 그대로 유지. 안정적 탭 이름으로 재클릭 시 같은 탭을 갱신(탭이 쌓이지 않음).
    let url = '#/k/' + encodeURIComponent(name);
    try {
        url = new URL('.', location.href).href + url;
    }
    catch (_) { /* 상대경로 폴백 */ }
    const w = window.open(url, 'lively-knowledge');
    if (w)
        try {
            w.focus();
        }
        catch (_) { /* noop */ }
}
// ── 기하 유틸 ──
function convexHull(nodes) {
    const p = nodes.map((n) => ({ x: n.x, y: n.y })).sort((a, b) => a.x - b.x || a.y - b.y);
    if (p.length < 3)
        return p;
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const pt of p) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0)
            lower.pop();
        lower.push(pt);
    }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) {
        const pt = p[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0)
            upper.pop();
        upper.push(pt);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
}
function smoothClosed(pts) {
    const n = pts.length;
    if (n < 3)
        return null;
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} `;
    for (let i = 0; i < n; i++) {
        const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
        const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
        const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
        d += `C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} `;
    }
    return d + 'Z';
}
function circlePath(cx, cy, r) {
    return `M ${(cx - r).toFixed(1)} ${cy.toFixed(1)} a ${r.toFixed(1)} ${r.toFixed(1)} 0 1 0 ${(r * 2).toFixed(1)} 0 a ${r.toFixed(1)} ${r.toFixed(1)} 0 1 0 ${(-r * 2).toFixed(1)} 0 Z`;
}
// ── 상태 화면(인증·빈·오류) ──
function renderState(kind, e) {
    const card = el('div', { class: 'atlas-state-card' });
    if (kind === 'auth') {
        card.append(el('div', { class: 'ic', text: '🔒' }), el('h2', { text: '로그인이 필요합니다' }), el('p', { text: '원래 창(WIKI)에서 로그인한 뒤 다시 「지식 그래프」를 열어 주세요.' }), el('div', { class: 'row' }, el('button', { class: 'atlas-btn', type: 'button', text: '다시 시도', onclick: () => location.reload() }), el('button', { class: 'atlas-btn', type: 'button', text: '닫기', onclick: () => window.close() })));
    }
    else if (kind === 'empty') {
        card.append(el('div', { class: 'ic', text: '🗺️' }), el('h2', { text: '아직 그릴 지식이 없습니다' }), el('p', { text: 'WIKI에서 지식을 추가하면 도메인 영토로 이 지도에 나타납니다.' }), el('div', { class: 'row' }, el('button', { class: 'atlas-btn', type: 'button', text: '닫기', onclick: () => window.close() })));
    }
    else {
        card.append(el('div', { class: 'ic', text: '⚠️' }), el('h2', { text: '지도를 불러오지 못했습니다' }), el('p', { text: (e && e.message) || '알 수 없는 오류' }), el('div', { class: 'row' }, el('button', { class: 'atlas-btn', type: 'button', text: '다시 시도', onclick: () => location.reload() })));
    }
    root.replaceChildren(el('div', { class: 'atlas-state' }, card));
}

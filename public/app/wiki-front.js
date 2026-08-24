// wiki-front.ts — WIKI 첫 화면(#1841 안 4+5). "위키를 열면 카테고리 서랍이 아니라 **팀이 오늘 남긴 것**이 먼저 보인다."
//  결정(원준 2026-08-24): 최상단 분류를 카테고리에서 시간으로 바꾼다 — 첫 화면 = 전 카테고리 시간순 표(오늘·어제·이번 주…),
//   카테고리는 행의 칩과 「카테고리」 탭으로 물러난다. 내게 걸린 검토가 있을 때만 그 위에 [검토할 것] 묶음이 얹힌다(안 5 에서 취함).
//  왜: ① 위키가 살아 있음이 첫 화면에서 보인다(AI 가 세션에서 남긴 지식을 바로 검토·정정) ② 카테고리를 몰라도 시작된다
//   ③ 좌측 셸 사이드바 옆에 위키 사이드바가 또 서던 이중 내비를 걷어낸다.
//  표면은 프로젝트 표 문법(wiki-table) 그대로 — 머리 3층 · 같은 행 · 같은 크롬.
import { api, busy, el, errorNote, relTime, state, toast } from './core.js';
import { confirmDialog, skeletonRows } from './ui-primitives.js';
import { KN_TYPE_LABEL, SPACE_LABEL, isCategoryHomeDoc } from './wiki-data.js';
import { wkDayLabel, wkEmpty } from './wiki-ui.js';
import { wkBoardHeader, wkColHead, wkSurfaceTabs, wkTableGroup, wkTableRow, wkTbPill, wkTbPrimary, wkTbSearch } from './wiki-table.js';
import { openWikiPeek, setWikiPeekList } from './wiki-doc.js';
import { pjvPopover } from './projects/popover.js';
const SPACES = ['business', 'product', 'system'];
// ── 카테고리 목록(3 space) — 사이드바가 없어졌으니 이 화면이 직접 읽는다. 세션 캐시 1콜. ──
let catsCache = null;
export function knLoadCats(force) {
    if (force)
        catsCache = null;
    if (!catsCache) {
        catsCache = Promise.all(SPACES.map((sk) => api('/api/ui/categories?' + new URLSearchParams({ space: sk })).then((d) => (d && d.categories) || []).catch(() => [])))
            .then((lists) => {
            const bySpace = { business: [], product: [], system: [] };
            SPACES.forEach((sk, i) => { bySpace[sk] = lists[i]; });
            return bySpace;
        });
    }
    return catsCache;
}
export function knFindCatIn(bySpace, val) {
    const v = String(val || '');
    for (const sk of SPACES)
        for (const c of (bySpace[sk] || []))
            if (String(c.id) === v || c.key === v)
                return c;
    return null;
}
function myCatIds() {
    const ids = (state.me && state.me.team_category_ids) || [];
    return new Set(ids.map((x) => String(x)));
}
// ── 카테고리 칩 — 행에서 그 카테고리로 가는 링크. 스페이스마다 점 색만 다르다(§0.5 컬러 예산: 채운 배지 금지). ──
function catChip(e, bySpace) {
    const name = e.category_name || '';
    if (!name)
        return el('span', { class: 'pjv-fval wk-catchip wk-catchip-none', text: '미분류' });
    const cat = (e.category_id != null && knFindCatIn(bySpace, String(e.category_id))) || null;
    const sp = (cat && cat.space) || '';
    const a = el('a', { class: 'wk-catchip' + (sp ? ' sp-' + sp : ''), href: '#/knowledge?category=' + encodeURIComponent(cat ? cat.id : name), title: (SPACE_LABEL[sp] || '') + (sp ? ' · ' : '') + name }, el('i', { class: 'wk-catchip-dot', 'aria-hidden': 'true' }), el('span', { text: name }));
    a.onclick = (ev) => ev.stopPropagation();
    return a;
}
// ── 첫 화면(최근) 열: 카테고리 · 유형 · 작성 · 시각 ──
function recentCols(bySpace) {
    return [
        { key: 'cat', label: '카테고리', width: '176px', align: 'left', render: (e) => catChip(e, bySpace) },
        { key: 'type', label: '유형', width: '84px', render: (e) => el('span', { class: 'pjv-fval', text: e.type ? (KN_TYPE_LABEL[e.type] || e.type) : '' }) },
        { key: 'who', label: '작성', width: '72px', render: (e) => el('span', { class: 'pjv-fval wk-twho' + (e.confidence === 'human' ? ' human' : ''), text: e.confidence === 'human' ? '사람' : (e.provenance === 'observed' ? '미러' : 'AI') }) },
        { key: 'updated', label: '시각', width: '92px', render: (e) => el('span', { class: 'pjv-fval', title: e.updated_at || '', text: e.updated_at ? relTime(e.updated_at) : '' }) },
    ];
}
// 기간·작성 필터 — 툴바 드롭다운(알약). 값은 세션 상태(state.wiki.recent)에 남는다.
const PERIODS = [['', '전체 기간'], ['7d', '이번 주'], ['30d', '최근 30일'], ['today', '오늘']];
const AUTHORS = [['', '작성 전체'], ['human', '사람'], ['ai', 'AI'], ['observed', '외부 미러']];
function dropPill(label, opts, cur, onPick) {
    const cap = (opts.find(([k]) => k === cur) || opts[0])[1];
    return wkTbPill(cur ? cap : label, {
        active: !!cur, title: label,
        onClick: (b) => {
            const menu = el('div', { class: 'pjv-menu' });
            const close = pjvPopover(b, menu, { align: 'left' });
            for (const [k, lab] of opts) {
                const it = el('button', { class: 'pjv-menu-item' + (k === cur ? ' on' : ''), type: 'button' }, el('span', { text: lab }));
                it.onclick = () => { close(); onPick(k); };
                menu.append(it);
            }
        },
    });
}
function withinPeriod(iso, period) {
    if (!period || !iso)
        return true;
    const t = Date.parse(iso);
    if (!Number.isFinite(t))
        return true;
    if (period === 'today') {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return t >= d.getTime();
    }
    const days = period === '7d' ? 7 : 30;
    return t >= Date.now() - days * 86400000;
}
// ════════════════════════════════════════════
// 최근 — WIKI 첫 화면. [검토할 것](조건부) + 시간 묶음 표.
// ════════════════════════════════════════════
export async function renderRecentSurface(box, ctx) {
    const f = ctx.f;
    const r = f.recent = f.recent || { space: '', type: '', author: '', period: '' };
    busy(box, el('div', { class: 'wk-home wk-board-pad' }, skeletonRows(5)));
    const p = new URLSearchParams({ limit: '200', orderBy: 'updated_at', injection: 'recalled' });
    if (r.type)
        p.set('type', r.type);
    let entries = [];
    let bySpace = { business: [], product: [], system: [] };
    try {
        [entries, bySpace] = await Promise.all([
            api('/api/ui/knowledge?' + p).then((d) => ((d && d.entries) || []).filter((e) => !isCategoryHomeDoc(e.name))),
            knLoadCats(),
        ]);
    }
    catch (e) {
        box.replaceChildren(errorNote(e, '목록을 불러오지 못했습니다'));
        return;
    }
    // 스페이스 필터는 카테고리 id → space 로 접어 건다(서버 필터가 없다 — 목록은 이미 한 벌만 받는다).
    const spaceOf = (e) => { const c = e.category_id != null ? knFindCatIn(bySpace, String(e.category_id)) : null; return (c && c.space) || ''; };
    const shown = entries.filter((e) => (!r.space || spaceOf(e) === r.space)
        && (!r.author || (r.author === 'human' ? e.confidence === 'human' : r.author === 'observed' ? e.provenance === 'observed' : (e.confidence !== 'human' && e.provenance !== 'observed')))
        && withinPeriod(e.updated_at, r.period));
    const repaint = () => renderRecentSurface(box, ctx);
    const left = [
        wkTbPill('전체', { active: !r.space, title: '전 스페이스', onClick: () => { r.space = ''; repaint(); } }),
        ...SPACES.map((sk) => wkTbPill(SPACE_LABEL[sk], { active: r.space === sk, title: SPACE_LABEL[sk] + ' 스페이스만', onClick: () => { r.space = sk; repaint(); } })),
        el('span', { class: 'pjv-tb-sep', 'aria-hidden': 'true' }),
        dropPill('유형', [['', '유형 전체'], ...Object.entries(KN_TYPE_LABEL)], r.type, (v) => { r.type = v; repaint(); }),
        dropPill('작성', AUTHORS, r.author, (v) => { r.author = v; repaint(); }),
        dropPill('기간', PERIODS, r.period, (v) => { r.period = v; repaint(); }),
    ];
    const right = [
        wkTbSearch(f.q || '', '제목·본문 검색…', (q) => { if (q === (f.q || ''))
            return; f.q = q; ctx.syncHash(); ctx.repaint(); }),
        el('span', { class: 'pjv-tb-sep', 'aria-hidden': 'true' }),
        wkTbPrimary('새 페이지', () => { location.hash = '#/knowledge/new'; }),
    ];
    const today = entries.filter((e) => withinPeriod(e.updated_at, 'today')).length;
    const week = entries.filter((e) => withinPeriod(e.updated_at, '7d')).length;
    const header = wkBoardHeader({
        crumbs: [{ label: 'WIKI' }],
        sub: '이번 주 ' + week + '건 · 오늘 ' + today + '건 — 팀이 남긴 순서대로',
        tabs: wkSurfaceTabs('recent'), left, right,
    });
    const body = el('div', { class: 'wk-board-body' });
    const cols = recentCols(bySpace);
    const names = shown.map((e) => e.name);
    const open = (x, rowEl) => { setWikiPeekList(names); openWikiPeek(x.name, { onRefresh: ctx.repaint, originEl: rowEl }); };
    const reviewBox = el('div', {}); // 검토 묶음 — 있을 때만 채워진다(없으면 빈 div, 화면에 자국 없음)
    body.append(reviewBox);
    if (!shown.length) {
        body.append(wkEmpty(entries.length ? '이 조건에 해당하는 문서가 없어요.' : '아직 문서가 없어요 — [＋ 새 페이지]로 첫 지식을 남겨 보세요.'));
    }
    else {
        const byDay = [];
        for (const e of shown) {
            const day = wkDayLabel(e.updated_at);
            const last = byDay[byDay.length - 1];
            if (last && last[0] === day)
                last[1].push(e);
            else
                byDay.push([day, [e]]);
        }
        for (const [day, list] of byDay)
            body.append(wkTableGroup(day, list, { cols, open, titleLabel: '문서' }));
    }
    box.replaceChildren(el('div', { class: 'wk-home wk-board-pad' }, el('div', { class: 'card pjv-listboard wk-board' }, header, body)));
    void paintReviewLane(reviewBox, bySpace, ctx); // 뒤따라 채운다 — 검토 조회가 첫 화면을 붙잡지 않게
}
// ── [검토할 것](안 5) — 내 카테고리에 걸린 지식·수정 제안. 없으면 아예 안 그린다. ──
//  줄에서 바로 승인·반려한다(검토 대기 화면까지 안 들어가도 되게). 반려는 되돌리기 어려워 확인창을 거친다.
async function paintReviewLane(host, bySpace, ctx) {
    let pending = [], revs = [], mine = [];
    try {
        [pending, revs, mine] = await Promise.all([
            api('/api/ui/knowledge?lifecycle=pending&orderBy=updated_at&limit=50').then((d) => (d && d.entries) || []).catch(() => []),
            api('/api/ui/knowledge-revisions?status=pending&limit=50').then((d) => (d && d.entries) || []).catch(() => []),
            api('/api/ui/review-queue/summary').then((s) => (s && s.mine_category_keys) || []).catch(() => []),
        ]);
    }
    catch {
        return;
    }
    if (!host.isConnected)
        return;
    const mineSet = new Set(mine.map((x) => String(x)));
    const catKeyOf = (e) => { const c = e.category_id != null ? knFindCatIn(bySpace, String(e.category_id)) : null; return (c && c.key) || ''; };
    const all = [
        ...pending.map((k) => ({ kind: 'new', e: k, title: k.title || k.name, why: '새 지식 · ' + (k.confidence === 'human' ? '사람' : 'AI') + ' 가 남김' })),
        ...revs.map((v) => ({ kind: 'rev', e: { ...(v.knowledge || {}), name: v.name, title: v.title || v.name, category_name: v.category_name, category_id: v.category_id, type: v.type, updated_at: v.created_at || v.updated_at }, id: v.id, title: v.title || v.name, why: '수정 제안' })),
    ];
    const mineOnly = mineSet.size ? all.filter((it) => mineSet.has(catKeyOf(it.e))) : all;
    const items = (mineOnly.length ? mineOnly : []).slice(0, 5);
    if (!items.length)
        return;
    const cols = [
        { key: 'cat', label: '카테고리', width: '176px', align: 'left', render: (e) => catChip(e, bySpace) },
        { key: 'type', label: '유형', width: '84px', render: (e) => el('span', { class: 'pjv-fval', text: e.type ? (KN_TYPE_LABEL[e.type] || e.type) : '' }) },
        { key: 'updated', label: '올라온 때', width: '92px', render: (e) => el('span', { class: 'pjv-fval', text: e.updated_at ? relTime(e.updated_at) : '' }) },
        { key: 'act', label: '', width: '150px', render: (e) => e.__acts },
    ];
    const body = el('div', { class: 'pjv-tgroup-body wk-tbody' }, wkColHead(cols, '검토할 것'));
    for (const it of items) {
        const decide = async (ok) => {
            if (!ok) {
                const yes = await confirmDialog({ title: it.kind === 'new' ? '이 지식을 반려할까요?' : '이 수정 제안을 반려할까요?',
                    note: it.kind === 'new' ? '반려하면 이 지식은 휴지통으로 갑니다 — 휴지통에서 되살릴 수 있어요.' : '제안이 버려지고 문서는 지금 내용 그대로 남습니다.', danger: true, confirmText: '반려' });
                if (!yes)
                    return;
            }
            try {
                if (it.kind === 'new') {
                    if (ok)
                        await api('/api/ui/knowledge/' + encodeURIComponent(it.e.name) + '/lifecycle', { method: 'POST', body: JSON.stringify({ lifecycle: 'active' }) });
                    else
                        await api('/api/ui/knowledge/' + encodeURIComponent(it.e.name) + '/delete', { method: 'POST' });
                }
                else {
                    await api('/api/ui/knowledge-revisions/' + it.id + '/review', { method: 'POST', body: JSON.stringify({ decision: ok ? 'approve' : 'reject' }) });
                }
                toast(ok ? '반영했습니다' : '반려했습니다');
                ctx.repaint();
            }
            catch (e) {
                toast('처리하지 못했습니다 — ' + (e.message || ''));
            }
        };
        const acts = el('span', { class: 'wk-rv-acts' }, el('button', { class: 'wk-rv-btn ok', type: 'button', text: it.kind === 'new' ? '승인' : '반영', onclick: (ev) => { ev.stopPropagation(); void decide(true); } }), el('button', { class: 'wk-rv-btn no', type: 'button', text: '반려', onclick: (ev) => { ev.stopPropagation(); void decide(false); } }));
        body.append(wkTableRow({ ...it.e, __acts: acts }, {
            cols, deck: it.why,
            open: (x, rowEl) => openWikiPeek(x.name, { onRefresh: ctx.repaint, originEl: rowEl }),
            menu: () => [{ label: '검토 대기에서 자세히', fn: () => { location.hash = '#/knowledge/review'; } }],
        }));
    }
    const head = el('div', { class: 'pjv-tgroup-head wk-tgroup-head wk-rv-head' }, el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }), el('span', { class: 'pjv-tgroup-label', text: '검토할 것' }), el('span', { class: 'pjv-tgroup-count', text: String(mineOnly.length) }), el('span', { class: 'wk-rv-hint', text: mineSet.size ? '내 카테고리에 걸린 지식·수정 제안' : '승인해야 검색·주입에 반영됩니다' }), el('a', { class: 'wk-rv-all', href: '#/knowledge/review', text: '전체 ' + all.length + ' →' }));
    host.replaceChildren(el('div', { class: 'pjv-tgroup wk-tgroup wk-rv-group' }, head, body));
}
// ════════════════════════════════════════════
// 카테고리 탭 — 스페이스 그룹 + 카테고리 한 줄(문서 수 · 검토 대기 · 소유 팀 · 최근 갱신).
//  옛 첫 화면(오로라 카드 격자)을 대신한다 — 같은 정보를 표로, 더 정확히.
// ════════════════════════════════════════════
export async function renderCatsSurface(box, ctx) {
    busy(box, el('div', { class: 'wk-home wk-board-pad' }, skeletonRows(4)));
    let bySpace = { business: [], product: [], system: [] };
    let review = null;
    try {
        [bySpace, review] = await Promise.all([knLoadCats(), api('/api/ui/review-queue/summary').catch(() => null)]);
    }
    catch (e) {
        box.replaceChildren(errorNote(e, '카테고리를 불러오지 못했습니다'));
        return;
    }
    const byCat = new Map();
    for (const row of ((review && review.by_category) || []))
        if (row && row.key)
            byCat.set(String(row.key), Number(row.n) || 0);
    const mine = myCatIds();
    const header = wkBoardHeader({
        crumbs: [{ label: 'WIKI' }],
        sub: '분류축 — 어디에 무엇이 얼마나 쌓였나',
        tabs: wkSurfaceTabs('cats'),
        left: [wkTbPill('전체 ' + SPACES.reduce((n, sk) => n + ((bySpace[sk] || []).length), 0), { active: true, title: '등록된 카테고리 수' })],
        right: [
            wkTbSearch('', '카테고리 찾기…', (q) => { const t = q.trim(); for (const w of Array.from(box.querySelectorAll('.wk-trow-wrap'))) {
                const el2 = w;
                const nm = (el2.textContent || '');
                el2.hidden = !!t && !nm.toLowerCase().includes(t.toLowerCase());
            } }),
            el('span', { class: 'pjv-tb-sep', 'aria-hidden': 'true' }),
            wkTbPrimary('새 페이지', () => { location.hash = '#/knowledge/new'; }),
        ],
    });
    const body = el('div', { class: 'wk-board-body' });
    const track = 'minmax(var(--pjv-name-min, 260px), 1fr) 92px 104px 150px 100px 34px';
    const rowOf = (c) => {
        const n = Number(c.knowledge_count);
        const pend = byCat.get(String(c.key)) || 0;
        const row = el('a', { class: 'pjv-trow pjv-proj-row wk-trow wk-catrow', href: '#/knowledge?category=' + encodeURIComponent(c.id) }, el('div', { class: 'pjv-trow-title-cell' }, el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }), mine.has(String(c.id)) ? el('span', { class: 'kn-cat-star', title: '내 소유 카테고리', 'aria-hidden': 'true', text: '★' }) : null, el('span', { class: 'pjv-trow-title wk-ttitle', text: c.name || c.key }), c.hint ? el('span', { class: 'wk-tsnip', title: c.hint, text: c.hint }) : null), el('div', { class: 'pjv-tcell wk-tcell', 'data-col': 'n' }, el('span', { class: 'pjv-fval', text: Number.isFinite(n) ? String(n) : '—' })), el('div', { class: 'pjv-tcell wk-tcell', 'data-col': 'rv' }, pend ? el('span', { class: 'wk-rv-pill', title: '검토 대기 — 승인해야 검색·주입에 반영됩니다', text: String(pend) }) : el('span', { class: 'pjv-fval', text: '—' })), el('div', { class: 'pjv-tcell wk-tcell wk-col-left', 'data-col': 'own' }, el('span', { class: 'pjv-fval', text: c.owner_team_name || '—' })), el('div', { class: 'pjv-tcell wk-tcell', 'data-col': 'up' }, el('span', { class: 'pjv-fval', text: c.updated_at ? relTime(c.updated_at) : '' })), el('div', { class: 'pjv-tcell pjv-tcell-add' }, el('span', { class: 'wk-catrow-go', 'aria-hidden': 'true', text: '›' })));
        row.style.gridTemplateColumns = track;
        return el('div', { class: 'pjv-trow-wrap wk-trow-wrap' }, row);
    };
    let total = 0;
    for (const sk of SPACES) {
        const cats = (bySpace[sk] || []).slice().sort((a, b) => (Number(b.knowledge_count) || 0) - (Number(a.knowledge_count) || 0));
        if (!cats.length)
            continue;
        total += cats.length;
        const head = el('div', { class: 'pjv-tgroup-head wk-tgroup-head' }, el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }), el('span', { class: 'pjv-tgroup-label', text: SPACE_LABEL[sk] }), el('span', { class: 'pjv-tgroup-count', text: String(cats.length) }));
        const grpBody = el('div', { class: 'pjv-tgroup-body wk-tbody' }, el('div', { class: 'pjv-tgroup-head pjv-tgroup-head-cols pjv-list-colhead wk-colhead' }, el('div', { class: 'pjv-trow-title-cell' }, el('span', { class: 'pjv-list-colhead-name', text: '카테고리' })), ...[['n', '문서'], ['rv', '검토 대기'], ['own', '소유 팀'], ['up', '정의 갱신']].map(([k, label]) => el('div', { class: 'pjv-tcell pjv-colhead pjv-stdcol' + (k === 'own' ? ' wk-col-left' : ''), 'data-col': k }, el('span', { class: 'pjv-thcol-name', text: label }))), el('div', { class: 'pjv-tcell pjv-tcell-add' }, el('span', {}))), ...cats.map(rowOf));
        grpBody.firstChild.style.gridTemplateColumns = track;
        body.append(el('div', { class: 'pjv-tgroup wk-tgroup' }, head, grpBody));
    }
    if (!total)
        body.append(wkEmpty('아직 카테고리가 없어요 — [맥락 관리 ▸ 분류 ▸ 분류축]에서 만듭니다.'));
    box.replaceChildren(el('div', { class: 'wk-home wk-board-pad' }, el('div', { class: 'card pjv-listboard wk-board' }, header, body)));
}

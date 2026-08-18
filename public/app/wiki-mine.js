// wiki-mine.ts — #1685 '내 소유 카테고리' 대시보드. WIKI 맨 진입(상단 탭)과 사이드바 ★구역 헤더의 착지점.
//  "위키에 들어갔는데 뭐부터 눌러야 할지 막막하다"의 답 — 첫 화면이 카테고리 벽이 아니라 **내 일감의 최신 상태**다.
//
//  v4(사용자 선택): **한 화면 콕핏(마스터-디테일)** — 피드가 아니라 앱처럼 작동한다.
//  · 왼쪽 마스터 = 내 소유 카테고리 목록(아이콘·이름·이번 주 +n·문서 수). 클릭=선택, ↑↓=이동,
//    **끌어서 순서 변경**(홈 카드·사이드바 ★구역과 같은 키 kn_home_cat_order_v1 — 세 화면이 같은 순서).
//  · 마스터 맨 위 = **'전체 최신'**(섹터별보다 위 — 사용자 지정, 첫 방문 기본 선택): 위키 전체의 최근 변경.
//  · 오른쪽 디테일 = 선택 항목의 최근 문서(발췌 포함) — 카테고리면 오로라 헤더 밴드(이 화면의 유일한 장식).
//  · 두 패널은 화면 높이에 맞춰 서게 하고 각자 안에서 스크롤한다 — 스크롤 벽 없음. 선택은 기기에 기억.
//
//  내용 계약(불변): 현황 한 줄(카테고리·지식·이번 주 새 글) · '이어서' · 검색(⌘K)·＋ 새 페이지 ·
//  카테고리별 최근 문서(민트 틱·'새 글'·유형·시간, 행=피크) · 전체 보기/카테고리 선지정 새 페이지 ·
//  조직 어웨어니스('그 외 최근 변경'의 역할)는 '전체 최신' 뷰가 흡수했다.
//  데이터는 전부 경량(#1091 light — 본문 0바이트): knFetchCategoryIndex(세션 캐시, 사이드바 트리와 공유) +
//  목록 API light=1. 발췌는 body_md 가 아니라 summary(경량 행에 실려 온다)로 그린다.
import { api, el, relTime } from './core.js';
import { skeletonRows } from './learn.js';
import { KN_TYPE_LABEL, hasMemoryScope, isCategoryHomeDoc, knApplyCatReorder, knCatOrderClear, knCatOrderSaved, knFetchCategoryIndex, knSortByCatOrder } from './wiki-data.js';
import { wkAurora, wkEmpty, wkIsRead, wkResumeRow, wkRow, wkSection } from './wiki-ui.js';
import { openWikiPeek, openWikiSearch, setWikiPeekList } from './wiki-doc.js';
const DETAIL_DOCS = 10; // 디테일 패널 문서 행(카테고리)
const ALL_DOCS = 20; // '전체 최신' 문서 행
const ALL_ID = '__all__'; // 마스터 맨 위 '전체 최신' 항목(섹터별보다 위 — 사용자 지정)
const NEW_WINDOW_MS = 7 * 86400000; // '새 글' 판정 — 생성 7일 이내
const WK_MINE_SEL = 'wk_mine_sel_v1'; // 마지막으로 보던 카테고리(기기 로컬) — 돌아오면 그 자리부터
// 이번 주 새로 만들어진 문서인가 — 수정만 된 옛 문서에 '새 글'을 붙이면 거짓말이라 created_at 기준.
function wkIsFresh(e) {
    const t = Date.parse(e.created_at || '');
    return Number.isFinite(t) && Date.now() - t <= NEW_WINDOW_MS;
}
// 패널에 앉힐 문서만 — 폴더·대문·(index 는 원래 active,pending 만 오지만 방어로) archived 제외, 최신순.
function laneDocsOf(rows) {
    return rows.filter((r) => !r.is_folder && !isCategoryHomeDoc(r.name) && r.lifecycle !== 'archived')
        .slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}
async function renderMineSurface(box, ctx) {
    const owned = ctx.ownedCatIds ? ctx.ownedCatIds() : new Set();
    const bySpace = ctx.bySpace ? ctx.bySpace() : { business: [], product: [], system: [] };
    const allOwned = ['business', 'product', 'system'].flatMap((sk) => bySpace[sk] || [])
        .filter((c) => owned.has(String(c.id)));
    const refresh = () => ctx.repaint();
    // ── 딥링크로 왔는데 내 소유가 없다 — 사실 + 다음 행동(★ 토글)만. ──
    if (!allOwned.length) {
        const mine0 = el('div', { class: 'wk-mc' });
        const sec = wkSection('★ 내 소유 카테고리');
        sec.body.append(wkEmpty('아직 내 소유 카테고리가 없습니다. 사이드바에서 카테고리에 ★를 켜면 이 화면에 모입니다.', el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '카테고리 훑어보기',
            onclick: () => ctx.selectCategory('') })));
        mine0.append(sec.el);
        box.replaceChildren(mine0);
        return;
    }
    const mine = el('div', { class: 'wk-mc' });
    const orderedCats = () => knSortByCatOrder(allOwned);
    const catById = new Map(allOwned.map((c) => [String(c.id), c]));
    const letterOf = (c) => (Array.from(String(c.name || c.key || '?').trim())[0] || '?').toUpperCase();
    // ── 데이터 — 모든 소유 카테고리의 경량 인덱스를 병렬 선적재(마스터 배지·즉시 전환의 근거). ──
    const docsOf = new Map(); // catId → 최신순 문서
    const iconOf = new Map(); // catId → 대문 아이콘
    const freshOf = new Map(); // catId → 이번 주 새 문서 수
    const failed = new Set(); // 못 불러온 카테고리
    const catNameOf = new Map(); // 문서 name → 소유 카테고리 이름('전체 최신' 행의 출처 표기)
    let globalDocs = null; // '전체 최신' — 위키 전체 최신 변경(경량)
    let globalFail = false;
    let freshTotal = 0;
    // ── 헤더 — 이름 + mono 현황 + 검색(⌘K)·새 페이지(primary 1개). ──
    const totalDocs = allOwned.reduce((n, c) => n + (Number(c.knowledge_count) || 0), 0);
    const freshStat = el('span', { class: 'wk-row-m wk-m-new' });
    const searchBtn = el('button', { class: 'wk-mc-search', type: 'button', title: '전체 지식 의미검색 (⌘K)' }, el('span', { 'aria-hidden': 'true', text: '🔍' }), el('span', { text: '검색' }), el('span', { class: 'wk-hero-kbd', text: '⌘K' }));
    searchBtn.onclick = () => openWikiSearch();
    mine.append(el('div', { class: 'wk-mc-head' }, el('h1', { class: 'wk-mc-title', text: '★ 내 소유 카테고리' }), el('span', { class: 'wk-mc-stats' }, el('span', { class: 'wk-row-m', text: '카테고리 ' + allOwned.length }), el('span', { class: 'wk-row-m', text: '지식 ' + totalDocs }), freshStat), el('span', { class: 'wk-mc-sp' }), searchBtn, hasMemoryScope() ? el('a', { class: 'btn btn-primary wk-mc-new', href: '#/knowledge/new',
        title: '새 페이지 — 제목을 쓰면 바로 저장됩니다', text: '＋ 새 페이지' }) : null));
    const resume = wkResumeRow();
    if (resume)
        mine.append(resume);
    // ── 분할 골격 — 마스터(선택·정렬) + 디테일(읽기). ──
    const mlist = el('div', { class: 'wk-mc-mlist', role: 'listbox', 'aria-label': '내 소유 카테고리' });
    const mfoot = el('div', { class: 'wk-mc-mfoot' });
    const master = el('aside', { class: 'wk-mc-master' }, mlist, mfoot);
    const dhead = el('div', { class: 'wk-mc-dhead' });
    const dbody = el('div', { class: 'wk-mc-body' });
    const detail = el('section', { class: 'wk-mc-detail' }, dhead, el('div', { class: 'wk-mc-scroll' }, dbody));
    const split = el('div', { class: 'wk-mc-split' }, master, detail);
    mine.append(split);
    // 선택 상태 — 마지막으로 보던 카테고리를 기억(소유에서 빠졌으면 첫 번째로).
    let selId = '';
    try {
        selId = localStorage.getItem(WK_MINE_SEL) || '';
    }
    catch (_) { /* noop */ }
    if (selId !== ALL_ID && !catById.has(selId))
        selId = ALL_ID; // 첫 방문 기본 = 전체 최신
    function select(id) {
        if (id !== ALL_ID && !catById.has(id))
            return;
        selId = id;
        try {
            localStorage.setItem(WK_MINE_SEL, id);
        }
        catch (_) { /* noop */ }
        paintMaster();
        paintDetail();
    }
    // ── 마스터 — 행 = 선택 단위이자 드래그 순서 단위. ──
    let dragId = null;
    function paintMaster() {
        const cats = orderedCats();
        const allRow = el('button', { class: 'wk-mc-mrow wk-mc-mall', type: 'button', role: 'option',
            'aria-selected': String(selId === ALL_ID),
            title: '위키 전체의 최근 변경을 오른쪽에 보여줍니다' }, el('span', { class: 'wk-mc-mic', 'aria-hidden': 'true', text: '∗' }), el('span', { class: 'wk-mc-mname', text: '전체 최신' }), el('span', { class: 'wk-mc-mmeta' }, freshTotal ? el('span', { class: 'wk-row-m wk-m-new', text: '+' + freshTotal }) : null));
        allRow.addEventListener('click', () => select(ALL_ID));
        allRow.addEventListener('keydown', (ev) => {
            if (ev.key !== 'ArrowDown')
                return;
            ev.preventDefault();
            const first = orderedCats()[0];
            if (!first)
                return;
            select(String(first.id));
            const n = mlist.querySelector('[data-cat-id="' + String(first.id) + '"]');
            if (n)
                n.focus();
        });
        const rows = cats.map((c) => {
            const id = String(c.id);
            const icon = iconOf.get(id) || '';
            const freshN = freshOf.get(id) || 0;
            const docsN = docsOf.has(id) ? docsOf.get(id).length : Number(c.knowledge_count);
            const row = el('button', { class: 'wk-mc-mrow', type: 'button', role: 'option',
                'aria-selected': String(id === selId), 'data-cat-id': id, draggable: 'true',
                title: (c.name || c.key) + ' — 최근 문서를 오른쪽에 보여줍니다. 끌면 순서가 바뀝니다.' }, icon ? el('span', { class: 'wk-mc-mic', 'aria-hidden': 'true', text: icon })
                : el('span', { class: 'wk-mc-mic letter', 'aria-hidden': 'true', text: letterOf(c) }), el('span', { class: 'wk-mc-mname', text: c.name || c.key }), el('span', { class: 'wk-mc-mmeta' }, freshN ? el('span', { class: 'wk-row-m wk-m-new', text: '+' + freshN }) : null, Number.isFinite(docsN) ? el('span', { class: 'wk-row-m', text: String(docsN) }) : null));
            row.addEventListener('click', () => select(id));
            row.addEventListener('keydown', (ev) => {
                if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp')
                    return;
                ev.preventDefault();
                const ids = orderedCats().map((x) => String(x.id));
                const ni = ids.indexOf(id) + (ev.key === 'ArrowDown' ? 1 : -1);
                if (ni < 0) {
                    select(ALL_ID);
                    const a = mlist.querySelector('.wk-mc-mall');
                    if (a)
                        a.focus();
                    return;
                }
                const next = ids[ni];
                if (!next)
                    return;
                select(next);
                const n = mlist.querySelector('[data-cat-id="' + next + '"]');
                if (n)
                    n.focus();
            });
            // 드래그 정렬(세로) — 홈 카드와 같은 저장·같은 표식(삽입선).
            row.addEventListener('dragstart', (ev) => {
                dragId = id;
                row.classList.add('drag-src');
                try {
                    ev.dataTransfer.effectAllowed = 'move';
                    ev.dataTransfer.setData('text/plain', id);
                }
                catch (_) { /* noop */ }
            });
            row.addEventListener('dragend', () => { dragId = null; mlist.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after')); });
            row.addEventListener('dragover', (ev) => {
                if (!dragId || dragId === id)
                    return;
                ev.preventDefault();
                const r = row.getBoundingClientRect();
                const before = ev.clientY < r.top + r.height / 2;
                row.classList.toggle('drop-before', before);
                row.classList.toggle('drop-after', !before);
            });
            row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
            row.addEventListener('drop', (ev) => {
                if (!dragId || dragId === id)
                    return;
                ev.preventDefault();
                const before = row.classList.contains('drop-before');
                if (knApplyCatReorder(allOwned, dragId, id, before)) {
                    paintMaster();
                    if (ctx.onCatChanged)
                        ctx.onCatChanged(); // 사이드바 ★구역 순서도 즉시 맞춘다
                }
                dragId = null;
            });
            return row;
        });
        mlist.replaceChildren(allRow, el('div', { class: 'wk-mc-mdiv', 'aria-hidden': 'true' }), ...rows);
        mfoot.replaceChildren(knCatOrderSaved().length
            ? el('button', { class: 'wk-sec-act', type: 'button', title: '끌어서 바꾼 카테고리 순서를 기본으로 되돌립니다', text: '↺ 순서 초기화',
                onclick: () => { knCatOrderClear(); paintMaster(); if (ctx.onCatChanged)
                    ctx.onCatChanged(); } })
            : el('span', { class: 'wk-sec-hint', text: '드래그해서 순서 변경' }));
    }
    // ── 디테일 — 선택 카테고리의 헤더 밴드(오로라 = 이 화면의 유일한 장식) + 최근 문서. ──
    function paintDetail() {
        if (selId === ALL_ID) {
            paintAllDetail();
            return;
        }
        const c = catById.get(selId);
        if (!c)
            return;
        const id = String(c.id);
        const icon = iconOf.get(id) || '';
        const docs = docsOf.get(id);
        const go = () => ctx.selectCategory(id);
        const cover = wkAurora(String(c.key || c.id), c.space, { cls: 'wk-mc-dcover', watermark: icon || letterOf(c) });
        const name = el('a', { class: 'wk-mc-dname', href: '#/knowledge?category=' + encodeURIComponent(id),
            title: (c.name || c.key) + ' — 카테고리 페이지로 이동합니다', text: c.name || c.key });
        name.addEventListener('click', (ev) => { ev.preventDefault(); go(); });
        const latest = docs && docs[0] && docs[0].updated_at ? relTime(docs[0].updated_at) : '';
        dhead.replaceChildren(cover, el('div', { class: 'wk-mc-dbar' }, el('span', { class: 'wk-mc-dic' + (icon ? '' : ' letter'), 'aria-hidden': 'true', text: icon || letterOf(c) }), el('span', { class: 'wk-mc-dmain' }, name, el('span', { class: 'wk-mc-dmeta' }, docs ? el('span', { class: 'wk-row-m', text: '지식 ' + docs.length }) : null, latest ? el('span', { class: 'wk-row-m', text: '최근 ' + latest }) : null, (freshOf.get(id) || 0) ? el('span', { class: 'wk-row-m wk-m-new', text: '이번 주 +' + freshOf.get(id) }) : null)), el('span', { class: 'wk-mc-dacts' }, el('button', { class: 'wk-sec-act', type: 'button', text: '전체 보기 →', onclick: go }), hasMemoryScope() && c.key ? el('a', { class: 'wk-sec-act', href: '#/knowledge/new?category=' + encodeURIComponent(c.key),
            title: '이 카테고리에 새 페이지를 만듭니다', text: '＋ 새 페이지' }) : null)));
        if (!docs) {
            dbody.replaceChildren(...(failed.has(id) ? [wkEmpty('불러오지 못했습니다.')] : [skeletonRows(4)]));
            return;
        }
        if (!docs.length) {
            dbody.replaceChildren(wkEmpty('아직 지식이 없습니다.', hasMemoryScope() && c.key ? el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge/new?category=' + encodeURIComponent(c.key), text: '＋ 첫 페이지' }) : null));
            return;
        }
        const show = docs.slice(0, DETAIL_DOCS);
        const names = show.map((r) => r.name);
        const open = (e, rowEl) => { setWikiPeekList(names); openWikiPeek(e.name, { onRefresh: refresh, originEl: rowEl }); };
        dbody.replaceChildren(...show.map((r) => wkRow(r, {
            open,
            deck: r.summary || '', // 발췌 = 사람용 한 줄 요지(경량 행에 실려 온다 — 본문 다운로드 0)
            metas: [
                wkIsFresh(r) && !wkIsRead(r.name) ? el('span', { class: 'wk-row-m wk-m-new', text: '새 글' }) : null,
                r.lifecycle === 'pending' ? '검토 대기' : null,
                r.type ? (KN_TYPE_LABEL[r.type] || r.type) : null,
                r.updated_at ? relTime(r.updated_at) : null,
            ].filter(Boolean),
        })), docs.length > DETAIL_DOCS ? el('div', { class: 'wk-mc-more' }, el('button', { class: 'wk-sec-act', type: 'button', text: '… ' + (docs.length - DETAIL_DOCS) + '개 더 — 전체 보기 →', onclick: go })) : null);
    }
    // '전체 최신' 뷰 — 위키 전체의 최근 변경(내 소유 포함). 소유 문서엔 출처 카테고리 이름을 메타로 단다.
    function paintAllDetail() {
        dhead.replaceChildren(el('div', { class: 'wk-mc-dbar plain' }, el('span', { class: 'wk-mc-dic letter', 'aria-hidden': 'true', text: '∗' }), el('span', { class: 'wk-mc-dmain' }, el('span', { class: 'wk-mc-dname', text: '전체 최신' }), el('span', { class: 'wk-mc-dmeta' }, el('span', { class: 'wk-row-m', text: '위키 전체의 최근 변경입니다.' }), freshTotal ? el('span', { class: 'wk-row-m wk-m-new', text: '이번 주 +' + freshTotal }) : null)), el('span', { class: 'wk-mc-dacts' }, el('a', { class: 'wk-sec-act', href: '#/knowledge?all=1', text: '전체 지식 →' }))));
        if (!globalDocs) {
            dbody.replaceChildren(...(globalFail ? [wkEmpty('불러오지 못했습니다.')] : [skeletonRows(5)]));
            return;
        }
        if (!globalDocs.length) {
            dbody.replaceChildren(wkEmpty('아직 지식이 없어요. 첫 페이지로 시작해 보세요.', hasMemoryScope() ? el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge/new', text: '＋ 첫 페이지' }) : null));
            return;
        }
        const show = globalDocs.slice(0, ALL_DOCS);
        const names = show.map((r) => r.name);
        const open = (e, rowEl) => { setWikiPeekList(names); openWikiPeek(e.name, { onRefresh: refresh, originEl: rowEl }); };
        dbody.replaceChildren(...show.map((r) => wkRow(r, {
            open,
            deck: r.summary || '',
            metas: [
                wkIsFresh(r) && !wkIsRead(r.name) ? el('span', { class: 'wk-row-m wk-m-new', text: '새 글' }) : null,
                catNameOf.get(r.name) || null,
                r.type ? (KN_TYPE_LABEL[r.type] || r.type) : null,
                r.updated_at ? relTime(r.updated_at) : null,
            ].filter(Boolean),
        })), globalDocs.length > ALL_DOCS ? el('div', { class: 'wk-mc-more' }, el('a', { class: 'wk-sec-act', href: '#/knowledge?all=1', text: '… 더 보기 — 전체 지식 →' })) : null);
    }
    // ── 선적재 — 카테고리별 경량 인덱스(세션 캐시). 도착하는 대로 마스터 배지·현재 디테일을 갱신. ──
    for (const c of allOwned)
        knFetchCategoryIndex(c.id).then((rows) => {
            const id = String(c.id);
            const docs = laneDocsOf(rows);
            docsOf.set(id, docs);
            for (const r of docs)
                catNameOf.set(r.name, c.name || c.key);
            const homeDoc = rows.find((r) => isCategoryHomeDoc(r.name));
            if (homeDoc && homeDoc.icon)
                iconOf.set(id, homeDoc.icon);
            const freshN = docs.filter(wkIsFresh).length;
            if (freshN) {
                freshOf.set(id, freshN);
                freshTotal += freshN;
                freshStat.textContent = '이번 주 새 글 ' + freshTotal;
            }
            if (!mine.isConnected)
                return;
            paintMaster();
            if (id === selId || selId === ALL_ID)
                paintDetail(); // 전체 최신 뷰의 출처 라벨·배지도 도착분을 반영
        }).catch(() => {
            failed.add(String(c.id));
            if (mine.isConnected && String(c.id) === selId)
                paintDetail();
        });
    // ── '전체 최신' 데이터 — 위키 전체의 최근 변경(경량 40건). 도착하면 그 뷰를 갱신한다. ──
    api('/api/ui/knowledge?' + new URLSearchParams({
        limit: '40', orderBy: 'updated_at', injection: 'recalled', light: '1'
    }))
        .then((r) => {
        globalDocs = ((r && r.entries) || []).filter((e) => !e.is_folder && !isCategoryHomeDoc(e.name));
        if (mine.isConnected && selId === ALL_ID)
            paintDetail();
    })
        .catch(() => { globalFail = true; if (mine.isConnected && selId === ALL_ID)
        paintDetail(); });
    // ── 화면 높이에 맞추기 — 분할 패널이 뷰포트를 채우고 각자 스크롤한다(모바일은 자연 흐름). ──
    function fit() {
        if (!split.isConnected)
            return;
        if (matchMedia('(max-width: 900px)').matches) {
            split.style.height = '';
            return;
        }
        const top = split.getBoundingClientRect().top;
        split.style.height = Math.max(420, window.innerHeight - top - 26) + 'px';
    }
    const onResize = () => { if (!split.isConnected) {
        window.removeEventListener('resize', onResize);
        return;
    } fit(); };
    window.addEventListener('resize', onResize);
    paintMaster();
    paintDetail();
    box.replaceChildren(mine);
    requestAnimationFrame(fit);
}
export { renderMineSurface };

// wiki-home.ts — #764 위키 홈. 콘텐츠 영역의 일은 내비가 아니라 orientation — 카테고리 카드 그리드(사이드바와
//  중복) 폐지. 위→아래: 이어서(기기 로컬 최근 열람) → 시작하기(인덱스 핀 = 조직의 필독 목차) →
//  카테고리 지도(space 그룹 텍스트 행 — 이름·설명·mono 건수/갱신, 아이콘·갱신은 세션 캐시로 점진 보강) →
//  최근 변경(날짜 그룹). '내 소유' 뱃지 반복 금지 — 예외(다른 팀 소유)만 표기.
import { api, el, errorNote, relTime, state } from './core.js';
import { skeletonRows } from './learn.js';
import { KN_TYPE_LABEL, hasMemoryScope, isCategoryHomeDoc, knFetchCategoryRows } from './wiki-data.js';
import { wkDayLabel, wkEmpty, wkReadVisits, wkRow, wkSection } from './wiki-ui.js';
import { openWikiPeek, setWikiPeekList } from './wiki-doc.js';
const SPACE_KO = { business: '사업', product: '제품', system: '시스템' };
const HOME_PIN_CAP = 12;
const HOME_DAY_CAP = 8;
async function renderHomeSurface(box, ctx) {
    box.replaceChildren(el('div', { class: 'wk-home' }, skeletonRows(4)));
    let pinned = [];
    let recent = [];
    try {
        [pinned, recent] = await Promise.all([
            api('/api/ui/knowledge?' + new URLSearchParams({ is_wiki: 'true', limit: '50', orderBy: 'updated_at', injection: 'recalled' }))
                .then((r) => ((r && r.entries) || []).filter((e) => !isCategoryHomeDoc(e.name))).catch(() => []),
            api('/api/ui/knowledge?' + new URLSearchParams({ limit: '40', orderBy: 'updated_at', injection: 'recalled' }))
                .then((r) => ((r && r.entries) || []).filter((e) => !isCategoryHomeDoc(e.name))),
        ]);
    }
    catch (e) {
        box.replaceChildren(errorNote(e, '위키를 불러오지 못했습니다'));
        return;
    }
    const home = el('div', { class: 'wk-home' });
    const refresh = () => ctx.repaint();
    const openFrom = (names) => (e, rowEl) => {
        setWikiPeekList(names);
        openWikiPeek(e.name, { onRefresh: refresh, originEl: rowEl });
    };
    // ── 이어서 — 내가 마지막으로 열었던 문서(기기 로컬). 조용한 인라인 줄. ──
    const visits = wkReadVisits().slice(0, 3);
    if (visits.length) {
        const row = el('div', { class: 'wk-resume' }, el('span', { class: 'wk-resume-label', text: '이어서' }));
        for (const v of visits) {
            row.append(el('a', { class: 'wk-resume-it', href: '#/k/' + encodeURIComponent(v.name), title: v.title }, v.icon ? el('span', { class: 'wk-resume-ic', 'aria-hidden': 'true', text: v.icon }) : null, el('span', { text: v.title })));
        }
        home.append(row);
    }
    // ── 시작하기 — 인덱스 핀(is_wiki). 신규 입사자의 첫 목차. 핀 0이면 섹션 자체 생략. ──
    if (pinned.length) {
        const show = pinned.slice(0, HOME_PIN_CAP);
        const names = show.map((e) => e.name);
        const sec = wkSection('시작하기', {
            count: pinned.length,
            hint: '인덱스에 핀된 문서 — 매 대화 첫머리에 항상 깔립니다',
        });
        for (const e of show) {
            sec.body.append(wkRow(e, { open: openFrom(names), metas: [e.type ? (KN_TYPE_LABEL[e.type] || e.type) : null, relTime(e.updated_at)] }));
        }
        if (pinned.length > HOME_PIN_CAP) {
            sec.body.append(el('button', { class: 'wk-more-note', type: 'button', text: '＋' + (pinned.length - HOME_PIN_CAP) + '개 더 — 인덱스 전체 보기',
                onclick: () => ctx.selectCategory('__indexed__') }));
        }
        home.append(sec.el);
    }
    // ── 카테고리 지도 — space 그룹의 텍스트 행. 클릭 = 그 카테고리 페이지(대문). ──
    const bySpace = ctx.bySpace ? ctx.bySpace() : { business: [], product: [], system: [] };
    const allCats = ['business', 'product', 'system'].flatMap((sk) => (bySpace[sk] || []));
    const myIds = new Set(((state.me && state.me.team_category_ids) || []).map((x) => String(x)));
    const catRowEls = new Map(); // cat.id → { icEl, metaEl } — 점진 보강 대상
    if (allCats.length) {
        const sec = wkSection('카테고리', { count: allCats.length });
        for (const sk of ['business', 'product', 'system']) {
            const cats = bySpace[sk] || [];
            if (!cats.length)
                continue;
            sec.body.append(el('div', { class: 'wk-space-label', text: SPACE_KO[sk] || sk }));
            for (const c of cats) {
                const icEl = el('span', { class: 'wk-catrow-ic letter', 'aria-hidden': 'true', text: String(c.name || c.key || '?').trim().charAt(0).toUpperCase() });
                const cnt = Number(c.knowledge_count);
                const otherTeam = c.owner_team_name && !myIds.has(String(c.id)) ? c.owner_team_name : '';
                const metaEl = el('span', { class: 'wk-row-meta' }, otherTeam ? el('span', { class: 'wk-row-m wk-otherteam', title: '담당 팀', text: otherTeam }) : null, Number.isFinite(cnt) ? el('span', { class: 'wk-row-m', text: cnt + '개' }) : null, el('span', { class: 'wk-row-m wk-catrow-time' }));
                const row = el('div', { class: 'wk-catrow', role: 'link', tabindex: '0' }, icEl, el('span', { class: 'wk-catrow-main' }, el('span', { class: 'wk-catrow-name', text: c.name || c.key }), c.description ? el('span', { class: 'wk-catrow-desc', text: c.description }) : null), metaEl);
                const go = () => ctx.selectCategory(String(c.id));
                row.addEventListener('click', go);
                row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter')
                    go(); });
                catRowEls.set(String(c.id), { icEl, timeEl: metaEl.querySelector('.wk-catrow-time') });
                sec.body.append(row);
            }
        }
        home.append(sec.el);
    }
    // ── 최근 변경 — 날짜 그룹, 하루 8행 캡. 카테고리명은 세션 캐시가 채워지면 점진 표기. ──
    const recentSec = wkSection('최근 변경', {
        actions: [
            hasMemoryScope() ? el('a', { class: 'btn btn-primary btn-sm', href: '#/knowledge/new',
                title: '새 페이지를 씁니다 — 제목을 쓰면 바로 저장', text: '＋ 새 페이지' }) : null,
            el('a', { class: 'wk-sec-act', href: '#/knowledge?all=1', text: '전체 지식 →' }),
        ],
    });
    const recentNames = recent.map((e) => e.name);
    const recentCatEls = new Map(); // name → 카테고리명 슬롯(점진 보강)
    if (!recent.length) {
        recentSec.body.append(wkEmpty('아직 지식이 없어요. 첫 페이지로 시작해 보세요.', hasMemoryScope() ? el('a', { class: 'btn btn-ghost btn-sm', href: '#/knowledge/new', text: '＋ 첫 페이지' }) : null));
    }
    else {
        let curDay = '';
        let dayCount = 0;
        let hiddenInDay = 0;
        for (const e of recent) {
            const day = wkDayLabel(e.updated_at);
            if (day !== curDay) {
                if (hiddenInDay > 0)
                    recentSec.body.append(el('div', { class: 'wk-day-more', text: '… ' + hiddenInDay + '개 더' }));
                curDay = day;
                dayCount = 0;
                hiddenInDay = 0;
                recentSec.body.append(el('div', { class: 'wk-day-label', text: day }));
            }
            if (dayCount >= HOME_DAY_CAP) {
                hiddenInDay++;
                continue;
            }
            dayCount++;
            const catSlot = el('span', { class: 'wk-row-m wk-row-cat' });
            recentCatEls.set(e.name, catSlot);
            recentSec.body.append(wkRow(e, {
                open: openFrom(recentNames),
                metas: [e.type ? (KN_TYPE_LABEL[e.type] || e.type) : null, catSlot, relTime(e.updated_at)],
            }));
        }
        if (hiddenInDay > 0)
            recentSec.body.append(el('div', { class: 'wk-day-more', text: '… ' + hiddenInDay + '개 더' }));
    }
    home.append(recentSec.el);
    box.replaceChildren(home);
    // ── 점진 보강 — 카테고리별 rows(세션 캐시, 사이드바 펼침과 공유)가 도착하는 대로:
    //  ① 카테고리 행의 아이콘(대문 문서 props_ui.icon)·마지막 갱신 ② 최근 변경 행의 카테고리명.
    for (const c of allCats) {
        knFetchCategoryRows(c.id).then((rows) => {
            const slot = catRowEls.get(String(c.id));
            if (slot && slot.icEl.isConnected) {
                const homeDoc = rows.find((r) => isCategoryHomeDoc(r.name));
                if (homeDoc && homeDoc.icon) {
                    slot.icEl.textContent = homeDoc.icon;
                    slot.icEl.classList.remove('letter');
                }
                const latest = rows.filter((r) => !isCategoryHomeDoc(r.name))
                    .reduce((m, r) => (String(r.updated_at || '') > m ? String(r.updated_at) : m), '');
                if (latest && slot.timeEl)
                    slot.timeEl.textContent = relTime(latest);
            }
            for (const r of rows) {
                const catSlot = recentCatEls.get(r.name);
                if (catSlot && catSlot.isConnected && !catSlot.textContent)
                    catSlot.textContent = c.name || c.key;
            }
        }).catch(() => { });
    }
}
export { renderHomeSurface };

// dashboard.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { ACTIVITY_TYPE_LABEL, ACTIVITY_TYPE_ORDER, interleave, REF_REL_LABEL, REVIEW_LABEL, absTime, api, applyReveal, el, errorNote, fmtNum, lifecycleDot, relTime, renderMarkdown, state } from './core.js';
import { fmtDateTime } from './projects.js';
import { skeleton } from './learn.js';
import { overlay } from './admin.js';
// 작업 현황 #/dash — PM/PO 가 "전 구성원이 무엇을 했고 지금 무엇을 하는지" 파악하는 화면.
//  세 층: ① 구성원 요약(사람별 AI·작업수·마지막활동 + 최근 작업 제목 한 줄) ② 필터(구성원·유형 칩)
//  ③ 작업 타임라인(실제 작업 — 펼치면 본문·연결 과업·산출/참조 지식·바뀐 것). 클릭=펼침이 핵심(드릴인).
//  요약 집계는 GET /api/ui/dash/people, 타임라인은 GET /api/ui/activity/list(연결 곁들임). 고유명 하드코딩 없음.
// ════════════════════════════════════════════
// 유형별 점 색(스캔용 — §0.5: 채운 필 금지, 6px 점 + 무채 라벨). 성격축 8종(프로젝트 #182).
//  feature=민트, fix=코랄, decision=파랑, docs=틸, research=바이올렛, review=앰버, chore/other=중립.
const ACT_TYPE_TONE = { feature: 'mint', fix: 'coral', decision: 'blue', docs: 'teal', research: 'violet', review: 'amber', chore: 'muted', other: 'muted' };
function actTypeTag(type) {
    return el('span', { class: 'act-type tone-' + (ACT_TYPE_TONE[type] || 'muted') }, el('span', { class: 'act-type-dot', 'aria-hidden': 'true' }), ACTIVITY_TYPE_LABEL[type] || type);
}
// 작업(activity) 한 줄 — 회사 전체 타임라인(#/projects2)·작업 현황(#/dash) 공용.
//  접힘: 캐럿 + 유형칩 + 요약(굵게) / 사람·AI·상대시간(+ 구조·의도 변경 태그).
//  펼침(클릭): 기술 제목·메모 + 연결 과업(W) + 산출/참조/결정 지식 + 변경(커밋·should/is 점검) + 정확 시각.
//  펼침 데이터는 activity/list 가 곁들여 주는 a.body/a.tasks/a.refs/a.commit_sha/a.touchCount/a.*_review 를 그대로 쓴다.
function activityTimelineRow(a, nameOf) {
    const when = a.committed_at || a.created_at;
    const techTitle = a.title && a.title !== (a.summary || '') ? a.title : '';
    const hasDetail = !!(techTitle || a.body || (a.tasks && a.tasks.length) || (a.refs && a.refs.length)
        || a.commit_sha || a.touchCount || a.external_url
        || (a.is_review && a.is_review !== 'na') || (a.should_review && a.should_review !== 'na'));
    const caret = el('span', { class: 'act-row-caret' + (hasDetail ? '' : ' act-row-caret-empty'), 'aria-hidden': 'true', text: hasDetail ? '▸' : '' });
    // 변경 태그 — 이번 작업이 코드구조(is)/도메인 의도(should)를 바꾼 경우만 작게 표기.
    const tags = [];
    if (a.is_review === 'changed')
        tags.push(el('span', { class: 'act-row-tag', text: '구조 변경' }));
    if (a.should_review === 'changed')
        tags.push(el('span', { class: 'act-row-tag', text: '의도 변경' }));
    const head = el('div', { class: 'act-row-head',
        role: hasDetail ? 'button' : null, tabindex: hasDetail ? '0' : null, 'aria-expanded': hasDetail ? 'false' : null }, caret, actTypeTag(a.type), el('div', { class: 'act-row-body' }, el('div', { class: 'act-row-title', text: a.summary || a.title || '(제목 없음)' }), el('div', { class: 'act-row-meta' }, el('span', { class: 'act-row-who', text: nameOf(a.author_person) }), a.author_agent ? el('span', { class: 'act-row-agent', text: ' · ' + a.author_agent }) : null, el('span', { class: 'act-row-time', text: ' · ' + relTime(when) }), ...tags)));
    const row = el('div', { class: 'act-row' + (hasDetail ? ' act-row-expandable' : '') }, head);
    if (!hasDetail)
        return row;
    const detail = el('div', { class: 'act-row-detail', hidden: true });
    if (techTitle)
        detail.append(el('div', { class: 'act-row-tech', text: techTitle }));
    if (a.body)
        detail.append(el('div', { class: 'act-row-note', text: a.body }));
    const linkList = (items) => el('span', { class: 'act-row-links' }, ...items.map((it) => el('a', { class: 'act-row-link', href: '#/k/' + encodeURIComponent(it.name), text: it.title || it.name })));
    // v6: 과업 = 진척시킨 프로젝트(task) — #/projects2/p/:id 로 링크(지식 refs 는 #/k/:name 유지).
    if (a.tasks && a.tasks.length) {
        detail.append(el('div', { class: 'act-row-sec' }, el('span', { class: 'act-row-sec-label', text: '과업' }), el('span', { class: 'act-row-links' }, ...a.tasks.map((t) => el('a', { class: 'act-row-link', href: '#/projects2/p/' + t.id, text: t.title || ('#' + t.id) })))));
    }
    if (a.refs && a.refs.length) {
        const byRel = {};
        for (const rf of a.refs)
            (byRel[rf.relation] = byRel[rf.relation] || []).push(rf);
        for (const rel of ['produced', 'references', 'decided']) {
            if (!byRel[rel])
                continue;
            detail.append(el('div', { class: 'act-row-sec' }, el('span', { class: 'act-row-sec-label', text: REF_REL_LABEL[rel] || rel }), linkList(byRel[rel])));
        }
    }
    // 변경 — 커밋 좌표(sha·repo·코드 N곳) + should/is 점검 결과(변화 없음/변경됨까지 명시).
    const chg = [];
    if (a.commit_sha)
        chg.push(a.commit_sha.slice(0, 7) + (a.repo ? ' · ' + a.repo : '') + (a.touchCount ? ' · 코드 ' + a.touchCount + '곳' : ''));
    if (a.is_review && a.is_review !== 'na')
        chg.push('코드구조 ' + (REVIEW_LABEL[a.is_review] || a.is_review));
    if (a.should_review && a.should_review !== 'na')
        chg.push('도메인 의도 ' + (REVIEW_LABEL[a.should_review] || a.should_review));
    if (chg.length || a.external_url) {
        const sec = el('div', { class: 'act-row-sec' }, el('span', { class: 'act-row-sec-label', text: '변경' }));
        if (chg.length)
            sec.append(el('span', { class: 'act-row-chg', text: chg.join('  ·  ') }));
        if (a.external_url)
            sec.append(el('a', { class: 'act-row-link', href: a.external_url, target: '_blank', rel: 'noopener', text: '↗ 원본' }));
        detail.append(sec);
    }
    detail.append(el('div', { class: 'act-row-exact', text: fmtDateTime(when) }));
    let open = false;
    const toggle = () => {
        open = !open;
        detail.hidden = !open;
        row.classList.toggle('open', open);
        caret.textContent = open ? '▾' : '▸';
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        toggle();
    } });
    row.append(detail);
    return row;
}
async function renderDashboard(view, params) {
    if (!state.dash)
        state.dash = { expanded: new Set(), filter: { person: '', agent: '', type: '' } };
    // 딥링크(#/dash?person=..&type=..)면 그 필터로 시작. 그 외 일반 진입은 필터 초기화 — 디폴트로 아무도 선택 안 됨
    //  (모듈 state 가 재방문 간 유지되어 이전 클릭이 '눌린 채' 남던 것 방지).
    if (params && (params.get('person') || params.get('type') || params.get('agent'))) {
        state.dash.filter = { person: params.get('person') || '', agent: params.get('agent') || '', type: params.get('type') || '' };
    }
    else {
        state.dash.filter = { person: '', agent: '', type: '' };
    }
    const f = state.dash.filter;
    view.replaceChildren(skeleton('작업 현황을 불러오는 중'));
    const head = el('div', { class: 'page-head' }, el('h1', {}, '작업 ', el('span', { class: 'accent', text: '현황' })), el('p', { class: 'sub', text: '구성원이 어떤 작업을 했고 지금 무엇을 하고 있는지 한눈에. 작업을 누르면 — 무엇을 했고 어떤 과업·지식과 연결됐는지 — 상세가 펼쳐집니다.' }));
    let people = [];
    let feed = [];
    try {
        const [pp, ff] = await Promise.all([
            api('/api/ui/dash/people').then((d) => (d && d.people) || []),
            api('/api/ui/activity/list?limit=200').then((d) => (Array.isArray(d) ? d : (d && d.rows) || [])),
        ]);
        people = pp;
        feed = ff;
    }
    catch (e) {
        view.replaceChildren(head, errorNote(e, '작업 현황을 불러오지 못했습니다'));
        return;
    }
    if (!feed.length && !people.length) {
        view.replaceChildren(head, el('div', { class: 'empty', text: '아직 기록된 작업이 없습니다. AI가 작업(activity)을 남기면 여기 구성원·AI별로 쌓입니다.' }));
        return;
    }
    // 사람별 '가장 최근 작업'(피드는 최신순 → 사람별 첫 등장이 최신). 요약 한 줄 + 마지막 활동 시각 보강.
    const latestByPerson = new Map();
    for (const a of feed) {
        const k = a.author_person || '';
        if (!latestByPerson.has(k))
            latestByPerson.set(k, a);
    }
    // 작성자 표시명(명부) — 피드 카드도 id 대신 표시명으로(요약·칩과 일관). people 에 display_name 동봉.
    const displayName = (pid) => { if (!pid)
        return ''; const m = people.find((p) => p.author_person === pid); return (m && m.display_name) || pid; };
    // 내 목록(people) 사람 id 집합 — 타임라인도 '내 사람들'로 스코프(구성원 섹션과 일관).
    const myIds = new Set(people.map((p) => p.author_person).filter(Boolean));
    // ── 필터 갱신: state 만 바꾸고 in-place 재도색(요약 active·칩 active·피드). 해시 라우팅 왕복 없음. ──
    const setFilter = (patch) => { Object.assign(f, patch); paint(); };
    // ── 층 ② 필터 바(구성원 + 유형) ──
    const filterBar = el('div', { class: 'dash-filters' });
    function chip(label, on, onClick, extraCls) {
        return el('button', { class: 'dash-chip' + (on ? ' active' : '') + (extraCls ? ' ' + extraCls : ''), type: 'button', onclick: onClick }, label);
    }
    function paintFilters() {
        const personChips = el('div', { class: 'dash-chip-group' }, el('span', { class: 'dash-chip-label', text: '구성원' }), chip('전체', !f.person, () => setFilter({ person: '', agent: '' })), ...people.filter((p) => p.author_person).map((p) => chip(p.display_name || p.author_person, f.person === p.author_person, () => setFilter({ person: f.person === p.author_person ? '' : p.author_person, agent: '' }))));
        const typeChips = el('div', { class: 'dash-chip-group' }, el('span', { class: 'dash-chip-label', text: '유형' }), chip('전체', !f.type, () => setFilter({ type: '' })), ...ACTIVITY_TYPE_ORDER.filter((t) => feed.some((a) => a.type === t)).map((t) => chip(ACTIVITY_TYPE_LABEL[t], f.type === t, () => setFilter({ type: f.type === t ? '' : t }))));
        filterBar.replaceChildren(personChips, typeChips);
    }
    // ── 층 ① 구성원 요약 ──
    const summaryBox = el('div', { class: 'list-box dash-summary' });
    function summaryRow(p) {
        const key = p.author_person || '';
        const name = p.display_name || p.author_person;
        const selectable = !!p.author_person;
        const on = selectable && f.person === key;
        const totalTasks = (p.agents || []).reduce((s, a) => s + (a.tasks || 0), 0);
        const last = (p.agents || []).reduce((mx, a) => (a.lastActiveAt && (!mx || a.lastActiveAt > mx) ? a.lastActiveAt : mx), null);
        const aiChips = (p.agents || []).map((a) => el('span', { class: 'dash-ai' }, el('span', { class: 'dash-ai-dot', 'aria-hidden': 'true' }), el('span', { class: 'dash-ai-name', text: a.author_agent || '직접' }), el('span', { class: 'dash-ai-n', text: fmtNum(a.count) })));
        const latest = latestByPerson.get(key);
        const row = el('div', { class: 'dash-person' + (on ? ' active' : '') + (selectable ? '' : ' static'),
            role: selectable ? 'button' : null, tabindex: selectable ? '0' : null,
            'aria-pressed': selectable ? (on ? 'true' : 'false') : null }, el('div', { class: 'dash-person-top' }, el('span', { class: 'dash-person-name', text: name || '미상' }), el('span', { class: 'dash-person-meta' }, el('strong', { text: fmtNum(p.total) }), ' 작업 · ', fmtNum(totalTasks) + ' 과업 · ', last ? relTime(last) : '활동 없음')), aiChips.length ? el('div', { class: 'dash-ai-row' }, ...aiChips) : null, latest ? el('div', { class: 'dash-latest' }, el('span', { class: 'dash-latest-label', text: '최근' }), actTypeTag(latest.type), el('span', { class: 'dash-latest-title', text: latest.summary || latest.title })) : null);
        if (selectable) {
            const go = () => setFilter({ person: on ? '' : key, agent: '' });
            row.addEventListener('click', go);
            row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                go();
            } });
        }
        return row;
    }
    // ── 층 ③ 작업 타임라인(펼침형) ──
    const feedBox = el('div', { class: 'list-box dash-feed' });
    function activityDetail(a, when) {
        const box = el('div', { class: 'act-detail' });
        // 겉(접힘)엔 쉬운 summary 를 보였으니, 펼치면 AI가 기록한 기술 상세 제목을 먼저 드러낸다(summary 와 다를 때만).
        if (a.summary && a.title && a.summary !== a.title) {
            box.append(el('div', { class: 'act-techtitle' }, el('span', { class: 'act-techtitle-label', text: '상세 제목' }), el('span', { class: 'act-techtitle-text', text: a.title })));
        }
        if (a.body)
            box.append(renderMarkdown(a.body));
        if ((a.tasks || []).length) {
            box.append(el('div', { class: 'act-group' }, el('div', { class: 'act-group-label', text: '연결된 과업' }), el('div', { class: 'act-links' }, ...a.tasks.map((t) => el('a', { class: 'act-link', href: '#/k/' + encodeURIComponent(t.name) }, el('span', { class: 'kb-glyph', text: 'W' }), el('span', { class: 'act-link-title', text: t.title || t.name }), (t.lifecycle && t.lifecycle !== 'active') ? lifecycleDot(t.lifecycle) : null)))));
        }
        if ((a.refs || []).length) {
            box.append(el('div', { class: 'act-group' }, el('div', { class: 'act-group-label', text: '산출·참조 지식' }), el('div', { class: 'act-links' }, ...a.refs.map((r) => el('a', { class: 'act-link', href: '#/k/' + encodeURIComponent(r.name) }, el('span', { class: 'act-rel', text: REF_REL_LABEL[r.relation] || r.relation }), el('span', { class: 'act-link-title', text: r.title || r.name }))))));
        }
        const facts = [];
        if (a.touchCount)
            facts.push(['건드린 코드', fmtNum(a.touchCount) + '곳']);
        if (a.commit_sha)
            facts.push(['커밋', a.commit_sha.slice(0, 10)]);
        facts.push(['도메인 의도(should) 점검', REVIEW_LABEL[a.should_review] || a.should_review || '—']);
        facts.push(['코드 구조(is) 점검', REVIEW_LABEL[a.is_review] || a.is_review || '—']);
        if (a.external_system)
            facts.push(['외부 출처', a.external_system]);
        if (a.session_id)
            facts.push(['세션', String(a.session_id).slice(0, 8)]);
        facts.push(['기록 시각', absTime(when) || '—']);
        box.append(el('div', { class: 'act-facts' }, ...facts.map(([k, v]) => el('div', { class: 'act-fact' }, el('span', { class: 'act-fact-k', text: k }), el('span', { class: 'act-fact-v', text: String(v) })))));
        return box;
    }
    function activityCard(a) {
        const open = state.dash.expanded.has(a.id);
        const when = a.committed_at || a.created_at;
        const meta = [
            el('span', { class: 'act-who', text: displayName(a.author_person) || '미상' }),
            el('span', { class: 'act-ai', text: a.author_agent || '직접' }),
            el('span', { text: relTime(when) }),
        ];
        if (a.repo)
            meta.push(el('span', { class: 'mono', text: a.repo }));
        if ((a.tasks || []).length)
            meta.push(el('span', { text: fmtNum(a.tasks.length) + ' 과업' }));
        const sigs = [];
        if (a.should_review === 'changed')
            sigs.push(el('span', { class: 'act-sig sig-should', text: '의도 변경' }));
        if (a.is_review === 'changed')
            sigs.push(el('span', { class: 'act-sig sig-is', text: '구조 변경' }));
        const headRow = el('div', { class: 'act-head', role: 'button', tabindex: '0', 'aria-expanded': open ? 'true' : 'false' }, el('span', { class: 'act-caret', 'aria-hidden': 'true', text: open ? '▾' : '▸' }), el('div', { class: 'act-head-main' }, el('div', { class: 'act-titleline' }, actTypeTag(a.type), el('span', { class: 'act-title', text: a.summary || a.title })), el('div', { class: 'row-meta act-meta' }, ...interleave(meta, el('span', { class: 'act-sep', 'aria-hidden': 'true', text: '·' })), ...sigs)));
        const toggle = () => { if (open)
            state.dash.expanded.delete(a.id);
        else
            state.dash.expanded.add(a.id); renderFeed(); };
        headRow.addEventListener('click', toggle);
        headRow.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            toggle();
        } });
        const card = el('div', { class: 'act-card' + (open ? ' open' : '') }, headRow);
        if (open)
            card.append(activityDetail(a, when));
        return card;
    }
    function renderFeed() {
        const filtered = feed.filter((a) => myIds.has(a.author_person)
            && (!f.person || (a.author_person || '') === f.person)
            && (!f.agent || (a.author_agent || '') === f.agent)
            && (!f.type || a.type === f.type));
        if (!filtered.length) {
            feedBox.replaceChildren(el('div', { class: 'empty', text: '내 목록 구성원의 작업이 없습니다. 「목록 편집」으로 사람을 추가하거나 위 필터를 넓혀 보세요.' }));
            return;
        }
        feedBox.replaceChildren(...filtered.map(activityCard));
    }
    function paint() {
        paintFilters();
        summaryBox.replaceChildren(...people.map(summaryRow));
        renderFeed();
    }
    const sec = (title, hint, ...extra) => el('div', { class: 'dash-sec-head' }, el('h2', { class: 'dash-sec-title', text: title }), hint ? el('span', { class: 'dash-sec-hint', text: hint }) : null, ...extra);
    // ── 내 목록 편집 팝업 — 전체 활성 구성원 검색 + 체크/언체크로 내 목록 구성(나는 항상 표시). ──
    async function openWatchEditor() {
        let allMembers = [], watched = new Set(), me = null;
        try {
            const [mm, ww] = await Promise.all([
                api('/api/ui/dash/members').then((d) => (d && d.members) || []),
                api('/api/ui/dash/watch').then((d) => d || {}),
            ]);
            allMembers = mm;
            watched = new Set((ww && ww.member_ids) || []);
            me = (ww && ww.me) || null;
        }
        catch (e) {
            alert('구성원 목록을 불러오지 못했습니다: ' + (e.message || e));
            return;
        }
        const search = el('input', { type: 'text', class: 'inp dash-watch-search', placeholder: '이름으로 검색…', 'aria-label': '구성원 검색' });
        const listBox = el('div', { class: 'dash-watch-list' });
        // 행을 한 번만 만들고(체크 상태 보존), 검색은 표시/숨김만 토글한다.
        const rows = allMembers.map((m) => {
            const isMe = me && m.id === me;
            const cb = el('input', { type: 'checkbox', 'data-mid': m.id });
            if (isMe) {
                cb.checked = true;
                cb.disabled = true;
            }
            else if (watched.has(m.id))
                cb.checked = true;
            const label = el('label', { class: 'dash-watch-row' }, cb, el('span', { class: 'dash-watch-name', text: m.display_name || m.id }), isMe ? el('span', { class: 'dash-watch-tag', text: '나 · 항상 표시' }) : null);
            return { m, isMe, cb, label };
        });
        const applySearch = () => {
            const term = search.value.trim().toLowerCase();
            let shown = 0;
            for (const r of rows) {
                const hay = ((r.m.display_name || '') + ' ' + r.m.id).toLowerCase();
                const ok = !term || hay.includes(term);
                r.label.style.display = ok ? '' : 'none';
                if (ok)
                    shown++;
            }
            emptyNote.style.display = shown ? 'none' : '';
        };
        const emptyNote = el('div', { class: 'dash-watch-empty', text: '검색 결과가 없습니다.' });
        search.addEventListener('input', applySearch);
        listBox.replaceChildren(...rows.map((r) => r.label), emptyNote);
        applySearch();
        const saveBtn = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '저장' });
        const back = overlay('내 목록 편집', el('p', { class: 'dash-watch-help', text: '작업 현황 「구성원」에 보일 사람만 고르세요 — 나와 관계있는 사람 위주로. 나는 항상 표시됩니다.' }), search, listBox, el('div', { class: 'dash-watch-actions' }, saveBtn));
        saveBtn.addEventListener('click', async () => {
            const picked = rows.filter((r) => !r.isMe && r.cb.checked).map((r) => r.m.id);
            saveBtn.disabled = true;
            saveBtn.textContent = '저장 중…';
            try {
                await api('/api/ui/dash/watch', { method: 'POST', body: JSON.stringify({ member_ids: picked }) });
                back.remove();
                renderDashboard(view, params);
            }
            catch (e) {
                alert('저장 실패: ' + (e.message || e));
                saveBtn.disabled = false;
                saveBtn.textContent = '저장';
            }
        });
    }
    const editBtn = el('button', { class: 'btn btn-ghost btn-sm dash-edit-btn', type: 'button', text: '목록 편집', onclick: openWatchEditor });
    view.replaceChildren(head, sec('구성원', '내 목록 — 나와 관계있는 사람만. 눌러서 그 사람 작업만 보기', editBtn), summaryBox, sec('작업 타임라인', '내 목록 사람들의 최근 작업부터 — 작업을 눌러 상세를 펼칩니다'), filterBar, feedBox);
    paint();
    applyReveal([summaryBox, feedBox]);
    document.getElementById('view').focus?.();
}
// ════════════════════════════════════════════
export { actTypeTag, activityTimelineRow, renderDashboard, };

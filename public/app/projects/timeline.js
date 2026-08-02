// projects/timeline.ts — #1313 R33: web/projects.ts 분해 ④.
//  타임라인(간트) 탭 한 벌 — 축·스케일 상수, 뷰 상태(pjvTlState), 하위 작업·의존 엣지 캐시(pjvTlTasks),
//  간트 본체(pjvTimelineView), 우클릭 지점 앵커(pjvCursorSpot), 바/의존선 메뉴, 의존 대상 피커,
//  그리고 테이블 뷰의 기본 정렬 비교자(pjvTableDefaultCmp).
//  ⚠ pjvTlState · pjvTlTasks · pjvCursorSpotEl 은 이 모듈이 **단독 소유**한다 — 사본이 생기면 캐시가 갈라져
//   같은 화면이 서로 다른 하위 작업을 그린다. 캐시 비우기(pjvTlClearTasks)는 뷰 탭 전환(pjvSetViewTab)이 부른다.
//  ⚠ pjvOpenTaskModal 은 **배럴(../projects.js) 경유** — rows.ts 와 같은 이유(projects↔taskmodal 순환에 새 가지 금지).
import { api, el, personFace, sv, toast } from '../core.js';
import { pjvOpenTaskModal } from '../projects.js';
import { pjvPopover } from './popover.js';
import { pjvClosedView, pjvProjClosedView, pjvReloadKeepScroll } from './state.js';
import { pjvStatusIconStd } from './status.js';
import { pjvAssignees, pjvSaveTask } from './task-controls.js';
// ════════════════════════════════════════════════════════════════════════════
// 타임라인 뷰(#1067) — 시간축 × 프로젝트. ClickUp Gantt 의 **현행(Gen-C)** 시각 규약을 따른다:
//  바는 pill 이 아니라 radius 4px, 저채도 단색, 이름·아바타는 **바 바깥**, 가로 행 구분선 없음, 주말 음영.
//  (헬프센터에 남아 있는 구세대 스샷의 '원색 pill + 바 안 흰 글씨'는 2019~2020 디자인이라 따르지 않는다.)
//
// ★ 축 선택 — 우리 데이터의 현실에 맞춘 핵심 설계:
//  프로젝트 304개 중 start+due 를 **둘 다** 가진 건 0개, 태스크도 1개뿐이다(2026-07-21 실측).
//  계획축만 쓰면 화면의 99% 가 빈 줄이 되므로, 계획 날짜가 없으면 **실적축(created_at ~ completed_at/오늘)** 으로 그린다.
//  실적 바는 점선 테두리로 계획 바와 구분한다 — "이건 계획이 아니라 지나간 자취"라는 걸 화면이 스스로 말해야 한다.
// ════════════════════════════════════════════════════════════════════════════
const PJV_TL_DAY = 86400000;
// 스케일 — 하루가 몇 px.
const PJV_TL_SCALES = [
    { key: 'day', label: '일', px: 30 },
    { key: 'week', label: '주', px: 10 },
    { key: 'month', label: '월', px: 3.4 },
];
const PJV_GT_SHEET_W = 300; // 좌측 시트 폭
const PJV_GT_ROW_H = 36; // 행 높이 = 바 28 + 상하 4
const PJV_GT_NEW_DAYS = 7; // 캔버스를 클릭해 새로 잡는 일정의 기본 길이
// showActual — 실적(지나간 자취) 띠를 겹쳐 볼지. **기본 꺼짐**: 간트는 과거 기록이 아니라 앞으로의 계획을 보는 도구다.
// depth(#1305) — 어디까지 행으로 펼칠지. 기본은 **끝까지**: 프로젝트만 그린 간트는 "언제 무엇을 한다"의 실제
//  단위(태스크)가 빠져 계획 도구로 쓸 수 없다. 화면이 복잡하면 여기서 프로젝트만으로 접는다.
const PJV_TL_DEPTHS = [
    { key: 'project', label: '프로젝트', hint: '프로젝트 행만' },
    { key: 'task', label: '＋태스크', hint: '프로젝트 ▸ 태스크' },
    { key: 'subtask', label: '＋하위', hint: '프로젝트 ▸ 태스크 ▸ 하위 태스크' },
];
// reschedule(#1308) — 선행 날짜를 옮기면 depends_on 후행 체인도 같은 Δ 로 따라간다. **기본 켜짐**:
//  의존을 걸어 두는 이유가 바로 그 연동이고, 끄고 싶은 사람은 툴바에서 한 번에 끈다.
// linking — connector 노드를 끄는 중인 상태(from 노드와 어느 끝을 잡았는지). 드롭하면 엣지가 된다.
const pjvTlState = { scale: 'week', collapsed: new Set(), showActual: false, depth: 'subtask', reschedule: true, linking: null };
// ── 하위 작업 캐시(#1305) ────────────────────────────────────────────────────
//  타임라인은 스코프 안 **모든** 프로젝트의 하위 작업을 한 화면에 계층으로 그린다. 프로젝트마다 상세
//  (/v6/projects/:id)를 부르면 화면 하나에 수백 요청이 나가므로 /v6/project-tasks 로 한 번에 받아 여기 둔다.
//  비우는 시점은 '타임라인 탭 진입'(pjvSetViewTab) — 다른 뷰에서 태스크를 고치고 돌아와도 신선하다.
//  #1308 — 같은 응답에 의존선(depends_on 엣지)도 실려 온다. 엣지는 프로젝트·태스크 어느 층에나 걸리므로
//   노드 축(프로젝트별)이 아니라 평면 배열로 모아 둔다: { from_id(후행), to_id(선행) }.
const pjvTlTasks = { byProject: new Map(), pending: new Set(), failed: false, edges: [] };
function pjvTlClearTasks() { pjvTlTasks.byProject.clear(); pjvTlTasks.pending.clear(); pjvTlTasks.failed = false; pjvTlTasks.edges = []; }
// 아직 안 받은 프로젝트의 하위 작업을 가져온다. 도착하면 done()(=재렌더)을 부른다. 반환값 = 지금 로딩 중인가.
function pjvTlFetchTasks(ids, done) {
    const need = ids.filter((id) => !pjvTlTasks.byProject.has(id) && !pjvTlTasks.pending.has(id));
    if (!need.length)
        return pjvTlTasks.pending.size > 0;
    for (const id of need)
        pjvTlTasks.pending.add(id);
    // 서버 상한(500)에 맞춰 나눠 던진다 — 완료까지 켠 전체 스코프면 프로젝트가 수백 개다.
    const chunks = [];
    for (let i = 0; i < need.length; i += 500)
        chunks.push(need.slice(i, i + 500));
    Promise.all(chunks.map((c) => api('/api/ui/v6/project-tasks?ids=' + c.join(','))
        .then((d) => ({ tasks: (d && d.tasks) || [], edges: (d && d.edges) || [] }))
        .catch(() => { pjvTlTasks.failed = true; return { tasks: [], edges: [] }; })))
        .then((all) => {
        // 요청한 id 는 결과가 0건이어도 빈 배열로 채운다 — 안 그러면 '아직 안 받음'으로 남아 매 렌더마다 다시 부른다.
        for (const id of need) {
            pjvTlTasks.byProject.set(id, []);
            pjvTlTasks.pending.delete(id);
        }
        for (const row of all.flatMap((r) => r.tasks)) {
            const arr = pjvTlTasks.byProject.get(Number(row.project_id));
            if (arr)
                arr.push(row);
        }
        // 엣지는 청크마다 겹칠 수 있다(끝점이 다른 청크에 걸린 선) — from-to 키로 합친다.
        const seen = new Set(pjvTlTasks.edges.map((e) => e.from_id + '>' + e.to_id));
        for (const e of all.flatMap((r) => r.edges)) {
            const k = e.from_id + '>' + e.to_id;
            if (seen.has(k))
                continue;
            seen.add(k);
            pjvTlTasks.edges.push(e);
        }
        done();
    });
    return true;
}
function pjvTlScale() { return PJV_TL_SCALES.find((s) => s.key === pjvTlState.scale) || PJV_TL_SCALES[1]; }
function pjvTlDayStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function pjvTlFmt(ms) { const d = new Date(ms); return (d.getMonth() + 1) + '/' + d.getDate(); }
function pjvTlISO(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// 계획 구간 — start/due 가 실제로 있는 것만. 하나만 있으면 그날 하루로 본다.
function pjvGtPlan(p) {
    const s = p.start_date ? Date.parse(p.start_date) : NaN;
    const d = p.due_date ? Date.parse(p.due_date) : NaN;
    if (!isNaN(s) && !isNaN(d))
        return { from: Math.min(s, d), to: Math.max(s, d) };
    if (!isNaN(d))
        return { from: d, to: d };
    if (!isNaN(s))
        return { from: s, to: s };
    return null;
}
// 실적 구간 — 실제로 살아 있던 기간(참고용 배경 띠).
function pjvGtActual(p) {
    const c = Date.parse(p.created_at || '');
    if (isNaN(c))
        return null;
    const done = p.completed_at ? Date.parse(p.completed_at) : NaN;
    return { from: c, to: Math.max(c, !isNaN(done) ? done : Date.now()) };
}
// ════════════════════════════════════════════════════════════════════════════
// 간트 차트(#1067) — 타임라인 탭.
//
// ★ 목적: **앞으로의 계획을 세우고 지연을 잡아내는 도구**다. 지나간 기록을 보는 화면이 아니다.
//   그래서 이 구현의 세 가지 원칙:
//   ① 축은 **오늘을 지나 미래까지** 항상 열려 있다(데이터가 과거뿐이어도 앞쪽 12주를 비워 둔다).
//      — 오늘까지만 그리면 "무엇을 언제 할 것인가"를 볼 수 없어 간트가 아니라 로그가 된다.
//   ② 일정이 없는 프로젝트는 **숨기지 않고 좌측 '일정 없음'에 쌓는다**. 우리 데이터는 317건 중 314건이
//      날짜가 없다 — 이걸 과거 띠로 그려 화면을 채우면 '다 계획된 것처럼' 보여 거짓말이 된다.
//   ③ **차트에서 일정을 만들 수 있다** — 빈 칸을 클릭하면 그 날짜로 일정이 잡히고, 바를 끌면 날짜가 바뀐다.
//      읽기만 하는 간트는 생산성에 기여하지 않는다.
//
// 시각 규약은 ClickUp 현행(Gen-C): 바는 pill 아닌 radius 4px, 저채도, 라벨은 바 바깥, 차트에 가로 구분선 없음.
// ════════════════════════════════════════════════════════════════════════════
function pjvTimelineView(projects, ctx) {
    const wrap = el('div', { class: 'pjv-gt' });
    const lists = (ctx && ctx.lists) || [];
    const reload = (ctx && ctx.reload) || (() => { });
    const rerender = (ctx && ctx.rerender) || (() => { });
    const all = (projects || []).filter((p) => p.status !== 'done' || pjvProjClosedView.done);
    if (!all.length) {
        wrap.append(el('div', { class: 'pjv-proj-empty', text: '타임라인에 그릴 프로젝트가 없습니다.' }));
        return wrap;
    }
    // ── ⓪ 계층(#1305) — 프로젝트 ▸ 태스크 ▸ 하위 태스크를 한 트리로 세운다. ──
    //  프로젝트만 그린 간트는 계획의 실제 단위(태스크)가 빠져 있어 "무엇을 언제 하는가"를 볼 수 없었다.
    //  한 행이 되는 것 = 노드. own = 자기 계획 / span = 자기+하위 계획의 합집합(롤업) — 롤업이 있어야
    //  접힌 프로젝트도 "그 안의 일정이 어디쯤인지"를 말해 준다.
    const wantTasks = pjvTlState.depth !== 'project';
    const loadingTasks = wantTasks && pjvTlFetchTasks(all.map((p) => Number(p.id)), rerender);
    const nodeOf = (row, kind, depth) => {
        let children = [];
        if (wantTasks && kind === 'project') {
            children = (pjvTlTasks.byProject.get(Number(row.id)) || [])
                .filter((t) => t.level === 'task' && (t.status !== 'done' || pjvClosedView.tasks))
                .map((t) => nodeOf(t, 'task', depth + 1));
        }
        else if (kind === 'task' && pjvTlState.depth === 'subtask') {
            children = (pjvTlTasks.byProject.get(Number(row.project_id)) || [])
                .filter((s) => s.level === 'subtask' && Number(s.parent_id) === Number(row.id)
                && (s.status !== 'done' || pjvClosedView.subtasks))
                .map((s) => nodeOf(s, 'subtask', depth + 1));
        }
        const own = pjvGtPlan(row);
        let span = own ? { from: own.from, to: own.to } : null;
        for (const c of children) {
            if (!c.span)
                continue;
            span = span ? { from: Math.min(span.from, c.span.from), to: Math.max(span.to, c.span.to) }
                : { from: c.span.from, to: c.span.to };
        }
        return { row, kind, depth, children, own, span, done: children.filter((c) => c.row.status === 'done').length };
    };
    const nodes = all.map((p) => nodeOf(p, 'project', 0));
    // 차트 행이 되는 기준 = '자기 또는 하위에 일정이 있는가'. 태스크에만 날짜가 잡힌 프로젝트도 이제 축 위에 선다.
    const scheduled = nodes.filter((n) => n.span);
    const unscheduled = nodes.filter((n) => !n.span);
    // ── 리스트별 그룹(간트 좌측 계층) — 일정이 있는 것만 차트 행이 된다. ──
    const listById = new Map(lists.map((l) => [String(l.id), l]));
    const groups = [];
    const gmap = new Map();
    for (const n of scheduled) {
        const key = n.row.list_id != null ? String(n.row.list_id) : '__none__';
        let g = gmap.get(key);
        if (!g) {
            const l = listById.get(key);
            g = { key, name: l ? l.name : '기타 (미분류)', color: l ? (l.color || null) : null, rows: [] };
            gmap.set(key, g);
            groups.push(g);
        }
        g.rows.push(n);
    }
    for (const g of groups) {
        g.rows.sort((a, b) => a.span.from - b.span.from || String(a.row.name).localeCompare(String(b.row.name)));
        g.from = Math.min(...g.rows.map((r) => r.span.from));
        g.to = Math.max(...g.rows.map((r) => r.span.to));
        g.done = g.rows.filter((r) => r.row.status === 'done').length;
        g.pct = Math.round((g.done / g.rows.length) * 100);
    }
    groups.sort((a, b) => a.from - b.from);
    // ── ① 축 범위 — 오늘을 중심에 두고 **미래를 항상 확보**한다. ──
    const today = pjvTlDayStart(Date.now());
    const sc = pjvTlScale();
    const dayPx = sc.px;
    // 축은 **모든 깊이**의 자기 계획을 담는다 — 태스크 마감이 프로젝트 범위 밖이면 그것도 화면 안에 들어와야 한다.
    const spans = [];
    const flatNodes = []; // 의존 피커가 고를 수 있는 전체 노드(#1308)
    const collectSpans = (n) => { if (n.own)
        spans.push(n.own); flatNodes.push(n); for (const c of n.children)
        collectSpans(c); };
    for (const n of nodes)
        collectSpans(n);
    const dataMin = spans.length ? Math.min(...spans.map((s) => s.from)) : today;
    const dataMax = spans.length ? Math.max(...spans.map((s) => s.to)) : today;
    // 과거는 최소 3주, 미래는 최소 12주 — 계획을 '앞으로 끌어다 놓을 빈 캔버스'가 늘 있어야 한다.
    const from = pjvTlDayStart(Math.min(dataMin, today - 21 * PJV_TL_DAY));
    const to = pjvTlDayStart(Math.max(dataMax + 7 * PJV_TL_DAY, today + 84 * PJV_TL_DAY));
    const days = Math.max(1, Math.round((to - from) / PJV_TL_DAY) + 1);
    const trackW = Math.max(360, Math.round(days * dayPx));
    const xOf = (ms) => Math.round(((pjvTlDayStart(ms) - from) / PJV_TL_DAY) * dayPx);
    const wOf = (a, b) => Math.max(Math.max(6, Math.round(dayPx)), xOf(b) - xOf(a) + Math.round(dayPx));
    const dayAt = (x) => pjvTlDayStart(from + Math.round(x / dayPx) * PJV_TL_DAY);
    // ── 툴바 ──
    const scaleWrap = el('div', { class: 'pjv-gt-scales' });
    for (const s of PJV_TL_SCALES) {
        const b = el('button', { class: 'pjv-gt-scale' + (s.key === sc.key ? ' on' : ''), type: 'button', text: s.label });
        b.onclick = (e) => { e.stopPropagation(); if (pjvTlState.scale === s.key)
            return; pjvTlState.scale = s.key; rerender(); };
        scaleWrap.append(b);
    }
    const actualBtn = el('button', { class: 'pjv-gt-toggle' + (pjvTlState.showActual ? ' on' : ''), type: 'button',
        title: '실제로 진행된 기간을 흐린 띠로 겹쳐 봅니다', text: '실적 겹쳐보기' });
    actualBtn.onclick = (e) => { e.stopPropagation(); pjvTlState.showActual = !pjvTlState.showActual; rerender(); };
    // 의존 연동(#1308) — 선행을 옮기면 후행 체인이 같은 일수만큼 따라간다(간격 유지). 끄면 그 항목만 움직인다.
    const reschedBtn = el('button', { class: 'pjv-gt-toggle' + (pjvTlState.reschedule ? ' on' : ''), type: 'button',
        title: '선행 일정을 옮기면 그것에 의존하는 후행도 같은 일수만큼 따라 옮깁니다(간격 유지)', text: '의존 연동' });
    reschedBtn.onclick = (e) => { e.stopPropagation(); pjvTlState.reschedule = !pjvTlState.reschedule; rerender(); };
    const todayBtn = el('button', { class: 'pjv-gt-todaybtn', type: 'button', text: '오늘' });
    // 깊이(#1305) — 어디까지 행으로 펼칠지. 스케일과 같은 세그먼트 모양(둘 다 '무엇을 얼마나 보여줄까'의 축).
    const depthWrap = el('div', { class: 'pjv-gt-scales pjv-gt-depths' });
    for (const d of PJV_TL_DEPTHS) {
        const b = el('button', { class: 'pjv-gt-scale' + (d.key === pjvTlState.depth ? ' on' : ''), type: 'button', title: d.hint, text: d.label });
        b.onclick = (e) => { e.stopPropagation(); if (pjvTlState.depth === d.key)
            return; pjvTlState.depth = d.key; rerender(); };
        depthWrap.append(b);
    }
    // 하위 작업이 몇 개 그려졌는지 — '보이는 것'을 숫자로도 확인할 수 있게(로딩 중이면 그 사실을 말한다).
    let taskRowCount = 0;
    const countRows = (n) => { for (const c of n.children) {
        taskRowCount++;
        countRows(c);
    } };
    for (const n of nodes)
        countRows(n);
    const taskLegend = el('span', { class: 'pjv-gt-legend' }, el('span', { class: 'pjv-gt-key task' }), el('span', { text: loadingTasks ? '하위 작업 불러오는 중…' : (pjvTlTasks.failed ? '하위 작업을 못 불러왔어요' : '하위 작업 ' + taskRowCount) }));
    wrap.append(el('div', { class: 'pjv-gt-toolbar' }, scaleWrap, depthWrap, actualBtn, reschedBtn, el('span', { class: 'pjv-gt-legend' }, el('span', { class: 'pjv-gt-key plan' }), el('span', { text: '일정 ' + scheduled.length }), el('span', { class: 'pjv-gt-key none' }), el('span', { text: '미정 ' + unscheduled.length })), wantTasks ? taskLegend : null, todayBtn));
    const scroller = el('div', { class: 'pjv-gt-scroll' });
    const inner = el('div', { class: 'pjv-gt-inner', style: 'width:' + (PJV_GT_SHEET_W + trackW) + 'px' });
    // ── 2단 시간축 ──
    const axis = el('div', { class: 'pjv-gt-axis', style: 'width:' + trackW + 'px' });
    const rowMon = el('div', { class: 'pjv-gt-mons' });
    const rowSub = el('div', { class: 'pjv-gt-subs' });
    {
        let cur = from;
        while (cur <= to) {
            const d = new Date(cur);
            const monEnd = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
            const segTo = Math.min(monEnd - PJV_TL_DAY, to);
            rowMon.append(el('div', { class: 'pjv-gt-mon', style: 'left:' + xOf(cur) + 'px;width:' + (xOf(segTo) - xOf(cur) + dayPx) + 'px',
                text: (d.getMonth() === 0 || cur === from ? d.getFullYear() + '. ' : '') + (d.getMonth() + 1) + '월' }));
            cur = monEnd;
        }
        const step = sc.key === 'day' ? 1 : 7;
        for (let i = 0; i < days; i += step) {
            const ms = from + i * PJV_TL_DAY;
            const d = new Date(ms);
            const wknd = d.getDay() === 0 || d.getDay() === 6;
            const cell = el('div', { class: 'pjv-gt-sub' + (wknd && sc.key === 'day' ? ' wknd' : ''),
                style: 'left:' + xOf(ms) + 'px;width:' + Math.round(step * dayPx) + 'px' });
            if (sc.key !== 'month')
                cell.append(el('span', { text: sc.key === 'day' ? String(d.getDate()) : pjvTlFmt(ms) }));
            rowSub.append(cell);
        }
    }
    axis.append(rowMon, rowSub);
    inner.append(el('div', { class: 'pjv-gt-headrow' }, el('div', { class: 'pjv-gt-sheethead', style: 'width:' + PJV_GT_SHEET_W + 'px' }, el('span', { class: 'pjv-gt-th name', text: '이름' }), el('span', { class: 'pjv-gt-th span', text: '기간' })), axis));
    // ── ③ 일정 저장 — 차트에서 만든 계획을 서버에 반영. 드래그·클릭·우클릭 모두 이 한 곳을 지난다. ──
    //  프로젝트와 태스크는 엔드포인트가 다르다(#1305). 태스크는 전체 reload 를 걸지 않는다 — 목록 API 는
    //  프로젝트만 돌려주므로 다시 불러도 태스크는 안 딸려온다. 캐시에 있는 그 행을 직접 고치고 다시 그린다.
    //  #1308 — 날짜를 건드리는 패치엔 reschedule_dependents 를 실어 보낸다(툴바 토글). 서버가 depends_on
    //   후행 체인을 같은 Δ 로 밀고 옮긴 행을 rescheduled 로 돌려준다. 그게 비어 있지 않으면 어느 태스크가
    //   얼마나 움직였는지 낱개로 맞추기보다 **캐시를 통째로 비우고 다시 받는다** — 한 번의 추가 요청으로 정확해진다.
    const withResched = (patch) => (pjvTlState.reschedule && ('start_date' in patch || 'due_date' in patch)
        ? { ...patch, reschedule_dependents: true } : patch);
    const afterSave = (d) => {
        if (d && d.rescheduled && d.rescheduled.length) {
            pjvTlClearTasks();
            toast('의존 태스크 ' + d.rescheduled.length + '개도 함께 옮겼습니다');
        }
        rerender();
    };
    const savePatch = (n, patch) => {
        const body = withResched(patch);
        if (n.kind === 'project') {
            // 프로젝트는 목록 reload 가 자기 날짜를 되가져온다. 재스케줄로 움직인 **태스크**는 캐시에 있으므로 함께 비운다.
            api('/api/ui/v6/projects/' + n.row.id, { method: 'POST', body: JSON.stringify(body) })
                .then((d) => { if (d && d.rescheduled && d.rescheduled.length)
                pjvTlClearTasks(); pjvReloadKeepScroll(reload); })
                .catch((e) => toast('수정 실패 — ' + e.message, true));
            return;
        }
        Object.assign(n.row, patch);
        pjvSaveTask(n.row.id, body).then(afterSave);
        rerender();
    };
    const saveSpan = (n, fromMs, toMs) => savePatch(n, { start_date: pjvTlISO(fromMs), due_date: pjvTlISO(toMs) });
    // 끄는 동안 따라다니는 날짜 배지 — '지금 놓으면 언제부터 언제까지, 며칠'을 커서 옆에서 즉시 읽는다.
    //  (폭만 변하고 날짜가 안 보이면 눈대중으로 놓게 되어, 결국 놓고 나서 좌측 시트를 다시 확인해야 한다.)
    const dragTip = el('div', { class: 'pjv-gt-dragtip' });
    // 바 드래그 — move(전체 이동) / l(시작일) / r(마감일). 하루 단위로 스냅하고, 놓을 때 저장한다.
    //  grip = 실제로 붙잡는 요소(핸들 또는 바 자신) · bar = 위치·폭을 다시 그릴 대상. 이 둘을 나누지 않으면
    //  핸들을 끌 때 style 이 핸들 자신에게 적용돼 바가 그대로 있는다(= 어디까지 늘었는지 안 보인다).
    const attachDrag = (grip, bar, n, span, mode, rangeEl) => {
        grip.addEventListener('pointerdown', (ev) => {
            if (ev.button !== 0)
                return;
            ev.preventDefault();
            ev.stopPropagation();
            const startX = ev.clientX;
            let dFrom = span.from, dTo = span.to;
            grip.setPointerCapture(ev.pointerId);
            bar.classList.add('dragging');
            // 끄는 쪽 끝에 배지를 둔다 — 시작일을 끌면 왼쪽 끝, 마감일을 끌면 오른쪽 끝, 통째로 옮기면 가운데.
            const paint = () => {
                const x = xOf(dFrom), w = wOf(dFrom, dTo);
                bar.style.left = x + 'px';
                bar.style.width = w + 'px';
                const range = pjvTlFmt(dFrom) + ' – ' + pjvTlFmt(dTo);
                dragTip.textContent = range + ' · ' + (Math.round((dTo - dFrom) / PJV_TL_DAY) + 1) + '일';
                dragTip.style.left = (mode === 'l' ? x : mode === 'r' ? x + w : x + w / 2) + 'px';
                if (rangeEl)
                    rangeEl.textContent = range; // 좌측 시트의 기간도 같이 따라간다
            };
            (bar.parentElement || bar).append(dragTip);
            paint();
            const onMove = (mv) => {
                const dd = Math.round((mv.clientX - startX) / dayPx);
                if (mode === 'move') {
                    dFrom = span.from + dd * PJV_TL_DAY;
                    dTo = span.to + dd * PJV_TL_DAY;
                }
                else if (mode === 'l')
                    dFrom = Math.min(span.from + dd * PJV_TL_DAY, span.to);
                else
                    dTo = Math.max(span.to + dd * PJV_TL_DAY, span.from);
                paint();
            };
            const onUp = () => {
                grip.removeEventListener('pointermove', onMove);
                grip.removeEventListener('pointerup', onUp);
                bar.classList.remove('dragging');
                dragTip.remove();
                if (dFrom !== span.from || dTo !== span.to)
                    saveSpan(n, dFrom, dTo);
                else if (rangeEl)
                    rangeEl.textContent = pjvTlFmt(span.from) + ' – ' + pjvTlFmt(span.to);
            };
            grip.addEventListener('pointermove', onMove);
            grip.addEventListener('pointerup', onUp);
        });
    };
    // 빈 트랙 클릭 → 그 날짜부터 기본 기간으로 일정 생성(ClickUp 의 Click to Schedule).
    const makeTrack = (n, hint) => {
        const track = el('div', { class: 'pjv-gt-track' + (hint ? ' schedulable' : ''), style: 'width:' + trackW + 'px' });
        if (hint) {
            track.title = '클릭하면 그 날짜부터 ' + PJV_GT_NEW_DAYS + '일 일정이 잡힙니다';
            track.onclick = (e) => {
                const rect = track.getBoundingClientRect();
                const d0 = dayAt(e.clientX - rect.left);
                saveSpan(n, d0, d0 + (PJV_GT_NEW_DAYS - 1) * PJV_TL_DAY);
            };
        }
        return track;
    };
    const bodyEl = el('div', { class: 'pjv-gt-body' });
    // ── 의존선(#1308) ────────────────────────────────────────────────────────
    //  선을 그리려면 두 끝점의 **화면 좌표**가 필요하다. x 는 바를 만들 때 여기 적어 두고, y 는 렌더가 끝난 뒤
    //  행 순서에서 계산한다(모든 행이 PJV_GT_ROW_H 고정이라 index × 높이면 정확하고, 접힘·필터로 행이 빠져도
    //  DOM 순서가 곧 진실이다).
    const nodeX = new Map();
    // 엣지 방향 규약(서버와 동일): from = 후행(blocked) · to = 선행(blocking).
    const linkEdge = (fromId, toId, unlink) => {
        if (fromId === toId) {
            toast('자기 자신에는 의존을 걸 수 없습니다', true);
            return;
        }
        api('/api/ui/v6/projects/' + fromId + '/link', { method: 'POST', body: JSON.stringify({ to: toId, relation: 'depends_on', unlink: !!unlink }) })
            .then(() => { pjvTlClearTasks(); rerender(); })
            .catch((e) => toast((unlink ? '의존 해제 실패 — ' : '의존 연결 실패 — ') + e.message, true));
    };
    // connector 노드 드래그 — 바 양 끝 바깥의 원을 잡아 다른 바에 놓으면 그 둘 사이에 의존이 걸린다.
    //  놓는 지점 판정은 elementFromPoint → 가장 가까운 바. 드래그 중엔 점선 고스트가 커서를 따라온다.
    const attachLinkNode = (nd, n, side) => {
        nd.addEventListener('pointerdown', (ev) => {
            if (ev.button !== 0)
                return;
            ev.preventDefault();
            ev.stopPropagation();
            nd.setPointerCapture(ev.pointerId);
            const ghost = el('div', { class: 'pjv-gt-linkghost' });
            document.body.append(ghost);
            const paint = (mv) => {
                const r0 = nd.getBoundingClientRect();
                const x0 = r0.left + r0.width / 2, y0 = r0.top + r0.height / 2;
                const dx = mv.clientX - x0, dy = mv.clientY - y0;
                ghost.style.left = x0 + 'px';
                ghost.style.top = y0 + 'px';
                ghost.style.width = Math.hypot(dx, dy) + 'px';
                ghost.style.transform = 'rotate(' + Math.atan2(dy, dx) + 'rad)';
            };
            const onMove = (mv) => paint(mv);
            const onUp = (up) => {
                nd.removeEventListener('pointermove', onMove);
                nd.removeEventListener('pointerup', onUp);
                ghost.remove();
                const hit = document.elementFromPoint(up.clientX, up.clientY);
                const bar = hit && hit.closest ? hit.closest('.pjv-gt-bar') : null;
                const otherId = bar && bar.dataset && bar.dataset.nid ? Number(bar.dataset.nid) : 0;
                if (!otherId || otherId === Number(n.row.id))
                    return;
                // 오른쪽 노드에서 끌었다 = 이 노드가 선행(끝나야 상대가 시작) / 왼쪽 = 이 노드가 후행.
                if (side === 'r')
                    linkEdge(otherId, n.row.id);
                else
                    linkEdge(n.row.id, otherId);
            };
            nd.addEventListener('pointermove', onMove);
            nd.addEventListener('pointerup', onUp);
            paint(ev);
        });
    };
    // ── 한 노드 = 한 행(#1305). 프로젝트·태스크·하위 태스크가 같은 규칙으로 그려진다 — 다른 건 들여쓰기와
    //  바 두께뿐이다(색은 상태 축이 이미 쓰고 있어 위계에 또 쓰면 읽을 수 없게 된다). ──
    const renderNode = (n) => {
        const row = n.row;
        const key = 'n' + row.id;
        const collapsed = pjvTlState.collapsed.has(key);
        const overdue = row.due_date && row.status !== 'done' && Date.parse(row.due_date) < today;
        const openDetail = () => {
            if (n.kind === 'project') {
                location.hash = '#/projects2/p/' + row.id;
                return;
            }
            // 모달에서 기간·상태를 고치고 닫으면 캐시가 낡는다 — 목록 리로드에 태스크 캐시 비우기를 묶어 함께 되돌아온다.
            pjvOpenTaskModal(row.id, () => { pjvTlClearTasks(); reload(); });
        };
        const r = el('div', { class: 'pjv-gt-row' + (n.kind === 'project' ? ' proj' : ''), 'data-nid': String(row.id) });
        // 부모 범위 이탈(#1308) — 자기 계획은 있는데 하위가 그 밖으로 삐져나간 경우. 종전엔 롤업이 조용히
        //  넓어질 뿐이라 "부모 마감 안에 안 들어온다"는 사실이 화면에 드러나지 않았다.
        const outOfRange = n.own && n.span && (n.span.from < n.own.from || n.span.to > n.own.to);
        // 기간 — 자기 계획이 있으면 그것, 없으면 하위에서 걷은 롤업(연하게), 둘 다 없으면 '미정'.
        const rangeEl = el('span', {
            class: 'pjv-gt-range' + (overdue ? ' overdue' : '') + (n.own ? '' : (n.span ? ' roll' : ' none')),
            text: n.own ? (pjvTlFmt(n.own.from) + ' – ' + pjvTlFmt(n.own.to))
                : n.span ? (pjvTlFmt(n.span.from) + ' – ' + pjvTlFmt(n.span.to)) : '미정',
        });
        // caret — 하위가 있을 때만 누를 수 있다. 없으면 같은 폭의 자리표시자를 둬 이름 시작선이 층마다 흔들리지 않게.
        const caret = n.children.length
            ? el('button', { class: 'pjv-gt-caret' + (collapsed ? ' off' : ''), type: 'button', 'aria-label': '접기/펼치기', text: '▾' })
            : el('span', { class: 'pjv-gt-caret ghost', 'aria-hidden': 'true' });
        if (n.children.length) {
            caret.onclick = (e) => {
                e.stopPropagation();
                if (collapsed)
                    pjvTlState.collapsed.delete(key);
                else
                    pjvTlState.collapsed.add(key);
                rerender();
            };
        }
        // 이름 클릭 = 상세. 바 더블클릭만으로는 **바가 없는 행**(일정 미정·롤업만)을 열 방법이 없다.
        const nameEl = el('span', { class: 'pjv-gt-name link' + (n.kind === 'project' ? '' : ' task'), text: row.name, title: row.name });
        nameEl.onclick = (e) => { e.stopPropagation(); openDetail(); };
        r.append(el('div', { class: 'pjv-gt-sheet', style: 'width:' + PJV_GT_SHEET_W + 'px;padding-left:' + (10 + n.depth * 15) + 'px' }, caret, pjvStatusIconStd(row.status), nameEl, n.children.length ? el('span', { class: 'pjv-gt-count', text: n.done + '/' + n.children.length }) : null, outOfRange ? el('span', { class: 'pjv-gt-warn', text: '⚠',
            title: '하위 일정이 이 항목의 기간(' + pjvTlFmt(n.own.from) + ' – ' + pjvTlFmt(n.own.to) + ')을 벗어납니다 — 하위 전체는 '
                + pjvTlFmt(n.span.from) + ' – ' + pjvTlFmt(n.span.to) }) : null, rangeEl));
        // 트랙 — 자기 계획이 없으면 클릭해 그 자리에 잡을 수 있다(롤업이 보여도 '자기 일정'은 아직 없는 것).
        const track = makeTrack(n, !n.own);
        // 실적 띠(옵션) — 계획 뒤에 흐리게 깔아 '계획 대비 실제'를 대조한다.
        if (pjvTlState.showActual) {
            const a = pjvGtActual(row);
            if (a)
                track.append(el('div', { class: 'pjv-gt-actual', style: 'left:' + xOf(a.from) + 'px;width:' + wOf(a.from, a.to) + 'px',
                    title: '실제 진행: ' + pjvTlFmt(a.from) + ' – ' + pjvTlFmt(a.to) }));
        }
        if (n.own) {
            const x = xOf(n.own.from), w = wOf(n.own.from, n.own.to);
            const bar = el('div', {
                class: 'pjv-gt-bar' + (row.status === 'done' ? ' done' : '') + (overdue ? ' overdue' : '')
                    + (n.depth ? ' lv' + Math.min(n.depth, 2) : ''),
                style: 'left:' + x + 'px;width:' + w + 'px', tabindex: '0', 'data-nid': String(row.id),
                title: row.name + '\n' + pjvTlFmt(n.own.from) + ' → ' + pjvTlFmt(n.own.to)
                    + ' (' + (Math.round((n.own.to - n.own.from) / PJV_TL_DAY) + 1) + '일)'
                    + (overdue ? ' · 마감 초과' : '') + '\n끌어서 일정 변경 · 더블클릭으로 상세 · 우클릭으로 메뉴',
            });
            nodeX.set(Number(row.id), { x, w }); // 의존선이 이 좌표로 두 바를 잇는다(#1308)
            bar.ondblclick = openDetail;
            bar.addEventListener('keydown', (ev) => { if (ev.key === 'Enter')
                openDetail(); });
            // 우클릭 — 잡은 자리에서 일정을 물린다. 계획은 세우는 것만큼 **무르는 것**도 차트 안에서 끝나야 한다
            //  (지우려고 상세까지 들어가 날짜 필드를 두 번 비우게 하지 않는다).
            bar.oncontextmenu = (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                pjvGtBarMenu(ev, n, savePatch, openDetail, { linkEdge, nodes: flatNodes, edges: pjvTlTasks.edges });
            };
            const hl = el('div', { class: 'pjv-gt-handle l' });
            const hr = el('div', { class: 'pjv-gt-handle r' });
            bar.append(hl, hr);
            // connector 노드(#1308) — 바 **바깥** 양 끝의 원. 리사이즈 핸들(바 안쪽 그립)과 자리가 겹치지 않아야
            //  "늘리기"와 "잇기"가 헷갈리지 않는다(클릭업도 같은 배치).
            const ndL = el('div', { class: 'pjv-gt-node l', title: '끌어서 다른 작업에 놓으면 그 작업이 선행이 됩니다' });
            const ndR = el('div', { class: 'pjv-gt-node r', title: '끌어서 다른 작업에 놓으면 이 작업이 선행이 됩니다' });
            attachLinkNode(ndL, n, 'l');
            attachLinkNode(ndR, n, 'r');
            bar.append(ndL, ndR);
            attachDrag(bar, bar, n, n.own, 'move', rangeEl);
            attachDrag(hl, bar, n, n.own, 'l', rangeEl);
            attachDrag(hr, bar, n, n.own, 'r', rangeEl);
            const asg = pjvAssignees(row).slice(0, 2);
            if (asg.length) {
                const faces = el('div', { class: 'pjv-gt-faces', style: 'left:' + (x + w + 6) + 'px' });
                for (const id of asg)
                    faces.append(personFace(id, 'pjv-ava', id));
                track.append(faces);
            }
            track.append(bar);
        }
        else if (n.span) {
            // 롤업 — 자기 계획은 없고 하위에만 있다. 접어 둔 채로도 "그 안의 일정이 어디쯤인지"가 보이게 얇은 띠로.
            //  클릭은 트랙으로 흘려보낸다(pointer-events:none) — 이 자리를 눌러 자기 일정을 잡을 수 있어야 하므로.
            const pct = n.children.length ? Math.round((n.done / n.children.length) * 100) : 0;
            const roll = el('div', { class: 'pjv-gt-roll node', style: 'left:' + xOf(n.span.from) + 'px;width:' + wOf(n.span.from, n.span.to) + 'px',
                title: row.name + ' — 하위 일정 ' + pjvTlFmt(n.span.from) + ' – ' + pjvTlFmt(n.span.to) + ' · ' + pct + '% (' + n.done + '/' + n.children.length + ')' });
            roll.append(el('div', { class: 'pjv-gt-roll-fill', style: 'width:' + pct + '%' }));
            track.append(roll);
        }
        r.append(track);
        bodyEl.append(r);
        if (!collapsed)
            for (const c of n.children)
                renderNode(c);
    };
    // ── 차트 본문 — 일정이 있는 것들 ──
    for (const g of groups) {
        const collapsed = pjvTlState.collapsed.has(g.key);
        const gr = el('div', { class: 'pjv-gt-row group' });
        const caret = el('button', { class: 'pjv-gt-caret' + (collapsed ? ' off' : ''), type: 'button', 'aria-label': '접기/펼치기', text: '▾' });
        caret.onclick = (e) => {
            e.stopPropagation();
            if (collapsed)
                pjvTlState.collapsed.delete(g.key);
            else
                pjvTlState.collapsed.add(g.key);
            rerender();
        };
        gr.append(el('div', { class: 'pjv-gt-sheet', style: 'width:' + PJV_GT_SHEET_W + 'px' }, caret, el('span', { class: 'pjv-gt-dot', style: g.color ? ('background:' + g.color) : '' }), el('span', { class: 'pjv-gt-name group', text: g.name }), el('span', { class: 'pjv-gt-count', text: g.done + '/' + g.rows.length }), el('span', { class: 'pjv-gt-range', text: pjvTlFmt(g.from) + ' – ' + pjvTlFmt(g.to) })));
        const gtrack = el('div', { class: 'pjv-gt-track', style: 'width:' + trackW + 'px' });
        const roll = el('div', { class: 'pjv-gt-roll', style: 'left:' + xOf(g.from) + 'px;width:' + wOf(g.from, g.to) + 'px',
            title: g.name + ' — ' + g.pct + '% (' + g.done + '/' + g.rows.length + ')' });
        roll.append(el('div', { class: 'pjv-gt-roll-fill', style: 'width:' + g.pct + '%' }));
        gtrack.append(roll);
        gr.append(gtrack);
        bodyEl.append(gr);
        if (collapsed)
            continue;
        for (const n of g.rows)
            renderNode(n);
    }
    // ── ② 일정 없음 — 숨기지 않고 쌓아 둔다. 트랙을 클릭하면 그 자리에서 계획이 된다. ──
    if (unscheduled.length) {
        const key = '__unscheduled__';
        const collapsed = pjvTlState.collapsed.has(key);
        const hr = el('div', { class: 'pjv-gt-row group unsched' });
        const caret = el('button', { class: 'pjv-gt-caret' + (collapsed ? ' off' : ''), type: 'button', text: '▾' });
        caret.onclick = (e) => {
            e.stopPropagation();
            if (collapsed)
                pjvTlState.collapsed.delete(key);
            else
                pjvTlState.collapsed.add(key);
            rerender();
        };
        hr.append(el('div', { class: 'pjv-gt-sheet', style: 'width:' + PJV_GT_SHEET_W + 'px' }, caret, el('span', { class: 'pjv-gt-name group', text: '일정 없음' }), el('span', { class: 'pjv-gt-count', text: String(unscheduled.length) })), el('div', { class: 'pjv-gt-track', style: 'width:' + trackW + 'px' }, el('div', { class: 'pjv-gt-unsched-hint', text: '오른쪽 빈 칸을 클릭하면 그 날짜로 일정이 잡힙니다' })));
        bodyEl.append(hr);
        if (!collapsed) {
            // 여기 있는 것들은 자기도 하위도 일정이 없다 — 그래도 하위 작업은 펼쳐 볼 수 있다(그 자리에서 바로 계획).
            for (const n of unscheduled.slice(0, 200))
                renderNode(n);
            if (unscheduled.length > 200) {
                bodyEl.append(el('div', { class: 'pjv-gt-more', text: '외 ' + (unscheduled.length - 200) + '개 — 필터로 좁혀 보세요' }));
            }
        }
    }
    inner.append(bodyEl);
    // ── 의존선(#1308) — 렌더가 끝난 뒤 한 번에. x 는 바를 만들며 적어 둔 nodeX, y 는 DOM 행 순서에서. ──
    //  두 끝점이 **모두 지금 화면에 그려진 바**일 때만 그린다 — 접혀 있거나 일정이 없어 바가 없는 쪽은
    //  이을 좌표가 없다(억지로 부모 행에 모아 그리면 없는 관계를 있는 것처럼 보여준다).
    {
        const rowEls = Array.from(bodyEl.children);
        const yOf = new Map();
        rowEls.forEach((elm, i) => {
            const nid = elm.dataset && elm.dataset.nid;
            if (nid)
                yOf.set(Number(nid), i * PJV_GT_ROW_H + PJV_GT_ROW_H / 2);
        });
        const links = pjvTlTasks.edges.filter((e) => nodeX.has(e.from_id) && nodeX.has(e.to_id) && yOf.has(e.from_id) && yOf.has(e.to_id));
        if (links.length) {
            const svg = sv('svg', { class: 'pjv-gt-links',
                style: 'left:' + PJV_GT_SHEET_W + 'px;width:' + trackW + 'px;height:' + (rowEls.length * PJV_GT_ROW_H) + 'px' });
            for (const e of links) {
                const a = nodeX.get(e.to_id), b = nodeX.get(e.from_id); // to=선행, from=후행
                const ay = yOf.get(e.to_id), by = yOf.get(e.from_id);
                const ax = a.x + a.w, bx = b.x; // 선행 오른쪽 끝 → 후행 왼쪽 끝
                const gap = 12;
                // 후행이 선행보다 왼쪽에 있으면(=계획이 거꾸로 잡힌 상태) 바 사이를 가로지르지 말고 크게 돌아 나간다.
                const d = bx - ax >= gap * 2
                    ? `M${ax} ${ay} H${(ax + bx) / 2} V${by} H${bx}`
                    : `M${ax} ${ay} h${gap} V${(ay + by) / 2} H${bx - gap} V${by} H${bx}`;
                svg.append(sv('path', { class: 'pjv-gt-link', d }));
                // 굵고 투명한 히트 경로 — 1px 선은 손으로 못 누른다. 누르면 해제 메뉴.
                const hit = sv('path', { class: 'pjv-gt-link-hit', d });
                hit.addEventListener('click', (ev) => { ev.stopPropagation(); pjvGtLinkMenu(ev, e, linkEdge); });
                svg.append(hit);
                svg.append(sv('polygon', { class: 'pjv-gt-arrow', points: `${bx},${by} ${bx - 7},${by - 4.5} ${bx - 7},${by + 4.5}` }));
            }
            inner.append(svg);
        }
    }
    // ── 오늘 — 세로선 + 배지 ──
    const tx = PJV_GT_SHEET_W + xOf(today);
    inner.append(el('div', { class: 'pjv-gt-todayline', style: 'left:' + tx + 'px' }));
    inner.append(el('div', { class: 'pjv-gt-todaybadge', style: 'left:' + tx + 'px', text: '오늘' }));
    scroller.append(inner);
    wrap.append(scroller);
    // 처음 화면 = 오늘이 왼쪽 1/4 쯤. 간트는 '지금부터 앞으로'가 주 무대다.
    const jumpToday = () => { scroller.scrollLeft = Math.max(0, xOf(today) - scroller.clientWidth / 4); };
    todayBtn.onclick = (e) => { e.stopPropagation(); jumpToday(); };
    setTimeout(jumpToday, 0);
    return wrap;
}
// 커서 자리 앵커 — pjvPopover 는 '엘리먼트' 기준으로 위치를 잡으므로 우클릭 지점에 둘 자리표시자가 필요하다.
//  하나를 옮겨 쓴다: pjvPopover 에 닫힘 훅이 없어 매번 만들면 body 에 유령 앵커가 쌓인다.
let pjvCursorSpotEl = null;
function pjvCursorSpot(x, y) {
    if (!pjvCursorSpotEl || !pjvCursorSpotEl.isConnected) {
        pjvCursorSpotEl = el('div', { class: 'pjv-cursor-spot' });
        document.body.append(pjvCursorSpotEl);
    }
    pjvCursorSpotEl.style.left = x + 'px';
    pjvCursorSpotEl.style.top = y + 'px';
    return pjvCursorSpotEl;
}
// 간트 바 우클릭 메뉴 — 세운 계획을 차트 안에서 그대로 무른다.
//  날짜를 비울 땐 null 을 보낸다(서버 parseDateOrNull: null·"" → 컬럼 NULL). 지우면 그 프로젝트는
//  사라지는 게 아니라 좌측 '일정 없음' 그룹으로 되돌아간다 — 계획 취소지 삭제가 아니다.
//  #1305 이후 인자는 '노드'다 — 프로젝트든 태스크든 같은 메뉴를 쓰고, 저장 경로(savePatch)와 상세 열기
//  (openDetail)만 호출부가 층에 맞게 넘긴다.
function pjvGtBarMenu(ev, n, savePatch, openDetail, dep) {
    const menu = el('div', { class: 'pjv-menu' });
    const spot = pjvCursorSpot(ev.clientX, ev.clientY);
    const close = pjvPopover(spot, menu);
    const mk = (label, fn, danger) => {
        const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label }));
        b.onclick = () => { close(); fn(); };
        return b;
    };
    menu.append(mk('일정 지우기', () => savePatch(n, { start_date: null, due_date: null }), true));
    // 한쪽만 지우는 건 양쪽이 다 있을 때만 의미가 있다(하나뿐이면 '일정 지우기'와 같은 동작).
    if (n.row.start_date && n.row.due_date) {
        menu.append(mk('시작일만 지우기', () => savePatch(n, { start_date: null })));
        menu.append(mk('마감일만 지우기', () => savePatch(n, { due_date: null })));
    }
    // 의존(#1308) — connector 노드를 끄는 것과 같은 결과를 메뉴로도 만든다. 드래그는 빠르고, 메뉴는 정확하다
    //  (먼 곳에 있거나 스크롤 밖에 있는 작업은 끌어다 놓을 수가 없다).
    if (dep) {
        menu.append(mk('이 작업의 선행 지정…', () => pjvGtDepPicker(spot, n, dep, true)));
        menu.append(mk('이 작업의 후행 지정…', () => pjvGtDepPicker(spot, n, dep, false)));
        const mine = (dep.edges || []).filter((e) => e.from_id === Number(n.row.id) || e.to_id === Number(n.row.id));
        if (mine.length) {
            menu.append(mk('걸린 의존 ' + mine.length + '건 모두 해제', () => {
                for (const e of mine)
                    dep.linkEdge(e.from_id, e.to_id, true);
            }, true));
        }
    }
    menu.append(mk('상세 열기', openDetail));
    return close;
}
// 의존 대상 고르기(#1308) — 지금 트리에 있는 작업을 이름으로 좁혀 고른다.
//  asPredecessor=true 면 고른 것이 **선행**(이 작업이 그것에 의존), false 면 고른 것이 **후행**.
function pjvGtDepPicker(anchor, n, dep, asPredecessor) {
    const search = el('input', { type: 'text', class: 'pjv-rename-input', placeholder: '작업 이름으로 찾기…' });
    const listBox = el('div', { class: 'pjv-gt-deplist' });
    const pop = el('div', { class: 'pjv-menu pjv-gt-deppick' }, el('div', { class: 'pjv-subtask-pop-head', text: asPredecessor ? '먼저 끝나야 할 작업 고르기' : '이 작업 뒤에 올 작업 고르기' }), search, listBox);
    const close = pjvPopover(anchor, pop);
    const rebuild = () => {
        const q = search.value.trim().toLowerCase();
        const items = (dep.nodes || [])
            .filter((x) => Number(x.row.id) !== Number(n.row.id) && (!q || String(x.row.name).toLowerCase().includes(q)))
            .slice(0, 40);
        listBox.replaceChildren();
        for (const x of items) {
            const b = el('button', { class: 'pjv-menu-item', type: 'button' }, el('span', { class: 'pjv-gt-depname', text: x.row.name, title: x.row.name }));
            b.onclick = () => {
                close();
                if (asPredecessor)
                    dep.linkEdge(n.row.id, x.row.id); // from=이 작업(후행), to=고른 것(선행)
                else
                    dep.linkEdge(x.row.id, n.row.id);
            };
            listBox.append(b);
        }
        if (!items.length)
            listBox.append(el('div', { class: 'pjv-menu-empty', text: '해당하는 작업이 없습니다' }));
    };
    search.addEventListener('input', rebuild);
    rebuild();
    setTimeout(() => search.focus(), 0);
    return close;
}
// 의존선 클릭 메뉴(#1308) — 선은 '해제'가 유일한 조작이라 확인 한 단계만 둔다.
function pjvGtLinkMenu(ev, edge, linkEdge) {
    const menu = el('div', { class: 'pjv-menu' });
    const close = pjvPopover(pjvCursorSpot(ev.clientX, ev.clientY), menu);
    const b = el('button', { class: 'pjv-menu-item danger', type: 'button' }, el('span', { text: '이 의존 해제' }));
    b.onclick = () => { close(); linkEdge(edge.from_id, edge.to_id, true); };
    menu.append(b);
    return close;
}
// 테이블 기본 정렬 — 평면과 같은 규칙(진행 중 → 할 일 → 완료, 같으면 최신 갱신순).
function pjvTableDefaultCmp(a, b) {
    const rank = (p) => p.status === 'done' ? 2 : (p.status === 'todo' ? 1 : 0);
    return rank(a) - rank(b) || (Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0));
}
export { PJV_GT_NEW_DAYS, PJV_GT_ROW_H, PJV_GT_SHEET_W, PJV_TL_DAY, PJV_TL_DEPTHS, PJV_TL_SCALES, pjvCursorSpot, pjvCursorSpotEl, pjvGtActual, pjvGtBarMenu, pjvGtDepPicker, pjvGtLinkMenu, pjvGtPlan, pjvTableDefaultCmp, pjvTimelineView, pjvTlClearTasks, pjvTlDayStart, pjvTlFetchTasks, pjvTlFmt, pjvTlISO, pjvTlScale, pjvTlState, pjvTlTasks, };

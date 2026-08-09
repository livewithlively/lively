// dash/widget-lively-log.ts — ⑧ 내 라이블리 사용 내역(브리핑) + ⑨ 라이블리 로그(타임라인) (#1570).
//  요구 원문(윤상민): "라이블리 딴에서 한 작업들의 목록/통계가 보이면 좋겠다" → 디자인 시안 4종
//  (lvlog-designs.html) 중 **A 브리핑**을 기본 위젯으로 확정, **D 정돈된 로그**도 별도 위젯으로 유지.
//   · lvlog(브리핑) — 문장 리드 + 스탯 타일 3 + 활동 구성 스택바 + 많이 기댄 지식. 기본 배치 3열 상단.
//   · lvlogd(로그) — KPI 스트립 + 시간순 감사 로그(사람 말 번역·연속 중복 접기). 기본 숨김(편집에서 꺼냄).
//
//  ── 지키는 것 ──
//   ① 기록이지 주장이 아니다 — 문구는 일어난 일만. 자화자찬 배지 금지.
//   ② 쉬운 말 — 툴 이름(knowledge_get)은 사람 말이 아니다. 여기서 번역한다.
//   ③ 유형 4색(blue·mint-deep·violet·coral)은 CVD 검증 통과 조합 — 라벨 병기 필수(coral 대비 2.9:1).
//   ④ '팀 전체' 범위와 빈 화면 사유 문구는 있었다가 **사용자 반려로 제거**됐다 — 재도입 금지.
//  ⚠ '읽음'은 knowledge_get(본문을 실제로 연 것)만 — 훅 자동회수(주입)는 주입≠사용이라 세면 과대계상.
//  ⚠ 기간 단위 — mcp_call_log 에 session_id 가 없어 '이 세션에서'로는 못 묶는다(#1578).
import { api, el, errorNote } from '../core.js';
import { dashChips, dashCtl, myDisplayName } from './chrome.js';
const LVL_WINDOWS = [['24h', '24시간'], ['7d', '7일'], ['30d', '30일']];
const PAGE = 120;
function n(v) { return Number(v || 0).toLocaleString('ko-KR'); }
// 유형 축 — 색은 20-dashboard.css 의 기존 톤 어휘(tn-*)와 같은 값. 구성 바·범례·KPI·로그 점이 전부 이 한 벌.
const KINDS = [
    { keys: ['knowledge_read'], label: '지식 읽음', cls: 'k-read' },
    { keys: ['knowledge_write'], label: '지식 기록', cls: 'k-write' },
    { keys: ['project', 'task', 'activity'], label: '프로젝트·할 일', cls: 'k-work' },
    { keys: ['db'], label: 'DB 조회', cls: 'k-db' },
    { keys: ['context', 'infra', 'other'], label: '기타', cls: 'k-etc' },
];
const kindCls = (kind) => (KINDS.find((g) => g.keys.includes(kind)) || KINDS[4]).cls;
// 기간 → 리드 문장 접두 / 증감 비교 라벨.
const WIN_WORD = { '24h': ['오늘', '어제보다'], '7d': ['이번 주', '지난주보다'], '30d': ['이번 달', '지난달보다'] };
// ── ⑧ 브리핑(lvlog) — 시안 A ──────────────────────────────────────────────────────────────────
async function fillLivelyLog(zone) {
    let win = '7d';
    const draw = async () => {
        let d;
        try {
            d = await api('/api/ui/me/lively-log?window=' + encodeURIComponent(win) + '&limit=1');
        }
        catch (e) {
            zone.body.replaceChildren(errorNote(e, '사용 내역을 불러오지 못했습니다'));
            return;
        }
        const s = d.summary || {};
        const bg = d.background || null;
        const dbQ = (d.dbAccess || []).reduce((a, r) => a + Number(r.queries || 0), 0);
        const dbRows = (d.dbAccess || []).reduce((a, r) => a + Number(r.rows_read || 0), 0);
        zone.countEl.textContent = n(d.event_total);
        dashChips(zone.chipsEl, LVL_WINDOWS, win, (k) => { win = k; draw(); });
        const box = el('div', { class: 'dash-lvl' });
        const [word, prevWord] = WIN_WORD[win] || WIN_WORD['7d'];
        if (!Number(d.event_total)) {
            box.append(el('div', { class: 'dash-lvl-why', text: '이 기간에는 라이블리가 관여한 기록이 없어요.' }));
            zone.body.replaceChildren(box);
            return;
        }
        // 리드 — 이 기간을 문장으로. 숫자는 <b>로만 세운다(색 강조 금지 — 잉크 위계).
        //  "XX님의 AI 세션에서" — 이 내역이 누구의 작업에서 나온 것인지 주어를 박는다(사용자 요청 2026-08-09).
        //  표시명이 없어 폴백('나')이면 '내 AI 세션에서'로 자연스럽게.
        const who = myDisplayName();
        const whoPhrase = who && who !== '나' ? who + '님의 AI 세션에서 ' : '내 AI 세션에서 ';
        const lead = el('div', { class: 'dash-lvl-lead' });
        const seg = [word + ' 라이블리는 ' + whoPhrase];
        if (s.knowledge_titles) {
            seg.push('조직 지식 ', el('b', { text: n(s.knowledge_titles) + '건' }), '을 답변 근거로 꺼냈');
        }
        if (s.knowledge_saved) {
            seg.push(s.knowledge_titles ? '고, 새 지식 ' : '새 지식 ', el('b', { text: n(s.knowledge_saved) + '건' }), '을 남겼어요.');
        }
        else if (s.knowledge_titles)
            seg.push('어요.');
        else
            seg.push('도구 호출 ', el('b', { text: n(s.calls) + '건' }), '을 처리했어요.');
        if (bg && (Number(bg.sources_ingested) || Number(bg.distilled))) {
            seg.push(' 밤사이 자료 ', el('b', { text: n(bg.sources_ingested) + '건' }), '이 수집');
            if (Number(bg.distilled))
                seg.push('돼 지식 ', el('b', { text: n(bg.distilled) + '건' }), '으로 증류됐어요.');
            else
                seg.push('됐어요.');
        }
        lead.append(...seg);
        box.append(lead);
        // 스탯 타일 3 — 값 + 라벨 + 보조(증감/행수). 증감은 직전 같은 길이 구간 대비(전체 기간이면 숨김).
        const delta = (curr, prev) => {
            if (win === 'all' || (!curr && !prev))
                return '';
            const df = curr - prev;
            return df === 0 ? prevWord.replace('보다', '와') + ' 비슷' : `${prevWord} ${df > 0 ? '+' : ''}${n(df)}`;
        };
        box.append(el('div', { class: 'dash-lvl-tiles' }, el('div', { class: 'dash-lvl-tile' }, el('div', { class: 'v', text: n(s.knowledge_titles) }), el('div', { class: 'l', text: '근거로 쓴 지식' }), el('div', { class: 'd', text: delta(Number(s.knowledge_titles), Number(s.prev_knowledge_titles)) })), el('div', { class: 'dash-lvl-tile' }, el('div', { class: 'v', text: n(s.knowledge_saved) }), el('div', { class: 'l', text: '새로 남긴 지식' }), el('div', { class: 'd', text: delta(Number(s.knowledge_saved), Number(s.prev_knowledge_saved)) })), el('div', { class: 'dash-lvl-tile' }, el('div', { class: 'v', text: n(dbQ) }), el('div', { class: 'l', text: '조직 DB 조회' }), el('div', { class: 'd', text: dbRows ? n(dbRows) + '행' : '' }))));
        // 활동 구성 — 유형별 스택 바(2px 갭) + 범례(수치 병기 — coral 대비 부족을 라벨이 메운다).
        const counts = new Map();
        for (const k of d.kinds || [])
            counts.set(kindCls(k.kind), (counts.get(kindCls(k.kind)) || 0) + Number(k.calls || 0));
        const groups = KINDS.map((g) => ({ ...g, v: counts.get(g.cls) || 0 })).filter((g) => g.v > 0);
        const total = groups.reduce((a, g) => a + g.v, 0);
        if (total) {
            box.append(el('div', { class: 'dash-task-gh' }, el('span', { text: '활동 구성' }), el('span', { class: 'dash-task-gn', text: n(total) + '건' })));
            box.append(el('div', { class: 'dash-lvl-comp' }, ...groups.map((g) => el('i', { class: g.cls, style: `flex:${g.v}`, title: `${g.label} ${n(g.v)}` }))));
            box.append(el('div', { class: 'dash-lvl-legend' }, ...groups.map((g) => el('span', {}, el('i', { class: 'dash-dot-s ' + g.cls }), `${g.label} `, el('b', { text: n(g.v) })))));
        }
        // 가장 많이 기댄 지식 — top 3. 행 = 지식 문서 링크(#/k/<name> — 전역 '지식 문서 열기' 정주소).
        const reads = (d.reads || []).slice(0, 3);
        if (reads.length) {
            box.append(el('div', { class: 'dash-task-gh' }, el('span', { text: '가장 많이 기댄 지식' })));
            const rows = el('div', { class: 'dash-lvl-rows' });
            for (const r of reads) {
                rows.append(el('a', { class: 'dash-lvl-krow', href: '#/k/' + encodeURIComponent(r.name), title: r.name }, el('span', { class: 't', text: r.title || r.name }), el('span', { class: 'v num', text: n(r.reads) + '번' })));
            }
            box.append(rows);
        }
        zone.body.replaceChildren(box);
    };
    dashCtl(zone, { action: { href: '#/knowledge', title: '지식 탭으로' } });
    await draw();
}
// ── ⑨ 라이블리 로그(lvlogd) — 시안 D ─────────────────────────────────────────────────────────
//  툴명 → 사람 말. 자주 흐르는 것부터 명시 매핑(실측 상위 28종을 덮는다), 모르는 툴은 접미사 규칙 폴백.
const VERB = {
    knowledge_get: '지식을 읽었어요',
    knowledge_search: '지식을 찾아봤어요',
    knowledge_grep: '지식을 찾아봤어요',
    knowledge_list: '지식 목록을 봤어요',
    knowledge_save: '지식을 남겼어요',
    knowledge_link_category: '지식을 분류에 연결했어요',
    knowledge_set_lifecycle: '지식 상태를 바꿨어요',
    activity_log: '작업 기록을 남겼어요',
    db_query: '조직 DB를 조회했어요',
    project_get_v6: '프로젝트 맥락을 불러왔어요',
    project_create_v6: '프로젝트를 만들었어요',
    project_update_v6: '프로젝트를 고쳤어요',
    project_set_status_v6: '프로젝트 상태를 바꿨어요',
    project_set_list_v6: '프로젝트를 분류했어요',
    project_set_repos_v6: '프로젝트에 레포를 연결했어요',
    project_link_knowledge_v6: '프로젝트에 지식을 연결했어요',
    project_list_v6: '프로젝트 목록을 봤어요',
    task_create_v6: '할 일을 만들었어요',
    task_update_v6: '할 일을 고쳤어요',
    task_set_status_v6: '할 일 상태를 바꿨어요',
    source_save: '자료를 남겼어요',
    source_list: '자료를 찾아봤어요',
    category_list: '분류 체계를 봤어요',
    category_update: '분류 정의를 고쳤어요',
    preview_env_ensure: '미리보기 환경을 띄웠어요',
    preview_env_set: '미리보기 환경을 설정했어요',
    preview_env_stop: '미리보기 환경을 내렸어요',
    preview_env_list: '미리보기 목록을 봤어요',
    workspace_reclaim: '작업 공간을 정리했어요',
    map_code_unit: '코드 구조를 기록했어요',
    delegate_run: '무거운 작업을 다른 컴퓨터에 맡겼어요',
};
function verbOf(tool) {
    if (VERB[tool])
        return VERB[tool];
    if (/_(get|list|search|grep|read|overview)(_v6)?$/.test(tool))
        return '맥락을 조회했어요';
    if (/_(create|save|add|new)(_v6)?$/.test(tool))
        return '새로 만들었어요';
    if (/_(update|set|edit|patch|link)(_v6)?$/.test(tool) || /_set_/.test(tool))
        return '내용을 바꿨어요';
    if (/_(delete|remove|stop|unlink)(_v6)?$/.test(tool))
        return '정리했어요';
    return '작업했어요';
}
// 같은 대상 연속 호출을 ×N 로 접는다 — 실측: 같은 런북을 19번 연속 부른 구간이 있었다(안 접으면 벽).
function fold(events) {
    const out = [];
    for (const e of events) {
        const prev = out[out.length - 1];
        if (prev && prev.tool === e.tool && prev.label === e.label && prev.ok === e.ok) {
            prev.count++;
            continue;
        }
        out.push({ ...e, count: 1 });
    }
    return out;
}
const dayKey = (iso) => { const d = new Date(iso); return d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }); };
const hhmm = (iso) => new Date(iso).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' });
async function fillLivelyLogTimeline(zone) {
    let win = '7d';
    let shown = PAGE;
    const draw = async () => {
        let d;
        try {
            d = await api(`/api/ui/me/lively-log?window=${encodeURIComponent(win)}&limit=${shown}`);
        }
        catch (e) {
            zone.body.replaceChildren(errorNote(e, '로그를 불러오지 못했습니다'));
            return;
        }
        const events = d.events || [];
        const total = Number(d.event_total || 0);
        zone.countEl.textContent = n(total);
        dashChips(zone.chipsEl, LVL_WINDOWS, win, (k) => { win = k; shown = PAGE; draw(); });
        const box = el('div', { class: 'dash-lvl' });
        if (!events.length) {
            box.append(el('div', { class: 'dash-lvl-why', text: '이 기간에는 라이블리가 관여한 기록이 없어요.' }));
            zone.body.replaceChildren(box);
            return;
        }
        // KPI 스트립 — 유형 4칸(값 + 색점 + 라벨). 로그 점과 같은 색 어휘.
        const counts = new Map();
        for (const k of d.kinds || [])
            counts.set(kindCls(k.kind), (counts.get(kindCls(k.kind)) || 0) + Number(k.calls || 0));
        box.append(el('div', { class: 'dash-lvl-kpis' }, ...KINDS.slice(0, 4).map((g) => el('div', { class: 'dash-lvl-kpi' }, el('div', { class: 'v num', text: n(counts.get(g.cls) || 0) }), el('div', { class: 'l' }, el('i', { class: 'dash-dot-s ' + g.cls }), g.label)))));
        // 시간순 로그 — 날짜 머리 + [시각 | 유형점 | 동사 · 대상 | ×N]. 대상이 실존 지식(ref)이면 행이 문서 링크.
        let lastDay = '';
        for (const e of fold(events)) {
            const day = dayKey(e.at);
            if (day !== lastDay) {
                lastDay = day;
                box.append(el('div', { class: 'dash-lvl-day', text: day }));
            }
            const tag = e.ref ? 'a' : 'div';
            const attrs = { class: 'dash-lvl-erow', title: `${e.tool}${e.harness ? ' · ' + e.harness : ''}` };
            if (e.ref)
                attrs.href = '#/k/' + encodeURIComponent(e.ref);
            box.append(el(tag, attrs, el('span', { class: 'tm num', text: hhmm(e.at) }), el('i', { class: 'dash-dot-s ' + kindCls(e.kind) + (e.ok ? '' : ' fail') }), el('span', { class: 'body' }, el('span', { class: 'verb', text: verbOf(e.tool) }), e.label ? el('span', { class: 'obj', text: ' · ' + e.label }) : null), e.count > 1 ? el('span', { class: 'x num', text: '×' + e.count }) : el('span')));
        }
        if (events.length < total) {
            const more = el('button', { class: 'dash-lvl-more', type: 'button', text: `더 보기 (${n(total - events.length)}건 남음)` });
            more.onclick = () => { shown += PAGE; draw(); };
            box.append(more);
        }
        else if (d.retention_days) {
            box.append(el('div', { class: 'dash-lvl-foot', text: `호출 기록은 ${d.retention_days}일간 보관돼요` }));
        }
        zone.body.replaceChildren(box);
    };
    dashCtl(zone, { action: { href: '#/knowledge', title: '지식 탭으로' } });
    await draw();
}
export { fillLivelyLog, fillLivelyLogTimeline };

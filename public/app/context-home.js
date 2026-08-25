// context-home.ts — 맥락 관리의 첫 화면(#1841 전면 재설계, 2026-08-24).
//  원준 지적: "사용자 입장에서 뭐하는건지 감이 안 옴". 원인은 화면이 **기계 이름**(수집기·증류기·분류기·관리기·주입)으로
//  말하고, 첫 화면이 내부 지표(미증류 560건 · 켜진 증류기 0/0)를 먼저 보여준 것이다. 사람이 알고 싶은 건 둘뿐이다:
//   ① 우리 AI 가 지금 무엇을 아나  ② 무엇이 막혀 있고 내가 뭘 하면 되나.
//  그래서 이 화면은 그 둘만 말한다 — 큰 숫자 세 개(아는 것) + 할 일 카드(막힌 것, 사람 말 + 버튼) + 흐름 네 칸.
//  판정은 새로 하지 않는다 — context-pipeline 의 *Health 한 벌(pipelineHealths)을 그대로 쓴다.
import { api, el, relTime } from './core.js';
import { skeleton } from './ui-primitives.js';
import { pipelineHealths } from './context-pipeline.js';
const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('ko-KR') : '—');
const TAB_OF = {
    collect: { href: '#/context/sources/collectors', label: '가져오는 곳 열기' },
    distill: { href: '#/context/knowledge/distillers', label: '지식 만들기 열기' },
    classify: { href: '#/context/topics/categories', label: '갈래 열기' },
    manage: { href: '#/context/checks/findings', label: '점검 열기' },
};
export async function renderContextHome(box) {
    box.replaceChildren(skeleton('맥락 현황을 읽는 중'));
    let d = null;
    try {
        d = await api('/api/ui/org/pipeline');
    }
    catch (e) {
        box.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'admin-hint', text: '현황을 불러오지 못했습니다 — ' + e.message })));
        return;
    }
    const st = (d && d.stages) || {};
    const healths = pipelineHealths(d);
    const byKey = Object.fromEntries(healths.map((h) => [h.key, h]));
    // ── ① 아는 것 — 큰 숫자 셋. "지식이 몇 건인가"가 아니라 "AI 가 쓸 수 있는 게 얼마나 되나". ──
    const known = el('div', { class: 'cxh-know' }, knowCard(fmt(st.classify ? (Number(st.distill?.output || 0) - Number(st.classify?.backlog || 0)) : st.distill?.output), 'AI 가 찾아 쓸 수 있는 지식', st.classify?.backlog ? '갈래가 없는 ' + fmt(st.classify.backlog) + '건은 검색에 안 잡힙니다' : '전부 갈래가 정해져 있습니다', '#/knowledge'), knowCard(fmt(st.collect?.enabled) + (st.collect?.configured ? ' / ' + fmt(st.collect.configured) : ''), '켜져 있는 연결', st.collect?.recent_24h ? '최근 24시간에 ' + fmt(st.collect.recent_24h) + '건이 들어왔습니다' : '최근 24시간에 새로 들어온 자료가 없습니다', '#/context/sources/collectors'), knowCard(fmt(st.manage?.open?.total), '확인할 것', st.manage?.open?.high ? '그중 중요 ' + fmt(st.manage.open.high) + '건' : '자동 점검이 찾아낸 문제', '#/context/checks/findings'));
    // ── ② 할 일 — 막힌 것만. 사람 말 + 버튼 하나. ──
    const todos = [];
    for (const h of healths) {
        if (h.level === 'ok')
            continue;
        const t = TAB_OF[h.key];
        todos.push({ level: h.level, title: h.label + ' — ' + LEVEL_WORD[h.level], line: h.line, go: t.href, goLabel: t.label });
    }
    // 사람 확인 대기 — 파이프라인이 멀쩡해도 사람이 안 누르면 지식이 갇힌다(가장 흔한 정지 사유).
    const g = (d && d.gates) || {};
    if (Number(g.knowledge_pending) > 0)
        todos.push({ level: 'warn', title: '지식 검토 대기 ' + fmt(g.knowledge_pending) + '건', line: 'AI 가 쓴 지식이 승인 전이라 검색·세션 전달에서 빠져 있습니다. 승인해야 팀이 쓸 수 있습니다.', go: '#/knowledge/review', goLabel: '검토하러 가기' });
    if (Number(g.classification_proposed) > 0)
        todos.push({ level: 'note', title: '갈래 제안 ' + fmt(g.classification_proposed) + '건', line: 'AI 가 갈래를 제안했지만 확신이 낮아 사람 확인을 기다립니다.', go: '#/knowledge/classifications', goLabel: '확인하러 가기' });
    const RANK = { off: 0, warn: 1, note: 2 };
    todos.sort((a, b) => RANK[a.level] - RANK[b.level]);
    const todoBox = el('div', { class: 'cxh-todos' });
    if (!todos.length) {
        todoBox.append(el('div', { class: 'cxh-allok' }, el('b', { text: '지금 손볼 것이 없습니다' }), el('span', { text: '자료가 들어오고, 지식이 되고, 갈래가 정해지고, 점검까지 돌고 있습니다.' })));
    }
    else {
        for (const t of todos)
            todoBox.append(todoCard(t));
    }
    // ── ③ 흐름 네 칸 — 자료가 AI 에 닿기까지. 숫자는 '지금 어디에 얼마나 있나'. ──
    const flow = el('div', { class: 'cxh-flow' }, flowStep('1', '가져오기', st.collect?.output, '모인 자료', byKey.collect, '#/context/sources/collectors'), flowArrow('자료'), flowStep('2', '지식으로', st.distill?.output, '만들어진 지식', byKey.distill, '#/context/knowledge/distillers'), flowArrow('지식'), flowStep('3', '갈래 정하기', st.classify?.categories, '갈래', byKey.classify, '#/context/topics/categories'), flowArrow('분류된 지식'), flowStep('4', '점검', st.manage?.open?.total, '확인할 것', byKey.manage, '#/context/checks/findings'));
    // ── ④ 자동 실행 — "설정했다"와 "돌고 있다"는 다르다(이 제품에서 가장 비쌌던 오해). ──
    const jobs = el('div', { class: 'cxh-jobs' }, el('span', { class: 'cxh-jobs-t', text: '자동 실행' }), jobChip('가져오기', st.collect?.job), jobChip('지식으로', st.distill?.job), jobChip('갈래', st.classify?.job), jobChip('점검', st.manage?.job));
    box.replaceChildren(el('div', { class: 'cxh' }, el('section', { class: 'cxh-sec' }, el('h2', { class: 'cxh-h', text: '우리 AI 가 아는 것' }), known), el('section', { class: 'cxh-sec' }, el('h2', { class: 'cxh-h' }, el('span', { text: '지금 할 일' }), todos.length ? el('span', { class: 'cxh-h-n', text: String(todos.length) }) : null), todoBox), el('section', { class: 'cxh-sec' }, el('h2', { class: 'cxh-h', text: '자료가 AI 에 닿기까지' }), flow, jobs)));
}
const LEVEL_WORD = { off: '멈춰 있습니다', warn: '확인이 필요합니다', note: '살펴볼 것이 있습니다' };
function knowCard(big, label, sub, href) {
    return el('a', { class: 'cxh-know-card', href }, el('b', { class: 'cxh-know-n', text: big }), el('span', { class: 'cxh-know-l', text: label }), el('span', { class: 'cxh-know-s', text: sub }));
}
function todoCard(t) {
    return el('div', { class: 'cxh-todo is-' + t.level }, el('div', { class: 'cxh-todo-body' }, el('b', { class: 'cxh-todo-t', text: t.title }), el('p', { class: 'cxh-todo-l', text: t.line })), el('a', { class: 'btn btn-sm ' + (t.level === 'off' || t.level === 'warn' ? 'btn-primary' : 'btn-ghost'), href: t.go, text: t.goLabel }));
}
function flowStep(n, label, num, numLabel, h, href) {
    const lv = (h && h.level) || 'note';
    return el('a', { class: 'cxh-step is-' + lv, href, title: (h && h.line) || '' }, el('span', { class: 'cxh-step-n', 'aria-hidden': 'true', text: n }), el('span', { class: 'cxh-step-l', text: label }), el('b', { class: 'cxh-step-v', text: fmt(num) }), el('span', { class: 'cxh-step-vl', text: numLabel }), el('span', { class: 'cxh-step-dot', 'aria-hidden': 'true' }));
}
function flowArrow(label) {
    return el('div', { class: 'cxh-arrow', 'aria-hidden': 'true' }, el('span', { class: 'cxh-arrow-l', text: label }), el('span', { class: 'cxh-arrow-a', text: '→' }));
}
// 자동 실행 칩 — 미등록/꺼짐/주기 + 마지막 실행. 개요가 하던 말을 그대로, 더 짧게.
function jobChip(label, job) {
    const state = !job ? 'off' : (!job.any_enabled ? 'off' : 'on');
    const txt = !job ? '미등록' : (!job.any_enabled ? '꺼짐' : intervalText(job.interval_sec) + (job.last_run_at ? ' · ' + relTime(job.last_run_at) : ' · 미실행'));
    return el('span', { class: 'cxh-job is-' + state }, el('i', { class: 'cxh-job-dot', 'aria-hidden': 'true' }), el('b', { text: label }), el('span', { text: txt }));
}
function intervalText(sec) {
    const n = Number(sec) || 0;
    if (!n)
        return '';
    if (n % 3600 === 0)
        return n / 3600 + '시간마다';
    if (n % 60 === 0)
        return n / 60 + '분마다';
    return n + '초마다';
}

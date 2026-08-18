// session-trail.ts — 세션 우패널 "발자취"(#1719): 이 세션에서 AI 가 **읽고 쓴 것**을 한 목록으로.
//
//  상민님 지시(2026-08-18): 우측 지식 위젯을 클래식 '라이블리 로그'(dash/widget-lively-log.ts)를 참고한 맥락 이력 위젯으로 —
//  이 세션에서 LLM 이 쓴/읽은 **파일·지식·활동·프로젝트·태스크·자료**를 통합해 보고, 일부만 쉽게 걸러 보고, 하나를 누르면
//  그 자리가 넓어지며 **본문**이 보이게. 이름은 "발자취"(이 세션이 지나간 자리 — 무엇을 봤고 무엇을 남겼나).
//
//  ── 재료는 트랜스크립트 자체 ──
//  세션 화면(session-chat.ts)이 이미 대화 파일을 줄 단위로 읽는다. 그 안의 tool_use(Read/Edit/Write · mcp__lively__knowledge_get …)가
//  곧 '무엇을 읽고 썼나'의 정본이다 — 별도 서버 로그(mcp_call_log 에는 session_id 가 없다, #1578)를 기다릴 필요가 없고, 라이브로 자란다.
//  본문은 두 갈래: ① 그때 AI 가 받은 것(tool_result 원문 — 파일 내용·검색 결과)은 그대로 보관해 보여 주고, ② 지금 정본이 있는 것
//  (지식·프로젝트·태스크·자료)은 누를 때 API 로 **지금 본문**을 가져온다(그새 바뀌었어도 최신을 본다).
//
//  ── 지키는 것(라이블리 로그에서 물려받음) ──
//  · 기록이지 주장이 아니다 — 동사는 일어난 일만(읽음·고침·씀·찾아봄·남김). 툴 이름은 사람 말로.
//  · 같은 대상 연속 호출은 ×N 으로 접는다(안 접으면 벽).
//  · 유형은 점+글자(색만으로 가르지 않는다).
import { api, el, renderMarkdown } from './core.js';
export const TRAIL_KINDS = [
    { key: 'file', label: '파일' }, { key: 'knowledge', label: '지식' }, { key: 'activity', label: '활동' },
    { key: 'project', label: '프로젝트' }, { key: 'task', label: '태스크' }, { key: 'source', label: '자료' },
];
const short = (s, n = 120) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const tailPath = (p) => { const s = String(p ?? ''); const parts = s.split('/').filter(Boolean); return parts.length > 4 ? '…/' + parts.slice(-4).join('/') : s; };
/** tool_use 한 건 → 발자취 항목(해당 없으면 null). 순수 함수. */
export function classifyToolUse(name, input) {
    const o = (input && typeof input === 'object' ? input : {});
    const mk = (kind, verb, label, ref) => ({ kind, verb, label, key: `${kind}|${verb}|${label}`, tool: name, input, ref });
    switch (name) {
        case 'Read': return mk('file', '읽음', tailPath(o.file_path), { type: 'file', id: String(o.file_path || '') });
        case 'Edit':
        case 'MultiEdit':
        case 'NotebookEdit': return mk('file', '고침', tailPath(o.file_path ?? o.notebook_path), { type: 'file', id: String(o.file_path ?? o.notebook_path ?? '') });
        case 'Write': return mk('file', '씀', tailPath(o.file_path), { type: 'file', id: String(o.file_path || '') });
    }
    if (!name.startsWith('mcp__lively__'))
        return null;
    const t = name.slice('mcp__lively__'.length);
    // 지식
    if (t === 'knowledge_get')
        return mk('knowledge', '읽음', String(o.name || ''), { type: 'k', id: String(o.name || '') });
    if (t === 'knowledge_search' || t === 'knowledge_grep' || t === 'knowledge_similar')
        return mk('knowledge', '찾아봄', short(o.q ?? o.query ?? o.name, 80));
    if (t === 'knowledge_save')
        return mk('knowledge', o.mode === 'append' ? '덧붙임' : o.mode === 'edit' ? '고침' : '남김', String(o.name || o.title || ''), o.name ? { type: 'k', id: String(o.name) } : undefined);
    if (/^knowledge_(link|link_category|set_lifecycle|set_title|move|set_wiki|propose_category)$/.test(t))
        return mk('knowledge', '고침', String(o.name || o.from || ''), o.name ? { type: 'k', id: String(o.name) } : undefined);
    if (t === 'knowledge_list' || t === 'knowledge_projects_v6' || t === 'knowledge_history')
        return mk('knowledge', '살펴봄', short(o.name || o.category || o.q || t, 60));
    // 활동
    if (t === 'activity_log')
        return mk('activity', '기록', short(o.summary || o.title, 100));
    if (t === 'activity_list')
        return mk('activity', '살펴봄', short(o.project_id ? `프로젝트 #${o.project_id}` : '작업 기록', 60));
    // 프로젝트
    if (t === 'project_get_v6')
        return mk('project', '불러옴', `#${o.id ?? o.projectId ?? ''}`, { type: 'p', id: String(o.id ?? o.projectId ?? '') });
    if (t === 'project_create_v6')
        return mk('project', '만듦', short(o.name, 80));
    if (/^project_(update|set_status|set_list|set_repos|set_members|set_categories|link_knowledge|link_category|link_project|bind_folder)_v6$/.test(t))
        return mk('project', '고침', `#${o.id ?? o.projectId ?? ''}`, { type: 'p', id: String(o.id ?? o.projectId ?? '') });
    if (/^project_(list|search|grep|my_status|find_by_origin)/.test(t))
        return mk('project', '찾아봄', short(o.q ?? o.query ?? o.status ?? '목록', 60));
    // 태스크
    if (t === 'task_create_v6')
        return mk('task', '만듦', short(o.name, 80));
    if (t === 'task_detail_v6')
        return mk('task', '봄', `#${o.id ?? ''}`, { type: 't', id: String(o.id ?? '') });
    if (/^task_/.test(t))
        return mk('task', '고침', `#${o.id ?? o.taskId ?? ''}`, o.id ? { type: 't', id: String(o.id) } : undefined);
    // 자료
    if (t === 'source_get' || t === 'source_artifact')
        return mk('source', '읽음', String(o.id ?? o.name ?? ''), { type: 'src', id: String(o.id ?? '') });
    if (t === 'source_save')
        return mk('source', '남김', short(o.title ?? o.name ?? o.url, 80));
    if (/^source_(list|undistilled|search)/.test(t))
        return mk('source', '찾아봄', short(o.q ?? o.channel ?? '목록', 60));
    return null;
}
/** tool_result 원문에서 대상의 이름을 건진다(라벨을 사람 말로 — "#1719" 대신 "APP. lvly.io …"). 못 건지면 null. */
function nameFromOutput(kind, output) {
    const s = output.trim();
    if (!s.startsWith('{'))
        return null;
    try {
        const j = JSON.parse(s);
        if (kind === 'project')
            return j?.project?.name || j?.name || null;
        if (kind === 'task')
            return j?.task?.name || j?.name || null;
        if (kind === 'knowledge')
            return j?.knowledge?.title || j?.title || null;
        if (kind === 'source')
            return j?.source?.title || j?.title || null;
    }
    catch { /* JSON 아님 */ }
    return null;
}
const hhmm = (iso) => { if (!iso)
    return ''; const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }) : ''; };
export function createTrailWidget(host, _ctx) {
    const items = []; // 시간순(오래된 → 최신). 화면은 최신이 위.
    const rowOf = new Map(); // item.key(접힌 행) → 행
    let filter = 'all';
    const countEl = el('span', { class: 'v2-k', text: '0' });
    const chips = el('div', { class: 'tr-chips' });
    const list = el('div', { class: 'tr-list' });
    const empty = el('p', { class: 'v2-empty', text: '아직 읽거나 쓴 것이 없어요 — 세션이 일하면 여기에 쌓입니다.' });
    const root = el('section', { class: 'tr-wrap' }, el('div', { class: 'v2-aside-h' }, el('b', { text: '발자취' }), el('span', { class: 'tr-sub', text: '이 세션이 읽고 쓴 것' }), countEl), chips, list, empty);
    host.append(root);
    const drawChips = () => {
        const counts = new Map();
        for (const it of items)
            counts.set(it.kind, (counts.get(it.kind) || 0) + 1);
        const mk = (key, label, n) => el('button', { class: 'tr-chip' + (filter === key ? ' on' : ''), type: 'button', 'aria-pressed': filter === key ? 'true' : 'false',
            onclick: () => { filter = key; drawChips(); applyFilter(); } }, el('span', { class: 'tr-chip-dot k-' + key, 'aria-hidden': 'true' }), el('span', { text: label }), el('span', { class: 'tr-chip-n', text: String(n) }));
        chips.replaceChildren(mk('all', '전체', items.length), ...TRAIL_KINDS.map((k) => mk(k.key, k.label, counts.get(k.key) || 0)));
        countEl.textContent = String(items.length);
        empty.hidden = items.length > 0;
    };
    const applyFilter = () => {
        list.querySelectorAll('.tr-row').forEach((n) => { const r = n; r.hidden = filter !== 'all' && r.dataset.kind !== filter; });
    };
    function row(it) {
        const cnt = el('span', { class: 'tr-x', text: it.count > 1 ? '×' + it.count : '' });
        const lab = el('span', { class: 'tr-label', text: it.label || '(이름 없음)', title: it.label });
        const st = el('span', { class: 'tr-st', text: it.error ? '실패' : '' });
        const body = el('div', { class: 'tr-body', hidden: true });
        const head = el('button', { class: 'tr-head', type: 'button', 'aria-expanded': 'false',
            onclick: () => { const open = body.hidden; body.hidden = !open; head.setAttribute('aria-expanded', open ? 'true' : 'false'); r.classList.toggle('open', open); if (open && !body.dataset.loaded) {
                body.dataset.loaded = '1';
                void fillBody(body, it);
            } } }, el('span', { class: 'tr-dot k-' + it.kind, 'aria-hidden': 'true' }), el('span', { class: 'tr-verb', text: it.verb }), lab, cnt, st, el('span', { class: 'tr-tm', text: hhmm(it.ts) }));
        const r = el('div', { class: 'tr-row', 'data-kind': it.kind }, head, body);
        r._it = it;
        r._cnt = cnt;
        r._lab = lab;
        r._st = st;
        r._body = body;
        return r;
    }
    async function fillBody(body, it) {
        body.replaceChildren(el('p', { class: 'tr-loading', text: '불러오는 중…' }));
        const parts = [];
        const pre = (cap, text, max = 24_000) => {
            const s = String(text ?? '');
            return el('div', { class: 'tr-part' }, el('div', { class: 'tr-cap', text: cap + (s.length > max ? ` · 앞 ${max.toLocaleString('ko-KR')}자` : '') }), el('pre', { class: 'tr-pre', text: s.slice(0, max) }));
        };
        const link = (href, text) => el('a', { class: 'btn btn-ghost btn-sm', href, text });
        try {
            if (it.kind === 'file') {
                const p = String(it.input?.file_path ?? it.input?.notebook_path ?? '');
                parts.push(el('div', { class: 'tr-path', text: p }));
                if (it.tool === 'Write')
                    parts.push(pre('쓴 내용', String(it.input?.content ?? '')));
                else if (it.tool === 'Edit') {
                    parts.push(pre('바꾸기 전', String(it.input?.old_string ?? '')));
                    parts.push(pre('바꾼 후', String(it.input?.new_string ?? '')));
                }
                else if (it.tool === 'MultiEdit') {
                    for (const e of (Array.isArray(it.input?.edits) ? it.input.edits : []).slice(0, 20)) {
                        parts.push(pre('바꾸기 전', String(e?.old_string ?? '')));
                        parts.push(pre('바꾼 후', String(e?.new_string ?? '')));
                    }
                }
                else if (it.tool === 'NotebookEdit')
                    parts.push(pre('셀 내용', String(it.input?.new_source ?? '')));
                if (it.output)
                    parts.push(pre(it.tool === 'Read' ? '그때 읽은 내용' : '돌아온 것', it.output));
                else if (it.tool === 'Read')
                    parts.push(el('p', { class: 'v2-empty', text: '읽은 내용은 이 창 밖(이전 기록)에 있어요.' }));
            }
            else if (it.kind === 'knowledge') {
                if (it.ref?.id) {
                    const d = await api('/api/ui/knowledge/' + encodeURIComponent(it.ref.id));
                    const k = d?.knowledge || d;
                    if (k?.title)
                        parts.push(el('div', { class: 'tr-title', text: String(k.title) }));
                    if (k?.body_md)
                        parts.push(el('div', { class: 'tr-md' }, renderMarkdown(String(k.body_md).slice(0, 40_000))));
                    parts.push(link('#/k/' + encodeURIComponent(it.ref.id), 'WIKI에서 열기 →'));
                }
                else if (it.output)
                    parts.push(pre('돌아온 것', it.output));
                if (it.tool === 'mcp__lively__knowledge_save' && it.input?.body_md)
                    parts.push(pre(it.verb === '덧붙임' ? '덧붙인 조각' : '남긴 본문', String(it.input.body_md)));
            }
            else if (it.kind === 'activity') {
                const i = it.input || {};
                if (i.title)
                    parts.push(el('div', { class: 'tr-title', text: String(i.title) }));
                if (i.body)
                    parts.push(el('div', { class: 'tr-md' }, renderMarkdown(String(i.body))));
                if (i.commit_sha)
                    parts.push(el('div', { class: 'tr-kv', text: `커밋 ${String(i.commit_sha).slice(0, 10)}${i.repo ? ' · ' + i.repo : ''}` }));
                if (i.project_id)
                    parts.push(link('#/p/' + i.project_id, `프로젝트 #${i.project_id} →`));
                if (!i.title && it.output)
                    parts.push(pre('돌아온 것', it.output));
            }
            else if (it.kind === 'project') {
                if (it.ref?.id) {
                    const d = await api('/api/ui/v6/projects/' + encodeURIComponent(it.ref.id));
                    const p = d?.project || d;
                    if (p?.name)
                        parts.push(el('div', { class: 'tr-title', text: String(p.name) }));
                    const st = p?.status || p?.status_category;
                    if (st)
                        parts.push(el('div', { class: 'tr-kv', text: `상태 ${st}` }));
                    if (p?.description)
                        parts.push(el('div', { class: 'tr-md' }, renderMarkdown(String(p.description).slice(0, 20_000))));
                    parts.push(link('#/p/' + encodeURIComponent(it.ref.id), '프로젝트 화면 →'));
                }
                if (it.tool !== 'mcp__lively__project_get_v6')
                    parts.push(pre('보낸 것', JSON.stringify(it.input ?? {}, null, 2)));
                if (!it.ref?.id && it.output)
                    parts.push(pre('돌아온 것', it.output));
            }
            else if (it.kind === 'task') {
                if (it.ref?.id) {
                    const d = await api('/api/ui/v6/tasks/' + encodeURIComponent(it.ref.id) + '/detail').catch(() => null);
                    const t = d?.task || d;
                    if (t?.name)
                        parts.push(el('div', { class: 'tr-title', text: String(t.name) }));
                    const st = t?.status || t?.status_category;
                    if (st)
                        parts.push(el('div', { class: 'tr-kv', text: `상태 ${st}` }));
                    if (t?.description)
                        parts.push(el('div', { class: 'tr-md' }, renderMarkdown(String(t.description).slice(0, 20_000))));
                    parts.push(link('#/projects2/t/' + encodeURIComponent(it.ref.id), '태스크 열기 →'));
                }
                if (it.tool !== 'mcp__lively__task_detail_v6')
                    parts.push(pre('보낸 것', JSON.stringify(it.input ?? {}, null, 2)));
            }
            else if (it.kind === 'source') {
                if (it.ref?.id) {
                    const d = await api('/api/ui/sources/' + encodeURIComponent(it.ref.id)).catch(() => null);
                    const s = d?.source || d;
                    if (s?.title)
                        parts.push(el('div', { class: 'tr-title', text: String(s.title) }));
                    if (s?.body || s?.body_md || s?.text)
                        parts.push(pre('본문', String(s.body ?? s.body_md ?? s.text)));
                }
                if (it.tool === 'mcp__lively__source_save')
                    parts.push(pre('남긴 것', JSON.stringify(it.input ?? {}, null, 2)));
                if (!it.ref?.id && it.output)
                    parts.push(pre('돌아온 것', it.output));
            }
            if (!parts.length)
                parts.push(pre('보낸 것', JSON.stringify(it.input ?? {}, null, 2)));
        }
        catch (e) {
            parts.push(el('p', { class: 'livc-err', text: `본문을 불러오지 못했습니다. ${e?.message || ''}` }));
            if (it.output)
                parts.push(pre('그때 돌아온 것', it.output));
        }
        body.replaceChildren(...parts);
    }
    const w = {
        root,
        add(item, at = 'end') {
            // 접기 — 같은 대상 연속 호출은 ×N(끝에 붙일 때만; 위에 끼울 땐 위 이웃과 비교).
            const neighbor = at === 'end' ? items[items.length - 1] : items[0];
            if (neighbor && neighbor.key === item.key && !neighbor.error) {
                neighbor.count++;
                if (!neighbor.ts && item.ts)
                    neighbor.ts = item.ts;
                rowOf.set(item.id, rowOf.get(neighbor.id)); // 이 결과도 그 행으로
                const r = rowOf.get(neighbor.id);
                r._cnt.textContent = '×' + neighbor.count;
                return;
            }
            const it = { ...item, count: 1 };
            const r = row(it);
            if (at === 'end') {
                items.push(it);
                list.prepend(r);
            }
            else {
                items.unshift(it);
                list.append(r);
            }
            rowOf.set(it.id, r);
            drawChips();
            applyFilter();
        },
        result(id, output, isError) {
            const r = rowOf.get(id);
            if (!r)
                return;
            const it = r._it;
            if (!it.output)
                it.output = output; // 접힌 행은 첫 결과를 대표로(펼치면 그것)
            if (isError) {
                it.error = true;
                r._st.textContent = '실패';
                r.classList.add('err');
            }
            const nm = nameFromOutput(it.kind, output);
            if (nm && (it.kind !== 'knowledge' || !it.label)) {
                const lab = r._lab;
                const shown = it.kind === 'project' || it.kind === 'task' ? `${nm} (${it.label})` : nm;
                lab.textContent = shown;
                lab.title = shown;
            }
        },
        clear() { items.splice(0); rowOf.clear(); list.replaceChildren(); drawChips(); },
    };
    drawChips();
    return w;
}

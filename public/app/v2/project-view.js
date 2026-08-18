// v2/project-view.ts — 새 셸의 **프로젝트 화면**(#1757, 처음부터 다시 잡음).
//
//  ── 화면의 문법 ──
//  홈(입력창)·세션(대화창)과 같은 문법으로 맞춘다: 위는 **짧은 개요**, 아래는 **리브와의 대화 + 입력칸**.
//   ┌ 개요 — 번호·상태·리스트 / 제목 [편집] / 본문(몇 줄만, 더 보기) / [＋ 새 세션][공유 폴더][보드] · 세션 n ▾ 태스크 n ▾ 지식 n
//   ├ (펼친 목록 — 세션·태스크는 눌렀을 때만 한 칸 펼친다. 늘 펼쳐 두면 옛 화면처럼 길어진다)
//   └ 대화 — 리브(프로젝트 폴더에서 도는 턴, web/project-chat.ts). 빈 대화엔 상태에 맞는 제안 칩. 입력칸은 맨 아래 고정.
//
//  ── 본문은 누가 쓰나 ──
//  둘 다. 리브가 대화로 정돈해서 쓰는 것이 기본 길(칩 '본문 정리' · 바의 [본문 정리])이고, 사람은 [편집]으로 언제든 직접 고친다.
//  그래서 리브의 턴이 끝날 때마다 개요를 서버에서 다시 읽는다(리브가 본문·태스크·상태를 바꿨을 수 있다) — 대화는 그대로 두고 개요만.
//
//  ── 이 파일이 모르는 것 ──
//  대화의 읽기·쓰기(project-chat.ts) · 세션 생성(quick-session.ts) · 공유 폴더 브라우저(projects/files.ts openFolderGrid — 클래식 모달 재사용).
import { api, el, relTime, renderMarkdown, toast } from '../core.js';
import { openFolderGrid } from '../projects/files.js';
import { mountProjectChat } from '../project-chat.js';
import { openProjectSession } from './quick-session.js';
import { dotCls } from './views.js';
/** 본문 정돈 — 칩·바 버튼이 같은 말을 쓴다(둘이 다르면 리브가 다르게 움직인다). */
const SAY_TIDY_NEW = '이 프로젝트의 본문을 정돈된 형식으로 써 줘. 이름·태스크·연결된 지식에서 읽히는 만큼만 — 없는 사실은 지어내지 말고, 모르는 항목은 비워 둬.';
const SAY_TIDY = '본문을 정돈된 형식으로 다시 써 줘. 원문의 사실·결정·링크는 하나도 잃지 말고, 산만한 문장만 정리해.';
const SAY_NEXT = '지금 상태를 읽고 다음에 할 일 2~3개를 제안해 줘. 각각 한 줄로, 바로 시킬 수 있게.';
const SAY_SPLIT = '이 프로젝트를 태스크로 나눠 줘. 만들기 전에 목록을 먼저 보여 줘.';
const SAY_CHECK = '상태·마감·담당·우선순위를 점검하고, 비어 있거나 어긋난 게 있으면 정리해 줘.';
const stateWord = (cat) => cat === 'done' ? { word: '끝남', dot: 'done' } : cat === 'unstarted' ? { word: '시작 전', dot: '' } : { word: '진행 중', dot: 'idle' };
const when = (ms) => (ms ? relTime(new Date(ms).toISOString()) : '');
export function mountProjectView(host, opts) {
    const id = opts.id;
    let detail = opts.detail;
    let editing = false;
    let expanded = false;
    let panel = null;
    let chat = null;
    let dead = false;
    const top = el('div', { class: 'pv-top' });
    const chatHost = el('div', { class: 'pv-chat' });
    const wrap = el('div', { class: 'pv-wrap' }, top, chatHost);
    host.replaceChildren(wrap);
    // ── 데이터 접근(항상 최신 detail 에서) ──
    const pj = () => (detail && detail.project) || opts.data.projects.find((x) => Number(x.id) === id) || { id, name: `프로젝트 #${id}` };
    const tasksOf = () => (Array.isArray(detail?.project?.tasks) ? detail.project.tasks : []);
    const sessOf = () => opts.data.sessions.filter((s) => Number(s.projectId) === id).sort((a, b) => Number(b.live && b.alive) - Number(a.live && a.alive) || b.lastSeen - a.lastSeen);
    const knOf = () => { const k = detail?.project?.knowledge || {}; return { req: k.required || [], prod: k.produced || [] }; };
    // ── 개요 ──
    function paintTop() {
        const p = pj();
        const st = stateWord(p.status_category);
        const tasks = tasksOf();
        const done = tasks.filter((t) => t.status_category === 'done' || t.status === 'done').length;
        const sess = sessOf();
        const live = sess.filter((s) => s.live && s.alive);
        const kn = knOf();
        const desc = String(p.description || '');
        // 번호 · 상태 · 리스트 · 마지막 수정
        const eyebrow = el('div', { class: 'pv-eyebrow' }, el('span', { class: 'mono', text: '#' + p.id }), el('span', { class: 'sep', text: '·' }), el('span', { class: 'pv-state' }, el('span', { class: 'v2-dot ' + st.dot, 'aria-hidden': 'true' }), el('span', { text: st.word })), p.list && p.list.name ? [el('span', { class: 'sep', text: '·' }), el('span', { text: p.list.name })] : null, p.updated_at ? [el('span', { class: 'sep', text: '·' }), el('span', { class: 'pv-when', text: '수정 ' + relTime(p.updated_at) })] : null);
        // 제목 + [편집]
        const editBtn = el('button', { class: 'pv-act', type: 'button', text: editing ? '편집 중' : '편집', title: '본문을 직접 고칩니다', disabled: editing, onclick: () => startEdit() });
        const titleRow = el('div', { class: 'pv-title-row' }, el('h1', { class: 'pv-title', text: p.name }), el('div', { class: 'pv-head-acts' }, editBtn));
        // 본문 — 몇 줄만(clamp) + 더 보기 / 편집 중이면 textarea
        let bodyWrap;
        if (editing) {
            const ta = el('textarea', { class: 'pv-edit-ta', rows: '8', 'aria-label': '본문 편집', placeholder: '이 프로젝트가 무엇을 왜 하는지 — 마크다운' });
            ta.value = desc;
            const save = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '저장' });
            const cancel = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '취소', onclick: () => { editing = false; paintTop(); } });
            const doSave = async () => {
                const v = ta.value.trim();
                if (v === desc.trim()) {
                    editing = false;
                    paintTop();
                    return;
                }
                save.disabled = true;
                save.textContent = '저장 중…';
                try {
                    await api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify({ description: v || null }) });
                    if (detail && detail.project)
                        detail.project.description = v || null;
                    editing = false;
                    expanded = false;
                    toast('본문을 저장했어요.');
                    paintTop();
                    opts.onProjectChanged?.();
                    void reloadDetail();
                }
                catch (e) {
                    save.disabled = false;
                    save.textContent = '저장';
                    toast('본문을 저장하지 못했습니다 — ' + (e && e.message ? e.message : e), true);
                }
            };
            save.onclick = () => { void doSave(); };
            ta.addEventListener('keydown', (e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void doSave();
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    editing = false;
                    paintTop();
                }
            });
            const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(420, Math.max(140, ta.scrollHeight)) + 'px'; };
            ta.addEventListener('input', grow);
            bodyWrap = el('div', { class: 'pv-edit' }, ta, el('div', { class: 'pv-edit-acts' }, el('span', { class: 'pv-edit-hint', text: '마크다운 · ⌘⏎ 저장 · Esc 취소 · 정돈은 리브에게 「본문 정리해 줘」' }), cancel, save));
            window.setTimeout(() => { grow(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
        }
        else if (desc.trim()) {
            const body = el('div', { class: 'pv-body' + (expanded ? '' : ' clamp') }, renderMarkdown(desc));
            const more = el('button', { class: 'pv-more', type: 'button', hidden: true, text: expanded ? '접기 ▴' : '더 보기 ▾',
                onclick: () => { expanded = !expanded; paintTop(); } });
            bodyWrap = el('div', { class: 'pv-body-wrap' }, body, more);
            // 넘칠 때만 [더 보기] — 몇 줄짜리 본문에 버튼이 붙어 있으면 그게 곧 잡음이다. 붙인 뒤에 재야 한다.
            requestAnimationFrame(() => { if (expanded || body.scrollHeight > body.clientHeight + 6)
                more.hidden = false; });
        }
        else {
            bodyWrap = el('p', { class: 'pv-empty-body' }, el('span', { text: '아직 본문이 없어요. ' }), el('button', { class: 'pv-link', type: 'button', text: '리브에게 써 달라고 하기', onclick: () => chat?.say(SAY_TIDY_NEW) }), el('span', { text: ' 또는 ' }), el('button', { class: 'pv-link', type: 'button', text: '직접 쓰기', onclick: () => startEdit() }));
        }
        // 여는 길 + 사실 한 줄
        const factBtn = (key, label) => el('button', { class: 'pv-fact' + (panel === key ? ' on' : ''), type: 'button', 'aria-expanded': String(panel === key),
            onclick: () => { panel = panel === key ? null : key; paintTop(); } }, el('span', { text: label }), el('span', { class: 'car', 'aria-hidden': 'true', text: panel === key ? '▴' : '▾' }));
        const tools = el('div', { class: 'pv-tools' }, el('div', { class: 'pv-tools-l' }, el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '＋ 새 세션', title: '이 프로젝트에 붙은 AI 세션을 엽니다',
            onclick: (e) => { const b = e.currentTarget; b.disabled = true; void openProjectSession(id, String(p.name || '')).then((ok) => { if (!ok)
                b.disabled = false; }); } }), el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '공유 폴더', title: '이 프로젝트의 공유 폴더(파일 올리기·내려받기)',
            onclick: () => openFolderGrid(id, '', '/api/ui/projects/', p.folder || undefined) }), el('a', { class: 'btn btn-ghost btn-sm', href: '#/app/projects2/p/' + id, text: '보드 ↗', title: '프로젝트 앱(보드·태스크·타임라인)에서 열기' })), el('div', { class: 'pv-facts' }, factBtn('sessions', live.length ? `세션 ${sess.length} · 작업 중 ${live.filter((s) => s.stateKey === 'busy').length || live.length}` : `세션 ${sess.length}`), factBtn('tasks', tasks.length ? `태스크 ${done}/${tasks.length}` : '태스크 0'), el('span', { class: 'pv-fact-plain', text: `지식 ${kn.req.length + kn.prod.length}`, title: `필요 ${kn.req.length} · 산출 ${kn.prod.length} — 우측 타임라인 아래` })));
        // 펼친 목록(하나만)
        let panelEl = null;
        if (panel === 'sessions') {
            panelEl = el('div', { class: 'pv-panel' }, sess.length ? sess.slice(0, 30).map((s) => el('a', { class: 'v2-row', href: '#/s/' + encodeURIComponent(s.id) }, el('span', { class: 'v2-dot ' + dotCls(s.stateKey), 'aria-hidden': 'true' }), el('div', { class: 'v2-row-main' }, el('div', { class: 't', text: s.label }), el('div', { class: 'm', text: `${s.stateLabel}${s.live ? '' : ' · 기록만'} · ${when(s.lastSeen)}` })), el('span', { class: 'v2-row-r', text: '›' })))
                : el('p', { class: 'v2-empty', text: '이 프로젝트에 붙은 세션이 아직 없어요 — [＋ 새 세션]으로 시작하면 여기에 쌓입니다.' }));
        }
        else if (panel === 'tasks') {
            const rows = [...tasks].sort((a, b) => Number(a.status_category === 'done') - Number(b.status_category === 'done'));
            panelEl = el('div', { class: 'pv-panel' }, rows.length ? rows.map((t) => el('a', { class: 'v2-row', href: '#/app/projects2/t/' + t.id }, el('span', { class: 'v2-dot ' + (t.status_category === 'done' ? 'done' : t.status_category === 'started' ? 'idle' : ''), 'aria-hidden': 'true' }), el('div', { class: 'v2-row-main' }, el('div', { class: 't', text: t.name }), el('div', { class: 'm', text: t.status || t.status_category || '' })), el('span', { class: 'v2-row-r', text: '›' })))
                : el('p', { class: 'v2-empty' }, el('span', { text: '태스크가 아직 없어요 — ' }), el('button', { class: 'pv-link', type: 'button', text: '리브에게 나눠 달라고 하기', onclick: () => chat?.say(SAY_SPLIT) })), el('a', { class: 'v2-more', href: '#/app/projects2/p/' + id, text: '보드에서 열기 →' }));
        }
        top.replaceChildren(eyebrow, titleRow, bodyWrap, tools, panelEl ?? el('div', { hidden: true }));
    }
    function startEdit() { if (editing)
        return; editing = true; paintTop(); }
    /** 리브의 턴이 끝났거나 사람이 저장했다 — 개요를 서버에서 다시 읽는다(대화는 건드리지 않는다). 편집 중이면 미룬다(입력을 덮지 않는다). */
    async function reloadDetail() {
        try {
            const d = await api('/api/ui/v6/projects/' + id);
            if (dead)
                return;
            if (d && d.project) {
                detail = d;
                if (!editing)
                    paintTop();
            }
        }
        catch { /* 다음 턴에 다시 */ }
    }
    // ── 대화 ──
    function opening() {
        const p = pj();
        const desc = String(p.description || '').trim();
        // 상태에 맞는 제안 셋 — 칩 글은 짧게, 실제 보내는 말(title)은 온전한 지시.
        const chips = [
            desc ? ['본문 정돈해 줘', SAY_TIDY] : ['본문 써 줘', SAY_TIDY_NEW],
            tasksOf().length ? ['다음 할 일 제안', SAY_NEXT] : ['태스크로 나눠 줘', SAY_SPLIT],
            ['상태·마감 점검', SAY_CHECK],
        ];
        return el('div', { class: 'pv-open' }, el('div', { class: 'pv-open-lede' }, el('b', { text: '리브에게 이 프로젝트를 시키세요.' }), el('span', { text: ' 본문·태스크·상태·지식 연결을 대화로 고칩니다 — 이 프로젝트의 기록만 만지고, 셸·파일은 건드리지 않아요.' })), el('div', { class: 'pv-chips' }, ...chips.map(([label, say]) => el('button', { class: 'chip', type: 'button', text: label, title: say, onclick: () => chat?.say(say) }))));
    }
    const barNote = el('span', { class: 'pv-bar-note', text: '리브 · 라이블리 도구만 · 이 프로젝트 폴더에서' });
    const barTidy = el('button', { class: 'pv-bar-btn', type: 'button', text: '본문 정리', title: '리브가 본문을 정돈된 형식으로 다시 씁니다', onclick: () => chat?.say(String(pj().description || '').trim() ? SAY_TIDY : SAY_TIDY_NEW) });
    const barNew = el('button', { class: 'pv-bar-btn', type: 'button', text: '새 대화', title: '이어가던 대화를 놓고 새로 시작합니다', onclick: () => chat?.restart() });
    chat = mountProjectChat(chatHost, {
        projectId: id,
        opening: opening(),
        bar: { left: barNote, right: el('span', { class: 'pv-bar-r' }, barTidy, barNew) },
        onTurnDone: () => { void reloadDetail(); opts.onProjectChanged?.(); },
    });
    paintTop();
    return {
        destroy() { dead = true; if (chat) {
            chat.destroy();
            chat = null;
        } },
    };
}

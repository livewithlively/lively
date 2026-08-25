// v2/proj-settings.ts — **프로젝트 정보** 창(#1719 원준 2026-08-20).
//
//  왜 따로인가: 이름·상태·본문·할 일은 **자주 고치는 것이 아니다**. 그런데 종전 화면들은 그걸 늘 펼쳐 두느라
//  정작 매일 보는 것(세션·자료)의 자리를 빼앗았다. 그래서 기본 뷰는 그것들을 화면에서 빼고 여기 한곳에 모은다 —
//  문패 [정보]와 개요 부품의 [프로젝트 정보에서 고치기]가 같은 창을 연다.
//  이름은 '설정'이 아니라 **정보**(원준 2026-08-20) — 내용물이 동작 옵션이 아니라 프로젝트 그 자체라서다.
//
//  저장은 **손대면 곧바로** — 이름·상태는 고른 그 자리에서, 본문은 타자가 멎으면(1.2s) 자동으로.
//  '적용'도 '[본문 저장]'도 두지 않는다(#1719 원준 2026-08-21): 한 창 안에서 어떤 칸은 즉시 남고
//  어떤 칸만 버튼을 요구하면 규칙이 둘로 갈린다 — 사람은 버튼을 못 보고 창을 닫고, 쓴 글이 사라진다.
import { api, el, toast } from '../core.js';
import { pnIcon } from './panes-parts.js';
const STATES = [
    { key: 'todo', label: '시작 전', status: 'todo' },
    { key: 'in_progress', label: '진행 중', status: 'in_progress' },
    { key: 'done', label: '끝남', status: 'done' },
];
export function openProjSettings(opts) {
    const id = opts.id;
    const p = (opts.detail && opts.detail.project) || {};
    let closed = false;
    const back = el('div', { class: 'pn-modal-back' });
    const panel = el('section', { class: 'pn-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '프로젝트 정보' });
    const close = () => {
        if (closed)
            return;
        closed = true;
        // 닫기(X·Esc·바깥 클릭)로 빠져나가도 미저장분은 남긴다 — 창은 곧바로 닫히고 저장은 뒤에서 끝난다.
        //  요소가 지워지며 blur 가 안 뜨는 브라우저가 있어 blur 만 믿을 수 없다.
        flushName();
        void flushDesc();
        back.remove();
        panel.remove();
        document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => { if (e.key === 'Escape')
        close(); };
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', close);
    // ── 이름 ──
    const nameIn = el('input', { class: 'pn-set-name', type: 'text', value: String(p.name || ''), 'aria-label': '프로젝트 이름' });
    let nameSaved = String(p.name || '');
    // blur 와 close 가 잇달아 부를 수 있으므로 보내기 **전에** 기준값을 옮겨 둔다(중복 전송 방지·실패하면 되돌린다).
    const flushName = () => {
        const v = nameIn.value.trim();
        if (!v || v === nameSaved)
            return;
        const prev = nameSaved;
        nameSaved = v;
        void api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify({ name: v }) })
            .then(() => { p.name = v; toast('이름을 바꿨어요.'); opts.onChanged?.(); })
            .catch((e) => { nameSaved = prev; toast('이름을 바꾸지 못했어요 — ' + (e?.message || e), true); });
    };
    nameIn.addEventListener('blur', flushName);
    // ── 상태 ──
    const cur = p.status_category === 'done' ? 'done' : p.status_category === 'unstarted' ? 'todo' : 'in_progress';
    const stateRow = el('div', { class: 'pn-set-states' }, ...STATES.map((s) => el('button', {
        class: 'pn-set-state' + (s.key === cur ? ' on' : ''), type: 'button', 'aria-pressed': String(s.key === cur),
        text: s.label,
        onclick: (e) => {
            const btn = e.currentTarget;
            void api('/api/ui/v6/projects/' + id + '/status', { method: 'POST', body: JSON.stringify({ status: s.status, status_raw: s.key }) })
                .then(() => {
                stateRow.querySelectorAll('.pn-set-state').forEach((n) => { n.classList.remove('on'); n.setAttribute('aria-pressed', 'false'); });
                btn.classList.add('on');
                btn.setAttribute('aria-pressed', 'true');
                toast('상태를 바꿨어요.');
                opts.onChanged?.();
            })
                .catch((err) => toast('상태를 바꾸지 못했어요 — ' + (err?.message || err), true));
        },
    })));
    // ── 본문 ──
    const desc = el('textarea', { class: 'pn-set-desc', rows: '10', placeholder: '이 프로젝트가 무엇인지 적어 두면 세션도 그걸 읽고 일합니다.', 'aria-label': '프로젝트 본문' });
    desc.value = String(p.description || '');
    // 자동저장 — 프로젝트 상세 본문(projects/detail-body.ts)과 같은 박자(1.2s 디바운스 + 칸을 떠날 때·창 닫을 때 flush).
    //  저장했다는 신호는 토스트가 아니라 칸 아래 작은 글씨다 — 타자를 칠 때마다 토스트가 뜨면 그게 방해가 된다.
    const descChip = el('span', { class: 'pn-set-chip' });
    const setChip = (t, warn) => { descChip.textContent = t; descChip.classList.toggle('warn', !!warn); };
    let descTimer = null, descSaving = false, descSaved = desc.value;
    const saveDesc = async () => {
        if (descSaving)
            return;
        const md = desc.value;
        if (md === descSaved) {
            setChip('');
            return;
        }
        descSaving = true;
        setChip('저장 중…');
        try {
            await api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify({ description: md || null }) });
            descSaved = md;
            p.description = md;
            setChip('저장했어요.');
            window.setTimeout(() => { if (descChip.textContent === '저장했어요.')
                setChip(''); }, 1600);
            opts.onChanged?.();
        }
        catch (e) {
            setChip('저장하지 못했어요.', true);
            toast('본문을 저장하지 못했어요 — ' + (e?.message || e), true);
        }
        descSaving = false;
        if (desc.value !== descSaved)
            queueDesc(); // 저장하는 동안 더 친 글이 있으면 곧바로 다음 저장을 건다
    };
    const queueDesc = () => {
        setChip('쓰는 중…');
        if (descTimer !== null)
            window.clearTimeout(descTimer);
        descTimer = window.setTimeout(() => { descTimer = null; void saveDesc(); }, 1200);
    };
    const flushDesc = () => {
        if (descTimer !== null) {
            window.clearTimeout(descTimer);
            descTimer = null;
        }
        return desc.value === descSaved ? Promise.resolve() : saveDesc();
    };
    desc.addEventListener('input', queueDesc);
    desc.addEventListener('blur', () => { void flushDesc(); });
    // ── 할 일 ──
    const taskList = el('div', { class: 'pn-set-tasks' });
    const taskIn = el('input', { class: 'pn-set-tin', type: 'text', placeholder: '할 일을 적고 Enter 를 누르세요.', 'aria-label': '새 할 일' });
    taskIn.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing)
            return;
        const name = taskIn.value.trim();
        if (!name)
            return;
        taskIn.disabled = true;
        void api('/api/ui/v6/projects/' + id + '/tasks', { method: 'POST', body: JSON.stringify({ name }) })
            .then(() => { taskIn.value = ''; toast('할 일을 더했어요.'); opts.onChanged?.(); void reload(); })
            .catch((err) => toast('더하지 못했어요 — ' + (err?.message || err), true))
            .finally(() => { taskIn.disabled = false; taskIn.focus(); });
    });
    function paintTasks(tasks) {
        if (!tasks.length) {
            taskList.replaceChildren(el('p', { class: 'pn-fine', text: '할 일이 아직 없어요.' }));
            return;
        }
        taskList.replaceChildren(...tasks.map((t) => {
            const isDone = t.status_category === 'done';
            return el('div', { class: 'pn-set-trow' + (isDone ? ' done' : '') }, el('button', {
                class: 'pn-tcheck' + (isDone ? ' on' : ''), type: 'button', 'aria-pressed': String(isDone),
                title: isDone ? '아직 안 끝난 것으로 되돌립니다' : '끝냈다고 표시합니다',
                onclick: () => {
                    void api('/api/ui/v6/tasks/' + t.id, { method: 'POST', body: JSON.stringify({ status: isDone ? 'todo' : 'done' }) })
                        .then(() => { opts.onChanged?.(); void reload(); })
                        .catch((e) => toast('바꾸지 못했어요 — ' + (e?.message || e), true));
                },
            }), el('span', { class: 'n ell2', text: t.name || '이름 없는 할 일' }), el('a', { class: 'pn-fine', href: '#/t/' + t.id, text: '열기 ↗' }));
        }));
    }
    paintTasks(Array.isArray(p.tasks) ? p.tasks : []);
    async function reload() {
        try {
            const d = await api('/api/ui/v6/projects/' + id);
            if (closed || !d?.project)
                return;
            paintTasks(Array.isArray(d.project.tasks) ? d.project.tasks : []);
        }
        catch (_) { /* 목록만 못 갱신한 것이라 창은 그대로 둔다 */ }
    }
    const sec = (title, hint, ...kids) => el('section', { class: 'pn-set-sec' }, el('h3', { text: title }), el('p', { class: 'pn-fine', text: hint }), ...kids);
    panel.replaceChildren(el('header', { class: 'pn-modal-h' }, el('h2', { text: '프로젝트 정보' }), el('button', { class: 'pn-modal-x', type: 'button', title: '닫습니다', 'aria-label': '닫기', onclick: close }, pnIcon('x', 'pn-i'))), el('div', { class: 'pn-modal-b' }, sec('이름', '사이드바·탭에 보이는 이름입니다.', nameIn), sec('상태', '프로젝트가 지금 어느 단계인지 알려 줍니다.', stateRow), sec('본문', '무엇을 하는 프로젝트인지 적어 둡니다. 쓰면 저절로 저장되고, 세션과 리브가 이 글을 읽고 일합니다.', desc, el('div', { class: 'pn-set-foot' }, descChip)), sec('할 일', '큰 덩어리만 적어 두면 충분합니다. 자세한 것은 세션이 만들어 줍니다.', taskIn, taskList)), el('footer', { class: 'pn-modal-f' }, el('a', { class: 'btn-text', href: '#/projects/' + id, onclick: () => close(), text: '전체 프로젝트 화면 열기 ↗' }), el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '닫기', onclick: close })));
    document.body.append(back, panel);
    window.setTimeout(() => nameIn.focus(), 0);
}

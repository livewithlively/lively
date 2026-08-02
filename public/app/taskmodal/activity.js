// taskmodal/activity.ts — #1313 R56: web/taskmodal.ts 섹션 분할 ⑦(Activity 패널).
//  검색·구독·필터 헤더 · 피드(댓글 카드+시스템 이벤트, 노이즈 필드 접기) · 작성기(전송·Enter).
import { api, el, personFace, relTime, renderMarkdown, toast } from '../core.js';
// 소유처 직결(#1313 R56) — 배럴 경유였다면 순환 가지가 늘어난다(composer.ts 주석과 같은 이유).
import { pjvPopover } from '../projects/popover.js';
import { PJV_PRIORITY, pjvStatusMeta } from '../projects/status.js';
import { pjvtmComposerToolbar, pjvtmEmojiPicker, pjvtmIcon, pjvtmWireFileLinks } from './composer.js';
// ── 우측(Activity) — 클릭업식: 댓글 카드(반응·Reply) + 시스템 이벤트(불릿·우측 시간) + 작성기(툴바). ──
function pjvtmSide(d, t, refresh) {
    const side = el('div', { class: 'pjv-tm-side' });
    let _filterMode = 'all';
    const _searchIn = el('input', { type: 'text', class: 'pjv-tm-search-in', placeholder: '활동 검색…' });
    const _searchWrap = el('div', { class: 'pjv-tm-search', hidden: true }, _searchIn);
    const _applyActFilter = () => {
        const fe = side.querySelector('.pjv-tm-feed');
        if (!fe)
            return;
        const qq = (_searchIn.value || '').trim().toLowerCase();
        for (const ch of fe.children) {
            if (ch.classList.contains('pjv-tm-feed-empty'))
                continue;
            const isEv = ch.classList.contains('pjv-tm-ev');
            let show = _filterMode === 'all' || (_filterMode === 'comments' && !isEv) || (_filterMode === 'events' && isEv);
            if (show && qq)
                show = ch.textContent.toLowerCase().includes(qq);
            ch.hidden = !show;
        }
    };
    _searchIn.addEventListener('input', _applyActFilter);
    const _searchBtn = el('button', { class: 'pjv-tm-side-icon', type: 'button', title: '활동 검색' }, pjvtmIcon('search'));
    _searchBtn.onclick = () => { _searchWrap.hidden = !_searchWrap.hidden; _searchBtn.classList.toggle('on', !_searchWrap.hidden); if (!_searchWrap.hidden)
        _searchIn.focus();
    else {
        _searchIn.value = '';
        _applyActFilter();
    } };
    let _subscribed = false;
    const _bellBtn = el('button', { class: 'pjv-tm-side-icon', type: 'button', title: '이 태스크 활동 구독' }, pjvtmIcon('bell'));
    _bellBtn.onclick = () => { _subscribed = !_subscribed; _bellBtn.classList.toggle('on', _subscribed); toast(_subscribed ? '이 태스크 활동을 구독합니다' : '구독을 해제했습니다'); };
    const _filterBtn = el('button', { class: 'pjv-tm-side-icon', type: 'button', title: '필터' }, pjvtmIcon('filter'));
    _filterBtn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu' });
        const close = pjvPopover(_filterBtn, menu);
        for (const opt of [['all', '전체'], ['comments', '댓글만'], ['events', '활동만']]) {
            menu.append(el('button', { class: 'pjv-menu-item' + (_filterMode === opt[0] ? ' sel' : ''), type: 'button', text: opt[1],
                onclick: () => { _filterMode = opt[0]; close(); _applyActFilter(); } }));
        }
    };
    side.append(el('div', { class: 'pjv-tm-side-head' }, el('span', { text: 'Activity' }), el('div', { class: 'pjv-tm-side-tools' }, _searchBtn, _bellBtn, _filterBtn)), _searchWrap);
    const feedBox = el('div', { class: 'pjv-tm-feed' });
    const feed = d.feed || [];
    const ta = el('textarea', { class: 'pjv-tm-composer', rows: '1', placeholder: '댓글을 입력하세요…' });
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; };
    ta.addEventListener('input', grow);
    const insertAtCursor = (text) => {
        const s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
        const e = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
        const pos = s + text.length;
        ta.focus();
        try {
            ta.setSelectionRange(pos, pos);
        }
        catch (_) { /* noop */ }
        grow();
    };
    const cctx = { taskId: t.id, projectId: d.project && d.project.id, members: d.members || [], replyTo: (name) => insertAtCursor('@' + name + ' ') };
    if (!feed.length)
        feedBox.append(el('div', { class: 'pjv-tm-feed-empty', text: '아직 활동이 없습니다. 첫 댓글을 남겨보세요.' }));
    // 산만함 줄이기 — 노이즈 필드(담당자·설명·이름·시작일)의 '연속' 변경은 최신 1건으로 합쳐 도배 방지.
    //  상태·마감일·우선순위·생성·댓글은 각각 그대로 둔다(의미 있는 마일스톤이라 합치지 않음).
    const NOISY_FIELDS = new Set(['description', 'assignee', 'name', 'title', 'start_date']);
    const feedShown = [];
    for (const f of feed) {
        const prev = feedShown[feedShown.length - 1];
        if (f.kind === 'event' && prev && prev.kind === 'event' && prev.field === f.field && NOISY_FIELDS.has(f.field))
            feedShown[feedShown.length - 1] = f;
        else
            feedShown.push(f);
    }
    for (const f of feedShown)
        feedBox.append(f.kind === 'comment' ? pjvtmComment(f, cctx) : pjvtmEvent(f));
    side.append(feedBox);
    setTimeout(() => { feedBox.scrollTop = feedBox.scrollHeight; }, 0);
    const sendBtn = el('button', { class: 'pjv-tm-send', type: 'button', title: '보내기 (Enter)' }, pjvtmIcon('send'));
    const send = async () => {
        const text = ta.value.trim();
        if (!text)
            return;
        sendBtn.disabled = true;
        ta.disabled = true;
        try {
            await api('/api/ui/v6/tasks/' + t.id + '/comments', { method: 'POST', body: JSON.stringify({ text }) });
            ta.value = '';
            refresh();
        }
        catch (e) {
            toast('실패 — ' + e.message, true);
            sendBtn.disabled = false;
            ta.disabled = false;
        }
    };
    sendBtn.onclick = send;
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
    } });
    const toolbar = pjvtmComposerToolbar({ insertAtCursor, members: d.members || [], d, sendBtn });
    side.append(el('div', { class: 'pjv-tm-composer-box' }, ta, toolbar));
    return side;
}
function pjvtmComment(f, cctx) {
    const name = f.display_name || f.actor || '알 수 없음';
    let reactions = (f.reactions || []).map((r) => ({ emoji: r.emoji, count: r.count, mine: r.mine }));
    const footer = el('div', { class: 'pjv-tm-c-foot' });
    const toggle = (emoji) => {
        const i = reactions.findIndex((r) => r.emoji === emoji);
        if (i >= 0) {
            if (reactions[i].mine) {
                reactions[i].count -= 1;
                reactions[i].mine = false;
                if (reactions[i].count <= 0)
                    reactions.splice(i, 1);
            }
            else {
                reactions[i].count += 1;
                reactions[i].mine = true;
            }
        }
        else
            reactions.push({ emoji, count: 1, mine: true });
        drawFoot();
        api('/api/ui/v6/comments/' + f.id + '/reactions', { method: 'POST', body: JSON.stringify({ emoji }) })
            .then((res) => { if (res && res.reactions) {
            reactions = res.reactions;
            drawFoot();
        } })
            .catch((e) => toast('반응 실패 — ' + e.message, true));
    };
    const drawFoot = () => {
        footer.replaceChildren();
        const left = el('div', { class: 'pjv-tm-c-react' });
        for (const r of reactions)
            left.append(el('button', { class: 'pjv-tm-react-chip' + (r.mine ? ' mine' : ''), type: 'button', title: '반응 토글', onclick: () => toggle(r.emoji) }, el('span', { text: r.emoji }), el('span', { class: 'pjv-tm-react-n', text: String(r.count) })));
        left.append(el('button', { class: 'pjv-tm-c-act', type: 'button', title: '좋아요', onclick: () => toggle('👍') }, pjvtmIcon('like')));
        const emo = el('button', { class: 'pjv-tm-c-act', type: 'button', title: '이모지 반응' }, pjvtmIcon('smile'));
        emo.onclick = () => pjvtmEmojiPicker(emo, (e) => toggle(e));
        left.append(emo);
        footer.append(left, el('button', { class: 'pjv-tm-c-reply', type: 'button', text: 'Reply', onclick: () => cctx.replyTo(name) }));
    };
    drawFoot();
    const textDiv = el('div', { class: 'pjv-tm-c-text md-rendered' }, renderMarkdown(f.body || ''));
    pjvtmWireFileLinks(textDiv, cctx);
    return el('div', { class: 'pjv-tm-c' }, personFace(f.actor || name, 'pjv-ava', name), el('div', { class: 'pjv-tm-c-body' }, el('div', { class: 'pjv-tm-c-meta' }, el('span', { class: 'pjv-tm-c-who', text: name }), el('span', { class: 'pjv-tm-c-time', text: ' · ' + (typeof relTime === 'function' ? relTime(f.ts) : f.ts) })), textDiv, footer));
}
function pjvtmEvent(f) {
    const name = f.display_name || f.actor || '시스템';
    let txt;
    if (f.field === 'created')
        txt = '태스크를 생성';
    else if (f.field === 'description')
        txt = '설명을 수정';
    else {
        const tv = pjvtmEventVal(f.field, f.to);
        if (f.to == null)
            txt = f.label + ' 해제';
        else
            txt = f.label + ' → ' + tv;
    }
    return el('div', { class: 'pjv-tm-ev' }, el('div', { class: 'pjv-tm-ev-main' }, el('span', { class: 'pjv-tm-ev-dot', text: '•' }), el('span', { class: 'pjv-tm-ev-who', text: name }), el('span', { class: 'pjv-tm-ev-txt', text: ' ' + txt })), el('span', { class: 'pjv-tm-ev-time', text: (typeof relTime === 'function' ? relTime(f.ts) : f.ts) }));
}
function pjvtmEventVal(field, v) {
    if (v == null || v === '')
        return '';
    if (field === 'status')
        return (pjvStatusMeta(v).label) || v;
    if (field === 'priority')
        return (PJV_PRIORITY[v] && PJV_PRIORITY[v].label) || v;
    if (field === 'assignee')
        return v;
    return String(v);
}
export { pjvtmSide };

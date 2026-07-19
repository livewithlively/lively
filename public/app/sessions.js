// sessions.ts — 세션이력 웹뷰(#905 C1 슬⑤b). `#/sessions` — 어느 환경에서 만들었든 중앙에 기록된 내 세션 목록 +
//  트랜스크립트 "이어보기"(채널필터 렌더). 회수 API(슬⑤a): GET /api/ui/v6/sessions · GET …/log?view=render.
//  ⚠ 트랜스크립트 본문은 신뢰 불가 → 반드시 el({text})(textContent)로만 렌더(innerHTML 금지, XSS 방어).
import { api, el } from './core.js';
const fmtBytes = (b) => !b ? '(비어있음/정리됨)' : b >= 1024 ? (b / 1024).toFixed(1) + ' KB' : b + ' B';
export async function renderSessions(view) {
    const listEl = el('div', { class: 'admin-hint', text: '불러오는 중…' });
    view.replaceChildren(el('div', { class: 'card', style: 'max-width:920px;margin:24px auto' }, el('div', { class: 'card-head' }, el('h2', { text: '세션 이력' })), el('p', { class: 'guide-lead', text: '어느 환경/멤버 노드에서 만들었든 중앙에 기록된 내 세션들입니다. "이어보기"로 대화를 다시 봅니다.' }), listEl));
    let data;
    try {
        data = await api('/api/ui/v6/sessions');
    }
    catch (e) {
        listEl.replaceChildren(el('p', { class: 'install-token-err', text: e?.message || '목록을 불러오지 못했습니다.' }));
        return;
    }
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    if (!sessions.length) {
        listEl.replaceChildren(el('p', { class: 'admin-hint', text: '중앙에 기록된 세션이 없습니다. (관리 ▸ 세션 공유가 켜져 있어야 수집됩니다.)' }));
        return;
    }
    listEl.replaceChildren(...sessions.map((s) => sessionRow(s)));
}
function sessionRow(s) {
    const btn = el('button', { class: 'btn btn-ghost btn-sm', text: '이어보기' });
    btn.addEventListener('click', () => openTranscript(s));
    return el('div', { class: 'sess-row', style: 'display:flex;gap:10px;align-items:center;padding:9px 2px;border-bottom:1px solid rgba(127,127,127,.15)' }, el('code', { text: s.session_id, style: 'font-size:12px' }), el('span', { class: 'admin-hint', text: `${s.harness || '?'} · ${s.node_id ? s.node_id : '박스'} · ${fmtBytes(s.bytes)}` }), el('span', { style: 'flex:1' }), btn);
}
async function openTranscript(s) {
    const body = el('div', { class: 'sess-transcript', style: 'overflow:auto;padding:4px 2px' }, el('p', { class: 'admin-hint', text: '불러오는 중…' }));
    const closeBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '닫기' });
    const overlay = el('div', {
        class: 'sess-overlay',
        style: 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;display:flex;align-items:center;justify-content:center',
    }, el('div', { class: 'card', style: 'width:min(840px,94vw);max-height:86vh;display:flex;flex-direction:column;overflow:hidden' }, el('div', { class: 'card-head', style: 'display:flex;justify-content:space-between;align-items:center;gap:10px' }, el('h3', { text: '세션 ' + s.session_id, style: 'font-size:14px;overflow:hidden;text-overflow:ellipsis' }), closeBtn), body));
    const close = () => overlay.remove();
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay)
        close(); });
    document.body.appendChild(overlay);
    const q = new URLSearchParams({ node: s.node_id || '', view: 'render' }).toString();
    let data;
    try {
        data = await api(`/api/ui/v6/sessions/${encodeURIComponent(s.session_id)}/log?${q}`);
    }
    catch (e) {
        body.replaceChildren(el('p', { class: 'install-token-err', text: e?.message || '트랜스크립트를 불러오지 못했습니다.' }));
        return;
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) {
        body.replaceChildren(el('p', { class: 'admin-hint', text: '표시할 대화가 없습니다.' }));
        return;
    }
    body.replaceChildren(...items.map(itemEl));
}
function itemEl(it) {
    const label = it.role === 'user' ? '나' : it.role === 'assistant' ? 'AI' : '툴';
    const color = it.role === 'user' ? '#2563eb' : it.role === 'assistant' ? '#16a34a' : '#a16207';
    return el('div', { class: 'sess-item', style: 'padding:7px 0;border-bottom:1px solid rgba(127,127,127,.08)' }, el('span', { style: `font-weight:600;color:${color};font-size:12px`, text: label + (it.tool ? ' · ' + it.tool : '') }), 
    // ⚠ text = textContent — 트랜스크립트 본문(신뢰 불가)을 안전하게 렌더.
    el('div', { style: 'white-space:pre-wrap;margin-top:2px;font-size:13px', text: it.text }));
}

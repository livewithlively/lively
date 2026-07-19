// sessions.ts — 세션이력 웹뷰(#905 C1 슬⑤b). `#/sessions`(내 세션 목록) · `#/sessions/<sid>[?node=]`(대화록, 공유 링크).
//  설계 목표(사용자 요청): **사람 질문은 전부·바로 보이고, AI 답변은 축약(더보기)·툴콜은 접힘(펼치기)** — skimming·navigate 용이.
//  ⚠ 트랜스크립트 본문은 신뢰 불가 → 반드시 el({text})(textContent)로만 렌더(innerHTML 금지, XSS 방어).
import { api, el, toast } from './core.js';
const AI_PREVIEW = 560; // AI 답변 기본 표시 길이(넘으면 접고 [더보기]).
const fmtBytes = (b) => !b ? '비어있음' : b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : b >= 1024 ? Math.round(b / 1024) + 'KB' : b + 'B';
function fmtWhen(iso) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t))
        return '';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60)
        return '방금';
    if (s < 3600)
        return `${Math.floor(s / 60)}분 전`;
    if (s < 86400)
        return `${Math.floor(s / 3600)}시간 전`;
    if (s < 86400 * 30)
        return `${Math.floor(s / 86400)}일 전`;
    return new Date(iso).toISOString().slice(0, 10);
}
const shortId = (sid) => sid.length > 12 ? sid.slice(0, 8) + '…' : sid;
// #/sessions/<sid>[?node=] 파싱 — 없으면(=목록) null.
function parseSel() {
    const h = location.hash.replace(/^#\/?/, '');
    const path = h.split('?')[0];
    const segs = path.split('/').filter(Boolean);
    if (segs[0] !== 'sessions' || !segs[1])
        return null;
    const params = new URLSearchParams(h.includes('?') ? h.slice(h.indexOf('?') + 1) : '');
    return { sid: decodeURIComponent(segs[1]), node: params.get('node') || '' };
}
export async function renderSessions(view) {
    const sel = parseSel();
    if (sel)
        return renderTranscriptPage(view, sel.sid, sel.node);
    return renderList(view);
}
// ── 목록면 ──
async function renderList(view) {
    const listEl = el('div', { class: 'admin-hint', text: '불러오는 중…' });
    view.replaceChildren(el('div', { class: 'card', style: 'max-width:940px;margin:24px auto' }, el('div', { class: 'card-head' }, el('h2', { text: '세션 이력' })), el('p', { class: 'guide-lead', text: '어느 환경/멤버 노드에서 만들었든 중앙에 기록된 내 세션들. 클릭하면 대화를 이어봅니다.' }), listEl));
    let data;
    try {
        data = await api('/api/ui/v6/sessions');
    }
    catch (e) {
        listEl.replaceChildren(el('p', { class: 'install-token-err', text: e?.message || '목록을 불러오지 못했습니다.' }));
        return;
    }
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    renderSessionListInto(listEl, sessions, '중앙에 기록된 세션이 없습니다. (관리 ▸ 세션 공유를 켜고 `lively backfill` 로 기존 기록을 올리세요.)');
}
// 세션 목록을 컨테이너에 렌더(프로젝트 상세 탭에서도 재사용). 제목·소유자·생성·마지막활동·크기.
export function renderSessionListInto(container, sessions, emptyMsg) {
    if (!sessions.length) {
        container.replaceChildren(el('p', { class: 'admin-hint', text: emptyMsg }));
        return;
    }
    container.replaceChildren(...sessions.map(sessionRowEl));
}
function sessionRowEl(s) {
    const link = '#/sessions/' + encodeURIComponent(s.session_id) + (s.node_id ? '?node=' + encodeURIComponent(s.node_id) : '');
    const title = s.title || shortId(s.session_id);
    const who = s.owner_name || s.owner || '(알 수 없음)';
    const meta = `${who} · 만든 ${fmtWhen(s.first_seen)} · 마지막 ${fmtWhen(s.last_seen)} · ${fmtBytes(s.bytes)}${s.harness ? ' · ' + s.harness : ''}`;
    const open = el('a', { class: 'btn btn-ghost btn-sm', href: link, text: '이어보기 →' });
    const titleLink = el('a', { href: link, style: 'font-weight:600;text-decoration:none;color:inherit', text: title });
    return el('div', { class: 'sess-row', style: 'display:flex;gap:12px;align-items:center;padding:10px 2px;border-bottom:1px solid rgba(127,127,127,.15)' }, el('div', { style: 'flex:1;min-width:0' }, el('div', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, titleLink), el('div', { class: 'admin-hint', style: 'font-size:12px;margin-top:2px', text: meta })), open);
}
// ── 대화록 페이지(공유 링크) ──
async function renderTranscriptPage(view, sid, node) {
    const shareUrl = location.origin + location.pathname + '#/sessions/' + encodeURIComponent(sid) + (node ? '?node=' + encodeURIComponent(node) : '');
    const copyBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '🔗 링크 복사' });
    copyBtn.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(shareUrl);
            toast('링크를 복사했습니다 — 열람 권한 있는 사람과 공유하세요.');
        }
        catch {
            window.prompt('이 링크를 복사하세요:', shareUrl);
        }
    });
    const back = el('a', { class: 'btn btn-ghost btn-sm', href: '#/sessions', text: '← 목록' });
    const idxSlot = el('div');
    const convo = el('div', { class: 'sess-convo', style: 'margin-top:8px' }, el('p', { class: 'admin-hint', text: '불러오는 중…' }));
    view.replaceChildren(el('div', { class: 'card', style: 'max-width:920px;margin:20px auto' }, el('div', { class: 'card-head', style: 'display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap' }, el('h2', { id: 'sess-title', style: 'font-size:16px;margin:0;overflow:hidden;text-overflow:ellipsis', text: '세션 ' + shortId(sid) }), el('div', { style: 'display:flex;gap:6px' }, copyBtn, back)), idxSlot, convo));
    const q = new URLSearchParams({ node, view: 'render' }).toString();
    let data;
    try {
        data = await api(`/api/ui/v6/sessions/${encodeURIComponent(sid)}/log?${q}`);
    }
    catch (e) {
        convo.replaceChildren(el('p', { class: 'install-token-err', text: e?.message || '대화록을 불러오지 못했습니다(열람 권한이 없을 수 있습니다).' }));
        return;
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) {
        convo.replaceChildren(el('p', { class: 'admin-hint', text: '표시할 대화가 없습니다.' }));
        return;
    }
    const turns = groupTurns(items);
    // 제목 = 첫 사람 질문(있으면).
    const firstQ = turns.find((t) => t.user)?.user?.text;
    if (firstQ) {
        const h = document.getElementById('sess-title');
        if (h)
            h.textContent = firstQ.length > 80 ? firstQ.slice(0, 80) + '…' : firstQ;
    }
    idxSlot.replaceChildren(questionIndex(turns));
    convo.replaceChildren(...turns.map(turnEl));
}
// 사람 발화마다 새 턴 시작, 뒤따르는 AI/툴은 그 턴에 붙인다(첫 사람 발화 이전 AI 는 user=null 턴).
function groupTurns(items) {
    const turns = [];
    let cur = null;
    for (const it of items) {
        if (it.role === 'user') {
            cur = { user: it, ai: [] };
            turns.push(cur);
        }
        else {
            if (!cur) {
                cur = { user: null, ai: [] };
                turns.push(cur);
            }
            cur.ai.push(it);
        }
    }
    return turns;
}
// 질문 인덱스(skimming/navigate) — 접이식. 각 항목 클릭 시 해당 턴으로 스크롤.
function questionIndex(turns) {
    const qs = turns.map((t, i) => ({ i, text: t.user?.text || '' })).filter((x) => x.text);
    if (!qs.length)
        return el('div');
    const list = el('div', { style: 'display:none;margin-top:6px;padding-left:4px;border-left:2px solid rgba(127,127,127,.25)' }, ...qs.map((q) => {
        const a = el('a', { href: 'javascript:void 0', class: 'admin-hint',
            style: 'display:block;padding:3px 8px;font-size:12px;text-decoration:none;color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
            text: `${q.i + 1}. ${q.text}` });
        a.addEventListener('click', (e) => { e.preventDefault(); document.getElementById('turn-' + q.i)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
        return a;
    }));
    const toggle = el('button', { class: 'btn btn-ghost btn-sm', text: `질문 ${qs.length}개 ▾` });
    toggle.addEventListener('click', () => {
        const open = list.style.display === 'none';
        list.style.display = open ? 'block' : 'none';
        toggle.textContent = `질문 ${qs.length}개 ${open ? '▴' : '▾'}`;
    });
    return el('div', { style: 'margin:6px 0' }, toggle, list);
}
function turnEl(t, idx) {
    const box = el('div', { class: 'sess-turn', id: 'turn-' + idx, style: 'margin:10px 0' });
    if (t.user)
        box.append(userBubble(t.user.text));
    for (const it of t.ai)
        if (it.role === 'assistant' && it.text)
            box.append(aiBubble(it.text));
    const tools = t.ai.filter((i) => i.role === 'tool');
    if (tools.length)
        box.append(toolsChip(tools));
    return box;
}
// 사람 질문 — 전부·바로 보인다(축약 없음), 시각적으로 두드러지게.
function userBubble(text) {
    return el('div', { style: 'background:rgba(37,99,235,.10);border-left:3px solid #2563eb;border-radius:6px;padding:8px 12px;margin:8px 0' }, el('div', { style: 'font-weight:700;font-size:11px;color:#2563eb;margin-bottom:2px', text: '나' }), el('div', { style: 'white-space:pre-wrap;font-size:14px', text: text }));
}
// AI 답변 — 기본은 제한 길이까지, 넘으면 [더보기]/[접기]. 축약해서 사람 질문 사이가 잘 보이게.
function aiBubble(text) {
    const wrap = el('div', { style: 'padding:6px 12px;margin:4px 0 4px 8px' });
    const head = el('div', { style: 'font-weight:700;font-size:11px;color:#16a34a;margin-bottom:2px', text: 'AI' });
    const body = el('div', { style: 'white-space:pre-wrap;font-size:13.5px;color:var(--fg,#333)' });
    wrap.append(head, body);
    const long = text.length > AI_PREVIEW;
    let expanded = false;
    const render = () => {
        body.textContent = expanded || !long ? text : text.slice(0, AI_PREVIEW) + '…';
        if (long) {
            const btn = el('button', { class: 'btn btn-ghost btn-sm', style: 'margin-top:2px;font-size:12px', text: expanded ? '접기' : '더보기' });
            btn.addEventListener('click', () => { expanded = !expanded; render(); });
            body.append(el('div', {}, btn));
        }
    };
    render();
    return wrap;
}
// 툴 호출 — 기본 접힘. [펼치기] 하면 이름+요약 목록. 대화 읽기 흐름에서 노이즈 제거.
function toolsChip(tools) {
    const names = [...new Set(tools.map((t) => t.tool).filter(Boolean))].slice(0, 4).join(', ');
    const detail = el('div', { style: 'display:none;margin:4px 0 4px 8px;padding:6px 10px;border-left:2px solid rgba(161,98,7,.35);background:rgba(161,98,7,.06);border-radius:4px' }, ...tools.map((t) => el('div', { style: 'font-size:12px;padding:2px 0;font-family:ui-monospace,Menlo,monospace' }, el('span', { style: 'color:#a16207;font-weight:600', text: (t.tool || 'tool') + ' ' }), el('span', { style: 'opacity:.8', text: t.text || '' }))));
    const btn = el('button', { class: 'btn btn-ghost btn-sm', style: 'margin:2px 0 2px 8px;font-size:12px', text: `🔧 도구 ${tools.length}개${names ? ' · ' + names : ''} ▸` });
    btn.addEventListener('click', () => {
        const open = detail.style.display === 'none';
        detail.style.display = open ? 'block' : 'none';
        btn.textContent = `🔧 도구 ${tools.length}개${names ? ' · ' + names : ''} ${open ? '▾' : '▸'}`;
    });
    return el('div', {}, btn, detail);
}

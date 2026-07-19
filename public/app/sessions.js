// sessions.ts — 세션이력 웹뷰(#905 C1 슬⑤b). `#/sessions`(내 세션 목록) · `#/sessions/<sid>[?node=&q=&ln=]`(대화록·공유).
//  설계(사용자 요청): 스키밍 — 질문·답변 모두 10줄 하드 캡(더보기)·질문 사이드바 네비·마크다운 렌더·질문/줄 단위 링크.
//  ⚠ 트랜스크립트 본문은 신뢰 불가 → el({text})(textContent) 또는 renderMarkdown(core, textContent 기반)로만 렌더(innerHTML 금지, XSS 방어).
import { api, el, toast, renderMarkdown } from './core.js';
const PAGE_SIZE = 15; // 목록 페이지당 세션 수(페이지네이션).
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
// #/sessions/<sid>[?node=&q=&ln=] 파싱 — 없으면(=목록) null. q=질문(턴) 앵커, ln=줄/블록 앵커.
function parseSel() {
    const h = location.hash.replace(/^#\/?/, '');
    const path = h.split('?')[0];
    const segs = path.split('/').filter(Boolean);
    if (segs[0] !== 'sessions' || !segs[1])
        return null;
    const params = new URLSearchParams(h.includes('?') ? h.slice(h.indexOf('?') + 1) : '');
    return { sid: decodeURIComponent(segs[1]), node: params.get('node') || '', q: params.get('q') || '', ln: params.get('ln') || '' };
}
export async function renderSessions(view) {
    const sel = parseSel();
    if (sel)
        return renderTranscriptPage(view, sel);
    return renderList(view);
}
// ── 목록면(#/sessions) ──
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
// 세션 목록을 컨테이너에 렌더 — 페이지네이션 + 빈 세션(0바이트) 방어적 제외. onGo: 행 진입 시 콜백(모달 닫기 등).
export function renderSessionListInto(container, sessions, emptyMsg, onGo) {
    const rows = (Array.isArray(sessions) ? sessions : []).filter((s) => (s.bytes || 0) > 0);
    if (!rows.length) {
        container.replaceChildren(el('p', { class: 'admin-hint', text: emptyMsg }));
        return;
    }
    const pages = Math.ceil(rows.length / PAGE_SIZE);
    let page = 0;
    const listBox = el('div');
    const pager = el('div', { style: 'display:flex;gap:10px;align-items:center;justify-content:center;margin-top:12px' });
    const draw = () => {
        listBox.replaceChildren(...rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((s) => sessionRowEl(s, onGo)));
        if (pages <= 1) {
            pager.replaceChildren();
            return;
        }
        const prev = el('button', { class: 'btn btn-ghost btn-sm', text: '← 이전' });
        const next = el('button', { class: 'btn btn-ghost btn-sm', text: '다음 →' });
        prev.disabled = page === 0;
        next.disabled = page >= pages - 1;
        prev.addEventListener('click', () => { if (page > 0) {
            page--;
            draw();
        } });
        next.addEventListener('click', () => { if (page < pages - 1) {
            page++;
            draw();
        } });
        pager.replaceChildren(prev, el('span', { class: 'admin-hint', style: 'font-size:12px', text: `${page + 1} / ${pages} · 총 ${rows.length}` }), next);
    };
    draw();
    container.replaceChildren(listBox, pager);
}
function sessionRowEl(s, onGo) {
    const link = '#/sessions/' + encodeURIComponent(s.session_id) + (s.node_id ? '?node=' + encodeURIComponent(s.node_id) : '');
    const title = s.title || shortId(s.session_id);
    const who = s.owner_name || s.owner || '(알 수 없음)';
    const meta = `${who} · 만든 ${fmtWhen(s.first_seen)} · 마지막 ${fmtWhen(s.last_seen)} · ${fmtBytes(s.bytes)}${s.harness ? ' · ' + s.harness : ''}`;
    const remember = () => { try {
        sessionStorage.setItem('sessReturn', location.hash || '#/sessions');
    }
    catch { /* */ } if (onGo)
        onGo(); };
    const open = el('a', { class: 'btn btn-ghost btn-sm', href: link, text: '이어보기 →' });
    const titleLink = el('a', { href: link, style: 'font-weight:600;text-decoration:none;color:inherit', text: title });
    open.addEventListener('click', remember);
    titleLink.addEventListener('click', remember);
    return el('div', { class: 'sess-row', style: 'display:flex;gap:12px;align-items:center;padding:10px 2px;border-bottom:1px solid rgba(127,127,127,.15)' }, el('div', { style: 'flex:1;min-width:0' }, el('div', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, titleLink), el('div', { class: 'admin-hint', style: 'font-size:12px;margin-top:2px', text: meta })), open);
}
// 프로젝트 탭 '세션 기록' — 버튼→모달(공간 절약). 페이지네이션·빈세션 제외. 진입 시 오버레이 닫고 프로젝트를 '돌아갈 곳'으로.
export async function openProjectSessionsModal(projectId, projectName) {
    const body = el('div', { class: 'admin-hint', text: '불러오는 중…' });
    const box = el('div', { class: 'ov-box', style: 'max-width:820px;width:92%' }, el('div', { class: 'ov-head' }, el('h3', { text: `세션 기록${projectName ? ' · ' + projectName : ''}` }), el('button', { class: 'btn-text', text: '닫기', onclick: () => back.remove() })), el('p', { class: 'admin-hint', style: 'margin:0 0 8px', text: '이 프로젝트에서 만든 AI 세션 대화록(끝난 세션 포함).' }), body);
    const back = el('div', { class: 'ov-back' }, box);
    back.addEventListener('click', (e) => { if (e.target === back)
        back.remove(); });
    const esc = (ev) => { if (ev.key === 'Escape') {
        back.remove();
        document.removeEventListener('keydown', esc);
    } };
    document.addEventListener('keydown', esc);
    document.body.append(back);
    let d;
    try {
        d = await api('/api/ui/v6/projects/' + projectId + '/session-logs');
    }
    catch (e) {
        body.replaceChildren(el('p', { class: 'install-token-err', text: e?.message || '세션 기록을 불러오지 못했습니다.' }));
        return;
    }
    renderSessionListInto(body, (d && d.sessions) || [], '이 프로젝트에 기록된(내용 있는) 세션이 없습니다.', () => back.remove());
}
// ── 대화록 페이지(공유 링크) ──
function buildShareLink(sid, node, extra) {
    const p = new URLSearchParams();
    if (node)
        p.set('node', node);
    for (const k in (extra || {}))
        p.set(k, String(extra[k]));
    const qs = p.toString();
    return location.origin + location.pathname + '#/sessions/' + encodeURIComponent(sid) + (qs ? '?' + qs : '');
}
async function copyLink(url) {
    try {
        await navigator.clipboard.writeText(url);
        toast('링크를 복사했습니다 — 열람 권한 있는 사람과 공유하세요.');
    }
    catch {
        window.prompt('이 링크를 복사하세요:', url);
    }
}
// 앵커(줄/블록·질문)로 스크롤 + 잠깐 하이라이트. 접힌 답변 안이면 먼저 펼친다.
function gotoAnchor(sel) {
    let target = null;
    if (sel.ln)
        target = document.getElementById('ln-' + sel.ln);
    else if (sel.q)
        target = document.getElementById('turn-' + sel.q);
    if (!target)
        return;
    const body = target.closest('.sess-body'); // 접힌 답변 속이면 펼치기
    if (body && body.classList.contains('clamp')) {
        const more = body.parentElement?.querySelector('.sess-more');
        if (more)
            more.click();
    }
    requestAnimationFrame(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('sess-flash');
        setTimeout(() => target.classList.remove('sess-flash'), 2600);
    });
}
async function renderTranscriptPage(view, sel) {
    const { sid, node } = sel;
    const copyBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '🔗 링크 복사' });
    copyBtn.addEventListener('click', () => copyLink(buildShareLink(sid, node)));
    let returnTo = '#/sessions';
    try {
        returnTo = sessionStorage.getItem('sessReturn') || '#/sessions';
    }
    catch { /* */ }
    const back = el('a', { class: 'btn btn-ghost btn-sm', href: returnTo, text: '← 뒤로' });
    const sideSlot = el('nav', { class: 'sess-side' });
    const convo = el('div', { class: 'sess-main', style: 'min-width:0' }, el('p', { class: 'admin-hint', text: '불러오는 중…' }));
    view.replaceChildren(el('div', { class: 'card', style: 'max-width:1160px;margin:20px auto' }, el('div', { class: 'card-head', style: 'display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap' }, el('h2', { id: 'sess-title', style: 'font-size:16px;margin:0;overflow:hidden;text-overflow:ellipsis', text: '세션 ' + shortId(sid) }), el('div', { style: 'display:flex;gap:6px' }, copyBtn, back)), el('div', { class: 'sess-layout', style: 'display:flex;gap:20px;align-items:flex-start;margin-top:8px' }, sideSlot, convo)));
    const qy = new URLSearchParams({ node, view: 'render' }).toString();
    let data;
    try {
        data = await api(`/api/ui/v6/sessions/${encodeURIComponent(sid)}/log?${qy}`);
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
    const firstQ = turns.find((t) => t.user)?.user?.text;
    if (firstQ) {
        const h = document.getElementById('sess-title');
        if (h)
            h.textContent = firstQ.length > 80 ? firstQ.slice(0, 80) + '…' : firstQ;
    }
    sideSlot.replaceChildren(sidebar(turns, sid, node));
    convo.replaceChildren(...turns.map((t, i) => turnEl(t, i, sid, node)));
    requestAnimationFrame(() => { finalizeCaps(convo); if (sel.q || sel.ln)
        setTimeout(() => gotoAnchor(sel), 60); });
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
// 질문 사이드바(skimming/navigate) — 항상 보이는 세로 목록. 항목 클릭 = 그 질문으로 스크롤, 🔗 = 질문 링크 복사.
function sidebar(turns, sid, node) {
    const qs = turns.map((t, i) => ({ i, text: t.user?.text || '' })).filter((x) => x.text);
    const box = el('div', {}, el('div', { class: 'sess-side-head', text: `질문 ${qs.length}개` }));
    if (!qs.length) {
        box.append(el('p', { class: 'admin-hint', style: 'font-size:12px', text: '(질문 없음)' }));
        return box;
    }
    for (const q of qs) {
        const label = el('button', { class: 'sess-side-item', title: q.text, text: `${q.i + 1}. ${q.text}` });
        label.addEventListener('click', () => document.getElementById('turn-' + q.i)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
        const cp = el('button', { class: 'sess-side-copy', title: '이 질문 링크 복사', text: '🔗' });
        cp.addEventListener('click', (e) => { e.stopPropagation(); copyLink(buildShareLink(sid, node, { q: String(q.i) })); });
        box.append(el('div', { class: 'sess-side-row' }, label, cp));
    }
    return box;
}
function turnEl(t, idx, sid, node) {
    const box = el('div', { class: 'sess-turn', id: 'turn-' + idx, style: 'margin:8px 0 14px' });
    if (t.user)
        box.append(userBubble(t.user.text, idx, sid, node));
    let aiIdx = 0;
    for (const it of t.ai)
        if (it.role === 'assistant' && it.text)
            box.append(aiBubble(it.text, idx, aiIdx++, sid, node));
    const tools = t.ai.filter((i) => i.role === 'tool');
    if (tools.length)
        box.append(toolsChip(tools));
    return box;
}
// 한 줄/블록을 앵커(id)+호버 링크복사(🔗)로 감싼다 — 질문/답변의 특정 지점으로 링크 전달.
function lineWrap(content, anchor, sid, node) {
    const cp = el('button', { class: 'sess-line-copy', title: '이 지점 링크 복사', text: '🔗' });
    cp.addEventListener('click', () => copyLink(buildShareLink(sid, node, { ln: anchor })));
    return el('div', { class: 'sess-line', id: 'ln-' + anchor }, cp, content);
}
// 사람 질문 — 파란 배경(라벨 없음). 원문 그대로(줄 단위 앵커), 10줄 넘으면 접힘.
function userBubble(text, turnIdx, sid, node) {
    const body = el('div', { class: 'sess-body clamp', style: 'font-size:14px' });
    const lines = text.split('\n');
    lines.forEach((ln, li) => body.append(lineWrap(el('span', { style: 'white-space:pre-wrap', text: ln || ' ' }), `${turnIdx}-q-${li}`, sid, node)));
    return el('div', { class: 'sess-bubble sess-user' }, body);
}
// AI 답변 — 마크다운 렌더(**/목록/코드/표 등, textContent 기반 안전). 블록 단위 앵커. 10줄 넘으면 접힘.
function aiBubble(text, turnIdx, aiIdx, sid, node) {
    const body = el('div', { class: 'sess-body clamp', style: 'font-size:13.5px' });
    const md = renderMarkdown(text); // <div class=md> — 안전 렌더(core)
    const blocks = Array.from(md.children); // 블록 요소만(스냅샷 — append 가 원소를 옮기므로)
    if (!blocks.length)
        body.append(lineWrap(el('span', { style: 'white-space:pre-wrap', text }), `${turnIdx}-a${aiIdx}-0`, sid, node));
    else
        blocks.forEach((b, bi) => body.append(lineWrap(b, `${turnIdx}-a${aiIdx}-${bi}`, sid, node)));
    return el('div', { class: 'sess-bubble sess-ai' }, body);
}
// 마운트 후 실제 높이로 캡 확정 — 안 넘치면 clamp 해제(버튼 없음), 넘치면 [더보기]/[접기]. (CSS 로 처음부터 접혀 플리커 없음)
function finalizeCaps(root) {
    root.querySelectorAll('.sess-body.clamp').forEach((body) => {
        if (body.dataset.capReady)
            return;
        body.dataset.capReady = '1';
        if (body.scrollHeight <= body.clientHeight + 4) {
            body.classList.remove('clamp');
            return;
        } // 안 넘침 → 펼쳐둠
        const btn = el('button', { class: 'btn btn-ghost btn-sm sess-more', style: 'font-size:12px;margin-top:4px', text: '더보기 ▾' });
        let expanded = false;
        btn.addEventListener('click', () => { expanded = !expanded; body.classList.toggle('clamp', !expanded); btn.textContent = expanded ? '접기 ▴' : '더보기 ▾'; });
        if (body.parentElement)
            body.parentElement.append(btn);
    });
}
// 툴 호출 — 기본 접힘. [펼치기] 하면 이름+요약 목록(노이즈 제거하되 볼 수는 있게).
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

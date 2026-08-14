// activate.ts — CLI 디바이스 로그인 승인 화면 (#880). `#/activate?code=XXXX-XXXX`.
//  CLI 가 표시한 코드를 사람이 브라우저(로그인된 세션)에서 승인 → CLI 가 폴링해 토큰을 받는다.
//
//  ⚠ 보안(설계 R1~R3):
//   · 승인은 이 페이지의 세션 자격으로 이뤄진다(서버가 tokenSource!=='static' 강제).
//   · client_label 은 요청 기기가 **스스로 주장**한 값 — el({text})(textContent)로만 렌더(innerHTML 금지).
//   · 양방향 피싱 경고: ① 남이 준 코드 승인 금지(내 계정 탈취) ② 남의 코드 승인 금지(그 기기가 나로 로그인).
//   · client_ip 는 서버가 안 준다(trust proxy 미설정이라 프록시 IP=모든 클라 동일 → 신뢰신호 무의미).
//   · control-plane(관리권한) 포함 승인은 비밀번호 재확인(step-up) — 서버가 검증.
import { api, busy, el, state, toast, usernameAnchor } from './core.js';
export async function renderActivate(view) {
    const params = new URLSearchParams((location.hash.split('?')[1] || ''));
    const prefill = (params.get('code') || '').trim();
    const slot = el('div', { class: 'activate-result' });
    // 승인코드는 아이디도 비번도 아니다 — autocomplete 를 **명시하지 않아** el() 의 자동완성 차단을 받는다(#1250).
    //  (아래 비번 재확인칸 때문에 크롬이 이 칸을 아이디로 오인해 이메일을 채우던 자리.)
    const codeInput = el('input', {
        type: 'text', class: 'term-input', spellcheck: 'false',
        placeholder: '터미널에 표시된 코드 (예: MPQR-STVW)', value: prefill,
        style: 'text-transform:uppercase;letter-spacing:2px;font-family:ui-monospace,Menlo,monospace',
    });
    const goBtn = el('button', { class: 'btn btn-primary btn-sm', text: '조회' });
    const look = () => drawLookup(slot, codeInput.value);
    goBtn.addEventListener('click', look);
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') {
        e.preventDefault();
        look();
    } });
    view.replaceChildren(el('div', { class: 'card', style: 'max-width:560px;margin:24px auto' }, el('div', { class: 'card-head' }, el('h2', { text: '터미널 로그인 승인' })), el('p', { class: 'guide-lead', text: '내 컴퓨터 터미널에서 lively 로그인을 시작하면 코드가 표시됩니다. 그 코드를 아래에 넣고 승인하세요.' }), 
    // ⚠ 피싱 경고 — 양방향.
    el('div', { class: 'callout', style: 'border-left:3px solid #d9822b;padding:8px 12px;margin:8px 0;background:rgba(217,130,43,.08)' }, el('p', { style: 'margin:0 0 4px;font-weight:600', text: '⚠ 본인이 방금 자기 기기에서 시작한 로그인만 승인하세요.' }), el('ul', { style: 'margin:0;padding-left:18px' }, el('li', { text: '남이 준 코드를 입력·승인하지 마세요 — 당신 계정이 그 사람에게 넘어갑니다.' }), el('li', { text: '남의 코드를 대신 승인하지 마세요 — 그 기기가 당신 이름으로 로그인됩니다.' }))), el('div', { class: 'install-minter', style: 'display:flex;gap:8px;align-items:center' }, codeInput, goBtn), slot));
    if (prefill)
        look();
}
// 코드 조회 → 기기 정보 + 승인/거부.
async function drawLookup(slot, raw) {
    const code = String(raw || '').trim();
    if (!code) {
        slot.replaceChildren(el('p', { class: 'admin-hint', text: '코드를 입력하세요.' }));
        return;
    }
    busy(slot, el('p', { class: 'admin-hint', text: '조회 중…' }));
    let info;
    try {
        info = await api('/api/ui/cli/device/lookup?code=' + encodeURIComponent(code));
    }
    catch (e) {
        slot.replaceChildren(el('p', { class: 'install-token-err', text: e?.message || '조회 실패 — 코드를 확인하세요(만료됐을 수 있습니다).' }));
        return;
    }
    // control-plane opt-in — admin/runtime 보유 멤버만 노출.
    const scopes = Array.isArray(state.me?.scopes) ? state.me.scopes : [];
    const canCp = scopes.includes('admin') || scopes.includes('runtime');
    const cpChk = el('input', { type: 'checkbox' });
    // 여긴 진짜 계정 비밀번호(step-up)다 → autocomplete 를 명시해 브라우저가 **제대로** 돕게 둔다.
    //  단, 아이디칸을 명시하지 않으면 크롬이 위 승인코드칸을 아이디로 오인하므로 숨은 앵커를 바로 앞에 둔다(#1250).
    const pwInput = el('input', { type: 'password', class: 'term-input', placeholder: '비밀번호 재확인',
        autocomplete: 'current-password', style: 'margin-top:6px;display:none' });
    const pwAnchor = usernameAnchor();
    const cpBlock = canCp ? el('div', { style: 'margin:8px 0;position:relative' }, el('label', { class: 'admin-check', style: 'cursor:pointer' }, cpChk, el('span', { text: ' 관리 권한(admin/runtime) 포함 — 이 CLI 세션이 관리탭 기능(구성원·토큰·훅·DB소스)을 MCP로 다룹니다.' })), pwAnchor, pwInput) : null;
    if (canCp)
        cpChk.addEventListener('change', () => { pwInput.style.display = cpChk.checked ? 'block' : 'none'; });
    const approveBtn = el('button', { class: 'btn btn-primary btn-sm', text: '승인' });
    const denyBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '거부' });
    approveBtn.addEventListener('click', async () => {
        approveBtn.disabled = true;
        try {
            const body = { user_code: code };
            if (canCp && cpChk.checked) {
                body.include_control_plane = true;
                body.password = pwInput.value;
            }
            await api('/api/ui/cli/device/approve', { method: 'POST', body: JSON.stringify(body) });
            slot.replaceChildren(el('div', { class: 'install-ok' }, el('p', { style: 'font-weight:600', text: '✓ 승인됐습니다.' }), el('p', { text: '이제 터미널로 돌아가세요 — 로그인이 이어집니다. (터미널에서 한 번 더 “계속할까요?”를 확인해 주세요.)' })));
        }
        catch (e) {
            approveBtn.disabled = false;
            toast(e?.message || '승인 실패', true);
        }
    });
    denyBtn.addEventListener('click', async () => {
        try {
            await api('/api/ui/cli/device/deny', { method: 'POST', body: JSON.stringify({ user_code: code }) });
        }
        catch { /* */ }
        slot.replaceChildren(el('p', { class: 'admin-hint', text: '거부했습니다. 터미널의 로그인은 취소됩니다.' }));
    });
    const when = timeAgo(info.created_at);
    slot.replaceChildren(el('div', { style: 'margin-top:12px;border-top:1px solid rgba(127,127,127,.18);padding-top:12px' }, el('p', { style: 'margin:0 0 2px' }, '이 기기가 승인을 기다립니다: ', el('b', { text: info.client_label || '(이름 없음)' })), // ← textContent (el text) — XSS 안전
    el('p', { class: 'admin-hint', style: 'margin:0 0 8px' }, `${when} 요청됨. 이 이름은 요청 기기가 스스로 주장한 값입니다 — 본인 기기가 맞는지 확인하세요.`), cpBlock, el('div', { style: 'display:flex;gap:8px;margin-top:8px' }, approveBtn, denyBtn)));
}
function timeAgo(iso) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t))
        return '방금';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60)
        return `${s}초 전`;
    if (s < 3600)
        return `${Math.floor(s / 60)}분 전`;
    return `${Math.floor(s / 3600)}시간 전`;
}

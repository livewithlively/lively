// me-profile.ts — 개인 프로필: [내 정보] 모달 · 아바타 편집 · 비밀번호 변경 · 개인 레이어 직렬화 규약
//  (#1313 R38, admin.ts 에서 verbatim 분리).
//  ⚠ web/main.ts 가 changePasswordModal·openMyProfileModal 을 './admin.js' 에서 import 한다 — admin.ts 가
//   이 모듈을 그대로 재수출해 main.ts 를 무수정으로 둔다(소비자 import 문 무변경 계약).
//  PROF_* · profChips · parseMyProfile 은 [내 설정 ▸ 내 AI 설정](me-ai.ts)이 함께 쓴다 — 모달과 그 화면이
//   같은 저장 경로(POST /api/ui/me/profile)를 부분 갱신으로 나눠 쓰기 때문에 직렬화 규약이 한 곳이어야 한다.
import { api, apiUrl, el, errorNote, logout, profileAvatar, setPersonAvatar, state, toast, uiText, usernameAnchor } from './core.js';
import { THEME_ORDER, applyToOpenTabs, harnessThemeSync, setApplyToOpenTabs, setHarnessThemeSync, setThemePref, themePref } from './theme.js'; // #1683 화면 테마 · AI 세션 동기화
import { field, skeleton } from './ui-primitives.js';
// 우측 상단 '내 프로필' — 인증된 구성원이 자기 표시 이름·개인 레이어를 직접 편집(셀프 서비스, 선택형).
//  관리자 경로(관리▸구성원) 없이 본인이 채운다. 권한·이메일·상태·계정연결·내부 아이디는 admin 전용(여기 없음).
//  개인 레이어는 자유 텍스트(body_md)로 저장되지만 편집 UI 는 '고르기' — 항목별 선택지를 제시하고 선택을
//  canonical markdown 으로 직렬화한다. 다시 열면 그 markdown 을 파싱해 선택을 복원한다(parseMyProfile).
//  데이터: GET /api/ui/me/profile 1회 → 저장 POST /api/ui/me/profile(id 는 서버가 principal 로 강제 — 타인 편집 불가).
const PROF_DEV = [
    { v: '비개발', label: '비개발', hint: '코드는 직접 안 봐요 — 기술용어는 풀어서, 결론·근거 위주로' },
    { v: '기초', label: '기초', hint: '코드를 읽고 따라갈 수 있어요 — 핵심 코드는 보여주되 설명을 곁들여' },
    { v: '능숙', label: '능숙', hint: '직접 짜고 방향도 제시해요 — 코드 중심으로 적당히 깊게' },
    { v: '전문', label: '전문', hint: '아키텍처·리뷰까지 깊게 봐요 — 군더더기 없이 기술적으로' },
];
const PROF_TONE = ['친근한 존댓말', '간결한 존댓말', '격식 있는 존댓말', '편한 반말', '위트 있는 존댓말'];
// 사용 언어 — 내 AI 가 답하는 언어. 프리셋 칩 + '직접 입력'(목록 밖 언어). tone/dev 와 달리 언어는 장꼬리라 자유입력을 허용한다.
const PROF_LANG = ['한국어', 'English', '日本語', '中文'];
// 단일 선택 chip 그룹 — selected.v 를 토글(다시 누르면 해제). getVal/getLabel 로 옵션 모양에 무관.
function profChips(opts, selected, getLabel, getVal, onPick) {
    const wrap = el('div', { class: 'prof-chips' });
    const chips = [];
    const repaint = () => chips.forEach((c) => c.el.classList.toggle('on', c.val === selected.v));
    opts.forEach((o) => {
        const val = getVal(o);
        const chip = el('button', { type: 'button', class: 'prof-chip' + (val === selected.v ? ' on' : ''), text: getLabel(o) });
        chip.addEventListener('click', () => {
            selected.v = (selected.v === val) ? '' : val;
            repaint();
            if (onPick)
                onPick(selected.v);
        });
        chips.push({ el: chip, val });
        wrap.append(chip);
    });
    wrap.repaint = repaint; // 외부에서 selected.v 를 바꾼 뒤(예: '직접 입력' 타이핑) 칩 하이라이트를 동기화한다.
    return wrap;
}
// canonical body_md → 선택값 복원. 기본 견본(채워넣기/local.md)은 빈값으로(새로 시작).
function parseMyProfile(md) {
    const r = { role: '', dev: '', address: '', tone: '', lang: '', memo: '' };
    if (!md || /채워넣기|members\/local\.md/.test(md))
        return r;
    const parts = md.split(/^##\s*추가 메모\s*$/m);
    const head = parts[0] || '';
    if (parts[1])
        r.memo = parts[1].trim();
    const grab = (re) => { const m = head.match(re); return m ? m[1].trim() : ''; };
    r.role = grab(/^[-*\s]*\**\s*역할\s*\**\s*[:：]\s*(.+)$/m);
    const dev = grab(/^[-*\s]*\**\s*개발[^:：\n]*\**\s*[:：]\s*(.+)$/m);
    r.dev = (PROF_DEV.find((d) => dev.startsWith(d.label)) || {}).v || '';
    r.address = grab(/^[-*\s]*\**\s*호칭[^:：\n]*\**\s*[:：]\s*(.+)$/m);
    const tone = grab(/^[-*\s]*\**\s*말투\s*\**\s*[:：]\s*(.+)$/m);
    r.tone = PROF_TONE.find((t) => tone.startsWith(t)) || '';
    r.lang = grab(/^[-*\s]*\**\s*사용\s*언어\s*\**\s*[:：]\s*(.+)$/m).split(' — ')[0].trim(); // 뒤에 붙는 지시문(' — 되도록…')을 떼고 언어값만 복원(구 데이터는 지시문 없어 그대로).
    // 응답 길이·담당 영역·자주 쓰는 도구는 #837 에서 제거 — 파싱도 안 한다(다음 저장에 자연 소멸).
    return r;
}
// 업로드 이미지 → 128px 정사각(center-crop) JPEG data URL. 작게 만들어 org_member.avatar 에 인라인 저장.
function fileToAvatarDataUrl(file) {
    return new Promise((resolve, reject) => {
        if (!file || !/^image\//.test(file.type)) {
            reject(new Error('이미지 파일만 올릴 수 있어요'));
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('파일을 읽지 못했습니다'));
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const size = 128;
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    reject(new Error('이미지를 처리하지 못했습니다'));
                    return;
                }
                const s = Math.min(img.width, img.height); // 짧은 변 기준 정사각 center-crop
                ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
                resolve(canvas.toDataURL('image/jpeg', 0.85));
            };
            img.onerror = () => reject(new Error('이미지를 불러오지 못했습니다'));
            img.src = String(reader.result);
        };
        reader.readAsDataURL(file);
    });
}
// ── 비밀번호 변경 모달 (#444) ──
// 두 진입: (a) 임시 비번(must_change) 로그인 직후 강제 변경(forced=닫기 불가, 현재 비번은 방금 임시 비번 자동),
//  (b) '내 프로필' 모달의 [비밀번호 변경](상시, 취소 가능). 백엔드 POST /api/ui/password(현재→새, 8자+).
//  보안: el()/textContent 만(innerHTML 금지). 모달 셸은 .ov-* 재사용.
const PW_INPUT_STYLE = 'width:100%; box-sizing:border-box; padding:9px 11px; border:1px solid var(--line); border-radius:9px; font-size:14px; background:var(--bg); color:var(--ink);';
function pwFieldRow(label, input) {
    return el('label', { style: 'display:flex; flex-direction:column; gap:5px; margin-bottom:12px;' }, el('span', { style: 'font-size:12.5px; font-weight:600; color:var(--ink-sub);', text: label }), input);
}
function changePasswordModal(o) {
    const forced = !!(o && o.forced);
    const presetCurrent = (o && o.currentPrefill) || '';
    const head = el('div', { class: 'ov-head' }, el('h3', { text: forced ? '새 비밀번호 설정' : '비밀번호 변경' }));
    const box = el('div', { class: 'ov-box', style: 'max-width:440px' }, head);
    const back = el('div', { class: 'ov-back' }, box);
    const close = () => back.remove();
    if (!forced) { // 강제(forced) 모드는 닫기 불가 — 새 비번을 설정해야만 진행.
        head.append(el('button', { class: 'btn btn-ghost btn-sm', text: '닫기', onclick: close }));
        back.addEventListener('click', (e) => { if (e.target === back)
            close(); });
        document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') {
            close();
            document.removeEventListener('keydown', esc);
        } });
    }
    const pwInput = (ph, ac) => el('input', { type: 'password', placeholder: ph, autocomplete: ac, style: PW_INPUT_STYLE });
    const curIn = pwInput('현재 비밀번호', 'current-password');
    const nextIn = pwInput('새 비밀번호 (8자 이상)', 'new-password');
    const confIn = pwInput('새 비밀번호 확인', 'new-password');
    const err = el('p', { class: 'gate-error', hidden: true, style: 'margin:2px 0 10px;' });
    const showErr = (m) => { err.textContent = m; err.hidden = false; };
    const rows = [];
    if (forced)
        rows.push(el('p', { class: 'admin-hint' }, ...uiText('임시 비밀번호로 로그인했습니다. 계속하려면 새 비밀번호를 설정하세요.')));
    else
        rows.push(pwFieldRow('현재 비밀번호', curIn));
    rows.push(pwFieldRow('새 비밀번호', nextIn), pwFieldRow('새 비밀번호 확인', confIn));
    const submit = el('button', { class: 'btn btn-primary', type: 'submit', text: forced ? '설정하고 계속' : '변경' });
    const secondary = forced
        ? el('button', { type: 'button', class: 'btn btn-ghost', text: '로그아웃', onclick: () => { close(); logout(); } })
        : el('button', { type: 'button', class: 'btn btn-ghost', text: '취소', onclick: close });
    const actions = el('div', { style: 'display:flex; gap:8px; justify-content:flex-end; margin-top:16px;' }, secondary, submit);
    // 아이디칸을 명시해 크롬이 '누구의 비번인지' 알게 한다 — 없으면 근처 텍스트칸을 아이디로 오인한다(#1250).
    const form = el('form', { style: 'margin:0;position:relative' }, usernameAnchor(), ...rows, err, actions);
    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const current = forced ? presetCurrent : curIn.value;
        const next = nextIn.value;
        const conf = confIn.value;
        if (!forced && !current) {
            showErr('현재 비밀번호를 입력하세요.');
            return;
        }
        if (next.length < 8) {
            showErr('새 비밀번호는 8자 이상이어야 합니다.');
            return;
        }
        if (next !== conf) {
            showErr('새 비밀번호가 일치하지 않습니다.');
            return;
        }
        if (next === current) {
            showErr('현재 비밀번호와 다른 비밀번호를 설정하세요.');
            return;
        }
        submit.disabled = true;
        try {
            await api('/api/ui/password', { method: 'POST', body: JSON.stringify({ current, next }) });
            close();
            toast('비밀번호가 변경되었습니다.');
        }
        catch (e) {
            submit.disabled = false;
            showErr((e && e.message) || '비밀번호 변경에 실패했습니다.');
        }
    });
    box.append(form);
    document.body.append(back);
    setTimeout(() => (forced ? nextIn : curIn).focus(), 0);
}
// ════════════════════════════════════════════════════════════════════
// 개인 설정 (#837 후속) — 우상단 [내 프로필] 모달 하나에 필드 15개 + 중첩 모달 2개가 들어 있었다.
//  사용자 지적: "개인 설정을 프로필 모달에서 하고있는데 이 경험이 안좋은거같아. 프로필 모달은 진짜 프사나
//  표시 이름변경정도로 하고 나머지는 관리탭에 개인 설정 대분류 하나 파서 그 안으로 적절히 옮기는게 맞지 않을까?"
//  → 모달 = 빠른 편집(프사·표시이름), 관리탭 [내 설정] = 전체. 저장 경로는 그대로다(서버가 부분 갱신).
// ════════════════════════════════════════════════════════════════════
// 아바타 편집기 — 사진 업로드 / 커스텀 글자·색 / 기본(이니셜+해시색). 모달과 [내 정보]가 공유한다.
//  payload(): undefined 인 필드는 안 보낸다 = 서버가 보존(me_profile_update 는 patch).
function avatarEditor(data, nameInput) {
    let avatarState; // undefined=변경없음 · null=기본으로 · string=새 이미지
    let charState = (data.avatar_char || '');
    let colorState = (data.avatar_color || '');
    const preview = el('span', { class: 'prof-ava-preview' });
    const render = () => {
        const cur = avatarState === undefined ? (data.avatar || null) : avatarState;
        const nm = (nameInput && nameInput.value.trim()) || data.display_name || data.email || data.id || '';
        preview.replaceChildren(profileAvatar(cur, nm, data.id, 'prof-ava-lg', { char: charState, color: colorState }));
    };
    const fileIn = el('input', { type: 'file', accept: 'image/*', style: 'display:none' });
    const uploadBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '사진 올리기' });
    const removeBtn = el('button', { type: 'button', class: 'btn-text', text: '기본 이미지로' });
    uploadBtn.addEventListener('click', () => fileIn.click());
    fileIn.addEventListener('change', async () => {
        const f = fileIn.files && fileIn.files[0];
        if (!f)
            return;
        try {
            avatarState = await fileToAvatarDataUrl(f);
            render();
        }
        catch (e) {
            toast((e && e.message) || '이미지를 처리하지 못했습니다', true);
        }
        fileIn.value = '';
    });
    removeBtn.addEventListener('click', () => { avatarState = null; render(); });
    if (nameInput)
        nameInput.addEventListener('input', render); // 이름을 바꾸면 폴백 이니셜도 갱신
    const charIn = el('input', { type: 'text', maxlength: '3', value: charState, placeholder: '글자', style: 'width:70px; text-align:center; font-weight:700;' });
    charIn.addEventListener('input', () => { charState = charIn.value; render(); });
    const AVA_COLORS = ['#6c8cff', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#64748b', '#0ea5e9', '#14b8a6', '#f97316', '#8b5cf6'];
    const colorRow = el('div', { class: 'pjv-color-swatches' });
    const paintColors = () => {
        const auto = el('button', { type: 'button', class: 'pjv-sw pjv-sw-none' + (colorState ? '' : ' on'), title: '자동(이름 해시색)', text: 'A' });
        auto.onclick = () => { colorState = ''; paintColors(); render(); };
        colorRow.replaceChildren(auto, ...AVA_COLORS.map((c) => {
            const sw = el('button', { type: 'button', class: 'pjv-sw' + (colorState === c ? ' on' : ''), style: 'background:' + c, title: c });
            sw.onclick = () => { colorState = c; paintColors(); render(); };
            return sw;
        }));
    };
    paintColors();
    render();
    const node = el('div', {}, el('div', { class: 'prof-ava-row' }, preview, el('div', { class: 'prof-ava-actions' }, fileIn, uploadBtn, removeBtn, el('p', { class: 'prof-hint', style: 'margin:0' }, ...uiText('정사각형 이미지를 권장해요. 안 올리면 아래 글자·색(또는 이름 이니셜)으로 자동 생성됩니다.')))), el('div', { class: 'prof-ava-cc', style: 'margin-top:12px' }, el('div', { style: 'display:flex; align-items:center; gap:12px; flex-wrap:wrap' }, charIn, colorRow), el('p', { class: 'prof-hint', style: 'margin:6px 0 0' }, ...uiText('사진이 없을 때 아바타에 쓸 글자(비우면 이니셜)와 배경색이에요.'))));
    const payload = () => {
        const out = { avatar_char: charState.trim() || null, avatar_color: colorState || null };
        if (avatarState !== undefined)
            out.avatar = avatarState; // 미변경이면 아예 안 보낸다 → 서버 보존
        return out;
    };
    return { node, payload };
}
// 저장 후 상단바(아바타·이름)·사람 아바타 맵 즉시 갱신 — 모달·[내 정보] 공유.
function applyMyProfileSaved(res, fallbackId) {
    const m = (res && res.member) || {};
    if (state.me) {
        state.me.display_name = m.display_name || null;
        state.me.avatar = m.avatar || null;
        state.me.avatar_char = m.avatar_char || null;
        state.me.avatar_color = m.avatar_color || null;
    }
    setPersonAvatar((state.me && state.me.userId) || fallbackId, m);
    const label = (m.display_name && m.display_name.trim()) || m.email || (state.me && (state.me.email || state.me.userId)) || '';
    const ue = document.getElementById('user-email');
    if (ue)
        ue.replaceChildren(profileAvatar(m.avatar || null, label, (state.me && state.me.userId) || fallbackId, 'topbar-ava', { char: m.avatar_char, color: m.avatar_color }), el('span', { text: label }));
}
// ── '내 정보' 팝업(#762) — 우측 상단 프로필 클릭 시 열림. 관리에서 분리. 아바타 · 이름 · 닉네임 · 이메일(읽기) · 비밀번호. ──
//  닉네임은 표시 이름(이름)과 별개 필드 — 대시보드 활동 로그 등 캐주얼 표기에 쓰인다(비우면 이름 폴백).
export async function openMyProfileModal() {
    const head = el('div', { class: 'ov-head' }, el('h3', { text: '내 정보' }));
    const box = el('div', { class: 'ov-box', style: 'max-width:520px' }, head);
    const back = el('div', { class: 'ov-back' }, box);
    const close = () => back.remove();
    head.append(el('button', { class: 'btn btn-ghost btn-sm', text: '닫기', onclick: close }));
    back.addEventListener('click', (e) => { if (e.target === back)
        close(); });
    document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') {
        close();
        document.removeEventListener('keydown', esc);
    } });
    const bodyWrap = el('div', {}, skeleton('내 정보를 불러오는 중'));
    box.append(bodyWrap);
    document.body.append(back);
    let data;
    try {
        data = await api('/api/ui/me/profile');
    }
    catch (e) {
        bodyWrap.replaceChildren(errorNote(e, '내 정보를 불러오지 못했습니다'));
        return;
    }
    // 로그인 수단(#1520) — 실패해도 프로필 편집은 그대로 되게 조용히 넘어간다(부가 정보).
    let logins = null;
    try {
        logins = await api('/api/ui/me/logins');
    }
    catch (_) { /* OIDC 미설정 배포 등 — 섹션을 안 그린다 */ }
    const nameIn = el('input', { type: 'text', value: data.display_name || '', placeholder: '이름 (비우면 이메일/아이디로 표시)' });
    const nickIn = el('input', { type: 'text', value: data.nickname || '', placeholder: '닉네임 (비우면 이름으로 표시)' });
    const ava = avatarEditor(data, nameIn);
    const saveBtn = el('button', { type: 'button', class: 'btn btn-primary', text: '저장' });
    const status = el('span', { class: 'admin-status' });
    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        // body_md 는 **안 보낸다** — 서버가 미전송 필드를 보존하므로 [내 AI 설정]이 지워지지 않는다.
        const payload = { display_name: nameIn.value.trim(), nickname: nickIn.value.trim(), ...ava.payload() };
        try {
            const res = await api('/api/ui/me/profile', { method: 'POST', body: JSON.stringify(payload) });
            applyMyProfileSaved(res, data.id);
            toast('저장됨');
            status.textContent = '저장됨';
        }
        catch (e) {
            toast((e && e.message) || '저장하지 못했습니다', true);
        }
        saveBtn.disabled = false;
    });
    bodyWrap.replaceChildren(el('p', { class: 'admin-hint', style: 'margin:0 0 14px' }, ...uiText('이름·사진은 프로젝트·작업 기록·팀 화면 어디에서나 나를 가리키는 얼굴이에요.')), field('프로필 사진', ava.node), field('이름', nameIn), field('닉네임 (활동 로그 등에 표시)', nickIn), data.email ? field('이메일 (로그인 아이디 · 변경은 관리자)', el('div', { class: 'admin-ro', text: data.email })) : null, data.email ? field('비밀번호', el('div', { style: 'display:flex; align-items:center; gap:10px; flex-wrap:wrap;' }, el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '비밀번호 변경', onclick: () => changePasswordModal() }), el('span', { class: 'admin-hint', style: 'margin:0' }, ...uiText('현재 비밀번호를 확인한 뒤 새 비밀번호로 바꿔요.')))) : null, logins && logins.oidcAvailable ? field('회사 계정 로그인', companyLoginRow(logins)) : null, field('화면 테마', themePrefRow()), el('div', { class: 'admin-actions' }, saveBtn, status));
}
// 회사 계정(외부 IdP) 연결 — 붙이면 그 계정 버튼 한 번으로 들어오고, 떼면 비밀번호로만 들어온다(#1520 A).
//  '연결'은 IdP 왕복이 필요해 페이지 이동으로 시작하고, '해제'는 그 자리에서 끝난다.
function companyLoginRow(logins) {
    const row = el('div', { style: 'display:flex; align-items:center; gap:10px; flex-wrap:wrap;' });
    const label = String(logins.oidcLabel || '회사 계정');
    const render = (st) => {
        const kids = [];
        if (st.linked) {
            kids.push(el('span', { class: 'admin-ro', text: st.email || '연결됨' }));
            const off = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '연결 해제' });
            off.addEventListener('click', async () => {
                off.disabled = true;
                try {
                    await api('/api/ui/me/oidc/unlink', { method: 'POST' });
                    toast('연결을 해제했습니다.');
                    render({ ...st, linked: false, email: null });
                }
                catch (e) {
                    toast((e && e.message) || '해제하지 못했습니다', true);
                    off.disabled = false;
                }
            });
            kids.push(off);
            // 비밀번호가 없으면 해제 자체가 막힌다(로그인 수단이 0이 된다) — 누르기 전에 이유를 알려준다.
            kids.push(el('span', { class: 'admin-hint', style: 'margin:0' }, ...uiText(st.hasPassword
                ? '해제하면 이메일·비밀번호로만 로그인해요.'
                : '해제하려면 먼저 비밀번호를 설정하세요 — 지금 해제하면 로그인할 수단이 없어져요.')));
        }
        else {
            const on = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: label + ' 연결' });
            on.addEventListener('click', () => {
                location.href = apiUrl('/api/ui/auth/oidc/start') + '?link=1&to=' + encodeURIComponent('/ui/' + (location.hash || ''));
            });
            kids.push(on, el('span', { class: 'admin-hint', style: 'margin:0' }, ...uiText('연결하면 다음부터 버튼 한 번으로 로그인해요. 이메일이 달라도 괜찮아요.')));
        }
        row.replaceChildren(...kids);
    };
    render(logins);
    return row;
}
export { PROF_DEV, PROF_LANG, PROF_TONE, applyMyProfileSaved, avatarEditor, changePasswordModal, parseMyProfile, profChips, };
// ── 화면 테마(#1683) — 클래식·v2 어디서 열어도 같은 자리에서 고른다. ─────────────
//  상단바 버튼(클래식)·사이드바 세그먼트(v2)는 빠른 전환이고, 여기는 **'AI 세션도 이 테마로'를 끄고 켜는 곳**이다.
//  값은 이 브라우저에 남는다(사람마다·기기마다 다를 수 있는 취향이라 서버에 올리지 않는다).
function themePrefRow() {
    const wrap = el('div', { style: 'display:flex; flex-direction:column; gap:8px;' });
    const seg = el('div', { style: 'display:flex; gap:6px; flex-wrap:wrap;' });
    const lab = { system: '시스템 설정을 따릅니다', light: '라이트', dark: '다크' };
    const paint = () => {
        const cur = themePref();
        seg.replaceChildren(...THEME_ORDER.map((k) => el('button', {
            type: 'button', class: 'btn btn-sm ' + (cur === k ? 'btn-primary' : 'btn-ghost'), text: lab[k],
            'aria-pressed': String(cur === k),
            onclick: () => { setThemePref(k); paint(); }
        })));
    };
    paint();
    const cb = el('input', { type: 'checkbox', style: 'margin:0', ...(harnessThemeSync() ? { checked: '' } : {}),
        onchange: (e) => setHarnessThemeSync(!!e.target.checked) });
    // 열린 탭 일괄 적용(#1683 후속2) — 클래식 셸엔 탭이 없어 **설정만 여기서** 하고, 실제 밀기는 새 셸이 한다.
    //  값을 브라우저에 함께 두므로 어느 화면에서 켜도 다른 화면이 그 뜻을 따른다.
    const tabsCb = el('input', { type: 'checkbox', style: 'margin:0', ...(applyToOpenTabs() ? { checked: '' } : {}),
        onchange: (e) => setApplyToOpenTabs(!!e.target.checked) });
    wrap.append(seg, el('label', { style: 'display:flex; align-items:center; gap:8px; cursor:pointer;' }, cb, el('span', { style: 'font-size:13px' }, ...uiText('새로 여는 AI 세션도 이 테마로 띄웁니다.'))), el('label', { style: 'display:flex; align-items:center; gap:8px; cursor:pointer;' }, tabsCb, el('span', { style: 'font-size:13px' }, ...uiText('현재 열린 탭도 모두 함께 바꿉니다.'))), el('p', { class: 'admin-hint', style: 'margin:0' }, ...uiText('첫째 칸을 끄면 각 AI 하네스가 저장해 둔 테마를 그대로 씁니다. 둘째 칸을 켜면 지금 열려 있는 세션 탭의 하네스까지 그 자리에서 바꿉니다 — 하네스마다 지원 여부가 달라, 바꾼 개수와 못 바꾼 이유를 알려드려요.')));
    return wrap;
}

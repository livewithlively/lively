// v2/me-modal.ts — 좌하단 [나] 행이 여는 **내 프로필 · 환경설정** 창(#1843, 원준 2026-08-21).
//
//  왜 모달인가: 개인 설정은 '보는 것'이 아니라 **잠깐 들렀다 나오는 것**이다. 지금 보던 화면(세션·프로젝트)을
//   탭으로 밀어내고 관리탭까지 다녀오게 하면, 프사 한 장 바꾸려고 작업 맥락을 잃는다. 슬랙·노션·리니어가 전부
//   프로필/환경설정을 오버레이로 두는 이유가 이것이고, 우리 발치의 [나] 행도 같은 문법을 따른다.
//
//  구조(슬랙 환경설정 문법): [좌 목록 | 우 내용] 2단. 왼쪽은 **주제**(프로필 · AI 개인 규칙 · 내 AI 계정 ·
//   외부 서비스 · 화면 · 계정)이고, 오른쪽만 갈아 끼운다. 발치에는 로그아웃 — 슬랙과 같은 자리다
//   (계정을 떠나는 일은 목록 맨 아래).
//
//  ── #1898 — 내보내던 링크를 창 안으로 ────────────────────────────────────────────────
//  [내 AI 계정]·[외부 서비스]는 종전에 이 창이 관리탭으로 **내보내던 링크**였다([계정 · 보안 ▸ 더 자세한
//   설정]). 개인 설정을 보러 들어와서 다른 앱으로 튕겨 나가면 그건 창을 닫는 것과 같다 — 그래서 두 화면을
//   이 창으로 들였다. **새로 만들지 않는다**: 관리탭이 쓰던 바로 그 부품(myAiAccountsCard · renderServices)을
//   그대로 부른다. 부품 소유는 저쪽에 두고 여기선 자리만 내준다 — 두 벌이 되면 한쪽만 고쳐진다.
//   관리탭 쪽 입구는 새 셸에서 감춘다(admin-shell sectionHidden) — 클래식엔 이 창이 없어 그쪽엔 남긴다.
//
//  ⚠ 저장 규약: 서버(POST /api/ui/me/profile)는 **미전송 필드를 보존**하는 patch 다. 그래서 [프로필]은
//   body_md 를 안 보내고 [AI 개인 규칙]은 이름·아바타를 안 보낸다 — 한 창에 둘이 같이 있어도 서로를 지우지 않는다.
//  ⚠ 칸에 적던 것이 탭을 옮기면 사라지면 안 된다 → 화면을 **한 번 만들어 두고 보이기만 토글**한다(다시 짓지 않는다).
//  ⚠ 단 서버를 더 부르는 두 화면([내 AI 계정]·[외부 서비스])은 **처음 펼 때** 그린다 — 열 때마다 넷을 더
//   부르면(ai-accounts · sessions · credentials · oauth) 안 볼 수도 있는 화면 때문에 창이 늦게 뜨고,
//   그러면 '잠깐 들르는 창'이 아니게 된다.
import { api, el, errorNote, logout, profileAvatar, setUiModeOverride, state, sv, toast, uiText } from '../core.js';
import { field, skeleton } from '../ui-primitives.js';
import { PROF_DEV, PROF_LANG, PROF_TONE, applyMyProfileSaved, avatarEditor, changePasswordModal, companyLoginRow, parseMyProfile, profChips, } from '../me-profile.js';
import { THEME_ORDER, applyToOpenTabs, harnessThemeSync, pushThemeToOpenTabs, setApplyToOpenTabs, setHarnessThemeSync, setThemePref, themePref } from '../theme.js';
//  #1898 — 관리탭 두 화면의 본체를 그대로 부른다(소유는 그쪽 — 여기서 다시 만들지 않는다).
import { myAiAccountsCard } from '../me-ai.js';
import { autoPane } from './me-auto.js'; // #1898 [자동으로 하는 일] — 세션 주입 화면과 같은 행을 본다(사본 없음)
import { renderServices } from '../me-logins.js';
import { openGitCredentialManager } from '../admin-credentials.js';
// 좌 목록 — 순서가 곧 위계다. 나를 가리키는 것(프로필) → 내 AI 가 나를 대하는 법 → 내 AI 가 무엇으로 도나
//  (계정) → 내 AI 가 무엇에 닿나(외부 서비스) → 내가 보는 화면 → 내가 들어오는 법(계정 · 보안).
//  가운데 둘이 붙어 있는 이유: 둘 다 '내 AI 가 어디에 로그인해 있나' 다 — 하나가 막히면 다른 하나도 본다.
const SECS = [
    { key: 'profile', label: '프로필', icon: ['M12 12.2a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2', 'M4.6 20.2a7.4 7.4 0 0 1 14.8 0'] },
    { key: 'ai', label: 'AI 개인 규칙', icon: ['M12 3.4l1.9 5.7 5.7 1.9-5.7 1.9L12 18.6l-1.9-5.7-5.7-1.9 5.7-1.9z', 'M18.5 16.5l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7z'] },
    // 시계 — 이 화면은 '언제 무슨 일이 자동으로 일어나나'를 다룬다(#1898). 규칙(위)이 '무엇을'이면 이건 '언제'.
    { key: 'auto', label: '자동 주입문', icon: ['M12 4.6a7.4 7.4 0 1 0 0 14.8 7.4 7.4 0 0 0 0-14.8', 'M12 8.2V12l2.6 1.6'] },
    // 열쇠 — 이 화면이 하는 일은 '로그인' 하나다(상태 확인 + 다시 로그인). 아래 방패(계정 · 보안)와 겹치지 않는 붓.
    { key: 'aiacct', label: '내 AI 계정', icon: ['M16 4.9a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2', 'M13.5 11 5 19.5', 'M7 17.5l2 2', 'M9.5 15l2 2'] },
    // 맞물린 고리 — 사이드바 [외부 앱 연결]과 **같은 글리프**(side.ts glyph 'link'). 같은 것을 가리키니 같은 그림이어야 한다.
    { key: 'svc', label: '외부 서비스', icon: ['M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.3 1.3', 'M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.3-1.3'] },
    { key: 'look', label: '화면', icon: ['M4 5.5h16v10H4z', 'M9 19.5h6', 'M12 15.5v4'] },
    { key: 'account', label: '계정 · 보안', icon: ['M12 3.4 19 6v5.6c0 4.2-2.9 7.4-7 9-4.1-1.6-7-4.8-7-9V6z', 'M9.3 12.1l1.9 1.9 3.5-3.6'] },
];
let openBack = null; // 열려 있는 창 — 두 번 눌러 두 장이 겹치지 않게
function ic(paths, cls) {
    return sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, ...paths.map((d) => sv('path', { d })));
}
/** 내 프로필 · 환경설정 창을 연다. 이미 열려 있으면 그 창을 그대로 둔다. */
export function openMeModal(opts = {}) {
    if (openBack)
        return;
    let cur = opts.tab || 'profile';
    // 창을 닫으면 키보드 초점은 **부른 자리**로 돌아가야 한다(안 그러면 <body> 로 떨어져 Tab 이 화면 맨 앞부터 다시 돈다).
    const opener = document.activeElement;
    const back = el('div', { class: 'v2me-back' });
    const panel = el('section', { class: 'v2me', role: 'dialog', 'aria-modal': 'true', 'aria-label': '내 프로필 · 환경설정' });
    const close = () => {
        if (!openBack)
            return;
        openBack = null;
        back.remove();
        document.removeEventListener('keydown', onKey, true);
        if (opener && document.contains(opener))
            opener.focus();
    };
    // Esc = 닫기. 단 안쪽에 또 창이 떠 있으면(비밀번호 변경 등) 그쪽이 먼저 먹는다 — capture 를 쓰되 그 창이
    //  document.body 마지막 자식일 때는 넘긴다(중첩 모달은 자기 리스너로 스스로 닫는다).
    const onKey = (e) => {
        if (e.key !== 'Escape')
            return;
        if (document.body.lastElementChild !== back)
            return;
        e.stopPropagation();
        close();
    };
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', (e) => { if (e.target === back)
        close(); });
    // ── 머리 — 지금 누구로 있나(얼굴·이름·이메일). 저장하면 여기부터 바뀐다(바뀐 게 눈에 보여야 저장된 줄 안다). ──
    const headAva = el('span', { class: 'v2me-h-ava' });
    const headName = el('div', { class: 'v2me-h-name' });
    const headSub = el('div', { class: 'v2me-h-sub' });
    const paintHead = () => {
        const m = state.me || {};
        const nm = String(m.display_name || m.email || m.userId || '');
        headAva.replaceChildren(profileAvatar(m.avatar || null, nm, m.userId, 'v2me-ava', { char: m.avatar_char, color: m.avatar_color }));
        headName.textContent = nm;
        headSub.textContent = String(m.email || m.userId || '');
    };
    paintHead();
    const head = el('header', { class: 'v2me-h' }, headAva, el('div', { class: 'v2me-h-txt' }, headName, headSub), el('button', { class: 'v2me-x', type: 'button', 'aria-label': '닫기', title: '닫기 (Esc)', onclick: close }, ic(['M6 6l12 12', 'M18 6 6 18'], 'v2me-x-ic')));
    // ── 좌 목록 · 우 내용 ──
    const navEl = el('nav', { class: 'v2me-nav', 'aria-label': '설정 항목' });
    const contEl = el('div', { class: 'v2me-cont' }, skeleton('내 설정을 불러오는 중'));
    const navBtns = new Map();
    const panes = new Map();
    // 처음 펼 때 한 번만 그리는 화면 — 서버를 더 부르는 것만 담긴다(위 ⚠ 참고).
    const lazy = new Map();
    const show = (k) => {
        cur = k;
        navBtns.forEach((b, key) => { b.classList.toggle('on', key === k); b.setAttribute('aria-current', String(key === k)); });
        panes.forEach((p, key) => { p.hidden = key !== k; });
        const first = lazy.get(k);
        // 표에서 **먼저 지우고** 부른다 — 그리는 동안 같은 항목을 다시 눌러도 두 번 그리지 않는다.
        if (first) {
            lazy.delete(k);
            first();
        }
        contEl.scrollTop = 0;
    };
    SECS.forEach((s) => {
        const b = el('button', { class: 'v2me-nav-b', type: 'button', onclick: () => show(s.key) }, ic(s.icon, 'v2me-nav-ic'), el('span', { text: s.label }));
        navBtns.set(s.key, b);
        navEl.append(b);
    });
    navEl.append(el('div', { class: 'v2me-nav-sp' }), el('button', { class: 'v2me-nav-b v2me-nav-out', type: 'button', onclick: () => { close(); void logout(); } }, ic(['M14.5 8V5.5a1.5 1.5 0 0 0-1.5-1.5H6a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 6 20h7a1.5 1.5 0 0 0 1.5-1.5V16', 'M10 12h10', 'M17.2 9.2 20 12l-2.8 2.8'], 'v2me-nav-ic'), el('span', { text: '로그아웃' })));
    panel.append(head, el('div', { class: 'v2me-body' }, navEl, contEl));
    back.append(panel);
    document.body.append(back);
    openBack = back;
    // 초점을 창 안으로 — 첫 항목(프로필)에 둔다. 키보드만 쓰는 사람이 Tab 한 번에 목록을 훑을 수 있는 자리다.
    navBtns.get(cur)?.focus();
    // ── 데이터 한 번 — [프로필]과 [AI 개인 규칙]이 같은 레코드를 나눠 쓴다(GET /api/ui/me/profile). ──
    void (async () => {
        let data;
        try {
            data = await api('/api/ui/me/profile');
        }
        catch (e) {
            contEl.replaceChildren(errorNote(e, '내 설정을 불러오지 못했습니다'));
            return;
        }
        // 로그인 수단(#1520)은 있으면 [계정]에 얹고, 없으면(OIDC 미설정 배포) 그 칸만 안 그린다 — 나머지는 그대로 쓴다.
        let logins = null;
        try {
            logins = await api('/api/ui/me/logins');
        }
        catch (_) { /* 부가 정보 — 조용히 넘어간다 */ }
        // 리브가 온보딩에서 알게 된 것(#1843). 실패해도 [AI 개인 규칙]은 종전대로 열린다 — 그 칸만 안 그린다.
        let liv = null;
        try {
            liv = await api('/api/ui/me/liv-profile');
        }
        catch (_) { /* 옛 서버·조회 실패 — 칸을 접는다 */ }
        const saved = () => { paintHead(); opts.onSaved?.(); };
        panes.set('profile', profilePane(data, saved));
        panes.set('ai', aiPane(data, liv));
        const auto = autoPane({ close, pane });
        panes.set('auto', auto.node);
        lazy.set('auto', auto.init);
        const acct = aiAccountPane();
        panes.set('aiacct', acct.node);
        lazy.set('aiacct', acct.init);
        const svc = servicesPane();
        panes.set('svc', svc.node);
        lazy.set('svc', svc.init);
        panes.set('look', lookPane(close));
        panes.set('account', accountPane(data, logins, close));
        contEl.replaceChildren(...panes.values());
        show(cur);
    })();
}
// 화면 하나 = [제목 · 한 줄 설명 · 내용] — 관리탭 섹션과 같은 규격.
function pane(title, hint, ...kids) {
    return el('div', { class: 'v2me-pane', hidden: true }, el('h3', { class: 'v2me-t', text: title }), el('p', { class: 'v2me-hint' }, ...uiText(hint)), ...kids);
}
function saveRow(btn, status) {
    return el('div', { class: 'v2me-save' }, btn, status);
}
// 이 창에서 관리탭 안쪽 화면으로 건너가는 줄 — 여기서 다 하지 않고 **어디로 가면 되는지**만 말한다.
function moreLink(href, label, desc, close) {
    return el('a', { class: 'v2me-more', href, onclick: () => close() }, el('span', { class: 'v2me-more-t', text: label }), el('span', { class: 'v2me-more-d', text: desc }), ic(['M9 6l6 6-6 6'], 'v2me-more-ic'));
}
// ── ① 프로필 — 얼굴·이름. 팀 화면 어디에서나 나를 가리키는 것. ──
function profilePane(data, onSaved) {
    const nameIn = el('input', { type: 'text', value: data.display_name || '', placeholder: '이름 (비우면 이메일·아이디로 표시됩니다)' });
    const nickIn = el('input', { type: 'text', value: data.nickname || '', placeholder: '닉네임 (비우면 이름으로 표시됩니다)' });
    const ava = avatarEditor(data, nameIn);
    const status = el('span', { class: 'v2me-status' });
    const btn = el('button', { type: 'button', class: 'btn btn-primary', text: '저장' });
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        // body_md 는 안 보낸다 — 서버가 보존하므로 [AI 개인 규칙]이 지워지지 않는다.
        const payload = { display_name: nameIn.value.trim(), nickname: nickIn.value.trim(), ...ava.payload() };
        try {
            const res = await api('/api/ui/me/profile', { method: 'POST', body: JSON.stringify(payload) });
            applyMyProfileSaved(res, data.id);
            onSaved();
            toast('저장했습니다.');
            status.textContent = '저장했습니다.';
        }
        catch (e) {
            toast((e && e.message) || '저장하지 못했습니다.', true);
        }
        btn.disabled = false;
    });
    return pane('프로필', '이름과 사진은 프로젝트·작업 기록·팀 화면 어디에서나 나를 가리키는 얼굴입니다.', field('프로필 사진', ava.node), field('이름', nameIn), field('닉네임 (활동 기록 등에 표시됩니다)', nickIn), data.email ? field('이메일 (로그인 아이디 · 변경은 관리자가 합니다)', el('div', { class: 'admin-ro', text: data.email })) : null, saveRow(btn, status));
}
// ── 온보딩에서 알려주신 것(#1843) — 리브가 대화로 알게 된 것을 이 창이 되읽는다. ──
//
//  **버튼이 없는 것이 설계다**(원준 2026-08-21: "사람이 굳이 직접 저장을 누르지 않고 자연스럽게 그냥
//   반영되게"). 리브가 알아낸 것은 주입 시점에 개인 층으로 합쳐진다(publish.ts renderLivOnboarding) —
//   여기서 [추가 메모]로 옮겨 담게 하면 ⓐ 안 누른 사람에겐 안 가고 ⓑ 누른 순간 사본이 생겨 나중에
//   리브가 알아낸 것이 갱신돼도 그 사본만 낡는다. 그래서 이 칸은 **거울**이지 입력칸이 아니다.
//  그러니 문구도 '반영하세요'가 아니라 '이미 반영되고 있습니다'여야 한다 — 화면이 사실을 말해야 한다.
function onboardingCard(liv) {
    const work = (liv && liv.work) || null;
    const answers = (liv && Array.isArray(liv.answers) ? liv.answers : []);
    const rows = [];
    if (work && String(work.asis || '').trim())
        rows.push({ k: '지금 하는 일', v: String(work.asis).trim() });
    if (work && String(work.tobe || '').trim())
        rows.push({ k: '이렇게 하고 싶어요', v: String(work.tobe).trim() });
    answers.forEach((a) => {
        // 고른 값은 id 로 저장된다(선택지 라벨은 답한 순간 사라진다) — 있는 그대로 보여준다. 직접 적은 것은 뒤에 잇는다.
        const picked = [...(Array.isArray(a.choices) ? a.choices : []), ...(a.other ? [String(a.other)] : [])]
            .map((c) => String(c).trim()).filter(Boolean);
        if (!picked.length)
            return;
        rows.push({ k: String(a.question || a.key || '').trim() || String(a.key || ''), v: picked.join(' · ') });
    });
    const head = el('div', { class: 'v2me-ob-h' }, el('span', { class: 'v2me-ob-t', text: '온보딩에서 알려주신 것' }));
    const card = el('section', { class: 'v2me-ob' }, head);
    if (!rows.length) {
        card.append(el('p', { class: 'v2me-ob-d' }, ...uiText('아직 리브와 나눈 이야기가 없어요. 리브가 묻는 것에 답하면 하는 일·일하는 방식이 여기에 저절로 모이고, 그대로 내 AI 세션에 실립니다.')), el('a', { class: 'btn btn-ghost btn-sm', href: '#/liv', text: '리브와 이야기하기' }));
        return card;
    }
    head.append(el('span', { class: 'pill pill-ok', text: '반영 중' }));
    card.append(el('p', { class: 'v2me-ob-d' }, ...uiText('리브와 이야기하며 알려주신 내용이에요. 따로 저장하지 않아도 내 AI 가 매 세션 시작할 때 아래 항목들과 함께 읽습니다. 고치려면 리브에게 말씀하세요.')), el('dl', { class: 'v2me-ob-l' }, ...rows.map((r) => el('div', { class: 'v2me-ob-r' }, el('dt', { text: r.k }), el('dd', { text: r.v })))));
    return card;
}
// ── ② AI 개인 규칙 — 내 AI 가 매 세션 시작에 읽는 개인 레이어(org_member.body_md). ──
//  선택지·직렬화·복원은 me-profile.ts 소유를 그대로 쓴다(PROF_* · profChips · parseMyProfile) —
//  규약이 두 벌이 되면 관리탭 [내 AI 설정]과 이 창의 저장이 서로를 지운다.
function aiPane(data, liv) {
    const pr = parseMyProfile(data.body_md || '');
    const roleIn = el('input', { type: 'text', value: pr.role, placeholder: '예: 라이블리 공동대표 / 백엔드 개발 / 디자이너' });
    const addressIn = el('input', { type: 'text', value: pr.address, placeholder: '예: 원준님 / 대표님' });
    const memoTa = el('textarea', { class: 'admin-ta admin-ta-prose', rows: '5',
        placeholder: '내 AI 가 알아두면 좋은 규칙·선호·맥락을 자유롭게 적어주세요.\n예: 금액은 항상 원 단위로 / 보고는 결론부터 / 화요일 오전엔 회의라 답이 늦어요' });
    memoTa.value = pr.memo;
    const devSel = { v: pr.dev };
    const devHint = el('p', { class: 'prof-hint' });
    const renderDevHint = () => {
        const d = PROF_DEV.find((x) => x.v === devSel.v);
        devHint.textContent = d ? d.hint : '항목을 고르면 AI 가 그 수준에 맞춰 기술 설명의 자세한 정도를 조절합니다.';
    };
    const devChips = profChips(PROF_DEV, devSel, (o) => o.label, (o) => o.v, renderDevHint);
    renderDevHint();
    const toneSel = { v: pr.tone };
    const toneChips = profChips(PROF_TONE.map((t) => ({ v: t })), toneSel, (o) => o.v, (o) => o.v);
    const langSel = { v: pr.lang };
    const langCustom = el('input', { type: 'text', class: 'prof-chip-input', placeholder: '직접 입력 (예: Français)' });
    if (langSel.v && !PROF_LANG.includes(langSel.v))
        langCustom.value = langSel.v;
    const langChips = profChips(PROF_LANG.map((t) => ({ v: t })), langSel, (o) => o.v, (o) => o.v, () => { langCustom.value = ''; });
    langChips.append(langCustom);
    langCustom.addEventListener('input', () => { langSel.v = langCustom.value.trim(); langChips.repaint(); });
    const status = el('span', { class: 'v2me-status' });
    const btn = el('button', { type: 'button', class: 'btn btn-primary', text: '저장' });
    btn.addEventListener('click', async () => {
        // 선택·입력 → canonical markdown(AI 가 읽기 좋고 parseMyProfile 로 복원 가능). 빈 항목은 생략.
        const lines = [];
        if (roleIn.value.trim())
            lines.push('- 역할: ' + roleIn.value.trim());
        const d = PROF_DEV.find((x) => x.v === devSel.v);
        if (d)
            lines.push('- 개발 이해도: ' + d.label + ' — ' + d.hint);
        if (addressIn.value.trim())
            lines.push('- 호칭: ' + addressIn.value.trim());
        if (toneSel.v)
            lines.push('- 말투: ' + toneSel.v);
        if (langSel.v)
            lines.push('- 사용 언어: ' + langSel.v + ' — 되도록 이 언어로 답하고, 다른 언어는 쓰지 마세요');
        let body = lines.length ? ('## 내 프로필\n' + lines.join('\n') + '\n') : '';
        const memo = memoTa.value.trim();
        if (memo)
            body += (body ? '\n' : '') + '## 추가 메모\n' + memo + '\n';
        btn.disabled = true;
        // 이름·아바타는 안 보낸다 — 서버가 보존하므로 [프로필]이 지워지지 않는다.
        try {
            await api('/api/ui/me/profile', { method: 'POST', body: JSON.stringify({ body_md: body }) });
            toast('저장했습니다 — 다음 세션부터 내 AI 가 반영합니다.');
            status.textContent = '저장했습니다.';
        }
        catch (e) {
            toast((e && e.message) || '저장하지 못했습니다.', true);
        }
        btn.disabled = false;
    });
    return pane('AI 개인 규칙', '내 AI 가 나에 대해 무엇을 알고 일할지 정합니다. 나에게만 적용되고 팀에는 공유되지 않습니다.', onboardingCard(liv), el('div', { class: 'v2me-k', text: '내가 적는 것' }), field('역할', roleIn), field('개발 이해도', el('div', {}, devChips, devHint)), field('호칭 (AI 가 나를 부르는 말)', addressIn), field('말투', toneChips), field('사용 언어 (AI 가 답하는 언어)', el('div', {}, langChips, el('p', { class: 'prof-hint' }, ...uiText('고르거나 직접 적은 언어로 내 AI 가 답합니다. 비우면 조직 기본값(주로 한국어)을 따릅니다.')))), field('추가 메모', el('div', {}, memoTa, el('p', { class: 'prof-hint' }, ...uiText('비밀번호·API 키·개인키 같은 비밀값은 적지 마세요. 토큰으로 보이는 값이 들어 있으면 저장되지 않고 오류로 알려드립니다.')))), saveRow(btn, status));
}
// ── ③ 내 AI 계정 — 내 세션이 **무엇으로, 누구 계정으로** 도나(#1085 카드 그대로). ──
//  카드 본체는 me-ai.ts 소유다 — 로그인 세션을 여는 법(claude 는 그 하네스로, codex 는 셸 + device-auth)이
//  거기 적혀 있고, 그 규칙이 두 벌이 되면 한쪽이 낡는다. 여기선 자리와 문구만 준다.
function aiAccountPane() {
    const host = el('div');
    const node = pane('내 AI 계정', '내 AI 세션이 어떤 AI 로, 누구 계정으로 실행되는지 봅니다. 세션에서 로그인 오류가 나면 여기서 다시 로그인하세요.', host);
    node.classList.add('v2me-pane-wide'); // 계정 행은 [이름 · 배지 · 버튼] 한 줄이라 520px 에선 버튼이 접힌다
    return { node, init: () => host.replaceChildren(myAiAccountsCard()) };
}
// ── ④ 외부 서비스 — AI 가 **내 계정으로** 쓸 수 있는 앱. 관리탭 [외부 서비스 관리]의 본체 그대로. ──
//  ⚠ 사이드바 [외부 앱 연결](#/connect)은 같은 것을 전체 화면으로 편다(목록 ▸ 앱 상세 + 관리자 층).
//   둘은 같은 표·같은 판정(LOGIN_SERVICES · partition)에서 나오므로 내용이 어긋나지 않는다 — 여기는
//   '설정을 보러 들어온 김에 잇는' 자리이고, 저기는 '무엇을 시킬 수 있나'를 보러 가는 자리다.
function servicesPane() {
    const host = el('div', { class: 'admin-stack' });
    //  git 자격은 서비스 연결과 성격이 다르다(AI 가 남의 계정을 쓰는 게 아니라 **코드를 받아오는** 열쇠) —
    //  카드로 세우지 않고 발치 한 줄로 둔다. 여는 창(openGitCredentialManager)은 자격 금고 소유 그대로.
    const node = pane('외부 서비스', 'AI 가 내 계정으로 외부 서비스를 쓸 수 있게 연결하고, 연결한 뒤 어디까지 허용할지 정합니다. 나에게만 적용되고 팀에는 공유되지 않습니다.', host, el('div', { class: 'v2me-k', style: 'margin-top:20px', text: '코드 저장소' }), field('리포지토리 접근 (개발자용)', el('div', {}, el('div', { class: 'v2me-inline' }, el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'git 인증 관리', onclick: () => openGitCredentialManager('me') })), el('p', { class: 'prof-hint' }, ...uiText('코드 저장소(GitHub·GitLab)에서 클론·푸시할 때 쓰는 SSH 키·토큰입니다. 코드 작업을 하지 않으면 설정하지 않아도 됩니다.')))));
    node.classList.add('v2me-pane-wide');
    return { node, init: () => { void renderServices(host); } };
}
// ── ⑤ 화면 — 이 브라우저에서 내가 보는 모습. 서버에 저장되지 않는다(기기별 취향). ──
function lookPane(close) {
    const LAB = { system: '시스템', light: '라이트', dark: '다크' };
    const TIP = { system: '기기 설정을 따릅니다', light: '항상 밝은 화면으로 봅니다', dark: '항상 어두운 화면으로 봅니다' };
    // 세그먼트는 사이드바 발치에 있던 그 부품(.v2-theme)을 그대로 쓴다 — 자리만 옮겼지 다른 물건이 아니다.
    const seg = el('div', { class: 'v2-theme', role: 'group', 'aria-label': '테마' });
    const paintSeg = () => {
        const cur = themePref();
        seg.replaceChildren(...THEME_ORDER.map((k) => el('button', {
            class: 'v2-theme-opt' + (cur === k ? ' on' : ''), type: 'button', text: LAB[k], title: TIP[k],
            'aria-pressed': String(cur === k),
            onclick: () => { setThemePref(k); paintSeg(); void pushThemeIfOn(); }
        })));
    };
    paintSeg();
    const classicBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '클래식 화면으로 바꾸기',
        onclick: () => {
            close();
            setUiModeOverride('classic');
            location.replace(location.pathname + '#/dashboard');
            location.reload();
        } });
    // 지금 열려 있는 탭까지 그 자리에서 바꿀지(#1683 후속2). 기본 꺼짐 — 세션 입력창에 하네스의 테마 명령을
    //  넣는 일이라(사람이 쓰던 초안 뒤에 붙을 수 있다) 사람이 켜 둔 경우에만 한다.
    const tabsCb = el('input', { type: 'checkbox', style: 'margin:0',
        ...(applyToOpenTabs() ? { checked: '' } : {}),
        onchange: (e) => setApplyToOpenTabs(!!e.target.checked) });
    // 테마를 바꾼 직후 — 켜져 있으면 열린 세션 탭에 밀고 결과를 그대로 알린다(조용한 실패 금지).
    const pushThemeIfOn = async () => {
        if (!applyToOpenTabs())
            return;
        try {
            const { v2OpenSessionIds } = await import('./main.js');
            const ids = v2OpenSessionIds();
            if (!ids.length)
                return;
            const r = await pushThemeToOpenTabs(ids);
            toast([r.applied ? `${r.applied}개 탭을 바꿨어요` : '바꾼 탭이 없어요', ...r.notes].join(' · '));
        }
        catch (e) {
            toast((e && e.message) || '열린 탭에 적용하지 못했습니다', true);
        }
    };
    // 'AI 세션도 이 테마로'(#1683 후속) — 터미널 **안에서 도는 하네스**까지 맞출지. 기본 켜짐.
    //  화면(사이드바·터미널 칠)은 이 스위치와 무관하게 늘 위 테마를 따른다 — 스위치가 가리는 건 하네스 안쪽뿐이다.
    const aiCb = el('input', { type: 'checkbox', style: 'margin:0',
        ...(harnessThemeSync() ? { checked: '' } : {}),
        onchange: (e) => setHarnessThemeSync(!!e.target.checked) });
    return pane('화면', '이 브라우저에서 화면이 어떻게 보일지 정합니다. 기기마다 따로 기억되고 팀에는 영향이 없습니다.', field('테마', el('div', {}, seg, el('p', { class: 'prof-hint' }, ...uiText('시스템을 고르면 기기의 밝게·어둡게 설정을 그대로 따라갑니다.')))), field('AI 세션', el('div', {}, el('label', { style: 'display:flex; align-items:center; gap:8px; cursor:pointer;' }, aiCb, el('span', { style: 'font-size:13.5px' }, ...uiText('새로 여는 AI 세션도 이 테마로 띄웁니다.'))), el('label', { style: 'display:flex; align-items:center; gap:8px; cursor:pointer; margin-top:6px;' }, tabsCb, el('span', { style: 'font-size:13.5px' }, ...uiText('현재 열린 탭도 모두 함께 바꿉니다.'))), el('p', { class: 'prof-hint' }, ...uiText('첫째 칸을 끄면 AI 하네스가 저마다 저장해 둔 테마를 그대로 씁니다. 둘째 칸을 켜면 지금 열려 있는 세션 탭의 하네스까지 그 자리에서 바꿉니다 — 하네스마다 지원 여부가 달라, 바꾼 개수와 못 바꾼 이유를 알려드려요.')))), field('화면 모드', el('div', { class: 'v2me-inline' }, classicBtn, el('p', { class: 'prof-hint', style: 'margin:0' }, ...uiText('지금은 새 화면입니다. 옛 화면으로 바꿔도 이 브라우저에서만 적용되고, 설정 ▸ 화면 에서 언제든 돌아옵니다.')))));
}
// ── ⑥ 계정 · 보안 — 어떻게 들어오는가. 프로필(누구로 보이는가)과 축이 달라 따로 둔다. ──
function accountPane(data, logins, close) {
    const kids = [];
    if (data.email) {
        kids.push(field('비밀번호', el('div', { class: 'v2me-inline' }, el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '비밀번호 변경', onclick: () => changePasswordModal() }), el('p', { class: 'prof-hint', style: 'margin:0' }, ...uiText('현재 비밀번호를 확인한 뒤 새 비밀번호로 바꿉니다.')))));
    }
    if (logins && logins.oidcAvailable)
        kids.push(field('회사 계정 로그인', companyLoginRow(logins)));
    //  [내 AI 계정]·[외부 서비스]는 이 창의 화면이 됐다(#1898) — 더는 밖으로 내보내지 않는다.
    //  남은 한 줄([내 스킬 · 훅])은 목록·편집기가 큰 화면이라 이 창에 들이지 않았다.
    kids.push(el('div', { class: 'v2me-more-k', text: '더 자세한 설정' }), moreLink('#/system/me-assets', '내 스킬 · 훅', '내 AI 가 쓰는 스킬과 훅을 켜고 끕니다.', close));
    return pane('계정 · 보안', '내가 이 워크스페이스에 어떻게 들어오는지 정합니다.', ...kids);
}

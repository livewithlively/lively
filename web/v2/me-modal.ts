// v2/me-modal.ts — 좌하단 [나] 행이 여는 **내 프로필 · 환경설정** 창(#1843, 원준 2026-08-21).
//
//  왜 모달인가: 개인 설정은 '보는 것'이 아니라 **잠깐 들렀다 나오는 것**이다. 지금 보던 화면(세션·프로젝트)을
//   탭으로 밀어내고 관리탭까지 다녀오게 하면, 프사 한 장 바꾸려고 작업 맥락을 잃는다. 슬랙·노션·리니어가 전부
//   프로필/환경설정을 오버레이로 두는 이유가 이것이고, 우리 발치의 [나] 행도 같은 문법을 따른다.
//
//  구조(슬랙 환경설정 문법): [좌 목록 | 우 내용] 2단. 왼쪽은 **주제**(프로필 · AI 개인 규칙 · 내 AI 계정 ·
//   외부 서비스 · 화면 · 계정 · 고급 설정)이고, 오른쪽만 갈아 끼운다. 발치에는 로그아웃 — 슬랙과 같은 자리다
//   (계정을 떠나는 일은 목록 맨 아래).
//
//  ── #1898 — 내보내던 링크를 창 안으로 ────────────────────────────────────────────────
//  [내 AI 계정]·[외부 서비스]는 종전에 이 창이 관리탭으로 **내보내던 링크**였다([계정 · 보안 ▸ 더 자세한
//   설정]). 개인 설정을 보러 들어와서 다른 앱으로 튕겨 나가면 그건 창을 닫는 것과 같다 — 그래서 두 화면을
//   이 창으로 들였다. **새로 만들지 않는다**: 관리탭이 쓰던 바로 그 부품(myAiAccountsCard · renderServices)을
//   그대로 부른다. 부품 소유는 저쪽에 두고 여기선 자리만 내준다 — 두 벌이 되면 한쪽만 고쳐진다.
//   관리탭 쪽 입구는 새 셸에서 감춘다(admin-shell sectionHidden) — 클래식엔 이 창이 없어 그쪽엔 남긴다.
//
//  ── #2199 — 설정 화면의 문이 이 창으로 ────────────────────────────────────────────
//  런치패드의 [설정] 앱을 뺐다(apps.ts hidden). 조직 · AI 능력 · 데이터 연결 · 운영 화면으로 가는 문은 이제 이 창의
//   맨 끝 [고급 설정] 하나다 — 목차는 설정 화면의 정보구조(admin-shell adminDirectory)를 그대로 읽고, 고르면 창이
//   닫히며 그 화면이 가운데 액자로 뜬다. [계정 · 보안]에 있던 [내 스킬 · 훅] 링크도 그 목차로 옮겼다(문은 하나).
//
//  ⚠ 저장 규약: 서버(POST /api/ui/me/profile)는 **미전송 필드를 보존**하는 patch 다. 그래서 [프로필]은
//   body_md 를 안 보내고 [AI 개인 규칙]은 이름·아바타를 안 보낸다 — 한 창에 둘이 같이 있어도 서로를 지우지 않는다.
//  ⚠ 칸에 적던 것이 탭을 옮기면 사라지면 안 된다 → 화면을 **한 번 만들어 두고 보이기만 토글**한다(다시 짓지 않는다).
//  ⚠ 단 서버를 더 부르는 두 화면([내 AI 계정]·[외부 서비스])은 **처음 펼 때** 그린다 — 열 때마다 넷을 더
//   부르면(ai-accounts · sessions · credentials · oauth) 안 볼 수도 있는 화면 때문에 창이 늦게 뜨고,
//   그러면 '잠깐 들르는 창'이 아니게 된다.
import { api, el, errorNote, logout, personName, profileAvatar, setUiModeOverride, state, sv, toast, uiText } from '../core.js';
import { field, skeleton } from '../ui-primitives.js';
import {
  PROF_DEV, PROF_LANG, PROF_TONE, applyMyProfileSaved, avatarEditor, changePasswordModal, companyLoginRow, parseMyProfile, profChips,
} from '../me-profile.js';
import { THEME_ORDER, applyToOpenTabs, harnessThemeSync, pushThemeToOpenTabs, setApplyToOpenTabs, setHarnessThemeSync, setThemePref, themePref, type ThemePref } from '../theme.js';
//  #1898 — 관리탭 두 화면의 본체를 그대로 부른다(소유는 그쪽 — 여기서 다시 만들지 않는다).
import { myAiAccountsCard } from '../me-ai.js';
import { autoPane } from './me-auto.js';   // #1898 [자동으로 하는 일] — 세션 주입 화면과 같은 행을 본다(사본 없음)
import { renderServices } from '../me-logins.js';
import { openGitCredentialManager } from '../admin-credentials.js';
//  #2199 — [고급 설정]은 설정 화면의 정보구조(그룹 · 섹션 · 권한 숨김)를 **그쪽 표 그대로** 읽는다(사본 없음).
import { adminDirectory, type AdminDirGroup } from '../admin-shell.js';
import { loadAdmin } from '../admin-rerender.js';

export interface MeModalOpts {
  /** 저장으로 이름·프사가 바뀌었다 — 사이드바(와 부른 쪽)가 다시 그리도록. */
  onSaved?: () => void;
  /** 처음 펼 화면. 기본 '프로필'. */
  tab?: SecKey;
}

type SecKey = 'profile' | 'ai' | 'auto' | 'aiacct' | 'svc' | 'notify' | 'look' | 'account' | 'advanced';
interface Sec { key: SecKey; label: string; icon: string[] }

// 좌 목록 — 순서가 곧 위계다. 나를 가리키는 것(프로필) → 내 AI 가 나를 대하는 법(규칙) → 매 대화에
//  자동으로 들어가는 것(주입문) → 내 AI 가 무엇으로 도나(계정) → 무엇에 닿나(외부 서비스) →
//  나를 부르는 법(알림) → 내가 보는 화면 → 내가 들어오는 법(계정 · 보안) → 그 너머로 가는 문(고급 설정).
//  ⚠ 알림은 'AI 를 어떻게 세팅하나'가 아니라 **내가 무엇을 언제 받나**다. 그래서 AI 묶음(규칙·주입문·
//   계정·외부 서비스) 뒤, 화면 바로 앞에 둔다(원준 2026-08-26) — 앞에 끼면 AI 설정이 갈라져 읽힌다.
const SECS: Sec[] = [
  { key: 'profile', label: '프로필', icon: ['M12 12.2a4.1 4.1 0 1 0 0-8.2 4.1 4.1 0 0 0 0 8.2', 'M4.6 20.2a7.4 7.4 0 0 1 14.8 0'] },
  { key: 'ai', label: 'AI 개인 규칙', icon: ['M12 3.4l1.9 5.7 5.7 1.9-5.7 1.9L12 18.6l-1.9-5.7-5.7-1.9 5.7-1.9z', 'M18.5 16.5l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7z'] },
  // 종 — 나를 부르는 법(#1842). 규칙(위)이 'AI 가 나를 대하는 법'이면, 이건 'AI 가 나를 부르는 법'이다.
  // 시계 — 이 화면은 '언제 무슨 일이 자동으로 일어나나'를 다룬다(#1898). 규칙(위)이 '무엇을'이면 이건 '언제'.
  { key: 'auto', label: '자동 주입문', icon: ['M12 4.6a7.4 7.4 0 1 0 0 14.8 7.4 7.4 0 0 0 0-14.8', 'M12 8.2V12l2.6 1.6'] },
  // 열쇠 — 이 화면이 하는 일은 '로그인' 하나다(상태 확인 + 다시 로그인). 아래 방패(계정 · 보안)와 겹치지 않는 붓.
  { key: 'aiacct', label: '내 AI 계정', icon: ['M16 4.9a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2', 'M13.5 11 5 19.5', 'M7 17.5l2 2', 'M9.5 15l2 2'] },
  // 맞물린 고리 — 사이드바 [외부 앱 연결]과 **같은 글리프**(side.ts glyph 'link'). 같은 것을 가리키니 같은 그림이어야 한다.
  { key: 'svc', label: '외부 서비스', icon: ['M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.3 1.3', 'M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.3-1.3'] },
  { key: 'notify', label: '알림', icon: ['M12 4.2a5 5 0 0 0-5 5v3.1l-1.5 2.7h13L17 12.3V9.2a5 5 0 0 0-5-5z', 'M10.1 18a1.95 1.95 0 0 0 3.8 0'] },
  { key: 'look', label: '화면', icon: ['M4 5.5h16v10H4z', 'M9 19.5h6', 'M12 15.5v4'] },
  { key: 'account', label: '계정 · 보안', icon: ['M12 3.4 19 6v5.6c0 4.2-2.9 7.4-7 9-4.1-1.6-7-4.8-7-9V6z', 'M9.3 12.1l1.9 1.9 3.5-3.6'] },
  // 슬라이더 — 여기서 고치는 게 아니라 **더 깊은 자리로 가는 문**(#2199). 톱니는 [나] 행이 이미 쓰는 표식이라 겹치지 않게.
  //  맨 끝인 이유: 위 여덟은 '나'의 것이고 이건 그 너머(조직 · AI 능력 · 데이터 · 운영)다 — 슬랙 환경설정의 [고급] 자리.
  { key: 'advanced', label: '고급 설정', icon: ['M20.5 5h-6', 'M10.5 5h-7', 'M20.5 12h-8', 'M8.5 12h-5', 'M20.5 19h-4', 'M12.5 19h-9', 'M14.5 3v4', 'M8.5 10v4', 'M16.5 17v4'] },
];

let openBack: HTMLElement | null = null;   // 열려 있는 창 — 두 번 눌러 두 장이 겹치지 않게

function ic(paths: string[], cls: string): SVGElement {
  return sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, ...paths.map((d) => sv('path', { d })));
}

/** 내 프로필 · 환경설정 창을 연다. 이미 열려 있으면 그 창을 그대로 둔다. */
export function openMeModal(opts: MeModalOpts = {}): void {
  if (openBack) return;
  let cur: SecKey = opts.tab || 'profile';
  // 창을 닫으면 키보드 초점은 **부른 자리**로 돌아가야 한다(안 그러면 <body> 로 떨어져 Tab 이 화면 맨 앞부터 다시 돈다).
  const opener = document.activeElement as HTMLElement | null;

  const back = el('div', { class: 'v2me-back' });
  const panel = el('section', { class: 'v2me', role: 'dialog', 'aria-modal': 'true', 'aria-label': '내 프로필 · 환경설정' });
  const close = (): void => {
    if (!openBack) return;
    openBack = null;
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    if (opener && document.contains(opener)) opener.focus();
  };
  // Esc = 닫기. 단 안쪽에 또 창이 떠 있으면(비밀번호 변경 등) 그쪽이 먼저 먹는다 — capture 를 쓰되 그 창이
  //  document.body 마지막 자식일 때는 넘긴다(중첩 모달은 자기 리스너로 스스로 닫는다).
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    if (document.body.lastElementChild !== back) return;
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', (e: MouseEvent) => { if (e.target === back) close(); });

  // ── 머리 — 지금 누구로 있나(얼굴·이름·이메일). 저장하면 여기부터 바뀐다(바뀐 게 눈에 보여야 저장된 줄 안다). ──
  const headAva = el('span', { class: 'v2me-h-ava' });
  const headName = el('div', { class: 'v2me-h-name' });
  const headSub = el('div', { class: 'v2me-h-sub' });
  const paintHead = (): void => {
    const m: any = state.me || {};
    const nm = personName(m);   // 이름 판정은 한 곳(#1813)
    headAva.replaceChildren(profileAvatar(m.avatar || null, nm, m.userId, 'v2me-ava', { char: m.avatar_char, color: m.avatar_color }));
    headName.textContent = nm;
    headSub.textContent = String(m.email || m.userId || '');
  };
  paintHead();
  const head = el('header', { class: 'v2me-h' }, headAva,
    el('div', { class: 'v2me-h-txt' }, headName, headSub),
    el('button', { class: 'v2me-x', type: 'button', 'aria-label': '닫기', title: '닫기 (Esc)', onclick: close },
      ic(['M6 6l12 12', 'M18 6 6 18'], 'v2me-x-ic')));

  // ── 좌 목록 · 우 내용 ──
  const navEl = el('nav', { class: 'v2me-nav', 'aria-label': '설정 항목' });
  const contEl = el('div', { class: 'v2me-cont' }, skeleton('내 설정을 불러오는 중'));
  const navBtns = new Map<SecKey, HTMLElement>();
  const panes = new Map<SecKey, HTMLElement>();
  // 처음 펼 때 한 번만 그리는 화면 — 서버를 더 부르는 것만 담긴다(위 ⚠ 참고).
  const lazy = new Map<SecKey, () => void>();
  const show = (k: SecKey): void => {
    cur = k;
    navBtns.forEach((b, key) => { b.classList.toggle('on', key === k); b.setAttribute('aria-current', String(key === k)); });
    panes.forEach((p, key) => { p.hidden = key !== k; });
    const first = lazy.get(k);
    // 표에서 **먼저 지우고** 부른다 — 그리는 동안 같은 항목을 다시 눌러도 두 번 그리지 않는다.
    if (first) { lazy.delete(k); first(); }
    contEl.scrollTop = 0;
  };
  SECS.forEach((s) => {
    const b = el('button', { class: 'v2me-nav-b', type: 'button', onclick: () => show(s.key) },
      ic(s.icon, 'v2me-nav-ic'), el('span', { text: s.label }));
    navBtns.set(s.key, b);
    navEl.append(b);
  });
  navEl.append(el('div', { class: 'v2me-nav-sp' }),
    el('button', { class: 'v2me-nav-b v2me-nav-out', type: 'button', onclick: () => { close(); void logout(); } },
      ic(['M14.5 8V5.5a1.5 1.5 0 0 0-1.5-1.5H6a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 6 20h7a1.5 1.5 0 0 0 1.5-1.5V16', 'M10 12h10', 'M17.2 9.2 20 12l-2.8 2.8'], 'v2me-nav-ic'),
      el('span', { text: '로그아웃' })));

  panel.append(head, el('div', { class: 'v2me-body' }, navEl, contEl));
  back.append(panel);
  document.body.append(back);
  openBack = back;
  // 초점을 창 안으로 — 첫 항목(프로필)에 둔다. 키보드만 쓰는 사람이 Tab 한 번에 목록을 훑을 수 있는 자리다.
  navBtns.get(cur)?.focus();

  // ── 데이터 한 번 — [프로필]과 [AI 개인 규칙]이 같은 레코드를 나눠 쓴다(GET /api/ui/me/profile). ──
  void (async () => {
    let data: any;
    try { data = await api('/api/ui/me/profile'); }
    catch (e) { contEl.replaceChildren(errorNote(e, '내 설정을 불러오지 못했습니다')); return; }
    // 로그인 수단(#1520)은 있으면 [계정]에 얹고, 없으면(OIDC 미설정 배포) 그 칸만 안 그린다 — 나머지는 그대로 쓴다.
    let logins: any = null;
    try { logins = await api('/api/ui/me/logins'); } catch (_) { /* 부가 정보 — 조용히 넘어간다 */ }
    // 리브가 온보딩에서 알게 된 것(#1843). 실패해도 [AI 개인 규칙]은 종전대로 열린다 — 그 칸만 안 그린다.
    let liv: any = null;
    try { liv = await api('/api/ui/me/liv-profile'); } catch (_) { /* 옛 서버·조회 실패 — 칸을 접는다 */ }

    const saved = (): void => { paintHead(); opts.onSaved?.(); };
    panes.set('profile', profilePane(data, saved));
    panes.set('ai', aiPane(data, liv));
    const auto = autoPane({ close, pane });  panes.set('auto', auto.node); lazy.set('auto', auto.init);
    const acct = aiAccountPane();  panes.set('aiacct', acct.node); lazy.set('aiacct', acct.init);
    const svc = servicesPane();    panes.set('svc', svc.node);     lazy.set('svc', svc.init);
    panes.set('notify', notifyPane());
    panes.set('look', lookPane(close));
    panes.set('account', accountPane(data, logins));
    const adv = advancedPane(close); panes.set('advanced', adv.node); lazy.set('advanced', adv.init);   // #2199 — 권한 데이터를 더 부르므로 처음 펼 때
    contEl.replaceChildren(...panes.values());
    show(cur);
  })();
}

// 화면 하나 = [제목 · 한 줄 설명 · 내용] — 관리탭 섹션과 같은 규격.
function pane(title: string, hint: string, ...kids: any[]): HTMLElement {
  return el('div', { class: 'v2me-pane', hidden: true },
    el('h3', { class: 'v2me-t', text: title }),
    el('p', { class: 'v2me-hint' }, ...uiText(hint)),
    ...kids);
}
function saveRow(btn: HTMLElement, status: HTMLElement): HTMLElement {
  return el('div', { class: 'v2me-save' }, btn, status);
}
// 이 창에서 관리탭 안쪽 화면으로 건너가는 줄 — 여기서 다 하지 않고 **어디로 가면 되는지**만 말한다.
function moreLink(href: string, label: string, desc: string, close: () => void, opts?: { gated?: boolean }): HTMLElement {
  return el('a', { class: 'v2me-more', href, onclick: () => close() },
    el('span', { class: 'v2me-more-t', text: label }),
    // 권한 배지(#2199) — 설정 화면 사이드바의 '관리자' 배지와 같은 판정 · 같은 문구(admin-shell navPermBadge). 내부 scope 이름은 안 쓴다.
    opts && opts.gated ? el('span', { class: 'v2me-more-badge', text: '관리자', title: '관리 권한이 있어야 보고 편집할 수 있는 항목입니다.' }) : null,
    el('span', { class: 'v2me-more-d', text: desc }),
    ic(['M9 6l6 6-6 6'], 'v2me-more-ic'));
}

// ── ① 프로필 — 얼굴·이름. 팀 화면 어디에서나 나를 가리키는 것. ──
function profilePane(data: any, onSaved: () => void): HTMLElement {
  const nameIn = el('input', { type: 'text', value: data.display_name || '', placeholder: '이름 (비우면 이메일·아이디로 표시됩니다)' });
  const nickIn = el('input', { type: 'text', value: data.nickname || '', placeholder: '닉네임 (예: 원준)' });
  // 「이 닉네임을 내 이름으로 사용」(#1813) — 켜면 사람 이름을 보이는 자리 **전부**에서 닉네임이 이름을 대체한다.
  //  닉네임이 비어 있으면 켤 수 없다(켜 둔 채 닉네임을 지우면 이름이 사라진 것처럼 보인다 — 서버도 같은 규칙으로 끈다).
  const useNick = el('input', { type: 'checkbox' }) as HTMLInputElement;
  useNick.checked = data.use_nickname === true;
  const useNickRow = el('label', { class: 'v2me-check' }, useNick,
    el('span', { text: '이 닉네임을 내 이름으로 사용' }),
    el('span', { class: 'v2me-check-d', text: '켜면 사이드바·작업 기록 등 이름이 나오는 곳에 닉네임이 표시됩니다.' }));
  const syncUseNick = () => {
    const has = !!String((nickIn as any).value || '').trim();
    useNick.disabled = !has;
    if (!has) useNick.checked = false;
    useNickRow.classList.toggle('off', !has);
  };
  nickIn.addEventListener('input', syncUseNick);
  syncUseNick();
  const ava = avatarEditor(data, nameIn);
  const status = el('span', { class: 'v2me-status' });
  const btn = el('button', { type: 'button', class: 'btn btn-primary', text: '저장' });
  btn.addEventListener('click', async () => {
    (btn as any).disabled = true;
    // body_md 는 안 보낸다 — 서버가 보존하므로 [AI 개인 규칙]이 지워지지 않는다.
    const payload = { display_name: (nameIn as any).value.trim(), nickname: (nickIn as any).value.trim(),
      use_nickname: useNick.checked, ...ava.payload() };
    try {
      const res = await api('/api/ui/me/profile', { method: 'POST', body: JSON.stringify(payload) });
      applyMyProfileSaved(res, data.id);
      // 이름이 바뀌면 부른 쪽이 자기 화면을 다시 그린다 — 레일은 drawRail, 사이드바는 redraw 를 이미 넘긴다.
      //  ⚠ 여기서 rail.js 를 직접 부르면 import 순환이 된다(rail → me-modal → rail). 방향은 한쪽으로만.
      onSaved();
      toast('저장했습니다.'); status.textContent = '저장했습니다.';
    } catch (e: any) { toast((e && e.message) || '저장하지 못했습니다.', true); }
    (btn as any).disabled = false;
  });
  return pane('프로필', '이름과 사진은 프로젝트·작업 기록·팀 화면 어디에서나 나를 가리키는 얼굴입니다.',
    field('프로필 사진', ava.node),
    field('이름', nameIn),
    field('닉네임', nickIn),
    useNickRow,
    data.email ? field('이메일 (로그인 아이디 · 변경은 관리자가 합니다)', el('div', { class: 'admin-ro', text: data.email })) : null,
    saveRow(btn, status));
}

// ── 온보딩에서 알려주신 것(#1843) — 리브가 대화로 알게 된 것을 이 창이 되읽는다. ──
//
//  **버튼이 없는 것이 설계다**(원준 2026-08-21: "사람이 굳이 직접 저장을 누르지 않고 자연스럽게 그냥
//   반영되게"). 리브가 알아낸 것은 주입 시점에 개인 층으로 합쳐진다(publish.ts renderLivOnboarding) —
//   여기서 [추가 메모]로 옮겨 담게 하면 ⓐ 안 누른 사람에겐 안 가고 ⓑ 누른 순간 사본이 생겨 나중에
//   리브가 알아낸 것이 갱신돼도 그 사본만 낡는다. 그래서 이 칸은 **거울**이지 입력칸이 아니다.
//  그러니 문구도 '반영하세요'가 아니라 '이미 반영되고 있습니다'여야 한다 — 화면이 사실을 말해야 한다.
function onboardingCard(liv: any): HTMLElement {
  const work = (liv && liv.work) || null;
  const answers: any[] = (liv && Array.isArray(liv.answers) ? liv.answers : []);
  const rows: Array<{ k: string; v: string }> = [];
  if (work && String(work.asis || '').trim()) rows.push({ k: '지금 하는 일', v: String(work.asis).trim() });
  if (work && String(work.tobe || '').trim()) rows.push({ k: '이렇게 하고 싶어요', v: String(work.tobe).trim() });
  answers.forEach((a) => {
    // 고른 값은 id 로 저장된다(선택지 라벨은 답한 순간 사라진다) — 있는 그대로 보여준다. 직접 적은 것은 뒤에 잇는다.
    const picked = [...(Array.isArray(a.choices) ? a.choices : []), ...(a.other ? [String(a.other)] : [])]
      .map((c: any) => String(c).trim()).filter(Boolean);
    if (!picked.length) return;
    rows.push({ k: String(a.question || a.key || '').trim() || String(a.key || ''), v: picked.join(' · ') });
  });

  const head = el('div', { class: 'v2me-ob-h' }, el('span', { class: 'v2me-ob-t', text: '온보딩에서 알려주신 것' }));
  const card = el('section', { class: 'v2me-ob' }, head);
  if (!rows.length) {
    card.append(
      el('p', { class: 'v2me-ob-d' }, ...uiText('아직 리브와 나눈 이야기가 없어요. 리브가 묻는 것에 답하면 하는 일·일하는 방식이 여기에 저절로 모이고, 그대로 내 AI 세션에 실립니다.')),
      el('a', { class: 'btn btn-ghost btn-sm', href: '#/liv', text: '리브와 이야기하기' }));
    return card;
  }

  head.append(el('span', { class: 'pill pill-ok', text: '반영 중' }));
  card.append(
    el('p', { class: 'v2me-ob-d' }, ...uiText('리브와 이야기하며 알려주신 내용이에요. 따로 저장하지 않아도 내 AI 가 매 세션 시작할 때 아래 항목들과 함께 읽습니다. 고치려면 리브에게 말씀하세요.')),
    el('dl', { class: 'v2me-ob-l' }, ...rows.map((r) => el('div', { class: 'v2me-ob-r' },
      el('dt', { text: r.k }), el('dd', { text: r.v })))));
  return card;
}

// ── ② AI 개인 규칙 — 내 AI 가 매 세션 시작에 읽는 개인 레이어(org_member.body_md). ──
//  선택지·직렬화·복원은 me-profile.ts 소유를 그대로 쓴다(PROF_* · profChips · parseMyProfile) —
//  규약이 두 벌이 되면 관리탭 [내 AI 설정]과 이 창의 저장이 서로를 지운다.
function aiPane(data: any, liv: any): HTMLElement {
  const pr = parseMyProfile(data.body_md || '');
  const roleIn = el('input', { type: 'text', value: pr.role, placeholder: '예: 라이블리 공동대표 / 백엔드 개발 / 디자이너' });
  const addressIn = el('input', { type: 'text', value: pr.address, placeholder: '예: 원준님 / 대표님' });
  const memoTa = el('textarea', { class: 'admin-ta admin-ta-prose', rows: '5',
    placeholder: '내 AI 가 알아두면 좋은 규칙·선호·맥락을 자유롭게 적어주세요.\n예: 금액은 항상 원 단위로 / 보고는 결론부터 / 화요일 오전엔 회의라 답이 늦어요' });
  (memoTa as any).value = pr.memo;

  const devSel = { v: pr.dev };
  const devHint = el('p', { class: 'prof-hint' });
  const renderDevHint = (): void => {
    const d = PROF_DEV.find((x) => x.v === devSel.v);
    devHint.textContent = d ? d.hint : '항목을 고르면 AI 가 그 수준에 맞춰 기술 설명의 자세한 정도를 조절합니다.';
  };
  const devChips = profChips(PROF_DEV, devSel, (o) => o.label, (o) => o.v, renderDevHint);
  renderDevHint();
  const toneSel = { v: pr.tone };
  const toneChips = profChips(PROF_TONE.map((t) => ({ v: t })), toneSel, (o) => o.v, (o) => o.v);
  const langSel = { v: pr.lang };
  const langCustom = el('input', { type: 'text', class: 'prof-chip-input', placeholder: '직접 입력 (예: Français)' });
  if (langSel.v && !PROF_LANG.includes(langSel.v)) (langCustom as any).value = langSel.v;
  const langChips = profChips(PROF_LANG.map((t) => ({ v: t })), langSel, (o) => o.v, (o) => o.v, () => { (langCustom as any).value = ''; });
  langChips.append(langCustom);
  langCustom.addEventListener('input', () => { langSel.v = (langCustom as any).value.trim(); (langChips as any).repaint(); });

  const status = el('span', { class: 'v2me-status' });
  const btn = el('button', { type: 'button', class: 'btn btn-primary', text: '저장' });
  btn.addEventListener('click', async () => {
    // 선택·입력 → canonical markdown(AI 가 읽기 좋고 parseMyProfile 로 복원 가능). 빈 항목은 생략.
    const lines: string[] = [];
    if ((roleIn as any).value.trim()) lines.push('- 역할: ' + (roleIn as any).value.trim());
    const d = PROF_DEV.find((x) => x.v === devSel.v);
    if (d) lines.push('- 개발 이해도: ' + d.label + ' — ' + d.hint);
    if ((addressIn as any).value.trim()) lines.push('- 호칭: ' + (addressIn as any).value.trim());
    if (toneSel.v) lines.push('- 말투: ' + toneSel.v);
    if (langSel.v) lines.push('- 사용 언어: ' + langSel.v + ' — 되도록 이 언어로 답하고, 다른 언어는 쓰지 마세요');
    let body = lines.length ? ('## 내 프로필\n' + lines.join('\n') + '\n') : '';
    const memo = (memoTa as any).value.trim();
    if (memo) body += (body ? '\n' : '') + '## 추가 메모\n' + memo + '\n';
    (btn as any).disabled = true;
    // 이름·아바타는 안 보낸다 — 서버가 보존하므로 [프로필]이 지워지지 않는다.
    try {
      await api('/api/ui/me/profile', { method: 'POST', body: JSON.stringify({ body_md: body }) });
      toast('저장했습니다 — 다음 세션부터 내 AI 가 반영합니다.'); status.textContent = '저장했습니다.';
    } catch (e: any) { toast((e && e.message) || '저장하지 못했습니다.', true); }
    (btn as any).disabled = false;
  });

  return pane('AI 개인 규칙', '내 AI 가 나에 대해 무엇을 알고 일할지 정합니다. 나에게만 적용되고 팀에는 공유되지 않습니다.',
    onboardingCard(liv),
    el('div', { class: 'v2me-k', text: '내가 적는 것' }),
    field('역할', roleIn),
    field('개발 이해도', el('div', {}, devChips, devHint)),
    field('호칭 (AI 가 나를 부르는 말)', addressIn),
    field('말투', toneChips),
    field('사용 언어 (AI 가 답하는 언어)', el('div', {}, langChips,
      el('p', { class: 'prof-hint' }, ...uiText('고르거나 직접 적은 언어로 내 AI 가 답합니다. 비우면 조직 기본값(주로 한국어)을 따릅니다.')))),
    field('추가 메모', el('div', {}, memoTa,
      el('p', { class: 'prof-hint' }, ...uiText('비밀번호·API 키·개인키 같은 비밀값은 적지 마세요. 토큰으로 보이는 값이 들어 있으면 저장되지 않고 오류로 알려드립니다.')))),
    saveRow(btn, status));
}

// ── ③ 내 AI 계정 — 내 세션이 **무엇으로, 누구 계정으로** 도나(#1085 카드 그대로). ──
//  카드 본체는 me-ai.ts 소유다 — 로그인 세션을 여는 법(claude 는 그 하네스로, codex 는 셸 + device-auth)이
//  거기 적혀 있고, 그 규칙이 두 벌이 되면 한쪽이 낡는다. 여기선 자리와 문구만 준다.
function aiAccountPane(): { node: HTMLElement; init: () => void } {
  const host = el('div');
  const node = pane('내 AI 계정',
    '내 AI 세션이 어떤 AI 로, 누구 계정으로 실행되는지 봅니다. 세션에서 로그인 오류가 나면 여기서 다시 로그인하세요.',
    host);
  node.classList.add('v2me-pane-wide');   // 계정 행은 [이름 · 배지 · 버튼] 한 줄이라 520px 에선 버튼이 접힌다
  return { node, init: () => host.replaceChildren(myAiAccountsCard()) };
}

// ── ④ 외부 서비스 — AI 가 **내 계정으로** 쓸 수 있는 앱. 관리탭 [외부 서비스 관리]의 본체 그대로. ──
//  ⚠ 사이드바 [외부 앱 연결](#/connect)은 같은 것을 전체 화면으로 편다(목록 ▸ 앱 상세 + 관리자 층).
//   둘은 같은 표·같은 판정(LOGIN_SERVICES · partition)에서 나오므로 내용이 어긋나지 않는다 — 여기는
//   '설정을 보러 들어온 김에 잇는' 자리이고, 저기는 '무엇을 시킬 수 있나'를 보러 가는 자리다.
function servicesPane(): { node: HTMLElement; init: () => void } {
  const host = el('div', { class: 'admin-stack' });
  //  git 자격은 서비스 연결과 성격이 다르다(AI 가 남의 계정을 쓰는 게 아니라 **코드를 받아오는** 열쇠) —
  //  카드로 세우지 않고 발치 한 줄로 둔다. 여는 창(openGitCredentialManager)은 자격 금고 소유 그대로.
  const node = pane('외부 서비스',
    'AI 가 내 계정으로 외부 서비스를 직접 쓸 수 있게 연결하고, 연결한 뒤 어디까지 허용할지 정합니다. 나에게만 적용됩니다 — 자료를 워크스페이스가 함께 보는 자료함으로 가져오는 것은 [외부 앱 연결]의 «자료 가져오기»가 따로 합니다.',
    host,
    el('div', { class: 'v2me-k', style: 'margin-top:20px', text: '코드 저장소' }),
    field('리포지토리 접근 (개발자용)', el('div', {},
      el('div', { class: 'v2me-inline' },
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'git 인증 관리', onclick: () => openGitCredentialManager('me') })),
      el('p', { class: 'prof-hint' }, ...uiText('코드 저장소(GitHub·GitLab)에서 클론·푸시할 때 쓰는 SSH 키·토큰입니다. 코드 작업을 하지 않으면 설정하지 않아도 됩니다.')))));
  node.classList.add('v2me-pane-wide');
  return { node, init: () => { void renderServices(host); } };
}

// ── ⑤ 화면 — 이 브라우저에서 내가 보는 모습. 서버에 저장되지 않는다(기기별 취향). ──
function lookPane(close: () => void): HTMLElement {
  const LAB: Record<ThemePref, string> = { system: '시스템', light: '라이트', dark: '다크' };
  const TIP: Record<ThemePref, string> = { system: '기기 설정을 따릅니다', light: '항상 밝은 화면으로 봅니다', dark: '항상 어두운 화면으로 봅니다' };
  // 세그먼트는 사이드바 발치에 있던 그 부품(.v2-theme)을 그대로 쓴다 — 자리만 옮겼지 다른 물건이 아니다.
  const seg = el('div', { class: 'v2-theme', role: 'group', 'aria-label': '테마' });
  const paintSeg = (): void => {
    const cur = themePref();
    seg.replaceChildren(...THEME_ORDER.map((k) => el('button', {
      class: 'v2-theme-opt' + (cur === k ? ' on' : ''), type: 'button', text: LAB[k], title: TIP[k],
      'aria-pressed': String(cur === k),
      onclick: () => { setThemePref(k); paintSeg(); void pushThemeIfOn(); } })));
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
    onchange: (e: any) => setApplyToOpenTabs(!!e.target.checked) }) as HTMLInputElement;

  // 테마를 바꾼 직후 — 켜져 있으면 열린 세션 탭에 밀고 결과를 그대로 알린다(조용한 실패 금지).
  const pushThemeIfOn = async (): Promise<void> => {
    if (!applyToOpenTabs()) return;
    try {
      const { v2OpenSessionIds } = await import('./main.js');
      const ids = v2OpenSessionIds();
      if (!ids.length) return;
      const r = await pushThemeToOpenTabs(ids);
      toast([r.applied ? `${r.applied}개 탭을 바꿨어요` : '바꾼 탭이 없어요', ...r.notes].join(' · '));
    } catch (e: any) { toast((e && e.message) || '열린 탭에 적용하지 못했습니다', true); }
  };

  // 'AI 세션도 이 테마로'(#1683 후속) — 터미널 **안에서 도는 하네스**까지 맞출지. 기본 켜짐.
  //  화면(사이드바·터미널 칠)은 이 스위치와 무관하게 늘 위 테마를 따른다 — 스위치가 가리는 건 하네스 안쪽뿐이다.
  const aiCb = el('input', { type: 'checkbox', style: 'margin:0',
    ...(harnessThemeSync() ? { checked: '' } : {}),
    onchange: (e: any) => setHarnessThemeSync(!!e.target.checked) }) as HTMLInputElement;

  return pane('화면', '이 브라우저에서 화면이 어떻게 보일지 정합니다. 기기마다 따로 기억되고 팀에는 영향이 없습니다.',
    field('테마', el('div', {}, seg,
      el('p', { class: 'prof-hint' }, ...uiText('시스템을 고르면 기기의 밝게·어둡게 설정을 그대로 따라갑니다.')))),
    field('AI 세션', el('div', {},
      el('label', { style: 'display:flex; align-items:center; gap:8px; cursor:pointer;' }, aiCb,
        el('span', { style: 'font-size:13.5px' }, ...uiText('새로 여는 AI 세션도 이 테마로 띄웁니다.'))),
      el('label', { style: 'display:flex; align-items:center; gap:8px; cursor:pointer; margin-top:6px;' }, tabsCb,
        el('span', { style: 'font-size:13.5px' }, ...uiText('현재 열린 탭도 모두 함께 바꿉니다.'))),
      el('p', { class: 'prof-hint' }, ...uiText('첫째 칸을 끄면 AI 하네스가 저마다 저장해 둔 테마를 그대로 씁니다. 둘째 칸을 켜면 지금 열려 있는 세션 탭의 하네스까지 그 자리에서 바꿉니다 — 하네스마다 지원 여부가 달라, 바꾼 개수와 못 바꾼 이유를 알려드려요.')))),
    field('화면 모드', el('div', { class: 'v2me-inline' }, classicBtn,
      el('p', { class: 'prof-hint', style: 'margin:0' }, ...uiText('지금은 새 화면입니다. 옛 화면으로 바꿔도 이 브라우저에서만 적용되고, 설정 ▸ 화면 에서 언제든 돌아옵니다.')))));
}

// ── ⑥ 계정 · 보안 — 어떻게 들어오는가. 프로필(누구로 보이는가)과 축이 달라 따로 둔다. ──
function accountPane(data: any, logins: any): HTMLElement {
  const kids: any[] = [];
  if (data.email) {
    kids.push(field('비밀번호', el('div', { class: 'v2me-inline' },
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '비밀번호 변경', onclick: () => changePasswordModal() }),
      el('p', { class: 'prof-hint', style: 'margin:0' }, ...uiText('현재 비밀번호를 확인한 뒤 새 비밀번호로 바꿉니다.')))));
  }
  if (logins && logins.oidcAvailable) kids.push(field('회사 계정 로그인', companyLoginRow(logins)));
  //  [내 AI 계정]·[외부 서비스]는 이 창의 화면이 됐다(#1898) — 더는 밖으로 내보내지 않는다.
  //  [내 스킬 · 훅]으로 건너가던 '더 자세한 설정' 줄도 뺐다(원준 지시 2026-08-27): 이 칸은
  //  '어떻게 들어오는가'인데 그 줄만 축이 달랐고, 관리탭에 같은 자리가 이미 있다.
  //  남아 있던 [내 스킬 · 훅] 링크는 [고급 설정] ▸ 내 설정으로 옮겼다(#2199) — 설정 화면으로 가는 문은 그 탭 하나다.

  // ── 회원 탈퇴(#1876) — **이 창 안에서 끝난다.**
  //  종전엔 app.lvly.io 로 새 탭을 띄웠는데, 로그인해서 쓰고 있는 사람이 탈퇴하려면 밖에서 다시
  //  로그인해야 하는 화면이 됐다 — 기능이 없는 것과 같다. 실행만 서버가 위임한다.
  //
  //  ⚠ 종전엔 `hub_url`(매니지드 표식)이 없으면 이 줄을 **아예 그리지 않았다.** 그건 틀렸다 —
  //   셀프호스트에도 탈퇴는 있어야 하고(거기선 '이 워크스페이스에서 내려오는 것'을 뜻한다),
  //   실측에서 "계정·보안에 탈퇴가 없는데?"로 그대로 드러났다. 무엇을 뜻하는지는 서버가 판정해
  //   미리보기(plan.mode)로 알려 주므로, 화면은 **항상 문을 연다**. 자기가 어떤 배포인지 화면이
  //   먼저 알아맞히려 들면 그 판단이 서버와 갈리는 순간 사람이 빈손이 된다.
  kids.push(el('div', { class: 'v2me-more-k', text: '계정 정리' }),
    el('button', {
      type: 'button', class: 'v2me-more', style: 'width:100%;text-align:left;background:none;border:0;cursor:pointer',
      onclick: () => accountDeleteModal(),
    },
      el('span', { class: 'v2me-more-t', text: '회원 탈퇴' }),
      el('span', { class: 'v2me-more-d', text: '더 이상 이곳에 들어오지 않습니다. 무엇이 지워지고 무엇이 남는지 먼저 보여 드립니다.' }),
      ic(['M9 6l6 6-6 6'], 'v2me-more-ic')));
  return pane('계정 · 보안', '내가 이 워크스페이스에 어떻게 들어오는지 정합니다.', ...kids);
}

// ── ③ 화면 — 이 브라우저에서 내가 보는 모습. 서버에 저장되지 않는다(기기별 취향). ──
// ── 알림(#1842) — 어떤 순간에 데스크톱 앱이 OS 배너를 띄울지. ──
//  ⚠ **기기가 아니라 사람 단위**다(서버 저장). 기기별로 두면 사무실 맥에서 끈 것이 노트북에선 그대로 떠
//   "껐는데 뜬다"가 된다. 그래서 끄고 켜는 자리도 여기 하나뿐이고, 앱은 이 값을 읽기만 한다.
//  ⚠ 스위치는 **누르는 순간 저장한다**(저장 버튼 없음). 스위치를 내린 것 자체가 결정이라, 한 번 더 누르게
//   하면 "껐는데 안 꺼졌다"가 난다. 텍스트를 고치는 [프로필]·[AI 개인 규칙]이 저장 버튼을 쓰는 것과 다른
//   이유이고, 그 구분은 일반적인 관례와 같다.
const NOTIFY_ROWS: Array<{ key: string; label: string; desc: string }> = [
  { key: 'session_waiting', label: 'AI 가 확인을 기다릴 때',
    desc: '승인이나 선택을 물어놓고 멈춰 있을 때 알려 줍니다. 놓치면 AI 가 그대로 서 있게 됩니다.' },
  { key: 'session_done', label: 'AI 가 작업을 마쳤을 때',
    desc: '맡겨 둔 작업이 끝나는 순간 알려 줍니다. 세션을 여러 개 동시에 돌릴 때 가장 자주 받게 됩니다.' },
  { key: 'person', label: '사람이 나를 부를 때',
    desc: '댓글에서 나를 언급하거나, 내가 참여한 일에 댓글이 달리면 알려 줍니다.' },
];

function notifyPane(): HTMLElement {
  const status = el('span', { class: 'v2me-status' });
  const list = el('div', { class: 'v2me-sw-list' }, skeleton('알림 설정을 불러오는 중'));
  const body = pane('알림',
    '라이블리 데스크톱 앱이 화면 밖에 띄우는 알림입니다. 여기서 정한 값은 **내가 쓰는 모든 컴퓨터에 함께** 적용됩니다.',
    list,
    el('p', { class: 'prof-hint', style: 'margin-top:14px' },
      ...uiText('알림은 데스크톱 앱이 띄웁니다 — 앱을 아직 안 쓰신다면 이 설정만으로는 알림이 오지 않습니다. 앱은 창을 닫아도 메뉴막대에 남아 있어, 라이블리를 보고 있지 않을 때도 알려 줍니다.')));

  const paint = (prefs: Record<string, boolean>): void => {
    list.replaceChildren(...NOTIFY_ROWS.map((r) => {
      const box = el('input', { type: 'checkbox', class: 'v2me-sw-in' }) as HTMLInputElement;
      box.checked = prefs[r.key] !== false;
      box.addEventListener('change', () => {
        const on = box.checked;
        box.disabled = true;
        status.textContent = '저장 중…';
        void api('/api/ui/me/notify-prefs', { method: 'POST', body: JSON.stringify({ [r.key]: on }) })
          .then(() => { status.textContent = on ? '켰습니다' : '껐습니다'; })
          .catch((e: any) => {
            box.checked = !on;                       // 서버가 못 받았으면 화면도 되돌린다(거짓 상태를 남기지 않는다)
            status.textContent = '';
            toast((e && e.message) || '저장하지 못했습니다', true);
          })
          .finally(() => { box.disabled = false; });
      });
      return el('label', { class: 'v2me-sw' }, box,
        el('span', { class: 'v2me-sw-txt' },
          el('span', { class: 'v2me-sw-l', text: r.label }),
          el('span', { class: 'v2me-sw-d' }, ...uiText(r.desc))));
    }), status);
  };

  void api('/api/ui/me/notify-prefs')
    .then((r: any) => paint((r && r.prefs) || {}))
    .catch((e) => list.replaceChildren(errorNote(e, '알림 설정을 불러오지 못했습니다')));
  return body;
}

// ── ⑨ 고급 설정(#2199) — 조직 전체에 걸친 설정·운영 화면으로 가는 **문**. ──
//  종전엔 런치패드의 [설정] 앱이 이 문이었다(원준 2026-08-27: "앱에 설정을 없애고 그 설정 창이 뜨는 걸 … 모달 사이드바에
//   고급설정 하나 만들어서 그걸 통해서 들어가는 과정"). 설정은 앱(할 일이 있는 화면)이 아니라 **환경을 손보는 자리**다 —
//   나에 관한 것은 이 창의 다른 탭이 맡고, 그 너머(조직 · AI 능력 · 데이터 연결 · 운영)는 이 탭이 가리킨다. 슬랙도
//   환경설정 창 맨 끝 [고급]에서 워크스페이스 설정으로 건너간다. 앱 목록에 [설정]이 남아 있으면 같은 문이 둘이라
//   어느 쪽이 진짜인지 화면이 말하지 못한다(apps.ts `hidden`).
//  목차는 **설정 화면의 정보구조 그대로**(admin-shell adminDirectory) — 그룹 · 순서 · 권한 숨김 · '관리자' 배지가 저쪽
//   사이드바와 같은 표 · 같은 판정에서 나온다. 여기서 목록을 따로 적으면 저쪽에 화면이 늘거나 권한이 바뀔 때 한쪽만
//   고쳐진다. 이 파일이 갖는 건 **한 줄 설명**뿐이다(저쪽 사이드바는 설명을 안 그린다). 표에 없는 키는 이름만 선다.
//  항목을 고르면 이 창이 닫히고 그 설정 화면이 가운데 액자로 뜬다(#/system/<key> — main.ts 클래식 분기, #1843 이
//   [내 스킬 · 훅] 링크로 이미 쓰던 길). 이 창은 '잠깐 들르는 창'이라 설정 화면을 여기 안 그린다 — 그 화면은 자기
//   사이드바가 있는 전폭 화면이다(880×620 안에 액자로 넣으면 두 사이드바가 겹친다).
//  권한 데이터(GET /api/ui/org)를 더 부르므로 **처음 펼 때** 그린다(머리말 ⚠ 규칙). 관리탭을 다녀왔으면 캐시를 쓴다.
const ADV_DESC: Record<string, string> = {
  'me-assets': '내 AI 가 쓰는 스킬과 훅을 켜고 끕니다.',
  'me-nodes': '내 노트북이나 서버를 라이블리에 연결해 거기서 AI 세션을 엽니다.',
  'profile': '조직 이름과 게이트웨이 주소 같은 기본 정보를 봅니다.',
  'ui': '조직이 기본으로 보는 화면(새 화면 · 클래식)을 정합니다.',
  'members': '이 조직에 누가 있는지 보고 고치며, 팀으로 묶습니다.',
  'member-add': '새 팀원을 조직에 등록합니다.',
  'member-access': '구성원이 무엇으로 접속하고, 그 사람의 AI 가 어느 계정으로 실행되는지 관리합니다.',
  'login-idp': '구성원이 회사 구글 · SSO 계정으로 로그인하게 합니다.',
  'tools': 'AI 가 호출할 수 있는 도구를 관리합니다 — 사내 API · 기본 제공 · 외부 도구 서버(MCP).',
  'credentials': 'AI 가 외부 서비스를 조직 공용 계정으로 쓰도록 미리 로그인해 둡니다.',
  'agent-assets': '구성원의 AI 에 배포할 스킬 · 서브에이전트 · 커맨드와 자동 실행 훅을 관리합니다.',
  'automation': '정해진 시각에 사람 없이 도는 작업과 상시 에이전트를 관리합니다.',
  'preview-envs': '아직 반영하지 않은 작업 화면을 운영 화면과 따로 띄워 확인합니다.',
  'session-share': '구성원의 AI 대화 기록을 중앙에 모아 이어보게 할지 정합니다.',
  'feed-targets': '위키 지식을 노션 같은 외부 도구로 내보냅니다.',
  'project-outbound': '프로젝트와 과업의 변경을 외부 협업 도구로 내보냅니다.',
  'db-sources': 'AI 가 조회할 데이터베이스를 등록하고 어느 테이블까지 보여줄지 정합니다.',
  'repos': '코드 레포(git)를 등록합니다 — 도메인맵과 코드 작업의 출처입니다.',
  'audit': '누가 언제 무엇을 했는지 봅니다 — 관리 변경 · DB 조회 · AI 도구 호출.',
  'storage': '메모리 · PTY · 디스크 사용량을 보고, 바닥나기 전에 알림 임계를 정합니다.',
  'logs': '게이트웨이 로그가 무한히 자라지 않도록 보관 상한을 정합니다.',
  'sessions': '이 박스에서 도는 모든 AI 세션을 보고 오래 쉬는 세션을 회수합니다.',
  'nodes': '조직이 함께 쓰는 컴퓨터 전체와 공유 지정을 관리합니다.',
};
function advancedPane(close: () => void): { node: HTMLElement; init: () => void } {
  const host = el('div', { class: 'v2me-dir' }, skeleton('설정 목록을 불러오는 중'));
  const node = pane('고급 설정',
    '조직 전체에 걸친 설정과 운영 화면입니다. 항목을 고르면 이 창이 닫히고 그 설정 화면이 열립니다.',
    host);
  node.classList.add('v2me-pane-wide');   // 행이 [이름 · 배지 · 설명 · ›] 한 줄이라 520px 에선 설명이 다 잘린다
  const paint = (groups: AdminDirGroup[]): void => {
    if (!groups.length) { host.replaceChildren(el('p', { class: 'prof-hint', text: '지금 권한으로 열 수 있는 설정 화면이 없습니다.' })); return; }
    const kids: HTMLElement[] = [];
    let anyGated = false;
    for (const g of groups) {
      kids.push(el('div', { class: 'v2me-more-k', text: g.label }));
      for (const s of g.items) {
        if (s.gated) anyGated = true;
        kids.push(moreLink('#/system/' + s.key, s.label, ADV_DESC[s.key] || '', close, { gated: s.gated }));
      }
    }
    // 배지 설명은 배지가 하나라도 있을 때만 — 없는 것을 설명하지 않는다.
    if (anyGated) kids.push(el('p', { class: 'prof-hint', style: 'margin-top:14px' }, ...uiText('「관리자」가 붙은 항목은 관리 권한이 있는 사람에게만 보입니다.')));
    host.replaceChildren(...kids);
  };
  const init = (): void => {
    void loadAdmin()
      .then((data: any) => paint(adminDirectory(data)))
      .catch((e: any) => host.replaceChildren(errorNote(e, '설정 목록을 불러오지 못했습니다')));
  };
  return { node, init };
}

// ── 회원 탈퇴(#1876) — 이 창 안에서 끝난다 ──────────────────────────────────────
//  화면이 "무엇이 지워지고 무엇이 남는지" 를 **서버 판정 그대로** 먼저 말한다(실행과 같은 함수를 쓴다).
//  확인은 이메일 타이핑 — 되돌릴 수 없는 일의 방어는 버튼 한 번이 아니다.
function accountDeleteModal(): void {
  const head = el('div', { class: 'ov-head' }, el('h3', { text: '회원 탈퇴' }));
  const box = el('div', { class: 'ov-box', style: 'max-width:520px' }, head);
  const back = el('div', { class: 'ov-back' }, box);
  const close = () => back.remove();
  head.append(el('button', { class: 'btn btn-ghost btn-sm', text: '닫기', onclick: close }));
  back.addEventListener('click', (e: any) => { if (e.target === back) close(); });
  document.addEventListener('keydown', function esc(ev: any) { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });

  const bodyEl = el('div', { style: 'margin-top:4px' }, el('p', { class: 'admin-hint', text: '확인하는 중입니다…' }));
  box.append(bodyEl);
  document.body.append(back);

  const listOf = (title: string, names: string[], tone: string) => el('div', { style: 'margin:10px 0' },
    el('p', { class: 'admin-hint', style: tone, text: title }),
    el('ul', { style: 'margin:4px 0 0; padding-left:18px; font-size:13.5px' },
      ...names.map((n) => el('li', { text: n }))));

  void (async () => {
    let plan: any;
    try { plan = await api('/api/ui/me/account-delete-plan'); }
    catch (e: any) {
      bodyEl.replaceChildren(el('p', { class: 'gate-error', text: (e && e.message) || '탈퇴 정보를 불러오지 못했습니다.' }));
      return;
    }
    // 막는 화면은 두 배포가 이유만 다르다 — 둘 다 '주인 없는 것을 남기지 않는다'가 근거다.
    const blocked = (title: string, names: string[], why: string) => {
      bodyEl.replaceChildren(
        names.length
          ? listOf(title, names, 'color:var(--danger-text,#b42318)')
          : el('p', { class: 'admin-hint', style: 'color:var(--danger-text,#b42318)', text: title }),
        el('p', { class: 'admin-hint' }, ...uiText(why)),
        el('div', { style: 'display:flex;justify-content:flex-end;margin-top:14px' },
          el('button', { type: 'button', class: 'btn btn-ghost', text: '닫기', onclick: close })));
    };

    const rows: any[] = [];

    if (plan.mode === 'selfhost') {
      // 셀프호스트 — '계정'이라는 상위 단위가 없다. 탈퇴 = 이 워크스페이스에서 내려오는 것.
      //  ⚠ 여기서 지워진다고 말하지 않는다. 실제로 지워지는 건 **들어올 수 있는 자격**이고,
      //   올린 자료·지식은 그대로 남는다. 화면이 과장하면 그것도 거짓말이다.
      if (plan.last_admin) {
        blocked('이 워크스페이스의 마지막 관리자라 지금은 탈퇴할 수 없습니다.', [],
          '다른 분에게 관리자 권한을 넘긴 뒤에 다시 시도해 주세요. 관리자가 아무도 없이 남으면 구성원을 들이거나 설정을 바꿀 수 있는 사람이 없어집니다.');
        return;
      }
      rows.push(el('p', { class: 'admin-hint' },
        ...uiText('«' + (plan.workspace || '이 워크스페이스') + '» 에서 내려옵니다. 지금 열려 있는 화면과 CLI 로그인이 즉시 끊기고, 비밀번호·구글·기기 승인 어느 쪽으로도 다시 들어오실 수 없습니다.')));
      rows.push(el('p', { class: 'admin-hint' },
        ...uiText('올리신 자료와 지식, 만드신 프로젝트는 팀의 것이라 그대로 남습니다. 그것까지 지우셔야 하면 관리자에게 요청해 주세요.')));
      rows.push(el('p', { class: 'admin-hint' },
        ...uiText('다시 들어오시려면 관리자가 계정을 되살려 드려야 합니다.')));
    } else {
      const blocking: string[] = plan.blocking_teams || [];
      const solo: string[] = plan.solo_workspaces || [];
      const left: string[] = plan.memberships || [];

      // 팀의 주인이면 막는다 — 주인 없는 팀을 남기지 않기 위해서다(넘기기는 아직 없다).
      if (blocking.length) {
        blocked('함께 쓰는 워크스페이스의 주인이라 지금은 탈퇴할 수 없습니다.', blocking,
          '이 워크스페이스를 다른 분에게 넘기거나 지운 뒤에 다시 시도해 주세요. 주인이 사라진 채로 남으면 남은 분들이 아무것도 할 수 없게 됩니다.');
        return;
      }
      rows.push(solo.length
        ? listOf('아래 워크스페이스가 함께 지워집니다 — 그 안의 자료와 대화도 사라집니다.', solo, 'color:var(--danger-text,#b42318)')
        : el('p', { class: 'admin-hint', text: '지워질 워크스페이스는 없습니다.' }));
      if (left.length) rows.push(listOf('아래 워크스페이스에서는 나가기만 합니다 — 거기에 올리신 자료와 지식은 그대로 남습니다.', left, ''));
      rows.push(el('p', { class: 'admin-hint' }, ...uiText('지운 워크스페이스의 파일은 복구를 위해 30일간 보관된 뒤 삭제됩니다. 더 빨리 파기해야 하면 운영팀에 요청해 주세요.')));
    }

    const input = el('input', { type: 'text', autocomplete: 'off', style: 'width:100%;margin-top:6px',
      placeholder: '탈퇴하려면 이메일을 그대로 입력: ' + (plan.email || '') });
    const err = el('p', { class: 'gate-error', hidden: true, style: 'margin:8px 0 0' });
    const go = el('button', { class: 'btn btn-danger', type: 'submit', text: '탈퇴하기' });
    const form = el('form', { style: 'margin:0' }, ...rows, input, err,
      el('p', { class: 'admin-hint', style: 'margin-top:8px' }, ...uiText(plan.mode === 'selfhost'
        ? '탈퇴하면 스스로 되돌릴 수 없습니다.'
        : '탈퇴하면 되돌릴 수 없습니다. 같은 이메일로 다시 가입하실 수는 있고, 그때는 빈 계정으로 시작합니다.')),
      el('div', { style: 'display:flex;gap:8px;justify-content:flex-end;margin-top:16px' },
        el('button', { type: 'button', class: 'btn btn-ghost', text: '취소', onclick: close }), go));

    form.addEventListener('submit', async (ev: any) => {
      ev.preventDefault();
      (err as any).hidden = true;
      (go as any).disabled = true;
      try {
        await api('/api/ui/me/account-delete', { method: 'POST', body: JSON.stringify({ confirm: input.value }) });
      } catch (e: any) {
        (go as any).disabled = false;
        err.textContent = (e && e.message) || '탈퇴에 실패했습니다.';
        (err as any).hidden = false;
        return;
      }
      // 계정이 사라졌으므로 이 화면에 더 머물 이유가 없다 — 곧바로 내보낸다.
      bodyEl.replaceChildren(el('p', { class: 'admin-hint', text: '탈퇴가 완료되었습니다. 로그아웃합니다…' }));
      setTimeout(() => logout(), 1200);
    });
    bodyEl.replaceChildren(form);
  })();
}

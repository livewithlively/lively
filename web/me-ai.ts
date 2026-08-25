// me-ai.ts — [내 설정 ▸ 내 AI 계정] 패널: 연결된 AI 계정(무엇으로·누구 계정으로)
//  (#1313 R38, admin.ts 에서 verbatim 분리).
//  AI 개인 규칙(org_member.body_md) 편집 폼도 여기 있었는데, 좌하단 내 프로필 창의 [AI 개인 규칙] 탭으로
//   옮겨 갔다(#1843 이 그 창을 만들고 #1898 이 이쪽 사본을 걷었다) — 같은 레코드를 고치는 폼이 두 화면에
//   있으면 어느 쪽이 정본인지 아무도 모른다. 직렬화 규약(PROF_* · profChips · parseMyProfile)은 그대로
//   me-profile.ts 소유이고, 이제 그 창(v2/me-modal.ts)만 쓴다.
import { api, busy, cardHead, el, errorNote, state, toast, uiText, withTip } from './core.js';
import { sessionTermUrl } from './lib/session-open.js';   // #1820 — 세션 주소는 한 곳에서만 만든다
import { sectionHead } from './admin-widgets.js';

// ── [내 설정 ▸ 내 AI 계정] 박스 — 내 AI 계정(#1085). ──
//  '내 AI 에게 무엇을 알려줄까'(개인 규칙, 내 프로필 창)와 달리 이 박스는 '내 AI 가 **무엇으로, 누구 계정으로** 도는가'다.
//  · 무엇으로 — 하네스(Claude Code · Codex). 지금 내 세션이 실제로 어느 것으로 떠 있는지 개수로 보여준다.
//  · 누구 계정으로 — 서버가 보는 자격증명 존재 여부(scope=isolated/profile/shared, /api/ui/me/ai-accounts).
//  로그인은 그 AI 를 띄운 **개인 세션**을 새 탭으로 열어 사람이 직접 한다(OAuth 는 브라우저 흐름이라 대행 불가) —
//  AI세션 탭의 [내 계정 로그인]과 같은 경로(loginProfile)를 재사용한다.
//
//  ⚠ codex 는 하네스 세션을 열어선 안 된다(#1516): 자격이 만료된 상태에서 codex 는 로그인 화면을 띄우는 대신
//   `Error: … refresh token was already used …` 를 뱉고 exit 1 로 즉사하고, 그러면 pane 이 사라져 **세션까지
//   함께 닫힌다** → 로그인하려고 연 세션이 로그인 화면을 못 보여주는 데드락. 그래서 codex 는 셸 세션에서
//   로그인 명령(`codex login --device-auth`)을 직접 돌린다(서버 loginFor — catalog.ts harnessLoginArgv).
//   device-auth 인 이유: 웹터미널은 원격이라 기본 플로우의 `http://localhost:1455`(서버의 localhost)에
//   사용자 브라우저가 닿지 못한다. device-auth 는 주소+일회용 코드라 어느 브라우저에서든 된다(실측).
const AI_LOGIN_HINT: Record<string, string> = {
  claude: '열린 세션의 claude 에서 /login 을 실행하세요.',
  codex: '열린 세션에 나오는 주소와 일회용 코드를 브라우저에 입력하면 됩니다.',
};
function aiAccountRow(a, mySessions, reload) {
  const mine = (mySessions || []).filter((s) => s.harness === a.key);
  const live = mine.filter((s) => s.agentState && s.agentState !== 'exited' && s.agentState !== 'offline');
  // 공유 계정 = 이 서버의 호스트 홈 자격을 전 구성원이 함께 쓰는 상태. 로그아웃하면 남의 세션까지 끊기므로 잠근다.
  const shared = a.scope === 'shared';
  // 상태는 3-상태다(true/false/null). **배지는 짧게, 사연은 툴팁으로** — 제약 설명(공용 계정·맥 키체인)을
  //  본문에 풀어 쓰면 두세 줄짜리 회색 문단이 되어 정작 '연결됐나?'가 안 읽힌다(사용자 지적).
  // ⚠ '연결됨'은 **자격이 저장돼 있다**는 뜻이지 '지금 쓸 수 있다'가 아니다(#1516). 만료·무효 토큰은 서버가
  //  알아낼 방법이 없다 — 파일 존재는 물론 `codex login status`·`codex doctor` 도 만료된 토큰을 정상으로
  //  보고한다(실측). 그래서 툴팁으로 그 한계를 말하고, 아래에서 **연결됨이어도 [다시 로그인]을 열어 둔다**.
  const st = a.loggedIn === true
    ? { text: '연결됨', cls: 'pill pill-ok', tip: (shared ? '이 서버 공용 계정으로 연결돼 있습니다' : '내 계정으로 연결돼 있습니다') + ' — ' + a.where + '. 저장된 자격이 있다는 뜻이며, 만료 여부까지는 서버가 알 수 없습니다 — 세션에서 로그인 오류가 나면 [다시 로그인] 을 누르세요.' }
    : a.loggedIn === false
      ? { text: '연결 안 됨', cls: 'pill', tip: '아직 로그인하지 않았습니다. [로그인] 을 누르면 이 AI 로 세션이 하나 열리고, 거기서 한 번만 로그인하면 됩니다.' }
      : { text: '확인 불가', cls: 'pill', tip: '이 서버가 로그인 여부를 확인하지 못했습니다(자격이 키체인에 있거나 접근할 수 없음). 세션이 잘 돌고 있으면 연결된 것입니다.' };
  const badge = withTip(el('span', { class: st.cls, text: st.text }), st.tip);
  const openLogin = async (ev) => {
    // 공용 계정에서의 로그인은 **남의 것까지 바꾼다** — 이 서버의 그 AI 계정이 통째로 바뀌므로 먼저 알린다.
    if (shared && !confirm(a.label + ' 로그인 세션을 열까요?\n\n이 서버는 구성원별 계정 격리가 없어, 여기서 로그인하면 이 서버의 ' + a.label + ' 계정이 통째로 바뀝니다 — 다른 구성원의 세션도 그 계정을 쓰게 됩니다.')) return;
    const btn = ev.currentTarget; btn.disabled = true;
    try {
      // codex 는 셸 세션 + 로그인 명령(loginFor), 그 외는 종전대로 그 하네스 세션(claude 의 /login 은 TUI 안이라 자동화 불가).
      const viaShell = a.key === 'codex';
      const out = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify({
        label: '내 계정 로그인 (' + a.label + ')', rootKey: 'personal', subpath: '',
        harness: viaShell ? 'shell' : a.key, loginFor: viaShell ? a.key : undefined,
        flags: {}, autoApprove: false, loginProfile: true,
      }) });
      toast('로그인용 세션을 열었습니다 — ' + (AI_LOGIN_HINT[a.key] || '그 세션에서 로그인하세요.'));
      if (out && out.session) window.open(sessionTermUrl(out.session.id, { label: out.session.label }), '_blank');
    } catch (e: any) { toast('로그인 세션을 열지 못했습니다 — ' + ((e && e.message) || e), true); }
    btn.disabled = false;
  };
  const logout = async (ev) => {
    if (!confirm(a.label + ' 에서 로그아웃할까요?\n\n내 자격증명만 지웁니다(다시 로그인하면 복구됩니다). 이미 떠 있는 세션의 AI 는 그 자리에서 끊기지 않고, 다음 로그인부터 적용됩니다.')) return;
    const btn = ev.currentTarget; btn.disabled = true;
    try { await api('/api/ui/me/ai-accounts/logout', { method: 'POST', body: JSON.stringify({ harness: a.key }) }); toast(a.label + ' 로그아웃됨'); }
    catch (e: any) { toast('로그아웃하지 못했습니다 — ' + ((e && e.message) || e), true); }
    void reload();
  };
  // 부제는 **한 줄**만 — 지금 이 AI 로 도는 내 세션이 몇 개인지(이 화면에서 사람이 실제로 궁금해하는 것).
  //  공유 계정 같은 단서는 짧은 꼬리표로만 붙이고 사연은 툴팁에 둔다.
  const sub = live.length ? `내 세션 ${live.length}개가 이 AI로 실행 중` : '이 AI로 실행 중인 내 세션 없음';
  return el('div', { class: 'aiacct' },
    el('div', { class: 'aiacct-txt' },
      el('div', { class: 'aiacct-head' },
        el('span', { class: 'aiacct-name', text: a.label }), badge,
        shared ? withTip(el('span', { class: 'pill', text: '서버 공용' }),
          '이 AI 의 계정은 이 서버 전체가 함께 씁니다 — 내가 연결한 것이 아닐 수 있고, 로그아웃하면 다른 구성원 세션까지 끊기므로 잠가 두었습니다.') : null),
      el('div', { class: 'aiacct-sub', text: sub })),
    el('div', { class: 'aiacct-act' },
      // 로그인 버튼은 **언제나 연다**(#1516). 종전엔 '연결 확정'이면 감췄는데, 판정이 자격 **파일 존재**만
      //  보므로 만료된 자격도 '연결됨'이 된다 → 세션이 인증 오류로 죽는 바로 그 상황에서 화면에 로그인
      //  진입점이 하나도 없었다(상민님 신고: "비개발자가 어떻게 로그인을 하라는건지도 알기 어렵다").
      //  다시 로그인은 어떤 상태에서도 해가 없다 — 강조만 낮춘다(연결됨이면 ghost).
      el('button', { type: 'button', class: a.loggedIn === true ? 'btn btn-ghost btn-sm' : 'btn btn-primary btn-sm',
        text: a.loggedIn === true ? '다시 로그인' : '로그인', onclick: openLogin }),
      a.canLogout ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '로그아웃', onclick: logout }) : null));
}
function myAiAccountsCard() {
  const body = el('div');
  // 제목이 '내 AI 계정'이면 거짓말이 될 수 있다 — 구성원별 격리가 없는 서버에서는 아래 상태가 **서버 공용 계정**의
  //  것이고 내가 연결한 게 아니다(사용자 지적: "Codex는 내가 연결한 적 없"). 중립 제목 + 상황별 배너로 바로잡는다.
  const card = el('div', { class: 'card' },
    cardHead('연결된 AI 계정', '내 AI 세션이 이 계정으로 실행됩니다. 계정이 구성원별로 갈리지 않는 서버에서는 \'서버 공용\' 표시가 붙습니다.'),
    body);
  const load = async () => {
    busy(body, el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));
    try {
      // 세션은 실패해도 계정 카드는 보여준다(개수는 부가정보) — 터미널이 없는 배포에서도 로그인 상태는 유효하다.
      const [acc, ses] = await Promise.all([
        api('/api/ui/me/ai-accounts'),
        api('/api/ui/terminal/sessions?includeProjects=1').catch(() => ({ sessions: [] })),
      ]);
      const meId = (state.me && (state.me.userId || state.me.email)) || '';
      const mine = (((ses || {}) as any).sessions || []).filter((s) => s.owner === meId);   // 프로젝트 세션은 전원 공개라 소유자로 좁힌다
      const accounts = ((acc || {}) as any).accounts || [];
      // 공용 계정이라는 사실은 행의 '서버 공용' 배지(+툴팁)로 충분하다 — 같은 말을 배너로 또 적지 않는다(사용자 요구).
      body.replaceChildren(...(accounts.length
        ? accounts.map((a) => aiAccountRow(a, mine, load))
        : [el('p', { class: 'admin-hint' }, ...uiText('이 서버에 로그인이 필요한 AI 가 없습니다.'))]));
    } catch (e) { body.replaceChildren(errorNote(e, '내 AI 계정 상태를 불러오지 못했습니다')); }
  };
  void load();
  return card;
}

// ── [내 설정 ▸ 내 AI 계정] — 화면 조립(**클래식 전용 자리**). ──
//  AI 개인 규칙 편집 폼(개인 레이어 org_member.body_md — #846 이 주입 배선을 완성)은 좌하단 내 프로필 창의
//  [AI 개인 규칙] 탭으로 옮겨 갔다(#1843·#1898). 여기는 계정 카드만 남고, 규칙은 안내 한 줄로 그 창을 가리킨다.
//  ⚠ 새 셸에서는 이 화면이 통째로 그 창의 [내 AI 계정] 탭이다(#1898) — admin-shell sectionHidden 이
//   새 셸에서만 감춘다. 클래식엔 그 창이 없으므로 여기가 유일한 자리라 지우지 않는다.
function myAiSection(detail) {
  detail.replaceChildren(
    sectionHead('내 AI 계정', '내 AI 세션이 어떤 AI 로, 누구 계정으로 실행되는지 보고 필요하면 로그인합니다.'),
    el('div', { class: 'admin-stack' },
      myAiAccountsCard(),
      el('p', { class: 'admin-hint' }, ...uiText('역할·호칭·말투·사용 언어 같은 **AI 개인 규칙**은 화면 왼쪽 아래의 내 이름을 눌러 열리는 내 프로필 창 [AI 개인 규칙] 에서 편집합니다.'))));
}

export {
  //  #1898 — 내 프로필 창([내 AI 계정] 탭)이 **이 카드를 그대로** 쓴다. 로그인 세션을 여는 규칙
  //  (claude 는 그 하네스로 · codex 는 셸 + device-auth)이 여기 한 곳에만 있어야 한다.
  myAiAccountsCard,
  myAiSection,
};

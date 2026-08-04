// me-ai.ts — [내 설정 ▸ 내 AI 설정] 패널: 연결된 AI 계정(무엇으로·누구 계정으로) + AI 개인 규칙
//  (#1313 R38, admin.ts 에서 verbatim 분리).
//  개인 레이어(org_member.body_md)의 선택지·직렬화·복원은 me-profile.ts 소유를 그대로 쓴다(PROF_* · profChips ·
//   parseMyProfile) — 규약이 두 벌이 되면 [내 정보] 모달과 이 화면의 저장이 서로를 지운다.
import { api, appUrl, cardHead, el, errorNote, state, toast, uiText, withTip } from './core.js';
import { field, skeleton } from './ui-primitives.js';
import { sectionHead } from './admin-widgets.js';
import { PROF_DEV, PROF_LANG, PROF_TONE, parseMyProfile, profChips } from './me-profile.js';

// ── [내 설정 ▸ 내 AI 설정] 상단 박스 — 내 AI 계정(#1085). ──
//  아래 박스가 '내 AI 에게 무엇을 알려줄까'(개인 규칙)라면, 이 박스는 '내 AI 가 **무엇으로, 누구 계정으로** 도는가'다.
//  성격이 달라 한 박스에 섞지 않고 위에 별도 카드로 둔다(사용자 요구).
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
      if (out && out.session) window.open(appUrl('/ui/terminal.html?session=') + encodeURIComponent(out.session.id) + '&label=' + encodeURIComponent(out.session.label || ''), '_blank');
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
    body.replaceChildren(el('p', { class: 'admin-hint' }, ...uiText('불러오는 중…')));
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

// ── [내 설정 ▸ 내 AI 설정] — 개인 레이어(org_member.body_md). ──
//  #846 이 배선을 완성했다: previewMemberContext 가 `## 내 개인 규칙 (나에게만 적용 — 팀 공유 아님)` 블록으로
//  **본인 세션에만** 싣는다(memberId = bearer principal — 남의 개인 규칙이 새지 않는다). 그 전엔 저장은 됐지만
//  **어떤 주입 경로도 읽지 않았다** — 그래서 개인 규칙을 올릴 데가 없어 injection='always' 지식(=전원 공유)
//  밖에 선택지가 없었다(남의 세션까지 오염). 이제 진짜로 반영되므로, 여기서 **실제 주입 전문**을 그대로 보여 준다.
//
//  필드는 4개로 줄였다(#837 · 사용자 지적: "응답길이랑 담당영역, 자주쓰는레포는 좀 불필요한거같아").
//   · 응답 길이 — 대화에서 그때그때 말하면 되는 것(고정하면 오히려 방해).
//   · 담당 영역 — 팀·카테고리 오너십(${team})이 이미 주입한다(중복).
//   · 자주 쓰는 도구·레포 — 세션이 열린 폴더·레포가 말해 준다(중복).
async function myAiSection(detail) {
  detail.replaceChildren(el('div', { class: 'card' }, skeleton('내 AI 설정을 불러오는 중')));
  let data: any;
  try { data = await api('/api/ui/me/profile'); }
  catch (e) { detail.replaceChildren(el('div', { class: 'card' }, errorNote(e, '불러오지 못했습니다'))); return; }
  const pr = parseMyProfile(data.body_md || '');

  const roleIn = el('input', { type: 'text', value: pr.role, placeholder: '예: 라이블리 공동대표 / 백엔드 개발 / 디자이너' });
  const addressIn = el('input', { type: 'text', value: pr.address, placeholder: '예: 상민님 / 대표님' });
  // 플레이스홀더는 **넣을 것만** 말한다 — 넣지 말 것(시크릿)은 아래 힌트로 따로 뗀다. 한 문장에 뭉쳐 놓으니
  //  '나만의 규칙·선호·맥락(도) 넣지 마세요'로 읽혔다(사용자 지적).
  const memoTa = el('textarea', { class: 'admin-ta admin-ta-prose', rows: '5',
    placeholder: '내 AI 가 알아두면 좋은 규칙·선호·맥락을 자유롭게 적어주세요.\n예: 금액은 항상 원 단위로 / 보고는 결론부터 / 화요일 오전엔 회의라 답이 늦어요' });
  memoTa.value = pr.memo;

  const devSel = { v: pr.dev };
  const devHint = el('p', { class: 'prof-hint' });
  const renderDevHint = () => { const d = PROF_DEV.find((x) => x.v === devSel.v); devHint.textContent = d ? d.hint : '항목을 고르면 AI가 그 수준에 맞춰 기술 설명의 자세한 정도를 조절해요.'; };
  const devChips = profChips(PROF_DEV, devSel, (o) => o.label, (o) => o.v, renderDevHint);
  renderDevHint();
  const toneSel = { v: pr.tone };
  const toneChips = profChips(PROF_TONE.map((t) => ({ v: t })), toneSel, (o) => o.v, (o) => o.v);
  // 사용 언어 — 프리셋 칩과 '직접 입력'이 한 값(langSel.v)을 공유한다. 칩을 고르면 입력칸을 비우고, 직접 입력하면 칩 선택이 풀린다.
  const langSel = { v: pr.lang };
  // 직접 입력 = 칩 줄의 마지막 칸. 칩과 같은 알약 모양·높이로 맞춰 한 줄에 이어 붙인다(#1085).
  const langCustom = el('input', { type: 'text', class: 'prof-chip-input', placeholder: '직접 입력 (예: Français)' });
  if (langSel.v && !PROF_LANG.includes(langSel.v)) langCustom.value = langSel.v;   // 프리셋 밖 값이면 입력칸에 복원
  const langChips = profChips(PROF_LANG.map((t) => ({ v: t })), langSel, (o) => o.v, (o) => o.v, () => { langCustom.value = ''; });
  langChips.append(langCustom);   // 칩 wrap(.prof-chips) 안 — 폭이 좁아지면 자연히 다음 줄로 넘어간다
  langCustom.addEventListener('input', () => { langSel.v = langCustom.value.trim(); (langChips as any).repaint(); });

  const saveBtn = el('button', { type: 'button', class: 'btn btn-primary', text: '저장' });
  const status = el('span', { class: 'admin-status' });
  saveBtn.addEventListener('click', async () => {
    // 선택·입력 → canonical markdown(AI가 읽기 좋고 parseMyProfile 로 복원 가능). 빈 항목은 생략.
    const lines: string[] = [];
    if (roleIn.value.trim()) lines.push('- 역할: ' + roleIn.value.trim());
    const d = PROF_DEV.find((x) => x.v === devSel.v);
    if (d) lines.push('- 개발 이해도: ' + d.label + ' — ' + d.hint);
    if (addressIn.value.trim()) lines.push('- 호칭: ' + addressIn.value.trim());
    if (toneSel.v) lines.push('- 말투: ' + toneSel.v);
    if (langSel.v) lines.push('- 사용 언어: ' + langSel.v + ' — 되도록 이 언어로 답하고, 다른 언어는 쓰지 마세요');
    let body = lines.length ? ('## 내 프로필\n' + lines.join('\n') + '\n') : '';
    const memo = memoTa.value.trim();
    if (memo) body += (body ? '\n' : '') + '## 추가 메모\n' + memo + '\n';
    saveBtn.disabled = true;
    // display_name·아바타는 **안 보낸다** — 서버가 보존하므로 [내 정보]가 지워지지 않는다.
    try {
      await api('/api/ui/me/profile', { method: 'POST', body: JSON.stringify({ body_md: body }) });
      toast('저장됨 — 다음 세션부터 내 AI 가 반영합니다'); status.textContent = '저장됨';
    } catch (e: any) { toast((e && e.message) || '저장하지 못했습니다', true); }
    saveBtn.disabled = false;
  });

  detail.replaceChildren(
    // 페이지 제목 = 이 화면 전체(계정 + 개인 규칙). 개별 박스 설명은 각 박스의 .caption 이 맡는다.
    //  (설명은 hint 한 줄만 — meaning 인자도 화면에 한 줄로 깔려서 둘 다 주면 같은 말이 두 줄로 겹친다.)
    sectionHead('내 AI 설정', '내 AI 세션이 어떤 계정으로 실행되는지, 그리고 내 AI 가 나에 대해 무엇을 알고 일할지 정합니다. 여기 설정은 나에게만 적용되고 팀에는 공유되지 않습니다.'),
    // 두 박스는 성격이 다르다 — 붙여 놓으면 한 덩어리로 읽힌다. .admin-stack 으로 간격을 준다(관리탭 공용 규약).
    el('div', { class: 'admin-stack' },
      myAiAccountsCard(),   // 위 박스 = 내 AI 가 '무엇으로·누구 계정으로' 도는가(#1085)
      el('div', { class: 'card admin-form-narrow' },
        // 섹션 제목은 서술문('~할 것')이 아니라 **명사구**로 — 관리탭 다른 섹션(구성원·조직 정보·세션 주입)과 같은 규격.
        //  설명 한 줄은 위 [AI 계정 연결] 박스와 같은 자리(.caption)에 둔다: 박스마다 [제목 · 한 줄 설명 · 내용].
        cardHead('AI 개인 규칙', '내 역할·호칭·말투·사용 언어입니다. 내 AI 가 매 세션을 시작할 때 이 내용을 읽고 따릅니다 — 나에게만 적용되고 팀에는 공유되지 않습니다.'),
        // 필드는 종전 그대로 — 라벨 + 입력칸 + 회색 힌트(사용자: "필드들은 ⓘ 규격 바꾸지 말고 이전 유지").
        field('역할', roleIn),
        field('개발 이해도', el('div', {}, devChips, devHint)),
        field('호칭 (AI가 나를 부르는 말)', addressIn),
        field('말투', toneChips),
        // 직접 입력칸은 칩과 **같은 줄**에 칩 모양으로 붙인다(#1085) — '한국어·English·…' 다음에 오는
        //  또 하나의 선택지지, 아래 딸린 별개 입력이 아니다. 실제 배치는 profChips 가 wrap 안에 넣어 준다.
        field('사용 언어 (AI가 답하는 언어)', el('div', {}, langChips,
          el('p', { class: 'prof-hint' }, ...uiText('고르거나 직접 적은 언어로 내 AI가 답해요. 비우면 조직 기본값(주로 한국어)을 따릅니다.')))),
        field('추가 메모', el('div', {}, memoTa,
          el('p', { class: 'prof-hint' }, ...uiText('비밀번호·API 키·개인키 같은 비밀값은 적지 마세요. 토큰으로 보이는 값이 들어 있으면 저장되지 않고 오류로 알려드립니다.')))),
        el('div', { class: 'admin-actions' }, saveBtn, status))));
}

export {
  myAiSection,
};

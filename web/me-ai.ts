// me-ai.ts — [내 설정 ▸ 내 AI 계정] 패널: 연결된 AI 계정(무엇으로·누구 계정으로)
//  (#1313 R38, admin.ts 에서 verbatim 분리).
//  AI 개인화(org_member.body_md) 편집 폼도 여기 있었는데, 좌하단 내 프로필 창의 [AI 개인화] 탭으로
//   옮겨 갔다(#1843 이 그 창을 만들고 #1898 이 이쪽 사본을 걷었다) — 같은 레코드를 고치는 폼이 두 화면에
//   있으면 어느 쪽이 정본인지 아무도 모른다. 직렬화 규약(PROF_* · profChips · parseMyProfile)은 그대로
//   me-profile.ts 소유이고, 이제 그 창(v2/me-modal.ts)만 쓴다.
import { api, busy, cardHead, el, errorNote, relTime, state, toast, uiText, withTip } from './core.js';
import { overlay } from './ui-primitives.js';
import { sessionTermUrl } from './lib/session-open.js';   // #1820 — 세션 주소는 한 곳에서만 만든다
import { sectionHead } from './admin-widgets.js';
//  헤드리스 토큰을 다시 넣는 폼 — 자격 금고 소유 그대로 부른다(여기서 폼을 다시 만들지 않는다).
import { svcTokenForm } from './admin-credentials.js';
//  ★ #2477 — «화면에서 끝나는 로그인» 의 프로토콜은 한 벌이다(처음 설정과 공유). 여기선 그리기만 한다.
import {
  isInlineCardHarness, startInlineAiLogin, ensureLoginTerminal, loginTerminalSrc, loginTerminalPopoutUrl,
  type InlineLoginHandle, type LoginTerminal,
} from './lib/ai-login-inline.js';

// ── [내 설정 ▸ 내 AI 계정] 박스 — 내 AI 계정(#1085). ──
//  '내 AI 에게 무엇을 알려줄까'(개인 규칙, 내 프로필 창)와 달리 이 박스는 '내 AI 가 **무엇으로, 누구 계정으로** 도는가'다.
//  · 무엇으로 — 하네스(Claude Code · Codex). 지금 내 세션이 실제로 어느 것으로 떠 있는지 개수로 보여준다.
//  · 누구 계정으로 — 서버가 보는 자격증명 존재 여부(scope=isolated/profile/shared, /api/ui/me/ai-accounts).
//  ★ 로그인은 **이 자리에서** 끝난다(#2477). 종전엔 새 탭(데스크톱 앱에서는 새 창)으로 세션을 열었는데,
//   그러면 사람은 «어디로 돌아오지» 를 만나고 맥락이 끊긴다. 이제:
//    · codex·claude·grok — 서버가 로그인 명령을 대신 돌리고 **주소·코드만** 이 행 아래 펼쳐 보여 준다.
//    · agy·그 밖        — 주소·코드로 안 끝나므로 **터미널을 이 행 아래 액자로** 띄운다(?embed=1, #1744).
//   그 통로의 정본은 lib/ai-login-inline.ts 이고 처음 설정(v2/onboarding.ts)과 **같은 한 벌**을 쓴다 —
//   화면 하나에서만 되는 것은 «된다» 가 아니고, 두 벌로 두면 실측으로 얻은 처방이 갈린다.
//  ⚠ 그래도 «창으로 열기» 는 남긴다 — 액자가 좁거나 여기서 못 뜨는 경우의 탈출로다(막다른 카드 금지).
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
      //  ★ #2477 — «모름» 에도 두 종류가 있다. probe 하네스(agy)는 **아직 안 물어본 것**이지 못 잰 것이 아니다.
      //   그 둘을 같은 문장으로 말하면 사람이 «이 서버가 고장났나» 로 읽는다.
      : a.how === 'probe'
        ? { text: '확인 필요', cls: 'pill', tip: a.label + ' 는 자격이 파일로 남지 않아, 목록을 열 때가 아니라 **물어봐야** 알 수 있습니다(그 CLI 에게 직접 묻습니다 — 몇 초 걸립니다). [확인] 을 누르면 지금 재 봅니다.' }
        : { text: '확인 불가', cls: 'pill', tip: '이 서버가 로그인 여부를 확인하지 못했습니다(자격이 키체인에 있거나 접근할 수 없음). 세션이 잘 돌고 있으면 연결된 것입니다.' };
  const badge = withTip(el('span', { class: st.cls, text: st.text }), st.tip);
  //  ── 이 행 아래 펼쳐지는 로그인 자리(#2477) ────────────────────────────────────
  //   ⚠ 카드를 **지우는 경로를 두지 않는다.** 실측(2026-08-31): 조회가 30초 끊기자 탈출로가 카드를 덮어
  //    받은 주소와 사람이 치던 코드까지 지웠다. 여기서는 채우기만 하고, 실패·정체는 잔글씨로만 말한다.
  const panel = el('div', { class: 'aiacct-login', hidden: true });
  let handle: InlineLoginHandle | null = null;
  let term: LoginTerminal | null = null;
  let fellBack = false;   // 카드가 못 떠서 터미널로 옮겼나(한 번만)
  let noteEl: HTMLElement | null = null;
  const note = (t: string) => { if (noteEl) noteEl.textContent = t || ''; };

  /**
   * 종전 «창으로 열기» — 어떤 갈래에서도 갇히지 않게 늘 곁에 둔다. 이미 만든 세션이 있으면 **그것**을 연다.
   *
   *  ⚠ 창은 **사람이 누른 그 순간** 연다. `await` 뒤의 `window.open` 은 그 제스처와 끊겨 **팝업차단에
   *   조용히 막힌다**(#2055 에서 실제로 밟았다 — 오류도 안 난다). 그래서 빈 탭을 먼저 열어 두고,
   *   세션이 생기면 그 탭을 그 주소로 보낸다. 차단돼 탭을 못 받았으면(w=null) 그 사실을 말한다.
   */
  const openWindow = () => {
    const w = window.open('', '_blank');
    const send = (url: string, msg: string) => {
      if (w) { w.location.href = url; toast(msg); }
      else toast('브라우저가 새 탭을 막았어요 — 팝업 차단을 풀고 다시 눌러 주세요.', true);
    };
    if (term) { send(loginTerminalPopoutUrl(term), '같은 로그인 창을 새 탭에서 열었어요.'); return; }
    void (async () => {
      try {
        const viaShell = a.key === 'codex' || a.key === 'grok';   // 셸에서 로그인 명령을 돌린다(catalog.harnessLoginArgv)
        const out: any = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify({
          label: '내 계정 로그인 (' + a.label + ')', rootKey: 'personal', subpath: '',
          harness: viaShell ? 'shell' : a.key, loginFor: viaShell ? a.key : undefined,
          flags: {}, autoApprove: false, loginProfile: true,
        }) });
        if (!(out && out.session)) throw new Error('세션을 받지 못했어요');
        send(sessionTermUrl(out.session.id, { label: out.session.label }),
          '로그인용 세션을 열었습니다 — ' + (AI_LOGIN_HINT[a.key] || '그 세션에서 로그인하세요.'));
      } catch (e: any) {
        try { w?.close(); } catch (_) { /* 이미 사람이 닫았을 수 있다 */ }
        toast('로그인 세션을 열지 못했습니다 — ' + ((e && e.message) || e), true);
      }
    })();
  };

  /** 주소·코드 카드(codex·claude·grok) — 터미널이 아예 필요 없는 하네스. */
  const paintCard = () => {
    const addr = el('code', { class: 'aiacct-addr', text: '주소를 받는 중이에요…' });
    const open = el('a', { class: 'btn btn-primary btn-sm', target: '_blank', rel: 'noopener', text: '열기 ↗', hidden: true });
    const code = el('button', { type: 'button', class: 'aiacct-code', hidden: true, title: '눌러서 복사' });
    code.onclick = () => { void navigator.clipboard?.writeText(code.textContent || '').then(() => toast('복사했어요')); };
    const pasteRow = el('div', { class: 'aiacct-paste', hidden: true });
    const inp = el('input', { class: 'input', type: 'text', placeholder: '브라우저에서 받은 코드' }) as HTMLInputElement;
    const put = el('button', { class: 'btn btn-primary btn-sm', text: '넣기' }) as HTMLButtonElement;
    const submit = async () => {
      const v = inp.value.trim(); if (!v || !handle) return;
      put.disabled = true; put.textContent = '넣는 중…';
      try { await handle.paste(v); put.textContent = '넣었어요'; note('코드를 넣었어요 — 확인하는 중이에요'); }
      catch (e: any) { put.disabled = false; put.textContent = '넣기'; note('코드를 넣지 못했어요 — ' + ((e && e.message) || e)); }
    };
    put.onclick = submit;
    inp.onkeydown = (ev) => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); void submit(); } };
    pasteRow.append(inp, put);
    noteEl = el('span', { class: 'aiacct-note' });
    panel.replaceChildren(
      el('div', { class: 'aiacct-addrrow' }, addr, open),
      code, pasteRow,
      el('div', { class: 'aiacct-foot' },
        el('button', { type: 'button', class: 'ob-linkbtn', text: '다시 시도', onclick: () => { handle?.stop(); run(true); } }),
        el('button', { type: 'button', class: 'ob-linkbtn', text: '창으로 열기 ↗', onclick: () => openWindow() }),
        noteEl));
    return {
      url: (u) => { addr.textContent = u.replace(/^https?:\/\//, ''); open.setAttribute('href', u); open.hidden = false; },
      code: (c) => { code.textContent = c; code.hidden = false; },
      needsPaste: () => { pasteRow.hidden = false; setTimeout(() => inp.focus(), 100); },
      done: () => { note(''); panel.replaceChildren(el('div', { class: 'aiacct-ok', text: '✓ 로그인이 끝났어요' })); setTimeout(() => void reload(), 800); },
      //  ⚠ **시작 자체가 실패하면 터미널로 떨어진다**(막다른 카드 금지의 실물).
      //   매니지드에서 이 카드는 멤버 중계 = **tmux 컨테이너**에서 로그인 명령을 돌리는데, #2454(이미지
      //   역할 분할)가 거기서 하네스 4종을 걷어냈다 — 그래서 «grok 없음» 이 난다(실측 2026-09-01).
      //   반면 터미널 경로는 **세션 컨테이너**를 만들고 그쪽엔 하네스가 있다. 그러니 사람을 막다른 곳에
      //   세우지 말고 되는 길로 옮긴다. (근본 수정은 카드도 세션 경계에서 돌리는 것 — 별건.)
      failed: (m) => {
        if (/없음|not found|127/.test(String(m)) && !fellBack) {
          fellBack = true; handle?.stop();
          note('');
          void paintTerminal();
          return;
        }
        note(m + ' — 창으로 여시거나 [다시 시도] 를 눌러 보세요.');
      },
      stalled: () => note('주소가 늦네요 — 조금 더 기다리거나 창으로 여셔도 됩니다.'),
    };
  };

  /** 인라인 터미널(agy·미지) — 주소·코드로 안 끝나므로 그 자리에 터미널을 얹는다. */
  const paintTerminal = async () => {
    const st = el('span', { class: 'aiacct-note', text: '터미널을 여는 중이에요…' });
    const out = el('a', { class: 'aiacct-pop', target: '_blank', rel: 'noopener', text: '새 탭에서 크게 보기 ↗', hidden: true });
    const frame = el('iframe', { class: 'aiacct-term', title: '로그인 터미널' }) as HTMLIFrameElement;
    panel.replaceChildren(
      el('div', { class: 'aiacct-termbar' }, st, out),
      frame,
      el('div', { class: 'aiacct-foot' },
        el('span', { class: 'aiacct-note', text: '창 안을 한 번 누르면 글자를 칠 수 있어요. 붙여넣기는 ⌘V(윈도우 Ctrl+V). 끝나면 [상태 새로고침].' }),
        el('button', { type: 'button', class: 'ob-linkbtn', text: '상태 새로고침', onclick: () => void reload() })));
    try {
      term = await ensureLoginTerminal(a.key, a.label, term);
      frame.setAttribute('src', loginTerminalSrc(term));
      st.textContent = a.label + ' 로그인 — 이 자리에서 하시면 됩니다.';
      out.setAttribute('href', loginTerminalPopoutUrl(term)); out.hidden = false;
    } catch (e: any) {
      //  막다른 액자를 만들지 않는다 — 여기서 못 띄웠으면 그렇게 말하고 **사람이 누르는** 탈출로를 준다.
      st.textContent = '이 자리에 못 띄웠어요 — ' + ((e && e.message) || e);
      out.textContent = '창으로 열기 ↗'; out.hidden = false;
      out.onclick = (ev) => { ev.preventDefault(); openWindow(); };
    }
  };

  const run = (restart?: boolean) => {
    panel.hidden = false;
    if (!isInlineCardHarness(a.key)) { void paintTerminal(); return; }
    const view = paintCard();
    handle = startInlineAiLogin(a.key, view, { restart, alive: () => document.body.contains(panel) });
  };

  const openLogin = async (ev) => {
    // 공용 계정에서의 로그인은 **남의 것까지 바꾼다** — 이 서버의 그 AI 계정이 통째로 바뀌므로 먼저 알린다.
    if (shared && !confirm(a.label + ' 에 로그인할까요?\n\n이 서버는 구성원별 계정 격리가 없어, 여기서 로그인하면 이 서버의 ' + a.label + ' 계정이 통째로 바뀝니다 — 다른 구성원의 세션도 그 계정을 쓰게 됩니다.')) return;
    const btn = ev.currentTarget; btn.disabled = true;
    //  ⚠ 사람이 [로그인]/[다시 로그인] 을 **명시적으로** 눌렀다 = «지금 새로 하고 싶다» 다.
    //   restart 없이 부르면 서버가 «이미 돌고 있다» 며 지난 시도의 **만료된 코드**를 그대로 보여 준다(#2232 실측).
    run(true);
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
      //  ★ probe 하네스(agy)는 «지금 재 보기» 를 준다 — 목록 조회에 4.3초짜리 프로브를 넣지 않는 대신,
      //   사람이 궁금할 때 그 행만 묻는다(서버 교리와 같은 자리: 뜨거운 경로에 프로브를 올리지 않는다).
      a.how === 'probe' ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '확인',
        onclick: async (ev) => {
          const b2 = ev.currentTarget as HTMLButtonElement; b2.disabled = true; const was = b2.textContent; b2.textContent = '확인 중…';
          try {
            const r: any = await api('/api/ui/me/ai-accounts/check', { method: 'POST', body: JSON.stringify({ harness: a.key }) });
            //  ⚠ null 은 통과가 아니다 — «모름» 을 «연결됨» 으로 접지 않는다(이 화면의 교리).
            toast(r && r.loggedIn === true ? a.label + ' 에 연결돼 있습니다.'
              : r && r.loggedIn === false ? a.label + ' 에 아직 로그인하지 않았습니다.'
              : a.label + ' 로그인 여부를 확인하지 못했습니다(그 자리에서 CLI 를 못 불렀습니다).');
          } catch (e: any) { toast('확인하지 못했습니다 — ' + ((e && e.message) || e), true); }
          b2.disabled = false; b2.textContent = was;
        } }) : null,
      el('button', { type: 'button', class: a.loggedIn === true ? 'btn btn-ghost btn-sm' : 'btn btn-primary btn-sm',
        text: a.loggedIn === true ? '다시 로그인' : '로그인', onclick: openLogin }),
      a.canLogout ? el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '로그아웃', onclick: logout }) : null),
    //  ⚠ **행에 붙인다.** 이걸 빠뜨리면 `panel.hidden=false` 가 아무 데도 안 보이고,
    //   `alive: () => document.body.contains(panel)` 이 늘 false 라 폴링도 즉시 죽는다 — 눌러도
    //   **아무 일도 안 일어난다**(오류도 없다). 실측(2026-09-01, 상민님 신고)으로 밟았다.
    panel);
}
// ── 헤드리스 인증 실패 줄(#1675 → 여기로 옮겨 되살림, 2026-09-03) ────────────────────────
//  **무엇이 다른가:** 위 계정 행들은 «내가 앉아서 쓰는 세션» 이 무엇으로 도는지다. 이 줄은 «사람이 안 보는
//   동안 도는 것»(증류 · 분류 · 에이전트 크론 · 위탁)이 무엇으로 도는지다 — 그 실행은 내가 등록해 둔
//   `claude setup-token`(member_secret kind=claude_setup_token)을 빌려 **내 Claude 계정으로** 돈다
//   (src/node/task-scheduler.ts — CLAUDE_CODE_OAUTH_TOKEN 으로 리스).
//  **왜 실패를 화면이 말해야 하나:** 그 토큰이 폐기·만료되면 자동 작업이 auth/init 에서 막히는데, 화면은
//   아무 데도 안 변한다 — 증류가 안 돌고 크론이 안 도는 것을 며칠 뒤에 안다. #1675 가 그래서 배지를 만들었다.
//  ⚠ **그 배지가 한동안 어디에도 안 떴다.** 배지는 [외부 서비스]의 «Claude (헤드리스 실행)» 행에 붙어
//   있었는데, #2243 이 그 앱을 `LOGIN_SERVICES.hidden` 으로 내렸고 me-logins 의 `partition` 은 hidden 을
//   네 버킷 전부에서 건너뛴다 → 행이 안 만들어지니 배지도 못 붙었다(주소로 여는 상세에도 없었다).
//   그래서 **자리를 옮겨** 되살린다: 여기는 앱 카탈로그가 아니라 «내 AI 가 무엇으로 도나» 를 보는 화면이라,
//   목록에서 내려도 사라지지 않는다. 신호 출처는 그대로 서버 한 곳이다(me/credentials 의 headless_auth_failure).
//  ⚠ 실패가 **마지막 등록보다 나중**일 때만 말한다 — 다시 등록했으면 지난 실패는 이미 해결된 것이다.
function headlessAuthWarn(creds: any, reload: () => void): HTMLElement | null {
  const fail = creds?.headless_auth_failure;
  if (!fail) return null;
  const cred = (creds.credentials || []).find((c: any) => c.kind === 'claude_setup_token');
  if (!cred?.has_secret) return null;   // 등록한 적 없는 사람에게 남의 실패를 보여주지 않는다
  const failAt = fail.at ? new Date(fail.at).getTime() : 0;
  const setAt = cred.updated_at ? new Date(cred.updated_at).getTime() : 0;
  if (!(failAt > setAt)) return null;
  //  ⚠ 카드 안에 카드를 만들지 않는다(디자인시스템 §9 — me-logins.ts 가 같은 자리에 적어 둔 규칙).
  //   이 카드 body 의 **맨 위 한 줄**로 앉힌다: 계정 행들을 읽기 전에 먼저 눈에 들어와야 하는 사실이다.
  return el('div', { class: 'svc-conn-blurb', style: 'margin:0 0 12px' },
    el('span', { class: 'pill pill-warn', text: '인증 실패' }),
    el('span', { text: ' ' + relTime(fail.at) + ' · ' + String(fail.label || '')
      + ' — 사람 없이 도는 작업(증류 · 분류 · 에이전트 크론 · 위탁)이 내 Claude 계정으로 인증하지 못했습니다.'
      + ' 터미널에서 `claude setup-token` 을 다시 실행해 나온 토큰으로 바꾸세요.'
      + ' 내 PC(노드)에서 실행된 작업이었다면 그 PC 의 Claude 로그인을 다시 하셔야 합니다 —'
      + ' 그 경우 이 안내는 30일 뒤 저절로 사라집니다.'
      + ' 이 실패로 멈춘 예약 작업이 있다면 관리 ▸ 자동화에서 다시 켜세요.' }),
    el('div', { class: 'admin-actions', style: 'margin:8px 0 0' },
      el('button', {
        type: 'button', class: 'btn btn-ghost btn-sm', text: '토큰 교체',
        onclick: () => {
          const host = el('div', { class: 'svc-form-host', style: 'min-width:min(460px, 78vw)' });
          const back = overlay('Claude 헤드리스 토큰 교체', host);
          host.append(svcTokenForm('claude_setup_token', () => { back.remove(); reload(); }));
        },
      })));
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
      //  자격도 같다 — 못 읽으면 헤드리스 경고 줄만 없고 계정 행은 그대로 뜬다(부가 신호 하나가 화면을 못 잡아먹는다).
      const [acc, ses, creds] = await Promise.all([
        api('/api/ui/me/ai-accounts'),
        api('/api/ui/terminal/sessions?includeProjects=1').catch(() => ({ sessions: [] })),
        api('/api/ui/me/credentials').catch(() => null),
      ]);
      const meId = (state.me && (state.me.userId || state.me.email)) || '';
      const mine = (((ses || {}) as any).sessions || []).filter((s) => s.owner === meId);   // 프로젝트 세션은 전원 공개라 소유자로 좁힌다
      const accounts = ((acc || {}) as any).accounts || [];
      // 공용 계정이라는 사실은 행의 '서버 공용' 배지(+툴팁)로 충분하다 — 같은 말을 배너로 또 적지 않는다(사용자 요구).
      const warn = headlessAuthWarn(creds, load);   // 있으면 계정 행보다 **위**에 — 먼저 읽혀야 하는 사실이다
      body.replaceChildren(...(warn ? [warn] : []), ...(accounts.length
        ? accounts.map((a) => aiAccountRow(a, mine, load))
        : [el('p', { class: 'admin-hint' }, ...uiText('이 서버에 로그인이 필요한 AI 가 없습니다.'))]));
    } catch (e) { body.replaceChildren(errorNote(e, '내 AI 계정 상태를 불러오지 못했습니다')); }
  };
  void load();
  return card;
}

// ── [내 설정 ▸ 내 AI 계정] — 화면 조립(**클래식 전용 자리**). ──
//  AI 개인화 편집 폼(개인 레이어 org_member.body_md — #846 이 주입 배선을 완성)은 좌하단 내 프로필 창의
//  [AI 개인화] 탭으로 옮겨 갔다(#1843·#1898). 여기는 계정 카드만 남고, 규칙은 안내 한 줄로 그 창을 가리킨다.
//  ⚠ 새 셸에서는 이 화면이 통째로 그 창의 [AI 계정 연결] 탭이다(#1898) — admin-shell sectionHidden 이
//   새 셸에서만 감춘다. 클래식엔 그 창이 없으므로 여기가 유일한 자리라 지우지 않는다.
function myAiSection(detail) {
  detail.replaceChildren(
    sectionHead('내 AI 계정', '내 AI 세션이 어떤 AI 로, 누구 계정으로 실행되는지 보고 필요하면 로그인합니다.'),
    el('div', { class: 'admin-stack' },
      myAiAccountsCard(),
      el('p', { class: 'admin-hint' }, ...uiText('역할·호칭·말투·사용 언어 같은 **AI 개인화**는 화면 왼쪽 아래의 내 이름을 눌러 열리는 내 프로필 창 [AI 개인화] 에서 편집합니다.'))));
}

export {
  //  #1898 — 내 프로필 창([AI 계정 연결] 탭)이 **이 카드를 그대로** 쓴다. 로그인 세션을 여는 규칙
  //  (claude 는 그 하네스로 · codex 는 셸 + device-auth)이 여기 한 곳에만 있어야 한다.
  myAiAccountsCard,
  myAiSection,
};

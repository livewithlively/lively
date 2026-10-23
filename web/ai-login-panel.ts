// ai-login-panel.ts — «이 자리에서 끝나는 AI 로그인» 칸 한 벌 (#2477 · #4970).
//
//  [나] 창 [AI 계정 연결](me-ai.ts)과 처음 설정 «AI 연결»(v2/onboarding.ts)이 **같은 칸**을 쓴다. 종전엔 이 칸이 me-ai.ts 의 한 행 안에
//  묶여 있었는데, 처음 설정이 AI 연결을 다시 갖게 되면서(#4970 상민님 2026-10-23 «AI 연결 유도를 앱 연결 전에») 떼어 냈다 —
//  두 벌로 두면 실측으로 얻은 처방(카드를 지우지 않기 · 팝업 차단 · 카드가 못 뜨면 터미널로)이 갈린다.
//  주고받는 규약은 lib/ai-login-inline.ts 가 정본이고, 이 파일은 «어떻게 그리나» 만 갖는다.
//  · codex·claude·grok — 서버가 로그인 명령을 대신 돌리고 **주소·코드만** 이 칸에 펼친다.
//  · agy·그 밖        — 주소·코드로 안 끝나므로 **터미널을 이 칸에 액자로** 띄운다(?embed=1, #1744).
//  ⚠ 칸(panel)은 **부른 쪽이 화면에 붙인다.** 안 붙이면 `panel.hidden=false` 가 아무 데도 안 보이고,
//   `alive: () => document.body.contains(panel)` 이 늘 false 라 폴링도 즉시 죽는다 — 눌러도 아무 일도 안 일어난다(실측 2026-09-01).
import { api, el, toast } from './core.js';
import { sessionTermUrl } from './lib/session-open.js';   // #1820 — 세션 주소는 한 곳에서만 만든다
import {
  isInlineCardHarness, startInlineAiLogin, ensureLoginTerminal, loginTerminalSrc, loginTerminalPopoutUrl,
  type InlineLoginHandle, type LoginTerminal,
} from './lib/ai-login-inline.js';

/** 칸이 다루는 AI 한 줄 — /api/ui/me/ai-accounts 의 행. */
export interface AiLoginAccount { key: string; label: string; scope?: string }

//  ⚠ codex 는 하네스 세션을 열어선 안 된다(#1516): 자격이 만료된 상태에서 codex 는 로그인 화면을 띄우는 대신
//   `Error: … refresh token was already used …` 를 뱉고 exit 1 로 즉사하고, 그러면 pane 이 사라져 **세션까지
//   함께 닫힌다** → 로그인하려고 연 세션이 로그인 화면을 못 보여주는 데드락. 그래서 codex 는 셸 세션에서
//   로그인 명령(`codex login --device-auth`)을 직접 돌린다(서버 loginFor — catalog.ts harnessLoginArgv).
const AI_LOGIN_HINT: Record<string, string> = {
  claude: '열린 세션의 claude 에서 /login 을 실행하세요.',
  codex: '열린 세션에 나오는 주소와 일회용 코드를 브라우저에 입력하면 됩니다.',
};

/**
 * 공용 계정에서의 로그인은 **남의 것까지 바꾼다** — 이 서버의 그 AI 계정이 통째로 바뀌므로 먼저 알린다.
 *  (#4970) [AI 계정 연결]과 처음 설정이 같은 물음을 쓴다. 공용이 아니면 묻지 않고 true.
 */
export function confirmSharedLogin(a: AiLoginAccount): boolean {
  if (a.scope !== 'shared') return true;
  return confirm(a.label + ' 에 로그인할까요?\n\n이 서버는 구성원별 계정 격리가 없어, 여기서 로그인하면 이 서버의 ' + a.label + ' 계정이 통째로 바뀝니다 — 다른 구성원의 세션도 그 계정을 쓰게 됩니다.');
}

export interface AiLoginPanel {
  /** 펼쳐지는 칸 — 부른 쪽이 화면에 붙인다(머리말 ⚠). */
  panel: HTMLElement;
  /** 로그인을 띄운다. 사람이 [로그인]을 눌렀으면 restart — 지난 시도의 코드는 이미 죽었다(#2232). */
  run(restart?: boolean): void;
}

/**
 * 한 AI 의 로그인 칸을 만든다. reload — 끝났거나 사람이 [상태 새로고침]을 눌렀을 때 부른다(부른 쪽이 상태를 다시 읽는다).
 *   ⚠ 카드를 **지우는 경로를 두지 않는다.** 실측(2026-08-31): 조회가 30초 끊기자 탈출로가 카드를 덮어
 *    받은 주소와 사람이 치던 코드까지 지웠다. 여기서는 채우기만 하고, 실패·정체는 잔글씨로만 말한다.
 */
export function aiLoginPanel(a: AiLoginAccount, reload: () => void | Promise<void>): AiLoginPanel {
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
      else toast('브라우저가 새 탭 열기를 차단했습니다. 팝업 차단을 해제한 뒤 다시 눌러 주세요.', true);
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
  return { panel, run };
}

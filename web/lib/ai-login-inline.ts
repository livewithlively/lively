// ai-login-inline.ts — «화면에서 끝나는 AI 로그인» 의 **클라이언트 프로토콜 한 벌** (#2055 · #2477).
//
//  ── 왜 이 파일이 생겼나 ──────────────────────────────────────────────────────
//  종전엔 이 통로가 **처음 설정(v2/onboarding.ts) 안에만** 있었다. 그래서 온보딩을 끝낸 사람이 나중에
//  AI 를 잇거나 자격이 만료돼 다시 로그인할 때는 여전히 «새 탭에 터미널» 이었다 — 실사용자 대부분이
//  그쪽이다(상민님 2026-09-01: *"저 웤스는 이미 온보딩 끝난앤데"*). 화면 하나에서만 되는 것은
//  «된다» 가 아니다.
//
//  그렇다고 [내 AI 계정]에 폴링 루프를 한 벌 더 쓰면, 이 통로가 실측으로 얻은 처방들(30초 상한 ·
//  restart · 완료 시 정리 · 실패를 삼키지 않기)이 **두 곳에서 갈린다.** 그래서 «무엇을 주고받나» 는
//  여기 한 벌로 두고, «어떻게 그리나» 만 화면이 각자 갖는다.
//
//  ── 경계 ────────────────────────────────────────────────────────────────────
//  이 파일은 **DOM 을 모른다.** 서버와 주고받고, 화면이 준 콜백(InlineLoginView)으로 알린다.
//  판정·파싱의 정본은 **서버** `src/terminal/ai-login-flow.ts` 다 — 여기서 출력 형식을 다시 짐작하지 않는다.
import { api } from './net.js';
import { sessionTermUrl } from './session-open.js';

/**
 * 주소·코드 두 값으로 **터미널 없이** 끝나는 하네스.
 *
 *  ⚠ 서버 `AI_LOGIN_HARNESSES` 와 **같은 목록**이어야 한다. 어긋나면 조용히 깨진다 —
 *   여기 켜 놓고 서버가 거부하면 «시작하지 못했어요», 여기 빠뜨리면 되는 걸 새 탭으로 보낸다.
 *  ⚠ 그리고 이 목록에 하네스를 더할 때는 **그 화면의 걸음 칸(주소가 뜰 자리)도 함께** 만들어야 한다.
 *   실측(#2477): grok 을 목록에만 켜고 스테퍼를 안 만들어, 버튼을 눌러도 아무 일도 안 일어났다(오류도 없다).
 */
export const AI_LOGIN_INLINE: Readonly<Record<string, true>> = Object.freeze({
  codex: true, claude: true, grok: true,
});

export function isInlineCardHarness(h: string): boolean {
  return AI_LOGIN_INLINE[h] === true;
}

/** 화면이 채워 주는 자리 — 이 파일은 이것만 부른다(DOM 은 화면 몫). */
export interface InlineLoginView {
  /** 브라우저에서 열 주소가 왔다(같은 주소로 여러 번 불릴 수 있다 — 화면이 걸러 쓴다). */
  url(url: string): void;
  /** 보여 줄 일회용 코드가 왔다(codex·grok). */
  code(code: string): void;
  /** 사람이 받아 온 코드를 **되돌려 넣어야** 한다(claude) — 입력칸을 연다. */
  needsPaste(): void;
  /** 자격 확인이 «됐다» 고 답했다. 프로세스 종료와는 다른 사실이다. */
  done(): void;
  /** 사람에게 그대로 보여줄 실패 한 줄. */
  failed(message: string): void;
  /** 주소가 상한(30초)을 넘도록 안 왔다 — **기다림은 계속된다**(화면을 지우지 말 것). */
  stalled(): void;
}

export interface InlineLoginHandle {
  /** 사람이 받아 온 코드를 넣는다(claude). */
  paste(code: string): Promise<void>;
  /** 폴링을 멈춘다(화면이 사라질 때). 서버 절차는 건드리지 않는다. */
  stop(): void;
}

/** 주소가 이만큼 안 오면 «늦네요» 라고 말한다 — 그래도 **계속 기다린다**. */
export const STALL_MS = 30_000;
/** 상태 폴링 간격. */
const TICK_MS = 2_000;

/**
 * 로그인 절차를 띄우고 상태를 폴링한다.
 *
 *  ⚠ `restart` 가 필요한 이유(실측 2026-08-28): 사람이 브라우저에서 **막히는** 경우가 있다 — 예컨대 ChatGPT
 *   계정에 «Codex용 장치 코드 인증» 이 꺼져 있으면 그 코드가 거기서 죽는다. 그런데 우리 프로세스는 15분을
 *   더 기다리므로, 설정을 켜고 다시 눌러도 start 는 «이미 돌고 있다» 며 **죽은 코드를 그대로 다시 보여 준다.**
 *   다시 시도는 반드시 새로 띄워야 한다.
 *  ⚠ 시작에 실패해도 **던지지 않는다.** 화면이 «막다른 카드» 가 되면 안 되므로 view.failed 로 알리고,
 *   화면은 종전 «창으로 열기» 탈출로를 그대로 두면 된다.
 */
export function startInlineAiLogin(
  harness: string, view: InlineLoginView, opts: { restart?: boolean; alive?: () => boolean } = {},
): InlineLoginHandle {
  let stopped = false;
  const alive = (): boolean => !stopped && (opts.alive ? opts.alive() : true);
  let lastUrl = ''; let lastCode = ''; let saidPaste = false;
  let saidStall = false; let saidDone = false;
  const startedAt = Date.now();

  const tick = async (): Promise<void> => {
    if (!alive()) return;
    let st: Record<string, unknown> | null = null;
    try { st = await api(`/api/ui/me/ai-login/state?harness=${encodeURIComponent(harness)}`) as Record<string, unknown>; }
    catch (_) { /* 잠깐 못 물었다 — 다음 틱에. 조회 실패로 화면을 지우지 않는다 */ }
    if (!alive()) return;

    //  ⚠ **이미 로그인돼 있다고 «끝났다» 로 읽으면 안 된다.** 자격 판정은 «파일이 있나» 라서 만료된 자격도
    //   true 다(#1516) — [다시 로그인] 은 바로 그 상황을 위해 있는 버튼인데, 첫 조회의 true 를 완료로 읽으면
    //   눌러도 «✓ 끝났어요» 만 깜빡이고 아무것도 안 한다(실측 2026-09-01, 상민님 신고).
    //   그래서 «이번 시도의 결과» 로만 인정한다: 주소를 한 번 봤거나(사람이 브라우저에서 끝냈다),
    //   프로세스가 끝났거나(CLI 가 «이미 로그인됨» 이라며 스스로 종료했다).
    if (st && st.loggedIn === true && (lastUrl || st.exited === true)) {
      if (!saidDone) {
        saidDone = true; stopped = true;
        view.done();
        //  끝났으면 그 자리를 치운다 — 남겨 두면 다음 사람이 **만료된 코드**를 본다.
        try { await api('/api/ui/me/ai-login/cancel', { method: 'POST', body: JSON.stringify({ harness }) }); }
        catch (_) { /* 정리 실패는 사람에게 알릴 일이 아니다 */ }
      }
      return;
    }
    if (st && st.step === 'failed') {
      view.failed(String(st.error || '로그인이 실패했어요'));
      //  폴링은 **멈추지 않는다** — 사람이 브라우저에서 되살릴 수도 있고, [다시 시도]가 새로 띄울 수도 있다.
      //  다만 간격을 늘려 헛도는 조회를 줄인다.
      setTimeout(() => { void tick(); }, TICK_MS * 2);
      return;
    }
    if (st && typeof st.url === 'string' && st.url) {
      if (st.url !== lastUrl) { lastUrl = st.url; view.url(st.url); }
      if (typeof st.code === 'string' && st.code && st.code !== lastCode) { lastCode = st.code; view.code(st.code); }
      if (st.needsPaste === true && !saidPaste) { saidPaste = true; view.needsPaste(); }
    } else if (!lastUrl && !saidStall && Date.now() - startedAt > STALL_MS) {
      //  ⚠ 종전엔 이 상한이 화면을 **덮었다**(«주소가 오지 않았어요» 대체 화면). 그러다 2026-08-31 에
      //   조회가 30초 끊기자 **받은 주소와 사람이 치던 코드까지 지웠다.** 이제 사실만 알리고 계속 기다린다.
      saidStall = true; view.stalled();
    }
    setTimeout(() => { void tick(); }, TICK_MS);
  };

  void (async () => {
    try { await api('/api/ui/me/ai-login/start', { method: 'POST', body: JSON.stringify({ harness, restart: opts.restart === true }) }); }
    catch (e) { view.failed(`여기서 바로 시작하지 못했어요 — ${(e as Error)?.message || e}`); }
    void tick();
  })();

  return {
    async paste(code: string): Promise<void> {
      await api('/api/ui/me/ai-login/paste', { method: 'POST', body: JSON.stringify({ harness, code }) });
    },
    stop(): void { stopped = true; },
  };
}

/** 이 화면이 만든 로그인 세션 하나(하네스별). 두 번 만들지 않기 위해 호출자가 들고 있는다. */
export interface LoginTerminal { id: string; label: string; }

/**
 * 인라인 **터미널**용 로그인 세션을 확보한다(주소·코드로 안 끝나는 하네스 — agy·미지).
 *
 *  ⚠ **한 번만 만든다.** 누를 때마다 새로 만들면 로그인 세션이 쌓이고, 사람은 «어느 창에서 로그인한 게
 *   맞나» 를 알 수 없게 된다. 그래서 이미 있으면 그대로 돌려준다.
 */
export async function ensureLoginTerminal(
  harness: string, label: string, have: LoginTerminal | null,
  loginSession: Record<string, unknown> = { harness },
): Promise<LoginTerminal> {
  if (have) return have;
  const r = await api('/api/ui/terminal/sessions', { method: 'POST', body: JSON.stringify({
    label: `내 계정 로그인 (${label})`, rootKey: 'personal', subpath: '', flags: {}, autoApprove: false, loginProfile: true,
    ...loginSession,
  }) }) as { session?: { id?: string; label?: string } };
  const id = r && r.session && r.session.id;
  if (!id) throw new Error('세션을 받지 못했어요');
  return { id, label: (r.session && r.session.label) || label };
}

/**
 * 그 로그인 세션을 **액자에 실을** 주소(`?embed=1`).
 *  상단바·파일 탐색기가 빠진 «터미널만» 판이라 카드 안에 그대로 맞는다(#1744 — 세션 화면이 그렇게 쓴다).
 */
export function loginTerminalSrc(t: LoginTerminal): string {
  return sessionTermUrl(t.id, { label: t.label, embed: true });
}

/** 같은 세션을 **크게** 여는 주소 — 액자가 좁을 때의 탈출로(새 세션을 또 만들지 않는다). */
export function loginTerminalPopoutUrl(t: LoginTerminal): string {
  return sessionTermUrl(t.id, { label: t.label });
}

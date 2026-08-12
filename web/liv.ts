// liv.ts — 리브 화면(#1631). 홈이 대시보드 대신 이걸 띄우는 경우가 있다.
//
//  ── 이 화면이 무엇인가 ──
//  워크스페이스가 아직 굴러가지 않을 때, "지금 손볼 것"을 카드로 보여주고 **리브에게 맡기면 실제로 해 주는** 화면.
//  위쪽이 액션카드, 아래쪽이 리브와의 대화(터미널)다. 카드의 [리브에게 맡기기]는 그 세션에 프롬프트를 주입한다 —
//  그래서 **사람이 터미널을 읽을 줄 몰라도 일이 진행된다**. 이게 v0 가 웹터미널을 재사용하면서도 성립하는 이유다.
//
//  ── 판정은 여기서 하지 않는다 ──
//  무엇을 띄울지(mode)도, 무엇이 덜 됐는지(카드)도 서버가 이미 정해서 준다(GET /api/ui/me/liv).
//  화면이 자기 판정을 가지면 리브와 다른 답을 하고, 그게 #1618 이 잡아낸 실패다. 여기는 그리기만 한다.
import { api, appUrl, el } from './core.js';

// 사람이 홈을 명시적으로 고른 값. **서버 판정을 이긴다** — 내가 껐는데 자꾸 뜨면 고장으로 읽힌다.
const LIV_CHOICE_KEY = 'liv_home_choice_v1';
// 세션당 1회만 판정한다. 홈은 자주 드나드는 화면이라 매번 왕복하면 대시보드가 느려진다.
const LIV_GATE_CACHE = 'liv_home_mode_v1';

export type LivMode = 'login' | 'liv' | 'dashboard';
export interface LivFinding {
  key: string; severity: 'p0' | 'p1'; scope: 'org' | 'member';
  title: string; detail: string; href?: string; prompt?: string;
}
export interface LivStatus {
  mode: LivMode; reason: string; findings: LivFinding[]; total: number;
  context?: { isAdmin?: boolean; claudeLoggedIn?: boolean | null; nodes?: { registered: number; online: number } | null };
}

export function livChoice(): 'liv' | 'dashboard' | null {
  const v = localStorage.getItem(LIV_CHOICE_KEY);
  return v === 'liv' || v === 'dashboard' ? v : null;
}
export function livSetChoice(v: 'liv' | 'dashboard' | null): void {
  if (v) localStorage.setItem(LIV_CHOICE_KEY, v); else localStorage.removeItem(LIV_CHOICE_KEY);
  sessionStorage.removeItem(LIV_GATE_CACHE); // 선택이 바뀌면 캐시된 판정은 낡았다
}

export async function livStatus(): Promise<LivStatus> {
  const c = livChoice();
  return await api('/api/ui/me/liv' + (c ? '?choice=' + encodeURIComponent(c) : '')) as LivStatus;
}

/**
 * 홈(#/dashboard) 진입 게이트 — 리브를 띄울지 대시보드를 띄울지.
 *
 * **대시보드를 고른 사람은 왕복조차 하지 않는다**(그게 대부분의 기존 사용자다). 그 외에는 세션당 1회만
 * 서버에 묻고 sessionStorage 에 담아 둔다 — 새로고침이나 탭 이동으로 홈에 다시 와도 즉시 그려진다.
 *
 * 실패하면 **대시보드로 떨어진다**. 리브가 안 뜨는 것보다 홈이 안 열리는 게 훨씬 나쁘다.
 */
export async function livHomeGate(): Promise<LivMode> {
  if (livChoice() === 'dashboard') return 'dashboard';
  const cached = sessionStorage.getItem(LIV_GATE_CACHE);
  if (cached === 'liv' || cached === 'dashboard' || cached === 'login') return cached;
  try {
    const st = await livStatus();
    sessionStorage.setItem(LIV_GATE_CACHE, st.mode);
    return st.mode;
  } catch { return 'dashboard'; }
}

// ── 세션 부팅 ────────────────────────────────────────────────────────────────
// 리브 세션은 **한 사람당 하나**다. 이미 있으면 그걸 쓰고, 없을 때만 만든다 — 홈에 들어올 때마다 세션이
//  늘어나면 그건 청소해야 할 쓰레기가 된다. 표식은 라벨(@box_label)이다.
const LIV_LABEL = '리브';

interface TermSession { id: string; label?: string; dir?: string; owned?: boolean; node?: { id: string } }

async function findLivSession(): Promise<TermSession | null> {
  const r = await api('/api/ui/terminal/sessions') as { sessions?: TermSession[] };
  return (r.sessions ?? []).find((s) => s.label === LIV_LABEL && s.owned !== false) ?? null;
}

async function createLivSession(): Promise<TermSession> {
  const r = await api('/api/ui/terminal/sessions', {
    method: 'POST',
    body: JSON.stringify({ label: LIV_LABEL, rootKey: 'personal', subpath: 'liv', harness: 'claude', autoApprove: true }),
  }) as { session: TermSession };
  return r.session;
}

/** 리브에게 말을 건다 — 그 세션에 프롬프트를 넣고 제출한다(사람이 터미널에 타이핑한 것과 같다). */
export async function livSendPrompt(sessionId: string, text: string): Promise<void> {
  await api('/api/ui/terminal/sessions/' + encodeURIComponent(sessionId) + '/prompt',
    { method: 'POST', body: JSON.stringify({ text }) });
}

/** 리브가 처음 열릴 때 스스로 시작하는 말. 사람이 아무것도 안 눌러도 진단이 돈다(대표 결정). */
const LIV_OPENING = 'liv 스킬로 지금 내 워크스페이스를 점검하고, 제일 급한 것부터 무엇을 하면 되는지 알려줘. 내가 맡기면 네가 직접 해 줘.';

// ── 화면 ─────────────────────────────────────────────────────────────────────

export async function renderLiv(view: HTMLElement | null): Promise<void> {
  if (!view) return; // 라우터가 넘기는 $view() 는 셸이 아직 없으면 null 이다(대시보드와 같은 계약)
  view.replaceChildren();
  document.body.dataset.route = 'liv';

  const head = el('div', { class: 'liv-head' },
    el('div', { class: 'liv-title' }, el('span', { class: 'liv-dot' }), el('b', { text: '리브' })),
    el('div', { class: 'liv-head-acts' },
      el('button', {
        class: 'btn btn-sm', type: 'button', text: '대시보드로 →',
        title: '앞으로 홈은 대시보드로 엽니다. 리브는 언제든 다시 열 수 있습니다.',
        onclick: () => { livSetChoice('dashboard'); location.hash = '#/dashboard'; },
      })));

  const cards = el('div', { class: 'liv-cards' }, skeletonLine(), skeletonLine());
  const chatWrap = el('div', { class: 'liv-chat' },
    el('div', { class: 'liv-chat-head' }, el('span', { text: '리브와 대화' })),
    el('div', { class: 'liv-chat-body', id: 'liv-chat-body' }, el('div', { class: 'liv-chat-boot', text: '세션을 준비하고 있습니다…' })));

  view.append(el('div', { class: 'liv-wrap' }, head, cards, chatWrap));

  // 카드와 세션은 **독립적으로** 로드한다. 세션이 못 떠도 무엇이 문제인지는 보여야 하고,
  //  카드 조회가 느려도 대화는 먼저 시작될 수 있다(위젯 독립 실패 원칙과 같은 결).
  void fillLivCards(cards);
  void bootLivSession(chatWrap.querySelector('.liv-chat-body') as HTMLElement, cards);
}

function skeletonLine(): HTMLElement { return el('div', { class: 'liv-card liv-card-skel' }); }

async function fillLivCards(host: HTMLElement): Promise<void> {
  let st: LivStatus;
  try { st = await livStatus(); }
  catch {
    host.replaceChildren(el('div', { class: 'liv-note', text: '지금 상태를 읽지 못했습니다. 아래에서 리브에게 직접 물어보셔도 됩니다.' }));
    return;
  }
  if (!st.findings.length) {
    host.replaceChildren(el('div', { class: 'liv-note' },
      el('b', { text: '지금 손볼 것은 없습니다.' }),
      el('span', { text: ' 아래에서 리브에게 무엇이든 물어보세요.' })));
    return;
  }
  host.replaceChildren(
    el('div', { class: 'liv-cards-title', text: `지금 손볼 것 ${st.total}가지` }),
    ...st.findings.map((f) => livCard(f, host)));
}

function livCard(f: LivFinding, host: HTMLElement): HTMLElement {
  const acts = el('div', { class: 'liv-card-acts' });
  if (f.prompt) {
    acts.append(el('button', {
      class: 'btn btn-sm btn-primary', type: 'button', text: '리브에게 맡기기',
      onclick: (ev: Event) => void livDelegate(ev.currentTarget as HTMLButtonElement, f),
    }));
  }
  if (f.href) acts.append(el('a', { class: 'btn btn-sm', href: f.href, text: f.prompt ? '직접 보기' : '보러 가기' }));
  // '나중에' 는 이 화면에서 그 카드를 접어 둘 뿐, 서버에 거절로 남기지 않는다 — 거절 기록은 리브가
  //  대화에서 사람 뜻을 확인하고 남길 일이다(화면 버튼 한 번으로 영구 침묵시키면 그게 더 위험하다).
  acts.append(el('button', {
    class: 'btn btn-sm btn-ghost', type: 'button', text: '나중에',
    onclick: (ev: Event) => { (ev.currentTarget as HTMLElement).closest('.liv-card')?.remove(); if (!host.querySelector('.liv-card')) void fillLivCards(host); },
  }));
  return el('div', { class: 'liv-card liv-card-' + f.severity },
    el('div', { class: 'liv-card-title' }, el('span', { class: 'liv-card-mark', text: f.severity === 'p0' ? '!' : '·' }), el('b', { text: f.title })),
    f.detail ? el('div', { class: 'liv-card-detail', text: f.detail }) : null,
    acts);
}

// 카드에서 맡긴 일은 **대화로 이어진다** — 무엇을 시켰는지 사람이 보고, 리브의 진행도 같은 자리에서 본다.
async function livDelegate(btn: HTMLButtonElement, f: LivFinding): Promise<void> {
  const id = livSessionId;
  if (!id) { livToast('리브 세션이 아직 준비되지 않았습니다. 잠시 후 다시 눌러 주세요.'); return; }
  btn.disabled = true; const was = btn.textContent; btn.textContent = '맡기는 중…';
  try {
    await livSendPrompt(id, f.prompt as string);
    btn.textContent = '맡겼습니다';
    btn.closest('.liv-card')?.classList.add('liv-card-done');
  } catch (e) {
    btn.disabled = false; btn.textContent = was ?? '리브에게 맡기기';
    livToast(String((e as Error)?.message ?? e));
  }
}

function livToast(msg: string): void {
  const t = el('div', { class: 'liv-toast', text: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

// 지금 열려 있는 리브 세션 id — 카드 버튼이 이걸 쓴다(세션이 뜨기 전엔 null).
let livSessionId: string | null = null;

async function bootLivSession(host: HTMLElement, cards: HTMLElement): Promise<void> {
  let s: TermSession | null = null;
  let fresh = false;
  try {
    s = await findLivSession();
    if (!s) { s = await createLivSession(); fresh = true; }
  } catch (e) {
    host.replaceChildren(el('div', { class: 'liv-chat-err' },
      el('div', { text: '리브 세션을 열지 못했습니다.' }),
      el('div', { class: 'liv-chat-err-detail', text: String((e as Error)?.message ?? e) })));
    void cards; // 카드는 그대로 둔다 — 세션이 없어도 무엇이 문제인지는 보인다
    return;
  }
  livSessionId = s.id;

  // 터미널은 iframe 으로 붙인다(#745 그리드 뷰어와 같은 문법) — 터미널 화면 코드를 두 벌 만들지 않는다.
  // #1169 appUrl — 프리뷰(/preview/<id>/…) 아래에서 루트 절대경로를 쓰면 오리진 루트(라이브)로 새어 프리뷰가 풀린다.
  const url = appUrl('/ui/terminal.html?session=') + encodeURIComponent(s.id) + '&label=' + encodeURIComponent(LIV_LABEL)
    + (s.node?.id ? '&node=' + encodeURIComponent(s.node.id) : '');
  host.replaceChildren(el('iframe', { class: 'liv-term', src: url, title: '리브와의 대화' }));

  // **열면 바로 진단**(대표 결정) — 방금 만든 세션에만 건다. 이미 있던 세션에 또 걸면 하던 말을 끊는다.
  if (fresh) void sendWhenReady(s.id, LIV_OPENING);
}

/**
 * 하네스가 **입력을 받을 준비가 된 뒤에** 첫 말을 넣는다.
 *
 * ⚠ 고정 지연은 못 믿는다(실측): 세션이 뜨자마자 4초 뒤 넣었더니 프롬프트가 **조용히 유실**됐다 —
 *  claude 가 이전 대화를 이어받으면(`--resume`) 기동이 훨씬 길어지는데, 그 사이에 넣은 키는 아무 데도
 *  안 남고 화면만 멀쩡해 보인다. "열면 바로 진단"이 조건부로 깨지는 셈이라 상태를 보고 넣는다.
 *  못 넣어도 화면은 살아 있다 — 사람이 직접 물으면 된다(조용히 포기하되 막지는 않는다).
 */
async function sendWhenReady(sessionId: string, text: string): Promise<void> {
  for (let i = 0; i < 40; i++) {                 // 최대 ~80초
    await new Promise((r) => setTimeout(r, 2000));
    if (livSessionId !== sessionId) return;      // 그 사이 화면을 떠났거나 다른 세션으로 바뀌었다
    try {
      const r = await api('/api/ui/terminal/sessions') as { sessions?: Array<{ id: string; agentState?: string }> };
      const st = (r.sessions ?? []).find((x) => x.id === sessionId)?.agentState;
      if (st !== 'idle' && st !== 'waiting') continue;  // 아직 기동·복원 중이다
      // ⚠ **이미 대화가 있으면 여는 말을 하지 않는다.** tmux 세션이 새로 떴다고 대화가 새 것은 아니다 —
      //  서버가 죽은 세션을 되살릴 때 claude 대화를 `--resume` 으로 이어붙인다(#1059 E, 실측으로 확인).
      //  그걸 모르고 여는 말을 또 넣으면 리브가 하던 말을 끊고 처음부터 다시 진단한다.
      //  (리브가 대화를 이어받는 것 자체는 기획 의도와 맞다 — "세션이 죽어도 리브는 이어진다".)
      const p = await api('/api/ui/terminal/sessions/' + encodeURIComponent(sessionId) + '/prompts')
        .catch(() => null) as { prompts?: unknown[] } | null;
      if (p && Array.isArray(p.prompts) && p.prompts.length) return;
      await livSendPrompt(sessionId, text).catch(() => { /* 사람이 직접 물어도 된다 */ });
      return;
    } catch { /* 조회 실패는 그냥 다음 주기에 다시 */ }
  }
}

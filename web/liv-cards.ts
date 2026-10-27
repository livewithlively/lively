// liv-cards.ts — 리브(워크스페이스 담당자)의 카드 한 벌(#1631 · #4970). 세 자리가 같은 카드를 쓴다:
//   · 리브 세션 대화창의 입력칸 바로 위(물음 — web/liv-ask-dock.ts)
//   · 리브 세션 화면의 오른쪽 «리브» 칸(편지 = 지금 손볼 것 — web/v2/panes-liv.ts)
//   · 리브 화면(#/liv, 단독 — web/liv.ts)
//  카드는 **어디에 사는지 모른다** — 리브에게 말을 거는 문(say)·입력칸에 담기만 하는 문(fill)·다시 그리기(refresh)를 받아서 쓴다.
//  종전(#4032)엔 이 카드들이 리브 탭의 대화 칸(liv-chat.ts)에 묶여 그 칸 안의 입력칸만 만졌다. 리브가 보통 세션 화면으로 옮겨 가며
//  (#4970 «리브 = 세션 하나») 문을 밖에서 받게 했다 — 자리마다 «리브에게 말을 거는 길» 이 다르다(대화창이 바로 옆 · 서버로 넣기).
//
//  ── 판정은 여기서 하지 않는다 ──
//  무엇이 덜 됐는지(카드)는 서버가 이미 정해서 준다(GET /api/ui/me/liv). 화면이 자기 판정을 가지면 리브와 다른 답을 하고,
//  그게 #1618 이 잡아낸 실패다. 여기는 그리기만 한다.
import { api, el, state } from './core.js';
import { bindCtx } from './v2/ctx-registry.js';   // #3784 리브 카드 우클릭
import { copyText } from './v2/ctx-menu.js';
import { rowView, type ConnectAppIn } from './lib/connect-routes-view.js';   // #4970 — 앱 한 줄 말은 [외부 앱 연결] 목록과 한 벌

export type LivMode = 'login' | 'liv' | 'dashboard';
export interface LivFinding {
  key: string; severity: 'p0' | 'p1'; scope: 'org' | 'member';
  title: string; detail: string; href?: string; prompt?: string;
}
/**
 * 리브가 지금 사람에게 받아야 하는 것 하나. **값은 여기 오지 않는다** — 무엇이 필요한지만 온다.
 *
 * 이게 있으면 화면이 안전 입력칸을 띄운다. 그 값은 곧바로 금고로 가고 대화에는 남지 않는다.
 * (그래서 리브가 "시크릿을 여기 붙여넣어 주세요"라고 하거나 다른 탭으로 보낼 일이 없어진다.)
 */
export interface LivSecretAsk {
  kind?: 'secret' | 'choice' | 'upload';
  collector_id?: number; field?: string; label?: string; why?: string; hint?: string;
  /** 객관식 — 사람은 고르기만 하고, 그 답이 통계 축(key)으로 쌓인다. */
  key?: string; question?: string; multi?: boolean; allow_other?: boolean;
  options?: Array<{ id: string; label: string; hint?: string }>;
  /** 업로드 — 어떤 파일을 올리면 되는지 한 줄. */
  accept_hint?: string;
}

export interface LivStatus {
  mode: LivMode; reason: string; findings: LivFinding[]; total: number;
  context?: { isAdmin?: boolean; claudeLoggedIn?: boolean | null; nodes?: { registered: number; online: number } | null };
  secretAsk?: LivSecretAsk | null;
}

export async function livStatus(): Promise<LivStatus> {
  return await api('/api/ui/me/liv') as LivStatus;
}

// ── 현황 되묻기 한 줄 — 같은 화면의 여러 자리(대화창 물음 자리 · 오른쪽 «리브» 칸)가 **한 번** 묻고 같은 답을 나눠 받는다 ──
//  리브가 대화 중에 물음을 걸면(me_liv_ask_*) 화면이 그걸 알아야 입력칸이 뜬다. 터미널·대화는 서버 상태를 신호로 주지 않으므로
//  가볍게 되묻는다(종전 리브 화면과 같은 6초). 보이는 자리가 하나도 없으면 묻지 않는다(숨은 탭은 DOM 이 살아 있어도 쉰다).
const POLL_MS = 6000;
interface LivWatch { fn: (st: LivStatus | null) => void; visible: () => boolean; alive?: () => boolean }
const watches = new Set<LivWatch>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let asking: Promise<void> | null = null;

function askNow(): Promise<void> {
  if (!asking) {
    asking = livStatus().then((st) => st, () => null)
      .then((st) => { for (const w of [...watches]) { try { w.fn(st); } catch (e) { console.warn('[liv] 현황 받기 실패', e); } } })
      .finally(() => { asking = null; });
  }
  return asking;
}

/**
 * 리브 현황을 받는다 — 붙자마자 한 번, 그 뒤 보이는 동안 6초마다. 돌려주는 함수로 끊는다(마지막이 끊으면 되묻기도 멈춘다).
 *  alive — 주면 매 판 묻는다: 거짓이면(그 자리가 화면에서 떨어졌다) 스스로 끊는다. 끊을 손잡이를 쥘 데가 없는 화면(라우터가 통째로 갈아 끼우는 리브 화면)용.
 */
export function watchLivStatus(fn: (st: LivStatus | null) => void, visible: () => boolean, alive?: () => boolean): () => void {
  const w: LivWatch = { fn, visible, alive };
  const off = (): void => {
    watches.delete(w);
    if (!watches.size && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };
  watches.add(w);
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      for (const x of [...watches]) { try { if (x.alive && !x.alive()) { watches.delete(x); } } catch { watches.delete(x); } }
      if (!watches.size) { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } return; }
      if ([...watches].some((x) => { try { return x.visible(); } catch { return false; } })) void askNow();
    }, POLL_MS);
  }
  void askNow();
  return off;
}

/** 지금 다시 묻는다 — 카드가 답을 보냈거나 물음을 접은 뒤. */
export function pokeLivStatus(): void { void askNow(); }

/** 카드가 바깥에서 받는 문. */
export interface LivHooks {
  /** 리브에게 한 마디 건넨다 — 카드가 답을 전했거나(객관식·자격·올리기) 일을 맡겼을 때(편지의 [제가 해 드릴게요]). */
  say(text: string): void;
  /** 입력칸에 **담기만** 한다(보내지 않는다) — 조용한 날의 «이런 것도 부탁하실 수 있어요»·우클릭 «리브에게 이 건 묻기». 없으면 say 를 쓴다. */
  fill?(text: string): void;
  /** 카드가 제출 뒤 자기 자리를 다시 그린다. */
  refresh(): void;
  /** 리브가 지금 일하는 중인가 — 그러면 «드릴 말씀이 없습니다» 대신 «일하는 중» 을 쓴다. */
  working?(): boolean;
  /** 리브가 일하는 동안의 둘째 줄 — 그 자리에서 대화가 어디 있는지(기본: «끝나면 대화에서 이어서 말씀드릴게요.»). */
  workingSub?: string;
}

/** 사람이 물음 칸에 치는 중인가 — 다시 그리면 타이핑하던 값이 사라진다. */
function livAskTyping(askHost: ParentNode): boolean {
  const typing = askHost.querySelector('.liv-ask-input') as HTMLInputElement | null;
  return !!typing && (typing.value !== '' || document.activeElement === typing);
}

/**
 * 물음 자리를 다시 그리지 말아야 하나 — 치는 중이거나, **지금 떠 있는 카드가 받은 물음과 같으면** 그대로 둔다.
 *  ⚠ 같은 물음이어도 다시 그리면 사람이 눌러 둔 선택(복수 선택의 고른 것)·올리던 파일 칸이 6초마다 지워진다(실측 2026-10-26:
 *   노션·슬랙을 고르고 몇 초 뒤 다 풀렸다). 물음이 바뀌었거나 없어졌을 때만 갈아 끼운다.
 */
export function livAskKeep(askHost: ParentNode, ask: LivSecretAsk | null | undefined): boolean {
  if (livAskTyping(askHost)) return true;
  const cur = askHost.querySelector('.liv-ask') as HTMLElement | null;
  return !!cur && !!ask && cur.dataset.ask === JSON.stringify(ask);
}

/** 리브가 기다리는 물음 카드 — 없으면 null. 이게 떠 있으면 리브는 그걸 기다리느라 멈춰 있다. */
export function livAskCard(ask: LivSecretAsk | null | undefined, hooks: LivHooks): HTMLElement | null {
  if (!ask) return null;
  const card = ask.kind === 'choice' ? livChoiceCard(ask, hooks)
    : ask.kind === 'upload' ? livUploadCard(ask, hooks)
      : livSecretCard(ask, hooks);
  card.dataset.ask = JSON.stringify(ask);   // livAskKeep 이 «같은 물음» 을 가르는 표
  return card;
}

/** 편지 칸 — 지금 손볼 것이 있으면 편지, 리브가 일하는 중이면 그 한 줄, 아니면 조용한 날. */
export function livLetterBox(st: LivStatus, hooks: LivHooks, host: HTMLElement): HTMLElement {
  return st.findings.length ? livLetter(st, hooks, host) : hooks.working?.() ? livWorking(hooks) : livQuiet(hooks);
}

/** 리브가 일하는 동안의 편지(#1631) — 지금 일하고 있다는 것 한 줄, 끝나면 대화에서 이어진다는 것 한 줄. */
function livWorking(hooks: LivHooks): HTMLElement {
  return el('div', { class: 'liv-letter-quiet liv-letter-working' },
    el('p', { class: 'liv-quiet-say', text: '지금 리브가 일하고 있어요.' }),
    el('p', { class: 'liv-quiet-sub', text: hooks.workingSub || '끝나면 대화에서 이어서 말씀드릴게요.' }));
}

/** 사람 이름 — 편지는 누구에게 쓰는지가 있어야 편지다. 모르면 호칭 없이 시작한다(억지로 '고객님' 하지 않는다). */
function meName(): string {
  const m: any = (state && (state as any).me) || {};
  const n = String(m.name || m.display_name || '').trim();
  return n ? n + '님, ' : '';
}
const ORDINAL = ['하나', '둘', '셋', '넷', '다섯', '여섯'];

/**
 * 편지 — 카드 목록이 아니라 **리브가 쓴 글 한 통**(#1719 안 A · 0818 회의 §3).
 *
 * 왜 목록이 아닌가: 목록은 훑게 만들고, 훑으면 결정하지 않는다. 그리고 항목이 늘어나는 순간 그건 현황판이 된다 —
 *  이 칸이 대시보드가 되면 안 된다는 것이 대표 결정이다. 글은 끝까지 읽히거나 안 읽히거나 둘 중 하나라
 *  "몇 개인지"가 아니라 "무엇을 할지"가 남는다.
 * 어조 규칙 하나: **1인칭**이다. "제가 켜 드릴게요"는 제안이고 "설정을 켜세요"는 훈수다 — 주어를 바꾸면
 *  리브가 못 하는 일은 문장이 아예 안 만들어진다(훈수 차단이 문법에서 이뤄진다).
 */
function livLetter(st: LivStatus, hooks: LivHooks, host: HTMLElement): HTMLElement {
  const n = st.findings.length;
  const lead = n === 1
    ? `${meName()}지금 한 가지가 걸립니다.`
    : `${meName()}지금 ${n}가지가 걸립니다.`;
  return el('article', { class: 'liv-letter-body' },
    el('p', { class: 'liv-lead', text: lead }),
    ...st.findings.map((f, i) => livPara(f, i, n, hooks, host)),
    el('p', { class: 'liv-sign' }, el('span', { text: '— 리브' })));
}

/** 편지의 한 문단 = 제안 하나. 무엇을 봤는지(제목·설명) + 제가 하겠다(버튼)까지가 한 덩어리다. */
function livPara(f: LivFinding, i: number, total: number, hooks: LivHooks, host: HTMLElement): HTMLElement {
  const fill = (t: string): void => (hooks.fill ? hooks.fill(t) : hooks.say(t));
  const acts = el('div', { class: 'liv-para-acts' });
  if (f.prompt) {
    acts.append(el('button', {
      class: 'btn btn-sm btn-primary', type: 'button', text: '제가 해 드릴게요',
      title: '이 일을 제가 대신 합니다 — 무엇을 했는지 대화에 그대로 남습니다.',
      onclick: (ev: Event) => livDelegate(ev.currentTarget as HTMLButtonElement, f, hooks),
    }));
  }
  if (f.href) acts.append(el('a', { class: 'btn btn-sm', href: f.href, text: f.prompt ? '직접 볼게요' : '보러 가기' }));
  acts.append(el('button', {
    class: 'btn btn-sm btn-ghost', type: 'button', text: '나중에',
    // '나중에'는 이 화면에서 그 문단을 접어 둘 뿐, 서버에 거절로 남기지 않는다 — 거절 기록은 리브가
    //  대화에서 사람 뜻을 확인하고 남길 일이다(버튼 한 번으로 영구 침묵시키는 건 더 위험하다).
    onclick: (ev: Event) => {
      (ev.currentTarget as HTMLElement).closest('.liv-para')?.remove();
      if (!host.querySelector('.liv-para')) hooks.refresh();
    },
  }));
  const para = el('div', { class: 'liv-para liv-para-' + f.severity },
    total > 1 ? el('span', { class: 'liv-para-no', text: ORDINAL[i] ?? String(i + 1) }) : null,
    el('div', { class: 'liv-para-b' },
      el('p', { class: 'liv-para-t', text: f.title }),
      f.detail ? el('p', { class: 'liv-para-d', text: f.detail }) : null,
      acts));
  // #3784 우클릭 — 문단의 단추 셋과 같은 일 + 복사 · 리브에게 이 건 묻기
  bindCtx(para, () => ({
    title: f.title, sub: f.severity ? '리브의 제안 · ' + f.severity : '리브의 제안',
    rows: [
      ...(f.prompt ? [{ label: '제가 해 드릴게요', icon: 'bolt', run: () => { (acts.querySelector('.btn-primary') as HTMLButtonElement | null)?.click(); } }] : []),
      ...(f.href ? [{ label: f.prompt ? '직접 볼게요' : '보러 가기', icon: 'open', run: () => { location.hash = f.href!; } }] : []),
      { label: '리브에게 이 건 묻기', icon: 'ask', run: () => fill(`「${f.title}」 — 이건 어떻게 하면 좋을까요?`) },
      { sep: true, label: '' },
      { label: '내용 복사', icon: 'copy', run: () => void copyText([f.title, f.detail || ''].filter(Boolean).join('\n')).then((ok) => { if (ok) livToast('복사했어요'); }) },
      { sep: true, label: '' },
      { label: '나중에', icon: 'clock', run: () => { (acts.querySelector('.btn-ghost') as HTMLButtonElement | null)?.click(); } },
    ],
  }));
  return para;
}

/**
 * 할 말이 없는 날 — **이 칸의 기본 상태**다(1년의 대부분).
 *
 * 여길 목록으로 채우고 싶은 유혹이 곧 대시보드로 되돌아가는 길이다. 대신 **부탁할 수 있는 것**을 세 줄 둔다 —
 * 처음 온 사람에게는 이게 곧 사용법이고, 오래 쓴 사람에게는 "지금 조용하다"는 사실 자체가 정보다.
 * (누르면 그 말이 입력칸에 담긴다 — 보내지는 않는다. 고치고 보내는 건 사람 몫이다. 입력칸이 없는 자리면 리브에게 건넨다.)
 */
function livQuiet(hooks: LivHooks): HTMLElement {
  const say = (t: string): HTMLElement => el('button', {
    class: 'liv-can-row', type: 'button', onclick: () => (hooks.fill ? hooks.fill(t) : hooks.say(t)),
  }, el('span', { class: 'liv-can-mark', 'aria-hidden': 'true', text: '·' }), el('span', { text: t }));
  return el('div', { class: 'liv-letter-quiet' },
    el('p', { class: 'liv-quiet-say', text: '오늘은 드릴 말씀이 없습니다.' }),
    el('p', { class: 'liv-quiet-sub', text: '새로 눈에 띄는 게 생기면 제가 먼저 말씀드릴게요. 그동안 무엇이든 시키셔도 됩니다.' }),
    el('div', { class: 'liv-can' },
      el('div', { class: 'liv-can-h', text: '이런 것도 부탁하실 수 있어요' }),
      say('쓰던 노션이랑 연결해 주세요'),
      say('매주 회의록을 여기 쌓고 싶어요'),
      say('지금 워크스페이스에서 손볼 게 있는지 봐 주세요')));
}

/**
 * 물음을 **치우는 길**. 이게 없으면 리브가 건 물음은 답하기 전엔 영원히 남는다 —
 * 대화 칸에 고정한 뒤로는 그게 '리브가 지금 기다리는 것'이 아니라 **영구 가구**로 보인다(대표 지적).
 * 접으면 서버가 declined 에도 남겨, 다음 대화의 리브가 곧바로 다시 묻지 않는다.
 */
function livDismissBtn(hooks: LivHooks): HTMLElement {
  return el('button', {
    class: 'btn btn-sm btn-ghost liv-ask-later', type: 'button', text: '나중에',
    title: '지금은 넘어갑니다. 리브가 이걸 다시 곧바로 묻지 않습니다.',
    onclick: async (ev: Event) => {
      const b = ev.currentTarget as HTMLButtonElement;
      b.disabled = true;
      await api('/api/ui/me/liv/ask-dismiss', { method: 'POST', body: '{}' }).catch(() => { /* 비치명 */ });
      hooks.refresh();
    },
  });
}

/**
 * 객관식 질문 — **사람은 고르기만 한다.**
 *
 * 실측에서 사람이 가장 오래 멈춘 자리가 자유서술이었다("어디에 쌓고 계셨나요?"). 없는 말을 지어내야 하니
 * 어렵고, 답이 제각각이라 우리도 개선점을 못 뽑는다. 고르게 하면 둘 다 풀린다 — 쉽고, **답이 저절로
 * 구조화된다**. 그래서 이 카드가 곧 통계 수집기다.
 */
function livChoiceCard(ask: LivSecretAsk, hooks: LivHooks): HTMLElement {
  const picked = new Set<string>();
  const opts = el('div', { class: 'liv-ask-opts' });
  //  (#5058) 종전 이름 «이걸로» 는 무엇을 하는 버튼인지 말하지 않았고, [나중에] 오른쪽이 아니라 왼쪽에 있어
  //   사람이 다 고른 뒤 오른쪽의 [나중에]를 «확인» 으로 알고 눌렀다(원준님 2026-10-27). 확정은 **오른쪽 끝**, 이름은 «선택 완료»,
  //   몇 개 골랐는지 함께 보여 준다.
  const SEND = '선택 완료';
  const send = el('button', { class: 'btn btn-sm btn-primary liv-ask-go', type: 'button', text: SEND }) as HTMLButtonElement;
  // 복수 선택이면 고른 게 있어야 보낼 수 있다. 단일 선택은 누르는 즉시 보낸다(한 번 덜 누르게).
  const sync = (): void => {
    send.disabled = picked.size === 0 && !otherIn.value.trim();
    if (!send.textContent?.endsWith('…')) send.textContent = ask.multi && picked.size > 0 ? `${SEND} (${picked.size})` : SEND;
  };

  const submit = async (): Promise<void> => {
    send.disabled = true; const was = send.textContent; send.textContent = '보내는 중…';
    try {
      const r = await api('/api/ui/me/liv-answer', {
        method: 'POST',
        body: JSON.stringify({ choices: [...picked], other: otherIn.value.trim() || undefined }),
      }) as { labels?: string[]; other?: string };
      const said = [...(r.labels ?? []), ...(r.other ? [r.other] : [])].join(', ');
      // ⚠ 비우고 포커스를 뗀다 — 안 그러면 '타이핑 중이면 갱신하지 않는다' 가드에 걸려
      //  답을 보냈는데도 질문 카드가 그대로 남는다(실측).
      otherIn.value = ''; otherIn.blur();
      livToast('고르신 걸 전했습니다.');
      // 사람이 다시 타이핑하지 않아도 대화가 이어지게 — 무엇을 골랐는지 리브에게 그대로 말해 준다.
      if (said) hooks.say(said);
      setTimeout(() => hooks.refresh(), 600);
    } catch (e) {
      send.disabled = false; send.textContent = was ?? SEND;
      livToast(String((e as Error)?.message ?? e));
    }
  };

  for (const o of ask.options ?? []) {
    const b = el('button', { class: 'btn btn-sm btn-ghost liv-opt', type: 'button' },
      el('b', { text: o.label }), o.hint ? el('span', { class: 'liv-opt-hint', text: o.hint }) : null) as HTMLButtonElement;
    b.onclick = () => {
      if (ask.multi) {
        if (picked.has(o.id)) { picked.delete(o.id); b.classList.remove('liv-opt-on'); }
        else { picked.add(o.id); b.classList.add('liv-opt-on'); }
        sync();
      } else { picked.clear(); picked.add(o.id); void submit(); }
    };
    opts.append(b);
  }

  const otherIn = el('input', {
    class: 'liv-ask-input', type: 'text', autocomplete: 'off',
    placeholder: '목록에 없으면 여기 적어 주세요', 'aria-label': '그 외',
  }) as HTMLInputElement;
  otherIn.oninput = sync;
  otherIn.onkeydown = (ev: KeyboardEvent) => { if (ev.key === 'Enter') { ev.preventDefault(); void submit(); } };
  send.onclick = () => void submit();
  sync();

  return el('div', { class: 'liv-ask' },
    el('div', { class: 'liv-ask-head' }, el('b', { text: ask.question ?? '' })),
    ask.why ? el('div', { class: 'liv-ask-why', text: ask.why }) : null,
    opts,
    // '그 외'는 탈출구다 — 여기 적히는 것이 곧 다음에 만들 커넥터 후보라 버리지 않고 쌓는다.
    ask.allow_other ? el('div', { class: 'liv-ask-row' }, otherIn) : null,
    el('div', { class: 'liv-ask-row liv-ask-acts' }, livDismissBtn(hooks), (ask.multi || ask.allow_other) ? send : null),
    ask.multi ? el('div', { class: 'liv-ask-note', text: '해당하는 걸 모두 고르셔도 됩니다.' }) : null);
}

/**
 * 파일 올리기 — **로컬 폴더를 뒤지는 대신 끌어다 놓는다**(대표 판단).
 *
 * 글자 파일만 받는다. PDF·이미지는 브라우저에서 글자를 못 뽑아 **올린 척만 하고 빈 자료가 쌓이므로**,
 * 되는 척하지 않고 그 자리에서 거른다.
 */
function livUploadCard(ask: LivSecretAsk, hooks: LivHooks): HTMLElement {
  const TEXT_RE = /\.(md|markdown|txt|csv|tsv|json|ya?ml|log|rtf|html?|tex|org)$/i;
  const msg = el('div', { class: 'liv-ask-msg' });
  const input = el('input', { class: 'liv-upload-in', type: 'file', multiple: 'multiple' }) as HTMLInputElement;

  input.onchange = async (): Promise<void> => {
    const files = [...(input.files ?? [])];
    if (!files.length) return;
    const ok = files.filter((f) => TEXT_RE.test(f.name));
    const skipped = files.filter((f) => !TEXT_RE.test(f.name));
    input.disabled = true;
    let saved = 0; const failed: string[] = [];
    for (const f of ok) {
      try {
        const body_md = await f.text();
        if (!body_md.trim()) { failed.push(`${f.name}(비어 있음)`); continue; }
        await api('/api/ui/sources', { method: 'POST', body: JSON.stringify({
          kind: 'upload', title: f.name, body_md,
          occurred_at: new Date(f.lastModified).toISOString(),
        }) });
        saved++;
      } catch (e) { failed.push(`${f.name}(${(e as Error)?.message ?? e})`); }
    }
    input.disabled = false; input.value = '';
    const parts = [`${saved}개 올렸습니다`];
    if (skipped.length) parts.push(`${skipped.length}개는 글자 파일이 아니라 건너뛰었습니다`);
    if (failed.length) parts.push(`${failed.length}개 실패`);
    msg.replaceChildren(el('span', { class: failed.length ? 'liv-ask-err' : 'liv-ask-ok', text: parts.join(' · ') }));
    if (saved) {
      hooks.say(`파일 ${saved}개 올렸어요: ${ok.slice(0, 10).map((f) => f.name).join(', ')}`);
      setTimeout(() => hooks.refresh(), 1200);
    }
  };

  return el('div', { class: 'liv-ask' },
    el('div', { class: 'liv-ask-head' }, el('b', { text: ask.label ?? '파일 올리기' })),
    ask.why ? el('div', { class: 'liv-ask-why', text: ask.why }) : null,
    el('div', { class: 'liv-ask-row' }, input),
    el('div', { class: 'liv-ask-row' }, livDismissBtn(hooks)),
    el('div', { class: 'liv-ask-note', text: ask.accept_hint || '글자로 된 파일만 됩니다 — 메모·문서(.txt·.md)·표(.csv) 등. PDF·이미지는 아직 안 됩니다.' }),
    msg);
}

/**
 * 자격 입력칸 — **이 화면에서 끝내기 위한 장치**.
 *
 * 실측 2회 모두 리브는 시크릿을 채팅에 붙여넣으라고 했고(대화 기록에 남는다), 화면으로 돌릴 때는
 * 없는 메뉴 경로를 지어냈다. 안내를 다듬어 고칠 문제가 아니라 **여기서 받을 자리가 없던 것**이 원인이다.
 *
 * 계약: 넣을 자리는 서버가 저장해 둔 요청에서만 온다(브라우저가 대상을 못 바꾼다). 값은 전송 즉시
 * 암호화 저장되고 화면에서도 지운다. 저장되면 리브에게 **사람 대신 한 마디 건네** 대화가 이어진다.
 */
function livSecretCard(ask: LivSecretAsk, hooks: LivHooks): HTMLElement {
  const input = el('input', {
    class: 'liv-ask-input', type: 'password', autocomplete: 'off', spellcheck: 'false',
    placeholder: ask.hint || '여기에 붙여넣어 주세요', 'aria-label': ask.label,
  }) as HTMLInputElement;
  const msg = el('div', { class: 'liv-ask-msg' });
  const save = el('button', { class: 'btn btn-sm btn-primary liv-ask-go', type: 'button', text: '저장' }) as HTMLButtonElement;

  const submit = async (): Promise<void> => {
    const value = input.value;
    if (!value.trim()) { input.focus(); return; }
    save.disabled = true; input.disabled = true; save.textContent = '저장 중…';
    try {
      await api('/api/ui/me/liv-secret', { method: 'POST', body: JSON.stringify({ value }) });
      input.value = '';  // 화면에서도 즉시 지운다
      // ⚠ 확인은 **카드 밖**(토스트)에 띄운다 — 카드 안에 쓰면 바로 뒤의 갱신이 카드째 지워서
      //  사람은 아무 일도 안 일어난 것처럼 본다(실측: 저장은 됐는데 화면엔 흔적이 없었다).
      livToast('저장했습니다. 리브가 이어서 확인합니다.');
      // 사람이 다시 타이핑하지 않아도 대화가 이어지게 한마디 건넨다 — 값은 절대 안 보낸다.
      hooks.say('자격 저장했어요. 확인해 주세요.');
      setTimeout(() => hooks.refresh(), 600);
    } catch (e) {
      save.disabled = false; input.disabled = false; save.textContent = '저장';
      msg.replaceChildren(el('span', { class: 'liv-ask-err', text: String((e as Error)?.message ?? e) }));
      input.focus();
    }
  };
  save.onclick = () => void submit();
  input.onkeydown = (ev: KeyboardEvent) => { if (ev.key === 'Enter') { ev.preventDefault(); void submit(); } };

  return el('div', { class: 'liv-ask' },
    el('div', { class: 'liv-ask-head' }, el('b', { text: ask.label })),
    ask.why ? el('div', { class: 'liv-ask-why', text: ask.why }) : null,
    el('div', { class: 'liv-ask-row' }, input),
    el('div', { class: 'liv-ask-row liv-ask-acts' }, livDismissBtn(hooks), save),
    el('div', { class: 'liv-ask-note', text: '입력하신 값은 잠긴 보관함으로 바로 들어가고, 대화 기록에는 남지 않습니다.' }),
    msg);
}

// 카드에서 맡긴 일은 **대화로 이어진다** — 무엇을 시켰는지 사람이 보고, 리브의 진행도 같은 자리에서 본다.
function livDelegate(btn: HTMLButtonElement, f: LivFinding, hooks: LivHooks): void {
  hooks.say(f.prompt as string);
  btn.disabled = true;
  btn.textContent = '맡겼습니다';
  btn.closest('.liv-card')?.classList.add('liv-card-done');
}

export function livToast(msg: string): void {
  const t = el('div', { class: 'liv-toast', text: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

// ── 외부 앱 연결 상태 한 줄씩 — 서버 org_connect_status 그대로(화면이 판정하지 않는다). 말은 [외부 앱 연결] 목록과 한 벌 ──
type ConnectApp = ConnectAppIn;

/** 외부 앱 연결 상태를 host 에 그린다. 못 읽으면 그렇다고 한 줄. */
/** onPick — 주면 줄이 링크가 아니라 단추다: 누르면 그 앱의 일을 부른 쪽(리브 세션의 «리브» 칸)에 넘긴다(#5058). */
export async function fillConnectApps(host: HTMLElement, onPick?: (app: { app: string; label: string; bucket: string }) => void): Promise<void> {
  try {
    const r: any = await api('/api/ui/org/connect-status');
    const apps: ConnectApp[] = Array.isArray(r?.apps) ? r.apps : [];
    host.replaceChildren(...(apps.length ? apps.map((a) => connectAppRow(a, onPick)) : [el('p', { class: 'pn-fine', text: '연결할 수 있는 앱이 없어요.' })]));
  } catch (_) {
    host.replaceChildren(el('p', { class: 'pn-fine', text: '연결 상태를 읽지 못했어요.' }));
  }
}

/** 앱 한 줄 — 이름 · 지금 어떻게 연결돼 있나(사람 말) · 누르면 그 앱의 연결 화면. 말은 [외부 앱 연결] 목록과 같다(lib/connect-routes-view). */
function connectAppRow(a: ConnectApp, onPick?: (app: { app: string; label: string; bucket: string }) => void): HTMLElement {
  const v = rowView(a);
  const kids = [el('span', { class: 'liv-app-n', text: a.label || a.app }), el('span', { class: 'liv-app-s', text: v.word })];
  if (onPick) {
    return el('button', { type: 'button', class: 'liv-app liv-app-' + v.bucket,
      onclick: () => onPick({ app: a.app, label: a.label || a.app, bucket: v.bucket }) }, ...kids);
  }
  return el('a', { class: 'liv-app liv-app-' + v.bucket, href: '#/connect/' + encodeURIComponent(a.app) }, ...kids);
}

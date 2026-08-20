// chat-view.ts — 대화창 **하나**(#1719). 리브(web/liv-chat.ts)와 세션 화면(web/session-chat.ts)이 같은 컴포넌트를 쓴다.
//
//  ── 왜 떼어냈나 ──
//  리브 대화창(#1631 v1)은 "터미널 대신 말풍선"을 이미 풀었다 — 일지 형태(사람 말은 제목처럼, AI 가 한 일은 세로 괘선에),
//  작업 슬립(무엇을 보냈고 무엇이 돌아왔는지 접힘), 조각 스트리밍, 읽고 있으면 잡아채지 않는 스크롤, IME 안전 Enter, Esc 멈춤.
//  세션 화면(라이브 Claude Code 세션)도 **같은 문법의 데이터**(assistant/user 메시지의 text·tool_use·tool_result 블록)라
//  같은 그림이 맞다. 두 벌을 두면 한쪽만 고쳐진다 — 그래서 그림·입력·스크롤은 여기 한 곳에, **어디서 읽고 어디로 보내나**만
//  호출자가 다르다(리브: me/liv/turn 파일 · 세션: 박스의 대화 파일 + 프롬프트 주입).
//
//  ── 이 파일이 아는 것 / 모르는 것 ──
//  안다: 이벤트 한 줄(claude stream-json / Claude Code 트랜스크립트 한 줄)을 받아 어느 턴의 어디에 무엇을 그릴지.
//  모른다: 그 줄이 어디서 오는지(파일·API), 언제 폴링하는지, 보내기가 무엇을 하는지 — 전부 opts 콜백.
//
//  ── 지키는 것(리브에서 물려받은 원칙, 그대로) ──
//  · 사람이 읽고 있으면 스크롤을 잡아채지 않는다(바닥에 붙어 있을 때만 따라간다 + 돌아가는 버튼).
//  · 한글 입력 중 Enter 는 전송이 아니다(isComposing — 레포 불변식).
//  · 실패를 조용히 삼키지 않는다 — 그 자리에 말한다.
//  · 원문(도구 입출력)은 버리지 않고 접는다 — 펼치면 그게 '진짜 했다'의 증거.
//  · innerHTML 을 쓰지 않는다(모델 출력을 그린다 — 마크다운도 textContent 기반 렌더러 lib/markdown.ts).
//  클래스 이름은 리브 시절의 `livc-*` 를 그대로 둔다(35-liv.css 가 이미 그 이름으로 그린다 — 접두어를 바꾸면 얻는 게 없다).
import { el, renderMarkdown, toast } from './core.js';
import { toolGroupSummary } from './chat-tool-group.js';

/** 도구 이름 → 사람 말. label 은 필수, detail 은 한 줄 요약(경로·명령 — Claude Code 의 `Read(src/x.ts)` 자리). */
export interface ToolLabel { label: string; detail?: string }

export interface ChatViewOpts {
  who: { me: string; ai: string };                 // 이름표(위치가 아니라 이름으로 화자를 밝힌다)
  placeholder: string;
  busyPlaceholder?: string;                        // 답을 기다리는 동안 입력칸이 말할 것(sendWhileBusy=false 일 때)
  toolLabel: (name: string, input: unknown) => ToolLabel;
  thinking: 'hide' | 'fold';                       // 생각(thinking) 블록 — 리브는 숨기고, 세션은 접힌 카드로
  sendWhileBusy: boolean;                          // 도는 동안에도 보낼 수 있나(세션은 큐잉되므로 true · 리브는 이어받기가 꼬여 false)
  onSend: (text: string) => void | Promise<void>;
  onStop?: () => void | Promise<void>;             // 없으면 멈춤 버튼·Esc 가 없다
  escActive?: () => boolean;                       // Esc 를 이 화면이 받을 상황인가(리브: 리브 화면일 때만)
  opening?: HTMLElement | null;                    // 빈 화면(첫 대화 전) — 없으면 아무것도 안 그린다
  askHost?: HTMLElement | null;                    // 리브의 물음이 앉는 자리(입력 바로 위)
  footer?: HTMLElement | null;                     // 입력칸 대신 앉힐 것(끝난 세션의 '이어서 대화하기' 바 등)
  /**
   * 그림 방식.
   *  · journal(기본) — 리브(#1631): 사람 말은 제목처럼, AI 가 한 일은 세로 괘선에, 이름표로 화자를 밝힘, 도구는 슬립 한 장씩.
   *  · desktop — Claude Desktop(Claude Code) 문법(#1719 상민님 지시): 내 말은 오른쪽 회색 말풍선, AI 는 왼쪽에 이름표 없이 글만,
   *    **연속된 도구 사용은 한 줄로 접음**("도구 N개 사용함 ›" — 펼치면 하나씩), 도는 중엔 ✻ 표식, 입력칸은 둥근 상자 + 아래 얇은 바.
   */
  style?: 'journal' | 'desktop';
  bar?: { left?: HTMLElement | null; right?: HTMLElement | null };   // desktop 입력칸 아래 바에 앉힐 것(모드·모델 등 — 호출자가 채움)
}

/** 한 턴을 그리는 동안 들고 있는 것 — 조각(스트리밍)과 완성본이 **같은 글**이라 겹치지 않게 하는 게 핵심. */
interface TurnRender {
  cards: Map<string, HTMLElement>;
  blocks: Map<number, { el: HTMLElement; buf: string }>;
  msgId: string | null;
  streamed: Set<string>;
}
export interface ChatTurn {
  root: HTMLElement; work: HTMLElement; ask: HTMLElement | null;
  text: string; ts?: string; r: TurnRender; live: HTMLElement | null; startedAt: number;
}

export interface ChatView {
  root: HTMLElement; list: HTMLElement; input: HTMLTextAreaElement; form: HTMLFormElement; noteEl: HTMLElement;
  /** 새 턴(사람 말 한 마디). userText=null 이면 사람 말 없이 AI 가 한 일만(창을 중간부터 읽을 때). */
  turn(userText: string | null, opts?: { ts?: string; at?: 'end' | 'start' }): ChatTurn;
  /** 완성본 이벤트(assistant/user 메시지)를 그 턴에 반영. text=그 줄에 AI 의 글이 있었나. */
  event(t: ChatTurn, ev: any): { text?: string };
  /** 조각(stream_event) — 글자가 오는 대로. */
  stream(t: ChatTurn, ev: any): void;
  /** 그 턴 끝 — 흘러오던 덩이를 마감하고 상태점을 끈다. */
  settle(t: ChatTurn, o?: { exit?: number | null; interrupted?: boolean; durationMs?: number }): void;
  /** 이 턴이 '지금 도는 중'임을 표시(깜빡이는 점 + 경과 시간 줄). */
  running(t: ChatTurn | null): void;
  busy(on: boolean): void;
  scroll(): void;
  scrollToBottom(): void;
  setNote(text: string): void;
  error(t: ChatTurn | null, text: string): void;
  divider(text: string, details?: string, at?: 'end' | 'start'): void;
  removeOpening(): void;
  setFooter(f: HTMLElement | null): void;
  turns(): ChatTurn[];
  /** 위에 끼워 넣기(이전 기록 불러오기) — 보고 있던 자리를 지킨다. */
  prependKeepingView(fn: () => void): void;
  destroy(): void;
}

// ── 조각 렌더 ────────────────────────────────────────────────────────────────────────────

/** 작업 슬립 — 이 화면의 시그니처. 상태는 색이 아니라 표식과 글자로(●하는 중 / ✓했음 / ✕실패). */
function actionCard(lab: ToolLabel, input: unknown): HTMLElement {
  return el('div', { class: 'livc-slip' },
    el('div', { class: 'livc-slip-head' },
      el('span', { class: 'livc-slip-mark livc-slip-run', 'aria-hidden': 'true', text: '●' }),
      el('span', { class: 'livc-slip-name', text: lab.label }),
      lab.detail ? el('span', { class: 'livc-slip-detail', title: lab.detail, text: lab.detail }) : null,
      el('details', { class: 'livc-slip-raw' },
        el('summary', { text: '자세히' }),
        rawPart('보낸 것', pretty(input))),
      el('span', { class: 'livc-slip-state', text: '하는 중' })));
}
function pretty(v: unknown): string {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v ?? {}, null, 2); } catch { return String(v); }
}
function rawPart(cap: string, body: string): HTMLElement {
  const s = String(body ?? '');
  return el('div', { class: 'livc-raw-part' },
    el('div', { class: 'livc-raw-cap', text: cap + (s.length > 4000 ? ` · 앞 4,000자` : '') }),
    el('pre', { text: s.slice(0, 4000) }));
}
function finishCard(card: HTMLElement, output: string, isError: boolean): void {
  const mark = card.querySelector('.livc-slip-mark');
  if (mark) { mark.classList.remove('livc-slip-run'); mark.textContent = isError ? '✕' : '✓'; }
  const state = card.querySelector('.livc-slip-state');
  if (state) state.textContent = isError ? '실패' : '했음';
  card.classList.add(isError ? 'livc-slip-err' : 'livc-slip-done');
  card.querySelector('.livc-slip-raw')?.append(rawPart(isError ? '무엇이 잘못됐는지' : '돌아온 것', output));
}
/** 끝난 세션의 기록을 되그릴 때 — 결과가 창 밖(이전 창)에 있어 못 받은 카드는 '하는 중'으로 남기지 않는다. */
function settleCard(card: HTMLElement): void {
  const mark = card.querySelector('.livc-slip-mark');
  if (mark) { mark.classList.remove('livc-slip-run'); mark.textContent = '·'; }
  const state = card.querySelector('.livc-slip-state');
  if (state) state.textContent = '';
}

/** AI 가 한 말 한 덩이 — 마크다운(textContent 기반, XSS 없음). 코드 블록엔 복사 버튼을 단다. */
function said(text: string): HTMLElement {
  const box = el('div', { class: 'livc-said' }, renderMarkdown(text));
  decorateCode(box);
  return box;
}
function decorateCode(box: HTMLElement): void {
  box.querySelectorAll('pre').forEach((pre) => {
    if (pre.parentElement?.classList.contains('livc-code')) return;
    const wrap = el('div', { class: 'livc-code' });
    pre.replaceWith(wrap);
    const btn = el('button', {
      class: 'livc-copy', type: 'button', text: '복사', 'aria-label': '코드 복사',
      onclick: async () => {
        try { await navigator.clipboard.writeText(pre.textContent || ''); btn.textContent = '복사됨'; setTimeout(() => { btn.textContent = '복사'; }, 1200); }
        catch { toast('복사하지 못했습니다 — 직접 선택해 복사해 주세요.'); }
      },
    });
    wrap.append(pre, btn);
  });
}

/** 생각(thinking) 블록 — 접힌 카드. Claude Code 의 "✻ Thinking…" 자리. 글자 수만 머리에 보이고 본문은 펼쳐야 보인다. */
function thinkCard(text: string): HTMLElement {
  const n = text.length;
  return el('details', { class: 'livc-think' },
    el('summary', {}, el('span', { class: 'livc-think-k', text: '생각' }), el('span', { class: 'livc-think-n', text: n >= 1000 ? `${(n / 1000).toFixed(1)}천자` : `${n}자` })),
    el('div', { class: 'livc-think-body', text }));
}

const fmtClock = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso); if (!Number.isFinite(d.getTime())) return '';
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return same ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};
const fmtDur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
};

// ── 컴포넌트 ─────────────────────────────────────────────────────────────────────────────
export function createChatView(host: HTMLElement, opts: ChatViewOpts): ChatView {
  const desktop = opts.style === 'desktop';
  const list = el('div', { class: 'livc-list' });
  const input = el('textarea', { class: 'livc-input', rows: '1', placeholder: opts.placeholder, 'aria-label': opts.placeholder }) as HTMLTextAreaElement;
  // desktop: 보내기는 ⏎ 글리프 아이콘 버튼(입력 상자 안 오른쪽), 멈춤은 ■ — Claude Desktop 과 같은 자리·같은 문법.
  const send = desktop
    ? el('button', { class: 'dt-send', type: 'submit', title: '보내기 (Enter)', 'aria-label': '보내기', text: '⏎' }) as HTMLButtonElement
    : el('button', { class: 'btn btn-sm livc-send', type: 'submit', text: '보내기' }) as HTMLButtonElement;
  const stop = desktop
    ? el('button', { class: 'dt-send dt-stop', type: 'button', title: '멈춤 (Esc)', 'aria-label': '멈춤', hidden: true, text: '■' }) as HTMLButtonElement
    : el('button', { class: 'btn btn-sm livc-send livc-send-stop', type: 'button', text: '멈춤', hidden: true, title: 'Esc' }) as HTMLButtonElement;
  const note = el('div', { class: 'livc-note' });
  const form = desktop
    ? el('form', { class: 'livc-compose dt-compose' },
        el('div', { class: 'dt-box' }, input, el('div', { class: 'dt-box-acts' }, stop, send)),
        el('div', { class: 'dt-bar' }, el('div', { class: 'dt-bar-l' }, opts.bar?.left ?? undefined), el('div', { class: 'dt-bar-r' }, opts.bar?.right ?? undefined))) as HTMLFormElement
    : el('form', { class: 'livc-compose' }, input, stop, send) as HTMLFormElement;
  const footSlot = el('div', { class: 'livc-foot' }, form);

  // 스크롤 — 사람이 읽고 있으면 잡아채지 않는다.
  const NEAR_BOTTOM = 48;
  let stick = true;
  const jump = el('button', {
    class: 'livc-jump', type: 'button', hidden: true, text: '최신 대화로 ↓',
    onclick: () => { stick = true; toBottom(); },
  }) as HTMLButtonElement;
  // ⚠ 우리가 바닥으로 내린 직후의 scroll 이벤트는 '사람이 올렸다'가 아니다 — 내용이 연달아 붙는 되그리기 중에는 내린 뒤
  //  다음 덩이가 먼저 붙어 이벤트가 '바닥이 아님'으로 잡히고, 그 한 번에 stick 이 풀려 [최신 대화로] 가 괜히 뜬다(실측).
  //  프로그램 스크롤 뒤 120ms 안의 이벤트는 stick 을 풀지 않는다(붙이는 방향은 그대로 반영).
  let progAt = 0;
  list.addEventListener('scroll', () => {
    const near = list.scrollHeight - list.scrollTop - list.clientHeight <= NEAR_BOTTOM;
    if (near) { stick = true; jump.hidden = true; return; }
    if (Date.now() - progAt > 120) stick = false;
  });
  const toBottom = (): void => { progAt = Date.now(); list.scrollTop = list.scrollHeight; jump.hidden = true; };
  const scroll = (): void => {
    if (stick) { toBottom(); return; }
    jump.hidden = false;
  };

  const root = el('div', { class: 'livc-wrap' + (desktop ? ' livc-desktop' : '') }, el('div', { class: 'livc-scroller' }, list, jump), opts.askHost ?? undefined, note, footSlot);
  host.replaceChildren(root);
  if (opts.opening) list.append(opts.opening);
  if (opts.footer) { form.hidden = true; footSlot.append(opts.footer); }

  const turnsArr: ChatTurn[] = [];
  let runningTurn: ChatTurn | null = null;
  let ticker: number | null = null;
  let isBusy = false;

  const busy = (on: boolean): void => {
    isBusy = on;
    const lock = on && !opts.sendWhileBusy;
    input.disabled = lock;
    input.placeholder = lock ? (opts.busyPlaceholder || opts.placeholder) : opts.placeholder;
    stop.hidden = !(on && opts.onStop);
    // 리브(보내기 잠금)에서는 멈춤이 보내기 자리를 차지한다 — 버튼이 둘이면 잠긴 칸 옆에 죽은 버튼이 하나 남는다.
    //  desktop 도 같은 문법(Claude Desktop: 도는 동안 보내기 자리가 멈춤이 된다) — 단 보낼 수 있으면(큐잉) 둘 다 둔다.
    send.hidden = lock && !!opts.onStop;
    if (desktop) form.classList.toggle('dt-busy', on);
  };

  const tickLive = (): void => {
    if (!runningTurn || !runningTurn.live) return;
    const t = runningTurn;
    const busyCard = Array.from(t.work.querySelectorAll('.livc-slip-run')).pop()?.closest('.livc-slip');
    const doing = busyCard ? (busyCard.querySelector('.livc-slip-name')?.textContent || '') : '';
    // 사람 말 없이 중간부터 읽은 턴(창의 첫 턴)은 시작 시각을 모른다 — 경과 시간을 지어내지 않는다.
    const dur = t.ask ? fmtDur(Date.now() - t.startedAt) : '작업 중';
    if (desktop) {
      // ✻ 표식 + 작은 상태 글자. 도구가 도는 중이면 그 이름은 접힌 도구 줄이 이미 말하고 있어 여기선 시간만.
      const txt = t.live!.querySelector('.dt-live-t');
      if (txt) txt.textContent = `${dur}${opts.onStop ? ' · Esc 로 멈춤' : ''}`;
      return;
    }
    t.live!.textContent = `${doing ? doing + ' · ' : ''}${dur}${opts.onStop ? ' · Esc 로 멈춤' : ''}`;
  };
  const running = (t: ChatTurn | null): void => {
    if (runningTurn && runningTurn !== t) {
      runningTurn.work.classList.remove('livc-work-busy');
      runningTurn.live?.remove(); runningTurn.live = null;
    }
    runningTurn = t;
    if (ticker) { clearInterval(ticker); ticker = null; }
    if (!t) return;
    t.work.classList.add('livc-work-busy');
    const live = t.live ?? (t.live = (desktop
      ? el('div', { class: 'dt-live', 'aria-live': 'polite' }, el('span', { class: 'dt-spin', 'aria-hidden': 'true', text: '✻' }), el('span', { class: 'dt-live-t' }))
      : el('div', { class: 'livc-live', 'aria-live': 'polite' })) as HTMLElement);
    t.work.append(live);              // 항상 괘선의 맨 아래(새 내용이 오면 다시 내려간다 — event() 참고)
    tickLive();
    ticker = window.setInterval(tickLive, 1000);
  };

  function turn(userText: string | null, o?: { ts?: string; at?: 'end' | 'start' }): ChatTurn {
    let work: HTMLElement; let ask: HTMLElement | null = null;
    if (desktop) {
      // Claude Desktop 문법 — 내 말은 오른쪽 말풍선(이름표 없음, 시각은 title 로만), AI 는 왼쪽에 글만.
      work = el('div', { class: 'livc-work dt-ai' });
      if (userText !== null) {
        ask = el('div', { class: 'livc-ask dt-user' },
          el('div', { class: 'livc-ask-text dt-bubble', text: userText, title: o?.ts ? new Date(o.ts).toLocaleString() : undefined }));
      }
    } else {
      work = el('div', { class: 'livc-work' }, el('div', { class: 'livc-who', text: opts.who.ai }));
      if (userText !== null) {
        ask = el('div', { class: 'livc-ask' },
          el('div', { class: 'livc-who' }, el('span', { text: opts.who.me }), o?.ts ? el('time', { class: 'livc-ts', datetime: o.ts, title: new Date(o.ts).toLocaleString(), text: fmtClock(o.ts) }) : null),
          el('div', { class: 'livc-ask-text', text: userText }));
      }
    }
    const root0 = el('section', { class: 'livc-turn' + (ask ? '' : ' livc-turn-cont') }, ask, work);
    // 경과 시간의 기준 — 사람 말의 시각이 있으면 그것(화면을 나중에 열어도 '이 턴이 얼마나 됐나'가 맞다), 없으면 지금.
    const t0 = o?.ts ? Date.parse(o.ts) : NaN;
    const t: ChatTurn = { root: root0, work, ask, text: userText ?? '', ts: o?.ts, r: { cards: new Map(), blocks: new Map(), msgId: null, streamed: new Set() }, live: null, startedAt: Number.isFinite(t0) ? t0 : Date.now() };
    if (o?.at === 'start') { list.prepend(root0); turnsArr.unshift(t); }
    else { list.append(root0); turnsArr.push(t); }
    return t;
  }

  function appendWork(t: ChatTurn, node: HTMLElement): void {
    if (t.live && t.live.parentElement === t.work) t.work.insertBefore(node, t.live);
    else t.work.append(node);
  }

  /**
   * desktop — 연속된 도구 사용을 **한 줄**로 접는다("라이블리 5개 · 명령 2개 사용함 ›"). 도구 이력이 슬립 한 장씩 늘어서면 대화가 슬립에
   * 묻힌다(실측 지적: "너무 많이 뜬다"). 글(text)이 끼면 거기서 묶음이 끊기고 새 묶음이 시작된다 — 무엇을 하고 무엇을 말했는지의
   * 순서는 그대로 남는다. 펼치면 슬립이 그대로 있다(원문은 버리지 않는다).
   */
  function addToToolGroup(t: ChatTurn, card: HTMLElement, lab: ToolLabel): void {
    let last: Element | null = t.work.lastElementChild;
    if (last && last === t.live) last = last.previousElementSibling;
    let group: HTMLElement | null = last && last.classList.contains('dt-tools') ? (last as HTMLElement) : null;
    if (!group) {
      const g = el('details', { class: 'dt-tools' },
        el('summary', { class: 'dt-tools-sum' }, el('span', { class: 'dt-tools-mark', 'aria-hidden': 'true' }), el('span', { class: 'dt-tools-t' }), el('span', { class: 'dt-tools-chev', 'aria-hidden': 'true', text: '›' })),
        el('div', { class: 'dt-tools-body' })) as HTMLElement;
      appendWork(t, g);
      group = g;
    }
    (group.querySelector('.dt-tools-body') as HTMLElement).append(card);
    card.dataset.label = lab.label; card.dataset.detail = lab.detail || '';
    refreshToolGroup(group);
  }
  function refreshToolGroup(group: HTMLElement | null): void {
    if (!group) return;
    const cards = Array.from(group.querySelectorAll(':scope > .dt-tools-body > .livc-slip')) as HTMLElement[];
    // 문구 계산은 DOM 없는 chat-tool-group.ts 가 쥔다(#1822) — 여기서는 DOM → 항목으로 옮기고 표식만 칠한다.
    const items = cards.map((c) => ({
      label: c.dataset.label || '도구',
      detail: c.dataset.detail || '',
      running: !!c.querySelector('.livc-slip-run'),
      err: c.classList.contains('livc-slip-err'),
    }));
    const t = group.querySelector('.dt-tools-t') as HTMLElement;
    const mark = group.querySelector('.dt-tools-mark') as HTMLElement;
    t.textContent = toolGroupSummary(items);
    const errs = items.filter((it) => it.err).length;
    if (items.some((it) => it.running)) { mark.textContent = '●'; mark.className = 'dt-tools-mark run'; }
    else { mark.textContent = errs ? '✕' : '✓'; mark.className = 'dt-tools-mark' + (errs ? ' err' : ' ok'); }
  }

  function event(t: ChatTurn, ev: any): { text?: string } {
    const r = t.r;
    let lastText: string | undefined;
    const content = ev?.message?.content;
    const isAssistant = ev?.type === 'assistant';
    const already = isAssistant && r.streamed.has(String(ev?.message?.id ?? ''));
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'text' && isAssistant && String(b.text ?? '').trim()) {
          lastText = String(b.text);
          if (!already) appendWork(t, said(lastText));   // 조각으로 이미 그렸으면 건너뛴다(같은 글이다)
        } else if (b.type === 'thinking' && isAssistant) {
          if (opts.thinking === 'fold' && String(b.thinking ?? '').trim()) appendWork(t, thinkCard(String(b.thinking)));
        } else if (b.type === 'tool_use') {
          const lab = opts.toolLabel(String(b.name ?? '도구'), b.input);
          const card = actionCard(lab, b.input);
          if (b.id) r.cards.set(String(b.id), card);
          if (desktop) addToToolGroup(t, card, lab); else appendWork(t, card);
        } else if (b.type === 'tool_result') {
          const card = b.tool_use_id ? r.cards.get(String(b.tool_use_id)) : null;
          const out = typeof b.content === 'string' ? b.content
            : Array.isArray(b.content) ? b.content.map((c: any) => (c && c.type === 'text' ? String(c.text ?? '') : c && c.type === 'image' ? '[이미지]' : pretty(c))).join('\n')
            : pretty(b.content ?? '');
          if (card) { finishCard(card, out, !!b.is_error); if (desktop) refreshToolGroup(card.closest('.dt-tools') as HTMLElement | null); }
        }
      }
    }
    if (t === runningTurn && t.live) t.work.append(t.live);
    return { text: lastText };
  }

  function stream(t: ChatTurn, ev: any): void {
    const r = t.r; const e = ev?.event;
    if (!e) return;
    if (e.type === 'message_start') { r.msgId = String(e.message?.id ?? ''); r.blocks.clear(); return; }
    if (e.type === 'content_block_start' && e.content_block?.type === 'text') {
      const el0 = el('div', { class: 'livc-said livc-said-live' });
      r.blocks.set(Number(e.index), { el: el0, buf: '' });
      appendWork(t, el0);
      return;
    }
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
      const b = r.blocks.get(Number(e.index));
      if (!b) return;
      b.buf += String(e.delta.text ?? '');
      b.el.textContent = b.buf;
      if (r.msgId) r.streamed.add(r.msgId);
      return;
    }
    if (e.type === 'content_block_stop') {
      const b = r.blocks.get(Number(e.index));
      if (!b) return;
      b.el.classList.remove('livc-said-live');
      if (b.buf.trim()) { b.el.replaceChildren(renderMarkdown(b.buf)); decorateCode(b.el); }
      else b.el.remove();
      r.blocks.delete(Number(e.index));
    }
  }

  function settle(t: ChatTurn, o?: { exit?: number | null; interrupted?: boolean; durationMs?: number }): void {
    for (const [i, b] of t.r.blocks) {
      b.el.classList.remove('livc-said-live');
      if (b.buf.trim()) { b.el.replaceChildren(renderMarkdown(b.buf)); decorateCode(b.el); } else b.el.remove();
      t.r.blocks.delete(i);
    }
    t.work.querySelectorAll('.livc-slip-run').forEach((m) => { const c = m.closest('.livc-slip'); if (c) settleCard(c as HTMLElement); });
    if (desktop) t.work.querySelectorAll('.dt-tools').forEach((g) => refreshToolGroup(g as HTMLElement));
    if (t === runningTurn) running(null);
    if (o?.interrupted) appendWork(t, el('div', { class: 'livc-mark', text: '중단함' }));
    if (o?.exit != null && o.exit !== 0) appendWork(t, el('div', { class: 'livc-err', text: '이번 요청은 끝까지 가지 못했습니다. 다시 말씀해 주시면 이어서 해 보겠습니다.' }));
    if (o?.durationMs && o.durationMs > 3000) {
      const w = t.work.querySelector(':scope > .livc-who');
      if (w && !w.querySelector('.livc-dur')) w.append(el('span', { class: 'livc-dur', text: fmtDur(o.durationMs) }));
    }
  }

  function divider(text: string, details?: string, at?: 'end' | 'start'): void {
    const node = details
      ? el('details', { class: 'livc-divider' }, el('summary', { text }), el('div', { class: 'livc-divider-body', text: details }))
      : el('div', { class: 'livc-divider' }, el('span', { text }));
    if (at === 'start') list.prepend(node); else list.append(node);
  }

  const doStop = async (): Promise<void> => {
    if (!opts.onStop) return;
    stop.disabled = true;
    try { await opts.onStop(); } finally { stop.disabled = false; }
  };
  stop.addEventListener('click', () => { void doStop(); });
  const onEsc = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !isBusy || !opts.onStop) return;
    if (opts.escActive && !opts.escActive()) return;
    if (!root.isConnected) return;
    e.preventDefault();
    void doStop();
  };
  document.addEventListener('keydown', onEsc);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || input.disabled) return;
    input.value = ''; input.style.height = '';
    void opts.onSend(text);
  });
  // 한글 입력 중의 Enter 는 조합 확정이지 전송이 아니다(isComposing). Shift+Enter 는 줄바꿈.
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.isComposing || (e as any).keyCode === 229) return;
    e.preventDefault();
    form.requestSubmit();
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  });

  return {
    root, list, input, form, noteEl: note,
    turn, event, stream, settle, running, busy, scroll,
    scrollToBottom: () => { stick = true; toBottom(); },
    setNote: (text: string) => { note.textContent = text; },
    error: (t, text) => { const n = el('div', { class: 'livc-err', text }); if (t) appendWork(t, n); else list.append(n); scroll(); },
    divider,
    removeOpening: () => { list.querySelector('.livc-open')?.remove(); },
    setFooter: (f) => { footSlot.querySelectorAll(':scope > :not(form)').forEach((n) => n.remove()); if (f) { form.hidden = true; footSlot.append(f); } else form.hidden = false; },
    turns: () => turnsArr.slice(),
    prependKeepingView: (fn) => {
      const before = list.scrollHeight; const top = list.scrollTop;
      fn();
      list.scrollTop = top + (list.scrollHeight - before);
    },
    destroy: () => { document.removeEventListener('keydown', onEsc); if (ticker) clearInterval(ticker); },
  };
}

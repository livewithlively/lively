// codex 대화창의 **실시간 층** (#2055) — 승인 · 타이핑 · 도는 중 · 사용량.
//
//  ── 왜 별도 층인가 ──
//  대화의 **정본은 대화 파일**이다(session-chat 이 폴링으로 읽어 그린다 — 새로고침해도 같은 그림이 나오는 이유).
//  이 층은 그 위에 얹는 "지금 무슨 일이 벌어지는가"이고, 파일이 **못 나르는 것**을 나른다:
//   ① 승인 — 서버가 우리에게 묻고 답을 기다리는 요청이다. 사람에게 못 전하면 기본값(거부)으로 닫혀
//      codex 는 아무 명령도 못 돌린다. 파일에는 애초에 안 적힌다.
//   ② 글자 조각 — 파일은 한 항목이 **끝나야** 담는다. 그때까지 화면이 비어 있으면 사람은 "답이 안 온다"로 읽는다
//      (실측 2026-08-26: 실제로 그렇게 헤맸다).
//  나머지(완성된 글·도구 카드·생각)는 **파일이 그린다** — 두 곳에서 그리면 같은 말이 두 번 뜬다.
//
//  ── 규율 ──
//  · 미리보기 글자는 완성본이 도착하는 순간 사라진다(line 이벤트로 안다 — 그때 폴링도 깨운다).
//  · innerHTML 을 쓰지 않는다(레포 불변식). 모든 글자는 textContent.
//  · 스트림이 끊겨도 대화는 안 끊긴다 — 파일 폴링이 정본이라, 여기서는 조용히 다시 붙는다.
//  · 승인은 **세 갈래**만 둔다(허용 / 이 세션 동안 / 거부). codex 의 결정값이 그 셋이고, 넷째는 고를 것만 늘린다.
import { apiUrl, el, TOKEN_KEY, toast } from './core.js';
import type { ChatTurn, ChatView } from './chat-view.js';
import { splitSse } from './sse-frames.js';

export interface CodexLiveOpts {
  sessionId: string;
  view: ChatView;
  /** 승인이 앉는 자리 — 입력칸 바로 위(스크롤에 떠내려가면 안 된다). */
  dock: HTMLElement;
  /** 지금 글자가 흘러 들어갈 턴. 없으면 미리보기를 목록 끝에 둔다. */
  liveTurn: () => ChatTurn | null;
  /** 완성본이 파일에 떨어졌다 — 폴링을 지금 깨워 달라. */
  poke: () => void;
  /** 도는 중인지·기다리는 승인이 몇 개인지 바뀔 때 — 헤더의 점·상태 글자가 이 값을 따른다. */
  onState?: (s: { running: boolean; waiting: number }) => void;
  /** 턴이 끝났다(런타임이 말했다) — 화면이 그 턴을 마감한다. 파일의 마감 줄을 기다리지 않는다. */
  onSettled?: () => void;
}

export interface CodexLive {
  /** 지금 도는 중인가(서버가 말한 값). */
  running(): boolean;
  /** 대기 중 승인 수 — 헤더 배지가 읽는다. */
  waiting(): number;
  destroy(): void;
}

type Ev =
  | { kind: 'hello'; running?: boolean }
  | { kind: 'delta'; text: string }
  | { kind: 'line'; line: any }
  | { kind: 'status'; running: boolean }
  | { kind: 'approval'; id: string; title: string; detail: string; kindHint: string }
  | { kind: 'approval-done'; id: string; decision: string }
  | { kind: 'usage'; totalTokens?: number; usedPercent?: number };

/** codex 의 결정값 그대로. 순서가 곧 위험도 — 왼쪽이 가장 좁은 허락이다. */
const DECISIONS = [
  { v: 'accept', label: '허용', hint: '이번 한 번만 실행합니다', primary: true },
  { v: 'acceptForSession', label: '이 세션 동안', hint: '이 세션이 끝날 때까지 같은 요청을 묻지 않습니다' },
  { v: 'decline', label: '거부', hint: '실행하지 않고 하던 일을 이어갑니다' },
];
const KIND_KO: Record<string, string> = { command: '명령 실행', patch: '파일 변경', permission: '권한', other: '확인' };

export function mountCodexLive(o: CodexLiveOpts): CodexLive {
  let closed = false;
  let isRunning = false;
  let buf = '';
  let preview: HTMLElement | null = null;
  const cards = new Map<string, HTMLElement>();
  const ctl = new AbortController();

  const tell = (): void => o.onState?.({ running: isRunning, waiting: cards.size });

  const usage = el('div', { class: 'cxl-usage', hidden: true });
  const asks = el('div', { class: 'cxl-asks' });
  o.dock.append(usage, asks);

  // ── 타이핑 미리보기 ────────────────────────────────────────────────────────────────
  //  완성본과 **같은 글**이라 마크다운으로 정성껏 그리지 않는다(그건 파일이 그릴 몫이고, 이건 몇 초짜리다).
  //  ChatView 의 경과시간 줄(t.live) **위**에 둔다 — 글이 먼저, 상태가 아래.
  function place(node: HTMLElement): void {
    const t = o.liveTurn();
    if (!t) { o.view.list.append(node); return; }
    if (t.live && t.live.parentElement === t.work) t.work.insertBefore(node, t.live);
    else t.work.append(node);
  }
  function showPreview(): HTMLElement {
    if (preview && preview.isConnected) return preview;
    const node: HTMLElement = el('div', { class: 'livc-said cxl-typing', 'aria-live': 'polite' });
    preview = node;
    place(node);
    return node;
  }
  function clearPreview(): void { preview?.remove(); preview = null; buf = ''; }

  // ── 승인 ─────────────────────────────────────────────────────────────────────────
  //  이 화면에서 **사람이 답해야 에이전트가 움직이는** 유일한 순간이다. 그래서 대화 흐름 안이 아니라
  //  입력칸 바로 위에 서고(스크롤을 올려도 안 사라진다), 무엇을 실행하려는지 **원문 그대로** 보여 준다.
  async function answer(id: string, decision: string, card: HTMLElement, label: string): Promise<void> {
    card.classList.add('is-busy');
    try {
      const res = await fetch(apiUrl(`/api/ui/terminal/sessions/${encodeURIComponent(o.sessionId)}/codex-chat/approve`), {
        method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ id, decision }),
      });
      if (!res.ok) throw new Error(`답하지 못했습니다 (${res.status})`);
      const j: any = await res.json().catch(() => ({}));
      // applied=false = 이미 처리됐거나 시간이 지나 닫혔다. 지어내지 않고 사실대로 적는다.
      settleCard(id, j?.applied ? label : '이미 닫힘');
    } catch (e: any) {
      card.classList.remove('is-busy');
      toast(e?.message || '답하지 못했습니다.', true);
    }
  }

  function approvalCard(e: Extract<Ev, { kind: 'approval' }>): HTMLElement {
    const card = el('div', { class: 'cxl-ask', role: 'group', 'aria-label': e.title });
    const acts = el('div', { class: 'cxl-ask-acts' },
      ...DECISIONS.map((d) => el('button', {
        class: 'cxl-ask-btn' + (d.primary ? ' is-go' : ''), type: 'button', title: d.hint, text: d.label,
        onclick: () => { void answer(e.id, d.v, card, d.label); },
      })));
    card.append(
      el('div', { class: 'cxl-ask-head' },
        el('span', { class: 'cxl-ask-kind', text: KIND_KO[e.kindHint] || KIND_KO.other }),
        el('span', { class: 'cxl-ask-title', text: e.title })),
      el('pre', { class: 'cxl-ask-body' }, el('code', { text: e.detail })),
      acts);
    return card;
  }

  function settleCard(id: string, decisionLabel: string): void {
    const card = cards.get(id);
    if (!card) return;
    cards.delete(id);
    card.classList.remove('is-busy');
    card.classList.add('is-done');
    card.querySelector('.cxl-ask-acts')?.replaceChildren(el('span', { class: 'cxl-ask-said', text: decisionLabel }));
    // 답한 카드는 잠깐 남겨 무엇을 골랐는지 보이게 한 뒤 접는다(즉시 사라지면 눌렀는지 알 수 없다).
    window.setTimeout(() => { if (!closed) card.remove(); }, 2600);
    tell();
  }

  /** 완성된 AI 글이 왔나 — 그러면 미리보기는 제 할 일을 마쳤다(같은 글이 두 번 뜨면 안 된다). */
  const isAgentText = (line: any): boolean =>
    line?.type === 'assistant' && Array.isArray(line?.message?.content)
    && line.message.content.some((b: any) => b?.type === 'text' && String(b.text ?? '').trim());

  function handle(ev: Ev): void {
    switch (ev.kind) {
      case 'delta': {
        buf += ev.text;
        // 긴 답의 앞부분은 이미 스크롤 위로 지나갔다 — 꼬리만 보여 준다(완성본이 곧 전문을 그린다).
        showPreview().textContent = buf.length > 4000 ? '…' + buf.slice(-4000) : buf;
        o.view.scroll();
        return;
      }
      case 'line': {
        if (isAgentText(ev.line)) { clearPreview(); o.poke(); }   // 완성본이 파일에 있다 — 지금 읽어 오라
        else o.poke();                                            // 도구 카드도 몇 초 기다릴 이유가 없다
        return;
      }
      case 'hello':
      case 'status': {
        isRunning = !!(ev as any).running;
        if (!isRunning) {
          clearPreview();                        // 턴이 끝났다 — 남은 조각은 파일이 그린다
          // ★ 끝났다는 사실도 **여기가 먼저 안다**. 종전엔 마감을 대화 파일에만 맡겼는데, 멈춤(interrupt)처럼
          //  파일에 마감 줄이 늦게/안 오는 경우 화면이 최대 2분을 '작업 중'으로 남았다(실측 2026-08-26).
          //  런타임이 이 세션의 AI 다 — 그 말을 그대로 쓴다.
          //  ⚠ **이 층이 '도는 중'을 본 적 있을 때만** 알리지 않는다. 화면의 busy 는 보낼 때 세워지는데,
          //   스트림이 그 사이 끊겼다 붙으면(프록시가 장수 연결을 끊는다 — dev 실측 ERR_HTTP2_PROTOCOL_ERROR)
          //   이 층은 turn/started 를 못 봤으므로 was 가 false 고, 그러면 화면이 영영 '작업 중'으로 남는다.
          //   끝났다는 사실은 그 자체로 전할 값이다 — 마감할지는 받는 쪽이 자기 상태를 보고 정한다.
          o.onSettled?.();
        }
        tell();
        return;
      }
      case 'approval': {
        if (cards.has(ev.id)) return;            // 새로고침 재생(hello 뒤 replay)에서 두 번 오지 않게
        const card = approvalCard(ev);
        cards.set(ev.id, card);
        asks.append(card);
        tell();
        return;
      }
      case 'approval-done':
        settleCard(ev.id, ev.decision === 'decline' ? '거부' : ev.decision === 'cancel' ? '취소' : '허용');
        return;
      case 'usage': {
        if (Number.isFinite(ev.totalTokens)) usage.dataset.tok = String(Math.round(Number(ev.totalTokens) / 1000));
        if (Number.isFinite(ev.usedPercent)) usage.dataset.pct = String(Math.round(Number(ev.usedPercent)));
        const bits: string[] = [];
        if (usage.dataset.tok) bits.push(`${usage.dataset.tok}k 토큰`);
        if (usage.dataset.pct) bits.push(`사용 한도 ${usage.dataset.pct}%`);
        usage.textContent = bits.join(' · ');
        usage.hidden = !bits.length;
      }
    }
  }

  // ── 스트림 ──────────────────────────────────────────────────────────────────────
  //  EventSource 는 헤더를 못 싣는다(토큰이 주소로 새 나간다) — fetch 스트림으로 읽는다.
  /**
   * ★ **말 없는 연결을 살아 있는 것으로 착각하지 않는다**(실측 2026-08-26 dev).
   *  게이트웨이가 재기동되면 프록시(HTTP/2)가 스트림을 **닫지 않은 채** 붙들고 있어, `reader.read()` 가
   *  영원히 안 깨어난다 — 예외도 없고 done 도 없다. 그래서 재접속 루프가 통째로 멈췄고, 화면은 멈춤 버튼과
   *  경과 시간만 든 채 **영영 '작업 중'** 으로 남았다(사용자 신고의 절반이 이 한 가지에서 나왔다).
   *  서버가 25초마다 하트비트(`: beat`)를 보내므로, 그보다 넉넉한 시간 동안 **한 바이트도 안 오면 죽은 것**이다.
   */
  const SILENCE_MS = 40_000;

  async function pump(): Promise<void> {
    let wait = 1000;                       // 끊기면 다시 붙되, 간격을 늘려 폭주하지 않게(게이트웨이 재기동·프록시 타임아웃)
    while (!closed) {
      const attempt = new AbortController();
      const onAbortAll = (): void => attempt.abort();
      ctl.signal.addEventListener('abort', onAbortAll);
      let silence: ReturnType<typeof setTimeout> | null = null;
      const beat = (): void => {
        if (silence) clearTimeout(silence);
        silence = setTimeout(() => attempt.abort(), SILENCE_MS);   // 조용하면 끊고 새로 붙는다
      };
      try {
        const res = await fetch(apiUrl(`/api/ui/terminal/sessions/${encodeURIComponent(o.sessionId)}/codex-chat/events`), {
          headers: authHeaders({}), signal: attempt.signal, credentials: 'same-origin',
        });
        if (!res.ok || !res.body) throw new Error(`스트림 실패 (${res.status})`);
        wait = 1000;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let acc = '';
        beat();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          beat();
          acc += dec.decode(value, { stream: true });
          const cut = splitSse(acc);                              // 자르기 계약은 순수 모듈이 쥔다(web/sse-frames.ts)
          acc = cut.rest;
          for (const d of cut.data) {
            try { handle(JSON.parse(d)); } catch { /* 깨진 프레임 한 장은 넘긴다 */ }
          }
        }
      } catch {
        if (closed) return;                                       // 화면이 닫혔다 — 여기서 끝
      } finally {
        if (silence) clearTimeout(silence);
        ctl.signal.removeEventListener('abort', onAbortAll);
      }
      if (closed) return;
      await new Promise((r) => setTimeout(r, wait));
      // 상한을 짧게 둔다 — 이 통로가 나르는 것은 **승인**이라, 공백이 길면 그만큼 턴이 서 있는다.
      //  프록시가 장수 연결을 주기적으로 끊는 환경(dev 실측)에서는 끊김이 정상 상태에 가깝다.
      wait = Math.min(wait * 2, 5_000);
    }
  }
  void pump();

  return {
    running: () => isRunning,
    waiting: () => cards.size,
    destroy: () => { closed = true; ctl.abort(); clearPreview(); usage.remove(); asks.remove(); },
  };
}

function authHeaders(base: Record<string, string>): Record<string, string> {
  const tok = localStorage.getItem(TOKEN_KEY);
  return tok ? { ...base, Authorization: 'Bearer ' + tok } : base;
}

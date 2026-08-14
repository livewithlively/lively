// 리브와의 대화 — 터미널 대신 말풍선(#1631 v1).
//
//  ── 왜 터미널을 걷어내나 ──
//  v0 는 웹터미널을 재사용했다. 두뇌를 먼저 검증하려는 선택이었고 그건 성공했다. 그런데 리브의 대상은
//  "라이블리를 1도 모르는 사람"이고, 그 사람이 마주하는 화면 오른쪽 절반이 **까만 터미널**이었다.
//  잘 대답해도 그 자리가 무섭다. 두뇌는 그대로 두고 표면만 바꾼다(D2·D5).
//
//  ── 무엇을 그리나 ──
//  서버가 헤드리스 한 턴을 띄우고(POST me/liv/turn) 진행을 JSONL 로 남긴다. 화면은 그 줄을 바이트
//  오프셋으로 이어 읽어 셋으로 나눠 그린다:
//    · assistant 의 글 → 말풍선
//    · 도구 호출 → **액션카드**("무엇을 하는 중" → 끝나면 "했음"). 원문은 **버리지 않고 접는다** —
//      펼치면 그게 '진짜 했다'의 증거다. 접어 두는 이유는 그 원문이 이 사람의 언어가 아니기 때문이지,
//      숨겨야 해서가 아니다.
//    · 마지막 result → 답이 비어 있을 때만 쓴다(보통은 그 앞 assistant 글이 이미 답이다).
//
//  ── 이 화면이 지키는 것 ──
//  · **답을 기다리는 동안 입력을 막는다.** 턴이 겹치면 대화 이어받기(--resume)가 꼬인다.
//  · **한글 입력 중 Enter 는 전송이 아니다**(IME 조합 확정 Enter — 레포 불변식).
//  · **실패를 조용히 삼키지 않는다.** exit≠0 이면 그 자리에 말한다.
import { api, el } from './core.js';

/** 진행을 다시 물어보는 간격. 사람이 기다리는 화면이라 짧게, 그러나 서버를 때리지 않게. */
const POLL_MS = 900;

interface TurnStart { turn_id: string; resumed: boolean }
interface TailResult { chunk?: string; next?: number; done?: boolean; exit?: number | null }

/** 도구 이름을 사람 말로. 모르는 건 이름 그대로 둔다 — 지어내지 않는다. */
function toolLabel(name: string): string {
  if (name.startsWith('mcp__lively__')) return '라이블리 설정';
  if (name === 'Skill') return '전담 절차 실행';
  return name;
}

/** 액션카드 하나. 시작할 때 만들고 결과가 오면 그 자리를 채운다(새 카드를 또 만들지 않는다). */
function actionCard(name: string, input: unknown): HTMLElement {
  const card = el('div', { class: 'livc-act' },
    el('div', { class: 'livc-act-head' },
      el('span', { class: 'livc-act-spin', 'aria-hidden': 'true' }),
      el('b', { text: toolLabel(name) }),
      el('span', { class: 'livc-act-state', text: '하는 중…' })),
    el('details', { class: 'livc-act-raw' },
      el('summary', { text: '무엇을 보냈는지 보기' }),
      el('pre', { text: JSON.stringify(input ?? {}, null, 2).slice(0, 4000) })));
  return card;
}

function finishCard(card: HTMLElement, output: string, isError: boolean): void {
  const spin = card.querySelector('.livc-act-spin');
  if (spin) spin.remove();
  const state = card.querySelector('.livc-act-state');
  if (state) state.textContent = isError ? '실패' : '했음';
  card.classList.add(isError ? 'livc-act-err' : 'livc-act-done');
  card.append(el('details', { class: 'livc-act-raw' },
    el('summary', { text: isError ? '무엇이 잘못됐는지 보기' : '무엇이 돌아왔는지 보기' }),
    el('pre', { text: output.slice(0, 4000) })));
}

function bubble(role: 'me' | 'liv', text: string): HTMLElement {
  return el('div', { class: `livc-msg livc-msg-${role}` }, el('div', { class: 'livc-bubble', text }));
}

/** 스트림 한 줄을 화면에 반영한다. cards = tool_use id → 그 카드(결과가 왔을 때 찾아 채운다). */
function applyEvent(ev: any, list: HTMLElement, cards: Map<string, HTMLElement>): { text?: string } {
  let lastText: string | undefined;
  const content = ev?.message?.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'text' && String(b.text ?? '').trim()) {
        lastText = String(b.text);
        list.append(bubble('liv', lastText));
      } else if (b?.type === 'tool_use') {
        const card = actionCard(String(b.name ?? '도구'), b.input);
        if (b.id) cards.set(String(b.id), card);
        list.append(card);
      } else if (b?.type === 'tool_result') {
        const card = b.tool_use_id ? cards.get(String(b.tool_use_id)) : null;
        const out = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '', null, 2);
        if (card) finishCard(card, out, !!b.is_error);
      }
    }
  }
  return { text: lastText };
}

export function mountLivChat(host: HTMLElement): void {
  const list = el('div', { class: 'livc-list' });
  const input = el('textarea', {
    class: 'livc-input', rows: '1', placeholder: '리브에게 말해 보세요 — 예: 지금 뭐부터 하면 돼요?',
    'aria-label': '리브에게 보낼 말',
  }) as HTMLTextAreaElement;
  const send = el('button', { class: 'btn btn-sm livc-send', type: 'submit', text: '보내기' }) as HTMLButtonElement;
  const note = el('div', { class: 'livc-note' });

  const form = el('form', { class: 'livc-compose' }, input, send) as HTMLFormElement;
  host.replaceChildren(el('div', { class: 'livc-wrap' }, list, note, form));

  const scroll = (): void => { list.scrollTop = list.scrollHeight; };
  const busy = (on: boolean): void => {
    input.disabled = on; send.disabled = on;
    send.textContent = on ? '…' : '보내기';
    // 답을 기다리는 동안 입력을 막는 이유는 예의가 아니라 **정합성**이다 — 턴이 겹치면 이어받기가 꼬인다.
    note.textContent = on ? '리브가 하는 중입니다…' : '';
  };

  // 첫 인사는 사람이 먼저 말을 걸게 둔다 — 열자마자 리브가 떠들면 그것도 무섭다.
  list.append(el('div', { class: 'livc-hello' },
    el('b', { text: '리브예요.' }),
    el('p', { text: '이 워크스페이스를 대신 손봐 드립니다. 무엇을 도와드릴지 편하게 말씀해 주세요.' })));

  async function drain(turnId: string): Promise<void> {
    let from = 0;
    const cards = new Map<string, HTMLElement>();
    let sawText = false;
    for (;;) {
      let r: TailResult;
      try {
        r = await api(`/api/ui/me/liv/turn/${encodeURIComponent(turnId)}?from=${from}`) as TailResult;
      } catch (e) {
        list.append(el('div', { class: 'livc-err', text: `진행을 읽지 못했습니다: ${(e as Error).message}` }));
        scroll(); return;
      }
      if (r.chunk) {
        for (const line of r.chunk.split('\n')) {
          if (!line.trim()) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }  // 잘린 줄 — 다음 청크에서 온전히 온다
          if (ev.type === 'result') {
            // 앞에서 글이 하나도 안 나왔을 때만 최종 result 를 쓴다(보통은 중복이다).
            if (!sawText && String(ev.result ?? '').trim()) list.append(bubble('liv', String(ev.result)));
            continue;
          }
          if (applyEvent(ev, list, cards).text) sawText = true;
        }
        from = r.next ?? from;
        scroll();
      }
      if (r.done) {
        if (r.exit != null && r.exit !== 0) {
          list.append(el('div', { class: 'livc-err', text: `이번 요청이 끝까지 가지 못했습니다(코드 ${r.exit}). 다시 말씀해 주시면 이어서 해 보겠습니다.` }));
          scroll();
        }
        return;
      }
      await new Promise((s) => setTimeout(s, POLL_MS));
    }
  }

  async function sendTurn(text: string): Promise<void> {
    list.append(bubble('me', text));
    scroll(); busy(true);
    try {
      const t = await api('/api/ui/me/liv/turn', { method: 'POST', body: JSON.stringify({ text }) }) as TurnStart;
      await drain(t.turn_id);
    } catch (e) {
      list.append(el('div', { class: 'livc-err', text: `보내지 못했습니다: ${(e as Error).message}` }));
      scroll();
    } finally {
      busy(false); input.focus();
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || input.disabled) return;
    input.value = ''; input.style.height = '';
    void sendTurn(text);
  });

  // ⚠ 한글 입력 중의 Enter 는 **조합 확정**이지 전송이 아니다(레포 불변식 — 이걸 빼면 한국어 사용자는
  //  글자를 확정할 때마다 반쪽짜리 문장이 날아간다). isComposing 이 그 신호다.
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.isComposing || (e as any).keyCode === 229) return;
    e.preventDefault();
    form.requestSubmit();
  });

  // 여러 줄을 치면 입력칸이 따라 늘어난다(고정 높이면 자기가 뭘 썼는지 안 보인다). 상한은 둔다.
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  });

  input.focus();
}

/**
 * 카드(맡기기·객관식 답·업로드·자격 저장)가 리브에게 말을 거는 **유일한 문**.
 * 종전엔 터미널 세션에 프롬프트를 주입했다. 표면이 바뀌었으니 들어가는 길도 대화창 하나다.
 *
 * ⚠ 리브가 답하는 중이면 **버리지 않고 기다린다.** 사람이 카드에서 답을 골랐는데 그게 조용히 사라지면
 *  그 답은 영영 리브에게 안 간다(그리고 사람은 골랐다고 믿는다). 화면에는 곧바로 올려 두고, 보낼 수
 *  있게 되는 순간 보낸다. 끝내 못 보내면 **친 글은 입력칸에 남겨** 사람이 직접 보낼 수 있게 한다.
 */
export function livChatAsk(text: string): void {
  const t0 = Date.now();
  const tryOnce = (): void => {
    const form = document.querySelector('.livc-compose') as HTMLFormElement | null;
    const input = document.querySelector('.livc-input') as HTMLTextAreaElement | null;
    if (!form || !input) return;                                  // 화면을 떠났다
    if (input.disabled) {
      if (Date.now() - t0 > 120_000) { input.value = text; return; }  // 너무 오래 걸린다 — 사람 손에 넘긴다
      setTimeout(tryOnce, 500);
      return;
    }
    input.value = text;
    form.requestSubmit();
  };
  tryOnce();
}

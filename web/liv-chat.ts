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
import { api, el, renderMarkdown } from './core.js';

/**
 * 진행을 다시 물어보는 간격.
 *
 * 조각(글자 단위)이 와도 이 간격마다 그리므로 **이 값이 곧 체감 속도**다. 900ms 면 조각이 와도
 * 뭉텅이로 나타나 스트리밍이 아니게 된다. 400ms 는 20초 턴에 50회 남짓인데, 한 번이 파일을
 * 오프셋부터 이어 읽는 값싼 요청이라 감당된다.
 * ⚠ 진짜 밀어주기(SSE)가 아니라 **당겨오기**다 — 부드러운 타이핑이 아니라 짧은 뭉치로 나타난다.
 *  20초 빈 화면과 비교하면 큰 차이지만, 더 매끄럽게 하려면 그때는 전송 방식을 바꿔야 한다.
 */
const POLL_MS = 400;
/** 진행 읽기가 연달아 몇 번까지 실패해도 버티나. 배포·네트워크 blip 은 몇 초면 지나간다 —
 *  그 사이에 포기하면 서버에서 멀쩡히 만들어진 답을 화면이 버리는 꼴이다. */
const RETRY_MAX = 6;

interface TurnStart { turn_id: string; resumed: boolean }
interface TailResult { chunk?: string; next?: number; done?: boolean; exit?: number | null }

/**
 * 도구 이름을 사람 말로.
 *
 * 이 화면의 전제가 "무대 뒤를 드러내지 않는다"인데, 액션카드에 `ToolSearch` 같은 하네스 내부 이름이
 * 그대로 뜨면 그 전제가 카드 한 장으로 깨진다(실측: 첫 대화에서 그렇게 떴다). 그렇다고 감추지는 않는다 —
 * 카드가 있다는 사실 자체가 '진짜 했다'의 증거라, **이름만 사람 말로 바꾸고 원문은 접어 둔다.**
 *
 * ⚠ 모르는 이름은 **그대로 둔다.** 그럴싸한 한국어를 지어내면 사람이 무슨 일이 있었는지 오해한다 —
 *  낯선 영어 한 줄이 틀린 한국어보다 낫다.
 */
const TOOL_LABELS: Record<string, string> = {
  ToolSearch: '쓸 도구 찾기',
  Skill: '전담 절차 실행',
  TodoWrite: '할 일 정리',
  AskUserQuestion: '물어보기',
};
function toolLabel(name: string): string {
  if (name.startsWith('mcp__lively__')) return '라이블리 설정';
  if (name.startsWith('mcp__')) return '연결한 도구 사용';
  return TOOL_LABELS[name] ?? name;
}

/**
 * 작업 슬립 — 이 화면의 시그니처.
 *
 * 리브의 제품적 주장은 "안내가 아니라 **수행**"이다. 그 주장이 눈에 보이는 자리가 여기다:
 * 리브가 무언가 할 때마다 슬립이 한 장 끼어들고, **무엇을 보냈고 무엇이 돌아왔는지**가 그 안에 접혀 있다.
 * 접는 이유는 숨겨야 해서가 아니라 그 원문이 이 사람의 언어가 아니어서다 — 펼치면 그게 증거다.
 * 상태는 색이 아니라 **표식과 글자**로 간다(●하는 중 / ✓했음 / ✕실패) — 색각 계약(35-liv.css §0.5).
 */
function actionCard(name: string, input: unknown): HTMLElement {
  const card = el('div', { class: 'livc-slip' },
    el('div', { class: 'livc-slip-head' },
      el('span', { class: 'livc-slip-mark livc-slip-run', 'aria-hidden': 'true', text: '●' }),
      el('span', { class: 'livc-slip-name', text: toolLabel(name) }),
      el('span', { class: 'livc-slip-state', text: '하는 중' })),
    el('div', { class: 'livc-slip-more' },
      el('details', { class: 'livc-slip-raw' },
        el('summary', { text: '보낸 것' }),
        el('pre', { text: JSON.stringify(input ?? {}, null, 2).slice(0, 4000) }))));
  return card;
}

function finishCard(card: HTMLElement, output: string, isError: boolean): void {
  const mark = card.querySelector('.livc-slip-mark');
  if (mark) { mark.classList.remove('livc-slip-run'); mark.textContent = isError ? '✕' : '✓'; }
  const state = card.querySelector('.livc-slip-state');
  if (state) state.textContent = isError ? '실패' : '했음';
  card.classList.add(isError ? 'livc-slip-err' : 'livc-slip-done');
  card.querySelector('.livc-slip-more')?.append(el('details', { class: 'livc-slip-raw' },
    el('summary', { text: isError ? '무엇이 잘못됐는지' : '돌아온 것' }),
    el('pre', { text: output.slice(0, 4000) })));
}

/**
 * 리브가 한 말 한 덩이. 말풍선이 아니라 **일지의 한 줄**이다(아래 turnBlock 주석 참조).
 *
 * ⚠ 리브는 마크다운으로 쓴다(LLM 이 그렇게 쓴다). 날글로 그리면 화면에 `**굵게**` 와 백틱이 그대로 뜬다 —
 *  실측에서 답 한 통이 별표투성이로 나왔다. 제품 렌더러를 쓴다: 그쪽은 **innerHTML 을 아예 안 쓰고**
 *  전부 textContent/createElement 로만 짓는 것이 불변식이라(lib/markdown.ts P4b), 모델 출력을 그려도
 *  HTML 이 주입될 길이 없다. 새로 파서를 짜서 그 보장을 잃을 이유가 없다.
 */
function livSaid(text: string): HTMLElement {
  return el('div', { class: 'livc-said' }, renderMarkdown(text));
}

/**
 * 한 턴 = 사람의 말 한 마디 + 그 말에 리브가 한 **모든 것**.
 *
 * ⚠ 좌우 말풍선을 쓰지 않는다. 말풍선은 "친구와의 대화"라는 관계를 들여오는데, 리브는 친구가 아니라
 *  **담당자**다. 그리고 이 제품의 원칙은 "이 대화는 사라지고 기록만 남는다"(#1663)라, 정직한 형태는
 *  채팅이 아니라 **일지**다. 그래서:
 *   · 사람의 말은 굵게, 바깥에 — 일지의 항목 제목처럼
 *   · 리브가 한 일은 **하나의 세로 괘선**에 전부 매단다. 그 선의 길이가 곧 "이 한 마디에 리브가 한 일의
 *     범위"라 장식이 아니라 정보다(말·슬립·말이 섞여도 한 덩이로 읽힌다).
 *   · 누가 말했는지는 위치가 아니라 **이름표**로 밝힌다 — 위치로만 가르면 화면을 못 보는 사람에게 사라진다.
 */
function turnBlock(userText: string): { root: HTMLElement; work: HTMLElement } {
  const work = el('div', { class: 'livc-work livc-work-busy' },
    el('div', { class: 'livc-who', text: '리브' }));
  const root = el('section', { class: 'livc-turn' },
    el('div', { class: 'livc-ask' },
      el('div', { class: 'livc-who', text: '나' }),
      el('div', { class: 'livc-ask-text', text: userText })),
    work);
  return { root, work };
}

/** 한 턴을 그리는 동안 들고 있는 것. 조각(스트리밍)과 완성본이 **같은 글**이라 겹치지 않게 하는 게 핵심이다. */
interface TurnRender {
  cards: Map<string, HTMLElement>;         // tool_use id → 그 슬립
  blocks: Map<number, { el: HTMLElement; buf: string }>;  // 지금 흘러들어오는 글 덩이(index 별)
  msgId: string | null;                    // 지금 조각이 실리고 있는 메시지
  streamed: Set<string>;                   // 조각으로 이미 다 그린 메시지 — 완성본이 와도 다시 그리지 않는다
}

/**
 * 조각(`stream_event`)을 그린다 — 글자가 오는 대로.
 *
 * ⚠ **조각을 이어붙인 글은 뒤따르는 완성본(assistant/text)과 글자까지 똑같다**(실측 2026-08-15).
 *  그래서 조각으로 그린 메시지는 기억해 두고, 완성본이 와도 그 글은 **건너뛴다**. 안 그러면 답이 두 번 나온다.
 *  그리고 흘러오는 동안은 **날글**로 그린다 — 마크다운을 매 조각마다 다시 파싱하면 비싸고, 반쯤 열린
 *  `**` 가 화면에서 깜빡인다. 덩이가 끝나는 순간 마크다운으로 갈아끼운다.
 */
function applyStream(ev: any, work: HTMLElement, r: TurnRender): void {
  const e = ev?.event;
  if (!e) return;
  if (e.type === 'message_start') { r.msgId = String(e.message?.id ?? ''); r.blocks.clear(); return; }
  if (e.type === 'content_block_start' && e.content_block?.type === 'text') {
    const el0 = el('div', { class: 'livc-said livc-said-live' });
    r.blocks.set(Number(e.index), { el: el0, buf: '' });
    work.append(el0);
    return;
  }
  if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
    const b = r.blocks.get(Number(e.index));
    if (!b) return;
    b.buf += String(e.delta.text ?? '');
    b.el.textContent = b.buf;                    // 흘러오는 동안은 날글
    if (r.msgId) r.streamed.add(r.msgId);
    return;
  }
  if (e.type === 'content_block_stop') {
    const b = r.blocks.get(Number(e.index));
    if (!b) return;
    b.el.classList.remove('livc-said-live');
    if (b.buf.trim()) b.el.replaceChildren(renderMarkdown(b.buf));   // 끝나면 제대로
    else b.el.remove();                                             // 빈 덩이는 자리를 차지하지 않는다
    r.blocks.delete(Number(e.index));
  }
}

/** 완성본 한 줄을 그 턴의 괘선 안에 반영한다. */
function applyEvent(ev: any, list: HTMLElement, r: TurnRender): { text?: string } {
  const cards = r.cards;
  let lastText: string | undefined;
  const content = ev?.message?.content;
  const already = ev?.type === 'assistant' && r.streamed.has(String(ev?.message?.id ?? ''));
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'text' && String(b.text ?? '').trim()) {
        lastText = String(b.text);
        if (!already) list.append(livSaid(lastText));   // 조각으로 이미 그렸으면 건너뛴다(같은 글이다)
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

/** askHost = 리브가 던진 물음이 앉는 자리. **대화와 같은 칸, 입력 바로 위**에 끼운다 —
 *  물음이 다른 칸에 있으면 그건 대화가 아니라 서식이고, 스크롤 안에 있으면 답하려는 순간 떠내려간다. */
export function mountLivChat(host: HTMLElement, askHost: HTMLElement): void {
  const list = el('div', { class: 'livc-list' });
  const input = el('textarea', {
    class: 'livc-input', rows: '1', placeholder: '리브에게 말하기',
    'aria-label': '리브에게 보낼 말',
  }) as HTMLTextAreaElement;
  const send = el('button', { class: 'btn btn-sm livc-send', type: 'submit', text: '보내기' }) as HTMLButtonElement;
  const note = el('div', { class: 'livc-note' });

  const form = el('form', { class: 'livc-compose' }, input, send) as HTMLFormElement;
  host.replaceChildren(el('div', { class: 'livc-wrap' }, list, askHost, note, form));

  const scroll = (): void => { list.scrollTop = list.scrollHeight; };
  const busy = (on: boolean): void => {
    input.disabled = on; send.disabled = on;
    send.textContent = on ? '…' : '보내기';
    // 답을 기다리는 동안 입력을 막는 이유는 예의가 아니라 **정합성**이다 — 턴이 겹치면 이어받기가 꼬인다.
    //  ⚠ 그 사실을 별도 안내줄로 말하지 않는다. 이름표 옆 깜빡이는 점이 이미 "하는 중"을 말하고 있어
    //   같은 말이 두 번 나온다. **못 치는 이유는 못 치는 칸이 말하는 게 맞다** — 시선이 거기 있다.
    input.placeholder = on ? '리브가 하는 중…' : '리브에게 말하기';
  };

  /**
   * 빈 화면 — **행동으로의 초대**여야 한다(설명이 아니라).
   *
   * 종전엔 "무엇을 도와드릴지 편하게 말씀해 주세요"였는데, 그건 어떤 제품에 붙여도 되는 말이라
   * 아무것도 알려주지 않는다. 그리고 이 화면의 진짜 문제는 **말을 걸 줄 모르는 것**이다 — 라이블리를
   * 처음 본 사람은 무엇을 부탁해도 되는지 감이 없다.
   * 그래서 리브가 실제로 할 수 있는 세 마디를 **눌러서 채워지는** 보기로 둔다. 예시가 곧 사용법이다.
   * 앞의 라벨(점검·연결·기록)은 장식이 아니라 **리브가 하는 일의 세 갈래**다 — 세 줄이 예시 목록이 아니라
   * '내가 부탁할 수 있는 것의 지도'가 된다. '연결'은 제품이 정한 사람 말이다(수집기라고 하지 않는다).
   */
  const STARTERS: Array<[string, string]> = [
    ['점검', '지금 뭐부터 하면 돼요?'],
    ['연결', '쓰던 노션이랑 연결해 주세요'],
    ['기록', '매주 회의록을 여기 쌓고 싶어요'],
  ];
  const fill = (t: string): void => { input.value = t; input.focus(); form.requestSubmit(); };
  list.append(el('div', { class: 'livc-open' },
    el('div', { class: 'livc-open-lede' },
      el('b', { text: '말씀하시면 제가 합니다.' }),
      el('p', { text: '설명서를 드리는 게 아니라, 이 워크스페이스를 직접 손봅니다.' })),
    el('ul', { class: 'livc-open-list' },
      ...STARTERS.map(([kind, t]) => el('li', {},
        el('button', { class: 'livc-open-btn', type: 'button', onclick: () => fill(t) },
          el('span', { class: 'livc-open-kind', text: kind }),
          el('span', { class: 'livc-open-say', text: t })))))));

  async function drain(turnId: string, work: HTMLElement): Promise<void> {
    let from = 0;
    const r: TurnRender = { cards: new Map(), blocks: new Map(), msgId: null, streamed: new Set() };
    let sawText = false;
    let fails = 0;
    for (;;) {
      let tail: TailResult;
      try {
        tail = await api(`/api/ui/me/liv/turn/${encodeURIComponent(turnId)}?from=${from}`) as TailResult;
        fails = 0;
      } catch (e) {
        // ⚠ **한 번 끊겼다고 턴을 버리지 않는다.** 이 요청이 실패해도 리브는 서버에서 계속 일하고 진행도
        //  계속 파일에 쌓인다 — 화면만 포기하면 그 답을 통째로 잃는다(실측: 게이트웨이를 재배포하는 몇 초
        //  동안 프록시가 502 를 냈고, 그 한 번에 대화가 끊겼다). 오프셋을 그대로 들고 물러났다가 다시 붙는다.
        fails++;
        if (fails <= RETRY_MAX) {
          await new Promise((s) => setTimeout(s, Math.min(POLL_MS * 2 ** (fails - 1), 5000)));
          continue;
        }
        work.append(el('div', { class: 'livc-err',
          text: '진행을 따라가지 못했습니다. 리브는 계속 일하고 있을 수 있으니, 화면을 새로고침하면 이어서 보입니다.' }));
        scroll(); return;
      }
      if (tail.chunk) {
        for (const line of tail.chunk.split('\n')) {
          if (!line.trim()) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }  // 잘린 줄 — 다음 청크에서 온전히 온다
          if (ev.type === 'stream_event') { applyStream(ev, work, r); sawText = true; continue; }
          if (ev.type === 'result') {
            // 앞에서 글이 하나도 안 나왔을 때만 최종 result 를 쓴다(보통은 중복이다).
            if (!sawText && String(ev.result ?? '').trim()) work.append(livSaid(String(ev.result)));
            continue;
          }
          if (applyEvent(ev, work, r).text) sawText = true;
        }
        from = tail.next ?? from;
        scroll();
      }
      if (tail.done) {
        // 중간에 끊겨 content_block_stop 을 못 받은 덩이 — 날글·깜빡이는 커서로 남기지 않는다.
        for (const [i, b] of r.blocks) {
          b.el.classList.remove('livc-said-live');
          if (b.buf.trim()) b.el.replaceChildren(renderMarkdown(b.buf)); else b.el.remove();
          r.blocks.delete(i);
        }
        if (tail.exit != null && tail.exit !== 0) {
          // 실패를 조용히 삼키지 않는다. 다만 코드만 던지지 말고 **다음에 할 일**을 준다.
          work.append(el('div', { class: 'livc-err', text: '이번 요청은 끝까지 가지 못했습니다. 다시 말씀해 주시면 이어서 해 보겠습니다.' }));
          scroll();
        }
        return;
      }
      await new Promise((s) => setTimeout(s, POLL_MS));
    }
  }

  /**
   * 지난 대화를 되그린다 — **일지인데 지난 장을 못 펼치면 일지가 아니다.**
   *
   * 본문은 서버에 복제해 두지 않았다(진행 파일이 정본이다). 그래서 턴 목록만 받아 각 턴의 진행을
   * 처음부터 한 번씩 읽어 같은 방식으로 그린다. 조각(stream_event)은 **건너뛴다** — 다 끝난 턴이라
   * 완성본에 같은 글이 이미 있고, 되그리기에서까지 조각을 재생할 이유가 없다.
   * 마지막 턴이 아직 돌고 있으면(새로고침 중에도 리브는 일한다) 거기서부터 **live 로 이어붙는다.**
   */
  async function replayHistory(): Promise<void> {
    type Chat = { turns?: Array<{ id: string; text: string }> } | null;
    let chat: Chat = null;
    try { chat = ((await api('/api/ui/me/liv/chat')) as { chat: Chat }).chat; } catch { return; }
    const turns = chat?.turns ?? [];
    if (!turns.length) return;
    list.querySelector('.livc-open')?.remove();
    for (const t of turns) {
      const { root, work } = turnBlock(t.text);
      list.append(root);
      let tail: TailResult | null = null;
      try { tail = await api(`/api/ui/me/liv/turn/${encodeURIComponent(t.id)}?from=0`) as TailResult; }
      catch { work.remove(); continue; }        // 그 턴의 기록이 사라졌다 — 사람 말만 남기고 넘어간다
      const r: TurnRender = { cards: new Map(), blocks: new Map(), msgId: null, streamed: new Set() };
      for (const line of String(tail.chunk ?? '').split('\n')) {
        if (!line.trim()) continue;
        let ev: any; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'stream_event') continue;          // 완성본에 같은 글이 있다
        if (ev.type === 'result') continue;
        applyEvent(ev, work, r);
      }
      work.classList.remove('livc-work-busy');
      if (!tail.done) {                          // 아직 도는 중 — 새로고침해도 이어서 따라간다
        work.classList.add('livc-work-busy');
        busy(true);
        void drain(t.id, work).finally(() => { work.classList.remove('livc-work-busy'); busy(false); });
      }
      scroll();
    }
  }

  async function sendTurn(text: string): Promise<void> {
    // 첫 말을 걸면 빈 화면의 초대는 물러난다 — 할 일이 생겼는데 안내가 자리를 차지할 이유가 없다.
    list.querySelector('.livc-open')?.remove();
    const { root, work } = turnBlock(text);
    list.append(root);
    scroll(); busy(true);
    try {
      const t = await api('/api/ui/me/liv/turn', { method: 'POST', body: JSON.stringify({ text }) }) as TurnStart;
      await drain(t.turn_id, work);
    } catch (e) {
      work.append(el('div', { class: 'livc-err', text: `보내지 못했습니다. ${(e as Error).message}` }));
      scroll();
    } finally {
      work.classList.remove('livc-work-busy');
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

  void replayHistory();
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

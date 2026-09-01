// 세션 작업 표면 (#2439 ③) — **백그라운드 셸과 서브에이전트를 한 자리에** 보여준다.
//
//  ── 왜 필요한가 ──────────────────────────────────────────────────────────────────
//  상민님(2026-08-31): *"백그라운드 셸 정보나 서브에이전트 정보나 만든 아티팩트 정보 같이 하네스 아래쪽에
//   뜨는 것들은 확인할 방법이 하나도 없네."* — 맞는 말이었다. 그 정보는 **대화 파일에 아예 없어서**
//  (실측: transcript 26줄에 task 이벤트 0건) 대화창이 읽을 길 자체가 없었다. 대화 런타임(#2439 ②)이
//  생기고서야 이벤트로 오기 시작했고, 이 파일이 그걸 그린다.
//
//  ── ★ 왜 카드 하나로 둘 다 되나 ─────────────────────────────────────────────────
//  claude 실측: 백그라운드 셸과 서브에이전트가 **완전히 같은 봉투**로 온다 — `task_started` 에
//  `task_type` 만 `local_bash` / `local_agent` 로 다르다(+ 서브에이전트는 subagent_type·spawn_depth).
//  그래서 «작업(task)» 하나를 1급으로 두면 둘이 한 번에 덮인다. 서버가 그걸 `kind: shell|agent` 로
//  옮겨 주므로(session-event.ts ★3) 이 화면은 **하네스를 모른다.**
//
//  ── ★ 작업만이 아니다 (#2439 ④) ────────────────────────────────────────────────
//  이 파일은 세션 상태 통로(SSE)의 **유일한 구독자**다. 그래서 그 통로로 오는 축을 전부 여기서 그린다:
//   작업(백그라운드 셸·서브에이전트) · **승인** · **세션 사실**(모델·슬래시 목록) · **사용량**.
//  구독자를 축마다 따로 두면 SSE 가 세션당 네 개 열리고, 재접속·침묵감시 규칙이 네 벌이 된다 —
//  그중 하나는 반드시 빠진다(이 프로젝트가 계속 마주친 실패 모양이다).
//
//  ── 화면이 하지 않는 것 ─────────────────────────────────────────────────────────
//  · 접기를 다시 하지 않는다. 서버가 언제나 **접힌 스냅샷**을 준다(runtime-bus) — 두 벌이면 갈린다.
//  · 모르는 이벤트에 던지지 않는다. 새 표면이 생겨도 화면은 조용히 건너뛴다(session-event.ts ★2).
//  · **하네스 낱말을 모른다.** `behavior:"allow"` 도 `optionId` 도 서버의 respond 가 만든다(★3).
import { apiUrl, el, TOKEN_KEY } from './core.js';
import { splitSse } from './sse-frames.js';
//  판단(무엇을 접고 무엇을 남기나)은 의존 없는 모듈에 둔다 — 화면 코드는 node 에서 로드조차 안 되므로
//  그 규칙을 값으로 지킬 수 없다. 그래서 갈라 둔다(sess-face 와 같은 규율).
import { dockHead, elapsed, visibleTasks, type TaskInfo } from './session-tasks-view.js';
import {
  answersReady, applySlash, askChoices, askDetail, askHeadline, askIsRisky, askKind, askWhy,
  buildAnswers, factChips, isQuestion,
  slashMatches, slashQuery, terminalOnlyNote, usageLine, usageTight,
  type AskInfo, type FactsInfo, type UsageInfo,
} from './session-surface-view.js';

export interface SessionTasksHandle { destroy(): void }

export interface SessionTasksOpts {
  sessionId: string;
  /**
   * 이 하네스가 **웹에서 못 하는 축들**(서버의 terminalOnly). 화면이 그 사실을 한 줄로 말한다.
   *  ⚠ 안 주면 안내가 안 뜬다 — 그러면 사람은 없는 기능을 찾아 헤맨다(막다른 길).
   */
  terminalOnly?: readonly string[];
  /**
   * 승인 카드를 **이 표면이 그리나**. 기본 true.
   *  ⚠ false 는 «승인이 없다» 가 아니라 «다른 층이 이미 그린다» 는 뜻이다(codex 의 실시간 층).
   *   두 층이 함께 그리면 한 번의 승인에 카드가 두 장 뜨고, 하나를 누르면 남은 하나가 유령이 된다.
   */
  drawAsks?: boolean;
  /**
   * 슬래시 자동완성을 붙일 입력칸. 없으면 그 축은 안 그린다.
   *  ⚠ 터미널에선 `/` 를 치면 목록이 뜬다 — 웹에 그게 없으면 그건 **기능 없음**이지 «디자인 차이» 가 아니다.
   */
  input?: HTMLTextAreaElement | null;
}

//  토큰은 주소가 아니라 헤더로 — EventSource 를 못 쓰는 이유이자, 이 한 줄이 그 대가를 갚는 자리다.
function authHeaders(base: Record<string, string>): Record<string, string> {
  const tok = localStorage.getItem(TOKEN_KEY);
  return tok ? { ...base, Authorization: 'Bearer ' + tok } : base;
}

const KIND_ICON: Record<string, string> = { shell: '⌘', agent: '◆', other: '•' };
const STATUS_LABEL: Record<string, string> = {
  running: '도는 중', completed: '끝남', failed: '실패', killed: '중단됨',
};

/**
 * 작업 도크를 붙인다. 세션 상태 통로(SSE)를 구독해 목록을 그린다.
 *
 *  ⚠ 도는 작업이 없으면 **통째로 숨긴다** — 빈 상자를 늘 띄워 두면 대화가 그만큼 밀린다.
 */
export function mountSessionTasks(host: HTMLElement, o: SessionTasksOpts): SessionTasksHandle {
  let tasks: TaskInfo[] = [];
  let facts: FactsInfo = {};
  let closed = false;
  const ctl = new AbortController();

  //  ── 자리 순서 = 급한 순서 ───────────────────────────────────────────────────────
  //  승인이 **맨 위**다: 답해야 턴이 진행되는 유일한 것이라, 작업 목록에 밀려 화면 밖으로 나가면 안 된다.
  //  그다음 작업(지금 무엇이 도나), 마지막이 사실·사용량(알아 두면 좋은 것).
  const asksWrap = el('div', { class: 'cxl-asks' });          // ★ codex 승인과 **같은 클래스** — 화면이 하네스마다 갈리지 않게
  const wrap = el('div', { class: 'stk-dock' });
  const info = el('div', { class: 'stk-info' });
  wrap.hidden = true;
  info.hidden = true;
  host.append(asksWrap, wrap, info);

  const askCards = new Map<string, HTMLElement>();

  function paint(): void {
    const now = Date.now();
    //  끝난 작업은 잠깐만 남긴다 — 결과를 볼 틈은 주되 목록이 무한히 자라지 않게.
    const show = visibleTasks(tasks, now);
    wrap.hidden = show.length === 0;
    if (!show.length) { wrap.replaceChildren(); return; }

    wrap.replaceChildren(
      el('div', { class: 'stk-head', text: dockHead(show) }),
      ...show.map((t) => el('div', { class: `stk-row stk-${t.status}` },
        el('span', { class: 'stk-ic', text: KIND_ICON[t.kind] ?? '•' }),
        el('span', { class: 'stk-title', text: t.title || (t.kind === 'agent' ? '서브에이전트' : '명령') }),
        //  서브에이전트는 «무엇이 도는지» 가 종류에 있다 — 셸과 같은 줄에서 구분되게 칩으로 세운다.
        t.kind === 'agent' && t.agentType ? el('span', { class: 'stk-chip', text: t.agentType }) : null,
        t.depth && t.depth > 1 ? el('span', { class: 'stk-chip', text: `${t.depth}겹` }) : null,
        el('span', { class: 'stk-state', text: STATUS_LABEL[t.status] ?? t.status }),
        el('span', { class: 'stk-time', text: elapsed(t, now) }),
      )),
    );
  }

  //  도는 작업이 있으면 경과 시간을 1초마다 다시 그린다(없으면 타이머도 안 돈다).
  const tick = setInterval(() => { if (tasks.some((t) => t.status === 'running')) paint(); }, 1000);

  // ── 승인 ──────────────────────────────────────────────────────────────────────
  //  이 화면에서 **사람이 답해야 에이전트가 움직이는** 유일한 순간이다. 그래서:
  //   · 입력칸 바로 위에 선다(스크롤을 올려도 안 사라진다 — 사라지면 그 턴이 통째로 선다).
  //   · 무엇을 하려는지 **원문 그대로** 보여 준다(요약하면 무엇을 허용하는지 모른다).
  //   · 되돌리기 어려운 것은 **경고 줄**을 세운다(모르고 누르지 않게 — 대신 결정하지는 않는다).
  async function answerAsk(ask: AskInfo, choice: { label: string; hint: string; primary?: boolean; value: { allow: boolean; scope?: 'once' | 'always'; optionId?: string; answers?: Record<string, string | string[]> } }, card: HTMLElement): Promise<void> {
    card.classList.add('is-busy');
    try {
      const res = await fetch(apiUrl(`/api/ui/terminal/sessions/${encodeURIComponent(o.sessionId)}/events/answer`), {
        method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
        credentials: 'same-origin', body: JSON.stringify({ id: ask.id, value: choice.value }),
      });
      if (!res.ok) throw new Error(`답하지 못했습니다 (${res.status})`);
      const j = await res.json().catch(() => ({})) as { stale?: boolean };
      //  stale = 이미 처리됐거나 시간이 지나 닫혔다. 지어내지 않고 사실대로 적는다.
      settleAsk(ask.id, j?.stale ? '이미 닫힘' : choice.label);
    } catch (e) {
      card.classList.remove('is-busy');
      settleAsk(ask.id, (e as Error)?.message || '답하지 못했습니다');
    }
  }

  /**
   * **질문 카드** — 에이전트가 준 선택지 중에서 고른다 (#2439).
   *
   *  ⚠ 승인 카드와 **다른 그림**이다: [허용]/[거부] 가 아니라 **선택지 버튼**이고, 답은
   *   `answers`(키=질문 전문, 값=고른 label)로 간다. 승인으로 그리면 [허용] 을 눌러도 답이 안 채워져
   *   툴이 "The user did not answer the questions" 로 끝난다(실측) — 화면은 영원히 도는 것처럼 보인다.
   */
  function drawQuestion(ask: AskInfo): void {
    const qs = ask.questions ?? [];
    const card = el('div', { class: 'cxl-ask stk-q', role: 'group', 'aria-label': qs[0]?.question ?? '질문' });
    //  고른 것 — 질문마다 label 묶음(여러 개 고르는 질문이 있어 배열이다).
    const picked: string[][] = qs.map(() => []);
    const send = el('button', { class: 'cxl-ask-btn is-go', type: 'button', text: '보내기', disabled: '' }) as HTMLButtonElement;

    function repaintSend(): void { send.disabled = !answersReady(qs, picked); }

    card.append(
      el('div', { class: 'cxl-ask-head' },
        el('span', { class: 'cxl-ask-kind', text: '질문' }),
        el('span', { class: 'cxl-ask-title', text: qs.length > 1 ? `${qs.length}가지를 물어봐요` : (qs[0]?.header || '골라 주세요') })),
      ...qs.map((q, qi) => el('div', { class: 'stk-q-item' },
        el('div', { class: 'stk-q-text', text: q.question }),
        q.multiSelect ? el('div', { class: 'stk-q-hint', text: '여러 개 고를 수 있어요' }) : null,
        el('div', { class: 'stk-q-opts' }, ...q.options.map((o) => {
          const b = el('button', { class: 'stk-q-opt', type: 'button' },
            el('span', { class: 'stk-q-label', text: o.label }),
            o.description ? el('span', { class: 'stk-q-desc', text: o.description }) : null,
          ) as HTMLButtonElement;
          b.addEventListener('click', () => {
            if (q.multiSelect) {
              const i = picked[qi].indexOf(o.label);
              if (i >= 0) picked[qi].splice(i, 1); else picked[qi].push(o.label);
              b.classList.toggle('is-on', picked[qi].includes(o.label));
            } else {
              picked[qi] = [o.label];
              //  하나만 고르는 질문은 형제 버튼의 표시를 끈다.
              b.parentElement?.querySelectorAll('.stk-q-opt').forEach((x) => x.classList.remove('is-on'));
              b.classList.add('is-on');
            }
            repaintSend();
          });
          return b;
        })),
      )),
      el('div', { class: 'cxl-ask-acts' }, send,
        el('button', { class: 'cxl-ask-btn', type: 'button', title: '답하지 않고 닫습니다 — 에이전트가 그 사실을 알고 이어갑니다',
          text: '건너뛰기', onclick: () => { void answerAsk(ask, { label: '건너뜀', value: { allow: false, scope: 'once' }, hint: '' }, card); } })),
    );
    send.addEventListener('click', () => {
      void answerAsk(ask, { label: '보냄', value: { allow: true, scope: 'once', answers: buildAnswers(qs, picked) }, hint: '' }, card);
    });
    askCards.set(ask.id, card);
    asksWrap.append(card);
  }

  function drawAsk(ask: AskInfo): void {
    if (askCards.has(ask.id)) return;                 // 재접속 replay — 카드를 두 장 만들지 않는다
    //  ★ 질문과 승인은 **다른 그림**이다(위 머리말).
    if (isQuestion(ask)) { drawQuestion(ask); return; }
    const choices = askChoices(ask);
    const risky = askIsRisky(ask);
    //  ⚠ 위험은 **카드째로** 티가 나야 한다. 안쪽 경고 상자만으로는 훑을 때 옆 카드와 구분이 안 되고,
    //   승인 카드가 여러 장 쌓이면 «어느 게 위험한 거였지» 가 된다.
    const card = el('div', { class: 'cxl-ask' + (risky ? ' is-risky' : ''), role: 'group', 'aria-label': askHeadline(ask) });
    //  ⚠ **`.filter(Boolean)` 이 없으면 안 된다.** `el()` 은 null 자식을 거르지만 DOM 의 `append()` 는
    //   null 을 **"null" 이라는 글자로** 넣는다 — 실제로 카드에 «null» 이 찍혀 있었다(2026-09-01 화면 확인).
    //   같은 이유로 아래 replaceChildren 도 걸러서 넘긴다.
    card.append(...[
      el('div', { class: 'cxl-ask-head' },
        el('span', { class: 'cxl-ask-kind', text: askKind(ask) }),
        el('span', { class: 'cxl-ask-title', text: askHeadline(ask) })),
      //  ⚠ 위험 경고는 **본문 위**에 둔다 — 명령을 읽고 나서 보면 이미 눌렀을 수 있다.
      risky ? el('div', { class: 'stk-warn', text: '⚠ 되돌리기 어려운 작업이에요. 명령을 꼭 읽어 보세요.' }) : null,
      el('pre', { class: 'cxl-ask-body' }, el('code', { text: askDetail(ask) })),
      (() => { const w = askWhy(ask); return w ? el('div', { class: 'stk-askwhy', text: w }) : null; })(),
      el('div', { class: 'cxl-ask-acts' },
        //  ★ 위험한 요청에는 **아무 버튼도 파랗게 세우지 않는다.** `rm -rf` 옆의 큰 파란 [허용] 은
        //   «여길 누르세요» 로 읽힌다 — 되돌릴 수 없는 일에는 손이 먼저 가게 두면 안 된다.
        ...choices.map((c) => el('button', {
          class: 'cxl-ask-btn' + (c.primary && !risky ? ' is-go' : ''), type: 'button', title: c.hint, text: c.label,
          onclick: () => { void answerAsk(ask, c, card); },
        }))),
    ].filter(Boolean));
    askCards.set(ask.id, card);
    asksWrap.append(card);
  }

  function settleAsk(id: string, said: string): void {
    const card = askCards.get(id);
    if (!card) return;
    askCards.delete(id);
    card.classList.remove('is-busy');
    card.classList.add('is-done');
    card.querySelector('.cxl-ask-acts')?.replaceChildren(el('span', { class: 'cxl-ask-said', text: said }));
    //  답한 카드는 잠깐 남긴다 — 즉시 사라지면 무엇을 골랐는지 알 수 없다.
    window.setTimeout(() => { if (!closed) card.remove(); }, 2600);
  }

  // ── 사실·사용량 ────────────────────────────────────────────────────────────────
  //  ⚠ **말할 것이 없으면 통째로 숨긴다.** 늘 떠 있는 줄은 대화를 그만큼 밀어낸다.
  let usageText = '';
  let usageHot = false;
  const onlyNote = terminalOnlyNote(o.terminalOnly ?? []);
  function paintInfo(): void {
    const chips = factChips(facts);
    info.hidden = chips.length === 0 && !usageText && !onlyNote;
    info.replaceChildren(...[
      ...chips.map((t) => el('span', { class: 'stk-fact', text: t })),
      //  ⚠ 곧 막힐 사용량은 **색으로 먼저** 온다 — 회색 92% 는 그냥 숫자로 읽히고 지나간다.
      usageText ? el('span', { class: 'stk-fact' + (usageHot ? ' stk-hot' : ''), text: usageText }) : null,
      //  ⚠ 안내는 칩이 없어도 뜬다 — «못 하는 것» 을 아는 게 «무슨 모델인지» 아는 것보다 급하다.
      onlyNote ? el('span', { class: 'stk-fact stk-only', text: onlyNote }) : null,
    ].filter(Boolean));
  }
  paintInfo();

  // ── 슬래시 자동완성 ────────────────────────────────────────────────────────────
  //  터미널에선 `/` 를 치면 목록이 뜬다. 웹에 그게 없으면 **기능 없음**이다(디자인 차이가 아니다).
  const menu = el('div', { class: 'stk-slash', hidden: true });
  let picks: ReturnType<typeof slashMatches> = [];
  let sel = 0;
  host.append(menu);

  function closeMenu(): void { menu.hidden = true; picks = []; sel = 0; }

  function paintMenu(): void {
    const ta = o.input;
    if (!ta) return;
    const q = slashQuery(ta.value, ta.selectionStart ?? ta.value.length);
    if (q === null || !(facts.commands?.length)) { closeMenu(); return; }
    picks = slashMatches(facts.commands, q);
    if (!picks.length) { closeMenu(); return; }
    sel = Math.min(sel, picks.length - 1);
    menu.hidden = false;
    menu.replaceChildren(...picks.map((c, i) => el('div', {
      class: 'stk-slash-row' + (i === sel ? ' is-sel' : ''),
      //  ⚠ mousedown 으로 받는다 — click 은 blur 뒤에 와서 입력칸이 이미 포커스를 잃는다.
      onmousedown: (ev: Event) => { ev.preventDefault(); choose(i); },
    },
      el('span', { class: 'stk-slash-name', text: '/' + c.name }),
      c.description ? el('span', { class: 'stk-slash-desc', text: c.description }) : null,
    )));
  }

  function choose(i: number): void {
    const ta = o.input;
    const c = picks[i];
    if (!ta || !c) return;
    const next = applySlash(ta.value, ta.selectionStart ?? ta.value.length, c.name);
    ta.value = next.text;
    ta.setSelectionRange(next.caret, next.caret);
    ta.dispatchEvent(new Event('input', { bubbles: true }));   // 입력칸 높이 자동조절이 따라오게
    closeMenu();
    ta.focus();
  }

  const onInput = (): void => paintMenu();
  const onKey = (ev: KeyboardEvent): void => {
    if (menu.hidden || !picks.length) return;
    if (ev.key === 'ArrowDown') { sel = (sel + 1) % picks.length; paintMenu(); ev.preventDefault(); return; }
    if (ev.key === 'ArrowUp') { sel = (sel - 1 + picks.length) % picks.length; paintMenu(); ev.preventDefault(); return; }
    //  ⚠ Enter 는 **목록이 열려 있을 때만** 가로챈다 — 안 그러면 평소 보내기가 막힌다.
    if (ev.key === 'Enter' || ev.key === 'Tab') { choose(sel); ev.preventDefault(); ev.stopPropagation(); return; }
    if (ev.key === 'Escape') { closeMenu(); ev.preventDefault(); ev.stopPropagation(); }
  };
  if (o.input) {
    o.input.addEventListener('input', onInput);
    //  ⚠ capture 로 받는다 — 입력칸의 기존 Enter 처리(보내기)보다 **먼저** 봐야 가로챌 수 있다.
    o.input.addEventListener('keydown', onKey, true);
    o.input.addEventListener('blur', () => window.setTimeout(closeMenu, 120));
  }

  function handle(ev: unknown): void {
    const e = ev as { t?: string; tasks?: TaskInfo[]; ask?: AskInfo; id?: string; facts?: FactsInfo; usage?: UsageInfo };
    //  ★ 서버가 접어서 스냅샷으로 준다 — 화면은 접지 않는다.
    if (e?.t === 'tasks.snapshot' && Array.isArray(e.tasks)) { tasks = e.tasks; paint(); return; }
    if (e?.t === 'permission.asked' && e.ask?.id) { if (o.drawAsks !== false) drawAsk(e.ask); return; }
    //  다른 창에서 답했거나 시간이 지나 닫혔다 — 이 화면의 카드도 함께 접는다(죽은 버튼을 남기지 않는다).
    if (e?.t === 'permission.resolved' && e.id) { settleAsk(e.id, '닫힘'); return; }
    if (e?.t === 'facts' && e.facts) {
      //  ⚠ **덮어쓰지 않고 겹친다** — 하네스는 사실을 조각조각 보낸다(모델 따로, MCP 따로).
      //   통째로 갈면 방금 받은 슬래시 목록이 다음 조각에 지워진다.
      facts = { ...facts, ...e.facts };
      paintInfo(); paintMenu();
      return;
    }
    if (e?.t === 'usage' && e.usage) {
      const line = usageLine(e.usage);
      //  ⚠ 값이 없는 usage(턴 끝 신호 등)에 **앞의 숫자를 지우지 않는다** — 지우면 한도가 깜빡인다.
      if (line) { usageText = line; usageHot = usageTight(e.usage); }
      paintInfo();
      return;
    }
    //  ★ 모르는 이벤트는 조용히 건너뛴다(새 표면이 생겨도 화면이 안 깨진다).
  }

  //  ── 스트림 ────────────────────────────────────────────────────────────────────
  //  EventSource 는 헤더를 못 싣는다(토큰이 주소로 샌다) — fetch 스트림으로 읽는다.
  //  ★ 서버가 25초마다 하트비트를 보내므로, 그보다 넉넉한 동안 **한 바이트도 안 오면 죽은 것**이다.
  //   말 없는 연결을 살아 있는 것으로 착각하면 재접속 루프가 통째로 멈춘다(2026-08-26 실측 사고).
  const SILENCE_MS = 40_000;

  async function pump(): Promise<void> {
    let wait = 1000;
    while (!closed) {
      const attempt = new AbortController();
      const onAbortAll = (): void => attempt.abort();
      ctl.signal.addEventListener('abort', onAbortAll);
      let silence: ReturnType<typeof setTimeout> | null = null;
      const beat = (): void => {
        if (silence) clearTimeout(silence);
        silence = setTimeout(() => attempt.abort(), SILENCE_MS);
      };
      try {
        const res = await fetch(apiUrl(`/api/ui/terminal/sessions/${encodeURIComponent(o.sessionId)}/events`), {
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
          const cut = splitSse(acc);
          acc = cut.rest;
          for (const d of cut.data) {
            try { handle(JSON.parse(d)); } catch { /* 깨진 프레임 한 장은 넘긴다 */ }
          }
        }
      } catch { /* 끊겼다 — 아래에서 다시 붙는다 */ }
      finally {
        if (silence) clearTimeout(silence);
        ctl.signal.removeEventListener('abort', onAbortAll);
      }
      if (closed) break;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 1.6, 15_000);   // 게이트웨이 재기동 중에 폭주하지 않게
    }
  }
  void pump();

  return {
    destroy(): void {
      closed = true;
      clearInterval(tick);
      try { ctl.abort(); } catch { /* noop */ }
      if (o.input) {
        o.input.removeEventListener('input', onInput);
        o.input.removeEventListener('keydown', onKey, true);
      }
      wrap.remove(); asksWrap.remove(); info.remove(); menu.remove();
    },
  };
}

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
import { el, renderInline, renderMarkdown, toast } from './core.js';
import { toolGroupSummary } from './chat-tool-group.js';
import { scanDiff, type DiffScan } from './chat-diff.js';
import { CHAT_FONT_KEY, fontScale, parseFontStep } from './chat-font.js';
import { bindCtx } from './v2/ctx-registry.js';   // #3784 대화 덩이 우클릭(답·질문·코드)
import { copyText } from './v2/ctx-menu.js';
import { prependKeepingView } from './lib/older-autoload.js';   // #3778 위로 붙이는 동안 보던 자리 지키기 — 헤드리스 테스트가 같은 함수를 잰다
// #4707 tui 문법 — 글자 규칙(chat-tui.ts)과 웹 터미널 설정(lib/term-prefs.ts)은 DOM 없는 모듈이 쥔다. 여기는 칠하기만 한다.
import { addToGroup, asyncAgentId, bashPopsOut, dispWidth, fmtElapsed, fmtTokens, groupSegs, groupVisible, isAsyncAgent, mdPlain, newGroup, pickVerb, seedOf, TUI_DIFF_ROWS, TUI_SPIN_FRAMES, tuiCollapse, tuiHighlight, tuiMode, tuiTableLayout, tuiToolHead, tuiToolResult, turnEndSegs, wrapWords, type TuiAlign, type TuiDiffRow, type TuiCollapse, type TuiGroup, type TuiResult, type TuiSeg } from './chat-tui.js';
import { caretShape, isWheelNotch, parseTermPrefs, TERM_PREFS_KEY, termFace, wheelPx, type TermPrefs } from './lib/term-prefs.js';
import { isDark } from './theme.js';

/** 도구 이름 → 사람 말. label 은 필수, detail 은 한 줄 요약(경로·명령 — Claude Code 의 `Read(src/x.ts)` 자리). */
export interface ToolLabel { label: string; detail?: string }

/** tui — 대화 맨 위의 환영 상자(Claude Code 가 세션을 열 때 그리는 첫 화면). */
export interface TuiBanner {
  title: string;            // 'Claude Code'
  version?: string;         // 하네스 버전(대화 파일의 version)
  welcome: string;          // 'Welcome back 윤상민!'
  model?: string;           // 'Opus 5.5'
  cwd?: string;             // 작업 폴더
  mascot?: boolean;         // Claude Code 의 그 얼굴(claude 하네스만)
}

/** 대화창 안에서 웹 터미널 설정이 바뀌었다고 알리는 같은 문서 신호(localStorage 의 storage 신호는 **다른** 문서에만 간다). */
export const TERM_PREFS_EVENT = 'lively:term-prefs';

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
   *  · tui — Claude Code **터미널 화면** 문법(#4707 상민님 지시 «클로드코드 tui랑 최대한 똑같이»): 고정폭 글꼴 한 벌,
   *    `> 내 말` · `⏺ 답` · `⏺ Bash(…)` + `⎿  결과`(앞 3줄 + `… +N lines`, 눌러서·Ctrl+O 로 펼침) · `✻ Cogitating…` 스피너 ·
   *    가로줄 두 개 사이의 `>` 입력줄 + 아래 상태 줄(권한 모드 · `? for shortcuts`). 글꼴·크기·색·커서·스크롤은
   *    **웹 터미널의 환경 설정을 그대로** 쓴다(lib/term-prefs.ts — 상민님 «웹터미널의 설정이 똑같이 대화화면에도»).
   */
  style?: 'journal' | 'desktop' | 'tui';
  bar?: { left?: HTMLElement | null; right?: HTMLElement | null };   // desktop 입력칸 아래 바에 앉힐 것(모드·모델 등 — 호출자가 채움)
  /** 이 대화에 딸린 파일 첨부 UI. 입력칸과 같은 form 안에 두어 붙여넣기·선택·전송이 한 흐름이 되게 한다. */
  compose?: { chips?: HTMLElement | null; button?: HTMLElement | null; fileInput?: HTMLElement | null };
  /** 글자가 없어도 보낼 수 있는 다른 입력(예: 이미 끝난 파일 첨부)이 있나. */
  canSendEmpty?: () => boolean;
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
  /** tui — 이 턴에 쓴 출력 토큰(응답 id → 그 응답의 output_tokens). 스피너의 `↓ 1.2k tokens` 가 이걸 더한다. */
  tok?: Map<string, number>;
}

export interface ChatView {
  root: HTMLElement; list: HTMLElement; input: HTMLTextAreaElement; form: HTMLFormElement; noteEl: HTMLElement;
  /** 새 턴(사람 말 한 마디). userText=null 이면 사람 말 없이 AI 가 한 일만(창을 중간부터 읽을 때). */
  turn(userText: string | null, opts?: { ts?: string; at?: 'end' | 'start' }): ChatTurn;
  /** 완성본 이벤트(assistant/user 메시지)를 그 턴에 반영. text=그 줄에 AI 의 글이 있었나. */
  event(t: ChatTurn, ev: any): { text?: string };
  /** 조각(stream_event) — 글자가 오는 대로. */
  stream(t: ChatTurn, ev: any): void;
  /**
   * 그 턴 끝 — 흘러오던 덩이를 마감하고 상태점을 끈다. turnEnd — tui 의 턴 끝 줄(`✻ Churned for 3m 51s · done 6:43 PM`) 재료:
   *  그 턴의 turn_duration 기록(uuid·timestamp·pendingBackgroundAgentCount). 기록이 없는 마감(Stop 훅 요약·폴링 마감)엔 주지 않는다.
   */
  settle(t: ChatTurn, o?: { exit?: number | null; interrupted?: boolean; durationMs?: number; turnEnd?: { uuid?: string; ts?: string; pendingBg?: number } }): void;
  /** 이 턴이 '지금 도는 중'임을 표시(깜빡이는 점 + 경과 시간 줄). */
  running(t: ChatTurn | null): void;
  busy(on: boolean): void;
  scroll(): void;
  scrollToBottom(): void;
  setNote(text: string): void;
  error(t: ChatTurn | null, text: string): void;
  /** 구분선. kind — tui 문법에서만 뜻이 있다: compact = `✻ Conversation compacted`, error = 빨간 `⎿` 한 줄. */
  divider(text: string, details?: string, at?: 'end' | 'start', kind?: 'compact' | 'error'): void;
  /** tui — 입력칸 아래 상태 줄의 권한 모드(대화 파일의 permissionMode). 다른 문법에선 아무것도 안 한다. */
  setPermissionMode(mode: string | null): void;
  /** tui — 대화 맨 위 환영 상자. null 이면 걷는다. 다른 문법에선 아무것도 안 한다. */
  banner(b: TuiBanner | null): void;
  /** tui — `● Agent "…" finished · 1m 1s` 같은 한 줄 알림(점 색 = tone). 다른 문법에선 아무것도 안 한다. */
  notice(t: ChatTurn | null, text: string | TuiSeg[], tone?: 'ok' | 'err' | 'dim'): void;
  /** tui — 백그라운드 에이전트 하나가 끝났다(완료 알림의 task-id). 턴 끝 줄 `Waiting for N background agents` 의 수가 준다. */
  bgDone(id: string): void;
  /** 지금 그림 문법(호출자가 문법별로 말을 고를 때 — 예: 구분선 글). */
  readonly style: 'journal' | 'desktop' | 'tui';
  removeOpening(): void;
  setFooter(f: HTMLElement | null): void;
  turns(): ChatTurn[];
  /** 위에 끼워 넣기(이전 기록 불러오기) — 보고 있던 자리를 지킨다. */
  prependKeepingView(fn: () => void): void;
  /** 글자 크기 단계(0..3)를 바꾸고 이 브라우저에 기억한다. */
  setFontStep(step: number): void;
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
// ── 변경분(diff) ────────────────────────────────────────────────────────────────────────
//  판정·세기는 순수 모듈(web/chat-diff.ts)이 쥔다 — 여기는 그 결과를 칠하기만 한다. 색만으로 말하지 않는다:
//  +/- 부호가 원문 그대로 남고 배경 톤은 그걸 거들 뿐이다(§0.5 색각 계약).
function diffPre(d: DiffScan): HTMLElement {
  const pre = el('pre', { class: 'livc-diff' });
  for (const l of d.lines) pre.append(el('span', { class: 'livc-dl' + (l.kind ? ' is-' + l.kind : ''), text: l.text + '\n' }));
  return pre;
}
function rawPart(cap: string, body: string): HTMLElement {
  const s = String(body ?? '');
  const shown = s.slice(0, 4000);
  const more = s.length > 4000 ? ' · 앞 4,000자' : '';
  const d = scanDiff(shown);
  if (d.isDiff) {
    // 펼치기 전에도 규모를 알 수 있게 머리에 +N -N 을 적는다 — 한 줄 고침과 300줄 갈아엎기는 다른 일이다.
    return el('div', { class: 'livc-raw-part' },
      el('div', { class: 'livc-raw-cap' },
        el('span', { text: cap + ' · ' }),
        el('b', { class: 'livc-dc-add', text: `+${d.add}` }),
        el('span', { text: ' ' }),
        el('b', { class: 'livc-dc-del', text: `-${d.del}` }),
        el('span', { text: more })),
      diffPre(d));
  }
  return el('div', { class: 'livc-raw-part' },
    el('div', { class: 'livc-raw-cap', text: cap + more }),
    el('pre', { text: shown }));
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

/**
 * tui — 답 글을 Claude Code 처럼 **줄 단위로** 그린다(#4707). 그 화면은 원문의 줄바꿈·빈 줄을 그대로 살린다 — 문단 안의
 *  줄바꿈도 줄바꿈이고, 빈 줄이 있던 자리에만 빈 줄이 선다(문단 뒤에 붙여 쓴 목록은 붙어서 나온다). 블록 단위 렌더러
 *  (lib/markdown.ts)는 그 빈 줄 정보를 버려서 «문단 사이 빈 줄 · 목록 앞 붙음» 이 터미널과 어긋났다(2026-10-14 두 화면 실측).
 *  꾸밈(굵게·기울임·코드·링크)은 앱의 인라인 렌더러를 그대로 쓴다 — 링크·경로 열기 규칙이 한 벌로 남는다(textContent 기반, XSS 없음).
 */
function tuiMarkdown(src: string, cols = 80): HTMLElement {
  const box = el('div', { class: 'md tui-md' });
  const lines = String(src || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
  const row = (cls: string, ...kids: unknown[]): HTMLElement => el('div', { class: 'tui-ml ' + cls }, ...kids);
  const cw = (n: number): string => `calc(var(--tui-cw) * ${n})`;
  const cells = (l: string): string[] => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*([\w.+#-]*)/.exec(line);
    if (fence) {
      //  코드 블록 — 울타리 줄은 그리지 않고 안의 줄만. Claude Code 2.1.299: 언어가 없으면 글자를 권한색(인라인 코드와 같은 보라)으로,
      //   언어가 있으면 문법 색으로 찍는다(들여쓰기·바탕 없음).
      const close = new RegExp('^\\s*\\' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
      const lang = fence[2] || '';
      const code: string[] = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) code.push(lines[i]);
      i++;
      const pre = el('pre', { class: 'tui-code' + (lang ? '' : ' tui-code-plain') });
      code.forEach((l, k) => {
        const ln = el('span', { class: 'tui-cl' });
        if (lang) paintCode(ln, l, lang, false); else ln.textContent = l;
        pre.append(ln, k < code.length - 1 ? '\n' : '');
      });
      box.append(pre);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c): TuiAlign => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : 'left'));
      const body: string[][] = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) body.push(cells(lines[i]));
      box.append(...tuiTable(head, body, align, cols));
      continue;
    }
    i++;
    if (!line.trim()) { box.append(row('tui-blank')); continue; }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      //  제목 뒤엔 원문에 빈 줄이 없어도 한 줄을 띄운다(Claude Code 의 제목 = 굵게 + 빈 줄).
      box.append(row('tui-h tui-h' + h[1].length, ...renderInline(h[2])));
      if (i < lines.length && lines[i].trim()) box.append(row('tui-blank'));
      continue;
    }
    //  가로줄 — Claude Code 는 `---` 를 글자 그대로 찍는다.
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { box.append(row('tui-p tui-hr', '---')); continue; }
    const li = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
    if (li) {
      //  글머리는 `-`(Claude Code 는 *·+ 도 - 로 찍는다) · 번호는 그대로. 줄이 넘치면 글머리 뒤에 맞춰 이어진다(걸친 들여쓰기).
      const ind = li[1].replace(/\t/g, '  ').length;
      const mk = /\d/.test(li[2]) ? li[2] : '-';
      const r = row('tui-li', el('span', { class: 'tui-li-m', text: mk + ' ' }), ...renderInline(li[3]));
      r.style.paddingLeft = cw(ind + mk.length + 1);
      r.style.textIndent = `calc(var(--tui-cw) * -${mk.length + 1})`;
      box.append(r);
      continue;
    }
    const bq = /^\s*>\s?(.*)$/.exec(line);
    if (bq) { box.append(row('tui-bq', ...renderInline(bq[1]))); continue; }
    const lead = (/^\s*/.exec(line)?.[0] || '');
    const p = row('tui-p', ...renderInline(line.slice(lead.length)));
    if (lead) p.style.paddingLeft = cw(lead.replace(/\t/g, '  ').length);
    box.append(p);
  }
  return box;
}
/**
 * 표 — Claude Code 2.1.299 의 그 꼴(chat-tui.ts tuiTableLayout 이 고른다): 들어가면 상자 표(`┌─┬─┐` · 머리 가운데 · 행마다 칸막이),
 *  넘치면 세로꼴(`**머리:** 값` · 행 사이 `─`). 한 줄에 다 든 칸은 꾸밈(코드·굵게·링크)을 그대로 칠하고, 접힌 칸은 맨글로 잇는다.
 */
function tuiTable(head: string[], rows: string[][], align: TuiAlign[], cols: number): HTMLElement[] {
  const lay = tuiTableLayout(head, rows, cols);
  const row = (cls: string, ...kids: unknown[]): HTMLElement => el('div', { class: 'tui-ml ' + cls }, ...kids);
  if (lay.kind === 'vertical') {
    return lay.lines.map((l) => ('sep' in l ? row('tui-p tui-tsep', l.sep)
      : row('tui-p', ...(l.head ? [el('b', { text: l.head + ':' }), ' '] : []), ...(l.raw != null ? renderInline(l.raw) : [l.text]))));
  }
  const W = lay.widths;
  const rule = (a: string, m: string, b: string): HTMLElement => row('tui-tl', a + W.map((w) => '─'.repeat(w + 2)).join(m) + b);
  const band = (cs: string[], center: boolean): HTMLElement[] => {
    const wrapped = cs.map((c, k) => wrapWords(mdPlain(c), W[k], lay.hard));
    const h = Math.max(1, ...wrapped.map((w) => w.length));
    const off = wrapped.map((w) => Math.floor((h - w.length) / 2));
    const out: HTMLElement[] = [];
    for (let j = 0; j < h; j++) {
      const kids: unknown[] = ['│'];
      cs.forEach((c, k) => {
        const at = j - off[k];
        const txt = at >= 0 && at < wrapped[k].length ? wrapped[k][at] : '';
        const pad = Math.max(0, W[k] - dispWidth(txt));
        const al = center ? 'center' : align[k] || 'left';
        const lp = al === 'right' ? pad : al === 'center' ? Math.floor(pad / 2) : 0;
        kids.push(' ' + ' '.repeat(lp), ...(wrapped[k].length === 1 && at === 0 ? renderInline(c) : [txt]), ' '.repeat(pad - lp) + ' │');
      });
      out.push(row('tui-tl', ...kids));
    }
    return out;
  };
  const out: HTMLElement[] = [rule('┌', '┬', '┐'), ...band(head, true), rule('├', '┼', '┤')];
  rows.forEach((r, k) => { out.push(...band(head.map((_, c) => r[c] ?? ''), false)); if (k < rows.length - 1) out.push(rule('├', '┼', '┤')); });
  out.push(rule('└', '┴', '┘'));
  return out;
}

/** AI 가 한 말 한 덩이 — 마크다운(textContent 기반, XSS 없음). 코드 블록엔 복사 버튼을 단다. render — tui 는 줄 단위 렌더러(tuiMarkdown). */
function said(text: string, render: (s: string) => HTMLElement = renderMarkdown): HTMLElement {
  const box = el('div', { class: 'livc-said' }, render(text));
  decorateCode(box);
  // 답 한 덩이를 그대로 가져가는 자리 — 코드블록 복사와 같은 문법(손을 올려야 드러난다). 붙여넣을 것은 화면의
  //  마크다운이 아니라 **원문**이라, 그린 결과가 아니라 받은 글자를 그대로 준다.
  box.append(copyBtn(text, 'livc-said-copy', '답 복사'));
  // #3784 우클릭 — 답 복사 · 인용해서 묻기(입력칸에 > 로 담는다) · 코드 블록 위면 코드 복사
  bindCtx(box, (hit, ev) => {
    const pre = ev.target.closest('pre');
    const code = pre ? String(pre.textContent || '') : '';
    return {
      title: 'AI 의 답', sub: text.length > 60 ? text.slice(0, 60).replace(/\s+/g, ' ') + '…' : text,
      rows: [
        ...(code ? [{ label: '코드 복사', icon: 'code', run: () => void copyText(code).then((ok) => { if (ok) toast('코드를 복사했어요'); }) }] : []),
        { label: '답 복사', icon: 'copy', hint: '원문(마크다운)', run: () => void copyText(text).then((ok) => { if (ok) toast('복사했어요'); }) },
        { label: '인용해서 묻기', icon: 'quote', run: () => quoteInto(hit.el, ev.selection || text) },
      ],
    };
  });
  return box;
}
/** 대화창 입력칸에 인용(> …)을 담는다 — 보내지는 않는다. 같은 대화창(livc-wrap)의 입력칸을 찾는다. */
function quoteInto(from: HTMLElement, text: string): void {
  const ta = from.closest('.livc-wrap')?.querySelector('.livc-input') as HTMLTextAreaElement | null;
  if (!ta) { void copyText(text).then((ok) => { if (ok) toast('입력칸이 없어 복사만 했어요'); }); return; }
  const q = text.trim().split('\n').slice(0, 12).map((l) => '> ' + l).join('\n') + '\n\n';
  ta.value = (ta.value ? ta.value.replace(/\s+$/, '') + '\n\n' : '') + q;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}
/** 복사 버튼 하나 — 누르면 잠깐 '복사됨'으로 바뀐다(눌렸는지 알 수 없는 버튼을 만들지 않는다). */
function copyBtn(text: string, cls: string, aria: string): HTMLElement {
  const btn: HTMLElement = el('button', {
    class: cls, type: 'button', text: '복사', 'aria-label': aria,
    onclick: async () => {
      try { await navigator.clipboard.writeText(text); btn.textContent = '복사됨'; setTimeout(() => { btn.textContent = '복사'; }, 1200); }
      catch { toast('복사하지 못했습니다 — 직접 선택해 복사해 주세요.'); }
    },
  });
  return btn;
}
function decorateCode(box: HTMLElement): void {
  box.querySelectorAll('pre').forEach((pre) => {
    if (pre.parentElement?.classList.contains('livc-code')) return;
    const wrap = el('div', { class: 'livc-code' });
    pre.replaceWith(wrap);
    wrap.append(pre, copyBtn(pre.textContent || '', 'livc-copy', '코드 복사'));
  });
}

/** 생각(thinking) 블록 — 접힌 카드. Claude Code 의 "✻ Thinking…" 자리. 글자 수만 머리에 보이고 본문은 펼쳐야 보인다. */
function thinkCard(text: string): HTMLElement {
  const n = text.length;
  return el('details', { class: 'livc-think' },
    el('summary', {}, el('span', { class: 'livc-think-k', text: '생각' }), el('span', { class: 'livc-think-n', text: n >= 1000 ? `${(n / 1000).toFixed(1)}천자` : `${n}자` })),
    el('div', { class: 'livc-think-body', text }));
}

// ── tui 조각 (#4707) ─────────────────────────────────────────────────────────────────────
//  글자 규칙은 chat-tui.ts 가 정했다 — 여기는 그 줄들을 고정폭 칸에 앉힌다. 표식(⏺ ⎿ ✻)의 자리·색은 38-chat-tui.css 가 쥔다.
//  ⚠ ⏺·⏸·✳ 은 이모지 판(컬러 그림)이 있는 글자라 글꼴에 따라 그림으로 뜬다 — 글자 판 선택자(U+FE0E)를 붙여 터미널처럼 글자로 세운다.
const VS15 = '︎';
/** 결과 한 줄. */
const rl = (text: string, cls?: string): HTMLElement => el('div', { class: 'tui-rl' + (cls ? ' ' + cls : ''), text });
/** 펼칠 수 있는 결과의 안내 줄 — `… +N lines (ctrl+o to expand)`. 누르면 펼친다(손으로 Ctrl+O 를 칠 필요는 없다). */
//   ⚠ 전체 화면 Claude Code 는 이 줄에 `(ctrl+o to expand)` 를 붙이지 않는다(2.1.299 실측: `… +3 lines` 만, 흐리게).
const moreRow = (n: number): HTMLElement => el('div', { class: 'tui-rl tui-more', role: 'button', tabindex: '-1', title: '눌러서 펼치기 · Ctrl+O 로 전부', text: n > 0 ? `… +${n} line${n === 1 ? '' : 's'}` : '…' });
/** 꾸민 조각(chat-tui.ts TuiSeg) → 칠한 노드들. 굵게 = tui-b · 흐림 = tui-d · +N/-N = tui-add/tui-del. 꾸밈 없는 조각은 글자 그대로. */
function segEls(segs: TuiSeg[]): Node[] {
  return segs.map((s) => (!s.b && !s.d && !s.c ? document.createTextNode(s.t)
    : el('span', { class: [s.b ? 'tui-b' : '', s.d ? 'tui-d' : '', s.c ? 'tui-' + s.c : ''].filter(Boolean).join(' '), text: s.t })));
}
/**
 * 한 줄의 코드를 칠해 into 에 붙인다 — 문법 갈래마다 한 색(tui-hk-*). hl = 짝 줄과 달라진 구간(낱말 단위 강조 바탕).
 *  plain = 칠하지 않는다(지운 줄 — Claude Code 2.1.299 는 지운 줄을 문법 색 없이 찍는다).
 */
function paintCode(into: HTMLElement, text: string, lang: string, plain: boolean, hl?: [number, number]): void {
  const toks = plain ? [{ t: text }] : tuiHighlight(text, lang);
  let at = 0;
  const piece = (t: string, k: string | undefined): Node => (k ? el('span', { class: 'tui-hk-' + k, text: t }) : document.createTextNode(t));
  let hlBox: HTMLElement | null = null;
  for (const tk of toks) {
    let s = tk.t;
    while (s) {
      const inHl = !!hl && at >= hl[0] && at < hl[1];
      const edge = !hl ? s.length : inHl ? hl[1] - at : at < hl[0] ? hl[0] - at : s.length;
      const take = s.slice(0, Math.max(1, Math.min(s.length, edge)));
      if (inHl) {
        let b = hlBox;
        if (!b) { b = el('span', { class: 'tui-hl' }) as HTMLElement; into.append(b); hlBox = b; }
        b.append(piece(take, tk.k));
      }
      else { hlBox = null; into.append(piece(take, tk.k)); }
      at += take.length; s = s.slice(take.length);
    }
  }
}
/**
 * 변경분 — Claude Code 2.1.299 의 그 꼴(실측): ` 186 -` · ` 186 +` · ` 183  ` (앞 칸 + 줄 번호 + 칸 + 부호) 뒤에 코드.
 *  지운 줄·더한 줄은 줄 끝까지 물들고 번호·부호가 빨강/초록, 문맥 줄은 번호가 흐리다. 줄이 넘치면 코드 칸 안에서 이어진다.
 *  signs=false — 부호 칸 없이 번호와 코드만(Write 미리보기).
 */
function diffBlock(rows: TuiDiffRow[], lang: string, signs = true): HTMLElement {
  const numbered = rows.some((r) => r.no != null);
  const w = numbered ? Math.max(1, ...rows.map((r) => (r.no == null ? 0 : String(r.no).length))) : 0;
  const box = el('div', { class: 'tui-diff' });
  for (const r of rows) {
    if (r.kind === 'gap') { box.append(el('div', { class: 'tui-dl is-gap', text: (numbered ? ' '.repeat(w + 2) : '') + '...' })); continue; }
    const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' ';
    const body = el('span', { class: 'tui-dtext' });
    //  같은 자리 짝 줄과 달라진 낱말만 한 단계 짙게(Claude Code 의 낱말 단위 강조). 색만으로 말하지 않는다 — +/- 부호가 그대로 있다.
    paintCode(body, r.text, lang, r.kind === 'del', r.hl && r.hl[1] > r.hl[0] ? r.hl : undefined);
    box.append(el('div', { class: 'tui-dl is-' + r.kind },
      numbered ? el('span', { class: 'tui-dgut', text: ` ${(r.no == null ? '' : String(r.no)).padStart(w)} ` }) : null,
      signs ? el('span', { class: 'tui-dsign', text: sign }) : null, body));
  }
  return box;
}
/** 생각(thinking) — `∴ Thinking…`. 접혀 있고 누르거나 Ctrl+O 로 펼친다(Claude Code 와 같다). */
function tuiThink(text: string): HTMLElement {
  return el('details', { class: 'tui-think' },
    el('summary', { class: 'tui-think-sum', text: '∴ Thinking…' }),
    el('div', { class: 'tui-think-body', text }));
}
/** 결과 칸이 «펼친 상태»로 그려져야 하나 — 그 카드를 눌러 펼쳤거나 대화창 전체가 Ctrl+O 상태. */
const isOpen = (card: HTMLElement): boolean => card.classList.contains('tui-open') || !!card.closest('.tui-verbose');
/** `⎿` 아래를 칠한다. 펼친 상태면 원문 전부, 아니면 Claude Code 가 접어 보이는 만큼. */
function paintTuiResult(card: HTMLElement, r: TuiResult): void {
  const res = card.querySelector(':scope > .tui-res') as HTMLElement | null;
  if (!res) return;
  const open = isOpen(card);
  const expandable = r.full != null || r.more > 0 || (!!r.diff && r.diff.length > TUI_DIFF_ROWS);
  card.classList.toggle('tui-can-open', expandable);
  const kids: HTMLElement[] = [];
  //  요약만 있는 결과(Read · Search …)는 안내를 같은 줄 뒤에 붙인다 — `Found 3 files (ctrl+o to expand)`.
  //  꾸민 요약(`Added **12** lines, removed **7** lines`)은 조각대로 칠한다(숫자 굵게).
  if (r.sumSegs) kids.push(el('div', { class: 'tui-rl tui-sum' }, ...segEls(r.sumSegs)));
  else if (r.summary) kids.push(rl(r.summary, 'tui-sum'));
  if (r.todos) {
    for (const td of r.todos) {
      kids.push(el('div', { class: 'tui-rl tui-todo is-' + td.status },
        el('span', { class: 'tui-todo-box', text: td.status === 'completed' ? '☒ ' : '☐ ' }), el('span', { class: 'tui-todo-t', text: td.text })));
    }
  }
  if (r.diff) {
    const shown = open ? r.diff : r.diff.slice(0, TUI_DIFF_ROWS);
    if (shown.length) kids.push(diffBlock(shown, r.lang || ''));
    if (!open && r.diff.length > TUI_DIFF_ROWS) kids.push(moreRow(r.diff.length - TUI_DIFF_ROWS));
  } else if (r.code && !(open && r.full != null)) {
    //  새 파일 미리보기 — ` 1 ` 흐린 번호 + 문법 색 코드(부호 칸 없음), 남은 줄은 `… +N lines (ctrl+o to expand)`.
    if (r.code.length) kids.push(diffBlock(r.code.map((text, i) => ({ kind: 'ctx' as const, no: i + 1, text })), r.lang || '', false));
    if (r.more > 0) kids.push(moreRow(r.more));
  } else if (open && r.full != null) {
    kids.push(el('div', { class: 'tui-full', text: r.full }));
  } else {
    for (const l of r.lines) kids.push(rl(l));
    if (r.more > 0) kids.push(moreRow(r.more));
    else if (r.lines.length && r.full != null) kids.push(moreRow(0));   // 줄 수는 그대로인데 긴 줄이 잘렸다
  }
  res.replaceChildren(...kids);
  res.classList.toggle('tui-err', r.tone === 'err');
  res.classList.toggle('tui-subtle', r.tone === 'subtle');
  //  따로 선 `⎿` 덩이들 — 셸 명령이 바꾼 파일마다 하나(`Updated **경로** (+a -r)` + 변경분), 흐린 안내 줄, 그리고 자동 모드 판정기가
  //   허락한 호출이면 `Allowed by auto mode classifier`(Claude Code 2.1.299 — 결과 아래 한 줄).
  card.querySelectorAll(':scope > .tui-res-x').forEach((n) => n.remove());
  const extra: HTMLElement[] = [];
  for (const e of r.edits || []) {
    const box2: HTMLElement[] = [el('div', { class: 'tui-rl tui-sum' }, ...segEls(e.segs))];
    if (e.diff.length) box2.push(diffBlock(e.diff, e.lang));
    if (e.hidden > 0) box2.push(rl(`… ${e.hidden} more lines`, 'tui-dim'));
    extra.push(el('div', { class: 'tui-res tui-res-x' }, ...box2));
  }
  for (const n of r.notes || []) extra.push(el('div', { class: 'tui-res tui-res-x tui-dim' }, rl(n)));
  if (card.dataset.allowed === '1') extra.push(el('div', { class: 'tui-res tui-res-x tui-dim' }, rl('Allowed by auto mode classifier')));
  card.append(...extra);
  const head = card.querySelector(':scope > .tui-tool-head');
  if (head) head.setAttribute('aria-expanded', String(open && expandable));
}
/** 환영 상자 — Claude Code 가 세션을 열 때 그리는 첫 화면(좁은 판). */
function tuiBannerEl(b: TuiBanner): HTMLElement {
  return el('div', { class: 'tui-banner', role: 'note', 'aria-label': `${b.title}${b.version ? ' v' + b.version : ''}` },
    el('div', { class: 'tui-banner-t' }, el('span', { class: 'tui-banner-name', text: b.title }), b.version ? el('span', { class: 'tui-banner-ver', text: ' v' + b.version }) : null),
    el('div', { class: 'tui-banner-hi', text: b.welcome }),
    //  그 얼굴 — 터미널에서 Claude Code 가 찍는 블록 글자 그대로. 줄마다 가운데로 맞추면 모양이 어긋나므로 한 덩이로 가운데 둔다.
    b.mascot ? el('div', { class: 'tui-mascot', 'aria-hidden': 'true', text: ' ▐▛███▜▌\n▝▜█████▛▘\n  ▘▘ ▝▝' }) : null,
    b.model ? el('div', { class: 'tui-banner-dim', text: b.model }) : null,
    b.cwd ? el('div', { class: 'tui-banner-dim tui-banner-cwd', text: b.cwd }) : null);
}

//  웹 터미널이 고를 수 있는 글꼴 중 구글 글꼴인 것 — 터미널 페이지(terminal.html)가 싣는 것과 **같은 주소**를 이 문서에도 한 번 싣는다.
//  D2Coding(한글)은 index.html 이 이미 자체 호스팅으로 싣고, Menlo·SF Mono·Monaco·Consolas 는 시스템 글꼴이다.
const TERM_WEB_FONTS = /JetBrains Mono|Fira Code|Source Code Pro|IBM Plex Mono|Roboto Mono/;
const TERM_WEB_FONTS_HREF = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Fira+Code:wght@400;600&family=Source+Code+Pro:wght@400;600&family=IBM+Plex+Mono:wght@400;600&family=Roboto+Mono:wght@400;600&display=swap';
/**
 * 그 글꼴의 @font-face 가 이 문서에 **등록될 때까지** 기다린다. ⚠ 시트가 아직 안 왔을 때 document.fonts.load() 를 부르면 맞는 글꼴이
 *  없어 곧바로 «빈 배열» 로 끝난다 — 그 순간 잰 칸은 대체 글꼴(D2Coding)의 것이라 줄 높이가 15px 로 굳었다(2026-10-14 실측, 터미널은 18.5px).
 */
function ensureTermFonts(family: string): Promise<void> {
  if (!TERM_WEB_FONTS.test(family)) return Promise.resolve();
  let link = document.querySelector('link[data-term-fonts]') as HTMLLinkElement | null;
  if (!link) {
    link = el('link', { rel: 'stylesheet', href: TERM_WEB_FONTS_HREF, 'data-term-fonts': '1' }) as HTMLLinkElement;
    link.addEventListener('load', () => { link!.dataset.loaded = '1'; }, { once: true });
    document.head.append(link);
  }
  if (link.dataset.loaded === '1' || link.sheet) return Promise.resolve();
  const l = link;
  return new Promise((res) => {
    const done = (): void => { l.dataset.loaded = '1'; res(); };
    l.addEventListener('load', done, { once: true });
    l.addEventListener('error', () => res(), { once: true });
    window.setTimeout(res, 8000);   // 글꼴 서버가 막힌 곳 — 대체 글꼴로 산다
  });
}
/** 터미널이 «폰»으로 보는 기기인가 — 기본 글자 크기(폰 12 · 그 밖 14)를 터미널과 같게 고른다(terminal.ts IS_MOBILE 과 같은 판정). */
function termMobile(): boolean {
  try { if (window.matchMedia('(pointer: coarse)').matches) return true; } catch { /* 구형 */ }
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}
function readTermPrefs(): TermPrefs {
  let raw: string | null = null;
  try { raw = localStorage.getItem(TERM_PREFS_KEY); } catch { /* 스토리지가 막힌 브라우저 — 기본값 */ }
  return parseTermPrefs(raw, termMobile());
}
/**
 * xterm 이 이 글꼴로 잡는 **한 칸**의 크기(css px) — 터미널과 같은 격자에 글자를 앉히려고 같은 셈을 한다.
 *  xterm 렌더러: 칸 폭 = floor(글자 폭 × dpr) / dpr · 칸 높이 = ceil(글꼴 상하 높이 × dpr) / dpr(lineHeight 1).
 *  그래서 JetBrains Mono 14px 은 브라우저 글자 폭 8.4px 이 아니라 **8px 칸**에 앉는다(2배 화면). 한글은 두 칸을 쓴다.
 *  반환: w·h = 칸 폭·높이, natW = 브라우저가 그리는 라틴 글자 폭, wide = 한글 한 글자 폭(한글 폴백 글꼴).
 */
function measureCell(family: string, size: number): { w: number; h: number; natW: number; wide: number; box: number } {
  const dpr = window.devicePixelRatio || 1;
  let natW = size * 0.6, natH = size * 1.32, wide = size, box = size * 0.6;
  try {
    const c = document.createElement('canvas').getContext('2d');
    if (c) {
      c.font = `${size}px ${family}`;
      const m = c.measureText('W'.repeat(32));
      natW = m.width / 32;
      const asc = (m as TextMetrics & { fontBoundingBoxAscent?: number }).fontBoundingBoxAscent;
      const desc = (m as TextMetrics & { fontBoundingBoxDescent?: number }).fontBoundingBoxDescent;
      if (Number.isFinite(asc) && Number.isFinite(desc) && (asc as number) + (desc as number) > 0) natH = (asc as number) + (desc as number);
      wide = c.measureText('가'.repeat(16)).width / 16;
      //  상자 글자(─│┌) — 구글 글꼴 판 JetBrains Mono 엔 이 구간이 없어 대체 글꼴로 그려지고 폭이 칸과 다르다(실측 7px vs 칸 8px —
      //   표 테두리가 칸막이와 어긋났다). 터미널(xterm)은 이 글자를 칸에 맞춰 직접 그린다. 그래서 폭을 재어 칸에 맞춘다(--tui-bgap).
      box = c.measureText('─'.repeat(16)).width / 16;
    }
  } catch { /* 캔버스가 막힌 환경 — 어림값 */ }
  return { w: Math.max(1, Math.floor(natW * dpr)) / dpr, h: Math.max(1, Math.ceil(natH * dpr)) / dpr, natW, wide, box };
}
/** 두 칸을 쓰는 글자(한글·한자·전각) — 터미널이 두 칸에 앉히는 것들(동아시아 너비 W·F 의 주요 구간). 뒤의 덩이는 한 칸짜리 상자 글자(─│┌▎). */
const WIDE_RE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]+|\u2500+|[\u2501-\u259f]+/g;
const BOX_RE = /^[\u2500-\u259f]/;
/**
 * 그 노드 아래의 글자에서 두 칸 글자 덩이를 `<span class="tui-w">` 로 감싼다 — 그 span 이 한글을 터미널처럼 **두 칸 폭**으로 띄운다
 *  (38-chat-tui.css `--tui-wgap`). 입력칸(textarea)·이미 감싼 곳·코드 편집기 안은 건드리지 않는다.
 */
function wrapWide(node: Node): void {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) => {
      const p = t.parentElement;
      if (!p || p.closest('.tui-w, .tui-bx, textarea, input, select, .tui-nowide')) return NodeFilter.FILTER_REJECT;
      WIDE_RE.lastIndex = 0;
      return WIDE_RE.test(t.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const hits: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) hits.push(n as Text);
  for (const t of hits) {
    const s = t.nodeValue || '';
    const frag = document.createDocumentFragment();
    let last = 0;
    WIDE_RE.lastIndex = 0;
    for (let m = WIDE_RE.exec(s); m; m = WIDE_RE.exec(s)) {
      if (m.index > last) frag.append(s.slice(last, m.index));
      //  가로선(─) 덩이는 글자 대신 한 줄 선으로 칠한다(tui-bxh) — 대체 글꼴의 ─ 는 칸보다 좁아 칸을 맞추면 사이가 벌어져 점선처럼 보인다.
      const sp = document.createElement('span'); sp.className = !BOX_RE.test(m[0]) ? 'tui-w' : m[0].charCodeAt(0) === 0x2500 ? 'tui-bx tui-bxh' : 'tui-bx'; sp.textContent = m[0];
      frag.append(sp);
      last = m.index + m[0].length;
    }
    if (last < s.length) frag.append(s.slice(last));
    t.replaceWith(frag);
  }
}

// ── 글자 크기 (#2055) ──────────────────────────────────────────────────────────────────
//  규칙(단계·배율·범위 접기)은 순수 모듈 web/chat-font.ts 가 쥔다 — 여기는 그 값을 DOM 에 바르기만 한다.
function applyFont(root: HTMLElement, step: number): void {
  root.style.setProperty('--livc-fs', String(fontScale(step)));
}
function readFontStep(): number {
  try { return parseFontStep(localStorage.getItem(CHAT_FONT_KEY)); } catch { return 1; }
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
  const style: 'journal' | 'desktop' | 'tui' = opts.style === 'desktop' || opts.style === 'tui' ? opts.style : 'journal';
  const desktop = style === 'desktop';
  const tui = style === 'tui';
  const list = el('div', { class: 'livc-list' });
  //  tui — Claude Code 의 입력줄엔 자리표시 글이 없다(`❯ ` 뒤가 빈 줄). 무엇을 하는 칸인지는 aria-label 로만 남긴다.
  const placeholderOf = (s: string): string => (tui ? '' : s);
  const input = el('textarea', { class: 'livc-input', rows: '1', placeholder: placeholderOf(opts.placeholder), 'aria-label': opts.placeholder }) as HTMLTextAreaElement;
  /** 답 글을 그리는 렌더러 — tui 는 줄 단위(tuiMarkdown), 그 밖은 앱 마크다운. */
  //   표의 꼴(상자/세로)은 글이 앉는 칸 수로 정한다 — 목록 폭 ÷ 칸 폭 − ⏺ 자리(2칸). 아직 화면에 안 붙었으면 터미널 기본 80칸.
  const textCols = (): number => {
    const cwPx = parseFloat(getComputedStyle(list).getPropertyValue('--tui-cw')) || 0;
    const cs = getComputedStyle(list);
    const w = list.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    return cwPx > 0 && w > 0 ? Math.max(20, Math.floor(w / cwPx) - 2) : 80;
  };
  //   표는 칸 수에 따라 꼴(상자/세로)이 바뀐다 — 칸 수가 바뀌면(창 크기 · 숨었던 대화창이 드러남 — 숨은 동안엔 폭을 못 잰다) 그 글만
  //   다시 그린다(아래 ResizeObserver). Claude Code 도 창 크기가 바뀌면 표를 다시 그린다.
  const tableMds = new Map<HTMLElement, string>();
  const renderBody = (s: string): HTMLElement => {
    if (!tui) return renderMarkdown(s);
    const cols = textCols();
    const md = tuiMarkdown(s, cols);
    if (/^\s*\|.*\|\s*$/m.test(s)) { md.dataset.cols = String(cols); tableMds.set(md, s); }
    return md;
  };
  // desktop: 보내기는 ⏎ 글리프 아이콘 버튼(입력 상자 안 오른쪽), 멈춤은 ■ — Claude Desktop 과 같은 자리·같은 문법.
  //  tui: Claude Code 엔 단추가 없다(Enter 가 보내고 Esc 가 멈춘다) — 두 단추는 손가락 화면(자판에 Esc 가 없다)에서만 선다(38-chat-tui.css).
  const send = desktop || tui
    ? el('button', { class: tui ? 'tui-send' : 'dt-send', type: 'submit', title: '보내기 (Enter)', 'aria-label': '보내기', text: '⏎' }) as HTMLButtonElement
    : el('button', { class: 'btn btn-sm livc-send', type: 'submit', text: '보내기' }) as HTMLButtonElement;
  const stop = desktop || tui
    ? el('button', { class: tui ? 'tui-send tui-stop' : 'dt-send dt-stop', type: 'button', title: '멈춤 (Esc)', 'aria-label': '멈춤', hidden: true, text: '■' }) as HTMLButtonElement
    : el('button', { class: 'btn btn-sm livc-send livc-send-stop', type: 'button', text: '멈춤', hidden: true, title: 'Esc' }) as HTMLButtonElement;
  const note = el('div', { class: 'livc-note' });
  //  tui 상태 줄 왼쪽 — 권한 모드가 있으면 그것(`⏵⏵ auto mode on`), 없으면 `? for shortcuts`(입력칸이 비었을 때 ? 를 치면 단축키 표).
  //   도는 동안엔 그 뒤에 `· esc to interrupt` 가 붙는다(Claude Code 2.1.299 는 이 말을 스피너가 아니라 상태 줄에 둔다 — 실측).
  //   글자이자 단추다 — Esc 가 없는 자판(폰)에서도 그 자리를 눌러 멈춘다.
  const modeEl = el('span', { class: 'tui-mode' });
  //  쉬는 동안 모드 뒤의 흐린 안내 — Claude Code 그대로 `(shift+tab to cycle)`. 이 화면에선 모드를 못 바꾸지만(터미널에서 바꾼다)
  //   상민님 목적함수(«두 창을 오가도 거의 똑같다고 느끼게»)를 따라 글자는 같게 둔다. 무엇을 하는 말인지는 title 이 설명한다.
  const cycleEl = el('span', { class: 'tui-cycle', hidden: true, text: ' (shift+tab to cycle)', title: '권한 모드는 터미널에서 shift+tab 으로 바꿉니다.' });
  const escSep = el('span', { class: 'tui-esc-sep', hidden: true, text: ' · ' });
  const escBtn = el('button', { class: 'tui-esc', type: 'button', hidden: true, text: 'esc to interrupt', title: '멈춤 (Esc)' }) as HTMLButtonElement;
  const helpEl = el('div', { class: 'tui-help', hidden: true, role: 'note', 'aria-label': '단축키' },
    ...[
      ['/ for commands', '이 세션에 슬래시 명령을 보냅니다'],
      ['shift + ⏎ for newline', '보내지 않고 줄을 바꿉니다'],
      ['esc to interrupt', '도는 턴을 멈춥니다'],
      ['ctrl + o for verbose output', '도구 결과·생각을 전부 펼칩니다'],
      ['ctrl + v to paste files', '파일·그림을 붙여 넣어 함께 보냅니다'],
    ].map(([k, d]) => el('span', { class: 'tui-help-k', text: k, title: d })));
  const form = tui
    ? el('form', { class: 'livc-compose tui-compose' },
        opts.compose?.chips ?? undefined,
        //  입력줄 기호는 `❯`(U+276F) — Claude Code 2.1.299 터미널 실측(`>` 가 아니다).
        el('div', { class: 'tui-box' }, el('span', { class: 'tui-prompt', 'aria-hidden': 'true', text: '❯' }), input, el('div', { class: 'tui-box-acts' }, stop, send)),
        helpEl,
        el('div', { class: 'tui-status' },
          el('div', { class: 'tui-status-l' }, el('span', { class: 'tui-status-mode' }, modeEl, cycleEl, escSep, escBtn), opts.bar?.left ?? undefined),
          el('div', { class: 'tui-status-r' }, opts.bar?.right ?? undefined, opts.compose?.button ?? undefined)),
        opts.compose?.fileInput ?? undefined) as HTMLFormElement
    : desktop
    ? el('form', { class: 'livc-compose dt-compose' },
        opts.compose?.chips ?? undefined,
        el('div', { class: 'dt-box' }, input, el('div', { class: 'dt-box-acts' }, stop, send)),
        el('div', { class: 'dt-bar' }, el('div', { class: 'dt-bar-l' }, opts.bar?.left ?? undefined), el('div', { class: 'dt-bar-r' }, opts.bar?.right ?? undefined, opts.compose?.button ?? undefined)),
        opts.compose?.fileInput ?? undefined) as HTMLFormElement
    : el('form', { class: 'livc-compose' }, opts.compose?.chips ?? undefined, input, stop, opts.compose?.button ?? undefined, send, opts.compose?.fileInput ?? undefined) as HTMLFormElement;
  const footSlot = el('div', { class: 'livc-foot' }, form);
  let permMode: string | null = null;
  let statusBusy = false;
  const paintStatus = (): void => {
    if (!tui) return;
    const m = tuiMode(permMode);
    const canEsc = statusBusy && !!opts.onStop;
    if (m) {
      modeEl.className = 'tui-mode tui-mode-' + m.tone;
      modeEl.textContent = `${m.glyph}${VS15} ${m.text}`;
      modeEl.title = '이 세션의 권한 모드예요 — 터미널에서 shift+tab 으로 바꿉니다.';
      modeEl.hidden = false;
    } else {
      //  기본 모드 — 쉬는 동안 `? for shortcuts`, 도는 동안엔 그 자리를 `esc to interrupt` 가 차지한다.
      modeEl.className = 'tui-mode';
      modeEl.textContent = '? for shortcuts';
      modeEl.title = '입력칸이 비었을 때 ? 를 치면 단축키를 봅니다.';
      modeEl.hidden = canEsc;
    }
    escBtn.hidden = !canEsc;
    escSep.hidden = !(canEsc && !modeEl.hidden);
    cycleEl.hidden = !(m && !canEsc);
  };
  const setPermissionMode = (mode: string | null): void => { permMode = mode; paintStatus(); };
  paintStatus();

  // 스크롤 — 사람이 읽고 있으면 잡아채지 않는다.
  const NEAR_BOTTOM = 48;
  let stick = true;
  //  tui — Claude Code 의 그 글: `Jump to bottom (click) ↓`, 떠나 있는 동안 새 글이 붙었으면 `2 new messages (click) ↓`.
  const jumpText = (n: number): string => (!tui ? '최신 대화로 ↓' : n > 0 ? `${n} new ${n === 1 ? 'message' : 'messages'} (click) ↓` : 'Jump to bottom (click) ↓');
  let unseen = 0;
  const jump = el('button', {
    class: 'livc-jump', type: 'button', hidden: true, text: jumpText(0),
    onclick: () => { stick = true; toBottom(); },
  }) as HTMLButtonElement;
  // ⚠ 우리가 바닥으로 내린 직후의 scroll 이벤트는 '사람이 올렸다'가 아니다 — 내용이 연달아 붙는 되그리기 중에는 내린 뒤
  //  다음 덩이가 먼저 붙어 이벤트가 '바닥이 아님'으로 잡히고, 그 한 번에 stick 이 풀려 [최신 대화로] 가 괜히 뜬다(실측).
  //  프로그램 스크롤 뒤 120ms 안의 이벤트는 stick 을 풀지 않는다(붙이는 방향은 그대로 반영).
  let progAt = 0;
  list.addEventListener('scroll', () => {
    const near = list.scrollHeight - list.scrollTop - list.clientHeight <= NEAR_BOTTOM;
    if (near) { stick = true; jump.hidden = true; unseen = 0; return; }
    //  tui — 터미널은 바닥을 떠나는 순간 그 단추를 세운다(새 글이 오기 전에도).
    if (tui && Date.now() - progAt > 120 && jump.hidden) { jump.textContent = jumpText(unseen); jump.hidden = false; }
    if (Date.now() - progAt > 120) stick = false;
  });
  const toBottom = (): void => { progAt = Date.now(); list.scrollTop = list.scrollHeight; jump.hidden = true; unseen = 0; };
  const scroll = (): void => {
    if (stick) { toBottom(); return; }
    unseen++;
    jump.textContent = jumpText(unseen);
    jump.hidden = false;
  };

  //  tui — 위에 붙는 사람 말 머리(Claude Code 전체 화면): 지금 읽는 턴의 사람 말이 화면 위로 지나가면 맨 위에 그 말 한 줄(`❯ …`)이
  //   선다(흐린 글자 · 사람 말 띠 바탕 · 넘치면 «…»). 누르면 그 말로 올라간다.
  const sticky = tui ? el('div', { class: 'tui-sticky', hidden: true, role: 'button', tabindex: '-1', title: '이 말로 올라가기' }) as HTMLElement : null;
  let stickyAsk: HTMLElement | null = null;
  const paintSticky = (): void => {
    if (!sticky) return;
    const top = list.getBoundingClientRect().top;
    let hit: ChatTurn | null = null;
    for (const t of turnsArr) {
      if (!t.ask || !t.ask.isConnected) continue;
      const r = t.ask.getBoundingClientRect();
      if (r.top >= top) break;                 // 이 말부터는 화면 안(또는 아래)
      if (r.bottom <= top + 1) hit = t;        // 화면 위로 다 지나간 말 — 마지막 것이 지금 읽는 턴의 말
    }
    stickyAsk = hit?.ask ?? null;
    const line = hit ? (hit.text.split('\n').find((l) => l.trim()) || hit.text).trim() : '';
    if (!hit || !line) { sticky.hidden = true; return; }
    sticky.textContent = '❯ ' + line;
    sticky.hidden = false;
  };
  let stickyRaf = 0;
  if (sticky) {
    list.addEventListener('scroll', () => { if (!stickyRaf) stickyRaf = requestAnimationFrame(() => { stickyRaf = 0; paintSticky(); }); }, { passive: true });
    sticky.addEventListener('click', () => { stickyAsk?.scrollIntoView({ block: 'start' }); });
  }
  const root = el('div', { class: 'livc-wrap' + (desktop ? ' livc-desktop' : '') + (tui ? ' livc-tui' : '') }, el('div', { class: 'livc-scroller' }, list, sticky ?? undefined, jump), opts.askHost ?? undefined, note, footSlot);
  applyFont(root, readFontStep());          // 이 브라우저가 고른 배율로 열린다(다음에 와도 그대로)
  host.replaceChildren(root);
  if (opts.opening) list.append(opts.opening);
  if (opts.footer) { form.hidden = true; footSlot.append(opts.footer); }

  // ── tui — 웹 터미널의 환경 설정을 그대로 입는다(#4707 상민님 «웹터미널의 설정이 똑같이 대화화면에도») ───────────
  //  글꼴·크기·색(바탕·글자·커서·선택)·커서 모양·스크롤 배수 — 정본은 터미널이 저장한 값(lively_term_prefs)이다.
  //  색 테마가 «앱 테마 따름»이면 앱이 지금 어두운가로 정하고, 이름 있는 테마(Dracula·Nord…)면 앱과 무관하게 그 색이다
  //  (터미널과 같다). Claude Code 의 다크/라이트 팔레트(성공·실패·변경분 색)는 그 테마가 어두운 판인가로 고른다.
  //  바뀌면 그 자리에서 따라간다: 다른 문서(터미널 액자·다른 탭)가 바꾸면 storage 신호, 이 문서가 바꾸면 TERM_PREFS_EVENT,
  //  앱 테마가 바뀌면 lv:theme-change(web/theme.ts)·OS 다크 전환.
  let termPrefs: TermPrefs = readTermPrefs();
  //  칸 크기 — 글꼴이 늦게 도착하면(구글 글꼴) 그때 다시 잰다. 재는 값은 터미널 격자와 같은 셈(measureCell).
  const applyCell = (): void => {
    const cell = measureCell(termPrefs.fontFamily, termPrefs.fontSize);
    root.style.setProperty('--tui-cw', `${cell.w}px`);
    root.style.setProperty('--tui-lh', `${cell.h}px`);
    root.style.setProperty('--tui-ls', `${(cell.w - cell.natW).toFixed(3)}px`);
    root.style.setProperty('--tui-wgap', `${(2 * cell.w - cell.wide).toFixed(3)}px`);
    root.style.setProperty('--tui-bgap', `${(cell.w - cell.box).toFixed(3)}px`);
  };
  let fontGen = 0;
  const applyTermLook = (): void => {
    if (!tui) return;
    termPrefs = readTermPrefs();
    const face = termFace(termPrefs.theme, isDark());
    root.style.setProperty('--tui-font', termPrefs.fontFamily);
    root.style.setProperty('--tui-fs', `${termPrefs.fontSize}px`);
    root.style.setProperty('--tui-bg', face.background);
    root.style.setProperty('--tui-fg', face.foreground);
    root.style.setProperty('--tui-cursor', face.cursor);
    root.style.setProperty('--tui-sel', face.selectionBackground);
    root.style.setProperty('--tui-link', face.blue);   // Claude Code 는 링크를 터미널의 ANSI 파랑으로 찍는다(실측)
    root.dataset.tuiScheme = face.dark ? 'dark' : 'light';
    root.dataset.tuiCaret = caretShape(termPrefs.cursorStyle);
    applyCell();
    //  글꼴이 아직 안 왔으면 대체 글꼴로 잰 값이다 — 시트가 등록되고 글꼴이 도착하면 한 번 더 잰다(늦게 온 응답이 새 설정을 덮지 않게 세대를 본다).
    const gen = ++fontGen;
    const fam = termPrefs.fontFamily, size = termPrefs.fontSize;
    void ensureTermFonts(fam).then(async () => {
      try {
        const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
        if (fonts) await Promise.all([fonts.load(`${size}px ${fam}`, 'W'), fonts.load(`${size}px ${fam}`, '가')]);
      } catch { /* 글꼴을 못 받았다 — 대체 글꼴 값 그대로 */ }
      if (gen === fontGen && root.isConnected) { applyCell(); if (stick) toBottom(); }
    });
  };
  //  어느 글꼴이든 새로 도착하면(다른 칸이 먼저 부른 글꼴 포함) 칸을 다시 잰다 — 캔버스 한 번이라 싸다.
  const onFontsDone = (): void => { if (tui && root.isConnected) applyCell(); };
  try { (document as Document & { fonts?: FontFaceSet }).fonts?.addEventListener('loadingdone', onFontsDone); } catch { /* 구형 */ }
  //  한글을 두 칸 폭으로(wrapWide) — 대화창에 새로 붙는 글마다 한 번씩. 입력칸은 건드리지 않는다.
  let wideObs: MutationObserver | null = null;
  if (tui) {
    wideObs = new MutationObserver((recs) => {
      for (const r of recs) r.addedNodes.forEach((n) => { if (n.nodeType === 1 || n.nodeType === 3) { const host0 = n.nodeType === 3 ? n.parentNode : n; if (host0) wrapWide(host0); } });
    });
    wideObs.observe(root, { childList: true, subtree: true });
    wrapWide(root);   // 이미 붙어 있던 것(빈 화면 안내 등)
  }
  applyTermLook();
  const onTermStorage = (e: StorageEvent): void => { if (!e.key || e.key === TERM_PREFS_KEY || e.key === 'lv:theme') applyTermLook(); };
  let darkMq: MediaQueryList | null = null;
  if (tui) {
    window.addEventListener('storage', onTermStorage);
    window.addEventListener(TERM_PREFS_EVENT, applyTermLook);
    document.addEventListener('lv:theme-change', applyTermLook);
    try { darkMq = window.matchMedia('(prefers-color-scheme: dark)'); darkMq.addEventListener('change', applyTermLook); } catch { darkMq = null; }
  }
  //  스크롤도 터미널의 배수를 따른다 — 마우스 휠은 «한 칸 = scrollSpeed 줄», 트랙패드는 «손가락 이동 × padGain»(terminal.ts setupWheel 과 같은 단위).
  //  ⚠ 안쪽에 스스로 세로로 굴러가는 칸(코드 블록이 아니라 높이 상한이 있는 칸)이 있으면 그 칸이 먼저다 — 그 휠까지 가로채면 안쪽이 안 굴러간다.
  const innerScrolls = (from: EventTarget | null, dy: number): boolean => {
    for (let n = from as HTMLElement | null; n && n !== list; n = n.parentElement) {
      if (!(n instanceof HTMLElement) || n.scrollHeight <= n.clientHeight + 1) continue;
      const oy = getComputedStyle(n).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      if (dy < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1) return true;
    }
    return false;
  };
  let tableRo: ResizeObserver | null = null;
  if (tui && typeof ResizeObserver !== 'undefined') {
    tableRo = new ResizeObserver(() => {
      //  폭이 바뀌면(숨었던 대화창이 드러날 때 포함) 표를 다시 그린다 — 높이가 바뀌므로, 바닥에 붙어 있었으면 다시 바닥으로
      //   (안 그러면 브라우저의 스크롤 고정이 자리를 옮기고 그 스크롤 신호를 «사람이 올렸다» 로 읽어 바닥 따라가기가 풀린다 — 실측).
      const wasStick = stick;
      const cols = textCols();
      queueMicrotask(() => { if (wasStick) { stick = true; toBottom(); } });
      for (const [md, src] of [...tableMds]) {
        if (!md.isConnected) { tableMds.delete(md); continue; }
        if (Number(md.dataset.cols) === cols) continue;
        const next = tuiMarkdown(src, cols);
        next.dataset.cols = String(cols);
        const host0 = md.parentElement;
        md.replaceWith(next);
        tableMds.delete(md); tableMds.set(next, src);
        if (host0) decorateCode(host0);
      }
    });
    tableRo.observe(list);
  }
  if (tui) {
    list.addEventListener('wheel', (e: WheelEvent) => {
      if (e.ctrlKey || e.defaultPrevented || e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) || !e.deltaY) return;   // 확대·가로 굴림은 브라우저 몫
      if (innerScrolls(e.target, e.deltaY)) return;
      const linePx = parseFloat(getComputedStyle(list).lineHeight) || termPrefs.fontSize * 1.35;
      const px = wheelPx(e, isWheelNotch(e as WheelEvent & { wheelDeltaY?: number }), termPrefs, linePx, list.clientHeight);
      e.preventDefault();
      list.scrollTop += px;
    }, { passive: false });
  }

  const turnsArr: ChatTurn[] = [];
  let runningTurn: ChatTurn | null = null;
  let ticker: number | null = null;
  let spinTimer: number | null = null;   // tui — 스피너 글리프(✻)만 촘촘히 돌린다(글자 줄은 1초 ticker)
  let isBusy = false;
  let lastCwd: string | null = null;     // tui — 경로를 작업 폴더 기준 상대 경로로(Claude Code 와 같다). 대화 줄의 cwd 를 따른다.
  //  tui 도구 카드 → 그 호출(이름·입력)과 결과. 결과는 펼칠 때(클릭·Ctrl+O) 다시 그리려고 들고 있는다.
  const tuiCall = new WeakMap<HTMLElement, { name: string; input: unknown }>();
  const bgAgents = new Set<string>();    // tui — 띄웠는데 아직 «끝났다» 알림이 안 온 백그라운드 에이전트(id)
  //  이미 «끝났다» 알림을 본 에이전트 — 이전 기록을 위로 붙일 때(loadOlder)는 알림(새 쪽)을 띄운 기록(옛 쪽)보다 먼저 읽으므로,
  //   그 뒤에 띄운 기록을 만나도 «아직 돈다» 로 세지 않게 기억해 둔다.
  const bgFinished = new Set<string>();
  const tuiRes = new WeakMap<HTMLElement, TuiResult>();
  //  tui 도구 묶음(접힌 한 줄) → 그 셈과 안에 든 카드들.
  const groups = new WeakMap<HTMLElement, { g: TuiGroup; cards: HTMLElement[] }>();
  const cardCol = new WeakMap<HTMLElement, TuiCollapse>();   // 묶음 안 카드 → 그 셈(셸 명령을 빼낼 때 묶음 수를 다시 센다)

  const busy = (on: boolean): void => {
    isBusy = on;
    const lock = on && !opts.sendWhileBusy;
    input.disabled = lock;
    input.placeholder = placeholderOf(lock ? (opts.busyPlaceholder || opts.placeholder) : opts.placeholder);
    stop.hidden = !(on && opts.onStop);
    statusBusy = on; paintStatus();
    // 리브(보내기 잠금)에서는 멈춤이 보내기 자리를 차지한다 — 버튼이 둘이면 잠긴 칸 옆에 죽은 버튼이 하나 남는다.
    //  desktop 도 같은 문법(Claude Desktop: 도는 동안 보내기 자리가 멈춤이 된다) — 단 보낼 수 있으면(큐잉) 둘 다 둔다.
    send.hidden = lock && !!opts.onStop;
    if (desktop) form.classList.toggle('dt-busy', on);
    if (tui) form.classList.toggle('tui-busy', on);
  };

  /** tui 스피너의 괄호 안 — `(12s · ↓ 1.2k tokens)`. 모르는 값(시작 시각·토큰)은 지어내지 않고 뺀다 — 둘 다 모르면 괄호째 뺀다. */
  const tickTui = (t: ChatTurn): void => {
    tickGroups(t);
    const live = t.live; if (!live) return;
    const meta = live.querySelector('.tui-spin-m');
    if (!meta) return;
    const bits: string[] = [];
    if (t.ask) bits.push(fmtElapsed(Date.now() - t.startedAt));
    const tok = t.tok ? [...t.tok.values()].reduce((a, b) => a + b, 0) : 0;
    if (tok > 0) bits.push(`↓ ${fmtTokens(tok)} tokens`);
    meta.textContent = bits.length ? ` (${bits.join(' · ')})` : '';
  };
  const tickLive = (): void => {
    if (!runningTurn || !runningTurn.live) return;
    const t = runningTurn;
    if (tui) { tickTui(t); return; }
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
    if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
    if (!t) return;
    t.work.classList.add('livc-work-busy');
    const live = t.live ?? (t.live = (tui ? tuiSpinner(t)
      : desktop
      ? el('div', { class: 'dt-live', 'aria-live': 'polite' }, el('span', { class: 'dt-spin', 'aria-hidden': 'true', text: '✻' }), el('span', { class: 'dt-live-t' }))
      : el('div', { class: 'livc-live', 'aria-live': 'polite' })) as HTMLElement);
    t.work.append(live);              // 항상 괘선의 맨 아래(새 내용이 오면 다시 내려간다 — event() 참고)
    tickLive();
    ticker = window.setInterval(tickLive, 1000);
    if (tui) {
      //  글리프는 Claude Code 처럼 · ✢ ✳ ✶ ✻ ✽ 를 오간다. 움직임을 줄이라는 설정이면 한 자리에 선다.
      let reduce = false;
      try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { reduce = false; }
      const g = live.querySelector('.tui-spin-g');
      if (g && !reduce) spinTimer = window.setInterval(() => { g.textContent = TUI_SPIN_FRAMES[Math.floor(Date.now() / 120) % TUI_SPIN_FRAMES.length] + VS15; }, 120);
    }
  };
  /** tui 스피너 한 줄 — `✻ Cogitating… (12s · ↓ 1.2k tokens)`. 동사는 턴마다 하나(다시 그려도 같다). 멈춤 안내는 상태 줄이 말한다. */
  function tuiSpinner(t: ChatTurn): HTMLElement {
    const verb = pickVerb(seedOf(String(t.ts || t.startedAt)));
    return el('div', { class: 'tui-spin', role: 'status', 'aria-live': 'polite' },
      el('span', { class: 'tui-spin-g', 'aria-hidden': 'true', text: '✻' + VS15 }),
      el('span', { class: 'tui-spin-v', text: verb + '…' }),
      el('span', { class: 'tui-spin-m' }));
  }

  function turn(userText: string | null, o?: { ts?: string; at?: 'end' | 'start' }): ChatTurn {
    let work: HTMLElement; let ask: HTMLElement | null = null;
    if (tui) {
      // Claude Code 터미널 문법 — 내 말은 `> …` 한 띠(옅은 바탕), AI 가 한 일은 그 아래 `⏺` 덩이들. 이름표·말풍선 없음.
      work = el('div', { class: 'livc-work tui-ai' });
      if (userText !== null) {
        ask = el('div', { class: 'livc-ask tui-user' },
          el('div', { class: 'livc-ask-text tui-user-text', text: userText, title: o?.ts ? new Date(o.ts).toLocaleString() : undefined }));
      }
    } else if (desktop) {
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
    // #3784 우클릭 — 내 말: 복사 · 다시 묻기(입력칸에 담기) · 인용
    if (ask && userText) {
      const ut = userText;
      bindCtx(ask, (hit, ev) => ({
        title: '내 말', sub: ut.length > 60 ? ut.slice(0, 60).replace(/\s+/g, ' ') + '…' : ut,
        rows: [
          { label: '복사', icon: 'copy', run: () => void copyText(ut).then((ok) => { if (ok) toast('복사했어요'); }) },
          { label: '입력칸에 다시 담기', icon: 'pen', hint: '고쳐서 다시 묻기', run: () => {
            const ta = hit.el.closest('.livc-wrap')?.querySelector('.livc-input') as HTMLTextAreaElement | null;
            if (!ta) return; ta.value = ut; ta.focus(); ta.dispatchEvent(new Event('input', { bubbles: true }));
          } },
          { label: '인용해서 묻기', icon: 'quote', run: () => quoteInto(hit.el, ev.selection || ut) },
        ],
      }));
    }
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

  // ── tui 도구 카드 — `⏺ Bash(npm test)` + `⎿  결과` ─────────────────────────────────────────────
  //  점의 색이 상태다(Claude Code 와 같다): 도는 중 = 깜빡이는 회색 · 성공 = 초록 · 실패 = 빨강 · 결과가 창 밖 = 회색.
  //  머리를 누르면 그 카드만, Ctrl+O 면 전부 펼친다(Claude Code 의 ctrl+o). 원문은 버리지 않고 접을 뿐이다.
  function tuiToolCard(name: string, input: unknown): HTMLElement {
    const h = tuiToolHead(name, input, lastCwd);
    const head = el('div', { class: 'tui-tool-head', role: 'button', tabindex: '0', 'aria-expanded': 'false', title: '눌러서 펼치기 · Ctrl+O 로 전부 펼치기' },
      el('span', { class: 'tui-dot', 'aria-hidden': 'true', text: '⏺' + VS15 }),
      el('span', { class: 'tui-tool-name', text: h.name }),
      h.args ? el('span', { class: 'tui-tool-args', text: `(${h.args})` }) : null);
    //  셸 명령·보조 에이전트는 끝날 때까지 시간이 걸린다 — Claude Code 처럼 그 사이 `⎿  Running…` 을 둔다.
    const res = el('div', { class: 'tui-res' }, name === 'Bash' || name === 'Task' || name === 'Agent' ? rl('Running…', 'tui-dim') : null);
    const card = el('div', { class: 'tui-tool', 'data-st': 'run' }, head, res) as HTMLElement;
    tuiCall.set(card, { name, input });
    return card;
  }
  function finishTui(card: HTMLElement, out: string, isError: boolean, meta: unknown, pd?: unknown): void {
    const call = tuiCall.get(card);
    if (!call) return;
    const why = pd && typeof pd === 'object' ? (pd as { reasonType?: unknown }).reasonType : undefined;
    card.dataset.allowed = why === 'classifier' && call.name !== 'Agent' && call.name !== 'Task' && !isError ? '1' : '';
    //  백그라운드로 띄운 에이전트 — 끝났다는 알림(bgDone)이 올 때까지 «돌고 있다» 로 센다(턴 끝 줄 `Waiting for N…`).
    if ((call.name === 'Agent' || call.name === 'Task') && !isError && isAsyncAgent(meta, out)) { const id = asyncAgentId(meta, out); if (id && !bgFinished.has(id)) bgAgents.add(id); }
    const r = tuiToolResult(call.name, call.input, out, isError, meta, lastCwd);
    card.dataset.st = isError || r.tone === 'err' ? 'err' : 'ok';
    tuiRes.set(card, r);
    paintTuiResult(card, r);
    const g = card.parentElement?.closest('.tui-group') as HTMLElement | null;
    //  파일을 바꾼 셸 명령 — Claude Code 는 그 명령을 묶음에서 빼내 따로 세운다(묶음의 마지막 호출일 때 — 2.1.299 의 규칙).
    //   묶음은 거기서 끊기고, 뒤에 오는 접힘 도구는 새 묶음을 연다(괘선의 마지막 덩이가 이제 이 카드다).
    if (g && (call.name === 'Bash' || call.name === 'PowerShell') && !isError && bashPopsOut(meta)) {
      const st = groups.get(g);
      if (st && st.cards[st.cards.length - 1] === card) {
        st.cards.pop();
        st.g = newGroup();
        for (const c of st.cards) { const cc = cardCol.get(c); if (cc) addToGroup(st.g, cc); }
        g.after(card);
        if (st.cards.length) paintGroup(g); else g.remove();
        return;
      }
    }
    if (g) paintGroup(g);
  }

  // ── tui 도구 묶음 — `  Ran 2 shell commands` · `  Called lively, ran 1 shell command` ─────────────────────
  //  들여다보는 도구(읽기·검색·셸·MCP…)는 Claude Code 처럼 이어진 것끼리 흐린 한 줄로 접는다(무엇이 접히나는 chat-tui.ts tuiCollapse).
  //  도는 동안엔 `⏺ Running 1 shell command…`(점 깜빡임) + `⎿  $ npm test`, 끝나면 2칸 들여쓴 흐린 줄. 누르면 안의 카드가 하나씩 펼쳐진다
  //  (Ctrl+O 면 전부) — 원문은 버리지 않고 접을 뿐이다.
  /** 이 턴 괘선의 마지막 덩이(스피너·숨은 생각은 건너뛴다). 그게 묶음이면 새 접힘 도구가 거기 붙는다. */
  function lastWorkEl(t: ChatTurn): HTMLElement | null {
    let n = t.work.lastElementChild as HTMLElement | null;
    while (n && (n === t.live || n.classList.contains('tui-think'))) n = n.previousElementSibling as HTMLElement | null;
    return n;
  }
  function groupFor(t: ChatTurn): HTMLElement {
    const last = lastWorkEl(t);
    if (last && last.classList.contains('tui-group')) return last;
    const line = el('div', { class: 'tui-group-line', role: 'button', tabindex: '0', 'aria-expanded': 'false', title: '눌러서 하나씩 보기 · Ctrl+O 로 전부 펼치기' },
      el('span', { class: 'tui-dot', 'aria-hidden': 'true', text: '⏺' + VS15 }),
      el('span', { class: 'tui-group-t' }),
      el('span', { class: 'tui-group-el' }));
    const gEl = el('div', { class: 'tui-group', 'data-st': 'run' }, line, el('div', { class: 'tui-res tui-group-hint' }), el('div', { class: 'tui-group-body' })) as HTMLElement;
    groups.set(gEl, { g: newGroup(), cards: [] });
    appendWork(t, gEl);
    return gEl;
  }
  function paintGroup(gEl: HTMLElement): void {
    const st = groups.get(gEl);
    if (!st) return;
    const running = st.cards.some((c) => c.dataset.st === 'run');
    gEl.dataset.st = running ? 'run' : 'done';
    gEl.hidden = !groupVisible(st.g);   // 할 일 목록 갱신만 든 묶음 — 터미널도 아무 줄도 세우지 않는다
    gEl.querySelector('.tui-group-t')?.replaceChildren(...segEls(groupSegs(st.g, running)), ...(running ? [document.createTextNode('…')] : []));
    const hint = gEl.querySelector(':scope > .tui-group-hint');
    if (hint) hint.textContent = running && st.g.hint ? st.g.hint : '';
    if (!running) { const e0 = gEl.querySelector('.tui-group-el'); if (e0) e0.textContent = ''; }
    gEl.querySelector(':scope > .tui-group-line')?.setAttribute('aria-expanded', String(gEl.classList.contains('tui-open') || root.classList.contains('tui-verbose')));
  }
  /** 도는 묶음의 경과 시간 자리 — 전체 화면 Claude Code 는 이 줄에 시간을 붙이지 않는다(2.1.299 실측). 자리만 비워 둔다. */
  function tickGroups(_t: ChatTurn): void { /* 의도적으로 비움 */ }
  /** 한 카드를 펼치거나 접는다. 펼칠 것이 없는 카드(요약뿐·결과 전)는 그대로 둔다(죽은 반응 금지 — 머리에 표시도 없다). */
  function toggleTool(card: HTMLElement): void {
    const r = tuiRes.get(card);
    if (!r || !card.classList.contains('tui-can-open')) { card.classList.toggle('tui-open'); return; }   // 결과 전이면 긴 명령 머리만 펼친다
    card.classList.toggle('tui-open');
    paintTuiResult(card, r);
  }
  /** Ctrl+O — 대화창 전체를 «다 펼친 판»으로(Claude Code 의 verbose). 생각·압축 요약도 함께 열린다. */
  function toggleVerbose(): void {
    const on = !root.classList.contains('tui-verbose');
    root.classList.toggle('tui-verbose', on);
    (list.querySelectorAll('.tui-tool') as NodeListOf<HTMLElement>).forEach((c) => { const r = tuiRes.get(c); if (r) paintTuiResult(c, r); });
    (list.querySelectorAll('.tui-group') as NodeListOf<HTMLElement>).forEach((g) => paintGroup(g));
    (list.querySelectorAll('details.tui-think, details.tui-compact') as NodeListOf<HTMLDetailsElement>).forEach((d) => { d.open = on; });
    if (stick) toBottom();
  }
  /** 묶음 한 줄을 눌렀다 — 안의 도구 카드들을 펼치거나 접는다. */
  function toggleGroup(gEl: HTMLElement): void {
    gEl.classList.toggle('tui-open');
    paintGroup(gEl);
  }
  if (tui) {
    list.addEventListener('click', (e: MouseEvent) => {
      const tgt = e.target as HTMLElement | null;
      const hit = tgt?.closest('.tui-tool-head, .tui-more, .tui-group-line') as HTMLElement | null;
      if (!hit || !list.contains(hit)) return;
      //  끌어서 글을 고르던 중이면 펼치지 않는다 — 결과 글을 복사하려다 카드가 접혀 버리면 안 된다.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && hit.contains(sel.anchorNode)) return;
      if (hit.classList.contains('tui-group-line')) { const g = hit.closest('.tui-group') as HTMLElement | null; if (g) toggleGroup(g); return; }
      const card = hit.closest('.tui-tool') as HTMLElement | null;
      if (card) toggleTool(card);
    });
    list.addEventListener('keydown', (e: KeyboardEvent) => {
      const head = (e.target as HTMLElement | null)?.closest('.tui-tool-head, .tui-group-line') as HTMLElement | null;
      if (!head || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      if (head.classList.contains('tui-group-line')) { const g = head.closest('.tui-group') as HTMLElement | null; if (g) toggleGroup(g); return; }
      const card = head.closest('.tui-tool') as HTMLElement | null;
      if (card) toggleTool(card);
    });
  }

  function event(t: ChatTurn, ev: any): { text?: string } {
    const r = t.r;
    let lastText: string | undefined;
    const content = ev?.message?.content;
    const isAssistant = ev?.type === 'assistant';
    const already = isAssistant && r.streamed.has(String(ev?.message?.id ?? ''));
    if (tui) {
      if (ev?.cwd) lastCwd = String(ev.cwd);
      //  스피너의 토큰 수 — 한 응답이 블록마다 여러 줄로 오고 줄마다 같은 usage 를 싣는다. 응답 id 로 묶어 가장 큰 값만 센다.
      const u = isAssistant ? ev?.message?.usage : null;
      const mid = String(ev?.message?.id ?? '');
      const outTok = Number(u?.output_tokens) || 0;
      if (mid && outTok > 0) { (t.tok ??= new Map()).set(mid, Math.max(t.tok.get(mid) || 0, outTok)); }
    }
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!b) continue;
        if (b.type === 'text' && isAssistant && String(b.text ?? '').trim()) {
          lastText = String(b.text);
          if (!already) appendWork(t, said(lastText, renderBody));   // 조각으로 이미 그렸으면 건너뛴다(같은 글이다)
        } else if (b.type === 'thinking' && isAssistant) {
          if (opts.thinking === 'fold' && String(b.thinking ?? '').trim()) appendWork(t, tui ? tuiThink(String(b.thinking)) : thinkCard(String(b.thinking)));
        } else if (b.type === 'tool_use') {
          if (tui) {
            const nm = String(b.name ?? 'Tool');
            const card = tuiToolCard(nm, b.input);
            if (b.id) r.cards.set(String(b.id), card);
            const col = tuiCollapse(nm, b.input, lastCwd);
            if (col) {
              //  접히는 도구 — 이어진 묶음에 더한다(카드는 묶음 안에 접혀 들어간다). 경과 시간의 기준은 가장 최근 호출의 시각.
              const gEl = groupFor(t);
              const st = groups.get(gEl)!;
              addToGroup(st.g, col);
              st.cards.push(card);
              cardCol.set(card, col);
              (gEl.querySelector(':scope > .tui-group-body') as HTMLElement).append(card);
              const at = Date.parse(String(ev?.timestamp ?? ''));
              gEl.dataset.start = String(Number.isFinite(at) ? at : Date.now());
              paintGroup(gEl);
            } else appendWork(t, card);
            continue;
          }
          const lab = opts.toolLabel(String(b.name ?? '도구'), b.input);
          const card = actionCard(lab, b.input);
          if (b.id) r.cards.set(String(b.id), card);
          if (desktop) addToToolGroup(t, card, lab); else appendWork(t, card);
        } else if (b.type === 'tool_result') {
          const card = b.tool_use_id ? r.cards.get(String(b.tool_use_id)) : null;
          const out = typeof b.content === 'string' ? b.content
            : Array.isArray(b.content) ? b.content.map((c: any) => (c && c.type === 'text' ? String(c.text ?? '') : c && c.type === 'image' ? '[이미지]' : pretty(c))).join('\n')
            : pretty(b.content ?? '');
          if (card && tui) { finishTui(card, out, !!b.is_error, ev?.toolUseResult, ev?.permissionDecision); continue; }
          if (card) { finishCard(card, out, !!b.is_error); if (desktop) refreshToolGroup(card.closest('.dt-tools') as HTMLElement | null); }
        }
      }
    }
    if (t === runningTurn && t.live) t.work.append(t.live);
    if (tui && t === runningTurn) tickTui(t);
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
      if (b.buf.trim()) { b.el.replaceChildren(renderBody(b.buf)); decorateCode(b.el); b.el.append(copyBtn(b.buf, 'livc-said-copy', '답 복사')); }
      else b.el.remove();
      r.blocks.delete(Number(e.index));
    }
  }

  /** 턴 끝 줄을 (다시) 칠한다 — 그 턴이 남긴 백그라운드 에이전트가 아직 돌면 `Waiting for…`, 다 끝났으면 걸린 시간. */
  function paintDone(node: HTMLElement): void {
    const pend = Number(node.dataset.pend) || 0;
    //  Claude Code 도 이 줄을 그릴 때의 상태로 고른다 — 기록엔 «그때 N개가 돌았다» 가 적혀 있어도 지금 다 끝났으면 걸린 시간을 보인다
    //   (터미널 실측: pendingBackgroundAgentCount=1 인 턴이 알림 뒤엔 `Crunched for 48s · done 6:40 PM`).
    const waiting = pend > 0 && bgAgents.size > 0 ? pend : 0;
    node.replaceChildren(el('span', { class: 'tui-done-g', 'aria-hidden': 'true', text: '✻' + VS15 }),
      ...segEls(turnEndSegs({ pendingBg: waiting, durationMs: Number(node.dataset.ms) || 0, uuid: node.dataset.uuid, ts: node.dataset.ts })));
  }
  function settle(t: ChatTurn, o?: { exit?: number | null; interrupted?: boolean; durationMs?: number; turnEnd?: { uuid?: string; ts?: string; pendingBg?: number } }): void {
    for (const [i, b] of t.r.blocks) {
      b.el.classList.remove('livc-said-live');
      if (b.buf.trim()) { b.el.replaceChildren(renderBody(b.buf)); decorateCode(b.el); b.el.append(copyBtn(b.buf, 'livc-said-copy', '답 복사')); } else b.el.remove();
      t.r.blocks.delete(i);
    }
    t.work.querySelectorAll('.livc-slip-run').forEach((m) => { const c = m.closest('.livc-slip'); if (c) settleCard(c as HTMLElement); });
    if (desktop) t.work.querySelectorAll('.dt-tools').forEach((g) => refreshToolGroup(g as HTMLElement));
    //  tui — 결과를 못 받은 채 끝난 도구(결과가 창 밖·턴이 끊김)는 «도는 중»으로 남기지 않는다: 점을 회색으로, Running… 은 걷는다.
    if (tui) {
      t.work.querySelectorAll<HTMLElement>('.tui-tool[data-st="run"]').forEach((c) => { c.dataset.st = 'idle'; c.querySelector(':scope > .tui-res .tui-dim')?.remove(); });
      t.work.querySelectorAll<HTMLElement>(':scope > .tui-group').forEach((g) => paintGroup(g));
    }
    if (t === runningTurn) running(null);
    if (tui) {
      //  Claude Code 의 그 문장들 — 끊긴 턴은 빨간 `⎿`, 턴의 끝엔 `✻ Churned for 3m 51s · done 6:43 PM`(동사·시각은 그 기록에서 —
      //   터미널과 같은 낱말이 선다) 또는 백그라운드 에이전트가 아직 돌면 `✻ Waiting for 1 background agent to finish`. 한 턴에 한 번만.
      if (o?.interrupted && !t.work.querySelector(':scope > .tui-interrupted')) appendWork(t, el('div', { class: 'tui-res tui-err tui-interrupted' }, rl('Interrupted · What should Claude do instead?')));
      if (o?.exit != null && o.exit !== 0) appendWork(t, el('div', { class: 'livc-err tui-res tui-err' }, rl('이번 요청은 끝까지 가지 못했습니다. 다시 말씀해 주시면 이어서 해 보겠습니다.')));
      if (o?.turnEnd && !t.work.querySelector(':scope > .tui-done')) {
        const node = el('div', { class: 'tui-done' }) as HTMLElement;
        node.dataset.ms = String(Number(o.durationMs) || 0);
        node.dataset.pend = String(Number(o.turnEnd.pendingBg) || 0);
        if (o.turnEnd.uuid) node.dataset.uuid = o.turnEnd.uuid;
        if (o.turnEnd.ts) node.dataset.ts = o.turnEnd.ts;
        paintDone(node);
        appendWork(t, node);
      }
      return;
    }
    if (o?.interrupted) appendWork(t, el('div', { class: 'livc-mark', text: '중단함' }));
    if (o?.exit != null && o.exit !== 0) appendWork(t, el('div', { class: 'livc-err', text: '이번 요청은 끝까지 가지 못했습니다. 다시 말씀해 주시면 이어서 해 보겠습니다.' }));
    if (o?.durationMs && o.durationMs > 3000) {
      const w = t.work.querySelector(':scope > .livc-who');
      if (w && !w.querySelector('.livc-dur')) w.append(el('span', { class: 'livc-dur', text: fmtDur(o.durationMs) }));
    }
  }

  function divider(text: string, details?: string, at?: 'end' | 'start', kind?: 'compact' | 'error'): void {
    let node: HTMLElement;
    if (tui && kind === 'error') {
      //  하네스가 올린 오류 — Claude Code 의 `⎿  API Error: …` 처럼 빨간 한 덩이. 이유(details)가 곧 내용이라 접지 않는다.
      node = el('div', { class: 'tui-res tui-err tui-lone' }, ...splitLinesForErr(details || text).map((l) => rl(l)));
    } else if (tui) {
      //  맥락 압축 — `✻ Conversation compacted · ctrl+o for history`. 요약 본문은 접혀 있고 누르거나 Ctrl+O 로 연다.
      const label = kind === 'compact' ? 'Conversation compacted' : text;
      node = details
        ? el('details', { class: 'livc-divider tui-compact' }, el('summary', { text: `✻${VS15} ${label} · ctrl+o for history` }), el('div', { class: 'livc-divider-body', text: details }))
        : el('div', { class: 'livc-divider tui-compact' }, el('span', { text: `✻${VS15} ${label}` }));
      if (root.classList.contains('tui-verbose') && node instanceof HTMLDetailsElement) node.open = true;
    } else {
      node = details
        ? el('details', { class: 'livc-divider' }, el('summary', { text }), el('div', { class: 'livc-divider-body', text: details }))
        : el('div', { class: 'livc-divider' }, el('span', { text }));
    }
    if (at === 'start') list.prepend(node); else list.append(node);
  }
  const splitLinesForErr = (s: string): string[] => { const ls = String(s || '').replace(/\s+$/, '').split('\n'); return ls.length ? ls : ['Error']; };

  // ── tui 환영 상자 · 단축키 · Ctrl+O ───────────────────────────────────────────────────────
  let bannerEl: HTMLElement | null = null;
  const banner = (b: TuiBanner | null): void => {
    if (!tui) return;
    bannerEl?.remove(); bannerEl = null;
    if (!b) return;
    bannerEl = tuiBannerEl(b);
    list.prepend(bannerEl);
  };
  //  `?` — 입력칸이 비었을 때 치면 단축키 표가 상태 줄 자리에 선다(Claude Code 와 같다). 다른 글자를 치면 물러난다.
  const showHelp = (on: boolean): void => { helpEl.hidden = !on; form.classList.toggle('tui-help-on', on); };
  //  Ctrl+O — 이 대화창이 **보이는 동안**, 초점이 이 대화창 안에 있거나 아무 데도 없을 때만 받는다(다른 칸의 Ctrl+O 를 가로채지 않는다).
  const onTuiKey = (e: KeyboardEvent): void => {
    if (!tui || !root.isConnected || !root.getClientRects().length) return;
    if (!(e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.code === 'KeyO' || e.key === 'o' || e.key === 'O'))) return;
    const tgt = e.target as Node | null;
    if (tgt && tgt !== document.body && tgt !== document.documentElement && !root.contains(tgt)) return;
    e.preventDefault();
    toggleVerbose();
  };
  if (tui) document.addEventListener('keydown', onTuiKey);

  const doStop = async (): Promise<void> => {
    if (!opts.onStop) return;
    stop.disabled = true;
    try { await opts.onStop(); } finally { stop.disabled = false; }
  };
  stop.addEventListener('click', () => { void doStop(); });
  escBtn.addEventListener('click', () => { void doStop(); });
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
    if ((!text && !opts.canSendEmpty?.()) || input.disabled) return;
    input.value = ''; input.style.height = '';
    void opts.onSend(text);
  });
  // 한글 입력 중의 Enter 는 조합 확정이지 전송이 아니다(isComposing). Shift+Enter 는 줄바꿈.
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (tui && !e.isComposing && (e as any).keyCode !== 229) {
      //  `?` — 빈 입력칸에서만 단축키 표(글자로 들어가지 않는다). 표가 떠 있으면 다음 키에 물러난다(Esc 는 표만 닫고 턴을 멈추지 않는다).
      if (e.key === '?' && !input.value && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); showHelp(helpEl.hidden); return; }
      if (!helpEl.hidden && e.key !== 'Shift') {
        showHelp(false);
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return; }
      }
    }
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (e.isComposing || (e as any).keyCode === 229) return;
    e.preventDefault();
    form.requestSubmit();
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    //  tui — 터미널처럼 친 만큼 늘어난다(창 높이의 40% 까지). 그 밖은 종전 상한(160px).
    const cap = tui ? Math.max(160, Math.round(window.innerHeight * 0.4)) : 160;
    input.style.height = `${Math.min(input.scrollHeight, cap)}px`;
  });

  return {
    root, list, input, form, noteEl: note, style,
    turn, event, stream, settle, running, busy, scroll,
    scrollToBottom: () => { stick = true; toBottom(); },
    setNote: (text: string) => { note.textContent = text; },
    error: (t, text) => {
      //  tui — 빨간 `⎿` 덩이(Claude Code 가 도구·API 오류를 그리는 자리). 그 밖은 종전 오류 줄.
      const n = tui ? el('div', { class: 'livc-err tui-res tui-err' }, ...splitLinesForErr(text).map((l) => rl(l))) : el('div', { class: 'livc-err', text });
      if (t) appendWork(t, n); else list.append(n);
      scroll();
    },
    divider,
    setPermissionMode,
    banner,
    notice: (t, text, tone = 'ok') => {
      if (!tui) return;
      //  `● Agent "…" finished · 1m 1s` — 점 색이 결과다(성공 초록 · 실패 빨강). 덩이 하나라 앞뒤로 빈 줄이 선다.
      //  ⚠ 여기서 scroll() 을 부르지 않는다 — 위로 이전 대화를 붙이는 중(loadOlder)에도 불리는데, 그때 부르면 읽던 사람 앞에 [최신 대화로] 가 괜히 선다.
      //   새 줄을 받은 뒤의 스크롤은 호출자(세션 화면의 폴)가 한 번에 한다.
      //   줄이 넘치면 0번 칸부터 잇는다(걸친 들여쓰기 없음 — 2.1.299 실측). 그래서 점도 글 흐름 안에 둔다.
      const segs: TuiSeg[] = typeof text === 'string' ? [{ t: text }] : text;
      const n = el('div', { class: 'tui-notice tui-notice-' + tone }, el('span', { class: 'tui-dot', 'aria-hidden': 'true', text: '⏺' + VS15 }), ' ', ...segEls(segs));
      if (t) appendWork(t, n); else list.append(n);
    },
    bgDone: (id) => {
      if (!id) return;
      bgFinished.add(id);
      if (!bgAgents.delete(id) || bgAgents.size > 0) return;
      //  마지막 하나가 끝났다 — `Waiting for…` 로 서 있던 턴 끝 줄들을 걸린 시간으로 바꾼다(터미널이 그 줄을 다시 그리면 보이는 꼴).
      (list.querySelectorAll('.tui-done[data-pend]') as NodeListOf<HTMLElement>).forEach((n) => { if (Number(n.dataset.pend) > 0) paintDone(n); });
    },
    removeOpening: () => { list.querySelector('.livc-open')?.remove(); },
    setFooter: (f) => { footSlot.querySelectorAll(':scope > :not(form)').forEach((n) => n.remove()); if (f) { form.hidden = true; footSlot.append(f); } else form.hidden = false; },
    turns: () => turnsArr.slice(),
    setFontStep: (step) => {
      const n = parseFontStep(String(Math.round(step)));
      applyFont(root, n);
      try { localStorage.setItem(CHAT_FONT_KEY, String(n)); } catch { /* 스토리지가 막힌 브라우저 — 이번 화면에만 적용된다 */ }
      scroll();                              // 배율이 바뀌면 높이가 바뀐다 — 바닥에 붙어 있었으면 그대로 둔다
    },
    prependKeepingView: (fn) => prependKeepingView(list, fn),
    destroy: () => {
      document.removeEventListener('keydown', onEsc);
      if (ticker) clearInterval(ticker);
      if (spinTimer) clearInterval(spinTimer);
      try { (document as Document & { fonts?: FontFaceSet }).fonts?.removeEventListener('loadingdone', onFontsDone); } catch { /* 구형 */ }
      if (tui) {
        wideObs?.disconnect();
        tableRo?.disconnect();
        document.removeEventListener('keydown', onTuiKey);
        window.removeEventListener('storage', onTermStorage);
        window.removeEventListener(TERM_PREFS_EVENT, applyTermLook);
        document.removeEventListener('lv:theme-change', applyTermLook);
        try { darkMq?.removeEventListener('change', applyTermLook); } catch { /* 구형 */ }
      }
    },
  };
}

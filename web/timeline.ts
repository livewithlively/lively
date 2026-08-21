// timeline.ts — 우패널 공용 **타임라인**(#1719). 화면마다 대상만 바뀌고 생김새·어휘는 한 벌이다.
//   프로젝트 → 그 프로젝트에서 일어난 일 · AI 세션 → 그 세션이 한 일 · 홈/리브 → 워크스페이스에서 일어난 일.
//
//  ── 무엇을 적나 (상민님 2026-08-18) ──
//   "일반 사람 입장에서 **중요한 변화·새로 만든 파일·중요한 결정**만. 쓸데없는 얘기는 하나도 없게.
//    모두 한 줄 안에 요약하고, 자세한 건 눌러서."
//   규칙 셋:
//    ① 사건이 아닌 것은 **아예 안 적는다** — 임시파일·스크린샷·조회 명령은 일한 자취가 아니다(거르기는 session-trail.ts).
//    ② 한 항목은 **한 줄**이다 — 넘치면 자른다. 원문은 툴팁에. 다만 줄끼리는 숨 쉴 만큼 떨어뜨린다.
//    ②' 필터는 두지 않는다 — 고를 필요가 없도록 애초에 남은 것만 싣는다(상민님 2026-08-18).
//    ③ 일은 **장(章)으로 접힌다** — 세션은 지시 하나가 한 장, 프로젝트는 작업 기록 하나가 한 장.
//       접힌 장에는 제목과 결과 배지(파일 4 · 커밋 1)만 보이고, 누르면 그 안이 펼쳐진다.
//
//  ── 위계 ──
//   손으로 매기지 않는다. tierOf(kind, verb) 규칙 하나가 정한다(상태 어휘 session-status.ts 와 같은 규약).
//    1 중요한 것(기본 보기) — 파일 씀·고침 · 지식 남김 · 커밋 · 작업 기록 · 태스크 끝냄 · 상태 바뀜
//    2 한 일 — 읽음 · 찾아봄 · 검사(빌드·테스트)
//    3 뒷일 — 지시·잔 편집·배관(머지·푸시·서버 반영)
import { el, personFace } from './core.js';

export type TlTier = 1 | 2 | 3;
export type TlKind = 'file' | 'cmd' | 'knowledge' | 'activity' | 'project' | 'task' | 'source' | 'say' | 'reply' | 'meta';

export interface TlActor { id?: string | null; name?: string | null; agent?: string | null }
/** 장 안에 접혀 있는 한 줄 — 그 항목이 스스로 데리고 있는 것(작업 기록의 산출지식·커밋 등). */
export interface TlChild { verb: string; label: string; href?: string | null }
export interface TlItem {
  id: string;
  kind: TlKind;
  verb: string;            // 씀 · 고침 · 남김 · 커밋 · 끝냄 · 기록 · 읽음 · 찾아봄 · 검사 · 지시 …
  label: string;           // 사람 말 한 줄
  key: string;             // 접기 열쇠(같은 것 연속이면 ×N)
  ts?: string;
  tier?: TlTier;
  detail?: string;         // 툴팁·펼침용 부연(한 줄 화면에는 안 나온다)
  actor?: TlActor | null;
  href?: string | null;    // 누르면 갈 가운데 화면
  children?: TlChild[];    // 있으면 이 항목이 곧 장이 된다
  /** 지시 전문(#1819) — 한 줄 제목 뒤에 접어 둔 원문. 붙여넣은 덩어리는 여기에만 산다. */
  full?: string;
  /** 붙여넣은 줄 수(#1819) — 제목으로 세우지 않고 칩으로 접은 덩어리의 크기. */
  pasteLines?: number;
  count: number;
  error?: boolean;
}

// ── 위계표 ──────────────────────────────────────────────────────────────────
const KEEP_VERBS = new Set(['씀', '고침', '남김', '덧붙임', '만듦', '끝냄', '커밋', '기록', '바꿈']);
const KIND_TIER: Record<TlKind, TlTier> = {
  file: 2, cmd: 2, knowledge: 2, activity: 1, project: 2, task: 2, source: 2, say: 3, reply: 3, meta: 3,
};
export function tierOf(it: { kind: TlKind; verb: string; tier?: TlTier }): TlTier {
  if (it.tier) return it.tier;
  if (KEEP_VERBS.has(it.verb)) return 1;
  return KIND_TIER[it.kind] ?? 2;
}

export const TL_KINDS: Array<{ key: TlKind; label: string }> = [
  { key: 'file', label: '파일' }, { key: 'knowledge', label: '지식' }, { key: 'activity', label: '작업 기록' },
  { key: 'cmd', label: '명령' }, { key: 'task', label: '태스크' }, { key: 'project', label: '프로젝트' },
  { key: 'source', label: '자료' }, { key: 'say', label: '지시' }, { key: 'meta', label: '잔 변경' },
];
// 2행에 조용히 놓을 '무엇을 한 일인가' — 라벨이 아니라 문장의 한 조각이다.
//  ⚠ activity 는 비어 있다 — 워크스페이스 타임라인은 대부분이 작업 기록이라 '작업'이 전 행에 반복되면
//    그 단어가 또 소음이 된다(같은 이유로 세션 뷰의 지시도 비움). 단어는 **소수파일 때만 정보**다.
const KIND_WORD: Record<string, string> = {
  task: '끝낸 일', knowledge: '지식', activity: '', cmd: '커밋', file: '파일',
  project: '프로젝트', say: '', reply: '답', source: '자료', meta: '설정',
};

const hhmm = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
};
const dayOf = (iso?: string): string => (iso || '').slice(0, 10);
function dayLabel(key: string): string {
  const today = new Date();
  const t = today.toISOString().slice(0, 10);
  const y = new Date(today.getTime() - 864e5).toISOString().slice(0, 10);
  if (key === t) return '오늘';
  if (key === y) return '어제';
  const d = new Date(key + 'T00:00:00');
  return Number.isFinite(d.getTime()) ? (d.getMonth() + 1) + '월 ' + d.getDate() + '일' : key;
}
const tsNum = (iso?: string): number => { const n = Date.parse(iso || ''); return Number.isFinite(n) ? n : 0; };

// ── 사람 말로 ───────────────────────────────────────────────────────────────
//  개발 도구의 원문(커밋 문법 feat(ui):, 꼬리표 (#1719)·PR #146)을 그대로 붙여넣지 않는다.
const CONV_PREFIX = /^(feat|fix|chore|docs|refactor|test|perf|style|build|ci|design)(\([^)]*\))?:\s*/i;
const TAIL_REF = /\s*[·,]?\s*\(?(?:lively\s*)?(?:dev\s*반영\s*[·,]?\s*)?PR\s*#\d+\)?\s*$/i;
const TAIL_NUM = /\s*\(?#\d+\)?\s*$/;
function stripRefs(t: string): string {
  let s = t;
  for (let i = 0; i < 3; i++) s = s.replace(TAIL_REF, '').replace(TAIL_NUM, '').trim();
  return s;
}
/** 커밋 메시지·PR 제목·지시 → 한 줄. */
export function humanTitle(raw: unknown, max = 44): string {
  let t = String(raw ?? '').split('\n')[0].replace(/\s+/g, ' ').trim().replace(CONV_PREFIX, '');
  t = stripRefs(t);
  const dash = t.search(/\s[—–]\s/);            // 부연은 뒤에 온다 — 앞 마디만
  if (dash > 10) t = t.slice(0, dash);
  return t.length > max ? t.slice(0, max - 1).replace(/[\s·,]+$/, '') + '…' : t;
}
/** 작업 기록 요약 → 한 줄. '중분류 - 내용' 규약이면 내용이 본체다. */
export function humanSummary(raw: unknown, max = 46): string {
  let t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{2,14}?)\s+-\s+(.+)$/);           // '중분류 - 내용' 규약이면 내용이 본체
  if (m) t = m[2];
  const c = t.match(/^([^:：]{2,24})[:：]\s+(.{6,})$/);      // "as-built(#1437): 무엇을 했나" 처럼 앞이 꼬리표
  if (c) t = c[2];
  t = stripRefs(t);
  // 참조성 괄호는 길이와 무관하게 뗀다 — (#1719), (2026-08-18 · PR #164) 같은 건 읽는 사람 몫이 아니다.
  t = t.replace(/\s*\((?=[^)]*(?:#\d|\d{4}-\d{2}))[^)]*\)?\s*/g, ' ').replace(/\s+/g, ' ').trim();
  // 나머지는 **넘칠 때만** 자른다 — 짧은 제목의 부연·나열·괄호는 정보다.
  if (t.length > max) { const i = t.search(/\s[—–]\s/); if (i > 8) t = t.slice(0, i); }
  { const i = t.search(/\s·\s/); if (i > 8) t = t.slice(0, i); }   // 나열(·)은 길이와 무관하게 첫 마디만 — 여러 건을 한 줄에 욱여넣은 표시다
  if (t.length > max) { const i = t.search(/\s*\(/); if (i >= 6) t = t.slice(0, i); }
  t = stripRefs(t).replace(/[\s·,:=+-]+$/, '').trim();
  return t.length > max ? t.slice(0, max - 1).replace(/[\s·,]+$/, '') + '…' : t;
}

export interface TimelineCtx {
  scope: string;
  showActors?: boolean;
  empty?: string;
  /** 세션처럼 '지시 하나 = 한 장'으로 묶을 화면이면 true. */
  chapters?: boolean;
  /** 남긴 것이 없는 지시도 **한 장으로 세운다**(chapters 와 함께 쓴다).
   *  기본은 지운다 — 프로젝트·워크스페이스 타임라인에서 '아무것도 안 남은 지시'는 사건이 아니기 때문이다.
   *  세션 발자취는 반대다: 내가 무엇을 시켰나가 곧 그 세션의 줄기라, 아직 아무것도 안 남았어도 그 자리에 있어야 한다
   *  (원준 2026-08-20: "타임라인에는 내가 올린 질문들도 보였으면 좋겠고"). */
  allSays?: boolean;
  /** 결과물 보기(#1756) — 무슨 일이 있었나가 아니라 **무엇이 남았나**. 세션 화면이 쓴다. */
  outcomes?: boolean;
}
export interface TimelineHandle {
  add(item: { id: string; kind: string; verb: string; label: string; key: string; ts?: string; detail?: string; actor?: TlActor | null; href?: string | null; tier?: TlTier; children?: TlChild[]; full?: string; pasteLines?: number }, at?: 'end' | 'start'): void;
  result(id: string, output: string, isError: boolean): void;
  addAll(items: Array<Omit<TlItem, 'count'> & { count?: number }>): void;
  setNote(note: string | null): void;
  /** 머리 바 바로 아래 한 줄(세션 사실 등). null 이면 그 줄 자체가 없다. */
  setMeta(node: HTMLElement | null): void;
  clear(): void;
  root: HTMLElement;
}

export function createTimeline(host: HTMLElement, ctx: TimelineCtx): TimelineHandle {
  let items: TlItem[] = [];                    // 시간순(오래된 → 최신). 화면은 최신이 위.
  const byId = new Map<string, TlItem>();
  const open = new Set<string>();              // 펼친 장
  let dirty = false;

  const countEl = el('span', { class: 'v2-k' });
  const list = el('div', { class: 'tl-list' });
  const emptyEl = el('p', { class: 'v2-empty', text: ctx.empty || '아직 기록이 없어요.' });
  const noteEl = el('p', { class: 'v2-fine', hidden: true });
  // 골격은 가운데 화면과 같다(#1756): [머리 바][사실 한 줄] + 본문만 스크롤.
  //  가운데 대화창(sc-head → sc-chat)과 같은 자리에 같은 선이 지나가야 두 열이 한 판으로 읽힌다.
  const factsEl = el('div', { class: 'tl-facts', hidden: true });

  // ── 보는 차례(#1819 원준 2026-08-21) ────────────────────────────────────────
  //  items 는 늘 시간순(오래된 → 최신)으로 쌓이고, **그리는 차례만** 이 스위치가 정한다.
  //  기본은 최신이 위 — 세션을 열면 방금 있었던 일이 먼저 보여야 한다. 과거순은 처음부터 훑어 읽을 때 쓴다.
  //  취향이라 브라우저에 남긴다(칸 배치와 같은 급). 프라이빗 모드에선 저장이 막히므로 조용히 기본값으로 간다.
  const ORDER_KEY = 'lively_tl_order';
  let newestFirst = true;
  try { newestFirst = localStorage.getItem(ORDER_KEY) !== 'old'; } catch (_) { /* 저장이 막힌 브라우저 */ }
  /** 그리는 차례 — 최신순이면 뒤집어 그린다(원본은 건드리지 않는다). */
  const inOrder = <T>(arr: T[]): T[] => (newestFirst ? arr.slice().reverse() : arr);

  const ordBtn = el('button', { class: 'tl-ord', type: 'button' }) as HTMLButtonElement;

  // ── 얼마나 자세히(#1819 원준 2026-08-21) ─────────────────────────────────────
  //  "답 밑에 고침·고침·커밋 이런 거, 컴팩트하게 보고 싶어하는 사람한테는 굳이 안 보여줄 수 있으면."
  //  무엇이 남았나는 어떤 사람에겐 본론이고 어떤 사람에겐 소음이다 — 한쪽으로 정하지 말고 **사람이 고르게** 한다.
  //  ⚠ 간단히에서도 **지우지는 않는다**: 남은 것이 있는 장에는 답 끝에 `+N` 칩이 서고, 그 장만 펼칠 수 있다.
  //   안 보이는 것과 없는 것은 다르다(결과물 보기의 '접힘 줄'과 같은 규약).
  const COMPACT_KEY = 'lively_tl_compact';
  let compact = false;
  try { compact = localStorage.getItem(COMPACT_KEY) === '1'; } catch (_) { /* 저장이 막힌 브라우저 */ }
  const cmpBtn = el('button', { class: 'tl-ord tl-cmp', type: 'button', hidden: !ctx.chapters }) as HTMLButtonElement;

  function paintHeadBtns(): void {
    ordBtn.replaceChildren(
      el('span', { class: 'tl-ord-i', 'aria-hidden': 'true', text: '⇅' }),
      el('span', { text: newestFirst ? '최신순' : '과거순' }));
    ordBtn.title = newestFirst
      ? '지금은 최신이 맨 위에 있습니다. 누르면 과거순으로 바뀝니다.'
      : '지금은 과거가 맨 위에 있습니다. 누르면 최신순으로 바뀝니다.';
    cmpBtn.replaceChildren(
      el('span', { class: 'tl-ord-i', 'aria-hidden': 'true', text: '≡' }),
      el('span', { text: compact ? '간단히' : '자세히' }));
    cmpBtn.title = compact
      ? '지금은 질문과 답만 보입니다. 누르면 남은 것(파일·커밋·지식)까지 펼칩니다.'
      : '지금은 남은 것(파일·커밋·지식)까지 보입니다. 누르면 접어서 질문과 답만 봅니다.';
  }
  cmpBtn.addEventListener('click', () => {
    compact = !compact;
    try { localStorage.setItem(COMPACT_KEY, compact ? '1' : '0'); } catch (_) { /* noop */ }
    paint();
  });
  const scrollEl = el('div', { class: 'tl-scroll' }, list, emptyEl, noteEl);
  ordBtn.addEventListener('click', () => {
    newestFirst = !newestFirst;
    try { localStorage.setItem(ORDER_KEY, newestFirst ? 'new' : 'old'); } catch (_) { /* noop */ }
    paint();
    // 차례를 뒤집으면 '지금'이 반대편 끝으로 간다 — 그 자리로 데려간다(안 그러면 옛날 얘기만 보인 채로 남는다).
    scrollEl.scrollTop = newestFirst ? 0 : scrollEl.scrollHeight;
  });

  const root = el('section', { class: 'tl-wrap' },
    el('div', { class: 'v2-aside-h' }, el('b', { text: '타임라인' }), el('span', { class: 'tl-scope', text: ctx.scope }), ordBtn, cmpBtn, countEl),
    factsEl,
    scrollEl);
  host.append(root);

  const isHead = (it: TlItem): boolean => !!ctx.chapters && it.kind === 'say' && it.verb === '지시';

  // ── 한 항목 = 원장(ledger) 한 줄 ──────────────────────────────────────
  //  상민님 2026-08-18: "너무 정신없고 이쁘지 않다. 파일·중요 변경점과도 조화롭게 — 완전 변경."
  //  종전 카드는 한 행에 일곱 가지(동사색·제목·배지·얼굴·이름·시각·자세히)가 경쟁했다. 반복되는 것
  //  (이름·배지·자세히)이 소음이고 변하는 것(제목)이 눌려 있었다. 그래서 **회계 원장의 문법**으로 바꾼다
  //  (덱 디자인 시스템 "Ledger & Pulse"의 Ledger 를 제품에 들여온 것):
  //   · 시각이 왼쪽 거터에 모노로 선다 — 세로로 정렬된 숫자가 그 자체로 리듬이다.
  //   · 그 아래 종류 한 단어(지식·기능·파일…)가 조용히 붙는다 — 색 코드는 전부 걷는다
  //     (범례 없는 색 축은 정보가 아니라 소음이다). 색은 오류(코랄) 하나만.
  //   · 본문은 제목뿐이다. 사람은 얼굴 하나 — 그것도 앞 행과 같은 사람이면 안 그린다.
  const faceOf = (a?: TlActor | null): HTMLElement | null =>
    (ctx.showActors && a && (a.id || a.name) ? personFace(String(a.id || ''), 'tl-face', String(a.name || a.id || '')) : null);

  function card(it: TlItem, kids: TlItem[], sameWho: boolean): HTMLElement {
    const canOpen = kids.length > 0 || (it.children || []).length > 0;
    const isOpen = open.has(it.id);
    const body = canOpen
      ? el('div', { class: 'tl-body', hidden: !isOpen }, ...kids.slice().reverse().map(sub), ...(it.children || []).map(childLine))
      : null;
    const face = sameWho ? null : faceOf(it.actor);
    const kindWord = it.kind === 'cmd' && it.detail ? it.detail + '번' : (KIND_WORD[it.kind] || '');
    const box = el(it.href && !canOpen ? 'a' : 'div', {
      class: 'tl-card tlk-' + it.kind + (canOpen ? ' can' : '') + (isOpen ? ' open' : '') + (it.href && !canOpen ? ' go' : '') + (it.error ? ' err' : ''),
      // 실험장(#1719 원준): 지식 카드는 판(작업대)으로 끌어다 문서 위젯이 된다.
      draggable: it.href && String(it.href).startsWith('#/k/') ? 'true' : null,
      ondragstart: it.href && String(it.href).startsWith('#/k/') ? ((e: DragEvent) => { e.dataTransfer?.setData('text/plain', 'tl:' + JSON.stringify({ href: it.href, label: it.label })); }) : null,
      href: it.href && !canOpen ? it.href : null,
      title: [it.label, it.detail, it.actor && it.actor.name ? String(it.actor.name) : ''].filter(Boolean).join('\n'),
    },
      el('div', { class: 'tl-gut' }, el('span', { class: 'tl-tm', text: hhmm(it.ts) }), kindWord ? el('span', { class: 'tl-kw', text: kindWord }) : null),
      el('div', { class: 'tl-main' },
        el('div', { class: 'tl-head' },
          el('span', { class: 'tl-ttl', text: it.label || '(이름 없음)' }),
          it.count > 1 ? el('span', { class: 'tl-x', text: '×' + it.count }) : null,
          face,
          canOpen ? el('span', { class: 'tl-car', 'aria-hidden': 'true', text: '›' }) : null),
        body));
    if (canOpen) {
      box.setAttribute('role', 'button');
      box.setAttribute('tabindex', '0');
      box.setAttribute('aria-expanded', String(isOpen));
      const toggle = () => { if (isOpen) open.delete(it.id); else open.add(it.id); paint(); };
      box.addEventListener('click', (e: Event) => { if ((e.target as HTMLElement).closest('a')) return; toggle(); });
      box.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    }
    return box;
  }
  /** 펼친 카드 안의 한 줄 — 맥락은 카드가 잡았으니 여기서는 촘촘해도 된다. */
  function sub(it: TlItem): HTMLElement {
    return el(it.href ? 'a' : 'div', { class: 'tl-sub' + (it.href ? ' go' : '') + (it.error ? ' err' : ''), href: it.href || null, title: it.label },
      el('span', { class: 'tl-sub-v tlk-' + it.kind, text: it.verb }),
      el('span', { class: 'tl-sub-t', text: it.label }),
      it.count > 1 ? el('span', { class: 'tl-x', text: '×' + it.count }) : null,
      el('span', { class: 'tl-tm', text: hhmm(it.ts) }));
  }
  function childLine(c: TlChild): HTMLElement {
    return el(c.href ? 'a' : 'div', { class: 'tl-sub' + (c.href ? ' go' : ''), href: c.href || null, title: c.label },
      el('span', { class: 'tl-sub-v', text: c.verb }), el('span', { class: 'tl-sub-t', text: c.label }));
  }

  // ── 결과물 보기(#1756, 다른 세션 작업 — 이 브랜치의 카드 구조에 맞춰 합침) ──
  //  상민님: "결과물 위주로. 사소한 건 됐고, 전체 맥락에 중요한 영향 끼칠 것만."
  //  ① 같은 대상은 한 장으로 접는다(같은 파일을 열 번 고쳤어도 그 파일은 하나다 — 횟수는 ×N 으로).
  //  ② 지시는 결과물이 아니다(무엇을 시켰나는 가운데 대화가 말한다).
  //  ③ 남는 것과 과정을 **종류로 가른다** — 무게 점수는 통하지 않았다(아래).
  //
  //  ★ 무엇이 카드가 되나 (상민님 2026-08-18, 두 차례 되돌아온 피드백)
  //    "정말로 누가 봐도 유의미한 변화가 있는 것만 올라가야지 그냥 다 올라가잖아."
  //    "커밋도 솔직히 별로 쓸데없지. 추가된 기능 정도만 보이면 되잖아."
  //   처음엔 무게 점수(파일 45 + 반복 가산, 55점 이상 노출)로 걸렀는데 **여러 번 고친 파일이 그대로 통과**해
  //   결국 다 올라오는 화면이 됐다(실측: 이 화면을 만든 세션은 도구 호출 109건 중 대부분이 파일 편집 —
  //   파일 4개를 14번 고쳤고 커밋·지식은 몇 건뿐이었다). 그래서 점수가 아니라 **종류**로 가른다:
  //   그런데 종류로 뭉텅이로 자르면 **중요한 커밋까지 같이 사라진다**(상민님: "커밋 중요한 것도 있을 텐데
  //   다 빼면 어떡해"). 그래서 종류로 자르는 게 아니라 **항목마다 판단한다**:
  //     · 조직에 남는 것(작업 기록·지식·프로젝트·태스크) — 언제나 결과다.
  //     · 커밋 — 메시지가 말해 준다. 개발 관례(feat·design·fix…)가 이미 '기능이 생겼다'와
  //       '치우는 일'을 가르고 있으므로 그 판정을 그대로 쓴다(session-trail.ts 가 tier 로 실어 보낸다).
  //     · 파일 — **새로 만든 것**은 결과(없던 게 생겼다), **고친 것**은 과정(몇 번 고쳤나는 결과가 아니다).
  //   나머지는 지우지 않고 접는다 — 안 보이는 것과 없는 것은 다르고, 접힘 줄은 무엇을 접었는지 그대로 말한다.
  const OUTCOME_KINDS = new Set<TlKind>(['activity', 'knowledge', 'project', 'task']);
  const isOutcome = (it: TlItem): boolean =>
    OUTCOME_KINDS.has(it.kind) ? true
      : it.kind === 'cmd' ? (it.verb === '커밋' && tierOf(it) === 1)     // 기능·수정 커밋만(치우는 커밋은 접힘)
        : it.kind === 'file' ? it.verb === '씀'                          // 새로 만든 파일만
          : false;
  /** 접힌 것의 이름 — '그 밖에 N개'는 열어 보기 전엔 아무 뜻이 없다. */
  function restLabel(rest: TlItem[]): string {
    const files = rest.filter((it) => it.kind === 'file').length;
    const commits = rest.filter((it) => it.kind === 'cmd' && it.verb === '커밋').length;
    const etc = rest.length - files - commits;
    const parts: string[] = [];
    if (files) parts.push(`손댄 파일 ${files}개`);
    if (commits) parts.push(`커밋 ${commits}개`);
    if (etc) parts.push(`그 밖 ${etc}개`);
    return parts.join(' · ') + ' 보기';
  }
  let restOpen = false;
  function outcomes(): { keep: TlItem[]; rest: TlItem[] } {
    const by = new Map<string, TlItem>();
    for (const it of items) {
      if (it.kind === 'say' || it.kind === 'reply') continue;
      const k = it.kind + '|' + it.label;
      const cur = by.get(k);
      if (!cur) { by.set(k, { ...it }); continue; }
      cur.count += it.count;
      if (tsNum(it.ts) > tsNum(cur.ts)) cur.ts = it.ts;
      if (it.verb === '씀' || it.verb === '만듦') cur.verb = it.verb;   // 만든 것이 고친 것을 이긴다
      if (it.children && it.children.length) cur.children = [...(cur.children || []), ...it.children];
    }
    const all = [...by.values()].sort((a2, b2) => tsNum(a2.ts) - tsNum(b2.ts));
    return { keep: all.filter(isOutcome), rest: all.filter((it) => !isOutcome(it)) };
  }
  function paintOutcomes(): void {
    const { keep, rest } = outcomes();
    countEl.textContent = String(keep.length);
    emptyEl.hidden = keep.length > 0 || rest.length > 0;
    const kids: HTMLElement[] = [];
    let day = ' ';
    let lastWho = '\u0000';
    let rail: HTMLElement = el('div', { class: 'tl-rail' });
    const shown = restOpen ? [...keep, ...rest].sort((a2, b2) => tsNum(a2.ts) - tsNum(b2.ts)) : keep;
    for (const it of inOrder(shown)) {                            // 차례는 머리 바의 [최신순/과거순]이 정한다
      const d = dayOf(it.ts);
      if (d !== day) {
        day = d; lastWho = '\u0000';
        if (d) kids.push(el('div', { class: 'tl-day' }, el('span', { text: dayLabel(d) })));
        rail = el('div', { class: 'tl-rail' });
        kids.push(el('div', { class: 'tl-group' }, rail));       // 하루 = 한 판(이 브랜치의 구조)
      }
      const who = String((it.actor && it.actor.id) || '');
      rail.append(card(it, [], who === lastWho));
      lastWho = who;
    }
    if (rest.length) {
      kids.push(el('button', {
        class: 'tl-rest', type: 'button', 'aria-expanded': String(restOpen),
        onclick: () => { restOpen = !restOpen; paint(); },
      }, restOpen ? '과정 접기' : restLabel(rest)));
    }
    list.replaceChildren(...kids);
  }

  // ── 질문·대답(#1819 원준 2026-08-21) ────────────────────────────────────────
  //  ★ 타임라인은 프로젝트가 아니라 **세션**에 딸린 위젯이다. 세션에서 일이 벌어지는 단위는 '내가 시킨 것 하나'이므로
  //   장(章)의 머리는 내 지시(질문)이고, 몸은 그 지시에 대한 답이다:
  //    [질문] 내가 한 말 한 줄. 붙여넣은 덩어리는 제목으로 세우지 않고 '붙여넣은 글 N줄' 칩으로 접는다(눌러서 전문).
  //           — 로그를 통째로 붙여넣은 지시가 제목이 되면 그 한 장이 화면을 다 먹는다(원준 2026-08-21).
  //    [답]   AI 가 한 말 첫 문장 + 그 지시에서 **남은 것**(파일·지식·커밋·작업 기록).
  //  ⚠ 한 장에 답은 여러 번 온다("확인하겠습니다" → 도구 → … → 최종 답). 세우는 것은 **마지막 것**이다.
  //  ⚠ 거터의 말은 '나·다온'이 아니라 '질문·답'이다 — 페르소나 이름은 조직마다 다르므로 화면에 박지 않는다.
  interface Chap { q: TlItem | null; a: TlItem | null; kids: TlItem[] }
  function chapters(): Chap[] {
    const out: Chap[] = [];
    let cur: Chap | null = null;
    for (const it of items) {
      if (isHead(it)) { cur = { q: it, a: null, kids: [] }; out.push(cur); continue; }
      if (!cur) { cur = { q: null, a: null, kids: [] }; out.push(cur); }   // 창 첫머리(되그린 꼬리) — 버리지 않는다
      if (it.kind === 'reply') { cur.a = it; continue; }
      cur.kids.push(it);
    }
    // allSays 면 아직 아무 결과도 없는 지시도 선다(세션 발자취의 줄기는 '내가 뭘 시켰나'다).
    return out.filter((c) => (c.q ? (ctx.allSays || !!c.a || c.kids.length > 0) : (!!c.a || c.kids.length > 0)));
  }

  /** 질문 한 줄 — 붙여넣은 덩어리는 칩으로 접고, 전문은 눌러서 편다. */
  function askRow(it: TlItem): HTMLElement {
    const isOpen = open.has(it.id);
    const box = el('div', {
      class: 'tl-card tl-q tlk-say' + (it.full ? ' can' : '') + (isOpen ? ' open' : ''),
      title: it.label,
    },
      el('div', { class: 'tl-gut' }, el('span', { class: 'tl-tm', text: hhmm(it.ts) }), el('span', { class: 'tl-kw', text: '질문' })),
      el('div', { class: 'tl-main' },
        it.pasteLines ? el('div', { class: 'tl-paste' }, el('span', { text: '붙여넣은 글 ' + it.pasteLines + '줄' })) : null,
        el('div', { class: 'tl-head' },
          el('span', { class: 'tl-ttl', text: it.label || '(빈 지시)' }),
          it.full ? el('span', { class: 'tl-car', 'aria-hidden': 'true', text: '›' }) : null),
        it.full ? el('pre', { class: 'tl-full', hidden: !isOpen, text: it.full }) : null));
    if (it.full) {
      box.setAttribute('role', 'button');
      box.setAttribute('tabindex', '0');
      box.setAttribute('aria-expanded', String(isOpen));
      const toggle = (): void => { if (isOpen) open.delete(it.id); else open.add(it.id); paint(); };
      box.addEventListener('click', toggle);
      box.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    }
    return box;
  }

  /** 대답 — 한 줄 + 그 지시에서 남은 것. 둘 다 없으면 줄 자체가 없다(아직 도는 중인 장). */
  function ansRow(c: Chap): HTMLElement | null {
    if (!c.a && !c.kids.length) return null;
    // 간단히에서 접는 것은 **답이 있는 장의 남은 것**뿐이다 — 답이 없으면 남은 것이 그 장의 유일한 내용이라
    //  접으면 빈 줄만 남는다(접기가 화면에서 사건을 지워 버리면 안 된다).
    const cid = 'kids:' + String((c.q && c.q.id) || (c.a && c.a.id) || (c.kids[0] && c.kids[0].id) || '');
    const canHide = compact && !!c.a && c.kids.length > 0;
    const openKids = !canHide || open.has(cid);
    const chip = canHide
      ? el('button', {
          class: 'tl-kidsn', type: 'button', 'aria-expanded': String(openKids),
          title: openKids ? '남은 것을 다시 접습니다.' : `이 지시에서 남은 것 ${c.kids.length}개를 폅니다.`,
          onclick: (e: Event) => { e.stopPropagation(); if (openKids) open.delete(cid); else open.add(cid); paint(); },
        }, (openKids ? '−' : '+') + c.kids.length)
      : null;
    return el('div', { class: 'tl-card tl-a tlk-reply' + (c.a && c.a.error ? ' err' : '') },
      el('div', { class: 'tl-gut' }, el('span', { class: 'tl-kw', text: '답' })),
      el('div', { class: 'tl-main' },
        c.a ? el('div', { class: 'tl-head' }, el('span', { class: 'tl-ttl tl-ans', text: c.a.label, title: c.a.label }), chip) : null,
        c.kids.length && openKids ? el('div', { class: 'tl-kids' }, ...c.kids.map(sub)) : null));
  }

  function paintQA(): void {
    const chaps = chapters();
    countEl.textContent = String(chaps.length);
    emptyEl.hidden = chaps.length > 0;
    const kids: HTMLElement[] = [];
    let day = ' ';
    let rail: HTMLElement = el('div', { class: 'tl-rail' });
    for (const c of inOrder(chaps)) {                          // 차례는 머리 바의 [최신순/과거순]이 정한다
      const it0 = c.q || c.a || c.kids[0];
      const d = dayOf(it0 && it0.ts);
      if (d !== day) {
        day = d;
        if (d) kids.push(el('div', { class: 'tl-day' }, el('span', { text: dayLabel(d) })));
        rail = el('div', { class: 'tl-rail' });
        kids.push(el('div', { class: 'tl-group' }, rail));     // 하루 = 한 판(다른 보기와 같은 골격)
      }
      rail.append(el('div', { class: 'tl-qa' }, c.q ? askRow(c.q) : null, ansRow(c)));
    }
    list.replaceChildren(...kids);
  }

  // ── 그리기 ──
  //  갈래(질문·대답 / 결과물 / 옛 목록)를 고르고, **차례에 딸린 뒷일**은 여기서 한 번만 한다.
  function paint(): void {
    // 과거순은 새 항목이 **아래**로 붙는다 — 바닥을 보고 있던 사람은 계속 바닥에 있어야 방금 일어난 일이 보인다.
    const stick = !newestFirst && scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 24;
    paintHeadBtns();
    if (ctx.chapters) paintQA();
    else if (ctx.outcomes) paintOutcomes();
    else paintRows();
    if (stick) scrollEl.scrollTop = scrollEl.scrollHeight;
  }
  function paintRows(): void {
    type Row = { head: TlItem; kids: TlItem[] } | { solo: TlItem };
    const rows: Row[] = [];
    let cur: { head: TlItem; kids: TlItem[] } | null = null;
    for (const it of items) {
      if (isHead(it)) { cur = { head: it, kids: [] }; rows.push(cur); continue; }
      if (cur) cur.kids.push(it); else rows.push({ solo: it });
    }
    // 장은 안에 남은 것이 있을 때만 세운다 — 아무것도 안 남은 지시는 타임라인의 사건이 아니다.
    //  단 allSays 면 반대로 **모든 지시가 선다**(세션 발자취 — 위 TimelineCtx.allSays 주석).
    const shownRows = rows.filter((r) => ('solo' in r ? true : ctx.allSays || r.kids.length > 0));
    const shownCount = rows.reduce((n, r) => n + ('solo' in r ? 1 : r.kids.length + (ctx.allSays ? 1 : 0)), 0);
    countEl.textContent = String(shownCount);
    emptyEl.hidden = shownCount > 0;

    // 하루가 **한 판**이다. 종전엔 항목마다 흰 카드가 서서 말풍선이 줄줄이 붙은 꼴이었다(상민님: "다다다닥 붙어 거슬린다").
    //  이제 판은 날짜 하나에 하나뿐이고, 그 안에서 항목은 얇은 선으로만 나뉜다 — 반복되는 상자가 사라진다.
    const kids: HTMLElement[] = [];
    let day = ' ';
    let lastWho = '\u0000';
    let rail: HTMLElement = el('div', { class: 'tl-rail' });
    for (const r of inOrder(shownRows)) {                       // 차례는 머리 바의 [최신순/과거순]이 정한다
      const it0 = 'solo' in r ? r.solo : r.head;
      const d = dayOf(it0.ts);
      if (d !== day) {
        day = d;
        lastWho = '\u0000';                                     // 날이 바뀌면 누구인지 다시 밝힌다
        if (d) kids.push(el('div', { class: 'tl-day' }, el('span', { text: dayLabel(d) })));
        rail = el('div', { class: 'tl-rail' });
        kids.push(el('div', { class: 'tl-group' }, rail));
      }
      const who = String((it0.actor && it0.actor.id) || '');
      rail.append('solo' in r ? card(r.solo, [], who === lastWho) : card(r.head, r.kids, who === lastWho));
      lastWho = who;
    }
    list.replaceChildren(...kids);
  }
  function schedule(): void {
    if (dirty) return;
    dirty = true;
    requestAnimationFrame(() => { dirty = false; paint(); });
  }

  // 같은 것은 **떨어져 있어도** 한 줄로 합친다 — 한 지식을 세 번 덧붙였다고 세 줄이 되면 그건 사건이 아니라 반복이다.
  //  합칠 때 맨 뒤로 옮겨, 지금 하는 일(마지막 장) 아래에 놓이게 한다.
  const byKey = new Map<string, TlItem>();
  function merge(it: TlItem, at: 'end' | 'start'): boolean {
    const prev = byKey.get(it.key);
    if (!prev || prev.error || it.error) return false;
    prev.count++;
    if (at === 'end') {
      if (it.ts) prev.ts = it.ts;
      const i = items.indexOf(prev);
      if (i >= 0 && i !== items.length - 1) { items.splice(i, 1); items.push(prev); }
    }
    byId.set(it.id, prev);
    return true;
  }

  const h: TimelineHandle = {
    root,
    add(raw, at = 'end') {
      const it: TlItem = { count: 1, ...raw, kind: (raw.kind as TlKind) || 'cmd' };
      if (!merge(it, at)) {
        if (at === 'end') items.push(it); else items.unshift(it);
        byId.set(it.id, it); byKey.set(it.key, it);
        // #1819 — 장 머리를 자동으로 펼치던 규칙은 뺐다. 이제 접는 것은 '장의 몸'이 아니라 **지시 전문**이고,
        //  그건 기본이 접힘이어야 한다(붙여넣은 로그가 열린 채로 뜨면 그 한 장이 화면을 다 먹는다).
      }
      schedule();
    },
    result(id, _output, isError) {
      const it = byId.get(id);
      if (!it || !isError) return;
      it.error = true;
      schedule();
    },
    addAll(next) {
      for (const raw of next) {
        const it: TlItem = { count: 1, ...raw };
        const old = byId.get(it.id);
        if (old) { Object.assign(old, it, { count: old.count }); continue; }
        items.push(it); byId.set(it.id, it); byKey.set(it.key, it);
      }
      items.sort((a, b) => tsNum(a.ts) - tsNum(b.ts));
      schedule();
    },
    setNote(note) { noteEl.textContent = note || ''; noteEl.hidden = !note; },
    setMeta(node) { factsEl.replaceChildren(...(node ? [node] : [])); factsEl.hidden = !node; },
    clear() { items = []; byId.clear(); byKey.clear(); open.clear(); schedule(); },
  };
  paint();
  return h;
}

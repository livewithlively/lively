// v2/omni.ts — 통합검색(상민님 2026-08-20: "맥의 spotlight·클로드 데스크탑 검색처럼 지식·프로젝트·자료·세션이력 등
//  검색 가능한 자원이 전부 한 결과에 보이게. 웹에서도 쓸 수 있게").
//
//  ── 왜 한 칸인가 ──
//  자원마다 검색칸이 따로 있으면 사람은 **찾기 전에 어디서 찾을지**를 먼저 정해야 한다. 기억에 남는 건 "그 얘기 어디서
//  봤더라"이지 "그건 지식이었나 자료였나"가 아니다. 입구를 하나로 두고, 무엇이었는지는 **결과가 말한다**(줄마다 종류).
//
//  ── 3차(#4530, 원준 2026-10-01) — 무엇이 바뀌었나 ──
//   원준: «관련도가 적당히 있는 걸 시간순으로 보여 줘야지 … 슬랙도 참고하고» · «주로 쓰는 게 세션 내부의 대화 내용의 일부나
//    그 세션에서 고쳤던 대상을 어렴풋하게 쳐서 그 세션을 찾는 것» · «폰에서는 애초에 보이는 화면이 별로 없을걸».
//   점검(지식 omni-search-audit-defects-4530)에서 46건을 찾았고, 이 판이 그걸 고친다. 큰 줄기 넷:
//   ① 순서 — 기본은 **맨 위 «가장 맞는 결과» 최대 셋 + 낱말이 모두 글자로 맞은 것을 최근 것부터**(슬랙 Recent + Top Results).
//      뜻만 비슷한 것(similar)은 섞지 않고 맨 아래 «뜻이 비슷한 지식» 에만 둔다 — 0.48 문턱이 무관한 것을 통과시켰다(실측).
//      글자 검색은 서버가 «화면용 글 그대로»(plain=1: 괄호·물음표를 글자로, 조사 뗀 꼴로도)로 찾는다.
//   ② 치는 동안 화면을 흔들지 않는다 — 새 결과가 다 올 때까지(최대 SETTLE_MS) 앞 결과를 흐리게 둔 채 한 번에 바꾼다.
//      선택은 **줄의 열쇠**로 기억한다(번호로 기억하면 늦게 온 줄이 끼어들어 다른 것이 열렸다 — 실측 3/3).
//      Enter 는 결과가 자리 잡은 뒤의 줄을 연다(종전: 0.2초 안에 누르면 빈 칸의 최근 세션이 열렸다 — 실측).
//   ③ 줄 하나가 말하는 것 — 지식 제목의 머리말(«as-built(#…):»)은 떼어 작게, 둘째 줄은 마크다운 기호·자동 안내문을 걷고,
//      완료·보관·초안 표시와 태스크의 상위 프로젝트, 줄마다 시각.
//   ④ 여닫기 — 닫으면 쓰던 자리로 초점을 돌려준다 · 칩을 눌러도 입력칸에 초점이 남는다 · 주소가 바뀌면 닫힌다 ·
//      폰에서는 전체 화면(키보드 위까지)으로 열린다 · 직전 검색어·최근 연 것을 기억한다.
//
//  ── 구조: 팬아웃 ──
//  · 대화      GET /api/ui/v6/session-search  (세션 단위 · 조사 · 고친 파일 · 맨 위 셋 표시, #4530)
//  · 지식      GET /api/ui/knowledge/search?plain=1   (글자 · 제목에 든 것 먼저)
//  · 프로젝트  GET /api/ui/v6/projects/search?plain=1 (글자 · 휴지통 제외 · 완료/보관/초안 표시)
//  · 뜻 비슷   GET /api/ui/knowledge/similar           (맨 아래 묶음 전용)
//  · 자료      GET /api/ui/sources?q=                  (칩으로만)
//  · 세션·화면·분류·리스트·설정·명령 — 셸이 쥔 목록에서(네트워크 0)
//  공개범위는 **전부 서버가 시행한다**(#1291) — 여기서 거르지 않는다.
import { api, el, sv, wsKey } from '../core.js';
import { ICONS } from '../lib/icon-paths.js';   // #4233 선 아이콘 한 벌
import { appHref, visibleApps } from './apps.js';
import { appMatches } from '../lib/app-match.js';   // #4233 옛 이름으로도 찾는다(런치패드와 같은 잣대)
import { sessText } from './side.js';
import { projName, findSessByConv, isTrashedSess, isMineSess, type Sess, type V2Data } from './views.js';
import { showCtxMenu, ctxIsOpen, closeCtxMenu } from './ctx-menu.js';   // 기간 고르기 — 화면 어디서나 같은 메뉴 한 벌(#3784)
import {
  type OmniSort, type OmniPeriod, SORT_STORE, SORT_LABEL, readSort, PERIODS, periodLabel, periodSince, inPeriod,
  dayBucket, whenLabel, byRecent, atOf,
} from '../lib/omni-order.js';   // #4517 정렬·기간 규칙(순수)
import {
  type Term, parseTerms, matchAll, matchAllAcross, highlightWords, splitKnowTitle, cleanSnippet, identKind, pickTop,
} from '../lib/omni-rank.js';   // #4530 순서·줄 다듬기 규칙(순수)
import { isOmniChordLike, OMNI_MSG, OMNI_CLOSED_MSG, type ChordLike } from '../lib/omni-chord.js';   // #4530 여는 키 판정 · 신호 이름 한 벌
import { projHitHref } from '../lib/proj-page.js';   // #3870 프로젝트 줄은 프로젝트 화면으로(사이드바 [→] 와 같은 문)

type Kind = 'proj' | 'know' | 'src' | 'sess' | 'conv' | 'app';

interface Hit {
  kind: Kind;
  key: string;            // 줄의 열쇠(같은 항목이면 같다) — 선택·중복 제거의 기준
  title: string;
  /** 지식 제목에서 뗀 머리말(«as-built · #4135») — 작게 보인다. */
  head?: string;
  sub: string;            // 둘째 줄
  href?: string;          // 셸 라우트(명령 줄은 없고 run 이 있다)
  run?: () => void;
  ident?: string;         // 번호(프로젝트) · key(지식)
  at?: number;            // 줄의 시각(ms)
  /** 종류 안의 이름(태스크 · 분류 · 리스트 · 폴더 · 설정 · 명령 …) — 배지 글. 없으면 종류 이름. */
  label?: string;
  /** 완료 · 보관 · 초안 · 취소 — 작은 표시. */
  status?: string;
  /** 태스크의 상위 프로젝트 · 남의 세션의 주인 — 둘째 줄 앞에 붙는다. */
  context?: string;
  /** 대화로 맞은 세션 — 대표 말이 누구의 말인가 · 맞은 곳 수 · 고친 파일로 맞았으면 그 파일. */
  role?: 'user' | 'assistant';
  hits?: number;
  edit?: string | null;
  /** 서버가 «가장 맞는 대화» 로 표시했다. */
  serverTop?: boolean;
  /** 서버가 매긴 순서(작을수록 앞). */
  order?: number;
  /** 뜻만 비슷해서 온 줄(맨 아래 묶음 전용) · 그 점수. */
  sim?: boolean;
  score?: number;
}

interface OmniHooks {
  data(): V2Data;
  /** 셸 이동 — 탭 규칙은 셸이 안다(사이드바와 같은 «있으면 그 창, 없으면 새 창»). title 은 탭 이름 힌트. */
  open(href: string, newTab: boolean, title?: string): void;
  /** 새 세션을 그 글로 시작한다(명령 «새 세션»). 없으면 명령을 안 보인다. */
  newSession?(seed: string): void;
  /** [나] 창의 한 칸을 연다(«설정» 줄). 없으면 설정 줄을 안 보인다. */
  openMe?(tab: string): void;
}

const GROUPS: Array<{ kind: Kind; label: string }> = [
  { kind: 'sess', label: '세션' },
  { kind: 'conv', label: '대화' },
  { kind: 'proj', label: '프로젝트' },
  { kind: 'know', label: '지식' },
  { kind: 'src', label: '자료' },
  { kind: 'app', label: '바로 가기' },
];
const KIND_LABEL: Record<Kind, string> = { proj: '프로젝트', know: '지식', src: '자료', sess: '세션', conv: '대화', app: '화면' };
const CHIP_LABEL = (k: Kind): string => (k === 'app' ? '바로 가기' : KIND_LABEL[k]);
// 아이콘은 사이드바 · 레일과 같은 그림이다(#4233, lib/icon-paths.ts 한 벌). 「화면」만 여기서 그린다(그 표에 없는 뜻).
const KIND_PATH: Record<Kind, string[]> = {
  proj: [ICONS.folder],
  know: [ICONS.wiki],
  src: [ICONS.src],
  sess: [ICONS.chat],
  conv: [ICONS.sess],   // 말풍선 둘 — 오간 말(대화)
  app: ['M4 5h16v12H4z', 'M4 9h16'],
};
const icon = (k: Kind, cls: string): SVGElement =>
  sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, ...KIND_PATH[k].map((d) => sv('path', { d })));

//  뜻만 비슷한 지식을 맨 아래 묶음에 세우는 문턱 — 관련도순 맨 위에 쓰던 0.48 은 무관한 것을 0.49~0.66 으로 통과시켰다
//   (점검 실측). 이제 이 묶음은 순위에 끼지 않으므로 문턱은 «보여 줄 만한가» 만 가른다.
const SIM_MIN = 0.55;
const SIM_MAX_ROWS = 3;
//  결과가 자리 잡을 때까지 기다리는 상한 — 글자 채널이 다 오면 그 전에 그린다. 실측 채널 시간(매니지드): 대화 0.3초(색인을
//   다시 쓰는 동안 1.4초) · 프로젝트 0.4초 · 지식 글자 검색 0.8~1.4초. 이 안에 못 온 채널은 온 뒤에 제 자리에 끼되 맨 위 셋은
//   바꾸지 않는다 — 1.2초일 때 배포 직후 실화면에서 대화(1.4초)가 늦게 와 «가장 맞는 결과» 가 빈 채 굳고, 첫 줄로 고른 줄이
//   한 칸 밀렸다(#4530). 뜻 비슷(sim)은 맨 아래 묶음 전용이라 기다리지 않는다(늦게 와도 위의 줄을 밀지 않는다).
const SETTLE_MS = 2500;
/** 자리 잡기를 막는 채널 — 뜻 비슷은 빼고. */
const holdsSettle = (pending: Set<string>): boolean => [...pending].some((s) => s !== 'sim');
const DEBOUNCE_MS = 160;

// ── 종류 필터 — 칩 하나 = 종류 하나, 누른 것만 켜진다 (#4156) ─────────────
//  아무것도 안 누름 = 기본 검색(세션·대화·프로젝트·지식·바로 가기). 칩을 누르면 그 종류만, 이어서 누르면 더해진다.
//  자료는 기본 검색에 들어가지 않는다(결과가 많고 덜 정제돼 잡음이 된다) — 칩으로만.
//  선택은 페이지 수명이다(창을 닫았다 열어도 유지). 켜져 있으면 안내 문구(placeholder)가 그 사실을 말한다(#4530).
const MAIN_KINDS: Kind[] = ['sess', 'conv', 'proj', 'know', 'app'];
const AUX_KINDS: Kind[] = ['src'];
const isAux = (k: Kind): boolean => AUX_KINDS.includes(k);
let kindSel = new Set<Kind>();
/** 이 종류를 지금 찾는가 — 빈 선택이면 주 축만, 고른 게 있으면 고른 것만. */
export function kindActive(sel: Set<Kind>, k: Kind): boolean {
  return sel.size === 0 ? !isAux(k) : sel.has(k);
}
const kindOn = (k: Kind): boolean => kindActive(kindSel, k);
/** 칩 하나를 눌렀을 때의 다음 상태 — 규칙을 한 곳에서만 구현한다(화면·테스트가 같은 것을 본다). */
export function nextKindSel(cur: Set<Kind>, k: Kind): Set<Kind> {
  const next = new Set(cur);
  if (next.has(k)) next.delete(k); else next.add(k);
  if (next.size === MAIN_KINDS.length && MAIN_KINDS.every((m) => next.has(m))) return new Set();
  return next;
}

// ── 일치 부분 색칠 ─────────────────────────────────────────────────────────────
//  정규식을 쓰지 않는다 — 질의에 `c++`·`(`·`.` 같은 글자가 들어오면 정규식은 깨지거나 엉뚱한 데를 칠한다.
//  겹치는 구간은 합쳐서 한 번만 칠한다. 색칠할 낱말은 omni-rank highlightWords 가 고른다(한 글자 낱말은 빼고, 조사 뗀 꼴 포함).
export function hlParts(text: string, words: string[]): Array<{ t: string; hit: boolean }> {
  const s = String(text ?? '');
  if (!s) return [];
  const toks = words.map((t) => t.replace(/^#/, '')).filter((t) => t.length > 0);
  if (!toks.length) return [{ t: s, hit: false }];
  const low = s.toLowerCase();
  const spans: Array<[number, number]> = [];
  for (const tok of toks) {
    for (let i = low.indexOf(tok); i >= 0; i = low.indexOf(tok, i + tok.length)) spans.push([i, i + tok.length]);
  }
  if (!spans.length) return [{ t: s, hit: false }];
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else merged.push([sp[0], sp[1]]);
  }
  const out: Array<{ t: string; hit: boolean }> = [];
  let at = 0;
  for (const [a, b] of merged) {
    if (a > at) out.push({ t: s.slice(at, a), hit: false });
    out.push({ t: s.slice(a, b), hit: true });
    at = b;
  }
  if (at < s.length) out.push({ t: s.slice(at), hit: false });
  return out;
}

let hooks: OmniHooks | null = null;
export function setOmniHooks(h: OmniHooks): void { hooks = h; }

// ── 기억(#4530) ─────────────────────────────────────────────────────────────────
//  · 정렬은 저장한다(취향). 기간은 페이지 수명(좁히기 — 저장하면 다음 검색이 말없이 좁아진다).
//  · 직전 검색어는 10분 동안 — 결과 하나를 열어 보고 다시 ⌘K 를 누르면 그 검색이 그대로 있다(전부 선택돼 있어 새로 치면 바로 바뀐다).
//  · 최근 검색어 6개 · 최근 연 결과 8개는 저장한다(빈 칸 화면이 보여 준다). 저장소가 막힌 환경이면 이번 페이지에서만.
let sortMode: OmniSort | null = null;
let period: OmniPeriod = 'all';
let lastQuery: { q: string; at: number } | null = null;
const LAST_QUERY_MS = 10 * 60_000;
//  최근 연 것 · 최근 검색어는 **워크스페이스의 내용**을 가리킨다 — wsKey 로 나눈다(#1875 규칙, web/lib/net.ts). 안 나누면 워크스페이스를
//   바꾼 뒤 빈 칸 화면에 다른 워크스페이스의 제목이 섰다(격리 리뷰). 정렬은 취향이라 나누지 않는다.
const OPENED_STORE = (): string => wsKey('lively.omni.opened');
const QUERIES_STORE = (): string => wsKey('lively.omni.queries');
interface OpenedRow { kind: Kind; key: string; title: string; href: string; at: number }
function readJson(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function writeJson(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 막힌 저장소 — 이번 페이지에서만 */ }
}
const ALL_KINDS: Kind[] = [...MAIN_KINDS, ...AUX_KINDS];
function loadOpened(): OpenedRow[] {
  const v = readJson(OPENED_STORE());
  if (!Array.isArray(v)) return [];
  return v.filter((x: any) => x && typeof x.key === 'string' && typeof x.href === 'string' && x.href.startsWith('#/')
    && typeof x.title === 'string' && ALL_KINDS.includes(x.kind)).slice(0, 8) as OpenedRow[];
}
function rememberOpened(h: Hit): void {
  if (!h.href) return;
  const row: OpenedRow = { kind: h.kind, key: h.key, title: h.title, href: h.href, at: Date.now() };
  writeJson(OPENED_STORE(), [row, ...loadOpened().filter((x) => x.key !== row.key)].slice(0, 8));
}
function loadQueries(): string[] {
  const v = readJson(QUERIES_STORE());
  return Array.isArray(v) ? (v.filter((x) => typeof x === 'string' && x.trim()) as string[]).slice(0, 6) : [];
}
function rememberQuery(q: string): void {
  const t = q.trim();
  if (!t || t.length > 120) return;
  writeJson(QUERIES_STORE(), [t, ...loadQueries().filter((x) => x !== t)].slice(0, 6));
}
function loadSort(): OmniSort {
  try { return readSort(localStorage.getItem(SORT_STORE)); } catch { return 'recent'; }
}
function saveSort(m: OmniSort): void {
  try { localStorage.setItem(SORT_STORE, m); } catch { /* 막힌 저장소 — 이번 페이지에서만 */ }
}

// ── [나] 창의 칸 — «설정» 을 찾는 사람을 그 칸으로(#4530: 설정 앱이 숨어 있어 «설정» 을 쳐도 아무것도 안 나왔다) ──
const ME_TABS: Array<{ tab: string; title: string; aka: string }> = [
  { tab: 'advanced', title: '고급 설정', aka: '설정 고급 조직 구성원 운영 연결 데이터 권한 관리 시스템' },
  { tab: 'profile', title: '내 프로필', aka: '프로필 이름 사진 설정' },
  { tab: 'account', title: '계정', aka: '계정 비밀번호 로그인 설정' },
  { tab: 'look', title: '화면 설정', aka: '화면 테마 다크 밝기 글꼴 설정' },
  { tab: 'notify', title: '알림 설정', aka: '알림 소리 배너 설정' },
  { tab: 'aiacct', title: 'AI 계정 연결', aka: 'ai 계정 연결 클로드 코덱스 로그인 설정' },
  { tab: 'ai', title: 'AI 개인화', aka: 'ai 개인화 주입 문구 말투 설정' },
];

// ════════════════════════════════════════════
// 오버레이 — 한 번에 하나. Esc·바깥클릭·닫기 단추·주소 바뀜으로 닫힌다.
// ════════════════════════════════════════════
let box: HTMLElement | null = null;
//  진행 중 요청 — 글자를 더 치거나 창을 닫으면 끊는다. 늦게 온 응답이 화면을 덮지 않고 브라우저 연결을 놓는다.
let inflight: AbortController | null = null;
//  닫을 때 초점을 돌려줄 자리(#4530) — 연 순간 초점이 있던 요소, 그리고 프레임이 열어 달라고 했으면 그 프레임.
let returnFocus: Element | null = null;
let openerFrame: Window | null = null;
let onHash: (() => void) | null = null;
let onCloseTimers: (() => void) | null = null;   // 창의 타이머(입력 기다림 · 자리 잡기)를 닫을 때 끊는다
let onViewport: (() => void) | null = null;

export function omniOpen(seed?: string, opener?: Window | null): void {
  if (box) {
    const i = box.querySelector('.v2-omni-in') as HTMLInputElement | null;
    if (i) { if (seed) { i.value = seed; i.dispatchEvent(new Event('input')); } i.focus(); i.select(); }
    return;
  }
  if (!hooks) return;
  if (sortMode === null) sortMode = loadSort();
  const active = document.activeElement;
  returnFocus = active && active !== document.body ? active : null;
  openerFrame = opener || null;

  const input = el('input', {
    class: 'v2-omni-in', type: 'text', spellcheck: 'false', autocomplete: 'off', enterkeyhint: 'search',
    role: 'combobox', 'aria-expanded': 'true', 'aria-autocomplete': 'list',
    'aria-label': '통합검색', 'aria-controls': 'v2-omni-list',
  }) as HTMLInputElement;
  const list = el('div', { class: 'v2-omni-list', id: 'v2-omni-list', role: 'listbox', 'aria-label': '검색 결과' });
  const bar = el('div', { class: 'v2-omni-bar', 'aria-hidden': 'true' });   // 찾는 중 — 맨 위의 가는 줄(글보다 덜 흔들린다)
  const note = el('div', { class: 'v2-omni-note', role: 'status', 'aria-live': 'polite' });
  const moreBtn = el('button', { class: 'v2-omni-more', type: 'button', hidden: true, onclick: () => { moreFactor++; input.focus(); run(true); } },
    el('span', { text: '결과 더 보기' })) as HTMLButtonElement;

  // ── 칩 — 한 번만 만들고 켜짐 표시만 바꾼다(다시 만들면 누른 단추가 사라져 초점이 날아갔다 — 점검 실측) ──
  const chipBtns = new Map<Kind, HTMLButtonElement>();
  for (const k of ALL_KINDS) {
    chipBtns.set(k, el('button', {
      class: 'v2-omni-chip' + (isAux(k) ? ' aux' : ''), type: 'button', 'data-kind': k,
      onclick: () => { kindSel = nextKindSel(kindSel, k); paintChips(); input.focus(); run(true); },
    }, icon(k, 'v2-omni-chip-ic'), el('span', { text: CHIP_LABEL(k) })) as HTMLButtonElement);
  }
  const chips = el('span', { class: 'v2-omni-kinds', role: 'group', 'aria-label': '종류 필터' },
    ...MAIN_KINDS.map((k) => chipBtns.get(k)!), el('span', { class: 'v2-omni-chipsep', 'aria-hidden': 'true' }), ...AUX_KINDS.map((k) => chipBtns.get(k)!));
  function paintChips(): void {
    for (const [k, b] of chipBtns) {
      const picked = kindSel.has(k);
      b.classList.toggle('on', picked);
      b.setAttribute('aria-pressed', String(picked));
      b.title = picked ? `${CHIP_LABEL(k)} 빼기` : kindSel.size === 0 ? `${CHIP_LABEL(k)}만 보기` + (isAux(k) ? ' (기본 검색에는 들어가지 않습니다)' : '') : `${CHIP_LABEL(k)} 더하기`;
    }
    input.placeholder = kindSel.size
      ? [...kindSel].map(CHIP_LABEL).join(' · ') + '에서 찾습니다 (칩을 다시 누르면 풀립니다)'
      : '세션 · 대화 · 프로젝트 · 지식 · 화면에서 찾기';
  }
  // ── 정렬 · 기간 (#4517) ──
  const sortBtns = (['recent', 'rel'] as OmniSort[]).map((m) => el('button', {
    type: 'button', class: 'v2-omni-segb', 'data-sort': m,
    title: m === 'rel' ? '가장 잘 맞는 것부터 종류별로 보여 줍니다' : '맨 위에 가장 맞는 결과를 두고, 그 아래는 최근 것부터 보여 줍니다',
    onclick: () => { if (sortMode === m) return; sortMode = m; saveSort(m); paintSort(); input.focus(); run(true); },
  }, el('span', { text: SORT_LABEL[m] })) as HTMLButtonElement);
  const sortSeg = el('div', { class: 'v2-omni-seg' }, ...sortBtns);
  function paintSort(): void {
    for (const b of sortBtns) { const on = b.dataset.sort === sortMode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
  }
  const periodBtn = el('button', {
    type: 'button', class: 'v2-omni-chip v2-omni-period', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    onclick: () => openPeriodMenu(),
  }) as HTMLButtonElement;
  function paintPeriod(): void {
    const on = period !== 'all';
    periodBtn.classList.toggle('on', on);
    periodBtn.title = on ? `${periodLabel(period)} 안에서만 찾습니다 — 눌러서 바꿉니다` : '기간으로 좁힙니다';
    periodBtn.replaceChildren(
      sv('svg', { viewBox: '0 0 24 24', class: 'v2-omni-chip-ic', 'aria-hidden': 'true' }, sv('path', { d: ICONS.clock })),
      el('span', { text: on ? periodLabel(period) : '기간' }),
      sv('svg', { viewBox: '0 0 24 24', class: 'v2-omni-chip-ic', 'aria-hidden': 'true' }, sv('path', { d: ICONS.chevD })));
  }
  function openPeriodMenu(): void {
    const r = periodBtn.getBoundingClientRect();
    periodBtn.setAttribute('aria-expanded', 'true');
    showCtxMenu(r.left, r.bottom + 4, PERIODS.map((p) => ({
      label: p.label, checked: period === p.key,
      run: () => { if (period === p.key) return; period = p.key; paintPeriod(); run(true); },
    })), { minWidth: 150, onClose: () => { periodBtn.setAttribute('aria-expanded', 'false'); if (box) input.focus(); } });
  }
  const tools = el('span', { class: 'v2-omni-tools', role: 'group', 'aria-label': '정렬과 기간' }, sortSeg, periodBtn);
  const filters = el('div', { class: 'v2-omni-filters' }, chips, tools);
  //  닫기 — 눌리는 단추다(종전 «Esc» 는 글자 표시라 폰에서 닫을 길이 바깥 여백뿐이었다 — 점검 실측).
  const closeBtn = el('button', { class: 'v2-omni-close', type: 'button', title: '닫기 (Esc)', 'aria-label': '통합검색 닫기', onclick: () => omniClose() },
    el('span', { class: 'v2-omni-close-t', text: '닫기' }), el('kbd', { class: 'v2-omni-esc', text: 'Esc' }));

  box = el('div', {
    class: 'v2-omni', role: 'dialog', 'aria-modal': 'true', 'aria-label': '통합검색',
    onmousedown: (e: MouseEvent) => { if (e.target === box) omniClose(); },
  },
    el('div', { class: 'v2-omni-card' },
      el('div', { class: 'v2-omni-top' },
        sv('svg', { viewBox: '0 0 24 24', class: 'v2-omni-lens', 'aria-hidden': 'true' },
          sv('circle', { cx: '11', cy: '11', r: '6.5' }), sv('path', { d: 'M16 16l4.5 4.5' })),
        input, closeBtn),
      bar, filters, list, note, moreBtn)) as HTMLElement;

  //  이 창 — 닫았다 다시 열면 새 창이다. 옛 창의 타이머·응답이 새 창을 건드리지 않게 모든 진입점이 이걸 본다(격리 리뷰:
  //   결과 전 Enter 후 닫고 1.2초 안에 다시 열면 옛 settle 이 새 창을 닫았다).
  const mine = box;
  // ── 상태 ──
  const buckets = new Map<string, Hit[]>();
  let hits: Hit[] = [];
  let seq = 0;                      // 늦게 온 응답 무시
  let pending = new Set<string>();  // 아직 안 온 채널
  let timer = 0;                    // 글자 → 검색 사이의 짧은 기다림
  let settleTimer = 0;
  let settled = true;               // 지금 질의의 결과가 자리 잡았나(Enter 는 이걸 기다린다)
  let ranQuery = '';                // 마지막으로 돌린 질의(입력칸과 다르면 아직 안 돌렸다)
  let terms: Term[] = [];
  let words: string[] = [];         // 색칠할 낱말
  let sinceMs = 0;
  let frozenTop: string[] | null = null;   // 자리 잡은 뒤의 맨 위 셋(늦게 온 줄이 바꾸지 않는다)
  let selKey = '';                  // 고른 줄의 열쇠
  let userMoved = false;            // 이 질의에서 사람이 화살표·마우스로 골랐나
  let enterWant: { newTab: boolean } | null = null;   // 자리 잡으면 열 Enter
  let convNoteText = '';            // 대화 채널이 남긴 말(색인 중 · 실패 · 상한)
  let simDegraded = false;
  let moreFactor = 1;               // «결과 더 보기» 를 누른 횟수 + 1

  const rowNodes: HTMLElement[] = [];
  const rowHits: Hit[] = [];        // ⚠ 그려진 줄과 짝 — i 번째 줄이 무엇인지는 이것만 안다(#1960)

  const hl = (text: string): Node[] => hlParts(text, words).map((p) =>
    (p.hit ? el('mark', { class: 'v2-omni-hl', text: p.t }) : document.createTextNode(p.t)) as Node);

  function subLine(h: Hit): HTMLElement | null {
    const bits: Node[] = [];
    const dot = (): void => { if (bits.length) bits.push(document.createTextNode(' · ')); };
    if (h.role) bits.push(el('span', { class: 'v2-omni-role', text: h.role === 'user' ? '지시' : 'AI' }));
    if (h.context) { if (bits.length) bits.push(document.createTextNode(' ')); bits.push(el('span', { class: 'v2-omni-ctx', text: h.context })); }
    const id = identKind(h.ident, terms);
    if (id && h.ident) { dot(); bits.push(el('code', { class: 'v2-omni-key' + (id === 'exact' ? ' exact' : '') }, ...hl(/^[0-9]+$/.test(h.ident) ? '#' + h.ident : h.ident))); }
    if (h.sub) { if (bits.length && !(h.role && bits.length === 1)) dot(); else if (bits.length) bits.push(document.createTextNode(' ')); bits.push(...hl(h.sub)); }
    if (h.edit) { dot(); bits.push(el('span', { class: 'v2-omni-edit', text: '고친 파일 ' }), el('code', { class: 'v2-omni-key' }, ...hl(h.edit))); }
    if ((h.hits || 0) > 1) bits.push(document.createTextNode(` · 맞은 곳 ${h.hits}`));
    return bits.length ? el('span', { class: 'v2-omni-s' }, ...bits) : null;
  }

  // ── 그리기 ──
  function paint(): void {
    rowNodes.length = 0;
    rowHits.length = 0;
    const kids: HTMLElement[] = [];
    const now = Date.now();
    const shown = new Set<string>();
    const draw = (label: string, rows: Hit[]): void => {
      const fresh = rows.filter((h) => !shown.has(h.key));
      if (!fresh.length) return;
      kids.push(el('div', { class: 'v2-omni-gh', role: 'presentation', text: label }));
      for (const h of fresh) {
        shown.add(h.key);
        const i = rowNodes.length;
        const when = typeof h.at === 'number' ? whenLabel(h.at, now) : '';
        const node = el('div', {
          class: 'v2-omni-row' + (h.sim ? ' sim' : ''), role: 'option', id: 'v2-omni-opt-' + i, 'aria-selected': 'false',
          title: (h.head ? h.head + ': ' : '') + h.title + (h.sub ? ' — ' + h.sub : ''),
          //  마우스가 **실제로 움직였을 때만** 고른다 — 목록이 그 아래로 지나가는 것은 고른 것이 아니다.
          onmousemove: (e: MouseEvent) => { if ((e.movementX || e.movementY) && selKey !== h.key) { selKey = h.key; userMoved = true; mark(false); } },
          onclick: (e: MouseEvent) => go(i, e.metaKey || e.ctrlKey),
        },
          el('span', { class: 'v2-omni-ic' }, icon(h.kind, 'v2-omni-kic')),
          el('span', { class: 'v2-omni-tt' },
            el('span', { class: 'v2-omni-tl' },
              h.head ? el('span', { class: 'v2-omni-head', text: h.head }) : null,
              el('b', { class: 'v2-omni-t' }, ...hl(h.title)),
              h.status ? el('span', { class: 'v2-omni-st', text: h.status }) : null),
            subLine(h)),
          el('span', { class: 'v2-omni-meta' },
            when ? el('span', { class: 'v2-omni-when', text: when, title: new Date(h.at as number).toLocaleString('ko-KR') }) : null,
            el('span', { class: 'v2-omni-badge', text: h.label || KIND_LABEL[h.kind] }))) as HTMLElement;
        rowNodes.push(node);
        rowHits.push(h);
        kids.push(node);
      }
    };
    if (!input.value.trim()) {
      paintEmpty(draw);
    } else {
      const lexical = hits.filter((h) => !h.sim);
      draw('가장 맞는 결과', topHits(lexical));
      if (sortMode === 'recent') {
        //  그 아래는 낱말이 모두 맞은 것을 최근 것부터 — 시각이 없는 바로 가기(화면·명령)는 맨 아래 따로.
        const timed = lexical.filter((h) => h.kind !== 'app').sort(byRecent).slice(0, 60 * moreFactor);
        let bucket = '';
        let group: Hit[] = [];
        for (const h of timed) {
          const b = dayBucket(h.at, now);
          if (b !== bucket) { draw(bucket, group); group = []; bucket = b; }
          group.push(h);
        }
        draw(bucket, group);
        draw('바로 가기', lexical.filter((h) => h.kind === 'app'));
      } else {
        for (const g of GROUPS) draw(g.label, lexical.filter((h) => h.kind === g.kind).slice(0, 12 * moreFactor));
      }
      draw('뜻이 비슷한 지식', hits.filter((h) => h.sim).slice(0, SIM_MAX_ROWS));
    }
    list.replaceChildren(...kids);
    //  선택은 열쇠로 이어 간다. 고른 줄이 사라졌으면 첫 줄.
    if (!rowHits.some((h) => h.key === selKey)) selKey = rowHits[0]?.key || '';
    mark(false);
  }
  /** 맨 위 셋 — 자리 잡은 뒤에는 굳힌다(늦게 온 채널이 첫 줄을 바꾸면 Enter 가 엉뚱한 것을 연다). */
  function topHits(lexical: Hit[]): Hit[] {
    if (frozenTop) return frozenTop.map((k) => lexical.find((h) => h.key === k)).filter((h): h is Hit => !!h);
    //  명령 줄(«…로 새 세션 시작»)은 이름에 검색어가 그대로 들어 있어 «이름에 모두» 층에 붙는다 — 결과가 아니므로 후보에서 뺀다
    //   (캡처로 확인: 맨 위 셋을 명령 둘이 차지했다).
    const ranked = pickTop(lexical.filter((h) => !h.key.startsWith('cmd:')).map((h) => ({ ...h, name: h.title })), terms, input.value);
    return ranked.map((r) => lexical.find((h) => h.key === r.key)).filter((h): h is Hit => !!h);
  }
  /** 빈 칸 — 최근 검색어 · 최근 연 것 · 내 최근 세션(칩을 따른다). 스포트라이트를 열자마자 빈 판이면 무엇을 칠지가 안 보인다. */
  function paintEmpty(draw: (label: string, rows: Hit[]) => void): void {
    const qs = loadQueries();
    if (qs.length && !kindSel.size) {
      draw('최근 검색', qs.map((q): Hit => ({ kind: 'app', key: 'q:' + q, title: q, sub: '', label: '검색', run: () => { input.value = q; run(true); } })));
    }
    draw('최근 연 것', loadOpened().filter((o) => kindOn(o.kind)).slice(0, 5).map((o): Hit => ({ kind: o.kind, key: o.key, title: o.title, sub: '', href: o.href, at: o.at })));
    if (kindOn('sess')) draw('내 최근 세션', recentSessions().slice(0, 6));
  }

  function mark(scroll = true): void {
    let selIdx = -1;
    rowNodes.forEach((n, i) => {
      const on = rowHits[i]?.key === selKey;
      if (on) selIdx = i;
      n.classList.toggle('on', on);
      n.setAttribute('aria-selected', String(on));
    });
    if (selIdx >= 0) { input.setAttribute('aria-activedescendant', rowNodes[selIdx].id); if (scroll) rowNodes[selIdx].scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function moveSel(d: number): void {
    if (!rowNodes.length) return;
    const cur = rowHits.findIndex((h) => h.key === selKey);
    const next = cur < 0 ? 0 : (cur + d + rowNodes.length) % rowNodes.length;
    selKey = rowHits[next].key;
    userMoved = true;
    mark();
  }

  // ── 안내 줄 ──
  const emptyNote = (): string => {
    const why: string[] = [];
    if (kindSel.size > 0) why.push('고른 종류에서만 찾았습니다 — 칩을 다시 누르면 풀립니다');
    else why.push('자료는 기본 검색에 들어가지 않습니다 — 자료 칩을 누르면 찾습니다');
    if (period !== 'all') why.push(`${periodLabel(period)} 안의 결과만 봤습니다 — 기간을 넓히면 더 나올 수 있습니다`);
    return `결과가 없습니다. (${why.join(' · ')})`;
  };
  function refreshNote(): void {
    const q = input.value.trim();
    const parts: string[] = [];
    if (enterWant && !settled) parts.push('결과가 다 오면 첫 줄을 엽니다…');
    //  명령 줄(«…로 새 세션» 등)은 결과가 아니다 — 그것만 있으면 «결과가 없습니다» 를 말한다.
    const real = rowHits.filter((h) => !h.key.startsWith('cmd:') && !h.key.startsWith('q:')).length;
    if (settled && q && !real) parts.push(emptyNote());
    if (q && convNoteText) parts.push(convNoteText);
    if (q && simDegraded && kindOn('know')) parts.push('뜻이 비슷한 지식은 지금 가져오지 못했습니다.');
    note.hidden = !parts.length;
    note.replaceChildren(...(parts.length ? [el('span', { text: parts.join(' ') })] : []));
    moreBtn.hidden = !(settled && q && rowNodes.length >= 40 * moreFactor);
  }

  function go(i: number, newTab: boolean): void {
    const h = rowHits[i];
    if (!h) return;
    if (h.run) { h.run(); return; }
    if (!h.href) return;
    const q = input.value.trim();
    if (q) { rememberQuery(q); lastQuery = { q, at: Date.now() }; }
    rememberOpened(h);
    omniClose({ restoreFocus: false });
    hooks!.open(h.href, newTab, h.title);
  }

  // ── 결과 담기 ──
  function rebuild(): void {
    const byKey = new Map<string, Hit>();
    hits = [];
    for (const src of ['local', 'conv', 'proj', 'know', 'src', 'sim']) {
      for (const h of buckets.get(src) || []) {
        const prev = byKey.get(h.key);
        if (prev) {
          //  같은 항목이 다른 채널에서 또 오면 빈 칸만 채운다(셸 목록 사본엔 시각·상태가 없을 수 있다).
          //  세션이 이름으로도 대화로도 맞았으면 **왜 맞았는지**(대표 말·고친 파일)를 대화 쪽에서 가져온다.
          if (h.kind === 'conv' && prev.kind === 'sess') {
            prev.role = h.role; prev.hits = h.hits; prev.edit = h.edit; prev.serverTop = h.serverTop;
            if (h.sub) prev.sub = h.sub;
            if ((h.at || 0) > (prev.at || 0)) prev.at = h.at;
          }
          if (prev.at === undefined && h.at !== undefined) prev.at = h.at;
          if (!prev.status && h.status) prev.status = h.status;
          if (!prev.context && h.context) prev.context = h.context;
          if (!prev.label && h.label) prev.label = h.label;
          if (!prev.sub && h.sub) prev.sub = h.sub;
          continue;
        }
        //  뜻만 비슷한 줄은 글자로 이미 뜬 문서면 뺀다(같은 문서를 두 번 보이지 않는다).
        //  이름이 같은 **다른** 항목은 합치지 않는다(#4530 — 이름 «새 작업» 인 프로젝트 39개가 한 줄로 합쳐져 나머지를 찾을 길이 없었다).
        const copy = { ...h };
        byKey.set(h.key, copy);
        hits.push(copy);
      }
    }
  }
  function put(src: string, rows: Hit[], mySeq: number): void {
    if (mySeq !== seq || box !== mine) return;
    buckets.set(src, sinceMs ? rows.filter((h) => h.sim || inPeriod(h.at, sinceMs)) : rows);
    pending.delete(src);
    if (settled) { rebuild(); paint(); refreshNote(); }   // 자리 잡은 뒤 늦게 온 채널 — 제 자리에 끼운다(맨 위는 굳어 있다)
    else if (!holdsSettle(pending)) settle(mySeq);
  }
  function settle(mySeq: number): void {
    if (mySeq !== seq || box !== mine) return;
    window.clearTimeout(settleTimer);
    const first = !settled;
    settled = true;
    rebuild();
    if (first) { frozenTop = null; if (!userMoved) selKey = ''; }
    paint();
    if (first && input.value.trim()) frozenTop = topHits(hits.filter((h) => !h.sim)).map((h) => h.key);
    list.classList.remove('stale');
    bar.classList.remove('on');
    refreshNote();
    if (enterWant) {
      const w = enterWant; enterWant = null;
      const i = rowHits.findIndex((h) => h.key === selKey);
      go(i < 0 ? 0 : i, w.newTab);
    }
  }

  // ── 셸 목록에서(네트워크 0) ──
  function recentSessions(): Hit[] {
    const d = hooks!.data();
    return [...d.sessions].filter((s) => !isTrashedSess(s) && isMineSess(s)).sort((a, b) => b.lastSeen - a.lastSeen).map((s) => sessHit(d, s));
  }
  function sessHit(d: V2Data, s: Sess): Hit {
    const t = sessText(s, projName(d, s.projectId));
    return {
      kind: 'sess', key: 's:' + s.id, title: t.main || t.sub || s.id,
      sub: [projName(d, s.projectId), t.main && t.sub ? t.sub : ''].filter(Boolean).join(' · '),
      href: '#/s/' + encodeURIComponent(s.id), at: s.lastSeen || undefined,
      context: isMineSess(s) ? undefined : ownerOf(s),
    };
  }
  function localHits(): Hit[] {
    const d = hooks!.data();
    const out: Hit[] = [];
    const q = input.value.trim();
    if (kindOn('sess')) {
      //  세션 — 낱말마다 이름·하는 일·프로젝트 이름 어디에든(순서 무관 · 조사 뗀 꼴로도). 휴지통 세션은 뺀다. 최근 것부터.
      out.push(...d.sessions
        .filter((s) => !isTrashedSess(s))
        .filter((s) => { const t = sessText(s, projName(d, s.projectId)); return matchAllAcross([t.main, t.sub, s.label, projName(d, s.projectId)], terms); })
        .sort((a, b) => b.lastSeen - a.lastSeen)
        .slice(0, 8 * moreFactor)
        .map((s) => sessHit(d, s)));
    }
    if (kindOn('proj')) {
      //  프로젝트 이름 — 서버 결과가 오기 전에도 이름으로 부른 것은 바로(휴지통 제외). 서버 줄이 오면 빈 칸을 채운다.
      out.push(...d.projects.filter((p) => !p.trashed_at && matchAll(String(p.name || ''), terms)).slice(0, 8)
        .map((p) => ({
          kind: 'proj' as const, key: 'p:' + p.id, title: String(p.name || ''), sub: cleanSnippet(String(p.description || ''), 120), href: projHitHref(p),
          at: atOf(p.updated_at), ident: String(p.id), status: p.archived_at ? '보관' : undefined,
        })));
    }
    if (kindOn('app')) {
      const nq = q.toLowerCase();
      out.push(...visibleApps().filter((a) => appMatches(a, nq)).slice(0, 4)
        .map((a) => ({ kind: 'app' as const, key: 'a:' + a.key, title: a.title, sub: a.desc, href: appHref(a), label: '화면' })));
      //  프로젝트 리스트 · 폴더(보드의 묶음) · 분류 — 이름으로(#4530: 종전엔 찾을 수 없었다).
      for (const l of (d.lists || []).filter((x) => matchAll(String(x.name || ''), terms)).slice(0, 4)) {
        out.push({ kind: 'app', key: 'l:' + l.id, title: String(l.name), sub: '프로젝트 리스트', href: '#/projects2/l/' + l.id, label: '리스트' });
      }
      for (const f of (d.folders || []).filter((x) => matchAll(String(x.name || ''), terms)).slice(0, 3)) {
        out.push({ kind: 'app', key: 'f:' + f.id, title: String(f.name), sub: '프로젝트 폴더', href: '#/projects2/f/' + f.id, label: '폴더' });
      }
      //  분류 화면 주소는 **숫자 id** 를 받는다(taxonomy.ts catHref · side.ts 와 같은 문) — key 를 넣으면 «이 분류를 찾지 못했어요»(격리 리뷰).
      for (const c of categories.filter((x) => matchAllAcross([x.name, x.key], terms)).slice(0, 4)) {
        out.push({ kind: 'app', key: 'c:' + c.id, title: c.name, sub: c.desc ? cleanSnippet(c.desc, 80) : '분류', href: '#/taxonomy/' + encodeURIComponent(c.id), label: '분류' });
      }
      if (hooks!.openMe) {
        for (const m of ME_TABS.filter((x) => matchAllAcross([x.title, x.aka], terms)).slice(0, 3)) {
          out.push({ kind: 'app', key: 'me:' + m.tab, title: m.title, sub: '[나] 창에서 엽니다', label: '설정', run: () => { omniClose({ restoreFocus: false }); hooks!.openMe!(m.tab); } });
        }
      }
      //  명령 — 찾는 것이 없을 때 바로 할 수 있는 일. 늘 맨 아래(시각이 없어 «바로 가기» 묶음).
      const short = q.length > 40 ? q.slice(0, 40) + '…' : q;
      if (q && hooks!.newSession) out.push({ kind: 'app', key: 'cmd:new-session', title: `«${short}» 로 새 세션 시작`, sub: '이 글을 첫 지시로 새 AI 세션을 엽니다', label: '명령', run: () => { omniClose({ restoreFocus: false }); hooks!.newSession!(q); } });
      if (q) out.push({ kind: 'app', key: 'cmd:new-know', title: `«${short}» 제목으로 새 지식 쓰기`, sub: '새 지식 문서를 엽니다', label: '명령', href: '#/knowledge/new?title=' + encodeURIComponent(q) });
    }
    return out.filter((h) => !sinceMs || h.kind === 'app' || inPeriod(h.at, sinceMs));
  }
  function ownerOf(s: Sess): string {
    const n = String((s.raw && (s.raw.owner_name || s.raw.ownerName)) || '');
    return n ? n + '의 세션' : '팀원 세션';
  }

  // ── 서버 줄 만들기 ──
  const projRow = (p: any, order: number): Hit => {
    const level = String(p.level || 'project');
    const st = p.status_category === 'done' ? '완료' : p.status_category === 'canceled' ? '취소' : p.archived ? '보관' : p.draft ? '초안' : undefined;
    return {
      kind: 'proj', key: 'p:' + p.id,
      title: String(p.name || p.title || ('프로젝트 #' + p.id)),
      sub: cleanSnippet(Array.isArray(p.snippets) ? p.snippets.join(' ') : (p.snippet || p.description || ''), 140),
      href: projHitHref(p), ident: String(p.id), at: atOf(p.updated_at), order,
      label: level === 'project' ? undefined : level === 'task' ? '태스크' : '서브태스크',
      //  상위 프로젝트 이름 + « ›» — «↳» 는 글꼴에 없어 네모로 깨졌다(캡처로 확인).
      context: level !== 'project' && p.parent_name ? String(p.parent_name) + ' ›' : undefined,
      status: st,
    };
  };
  const knowRow = (e: any, order: number, extra: Partial<Hit> = {}): Hit => {
    const sp = splitKnowTitle(String(e.title || e.name));
    return {
      kind: 'know', key: 'k:' + e.name, title: sp.main, head: sp.head || undefined,
      sub: cleanSnippet(Array.isArray(e.snippets) ? e.snippets.join(' ') : (e.snippet || e.summary || ''), 140),
      href: '#/k/' + encodeURIComponent(e.name), ident: String(e.name || ''), at: atOf(e.updated_at), order, ...extra,
    };
  };
  function convHit(r: any, order: number): Hit {
    const d = hooks!.data();
    const sid = String(r.session_id || '');
    const node = String(r.node_id || '');
    const s = findSessByConv(d.sessions, sid);
    const face = s ? sessText(s, projName(d, s.projectId)) : null;
    const best = (r && r.best) || null;
    return {
      kind: 'conv', key: s ? 's:' + s.id : 'c:' + node + ':' + sid,
      title: (face && (face.main || face.sub)) || String(r.name || r.title || '이름 없는 세션'),
      sub: best ? cleanSnippet(String(best.text || ''), 160) : '',
      href: s ? '#/s/' + encodeURIComponent(s.id) : '#/sessions/' + encodeURIComponent(sid) + (node ? '?node=' + encodeURIComponent(node) : ''),
      at: atOf(r.at, best && best.ts), role: best ? (best.role === 'assistant' ? 'assistant' : 'user') : undefined,
      hits: Number(r.hits) || 1, edit: r.edit || null, serverTop: !!r.top, order,
    };
  }

  // ── 검색 ──
  function run(force = false): void {
    if (box !== mine) return;
    const q = input.value.trim();
    if (!force && q === ranQuery) return;
    ranQuery = q;
    seq++;
    const my = seq;
    window.clearTimeout(timer);
    window.clearTimeout(settleTimer);
    inflight?.abort();
    inflight = new AbortController();
    const signal = inflight.signal;
    terms = parseTerms(q);
    words = highlightWords(terms);
    sinceMs = periodSince(period, Date.now());
    convNoteText = ''; simDegraded = false;
    frozenTop = null;
    userMoved = false;
    enterWant = enterWant && q ? enterWant : null;
    buckets.clear();
    pending = new Set();
    if (!q) { hits = []; settled = true; list.classList.remove('stale'); bar.classList.remove('on'); paint(); refreshNote(); return; }
    buckets.set('local', localHits());
    const call = (src: string, k: Kind, fn: () => void): void => { if (kindOn(k)) { pending.add(src); fn(); } };
    const fail = (src: string) => (e: any): void => {
      if (my !== seq || signal.aborted) return;
      if (src === 'conv') convNoteText = '대화 결과를 가져오지 못했습니다 — ' + failText(e) + '.';
      if (src === 'sim') simDegraded = true;
      put(src, [], my);
    };
    const lim = (n: number): string => String(Math.min(50, n * moreFactor));
    const qs = encodeURIComponent(q);
    call('conv', 'conv', () => {
      if (q.length > 200) { convNoteText = '검색어가 길어(200자 넘음) 대화에서는 찾지 않았습니다.'; window.setTimeout(() => put('conv', [], my)); return; }
      const p = new URLSearchParams({ q, sort: sortMode === 'rel' ? 'relevance' : 'recent', limit: lim(20) });
      if (sinceMs) p.set('since', new Date(sinceMs).toISOString());
      api('/api/ui/v6/session-search?' + p.toString(), { signal }).then((r: any) => {
        if (my !== seq) return;
        const pend = r ? r.pending : 0;
        //  밀린 수를 서버가 못 셌으면(null) 그 사실을 말한다 — 0 으로 읽으면 «다 색인됐다» 는 거짓말이 된다(#4517 재검토).
        const notes: string[] = [];
        if (pend === null) notes.push('대화 색인이 어디까지 됐는지 확인하지 못했습니다 — 최근 대화는 아직 찾지 못할 수 있습니다.');
        else if (pend) notes.push(`대화 색인을 만드는 중입니다 — 세션 ${pend}개의 대화는 아직 찾지 못할 수 있습니다.`);
        //  후보는 «낱말을 더 많이 맞춘 세션 → 최근» 순으로 400개까지 모은다(conv-index-store). 드문 낱말을 넣으면 그 세션이 앞에 남는다.
        if (r && r.capped) {
          const cap = Number(r.cap) || 400;
          notes.push(terms.length > 1
            ? `맞는 세션이 많아 낱말이 더 많이 맞은 세션 ${cap}개 안에서 골랐습니다 — 드문 낱말을 넣거나 기간을 좁히면 정확해집니다.`
            : `맞는 세션이 많아 최근 세션 ${cap}개 안에서 골랐습니다 — 낱말을 하나 더 넣거나 기간을 좁히면 정확해집니다.`);
        }
        convNoteText = notes.join(' ');
        put('conv', ((r && r.results) || []).map((x: any, i: number) => convHit(x, i)), my);
      }, fail('conv'));
    });
    call('proj', 'proj', () => {
      api(`/api/ui/v6/projects/search?plain=1&limit=${lim(20)}&q=` + qs, { signal })
        .then((r: any) => put('proj', ((r && r.projects) || []).map((p: any, i: number) => projRow(p, i)), my), fail('proj'));
    });
    call('know', 'know', () => {
      api(`/api/ui/knowledge/search?plain=1&limit=${lim(20)}&q=` + qs, { signal })
        .then((r: any) => put('know', ((r && r.entries) || []).map((e: any, i: number) => knowRow(e, i)), my), fail('know'));
    });
    //  뜻만 비슷한 지식 — 맨 아래 묶음 전용. 글자로 이미 뜬 문서는 rebuild 가 겹치지 않게 뺀다(같은 열쇠).
    call('sim', 'know', () => {
      api(`/api/ui/knowledge/similar?limit=8&min_score=${SIM_MIN}&text=` + qs, { signal }).then((r: any) => {
        simDegraded = !!(r && r.degraded);
        put('sim', ((r && r.entries) || []).map((e: any, i: number) => knowRow(e, i, { sim: true, score: Number(e.similarity) || 0 })), my);
      }, fail('sim'));
    });
    call('src', 'src', () => {
      api(`/api/ui/sources?limit=${lim(20)}&q=` + qs, { signal }).then((r: any) => put('src', ((r && r.entries) || []).map((s: any, i: number) => ({
        kind: 'src' as const, key: 'src:' + s.id, title: String(s.title || ('자료 #' + s.id)),
        sub: [s.kind, (s.fields && s.fields.container_name) ? '#' + s.fields.container_name : ''].filter(Boolean).join(' · '),
        href: '#/sources/' + s.id, at: atOf(s.occurred_at, s.updated_at), order: i,
      })), my), fail('src'));
    });
    settled = false;
    if (!holdsSettle(pending)) { settle(my); return; }
    //  앞 결과는 흐리게 둔 채 기다린다 — 다 오거나 상한이 되면 한 번에 바꾼다. 앞 결과가 없으면(첫 글자) 셸 목록부터 보인다.
    bar.classList.add('on');
    if (!rowNodes.length || rowHits.every((h) => h.key.startsWith('q:') || !h.at)) { rebuild(); paint(); }
    else list.classList.add('stale');
    settleTimer = window.setTimeout(() => settle(my), SETTLE_MS);
    refreshNote();
  }

  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    moreFactor = 1;
    if (!input.value.trim()) { run(true); return; }
    timer = window.setTimeout(() => run(), DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.isComposing) return;                       // 한글 조합 중 키는 입력기의 것이다
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { e.preventDefault(); moveSel(1); }
    else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { e.preventDefault(); moveSel(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const newTab = e.metaKey || e.ctrlKey;
      //  결과가 지금 친 글의 것이 아니면(아직 안 돌렸거나 오는 중) 다 온 뒤의 줄을 연다 — 엉뚱한 것을 여는 것보다 잠깐 기다리는 게 낫다.
      if (input.value.trim() !== ranQuery) run();
      if (!settled) { enterWant = { newTab }; refreshNote(); return; }
      const i = rowHits.findIndex((h) => h.key === selKey);
      go(i < 0 ? 0 : i, newTab);
    }
  });
  //  Tab 은 창 안에서만 돈다(aria-modal 인데 뒤 화면으로 빠지던 것, #4530).
  box.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !box) return;
    const f = [...box.querySelectorAll<HTMLElement>('input, button:not([hidden])')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
  });

  document.body.append(box);
  document.addEventListener('keydown', onEsc, true);
  onCloseTimers = () => { window.clearTimeout(timer); window.clearTimeout(settleTimer); enterWant = null; };
  //  주소가 바뀌면(뒤로 가기 · 다른 문으로 이동) 창은 이제 그 화면의 것이 아니다 — 닫는다(#4530).
  onHash = () => omniClose({ restoreFocus: false });
  window.addEventListener('hashchange', onHash);
  //  폰 — 키보드가 올라오면 보이는 높이가 줄어든다. 그 높이를 CSS 에 알려 결과 목록이 키보드 아래로 숨지 않게 한다.
  const vv = window.visualViewport;
  if (vv) {
    onViewport = () => { box?.style.setProperty('--omni-vh', vv.height + 'px'); box?.style.setProperty('--omni-vt', vv.offsetTop + 'px'); };
    onViewport();
    vv.addEventListener('resize', onViewport);
    vv.addEventListener('scroll', onViewport);
  }
  paintSort();
  paintPeriod();
  paintChips();
  //  분류는 셸 목록 줄에만 쓰인다 — 도착하면 그 줄만 다시 만든다(검색 전체를 다시 돌리면 고른 줄·맨 위 셋이 풀렸다, 격리 리뷰).
  void loadCategories().then((fresh) => {
    if (!fresh || box !== mine || !input.value.trim()) return;
    buckets.set('local', localHits());
    if (settled) { rebuild(); paint(); refreshNote(); }   // 오는 중이면 자리 잡을 때 함께 그려진다(중간에 한 번 더 바뀌지 않게)
  });
  const prev = !seed && lastQuery && Date.now() - lastQuery.at < LAST_QUERY_MS ? lastQuery.q : '';
  input.value = seed || prev;
  input.focus();
  input.select();
  run(true);
}

/** 채널 실패를 사람이 읽는 말로. */
function failText(e: any): string {
  const msg = String((e && e.message) || '').trim();
  if (!e || !e.status) return '서버에 닿지 못했습니다';
  if (!msg || msg === 'internal_error' || /^요청 실패 \(\d+\)$/.test(msg)) return e.status >= 500 ? '서버에 오류가 났습니다. 잠시 뒤 다시 찾아 주세요' : '요청이 거절됐습니다';
  return msg.replace(/[.。]\s*$/, '');
}

// ── 분류(카테고리) — 한 페이지에 5분에 한 번 받아 둔다(이름으로 찾는다, #4530) ──
let categories: Array<{ id: string; key: string; name: string; desc: string }> = [];
let categoriesAt = 0;
/** 새로 받았으면 true. */
async function loadCategories(): Promise<boolean> {
  if (Date.now() - categoriesAt < 5 * 60_000) return false;
  categoriesAt = Date.now();
  try {
    const d: any = await api('/api/ui/categories');
    const rows: any[] = (d && (d.categories || d.items)) || (Array.isArray(d) ? d : []);
    categories = rows.filter((c) => c && c.id != null && c.name).map((c) => ({ id: String(c.id), key: String(c.key || ''), name: String(c.name), desc: String(c.should || c.description || '') }));
    return true;
  } catch { categoriesAt = 0; return false; }
}

//  기간 메뉴가 떠 있으면 Esc 는 **메뉴의 것**이다(메뉴만 닫는다) — 캡처 단계에서 여기가 먼저 받으므로 비켜 준다(#4517).
function onEsc(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !box) return;
  if (ctxIsOpen()) return;
  e.stopPropagation(); e.preventDefault(); omniClose();
}
export function omniClose(opts: { restoreFocus?: boolean } = {}): void {
  if (!box) return;
  inflight?.abort(); inflight = null;
  onCloseTimers?.(); onCloseTimers = null;
  closeCtxMenu();
  box.remove(); box = null;
  document.removeEventListener('keydown', onEsc, true);
  if (onHash) { window.removeEventListener('hashchange', onHash); onHash = null; }
  const vv = window.visualViewport;
  if (vv && onViewport) { vv.removeEventListener('resize', onViewport); vv.removeEventListener('scroll', onViewport); onViewport = null; }
  //  초점을 연 자리로 돌려준다(#4530 — 닫고 이어 친 글자가 어디에도 안 들어가던 것). 결과를 열어 화면을 옮긴 때는 돌려주지 않는다.
  const back = returnFocus, frame = openerFrame;
  returnFocus = null; openerFrame = null;
  if (opts.restoreFocus === false) return;
  if (frame) { try { frame.postMessage({ type: OMNI_CLOSED_MSG }, location.origin); } catch { /* 프레임이 닫혔다 */ } }
  if (back && (back as HTMLElement).isConnected && typeof (back as HTMLElement).focus === 'function') {
    (back as HTMLElement).focus();
    if (back instanceof HTMLIFrameElement && back.contentWindow !== frame) {
      try { back.contentWindow?.postMessage({ type: OMNI_CLOSED_MSG }, location.origin); } catch { /* 다른 오리진 */ }
    }
  }
}
export function omniIsOpen(): boolean { return !!box; }

// ── 여는 키 ────────────────────────────────────────────────────────────────
//  맥 ⌘K · 그 밖 Ctrl+K, 그리고 **Alt+K**(둘 다). 터미널 프레임은 Alt+K·⌘K 만 넘긴다(Ctrl+K 는 readline kill-line, web/standalone/terminal.ts).
//  판정은 한 벌(web/lib/omni-chord.ts) — 라틴 글자면 글자로, 아니면 **자판 위치**로 본다(한글 입력기가 켜져 있으면 e.key 가 'ㅏ').
export function isOmniChord(e: ChordLike): boolean { return isOmniChordLike(e); }
/** 어디서든 여는 키 + **자식 프레임이 넘겨 준 요청**. */
export function bindOmniKey(): void {
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!isOmniChord(e)) return;
    e.preventDefault();
    e.stopPropagation();     // 같은 문서의 위키 ⌘K(web/wiki-doc.ts)와 겹쳐 두 창이 뜨지 않게 — 캡처에서 끊는다
    if (box) omniClose(); else omniOpen();
  }, true);
  //  프레임(터미널 · 액자)에서 넘어온 요청 — **같은 오리진만**. 보낸 창을 기억했다가 닫을 때 그 창에 알린다(초점 돌려받기).
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.origin !== location.origin) return;
    const m: any = ev.data;
    if (!m || m.type !== OMNI_MSG) return;
    const seed = typeof m.seed === 'string' ? m.seed.slice(0, 200) : '';
    //  키 신호는 열고 닫기를 오간다(셸의 ⌘K 와 같다). «여는» 뜻만 있는 신호(open: true — 앱 화면 다리)는 열린 창을 닫지 않는다.
    if (box && !seed) { if (m.open === true) omniOpen(); else omniClose(); return; }
    omniOpen(seed || undefined, (ev.source as Window) || null);
  });
}
/** 프레임 ↔ 셸 신호 이름 — 한 벌은 web/lib/omni-chord.ts 에 있다(액자·앱 화면 다리가 omni.ts 를 들이지 않고도 같은 상수를 쓰게). */
export { OMNI_MSG, OMNI_CLOSED_MSG };
/** 이 문서에서 통합검색을 열 수 있나 — 셸(v2)만 연다. 액자(클래식 ?embed=1) 문서는 같은 모듈을 실어도 훅이 없다(#4530). */
export function omniAvailable(): boolean { return !!hooks; }
/** 액자 안 문서가 바깥 셸에게 «통합검색을 열어 달라» 고 부탁한다(#4530). 셸 밖(단독 탭)이면 false. */
export function requestOmniFromParent(seed?: string): boolean {
  if (typeof window === 'undefined' || window.parent === window) return false;
  try {
    window.parent.postMessage({ type: OMNI_MSG, ...(seed ? { seed: String(seed).slice(0, 200) } : {}) }, location.origin);
    return true;
  } catch { return false; }
}

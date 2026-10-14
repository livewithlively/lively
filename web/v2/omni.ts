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
//
//  ── 4차(#4530 검색 품질, 원준 2026-10-05) — «결국 세션을 해야함» · «어느 정도 이상 되는 애들 찾고 그 다음은 시간순» ──
//   실측(매니지드): 붙여 쓰면 6% · 한 글자 틀리면 0% · 군말을 더하면 48% 만 그 세션을 찾았다. 서버(conv-index-store)가 이제
//    ① 글자가 조금 달라도 찾고(붙여 쓰기 · 한 글자 틀림 · 배포 = deploy · 군말은 없어도 됨) ② 결과를 두 층으로 준다:
//    **맞는 결과**(문턱을 넘은 것 — 맨 위 셋 + 시간순) · **덜 맞는 결과**(낱말 일부만 · 비슷한 글자로 · AI 가 스친 말로만).
//   화면은 덜 맞는 결과를 날짜 묶음 아래 «덜 맞는 결과» 로 따로 세우고, 줄마다 왜 그런지 한마디를 붙인다. 맨 위 셋·탭 숫자에는 넣지 않는다.
//   다른 제품(Slack · Outlook · Gmail 모바일 · Yahoo 메일)의 표준이 «시간순 목록 + 맨 위 몇 개», Algolia 가 «층을 나누고 층 안에서 다른 기준» 이다.
//   무엇을 쳤고 무엇을 열었는지는 한 번의 찾기에 한 줄 남긴다(POST /api/ui/v6/search-log) — 다음 판을 수치로 견주려고.
import { api, el, sv, wsKey } from '../core.js';
import { ICONS, projGlyph } from '../lib/icon-paths.js';   // #4233 선 아이콘 한 벌
import { appHref, embedUrl, visibleApps } from './apps.js';
import { appMatches } from '../lib/app-match.js';   // #4233 옛 이름으로도 찾는다(런치패드와 같은 잣대)
import { sessText } from './side.js';
import { projName, findSessByConv, isTrashedSess, isMineSess, type Sess, type V2Data } from './views.js';
import { showCtxMenu, ctxIsOpen, closeCtxMenu } from './ctx-menu.js';   // 기간 고르기 — 화면 어디서나 같은 메뉴 한 벌(#3784)
import {
  type OmniSort, type OmniPeriod, SORT_STORE, SORT_LABEL, readSort, PERIODS, periodLabel, periodSince, inPeriod,
  dayBucket, whenLabel, byRecent, atOf,
} from '../lib/omni-order.js';   // #4517 정렬·기간 규칙(순수)
import {
  type Term, parseTerms, matchAll, matchAllAcross, highlightWords, splitKnowTitle, cleanSnippet, focusSnippet, identKind, pickTop,
} from '../lib/omni-rank.js';   // #4530 순서·줄 다듬기 규칙(순수)
import { isOmniChordLike, OMNI_MSG, OMNI_CLOSED_MSG, type ChordLike } from '../lib/omni-chord.js';   // #4530 여는 키 판정 · 신호 이름 한 벌
import { createPreview, type PvRef, type PvOpenMode } from './omni-preview.js';   // #4530 안 A — 고른 결과의 안을 옆 칸에
import { canOpenInAside, openInAside } from './aside-slot.js';
import { pinGuest } from '../lib/wiki-list.js';
import { projHitHref } from '../lib/proj-page.js';   // #3870 프로젝트 줄은 프로젝트 화면으로(사이드바 [→] 와 같은 문)

type Kind = 'proj' | 'know' | 'src' | 'sess' | 'app';

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
  /** 종류 그림 대신 쓸 그림(표의 패스) — 최근 검색은 시계. 종류(app)의 창 그림이 «왜 저 그림이냐» 였다(원준 2026-10-04). */
  icon?: string[];
  /** 목록 둘째 줄 — 이 항목이 **어디에 있는 것인가**(세션의 프로젝트 · 태스크의 상위). 없으면 발췌(sub)가 그 자리를 받는다. */
  meta?: string;
  /** 미리보기 칸이 안을 읽을 좌표(#4530 안 A). */
  pv?: PvRef;
  /** 층(#4530 검색 품질) — weak = 덜 맞는 결과(낱말 일부만 · 비슷한 글자로 · AI 가 스친 말로만). 없으면 맞는 결과. */
  tier?: 'match' | 'weak';
  /** 왜 덜 맞는가 — 둘째 줄 앞에 붙는 한마디(«‘물소’ 없음» · «‘귤나무 정원’ 으로 찾음»). */
  why?: string;
  /** 빈 칸 맨 위의 «최근 검색» 한 줄에 서는 칩인가 — 줄이 아니라 옆으로 늘어선다(←→ 로 옮긴다). */
  chip?: boolean;
  /** 친 번호로 온 세션(그 번호의 프로젝트에 묶였거나 그 번호의 태스크를 맡았다) — 둘째 줄에 «#4530» 을 단다.
   *  ⚠ ident 에 넣지 않는다 — ident 는 «그 번호의 주인»(프로젝트·태스크 자신)이고 맨 위 셋의 첫 층이다. 세션은 그 주인 다음에 선다. */
  num?: string;
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
  { kind: 'proj', label: '프로젝트' },
  { kind: 'know', label: '지식' },
  { kind: 'src', label: '자료' },
  { kind: 'app', label: '바로 가기' },
];
/** 자료의 출처를 사람 말로 — 목록 둘째 줄(종전엔 github_issue · local_file 같은 내부 이름이 그대로 보였다). */
const SRC_SYS: Record<string, string> = { slack: 'Slack', github: 'GitHub', gitlab: 'GitLab', notion: 'Notion', google: 'Google', gdrive: 'Google Drive', gmail: 'Gmail',
  linear: 'Linear', clickup: 'ClickUp', figma: 'Figma', outlook: 'Outlook', local: '올린 파일', local_file: '올린 파일' };
const KIND_LABEL: Record<Kind, string> = { proj: '프로젝트', know: '지식', src: '자료', sess: '세션', app: '화면' };
/** 문턱 밖의 결과를 세우는 묶음 — 날짜 묶음 아래, 바로 가기 위. */
const WEAK_LABEL = '덜 맞는 결과';
// 아이콘은 사이드바 · 레일과 같은 그림이다(#4233, lib/icon-paths.ts 한 벌). 「화면」만 여기서 그린다(그 표에 없는 뜻).
//  프로젝트는 과녁(#4233, 원준 2026-10-04). 크기에 따라 과녁 · 작은 과녁을 고른다(미리보기의 종류 이름표 13px · 결과 줄 16px).
const KIND_PATH: Record<Kind, string[]> = {
  proj: [ICONS.proj],
  know: [ICONS.wiki],
  src: [ICONS.src],
  sess: [ICONS.chat],
  app: ['M4 5h16v12H4z', 'M4 9h16'],
};
const KIND_PX: Record<string, number> = { 'v2-opv-kic': 13, 'v2-omni-kic': 15 };
const kindPaths = (k: Kind, cls: string): string[] => (k === 'proj' ? [ICONS[projGlyph(KIND_PX[cls] || 15)]] : KIND_PATH[k]);
const icon = (k: Kind, cls: string, paths: string[] = kindPaths(k, cls)): SVGElement =>
  sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, ...paths.map((d) => sv('path', { d })));

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

// ── 탭 — 한 번에 종류 하나(#4530 안 A, 원준 2026-10-04 «A안으로 가자») ─────────────
//  종전 칩은 «누른 것만 켜지는» 여러 개 고르기였다 — 손잡이 다섯이 한 줄에 서고(폰에선 잘렸다), 지금 무엇을 보고 있는지가 칩의
//   켜짐 조합으로만 보였다. 탭은 하나만 고른다: 전체 · 세션 · 프로젝트 · 지식 · 자료. 숫자가 탭마다 서서 어디에 몇 개 있는지 보인다.
//  ★ 세션·프로젝트·지식은 **어느 탭에서든 함께 묻는다** — 탭을 넘길 때 다시 기다리지 않고 숫자도 늘 선다.
//   자료만 그 탭을 눌렀을 때 묻는다(결과가 많고 느리다 — 실측 2~3초).
type OmniTab = 'all' | 'sess' | 'proj' | 'know' | 'src';
const OMNI_TABS: ReadonlyArray<{ key: OmniTab; label: string }> = [
  { key: 'all', label: '전체' }, { key: 'sess', label: '세션' }, { key: 'proj', label: '프로젝트' }, { key: 'know', label: '지식' }, { key: 'src', label: '자료' },
];
let tab: OmniTab = 'all';
/** 이 탭이 이 종류의 줄을 보이나 — 전체는 자료만 빼고 다, 나머지는 그 종류만(화면·명령 같은 바로 가기는 전체에서만). */
function tabShows(t: OmniTab, k: Kind): boolean { return t === 'all' ? k !== 'src' : k === t; }
/** 이 탭에서 이 종류를 서버에 묻나 — 자료는 그 탭에서만. */
function tabFetches(t: OmniTab, k: Kind): boolean { return k === 'src' ? t === 'src' : true; }
/** Tab(다음) · Shift+Tab(앞) 으로 넘길 탭 — 끝에서 처음으로 돈다. */
function nextTab(cur: OmniTab, d: number): OmniTab {
  const i = OMNI_TABS.findIndex((x) => x.key === cur);
  return OMNI_TABS[(Math.max(0, i) + d + OMNI_TABS.length) % OMNI_TABS.length].key;
}
const kindOn = (k: Kind): boolean => tabFetches(tab, k);
const kindShown = (k: Kind): boolean => tabShows(tab, k);
const ALL_KINDS: Kind[] = ['sess', 'proj', 'know', 'app', 'src'];
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(String((navigator as any).platform || navigator.userAgent || ''));
/** 폰 폭인가 — 미리보기가 옆 칸이 아니라 아래에서 올라오는 판이 된다(CSS 와 같은 문턱 640px). */
const isNarrow = (): boolean => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
/** 손가락으로 쓰는 넓은 화면(태블릿)인가 — 마우스를 올려 고를 수 없으니 첫 누름은 고르기(미리보기), 고른 줄을 다시 누르면 연다. */
const noHover = (): boolean => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(hover: none)').matches;
const fmtN = (n: number): string => n.toLocaleString('ko-KR');

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
interface OpenedRow { kind: Kind; key: string; title: string; href: string; at: number; label?: string }
function readJson(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function writeJson(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 막힌 저장소 — 이번 페이지에서만 */ }
}
function loadOpened(): OpenedRow[] {
  const v = readJson(OPENED_STORE());
  if (!Array.isArray(v)) return [];
  return v.map((x: any) => (x && x.kind === 'conv' ? { ...x, kind: 'sess' } : x))   // #4530 전 저장값 — 대화는 이제 세션이다
    .filter((x: any) => x && typeof x.key === 'string' && typeof x.href === 'string' && x.href.startsWith('#/')
    && typeof x.title === 'string' && ALL_KINDS.includes(x.kind)).slice(0, 8) as OpenedRow[];
}
function rememberOpened(h: Hit): void {
  if (!h.href) return;
  const row: OpenedRow = { kind: h.kind, key: h.key, title: h.title, href: h.href, at: Date.now(), ...(h.label ? { label: h.label } : {}) };
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
let onSheetEsc: (() => boolean) | null = null;   // 폰 — 미리보기 판이 올라와 있으면 Esc 는 판만 내린다

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
  //  더 가져온 뒤에도 고른 줄은 그대로다 — 맨 아래에서 ↓ 로 이어 내려가는 중에 선택이 맨 위로 돌아가면 처음부터 다시 내려와야 한다(격리 리뷰).
  const loadMore = (): void => { const keep = selKey; moreFactor++; input.focus(); run(true); if (keep) { selKey = keep; userMoved = true; } };
  const moreBtn = el('button', { class: 'v2-omni-more', type: 'button', hidden: true, title: '결과 더 보기 (맨 아래 줄에서 ↓)', onclick: () => loadMore() },
    el('span', { text: '결과 더 보기' })) as HTMLButtonElement;

  // ── 탭 — 한 번만 만들고 켜짐·숫자만 바꾼다(다시 만들면 누른 단추가 사라져 초점이 날아갔다 — 점검 실측) ──
  const tabBtns = new Map<OmniTab, HTMLButtonElement>();
  const tabNums = new Map<OmniTab, HTMLElement>();
  for (const t of OMNI_TABS) {
    const n = el('em', { class: 'v2-omni-tabn' }) as HTMLElement;
    tabNums.set(t.key, n);
    tabBtns.set(t.key, el('button', {
      class: 'v2-omni-tab' + (t.key === 'src' ? ' aux' : ''), type: 'button', role: 'tab', 'data-tab': t.key, 'aria-controls': 'v2-omni-list',
      title: t.key === 'src' ? '수집한 원문과 올린 파일에서 찾습니다 (이 탭을 눌렀을 때만 찾습니다)' : t.key === 'all' ? '세션 · 프로젝트 · 지식 · 화면을 함께 봅니다' : `${t.label}만 봅니다`,
      onclick: () => setTab(t.key),
    }, el('span', { text: t.label }), n) as HTMLButtonElement);
  }
  const tabs = el('div', { class: 'v2-omni-tabs', role: 'tablist', 'aria-label': '종류' }, ...OMNI_TABS.map((t) => tabBtns.get(t.key)!));
  function paintTabs(): void {
    for (const [k, b] of tabBtns) { const on = k === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; }
    input.placeholder = tab === 'all' ? '세션(대화 내용 포함) · 프로젝트 · 지식 · 화면에서 찾기'
      : tab === 'src' ? '수집한 자료와 올린 파일에서 찾기' : `${OMNI_TABS.find((x) => x.key === tab)!.label}에서 찾기 (Tab 으로 종류를 바꿉니다)`;
  }
  /** 탭을 바꾼다 — 받아 둔 결과를 그 종류만 다시 세운다(기다림 없음). 자료는 처음 고를 때 **자료만** 서버에 묻는다. */
  function setTab(t: OmniTab): void {
    input.focus();
    if (tab === t) return;
    tab = t;
    paintTabs();
    closeSheet();
    //  자료 탭에 처음 들어왔다 — 다른 채널(세션·프로젝트·지식)은 받아 둔 것을 그대로 두고 자료만 묻는다. 종전엔 검색 전체를 다시 돌려
    //   탭 숫자가 비었다 차고, 자료(실측 2~4초)가 자리 잡기 상한보다 늦으면 «결과가 없습니다» 가 먼저 떴다(격리 리뷰 · 실화면).
    const q = input.value.trim();
    if (t === 'src' && q && q === ranQuery && inflight && !buckets.has('src') && !pending.has('src')) {
      pending.add('src');
      bar.classList.add('on');
      fetchSrc(q, seq, inflight.signal);
    }
    userMoved = false; selKey = '';
    paint();
    refreshNote();
  }
  // ── 기간 · 정렬(#4517) — 탭 줄 오른쪽의 작은 단추 둘 ──
  const optIcon = (d: string): SVGElement => sv('svg', { viewBox: '0 0 24 24', class: 'v2-omni-opt-ic', 'aria-hidden': 'true' }, sv('path', { d }));
  const sortBtn = el('button', { type: 'button', class: 'v2-omni-opt v2-omni-sort', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => openSortMenu() }) as HTMLButtonElement;
  function paintSort(): void {
    sortBtn.dataset.sort = String(sortMode);
    sortBtn.title = sortMode === 'rel' ? '가장 잘 맞는 것부터 종류별로 보여 줍니다 — 눌러서 바꿉니다' : '맨 위에 가장 맞는 결과를 두고, 그 아래는 최근 것부터 보여 줍니다 — 눌러서 바꿉니다';
    sortBtn.replaceChildren(optIcon('M7 4v16 M3 8l4-4 4 4 M17 20V4 M13 16l4 4 4-4'), el('span', { text: SORT_LABEL[sortMode as OmniSort] }), optIcon(ICONS.chevD));
  }
  function openSortMenu(): void {
    const r = sortBtn.getBoundingClientRect();
    sortBtn.setAttribute('aria-expanded', 'true');
    showCtxMenu(r.left, r.bottom + 4, (['recent', 'rel'] as OmniSort[]).map((m) => ({
      label: SORT_LABEL[m], checked: sortMode === m,
      run: () => { if (sortMode === m) return; sortMode = m; saveSort(m); paintSort(); run(true); },
    })), { minWidth: 150, onClose: () => { sortBtn.setAttribute('aria-expanded', 'false'); if (box) input.focus(); } });
  }
  const periodBtn = el('button', {
    type: 'button', class: 'v2-omni-opt v2-omni-period', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    onclick: () => openPeriodMenu(),
  }) as HTMLButtonElement;
  function paintPeriod(): void {
    const on = period !== 'all';
    periodBtn.classList.toggle('on', on);
    periodBtn.title = on ? `${periodLabel(period)} 안에서만 찾습니다 — 눌러서 바꿉니다` : '기간으로 좁힙니다';
    periodBtn.replaceChildren(optIcon(ICONS.clock), el('span', { text: on ? periodLabel(period) : '기간' }), optIcon(ICONS.chevD));
  }
  function openPeriodMenu(): void {
    const r = periodBtn.getBoundingClientRect();
    periodBtn.setAttribute('aria-expanded', 'true');
    showCtxMenu(r.left, r.bottom + 4, PERIODS.map((p) => ({
      label: p.label, checked: period === p.key,
      run: () => { if (period === p.key) return; period = p.key; paintPeriod(); run(true); },
    })), { minWidth: 150, onClose: () => { periodBtn.setAttribute('aria-expanded', 'false'); if (box) input.focus(); } });
  }
  const tools = el('span', { class: 'v2-omni-tools', role: 'group', 'aria-label': '기간과 정렬' }, periodBtn, sortBtn);
  const filters = el('div', { class: 'v2-omni-filters' }, tabs, tools);
  //  닫기 — 눌리는 단추다(종전 «Esc» 는 글자 표시라 폰에서 닫을 길이 바깥 여백뿐이었다 — 점검 실측).
  const closeBtn = el('button', { class: 'v2-omni-close', type: 'button', title: '닫기 (Esc)', 'aria-label': '통합검색 닫기', onclick: () => omniClose() },
    el('span', { class: 'v2-omni-close-t', text: '닫기' }), el('kbd', { class: 'v2-omni-esc', text: 'Esc' }));
  //  결과가 없을 때의 말은 목록 자리에 선다(아래 줄은 색인·실패 같은 상태만 말한다).
  const none = el('div', { class: 'v2-omni-none', hidden: true }) as HTMLElement;
  //  미리보기 칸 — 넓은 화면에선 목록 옆, 폰에선 아래에서 올라오는 판(줄을 누르면 올라온다).
  const pvWrap = el('div', { class: 'v2-omni-pvw' }) as HTMLElement;
  const sheetBg = el('div', { class: 'v2-omni-sheetbg', 'aria-hidden': 'true', onclick: () => closeSheet() }) as HTMLElement;
  const kbdEl = (t: string): HTMLElement => el('kbd', { text: t }) as HTMLElement;
  const hints = el('div', { class: 'v2-omni-hints', 'aria-hidden': 'true' },
    el('span', {}, kbdEl('↑'), kbdEl('↓'), document.createTextNode(' 고르기')),
    el('span', {}, kbdEl('Enter'), document.createTextNode(' 열기')),
    el('span', {}, kbdEl((IS_MAC ? '⌘' : 'Ctrl') + ' Enter'), document.createTextNode(' 새 탭')),
    el('span', {}, kbdEl('Tab'), document.createTextNode(' 종류 바꾸기')),
    el('span', {}, kbdEl('Esc'), document.createTextNode(' 닫기')));
  const card = el('div', { class: 'v2-omni-card' },
    el('div', { class: 'v2-omni-top' },
      sv('svg', { viewBox: '0 0 24 24', class: 'v2-omni-lens', 'aria-hidden': 'true' },
        sv('circle', { cx: '11', cy: '11', r: '6.5' }), sv('path', { d: 'M16 16l4.5 4.5' })),
      input, closeBtn),
    bar, filters,
    el('div', { class: 'v2-omni-body' },
      el('div', { class: 'v2-omni-col' }, none, list, moreBtn),
      sheetBg, pvWrap),
    el('div', { class: 'v2-omni-foot' }, hints, note)) as HTMLElement;

  box = el('div', {
    class: 'v2-omni', role: 'dialog', 'aria-modal': 'true', 'aria-label': '통합검색',
    onmousedown: (e: MouseEvent) => { if (e.target === box) omniClose(); },
  }, card) as HTMLElement;

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
  const frozenTop = new Map<OmniTab, string[]>();   // 자리 잡은 뒤의 맨 위 셋(탭마다 — 늦게 온 줄이 바꾸지 않는다)
  let selKey = '';                  // 고른 줄의 열쇠
  let userMoved = false;            // 이 질의에서 사람이 화살표·마우스로 골랐나
  let enterWant: { mode: PvOpenMode } | null = null;   // 자리 잡으면 열 Enter
  let convNoteText = '';            // 대화 채널이 남긴 말(색인 중 · 실패 · 상한)
  let simDegraded = false;
  let moreFactor = 1;               // «결과 더 보기» 를 누른 횟수 + 1
  //  글자 채널(프로젝트·지식·자료)이 실패한 것 — 전엔 말없이 빈 결과로 처리해 다 실패하면 «결과가 없습니다» 가 떴다(#4530 항목 42).
  const failedSrc = new Set<string>();
  //  더 있을 수 있나 — 채널이 요청한 만큼 꽉 채워 왔거나(서버 상한 50 전까지) 그리기 상한에 잘렸다.
  //   전엔 줄이 40개 넘을 때만 단추가 떠서 칩 하나만 켜면(지식 20줄) 더 볼 길이 없었다(#4530 항목 22).
  const fullSrc = new Set<string>();
  let truncated = false;
  //  종류마다 **모두** 몇 개인가(서버가 센 것) — 줄은 20개씩만 받아 오므로 받은 수만 세면 탭마다 «20+» 만 섰다(실화면).
  const totals = new Map<string, number>();
  let convCapped = false;
  //  서버가 비슷한 글자로 찾아 준 자리의 실제 글(«통합 검색» · «프로젝트») — 친 글과 달라서 따로 칠한다. 덜 맞는 세션의 수 · 느슨하게 본 낱말.
  let extraWords: string[] = [];
  let convWeak = 0;
  let convLoosened: string[] = [];
  //  검색 기록 — 마지막 글자를 친 때 · 자리 잡기까지 걸린 시간 · 이 창에서 무엇을 열었나.
  let typedAt = 0;
  let typedFresh = false;   // 마지막 검색 뒤에 글자를 쳤나 — 아니면(정렬·기간·더 보기로 다시 돈다) 그 검색이 시작된 때부터 잰다
  let startAt = 0;
  let settleMs: number | null = null;
  let logged = false;
  let totalsFor = '';               // 그 개수가 어느 검색어·기간의 것인가(같으면 «더 보기»·정렬 바꾸기에서 다시 묻지 않는다)

  const rowNodes: HTMLElement[] = [];
  const rowHits: Hit[] = [];        // ⚠ 그려진 줄과 짝 — i 번째 줄이 무엇인지는 이것만 안다(#1960)

  //  extra = 그 글에서만 더 칠할 낱말(미리보기의 «비슷한 글자로 맞은 자리»).
  const hl = (text: string, extra?: string[]): Node[] => hlParts(text, extra && extra.length ? [...words, ...extraWords, ...extra] : extraWords.length ? [...words, ...extraWords] : words).map((p) =>
    (p.hit ? el('mark', { class: 'v2-omni-hl', text: p.t }) : document.createTextNode(p.t)) as Node);

  /** 목록 둘째 줄 — 어디에 있는 것인가(프로젝트 · 상위 · 주인) + 맞은 글 한 조각. 앞뒤 말까지는 미리보기 칸이 보인다. */
  function metaLine(h: Hit): HTMLElement | null {
    const bits: Node[] = [];
    let glue = ' · ';
    const dot = (): void => { if (bits.length) bits.push(document.createTextNode(glue)); glue = ' · '; };
    if (h.label) bits.push(el('span', { class: 'v2-omni-sub', text: h.label }));
    //  덜 맞는 결과 — 왜 그런지가 먼저다(«‘물소’ 없음» · «‘귤나무 정원’ 으로 찾음»). 말없이 섞으면 «왜 이게 떴지» 가 된다.
    if (h.why) { dot(); bits.push(el('span', { class: 'v2-omni-why', text: h.why })); }
    //  상위 프로젝트 «이름 ›» 뒤에는 가운뎃점을 찍지 않는다(«… › · …» 로 보였다, 실화면).
    if (h.context) { dot(); bits.push(el('span', { class: 'v2-omni-ctx', text: h.context })); if (h.context.endsWith('›')) glue = ' '; }
    const id = identKind(h.ident, terms);
    if (id && h.ident) { dot(); bits.push(el('code', { class: 'v2-omni-key' + (id === 'exact' ? ' exact' : '') }, ...hl(/^[0-9]+$/.test(h.ident) ? '#' + h.ident : h.ident))); }
    //  번호로 온 세션 — 왜 떴는지(그 번호의 프로젝트·태스크의 세션이다)를 번호로 말한다.
    if (h.num) { dot(); bits.push(el('code', { class: 'v2-omni-key exact', text: '#' + h.num })); }
    //  어디에 있는 것인가(세션의 프로젝트 · 자료의 출처) 뒤에 **왜 맞았는지**(고친 파일 · 맞은 말 한 조각)를 잇는다. 프로젝트 이름만 서면
    //   줄마다 미리보기를 봐야 맞은 말을 알았다 — 주로 쓰는 일이 대화 일부로 세션을 찾는 것이고, 폰에는 옆 칸이 없다(격리 리뷰).
    //   뒤에 이을 것이 없으면(자료 줄) 줄 전체를 쓴다(solo).
    if (h.meta) { dot(); bits.push(el('span', { class: 'v2-omni-where' + (h.edit || h.sub ? '' : ' solo') }, ...hl(h.meta))); }
    if (h.edit) { dot(); bits.push(el('span', { class: 'v2-omni-edit', text: '고친 파일 ' }), el('code', { class: 'v2-omni-key' }, ...hl(h.edit))); }
    else if (h.sub) { dot(); bits.push(...hl(focusSnippet(h.sub, words))); }
    return bits.length ? el('span', { class: 'v2-omni-s' }, ...bits) : null;
  }

  // ── 미리보기 칸(#4530 안 A) ──
  const pv = createPreview({
    api: (path, opts) => api(path, opts),
    data: () => hooks!.data(),
    query: () => ranQuery,
    words: () => words,
    since: () => sinceMs,
    hl,
    icon: (h, cls) => icon((h as Hit).kind, cls, (h as Hit).icon),
    kindLabel: (h) => (h as Hit).label || KIND_LABEL[(h as Hit).kind],
    when: (ms) => whenLabel(ms, Date.now()),
    open: (h, mode) => { const i = rowHits.findIndex((x) => x.key === h.key); if (i >= 0) go(i, mode); },
    openHref: (href, title) => {
      const q = input.value.trim();
      if (q) { rememberQuery(q); lastQuery = { q, at: Date.now() }; }
      //  미리보기 안의 다른 항목(상위 프로젝트 · 연결 지식)으로 간 것도 «그 줄을 골라 들어간 것» 으로 남긴다.
      const si = rowHits.findIndex((h) => h.key === selKey);
      if (q && q === ranQuery && si >= 0) sendLog('open', rowHits[si], si + 1);
      omniClose({ restoreFocus: false });
      hooks!.open(href, false, title);
    },
    canAside: () => canOpenInAside(),
    mac: IS_MAC,
  });
  const grab = el('button', { class: 'v2-omni-grab', type: 'button', 'aria-label': '미리보기 내리기', title: '미리보기 내리기', onclick: () => closeSheet() }) as HTMLElement;
  pvWrap.append(grab, pv.el);
  //  미리보기 안의 단추를 마우스로 눌러도 초점은 입력칸에 남는다 — 초점이 단추로 가면(‹ › 는 누르는 순간 다시 그려져 사라진다)
  //   방향키·Enter 가 듣지 않아 입력칸을 다시 눌러야 했다(격리 리뷰). 글을 긁어 복사하는 것은 막지 않는다(단추에서만).
  pvWrap.addEventListener('mousedown', (e: MouseEvent) => { if ((e.target as Element | null)?.closest?.('button')) e.preventDefault(); });
  //  폰 — 손잡이를 아래로 끌면 판이 내려간다(끌 수 있게 생겼는데 눌러야만 내려갔다, 격리 리뷰).
  let dragY = -1;
  grab.addEventListener('touchstart', (e: TouchEvent) => { dragY = e.touches[0].clientY; pvWrap.style.transition = 'none'; }, { passive: true });
  grab.addEventListener('touchmove', (e: TouchEvent) => { if (dragY >= 0) pvWrap.style.transform = `translateY(${Math.max(0, e.touches[0].clientY - dragY)}px)`; }, { passive: true });
  const endDrag = (e: TouchEvent): void => {
    if (dragY < 0) return;
    const dy = (e.changedTouches[0] ? e.changedTouches[0].clientY : dragY) - dragY;
    dragY = -1; pvWrap.style.transition = ''; pvWrap.style.transform = '';
    if (dy > 60) closeSheet();
  };
  grab.addEventListener('touchend', endDrag);
  grab.addEventListener('touchcancel', endDrag);
  /** 안을 읽을 것이 있는 줄인가(화면·명령·최근 검색은 한두 줄 설명뿐이다 — 폰에선 바로 연다). */
  const hasInside = (h: Hit): boolean => !!h.pv && h.pv.t !== 'text';
  function openSheet(): void { card.classList.add('sheet'); }
  function closeSheet(): void { card.classList.remove('sheet'); }

  // ── 그리기 ──
  /** 지금 탭에 보일 줄(뜻만 비슷한 것 제외). */
  const shownLexical = (): Hit[] => hits.filter((h) => !h.sim && kindShown(h.kind));
  const isReal = (h: Hit): boolean => !h.key.startsWith('cmd:') && !h.key.startsWith('q:');
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
        const kindName = h.label || KIND_LABEL[h.kind];
        const node = el('div', {
          class: 'v2-omni-row' + (h.sim ? ' sim' : '') + (h.tier === 'weak' ? ' weak' : ''), role: 'option', id: 'v2-omni-opt-' + i, 'aria-selected': 'false', 'data-kind': h.kind,
          title: (h.head ? h.head + ': ' : '') + h.title,
          //  마우스가 **실제로 움직였을 때만** 고른다 — 목록이 그 아래로 지나가는 것은 고른 것이 아니다.
          onmousemove: (e: MouseEvent) => { if ((e.movementX || e.movementY) && selKey !== h.key) { selKey = h.key; userMoved = true; mark(false); } },
          onclick: (e: MouseEvent) => {
            //  폰 — 줄을 누르면 미리보기 판이 올라오고 [열기]로 들어간다(안 A). 안을 읽을 것이 없는 줄(화면·명령)은 바로 연다.
            const plain = !(e.metaKey || e.ctrlKey || e.altKey);
            if (isNarrow() && hasInside(h) && plain) { selKey = h.key; userMoved = true; mark(false); pv.show(h); openSheet(); return; }
            //  태블릿(넓고 손가락) — 마우스를 올려 고를 수 없다. 첫 누름은 고르기(옆 칸에 미리보기), 고른 줄을 다시 누르면 연다.
            if (noHover() && hasInside(h) && plain && selKey !== h.key) { selKey = h.key; userMoved = true; mark(false); return; }
            go(i, e.altKey ? 'aside' : e.metaKey || e.ctrlKey ? 'tab' : 'here');
          },
        },
          el('span', { class: 'v2-omni-ic k-' + h.kind }, icon(h.kind, 'v2-omni-kic', h.icon)),
          el('span', { class: 'v2-omni-tt' },
            el('span', { class: 'v2-omni-tl' },
              h.head ? el('span', { class: 'v2-omni-head', text: h.head }) : null,
              el('b', { class: 'v2-omni-t' }, ...hl(h.title)),
              h.status ? el('span', { class: 'v2-omni-st', text: h.status }) : null),
            metaLine(h)),
          el('span', { class: 'v2-omni-meta' },
            when ? el('span', { class: 'v2-omni-when', text: when, title: new Date(h.at as number).toLocaleString('ko-KR') }) : null,
            //  종류 이름 — 그림(색)이 말하므로 눈에는 숨기고 화면 읽기 프로그램에만 읽힌다.
            el('span', { class: 'v2-omni-badge', text: kindName }))) as HTMLElement;
        rowNodes.push(node);
        rowHits.push(h);
        kids.push(node);
      }
    };
    //  빈 칸 맨 위의 «최근 검색» — **한 줄의 칩**으로(원준 2026-10-05 «최근 검색 기록이 차지하는 부분이 너무 많다 … 너무 저게 전부야»).
    //   종전엔 검색어마다 한 줄(여섯 줄)이라 목록을 다 차지해 «최근 연 것» · «내 최근 세션» 이 화면 밖으로 밀렸다.
    //   칩도 고르는 대상이다(rowHits 에 든다) — 목록 맨 위에서 ↑ 로 올라오고 ←→ 로 옮기고 Enter 로 다시 찾는다.
    const drawChips = (label: string, rows: Hit[]): void => {
      if (!rows.length) return;
      const strip = el('div', { class: 'v2-omni-recent', role: 'group', 'aria-label': label }, el('span', { class: 'v2-omni-recent-l', text: label })) as HTMLElement;
      for (const h of rows) {
        shown.add(h.key);
        const i = rowNodes.length;
        const node = el('div', {
          class: 'v2-omni-chip', role: 'option', id: 'v2-omni-opt-' + i, 'aria-selected': 'false', title: h.title + ' — 다시 찾기',
          onmousemove: (e: MouseEvent) => { if ((e.movementX || e.movementY) && selKey !== h.key) { selKey = h.key; userMoved = true; mark(false); } },
          onclick: () => go(i, 'here'),
        }, icon(h.kind, 'v2-omni-chip-ic', h.icon), el('span', { class: 'v2-omni-chip-t', text: h.title })) as HTMLElement;
        rowNodes.push(node);
        rowHits.push(h);
        strip.append(node);
      }
      kids.push(strip);
    };
    truncated = false;
    if (!input.value.trim()) {
      paintEmpty(draw, drawChips);
    } else {
      const all = shownLexical();
      //  덜 맞는 결과(서버가 가른 층)는 맨 위 셋에도 시간 줄에도 끼지 않는다 — 날짜 묶음 아래 따로.
      const lexical = all.filter((h) => h.tier !== 'weak');
      const weak = all.filter((h) => h.tier === 'weak');
      draw('가장 맞는 결과', topHits(lexical));
      if (sortMode === 'recent') {
        //  그 아래는 맞는 결과를 최근 것부터 — 시각이 없는 바로 가기(화면·명령)는 맨 아래 따로.
        const timed = lexical.filter((h) => h.kind !== 'app').sort(byRecent).slice(0, 60 * moreFactor);
        let bucket = '';
        let group: Hit[] = [];
        for (const h of timed) {
          const b = dayBucket(h.at, now);
          if (b !== bucket) { draw(bucket, group); group = []; bucket = b; }
          group.push(h);
        }
        draw(bucket, group);
        draw(WEAK_LABEL, weak);
        draw('바로 가기', lexical.filter((h) => h.kind === 'app'));
      } else {
        for (const g of GROUPS) draw(g.label, lexical.filter((h) => h.kind === g.kind).slice(0, 12 * moreFactor));
        draw(WEAK_LABEL, weak);
      }
      if (kindShown('know')) draw('뜻이 비슷한 지식', hits.filter((h) => h.sim).slice(0, SIM_MAX_ROWS));
      truncated = lexical.some((h) => !shown.has(h.key));   // 그리기 상한(최신순 60 · 관련도순 묶음당 12)에 잘린 줄이 있다
    }
    list.replaceChildren(...kids);
    paintCounts();
    //  선택은 열쇠로 이어 간다. 고른 줄이 사라졌으면 첫 줄 — 빈 칸에서는 칩이 아닌 첫 줄(Enter 가 가장 최근에 연 것을 연다).
    if (!rowHits.some((h) => h.key === selKey)) selKey = (rowHits.find((h) => !h.chip) || rowHits[0])?.key || '';
    mark(false);
  }
  /** 탭마다 몇 개 있는지 — 서버가 센 전체 개수(받은 줄 수가 아니다). 못 셌으면 받은 만큼 + «+»(더 있을 수 있다). 명령·최근 검색은 결과가 아니다. */
  function paintCounts(): void {
    const q = !!input.value.trim();
    const lex = hits.filter((h) => !h.sim && isReal(h) && h.tier !== 'weak');   // 덜 맞는 결과는 숫자에 넣지 않는다(서버의 total 도 맞는 결과만 센다)
    const n = (k: Kind): number => lex.filter((h) => h.kind === k).length;
    const cnt = (k: Kind, src: string): { n: number; plus: boolean } => {
      const got = n(k), tot = totals.get(src);
      //  이름으로만 맞은 셸 목록 줄(세션·프로젝트)은 서버 개수에 없을 수 있다 — 보이는 줄보다 작은 숫자를 세우지 않는다.
      return tot === undefined ? { n: got, plus: fullSrc.has(src) } : { n: Math.max(tot, got), plus: src === 'conv' && convCapped };
    };
    const text = (c: { n: number; plus: boolean }): string => fmtN(c.n) + (c.plus ? '+' : '');
    const set = (t: OmniTab, v: string): void => { const e = tabNums.get(t)!; e.textContent = v; e.hidden = !v; };
    if (!q) { for (const t of OMNI_TABS) set(t.key, ''); return; }
    const cs = cnt('sess', 'conv'), cp = cnt('proj', 'proj'), ck = cnt('know', 'know');
    //  «전체» 에는 바로 가기(화면 · 리스트 · 폴더 · 분류 · 설정) 줄도 선다 — 숫자에서 빼면 화면 이름만 맞은 검색이 «전체 0» 위에 줄이 서는 꼴이 된다.
    set('all', text({ n: cs.n + cp.n + ck.n + n('app'), plus: cs.plus || cp.plus || ck.plus }));
    set('sess', text(cs));
    set('proj', text(cp));
    set('know', text(ck));
    set('src', buckets.has('src') ? text(cnt('src', 'src')) : '');
  }
  /** 맨 위 셋 — 자리 잡은 뒤에는 탭마다 굳힌다(늦게 온 채널이 첫 줄을 바꾸면 Enter 가 엉뚱한 것을 연다). */
  function topHits(lexical: Hit[]): Hit[] {
    const frozen = frozenTop.get(tab);
    if (frozen) return frozen.map((k) => lexical.find((h) => h.key === k)).filter((h): h is Hit => !!h);
    //  명령 줄(«…로 새 세션 시작»)은 이름에 검색어가 그대로 들어 있어 «이름에 모두» 층에 붙는다 — 결과가 아니므로 후보에서 뺀다
    //   (캡처로 확인: 맨 위 셋을 명령 둘이 차지했다).
    const ranked = pickTop(lexical.filter((h) => !h.key.startsWith('cmd:')).map((h) => ({ ...h, name: h.title })), terms, input.value);
    const top = ranked.map((r) => lexical.find((h) => h.key === r.key)).filter((h): h is Hit => !!h);
    //  «전체» 의 맨 위 셋에는 세션이 하나는 선다 — 주로 찾는 것이 세션인데(원준 2026-10-01), 이름에 낱말이 든 지식·태스크 셋이
    //   자리를 다 차지하면 대화로 가장 잘 맞은 세션이 여섯째 줄 아래로 밀렸다(«배포 절차» 실화면). 서버가 표시한 세션(top)을 끝자리에 세운다.
    if (tab === 'all' && !top.some((h) => h.kind === 'sess')) {
      const best = lexical.find((h) => h.kind === 'sess' && h.serverTop);
      if (best) { if (top.length >= 3) top[top.length - 1] = best; else top.push(best); }
    }
    //  이 탭의 채널이 아직 오는 중이고 세울 줄이 없으면 굳히지 않는다(자료 탭 — 빈 채로 굳으면 온 뒤에도 맨 위가 비었다).
    if (settled && input.value.trim() && !(top.length === 0 && tabWaiting())) frozenTop.set(tab, top.map((h) => h.key));
    return top;
  }
  /** 빈 칸 — 최근 검색어 · 최근 연 것 · 내 최근 세션(탭을 따른다). 스포트라이트를 열자마자 빈 판이면 무엇을 칠지가 안 보인다. */
  function paintEmpty(draw: (label: string, rows: Hit[]) => void, drawChips: (label: string, rows: Hit[]) => void): void {
    const qs = loadQueries();
    if (qs.length && tab === 'all') {
      drawChips('최근 검색', qs.map((q): Hit => ({
        kind: 'app', key: 'q:' + q, title: q, sub: '', label: '검색', icon: [ICONS.clock], chip: true,
        pv: { t: 'text', lines: ['이 검색어로 다시 찾습니다.'], act: '다시 찾기' },
        run: () => { input.value = q; run(true); },
      })));
    }
    //  최근 검색이 한 줄로 줄어 자리가 났다 — 최근 연 것은 기억해 둔 여덟 개를 다 보인다(종전 다섯).
    draw('최근 연 것', loadOpened().filter((o) => kindShown(o.kind)).slice(0, 8).map((o): Hit => openedHit(o)));
    if (kindShown('sess')) draw('내 최근 세션', recentSessions().slice(0, 6));
  }
  /** 저장해 둔 «최근 연 것» 한 줄 → 미리보기 좌표를 열쇠에서 되찾는다. */
  function openedHit(o: OpenedRow): Hit {
    const d = hooks!.data();
    const base: Hit = { kind: o.kind, key: o.key, title: o.title, sub: '', href: o.href, at: o.at, label: o.label };
    if (o.key.startsWith('s:')) { const s = d.sessions.find((x) => x.id === o.key.slice(2)); if (s) return { ...sessHit(d, s), title: o.title, at: o.at }; }
    else if (o.key.startsWith('c:')) { const m = /^c:([^:]*):(.+)$/.exec(o.key); if (m) base.pv = { t: 'sess', node: m[1], sid: m[2] }; }
    else if (o.key.startsWith('k:')) base.pv = { t: 'know', name: o.key.slice(2) };
    else if (o.key.startsWith('p:')) { const id = Number(o.key.slice(2)); if (id) base.pv = o.label ? { t: 'task', id } : { t: 'proj', id }; }
    else if (o.key.startsWith('src:')) base.pv = { t: 'src', id: o.key.slice(4) };
    return base;
  }

  function mark(scroll = true): void {
    let selIdx = -1;
    rowNodes.forEach((n, i) => {
      const on = rowHits[i]?.key === selKey;
      if (on) selIdx = i;
      n.classList.toggle('on', on);
      n.setAttribute('aria-selected', String(on));
    });
    if (selIdx >= 0) { input.setAttribute('aria-activedescendant', rowNodes[selIdx].id); if (scroll) rowNodes[selIdx].scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
    //  미리보기는 고른 줄을 따라간다. 폰에서는 판이 올라와 있을 때만(줄을 눌러야 올라온다).
    if (!isNarrow() || card.classList.contains('sheet')) pv.show(selIdx >= 0 ? rowHits[selIdx] : null);
  }
  let lastChip = '';
  /** 칩 사이를 ←→ 로 옮긴다. 칩을 고르고 있지 않으면 false(입력칸의 커서 이동을 막지 않는다). */
  function moveChip(d: number): boolean {
    const cur = rowHits.findIndex((h) => h.key === selKey);
    if (cur < 0 || !rowHits[cur].chip) return false;
    const next = cur + d;
    if (next >= 0 && next < rowHits.length && rowHits[next].chip) { selKey = rowHits[next].key; lastChip = selKey; userMoved = true; mark(); }
    return true;
  }
  function moveSel(d: number): void {
    const cur = rowHits.findIndex((h) => h.key === selKey);
    //  맨 위에서 ↑ = 탭 줄로 올라간다 — 탭 · 기간 · 정렬과 그 뒤의 단추들에 키보드로 닿는 길이다(입력칸의 Tab 은 종류를 넘기는 데 쓴다.
    //   종전 칩·기간·정렬은 Tab 으로 닿았는데 그 길이 사라졌었다, 격리 리뷰).
    //  빈 칸의 «최근 검색» 칩들은 **한 줄**이다 — 위아래로는 한 번에 지나간다(칩 사이는 ←→, moveChip).
    //   칩에서 ↑ = 탭 줄 · 칩에서 ↓ = 첫 줄 · 첫 줄에서 ↑ = 칩(마지막에 있던 칩, 없으면 첫 칩).
    const chipAt = (i: number): boolean => !!rowHits[i]?.chip;
    if (cur >= 0 && chipAt(cur)) {
      if (d < 0) { tabBtns.get(tab)!.focus(); return; }
      const firstRow = rowHits.findIndex((h) => !h.chip);
      if (firstRow < 0) return;
      lastChip = selKey; selKey = rowHits[firstRow].key; userMoved = true; mark();
      return;
    }
    if (d < 0 && cur > 0 && chipAt(cur - 1)) {
      selKey = (rowHits.find((h) => h.chip && h.key === lastChip) || rowHits.find((h) => h.chip)!).key;
      userMoved = true; mark();
      return;
    }
    if (d < 0 && cur <= 0) { tabBtns.get(tab)!.focus(); return; }
    if (!rowNodes.length) return;
    //  맨 아래에서 ↓ = 더 있으면 더 가져온다(«결과 더 보기» 와 같은 일 — 그 단추가 12줄·60줄 너머를 보는 유일한 길이다).
    if (d > 0 && cur === rowNodes.length - 1 && !moreBtn.hidden) { loadMore(); return; }
    const next = cur < 0 ? 0 : (cur + d + rowNodes.length) % rowNodes.length;
    selKey = rowHits[next].key;
    userMoved = true;
    mark();
  }

  // ── 안내 ── 결과가 없다는 말은 목록 자리에, 색인·실패 같은 상태는 아래 줄에.
  /** 이 탭이 보이는 채널이 아직 오는 중인가(뜻 비슷은 빼고). */
  const tabWaiting = (): boolean => [...pending].some((x) => x !== 'sim' && (x === 'conv' ? kindShown('sess') : kindShown(x as Kind)));
  const tabLabel = (): string => OMNI_TABS.find((x) => x.key === tab)!.label;
  /** 다른 탭에는 몇 개 있나(자료 빼고) — 이 탭이 비었을 때 «전체에서 보기» 로 건넌다. */
  const otherCount = (): number => (tab === 'all' ? 0 : hits.filter((h) => !h.sim && isReal(h) && h.kind !== 'src' && !kindShown(h.kind)).length);
  const emptyWhy = (): string => {
    const why: string[] = [];
    if (tab !== 'all') why.push(otherCount() ? `«${tabLabel()}» 에는 없고 다른 종류에 있습니다.` : `«${tabLabel()}» 에서만 찾았습니다.`);
    else why.push('자료는 «자료» 탭을 눌러야 찾습니다.');
    if (period !== 'all') why.push(`${periodLabel(period)} 안의 결과만 봤습니다. 기간을 넓히면 더 나올 수 있습니다.`);
    return why.join(' ');
  };
  function refreshNote(): void {
    const q = input.value.trim();
    const parts: string[] = [];
    if (enterWant && (!settled || tabWaiting())) parts.push('결과가 다 오면 첫 줄을 엽니다…');
    //  명령 줄(«…로 새 세션» 등)은 결과가 아니다 — 그것만 있으면 «결과가 없습니다» 를 말한다.
    const real = rowHits.filter(isReal).length;
    const failNames = [...failedSrc].filter((x) => kindShown(x as Kind)).map((x) => KIND_LABEL[x as Kind] || x).join(' · ');
    if (failNames) parts.push(`${failNames} 결과를 가져오지 못했습니다. 잠시 뒤 다시 찾아 주세요.`);
    //  아직 오는 중이면 «없습니다» 가 아니라 «찾는 중» 이다 — 자료는 자리 잡기 상한(2.5초)보다 늦게 올 때가 있다(실측 2~4초).
    const waiting = settled && !!q && !real && !failNames && tabWaiting();
    const showNone = settled && !!q && !real && !failNames && !waiting;
    none.hidden = !(showNone || waiting);
    const other = showNone ? otherCount() : 0;
    none.replaceChildren(...(waiting ? [el('p', { text: `${tab === 'all' ? '' : tabLabel() + '에서 '}찾는 중입니다…` })]
      : showNone ? [el('b', { text: '결과가 없습니다' }), el('p', { text: emptyWhy() }),
        ...(other ? [el('button', { class: 'v2-omni-none-go', type: 'button', onclick: () => setTab('all') }, el('span', { text: `전체에서 ${fmtN(other)}개 보기` }))] : [])]
        : []));
    if (q && convLoosened.length && kindShown('sess') && rowHits.some((h) => h.tier === 'weak')) parts.push(`«${convLoosened.join('» · «')}» 은(는) 글자 그대로는 없어 비슷한 글자로 찾았습니다.`);
    if (q && convNoteText && kindShown('sess')) parts.push(convNoteText);
    if (q && simDegraded && kindShown('know')) parts.push('뜻이 비슷한 지식은 지금 가져오지 못했습니다.');
    note.hidden = !parts.length;
    note.replaceChildren(...(parts.length ? [el('span', { text: parts.join(' ') })] : []));
    moreBtn.hidden = !(settled && q && (truncated || (shownFull() && Math.min(50, 20 * moreFactor) < 50)));
  }
  /** 지금 탭에 보이는 채널 중 청한 만큼 꽉 채워 온 것이 있나(더 있을 수 있다). */
  const shownFull = (): boolean => [...fullSrc].some((x) => (x === 'conv' ? kindShown('sess') : kindShown(x as Kind)));

  /** 검색 기록 한 줄(#4530 검색 품질) — 무엇을 쳤고 무엇을 열었나(또는 안 열고 닫았나). 실패는 삼킨다(기록은 덤이다). */
  function sendLog(action: 'open' | 'close', h?: Hit, rank?: number): void {
    if (logged || !ranQuery) return;
    logged = true;
    const num = (k: string): number | null => (totals.has(k) ? (totals.get(k) as number) : null);
    const body = { q: ranQuery, tab, sort: sortMode, period, action, settle_ms: settleMs, loosened: convLoosened,
      counts: { sess: num('conv'), weak: totals.has('conv') ? convWeak : null, proj: num('proj'), know: num('know'), src: num('src') },
      opened: h ? { kind: h.kind, key: h.key, rank: rank || null, tier: h.tier || 'match' } : null };
    try { void api('/api/ui/v6/search-log', { method: 'POST', body: JSON.stringify(body), keepalive: true }).catch(() => { /* 기록은 덤이다 */ }); } catch { /* 같은 까닭 */ }
  }
  function go(i: number, mode: PvOpenMode): void {
    const h = rowHits[i];
    if (!h) return;
    if (h.run) { h.run(); return; }
    if (!h.href) return;
    const q = input.value.trim();
    if (q) { rememberQuery(q); lastQuery = { q, at: Date.now() }; }
    if (q && q === ranQuery) sendLog('open', h, i + 1);
    rememberOpened(h);
    //  곁칸에 고정 — 지식 문서만(위키 덧창의 [우측 사이드바에 고정]과 같은 문, lib/wiki-list pinGuest). 못 쓰면 그 자리에서 연다.
    if (mode === 'aside' && h.pv && h.pv.t === 'know' && canOpenInAside()) {
      const g = pinGuest(h.pv.name, h.title);
      omniClose({ restoreFocus: false });
      if (!openInAside({ key: g.key, title: g.title, url: embedUrl(g.hash), label: g.label, sticky: g.sticky })) hooks!.open(h.href, false, h.title);
      return;
    }
    omniClose({ restoreFocus: false });
    //  곁칸에 못 여는 종류의 Alt+Enter 는 새 탭이다(가이드 표기 «⌘·Ctrl·Alt+Enter = 새 화면»).
    hooks!.open(h.href, mode !== 'here', h.title);
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
          if (src === 'conv' && prev.kind === 'sess') {
            prev.role = h.role; prev.hits = h.hits; prev.edit = h.edit; prev.serverTop = h.serverTop;
            if (h.pv) prev.pv = h.pv;   // 대화 좌표는 서버가 준 것으로(셸 목록의 것과 다르면 미리보기가 404 다, 격리 리뷰)
            if (h.num) prev.num = h.num;
            //  이름으로 모든 낱말이 맞은 세션(셸 줄)은 맞는 결과다 — 서버가 대화만 보고 «덜 맞는다» 고 했어도 층·까닭을 옮겨 오지 않는다.
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
    if (settled) {
      //  자리 잡은 뒤 늦게 온 채널 — 제 자리에 끼운다(맨 위는 굳어 있다).
      rebuild(); paint();
      //  이 탭의 채널을 기다리던 Enter(자료 탭에 들어오자마자 누른 것) — 다 왔으면 첫 줄을 연다.
      if (enterWant && !tabWaiting()) {
        const w = enterWant; enterWant = null;
        const i = rowHits.findIndex((h) => h.key === selKey);
        if (rowHits.length) { go(i < 0 ? 0 : i, w.mode); return; }
      }
      refreshNote();
      if (!holdsSettle(pending)) bar.classList.remove('on');
    } else if (!holdsSettle(pending)) settle(mySeq);
  }
  function settle(mySeq: number): void {
    if (mySeq !== seq || box !== mine) return;
    window.clearTimeout(settleTimer);
    const first = !settled;
    settled = true;
    if (first && startAt && settleMs === null) settleMs = Math.max(0, Math.round(performance.now() - startAt));
    rebuild();
    if (first) { frozenTop.clear(); if (!userMoved) selKey = ''; }
    paint();   // 자리 잡은 뒤의 첫 그리기가 맨 위 셋을 굳힌다(topHits)
    list.classList.remove('stale');
    if (!holdsSettle(pending)) bar.classList.remove('on');   // 상한에 걸려 자리 잡았으면 아직 오는 채널이 있다 — 막대는 다 올 때까지
    refreshNote();
    if (enterWant) {
      const w = enterWant; enterWant = null;
      const i = rowHits.findIndex((h) => h.key === selKey);
      go(i < 0 ? 0 : i, w.mode);
    }
  }

  // ── 셸 목록에서(네트워크 0) ──
  function recentSessions(): Hit[] {
    const d = hooks!.data();
    return [...d.sessions].filter((s) => !isTrashedSess(s) && isMineSess(s)).sort((a, b) => b.lastSeen - a.lastSeen).map((s) => sessHit(d, s));
  }
  function sessHit(d: V2Data, s: Sess): Hit {
    const t = sessText(s, projName(d, s.projectId));
    const proj = s.projectId ? projName(d, s.projectId) : '';   // 프로젝트가 없으면 빈 칸 — «프로젝트 없음» 을 줄마다 되풀이하지 않는다
    return {
      kind: 'sess', key: 's:' + s.id, title: t.main || t.sub || s.id,
      sub: t.main && t.sub ? t.sub : '', meta: proj || undefined,
      href: '#/s/' + encodeURIComponent(s.id), at: s.lastSeen || undefined,
      context: isMineSess(s) ? undefined : ownerOf(s),
      pv: sessRef(s, proj),
    };
  }
  /** 세션의 대화 좌표(대화 uuid · 노드) — 접힌 기록(logId)이 없으면 터미널 행의 대화 id, 기록만 남은 행은 id 자체가 uuid 다(sess-tail 과 같은 규칙). */
  function sessRef(s: Sess, proj: string): PvRef {
    const raw = s.raw || {};
    return {
      t: 'sess', sid: String(s.logId || raw.claudeSessionId || raw.chatId || s.id), node: String((s.logNode ?? s.node) || ''),
      project: proj || undefined, owner: isMineSess(s) ? undefined : ownerOf(s),
      hint: sessText(s, proj).sub || undefined,
      ...(s.live && s.alive ? { stateKey: s.stateKey, stateLabel: s.stateLabel } : {}),
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
          pv: { t: 'proj' as const, id: Number(p.id) },
        })));
    }
    if (kindOn('app')) {
      const nq = q.toLowerCase();
      out.push(...visibleApps().filter((a) => appMatches(a, nq)).slice(0, 4)
        .map((a) => ({ kind: 'app' as const, key: 'a:' + a.key, title: a.title, sub: a.desc, href: appHref(a), label: '화면',
          pv: { t: 'text' as const, lines: [a.desc, '이 화면을 엽니다.'] } })));
      //  프로젝트 리스트 · 폴더(보드의 묶음) · 분류 — 이름으로(#4530: 종전엔 찾을 수 없었다).
      for (const l of (d.lists || []).filter((x) => matchAll(String(x.name || ''), terms)).slice(0, 4)) {
        out.push({ kind: 'app', key: 'l:' + l.id, title: String(l.name), sub: '프로젝트 리스트', href: '#/projects2/l/' + l.id, label: '리스트', pv: { t: 'list', id: Number(l.id) } });
      }
      for (const f of (d.folders || []).filter((x) => matchAll(String(x.name || ''), terms)).slice(0, 3)) {
        out.push({ kind: 'app', key: 'f:' + f.id, title: String(f.name), sub: '프로젝트 폴더', href: '#/projects2/f/' + f.id, label: '폴더', pv: { t: 'folder', id: Number(f.id) } });
      }
      //  분류 화면 주소는 **숫자 id** 를 받는다(taxonomy.ts catHref · side.ts 와 같은 문) — key 를 넣으면 «이 분류를 찾지 못했어요»(격리 리뷰).
      for (const c of categories.filter((x) => matchAllAcross([x.name, x.key], terms)).slice(0, 4)) {
        out.push({ kind: 'app', key: 'c:' + c.id, title: c.name, sub: c.desc ? cleanSnippet(c.desc, 80) : '', href: '#/taxonomy/' + encodeURIComponent(c.id), label: '분류', pv: { t: 'cat', id: c.id } });
      }
      if (hooks!.openMe) {
        for (const m of ME_TABS.filter((x) => matchAllAcross([x.title, x.aka], terms)).slice(0, 3)) {
          out.push({ kind: 'app', key: 'me:' + m.tab, title: m.title, sub: '[나] 창에서 엽니다', label: '설정',
            pv: { t: 'text', lines: [`[나] 창의 «${m.title}» 칸을 엽니다.`], act: '열기' },
            run: () => { omniClose({ restoreFocus: false }); hooks!.openMe!(m.tab); } });
        }
      }
      //  명령 — 찾는 것이 없을 때 바로 할 수 있는 일. 늘 맨 아래(시각이 없어 «바로 가기» 묶음).
      const short = q.length > 40 ? q.slice(0, 40) + '…' : q;
      if (q && hooks!.newSession) out.push({ kind: 'app', key: 'cmd:new-session', title: `«${short}» 로 새 세션 시작`, sub: '이 글을 첫 지시로 새 AI 세션을 엽니다', label: '명령',
        pv: { t: 'text', lines: ['찾는 것이 없으면 바로 시킬 수 있습니다.', `새 탭에 홈을 열고 입력칸에 «${short}» 를 넣어 둡니다. 보내기 전에 고칠 수 있습니다.`], act: '새 세션 시작' },
        run: () => { omniClose({ restoreFocus: false }); hooks!.newSession!(q); } });
      if (q) out.push({ kind: 'app', key: 'cmd:new-know', title: `«${short}» 제목으로 새 지식 쓰기`, sub: '새 지식 문서를 엽니다', label: '명령', href: '#/knowledge/new?title=' + encodeURIComponent(q),
        pv: { t: 'text', lines: [`제목이 «${short}» 인 새 지식 문서를 엽니다.`] } });
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
      pv: level === 'project' ? { t: 'proj', id: Number(p.id) } : { t: 'task', id: Number(p.id) },
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
      href: '#/k/' + encodeURIComponent(e.name), ident: String(e.name || ''), at: atOf(e.updated_at), order,
      pv: { t: 'know', name: String(e.name || '') }, ...extra,
    };
  };
  function convHit(r: any, order: number): Hit {
    const d = hooks!.data();
    const sid = String(r.session_id || '');
    const node = String(r.node_id || '');
    const s = findSessByConv(d.sessions, sid);
    const face = s ? sessText(s, projName(d, s.projectId)) : null;
    const best = (r && r.best) || null;
    const nums: number[] = Array.isArray(r && r.nums) ? r.nums.filter((n: unknown) => typeof n === 'number') : [];
    const proj = (s && s.projectId ? projName(d, s.projectId) : '') || String(r.project || '');
    return {
      meta: proj || undefined,
      pv: s ? { ...(sessRef(s, proj) as Extract<PvRef, { t: 'sess' }>), sid, node } : { t: 'sess', sid, node, project: proj || undefined },
      kind: 'sess', key: s ? 's:' + s.id : 'c:' + node + ':' + sid,
      title: (face && (face.main || face.sub)) || String(r.name || r.title || '이름 없는 세션'),
      //  맞은 말이 없는 줄(번호로 온 세션 · 뜻으로만 온 세션)은 첫 지시를 보여 무슨 세션인지 알린다.
      sub: best ? cleanSnippet(String(best.text || ''), 160) : (nums.length || typeof r.sem === 'number' ? cleanSnippet(String(r.title || ''), 160) : ''),
      ...(nums.length ? { num: String(nums[0]) } : {}),
      href: s ? '#/s/' + encodeURIComponent(s.id) : '#/sessions/' + encodeURIComponent(sid) + (node ? '?node=' + encodeURIComponent(node) : ''),
      at: atOf(r.at, best && best.ts), role: best ? (best.role === 'assistant' ? 'assistant' : 'user') : undefined,
      hits: Number(r.hits) || 1, edit: r.edit || null, serverTop: !!r.top, order,
      ...(r.tier === 'weak' ? { tier: 'weak' as const, why: weakWhy(r) } : {}),
    };
  }
  /** 덜 맞는 까닭 한마디 — 빠진 낱말 > 비슷한 글자로 찾음 > AI 가 스친 말. */
  function weakWhy(r: any): string {
    const q = (xs: unknown): string[] => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === 'string' && !!x) : []);
    const missing = q(r.missing), loose = q(r.loose), marks = q(r.marks);
    const parts: string[] = [];
    if (missing.length) parts.push(`«${missing.join('» · «')}» 없음`);
    if (loose.length) parts.push(marks.length ? `«${marks.join('» · «')}» (으)로 찾음` : '비슷한 글자로 찾음');
    //  글자로는 맞은 자리가 없고 뜻으로만 가까운 세션(서버가 세션 요약과 검색어의 뜻을 견줬다).
    if (!parts.length && typeof r.sem === 'number' && !(Array.isArray(r.fields) && r.fields.length)) return '뜻이 비슷함';
    return parts.join(' · ') || 'AI 가 잠깐 한 말';
  }

  // ── 검색 ──
  const lim = (n: number): string => String(Math.min(50, n * moreFactor));
  const full = (src: string, n: number, rows: unknown[]): void => { if (rows.length >= Math.min(50, n * moreFactor)) fullSrc.add(src); };
  const failOf = (src: string, my: number, signal: AbortSignal) => (e: any): void => {
    if (my !== seq || signal.aborted) return;
    if (src === 'conv') convNoteText = '대화 결과를 가져오지 못했습니다 — ' + failText(e) + '.';
    if (src === 'sim') simDegraded = true;
    if (src === 'proj' || src === 'know' || src === 'src') failedSrc.add(src);
    put(src, [], my);
  };
  /** 자료 채널 — 검색을 돌릴 때(자료 탭에서) 와 자료 탭에 처음 들어올 때(setTab) 가 같이 쓴다. */
  function fetchSrc(q: string, my: number, signal: AbortSignal): void {
    api(`/api/ui/sources?limit=${lim(20)}&q=` + encodeURIComponent(q), { signal }).then((r: any) => {
      if (my !== seq || signal.aborted) return;
      const rows: any[] = (r && r.entries) || [];
      full('src', 20, rows);
      if (r && typeof r.total === 'number' && !sinceMs) totals.set('src', r.total);
      put('src', rows.map((x: any, i: number) => ({
        kind: 'src' as const, key: 'src:' + x.id, title: String(x.title || ('자료 #' + x.id)),
        sub: '', meta: [SRC_SYS[String(x.external_system || '')] || SRC_SYS[String(x.kind || '')] || '', (x.fields && (x.fields.container_name || x.fields.repo)) ? String(x.fields.container_name || x.fields.repo) : ''].filter(Boolean).join(' · ') || '자료',
        href: '#/sources/' + x.id, at: atOf(x.occurred_at, x.updated_at), order: i,
        pv: { t: 'src' as const, id: String(x.id) },
      })), my);
    }, failOf('src', my, signal));
  }
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
    convNoteText = ''; simDegraded = false; failedSrc.clear(); fullSrc.clear();
    extraWords = []; convWeak = 0; convLoosened = []; settleMs = null;
    startAt = typedFresh ? typedAt : performance.now(); typedFresh = false;
    //  개수는 검색어와 기간에만 달려 있다 — «결과 더 보기»·정렬 바꾸기로 다시 돌 때는 받아 둔 것을 쓴다(서버 검색을 두 번 시키지 않는다).
    const countsKey = q + '\u0001' + period;
    //   받다가 끊긴 개수(바로 이어 «더 보기» 를 누른 때)는 받아 둔 것이 아니다 — 둘 다 와 있을 때만 건너뛴다.
    const askCounts = countsKey !== totalsFor || !(totals.has('proj') && totals.has('know'));
    if (askCounts) { totals.clear(); convCapped = false; totalsFor = countsKey; }
    frozenTop.clear();
    userMoved = false;
    enterWant = enterWant && q ? enterWant : null;
    buckets.clear();
    pending = new Set();
    if (!q) { hits = []; settled = true; list.classList.remove('stale'); bar.classList.remove('on'); paint(); refreshNote(); return; }
    buckets.set('local', localHits());
    const call = (src: string, k: Kind, fn: () => void): void => { if (kindOn(k)) { pending.add(src); fn(); } };
    const fail = (src: string) => failOf(src, my, signal);
    const qs = encodeURIComponent(q);
    call('conv', 'sess', () => {
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
        const rows: any[] = (r && r.results) || [];
        //  «더 있을 수 있다» 는 맞는 결과로만 잰다(덜 맞는 결과는 limit 밖에 따로 붙어 온다).
        full('conv', 20, rows.filter((x) => x && x.tier !== 'weak'));
        if (r && typeof r.total === 'number') { totals.set('conv', r.total); convCapped = !!r.capped; }
        convWeak = Number(r && r.weak) || 0;
        convLoosened = Array.isArray(r && r.loosened) ? r.loosened.filter((x: unknown) => typeof x === 'string') : [];
        //  비슷한 글자로 맞은 자리의 실제 글 — 친 글과 달라서 따로 칠한다(두 글자 이상만).
        extraWords = [...new Set(rows.flatMap((x) => (Array.isArray(x && x.marks) ? x.marks : [])).filter((m: unknown): m is string => typeof m === 'string' && [...m].length >= 2).map((m: string) => m.toLowerCase()))];
        put('conv', rows.map((x: any, i: number) => convHit(x, i)), my);
      }, fail('conv'));
    });
    call('proj', 'proj', () => {
      api(`/api/ui/v6/projects/search?plain=1&limit=${lim(20)}&q=` + qs, { signal })
        .then((r: any) => { full('proj', 20, (r && r.projects) || []); put('proj', ((r && r.projects) || []).map((p: any, i: number) => projRow(p, i)), my); }, fail('proj'));
    });
    call('know', 'know', () => {
      api(`/api/ui/knowledge/search?plain=1&limit=${lim(20)}&q=` + qs, { signal })
        .then((r: any) => { full('know', 20, (r && r.entries) || []); put('know', ((r && r.entries) || []).map((e: any, i: number) => knowRow(e, i)), my); }, fail('know'));
    });
    //  뜻만 비슷한 지식 — 맨 아래 묶음 전용. 글자로 이미 뜬 문서는 rebuild 가 겹치지 않게 뺀다(같은 열쇠).
    call('sim', 'know', () => {
      api(`/api/ui/knowledge/similar?limit=8&min_score=${SIM_MIN}&text=` + qs, { signal }).then((r: any) => {
        simDegraded = !!(r && r.degraded);
        put('sim', ((r && r.entries) || []).map((e: any, i: number) => knowRow(e, i, { sim: true, score: Number(e.similarity) || 0 })), my);
      }, fail('sim'));
    });
    call('src', 'src', () => fetchSrc(q, my, signal));
    //  종류마다 모두 몇 개인가 — 줄은 20개씩만 받으므로 따로 센다(실측 0.3~0.8초). 자리 잡기를 기다리게 하지 않고, 늦게 와도 탭의 숫자만 바뀐다.
    //   기간으로 좁혔을 때는 묻지 않는다(프로젝트·지식의 기간은 화면이 거른다 — 서버 개수와 다르다). 못 세면 받은 만큼만 센다.
    if (!sinceMs && askCounts) {
      for (const [src, url] of [['proj', '/api/ui/v6/projects/search?plain=1&mode=count&q='], ['know', '/api/ui/knowledge/search?plain=1&mode=count&q=']] as const) {
        api(url + qs, { signal }).then((r: any) => {
          if (my !== seq || signal.aborted || box !== mine || !r || typeof r.total !== 'number') return;
          totals.set(src, r.total);
          paintCounts();
        }, () => { /* 받은 만큼만 센다 */ });
      }
    }
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
    typedAt = performance.now(); typedFresh = true;
    logged = false;   // 검색어를 고쳐 치면 새 찾기다
    moreFactor = 1;
    closeSheet();   // 폰 — 다시 치기 시작하면 미리보기 판은 내린다
    if (!input.value.trim()) { run(true); return; }
    timer = window.setTimeout(() => run(), DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.isComposing) return;                       // 한글 조합 중 키는 입력기의 것이다
    //  Tab = 다음 종류 · Shift+Tab = 앞 종류(#4530 안 A). 입력칸에서만 — 다른 단추에 초점이 있으면 Tab 은 창 안을 돈다(아래).
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); setTab(nextTab(tab, e.shiftKey ? -1 : 1)); return; }
    //  Shift+↑↓ = 미리보기의 앞·다음 «맞은 말»(세션). 넘길 것이 없으면 평소대로 줄을 고른다.
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && e.shiftKey && pv.nav(e.key === 'ArrowDown' ? 1 : -1)) { e.preventDefault(); return; }
    //  ←→ = «최근 검색» 칩 사이(칩을 고르고 있을 때만 — 빈 칸이라 커서가 갈 곳이 없다).
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !input.value && moveChip(e.key === 'ArrowRight' ? 1 : -1)) { e.preventDefault(); return; }
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { e.preventDefault(); moveSel(1); }
    else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { e.preventDefault(); moveSel(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      //  Enter = 열기 · ⌘/Ctrl+Enter = 새 탭 · Alt+Enter = 곁칸에 고정(지식 문서 — 그 밖의 종류는 새 탭).
      const mode: PvOpenMode = e.altKey ? 'aside' : e.metaKey || e.ctrlKey ? 'tab' : 'here';
      //  결과가 지금 친 글의 것이 아니면(아직 안 돌렸거나 오는 중) 다 온 뒤의 줄을 연다 — 엉뚱한 것을 여는 것보다 잠깐 기다리는 게 낫다.
      if (input.value.trim() !== ranQuery) run();
      if (!settled) { enterWant = { mode }; refreshNote(); return; }
      //  자리 잡았어도 이 탭이 보일 채널이 아직 오는 중이고 세울 줄이 없으면(자료 탭 — 그 채널만 따로 묻는다) 기다린다.
      //   그냥 두면 Enter 가 조용히 버려진다(격리 리뷰).
      if (!rowHits.some(isReal) && tabWaiting()) { enterWant = { mode }; refreshNote(); return; }
      const i = rowHits.findIndex((h) => h.key === selKey);
      go(i < 0 ? 0 : i, mode);
    }
  });
  //  탭 줄 — ←→ 로 탭 · 기간 · 정렬을 오가고 ↓ 로 입력칸에 돌아온다(맨 위 줄에서 ↑ 로 올라온다, moveSel).
  filters.addEventListener('keydown', (e: KeyboardEvent) => {
    const btns: HTMLElement[] = [...OMNI_TABS.map((t) => tabBtns.get(t.key)!), periodBtn, sortBtn];
    const i = btns.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length].focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); input.focus(); }
  });
  //  Tab 은 창 안에서만 돈다(aria-modal 인데 뒤 화면으로 빠지던 것, #4530). 입력칸의 Tab 은 위에서 종류 넘기기로 받았으므로 여기는
  //   초점이 단추·링크에 있을 때다 — 켜지지 않은 탭(tabindex -1) · 보이지 않는 것(폰의 내려간 판)은 건너뛴다.
  box.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!box) return;
    //  단추에 초점이 있을 때 글자를 치면 입력칸으로 돌아가 그 글자가 들어간다(탭 줄에 올라갔다가 이어 치는 흐름).
    //   한글 입력기가 켜져 있으면 첫 keydown 의 key 가 글자가 아니라 'Process'(keyCode 229)다 — 그것도 입력칸으로 보낸다.
    const typing = (e.key.length === 1 && e.key !== ' ') || e.key === 'Process' || e.keyCode === 229;
    if (document.activeElement !== input && typing && !e.ctrlKey && !e.metaKey && !e.altKey) { input.focus(); return; }
    if (e.key !== 'Tab') return;
    const f = [...box.querySelectorAll<HTMLElement>('input, button:not([hidden]), a[href]')]
      .filter((x) => x.tabIndex >= 0 && x.getClientRects().length > 0 && getComputedStyle(x).visibility !== 'hidden');
    if (!f.length) return;
    const i = f.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
  });

  document.body.append(box);
  document.addEventListener('keydown', onEsc, true);
  onCloseTimers = () => {
    //  아무것도 안 열고 닫았다 — 결과가 자리 잡은 검색만 남긴다(치다 만 글자는 찾기가 아니다).
    if (settled && ranQuery) sendLog('close');
    window.clearTimeout(timer); window.clearTimeout(settleTimer); enterWant = null; pv.dispose();
  };
  onSheetEsc = () => { if (!card.classList.contains('sheet')) return false; closeSheet(); return true; };
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
  paintTabs();
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
  e.stopPropagation(); e.preventDefault();
  if (onSheetEsc && onSheetEsc()) return;
  omniClose();
}
export function omniClose(opts: { restoreFocus?: boolean } = {}): void {
  if (!box) return;
  inflight?.abort(); inflight = null;
  onCloseTimers?.(); onCloseTimers = null; onSheetEsc = null;
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

// v2/omni.ts — 통합검색(상민님 2026-08-20: "맥의 spotlight·클로드 데스크탑 검색처럼 지식·프로젝트·자료·세션이력 등
//  검색 가능한 자원이 전부 한 결과에 보이게. 웹에서도 쓸 수 있게").
//
//  ── 왜 한 칸인가 ──
//  자원마다 검색칸이 따로 있으면(위키 ⌘K · 사이드바 프로젝트 찾기 · 세션 질문 검색) 사람은 **찾기 전에 어디서 찾을지**를
//  먼저 정해야 한다. 그런데 기억에 남는 건 "그 얘기 어디서 봤더라"이지 "그건 지식이었나 자료였나"가 아니다.
//  그래서 입구를 하나로 두고, 무엇이었는지는 **결과가 말한다**(줄마다 종류 배지).
//
//  ── 구조: 팬아웃 + 흘려 그리기 ──
//  자원별 REST 를 **동시에** 부르고, 먼저 온 것부터 그 자리에 그린다(다 모아 기다리지 않는다). 채널 하나가 늦으면
//  (종전 세션 이력은 전 세션의 대화 파일을 훑어 늘 1초씩 늦었다) 그거 하나 때문에 지식·프로젝트 결과가 멈춰 서면 못 쓴다.
//  · 지식      GET /api/ui/knowledge/semantic  (임베딩 off 면 서버가 grep 으로 폴백)
//  · 프로젝트  GET /api/ui/v6/projects/semantic (같은 규약)
//  · 자료      GET /api/ui/sources?q=  → 결과는 자료 앱 상세(#/sources/<id>)로 연다
//  · 대화      GET /api/ui/v6/session-search  (#4517 — 볼 수 있는 세션의 사람 말·AI 말. 중앙 기록 색인)
//  · 세션·화면 셸이 이미 쥐고 있는 목록에서 즉시(네트워크 0) — 첫 글자에 바로 뭔가 보이는 건 이 둘이다.
//
//  ── 정렬 두 가지 (#4517, 원준 2026-09-30 «관련도 순으로만 나오니 최신순이 아예 안 된다 — 슬랙 참고해서») ──
//  관련도순(기본)과 최신순. 최신순은 모든 낱말이 맞은 것을 시각 역순으로 세우고, 맨 위에 «가장 맞는 결과» 3개를 얹는다
//  (슬랙 Top Results). 기간(오늘·최근 7일 …)으로 좁힐 수 있다. 규칙은 lib/omni-order.ts.
//  공개범위는 **전부 서버가 시행한다**(#1291) — 여기서 거르지 않는다.
//
//  ── 데스크톱/웹 공용 ──
//  이 파일은 셸(web/v2)의 일부라 브라우저에서 연 웹 UI 와 데스크톱 앱이 같은 코드를 쓴다. 데스크톱 전용 통로 없음.
import { api, el, sv } from '../core.js';
import { ICONS } from '../lib/icon-paths.js';   // #4233 선 아이콘 한 벌
import { appHref, visibleApps } from './apps.js';
import { appMatches } from '../lib/app-match.js';   // #4233 옛 이름으로도 찾는다(런치패드와 같은 잣대)
import { sessText } from './side.js';
import { projName, findSessByConv, type Sess, type V2Data } from './views.js';
import { showCtxMenu, ctxIsOpen, closeCtxMenu } from './ctx-menu.js';   // 기간 고르기 — 화면 어디서나 같은 메뉴 한 벌(#3784)
import {
  type OmniSort, type OmniPeriod, SORT_KEY, SORT_LABEL, readSort, PERIODS, periodLabel, periodSince, inPeriod,
  dayBucket, whenLabel, byRecent, atOf,
} from '../lib/omni-order.js';   // #4517 정렬·기간 규칙(순수)
import { projHitHref } from '../lib/proj-page.js';   // #3870 프로젝트 줄은 프로젝트 화면으로(사이드바 [→] 와 같은 문)

type Kind = 'proj' | 'know' | 'src' | 'sess' | 'conv' | 'app';

interface Hit {
  kind: Kind;
  key: string;        // 중복 제거 키
  title: string;
  sub: string;        // 두 번째 줄(스니펫·경로·시각)
  href: string;       // 셸 라우트
  /** 절대 코사인 유사도(0~1) — `similar` 채널만 준다. **채널을 가로질러 비교되는 유일한 축**이라 이걸로 정렬한다. */
  score?: number;
  /** 사람이 옮겨 적는 **식별자** — 지식은 key(name), 프로젝트는 번호(id). 제목엔 없지만 그걸로 찾는 사람이 있다. */
  ident?: string;
  /** 이 항목의 시각(ms) — 지식·프로젝트는 고친 때, 자료는 원래 날짜, 세션은 마지막 활동, 대화는 맞은 말 중 가장 늦은 것.
   *  최신순의 축이자 줄 오른쪽의 시각(#4517). 모르면 없다. */
  at?: number;
  /** 질의 낱말이 **글자로** 맞았나(grep·이름·대화) — 최신순에 세울 자격(슬랙 Recent 의 «match all terms»).
   *  의미검색(similar)만으로 온 것은 아니다 — 최신순에선 맨 위 «가장 맞는 결과» 로만 선다. */
  lex?: boolean;
  /** 대화 결과(#4517) — 대표로 보인 말이 누구의 말인가 · 이 세션에서 맞은 말 수. */
  role?: 'user' | 'assistant';
  hits?: number;
}

interface OmniHooks {
  data(): V2Data;
  /** 셸 이동 — newTab 이면 새 탭에서(탭 규칙은 셸이 안다).
   *  title 은 **클래식 딥링크(지식·자료)** 가 제 이름으로 탭에 앉게 하는 힌트다 — 안 주면 탭 이름이 'WIKI' 가 된다. */
  open(href: string, newTab: boolean, title?: string): void;
}

const GROUPS: Array<{ kind: Kind; label: string }> = [
  { kind: 'sess', label: '세션' },
  { kind: 'conv', label: '대화' },
  { kind: 'proj', label: '프로젝트' },
  { kind: 'know', label: '지식' },
  { kind: 'src', label: '자료' },
  { kind: 'app', label: '화면' },
];
const KIND_LABEL: Record<Kind, string> = { proj: '프로젝트', know: '지식', src: '자료', sess: '세션', conv: '대화', app: '화면' };
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

// ── 관련도 축 (2026-08-24 실측) ────────────────────────────────────────────────
//  `semantic` 이 주는 RRF 점수로는 못 가른다 — 순위역수라 채널마다 1등이 전부 1/61≈0.0164 로 동점이고,
//  질의에 따라 12항목의 점수 폭이 0.0012 까지 좁아진다. 그래서 종전엔 종류 고정순서로 늘어놓을 수밖에 없었고,
//  "왜 항상 프로젝트가 먼저 뜨냐"(상민님)가 거기서 나왔다.
//  `similar` 는 **절대 코사인(0~1)** 을 준다 — 랭크가 아니라 값이라 채널을 가로질러 비교되고, 컷오프가 선다.
//  dev 실측: 정답이 있는 질의는 0.50~0.70, 뜻 없는 질의('zxcvbnm')는 top 이 0.439 였다 → 그 사이를 끊는다.
//   세션이 안 열려요 0.657 · 릴리스 어떻게 해 0.631 · 디스크 가득 0.575 · 통합검색 0.502 | 외계어 0.439
//  컷오프는 **0.48** — 0.45 로 두면 뜻 없는 질의에도 2건이 새어 나왔다(실측 'zxcvbnm…' → 0.458·0.452).
const MIN_COSINE = 0.48;
//  ⚠ 짧은 제목은 코사인이 부풀려진다 — 임베딩이 몇 글자에 지배되기 때문. 실측에서 'ㅇㅇ'(0.522)·'ㄹㅇㄹㅁ'(0.526)·
//   '세션찾기'(0.695) 같은 이름들이 진짜 답 위로 올라왔다. 이름만으로 아무것도 말하지 않는 항목을 상위에 세울
//   근거가 없으므로 관련도순에서는 뺀다(종류별 묶음에는 그대로 남는다 — 정보를 버리지는 않는다).
//   제목이 질의를 통째로 담았으면(제목 적중) 예외다 — 그건 길이와 무관하게 확실한 신호다.
const MIN_TITLE_CHARS = 6;

// ── 이 조직에 '관련도 축'이 있는가 — **추론하지 말고 물어본다** ──────────────────────────────
//  이 값이 true 여야 아래의 '무관하면 접기' 가 발동한다. 처음엔 "similar 가 한 번이라도 결과를 준 적 있나"로
//  **추론**했는데, 그러면 **새 페이지의 첫 질의는 영영 억제되지 않는다** — 하필 그게 무관한 질의면 잡음이
//  그대로 뜬다(실측 2026-08-24: 뜻 없는 질의로 처음 열었더니 12건이 그대로). 관측의 순서에 답이 달라지는
//  판정은 판정이 아니다. 그래서 **min_score=0 으로 한 번 찔러 본다** — 그건 "가장 가까운 것 하나"를 뜻하므로
//  결과가 있으면 축이 살아 있는 것이고, 비어 있으면 임베딩이 꺼진 조직이다. 둘이 확실히 갈린다.
//  통합검색을 처음 열 때 한 번만 돌고, 페이지 수명 동안 기억한다.
let simAlive = false;
let axisProbed = false;
function probeAxis(): void {
  if (axisProbed) return;
  axisProbed = true;
  api('/api/ui/knowledge/similar?limit=1&min_score=0&text=lively').then(
    (r: any) => { if (((r && r.entries) || []).length) simAlive = true; },
    () => { /* 못 물어봤으면 모르는 채로 둔다 — 모르면 접지 않는다(있는 것을 숨기는 쪽이 더 나쁘다) */ },
  );
}

// ── 종류 필터 — 칩 하나 = 종류 하나, 누른 것만 켜진다 (2026-09-22 #4156, 상민·원준 회의) ─────────────
//  회의 신고: *"처음엔 다 꺼져 있고, 지식만 누르면 지식만 보이는 게 맞다."* 종전엔 **기본에서 주 축 칩 넷이 켜진
//  모습**으로 그려져, '지식' 을 누르면 나머지 셋이 꺼지는(=누른 것만 남는) 동작이 사람 눈에는 «누른 게 꺼졌다» 로
//  읽혔다. 거기에 자료·세션 이력은 반대로 «꺼진 채 누르면 켜지는» 칩이라, 한 줄에 규칙이 둘이었다.
//  → 규칙을 하나로 합친다(회의 대안 «자료·세션 이력은 기본으로 안 보여 주고 필요할 때 따로» 를 그대로 택했다):
//   · **아무것도 안 누름 = 기본 검색**. 칩은 전부 꺼진 모습이다. 찾는 범위는 세션·프로젝트·지식·화면(주 축).
//     자료·세션 이력은 기본 검색에 **들어가지 않는다** — 결과가 많고 덜 정제돼 잡음이 된다(#1960 에서 이미 기본 꺼짐).
//   · **칩을 누르면 그 종류만** 찾는다. 이어서 누르면 더해지고, 켜진 칩을 다시 누르면 빠진다.
//     자료·세션 이력도 **같은 규칙**이다 — '자료' 만 누르면 자료만 나온다.
//   · 켜진 게 없어지거나 주 축을 다 켠 상태(= 기본과 같은 결과)면 기본으로 접는다.
//  자료는 켜도 **아래 전용 묶음에만** 선다(관련도 축이 없다 — 관련도순엔 영영 안 선다, #1960).
//  ⚠ 선택은 페이지 수명이다(창을 닫았다 열어도 유지 · 새로고침하면 풀린다). 종전엔 보조 축 선택을 저장했지만,
//   이제 칩을 누르는 건 '더하기' 가 아니라 '좁히기' 라 저장하면 다음 검색이 **말없이 자료만** 찾게 된다.
//   칩이 늘 보이므로 왜 결과가 짧은지는 화면이 말한다.
//  ★ #4517 — «세션 이력»(내가 시킨 말) 칩을 **«대화»** 로 바꾸고 기본 검색에 넣었다(원준: «세션의 대화 내용으로도 세션을
//   찾고 싶어»). 종전 채널은 게이트웨이 디스크의 대화 파일을 훑어 매니지드에선 늘 0건이었고(2026-09-30 실측), 줄마다 말
//   한 마디라 잡음이 많아 기본에서 뺐었다. 이제는 중앙 기록 색인에서 찾고, 결과가 **세션 한 줄**(대표 발췌문 + 맞은 수)로
//   묶여 온다. 대화는 관련도순 맨 위 묶음에는 서지 않는다(점수 축이 다르다 — 아래 «대화» 묶음) · 최신순에선 시각 축으로 함께 선다.
const MAIN_KINDS: Kind[] = ['sess', 'conv', 'proj', 'know', 'app'];
const AUX_KINDS: Kind[] = ['src'];
const isAux = (k: Kind): boolean => AUX_KINDS.includes(k);
let kindSel = new Set<Kind>();
/** 이 종류를 지금 찾는가 — 빈 선택이면 주 축만, 고른 게 있으면 고른 것만. */
export function kindActive(sel: Set<Kind>, k: Kind): boolean {
  return sel.size === 0 ? !isAux(k) : sel.has(k);
}
const kindOn = (k: Kind): boolean => kindActive(kindSel, k);
/** 칩 하나를 눌렀을 때의 다음 상태 — 위 규칙을 한 곳에서만 구현한다(화면·테스트가 같은 것을 본다). */
export function nextKindSel(cur: Set<Kind>, k: Kind): Set<Kind> {
  const next = new Set(cur);
  if (next.has(k)) next.delete(k); else next.add(k);
  //  주 축만 다 켠 것 = 기본 검색과 결과가 같다 → 둘을 따로 기억할 이유가 없다.
  if (next.size === MAIN_KINDS.length && MAIN_KINDS.every((m) => next.has(m))) return new Set();
  return next;
}
//  종전(#1960)에 저장해 두던 보조 축 선택 — 이제 쓰지 않으니 남은 값을 걷는다(한 번 지우면 끝).
function dropLegacyAux(): void {
  try { localStorage.removeItem('lively.omni.aux'); } catch { /* 막힌 환경이면 남아도 해가 없다 */ }
}

// ── 식별자 적중 — 제목보다도 확실한 신호 (2026-08-25) ─────────────────────────────────
//  key(`omni-unified-search-spotlight-1835`)·번호(`1835`·`#1960`)로 찾는 사람이 있다. 서버는 이제 그걸 찾아
//  주는데(#336·#342) **화면이 버리고 있었다** — grep 채널을 제목 적중으로만 걸러서, key 는 title 이 아니라
//  name 에, 번호는 id 에 있으니 통째로 떨어져 나갔다(실측: key 로 치면 정답이 아예 안 떴다).
//  지목한 이름이 맞았으면 그건 검색이 아니라 **호명**이다 — 맨 위에 세운다.
//  · 번호는 **정확일치**(`183` 이 1835 를 잡으면 안 된다) · key 는 **부분일치**(`omni-unified` 로도 찾는다)
//  · 토큰이 둘 이상이면 지목이 아니라 검색이다(`1835 탭`) · `#` 은 사람 표기라 벗긴다
export type IdentKind = 'exact' | 'partial' | null;
export function identKind(ident: string | undefined, qTokens: string[]): IdentKind {
  if (!ident || qTokens.length !== 1) return null;
  const q = qTokens[0].replace(/^#/, '');
  if (!q) return null;
  const id = ident.toLowerCase();
  if (id === q) return 'exact';
  //  번호는 부분일치를 주지 않는다 — `183` 이 1835 를 잡으면 안 된다(idEquals 와 같은 규약).
  if (/^[0-9]+$/.test(id)) return null;
  return id.includes(q) ? 'partial' : null;
}
export function identHit(ident: string | undefined, qTokens: string[]): boolean {
  return identKind(ident, qTokens) !== null;
}

// ── 일치 부분 색칠 (2026-08-25 상민님) ────────────────────────────────────────
//  "왜 이 줄이 떴나"를 글자로 보여 준다. 스니펫이 잘려 있으면 매치가 어디였는지 알 길이 없었다.
//  정규식을 쓰지 않는다 — 질의에 `c++`·`(`·`.` 같은 글자가 들어오면 정규식은 깨지거나 엉뚱한 데를 칠한다.
//  겹치는 구간은 합쳐서 한 번만 칠한다(토큰 둘이 같은 자리를 덮을 때 조각이 잘게 쪼개지지 않게).
export function hlParts(text: string, qTokens: string[]): Array<{ t: string; hit: boolean }> {
  const s = String(text ?? '');
  if (!s) return [];
  const toks = qTokens.map((t) => t.replace(/^#/, '')).filter((t) => t.length > 0);
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

// ── 한 줄로 줄이기 ── 스니펫은 `L12: …` 꼴로 오고 줄바꿈이 섞여 있다. 목록은 한 줄이 한 결과여야 훑을 수 있다.
function oneLine(s: string, max = 96): string {
  const t = String(s || '').replace(/^L\d+:\s?/gm, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t;
}
function snippetOf(e: any): string {
  const raw = Array.isArray(e?.snippets) ? e.snippets.join(' ') : (e?.snippet || e?.excerpt || e?.description || '');
  return oneLine(raw);
}

// ════════════════════════════════════════════
// 오버레이 — 한 번에 하나. Esc·바깥클릭으로 닫힌다.
// ════════════════════════════════════════════
let box: HTMLElement | null = null;
//  대화 채널의 진행 중 요청 — 글자를 더 치거나 창을 닫으면 끊는다(#4517). 늦게 온 응답이 화면을 덮지 않고 브라우저 연결을 놓는다.
//   ⚠ 서버의 SQL 까지 끊기지는 않는다 — 서버 쪽 경계는 검색 한 번의 시간 상한(4초, CONV_QUERY_TIMEOUT_MS)이다.
let convAbort: AbortController | null = null;
// ── 정렬·기간 상태 (#4517) ──
//  정렬은 **저장한다**(취향 — 다음에 열어도 같은 순서), 기간은 **페이지 수명**(좁히기 — 저장하면 다음 검색이 말없이 좁아진다,
//  종류 칩과 같은 규칙 #4156). 저장소가 막힌 환경(사파리 프라이빗)이면 이번 페이지에서만 기억한다.
let sortMode: OmniSort | null = null;
let period: OmniPeriod = 'all';
function loadSort(): OmniSort {
  try { return readSort(localStorage.getItem(SORT_KEY)); } catch { return 'rel'; }
}
function saveSort(m: OmniSort): void {
  try { localStorage.setItem(SORT_KEY, m); } catch { /* 막힌 저장소 — 이번 페이지에서만 */ }
}

export function omniOpen(seed?: string): void {
  if (box) { const i = box.querySelector('.v2-omni-in') as HTMLInputElement | null; i?.focus(); i?.select(); return; }
  if (!hooks) return;
  probeAxis();
  dropLegacyAux();
  if (sortMode === null) sortMode = loadSort();

  const input = el('input', {
    class: 'v2-omni-in', type: 'text', spellcheck: 'false', autocomplete: 'off',
    //  안내 문구는 **기본으로 찾는 것**만 적는다 — 자료는 켜야 들어오므로 여기 적으면 거짓말이 된다.
    placeholder: '무엇이든 찾기 — 지식 · 프로젝트 · 세션 · 대화 · 화면',
    'aria-label': '통합검색', 'aria-controls': 'v2-omni-list',
  }) as HTMLInputElement;
  const list = el('div', { class: 'v2-omni-list', id: 'v2-omni-list', role: 'listbox' });
  //  종류 칩 — 각 종류에 버튼 하나. 눌리면 위 nextKindSel 규칙대로 상태가 바뀌고 **즉시 다시 찾는다**
  //  (꺼진 종류는 아예 부르지 않으므로 오히려 빨라진다).
  //  칩 줄 = 종류(무엇을) 묶음 + 정렬·기간(어떤 순서로 · 언제) 묶음. 묶음마다 이름을 따로 단다 — 한 묶음 이름(«종류 필터»)
  //   아래에 정렬·기간 단추가 들어가 있으면 화면 낭독기가 그 단추를 «종류» 로 읽는다(#4517 리뷰).
  const chips = el('span', { class: 'v2-omni-kinds', role: 'group', 'aria-label': '종류 필터' });
  const filters = el('div', { class: 'v2-omni-filters' }, chips);
  function chip(k: Kind): HTMLElement {
    const picked = kindSel.has(k);     // 켜진 모습 = **사람이 누른 것**뿐이다(기본 검색에선 전부 꺼진 모습)
    //  제목(툴팁)이 **누르면 무슨 일이 일어나는지**를 말한다.
    const tip = picked ? `${KIND_LABEL[k]} 빼기`
      : kindSel.size === 0 ? `${KIND_LABEL[k]}만 보기` + (isAux(k) ? ' (기본 검색에는 들어가지 않습니다)' : '')
      : `${KIND_LABEL[k]} 더하기`;
    return el('button', {
      class: 'v2-omni-chip' + (picked ? ' on' : '') + (isAux(k) ? ' aux' : ''), type: 'button',
      'aria-pressed': String(picked), title: tip,
      onclick: () => { kindSel = nextKindSel(kindSel, k); paintChips(); run(); },
    }, icon(k, 'v2-omni-chip-ic'), el('span', { text: KIND_LABEL[k] })) as HTMLElement;
  }
  // ── 정렬 · 기간 (#4517) — 칩 줄 오른쪽 끝. 슬랙 검색의 «정렬» 과 «날짜» 자리다. ──
  //  정렬은 두 값뿐이라 드롭다운이 아니라 **나란한 두 단추**다 — 지금 어느 순서인지가 늘 보이고 한 번에 바뀐다.
  //  단추는 한 번만 만들고 켜짐 표시만 바꾼다 — 다시 만들면 키보드 초점이 날아간다(#4517 리뷰).
  const sortBtns = (['rel', 'recent'] as OmniSort[]).map((m) => el('button', {
    type: 'button', class: 'v2-omni-segb', 'data-sort': m,
    title: m === 'rel' ? '가장 잘 맞는 것부터 보여 줍니다' : '최근 것부터 보여 줍니다 — 맨 위에 가장 맞는 결과 3개를 먼저 둡니다',
    onclick: () => { if (sortMode === m) return; sortMode = m; saveSort(m); paintSort(); run(); },
  }, el('span', { text: SORT_LABEL[m] })) as HTMLButtonElement);
  const sortSeg = el('div', { class: 'v2-omni-seg' }, ...sortBtns);
  function paintSort(): void {
    for (const b of sortBtns) { const on = b.dataset.sort === sortMode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
  }
  //  기간은 메뉴를 여는 단추다 — 눌림(aria-pressed)이 아니라 펼침(aria-expanded)을 말한다. 고른 기간은 단추 글자가 말한다.
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
      run: () => { if (period === p.key) return; period = p.key; paintPeriod(); run(); },
    })), { minWidth: 150, onClose: () => { periodBtn.setAttribute('aria-expanded', 'false'); if (box) input.focus(); } });
  }
  const tools = el('span', { class: 'v2-omni-tools', role: 'group', 'aria-label': '정렬과 기간' }, sortSeg, periodBtn);
  filters.append(tools);
  function paintChips(): void {
    //  자료는 **오른쪽에 따로** 세운다(구분선) — 누르는 규칙은 같지만, 기본 검색에 안 들어가는 종류임이 보이게.
    chips.replaceChildren(
      ...MAIN_KINDS.map(chip),
      el('span', { class: 'v2-omni-chipsep', 'aria-hidden': 'true' }),
      ...AUX_KINDS.map(chip),
    );
  }
  const note = el('div', { class: 'v2-omni-note' });

  box = el('div', {
    class: 'v2-omni', role: 'dialog', 'aria-modal': 'true', 'aria-label': '통합검색',
    onmousedown: (e: MouseEvent) => { if (e.target === box) omniClose(); },
  },
    el('div', { class: 'v2-omni-card' },
      el('div', { class: 'v2-omni-top' },
        sv('svg', { viewBox: '0 0 24 24', class: 'v2-omni-lens', 'aria-hidden': 'true' },
          sv('circle', { cx: '11', cy: '11', r: '6.5' }), sv('path', { d: 'M16 16l4.5 4.5' })),
        input,
        el('kbd', { class: 'v2-omni-esc', text: 'Esc' })),
      filters, list, note)) as HTMLElement;

  // ── 상태 ──
  //  결과는 **소스별로** 담는다(한 종류에 소스가 둘일 수 있다 — 지식·프로젝트는 의미검색 + grep).
  //  화면에 그릴 목록(hits)은 그때그때 buckets 에서 다시 만든다(rebuild) — 소스 하나가 늦게 와도 나머지가 안 지워진다.
  const buckets = new Map<string, Hit[]>();
  let hits: Hit[] = [];
  let sel = 0;
  let seq = 0;                      // 늦게 온 응답 무시
  let pending = 0;                  // 아직 안 온 원본 수(안내 문구용)
  let timer = 0;
  let qTokens: string[] = [];       // 지금 질의의 토큰(제목 적중 판정용)
  let sinceMs = 0;                  // 기간의 시작(ms) — 0 = 전체 기간
  let convPending: number | null = 0;   // 대화 색인이 아직 밀린 세션 수(서버가 알려 준다, 모르면 null) — 0 이 아니면 «못 찾을 수 있다» 를 말한다
  let convCapped = false;           // 대화 검색이 흔한 낱말로 상한에 걸렸나
  let convFailed = '';              // 대화 채널이 실패했다(시간 초과 등) — «결과 없음» 과 다른 사실이라 따로 말한다
  let convSkipped = false;          // 검색어가 길어(200자 넘음) 대화 채널을 부르지 않았다

  const rowNodes: HTMLElement[] = [];
  //  ⚠ **그려진 줄과 짝을 이루는 배열**. rowNodes 의 i 번째가 무엇인지는 이것만 안다 —
  //   `hits` 는 병합·중복제거 순서라 화면 순서와 다르고(관련도순이 앞으로 끌어올리고, 종류별 묶음은
  //   이미 나온 것을 빼므로), `hits[i]` 로 열면 **엉뚱한 줄이 열린다**
  //   (상민님 2026-08-25 신고: "1835 치면 3번째 프로젝트를 눌렀는데 그 위 지식으로 넘어간다").
  const rowHits: Hit[] = [];
  /** 제목이 질의를 통째로 담고 있나 — **종류와 무관하게** 맨 위로 올릴 근거(2026-08-20 실측 뒤 도입).
   *  왜 필요한가: 채널 간 순서가 타입 고정이라 '정확히 그 이름인 문서'가 프로젝트 6건 아래 묻혔다. 게다가
   *  하이브리드(RRF)는 순위역수라 채널마다 1등이 전부 같은 점수(1/61≈0.0164)가 되어 **점수로는 못 가른다**
   *  (실측: 질의에 따라 12항목의 점수 폭이 0.0012 까지 좁아진다). 제목 적중은 그 애매함이 없는 유일한 신호다. */
  const identOf = (h: Hit): IdentKind => identKind(h.ident, qTokens);
  const isIdentHit = (h: Hit): boolean => identOf(h) !== null;
  const identRank = (h: Hit): number => { const k = identOf(h); return k === 'exact' ? 0 : k === 'partial' ? 1 : 2; };
  function isTitleHit(h: Hit): boolean {
    if (!qTokens.length) return false;
    const t = h.title.toLowerCase();
    return qTokens.every((tok) => t.includes(tok));
  }
  /** 작을수록 '그 이름다운' 제목 — 질의가 놓인 위치 + 제목 길이. */
  function titleRank(h: Hit): number {
    const t = h.title.toLowerCase();
    const at = qTokens.length ? t.indexOf(qTokens[0]) : -1;
    return (at < 0 ? 999 : at) * 10 + Math.min(99, h.title.length);
  }
  /** 글자를 조각내 일치 부분만 <mark> 로. HTML 을 만들지 않는다 — 전부 텍스트 노드라 주입이 원천적으로 없다. */
  const hl = (text: string): Node[] => hlParts(text, qTokens).map((p) =>
    (p.hit ? el('mark', { class: 'v2-omni-hl', text: p.t }) : document.createTextNode(p.t)) as Node);
  /** 둘째 줄 — **비워 두지 않는다**. similar 응답엔 스니펫이 없어서(실측) 관련도순 상위가 제목만 덩그러니 남았다.
   *  key 로 찾았으면 **그 key 를 보여 준다** — 내가 친 것과 화면이 이어져야 '이게 그건가'를 다시 안 묻는다.
   *  대화 결과(#4517)는 **누구의 말인가**(지시 · AI)를 앞에 달고 맞은 말 발췌문을 보인다 — 이름에 없는 낱말로 왜 이 세션이
   *  떴는지는 그 발췌문만이 말한다. 맞은 말이 여럿이면 몇 개인지도. */
  function subLine(h: Hit): HTMLElement | null {
    const kind = identOf(h);
    const bits: Node[] = [];
    if (h.kind === 'conv' && h.role) bits.push(el('span', { class: 'v2-omni-role', text: h.role === 'user' ? '지시' : 'AI' }));
    if (kind && h.ident) {
      const isNum = /^[0-9]+$/.test(h.ident);
      bits.push(el('code', { class: 'v2-omni-key' + (kind === 'exact' ? ' exact' : '') }, ...hl(isNum ? '#' + h.ident : h.ident)));
    }
    if (h.sub) { if (bits.length && !(h.kind === 'conv' && bits.length === 1)) bits.push(document.createTextNode(' · ')); bits.push(...hl(h.sub)); }
    if (h.kind === 'conv' && (h.hits || 0) > 1) bits.push(document.createTextNode(` · 맞은 말 ${h.hits}개`));
    if (!bits.length && h.ident) bits.push(el('code', { class: 'v2-omni-key' }, ...hl(/^[0-9]+$/.test(h.ident) ? '#' + h.ident : h.ident)));
    return bits.length ? el('span', { class: 'v2-omni-s' }, ...bits) : null;
  }
  /** 관련도순 맨 위 묶음 — 종류를 가로질러 가장 맞는 것(최신순에선 앞 셋이 «가장 맞는 결과»). 순서 규칙은 아래 주석 그대로. */
  function relTop(): Hit[] {
    // ── 관련도순 — 상민님 "가장 정확도 높은 게 먼저 뜨는 게 맞지 않아?" (2026-08-24) ─────────────
    //  들어가는 것: **제목이 그대로 맞은 것**(모든 채널) + **절대 코사인이 컷오프를 넘은 것**(지식·프로젝트).
    //  순서: 제목 적중이 먼저(그보다 확실한 신호가 없다) — 그 안은 '얼마나 그 이름다운가'(질의 위치 + 제목 길이,
    //   실측: '통합검색' 에서 정답보다 '…그리드 통합검색' 이 먼저 뜨던 것). 나머지는 코사인 내림차순.
    //  ⚠ 자료는 **한 줄도 오지 않는다**(2026-08-25). 자료엔 이 축이 없고(ILIKE), 종전엔 '제목이 맞으면' 예외로 끼워
    //   줬는데 그게 정확히 회의록이 위를 먹던 경로였다 — 긴 전사에는 어지간한 단어가 다 들어 있어 제목 적중이 쉽게 난다.
    //   축이 없는 것은 순위에 세우지 않는다(전용 묶음에만). 대화(#4517)도 같다 — 점수가 대화끼리만 비교되는 값이다.
    const meaty = (h: Hit): boolean => isIdentHit(h) || isTitleHit(h) || h.title.replace(/[^\p{L}\p{N}]/gu, '').length >= MIN_TITLE_CHARS;
    return hits.filter((h) => !isAux(h.kind) && h.kind !== 'conv' && (isIdentHit(h) || isTitleHit(h) || typeof h.score === 'number') && meaty(h))
      .sort((a, b) => {
        //  **정확히 그 이름/번호인 것**이 먼저다(상민님 2026-08-25). 종전엔 정확·부분을 한 티어로 묶어서,
        //  `1835` 로 치면 key 에 1835 가 든 지식 2건이 먼저 서고 정작 **번호가 맞는 프로젝트가 3위**로 밀렸다.
        const ra = identRank(a), rb = identRank(b);
        if (ra !== rb) return ra - rb;                        // 0=정확 · 1=부분 · 2=아님
        const ta = isTitleHit(a) ? 1 : 0, tb = isTitleHit(b) ? 1 : 0;
        if (ta !== tb) return tb - ta;
        // 점수가 있으면 점수가 먼저다 — 제목 적중끼리도 그렇다. 화면에 0.585 가 0.632 위에 서면 '관련도순'이 거짓말이 된다.
        const sa = a.score, sb = b.score;
        if (typeof sa === 'number' && typeof sb === 'number' && sa !== sb) return sb - sa;
        if (ta) return titleRank(a) - titleRank(b);
        return (sb || 0) - (sa || 0);
      });
  }
  function paint(): void {
    rowNodes.length = 0;
    rowHits.length = 0;
    const kids: HTMLElement[] = [];
    const now = Date.now();
    const draw = (label: string, rows: Hit[]): void => {
      if (!rows.length) return;
      kids.push(el('div', { class: 'v2-omni-gh', text: label }));
      for (const h of rows) {
        const i = rowNodes.length;
        //  시각 — 슬랙처럼 줄마다 단다(정렬과 무관하게). 무엇이 최근 것인지가 늘 보여야 순서를 믿는다.
        const when = typeof h.at === 'number' ? whenLabel(h.at, now) : '';
        const node = el('div', {
          class: 'v2-omni-row', role: 'option', 'aria-selected': 'false', title: h.title + (h.sub ? ' — ' + h.sub : ''),
          onmousemove: () => { if (sel !== i) { sel = i; mark(); } },
          onclick: (e: MouseEvent) => go(i, e.metaKey || e.ctrlKey || e.altKey),
        },
          el('span', { class: 'v2-omni-ic' }, icon(h.kind, 'v2-omni-kic')),
          el('span', { class: 'v2-omni-tt' },
            el('b', { class: 'v2-omni-t' }, ...hl(h.title)),
            subLine(h)),
          when ? el('span', { class: 'v2-omni-when', text: when, title: new Date(h.at as number).toLocaleString('ko-KR') }) : null,
          el('span', { class: 'v2-omni-badge', text: KIND_LABEL[h.kind] })) as HTMLElement;
        rowNodes.push(node);
        rowHits.push(h);
        kids.push(node);
      }
    };
    if (sortMode === 'recent' && qTokens.length) {
      // ── 최신순(#4517) — 슬랙 «Recent» + «Top Results» ──────────────────────────────────────
      //  맨 위에 관련도순 앞 셋(«가장 맞는 결과») — 이름·번호로 부른 것(호명)이 최신순에서도 첫 줄에 선다.
      //  그 아래는 **글자로 맞은 것 전부**(lex)를 시각 역순으로, 날짜 묶음으로 끊어서. 의미검색만으로 온 것은 여기 안 선다 —
      //   «최근에 고친, 조금 비슷한 문서» 가 정확히 그 낱말이 든 문서를 밀어내면 최신순이 아니라 잡음이다(슬랙 Recent 도 모든 낱말 일치).
      //  화면(앱)은 시각이 없어 맨 아래 따로.
      const best = relTop().slice(0, 3);
      const bestKeys = new Set(best.map((h) => h.key));
      draw('가장 맞는 결과', best);
      const timeline = hits.filter((h) => h.kind !== 'app' && !bestKeys.has(h.key) && (h.lex || isTitleHit(h) || isIdentHit(h)))
        .sort(byRecent).slice(0, 60);
      let bucket = '';
      let group: Hit[] = [];
      for (const h of timeline) {
        const b = dayBucket(h.at, now);
        if (b !== bucket) { draw(bucket, group); group = []; bucket = b; }
        group.push(h);
      }
      draw(bucket, group);
      draw('화면', hits.filter((h) => h.kind === 'app' && !bestKeys.has(h.key)));
    } else {
      const top = relTop().slice(0, 10);
      const topKeys = new Set(top.map((h) => h.key));
      // ── 축이 '무관' 이라고 말하면 그 종류를 통째로 접는다 (2026-08-24 화면 실측) ──────────────
      //  관련도순만 고쳐 놓고 끝낼 뻔했다: 뜻 없는 질의('zxcvbnm…')에 관련도순은 0건인데 **그 아래 '프로젝트'
      //  묶음에 무관한 6건이 그대로 떴다.** semantic(RRF)은 컷오프가 없어 무엇을 물어도 채널마다 6건을 채우기
      //  때문이다 — 그래서 "결과가 없습니다" 가 화면에 나올 수가 없었다.
      //  지식·프로젝트는 **무관을 판정할 수단(절대 코사인)이 있다.** 그 판정이 '없음'이면 RRF 가 채운 것도 잡음이다.
      //  ⚠ 단, 임베딩이 꺼진 조직에서는 similar 가 늘 빈 결과다 — 그때 접으면 지식·프로젝트가 통째로 사라진다.
      //   그래서 **이 창에서 similar 가 한 번이라도 결과를 준 적이 있을 때만** 접는다(축이 살아 있다는 증거).
      //  축이 살아 있고 그 채널이 **답을 했으면**, 그 종류는 관련도순이 유일한 창구다.
      //  남는 것(코사인 컷오프 아래 + 제목도 안 맞음)은 RRF 가 채운 것뿐이고, 그건 무엇을 물어도 6건씩 나온다 —
      //  실측: '세션이 안 열려요' 의 관련도순 8건 아래에 무관한 프로젝트 11건이 더 붙어 있었다.
      //  아직 답이 안 온 채널은 건드리지 않는다(흘려 그리는 중에 목록이 사라지면 안 된다).
      const muted = new Set<Kind>();
      if (simAlive) {
        for (const [kind, src] of [['know', 'know:sim'], ['proj', 'proj:sim']] as Array<[Kind, string]>) {
          if (buckets.has(src)) muted.add(kind);
        }
      }
      // 위에 세운 것은 아래 종류별 묶음에서 뺀다 — 같은 줄이 두 번 뜨지 않게(배지가 종류를 말한다).
      draw('관련도순', top);
      for (const g of GROUPS) {
        if (muted.has(g.kind)) continue;
        draw(g.label, hits.filter((h) => h.kind === g.kind && !topKeys.has(h.key)));
      }
    }
    list.replaceChildren(...kids);
    if (sel >= rowNodes.length) sel = Math.max(0, rowNodes.length - 1);
    mark();
  }
  function mark(): void {
    rowNodes.forEach((n, i) => { const on = i === sel; n.classList.toggle('on', on); n.setAttribute('aria-selected', String(on)); });
    rowNodes[sel]?.scrollIntoView({ block: 'nearest' });
  }
  // ⚠ replaceChildren 은 null 을 글자 "null" 로 그린다(el() 과 다르다) — 빈 상태는 자식을 아예 두지 않는다.
  //  결과가 없을 때 **왜 없는지**를 화면이 말한다 — 자료를 찾는 사람에게 그냥 '결과가 없습니다'는 거짓말에 가깝다
  //  (그 채널을 아예 안 불렀으니까).
  const emptyNote = (): string => {
    const why: string[] = [];
    //  기본 검색이면 자료는 **부르지도 않았다** — 그걸 말하지 않으면 '없다' 가 거짓말이 된다.
    why.push(kindSel.size > 0 ? '고른 종류에서만 찾았습니다 — 칩을 다시 누르면 풀립니다' : '자료는 기본 검색에 들어가지 않습니다 — 위 칩을 누르면 찾습니다');
    //  «그 기간 안을 빠짐없이 봤다» 고 말하지 않는다 — 의미검색 채널은 상위 몇 건을 받은 뒤 기간으로 거른다.
    if (period !== 'all') why.push(`${periodLabel(period)} 안의 결과만 보여 줍니다 — 기간을 넓히면 더 나올 수 있습니다`);
    return `결과가 없습니다. (${why.join(' · ')})`;
  };
  //  대화 색인이 아직 밀려 있으면 그 사실을 말한다 — 결과가 있어도 «이게 전부» 로 읽히면 안 된다(초록불 자가점검).
  const convNote = (): string => {
    if (!kindOn('conv')) return '';
    if (convSkipped) return '검색어가 길어(200자 넘음) 대화에서는 찾지 않았습니다.';
    if (convFailed) return `대화 결과를 가져오지 못했습니다 — ${convFailed}`;
    if (convPending === null) return '대화 색인이 어디까지 됐는지 확인하지 못했습니다 — 최근 대화는 아직 찾지 못할 수 있습니다.';
    if (convPending) return `대화 색인을 만드는 중입니다 — 세션 ${convPending}개의 대화는 아직 찾지 못할 수 있습니다.`;
    if (convCapped) return '흔한 낱말이라 최근 말 2,000개 안에서만 찾았습니다 — 낱말을 더 넣으면 좁혀집니다.';
    return '';
  };
  function setNote(text: string): void {
    note.hidden = !text;
    if (text) note.replaceChildren(el('span', { text })); else note.replaceChildren();
  }
  function finalNote(): string {
    const extra = convNote();
    if (rowNodes.length) return extra;
    return extra ? emptyNote() + ' ' + extra : emptyNote();
  }

  function go(i: number, newTab: boolean): void {
    const h = rowHits[i];
    if (!h) return;
    omniClose();
    hooks!.open(h.href, newTab, h.title);
  }

  // ── 검색 ── 소스마다 따로 돌고, 도착하는 대로 그 소스 칸만 갈아 끼운 뒤 목록을 다시 만든다.
  //  소스 순서 = 같은 항목이 두 소스에서 오면 **먼저 온 쪽의 표현**(스니펫)을 쓴다는 뜻이다. 의미검색을 앞에 두어
  //  종전 순서를 지키고, grep 은 **의미검색이 놓친 것을 뒤에 보탠다**(그 중 제목 적중은 위 '가장 맞는 것'이 끌어올린다).
  //  ⚠ similar(절대 코사인)를 **먼저** 둔다 — 같은 항목이 두 소스에서 오면 먼저 온 쪽이 남는데, 점수를 가진 쪽이
  //   남아야 관련도순에 설 수 있다(뒤에 두면 점수 없는 사본이 먼저 잡혀 그 줄이 순위에서 빠진다).
  const SRC_ORDER = ['know:sim', 'proj:sim', 'local', 'know:sem', 'know:grep', 'proj:sem', 'proj:grep', 'conv', 'src'];
  function rebuild(): void {
    const seen = new Set<string>();
    const byKey = new Map<string, Hit>();
    hits = [];
    for (const src of SRC_ORDER) {
      for (const h of buckets.get(src) || []) {
        //  같은 항목(key)이 다른 소스에서 또 오면 **빈 칸만 채운다**(#4517) — 의미검색 사본엔 «글자로 맞았나»(lex)가 없고,
        //   셸 목록 사본엔 시각이 없을 수 있다. 먼저 온 표현(점수·스니펫)은 그대로 두고 모자란 것만 보탠다.
        const prev = byKey.get(h.key);
        if (prev) {
          if (prev.at === undefined && h.at !== undefined) prev.at = h.at;
          if (h.lex) prev.lex = true;
          if (typeof prev.score !== 'number' && typeof h.score === 'number') prev.score = h.score;
          continue;
        }
        // 같은 것으로 치는 기준 셋 — ⓐ같은 항목(key) ⓑ**같은 곳으로 가는 줄**(href) ⓒ같은 종류의 같은 이름.
        //  ⓑ·ⓒ 가 없으면 같은 줄이 두 번 뜬다(실측 2026-08-24 'tmux': 1·2위가 글자 그대로 같은 제목이었다) —
        //  소스가 둘이고(의미검색·grep) 프로젝트/태스크가 이름을 공유할 때 생긴다. 먼저 온 쪽(더 높은 순위)이 남는다.
        //  대화 결과가 이름으로 이미 뜬 세션과 같은 곳으로 가면 ⓑ 로 빠진다 — 이름으로 부른 것이 먼저다.
        const ids = [h.key, 'href:' + h.href, 'name:' + h.kind + '|' + h.title.trim().toLowerCase()];
        if (ids.some((k) => seen.has(k))) continue;
        for (const k of ids) seen.add(k);
        const copy = { ...h };   // 소스 칸의 원본은 그대로 둔다(다시 만들 때마다 같은 결과)
        byKey.set(h.key, copy);
        hits.push(copy);
      }
    }
  }
  function put(src: string, rows: Hit[], mySeq: number): void {
    if (mySeq !== seq || !box) return;
    if (rows.length && src.endsWith(':sim')) simAlive = true;
    //  기간(#4517) — 서버가 기간을 모르는 채널(지식·프로젝트·자료)은 여기서 거른다. 글자 검색 채널은 최신순으로 오므로
    //   기간 안의 것이 앞에 모여 있다(넉넉히 받아 거르면 그 앞부분이 곧 답이다). 시각을 모르는 줄은 기간을 고르면 뺀다.
    buckets.set(src, sinceMs ? rows.filter((h) => inPeriod(h.at, sinceMs)) : rows);
    pending = Math.max(0, pending - 1);
    rebuild();
    paint();
    // ⚠ **그려진 줄**로 판정한다(hits 가 아니라). 무관한 종류를 접고 나면 hits 는 남아 있는데 화면은 비어 있어,
    //  hits 로 보면 안내문이 안 뜨고 **아무 설명 없는 빈 판**이 된다(실측 2026-08-24: 뜻 없는 질의에 0줄 + 무문구).
    //  "결과가 없습니다" 는 이 검색의 결론이지 부작용이 아니다 — 화면이 비면 그 말이 있어야 한다.
    setNote(pending ? '찾는 중…' : finalNote());
  }

  function localHits(q: string): void {
    const d = hooks!.data();
    const nq = q.toLowerCase();
    // 세션 — 이름·'지금 하는 일'·프로젝트명 어느 쪽이 걸려도 잡는다(사이드바와 같은 이름 규칙: sessText).
    const sess: Hit[] = d.sessions
      .map((s: Sess) => ({ s, t: sessText(s, projName(d, s.projectId)) }))
      .filter(({ s, t }) => [t.main, t.sub, s.label, projName(d, s.projectId)].some((x) => String(x || '').toLowerCase().includes(nq)))
      .slice(0, 6)
      .map(({ s, t }) => ({
        kind: 'sess' as const, key: 's:' + s.id, title: t.main || t.sub || s.id,
        sub: [projName(d, s.projectId), t.main && t.sub ? t.sub : ''].filter(Boolean).join(' · '),
        href: '#/s/' + encodeURIComponent(s.id), at: s.lastSeen || undefined, lex: true,
      }));
    // 프로젝트 — 서버 의미검색이 오기 전에 이름 매칭만 먼저(첫 글자에 화면이 비어 있지 않게). 서버 응답이 오면 덮인다.
    const proj: Hit[] = d.projects.filter((p) => String(p.name || '').toLowerCase().includes(nq)).slice(0, 6)
      .map((p) => ({ kind: 'proj' as const, key: 'p:' + p.id, title: p.name, sub: oneLine(String(p.description || '')), href: projHitHref(p), at: atOf(p.updated_at), lex: true }));
    const apps: Hit[] = visibleApps().filter((a) => appMatches(a, nq)).slice(0, 4)
      .map((a) => ({ kind: 'app' as const, key: 'a:' + a.key, title: a.title, sub: a.desc, href: appHref(a), lex: true }));
    //  꺼진 종류는 애초에 담지 않는다 — 화면에서 거르는 게 아니라 **아예 찾지 않는다**(칩이 곧 검색 범위다).
    buckets.set('local', [...sess, ...proj, ...apps].filter((h) => kindOn(h.kind) && inPeriod(h.at, sinceMs)));
    rebuild();
  }

  /** 대화 결과 한 줄(#4517) — 여는 곳은 **셸이 아는 세션이면 그 세션**(사이드바와 같은 이름 · 같은 문), 모르면 대화록 화면.
   *  셸이 모르는 경우: 초대받은 세션의 옛 대화 · 내 기록 목록 밖(오래된 것). 대화록 화면은 중앙 기록을 바로 읽는다(열람 게이트 동일). */
  function convHit(r: any): Hit {
    const d = hooks!.data();
    const sid = String(r.session_id || '');
    const node = String(r.node_id || '');
    const s = findSessByConv(d.sessions, sid);
    const face = s ? sessText(s, projName(d, s.projectId)) : null;
    const title = (face && (face.main || face.sub)) || String(r.name || r.title || '이름 없는 세션');
    const best = (r && r.best) || {};
    return {
      kind: 'conv', key: 'c:' + node + ':' + sid, title,
      sub: oneLine(String(best.text || ''), 160),
      href: s ? '#/s/' + encodeURIComponent(s.id) : '#/sessions/' + encodeURIComponent(sid) + (node ? '?node=' + encodeURIComponent(node) : ''),
      at: atOf(r.at, best.ts), lex: true, role: best.role === 'assistant' ? 'assistant' : 'user', hits: Number(r.hits) || 1,
    };
  }

  function run(): void {
    const q = input.value.trim();
    seq++;
    const my = seq;
    buckets.clear();
    hits = [];
    sel = 0;   // 목록이 통째로 바뀐다 — 선택을 물려주면 3번째를 고른 채로 글자를 더 쳤을 때 **다른 항목**이 열린다
    qTokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    convPending = 0; convCapped = false; convFailed = ''; convSkipped = false;
    convAbort?.abort(); convAbort = null;
    sinceMs = periodSince(period, Date.now());
    if (!q) { pending = 0; recent(); paint(); setNote(''); return; }
    localHits(q);
    paint();
    const qs = encodeURIComponent(q);
    const byTime = sortMode === 'recent';
    //  기간을 골랐으면 **넉넉히** 받는다 — 지식·프로젝트·자료는 서버가 기간을 모르므로 받은 뒤 거른다(put).
    const wide = sinceMs > 0;
    //  실제로 부를 채널만 센다 — 꺼진 종류를 세면 '찾는 중…' 이 영영 안 걷힌다.
    //  최신순은 의미검색(semantic)을 부르지 않는다 — 최신순에 서는 것은 글자로 맞은 것이고(grep), 맨 위 셋은 similar·grep 으로 충분하다.
    const want = (k: Kind, n: number): number => (kindOn(k) ? n : 0);
    pending = want('know', byTime ? 2 : 3) + want('proj', byTime ? 2 : 3) + want('src', 1) + want('conv', 1);
    if (!pending) { paint(); setNote(finalNote()); return; }
    setNote('찾는 중…');
    const call = (k: Kind, fn: () => void): void => { if (kindOn(k)) fn(); };
    const projRow = (p: any, extra: Partial<Hit> = {}): Hit => ({
      kind: 'proj', key: 'p:' + p.id,
      title: String(p.name || p.title || ('프로젝트 #' + p.id)),
      sub: [p.level && p.level !== 'project' ? (p.level === 'task' ? '태스크' : '서브태스크') : '', snippetOf(p)].filter(Boolean).join(' · '),
      href: projHitHref(p), ident: String(p.id), at: atOf(p.updated_at), ...extra,
    });
    const knowRow = (e: any, extra: Partial<Hit> = {}): Hit => ({
      kind: 'know', key: 'k:' + e.name, title: String(e.title || e.name), sub: snippetOf(e),
      href: '#/k/' + encodeURIComponent(e.name), ident: String(e.name || ''), at: atOf(e.updated_at), ...extra,
    });
    if (!byTime) {
      // 프로젝트(의미) — 로컬 이름 매칭을 덮어쓴다(서버가 더 넓게 본다: 태스크·본문·임베딩).
      call('proj', () => {
    api(`/api/ui/v6/projects/semantic?limit=${wide ? 20 : 6}&q=` + qs).then((r: any) => put('proj:sem', ((r && r.projects) || []).map((p: any) => projRow(p)), my), () => put('proj:sem', [], my));
      });
      call('know', () => {
    api(`/api/ui/knowledge/semantic?limit=${wide ? 20 : 6}&q=` + qs).then((r: any) => put('know:sem', ((r && r.entries) || []).map((e: any) => knowRow(e)), my), () => put('know:sem', [], my));
      });
    }
    // ── grep 채널을 **따로 부른다**(2026-08-20 실측) ────────────────────────────────
    //  하이브리드(semantic)는 벡터 ∪ grep 을 RRF 로 합치는데, **벡터에 없는 문서**(미임베딩)는 벡터 쪽 순위가
    //  통째로 엉뚱한 것들로 차면서 grep 이 맞게 찾은 정답을 뒤로 밀어낸다 — 즉 그 구간에선 하이브리드가
    //  grep 단독보다 **나쁘다**(실측: 질의 '통합검색' 의 정답 문서가 grep 2위 / 하이브리드 top-5 밖).
    //  그래서 grep 을 독립 채널로 한 번 더 부어 **놓친 것을 보탠다**. 제목이 맞은 것은 '가장 맞는 것'이 끌어올린다.
    //  ⚠ 관련도순에선 grep 채널이 **제목이 맞은 것만** 취한다. grep 은 본문 어디든 토큰이 스치면 잡으므로 그대로 부으면
    //   무관한 문서가 목록을 늘린다(실측: '클릭업'·'임베딩' 질의에 '이용약관'·'고객사 도입 48일차'가 딸려 왔다).
    //   이 채널의 목적은 하나다 — **제목이 곧 그 이름인 문서가 RRF 에 묻히지 않게 하는 것**. 본문 회수는 의미검색 몫이다.
    //  ★ 최신순(#4517)에선 반대다 — 본문에 낱말이 든 것도 **전부** 취한다. 최신순의 자격이 «모든 낱말이 글자로 맞았나» 이고,
    //   이 채널은 서버가 이미 **고친 시각 역순**(exactFirst 다음 updated_at DESC)으로 준다(knowledge-search · project-store).
    // ── similar = **절대 코사인** 채널 (2026-08-24) ────────────────────────────────────────
    //  이 두 줄이 '관련도순' 을 가능하게 한다. semantic 의 RRF 점수로는 못 세운다(채널마다 1등이 동점).
    //  min_score 로 **무관하면 아무것도 안 돌려준다** — "결과가 없습니다" 가 정직한 답이 되는 유일한 경로다.
    //  최신순에서도 부른다 — 맨 위 «가장 맞는 결과» 셋이 이 축을 쓴다.
    call('know', () => {
  api(`/api/ui/knowledge/similar?limit=${wide ? 40 : 12}&min_score=${MIN_COSINE}&text=` + qs).then((r: any) => put('know:sim', ((r && r.entries) || []).map((e: any): Hit => knowRow(e, {
        score: Number(e.similarity) || 0,
      })), my), () => put('know:sim', [], my));
    });
    call('proj', () => {
  api(`/api/ui/v6/projects/similar?limit=${wide ? 40 : 12}&min_score=${MIN_COSINE}&text=` + qs).then((r: any) => put('proj:sim', ((r && r.projects) || []).map((p: any): Hit => projRow(p, {
        score: Number(p.similarity) || 0,
      })), my), () => put('proj:sim', [], my));
    });
    const grepLimit = byTime ? (wide ? 40 : 20) : (wide ? 30 : 8);
    call('know', () => {
  api(`/api/ui/knowledge/search?limit=${grepLimit}&q=` + qs).then((r: any) => put('know:grep', ((r && r.entries) || []).map((e: any) => knowRow(e, { lex: true }))
        .filter((h: Hit) => byTime || isTitleHit(h) || isIdentHit(h)), my), () => put('know:grep', [], my));
    });
    call('proj', () => {
  api(`/api/ui/v6/projects/search?limit=${grepLimit}&q=` + qs).then((r: any) => put('proj:grep', ((r && r.projects) || []).map((p: any): Hit => projRow(p, { lex: true }))
        .filter((h: Hit) => byTime || isTitleHit(h) || isIdentHit(h)), my), () => put('proj:grep', [], my));
    });
    call('src', () => {
  api(`/api/ui/sources?limit=${wide || byTime ? 30 : 6}&q=` + qs).then((r: any) => put('src', ((r && r.entries) || []).map((s: any) => ({
        kind: 'src' as const, key: 'src:' + s.id, title: String(s.title || ('자료 #' + s.id)),
        sub: [s.kind, (s.fields && s.fields.container_name) ? '#' + s.fields.container_name : ''].filter(Boolean).join(' · '),
        href: '#/sources/' + s.id,   // #2423 — 자료 상세는 제 주소를 갖는다(옛 '목록+오버레이' 조합을 대체)
        at: atOf(s.occurred_at, s.updated_at), lex: true,   // 자료의 시각은 원래 날짜(메일·메시지를 보낸 때)가 먼저다
      })), my), () => put('src', [], my));
    });
    // 대화(#4517) — 볼 수 있는 세션의 사람 말·AI 말 색인. 결과는 세션 한 줄씩(대표 발췌문 + 맞은 수). 기간은 서버가 거른다.
    call('conv', () => {
      //  서버가 200자 넘는 검색어를 받지 않는다(400) — 부르지 않고, 왜 대화 결과가 없는지를 안내 줄이 말한다.
      if (q.length > 200) { convSkipped = true; put('conv', [], my); return; }
      const p = new URLSearchParams({ q, sort: byTime ? 'recent' : 'relevance', limit: byTime ? '12' : '8' });
      if (sinceMs) p.set('since', new Date(sinceMs).toISOString());
      const ctl = new AbortController();
      convAbort = ctl;
      api('/api/ui/v6/session-search?' + p.toString(), { signal: ctl.signal }).then((r: any) => {
        if (my !== seq) return;
        convPending = r && r.pending == null ? null : (Number(r && r.pending) || 0);
        convCapped = !!(r && r.capped);
        put('conv', ((r && r.results) || []).map(convHit), my);
      }, (e: any) => {
        if (my !== seq || ctl.signal.aborted) return;   // 끊은 요청(글자를 더 쳤다 · 창을 닫았다) — 말할 것이 없다
        convFailed = convFailText(e);
        put('conv', [], my);
      });
    });
  }

  /** 빈 칸일 때 — 최근에 본 세션. 스포트라이트를 열자마자 빈 판이면 '무엇을 칠 수 있는지'가 안 보인다. */
  function recent(): void {
    const d = hooks!.data();
    buckets.clear();
    qTokens = [];
    buckets.set('local', [...d.sessions].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 6).map((s) => {
      const t = sessText(s, projName(d, s.projectId));
      return { kind: 'sess' as const, key: 's:' + s.id, title: t.main || t.sub || s.id, sub: projName(d, s.projectId), href: '#/s/' + encodeURIComponent(s.id), at: s.lastSeen || undefined };
    }));
    rebuild();
  }

  input.addEventListener('input', () => { window.clearTimeout(timer); timer = window.setTimeout(run, 200); });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.isComposing) return;                       // 한글 조합 중 Enter 는 확정이지 열기가 아니다
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) { e.preventDefault(); if (rowNodes.length) { sel = (sel + 1) % rowNodes.length; mark(); } }
    else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) { e.preventDefault(); if (rowNodes.length) { sel = (sel + rowNodes.length - 1) % rowNodes.length; mark(); } }
    else if (e.key === 'Enter') { e.preventDefault(); go(sel, e.metaKey || e.ctrlKey || e.altKey); }
    else if (e.key === 'Escape') { e.preventDefault(); omniClose(); }
  });

  document.body.append(box);
  document.addEventListener('keydown', onEsc, true);
  if (seed) input.value = seed;
  paintSort();
  paintPeriod();
  paintChips();
  recent(); paint(); setNote('');
  input.focus(); input.select();
  if (seed) run();
}

/** 대화 채널 실패를 사람이 읽는 말로. 서버가 사람 말을 준 경우(503 «시간 안에 끝나지 않았습니다» 등)는 그대로 싣고,
 *  코드값(internal_error)이나 상태 번호만 온 경우는 바꿔 말한다 — 안내 줄에 «internal_error» 가 그대로 서지 않게. */
function convFailText(e: any): string {
  const msg = String((e && e.message) || '').trim();
  if (!e || !e.status) return '서버에 닿지 못했습니다';
  if (!msg || msg === 'internal_error' || /^요청 실패 \(\d+\)$/.test(msg)) {
    return e.status >= 500 ? '서버에 오류가 났습니다. 잠시 뒤 다시 찾아 주세요' : '요청이 거절됐습니다';
  }
  return msg;
}

//  기간 메뉴가 떠 있으면 Esc 는 **메뉴의 것**이다(메뉴만 닫는다) — 캡처 단계에서 여기가 먼저 받으므로 비켜 준다(#4517).
function onEsc(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !box) return;
  if (ctxIsOpen()) return;
  e.stopPropagation(); omniClose();
}
export function omniClose(): void {
  if (!box) return;
  convAbort?.abort(); convAbort = null;
  closeCtxMenu();
  box.remove(); box = null;
  document.removeEventListener('keydown', onEsc, true);
}
export function omniIsOpen(): boolean { return !!box; }

// ── 여는 키 ────────────────────────────────────────────────────────────────
//  맥 ⌘K · 그 밖 Ctrl+K, 그리고 **Alt+K**(둘 다).
//  왜 Alt+K 가 더 있나 — 터미널이 포커스면 Ctrl+K 를 셸이 못 받는다(상민님 2026-08-20 윈도우 앱 신고).
//   ① 터미널은 iframe 이라 그 안의 키는 이 문서에 아예 안 온다.
//   ② 온다 해도 xterm 이 Ctrl+K 를 PTY 로 보낸다 — 그건 readline `kill-line`(커서~줄끝 삭제)이라 **뺏으면 안 된다**.
//  그래서 터미널 프레임은 **Alt+K 만** 가로채 이 창에 넘긴다(web/standalone/terminal.ts) — 터미널에서 Alt+K 는
//  ESC k(meta-k)이고 readline 기본 바인딩이 없어 잃는 것이 없다. 맥은 ⌘ 가 애초에 PTY 로 안 가므로 ⌘K 그대로.
export function isOmniChord(e: KeyboardEvent): boolean {
  if (e.key !== 'k' && e.key !== 'K') return false;
  if (e.altKey) return !e.metaKey && !e.ctrlKey;          // Alt+K — 터미널이 포커스여도 되는 길
  return (e.metaKey || e.ctrlKey) && !e.shiftKey;         // ⌘K / Ctrl+K
}
/** 어디서든 여는 키 + **자식 프레임이 넘겨 준 요청**. 글자를 치던 중이면(입력칸) 그 칸의 키가 우선이다. */
export function bindOmniKey(): void {
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!isOmniChord(e)) return;
    e.preventDefault();
    e.stopPropagation();     // 같은 문서의 위키 ⌘K(web/wiki-doc.ts)와 겹쳐 두 창이 뜨지 않게 — 캡처에서 끊는다
    if (box) omniClose(); else omniOpen();
  }, true);
  // 프레임(터미널)에서 넘어온 요청 — **같은 오리진만**. 우리 프레임은 전부 같은 오리진이라 이 한 줄이면
  //  프레임이 늘어나도 각자 넘기기만 하면 된다(셸에 프레임 목록을 두지 않는다).
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.origin !== location.origin) return;
    const m: any = ev.data;
    if (!m || m.type !== OMNI_MSG) return;
    if (box) omniClose(); else omniOpen();
  });
}
/** 프레임 → 셸 '통합검색 열어라' 신호. 프레임 쪽(web/standalone/terminal.ts)도 이 문자열을 쓴다. */
export const OMNI_MSG = 'lively-omni-open';

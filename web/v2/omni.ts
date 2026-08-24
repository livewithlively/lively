// v2/omni.ts — 통합검색(상민님 2026-08-20: "맥의 spotlight·클로드 데스크탑 검색처럼 지식·프로젝트·자료·세션이력 등
//  검색 가능한 자원이 전부 한 결과에 보이게. 웹에서도 쓸 수 있게").
//
//  ── 왜 한 칸인가 ──
//  자원마다 검색칸이 따로 있으면(위키 ⌘K · 사이드바 프로젝트 찾기 · 세션 질문 검색) 사람은 **찾기 전에 어디서 찾을지**를
//  먼저 정해야 한다. 그런데 기억에 남는 건 "그 얘기 어디서 봤더라"이지 "그건 지식이었나 자료였나"가 아니다.
//  그래서 입구를 하나로 두고, 무엇이었는지는 **결과가 말한다**(줄마다 종류 배지).
//
//  ── 구조: 팬아웃 + 흘려 그리기 ──
//  자원별 REST 를 **동시에** 부르고, 먼저 온 것부터 그 자리에 그린다(다 모아 기다리지 않는다). 세션 이력(질문)은
//  전 세션의 대화 파일을 훑어 늘 제일 늦게 오는데, 그거 하나 때문에 지식·프로젝트 결과가 1초씩 멈춰 서면 못 쓴다.
//  · 지식      GET /api/ui/knowledge/semantic  (임베딩 off 면 서버가 grep 으로 폴백)
//  · 프로젝트  GET /api/ui/v6/projects/semantic (같은 규약)
//  · 자료      GET /api/ui/sources?q=
//  · 세션이력  GET /api/ui/terminal/prompts/search  (내가 접근 가능한 세션의 '내가 시킨 말')
//  · 세션·화면 셸이 이미 쥐고 있는 목록에서 즉시(네트워크 0) — 첫 글자에 바로 뭔가 보이는 건 이 둘이다.
//  공개범위는 **전부 서버가 시행한다**(#1291) — 여기서 거르지 않는다.
//
//  ── 데스크톱/웹 공용 ──
//  이 파일은 셸(web/v2)의 일부라 브라우저에서 연 웹 UI 와 데스크톱 앱이 같은 코드를 쓴다. 데스크톱 전용 통로 없음.
import { api, el, sv } from '../core.js';
import { visibleApps } from './apps.js';
import { sessText } from './side.js';
import { projName, type Sess, type V2Data } from './views.js';

type Kind = 'proj' | 'know' | 'src' | 'sess' | 'hist' | 'app';

interface Hit {
  kind: Kind;
  key: string;        // 중복 제거 키
  title: string;
  sub: string;        // 두 번째 줄(스니펫·경로·시각)
  href: string;       // 셸 라우트
  /** 절대 코사인 유사도(0~1) — `similar` 채널만 준다. **채널을 가로질러 비교되는 유일한 축**이라 이걸로 정렬한다. */
  score?: number;
}

interface OmniHooks {
  data(): V2Data;
  /** 셸 이동 — newTab 이면 새 탭에서(탭 규칙은 셸이 안다).
   *  title 은 **클래식 딥링크(지식·자료)** 가 제 이름으로 탭에 앉게 하는 힌트다 — 안 주면 탭 이름이 'WIKI' 가 된다. */
  open(href: string, newTab: boolean, title?: string): void;
}

const GROUPS: Array<{ kind: Kind; label: string }> = [
  { kind: 'sess', label: '세션' },
  { kind: 'proj', label: '프로젝트' },
  { kind: 'know', label: '지식' },
  { kind: 'src', label: '자료' },
  { kind: 'hist', label: '세션 이력' },
  { kind: 'app', label: '화면' },
];
const KIND_LABEL: Record<Kind, string> = { proj: '프로젝트', know: '지식', src: '자료', sess: '세션', hist: '세션 이력', app: '화면' };
// 아이콘은 셸의 붓 그대로(24 뷰박스·현재색 스트로크) — 사이드바·탭과 같은 모양이라 종류가 눈에 먼저 든다.
const KIND_PATH: Record<Kind, string[]> = {
  proj: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  know: ['M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2zM8 7h8M8 11h6'],
  src: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6M9 16h4'],
  sess: ['M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z'],
  hist: ['M12 7v5l3 2', 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3 4v4h4'],
  app: ['M4 5h16v12H4z', 'M4 9h16'],
};
const icon = (k: Kind, cls: string): SVGElement =>
  sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, ...KIND_PATH[k].map((d) => sv('path', { d })));

/** 프로젝트 검색 결과의 이동 자리 — **행의 층에 맞는 화면**으로.
 *  ⚠ 응답의 `project_id` 는 비어 있다(실측 2026-08-24: 태스크 행도 null). 그래서 `project_id || id` 로 폴백하면
 *   **태스크 id 를 프로젝트 id 로 착각해** 엉뚱한 프로젝트로 간다(없는 번호면 빈 화면). 층을 보고 갈라 준다:
 *   프로젝트는 셸의 프로젝트 화면, 태스크·서브태스크는 제 주소를 가진 클래식 태스크 모달(#/projects2/t/<id>). */
function projHref(p: { id: number | string; level?: string }): string {
  const id = Number(p.id);
  return p.level === 'task' || p.level === 'subtask' ? '#/projects2/t/' + id : '#/p/' + id;
}

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

//  similar(절대 코사인)가 **한 번이라도** 결과를 준 적이 있나 = 그 축이 이 조직에서 살아 있나.
//  ⚠ **모듈 스코프다**(창 수명이 아니라 페이지 수명) — 창 안에 두면 ⌘K 를 닫았다 열 때마다 초기화돼
//   **그 창의 첫 질의는 늘 억제가 안 걸린다**(실측 2026-08-24: 뜻 없는 질의로 창을 열면 잡음 12건이 그대로 떴다).
//   임베딩이 꺼진 조직에선 영영 false 라 아래 규칙들이 발동하지 않는다(종전 동작 그대로).
let simAlive = false;

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
export function omniOpen(seed?: string): void {
  if (box) { const i = box.querySelector('.v2-omni-in') as HTMLInputElement | null; i?.focus(); i?.select(); return; }
  if (!hooks) return;

  const input = el('input', {
    class: 'v2-omni-in', type: 'text', spellcheck: 'false', autocomplete: 'off',
    placeholder: '무엇이든 찾기 — 지식 · 프로젝트 · 자료 · 세션 · 세션 이력',
    'aria-label': '통합검색', 'aria-controls': 'v2-omni-list',
  }) as HTMLInputElement;
  const list = el('div', { class: 'v2-omni-list', id: 'v2-omni-list', role: 'listbox' });
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
      list, note)) as HTMLElement;

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

  const rowNodes: HTMLElement[] = [];
  /** 제목이 질의를 통째로 담고 있나 — **종류와 무관하게** 맨 위로 올릴 근거(2026-08-20 실측 뒤 도입).
   *  왜 필요한가: 채널 간 순서가 타입 고정이라 '정확히 그 이름인 문서'가 프로젝트 6건 아래 묻혔다. 게다가
   *  하이브리드(RRF)는 순위역수라 채널마다 1등이 전부 같은 점수(1/61≈0.0164)가 되어 **점수로는 못 가른다**
   *  (실측: 질의에 따라 12항목의 점수 폭이 0.0012 까지 좁아진다). 제목 적중은 그 애매함이 없는 유일한 신호다. */
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
  function paint(): void {
    rowNodes.length = 0;
    const kids: HTMLElement[] = [];
    // ── 관련도순 — 상민님 "가장 정확도 높은 게 먼저 뜨는 게 맞지 않아?" (2026-08-24) ─────────────
    //  들어가는 것: **제목이 그대로 맞은 것**(모든 채널) + **절대 코사인이 컷오프를 넘은 것**(지식·프로젝트).
    //  순서: 제목 적중이 먼저(그보다 확실한 신호가 없다) — 그 안은 '얼마나 그 이름다운가'(질의 위치 + 제목 길이,
    //   실측: '통합검색' 에서 정답보다 '…그리드 통합검색' 이 먼저 뜨던 것). 나머지는 코사인 내림차순.
    //  ⚠ 자료·세션이력에는 이 축이 **없다**(자료는 ILIKE, 이력은 자체 스코어) — 섞으면 없는 값을 있는 척하게 되므로
    //   그 채널들은 아래 종류별 묶음에 그대로 둔다. 축이 없는 것을 억지로 한 줄에 세우지 않는다.
    const meaty = (h: Hit): boolean => isTitleHit(h) || h.title.replace(/[^\p{L}\p{N}]/gu, '').length >= MIN_TITLE_CHARS;
    const top = hits.filter((h) => (isTitleHit(h) || typeof h.score === 'number') && meaty(h))
      .sort((a, b) => {
        const ta = isTitleHit(a) ? 1 : 0, tb = isTitleHit(b) ? 1 : 0;
        if (ta !== tb) return tb - ta;
        // 점수가 있으면 점수가 먼저다 — 제목 적중끼리도 그렇다. 화면에 0.585 가 0.632 위에 서면 '관련도순'이 거짓말이 된다.
        const sa = a.score, sb = b.score;
        if (typeof sa === 'number' && typeof sb === 'number' && sa !== sb) return sb - sa;
        if (ta) return titleRank(a) - titleRank(b);
        return (sb || 0) - (sa || 0);
      })
      .slice(0, 10);
    const topKeys = new Set(top.map((h) => h.key));
    const draw = (label: string, rows: Hit[]): void => {
      if (!rows.length) return;
      kids.push(el('div', { class: 'v2-omni-gh', text: label }));
      for (const h of rows) {
        const i = rowNodes.length;
        const node = el('div', {
          class: 'v2-omni-row', role: 'option', 'aria-selected': 'false', title: h.title + (h.sub ? ' — ' + h.sub : ''),
          onmousemove: () => { if (sel !== i) { sel = i; mark(); } },
          onclick: (e: MouseEvent) => go(i, e.metaKey || e.ctrlKey || e.altKey),
        },
          el('span', { class: 'v2-omni-ic' }, icon(h.kind, 'v2-omni-kic')),
          el('span', { class: 'v2-omni-tt' },
            el('b', { class: 'v2-omni-t', text: h.title }),
            h.sub ? el('span', { class: 'v2-omni-s', text: h.sub }) : null),
          el('span', { class: 'v2-omni-badge', text: KIND_LABEL[h.kind] })) as HTMLElement;
        rowNodes.push(node);
        kids.push(node);
      }
    };
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
    list.replaceChildren(...kids);
    if (sel >= rowNodes.length) sel = Math.max(0, rowNodes.length - 1);
    mark();
  }
  function mark(): void {
    rowNodes.forEach((n, i) => { const on = i === sel; n.classList.toggle('on', on); n.setAttribute('aria-selected', String(on)); });
    rowNodes[sel]?.scrollIntoView({ block: 'nearest' });
  }
  // ⚠ replaceChildren 은 null 을 글자 "null" 로 그린다(el() 과 다르다) — 빈 상태는 자식을 아예 두지 않는다.
  function setNote(text: string): void {
    note.hidden = !text;
    if (text) note.replaceChildren(el('span', { text })); else note.replaceChildren();
  }

  function go(i: number, newTab: boolean): void {
    const h = hits[i];
    if (!h) return;
    omniClose();
    hooks!.open(h.href, newTab, h.title);
  }

  // ── 검색 ── 소스마다 따로 돌고, 도착하는 대로 그 소스 칸만 갈아 끼운 뒤 목록을 다시 만든다.
  //  소스 순서 = 같은 항목이 두 소스에서 오면 **먼저 온 쪽의 표현**(스니펫)을 쓴다는 뜻이다. 의미검색을 앞에 두어
  //  종전 순서를 지키고, grep 은 **의미검색이 놓친 것을 뒤에 보탠다**(그 중 제목 적중은 위 '가장 맞는 것'이 끌어올린다).
  //  ⚠ similar(절대 코사인)를 **먼저** 둔다 — 같은 항목이 두 소스에서 오면 먼저 온 쪽이 남는데, 점수를 가진 쪽이
  //   남아야 관련도순에 설 수 있다(뒤에 두면 점수 없는 사본이 먼저 잡혀 그 줄이 순위에서 빠진다).
  const SRC_ORDER = ['know:sim', 'proj:sim', 'local', 'know:sem', 'know:grep', 'proj:sem', 'proj:grep', 'src', 'hist'];
  function rebuild(): void {
    const seen = new Set<string>();
    hits = [];
    for (const src of SRC_ORDER) {
      for (const h of buckets.get(src) || []) {
        // 같은 것으로 치는 기준 셋 — ⓐ같은 항목(key) ⓑ**같은 곳으로 가는 줄**(href) ⓒ같은 종류의 같은 이름.
        //  ⓑ·ⓒ 가 없으면 같은 줄이 두 번 뜬다(실측 2026-08-24 'tmux': 1·2위가 글자 그대로 같은 제목이었다) —
        //  소스가 둘이고(의미검색·grep) 프로젝트/태스크가 이름을 공유할 때 생긴다. 먼저 온 쪽(더 높은 순위)이 남는다.
        const ids = [h.key, 'href:' + h.href, 'name:' + h.kind + '|' + h.title.trim().toLowerCase()];
        if (ids.some((k) => seen.has(k))) continue;
        for (const k of ids) seen.add(k);
        hits.push(h);
      }
    }
  }
  function put(src: string, rows: Hit[], mySeq: number): void {
    if (mySeq !== seq || !box) return;
    if (rows.length && src.endsWith(':sim')) simAlive = true;
    buckets.set(src, rows);
    pending = Math.max(0, pending - 1);
    rebuild();
    paint();
    setNote(pending ? '찾는 중…' : (hits.length ? '' : '결과가 없습니다.'));
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
        href: '#/s/' + encodeURIComponent(s.id),
      }));
    // 프로젝트 — 서버 의미검색이 오기 전에 이름 매칭만 먼저(첫 글자에 화면이 비어 있지 않게). 서버 응답이 오면 덮인다.
    const proj: Hit[] = d.projects.filter((p) => String(p.name || '').toLowerCase().includes(nq)).slice(0, 6)
      .map((p) => ({ kind: 'proj' as const, key: 'p:' + p.id, title: p.name, sub: oneLine(String(p.description || '')), href: '#/p/' + p.id }));
    const apps: Hit[] = visibleApps().filter((a) => (a.title + ' ' + a.desc).toLowerCase().includes(nq)).slice(0, 4)
      .map((a) => ({ kind: 'app' as const, key: 'a:' + a.key, title: a.title, sub: a.desc, href: '#/app/' + a.key }));
    buckets.set('local', [...sess, ...proj, ...apps]);
    rebuild();
  }

  function run(): void {
    const q = input.value.trim();
    seq++;
    const my = seq;
    buckets.clear();
    hits = [];
    qTokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!q) { pending = 0; recent(); paint(); setNote(''); return; }
    localHits(q);
    paint();
    pending = 8;
    setNote('찾는 중…');
    const qs = encodeURIComponent(q);
    // 프로젝트(의미) — 로컬 이름 매칭을 덮어쓴다(서버가 더 넓게 본다: 태스크·본문·임베딩).
    api('/api/ui/v6/projects/semantic?limit=6&q=' + qs).then((r: any) => put('proj:sem', ((r && r.projects) || []).map((p: any) => ({
      kind: 'proj' as const, key: 'p:' + p.id,
      title: String(p.name || p.title || ('프로젝트 #' + p.id)),
      sub: [p.level && p.level !== 'project' ? (p.level === 'task' ? '태스크' : '서브태스크') : '', snippetOf(p)].filter(Boolean).join(' · '),
      href: projHref(p),
    })), my), () => put('proj:sem', [], my));
    const knowRow = (e: any): Hit => ({
      kind: 'know', key: 'k:' + e.name, title: String(e.title || e.name), sub: snippetOf(e), href: '#/k/' + encodeURIComponent(e.name),
    });
    api('/api/ui/knowledge/semantic?limit=6&q=' + qs).then((r: any) => put('know:sem', ((r && r.entries) || []).map(knowRow), my), () => put('know:sem', [], my));
    // ── grep 채널을 **따로 부른다**(2026-08-20 실측) ────────────────────────────────
    //  하이브리드(semantic)는 벡터 ∪ grep 을 RRF 로 합치는데, **벡터에 없는 문서**(미임베딩)는 벡터 쪽 순위가
    //  통째로 엉뚱한 것들로 차면서 grep 이 맞게 찾은 정답을 뒤로 밀어낸다 — 즉 그 구간에선 하이브리드가
    //  grep 단독보다 **나쁘다**(실측: 질의 '통합검색' 의 정답 문서가 grep 2위 / 하이브리드 top-5 밖).
    //  그래서 grep 을 독립 채널로 한 번 더 부어 **놓친 것을 보탠다**. 제목이 맞은 것은 '가장 맞는 것'이 끌어올린다.
    //  ⚠ grep 채널은 **제목이 맞은 것만** 취한다. grep 은 본문 어디든 토큰이 스치면 잡으므로 그대로 부으면
    //   무관한 문서가 목록을 늘린다(실측: '클릭업'·'임베딩' 질의에 '이용약관'·'고객사 도입 48일차'가 딸려 왔다).
    //   이 채널의 목적은 하나다 — **제목이 곧 그 이름인 문서가 RRF 에 묻히지 않게 하는 것**. 본문 회수는 의미검색 몫이다.
    // ── similar = **절대 코사인** 채널 (2026-08-24) ────────────────────────────────────────
    //  이 두 줄이 '관련도순' 을 가능하게 한다. semantic 의 RRF 점수로는 못 세운다(채널마다 1등이 동점).
    //  min_score 로 **무관하면 아무것도 안 돌려준다** — "결과가 없습니다" 가 정직한 답이 되는 유일한 경로다.
    api(`/api/ui/knowledge/similar?limit=12&min_score=${MIN_COSINE}&text=` + qs).then((r: any) => put('know:sim', ((r && r.entries) || []).map((e: any): Hit => ({
      kind: 'know', key: 'k:' + e.name, title: String(e.title || e.name), sub: snippetOf(e),
      href: '#/k/' + encodeURIComponent(e.name), score: Number(e.similarity) || 0,
    })), my), () => put('know:sim', [], my));
    api(`/api/ui/v6/projects/similar?limit=12&min_score=${MIN_COSINE}&text=` + qs).then((r: any) => put('proj:sim', ((r && r.projects) || []).map((p: any): Hit => ({
      kind: 'proj', key: 'p:' + p.id, title: String(p.name || ('프로젝트 #' + p.id)),
      sub: [p.level && p.level !== 'project' ? (p.level === 'task' ? '태스크' : '서브태스크') : '', snippetOf(p)].filter(Boolean).join(' · '),
      href: projHref(p), score: Number(p.similarity) || 0,
    })), my), () => put('proj:sim', [], my));
    api('/api/ui/knowledge/search?limit=8&q=' + qs).then((r: any) => put('know:grep', ((r && r.entries) || []).map(knowRow).filter(isTitleHit), my), () => put('know:grep', [], my));
    api('/api/ui/v6/projects/search?limit=8&q=' + qs).then((r: any) => put('proj:grep', ((r && r.projects) || []).map((p: any): Hit => ({
      kind: 'proj' as const, key: 'p:' + p.id,
      title: String(p.name || p.title || ('프로젝트 #' + p.id)),
      sub: [p.level && p.level !== 'project' ? (p.level === 'task' ? '태스크' : '서브태스크') : '', snippetOf(p)].filter(Boolean).join(' · '),
      href: projHref(p),
    })).filter(isTitleHit), my), () => put('proj:grep', [], my));
    api('/api/ui/sources?limit=6&q=' + qs).then((r: any) => put('src', ((r && r.entries) || []).map((s: any) => ({
      kind: 'src' as const, key: 'src:' + s.id, title: String(s.title || ('자료 #' + s.id)),
      sub: [s.kind, (s.fields && s.fields.container_name) ? '#' + s.fields.container_name : ''].filter(Boolean).join(' · '),
      // 자료엔 단독 주소가 없다 — 자료 목록을 그 검색어로 연 뒤 그 자료를 펴 준다(web/wiki.ts renderSources).
      href: '#/knowledge/sources?q=' + qs + '&src=' + s.id,
    })), my), () => put('src', [], my));
    // 세션 이력 = 그 세션에 **내가 시킨 말**. 전 세션의 대화 파일을 훑으므로 늘 제일 늦게 온다(그래서 따로 그린다).
    api('/api/ui/terminal/prompts/search?q=' + qs).then((r: any) => put('hist', ((r && r.results) || []).slice(0, 6).map((h: any) => ({
      kind: 'hist' as const, key: 'h:' + h.sessionId + ':' + (h.ts || '') + ':' + oneLine(h.text, 24),
      title: oneLine(h.text), sub: String(h.label || h.sessionId), href: '#/s/' + encodeURIComponent(h.sessionId),
    })), my), () => put('hist', [], my));
  }

  /** 빈 칸일 때 — 최근에 본 세션. 스포트라이트를 열자마자 빈 판이면 '무엇을 칠 수 있는지'가 안 보인다. */
  function recent(): void {
    const d = hooks!.data();
    buckets.clear();
    qTokens = [];
    buckets.set('local', [...d.sessions].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 6).map((s) => {
      const t = sessText(s, projName(d, s.projectId));
      return { kind: 'sess' as const, key: 's:' + s.id, title: t.main || t.sub || s.id, sub: projName(d, s.projectId), href: '#/s/' + encodeURIComponent(s.id) };
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
  recent(); paint(); setNote('');
  input.focus(); input.select();
  if (seed) run();
}

function onEsc(e: KeyboardEvent): void { if (e.key === 'Escape' && box) { e.stopPropagation(); omniClose(); } }
export function omniClose(): void {
  if (!box) return;
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

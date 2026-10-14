// v2/omni-preview.ts — 통합검색 미리보기 칸(#4530 안 A, 원준 2026-10-04).
//
//  원준: «A안으로 가자 … 지식, 세션, 프로젝트 뭐든 내부 안까지 어떻게 보여줘야 사용자에게 가장 만족스럽게 보여줄지 다 구현해 ·
//   하나씩 찾아서 그 레이아웃도 너가 직접 만들어».
//  왜 — 목록 한 줄(이름 + 발췌 한 조각)로는 «이게 내가 찾던 것인가» 를 못 가려 열어 봐야 했고, 열면 검색 창이 닫혀 다시 찾아야 했다.
//   고른 결과의 **안**을 옆 칸에 보여 준다. 종류마다 «맞는지 가르는 데 쓰는 것» 이 달라 레이아웃도 다르다:
//    · 세션     맞은 말과 그 앞뒤 말(대화 모양) · 처음 시킨 말 · 고친 파일 · 프로젝트 · 상태
//    · 지식     맞은 줄과 그 줄이 속한 절 · 요약 · 목차 · 분류 · 연결
//    · 프로젝트 상태 · 태스크 진행과 목록 · 본문에서 맞은 곳 · 필요/산출 지식 · 이 프로젝트의 세션
//    · 태스크   상위 프로젝트 · 담당·마감 · 본문 · 하위 태스크 · 최근 활동
//    · 자료     출처·채널·글쓴이 · 본문에서 맞은 곳 · 이 자료로 만든 지식 · 원본 열기
//    · 분류·리스트·폴더·화면·명령  무엇인지와 누르면 일어나는 일
//  서버에 새로 묻는 것은 세션 하나(GET /api/ui/v6/session-search/hits) — 나머지는 화면들이 이미 쓰는 단건 조회를 그대로 읽는다.
//  고를 때마다 묻지 않게 답은 이 창이 떠 있는 동안 기억한다(같은 줄로 돌아오면 바로 선다).
import { el, sv } from '../core.js';
import { ICONS } from '../lib/icon-paths.js';
import { excerptBlocks, leadLines, outline, taskSummary, statusText, orderTasks, cleanLine, cleanInline, type ExcerptBlock } from '../lib/omni-preview.js';
import { splitKnowTitle } from '../lib/omni-rank.js';
import { dotCls, type V2Data } from './views.js';

export type PvRef =
  | { t: 'sess'; sid: string; node: string; project?: string; owner?: string; stateKey?: string; stateLabel?: string;
      /** 셸 목록이 아는 첫 지시 — 서버에 대화 기록이 아직 없을 때(방금 만든 세션) 이것이라도 보인다. */
      hint?: string }
  | { t: 'know'; name: string }
  | { t: 'proj'; id: number }
  | { t: 'task'; id: number }
  | { t: 'src'; id: string }
  | { t: 'cat'; id: string }
  | { t: 'list'; id: number }
  | { t: 'folder'; id: number }
  | { t: 'text'; lines: string[]; act?: string };

export interface PvHit {
  key: string;
  title: string;
  head?: string;
  status?: string;
  at?: number;
  href?: string;
  /** 누르면 도는 일(명령·설정·최근 검색) — href 가 없는 줄. */
  run?: () => void;
  pv?: PvRef;
}
export type PvOpenMode = 'here' | 'tab' | 'aside';

export interface PvDeps {
  api(path: string, opts?: { signal?: AbortSignal }): Promise<any>;
  data(): V2Data;
  query(): string;
  words(): string[];
  /** 기간으로 좁혔으면 그 시작(ms) — 세션의 맞은 말도 그 기간 안에서 고른다. 아니면 0. */
  since(): number;
  /** 글에서 맞은 낱말을 칠한 노드들. extra = 그 글에서만 더 칠할 낱말(서버가 비슷한 글자로 맞춘 자리의 실제 글). */
  hl(text: string, extra?: string[]): Node[];
  /** 종류 그림과 이름(목록 줄과 같은 것). */
  icon(h: PvHit, cls: string): SVGElement;
  kindLabel(h: PvHit): string;
  /** 상대 시각(«3시간 전» · «9월 25일»). */
  when(ms: number): string;
  open(h: PvHit, mode: PvOpenMode): void;
  /** 미리보기 안의 다른 항목(상위 프로젝트 · 연결 지식)으로 간다. */
  openHref(href: string, title?: string): void;
  canAside(): boolean;
  mac: boolean;
}
export interface Preview {
  el: HTMLElement;
  show(h: PvHit | null): void;
  /** 맞은 곳 넘기기(세션). 넘겼으면 true. */
  nav(d: number): boolean;
  dispose(): void;
}

const svg = (d: string, cls = 'v2-opv-ic'): SVGElement =>
  sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, ...d.split(/(?= M)/).map((p) => sv('path', { d: p.trim() })));
const IC = {
  proj: ICONS.proj, clock: ICONS.clock, person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',
  tag: 'M2.5 5h6.5l8 8-6 6-8.5-8.5z M6.5 9h.01', chat: ICONS.chat, file: ICONS.src, link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  cal: 'M4 6h16v14H4z M4 10h16 M8 3v5 M16 3v5', ret: 'M20 5v7H6 M10 8l-4 4 4 4', tab: 'M4 6h16v14H4z M4 10h16',
  side: 'M3 4h18v16H3z M15 4v16', ext: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6', flag: 'M5 21V4 M5 4h12l-2 4 2 4H5',
  list: 'M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
};
const iso = (v: unknown): number => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : 0; };
const short = (s: unknown, n: number): string => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n).trimEnd() + '…' : t; };
const dateOnly = (v: unknown): string => { const t = iso(v); if (!t) return ''; const d = new Date(t); return `${d.getMonth() + 1}월 ${d.getDate()}일`; };
const SYS_LABEL: Record<string, string> = { slack: 'Slack', github: 'GitHub', gitlab: 'GitLab', notion: 'Notion', google: 'Google', gdrive: 'Google Drive', gmail: 'Gmail', linear: 'Linear', clickup: 'ClickUp', figma: 'Figma', outlook: 'Outlook', local: '올린 파일' };
const PRIO_LABEL: Record<string, string> = { urgent: '긴급', high: '높음', normal: '보통', low: '낮음' };

export function createPreview(deps: PvDeps): Preview {
  //  aria-live 는 걸지 않는다 — 줄을 옮길 때마다 미리보기 전체를 읽으면 화면 읽기 프로그램이 고른 줄 이름을 못 읽는다.
  const root = el('section', { class: 'v2-opv', 'aria-label': '미리보기' }) as HTMLElement;
  const cache = new Map<string, any>();          // 답(이 창이 떠 있는 동안)
  const failed = new Map<string, string>();      // 실패한 까닭
  let cur: PvHit | null = null;
  let seq = 0;
  let abort: AbortController | null = null;
  let timer = 0;
  let stamp = '';                                 // 지금 그려 둔 것(줄 · 좌표 · 검색어) — 같으면 다시 그리지 않는다
  let waitKey = '';                               // 가는 중인 요청이 묻는 것
  let hitIdx = 0;                                 // 세션의 «맞은 말» 몇 번째를 보고 있나
  let convHost: HTMLElement | null = null;        // 맞은 말 자리(넘길 때 여기만 다시 그린다)
  let convData: any = null;
  let convRef: Extract<PvRef, { t: 'sess' }> | null = null;
  let convMissing = false;                        // 서버에 이 세션의 대화 기록이 없다(404)

  const keyOf = (ref: PvRef): string => {
    switch (ref.t) {
      case 'sess': return 'sess:' + ref.node + ':' + ref.sid + ':' + deps.since() + ':' + deps.query();
      case 'know': return 'know:' + ref.name;
      case 'text': return '';
      default: return ref.t + ':' + ref.id;
    }
  };
  const urlOf = (ref: PvRef): string => {
    switch (ref.t) {
      case 'sess': {
        const p = new URLSearchParams({ session_id: ref.sid, node_id: ref.node, q: deps.query().slice(0, 200), limit: '8' });
        if (deps.since()) p.set('since', new Date(deps.since()).toISOString());
        return '/api/ui/v6/session-search/hits?' + p.toString();
      }
      case 'know': return '/api/ui/knowledge/' + encodeURIComponent(ref.name) + '?offset=1&limit=1500';
      case 'proj': return '/api/ui/v6/projects/' + ref.id;
      case 'task': return '/api/ui/v6/tasks/' + ref.id + '/detail';
      case 'src': return '/api/ui/sources/' + encodeURIComponent(ref.id);
      case 'cat': return '/api/ui/categories/' + encodeURIComponent(ref.id);
      default: return '';
    }
  };

  // ── 부품 ──
  const sec = (title: string, ...extra: Array<Node | null>): HTMLElement =>
    el('div', { class: 'v2-opv-sec' }, el('span', { text: title }), ...extra.filter((x): x is Node => !!x)) as HTMLElement;
  const fact = (path: string, text: string, title?: string): HTMLElement | null =>
    text ? el('span', { class: 'v2-opv-fact', ...(title ? { title } : {}) }, svg(path), el('span', { text })) as HTMLElement : null;
  const facts = (...items: Array<HTMLElement | null>): HTMLElement | null => {
    const xs = items.filter((x): x is HTMLElement => !!x);
    return xs.length ? el('div', { class: 'v2-opv-facts' }, ...xs) as HTMLElement : null;
  };
  const pill = (text: string, tone: string): HTMLElement => el('span', { class: 'v2-opv-pill ' + tone, text }) as HTMLElement;
  const kbd = (text: string): HTMLElement => el('kbd', { class: 'v2-opv-kbd', text }) as HTMLElement;
  const para = (cls: string, text: string): HTMLElement => el('p', { class: cls }, ...deps.hl(text)) as HTMLElement;
  const blocksEl = (blocks: ExcerptBlock[]): HTMLElement =>
    //  같은 절의 덩이가 이어지면 절 이름은 첫 덩이에만(같은 제목이 덩이마다 되풀이됐다, 실화면).
    el('div', { class: 'v2-opv-blocks' }, ...blocks.map((b, i) => el('div', { class: 'v2-opv-block' },
      b.heading && (i === 0 || blocks[i - 1].heading !== b.heading) ? el('div', { class: 'v2-opv-crumb', text: b.heading }) : null,
      ...b.lines.map((l) => el('p', { class: 'v2-opv-line' + (l.hit ? ' hit' : '') }, ...deps.hl(l.text)))))) as HTMLElement;
  /** 본문 — 낱말이 든 곳이 있으면 그곳을, 없으면 앞부분을. */
  const bodyEl = (body: string, max: number, leadTitle: string): HTMLElement[] => {
    const ex = excerptBlocks(body, deps.words(), { max, ctx: 1 });
    if (ex.blocks.length) {
      return [sec('맞은 곳', el('em', { text: ex.total > ex.blocks.length ? `${ex.total}줄 중 ${countHits(ex.blocks)}줄` : `${ex.total}줄` })), blocksEl(ex.blocks)];
    }
    const lead = leadLines(body, 5);
    if (!lead.length) return [];
    return [sec(leadTitle), el('div', { class: 'v2-opv-blocks' }, el('div', { class: 'v2-opv-block' }, ...lead.map((t) => para('v2-opv-line', t)))) as HTMLElement];
  };
  const countHits = (blocks: ExcerptBlock[]): number => blocks.reduce((n, b) => n + b.lines.filter((l) => l.hit).length, 0);
  const linkRow = (text: string, onclick: () => void, cls = ''): HTMLElement =>
    el('button', { class: 'v2-opv-link ' + cls, type: 'button', onclick: (e: MouseEvent) => { e.stopPropagation(); onclick(); } }, ...deps.hl(text)) as HTMLElement;

  // ── 머리 · 단추(답이 오기 전에도 선다) ──
  function headEl(h: PvHit, extra?: HTMLElement | null): HTMLElement {
    return el('header', { class: 'v2-opv-h' },
      el('div', { class: 'v2-opv-kline' },
        el('span', { class: 'v2-opv-kind' }, deps.icon(h, 'v2-opv-kic'), el('span', { text: deps.kindLabel(h) })),
        h.head ? el('span', { class: 'v2-opv-tag', text: h.head }) : null,
        //  상태 — 안을 읽은 뒤에는 그 답이 말한다(extra). 그 전에는 목록 줄이 아는 것.
        extra || (h.status ? pill(h.status, h.status === '완료' ? 'done' : 'off') : null)),
      el('h3', { class: 'v2-opv-t' }, ...deps.hl(h.title))) as HTMLElement;
  }
  function actionsEl(h: PvHit, more: HTMLElement[] = []): HTMLElement {
    const mod = deps.mac ? '⌘' : 'Ctrl';
    const btn = (cls: string, path: string, label: string, key: string, onclick: () => void): HTMLElement =>
      el('button', { class: 'v2-opv-btn ' + cls, type: 'button', onclick: (e: MouseEvent) => { e.stopPropagation(); onclick(); } }, svg(path), el('span', { text: label }), key ? kbd(key) : null) as HTMLElement;
    const xs: HTMLElement[] = [];
    if (h.run && !h.href) xs.push(btn('pri', IC.ret, (h.pv && h.pv.t === 'text' && h.pv.act) || '실행', 'Enter', () => deps.open(h, 'here')));
    else {
      xs.push(btn('pri', IC.ret, '열기', 'Enter', () => deps.open(h, 'here')));
      xs.push(btn('', IC.tab, '새 탭', mod + ' Enter', () => deps.open(h, 'tab')));
      if (h.pv && h.pv.t === 'know' && deps.canAside()) xs.push(btn('', IC.side, '사이드바에 고정', 'Alt Enter', () => deps.open(h, 'aside')));   // 위키 덧창의 [우측 사이드바에 고정]과 같은 일
    }
    return el('footer', { class: 'v2-opv-act' }, ...xs, ...more) as HTMLElement;
  }
  const skeleton = (): HTMLElement => el('div', { class: 'v2-opv-skel', 'aria-hidden': 'true' }, ...[72, 88, 60, 80].map((w) => el('i', { style: `width:${w}%` }))) as HTMLElement;

  function frame(h: PvHit, body: Array<Node | null>, moreActs: HTMLElement[] = [], headExtra?: HTMLElement | null): void {
    root.replaceChildren(headEl(h, headExtra), el('div', { class: 'v2-opv-b' }, ...body.filter((x): x is Node => !!x)), actionsEl(h, moreActs));
  }

  // ── 세션 ──
  function convEl(): HTMLElement {
    const d = convData, ref = convRef!;
    const hits: any[] = (d && d.hits) || [];
    //  누구의 세션인가 — 서버가 말한 것이 먼저(셸이 모르는 세션도 안다). 없으면 셸 목록이 아는 주인.
    const mine = d && typeof d.mine === 'boolean' ? d.mine : !ref.owner;
    const who = (role: string): HTMLElement => el('span', { class: 'v2-opv-who ' + (role === 'assistant' ? 'ai' : 'user'), text: role === 'assistant' ? 'AI' : mine ? '나' : '지시' }) as HTMLElement;
    //  말은 마크다운 원문이다 — 굵게·코드 표시(** `)를 걷어 글만 보인다(실화면: «**파일:** `…`» 가 그대로 보였다).
    //  marks = 비슷한 글자로(붙여 쓰기 · 한 글자 틀림) 맞은 자리의 실제 글 — 친 글과 달라서 따로 칠한다.
    const marks: string[] = (d && Array.isArray(d.marks) ? d.marks : []).filter((x: unknown): x is string => typeof x === 'string' && [...x].length >= 2);
    const msg = (m: any, cls: string): HTMLElement | null => m ? el('div', { class: 'v2-opv-msg ' + cls }, who(String(m.role)), el('p', {}, ...deps.hl(cleanInline(String(m.text || '')), marks))) as HTMLElement : null;
    const host = el('div', { class: 'v2-opv-conv' }) as HTMLElement;
    if (hits.length) {
      const i = Math.max(0, Math.min(hitIdx, hits.length - 1));
      const hit = hits[i];
      const t = iso(hit.ts);
      host.append(
        sec('맞은 말', el('em', { text: `${i + 1} / ${hits.length}` + (d.total > hits.length ? ` (모두 ${d.total}곳)` : '') }),
          t ? el('span', { class: 'v2-opv-when', text: deps.when(t), title: new Date(t).toLocaleString('ko-KR') }) : null,
          hits.length > 1 ? el('span', { class: 'v2-opv-nav' },
            //  ‹ › 는 Tab 으로 닿지 않게 한다 — 누르는 순간 이 자리가 다시 그려져 단추가 사라지고, 초점이 창 밖으로 새어 Tab 순환이 풀렸다
            //   (격리 리뷰). 키보드로는 Shift+↑↓ 가 같은 일을 한다.
            el('button', { type: 'button', tabindex: '-1', class: 'v2-opv-navb', title: '앞의 맞은 말 (Shift ↑)', 'aria-label': '앞의 맞은 말', text: '‹', onclick: (e: MouseEvent) => { e.stopPropagation(); nav(-1); } }),
            el('button', { type: 'button', tabindex: '-1', class: 'v2-opv-navb', title: '다음 맞은 말 (Shift ↓)', 'aria-label': '다음 맞은 말', text: '›', onclick: (e: MouseEvent) => { e.stopPropagation(); nav(1); } })) : null),
        ...[msg(hit.before, 'dim'), msg(hit, 'hit'), msg(hit.after, 'dim')].filter((x): x is HTMLElement => !!x));
    } else if (d && (d.first || d.last)) {
      //  낱말이 말에는 없다(이름·프로젝트·고친 파일로 맞았거나 검색어가 없다) — 처음과 끝으로 무슨 세션인지 보인다.
      if (d.first) host.append(sec('처음 시킨 말'), msg(d.first, 'plain')!);
      if (d.last && (!d.first || d.last.text !== d.first.text)) host.append(sec('마지막 말'), msg(d.last, 'plain')!);
    } else {
      //  기록이 서버에 없다(방금 만든 세션 · 기록을 올리지 않는 세션)와 색인이 아직 안 됐다는 다른 일이다 — 있는 그대로 말한다.
      host.append(el('p', { class: 'v2-opv-empty', text: convMissing
        ? '이 세션의 대화 기록이 아직 서버에 올라오지 않았습니다. 방금 만든 세션이면 잠시 뒤에 보입니다. 지금은 열어서 확인해 주세요.'
        : '이 세션의 대화는 아직 찾을 수 있게 정리되지 않았습니다. 열어서 확인해 주세요.' }));
    }
    return host;
  }
  const sameStart = (a: unknown, b: unknown): boolean => { const x = String(a || '').replace(/^…/, '').slice(0, 40), y = String(b || '').replace(/^…/, '').slice(0, 40); return !!x && x === y; };
  const firstShownBelow = (d: any): boolean => { const h0 = d.hits && d.hits[0]; return !!h0 && (sameStart(d.first.text, h0.text) || (h0.before && sameStart(d.first.text, h0.before.text))); };
  function renderSess(h: PvHit, ref: Extract<PvRef, { t: 'sess' }>, d: any, missing = false): void {
    convData = d; convRef = ref; hitIdx = 0; convMissing = missing;
    convHost = convEl();
    const edits: any[] = (d && d.edits) || [];
    const hasHits = !!(d && d.hits && d.hits.length);
    frame(h, [
      facts(
        fact(IC.proj, ref.project || ''),
        fact(IC.person, ref.owner || ''),
        fact(IC.clock, h.at ? deps.when(h.at) + ' 활동' : ''),
        fact(IC.chat, d && d.msgs ? `말 ${d.msgs}개` : '')),
      //  처음 시킨 말 — 무슨 세션이었는지 떠올리게 한다. 바로 아래 «맞은 말» 의 앞 말이 그 말이면 두 번 보이지 않게 뺀다.
      hasHits && d.first && !firstShownBelow(d) ? el('p', { class: 'v2-opv-first' }, el('b', { text: '처음 시킨 말 ' }), ...deps.hl(short(cleanInline(String(d.first.text || '')), 150)))
        : !d && ref.hint ? el('p', { class: 'v2-opv-first' }, el('b', { text: '처음 시킨 말 ' }), ...deps.hl(short(cleanInline(ref.hint), 220))) : null,
      convHost,
      edits.length ? sec('이 세션에서 고친 파일') : null,
      edits.length ? el('div', { class: 'v2-opv-files' }, ...edits.map((e) => el('code', { class: e.hit ? 'hit' : '' }, ...deps.hl(String(e.path))))) : null,
    ], [], ref.stateLabel ? el('span', { class: 'v2-opv-state' }, el('span', { class: 'v2-dot ' + dotCls(ref.stateKey || ''), 'aria-hidden': 'true' }), el('span', { text: ref.stateLabel })) as HTMLElement : null);
  }
  function nav(d: number): boolean {
    const hits: any[] = (convData && convData.hits) || [];
    if (!cur || !cur.pv || cur.pv.t !== 'sess' || hits.length < 2 || !convHost) return false;
    hitIdx = (hitIdx + d + hits.length) % hits.length;
    const next = convEl();
    convHost.replaceWith(next);
    convHost = next;
    return true;
  }

  // ── 지식 ──
  function renderKnow(h: PvHit, d: any): void {
    const k = (d && d.knowledge) || {};
    const body = String(k.body_md || '');
    const cats: string[] = (k.categories || []).map((c: any) => String(c.name || '')).filter(Boolean);
    const out = outline(body, 8);
    const links = ((k.links && k.links.outgoing) || []).length + ((k.links && k.links.incoming) || []).length;
    const srcN = (k.sources || []).length;
    const kids = Number(k.children_total) || 0;
    const related: any[] = ((k.links && k.links.outgoing) || []).slice(0, 3);
    frame(h, [
      facts(
        fact(IC.tag, cats.slice(0, 3).join(' · ')),
        fact(IC.clock, iso(k.updated_at) ? deps.when(iso(k.updated_at)) + ' 고침' : ''),
        fact(IC.person, String(k.updated_by || k.author || '').replace(/^connector:/, '')),
        fact(IC.list, k.version ? `판 ${k.version}` : '')),
      k.summary ? para('v2-opv-sum', short(k.summary, 260)) : null,
      ...bodyEl(body, 3, '문서 앞부분'),
      d && d.body_range && d.body_range.has_more ? el('p', { class: 'v2-opv-note', text: '긴 문서라 앞 1,500줄에서만 찾았습니다.' }) : null,
      out.length ? sec('목차') : null,
      out.length ? el('ul', { class: 'v2-opv-toc' }, ...out.map((o) => el('li', { class: 'l' + o.level }, ...deps.hl(o.text)))) : null,
      links || srcN || kids ? sec('연결', el('em', { text: [links ? `문서 ${links}` : '', srcN ? `원본 자료 ${srcN}` : '', kids ? `하위 문서 ${kids}` : ''].filter(Boolean).join(' · ') })) : null,
      related.length ? el('div', { class: 'v2-opv-rows' }, ...related.map((r) => linkRow(splitKnowTitle(String(r.title || r.name)).main, () => deps.openHref('#/k/' + encodeURIComponent(String(r.name)), String(r.title || r.name))))) : null,
    ]);
  }

  // ── 프로젝트 ──
  const stateDot = (cat: unknown): HTMLElement => el('span', { class: 'v2-opv-sdot ' + statusText({ status_category: String(cat || '') }).tone, 'aria-hidden': 'true' }) as HTMLElement;
  function renderProj(h: PvHit, ref: Extract<PvRef, { t: 'proj' }>, d: any): void {
    const p = (d && d.project) || {};
    const st = statusText(p);
    const tasks: any[] = (p.tasks || []).filter((t: any) => !t.trashed_at);
    const sum = taskSummary(tasks);
    const shown = orderTasks(tasks, deps.words()).slice(0, 6);
    const members: string[] = (p.members || []).map((m: any) => String(m.display_name || m.name || m.member_id || '')).filter(Boolean);
    const period = [dateOnly(p.start_date), dateOnly(p.due_date)].filter(Boolean).join(' → ');
    const req: any[] = (p.knowledge && p.knowledge.required) || [], prod: any[] = (p.knowledge && p.knowledge.produced) || [];
    const data = deps.data();
    const sess = data.sessions.filter((s) => s.projectId === ref.id && !s.trashedAt).sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 3);
    frame(h, [
      facts(
        fact(IC.list, String((p.list && p.list.name) || '')),
        fact(IC.person, members.slice(0, 3).join(' · ') + (members.length > 3 ? ` 외 ${members.length - 3}명` : '')),
        fact(IC.cal, period),
        fact(IC.flag, PRIO_LABEL[String(p.priority || '')] || ''),
        fact(IC.clock, iso(p.updated_at) ? deps.when(iso(p.updated_at)) + ' 고침' : '')),
      sum.total ? sec('태스크', el('em', { text: `${sum.done} / ${sum.total} 끝남` + (sum.doing ? ` · 하는 중 ${sum.doing}` : '') })) : null,
      sum.total ? el('div', { class: 'v2-opv-prog', role: 'img', 'aria-label': `태스크 ${sum.total}개 중 ${sum.done}개 끝남` },
        el('i', { class: 'done', style: `width:${(sum.done / sum.total) * 100}%` }), el('i', { class: 'doing', style: `width:${(sum.doing / sum.total) * 100}%` })) : null,
      shown.length ? el('div', { class: 'v2-opv-rows' }, ...shown.map((t) => el('button', { class: 'v2-opv-trow', type: 'button',
        onclick: (e: MouseEvent) => { e.stopPropagation(); deps.openHref('#/projects2/p/' + t.id, String(t.name || '')); } },
        stateDot(t.status_category), el('span', { class: 'n' }, ...deps.hl(String(t.name || ''))), el('span', { class: 's', text: statusText(t).text }))),
        tasks.length > shown.length ? el('p', { class: 'v2-opv-note', text: `외 ${tasks.length - shown.length}개` }) : null) : null,
      ...bodyEl(String(p.description || ''), 2, '본문'),
      req.length || prod.length ? sec('지식', el('em', { text: [req.length ? `필요 ${req.length}` : '', prod.length ? `산출 ${prod.length}` : ''].filter(Boolean).join(' · ') })) : null,
      req.length || prod.length ? el('div', { class: 'v2-opv-rows' }, ...[...prod.slice(0, 2), ...req.slice(0, 2)].map((k) =>
        linkRow(splitKnowTitle(String(k.title || k.name)).main, () => deps.openHref('#/k/' + encodeURIComponent(String(k.name)), String(k.title || k.name))))) : null,
      sess.length ? sec('이 프로젝트의 세션') : null,
      sess.length ? el('div', { class: 'v2-opv-rows' }, ...sess.map((s) => el('button', { class: 'v2-opv-trow', type: 'button',
        onclick: (e: MouseEvent) => { e.stopPropagation(); deps.openHref('#/s/' + encodeURIComponent(s.id), s.label); } },
        el('span', { class: 'v2-dot ' + dotCls(s.stateKey), 'aria-hidden': 'true' }), el('span', { class: 'n', text: s.label || s.logTitle || s.id }),
        el('span', { class: 's', text: s.lastSeen ? deps.when(s.lastSeen) : '' })))) : null,
    ], [], pill(st.text, st.tone));
  }

  // ── 태스크 ──
  function renderTask(h: PvHit, d: any): void {
    const t = (d && d.task) || {};
    const st = statusText(t);
    const proj = (d && d.project) || null;
    const subs: any[] = t.subtasks || [];
    const sess: any[] = t.sessions || [];
    const checks: any[] = ((d && d.checklists) || []).flatMap((c: any) => c.items || []);
    const checked = checks.filter((c) => c.checked || c.done || c.resolved).length;
    const feed: any[] = ((d && d.feed) || []).slice(-3).reverse();
    const feedText = (f: any): string => {
      if (f.field === 'created') return '만듦';
      if (f.field === 'status') return `상태 ${f.from || ''} → ${f.to || ''}`.trim();
      if (f.kind === 'comment') return '댓글: ' + short(f.body || f.text || '', 60);
      return String(f.label || f.field || '고침');
    };
    frame(h, [
      facts(
        proj ? el('button', { class: 'v2-opv-fact link', type: 'button', title: '상위 프로젝트 열기', onclick: (e: MouseEvent) => { e.stopPropagation(); deps.openHref('#/projects2/p/' + proj.id, String(proj.name || '')); } }, svg(IC.proj), el('span', { text: short(proj.name, 40) })) as HTMLElement : null,
        fact(IC.person, String(t.assignee || '')),
        fact(IC.cal, t.due_date ? dateOnly(t.due_date) + ' 마감' : ''),
        fact(IC.flag, PRIO_LABEL[String(t.priority || '')] || ''),
        fact(IC.clock, iso(t.updated_at) ? deps.when(iso(t.updated_at)) + ' 고침' : '')),
      ...bodyEl(String(t.description || ''), 3, '본문'),
      checks.length ? sec('체크리스트', el('em', { text: `${checked} / ${checks.length}` })) : null,
      subs.length ? sec('하위 태스크', el('em', { text: `${taskSummary(subs).done} / ${subs.length} 끝남` })) : null,
      subs.length ? el('div', { class: 'v2-opv-rows' }, ...subs.slice(0, 5).map((s) => el('div', { class: 'v2-opv-trow' }, stateDot(s.status_category), el('span', { class: 'n' }, ...deps.hl(String(s.name || ''))), el('span', { class: 's', text: statusText(s).text })))) : null,
      sess.length ? sec('이 태스크를 맡은 세션') : null,
      sess.length ? el('div', { class: 'v2-opv-rows' }, ...sess.slice(0, 3).map((s) => el('div', { class: 'v2-opv-trow' }, svg(IC.chat), el('span', { class: 'n', text: String(s.name || s.label || s.title || s.session_id || s.id || '세션') })))) : null,
      feed.length ? sec('최근 활동') : null,
      feed.length ? el('div', { class: 'v2-opv-rows' }, ...feed.map((f) => el('div', { class: 'v2-opv-trow' }, svg(IC.clock),
        el('span', { class: 'n', text: [String(f.display_name || f.actor || ''), feedText(f)].filter(Boolean).join(' · ') }),
        el('span', { class: 's', text: iso(f.ts) ? deps.when(iso(f.ts)) : '' })))) : null,
    ], [], pill(st.text, st.tone));
  }

  // ── 자료 ──
  function renderSrc(h: PvHit, d: any): void {
    const s = (d && d.source) || {};
    const f = s.fields || {};
    const sys = SYS_LABEL[String(s.external_system || '')] || String(s.external_system || '');
    const where = String(f.container_name || f.channel_name || f.repo || f.container_ref || '');
    const who = String(f.author_name || s.author || '').replace(/^connector:.*/, '');
    const state = f.merged_at ? '머지됨' : f.state === 'closed' ? '닫힘' : f.state === 'open' ? '열림' : '';
    const know: any[] = s.knowledge || [];
    const ext = typeof s.external_url === 'string' && /^https?:\/\//.test(s.external_url) ? s.external_url : '';
    const more: HTMLElement[] = ext ? [el('a', { class: 'v2-opv-btn', href: ext, target: '_blank', rel: 'noopener noreferrer', onclick: (e: MouseEvent) => e.stopPropagation() }, svg(IC.ext), el('span', { text: '원본 열기' })) as HTMLElement] : [];
    frame(h, [
      facts(
        fact(IC.link, sys),
        fact(IC.list, where),
        fact(IC.person, who),
        fact(IC.clock, iso(s.occurred_at || s.updated_at) ? deps.when(iso(s.occurred_at || s.updated_at)) : ''),
        fact(IC.chat, Number(s.reply_count) ? `답글 ${s.reply_count}` : ''),
        fact(IC.flag, state)),
      ...bodyEl(String(s.body_md || ''), 3, '본문 앞부분'),
      know.length ? sec('이 자료로 만든 지식', el('em', { text: String(know.length) })) : null,
      know.length ? el('div', { class: 'v2-opv-rows' }, ...know.slice(0, 3).map((k) => linkRow(splitKnowTitle(String(k.title || k.name)).main, () => deps.openHref('#/k/' + encodeURIComponent(String(k.name)), String(k.title || k.name))))) : null,
    ], more);
  }

  // ── 분류 · 리스트 · 폴더 · 글(화면·명령·설정·최근 검색) ──
  function renderCat(h: PvHit, d: any): void {
    const c = (d && d.category) || {};
    const def = String(c.should || c.description || '');
    const lead = leadLines(def, 6, 260);
    const mis = ((d && d.mismatches) || []).length;
    frame(h, [
      facts(fact(IC.tag, String((c.group && c.group.name) || c.group_key || '')), fact(IC.clock, iso(c.updated_at) ? deps.when(iso(c.updated_at)) + ' 고침' : ''), fact(IC.flag, mis ? `자리가 어긋난 지식 ${mis}` : '')),
      lead.length ? sec('이 분류에 들어가는 것') : null,
      lead.length ? el('div', { class: 'v2-opv-blocks' }, el('div', { class: 'v2-opv-block' }, ...lead.map((t) => para('v2-opv-line', t)))) : el('p', { class: 'v2-opv-empty', text: '정의가 아직 없는 분류입니다.' }),
    ]);
  }
  function renderList(h: PvHit, ref: Extract<PvRef, { t: 'list' | 'folder' }>): void {
    const data = deps.data();
    if (ref.t === 'folder') {
      const lists = (data.lists || []).filter((l: any) => Number(l.folder_id) === ref.id);
      frame(h, [
        facts(fact(IC.list, `리스트 ${lists.length}개`)),
        lists.length ? sec('이 폴더의 리스트') : null,
        lists.length ? el('div', { class: 'v2-opv-rows' }, ...lists.slice(0, 8).map((l: any) => el('button', { class: 'v2-opv-trow', type: 'button', onclick: (e: MouseEvent) => { e.stopPropagation(); deps.openHref('#/projects2/l/' + l.id, String(l.name)); } },
          svg(IC.list), el('span', { class: 'n', text: String(l.name) }), el('span', { class: 's', text: l.project_count != null ? `프로젝트 ${l.project_count}` : '' })))) : el('p', { class: 'v2-opv-empty', text: '리스트가 없는 폴더입니다.' }),
      ]);
      return;
    }
    const projs = data.projects.filter((p: any) => Number(p.list_id) === ref.id && !p.trashed_at);
    const live = projs.filter((p: any) => !p.archived_at).sort((a: any, b: any) => iso(b.updated_at) - iso(a.updated_at));
    frame(h, [
      facts(fact(IC.proj, `프로젝트 ${projs.length}개`)),
      live.length ? sec('최근에 고친 프로젝트') : null,
      live.length ? el('div', { class: 'v2-opv-rows' }, ...live.slice(0, 8).map((p: any) => el('button', { class: 'v2-opv-trow', type: 'button', onclick: (e: MouseEvent) => { e.stopPropagation(); deps.openHref('#/projects2/p/' + p.id, String(p.name)); } },
        stateDot(p.status_category), el('span', { class: 'n' }, ...deps.hl(String(p.name || ''))), el('span', { class: 's', text: iso(p.updated_at) ? deps.when(iso(p.updated_at)) : '' })))) : el('p', { class: 'v2-opv-empty', text: '프로젝트가 없는 리스트입니다.' }),
    ]);
  }
  function renderText(h: PvHit, ref: Extract<PvRef, { t: 'text' }>): void {
    frame(h, [el('div', { class: 'v2-opv-blocks' }, el('div', { class: 'v2-opv-block' }, ...ref.lines.filter(Boolean).map((t) => para('v2-opv-line', cleanLine(t, 300)))))]);
  }

  function render(h: PvHit, d: any): void {
    const ref = h.pv!;
    switch (ref.t) {
      case 'sess': renderSess(h, ref, d); break;
      case 'know': renderKnow(h, d); break;
      case 'proj': renderProj(h, ref, d); break;
      case 'task': renderTask(h, d); break;
      case 'src': renderSrc(h, d); break;
      case 'cat': renderCat(h, d); break;
      default: break;
    }
  }

  function show(h: PvHit | null): void {
    const ref = h ? h.pv : undefined;
    const key = ref ? keyOf(ref) : '';
    const st = h ? h.key + '\u0001' + key + '\u0001' + deps.query() : '';
    //  같은 줄 · 같은 검색어면 아무것도 하지 않는다 — 넘겨 보던 자리를 지키고, **가는 중인 요청도 끊지 않는다**(늦게 온 채널이 목록을 다시
    //   그릴 때마다 여기가 불린다 — 그때 기다림을 끊으면 미리보기가 뼈대인 채로 남았다, 캡처로 확인).
    if (h && st === stamp) { cur = h; return; }
    //  줄은 같고 검색어만 바뀌었는데 그 줄의 답이 오는 중이다 — 끊지 않는다. 오면 새 낱말로 그린다(render 는 그때의 낱말을 읽는다).
    if (h && cur && h.key === cur.key && key && key === waitKey) { cur = h; stamp = st; return; }
    //  그 밖에는 다시 그린다 — 줄이 같아도 검색어가 바뀌면 «맞은 곳» 과 색칠이 달라진다(종전엔 같은 줄이면 그냥 돌아가 지식·프로젝트·
    //   명령 줄의 미리보기가 옛 검색어로 굳었다, 격리 리뷰). 받아 둔 답이 있으면 묻지 않는다.
    window.clearTimeout(timer);
    cur = h; stamp = st; waitKey = '';
    convHost = null; convData = null; convRef = null;
    const my = ++seq;
    abort?.abort(); abort = null;
    root.classList.toggle('empty', !h);
    if (!h) { root.replaceChildren(el('p', { class: 'v2-opv-empty big', text: '결과를 고르면 여기에 내용이 보입니다.' })); return; }
    if (!ref) { frame(h, []); return; }
    if (ref.t === 'text') { renderText(h, ref); return; }
    if (ref.t === 'list' || ref.t === 'folder') { renderList(h, ref); return; }
    if (cache.has(key)) { render(h, cache.get(key)); return; }
    if (failed.has(key)) { frame(h, [el('p', { class: 'v2-opv-empty', text: failed.get(key)! })]); return; }
    frame(h, [skeleton()]);
    const url = urlOf(ref);   // 열쇠와 같은 순간의 검색어로 — 기다리는 사이 검색어가 바뀌어도 열쇠와 답이 어긋나지 않는다
    waitKey = key;
    const fail = (e: any): void => {
      waitKey = '';
      const gone = !!e && e.status === 404;
      //  세션의 404 는 «서버에 대화 기록이 아직 없다» 가 흔하다(방금 만든 세션) — 지워졌다고 말하지 않고, 셸이 아는 것을 보인다.
      //   기억하지 않는다: 잠시 뒤 다시 고르면 올라와 있을 수 있다.
      if (gone && ref.t === 'sess') { renderSess(cur || h, ref, null, true); return; }
      const why = gone ? '지금은 볼 수 없는 항목입니다. 지워졌거나 권한이 없습니다.' : '미리보기를 가져오지 못했습니다. 열어서 확인해 주세요.';
      if (gone) failed.set(key, why);
      frame(cur || h, [el('p', { class: 'v2-opv-empty', text: why })]);
    };
    //  고르며 지나가는 줄마다 묻지 않는다 — 잠깐 머문 줄만.
    timer = window.setTimeout(() => {
      const ac = new AbortController();
      abort = ac;
      deps.api(url, { signal: ac.signal }).then((d) => {
        //  끊긴 요청은 답이 아니다 — 본문을 받는 도중 끊기면 api() 가 실패가 아니라 null 로 풀린다(web/lib/net.ts). 그걸 답으로 기억하면
        //   그 줄은 창을 닫을 때까지 빈 칸(세션은 «정리되지 않았습니다» 라는 틀린 말)으로 남는다(격리 리뷰).
        if (ac.signal.aborted || my !== seq) return;
        if (d == null) { fail(null); return; }
        cache.set(key, d);
        if (cache.size > 60) cache.delete(cache.keys().next().value as string);
        waitKey = '';
        render(cur || h, d);
      }, (e: any) => {
        if (ac.signal.aborted || my !== seq || (e && e.name === 'AbortError')) return;
        fail(e);
      });
    }, 110);
  }

  return {
    el: root,
    show,
    nav,
    dispose: () => { window.clearTimeout(timer); abort?.abort(); abort = null; seq++; stamp = ''; waitKey = ''; },
  };
}

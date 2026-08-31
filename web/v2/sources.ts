// v2/sources.ts — 자료 앱(#2423). 라이블리가 가진 **원본**을 출처별로 훑고, 하나를 열어 원문과 내력을 본다.
//
// 왜 이 앱인가(설계 `sources-app-design-2423`): 자료는 지식(WIKI)의 셋째 탭에 얹혀 있어 자기 주소가 없었고,
//  화면이 4열 표 하나라 «어디서 왔나» 를 말하지 못했다. 사람이 여기 오는 이유는 상태(증류 여부)가 아니라
//  ① 내가 올린 파일을 다시 찾으려고 ② AI 가 한 말의 근거(출처)를 보려고 ③ 옛 대화를 찾으려고 ④ 뭘 모으는지 확인하려고다.
//  그래서 뼈대는 **왼쪽 출처 나무**(폴더·채널·저장소가 그대로 가지)이고, 목록 열은 **출처마다 바뀐다**.
//  증류 사각지대 관리는 이 앱이 하지 않는다 — 그건 「맥락 관리 ▸ 지식 만들기」의 몫이다(v1 반려로 확정).
import { api, busy, el, errorNote, relTime, renderMarkdown, safeHref, state, toast } from '../core.js';

// ── 자료 한 건(목록용 얕은 행) ─────────────────────────────────────────────
export interface SrcRow {
  id: number; kind: string; title: string | null; provenance: string;
  external_system: string | null; external_url: string | null;
  occurred_at: string | null; updated_at: string | null;
  fields: Record<string, any> | null;
  has_knowledge?: boolean;
  visibility?: string;
  parent_external_id?: string | null;
}
export interface SrcTreeNode { system: string; container: string | null; n: number; linked: number; newest: string | null }

/** 출처 이름 — external_system 은 기계 이름이라 그대로 보여 주지 않는다. 'authored' 는 사람이 직접 넣은 것. */
const SYS_LABEL: Record<string, string> = {
  slack: '슬랙', discord: '디스코드', github: '깃허브', gitlab: '깃랩', linear: '리니어', figma: '피그마',
  notion: '노션', clickup: '클릭업', gdrive: '구글드라이브', gmail: '지메일', local: '내 컴퓨터',
  'domain-wiki': '도메인 위키', authored: '적어 둔 것',
};
const KIND_LABEL: Record<string, string> = {
  transcript: '전사록', minutes: '회의록', email: '이메일', slack: '슬랙', discord: '디스코드',
  notion_doc: '노션', clickup_doc: '클릭업', drive_file: '구글드라이브', local_file: '파일',
  figma_comment: '피그마 코멘트', github_issue: '깃허브', gitlab_issue: '깃랩', linear_issue: '리니어', other: '기타',
};
const sysLabel = (s: string): string => SYS_LABEL[s] || s;
const kindLabel = (k: string): string => KIND_LABEL[k] || k;

/** 출처 나무의 차례 — 사람이 준 것이 위, 기계가 모은 것이 아래. 같은 무게면 건수 순. */
const SYS_ORDER = ['local', 'authored', 'slack', 'discord', 'github', 'gitlab', 'linear', 'figma', 'notion', 'gdrive', 'gmail', 'clickup'];
const sysRank = (s: string): number => { const i = SYS_ORDER.indexOf(s); return i < 0 ? SYS_ORDER.length : i; };

function bytesText(n: unknown): string {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

/** 파일 자료가 실제로 읽혔나 — 증류가 볼 수 있는 상태인지를 사람 말로. local_kind 는 ingest/local-file-core.ts 가 정한다.
 *  열은 좁으니 한 낱말로 쓰고, 사연은 툴팁(why)에 둔다 — 목록에서 문장이 길면 파일 이름을 밀어낸다(#2423 실측). */
function readState(f: Record<string, any>): { text: string; why: string; tone: '' | 'no' | 'later' } {
  const k = String(f.local_kind || '');
  if (k === 'vision') return { text: '그림', why: '글자가 없는 그림입니다. AI 가 필요할 때 원본을 열어 읽습니다.', tone: 'later' };
  if (k === 'unreadable') return { text: '못 읽음', why: '이 형식은 글자를 뽑지 못했습니다. PDF 로 저장해 다시 올리면 읽습니다.', tone: 'no' };
  if (f.extracted === false) return { text: '아직', why: '아직 글자를 뽑지 않았습니다.', tone: 'later' };
  return { text: '읽음', why: '글자를 뽑아 두었습니다 — 검색과 지식 만들기에 쓰입니다.', tone: '' };
}

const authorOf = (r: SrcRow): string => String((r.fields || {}).author_name || '');
const containerOf = (r: SrcRow): string => String((r.fields || {}).container_name || '');
const isBot = (r: SrcRow): boolean => (r.fields || {}).author_is_bot === true;

// ── 선택(나무에서 고른 자리) ────────────────────────────────────────────────
export interface SrcSel { system?: string; container?: string; author?: string; linked?: boolean; q?: string }

function selQuery(sel: SrcSel, extra?: Record<string, string>): string {
  const p = new URLSearchParams();
  if (sel.system) p.set('system', sel.system);
  if (sel.container) p.set('container', sel.container);
  if (sel.author) p.set('author', sel.author);
  if (sel.linked !== undefined) p.set('linked', String(sel.linked));
  if (sel.q) p.set('q', sel.q);
  for (const [k, v] of Object.entries(extra || {})) p.set(k, v);
  return p.toString();
}
/** 주소는 선택을 담는다 — 채널 하나를 사람에게 링크로 줄 수 있어야 한다(북마크·공유). */
export function sourcesHref(sel: SrcSel): string {
  const qs = selQuery(sel);
  return '#/sources' + (qs ? '?' + qs : '');
}
export function selFromParams(params: URLSearchParams): SrcSel {
  const sel: SrcSel = {};
  const g = (k: string) => params.get(k) || undefined;
  sel.system = g('system'); sel.container = g('container'); sel.author = g('author'); sel.q = g('q');
  const l = params.get('linked');
  if (l === 'true' || l === 'false') sel.linked = l === 'true';
  return sel;
}

/** 나 자신 — 「내가 올린 것」이 쓰는 값. 업로드 자료의 author_name 은 이메일이다(ingest/local-file.ts). */
function myUploadName(): string | null {
  const me: any = state.me;
  return (me && (me.email || me.member_id)) ? String(me.email || me.member_id) : null;
}

// ════════════════════════════════════════════════════════════════════════
// 목록 화면
// ════════════════════════════════════════════════════════════════════════
const PAGE = 60;

// ── 앱 안 이동은 앱이 처리한다 ──────────────────────────────────────────────
//  자료는 **한 창 안에서 돌아다니는 앱**이라 셸의 탭 키가 `#/sources…` 를 한 화면으로 접는다(tabs.ts routeKey).
//  그 덕에 채널을 옮겨도 탭·좌측 행이 안 늘지만, 대신 **셸이 «같은 화면»이라 보고 다시 그리지 않는다** —
//  종전엔 출처를 골라도 목록이 그대로였다(#2423 dev 실측). 그래서 주소 변화를 이 앱이 직접 듣는다.
//  ⚠ 창이 닫히면 host 가 DOM 에서 빠진다 — 그때는 아무것도 하지 않는다(리스너는 모듈에 하나뿐이라 새지 않는다).
let mounted: HTMLElement | null = null;
let lastDrawn = '';

function drawFor(host: HTMLElement, hash: string): void {
  const h = hash.replace(/^#\/?/, '');
  const qi = h.indexOf('?');
  const segs = (qi >= 0 ? h.slice(0, qi) : h).split('/').filter(Boolean);
  if (segs[0] !== 'sources') return;                       // 다른 화면으로 갔다 — 셸의 몫
  const params = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : '');
  lastDrawn = hash;
  if (segs[1]) { paintDetail(host, Number(decodeURIComponent(segs[1]))); return; }
  const sel = selFromParams(params);
  const treeHost = el('nav', { class: 'v2-src-tree', 'aria-label': '자료 출처' });
  const boardHost = el('div', { class: 'v2-src-board' });
  host.replaceChildren(el('div', { class: 'v2-src' }, treeHost, boardHost));
  void paintTree(treeHost, sel);
  void paintList(boardHost, sel);
}

window.addEventListener('hashchange', () => {
  if (!mounted || !document.contains(mounted)) { mounted = null; return; }
  if (location.hash === lastDrawn) return;                 // 셸이 이미 그린 뒤면 두 번 그리지 않는다
  drawFor(mounted, location.hash);
});

export function renderSourcesApp(host: HTMLElement, params: URLSearchParams): void {
  mounted = host;
  drawFor(host, location.hash.startsWith('#/sources') ? location.hash : '#/sources?' + params.toString());
}

// ── 왼쪽: 출처 나무 ────────────────────────────────────────────────────────
async function paintTree(host: HTMLElement, sel: SrcSel): Promise<void> {
  busy(host, el('div', { class: 'v2-src-tskel' }));
  let nodes: SrcTreeNode[] = [];
  try { const r: any = await api('/api/ui/sources/tree'); nodes = (r && r.nodes) || []; }
  catch (e: any) { host.replaceChildren(errorNote(e, '출처를 불러오지 못했습니다')); return; }

  const total = nodes.reduce((a, n) => a + n.n, 0);
  const linked = nodes.reduce((a, n) => a + n.linked, 0);
  const bySys = new Map<string, SrcTreeNode[]>();
  for (const n of nodes) { const a = bySys.get(n.system) || []; a.push(n); bySys.set(n.system, a); }
  const systems = [...bySys.keys()].sort((a, b) => {
    const ra = sysRank(a), rb = sysRank(b);
    if (ra !== rb) return ra - rb;
    return (bySys.get(b) || []).reduce((x, n) => x + n.n, 0) - (bySys.get(a) || []).reduce((x, n) => x + n.n, 0);
  });

  const rows: HTMLElement[] = [];
  const isAll = !sel.system && !sel.author && sel.linked === undefined;
  rows.push(treeRow({ label: '모든 자료', n: total, href: sourcesHref({}), on: isAll, icon: 'box', top: true }));

  const mine = myUploadName();
  const quick: HTMLElement[] = [];
  let mineRow: HTMLElement | null = null;
  if (mine) {
    //  나무 집계는 출처 × 자리라 사람 축이 없다 — 이 한 줄만 따로 센다(total 만 쓰므로 limit=1).
    //   건수가 없는 줄이 하나 끼면 나머지가 다 있는 만큼 «못 센 것»으로 읽힌다.
    mineRow = treeRow({ label: '내가 올린 것', href: sourcesHref({ system: 'local', author: mine }),
      on: sel.system === 'local' && sel.author === mine, icon: 'up' });
    quick.push(mineRow);
  }
  quick.push(treeRow({ label: '지식이 된 것', n: linked, href: sourcesHref({ linked: true }),
    on: sel.linked === true && !sel.system, icon: 'doc' }));
  if (quick.length) { rows.push(el('div', { class: 'v2-src-tk', text: '빠른 자리' }), ...quick); }
  rows.push(el('div', { class: 'v2-src-thr' }));

  for (const sys of systems) {
    const kids = (bySys.get(sys) || []).sort((a, b) => b.n - a.n);
    const sum = kids.reduce((a, n) => a + n.n, 0);
    rows.push(treeRow({ label: sysLabel(sys), n: sum, href: sourcesHref({ system: sys }),
      on: sel.system === sys && !sel.container && !sel.author, icon: sysIconKey(sys), grp: true }));
    for (const k of kids) {
      if (!k.container) continue;                       // 자리 이름이 없는 자료는 출처 가지에서 함께 보인다
      rows.push(treeRow({ label: k.container, n: k.n, href: sourcesHref({ system: sys, container: k.container }),
        on: sel.system === sys && sel.container === k.container, sub: true }));
    }
  }
  host.replaceChildren(...rows);
  //  건수는 늦게 와도 된다 — 나무가 먼저 서고 숫자가 따라 붙는다(못 세면 그 줄만 숫자 없이 남는다).
  if (mine && mineRow) {
    void api('/api/ui/sources?' + selQuery({ system: 'local', author: mine }, { limit: '1' }))
      .then((r: any) => { const n = Number(r && r.total); if (mineRow && Number.isFinite(n)) mineRow.append(el('span', { class: 'n', text: String(n) })); })
      .catch(() => { /* 못 세도 줄은 선다 */ });
  }
}

function treeRow(o: { label: string; n?: number; href: string; on?: boolean; icon?: string; grp?: boolean; sub?: boolean; top?: boolean }): HTMLElement {
  const cls = 'v2-src-trow'
    + (o.grp ? ' grp' : '') + (o.sub ? ' sub' : '') + (o.top ? ' top' : '') + (o.on ? ' on' : '');
  return el('a', { class: cls, href: o.href, 'aria-current': o.on ? 'page' : null },
    o.sub ? null : el('span', { class: 'ic' }, treeIcon(o.icon || 'dot')),
    el('span', { class: 'nm', text: o.label, title: o.label }),
    o.n === undefined ? null : el('span', { class: 'n', text: String(o.n) }));
}

const sysIconKey = (s: string): string =>
  s === 'local' ? 'disk' : s === 'authored' ? 'note' : s === 'github' || s === 'gitlab' ? 'repo'
  : s === 'slack' || s === 'discord' ? 'chat' : 'dot';

/** 나무 아이콘 — 16px 자리라 선 글리프다(유리는 런치패드 64px 전용, `app-icon-design-system-glass-1841`). */
function treeIcon(key: string): SVGElement {
  const D: Record<string, string> = {
    box: 'M10 4h5.5L19 7.5V19a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M15.5 4v3.5H19 M5.6 6.4 3.7 16.6a1 1 0 0 0 .8 1.2l3.2.6',
    up: 'M12 16V5M7 10l5-5 5 5M4 19h16',
    doc: 'M6 4h9l3 3v13H6zM15 4v4h3',
    disk: 'M3 5h18v12H3zM8 20h8',
    note: 'M5 4h14v16H5zM9 9h6M9 13h4',
    repo: 'M6 3h9l4 4v14H6zM9 12h7M9 16h5',
    chat: 'M4 5h16v11H9l-4 3z',
    dot: 'M12 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z',
  };
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '15'); svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', D[key] || D.dot);
  svg.append(p);
  return svg;
}

// ── 오른쪽: 고른 자리의 목록 ──────────────────────────────────────────────
async function paintList(host: HTMLElement, sel: SrcSel): Promise<void> {
  const listBox = el('div', { class: 'v2-src-list' });
  const moreBox = el('div', { class: 'v2-src-more' });
  const factLine = el('div', { class: 'v2-src-fact' });

  const qIn = el('input', { class: 'v2-src-q', type: 'search', value: sel.q || '',
    placeholder: sel.system === 'local' ? '파일 이름·내용에서 찾기' : '원문에서 찾기', 'aria-label': '자료 검색' }) as HTMLInputElement;
  let t: any = null;
  qIn.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { location.hash = sourcesHref({ ...sel, q: qIn.value.trim() || undefined }); }, 300);
  });

  host.replaceChildren(
    el('div', { class: 'v2-src-hd' },
      crumb(sel),
      factLine,
      el('div', { class: 'v2-src-tb' },
        el('span', { class: 'v2-src-qbox' }, searchGlyph(), qIn),
        el('span', { class: 'v2-src-sp' }),
        sel.linked === undefined
          ? el('a', { class: 'v2-src-chip', href: sourcesHref({ ...sel, linked: true }), text: '지식이 된 것만' })
          : el('a', { class: 'v2-src-chip on', href: sourcesHref({ ...sel, linked: undefined }), text: '지식이 된 것만' }))),
    listBox, moreBox);

  const cols = columnsFor(sel);
  let offset = 0, loading = false, total = 0;

  async function load(reset: boolean): Promise<void> {
    if (loading) return;
    loading = true;
    if (reset) { offset = 0; busy(listBox, el('div', { class: 'v2-src-skel' })); moreBox.replaceChildren(); }
    try {
      const qs = selQuery(sel, { limit: String(PAGE), offset: String(offset) });
      const r: any = await api('/api/ui/sources?' + qs);
      const entries: SrcRow[] = (r && r.entries) || [];
      total = Number(r && r.total) || 0;
      if (reset) {
        listBox.replaceChildren();
        if (!entries.length) {
          listBox.append(emptyNote(sel));
          factLine.replaceChildren(...factOf(sel, 0, 0));
          return;
        }
        listBox.append(el('div', { class: 'v2-src-colhead', style: 'grid-template-columns:' + cols.grid },
          ...cols.head.map((h, i) => el('div', { class: i === cols.head.length - 1 ? 'r' : '', text: h }))));
        factLine.replaceChildren(...factOf(sel, total, entries.reduce((a, e) => a + (e.has_knowledge ? 1 : 0), 0)));
      }
      for (const s of entries) listBox.append(rowOf(s, cols));
      offset += entries.length;
      if (r && r.has_more) {
        const btn = el('button', { class: 'btn btn-sm', type: 'button', text: `더 보기 (${offset}/${total})` });
        btn.addEventListener('click', () => { void load(false); });
        moreBox.replaceChildren(btn);
      } else {
        moreBox.replaceChildren(el('span', { class: 'v2-src-count', text: `${total}건을 다 보고 있습니다.` }));
      }
    } catch (e: any) {
      if (reset) listBox.replaceChildren(errorNote(e, '자료를 불러오지 못했습니다'));
    } finally { loading = false; }
  }
  void load(true);
}

function crumb(sel: SrcSel): HTMLElement {
  const parts: HTMLElement[] = [];
  const sep = () => el('span', { class: 'sep', text: '›' });
  if (!sel.system && sel.linked === undefined && !sel.author) {
    parts.push(el('span', { class: 'leaf', text: '모든 자료' }));
  } else {
    parts.push(el('a', { class: 'up', href: sourcesHref({}), text: '자료' }));
    if (sel.linked === true && !sel.system) { parts.push(sep(), el('span', { class: 'leaf', text: '지식이 된 것' })); }
    if (sel.system) {
      parts.push(sep());
      const last = !sel.container;
      const lbl = sel.author && sel.system === 'local' ? '내가 올린 것' : sysLabel(sel.system);
      parts.push(last ? el('span', { class: 'leaf', text: lbl }) : el('a', { class: 'up', href: sourcesHref({ system: sel.system }), text: lbl }));
      if (sel.container) parts.push(sep(), el('span', { class: 'leaf mono', text: sel.container }));
    }
  }
  return el('div', { class: 'v2-src-crumb' }, ...parts);
}

/** 그 자리의 사실 한 줄 — «무엇이 · 얼마나 · 누가 보나». 파이프라인 대시보드가 아니라 이 한 줄이 4번 용도를 받는다. */
function factOf(sel: SrcSel, total: number, linkedShown: number): Node[] {
  const n = (t: string) => el('b', { class: 'm', text: t });
  if (sel.system === 'local') {
    return [document.createTextNode('사람이 올린 파일 '), n(String(total)), document.createTextNode('개입니다. 개인 폴더에 올린 것은 올린 사람만 봅니다. 프로젝트 폴더에 올린 것도 여기 함께 있습니다.')];
  }
  if (sel.system === 'authored') {
    return [document.createTextNode('세션과 사람이 직접 남긴 원본 '), n(String(total)), document.createTextNode('건입니다.')];
  }
  if (sel.linked === true) {
    return [document.createTextNode('지식이 만들어진 자료 '), n(String(total)), document.createTextNode('건입니다. 자료를 열면 그 지식으로 갈 수 있습니다.')];
  }
  if (sel.system) {
    return [document.createTextNode(sysLabel(sel.system) + ' 에서 모은 원본 '), n(String(total)),
      document.createTextNode('건입니다' + (sel.container ? ` · ${sel.container}` : '') + '.')];
  }
  return [document.createTextNode('라이블리가 가진 원본 '), n(String(total)), document.createTextNode('건입니다. 왼쪽에서 출처를 고르면 그 자리만 봅니다.'),
    ...(linkedShown ? [] : [])];
}

function emptyNote(sel: SrcSel): HTMLElement {
  const msg = sel.q ? '찾는 말이 든 자료가 없습니다.'
    : sel.system === 'local' ? '아직 올린 파일이 없습니다. 프로젝트 폴더나 세션에 파일을 올리면 여기 모입니다.'
    : '이 자리에는 아직 자료가 없습니다.';
  return el('div', { class: 'v2-src-empty', text: msg });
}

// ── 출처마다 다른 열 ──────────────────────────────────────────────────────
interface Cols { grid: string; head: string[]; cells: (r: SrcRow) => (Node | null)[] }

function columnsFor(sel: SrcSel): Cols {
  const sys = sel.system;
  const txt = (t: string, cls = 'c') => el('span', { class: cls, text: t });
  const at = (r: SrcRow) => el('span', { class: 'at', text: relTime(r.occurred_at || r.updated_at) });

  if (sys === 'local') {
    return {
      grid: 'minmax(0, 1fr) 124px 66px 70px 104px 66px',
      head: ['파일', '폴더', '크기', '읽었나', '올린 사람', '언제'],
      cells: (r) => {
        const f = r.fields || {};
        const rs = readState(f);
        return [
          null,
          txt(containerOf(r), 'c mono'),
          el('span', { class: 'c mono r', text: bytesText(f.bytes) }),
          el('span', { class: 'c read' + (rs.tone ? ' ' + rs.tone : ''), text: rs.text, title: rs.why }),
          txt(shortPerson(authorOf(r))),
          at(r),
        ];
      },
    };
  }
  if (sys === 'github' || sys === 'gitlab' || sys === 'linear') {
    return {
      grid: 'minmax(0, 1fr) 74px 84px 92px 108px 66px',
      head: ['자료', '번호', '종류', '상태', '쓴 사람', '언제'],
      cells: (r) => {
        const f = r.fields || {};
        const num = f.number ? '#' + f.number : '';
        const k = String(f.kind || '');
        const kl = k === 'pr' ? 'PR' : k === 'mr' ? 'MR' : k === 'issue' ? '이슈' : k === 'release' ? '릴리스'
          : k.includes('comment') || k === 'note' || k === 'mr_note' ? '댓글' : kindLabel(r.kind);
        return [
          null,
          el('span', { class: 'c mono', text: num }),
          txt(kl),
          ghState(f),
          txt(shortPerson(authorOf(r)) + (isBot(r) ? ' · 봇' : '')),
          at(r),
        ];
      },
    };
  }
  if (sys === 'slack' || sys === 'discord') {
    const withChan = !sel.container;
    return {
      grid: withChan ? 'minmax(0, 1fr) 150px 118px 66px' : 'minmax(0, 1fr) 132px 66px',
      head: withChan ? ['자료', '채널', '쓴 사람', '언제'] : ['자료', '쓴 사람', '언제'],
      cells: (r) => [
        null,
        ...(withChan ? [txt('#' + containerOf(r), 'c mono')] : []),
        txt(shortPerson(authorOf(r)) + (isBot(r) ? ' · 봇' : '')),
        at(r),
      ],
    };
  }
  if (sys === 'authored') {
    return {
      grid: 'minmax(0, 1fr) 118px 66px',
      head: ['자료', '종류', '언제'],
      cells: (r) => [null, txt(kindLabel(r.kind)), at(r)],
    };
  }
  // 섞인 목록(모든 자료·지식이 된 것) — 여기서만 «어디서» 열이 선다.
  return {
    grid: 'minmax(0, 1fr) 168px 116px 66px',
    head: ['자료', '어디서', '누가', '언제'],
    cells: (r) => [
      null,
      el('span', { class: 'c src' },
        el('span', { class: 'v2-src-badge', text: sysLabel(r.external_system || 'authored') }),
        containerOf(r) ? el('span', { class: 'mono', text: containerOf(r) }) : null),
      txt(shortPerson(authorOf(r)) + (isBot(r) ? ' · 봇' : '')),
      at(r),
    ],
  };
}

function ghState(f: Record<string, any>): HTMLElement {
  if (f.merged_at) return el('span', { class: 'v2-src-st merged', text: '머지됨' });
  const s = String(f.state || '');
  if (s === 'open') return el('span', { class: 'v2-src-st open', text: '열림' });
  if (s === 'closed') return el('span', { class: 'v2-src-st closed', text: '닫힘' });
  return el('span', { class: 'c', text: '' });
}

/** 사람 이름 — 업로드 자료의 author_name 은 이메일이라 앞부분만 쓴다(열이 좁다). */
function shortPerson(s: string): string {
  if (!s) return '';
  const at = s.indexOf('@');
  return at > 0 ? s.slice(0, at) : s;
}

function rowOf(r: SrcRow, cols: Cols): HTMLElement {
  const f = r.fields || {};
  const cells = cols.cells(r);
  const priv = r.visibility === 'members' || String(f.root || '') === 'personal';
  const title = el('span', { class: 'v2-src-t' },
    el('span', { class: 'tick' + (r.has_knowledge ? ' on' : ''), title: r.has_knowledge ? '이 자료로 지식이 만들어졌습니다' : null }),
    el('span', { class: 'ttl', text: r.title || `자료 #${r.id}`, title: r.title || '' }),
    priv ? lockGlyph() : null);
  return el('a', { class: 'v2-src-row', href: '#/sources/' + r.id, style: 'grid-template-columns:' + cols.grid },
    title, ...cells.slice(1).map((c) => c || el('span', {})));
}

function searchGlyph(): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '15'); svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('aria-hidden', 'true');
  const c = document.createElementNS(ns, 'circle'); c.setAttribute('cx', '11'); c.setAttribute('cy', '11'); c.setAttribute('r', '7');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', 'M20 20l-3.5-3.5');
  svg.append(c, p);
  return svg;
}
function lockGlyph(): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '13'); svg.setAttribute('height', '13');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('class', 'v2-src-lock'); svg.setAttribute('stroke-linecap', 'round');
  const r = document.createElementNS(ns, 'rect');
  r.setAttribute('x', '5'); r.setAttribute('y', '10'); r.setAttribute('width', '14'); r.setAttribute('height', '10'); r.setAttribute('rx', '2');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', 'M8 10V7a4 4 0 0 1 8 0v3');
  svg.append(r, p);
  const t = document.createElementNS(ns, 'title'); t.textContent = '올린 사람만 봅니다';
  svg.append(t);
  return svg;
}

// ════════════════════════════════════════════════════════════════════════
// 자료 하나 — 원문이 주인공이다
// ════════════════════════════════════════════════════════════════════════
export function renderSourceDetail(host: HTMLElement, id: number): void {
  mounted = host;
  lastDrawn = location.hash;
  paintDetail(host, id);
}

function paintDetail(host: HTMLElement, id: number): void {
  const box = el('div', { class: 'v2-src-detail' });
  host.replaceChildren(box);
  busy(box, el('div', { class: 'v2-src-skel' }));
  void (async () => {
    let s: any;
    try { const r: any = await api('/api/ui/sources/' + id); s = (r && r.source) || r; }
    catch (e: any) { box.replaceChildren(errorNote(e, '자료를 불러오지 못했습니다')); return; }
    box.replaceChildren(detailSheet(s));
  })();
}

function detailSheet(s: any): HTMLElement {
  const f: Record<string, any> = s.fields || {};
  const sys = String(s.external_system || 'authored');
  const chan = String(f.container_name || '');
  const isFile = s.kind === 'local_file';
  const isChat = sys === 'slack' || sys === 'discord';
  const priv = String(f.root || '') === 'personal' || s.visibility === 'members';
  const derived: any[] = s.knowledge || [];

  const head = el('div', { class: 'v2-src-dcrumb' },
    el('a', { class: 'up', href: sourcesHref({}), text: '자료' }),
    el('span', { class: 'sep', text: '›' }),
    el('a', { class: 'up', href: sourcesHref({ system: sys }), text: sysLabel(sys) }),
    ...(chan ? [el('span', { class: 'sep', text: '›' }),
      el('a', { class: 'up mono', href: sourcesHref({ system: sys, container: chan }), text: chan })] : []),
    el('span', { class: 'addr', text: '#/sources/' + s.id }));

  const meta = el('div', { class: 'v2-src-dmeta' },
    el('span', { class: 'v2-src-badge', text: kindLabel(s.kind) }),
    ...(chan ? [el('span', { class: 'mono', text: (isChat ? '#' : '') + chan })] : []),
    ...(isFile && f.bytes ? [el('span', { class: 'mono', text: bytesText(f.bytes) })] : []),
    ...(authorOf(s as SrcRow) ? [el('span', { text: shortPerson(authorOf(s as SrcRow)) + (isFile ? ' 님이 올렸습니다' : '') })] : []),
    el('span', { class: 'mono', text: absLike(s.occurred_at || s.updated_at) }),
    el('span', { class: 'vis' }, priv ? '올린 사람만 봅니다' : '이 워크스페이스 사람 모두가 봅니다'));

  //  원본으로 가는 문 — 파일 자료의 external_url 은 **우리 앱 안 주소**(#/f?root=…)라 새 탭으로 열지 않는다.
  //   ⚠ 자료의 원본 파일 자체를 내려받는 REST 는 없다(source_artifact 는 MCP 전용) — 없는 문을 그리지 않는다.
  const acts = el('div', { class: 'v2-src-dacts' });
  const url = s.external_url ? String(s.external_url) : '';
  if (url.startsWith('#')) {
    acts.append(el('a', { class: 'btn btn-sm v2-src-primary', href: url, text: '폴더에서 열기' }));
  } else if (url) {
    acts.append(el('a', { class: 'btn btn-sm v2-src-primary', href: safeHref(url) || '#',
      target: '_blank', rel: 'noopener', text: sysLabel(sys) + '에서 열기' }));
  }

  const knBox = derived.length
    ? el('div', { class: 'v2-src-kn' },
        el('span', { class: 'k', text: '여기서 나온 지식' }),
        el('div', { class: 'v' }, ...derived.map((d: any) =>
          el('a', { class: 'kl', href: '#/k/' + encodeURIComponent(d.name), text: d.title || d.name }))))
    : el('div', { class: 'v2-src-knnone', text: '이 자료에서 나온 지식은 아직 없습니다.' });

  //  ★ [BINARY] 스텁은 **증류 세션에게 주는 쪽지**다(«source_artifact 로 원본을 받아…»). 사람 화면에 그대로 두면
  //   자기 파일을 열었는데 기계 지시문을 읽게 된다(#2423 실측). 파일의 사실만 사람 말로 다시 쓴다.
  const body = String(s.body_md || '');
  const stub = body.startsWith('[BINARY]');
  const rs = isFile ? readState(f) : null;
  const bodyBox = stub
    ? el('div', { class: 'v2-src-body v2-src-stub' },
        el('p', { class: 'h', text: rs ? rs.why : '글자가 없는 파일입니다.' }),
        el('p', { class: 'sub', text: [kindLabel(s.kind), String(f.ext || '').toUpperCase(), bytesText(f.bytes)].filter(Boolean).join(' · ') }))
    : el('div', { class: 'v2-src-body md-rendered' }, renderMarkdown(body || '(본문 없음)'));

  const thread: HTMLElement[] = [];
  if (s.parent) {
    thread.push(el('div', { class: 'v2-src-seck', text: '이 자료가 달린 곳' }),
      el('div', { class: 'v2-src-nbs' }, refRow(s.parent, '상위')));
  }
  if (s.replies && s.replies.length) {
    thread.push(el('div', { class: 'v2-src-seck', text: `이어진 자료 · ${s.reply_count || s.replies.length}건` }),
      el('div', { class: 'v2-src-nbs' }, ...s.replies.map((r: any) => refRow(r, ''))));
  }

  return el('div', { class: 'v2-src-sheet' },
    head,
    el('h1', { class: 'v2-src-h1', text: s.title || `자료 #${s.id}` }),
    meta,
    acts.childElementCount ? acts : null,
    knBox,
    el('div', { class: 'v2-src-seck', text: '원문' }),
    bodyBox,
    ...thread);
}

function refRow(r: any, tag: string): HTMLElement {
  const f = r.fields || {};
  const sub = kindLabel(r.kind) + (f.container_name ? ' · ' + f.container_name : '') + (f.author_name ? ' · ' + shortPerson(String(f.author_name)) : '');
  return el('a', { class: 'v2-src-nb', href: '#/sources/' + r.id },
    tag ? el('span', { class: 'ar', text: tag }) : null,
    el('span', { class: 'tt', text: r.title || `자료 #${r.id}` }),
    el('span', { class: 'sb', text: sub }));
}

/** 상세의 시각 — 목록은 상대시각(3분 전)이지만 상세는 «언제 있었던 일인지»가 사실이라 절대시각이다. */
function absLike(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 목록·상세가 쓰는 안내 — 자료를 지운 뒤 목록으로 돌아가는 자리에서 쓴다. */
export function sourcesToast(msg: string): void { toast(msg); }

// v2/sources.ts — 자료 앱(#2423) **열람실 판**. 라이블리가 가진 원본을 훑으며 읽는다.
//
// 왜 이 모양인가(v3 확정, 원준 2026-09-01 «2안 좋음»):
//  · **사이드바 칸은 이 앱의 것이다** — 자료를 여는 순간 셸의 왼쪽 316px 이 자료의 나무(내 자료·수집함)가 된다.
//    v2 는 나무를 본창 안에 그려서 옆에 남의(AI 세션) 목록이 계속 서 있었다 — 앱 소유 사이드바 개념의 오독이었다.
//  · **주인공은 내가 올린 파일이다** — 나무의 첫 자리가 「내 자료」, 수집함(슬랙·깃허브…)은 그 아래.
//  · 본창은 **열람실**: 왼쪽 촘촘한 목록 + 오른쪽 항상 열린 원문. ↑↓로 다음 자료, 화면 전환 없이 훑는다.
//    파일은 공용 미리보기(lib/file-preview — 홈 모달·#/f 와 같은 코드)로 원문 그대로, 내려받기·폴더 문이 머리에 선다.
//  · 분류·작동 방식은 v2 그대로다 — 출처 나무 · 출처마다 다른 목록 메타 · 민트 점(지식 연결) · 주소가 정본.
//
// 주소: `#/sources?<선택>` = 그 자리의 목록(첫 줄이 자동으로 열린다) · `#/sources/<id>?<선택>` = 그 자료를 읽는 중.
//  선택(query)이 함께 실려 채널 하나·자료 하나를 링크로 줄 수 있다(북마크·공유).
import { TOKEN_KEY, api, apiUrl, busy, el, errorNote, relTime, renderMarkdown, safeHref, state, toast } from '../core.js';
import { buildFilePreview } from '../lib/file-preview.js';   // 미리보기 판정·렌더의 단일 소유(#/f·홈 모달과 같은 코드)
import { authDownload, authUploadProgress } from '../projects/files-upload.js';
import { appGlassIcon } from './apps.js';

// ── 자료 한 건(목록용 얕은 행) ─────────────────────────────────────────────
export interface SrcRow {
  id: number; kind: string; title: string | null; provenance: string;
  external_system: string | null; external_url: string | null;
  occurred_at: string | null; updated_at: string | null;
  fields: Record<string, any> | null;
  has_knowledge?: boolean;
  visibility?: string;
  parent_external_id?: string | null;
  reply_n?: number;     // fold 목록 전용 — 이 대화에 이어진 답글 수
  body_len?: number;    // fold 목록 전용 — 잡음(한 줄짜리) 판정용 본문 길이
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

/** 수집함 나무의 차례 — 대화가 위, 기록계가 아래. (내 자료는 나무 밖 첫 구역이라 local 은 여기 안 온다.) */
const SYS_ORDER = ['slack', 'discord', 'authored', 'github', 'gitlab', 'linear', 'figma', 'notion', 'gdrive', 'gmail', 'clickup'];
const sysRank = (s: string): number => { const i = SYS_ORDER.indexOf(s); return i < 0 ? SYS_ORDER.length : i; };

function bytesText(n: unknown): string {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

/** 파일 자료가 실제로 읽혔나 — 한 낱말 + 사연은 툴팁. local_kind 는 ingest/local-file-core.ts 가 정한다. */
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

/** 사람 이름 — 업로드 자료의 author_name 은 이메일이라 앞부분만 쓴다(칸이 좁다). */
function shortPerson(s: string): string {
  if (!s) return '';
  const at = s.indexOf('@');
  return at > 0 ? s.slice(0, at) : s;
}

// ── 선택(나무에서 고른 자리) ────────────────────────────────────────────────
export interface SrcSel { system?: string; container?: string; author?: string; root?: string; linked?: boolean; q?: string }

function selQuery(sel: SrcSel, extra?: Record<string, string>): string {
  const p = new URLSearchParams();
  if (sel.system) p.set('system', sel.system);
  if (sel.container) p.set('container', sel.container);
  if (sel.author) p.set('author', sel.author);
  if (sel.root) p.set('root', sel.root);
  if (sel.linked !== undefined) p.set('linked', String(sel.linked));
  if (sel.q) p.set('q', sel.q);
  for (const [k, v] of Object.entries(extra || {})) p.set(k, v);
  return p.toString();
}
/** 주소는 선택(+ 읽는 자료)을 담는다 — 채널·자료 하나를 링크로 줄 수 있어야 한다. */
export function sourcesHref(sel: SrcSel, id?: number | null): string {
  const qs = selQuery(sel);
  return '#/sources' + (id ? '/' + id : '') + (qs ? '?' + qs : '');
}
export function selFromParams(params: URLSearchParams): SrcSel {
  const sel: SrcSel = {};
  const g = (k: string) => params.get(k) || undefined;
  sel.system = g('system'); sel.container = g('container'); sel.author = g('author'); sel.q = g('q');
  const rt = params.get('root');
  if (rt === 'personal' || rt === 'project') sel.root = rt;
  const l = params.get('linked');
  if (l === 'true' || l === 'false') sel.linked = l === 'true';
  return sel;
}
const selKey = (sel: SrcSel): string => selQuery(sel);

/** 나 자신 — 「내가 올린 것」이 쓰는 값. 업로드 자료의 author_name 은 이메일이다(ingest/local-file.ts). */
function myUploadName(): string | null {
  const me: any = state.me;
  return (me && (me.email || me.member_id)) ? String(me.email || me.member_id) : null;
}

// ════════════════════════════════════════════════════════════════════════
// 라우팅 — 앱 안 이동은 앱이 처리한다
// ════════════════════════════════════════════════════════════════════════
//  자료는 한 창 안에서 돌아다니는 앱이라 셸의 탭 키가 `#/sources…` 를 한 화면으로 접는다(tabs.ts routeKey).
//  그래서 주소 변화를 이 앱이 직접 듣고, 같은 자리 안의 이동(읽는 자료만 바뀜)은 **원문 칸만** 다시 그린다.
const PAGE = 60;

interface View {
  key: string; listBox: HTMLElement; readHost: HTMLElement; moreBox: HTMLElement; selId: number | null; sel: SrcSel;
  noiseN: number; noiseOpen: boolean; noiseBtn: HTMLElement | null;
}

/** 잡음(#2423 v3.1) — 기본으로 접어 두는 행. 지우는 게 아니라 뒤로 미는 것: 「사소한 것 n건」 줄로 접히고 누르면 펼친다.
 *  판정은 기계적으로 둘뿐이다 — ① 봇이 쓴 것(어느 출처든: 모니터링 알림이 목록을 덮던 실측 814건이 근거)
 *  ② 대화·주석 출처의 독립 한 줄(답글도 안 달린 20자 미만 — 「ㅇㅋ」가 스레드 밖에 홀로 선 경우).
 *  문서·파일·기록계(전사록·local_file·깃허브·리니어)는 짧아도 잡음이 아니다 — 제목이 곧 내용인 것들이 아니다. */
const NOISE_SYS = new Set(['slack', 'discord', 'figma']);
function isNoise(r: SrcRow): boolean {
  if (isBot(r)) return true;
  if (!NOISE_SYS.has(r.external_system || '')) return false;
  return (r.reply_n || 0) === 0 && (r.body_len ?? 999) < 20;
}
let mounted: HTMLElement | null = null;   // 본창 그릇(셸 tab.center 안)
let view: View | null = null;             // 지금 서 있는 열람실(목록 한 벌)
let sideBox: HTMLElement | null = null;   // 셸 사이드바 안 우리 그릇
let lastDrawn = '';

function parseHash(hash: string): { sel: SrcSel; id: number | null } | null {
  const h = hash.replace(/^#\/?/, '');
  const qi = h.indexOf('?');
  const segs = (qi >= 0 ? h.slice(0, qi) : h).split('/').filter(Boolean);
  if (segs[0] !== 'sources') return null;
  const params = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : '');
  const id = segs[1] ? Number(decodeURIComponent(segs[1])) : null;
  return { sel: selFromParams(params), id: Number.isFinite(id as number) && id ? (id as number) : null };
}

function drawFor(host: HTMLElement, hash: string): void {
  const at = parseHash(hash);
  if (!at) return;                                        // 다른 화면으로 갔다 — 셸의 몫
  lastDrawn = hash;
  //  같은 자리(목록 조건 동일)면 목록은 그대로 두고 읽는 자료만 바꾼다 — 열람실의 핵심 손맛(↑↓ 훑기)이 여기 산다.
  if (view && view.key === selKey(at.sel) && host.contains(view.listBox)) {
    if (at.id !== view.selId) setSelected(at.id);
    paintSideActive();
    return;
  }
  view = null;
  const listBox = el('div', { class: 'v2-srl-list', role: 'list' });
  const moreBox = el('div', { class: 'v2-srl-more' });
  const readHost = el('div', { class: 'v2-srd' });
  const listPane = el('div', { class: 'v2-srl' }, listHead(at.sel), listBox, moreBox);
  host.replaceChildren(el('div', { class: 'v2-src' }, listPane, readHost));
  view = { key: selKey(at.sel), listBox, readHost, moreBox, selId: at.id, sel: at.sel, noiseN: 0, noiseOpen: false, noiseBtn: null };
  void loadList(view, true);
  if (at.id) paintRead(readHost, at.id, at.sel);
  else readHost.replaceChildren(el('div', { class: 'v2-srd-none', text: '왼쪽에서 자료를 고르세요.' }));
  paintSideActive();
}

window.addEventListener('hashchange', () => {
  if (!mounted || !document.contains(mounted)) { mounted = null; view = null; return; }
  if (location.hash === lastDrawn) return;                // 셸이 이미 그린 뒤면 두 번 그리지 않는다
  drawFor(mounted, location.hash);
});

//  ↑↓ — 목록을 훑는다. 입력 칸에 쓰는 중이면 건드리지 않는다.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  if (!mounted || !view || !document.contains(mounted)) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const rows = [...view.listBox.querySelectorAll<HTMLAnchorElement>('.v2-srl-row')].filter((r) => !r.hidden);
  if (!rows.length) return;
  const cur = rows.findIndex((r) => Number(r.dataset.id) === view!.selId);
  const next = rows[Math.max(0, Math.min(rows.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))];
  if (!next || Number(next.dataset.id) === view.selId) return;
  e.preventDefault();
  location.hash = sourcesHref(view.sel, Number(next.dataset.id));
});

export function renderSourcesApp(host: HTMLElement, params: URLSearchParams): void {
  mounted = host;
  drawFor(host, location.hash.startsWith('#/sources') ? location.hash : '#/sources?' + params.toString());
}
/** 딥링크(#/sources/<id>) — 열람실 그대로, 그 자료가 열린 채로 선다(단독 상세 페이지는 없앴다). */
export function renderSourceDetail(host: HTMLElement, _id: number): void {
  mounted = host;
  drawFor(host, location.hash);
}

/** 읽는 자료를 바꾼다 — 목록의 선택 표시 + 원문 칸. 목록 자체는 손대지 않는다. */
function setSelected(id: number | null): void {
  if (!view) return;
  view.selId = id;
  for (const r of view.listBox.querySelectorAll<HTMLElement>('.v2-srl-row')) {
    const on = Number(r.dataset.id) === id;
    r.classList.toggle('sel', on);
    if (on) r.scrollIntoView({ block: 'nearest' });
  }
  if (id) paintRead(view.readHost, id, view.sel);
}

/** 첫 줄 자동 열기 — 열람실은 원문이 항상 열려 있는 방이다. 주소는 조용히 맞춘다(뒤로가기 더미를 안 만든다). */
function autoSelect(id: number): void {
  if (!view || view.selId) return;
  view.selId = id;
  lastDrawn = sourcesHref(view.sel, id);
  history.replaceState(null, '', location.pathname + location.search + lastDrawn);
  setSelected(id);
}

// ════════════════════════════════════════════════════════════════════════
// 앱 소유 사이드바 — 셸(main.ts drawSide)이 자료가 활성인 동안 이걸 그린다
// ════════════════════════════════════════════════════════════════════════
interface SideHooks { railHidden?: () => boolean; onToggleRail?: () => void }
let treeCache: { nodes: SrcTreeNode[]; at: number } | null = null;
let sideCounts: { mine?: number; proj?: number } = {};

export function renderSourcesSide(host: HTMLElement, hooks?: SideHooks): void {
  const box = el('div', { class: 'v2-ss' });
  sideBox = box;
  host.replaceChildren(box);
  void paintSide(hooks);
}

async function fetchTree(): Promise<SrcTreeNode[]> {
  if (treeCache && Date.now() - treeCache.at < 60_000) return treeCache.nodes;
  const r: any = await api('/api/ui/sources/tree');
  treeCache = { nodes: (r && r.nodes) || [], at: Date.now() };
  return treeCache.nodes;
}

async function paintSide(hooks?: SideHooks): Promise<void> {
  const box = sideBox;
  if (!box) return;
  busy(box, el('div', { class: 'v2-ss-skel' }));
  let nodes: SrcTreeNode[] = [];
  try { nodes = await fetchTree(); }
  catch (e: any) { box.replaceChildren(errorNote(e, '출처를 불러오지 못했습니다')); return; }
  if (!document.contains(box)) return;                    // 그 사이 다른 구역으로 갔다

  const at = parseHash(location.hash);
  const cur = at ? selKey(at.sel) : '';
  const total = nodes.reduce((a, n) => a + n.n, 0);
  const linked = nodes.reduce((a, n) => a + n.linked, 0);
  const localN = nodes.filter((n) => n.system === 'local').reduce((a, n) => a + n.n, 0);
  const mine = myUploadName();

  const row = (o: { label: string; sel: SrcSel; n?: number | string; icon?: string; child?: boolean; cls?: string }): HTMLElement => {
    const on = cur === selKey(o.sel);
    return el('a', {
      class: 'v2-ss-row' + (o.child ? ' child' : '') + (on ? ' on' : '') + (o.cls ? ' ' + o.cls : ''),
      href: sourcesHref(o.sel), 'aria-current': on ? 'page' : null, 'data-sel': selKey(o.sel),
    },
      o.child || !o.icon ? null : el('span', { class: 'ic' }, treeIcon(o.icon)),
      el('span', { class: 'nm', text: o.label, title: o.label }),
      o.n === undefined ? null : el('span', { class: 'n', text: String(o.n) }));
  };

  // 머리 — 유리 아이콘 문패. 레일이 숨어 있으면 되살리는 문을 함께 둔다(이 사이드바가 구역 머리를 대신 서 있으니).
  const head = el('div', { class: 'v2-ss-hd' },
    hooks && hooks.railHidden && hooks.railHidden()
      ? el('button', { class: 'v2-ss-rail', type: 'button', title: '레일 펼치기', 'aria-label': '레일 펼치기',
          onclick: () => hooks.onToggleRail && hooks.onToggleRail() }, treeIcon('panel'))
      : null,
    el('span', { class: 'gi' }, appGlassIcon('src')),
    el('b', { text: '자료' }),
    el('span', { class: 'n', text: total ? total + '건' : '' }));

  // 찾기 — 값은 주소의 q 로 간다(목록이 그 말로 좁혀진다).
  const qIn = el('input', { class: 'v2-ss-qin', type: 'search', value: (at && at.sel.q) || '',
    placeholder: '자료에서 찾기', 'aria-label': '자료에서 찾기' }) as HTMLInputElement;
  let t: any = null;
  qIn.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const base = (parseHash(location.hash) || { sel: {} as SrcSel }).sel;
      location.hash = sourcesHref({ ...base, q: qIn.value.trim() || undefined });
    }, 300);
  });

  const rows: (HTMLElement | null)[] = [];
  rows.push(el('div', { class: 'v2-ss-sec', text: '내 자료' }));
  const mineRow = mine ? row({ label: '내가 올린 것', sel: { system: 'local', author: mine }, icon: 'up',
    n: sideCounts.mine !== undefined ? sideCounts.mine : undefined }) : null;
  rows.push(mineRow);
  const projRow = row({ label: '프로젝트에 올린 것', sel: { system: 'local', root: 'project' }, icon: 'folder',
    n: sideCounts.proj !== undefined ? sideCounts.proj : undefined });
  rows.push(projRow);
  rows.push(row({ label: '팀 전체', sel: { system: 'local' }, icon: 'disk', n: localN }));
  rows.push(row({ label: '지식이 된 것', sel: { linked: true }, icon: 'doc', n: linked }));

  rows.push(el('div', { class: 'v2-ss-sec', text: '수집함' }));
  const bySys = new Map<string, SrcTreeNode[]>();
  for (const n of nodes) { if (n.system === 'local') continue; const a = bySys.get(n.system) || []; a.push(n); bySys.set(n.system, a); }
  const systems = [...bySys.keys()].sort((a, b) => {
    const ra = sysRank(a), rb = sysRank(b);
    if (ra !== rb) return ra - rb;
    return (bySys.get(b) || []).reduce((x, n) => x + n.n, 0) - (bySys.get(a) || []).reduce((x, n) => x + n.n, 0);
  });
  for (const sys of systems) {
    const kids = (bySys.get(sys) || []).sort((a, b) => b.n - a.n);
    const sum = kids.reduce((a, n) => a + n.n, 0);
    rows.push(row({ label: sysLabel(sys), sel: { system: sys }, icon: sysIconKey(sys), n: sum }));
    for (const k of kids) {
      if (!k.container) continue;                         // 자리 이름 없는 자료는 출처 가지에서 함께 보인다
      rows.push(row({ label: k.container, sel: { system: sys, container: k.container }, n: k.n, child: true }));
    }
  }

  // 발치 — 올리기. PUT 한 번이면 자료로도 등록된다(#1881 browse/file 이 source 를 만든다).
  const fileIn = el('input', { type: 'file', multiple: true, hidden: true }) as HTMLInputElement;
  fileIn.addEventListener('change', () => { void uploadFiles([...(fileIn.files || [])]); fileIn.value = ''; });
  const upBtn = el('button', { class: 'v2-ss-up', type: 'button', onclick: () => fileIn.click() },
    treeIcon('plus'), el('span', { text: '올리기' }));

  box.replaceChildren(head, el('div', { class: 'v2-ss-q' }, treeIcon('search'), qIn),
    el('div', { class: 'v2-ss-body' }, ...rows.filter(Boolean) as HTMLElement[]),
    el('div', { class: 'v2-ss-ft' }, upBtn, fileIn));

  //  건수는 늦게 와도 된다 — 나무 집계는 출처 × 자리라 사람·root 축이 없어 이 두 줄만 따로 센다(total 만 쓰므로 limit=1).
  const late = (r0: HTMLElement | null, sel: SrcSel, keep: (n: number) => void): void => {
    if (!r0 || r0.querySelector('.n')) return;
    void api('/api/ui/sources?' + selQuery(sel, { limit: '1' }))
      .then((r: any) => { const n = Number(r && r.total); if (Number.isFinite(n)) { keep(n); if (document.contains(r0)) r0.append(el('span', { class: 'n', text: String(n) })); } })
      .catch(() => { /* 못 세도 줄은 선다 */ });
  };
  if (mine) late(mineRow, { system: 'local', author: mine }, (n) => { sideCounts.mine = n; });
  late(projRow, { system: 'local', root: 'project' }, (n) => { sideCounts.proj = n; });
}

/** 주소만 바뀌었을 때 — 사이드바를 다시 만들지 않고 켜진 줄만 옮긴다. */
function paintSideActive(): void {
  if (!sideBox || !document.contains(sideBox)) return;
  const at = parseHash(location.hash);
  const cur = at ? selKey(at.sel) : '';
  for (const r of sideBox.querySelectorAll<HTMLElement>('.v2-ss-row')) {
    const on = r.dataset.sel === cur;
    r.classList.toggle('on', on);
    if (on) r.setAttribute('aria-current', 'page'); else r.removeAttribute('aria-current');
  }
  const q = sideBox.querySelector<HTMLInputElement>('.v2-ss-qin');
  if (q && document.activeElement !== q) q.value = (at && at.sel.q) || '';
}

async function uploadFiles(files: File[]): Promise<void> {
  if (!files.length) return;
  let ok = 0;
  for (const f of files) {
    try {
      // 순차 업로드(compose-attach 와 같은 이유) — 병렬로 쏘면 큰 파일 여럿이 회선을 나눠 서로 오래 걸린다.
      await authUploadProgress(apiUrl('/api/ui/terminal/browse/file?root=personal&path=' + encodeURIComponent('uploads/' + (f.name || '파일'))), f, () => { /* 조용히 */ });
      ok++;
    } catch (e: any) { toast(`${f.name || '파일'} — 올리지 못했습니다: ${(e && e.message) || e}`, true); }
  }
  if (!ok) return;
  toast(`${ok}개를 올렸습니다 — 올린 순간부터 AI 가 읽을 수 있어요.`);
  treeCache = null; sideCounts = {};
  void paintSide();
  if (view && mounted && document.contains(mounted)) { const k = view.key; view = null; drawFor(mounted, location.hash || '#/sources' + (k ? '?' + k : '')); }
}

const sysIconKey = (s: string): string =>
  s === 'local' ? 'disk' : s === 'authored' ? 'note' : s === 'github' || s === 'gitlab' ? 'repo'
  : s === 'slack' || s === 'discord' ? 'chat' : 'dot';

/** 16px 자리 선 글리프 — 유리는 문패(24px) 전용(`app-icon-design-system-glass-1841`). */
function treeIcon(key: string): SVGElement {
  const D: Record<string, string> = {
    up: 'M12 16V5M7 10l5-5 5 5M4 19h16',
    doc: 'M6 4h9l3 3v13H6zM15 4v4h3',
    disk: 'M3 5h18v12H3zM8 20h8',
    note: 'M5 4h14v16H5zM9 9h6M9 13h4',
    repo: 'M6 3h9l4 4v14H6zM9 12h7M9 16h5',
    chat: 'M4 5h16v11H9l-4 3z',
    folder: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z',
    plus: 'M12 5v14M5 12h14',
    search: 'M11 4.25a6.75 6.75 0 1 0 0 13.5 6.75 6.75 0 0 0 0-13.5zM16.1 16.1 21 21',
    panel: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 3v18',
    down: 'M12 4v11M7 10.5l5 5 5-5M4.5 20h15',
    ext: 'M14 4h6v6M20 4 11 13M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6',
    dot: 'M12 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z',
  };
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '15'); svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of D[key] ? [D[key]] : [D.dot]) {
    const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.append(p);
  }
  return svg;
}

// ════════════════════════════════════════════════════════════════════════
// 목록(왼 칸) — 촘촘한 두 줄 행, 출처마다 다른 메타
// ════════════════════════════════════════════════════════════════════════
function listHead(sel: SrcSel): HTMLElement {
  return el('div', { class: 'v2-srl-hd' },
    el('div', { class: 'v2-srl-crumb' }, ...crumbParts(sel)),
    el('span', { class: 'sp' }),
    sel.linked === undefined
      ? el('a', { class: 'v2-src-chip', href: sourcesHref({ ...sel, linked: true }), text: '지식이 된 것만' })
      : el('a', { class: 'v2-src-chip on', href: sourcesHref({ ...sel, linked: undefined }), text: '지식이 된 것만' }));
}

function crumbParts(sel: SrcSel): Node[] {
  const b = (t: string) => el('b', { text: t });
  const dim = (t: string) => el('span', { class: 'dim', text: t });
  if (sel.q) return [dim('찾기'), el('span', { class: 'sep', text: '›' }), b(sel.q)];
  if (sel.linked === true && !sel.system) return [b('지식이 된 것')];
  if (sel.system === 'local') {
    if (sel.author) return [dim('내 자료'), el('span', { class: 'sep', text: '›' }), b('내가 올린 것')];
    if (sel.root === 'project') return [dim('내 자료'), el('span', { class: 'sep', text: '›' }), b('프로젝트에 올린 것')];
    return [dim('내 자료'), el('span', { class: 'sep', text: '›' }), b('팀 전체')];
  }
  if (sel.system) {
    return [dim(sysLabel(sel.system)), ...(sel.container ? [el('span', { class: 'sep', text: '›' }), b(sel.container)] : [b('')])];
  }
  return [b('모든 자료')];
}

async function loadList(v: View, reset: boolean, offset = 0): Promise<void> {
  if (reset) { busy(v.listBox, el('div', { class: 'v2-src-skel' })); v.moreBox.replaceChildren(); }
  try {
    const qs = selQuery(v.sel, { limit: String(PAGE), offset: String(offset), fold: 'true' });
    const r: any = await api('/api/ui/sources?' + qs);
    if (view !== v) return;                                // 그 사이 다른 자리로 갔다
    const entries: SrcRow[] = (r && r.entries) || [];
    const total = Number(r && r.total) || 0;
    if (reset) {
      v.listBox.replaceChildren();
      if (!entries.length) {
        v.listBox.append(el('div', { class: 'v2-src-empty', text: emptyText(v.sel) }));
        v.readHost.replaceChildren(el('div', { class: 'v2-srd-none', text: emptyText(v.sel) }));
        return;
      }
    }
    for (const s of entries) {
      const row = rowOf(s, v.sel);
      if (isNoise(s)) { row.classList.add('noise'); row.hidden = !v.noiseOpen; v.noiseN++; }
      v.listBox.append(row);
    }
    paintNoiseLine(v);
    const shown = offset + entries.length;
    if (r && r.has_more) {
      const btn = el('button', { class: 'btn btn-sm', type: 'button', text: `더 보기 (${shown}/${total})` });
      btn.addEventListener('click', () => { btn.remove(); void loadList(v, false, shown); });
      v.moreBox.replaceChildren(btn);
    } else {
      v.moreBox.replaceChildren(el('span', { class: 'v2-src-count', text: `${total}건을 다 보고 있습니다.` }));
    }
    if (reset) {
      if (v.selId) setSelected(v.selId);
      else {
        const first = entries.find((e) => !isNoise(e)) || entries[0];   // 열람실 첫 장이 봇 알림이면 방이 잘못 읽힌다
        if (first) autoSelect(first.id);
      }
    }
  } catch (e: any) {
    if (view === v && reset) v.listBox.replaceChildren(errorNote(e, '자료를 불러오지 못했습니다'));
  }
}

/** 「사소한 것 n건」 줄 — 접힌 잡음의 유일한 손잡이. 더 불러올 때마다 수만 다시 쓴다. */
function paintNoiseLine(v: View): void {
  if (!v.noiseN) { v.noiseBtn?.remove(); v.noiseBtn = null; return; }
  const btn = v.noiseBtn || el('button', { class: 'v2-srl-noiseln', type: 'button', onclick: () => {
    v.noiseOpen = !v.noiseOpen;
    for (const r of v.listBox.querySelectorAll<HTMLElement>('.v2-srl-row.noise')) r.hidden = !v.noiseOpen;
    paintNoiseLine(v);
  } });
  v.noiseBtn = btn;
  btn.textContent = v.noiseOpen ? `사소한 것 ${v.noiseN}건을 함께 보는 중 — 접기` : `사소한 것 ${v.noiseN}건 — 봇 알림·한 줄짜리`;
  v.listBox.append(btn);   // 늘 목록 맨 끝(새 행이 뒤에 붙어도 줄이 그 아래로 내려온다)
}

function emptyText(sel: SrcSel): string {
  return sel.q ? '찾는 말이 든 자료가 없습니다.'
    : sel.system === 'local' && sel.author ? '아직 올린 파일이 없습니다. 아래 [올리기]나 세션에 파일을 올리면 여기 모입니다.'
    : sel.system === 'local' ? '아직 올린 파일이 없습니다. 프로젝트 폴더나 세션에 파일을 올리면 여기 모입니다.'
    : '이 자리에는 아직 자료가 없습니다.';
}

/** 출처마다 다른 메타 한 줄 — v2 의 «출처마다 다른 열»이 열람실에선 둘째 줄이 된다. */
function metaOf(sel: SrcSel, r: SrcRow): string {
  const f = r.fields || {};
  const when = relTime(r.occurred_at || r.updated_at);
  const who = shortPerson(authorOf(r)) + (isBot(r) ? ' · 봇' : '');
  const sys = r.external_system || 'authored';
  if (sys === 'local') {
    const rs = readState(f);
    return [bytesText(f.bytes), rs.text, who, when].filter(Boolean).join(' · ');
  }
  if (sys === 'github' || sys === 'gitlab' || sys === 'linear') {
    const st = f.merged_at ? '머지됨' : String(f.state || '') === 'open' ? '열림' : String(f.state || '') === 'closed' ? '닫힘' : '';
    return [f.number ? '#' + f.number : '', st, who, when].filter(Boolean).join(' · ');
  }
  if (sys === 'slack' || sys === 'discord') {
    return [(!sel.container && containerOf(r)) ? '#' + containerOf(r) : '', who,
      r.reply_n ? `답글 ${r.reply_n}` : '', when].filter(Boolean).join(' · ');
  }
  if (sys === 'authored') return [kindLabel(r.kind), when].filter(Boolean).join(' · ');
  return [sysLabel(sys) + (containerOf(r) ? ' · ' + containerOf(r) : ''), who, when].filter(Boolean).join(' · ');
}

function rowOf(r: SrcRow, sel: SrcSel): HTMLElement {
  const f = r.fields || {};
  const priv = r.visibility === 'members' || String(f.root || '') === 'personal';
  const isFile = r.kind === 'local_file';
  const lead = isFile
    ? el('span', { class: 'v2-srl-ext ' + extClass(String(f.ext || '')), text: String(f.ext || 'file').toUpperCase().slice(0, 4) })
    : el('span', { class: 'v2-srl-ic' }, treeIcon(sysIconKey(r.external_system || 'authored')));
  return el('a', {
    class: 'v2-srl-row' + (view && view.selId === r.id ? ' sel' : ''), role: 'listitem',
    href: sourcesHref(sel, r.id), 'data-id': String(r.id),
  },
    lead,
    el('span', { class: 'tx' },
      el('b', { class: 't1' },
        el('span', { class: 'ttl', text: r.title || `자료 #${r.id}`, title: r.title || '' }),
        priv ? lockGlyph() : null),
      el('s', { class: 't2', text: metaOf(sel, r) })),
    el('span', { class: 'tick' + (r.has_knowledge ? ' on' : ''), title: r.has_knowledge ? '이 자료로 지식이 만들어졌습니다' : null }));
}

const extClass = (ext: string): string => {
  const e = ext.toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(e)) return 'img';
  if (['md', 'markdown'].includes(e)) return 'md';
  if (['csv', 'tsv', 'xlsx'].includes(e)) return 'csv';
  if (e === 'pdf') return 'pdf';
  return 'txt';
};

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
// 원문(오른 칸) — 항상 열려 있다
// ════════════════════════════════════════════════════════════════════════
let readSeq = 0;

function paintRead(host: HTMLElement, id: number, sel: SrcSel): void {
  const seq = ++readSeq;
  busy(host, el('div', { class: 'v2-src-skel' }));
  void (async () => {
    let s: any;
    try { const r: any = await api('/api/ui/sources/' + id); s = (r && r.source) || r; }
    catch (e: any) { if (seq === readSeq) host.replaceChildren(errorNote(e, '자료를 불러오지 못했습니다')); return; }
    if (seq !== readSeq || !document.contains(host)) return;
    host.replaceChildren(readSheet(s, sel));
  })();
}

/** 파일 자료의 원본 자리 — external_url(#/f?root=…&path=…)에서 브라우즈 API 좌표를 꺼낸다. */
function fileCoords(s: any): { root: string; path: string } | null {
  const url = String(s.external_url || '');
  if (!url.startsWith('#/f?')) return null;
  const p = new URLSearchParams(url.slice(4));
  const root = p.get('root'), path = p.get('path');
  return root && path ? { root, path } : null;
}

function readSheet(s: any, sel: SrcSel): HTMLElement {
  const f: Record<string, any> = s.fields || {};
  const sys = String(s.external_system || 'authored');
  const chan = String(f.container_name || '');
  const isFile = s.kind === 'local_file';
  const isChat = sys === 'slack' || sys === 'discord';
  const priv = String(f.root || '') === 'personal' || s.visibility === 'members';
  const derived: any[] = s.knowledge || [];

  const meta = el('div', { class: 'v2-src-dmeta' },
    el('span', { class: 'v2-src-badge', text: kindLabel(s.kind) }),
    ...(chan ? [el('span', { class: 'mono', text: (isChat ? '#' : '') + chan })] : []),
    ...(isFile && f.bytes ? [el('span', { class: 'mono', text: bytesText(f.bytes) })] : []),
    ...(authorOf(s as SrcRow) ? [el('span', { text: shortPerson(authorOf(s as SrcRow)) + (isFile ? ' 님이 올렸습니다' : '') })] : []),
    el('span', { class: 'mono', text: absLike(s.occurred_at || s.updated_at) }),
    el('span', { class: 'vis' }, priv ? '올린 사람만 봅니다' : '이 워크스페이스 사람 모두가 봅니다'));

  //  문 — 파일이면 내려받기(browse API — #/f 와 같은 문)와 폴더, 남의 시스템이면 그 시스템으로.
  const acts = el('div', { class: 'v2-src-dacts' });
  const co = isFile ? fileCoords(s) : null;
  if (co) {
    const dl = '/api/ui/terminal/browse/file?download=1&root=' + encodeURIComponent(co.root) + '&path=' + encodeURIComponent(co.path);
    acts.append(el('button', { class: 'btn btn-sm v2-src-primary', type: 'button',
      onclick: () => { void authDownload(apiUrl(dl), String(s.title || 'file')); } },
      treeIcon('down'), el('span', { text: '내려받기' })));
    acts.append(el('a', { class: 'btn btn-sm', href: String(s.external_url), text: '폴더에서 열기' }));
  } else if (s.external_url && String(s.external_url).startsWith('#')) {
    acts.append(el('a', { class: 'btn btn-sm v2-src-primary', href: String(s.external_url), text: '폴더에서 열기' }));
  } else if (s.external_url) {
    acts.append(el('a', { class: 'btn btn-sm v2-src-primary', href: safeHref(String(s.external_url)) || '#',
      target: '_blank', rel: 'noopener' }, treeIcon('ext'), el('span', { text: sysLabel(sys) + '에서 열기' })));
  }
  if (derived.length) acts.append(el('span', { class: 'v2-srd-kchip', text: `지식 ${derived.length}건이 여기서 나왔어요` }));

  const knBox = derived.length
    ? el('div', { class: 'v2-src-kn' },
        el('span', { class: 'k', text: '여기서 나온 지식' }),
        el('div', { class: 'v' }, ...derived.map((d: any) =>
          el('a', { class: 'kl', href: '#/k/' + encodeURIComponent(d.name), text: d.title || d.name }))))
    : null;

  //  원문 — 파일은 공용 미리보기(#/f·홈 모달과 같은 코드)로 **실물**을 그린다: 이미지는 그림으로, md 는 렌더로,
  //   표는 표로. 실패·미지원은 렌더러가 안내 노드로 돌려준다. 파일이 아니면 저장된 본문(body_md)이 원문이다.
  const bodyBox = el('div', { class: 'v2-srd-body' });
  if (co) {
    busy(bodyBox, el('div', { class: 'v2-src-skel' }));
    const viewUrl = '/api/ui/terminal/browse/file?root=' + encodeURIComponent(co.root) + '&path=' + encodeURIComponent(co.path);
    const dlUrl = '/api/ui/terminal/browse/file?download=1&root=' + encodeURIComponent(co.root) + '&path=' + encodeURIComponent(co.path);
    const tok = localStorage.getItem(TOKEN_KEY);
    const ffetch = (u: string) => fetch(apiUrl(u), { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
    void buildFilePreview({
      name: String(s.title || (f.path || '').split('/').pop() || 'file'),
      size: Number(f.bytes) || undefined,
      fetchView: () => ffetch(viewUrl),
      fetchDownload: () => ffetch(dlUrl),
      cls: { img: 'v2-srd-img', pdf: 'v2-srd-pdf', html: 'v2-srd-html', md: 'md-rendered', code: 'v2-srd-code', table: 'v2-srd-table', audio: 'v2-srd-media', video: 'v2-srd-media', msg: 'v2-srd-msg' },
      mkBtn: (label, onClick) => el('button', { class: 'btn btn-sm', type: 'button', text: label, onclick: onClick }),
    }).then((out) => { if (document.contains(bodyBox)) bodyBox.replaceChildren(out.body); })
      .catch((e: any) => { if (document.contains(bodyBox)) bodyBox.replaceChildren(errorNote(e, '미리보기를 열지 못했습니다')); });
  } else {
    //  ★ [BINARY] 스텁은 증류 세션에게 주는 쪽지다 — 사람에게는 파일의 사실만 사람 말로(#2423 실측).
    const body = String(s.body_md || '');
    const rs = isFile ? readState(f) : null;
    if (body.startsWith('[BINARY]')) {
      bodyBox.append(el('div', { class: 'v2-src-stub' },
        el('p', { class: 'h', text: rs ? rs.why : '글자가 없는 파일입니다.' }),
        el('p', { class: 'sub', text: [kindLabel(s.kind), String(f.ext || '').toUpperCase(), bytesText(f.bytes)].filter(Boolean).join(' · ') })));
    } else {
      bodyBox.classList.add('md-rendered');
      bodyBox.append(renderMarkdown(body || '(본문 없음)'));
    }
  }

  const thread: HTMLElement[] = [];
  if (s.parent) {
    thread.push(el('div', { class: 'v2-src-seck', text: '이 자료가 달린 곳' }),
      el('div', { class: 'v2-src-nbs' }, refRow(s.parent, '상위', sel)));
  }
  if (s.replies && s.replies.length) {
    thread.push(el('div', { class: 'v2-src-seck', text: `이어진 자료 · ${s.reply_count || s.replies.length}건` }),
      el('div', { class: 'v2-src-nbs' }, ...s.replies.map((r: any) => refRow(r, '', sel))));
  }

  return el('div', { class: 'v2-srd-sheet' },
    el('h1', { class: 'v2-src-h1', text: s.title || `자료 #${s.id}` }),
    meta,
    acts.childElementCount ? acts : null,
    bodyBox,
    knBox,
    ...thread);
}

function refRow(r: any, tag: string, sel: SrcSel): HTMLElement {
  const f = r.fields || {};
  const sub = kindLabel(r.kind) + (f.container_name ? ' · ' + f.container_name : '') + (f.author_name ? ' · ' + shortPerson(String(f.author_name)) : '');
  //  같은 자리(sel)를 들고 간다 — 스레드를 오가는 동안 왼쪽 목록이 갈리지 않는다.
  return el('a', { class: 'v2-src-nb', href: sourcesHref(sel, r.id) },
    tag ? el('span', { class: 'ar', text: tag }) : null,
    el('span', { class: 'tt', text: r.title || `자료 #${r.id}` }),
    el('span', { class: 'sb', text: sub }));
}

/** 원문의 시각 — 목록은 상대시각(3분 전)이지만 원문은 «언제 있었던 일인지»가 사실이라 절대시각이다. */
function absLike(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

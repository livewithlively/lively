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
// 3판(#4233, 원준 2026-09-26 «세 가지로 나눠서 보여주면 제일 좋을 것 같기는 한데. 직관적으로 딱딱딱 나눠지니까»):
//  · 사이드바는 **들어온 길** 셋으로 나눈다: 올린 자료(사람 줄) · 수집한 자료(앱 줄 → 자리 줄) · 라이블리에서 만든 자료(AI가 만든 파일 · 직접 적은 글).
//    옛 네 줄(내가 올린 것 · 프로젝트에 올린 것 · 팀 전체 · 지식이 된 것)은 기준 셋을 섞어서 걷었다. 조립은 side.ts, 규칙은 sources-plan.ts.
//  · 목록 줄마다 원천 칸(올린 사람 · AI 세션 · 앱과 자리), 원문에 «올린 곳 · 만든 곳 · 가져온 곳» 한 줄. 올린 자리는 묶음이 아니다.
//
// 주소: `#/sources?<선택>` = 그 자리의 목록(첫 줄이 자동으로 열린다) · `#/sources/<id>?<선택>` = 그 자료를 읽는 중.
//  선택(query)이 함께 실려 채널 하나·자료 하나를 링크로 줄 수 있다(북마크·공유).
import { TOKEN_KEY, api, apiUrl, busy, el, errorNote, loadPeopleAvatars, personDisplayName, personFace, relTime, renderMarkdown, safeHref, state, toast } from '../core.js';
import {
  type SrcSel, type SourcesSidePlan, type PlanNode, type PlanUploader, SRC_GROUP_SELS, sysLabel, kindLabel, isChatSys,
  planSourcesSide, normalizeSel, sideSel, showsUploaderFilter, crumbOf, emptyTextOf, originOf, placeLine, rowGroup,
} from './sources-plan.js';   // #4233 들어온 길 규칙(순수)
import { buildFilePreview } from '../lib/file-preview.js';   // 미리보기 판정·렌더의 단일 소유(#/f·홈 모달과 같은 코드)
import { authDownload, authUploadProgress } from '../projects/files-upload.js';
import { confirmDialog } from '../ui-primitives.js';

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
export interface SrcTreeNode extends PlanNode { linked: number; newest: string | null }
export type { SrcSel };

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
  //  추출을 **시도했다가 실패한** 것은 «아직» 이 아니다 — 기다려도 안 된다. 사유(local_reason)가 있으면 그렇게 말한다.
  //   (#3778: hwp 를 읽기 시작하면서 이 갈래가 생겼는데, docx 추출 실패도 종전부터 «아직» 이라 잘못 말하고 있었다.)
  if (f.extracted === false && f.local_reason) {
    return { text: '못 읽음', why: '본문을 뽑다가 실패했습니다(' + String(f.local_reason) + '). PDF 로 저장해 다시 올리면 읽습니다.', tone: 'no' };
  }
  if (f.extracted === false) return { text: '아직', why: '아직 글자를 뽑지 않았습니다.', tone: 'later' };
  return { text: '읽음', why: '글자를 뽑아 두었습니다 — 검색과 지식 만들기에 쓰입니다.', tone: '' };
}

const authorOf = (r: SrcRow): string => String((r.fields || {}).author_name || '');
const isBot = (r: SrcRow): boolean => (r.fields || {}).author_is_bot === true;

/** 사람 이름 — 업로드 자료의 author_name 은 이메일이라 앞부분만 쓴다(칸이 좁다). */
function shortPerson(s: string): string {
  if (!s) return '';
  const at = s.indexOf('@');
  return at > 0 ? s.slice(0, at) : s;
}
/** 올린 사람의 표시 이름: 명부(id → 이름)에 있으면 그 이름, 없으면 이메일 앞부분. */
export function uploaderLabel(name: string, id?: string | null): string {
  return (id && personDisplayName(id)) || shortPerson(name) || (id || '');
}

// ── 선택(사이드바에서 고른 자리) ──────────────────────────────────────────────
function selQuery(sel: SrcSel, extra?: Record<string, string>): string {
  const p = new URLSearchParams();
  if (sel.group) p.set('group', sel.group);
  if (sel.system) p.set('system', sel.system);
  if (sel.container) p.set('container', sel.container);
  if (sel.author) p.set('author', sel.author);
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
/** 옛 주소(system=local · root · system=authored)는 새 자리로 연다(sources-plan normalizeSel). */
export function selFromParams(params: URLSearchParams): SrcSel {
  const g = (k: string) => params.get(k) || undefined;
  const grp = g('group');
  const l = params.get('linked');
  return normalizeSel({
    group: grp && (SRC_GROUP_SELS as readonly string[]).includes(grp) ? grp as SrcSel['group'] : undefined,
    system: g('system'), container: g('container'), author: g('author'), q: g('q'), root: g('root'),
    linked: l === 'true' || l === 'false' ? l === 'true' : undefined,
  });
}
export const selKey = (sel: SrcSel): string => selQuery(sel);

/** 나 자신: 내 개인 폴더 파일인지(폴더 문) 가르는 값. 업로드 자료의 author_name 은 이메일이다(ingest/local-file.ts). */
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
// 앱 소유 사이드바(#2423) — **조립은 side.ts 가 한다**(구역 사이드바와 같은 틀: topBits·secHead·secFoot).
//  여기는 내용만 내놓는다: 나무 몸통 · 총계 · 찾기 입력 · 올리기. v3 첫 판은 셸 규약을 우회하고 맨몸으로
//  섰다가 반려됐다(원준 2026-09-01: "이것저것 다 깨져있고 잘려있고") — 패널 배경이 없고, 검색 입력이 그릇을
//  넘치고, 레일을 숨긴 사람은 구역 이동 문이 통째로 사라졌다. 같은 틀을 쓰면 그 셋이 전부 공짜로 맞는다.
// ════════════════════════════════════════════════════════════════════════
interface SideCache { nodes: SrcTreeNode[]; uploaders: PlanUploader[]; plan: SourcesSidePlan; at: number }
let treeCache: SideCache | null = null;
let treeErr: unknown = null;
let treeErrAt = 0;
let treeLoading = false;
let treeWait: Promise<void> = Promise.resolve();
let sideRedraw: (() => void) | null = null;
let srcFindOpen = false;

/** 머리 숫자(자료 n건) — 나무 캐시에서. 아직 안 왔으면 null(secHead 가 숫자를 생략한다). */
export function sourcesSideCount(): number | null {
  return treeCache ? treeCache.plan.total : null;
}
export function sourcesFindShown(): boolean { return srcFindOpen || !!(parseHash(location.hash)?.sel.q); }
export function toggleSourcesFind(): void { srcFindOpen = !srcFindOpen; }

/** 찾기 입력 — 구역 사이드바의 .v2-find-in 과 같은 붓. 값은 주소의 q 로 간다(목록·원문이 그 말로 좁혀진다). */
export function sourcesFindInput(onClose: () => void): HTMLInputElement {
  const at = parseHash(location.hash);
  const input = el('input', { class: 'v2-find-in', type: 'search', 'data-src-q': '1',
    placeholder: '자료에서 찾기', 'aria-label': '자료에서 찾기', value: (at && at.sel.q) || '' }) as HTMLInputElement;
  let t: any = null;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const base = (parseHash(location.hash) || { sel: {} as SrcSel }).sel;
      const q = input.value.trim() || undefined;
      if (q !== base.q) location.hash = sourcesHref({ ...base, q });
    }, 300);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || (e as KeyboardEvent).isComposing) return;
    e.stopPropagation();
    const base = (parseHash(location.hash) || { sel: {} as SrcSel }).sel;
    if (base.q) location.hash = sourcesHref({ ...base, q: undefined });
    srcFindOpen = false;
    onClose();
  });
  return input;
}

/** 올리기 — 파일을 고르면 개인 폴더 uploads/ 로. PUT 한 번이면 자료로도 등록된다(#1881). */
export function sourcesUploadPick(): void {
  const fileIn = el('input', { type: 'file', multiple: true, hidden: true }) as HTMLInputElement;
  fileIn.addEventListener('change', () => { void uploadFiles([...(fileIn.files || [])]); fileIn.remove(); });
  document.body.append(fileIn);
  fileIn.click();
}

/** 사이드바 재료(#4233): 나무 · 올린 사람 · 그걸로 세운 카드 계획 + 지금 켜질 줄. 조립은 side.ts renderSourcesSection.
 *  캐시가 없거나 1분이 지났으면 불러오고, 도착하면 redraw 를 한 번 부른다(분류체계 사이드바의 loadTaxonomy 와 같은 틀).
 *  redraw 는 기억해 둔다: 올린 뒤 · 접힌 줄을 주소로 골랐을 때 사이드바를 다시 세우는 손잡이다. */
export function sourcesSideData(redraw: () => void): { plan: SourcesSidePlan | null; error: unknown; cur: string; sel: SrcSel } {
  sideRedraw = redraw;
  loadSide();
  const at = parseHash(location.hash);
  const sel = at ? at.sel : {};
  return { plan: treeCache ? treeCache.plan : null, error: treeCache ? null : treeErr, cur: selKey(sideSel(sel)), sel };
}

/** 나무를 (다시) 불러온다: 없거나 1분이 지났을 때만. 도착하면 사이드바를 한 번 다시 세운다. 돌려주는 약속은 목록 머리(올린 사람)도 기다린다. */
function loadSide(): Promise<void> {
  //  실패하면 1분은 다시 묻지 않는다: 도착 때 부르는 redraw 가 다시 여기로 오므로, 안 막으면 실패가 끝없이 돈다.
  if (treeLoading || (treeCache && Date.now() - treeCache.at < 60_000) || (treeErr && Date.now() - treeErrAt < 60_000)) return treeWait;
  treeLoading = true;
  //  얼굴 · 표시 이름(명부)도 함께 기다린다: 사람 줄이 이메일로 섰다가 이름으로 바뀌며 흔들리지 않게.
  treeWait = Promise.all([fetchTree(), loadPeopleAvatars().catch(() => null)])
    .then(() => { treeErr = null; })
    .catch((e) => { treeErr = e; treeErrAt = Date.now(); })
    .finally(() => { treeLoading = false; sideRedraw?.(); });
  return treeWait;
}

async function fetchTree(): Promise<SideCache> {
  const r: any = await api('/api/ui/sources/tree');
  const nodes: SrcTreeNode[] = (r && r.nodes) || [];
  const uploaders: PlanUploader[] = (r && r.uploaders) || [];
  treeCache = { nodes, uploaders, plan: planSourcesSide(nodes, uploaders), at: Date.now() };
  return treeCache;
}

/** 주소만 바뀌었을 때: 사이드바를 다시 만들지 않고 켜진 줄만 옮긴다. 고른 줄이 접힌 자리에 있으면 사이드바를 다시 세운다(forced). */
function paintSideActive(): void {
  const box = document.querySelector<HTMLElement>('.v2-srcside');
  const at = parseHash(location.hash);
  const cur = at ? selKey(sideSel(at.sel)) : '';
  if (box) {
    let hit = false;
    for (const r of box.querySelectorAll<HTMLElement>('[data-sel]')) {
      const on = r.dataset.sel === cur;
      hit = hit || on;
      r.classList.toggle('on', on);
      const link = r.matches('a') ? r : r.querySelector('a');
      if (link) { if (on) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); }
    }
    if (!hit && at && (at.sel.container || at.sel.author)) sideRedraw?.();
  }
  const q = document.querySelector<HTMLInputElement>('input[data-src-q]');
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
  void fetchTree().then(() => sideRedraw?.()).catch(() => { /* 다음 그리기에 온다 */ });
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
    spark: 'M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9zM18.5 16v4M16.5 18h4',
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
  const crumb = el('div', { class: 'v2-srl-crumb' }, ...crumbParts(sel));
  //  사람 이름은 명부 · 나무가 와야 안다: 아직이면 이메일 앞부분으로 섰다가 도착하면 이름으로 고친다.
  if (sel.author && !treeCache) void loadSide().then(() => { if (document.contains(crumb)) crumb.replaceChildren(...crumbParts(sel)); });
  return el('div', { class: 'v2-srl-hd' },
    crumb,
    el('span', { class: 'sp' }),
    showsUploaderFilter(sel) ? uploaderPick(sel) : null,
    sel.linked === undefined
      ? el('a', { class: 'v2-src-chip', href: sourcesHref({ ...sel, linked: true }), text: '지식이 된 것만' })
      : el('a', { class: 'v2-src-chip on', href: sourcesHref({ ...sel, linked: undefined }), text: '지식이 된 것만' }));
}

/** 「올린 사람」 거르개(#4233): 모든 자료 · 올린 자료에서만 선다. 칸의 수는 그 사람이 올린 자료 수(나무의 uploaders).
 *  나무가 아직 안 왔으면 고른 사람만 든 채로 서고, 도착하면 채운다. */
function uploaderPick(sel: SrcSel): HTMLSelectElement {
  const pick = el('select', { class: 'v2-src-who' + (sel.author ? ' on' : ''), 'aria-label': '올린 사람', title: '올린 사람으로 거릅니다',
    onchange: () => { location.hash = sourcesHref({ ...sel, author: pick.value || undefined }); } }) as HTMLSelectElement;
  const fill = (): void => {
    const people = treeCache ? treeCache.plan.uploaded.people : [];
    const opts = [el('option', { value: '', text: sel.author ? '올린 사람 모두' : '올린 사람' })];
    for (const u of people) opts.push(el('option', { value: String(u.name), text: `${uploaderLabel(String(u.name), u.id)} ${u.n}` }));
    if (sel.author && !people.some((u) => u.name === sel.author)) opts.push(el('option', { value: sel.author, text: uploaderLabel(sel.author) }));
    pick.replaceChildren(...opts);
    pick.value = sel.author || '';
  };
  fill();
  if (!treeCache) void loadSide().then(() => { if (document.contains(pick)) fill(); });
  return pick;
}

function crumbParts(sel: SrcSel): Node[] {
  const c = crumbOf(sel, (name) => {
    const u = treeCache?.plan.uploaded.people.find((x) => x.name === name);
    return uploaderLabel(name, u?.id);
  });
  const out: Node[] = [];
  for (const d of c.dim) out.push(el('span', { class: 'dim', text: d }), el('span', { class: 'sep', text: '›' }));
  out.push(el('b', { text: c.last }));
  return out;
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

const emptyText = emptyTextOf;

/** 둘째 줄: 원천 칸(누가 · 어디서)이 따로 서므로 여기엔 그 자료의 사실만: 크기 · 읽음 · 번호 · 글쓴이 · 답글 · 때. */
function metaOf(_sel: SrcSel, r: SrcRow): string {
  const f = r.fields || {};
  const when = relTime(r.occurred_at || r.updated_at);
  const sys = r.external_system || 'authored';
  if (sys === 'local') {
    const rs = readState(f);
    return [bytesText(f.bytes), rs.text, when].filter(Boolean).join(' · ');
  }
  //  바깥 자료의 글쓴이는 원천(앱 · 자리)과 다른 사실이라 둘째 줄에 남는다.
  const who = shortPerson(authorOf(r)) + (isBot(r) ? ' · 봇' : '');
  if (sys === 'github' || sys === 'gitlab' || sys === 'linear') {
    const st = f.merged_at ? '머지됨' : String(f.state || '') === 'open' ? '열림' : String(f.state || '') === 'closed' ? '닫힘' : '';
    return [f.number ? '#' + f.number : '', st, who, when].filter(Boolean).join(' · ');
  }
  if (isChatSys(sys)) return [who, r.reply_n ? `답글 ${r.reply_n}` : '', when].filter(Boolean).join(' · ');
  if (sys === 'authored') return [kindLabel(r.kind), when].filter(Boolean).join(' · ');
  return [who, when].filter(Boolean).join(' · ');
}

/** 원천 칸(#4233): 올린 파일은 사람(얼굴 + 이름), AI 파일은 «AI 세션 · 자리», 수집은 «앱 · 자리», 직접 적은 글은 종류. */
function originCell(r: SrcRow): HTMLElement {
  const o = originOf(r, (name, id) => uploaderLabel(name, id));
  const f = r.fields || {};
  const lead = o.kind === 'person' && o.id ? personFace(String(f.author_external_id || o.id), 'pava v2-srl-ava', String(f.author_name || ''))
    : el('span', { class: 'v2-srl-sic' }, treeIcon(o.kind === 'ai' ? 'spark' : o.kind === 'note' ? 'note' : o.kind === 'app' ? sysIconKey(o.sys || '') : 'up'));
  return el('span', { class: 'v2-srl-src ' + o.kind, title: o.text }, lead, el('span', { class: 't', text: o.text }));
}

function rowOf(r: SrcRow, sel: SrcSel): HTMLElement {
  const f = r.fields || {};
  const priv = r.visibility === 'members';   // (#4007) 개인 루트라는 이유만으로 잠그지 않는다 — 실제 잠금만 자물쇠다
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
    originCell(r),
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
  const t = document.createElementNS(ns, 'title'); t.textContent = '지정된 사람만 봅니다';
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
  //  (#4007) 개인 루트 자동 잠금을 없앴으므로 root/share 추정을 하지 않는다 — 실제 잠금(visibility='members')만 본다.
  //   그 잠금은 이제 부서 구분 정책(org_source_vis_policy, EE)에서만 온다.
  const priv = s.visibility === 'members';
  const derived: any[] = s.knowledge || [];

  //  누가: 올린 파일은 올린 사람, 바깥 자료는 글쓴이. AI 가 만든 파일은 사람을 적지 않는다(아래 «만든 곳» 한 줄이 말한다).
  const grp = rowGroup(s);
  const who = grp === 'uploaded' ? (authorOf(s as SrcRow) ? uploaderLabel(authorOf(s as SrcRow), f.author_external_id) + ' 님이 올렸습니다' : '')
    : grp === 'collected' ? shortPerson(authorOf(s as SrcRow)) : '';
  const meta = el('div', { class: 'v2-src-dmeta' },
    el('span', { class: 'v2-src-badge', text: kindLabel(s.kind) }),
    ...(chan && !isFile ? [el('span', { class: 'mono', text: (isChat ? '#' : '') + chan })] : []),
    ...(isFile && f.bytes ? [el('span', { class: 'mono', text: bytesText(f.bytes) })] : []),
    ...(who ? [el('span', { text: who })] : []),
    el('span', { class: 'mono', text: absLike(s.occurred_at || s.updated_at) }),
    el('span', { class: 'vis' }, priv ? '지정된 사람만 봅니다' : '이 워크스페이스 사람 모두가 봅니다'));
  //  들어온 자리 한 줄(#4233): 올린 곳 · 만든 곳 · 가져온 곳. 자리는 사이드바의 묶음이 아니라 이 자료의 사실이다.
  const place = el('p', { class: 'v2-srd-place', text: placeLine(s) });

  //  문 — 파일이면 내려받기(browse API — #/f 와 같은 문)와 폴더, 남의 시스템이면 그 시스템으로.
  const acts = el('div', { class: 'v2-src-dacts' });
  const co = isFile ? fileCoords(s) : null;
  //  (#1631) 개인 폴더 파일은 브라우즈 API 가 **보는 사람 자기** 폴더로 풀린다 — 팀원 모두가 보게 올린 자료(share=team)를 동료가 열면
  //   «파일 없음» 이거나 같은 이름의 자기 파일이 열렸다. 그래서 개인 폴더 파일의 원본은 자료 id 로 연다(서버가 올린 사람 자리로 푼다).
  const orig = co && co.root === 'personal' ? '/api/ui/sources/' + encodeURIComponent(String(s.id)) + '/original' : null;
  const mine = !!myUploadName() && authorOf(s as SrcRow) === myUploadName();
  if (co) {
    const dl = orig ? orig + '?download=1' : '/api/ui/terminal/browse/file?download=1&root=' + encodeURIComponent(co.root) + '&path=' + encodeURIComponent(co.path);
    acts.append(el('button', { class: 'btn btn-sm v2-src-primary', type: 'button',
      onclick: () => { void authDownload(apiUrl(dl), String(s.title || 'file')); } },
      treeIcon('down'), el('span', { text: '내려받기' })));
    //  폴더 문은 내 개인 폴더이거나 누구에게나 같은 자리(공유·프로젝트)일 때만 — 남의 개인 폴더 주소(#/f?root=personal)는 내 폴더로 풀린다.
    if (!orig || mine) acts.append(el('a', { class: 'btn btn-sm', href: String(s.external_url), text: '폴더에서 열기' }));
  } else if (s.external_url && String(s.external_url).startsWith('#')) {
    acts.append(el('a', { class: 'btn btn-sm v2-src-primary', href: String(s.external_url), text: '폴더에서 열기' }));
  } else if (s.external_url) {
    acts.append(el('a', { class: 'btn btn-sm v2-src-primary', href: safeHref(String(s.external_url)) || '#',
      target: '_blank', rel: 'noopener' }, treeIcon('ext'), el('span', { text: sysLabel(sys) + '에서 열기' })));
  }
  if (derived.length) acts.append(el('span', { class: 'v2-srd-kchip', text: `지식 ${derived.length}건이 여기서 나왔어요` }));

  //  휴지통으로(#3778) — 종전엔 자료 앱에 지우는 문이 아예 없었다(삭제 경로 점검 2026-09-20). 되살릴 수 있는 두 갈래에만 세운다:
  //   · 글로 적어 둔 자료(외부 좌표 없음) → 자료 삭제(감사 스냅샷 → 휴지통 ▸ 자료 탭에서 되살림)
  //   · 프로젝트 폴더의 파일 → 그 파일을 지운다(서버가 숨김 자리에 보관 → 같은 탭에서 파일째 되살림)
  //   남의 시스템에서 온 것(슬랙·깃허브…)은 세우지 않는다 — 지워도 다음 수집 때 다시 들어온다. 지울 곳은 원본이다.
  //   · 내 폴더·공유 폴더의 파일 → 그 폴더에서 지운다(#3778 후속 — 브라우즈 삭제도 이제 보관한다). ⚠ **남의** 개인 폴더 파일에는 세우지 않는다:
  //     브라우즈 주소(root=personal)는 «보는 사람 자기» 폴더로 풀려, 같은 경로의 **내 파일**이 지워진다.
  const extId = String(s.external_id || '');
  const projFile = /^project:(\d+)\/(.+)$/.exec(extId);
  const me = (state.me || {}) as { userId?: string; email?: string };
  const myPersonal = !!co && co.root === 'personal' && [me.userId, me.email].some((k) => !!k && extId.startsWith('personal:' + k + '/'));
  const browseFile = !!co && !projFile && (co.root === 'shared' ? extId.startsWith('shared/') : myPersonal);
  const authoredNote = !s.external_system && !isFile;
  if (authoredNote || (isFile && (projFile || browseFile))) {
    const toTrash = el('button', { class: 'btn-text v2-srd-trash', type: 'button', text: '휴지통으로',
      title: '이 자료를 휴지통으로 보냅니다 — [휴지통] ▸ [자료] 탭에서 되살릴 수 있어요' }) as HTMLButtonElement;
    toTrash.onclick = () => { void (async () => {
      if (!await confirmDialog({
        title: `「${String(s.title || s.name || '이 자료')}」를 휴지통으로 보낼까요?`,
        message: '자료 목록과 AI 검색에서 빠집니다. [휴지통] ▸ [자료] 탭에서 되살릴 수 있어요.',
        lines: [isFile ? (projFile ? '프로젝트 폴더' : co && co.root === 'personal' ? '내 폴더' : '공유 폴더') + '의 파일도 함께 빠지고, 되살리면 원래 자리로 돌아옵니다.'
          : (derived.length ? `이 자료에서 나온 지식 ${derived.length}건은 그대로 남지만, 출처 표시는 되살려도 돌아오지 않아요.` : '적어 둔 본문은 되살리면 그대로 돌아옵니다.')],
        confirmText: '휴지통으로',
      })) return;
      toTrash.disabled = true;
      try {
        if (isFile && projFile) await api('/api/ui/v6/projects/' + projFile[1] + '/file?path=' + encodeURIComponent(projFile[2]), { method: 'DELETE' });
        else if (isFile && co) await api('/api/ui/terminal/browse?root=' + encodeURIComponent(co.root) + '&path=' + encodeURIComponent(co.path), { method: 'DELETE' });
        else await api('/api/ui/sources/' + encodeURIComponent(String(s.id)) + '/delete', { method: 'POST' });
        toast('휴지통으로 보냈어요 — [휴지통] ▸ [자료] 탭에서 되살릴 수 있어요.');
        toTrash.closest('.v2-srd-sheet')?.replaceChildren(el('p', { class: 'v2-src-empty', text: '휴지통으로 보낸 자료예요.' }));
        if (view) void loadList(view, true);
      } catch (e: any) { toTrash.disabled = false; toast('휴지통으로 보내지 못했어요 — ' + (e?.message || e), true); }
    })(); };
    acts.append(toTrash);
  }

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
    const viewUrl = orig ?? '/api/ui/terminal/browse/file?root=' + encodeURIComponent(co.root) + '&path=' + encodeURIComponent(co.path);
    const dlUrl = orig ? orig + '?download=1' : '/api/ui/terminal/browse/file?download=1&root=' + encodeURIComponent(co.root) + '&path=' + encodeURIComponent(co.path);
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
    place,
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

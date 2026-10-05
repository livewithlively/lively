// sessions-kit.ts — 세션 이력 앱(#4553)의 탭들이 함께 쓰는 부품: 내 세션 목록 받기 · 셸에 주소 부탁하기 · 「남긴 것」 그리기 ·
//  화면의 한 벌(아이콘 · 단추 · 칸 머리 · 빈 자리 · 고르개). 규칙(무엇이 어느 묶음에 서나)은 session-history.ts(순수)에,
//  대화록은 sessions.ts 에 있다.
//  디자인(원준 2026-10-05 «프로젝트 본문 창 참고해서 그 디자인 언어로»): 프로젝트 허브(37-projects-hub.css)의 문법을 따른다 —
//   카드 16 · 아이콘 타일 · 이름 800 · 26px 알약 칩 · 잉크 세그 · 줄 사이 line-row 하나 · 빈 자리는 tint 상자 · 그림자는 뜬 것에만.
import { api, el } from './core.js';
import { icon } from './v2/icons.js';
import { requestOpenRoute } from './v2/ctx-registry.js';
import { EMBEDDED } from './v2/embed.js';
import { openSessionWindow } from './lib/session-open.js';
import type { JActivity, JRow } from './session-history.js';

export const fmtBytes = (b: number): string => !b ? '' : b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : b >= 1024 ? Math.round(b / 1024) + 'KB' : b + 'B';

/** 이 화면이 v2 셸 안에 있나 — 셸 액자(?embed=1)로 실렸거나 셸 문서(#v2-root) 그 자체(projects/detail-hub-kit inShell 과 같은 판정). */
function inShell(): boolean {
  try { if (EMBEDDED && window.parent && window.parent !== window) return true; } catch { /* 못 보면 아래로 */ }
  try { return !!document.getElementById('v2-root'); } catch { return false; }
}
/** 이 주소를 연다 — 셸 안(액자)이면 셸에 부탁한다. 액자 안에서 주소를 바꾸면 세션 이력 앱 자리에 그 화면이 그려진다(#3870). */
export function openRoute(href: string): void {
  if (inShell()) requestOpenRoute(href, true);
  else location.hash = href;
}
/** 새 탭·가운데 클릭이 여는 주소 — 액자 안이면 액자 표식(?embed=1&shell=classic)을 뗀 셸 주소로. 그대로 두면 셸 없는 액자판이 새 탭에 뜬다. */
export const shellHref = (hash: string): string => (EMBEDDED ? location.pathname + hash : hash);
/** 셸 주소로 가는 링크 — 가운데 클릭·새 탭은 브라우저에 맡기고, 그냥 누르면 openRoute. */
export function routeLink(href: string, attrs: Record<string, unknown>, ...kids: unknown[]): HTMLAnchorElement {
  const a = el('a', { href: shellHref(href), ...attrs }, ...kids) as HTMLAnchorElement;
  a.addEventListener('click', (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    openRoute(href);
  });
  return a;
}
export const sessionHref = (boxId: string): string => '#/s/' + encodeURIComponent(boxId);
export const transcriptHref = (sid: string, node: string): string => '#/sessions/' + encodeURIComponent(sid) + (node ? '?node=' + encodeURIComponent(node) : '');
/**
 * 세션 화면으로 가는 문. 셸 안이면 그 세션 화면(#/s/<id> — 멈춘 세션은 그 화면이 열면서 되살린다), 셸 밖(클래식 단독 화면)은
 *  `#/s/` 주소를 모르므로 세션 터미널 창을 연다(projects/detail-hub-kit enterSession 과 같은 규칙).
 */
export function sessionLink(boxId: string, attrs: Record<string, unknown>, ...kids: unknown[]): HTMLAnchorElement {
  const href = sessionHref(boxId);
  const a = el('a', { href: shellHref(href), ...attrs }, ...kids) as HTMLAnchorElement;
  a.addEventListener('click', (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    if (inShell()) requestOpenRoute(href, true);
    else openSessionWindow(boxId);
  });
  return a;
}

// ── 내 세션 목록(중앙 기록) — 탭 셋이 같은 한 번의 응답을 쓴다 ──
//  깊이는 서버 상한(2,000)까지 — 종전 목록면은 기본 200행만 받고 «더 있다»(truncated)를 읽지 않았다.
export interface MySessions { sessions: any[]; truncated: boolean }
const MY_TTL_MS = 30_000;
let myCache: { at: number; p: Promise<MySessions> } | null = null;
export function loadMySessions(force = false): Promise<MySessions> {
  if (!force && myCache && Date.now() - myCache.at < MY_TTL_MS) return myCache.p;
  const p = api('/api/ui/v6/sessions?limit=2000').then((d: any): MySessions => ({
    //  내용 없는 세션(0바이트)과 휴지통에 있는 세션은 뺀다(#3778 — 되돌리기·완전 삭제는 휴지통 화면의 몫이다).
    sessions: (Array.isArray(d?.sessions) ? d.sessions : []).filter((s: any) => (s.bytes || 0) > 0 && !s.trashed_at),
    truncated: !!d?.truncated,
  }));
  myCache = { at: Date.now(), p };
  p.catch(() => { if (myCache && myCache.p === p) myCache = null; });   // 실패는 붙잡아 두지 않는다 — 다음에 다시 받는다
  return p;
}
export function dropMySessions(): void { myCache = null; }

// ── 화면의 한 벌 — 아이콘 · 단추 · 칸 머리 · 빈 자리 ──────────────────────────────────────────────
/** 선 아이콘(lib/icon-paths 한 벌). 크기·색은 놓인 자리의 CSS 가 정한다(.shx-ic 기본 15px). */
export const ico = (name: string, cls = ''): SVGElement => icon(name, 'shx-ic' + (cls ? ' ' + cls : ''));
/** 글자 단추. kind: 기본 = 잉크(주 동작) · ghost = 테두리 · quiet = 글자만. 글자는 span 에 든다(setBtnLabel 로 바꾼다 — 아이콘이 남는다). */
export function btnOf(label: string, o: { icon?: string; kind?: 'ghost' | 'quiet'; title?: string; cls?: string } = {}): HTMLButtonElement {
  return el('button', { type: 'button', class: 'shx-btn' + (o.kind ? ' ' + o.kind : '') + (o.cls ? ' ' + o.cls : ''), ...(o.title ? { title: o.title } : {}) },
    o.icon ? ico(o.icon) : null, el('span', { class: 'shx-btn-l', text: label })) as HTMLButtonElement;
}
export function setBtnLabel(btn: HTMLElement, text: string): void {
  const l = btn.querySelector('.shx-btn-l');
  if (l) l.textContent = text; else btn.textContent = text;
}
/** 아이콘만 있는 단추 — 이름은 title · aria-label 이 말한다. */
export function ibtnOf(iconName: string, label: string, cls = ''): HTMLButtonElement {
  return el('button', { type: 'button', class: 'shx-ibtn' + (cls ? ' ' + cls : ''), title: label, 'aria-label': label }, ico(iconName)) as HTMLButtonElement;
}
/** 아이콘 타일(허브 카드 머리의 그 타일). tone: blue · mint · amber · 없음(중립). */
export const tileOf = (iconName: string, tone = ''): HTMLElement => el('span', { class: 'shx-tile' + (tone ? ' ' + tone : '') }, ico(iconName)) as HTMLElement;

/** 칸 머리 — 타일 · 이름 · 부제 · 도구(링크·휴지통 …) · 문(세션으로 가는 단추). 대화록과 세션 목록의 상세가 같은 머리를 쓴다. */
export interface PaneHead { el: HTMLElement; tile: HTMLElement; title: HTMLElement; sub: HTMLElement; tools: HTMLElement; acts: HTMLElement }
export function paneHead(name: string, o: { icon?: string; tone?: string; sub?: string } = {}): PaneHead {
  const tile = tileOf(o.icon || 'chat', o.tone || '');
  const title = el('h2', { class: 'sess-title', text: name, title: name }) as HTMLElement;
  const sub = el('div', { class: 'shx-ph-sub', text: o.sub || '' }) as HTMLElement;
  const tools = el('div', { class: 'shx-ph-tools' }) as HTMLElement;
  const acts = el('div', { class: 'shx-ph-acts' }) as HTMLElement;
  return { el: el('header', { class: 'shx-ph' }, tile, el('div', { class: 'shx-ph-t' }, title, sub), tools, acts) as HTMLElement, tile, title, sub, tools, acts };
}
/** 빈 자리 — 타일 · 한 줄 제목 · 설명 · (있으면) 단추. big = 칸 한가운데에 서는 큰 판. */
export function emptyBox(o: { icon?: string; title: string; text?: string; big?: boolean; action?: HTMLElement | null }): HTMLElement {
  return el('div', { class: 'shx-empty' + (o.big ? ' big' : '') },
    tileOf(o.icon || 'info'),
    el('div', { class: 'shx-empty-b' }, el('div', { class: 'shx-empty-t', text: o.title }), o.text ? el('div', { class: 'shx-empty-s', text: o.text }) : null),
    o.action || null) as HTMLElement;
}
/** 실패를 말하는 자리 — 서버가 말한 이유를 그대로. */
export const errBox = (text: string): HTMLElement => el('div', { class: 'shx-err', role: 'alert' }, ico('alert'), el('span', { text })) as HTMLElement;
/** 받는 동안의 자리 — 줄 모양 뼈대 n 개. */
export function skelRows(n = 5, cls = ''): HTMLElement {
  return el('div', { class: 'shx-skel' + (cls ? ' ' + cls : ''), 'aria-busy': 'true', 'aria-label': '불러오는 중' },
    ...Array.from({ length: n }, (_, i) => el('div', { class: 'shx-skel-r', style: '--i:' + i }, el('i', {}), el('i', {})))) as HTMLElement;
}
/**
 * 이 요소를 창 바닥까지 채운다 — 앱은 문서를 스크롤하지 않고 칸마다 제 안에서 스크롤한다(본문 창과 같은 결).
 *  높이는 CSS 변수(--shx-h)로만 준다: 좁은 화면(한 칸)에서는 CSS 가 그 값을 쓰지 않고 문서 스크롤로 돌아간다.
 */
export function fitHeight(node: HTMLElement, bottom = 14): void {
  const apply = (): void => {
    if (!node.isConnected) { window.removeEventListener('resize', apply); return; }
    const top = node.getBoundingClientRect().top + (window.scrollY || 0);
    node.style.setProperty('--shx-h', Math.max(420, Math.round(window.innerHeight - top - bottom)) + 'px');
  };
  window.addEventListener('resize', apply);
  apply();
}

// ── 「남긴 것」 — 한 일(작업 기록) · 산출 지식 · 맡은 태스크 · 커밋 · 고친 파일 ──
const ACT_TYPE: Record<string, string> = { feature: '기능', fix: '수정', decision: '결정', docs: '문서', research: '조사', review: '검토', chore: '정리', other: '작업' };
export const actTypeLabel = (t: string): string => ACT_TYPE[t] || '작업';
/** 기록 종류의 색 — 만든 것(파랑) · 고친 것(호박) · 글로 남긴 것(민트) · 그 밖(중립). */
const ACT_TONE: Record<string, string> = { feature: 'blue', fix: 'amber', decision: 'mint', docs: 'mint', research: 'mint' };
export const actTypePill = (t: string): HTMLElement => el('span', { class: 'shx-type ' + (ACT_TONE[t] || ''), text: actTypeLabel(t) }) as HTMLElement;

export function leftChips(r: Pick<JRow, 'knowledge' | 'tasks' | 'activities' | 'edits'>): HTMLElement {
  const box = el('div', { class: 'shx-chips' });
  for (const k of r.knowledge) box.append(routeLink('#/k/' + encodeURIComponent(k.name), { class: 'shx-chip k', title: '지식 열기 — ' + (k.title || k.name) }, ico('wiki'), el('span', { text: k.title || k.name })));
  for (const t of r.tasks) {
    const done = t.status === 'done';
    box.append(routeLink('#/projects2/t/' + t.id, { class: 'shx-chip t' + (done ? ' done' : ''), title: '태스크 열기 — ' + (done ? '완료' : '진행 중') },
      ico(done ? 'check' : 'task'), el('span', { text: `#${t.id} ${t.name}` })));
  }
  const commits = r.activities.filter((a) => a.commit).length;
  if (commits) box.append(el('span', { class: 'shx-chip', title: '커밋을 남긴 작업 기록 수' }, ico('code'), el('span', { text: `커밋 ${commits}` })));
  if (r.edits) box.append(el('span', { class: 'shx-chip', title: '이 세션이 고친 파일 수' }, ico('pen'), el('span', { text: `고친 파일 ${r.edits}` })));
  return box;
}
export function activityLine(a: JActivity): HTMLElement {
  return el('div', { class: 'shx-act' },
    actTypePill(a.type),
    el('div', { class: 'shx-act-body' },
      el('div', { class: 'shx-act-title', text: a.title || '(제목 없음)', title: a.title || '' }),
      a.summary && a.summary !== a.title ? el('div', { class: 'shx-act-sum', text: a.summary, title: a.summary }) : null));
}

/** 「이 세션이 남긴 것」 칸 — 세션 하나의 일지 줄을 받아 그린다. 내 세션이 아니면(404) 칸을 세우지 않는다.
 *  onRow — 줄을 받았을 때(그 대화를 돌린 박스를 알게 됐을 때) 부르는 쪽이 할 일(대화록 머리의 문을 바꾼다).
 *  세션으로 가는 문은 여기 두지 않는다 — 칸 머리에 하나만 선다. */
export function leftPanel(sid: string, node: string, onRow?: (r: JRow) => void): HTMLElement {
  const body = el('div', { class: 'shx-left-b' }, skelRows(2, 'tight'));
  const box = el('section', { class: 'shx-left', 'aria-label': '이 세션이 남긴 것' }, el('div', { class: 'shx-rail-h', text: '이 세션이 남긴 것' }), body);
  api('/api/ui/v6/session-journal?session_id=' + encodeURIComponent(sid) + '&node_id=' + encodeURIComponent(node))
    .then((d: any) => {
      const r: JRow | null = d && d.row ? d.row : null;
      if (!r) { box.remove(); return; }
      if (onRow) onRow(r);
      const has = r.activities.length || r.knowledge.length || r.tasks.length || r.edits;
      if (!has) { body.replaceChildren(el('p', { class: 'shx-note', text: '적어 둔 작업 기록 · 만든 지식 · 맡은 태스크가 없습니다.' })); return; }
      body.replaceChildren(...r.activities.map(activityLine), leftChips(r));
    })
    .catch((e: any) => {
      //  남의 세션(초대받아 보는 대화록)은 일지가 없다 — 칸을 걷는다. 그 밖의 실패는 그렇다고 말한다.
      if (e && (e.status === 404 || /찾을 수 없/.test(String(e.message || '')))) box.remove();
      else body.replaceChildren(el('p', { class: 'shx-note', text: '남긴 것을 불러오지 못했습니다.' }));
    });
  return box;
}

// ── 고르개 ──
/** 알약 고르개 하나 — 값이 바뀌면 onChange. 기본값(첫 항목)이 아니면 켜진 색이 된다. select 는 .shx-pick 안에 든다(pickOf). */
export function selectOf<T extends string>(opts: ReadonlyArray<{ key: T; label: string }>, value: T, onChange: (v: T) => void, label: string): HTMLSelectElement {
  const s = el('select', { class: 'shx-select', 'aria-label': label }, ...opts.map((o) => el('option', { value: o.key, text: o.label }))) as HTMLSelectElement;
  s.value = value;
  s.addEventListener('change', () => onChange(s.value as T));
  return s;
}
/** select 를 알약으로 감싼다 — 첫 항목(«전부»)이 아닌 값이면 .on. */
export function pickOf(select: HTMLSelectElement, iconName?: string): HTMLElement {
  const wrap = el('span', { class: 'shx-pick' }, iconName ? ico(iconName) : null, select, ico('chevD', 'shx-pick-c')) as HTMLElement;
  const paint = (): void => { wrap.classList.toggle('on', select.selectedIndex > 0); };
  select.addEventListener('change', paint);
  //  값을 코드로 바꾼 뒤(목록을 늦게 채운 프로젝트 고르개)에도 맞추게 부르는 쪽이 다시 칠할 수 있다.
  (wrap as HTMLElement & { repaint?: () => void }).repaint = paint;
  paint();
  return wrap;
}
/** 나란한 단추 묶음(하나만 켜진다). */
export function segOf<T extends string>(opts: ReadonlyArray<{ key: T; label: string }>, value: T, onChange: (v: T) => void, label: string): HTMLElement {
  const box = el('div', { class: 'shx-seg', role: 'group', 'aria-label': label });
  const paint = (v: T): void => { for (const b of Array.from(box.children) as HTMLElement[]) { const on = b.dataset.key === v; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); } };
  for (const o of opts) {
    const b = el('button', { type: 'button', class: 'shx-seg-b', 'data-key': o.key, text: o.label }) as HTMLButtonElement;
    b.addEventListener('click', () => { paint(o.key); onChange(o.key); });
    box.append(b);
  }
  paint(value);
  return box;
}
/** 거르개 칩 묶음(하나만 켜진다) — 칩마다 그 묶음의 수가 선다. setCounts 로 수를 채운다. */
export interface FilterChips<T extends string> { el: HTMLElement; setCounts: (counts: Partial<Record<T, number>>) => void }
export function filterChips<T extends string>(opts: ReadonlyArray<{ key: T; label: string; dot?: string }>, value: T, onChange: (v: T) => void, label: string): FilterChips<T> {
  const box = el('div', { class: 'shx-fchips', role: 'group', 'aria-label': label }) as HTMLElement;
  const nums = new Map<T, HTMLElement>();
  const paint = (v: T): void => { for (const b of Array.from(box.children) as HTMLElement[]) { const on = b.dataset.key === v; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); } };
  for (const o of opts) {
    const n = el('b', { class: 'shx-fchip-n' }) as HTMLElement;
    nums.set(o.key, n);
    const b = el('button', { type: 'button', class: 'shx-fchip', 'data-key': o.key }, o.dot ? el('span', { class: 'shx-dot ' + o.dot }) : null, el('span', { class: 'shx-fchip-l', text: o.label }), n) as HTMLButtonElement;
    b.addEventListener('click', () => { paint(o.key); onChange(o.key); });
    box.append(b);
  }
  paint(value);
  return { el: box, setCounts: (counts) => { for (const [k, n] of nums) n.textContent = counts[k] == null ? '' : String(counts[k]); } };
}
/** 찾기 칸 — 돋보기 · 입력 · 지우기(글자가 있을 때만). 입력은 부르는 쪽이 만든 것을 그대로 쓴다(값·이벤트는 그쪽 것). */
export function searchBox(input: HTMLInputElement, onClear: () => void): HTMLElement {
  const clear = ibtnOf('x', '지우기', 'shx-search-x');
  const sync = (): void => { clear.hidden = !input.value; };
  input.addEventListener('input', sync);
  input.addEventListener('keyup', sync);   // Esc 로 비운 뒤(값만 바뀌고 input 이벤트는 없다)에도 맞춘다
  clear.addEventListener('click', () => { input.value = ''; sync(); onClear(); input.focus(); });
  sync();
  return el('label', { class: 'shx-search' }, ico('search'), input, clear) as HTMLElement;
}

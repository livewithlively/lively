// sessions-kit.ts — 세션 이력 앱(#4553)의 탭들이 함께 쓰는 부품: 내 세션 목록 받기 · 셸에 주소 부탁하기 · 「남긴 것」 그리기.
//  규칙(무엇이 어느 묶음에 서나)은 session-history.ts(순수)에, 대화록은 sessions.ts 에 있다.
import { api, el } from './core.js';
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

// ── 「남긴 것」 — 산출 지식 · 맡은 태스크 · 커밋 · 고친 파일 ──
const ACT_TYPE: Record<string, string> = { feature: '기능', fix: '수정', decision: '결정', docs: '문서', research: '조사', review: '검토', chore: '정리', other: '작업' };
export const actTypeLabel = (t: string): string => ACT_TYPE[t] || '작업';

export function leftChips(r: Pick<JRow, 'knowledge' | 'tasks' | 'activities' | 'edits'>): HTMLElement {
  const box = el('div', { class: 'shx-chips' });
  for (const k of r.knowledge) box.append(routeLink('#/k/' + encodeURIComponent(k.name), { class: 'shx-chip k', title: '지식 열기' }, '지식 · ' + (k.title || k.name)));
  for (const t of r.tasks) box.append(routeLink('#/projects2/t/' + t.id, { class: 'shx-chip t', title: '태스크 열기' }, `태스크 · #${t.id} ${t.name}` + (t.status === 'done' ? ' · 완료' : '')));
  const commits = r.activities.filter((a) => a.commit).length;
  if (commits) box.append(el('span', { class: 'shx-chip', text: `커밋 ${commits}` }));
  if (r.edits) box.append(el('span', { class: 'shx-chip', text: `고친 파일 ${r.edits}` }));
  return box;
}
export function activityLine(a: JActivity): HTMLElement {
  return el('div', { class: 'shx-act' },
    el('span', { class: 'shx-act-type', text: actTypeLabel(a.type) }),
    el('div', { class: 'shx-act-body' },
      el('div', { class: 'shx-act-title', text: a.title || '(제목 없음)' }),
      a.summary && a.summary !== a.title ? el('div', { class: 'shx-act-sum', text: a.summary }) : null));
}

/** 「이 세션이 남긴 것」 칸 — 세션 하나의 일지 줄을 받아 그린다. 내 세션이 아니면(404) 칸을 세우지 않는다.
 *  onRow — 줄을 받았을 때(그 대화를 돌린 박스를 알게 됐을 때) 부르는 쪽이 할 일(대화록 머리의 문을 바꾼다). */
export function leftPanel(sid: string, node: string, onRow?: (r: JRow) => void): HTMLElement {
  const body = el('div', { class: 'admin-hint', text: '불러오는 중…' });
  const head = el('div', { class: 'shx-left-head' }, el('h4', { text: '이 세션이 남긴 것' }));
  const box = el('div', { class: 'shx-left' }, head, body);
  api('/api/ui/v6/session-journal?session_id=' + encodeURIComponent(sid) + '&node_id=' + encodeURIComponent(node))
    .then((d: any) => {
      const r: JRow | null = d && d.row ? d.row : null;
      if (!r) { box.remove(); return; }
      //  이 대화를 돌린 박스를 알면 세션 화면으로 가는 문을 머리에 단다(멈춘 세션은 그 화면이 열면서 되살린다).
      if (r.box_id) head.append(sessionLink(r.box_id, { class: 'shx-left-open' }, '세션 열기 →'));
      if (onRow) onRow(r);
      const has = r.activities.length || r.knowledge.length || r.tasks.length || r.edits;
      if (!has) { body.textContent = '적어 둔 작업 기록 · 만든 지식 · 맡은 태스크가 없습니다.'; return; }
      body.className = '';
      body.replaceChildren(...r.activities.map(activityLine), leftChips(r));
    })
    .catch((e: any) => {
      //  남의 세션(초대받아 보는 대화록)은 일지가 없다 — 칸을 걷는다. 그 밖의 실패는 그렇다고 말한다.
      if (e && (e.status === 404 || /찾을 수 없/.test(String(e.message || '')))) box.remove();
      else body.textContent = '남긴 것을 불러오지 못했습니다.';
    });
  return box;
}

/** 고르개 하나 — 값이 바뀌면 onChange. */
export function selectOf<T extends string>(opts: ReadonlyArray<{ key: T; label: string }>, value: T, onChange: (v: T) => void, label: string): HTMLSelectElement {
  const s = el('select', { class: 'shx-select', 'aria-label': label }, ...opts.map((o) => el('option', { value: o.key, text: o.label }))) as HTMLSelectElement;
  s.value = value;
  s.addEventListener('change', () => onChange(s.value as T));
  return s;
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

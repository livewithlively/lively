// timeline.ts — 우패널 공용 **타임라인**(#1719). 화면마다 대상만 바뀌고 생김새·어휘는 한 벌이다.
//   프로젝트 → 그 프로젝트에서 일어난 일 · AI 세션 → 그 세션이 한 일 · 홈/리브 → 워크스페이스에서 일어난 일.
//
//  ── 무엇을 적나 (상민님 2026-08-18) ──
//   "일반 사람 입장에서 **중요한 변화·새로 만든 파일·중요한 결정**만. 쓸데없는 얘기는 하나도 없게.
//    모두 한 줄 안에 요약하고, 자세한 건 눌러서."
//   규칙 셋:
//    ① 사건이 아닌 것은 **아예 안 적는다** — 임시파일·스크린샷·조회 명령은 일한 자취가 아니다(거르기는 session-trail.ts).
//    ② 모든 줄은 **한 줄**이다 — 넘치면 자른다. 원문은 툴팁에.
//    ③ 일은 **장(章)으로 접힌다** — 세션은 지시 하나가 한 장, 프로젝트는 작업 기록 하나가 한 장.
//       접힌 장에는 제목과 결과 배지(파일 4 · 커밋 1)만 보이고, 누르면 그 안이 펼쳐진다.
//
//  ── 위계 ──
//   손으로 매기지 않는다. tierOf(kind, verb) 규칙 하나가 정한다(상태 어휘 session-status.ts 와 같은 규약).
//    1 중요한 것(기본 보기) — 파일 씀·고침 · 지식 남김 · 커밋 · 작업 기록 · 태스크 끝냄 · 상태 바뀜
//    2 한 일 — 읽음 · 찾아봄 · 검사(빌드·테스트)
//    3 뒷일 — 지시·잔 편집·배관(머지·푸시·서버 반영)
import { el, personFace, relTime } from './core.js';

export type TlTier = 1 | 2 | 3;
export type TlKind = 'file' | 'cmd' | 'knowledge' | 'activity' | 'project' | 'task' | 'source' | 'say' | 'meta';

export interface TlActor { id?: string | null; name?: string | null; agent?: string | null }
/** 장 안에 접혀 있는 한 줄 — 그 항목이 스스로 데리고 있는 것(작업 기록의 산출지식·커밋 등). */
export interface TlChild { verb: string; label: string; href?: string | null }
export interface TlItem {
  id: string;
  kind: TlKind;
  verb: string;            // 씀 · 고침 · 남김 · 커밋 · 끝냄 · 기록 · 읽음 · 찾아봄 · 검사 · 지시 …
  label: string;           // 사람 말 한 줄
  key: string;             // 접기 열쇠(같은 것 연속이면 ×N)
  ts?: string;
  tier?: TlTier;
  detail?: string;         // 툴팁·펼침용 부연(한 줄 화면에는 안 나온다)
  actor?: TlActor | null;
  href?: string | null;    // 누르면 갈 가운데 화면
  children?: TlChild[];    // 있으면 이 항목이 곧 장이 된다
  count: number;
  error?: boolean;
}

// ── 위계표 ──────────────────────────────────────────────────────────────────
const KEEP_VERBS = new Set(['씀', '고침', '남김', '덧붙임', '만듦', '끝냄', '커밋', '기록', '바꿈']);
const KIND_TIER: Record<TlKind, TlTier> = {
  file: 2, cmd: 2, knowledge: 2, activity: 1, project: 2, task: 2, source: 2, say: 3, meta: 3,
};
export function tierOf(it: { kind: TlKind; verb: string; tier?: TlTier }): TlTier {
  if (it.tier) return it.tier;
  if (KEEP_VERBS.has(it.verb)) return 1;
  return KIND_TIER[it.kind] ?? 2;
}

export const TL_KINDS: Array<{ key: TlKind; label: string }> = [
  { key: 'file', label: '파일' }, { key: 'knowledge', label: '지식' }, { key: 'activity', label: '작업 기록' },
  { key: 'cmd', label: '명령' }, { key: 'task', label: '태스크' }, { key: 'project', label: '프로젝트' },
  { key: 'source', label: '자료' }, { key: 'say', label: '지시' }, { key: 'meta', label: '잔 변경' },
];
const KIND_LABEL = new Map<TlKind, string>(TL_KINDS.map((k) => [k.key, k.label]));

const VIEWS: Array<{ key: 'keep' | 'work' | 'all'; label: string; max: TlTier; hint: string }> = [
  { key: 'keep', label: '중요한 것', max: 1, hint: '남은 변화만 — 파일·지식·커밋·기록·완료' },
  { key: 'work', label: '한 일', max: 2, hint: '남은 변화 + 그 과정(읽음·찾아봄·검사)' },
  { key: 'all', label: '전부', max: 3, hint: '지시·잔 변경·배관까지 전부' },
];
const VIEW_KEY = 'lively_tl_view';

const hhmm = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
};
const dayOf = (iso?: string): string => (iso || '').slice(0, 10);
function dayLabel(key: string): string {
  const today = new Date();
  const t = today.toISOString().slice(0, 10);
  const y = new Date(today.getTime() - 864e5).toISOString().slice(0, 10);
  if (key === t) return '오늘';
  if (key === y) return '어제';
  const d = new Date(key + 'T00:00:00');
  return Number.isFinite(d.getTime()) ? (d.getMonth() + 1) + '월 ' + d.getDate() + '일' : key;
}
const tsNum = (iso?: string): number => { const n = Date.parse(iso || ''); return Number.isFinite(n) ? n : 0; };
function span(a?: string, b?: string): string {
  const m = Math.round((tsNum(b) - tsNum(a)) / 60000);
  if (!Number.isFinite(m) || m <= 0) return '';
  return m < 60 ? m + '분' : Math.floor(m / 60) + '시간' + (m % 60 ? ' ' + (m % 60) + '분' : '');
}

// ── 사람 말로 ───────────────────────────────────────────────────────────────
//  개발 도구의 원문(커밋 문법 feat(ui):, 꼬리표 (#1719)·PR #146)을 그대로 붙여넣지 않는다.
const CONV_PREFIX = /^(feat|fix|chore|docs|refactor|test|perf|style|build|ci|design)(\([^)]*\))?:\s*/i;
const TAIL_REF = /\s*[·,]?\s*\(?(?:lively\s*)?(?:dev\s*반영\s*[·,]?\s*)?PR\s*#\d+\)?\s*$/i;
const TAIL_NUM = /\s*\(?#\d+\)?\s*$/;
function stripRefs(t: string): string {
  let s = t;
  for (let i = 0; i < 3; i++) s = s.replace(TAIL_REF, '').replace(TAIL_NUM, '').trim();
  return s;
}
/** 커밋 메시지·PR 제목·지시 → 한 줄. */
export function humanTitle(raw: unknown, max = 44): string {
  let t = String(raw ?? '').split('\n')[0].replace(/\s+/g, ' ').trim().replace(CONV_PREFIX, '');
  t = stripRefs(t);
  const dash = t.search(/\s[—–]\s/);            // 부연은 뒤에 온다 — 앞 마디만
  if (dash > 10) t = t.slice(0, dash);
  return t.length > max ? t.slice(0, max - 1).replace(/[\s·,]+$/, '') + '…' : t;
}
/** 작업 기록 요약 → 한 줄. '중분류 - 내용' 규약이면 내용이 본체다. */
export function humanSummary(raw: unknown, max = 46): string {
  let t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{2,14}?)\s+-\s+(.+)$/);
  if (m) t = m[2];
  t = stripRefs(t);
  return t.length > max ? t.slice(0, max - 1).replace(/[\s·,]+$/, '') + '…' : t;
}

export interface TimelineCtx {
  scope: string;
  showActors?: boolean;
  empty?: string;
  /** 세션처럼 '지시 하나 = 한 장'으로 묶을 화면이면 true. */
  chapters?: boolean;
}
export interface TimelineHandle {
  add(item: { id: string; kind: string; verb: string; label: string; key: string; ts?: string; detail?: string; actor?: TlActor | null; href?: string | null; tier?: TlTier; children?: TlChild[] }, at?: 'end' | 'start'): void;
  result(id: string, output: string, isError: boolean): void;
  addAll(items: Array<Omit<TlItem, 'count'> & { count?: number }>): void;
  setNote(note: string | null): void;
  clear(): void;
  root: HTMLElement;
}

export function createTimeline(host: HTMLElement, ctx: TimelineCtx): TimelineHandle {
  let items: TlItem[] = [];                    // 시간순(오래된 → 최신). 화면은 최신이 위.
  const byId = new Map<string, TlItem>();
  const open = new Set<string>();              // 펼친 장
  let view: 'keep' | 'work' | 'all' = 'keep';
  try { const v = localStorage.getItem(VIEW_KEY); if (v === 'keep' || v === 'work' || v === 'all') view = v; } catch (_) { /* noop */ }
  let kindFilter: TlKind | null = null;
  let kindsOpen = false;
  let dirty = false;

  const countEl = el('span', { class: 'v2-k' });
  const seg = el('div', { class: 'tl-seg', role: 'group', 'aria-label': '무엇까지 볼지' });
  const kindRow = el('div', { class: 'tl-kinds', hidden: true });
  const list = el('div', { class: 'tl-list' });
  const emptyEl = el('p', { class: 'v2-empty', text: ctx.empty || '아직 기록이 없어요.' });
  const noteEl = el('p', { class: 'v2-fine', hidden: true });
  const root = el('section', { class: 'tl-wrap' },
    el('div', { class: 'v2-aside-h' }, el('b', { text: '타임라인' }), el('span', { class: 'tl-scope', text: ctx.scope }), countEl),
    seg, kindRow, list, emptyEl, noteEl);
  host.append(root);

  const visible = (it: TlItem): boolean => {
    const max = (VIEWS.find((v) => v.key === view) || VIEWS[0]).max;
    return tierOf(it) <= max && (!kindFilter || it.kind === kindFilter);
  };
  const isHead = (it: TlItem): boolean => !!ctx.chapters && it.kind === 'say' && it.verb === '지시';

  // ── 필터 ──
  function drawSeg(): void {
    const n = (max: TlTier) => items.filter((it) => tierOf(it) <= max && (!kindFilter || it.kind === kindFilter)).length;
    seg.replaceChildren(
      ...VIEWS.map((v) => el('button', {
        class: 'tl-seg-b' + (view === v.key ? ' on' : ''), type: 'button', 'aria-pressed': String(view === v.key), title: v.hint,
        onclick: () => { view = v.key; try { localStorage.setItem(VIEW_KEY, v.key); } catch (_) { /* noop */ } drawSeg(); paint(); },
      }, el('span', { text: v.label }), el('span', { class: 'n', text: String(n(v.max)) }))),
      el('button', {
        class: 'tl-kind-b' + (kindFilter ? ' on' : '') + (kindsOpen ? ' open' : ''), type: 'button',
        'aria-expanded': String(kindsOpen), title: '종류로 좁혀 보기',
        onclick: () => { kindsOpen = !kindsOpen; drawKinds(); drawSeg(); },
      }, el('span', { text: kindFilter ? (KIND_LABEL.get(kindFilter) || '종류') : '종류' })));
  }
  function drawKinds(): void {
    kindRow.hidden = !kindsOpen;
    if (!kindsOpen) return;
    const counts = new Map<TlKind, number>();
    for (const it of items) counts.set(it.kind, (counts.get(it.kind) || 0) + 1);
    const mk = (key: TlKind | null, label: string, n: number) => el('button', {
      class: 'tl-kchip' + (kindFilter === key ? ' on' : ''), type: 'button', 'aria-pressed': String(kindFilter === key),
      onclick: () => { kindFilter = key; drawKinds(); drawSeg(); paint(); },
    }, el('span', { class: 'tl-dot tlk-' + (key || 'all'), 'aria-hidden': 'true' }), el('span', { text: label }), el('span', { class: 'n', text: String(n) }));
    kindRow.replaceChildren(mk(null, '전체', items.length),
      ...TL_KINDS.filter((k) => counts.get(k.key)).map((k) => mk(k.key, k.label, counts.get(k.key) || 0)));
  }

  // ── 한 줄 ──
  function line(it: TlItem): HTMLElement {
    const tier = tierOf(it);
    const face = ctx.showActors && it.actor && (it.actor.id || it.actor.name)
      ? personFace(String(it.actor.id || ''), 'tl-face', String(it.actor.name || it.actor.id || '')) : null;
    const tip = [it.label, it.detail, it.actor && it.actor.name ? String(it.actor.name) + (it.actor.agent ? ' · ' + it.actor.agent : '') : '', it.ts ? relTime(it.ts) : '']
      .filter(Boolean).join('\n');
    return el(it.href ? 'a' : 'div', {
      class: 'tl-ev t' + tier + ' tlk-' + it.kind + (it.href ? ' go' : '') + (it.error ? ' err' : ''),
      href: it.href || null, title: tip, 'data-kind': it.kind,
    },
      el('span', { class: 'tl-verb', text: it.verb }),
      el('span', { class: 'tl-ttl', text: it.label || '(이름 없음)' }),
      it.count > 1 ? el('span', { class: 'tl-x', text: '×' + it.count }) : null,
      face, el('span', { class: 'tl-tm', text: hhmm(it.ts) }));
  }
  function childLine(c: TlChild): HTMLElement {
    return el(c.href ? 'a' : 'div', { class: 'tl-ev t2' + (c.href ? ' go' : ''), href: c.href || null, title: c.label },
      el('span', { class: 'tl-verb', text: c.verb }), el('span', { class: 'tl-ttl', text: c.label }));
  }

  // ── 장(章) ──
  function badges(kids: TlItem[], extra?: TlChild[]): HTMLElement | null {
    const c = new Map<string, number>();
    for (const k of kids) {
      if (tierOf(k) !== 1) continue;
      const w = k.kind === 'cmd' ? k.verb : (KIND_LABEL.get(k.kind) || k.kind);
      c.set(w, (c.get(w) || 0) + k.count);
    }
    for (const e of extra || []) c.set(e.verb, (c.get(e.verb) || 0) + 1);
    if (!c.size) return null;
    const dotOf = (w: string) => (w === '파일' ? 'file' : w === '지식' ? 'knowledge' : w === '커밋' ? 'cmd' : w === '태스크' ? 'task' : 'activity');
    return el('span', { class: 'tl-bdgs', title: [...c.entries()].map(([w, n]) => w + ' ' + n).join(' · ') },
      ...[...c.entries()].slice(0, 3).map(([w, n]) =>
        el('span', { class: 'tl-bdg' }, el('span', { class: 'tl-dot tlk-' + dotOf(w), 'aria-hidden': 'true' }), String(n))));
  }
  function chapter(head: TlItem, kids: TlItem[]): HTMLElement {
    const id = head.id;
    const isOpen = open.has(id);
    const shownKids = kids.filter(visible);
    const kidsBox = el('div', { class: 'tl-ch-body', hidden: !isOpen },
      ...shownKids.slice().reverse().map(line), ...(head.children || []).map(childLine));
    const car = el('button', {
      class: 'tl-car', type: 'button', 'aria-expanded': String(isOpen), 'aria-label': isOpen ? '접기' : '펼치기', text: '›',
      onclick: (e: Event) => { e.preventDefault(); e.stopPropagation(); if (isOpen) open.delete(id); else open.add(id); paint(); },
    });
    const dur = kids.length ? span(head.ts, kids[kids.length - 1].ts) : '';
    const ttl = el(head.href ? 'a' : 'span', { class: 'tl-ch-ttl' + (head.href ? ' go' : ''), href: head.href || null, text: head.kind === 'activity' ? head.label : humanTitle(head.label, 40) });
    const row = el('div', { class: 'tl-ch-top', title: [head.label, head.detail].filter(Boolean).join('\n') },
      car, ttl, badges(kids, head.children), dur ? el('span', { class: 'tl-dur', text: dur }) : null,
      ctx.showActors && head.actor && head.actor.id ? personFace(String(head.actor.id), 'tl-face', String(head.actor.name || '')) : null,
      el('span', { class: 'tl-tm', text: hhmm(head.ts) }));
    return el('div', { class: 'tl-ch' + (isOpen ? ' open' : '') }, row, kidsBox);
  }

  // ── 그리기 ──
  function paint(): void {
    type Row = { head: TlItem; kids: TlItem[] } | { solo: TlItem };
    const rows: Row[] = [];
    let cur: { head: TlItem; kids: TlItem[] } | null = null;
    for (const it of items) {
      if (isHead(it)) { cur = { head: it, kids: [] }; rows.push(cur); continue; }
      if (cur) cur.kids.push(it); else rows.push({ solo: it });
    }
    const shownRows = rows.filter((r) => ('solo' in r ? visible(r.solo) : (r.kids.some(visible) || view === 'all')));
    const shownCount = rows.reduce((n, r) => n + ('solo' in r ? (visible(r.solo) ? 1 : 0) : r.kids.filter(visible).length), 0);
    countEl.textContent = String(shownCount);
    emptyEl.hidden = shownCount > 0;

    const kids: HTMLElement[] = [];
    let day = ' ';
    let rail: HTMLElement = el('div', { class: 'tl-rail' });
    for (let i = shownRows.length - 1; i >= 0; i--) {           // 최신이 위
      const r = shownRows[i];
      const ts = 'solo' in r ? r.solo.ts : r.head.ts;
      const d = dayOf(ts);
      if (d !== day) {
        day = d;
        if (d) kids.push(el('div', { class: 'tl-day' }, el('span', { text: dayLabel(d) })));
        rail = el('div', { class: 'tl-rail' });
        kids.push(rail);
      }
      rail.append('solo' in r
        ? (r.solo.children && r.solo.children.length ? chapter(r.solo, []) : line(r.solo))
        : chapter(r.head, r.kids));
    }
    list.replaceChildren(...kids);
  }
  function schedule(): void {
    if (dirty) return;
    dirty = true;
    requestAnimationFrame(() => { dirty = false; drawSeg(); drawKinds(); paint(); });
  }

  function merge(it: TlItem, at: 'end' | 'start'): boolean {
    const nb = at === 'end' ? items[items.length - 1] : items[0];
    if (!nb || nb.key !== it.key || nb.error || it.error) return false;
    nb.count++;
    if (at === 'end' && it.ts) nb.ts = it.ts;
    byId.set(it.id, nb);
    return true;
  }

  const h: TimelineHandle = {
    root,
    add(raw, at = 'end') {
      const it: TlItem = { count: 1, ...raw, kind: (raw.kind as TlKind) || 'cmd' };
      if (!merge(it, at)) {
        if (at === 'end') items.push(it); else items.unshift(it);
        byId.set(it.id, it);
        if (isHead(it) && at === 'end') { open.clear(); open.add(it.id); }   // 지금 하는 일만 펼친 채로
      }
      schedule();
    },
    result(id, _output, isError) {
      const it = byId.get(id);
      if (!it || !isError) return;
      it.error = true;
      schedule();
    },
    addAll(next) {
      for (const raw of next) {
        const it: TlItem = { count: 1, ...raw };
        const old = byId.get(it.id);
        if (old) { Object.assign(old, it, { count: old.count }); continue; }
        items.push(it); byId.set(it.id, it);
      }
      items.sort((a, b) => tsNum(a.ts) - tsNum(b.ts));
      schedule();
    },
    setNote(note) { noteEl.textContent = note || ''; noteEl.hidden = !note; },
    clear() { items = []; byId.clear(); open.clear(); schedule(); },
  };
  drawSeg(); paint();
  return h;
}

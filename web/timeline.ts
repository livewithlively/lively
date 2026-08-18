// timeline.ts — 우패널 공용 **타임라인**(#1719). 화면마다 대상만 바뀌고 생김새·어휘는 한 벌이다.
//   프로젝트 → 그 프로젝트에서 일어난 일 · AI 세션 → 그 세션이 한 일 · 홈/리브 → 워크스페이스에서 일어난 일.
//
//  ── 무엇을 적나 (상민님 2026-08-18) ──
//   "일반 사람 입장에서 **중요한 변화·새로 만든 파일·중요한 결정**만. 쓸데없는 얘기는 하나도 없게.
//    모두 한 줄 안에 요약하고, 자세한 건 눌러서."
//   규칙 셋:
//    ① 사건이 아닌 것은 **아예 안 적는다** — 임시파일·스크린샷·조회 명령은 일한 자취가 아니다(거르기는 session-trail.ts).
//    ② 한 항목은 **한 줄**이다 — 넘치면 자른다. 원문은 툴팁에. 다만 줄끼리는 숨 쉴 만큼 떨어뜨린다.
//    ②' 필터는 두지 않는다 — 고를 필요가 없도록 애초에 남은 것만 싣는다(상민님 2026-08-18).
//    ③ 일은 **장(章)으로 접힌다** — 세션은 지시 하나가 한 장, 프로젝트는 작업 기록 하나가 한 장.
//       접힌 장에는 제목과 결과 배지(파일 4 · 커밋 1)만 보이고, 누르면 그 안이 펼쳐진다.
//
//  ── 위계 ──
//   손으로 매기지 않는다. tierOf(kind, verb) 규칙 하나가 정한다(상태 어휘 session-status.ts 와 같은 규약).
//    1 중요한 것(기본 보기) — 파일 씀·고침 · 지식 남김 · 커밋 · 작업 기록 · 태스크 끝냄 · 상태 바뀜
//    2 한 일 — 읽음 · 찾아봄 · 검사(빌드·테스트)
//    3 뒷일 — 지시·잔 편집·배관(머지·푸시·서버 반영)
import { el, personFace } from './core.js';

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
  // 개발자 요약은 "A — B · C · D" 처럼 겹쳐 쓰는 일이 잦다. 읽는 사람에게 필요한 건 첫 마디다.
  const cut = (re: RegExp) => { const i = t.search(re); if (i > 12) t = t.slice(0, i); };
  cut(/\s[—–]\s/);
  cut(/\s·\s/);
  cut(/\s*\(/);                          // 괄호 주석은 통째로 — 열린 채 잘리면 더 읽기 나쁘다
  t = t.replace(/[\s·,:=+-]+$/, '').trim();
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
  let dirty = false;

  const countEl = el('span', { class: 'v2-k' });
  const list = el('div', { class: 'tl-list' });
  const emptyEl = el('p', { class: 'v2-empty', text: ctx.empty || '아직 기록이 없어요.' });
  const noteEl = el('p', { class: 'v2-fine', hidden: true });
  const root = el('section', { class: 'tl-wrap' },
    el('div', { class: 'v2-aside-h' }, el('b', { text: '타임라인' }), el('span', { class: 'tl-scope', text: ctx.scope }), countEl),
    list, emptyEl, noteEl);
  host.append(root);

  const isHead = (it: TlItem): boolean => !!ctx.chapters && it.kind === 'say' && it.verb === '지시';

  // ── 한 항목 = 한 카드 ────────────────────────────────────────────────────
  //  상민님 2026-08-18: "얇은 한 줄에 배경도 없이 다닥다닥 붙어 있으니 징그럽다.
  //   중요한 내용이면 그만큼 공간을 차지하는 게 맞다 — 세로 공간을 너무 박하게 쓰지 마라."
  //  → 모든 항목을 같은 카드로 그린다: [무엇을 했나] 제목(두 줄까지) / 아랫줄에 결과·사람·시각.
  const faceOf = (a?: TlActor | null): HTMLElement | null =>
    (ctx.showActors && a && (a.id || a.name) ? personFace(String(a.id || ''), 'tl-face', String(a.name || a.id || '')) : null);

  function metaRow(it: TlItem, kids: TlItem[], canOpen: boolean, isOpen: boolean): HTMLElement {
    const face = faceOf(it.actor);
    const dur = kids.length ? span(it.ts, kids[kids.length - 1].ts) : '';
    return el('div', { class: 'tl-meta' },
      badges(kids, it.children),
      dur ? el('span', { class: 'tl-dur', text: dur }) : null,
      face, face && it.actor && it.actor.name ? el('span', { class: 'tl-who', text: String(it.actor.name) }) : null,
      el('span', { class: 'tl-tm', text: hhmm(it.ts) }),
      canOpen ? el('span', { class: 'tl-more', text: isOpen ? '접기' : '자세히' }) : null);
  }

  /** 카드 하나. kids 가 있으면 장(章)이 되어 눌러서 펼친다. */
  function card(it: TlItem, kids: TlItem[]): HTMLElement {
    const childRows = (it.children || []).length;
    const canOpen = kids.length > 0 || childRows > 0;
    const isOpen = open.has(it.id);
    const body = canOpen
      ? el('div', { class: 'tl-body', hidden: !isOpen },
        ...kids.slice().reverse().map(sub), ...(it.children || []).map(childLine))
      : null;
    const head = el('div', { class: 'tl-head' },
      el('span', { class: 'tl-verb', text: it.verb }),
      el('span', { class: 'tl-ttl', text: it.label || '(이름 없음)' }),
      it.count > 1 ? el('span', { class: 'tl-x', text: '×' + it.count }) : null);
    const box = el(it.href && !canOpen ? 'a' : 'div', {
      class: 'tl-card t' + tierOf(it) + ' tlk-' + it.kind + (canOpen ? ' can' : '') + (isOpen ? ' open' : '') + (it.href && !canOpen ? ' go' : '') + (it.error ? ' err' : ''),
      href: it.href && !canOpen ? it.href : null,
      title: [it.label, it.detail].filter(Boolean).join('\n'),
    }, head, metaRow(it, kids, canOpen, isOpen), body);
    if (canOpen) {
      box.setAttribute('role', 'button');
      box.setAttribute('tabindex', '0');
      box.setAttribute('aria-expanded', String(isOpen));
      const toggle = () => { if (isOpen) open.delete(it.id); else open.add(it.id); paint(); };
      box.addEventListener('click', (e: Event) => { if ((e.target as HTMLElement).closest('a')) return; toggle(); });
      box.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    }
    return box;
  }
  /** 펼친 카드 안의 한 줄(그 일에서 나온 것들) — 여기서는 촘촘해도 된다. 맥락이 이미 카드가 잡아 준다. */
  function sub(it: TlItem): HTMLElement {
    return el(it.href ? 'a' : 'div', { class: 'tl-sub' + (it.href ? ' go' : ''), href: it.href || null, title: it.label },
      el('span', { class: 'tl-sub-v tlk-' + it.kind, text: it.verb }),
      el('span', { class: 'tl-sub-t', text: it.label }),
      it.count > 1 ? el('span', { class: 'tl-x', text: '×' + it.count }) : null,
      el('span', { class: 'tl-tm', text: hhmm(it.ts) }));
  }
  function childLine(c: TlChild): HTMLElement {
    return el(c.href ? 'a' : 'div', { class: 'tl-sub' + (c.href ? ' go' : ''), href: c.href || null, title: c.label },
      el('span', { class: 'tl-sub-v', text: c.verb }), el('span', { class: 'tl-sub-t', text: c.label }));
  }

  // ── 결과 배지 ──
  function badges(kids: TlItem[], extra?: TlChild[]): HTMLElement | null {
    const c = new Map<string, number>();
    for (const k of kids) {
      const w = k.kind === 'file' ? '파일' : k.kind === 'knowledge' ? '지식' : k.kind === 'cmd' ? '커밋' : (KIND_LABEL.get(k.kind) || k.kind);
      c.set(w, (c.get(w) || 0) + k.count);
    }
    for (const e of extra || []) c.set(e.verb, (c.get(e.verb) || 0) + 1);
    if (!c.size) return null;
    const dotOf = (w: string) => (w === '파일' ? 'file' : w === '지식' ? 'knowledge' : w === '커밋' ? 'cmd' : w === '코드' ? 'activity' : 'task');
    return el('span', { class: 'tl-bdgs' }, ...[...c.entries()].slice(0, 3).map(([w, n]) =>
      el('span', { class: 'tl-bdg' }, el('span', { class: 'tl-dot tlk-' + dotOf(w), 'aria-hidden': 'true' }), w + ' ' + n)));
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
    // 장은 안에 남은 것이 있을 때만 세운다 — 아무것도 안 남은 지시는 타임라인의 사건이 아니다.
    const shownRows = rows.filter((r) => ('solo' in r ? true : r.kids.length > 0));
    const shownCount = rows.reduce((n, r) => n + ('solo' in r ? 1 : r.kids.length), 0);
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
      rail.append('solo' in r ? card(r.solo, []) : card(r.head, r.kids));
    }
    list.replaceChildren(...kids);
  }
  function schedule(): void {
    if (dirty) return;
    dirty = true;
    requestAnimationFrame(() => { dirty = false; paint(); });
  }

  // 같은 것은 **떨어져 있어도** 한 줄로 합친다 — 한 지식을 세 번 덧붙였다고 세 줄이 되면 그건 사건이 아니라 반복이다.
  //  합칠 때 맨 뒤로 옮겨, 지금 하는 일(마지막 장) 아래에 놓이게 한다.
  const byKey = new Map<string, TlItem>();
  function merge(it: TlItem, at: 'end' | 'start'): boolean {
    const prev = byKey.get(it.key);
    if (!prev || prev.error || it.error) return false;
    prev.count++;
    if (at === 'end') {
      if (it.ts) prev.ts = it.ts;
      const i = items.indexOf(prev);
      if (i >= 0 && i !== items.length - 1) { items.splice(i, 1); items.push(prev); }
    }
    byId.set(it.id, prev);
    return true;
  }

  const h: TimelineHandle = {
    root,
    add(raw, at = 'end') {
      const it: TlItem = { count: 1, ...raw, kind: (raw.kind as TlKind) || 'cmd' };
      if (!merge(it, at)) {
        if (at === 'end') items.push(it); else items.unshift(it);
        byId.set(it.id, it); byKey.set(it.key, it);
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
        items.push(it); byId.set(it.id, it); byKey.set(it.key, it);
      }
      items.sort((a, b) => tsNum(a.ts) - tsNum(b.ts));
      schedule();
    },
    setNote(note) { noteEl.textContent = note || ''; noteEl.hidden = !note; },
    clear() { items = []; byId.clear(); byKey.clear(); open.clear(); schedule(); },
  };
  paint();
  return h;
}

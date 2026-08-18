// timeline.ts — 우패널 공용 **타임라인**(#1719). 화면마다 대상만 바뀌고 생김새·어휘는 한 벌이다.
//   프로젝트 → 그 프로젝트에서 일어난 일 · AI 세션 → 그 세션이 한 일 · 홈/리브 → 워크스페이스에서 일어난 일.
//
//  ── 위계(상민님 2026-08-18: "중요한 건 강하게, 가독성 중요, 쓸데없는 건 필터로") ──
//   손으로 매기지 않는다. **사건의 종류(kind)와 동사(verb)로 규칙이 정한다** — 어휘를 한 곳에 두는 것이
//   상태 어휘(session-status.ts)와 같은 규약이다. 세 단:
//     1 남긴 것 — 세상에 남은 결과물(파일 씀·고침 · 지식 남김 · 커밋 · 작업 기록 · 태스크 만듦/끝냄 · 배포·PR)
//     2 한 일   — 결과로 가는 과정(읽음 · 찾아봄 · 불러옴 · 빌드 · 테스트 · 조회)
//     3 오간 말 — 지시와 답, 그리고 프로젝트의 잔 편집(설명·이름 고침)
//   기본 보기는 1+2. 3은 [전부]를 눌러야 나온다 — 안 그러면 결과가 잡담에 묻힌다(실측: 세션 사건 151건 중 남긴 것 8건).
//
//  ── 클릭 ──
//   상민님 결정: **자세히 보기는 가운데 화면에서** 연다. 그래서 이 패널의 행은 갈 곳(href)이 있을 때만 링크다.
//   갈 곳이 아직 없는 것(파일 본문·명령 출력)은 링크처럼 보이지 않는다 — 눌러도 안 되는 컨트롤을 두지 않는다.
import { el, personFace, relTime } from './core.js';

export type TlTier = 1 | 2 | 3;
export type TlKind = 'file' | 'cmd' | 'knowledge' | 'activity' | 'project' | 'task' | 'source' | 'say' | 'meta';

export interface TlActor { id?: string | null; name?: string | null; agent?: string | null }
export interface TlItem {
  id: string;
  kind: TlKind;
  verb: string;            // 읽음 · 씀 · 고침 · 남김 · 커밋 · 끝냄 · 찾아봄 …
  label: string;           // 대상(경로·지식 이름·요약)
  key: string;             // 접기 열쇠(같은 것 연속이면 ×N)
  ts?: string;
  tier?: TlTier;           // 안 주면 tierOf 가 정한다
  detail?: string;         // 둘째 줄(커밋·레포·상태 변화 등)
  actor?: TlActor | null;  // 공유 프로젝트에서 '누가' — 세션 소유자 한 명뿐이면 안 붙인다
  href?: string | null;    // 가운데 화면 목적지
  count: number;
  error?: boolean;
}

// ── 위계표 — (kind, verb) → 단. 여기 없는 동사는 kind 기본값을 따른다. ────────────
const KEEP_VERBS = new Set(['씀', '고침', '남김', '덧붙임', '만듦', '끝냄', '커밋', '배포', '올림', '기록', '바꿈']);
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
  { key: 'source', label: '자료' }, { key: 'say', label: '대화' }, { key: 'meta', label: '잔 변경' },
];
const KIND_LABEL = new Map<TlKind, string>(TL_KINDS.map((k) => [k.key, k.label]));

// 보기 단계 — 기본은 '일한 것'(1+2). 이름이 곧 뜻이다.
const VIEWS: Array<{ key: 'keep' | 'work' | 'all'; label: string; max: TlTier; hint: string }> = [
  { key: 'keep', label: '남긴 것', max: 1, hint: '결과물만 — 파일·지식·커밋·기록·태스크' },
  { key: 'work', label: '일한 것', max: 2, hint: '결과물 + 그 과정(읽음·찾아봄·빌드)' },
  { key: 'all', label: '전부', max: 3, hint: '지시·답변과 잔 변경까지 전부' },
];
const VIEW_KEY = 'lively_tl_view';

const hhmm = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
};
const dayOf = (iso?: string): string => (iso || '').slice(0, 10);
function dayLabel(key: string): string {
  if (!key) return '';
  const today = new Date(); const y = new Date(today.getTime() - 864e5);
  const t = today.toISOString().slice(0, 10), yk = y.toISOString().slice(0, 10);
  if (key === t) return '오늘';
  if (key === yk) return '어제';
  const d = new Date(key + 'T00:00:00');
  return Number.isFinite(d.getTime()) ? `${d.getMonth() + 1}월 ${d.getDate()}일` : key;
}
const tsNum = (iso?: string): number => { const n = Date.parse(iso || ''); return Number.isFinite(n) ? n : 0; };

export interface TimelineCtx {
  scope: string;                  // 패널 부제("프로젝트 #1719" · "이 세션" · "워크스페이스")
  showActors?: boolean;           // 공유 대상이면 항목마다 사람 얼굴
  empty?: string;                 // 빈 상태 문구
}
/** session-chat.ts 가 쓰는 발자취 싱크와 같은 모양 + 목록 통째 교체(setItems). */
export interface TimelineHandle {
  add(item: { id: string; kind: string; verb: string; label: string; key: string; ts?: string; detail?: string; actor?: TlActor | null; href?: string | null; tier?: TlTier }, at?: 'end' | 'start'): void;
  result(id: string, output: string, isError: boolean): void;
  /** 목록에 통째로 얹는다(id 가 같으면 갈아 끼움) — 트랜스크립트가 흘려 넣는 항목과 섞여도 안전하다. */
  addAll(items: Array<Omit<TlItem, 'count'> & { count?: number }>): void;
  setNote(note: string | null): void;
  clear(): void;
  root: HTMLElement;
}

export function createTimeline(host: HTMLElement, ctx: TimelineCtx): TimelineHandle {
  let items: TlItem[] = [];                    // 시간순(오래된 → 최신). 화면은 최신이 위.
  const byId = new Map<string, TlItem>();      // tool_use id → 항목(결과 이어 붙이기)
  let view: 'keep' | 'work' | 'all' = 'work';
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

  // ── 필터 ──
  function drawSeg(): void {
    const shownAll = items.filter((it) => !kindFilter || it.kind === kindFilter);
    const n = (max: TlTier) => shownAll.filter((it) => tierOf(it) <= max).length;
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

  // ── 행 ──
  function row(it: TlItem): HTMLElement {
    const tier = tierOf(it);
    const t = hhmm(it.ts);
    const face = ctx.showActors && it.actor && (it.actor.id || it.actor.name)
      ? personFace(String(it.actor.id || ''), 'tl-face', String(it.actor.name || it.actor.id || '')) : null;
    const tip = [it.label, it.detail, it.actor && it.actor.name ? String(it.actor.name) + (it.actor.agent ? ' · ' + it.actor.agent : '') : '', it.ts ? relTime(it.ts) : '']
      .filter(Boolean).join('\n');
    const cnt = it.count > 1 ? el('span', { class: 'tl-x', text: '×' + it.count }) : null;

    if (tier === 1) {
      const card = el('div', { class: 'tl-card' },
        el('div', { class: 'tl-c-top' }, el('span', { class: 'tl-verb', text: it.verb }), cnt,
          it.error ? el('span', { class: 'tl-err', text: '실패' }) : null,
          el('span', { class: 'tl-tm', text: t })),
        el('div', { class: 'tl-ttl', text: it.label || '(이름 없음)' }),
        (it.detail || face) ? el('div', { class: 'tl-sub' }, it.detail ? el('span', { text: it.detail }) : null,
          face, it.actor && it.actor.agent ? el('span', { class: 'tl-ai', text: String(it.actor.agent) }) : null) : null);
      return el(it.href ? 'a' : 'div', { class: 'tl-ev t1 tlk-' + it.kind + (it.href ? ' go' : ''), href: it.href || null, title: tip, 'data-kind': it.kind }, card);
    }
    if (tier === 2) {
      return el(it.href ? 'a' : 'div', { class: 'tl-ev t2 tlk-' + it.kind + (it.href ? ' go' : '') + (it.error ? ' err' : ''), href: it.href || null, title: tip, 'data-kind': it.kind },
        el('span', { class: 'tl-verb', text: it.verb }),
        el('span', { class: 'tl-ttl', text: it.label || '' }),
        cnt, face, el('span', { class: 'tl-tm', text: t }));
    }
    return el('div', { class: 'tl-ev t3 tlk-' + it.kind, title: tip, 'data-kind': it.kind },
      el('span', { class: 'tl-ttl', text: (it.verb ? it.verb + ' · ' : '') + (it.label || '') }), cnt, face);
  }

  // ── 그리기 — 항목이 몰려 들어와도(되그리기 수백 건) 한 프레임에 한 번만. ──
  function paint(): void {
    const max = (VIEWS.find((v) => v.key === view) || VIEWS[1]).max;
    const shown = items.filter((it) => tierOf(it) <= max && (!kindFilter || it.kind === kindFilter));
    countEl.textContent = String(shown.length);
    emptyEl.hidden = shown.length > 0;
    const kids: HTMLElement[] = [];
    let day = '\u0000';                                     // 첫 항목에서 반드시 날짜 머리를 세우도록 실제로 못 나오는 값
    let rail: HTMLElement = el('div', { class: 'tl-rail' });
    for (let i = shown.length - 1; i >= 0; i--) {          // 최신이 위
      const it = shown[i];
      const d = dayOf(it.ts);
      if (d !== day) {
        day = d;
        if (d) kids.push(el('div', { class: 'tl-day' }, el('span', { text: dayLabel(d) })));
        rail = el('div', { class: 'tl-rail' });
        kids.push(rail);
      }
      rail.append(row(it));
    }
    list.replaceChildren(...kids);
  }
  function schedule(): void {
    if (dirty) return;
    dirty = true;
    requestAnimationFrame(() => { dirty = false; drawSeg(); drawKinds(); paint(); });
  }

  // 같은 것 연속이면 ×N — 안 접으면 읽을 수 없는 벽이 된다(라이블리 로그에서 물려받은 규칙).
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
    clear() { items = []; byId.clear(); schedule(); },
  };
  drawSeg(); paint();
  return h;
}

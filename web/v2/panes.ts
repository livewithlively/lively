// v2/panes.ts — **프로젝트 화면 = 세션 화면**(#1719 원준 2026-08-20). 새 셸의 유일한 작업 화면이다.
//
//  ── 왜 이 모양인가 ──
//  앞선 캔버스(v2/studio.ts, 2026-08-20 폐기 — 지식 canvas-view-retired-1719)는 **빈 판에서 시작해 사람이 위젯을
//  올려야** 채워졌다. 그게 처음 보는 사람에게는 "프로젝트마다 설정할 게 너무 많고, 공간은 텅 비어 있다"로 읽혔다.
//  이 화면의 규칙은 정확히 그 반대다:
//   ① **들어오면 이미 채워져 있다** — 왼쪽은 세션, 오른쪽은 자료·지식. 아무것도 안 해도 일이 보인다.
//   ② **배치는 프로젝트마다가 아니라 한 벌뿐이다**(localStorage 전역) — 한 번 맞춰 두면 모든 프로젝트가 그 모양이다.
//      캔버스는 프로젝트마다 판을 따로 기억한다. 그 차이가 '설정할 게 많다'의 실체였다.
//   ③ 자유배치가 아니라 **도킹 분할**(VS Code·Cursor 문법) — 칸의 경계를 끌어 크기를 바꾸고, 탭을 끌어 칸을 옮긴다.
//      아무 데나 놓을 수 없다는 제약이 곧 '아무것도 안 해도 되는' 기본값을 가능하게 한다.
//
//  ── 구도 ──
//   문패(door) — 프로젝트 이름·요약, 오른쪽에 [칸] · [설정].
//   가운데 칸(main) — 기본 [세션]. 위는 **지금 보는 세션의 화면 그 자체**, 아래는 세션 서랍.
//   아래 칸(bottom) — 기본 닫힘. 열면 main 아래에 붙는다(타임라인·할 일 자리).
//   곁칸(side) — 기본 [자료][지식] 탭. 경계를 끌어 폭 조절, [칸]에서 접을 수 있다.
//
//  ── ★ 프로젝트 화면과 세션 화면은 하나다(원준 2026-08-20) ──
//  종전엔 `#/p/<id>`(프로젝트)와 `#/s/<sid>`(세션)가 서로 다른 화면이었다. 이제 **주소는 늘 세션**이고,
//  프로젝트는 그 세션이 놓인 방일 뿐이다 — `#/p/<id>` 로 들어오면 라우터가 그 프로젝트 맨 위 세션으로 보낸다.
//  서랍에서 세션을 갈아 끼울 때 이 셸은 다시 그리지 않는다(자료·지식·문패가 그대로 산다) — 주소만 바뀐다.
//
//  이 파일이 모르는 것: 각 칸에 들어가는 내용(v2/panes-parts.ts) · 프로젝트 설정 창(v2/proj-settings.ts).
import { anchoredPopover, api, el, personFace, toast } from '../core.js';
import { confirmDialog } from '../ui-primitives.js';
import { makeSplitter } from './split.js';
import { PART_DEFS, hiddenSessions, hideSession, lookupSessNames, makePart, partDef, pnIcon, sessTitle, type Part, type PartCtx, type PartType } from './panes-parts.js';
import { openProjSettings } from './proj-settings.js';
import { dotCls, type Sess, type V2Data } from './views.js';

export interface PanesOpts {
  data: () => V2Data;
  id: number;
  detail: any;
  onProjectChanged?: () => void;
  /** 라우트가 지정한 '지금 보는 세션'(#/s/<sid>). 없으면 새 세션 자리로 연다. */
  sessionId?: string | null;
  /** 서랍에서 세션을 갈아 끼웠다 — 셸을 다시 그리지 않고 주소만 그 세션 것으로. */
  onSessionPicked?: (sid: string | null) => void;
  /** 세션 화면(대화창·터미널·상단바) 통째를 붙이는 배선 — main.ts 가 준다. */
  mountSession?: (host: HTMLElement, sid: string) => { destroy(): void } | null;
}
export interface PanesHandle { destroy(): void }

// ── 배치 ────────────────────────────────────────────────────────────────────
type Zone = 'main' | 'side' | 'bottom';
interface Layout {
  main: PartType[]; side: PartType[]; bottom: PartType[];
  act: { main: PartType | null; side: PartType | null; bottom: PartType | null };
  sideOn: boolean; bottomOn: boolean;
}
const LAYOUT_KEY = 'lively_panes_layout_v1';
const DEF_LAYOUT = (): Layout => ({
  main: ['sessions'], side: ['files', 'knowledge'], bottom: ['timeline'],
  act: { main: 'sessions', side: 'files', bottom: 'timeline' },
  sideOn: true, bottomOn: false,
});
const ALL = new Set<string>(PART_DEFS.map((d) => d.type));
function loadLayout(): Layout {
  try {
    const s = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
    if (!s || typeof s !== 'object') return DEF_LAYOUT();
    const arr = (v: any): PartType[] => (Array.isArray(v) ? v.filter((x: any) => ALL.has(x)) : []);
    const d = DEF_LAYOUT();
    const lay: Layout = {
      main: arr(s.main), side: arr(s.side), bottom: arr(s.bottom),
      act: {
        main: ALL.has(s.act?.main) ? s.act.main : null,
        side: ALL.has(s.act?.side) ? s.act.side : null,
        bottom: ALL.has(s.act?.bottom) ? s.act.bottom : null,
      },
      sideOn: s.sideOn !== false, bottomOn: !!s.bottomOn,
    };
    // 저장된 배치가 모든 칸에서 비었으면(옛 판·손상) 기본으로 — 빈 화면을 보여 주는 것보다 낫다.
    if (!lay.main.length && !lay.side.length && !lay.bottom.length) return d;
    return lay;
  } catch (_) { return DEF_LAYOUT(); }
}

export function mountPanes(host: HTMLElement, opts: PanesOpts): PanesHandle {
  const id = opts.id;
  const loose = id === 0;                       // 프로젝트 없는 세션들의 화면 — 공유 폴더·지식·할 일이 없다
  let detail: any = opts.detail;
  let dead = false;
  let lay = loadLayout();
  // 프로젝트 없는 세션 화면 — 공유 폴더·지식·할 일이 없으니 곁칸에 넣을 것도 없다. 빈 칸을 보여 주느니 접어 둔다.
  if (loose) { lay = { ...lay, side: lay.side.filter((t) => t === 'timeline'), bottom: [], bottomOn: false, sideOn: false }; }

  function saveLayout(): void {
    if (loose) return;                          // 자투리 화면의 임시 배치를 정본으로 굳히지 않는다
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(lay)); } catch (_) { /* noop */ }
  }

  const pj = (): any => (loose ? { id: 0, name: '프로젝트 없는 세션' } : (detail && detail.project) || { id, name: '프로젝트 #' + id });

  const ctx: PartCtx = {
    id,
    data: opts.data,
    detail: () => detail,
    dead: () => dead,
    onChanged: () => { void refreshDetail(); opts.onProjectChanged?.(); },
    openSettings: () => openSettings(),
    sessionId: opts.sessionId || null,
    onSessionPicked: (sid) => { opts.onSessionPicked?.(sid); paintDoor(); },
    mountSession: opts.mountSession,
  };

  // ── 골격 ──
  const door = el('header', { class: 'pn-door' });
  const colMain = el('div', { class: 'pn-col' });
  const body = el('div', { class: 'pn-body' });
  const wrap = el('div', { class: 'pn-wrap' }, door, body) as HTMLElement;
  host.replaceChildren(wrap);

  // 칸 하나 = 탭 줄 + 본문. 부품은 탭을 옮겨도 **살아 있는 채로** 따라간다(대화·스크롤 보존).
  interface Pane { zone: Zone; root: HTMLElement; tabs: HTMLElement; bodyEl: HTMLElement; parts: Map<PartType, Part> }
  const panes = new Map<Zone, Pane>();

  function makePane(zone: Zone): Pane {
    const tabs = el('div', { class: 'pn-tabs', role: 'tablist' });
    const bodyEl = el('div', { class: 'pn-pane-body' });
    const root = el('section', { class: 'pn-pane', 'data-zone': zone }, tabs, bodyEl);
    const p: Pane = { zone, root, tabs, bodyEl, parts: new Map() };
    // 탭을 끌어 이 칸에 떨구면 그 부품이 여기로 옮겨 온다(VS Code 의 탭 도킹).
    tabs.addEventListener('dragover', (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('text/x-pn-part')) return;
      e.preventDefault(); tabs.classList.add('drop');
    });
    tabs.addEventListener('dragleave', () => tabs.classList.remove('drop'));
    tabs.addEventListener('drop', (e: DragEvent) => {
      tabs.classList.remove('drop');
      const raw = e.dataTransfer?.getData('text/x-pn-part') || '';
      if (!raw) return;
      e.preventDefault();
      let msg: { type: PartType; from: Zone };
      try { msg = JSON.parse(raw); } catch (_) { return; }
      moveTab(msg.type, msg.from, zone);
    });
    panes.set(zone, p);
    return p;
  }

  const mainPane = makePane('main');
  const bottomPane = makePane('bottom');
  const sidePane = makePane('side');

  // 세로 경계(가운데|곁칸) · 가로 경계(가운데|아래 칸) — 폭·높이는 split.ts 가 기억한다.
  const splitX = makeSplitter({ axis: 'x', key: 'panes_side', cssVar: '--pn-side-w', target: body, def: 340, min: 220, max: 620, grow: -1, label: '곁칸 너비' });
  const splitY = makeSplitter({ axis: 'y', key: 'panes_bottom', cssVar: '--pn-bottom-h', target: colMain, def: 240, min: 120, max: 560, grow: -1, label: '아래 칸 높이' });
  colMain.append(mainPane.root, splitY, bottomPane.root);
  body.append(colMain, splitX, sidePane.root);

  // ── 탭 ──
  function ensurePart(pane: Pane, type: PartType): Part {
    let p = pane.parts.get(type);
    if (!p) { p = makePart(type, ctx); pane.parts.set(type, p); pane.bodyEl.append(p.root); }
    return p;
  }
  function activate(zone: Zone, type: PartType | null): void {
    lay.act[zone] = type;
    saveLayout();
    paintPane(zone);
  }
  function addTab(zone: Zone, type: PartType): void {
    const list = lay[zone];
    if (!list.includes(type)) list.push(type);
    lay.act[zone] = type;
    if (zone === 'side') lay.sideOn = true;
    if (zone === 'bottom') lay.bottomOn = true;
    saveLayout(); paintAll();
  }
  function removeTab(zone: Zone, type: PartType): void {
    const list = lay[zone];
    const i = list.indexOf(type);
    if (i < 0) return;
    list.splice(i, 1);
    const pane = panes.get(zone)!;
    const part = pane.parts.get(type);
    if (part) { part.destroy?.(); part.root.remove(); pane.parts.delete(type); }
    if (lay.act[zone] === type) lay.act[zone] = list[Math.max(0, i - 1)] || null;
    saveLayout(); paintAll();
  }
  function moveTab(type: PartType, from: Zone, to: Zone): void {
    if (from === to) { activate(to, type); return; }
    removeTab(from, type);
    addTab(to, type);
  }

  function tabEl(zone: Zone, type: PartType, on: boolean): HTMLElement {
    const d = partDef(type);
    const b = el('button', {
      class: 'pn-tab' + (on ? ' on' : ''), type: 'button', role: 'tab',
      'aria-selected': String(on), title: d.hint, draggable: 'true',
      onclick: () => activate(zone, type),
    }, pnIcon(d.icon, 'pn-i sm'), el('span', { text: d.name })) as HTMLElement;
    b.addEventListener('dragstart', (e: DragEvent) => {
      e.dataTransfer?.setData('text/x-pn-part', JSON.stringify({ type, from: zone }));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      b.classList.add('drag');
    });
    b.addEventListener('dragend', () => b.classList.remove('drag'));
    const x = el('button', {
      class: 'pn-tab-x', type: 'button', title: `${d.name} 칸에서 뺍니다`, 'aria-label': `${d.name} 빼기`,
      onclick: (e: MouseEvent) => { e.stopPropagation(); removeTab(zone, type); },
    }, pnIcon('x', 'pn-i xs'));
    return el('span', { class: 'pn-tabwrap' + (on ? ' on' : '') }, b, x);
  }

  function addBtn(zone: Zone): HTMLElement {
    const b = el('button', { class: 'pn-tab-add', type: 'button', title: '이 칸에 내용을 더합니다', 'aria-label': '내용 더하기' }, pnIcon('plus', 'pn-i sm')) as HTMLElement;
    b.onclick = () => {
      const rest = PART_DEFS.filter((d) => !lay[zone].includes(d.type) && !(loose && (d.type === 'files' || d.type === 'knowledge' || d.type === 'tasks' || d.type === 'overview' || d.type === 'liv')));
      const close = anchoredPopover(b, el('div', { class: 'pn-pop' },
        el('p', { class: 'pn-pop-h', text: '이 칸에 넣을 것을 고르세요.' }),
        rest.length ? el('div', { class: 'pn-pop-list' }, ...rest.map((d) =>
          el('button', { class: 'pn-pop-row', type: 'button', onclick: () => { close(); addTab(zone, d.type); } },
            pnIcon(d.icon, 'pn-i sm'),
            el('span', { class: 'n' }, el('b', { text: d.name }), el('span', { class: 'pn-fine', text: d.hint })))))
          : el('p', { class: 'pn-fine', text: '넣을 수 있는 것을 이미 다 넣었어요.' })));
    };
    return b;
  }

  /** 이 프로젝트의 세션 — 탭 줄에 눕히는 순서(답 기다림 → 도는 중 → 최근). */
  const mySessions = (): Sess[] => {
    const rank = (s: Sess): number => (s.stateKey === 'waiting' ? 0 : s.stateKey === 'busy' ? 1 : s.live && s.alive ? 2 : 3);
    return opts.data().sessions
      .filter((s) => (loose ? !s.projectId : Number(s.projectId) === id))
      .sort((a, b) => rank(a) - rank(b) || (b.lastSeen || 0) - (a.lastSeen || 0));
  };
  const SESS_TAB_MAX = 40;   // 탭 줄에 눕히는 상한 — 프로젝트 없는 세션 화면엔 수백 개가 몰린다(실측 188개)

  /** 세션 탭 하나 — 상태점 + 이름 + ×(보관).
   *  ⚠ ×는 '화면 닫기'가 아니라 **세션 보관**이다(원준 2026-08-20): 돌던 터미널을 내리고 대화·설정은 남겨
   *   [보관한 세션]에서 되살릴 수 있게 한다. 돌고 있는 AI 를 멈추는 동작이라 확인창을 반드시 거친다.
   *   내 세션이고 살아 있을 때만 보인다 — 남의 세션은 못 내리고, 이미 끝난 세션은 보관할 것이 없다. */
  function sessTab(s: Sess, on: boolean, part: Part): HTMLElement {
    const t = sessTitle(s, String(pj().name || ''));
    const b = el('button', {
      class: 'pn-tab pn-stab' + (on ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': String(on),
      title: t + ' — ' + s.stateLabel, onclick: () => { part.selectSession?.(s.id); paintPane('main'); },
    }, el('span', { class: 'v2-dot ' + dotCls(s.stateKey), 'aria-hidden': 'true' }), el('span', { class: 'ell', text: t }));
    // ×는 **모든 세션 탭**에 있다(원준 2026-08-20 "탭을 닫을 수가 없음"). 하는 일이 상태에 따라 갈릴 뿐이다:
    //  · 살아 있는 내 세션 → 확인창 뒤 **보관**(터미널을 내리고 대화·설정은 남긴다) + 탭에서 치움.
    //  · 그 밖(끝난 세션·남의 세션) → 내릴 터미널이 없으니 **탭에서만 치운다**. 둘 다 [보관한 세션]에 남는다.
    const canArchive = s.owned && s.live && s.alive;
    const x = el('button', {
      class: 'pn-tab-x', type: 'button',
      title: canArchive ? '이 세션을 보관합니다 — 대화는 남고, [보관한 세션]에서 되살릴 수 있어요.'
        : '탭에서 치웁니다 — 세션은 [보관한 세션]에 그대로 있어요.',
      'aria-label': canArchive ? `「${t}」 세션 보관` : `「${t}」 탭 치우기`,
      onclick: (e: MouseEvent) => { e.stopPropagation(); void closeSessTab(s, t, part); },
    }, pnIcon('x', 'pn-i xs'));
    return el('span', { class: 'pn-tabwrap' + (on ? ' on' : '') }, b, x);
  }

  /** 탭 × — 살아 있는 내 세션이면 보관까지, 아니면 보기에서만 치운다. 치운 뒤 보던 탭이면 옆 탭으로 옮겨 준다. */
  async function closeSessTab(s: Sess, name: string, part: Part): Promise<void> {
    if (s.owned && s.live && s.alive) { if (!await archiveSess(s, name)) return; }
    hideSession(s.id);
    if (part.currentSession?.() === s.id) {
      const next = mySessions().find((x) => x.id !== s.id && !hiddenSessions().has(x.id));
      part.selectSession?.(next ? next.id : null);
    }
    if (!(s.owned && s.live && s.alive)) toast('탭에서 치웠어요 — [보관한 세션]에 그대로 있어요.');
    paintPane('main');
  }

  /** 세션 보관 — 터미널만 내리고 좌표·대화는 DB 에 남긴다(DELETE ?reclaim=1 = restorable). 성공하면 true. */
  async function archiveSess(s: Sess, name: string): Promise<boolean> {
    const working = s.stateKey === 'busy' || s.stateKey === 'waiting';
    const ok = await confirmDialog({
      title: `「${name}」 세션을 보관할까요?`,
      message: working ? '지금 일하는 중이라, 보관하면 그 자리에서 멈춥니다.' : '돌고 있는 터미널을 내려놓습니다.',
      lines: ['대화와 설정은 그대로 남습니다 — [보관한 세션]에서 언제든 되살릴 수 있어요.'],
      confirmText: '보관', danger: working,
    });
    if (!ok) return false;
    try {
      await api('/api/ui/terminal/sessions/' + encodeURIComponent(s.id) + '?reclaim=1' + (s.node ? '&node=' + encodeURIComponent(s.node) : ''), { method: 'DELETE' });
      toast('세션을 보관했어요 — [보관한 세션]에서 되살릴 수 있어요.');
      opts.onProjectChanged?.();
      return true;
    } catch (e: any) {
      toast('보관하지 못했어요 — ' + (e && e.message ? e.message : e), true);
      return false;
    }
  }

  /** 가운데 칸의 탭 줄에 세션 탭들을 그린다(원준 2026-08-20 — 하단 서랍을 이 줄로 옮겼다). */
  function sessTabs(pane: Pane, act: PartType | null): HTMLElement[] {
    const part = pane.parts.get('sessions');
    if (!part || !part.selectSession) return [];
    const cur = part.currentSession?.() ?? null;
    const hid = hiddenSessions();
    // 치운 탭은 줄에서 빠진다 — 단 **지금 보고 있는 세션은 예외**(보는 화면의 탭이 없으면 어디 있는지 알 수 없다).
    const ss = mySessions().filter((s) => !hid.has(s.id) || s.id === cur);
    const shown = ss.slice(0, SESS_TAB_MAX);
    // 지금 보는 세션이 상한 밖이면 그 탭만은 끼워 넣는다 — 켜진 것이 안 보이면 어디 있는지 알 수 없다.
    const out = ss.find((s) => s.id === cur && !shown.some((x) => x.id === s.id));
    const on = act === 'sessions';
    void lookupSessNames(shown.slice(0, 12), String(pj().name || ''), () => { if (!dead) paintPane('main'); });
    return [
      el('span', { class: 'pn-tabwrap' + (on && cur == null ? ' on' : '') },
        el('button', {
          class: 'pn-tab pn-stab new' + (on && cur == null ? ' on' : ''), type: 'button',
          title: '새 세션을 엽니다', onclick: () => { activate('main', 'sessions'); part.selectSession?.(null); paintPane('main'); },
        }, pnIcon('plus', 'pn-i sm'), el('span', { text: '새 세션' }))),
      ...(out ? [sessTab(out, on, part)] : []),
      ...shown.map((s) => sessTab(s, on && s.id === cur, part)),
    ];
  }

  function paintPane(zone: Zone): void {
    const pane = panes.get(zone)!;
    const list = lay[zone];
    let act = lay.act[zone];
    if (act && !list.includes(act)) act = null;
    if (!act && list.length) act = list[0];
    lay.act[zone] = act;

    const hideBtn = zone === 'side'
      ? el('button', { class: 'pn-pane-hide', type: 'button', title: '곁칸을 접습니다', 'aria-label': '곁칸 접기', onclick: () => { lay.sideOn = false; saveLayout(); paintAll(); } }, pnIcon('chev', 'pn-i sm'))
      : zone === 'bottom'
        ? el('button', { class: 'pn-pane-hide', type: 'button', title: '아래 칸을 닫습니다', 'aria-label': '아래 칸 닫기', onclick: () => { lay.bottomOn = false; saveLayout(); paintAll(); } }, pnIcon('x', 'pn-i sm'))
        : null;
    // 'sessions' 는 탭 하나가 아니라 **세션마다 탭 하나**로 펼친다(그 부품이 살아 있어야 하므로 먼저 만든다).
    const tabsOf = (t: PartType): HTMLElement[] => {
      if (t !== 'sessions') return [tabEl(zone, t, t === act)];
      ensurePart(pane, 'sessions');
      return sessTabs(pane, act);
    };
    // ⚠ replaceChildren 은 el() 과 달리 null 을 걸러 주지 않는다 — 넣으면 'null' 이 글자로 찍힌다.
    pane.tabs.replaceChildren(...[...list.flatMap(tabsOf), addBtn(zone), hideBtn].filter(Boolean) as HTMLElement[]);

    // 켜진 부품만 보이게(나머지는 살려 둔 채 숨긴다 — 탭을 오가도 대화·스크롤이 그대로다).
    if (act) ensurePart(pane, act);
    for (const [t, p] of pane.parts) p.root.hidden = t !== act;
    pane.bodyEl.classList.toggle('empty', !act);
    if (!act) {
      let ph = pane.bodyEl.querySelector('.pn-pane-empty') as HTMLElement | null;
      if (!ph) {
        ph = el('div', { class: 'pn-pane-empty' },
          el('p', { class: 'pn-fine', text: '이 칸이 비어 있어요 — 위의 ＋ 로 넣을 것을 고르세요.' })) as HTMLElement;
        pane.bodyEl.append(ph);
      }
      ph.hidden = false;
    } else {
      const ph = pane.bodyEl.querySelector('.pn-pane-empty') as HTMLElement | null;
      if (ph) ph.hidden = true;
    }
  }

  function paintAll(): void {
    body.classList.toggle('no-side', !lay.sideOn);
    colMain.classList.toggle('no-bottom', !lay.bottomOn);
    sidePane.root.hidden = !lay.sideOn;
    splitX.hidden = !lay.sideOn;
    bottomPane.root.hidden = !lay.bottomOn;
    splitY.hidden = !lay.bottomOn;
    paintPane('main'); paintPane('side'); paintPane('bottom');
    paintDoor();
  }

  // ── 문패 ──
  function paintDoor(): void {
    const p = pj();
    const tasks: any[] = Array.isArray(p.tasks) ? p.tasks : [];
    const doneN = tasks.filter((t) => t.status_category === 'done').length;
    const kn = p.knowledge || {};
    const knN = (kn.required || []).length + (kn.produced || []).length;
    const ss = opts.data().sessions.filter((s) => (loose ? !s.projectId : Number(s.projectId) === id));
    const live = ss.filter((s) => s.live && s.alive);
    const members: any[] = Array.isArray(p.members) ? p.members : [];
    const st = p.status_category === 'done' ? { t: '끝남', c: 'done' } : p.status_category === 'unstarted' ? { t: '시작 전', c: 'todo' } : { t: '진행 중', c: 'run' };
    door.replaceChildren(
      el('div', { class: 'pn-door-l' },
        el('div', { class: 'pn-eyebrow' },
          loose ? el('span', { text: '아직 어느 프로젝트에도 붙지 않았어요.' }) : el('span', { class: 'mono', text: '#' + p.id }),
          loose ? null : el('span', { class: 'sep', text: '·' }),
          loose ? null : el('span', { class: 'pn-state ' + st.c, text: st.t }),
          el('span', { class: 'sep', text: '·' }),
          el('span', { text: `세션 ${ss.length}` + (live.length ? ` · 지금 ${live.length}` : '') }),
          loose ? null : el('span', { class: 'sep', text: '·' }),
          loose ? null : el('span', { text: `할 일 ${tasks.length - doneN}/${tasks.length}` }),
          loose ? null : el('span', { class: 'sep', text: '·' }),
          loose ? null : el('span', { text: `지식 ${knN}` })),
        el('h1', { class: 'pn-title', text: p.name || '프로젝트 #' + id })),
      el('div', { class: 'pn-door-r' },
        el('span', { class: 'pn-faces' }, ...members.slice(0, 5).map((m: any) => personFace(String(m.member_id || m), 'pn-face', String(m.display_name || m.member_id || '')))),
        zonesBtn(),
        loose ? null : el('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: '이름·상태·본문·할 일을 고칩니다', onclick: () => openSettings() }, pnIcon('gear', 'pn-i sm'), el('span', { text: '설정' }))));
  }

  /** [칸] — 어떤 칸을 보일지, 배치를 되돌릴지. VS Code 의 보기 메뉴 자리다. */
  function zonesBtn(): HTMLElement {
    const b = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: '어떤 칸을 볼지 정합니다' }, pnIcon('cols', 'pn-i sm'), el('span', { text: '칸' })) as HTMLElement;
    b.onclick = () => {
      const row = (label: string, on: boolean, hint: string, onPick: () => void): HTMLElement =>
        el('button', { class: 'pn-pop-row' + (on ? ' on' : ''), type: 'button', onclick: () => { close(); onPick(); } },
          el('span', { class: 'pn-check' + (on ? ' on' : ''), 'aria-hidden': 'true' }),
          el('span', { class: 'n' }, el('b', { text: label }), el('span', { class: 'pn-fine', text: hint })));
      const close = anchoredPopover(b, el('div', { class: 'pn-pop' },
        el('div', { class: 'pn-pop-list' },
          row('곁칸', lay.sideOn, '오른쪽에 자료·지식을 두는 칸입니다.', () => { lay.sideOn = !lay.sideOn; saveLayout(); paintAll(); }),
          loose ? null : row('아래 칸', lay.bottomOn, '가운데 아래에 타임라인·할 일을 두는 칸입니다.', () => { lay.bottomOn = !lay.bottomOn; saveLayout(); paintAll(); })),
        el('div', { class: 'pn-pop-foot' },
          el('button', { class: 'btn-text', type: 'button', text: '기본 배치로 되돌리기', onclick: () => { close(); resetLayout(); } }))));
    };
    return b;
  }

  function resetLayout(): void {
    for (const pane of panes.values()) {
      for (const p of pane.parts.values()) { p.destroy?.(); p.root.remove(); }
      pane.parts.clear();
    }
    lay = DEF_LAYOUT();
    saveLayout(); paintAll();
    toast('기본 배치로 되돌렸어요.');
  }

  function openSettings(): void {
    if (loose) return;
    openProjSettings({ id, detail, onChanged: () => { void refreshDetail(); opts.onProjectChanged?.(); } });
  }

  async function refreshDetail(): Promise<void> {
    if (loose) { paintDoor(); return; }
    try {
      const d = await api('/api/ui/v6/projects/' + id);
      if (dead || !d) return;
      detail = d;
      paintDoor();
      for (const pane of panes.values()) for (const [t, p] of pane.parts) { if (!p.root.hidden && t !== 'sessions') p.tick?.(); }
    } catch (_) { /* 다음 틱에 다시 시도한다 */ }
  }

  // ── 라이브 틱 — 보이는 부품만 제자리 갱신(서명이 같으면 DOM 을 안 건드린다) ──
  const timer = window.setInterval(() => {
    if (dead) return;
    for (const pane of panes.values()) {
      const act = lay.act[pane.zone];
      if (!act) continue;
      const p = pane.parts.get(act);
      if (p && !p.root.hidden) p.tick?.();
    }
    paintDoor();
  }, 8000);

  paintAll();
  if (!loose && !detail) void refreshDetail();

  // [보관한 세션]에서 [탭에 꺼내기]를 누르면 이 줄을 그 자리에서 다시 그린다(8초 틱을 기다리지 않게).
  const onViewChanged = (): void => { if (!dead) paintPane('main'); };
  window.addEventListener('pn:sessions-view', onViewChanged);

  return {
    destroy(): void {
      dead = true;
      window.removeEventListener('pn:sessions-view', onViewChanged);
      window.clearInterval(timer);
      for (const pane of panes.values()) for (const p of pane.parts.values()) p.destroy?.();
      panes.clear();
    },
  };
}

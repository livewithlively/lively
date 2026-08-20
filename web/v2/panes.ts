// v2/panes.ts — 프로젝트 화면의 **기본 뷰**(#1719 원준 2026-08-20). 캔버스(studio.ts)와 토글로 오간다.
//
//  ── 왜 또 하나인가 ──
//  캔버스는 **빈 판에서 시작해 사람이 위젯을 올려야** 채워진다. 그게 처음 보는 사람에게는 "프로젝트마다 설정할 게 너무
//  많고, 공간은 텅 비어 있다"로 읽혔다(원준 2026-08-20). 그래서 기본 뷰의 규칙은 정확히 그 반대다:
//   ① **들어오면 이미 채워져 있다** — 왼쪽은 세션, 오른쪽은 자료·지식. 아무것도 안 해도 일이 보인다.
//   ② **배치는 프로젝트마다가 아니라 한 벌뿐이다**(localStorage 전역) — 한 번 맞춰 두면 모든 프로젝트가 그 모양이다.
//      캔버스는 프로젝트마다 판을 따로 기억한다. 그 차이가 '설정할 게 많다'의 실체였다.
//   ③ 자유배치가 아니라 **도킹 분할**(VS Code·Cursor 문법) — 칸의 경계를 끌어 크기를 바꾸고, 탭을 끌어 칸을 옮긴다.
//      아무 데나 놓을 수 없다는 제약이 곧 '아무것도 안 해도 되는' 기본값을 가능하게 한다.
//
//  ── 구도 ──
//   문패(door) — 이름·요약, 오른쪽에 [기본|캔버스] · [칸] · [설정].
//   가운데 칸(main) — 기본 [세션]. 세로로 넓게 쓴다.
//   아래 칸(bottom) — 기본 닫힘. 열면 main 아래에 붙는다(타임라인·할 일 자리).
//   곁칸(side) — 기본 [자료][지식] 탭. 경계를 끌어 폭 조절, [칸]에서 접을 수 있다.
//
//  이 파일이 모르는 것: 각 칸에 들어가는 내용(v2/panes-parts.ts) · 프로젝트 설정 창(v2/proj-settings.ts).
import { anchoredPopover, api, el, personFace, toast } from '../core.js';
import { makeSplitter } from './split.js';
import { PART_DEFS, makePart, partDef, pnIcon, type Part, type PartCtx, type PartType } from './panes-parts.js';
import { openProjSettings } from './proj-settings.js';
import { type V2Data } from './views.js';

export interface PanesOpts {
  data: () => V2Data;
  id: number;
  detail: any;
  onProjectChanged?: () => void;
  /** 뷰를 갈아탄다 — main.ts 가 그 탭을 다시 마운트한다. */
  onSwitchView?: (mode: ProjMode) => void;
}
export interface PanesHandle { destroy(): void }

// ── 뷰 모드 — 프로젝트 화면을 무엇으로 볼 것인가(전역 하나. 프로젝트마다 다르면 그게 또 '설정'이 된다) ──
export type ProjMode = 'panes' | 'canvas';
const MODE_KEY = 'lively_proj_view_mode';
export function projMode(): ProjMode {
  try { return localStorage.getItem(MODE_KEY) === 'canvas' ? 'canvas' : 'panes'; } catch (_) { return 'panes'; }
}
export function setProjMode(m: ProjMode): void {
  try { localStorage.setItem(MODE_KEY, m); } catch (_) { /* 저장 못 해도 이번 화면은 된다 */ }
}
/** [기본|캔버스] 세그먼트 — 두 뷰가 **같은 자리에 같은 모양으로** 두는 단추(캔버스 문패도 이걸 쓴다). */
export function viewToggle(cur: ProjMode, onPick: (m: ProjMode) => void): HTMLElement {
  const mk = (m: ProjMode, label: string, title: string): HTMLElement =>
    el('button', {
      class: 'pn-vt-b' + (cur === m ? ' on' : ''), type: 'button', title,
      'aria-pressed': String(cur === m),
      onclick: () => { if (cur !== m) onPick(m); },
    }, el('span', { text: label }));
  return el('div', { class: 'pn-vt', role: 'group', 'aria-label': '화면 보기 방식' },
    mk('panes', '기본', '칸으로 나뉜 기본 화면입니다.'),
    mk('canvas', '캔버스', '위젯을 자유롭게 놓는 작업대입니다.'));
}

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
  if (loose) { lay = { ...lay, side: lay.side.filter((t) => t === 'timeline'), bottom: [], bottomOn: false }; }

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
    // ⚠ replaceChildren 은 el() 과 달리 null 을 걸러 주지 않는다 — 넣으면 'null' 이 글자로 찍힌다.
    pane.tabs.replaceChildren(...[...list.map((t) => tabEl(zone, t, t === act)), addBtn(zone), hideBtn].filter(Boolean) as HTMLElement[]);

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
        viewToggle('panes', (m) => { if (m !== 'panes') { setProjMode(m); opts.onSwitchView?.(m); } }),
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

  return {
    destroy(): void {
      dead = true;
      window.clearInterval(timer);
      for (const pane of panes.values()) for (const p of pane.parts.values()) p.destroy?.();
      panes.clear();
    },
  };
}

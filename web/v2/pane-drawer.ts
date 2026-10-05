// ════════════════════════════════════════════════════════════════════════════
// 곁칸 탭 줄 [＋] — «앱 서랍» (#4443, 원준 2026-10-05: «① 앱 서랍 + ② 의 키보드 — 니 말대로 해보자»)
// ════════════════════════════════════════════════════════════════════════════
//  독 ⊞(모든 앱) 패널과 **같은 판 · 같은 머리 · 같은 타일**이다(.pn-dock-more-h/-q/-sh/-grid · .pn-dock-tile* — 42-v2-dock.css).
//  종전 고르기(옛 대시보드 팝오버 · 단색 아이콘 · 열 줄 모두 설명 두 줄)는 한 화면에 안 들어가 스크롤했고 독 · 탭과 딴 물건 같았다.
//  ⊞ 와 다른 것은 셋 —
//   ① 이 칸에 넣을 수 있는 것만 — 모두 사이드바에 선다(«새 탭으로 여는 앱» 은 없다, 원준 10-05 «그게 왜 필요하겠어»).
//   ② 설명은 고른 앱 하나 — 마우스를 올리거나 키보드로 고른 타일의 설명이 발치 위 한 줄에(아무것도 안 골랐으면 Enter 의 과녁 = 첫 타일).
//   ③ 키보드 먼저 — 열리면 검색칸에 초점, 치면 거르고 Enter 로 연다. ↓ 로 타일에 들어가 화살표로 옮긴다(⊞ 와 같은 손).
//  이미 열린 앱(여러 개 띄울 수 있는 것)은 타일 모서리 ＋ 배지 = 하나 더 · 아래 회색 점 = 지금 열려 있음(⊞ 의 점 문법).
//  떠 있는 자리 · 바깥 누름 · Esc 닫기는 anchoredPopover(lib/overlay)가 한다 — 판의 모양만 여기서.
import { anchoredPopover, el } from '../core.js';
import { appMatches, appRank } from '../lib/app-match.js';
import { pnIcon } from './panes-kit.js';
import { dockTile } from './pane-dock.js';

export interface DrawerItem {
  type: string; name: string; hint: string;
  /** 부품의 아이콘 이름 — 독 타일과 같은 그림(dockTile). */
  glyph: string;
  /** 이미 이 칸에 열려 있다 — 고르면 «하나 더». */
  more: boolean;
}
/** 발치 단추 — icon 은 제품 아이콘 표의 이름(icon-table G5), flip 은 위아래 뒤집기(«아래 칸» = 위 막대 창을 뒤집은 것). */
export interface DrawerFoot { label: string; title: string; icon: string; flip?: boolean; run: () => void }
export interface DrawerOpts {
  title: string; note: string; placeholder: string;
  items: DrawerItem[];
  onPick: (type: string) => void;
  foot: DrawerFoot[];
}

/** 하나 더 띄울 때의 설명 — 종전 고르기의 문구 그대로. */
export const MORE_HINT = '같은 것을 하나 더 띄워 나란히 봅니다.';

/** [＋] 아래에 앱 서랍을 연다. 돌려주는 것은 닫기. */
export function openAppDrawer(anchor: HTMLElement, o: DrawerOpts): () => void {
  const input = el('input', { class: 'pn-dock-more-q', type: 'search', placeholder: o.placeholder, 'aria-label': o.placeholder,
    spellcheck: 'false', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pn-adraw-grid' }) as HTMLInputElement;
  const grid = el('div', { class: 'pn-dock-more-grid', id: 'pn-adraw-grid', role: 'listbox', 'aria-label': o.title }) as HTMLElement;
  const descN = el('b') as HTMLElement, descT = el('span') as HTMLElement;
  const desc = el('p', { class: 'pn-adraw-desc', 'aria-live': 'polite' }, descN, descT) as HTMLElement;
  let closed = false;
  let close0: () => void = () => {};
  const close = (): void => { if (closed) return; closed = true; close0(); };
  const foot = o.foot.length ? el('div', { class: 'pn-dock-more-f pn-adraw-f' }, ...o.foot.map((f) =>
    el('button', { class: 'btn-text', type: 'button', title: f.title, onclick: () => { close(); f.run(); } },
      pnIcon(f.icon, 'pn-i sm' + (f.flip ? ' pn-adraw-flip' : '')), el('span', { text: f.label })))) : null;
  const panel = el('div', { class: 'pn-adraw', role: 'dialog', 'aria-label': o.title },
    el('div', { class: 'pn-dock-more-h' }, pnIcon('search', 'pn-i sm'), input),
    el('div', { class: 'pn-adraw-b' }, el('div', { class: 'pn-dock-more-sh' }, el('b', { text: o.title }), el('span', { class: 'pn-fine', text: o.note })), grid),
    desc, foot) as HTMLElement;

  let shown: DrawerItem[] = [];
  let tiles: HTMLElement[] = [];
  let hot = -1;   // 마우스 · 초점이 가리키는 타일. 없으면(-1) 첫 타일 — 검색칸에서 Enter 하면 열리는 것
  const target = (): number => (shown.length ? (hot >= 0 ? hot : 0) : -1);
  const say = (): void => {
    const i = target();
    tiles.forEach((t, k) => t.setAttribute('aria-selected', String(k === i)));
    if (i >= 0) {
      const it = shown[i];
      input.setAttribute('aria-activedescendant', tiles[i].id);
      descN.textContent = it.more ? `${it.name} 하나 더` : it.name;
      descT.textContent = it.more ? MORE_HINT : it.hint;
    } else {
      input.removeAttribute('aria-activedescendant');
      const q = input.value.trim();
      descN.textContent = '';
      descT.textContent = q ? `「${q}」에 맞는 앱이 없어요.` : '넣을 수 있는 것을 이미 다 넣었어요.';
    }
  };
  const pick = (it: DrawerItem): void => { close(); o.onPick(it.type); };
  const draw = (): void => {
    const q = input.value.trim();
    const key = (a: DrawerItem) => ({ title: a.name, desc: a.hint });
    shown = q ? o.items.filter((a) => appMatches(key(a), q)).sort((a, b) => appRank(key(a), q) - appRank(key(b), q)) : o.items.slice();
    hot = -1;
    tiles = shown.map((it, k) => {
      const b = el('button', { class: 'pn-dock-tile' + (it.more ? ' run' : ''), type: 'button', role: 'option', tabindex: '-1',
        id: `pn-adraw-${it.type}`, 'data-type': it.type, 'aria-label': it.more ? `${it.name} 하나 더` : it.name },
        el('span', { class: 'pn-dock-tile-ic' }, dockTile(it.glyph, it.type)),
        el('span', { class: 'pn-dock-tile-n', text: it.name }),
        el('span', { class: 'pn-dock-tile-dot', 'aria-hidden': 'true' }),
        it.more ? el('span', { class: 'pn-adraw-plus', 'aria-hidden': 'true', text: '+' }) : null) as HTMLElement;
      b.addEventListener('click', () => pick(it));
      b.addEventListener('mouseenter', () => { hot = k; say(); });
      b.addEventListener('focus', () => { hot = k; say(); });
      return b;
    });
    grid.replaceChildren(...tiles);
    say();
  };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.isComposing) return;                                    // 한글 조합 중의 Enter 는 글자 확정이다
    if (e.key === 'Enter') { e.preventDefault(); const i = target(); if (i >= 0) pick(shown[i]); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); tiles[0]?.focus(); }
  });
  //  격자 안 — 화살표로 옮긴다(한 줄 = 격자 열 수, ⊞ 와 같다). 첫 줄에서 ↑ 면 검색칸으로.
  grid.addEventListener('keydown', (e: KeyboardEvent) => {
    const i = tiles.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length);
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? cols : e.key === 'ArrowUp' ? -cols : 0;
    if (!d) return;
    e.preventDefault();
    if (i + d < 0) { hot = -1; input.focus(); say(); return; }
    tiles[Math.min(tiles.length - 1, i + d)]?.focus();
  });
  //  마우스가 격자를 떠나면 — 초점이 타일에 있으면 그 타일, 아니면 Enter 의 과녁(첫 타일)으로 설명을 돌린다.
  grid.addEventListener('mouseleave', () => { const f = tiles.indexOf(document.activeElement as HTMLElement); hot = f; say(); });

  draw();                                                         // 타일을 먼저 — anchoredPopover 가 판 높이로 위/아래를 정한다
  close0 = anchoredPopover(anchor, panel);
  //  자리 — [＋] 바로 아래(anchoredPopover), 오른쪽 끝은 그 칸의 오른쪽 끝(-8)에 맞춰 칸 안에 머문다.
  const pane = anchor.closest('.pn-pane');
  if (pane) {
    const pr = pane.getBoundingClientRect(), ar = anchor.getBoundingClientRect(), w = panel.offsetWidth;
    const left = Math.min(pr.right - w - 8, Math.max(pr.left + 8, ar.right - w));
    panel.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, left)) + 'px';
  }
  input.focus({ preventScroll: true });
  return close;
}

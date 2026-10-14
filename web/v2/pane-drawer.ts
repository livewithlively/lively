// ════════════════════════════════════════════════════════════════════════════
// 곁칸 탭 줄 [＋] — «앱 서랍» (#4443, 원준 2026-10-05: «① 앱 서랍 + ② 의 키보드 — 니 말대로 해보자»)
// ════════════════════════════════════════════════════════════════════════════
//  독 ⊞(모든 앱) 패널과 **같은 판 · 같은 머리 · 같은 묶음 · 같은 타일**이다(.pn-dock-more-h/-q/-sec/-sh/-grid · .pn-dock-tile*).
//  묶음은 부르는 쪽이 정한다 — 곁칸은 «사이드바 앱» + «이 세션에 붙이기»(원준 10-05 «세션에 붙인다는 개념으로 두개 나눈건 좋았던거같은데
//  그건 살려줘»). 여기서 여는 것은 모두 사이드바에 선다(«새 탭으로 여는 앱» 없음 · 아래 칸 없음).
//  ⊞ 와 다른 것은 둘 —
//   ① 설명은 고른 앱 하나 — 마우스를 올리거나 키보드로 고른 타일의 설명이 발치 위 한 줄에(아무것도 안 골랐으면 Enter 의 과녁 = 첫 타일).
//   ② 키보드 먼저 — 열리면 검색칸에 초점, 치면 거르고 Enter 로 연다. ↓ 로 타일에 들어가 화살표로 옮긴다(⊞ 와 같은 손).
//  이미 열린 앱(여러 개 띄울 수 있는 것)은 타일 모서리 ＋ 배지 = 하나 더 · 아래 회색 점 = 지금 열려 있음(⊞ 의 점 문법).
//  떠 있는 자리 · 바깥 누름 · Esc 닫기는 anchoredPopover(lib/overlay)가 한다 — 판의 모양만 여기서.
import { anchoredPopover, el } from '../core.js';
import { appMatches, appRank } from '../lib/app-match.js';
import { pnIcon } from './panes-kit.js';

export interface DrawerItem {
  /** 타일 id 의 꼬리(묶음 안에서 겹치지 않게) */
  id: string;
  name: string; hint: string;
  ic: () => SVGElement;
  /** 이미 이 칸에 열려 있다 — 고르면 «하나 더». */
  more?: boolean;
  /** 지금은 고를 수 없다(세션이 없을 때의 «붙이기» 등) — 흐리게 서고, 키보드 · Enter 가 건너뛴다. */
  off?: boolean;
  pick: () => void;
}
/** 묶음 하나 — items 가 null 이면 불러오는 중. */
export interface DrawerSec { title: string; note: string; items: DrawerItem[] | null }
/** 발치 단추 — icon 은 제품 아이콘 표의 이름(icon-table G5), flip 은 위아래 뒤집기. */
export interface DrawerFoot { label: string; title: string; icon: string; flip?: boolean; run: () => void }
export interface DrawerOpts { label: string; placeholder: string; sections: DrawerSec[]; foot: DrawerFoot[] }
export interface DrawerHandle { close(): void; setSection(i: number, s: DrawerSec): void }

/** 하나 더 띄울 때의 설명 — 종전 고르기의 문구 그대로. */
export const MORE_HINT = '같은 것을 하나 더 띄워 나란히 봅니다.';

/** [＋] 아래에 앱 서랍을 연다. */
export function openAppDrawer(anchor: HTMLElement, o: DrawerOpts): DrawerHandle {
  const secs = o.sections.slice();
  const input = el('input', { class: 'pn-dock-more-q', type: 'search', placeholder: o.placeholder, 'aria-label': o.placeholder,
    spellcheck: 'false', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pn-adraw-b' }) as HTMLInputElement;
  const body = el('div', { class: 'pn-adraw-b', id: 'pn-adraw-b', role: 'listbox', 'aria-label': o.label }) as HTMLElement;
  const descN = el('b') as HTMLElement, descT = el('span') as HTMLElement;
  const desc = el('p', { class: 'pn-adraw-desc', 'aria-live': 'polite' }, descN, descT) as HTMLElement;
  let closed = false;
  let close0: () => void = () => {};
  const close = (): void => { if (closed) return; closed = true; close0(); };
  const foot = o.foot.length ? el('div', { class: 'pn-dock-more-f pn-adraw-f' }, ...o.foot.map((f) =>
    el('button', { class: 'btn-text', type: 'button', title: f.title, onclick: () => { close(); f.run(); } },
      pnIcon(f.icon, 'pn-i sm' + (f.flip ? ' pn-adraw-flip' : '')), el('span', { text: f.label })))) : null;
  const panel = el('div', { class: 'pn-adraw', role: 'dialog', 'aria-label': o.label },
    el('div', { class: 'pn-dock-more-h' }, pnIcon('search', 'pn-i sm'), input), body, desc, foot) as HTMLElement;

  let shown: DrawerItem[] = [];      // 지금 보이는 고를 수 있는 타일(묶음 순서대로) — Enter · 화살표 · 설명의 차례
  let tiles: HTMLElement[] = [];
  let hot = -1;                      // 마우스 · 초점이 가리키는 타일. 없으면(-1) 첫 타일 — 검색칸에서 Enter 하면 열리는 것
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
  const pick = (it: DrawerItem): void => { if (it.off) return; close(); it.pick(); };
  const draw = (): void => {
    const q = input.value.trim();
    const key = (a: DrawerItem) => ({ title: a.name, desc: a.hint });
    hot = -1; shown = []; tiles = [];
    const kids: HTMLElement[] = [];
    secs.forEach((sec, si) => {
      const head = el('div', { class: 'pn-dock-more-sh' }, el('b', { text: sec.title }), el('span', { class: 'pn-fine', text: sec.note }));
      if (sec.items === null) { if (!q) kids.push(el('section', { class: 'pn-dock-more-sec' }, head, el('p', { class: 'pn-fine pn-adraw-wait', text: '불러오는 중…' })) as HTMLElement); return; }
      const list = q ? sec.items.filter((a) => appMatches(key(a), q)).sort((a, b) => appRank(key(a), q) - appRank(key(b), q)) : sec.items;
      if (!list.length) return;
      const btns = list.map((it) => {
        const b = el('button', { class: 'pn-dock-tile' + (it.more ? ' run' : ''), type: 'button', role: 'option', tabindex: '-1', disabled: !!it.off,
          id: `pn-adraw-${si}-${it.id}`, 'data-id': it.id, title: it.off ? it.hint : null, 'aria-label': it.more ? `${it.name} 하나 더` : it.name },
          el('span', { class: 'pn-dock-tile-ic' }, it.ic()),
          el('span', { class: 'pn-dock-tile-n', text: it.name }),
          el('span', { class: 'pn-dock-tile-dot', 'aria-hidden': 'true' }),
          it.more ? el('span', { class: 'pn-adraw-plus', 'aria-hidden': 'true', text: '+' }) : null) as HTMLElement;
        if (!it.off) {
          const k = shown.length; shown.push(it); tiles.push(b);
          b.addEventListener('click', () => pick(it));
          b.addEventListener('mouseenter', () => { hot = k; say(); });
          b.addEventListener('focus', () => { hot = k; say(); });
        }
        return b;
      });
      kids.push(el('section', { class: 'pn-dock-more-sec' }, head, el('div', { class: 'pn-dock-more-grid' }, ...btns)) as HTMLElement);
    });
    body.replaceChildren(...kids);
    say();
  };
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.isComposing) return;                                    // 한글 조합 중의 Enter 는 글자 확정이다
    if (e.key === 'Enter') { e.preventDefault(); const i = target(); if (i >= 0) pick(shown[i]); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); tiles[0]?.focus(); }
  });
  //  타일 사이 — 화살표로 옮긴다(한 줄 = 그 격자의 열 수, ⊞ 와 같다 · 묶음을 넘어 이어진다). 첫 줄에서 ↑ 면 검색칸으로.
  body.addEventListener('keydown', (e: KeyboardEvent) => {
    const i = tiles.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const grid = tiles[i].parentElement as HTMLElement;
    const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length);
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? cols : e.key === 'ArrowUp' ? -cols : 0;
    if (!d) return;
    e.preventDefault();
    if (i + d < 0) { hot = -1; input.focus(); say(); return; }
    tiles[Math.min(tiles.length - 1, i + d)]?.focus();
  });
  //  마우스가 타일 밖으로 — 초점이 타일에 있으면 그 타일, 아니면 Enter 의 과녁(첫 타일)으로 설명을 돌린다.
  body.addEventListener('mouseleave', () => { hot = tiles.indexOf(document.activeElement as HTMLElement); say(); });

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
  return {
    close,
    //  늦게 온 묶음(«이 세션에 붙이기» 의 설치 앱 목록) — 닫힌 뒤면 아무 일 없음. 검색어 · 초점은 그대로 둔다.
    setSection: (i: number, s: DrawerSec): void => { if (closed || !secs[i]) return; secs[i] = s; const f = document.activeElement === input; draw(); if (f) input.focus({ preventScroll: true }); },
  };
}

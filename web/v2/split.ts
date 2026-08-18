// v2/split.ts — 경계 끌어 조정(#1719 상민님: "메인 화면의 섹션 수직·수평 경계는 자유롭게 조정할 수 있게 — 좌우 사이드바 포함").
//
//  한 가지 원형만 둔다: **손잡이 하나 = 이웃한 두 칸 사이의 경계**. 끌면 한쪽 칸의 크기(px)를 CSS 변수로 바꾸고 localStorage 에
//  남긴다(새로고침·다음 방문에도 그대로). 그리드 열(세로 경계: 사이드바|가운데|우패널)과 플렉스 높이(가로 경계: 대화|터미널) 둘 다
//  같은 함수로 — 축(axis)만 다르다. 더블클릭 = 기본값으로.
//  ⚠ 크기는 '조정되는 칸' 하나에만 쓴다(나머지는 1fr/flex:1) — 두 칸을 다 px 로 두면 창 크기가 바뀔 때 어긋난다.
//  ⚠ 접근성: 손잡이는 role=separator + 키보드(←→/↑↓ 8px, Home=기본) — 마우스만 되는 경계는 경계가 아니라 장식이다.

export interface SplitOpts {
  axis: 'x' | 'y';            // x = 세로 경계(가로로 끈다 → 너비) · y = 가로 경계(세로로 끈다 → 높이)
  key: string;                // localStorage 키(v2 접두어는 여기서 붙인다)
  cssVar: string;             // 바꿀 CSS 변수 이름(예: --v2-side-w)
  target: HTMLElement;        // 변수를 세팅할 요소(보통 컨테이너)
  def: number;                // 기본값(px)
  min: number; max: number;   // 허용 범위(px)
  /** 손잡이 기준으로 조정되는 칸이 '앞'(왼쪽/위)에 있으면 +1, '뒤'(오른쪽/아래)면 -1 — 끄는 방향과 크기 증감의 부호. */
  grow: 1 | -1;
  label: string;              // aria-label
}

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const KEY = (k: string): string => 'lively_v2_split_' + k;

export function readSplit(key: string, def: number): number {
  try { const v = Number(localStorage.getItem(KEY(key))); return Number.isFinite(v) && v > 0 ? v : def; } catch { return def; }
}

/** 손잡이 요소를 만들어 돌려준다(호출자가 두 칸 사이에 끼운다). 저장된 값이 있으면 그 자리에서 곧바로 적용한다. */
export function makeSplitter(o: SplitOpts): HTMLElement {
  const apply = (px: number, persist: boolean): void => {
    const v = clamp(Math.round(px), o.min, o.max);
    o.target.style.setProperty(o.cssVar, v + 'px');
    if (persist) { try { localStorage.setItem(KEY(o.key), String(v)); } catch { /* 저장 못 해도 이번 화면은 된다 */ } }
  };
  const current = (): number => {
    const raw = getComputedStyle(o.target).getPropertyValue(o.cssVar).trim();
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : o.def;
  };
  apply(readSplit(o.key, o.def), false);

  const h = document.createElement('div');
  h.className = 'v2-split v2-split-' + o.axis;
  h.setAttribute('role', 'separator');
  h.setAttribute('aria-orientation', o.axis === 'x' ? 'vertical' : 'horizontal');
  h.setAttribute('aria-label', o.label);
  h.setAttribute('tabindex', '0');
  h.title = '끌어서 크기 조정 · 더블클릭 = 기본값';

  h.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = o.axis === 'x' ? e.clientX : e.clientY;
    const base = current();
    h.classList.add('on'); document.body.classList.add('v2-splitting-' + o.axis);
    h.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => {
      const d = (o.axis === 'x' ? ev.clientX : ev.clientY) - start;
      apply(base + d * o.grow, false);
    };
    const up = (): void => {
      h.classList.remove('on'); document.body.classList.remove('v2-splitting-' + o.axis);
      h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up);
      apply(current(), true);
    };
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
  });
  h.addEventListener('dblclick', () => apply(o.def, true));
  h.addEventListener('keydown', (e: KeyboardEvent) => {
    const step = e.shiftKey ? 32 : 8;
    const dec = o.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const inc = o.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === dec) { apply(current() - step * o.grow, true); e.preventDefault(); }
    else if (e.key === inc) { apply(current() + step * o.grow, true); e.preventDefault(); }
    else if (e.key === 'Home') { apply(o.def, true); e.preventDefault(); }
  });
  return h;
}

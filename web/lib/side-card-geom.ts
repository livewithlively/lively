// lib/side-card-geom.ts: 세션 카드의 셈(#3870, 원준 2026-09-27). 순수 함수만 둔다. DOM 없음.
//
//  우측 사이드바를 세션 쪽 끝까지 키우면 세션 열이 카드로 바뀐다(v2/side-card.ts). 그 판정과 카드의 자리·크기를
//  여기서 센다. 화면(v2/side-card.ts) · 자리바꿈(v2/side-swap.ts) · 칸 셸(v2/panes.ts)이 같은 값을 쓴다.
//
//  ⚠ 사이드바 상한의 기준은 **격자 폭**(.pn-body)이다. 종전 상한은 창 폭의 88% 였는데, 격자는 레일과 왼쪽 사이드바를
//   뺀 폭이라 1440px 창에서 상한(1267)이 격자(1042)를 넘었다. 끝까지 끌면 세션 열이 0px 가 되고 손잡이가 화면
//   끝에 5px 만 남았다(2026-09-27 매니지드 실측).

/** 세션 열이 이보다 좁아지지 않는다. 이 폭을 지나서 더 끌면 카드 전환 구간이다. */
export const SESS_MIN = 360;
/** 세션과 사이드바 사이 손잡이의 폭(42-v2-panes.css 의 격자 가운데 열). */
export const SPLIT_W = 6;
/** 사이드바 하한(panes.ts 의 min 과 같은 값). */
export const SIDE_MIN = 220;
/** 전환 구간의 이 비율을 넘겨 손을 놓으면 카드가 된다. */
export const COMMIT = 0.3;

/** 카드 값을 못 읽었을 때의 대체값. 실제 처음 크기·자리는 아래 defaultCardSize · defaultAnchor 가 창과 세션 쪽으로 정한다. */
export const CARD_DEF = { w: 360, h: 306, r: 24, b: 24 } as const;
/** 카드의 가장 작은 크기. 머리줄과 터미널 몇 줄이 들어가는 크기다. 기본값보다 작아야 사람이 더 줄일 수 있다. */
export const CARD_MIN = { w: 260, h: 160 } as const;
/** 카드를 제자리로 되돌릴 때 사이드바 폭. 세션을 처음 열 때의 기본 폭(panes.ts)과 같다 — 작은 카드를 키우려는 사람은
 *  세션을 크게 보려는 것이라, 사이드바는 상한이 아니라 기본 폭으로 물러나고 세션이 가운데를 차지한다(원준 2026-09-30). */
export const SIDE_DEF = 340;
/** 카드가 격자 가장자리에서 떨어져 있어야 하는 거리. */
export const CARD_PAD = 8;

export interface CardRect {
  /** 폭 · 높이 */
  w: number; h: number;
  /** 격자 오른쪽 · 아래 가장자리에서 떨어진 거리. 창 크기가 바뀌어도 오른쪽 아래 기준으로 선다. */
  r: number; b: number;
}
export interface CardState extends CardRect { fold: boolean }

const num = (v: unknown, d: number): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(Math.max(a, b), v));

/** 사이드바 상한(px). 격자 폭을 아직 못 쟀으면(0) 막지 않는다. 그때 막으면 적어 둔 폭이 하한으로 깎인다. */
export function sideCap(bodyW: number): number {
  if (!(bodyW > 0)) return Number.MAX_SAFE_INTEGER;
  return Math.max(SIDE_MIN, Math.round(bodyW) - SESS_MIN - SPLIT_W);
}

/** 카드 전환 구간의 길이(px). 상한에서 격자 끝까지다. */
export function overZone(bodyW: number): number {
  return Math.max(1, Math.round(bodyW) - sideCap(bodyW));
}

/** 상한을 넘겨 끈 거리(px)를 0~1 로. */
export function overProgress(overPx: number, bodyW: number): number {
  if (!(bodyW > 0) || !(overPx > 0)) return 0;
  return Math.min(1, overPx / overZone(bodyW));
}

/** 손을 놓았을 때 카드로 바꿀까. */
export const shouldCommit = (p: number): boolean => p > COMMIT;

/** 카드를 격자 안에 넣는다. 크기를 먼저 맞추고 자리를 맞춘다.
 *  foldH = 최소화한 카드(머리줄만 남는다)의 보이는 높이. 주면 자리의 세로 범위를 **그 높이**로 센다 — 카드는 아래 가장자리(b)에
 *  서므로 머리줄만 남은 카드는 편 카드보다 (h − foldH) 만큼 더 위로 갈 수 있다. 종전엔 최소화해도 편 높이로 세어서 창 위쪽
 *  (편 높이 − 머리줄)만큼은 갈 수 없었다(원준 2026-10-07 «최소화 상태에서는 또 … 이동 범위에 제약»). 크기(h)는 그대로 둔다 — 펴면 그 크기다.
 *  그렇게 올려 둔 카드를 펴면 foldH 없이 다시 세어 창 안으로 내려온다. */
export function clampCard(c: CardRect, bodyW: number, bodyH: number, foldH?: number): CardRect {
  //  격자가 카드 최소 크기보다 작으면(왼쪽 사이드바를 아주 넓게 편 좁은 창) 최소 크기를 고집하지 않는다. 격자 안에 넣는 것이 먼저다.
  const maxW = Math.max(1, Math.round(bodyW) - CARD_PAD * 2);
  const maxH = Math.max(1, Math.round(bodyH) - CARD_PAD * 2);
  const w = clamp(Math.round(num(c.w, CARD_DEF.w)), Math.min(CARD_MIN.w, maxW), maxW);
  const h = clamp(Math.round(num(c.h, CARD_DEF.h)), Math.min(CARD_MIN.h, maxH), maxH);
  const r = clamp(Math.round(num(c.r, CARD_DEF.r)), CARD_PAD, Math.round(bodyW) - w - CARD_PAD);
  const seen = foldH !== undefined && foldH > 0 ? Math.min(h, Math.round(foldH)) : h;
  const b = clamp(Math.round(num(c.b, CARD_DEF.b)), CARD_PAD, Math.round(bodyH) - seen - CARD_PAD);
  return { w, h, r, b };
}

/** 크기 조절 손잡이의 자리. n=위 s=아래 e=오른쪽 w=왼쪽, 모서리는 둘을 잇는다. */
export type CardEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** 손잡이를 (dx, dy) 만큼 끌었을 때의 카드. 반대쪽 가장자리는 제자리에 둔다. */
export function resizeCard(c: CardRect, edge: CardEdge, dx: number, dy: number, bodyW: number, bodyH: number): CardRect {
  const BW = Math.round(bodyW), BH = Math.round(bodyH);
  // 왼쪽 · 위 · 오른쪽 · 아래 가장자리의 좌표(격자 기준)로 바꿔 움직이고 되돌린다.
  let left = BW - c.r - c.w, top = BH - c.b - c.h, right = BW - c.r, bottom = BH - c.b;
  if (edge.includes('w')) left = clamp(left + dx, CARD_PAD, right - CARD_MIN.w);
  if (edge.includes('e')) right = clamp(right + dx, left + CARD_MIN.w, BW - CARD_PAD);
  if (edge.includes('n')) top = clamp(top + dy, CARD_PAD, bottom - CARD_MIN.h);
  if (edge.includes('s')) bottom = clamp(bottom + dy, top + CARD_MIN.h, BH - CARD_PAD);
  return clampCard({ w: right - left, h: bottom - top, r: BW - right, b: BH - bottom }, BW, BH);
}

/** 카드를 (dx, dy) 만큼 옮겼을 때. 크기는 그대로다. foldH = 최소화한 카드의 보이는 높이(clampCard). */
export function moveCard(c: CardRect, dx: number, dy: number, bodyW: number, bodyH: number, foldH?: number): CardRect {
  return clampCard({ w: c.w, h: c.h, r: c.r - dx, b: c.b - dy }, bodyW, bodyH, foldH);
}

/** 브라우저에 적어 둔 카드(JSON 글자)를 읽는다. 깨졌거나 없으면 기본값이다. */
export function parseCard(raw: string | null | undefined): CardState {
  let o: Record<string, unknown> = {};
  try { const v = raw ? JSON.parse(raw) : null; if (v && typeof v === 'object') o = v as Record<string, unknown>; } catch (_) { o = {}; }
  return {
    w: Math.max(CARD_MIN.w, Math.round(num(o.w, CARD_DEF.w))),
    h: Math.max(CARD_MIN.h, Math.round(num(o.h, CARD_DEF.h))),
    r: Math.max(0, Math.round(num(o.r, CARD_DEF.r))),
    b: Math.max(0, Math.round(num(o.b, CARD_DEF.b))),
    fold: o.fold === true,
  };
}

// ── 처음 자리 · 처음 크기 · 기억 (원준 2026-10-09 «위치 · 크기 · 상태가 되는 대로 짜였다») ─────────────────────────
//  카드는 창 기준(position: fixed)이다. 자리는 r · b 가 아니라 **가장 가까운 모서리 + 거리**로 적는다 — 창 크기가 바뀌어도
//  그 모서리에 붙어 있다(오른쪽 · 아래 거리로만 적으면 왼쪽에 둔 카드가 창을 넓힐 때 오른쪽으로 끌려간다).

/** 카드가 붙는 창의 모서리. t/b = 위/아래, l/r = 왼쪽/오른쪽. */
export type Corner = 'tl' | 'tr' | 'bl' | 'br';
export interface CardAnchor { corner: Corner; dx: number; dy: number }
/** 카드와 가장자리 사이의 기본 거리. */
export const CARD_GAP = 24;

/** 처음 크기. 폭 = 세션 열의 마지막 폭(SESS_MIN) — 카드가 되는 순간 터미널 줄 폭이 그대로라 화면이 다시 접히지 않는다.
 *  높이 = 창 높이의 34%(260~400). */
export function defaultCardSize(viewH: number): { w: number; h: number } {
  return { w: SESS_MIN, h: clamp(Math.round(num(viewH, 900) * 0.34), 260, 400) };
}

/** 처음 자리. 세션이 줄어든 쪽의 아래 모서리, 사이드바(격자) 안 — 손이 끝난 자리이고 세션이 사라진 자리다.
 *  gridLeft · gridRight = 격자의 창 좌표. 레일 · 왼쪽 목록 위에는 뜨지 않는다. */
export function defaultAnchor(sessionLeft: boolean, gridLeft: number, gridRight: number, viewW: number): CardAnchor {
  return sessionLeft
    ? { corner: 'bl', dx: Math.max(0, Math.round(num(gridLeft, 0))) + CARD_GAP, dy: CARD_GAP }
    : { corner: 'br', dx: Math.max(0, Math.round(num(viewW, 0) - num(gridRight, viewW))) + CARD_GAP, dy: CARD_GAP };
}

/** 모서리 + 거리 → 창 기준 r · b(창 안으로 넣은 값). 접혀 있으면 보이는 높이(알약)로 센다 — 위 모서리에 붙은 카드는
 *  알약이 위에 남고, 아래 모서리면 아래에 남는다. */
export function rectFromAnchor(w: number, h: number, a: CardAnchor, viewW: number, viewH: number, foldH?: number): CardRect {
  const seen = foldH !== undefined && foldH > 0 ? Math.min(h, Math.round(foldH)) : h;
  const r = a.corner[1] === 'r' ? a.dx : Math.round(viewW) - w - a.dx;
  const b = a.corner[0] === 'b' ? a.dy : Math.round(viewH) - seen - a.dy;
  return clampCard({ w, h, r, b }, viewW, viewH, foldH);
}

/** 창 기준 r · b → 가장 가까운 모서리 + 거리. 카드 가운데가 창의 어느 쪽 절반에 있나로 모서리를 고른다. */
export function anchorFromRect(c: CardRect, viewW: number, viewH: number, foldH?: number): CardAnchor {
  const seen = foldH !== undefined && foldH > 0 ? Math.min(c.h, Math.round(foldH)) : c.h;
  const left = Math.round(viewW) - c.r - c.w;
  const top = Math.round(viewH) - c.b - seen;
  const isLeft = left + c.w / 2 < viewW / 2;
  const isTop = top + seen / 2 < viewH / 2;
  return { corner: ((isTop ? 't' : 'b') + (isLeft ? 'l' : 'r')) as Corner, dx: isLeft ? left : c.r, dy: isTop ? top : c.b };
}

/** 기억해 두는 것 — 사람이 바꾼 크기(sized) · 옮긴 자리(placed). 따로 센다. 최소화는 기억하지 않는다(카드는 늘 펼쳐서 뜬다). */
export interface CardPrefs { w: number; h: number; sized: boolean; corner: Corner; dx: number; dy: number; placed: boolean }
const CORNERS: Corner[] = ['tl', 'tr', 'bl', 'br'];
/** 적어 둔 값(JSON 글자)을 읽는다. 깨졌거나 없으면 아무것도 기억하지 않은 상태(기본 크기 · 세션 쪽 모서리). */
export function parsePrefs(raw: string | null | undefined): CardPrefs {
  let o: Record<string, unknown> = {};
  try { const v = raw ? JSON.parse(raw) : null; if (v && typeof v === 'object') o = v as Record<string, unknown>; } catch (_) { o = {}; }
  const corner = CORNERS.includes(o.corner as Corner) ? (o.corner as Corner) : 'br';
  const sized = o.sized === true && Number.isFinite(Number(o.w)) && Number.isFinite(Number(o.h));
  const placed = o.placed === true && Number.isFinite(Number(o.dx)) && Number.isFinite(Number(o.dy));
  return {
    w: sized ? Math.max(CARD_MIN.w, Math.round(Number(o.w))) : 0,
    h: sized ? Math.max(CARD_MIN.h, Math.round(Number(o.h))) : 0,
    sized,
    corner,
    dx: placed ? Math.max(0, Math.round(Number(o.dx))) : CARD_GAP,
    dy: placed ? Math.max(0, Math.round(Number(o.dy))) : CARD_GAP,
    placed,
  };
}

/** 창 좌표의 상자(왼쪽 · 위 · 오른쪽 · 아래). */
export interface Box { left: number; top: number; right: number; bottom: number }
/** 기본 자리가 아래쪽에 떠 있는 막대(곁칸 앱 막대 등)와 겹치면 그 위로 올린다 — 카드가 사이드바의 길을 막지 않게.
 *  아래 모서리 자리에만 쓴다(위 모서리는 막대와 반대쪽). h = 보이는 높이(접혀 있으면 알약 높이). 올려도 또 겹치면 한 번 더 본다.
 *  ⚠ 사람이 옮긴 자리에는 쓰지 않는다(그 자리는 사람이 고른 것이다) — 부르는 쪽이 기본 자리일 때만 부른다. */
export function liftAbove(a: CardAnchor, w: number, h: number, boxes: Box[], viewW: number, viewH: number, gap = 12): CardAnchor {
  if (a.corner[0] !== 'b' || !boxes.length) return a;
  const left = a.corner[1] === 'l' ? a.dx : Math.round(viewW) - a.dx - w;
  const right = left + w;
  let dy = a.dy;
  for (let i = 0; i < 4; i++) {
    const top = Math.round(viewH) - dy - h, bottom = Math.round(viewH) - dy;
    let next = dy;
    for (const b of boxes) {
      if (b.right > left && b.left < right && b.bottom > top && b.top < bottom) next = Math.max(next, Math.round(viewH - b.top + gap));
    }
    if (next === dy) break;
    dy = next;
  }
  return dy === a.dy ? a : { ...a, dy };
}

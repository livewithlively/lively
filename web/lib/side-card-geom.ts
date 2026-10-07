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

/** 카드의 기본 크기와 가장자리 여백. 사이드바를 끝까지 키운 사람은 사이드바를 크게 보려는 것이라 카드는 작게 뜬다
 *  (원준 2026-09-30, 종전 420×560 은 1440 창에서 격자의 27%, 1116 창에서 43% 를 가렸다). */
export const CARD_DEF = { w: 320, h: 240, r: 24, b: 24 } as const;
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

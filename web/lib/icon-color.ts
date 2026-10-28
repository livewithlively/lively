// lib/icon-color.ts — 앱빌더 ④ 아이콘 「다른 색」 팔레트의 **순수** 색 계산(#4632, 원준 2026-10-28 «9개 냅두고, 원하면 다른 색을 훨씬 더 다양하게 · 존재하는 모든 색 보이는 연속적 컬러팔레트»).
//  화면(web/v2/app-studio.ts)은 색 면(채도 × 밝기)과 색상 띠(0~360)로 고르고, 여기서 색 코드 · 어두운 화면 짝 · 흐림 판정을 얻는다.
//  매니페스트 icon 은 색 둘(color · color_dark)을 받는다 — 사람은 하나만 고르고, 어두운 화면 색은 darkPair 가 만든다(9색의 짝처럼 조금 밝게).
//  시험: scripts/icon-color.test.mjs

export interface Hsv { h: number; s: number; v: number }   // h 0~360 · s, v 0~1
type Rgb = [number, number, number];   // 0~255

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** 색 코드를 #RRGGBB(대문자)로 — «#abc» · «abc» · «#a1b2c3» · 앞뒤 공백을 받는다. 틀리면 null. */
export function normHex(raw: string): string | null {
  const s = String(raw || '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) return '#' + s.split('').map((c) => c + c).join('').toUpperCase();
  if (/^[0-9a-fA-F]{6}$/.test(s)) return '#' + s.toUpperCase();
  return null;
}
function rgbOf(hex: string): Rgb { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function hexOf([r, g, b]: Rgb): string { return '#' + [r, g, b].map((x) => Math.round(clamp(x, 0, 255)).toString(16).padStart(2, '0')).join('').toUpperCase(); }

/** 색 면 · 색상 띠의 자리 → 색 코드. */
export function hsvToHex({ h, s, v }: Hsv): string {
  const hh = ((h % 360) + 360) % 360 / 60, ss = clamp(s, 0, 1), vv = clamp(v, 0, 1);
  const c = vv * ss, x = c * (1 - Math.abs((hh % 2) - 1)), m = vv - c;
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return hexOf([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}
/** 색 코드 → 색 면 · 색상 띠의 자리(팔레트를 펼칠 때 지금 색에 손잡이를 둔다). 틀린 코드면 null. */
export function hexToHsv(raw: string): Hsv | null {
  const hex = normHex(raw); if (!hex) return null;
  const [r, g, b] = rgbOf(hex).map((x) => x / 255) as Rgb;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s: max ? d / max : 0, v: max };
}

function toHsl([r0, g0, b0]: Rgb): [number, number, number] {
  const r = r0 / 255, g = g0 / 255, b = b0 / 255, max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return [(h + 360) % 360, s, l];
}
function fromHsl(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s, hh = h / 60, x = c * (1 - Math.abs((hh % 2) - 1)), m = l - c / 2;
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
const lum = (rgb: Rgb): number => {
  const [r, g, b] = rgb.map((x) => { const c = x / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** 두 색의 대비(WCAG, 1~21). */
export function contrast(a: string, b: string): number {
  const x = lum(rgbOf(normHex(a) || '#000000')), y = lum(rgbOf(normHex(b) || '#000000'));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
//  타일 바탕(01-base.css --bg-tint · 90-dark.css --bg-tint) — 아이콘 선이 서는 자리의 가장 가까운 단색.
export const LIGHT_TILE = '#F6FAFF', DARK_TILE = '#171F31';
/** 선 그림이 읽히는 대비의 아래 끝 — 큰 그림 · 선(WCAG 비문자 3:1). */
export const ICON_MIN_CONTRAST = 3;

/** 어두운 화면용 짝 — 같은 색상 · 채도로 밝기만 올린다(9색의 짝처럼 한 단계 밝게). 어두운 타일 위에서 대비가 4 이상이 될 때까지 더 올린다. */
export function darkPair(raw: string): string {
  const hex = normHex(raw) || '#576889';
  const [h, s, l] = toHsl(rgbOf(hex));
  let L = Math.max(l + 0.1, 0.45);
  let out = hexOf(fromHsl(h, s, Math.min(L, 0.9)));
  while (contrast(out, DARK_TILE) < 4 && L < 0.9) { L += 0.02; out = hexOf(fromHsl(h, s, Math.min(L, 0.9))); }
  return out;
}
/** 밝은 화면에서 너무 흐린가 — 밝은 타일 위 대비가 선 그림의 아래 끝에 못 미친다. */
export function tooLight(raw: string): boolean {
  const hex = normHex(raw); return !!hex && contrast(hex, LIGHT_TILE) < ICON_MIN_CONTRAST;
}

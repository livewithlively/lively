// 라이블리 소개 영상 — 장면과 시간표. 그리는 법은 engine.js, 생김새는 film.css.
//  이야기: 문패 → «AI는 똑똑하지만 내 일을 모른다» → 맥락 없는 대화 → 라이블리가 대신 챙긴다 →
//          수집 → 증류 → 전달(같은 한 줄이 이번엔 통한다) → 화면(레일 둘 + 앱 찾기) → 맺음.
import { K, tw, F, seek, rise, leave, pop, fade, riseWords, type, count } from './engine.js';
import * as engine from './engine.js';
import { ICONS, LOGOS } from './assets.gen.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };

// ── 그림 심기 ────────────────────────────────────────────────────────────────
for (const i of $$('i[data-ic]')) {
  const s = svgEl('svg', { viewBox: '0 0 24 24' });
  s.append(svgEl('path', { d: ICONS[i.dataset.ic] }));
  i.append(s);
}
for (const i of $$('i[data-logo]')) {
  const L = LOGOS[i.dataset.logo];
  const s = svgEl('svg', { viewBox: L.vb });
  for (const p of L.p) s.append(svgEl('path', p));
  i.append(s);
}
for (const n of $$('[data-y]')) n.style.top = n.dataset.y + 'px';

await document.fonts.ready;
await Promise.all(['400', '500', '600', '700'].map((w) => document.fonts.load(`${w} 40px Pretendard`, '가A')));

// ── 길(전선) ────────────────────────────────────────────────────────────────
const wires = $('#wires');
function wire(x1, y1, x2, y2) {
  const dx = (x2 - x1) * 0.5;
  const d = `M${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  const base = svgEl('path', { d, stroke: 'rgba(255,255,255,.13)', 'stroke-width': 2, 'stroke-linecap': 'round' });
  wires.append(base);
  const len = base.getTotalLength();
  base.style.strokeDasharray = String(len);
  base.style.strokeDashoffset = String(len);
  return { d, base, len };
}
function drawWire(w, t, dur = 0.8) {
  F(w.base, [[t, 0, 'hold'], [t + dur, 1, 'soft']], (el, p) => { el.style.strokeDashoffset = String(w.len * (1 - p)); });
}
/** 길을 따라 빛 한 토막이 달린다. */
function pulse(w, t, dur = 0.8, color = '#43E5B0') {
  const seg = Math.min(120, w.len * 0.45);
  const glow = svgEl('path', { d: w.d, stroke: color, 'stroke-width': 9, 'stroke-linecap': 'round', opacity: 0 });
  const core = svgEl('path', { d: w.d, stroke: '#EFFFF9', 'stroke-width': 3, 'stroke-linecap': 'round', opacity: 0 });
  glow.style.filter = 'blur(5px)';
  wires.append(glow, core);
  for (const el of [glow, core]) {
    el.style.strokeDasharray = `${seg} ${w.len + seg * 2}`;
    F(el, [[t, 0, 'hold'], [t + dur, 1, 'soft']], (n, p) => {
      n.style.strokeDashoffset = String(seg - p * (w.len + seg));
      n.style.opacity = p <= 0.001 || p >= 0.999 ? '0' : (n === glow ? '0.75' : '1');
    });
  }
}
/** 장면이 보이는 구간. */
function show(sel, t0, t1) { K(sel, { o: [[0, 0], [t0, 1, 'hold'], [t1, 0, 'hold']] }); }
/** 깜빡이는 글쇠 막대. */
function blink(sel, t0, t1) {
  F(sel, [[0, 0], [200, 200, 'lin']], (el, v) => { el.style.opacity = (v >= t0 && v < t1 && ((v * 1.7) % 1) < 0.58) ? '1' : '0'; });
}

const PROMPT = '지난주 회의에서 정한 대로 제안서 고쳐 줘';

// ════════════════════════════════════════════════════════════════════════════
//  바탕 — 빛 두 덩이가 영상 내내 천천히 흐른다
// ════════════════════════════════════════════════════════════════════════════
K('#glow1', { x: [[0, 0], [66, 260, 'lin']], y: [[0, 0], [66, 150, 'lin']] });
K('#glow2', { x: [[0, 0], [66, -300, 'lin']], y: [[0, 0], [66, -120, 'lin']] });

// ════════════════════════════════════════════════════════════════════════════
//  A · 문패 (0 → 3.0)
// ════════════════════════════════════════════════════════════════════════════
{
  show('#sA', 0, 3.25);
  const shift = ($('#logoWm').offsetWidth + 30) / 2;
  const wmW = $('#logoWm').offsetWidth + 20;
  tw('#logoDot', 0.35, 0.9, { s: 0, o: 0 }, { s: 1, o: 1 }, 'back');
  K('#logoRing', { o: [[0, 0]] });
  tw('#logoRing', 0.55, 1.5, { s: 1, o: 0.9 }, { s: 3.6, o: 0 }, 'out');
  tw('#logo', 0.95, 1.15, { x: shift }, { x: 0 }, 'inOut');
  tw('#logoWm', 0.95, 1.15, { x: -wmW }, { x: 0 }, 'inOut');
  tw('#logo', 2.7, 0.5, null, { o: 0 }, 'soft');
  tw('#logo', 2.7, 0.5, { s: 1 }, { s: 0.965 }, 'in');
  tw('#logo', 2.7, 0.5, { b: 0 }, { b: 10 }, 'soft');
}

// ════════════════════════════════════════════════════════════════════════════
//  A2 · 첫 문장 (3.1 → 7.3)
// ════════════════════════════════════════════════════════════════════════════
{
  show('#sA2', 3.1, 7.7);
  riseWords('#hl1', 3.25);
  riseWords('#hl2', 4.75);
  leave(['#hl1', '#hl2'].map($), 6.95, { stagger: 0.07 });
}

// ════════════════════════════════════════════════════════════════════════════
//  B · 맥락 없는 대화 (7.5 → 16.4)
// ════════════════════════════════════════════════════════════════════════════
{
  show('#sB', 7.5, 16.6);
  tw('#chat', 7.5, 0.7, { o: 0 }, { o: 1 }, 'soft');
  tw('#chat', 7.5, 1.2, { y: 70, s: 0.955 }, { y: 0, s: 1 }, 'out');
  blink('#caretB', 7.9, 10.15);
  type('#chatIn', PROMPT, 8.2, 9.85, { clearAt: 10.15 });
  pop('#bMe1', 10.15, { dy: 30, from: 0.9 });
  pop('#bAiTyping', 10.75, { dur: 0.45 });
  F('#bAiTyping', [[0, 0], [200, 200, 'lin']], (el, v) => {
    el.querySelectorAll('i').forEach((d, i) => { d.style.transform = `translateY(${(-7 * Math.max(0, Math.sin(v * 7.5 - i * 0.9))).toFixed(2)}px)`; });
  });
  tw('#bAiTyping', 11.85, 0.12, null, { o: 0 }, 'soft');
  pop('#bAi1', 11.9, { dur: 0.55, from: 0.94, dy: 8 });
  pop('#bMe2', 13.35, { dur: 0.5, dy: 22 });
  pop('#bMe3', 13.85, { dur: 0.5, dy: 22 });
  pop('#bMe4', 14.35, { dur: 0.5, dy: 22 });
  riseWords('#capB', 13.5, { dy: 20, blur: 8 });
  tw('#chat', 15.9, 0.55, null, { o: 0 }, 'soft');
  tw('#chat', 15.9, 0.55, null, { y: -26, s: 0.975 }, 'in');
  tw('#chat', 15.9, 0.55, { b: 0 }, { b: 10 }, 'soft');
  leave('#capB', 15.85, { dy: -12 });
}

// ════════════════════════════════════════════════════════════════════════════
//  C · 전환 (16.7 → 20.9)
// ════════════════════════════════════════════════════════════════════════════
{
  show('#sC', 16.7, 21.2);
  rise('#eyeC', 16.8, { dy: 16, blur: 6 });
  riseWords('#hl3', 17.0);
  riseWords('#hl4', 18.05);
  leave([$('#eyeC'), $('#hl3'), $('#hl4')], 20.45, { stagger: 0.06 });
}

// ════════════════════════════════════════════════════════════════════════════
//  P · 수집 → 증류 → 전달 (21.2 → 50.6)
// ════════════════════════════════════════════════════════════════════════════
{
  const T0 = 21.2;
  show('#sP', T0, 51.2);
  const CAM1 = 0, CAM2 = -920, CAM3 = -2040;
  const PAN1 = 30.0, PAN2 = 40.2, OUT = 50.4;
  K('#world', { x: [[0, CAM1], [PAN1, CAM1, 'hold'], [PAN1 + 1.5, CAM2, 'inOut'], [PAN2, CAM2, 'hold'], [PAN2 + 1.5, CAM3, 'inOut']] });

  // 자리 재기
  const srcs = $$('.src');
  const rows = $$('.row');
  const srcY = (i) => Number(srcs[i].dataset.y) + 54;
  const rowY = (i) => 120 + 96 + 8 + i * 98 + 49;
  const cards = ['#k1', '#k2', '#k3'].map($);
  //  카드는 키가 저마다 다르다 — 잰 키로 차곡차곡 세운다.
  { let y = 198; for (const c of cards) { c.style.top = y + 'px'; c.dataset.y = String(y); y += c.offsetHeight + 18; } }
  const cardY = (n) => Number(n.dataset.y) + n.offsetHeight / 2;
  const LENS = { x: 1960, y: 472 };

  // ── ① 수집 ──
  const wIn = rows.map((r, i) => wire(408 + 14, srcY(Number(r.dataset.from)), 1060 - 12, rowY(i)));
  pop(srcs, T0 + 0.2, { stagger: 0.09, dur: 0.7, dy: 24 });
  wIn.forEach((w, i) => drawWire(w, T0 + 0.75 + i * 0.06, 0.9));
  tw('#pSrc', T0 + 0.55, 0.6, { o: 0 }, { o: 1 }, 'soft');
  tw('#pSrc', T0 + 0.55, 1.15, { y: 64, s: 0.96 }, { y: 0, s: 1 }, 'out');
  rise('#cap1', T0 + 0.5, { dy: 22, blur: 8 });
  fade('#steps', T0 + 0.7, 0.6, 1, 0);
  K('#st1', { '--on': [[0, 0], [T0 + 0.7, 0, 'hold'], [T0 + 1.2, 1, 'soft'], [PAN1 + 0.4, 1, 'hold'], [PAN1 + 1.0, 0.42, 'soft']] });
  K('#st2', { '--on': [[0, 0], [PAN1 + 0.4, 0, 'hold'], [PAN1 + 1.0, 1, 'soft'], [PAN2 + 0.4, 1, 'hold'], [PAN2 + 1.0, 0.42, 'soft']] });
  K('#st3', { '--on': [[0, 0], [PAN2 + 0.4, 0, 'hold'], [PAN2 + 1.0, 1, 'soft']] });

  const FIRST = T0 + 1.75, GAP = 0.6, RUN = 0.85;
  rows.forEach((r, i) => {
    const t = FIRST + i * GAP;
    const tile = srcs[Number(r.dataset.from)].querySelector('.tile');
    tw(tile, t - 0.12, 0.22, { s: 1 }, { s: 1.09 }, 'out');
    tw(tile, t + 0.1, 0.5, null, { s: 1 }, 'out');
    pulse(wIn[i], t, RUN);
    tw(r, t + RUN - 0.12, 0.35, { o: 0 }, { o: 1 }, 'soft');
    tw(r, t + RUN - 0.12, 0.6, { x: -26 }, { x: 0 }, 'out');
    K(r, { '--hot': [[0, 0], [t + RUN - 0.12, 1, 'hold'], [t + RUN + 0.9, 0, 'soft']] });
  });
  // 줄이 다 선 뒤에도 자료는 계속 들어온다
  [0, 3, 1, 4, 2, 5, 0, 2].forEach((i, n) => pulse(wIn[i], FIRST + rows.length * GAP + 0.35 + n * 0.33, 0.75));
  count('#cntSrc', FIRST + RUN - 0.1, PAN1 + 0.2, 0, 1284, 'outSoft');

  // ── ② 증류 ──
  const wMid = [0, 1, 2, 3, 4, 5].map((i) => wire(1700 + 12, rowY(i), LENS.x - 104, LENS.y));
  const wOut = cards.map((c) => wire(LENS.x + 104, LENS.y, 2160 - 12, cardY(c)));
  leave('#cap1', PAN1 - 0.25, { dy: -14 });
  rise('#cap2', PAN1 + 1.15, { dy: 22, blur: 8 });
  wMid.forEach((w, i) => drawWire(w, PAN1 + 0.55 + i * 0.05, 0.8));
  wOut.forEach((w, i) => drawWire(w, PAN1 + 0.95 + i * 0.06, 0.7));
  tw('#lens', PAN1 + 0.5, 0.5, { o: 0 }, { o: 1 }, 'soft');
  tw('#lens', PAN1 + 0.5, 1.0, { s: 0.55 }, { s: 1 }, 'back');
  K('#lensRing', { r: [[PAN1, 0], [PAN2 + 2, 1500, 'lin']] });
  K('#lensPulse', { o: [[0, 0]] });
  fade('#lensLb', PAN1 + 1.3, 0.6, 1, 0);
  fade('#kCount', PAN1 + 1.2, 0.6, 1, 0);
  tw('#kCount', PAN1 + 1.2, 0.9, { y: 18 }, { y: 0 }, 'out');

  const CY0 = PAN1 + 1.75, CYGAP = 2.2;
  const feed = [[0, 1, 5], [1, 3, 4], [2, 3]];
  cards.forEach((c, n) => {
    const t = CY0 + n * CYGAP;
    feed[n].forEach((ri, k) => {
      const at = t + k * 0.16;
      K(rows[ri], { '--hot': [[at - 0.05, 0, 'hold'], [at + 0.2, 1, 'soft'], [at + 1.0, 0, 'soft']] });
      pulse(wMid[ri], at, 0.7, '#7DA5FA');
    });
    const hit = t + 0.75;
    tw('#lensPulse', hit, 0.95, { s: 1, o: 0.85 }, { s: 1.75, o: 0 }, 'out');
    tw('.lens-core', hit, 0.16, { s: 1 }, { s: 1.07 }, 'out');
    tw('.lens-core', hit + 0.16, 0.5, null, { s: 1 }, 'out');
    pulse(wOut[n], hit + 0.25, 0.6);
    const born = hit + 0.25 + 0.5;
    tw(c, born, 0.4, { o: 0 }, { o: 1 }, 'soft');
    tw(c, born, 0.85, { x: -44, s: 0.9 }, { x: 0, s: 1 }, 'back');
  });
  count('#cntK', CY0 + 1.4, PAN2 + 0.1, 0, 212, 'outSoft');

  // ── ③ 전달 ──
  const FOUND_Y = 120 + 96 + 122 + 64;
  const wSess = cards.map((c) => wire(2740 + 12, cardY(c), 2900 - 12, FOUND_Y));
  leave('#cap2', PAN2 - 0.25, { dy: -14 });
  rise('#cap3', PAN2 + 1.15, { dy: 22, blur: 8 });
  fade('#lensLb', PAN2, 0.5, 0);
  tw('#pSess', PAN2 + 0.35, 0.6, { o: 0 }, { o: 1 }, 'soft');
  tw('#pSess', PAN2 + 0.35, 1.2, { y: 64, s: 0.96 }, { y: 0, s: 1 }, 'out');
  wSess.forEach((w, i) => drawWire(w, PAN2 + 1.1 + i * 0.06, 0.6));
  const TY = PAN2 + 1.7;
  blink('#caretS', TY - 0.3, TY + 1.95);
  type('#sessIn', PROMPT, TY, TY + 1.6, { clearAt: TY + 1.95 });
  pop('#sMe', TY + 1.95, { dy: 26, from: 0.9 });
  const SEND = TY + 1.95;
  K('#sessLive', { s: [[SEND + 0.25, 1, 'hold'], [SEND + 0.45, 1.07, 'out'], [SEND + 1.0, 1, 'out']] });
  cards.forEach((c, n) => {
    const at = SEND + 0.45 + n * 0.22;
    tw(c, at - 0.1, 0.2, { s: 1 }, { s: 1.035 }, 'out');
    tw(c, at + 0.1, 0.55, null, { s: 1 }, 'out');
    pulse(wSess[n], at, 0.55);
  });
  tw('#sFound', SEND + 0.85, 0.4, { o: 0 }, { o: 1 }, 'soft');
  tw('#sFound', SEND + 0.85, 0.8, { y: 20 }, { y: 0 }, 'out');
  pop(['#kc1', '#kc2', '#kc3'].map($), SEND + 1.15, { stagger: 0.2, dur: 0.55, dy: 8 });
  const ANS = SEND + 2.45;
  rise('#sA1', ANS, { dy: 14, blur: 6, dur: 0.7 });
  rise('#sA2l', ANS + 0.6, { dy: 12, blur: 5, dur: 0.6 });
  rise('#sA3l', ANS + 1.05, { dy: 12, blur: 5, dur: 0.6 });
  pop('#sFile', ANS + 1.7, { dur: 0.55, dy: 10 });

  // 물러남
  tw('#world', OUT, 0.6, null, { o: 0 }, 'soft');
  K('#world', { s: [[OUT, 1, 'hold'], [OUT + 0.6, 0.975, 'in']], b: [[OUT, 0, 'hold'], [OUT + 0.6, 10, 'soft']] });
  leave('#cap3', OUT - 0.05, { dy: -14 });
  fade('#steps', OUT, 0.5, 0);
}

// ════════════════════════════════════════════════════════════════════════════
//  G · 제품 화면 — 레일 둘 + 앱 찾기 (51.2 → 61.4)
// ════════════════════════════════════════════════════════════════════════════
{
  const T0 = 51.2, OUT = 61.2;
  show('#sG', T0, OUT + 0.7);
  tw('#win', T0, 0.7, { o: 0 }, { o: 1 }, 'soft');
  tw('#win', T0, 1.5, { y: 110, rx: 16, s: 0.9 }, { y: 0, rx: 0, s: 1 }, 'out');
  K('#win', { s: [[T0 + 1.5, 1, 'hold'], [OUT, 1.025, 'lin']] });
  riseWords('#capG1', T0 + 1.0, { dy: 20, blur: 8 });

  // 레일의 두 칸
  const win = $('#win'), main = $('.main');
  const mid = (n) => n.offsetTop + n.offsetHeight / 2;
  $('#call1').style.top = (mid($('#rHome')) - 37) + 'px';
  $('#call2').style.top = (mid($('#rCtx')) - 37) + 'px';
  const C1 = T0 + 1.9, C2 = T0 + 3.2, COFF = T0 + 5.6;
  fade('#winDim', C1 - 0.1, 0.5, 1, 0);
  K('#rHome', { '--hl': [[0, 0], [C1, 0, 'hold'], [C1 + 0.35, 1, 'out'], [COFF, 1, 'hold'], [COFF + 0.35, 0, 'soft']] });
  K('#rCtx', { '--hl': [[0, 0], [C2, 0, 'hold'], [C2 + 0.35, 1, 'out'], [COFF, 1, 'hold'], [COFF + 0.35, 0, 'soft']] });
  for (const [sel, t] of [['#call1', C1 + 0.1], ['#call2', C2 + 0.1]]) {
    tw(sel, t, 0.3, { o: 0 }, { o: 1 }, 'soft');
    tw(sel, t, 0.7, { x: -30, s: 0.9 }, { x: 0, s: 1 }, 'back');
    tw(sel, COFF, 0.35, null, { o: 0 }, 'soft');
    tw(sel, COFF, 0.35, null, { x: -16 }, 'in');
  }
  fade('#winDim', COFF, 0.45, 0);
  leave('#capG1', COFF - 0.15, { dy: -12 });
  riseWords('#capG2', COFF + 0.45, { dy: 20, blur: 8 });

  // 손이 [앱] 으로 간다
  const apps = $('#rApps');
  const ax = win.offsetLeft + apps.offsetLeft + apps.offsetWidth / 2 + 4;
  const ay = win.offsetTop + apps.offsetTop + apps.offsetHeight / 2 - 4;
  const HX = 9, HY = 6;   // 화살 끝
  const M0 = COFF + 0.35, M1 = M0 + 1.15, CLICK = M1 + 0.12;
  tw('#cursor', M0, 0.3, { o: 0 }, { o: 1 }, 'soft');
  K('#cursor', {
    x: [[M0, 1130 - HX, 'hold'], [M1, ax - HX, 'inOut']],
    y: [[M0, 610 - HY, 'hold'], [M1, ay - HY, 'inOut']],
    s: [[CLICK - 0.02, 1, 'hold'], [CLICK + 0.09, 0.84, 'out'], [CLICK + 0.3, 1, 'out']],
  });
  K('#click', { x: [[0, ax]], y: [[0, ay]], o: [[0, 0]] });
  tw('#click', CLICK + 0.05, 0.6, { s: 0.25, o: 0.95 }, { s: 1, o: 0 }, 'out');
  K(apps, { '--hl': [[0, 0], [CLICK + 0.05, 0, 'hold'], [CLICK + 0.3, 1, 'out'], [OUT, 1, 'hold']] });

  // 앱 찾기가 핀다
  const OPEN = CLICK + 0.22;
  tw('#pad', OPEN, 0.4, { o: 0 }, { o: 1 }, 'soft');
  K('.home', { b: [[OPEN, 0, 'hold'], [OPEN + 0.45, 26, 'soft']] });
  tw('#padField', OPEN + 0.05, 0.4, { o: 0 }, { o: 1 }, 'soft');
  tw('#padField', OPEN + 0.05, 0.8, { y: -22, s: 0.96 }, { y: 0, s: 1 }, 'out');
  pop($$('.pad-it'), OPEN + 0.18, { stagger: 0.055, dur: 0.75, from: 0.72, dy: 26 });
  tw('#cursor', OPEN + 0.9, 0.5, null, { o: 0 }, 'soft');

  tw('#win', OUT, 0.6, null, { o: 0 }, 'soft');
  K('#win', { b: [[OUT, 0, 'hold'], [OUT + 0.6, 10, 'soft']] });
  leave('#capG2', OUT - 0.05, { dy: -12 });
}

// ════════════════════════════════════════════════════════════════════════════
//  H · 맺음 (61.9 → 끝)
// ════════════════════════════════════════════════════════════════════════════
const END = 66.4;
{
  const T0 = 61.9;
  show('#sH', T0, END + 1);
  tw('#logoH', T0, 0.5, { o: 0 }, { o: 1 }, 'soft');
  tw('#logoH', T0, 1.0, { y: 18, s: 0.9 }, { y: 0, s: 1 }, 'back');
  K('#logoRingH', { o: [[0, 0]] });
  tw('#logoRingH', T0 + 0.25, 1.4, { s: 1, o: 0.9 }, { s: 3.4, o: 0 }, 'out');
  riseWords('#hl5', T0 + 0.45);
  K('#sH', { s: [[T0, 1, 'hold'], [END, 1.03, 'lin']] });
}

// ── 내보내기 · 미리 보기 ─────────────────────────────────────────────────────
const DURATION = END;
seek(0);
const render = new URLSearchParams(location.search).has('render');
if (render) document.documentElement.classList.add('render');
function fit() {
  const s = render ? 1 : Math.min(innerWidth / 1920, (innerHeight - 34) / 1080);
  $('#fit').style.transform = `scale(${s})`;
}
fit(); addEventListener('resize', fit);
window.__film = { seek, duration: DURATION, engineDuration: engine.DURATION };

if (!render) {
  let t = Number(new URLSearchParams(location.search).get('t') || 0), playing = !new URLSearchParams(location.search).has('t'), last = performance.now();
  const bar = $('#hudBar'), lab = $('#hudT');
  const paint = () => { seek(t); bar.value = String(Math.round((t / DURATION) * 1000)); lab.textContent = t.toFixed(2) + ' / ' + DURATION.toFixed(1); };
  const loop = (now) => { if (playing) { t += (now - last) / 1000; if (t > DURATION) t = 0; paint(); } last = now; requestAnimationFrame(loop); };
  bar.oninput = () => { playing = false; t = (Number(bar.value) / 1000) * DURATION; paint(); };
  $('#hudPlay').onclick = () => { playing = !playing; };
  paint(); requestAnimationFrame(loop);
}

// 라이블리 둘러보기 영상(#5598, 2026-11-22 v4).
//   여는 장(라이블리가 무엇인지) → 이렇게 돌아가요(구조도: 세션이 프로젝트에 모이고, 외부 앱 · 프로젝트의 파일이 자료가 되고,
//   AI가 지식으로 정리하고, 다음 일에 다시 읽는다) → ① AI 세션 → ② 프로젝트(일마다 따로 · 화면 안 · 함께 일하기)
//   → ③ 자료 → ④ 지식 → 누구에게 보일까요(번호 없음) → 맺음. ①~④ 동안 위쪽 차례 띠가 지금 어디인지 짚는다.
//  그리는 법은 engine.js, 생김새는 share.css + intro.css.
import * as engine from './engine.js';
const { K, F, tw, seek, rise, leave, pop, fade } = engine;

const $ = (s) => document.querySelector(s);
const A = (arr) => arr.map((x) => (typeof x === 'string' ? $(x) : x));
await document.fonts.ready;
await Promise.all(['400', '500', '600', '700', '800'].map((w) => document.fonts.load(`${w} 16px Pretendard`, '가A')));

const CAPS = [];
const cap = (id, t0, t1) => { CAPS.push({ id: id.slice(1), t0, t1, text: $(id).textContent }); rise(id, t0, { dur: 0.7, dy: 16, blur: 6 }); leave(id, t1, { dur: 0.4, dy: -10, blur: 4 }); };
const appear = (el, t, dy = 10) => { tw(el, t, 0.45, { o: 0 }, { o: 1 }, 'soft'); tw(el, t, 0.6, { y: dy }, { y: 0 }, 'out'); };
const scene = (sel, t0, t1) => { tw(sel, t0, 0.45, { o: 0 }, { o: 1 }, 'soft'); tw(sel, t1, 0.5, null, { o: 0 }, 'soft'); };
const up = (sel, t, o = {}) => rise(sel, t, { dur: 0.8, dy: 22, blur: 6, ...o });
/** (dx,dy) 만큼 떨어진 곳에서 날아와 제자리에 앉는다 — 파일이 다른 곳으로 «들어가는» 움직임. */
const fly = (sel, t, dx, dy, dur = 1.1) => {
  tw(sel, t, 0.3, { o: 0 }, { o: 1 }, 'soft');
  tw(sel, t, dur, { x: dx, y: dy, s: 0.92 }, { x: 0, y: 0, s: 1 }, 'inOut');
};
/** 한 번 톡 — 눈길을 끈다. */
const tap = (sel, t, s = 1.05) => { tw(sel, t, 0.22, null, { s }, 'out'); tw(sel, t + 0.22, 0.4, null, { s: 1 }, 'back'); };
/** 점이 길을 따라 간다. */
const travel = (dot, path, t0, t1) => {
  const p = $(path);
  fade(dot, t0 - 0.05, 0.2, 1, 0); fade(dot, t1, 0.25, 0);
  F(dot, [[t0, 0, 'hold'], [t1, 1, 'inOut']], (el, v) => { const pt = p.getPointAtLength(p.getTotalLength() * v); el.setAttribute('cx', pt.x.toFixed(1)); el.setAttribute('cy', pt.y.toFixed(1)); });
};

const T = { flow: 6.8 };
T.s1 = T.flow + 27.0;
T.s2 = T.s1 + 11.8;
T.co = T.s2 + 21.8;         // ② 안의 «함께 일하기»
T.s3 = T.co + 20.8;
T.s4 = T.s3 + 16.4;
T.s5 = T.s4 + 14.6;
T.end = T.s5 + 29.4;
T.END = T.end + 4.2;

// ── 여는 장 ──
scene('#sc0', 0, T.flow - 0.7);
pop('#o-dot', 0.3, { dur: 0.8, from: 0.4, dy: 0 });
rise('#o-t', 0.8, { dur: 1.0, dy: 30, blur: 12 });
rise('#o-s', 1.6, { dur: 0.9, dy: 20, blur: 8 });
rise('#o-s2', 3.0, { dur: 0.9, dy: 16, blur: 8 });

// ── 이렇게 돌아가요 — 카드 넷이 하나씩 켜지고(지금 말하는 카드만 또렷), 지식에서 세션으로 돌아가는 고리 ──
{
  const t = T.flow;
  scene('#scF', t, T.s1 - 0.6);
  rise('#f-h', t + 0.1, { dur: 0.9, dy: 24, blur: 8 });
  const beats = [[0.6, 5.0], [5.3, 9.9], [10.2, 15.0], [15.3, 19.6]];
  const capIds = ['#cf1', '#cf2', '#cf3', '#cf4'];
  beats.forEach(([a, b], i) => {
    const n = i + 1;
    if (n > 1) { fade(`#f-a${n - 1}`, t + a - 0.2, 0.4, 1, 0); tw(`#f-a${n - 1}`, t + a - 0.2, 0.5, { x: -14 }, { x: 0 }, 'out'); }
    rise(`#f-${n}`, t + a, { dur: 0.9, dy: 34, blur: 8 });
    tap(`#f-${n} .bic`, t + a + 0.7, 1.12);
    if (n === 2) pop('#f-ab', t + a + 1.4, { dur: 0.6, from: 0.4, dy: 0 });
    cap(capIds[i], t + a, t + b);
    // 다음 카드가 켜지면 앞 카드는 한 걸음 물러난다
    if (n < 4) tw(`#f-${n}`, t + beats[i + 1][0], 0.4, null, { o: 0.42 }, 'soft');
  });
  // 고리 — 모두 다시 또렷해지고, 지식에서 세션으로 화살표가 그려진다
  tw(A(['#f-1', '#f-2', '#f-3']), t + 19.9, 0.5, null, { o: 1 }, 'soft');
  fade('#f-loop', t + 20.1, 0.01, 1, 0);
  F('#f-loop', [[t + 20.1, 1, 'hold'], [t + 21.6, 0, 'inOut']], (el, v) => { el.style.strokeDashoffset = String(v); });
  fade('#f-head', t + 21.5, 0.3, 1, 0);
  pop('#f-ln', t + 21.0, { dur: 0.6 });
  cap('#cf5', t + 19.9, t + 24.0);
  cap('#cf6', t + 24.3, t + 26.4);
}

// ── 차례 띠 — ①~④ ──
{
  tw('#toc', T.s1, 0.5, { o: 0 }, { o: 1 }, 'soft');
  tw('#toc', T.s5 - 0.6, 0.5, null, { o: 0 }, 'soft');
  const at = [T.s1, T.s2, T.s3, T.s4, T.s5];
  for (let i = 1; i <= 4; i++) {
    const on = `#toc${i} .on`;
    tw(on, at[i - 1] + 0.1, 0.4, { o: 0 }, { o: 1 }, 'soft');
    if (i < 4) tw(on, at[i] + 0.1, 0.4, null, { o: 0 }, 'soft');
  }
}

// ── ① AI 세션 = 대화창 하나 ──
{
  const t = T.s1;
  scene('#sc1', t, T.s2 - 0.6);
  rise('#s1-app', t + 0.3, { dur: 0.9, dy: 30, blur: 8 });
  appear('#s1-m1', t + 1.0); appear('#s1-m2', t + 1.6); appear('#s1-m3', t + 2.3); appear('#s1-m4', t + 2.9);
  pop('#s1-frame', t + 3.6, { dur: 0.7, from: 0.97, dy: 0 });
  cap('#c1a', t + 0.3, t + 5.0);
  tap('#s1-si2', t + 5.4, 1.04); tap('#s1-si3', t + 5.6, 1.04);
  cap('#c1b', t + 5.3, t + 10.6);
}

// ── ② 프로젝트 ──
{
  const t = T.s2;
  scene('#sc2', t, T.s3 - 0.6);
  // 알아서 생긴다 — 세션 하나가 가운데 뜨고, 그 둘레에 프로젝트가 저절로 생긴다
  up('#bn-s', t + 0.3, { dy: 30 });
  tw('#bn-s', t + 1.5, 0.9, { x: 230 }, { x: 0 }, 'inOut');
  pop('#bn-box', t + 1.7, { dur: 0.9, from: 0.9, dy: 0 });
  up('#bn-h', t + 2.0);
  pop('#bn-auto', t + 2.7, { dur: 0.6 });
  tap('#bn-auto', t + 3.6, 1.08);
  cap('#c2n1', t + 0.3, t + 5.2);
  // 그 일의 세션 · 파일이 들어온다
  cap('#c2n2', t + 5.5, t + 10.4);
  fly('#bn-r1', t + 6.0, 0, 240);
  fly('#bn-r2', t + 6.6, 0, 240);
  leave('#s2-bn', t + 10.6);
  // 일마다 따로
  up(A(['#s2-c1', '#s2-c2', '#s2-c3']), t + 11.0, { stagger: 0.25, dy: 30 });
  cap('#c2a', t + 11.0, t + 15.6);
  leave(A(['#s2-c1', '#s2-c2', '#s2-c3']), t + 15.8, { stagger: 0.08 });
  // 한 프로젝트 화면 안
  rise('#s2-page', t + 16.2, { dur: 0.9, dy: 30, blur: 8 });
  cap('#c2b', t + 16.1, t + 21.0);
  leave('#s2-page', t + 21.2);

  // 함께 일하기
  const c = T.co;
  pop('#co-pbg', c + 0.1, { dur: 0.8, from: 0.96, dy: 0 });
  up('#co-ph', c + 0.3);
  fade('#co-mem', c + 0.4, 0.4, 1, 0);
  up(A(['#co-t1', '#co-t2']), c + 0.6, { stagger: 0.2 });
  up('#co-a', c + 0.6, { dy: 30 });
  cap('#c2d', c + 0.3, c + 4.6);
  pop('#co-inv', c + 1.3, { dur: 0.6 }); leave('#co-inv', c + 3.4, { dy: -8 });
  pop('#co-min', c + 2.2, { dur: 0.6, from: 0.4, dy: 0 });
  cap('#c2e', c + 4.9, c + 10.4);
  up('#co-b', c + 5.2, { dy: 30 });
  fade(A(['#co-l1', '#co-l2']), c + 6.0, 0.4, 1, 0);
  travel('#co-d1', '#co-l1', c + 6.4, c + 7.7);
  tap('#co-t1', c + 7.7, 1.03);
  travel('#co-d2', '#co-l2', c + 7.9, c + 9.2);
  appear('#co-bm', c + 9.3);
  cap('#c2f', c + 10.7, c + 15.0);
  fade('#co-wall', c + 11.0, 0.5, 1, 0);
  pop('#co-lock', c + 11.3, { dur: 0.6 });
  cap('#c2g', c + 15.3, c + 20.2);
  pop('#co-sinv', c + 15.6, { dur: 0.6 });
  pop('#co-ainv', c + 16.6, { dur: 0.6, from: 0.4, dy: 0 });
}

// ── ③ 자료 ──
{
  const t = T.s3;
  scene('#sc3', t, T.s4 - 0.6);
  up('#s3-gl1', t + 0.3);
  up(A(['#s3-t1', '#s3-t2', '#s3-t3']), t + 0.4, { stagger: 0.15, dy: 26 });
  pop('#s3-box', t + 1.2, { dur: 0.8, from: 0.97, dy: 0 });
  up('#s3-bh', t + 1.4);
  // 타일 가운데 → 칩 가운데
  const tileC = [298, 518, 738], chipX = [236, 528, 820, 1112, 1404], chipC = chipX.map((x) => x + 139), chipY = 785;
  [0, 1, 2].forEach((i) => fly(`#s3-c${i + 1}`, t + 2.2 + i * 0.3, tileC[i] - chipC[i], 323 - chipY));
  cap('#c3a', t + 0.3, t + 5.4);
  up('#s3-gl2', t + 5.7);
  up('#s3-p', t + 5.9, { dy: 26 });
  fly('#s3-c4', t + 7.4, 1390 - chipC[3], 352 - chipY, 1.2);
  fly('#s3-c5', t + 7.9, 1390 - chipC[4], 428 - chipY, 1.2);
  cap('#c3b', t + 5.7, t + 11.0);
  cap('#c3c', t + 11.3, t + 15.6);
  [1, 2, 3, 4, 5].forEach((i) => tap(`#s3-c${i}`, t + 11.8 + i * 0.12, 1.06));
}

// ── ④ 지식 ──
{
  const t = T.s4;
  scene('#sc4', t, T.s5 - 0.6);
  up(A(['#s4-l1', '#s4-r1', '#s4-r2', '#s4-r3']), t + 0.4, { stagger: 0.22, dy: 24 });
  fade('#s4-arrow', t + 1.6, 0.5, 1, 0);
  rise('#s4-l2', t + 2.0, { dur: 0.6, dy: 12, blur: 4 });
  pop('#s4-k', t + 2.2, { dur: 0.8 });
  cap('#c4a', t + 0.3, t + 5.0);
  cap('#c4b', t + 5.3, t + 9.4);
  tap('#s4-src', t + 5.6, 1.04);
  cap('#c4c', t + 9.7, t + 13.8);
}

// ── 누구에게 보일까요 ──
{
  const t = T.s5;
  scene('#sc5', t, T.end - 0.6);
  rise('#s5-h', t + 0.2, { dur: 0.9, dy: 24, blur: 8 });
  // 닫힌 프로젝트
  pop('#v-pbg', t + 0.5, { dur: 0.8, from: 0.96, dy: 0 });
  up('#v-ph', t + 0.7);
  up(A(['#v-s1', '#v-s2', '#v-f1', '#v-f2']), t + 0.9, { stagger: 0.15 });
  pop('#v-lock', t + 1.6, { dur: 0.6 });
  up('#v-in', t + 2.2);
  cap('#c5a', t + 0.4, t + 5.4);
  cap('#c5b', t + 5.7, t + 10.2);
  up('#v-out', t + 6.0);
  // 파일은 자료로 — 열린 곳
  cap('#c5c', t + 10.5, t + 15.6);
  pop('#v-rbg', t + 10.7, { dur: 0.8, from: 0.96, dy: 0 });
  up('#v-rh', t + 10.9);
  pop('#v-rg', t + 11.3, { dur: 0.6 });
  fly('#v-d1', t + 12.0, 540 - 1229, 586 - 433, 1.3);
  fly('#v-d2', t + 12.5, 540 - 1529, 674 - 433, 1.3);
  cap('#c5d', t + 15.9, t + 20.2);
  pop('#v-kbg', t + 16.1, { dur: 0.8, from: 0.96, dy: 0 });
  up('#v-kh', t + 16.3);
  pop('#v-kg', t + 16.6, { dur: 0.6 });
  up('#v-k1', t + 16.8);
  up('#v-all', t + 17.3);
  // 정리 네 줄
  tw('#s5-dia', t + 20.7, 0.5, null, { o: 0 }, 'soft');
  rise(A(['#s5-r1', '#s5-r2', '#s5-r3', '#s5-r4']), t + 21.2, { dur: 0.9, dy: 30, blur: 8, stagger: 0.35 });
  cap('#c5e', t + 22.6, t + 28.6);
}

// ── 맺음 ──
tw('#sc9', T.end, 0.5, { o: 0 }, { o: 1 }, 'soft');
rise('#e-logo', T.end, { dur: 0.9, dy: 22, blur: 8 });
rise('#e-line', T.end + 0.4, { dur: 0.9, dy: 18, blur: 8 });
K('#sc9', { o: [[T.END, 1, 'hold']] });

window.__caps = CAPS;
const cs = [...CAPS].sort((a, b) => a.t0 - b.t0);
for (let i = 1; i < cs.length; i++) if (cs[i].t0 < cs[i - 1].t1 - 0.05) throw new Error(`자막이 겹친다: ${cs[i - 1].id} → ${cs[i].id}`);

// ── 내보내기 · 미리 보기 ─────────────────────────────────────────────────────
const DURATION = T.END;
seek(0);
const qs = new URLSearchParams(location.search);
const render = qs.has('render');
if (render) document.documentElement.classList.add('render');
function fit() { const s = render ? 1 : Math.min(innerWidth / 1920, (innerHeight - 34) / 1080); $('#fit').style.transform = `scale(${s})`; }
fit(); addEventListener('resize', fit);
window.__film = { seek, duration: DURATION, engineDuration: engine.DURATION };

if (!render) {
  let t = Number(qs.get('t') || 0), playing = !qs.has('t'), last = performance.now();
  const bar = $('#hudBar'), lab = $('#hudT');
  const paint = () => { seek(t); bar.value = String(Math.round((t / DURATION) * 1000)); lab.textContent = t.toFixed(2) + ' / ' + DURATION.toFixed(1); };
  const loop = (now) => { if (playing) { t += (now - last) / 1000; if (t > DURATION) t = 0; paint(); } last = now; requestAnimationFrame(loop); };
  bar.oninput = () => { playing = false; t = (Number(bar.value) / 1000) * DURATION; paint(); };
  $('#hudPlay').onclick = () => { playing = !playing; };
  paint(); requestAnimationFrame(loop);
}

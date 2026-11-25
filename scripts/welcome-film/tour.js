// 라이블리 둘러보기 영상 — 장면과 시간표. 그리는 법은 engine.js, 둘레의 생김새는 tour.css,
//  가운데 제품 화면은 gen-tour.mjs 가 제품의 스타일시트 · DOM 으로 세운 tour-app.gen.html 이다.
//  이야기: 흐린 화면 가운데 맞이 인사 → 사이드바(워크스페이스 · 고정 앱 둘 · 최근 연 앱 · 앱 · 내 프로필) →
//          홈에서 프로젝트 · 선행을 고르고 한 줄 시키기 → 세션이 지식을 읽고 답한다 →
//          곁칸을 열어 프로젝트(이 세션의 태스크) · 자료(공유 폴더) · 웹 → [앱] 을 눌러 앱 찾기 → 맺음.
//  수집 · 증류 흐름 지도는 이 영상에서 뺐다(원준 2026-11-19) — 원리는 사용 가이드 «라이블리 동작원리»(guide.js)가 맡는다.
//  화면을 키웠다 줄였다 하지 않는다 — 창은 처음부터 끝까지 같은 자리 · 같은 크기다. 움직이는 것은 손과 화면 안의 내용뿐이다.
import * as engine from './engine.js';
const { K, F, tw, seek, rise, leave, pop, fade, type, count, typingFrames } = engine;

const $ = (s) => document.querySelector(s);
const frame = $('#app');
const loaded = (fr) => new Promise((res) => {
  const ok = () => fr.contentDocument && fr.contentDocument.readyState === 'complete' && fr.contentDocument.body && fr.contentDocument.body.childElementCount > 0;
  if (ok()) res(); else fr.addEventListener('load', () => res(), { once: true });
});
await loaded(frame);
const A = frame.contentDocument;                       // 셸
const a = (n) => { const el = A.querySelector(`[data-f="${n}"]`); if (!el) throw new Error('셸에 없는 칸: ' + n); return el; };

for (const d of [document, A]) {
  await d.fonts.ready;
  await Promise.all(['400', '500', '600', '700', '800'].map((w) => d.fonts.load(`${w} 16px Pretendard`, '가A')));
}
await Promise.all([A.fonts.load('13.5px TourMono', '가A❯●'), A.fonts.load('700 13.5px TourMono', '가A❯●')]);

// ── 자리 재기 — 화면 안의 칸이 무대의 어디인가 ───────────────────────────────
const S = 1760 / 1160, WIN = { x: 80, y: 44 };
const panes = { home: a('pHome'), sess: a('pSess') };
function showOnly(name) { for (const k in panes) panes[k].hidden = k !== name; }
function rect(el) {
  const r = el.getBoundingClientRect();
  const x = WIN.x + r.left * S, y = WIN.y + r.top * S, w = r.width * S, h = r.height * S;
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}
const ASIDE_W = 372;
showOnly('home');
a('prePop').hidden = false;
const rRow1 = rect(a('preRow1'));
a('prePop').hidden = true;
const rHome = rect(a('rHome')), rCtx = rect(a('rCtx')), rApps = rect(a('rApps'));
const rWs = rect(a('rWs')), rMe = rect(a('rMe'));
const rRecent = (() => { const h = rect(a('rHr')), r2 = rect(a('rc2')); return { x: rCtx.x, y: h.y + 6, w: rCtx.w, h: r2.y + r2.h - h.y - 6, cx: rCtx.cx, cy: (h.y + 6 + r2.y + r2.h) / 2 }; })();
const rIn = rect(a('launchIn')), rSend = rect(a('send'));
const rProj = rect(a('dProj').closest('.v2-dest')), rPre = rect(a('dPre').closest('.v2-dest'));
showOnly('sess');
const rSideBtn = rect(a('sideBtn'));
a('aside').style.width = ASIDE_W + 'px';
const rDk = { proj: rect(a('dkProj')), files: rect(a('dkFiles')), web: rect(a('dkWeb')) };
const rT2 = rect(a('t2'));
//  둘째 지시(메일)가 붙으면 터미널이 넘친다 — 넘치는 만큼 위로 민다(실제 터미널이 스크롤하듯).
const MAIL_LINES = ['m0', 'mw', 'm1', 'm2', 'm3'];
for (const n of MAIL_LINES) a(n).style.display = 'none';
const termEl = a('scroll').parentElement;
for (const n of MAIL_LINES) if (n !== 'mw') a(n).style.display = '';
const SCROLL_UP = Math.max(0, Math.ceil(a('scroll').scrollHeight - (termEl.clientHeight - 40)));
for (const n of MAIL_LINES) a(n).style.display = 'none';
const rLbox = rect(a('lbox'));            // 둘째 지시 줄들을 걷은 뒤에 잰다 — 그때 입력칸이 서는 자리
a('aside').style.width = '0px';
showOnly('home');

// ── 작은 도구 ────────────────────────────────────────────────────────────────
/** 시각마다 켜고 끈다(클래스 · hidden 처럼 값이 둘뿐인 것). steps = [[t, 0|1], …] */
function sw(el, steps, apply) {
  F(el, steps.map(([t, v]) => [t, v, 'hold']), (node, v) => { const on = v > 0.5; if (node.__sw !== on) { node.__sw = on; apply(node, on); } });
}
const CAPS = [];
const cap = (id, t0, t1) => { CAPS.push({ id: id.slice(1), t0, t1, text: $(id).textContent }); rise(id, t0, { dur: 0.7, dy: 16, blur: 6 }); leave(id, t1, { dur: 0.4, dy: -10, blur: 4 }); };
const appear = (el, t, dy = 6) => { tw(el, t, 0.45, { o: 0 }, { o: 1 }, 'soft'); tw(el, t, 0.6, { y: dy }, { y: 0 }, 'out'); };
/** 입력칸(input)에 글을 친다 — 자모가 모여 글자가 되는 차례 그대로. */
function typeValue(input, text, t0, t1, clearAt) {
  const frames = typingFrames(text);
  F(input, [[t0, 0, 'hold'], [t1, frames.length - 1, 'lin'], [clearAt, frames.length - 1, 'hold'], [clearAt + 0.001, 0, 'hold']], (node, v) => {
    const s = frames[Math.max(0, Math.min(frames.length - 1, Math.round(v)))];
    if (node.__v !== s) { node.__v = s; node.value = s; }
  });
}
/** 한 칸에 글을 여러 번 친다(바꿔 치기) — segs = [[text, t0, t1], …]. type() 를 두 번 걸면 뒤엣것이 앞엣것을 지운다. */
function typeAt(el, segs) {
  const fr = segs.map(([text]) => typingFrames(text));
  F(el, [[0, 0, 'hold'], [T.END, 1, 'lin']], (node, v, t) => {
    let s = '';
    segs.forEach(([, t0, t1], i) => { if (t >= t0) { const f = fr[i]; s = f[Math.max(0, Math.min(f.length - 1, Math.round(((t - t0) / (t1 - t0)) * (f.length - 1))))]; } });
    if (node.__txt !== s) { node.__txt = s; (node.querySelector('.tx') || node).textContent = s; }
  });
}
/** 테두리 + 말 하나를 (t0 ~ t1) 동안 짚는다. place = 'right'(오른쪽에 · 화살 왼쪽) | 'below'(아래 · 화살 위) | 'above'(위 · 화살 아래) */
function point(ringSel, tipSel, r, t0, t1, place, pad = 5, ringReuse = false) {
  const tp = $(tipSel);
  if (ringSel) {
    const el = $(ringSel);
    const set = { x: [[t0 - 0.001, r.x - pad, 'hold']], y: [[t0 - 0.001, r.y - pad, 'hold']] };
    if (!ringReuse) { set.x.unshift([0, r.x - pad]); set.y.unshift([0, r.y - pad]); }
    F(el, [[t0 - 0.001, 0, 'hold'], [t0, 1, 'hold']], (n, v) => { if (v > 0.5) { n.style.width = (r.w + pad * 2) + 'px'; n.style.height = (r.h + pad * 2) + 'px'; } });
    K(el, set);
    if (!ringReuse) K(el, { o: [[0, 0]] });
    tw(el, t0, 0.4, { o: 0 }, { o: 1 }, 'soft'); tw(el, t0, 0.5, { s: 1.06 }, { s: 1 }, 'out');
    fade(el, t1, 0.35, 0);
  }
  const W = tp.offsetWidth, H = tp.offsetHeight;
  let tx, ty, from;
  if (place === 'right') { tx = r.x + r.w + 26; ty = r.cy - H / 2; from = { x: tx - 16 }; }
  else if (place === 'below') {
    tx = Math.max(100, Math.min(1820 - W, r.cx - 60)); ty = r.y + r.h + 24; from = { y: ty - 12 };
    tp.style.setProperty('--ax', Math.max(28, Math.min(W - 28, r.cx - tx)) + 'px');
  } else {
    tx = Math.max(100, Math.min(1820 - W, r.cx - 60)); ty = r.y - H - 24; from = { y: ty + 12 };
    tp.style.setProperty('--ax', Math.max(28, Math.min(W - 28, r.cx - tx)) + 'px');
  }
  K(tp, { x: [[0, tx]], y: [[0, ty]], o: [[0, 0]] });
  tw(tp, t0 + 0.12, 0.4, { o: 0 }, { o: 1 }, 'soft');
  if (from.x !== undefined) tw(tp, t0 + 0.12, 0.6, { x: from.x }, { x: tx }, 'out');
  else tw(tp, t0 + 0.12, 0.6, { y: from.y }, { y: ty }, 'out');
  fade(tp, t1, 0.35, 0);
}

// ── 손 ──────────────────────────────────────────────────────────────────────
const HX = 8, HY = 5;                                  // 화살 끝이 그림의 어디인가
const hand = { x: [], y: [], s: [] };
let handAt = null;
function handStart(t, x, y) { hand.x.push([t, x - HX, 'hold']); hand.y.push([t, y - HY, 'hold']); handAt = { t, x, y }; tw('#cursor', t, 0.35, { o: 0 }, { o: 1 }, 'soft'); }
/** t0 에 떠나 t1 에 (x, y) 에 닿는다. */
function handTo(t0, t1, x, y) {
  hand.x.push([t0, handAt.x - HX, 'hold'], [t1, x - HX, 'inOut']);
  hand.y.push([t0, handAt.y - HY, 'hold'], [t1, y - HY, 'inOut']);
  handAt = { t: t1, x, y };
}
/** 지금 자리에서 누른다 — 손이 살짝 눌리고 물결이 퍼진다. */
let clickN = 0;
function press(t) {
  hand.s.push([t - 0.02, 1, 'hold'], [t + 0.09, 0.86, 'out'], [t + 0.3, 1, 'out']);
  const ring = $('#click').cloneNode(); ring.id = 'click' + (clickN++); $('#click').after(ring);
  K(ring, { x: [[0, handAt.x]], y: [[0, handAt.y]], o: [[0, 0]] });
  tw(ring, t + 0.03, 0.55, { s: 0.3, o: 1 }, { s: 1, o: 0 }, 'out');
}
/** (go0 ~ go1) 동안 가서 누른다. 누른 시각을 돌려준다. */
function clickAt(go0, go1, x, y) { handTo(go0, go1, x, y); press(go1 + 0.15); return go1 + 0.15; }

// ════════════════════════════════════════════════════════════════════════════
//  시간표 — 장면마다 «시작 시각» 만 정하고 나머지는 그 안에서 센다
// ════════════════════════════════════════════════════════════════════════════
const T = {
  win: 0.15, wel: [0.7, 5.9],
  side: 6.9,           // 사이드바 — 워크스페이스 · 고정 앱 둘 · 최근 연 앱 · 앱 · 내 프로필 (~25초)
  home: 35.2,          // 홈 — 프로젝트 · 선행 · 시키기 (~16.5초)
  side2: 57.85,        // 곁칸 (~21초)
  burst: 91.95,        // 무엇이든 — 여러 사람이 시킬 법한 일이 화면 가득 (~10.4초)
  apps: 102.55,        // 앱 찾기 — 그대로 맺음으로
  out: 108.05, end: 108.85, END: 113.05,
};
const PAGE_HOME2 = T.END + 10;     // 홈으로 다시 돌아오지 않는다(«자동» 컴퓨터 장면은 뺐다, 원준 2026-11-19) — 영상 밖이라 걸리지 않는다

// ── 맞이 — 창이 흐린 채로 뜨고, 가운데에 인사 → 초점이 맞으며 화면으로 ──
{
  const [w0, w1] = T.wel;
  tw('#win', T.win, 0.9, { o: 0 }, { o: 1 }, 'soft');
  tw('#win', T.win, 1.6, { y: 30, s: 0.975, b: 18 }, { y: 0, s: 0.985, b: 18 }, 'out');
  fade('#welVeil', T.win, 0.9, 1, 0);
  pop('#welDot', w0, { dur: 0.8, from: 0.5, dy: 0 });
  rise('#welT', w0 + 0.25, { dur: 1.2, dy: 34, blur: 14 });
  rise('#welS', w0 + 1.9, { dur: 1.0, dy: 22, blur: 10 });
  CAPS.push({ id: 'welT', t0: w0 + 0.25, t1: w0 + 1.8, text: $('#welT').textContent + '.' }, { id: 'welS', t0: w0 + 1.9, t1: w1, text: $('#welS').textContent });
  leave(['#welDot', '#welT', '#welS'], w1, { dur: 0.55, dy: -16, blur: 10, stagger: 0.05 });
  fade('#welVeil', w1 + 0.1, 0.8, 0);
  tw('#win', w1 + 0.1, 1.0, null, { b: 0, s: 1 }, 'soft');           // 초점이 맞는다
}

// ── 사이드바 — 위에서 아래로 ──
{
  const t = T.side;
  cap('#s0', t, t + 2.6);
  fade('#veil', t + 2.8, 0.5, 1, 0);
  const s1 = [t + 3.0, t + 7.4];
  cap('#s1', s1[0], s1[1]);
  point('#ringWs', '#tipWs', rWs, s1[0] + 0.2, s1[1], 'right', 4);
  const s2 = [s1[1] + 0.4, s1[1] + 6.0];
  cap('#s2', s2[0], s2[1]);
  point('#ringHome', '#tipHome', rHome, s2[0] + 0.3, s2[1], 'right');
  point('#ringCtx', '#tipCtx', rCtx, s2[0] + 1.7, s2[1], 'right');
  //  최근 연 앱 — 처음엔 비어 있다. 앱을 열면 이렇게 쌓인다는 것만 잠깐 보이고 걷는다.
  const s3 = [s2[1] + 0.4, s2[1] + 5.2];
  cap('#s3', s3[0], s3[1]);
  for (const n of ['rc1', 'rc2']) K(a(n), { o: [[0, 0]] });
  pop(a('rc1'), s3[0] + 0.5, { dur: 0.55, from: 0.7, dy: 0 });
  pop(a('rc2'), s3[0] + 0.85, { dur: 0.55, from: 0.7, dy: 0 });
  point('#ringRecent', '#tipRecent', rRecent, s3[0] + 1.1, s3[1], 'right', 4);
  fade([a('rc1'), a('rc2')], s3[1], 0.4, 0);
  const s4 = [s3[1] + 0.4, s3[1] + 5.8];
  cap('#s4', s4[0], s4[1]);
  point('#ringApps', '#tipApps', rApps, s4[0] + 0.3, s4[1], 'right');
  point('#ringMe', '#tipMe', rMe, s4[0] + 1.8, s4[1], 'right', 4);
  fade('#veil', s4[1], 0.45, 0);
  cap('#h0', s4[1] + 0.4, T.home - 0.2);
  handStart(s4[1] + 0.9, 1240, 800);
  if (s4[1] + 0.4 > T.home - 3) throw new Error('사이드바가 홈 시각을 넘는다: ' + s4[1].toFixed(2));
}

// ── 홈 — 프로젝트 · 선행을 고르고 한 줄 시키기 ──
const PAGE_HOME = T.home;
const ASK = '지난주 회의에서 정한 대로 제안서 고쳐 줘';
let PAGE_SESS, CLICK_IN;
{
  // 프로젝트 — 비워 둬도 된다(시킨 말로 이름이 지어져 저절로 생긴다)
  const c6a = [PAGE_HOME + 0.3, PAGE_HOME + 5.0];
  cap('#c6a', c6a[0], c6a[1]);
  handTo(PAGE_HOME + 0.4, PAGE_HOME + 1.2, rProj.x + 300, rProj.y + rProj.h + 150);
  point('#ringProj', '#tipProj', rProj, PAGE_HOME + 0.6, c6a[1] - 0.15, 'below', 4);
  // 선행 — 몇 글자 치면 목록이 뜨고, 거기서 고른다
  const c6b = [c6a[1] + 0.45, c6a[1] + 6.4];
  cap('#c6b', c6b[0], c6b[1]);
  const qIn = clickAt(c6b[0] + 0.1, c6b[0] + 0.8, rPre.x + 200, rPre.cy + 2);
  typeValue(a('dPre'), '영업', qIn + 0.25, qIn + 0.75, qIn + 2.05);
  const pick = clickAt(qIn + 1.0, qIn + 1.75, rRow1.x + 120, rRow1.cy + 2);
  sw(a('prePop'), [[0, 0], [qIn + 0.3, 1], [pick + 0.08, 0]], (n, on) => { n.hidden = !on; });
  tw(a('prePop'), qIn + 0.3, 0.2, { o: 0 }, { o: 1 }, 'soft');
  sw(a('preRow1'), [[0, 0], [qIn + 1.6, 1], [pick + 0.08, 0]], (n, on) => n.classList.toggle('tf-hov', on));
  sw(a('dPre'), [[0, 0], [pick + 0.08, 1], [PAGE_HOME2, 0]], (n, on) => { n.style.display = on ? 'none' : ''; });
  sw(a('preChip'), [[0, 0], [pick + 0.08, 1], [PAGE_HOME2, 0]], (n, on) => { n.style.display = on ? '' : 'none'; });
  handTo(pick + 0.3, pick + 1.0, rPre.x + 330, rPre.y + rPre.h + 150);
  point('#ringPre', '#tipPre', rPre, pick + 0.3, c6b[1] - 0.15, 'below', 4);
  // 시키기
  const c6 = [c6b[1] + 0.45, c6b[1] + 6.4];
  cap('#c6', c6[0], c6[1]);
  CLICK_IN = clickAt(c6[0] + 0.1, c6[0] + 0.8, rIn.x + 150, rIn.y + 30);
  const ty = [CLICK_IN + 0.4, CLICK_IN + 3.05];
  handTo(CLICK_IN + 0.3, ty[0] + 0.5, rIn.x + 700, rIn.y + 46);   // 치는 글을 가리지 않게 비켜 선다
  sw(a('launchPh'), [[0, 1], [ty[0], 0], [PAGE_HOME2, 1]], (n, on) => { n.style.display = on ? '' : 'none'; });
  type(a('launchIn'), ASK, ty[0], ty[1], { clearAt: PAGE_HOME2 });
  const SEND = clickAt(ty[1] + 0.25, ty[1] + 0.95, rSend.cx + 2, rSend.cy + 2);
  K(a('send'), { s: [[SEND - 0.02, 1, 'hold'], [SEND + 0.08, 0.95, 'out'], [SEND + 0.28, 1, 'out']] });
  PAGE_SESS = SEND + 0.12;
  //  막대 — 칸을 누른 뒤부터 보인다. 치는 동안은 켜져 있고, 쉴 때만 깜빡인다.
  F(a('caret'), [[0, 0, 'hold'], [CLICK_IN + 0.05, 1, 'hold'], [PAGE_SESS, 0, 'hold']], (n, v, t) => {
    const typing = t >= ty[0] && t <= ty[1] + 0.25;
    n.style.opacity = v > 0.5 && (typing || ((t - CLICK_IN) % 1.06) < 0.58) ? '1' : '0';
  });
}

// ── 세션 — 지식을 읽고 답한다 ──
{
  const t = PAGE_SESS;
  handTo(t + 0.5, t + 1.5, 1300, 820);
  tw(panes.sess, t, 0.3, { o: 0 }, { o: 1 }, 'soft');
  const line = (n, at) => { K(a(n), { o: [[0, 0]] }); appear(a(n), at, 4); };
  sw(a('lw'), [[0, 0], [t + 0.5, 1], [t + 1.7, 0]], (n, on) => { n.style.display = on ? '' : 'none'; });
  const read = t + 1.7;
  line('l1', read); line('l2', read + 0.3); line('l3', read + 0.5); line('l4', read + 0.7);
  cap('#c7', read - 0.1, read + 5.2);
  const ans = read + 2.2;
  line('l5', ans); line('l6', ans + 0.45); line('l7', ans + 0.8); line('l8', ans + 1.15); line('l9', ans + 1.7); line('lbox', ans + 2.0);
}

// ── 곁칸 — 프로젝트 · 자료 · 웹 ──
{
  const open = clickAt(T.side2, T.side2 + 0.9, rSideBtn.cx, rSideBtn.cy);
  sw(a('sideBtn'), [[0, 0], [open + 0.05, 1]], (n, on) => n.classList.toggle('on', on));
  K(a('aside'), { w: [[0, 0], [open + 0.05, 0, 'hold'], [open + 0.65, ASIDE_W, 'out']] });
  const c9 = [open + 0.3, open + 3.6];
  cap('#c9', c9[0], c9[1]);
  handTo(open + 0.4, open + 1.3, rDk.proj.cx - 30, rDk.proj.y + rDk.proj.h + 120);

  //  탭 바꾸기 — 독의 칸이 눌리면 그 칸만 보인다
  const tabs = { proj: [a('dkProj'), a('aProj')], files: [a('dkFiles'), a('aFiles')], web: [a('dkWeb'), a('aWeb')] };
  const showTab = (steps) => {
    for (const k in tabs) {
      const st = steps.map(([t, on]) => [t, on === k ? 1 : 0]);
      sw(tabs[k][0], st, (n, on) => n.classList.toggle('on', on));
      sw(tabs[k][1], st, (n, on) => { n.hidden = !on; });
    }
  };

  // ① 프로젝트 — 이 세션의 태스크가 하나씩 끝난다
  const c10 = [c9[1] + 0.4, c9[1] + 5.6];
  cap('#c10', c10[0], c10[1]);
  point('#ringDock', '#tipDkProj', rDk.proj, c10[0] + 0.1, c10[1] - 0.2, 'below', 3);
  const DONE2 = c10[0] + 2.0;
  sw(a('t2'), [[0, 0], [DONE2, 1]], (n, on) => { n.classList.toggle('now', !on); n.classList.toggle('done', on); });
  sw(a('t2St'), [[0, 0], [DONE2, 1]], (n, on) => { n.className = 'pn-tk-st ' + (on ? 'done' : 'doing'); });
  sw(a('t2Meta'), [[0, 0], [DONE2, 1]], (n, on) => { n.className = on ? 'pp-mute' : 'pp-now'; n.textContent = on ? '끝냄' : '지금 하는 일'; });
  sw(a('t3'), [[0, 0], [DONE2 + 0.5, 1]], (n, on) => n.classList.toggle('now', on));
  sw(a('t3St'), [[0, 0], [DONE2 + 0.5, 1]], (n, on) => { n.className = 'pn-tk-st ' + (on ? 'doing' : 'todo'); });
  sw(a('t3Meta'), [[0, 0], [DONE2 + 0.5, 1]], (n, on) => { n.className = on ? 'pp-now' : 'pp-mute'; n.textContent = on ? '지금 하는 일' : '다음 차례'; });
  sw(a('tkCount'), [[0, 0], [DONE2, 1]], (n, on) => { n.textContent = on ? '2/3 끝냄' : '1/3 끝냄'; });
  F(a('tkBar'), [[0, 33.3, 'hold'], [DONE2, 33.3, 'hold'], [DONE2 + 0.5, 66.7, 'out']], (n, v) => { n.style.width = v.toFixed(2) + '%'; });
  handTo(c10[0] + 0.6, DONE2 - 0.3, rT2.x + 40, rT2.cy + 6);
  handTo(DONE2 + 0.6, DONE2 + 1.4, rT2.x + 220, rT2.cy + 160);

  // ② 자료 — 프로젝트 공유 폴더, 방금 만든 파일이 올라온다
  const FILES = clickAt(c10[1] - 0.3, c10[1] + 0.45, rDk.files.cx, rDk.files.cy);
  const c11 = [FILES + 0.15, FILES + 4.8];
  cap('#c11', c11[0], c11[1]);
  point('#ringDock', '#tipDkFiles', rDk.files, FILES + 0.1, c11[1] - 0.2, 'below', 3, true);
  K(a('f4'), { o: [[0, 0]] });
  pop(a('f4'), FILES + 1.4, { dur: 0.55, from: 0.92, dy: -8 });
  handTo(FILES + 0.4, FILES + 1.2, rDk.files.cx - 120, rDk.files.cy + 260);

  // ③ 웹 — AI 가 페이지를 읽고, 시키면 메일도 써서 보낸다
  const WEB = clickAt(c11[1] - 0.2, c11[1] + 0.5, rDk.web.cx, rDk.web.cy);
  const c12 = [WEB + 0.15, WEB + 4.6];
  cap('#c12', c12[0], c12[1]);
  point('#ringDock', '#tipDkWeb', rDk.web, WEB + 0.1, c12[1] - 0.2, 'below', 3, true);
  tw(a('page'), WEB + 1.75, 0.45, { o: 0 }, { o: 1 }, 'soft');
  appear(a('webAi'), WEB + 2.6);
  handTo(WEB + 0.4, WEB + 1.3, rDk.web.cx + 260, rDk.web.cy + 420);

  //  세션 입력칸에 둘째 지시
  const CL = clickAt(WEB + 4.9, WEB + 5.6, rLbox.x + 120, rLbox.cy + 2);
  const c14 = [CL + 0.1, CL + 3.4];
  cap('#c14', c14[0], c14[1]);
  const ASK2 = '김 팀장님께 제안서_v4 메일로 보내 줘';
  const SUB = CL + 2.75;
  type(a('lbox'), ASK2, CL + 0.35, CL + 2.35, { clearAt: SUB });
  handTo(CL + 0.3, CL + 1.0, rLbox.x + 640, rLbox.cy - 30);
  F(a('bcaret'), [[0, 0, 'hold'], [CL + 0.05, 1, 'hold'], [SUB, 0, 'hold']], (n, v, t) => {
    const typing = t >= CL + 0.35 && t <= CL + 2.6;
    n.style.opacity = v > 0.5 && (typing || ((t - CL) % 1.06) < 0.58) ? '1' : '0';
  });
  const showLine = (n, at, hideAt) => {
    sw(a(n), hideAt ? [[0, 0], [at, 1], [hideAt, 0]] : [[0, 0], [at, 1]], (node, on) => { node.style.display = on ? '' : 'none'; });
    appear(a(n), at, 4);
  };
  const WM = SUB + 0.5;
  showLine('m0', SUB);
  showLine('mw', SUB + 0.3, WM + 6.6);
  K(a('scroll'), { y: [[0, 0], [SUB, 0, 'hold'], [SUB + 0.5, -SCROLL_UP, 'out']] });

  //  웹 칸 — 주소를 바꾸고 메일 쓰기
  const c15 = [WM + 0.9, WM + 8.3];
  cap('#c15', c15[0], c15[1]);
  typeAt(a('url'), [['example.com/pricing', WEB + 0.5, WEB + 1.5], ['mail.example.com', WM, WM + 0.8]]);
  sw(a('page'), [[0, 0], [WM + 1.0, 1]], (n, on) => { n.style.display = on ? 'none' : ''; });
  sw(a('webAi'), [[0, 0], [WM + 1.0, 1]], (n, on) => { n.style.display = on ? 'none' : ''; });
  K(a('mail'), { o: [[0, 0]] });
  tw(a('mail'), WM + 1.0, 0.4, { o: 0 }, { o: 1 }, 'soft');
  type(a('mTo'), 'minsu.kim@example.com', WM + 1.4, WM + 2.3);
  type(a('mSub'), '수정한 제안서 보내드립니다', WM + 2.5, WM + 3.4);
  type(a('mBody'), '김 팀장님, 안녕하세요.\n지난주 회의에서 정한 내용을 반영한 제안서를 보내드립니다.\n검토 부탁드립니다.', WM + 3.6, WM + 5.6);
  K(a('mAtt'), { o: [[0, 0]] });
  pop(a('mAtt'), WM + 5.8, { dur: 0.5, from: 0.85, dy: 0 });
  const SENT = WM + 6.5;
  K(a('mSend'), { s: [[SENT - 0.02, 1, 'hold'], [SENT + 0.08, 0.93, 'out'], [SENT + 0.28, 1, 'out']] });
  appear(a('mSent'), SENT + 0.2, 0);
  showLine('m1', SENT + 0.45); showLine('m2', SENT + 0.7); showLine('m3', SENT + 0.95);

  showTab([[0, 'proj'], [FILES + 0.05, 'files'], [WEB + 0.05, 'web']]);
}

// ── 무엇이든 — 영업 · 개발 · 재무 · 디자인 … 여러 사람이 시킬 법한 일이 빠른 박자로 화면 가득 흩뿌려진다 ──
{
  const B = T.burst;
  const qs = [...document.querySelectorAll('#burst .q')];
  //  자리 — 재어 보고 줄에 채운다(겹치지 않게). 줄마다 가운데에 두되 조금씩 엇갈린다(정해진 값이라 매번 같은 그림).
  const GAP = 36, W = 1920, rowsOf = [[]];
  let used = 0;
  for (const q of qs) {
    const w = q.offsetWidth;
    if (used && used + GAP + w > W - 120) { rowsOf.push([]); used = 0; }
    rowsOf[rowsOf.length - 1].push(q); used += (used ? GAP : 0) + w;
  }
  const H = 930, top0 = 28, step = (H - top0 - 70) / Math.max(1, rowsOf.length - 1);
  rowsOf.forEach((row, r) => {
    const tot = row.reduce((n, q) => n + q.offsetWidth, 0) + GAP * (row.length - 1);
    let x = (W - tot) / 2 + (r % 2 ? 40 : -40);
    row.forEach((q, j) => {
      q.style.left = Math.round(x) + 'px'; q.style.top = Math.round(top0 + r * step + ((j * 13 + r * 7) % 17) - 8) + 'px';
      x += q.offsetWidth + GAP;
    });
  });
  qs.forEach((q) => K(q, { o: [[0, 0]] }));
  const order = qs.map((_, i) => i).sort((a, b) => ((a * 37) % 20) - ((b * 37) % 20));
  order.forEach((i, k) => pop(qs[i], B + 0.35 + k * 0.21, { dur: 0.45, from: 0.78, dy: 22 }));
  order.forEach((i, k) => fade(qs[i], B + 9.6 + k * 0.012, 0.35, 0));
  fade('#burstVeil', B, 0.4, 1, 0); fade('#burstVeil', B + 9.75, 0.45, 0);
  tw('#win', B, 0.5, { b: 0 }, { b: 6 }, 'soft'); tw('#win', B + 9.75, 0.45, null, { b: 0 }, 'soft');
  cap('#c16', B + 0.3, B + 4.7);
  cap('#c17', B + 5.1, B + 9.6);
  tw('#cursor', B - 0.1, 0.3, null, { o: 0 }, 'soft'); tw('#cursor', B + 10.0, 0.3, null, { o: 1 }, 'soft');
}

// ── 앱 찾기 ──
const PAD_OPEN = clickAt(T.apps, T.apps + 1.0, rApps.cx + 4, rApps.cy - 6) + 0.1;
{
  const pad = a('pad');
  sw(pad, [[0, 0], [PAD_OPEN, 1]], (n, on) => { n.hidden = !on; });
  tw(pad, PAD_OPEN, 0.3, { o: 0 }, { o: 1 }, 'soft');
  tw(a('padField'), PAD_OPEN, 0.5, { y: -14 }, { y: 0 }, 'out');
  pop([...pad.querySelectorAll('.v2-pad-item')], PAD_OPEN + 0.08, { stagger: 0.028, dur: 0.5, from: 0.82, dy: 10 });
  cap('#c8', PAD_OPEN + 0.25, T.out - 0.1);
  tw('#cursor', T.out - 0.3, 0.3, null, { o: 0 }, 'soft');
}

K('#cursor', hand);

// ── 쪽 바꾸기 — 제품처럼 누르면 바로 바뀐다 ──
sw(panes.home, [[0, 1], [PAGE_SESS, 0], [PAGE_HOME2, 1]], (n, on) => { n.hidden = !on; });
sw(panes.sess, [[0, 0], [PAGE_SESS, 1], [PAGE_HOME2, 0]], (n, on) => { n.hidden = !on; });

// ── 맺음 ──
tw('#win', T.out, 0.6, null, { o: 0 }, 'soft');
tw('#win', T.out, 0.6, null, { s: 0.985 }, 'soft');
tw('#end', T.end, 0.5, { o: 0 }, { o: 1 }, 'soft');
rise('#end .logo', T.end, { dur: 0.9, dy: 22, blur: 8 });
rise('#endLine', T.end + 0.35, { dur: 0.9, dy: 18, blur: 8 });
K('#end', { o: [[T.END, 1, 'hold']] });

//  시간표가 겹치지 않는지 — 장면이 앞 장면 안으로 밀려 들어가면 굽기 전에 멈춘다.
window.__caps = CAPS;
const order = [['사이드바', T.side], ['홈', PAGE_HOME], ['세션', PAGE_SESS], ['곁칸', T.side2], ['무엇이든', T.burst], ['앱 찾기', PAD_OPEN], ['맺음', T.out]];
for (let i = 1; i < order.length; i++) if (order[i][1] <= order[i - 1][1] + 2) throw new Error(`시간표가 겹친다: ${order[i - 1][0]}(${order[i - 1][1].toFixed(2)}) → ${order[i][0]}(${order[i][1].toFixed(2)})`);
window.__order = order.map(([n, t]) => n + ' ' + t.toFixed(2)).join(' · ');

// ── 내보내기 · 미리 보기 ─────────────────────────────────────────────────────
const DURATION = T.END;
seek(0);
const qs = new URLSearchParams(location.search);
const render = qs.has('render');
if (render) document.documentElement.classList.add('render');
function fit() {
  const s = render ? 1 : Math.min(innerWidth / 1920, (innerHeight - 34) / 1080);
  $('#fit').style.transform = `scale(${s})`;
}
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

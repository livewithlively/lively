// 사용 가이드 «라이블리 동작원리» — 장면과 시간표. 그리는 법은 engine.js, 무대 · 창 · 손 · 자막은 tour.css(둘러보기 영상과 같은 디자인),
//  원리 그림 넷은 guide.css, 가운데 제품 화면은 gen-guide.mjs 가 제품의 스타일시트 · DOM 으로 세운 guide-app.gen.html · guide-page.gen.html 이다.
//  이야기(원리 → 그 원리가 보이는 실제 화면):
//   표지(네 걸음) → 지식이란(흩어진 기록 → 주제별 문서 · 두 길) → [수집 · 증류 › 수집기 설정] → [증류기 설정] →
//   새로 만들지 않고 고친다(그림) → [실시간 현황 · 자동 실행 · 점검 · 확인할 것] → [앱 › WIKI — 분류 · 출처 자료 · 비슷한 지식] →
//   건네기(통째로가 아니라 세 번에 나눠, 그림) → [AI 주입기 설정] → [홈 › 선행 → 세션 · 곁칸 콘솔 · 종료 훅 · 지식 저장] → 네 걸음이 다시 돈다 → 맺음.
//  예시 데이터는 지어낸 팀(지원님 · 영업팀 · 3단계 요금제)이다 — 실제 조직의 데이터를 쓰지 않는다.
import * as engine from './engine.js';
import { ICONS } from '../../public/app/lib/icon-paths.js';
const { K, F, tw, seek, rise, leave, pop, fade, type, count } = engine;

const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const frame = $('#app');
const loaded = (fr) => new Promise((res) => {
  const ok = () => fr.contentDocument && fr.contentDocument.readyState === 'complete' && fr.contentDocument.body && fr.contentDocument.body.childElementCount > 0;
  if (ok()) res(); else fr.addEventListener('load', () => res(), { once: true });
});
await loaded(frame);
const A = frame.contentDocument;                       // 셸
const pageFrame = A.getElementById('pageFrame');
await loaded(pageFrame);
const P = pageFrame.contentDocument;                   // 앱 프레임 안(수집 · 증류 · WIKI)
const a = (n) => { const el = A.querySelector(`[data-f="${n}"]`); if (!el) throw new Error('셸에 없는 칸: ' + n); return el; };
const p = (n) => { const el = P.querySelector(`[data-f="${n}"]`); if (!el) throw new Error('앱 화면에 없는 칸: ' + n); return el; };

// ── 그림 판의 아이콘 · 로고 — 제품의 표에서(아이콘) · 제품 화면에 이미 선 것에서(로고 · Claude 표식 · 톱니) ──
const GI = { chat: '--gi-chat', wiki: '--gi-wiki', src: '--gi-src', ctx: '--gi-ctx', apps: '--gi-apps', proj: '--gi-proj' };
for (const n of document.querySelectorAll('[data-gi]')) {
  const name = n.dataset.gi;
  if (!ICONS[name] || !GI[name]) throw new Error('아이콘이 없다: ' + name);
  n.innerHTML = `<svg viewBox="0 0 64 64" class="gi" aria-hidden="true"><rect class="gi-tile" x="1.5" y="1.5" width="61" height="61" rx="16"/><path class="gi-glyph" style="stroke:var(${GI[name]})" transform="translate(14.72 14.72) scale(1.44)" d="${ICONS[name]}"/></svg>`;
}
for (const n of document.querySelectorAll('[data-ic]')) {
  if (!ICONS[n.dataset.ic]) throw new Error('아이콘이 없다: ' + n.dataset.ic);
  n.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[n.dataset.ic]}"/></svg>`;
}
const LOGO = { slack: 'tSlack', notion: 'tNotion', github: 'tGit' };
for (const n of document.querySelectorAll('[data-logo]')) n.innerHTML = p(LOGO[n.dataset.logo]).querySelector('svg').outerHTML;
for (const n of document.querySelectorAll('[data-claude]')) n.innerHTML = p('tClaude').querySelector('svg').outerHTML;
for (const n of document.querySelectorAll('[data-gear]')) n.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${P.querySelector('.cxm-mc-ic path').getAttribute('d')}"/></svg>`;

for (const d of [document, A, P]) {
  await d.fonts.ready;
  await Promise.all(['400', '500', '600', '700', '800'].map((w) => d.fonts.load(`${w} 16px Pretendard`, '가A')));
}
await Promise.all([A.fonts.load('13.5px TourMono', '가A❯●'), A.fonts.load('700 13.5px TourMono', '가A❯●')]);

// ════════════════════════════════════════════════════════════════════════════
//  화면의 상태 — 어느 쪽(홈 · 앱 프레임 · 세션)과 앱 프레임의 어느 화면인가. 시각마다 하나를 고른다.
// ════════════════════════════════════════════════════════════════════════════
const panes = { home: a('pHome'), app: a('pApp'), sess: a('pSess') };
const STAGES = ['home', 'sources', 'distill', 'deliver'];
const up1 = (s) => s[0].toUpperCase() + s.slice(1);
const BODY_ZOOM = { sources: 1 / 0.78, distill: 0.92 / 0.78, deliver: 0.88 / 0.78 };
function applyState(s) {
  for (const k in panes) panes[k].hidden = k !== s.pane;
  const wiki = s.page === 'wiki';
  a('root').classList.toggle('side-closed', !(s.pane === 'app' && wiki));
  p('vCtx').hidden = wiki; p('vWiki').hidden = !wiki;
  P.documentElement.classList.toggle('wk', wiki);
  for (const st of STAGES) { p('s' + up1(st)).hidden = st !== s.page; p('tab-' + st).classList.toggle('active', st === s.page); }
  if (!wiki) p('ctxWrap').dataset.stage = s.page;
  //  글을 읽히게 — 흐름 지도는 넓게 세워야 해서 화면 전체를 줄였는데(.78), 설정 화면들은 본문만 키운다(머리 탭 줄은 그대로라 탭을 오가도 안 흔들린다).
  P.querySelector('.ctx-body').style.zoom = String(BODY_ZOOM[s.page] || 1);
  a('rHome').classList.toggle('on', s.pane !== 'app');
  a('rCtx').classList.toggle('on', s.pane === 'app' && !wiki);
  a('rWiki').classList.toggle('on', s.pane === 'app' && wiki);
  a('rWiki').style.opacity = s.wikiSeen ? '1' : '0';
}
const ST = [[0, { pane: 'home', page: 'home', wikiSeen: false }]];
/** t 에 화면을 바꾼다(앞 상태에 덧붙여). 시각 차례대로 부른다. */
function go(t, patch) {
  const prev = ST[ST.length - 1];
  if (t <= prev[0]) throw new Error(`화면 바꾸기가 거꾸로 간다: ${t.toFixed(2)} ≤ ${prev[0].toFixed(2)}`);
  ST.push([t, { ...prev[1], ...patch }]);
}

// ── 자리 재기 — 화면 안의 칸이 무대의 어디인가(앱 프레임 안이면 프레임 자리를 더한다 · 줌은 이미 반영된 값이 온다) ──
const S = 1760 / 1160, WIN = { x: 80, y: 44 };
function rect(el) {
  const r = el.getBoundingClientRect();
  let ox = 0, oy = 0;
  if (el.ownerDocument === P) { const f = pageFrame.getBoundingClientRect(); ox = f.left; oy = f.top; }
  const x = WIN.x + (ox + r.left) * S, y = WIN.y + (oy + r.top) * S, w = r.width * S, h = r.height * S;
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}
function union(...rs) {
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
  const x2 = Math.max(...rs.map((r) => r.x + r.w)), y2 = Math.max(...rs.map((r) => r.y + r.h));
  return { x, y, w: x2 - x, h: y2 - y, cx: (x + x2) / 2, cy: (y + y2) / 2 };
}
const shift = (r, dy) => ({ ...r, y: r.y + dy, cy: r.cy + dy });
/** 무대 위 자리(그림 판의 칸) — 배율과 무관하게 offset 으로 잰다. */
function pos(el) {
  let x = 0, y = 0, n = el;
  while (n && n !== stage) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight, cx: x + el.offsetWidth / 2, cy: y + el.offsetHeight / 2 };
}

const ASIDE_W = 372;
a('aside').style.width = ASIDE_W + 'px';
a('sideBtn').classList.add('on');
const R = {};
applyState({ pane: 'home', page: 'home' });
Object.assign(R, { rHome: rect(a('rHome')), rCtx: rect(a('rCtx')), rApps: rect(a('rApps')) });
a('preChip').style.display = '';
Object.assign(R, { pre: rect(a('dPre').closest('.v2-dest')), launch: rect(a('launchIn')), send: rect(a('send')) });
applyState({ pane: 'app', page: 'home' });
for (const k of ['home', 'sources', 'distill', 'checks', 'deliver', 'inbox']) R['tab-' + k] = rect(p('tab-' + k));
Object.assign(R, { runs: rect(p('runs')), map: rect(P.querySelector('.cxm-floor')) });
applyState({ pane: 'app', page: 'sources' });
Object.assign(R, { slackMeta: rect(p('colSlack').querySelector('.cxc-m')), local: rect(p('colLocal')) });
applyState({ pane: 'app', page: 'distill' });
Object.assign(R, { dRead: rect(p('dsl1Read')), dCrit: rect(p('dsl1Crit')), dDest: rect(p('dsl1Dest')), dLast: rect(p('dsl1Last')) });
applyState({ pane: 'app', page: 'deliver' });
Object.assign(R, { dnFlow: union(rect(p('dnStart')), rect(p('dnWork'))), docs: rect(p('dlvDocs')), tokens: rect(p('dlvTokens')), tools: rect(p('dnTools')) });
applyState({ pane: 'app', page: 'wiki', wikiSeen: true });
Object.assign(R, { shelf: rect(a('kshelf')), catOn: rect(a('catOn')), rWiki: rect(a('rWiki')) });
//  WIKI 문서 — 꼬리(출처 자료 · 비슷한 지식)가 창 아래에 있다. 그만큼 올린다(제품에서 스크롤하듯).
const frameH = pageFrame.getBoundingClientRect().height;
const relB = p('related').getBoundingClientRect().bottom;
const SCR = Math.max(0, Math.ceil(relB + 14 - frameH));
Object.assign(R, { src: shift(union(rect(p('srcLabel')), rect(p('srcRows'))), -SCR * S), src1: shift(rect(p('src1')), -SCR * S), related: shift(rect(p('related')), -SCR * S) });
a('pad').hidden = false;
R.padWiki = rect(a('padWiki'));
a('pad').hidden = true;
applyState({ pane: 'sess', page: 'wiki' });
Object.assign(R, {
  given: union(rect(a('givenH')), rect(a('ckPrior')), rect(a('ckKn'))),
  call: rect(a('callT')), l2: rect(a('l2')), l3: rect(a('l3')), l4: rect(a('l4')),
  hook: union(rect(a('l8')), rect(a('l9'))),
  fork: rect(a('l10')), fixed: rect(a('l11')), lv3: rect(a('lv3')),
});
a('preChip').style.display = 'none';
applyState(ST[0][1]);

// ════════════════════════════════════════════════════════════════════════════
//  작은 도구 — 켜고 끄기 · 자막 · 짚기 · 손
// ════════════════════════════════════════════════════════════════════════════
/** 시각마다 켜고 끈다(클래스 · hidden 처럼 값이 둘뿐인 것). steps = [[t, 0|1], …] */
function sw(el, steps, apply) {
  F(el, steps.map(([t, v]) => [t, v, 'hold']), (node, v) => { const on = v > 0.5; if (node.__sw !== on) { node.__sw = on; apply(node, on); } });
}
const cls = (el, name, steps) => sw(el, steps, (n, on) => n.classList.toggle(name, on));
const show = (el, steps) => sw(el, steps, (n, on) => { n.style.display = on ? '' : 'none'; });
const appear = (el, t, dy = 6) => { tw(el, t, 0.45, { o: 0 }, { o: 1 }, 'soft'); tw(el, t, 0.6, { y: dy }, { y: 0 }, 'out'); };
function mk(tag, className, html) {
  const e = document.createElement(tag); e.className = className;
  if (html !== undefined) e.innerHTML = html;
  stage.insertBefore(e, $('#click'));
  return e;
}

//  자막 — 창 아래 한 줄. 넘치면(한 줄에 안 들어가면) 굽기 전에 멈춘다.
const CAPS = [];
function say(text, t0, t1) {
  const el = mk('p', 'cap'); el.textContent = text; el.id = 'g' + (CAPS.length + 1);
  el.style.right = 'auto'; const cw = el.offsetWidth; el.style.right = '';
  if (cw > 1800) throw new Error(`자막이 한 줄을 넘는다(${cw}px): ` + text);
  if (CAPS.length && t0 < CAPS[CAPS.length - 1].t1 + 0.2) throw new Error(`자막이 겹친다: «${CAPS[CAPS.length - 1].text}» → «${text}»`);
  CAPS.push({ id: el.id, t0, t1, text });
  rise(el, t0, { dur: 0.7, dy: 16, blur: 6 }); leave(el, t1, { dur: 0.4, dy: -10, blur: 4 });
  return t1;
}
/** 테두리 하나를 (t0 ~ t1) 동안 */
function ring(r, t0, t1, pad = 5) {
  const el = mk('span', 'ring');
  el.style.width = (r.w + pad * 2) + 'px'; el.style.height = (r.h + pad * 2) + 'px';
  K(el, { x: [[0, r.x - pad]], y: [[0, r.y - pad]], o: [[0, 0]] });
  tw(el, t0, 0.4, { o: 0 }, { o: 1 }, 'soft'); tw(el, t0, 0.5, { s: 1.04 }, { s: 1 }, 'out');
  fade(el, t1, 0.35, 0);
  return el;
}
/** 말 하나 — place = right(오른쪽) | left(왼쪽) | below(아래 · 화살 위) | above(위 · 화살 아래). 이름이 앞, 풀이가 뒤. */
function tip(r, t0, t1, place, title, sub, small = false) {
  const tp = mk('div', 'tip' + ({ below: ' up', above: ' dn', left: ' lt', right: '' })[place] + (small ? ' sm' : ''));
  tp.append(Object.assign(document.createElement('b'), { textContent: title }), Object.assign(document.createElement('span'), { textContent: sub }));
  const W = tp.offsetWidth, H = tp.offsetHeight;
  let tx, ty, from;
  if (place === 'right') { tx = r.x + r.w + 26; ty = r.cy - H / 2; from = { x: tx - 16 }; }
  else if (place === 'left') { tx = r.x - W - 26; ty = r.cy - H / 2; from = { x: tx + 16 }; }
  else {
    tx = Math.max(100, Math.min(1820 - W, r.cx - 60));
    ty = place === 'below' ? r.y + r.h + 24 : r.y - H - 24;
    from = { y: place === 'below' ? ty - 12 : ty + 12 };
    tp.style.setProperty('--ax', Math.max(28, Math.min(W - 28, r.cx - tx)) + 'px');
  }
  if (tx < 20 || tx + W > 1900 || ty < 10 || ty + H > 965) throw new Error(`말이 무대를 벗어난다: «${title}» (${tx.toFixed(0)}, ${ty.toFixed(0)}, ${W}×${H})`);
  K(tp, { x: [[0, tx]], y: [[0, ty]], o: [[0, 0]] });
  tw(tp, t0 + 0.12, 0.4, { o: 0 }, { o: 1 }, 'soft');
  if (from.x !== undefined) tw(tp, t0 + 0.12, 0.6, { x: from.x }, { x: tx }, 'out');
  else tw(tp, t0 + 0.12, 0.6, { y: from.y }, { y: ty }, 'out');
  fade(tp, t1, 0.35, 0);
  return tp;
}
const point = (r, t0, t1, place, title, sub, pad = 5) => { ring(r, t0, t1, pad); tip(r, t0, t1, place, title, sub); };

// ── 손 ──
const HX = 8, HY = 5;
const hand = { x: [], y: [], s: [] };
let handAt = null;
function handStart(t, x, y) { hand.x.push([t, x - HX, 'hold']); hand.y.push([t, y - HY, 'hold']); handAt = { t, x, y }; }
function handTo(t0, t1, x, y) {
  hand.x.push([t0, handAt.x - HX, 'hold'], [t1, x - HX, 'inOut']);
  hand.y.push([t0, handAt.y - HY, 'hold'], [t1, y - HY, 'inOut']);
  handAt = { t: t1, x, y };
}
let clickN = 0;
function press(t) {
  hand.s.push([t - 0.02, 1, 'hold'], [t + 0.09, 0.86, 'out'], [t + 0.3, 1, 'out']);
  const rp = $('#click').cloneNode(); rp.id = 'click' + (clickN++); $('#click').after(rp);
  K(rp, { x: [[0, handAt.x]], y: [[0, handAt.y]], o: [[0, 0]] });
  tw(rp, t + 0.03, 0.55, { s: 0.3, o: 1 }, { s: 1, o: 0 }, 'out');
}
/** (go0 ~ go1) 동안 가서 누른다. 누른 시각을 돌려준다. */
function clickAt(go0, go1, x, y) { handTo(go0, go1, x, y); press(go1 + 0.15); return go1 + 0.15; }
const clickR = (go0, go1, r, dx = 0, dy = 0) => clickAt(go0, go1, r.cx + dx, r.cy + dy);

// ── 창 · 그림 판 ──
function winIn(t) { tw('#win', t, 0.6, null, { o: 1 }, 'soft'); tw('#win', t, 0.9, { s: 0.985 }, { s: 1 }, 'out'); tw('#cursor', t + 0.3, 0.35, null, { o: 1 }, 'soft'); }
function winOut(t) { tw('#win', t, 0.5, null, { o: 0 }, 'soft'); tw('#win', t, 0.5, null, { s: 0.985 }, 'soft'); tw('#cursor', t - 0.1, 0.3, null, { o: 0 }, 'soft'); }
const dgIn = (sel, t) => tw(sel, t, 0.5, null, { o: 1 }, 'soft');
const dgOut = (sel, t) => tw(sel, t, 0.45, null, { o: 0 }, 'soft');
/** 선을 그린다(stroke-dash) — t0 ~ t1 동안 시작에서 끝까지. */
function draw(el, t0, t1) {
  const L = el.getTotalLength();
  el.style.strokeDasharray = L + ' ' + L;
  F(el, [[0, L, 'hold'], [t0, L, 'hold'], [t1, 0, 'inOut']], (n, v) => { n.style.strokeDashoffset = v.toFixed(1); });
}
//  흐름 지도의 관 — 켜진 뒤로 파선이 흐른다(시각 t 가 자리를 정한다).
function flow(n, t, end) {
  const w = p('wire' + n);
  sw(w, [[0, 0], [t, 1]], (node, on) => { node.classList.toggle('is-flow', on); node.classList.toggle('is-still', !on); });
  K(w, { '--fx': [[t, 0, 'hold'], [end, ((end - t) / 1.8) * 22, 'lin']] });
}

// ════════════════════════════════════════════════════════════════════════════
//  0. 표지 — 네 걸음
// ════════════════════════════════════════════════════════════════════════════
const LP = ['#lp1', '#lp2', '#lp3', '#lp4'];
//  처음엔 다 숨어 있다(창 · 그림 판) — 키가 없으면 엔진은 «보임(1)» 에서 시작한다.
K('#win', { o: [[0, 0]] });
for (const d of ['#dLoop', '#dKn', '#dFix', '#dHand']) K(d, { o: [[0, 0]] });
K('#lpBack', { o: [[0, 0]] }); K('#lpBackT', { o: [[0, 0]] });
{
  dgIn('#dLoop', 0.1);
  rise('#lpEye', 0.3, { dur: 0.9, dy: 16, blur: 6 });
  rise('#lpTitle', 0.45, { dur: 1.1, dy: 30, blur: 12 });
  LP.forEach((s, i) => pop(s, 1.1 + i * 0.22, { dur: 0.7, from: 0.9, dy: 22 }));
  ['#lpA1', '#lpA2', '#lpA3'].forEach((s, i) => { K(s, { o: [[0, 0]] }); fade(s, 1.4 + i * 0.22, 0.4, 1, 0); });
  say('라이블리는 이렇게 일합니다.', 1.0, 4.4);
  say('모으고, 정리하고, AI에게 건네고, 일한 만큼 다시 쌓습니다.', 4.8, 10.2);
}
const T1 = 10.6;
dgOut('#dLoop', T1);

// ════════════════════════════════════════════════════════════════════════════
//  1. 지식이란 — 흩어진 기록이 주제별 문서 하나로 · 지식이 생기는 두 길
// ════════════════════════════════════════════════════════════════════════════
const K1 = T1 + 0.5;
{
  dgIn('#dKn', K1);
  const srcs = ['#kS1', '#kS2', '#kS3', '#kS4', '#kS5', '#kS6'].map((s) => $(s));
  const doc = pos($('#kDoc'));
  const tilt = [-2.2, 1.6, -1.2, 2.0, -1.6, 1.1];
  srcs.forEach((el, i) => {
    K(el, { r: [[0, tilt[i]]] });
    pop(el, K1 + 0.2 + i * 0.17, { dur: 0.6, from: 0.85, dy: 18 });
    //  모인다 — 문서 쪽으로 날아가 작아지며 사라진다.
    const at = K1 + 2.5 + i * 0.1, q = pos(el);
    tw(el, at, 0.85, { x: 0, y: 0, s: 1, r: tilt[i] }, { x: doc.x + 60 - q.cx, y: doc.cy - q.cy, s: 0.32, r: 0 }, 'inOut');
    tw(el, at + 0.45, 0.4, null, { o: 0 }, 'soft');
  });
  K('#kDoc', { o: [[0, 0]] });
  pop('#kDoc', K1 + 2.9, { dur: 0.75, from: 0.88, dy: 16 });
  say('흩어진 기록을 주제별로 정리한 문서, 이것을 지식이라고 부릅니다.', K1 + 0.4, K1 + 5.8);
  //  두 길
  say('지식은 두 길로 생깁니다. 쌓인 자료에서, 그리고 AI와 일하면서.', K1 + 6.2, K1 + 11.6);
  K('#knLaneA', { o: [[0, 0]] }); K('#knLaneB', { o: [[0, 0]] });
  pop('#knLaneA', K1 + 6.6, { dur: 0.65, from: 0.9, dy: 16 });
  draw($('#knWA'), K1 + 7.1, K1 + 7.9);
  pop('#knLaneB', K1 + 8.6, { dur: 0.65, from: 0.9, dy: 16 });
  draw($('#knWB'), K1 + 9.1, K1 + 9.9);
}
const T2 = K1 + 11.9;
dgOut('#dKn', T2);

// ════════════════════════════════════════════════════════════════════════════
//  2. 수집 · 증류 › 수집기 설정
// ════════════════════════════════════════════════════════════════════════════
const K2 = T2 + 0.4;
winIn(K2);
handStart(K2, 1240, 800);
{
  say('먼저 수집기가, 쓰는 앱에서 자료를 가져옵니다.', K2 + 0.5, K2 + 5.8);
  const CTX = clickR(K2 + 0.6, K2 + 1.5, R.rCtx, 4, -6) + 0.1;
  go(CTX, { pane: 'app', page: 'home' });
  const SRC = clickR(CTX + 0.45, CTX + 1.2, R['tab-sources']) + 0.1;
  go(SRC, { page: 'sources' });
  handTo(SRC + 0.4, SRC + 1.2, 1460, 860);
  point(R['tab-sources'], SRC + 0.2, K2 + 5.8, 'below', '수집 · 증류 › 수집기 설정', '쓰는 앱마다 수집기가 하나씩', 4);
  say('정해 둔 주기마다, 새로 생기거나 바뀐 것만 가져옵니다.', K2 + 6.2, K2 + 11.2);
  point(R.slackMeta, K2 + 6.4, K2 + 11.2, 'below', '5분마다 자동 수집', '지난 실행에서 새 자료 3 · 바뀐 자료 1', 6);
  say('내 컴퓨터의 폴더는 올리는 순간 들어오고, 원문은 그대로 둡니다.', K2 + 11.6, K2 + 16.8);
  point(R.local, K2 + 11.8, K2 + 16.8, 'below', '내 컴퓨터', '폴더를 올리면 바로 · 원문은 고치지 않아요', 2);
}

// ════════════════════════════════════════════════════════════════════════════
//  3. 증류기 설정 — 읽는 곳 · 남길 기준 · 지식이 가는 곳
// ════════════════════════════════════════════════════════════════════════════
const K3 = K2 + 17.2;
let K4;
{
  const DST = clickR(K3, K3 + 0.8, R['tab-distill']) + 0.1;
  go(DST, { page: 'distill' });
  handTo(DST + 0.4, DST + 1.2, 1500, 880);
  say('증류기는 쌓인 자료를 읽고, 남길 가치가 있는 것만 지식으로 씁니다.', K3 + 0.2, K3 + 5.6);
  point(R['tab-distill'], DST + 0.2, K3 + 5.6, 'below', '수집 · 증류 › 증류기 설정', '자료를 읽고 지식을 쓰는 곳', 4);
  say('증류기마다 읽는 곳, 남길 기준, 지식이 가는 곳을 정해 둡니다.', K3 + 6.0, K3 + 13.2);
  point(R.dRead, K3 + 6.3, K3 + 8.6, 'below', '읽는 곳', '어느 채널 · 폴더를 읽을지');
  point(R.dCrit, K3 + 8.6, K3 + 10.9, 'below', '남길 기준', '무엇을 남기고 버릴지 — 말로 적어 둡니다');
  point(R.dDest, K3 + 10.9, K3 + 13.2, 'below', '지식이 가는 곳', '어느 분류에 쌓을지');
  //  고침 — 그림으로 넘어간다
  K4 = K3 + 16.2;
  say('같은 주제의 지식이 이미 있으면, 새로 만들지 않고 그 지식을 고칩니다.', K3 + 13.6, K4 + 5.2);
  point(R.dLast, K3 + 13.8, K3 + 15.7, 'below', '고침 5', '오늘 새로 만들지 않고 고친 횟수', 4);
  winOut(K3 + 15.8);
}

// ════════════════════════════════════════════════════════════════════════════
//  4. 새로 만들지 않고 고친다
// ════════════════════════════════════════════════════════════════════════════
{
  dgIn('#dFix', K4);
  for (const s of ['#fxSrc', '#fxA1', '#fxMc', '#fxA2', '#fxSim', '#fxA3', '#fxDoc', '#fxEd', '#fxNew', '#fxPlus', '#fxSt1', '#fxSt2', '#fxSt3']) K(s, { o: [[0, 0]] });
  pop('#fxSrc', K4 + 0.15, { dur: 0.6, from: 0.9, dy: 16 });
  fade('#fxA1', K4 + 0.65, 0.35, 1);
  pop('#fxMc', K4 + 0.85, { dur: 0.6, from: 0.85, dy: 0 });
  fade('#fxA2', K4 + 1.35, 0.35, 1);
  pop('#fxSim', K4 + 1.55, { dur: 0.6, from: 0.9, dy: 14 });
  ['#fxR1', '#fxR2', '#fxR3'].forEach((s, i) => { K(s, { o: [[0, 0]] }); appear($(s), K4 + 1.8 + i * 0.16, 6); });
  cls($('#fxR1'), 'lit', [[0, 0], [K4 + 2.5, 1]]);
  fade('#fxA3', K4 + 2.85, 0.35, 1);
  pop('#fxDoc', K4 + 3.05, { dur: 0.65, from: 0.9, dy: 14 });
  cls($('#fxOld'), 'x', [[0, 0], [K4 + 3.8, 1]]);
  pop('#fxNew', K4 + 4.0, { dur: 0.5, from: 0.7, dy: 0 });
  pop('#fxEd', K4 + 4.3, { dur: 0.5, from: 0.8, dy: 0 });
  sw($('#fxSrcN'), [[0, 0], [K4 + 4.5, 1]], (n, on) => { n.textContent = on ? '출처 자료 7건' : '출처 자료 6건'; });
  pop('#fxPlus', K4 + 4.5, { dur: 0.5, from: 0.6, dy: 0 });
  say('그래서 지식은 끝없이 불어나지 않고, 늘 최신으로 남습니다.', K4 + 5.6, K4 + 10.6);
  ['#fxSt1', '#fxSt2', '#fxSt3'].forEach((s, i) => pop(s, K4 + 6.0 + i * 0.28, { dur: 0.6, from: 0.88, dy: 14 }));
}
const T5 = K4 + 11.0;
dgOut('#dFix', T5);

// ════════════════════════════════════════════════════════════════════════════
//  5. 실시간 현황 — 흐름 지도 · 자동 실행 · 점검 · 확인할 것
// ════════════════════════════════════════════════════════════════════════════
const K5 = T5 + 0.3;
winIn(K5);
{
  const HOME = clickR(K5 + 0.3, K5 + 1.1, R['tab-home']) + 0.1;
  go(HOME, { page: 'home' });
  for (const n of [1, 2, 3]) flow(n, HOME + 0.2 + n * 0.25, HOME + 60);
  handTo(HOME + 0.4, HOME + 1.2, 1500, 900);
  say('이 흐름 전체는 실시간 현황에서 한눈에 봅니다.', K5 + 0.4, K5 + 5.2);
  point(R['tab-home'], HOME + 0.2, K5 + 5.2, 'below', '수집 · 증류 › 실시간 현황', '흐름 지도 · 자동 실행', 4);
  say('언제 무엇을 가져오고 고쳤는지는 자동 실행에 남고,', K5 + 5.6, K5 + 10.2);
  point(R.runs, K5 + 5.8, K5 + 10.2, 'above', '자동 실행', '점 하나가 실행 한 번 · 클수록 많이 바뀜', 3);
  say('점검은 낡거나 서로 어긋난 지식을 찾아내고,', K5 + 10.6, K5 + 14.8);
  point(R['tab-checks'], K5 + 10.8, K5 + 14.8, 'below', '점검 설정', '낡은 지식 · 서로 어긋난 지식 찾기', 4);
  say("사람이 정해야 할 것만 '확인할 것'에 모읍니다.", K5 + 15.2, K5 + 19.8);
  point(R['tab-inbox'], K5 + 15.4, K5 + 19.8, 'below', '확인할 것', '점검 · 증류가 사람에게 묻는 것만', 4);
}

// ════════════════════════════════════════════════════════════════════════════
//  6. 앱 › WIKI — 분류 · 출처 자료 · 비슷한 지식
// ════════════════════════════════════════════════════════════════════════════
const K6 = K5 + 20.2;
{
  const PAD = clickR(K6, K6 + 0.9, R.rApps, 4, -6) + 0.1;
  const pad = a('pad');
  say('정리된 지식은 WIKI에서 분류별로 봅니다.', K6 + 0.3, K6 + 6.0);
  const WK = clickR(PAD + 0.45, PAD + 1.25, R.padWiki) + 0.1;
  sw(pad, [[0, 0], [PAD, 1], [WK, 0]], (n, on) => { n.hidden = !on; });
  tw(pad, PAD, 0.3, { o: 0 }, { o: 1 }, 'soft');
  tw(a('padField'), PAD, 0.5, { y: -14 }, { y: 0 }, 'out');
  pop([...pad.querySelectorAll('.v2-pad-item')], PAD + 0.08, { stagger: 0.025, dur: 0.5, from: 0.82, dy: 10 });
  go(WK, { pane: 'app', page: 'wiki', wikiSeen: true });
  handTo(WK + 0.3, WK + 1.1, 1500, 640);
  point(R.shelf, WK + 0.3, K6 + 6.0, 'right', 'WIKI › 분류', '사업 › 영업 › 3단계 요금제', 3);
  //  꼬리로 내려간다
  say('지식마다 근거가 된 원본이 붙어 있어, 언제든 원문을 확인할 수 있고,', K6 + 6.4, K6 + 11.8);
  K(p('wkScroll'), { y: [[0, 0], [K6 + 6.5, 0, 'hold'], [K6 + 7.5, -SCR, 'inOut']] });
  point(R.src, K6 + 7.6, K6 + 11.8, 'above', '출처 자료', '누르면 원문이 그대로 열립니다', 5);
  handTo(K6 + 8.4, K6 + 9.3, R.src1.x + 260, R.src1.cy + 4);
  sw(p('src1'), [[0, 0], [K6 + 9.3, 1], [K6 + 11.6, 0]], (n, on) => { n.style.background = on ? 'rgba(45,107,240,.08)' : ''; });
  handTo(K6 + 11.4, K6 + 12.2, 1500, 400);
  say('뜻이 가까운 지식은 자동으로 이어져, 분류가 달라도 함께 찾아집니다.', K6 + 12.2, K6 + 17.6);
  point(R.related, K6 + 12.4, K6 + 17.6, 'above', '비슷한 지식', '자동 · 의미가 가까운 순', 5);
}
const T7 = K6 + 18.0;
winOut(T7);

// ════════════════════════════════════════════════════════════════════════════
//  7. 건네기 — 통째로가 아니라, 세 번에 나눠 필요한 만큼
// ════════════════════════════════════════════════════════════════════════════
const K7 = T7 + 0.4;
{
  dgIn('#dHand', K7);
  K('#hdStack', { o: [[0, 0]] }); K('#hdAi', { o: [[0, 0]] }); K('#hdKeep', { o: [[0, 0]] });
  pop('#hdStack', K7 + 0.2, { dur: 0.7, from: 0.9, dy: 18 });
  pop('#hdAi', K7 + 0.5, { dur: 0.7, from: 0.9, dy: 18 });
  say('AI에게 지식을 통째로 넣지 않습니다.', K7 + 0.4, K7 + 4.6);
  //  통째로 넣으면 — 넘친다
  const st = pos($('#hdStack')), ai = pos($('#hdAi')), meter = pos($('#hdFill').parentElement);
  const g = $('#hdGhost'), gw = g.offsetWidth, gh = g.offsetHeight;
  K(g, { o: [[0, 0]], x: [[0, st.x + st.w - 60]], y: [[0, st.cy - gh / 2]] });
  pop(g, K7 + 1.1, { dur: 0.5, from: 0.85, dy: 0 });
  tw(g, K7 + 1.3, 1.0, null, { x: ai.x + 20, y: meter.cy - gh / 2 - 70 }, 'inOut');
  cls(g, 'x', [[0, 0], [K7 + 2.9, 1]]);
  tw(g, K7 + 3.2, 0.45, null, { o: 0 }, 'soft');
  const over = $('#hdOver'), mw = meter.w;
  F(over, [[0, 0, 'hold'], [K7 + 2.0, 0, 'hold'], [K7 + 2.6, 1.12, 'out'], [K7 + 3.4, 1.12, 'hold'], [K7 + 3.9, 0, 'soft']], (n, v) => { n.style.width = (v * mw).toFixed(1) + 'px'; n.style.opacity = v > 0.01 ? '1' : '0'; });
  //  넣은 만큼(%) — 넘칠 때는 «넘침»
  const fillKeys = [[0, 0, 'hold']];
  sw($('#hdPct'), [[0, 0], [K7 + 2.3, 1], [K7 + 3.6, 0]], (n, on) => { n.dataset.over = on ? '1' : ''; n.style.color = on ? 'var(--red)' : ''; });
  //  세 걸음
  say('필요한 만큼만, 세 번에 나눠 건넵니다.', K7 + 5.0, K7 + 9.0);
  const rows = ['#hdR1', '#hdR2', '#hdR3'].map((s) => $(s));
  rows.forEach((r, i) => { K(r, { o: [[0, 0]] }); pop(r, K7 + 5.4 + i * 0.3, { dur: 0.6, from: 0.92, dy: 16 }); });
  const STEP = [
    ['① 대화를 시작하면, 팀 규칙과 업무 분류 목록만 넣고,', 5],
    ['② 말을 보낼 때마다, 가까운 지식 몇 건의 제목과 요약을 붙이고,', 10],
    ['③ 더 필요하면 AI가 직접 찾아, 필요한 부분만 꺼내 읽습니다.', 16],
  ];
  let t = K7 + 9.4;
  STEP.forEach(([text, pct], i) => {
    say(text, t, t + 4.8);
    cls(rows[i], 'on', [[0, 0], [t + 0.2, 1], [t + 4.8, 0]]);
    const pk = $('#hdP' + (i + 1)), rp = pos(rows[i]), w = pk.offsetWidth, h = pk.offsetHeight;
    const x0 = rp.x + rp.w - w - 150, y0 = rp.cy - h / 2;
    K(pk, { o: [[0, 0]], x: [[0, x0]], y: [[0, y0]] });
    pop(pk, t + 0.8, { dur: 0.45, from: 0.8, dy: 0 });
    tw(pk, t + 1.2, 0.95, null, { x: meter.x + 30, y: meter.cy - h / 2 }, 'inOut');
    tw(pk, t + 1.95, 0.3, null, { o: 0, s: 0.7 }, 'soft');
    fillKeys.push([t + 1.95, STEP[i - 1] ? STEP[i - 1][1] : 0, 'hold'], [t + 2.5, pct, 'out']);
    t += 5.2;
  });
  F($('#hdFill'), fillKeys, (n, v) => { n.style.width = (v / 100 * mw).toFixed(1) + 'px'; });
  F($('#hdPct'), fillKeys, (n, v) => { const s = n.dataset.over ? '넘침' : Math.round(v) + '%'; if (n.__t !== s) { n.__t = s; n.textContent = s; } });
  //  지식이 늘어도 받는 맥락은 그대로
  say('그래서 지식이 늘어도, AI가 받는 맥락은 가볍게 유지됩니다.', t, t + 5.0);
  count($('#hdN'), t + 0.4, t + 2.6, 212, 2120);
  //  뒤에 깔린 장이 두꺼워진다
  K('#hdS2', { x: [[0, 11]], y: [[0, -11]] }); K('#hdS3', { x: [[0, 22]], y: [[0, -22]] });
  tw('#hdS2', t + 0.4, 1.6, null, { x: 20, y: -20 }, 'out');
  tw('#hdS3', t + 0.4, 1.8, null, { x: 40, y: -40 }, 'out');
  pop('#hdKeep', t + 1.6, { dur: 0.5, from: 0.85, dy: 0 });
  var T8 = t + 5.4;
}
dgOut('#dHand', T8);

// ════════════════════════════════════════════════════════════════════════════
//  8. AI 주입기 설정 — ①② 세션 주입 · 넣는 문서 · 채워지는 값 · ③ MCP 도구
// ════════════════════════════════════════════════════════════════════════════
const K8 = T8 + 0.3;
winIn(K8);
{
  const CX = clickR(K8 + 0.3, K8 + 1.1, R.rCtx, 4, -6) + 0.1;
  go(CX, { pane: 'app', page: 'home' });
  const DLV = clickR(CX + 0.45, CX + 1.2, R['tab-deliver']) + 0.1;
  go(DLV, { page: 'deliver' });
  handTo(DLV + 0.4, DLV + 1.2, 1500, 900);
  say('무엇을 언제 넣을지는 AI 주입기 설정에서 보고 고칩니다.', K8 + 0.4, K8 + 6.0);
  point(R['tab-deliver'], DLV + 0.2, K8 + 6.0, 'below', '수집 · 증류 › AI 주입기 설정', 'AI에게 무엇을 언제 넣을지', 4);
  say("①은 '세션 시작', ②는 '작업 중'에서 정하고,", K8 + 6.4, K8 + 10.8);
  point(R.dnFlow, K8 + 6.6, K8 + 10.8, 'right', '세션 주입', '시작 · 작업 중 · 종료마다 넣는 것', 4);
  say('대화를 열 때 넣는 문서와, 매번 새로 채워지는 값이 여기 있습니다.', K8 + 11.2, K8 + 16.4);
  point(R.docs, K8 + 11.4, K8 + 13.9, 'below', '주입 문서', '회사 배경 · 규칙 · 라이블리 쓰는 법', 3);
  point(R.tokens, K8 + 13.9, K8 + 16.4, 'above', '${categories}', '업무 분류 목록 — 세션마다 새로 채워집니다', 3);
  say("③에서 AI가 쓰는 도구는 'MCP 도구'에서 켜고 끕니다.", K8 + 16.8, K8 + 21.0);
  point(R.tools, K8 + 17.0, K8 + 21.0, 'right', 'MCP 도구', 'AI가 지식을 찾아 읽는 도구', 4);
}

// ════════════════════════════════════════════════════════════════════════════
//  9. 홈 › 선행 → 세션 — 곁칸 콘솔 · 찾아 읽기 · 종료 훅 · 지식 저장
// ════════════════════════════════════════════════════════════════════════════
const K9 = K8 + 21.4;
let T10;
{
  const HM = clickR(K9, K9 + 0.8, R.rHome, 4, -6) + 0.1;
  go(HM, { pane: 'home' });
  say('두 번째 길은 AI와 일할 때입니다.', K9 + 0.2, K9 + 4.2);
  handTo(HM + 0.4, HM + 1.2, R.pre.x + 340, R.pre.y + R.pre.h + 160);
  //  선행 — 고르면 칩이 선다
  say('이어지는 일이면 선행을 골라, 앞 일의 지식을 이어받습니다.', K9 + 4.6, K9 + 9.8);
  const PK = clickAt(K9 + 4.7, K9 + 5.4, R.pre.x + 200, R.pre.cy + 2);
  show(a('preChip'), [[0, 0], [PK + 0.1, 1]]);
  show(A.querySelector('[data-f="dPre"] .v2-dest-in'), [[0, 1], [PK + 0.1, 0]]);
  pop(a('preChip'), PK + 0.1, { dur: 0.5, from: 0.8, dy: 0 });
  handTo(PK + 0.3, PK + 1.0, R.pre.x + 330, R.pre.y + R.pre.h + 150);
  point(R.pre, PK + 0.3, K9 + 9.8, 'below', '선행', '앞 프로젝트가 남긴 지식을 이어받아요', 4);
  //  시키기
  const ASK = '경쟁사 요금 조사해서 우리 요금제랑 비교표 만들어 줘';
  say('그리고 평소처럼 시키면,', K9 + 10.2, K9 + 13.8);
  const IN = clickAt(K9 + 10.1, K9 + 10.8, R.launch.x + 150, R.launch.y + 30);
  const ty = [IN + 0.35, IN + 2.6];
  handTo(IN + 0.3, ty[0] + 0.5, R.launch.x + 760, R.launch.y + 56);
  sw(a('launchPh'), [[0, 1], [ty[0], 0]], (n, on) => { n.style.display = on ? '' : 'none'; });
  type(a('launchIn'), ASK, ty[0], ty[1]);
  F(a('caret'), [[0, 0, 'hold'], [IN + 0.05, 1, 'hold']], (n, v, t) => {
    const typing = t >= ty[0] && t <= ty[1] + 0.25;
    n.style.opacity = v > 0.5 && (typing || ((t - IN) % 1.06) < 0.58) ? '1' : '0';
  });
  const SEND = clickR(ty[1] + 0.2, ty[1] + 0.85, R.send, 2, 2);
  K(a('send'), { s: [[SEND - 0.02, 1, 'hold'], [SEND + 0.08, 0.95, 'out'], [SEND + 0.28, 1, 'out']] });
  const SS = SEND + 0.12;
  go(SS, { pane: 'sess' });
  handTo(SS + 0.4, SS + 1.3, 1180, 900);
  F(a('bcaret'), [[0, 0, 'hold']], (n) => { n.style.opacity = '0'; });

  //  세션 — 줄이 차례로 선다. 라이블리가 붙으면서 터미널에 새로 뜨는 줄을 하나씩 읽어 준다.
  const line = (n, at) => { K(a(n), { o: [[0, 0]] }); appear(a(n), at, 4); };
  line('l0', SS + 0.15);
  say('AI가 무엇을 알고 시작했는지는 우측 사이드바의 콘솔에 보입니다.', SS + 0.4, SS + 5.4);
  point(R.given, SS + 0.6, SS + 5.4, 'left', '콘솔 › 알려 준 것', '선행 프로젝트 · 고른 지식', 4);
  //  Calling lively… → Called lively 3 times
  say("터미널에 'Calling lively'가 뜨면, AI가 라이블리에서 지식을 찾는 중입니다.", SS + 5.8, SS + 10.8);
  line('l1', SS + 6.0);
  const CALLED = SS + 9.4;
  sw(a('callT'), [[0, 0], [CALLED, 1]], (n, on) => { n.textContent = on ? 'Called lively 3 times' : 'Calling lively…'; });
  sw(a('callX'), [[0, 0], [CALLED, 1]], (n, on) => { n.textContent = on ? '(ctrl+o to expand)' : ''; });
  line('l2', SS + 7.0); line('l3', SS + 7.8); line('l4', SS + 8.6);
  point(R.call, SS + 6.3, SS + 10.8, 'above', 'Calling lively', '라이블리 도구를 부르는 중', 6);
  //  search · grep · get — 줄 끝에 이름표
  say('search는 뜻으로 찾고, grep은 글자 그대로 찾고, get은 필요한 줄만 읽습니다.', SS + 11.2, SS + 17.2);
  const tags = [['l2', '뜻으로 찾기'], ['l3', '글자 그대로 찾기'], ['l4', '필요한 줄만 읽기']];
  const tR = R.l2.x + R.l2.w - 18;
  tags.forEach(([n, text], i) => {
    const el = mk('span', 'ann'); el.textContent = text;
    const w = el.offsetWidth, h = el.offsetHeight, r = R[n];
    K(el, { x: [[0, tR - w]], y: [[0, r.cy - h / 2]], o: [[0, 0]] });
    pop(el, SS + 11.6 + i * 0.7, { dur: 0.5, from: 0.8, dy: 0 });
    fade(el, SS + 17.2, 0.35, 0);
  });
  ring(union(R.l2, R.l4), SS + 11.5, SS + 17.2, 4);
  line('l5', SS + 17.4); line('l6', SS + 17.7); line('l7', SS + 18.0);
  //  종료 훅
  say('기록 없이 끝내려 하면, 종료 훅이 한 번 붙잡습니다.', SS + 18.4, SS + 23.2);
  line('l8', SS + 19.0); line('l9', SS + 19.3);
  point(R.hook, SS + 19.5, SS + 23.2, 'below', 'Stop hook feedback', '세션 종료 훅 — 세션당 한 번', 6);
  //  기록 fork
  say("'기록:'으로 시작하는 에이전트는, 곁에서 지식을 저장하는 기록 fork입니다.", SS + 23.6, SS + 28.6);
  line('l10', SS + 24.0);
  point(R.fork, SS + 24.3, SS + 28.6, 'below', 'Agent(기록: …)', '대화는 그대로 두고, 곁에서 지식을 저장', 6);
  //  고침 · 남긴 것
  say("비슷한 지식이 있으면 고치고, 콘솔의 '남긴 것'에도 바로 보입니다.", SS + 29.0, SS + 34.4);
  line('l11', SS + 29.3);
  point(R.fixed, SS + 29.6, SS + 31.9, 'above', '판 2 → 판 3', '새 지식이 아니라, 고친 지식', 6);
  show(a('lv3'), [[0, 0], [SS + 31.6, 1]]);
  K(a('lv3'), { o: [[0, 0]] }); appear(a('lv3'), SS + 31.6, 8);
  point(R.lv3, SS + 31.9, SS + 34.4, 'left', '콘솔 › 남긴 것', '이 세션이 고친 지식', 3);
  line('lbox', SS + 30.0);
  T10 = SS + 34.8;
}
winOut(T10);

// ════════════════════════════════════════════════════════════════════════════
//  10. 네 걸음이 다시 돈다 → 맺음
// ════════════════════════════════════════════════════════════════════════════
const K10 = T10 + 0.4;
{
  dgIn('#dLoop', K10);
  say('모으고, 정리하고, 건네고, 일한 만큼 다시 쌓입니다.', K10 + 0.4, K10 + 5.8);
  draw($('#lpBackPath'), K10 + 2.9, K10 + 4.3);
  K('#lpBackHead', { o: [[0, 0]] }); fade('#lpBackHead', K10 + 4.2, 0.25, 1);
  fade('#lpBack', K10 + 2.8, 0.2, 1);
  rise('#lpBackT', K10 + 3.9, { dur: 0.8, dy: 14, blur: 6 });
}
//  걸음 짚기 — 표지와 맺음에서 한 번씩, 말하는 차례대로
LP.forEach((s, i) => cls($(s), 'on', [[0, 0], [5.2 + i * 1.15, 1], [5.2 + (i + 1) * 1.15, 0], [K10 + 0.8 + i * 0.6, 1], [K10 + 0.8 + (i + 1) * 0.6, 0]]));
const T_OUT = K10 + 6.2, T_END = T_OUT + 0.8, END = T_END + 4.6;
dgOut('#dLoop', T_OUT);
tw('#end', T_END, 0.5, { o: 0 }, { o: 1 }, 'soft');
rise('#end .logo', T_END, { dur: 0.9, dy: 22, blur: 8 });
rise('#endLine', T_END + 0.35, { dur: 0.9, dy: 18, blur: 8 });
K('#end', { o: [[END, 1, 'hold']] });

// ── 마무리: 손 · 화면 상태 ──
K('#cursor', hand);
K('#cursor', { o: [[0, 0]] });
F(document.body, ST.map(([t], i) => [t, i, 'hold']), (n, v) => { const i = Math.round(v); if (n.__st !== i) { n.__st = i; applyState(ST[i][1]); } });

window.__caps = CAPS;
window.__order = ST.map(([t, s]) => `${t.toFixed(1)} ${s.pane}/${s.page}`).join(' · ');

// ── 내보내기 · 미리 보기 ─────────────────────────────────────────────────────
const DURATION = END;
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

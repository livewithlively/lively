// 소개 영상의 시간축 엔진 — 키프레임을 «시각 t 의 값» 으로만 읽는다(벽시계를 안 쓴다).
//  같은 t 를 주면 언제나 같은 그림이 나온다. 그래서 굽는 쪽(render.mjs)은 프레임마다 seek(t) 하고 찍기만 하면 되고,
//  미리 보는 쪽(film.html)은 rAF 로 t 를 흘린다. 외부 라이브러리 없음.

// ── 가속 곡선 ────────────────────────────────────────────────────────────────
function bez(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const fx = (t) => ((ax * t + bx) * t + cx) * t;
  const fy = (t) => ((ay * t + by) * t + cy) * t;
  const dfx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) { const d = dfx(t); if (Math.abs(d) < 1e-6) break; t -= (fx(t) - x) / d; }
    if (t < 0 || t > 1) { let lo = 0, hi = 1; t = x; for (let i = 0; i < 24; i++) { const v = fx(t); if (Math.abs(v - x) < 1e-5) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; } }
    return fy(t);
  };
}
export const EASE = {
  lin: (t) => t,
  out: bez(0.16, 1, 0.3, 1),        // 빠르게 나가 길게 앉는다 — 등장의 기본
  outSoft: bez(0.22, 0.8, 0.3, 1),
  inOut: bez(0.7, 0, 0.2, 1),       // 카메라 이동
  soft: bez(0.4, 0, 0.2, 1),
  in: bez(0.6, 0, 0.85, 0.2),       // 퇴장
  back: bez(0.3, 1.5, 0.5, 1),      // 살짝 넘쳤다 앉는다(점 · 타일)
};

// ── 트랙 ────────────────────────────────────────────────────────────────────
/** el → { prop → [{t, v, e}] } · fn 트랙은 prop 이 'fn#n' 이고 cb 를 따로 든다. */
const tracks = new Map();
const fns = new Map();
let fnSeq = 0;
export let DURATION = 0;

const $1 = (x) => (typeof x === 'string' ? document.querySelector(x) : x);
const $all = (x) => (typeof x === 'string' ? [...document.querySelectorAll(x)] : Array.isArray(x) ? x : [x]);

function keysOf(el, prop) {
  let m = tracks.get(el); if (!m) { m = {}; tracks.set(el, m); }
  return m[prop] || (m[prop] = []);
}
function push(el, prop, t, v, e) {
  const ks = keysOf(el, prop);
  ks.push({ t, v, e: e || 'lin' });
  ks.sort((a, b) => a.t - b.t);
  if (t > DURATION) DURATION = t;
}
/** 키프레임을 직접 놓는다 — K(el, { o: [[0,0],[1,1,'out']], y: [...] }) */
export function K(target, props) {
  for (const el of $all(target)) for (const p in props) for (const [t, v, e] of props[p]) push(el, p, t, v, e);
}
/** t 에서 dur 동안 from → to. 그 전까지는 앞 키의 값을 그대로 든다(hold). */
export function tw(target, t, dur, from, to, ease = 'out') {
  for (const el of $all(target)) for (const p in to) {
    if (from && p in from) push(el, p, t, from[p], 'hold');
    else if (!keysOf(el, p).length) push(el, p, t, DEFAULTS[p] ?? 0, 'hold');
    else { const ks = keysOf(el, p); push(el, p, t, sample(ks, t), 'hold'); }
    push(el, p, t + dur, to[p], ease);
  }
}
/** 숫자 하나를 흘려 콜백으로 그린다(글자 치기 · 숫자 세기 · 길 따라가기). */
export function F(target, keys, cb) {
  for (const el of $all(target)) {
    const id = 'fn#' + (fnSeq++);
    fns.set(id, cb);
    for (const [t, v, e] of keys) push(el, id, t, v, e);
  }
}
const DEFAULTS = { o: 1, x: 0, y: 0, s: 1, sx: 1, sy: 1, r: 0, rx: 0, ry: 0, b: 0 };

function sample(ks, t) {
  if (t <= ks[0].t) return ks[0].v;
  let i = ks.length - 1;
  while (i > 0 && ks[i].t > t) i--;
  if (i === ks.length - 1) return ks[i].v;
  const a = ks[i], b = ks[i + 1];
  if (b.e === 'hold' || b.t === a.t) return a.v;
  const p = (t - a.t) / (b.t - a.t);
  return a.v + (b.v - a.v) * (EASE[b.e] || EASE.lin)(p);
}

const r3 = (n) => Math.round(n * 1000) / 1000;
export function seek(t) {
  for (const [el, m] of tracks) {
    const v = {};
    for (const p in m) {
      const val = sample(m[p], t);
      if (p.startsWith('fn#')) fns.get(p)(el, val, t);
      else v[p] = val;
    }
    if ('o' in v) {
      el.style.opacity = r3(Math.max(0, Math.min(1, v.o)));
      el.style.visibility = v.o <= 0.001 ? 'hidden' : 'visible';
    }
    if ('x' in v || 'y' in v || 's' in v || 'sx' in v || 'sy' in v || 'r' in v || 'rx' in v || 'ry' in v) {
      const s = v.s ?? 1;
      el.style.transform = `translate3d(${r3(v.x ?? 0)}px,${r3(v.y ?? 0)}px,0)`
        + (v.rx || v.ry ? ` rotateX(${r3(v.rx ?? 0)}deg) rotateY(${r3(v.ry ?? 0)}deg)` : '')
        + (v.r ? ` rotate(${r3(v.r)}deg)` : '')
        + ` scale(${r3(s * (v.sx ?? 1))},${r3(s * (v.sy ?? 1))})`;
    }
    if ('b' in v) el.style.filter = v.b > 0.05 ? `blur(${r3(v.b)}px)` : 'none';
    for (const p in v) if (p.startsWith('--')) el.style.setProperty(p, String(r3(v[p])));
    if ('w' in v) el.style.width = r3(v.w) + 'px';
    if ('h' in v) el.style.height = r3(v.h) + 'px';
  }
}

// ── 자주 쓰는 움직임 ─────────────────────────────────────────────────────────
/** 아래에서 떠오르며 또렷해진다. */
export function rise(target, t, { dur = 0.9, dy = 28, blur = 10, stagger = 0, ease = 'out' } = {}) {
  $all(target).forEach((el, i) => {
    const at = t + i * stagger;
    tw(el, at, dur * 0.7, { o: 0 }, { o: 1 }, 'soft');
    tw(el, at, dur, { y: dy }, { y: 0 }, ease);
    if (blur) tw(el, at, dur * 0.8, { b: blur }, { b: 0 }, 'soft');
  });
}
/** 위로 물러나며 흐려진다. */
export function leave(target, t, { dur = 0.5, dy = -18, blur = 8, stagger = 0 } = {}) {
  $all(target).forEach((el, i) => {
    const at = t + i * stagger;
    tw(el, at, dur, null, { o: 0 }, 'soft');
    tw(el, at, dur, null, { y: dy }, 'in');
    if (blur) tw(el, at, dur, null, { b: blur }, 'soft');
  });
}
/** 작게 있다가 톡 튀어나온다(타일 · 칩 · 말풍선). */
export function pop(target, t, { dur = 0.6, from = 0.86, stagger = 0, dy = 10 } = {}) {
  $all(target).forEach((el, i) => {
    const at = t + i * stagger;
    tw(el, at, dur * 0.5, { o: 0 }, { o: 1 }, 'soft');
    tw(el, at, dur, { s: from }, { s: 1 }, 'back');
    if (dy) tw(el, at, dur, { y: dy }, { y: 0 }, 'out');
  });
}
export function fade(target, t, dur, to, from) { tw(target, t, dur, from === undefined ? null : { o: from }, { o: to }, 'soft'); }

/** 글을 낱말로 쪼개 span 에 담는다 — 낱말마다 따로 떠오르게. 이미 쪼갠 것은 그대로 돌려준다. */
export function words(target) {
  const el = $1(target);
  if (el.dataset.split) return [...el.querySelectorAll('.w')];
  const walk = (node) => {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === 3) {
        const frag = document.createDocumentFragment();
        ch.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) { frag.append(document.createTextNode(' ')); return; }
          const s = document.createElement('span'); s.className = 'w'; s.textContent = part; frag.append(s);
        });
        ch.replaceWith(frag);
      } else if (ch.nodeType === 1 && !ch.classList.contains('w')) {
        if (ch.dataset.atom !== undefined) ch.classList.add('w'); else walk(ch);
      }
    }
  };
  walk(el);
  el.dataset.split = '1';
  return [...el.querySelectorAll('.w')];
}
export function riseWords(target, t, opt = {}) {
  const ws = words(target);
  rise(ws, t, { dur: 0.95, dy: 30, blur: 12, stagger: 0.075, ...opt });
  return t + ws.length * (opt.stagger ?? 0.075);
}

// ── 한글 타자 — 자모가 모여 글자가 되는 모습 그대로 ──────────────────────────
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
/** 글을 «자판을 칠 때마다 보이는 모습» 의 차례로 편다. */
export function typingFrames(text) {
  const out = [''];
  let done = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0) - 0xAC00;
    if (code >= 0 && code <= 11171) {
      const cho = Math.floor(code / 588), jung = Math.floor((code % 588) / 28), jong = code % 28;
      out.push(done + CHO[cho]);
      out.push(done + String.fromCharCode(0xAC00 + cho * 588 + jung * 28));
      if (jong) out.push(done + ch);
    } else out.push(done + ch);
    done += ch;
  }
  return out;
}
/** el 에 글을 친다(t0~t1). 끝에 깜빡이는 막대(.caret)가 있으면 그 앞에 적는다. */
export function type(target, text, t0, t1, { clearAt } = {}) {
  const el = $1(target);
  const frames = typingFrames(text);
  const keys = [[t0, 0, 'hold'], [t1, frames.length - 1, 'lin']];
  if (clearAt !== undefined) { keys.push([clearAt, frames.length - 1, 'hold']); keys.push([clearAt + 0.001, -1, 'hold']); }
  F(el, keys, (node, v) => {
    const s = v < 0 ? '' : frames[Math.max(0, Math.min(frames.length - 1, Math.round(v)))];
    if (node.__txt !== s) { node.__txt = s; (node.querySelector('.tx') || node).textContent = s; }
  });
}
/** 숫자를 센다. */
export function count(target, t0, t1, a, b, ease = 'soft') {
  F(target, [[t0, a, 'hold'], [t1, b, ease]], (node, v) => {
    const s = Math.round(v).toLocaleString('en-US');
    if (node.__txt !== s) { node.__txt = s; node.textContent = s; }
  });
}

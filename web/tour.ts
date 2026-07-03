// tour.ts — 프레임워크 없는 스포트라이트 온보딩 투어(코치마크). #517
//  왜: 예전 '터미널 새 창으로 열기'는 원래 창을 가려(동시에 안 보임) 헷갈렸다 → 같은 화면에서
//  필요한 버튼만 밝게 남기고 나머지를 어둡게 덮은 뒤(4-패널 딤), 실제 버튼을 사용자가 직접 눌러
//  한 단계씩 진행한다. 스포트라이트는 패널 사이의 '구멍'(빈틈)이라 클릭이 진짜 요소로 그대로 통과한다
//  — 가짜 복제 버튼이 아니라 실제 UI 를 짚어 준다.
//  견고성: target 을 매 프레임 다시 해석(rAF)해, 늦게 뜨는 타깃(모달 오픈)이나 스크롤로 움직이는
//  타깃에도 스포트라이트가 따라붙는다. z-index 2100 = 모달(.ov-back 300)·토스트(2000) 위.
import { el, reducedMotion } from './core.js';

// 한 단계: 무엇을 강조하고(target) 어떻게 안내하는지. target 은 셀렉터 또는 요소 반환 함수(매 프레임 재해석).
interface TourStep {
  target: string | (() => Element | null);
  title: string;
  body?: any;                                 // 문자열 또는 노드(들) — 코치마크 본문
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'center' | 'auto';
  padding?: number;                           // 스포트라이트 여백(px, 기본 8)
  advanceOn?: 'click' | 'next';               // 'click' = 강조된 실제 요소를 누르면 자동으로 다음 단계
  advanceDelay?: number;                      // click 자동진행 지연(ms) — 모달 오픈/폼 제출이 먼저 일어나게(기본 80)
  scrollIntoView?: boolean;                   // 진입 시 타깃을 화면에 보이게 스크롤(모달 하단 버튼 등)
  ctaNext?: string;                           // [다음] 버튼 라벨 오버라이드(마지막 단계 '마치기' 등)
}

let active: any = null; // 현재 진행 중인 투어(중복 방지 — 새 투어 시작 시 기존 것 종료)

// 투어 종료 — rAF 정지, 리스너 해제, 오버레이 제거. 라우트 이탈 시에도 호출해 잔여 오버레이 방지.
function endTour() {
  if (!active) return;
  const t = active; active = null;
  if (t.raf) cancelAnimationFrame(t.raf);
  if (t.clickBound) t.clickBound.el.removeEventListener('click', t.clickBound.fn, true);
  window.removeEventListener('keydown', t.onKey, true);
  t.root.remove();
}

// 투어 시작 — steps 를 순서대로 안내. 이미 진행 중이면 교체.
function startTour(steps: TourStep[]) {
  if (!Array.isArray(steps) || !steps.length) return;
  endTour();

  const dims = ['top', 'right', 'bottom', 'left'].map((s) => el('div', { class: 'tour-dim tour-dim-' + s }));
  const ring = el('div', { class: 'tour-ring', 'aria-hidden': 'true' });
  const pop = el('div', { class: 'tour-pop', role: 'dialog', 'aria-live': 'polite' });
  const root = el('div', { class: 'tour-root', role: 'presentation' }, ...dims, ring, pop);
  document.body.append(root);

  const t: any = { root, dims, ring, pop, steps, i: -1, raf: 0, clickBound: null, onKey: null };
  active = t;

  // ESC 로 투어만 종료 — 캡처 단계에서 잡고 전파를 멈춰, 아래(모달)의 ESC 닫기까지 번지지 않게 한다.
  t.onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); endTour(); } };
  window.addEventListener('keydown', t.onKey, true);

  go(0);

  function resolve(step: TourStep): Element | null {
    try { return typeof step.target === 'function' ? step.target() : document.querySelector(step.target); }
    catch (_) { return null; }
  }

  // 단계 이동 — 코치마크를 다시 그리고, 필요 시 타깃을 스크롤로 보이게 한 뒤 rAF 추적을 (없으면) 켠다.
  function go(idx: number) {
    if (idx < 0 || idx >= steps.length) { endTour(); return; }
    t.i = idx;
    const step = steps[idx];
    if (t.clickBound) { t.clickBound.el.removeEventListener('click', t.clickBound.fn, true); t.clickBound = null; }
    drawPop(step, idx);
    if (step.scrollIntoView) {
      const el0 = resolve(step);
      if (el0 && (el0 as any).scrollIntoView) (el0 as any).scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    }
    if (!t.raf) t.raf = requestAnimationFrame(tick);
  }

  // 코치마크(말풍선) 내용 — 카운터·건너뛰기·제목·본문·[이전]/[다음].
  function drawPop(step: TourStep, idx: number) {
    const last = idx === steps.length - 1;
    const counter = el('div', { class: 'tour-count', text: (idx + 1) + ' / ' + steps.length });
    const skip = el('button', { class: 'btn btn-text tour-skip', text: '건너뛰기', onclick: () => endTour() });
    const bodyWrap = el('div', { class: 'tour-body' });
    if (step.body != null) {
      if (Array.isArray(step.body)) bodyWrap.append(...step.body);
      else if (typeof step.body === 'string') bodyWrap.append(el('p', { class: 'tour-p', text: step.body }));
      else bodyWrap.append(step.body);
    }
    if (step.advanceOn === 'click') bodyWrap.append(el('p', { class: 'tour-hint', text: '↑ 강조된 버튼을 직접 눌러 보세요.' }));
    const prev = el('button', { class: 'btn btn-ghost btn-sm', text: '이전', onclick: () => go(idx - 1), disabled: idx === 0 });
    const next = el('button', { class: 'btn btn-primary btn-sm', text: step.ctaNext || (last ? '마치기' : '다음 →'), onclick: () => go(idx + 1) });
    pop.replaceChildren(
      el('div', { class: 'tour-pop-top' }, counter, skip),
      el('div', { class: 'tour-title', text: step.title }),
      bodyWrap,
      el('div', { class: 'tour-pop-foot' }, prev, next));
  }

  // 매 프레임: 타깃 위치를 다시 읽어 딤·링·말풍선을 갱신하고, click 자동진행 리스너를 (있으면) 건다.
  function tick() {
    if (!active) return;
    const step = steps[t.i];
    const target = resolve(step);
    const pad = step.padding == null ? 8 : step.padding;
    const r = target ? target.getBoundingClientRect() : null;
    if (target && r && (r.width > 0 || r.height > 0)) {
      layout(r, pad);
      ring.style.display = '';
      if (step.advanceOn === 'click' && (!t.clickBound || t.clickBound.el !== target)) {
        if (t.clickBound) t.clickBound.el.removeEventListener('click', t.clickBound.fn, true);
        const cur = t.i;
        const fn = () => { setTimeout(() => { if (active && t.i === cur) go(cur + 1); }, step.advanceDelay == null ? 80 : step.advanceDelay); };
        target.addEventListener('click', fn, true);
        t.clickBound = { el: target, fn };
      }
    } else {
      // 타깃이 아직 없거나 사라짐 → 전체 딤(구멍 0) + 말풍선 중앙(완료 안내·모달 전환 순간).
      layout({ left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0, height: 0 } as any, 0);
      ring.style.display = 'none';
    }
    t.raf = requestAnimationFrame(tick);
  }

  // 스포트라이트 사각형(구멍) 기준으로 4개 딤 패널·링·말풍선 좌표 계산.
  function layout(r: any, pad: number) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const hl = Math.max(0, r.left - pad), ht = Math.max(0, r.top - pad);
    const hr = Math.min(vw, r.left + r.width + pad), hb = Math.min(vh, r.top + r.height + pad);
    const hw = Math.max(0, hr - hl), hh = Math.max(0, hb - ht);
    setBox(dims[0], 0, 0, vw, ht);                       // top
    setBox(dims[2], 0, hb, vw, Math.max(0, vh - hb));    // bottom
    setBox(dims[3], 0, ht, hl, hh);                      // left
    setBox(dims[1], hr, ht, Math.max(0, vw - hr), hh);   // right
    ring.style.left = hl + 'px'; ring.style.top = ht + 'px';
    ring.style.width = hw + 'px'; ring.style.height = hh + 'px';
    positionPop(hl, ht, hw, hh);
  }
  function setBox(node: any, x: number, y: number, w: number, h: number) {
    node.style.left = x + 'px'; node.style.top = y + 'px'; node.style.width = w + 'px'; node.style.height = h + 'px';
  }

  // 말풍선을 스포트라이트 옆(placement)에 두되 뷰포트를 넘지 않게 클램프. 구멍이 없으면 중앙.
  function positionPop(hl: number, ht: number, hw: number, hh: number) {
    const step = steps[t.i];
    const vw = window.innerWidth, vh = window.innerHeight, gap = 14;
    const pr = pop.getBoundingClientRect();
    const pw = pr.width || 320, ph = pr.height || 160;
    let place = step.placement || 'auto';
    const spaceBelow = vh - (ht + hh), spaceAbove = ht;
    if (hw === 0 && hh === 0) place = 'center';
    else if (place === 'auto') place = (spaceBelow >= ph + gap) ? 'bottom' : (spaceAbove >= ph + gap ? 'top' : 'right');
    let x: number, y: number;
    if (place === 'center') { x = (vw - pw) / 2; y = (vh - ph) / 2; }
    else if (place === 'bottom') { x = hl + hw / 2 - pw / 2; y = ht + hh + gap; }
    else if (place === 'top') { x = hl + hw / 2 - pw / 2; y = ht - ph - gap; }
    else if (place === 'right') { x = hl + hw + gap; y = ht + hh / 2 - ph / 2; }
    else { x = hl - pw - gap; y = ht + hh / 2 - ph / 2; }
    x = Math.max(gap, Math.min(x, vw - pw - gap));
    y = Math.max(gap, Math.min(y, vh - ph - gap));
    pop.style.left = x + 'px'; pop.style.top = y + 'px';
  }
}

export { startTour, endTour };

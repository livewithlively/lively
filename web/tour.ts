// tour.ts — 프레임워크 없는 스포트라이트 온보딩 투어(코치마크). #517
//  왜: 예전 '터미널 새 창으로 열기'는 원래 창을 가려(동시에 안 보임) 헷갈렸다 → 같은 화면에서
//  필요한 버튼만 밝게 남기고 나머지를 어둡게 덮은 뒤(4-패널 딤), 실제 버튼을 사용자가 직접 눌러
//  한 단계씩 진행한다. 스포트라이트는 패널 사이의 '구멍'(빈틈)이라 클릭이 진짜 요소로 그대로 통과한다
//  — 가짜 복제 버튼이 아니라 실제 UI 를 짚어 준다.
//  견고성: target 을 매 프레임 다시 해석(rAF)해, 늦게 뜨는 타깃(모달 오픈)이나 스크롤로 움직이는
//  타깃에도 스포트라이트가 따라붙는다. z-index 2100 = 모달(.ov-back 300)·토스트(2000) 위.
import { el, reducedMotion } from './core.js';

// 한 단계: 무엇을 강조하고(target) 어떻게 안내하는지. target 은 셀렉터 또는 요소 반환 함수(매 프레임 재해석).
//  요소를 '배열'로 돌려주면 그 요소들을 합친 사각형 하나만 뚫는다 — 떨어져 있지 않고 나란한 몇 칸이 한 덩어리일 때
//  (예: 속성판 2열 그리드의 첫 줄 = 선행·후속) 부모 전체를 뚫어 무관한 속성까지 밝히지 않기 위함(#780).
//  스크롤·클릭 기준은 배열의 첫 요소.
interface TourStep {
  target: string | (() => Element | Element[] | null);
  title: string;
  body?: any;                                 // 문자열 또는 노드(들) — 코치마크 본문
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'center' | 'auto';
  padding?: number;                           // 스포트라이트 여백(px, 기본 8)
  advanceOn?: 'click' | 'next';               // 'click' = 강조된 실제 요소를 누르면 자동으로 다음 단계
  advanceWhen?: () => boolean;                // 매 프레임 평가해 true 면 자동 진행. 타깃이 클릭 후 재렌더돼
  //   click 리스너가 유실되는 요소(예: 도메인맵 노드 → 선택 시 그래프 재렌더)에 쓴다. [이전]/[다음]도 함께 노출(안 막힘).
  onAdvance?: () => void;                      // [다음] 클릭 시 go 대신 실행(예: 데모 프로젝트로 라우팅). 설정 시 [다음]이 이걸 호출.
  advanceDelay?: number;                      // click 자동진행 지연(ms) — 모달 오픈/폼 제출이 먼저 일어나게(기본 80)
  scrollIntoView?: boolean;                   // 진입 시 타깃을 화면에 보이게 스크롤(모달 하단 버튼 등)
  ctaNext?: string;                           // [다음] 버튼 라벨 오버라이드(마지막 단계 '마치기' 등)
}

// 시작 옵션(#761) — onEnd(reason): 투어가 내려간 이유를 크로스탭 오케스트레이터(guide-tour.ts)가 구분할 수 있게.
//  'user'=✕/ESC 로 직접 닫음 · 'auto'=라우팅 등 외부 정리(장면 전환) · 'complete'=마지막 단계까지 자연 완주.
interface TourOpts { onEnd?: (reason: 'user' | 'auto' | 'complete') => void }

let active: any = null; // 현재 진행 중인 투어(중복 방지 — 새 투어 시작 시 기존 것 종료)

// 투어 종료 — rAF 정지, 리스너 해제, 오버레이 제거. 라우트 이탈 시에도 호출해 잔여 오버레이 방지.
//  reason 은 onEnd 로 전달(기본 'auto' — 기존 호출부(main.ts route 등)는 인자 없이 그대로).
function endTour(reason: 'user' | 'auto' | 'complete' = 'auto') {
  if (!active) return;
  const t = active; active = null;
  if (t.raf) cancelAnimationFrame(t.raf);
  if (t.clickBound) t.clickBound.el.removeEventListener('click', t.clickBound.fn, true);
  window.removeEventListener('keydown', t.onKey, true);
  t.root.remove();
  if (t.opts && t.opts.onEnd) { try { t.opts.onEnd(reason); } catch (_) { /* 콜백 오류가 정리를 막지 않게 */ } }
}

// 투어 시작 — steps 를 순서대로 안내. 이미 진행 중이면 교체.
function startTour(steps: TourStep[], opts?: TourOpts) {
  if (!Array.isArray(steps) || !steps.length) return;
  endTour();

  const dims = ['top', 'right', 'bottom', 'left'].map((s) => el('div', { class: 'tour-dim tour-dim-' + s }));
  const ring = el('div', { class: 'tour-ring', 'aria-hidden': 'true' });
  const pop = el('div', { class: 'tour-pop', role: 'dialog', 'aria-live': 'polite' });
  const root = el('div', { class: 'tour-root', role: 'presentation' }, ...dims, ring, pop);
  document.body.append(root);

  const t: any = { root, dims, ring, pop, steps, i: -1, raf: 0, clickBound: null, onKey: null, opts: opts || null };
  active = t;

  // ESC 로 투어만 종료 — 캡처 단계에서 잡고 전파를 멈춰, 아래(모달)의 ESC 닫기까지 번지지 않게 한다.
  t.onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); endTour('user'); } };
  window.addEventListener('keydown', t.onKey, true);

  go(0);

  // 타깃 해석 — 배열이면 그대로(합집합 강조용), 단일이면 1개짜리 목록. 스크롤·클릭 바인딩은 항상 첫 요소 기준.
  function resolveAll(step: TourStep): Element[] {
    let v: any;
    try { v = typeof step.target === 'function' ? step.target() : document.querySelector(step.target); }
    catch (_) { return []; }
    return (Array.isArray(v) ? v : [v]).filter(Boolean) as Element[];
  }
  function resolve(step: TourStep): Element | null { return resolveAll(step)[0] || null; }

  // 뚫을 사각형 — 요소가 여럿이면 합집합. 아직 안 뜬(넓이 0) 요소는 뺀다.
  function holeRect(step: TourStep): any {
    let l = Infinity, t0 = Infinity, r0 = -Infinity, b0 = -Infinity;
    for (const n of resolveAll(step)) {
      const q = n.getBoundingClientRect();
      if (!q.width && !q.height) continue;
      l = Math.min(l, q.left); t0 = Math.min(t0, q.top); r0 = Math.max(r0, q.right); b0 = Math.max(b0, q.bottom);
    }
    return l === Infinity ? null : { left: l, top: t0, width: r0 - l, height: b0 - t0 };
  }

  // 단계 이동 — 코치마크를 다시 그리고, 필요 시 타깃을 스크롤로 보이게 한 뒤 rAF 추적을 (없으면) 켠다.
  function go(idx: number) {
    if (idx < 0) return; // [이전]은 0에서 비활성 — 방어만
    if (idx >= steps.length) { endTour('complete'); return; } // 마지막 단계 통과 = 자연 완주
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

  // 코치마크(말풍선) 내용 — 카운터·✕닫기·제목·본문·[이전]/[다음].
  //  ✕(닫기)는 언제든 투어를 끝내는 보편 어포던스(예전 '건너뛰기' 텍스트를 대신). 실제 버튼을 눌러야만
  //  진행되는 단계(advanceOn:'click', 예: ① 새 세션·생성하기)에는 [이전]/[다음]을 두지 않는다 — 강조된
  //  버튼을 누르는 것만이 다음이고, 빠져나가려면 ✕뿐(다음으로 건너뛰면 폼이 안 열려 흐름이 깨진다).
  function drawPop(step: TourStep, idx: number) {
    const last = idx === steps.length - 1;
    const counter = el('div', { class: 'tour-count', text: (idx + 1) + ' / ' + steps.length });
    const close = el('button', { class: 'btn btn-text tour-close', text: '✕', title: '따라하기 닫기', 'aria-label': '따라하기 닫기', onclick: () => endTour('user') });
    const bodyWrap = el('div', { class: 'tour-body' });
    if (step.body != null) {
      if (Array.isArray(step.body)) bodyWrap.append(...step.body);
      else if (typeof step.body === 'string') bodyWrap.append(el('p', { class: 'tour-p', text: step.body }));
      else bodyWrap.append(step.body);
    }
    if (step.advanceOn === 'click' || step.advanceWhen) bodyWrap.append(el('p', { class: 'tour-hint', text: step.advanceWhen ? '↑ 강조된 곳을 눌러 보세요 (또는 아래 [다음]).' : '↑ 강조된 버튼을 직접 눌러 보세요.' }));
    const kids: any[] = [
      el('div', { class: 'tour-pop-top' }, counter, close),
      el('div', { class: 'tour-title', text: step.title }),
      bodyWrap,
    ];
    if (step.advanceOn !== 'click') {
      const prev = el('button', { class: 'btn btn-ghost btn-sm', text: '이전', onclick: () => go(idx - 1), disabled: idx === 0 });
      // onAdvance — [다음] 을 누르면 go 대신 이걸 실행(예: 데모 프로젝트로 라우팅). 라우팅이면 route→resume 이 흐름을 잇는다.
      const next = el('button', { class: 'btn btn-primary btn-sm', text: step.ctaNext || (last ? '마치기' : '다음 →'),
        onclick: () => { if (step.onAdvance) step.onAdvance(); else go(idx + 1); } });
      kids.push(el('div', { class: 'tour-pop-foot' }, prev, next));
    }
    pop.replaceChildren(...kids);
  }

  // 매 프레임: 타깃 위치를 다시 읽어 딤·링·말풍선을 갱신하고, click 자동진행 리스너를 (있으면) 건다.
  function tick() {
    if (active !== t) return; // 내 투어가 교체/종료됐으면 이 rAF 루프도 멈춤(스테일 프레임 방지)
    const step = steps[t.i];
    // advanceWhen — 조건(예: 도메인맵 패널 열림)이 충족되면 자동 진행. 클릭 후 타깃이 재렌더돼 click 리스너가
    //  유실되는 요소를 위한 경로(그런 요소는 advanceOn:'click' 이 안 먹는다). raf=0 로 두고 go 가 루프를 재개한다.
    if (step.advanceWhen) {
      let met = false;
      try { met = !!step.advanceWhen(); } catch (_) { met = false; }
      if (met) { t.raf = 0; go(t.i + 1); return; }
    }
    const target = resolve(step);
    const pad = step.padding == null ? 8 : step.padding;
    const r = holeRect(step);
    if (target && r && (r.width > 0 || r.height > 0)) {
      layout(r, pad);
      ring.style.display = '';
      if (step.advanceOn === 'click' && (!t.clickBound || t.clickBound.el !== target)) {
        if (t.clickBound) t.clickBound.el.removeEventListener('click', t.clickBound.fn, true);
        const cur = t.i;
        // active === t: '이 투어'가 여전히 살아 있을 때만 진행 — 지연(80ms) 사이 라우팅으로 다른 투어가
        //  올라오면(크로스탭 둘러보기 #761 장면 전환) 스테일 클로저가 새 투어를 끝내 버리는 것을 차단.
        const fn = () => { setTimeout(() => { if (active === t && t.i === cur) go(cur + 1); }, step.advanceDelay == null ? 80 : step.advanceDelay); };
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
    const spaceBelow = vh - (ht + hh), spaceAbove = ht, spaceRight = vw - (hl + hw), spaceLeft = hl;
    if (hw === 0 && hh === 0) place = 'center';
    else {
      // 지정 placement 라도 그 방향에 말풍선이 안 들어가면(작은 창) 여유 있는 쪽으로 자동 뒤집어 타깃(강조 버튼) 가림 방지(#670).
      const fits: any = { bottom: spaceBelow >= ph + gap, top: spaceAbove >= ph + gap, right: spaceRight >= pw + gap, left: spaceLeft >= pw + gap };
      if (place === 'auto' || !fits[place]) place = fits.bottom ? 'bottom' : fits.top ? 'top' : fits.right ? 'right' : fits.left ? 'left' : 'center';
    }
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

// 투어 진행 중인지 — 새 세션 폼이 '따라하기 흐름'인지 판단해(완료 안내를 새 터미널 탭으로 보낼지) 쓴다(#673).
function isTourActive(): boolean { return !!active; }

export { startTour, endTour, isTourActive };

// v2/wire-board.ts — 앱빌더 ③ 「와이어프레임(화면 흐름) 보기」 보드(#4632, 원준 2026-10-16 묶음 #8
//  «와이어프레임 이거 전체화면으로 보여줘 · 클로드 아티팩트 화면 따와서 비슷하게 · 여기서도 수정 가능하게 — 선택 · 핀 · 구역 다 있게 ·
//   피그마 보드처럼 화면 한눈에 보거나 cmd+스크롤로 확대축소 · 얇고 버튼 하나하나마다 어디로 가는지» · «한 장만 나와도 와이어프레임은 그냥 있는 거지»).
//
//  화면 전체를 덮는 창 하나: 머리줄(이름 · 버전 · 도구 · 확대 · 코멘트 · 닫기) + 점 박힌 보드. 보드 위에 AI 가 앱과 함께 저장한 그림
//   (lib/studio-flow WIREFRAME_PATH)을 원래 크기로 놓고 옮기고 · 키운다(⌘/Ctrl + 스크롤 · 핀치 = 확대축소, 스크롤 · 끌기 = 이동).
//  그 그림이 아직 없는 앱(그림을 그리라는 말이 생기기 전에 만든 앱)은 **앱 화면 그대로**를 한 장으로 놓는다 — 빈 칸 · 「그려 달라기」 는 없다.
//   다음 「수정하기」 가 그 그림을 함께 그리라고 한다(fixBrief).
//  짚기(선택 · 핀 · 영역)는 앱 화면 위 코멘트 층(app-review.ts)과 같은 꼴의 코멘트를 만든다 — on:'wire' 로 표시해 같은 목록(허브 「코멘트」 칸)에 모이고
//   「수정하기」 가 「와이어프레임의 … 자리」 로 AI 에게 보낸다. 앱 화면 위엔 그리지 않는다.
import { el, toast } from '../core.js';
import { PROBE_JS, WIREFRAME_PATH, readHitRes, whereText, type HitRes, type StudioPin, type StudioPlace } from '../lib/studio-flow.js';
import { mountAppUiFrame, type AppUiFrame } from './app-ui.js';

type Tool = 'move' | 'pick' | 'pin' | 'box';
export interface WireBoardOpts {
  appId: string;
  title: string;
  /** 머리줄 버전 글(초안 · V2 …) */
  version: string;
  place: StudioPlace;
  /** 그림 HTML — 빈 글이면 앱 화면 그대로를 한 장으로 놓는다. */
  html: string;
  /** 지금 코멘트 목록 전부(앱 화면 것 포함 — 번호를 같이 센다). 보드는 on:'wire' 만 그린다. */
  pins: () => StudioPin[];
  /** 보드에서 더하거나 고치거나 지웠다 — 목록 전부를 돌려준다. */
  onPins: (pins: StudioPin[]) => void;
  /** 열자마자 그 코멘트(목록 번호 - 1)로 옮겨 연다 — 허브 칸의 번호를 눌렀을 때. */
  focus?: number;
  onClose?: () => void;
}
export interface WireBoard {
  close(): void;
  /** 목록이 밖에서 바뀌었다(새 판이 와 보낸 코멘트가 빠졌다 · 허브에서 지웠다) — 번호 · 셈 · 열린 칸을 새 목록에 맞춘다(점검 3-5). */
  refresh(): void;
}

const TOOLS: Array<{ k: Tool; t: string; help: string; svg: string }> = [
  { k: 'move', t: '이동', help: '끌어서 보드를 옮겨요. 스페이스를 누른 채 끌어도 돼요.', svg: '<path d="M10 2.5v15M2.5 10h15"/><path d="M7.6 4.9 10 2.5l2.4 2.4M7.6 15.1 10 17.5l2.4-2.4M4.9 7.6 2.5 10l2.4 2.4M15.1 7.6 17.5 10l-2.4 2.4"/>' },
  { k: 'pick', t: '선택', help: '그림 안의 단추 · 칸 · 글을 선택해요', svg: '<path d="M7.5 6.5 16.5 11l-4.2 1.1-2 4.2z"/><path d="M3.6 8.2a4.6 4.6 0 0 1 3.1-4.3"/><path d="M3.2 4.6 4.6 5.8"/>' },
  { k: 'pin', t: '핀', help: '누른 자리에 핀을 꽂고 코멘트를 적어요.', svg: '<path d="M10 17.5s-5-5-5-8.8a5 5 0 0 1 10 0c0 3.8-5 8.8-5 8.8z"/><circle cx="10" cy="8.6" r="1.8"/>' },
  { k: 'box', t: '영역', help: '끌어서 상자를 그리면 그 영역 전체에 코멘트를 적어요.', svg: '<rect x="2.8" y="3.8" width="14.4" height="12.4" rx="2" stroke-dasharray="3 2.2"/>' },
];
const svgIcon = (inner: string): HTMLElement => {
  const s = el('span', { class: 'ico', 'aria-hidden': 'true' });
  s.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';   // 셸 코드의 고정 그림
  return s;
};
//  그림은 AI 가 쓴 HTML — 출처 없는 샌드박스에 바깥으로 나가는 길을 막는 CSP 를 앞에 붙여 싣는다(앱 화면 app-ui 의 CSP 와 같은 뜻).
const WF_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";
//  그림의 원래 크기를 알려 주는 한 줄 — 샌드박스(출처 없음)라 밖에서 못 잰다. scrollWidth 는 창보다 작아지지 않아 그림 속 것들의 끝(오른쪽 · 아래)을 잰다.
//   짚기는 PROBE_JS(앱 화면 코멘트 층과 같은 탐침)가 맡는다.
const SIZE_JS = "(function(){function s(){var b=document.body;if(!b)return;var W=0,H=0,es=b.getElementsByTagName('*');for(var i=0;i<es.length&&i<6000;i++){var r=es[i].getBoundingClientRect();if(r.width||r.height){if(r.right>W)W=r.right;if(r.bottom>H)H=r.bottom;}}var cs=getComputedStyle(b);parent.postMessage({__wire:'size',w:Math.ceil(W+(parseFloat(cs.marginRight)||0)+scrollX),h:Math.ceil(H+(parseFloat(cs.marginBottom)||0)+scrollY)},'*');}addEventListener('load',function(){s();setTimeout(s,300);});})();";

let cur: WireBoard | null = null;
export function closeWireBoard(): void { if (cur) { const c = cur; cur = null; c.close(); } }

export function openWireBoard(o: WireBoardOpts): WireBoard {
  closeWireBoard();
  const S = { tool: 'pick' as Tool, k: 1, tx: 0, ty: 0, cw: 1600, ch: 1000, user: false, space: false, drag: null as null | { kind: 'pan' | 'box'; sx: number; sy: number; tx: number; ty: number; cx: number; cy: number },
    hitSeq: 1, hoverAt: 0, active: -1, dead: false, down: false };
  const hitWaits = new Map<number, (h: HitRes | null) => void>();
  const fallback = !o.html.trim();
  const frames: AppUiFrame[] = [];

  // ── 머리줄 — 클로드 아티팩트 창처럼: 이름 · 버전 · (가운데) 도구 · 확대 · 코멘트 · 닫기 ──
  const tools = el('span', { class: 'v2-wb-tools', role: 'tablist', 'aria-label': '코멘트 다는 도구' });
  const pct = el('button', { class: 'v2-wb-pct', type: 'button', title: '100% 로' }) as HTMLButtonElement;
  const count = el('button', { class: 'btn btn-ghost btn-sm v2-wb-count', type: 'button', title: '이 그림에 단 코멘트' }) as HTMLButtonElement;
  const head = el('div', { class: 'v2-wb-head' },
    el('div', { class: 'v2-wb-name' }, el('b', { text: '「' + o.title + '」 와이어프레임' }), el('span', { class: 'v2-wb-ver', text: o.version }),
      el('small', { text: '화면에서 무엇을 누르면 다른 어느 화면으로 이어지는지 보여 줘요.' })),
    el('span', { class: 'v2-studio-sp' }), tools, el('span', { class: 'v2-studio-sp' }),
    el('span', { class: 'v2-wb-zoom' },
      el('button', { type: 'button', text: '−', title: '작게(⌘ −)', 'aria-label': '작게', onclick: () => zoomBy(1 / 1.25) }), pct,
      el('button', { type: 'button', text: '+', title: '크게(⌘ +)', 'aria-label': '크게', onclick: () => zoomBy(1.25) }),
      el('button', { type: 'button', class: 'fit', text: '한눈에', title: '그림 전체를 한눈에(⇧ 1)', onclick: () => fit() })),
    count,
    el('button', { class: 'v2-wb-x', type: 'button', text: '×', title: '닫기(Esc)', 'aria-label': '닫기', onclick: () => api.close() }));

  // ── 보드 — 점 박힌 바탕 위에 그림(세계)을 옮기고 키운다. 누름은 전부 위 덮개(catch)가 받는다(그림은 설명이라 누를 것이 없다) ──
  const world = el('div', { class: 'v2-wb-world' });
  const marks = el('div', { class: 'v2-wb-marks' });
  const ghost = el('div', { class: 'v2-wb-ghost', hidden: true });
  const catcher = el('div', { class: 'v2-wb-catch' });
  const stage = el('div', { class: 'v2-wb-stage' }, world, catcher);
  const hint = el('div', { class: 'v2-wb-hint', text: '⌘/Ctrl+스크롤이나 핀치로 확대·축소하고, 스크롤이나 스페이스+끌기로 이동해요' });
  const note = fallback ? el('div', { class: 'v2-wb-note', text: '아직 와이어프레임이 없어 앱 화면을 그대로 보여드려요. 다음에 「수정하기」를 누르면 와이어프레임도 함께 그려요.' }) : null;
  const list = el('div', { class: 'v2-wb-list', hidden: true });
  const root = el('div', { class: 'v2-wb', role: 'dialog', 'aria-modal': 'true', 'aria-label': '「' + o.title + '」 와이어프레임' }, head, el('div', { class: 'v2-wb-body' }, stage, list), hint, note);
  document.body.append(root);

  let iframe: HTMLIFrameElement | null = null;
  //  그림이 없어 앱 화면을 대신 놓은 카드들(보드 자리 px) — 거기 단 코멘트는 그 카드 안의 비율로 적는다(점검 3-8 · fixBrief 가 «보드에 놓은 앱 화면» 으로 말한다).
  const cards: Array<{ screen: 'side' | 'full'; x: number; y: number; w: number; h: number }> = [];
  const cardAt = (wx: number, wy: number): { screen: 'side' | 'full'; x: number; y: number; w: number; h: number } | null => cards.find((c) => wx >= c.x && wx <= c.x + c.w && wy >= c.y && wy <= c.y + c.h) || null;
  //  코멘트의 보드 자리(px) — 카드에 단 것은 그 카드 기준 · 그 밖(그림)은 보드 전체 기준.
  const wr = (p: StudioPin): { x: number; y: number; w: number; h: number } => {
    const c = p.screen ? cards.find((k) => k.screen === p.screen) : null;
    return c ? { x: c.x + p.x * c.w, y: c.y + p.y * c.h, w: (p.w || 0) * c.w, h: (p.h || 0) * c.h } : { x: p.x * S.cw, y: p.y * S.ch, w: (p.w || 0) * S.cw, h: (p.h || 0) * S.ch };
  };
  if (!fallback) {
    iframe = el('iframe', { class: 'v2-wb-frame', title: '「' + o.title + '」 와이어프레임', sandbox: 'allow-scripts',
      srcdoc: '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + WF_CSP + '"><script>' + SIZE_JS + PROBE_JS + '</scr' + 'ipt>' + o.html }) as HTMLIFrameElement;
    iframe.style.width = S.cw + 'px'; iframe.style.height = S.ch + 'px';
    world.append(iframe, marks, ghost);
  } else {
    //  앱 화면 그대로 — 쓰는 자리마다 한 장(세션 위젯은 좁게 · 앱 화면은 넓게). 둘 다면 나란히.
    const wants: Array<[string, number, number]> = [];
    if (o.place !== 'full') wants.push(['세션 위젯', 360, 720]);
    if (o.place !== 'side') wants.push(['앱 화면', 1200, 760]);
    let x = 0; const GAP = 80, TOP = 34;
    for (const [label, w, h] of wants) {
      cards.push({ screen: label === '세션 위젯' ? 'side' : 'full', x, y: TOP, w, h });
      const slot = el('div', { class: 'v2-wb-slot' });
      const card = el('div', { class: 'v2-wb-card', style: `left:${x}px;top:${TOP}px;width:${w}px;height:${h}px` }, el('span', { class: 'v2-wb-card-l', text: label + ' · 지금 화면' }), slot);
      world.append(card);
      void mountAppUiFrame(o.appId, { title: o.title }).then((f) => { if (S.dead) { f.destroy(); return; } frames.push(f); slot.append(f.root); }).catch((e: any) => { slot.append(el('p', { class: 'v2-wb-err', text: '앱 화면을 열지 못했어요. ' + (e && e.message ? e.message : e) })); });
      x += w + GAP;
    }
    S.cw = Math.max(400, x - GAP); S.ch = TOP + Math.max(...wants.map((w) => w[2]));
    world.append(marks, ghost);
  }
  world.style.width = S.cw + 'px'; world.style.height = S.ch + 'px';

  // ── 옮기기 · 키우기 ──
  const apply = (): void => {
    world.style.transform = `translate(${S.tx}px, ${S.ty}px) scale(${S.k})`;
    pct.textContent = Math.round(S.k * 100) + '%';
    stage.style.backgroundSize = `${20 * S.k}px ${20 * S.k}px`;
    stage.style.backgroundPosition = `${S.tx}px ${S.ty}px`;
    paintMarks(); placePop();
  };
  const clampK = (k: number): number => Math.min(4, Math.max(0.1, k));
  const zoomAt = (k: number, px: number, py: number): void => {
    const nk = clampK(k); const wx = (px - S.tx) / S.k, wy = (py - S.ty) / S.k;
    S.k = nk; S.tx = px - wx * nk; S.ty = py - wy * nk; apply();
  };
  const zoomBy = (f: number): void => { S.user = true; const r = stage.getBoundingClientRect(); zoomAt(S.k * f, r.width / 2, r.height / 2); };
  const fit = (): void => {
    const r = stage.getBoundingClientRect(); const pad = 48;
    const k = clampK(Math.min((r.width - pad * 2) / S.cw, (r.height - pad * 2) / S.ch, 1));
    S.k = k; S.tx = (r.width - S.cw * k) / 2; S.ty = Math.max(pad, (r.height - S.ch * k) / 2); apply();
  };
  pct.onclick = () => { S.user = true; const r = stage.getBoundingClientRect(); zoomAt(1, r.width / 2, r.height / 2); };
  catcher.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault(); S.user = true;
    const r = stage.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(S.k * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), e.clientX - r.left, e.clientY - r.top);   // 핀치 · ⌘ + 스크롤
    else { const f = e.deltaMode === 1 ? 16 : 1; S.tx -= e.deltaX * f; S.ty -= e.deltaY * f; apply(); }
  }, { passive: false });

  // ── 그림 안의 자리 ↔ 보드 자리 ──
  const toWorld = (cx: number, cy: number): { x: number; y: number } => { const r = stage.getBoundingClientRect(); return { x: (cx - r.left - S.tx) / S.k, y: (cy - r.top - S.ty) / S.k }; };
  const inWorld = (p: { x: number; y: number }): boolean => p.x >= 0 && p.y >= 0 && p.x <= S.cw && p.y <= S.ch;
  //  그림 안 무엇이 거기 있나 — 탐침(PROBE_JS)에 물어본다. 앱 화면 그대로(대신 놓은 것)는 묻지 않는다(그 자리의 글만 없다).
  const hit = (fx: number, fy: number): Promise<HitRes | null> => new Promise((res) => {
    const w = iframe && iframe.contentWindow; if (!w) { res(null); return; }
    const id = S.hitSeq++; hitWaits.set(id, res); w.postMessage({ __studio: 'hit', x: fx, y: fy, id }, '*');
    window.setTimeout(() => { if (hitWaits.has(id)) { hitWaits.delete(id); res(null); } }, 700);
  });
  const onMsg = (ev: MessageEvent): void => {
    if (!iframe || ev.source !== iframe.contentWindow) return;
    const m: any = ev.data; if (!m || typeof m !== 'object') return;
    if (m.__wire === 'size') {
      //  레이아웃 전의 이른 소식(0 · 아주 작음)은 버린다. 폭은 1200 아래로 좁히지 않는다 — 좁히면 그림이 그 폭으로 다시 흘러 갇힌다.
      const rw = Math.round(Number(m.w) || 0), rh = Math.round(Number(m.h) || 0);
      if (rw < 50 || rh < 50) return;
      const w = Math.min(12000, Math.max(1200, rw)), h = Math.min(12000, Math.max(400, rh));
      if (w !== S.cw || h !== S.ch) { S.cw = w; S.ch = h; iframe.style.width = w + 'px'; iframe.style.height = h + 'px'; world.style.width = w + 'px'; world.style.height = h + 'px'; }
      if (!S.user) fit(); else apply();   // 사람이 아직 안 옮기고 안 키웠으면 늘 한눈에
      if (wantFocus >= 0) { const i = wantFocus; wantFocus = -1; focusPin(i); }
      return;
    }
    //  그림(AI 가 쓴 HTML)이 돌려준 값 — 실제 화면 막대와 같은 거르기(readHitRes · AI 에게 가는 고침 글에 실린다).
    const h = readHitRes(m);
    if (h && hitWaits.has(h.id)) { const f = hitWaits.get(h.id)!; hitWaits.delete(h.id); f(h); }
  };
  window.addEventListener('message', onMsg);
  const clearProbe = (): void => { const w = iframe && iframe.contentWindow; if (w) w.postMessage({ __studio: 'clear' }, '*'); };

  // ── 코멘트(on:'wire') — 보드 위 번호 · 자리 코멘트 칸 ──
  const all = (): StudioPin[] => o.pins();
  const changed = (): void => { o.onPins(all()); paintCount(); paintMarks(); if (!list.hidden) paintList(); };
  const paintCount = (): void => {
    const mine = all().filter((p) => p.on === 'wire' && !p.sent); const n = mine.filter((p) => p.note.trim()).length;   // 보내서 반영 중인 것은 세지 않는다
    count.textContent = '코멘트 ' + n + '건' + (mine.length > n ? ' · 빈 코멘트 ' + (mine.length - n) + '건' : '');
  };
  const paintMarks = (): void => {
    marks.replaceChildren();
    all().forEach((p, i) => {
      if (p.on !== 'wire') return;
      const hot = !!popPin && p === popPin;
      const r = wr(p);
      if (p.kind === 'pick' || p.kind === 'box') {
        const b = el('div', { class: 'v2-wb-mk-box' + (p.kind === 'pick' ? ' pick' : '') + (hot ? ' hot' : '') + (p.sent ? ' sent' : '') });
        Object.assign(b.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
        marks.append(b);
      }
      //  번호는 화면 크기 그대로(확대해도 같은 크기) — 보드 배율의 역수로 되돌린다.
      //  보낸 코멘트(반영 중)는 흐리게 · 눌러도 칸을 열지 않는다 — 실제 화면 막대(app-review)와 같은 규칙.
      const n = el('button', { type: 'button', class: 'v2-wb-mk-n' + (p.kind === 'pick' || p.kind === 'box' ? '' : ' pin') + (hot ? ' hot' : '') + (p.sent ? ' sent' : ''),
        title: p.sent ? 'AI가 반영하고 있어요. ' + (p.note || p.where || '') : p.note || p.where || '', 'aria-label': (i + 1) + (p.sent ? '번 코멘트, 반영 중' : '번 코멘트 열기'),
        onclick: (e: MouseEvent) => { e.stopPropagation(); if (!p.sent) openPop(i); } }, el('span', { text: String(i + 1) }));
      Object.assign(n.style, { left: r.x + 'px', top: r.y + 'px', transform: `translate(-50%, -50%) scale(${1 / S.k})` });
      marks.append(n);
    });
  };
  //  열린 칸은 번호가 아니라 **그 코멘트(객체)** 를 든다 — 보드를 연 채 새 판이 와 보낸 코멘트가 빠지면 번호가 당겨지는데,
  //   번호를 들고 있으면 「취소」 가 다른 코멘트를 지웠다(점검 3-5). 번호 글은 그릴 때마다 지금 목록에서 센다.
  let pop: HTMLElement | null = null, popPin: StudioPin | null = null;
  //  칸은 짚은 곳 옆 — 보드 화면의 남는 쪽으로(오른쪽이 모자라면 왼쪽). 옮기고 키울 때마다 따라간다.
  const placePop = (): void => {
    const p = popPin; if (!pop || !p) return;
    const r = stage.getBoundingClientRect(), W = 300, q = wr(p);
    const ax = S.tx + (q.x + q.w) * S.k, ay = S.ty + q.y * S.k;
    const left = ax + 14 + W < r.width ? ax + 14 : Math.max(8, S.tx + q.x * S.k - W - 14);
    Object.assign(pop.style, { left: Math.round(left) + 'px', top: Math.round(Math.min(Math.max(8, ay), r.height - 170)) + 'px', width: W + 'px' });
    const i = all().indexOf(p), hb = pop.querySelector('.h b');
    if (hb) hb.textContent = (i + 1) + ' · ' + (p.kind === 'pick' ? '선택한 요소' : p.kind === 'box' ? '영역' : '핀');
    pop.setAttribute('aria-label', (i + 1) + '번 코멘트');
  };
  const closePop = (): void => { const had = !!popPin; if (pop) { pop.remove(); pop = null; } popPin = null; S.active = -1; if (had) paintMarks(); };
  const removePin = (p: StudioPin): void => { const ps = all(); const j = ps.indexOf(p); if (j >= 0) ps.splice(j, 1); closePop(); changed(); };
  const openPop = (i: number): void => {
    const p = all()[i]; if (!p || p.sent) return;
    if (pop) pop.remove();
    S.active = i; popPin = p; paintMarks();
    const ta = el('textarea', { class: 'ta', rows: '2', placeholder: '이 자리를 어떻게 고칠까요', 'aria-label': (i + 1) + '번 코멘트' }) as HTMLTextAreaElement; ta.value = p.note;
    ta.addEventListener('input', () => { p.note = ta.value; o.onPins(all()); paintCount(); });
    ta.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); closePop(); changed(); } });   // Esc 는 문서의 onKey 가(칸 먼저 닫고 · 다음에 보드)
    const pp = el('div', { class: 'v2-studio-pop v2-wb-pop', role: 'dialog', 'aria-label': (i + 1) + '번 코멘트' },
      el('div', { class: 'h' }, el('b', { text: (i + 1) + ' · ' + (p.kind === 'pick' ? '선택한 요소' : p.kind === 'box' ? '영역' : '핀') }), el('small', { text: p.where || '' })), ta,
      el('div', { class: 'act' }, el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '취소', title: '이 자리 코멘트를 지워요', onclick: () => removePin(p) }),
        el('button', { type: 'button', class: 'v2-studio-now-pri', text: '완료', onclick: () => { closePop(); changed(); } })));
    pop = pp; stage.append(pp); placePop();
    requestAnimationFrame(() => ta.focus());
  };
  const addPin = (p: StudioPin): void => { const ps = all(); ps.push({ ...p, on: 'wire' }); o.onPins(ps); paintCount(); openPop(ps.length - 1); };
  const paintList = (): void => {
    const rows = all().map((p, i) => [p, i] as const).filter(([p]) => p.on === 'wire');
    list.replaceChildren(el('div', { class: 'v2-wb-list-h' }, el('b', { text: '이 그림에 단 코멘트' }), el('small', { text: '앱빌더의 「코멘트」 칸에도 함께 모여요' })),
      ...(rows.length ? rows.map(([p, i]) => el('button', { type: 'button', class: 'v2-wb-list-row', onclick: () => { focusPin(i); } },
        el('span', { class: 'n', text: String(i + 1) }), el('span', { class: 'w', text: p.note.trim() || '(아직 안 적음) ' + (p.where || '') })))
        : [el('p', { class: 'v2-wb-list-empty', text: '선택 · 핀 · 영역으로 그림 위에 코멘트를 남기면 여기 모여요.' })]));
  };
  const focusPin = (i: number): void => {
    const p = all()[i]; if (!p) return;
    const r = stage.getBoundingClientRect();
    const q = wr(p);
    S.user = true; S.tx = r.width / 2 - (q.x + q.w / 2) * S.k; S.ty = r.height / 2 - (q.y + q.h / 2) * S.k; apply(); openPop(i);
  };
  count.onclick = () => { list.hidden = !list.hidden; if (!list.hidden) paintList(); };

  // ── 도구 · 누르기 ──
  const setTool = (k: Tool): void => { S.tool = k; closePop(); clearProbe(); paintTools(); };
  const paintTools = (): void => {
    tools.replaceChildren(...TOOLS.map((x) => el('button', { type: 'button', role: 'tab', class: x.k === S.tool ? 'on' : '', 'aria-selected': x.k === S.tool ? 'true' : 'false', title: x.t + '\n' + x.help, onclick: () => setTool(x.k) }, svgIcon(x.svg), el('span', { text: x.t }))));
    root.dataset.tool = S.space ? 'move' : S.tool;
  };
  const panning = (): boolean => S.tool === 'move' || S.space;
  //  번호 단추는 덮개(catch) 아래에 있다 — 누른 자리가 번호 위면 덮개가 대신 그 코멘트를 연다(도구 동작은 하지 않는다).
  const badgeAt = (x: number, y: number): number => {
    for (const n of Array.from(marks.querySelectorAll('.v2-wb-mk-n')) as HTMLElement[]) { const q = n.getBoundingClientRect(); if (x >= q.left && x <= q.right && y >= q.top && y <= q.bottom) return Number(n.textContent) - 1; }
    return -1;
  };
  catcher.addEventListener('pointerdown', (e: PointerEvent) => {
    S.down = false;
    if (e.button !== 0 && e.button !== 1) return;
    const bi = e.button === 0 && !panning() ? badgeAt(e.clientX, e.clientY) : -1;
    if (bi >= 0) { if (pop) changed(); openPop(bi); return; }
    if (pop) { closePop(); changed(); return; }   // 열린 칸 밖을 누르면 먼저 닫기만 한다(새 코멘트를 만들지 않는다)
    const wp = toWorld(e.clientX, e.clientY);
    S.down = true;
    if (panning() || e.button === 1) { S.user = true; S.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, tx: S.tx, ty: S.ty, cx: wp.x, cy: wp.y }; catcher.setPointerCapture(e.pointerId); return; }
    if (S.tool === 'box' && inWorld(wp)) { S.drag = { kind: 'box', sx: e.clientX, sy: e.clientY, tx: S.tx, ty: S.ty, cx: wp.x, cy: wp.y }; catcher.setPointerCapture(e.pointerId); }
  });
  const cancelDrag = (): void => { S.drag = null; S.down = false; ghost.hidden = true; };
  catcher.addEventListener('pointercancel', cancelDrag);
  catcher.addEventListener('lostpointercapture', () => { if (S.drag && S.drag.kind === 'pan') cancelDrag(); });
  catcher.addEventListener('pointermove', (e: PointerEvent) => {
    const d = S.drag;
    if (d && d.kind === 'pan') { S.tx = d.tx + (e.clientX - d.sx); S.ty = d.ty + (e.clientY - d.sy); apply(); return; }
    if (d && d.kind === 'box') {
      const wp = toWorld(e.clientX, e.clientY);
      const x = Math.max(0, Math.min(d.cx, wp.x)), y = Math.max(0, Math.min(d.cy, wp.y)), w = Math.min(S.cw, Math.max(d.cx, wp.x)) - x, h = Math.min(S.ch, Math.max(d.cy, wp.y)) - y;
      ghost.hidden = false; Object.assign(ghost.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
      return;
    }
    //  선택 — 올리면 무엇이 골라질지 그림 안에 테두리(탐침이 그린다)
    if (S.tool === 'pick' && !S.space && iframe && Date.now() - S.hoverAt > 70) {
      S.hoverAt = Date.now(); const wp = toWorld(e.clientX, e.clientY);
      if (inWorld(wp)) void hit(wp.x / S.cw, wp.y / S.ch); else clearProbe();
    }
  });
  catcher.addEventListener('pointerup', async (e: PointerEvent) => {
    if (!S.down || (e.button !== 0 && e.button !== 1)) return;   // 눌러 시작한 짓이 없으면(칸 닫기 · 오른쪽 단추) 아무것도 안 한다
    S.down = false;
    const d = S.drag; S.drag = null;
    if (d && d.kind === 'pan') return;
    const wp = toWorld(e.clientX, e.clientY);
    if (d && d.kind === 'box') {
      ghost.hidden = true;
      const x = Math.max(0, Math.min(d.cx, wp.x)), y = Math.max(0, Math.min(d.cy, wp.y)), w = Math.min(S.cw, Math.max(d.cx, wp.x)) - x, h = Math.min(S.ch, Math.max(d.cy, wp.y)) - y;
      if (w < 8 || h < 8) return;
      if (fallback) {
        //  앱 화면을 대신 놓은 보드 — 상자는 가운데가 든 카드 안으로 자르고 그 카드 기준으로 적는다. 카드 밖(빈 보드)이면 만들지 않는다.
        const c = cardAt(x + w / 2, y + h / 2); if (!c) return;
        const l = Math.max(c.x, x), t = Math.max(c.y, y), rr = Math.min(c.x + c.w, x + w), bb = Math.min(c.y + c.h, y + h);
        addPin({ kind: 'box', x: (l - c.x) / c.w, y: (t - c.y) / c.h, w: (rr - l) / c.w, h: (bb - t) / c.h, where: '', note: '', screen: c.screen });
        return;
      }
      const r = await hit((x + w / 2) / S.cw, (y + h / 2) / S.ch); if (S.dead) return; clearProbe();
      addPin({ kind: 'box', x: x / S.cw, y: y / S.ch, w: w / S.cw, h: h / S.ch, where: r ? whereText({ tag: r.tag, text: r.text }) : '', note: '' });
      return;
    }
    if (!inWorld(wp) || panning()) return;
    if (fallback) {
      //  앱 화면 그대로(대신 놓은 것)는 탐침이 없다 — 선택도 그 자리 핀으로, 그 카드 안의 비율로 적는다. 카드 밖이면 만들지 않는다.
      const c = cardAt(wp.x, wp.y); if (!c || (S.tool !== 'pin' && S.tool !== 'pick')) return;
      addPin({ kind: 'pin', x: (wp.x - c.x) / c.w, y: (wp.y - c.y) / c.h, where: '', note: '', screen: c.screen });
      return;
    }
    const fx = wp.x / S.cw, fy = wp.y / S.ch;
    if (S.tool === 'pin') {
      const r = await hit(fx, fy); if (S.dead) return; clearProbe();
      addPin({ kind: 'pin', x: fx, y: fy, where: r ? whereText({ tag: r.tag, text: r.text }) : '', note: '' });
    } else if (S.tool === 'pick') {
      const r = await hit(fx, fy); if (S.dead) return;
      if (r && r.rect) addPin({ kind: 'pick', x: r.rect.l, y: r.rect.t, w: r.rect.w, h: r.rect.h, where: whereText({ tag: r.tag, text: r.text }), note: '' });
      else addPin({ kind: 'pin', x: fx, y: fy, where: '', note: '' });   // 그림이 답하지 않았다 — 그 자리에 핀
      clearProbe();
    }
  });

  // ── 자판 — Esc 닫기 · ⌘± 확대 · ⇧1 한눈에 · 스페이스 끌기 ──
  const onKey = (e: KeyboardEvent): void => {
    if (!root.isConnected) { document.removeEventListener('keydown', onKey, true); return; }
    const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    //  한글 조합 중의 Esc 는 조합을 끝내는 키다 — 칸을 닫지 않는다(점검 3-13).
    if (e.key === 'Escape') { if (e.isComposing || e.keyCode === 229) return; e.stopPropagation(); if (pop) { closePop(); changed(); } else api.close(); return; }
    if (typing) return;
    const onButton = e.target instanceof HTMLElement && e.target.tagName === 'BUTTON';
    if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomBy(1.25); }
    else if ((e.metaKey || e.ctrlKey) && e.key === '-') { e.preventDefault(); zoomBy(1 / 1.25); }
    else if ((e.metaKey || e.ctrlKey) && e.key === '0') { e.preventDefault(); pct.click(); }
    else if (e.shiftKey && e.key === '!') { e.preventDefault(); fit(); }
    else if (e.key === ' ' && !onButton) { e.preventDefault(); if (!S.space) { S.space = true; paintTools(); } }   // 단추 위의 스페이스는 그 단추를 누른다(자판 사용)
  };
  const onKeyUp = (e: KeyboardEvent): void => { if (e.key === ' ' && S.space) { e.preventDefault(); S.space = false; paintTools(); } };
  const onBlur = (): void => { if (S.space) { S.space = false; paintTools(); } cancelDrag(); };
  window.addEventListener('blur', onBlur);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKeyUp, true);
  const onResize = (): void => { if (!S.dead) apply(); };
  window.addEventListener('resize', onResize);

  paintTools(); paintCount();
  //  허브 칸의 번호로 열었으면 그 코멘트로 — 그림 크기를 알고 나서(없는 그림이면 바로)
  let wantFocus = o.focus != null && o.focus >= 0 ? o.focus : -1;
  requestAnimationFrame(() => { if (S.dead) return; fit(); if (fallback && wantFocus >= 0) { const i = wantFocus; wantFocus = -1; focusPin(i); } });
  window.setTimeout(() => { if (!S.dead && wantFocus >= 0) { const i = wantFocus; wantFocus = -1; focusPin(i); } }, 1600);
  root.tabIndex = -1; root.focus();   // 닫기 단추에 두면 스페이스 끌기가 그 단추를 누른다
  //  머리줄 단추를 마우스로 눌러도 초점은 보드에 남긴다 — 단추에 남으면 스페이스가 그 단추를 누르고(끌기 대신) 다음 끌기가 도구를 쓴다. 자판으로 누르기는 그대로.
  head.addEventListener('mousedown', (e) => { if ((e.target as HTMLElement).closest('button')) e.preventDefault(); });

  const api: WireBoard = {
    close() {
      if (S.dead) return; S.dead = true;
      document.removeEventListener('keydown', onKey, true); document.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('message', onMsg); window.removeEventListener('resize', onResize); window.removeEventListener('blur', onBlur);
      frames.forEach((f) => { try { f.destroy(); } catch (_) { /* 이미 떨어졌다 */ } });
      root.remove(); if (cur === api) cur = null;
      if (o.onClose) o.onClose();
    },
    refresh() {
      if (S.dead) return;
      if (popPin && !all().includes(popPin)) closePop();
      S.active = popPin ? all().indexOf(popPin) : -1;
      paintCount(); paintMarks(); placePop(); if (!list.hidden) paintList();
    },
  };
  cur = api;
  if (!fallback && !o.html.includes('<')) toast('와이어프레임을 읽지 못했어요. (' + WIREFRAME_PATH + ')');
  return api;
}

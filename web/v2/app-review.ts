// v2/app-review.ts — 앱빌더 「③ 시안 확인 · 고치기」 의 **진짜 화면 위 코멘트 층**(#4632, 원준 2026-10-14 «대충 구현한 앱 화면이랑 세션 위젯을 보여주지 말고
//  … 실제로 이게 들어간 라이블리 화면에서 활용되는 진짜 리얼 뷰 · 사이드바 그대로 있고, 대신 그 위에 코멘트 남기는 거만 기능으로»).
//
//  앱빌더(app-studio.ts ③)가 가운데 단추로 보낸다 — 세션 위젯 = **시험 세션**(app-try-session.ts — 앱을 만드는 세션과 다른 진짜 AI 세션의 진짜 화면, 우측 사이드바에 앱 ·
//   앱을 만드는 세션은 들이지 않는다 · 원준 2026-10-15), 앱 화면 = 앱 찾기에서 연 것과 같은 #/i/<앱>(셸이 평소대로 그린다). 이 층이 그 위에 뜬다:
//   · 막대 — 「‹ 앱빌더」 · 앱 이름 · 버전 · 도구(써 보기 · 선택 · 핀 · 영역) · 「의견 n건」 · 「수정하기」 · 「완료 · 다음 단계로」.
//     자리(dock)를 주면 그 안에 들어앉고(시험 세션의 문패 줄 위 — 세션의 입력칸을 가리지 않게), 없으면 아래 가운데 떠 있다(↑ 로 위로).
//   · 핀 · 상자 · 그 자리 의견 칸 — 그 앱의 프레임(iframe.v2-appui-frame[data-app-id], app-ui.ts) 자리를 따라 fixed 로 뜬다.
//     화면 구조를 모른다 — 곁칸이든 화면 가득이든 프레임이 보이는 곳이면 거기에 선다. 프레임이 안 보이면 막대가 그 말을 한다.
//   · 고르기 · 핀은 프레임 안 탐침(PROBE_JS)에게 그 자리의 요소(태그 · 글 · 테두리)를 묻는다 — app-ui 가 검토 중인 앱(markReviewProbe)의 문서에만 넣는다.
//  상태(짚은 곳 · 앱 전체 의견 · 판 · 기다림)는 부르는 쪽(앱빌더 만들기 화면)이 쥔다 — 이 층은 보여 주고 받아 적고(onChange) 단추를 전할 뿐(onSend · onLike · onBack).
//  떠나면(다른 주소로 · 「‹ 앱빌더」 · 부르는 쪽이 close) 층과 막대를 걷는다. 한 번에 하나만 뜬다.
import { el } from '../core.js';
import { markReviewProbe } from './app-ui.js';
import { verName, whereText, type StudioPin } from '../lib/studio-flow.js';

export type ReviewTool = 'try' | 'pick' | 'pin' | 'box';
export interface ReviewHost {
  appId: string; title: string;
  /** 보낼 실제 화면의 주소 — #/i/<앱>(앱 화면) · 시험 세션은 지금 주소(앱빌더). 이 주소를 벗어나면 층을 걷는다. */
  route: string;
  /** 막대가 들어앉을 자리(시험 세션의 문패 줄 위) — 없으면 화면 아래 가운데 떠 있다. */
  dock?: HTMLElement;
  pins: StudioPin[]; general: string;   // 부르는 쪽의 것 **그대로**(같은 배열 · 값) — 이 층이 더하고 지우고 고친 뒤 onChange 로 알린다
  version: number; waiting: boolean;
  onChange: (p: { pins: StudioPin[]; general: string }) => void;
  onSend: () => void; onLike: () => void; onBack: () => void;
  /** 층이 걷혔다(다른 데로 갔다 · close) — 부르는 쪽이 손잡이를 놓는다. */
  onClose?: () => void;
}
export interface ReviewApi {
  /** 판 · 기다림 · 이름 · 의견이 바뀌었다(새 판이 왔다 · 보냈다 · 앱빌더 쪽에서 고쳤다). note 를 주면 막대에 잠깐 띄운다(«2판 · 고쳤어요»). */
  update(p: { version?: number; waiting?: boolean; title?: string; note?: string; pins?: StudioPin[]; general?: string }): void;
  close(): void;
  isOpen(): boolean;
}
//  도구 그림은 이모지가 아니라 선 그림(원준 2026-10-15 «이모지 짜침 · 너가 아이콘 그려 · 써 보기와 맞는 걸로») — 20칸 격자 · 글자색을 따른다.
//   원준 2026-10-16 «고르기 아이콘이 영역 아이콘 같아 · 영역으로 보내고 · 써 보기에 있는 걸 고르기로 · 써 보기는 새로» —
//   써 보기 = 누르는 손가락과 눌림 표시 · 선택(옛 고르기) = 누르는 화살표와 눌린 물결 · 핀 = 핀 · 영역 = 점선 상자(묶음 #7 «영역은 점선 박스로»).
const TOOL_SVG: Record<ReviewTool, string> = {
  try: '<path d="M8.2 12.6V5.4a1.3 1.3 0 0 1 2.6 0v3.8"/><path d="M10.8 9.2v-.6a1.3 1.3 0 0 1 2.6 0v1"/><path d="M13.4 9.6a1.3 1.3 0 0 1 2.6 0v2.8a5.2 5.2 0 0 1-5.2 5.2H10a4.6 4.6 0 0 1-3.6-1.7l-2.5-3.1a1.25 1.25 0 0 1 1.9-1.6l2.4 2.4"/><path d="M5.4 3.4 6.6 4.2M9.5 1v1.3M13.6 3.4l-1.2.8"/>',
  pick: '<path d="M7.5 6.5 16.5 11l-4.2 1.1-2 4.2z"/><path d="M3.6 8.2a4.6 4.6 0 0 1 3.1-4.3"/><path d="M3.2 4.6 4.6 5.8"/>',
  pin: '<path d="M10 17.5s-5-5-5-8.8a5 5 0 0 1 10 0c0 3.8-5 8.8-5 8.8z"/><circle cx="10" cy="8.6" r="1.8"/>',
  box: '<rect x="2.8" y="3.8" width="14.4" height="12.4" rx="2" stroke-dasharray="3 2.2"/>',
};
function toolIcon(k: ReviewTool): HTMLElement {
  const s = el('span', { class: 'ico', 'aria-hidden': 'true' });
  s.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + TOOL_SVG[k] + '</svg>';   // 셸 코드의 고정 글(앱이 주는 것이 아니다)
  return s;
}
const TOOLS: Array<{ k: ReviewTool; t: string; help: string }> = [
  { k: 'try', t: '써 보기', help: '직접 써 보면서 앱의 실제 동작을 확인해요.' },
  { k: 'pick', t: '선택', help: '앱 안의 버튼 · 칸 · 글을 선택해요' },
  { k: 'pin', t: '핀', help: '누른 자리에 핀을 꽂고 코멘트를 적어요.' },
  { k: 'box', t: '영역', help: '끌어서 상자를 그리면 그 영역 전체에 코멘트를 적어요.' },
];
let cur: ReviewApi | null = null;
export function reviewOpen(): boolean { return !!cur && cur.isOpen(); }
export function closeReview(): void { if (cur) { const c = cur; cur = null; c.close(); } }

export function openReview(host: ReviewHost): ReviewApi {
  closeReview();
  const routeBase = host.route.split('?')[0];
  const S = { tool: 'pick' as ReviewTool, active: -1, hoverAt: 0, hitSeq: 1, hitWaits: {} as Record<number, (h: any) => void>, frame: null as HTMLIFrameElement | null, dead: false, tick: 0, noteT: 0, waitT0: 0, waitTick: 0, top: false };
  markReviewProbe(host.appId, true);

  // ── 막대 ──
  const bar = el('div', { class: 'v2-review-bar', role: 'toolbar', 'aria-label': '시안 코멘트' });
  const name = el('b', { text: '「' + host.title + '」' });
  const ver = el('span', { class: 'v2-review-ver', text: verName(host.version) });
  const tools = el('span', { class: 'v2-studio-tools v2-review-tools', role: 'tablist', 'aria-label': '코멘트 다는 도구' });
  const count = el('button', { class: 'btn btn-ghost btn-sm v2-review-count', type: 'button' }) as HTMLButtonElement;
  const send = el('button', { class: 'v2-studio-now-pri', type: 'button' }) as HTMLButtonElement;
  const like = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '완료 · 다음 단계로', title: '고칠 곳이 없으면 다음 단계로', onclick: () => host.onLike() }) as HTMLButtonElement;
  const hint = el('small', { class: 'v2-review-hint' });
  //  지금 보는 화면이 어느 꼴인지(원준 2026-10-16 «지금 보고 있는 창이 앱 전체 창인지 위젯 창인지만 구분해서 알려 주고») — 막대가 문패 줄에 얹혔으면 시험 세션의 세션 위젯.
  const mode = el('span', { class: 'v2-review-mode' + (host.dock ? ' widget' : ' app'), text: host.dock ? '세션 위젯으로 보는 중' : '앱 화면으로 보는 중',
    title: host.dock ? '시험 세션의 우측 사이드바에 붙은 모습이에요' : '실제 앱의 사용 화면과 동일한 화면이에요' });
  //  앱 전체 코멘트를 막대에서 바로(원준 2026-10-16 «그 창에 바로바로 텍스트 쳐서 전체 앱 코멘트도 바로바로») — 「코멘트 n건」 칸의 앱 전체 줄과 같은 값.
  const gen = el('input', { class: 'v2-review-gen', type: 'text', placeholder: '앱 전체 코멘트 · 예: 글자 조금 크게', 'aria-label': '앱 전체 코멘트' }) as HTMLInputElement;
  gen.value = host.general;
  gen.addEventListener('input', () => {
    host.general = gen.value; changed();
    const tg = document.querySelector('.v2-review-tray .v2-studio-tray-row.all input') as HTMLInputElement | null; if (tg) tg.value = gen.value;   // 열린 코멘트 칸의 앱 전체 줄도 같이
  });
  gen.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); gen.blur(); } });
  const note = el('span', { class: 'v2-review-note', hidden: true });
  const flip = el('button', { class: 'btn btn-ghost btn-sm v2-review-flip', type: 'button', text: '↑', title: '막대를 위나 아래로 옮겨요', 'aria-label': '막대 자리 바꾸기', onclick: () => { S.top = !S.top; bar.classList.toggle('v2-review-bar--top', S.top); flip.textContent = S.top ? '↓' : '↑'; } });
  bar.append(
    el('button', { class: 'btn btn-ghost btn-sm v2-review-back', type: 'button', text: '‹ 앱빌더', title: '앱빌더로 돌아가요. 적은 코멘트는 그대로 남아요.', onclick: () => host.onBack() }),
    el('span', { class: 'v2-review-name' }, name, ver), mode, el('i', { class: 'v2-review-sep' }),
    tools, count, gen, el('span', { class: 'v2-studio-sp' }), note, like, send, flip,
    hint);
  // ── 층 — 프레임 자리를 따라간다 ──
  const layer = el('div', { class: 'v2-review-layer', hidden: true });
  const ov = el('div', { class: 'v2-studio-overlay v2-review-ov' });
  layer.append(ov);
  //  자리(dock)에 얹히면 한 줄로 — 도움말은 막대 가운데(의견 n건 뒤)에서 남는 폭을 쓰고 넘치면 말줄임(문패 줄 높이를 넘지 않게).
  if (host.dock) { bar.classList.add('v2-review-bar--dock'); flip.hidden = true; count.after(hint); host.dock.append(bar); document.body.append(layer); }
  else document.body.append(layer, bar);

  const cmCount = (): number => host.pins.filter((p) => p.note.trim()).length + (host.general.trim() ? 1 : 0);
  const changed = (): void => { host.onChange({ pins: host.pins, general: host.general }); paintBar(); };
  const paintBar = (): void => {
    const n = cmCount();
    tools.replaceChildren(...TOOLS.map((x) => { const b = el('button', { type: 'button', role: 'tab', class: x.k === S.tool ? 'on' : '', 'aria-selected': x.k === S.tool ? 'true' : 'false', title: x.t + '\n' + x.help, onclick: () => setTool(x.k) }, toolIcon(x.k), el('span', { text: x.t })) as HTMLButtonElement; b.disabled = host.waiting; return b; }));
    const blank = host.pins.filter((p) => !p.note.trim()).length;
    count.textContent = '코멘트 ' + n + '건' + (blank ? ' · 빈 코멘트 ' + blank : '');
    count.title = '적은 코멘트 · 앱 전체 코멘트';
    send.textContent = host.waiting ? 'AI 수정 중…' : '수정하기' + (n ? ' · ' + n + '건' : '');
    send.disabled = host.waiting || n === 0; like.disabled = host.waiting;
    if (document.activeElement !== gen) gen.value = host.general;   // 허브 · 코멘트 칸에서 고친 것도 막대 칸에 · 치는 중엔 건드리지 않는다
    gen.disabled = host.waiting;
    ver.textContent = verName(host.version);
    const t = TOOLS.find((x) => x.k === S.tool) || TOOLS[1];
    hint.textContent = host.waiting ? 'AI가 수정하고 있어요. 다음 버전이 나오면 앱이 바뀌어요.' : !S.frame ? (host.dock ? '앱을 여는 중이에요. 시안을 보고 수정할 내용을 알려주세요.' : '앱이 아직 안 보여요. 앱 화면이 뜨면 코멘트를 남길 수 있어요.') : t.help;
    layer.hidden = !S.frame || host.waiting;
    ov.dataset.tool = S.tool; ov.hidden = S.tool === 'try';
  };
  const setTool = (k: ReviewTool): void => { S.tool = k; closePop(); const w = frameWin(); if (w) w.postMessage({ __studio: 'clear' }, '*'); paintBar(); paintMarks(); };
  count.onclick = () => openTray();
  send.onclick = () => { if (cmCount()) host.onSend(); };

  // ── 프레임 찾기 · 따라가기 ──
  const frameWin = (): Window | null => (S.frame && S.frame.contentWindow) || null;
  const findFrame = (): HTMLIFrameElement | null => {
    let best: HTMLIFrameElement | null = null, area = 0;
    document.querySelectorAll('iframe.v2-appui-frame[data-app-id="' + CSS.escape(host.appId) + '"]').forEach((n) => {
      const f = n as HTMLIFrameElement; const r = f.getBoundingClientRect();
      if (r.width < 40 || r.height < 40 || !f.getClientRects().length) return;
      //  떠 있는 창(다른 화면의 덮개) 속이 아닌, 지금 화면에 보이는 것 — 가운데 점이 그 프레임(또는 그 위 층)에 닿는가
      const hit = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + 24, r.bottom - 1));
      if (hit && hit !== f && !layer.contains(hit) && !f.contains(hit)) return;
      if (r.width * r.height > area) { best = f; area = r.width * r.height; }
    });
    return best;
  };
  const follow = (): void => {
    if (S.dead) return;
    if (!location.hash.startsWith(routeBase)) { api.close(); return; }   // 다른 데로 갔다 — 층을 걷는다(적은 것은 이미 부르는 쪽에 있다)
    const f = findFrame();
    if (f !== S.frame) { S.frame = f; closePop(); paintBar(); paintMarks(); }
    if (f) { const r = f.getBoundingClientRect(); layer.style.left = r.left + 'px'; layer.style.top = r.top + 'px'; layer.style.width = r.width + 'px'; layer.style.height = r.height + 'px'; }
  };
  S.tick = window.setInterval(follow, 250);
  const onScroll = (): void => { follow(); };
  window.addEventListener('resize', onScroll); document.addEventListener('scroll', onScroll, true);

  // ── 짚기 — 앱 위 투명한 층(도구마다 하는 일이 다르다: 고르기 = 요소 · 핀 = 점 · 영역 = 끌어 그린 상자) ──
  const askHit = async (x: number, y: number): Promise<any> => {
    const w = frameWin(); if (!w) return null;
    const id = S.hitSeq++;
    return new Promise((res) => { S.hitWaits[id] = res; w.postMessage({ __studio: 'hit', id, x, y }, '*'); setTimeout(() => { if (S.hitWaits[id]) { delete S.hitWaits[id]; res(null); } }, 700); });
  };
  const ratio = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = layer.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width))), y: Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height))) };
  };
  const addItem = (p: StudioPin): void => { host.pins.push(p); const w = frameWin(); if (w) w.postMessage({ __studio: 'clear' }, '*'); changed(); paintMarks(); openPop(host.pins.length - 1); };
  let drag: { x: number; y: number; box: HTMLElement } | null = null; let skip = false;
  ov.addEventListener('pointermove', (e: PointerEvent) => {
    if (S.tool === 'pick' && Date.now() - S.hoverAt > 70) { S.hoverAt = Date.now(); const w = frameWin(); const q = ratio(e); if (w) w.postMessage({ __studio: 'hit', id: 0, x: q.x, y: q.y }, '*'); }
    if (S.tool === 'box' && drag) {
      const q = ratio(e); const l = Math.min(q.x, drag.x), t = Math.min(q.y, drag.y);
      Object.assign(drag.box.style, { left: l * 100 + '%', top: t * 100 + '%', width: Math.abs(q.x - drag.x) * 100 + '%', height: Math.abs(q.y - drag.y) * 100 + '%' });
    }
  });
  ov.addEventListener('pointerleave', () => { if (S.tool === 'pick') { const w = frameWin(); if (w) w.postMessage({ __studio: 'clear' }, '*'); } });
  ov.addEventListener('pointerdown', (e: PointerEvent) => {
    if (pop) { closePop(); skip = true; return; }   // 열린 의견 칸 밖을 누르면 먼저 닫기만 한다
    if (S.tool !== 'box') return;
    const q = ratio(e); const box = el('div', { class: 'v2-studio-mk v2-studio-mk-box draft' }); layer.append(box); drag = { x: q.x, y: q.y, box }; ov.setPointerCapture(e.pointerId);
  });
  ov.addEventListener('click', async (e: MouseEvent) => {
    if (skip) { skip = false; return; }
    if (S.tool !== 'pick' && S.tool !== 'pin') return;
    const q = ratio(e); const hit = await askHit(q.x, q.y);
    if (S.tool === 'pick' && hit && hit.rect) addItem({ kind: 'pick', x: hit.rect.l, y: hit.rect.t, w: hit.rect.w, h: hit.rect.h, where: whereText(hit), note: '' });
    else addItem({ kind: 'pin', x: q.x, y: q.y, where: whereText(hit), note: '' });
  });
  ov.addEventListener('pointerup', async (e: PointerEvent) => {
    if (S.tool !== 'box' || !drag) return;
    const q = ratio(e); const d = drag; drag = null; d.box.remove();
    const l = Math.min(q.x, d.x), t = Math.min(q.y, d.y), w = Math.abs(q.x - d.x), hh = Math.abs(q.y - d.y);
    if (w < 0.02 || hh < 0.02) return;   // 너무 작은 상자는 실수로 본다
    const hit = await askHit(l + w / 2, t + hh / 2);
    addItem({ kind: 'box', x: l, y: t, w, h: hh, where: whereText(hit), note: '' });
  });
  const onMsg = (ev: MessageEvent): void => { const m: any = ev.data; if (!m || m.__studio !== 'hitres' || ev.source !== frameWin()) return; const w = S.hitWaits[m.id]; if (w) { delete S.hitWaits[m.id]; w(m); } };
  window.addEventListener('message', onMsg);
  const paintMarks = (): void => {
    layer.querySelectorAll('.v2-studio-mk').forEach((n) => n.remove());
    host.pins.forEach((p, i) => {
      if (p.on === 'wire') return;   // 와이어프레임 보드에서 짚은 곳 — 앱 화면 위엔 그리지 않는다(번호는 그대로 i + 1)
      const hot = i === S.active;
      if (p.kind === 'pick' || p.kind === 'box') {
        const b = el('div', { class: 'v2-studio-mk v2-studio-mk-box' + (p.kind === 'pick' ? ' pick' : '') + (hot ? ' hot' : '') });
        Object.assign(b.style, { left: p.x * 100 + '%', top: p.y * 100 + '%', width: (p.w || 0) * 100 + '%', height: (p.h || 0) * 100 + '%' });
        layer.append(b);
      }
      const n = el('button', { type: 'button', class: 'v2-studio-mk v2-studio-mk-n' + (p.kind === 'pick' || p.kind === 'box' ? '' : ' pin') + (hot ? ' hot' : ''), title: p.note || p.where || '', 'aria-label': (i + 1) + '번 코멘트 열기',
        onclick: (e: MouseEvent) => { e.stopPropagation(); openPop(i); } }, el('span', { text: String(i + 1) }));
      n.style.left = p.x * 100 + '%'; n.style.top = p.y * 100 + '%';
      layer.append(n);
    });
  };
  // 그 자리의 의견 칸 — 짚은 곳 옆에 뜬다
  let pop: HTMLElement | null = null;
  const closePop = (): void => { if (pop) { pop.remove(); pop = null; } if (S.active >= 0) { S.active = -1; paintMarks(); } };
  const removePin = (i: number): void => { host.pins.splice(i, 1); closePop(); changed(); paintMarks(); };
  const openPop = (i: number): void => {
    const p = host.pins[i]; if (!p) return;
    if (pop) pop.remove();
    S.active = i; paintMarks();
    const ta = el('textarea', { class: 'ta', rows: '2', placeholder: '이 자리를 어떻게 고칠까요', 'aria-label': (i + 1) + '번 코멘트' }) as HTMLTextAreaElement; ta.value = p.note;
    ta.addEventListener('input', () => { p.note = ta.value; changed(); });
    ta.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); closePop(); } if (e.key === 'Escape') closePop(); });
    const kind = p.kind === 'pick' ? '선택한 요소' : p.kind === 'box' ? '영역' : '핀';
    const pp = el('div', { class: 'v2-studio-pop', role: 'dialog', 'aria-label': (i + 1) + '번 코멘트' },
      el('div', { class: 'k' }, el('span', { class: 'n', text: String(i + 1) }), el('b', { text: kind }), el('span', { class: 'w', text: p.where || '' })),
      ta,
      el('div', { class: 'act' },
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '취소', title: '이 자리 코멘트를 지워요', onclick: () => removePin(i) }),
        el('span', { class: 'v2-studio-sp' }), el('button', { type: 'button', class: 'v2-studio-now-pri', text: '완료', onclick: () => closePop() })));
    pp.addEventListener('pointerdown', (e) => e.stopPropagation());
    const right = p.x + (p.w || 0);
    pp.style.top = Math.min(p.y * 100, 66) + '%';
    //  짚은 곳의 오른쪽 · 왼쪽 중 **화면에** 자리가 있는 쪽 — 앱 칸 안의 비율로만 고르면 화면 오른쪽 끝의 좁은 사이드바(340)에서 칸이 화면 밖으로 나갔다.
    const lr = layer.getBoundingClientRect(), need = 280 + 12 + 8;
    const roomR = window.innerWidth - (lr.left + right * lr.width), roomL = lr.left + p.x * lr.width;
    const toRight = roomR >= need ? true : roomL >= need ? false : roomR >= roomL;
    if (toRight) pp.style.left = 'calc(' + right * 100 + '% + 12px)'; else pp.style.right = 'calc(' + (100 - p.x * 100) + '% + 12px)';
    pop = pp; layer.append(pp); ta.focus();
  };
  // 의견 한눈에 — 막대 위에 뜨는 칸(짚은 곳마다 한 줄 · 앱 전체 한 칸)
  let tray: HTMLElement | null = null;
  const closeTray = (): void => { if (tray) { tray.remove(); tray = null; bar.classList.remove('v2-review-bar--tray'); document.removeEventListener('pointerdown', onTrayOut, true); } };
  const onTrayOut = (e: Event): void => { if (tray && !tray.contains(e.target as Node) && e.target !== count) closeTray(); };
  const openTray = (): void => {
    if (tray) { closeTray(); return; }
    const rows = host.pins.map((p, i) => {
      const inp = el('input', { class: 'v2-studio-tray-in', type: 'text', placeholder: '이 자리를 어떻게 고칠까요', 'aria-label': (i + 1) + '번 코멘트' }) as HTMLInputElement; inp.value = p.note;
      inp.addEventListener('input', () => { p.note = inp.value; changed(); });
      const wire = p.on === 'wire';
      return el('div', { class: 'v2-studio-tray-row' }, el('button', { type: 'button', class: 'n', text: String(i + 1), title: wire ? '와이어프레임에 남긴 코멘트예요. 앱빌더의 「와이어프레임(화면 흐름) 보기」에서 볼 수 있어요.' : '그 자리 보기', disabled: wire, onclick: () => { closeTray(); openPop(i); } }),
        el('span', { class: 'w', text: (wire ? '와이어프레임 · ' : '') + (p.kind === 'pick' ? '요소 ' : p.kind === 'box' ? '영역 ' : '핀 ') + (p.where || '') }), inp,
        el('button', { type: 'button', class: 'x', text: '✕', title: '이 코멘트 지우기', onclick: () => { removePin(i); closeTray(); openTray(); } }));
    });
    const g = el('input', { class: 'v2-studio-tray-in', type: 'text', placeholder: '앱 전체 코멘트 · 예: 글자 조금 크게', 'aria-label': '앱 전체 코멘트' }) as HTMLInputElement; g.value = host.general;
    g.addEventListener('input', () => { host.general = g.value; changed(); });
    const t = el('div', { class: 'v2-studio-tray v2-review-tray', role: 'dialog', 'aria-label': '코멘트' },
      el('div', { class: 'v2-studio-tray-h' }, el('b', { text: '코멘트' + (cmCount() ? ' · ' + cmCount() + '건' : '') }), el('span', { class: 'v2-studio-sp' }), el('small', { text: host.pins.length ? '번호를 누르면 그 자리 코멘트 칸이 열려요' : '막대의 선택 · 핀 · 영역으로 고칠 곳에 코멘트를 남겨주세요' })),
      //  앱 전체 의견 칸은 머리 바로 아래 — 짚은 자리 줄들보다 위(원준 2026-10-15 «텍스트 박스 위치가 그 윗줄에 보낼 의견 아래에»)
      el('div', { class: 'v2-studio-tray-list' }, el('div', { class: 'v2-studio-tray-row all' }, el('span', { class: 'w', text: '앱 전체' }), g), ...rows));
    tray = t;
    if (host.dock) {
      //  막대가 화면 맨 위 줄에 들어앉았으면 칸은 막대 **아래로** — 몸(body)에 붙여 앱 위 층(.v2-review-layer)보다 위에 선다(그 층이 사이드바의 앱을 덮고 있다).
      const br = bar.getBoundingClientRect(), cr = count.getBoundingClientRect(), w = Math.min(560, window.innerWidth - 16);
      t.classList.add('v2-review-tray--fixed');
      Object.assign(t.style, { top: Math.round(br.bottom) + 'px', left: Math.round(Math.max(8, Math.min(cr.left, window.innerWidth - w - 8))) + 'px', width: w + 'px' });
      document.body.append(t);
    } else bar.append(t);
    //  막대와 칸은 한 덩어리(원준 2026-10-16 «이거 두 개를 왜 하나로 안 붙이는 거야») — 사이 틈 없이 맞붙고 맞닿은 모서리는 각진다.
    bar.classList.add('v2-review-bar--tray');
    setTimeout(() => document.addEventListener('pointerdown', onTrayOut, true), 0);
  };
  const tickWait = (): void => {
    if (!host.waiting || S.dead) return;
    const s = Math.floor((Date.now() - S.waitT0) / 1000);
    send.textContent = 'AI 수정 중 ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    S.waitTick = window.setTimeout(tickWait, 1000);
  };

  const api: ReviewApi = {
    update: (p) => {
      if (S.dead) return;
      if (p.title != null) { host.title = p.title; name.textContent = '「' + host.title + '」'; }
      if (p.version != null) host.version = p.version;
      if (p.pins) { host.pins = p.pins; closePop(); closeTray(); }
      if (p.general != null) host.general = p.general;
      if (p.waiting != null && p.waiting !== host.waiting) { host.waiting = p.waiting; closePop(); closeTray(); if (p.waiting) { S.waitT0 = Date.now(); S.tool = 'try'; tickWait(); } else { window.clearTimeout(S.waitTick); S.tool = 'pick'; } }
      paintBar(); paintMarks();
      if (p.note) { note.textContent = (host.version ? verName(host.version) + ' · ' : '') + p.note; note.hidden = false; window.clearTimeout(S.noteT); S.noteT = window.setTimeout(() => { note.hidden = true; }, 8000); }
    },
    close: () => {
      if (S.dead) return; S.dead = true;
      if (cur === api) cur = null;
      window.clearInterval(S.tick); window.clearTimeout(S.waitTick); window.clearTimeout(S.noteT);
      window.removeEventListener('resize', onScroll); document.removeEventListener('scroll', onScroll, true); window.removeEventListener('message', onMsg);
      closeTray(); const w = frameWin(); if (w) w.postMessage({ __studio: 'clear' }, '*');
      layer.remove(); bar.remove(); markReviewProbe(host.appId, false);
      if (host.onClose) host.onClose();
    },
    isOpen: () => !S.dead,
  };
  cur = api;
  paintBar(); paintMarks();
  if (location.hash !== host.route) location.hash = host.route;   // 셸이 그 화면을 연다(탭이 있으면 그 탭으로) — 층은 프레임이 보이면 거기 선다
  follow();
  return api;
}

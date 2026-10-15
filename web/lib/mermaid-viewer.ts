// lib/mermaid-viewer.ts — mermaid 그림 «크게 보기»(#4685). lib/mermaid.ts 에서 갈랐다(그 파일은 그리기·칸, 여기는 보기).
//  그림은 격리 프레임이 그린 svg 를 data: 주소의 <img> 로만 띄운다 — 이 창도 같다(svg 를 문서에 심지 않는다. lib/mermaid.ts 머리말).
import { el } from './dom.js';

/** 그린 그림 한 장 — 프레임이 «그림으로 읽히는 XML» 로 다듬어 준 svg 와 그 크기(px). title = mermaid accTitle(있으면). */
export type Picture = { svg: string; w: number; h: number; title: string };

export const svgUrl = (svg: string): string => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

// ── 크게 보기 — 화면 가득, 끌어서 옮기고 휠·버튼으로 확대한다 ─────────────────────────────────────────
//  배율은 transform 이 아니라 그림의 실제 크기(width·height)로 준다 — transform 으로 키우면 브라우저가 작은 그림을
//  비트맵으로 늘려 글자가 뭉개진다. 크기로 주면 svg 를 그 크기로 다시 그린다.
export function openViewer(pic: Picture, opener: HTMLElement | null): void {
  const name = pic.title || '다이어그램';
  const img = el('img', { class: 'md-mmv-img', alt: name, draggable: 'false' }) as HTMLImageElement;
  img.src = svgUrl(pic.svg);
  const stage = el('div', { class: 'md-mmv-stage', tabindex: '0', 'aria-label': name }, img);
  const pct = el('span', { class: 'md-mmv-pct', 'aria-live': 'polite' });
  const btn = (text: string, label: string, fn: () => void): HTMLButtonElement =>
    el('button', { type: 'button', class: 'md-mermaid-btn', 'aria-label': label, title: label, text, onclick: fn }) as HTMLButtonElement;
  let s = 1, x = 0, y = 0;
  const apply = (): void => {
    img.style.width = (pic.w * s) + 'px';
    img.style.height = (pic.h * s) + 'px';
    img.style.transform = `translate(${x}px, ${y}px)`;
    pct.textContent = Math.round(s * 100) + '%';
  };
  const box = (): DOMRect => stage.getBoundingClientRect();
  const zoomAt = (f: number, cx?: number, cy?: number): void => {
    const r = box();
    const px = cx == null ? r.width / 2 : cx, py = cy == null ? r.height / 2 : cy;
    const ns = Math.min(8, Math.max(0.05, s * f));
    x = px - (px - x) * (ns / s);
    y = py - (py - y) * (ns / s);
    s = ns;
    apply();
  };
  const fit = (): void => {
    const r = box();
    s = Math.max(0.05, Math.min((r.width - 48) / pic.w, (r.height - 48) / pic.h, 2));
    x = (r.width - pic.w * s) / 2;
    y = (r.height - pic.h * s) / 2;
    apply();
  };
  const closeBtn = btn('닫기', '닫기 (Esc)', () => close());
  const bar = el('div', { class: 'md-mmv-bar' },
    el('span', { class: 'md-mmv-name', text: name }),
    btn('−', '축소', () => zoomAt(1 / 1.25)), pct, btn('+', '확대', () => zoomAt(1.25)),
    btn('맞춤', '화면에 맞춤', fit), btn('100%', '원래 크기', () => zoomAt(1 / s)), closeBtn);
  const root = el('div', { class: 'md-mmv', role: 'dialog', 'aria-modal': 'true', 'aria-label': name }, bar, stage);

  //  휠 = 옮기기, ⌘/Ctrl+휠(트랙패드 오므리기 포함) = 커서 자리를 중심으로 확대.
  //   마우스 휠은 한 칸에 100px 안팎, 트랙패드 오므리기는 한 번에 몇 px 씩 온다 — 한 칸이 1.5배를 넘지 않게 자른다.
  //   줄 단위(deltaMode 1 — 파이어폭스 마우스)는 한 줄을 16px 로 본다.
  stage.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (e.ctrlKey || e.metaKey) {
      const r = box();
      zoomAt(Math.exp(-Math.max(-50, Math.min(50, e.deltaY * k)) * 0.008), e.clientX - r.left, e.clientY - r.top);
    } else { x -= e.deltaX * k; y -= e.deltaY * k; apply(); }
  }, { passive: false });
  let drag: { id: number; sx: number; sy: number; x0: number; y0: number } | null = null;
  stage.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x0: x, y0: y };
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* 이미 끝난 포인터 — 끌기는 move 로만 이어진다 */ }
    stage.classList.add('is-drag');
  });
  stage.addEventListener('pointermove', (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    x = drag.x0 + e.clientX - drag.sx;
    y = drag.y0 + e.clientY - drag.sy;
    apply();
  });
  const endDrag = (e: PointerEvent): void => { if (drag && e.pointerId === drag.id) { drag = null; stage.classList.remove('is-drag'); } };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', (e: MouseEvent) => { const r = box(); zoomAt(2, e.clientX - r.left, e.clientY - r.top); });
  //  위 줄(이름·단추) 위의 휠이 뒤 페이지를 굴리지 않게.
  root.addEventListener('wheel', (e: WheelEvent) => e.preventDefault(), { passive: false });

  const onKey = (e: KeyboardEvent): void => {
    //  이 창이 떠 있는 동안 키는 뒤 화면(앱 단축키 · 깔린 모달)으로 보내지 않는다 — 기본 동작(단추 누름)은 그대로.
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {
      //  포커스를 이 창 안에 가둔다(뒤 화면으로 새지 않게).
      const items = [...(Array.from(bar.querySelectorAll('button')) as HTMLElement[]), stage as HTMLElement];
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i < 0 || i === items.length - 1 ? 0 : i + 1);
      e.preventDefault();
      items[next].focus();
      return;
    }
    if ((e.target as HTMLElement | null)?.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(1.25); }
    else if (e.key === '-') { e.preventDefault(); zoomAt(1 / 1.25); }
    else if (e.key === '0') { e.preventDefault(); fit(); }
  };
  const onResize = (): void => fit();
  function close(): void {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    root.remove();
    if (opener && opener.isConnected) opener.focus();
  }
  window.addEventListener('keydown', onKey, true);   // 창 단계 캡처 — 뒤에 깔린 모달의 Esc 보다 먼저 받는다
  window.addEventListener('resize', onResize);
  document.body.append(root);
  fit();
  closeBtn.focus();
}

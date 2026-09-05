// v2/file-preview.ts — **자료 미리보기 기계 한 자리**(#762). 자료 칸이 쥐고 있던 것을 꺼내 뷰어 목록도 같이 쓴다.
//  꺼낸 이유는 규율 그대로다: 같은 그림을 두 곳에서 그리게 되면 한쪽만 고쳐진다(PDF 를 pdf.js 로 바꾼 것도,
//  시안의 논리 폭을 1180 으로 잡은 것도 여기 한 번만 적혀 있어야 한다).
//
//  ── 이 기계가 지키는 넷 ──
//   ① **보일 때만** 받는다(IntersectionObserver) — 자료가 수십 개인 칸에서 전부 받으면 화면이 멈춘다.
//   ② 한 번에 세 개까지(fetch 큐) — 좁은 칸에서 브라우저가 연결로 막히지 않게.
//   ③ 큰 파일은 아이콘 그대로(PV_MAX) — 미리보기 하나 보자고 100MB 를 내려받지 않는다.
//   ④ PDF 는 **첫 장을 그림으로**(pdf.js) — 크롬 내장 뷰어는 플러그인 레이어라 제 도구모음이 카드 밖으로 넘친다.
import { el } from '../core.js';
import { PV_PAGE_W, PV_MAX, PV_W, authHeaders } from './panes-kit.js';

export interface PreviewKit {
  /** 이 상자에 미리보기를 채운다(보이면 자동으로 — 관찰자가 없으면 즉시 큐에). */
  watch: (box: HTMLElement, path: string, kind: string, size: number) => void;
  /** 다시 그리기 전에 부른다 — 종이 자리를 다시 재는 목록을 비운다. */
  reset: () => void;
  destroy: () => void;
}

// ── PDF 첫 장을 그림으로 (#762) ─────────────────────────────────────────────────
//  pdf.js 는 **필요할 때만** 받는다(1.7MB) — 자료 격자에 PDF 가 없으면 한 바이트도 안 받는다.
//  일꾼(worker) 주소까지 같은 벤더 폴더로 못박는다: 기본값은 CDN 을 보는데 이 제품은 제 오리진만 쓴다.
let pdfLibP: Promise<any> | null = null;
function pdfLib(): Promise<any> {
  if (!pdfLibP) {
    const base = new URL('../vendor/pdfjs/', import.meta.url).href;
    pdfLibP = import(/* @vite-ignore */ base + 'pdf.min.mjs').then((m: any) => {
      m.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';
      return m;
    }).catch((e) => { pdfLibP = null; throw e; });
  }
  return pdfLibP;
}
/** 첫 장을 PV_W 폭 캔버스로. 못 그리면 null — 카드는 아이콘 그대로 둔다(빈 흰 칸을 남기지 않는다). */
async function pdfFirstPage(buf: ArrayBuffer): Promise<HTMLCanvasElement | null> {
  try {
    const lib = await pdfLib();
    const doc = await lib.getDocument({ data: buf, disableAutoFetch: true, disableStream: true, isEvalSupported: false }).promise;
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: PV_W / (base.width || PV_W) });
      const cv = el('canvas', { class: 'pn-fpdf' }) as HTMLCanvasElement;
      cv.width = Math.max(1, Math.round(vp.width));
      cv.height = Math.max(1, Math.round(vp.height));
      const cx = cv.getContext('2d');
      if (!cx) return null;
      await page.render({ canvasContext: cx, viewport: vp }).promise;
      return cv;
    } finally { void doc.destroy?.(); }
  } catch (_) { return null; }   // 암호 걸린 PDF·깨진 파일 — 아이콘으로 두는 것이 정직하다
}

/** 미리보기 기계 한 벌. `fileUrl` 은 그 화면이 쓰는 파일 주소(프로젝트마다 다르다), `dead` 는 그 화면이 떠났나. */
export function createPreviewKit(o: { fileUrl: (path: string) => string; dead: () => boolean }): PreviewKit {
  const blobUrls: string[] = [];
  //  · **보일 때만** 받는다(IntersectionObserver) — 자료가 수십 개인 칸에서 전부 받으면 화면이 멈춘다.
  //  · 한 번에 세 개까지만 받는다(fetch 큐) — 좁은 칸에서 브라우저가 연결로 막히지 않게.
  //  · 큰 파일은 건너뛰고 아이콘으로 둔다(형식별 상한 PV_MAX) — 미리보기 하나 보자고 100MB 를 내려받지 않는다.
  const seenPv = new WeakSet<HTMLElement>();
  let inflight = 0;
  const queue: Array<() => Promise<void>> = [];
  function pump(): void {
    while (inflight < 3 && queue.length) {
      const job = queue.shift()!;
      inflight++;
      void job().catch(() => { /* 하나 실패해도 나머지는 계속 */ }).then(() => { inflight--; pump(); });
    }
  }
  const io: IntersectionObserver | null = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((ents) => {
      for (const e of ents) {
        const n = e.target as HTMLElement;
        if (!e.isIntersecting || seenPv.has(n)) continue;
        seenPv.add(n);
        io?.unobserve(n);
        queue.push(() => fillPreview(n, n.dataset.pv || '', n.dataset.pvk || '', Number(n.dataset.pvs || 0)));
        pump();
      }
    }, { rootMargin: '250px' })
    : null;

  /** 카드 폭에 맞춰 종이(300×246)를 줄인다 — 칸 폭이 바뀌면 다시 맞춘다. */
  function fitPaper(box: HTMLElement, paper: HTMLElement): void {
    const w = box.clientWidth || 92;
    const lw = Number(paper.dataset.lw) || PV_W;      // 종이마다 논리 폭이 다르다(글 300 · 시안 1180)
    paper.style.transform = 'scale(' + (w / lw).toFixed(4) + ')';
  }
  const fits: Array<[HTMLElement, HTMLElement]> = [];
  const ro: ResizeObserver | null = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { for (const [b, pp] of fits) fitPaper(b, pp); })
    : null;
  /** 미리보기 한 장을 카드에 앉힌다 — `logicalW` 는 **그 내용이 제대로 펴지는 폭**이고, 카드 폭으로 줄여 그린다. */
  function paper(box: HTMLElement, inner: HTMLElement, logicalW = PV_W): void {
    const pp = el('div', { class: 'pn-fpaper' }, inner) as HTMLElement;
    pp.dataset.lw = String(logicalW);
    pp.style.width = logicalW + 'px';
    pp.style.height = Math.round(logicalW * 0.82) + 'px';   // 카드 비율(1 : .82)과 같게 — 아래가 잘리지 않는다
    box.replaceChildren(pp);
    fits.push([box, pp]);
    fitPaper(box, pp);
    ro?.observe(box);
  }

  async function fillPreview(box: HTMLElement, path: string, kind: string, size: number): Promise<void> {
    if (o.dead() || !box.isConnected) return;
    if (size && size > (PV_MAX[kind] || 4e6)) return;              // 너무 큰 것은 아이콘 그대로
    const url = o.fileUrl(path);
    //  PDF 는 **첫 장을 그림으로 그린다**(#762) — 크롬 내장 뷰어를 프레임에 띄우던 종전 방식은
    //  플러그인 레이어라 우리 CSS·히트테스트 밖에서 제 도구모음을 띄웠고, 그게 카드 밖으로 넘쳐 격자를
    //  뒤덮었다(`pointer-events:none`·`overflow:hidden`·`#toolbar=0` 셋 다 안 닿는다). 그림에는 그 문제가 없다.
    if (kind === 'pdf') {
      const buf = await fetch(url, { headers: authHeaders() }).then((r2) => (r2.ok ? r2.arrayBuffer() : null)).catch(() => null);
      if (!buf || o.dead() || !box.isConnected) return;
      const cv = await pdfFirstPage(buf);
      if (!cv || o.dead() || !box.isConnected) return;
      box.classList.add('has-pv');
      paper(box, cv, PV_W);
      return;
    }
    if (kind === 'text' || kind === 'page') {
      // 앞부분만 — Range 를 무시하는 서버여도 글자만 잘라 쓰므로 화면은 같다. 416(범위 거부)이면 통째로 받는다.
      let r = await fetch(url, { headers: { ...authHeaders(), Range: 'bytes=0-' + (kind === 'page' ? 400_000 : 4095) } });
      if (r.status === 416) r = await fetch(url, { headers: authHeaders() });
      if (!r.ok || o.dead() || !box.isConnected) return;
      const raw = await r.text();
      if (!raw.trim()) return;
      box.classList.add('has-pv');
      if (kind === 'text') { paper(box, el('pre', { class: 'pn-fpre', text: raw.slice(0, 1400) })); return; }
      // ⚠ 시안(HTML)은 **srcdoc + 빈 sandbox** 로 그린다. blob 주소를 sandbox 프레임에 물리면 그 프레임은
      //  불투명 출처라 blob 을 읽을 권한이 없어 **흰 칸**이 된다(실측 2026-08-20 — 시안 미리보기가 전부 백지였다).
      //  srcdoc 은 내용을 그 자리에 넘기므로 출처 문제가 없고, 빈 sandbox 가 스크립트·폼·상위 접근을 모두 막는다.
      const frame = el('iframe', { class: 'pn-fframe', sandbox: '', loading: 'lazy', tabindex: '-1', 'aria-hidden': 'true' }) as HTMLIFrameElement;
      frame.srcdoc = raw.slice(0, 400_000);
      paper(box, frame, PV_PAGE_W);
      return;
    }
    const r = await fetch(url, { headers: authHeaders() });
    if (!r.ok || o.dead() || !box.isConnected) return;
    const bl = await r.blob();
    const u = URL.createObjectURL(bl);
    blobUrls.push(u);
    if (o.dead() || !box.isConnected) return;
    box.classList.add('has-pv');
    if (kind === 'img') {
      box.replaceChildren(el('img', { alt: '', src: u }));
    } else if (kind === 'video') {
      const v = el('video', { src: u, muted: 'true', playsinline: 'true', preload: 'metadata' }) as HTMLVideoElement;
      v.muted = true;
      box.replaceChildren(v);
      // 첫 프레임을 세운다 — metadata 만으로 검은 칸이 남는 브라우저가 있어 0.1초로 옮겨 한 장을 그린다.
      v.addEventListener('loadedmetadata', () => { try { v.currentTime = Math.min(0.1, (v.duration || 1) / 10); } catch (_) { /* noop */ } }, { once: true });
    }
  }

  return {
    watch: (box, path, kind, size) => {
      if (io) io.observe(box);
      else { seenPv.add(box); queue.push(() => fillPreview(box, path, kind, size)); pump(); }
    },
    reset: () => { fits.length = 0; },
    destroy: () => { io?.disconnect(); ro?.disconnect(); blobUrls.forEach((u) => URL.revokeObjectURL(u)); },
  };
}

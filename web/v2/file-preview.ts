// v2/file-preview.ts — **자료 미리보기 기계 한 자리**(#762). 자료 칸이 쥐고 있던 것을 꺼내 뷰어 목록도 같이 쓴다.
//  꺼낸 이유는 규율 그대로다: 같은 그림을 두 곳에서 그리게 되면 한쪽만 고쳐진다(PDF 를 pdf.js 로 바꾼 것도,
//  시안의 논리 폭을 1180 으로 잡은 것도 여기 한 번만 적혀 있어야 한다).
//
//  ── 이 기계가 지키는 다섯 ──
//   ① **보일 때만** 받는다(IntersectionObserver) — 자료가 수십 개인 칸에서 전부 받으면 화면이 멈춘다.
//   ② 한 번에 여섯 개까지(fetch 큐) — 한 연결(HTTP/2)에 실려 가므로 여섯도 막히지 않는다.
//   ③ 큰 파일은 아이콘 그대로(PV_MAX) — 미리보기 하나 보자고 100MB 를 내려받지 않는다.
//   ④ PDF 는 **첫 장을 그림으로**(pdf.js) — 크롬 내장 뷰어는 플러그인 레이어라 제 도구모음이 카드 밖으로 넘친다.
//   ⑤ **한 번 그린 것은 다시 받지 않는다**(#3870, 원준 2026-09-30: «미리보기 보이는거 왜캐 느리고 오래 기다려야하고»).
//      실측(매니지드): 파일 하나 받는 데 서버에서 0.34~0.55초가 고정으로 들고(12바이트 파일도 같다 — 멤버 저장소 왕복),
//      응답이 `no-store` 라 칸을 열 때마다·폴더를 오갈 때마다 전부 다시 받았다(14칸 중 마지막이 3.2초, 다시 열어도 2.9초).
//      이제 파일의 판(수정시각·크기 = 목록이 이미 주는 값)을 주소에 싣는다(`&v=`). 판이 같으면 ⓐ 이 페이지 안에서는
//      그려 둔 결과를 그대로 다시 쓰고(아래 THUMBS) ⓑ 서버는 그 주소를 브라우저가 보관해도 된다고 답한다(project-routes
//      `/file` — 판이 맞을 때만). 판이 바뀌면 주소가 바뀌므로 옛 그림이 남을 길이 없다.
import { el } from '../core.js';
import { PV_PAGE_W, PV_MAX, PV_W, authHeaders } from './panes-kit.js';

export interface PreviewKit {
  /** 이 상자에 미리보기를 채운다(보이면 자동으로 — 관찰자가 없으면 즉시 큐에).
   *  mtime 을 주면(목록이 주는 파일 판) 같은 판은 다시 받지 않는다 — 안 주면 매번 받는다(판을 모르면 옛 그림일 수 있다). */
  watch: (box: HTMLElement, path: string, kind: string, size: number, mtime?: number) => void;
  /** 다시 그린 **뒤에** 부른다 — 화면에서 떨어져 나간 상자의 «종이 맞춤» 항목만 잊는다(살아남은 카드는 칸 폭이 바뀌면 계속 다시 잰다). */
  prune: () => void;
  destroy: () => void;
}

/** 미리보기 주소에 붙이는 파일 판 — 서버(project-routes `/file`)가 같은 모양으로 비교한다. 모르면 ''. */
export const pvVersion = (mtime: number | undefined, size: number | undefined): string =>
  mtime && mtime > 0 ? `${Math.floor(mtime)}.${Math.max(0, Math.floor(size || 0))}` : '';

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
/** 첫 장을 종이 폭(PV_W)의 두 배 해상도 캔버스로 — 레티나에서 카드가 커져도 흐리지 않게. 못 그리면 null. */
async function pdfFirstPage(buf: ArrayBuffer): Promise<HTMLCanvasElement | null> {
  try {
    const lib = await pdfLib();
    const doc = await lib.getDocument({ data: buf, disableAutoFetch: true, disableStream: true, isEvalSupported: false }).promise;
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (PV_W * 2) / (base.width || PV_W) });
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(vp.width));
      cv.height = Math.max(1, Math.round(vp.height));
      const cx = cv.getContext('2d');
      if (!cx) return null;
      await page.render({ canvasContext: cx, viewport: vp }).promise;
      return cv;
    } finally { void doc.destroy?.(); }
  } catch (_) { return null; }   // 암호 걸린 PDF·깨진 파일 — 아이콘으로 두는 것이 정직하다
}

// ── 그려 둔 결과 한 벌 — DOM 이 아니라 **재료**로 둔다(같은 그림을 여러 상자에 다시 세울 수 있게) ──
type Thumb =
  | { t: 'img'; url: string; bytes: number }        // 그림·영상 첫 장 — 카드에 꽉 차게
  | { t: 'paper'; url: string; bytes: number }      // PDF 첫 장 — 종이(PV_W) 위에
  | { t: 'pre'; text: string }                      // 글 앞부분
  | { t: 'sheet'; rows: string[][] }                // 표 앞부분
  | { t: 'page'; html: string }                     // 시안(HTML) — srcdoc
  | { t: 'none' };                                  // 그릴 수 없다 — 아이콘 그대로(같은 판을 다시 받지 않는다)

// ── 페이지 안 보관함 — 판이 같은 주소면 그대로 다시 쓴다. 오래 안 쓴 것부터 비운다(바이트 예산). ──
//  칸마다가 아니라 **페이지에 하나**다: 곁칸을 닫았다 열어도, 폴더를 오가도, 프로젝트 화면의 같은 폴더를 열어도 같은 그림이다.
const THUMB_BUDGET = 48 * 1024 * 1024;
const THUMBS = new Map<string, Thumb>();
let thumbBytes = 0;
const sizeOf = (t: Thumb): number =>
  t.t === 'img' || t.t === 'paper' ? t.bytes : t.t === 'pre' ? t.text.length * 2 : t.t === 'page' ? t.html.length * 2
    : t.t === 'sheet' ? t.rows.reduce((n, r) => n + r.join('').length * 2, 0) : 16;
function thumbGet(key: string): Thumb | undefined {
  const t = THUMBS.get(key);
  if (t) { THUMBS.delete(key); THUMBS.set(key, t); }   // 최근에 쓴 것을 뒤로 — 비울 때 앞에서부터 비운다
  return t;
}
function thumbPut(key: string, t: Thumb): void {
  const old = THUMBS.get(key);
  if (old) { thumbBytes -= sizeOf(old); THUMBS.delete(key); }
  THUMBS.set(key, t);
  thumbBytes += sizeOf(t);
  for (const [k, v] of THUMBS) {
    if (thumbBytes <= THUMB_BUDGET || k === key) break;
    //  화면에 선 그림의 blob 주소는 거두지 않는다 — 거두면 그 그림이 다시 그려질 때(떼었다 붙일 때) 빈 칸이 된다.
    if ((v.t === 'img' || v.t === 'paper') && document.querySelector(`img[src="${CSS.escape(v.url)}"]`)) continue;
    THUMBS.delete(k); thumbBytes -= sizeOf(v);
    if (v.t === 'img' || v.t === 'paper') URL.revokeObjectURL(v.url);
  }
}

/** 캔버스 → 작은 그림 blob(webp, 못 하면 png). */
const canvasBlob = (cv: HTMLCanvasElement): Promise<Blob | null> =>
  new Promise((res) => { try { cv.toBlob((b) => res(b), 'image/webp', 0.86); } catch (_) { res(null); } });

//  카드 최대 196px(ICON_STEPS 끝) × 레티나 2 — 그보다 큰 그림은 이 크기로 줄여 둔다. «꽉 채우기»(object-fit: cover)라
//  가로·세로 **둘 다** 이 이상이어야 흐리지 않다(가로로 긴 그림을 가로 기준으로만 줄이면 세로가 모자란다).
const IMG_TW = 480, IMG_TH = 400;
/** 큰 그림을 카드 크기로 줄인다 — 원본이 이미 작거나(해상도·용량) 못 읽는 형식(SVG 등)이면 null(원본을 쓴다). */
async function shrinkImage(blob: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function') return null;
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await createImageBitmap(blob);
    const s = Math.min(1, Math.max(IMG_TW / Math.max(1, bmp.width), IMG_TH / Math.max(1, bmp.height)));
    if (s >= 0.999 && blob.size < 400_000) return null;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(bmp.width * s));
    cv.height = Math.max(1, Math.round(bmp.height * s));
    const cx = cv.getContext('2d');
    if (!cx) return null;
    cx.drawImage(bmp, 0, 0, cv.width, cv.height);
    const out = await canvasBlob(cv);
    return out && out.size < blob.size ? out : null;
  } catch (_) { return null; }
  finally { try { bmp?.close(); } catch (_) { /* noop */ } }
}

/** 영상 첫 장면 한 장 — 영상 blob 은 그 자리에서 놓는다(종전엔 수십 MB 영상이 카드마다 메모리에 남았다). */
function videoFrame(blob: Blob): Promise<Blob | null> {
  return new Promise((resolve) => {
    const u = URL.createObjectURL(blob);
    const v = document.createElement('video');
    let done = false;
    const finish = (b: Blob | null): void => { if (done) return; done = true; window.clearTimeout(t); v.removeAttribute('src'); try { v.load(); } catch (_) { /* noop */ } URL.revokeObjectURL(u); resolve(b); };
    const t = window.setTimeout(() => finish(null), 8000);
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.addEventListener('loadedmetadata', () => { try { v.currentTime = Math.min(0.1, (v.duration || 1) / 10); } catch (_) { finish(null); } }, { once: true });
    v.addEventListener('seeked', () => {
      const w = v.videoWidth, h = v.videoHeight;
      if (!w || !h) { finish(null); return; }
      const s = Math.min(1, Math.max(IMG_TW / w, IMG_TH / h));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(w * s)); cv.height = Math.max(1, Math.round(h * s));
      try { cv.getContext('2d')?.drawImage(v, 0, 0, cv.width, cv.height); } catch (_) { finish(null); return; }
      void canvasBlob(cv).then(finish);
    }, { once: true });
    v.addEventListener('error', () => finish(null), { once: true });
    v.src = u;
  });
}

// ── 사무문서 썸네일 (#3778) ───────────────────────────────────────────────────
//  «앞부분만» 이 목적이라 판독기가 돌려준 블록 중 앞쪽 몇 줄·몇 행만 종이에 앉힌다.
//  판독기(lib/office·lib/zip·lib/cfb)는 **사무문서가 실제로 보일 때** 처음 받는다 — 격자에 없으면 0바이트.
const officeLibs = () => Promise.all([import('../lib/zip.js'), import('../lib/office.js'), import('../lib/cfb.js')]);

async function officeThumb(buf: ArrayBuffer, path: string): Promise<Thumb> {
  const ext = (path.slice(path.lastIndexOf('.') + 1) || '').toLowerCase();
  const pic = (b: Uint8Array): Thumb => ({ t: 'img', url: URL.createObjectURL(new Blob([b as BlobPart])), bytes: b.byteLength });
  try {
    const [zipMod, officeMod, cfbMod] = await officeLibs();
    //  .hwp — 한컴이 파일 안에 넣어 둔 첫 쪽 그림이 있으면 그게 가장 좋은 썸네일이다.
    if (cfbMod.looksCfb(buf)) {
      const cfb = cfbMod.openCfb(buf);
      const pv = cfb ? cfbMod.hwpPreview(cfb) : null;
      if (pv?.image) return pic(pv.image as Uint8Array);
      return pv?.text ? { t: 'pre', text: pv.text.slice(0, 1400) } : { t: 'none' };
    }
    if (!zipMod.looksZip(buf)) return { t: 'none' };
    const zip = zipMod.openZip(buf);
    if (!zip) return { t: 'none' };
    //  애플 iWork 는 자기가 만든 미리보기 그림을 넣어 둔다.
    const ql = zip.entries.find((e) => /^preview(-web)?\.(jpe?g|png)$/i.test(e.name));
    if (ql && !officeMod.officeKindOf(ext)) {
      const b = await zip.bytes(ql.name);
      if (b) return pic(b as Uint8Array);
    }
    const doc = await officeMod.readOffice(zip, ext);
    if (!doc) return { t: 'none' };
    if (officeMod.isSheetDoc(doc)) {
      const s = doc.sheets[0];
      if (!s || !s.rows.length) return { t: 'none' };
      return { t: 'sheet', rows: s.rows.slice(0, 16).map((r) => r.slice(0, 8).map((c) => c.slice(0, 24))) };
    }
    const lines: string[] = [];
    for (const b of doc.blocks) {
      if (lines.length > 26) break;
      if (b.k === 'h' || b.k === 'p') lines.push(b.runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim());
      else if (b.k === 'sep') lines.push('— ' + b.title);
      else if (b.k === 'table') for (const row of b.rows.slice(0, 4)) lines.push(row.map((c) => c.map((r) => r.text).join('')).join('  |  '));
    }
    const text = lines.filter(Boolean).join('\n').slice(0, 1400);
    return text ? { t: 'pre', text } : { t: 'none' };
  } catch (_) { return { t: 'none' }; }   // 암호 걸린 문서·깨진 파일 — 아이콘으로 두는 것이 정직하다
}

/** 미리보기 기계 한 벌. `fileUrl` 은 그 화면이 쓰는 파일 주소(프로젝트마다 다르다), `dead` 는 그 화면이 떠났나. */
export function createPreviewKit(o: { fileUrl: (path: string) => string; dead: () => boolean }): PreviewKit {
  //  · **보일 때만** 받는다(IntersectionObserver) — 자료가 수십 개인 칸에서 전부 받으면 화면이 멈춘다.
  //  · 한 번에 여섯 개까지만 받는다(fetch 큐).
  //  · 큰 파일은 건너뛰고 아이콘으로 둔다(형식별 상한 PV_MAX) — 미리보기 하나 보자고 100MB 를 내려받지 않는다.
  const seenPv = new WeakSet<HTMLElement>();
  const vers = new WeakMap<HTMLElement, string>();   // 상자 → 파일 판(watch 가 받은 mtime·size)
  const own: string[] = [];                          // 판을 몰라 보관함에 못 넣은 그림 주소 — 이 칸이 닫힐 때 거둔다
  let inflight = 0;
  const queue: Array<() => Promise<void>> = [];
  function pump(): void {
    while (inflight < 6 && queue.length) {
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

  /** 재료 → 상자. 새로 받아 그린 것만 살짝 떠오른다(보관함에서 바로 선 것은 처음부터 그 자리에 있어야 한다). */
  function show(box: HTMLElement, t: Thumb, fresh: boolean): void {
    if (t.t === 'none') return;
    box.classList.add('has-pv');
    if (fresh) box.classList.add('pv-in');
    if (t.t === 'img') { box.replaceChildren(el('img', { alt: '', src: t.url, decoding: 'async' })); return; }
    if (t.t === 'paper') { paper(box, el('img', { class: 'pn-fpdf', alt: '', src: t.url, decoding: 'async' }) as HTMLElement, PV_W); return; }
    if (t.t === 'pre') { paper(box, el('pre', { class: 'pn-fpre', text: t.text }) as HTMLElement); return; }
    if (t.t === 'sheet') {
      const tb = el('table', { class: 'pn-fsheet' });
      t.rows.forEach((r, i) => { const tr = el('tr'); for (const c of r) tr.append(el(i === 0 ? 'th' : 'td', { text: c })); tb.append(tr); });
      paper(box, tb as HTMLElement, PV_W);
      return;
    }
    // ⚠ 시안(HTML)은 **srcdoc + 빈 sandbox** 로 그린다. blob 주소를 sandbox 프레임에 물리면 그 프레임은
    //  불투명 출처라 blob 을 읽을 권한이 없어 **흰 칸**이 된다(실측 2026-08-20 — 시안 미리보기가 전부 백지였다).
    //  srcdoc 은 내용을 그 자리에 넘기므로 출처 문제가 없고, 빈 sandbox 가 스크립트·폼·상위 접근을 모두 막는다.
    const frame = el('iframe', { class: 'pn-fframe', sandbox: '', loading: 'lazy', tabindex: '-1', 'aria-hidden': 'true' }) as HTMLIFrameElement;
    frame.srcdoc = t.html;
    paper(box, frame, PV_PAGE_W);
  }

  /** 받아서 재료로 만든다. 못 받았으면(망·서버) undefined — 보관하지 않는다(다음에 다시 받는다). */
  async function make(url: string, path: string, kind: string): Promise<Thumb | undefined> {
    const r = await fetch(url, { headers: authHeaders() }).catch(() => null);
    if (!r || !r.ok) return undefined;
    //  PDF 는 **첫 장을 그림으로 그린다**(#762) — 크롬 내장 뷰어를 프레임에 띄우던 종전 방식은
    //  플러그인 레이어라 우리 CSS·히트테스트 밖에서 제 도구모음을 띄웠고, 그게 카드 밖으로 넘쳐 격자를
    //  뒤덮었다(`pointer-events:none`·`overflow:hidden`·`#toolbar=0` 셋 다 안 닿는다). 그림에는 그 문제가 없다.
    if (kind === 'pdf') {
      const cv = await pdfFirstPage(await r.arrayBuffer());
      const b = cv ? await canvasBlob(cv) : null;
      return b ? { t: 'paper', url: URL.createObjectURL(b), bytes: b.size } : { t: 'none' };
    }
    //  사무문서(#3778) — zip 을 풀어 **앞부분을 진짜로 그린다**. 판독기는 여기서만 받는다(pdf.js 와 같은 규율).
    if (kind === 'office') return officeThumb(await r.arrayBuffer(), path);
    if (kind === 'text' || kind === 'page') {
      const raw = await r.text();
      if (!raw.trim()) return { t: 'none' };
      return kind === 'text' ? { t: 'pre', text: raw.slice(0, 1400) } : { t: 'page', html: raw.slice(0, 400_000) };
    }
    //  여기 아래는 그림·영상뿐이다 — 그릴 방법이 없는 종류를 굳이 **받아 놓고 버리지** 않는다.
    if (kind !== 'img' && kind !== 'video') return { t: 'none' };
    const bl = await r.blob();
    if (kind === 'video') {
      const f = await videoFrame(bl);
      return f ? { t: 'img', url: URL.createObjectURL(f), bytes: f.size } : { t: 'none' };
    }
    const small = await shrinkImage(bl);
    const use = small || bl;
    return { t: 'img', url: URL.createObjectURL(use), bytes: use.size };
  }

  async function fillPreview(box: HTMLElement, path: string, kind: string, size: number): Promise<void> {
    if (o.dead() || !box.isConnected) return;
    if (size && size > (PV_MAX[kind] || 4e6)) return;              // 너무 큰 것은 아이콘 그대로
    const v = vers.get(box) || '';
    const url = o.fileUrl(path) + (v ? '&v=' + encodeURIComponent(v) : '');
    const hit = v ? thumbGet(url) : undefined;
    if (hit) { show(box, hit, false); return; }
    const t = await make(url, path, kind);
    if (!t) return;
    if (v) thumbPut(url, t);
    else if (t.t === 'img' || t.t === 'paper') own.push(t.url);
    if (o.dead() || !box.isConnected) return;
    show(box, t, true);
  }

  return {
    watch: (box, path, kind, size, mtime) => {
      const v = pvVersion(mtime, size);
      if (v) vers.set(box, v);
      //  보관함에 이미 있으면 **지금 곧바로** 세운다 — 관찰자의 첫 알림(한 프레임 뒤)조차 기다리면 아이콘이 한 번 깜빡인다.
      const hit = v ? thumbGet(o.fileUrl(path) + '&v=' + encodeURIComponent(v)) : undefined;
      if (hit) { seenPv.add(box); show(box, hit, false); return; }
      if (io) io.observe(box);
      else { seenPv.add(box); queue.push(() => fillPreview(box, path, kind, size)); pump(); }
    },
    //  fits = [상자, 종이] 쌍(paper() 가 넣는다 — ResizeObserver 가 칸 폭에 맞춰 종이를 다시 줄인다). 떨어져 나간 상자만 잊는다 —
    //  제자리 되그리기(panes-files render)로 살아남은 카드의 종이는 계속 다시 재야 한다. 종전의 «통째로 비우기(reset)» 는
    //  카드가 늘 새 노드일 때만 맞았다. 그래서 다시 그린 **뒤에** 부른다(붙어 있나가 그때 정해진다).
    prune: () => { for (let i = fits.length - 1; i >= 0; i--) if (!fits[i][0].isConnected) fits.splice(i, 1); },
    //  그림 주소(blob)는 페이지 보관함의 것이라 여기서 거두지 않는다 — 다음에 여는 칸이 그대로 쓴다(예산을 넘으면 보관함이 거둔다).
    destroy: () => { io?.disconnect(); ro?.disconnect(); own.forEach((u) => URL.revokeObjectURL(u)); },
  };
}

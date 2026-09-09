// lib/office.ts — 사무문서(zip+XML) → **중립 문서 모델**. 그리는 일은 하지 않는다(DOM 을 안 딛는다).
//
// 다루는 것: .docx .pptx .xlsx(+xlsm) · .hwpx · .odt .odp .ods · .epub
//  전부 «XML 이 든 zip» 이라 lib/zip.ts 로 한 겹 벗기고 lib/xml.ts 로 글자를 줍는다.
//  서식은 **읽는 데 필요한 만큼만** 산다 — 제목/굵게/기울임/표/목록/그림. 워드의 조판을 재현하는 게 목적이 아니라
//  «열어 보지 않고도 무슨 문서인지 안다» 가 목적이다.
//
// 왜 이 선이 맞나: 종전엔 이 형식 전부가 "미리보기를 지원하지 않아요" 한 줄이었다. 그 자리에서 사람이 할 수
//  있는 일은 내려받아 원래 앱으로 여는 것뿐이었고, 그러면 자료 탭을 지나칠 이유가 없다. 글자와 표만 나와도
//  «이게 그 파일이 맞나» 는 그 자리에서 끝난다.
//
// leaf 규약: zip·xml(둘 다 import 0)만 딛는다 — node 로 실물 파일에 그대로 돌려 확인할 수 있다.
import { localName, xmlTokens } from './xml.js';
import type { ZipFile } from './zip.js';

// ── 중립 모델 ────────────────────────────────────────────────────────────────
export interface Run { text: string; b?: boolean; i?: boolean; u?: boolean; s?: boolean; href?: string }
export type Block =
  | { k: 'p'; runs: Run[]; list?: 'ul' | 'ol'; indent?: number }
  | { k: 'h'; level: number; runs: Run[] }
  | { k: 'table'; rows: Run[][][] }
  | { k: 'img'; part: string }
  | { k: 'sep'; title: string };

export interface OfficeDoc {
  blocks: Block[];
  /** 그림을 그릴 때 부른다 — 아카이브 안 경로를 바이트로. */
  media: (part: string) => Promise<Uint8Array | null>;
  /** 상한에 걸려 잘렸나(화면이 "…이하 생략"을 적을 수 있게). */
  truncated: boolean;
}
export interface SheetDoc {
  sheets: Array<{ name: string; rows: string[][] }>;
  truncated: boolean;
}

//  상한 — 200쪽짜리 보고서를 다 그리면 칸이 멈춘다. 「무슨 문서인지 안다」에 필요한 양을 넘지 않는다.
const MAX_BLOCKS = 3000;
const MAX_RUN_CHARS = 400_000;
const MAX_SHEET_ROWS = 500;
const MAX_SHEET_COLS = 60;
const MAX_SHEETS = 20;

const trimRuns = (runs: Run[]): Run[] => runs.filter((r) => r.text !== '');

/** `<dir>/_rels/<name>.rels` → { rId: target }. 그림·하이퍼링크가 전부 이 표를 거친다. */
async function rels(zip: ZipFile, part: string): Promise<Record<string, string>> {
  const i = part.lastIndexOf('/');
  const dir = i < 0 ? '' : part.slice(0, i + 1);
  const name = i < 0 ? part : part.slice(i + 1);
  const xml = await zip.text(dir + '_rels/' + name + '.rels');
  const out: Record<string, string> = {};
  if (!xml) return out;
  for (const tk of xmlTokens(xml)) {
    if (tk.t !== 'open' || localName(tk.name) !== 'Relationship') continue;
    const id = tk.attrs.Id, target = tk.attrs.Target;
    if (!id || !target) continue;
    //  Target 은 그 파트 기준 상대경로다(`media/image1.png`) — 아카이브 절대경로로 편다.
    out[id] = /^https?:|^mailto:/i.test(target) || tk.attrs.TargetMode === 'External'
      ? target
      : resolvePart(dir, target);
  }
  return out;
}

/** `word/` + `../media/x.png` → `media/x.png` 처럼 zip 안 경로로 편다.
 *  ⚠ `/` 로 시작하는 Target 은 **패키지 뿌리 기준**이다(OPC) — 엑셀이 실제로 이렇게 적는다
 *   (`Target="/xl/worksheets/sheet1.xml"`). 이걸 상대경로로 오해하면 `xl/xl/…` 이 되어 시트를 못 찾고,
 *   그러면 표가 통째로 «못 읽는 형식» 으로 떨어진다(실측 2026-09-09: 첫 xlsx 가 그랬다). */
function resolvePart(dir: string, target: string): string {
  const abs = target.startsWith('/');
  const t = target.replace(/^\/+/, '');
  const segs = ((abs ? '' : dir) + t).split('/');
  const out: string[] = [];
  for (const s of segs) {
    if (s === '.' || s === '') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}

// ── .docx ────────────────────────────────────────────────────────────────────
/** 워드 스타일 id → 제목 단계. 한국어판은 «제목 1», 영문판은 Heading1/Title 로 나온다. */
function headingLevel(style: string): number {
  const s = style.toLowerCase().replace(/\s+/g, '');
  if (s === 'title' || s === '제목') return 1;
  const m = /^(?:heading|제목)([1-9])$/.exec(s);
  return m ? Math.min(6, Number(m[1])) : 0;
}
/** `<w:b/>` 는 켬, `<w:b w:val="0"/>` 은 끔 — 값이 없으면 켬이 기본이다. */
const onOff = (v: string | undefined): boolean => v === undefined || !(v === '0' || v === 'false' || v === 'off');

export async function readDocx(zip: ZipFile): Promise<OfficeDoc | null> {
  const xml = await zip.text('word/document.xml');
  if (xml == null) return null;
  const rel = await rels(zip, 'word/document.xml');
  const blocks: Block[] = [];
  let truncated = false;
  let chars = 0;

  // 문단 상태 — 표 안에서도 같은 기계를 쓰므로 «지금 담는 곳»을 갈아 끼운다.
  let runs: Run[] = [];
  let style = '';
  let isList = false;
  let numFmt: 'ul' | 'ol' = 'ul';
  let indent = 0;
  let fmt: { b?: boolean; i?: boolean; u?: boolean; s?: boolean } = {};
  let href: string | undefined;
  let inRPr = false, inPPr = false, inText = false, inDeleted = false, inField = false;
  let textBuf = '';

  // 표 상태(중첩 표는 안쪽을 바깥 칸 글자로 눕힌다 — 읽는 데 지장이 없다).
  let table: Run[][][] | null = null;
  let row: Run[][] | null = null;
  let cell: Run[] | null = null;

  const push = (b: Block): void => { if (blocks.length < MAX_BLOCKS) blocks.push(b); else truncated = true; };
  const flushPara = (): void => {
    const rs = trimRuns(runs);
    runs = [];
    const st = style; style = ''; const li = isList; isList = false; const ind = indent; indent = 0;
    if (cell) { if (rs.length) { if (cell.length) cell.push({ text: '\n' }); cell.push(...rs); } return; }
    if (!rs.length) return;
    const h = headingLevel(st);
    if (h) push({ k: 'h', level: h, runs: rs });
    else push({ k: 'p', runs: rs, ...(li ? { list: numFmt } : {}), ...(ind ? { indent: ind } : {}) });
  };
  const addText = (t: string): void => {
    if (!t || chars >= MAX_RUN_CHARS) { if (t) truncated = true; return; }
    chars += t.length;
    runs.push({ text: t, ...fmt, ...(href ? { href } : {}) });
  };

  for (const tk of xmlTokens(xml)) {
    if (tk.t === 'text') { if (inText && !inDeleted && !inField) textBuf += tk.text; continue; }
    const ln = localName(tk.t === 'open' ? tk.name : tk.name);
    if (tk.t === 'open') {
      const a = tk.attrs;
      switch (ln) {
        case 'pPr': inPPr = true; break;
        case 'rPr': inRPr = true; break;
        case 'pStyle': if (inPPr) style = a['w:val'] || a.val || ''; break;
        case 'numPr': if (inPPr) isList = true; break;
        case 'numFmt': if (inPPr) numFmt = /^(decimal|ordinal|korean|chosung|arabic)/i.test(a['w:val'] || '') ? 'ol' : 'ul'; break;
        case 'ind': if (inPPr) indent = Math.min(6, Math.round(Number(a['w:left'] || a['w:start'] || 0) / 720)); break;
        case 'b': if (inRPr) fmt.b = onOff(a['w:val'] ?? a.val); break;
        case 'i': if (inRPr) fmt.i = onOff(a['w:val'] ?? a.val); break;
        case 'u': if (inRPr) fmt.u = (a['w:val'] ?? 'single') !== 'none'; break;
        case 'strike': if (inRPr) fmt.s = onOff(a['w:val'] ?? a.val); break;
        case 'r': if (!inRPr) fmt = {}; break;
        case 'hyperlink': { const t = rel[a['r:id'] || '']; if (t) href = t; break; }
        case 't': case 'delText': if (!inRPr) { inText = true; textBuf = ''; inDeleted = ln === 'delText'; } break;
        case 'instrText': inField = true; break;
        case 'br': addText('\n'); break;
        case 'tab': addText('\t'); break;
        case 'blip': { const t = rel[a['r:embed'] || a['r:link'] || '']; if (t && !/^https?:/i.test(t)) push({ k: 'img', part: t }); break; }
        case 'tbl': if (!table) { flushPara(); table = []; } break;
        case 'tr': if (table && !row) row = []; break;
        case 'tc': if (row && !cell) cell = []; break;
        default: break;
      }
      if (tk.self) {
        //  self-closing 은 곧바로 닫힌 것으로 친다 — 아래 close 처리를 한 번 더 태운다.
        if (ln === 'pPr') inPPr = false;
        else if (ln === 'rPr') inRPr = false;
        else if (ln === 't' || ln === 'delText') { inText = false; textBuf = ''; }
        else if (ln === 'instrText') inField = false;
      }
      continue;
    }
    // close
    switch (ln) {
      case 'pPr': inPPr = false; break;
      case 'rPr': inRPr = false; break;
      case 't': case 'delText': if (inText) { if (!inDeleted) addText(textBuf); inText = false; textBuf = ''; inDeleted = false; } break;
      case 'instrText': inField = false; break;
      case 'hyperlink': href = undefined; break;
      case 'p': flushPara(); break;
      case 'tc': if (cell) { (row as Run[][]).push(trimRuns(cell)); cell = null; } break;
      case 'tr': if (row) { (table as Run[][][]).push(row); row = null; } break;
      case 'tbl': if (table) { if (table.length) push({ k: 'table', rows: table }); table = null; } break;
      default: break;
    }
  }
  flushPara();
  if (!blocks.length) return null;
  return { blocks, media: (p) => zip.bytes(p), truncated };
}

// ── .pptx ────────────────────────────────────────────────────────────────────
export async function readPptx(zip: ZipFile): Promise<OfficeDoc | null> {
  //  장표 차례는 presentation.xml 의 sldIdLst 가 정본이다 — 파일 이름 순서(slide10 < slide2)와 다르다.
  const pres = await zip.text('ppt/presentation.xml');
  const prel = await rels(zip, 'ppt/presentation.xml');
  let order: string[] = [];
  if (pres) {
    for (const tk of xmlTokens(pres)) {
      if (tk.t !== 'open' || localName(tk.name) !== 'sldId') continue;
      const t = prel[tk.attrs['r:id'] || ''];
      if (t) order.push(t);
    }
  }
  if (!order.length) {
    order = zip.match(/^ppt\/slides\/slide\d+\.xml$/)
      .sort((a, b) => (Number(/(\d+)/.exec(a)?.[1] ?? 0) - Number(/(\d+)/.exec(b)?.[1] ?? 0)));
  }
  if (!order.length) return null;
  const blocks: Block[] = [];
  let truncated = false;
  for (let n = 0; n < order.length; n++) {
    if (blocks.length >= MAX_BLOCKS) { truncated = true; break; }
    const xml = await zip.text(order[n]);
    if (xml == null) continue;
    const srel = await rels(zip, order[n]);
    blocks.push({ k: 'sep', title: `슬라이드 ${n + 1}` });
    //  장표는 «글상자 하나 = 문단 묶음» 이다. a:p 로 끊고 a:t 를 이어 붙인다.
    let runs: Run[] = [];
    let inText = false, buf = '';
    let bold = false;
    for (const tk of xmlTokens(xml)) {
      if (tk.t === 'text') { if (inText) buf += tk.text; continue; }
      const ln = localName(tk.name);
      if (tk.t === 'open') {
        if (ln === 'rPr') bold = onOff(tk.attrs.b) && tk.attrs.b !== undefined;
        else if (ln === 't') { inText = true; buf = ''; }
        else if (ln === 'br') runs.push({ text: '\n' });
        else if (ln === 'blip') { const t = srel[tk.attrs['r:embed'] || '']; if (t && !/^https?:/i.test(t)) blocks.push({ k: 'img', part: t }); }
        if (tk.self && ln === 't') { inText = false; buf = ''; }
        continue;
      }
      if (ln === 't') { if (inText && buf) runs.push({ text: buf, ...(bold ? { b: true } : {}) }); inText = false; buf = ''; }
      else if (ln === 'p') {
        const rs = trimRuns(runs); runs = [];
        if (rs.length && blocks.length < MAX_BLOCKS) blocks.push({ k: 'p', runs: rs });
      }
    }
  }
  return blocks.some((b) => b.k !== 'sep') ? { blocks, media: (p) => zip.bytes(p), truncated } : null;
}

// ── .xlsx / .xlsm ────────────────────────────────────────────────────────────
/** `A1` → 0-기반 열 번호. 셀에 r 이 없을 수도 있어(희소 저장) 없으면 -1. */
function colOf(ref: string | undefined): number {
  if (!ref) return -1;
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}
/** 엑셀 일련번호 → 'YYYY-MM-DD' (시각이 있으면 분까지). 기준일은 1899-12-30(1900 윤년 버그 보정 포함). */
function serialDate(n: number): string {
  const ms = Math.round((n - 25569) * 86400000);
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return String(n);
  const p = (x: number) => String(x).padStart(2, '0');
  const day = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const frac = n - Math.floor(n);
  return frac > 1e-6 ? `${day} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : day;
}
/** 스타일 번호 → 날짜 서식인가. 내장 14~22·45~47 과, 서식코드에 y/m/d 가 든 사용자 서식. */
async function dateStyles(zip: ZipFile): Promise<Set<number>> {
  const out = new Set<number>();
  const xml = await zip.text('xl/styles.xml');
  if (!xml) return out;
  const dateFmtIds = new Set<number>([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  let inCellXfs = false, xfIdx = 0;
  for (const tk of xmlTokens(xml)) {
    if (tk.t === 'open') {
      const ln = localName(tk.name);
      if (ln === 'numFmt') {
        const id = Number(tk.attrs.numFmtId);
        const code = String(tk.attrs.formatCode || '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
        if (Number.isFinite(id) && /[ymdhs]/i.test(code)) dateFmtIds.add(id);
      } else if (ln === 'cellXfs') { inCellXfs = true; xfIdx = 0; }
      else if (ln === 'xf' && inCellXfs) { if (dateFmtIds.has(Number(tk.attrs.numFmtId))) out.add(xfIdx); xfIdx++; }
    } else if (tk.t === 'close' && localName(tk.name) === 'cellXfs') inCellXfs = false;
  }
  return out;
}

export async function readXlsx(zip: ZipFile): Promise<SheetDoc | null> {
  const wb = await zip.text('xl/workbook.xml');
  if (wb == null) return null;
  const wrel = await rels(zip, 'xl/workbook.xml');
  const named: Array<{ name: string; part: string }> = [];
  for (const tk of xmlTokens(wb)) {
    if (tk.t !== 'open' || localName(tk.name) !== 'sheet') continue;
    const part = wrel[tk.attrs['r:id'] || ''] || '';
    if (part) named.push({ name: tk.attrs.name || `시트 ${named.length + 1}`, part });
  }
  if (!named.length) {
    for (const p of zip.match(/^xl\/worksheets\/sheet\d+\.xml$/).sort()) named.push({ name: `시트 ${named.length + 1}`, part: p });
  }
  if (!named.length) return null;

  // 공유 문자열 — 셀 값 `t="s"` 는 여기 색인이다.
  const shared: string[] = [];
  const ss = await zip.text('xl/sharedStrings.xml');
  if (ss) {
    let cur: string[] | null = null, inT = false, buf = '';
    for (const tk of xmlTokens(ss)) {
      if (tk.t === 'text') { if (inT) buf += tk.text; continue; }
      const ln = localName(tk.name);
      if (tk.t === 'open') {
        if (ln === 'si') cur = [];
        else if (ln === 't') { inT = true; buf = ''; if (tk.self) { inT = false; } }
      } else if (ln === 't') { if (inT && cur) cur.push(buf); inT = false; buf = ''; }
      else if (ln === 'si') { shared.push((cur || []).join('')); cur = null; }
    }
  }
  const dateXf = await dateStyles(zip);

  const sheets: SheetDoc['sheets'] = [];
  let truncated = named.length > MAX_SHEETS;
  for (const s of named.slice(0, MAX_SHEETS)) {
    const xml = await zip.text(s.part);
    if (xml == null) continue;
    const rows: string[][] = [];
    let row: string[] | null = null;
    let col = -1, type = '', styleIdx = -1;
    let inV = false, inIsT = false, buf = '';
    for (const tk of xmlTokens(xml)) {
      if (tk.t === 'text') { if (inV || inIsT) buf += tk.text; continue; }
      const ln = localName(tk.name);
      if (tk.t === 'open') {
        if (ln === 'row') { row = []; col = -1; }
        else if (ln === 'c') {
          const c = colOf(tk.attrs.r);
          col = c >= 0 ? c : col + 1;
          type = tk.attrs.t || 'n';
          styleIdx = tk.attrs.s ? Number(tk.attrs.s) : -1;
          buf = '';
        } else if (ln === 'v') { inV = true; buf = ''; }
        else if (ln === 't') { inIsT = true; buf = ''; }
        if (tk.self && (ln === 'v' || ln === 't')) { inV = false; inIsT = false; }
        continue;
      }
      if (ln === 'v' || ln === 't') {
        if ((inV || inIsT) && row && col >= 0 && col < MAX_SHEET_COLS) {
          let text = buf;
          if (inV && type === 's') text = shared[Number(buf)] ?? '';
          else if (inV && type === 'b') text = buf === '1' ? 'TRUE' : 'FALSE';
          else if (inV && (type === 'n' || type === '') && dateXf.has(styleIdx) && buf && Number.isFinite(Number(buf))) text = serialDate(Number(buf));
          while (row.length < col) row.push('');
          row[col] = (row[col] ? row[col] + text : text);
        }
        inV = false; inIsT = false; buf = '';
      } else if (ln === 'row' && row) {
        if (rows.length < MAX_SHEET_ROWS) rows.push(row); else truncated = true;
        row = null;
      }
    }
    //  뒤쪽 빈 열은 떨군다 — 엑셀은 서식만 있는 빈 칸도 셀로 적어 표가 쓸데없이 넓어진다.
    let width = 0;
    for (const r of rows) for (let i = r.length - 1; i >= 0; i--) if (r[i]) { width = Math.max(width, i + 1); break; }
    sheets.push({ name: s.name, rows: rows.map((r) => { const o = r.slice(0, width); while (o.length < width) o.push(''); return o; }) });
  }
  return sheets.length ? { sheets, truncated } : null;
}

// ── .hwpx (한글 — 열린 문서 규격) ────────────────────────────────────────────
export async function readHwpx(zip: ZipFile): Promise<OfficeDoc | null> {
  const parts = zip.match(/^Contents\/section\d+\.xml$/i)
    .sort((a, b) => Number(/(\d+)/.exec(a)?.[1] ?? 0) - Number(/(\d+)/.exec(b)?.[1] ?? 0));
  if (!parts.length) return null;
  const blocks: Block[] = [];
  let truncated = false;
  for (const p of parts) {
    const xml = await zip.text(p);
    if (xml == null) continue;
    let runs: Run[] = [];
    let inT = false, buf = '';
    for (const tk of xmlTokens(xml)) {
      if (tk.t === 'text') { if (inT) buf += tk.text; continue; }
      const ln = localName(tk.name);
      if (tk.t === 'open') {
        if (ln === 't') { inT = true; buf = ''; if (tk.self) inT = false; }
        else if (ln === 'lineBreak') runs.push({ text: '\n' });
        continue;
      }
      if (ln === 't') { if (inT && buf) runs.push({ text: buf }); inT = false; buf = ''; }
      else if (ln === 'p') {
        const rs = trimRuns(runs); runs = [];
        if (rs.length) { if (blocks.length < MAX_BLOCKS) blocks.push({ k: 'p', runs: rs }); else truncated = true; }
      }
    }
  }
  return blocks.length ? { blocks, media: (p) => zip.bytes(p), truncated } : null;
}

// ── OpenDocument (.odt .odp .ods) ────────────────────────────────────────────
async function odfContent(zip: ZipFile): Promise<string | null> { return await zip.text('content.xml'); }

export async function readOdfText(zip: ZipFile): Promise<OfficeDoc | null> {
  const xml = await odfContent(zip);
  if (xml == null) return null;
  const blocks: Block[] = [];
  let truncated = false;
  let runs: Run[] = [];
  let level = 0, isHead = false, inBody = false;
  let bold = false, italic = false;
  let table: Run[][][] | null = null, row: Run[][] | null = null, cell: Run[] | null = null;
  const flush = (): void => {
    const rs = trimRuns(runs); runs = [];
    const h = isHead ? level : 0; isHead = false; level = 0;
    if (cell) { if (rs.length) { if (cell.length) cell.push({ text: '\n' }); cell.push(...rs); } return; }
    if (!rs.length) return;
    if (blocks.length >= MAX_BLOCKS) { truncated = true; return; }
    blocks.push(h ? { k: 'h', level: Math.min(6, h), runs: rs } : { k: 'p', runs: rs });
  };
  for (const tk of xmlTokens(xml)) {
    if (tk.t === 'text') { if (inBody && tk.text) runs.push({ text: tk.text, ...(bold ? { b: true } : {}), ...(italic ? { i: true } : {}) }); continue; }
    const ln = localName(tk.name);
    if (tk.t === 'open') {
      if (ln === 'body' || ln === 'text') inBody = true;
      else if (ln === 'h') { isHead = true; level = Number(tk.attrs['text:outline-level'] || 1); }
      else if (ln === 'line-break') runs.push({ text: '\n' });
      else if (ln === 'tab') runs.push({ text: '\t' });
      else if (ln === 's') runs.push({ text: ' '.repeat(Math.min(20, Number(tk.attrs['text:c'] || 1))) });
      else if (ln === 'span') { const st = String(tk.attrs['text:style-name'] || ''); if (/bold/i.test(st)) bold = true; if (/italic/i.test(st)) italic = true; }
      else if (ln === 'table' && !table) { flush(); table = []; }
      else if (ln === 'table-row' && table && !row) row = [];
      else if (ln === 'table-cell' && row && !cell) cell = [];
      continue;
    }
    if (ln === 'p' || ln === 'h') flush();
    else if (ln === 'span') { bold = false; italic = false; }
    else if (ln === 'table-cell' && cell) { (row as Run[][]).push(trimRuns(cell)); cell = null; }
    else if (ln === 'table-row' && row) { (table as Run[][][]).push(row); row = null; }
    else if (ln === 'table' && table) { if (table.length && blocks.length < MAX_BLOCKS) blocks.push({ k: 'table', rows: table }); table = null; }
  }
  flush();
  return blocks.length ? { blocks, media: (p) => zip.bytes(p), truncated } : null;
}

export async function readOdfSheet(zip: ZipFile): Promise<SheetDoc | null> {
  const xml = await odfContent(zip);
  if (xml == null) return null;
  const sheets: SheetDoc['sheets'] = [];
  let truncated = false;
  let rows: string[][] | null = null, name = '';
  let row: string[] | null = null, cellText: string[] | null = null, repeat = 1;
  let inText = false;
  for (const tk of xmlTokens(xml)) {
    if (tk.t === 'text') { if (inText && cellText) cellText.push(tk.text); continue; }
    const ln = localName(tk.name);
    if (tk.t === 'open') {
      if (ln === 'table') { rows = []; name = String(tk.attrs['table:name'] || `시트 ${sheets.length + 1}`); }
      else if (ln === 'table-row' && rows) row = [];
      else if (ln === 'table-cell' && row) { cellText = []; repeat = Math.min(MAX_SHEET_COLS, Number(tk.attrs['table:number-columns-repeated'] || 1)); if (tk.self) { for (let i = 0; i < repeat; i++) if (row.length < MAX_SHEET_COLS) row.push(''); cellText = null; } }
      else if (ln === 'p' && cellText) { inText = true; if (cellText.length) cellText.push('\n'); }
      continue;
    }
    if (ln === 'p') inText = false;
    else if (ln === 'table-cell' && cellText && row) { const t = cellText.join(''); for (let i = 0; i < repeat; i++) if (row.length < MAX_SHEET_COLS) row.push(t); cellText = null; }
    else if (ln === 'table-row' && row && rows) { if (rows.length < MAX_SHEET_ROWS) rows.push(row); else truncated = true; row = null; }
    else if (ln === 'table' && rows) {
      //  뒤쪽 빈 행·열은 떨군다 — ODS 는 «남은 칸» 을 반복 횟수로 적어 두어 그대로 그리면 수천 칸이 된다.
      while (rows.length && rows[rows.length - 1].every((c) => !c)) rows.pop();
      let width = 0;
      for (const r of rows) for (let i = r.length - 1; i >= 0; i--) if (r[i]) { width = Math.max(width, i + 1); break; }
      if (rows.length && sheets.length < MAX_SHEETS) sheets.push({ name, rows: rows.map((r) => { const o = r.slice(0, width); while (o.length < width) o.push(''); return o; }) });
      rows = null;
    }
  }
  return sheets.length ? { sheets, truncated } : null;
}

// ── .epub ────────────────────────────────────────────────────────────────────
/** XHTML 한 쪽에서 글자만 — 태그는 버리고 블록 태그 자리에서 줄을 끊는다. */
function xhtmlToBlocks(xml: string, into: Block[], cap: number): boolean {
  let runs: Run[] = [];
  let skip = 0;
  let head = 0;
  let truncated = false;
  const flush = (): void => {
    const rs = trimRuns(runs.map((r) => ({ ...r, text: r.text.replace(/\s+/g, ' ') }))).filter((r) => r.text.trim());
    runs = [];
    const h = head; head = 0;
    if (!rs.length) return;
    if (into.length >= cap) { truncated = true; return; }
    into.push(h ? { k: 'h', level: h, runs: rs } : { k: 'p', runs: rs });
  };
  for (const tk of xmlTokens(xml)) {
    if (tk.t === 'text') { if (!skip) runs.push({ text: tk.text }); continue; }
    const ln = localName(tk.name).toLowerCase();
    if (tk.t === 'open') {
      if ((ln === 'script' || ln === 'style' || ln === 'head') && !tk.self) skip++;
      else if (/^h[1-6]$/.test(ln)) { flush(); head = Number(ln[1]); }
      else if (ln === 'p' || ln === 'div' || ln === 'li' || ln === 'br' || ln === 'tr') flush();
      continue;
    }
    if ((ln === 'script' || ln === 'style' || ln === 'head') && skip) skip--;
    else if (/^h[1-6]$/.test(ln) || ln === 'p' || ln === 'div' || ln === 'li' || ln === 'tr') flush();
  }
  flush();
  return truncated;
}

export async function readEpub(zip: ZipFile): Promise<OfficeDoc | null> {
  const container = await zip.text('META-INF/container.xml');
  let opf = '';
  if (container) for (const tk of xmlTokens(container)) {
    if (tk.t === 'open' && localName(tk.name) === 'rootfile' && tk.attrs['full-path']) { opf = tk.attrs['full-path']; break; }
  }
  if (!opf) opf = zip.match(/\.opf$/i)[0] || '';
  if (!opf) return null;
  const xml = await zip.text(opf);
  if (xml == null) return null;
  const dir = opf.includes('/') ? opf.slice(0, opf.lastIndexOf('/') + 1) : '';
  const manifest: Record<string, string> = {};
  const spine: string[] = [];
  let title = '';
  let inTitle = false;
  for (const tk of xmlTokens(xml)) {
    if (tk.t === 'text') { if (inTitle) title += tk.text; continue; }
    const ln = localName(tk.name);
    if (tk.t === 'open') {
      if (ln === 'item' && tk.attrs.id && tk.attrs.href) manifest[tk.attrs.id] = resolvePart(dir, tk.attrs.href);
      else if (ln === 'itemref' && tk.attrs.idref) spine.push(tk.attrs.idref);
      else if (ln === 'title') { inTitle = true; title = ''; }
      continue;
    }
    if (ln === 'title') inTitle = false;
  }
  const parts = spine.map((id) => manifest[id]).filter(Boolean);
  if (!parts.length) return null;
  const blocks: Block[] = [];
  if (title.trim()) blocks.push({ k: 'h', level: 1, runs: [{ text: title.trim() }] });
  let truncated = false;
  for (const p of parts) {
    if (blocks.length >= MAX_BLOCKS) { truncated = true; break; }
    const doc = await zip.text(p);
    if (doc == null) continue;
    if (xhtmlToBlocks(doc, blocks, MAX_BLOCKS)) truncated = true;
  }
  return blocks.length ? { blocks, media: (p) => zip.bytes(p), truncated } : null;
}

// ── 배정표 ───────────────────────────────────────────────────────────────────
/** 확장자 → 어떤 판독기로 보내나. 미리보기 판정표(file-preview)가 이 표 하나만 본다. */
export type OfficeKind = 'doc' | 'sheet' | 'slides' | 'book' | null;
export function officeKindOf(ext: string): OfficeKind {
  switch (ext) {
    case 'docx': case 'docm': case 'odt': case 'hwpx': return 'doc';
    case 'xlsx': case 'xlsm': case 'ods': return 'sheet';
    case 'pptx': case 'pptm': case 'odp': return 'slides';
    case 'epub': return 'book';
    default: return null;
  }
}

/** 확장자에 맞는 판독기를 태운다. 못 읽으면 null — 화면은 "형식만 알고 내용은 못 읽었다"로 정직하게 떨어진다. */
export async function readOffice(zip: ZipFile, ext: string): Promise<OfficeDoc | SheetDoc | null> {
  switch (ext) {
    case 'docx': case 'docm': return await readDocx(zip);
    case 'pptx': case 'pptm': return await readPptx(zip);
    case 'xlsx': case 'xlsm': return await readXlsx(zip);
    case 'hwpx': return await readHwpx(zip);
    case 'odt': case 'odp': return await readOdfText(zip);
    case 'ods': return await readOdfSheet(zip);
    case 'epub': return await readEpub(zip);
    default: return null;
  }
}

export const isSheetDoc = (d: OfficeDoc | SheetDoc): d is SheetDoc => Array.isArray((d as SheetDoc).sheets);

// ── .rtf — zip 이 아니라 글자다. 제어어를 걷어 본문만 남긴다. ────────────────
/** RTF 코드페이지(`\ansicpg949`) → TextDecoder 이름. 한국어 문서가 이 길로 온다. */
function cpLabel(cp: number): string {
  if (cp === 949 || cp === 10003) return 'euc-kr';
  if (cp === 932) return 'shift_jis';
  if (cp === 936) return 'gbk';
  if (cp === 950) return 'big5';
  if (cp === 65001) return 'utf-8';
  if (cp >= 1250 && cp <= 1258) return 'windows-' + cp;
  return 'windows-1252';
}

export function rtfToText(src: string): string {
  //  RTF 를 온전히 해석하려는 게 아니다 — «무슨 글이 적혀 있나» 를 읽히게 하는 것이 전부다.
  //  한국어에서 중요한 두 가지만 제대로 한다:
  //   ① `\'xx` 는 **바이트**다 — 한 글자씩 charCode 로 바꾸면 한글이 깨진다. 모아 두었다가 코드페이지로 한 번에 푼다.
  //   ② `\uNNNN` 뒤에는 옛 리더용 **대체 문자**가 따라온다(`\ucN` 개수만큼) — 안 건너뛰면 같은 글자가 두 번 나온다.
  const pieces: Array<string | number> = [];
  let cp = 1252;
  let uc = 1;          // \uN 뒤에 건너뛸 대체 문자 수
  let skip = 0;        // 지금 건너뛰는 중인 대체 문자 수
  let depth = 0;
  let skipUntil = -1;  // 이 깊이 아래는 통째로 버린다(글꼴표·색표 등)
  const skipGroups = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'generator', 'mmathpr', 'listtable', 'rsidtbl']);
  const put = (v: string | number): void => { if (skipUntil < 0) pieces.push(v); };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { depth++; continue; }
    if (c === '}') { if (skipUntil >= 0 && depth <= skipUntil) skipUntil = -1; depth--; skip = 0; continue; }
    if (c === '\\') {
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i));
      if (m) {
        const word = m[1], num = m[2] === undefined ? null : Number(m[2]);
        i += m[0].length - 1;
        if (skipGroups.has(word.toLowerCase())) { skipUntil = depth; continue; }
        if (word === 'ansicpg' && num != null) cp = num;
        else if (word === 'uc' && num != null) uc = Math.max(0, Math.min(10, num));
        else if (word === 'u' && num != null) { put(String.fromCharCode(num < 0 ? num + 65536 : num)); skip = uc; }
        else if (skip > 0) skip--;                                   // 대체 문자 자리의 제어어
        else if (word === 'par' || word === 'line' || word === 'sect' || word === 'row') put('\n');
        else if (word === 'tab' || word === 'cell') put('\t');
        continue;
      }
      const h = /^\\'([0-9a-fA-F]{2})/.exec(src.slice(i));
      if (h) { i += h[0].length - 1; if (skip > 0) skip--; else put(parseInt(h[1], 16)); continue; }
      i++;                                    // \{ \} \\ 같은 이스케이프
      if (src[i]) { if (skip > 0) skip--; else put(src[i]); }
      continue;
    }
    if (c === '\r' || c === '\n') continue;   // RTF 원문의 줄바꿈은 조판용이라 글이 아니다
    if (skip > 0) { skip--; continue; }
    put(c);
  }
  //  이어진 바이트들을 코드페이지로 한 번에 푼다 — 조각조각 풀면 2바이트 한글이 반으로 잘린다.
  let out = '';
  let buf: number[] = [];
  const flush = (): void => {
    if (!buf.length) return;
    try { out += new TextDecoder(cpLabel(cp)).decode(new Uint8Array(buf)); }
    catch { out += buf.map((b) => String.fromCharCode(b)).join(''); }
    buf = [];
  };
  for (const p of pieces) { if (typeof p === 'number') buf.push(p); else { flush(); out += p; } }
  flush();
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

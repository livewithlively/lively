// lib/file-preview.ts — 파일 미리보기 **단일 렌더러**(#1436 후속).
//
// ## 왜 하나로 모았나
//  같은 파일이 화면마다 다르게 열리고 있었다(실측):
//   · `.csv` — 프로젝트 폴더 모달은 textarea 원문 / 홈 팀공유폴더 모달은 표
//   · `.mp4`·`.mp3` — 프로젝트 모달은 "미리보기 지원하지 않는 형식" / 홈은 재생
//   · `.md` — 프로젝트 모달은 편집·저장 가능 / 홈은 읽기 전용
//  두 모달이 프로젝트 상세와 대시보드에서 **각각 따로 자란** 결과다. 기능이 갈릴 이유가 없고, 갈려 있으면
//  사용자는 "왜 여기선 표로 나오고 저기선 안 나오지"를 버그로 신고한다. 그래서 **판정·렌더·툴바 동작**을
//  여기 한 곳으로 모으고, 각 화면은 '어디에 놓을지'와 '버튼을 어떤 모양으로 그릴지'만 정한다.
//  → 세 소비자: 홈 폴더 브라우저(dash/widget-folders) · 프로젝트 파일 뷰어(projects/files-cards) ·
//    공유 링크 전체페이지(filepage). 각각의 장점이 이제 셋 다에 있다.
//
// ## 화면별로 남는 차이 (의도된 것)
//  ① 놓이는 자리 — 프로젝트는 오버레이 모달(섹션이 인라인이라 제자리 전환할 컨테이너가 없다),
//     홈은 브라우저 모달 안 제자리 전환, 공유 링크는 전체페이지. 이건 문맥이 실제로 달라서다.
//  ② 크기 — 컨테이너가 다르니 max-height 등이 다르다. `cls` 로 화면별 클래스를 덧붙여 기존 규칙을 보존한다
//     (공유 클래스 `fp-*` 가 기본, 화면 클래스가 크기를 덮는다). ⚠ 기존 셀렉터는 지우지 않는다 —
//     scripts/check-css-drops.mjs 가 HEAD 셀렉터 유실을 실패로 잡는다(2026-06-30 사고 재발 방지).
//
// ## 「미지원」을 없앤다 (#3778, 원준 2026-09-09: "미리보기 안 되는 거 없이 최대한 다 붙여줘")
//  종전엔 확장자 표에 없으면 그대로 "미리보기를 지원하지 않아요" 였다. 자료 탭은 **원본을 훑는 자리**라
//  그 한 줄이 뜨는 순간 그 자리에 있을 이유가 사라진다(사무문서·한글·압축은 전부 그 줄이었다).
//  그래서 판정을 세 겹으로 두고 **마지막 겹이 반드시 무언가를 그린다**:
//   ① 확장자 표 — 그림·PDF·표·미디어·글/코드(종전) + **사무문서(docx·xlsx·pptx·hwpx·odf·epub)** · 압축 · RTF
//   ② 바이트 판정 — 확장자가 없거나 거짓이면 머리 바이트로 다시 본다(zip 인 .hwp, 확장자 없는 텍스트…)
//   ③ 마지막 겹 — 그래도 모르면 **바이트를 보여준다**(16진 + 아스키). "못 본다"가 아니라 "이게 그 파일이다".
//  사무문서 판독기(lib/office.ts)는 **필요할 때만 받는다** — 그림 한 장 보자고 파서를 내려받지 않는다.
//
// leaf 규약: lib/ 안(dom·markdown·zip·office)만 딛는다. 페이지 모듈을 import 하지 않는다.
import { el } from './dom.js';
import { renderMarkdown } from './markdown.js';
import type { Block, OfficeDoc, Run, SheetDoc } from './office.js';

// ── 타입 판정표 — 이 표가 곧 "무엇을 어떻게 보여주는가"의 단일 소스다. ──
const IMG_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif' };
const AUDIO_MIME: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', opus: 'audio/opus' };
const VIDEO_MIME: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg', mkv: 'video/x-matroska' };
const PREVIEW_IMG = Object.keys(IMG_MIME);
const PREVIEW_TABLE = new Set(['csv', 'tsv']);
const MEDIA_MAX = 80 * 1024 * 1024;   // 미디어는 서버 인라인 상한을 우회해 받으므로 메모리 보호 상한을 클라가 둔다
const HTML_EXTS = new Set(['html', 'htm']);
const MD_EXTS = new Set(['md', 'markdown']);
const PREVIEW_TEXT = ['txt', 'text', 'md', 'markdown', 'json', 'jsonl', 'ndjson', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'xml', 'sql', 'java', 'go', 'rs', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'hh', 'cs', 'rb', 'php', 'lua', 'r', 'kt', 'kts', 'swift', 'scala', 'dart', 'vue', 'svelte', 'pl', 'pm', 'ex', 'exs', 'erl', 'hs', 'clj', 'zig', 'nim', 'm', 'mm', 'gradle', 'groovy', 'tf', 'hcl', 'proto', 'graphql', 'gql', 'ipynb', 'patch', 'diff', 'srt', 'vtt', 'tex', 'bib', 'rst', 'adoc', 'org', 'eml', 'log', 'env', 'gitignore', 'gitattributes', 'editorconfig', 'dockerfile', 'makefile', 'lock'];
const PREVIEW_CODE = new Set(['json', 'jsonl', 'ndjson', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'styl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'xml', 'sql', 'java', 'go', 'rs', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'hh', 'cs', 'rb', 'php', 'lua', 'r', 'kt', 'kts', 'swift', 'scala', 'dart', 'vue', 'svelte', 'pl', 'pm', 'ex', 'exs', 'erl', 'hs', 'clj', 'zig', 'nim', 'm', 'mm', 'gradle', 'groovy', 'tf', 'hcl', 'proto', 'graphql', 'gql', 'ipynb', 'patch', 'diff', 'dockerfile', 'makefile', 'lock']);
// 확장자가 없는 흔한 텍스트 파일 — '미지원'으로 떨어지지 않게.
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', 'changelog', 'agents.md', '.gitignore', '.env']);
/** 사무문서 — zip 을 풀어 우리 손으로 그린다(lib/office.ts). */
const OFFICE_EXTS = new Set(['docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm', 'hwpx', 'odt', 'ods', 'odp', 'epub']);
/** 압축 — 안에 무엇이 들었는지 **목록**이 곧 미리보기다. */
const ARCHIVE_EXTS = new Set(['zip', 'jar', 'war', 'apk', 'ipa', 'whl', 'nupkg', 'crx', 'xpi', 'vsix', 'key', 'pages', 'numbers']);
/** 브라우저가 디코딩을 보장하지 않는 그림 — 그려 보고 실패하면 사연을 말한다(사파리는 heic 를 그린다). */
const RISKY_IMG = new Set(['heic', 'heif', 'tif', 'tiff', 'avif', 'jxl']);

function fileExtOf(name: any): string {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i + 1).toLowerCase() : '';
}

// CSV/TSV → 행렬. 따옴표 필드(구분자·개행·"" 이스케이프) 처리. 대용량 보호로 앞부분만.
function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; if (rows.length > 3000) break; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function tablePreview(text: string, delim: string, cls?: string): any {
  const wrap = el('div', { class: 'fp-tablewrap' + (cls ? ' ' + cls : '') });
  const rows = parseDelimited(text, delim);
  if (!rows.length) { wrap.append(el('div', { class: 'fp-msg' }, '빈 파일이에요.')); return wrap; }
  const MAXR = 500, MAXC = 60;
  const head = rows[0].slice(0, MAXC);
  const table = el('table', { class: 'fp-table' });
  const htr = el('tr', {}, el('th', { class: 'fp-cn' }, '#'));
  for (const cell of head) htr.append(el('th', {}, cell));
  table.append(el('thead', {}, htr));
  const tbody = el('tbody');
  const body = rows.slice(1, 1 + MAXR);
  body.forEach((r, i) => {
    const tr = el('tr', {}, el('td', { class: 'fp-cn' }, String(i + 1)));
    for (let c = 0; c < head.length; c++) tr.append(el('td', { title: r[c] != null ? r[c] : '' }, r[c] != null ? r[c] : ''));
    tbody.append(tr);
  });
  table.append(tbody);
  wrap.append(table);
  const extra = (rows.length - 1) - body.length;
  if (extra > 0) wrap.append(el('div', { class: 'fp-tablemore' }, '… 그리고 ' + extra.toLocaleString() + '개 행 더 — 전체는 다운로드해 확인하세요.'));
  return wrap;
}

/**
 * html 렌더 — **sandbox iframe + srcdoc**.
 *  남이 올린 임의 html 을 같은 오리진에 심으면 그 안 <script> 가 세션 쿠키·localStorage 토큰을 가져간다(저장형 XSS).
 *   · `allow-same-origin` **미부여**가 핵심 — 문서가 불투명 오리진을 갖고 부모 DOM·쿠키·저장소에 손이 닿지 않는다.
 *   · `allow-scripts` 는 준다 — 스크립트로 그리는 보고서가 백지로 뜨면 '렌더해서 보여준다'가 성립하지 않는다.
 *     ⚠ 이 둘을 **함께** 주면 샌드박스가 스스로 풀린다. 절대 같이 주지 말 것.
 *   · `allow-top-navigation` 미부여 → 이 페이지를 피싱 사이트로 갈아치울 수 없다.
 *  한계: srcdoc 엔 base URL 이 없어 상대경로 이미지·외부 CSS 는 안 붙는다(자기완결 단일 html 이 대상).
 */
function htmlFrame(text: string, name: string, cls?: string): any {
  const frame = el('iframe', {
    class: 'fp-html' + (cls ? ' ' + cls : ''), title: name,
    sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals',
    referrerpolicy: 'no-referrer',
  });
  frame.srcdoc = text;
  return frame;
}

function codeBlock(text: string, ext: string, cls?: string): any {
  const pre = el('pre', { class: 'fp-code' + (PREVIEW_CODE.has(ext) ? ' is-code' : '') + (cls ? ' ' + cls : '') });
  pre.textContent = text;
  return pre;
}

// ══ 사무문서·압축·바이트 — 「미지원」을 대신하는 세 렌더러 ═══════════════════════════════════
//  판독기(lib/office.ts·lib/cfb.ts·lib/zip.ts)는 **여기서 필요할 때만** 받는다. 그림 한 장 보자고
//  docx 파서를 내려받을 이유가 없다(pdf.js 를 그렇게 다루는 것과 같은 규율 — v2/file-preview.ts).
const officeMod = () => import('./office.js');
const zipMod = () => import('./zip.js');
const cfbMod = () => import('./cfb.js');

/** 바이트 머리로 그림 종류를 알아본다 — 문서 안에 든 그림엔 확장자가 없다(`word/media/image1`). */
function sniffImageMime(b: Uint8Array): string {
  const is = (...sig: number[]): boolean => sig.every((v, i) => b[i] === v);
  if (is(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (is(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (is(0x47, 0x49, 0x46)) return 'image/gif';
  if (is(0x42, 0x4d)) return 'image/bmp';
  if (is(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0x3c) return 'image/svg+xml';   // '<' — svg
  return 'application/octet-stream';
}

/** 문서 글자 한 조각 — 굵게·기울임·밑줄·취소선·링크를 그대로 살린다(줄바꿈은 <br>). */
function runNode(r: Run): any {
  const kids: any[] = [];
  String(r.text).split('\n').forEach((p, i) => { if (i) kids.push(el('br')); if (p) kids.push(p); });
  let n: any = kids.length === 1 && typeof kids[0] === 'string' ? null : el('span', {}, ...kids);
  const wrap = (tag: string): void => { n = el(tag, {}, n ?? kids[0]); };
  if (r.b) wrap('b');
  if (r.i) wrap('i');
  if (r.u) wrap('u');
  if (r.s) wrap('s');
  //  문서 안 링크는 http(s)·mailto 만 산다 — javascript: 를 그대로 걸면 남의 문서가 우리 페이지에서 실행된다.
  if (r.href && /^(https?:|mailto:)/i.test(r.href)) return el('a', { href: r.href, target: '_blank', rel: 'noopener noreferrer' }, n ?? kids[0]);
  return n ?? kids[0];
}
const runsNode = (runs: Run[]): any[] => runs.map(runNode);

/** 중립 문서 모델 → DOM. 그림은 아카이브에서 꺼내 blob 으로 건다(문서 하나에 수백 장이면 앞쪽만). */
function officeBody(doc: OfficeDoc, cls: string | undefined, urls: string[]): any {
  const wrap = el('article', { class: 'fp-doc' + (cls ? ' ' + cls : '') });
  let imgs = 0;
  for (const b of doc.blocks as Block[]) {
    if (b.k === 'h') { wrap.append(el('h' + Math.min(6, Math.max(1, b.level)), {}, ...runsNode(b.runs))); continue; }
    if (b.k === 'sep') { wrap.append(el('div', { class: 'fp-docsep', text: b.title })); continue; }
    if (b.k === 'p') {
      const p = el(b.list ? 'li' : 'p', { class: b.list ? 'fp-docli' : null }, ...runsNode(b.runs));
      if (b.indent) p.style.marginInlineStart = Math.min(6, b.indent) * 16 + 'px';
      wrap.append(p);
      continue;
    }
    if (b.k === 'table') {
      const t = el('table', { class: 'fp-table' });
      const body = el('tbody');
      b.rows.forEach((row, ri) => {
        const tr = el('tr');
        for (const cell of row) tr.append(el(ri === 0 ? 'th' : 'td', {}, ...runsNode(cell)));
        body.append(tr);
      });
      t.append(body);
      wrap.append(el('div', { class: 'fp-tablewrap' }, t));
      continue;
    }
    if (b.k === 'img' && imgs < 40) {
      imgs++;
      const im = el('img', { class: 'fp-docimg', alt: '', loading: 'lazy' });
      void doc.media(b.part).then((bytes) => {
        if (!bytes) { im.remove(); return; }
        const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: sniffImageMime(bytes) }));
        urls.push(u);
        im.src = u;
      }).catch(() => im.remove());
      wrap.append(im);
    }
  }
  if (doc.truncated) wrap.append(el('div', { class: 'fp-tablemore' }, '… 문서가 길어 앞부분만 보여 드려요 — 전체는 내려받아 확인하세요.'));
  return wrap;
}

/** 통합문서(xlsx·ods) → 시트 단추 + 표. 시트가 하나면 단추 줄을 두지 않는다. */
function sheetBody(doc: SheetDoc, cls: string | undefined, mkBtn: PreviewHost['mkBtn']): { body: any; tools: any[] } {
  const host = el('div', { class: 'fp-wrap' });
  const paint = (i: number): void => {
    const s = doc.sheets[i];
    const wrap = el('div', { class: 'fp-tablewrap' + (cls ? ' ' + cls : '') });
    if (!s.rows.length) wrap.append(el('div', { class: 'fp-msg' }, '빈 시트예요.'));
    else {
      const t = el('table', { class: 'fp-table' });
      const head = s.rows[0];
      const htr = el('tr', {}, el('th', { class: 'fp-cn' }, '#'));
      for (const c of head) htr.append(el('th', {}, c));
      t.append(el('thead', {}, htr));
      const tb = el('tbody');
      s.rows.slice(1).forEach((r, ri) => {
        const tr = el('tr', {}, el('td', { class: 'fp-cn' }, String(ri + 1)));
        for (let c = 0; c < head.length; c++) tr.append(el('td', { title: r[c] || '' }, r[c] || ''));
        tb.append(tr);
      });
      t.append(tb);
      wrap.append(t);
    }
    if (doc.truncated) wrap.append(el('div', { class: 'fp-tablemore' }, '… 시트가 커서 앞부분만 보여 드려요 — 전체는 내려받아 확인하세요.'));
    host.replaceChildren(wrap);
    for (const [j, b] of tabs.entries()) b.classList.toggle('on', j === i);
  };
  const tabs: any[] = doc.sheets.length > 1
    ? doc.sheets.map((s, i) => mkBtn(s.name || `시트 ${i + 1}`, () => paint(i)))
    : [];
  paint(0);
  return { body: host, tools: tabs };
}

/** 압축 — 안에 무엇이 들었나가 곧 미리보기다(풀지 않는다: 중앙 디렉터리만 읽는다). */
function archiveBody(entries: Array<{ name: string; size: number; dir: boolean }>, cls: string | undefined): any {
  const files = entries.filter((e) => !e.dir);
  const wrap = el('div', { class: 'fp-tablewrap' + (cls ? ' ' + cls : '') });
  const t = el('table', { class: 'fp-table' });
  t.append(el('thead', {}, el('tr', {}, el('th', { class: 'fp-cn' }, '#'), el('th', {}, '이름'), el('th', {}, '크기'))));
  const tb = el('tbody');
  const shown = files.slice(0, 500);
  shown.forEach((e, i) => tb.append(el('tr', {},
    el('td', { class: 'fp-cn' }, String(i + 1)),
    el('td', { title: e.name }, e.name),
    el('td', { class: 'fp-cn' }, bytesShort(e.size)))));
  t.append(tb);
  wrap.append(el('div', { class: 'fp-docsep', text: `압축 파일 ${files.length.toLocaleString()}개` }), t);
  if (files.length > shown.length) wrap.append(el('div', { class: 'fp-tablemore' }, '… 그리고 ' + (files.length - shown.length).toLocaleString() + '개 더.'));
  return wrap;
}
function bytesShort(n: number): string {
  if (!(n > 0)) return '0';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return Math.round(n / 1024) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

/** 마지막 겹 — 무엇인지 못 알아본 바이트. **그래도 보여준다**(16진 + 아스키). 「지원하지 않아요」로 끝내지 않는다. */
function hexBody(bytes: Uint8Array, cls: string | undefined): any {
  const N = Math.min(bytes.length, 4096);
  const lines: string[] = [];
  for (let i = 0; i < N; i += 16) {
    const row = bytes.subarray(i, Math.min(i + 16, N));
    const hex = Array.from(row).map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const asc = Array.from(row).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('');
    lines.push(i.toString(16).padStart(8, '0') + '  ' + hex + '  ' + asc);
  }
  const pre = el('pre', { class: 'fp-code is-code' + (cls ? ' ' + cls : '') });
  pre.textContent = lines.join('\n') + (bytes.length > N ? '\n… 이하 생략(' + bytesShort(bytes.length) + ')' : '');
  return el('div', { class: 'fp-wrap' },
    el('div', { class: 'fp-docsep', text: '알려진 형식이 아니에요 — 파일의 실제 바이트를 보여 드립니다.' }), pre);
}

/** 글자로 읽을 만한 바이트인가 — 확장자가 거짓이거나 없을 때 마지막으로 묻는다. */
function looksText(bytes: Uint8Array): string | null {
  const n = Math.min(bytes.length, 8192);
  if (!n) return '';
  let ctrl = 0;
  for (let i = 0; i < n; i++) { const b = bytes[i]; if (b === 0) return null; if (b < 9 || (b > 13 && b < 32)) ctrl++; }
  if (ctrl / n > 0.05) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* UTF-8 이 아니다 */ }
  //  UTF-8 이 아니면 한국어 레거시(CP949)일 때가 많다 — 브라우저 내장 디코더가 있으면 그걸로 한 번 더.
  try { const s = new TextDecoder('euc-kr').decode(bytes); return s.includes('�') ? null : s; } catch { return null; }
}

export interface PreviewHost {
  /** 파일 이름(확장자 판정·표시용). */
  name: string;
  /** 알려진 크기(있으면 미디어 상한 사전 판정에 쓴다 — 없으면 받아 보고 판단). */
  size?: number;
  /** 인라인 미리보기용 응답(서버 미리보기 상한 적용 — 413 이면 '너무 큼' 안내). */
  fetchView: () => Promise<Response>;
  /** 원본 응답(상한 우회 — 미디어 전용). */
  fetchDownload: () => Promise<Response>;
  /** 화면별 추가 클래스(기존 크기 규칙 보존). 키: img·pdf·html·md·code·table·audio·video·msg */
  cls?: Record<string, string>;
  /** PDF 뷰어 파라미터(예 '#navpanes=0&toolbar=1&view=FitH'). 기본 '#toolbar=1&view=FitH'. */
  pdfHash?: string;
  /** 주면 md·텍스트를 **편집·저장**할 수 있다(없으면 읽기 전용). */
  save?: (text: string) => Promise<void>;
  /** 툴바 버튼 팩토리 — 버튼 '모양'은 화면 소관이고 이 모듈은 '동작·라벨'만 소유한다. */
  mkBtn: (label: string, onClick: () => void) => any;
  /** 저장 성공 알림(토스트 등) — 화면이 소유. */
  onSaved?: () => void;
  /** 저장 실패 알림. */
  onError?: (msg: string) => void;
}

export interface PreviewOut {
  /** 본문 노드. */
  body: any;
  /** 툴바에 얹을 버튼들(원문 토글·편집·저장). 없으면 빈 배열. */
  tools: any[];
  /** 넓은 컨테이너가 유리한가(모달이 이걸로 ov-box-wide 등을 결정). */
  wide: boolean;
}

/**
 * 파일 하나의 미리보기를 만든다 — 타입 판정·데이터 수신·본문 렌더·툴바 동작까지.
 *  실패(413·기타)는 예외가 아니라 **안내 노드**로 돌려준다 — 화면마다 다르게 처리할 일이 아니다.
 */
async function buildFilePreview(host: PreviewHost): Promise<PreviewOut> {
  const name = host.name;
  const ext = fileExtOf(name);
  const cls = host.cls || {};
  const msg = (t: any): PreviewOut => ({ body: el('div', { class: 'fp-msg' + (cls.msg ? ' ' + cls.msg : '') }, t), tools: [], wide: false });

  // 인라인 응답 수신 — 413(서버 미리보기 상한)과 그 외 실패를 구분해 안내한다.
  const readable = async (fetcher: () => Promise<Response>, what: string): Promise<Response | { fail: PreviewOut }> => {
    let res: Response;
    try { res = await fetcher(); }
    catch (e: any) { return { fail: msg('파일을 불러오지 못했어요 — ' + ((e && e.message) || e)) }; }
    if (res.ok) return res;
    //  404 는 «형식을 모른다» 가 아니라 **파일이 그 자리에 없다** 는 사실이다 — 자료 목록은 남았는데
    //   폴더에서 지워졌거나 다른 컴퓨터(노드)에 있는 경우다. 사연이 다르면 안내도 달라야 한다(#3778 실측).
    return { fail: msg(res.status === 413
      ? what + '이(가) 커서 미리보기할 수 없어요 — 다운로드해 확인하세요.'
      : res.status === 404
        ? '이 파일이 폴더에 없어요 — 지워졌거나 다른 컴퓨터에 있습니다.'
        : '미리보기를 불러오지 못했어요 (' + res.status + ')') };
  };
  const failed = (r: any): r is { fail: PreviewOut } => !!r && !!r.fail;
  const urls: string[] = [];   // 문서 안 그림들의 blob 주소(수명은 이 미리보기와 같다)

  if (PREVIEW_IMG.includes(ext)) {
    const r = await readable(host.fetchView, '이미지'); if (failed(r)) return r.fail;
    const img = el('img', { class: 'fp-img' + (cls.img ? ' ' + cls.img : ''), alt: name });
    img.src = URL.createObjectURL(new Blob([await r.blob()], { type: IMG_MIME[ext] || 'application/octet-stream' }));
    //  heic·tiff 는 브라우저마다 그릴 수 있고 없고가 갈린다(사파리는 heic 를 그린다). 그려 보고 **실패했을 때만**
    //   사연을 말한다 — 표에서 미리 빼 버리면 그릴 수 있는 브라우저에서까지 안 보인다.
    if (RISKY_IMG.has(ext)) {
      const box = el('div', { class: 'fp-wrap' }, img);
      img.addEventListener('error', () => box.replaceChildren(el('div', { class: 'fp-msg' + (cls.msg ? ' ' + cls.msg : '') },
        '.' + ext + ' 그림은 이 브라우저가 펴지 못해요 — 내려받아 확인하거나 PNG·JPG 로 저장해 다시 올리세요.')), { once: true });
      return { body: box, tools: [], wide: false };
    }
    return { body: img, tools: [], wide: false };
  }

  if (ext === 'pdf') {
    // blob 에 MIME 을 명시해야 iframe 이 **브라우저 내장 PDF 뷰어**를 띄운다 —
    //  안 주면 %PDF 원시바이트가 텍스트로 노출된다(두 화면이 각각 이 함정을 밟았던 자리).
    const r = await readable(host.fetchView, 'PDF'); if (failed(r)) return r.fail;
    const frame = el('iframe', { class: 'fp-pdf' + (cls.pdf ? ' ' + cls.pdf : ''), title: name });
    frame.src = URL.createObjectURL(new Blob([await r.blob()], { type: 'application/pdf' }))
      + (host.pdfHash || '#toolbar=1&view=FitH');
    return { body: frame, tools: [], wide: true };
  }

  if (PREVIEW_TABLE.has(ext)) {
    const r = await readable(host.fetchView, '파일'); if (failed(r)) return r.fail;
    return { body: tablePreview(await r.text(), ext === 'tsv' ? '\t' : ',', cls.table), tools: [], wide: true };
  }

  if (AUDIO_MIME[ext] || VIDEO_MIME[ext]) {
    // 미디어는 인라인 상한을 넘기 쉬워 원본으로 받고, 메모리 보호는 클라 상한으로.
    if (host.size && host.size > MEDIA_MAX) return msg('파일이 커서 미리보기 대신 다운로드해 확인하세요.');
    const r = await readable(host.fetchDownload, '파일'); if (failed(r)) return r.fail;
    const isVid = !!VIDEO_MIME[ext];
    const src = URL.createObjectURL(new Blob([await r.blob()], { type: isVid ? VIDEO_MIME[ext] : AUDIO_MIME[ext] }));
    const extra = isVid ? cls.video : cls.audio;
    return {
      body: el(isVid ? 'video' : 'audio', { class: (isVid ? 'fp-video' : 'fp-audio') + (extra ? ' ' + extra : ''), src, controls: 'true', preload: 'metadata', playsinline: 'true' }),
      tools: [], wide: isVid,
    };
  }

  const isMd = MD_EXTS.has(ext);
  const isHtml = HTML_EXTS.has(ext);
  const isText = PREVIEW_TEXT.includes(ext) || TEXT_NAMES.has(String(name).toLowerCase());

  // ── 글도 그림도 아닌 것 — 여기서 「지원하지 않아요」로 끝내지 않는다(#3778). ──────────────────
  //  ① 사무문서(zip+XML) ② 한글 .hwp(OLE) ③ 압축 목록 ④ 바이트 판정(확장자가 없거나 거짓일 때)
  //  ⑤ 그래도 모르면 16진 — 어느 갈래로 가든 **무언가는 그려진다**.
  if (!isMd && !isHtml && !isText) {
    const r0 = await readable(host.fetchView, '파일'); if (failed(r0)) return r0.fail;
    const buf = await r0.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const { openZip, looksZip } = await zipMod();

    //  ⓐ zip 계열 — 확장자보다 **바이트**를 믿는다(hwpx 를 .hwp 로 저장해 오는 일이 흔하다).
    if (looksZip(buf)) {
      const zip = openZip(buf);
      if (zip) {
        const { officeKindOf, readOffice, isSheetDoc } = await officeMod();
        //  확장자가 사무문서가 아니어도 안쪽 구조로 다시 본다 — [Content_Types].xml 이 있으면 OOXML 이다.
        let useExt = ext;
        if (!officeKindOf(useExt)) {
          if (zip.has('word/document.xml')) useExt = 'docx';
          else if (zip.has('xl/workbook.xml')) useExt = 'xlsx';
          else if (zip.match(/^ppt\/slides\/slide\d+\.xml$/).length) useExt = 'pptx';
          else if (zip.match(/^Contents\/section\d+\.xml$/i).length) useExt = 'hwpx';
          else if (zip.has('META-INF/container.xml')) useExt = 'epub';
          else if (zip.has('content.xml')) {
            //  ODF 는 `mimetype` 항목이 자기가 무엇인지 적어 둔다 — 문서/시트/발표가 렌더러가 다르다.
            const mt = (await zip.text('mimetype')) || '';
            useExt = mt.includes('spreadsheet') ? 'ods' : mt.includes('presentation') ? 'odp' : 'odt';
          }
        }
        const doc = officeKindOf(useExt) ? await readOffice(zip, useExt) : null;
        if (doc) {
          if (isSheetDoc(doc)) {
            const out = sheetBody(doc, cls.table, host.mkBtn);
            return { body: out.body, tools: out.tools, wide: true };
          }
          return { body: officeBody(doc, cls.md, urls), tools: [], wide: true };
        }
        //  ⓑ 애플 iWork(.key·.pages·.numbers)는 안쪽이 제 규격이지만, **자기가 만든 미리보기**를 넣어 둔다.
        const ql = zip.entries.find((e) => /^(QuickLook\/Preview\.pdf|preview(-web)?\.jpe?g|preview\.png)$/i.test(e.name));
        if (ql) {
          const b = await zip.bytes(ql.name);
          if (b) {
            const isPdf = /\.pdf$/i.test(ql.name);
            const u = URL.createObjectURL(new Blob([b as BlobPart], { type: isPdf ? 'application/pdf' : sniffImageMime(b) }));
            urls.push(u);
            return isPdf
              ? { body: el('iframe', { class: 'fp-pdf' + (cls.pdf ? ' ' + cls.pdf : ''), title: name, src: u + (host.pdfHash || '#toolbar=1&view=FitH') }), tools: [], wide: true }
              : { body: el('img', { class: 'fp-img' + (cls.img ? ' ' + cls.img : ''), alt: name, src: u }), tools: [], wide: false };
          }
        }
        //  못 읽는 사무형식이어도 **안에 무엇이 들었는지**는 말할 수 있다.
        return { body: archiveBody(zip.entries, cls.table), tools: [], wide: true };
      }
    }

    //  ⓒ 한글 .hwp — 한컴이 파일 안에 넣어 둔 미리보기(첫 쪽 그림 + 앞부분 글자)를 꺼내 그린다.
    const { looksCfb, openCfb, hwpPreview } = await cfbMod();
    if (looksCfb(buf)) {
      const cfb = openCfb(buf);
      const pv = cfb ? hwpPreview(cfb) : null;
      if (pv && (pv.text || pv.image)) {
        const box = el('div', { class: 'fp-wrap' });
        if (pv.image) {
          const u = URL.createObjectURL(new Blob([pv.image as BlobPart], { type: sniffImageMime(pv.image) }));
          urls.push(u);
          box.append(el('img', { class: 'fp-img' + (cls.img ? ' ' + cls.img : ''), alt: name, src: u }));
        }
        if (pv.text) {
          box.append(el('div', { class: 'fp-docsep', text: pv.image ? '문서 앞부분' : '문서 앞부분(첫 쪽 그림이 없는 파일이에요)' }));
          box.append(codeBlock(pv.text, '', cls.code));
        }
        box.append(el('div', { class: 'fp-tablemore' }, '한글 문서는 파일 안에 든 미리보기만 보여 드려요 — 전체는 내려받아 한글에서 여세요.'));
        return { body: box, tools: [], wide: false };
      }
      return msg('옛 오피스 형식(.' + (ext || 'doc') + ')이라 브라우저가 펴지 못해요 — 내려받아 원래 앱에서 열거나, PDF·최신 형식으로 저장해 다시 올리면 여기서 바로 보입니다.');
    }

    //  ⓓ 바이트가 글자면 글자로 — 확장자가 없거나 우리 표에 없을 뿐인 텍스트가 대부분이다.
    const sniffed = looksText(bytes);
    if (sniffed !== null) {
      if (!sniffed) return msg('빈 파일이에요.');
      //  .rtf 는 zip 도 CFB 도 아닌 **글자**다 — 제어어를 걷어 본문만 남긴다.
      const shown = ext === 'rtf' ? (await officeMod()).rtfToText(sniffed) : sniffed;
      return { body: codeBlock(shown, ext === 'rtf' ? '' : ext, cls.code), tools: [], wide: false };
    }
    //  ⓔ 마지막 겹 — 그래도 바이트는 보여 준다.
    return { body: hexBody(bytes, cls.code), tools: [], wide: false };
  }

  const r = await readable(host.fetchView, '파일'); if (failed(r)) return r.fail;
  let text = await r.text();
  if (ext === 'json') { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 원문 유지 */ } }

  // ── md·html: 렌더가 기본, '원문'으로 토글. 텍스트·코드: 코드 표시가 기본, '편집'으로 토글. ──
  //  ⭐ save 가 있으면 **원문/편집 화면이 곧 textarea** 다 — 종전에 프로젝트 모달은 '편집' 토글,
  //   홈 모달은 '원문' 토글로 서로 다른 버튼을 뒀다. 둘은 같은 것이라 하나로 합쳤다(편집 가능하면 편집칸).
  const wrap = el('div', { class: 'fp-wrap' });
  const ta = host.save ? el('textarea', { class: 'fp-edit' + (cls.code ? ' ' + cls.code : '') }) : null;
  if (ta) ta.value = text;
  const rendered = (): any => (isMd
    ? el('article', { class: 'md-rendered fp-md' + (cls.md ? ' ' + cls.md : '') }, renderMarkdown(text))
    : isHtml
      ? htmlFrame(text, name, cls.html)
      : codeBlock(text, ext, cls.code));
  const rawNode = (): any => (ta || codeBlock(text, ext, cls.code));

  let raw = !isMd && !isHtml && !host.save ? false : false;   // 기본은 항상 렌더/코드 표시
  const saveBtn = host.save ? host.mkBtn('저장', () => { /* 아래에서 재배선 */ }) : null;
  const paint = (): void => {
    wrap.replaceChildren(raw ? rawNode() : rendered());
    if (saveBtn) saveBtn.hidden = !raw;   // 저장은 원문/편집 화면에서만
  };
  const tools: any[] = [];
  // 버튼 라벨: 렌더 형태가 있는 것(md·html)은 '원문', 없는 것(텍스트·코드)은 '편집' — 사용자가 보는 행동이 다르다.
  const onLabel = (isMd || isHtml) ? '</> 원문' : '✎ 편집';
  const offLabel = (isMd || isHtml) ? '👁 렌더 보기' : '✕ 편집 끝';
  if (isMd || isHtml || host.save) {
    const toggle = host.mkBtn(onLabel, () => {
      raw = !raw;
      toggle.textContent = raw ? offLabel : onLabel;
      paint();
    });
    tools.push(toggle);
  }
  if (saveBtn && host.save) {
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try { await host.save!(ta!.value); text = ta!.value; host.onSaved && host.onSaved(); }
      catch (e: any) { host.onError && host.onError((e && e.message) || String(e)); }
      saveBtn.disabled = false;
    };
    tools.push(saveBtn);
  }
  paint();
  return { body: wrap, tools, wide: isMd || isHtml };
}

export {
  ARCHIVE_EXTS, AUDIO_MIME, IMG_MIME, MEDIA_MAX, OFFICE_EXTS, PREVIEW_CODE, PREVIEW_IMG, PREVIEW_TABLE, PREVIEW_TEXT, RISKY_IMG, VIDEO_MIME,
  buildFilePreview, codeBlock, fileExtOf, htmlFrame, parseDelimited, tablePreview,
};

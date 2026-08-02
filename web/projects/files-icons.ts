// projects/files-icons.ts — #1405 W1: files.ts 분할 ②.
//  확장자 → 종류 판정과 아이콘·썸네일 렌더 한 벌(이미지 썸네일은 IntersectionObserver 지연로드).
//  순수 잎 — 관측자 싱글턴(_thumbObserver)을 이 모듈이 소유한다.
import { TOKEN_KEY, el, sv } from '../core.js';

function fileExt(name) { const i = String(name || '').lastIndexOf('.'); return i >= 0 ? name.slice(i + 1).toLowerCase() : ''; }

const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];

function iconFor(name) {
  const e = fileExt(name);
  if (IMG_EXTS.includes(e)) return '🖼️';
  if (['md', 'txt', 'rtf', 'csv'].includes(e)) return '📝';
  if (e === 'pdf') return '📕';
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(e)) return '🗜️';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(e)) return '🎬';
  if (['mp3', 'wav', 'flac', 'm4a'].includes(e)) return '🎵';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'json', 'html', 'css', 'java', 'go', 'rs', 'c', 'cpp', 'rb', 'php', 'yml', 'yaml', 'toml'].includes(e)) return '📄';
  return '📄';
}

// 공유 폴더 단색 라인 아이콘 — 컬러 이모지 대신(calm 예산: 색이 아니라 형태로 구분).
//  currentColor 를 상속하므로 색·획굵기는 CSS(.fic)에서 통제. 확장자→형태만 매핑(타입은 파일명 확장자가 이미 말해줌).
function fileKind(name) {
  const e = fileExt(name);
  if (IMG_EXTS.includes(e)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(e)) return 'video';
  if (['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'].includes(e)) return 'audio';
  if (['zip', 'tar', 'gz', 'tgz', 'rar', '7z'].includes(e)) return 'archive';
  if (['js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'json', 'html', 'css', 'java', 'go', 'rs', 'c', 'cpp', 'rb', 'php', 'yml', 'yaml', 'toml'].includes(e)) return 'code';
  return 'file';
}

const FILE_ICON_GLYPHS = {
  dir:     [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
  file:    [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }], ['polyline', { points: '14 3 14 8 19 8' }], ['line', { x1: 9, y1: 13, x2: 15, y2: 13 }], ['line', { x1: 9, y1: 16.5, x2: 15, y2: 16.5 }]],
  image:   [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['circle', { cx: 8.5, cy: 9.5, r: 1.5 }], ['polyline', { points: '21 16 15.5 11 5 20' }]],
  video:   [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['polygon', { points: '10 8.5 16 12 10 15.5 10 8.5' }]],
  audio:   [['path', { d: 'M9 17V5l10-2v12' }], ['circle', { cx: 6, cy: 17, r: 3 }], ['circle', { cx: 16, cy: 15, r: 3 }]],
  archive: [['rect', { x: 4, y: 4, width: 16, height: 4, rx: 1 }], ['path', { d: 'M5.5 8v10a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8' }], ['line', { x1: 10.5, y1: 12, x2: 13.5, y2: 12 }]],
  code:    [['polyline', { points: '15 7 20 12 15 17' }], ['polyline', { points: '9 7 4 12 9 17' }]],
};

// 파일/폴더 단색 라인 아이콘 — 동시 리팩터가 이 함수 정의를 지우고 호출처(공유폴더 참조목록·파일 필드·설정 참고파일)는
//  남겨 ReferenceError(fileIconSvg is not defined)가 났다. fileKind·FILE_ICON_GLYPHS(둘 다 생존)에 기반해 복구.
function fileIconSvg(name, isDir) {
  const kind = isDir ? 'dir' : fileKind(name);
  const node = sv('svg', { class: 'fic fic-' + kind, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  for (const [t, a] of (FILE_ICON_GLYPHS[kind] || FILE_ICON_GLYPHS.file)) node.append(sv(t as any, a));
  return node;
}

function fileThumb(id, it, rel, base) {
  if (it.type === 'dir') return folderThumb();
  const ext = fileExt(it.name);
  if (IMG_EXTS.includes(ext)) return imageThumb(id, rel, base, it.name);
  return docIcon(ext);
}

// 폴더 — 맥 느낌 소프트 블루(두 톤).
function folderThumb() {
  const n = sv('svg', { class: 'ft ft-folder', viewBox: '0 0 48 40', fill: 'none', 'aria-hidden': 'true' });
  n.append(sv('path', { class: 'ft-folder-tab', d: 'M4 9a3 3 0 0 1 3-3h10.5l4 4H4z' }));
  n.append(sv('path', { class: 'ft-folder-body', d: 'M4 12a3 3 0 0 1 3-3h34a3 3 0 0 1 3 3v19a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z' }));
  return n;
}

// 타입별 파일 라벨/색 — 동시 리팩터가 이 const 정의를 지우고 docIcon 의 사용처만 남겨 공유 폴더 파일 아이콘이
//  ReferenceError(FILE_TYPE_META is not defined)로 깨졌다(→ '폴더를 불러오지 못했습니다'). 사용처 바로 위에 복구.
const FILE_TYPE_META = {
  pdf: { label: 'PDF', cls: 'ft-pdf' },
  doc: { label: 'DOC', cls: 'ft-word' }, docx: { label: 'DOC', cls: 'ft-word' }, hwp: { label: 'HWP', cls: 'ft-word' }, hwpx: { label: 'HWP', cls: 'ft-word' },
  ppt: { label: 'PPT', cls: 'ft-ppt' }, pptx: { label: 'PPT', cls: 'ft-ppt' }, key: { label: 'KEY', cls: 'ft-ppt' },
  xls: { label: 'XLS', cls: 'ft-xls' }, xlsx: { label: 'XLS', cls: 'ft-xls' }, csv: { label: 'CSV', cls: 'ft-xls' },
  zip: { label: 'ZIP', cls: 'ft-zip' }, tar: { label: 'TAR', cls: 'ft-zip' }, gz: { label: 'GZ', cls: 'ft-zip' }, rar: { label: 'RAR', cls: 'ft-zip' }, '7z': { label: '7Z', cls: 'ft-zip' },
  mp3: { label: 'MP3', cls: 'ft-av' }, wav: { label: 'WAV', cls: 'ft-av' }, m4a: { label: 'M4A', cls: 'ft-av' }, flac: { label: 'FLAC', cls: 'ft-av' },
  mp4: { label: 'MP4', cls: 'ft-av' }, mov: { label: 'MOV', cls: 'ft-av' }, webm: { label: 'WEBM', cls: 'ft-av' }, mkv: { label: 'MKV', cls: 'ft-av' },
  md: { label: 'MD', cls: 'ft-txt' }, txt: { label: 'TXT', cls: 'ft-txt' }, rtf: { label: 'RTF', cls: 'ft-txt' },
};

// 타입별 색 문서 아이콘 — 흰 페이지 + 접힌 모서리 + 색 띠 + 라벨(PDF/DOC/PPT/XLS …).
function docIcon(ext) {
  const meta = FILE_TYPE_META[ext] || { label: (String(ext || '').toUpperCase().slice(0, 4) || 'FILE'), cls: 'ft-generic' };
  const n = sv('svg', { class: 'ft ft-file ' + meta.cls, viewBox: '0 0 40 48', fill: 'none', 'aria-hidden': 'true' });
  n.append(sv('path', { class: 'ft-page', d: 'M6 2.5h17.5L34 13v30.5a2.5 2.5 0 0 1-2.5 2.5h-25A2.5 2.5 0 0 1 4 43.5V5A2.5 2.5 0 0 1 6 2.5z' }));
  n.append(sv('path', { class: 'ft-fold', d: 'M23.5 2.5V11a2 2 0 0 0 2 2H34z' }));
  n.append(sv('rect', { class: 'ft-band', x: 4, y: 29, width: 30, height: 12, rx: 2.5 }));
  const t = sv('text', { class: 'ft-label', x: 19, y: 37.8, 'text-anchor': 'middle' }); t.textContent = meta.label;
  n.append(t);
  return n;
}

// 이미지 — 실제 썸네일. 파일 API 가 Bearer 인증이라 <img src> 직접 불가 → blob fetch 후 objectURL. 보일 때 지연 로드.
function imageThumb(id, rel, base, name) {
  const wrap = el('div', { class: 'ft ft-img' });
  const img = el('img', { alt: name });
  wrap.append(img);
  (wrap as any)._loadThumb = async () => {
    const token = localStorage.getItem(TOKEN_KEY);
    const url = (base || '/api/ui/projects/') + id + '/file?path=' + encodeURIComponent(rel);
    try {
      const res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
      if (!res.ok) { wrap.classList.add('ft-img-err'); return; }
      img.src = URL.createObjectURL(await res.blob());
      wrap.classList.add('loaded');
    } catch (_) { wrap.classList.add('ft-img-err'); }
  };
  thumbObserve(wrap);
  return wrap;
}

// 지연 로드 — 화면(+여유 200px)에 들어올 때 _loadThumb() 1회. IntersectionObserver 없으면 즉시.
let _thumbObserver: any = null;

function thumbObserve(wrap) {
  if (typeof IntersectionObserver === 'undefined') { if ((wrap as any)._loadThumb) (wrap as any)._loadThumb(); return; }
  if (!_thumbObserver) {
    _thumbObserver = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { _thumbObserver.unobserve(e.target); if ((e.target as any)._loadThumb) (e.target as any)._loadThumb(); }
    }, { rootMargin: '200px' });
  }
  _thumbObserver.observe(wrap);
}

export { IMG_EXTS, fileExt, fileIconSvg, fileThumb, iconFor };

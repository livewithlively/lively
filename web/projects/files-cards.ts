// projects/files-cards.ts — #1405 W1: files.ts 분할 ④.
//  파일 하나를 보는/다루는 표면 — 뷰어 모달(이미지·텍스트) + 카드/행 엘리먼트 + 이름변경·삭제.
//  의존은 단방향: cards → {files-upload, files-icons, files-format}.
import { TOKEN_KEY, api, el, renderMarkdown, toast } from '../core.js';
import { overlayBox } from '../learn.js';
import { fmtFileDate, fmtFileDateFull, fmtSize } from './files-format.js';
import { IMG_EXTS, fileExt, fileThumb } from './files-icons.js';
import { authDownload, authUpload } from './files-upload.js';

// 텍스트로 열어 편집 가능한 확장자(화이트리스트). 그 외 바이너리(docx/xlsx/zip 등)는 textarea 로 열면 깨지므로 다운로드.
const TEXT_EXTS = ['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs',
  'py', 'sh', 'bash', 'zsh', 'rb', 'go', 'rs', 'c', 'cc', 'cpp', 'h', 'hpp', 'java', 'kt', 'swift', 'php',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'xml', 'svg', 'yml', 'yaml', 'toml', 'ini', 'conf', 'env',
  'sql', 'vue', 'svelte', 'r', 'lua', 'pl', 'dart', 'gradle', 'properties', 'gitignore', 'dockerfile'];

// 파일 뷰어 — 이미지=미리보기, PDF=내장 뷰어(iframe), 텍스트=편집·저장, 그 외 바이너리=다운로드 안내.
async function openFileViewer(id, rel, name, reload, base) {
  const B = base || '/api/ui/projects/';
  const token = localStorage.getItem(TOKEN_KEY);
  const url = B + id + '/file?path=' + encodeURIComponent(rel);
  const ext = fileExt(name);
  const isImg = IMG_EXTS.includes(ext);
  const isPdf = ext === 'pdf';
  const isText = TEXT_EXTS.includes(ext);
  const footer = (back, extra?) => el('div', { class: 'ov-actions' },
    ...(extra || []),
    el('button', { class: 'btn btn-ghost', text: '다운로드', onclick: () => authDownload(url + '&download=1', name) }),
    el('button', { class: 'btn btn-ghost', text: '닫기', onclick: () => back.remove() }));

  // 미리보기 미지원 바이너리 — 다운로드만(fetch 생략).
  if (!isImg && !isPdf && !isText) {
    const back = overlayBox(name, el('p', { class: 'admin-hint', text: '미리보기를 지원하지 않는 형식이에요. 다운로드해서 확인하세요.' }));
    back.querySelector('.ov-box').append(footer(back));
    return;
  }
  let res: any;
  try { res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); }
  catch (_) { toast('파일을 열지 못했습니다', true); return; }
  if (res.status === 413) {
    const back = overlayBox(name, el('p', { class: 'admin-hint', text: '미리보기엔 너무 큰 파일이에요. 다운로드해서 확인하세요.' }));
    back.querySelector('.ov-box').append(footer(back));
    return;
  }
  if (!res.ok) { toast('파일을 열지 못했습니다 (' + res.status + ')', true); return; }
  const blob = await res.blob();

  if (isImg) {
    const back = overlayBox(name, el('img', { class: 'proj-file-img', src: URL.createObjectURL(blob), alt: name }));
    back.querySelector('.ov-box').append(footer(back));
    return;
  }
  if (isPdf) {
    // blob 에 MIME 이 없으면 iframe 이 PDF 를 텍스트로 표시(원시 %PDF 바이트 노출) — application/pdf 로 강제 후 네이티브 뷰어 렌더.
    const pdfBlob = blob.type === 'application/pdf' ? blob : new Blob([await blob.arrayBuffer()], { type: 'application/pdf' });
    const back = overlayBox(name, el('iframe', { class: 'proj-file-pdf', src: URL.createObjectURL(pdfBlob) }));
    const box = back.querySelector('.ov-box'); box.classList.add('ov-box-wide'); box.append(footer(back));
    return;
  }
  // 텍스트 — 편집/저장
  const ta = el('textarea', { class: 'proj-file-edit' }); ta.value = await blob.text();
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  // #req 마크다운 — 원문 대신 렌더(제목·목록·표·코드…)로 보기 좋게. '✎ 편집' 토글로 원문 수정·저장.
  const isMd = ext === 'md' || ext === 'markdown';
  let content: any = ta;
  let extraBtns: any[] = [saveBtn];
  if (isMd) {
    const wrap = el('div', { class: 'proj-file-mdwrap' }, el('div', { class: 'md-rendered proj-file-md' }, renderMarkdown(ta.value)));
    let editing = false;
    const toggle = el('button', { class: 'btn btn-ghost', text: '✎ 편집' });
    toggle.onclick = () => {
      editing = !editing;
      wrap.replaceChildren(editing ? ta : el('div', { class: 'md-rendered proj-file-md' }, renderMarkdown(ta.value)));
      toggle.textContent = editing ? '👁 렌더 보기' : '✎ 편집';
      saveBtn.hidden = !editing; // 저장은 편집 모드에서만 노출
    };
    saveBtn.hidden = true;
    content = wrap;
    extraBtns = [toggle, saveBtn];
  }
  const back = overlayBox(name, content);
  const box = back.querySelector('.ov-box'); if (isMd) box.classList.add('ov-box-wide');
  box.append(footer(back, extraBtns));
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try { await authUpload(url, new Blob([ta.value])); toast('저장했습니다'); back.remove(); if (reload) reload(); }
    catch (e) { toast(e.message, true); saveBtn.disabled = false; }
  };
}

// 공유 폴더 아이콘 카드(맥 데스크탑 느낌) — 폴더는 onDir(rel), 파일은 뷰어 팝업. 섹션·전체보기 팝업 공용.
function projFileCardEl(id, it, rel, onDir, reload, base, select) {
  const isDir = it.type === 'dir';
  const c = el('div', { class: 'proj-file-card' + (select ? ' select-mode' : ''), title: it.name },
    el('div', { class: 'proj-file-card-ic' }, fileThumb(id, it, rel, base)),
    el('div', { class: 'proj-file-card-nm', text: it.name }),
    el('div', { class: 'proj-file-card-sz', text: isDir ? '폴더' : fmtSize(it.size) }),
    it.mtime ? el('div', { class: 'proj-file-card-dt', text: fmtFileDate(it.mtime), title: fmtFileDateFull(it.mtime) }) : null);
  if (select) {
    // 선택 모드 — 카드 클릭 = 체크 토글(열기/진입 대신). 파일·폴더 모두 골라 일괄 삭제 가능.
    const ids = select.ids;
    const on0 = ids.has(rel);
    if (on0) c.classList.add('selected');
    const cb = el('span', { class: 'proj-file-check', 'aria-hidden': 'true', text: on0 ? '✓' : '' });
    c.append(cb);
    c.setAttribute('role', 'checkbox'); c.setAttribute('tabindex', '0'); c.setAttribute('aria-checked', on0 ? 'true' : 'false');
    const toggle = () => { const v = !ids.has(rel); if (v) ids.add(rel); else ids.delete(rel); c.classList.toggle('selected', v); cb.textContent = v ? '✓' : ''; c.setAttribute('aria-checked', v ? 'true' : 'false'); select.onToggle(); };
    c.onclick = toggle;
    c.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
  } else {
    c.onclick = isDir ? () => onDir(rel) : () => openFileViewer(id, rel, it.name, reload, base);
  }
  return c;
}

function projUpCardEl(onClick) {
  return el('div', { class: 'proj-file-card', onclick: onClick },
    el('div', { class: 'proj-file-card-ic', text: '↩' }), el('div', { class: 'proj-file-card-nm', text: '상위 폴더' }));
}

// 전체 보기 목록의 한 행 — [아이콘][이름][크기][호버 시 액션 아이콘]. 폴더는 진입, 파일은 뷰어.
function projFileRowEl(id, it, rel, onDir, reload, base) {
  const B = base || '/api/ui/projects/';
  const isDir = it.type === 'dir';
  const acts = el('div', { class: 'proj-file-lacts' },
    fileIconBtn('✎', '이름변경', (ev) => { ev.stopPropagation(); renameEntry(id, rel, it.name, isDir, reload, B); }),
    isDir ? null : fileIconBtn('↓', '다운로드', (ev) => { ev.stopPropagation(); authDownload(B + id + '/file?download=1&path=' + encodeURIComponent(rel), it.name); }),
    fileIconBtn('✕', '삭제', (ev) => { ev.stopPropagation(); deleteEntry(id, rel, it.name, isDir, reload, B); }, true));
  const row = el('div', { class: 'proj-file-lrow' },
    el('span', { class: 'proj-file-lic' }, fileThumb(id, it, rel, B)),
    el('span', { class: 'proj-file-lnm' + (isDir ? ' is-dir' : ''), text: it.name, title: it.name }),
    el('span', { class: 'proj-file-lsz', text: isDir ? '' : fmtSize(it.size) }),
    el('span', { class: 'proj-file-ldt', text: fmtFileDateFull(it.mtime) }),   // #1118 — 항상 풀 일시(오늘/어제 축약 X)
    acts);
  row.onclick = isDir ? () => onDir(rel) : () => openFileViewer(id, rel, it.name, reload, B);
  return row;
}

function fileIconBtn(glyph, title, onclick, danger?) {
  return el('button', { class: 'proj-file-iconbtn' + (danger ? ' danger' : ''), title, type: 'button', text: glyph, onclick });
}

// 파일/폴더 이름 변경(같은 폴더 안).
function renameEntry(id, rel, name, isDir, reload, base) {
  const B = base || '/api/ui/projects/';
  const nameIn = el('input', { type: 'text', value: name, maxlength: '120' });
  const saveBtn = el('button', { class: 'btn btn-primary', text: '저장' });
  const back = overlayBox('이름 변경',
    el('div', { class: 'field' }, el('label', { class: 'field-label', text: '새 이름' }), nameIn),
    el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() })));
  setTimeout(() => {
    nameIn.focus();
    // 파일은 확장자(.png 등)를 뺀 본문만 선택 — 타이핑 시 확장자가 통째로 지워지는 것 방지(Finder/VS Code 동작).
    const dot = name.lastIndexOf('.');
    if (!isDir && dot > 0) nameIn.setSelectionRange(0, dot);
    else nameIn.select();
  }, 0);
  const go = async () => {
    const nm = nameIn.value.trim();
    if (!nm || nm === name) { back.remove(); return; }
    saveBtn.disabled = true;
    try { await api(B + id + '/rename', { method: 'POST', body: JSON.stringify({ path: rel, name: nm }) }); back.remove(); toast('이름을 변경했습니다'); reload(); }
    catch (e) { toast('실패 — ' + e.message, true); saveBtn.disabled = false; }
  };
  saveBtn.onclick = go;
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

// 파일/폴더 삭제(폴더는 내용까지). 확인 후.
async function deleteEntry(id, rel, name, isDir, reload, base) {
  const B = base || '/api/ui/projects/';
  if (!confirm((isDir ? '폴더' : '파일') + ' ‘' + name + '’을(를) 삭제할까요?' + (isDir ? '\n\n폴더 안 내용도 함께 삭제됩니다(되돌릴 수 없음).' : '\n\n되돌릴 수 없습니다.'))) return;
  try { await api(B + id + '/file?path=' + encodeURIComponent(rel), { method: 'DELETE' }); toast('삭제했습니다'); reload(); }
  catch (e) { toast('실패 — ' + e.message, true); }
}

export { openFileViewer, projFileCardEl, projFileRowEl, projUpCardEl };

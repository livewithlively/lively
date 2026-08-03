// projects/files-cards.ts — #1405 W1: files.ts 분할 ④.
//  파일 하나를 보는/다루는 표면 — 뷰어 모달(이미지·텍스트) + 카드/행 엘리먼트 + 이름변경·삭제.
//  의존은 단방향: cards → {files-upload, files-icons, files-format}.
import { TOKEN_KEY, api, apiUrl, el, toast } from '../core.js';
import { overlayBox } from '../learn.js';
import { fmtFileDate, fmtFileDateFull, fmtSize } from './files-format.js';
import { fileThumb } from './files-icons.js';
import { authDownload, authUpload } from './files-upload.js';
import { copyFileLink, fileLinkUrl, joinRel, shareLinkIcon } from '../lib/sharelink.js';
import { buildFilePreview } from '../lib/file-preview.js';   // #1436 후속 — 미리보기 판정·렌더의 단일 소유

// 프로젝트 폴더의 공유 링크 좌표(#1436) — 프로젝트 폴더는 **공유 워크스페이스의 한 경로**(project/<id>/…,
//  src/project/project-fs.ts)라 홈 탐색기가 만드는 링크와 같은 주소축(root=shared + path)을 쓴다.
//  shareBase = 그 프로젝트 폴더의 루트기준 경로(= project.folder). 호출부가 그 값을 모르면(구 org 프리픽스 등)
//  undefined 로 두고, 그럼 버튼을 아예 그리지 않는다 — 죽은 링크를 뿌리는 것보다 없는 게 낫다.
function projShareRel(shareBase, rel): string | null {
  const b = String(shareBase || '').replace(/^\/+|\/+$/g, '');
  return b ? joinRel(b, rel) : null;
}

// 파일 뷰어(오버레이 모달) — 프로젝트 공유 폴더와 **태스크 첨부**(taskmodal/attachments)가 함께 쓴다.
//  ⭐ #1436 후속: 타입 판정·렌더·툴바 동작은 **공용 렌더러**(lib/file-preview.buildFilePreview)가 소유한다.
//   종전엔 이 함수가 자기 화이트리스트(TEXT_EXTS)를 갖고 있어 홈 팀공유폴더 모달과 답이 갈렸다 —
//   .csv 는 여기선 textarea 원문(저기선 표), .mp4·.mp3 는 여기선 '미지원'(저기선 재생), 코드 파일은 스타일 없음.
//   판정이 두 벌이면 반드시 갈라진다. 이 함수는 이제 '오버레이에 담는 것'과 '버튼 모양'만 정한다.
//  이 화면이 새로 얻은 것: **csv·tsv 표 · 음성·영상 재생 · 코드 스타일·json 정렬 · html 렌더** + [⛶ 전체화면].
//  오버레이인 이유: 프로젝트 상세의 공유 폴더는 페이지 안 인라인 섹션이라 '제자리 전환'할 컨테이너가 없다
//   (홈은 이미 모달 안이라 제자리 전환이 자연스럽다). 문맥이 실제로 달라서 남는 차이다.
async function openFileViewer(id, rel, name, reload, base, shareBase?) {
  const B = base || '/api/ui/projects/';
  const url = B + id + '/file?path=' + encodeURIComponent(rel);
  const shareRel = projShareRel(shareBase, rel);
  const mkBtn = (label, onClick) => el('button', { class: 'btn btn-ghost', type: 'button', text: label, onclick: onClick });
  const authFetch = (u: string) => {
    const t = localStorage.getItem(TOKEN_KEY);
    return fetch(apiUrl(u), { headers: t ? { Authorization: 'Bearer ' + t } : {} });
  };

  let out;
  try {
    out = await buildFilePreview({
      name, size: undefined,
      fetchView: () => authFetch(url),
      fetchDownload: () => authFetch(url + '&download=1'),
      // 기존 크기 규칙(14-files-upload.css .proj-file-*)을 보존하려고 화면 클래스를 함께 얹는다.
      cls: { img: 'proj-file-img', pdf: 'proj-file-pdf', html: 'proj-file-pdf', md: 'proj-file-md', code: 'proj-file-edit', msg: 'admin-hint' },
      mkBtn,
      // 편집·저장은 이 화면의 원래 장점 — 공용 렌더러의 옵션으로 남겨 홈 모달에도 같이 생겼다.
      save: async (text) => { await authUpload(url, new Blob([text])); },
      onSaved: () => { toast('저장했습니다'); if (reload) reload(); },
      onError: (m) => toast(m, true),
    });
  } catch (e: any) { toast('파일을 열지 못했습니다 — ' + ((e && e.message) || e), true); return; }

  const back = overlayBox(name, out.body);
  const box = back.querySelector('.ov-box');
  if (out.wide) box.classList.add('ov-box-wide');
  box.append(el('div', { class: 'ov-actions' },
    ...out.tools,
    // ⛶ 전체화면 — 같은 파일을 공유 링크 전체페이지(#/f)로 새 탭에 연다. 좌표를 모르면 버튼 없음(죽은 링크 금지).
    shareRel ? el('a', { class: 'btn btn-ghost', href: fileLinkUrl('shared', shareRel), target: '_blank', rel: 'noopener', text: '⛶ 전체화면' }) : null,
    shareRel ? el('button', { class: 'btn btn-ghost', type: 'button', text: '🔗 링크 복사', onclick: () => copyFileLink('shared', shareRel, 'file') }) : null,
    el('button', { class: 'btn btn-ghost', type: 'button', text: '다운로드', onclick: () => authDownload(url + '&download=1', name) }),
    el('button', { class: 'btn btn-ghost', type: 'button', text: '닫기', onclick: () => back.remove() })));
}

// 공유 폴더 아이콘 카드(맥 데스크탑 느낌) — 폴더는 onDir(rel), 파일은 뷰어 팝업. 섹션·전체보기 팝업 공용.
function projFileCardEl(id, it, rel, onDir, reload, base, select, shareBase?) {
  const isDir = it.type === 'dir';
  const c = el('div', { class: 'proj-file-card' + (select ? ' select-mode' : ''), title: it.name },
    el('div', { class: 'proj-file-card-ic' }, fileThumb(id, it, rel, base)),
    el('div', { class: 'proj-file-card-nm', text: it.name }),
    el('div', { class: 'proj-file-card-sz', text: isDir ? '폴더' : fmtSize(it.size) }),
    it.mtime ? el('div', { class: 'proj-file-card-dt', text: fmtFileDate(it.mtime), title: fmtFileDateFull(it.mtime) }) : null);
  // 🔗 링크 복사(#1436) — 카드엔 액션 열이 없어 **호버 시 모서리 버튼**으로(대시보드 카드와 같은 수).
  //  선택(일괄삭제) 모드에선 안 붙인다 — 그 모드의 카드 클릭은 체크 토글이라 다른 버튼이 끼면 오조작이 난다.
  const shareRel = select ? null : projShareRel(shareBase, rel);
  if (shareRel) {
    c.append(el('button', { class: 'proj-file-share', type: 'button', title: '링크 복사', 'aria-label': '링크 복사',
      onclick: (ev: any) => { ev.stopPropagation(); copyFileLink('shared', shareRel, isDir ? 'dir' : 'file'); } },
    shareLinkIcon(13)));
  }
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
    c.onclick = isDir ? () => onDir(rel) : () => openFileViewer(id, rel, it.name, reload, base, shareBase);
  }
  return c;
}

function projUpCardEl(onClick) {
  return el('div', { class: 'proj-file-card', onclick: onClick },
    el('div', { class: 'proj-file-card-ic', text: '↩' }), el('div', { class: 'proj-file-card-nm', text: '상위 폴더' }));
}

// 전체 보기 목록의 한 행 — [아이콘][이름][크기][호버 시 액션 아이콘]. 폴더는 진입, 파일은 뷰어.
function projFileRowEl(id, it, rel, onDir, reload, base, shareBase?) {
  const B = base || '/api/ui/projects/';
  const isDir = it.type === 'dir';
  const shareRel = projShareRel(shareBase, rel);
  const acts = el('div', { class: 'proj-file-lacts' },
    // 🔗 첫 자리 — 파괴적 액션(삭제)에서 가장 멀고, 이 화면에서 가장 자주 하는 일이다(#1436).
    shareRel ? fileIconBtn(shareLinkIcon(12), '링크 복사', (ev) => { ev.stopPropagation(); copyFileLink('shared', shareRel, isDir ? 'dir' : 'file'); }) : null,
    fileIconBtn('✎', '이름변경', (ev) => { ev.stopPropagation(); renameEntry(id, rel, it.name, isDir, reload, B); }),
    isDir ? null : fileIconBtn('↓', '다운로드', (ev) => { ev.stopPropagation(); authDownload(B + id + '/file?download=1&path=' + encodeURIComponent(rel), it.name); }),
    fileIconBtn('✕', '삭제', (ev) => { ev.stopPropagation(); deleteEntry(id, rel, it.name, isDir, reload, B); }, true));
  const row = el('div', { class: 'proj-file-lrow' },
    el('span', { class: 'proj-file-lic' }, fileThumb(id, it, rel, B)),
    el('span', { class: 'proj-file-lnm' + (isDir ? ' is-dir' : ''), text: it.name, title: it.name }),
    el('span', { class: 'proj-file-lsz', text: isDir ? '' : fmtSize(it.size) }),
    el('span', { class: 'proj-file-ldt', text: fmtFileDateFull(it.mtime) }),   // #1118 — 항상 풀 일시(오늘/어제 축약 X)
    acts);
  row.onclick = isDir ? () => onDir(rel) : () => openFileViewer(id, rel, it.name, reload, B, shareBase);
  return row;
}

// glyph 는 문자(✎·↓·✕) 또는 **노드**(SVG 아이콘 — #1436 🔗)다. text: 로 넣으면 노드가 "[object SVGSVGElement]"
//  문자열이 되므로 자식으로 넘긴다(el 이 nodeType 을 보고 그대로 붙인다).
function fileIconBtn(glyph, title, onclick, danger?) {
  return el('button', { class: 'proj-file-iconbtn' + (danger ? ' danger' : ''), title, type: 'button', onclick }, glyph);
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

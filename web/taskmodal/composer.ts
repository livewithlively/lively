// taskmodal/composer.ts — #1313 R56: web/taskmodal.ts 섹션 분할 ②(Activity 작성기).
//  단색 라인 아이콘 맵(PJV_TM_ICONS) · 이모지 피커 · 멘션 메뉴 · 공유폴더 첨부 피커 · 렌더된 #file: 링크 배선 ·
//  작성기 하단 툴바. 툴바는 프로젝트 탭(projects.ts)도 재사용하는 공개 표면이다.
import { api, busy, el, personFace, sv, toast } from '../core.js';
// 소유처 직결(#1313 R56) — 배럴(../projects.js) 경유였다면 projects↔taskmodal 순환에 가지가 하나 더 생긴다.
//  R30 이 이미 이 심볼들을 리프로 내려놨으므로 직결이 곧 진짜 소유처다.
import { pjvPopover } from '../projects/popover.js';
import { authDownload, fileIconSvg, fmtSize } from '../projects/files.js';

// ── 태스크 모달 Activity 작성기 — 아이콘/이모지/멘션/첨부 헬퍼(클릭업식). 단색 라인 아이콘(우리 톤). ──
const PJV_TM_ICONS: any = {
  plus:      { p: [['circle', { cx: 12, cy: 12, r: 9 }], ['line', { x1: 12, y1: 8.5, x2: 12, y2: 15.5 }], ['line', { x1: 8.5, y1: 12, x2: 15.5, y2: 12 }]] },
  paperclip: { p: [['path', { d: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48' }]] },
  at:        { p: [['circle', { cx: 12, cy: 12, r: 3.8 }], ['path', { d: 'M15.8 12v1.6a2.4 2.4 0 0 0 4.8 0V12a8.6 8.6 0 1 0-3.4 6.8' }]] },
  smile:     { p: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M8.5 14.5a4 4 0 0 0 7 0' }], ['line', { x1: 9, y1: 9.5, x2: 9.01, y2: 9.5 }], ['line', { x1: 15, y1: 9.5, x2: 15.01, y2: 9.5 }]] },
  check:     { p: [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 3.5 }], ['polyline', { points: '8.5 12.4 11 15 16 9' }]] },
  video:     { p: [['rect', { x: 3, y: 6, width: 13, height: 12, rx: 2 }], ['path', { d: 'M16 10l5-3v10l-5-3z' }]] },
  mic:       { p: [['rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }], ['path', { d: 'M6 11.5a6 6 0 0 0 12 0' }], ['line', { x1: 12, y1: 17.5, x2: 12, y2: 21 }]] },
  more:      { p: [['circle', { cx: 5.5, cy: 12, r: 1.5 }], ['circle', { cx: 12, cy: 12, r: 1.5 }], ['circle', { cx: 18.5, cy: 12, r: 1.5 }]], fill: true },
  like:      { p: [['path', { d: 'M7 10.6V19H4.8A1.3 1.3 0 0 1 3.5 17.7v-5.8A1.3 1.3 0 0 1 4.8 10.6z' }], ['path', { d: 'M7 10.6l3.6-6.4a1.8 1.8 0 0 1 3.4.9V9h4.6a1.8 1.8 0 0 1 1.78 2.1l-1 6A1.8 1.8 0 0 1 18.6 19H7' }]] },
  send:      { p: [['path', { d: 'M4.5 12 20 4.5 15.5 20l-4-6z' }], ['line', { x1: 11.5, y1: 14, x2: 20, y2: 4.5 }]] },
};
function pjvtmIcon(name) {
  const def = PJV_TM_ICONS[name] || PJV_TM_ICONS.plus;
  const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: def.fill ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': def.fill ? 0 : 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  for (const [t, a] of def.p) n.append(sv(t, a));
  return n;
}
const PJV_TM_EMOJIS = ['👍', '❤️', '😄', '🎉', '👀', '🙌', '🔥', '✅', '🚀', '😢', '😮', '🙏', '💯', '👏', '🤔', '💡'];
function pjvtmEmojiPicker(anchor, onPick) {
  const grid = el('div', { class: 'pjv-tm-emoji-grid' });
  const close = pjvPopover(anchor, grid);
  for (const e of PJV_TM_EMOJIS) {
    const b = el('button', { class: 'pjv-tm-emoji', type: 'button', text: e });
    b.onclick = () => { close(); onPick(e); };
    grid.append(b);
  }
}
function pjvtmMentionMenu(anchor, members, insert) {
  const menu = el('div', { class: 'pjv-menu' });
  const close = pjvPopover(anchor, menu);
  if (!members || !members.length) { menu.append(el('div', { class: 'pjv-menu-empty', text: '팀원이 없어요' })); return; }
  for (const m of members) {
    const nm = m.display_name || m.member_id;
    const item = el('button', { class: 'pjv-menu-item', type: 'button' },
      personFace(m.member_id, 'pjv-ava', nm), el('span', { text: nm }));
    item.onclick = () => { close(); insert('@' + nm + ' '); };
    menu.append(item);
  }
}
// 공유 폴더 첨부 — 파일 클릭 시 작성기에 [📎 이름](#file:상대경로) 마크다운 삽입(렌더 후 authDownload 로 다운로드).
function pjvtmAttachPicker(anchor, o) {
  const pid = o.d.project && o.d.project.id;
  if (!pid) { toast('이 태스크의 프로젝트 폴더를 찾을 수 없어요', true); return; }
  const B = '/api/ui/v6/projects/' + pid;
  const crumb = el('div', { class: 'pjv-files-crumb' });
  const rowsBox = el('div', { class: 'pjv-files-browser' });
  const close = pjvPopover(anchor, el('div', { class: 'pjv-field-editor pjv-files-editor' },
    el('div', { class: 'pjv-files-head2', text: '공유 폴더에서 첨부' }), crumb, rowsBox));
  let curPath = '';
  const load = async () => {
    busy(rowsBox, el('div', { class: 'pjv-files-empty', text: '불러오는 중…' }));
    let data: any;
    try { data = await api(B + '/files?path=' + encodeURIComponent(curPath)); }
    catch (e) { rowsBox.replaceChildren(el('div', { class: 'pjv-files-empty', text: '공유 폴더를 불러오지 못했어요' })); return; }
    crumb.replaceChildren(el('button', { class: 'pjv-files-crumb-btn', type: 'button', text: '루트', onclick: () => { curPath = ''; load(); } }));
    let acc = '';
    for (const p of (curPath ? curPath.split('/') : [])) {
      acc = acc ? acc + '/' + p : p; const tg = acc;
      crumb.append(el('span', { class: 'pjv-files-crumb-sep', text: '/' }), el('button', { class: 'pjv-files-crumb-btn', type: 'button', text: p, onclick: () => { curPath = tg; load(); } }));
    }
    rowsBox.replaceChildren();
    const items = data.items || [];
    if (!items.length) { rowsBox.append(el('div', { class: 'pjv-files-empty', text: '빈 폴더예요' })); return; }
    for (const it of items) {
      const childPath = curPath ? curPath + '/' + it.name : it.name;
      if (it.type === 'dir') rowsBox.append(el('button', { class: 'pjv-files-row dir', type: 'button', onclick: () => { curPath = childPath; load(); } },
        fileIconSvg(it.name, true), el('span', { class: 'pjv-files-name', text: it.name }), el('span', { class: 'pjv-files-chev', text: '›' })));
      else rowsBox.append(el('button', { class: 'pjv-files-row file', type: 'button', onclick: () => { o.insertAtCursor('[📎 ' + it.name + '](#file:' + encodeURIComponent(childPath) + ') '); close(); } },
        fileIconSvg(it.name, false), el('span', { class: 'pjv-files-name', text: it.name }), el('span', { class: 'pjv-files-size', text: fmtSize(it.size) })));
    }
  };
  load();
}
// 렌더된 댓글의 #file: 링크 → 클릭 시 인증 다운로드(평문 링크는 401 이므로 가로채 authDownload).
function pjvtmWireFileLinks(node, cctx) {
  if (!node || !node.querySelectorAll) return;
  node.querySelectorAll('a[href^="#file:"]').forEach((a) => {
    const rel = decodeURIComponent(a.getAttribute('href').slice(6));
    a.classList.add('pjv-tm-filelink');
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (!cctx.projectId) { toast('프로젝트 폴더를 찾을 수 없어요', true); return; }
      authDownload('/api/ui/v6/projects/' + cctx.projectId + '/file?download=1&path=' + encodeURIComponent(rel), a.textContent.replace(/^📎\s*/, ''));
    });
  });
}
// 작성기 하단 툴바 — 📎(파일첨부)·@(멘션)·😊(이모지)·✓(체크리스트) · ➤(전송).
//  아이콘은 전부 그 자리서 실제로 동작하는 것만 둔다(예전의 ＋삽입 중복 메뉴·Comment▾·화면녹화·음성입력·더보기 placeholder 제거).
//  화면녹화(영통)·음성입력(음성인식)처럼 지원 예정이 없는 건 아이콘 자체를 노출하지 않는다.
function pjvtmComposerToolbar(o) {
  const bar = el('div', { class: 'pjv-tm-toolbar' });
  const tool = (icon, title, fn) => {
    const b = el('button', { class: 'pjv-tm-tool', type: 'button', title }, pjvtmIcon(icon));
    b.onclick = (e) => fn(e);
    return b;
  };
  bar.append(tool('paperclip', '공유 폴더 파일 첨부', (e) => pjvtmAttachPicker(e.currentTarget, o)));
  bar.append(tool('at', '멘션', (e) => pjvtmMentionMenu(e.currentTarget, o.members, o.insertAtCursor)));
  bar.append(tool('smile', '이모지', (e) => pjvtmEmojiPicker(e.currentTarget, (em) => o.insertAtCursor(em))));
  bar.append(tool('check', '체크리스트 항목', () => o.insertAtCursor('\n- [ ] ')));
  bar.append(el('span', { class: 'pjv-tm-tool-spacer' }));
  bar.append(o.sendBtn);
  return bar;
}

// 액티비티 헤더용 아이콘 추가(맵 정의 비파괴 — 키만 보강).
PJV_TM_ICONS.search = { p: [['circle', { cx: 11, cy: 11, r: 7 }], ['line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }]] };
PJV_TM_ICONS.bell = { p: [['path', { d: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9' }], ['path', { d: 'M13.73 21a2 2 0 0 1-3.46 0' }]] };
PJV_TM_ICONS.filter = { p: [['line', { x1: 4, y1: 7, x2: 20, y2: 7 }], ['line', { x1: 7, y1: 12, x2: 17, y2: 12 }], ['line', { x1: 10, y1: 17, x2: 14, y2: 17 }]] };

export { PJV_TM_ICONS, pjvtmComposerToolbar, pjvtmEmojiPicker, pjvtmIcon, pjvtmWireFileLinks };

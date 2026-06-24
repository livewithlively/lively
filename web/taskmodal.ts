// taskmodal.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { TOKEN_KEY, api, el, errorNote, relTime, renderMarkdown, sv, toast } from './core.js';
import { PJV_PRIORITY, PJV_PRIORITY_ORDER, PJV_STATUS_ORDER, PJV_TASK_STATUS, authDownload, authUpload, avatarColor, debounce, fileIconSvg, fmtSize, initials, openFileViewer, pjvAssigneeControl, pjvAssignees, pjvAssigneeWrite, pjvCheckMini, pjvDueControl, pjvFmtDate, pjvIsOverdue, pjvPatchTask, pjvPopover, pjvPriorityControl, pjvSaveTask, pjvStatusMeta } from './projects.js';
import { field } from './admin.js';

const PJV_LINK_TYPE = {
  blocking:   { label: '막고 있음',  short: 'blocking' },
  waiting_on: { label: '기다리는 중', short: 'waiting on' },
  linked:     { label: '연결됨',     short: 'linked' },
};

function pjvFmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return h + '시간 ' + (m ? m + '분' : '').trim();
  if (m) return m + '분 ' + (s ? s + '초' : '').trim();
  return s + '초';
}
function pjvFmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const z = (x) => String(x).padStart(2, '0');
  return (h ? h + ':' : '') + z(m) + ':' + z(s);
}

// 모달 열기 — pageReload 는 리스트뷰 재페인트(변경 시 닫을 때 호출). 하위/연결 태스크로 점프 가능.
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
      el('span', { class: 'pjv-ava', style: 'background:' + avatarColor(m.member_id), text: initials(nm) }), el('span', { text: nm }));
    item.onclick = () => { close(); insert('@' + nm + ' '); };
    menu.append(item);
  }
}
function pjvtmTypeMenu(anchor) {
  const menu = el('div', { class: 'pjv-menu' });
  const close = pjvPopover(anchor, menu);
  const b = el('button', { class: 'pjv-menu-item sel', type: 'button' }, el('span', { text: 'Comment' }));
  b.onclick = () => close();
  menu.append(b, el('div', { class: 'pjv-menu-empty', text: '다른 유형은 준비 중' }));
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
    rowsBox.replaceChildren(el('div', { class: 'pjv-files-empty', text: '불러오는 중…' }));
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
function pjvtmInsertMenu(anchor, o) {
  const menu = el('div', { class: 'pjv-menu' });
  const close = pjvPopover(anchor, menu);
  const item = (icon, label, fn) => { const b = el('button', { class: 'pjv-menu-item', type: 'button' }, pjvtmIcon(icon), el('span', { text: label })); b.onclick = () => { close(); fn(); }; return b; };
  menu.append(item('paperclip', '공유 폴더 파일 첨부', () => pjvtmAttachPicker(anchor, o)));
  menu.append(item('at', '멘션', () => pjvtmMentionMenu(anchor, o.members, o.insertAtCursor)));
  menu.append(item('smile', '이모지', () => pjvtmEmojiPicker(anchor, (e) => o.insertAtCursor(e))));
  menu.append(item('check', '체크리스트 항목', () => o.insertAtCursor('\n- [ ] ')));
}
// 작성기 하단 툴바(클릭업식) — ＋·Comment▼ · 📎·@·😊·✓·🎥·🎤·⋯ · ➤(전송). 구현가능은 배선, 미지원은 정직 안내.
function pjvtmComposerToolbar(o) {
  const bar = el('div', { class: 'pjv-tm-toolbar' });
  const tool = (icon, title, fn, soon?) => {
    const b = el('button', { class: 'pjv-tm-tool' + (soon ? ' soon' : ''), type: 'button', title }, pjvtmIcon(icon));
    b.onclick = (e) => fn(e);
    return b;
  };
  bar.append(tool('plus', '삽입', (e) => pjvtmInsertMenu(e.currentTarget, o)));
  const typePill = el('button', { class: 'pjv-tm-ctypepill', type: 'button', title: '댓글 유형' }, el('span', { text: 'Comment' }), el('span', { class: 'pjv-tm-type-caret', text: '▾' }));
  typePill.onclick = () => pjvtmTypeMenu(typePill);
  bar.append(typePill, el('span', { class: 'pjv-tm-tool-sep' }));
  bar.append(tool('paperclip', '공유 폴더 파일 첨부', (e) => pjvtmAttachPicker(e.currentTarget, o)));
  bar.append(tool('at', '멘션', (e) => pjvtmMentionMenu(e.currentTarget, o.members, o.insertAtCursor)));
  bar.append(tool('smile', '이모지', (e) => pjvtmEmojiPicker(e.currentTarget, (em) => o.insertAtCursor(em))));
  bar.append(tool('check', '체크리스트 항목', () => o.insertAtCursor('\n- [ ] ')));
  bar.append(tool('video', '화면 녹화 (준비 중)', () => toast('화면 녹화는 준비 중이에요'), true));
  bar.append(tool('mic', '음성 입력 (준비 중)', () => toast('음성 입력은 준비 중이에요'), true));
  bar.append(tool('more', '더보기 (준비 중)', () => toast('추가 도구는 준비 중이에요'), true));
  bar.append(el('span', { class: 'pjv-tm-tool-spacer' }));
  bar.append(o.sendBtn);
  return bar;
}

// ── 태그 색 팔레트(클릭업식) + 태그 편집 아이콘(기어/휴지통/없음/뒤로). ──
const PJV_TAG_COLORS = ['#8b7fd6', '#6b8fff', '#4aa3e0', '#2bb3a3', '#56b877', '#e0b341', '#e8853a', '#e98aa8', '#d96bb0', '#b07fd6', '#a98e7d', '#cfd6e0', '#98a3b5'];
const PJV_TAG_NONE = '#aab3c2';
function pjvtmGearIcon() {
  const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 12, cy: 12, r: 3 }));
  n.append(sv('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }));
  return n;
}
function pjvtmTrashIcon() {
  const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('polyline', { points: '4 7 20 7' }), sv('path', { d: 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' }), sv('path', { d: 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12' }));
  return n;
}
function pjvtmNoneIcon() {
  const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'aria-hidden': 'true' });
  n.append(sv('circle', { cx: 12, cy: 12, r: 8 }), sv('line', { x1: 6.4, y1: 6.4, x2: 17.6, y2: 17.6 }));
  return n;
}
function pjvtmBackIcon() {
  const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  n.append(sv('polyline', { points: '14 6 8 12 14 18' }));
  return n;
}

function pjvOpenTaskModal(taskId, pageReload) {
  let dirty = false;
  let tickTimer: any = null;
  const back = el('div', { class: 'pjv-tm-back' });
  const box = el('div', { class: 'pjv-tm' });
  back.append(box);
  back.addEventListener('mousedown', (e) => { if (e.target === back) closeModal(); });
  const onKey = (e) => { if (e.key === 'Escape') { const pop = document.querySelector('.pjv-pop'); if (!pop) closeModal(); } };
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  document.body.classList.add('pjv-tm-open');

  function closeModal() {
    if (tickTimer) clearInterval(tickTimer);
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('pjv-tm-open');
    back.remove();
    if (dirty && pageReload) pageReload();
  }

  box.append(el('div', { class: 'pjv-tm-loading' }, '불러오는 중…'));
  load();

  async function load() {
    let d: any;
    try { d = await api('/api/ui/v6/tasks/' + taskId + '/detail'); }
    catch (e) { box.replaceChildren(el('div', { class: 'pjv-tm-loading' }, errorNote ? errorNote(e, '태스크를 불러오지 못했습니다') : ('실패 — ' + e.message),
      el('button', { class: 'btn btn-ghost btn-sm', text: '닫기', onclick: closeModal }))); return; }
    render(d);
  }
  // 편집 후 부분 갱신: 서버가 돌려준 조각으로 d 를 갱신하고 해당 영역만 다시 그릴 수도 있으나, 단순·정확을 위해 전체 재페치.
  function refresh() { dirty = true; load(); }

  function render(d) {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    const t = d.task;
    const members = d.members || [];
    const _prevMain = box.querySelector('.pjv-tm-main');
    const _prevScroll = _prevMain ? _prevMain.scrollTop : 0;
    box.replaceChildren(
      pjvtmMain(d, t, members, refresh, closeModal, pageReload),
      pjvtmSide(d, t, refresh),
    );
    const _newMain = box.querySelector('.pjv-tm-main');
    if (_newMain && _prevScroll) _newMain.scrollTop = _prevScroll;
    // 실행중 타이머 라이브 틱
    const running = d.time && d.time.running;
    if (running) {
      const elc = box.querySelector('.pjv-tm-timer-live');
      const base = d.time.total_seconds || 0;
      const startedMs = new Date(running.started_at).getTime();
      const upd = () => { if (elc) elc.textContent = pjvFmtClock(base + (Date.now() - startedMs) / 1000); };
      upd(); tickTimer = setInterval(upd, 1000);
    }
  }

  // ── 좌측(상세) ──
  function pjvtmMain(d, t, members, refresh, closeModal, pageReload) {
    const main = el('div', { class: 'pjv-tm-main' });

    // 상단바: 브레드크럼(프로젝트명) + 닫기
    main.append(el('div', { class: 'pjv-tm-top' },
      el('div', { class: 'pjv-tm-crumb' },
        d.project ? el('a', { class: 'pjv-tm-crumb-link', href: '#/projects2/p/' + d.project.id, text: d.project.name, onclick: () => closeModal() }) : null,
        el('span', { class: 'pjv-tm-crumb-sep', text: d.project ? ' /' : '' })),
      el('button', { class: 'pjv-tm-x', type: 'button', title: '닫기 (Esc)', text: '✕', onclick: closeModal })));

    // 타입 pill + 하위수
    const subs = t.subtasks || [];
    main.append(el('div', { class: 'pjv-tm-typebar' },
      el('span', { class: 'pjv-tm-typepill' },
        el('span', { class: 'pjv-tm-typedot' }),
        el('span', { text: t.level === 'subtask' ? 'Subtask' : 'Task' })),
      subs.length ? el('span', { class: 'pjv-tm-subcount', title: subs.length + '개 하위', text: '⌥ ' + subs.length }) : null));

    // 제목(편집 가능)
    const titleIn = el('textarea', { class: 'pjv-tm-title', rows: '1', maxlength: '200', spellcheck: 'false' });
    titleIn.value = t.name || '(제목 없음)';
    const autoGrow = () => { titleIn.style.height = 'auto'; titleIn.style.height = titleIn.scrollHeight + 'px'; };
    setTimeout(autoGrow, 0);
    titleIn.addEventListener('input', autoGrow);
    const saveTitle = () => {
      const v = titleIn.value.trim();
      if (v && v !== t.name) pjvPatchTask(t.id, { name: v }, refresh);
    };
    titleIn.addEventListener('blur', saveTitle);
    titleIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titleIn.blur(); } });
    main.append(titleIn);

    // 필드 그리드(2열): 좌(상태·기간·시간추적) 우(담당자·우선순위·태그)
    main.append(el('div', { class: 'pjv-tm-fields' },
      pjvtmFieldRow('◎', '상태', pjvtmStatusField(t, refresh)),
      pjvtmFieldRow('👤', '담당자', pjvtmAssigneeField(t, members, refresh)),
      pjvtmFieldRow('🗓', '기간', pjvtmDatesField(t, refresh)),
      pjvtmFieldRow('⚑', '우선순위', pjvtmPriorityField(t, refresh)),
      pjvtmFieldRow('⏱', '시간 추적', pjvtmTimeField(d, t, refresh)),
      pjvtmFieldRow('🏷', '태그', pjvtmTagsField(d, t, refresh))));

    // 설명(마크다운)
    main.append(pjvtmDescription(t, refresh));

    // 하위 태스크
    main.append(pjvtmSubtasks(d, t, members, refresh, pageReload));

    // 의존성 / 연결
    main.append(pjvtmLinks(d, t, refresh));

    // 체크리스트
    main.append(pjvtmChecklists(d, t, members, refresh));
    main.append(pjvtmAttachments(d, t, refresh));

    return main;
  }

  function pjvtmFieldRow(glyph, label, control) {
    return el('div', { class: 'pjv-tm-field' },
      el('span', { class: 'pjv-tm-field-ico', 'aria-hidden': 'true', text: glyph }),
      el('span', { class: 'pjv-tm-field-label', text: label }),
      el('div', { class: 'pjv-tm-field-val' }, control));
  }

  // 상태 — 색 pill(라벨). 클릭 → 메뉴.
  function pjvtmStatusField(t, refresh) {
    const meta = pjvStatusMeta(t.status);
    const btn = el('button', { class: 'pjv-tm-statuspill ' + meta.cls, type: 'button' },
      meta.glyph ? el('span', { class: 'pjv-status-glyph', text: meta.glyph }) : null,
      el('span', { text: meta.label.toUpperCase() }));
    btn.onclick = (e) => {
      e.stopPropagation();
      const menu = el('div', { class: 'pjv-menu' });
      const close = pjvPopover(btn, menu);
      for (const key of PJV_STATUS_ORDER) {
        const m = PJV_TASK_STATUS[key];
        const sel = meta.bucket === key;
        const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' },
          el('span', { class: 'pjv-status-dot sm ' + m.cls }, m.glyph ? el('span', { class: 'pjv-status-glyph', text: m.glyph }) : null),
          el('span', { text: m.label }));
        item.onclick = () => { close(); if (!sel) pjvPatchTask(t.id, { status: key }, refresh); };
        menu.append(item);
      }
    };
    return btn;
  }

  function pjvtmAssigneeField(t, members, refresh) {
    const nameOf = (id) => { const m = members.find((x) => x.member_id === id); return m ? (m.display_name || m.member_id) : id; };
    const btn = el('button', { class: 'pjv-tm-valbtn', type: 'button' });
    function render() {
      const ids = pjvAssignees(t);
      btn.className = 'pjv-tm-valbtn' + (ids.length ? '' : ' empty');
      if (ids.length) {
        const faces = el('span', { class: 'pjv-asg-faces' });
        for (const id of ids.slice(0, 4)) faces.append(el('span', { class: 'pjv-ava', style: 'background:' + avatarColor(id), title: nameOf(id), text: initials(nameOf(id)) }));
        btn.replaceChildren(faces, el('span', { class: 'pjv-tm-valtext', text: ids.length === 1 ? nameOf(ids[0]) : ids.length + '명' }));
      } else { btn.replaceChildren(el('span', { text: 'Empty' })); }
    }
    btn.onclick = (e) => {
      e.stopPropagation();
      const menu = el('div', { class: 'pjv-menu pjv-asg-menu' });
      pjvPopover(btn, menu);
      const setIds = (ids) => { t.assignee = pjvAssigneeWrite(ids); render(); pjvSaveTask(t.id, { assignee: t.assignee }); rebuild(); };
      const none = el('button', { class: 'pjv-menu-item', type: 'button' },
        el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '담당 없음' }));
      none.onclick = (ev) => { ev.stopPropagation(); setIds([]); };
      const itemsBox = el('div', {});
      menu.append(none, itemsBox);
      function rebuild() {
        const ids = pjvAssignees(t);
        none.className = 'pjv-menu-item' + (!ids.length ? ' sel' : '');
        itemsBox.replaceChildren(...members.map((m) => {
          const on = ids.includes(m.member_id);
          const item = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' },
            el('span', { class: 'pjv-ava', style: 'background:' + avatarColor(m.member_id), text: initials(m.display_name || m.member_id) }),
            el('span', { class: 'pjv-asg-mname', text: m.display_name || m.member_id }),
            el('span', { class: 'pjv-asg-check', text: on ? '✓' : '' }));
          item.onclick = (ev) => { ev.stopPropagation(); const c = pjvAssignees(t); setIds(c.includes(m.member_id) ? c.filter((x) => x !== m.member_id) : [...c, m.member_id]); };
          return item;
        }));
        if (!members.length) itemsBox.append(el('div', { class: 'pjv-menu-empty', text: '프로젝트 팀원을 먼저 추가하세요' }));
      }
      rebuild();
    };
    render();
    return btn;
  }

  // 기간 — start → due, 각각 날짜 picker.
  function pjvtmDatesField(t, refresh) {
    const wrap = el('div', { class: 'pjv-tm-dates' });
    const mk = (field, ph) => {
      const val = t[field];
      const overdue = field === 'due_date' && pjvIsOverdue(t);
      const b = el('button', { class: 'pjv-tm-datebtn' + (val ? '' : ' empty') + (overdue ? ' overdue' : ''), type: 'button' },
        el('span', { text: val ? pjvFmtDate(val) : ph }));
      b.onclick = (e) => {
        e.stopPropagation();
        const input = el('input', { type: 'date', class: 'pjv-date-input', value: val || '' });
        const wrapPop = el('div', { class: 'pjv-menu pjv-date-pop' }, input,
          val ? el('button', { class: 'pjv-menu-item danger', type: 'button', text: '지우기',
            onclick: () => { close(); pjvPatchTask(t.id, { [field]: null }, refresh); } }) : null);
        const close = pjvPopover(b, wrapPop);
        setTimeout(() => { input.focus(); if (input.showPicker) { try { input.showPicker(); } catch (_) {} } }, 0);
        input.onchange = () => { const v = input.value || null; close(); pjvPatchTask(t.id, { [field]: v }, refresh); };
      };
      return b;
    };
    wrap.append(mk('start_date', 'Start'), el('span', { class: 'pjv-tm-datearrow', text: '→' }), mk('due_date', 'Due'));
    return wrap;
  }

  function pjvtmPriorityField(t, refresh) {
    const m = t.priority ? PJV_PRIORITY[t.priority] : null;
    const btn = el('button', { class: 'pjv-tm-valbtn' + (m ? '' : ' empty'), type: 'button' });
    btn.append(m
      ? el('span', { class: 'pjv-flag ' + m.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' }), el('span', { class: 'pjv-flag-label', text: m.label }))
      : el('span', { text: 'Empty' }));
    btn.onclick = (e) => {
      e.stopPropagation();
      const menu = el('div', { class: 'pjv-menu' });
      const close = pjvPopover(btn, menu);
      for (const key of PJV_PRIORITY_ORDER) {
        const pm = PJV_PRIORITY[key];
        const sel = t.priority === key;
        const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' },
          el('span', { class: 'pjv-flag ' + pm.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' })),
          el('span', { text: pm.label }));
        item.onclick = () => { close(); if (!sel) pjvPatchTask(t.id, { priority: key }, refresh); };
        menu.append(item);
      }
      const none = el('button', { class: 'pjv-menu-item' + (!t.priority ? ' sel' : ''), type: 'button' },
        el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
      none.onclick = () => { close(); if (t.priority) pjvPatchTask(t.id, { priority: null }, refresh); };
      menu.append(none);
    };
    return btn;
  }

  // 시간추적 — 총합 + 타이머 토글 + 수동입력 + 엔트리 목록(팝오버).
  function pjvtmTimeField(d, t, refresh) {
    const time = d.time || { entries: [], total_seconds: 0, running: null };
    const wrap = el('div', { class: 'pjv-tm-time' });
    const running = time.running;
    const playBtn = el('button', { class: 'pjv-tm-timebtn' + (running ? ' on' : ''), type: 'button',
      title: running ? '타이머 정지' : '타이머 시작' },
      el('span', { text: running ? '⏸' : '▶' }),
      el('span', { text: running ? '정지' : 'Start' }));
    playBtn.onclick = async () => {
      playBtn.disabled = true;
      try { await api('/api/ui/v6/tasks/' + t.id + '/time', { method: 'POST', body: JSON.stringify({ action: running ? 'stop' : 'start' }) }); refresh(); }
      catch (e) { toast('실패 — ' + e.message, true); playBtn.disabled = false; }
    };
    wrap.append(playBtn);
    if (time.total_seconds > 0 || running) {
      wrap.append(el('span', { class: 'pjv-tm-timer-live', text: pjvFmtClock(time.total_seconds || 0) }));
    }
    // 더보기(수동 입력 + 엔트리 목록)
    const more = el('button', { class: 'pjv-tm-timemore', type: 'button', title: '시간 기록', text: '⋯' });
    more.onclick = (e) => { e.stopPropagation(); pjvtmTimePop(more, d, t, refresh); };
    wrap.append(more);
    return wrap;
  }
  function pjvtmTimePop(anchor, d, t, refresh) {
    const time = d.time || { entries: [] };
    const pop = el('div', { class: 'pjv-menu pjv-tm-timepop' });
    const close = pjvPopover(anchor, pop);
    // 수동 입력
    const hh = el('input', { type: 'number', min: '0', class: 'pjv-tm-tnum', placeholder: '0' });
    const mm = el('input', { type: 'number', min: '0', max: '59', class: 'pjv-tm-tnum', placeholder: '0' });
    const addBtn = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '추가' });
    addBtn.onclick = async () => {
      const secs = (Number(hh.value) || 0) * 3600 + (Number(mm.value) || 0) * 60;
      if (secs <= 0) { toast('시간을 입력하세요', true); return; }
      addBtn.disabled = true;
      try { await api('/api/ui/v6/tasks/' + t.id + '/time', { method: 'POST', body: JSON.stringify({ action: 'add', seconds: secs }) }); close(); refresh(); }
      catch (e) { toast('실패 — ' + e.message, true); addBtn.disabled = false; }
    };
    pop.append(el('div', { class: 'pjv-tm-tmanual' },
      el('span', { class: 'pjv-tm-tlabel', text: '수동 입력' }),
      hh, el('span', { text: '시간' }), mm, el('span', { text: '분' }), addBtn));
    // 엔트리 목록
    if (time.entries && time.entries.length) {
      const list = el('div', { class: 'pjv-tm-tentries' });
      for (const en of time.entries) {
        if (en.ended_at == null) continue; // 실행중은 위 라이브 표시
        const row = el('div', { class: 'pjv-tm-tentry' },
          el('span', { text: pjvFmtDuration(en.duration_seconds || 0) }),
          el('span', { class: 'pjv-tm-tentry-src', text: en.source === 'manual' ? '수동' : '타이머' }),
          el('button', { class: 'pjv-tm-tentry-x', type: 'button', title: '삭제', text: '✕',
            onclick: async () => {
              try { await api('/api/ui/v6/tasks/' + t.id + '/time', { method: 'POST', body: JSON.stringify({ action: 'delete', entry_id: en.id }) }); close(); refresh(); }
              catch (e) { toast('실패 — ' + e.message, true); } } }));
        list.append(row);
      }
      pop.append(list);
    }
  }

  // 태그 — 칩 + 추가(자동완성). 색상은 등록시 랜덤/지정(여기선 팔레트 순환).
  // 태그 필드 — 칩(색·× 제거) + Empty/＋. 변경은 로컬 갱신 + 백그라운드 저장(모달 풀 refresh 없이 부드럽게).
  function pjvtmTagsField(d, t, refresh) {
    const wrap = el('div', { class: 'pjv-tm-tags' });
    const render = () => {
      wrap.replaceChildren();
      for (const tag of (d.tags || [])) wrap.append(pjvtmTagChip(tag, () => removeTag(tag.id)));
      const addBtn = el('button', { class: 'pjv-tm-tagadd' + ((d.tags || []).length ? '' : ' empty'), type: 'button', text: (d.tags || []).length ? '＋' : 'Empty' });
      addBtn.onclick = (e) => { e.stopPropagation(); pjvtmTagPop(addBtn, d, t, render); };
      wrap.append(addBtn);
    };
    const removeTag = async (tagId) => {
      d.tags = (d.tags || []).filter((x) => x.id !== tagId); render();
      try { await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tagId, remove: true }) }); }
      catch (e) { toast('실패 — ' + e.message, true); }
    };
    render();
    return wrap;
  }
  function pjvtmTagChip(tag, onRemove) {
    const chip = el('span', { class: 'pjv-tm-tag', style: '--tag:' + (tag.color || PJV_TAG_NONE) }, el('span', { class: 'pjv-tm-tag-name', text: tag.name }));
    if (onRemove) {
      const x = el('button', { class: 'pjv-tm-tag-x', type: 'button', title: '제거', text: '✕' });
      x.onclick = (e) => { e.stopPropagation(); onRemove(); };
      chip.append(x);
    }
    return chip;
  }
  // 태그 피커(클릭업식) — 선택칩 + 검색/생성 입력 + 기존 태그 토글 + Create 행. 각 태그 기어 → 색/이름/삭제 뷰.
  async function pjvtmTagPop(anchor, d, t, renderField) {
    const pop = el('div', { class: 'pjv-menu pjv-tm-tagpop' });
    pjvPopover(anchor, pop);
    let all: any[] = [];
    const loadAll = async () => { try { all = await api('/api/ui/v6/tags').then((r) => (r && r.tags) || []); } catch (_) { all = []; } };
    const selIds = () => new Set((d.tags || []).map((x) => x.id));
    await loadAll();

    function showList(query) {
      const input = el('input', { type: 'text', class: 'pjv-tm-taginput', placeholder: '검색 또는 새 태그 이름…', maxlength: '40', value: query || '' });
      const chips = el('div', { class: 'pjv-tm-tagpop-chips' });
      const list = el('div', { class: 'pjv-tm-tagresults' });
      const manageBtn = el('button', { class: 'pjv-tm-tagmanage-btn', type: 'button' }, pjvtmGearIcon(), el('span', { text: '모든 태그 관리' }));
      manageBtn.onclick = () => showManageAll();
      pop.replaceChildren(
        el('div', { class: 'pjv-tm-tagpop-top' }, chips, input),
        el('div', { class: 'pjv-tm-tagpop-head' }, el('span', { text: 'Select an option' })),
        list, manageBtn);
      setTimeout(() => { input.focus(); }, 0);
      const renderChips = () => chips.replaceChildren(...(d.tags || []).map((tag) => pjvtmTagChip(tag, () => persistRemove(tag.id))));
      const persistAdd = async (x) => {
        if (!selIds().has(x.id)) { d.tags = [...(d.tags || []), x]; renderField(); renderChips(); renderList(); }
        try { await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: x.id }) }); }
        catch (e) { toast('실패 — ' + e.message, true); }
      };
      const persistRemove = async (tagId) => {
        d.tags = (d.tags || []).filter((x) => x.id !== tagId); renderField(); renderChips(); renderList();
        try { await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tagId, remove: true }) }); }
        catch (e) { toast('실패 — ' + e.message, true); }
      };
      const createAndAdd = async (name, color) => {
        try {
          const tags = await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ name, color }) }).then((r) => (r && r.tags) || []);
          d.tags = tags; await loadAll(); renderField(); showList('');
        } catch (e) { toast('실패 — ' + e.message, true); }
      };
      const renderList = () => {
        const qq = input.value.trim();
        const have = selIds();
        const cand = all.filter((x) => (!qq || x.name.toLowerCase().includes(qq.toLowerCase())));
        list.replaceChildren();
        for (const x of cand.slice(0, 40)) {
          const on = have.has(x.id);
          const row = el('button', { class: 'pjv-tm-tagrow' + (on ? ' sel' : ''), type: 'button' },
            pjvCheckMini(on),
            el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (x.color || PJV_TAG_NONE) }),
            el('span', { class: 'pjv-tm-tagrow-name', text: x.name }));
          row.onclick = () => (on ? persistRemove(x.id) : persistAdd(x));
          const gear = el('button', { class: 'pjv-tm-tagrow-gear', type: 'button', title: '태그 편집' }, pjvtmGearIcon());
          gear.onclick = (e) => { e.stopPropagation(); showColor(x, input.value); };
          row.append(gear);
          list.append(row);
        }
        if (qq && !all.some((x) => x.name.toLowerCase() === qq.toLowerCase())) {
          const previewColor = PJV_TAG_COLORS[all.length % PJV_TAG_COLORS.length];
          const cr = el('button', { class: 'pjv-tm-tagrow pjv-tm-tagcreate', type: 'button' },
            el('span', { class: 'pjv-tm-tagcreate-label', text: 'Create' }),
            el('span', { class: 'pjv-tm-tag', style: '--tag:' + previewColor }, el('span', { class: 'pjv-tm-tag-name', text: qq })),
            el('span', { class: 'pjv-tm-tagcreate-enter', text: '↵' }));
          cr.onclick = () => createAndAdd(qq, previewColor);
          list.append(cr);
        }
        if (!list.children.length) list.append(el('div', { class: 'pjv-menu-empty', text: '이름을 입력해 새 태그를 만들어보세요.' }));
      };
      input.addEventListener('input', renderList);
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const v = input.value.trim(); if (!v) return;
        const exact = all.find((x) => x.name.toLowerCase() === v.toLowerCase());
        if (exact) { if (!selIds().has(exact.id)) persistAdd(exact); input.value = ''; renderList(); }
        else createAndAdd(v, PJV_TAG_COLORS[all.length % PJV_TAG_COLORS.length]);
      });
      renderChips(); renderList();
    }

    function showColor(tag, backQuery, onBack?) {
      const goBack = onBack || (() => showList(backQuery));
      const back = el('button', { class: 'pjv-tm-tagcolor-back', type: 'button', title: '뒤로' }, pjvtmBackIcon());
      back.onclick = goBack;
      const nameIn = el('input', { type: 'text', class: 'pjv-tm-tagcolor-name', value: tag.name, maxlength: '40' });
      const grid = el('div', { class: 'pjv-tm-tagcolor-grid' });
      const syncLocal = () => {
        all = all.map((a) => (a.id === tag.id ? { ...a, name: tag.name, color: tag.color } : a));
        d.tags = (d.tags || []).map((x) => (x.id === tag.id ? { ...x, name: tag.name, color: tag.color } : x));
      };
      const renderGrid = () => {
        grid.replaceChildren();
        for (const c of PJV_TAG_COLORS) {
          const sw = el('button', { class: 'pjv-tm-swatch' + (tag.color === c ? ' sel' : ''), type: 'button', style: 'background:' + c + ';color:' + c, 'aria-label': '색상' });
          sw.onclick = () => applyColor(c);
          grid.append(sw);
        }
        const none = el('button', { class: 'pjv-tm-swatch none' + (!tag.color ? ' sel' : ''), type: 'button', title: '색 없음' }, pjvtmNoneIcon());
        none.onclick = () => applyColor(null);
        grid.append(none);
      };
      const applyColor = async (c) => {
        tag.color = c; renderGrid(); syncLocal(); renderField();
        try { await api('/api/ui/v6/tags/' + tag.id, { method: 'POST', body: JSON.stringify({ color: c }) }); }
        catch (e) { toast('실패 — ' + e.message, true); }
      };
      const rename = async () => {
        const v = nameIn.value.trim(); if (!v || v === tag.name) return;
        try { const r = await api('/api/ui/v6/tags/' + tag.id, { method: 'POST', body: JSON.stringify({ name: v }) }).then((x) => x.tag); tag.name = r.name; syncLocal(); renderField(); }
        catch (e) { toast('이름 변경 실패 — ' + e.message, true); nameIn.value = tag.name; }
      };
      const del = el('button', { class: 'pjv-tm-tagdelete', type: 'button' }, pjvtmTrashIcon(), el('span', { text: 'Delete' }));
      del.onclick = async () => {
        if (!confirm("'" + tag.name + "' 태그를 삭제할까요?\n모든 태스크에서 제거됩니다.")) return;
        try { await api('/api/ui/v6/tags/' + tag.id + '/delete', { method: 'POST', body: JSON.stringify({}) }); d.tags = (d.tags || []).filter((x) => x.id !== tag.id); await loadAll(); renderField(); goBack(); }
        catch (e) { toast('삭제 실패 — ' + e.message, true); }
      };
      nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); rename(); } });
      nameIn.addEventListener('blur', rename);
      pop.replaceChildren(
        el('div', { class: 'pjv-tm-tagcolor-top' }, back, nameIn),
        grid,
        el('div', { class: 'pjv-tm-tagcolor-sep' }),
        del);
      renderGrid();
      setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
    }

    // 모든 태그 관리(클릭업 Tag Manager 동형) — 워크스페이스 전체 태그를 한 곳에서 보고 이름·색상·삭제(모든 태스크 반영).
    function showManageAll() {
      const back = el('button', { class: 'pjv-tm-tagcolor-back', type: 'button', title: '뒤로' }, pjvtmBackIcon());
      back.onclick = () => showList('');
      const list = el('div', { class: 'pjv-tm-tagresults' });
      pop.replaceChildren(
        el('div', { class: 'pjv-tm-tagcolor-top' }, back, el('div', { class: 'pjv-tm-tagmanage-title', text: '모든 태그 관리' })),
        el('div', { class: 'pjv-tm-tagpop-head' }, el('span', { text: all.length + '개 · 클릭해 이름·색상·삭제 (모든 태스크 반영)' })),
        list);
      if (!all.length) { list.append(el('div', { class: 'pjv-menu-empty', text: '아직 태그가 없습니다.' })); return; }
      for (const x of all) {
        const row = el('button', { class: 'pjv-tm-tagrow', type: 'button' },
          el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (x.color || PJV_TAG_NONE) }),
          el('span', { class: 'pjv-tm-tagrow-name', text: x.name }),
          el('span', { class: 'pjv-tm-tagrow-gear' }, pjvtmGearIcon()));
        row.onclick = () => showColor(x, '', showManageAll);
        list.append(row);
      }
    }

    showList('');
  }

  // 설명 — 렌더(MD) ↔ 편집 토글.
  function pjvtmDescription(t, refresh) {
    const sec = el('div', { class: 'pjv-tm-desc' });
    const hasDesc = !!(t.description && t.description.trim());
    let editing = false;
    const paint = () => {
      sec.replaceChildren();
      if (editing) {
        const ta = el('textarea', { class: 'pjv-tm-desc-ta', rows: '6', placeholder: '설명을 입력하세요 (마크다운 지원)' });
        ta.value = t.description || '';
        const save = el('button', { class: 'btn btn-sm btn-primary', text: '저장' });
        const cancel = el('button', { class: 'btn btn-sm btn-ghost', text: '취소' });
        save.onclick = () => { editing = false; const v = ta.value; if (v !== (t.description || '')) pjvPatchTask(t.id, { description: v || null }, refresh); else paint(); };
        cancel.onclick = () => { editing = false; paint(); };
        sec.append(ta, el('div', { class: 'pjv-tm-desc-acts' }, save, cancel));
        setTimeout(() => ta.focus(), 0);
      } else if (hasDesc) {
        const body = el('div', { class: 'pjv-tm-desc-body md-rendered' }, renderMarkdown(t.description));
        body.onclick = () => { editing = true; paint(); };
        sec.append(body);
      } else {
        const add = el('button', { class: 'pjv-tm-desc-add', type: 'button', text: '＋ 설명 추가' });
        add.onclick = () => { editing = true; paint(); };
        sec.append(add);
      }
    };
    paint();
    return sec;
  }

  // 하위 태스크 — 헤더(N open) + 행(상태점·이름클릭→그 하위 모달·담당·우선) + 인라인 추가.
  function pjvtmSubtasks(d, t, members, refresh, pageReload) {
    const subs = (t.subtasks || []);
    const openCount = subs.filter((s) => s.status !== 'done').length;
    const sec = el('div', { class: 'pjv-tm-block' });
    if (t.level === 'subtask') return el('div'); // 하위태스크는 더 하위 없음(백엔드 제약)
    sec.append(el('div', { class: 'pjv-tm-block-head' },
      el('span', { class: 'pjv-tm-block-title', text: '하위 태스크' }),
      el('span', { class: 'pjv-tm-block-count', text: openCount + ' open' })));
    const tableHead = el('div', { class: 'pjv-tm-sub-head' },
      el('span', { text: '이름' }), el('span', { text: '담당자' }), el('span', { text: '마감일' }), el('span', { text: '우선순위' }));
    sec.append(tableHead);
    for (const s of subs) {
      const smeta = pjvStatusMeta(s.status);
      const nameBtn = el('button', { class: 'pjv-tm-sub-name', type: 'button' },
        el('span', { class: 'pjv-status-dot sm ' + smeta.cls }, smeta.glyph ? el('span', { class: 'pjv-status-glyph', text: smeta.glyph }) : null),
        el('span', { class: (s.status === 'done' ? 'done' : ''), text: s.name }));
      nameBtn.onclick = () => { dirty = true; pjvOpenTaskModal(s.id, pageReload); closeModal(); };
      sec.append(el('div', { class: 'pjv-tm-sub-row' },
        nameBtn,
        el('div', { class: 'pjv-tm-sub-cell' }, pjvAssigneeControl(s, members, (p) => pjvSaveTask(s.id, p))),
        el('div', { class: 'pjv-tm-sub-cell' }, pjvDueControl(s, (p) => pjvPatchTask(s.id, p, refresh))),
        el('div', { class: 'pjv-tm-sub-cell' }, pjvPriorityControl(s, (p) => pjvPatchTask(s.id, p, refresh)))));
    }
    // 인라인 추가
    const addInput = el('input', { type: 'text', class: 'pjv-tm-sub-add', placeholder: '＋ 하위 태스크 추가 후 Enter', maxlength: '200' });
    let subBusy = false;
    const subCommit = async () => {
      const name = addInput.value.trim();
      if (!name || subBusy) return;
      subBusy = true; addInput.disabled = true;
      try { await api('/api/ui/v6/projects/' + d.project.id + '/tasks', { method: 'POST', body: JSON.stringify({ name, parent_task_id: t.id }) }); refresh(); }
      catch (err) { toast('실패 — ' + err.message, true); addInput.disabled = false; subBusy = false; }
    };
    addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); subCommit(); } });
    addInput.addEventListener('blur', () => { subCommit(); });
    sec.append(addInput);
    return sec;
  }

  // 의존성/연결 — 목록 + 추가(같은 프로젝트 내 검색).
  function pjvtmLinks(d, t, refresh) {
    const links = d.links || [];
    const sec = el('div', { class: 'pjv-tm-block' });
    sec.append(el('div', { class: 'pjv-tm-block-head' },
      el('span', { class: 'pjv-tm-block-title', text: '의존성 / 연결' })));
    if (links.length) {
      const byType = {};
      for (const l of links) (byType[l.type] = byType[l.type] || []).push(l);
      for (const type of ['blocking', 'waiting_on', 'linked']) {
        if (!byType[type]) continue;
        const lt = PJV_LINK_TYPE[type];
        for (const l of byType[type]) {
          const lmeta = pjvStatusMeta(l.status);
          sec.append(el('div', { class: 'pjv-tm-link-row' },
            el('span', { class: 'pjv-tm-link-type ' + type, text: lt.label }),
            el('span', { class: 'pjv-status-dot sm ' + lmeta.cls }, lmeta.glyph ? el('span', { class: 'pjv-status-glyph', text: lmeta.glyph }) : null),
            el('button', { class: 'pjv-tm-link-name', type: 'button', text: l.name, onclick: () => { dirty = true; pjvOpenTaskModal(l.id, pageReload); closeModal(); } }),
            el('button', { class: 'pjv-tm-link-x', type: 'button', title: '연결 해제', text: '✕',
              onclick: async () => {
                try { await api('/api/ui/v6/tasks/' + t.id + '/links', { method: 'POST', body: JSON.stringify({ to_task: l.id, type, remove: true }) }); refresh(); }
                catch (e) { toast('실패 — ' + e.message, true); } } })));
        }
      }
    }
    const addBtn = el('button', { class: 'pjv-tm-block-add', type: 'button', text: '↻ 항목 연결 또는 의존성 추가' });
    addBtn.onclick = (e) => { e.stopPropagation(); pjvtmLinkPop(addBtn, d, t, refresh); };
    sec.append(addBtn);
    return sec;
  }
  function pjvtmLinkPop(anchor, d, t, refresh) {
    const pop = el('div', { class: 'pjv-menu pjv-tm-linkpop' });
    const typeSel = el('select', { class: 'pjv-tm-linktype-sel' },
      el('option', { value: 'blocking', text: '막고 있음 (blocking)' }),
      el('option', { value: 'waiting_on', text: '기다리는 중 (waiting on)' }),
      el('option', { value: 'linked', text: '연결됨 (linked)' }));
    const input = el('input', { type: 'text', class: 'pjv-tm-taginput', placeholder: '연결할 태스크 검색', maxlength: '100' });
    const results = el('div', { class: 'pjv-tm-tagresults' });
    pop.append(typeSel, input, results);
    const close = pjvPopover(anchor, pop);
    setTimeout(() => input.focus(), 0);
    const have = new Set((d.links || []).map((x) => x.id));
    const run = (typeof debounce === 'function' ? debounce : (f) => f)(async () => {
      const q = input.value.trim();
      let targets: any[] = [];
      try { targets = await api('/api/ui/v6/projects/' + d.project.id + '/link-targets?exclude=' + t.id + '&q=' + encodeURIComponent(q)).then((r) => (r && r.targets) || []); } catch (_) {}
      const cand = targets.filter((x) => !have.has(x.id));
      results.replaceChildren(...cand.slice(0, 10).map((x) => {
        const m = pjvStatusMeta(x.status);
        return el('button', { class: 'pjv-menu-item', type: 'button',
          onclick: async () => {
            try { await api('/api/ui/v6/tasks/' + t.id + '/links', { method: 'POST', body: JSON.stringify({ to_task: x.id, type: typeSel.value }) }); close(); refresh(); }
            catch (e) { toast('실패 — ' + e.message, true); } } },
          el('span', { class: 'pjv-status-dot sm ' + m.cls }, m.glyph ? el('span', { class: 'pjv-status-glyph', text: m.glyph }) : null),
          el('span', { text: x.name }));
      }));
      if (!cand.length) results.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '결과 없음' }));
    }, 250);
    input.addEventListener('input', run);
    run();
  }

  // 체크리스트 — 목록(진행률) + 항목(체크·이름·삭제) + 항목추가 + 새 체크리스트.
  function pjvtmChecklists(d, t, members, refresh) {
    const lists = d.checklists || [];
    const sec = el('div', { class: 'pjv-tm-block' });
    sec.append(el('div', { class: 'pjv-tm-block-head' },
      el('span', { class: 'pjv-tm-block-title', text: '체크리스트' })));
    for (const cl of lists) {
      const done = cl.items.filter((i) => i.done).length;
      const clBox = el('div', { class: 'pjv-tm-cl' });
      // 제목 — 클릭하면 인라인 입력으로 바뀌어 수정(rename). Enter/blur 저장, Esc 취소.
      const nameEl = el('span', { class: 'pjv-tm-cl-name', text: cl.name, title: '클릭해 제목 수정', role: 'button', tabindex: '0' });
      const editName = () => {
        const inp = el('input', { type: 'text', class: 'pjv-tm-cl-nameedit', value: cl.name, maxlength: '120' });
        nameEl.replaceWith(inp); inp.focus(); inp.select();
        let fin = false;
        const finish = async (save) => {
          if (fin) return; fin = true;
          const nv = inp.value.trim();
          if (save && nv && nv !== cl.name) {
            try { await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'rename', checklist_id: cl.id, name: nv }) }); cl.name = nv; nameEl.textContent = nv; }
            catch (e) { toast('제목 수정 실패 — ' + e.message, true); }
          }
          inp.replaceWith(nameEl);
        };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { finish(false); } });
        inp.addEventListener('blur', () => finish(true));
      };
      nameEl.onclick = editName;
      nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') editName(); });
      clBox.append(el('div', { class: 'pjv-tm-cl-head' },
        nameEl,
        el('span', { class: 'pjv-tm-cl-prog', text: done + '/' + cl.items.length }),
        el('button', { class: 'pjv-tm-cl-x', type: 'button', title: '체크리스트 삭제', text: '✕',
          onclick: async () => { if (!confirm('이 체크리스트를 삭제하겠습니까?\n하위 항목도 모두 사라집니다.')) return; try { await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'delete', checklist_id: cl.id }) }); refresh(); } catch (e) { toast('실패 — ' + e.message, true); } } })));
      for (const it of cl.items) {
        const cb = el('button', { class: 'pjv-tm-cl-check' + (it.done ? ' on' : ''), type: 'button', text: it.done ? '✓' : '',
          onclick: async () => { try { await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'update_item', item_id: it.id, done: !it.done }) }); refresh(); } catch (e) { toast('실패 — ' + e.message, true); } } });
        clBox.append(el('div', { class: 'pjv-tm-cl-item' }, cb,
          el('span', { class: 'pjv-tm-cl-itemname' + (it.done ? ' done' : ''), text: it.name }),
          el('button', { class: 'pjv-tm-cl-x', type: 'button', title: '항목 삭제', text: '✕',
            onclick: async () => { try { await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'delete_item', item_id: it.id }) }); refresh(); } catch (e) { toast('실패 — ' + e.message, true); } } })));
      }
      const itemIn = el('input', { type: 'text', class: 'pjv-tm-cl-add', placeholder: '＋ 항목 추가 후 Enter', maxlength: '200' });
      // Enter 로 연속 추가 — 전체 새로고침 대신 항목을 낙관적으로 붙이고 입력 포커스를 유지(커서가 안 사라짐).
      itemIn.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        const name = itemIn.value.trim(); if (!name) return;
        itemIn.value = ''; itemIn.focus();
        try {
          const res = await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'add_item', checklist_id: cl.id, name }) });
          const updated = ((res && res.checklists) || []).find((c) => c.id === cl.id);
          const it = updated && updated.items[updated.items.length - 1];
          if (!it) { refresh(); return; }
          const cb = el('button', { class: 'pjv-tm-cl-check', type: 'button', text: '',
            onclick: async () => { try { await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'update_item', item_id: it.id, done: true }) }); refresh(); } catch (e2) { toast('실패 — ' + e2.message, true); } } });
          clBox.insertBefore(el('div', { class: 'pjv-tm-cl-item' }, cb,
            el('span', { class: 'pjv-tm-cl-itemname', text: it.name }),
            el('button', { class: 'pjv-tm-cl-x', type: 'button', title: '항목 삭제', text: '✕',
              onclick: async () => { try { await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'delete_item', item_id: it.id }) }); refresh(); } catch (e2) { toast('실패 — ' + e2.message, true); } } })), itemIn);
          const prog = clBox.querySelector('.pjv-tm-cl-prog');
          if (prog) prog.textContent = updated.items.filter((i) => i.done).length + '/' + updated.items.length;
        } catch (err) { toast('실패 — ' + err.message, true); }
      });
      clBox.append(itemIn);
      sec.append(clBox);
    }
    const addBtn = el('button', { class: 'pjv-tm-block-add', type: 'button', text: '✓ 체크리스트 만들기' });
    addBtn.onclick = async () => {
      const name = prompt('체크리스트 이름', '체크리스트'); if (name == null) return;
      try { await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'create', name: name || '체크리스트' }) }); refresh(); }
      catch (e) { toast('실패 — ' + e.message, true); }
    };
    sec.append(addBtn);
    return sec;
  }

  // 첨부 파일 — 프로젝트 폴더 `_attachments/task-<id>/` 재사용(기존 파일 API: 멤버게이트·50MB·미리보기·다운로드).
  //  의존성/연결·체크리스트와 같은 레벨의 블록. 업로드=authUpload(PUT), 목록=/files, 미리보기=openFileViewer, 삭제=DELETE.
  function pjvtmAttachments(d, t, refresh) {
    const sec = el('div', { class: 'pjv-tm-block' });
    sec.append(el('div', { class: 'pjv-tm-block-head' },
      el('span', { class: 'pjv-tm-block-title', text: '첨부 파일' })));
    const pid = d.project && d.project.id;
    const dir = '_attachments/task-' + t.id;
    const base = '/api/ui/v6/projects/';
    const listBox = el('div', { class: 'pjv-tm-att-list' });
    sec.append(listBox);
    (async () => {
      if (pid == null) return;
      let files: any[] = [];
      try {
        const r = await api(base + pid + '/files?path=' + encodeURIComponent(dir));
        files = ((r && r.items) || []).filter((it) => it.type === 'file');
      } catch (_) { /* 디렉터리 없음(404) = 첨부 없음 */ }
      for (const f of files) {
        const rel = dir + '/' + f.name;
        listBox.append(el('div', { class: 'pjv-tm-att' },
          el('span', { class: 'pjv-tm-att-ico', 'aria-hidden': 'true', text: '📎' }),
          el('button', { class: 'pjv-tm-att-name', type: 'button', text: f.name,
            onclick: () => openFileViewer(pid, rel, f.name, refresh, base) }),
          el('span', { class: 'pjv-tm-att-size', text: fmtSize(f.size) }),
          el('button', { class: 'pjv-tm-att-act', type: 'button', title: '다운로드', text: '↓',
            onclick: () => authDownload(base + pid + '/file?download=1&path=' + encodeURIComponent(rel), f.name) }),
          el('button', { class: 'pjv-tm-att-act danger', type: 'button', title: '삭제', text: '✕',
            onclick: async () => {
              if (!confirm('첨부 ‘' + f.name + '’을(를) 삭제할까요?')) return;
              try { await api(base + pid + '/file?path=' + encodeURIComponent(rel), { method: 'DELETE' }); refresh(); }
              catch (e) { toast('삭제 실패 — ' + e.message, true); } } })));
      }
    })();
    const fileInput = el('input', { type: 'file', multiple: 'true', style: 'display:none' });
    const addBtn = el('button', { class: 'pjv-tm-block-add', type: 'button', text: '📎 파일 첨부' });
    fileInput.addEventListener('change', async () => {
      const picked: any[] = Array.from(fileInput.files || []);
      if (!picked.length || pid == null) return;
      addBtn.disabled = true; addBtn.textContent = '업로드 중…';
      try {
        for (const file of picked) {
          await authUpload(base + pid + '/file?path=' + encodeURIComponent(dir + '/' + file.name), file);
        }
        refresh();
      } catch (e) { toast('업로드 실패 — ' + e.message, true); addBtn.disabled = false; addBtn.textContent = '📎 파일 첨부'; }
    });
    // 공유 프로젝트 폴더에서 첨부 — 폴더 브라우저 팝오버에서 파일을 고르면 그 파일을 이 태스크 첨부폴더로 복사한다.
    const attachFromFolder = () => {
      if (pid == null) { toast('프로젝트 폴더를 찾을 수 없어요', true); return; }
      const crumb = el('div', { class: 'pjv-files-crumb' });
      const rowsBox = el('div', { class: 'pjv-files-browser' });
      const close = pjvPopover(addBtn, el('div', { class: 'pjv-field-editor pjv-files-editor' },
        el('div', { class: 'pjv-files-head2', text: '공유 프로젝트 폴더에서 첨부' }), crumb, rowsBox));
      let curPath = '';
      const load = async () => {
        rowsBox.replaceChildren(el('div', { class: 'pjv-files-empty', text: '불러오는 중…' }));
        let data: any;
        try { data = await api(base + pid + '/files?path=' + encodeURIComponent(curPath)); }
        catch (e) { rowsBox.replaceChildren(el('div', { class: 'pjv-files-empty', text: '폴더를 불러오지 못했어요' })); return; }
        crumb.replaceChildren(el('button', { class: 'pjv-files-crumb-btn', type: 'button', text: '루트', onclick: () => { curPath = ''; load(); } }));
        let acc = '';
        for (const p of (curPath ? curPath.split('/') : [])) { acc = acc ? acc + '/' + p : p; const tg = acc; crumb.append(el('span', { class: 'pjv-files-crumb-sep', text: '/' }), el('button', { class: 'pjv-files-crumb-btn', type: 'button', text: p, onclick: () => { curPath = tg; load(); } })); }
        rowsBox.replaceChildren();
        const items = data.items || [];
        if (!items.length) { rowsBox.append(el('div', { class: 'pjv-files-empty', text: '빈 폴더예요' })); return; }
        for (const it of items) {
          const childPath = curPath ? curPath + '/' + it.name : it.name;
          if (it.type === 'dir') { rowsBox.append(el('button', { class: 'pjv-files-row dir', type: 'button', onclick: () => { curPath = childPath; load(); } }, fileIconSvg(it.name, true), el('span', { class: 'pjv-files-name', text: it.name }), el('span', { class: 'pjv-files-chev', text: '›' }))); continue; }
          rowsBox.append(el('button', { class: 'pjv-files-row file', type: 'button', onclick: async () => {
            close(); addBtn.disabled = true; addBtn.textContent = '첨부 중…';
            try {
              const tok = localStorage.getItem(TOKEN_KEY);
              const blob = await fetch(base + pid + '/file?download=1&path=' + encodeURIComponent(childPath), { headers: tok ? { Authorization: 'Bearer ' + tok } : {} }).then((r) => { if (!r.ok) throw new Error('원본 읽기 실패 (' + r.status + ')'); return r.blob(); });
              await authUpload(base + pid + '/file?path=' + encodeURIComponent(dir + '/' + it.name), new File([blob], it.name));
              refresh();
            } catch (e2) { toast('첨부 실패 — ' + e2.message, true); addBtn.disabled = false; addBtn.textContent = '📎 파일 첨부'; }
          } }, fileIconSvg(it.name, false), el('span', { class: 'pjv-files-name', text: it.name }), el('span', { class: 'pjv-files-size', text: fmtSize(it.size) })));
        }
      };
      load();
    };
    // 📎 파일 첨부 → 출처 선택(내 컴퓨터 / 공유 프로젝트 폴더).
    addBtn.onclick = (e) => {
      e.stopPropagation();
      const menu = el('div', { class: 'pjv-menu' });
      const close = pjvPopover(addBtn, menu);
      const mk = (label, onPick) => { const b = el('button', { class: 'pjv-menu-item', type: 'button' }, el('span', { text: label })); b.onclick = () => { close(); onPick(); }; return b; };
      menu.append(mk('내 컴퓨터에서 업로드', () => fileInput.click()));
      menu.append(mk('공유 프로젝트 폴더에서 선택', attachFromFolder));
    };
    sec.append(fileInput, addBtn);
    return sec;
  }

  // ── 우측(Activity) — 클릭업식: 댓글 카드(반응·Reply) + 시스템 이벤트(불릿·우측 시간) + 작성기(툴바). ──
  function pjvtmSide(d, t, refresh) {
    const side = el('div', { class: 'pjv-tm-side' });
    let _filterMode = 'all';
    const _searchIn = el('input', { type: 'text', class: 'pjv-tm-search-in', placeholder: '활동 검색…' });
    const _searchWrap = el('div', { class: 'pjv-tm-search', hidden: true }, _searchIn);
    const _applyActFilter = () => {
      const fe = side.querySelector('.pjv-tm-feed'); if (!fe) return;
      const qq = (_searchIn.value || '').trim().toLowerCase();
      for (const ch of fe.children) {
        if (ch.classList.contains('pjv-tm-feed-empty')) continue;
        const isEv = ch.classList.contains('pjv-tm-ev');
        let show = _filterMode === 'all' || (_filterMode === 'comments' && !isEv) || (_filterMode === 'events' && isEv);
        if (show && qq) show = ch.textContent.toLowerCase().includes(qq);
        ch.hidden = !show;
      }
    };
    _searchIn.addEventListener('input', _applyActFilter);
    const _searchBtn = el('button', { class: 'pjv-tm-side-icon', type: 'button', title: '활동 검색' }, pjvtmIcon('search'));
    _searchBtn.onclick = () => { _searchWrap.hidden = !_searchWrap.hidden; _searchBtn.classList.toggle('on', !_searchWrap.hidden); if (!_searchWrap.hidden) _searchIn.focus(); else { _searchIn.value = ''; _applyActFilter(); } };
    let _subscribed = false;
    const _bellBtn = el('button', { class: 'pjv-tm-side-icon', type: 'button', title: '이 태스크 활동 구독' }, pjvtmIcon('bell'));
    _bellBtn.onclick = () => { _subscribed = !_subscribed; _bellBtn.classList.toggle('on', _subscribed); toast(_subscribed ? '이 태스크 활동을 구독합니다' : '구독을 해제했습니다'); };
    const _filterBtn = el('button', { class: 'pjv-tm-side-icon', type: 'button', title: '필터' }, pjvtmIcon('filter'));
    _filterBtn.onclick = (e) => {
      e.stopPropagation();
      const menu = el('div', { class: 'pjv-menu' });
      const close = pjvPopover(_filterBtn, menu);
      for (const opt of [['all', '전체'], ['comments', '댓글만'], ['events', '활동만']]) {
        menu.append(el('button', { class: 'pjv-menu-item' + (_filterMode === opt[0] ? ' sel' : ''), type: 'button', text: opt[1],
          onclick: () => { _filterMode = opt[0]; close(); _applyActFilter(); } }));
      }
    };
    side.append(el('div', { class: 'pjv-tm-side-head' },
      el('span', { text: 'Activity' }),
      el('div', { class: 'pjv-tm-side-tools' }, _searchBtn, _bellBtn, _filterBtn)), _searchWrap);
    const feedBox = el('div', { class: 'pjv-tm-feed' });
    const feed = d.feed || [];
    const ta = el('textarea', { class: 'pjv-tm-composer', rows: '1', placeholder: '댓글을 입력하세요…' });
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; };
    ta.addEventListener('input', grow);
    const insertAtCursor = (text) => {
      const s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
      const e = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
      const pos = s + text.length; ta.focus(); try { ta.setSelectionRange(pos, pos); } catch (_) { /* noop */ } grow();
    };
    const cctx = { taskId: t.id, projectId: d.project && d.project.id, members: d.members || [], replyTo: (name) => insertAtCursor('@' + name + ' ') };
    if (!feed.length) feedBox.append(el('div', { class: 'pjv-tm-feed-empty', text: '아직 활동이 없습니다. 첫 댓글을 남겨보세요.' }));
    for (const f of feed) feedBox.append(f.kind === 'comment' ? pjvtmComment(f, cctx) : pjvtmEvent(f));
    side.append(feedBox);
    setTimeout(() => { feedBox.scrollTop = feedBox.scrollHeight; }, 0);

    const sendBtn = el('button', { class: 'pjv-tm-send', type: 'button', title: '보내기 (Enter)' }, pjvtmIcon('send'));
    const send = async () => {
      const text = ta.value.trim(); if (!text) return;
      sendBtn.disabled = true; ta.disabled = true;
      try { await api('/api/ui/v6/tasks/' + t.id + '/comments', { method: 'POST', body: JSON.stringify({ text }) }); ta.value = ''; refresh(); }
      catch (e) { toast('실패 — ' + e.message, true); sendBtn.disabled = false; ta.disabled = false; }
    };
    sendBtn.onclick = send;
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    const toolbar = pjvtmComposerToolbar({ insertAtCursor, members: d.members || [], d, sendBtn });
    side.append(el('div', { class: 'pjv-tm-composer-box' }, ta, toolbar));
    return side;
  }
  function pjvtmComment(f, cctx) {
    const name = f.display_name || f.actor || '알 수 없음';
    let reactions = (f.reactions || []).map((r) => ({ emoji: r.emoji, count: r.count, mine: r.mine }));
    const footer = el('div', { class: 'pjv-tm-c-foot' });
    const toggle = (emoji) => {
      const i = reactions.findIndex((r) => r.emoji === emoji);
      if (i >= 0) {
        if (reactions[i].mine) { reactions[i].count -= 1; reactions[i].mine = false; if (reactions[i].count <= 0) reactions.splice(i, 1); }
        else { reactions[i].count += 1; reactions[i].mine = true; }
      } else reactions.push({ emoji, count: 1, mine: true });
      drawFoot();
      api('/api/ui/v6/comments/' + f.id + '/reactions', { method: 'POST', body: JSON.stringify({ emoji }) })
        .then((res) => { if (res && res.reactions) { reactions = res.reactions; drawFoot(); } })
        .catch((e) => toast('반응 실패 — ' + e.message, true));
    };
    const drawFoot = () => {
      footer.replaceChildren();
      const left = el('div', { class: 'pjv-tm-c-react' });
      for (const r of reactions) left.append(el('button', { class: 'pjv-tm-react-chip' + (r.mine ? ' mine' : ''), type: 'button', title: '반응 토글', onclick: () => toggle(r.emoji) }, el('span', { text: r.emoji }), el('span', { class: 'pjv-tm-react-n', text: String(r.count) })));
      left.append(el('button', { class: 'pjv-tm-c-act', type: 'button', title: '좋아요', onclick: () => toggle('👍') }, pjvtmIcon('like')));
      const emo = el('button', { class: 'pjv-tm-c-act', type: 'button', title: '이모지 반응' }, pjvtmIcon('smile'));
      emo.onclick = () => pjvtmEmojiPicker(emo, (e) => toggle(e));
      left.append(emo);
      footer.append(left, el('button', { class: 'pjv-tm-c-reply', type: 'button', text: 'Reply', onclick: () => cctx.replyTo(name) }));
    };
    drawFoot();
    const textDiv = el('div', { class: 'pjv-tm-c-text md-rendered' }, renderMarkdown(f.body || ''));
    pjvtmWireFileLinks(textDiv, cctx);
    return el('div', { class: 'pjv-tm-c' },
      el('span', { class: 'pjv-ava', style: 'background:' + avatarColor(f.actor || name), text: initials(name) }),
      el('div', { class: 'pjv-tm-c-body' },
        el('div', { class: 'pjv-tm-c-meta' },
          el('span', { class: 'pjv-tm-c-who', text: name }),
          el('span', { class: 'pjv-tm-c-time', text: ' · ' + (typeof relTime === 'function' ? relTime(f.ts) : f.ts) })),
        textDiv, footer));
  }
  function pjvtmEvent(f) {
    const name = f.display_name || f.actor || '시스템';
    let txt: any;
    if (f.field === 'created') txt = '태스크를 생성';
    else if (f.field === 'description') txt = '설명을 수정';
    else {
      const tv = pjvtmEventVal(f.field, f.to);
      if (f.to == null) txt = f.label + ' 해제';
      else txt = f.label + ' → ' + tv;
    }
    return el('div', { class: 'pjv-tm-ev' },
      el('div', { class: 'pjv-tm-ev-main' },
        el('span', { class: 'pjv-tm-ev-dot', text: '•' }),
        el('span', { class: 'pjv-tm-ev-who', text: name }),
        el('span', { class: 'pjv-tm-ev-txt', text: ' ' + txt })),
      el('span', { class: 'pjv-tm-ev-time', text: (typeof relTime === 'function' ? relTime(f.ts) : f.ts) }));
  }
  function pjvtmEventVal(field, v) {
    if (v == null || v === '') return '';
    if (field === 'status') return (pjvStatusMeta(v).label) || v;
    if (field === 'priority') return (PJV_PRIORITY[v] && PJV_PRIORITY[v].label) || v;
    if (field === 'assignee') return v;
    return String(v);
  }
}

// 액티비티 헤더용 아이콘 추가(맵 정의 비파괴 — 키만 보강).
PJV_TM_ICONS.search = { p: [['circle', { cx: 11, cy: 11, r: 7 }], ['line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }]] };
PJV_TM_ICONS.bell = { p: [['path', { d: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9' }], ['path', { d: 'M13.73 21a2 2 0 0 1-3.46 0' }]] };
PJV_TM_ICONS.filter = { p: [['line', { x1: 4, y1: 7, x2: 20, y2: 7 }], ['line', { x1: 7, y1: 12, x2: 17, y2: 12 }], ['line', { x1: 10, y1: 17, x2: 14, y2: 17 }]] };

export {
  PJV_TAG_NONE,
  pjvOpenTaskModal,
};

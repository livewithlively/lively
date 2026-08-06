// projects/detail-body.ts — #1313 R35: web/projects.ts 분해 ⑥.
//  프로젝트 상세의 **본문·지식·코멘트** 한 벌 —
//   · 본문 파일 업로드(uploadBodyFile) · 블록 에디터 마운트(mountBodyEditor)
//   · 본문 섹션(projectBodySection·접힘·첨부) + 본문↔코멘트 한 행(projectBodyCommentRow)
//   · 지식 흐름 섹션(projectKnowledgeSection, #245)
//   · 위지위그 직렬화(mdFromDom) · 마크다운 툴바(buildWysiwygToolbar)
//   · 코멘트 섹션(projectCommentsSection) + 코멘트 드로어(openProjectComments)
//  ⚠ mountBodyEditor 의 **1.2s 디바운스 자동저장 타이머**(saveTimer·doSave·flush)는 이 모듈과 동거한다 —
//   타이머를 쥔 클로저가 소유 모듈 밖으로 새면 flush 시점(닫힘·언마운트)이 갈라져 미저장분이 사라진다.
//  ⚠ pjvtmComposerToolbar 는 소유 모듈(taskmodal/composer.ts)을 **실체 직결**한다(#1404). R33 이 금지한 건
//   배럴 '../taskmodal.js' 직결(그건 projects↔taskmodal 에 가지를 늘린다)이고, composer.ts 는 projects 배럴을
//   되짚지 않는 리프라 간선을 깔아도 순환이 0 이다.
//   이 한 줄이 detail-body→projects 역방향 엣지의 전부였으므로, 이 모듈은 이제 배럴을 되짚지 않는다.
import { api, el, personFace, relTime, renderMarkdown, state, sv, toast } from '../core.js';
import { createBlockEditor } from '../block-editor.js';
import { pjvtmComposerToolbar } from '../taskmodal/composer.js';
import { authUpload } from './files.js';
import { pjvPopover } from './popover.js';

// ── 본문 섹션 — 태스크 위, 다른 섹션(공유 폴더·터미널 세션·작업 타임라인)과 동일 위계·디자인(.card + .card-head). ──
//  마크다운 렌더 + 본문 클릭/✎ 편집 버튼으로 그 자리 편집(Enter 저장·Shift+Enter 줄바꿈·Esc 취소). 길면 접힘+Expand.
// #730 본문 파일 업로드 — 프로젝트 폴더 하위(dir)에 저장하고 인라인 서빙 URL(/api/ui/…/file?path=)을 돌려준다.
//  core.ts 의 이미지 로더(#551)가 /api/ui/ 경로 이미지를 인증 fetch→blob 으로 렌더하므로 ![](url) 로 바로 표시·왕복.
async function uploadBodyFile(projId, dir, file) {
  try {
    const orig = (file && file.name) || 'file';
    const dot = orig.lastIndexOf('.');
    const ext = dot > 0 ? orig.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : (String(file.type || '').split('/')[1] || '').replace(/[^a-z0-9]/g, '');
    const stem = (dot > 0 ? orig.slice(0, dot) : orig).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, '_').slice(0, 60) || 'file';
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
    const stamp = '' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
    const fname = stem + '-' + stamp + (ext ? '.' + ext : '');
    const relPath = dir + '/' + fname;
    const url = '/api/ui/v6/projects/' + projId + '/file?path=' + encodeURIComponent(relPath);
    await authUpload(url, new File([file], fname, { type: file.type }));
    return url;
  } catch (e: any) { toast('업로드 실패 — ' + (e && e.message || e), true); return null; }
}

// #730 본문 블록 에디터 마운트 — 프로젝트/태스크/하위태스크 공용. 노션형 블록 에디터(항시 편집·자동저장).
//  config.save(md):Promise — 서버 저장. config.uploadFile(file):Promise<url|null> — 이미지/첨부 업로드.
//  반환 { el, flush, isDirty, destroy } — 호출부가 닫힐 때 flush()(미저장분 저장) + destroy() 권장.
function mountBodyEditor(config: { initial?: string; placeholder?: string; save: (md: string) => Promise<void>; uploadFile?: (f: File) => Promise<string | null> }) {
  let saveTimer: any = null, saving = false, lastSaved = config.initial || '';
  const chip = el('span', { class: 'pjv-bodyed-chip' });
  const setChip = (t, warn?) => { chip.textContent = t || ''; chip.classList.toggle('warn', !!warn); };
  const doSave = async () => {
    if (saving) return;
    const md = editor.getMarkdown();
    if (md === lastSaved) { editor.resetDirty(); setChip(''); return; }
    saving = true; setChip('저장 중…');
    try { await config.save(md); lastSaved = md; editor.resetDirty(); setChip('저장됨'); setTimeout(() => { if (chip.textContent === '저장됨') setChip(''); }, 1600); }
    catch (e: any) { setChip('저장 실패', true); toast('본문 저장 실패 — ' + (e && e.message || e), true); }
    saving = false;
    if (editor.isDirty()) queueSave();
  };
  const queueSave = () => { setChip('수정됨…', true); clearTimeout(saveTimer); saveTimer = setTimeout(doSave, 1200); };
  const flush = () => { clearTimeout(saveTimer); return editor.isDirty() ? doSave() : Promise.resolve(); };
  const editor = createBlockEditor({
    initial: config.initial || '',
    placeholder: config.placeholder,
    onChange: queueSave,
    onSaveShortcut: () => { clearTimeout(saveTimer); doSave(); },
    uploadFile: config.uploadFile,
  });
  const box = el('div', { class: 'pjv-bodyed' }, editor.el, el('div', { class: 'pjv-bodyed-bar' }, chip));
  // 본문 속 지식 링크(#/k/…)는 새 탭(#804). 프로젝트·태스크 본문은 모달로도 뜨는데(pjvOpenProjectModal·pjvOpenTaskModal),
  //  모달은 body 에 얹히고 라우터엔 모달 정리가 없어 같은 탭 이동은 모달 뒤에서 라우트만 바꾼다 → 죽은 클릭.
  //  편집 중인 본문(항시 편집·자동저장)을 두고 페이지가 떠나지도 않는다. 링크는 매 재렌더마다 새로 생기므로 위임(capture)으로 잡는다.
  //  ⚠ WIKI 문서 에디터는 createBlockEditor 를 직접 쓰므로 여기 안 걸린다 — 위키 내부 문서 이동은 같은 탭 유지.
  box.addEventListener('click', (e: any) => {
    const a = e.target && e.target.closest && e.target.closest('a.md-link[href^="#/k/"]');
    if (!a || !box.contains(a)) return;
    e.preventDefault(); e.stopPropagation();
    window.open(a.getAttribute('href'), '_blank', 'noopener');
  }, true);
  // 에디터 밖으로 포커스가 완전히 나가면 자동저장 flush(슬래시/툴바 팝업 클릭은 box 밖이지만 저장은 멱등이라 무해).
  box.addEventListener('focusout', () => setTimeout(() => { if (!box.contains(document.activeElement)) flush(); }, 200));
  return { el: box, flush, isDirty: () => editor.isDirty(), destroy: () => editor.destroy() };
}

// ── 본문 안에 얹은 코멘트(#1233) — 본문 박스는 지금 크기 그대로 두고, 그 **안쪽** 우측 2/7 에 코멘트를 띄운다.
//  본문 글줄은 그만큼 자리를 비켜 흐르므로(한 줄이 짧아져 읽기도 낫다) 코멘트가 세로를 따로 먹지 않는다.
//  본문을 펼치거나(더 보기) 편집을 시작하면 본문이 박스 전폭을 되찾고 코멘트는 그 아래로 내려간다 —
//  '자세히 볼 때·쓸 때만 본문이 넓으면 된다'는 게 이 배치의 전부다. ──
function projectBodyCommentRow(id, p, reload, members) {
  let card: any = null;
  const wide = (on) => { if (card) card.classList.toggle('is-wide', !!on); };
  card = projectBodySection(id, p, reload, wide);
  const cmt = projectCommentsSection(id, members);
  cmt.classList.add('proj-body-cmt');
  cmt.style.marginBottom = '';   // 섹션으로 서 있을 때의 인라인 마진 해제 — 배치는 아래 CSS 가 맡는다
  card.classList.add('has-inset-cmt');
  card.append(cmt);
  return card;
}

function projectBodySection(id, p, reload, onWide?) {
  const card = el('div', { class: 'card proj-body-card', style: 'margin-bottom:18px' });
  const bodyWrap = el('div', { class: 'proj-body-sec' });
  card.append(el('div', { class: 'card-head' }, el('h3', { text: '본문' })));
  // #730 노션형 블록 에디터로 통일 — 슬래시(/) 명령·블록 드래그·선택 툴바·이미지 붙여넣기/드롭. 항시 편집(자동저장).
  const bodyEd = mountBodyEditor({
    initial: p.description || '',
    placeholder: '본문을 입력하세요.  ‘/’ 로 블록 삽입 · 이미지 붙여넣기/드롭 · 드래그로 정렬',
    uploadFile: (file) => uploadBodyFile(id, '_attachments/project-' + id, file),
    save: async (md) => { await api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify({ description: md || null }) }); p.description = md; },
  });
  bodyWrap.append(bodyEd.el);
  projectBodyAttachments(bodyWrap, p);   // 이관 첨부 그리드(있으면)
  projectBodyCollapse(card, bodyWrap, onWide);   // 길면 접고 [더 보기] — 짧으면 아무것도 달라지지 않는다
  return card;
}

// ── 본문이 길면 접어 둔다(#1233-2) — 상세는 아래로 섹션이 계속 이어지는데(지식·코멘트·태스크·터미널…),
//  본문 하나가 화면을 다 먹으면 나머지가 한눈에 안 들어온다. 지식 섹션과 같은 클립+페이드+[더 보기] 알약.
//  ⚠ 본문은 '항시 편집' 블록 에디터다 → 접힌 채로 편집하면 커서가 클립된 영역으로 내려가 안 보이는 채 타이핑된다.
//   그래서 안에 포커스가 들어오면(편집 시작) 자동으로 펼치고, 편집 중에는 접기 컨트롤을 숨긴다.
//  짧으면 컨트롤을 감추고 펼쳐 두므로, 대부분의 짧은 본문에서는 아무것도 달라지지 않는다. ──
function projectBodyCollapse(card, bodyWrap, onWide?) {
  const wide = (on) => { if (onWide) onWide(on); };   // 본문이 전폭을 가져야 하는 순간을 바깥(본문+코멘트 행)에 알린다
  const box = el('div', { class: 'proj-body-collapse collapsed' }, bodyWrap);
  const lbl = el('span', { class: 'lbl', text: '더 보기' });
  const caret = el('span', { class: 'caret', text: '⌄' });
  const btn = el('button', { class: 'proj-detail-body-expand', type: 'button' }, lbl, caret);
  const row = el('div', { class: 'proj-detail-body-expand-row proj-body-expand-row' }, btn);
  //  [더 보기]로 **명시적으로** 펼친 상태. 편집·드래그로 포커스가 오갈 때 이 값을 건드리면 안 된다 —
  //  블록을 끌면 편집 영역에서 포커스가 빠지는데, 그때 리셋하면 펼쳐 둔 본문이 제멋대로 도로 접힌다.
  let userExpanded = false;
  const apply = (expanded) => {
    box.classList.toggle('collapsed', !expanded);
    caret.textContent = expanded ? '⌃' : '⌄';
    lbl.textContent = expanded ? '접기' : '더 보기';
  };
  //  [더 보기]로 펼친 것만 '전폭'이다 — 짧아서 캡이 필요 없는 본문은 접힌 것과 같은 취급(옆에 코멘트를 둔다).
  btn.onclick = () => { userExpanded = box.classList.contains('collapsed'); apply(userExpanded); wide(userExpanded); };
  // 캡 높이로 강제해 넘치는지 측정 → 짧으면 컨트롤 숨기고 펼침, 길면 컨트롤 노출(사용자 펼침 상태 유지).
  const remeasure = () => {
    if (box.contains(document.activeElement)) return;   // 편집 중 — 아래 focusin 이 펼쳐 둔 상태를 건드리지 않는다
    box.classList.add('collapsed');
    const tall = bodyWrap.scrollHeight > box.clientHeight + 2;
    if (!tall) { box.classList.remove('collapsed'); row.style.display = 'none'; return; }
    row.style.display = '';
    apply(userExpanded);
  };
  // 편집 시작 = 무조건 펼침(커서 유실 방지) + 전폭(쓸 땐 넓은 게 낫다). 편집을 마치고 나가면 다시 판정한다.
  box.addEventListener('focusin', () => { apply(true); row.style.display = 'none'; wide(true); });
  box.addEventListener('focusout', () => setTimeout(() => {
    if (box.contains(document.activeElement)) return;
    remeasure();            // 사용자가 펼쳐 뒀으면(userExpanded) remeasure 가 그 상태를 그대로 유지한다
    wide(userExpanded);
  }, 220));
  // 이미지·비동기 렌더로 높이가 늦게 확정된다 → 처음 한 번 + 크기 변할 때마다 재측정.
  requestAnimationFrame(remeasure);
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => remeasure()).observe(bodyWrap);
  card.append(box, row);
}

// #541 이관 첨부(task_attachment — ClickUp attachments[]/인라인 이미지) 그리드(읽기전용) — 본문 에디터 아래.
//  원본 URL 은 서명 URL 이라 만료 가능 → 이미지 로드 실패 시 파일 칩으로 폴백(레이아웃 보존).
function projectBodyAttachments(bodyWrap, p) {
    const atts = Array.isArray(p.attachments) ? p.attachments : [];
    if (atts.length) {
      const grid = el('div', { class: 'proj-att-grid' });
      for (const a of atts) {
        const url = a && a.url && /^https?:\/\//i.test(String(a.url)) ? String(a.url) : null;
        const isImg = /^image\//.test(String(a.mimetype || '')) || /(png|jpe?g|gif|webp|svg)$/i.test(String(a.extension || ''));
        const chip = el(url ? 'a' : 'span', { class: 'proj-att-chip', ...(url ? { href: url, target: '_blank', rel: 'noopener noreferrer' } : {}) });
        if (isImg && url) {
          const img = el('img', { class: 'proj-att-thumb', src: String(a.thumbnail || url), alt: a.title || '첨부 이미지', loading: 'lazy', referrerpolicy: 'no-referrer' });
          img.onerror = () => { img.replaceWith(el('span', { class: 'proj-att-fallback', text: '🖼' })); };
          chip.append(img);
        } else {
          chip.append(el('span', { class: 'proj-att-fallback', text: '📎' }));
        }
        chip.append(el('span', { class: 'proj-att-cap', text: a.title || String(a.url || '첨부').split('/').pop() }));
        grid.append(chip);
      }
      bodyWrap.append(el('div', { class: 'proj-att-sec' },
        el('div', { class: 'proj-att-head', text: '첨부 (' + atts.length + ')' }), grid));
    }
}

// ── '연결된 지식' 섹션 — 본문 바로 아래. 「필요 지식 → 이 프로젝트 → 산출 지식」 구조를 한 화면에(#245·#317). ──
//  '막막함' 제거(#317): ① 필요 빈칸은 죽은 끝 대신 추천을 인라인으로 먼저 보여줌(openKnowledgePicker = 추천-우선 단일 픽커)
//  ② '왜 다나' 배너(→ #/learn) ③ 액션은 섹션 헤더 우상단 단일 버튼 [＋ 지식 연결](관계는 픽커 라디오, 직접 작성도 픽커 안) ④ 산출 빈칸은 '아직 비어도 정상' 안내.
//  변경 후 v6 상세 GET 으로 재조회해 재페인트.
// (후속/선행 프로젝트 박스 projectEdgesSection 제거 — 상단 프로퍼티 pjvProjMetaPanel 의 선행/후속 필드로 이관, #359.)

// (직접 작성은 모달이 아니라 새 작성 페이지(#/knowledge/new?project=&relation=)로 이관 — renderKnowledgeCreate 가 프로젝트 연결을 기본 채움.)

// ── 코멘트 섹션 — 본문↔태스크 사이, 같은 급(.card). 얇은 가로 스트립으로 최신 코멘트(아바타+이름+요약)를 카드로 쭉.
//  세로 공간 최소(헤더 + 한 줄 카드). 섹션 어디든 클릭 → 오른쪽 드로어(openProjectComments)로 전체 보기·작성. ──
function projectCommentsSection(id, members) {
  const nameOf = (uid) => { const m = (members || []).find((x) => x.member_id === uid); return (m && m.display_name) || uid || '?'; };
  const card = el('div', { class: 'card pjv-cmt-sec', style: 'margin-bottom:18px', role: 'button', tabindex: '0', title: '코멘트 열기' });
  const countEl = el('span', { class: 'pjv-cmt-sec-count' });
  const unreadBadge = el('span', { class: 'pjv-cmt-unread', hidden: true });
  const strip = el('div', { class: 'pjv-cmt-strip' }, el('div', { class: 'pjv-cmt-loading', text: '불러오는 중…' }));
  card.append(
    el('div', { class: 'card-head pjv-cmt-sec-head' },
      el('h3', {}, el('span', { text: '코멘트' }), countEl, unreadBadge),
      el('span', { class: 'pjv-cmt-sec-hint', text: '클릭해 작성 · 모두 보기 →' })),
    strip);
  // 안 읽은 코멘트 강조 — 기기별 마지막 읽음 id(localStorage)보다 새 코멘트(내가 쓴 것 제외)를 안읽음으로. 클릭(드로어 열기)=읽음 처리.
  const cmtMeId = (state.me && (state.me.userId || state.me.email)) || '';
  const cmtReadKey = 'pjv_cmt_read_' + id;
  const cmtLastRead = () => Number(localStorage.getItem(cmtReadKey)) || 0;
  const cmtMarkRead = (list) => { const mx = Math.max(0, ...list.map((c) => Number(c.id) || 0)); if (mx) localStorage.setItem(cmtReadKey, String(mx)); };
  let cmtLoaded: any[] = [];
  const open = () => {
    cmtMarkRead(cmtLoaded);
    unreadBadge.hidden = true; card.classList.remove('pjv-cmt-has-unread');
    strip.querySelectorAll('.pjv-cmt-mini-unread').forEach((n) => n.classList.remove('pjv-cmt-mini-unread'));
    openProjectComments(id, members);
  };
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  (async () => {
    let comments: any[] = [];
    try { const d = await api('/api/ui/v6/projects/' + id + '/comments'); comments = ((d && d.feed) || []).filter((f) => f && f.kind === 'comment'); }
    catch (_) { strip.replaceChildren(el('div', { class: 'pjv-cmt-loading', text: '코멘트를 불러오지 못했어요' })); return; }
    cmtLoaded = comments;
    countEl.textContent = comments.length ? ' ' + comments.length : '';
    const lr = cmtLastRead();
    const isUnread = (c) => (Number(c.id) || 0) > lr && c.actor !== cmtMeId;
    const unreadN = comments.filter(isUnread).length;
    if (unreadN) { unreadBadge.hidden = false; unreadBadge.textContent = unreadN + '개 안 읽음'; card.classList.add('pjv-cmt-has-unread'); }
    strip.replaceChildren();
    if (!comments.length) {
      strip.append(el('div', { class: 'pjv-cmt-empty-card' }, el('span', { class: 'pjv-cmt-empty-ic', text: '＋' }), el('span', { text: '첫 코멘트를 남겨보세요' })));
      return;
    }
    const recent = comments.slice().reverse().slice(0, 12); // 피드는 시간 오름차순 → 최신 먼저
    for (const c of recent) {
      const who = c.display_name || nameOf(c.actor);
      const preview = (c.body || '').replace(/\s+/g, ' ').trim();
      strip.append(el('div', { class: 'pjv-cmt-mini' + (isUnread(c) ? ' pjv-cmt-mini-unread' : '') },
        el('div', { class: 'pjv-cmt-mini-top' },
          personFace(c.actor || who, 'pjv-cmt-mini-ava', who),
          el('span', { class: 'pjv-cmt-mini-name', text: who }),
          el('span', { class: 'pjv-cmt-mini-time', text: c.ts ? relTime(c.ts) : '' })),
        el('div', { class: 'pjv-cmt-mini-text', text: preview })));
    }
  })();
  return card;
}

// ── 코멘트 드로어 — 코멘트 섹션 클릭 → 우측에서 슬라이드되는 오버레이(상시 점유 X). 프로젝트 전체 코멘트, 모든 팀원 작성. ──
//  저장: task_comment(task_id=프로젝트 id) — v6 에서 태스크=프로젝트행이라 /tasks/:id/comments·/detail 을 프로젝트 id 로 그대로 재사용.
function openProjectComments(id, members) {
  const nameOf = (uid) => { const m = (members || []).find((x) => x.member_id === uid); return (m && m.display_name) || uid || '?'; };
  const panel = el('aside', { class: 'cmt-drawer', role: 'dialog', 'aria-label': '코멘트' });
  const back = el('div', { class: 'cmt-backdrop' }, panel);
  let closed = false;
  const close = () => { if (closed) return; closed = true; back.classList.remove('open'); document.removeEventListener('keydown', onEsc); setTimeout(() => back.remove(), 220); };
  const onEsc = (e) => { if (e.key === 'Escape') close(); };
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onEsc);

  let feedData: any[] = [];
  let newestFirst = false;  // 기본 오래된→최신(최신이 아래, 작성칸 옆) — 이미지와 동일
  let query = '';
  let threadParent: any = null;  // null=메인 피드, 숫자=해당 최상위 댓글의 스레드 보기
  const repliesOf = (pid) => feedData.filter((f) => f && f.kind === 'comment' && f.reply_to != null && Number(f.reply_to) === Number(pid));

  // 헤더 SVG 아이콘 헬퍼
  const hico = (...kids) => sv('svg', { viewBox: '0 0 24 24', width: '17', height: '17', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, ...kids);

  // 작성칸(하단) — 크고 편한 입력 + 파란 전송(이미지 참고).
  const ta = el('textarea', { class: 'cmt-input', placeholder: '댓글을 입력하세요…' });
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(Math.max(ta.scrollHeight, 56), 220) + 'px'; };
  ta.addEventListener('input', grow);
  const sendBtn = el('button', { class: 'cmt-send pjv-tm-send', type: 'button', title: '보내기 (⌘/Ctrl+Enter)' },
    hico(sv('path', { d: 'M22 2L11 13' }), sv('path', { d: 'M22 2l-7 20-4-9-9-4 20-7z' })));
  // 커서 위치 삽입(멘션·이모지·첨부·체크리스트). 태스크 모달 작성기 툴바와 동일 동작.
  const insertAtCursor = (text) => {
    const s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    const e = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
    const pos = s + text.length; ta.focus(); try { ta.setSelectionRange(pos, pos); } catch (_) { /* noop */ } grow();
  };
  // 태스크 팝업 Activity 작성기 툴바 그대로 재사용 — ＋·Comment▾·📎·@·😊·✓·🎥·🎤·⋯ · ➤. 첨부는 이 프로젝트 공유 폴더.
  const composer = el('div', { class: 'cmt-composer' }, ta,
    pjvtmComposerToolbar({ insertAtCursor, members, sendBtn, d: { project: { id } } }));

  const feedBox = el('div', { class: 'cmt-feed' }, el('div', { class: 'cmt-empty', text: '불러오는 중…' }));
  const reactTo = async (c, emoji) => {
    try { const d = await api('/api/ui/v6/comments/' + c.id + '/reactions', { method: 'POST', body: JSON.stringify({ emoji }) }); c.reactions = (d && d.reactions) || []; renderFeed(); }
    catch (e) { toast('반응 실패 — ' + e.message, true); }
  };
  // 댓글 카드 1개 — 최상위/답글 공용. isReply=true 면 답글 스타일(들여쓰기).
  function commentCard(c, isReply) {
    const who = c.display_name || nameOf(c.actor);
    // 👍 좋아요(아웃라인 아이콘 + 개수) — 내가 눌렀으면 .on. 그 외 이모지 반응은 칩으로.
    const like = (c.reactions || []).filter((r) => r.emoji === '👍')[0];
    const likeBtn = el('button', { class: 'cmt-foot-btn cmt-like' + (like && like.mine ? ' on' : ''), type: 'button', title: '좋아요' },
      sv('svg', { viewBox: '0 0 24 24', width: '15', height: '15', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
        sv('path', { d: 'M7 10v11' }), sv('path', { d: 'M7 10l4-7a2 2 0 0 1 2.6 2.5L12.5 9H19a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 21H7' })));
    if (like) likeBtn.append(el('span', { class: 'cmt-like-n', text: String(like.count) }));
    likeBtn.onclick = () => reactTo(c, '👍');
    const reactRow = el('span', { class: 'cmt-react' }, likeBtn,
      ...(c.reactions || []).filter((r) => r.emoji !== '👍').map((r) => {
        const ch = el('button', { class: 'cmt-react-chip' + (r.mine ? ' mine' : ''), type: 'button', text: r.emoji + ' ' + r.count });
        ch.onclick = () => reactTo(c, r.emoji); return ch;
      }));
    const replyBtn = el('button', { class: 'cmt-foot-btn cmt-reply', type: 'button', text: '답글' });
    replyBtn.onclick = () => {
      if (threadParent != null) { ta.value = (ta.value ? ta.value.replace(/\s*$/, ' ') : '') + '@' + who + ' '; ta.focus(); grow(); }
      else openThread(c.id);  // 메인 피드 → 스레드 열기
    };
    const bodyKids: any[] = [
      el('div', { class: 'cmt-meta' }, el('span', { class: 'cmt-name', text: who }), el('span', { class: 'cmt-time', text: c.ts ? '· ' + relTime(c.ts) : '' })),
      el('div', { class: 'cmt-text md-rendered' }, renderMarkdown(c.body || '')),
      el('div', { class: 'cmt-foot' }, reactRow, replyBtn),
    ];
    // 메인 피드의 최상위 카드에만 'N개의 답글' 칩 — 클릭 시 스레드 보기. (스레드 안에서는 표시 안 함)
    if (!isReply && threadParent == null) {
      const reps = repliesOf(c.id);
      if (reps.length) {
        const seen: any = {}; const avas: any[] = [];
        for (const r of reps) { const k = r.actor || r.display_name; if (seen[k] || avas.length >= 3) continue; seen[k] = 1;
          const rw = r.display_name || nameOf(r.actor);
          avas.push(personFace(r.actor || rw, 'cmt-thread-pill-ava', rw)); }
        const last = reps[reps.length - 1];
        const pill = el('button', { class: 'cmt-thread-pill', type: 'button' },
          el('span', { class: 'cmt-thread-pill-avas' }, ...avas),
          el('span', { class: 'cmt-thread-pill-n', text: reps.length + '개의 답글' }),
          el('span', { class: 'cmt-thread-pill-time', text: last && last.ts ? '· 마지막 ' + relTime(last.ts) : '' }));
        pill.onclick = () => openThread(c.id);
        bodyKids.splice(bodyKids.length - 1, 0, pill); // 푸터(👍/답글) '위'에 답글 칩을 둔다(맨 아래로 빠져 어색하던 것 수정).
      }
    }
    // 카드 우상단 호버 액션(클릭업식) — 반응(이모지)·링크 복사·답글. (수정/삭제는 백엔드 엔드포인트가 없어 제외.)
    const act = (title, icon, fn) => { const b = el('button', { class: 'cmt-act', type: 'button', title }, icon); b.onclick = (e) => { e.stopPropagation(); fn(b); }; return b; };
    const emojiIco = hico(sv('circle', { cx: 12, cy: 12, r: 8.5 }), sv('path', { d: 'M8.5 14a4 4 0 0 0 7 0' }), sv('circle', { cx: 9, cy: 10, r: .9, fill: 'currentColor', stroke: 'none' }), sv('circle', { cx: 15, cy: 10, r: .9, fill: 'currentColor', stroke: 'none' }));
    const linkIco = hico(sv('path', { d: 'M10 13a4.5 4.5 0 0 0 6.4 0l2-2a4.5 4.5 0 1 0-6.4-6.4l-1.1 1.1' }), sv('path', { d: 'M14 11a4.5 4.5 0 0 0-6.4 0l-2 2a4.5 4.5 0 1 0 6.4 6.4l1.1-1.1' }));
    const replyIco = hico(sv('path', { d: 'M9 17l-5-5 5-5' }), sv('path', { d: 'M4 12h11a5 5 0 0 1 5 5v1' }));
    const REACT_EMOJIS = ['👍', '❤️', '😄', '🎉', '👀', '🙏'];
    const actions = el('div', { class: 'cmt-actions' },
      act('반응', emojiIco, (b) => { const pop = el('div', { class: 'cmt-emoji-pop' }); const closePop = pjvPopover(b, pop); REACT_EMOJIS.forEach((em) => { const eb = el('button', { class: 'cmt-emoji-opt', type: 'button', text: em }); eb.onclick = () => { closePop(); reactTo(c, em); }; pop.append(eb); }); }),
      act('링크 복사', linkIco, () => { const url = location.origin + location.pathname + location.search + '#cmt-' + c.id; try { if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('링크를 복사했어요')).catch(() => toast('복사 실패', true)); else toast('복사 실패', true); } catch (_) { toast('복사 실패', true); } }),
      act('답글', replyIco, () => replyBtn.onclick()));
    return el('div', { class: 'cmt-card' + (isReply ? ' cmt-reply-card' : '') },
      personFace(c.actor || who, 'cmt-ava', who),
      el('div', { class: 'cmt-body' }, ...bodyKids),
      actions);
  }
  function openThread(pid) { threadParent = pid; query = ''; if (searchBar) { searchBar.hidden = true; searchBtn.classList.remove('on'); searchIn.value = ''; } renderFeed(); setTimeout(() => ta.focus(), 0); }
  // 헤더/작성칸을 현재 모드(메인 피드 vs 스레드)에 맞춰 갱신.
  function renderHead() {
    const inThread = threadParent != null;
    if (backBtn) backBtn.hidden = !inThread;
    if (headTitle) headTitle.textContent = inThread ? '스레드' : '활동';
    if (sortBtn) sortBtn.hidden = inThread;
    if (searchBtn) searchBtn.hidden = inThread;
    ta.placeholder = inThread ? '답글을 입력하세요…' : '댓글을 입력하세요…';
  }
  function renderFeed() {
    renderHead();
    feedBox.replaceChildren();
    if (threadParent != null) {  // ── 스레드 보기: 부모 + 답글들 ──
      const parent = feedData.find((f) => f && f.kind === 'comment' && Number(f.id) === Number(threadParent));
      if (!parent) { threadParent = null; renderFeed(); return; }
      feedBox.append(commentCard(parent, false));
      const reps = repliesOf(threadParent).slice().sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
      feedBox.append(reps.length
        ? el('div', { class: 'cmt-thread-replies' }, ...reps.map((r) => commentCard(r, true)))
        : el('div', { class: 'cmt-thread-empty', text: '첫 답글을 남겨보세요.' }));
      setTimeout(() => { feedBox.scrollTop = feedBox.scrollHeight; }, 0);
      return;
    }
    // ── 메인 피드: 최상위 댓글만(reply_to 없음) ──
    let comments = feedData.filter((f) => f && f.kind === 'comment' && f.reply_to == null);
    if (query) comments = comments.filter((c) => (c.body || '').toLowerCase().includes(query) || (c.display_name || nameOf(c.actor) || '').toLowerCase().includes(query));
    if (newestFirst) comments = comments.slice().reverse();
    if (!comments.length) { feedBox.append(el('div', { class: 'cmt-empty', text: query ? '검색 결과가 없어요.' : '아직 코멘트가 없어요. 아래에서 첫 코멘트를 남겨보세요.' })); return; }
    for (const c of comments) feedBox.append(commentCard(c, false));
    if (!newestFirst && !query) setTimeout(() => { feedBox.scrollTop = feedBox.scrollHeight; }, 0); // 오래된순 → 최신이 아래, 바닥으로
  }
  const send = async () => {
    const text = ta.value.trim(); if (!text) return;
    sendBtn.disabled = true; ta.disabled = true;
    const payload: any = { text };
    if (threadParent != null) payload.parent_id = threadParent;  // 스레드 답글
    try {
      const d = await api('/api/ui/v6/tasks/' + id + '/comments', { method: 'POST', body: JSON.stringify(payload) });
      ta.value = ''; grow(); feedData = (d && d.feed) || []; renderFeed();
      if (threadParent == null && newestFirst) feedBox.scrollTop = 0;
    }
    catch (e) { toast('전송 실패 — ' + e.message, true); }
    sendBtn.disabled = false; ta.disabled = false; ta.focus();
  };
  sendBtn.onclick = send;
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });

  // 헤더 — '코멘트' + 정렬·검색 토글(보이는 버튼은 기능까지) + 닫기.
  const sortBtn = el('button', { class: 'cmt-hbtn', type: 'button', title: '정렬: 오래된순' },
    hico(sv('path', { d: 'M7 4v15M7 4L4 8M7 4l3 4' }), sv('path', { d: 'M17 20V5M17 20l-3-4M17 20l3-4' })));
  sortBtn.onclick = () => { newestFirst = !newestFirst; sortBtn.classList.toggle('on', newestFirst); sortBtn.title = newestFirst ? '정렬: 최신순' : '정렬: 오래된순'; renderFeed(); };
  const searchIn = el('input', { type: 'text', class: 'cmt-search-in', placeholder: '코멘트 검색…' });
  searchIn.addEventListener('input', () => { query = searchIn.value.trim().toLowerCase(); renderFeed(); });
  const searchBar = el('div', { class: 'cmt-search', hidden: true }, searchIn);
  const searchBtn = el('button', { class: 'cmt-hbtn', type: 'button', title: '검색' }, hico(sv('circle', { cx: 11, cy: 11, r: 7 }), sv('path', { d: 'M21 21l-4.3-4.3' })));
  searchBtn.onclick = () => { const willOpen = searchBar.hidden; searchBar.hidden = !willOpen; searchBtn.classList.toggle('on', willOpen); if (willOpen) searchIn.focus(); else { query = ''; searchIn.value = ''; renderFeed(); } };
  // 스레드 보기 → 메인 피드로 돌아가는 뒤로 버튼(메인에서는 숨김).
  const backBtn = el('button', { class: 'cmt-hbtn cmt-back', type: 'button', title: '뒤로', hidden: true }, hico(sv('path', { d: 'M15 18l-6-6 6-6' })));
  backBtn.onclick = () => { threadParent = null; renderFeed(); };
  const headTitle = el('h3', { text: '활동' });
  const head = el('div', { class: 'cmt-head' }, backBtn, headTitle,
    el('div', { class: 'cmt-head-actions' }, sortBtn, searchBtn,
      el('button', { class: 'cmt-close', type: 'button', title: '닫기 (Esc)', text: '✕', onclick: close })));

  panel.append(head, searchBar, feedBox, composer);
  document.body.append(back);
  requestAnimationFrame(() => { back.classList.add('open'); grow(); });
  (async () => {
    try {
      const d = await api('/api/ui/v6/projects/' + id + '/comments'); feedData = (d && d.feed) || []; renderFeed();
      // 드로어를 열어 읽었으니 마지막 읽음 id 갱신(가장 최신 코멘트 id) — 섹션 안읽음 배지 해제.
      const cs = feedData.filter((f) => f && f.kind === 'comment'); const mx = Math.max(0, ...cs.map((c) => Number(c.id) || 0)); if (mx) localStorage.setItem('pjv_cmt_read_' + id, String(mx));
    }
    catch (e) { feedBox.replaceChildren(el('div', { class: 'cmt-empty', text: '불러오지 못했습니다 — ' + e.message })); }
  })();
  setTimeout(() => ta.focus(), 180);
}


export { mountBodyEditor, projectBodyCommentRow, projectBodySection, uploadBodyFile };
export { buildWysiwygToolbar, mdFromDom } from './detail-editor.js';
export { projectKnowledgeSection } from './detail-knowledge.js';

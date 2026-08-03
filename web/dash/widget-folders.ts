// dash/widget-folders.ts — ③ 팀 공유 폴더 위젯 + 그 '전체 보기' 파일 탐색기(#1313 R43 · dashboard-home.ts 에서 verbatim 분리).
//  위젯(아이콘/목록 한 줄) → ⤢ → 브라우저 모달(하위 진입·CRUD·업로드·미리보기) → 🔒 공개범위 폼까지가 한 흐름이라 한 파일에 모았다.
//  파일 프리미티브(authDownload·fmtSize)와 업로드 프리미티브(upControl/upDropZone/upSend/upProgress)는
//  프로젝트 공유 폴더(#781·#795·#797)에서 검증된 것을 그대로 재사용한다 — 취소·진행바를 화면마다 따로 만들지 않는다.
//  공개범위 폼 프리미티브(compactPicker·memberPicker)도 같은 이유로 재사용(#1291) — 리스트·스페이스·공유폴더가
//  '누가 보나'를 **같은 컨트롤**로 물어봐야 사용자가 규칙을 한 번만 배운다.
import { TOKEN_KEY, api, apiUrl, el, errorNote, toast, visAxisOn } from '../core.js';
import { skeleton } from '../learn.js';
import { overlay } from '../admin.js';            // 공개범위 폼 등 — 다른 모달과 같은 프리미티브(#853)
import { UP_CONFIRM, authDownload, compactPicker, fileSortApply, fileSortBtn, fileSortLoad, fileSortSave, fmtFileDateFull, fmtSize, memberPicker, upControl, upDropZone, upPrecheckOverwrite, upProgress, upSend, upToast, type UpItem } from '../projects.js';
import { dashFoldView, dashSaveFoldView } from './prefs.js';
import { dashDownloadIcon, dashFileThumb, dashFolderThumb, dashRenameIcon, dashTrashIcon, dashViewIconIcon, dashViewListIcon } from './icons.js';
import { dashChoicePopover, dashCtl, dashEmpty } from './chrome.js';
import { copyFileLink, fileLinkUrl, shareLinkIcon } from '../lib/sharelink.js';   // #1436 공유 링크 — 주소 형식·복사 UI 의 단일 소유
import { dashModal } from './widget-tasks-review-log.js'; // 전체 보기 팝업 — 작업로그 팝업과 **같은** 경량 모달
import { dashAuthFetch, wheelToHorizontal } from './widget-folders-preview.js';
import { buildFilePreview } from '../lib/file-preview.js';   // #1436 후속 — 미리보기 판정·렌더의 단일 소유

// ── ③ 팀 공유 폴더 — 공유 워크스페이스 루트의 폴더. 목록형→아이콘형(#621). ──
//  프로젝트 상세 '공유 폴더'와 동일한 아이콘 카드(proj-file-*): 맥 스타일 폴더 아이콘 + 이름 + '폴더'.
async function fillFolders(zone) {
  // '전체 보기' → 공유 폴더 브라우저 모달(하위 폴더 진입 + 파일 표시 + CRUD, #672). 넓은 모달로.
  const openBrowser = (startPath) => dashModal('팀 공유 폴더', dashFolderBrowser('shared', startPath || ''), true, { persistent: true, resizable: true, history: true });
  const qp = (p) => 'root=shared&path=' + encodeURIComponent(p || '');   // 위젯은 항상 공유 워크스페이스 루트 기준(현재 경로 개념이 없다)
  let dirs: string[] = [];
  let locked = new Set<string>();   // 일부공개 폴더(#1291) — 🔒 배지용. 서버가 items[].locked 로 알려준다.
  // 뷰(아이콘|목록)를 ⚙ 설정(dashFoldView, 전체보기와 공유)에 맞춰 렌더 — #670: 목록으로 바꾸면 대시보드 위젯도 목록으로.
  const paint = () => {
    if (!dirs.length) { zone.body.replaceChildren(dashEmpty('공유 워크스페이스에 폴더가 없어요.')); return; }
    if (dashFoldView() === 'list') {
      const list = el('div', { class: 'dash-fold-list' });
      for (const name of dirs) list.append(dashFolderRow(name, () => openBrowser(name), locked.has(name)));
      zone.body.replaceChildren(list);
    } else {
      const grid = el('div', { class: 'proj-file-grid dash-fold-grid' });
      for (const name of dirs) {
        const card = dashFolderCard(name, locked.has(name));
        card.classList.add('dash-fold-open');
        card.setAttribute('role', 'button'); card.setAttribute('tabindex', '0'); card.title = name + ' 열기';
        card.addEventListener('click', () => openBrowser(name));
        card.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBrowser(name); } });
        grid.append(card);
      }
      wheelToHorizontal(grid);   // 아이콘 뷰는 한 줄 가로 목록 — 마우스 세로 휠로도 옆으로 굴러가게(#req)
      zone.body.replaceChildren(grid);
    }
  };
  // 헤더 우상단 통일 컨트롤 — ⚙(폴더 기본 뷰: 저장 후 위젯도 즉시 그 뷰로 재렌더) + ⤢(전체 보기 모달).
  const openPrefs = (anchor) => dashChoicePopover(anchor, '폴더 기본 뷰', [['icon', '아이콘'], ['list', '목록']], dashFoldView(), (v) => { dashSaveFoldView(v); paint(); });
  dashCtl(zone, { gear: { title: '폴더 기본 뷰 설정', open: openPrefs }, action: { onClick: () => openBrowser(''), title: '공유 폴더 전체 보기 · 파일 관리' } });
  // 목록 로드 — 업로드 뒤에도 다시 부른다(#796: 예전엔 fetch 가 함수 안에 인라인이라 재로드 경로가 아예 없었다).
  const reload = async () => {
    let data;
    try { data = await api('/api/ui/terminal/browse?' + qp('')); }
    catch (e) { zone.body.replaceChildren(errorNote(e, '공유 폴더를 불러오지 못했습니다')); return; }
    dirs = (data && data.dirs) || [];
    // 일부공개 표시(#1291) — items 는 dirs 와 같은 응답의 상세형이라 추가 요청 없이 배지를 얻는다.
    locked = new Set((((data && data.items) || []) as any[]).filter((i) => i.type === 'dir' && i.locked).map((i) => i.name));
    zone.countEl.textContent = String(dirs.length);
    paint();
  };

  // ── 드래그앤드롭 업로드(#796) — 위젯 박스 위로 파일·폴더를 끌어다 놓으면 공유 워크스페이스 '루트'로 올린다. ──
  //  여기엔 드롭이 아예 없어서 끌어다 놔도 아무 일도 안 일어났다(모달·프로젝트 카드는 되는데 위젯만 안 되던 톤 어긋남).
  //  업로드 '버튼'은 두지 않는다 — 존 헤더는 [⚙][⤢] 로 5개 존이 동일해야 한다(#req 통일성). 버튼 업로드는 ⤢ 전체 보기 모달의 '⬆ 업로드'(#795).
  //  전송 루프·진행바·취소는 프리미티브(upSend/upProgress)를 그대로 쓴다 — 네 화면이 같은 취소를 공유한다(#797).
  let prog: any = null;   // 업로드 중이면 진행·취소 바 — 박스가 작아 헤더 아래 한 줄로(목록은 계속 보인다)
  const progSlot = el('div', { class: 'up-prog-box' });
  zone.box.insertBefore(progSlot, zone.body);   // 목록(zone.body)은 paint 가 통째로 갈아끼우므로 슬롯은 그 밖(헤더와 목록 사이)에 둔다
  async function uploadItems(items: UpItem[], emptyDirs: string[]) {
    // 업로드 중 또 드롭하면 진행 상태가 엉킨다 — 잠금(data-uploading)은 '목록'에만 걸리고(박스는 드롭을 계속 받아야 한다) 여기서 막는다.
    if (prog) { toast('업로드 중입니다 — 끝난 뒤에 올려 주세요', true); return; }
    const arr = items || [], eds = emptyDirs || [];
    if (!arr.length && !eds.length) { toast('올릴 파일이 없습니다', true); return; }
    if (arr.length > UP_CONFIRM && !confirm(arr.length + '개 파일을 업로드합니다. 계속할까요?')) return;
    const ac = new AbortController();
    prog = upProgress(arr.length, () => ac.abort());   // '취소' → 남은 파일은 안 보내고, 보내던 파일도 끊는다(#797)
    progSlot.append(prog.row);
    zone.box.setAttribute('data-uploading', '1');   // 목록 조작만 잠금 — 헤더(⚙·⤢)와 진행 바는 살아 있다(흐려지지 않는다)
    const r = await upSend({
      items: arr, emptyDirs: eds, signal: ac.signal,
      fileUrl: (rel) => '/api/ui/terminal/browse/file?' + qp(rel),
      dirUrl: (d) => '/api/ui/terminal/browse/mkdir?' + qp(d),
      onProgress: (i, rel, pct) => { if (prog) prog.set(i, rel, pct); },
    });
    prog.row.remove();
    prog = null;
    zone.box.removeAttribute('data-uploading');
    // 위젯은 '폴더'만 보여 준다 → 루트로 올린 파일은 목록에 안 나타난다. 어디로 갔는지 토스트가 말해 준다(파일은 ⤢ 전체 보기에서 확인).
    if (r.canceled) toast(r.ok ? ('팀 공유 폴더에 ' + r.ok + '개까지 올리고 취소했습니다') : '업로드를 취소했습니다');
    else if (r.ok || r.made) toast('팀 공유 폴더에 ' + (r.ok ? r.ok + '개 업로드 완료' : r.made + '개 폴더 생성') + (r.fail ? (' · ' + r.fail + '개 실패') : ''));
    await reload();
  }
  upDropZone(zone.box, zone.box, (items, emptyDirs) => uploadItems(items, emptyDirs));   // 박스가 곧 드롭존 + 하이라이트(.dash-zone.drop-active)

  await reload();
}

// 공유 폴더 목록 행(#670) — 아이콘 카드 대신 컴팩트 리스트. 폴더 아이콘 + 굵은 이름 + hover 시 슬라이드 셰브런.
function dashFolderRow(name, onOpen, locked?) {
  const row = el('div', { class: 'dash-fold-row', role: 'button', tabindex: '0', title: name + ' 열기' },
    el('span', { class: 'dash-fold-row-ic', 'aria-hidden': 'true' }, dashFolderThumb()),
    el('span', { class: 'dash-fold-row-nm' }, el('span', { text: name }), locked ? dashLockBadge() : null),
    el('span', { class: 'dash-fold-row-go', 'aria-hidden': 'true', text: '›' }));
  row.addEventListener('click', onOpen);
  row.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } });
  return row;
}

// 공유 폴더 아이콘 카드 — 박스·브라우저 공용. 프로젝트 상세 공유 폴더(proj-file-*)와 동일.
function dashFolderCard(name, locked?) {
  // 🔒 는 카드에선 **모서리 배지**다 — 이름은 2줄에서 잘리므로(-webkit-line-clamp) 이름 옆에 붙이면 긴 이름에서
  //  배지가 통째로 사라진다. 잠금 표시가 사라지는 건 표시가 없는 것보다 나쁘다(있다고 믿게 만든다).
  return el('div', { class: 'proj-file-card', title: name },
    locked ? dashLockBadge() : null,
    el('div', { class: 'proj-file-card-ic' }, dashFolderThumb()),
    el('div', { class: 'proj-file-card-nm', text: name }),
    el('div', { class: 'proj-file-card-sz', text: '폴더' }));
}

// ── 공유폴더 공개범위(#1291 v2) ──────────────────────────────────────────────
//  지금까지 공유 워크스페이스는 **항상 전원 공개**였다 — 대시보드에서 클릭 두 번이면 조직 전체의 파일을 목록·
//  다운로드·삭제까지 할 수 있었다. 제품조직 밖(영업본부 등)까지 쓰기 시작하면 그게 그대로 사고 표면이다.
//  아래가 폴더 단위로 대상을 지정하는 창구다.

// 🔒 배지 — '전원 공개가 아님'을 아이콘으로 알린다. 접근 여부가 아니라 **범위** 표시다(보이니까 배지가 보이는 것).
//  이게 없으면 "여긴 전체공개인 줄 알고" 파일을 올리는(혹은 반대로 못 볼 사람에게 공유했다고 착각하는) 사고가 난다.
function dashLockBadge(title?) {
  // 축이 꺼져 있으면 배지를 그리지 않는다(#1291) — ACL 값은 남아 있지만 지금은 강제되지 않으므로,
  //  배지를 붙이면 "지정한 사람만 본다"고 거짓말하는 셈이다(실제로는 전원이 본다).
  if (!visAxisOn('shared_folder')) return null;
  return el('span', { class: 'dash-lock-badge', title: title || '일부공개 — 지정한 사람만 볼 수 있어요', 'aria-label': '일부공개', text: '🔒' });
}

/**
 * 폴더 하나의 공개범위 설정 모달.
 *  컨트롤은 리스트·스페이스 공개범위와 **같은 것**을 쓴다(pjv-visrow 카드 + compactPicker(memberPicker)) —
 *  같은 개념('누가 보나')이 화면마다 다르게 생기면 사용자가 규칙을 두 번 배워야 한다(projects.ts openFolderForm 참고).
 */
async function openFolderVisibilityForm(root, rel, name, onSaved) {
  const aclUrl = '/api/ui/terminal/browse/acl?root=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(rel);
  let cur: any;
  try { cur = await api(aclUrl); }
  catch (e: any) { toast('공개범위를 불러오지 못했습니다 — ' + e.message, true); return; }

  // 프로젝트 폴더는 그 프로젝트의 공개범위를 그대로 따른다(원문: "프로젝트 내의 공유폴더는 해당 프로젝트의
  //  가시성을 상속받는 게 맞을듯"). 두 곳에서 따로 잠글 수 있으면 어느 쪽이 이겼는지 아무도 모른다 → 여기선 안내만.
  if (!cur.settable) {
    const okBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '알겠어요' });
    const backRO = overlay('공개범위 · ' + name,
      el('div', { class: 'dash-fbvis-path', text: rel }),
      el('div', { class: 'dash-fbvis-note' },
        el('b', { text: '이 폴더는 프로젝트의 공개범위를 그대로 따라요' }),
        el('span', { text: '프로젝트 폴더와 그 안의 모든 파일은 그 프로젝트가 보이는 사람에게만 보여요. 범위를 바꾸려면 프로젝트(또는 그 리스트·스페이스)의 공개범위를 바꾸세요.' })),
      el('div', { class: 'ov-actions' }, okBtn));
    okBtn.onclick = () => backRO.remove();
    return;
  }

  let vis = cur.visibility === 'members' ? 'members' : 'open';
  const sw = el('span', { class: 'pjv-switch' + (vis === 'members' ? ' on' : '') }, el('span', { class: 'pjv-switch-knob' }));
  // 아직 안 잠긴 폴더면 본인을 미리 담는다 — 자기가 잠그고 자기가 못 여는 상태(되돌릴 사람은 관리자뿐)를 막는 첫 방어선.
  //  서버도 같은 규칙을 강제한다(shared-folder.assertGrantSubjectsValid) — UI 는 실수를 줄이고, 경계는 서버가 지킨다.
  const picker = compactPicker('공개 대상',
    (onChange) => memberPicker(cur.members || [], { includeMe: vis !== 'members', onChange }),
    { emptyText: '대상 없음 — 관리자만 볼 수 있어요', avatars: true, maxChips: 6 });
  const memberField = el('div', { class: 'field', style: 'margin-top:12px' + (vis === 'members' ? '' : ';display:none') }, picker.row);
  const visRow = el('div', { class: 'pjv-visrow' + (vis === 'members' ? ' on' : ''), role: 'switch', tabindex: '0',
    'aria-checked': vis === 'members' ? 'true' : 'false' },
  el('span', { class: 'pjv-visrow-txt' },
    el('span', { class: 'pjv-visrow-title', text: '공개범위를 지정한 사람으로 제한' }),
    el('span', { class: 'pjv-visrow-hint', text: '켜면 이 폴더와 그 안의 하위 폴더·파일 전부가 대상 외에는 보이지 않아요(목록·미리보기·다운로드·업로드 모두).' })),
  sw);
  const toggleVis = () => {
    vis = vis === 'members' ? 'open' : 'members';
    const on = vis === 'members';
    visRow.classList.toggle('on', on); sw.classList.toggle('on', on);
    visRow.setAttribute('aria-checked', on ? 'true' : 'false');
    memberField.style.display = on ? '' : 'none';
  };
  visRow.onclick = (e: any) => { e.stopPropagation(); toggleVis(); };
  visRow.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleVis(); } });

  // 상속(단조 축소) 안내 — 상위가 이미 잠겨 있으면 여기서 '전체공개'로 돌려도 실제로는 안 열린다.
  //  이걸 안 보여 주면 "전체공개로 바꿨는데 왜 남들이 못 보지?"가 그대로 지원 문의가 된다.
  const inherited = cur.inherited_from
    ? el('div', { class: 'dash-fbvis-note' },
      el('b', { text: '상위 폴더에서 이미 제한돼 있어요' }),
      el('span', { text: '‘' + cur.inherited_from + '’ 이(가) 일부공개라, 이 폴더는 여기서 더 좁힐 수만 있고 넓힐 수는 없어요.' }))
    : null;

  const saveBtn = el('button', { class: 'btn btn-primary', type: 'button', text: '저장' });
  const cancelBtn = el('button', { class: 'btn btn-ghost', type: 'button', text: '취소' });
  const back = overlay('공개범위 · ' + name,
    el('div', { class: 'dash-fbvis-path', text: rel }),
    inherited,
    el('div', { class: 'field', style: 'margin-top:12px' }, visRow),
    memberField,
    el('div', { class: 'pjv-side-nav-hint', style: 'margin-top:10px', text: '공개범위는 사람과 그 사람의 AI 에 똑같이 적용돼요 — 웹에서 안 보이면 MCP 로도 안 보여요.' }),
    el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
  cancelBtn.onclick = () => back.remove();
  let busy = false;   // 재진입 가드 — 이중 제출로 대상 교체가 두 번 돌지 않게.
  saveBtn.onclick = async () => {
    if (busy) return;
    busy = true; saveBtn.disabled = true;
    try {
      await api(aclUrl, { method: 'POST', body: JSON.stringify({ visibility: vis, members: vis === 'members' ? picker.getSelected() : [] }) });
      back.remove();
      toast(vis === 'members' ? '이제 지정한 사람에게만 보여요' : '전체 공개로 바꿨어요');
      if (onSaved) onSaved();
    } catch (e: any) { toast('저장 실패 — ' + e.message, true); busy = false; saveBtn.disabled = false; }
  };
}

// ── 공유 폴더 브라우저(#672) — 전체 보기 모달 안의 파일 탐색기: 브레드크럼 하위 진입 + 파일 표시 + CRUD + 업로드(파일·폴더·드롭, #795). ──
//  루트 브라우즈 API(/api/ui/terminal/browse[/file])만 쓴다 — 공유 워크스페이스는 셸(터미널)로 이미 rw 라 UI CRUD 가 권한을 넓히지 않는다.
//  파일 프리미티브(authDownload·fmtSize)와 업로드 프리미티브(upControl/upDropZone/upSend/upProgress)는 프로젝트 공유 폴더에서 검증된 것을 그대로 재사용.
function dashFolderBrowser(root, startPath) {
  const container = el('div', { class: 'dash-fb' });
  let curPath = startPath || '';
  const qp = (p) => 'root=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(p);
  const relOf = (name) => (curPath ? curPath + '/' : '') + name;
  const busy = (on) => { if (on) container.setAttribute('aria-busy', 'true'); else container.removeAttribute('aria-busy'); };

  const load = async () => {
    container.replaceChildren(el('div', { class: 'dash-fb-load' }, skeleton('불러오는 중')));
    let data;
    try { data = await api('/api/ui/terminal/browse?' + qp(curPath)); }
    catch (e) { busy(false); container.replaceChildren(errorNote(e, '폴더를 불러오지 못했습니다')); return; }
    curPath = data.path || '';
    render(data);
    busy(false); // 새 상태 렌더 완료 → 진행중 표시 해제(성공 경로에서도 반드시 — 안 그러면 pointer-events:none 이 남아 잠김).
  };
  const newFolder = async () => {
    const name = (prompt('새 폴더 이름') || '').trim();
    if (!name) return;
    busy(true);
    try { await api('/api/ui/terminal/browse/mkdir?' + qp(relOf(name)), { method: 'POST' }); await load(); }
    catch (e) { toast('폴더 생성 실패 — ' + e.message, true); busy(false); }
  };
  // ── 업로드: 파일 + '폴더' + 드래그앤드롭 (#795) — 프로젝트 공유 폴더(#781)의 프리미티브를 그대로 쓴다. ──
  //  items[].rel = 현재 폴더 기준 상대경로. 폴더를 올리면 'sub/child/a.png' 처럼 중첩 경로가 들어오고,
  //  서버 PUT 이 dirname 을 mkdir -p 하므로(src/terminal/terminal-files.ts) 그 구조가 디스크에 그대로 생긴다 → 서버 변경 불필요.
  let prog: any = null;   // 업로드 중이면 진행·취소 바(upProgress) — 목록 자리에 1장(폴더 업로드는 수백 건이라 파일별 카드 X)
  const up = upControl((items) => uploadItems(items, []), { className: 'dash-fb-btn primary', label: '⬆ 업로드' });
  async function uploadItems(items: UpItem[], emptyDirs: string[]) {
    // 업로드 중 또 드롭하면 진행 상태가 엉킨다 — 조작 잠금(data-uploading)은 container 에만 걸리고 드롭존은 오버레이라 여기서 막는다.
    if (prog) { toast('업로드 중입니다 — 끝난 뒤에 올려 주세요', true); return; }
    const arr = items || [], dirs = emptyDirs || [];
    if (!arr.length && !dirs.length) { toast('올릴 파일이 없습니다', true); return; }
    const pc = upPrecheckOverwrite(arr, (curData && curData.items) || []);   // #877 — 겹치면 무엇이 덮이는지 보여주고 확인
    if (!pc.go) return;
    if (arr.length > UP_CONFIRM && !confirm(arr.length + '개 파일을 업로드합니다. 계속할까요?')) return;
    const dest = curPath;   // 업로드 중 다른 폴더로 들어가도 '끌어다 놓은 그 폴더'로 간다
    const ac = new AbortController();
    prog = upProgress(arr.length, () => ac.abort());  // '취소' → 남은 파일은 안 보내고, 보내던 파일도 끊는다(#797)
    container.setAttribute('data-uploading', '1');   // 조작 잠금 — 진행 패널이 흐려지지 않게 aria-busy(opacity .5) 대신 이 속성
    render(null);                                    // ⚠ 잠금은 pointer-events:none 이라 CSS 에서 .up-prog 만 되살린다(안 그러면 취소 버튼이 안 눌린다)
    const r = await upSend({
      items: arr, emptyDirs: dirs, signal: ac.signal, overwriteNames: pc.over,
      fileUrl: (rel) => '/api/ui/terminal/browse/file?' + qp((dest ? dest + '/' : '') + rel),
      dirUrl: (d) => '/api/ui/terminal/browse/mkdir?' + qp((dest ? dest + '/' : '') + d),
      onProgress: (i, rel, pct) => { if (prog) prog.set(i, rel, pct); },
    });
    prog = null;
    container.removeAttribute('data-uploading');
    upToast(r);
    await load();
  }
  // 드래그앤드롭 — 이 브라우저엔 드롭 핸들러가 아예 없었다(그래서 끌어다 놔도 아무 일도 안 일어났다).
  //  받는 영역은 모달 오버레이 '전체' — 모달 밖 배경에 떨어뜨려도 브라우저가 그 파일을 열어 화면(SPA 상태)을 날리는 사고를 막는다.
  //  container 는 아직 DOM 밖이라(dashModal 이 나중에 append 한다) 다음 틱에 오버레이를 찾는다. 모달 밖 사용이면 container 자신이 드롭존.
  setTimeout(() => {
    const ov = container.closest('.dash-modal-ov');
    const hi = container.closest('.dash-modal');
    upDropZone(ov || container, hi || container, (items, emptyDirs) => uploadItems(items, emptyDirs));
  }, 0);

  const renameItem = async (name) => {
    const to = (prompt('새 이름', name) || '').trim();
    if (!to || to === name) return;
    busy(true);
    try { await api('/api/ui/terminal/browse/rename?' + qp(relOf(name)) + '&to=' + encodeURIComponent(to), { method: 'POST' }); await load(); }
    catch (e) { toast('이름 변경 실패 — ' + e.message, true); busy(false); }
  };
  const deleteItem = async (name, isDir) => {
    if (!confirm((isDir ? '폴더' : '파일') + ' ‘' + name + '’' + (isDir ? ' 및 그 안의 모든 내용' : '') + '을(를) 삭제할까요? 되돌릴 수 없어요.')) return;
    busy(true);
    try { await api('/api/ui/terminal/browse?' + qp(relOf(name)), { method: 'DELETE' }); await load(); }
    catch (e) { toast('삭제 실패 — ' + e.message, true); busy(false); }
  };
  const download = (name) => authDownload('/api/ui/terminal/browse/file?download=1&' + qp(relOf(name)), name);

  // 파일 미리보기 — 클릭 시 다운로드 대신 타입별 렌더를 브라우저 안(제자리)에 표시.
  //  ⭐ #1436 후속: 타입 판정·렌더·툴바 동작은 **공용 렌더러**(lib/file-preview.buildFilePreview)가 소유한다.
  //   종전엔 이 함수와 프로젝트 파일 뷰어(projects/files-cards.openFileViewer)가 각자 판정을 갖고 있어 같은 파일이
  //   화면마다 다르게 열렸다 — .csv 는 여기선 표·저기선 원문, .mp4 는 여기선 재생·저기선 '미지원', .md 편집은
  //   저기만 가능. 여기는 이제 '어디에 놓을지(제자리 전환)'와 '버튼 모양'만 정한다.
  //  이 화면이 새로 얻은 것: **md·텍스트 편집·저장**(프로젝트 모달의 장점) + [⛶ 전체화면].
  // 편집 저장 — browse 업로드(PUT)와 같은 라우트(파일 바이트라 JSON api() 를 쓰지 않는다).
  //  이 루트는 셸(터미널)로 이미 rw 라 UI 편집이 새 권한경계를 열지 않는다 — browse CRUD 를 연 것과 같은 근거.
  const browsePutFile = (url: string, text: string): Promise<Response> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) headers.Authorization = 'Bearer ' + t;
    return fetch(apiUrl(url), { method: 'PUT', headers, body: new Blob([text]) });
  };
  const showPreview = async (rel, name, size?) => {
    const viewUrl = '/api/ui/terminal/browse/file?' + qp(rel);
    const dlUrl = '/api/ui/terminal/browse/file?download=1&' + qp(rel);
    const mkBtn = (label, onClick) => el('button', { class: 'dash-fb-btn', type: 'button', text: label, onclick: onClick });
    const bar = el('div', { class: 'dash-fp-bar' },
      el('button', { class: 'dash-fb-btn', type: 'button', text: '← 뒤로', onclick: () => load() }),
      el('span', { class: 'dash-fp-name', title: name, text: name }),
      el('span', { class: 'dash-fb-spacer' }));
    const stage = el('div', { class: 'dash-fp-stage' }, el('div', { class: 'dash-fp-load' }, skeleton('불러오는 중')));
    container.replaceChildren(bar, stage);
    // ⛶ 전체화면 — 같은 파일을 공유 링크 전체페이지(#/f)로 새 탭에 연다. '더 크게 보기'와 '링크로 보내기'가
    //  같은 주소로 수렴해, 모달은 빠른 확인용이고 정독·공유는 전체페이지가 맡는다.
    const fullBtn = el('a', { class: 'dash-fb-btn', href: fileLinkUrl(root, rel), target: '_blank', rel: 'noopener',
      title: '전체화면(새 탭)으로 열기', text: '⛶ 전체화면' });
    let out;
    try {
      out = await buildFilePreview({
        name, size,
        fetchView: () => dashAuthFetch(viewUrl),
        fetchDownload: () => dashAuthFetch(dlUrl),
        // 기존 크기 규칙(20-dashboard.css .dash-fp-*)을 보존하려고 화면 클래스를 함께 얹는다.
        cls: { img: 'dash-fp-img', pdf: 'dash-fp-pdf', md: 'dash-fp-md', code: 'dash-fp-code', html: 'dash-fp-pdf', table: 'dash-fp-tablewrap', audio: 'dash-fp-audio', video: 'dash-fp-video', msg: 'dash-fp-msg' },
        pdfHash: '#navpanes=0&toolbar=1&view=FitH',   // 모달은 폭이 좁아 썸네일 사이드바를 끈다
        mkBtn,
        save: async (text) => {
          const res = await browsePutFile(viewUrl, text);
          if (!res.ok) throw new Error('저장 실패 (' + res.status + ')');
        },
        onSaved: () => toast('저장했습니다'),
        onError: (m) => toast(m, true),
      });
    } catch (e) {
      stage.replaceChildren(el('div', { class: 'dash-fp-msg' }, '미리보기 실패 — ' + ((e && e.message) || e)));
      return;
    }
    bar.append(...out.tools, fullBtn,
      el('button', { class: 'dash-fb-btn', type: 'button', title: '이 파일의 링크 복사', text: '🔗 링크 복사',
        onclick: () => copyFileLink(root, rel, 'file') }),
      el('button', { class: 'dash-fb-btn', type: 'button', text: '⬇ 다운로드', onclick: () => authDownload(dlUrl, name) }));
    stage.replaceChildren(out.body);
  };

  // 액션 버튼(다운로드·이름변경·삭제) — 아이콘/목록 두 뷰 공용.
  const act = (icon, title, danger, onClick) => {
    const b = el('button', { class: 'dash-fb-act' + (danger ? ' danger' : ''), type: 'button', title, 'aria-label': title }, icon);
    b.addEventListener('click', (e: any) => { e.stopPropagation(); onClick(); });
    return b;
  };
  const mkActions = (it, isDir) => {
    const actions = el('div', { class: 'dash-fb-actions' });
    // 🔗 공유 링크(#1436) — 파일·폴더 **모두** 첫 자리. 이게 첫 자리인 이유: 링크로 건네는 일이 이 화면에서
    //  가장 자주 하는 일이 됐고(요구 원문: "링크로 유관자 공유할때 훨씬 편할거같음"), 파괴적 액션(삭제)에서
    //  가장 먼 자리이기도 하다. 폭 계약은 32-file-share.css 가 4개 기준으로 다시 맞춘다.
    actions.append(act(shareLinkIcon(), '링크 복사', false, () => copyFileLink(root, relOf(it.name), isDir ? 'dir' : 'file')));
    // 폴더는 다운로드가 없는 자리에 '공개범위'가 들어간다 — 그래서 파일·폴더 모두 버튼 수가 같아
    //  기존 액션 열 폭(.dash-fb-row .dash-fb-actions)이 그대로 유지된다(정렬이 어긋나지 않는다).
    //  개인 폴더 루트는 애초에 멤버별로 갈려 있어 잠글 대상이 없다 → 공유 루트에서만 노출한다.
    //  공개범위 메뉴는 축이 켜져 있을 때만(#1291) — 꺼진 축의 설정 폼은 저장돼도 강제되지 않는다.
    if (isDir && root === 'shared' && visAxisOn('shared_folder')) actions.append(act('🔒', '공개범위', false, () => openFolderVisibilityForm(root, relOf(it.name), it.name, () => load())));
    else if (!isDir) actions.append(act(dashDownloadIcon(), '다운로드', false, () => download(it.name)));
    actions.append(act(dashRenameIcon(), '이름 바꾸기', false, () => renameItem(it.name)));
    actions.append(act(dashTrashIcon(), '삭제', true, () => deleteItem(it.name, isDir)));
    return actions;
  };
  const openItem = (it, isDir) => { if (isDir) { curPath = relOf(it.name); load(); } else showPreview(relOf(it.name), it.name, it.size); };
  // 아이콘(카드) 뷰 항목 — 맥 데스크탑 아이콘 톤.
  const fbCard = (it) => {
    const isDir = it.type === 'dir';
    const card = el('div', { class: 'proj-file-card dash-fb-card', title: it.name, role: 'button', tabindex: '0' },
      // 🔒 = 일부공개(#1291). 자기 ACL 이든 상위에서 물려받은 것이든 '전원 공개가 아님'을 알린다(모서리 배지 —
      //  카드 이름은 2줄에서 잘려 이름 옆에 붙이면 긴 이름에서 배지가 사라진다).
      it.locked ? dashLockBadge() : null,
      el('div', { class: 'proj-file-card-ic' }, isDir ? dashFolderThumb() : dashFileThumb(it.name)),
      el('div', { class: 'proj-file-card-nm', text: it.name }),
      el('div', { class: 'proj-file-card-sz', text: isDir ? '폴더' : fmtSize(it.size) }),
      it.mtime ? el('div', { class: 'proj-file-card-dt', text: fmtFileDateFull(it.mtime) }) : null);   // #1118 — 항상 풀 일시
    card.addEventListener('click', (e: any) => { if (e.target.closest('.dash-fb-actions')) return; openItem(it, isDir); });
    card.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openItem(it, isDir); } });
    card.append(mkActions(it, isDir));
    return card;
  };
  // 목록(Finder 리스트) 뷰 항목 — 작은 아이콘 · 이름 · 크기 · hover 액션.
  const fbRow = (it) => {
    const isDir = it.type === 'dir';
    const row = el('div', { class: 'dash-fb-row' + (isDir ? ' is-dir' : ''), title: it.name, role: 'button', tabindex: '0' },
      el('span', { class: 'dash-fb-row-ic' }, isDir ? dashFolderThumb() : dashFileThumb(it.name)),
      el('span', { class: 'dash-fb-row-nm' }, el('span', { text: it.name }), it.locked ? dashLockBadge() : null),
      // 폴더는 반복되던 '폴더' 텍스트 대신 hover 셰브런(열기), 파일은 크기(#670).
      isDir ? el('span', { class: 'dash-fb-row-go', 'aria-hidden': 'true', text: '›' }) : el('span', { class: 'dash-fb-row-sz', text: fmtSize(it.size) }),
      el('span', { class: 'dash-fb-row-dt', text: fmtFileDateFull(it.mtime) }),   // #1118 — 항상 풀 일시(오늘/어제 축약 X)
      mkActions(it, isDir));
    row.addEventListener('click', (e: any) => { if (e.target.closest('.dash-fb-actions')) return; openItem(it, isDir); });
    row.addEventListener('keydown', (e: any) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openItem(it, isDir); } });
    return row;
  };
  let viewMode = dashFoldView(); // 'icon' | 'list' — 기기별 저장(⚙ 폴더 기본 뷰와 공유).
  let curData: any = null;       // 마지막 로드 데이터(뷰 토글 시 재요청 없이 재렌더).
  let sort = fileSortLoad();     // 열 정렬 상태(#1118) — 기기별 저장, 프로젝트 '전체 보기' 모달과 공유
  const setSort = (s) => { sort = s; fileSortSave(s); render(null); };
  const render = (data) => {
    if (data) curData = data;
    data = curData || { items: [] };
    // 브레드크럼(루트 → 하위 진입 경로).
    const crumb = el('div', { class: 'dash-fb-crumb' },
      el('button', { class: 'dash-fb-seg', type: 'button', text: '공유 워크스페이스', onclick: () => { curPath = ''; load(); } }));
    let acc = '';
    for (const seg of (curPath ? curPath.split('/') : [])) {
      acc = acc ? acc + '/' + seg : seg; const p = acc;
      crumb.append(el('span', { class: 'dash-fb-sep', text: '/' }), el('button', { class: 'dash-fb-seg', type: 'button', text: seg, onclick: () => { curPath = p; load(); } }));
    }
    // 뷰 토글(아이콘/목록) — 사람이 직접 선택, 기기별 저장, 즉시 재렌더(재요청 없이).
    const mkSeg = (mode, label, icon) => {
      const b = el('button', { class: 'dash-fb-vbtn' + (viewMode === mode ? ' on' : ''), type: 'button', title: label, 'aria-label': label, 'aria-pressed': viewMode === mode ? 'true' : 'false' }, icon);
      b.onclick = () => { if (viewMode === mode) return; viewMode = mode; dashSaveFoldView(mode); render(null); };
      return b;
    };
    const viewSeg = el('div', { class: 'dash-fb-viewseg', role: 'group', 'aria-label': '보기 방식' },
      mkSeg('icon', '아이콘 보기', dashViewIconIcon()), mkSeg('list', '목록 보기', dashViewListIcon()));
    // 아이콘 뷰 정렬 셀렉트(#1118) — 목록 뷰는 열 머리글 클릭이 담당하니 아이콘 뷰에서만 노출.
    let sortSel: any = null;
    if (viewMode === 'icon') {
      sortSel = el('select', { class: 'dash-fb-btn dash-fb-sortsel', title: '정렬 기준', 'aria-label': '정렬 기준' },
        ...[['name:1', '이름 ↑'], ['name:-1', '이름 ↓'], ['size:-1', '크기 큰순'], ['size:1', '크기 작은순'], ['mtime:-1', '최근 수정순'], ['mtime:1', '오래된 수정순']]
          .map(([v, t]) => el('option', { value: v, text: t })));
      sortSel.value = sort.key + ':' + sort.dir;
      sortSel.onchange = () => { const [k, dd] = sortSel.value.split(':'); setSort({ key: k, dir: Number(dd) }); };
    }
    // 도구모음 — [뷰토글] · 정렬(아이콘 뷰) · 상위로 · (스페이서) · 새 폴더 · 업로드(파일/폴더 메뉴, #795).
    //  up.btn·up.fileIn·up.dirIn 은 매 렌더 같은 노드를 다시 넣는다 — append 는 복제가 아니라 '이동'이라 리스너·선택상태가 유지된다.
    const tools = el('div', { class: 'dash-fb-tools' },
      viewSeg,
      sortSel,
      (curPath ? el('button', { class: 'dash-fb-btn', type: 'button', text: '⬆ 상위', onclick: () => { curPath = data.parent || ''; load(); } }) : null),
      el('span', { class: 'dash-fb-spacer' }),
      el('button', { class: 'dash-fb-btn', type: 'button', text: '＋ 새 폴더', onclick: newFolder }),
      up.btn, up.fileIn, up.dirIn);
    const items = fileSortApply(data.items || [], sort);   // #1118 — 열 정렬(폴더 우선)
    let body;
    if (prog) { body = prog.row; }   // 업로드 중 — 목록 대신 진행·취소 바(같은 노드를 다시 넣는다 = 이동이라 리스너 유지)
    else if (!items.length) { body = el('div', { class: 'proj-file-grid dash-fb-grid' }, dashEmpty('이 폴더가 비어 있어요. ‘⬆ 업로드’를 누르거나, 파일·폴더를 끌어다 놓으세요.')); }
    else if (viewMode === 'list') {
      body = el('div', { class: 'dash-fb-list' });
      // 열 머리글(#1118) — 어떤 필드인지(이름/크기/수정 일시) 이름표 + 클릭 정렬. 스크롤 시 상단 고정.
      body.append(el('div', { class: 'dash-fb-row dash-fb-head' },
        el('span', { class: 'dash-fb-row-ic' }),
        el('span', { class: 'dash-fb-row-nm' }, fileSortBtn('이름', 'name', sort, setSort)),
        el('span', { class: 'dash-fb-row-sz' }, fileSortBtn('크기', 'size', sort, setSort)),
        el('span', { class: 'dash-fb-row-dt' }, fileSortBtn('수정 일시', 'mtime', sort, setSort)),
        el('span', { class: 'dash-fb-actions' })));
      for (const it of items) body.append(fbRow(it));
    }
    else { body = el('div', { class: 'proj-file-grid dash-fb-grid' }); for (const it of items) body.append(fbCard(it)); }
    container.replaceChildren(crumb, tools, body);
  };
  load();
  return container;
}


export {
  dashFolderBrowser,
  dashFolderCard,
  dashFolderRow,
  dashLockBadge,
  fillFolders,
  openFolderVisibilityForm,
};
// #1436 후속 — 미리보기 판정표·표 파서 재수출을 걷었다(전부 web/lib/file-preview.ts 소관이 됐고, 소비처는 셋 다 그쪽을
//  직접 문다). 여기 남는 재수출은 대시보드 고유 보조 둘뿐이다.
export { dashAuthFetch, wheelToHorizontal } from './widget-folders-preview.js';

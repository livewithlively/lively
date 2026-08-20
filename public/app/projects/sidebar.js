// projects/sidebar.ts — #1313 R34: web/projects.ts 분해 ⑤.
//  프로젝트 화면 **좌측 트리와 그 조작** — 리스트 그룹 빌드/렌더 · 리스트 설정·폴더 메뉴 · 공개범위 자물쇠 ·
//   폴더/휴지통/아카이브 드롭 타깃 · 들여쓰기 격자 · 폴더·리스트 이동/재정렬 · 즐겨찾기 · 리스트/폴더 삭제.
//  ⚠ 아카이브 lazy 생성(pjvEnsureArchiveFolder/pjvEnsureArchiveList)의 **진행 중 프라미스 dedup** 상태
//   (pjvArchiveEnsurePr·pjvArchiveListPr)는 이 파일이 단독 소유한다. ESM import 바인딩은 재할당할 수 없으므로
//   그 let 과 재할당하는 함수가 갈라지면 dedup 이 깨져 동시 드롭이 아카이브 폴더·리스트를 중복 생성한다.
//  ⚠ 즐겨찾기 리스트 캐시(pjvFavListCache)도 같은 이유로 여기 상주하고, 통째 교체는 setFavListCache 세터만 쓴다(R31 규약).
//  ※ 보드 조립부(pjvProjectListBoard 클로저의 buildTree/renderArea)는 #1313 R36 에서 projects/board.ts 로 나갔다 —
//   행·그룹 렌더러(pjvProjRow·pjvProjAddRow·pjvRenderStatusGroups·pjvProjTeamControl·pjvProjDelete·
//   pjvContainerCmp)는 R33 이 projects/rows.ts 로 가져갔으므로 **직결**로 받는다(배럴 경유 금지).
//   드래그 싱글턴(pjvSideDrag·pjvFolderDrag)은 #1404 에서 projects/state.ts 로 내려갔다 — 여기·board·rows·
//   selection 넷이 함께 읽는 **보기 상태**라 리프가 원래 집이고, 그 덕에 이 모듈의 배럴 되짚기가 사라졌다.
import { api, busy, el, sv, toast, visAxisOn } from '../core.js';
import { overlayBox } from '../learn.js';
import { pjvApplyToolbarFilters } from './filters.js';
import { pjvBundleIcon } from './icons.js';
import { PJV_LIST_COLORS, openFolderForm, openListForm, pjvFolderIsArchive, pjvFolderIsSpace, pjvHarmonizeColor, pjvListStatusEditor, pjvSaveListMembers } from './list-forms.js';
import { pjvPopover } from './popover.js';
import { pjvContainerCmp, pjvProjAddRow, pjvProjDelete, pjvProjRow, pjvProjTeamControl, pjvRenderStatusGroups } from './rows.js';
import { pjvBoardMineOnly, pjvFolderDrag, pjvListOpen, pjvProjClosedView, pjvSideDrag } from './state.js';
// 그룹 빌드 — 내 리스트(펼침) → 그 외 리스트(접힘) → 미분류('기타'). '내 할당만' 이면 내 프로젝트만 남기고 빈 그룹은 숨김.
function pjvBuildListGroups(projects, lists, mineIds, meId) {
    const byList = new Map();
    const unassigned = [];
    for (const p of projects) {
        if (p.list_id == null) {
            unassigned.push(p);
            continue;
        }
        if (!byList.has(p.list_id))
            byList.set(p.list_id, []);
        byList.get(p.list_id).push(p);
    }
    const isMyList = (l) => (l.members || []).some((m) => String(m.member_id) === String(meId));
    const sortLists = pjvContainerCmp; // #541 — 사이드바와 동일 비교자(sort → ClickUp orderindex → 이름)
    const my = [], other = [];
    for (const l of [...lists].sort(sortLists))
        (isMyList(l) ? my : other).push(l);
    const mineOnly = pjvBoardMineOnly.on;
    // '내 할당만' + 툴바 좁히기(#1067 필터·담당자·검색) — 사이드바 카운트·본문·개요가 모두 이 한 관문을 지난다.
    const filterProj = (arr) => pjvApplyToolbarFilters(mineOnly ? arr.filter((p) => mineIds.has(p.id)) : arr);
    const groups = [];
    const pushList = (l, defaultOpenWhenNotMine) => {
        const projs = filterProj(byList.get(l.id) || []);
        if (mineOnly && !projs.length)
            return; // 내 할당만: 빈 리스트 숨김
        const mine = isMyList(l);
        const key = 'L' + l.id;
        const open = pjvListOpen.has(key) ? pjvListOpen.get(key) : (mineOnly ? true : (mine || defaultOpenWhenNotMine));
        groups.push({ key, list: l, isMine: mine, projects: projs, open });
    };
    for (const l of my)
        pushList(l, true);
    for (const l of other)
        pushList(l, false);
    // 미분류('기타') — 프로젝트가 있으면 표시. 리스트가 하나도 없으면(=전부 미분류) 빈 상태라도 표시해 시작 add-row 노출.
    const unProjs = filterProj(unassigned);
    if (unProjs.length > 0 || (!mineOnly && lists.length === 0)) {
        const key = '__none__';
        const hasMine = unProjs.some((p) => mineIds.has(p.id));
        const open = pjvListOpen.has(key) ? pjvListOpen.get(key) : (mineOnly ? true : (lists.length === 0 || hasMine));
        groups.push({ key, list: null, isMine: false, projects: unProjs, open });
    }
    return groups;
}
// 리스트 한 그룹(접이식) — 헤더(캐럿·색점·이름·개수·내리스트칩 | 멤버 페이스파일·⋯) + 프로젝트 행들 + 인라인 추가행.
function pjvListGroup(g, reload, canDelete, fields, anchorId, meId, taskCtx, nested, bare, opts) {
    const list = g.list; // null = 미분류('기타')
    const isUn = !list;
    const name = isUn ? '기타 (미분류)' : list.name;
    const color = isUn ? 'var(--line)' : pjvHarmonizeColor(list.color || pjvListAutoColor(list.id));
    const members = isUn ? [] : (list.members || []);
    const listIdForAdd = isUn ? null : list.id;
    const emptyText = pjvBoardMineOnly.on ? '내가 할당된 프로젝트가 없습니다.' : '아직 프로젝트가 없습니다.';
    // 헤더 개수 — 완료는 Closed 일 때만 집계(보이는 것과 일치).
    const visibleCount = pjvProjClosedView.done ? g.projects.length : g.projects.filter((p) => p.status !== 'done').length;
    const bodyEl = el('div', { class: 'pjv-tgroup-body' });
    if (nested) {
        // 리스트 › 상태 — 상태 하위그룹. 리스트가 커스텀 상태면 그 상태들로, 아니면 표준 3버킷(#475). 각 그룹에 추가행.
        const mineOnly = pjvBoardMineOnly.on;
        const before = bodyEl.childElementCount;
        // 그룹 기준(#1067) — 폴더/스페이스 스코프에서도 툴바에서 고른 기준(상태·담당자·우선순위·마감일·태그)으로 묶는다.
        pjvRenderStatusGroups(bodyEl, g.projects, list, { reload, canDelete, fields, anchorId, meId, taskCtx, mineOnly, listIdForAdd, groupBy: opts && opts.groupBy });
        if (mineOnly && bodyEl.childElementCount === before)
            bodyEl.append(el('div', { class: 'pjv-proj-empty', text: emptyText }));
    }
    else {
        // 평면 — 완료는 Closed 토글일 때만. 정렬: 진행 중→할 일→완료, 같은 상태면 최신순.
        const rank = (p) => p.status === 'done' ? 2 : (p.status === 'todo' ? 1 : 0);
        const shown = g.projects
            .filter((p) => p.status !== 'done' || pjvProjClosedView.done)
            .slice()
            .sort((a, b) => rank(a) - rank(b) || (Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0)));
        for (const p of shown)
            bodyEl.append(pjvProjRow(p, reload, null, canDelete, fields, anchorId, taskCtx));
        if (!shown.length)
            bodyEl.append(el('div', { class: 'pjv-proj-empty', text: emptyText }));
        if (!pjvBoardMineOnly.on)
            bodyEl.append(pjvProjAddRow('in_progress', reload, bodyEl, null, fields, null, canDelete, anchorId, meId, taskCtx, listIdForAdd));
    }
    // bare — 영역 헤더 생략(단일 영역 선택 시 좌측 네비가 이미 그 영역을 강조 → 본문 헤더는 중복). 본문만 펼친 채 노출.
    if (bare) {
        bodyEl.hidden = false;
        return el('div', { class: 'pjv-tgroup pjv-list-group pjv-list-group-bare', 'data-list-id': isUn ? '' : String(list.id), style: '--list-color:' + color }, bodyEl);
    }
    let open = !!g.open;
    const gcaret = el('button', { class: 'pjv-tgroup-caret', type: 'button', text: open ? '▾' : '▸', 'aria-expanded': String(open) });
    bodyEl.hidden = !open;
    const setOpen = (o) => { open = o; pjvListOpen.set(g.key, o); gcaret.textContent = o ? '▾' : '▸'; gcaret.setAttribute('aria-expanded', String(o)); bodyEl.hidden = !o; };
    gcaret.onclick = (e) => { e.stopPropagation(); setOpen(!open); };
    const dot = isUn
        ? el('span', { class: 'pjv-list-dot', style: 'background:' + color, 'aria-hidden': 'true' })
        : el('span', { class: 'pjv-list-headglyph', 'aria-hidden': 'true' }, pjvListGlyph(list));
    const labelEl = el('span', { class: 'pjv-tgroup-label', text: name });
    const countEl = el('span', { class: 'pjv-tgroup-count', text: String(visibleCount) });
    const mineChip = g.isMine ? el('span', { class: 'pjv-list-mine-chip', title: '내가 참여한 리스트', text: '내 리스트' }) : null;
    const main = el('div', { class: 'pjv-list-head-main' }, gcaret, dot, labelEl, countEl, mineChip);
    // 실제 리스트만 멤버 페이스파일(클릭→멤버 관리, 조용히 저장) + ⋯(리스트 설정). 미분류는 액션 없음.
    const actions = el('div', { class: 'pjv-list-head-actions' });
    if (!isUn) {
        const memberCell = pjvProjTeamControl(members, (ids) => pjvSaveListMembers(list.id, ids));
        memberCell.classList.add('pjv-list-members');
        memberCell.title = '리스트 참여 멤버 (참여하면 이 리스트가 기본으로 펼쳐집니다)';
        actions.append(memberCell, pjvListMore(list, reload));
    }
    const headEl = el('div', { class: 'pjv-tgroup-head pjv-list-head' + (isUn ? ' pjv-list-head-un' : '') }, main, actions);
    headEl.addEventListener('click', (e) => {
        if (e.target.closest('button, .pjv-cell-btn, .pjv-menu, input'))
            return;
        setOpen(!open);
    });
    // 박스(#1067) — 폴더/스페이스를 열었을 때 리스트마다 테두리 카드로 감싼다(ClickUp 폴더 뷰). 헤더 위엔 그 리스트가
    //  어디 있는지 알려주는 작은 경로(스페이스 / 폴더)를 얹는다 — 여러 리스트가 한 화면에 쌓이면 이름만으론 구분이 안 된다.
    const boxed = !!(opts && opts.boxed);
    const crumb = opts && opts.crumb ? el('div', { class: 'pjv-list-box-crumb', text: opts.crumb }) : null;
    const groupEl = el('div', { class: 'pjv-tgroup pjv-list-group' + (boxed ? ' pjv-list-box' : ''), 'data-list-id': isUn ? '' : String(list.id), style: '--list-color:' + color }, ...(crumb ? [crumb] : []), headEl, bodyEl);
    // 이 폴더 구역 어디에 프로젝트를 놓아도 그 폴더로(미분류 그룹이면 null=미분류)(#454).
    pjvFolderDropTarget(groupEl, isUn ? null : list.id, reload);
    return groupEl;
}
// 리스트 설정 팝아웃(클릭업 List settings 의 필요 부분집합, #475) — 사이드바 리스트 ⋯ · 인라인 리스트 헤더 ⋯ 공용.
//  리스트 설정(이름·색·아이콘·멤버·공개범위) / 상태 체계 관리 / 폴더로 이동 / 프로젝트 관리 / 삭제. 라벨 간결화(#500).
function pjvListSettingsMenu(menu, close, list, reload, favCtx) {
    const mk = (label, fn, danger, sub) => {
        const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label }), sub ? el('span', { class: 'pjv-menu-caret', text: '›' }) : null);
        b.onclick = (e) => { e.stopPropagation(); if (sub) {
            fn();
        }
        else {
            close();
            fn();
        } };
        return b;
    };
    menu.append(el('div', { class: 'pjv-menu-head', text: list.name }));
    // ⭐ 즐겨찾기(#1115) — 사이드바 행 호버 별을 대체해 메뉴 맨 위로. 사이드바 호출부(favCtx)는 낙관적 트리 갱신(리로드 없음),
    //  그 외(인라인 그룹 헤더·브레드크럼 ⋯)는 모듈 캐시(pjvFavListCache)로 상태를 읽고 저장 후 리로드.
    //  라벨은 텍스트만 — 이 메뉴의 다른 항목이 전부 아이콘 없는 텍스트라, 여기만 ★/☆ 문자를 붙이면 좌측 정렬이 어긋나고
    //  이모지·문자 아이콘 혼용이 된다(디자인 시스템 금지). 별 표식은 사이드바 섹션 헤더·브레드크럼의 SVG 별이 담당한다.
    const isFav = favCtx ? favCtx.isFav : pjvFavListCache.has(Number(list.id));
    menu.append(mk(isFav ? '즐겨찾기 해제' : '즐겨찾기에 추가', () => {
        if (favCtx) {
            favCtx.onToggle(!isFav);
            return;
        }
        pjvSetFavorite('project_list', Number(list.id), !isFav)
            .then(() => { if (isFav)
            pjvFavListCache.delete(Number(list.id));
        else
            pjvFavListCache.add(Number(list.id)); if (reload)
            reload(); })
            .catch((e) => toast('즐겨찾기 저장 실패 — ' + (e && e.message || e), true));
    }));
    menu.append(mk('리스트 설정', () => openListForm(reload, list)));
    menu.append(mk('상태 체계 관리', () => pjvListStatusEditor(list, reload)));
    menu.append(mk('폴더로 이동', () => pjvListFolderSubmenu(menu, close, list, reload), false, true));
    menu.append(mk('프로젝트 관리', () => pjvManageFolderProjects(list, reload)));
    menu.append(el('div', { class: 'pjv-bulk-sep-h' }));
    menu.append(mk('리스트 삭제', () => pjvDeleteList(list, reload), true));
}
// '폴더로 이동' 하위 — 같은 팝오버 안에서 폴더 목록으로 교체(뒤로가기 포함). 폴더를 그 자리에서 fetch.
function pjvListFolderSubmenu(menu, close, list, reload) {
    const back = el('button', { class: 'pjv-menu-item pjv-menu-back', type: 'button' }, el('span', { class: 'pjv-menu-caret', text: '‹' }), el('span', { text: '뒤로' }));
    back.onclick = (e) => { e.stopPropagation(); menu.replaceChildren(); pjvListSettingsMenu(menu, close, list, reload); };
    busy(menu, back, el('div', { class: 'pjv-menu-head', text: '폴더로 이동' }), el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
    api('/api/ui/v6/project-folders').then((d) => {
        const folders = (d && d.folders) || [];
        menu.replaceChildren(back, el('div', { class: 'pjv-menu-head', text: '폴더로 이동' }));
        const mkItem = (label, folderId, color) => {
            const cur = (list.folder_id == null ? folderId == null : String(list.folder_id) === String(folderId));
            const item = el('button', { class: 'pjv-menu-item' + (cur ? ' sel' : ''), type: 'button' }, color !== undefined ? pjvBundleIcon(color, folderId == null ? 'none' : undefined) : null, el('span', { class: 'pjv-asg-mname', text: label }), el('span', { class: 'pjv-asg-check', text: cur ? '✓' : '' }));
            item.onclick = async (e) => {
                e.stopPropagation();
                close();
                if (cur)
                    return;
                try {
                    await api('/api/ui/v6/project-lists/' + list.id + '/folder', { method: 'POST', body: JSON.stringify({ folder_id: folderId }) });
                    toast(folderId == null ? '폴더에서 뺐습니다' : '폴더로 옮겼습니다');
                    if (reload)
                        reload();
                }
                catch (err) {
                    toast('이동 실패 — ' + err.message, true);
                }
            };
            return item;
        };
        // '폴더 없음(최상위)' 선택지 폐지(#1067) — 리스트는 항상 어느 스페이스·폴더 안에 있어야 한다.
        for (const f of folders)
            if (!pjvFolderIsArchive(f))
                menu.append(mkItem(f.name, f.id, f.color || 'var(--muted-2)'));
        const addNew = el('button', { class: 'pjv-menu-item pjv-sess-add', type: 'button' }, el('span', { class: 'pjv-sess-add-ico', text: '＋' }), el('span', { text: '새 폴더…' }));
        addNew.onclick = (e) => { e.stopPropagation(); close(); openFolderForm(reload); };
        menu.append(el('div', { class: 'pjv-bulk-sep-h' }), addNew);
    }).catch((err) => menu.replaceChildren(back, el('div', { class: 'pjv-menu-empty', text: '폴더를 불러오지 못했어요 — ' + err.message })));
}
// 인라인 리스트 그룹 헤더의 ⋯ — 리스트 설정 팝아웃.
function pjvListMore(list, reload) {
    const btn = el('button', { class: 'pjv-trow-more', type: 'button', title: '리스트 설정', 'aria-label': '리스트 설정', text: '⋯' });
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu pjv-listset-menu' });
        const close = pjvPopover(btn, menu);
        pjvListSettingsMenu(menu, close, list, reload);
    };
    return btn;
}
// 리스트 글리프(사이드바) — settings.icon 이모지가 있으면 그것, 없으면 리스트 색의 체크리스트 글리프(클릭업 List 아이콘).
// 리스트 자동 색(#1067) — 색을 안 정한 리스트의 기본색. 예전 avatarColor 는 hsl(임의 hue, 50%, 60%) 라
//  형광 연두·탁한 자주 같은 게 섞여 상태 칩(슬레이트·앰버·그린)과 나란히 두면 튀었다.
//  이미 쓰고 있는 '차분한 톤' 팔레트(PJV_FIELD_PALETTE — 커스텀 필드 옵션 색)에서 id 로 결정적으로 고른다.
function pjvListAutoColor(id) {
    const n = Math.abs(Number(id) || 0);
    return PJV_LIST_COLORS[n % PJV_LIST_COLORS.length];
}
// 공개범위 배지(#1291) — 대상이 제한된 리스트·스페이스에 자물쇠를 붙인다.
//  잠긴 것과 안 잠긴 것을 한눈에 구분하지 못하면 "이건 전사 공개인가?"를 매번 설정 화면을 열어 확인해야 한다.
function pjvVisLock(row) {
    if (!row)
        return null;
    // 축이 꺼져 있으면 자물쇠를 그리지 않는다(#1291). visibility 값은 DB 에 남아 있지만 **지금은 강제되지 않으므로**
    //  배지를 붙이면 "일부만 본다"고 거짓말하는 셈이다(실제로는 전원이 본다). 다시 켜면 배지도 함께 돌아온다.
    if (!visAxisOn('project'))
        return null;
    // locked(#1291 v2) = 관리자에게만 오는 '존재는 보이되 내용은 안 보이는' 행. 이걸 안 그리면 관리자는
    //  **아무 설명 없이 비어 있는 리스트**를 보게 된다(대상이 아니라서 프로젝트가 안 실린 것인데, 고장으로 읽힌다).
    if (row.locked) {
        return el('span', {
            class: 'pjv-side-lock pjv-side-lock-hidden',
            title: '내용 비공개 — 관리자도 내용은 볼 수 없어요. 필요하면 긴급 열람을 사유와 함께 여세요.',
            'aria-label': '내용 비공개', text: '🔒',
        });
    }
    if (row.visibility !== 'members')
        return null;
    return el('span', { class: 'pjv-side-lock', title: '공개범위 제한 — 지정한 사람에게만 보여요', 'aria-label': '공개범위 제한', text: '🔒' });
}
function pjvListGlyph(list) {
    const emoji = list && list.settings && list.settings.icon;
    if (emoji)
        return el('span', { class: 'pjv-side-listemoji', text: String(emoji) });
    const color = pjvHarmonizeColor((list && list.color) || pjvListAutoColor(list ? list.id : 0));
    const n = sv('svg', { class: 'pjv-side-listglyph', viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    n.append(sv('path', { d: 'M4 7l1.6 1.6L8.4 5.6' }), sv('path', { d: 'M11 7h9' }), sv('path', { d: 'M4 15l1.6 1.6L8.4 13.6' }), sv('path', { d: 'M11 15h9' }));
    return n;
}
// 폴더에 프로젝트 넣고 빼기 모달(#454) — 이 폴더의 프로젝트(빼기) + 다른 프로젝트 검색해 추가. 이동은 즉시 반영 + 보드 리로드.
//  검색 입력은 고정하고 목록 컨테이너만 다시 그린다(타이핑 중 포커스 유지).
function pjvManageFolderProjects(list, reload) {
    let all = [];
    const inHead = el('div', { class: 'pjv-foldman-sec-h' });
    const inList = el('div', { class: 'pjv-foldman-list' });
    const otherList = el('div', { class: 'pjv-foldman-list' });
    const searchIn = el('input', { type: 'text', class: 'proj-mp-search', placeholder: '프로젝트 이름으로 검색해 추가…' });
    const move = async (p, listId) => {
        try {
            await api('/api/ui/v6/projects/' + p.id + '/list', { method: 'POST', body: JSON.stringify({ list_id: listId }) });
            p.list_id = listId;
            toast(listId == null ? '리스트에서 뺐습니다' : '이 리스트에 넣었습니다');
            paint();
            if (reload)
                reload();
        }
        catch (e) {
            toast('이동 실패 — ' + e.message, true);
        }
    };
    const paint = () => {
        const inFolder = all.filter((p) => String(p.list_id) === String(list.id));
        inHead.textContent = '이 리스트의 프로젝트 (' + inFolder.length + ')';
        inList.replaceChildren(...(inFolder.length
            ? inFolder.map((p) => el('div', { class: 'pjv-foldman-row' }, el('span', { class: 'pjv-foldman-name' + (p.status === 'done' ? ' done' : ''), text: p.name }), el('button', { class: 'pjv-foldman-btn', type: 'button', text: '빼기', onclick: () => move(p, null) })))
            : [el('div', { class: 'pjv-menu-empty', text: '이 리스트에 든 프로젝트가 없어요. 아래에서 추가하세요.' })]));
        const q = searchIn.value.trim().toLowerCase();
        const others = all.filter((p) => String(p.list_id) !== String(list.id) && (!q || (p.name || '').toLowerCase().includes(q)));
        otherList.replaceChildren(...(others.length
            ? others.slice(0, 50).map((p) => el('div', { class: 'pjv-foldman-row' }, el('span', { class: 'pjv-foldman-name' + (p.status === 'done' ? ' done' : ''), text: p.name }), p.list_id != null ? el('span', { class: 'pjv-foldman-cur', text: '다른 리스트' }) : null, el('button', { class: 'pjv-foldman-btn add', type: 'button', text: '＋ 추가', onclick: () => move(p, list.id) })))
            : [el('div', { class: 'pjv-menu-empty', text: q ? '일치하는 프로젝트가 없어요.' : '추가할 프로젝트가 없어요.' })]));
    };
    searchIn.addEventListener('input', paint);
    const box = el('div', { class: 'pjv-foldman' }, inHead, inList, el('div', { class: 'pjv-foldman-sec-h', style: 'margin-top:16px', text: '리스트에 추가' }), searchIn, otherList);
    const back = overlayBox('‘' + list.name + '’ 리스트 — 프로젝트 넣고 빼기', box, el('div', { class: 'ov-actions' }, el('button', { class: 'btn btn-ghost', text: '닫기', onclick: () => back.remove() })));
    inList.append(el('div', { class: 'pjv-menu-empty', text: '불러오는 중…' }));
    api('/api/ui/v6/projects').then((d) => { all = (d && d.projects) || []; paint(); setTimeout(() => searchIn.focus(), 0); })
        .catch((e) => inList.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '프로젝트를 불러오지 못했어요 — ' + e.message })));
    return back;
}
// 폴더 드롭 타깃 배선(#454) — elm 에 프로젝트 행 드래그를 받아 targetListId(폴더 id | null=미분류)로 이동한다.
//  진행 중인 폴더-드래그(pjvFolderDrag.id)가 있을 때만 반응 — 첨부파일 등 다른 드롭과 안 섞이게.
function pjvFolderDropTarget(elm, targetListId, reload) {
    const over = (ev) => { if (pjvFolderDrag.id == null)
        return; ev.preventDefault(); try {
        ev.dataTransfer.dropEffect = 'move';
    }
    catch (_) { /* */ } elm.classList.add('pjv-folder-drop-over'); };
    elm.addEventListener('dragover', over);
    elm.addEventListener('dragenter', over);
    elm.addEventListener('dragleave', (ev) => { if (!elm.contains(ev.relatedTarget))
        elm.classList.remove('pjv-folder-drop-over'); });
    elm.addEventListener('drop', (ev) => {
        elm.classList.remove('pjv-folder-drop-over');
        if (pjvFolderDrag.id == null)
            return;
        ev.preventDefault();
        ev.stopPropagation();
        const pid = pjvFolderDrag.id;
        pjvFolderDrag.id = null;
        api('/api/ui/v6/projects/' + pid + '/list', { method: 'POST', body: JSON.stringify({ list_id: targetListId }) })
            .then(() => { toast(targetListId == null ? '미분류로 옮겼습니다' : '리스트로 옮겼습니다'); if (reload)
            reload(); })
            .catch((e) => toast('이동 실패 — ' + e.message, true));
    });
}
// 휴지통 드롭 타깃(#1020) — 사이드바에서 끌던 리스트·폴더·프로젝트를 이 항목 위에 놓으면 삭제(휴지통 이동)한다.
//  드래그 종류가 둘로 갈린다: 리스트/폴더는 pjvSideDrag(kind), 프로젝트는 pjvFolderDrag(id). 어느 쪽이든 반응.
//  삭제는 각자의 기존 확인 절차를 그대로 거친다 — 리스트=cascade 모달(pjvDeleteList), 폴더=confirm(pjvDeleteFolder),
//  프로젝트=confirm(pjvProjDelete). 실수 드롭도 확인에서 막힌다. 놓을 수 있을 때만 빨강(파괴적) 하이라이트.
//  드롭 처리는 setTimeout 로 미뤄 dragend 가 먼저 드래그 스타일을 정리하게 한다(모달·confirm 뒤 잔상 방지).
function pjvTrashDropTarget(elm, lists, folderList, reload) {
    const canDrop = () => pjvFolderDrag.id != null || pjvSideDrag.kind === 'list' || pjvSideDrag.kind === 'folder';
    const over = (ev) => {
        if (!canDrop())
            return;
        ev.preventDefault();
        ev.stopPropagation();
        try {
            ev.dataTransfer.dropEffect = 'move';
        }
        catch (_) { /* */ }
        elm.classList.add('pjv-side-trash-over');
    };
    elm.addEventListener('dragover', over);
    elm.addEventListener('dragenter', over);
    elm.addEventListener('dragleave', (ev) => { if (!elm.contains(ev.relatedTarget))
        elm.classList.remove('pjv-side-trash-over'); });
    elm.addEventListener('drop', (ev) => {
        elm.classList.remove('pjv-side-trash-over');
        if (!canDrop())
            return;
        ev.preventDefault();
        ev.stopPropagation(); // 링크(#/trash) 이동·treeWrap 최상위 이동 폴백을 막는다
        // 프로젝트 드롭 — pjvFolderDrag 에서 id·name 을 꺼내 확인 후 삭제.
        if (pjvFolderDrag.id != null) {
            const proj = { id: pjvFolderDrag.id, name: pjvFolderDrag.name };
            pjvFolderDrag.id = null;
            pjvFolderDrag.name = null;
            setTimeout(() => pjvProjDelete(proj, reload), 0);
            return;
        }
        // 리스트/폴더 드롭 — pjvSideDrag 에서 대상 id 를 꺼내 원본 객체를 찾아(카운트·이름 필요) 확인 후 삭제.
        const kind = pjvSideDrag.kind;
        const id = pjvSideDrag.id;
        pjvSideDrag.kind = null;
        pjvSideDrag.id = null;
        pjvSideDrag.folderId = null;
        if (kind === 'list') {
            const l = (lists || []).find((x) => String(x.id) === String(id));
            if (l)
                setTimeout(() => pjvDeleteList(l, reload), 0);
        }
        else if (kind === 'folder') {
            const f = (folderList || []).find((x) => String(x.id) === String(id));
            if (f)
                setTimeout(() => pjvDeleteFolder(f, reload), 0);
        }
    });
}
// ── 사이드바 파일탐색기 DnD(#473 후속) — 리스트(=파일)를 폴더로 넣기/빼기, 폴더 순서 재정렬. ──
//  리스트 이동: POST project-lists/:id/folder {folder_id} · 폴더 재정렬: POST project-folders/:id {sort} 일괄.
function pjvMoveListToFolder(listId, folderId, reload) {
    api('/api/ui/v6/project-lists/' + listId + '/folder', { method: 'POST', body: JSON.stringify({ folder_id: folderId }) })
        .then(() => { toast(folderId == null ? '폴더에서 뺐어요' : '폴더로 옮겼어요'); if (reload)
        reload(); })
        .catch((e) => toast('이동 실패 — ' + e.message, true));
}
// 주어진 순서(id 배열)대로 폴더 sort 를 일괄 저장(#541 — 배치 엔드포인트, 서버가 1..n 재부여) 후 재렌더.
function pjvReorderFolders(orderedIds, reload) {
    api('/api/ui/v6/project-folders-reorder', { method: 'POST', body: JSON.stringify({ ids: orderedIds }) })
        .then(() => { if (reload)
        reload(); })
        .catch((e) => toast('폴더 순서 저장 실패 — ' + e.message, true));
}
// 사이드바 들여쓰기 격자(#1067) — 스페이스·폴더·리스트·검색결과가 **한 격자**를 쓴다(예전엔 폴더 14px 계단 +
//  리스트 .sub 30px 특례로 단이 어긋나 위계 세로선이 격자처럼 어색했다). 깊이 d → 왼쪽 여백 PJV_SIDE_PAD + d*PJV_SIDE_STEP.
//  같은 값으로 세로선 개수(--pjv-guide-n = 조상 수)도 실어 CSS 가 선을 긋는다(선 x = 부모 아이콘 중심).
const PJV_SIDE_PAD = 10; // 깊이 0 항목의 왼쪽 여백(= .pjv-side-navitem 기본 padding)
const PJV_SIDE_STEP = 18; // 한 단 들여쓰기 — 선(부모 아이콘 중심 19px)과 자식 아이콘 사이에 9px 숨통
function pjvSideIndent(elm, depth, extra = 0) {
    if (depth > 0 || extra)
        elm.style.paddingLeft = `${PJV_SIDE_PAD + depth * PJV_SIDE_STEP + extra}px`;
    elm.style.setProperty('--pjv-guide-n', String(depth));
}
// ── 📦 아카이브(#1067) — 사이드바 맨 아래 고정 폴더. '다 지난' 리스트·폴더·프로젝트를 끌어다 치워두는 곳. ──
//  휴지통과 나란히 있지만 성격이 반대다: 삭제가 아니라 **이동**이다. 실체는 그냥 폴더(project_folder, settings.kind='archive')라
//  끌어내면 원상복귀되고, 백엔드는 이 폴더에 한해 스페이스도 하위로 받는다(folder-store.folderIsArchive).
//  대신 아카이브 안의 것들은 사이드바 트리와 보드(상태·평면·칸반·리스트별)에서 통째로 빠져 평소 화면이 깨끗해진다 —
//  아카이브 항목을 직접 열었을 때만 보인다.
const PJV_ARCHIVE_FOLDER_NAME = '아카이브';
const PJV_ARCHIVE_LIST_NAME = '지난 프로젝트';
// 아카이브 폴더 한 개 — 어쩌다 여럿이 생겨도(동시 생성) 가장 오래된 것(최소 id) 하나만 고정 폴더로 채택한다.
function pjvFindArchiveFolder(folders) {
    const cands = (folders || []).filter(pjvFolderIsArchive);
    return cands.length ? cands.reduce((a, b) => (Number(a.id) <= Number(b.id) ? a : b)) : null;
}
// 아카이브 폴더 + 그 하위 폴더 전부의 id — 트리·보드에서 '아카이브 안'을 통째로 판정하는 데 쓴다.
function pjvArchiveFolderIds(folders, archive) {
    const ids = new Set();
    if (!archive)
        return ids;
    ids.add(Number(archive.id));
    let grew = true;
    while (grew) { // 깊이 제한 없이 — 폴더 수가 적어 반복 훑기로 충분(부모 순서 무관).
        grew = false;
        for (const f of (folders || [])) {
            if (f.parent_id != null && ids.has(Number(f.parent_id)) && !ids.has(Number(f.id))) {
                ids.add(Number(f.id));
                grew = true;
            }
        }
    }
    return ids;
}
// 아카이브 폴더 확보 — 없으면 그 자리에서 만든다(첫 드롭 때 생성). 동시 드롭이 두 개를 만들지 않게 진행 중 프로미스를 공유.
let pjvArchiveEnsurePr = null;
function pjvEnsureArchiveFolder(known) {
    if (known && known.id)
        return Promise.resolve(known);
    if (!pjvArchiveEnsurePr) {
        pjvArchiveEnsurePr = api('/api/ui/v6/project-folders')
            .then((d) => pjvFindArchiveFolder((d && d.folders) || [])
            || api('/api/ui/v6/project-folders', { method: 'POST', body: JSON.stringify({ name: PJV_ARCHIVE_FOLDER_NAME, kind: 'archive' }) }).then((r) => (r && r.folder) || r))
            .finally(() => { pjvArchiveEnsurePr = null; });
    }
    return pjvArchiveEnsurePr;
}
// 아카이브 안 '지난 프로젝트' 리스트 확보 — 프로젝트는 폴더에 직접 못 들어가고(프로젝트 ▸ 리스트 소속) 리스트가 있어야 한다.
//  화면의 stale 목록 대신 매번 서버 목록으로 찾는다(중복 생성 방지). 동시 드롭은 프로미스 공유로 한 번만 만든다.
let pjvArchiveListPr = null;
function pjvEnsureArchiveList(archive) {
    if (!pjvArchiveListPr) {
        pjvArchiveListPr = api('/api/ui/v6/project-lists')
            .then((d) => {
            const hit = ((d && d.lists) || []).find((l) => String(l.folder_id) === String(archive.id) && l.name === PJV_ARCHIVE_LIST_NAME);
            if (hit)
                return hit;
            return api('/api/ui/v6/project-lists', { method: 'POST', body: JSON.stringify({ name: PJV_ARCHIVE_LIST_NAME }) })
                .then((r) => {
                const l = (r && r.list) || r;
                return api('/api/ui/v6/project-lists/' + l.id + '/folder', { method: 'POST', body: JSON.stringify({ folder_id: archive.id }) }).then(() => l);
            });
        })
            .finally(() => { pjvArchiveListPr = null; });
    }
    return pjvArchiveListPr;
}
// 아카이브 드롭 타깃(#1067) — 사이드바에서 끌던 리스트·폴더·프로젝트를 놓으면 아카이브로 옮긴다.
//  휴지통(pjvTrashDropTarget)과 같은 두 드래그 상태를 받고(리스트·폴더=pjvSideDrag / 프로젝트=pjvFolderDrag),
//  같은 배선 주의점을 따른다: dragover·drop 에서 preventDefault+stopPropagation 로 treeWrap 의 '최상위로' 폴백을 막는다.
//  파괴적이지 않으므로 확인 없이 바로 옮기고(되돌리기는 다시 끌어내기), 하이라이트도 danger 빨강이 아닌 이동(파랑) 계열.
function pjvArchiveDropTarget(elm, ctx) {
    const canDrop = () => pjvFolderDrag.id != null || pjvSideDrag.kind === 'list' || pjvSideDrag.kind === 'folder';
    const over = (ev) => {
        if (!canDrop())
            return;
        ev.preventDefault();
        ev.stopPropagation();
        try {
            ev.dataTransfer.dropEffect = 'move';
        }
        catch (_) { /* */ }
        elm.classList.add('pjv-side-archive-over');
    };
    elm.addEventListener('dragover', over);
    elm.addEventListener('dragenter', over);
    elm.addEventListener('dragleave', (ev) => { if (!elm.contains(ev.relatedTarget))
        elm.classList.remove('pjv-side-archive-over'); });
    elm.addEventListener('drop', (ev) => {
        elm.classList.remove('pjv-side-archive-over');
        if (!canDrop())
            return;
        ev.preventDefault();
        ev.stopPropagation();
        const done = (msg) => { toast(msg); if (ctx.reload)
            ctx.reload(); };
        const fail = (e) => toast('아카이브로 옮기지 못했어요 — ' + (e && e.message || e), true);
        // 프로젝트 — 아카이브 안 '지난 프로젝트' 리스트로. 리스트가 없으면 폴더·리스트를 그 자리에서 만든다.
        if (pjvFolderDrag.id != null) {
            const pid = pjvFolderDrag.id;
            pjvFolderDrag.id = null;
            pjvFolderDrag.name = null;
            pjvEnsureArchiveFolder(ctx.archive())
                .then((a) => pjvEnsureArchiveList(a))
                .then((l) => api('/api/ui/v6/projects/' + pid + '/list', { method: 'POST', body: JSON.stringify({ list_id: l.id }) }))
                .then(() => done('아카이브로 옮겼어요'))
                .catch(fail);
            return;
        }
        const kind = pjvSideDrag.kind;
        const id = pjvSideDrag.id;
        pjvSideDrag.kind = null;
        pjvSideDrag.id = null;
        pjvSideDrag.folderId = null;
        if (kind === 'list') {
            pjvEnsureArchiveFolder(ctx.archive())
                .then((a) => api('/api/ui/v6/project-lists/' + id + '/folder', { method: 'POST', body: JSON.stringify({ folder_id: a.id }) }))
                .then(() => done('아카이브로 옮겼어요')).catch(fail);
        }
        else if (kind === 'folder') {
            const cur = ctx.archive();
            if (cur && String(cur.id) === String(id)) {
                toast('아카이브 폴더 자신은 옮길 수 없어요', true);
                return;
            }
            pjvEnsureArchiveFolder(cur)
                .then((a) => api('/api/ui/v6/project-folders/' + id, { method: 'POST', body: JSON.stringify({ parent_id: a.id }) }))
                .then(() => done('아카이브로 옮겼어요')).catch(fail);
        }
    });
}
// 폴더를 스페이스/폴더 하위로 이동(parentId=null 이면 최상위로) — parent_id 패치. #766
function pjvMoveFolderToParent(folderId, parentId, reload) {
    api('/api/ui/v6/project-folders/' + folderId, { method: 'POST', body: JSON.stringify({ parent_id: parentId }) })
        .then(() => { toast(parentId == null ? '최상위로 옮겼어요' : '스페이스로 옮겼어요'); if (reload)
        reload(); })
        .catch((e) => toast('이동 실패 — ' + e.message, true));
}
// 리스트 사이드바 순서 저장(#541) — 같은 폴더 형제의 새 순서(id 배열)를 배치 저장(sort=1..n).
function pjvReorderLists(orderedIds, reload) {
    api('/api/ui/v6/project-lists-reorder', { method: 'POST', body: JSON.stringify({ ids: orderedIds }) })
        .then(() => { if (reload)
        reload(); })
        .catch((e) => toast('리스트 순서 저장 실패 — ' + e.message, true));
}
// movingId 를 targetId '앞(after=false)/뒤(after=true)'에 옮긴 새 순서 배열.
function pjvMoveNear(ids, movingId, targetId, after) {
    const rest = ids.filter((x) => String(x) !== String(movingId));
    const idx = rest.findIndex((x) => String(x) === String(targetId));
    if (idx < 0)
        return ids;
    rest.splice(idx + (after ? 1 : 0), 0, movingId);
    return rest;
}
// 즐겨찾기 토글 저장(#670) — 서버 POST(/api/ui/v6/favorites). WIKI 사이드바도 동일 엔드포인트 공유.
function pjvSetFavorite(kind, id, on) {
    return api('/api/ui/v6/favorites', { method: 'POST', body: JSON.stringify({ kind, id, on }) });
}
// 즐겨찾기 리스트 id 캐시(#1115) — renderArea 가 로드마다 채우고, 사이드바 밖 ⋯ 메뉴 호출부(인라인 그룹 헤더·브레드크럼)가
//  현재 즐겨찾기 상태를 읽는다. (구 pjvFavStar 행 호버 별은 #1115 로 제거 — 토글은 pjvListSettingsMenu 항목으로.)
let pjvFavListCache = new Set();
// 통째 교체의 유일한 창구(#1313 R31) — 캐시를 세우는 쪽은 보드 렌더다. 세터를 거치게 해 두면 보드가 별도 모듈로
//  떨어져도(ESM import 바인딩은 재할당 불가) 호출부를 그대로 둘 수 있다.
function setFavListCache(v) { pjvFavListCache = v; }
// 사이드바 즐겨찾기 구역 접힘(#1113 후속) — 기본 펼침, 사용자가 접으면 localStorage 로 유지(폴더 접힘이 세션 Map 인 것과 달리
//  이 구역은 '늘 맨 위'라 새로고침마다 되살아나면 거슬린다).
function pjvFavSecOpen() {
    try {
        return localStorage.getItem('pjv:favSecOpen') !== '0';
    }
    catch (_) {
        return true;
    }
}
function pjvSetFavSecOpen(open) {
    try {
        localStorage.setItem('pjv:favSecOpen', open ? '1' : '0');
    }
    catch (_) { /* noop */ }
}
// 사이드바 항목 드롭 타깃 — 진행 중인 사이드바 드래그(pjvSideDrag)에만 반응.
//  같은 형제 재정렬(handlers.reorderList/reorderFolder 가 true)이면 커서 위/아래 절반으로 '앞/뒤' 가로 삽입선(#670,
//  어디 들어갈지 직관적), 아니면(폴더로 넣기 등) 종전 폴더 하이라이트. onList/onFolder(id, after) 로 위치 전달.
function pjvSideNavDrop(elm, handlers) {
    const clearMarks = () => elm.classList.remove('pjv-side-drop-over', 'pjv-side-drop-before', 'pjv-side-drop-after', 'pjv-side-drop-outdent');
    const over = (ev) => {
        if (!pjvSideDrag.kind)
            return;
        ev.preventDefault();
        // ⚠ 이 항목이 유효한 드롭 타깃이므로 컨테이너(treeWrap)의 dragover 로 **버블링을 막는다**(#1067 버그 수정).
        //  treeWrap 은 '빈 곳에 리스트 드롭'을 막으려고 리스트 드래그 중 dropEffect='none' 을 거는데, 버블링 순서상
        //  자식보다 **나중에** 실행돼 여기서 세운 'move' 를 덮어쓴다. 그러면 브라우저가 드롭을 불허해 네이티브 drop 이벤트가
        //  아예 안 떠 폴더 넣기·재정렬이 '반영 안 됨'으로 보였다(합성 이벤트는 이 판정을 안 거쳐 통과했다).
        ev.stopPropagation();
        try {
            ev.dataTransfer.dropEffect = 'move';
        }
        catch (_) { /* */ }
        const id = pjvSideDrag.id;
        const canReorder = pjvSideDrag.kind === 'list' ? !!(handlers.reorderList && handlers.reorderList(id))
            : pjvSideDrag.kind === 'folder' ? !!(handlers.reorderFolder && handlers.reorderFolder(id)) : false;
        clearMarks();
        const r = elm.getBoundingClientRect();
        const half = (ev.clientY - r.top) > r.height / 2 ? 'pjv-side-drop-after' : 'pjv-side-drop-before';
        // 인라인 아웃덴트(#670, VS Code식) — 폴더 '안' 리스트를 드래그하는 중(pjvSideDrag.folderId != null)에 커서 X 를 항목 왼쪽
        //  들여쓰기 영역(< PJV_OUTDENT_PX)으로 끌면 '폴더 밖 최상위'로 빼기. 삽입선을 최상위 들여쓰기로 당기고 세로 가이드 표시.
        //  (예전의 '여기로 끌어 폴더 밖으로 빼기' 드롭존 박스를 대체 — 별도 박스 없이 자연스러운 가로 인라인 레벨.)
        if (pjvSideDrag.kind === 'list' && handlers.onOutdent && pjvSideDrag.folderId != null && (ev.clientX - r.left) < PJV_OUTDENT_PX) {
            elm.classList.add('pjv-side-drop-outdent', half);
            return;
        }
        if (canReorder)
            elm.classList.add(half);
        else
            elm.classList.add('pjv-side-drop-over');
    };
    elm.addEventListener('dragover', over);
    elm.addEventListener('dragenter', over);
    elm.addEventListener('dragleave', (ev) => { if (!elm.contains(ev.relatedTarget))
        clearMarks(); });
    elm.addEventListener('drop', (ev) => {
        const isOutdent = elm.classList.contains('pjv-side-drop-outdent');
        const after = elm.classList.contains('pjv-side-drop-after');
        clearMarks();
        if (!pjvSideDrag.kind)
            return;
        ev.preventDefault();
        ev.stopPropagation();
        const kind = pjvSideDrag.kind;
        const id = pjvSideDrag.id;
        pjvSideDrag.kind = null;
        pjvSideDrag.id = null;
        pjvSideDrag.folderId = null;
        if (kind === 'list' && isOutdent && handlers.onOutdent) {
            handlers.onOutdent(id);
            return;
        }
        if (kind === 'list' && handlers.onList)
            handlers.onList(id, after);
        else if (kind === 'folder' && handlers.onFolder)
            handlers.onFolder(id, after);
    });
}
const PJV_OUTDENT_PX = 30; // 아웃덴트 트리거 — 항목 왼쪽 이만큼(px) 안으로 커서가 들어오면 '폴더 밖'으로 해석(#670).
// 리스트 삭제 확인 — 우리 디자인 모달(#732). 브라우저 confirm() 대신 overlayBox + 스위치 카드.
//  '리스트 안의 프로젝트도 함께 삭제'를 토글로 물어 선택대로 수행: OFF(기본)=리스트만 삭제하고 프로젝트는
//  ‘기타(미분류)’로 이동해 보존 / ON=cascade_projects 로 프로젝트(하위 태스크 포함)까지 삭제(휴지통에서 복원 가능).
function pjvDeleteList(list, reload) {
    const count = Number.isFinite(Number(list && list.project_count)) ? Number(list.project_count) : 0;
    let cascade = false;
    const hint = el('div', { class: 'pjv-dellist-note' });
    const paintHint = () => {
        hint.textContent = count === 0
            ? '이 리스트에는 프로젝트가 없어요. 리스트만 삭제합니다.'
            : (cascade
                ? '리스트와 그 안의 프로젝트 ' + count + '개를 모두 삭제해요. 휴지통(#/trash)에서 되살릴 수 있어요.'
                : '리스트만 삭제하고, 프로젝트 ' + count + '개는 ‘기타(미분류)’로 옮겨 보존해요.');
    };
    // '함께 삭제' 스위치 카드 — openListForm 공개범위 토글과 동일한 pjv-visrow/pjv-switch 결(우리 디자인).
    const sw = el('span', { class: 'pjv-switch', 'aria-hidden': 'true' }, el('span', { class: 'pjv-switch-knob' }));
    const toggleRow = el('div', { class: 'pjv-visrow', role: 'switch', tabindex: '0', 'aria-checked': 'false' }, el('span', { class: 'pjv-visrow-txt' }, el('span', { class: 'pjv-visrow-title', text: '리스트 안의 프로젝트도 함께 삭제' }), el('span', { class: 'pjv-visrow-hint', text: '끄면 프로젝트는 ‘기타(미분류)’로 옮겨져 보존돼요.' })), sw);
    const delBtn = el('button', { class: 'btn btn-danger' });
    const updateBtn = () => { delBtn.textContent = (cascade && count > 0) ? '리스트·프로젝트 삭제' : '리스트 삭제'; };
    const toggle = () => {
        cascade = !cascade;
        toggleRow.classList.toggle('on', cascade);
        sw.classList.toggle('on', cascade);
        toggleRow.setAttribute('aria-checked', cascade ? 'true' : 'false');
        paintHint();
        updateBtn();
    };
    toggleRow.onclick = (e) => { e.stopPropagation(); toggle(); };
    toggleRow.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
    } });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
    const body = el('div', { class: 'pjv-dellist' }, el('p', { class: 'pjv-dellist-lead' }, el('span', { class: 'pjv-dellist-name', text: '‘' + list.name + '’' }), ' 리스트를 삭제할까요?'), count > 0 ? toggleRow : null, hint);
    let busy = false;
    const go = async () => {
        if (busy)
            return;
        busy = true;
        delBtn.disabled = true;
        cancelBtn.disabled = true;
        try {
            await api('/api/ui/v6/project-lists/' + list.id + '/delete', { method: 'POST', body: JSON.stringify({ cascade_projects: cascade }) });
            back.remove();
            toast((cascade && count > 0) ? '리스트와 프로젝트 ' + count + '개를 삭제했습니다' : '리스트를 삭제했습니다');
            if (reload)
                reload();
        }
        catch (e) {
            toast('삭제 실패 — ' + e.message, true);
            busy = false;
            delBtn.disabled = false;
            cancelBtn.disabled = false;
        }
    };
    delBtn.onclick = go;
    const back = overlayBox('리스트 삭제', body, el('div', { class: 'ov-actions' }, delBtn, cancelBtn));
    const boxEl = back.querySelector('.ov-box');
    if (boxEl)
        boxEl.classList.add('pjv-modal-narrow');
    paintHint();
    updateBtn();
    setTimeout(() => cancelBtn.focus(), 0);
    return back;
}
// ── 폴더(project_folder) CRUD·메뉴(#475) — 폴더는 정리용(멤버·권한 없음). 리스트를 담아 사이드바에서 폴더›리스트로. ──
function pjvFolderTreeMenu(menu, close, folder, reload) {
    const mk = (label, fn, danger) => { const b = el('button', { class: 'pjv-menu-item' + (danger ? ' danger' : ''), type: 'button' }, el('span', { text: label })); b.onclick = (e) => { e.stopPropagation(); close(); fn(); }; return b; };
    const isSpace = pjvFolderIsSpace(folder); // #766 스페이스면 메뉴 문구·항목이 달라진다
    const kindLabel = isSpace ? '스페이스' : '폴더';
    menu.append(el('div', { class: 'pjv-menu-head', text: folder.name }));
    menu.append(mk(kindLabel + ' 설정 (이름·색)', () => openFolderForm(reload, folder)));
    if (isSpace)
        menu.append(mk('이 스페이스에 새 폴더', () => openFolderForm(reload, undefined, { parentId: folder.id }))); // #766 스페이스 하위 폴더 생성
    menu.append(mk('이 ' + kindLabel + '에 새 리스트', () => openListForm(reload, undefined, { folderId: folder.id })));
    // '최상위로 빼기' 는 **스페이스에만** 남긴다(#1067) — 아카이브에 치워둔 스페이스를 꺼내는 유일한 경로라 없애면 갇힌다.
    //  일반 폴더는 최상위로 나가면 '스페이스 미지정' 이 되므로 이 경로를 막았다(옮기려면 폴더 설정에서 상위 스페이스를 바꾼다).
    if (folder.parent_id != null && isSpace)
        menu.append(mk('최상위로 빼기', () => pjvMoveFolderToParent(folder.id, null, reload)));
    menu.append(el('div', { class: 'pjv-bulk-sep-h' }));
    menu.append(mk(kindLabel + ' 삭제', () => pjvDeleteFolder(folder, reload), true));
}
function pjvDeleteFolder(folder, reload) {
    if (!confirm('폴더 ‘' + folder.name + '’을(를) 삭제할까요?\n\n폴더만 사라지고, 속한 리스트는 보존됩니다(그 뒤 원하는 스페이스·폴더로 옮겨 주세요).'))
        return;
    (async () => {
        try {
            await api('/api/ui/v6/project-folders/' + folder.id + '/delete', { method: 'POST' });
            toast('폴더를 삭제했습니다');
            reload();
        }
        catch (e) {
            toast('삭제 실패 — ' + e.message, true);
        }
    })();
}
export { PJV_ARCHIVE_FOLDER_NAME, pjvArchiveDropTarget, pjvArchiveFolderIds, pjvBuildListGroups, pjvFavSecOpen, pjvFindArchiveFolder, pjvFolderDropTarget, pjvFolderTreeMenu, pjvListGlyph, pjvListGroup, pjvListSettingsMenu, pjvMoveFolderToParent, pjvMoveListToFolder, pjvMoveNear, pjvReorderFolders, pjvReorderLists, pjvSetFavSecOpen, pjvSetFavorite, pjvSideIndent, pjvSideNavDrop, pjvTrashDropTarget, pjvVisLock, setFavListCache, };

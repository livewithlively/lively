// dash/widget-projects.ts — 대시보드 '내 프로젝트' 위젯(#1313 R42 · dashboard-home.ts 에서 verbatim 분리).
//  mine=1(생성자 OR 팀원) 프로젝트를 '리스트 개요 카드 + 선택된 리스트의 행 목록' 두 층으로 보여준다(#622).
//  fillProjects 가 630줄짜리 한 덩어리 클로저였다 — 지역 상태 14개를 **ProjCtx 한 객체**로 명명해 내부 함수들을
//  파일 상위로 승격했다(로직은 무수정). 팝오버 3종은 widget-projects-popovers.ts 로 나가 있다.
//
// ⚠ 이 파일이 지켜야 하는 계약
//  · **listById 는 참조를 유지한다.** 행(projRow)이 만든 상태 컨트롤은 이 Map 을 **캡처**해 두고 나중에 읽는다.
//    그래서 새로고침(projReloadAll)은 `new Map(...)` 으로 갈아끼우지 않고 **같은 Map 을 비우고 다시 채운다**
//    (projRefillListById — 원문 주석 '같은 Map 참조 유지'). 갈아끼우면 이미 그려진 행들이 옛 Map 을 계속 보게 돼
//    리스트 이름·커스텀 상태 어휘가 옛 값으로 굳는다.
//  · **ctx.draw / ctx.reloadAll / ctx.setListShown 은 fillProjects 가 한 번 만든 안정된 함수 참조**다. 팝오버와
//    외부 폼(openProjectSessionForm·pjvOpenProjectModal·openListForm)에 콜백으로 넘어가므로 매번 새로 만들지 않는다.
//  · 리스트별 필터는 **그룹 body 만** 다시 그린다(paint) — 위젯 전체 draw() 는 팝오버 앵커를 죽인다(#1236).
import { api, el, errorNote, toast } from '../core.js';
import { skeleton } from '../learn.js';
import { openProjectSessionForm, pjvOpenProjectModal } from '../projects.js';
import { dashApplyListOrder, dashListFilter, dashListFilterOn, dashListFilterPreds, dashOvHidden, dashOvPinned, dashPrefsSync, dashProjFilterDefault, dashReorderList, dashSaveOvHidden, dashSaveOvPinned, dashTaskChip, dashTaskCountMode } from './prefs.js';
import { dashFilterIcon, dashListGlyph, dashSessAddIcon, dashSubtaskIcon } from './icons.js';
import { dashProjStatusControl, dashStatusIconSvg, dashTaskStatusControl } from './status.js';
import { dashInitRowResize } from './resize.js';
import { dashChips, dashCtl, dashEmpty, dashPopover } from './chrome.js';
import { projListAddCard, projOpenListFilter, projOpenOvPrefs } from './widget-projects-popovers.js';
import { dashOpenSessionTab } from './widget-sessions.js';
// 완료 판정 — 네이티브 status 와 커스텀 상태의 카테고리 둘 다 본다(위젯 전역 기준).
const projIsDone = (p) => p.status === 'done' || p.status_category === 'done' || p.status_category === 'closed';
// 상태 묶음(개요 미니바) — 프로젝트 탭 개요의 brk 와 동일 3버킷(할일·진행·완료).
const projBrk = (arr) => ({ total: arr.length, done: arr.filter(projIsDone).length,
    prog: arr.filter((p) => !projIsDone(p) && p.status !== 'todo').length, todo: arr.filter((p) => p.status === 'todo').length });
// ⚠ listById 참조 유지 계약의 구현부(파일 헤더 참조) — **같은 Map** 을 비우고 다시 채운다. `ctx.listById = new Map(...)`
//  으로 바꾸면 이미 그려진 행이 캡처한 옛 Map 이 영영 갱신되지 않는다.
function projRefillListById(ctx) {
    ctx.listById.clear();
    for (const l of ctx.lists)
        ctx.listById.set(l.id, l);
}
// #req 추가로 고른 리스트(pinned)는 '내 프로젝트'가 아닐 수 있다 — 그 카드/목록은 mine 필터 없이 **리스트 전체**를 보여준다.
//  조직 전체 프로젝트는 무거우니 pinned 가 실제로 있을 때만 한 번 받아 캐시(reloadAll 에서 무효화).
function projEnsureAllProjects(ctx) {
    if (ctx.allProjects || ctx.allLoading || !dashOvPinned().size)
        return;
    ctx.allLoading = true;
    api('/api/ui/v6/projects')
        .then((d) => { ctx.allProjects = (d && d.projects) || []; ctx.allLoading = false; ctx.draw(); })
        .catch(() => { ctx.allLoading = false; /* 실패 시 내 프로젝트 기준으로만 표시 */ });
}
// 요약 카드 표시/숨김 단일 토글 — 자동 후보는 hidden(블랙리스트)으로, 직접 고른 리스트는 pinned(화이트리스트)로 관리한다.
//  두 저장소를 한 함수로 묶어 '카드 ✕'와 '⚙ 트리 체크박스'가 항상 같은 결과를 내게 한다.
function projSetListShown(ctx, id, on) {
    const h = dashOvHidden();
    const p = dashOvPinned();
    const n = Number(id);
    if (on) {
        h.delete(n);
        if (!ctx.autoIds.has(n))
            p.add(n);
    }
    else {
        p.delete(n);
        if (ctx.autoIds.has(n))
            h.add(n);
    }
    dashSaveOvHidden(h);
    dashSaveOvPinned(p);
}
// 프로젝트 행 — 프로젝트 탭 리스트 행(pjv-trow-title-cell)과 동일 UI: 상태 아이콘(진행도 파이/체크) + 이름 + 태스크 수 + 세션 배지 + 태그.
//  좁은 대시보드 폭이라 프로젝트 탭 표의 나머지 열(담당·마감·날짜·우선순위 등)은 생략하고 제목 셀만 그대로 차용. 클릭→프로젝트 상세.
function projRow(ctx, p) {
    const cell = el('div', { class: 'pjv-trow-title-cell' }, 
    // 상태 동그라미 = 클릭 시 상태 변경 메뉴(프로젝트 탭 pjvProjStatusDot 과 동일 동작, #req). 행 링크로 전파 안 되게 preventDefault.
    dashProjStatusControl(p, ctx.listById, () => ctx.draw()), el('span', { class: 'pjv-trow-title clickable' + (projIsDone(p) ? ' done' : ''), title: p.name, text: p.name }));
    // 하위태스크 아이콘 = 클릭 시 그 프로젝트의 태스크 목록 팝오버(#req). 표시 방식(진행중만/전체/완료·전체)은 ⚙ 개인화(#req).
    const chip = dashTaskChip(p);
    if (chip) {
        const tb = el('span', { class: 'pjv-trow-subcount pjv-subcount-ico dash-rowchip', role: 'button', tabindex: '0', title: chip.title + ' — 눌러서 보기' }, dashSubtaskIcon(), el('span', { text: chip.text }));
        const openT = (e) => { e.preventDefault(); e.stopPropagation(); openProjTasksPopover(tb, p, ctx.reloadAll); };
        tb.addEventListener('click', openT);
        tb.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ')
            openT(e); });
        cell.append(tb);
    }
    // 세션 배지 = 클릭 시 들어갈 세션 선택(#req) — 1개면 바로 열기, 여러 개면 팝아웃 선택.
    if (p.my_session_count) {
        const sb = el('span', { class: 'dash-badge dash-rowchip', role: 'button', tabindex: '0', title: '내 세션 ' + p.my_session_count + '개 — 들어갈 세션 선택', text: '세션 ' + p.my_session_count });
        const openS = (e) => { e.preventDefault(); e.stopPropagation(); openProjSessionsPicker(sb, p); };
        sb.addEventListener('click', openS);
        sb.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ')
            openS(e); });
        cell.append(sb);
    }
    const tags = dashRowTags(p);
    if (tags)
        cell.append(tags);
    // #1236 행 호버 '새 세션' — 프로젝트 탭 리스트 뷰의 행 호버 아이콘과 같은 문법. 세션 배지(들어갈 세션 선택)와 달리
    //  이건 '만들기'로 곧장 — 프로젝트 탭과 같은 세션 생성 모달(openProjectSessionForm)을 그 자리에서 연다.
    const sess = el('button', { class: 'dash-projrow-more dash-projrow-sess', type: 'button', title: '새 세션 만들기', 'aria-label': '새 세션 만들기' }, dashSessAddIcon());
    sess.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openProjectSessionForm(p.id, ctx.reloadAll, '/api/ui/v6/projects/', p.name); });
    // #req 행 맨 뒤 '⋯' — 호버 시 노출, 삭제 등 관리 메뉴. 행 링크로 전파 안 되게 격리.
    const more = el('button', { class: 'dash-projrow-more', type: 'button', title: '프로젝트 관리', 'aria-label': '프로젝트 관리', text: '⋯' });
    more.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openProjRowMenu(more, p, ctx.reloadAll); });
    // 행 클릭 = 페이지 이동 대신 **상세 팝업**(내용 그대로·모달 내부 스크롤). href 는 남겨둬서 ⌘/Ctrl/중클릭·새 탭은 기존대로 전체 페이지로.
    //  행 안의 상태점·태스크칩·세션배지·⋯ 는 이미 각자 preventDefault/stopPropagation 하므로 여기까지 오지 않는다.
    const row = el('a', { class: 'dash-projrow2', href: '#/projects2/p/' + p.id }, cell, sess, more);
    row.addEventListener('click', (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
            return;
        e.preventDefault();
        pjvOpenProjectModal(p.id, ctx.reloadAll);
    });
    return row;
}
// #req R19 — 목록 맨 밑 인라인 '+ 새 프로젝트'. 프로젝트 탭 보드 추가행(pjvProjAddRow)과 동일 클래스·톤(테두리 없는 인라인 입력).
//  트리거(＋ 프로젝트) → 클릭 시 제목 셀(체크박스 자리·캐럿 자리·상태점 + 입력)로 펼침. Enter=생성 후 상세로, Esc=접기.
function projInlineAdd(ctx, listId, countEl) {
    const row = el('div', { class: 'pjv-addrow dash-addrow' });
    // 대시보드 프로젝트 행(projRow)은 상태아이콘이 셀 맨앞(체크박스·캐럿 자리 없음) — 추가행도 동일하게 spacer/caret 없이 맞춰 ＋가 상태점과 같은 들여쓰기에 오게(#670).
    const trigger = el('button', { class: 'pjv-addrow-trigger', type: 'button' }, el('span', { class: 'pjv-addrow-plus', text: '＋' }), el('span', { text: '프로젝트' }));
    const input = el('input', { type: 'text', class: 'pjv-addrow-input', placeholder: '프로젝트 이름 입력 후 Enter (Esc 취소)', maxlength: '200', spellcheck: 'false', autocomplete: 'off' });
    const collapse = () => { row.classList.remove('editing'); row.replaceChildren(trigger); };
    // Enter / 바깥클릭 → **설정 팝업 없이 바로 생성**(#1130). 프로젝트 탭 추가행(pjvProjAddRow, #1067)과 동일 —
    //  이름만으로 POST /v6/projects 즉시 생성하고, 새 행을 그 자리에 인라인 삽입한 뒤 입력을 열어 둬(keepOpen) 연속 추가한다.
    //  자세한 설정(설명·레포·태스크·팀원·AI세션)이 필요하면 섹션 상단 헤더의 '+ 새 프로젝트'(openProjectV2Form 팝업)를 쓴다.
    let busy = false;
    // #1098 — 리스트 없이 만들어지던 구멍 막기. 미분류 묶음의 추가행은 **리스트를 고른 뒤에만** 생성한다
    //  (예전엔 listId 가 없으면 list_id 없이 POST 해 '어느 리스트에도 없는 프로젝트'가 계속 생겼다).
    //  고르는 자리는 팝오버 한 겹 — 이름은 이미 쳤으니 리스트만 집으면 바로 만들어진다.
    const pickListThen = (anchor, onPicked) => {
        const panel = el('div', { class: 'dash-pop-panel' });
        panel.append(el('div', { class: 'dash-pop-head' }, el('strong', { text: '어느 리스트에 넣을까요?' })));
        let close = () => { };
        const body = el('div', { class: 'dash-pop-scroll' });
        panel.append(body);
        body.append(el('div', { class: 'dash-pop-desc', text: '불러오는 중…' }));
        api('/api/ui/v6/project-lists').then((d) => (d && d.lists) || []).catch(() => []).then((lists) => {
            if (!lists.length) {
                body.replaceChildren(el('div', { class: 'dash-pop-desc', text: '리스트가 아직 없어요 — 프로젝트 탭에서 먼저 만들어 주세요.' }));
                return;
            }
            body.replaceChildren(...lists.map((l) => {
                const b = el('button', { class: 'dash-pop-opt', type: 'button' }, el('span', { class: 'dash-pop-name', text: l.name }));
                b.onclick = () => { close(); onPicked(Number(l.id)); };
                return b;
            }));
        });
        close = dashPopover(anchor, panel);
    };
    const commit = async (keepOpen, forcedListId) => {
        if (busy)
            return;
        const name = (input.value || '').trim();
        if (!name) {
            if (!keepOpen)
                collapse();
            return;
        }
        const useListId = forcedListId != null ? forcedListId : listId;
        if (useListId == null || useListId === 0) { // 미분류 자리 — 리스트를 먼저 고른다
            pickListThen(input, (picked) => { void commit(keepOpen, picked); });
            return;
        }
        busy = true;
        input.disabled = true;
        try {
            // 생성 — 이름·리스트를 한 번에. (작성자=나(actor) 자동 → 내 보드 노출·삭제권한.)
            const np = await api('/api/ui/v6/projects', { method: 'POST', body: JSON.stringify({
                    name, list_id: useListId,
                }) }).then((d) => (d && d.project) || d);
            // #1130 대시보드 빠른 생성 기본 상태 = '할 일'(todo). 백엔드 createProject 는 항상 active(진행 중)로
            //  만들므로 생성 직후 상태만 todo 로 패치한다(프로젝트 탭이 비-진행중 그룹에 넣을 때와 동일 경로 /status POST).
            //  ⚠ 이 기본값 변경은 '대시보드 빠른 생성'에만 적용 — 백엔드 기본값·프로젝트 탭은 그대로(사용자 결정 #1130).
            if (np && np.id)
                await api('/api/ui/v6/projects/' + np.id + '/status', { method: 'POST', body: JSON.stringify({ status: 'todo', status_raw: null }) }).catch(() => { });
            // 새 프로젝트 행을 추가행 바로 위에 인라인 삽입(리로드 없이 흐름 유지). status 는 위 패치와 일치시켜 '할 일'로.
            const p = Object.assign({ task_count: 0, tasks: [], field_values: {}, tags: [], members: [] }, np, { status: 'todo', status_category: 'unstarted', list_id: useListId ?? (np && np.list_id) ?? null });
            if (np && np.id) {
                // ⚠ 데이터 배열(projects)에도 넣는다 — DOM 만 삽입하면, 행의 상태 아이콘을 눌러 상태를 바꿀 때
                //  dashSetProjStatus → draw() 가 projects 로 재렌더하며 이 행을 통째로 떨군다(생성은 됐는데 목록에서 사라짐, #1130).
                ctx.projects.push(p);
                row.parentNode?.insertBefore(projRow(ctx, p), row);
                ctx.onCount(ctx.projects.filter((x) => !projIsDone(x)).length); // 인사줄 '진행 중' 카운트 동기화
            }
            if (countEl)
                countEl.textContent = String((parseInt(countEl.textContent, 10) || 0) + 1);
            input.value = '';
            input.disabled = false;
            busy = false;
            if (keepOpen)
                input.focus();
            else
                collapse();
        }
        catch (err) {
            toast('프로젝트 생성 실패 — ' + (err && err.message || err), true);
            input.disabled = false;
            busy = false;
        }
    };
    const expand = () => {
        row.classList.add('editing');
        row.replaceChildren(el('div', { class: 'pjv-trow-title-cell' }, dashStatusIconSvg('active', '#94a3b8', 0), input));
        input.focus();
    };
    // 한글(IME) 조합 중 Enter 는 글자 확정용 — 그때 커밋하면 마지막 글자가 중복된 이름이 된다(프로젝트 탭 pjvProjAddRow 동형 가드).
    //  Enter=연속 추가(keepOpen) — 만들고 입력을 열어 둬 다음 프로젝트를 바로 잇는다. Esc=접기.
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        commit(true);
    }
    else if (e.key === 'Escape') {
        e.preventDefault();
        input.value = '';
        collapse();
    } });
    // 바깥클릭 — 이름 있으면 생성(접기), 없으면 접기. busy·행 내부 포커스면 보류(조기 이중생성 방지).
    input.addEventListener('blur', () => {
        setTimeout(() => {
            if (busy || !row.classList.contains('editing'))
                return;
            if (row.contains(document.activeElement))
                return;
            if ((input.value || '').trim())
                commit(false);
            else
                collapse();
        }, 130);
    });
    trigger.onclick = expand;
    collapse();
    return row;
}
// 리스트 그룹 — 프로젝트 탭 리스트 헤더(pjv-list-head: 캐럿·글리프·이름·개수, 접기/펼치기) + 행들. 미분류는 색점.
//  rawAll = 이 리스트 프로젝트 **전체 원본**(위젯 칩 mode 미적용 — #1236). 리스트별 필터는 그룹이 스스로 적용하고 body 만 다시 그린다
//  (필터를 만질 때 draw() 로 위젯을 통째로 다시 그리면 팝오버가 붙어 있던 헤더 버튼이 사라져 위치가 튄다).
//  상태 축을 직접 골랐으면 그 리스트에선 칩(진행 중/전체)보다 필터가 우선한다 — 칩이 '진행 중'이어도 '완료만 보기'가 되게.
function projGroup(ctx, listId, l, rawAll) {
    const isUn = !listId;
    const body = el('div', { class: 'pjv-tgroup-body' });
    let open = true;
    const caret = el('button', { class: 'pjv-tgroup-caret', type: 'button', text: '▾', 'aria-expanded': 'true' });
    const setOpen = (o) => { open = o; caret.textContent = o ? '▾' : '▸'; caret.setAttribute('aria-expanded', String(o)); body.hidden = !o; };
    caret.onclick = (e) => { e.stopPropagation(); setOpen(!open); };
    const dot = isUn
        ? el('span', { class: 'pjv-list-dot', style: 'background:' + ((l && l.color) || 'var(--muted-3)'), 'aria-hidden': 'true' })
        : el('span', { class: 'pjv-list-headglyph', 'aria-hidden': 'true' }, dashListGlyph(l));
    // #req 리스트 헤더 우측 필터 버튼 — 위젯 헤더의 [⚙][→] 와 같은 아이콘버튼(dash-wh-btn) 톤을 그대로 쓴다.
    //  직접 고른 리스트는 남의 프로젝트까지 들어와 목록이 길어지므로, 그 자리에서 담당·이름으로 좁힌다.
    const fBtn = el('button', { class: 'dash-wh-btn dash-lh-filter', type: 'button',
        title: '이 리스트 목록 거르기', 'aria-label': ((l && l.name) || '미분류') + ' 목록 거르기' }, dashFilterIcon());
    const countEl = el('span', { class: 'pjv-tgroup-count' });
    // 필터 적용 + 헤더 표식 갱신. 걸린 필터가 있으면 버튼 on + 개수를 '보이는 수/후보 수'로 바꿔 가려진 게 있음을 드러낸다.
    //  #1236 — 상태 축이 걸리면 mode(위젯 칩) 대신 전체 원본에서 상태로 거른다(칩과 필터가 서로 결과를 비우지 않게).
    const paint = () => {
        const lf = dashListFilter(listId);
        const P = dashListFilterPreds(lf, l, ctx.mineIds);
        const base = lf.st.length ? rawAll : (ctx.mode === 'active' ? rawAll.filter((p) => !projIsDone(p)) : rawAll);
        const arr = base.filter((p) => P.st(p) && P.who(p) && P.q(p) && P.pri(p) && P.tags(p) && P.due(p));
        body.replaceChildren(...arr.map((p) => projRow(ctx, p)), projInlineAdd(ctx, listId, countEl)); // 맨 밑 인라인 추가행
        const on = dashListFilterOn(lf);
        fBtn.classList.toggle('on', on);
        countEl.textContent = (on && arr.length !== base.length) ? arr.length + '/' + base.length : String(arr.length);
        if (on && !arr.length)
            body.prepend(dashEmpty('필터에 걸리는 프로젝트가 없어요.'));
    };
    fBtn.onclick = (e) => { e.stopPropagation(); projOpenListFilter(ctx, fBtn, listId, l, rawAll, paint); };
    paint();
    const head = el('div', { class: 'pjv-tgroup-head pjv-list-head' + (isUn ? ' pjv-list-head-un' : '') }, el('div', { class: 'pjv-list-head-main' }, caret, dot, el('span', { class: 'pjv-tgroup-label', text: (l && l.name) || '미분류' }), countEl), el('div', { class: 'dash-lh-ctl' }, fBtn));
    head.addEventListener('click', (e) => { if (e.target.closest('button'))
        return; setOpen(!open); });
    return el('div', { class: 'pjv-tgroup pjv-list-group' }, head, body);
}
// 리스트 블럭 카드 — pjv-overview 의 ovCard 와 동일 마크업. 클릭=이 리스트 '선택'(아래 목록을 그 리스트만으로 필터),
//  드래그=개요 순서 변경(대시보드-로컬 저장). 선택된 카드는 강조(파란 링).
function projBlock(ctx, listId, l, arr) {
    const b = projBrk(arr);
    const name = (l && l.name) || '미분류';
    const card = el('div', { class: 'pjv-ov-card dash-ov-card2' + (listId === ctx.selectedListId ? ' selected' : ''),
        role: 'button', tabindex: '0', title: name, draggable: 'true', 'data-list-id': String(listId) }, el('div', { class: 'pjv-ov-card-head' }, dashListGlyph(l), el('span', { class: 'pjv-ov-card-name', text: name })), el('div', { class: 'pjv-ov-card-count', text: b.total + '개 프로젝트' }));
    const bar = el('div', { class: 'pjv-ov-bar' });
    const seg = (n, cls) => { if (n > 0) {
        const s = el('span', { class: 'pjv-ov-bar-seg ' + cls });
        s.style.flex = String(n);
        bar.append(s);
    } };
    if (b.total) {
        seg(b.todo, 'todo');
        seg(b.prog, 'prog');
        seg(b.done, 'done');
    }
    else
        bar.append(el('span', { class: 'pjv-ov-bar-seg empty' }));
    card.append(bar);
    // 개요 카드 클릭 = 선택(아래 목록을 그 리스트만으로 필터). 팝업은 중복이라 제거(#670) — 아래 dash-projlist 가 이미 선택 리스트를 그대로 보여줌.
    const pick = () => { if (ctx.selectedListId !== listId) {
        ctx.selectedListId = listId;
        ctx.draw();
    } };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
    } });
    // 드래그 순서 변경 — 대시보드-로컬(localStorage) 저장, 프로젝트 탭 리스트 순서와는 독립.
    //  커서가 카드 좌/우 절반 어디냐로 '앞/뒤' 삽입을 정하고, 삽입 지점(카드 사이 간격)에 세로 디바이더
    //  (.drop-before::before / .drop-after::after)를 띄워 '어디로 들어가는지'를 명확히 보여준다(맨 끝 삽입도 가능).
    const clearDrop = () => card.classList.remove('drop-before', 'drop-after');
    card.addEventListener('dragstart', (e) => { ctx.dragListId = listId; try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(listId));
    }
    catch { /* */ } card.classList.add('drag-src'); });
    card.addEventListener('dragend', () => { ctx.dragListId = null; card.classList.remove('drag-src'); document.querySelectorAll('.dash-ov-card2.drop-before, .dash-ov-card2.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after')); });
    card.addEventListener('dragover', (e) => {
        if (ctx.dragListId == null || ctx.dragListId === listId)
            return;
        e.preventDefault();
        const r = card.getBoundingClientRect();
        const after = (e.clientX - r.left) > r.width / 2; // 오른쪽 절반이면 이 카드 '뒤'로
        card.classList.toggle('drop-after', after);
        card.classList.toggle('drop-before', !after);
    });
    card.addEventListener('dragleave', clearDrop);
    card.addEventListener('drop', (e) => {
        e.preventDefault();
        const after = card.classList.contains('drop-after');
        clearDrop();
        if (ctx.dragListId == null || ctx.dragListId === listId)
            return;
        dashReorderList(ctx.currentOrder, ctx.dragListId, listId, after);
        ctx.draw();
    });
    // 이 개요 카드 숨기기(#671) — hover ✕. 기기별 저장·즉시 재렌더. 카드 선택/드래그로 새지 않게 이벤트 격리.
    const hideBtn = el('button', { class: 'dash-ov-hide', type: 'button', title: '이 카드 숨기기', 'aria-label': name + ' 개요 카드 숨기기', text: '✕' });
    hideBtn.addEventListener('mousedown', (e) => e.stopPropagation()); // 드래그 시작 방지
    hideBtn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); ctx.setListShown(Number(listId), false); ctx.draw(); });
    card.append(hideBtn);
    return card;
}
function projDraw(ctx) {
    projEnsureAllProjects(ctx); // pinned 가 있으면 조직 전체 프로젝트를 한 번 확보(도착하면 스스로 재렌더)
    const pinned = dashOvPinned();
    const byMode = (arr) => (ctx.mode === 'active' ? arr.filter((p) => !projIsDone(p)) : arr);
    const shown = byMode(ctx.projects);
    ctx.zone.countEl.textContent = String(shown.length); // 위젯 헤더 개수는 언제나 '내' 프로젝트 기준
    dashChips(ctx.zone.chipsEl, [['all', '전체'], ['active', '진행 중']], ctx.mode, (k) => { ctx.mode = k; ctx.draw(); });
    if (!shown.length && !pinned.size) {
        ctx.zone.body.replaceChildren(dashEmpty(ctx.mode === 'active' ? '진행 중인 내 프로젝트가 없어요.' : '내가 참여한 프로젝트가 없어요.'));
        return;
    }
    // 리스트별 묶음, 미분류(list_id 없음)는 맨 뒤 → 저장된 개요 순서 적용.
    const byList = new Map();
    for (const p of shown) {
        const k = p.list_id || 0;
        if (!byList.has(k))
            byList.set(k, []);
        byList.get(k).push(p);
    }
    // #1236 필터용 원본(모드 미적용) — 리스트 그룹은 전체를 받고, 칩(mode)/리스트 필터 적용은 그룹 paint 가 스스로 한다.
    const byListAll = new Map();
    for (const p of ctx.projects) {
        const k = p.list_id || 0;
        if (!byListAll.has(k))
            byListAll.set(k, []);
        byListAll.get(k).push(p);
    }
    // 자동 후보는 상태 필터와 **무관하게** 판정한다 — '진행 중' 필터를 켰다고 리스트가 통째로 사라지면 안 되므로.
    //  list_id 없는 프로젝트는 0(미분류) — 미분류도 자동 후보라 pinned 가 아니라 hidden 으로만 토글된다.
    ctx.autoIds = new Set(ctx.projects.map((p) => Number(p.list_id) || 0));
    ctx.mineIds = new Set(ctx.projects.map((p) => Number(p.id))); // 리스트 필터 '내 것만' 판정 — projects 는 mine=1 결과.
    // #req 직접 고른 리스트(pinned)는 내가 관여하지 않았을 수 있다 → mine 필터를 풀고 **그 리스트 전체**를 채운다.
    //  (mine=1 그대로면 '0개 프로젝트' 빈 카드가 떠 고른 의미가 없어진다.) 전체 목록 도착 전에는 빈 채로 두고 도착 시 재렌더.
    if (ctx.allProjects) {
        for (const id of pinned) {
            if (Number(id) > 0) {
                byList.set(Number(id), []);
                byListAll.set(Number(id), []);
            }
        } // 0(미분류)은 pinned 대상이 아니다 — 내 미분류 묶음을 덮지 않게
        for (const p of byMode(ctx.allProjects)) {
            const k = Number(p.list_id || 0);
            if (k > 0 && pinned.has(k))
                byList.get(k).push(p);
        }
        for (const p of ctx.allProjects) {
            const k = Number(p.list_id || 0);
            if (k > 0 && pinned.has(k))
                byListAll.get(k).push(p);
        } // 필터용 원본도 동형(모드만 미적용)
    }
    // 개요 카드 후보 = 내 프로젝트가 있는 리스트 + 직접 고른 리스트(pinned) + 이 화면에서 방금 만든 리스트(#762).
    //  조직의 모든 리스트를 무조건 늘어놓지는 않는다 — 그건 ⚙ 트리에서 사람이 고른다.
    //  ⚠ 후보 판정은 **상태 필터(전체/진행 중)와 무관**해야 한다(위 autoIds 주석의 의도) → byList 가 아니라 byListAll(모드 미적용).
    //   byList 로 판정하면 '진행 중'에서 안 보이던 리스트(완료 프로젝트만 있는 리스트)가 <전체> 를 누를 때마다 후보로 새로
    //   튀어나오고, 사람은 그걸 본 적이 없어 숨길 수도 없었으니 ✕ 정리를 필터 전환마다 다시 해야 했다(#1129).
    //   위계: 카드 집합은 사람이 정하고(hidden/pinned), 상태 필터는 그 **카드 안의 프로젝트 목록**만 거른다.
    //   (⚙ 트리 체크 상태 isOn 은 이미 autoIds 기준이라, 팝오버는 '켜짐'인데 카드는 사라지던 불일치도 함께 해소된다.)
    const base = [...ctx.lists.filter((l) => byListAll.has(l.id) || pinned.has(Number(l.id)) || ctx.justCreated.has(l.id)).map((l) => l.id), ...(byListAll.has(0) ? [0] : [])];
    ctx.currentOrder = dashApplyListOrder(base);
    // 숨긴 개요 카드 제외(#671). 선택된 리스트가 숨겨졌거나 사라졌으면 보이는 첫 카드로 폴백.
    const hiddenOv = dashOvHidden();
    const visibleOrder = ctx.currentOrder.filter((id) => !hiddenOv.has(Number(id)));
    // 선택 리스트가 '보이는 목록'에 없을 때만 첫 카드로 폴백(방금 만든 빈 리스트 선택 유지).
    if (ctx.selectedListId === undefined || !visibleOrder.some((id) => Number(id) === Number(ctx.selectedListId))) {
        ctx.selectedListId = visibleOrder.length ? visibleOrder[0] : ctx.currentOrder[0];
    }
    let gridEl;
    if (visibleOrder.length) {
        gridEl = el('div', { class: 'pjv-ov-grid dash-ov-grid' });
        for (const listId of visibleOrder)
            gridEl.append(projBlock(ctx, listId, ctx.listById.get(listId), byList.get(listId) || []));
        gridEl.append(projListAddCard(ctx)); // #req R20 — 개요 맨 끝 '+ 새 리스트'
    }
    else {
        // 전부 숨김 — 그리드 대신 복원 힌트(선택된 리스트 목록은 아래에 그대로 유지).
        gridEl = el('div', { class: 'dash-ov-allhidden' }, el('span', { text: '개요 카드를 모두 숨겼어요.' }), el('button', { class: 'dash-ov-restore', type: 'button', text: '다시 표시', onclick: () => { dashSaveOvHidden(new Set()); ctx.draw(); } }));
    }
    // 선택된 리스트의 프로젝트만 — 프로젝트 탭과 동일한 리스트 그룹(헤더+행). 강조된 카드가 곧 선택 표시.
    //  생성순(id 오름차순) — 새로 만든 프로젝트가 목록 '맨 아래'(추가행 바로 위)에 자연스럽게 붙게(#670). 예전 updated_at 내림차순은 새 프로젝트를 맨 위로 튀게 했음.
    //  #1236 — 그룹엔 mode 미적용 원본(byListAll)을 넘긴다. 칩/리스트 필터 적용은 그룹 paint 몫.
    const rawArr = (byListAll.get(ctx.selectedListId) || []).slice().sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
    // #req R11.1/R19 — '+ 새 프로젝트'는 리스트 그룹 맨 밑 인라인 행(projInlineAdd)으로 이동(프로젝트 탭과 동일).
    //  리스트별 필터(헤더 우측 버튼)는 그룹이 스스로 적용·갱신한다 — 필터를 만질 때 위젯 전체를 다시 그리지 않으려고.
    const listEl = el('div', { class: 'dash-projlist' }, projGroup(ctx, ctx.selectedListId, ctx.listById.get(ctx.selectedListId), rawArr));
    // #req 리스트 카드(개요) ↔ 프로젝트 목록 사이 높이 조절 핸들 — 위젯 사이 리사이즈와 동일 UI(fr·기기별 저장). 기본은 개요 auto(현재 모습), 드래그하면 fr 전환.
    const split = el('div', { class: 'dash-proj-split' }, gridEl, listEl);
    ctx.zone.body.replaceChildren(split);
    dashInitRowResize(split, 'dash_proj_split_v1', [3, 5], { cssDefault: true });
}
// 프로젝트 변경(생성·삭제·이동·상태) 후 위젯 새로고침 — 최신 mine=1 재요청 후 재렌더.
async function projReloadAll(ctx) {
    try {
        const [pd, ld] = await Promise.all([
            api('/api/ui/v6/projects?mine=1').then((d) => (d && d.projects) || []),
            api('/api/ui/v6/project-lists').then((d) => (d && d.lists) || ctx.lists).catch(() => ctx.lists),
        ]);
        ctx.projects = pd;
        ctx.lists = ld;
        projRefillListById(ctx); // 리스트 추가/변경 반영(같은 Map 참조 유지)
        ctx.allProjects = null; // 직접 고른 리스트용 전체 목록도 무효화 — 다음 draw() 에서 다시 받는다
        ctx.onCount(ctx.projects.filter((p) => !projIsDone(p)).length);
    }
    catch { /* 실패 시 기존 데이터 유지 */ }
    ctx.draw();
}
// ── ① 내 프로젝트 — mine=1(생성자 OR 팀원)를 '리스트 블럭(개요 카드)'으로(#622). ──
//  프로젝트 탭 폴더 개요(pjv-overview)와 동일한 카드 UI: 리스트별 블럭에 글리프·이름 · 'N개 프로젝트' · 상태 미니바.
//  블럭을 누르면 그 리스트로 진입(#/projects2/l/<id>) — 기존 프로젝트 탭에서 그 안의 프로젝트가 그대로 보인다.
async function fillProjects(zone, onCount, projectsP, listsP) {
    let projects, lists;
    try {
        [projects, lists] = await Promise.all([projectsP, listsP]);
    }
    catch (e) {
        onCount(null);
        zone.body.replaceChildren(errorNote(e, '내 프로젝트를 불러오지 못했습니다'));
        return;
    }
    onCount(projects.filter((p) => !projIsDone(p)).length);
    const listById = new Map(lists.map((l) => [l.id, l]));
    const ctx = {
        zone, onCount, projects, lists, listById,
        favLists: new Set(),
        folders: [],
        foldersLoaded: false,
        ovOpen: new Set(), // ⚙ 트리에서 펼쳐 둔 폴더(팝오버를 닫았다 열어도 유지). 최초 1회 '켜진 리스트의 조상'을 펼친다.
        ovSeeded: false,
        allProjects: null,
        allLoading: false,
        dragListId: null,
        mode: dashProjFilterDefault(), // 진행 중 | 전체 — 완료 프로젝트 포함 여부(기본값 ⚙ 개인화).
        selectedListId: undefined, // 선택된 리스트(아래 목록 필터). 기본=첫 리스트.
        currentOrder: [], // 현재 표시 중인 리스트 순서(드래그 재정렬 기준).
        autoIds: new Set(), // 내 프로젝트가 있어 '자동으로' 뜨는 리스트(체크 해제 시에만 hidden 에 기록).
        mineIds: new Set(), // 내가 멤버인 프로젝트 id — 리스트별 필터의 '내 프로젝트만' 판정용.
        justCreated: new Set(), // 이 화면에서 방금 만든 리스트 — 비어도 개요에 뜨게(#762 '만들었는데 안 보임' 방지).
    };
    // ⚠ 안정된 함수 참조(파일 헤더 계약) — 팝오버·외부 폼에 콜백으로 넘어가므로 매 렌더마다 새로 만들지 않는다.
    ctx.draw = () => projDraw(ctx);
    ctx.reloadAll = () => projReloadAll(ctx);
    ctx.setListShown = (id, on) => projSetListShown(ctx, id, on);
    // #req ⚙ 팝오버에서 즐겨찾기 리스트를 상단에 — 백그라운드 로드(지연/실패 시 빈 집합, 무해).
    api('/api/ui/v6/favorites').then((d) => { ctx.favLists = new Set(((d && d.project_lists) || []).map((x) => Number(x))); }).catch(() => { });
    // #req ⚙ 팝오버의 리스트 고르기는 **조직의 모든 리스트**를 스페이스›폴더 트리로 훑는다 — 폴더는 백그라운드 로드.
    //  팝오버를 열 때까지 필요 없으므로 렌더를 막지 않는다(실패해도 트리 없이 평면 목록으로 폴백).
    ctx.foldersP = api('/api/ui/v6/project-folders')
        .then((d) => { ctx.folders = (d && d.folders) || []; ctx.foldersLoaded = true; return ctx.folders; })
        .catch(() => { ctx.foldersLoaded = true; return ctx.folders; }); // 실패해도 트리 자리에 '폴더에 없는 리스트'로 평면 표시
    dashCtl(zone, { gear: { title: '내 프로젝트 설정', open: (a) => projOpenOvPrefs(ctx, a) }, action: { href: '#/projects2', title: '프로젝트 탭으로' } });
    ctx.draw(); // 먼저 localStorage 캐시로 즉시 렌더(네트워크 대기 없이)
    dashPrefsSync().then((changed) => { if (changed && zone.body.isConnected)
        ctx.draw(); }); // #1129 서버(계정) 정본 반영 → 필요 시 재렌더
}
// 프로젝트 태그 칩(비인터랙티브) — 프로젝트 탭 pjvRowTagsEl 와 동일 마크업, 최대 2 + "+N".
function dashRowTags(p) {
    const cur = (p.tags || []);
    if (!cur.length)
        return null;
    const wrap = el('span', { class: 'pjv-trow-tags' });
    for (const tg of cur.slice(0, 2))
        wrap.append(el('span', { class: 'pjv-trow-tag', style: '--tag:' + (tg.color || 'var(--muted)'), title: tg.name }, el('span', { class: 'pjv-trow-tag-name', text: tg.name })));
    if (cur.length > 2)
        wrap.append(el('span', { class: 'pjv-trow-tag-more', text: '+' + (cur.length - 2) }));
    return wrap;
}
// #req 프로젝트 행 '⋯' 관리 메뉴 — 삭제(POST /projects/:id/delete). onChanged=위젯 새로고침.
function openProjRowMenu(anchor, p, onChanged) {
    const panel = el('div', { class: 'dash-pop-panel' });
    let close = () => { };
    const del = el('button', { class: 'dash-pop-opt danger', type: 'button' }, el('span', { class: 'dash-pop-name', text: '삭제' }));
    del.onclick = async () => {
        close();
        if (!confirm('프로젝트 ‘' + (p.name || '') + '’을(를) 삭제할까요?\n하위 태스크·세션 연결 포함 되돌릴 수 없어요.'))
            return;
        try {
            await api('/api/ui/v6/projects/' + p.id + '/delete', { method: 'POST', body: '{}' });
            toast('프로젝트를 삭제했어요');
            onChanged && onChanged();
        }
        catch (e) {
            toast('삭제 실패 — ' + (e && e.message || e), true);
        }
    };
    panel.append(del);
    close = dashPopover(anchor, panel);
}
// 하위태스크 아이콘 클릭 → 그 프로젝트의 태스크 목록 팝오버(#req). 클릭 시 프로젝트 상세로.
async function openProjTasksPopover(anchor, p, onWidgetChanged) {
    const panel = el('div', { class: 'dash-pop-panel dash-listpop' });
    const mode = dashTaskCountMode();
    panel.append(el('div', { class: 'dash-pop-head' }, el('strong', { title: p.name, text: p.name }), el('span', { class: 'dash-pop-sub', text: mode === 'active' ? '진행 중 태스크' : '태스크' })));
    const box = el('div', { class: 'dash-listpop-body' });
    box.append(skeleton('불러오는 중'));
    panel.append(box);
    dashPopover(anchor, panel);
    const isTaskDone = (t) => t.status === 'done' || t.status_category === 'done' || t.status_category === 'closed';
    const load = async () => {
        let d;
        try {
            d = await api('/api/ui/v6/projects/' + p.id);
        } // ⚠ 응답은 { project: {...tasks} } — d.project.tasks
        catch (e) {
            box.replaceChildren(errorNote(e, '태스크를 불러오지 못했습니다'));
            return;
        }
        let tasks = (d && (d.project ? d.project.tasks : d.tasks)) || [];
        if (mode === 'active')
            tasks = tasks.filter((t) => !isTaskDone(t)); // 칩(진행 중만)과 일치 — 할 일도 active 포함
        if (!tasks.length) {
            box.replaceChildren(el('div', { class: 'dash-pop-desc', text: mode === 'active' ? '진행 중인 태스크가 없어요.' : '태스크가 없어요.' }));
            return;
        }
        const onChanged = () => { load(); onWidgetChanged && onWidgetChanged(); }; // 상태 바꾸면 목록 재로드 + 위젯 새로고침(칩 수)
        box.replaceChildren(...tasks.map((t) => el('div', { class: 'dash-listpop-row dash-listpop-task', title: t.name || '' }, dashTaskStatusControl(t, onChanged), el('a', { class: 'dash-listpop-nm', href: '#/projects2/p/' + p.id, text: t.name || '(제목 없음)' }))));
    };
    load();
}
// 세션 배지 클릭 → 들어갈 세션 선택(#req). 1개면 바로 열기, 여러 개면 팝아웃 선택.
async function openProjSessionsPicker(anchor, p) {
    let sess;
    // #req 버그수정 — /terminal/sessions 는 프로젝트 세션을 숨긴다(터미널 탭 정책). 프로젝트 세션은 /projects/:id/sessions 에서 받고 내 것(owned)만.
    try {
        const d = await api('/api/ui/v6/projects/' + p.id + '/sessions');
        sess = ((d && d.sessions) || []).filter((s) => s.owned);
    }
    catch {
        toast('세션을 불러오지 못했습니다', true);
        return;
    }
    const openSess = (s) => dashOpenSessionTab(s.id, s.label || '', (s.node && s.node.id) || '');
    if (!sess.length) {
        toast('이 프로젝트의 내 세션이 없어요.');
        return;
    }
    if (sess.length === 1) {
        openSess(sess[0]);
        return;
    }
    const panel = el('div', { class: 'dash-pop-panel dash-listpop' });
    panel.append(el('div', { class: 'dash-pop-head' }, el('strong', { title: p.name, text: p.name }), el('span', { class: 'dash-pop-sub', text: '들어갈 세션' })));
    let close = () => { };
    for (const s of sess.sort((a, b) => (b.attached ? 1 : 0) - (a.attached ? 1 : 0))) {
        const row = el('button', { class: 'dash-listpop-row', type: 'button', title: s.label || '' }, el('span', { class: 'dash-listpop-dot', style: 'background:' + (s.attached ? '#22c55e' : '#94a3b8') }), el('span', { class: 'dash-listpop-nm', text: s.label || '(이름 없음)' }), s.attached ? el('span', { class: 'dash-listpop-live', text: '접속중' }) : null);
        row.onclick = () => { close(); openSess(s); };
        panel.append(row);
    }
    close = dashPopover(anchor, panel);
}
export { fillProjects, projRefillListById, dashRowTags, openProjRowMenu, openProjTasksPopover, openProjSessionsPicker };

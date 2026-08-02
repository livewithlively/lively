// taskmodal/shell.ts — #1313 R56: web/taskmodal.ts 섹션 분할 ⑧(모달 셸).
//  Activity 폭 리사이저 · 열린 모달 싱글턴/주소 소유(#810)·스크롤 계약(#1233-1) · 태스크 딥링크 라우트 ·
//  pjvOpenTaskModal(열기/닫기/재조회/재렌더) + 좌측 조립(상단바·제목·필드 그리드·본문·하위·연결).
//  ⚠ 아래 셋은 모달 셸의 클로저 상태(dirty·closeModal·pasteCtx·bodyEditor)를 잡으므로 여기 남는다 —
//   pjvtmDescription(bodyEditor 소유) · pjvtmSubtasks(드릴인) · pjvtmLinks(드릴인). 나머지 섹션은 순수 조립이라 적출됐다.
import { api, el, errorNote, toast } from '../core.js';
import { mountBodyEditor, pjvGridTemplate, pjvKeepScrollForNextRender, pjvPatchTask, pjvProjectModalOpen, pjvReloadKeepScroll, pjvRestoreScroll, pjvScrollTopNow, pjvSkipNextRouteRender, pjvStatusIconStd, pjvStatusMeta, pjvTaskRow, renderProjectV2Detail, uploadBodyFile } from '../projects.js';
import { pjvFmtClock, pjvtmSafeUrl } from './util.js';
import { pjvtmAssigneeField, pjvtmCustomFields, pjvtmDatesField, pjvtmFieldRow, pjvtmPriorityField, pjvtmStatusField, pjvtmTimeField } from './fields.js';
import { pjvtmTagsField } from './tags.js';
import { PJV_LINK_TYPE, pjvtmChecklists, pjvtmLinkPop } from './blocks.js';
import { pjvtmAttachments, pjvtmPasteImage } from './attachments.js';
import { pjvtmSide } from './activity.js';
// 본문(좌) ↔ Activity(우) 경계 드래그로 폭 조절(#496) — box(.pjv-tm)의 --pjv-side-w(우측 폭)를 조절하고 localStorage 저장.
//  더블클릭 = 기본값 리셋. box 는 재렌더(refresh)해도 유지되므로 변수/복원을 box 에 건다.
function pjvtmSideResizer(box) {
    const r = el('div', { class: 'pjv-tm-resizer', title: '드래그하여 Activity 폭 조절 (더블클릭: 기본값)', 'aria-hidden': 'true' });
    r.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const side = box.querySelector('.pjv-tm-side');
        if (!side)
            return;
        const startX = e.clientX;
        const startW = side.getBoundingClientRect().width;
        const boxW = box.getBoundingClientRect().width;
        const maxW = Math.max(320, Math.min(720, boxW - 360)); // 본문 최소폭 확보
        document.body.classList.add('pjv-tm-resizing');
        const onMove = (ev) => {
            let w = startW + (startX - ev.clientX); // 경계를 왼쪽으로 끌면 Activity(우측)가 넓어짐
            w = Math.max(300, Math.min(maxW, w));
            box.style.setProperty('--pjv-side-w', Math.round(w) + 'px');
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.classList.remove('pjv-tm-resizing');
            const cur = box.style.getPropertyValue('--pjv-side-w');
            if (cur) {
                try {
                    localStorage.setItem('pjv:tmSideW', cur.trim());
                }
                catch (_) { /* noop */ }
            }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
    r.addEventListener('dblclick', (e) => {
        e.preventDefault();
        box.style.removeProperty('--pjv-side-w');
        try {
            localStorage.removeItem('pjv:tmSideW');
        }
        catch (_) { /* noop */ }
    });
    return r;
}
let _pjvTmOpen = null;
// 모달이 소유한 히스토리 항목 — ret = 그 직전 해시(= 모달 '뒤'에 있는 것: 프로젝트 모달·프로젝트 페이지·보드).
let _pjvTmUrl = null;
// 태스크 모달 스택에 들어오기 **직전**의 스크롤(#1233-1). 모달이 열리며 body 에 overflow:hidden 이 붙는 순간
//  브라우저가 스크롤을 클램프해 버려(실측: 1000 → 321) 닫을 때 읽으면 이미 밀린 값이다. 그래서 '들어오기 전'에
//  잡아 둔다. 드릴인(swap)으로 모달이 교체돼도 첫 진입값을 그대로 이어받는다 — 뒤 화면은 계속 같은 자리다.
let _pjvTmEntryY = null;
// 라우터가 호출 — 새 주소가 이 모달의 주소면 살려두고(true) 아니면 닫는다. true 면 라우터는 뒤 화면도 안 그린다(#810).
function pjvCloseTaskModalOnRoute() {
    if (!_pjvTmOpen)
        return false;
    if (_pjvTmOpen.url === location.hash)
        return true;
    _pjvTmOpen.close('route');
    return false;
}
// undo 등이 '지금 화면'을 다시 그려야 할 때 — 이 모달이 주소의 주인이면 라우터가 안 도니 모달 안을 직접 갱신(#810).
function pjvTaskModalRefreshIfRoute() {
    if (!_pjvTmOpen || _pjvTmOpen.url !== location.hash)
        return false;
    _pjvTmOpen.refresh();
    return true;
}
// 태스크 딥링크 라우트(#810) — '#/projects2/t/<id>' 로 콜드 로드(공유 링크·새로고침·앞으로가기) 진입했을 때.
//  태스크는 전용 페이지가 없다(모달이 곧 상세) → **소속 프로젝트 페이지를 뒤에 그리고 그 위에 태스크 모달**을 연다
//  (클릭업의 모달 레이아웃 = '열었던 위치가 뒤에 보인다'와 같은 결). 주소를 먼저 그 프로젝트로 replace 해 두면 모달이
//  평소처럼 자기 주소를 push 하므로, 닫으면(뒤로) 자연스럽게 그 프로젝트로 돌아온다 — 히스토리가 모달 스택과 일치한다.
//  서브태스크도 같은 주소 체계다(부모를 경로에 넣지 않는 평면 id — 클릭업 '/t/<id>' 와 동형).
async function pjvRenderTaskRoute(view, taskIdStr) {
    const id = Number(taskIdStr);
    let d;
    try {
        d = await api('/api/ui/v6/tasks/' + id + '/detail');
    }
    catch (e) {
        view.replaceChildren(errorNote(e, '태스크를 불러오지 못했습니다'));
        return;
    }
    const pid = d && d.project && d.project.id;
    if (!pid) {
        view.replaceChildren(el('div', { class: 'note', text: '태스크를 찾을 수 없습니다.' }));
        return;
    }
    try {
        history.replaceState(null, '', '#/projects2/p/' + pid);
    }
    catch (_) { /* noop */ }
    const reload = () => renderProjectV2Detail(view, String(pid));
    const bg = reload(); // 뒤 화면(프로젝트 페이지)은 그리는 중에
    pjvOpenTaskModal(id, reload); // 모달은 곧바로 띄운다(자체 '불러오는 중…' 표시 → 딥링크가 빈 화면으로 안 보임)
    await bg;
}
// 모달 열기 — pageReload 는 리스트뷰 재페인트(변경 시 닫을 때 호출). 하위/연결 태스크로 점프 가능.
function pjvOpenTaskModal(taskId, pageReload) {
    // 주소는 지금 보고 있는 것을 가리킨다(#810). pushState 는 hashchange 를 안 쏘므로 라우터가 돌지 않는다 —
    //  돌면 라우터의 모달 정리가 방금 연 모달을 닫는 자충수가 된다(#808 과 같은 이유).
    const url = '#/projects2/t/' + taskId;
    if (!_pjvTmUrl)
        _pjvTmEntryY = pjvScrollTopNow(); // 첫 진입에서만 — 드릴인은 이 값을 이어받는다(#1233-1)
    if (_pjvTmUrl) {
        try {
            history.replaceState(null, '', url);
        }
        catch (_) { /* noop */ } // 드릴인 교체(상위·하위·연결 태스크)
    }
    else if (location.hash !== url) {
        const ret = location.hash || '#/';
        try {
            history.pushState(null, '', url);
            _pjvTmUrl = { ret };
        }
        catch (_) { /* noop */ }
    }
    let dirty = false;
    let tickTimer = null;
    let pasteCtx = null; // 클립보드 붙여넣기 대상 — render 에서 {pid, taskId, refresh} 로 갱신
    // 본문(설명) 블록 에디터(#730) — 항시 편집·자동저장. 모달 닫힘/재렌더 시 flush(미저장 저장)+destroy.
    let bodyEditor = null;
    const back = el('div', { class: 'pjv-tm-back' });
    const box = el('div', { class: 'pjv-tm' });
    // Activity 패널 폭 복원(#496) — 저장돼 있으면 기본값 대신 그 폭으로. box 는 재렌더에도 유지.
    try {
        const _sw = localStorage.getItem('pjv:tmSideW');
        if (_sw)
            box.style.setProperty('--pjv-side-w', _sw.indexOf('px') >= 0 ? _sw : (_sw + 'px'));
    }
    catch (_) { /* noop */ }
    back.append(box);
    // 바깥(배경) 클릭 — 본문 편집 중이면 먼저 저장하고 모달은 유지(한 번 더 눌러야 닫힘). 아니면 닫기.
    back.addEventListener('mousedown', (e) => {
        if (e.target !== back)
            return;
        closeModal(); // closeModal 이 본문 flush(자동저장)까지 처리
    });
    const onKey = (e) => {
        if (e.key !== 'Escape')
            return;
        const pb = document.querySelector('.pjv-tm-paste-back');
        if (pb) {
            pb._cancel && pb._cancel();
            return;
        } // 붙여넣기 다이얼로그가 떠 있으면 그것부터 닫기
        // 본문 블록 에디터의 팝업(슬래시·전환·링크·블록메뉴·멘션) 또는 오버레이가 떠 있으면 Esc 는 그쪽이 처리 — 모달은 유지.
        if (document.querySelector('.be-slash, .be-turnpop, .be-linkpop, .be-blockmenu, .be-mentionmenu, .ov-back'))
            return;
        if (!document.querySelector('.pjv-pop'))
            closeModal();
    };
    // 클립보드 이미지 붙여넣기(Ctrl/⌘+V) — 이 태스크 첨부폴더로 업로드(터미널 붙여넣기와 같은 결).
    //  이미지가 있을 때만 가로채고, 텍스트 등 비-이미지 붙여넣기는 기본 동작 그대로 통과시킨다.
    const onPaste = (e) => {
        if (!pasteCtx || pasteCtx.pid == null)
            return;
        // #730 본문 블록 에디터 안에서의 붙여넣기는 에디터가 인라인 이미지로 처리 — 여기서 가로채지 않는다(첨부로 새지 않게).
        const tgt = e.target;
        if (tgt && tgt.closest && tgt.closest('.be'))
            return;
        if (document.querySelector('.pjv-tm-paste-back'))
            return; // 이미 다이얼로그 열림
        const dt = e.clipboardData;
        if (!dt)
            return;
        let blob = null;
        for (const it of (dt.items || [])) {
            if (it.kind === 'file' && /^image\//.test(it.type || '')) {
                blob = it.getAsFile();
                break;
            }
        }
        if (!blob)
            for (const f of (dt.files || [])) {
                if (/^image\//.test(f.type || '')) {
                    blob = f;
                    break;
                }
            }
        if (!blob)
            return; // 이미지 없음 → 기본 붙여넣기 유지
        e.preventDefault();
        e.stopImmediatePropagation(); // 모달이 우선 — 프로젝트 상세의 전역 paste 핸들러(공유폴더 업로드)가 같은 이벤트를 또 잡지 않게 차단(capture 단계라 bubble 전역 핸들러보다 먼저 실행됨)
        pjvtmPasteImage(blob, { pid: pasteCtx.pid, dir: '_attachments/task-' + pasteCtx.taskId, base: '/api/ui/v6/projects/', refresh: pasteCtx.refresh }, back);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('paste', onPaste, true);
    document.body.append(back);
    document.body.classList.add('pjv-tm-open');
    //  url = 이 모달이 소유한 주소(라우터가 '살려둘지' 판단 · #810), refresh = 모달 안만 다시 그리기(undo 등)
    _pjvTmOpen = { close: closeModal, url, refresh }; // 라우트 변경 시 라우터가 닫거나 살려둘 수 있게(#804·#810)
    // 본문 flush(자동저장)는 어느 경로든 그대로 수행한다. mode 별 히스토리·재렌더 계약은 위 PjvTmClose 주석 참고.
    let tmClosed = false;
    function closeModal(mode = 'user') {
        if (tmClosed)
            return;
        tmClosed = true;
        if (_pjvTmOpen && _pjvTmOpen.close === closeModal)
            _pjvTmOpen = null;
        // 어떤 경로로 닫더라도(✕·Esc·바깥클릭) 편집 중인 본문은 먼저 저장(flush)해 유실 방지(#139-6, #730).
        if (bodyEditor) {
            try {
                bodyEditor.flush();
                bodyEditor.destroy();
            }
            catch (_) { /* noop */ }
            bodyEditor = null;
        }
        if (tickTimer)
            clearInterval(tickTimer);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('paste', onPaste, true);
        document.body.classList.remove('pjv-tm-open');
        back.remove();
        // 뒤 화면이 보고 있던 자리 = 모달을 **열기 직전** 값(#1233-1). 지금 읽으면 이미 클램프된 뒤라 소용없다.
        const backY = _pjvTmEntryY != null ? _pjvTmEntryY : pjvScrollTopNow();
        if (mode !== 'swap')
            _pjvTmEntryY = null; // 스택을 완전히 빠져나갈 때만 버린다(드릴인은 유지)
        // 주소 되돌리기(#810) — 우리가 넣은 항목을 pop 하면 뒤에 있던 주소로 돌아간다(프로젝트 모달 · 프로젝트 페이지 · 보드).
        let popped = false;
        let retHash = null; // 돌아갈 주소 — 아래에서 '그 페이지는 이미 그려져 있다'고 라우터에 알릴 때 쓴다
        if (mode === 'user') {
            if (_pjvTmUrl) {
                retHash = _pjvTmUrl.ret;
                _pjvTmUrl = null;
                try {
                    history.back();
                    popped = true;
                }
                catch (_) { /* noop */ }
            }
        }
        else if (mode !== 'swap') {
            _pjvTmUrl = null; // 'route' — 주소는 이미(또는 곧) 다른 곳에 있다
        }
        // pop 하면 그 hashchange 로 라우터가 뒤 화면을 다시 그린다 → pageReload 는 생략(이중 렌더 방지). 단 **프로젝트 모달이
        //  그 주소의 주인이면 라우터는 살려두느라 아무것도 안 그린다**(#810) → 그땐 여기서 그 모달 안을 갱신해야 한다.
        // ⚠ '모달을 닫으면 새로고침돼서 상단으로 감'(#1233-1)의 근본 원인은 **뒤 화면을 다시 그리는 것 자체**다.
        //  뒤 화면은 모달 아래에 멀쩡히 살아 있는데, pop 이 만든 hashchange 로 라우터가 같은 페이지를 처음부터
        //  재렌더한다 → 스켈레톤·섹션 순차 로드로 문서가 출렁이고 스크롤이 클램프된다. 그래서 그 렌더를 건너뛴다.
        //  내용이 바뀌었을 때만(dirty) 조용한 재조회를 돌리고, 그때도 보던 자리를 지킨다.
        const routerWillRedraw = popped && !pjvProjectModalOpen();
        if (routerWillRedraw) {
            pjvSkipNextRouteRender(retHash); // 그 주소는 이미 화면에 있다 — 라우터는 손대지 않는다
            pjvKeepScrollForNextRender(backY); // 혹시 다른 경로로 그려지더라도 자리는 지킨다(방어)
            if (dirty && pageReload)
                pjvReloadKeepScroll(pageReload);
        }
        else if (dirty && pageReload && mode !== 'route') {
            pjvReloadKeepScroll(pageReload); // 프로젝트 모달 안 — 우리가 직접 그린다(동기 소비)
        }
        // 재렌더 여부와 무관하게 자리를 되돌린다 — 여는 순간 클램프된 것을 여기서 푼다(overflow 해제 직후라야 먹는다).
        if (mode !== 'swap')
            pjvRestoreScroll(backY);
    }
    box.append(el('div', { class: 'pjv-tm-loading' }, '불러오는 중…'));
    load();
    async function load() {
        let d;
        try {
            d = await api('/api/ui/v6/tasks/' + taskId + '/detail');
        }
        catch (e) {
            box.replaceChildren(el('div', { class: 'pjv-tm-loading' }, errorNote ? errorNote(e, '태스크를 불러오지 못했습니다') : ('실패 — ' + e.message), el('button', { class: 'btn btn-ghost btn-sm', text: '닫기', onclick: () => closeModal() })));
            return;
        } // 참조로 넘기면 MouseEvent 가 mode 인자로 샌다(#810)
        render(d);
    }
    // 편집 후 부분 갱신: 서버가 돌려준 조각으로 d 를 갱신하고 해당 영역만 다시 그릴 수도 있으나, 단순·정확을 위해 전체 재페치.
    function refresh() { dirty = true; load(); }
    function render(d) {
        if (tickTimer) {
            clearInterval(tickTimer);
            tickTimer = null;
        }
        // 재렌더 전 본문 에디터 정리 — 미저장분 flush + 리스너/툴바 destroy(중복 방지). 새 본문 섹션이 다시 마운트.
        if (bodyEditor) {
            try {
                bodyEditor.flush();
                bodyEditor.destroy();
            }
            catch (_) { /* noop */ }
            bodyEditor = null;
        }
        const t = d.task;
        pasteCtx = { pid: d.project && d.project.id, taskId: t.id, refresh }; // 클립보드 붙여넣기 대상 갱신
        const members = d.members || [];
        const _prevMain = box.querySelector('.pjv-tm-main');
        const _prevScroll = _prevMain ? _prevMain.scrollTop : 0;
        box.replaceChildren(pjvtmMain(d, t, members, refresh, closeModal, pageReload), pjvtmSideResizer(box), // 본문↔Activity 경계 드래그 핸들(#496)
        pjvtmSide(d, t, refresh));
        const _newMain = box.querySelector('.pjv-tm-main');
        if (_newMain && _prevScroll)
            _newMain.scrollTop = _prevScroll;
        // 실행중 타이머 라이브 틱
        const running = d.time && d.time.running;
        if (running) {
            const elc = box.querySelector('.pjv-tm-timer-live');
            const base = d.time.total_seconds || 0;
            const startedMs = new Date(running.started_at).getTime();
            const upd = () => { if (elc)
                elc.textContent = pjvFmtClock(base + (Date.now() - startedMs) / 1000); };
            upd();
            tickTimer = setInterval(upd, 1000);
        }
    }
    // ── 좌측(상세) ──
    function pjvtmMain(d, t, members, refresh, closeModal, pageReload) {
        const main = el('div', { class: 'pjv-tm-main' });
        // 상단바: 브레드크럼(프로젝트 / 상위태스크 / …) + 닫기. 하위태스크면 직전 층위(상위 태스크)까지 하이퍼링크(#139-5).
        main.append(el('div', { class: 'pjv-tm-top' }, el('div', { class: 'pjv-tm-crumb' }, 
        // 프로젝트 크럼 — 그 프로젝트로 간다. 태스크 모달이 자기 주소를 갖게 되면서(#810) 두 경우로 갈린다:
        //  · 바로 뒤가 이미 그 프로젝트면(프로젝트 모달 위 중첩 · 프로젝트 페이지 위 · 태스크 딥링크) → 태스크 모달만
        //    닫으면 드러난다. 우리가 넣은 항목을 pop 하면 그 주소로 돌아가고, 라우터가 프로젝트 모달을 살려두거나 페이지를 그린다.
        //  · 그 외(보드·대시보드에서 열었다) → 실제로 그 프로젝트로 이동한다(히스토리는 우리가 옮기므로 모달은 'route' 로 닫는다).
        d.project ? (() => {
            const href = '#/projects2/p/' + d.project.id;
            const a = el('a', { class: 'pjv-tm-crumb-link', href, text: d.project.name });
            a.onclick = (e) => {
                if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
                    return; // ⌘/중클릭 = 새 탭
                e.preventDefault();
                if (_pjvTmUrl && _pjvTmUrl.ret === href) {
                    closeModal('user');
                    return;
                } // 뒤가 이미 그 프로젝트
                closeModal('route');
                location.hash = href;
            };
            return a;
        })() : null, d.project ? el('span', { class: 'pjv-tm-crumb-sep', text: ' /' }) : null, d.parent ? el('a', { class: 'pjv-tm-crumb-link', href: '#', title: '상위 태스크로 돌아가기',
            text: d.parent.name,
            onclick: (e) => { e.preventDefault(); dirty = true; closeModal('swap'); pjvOpenTaskModal(d.parent.id, pageReload); } }) : null, d.parent ? el('span', { class: 'pjv-tm-crumb-sep', text: ' /' }) : null), 
        // ⚠ onclick: closeModal (참조) 로 넘기면 MouseEvent 가 첫 인자(mode)로 샌다 — 옛 skipReload 시절엔 truthy 라
        //  ✕ 로 닫을 때 pageReload 가 조용히 스킵됐고(#810 에서 발견), 지금은 주소 복원이 깨진다. 반드시 감싸서 호출.
        el('button', { class: 'pjv-tm-x', type: 'button', title: '닫기 (Esc)', text: '✕', onclick: () => closeModal() })));
        // 타입 pill + 하위수 + 원본 링크(#541) — 외부 이관 태스크(external_url)면 원 시스템으로 새 탭 점프.
        const subs = t.subtasks || [];
        const extUrl = pjvtmSafeUrl(t.external_url);
        main.append(el('div', { class: 'pjv-tm-typebar' }, el('span', { class: 'pjv-tm-typepill' }, el('span', { class: 'pjv-tm-typedot' }), el('span', { text: t.level === 'subtask' ? 'Subtask' : 'Task' })), subs.length ? el('span', { class: 'pjv-tm-subcount', title: subs.length + '개 하위', text: '⌥ ' + subs.length }) : null, extUrl ? el('a', { class: 'pjv-tm-extlink', href: extUrl, target: '_blank', rel: 'noopener',
            title: '원본 태스크로 이동(새 탭)',
            text: (t.external_system === 'clickup' ? 'ClickUp' : '원본') + '에서 열기 ↗' }) : null));
        // 제목(편집 가능)
        const titleIn = el('textarea', { class: 'pjv-tm-title', rows: '1', maxlength: '200', spellcheck: 'false' });
        titleIn.value = t.name || '(제목 없음)';
        const autoGrow = () => { titleIn.style.height = 'auto'; titleIn.style.height = titleIn.scrollHeight + 'px'; };
        setTimeout(autoGrow, 0);
        titleIn.addEventListener('input', autoGrow);
        // 마지막 저장값을 추적해 같은 값이 두 번 저장(=activity 중복 기록)되는 것을 막는다(#293).
        let lastSavedName = t.name;
        const saveTitle = () => {
            const v = titleIn.value.trim();
            if (v && v !== lastSavedName) {
                lastSavedName = v;
                pjvPatchTask(t.id, { name: v }, refresh);
            }
        };
        titleIn.addEventListener('blur', saveTitle);
        // 한글(IME) 조합 중의 Enter 는 마지막 글자 '확정'용이다. 그때 blur→저장하면 조합 중 값이 저장돼
        // 마지막 글자가 중복되고(생각해보기→생각해보기기) 저장이 두 번 일어난다(#293). 조합이 끝난 Enter 에서만 저장.
        titleIn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                titleIn.blur();
            }
        });
        main.append(titleIn);
        // 필드 그리드(2열): 좌(상태·기간·시간추적) 우(담당자·우선순위·태그)
        main.append(el('div', { class: 'pjv-tm-fields' }, pjvtmFieldRow('◎', '상태', pjvtmStatusField(t, refresh, d.list)), pjvtmFieldRow('👤', '담당자', pjvtmAssigneeField(t, members, refresh)), pjvtmFieldRow('🗓', '기간', pjvtmDatesField(t, refresh)), pjvtmFieldRow('⚑', '우선순위', pjvtmPriorityField(t, refresh)), pjvtmFieldRow('⏱', '시간 추적', pjvtmTimeField(d, t, refresh)), pjvtmFieldRow('🏷', '태그', pjvtmTagsField(d, t, refresh))));
        // 커스텀 필드(#541) — 루트 프로젝트 정의(detail.fields)를 리스트뷰 셀 컨트롤로 편집(낙관 저장).
        main.append(pjvtmCustomFields(d, t, refresh));
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
    // 설명(본문) — #730 프로젝트 탭 '본문'(projectBodySection)과 동일한 노션형 블록 에디터로 통일. 항시 편집·자동저장.
    //  슬래시(/) 명령·블록 드래그·선택 툴바·이미지 붙여넣기/드롭. 미저장분은 모달 닫힘·재렌더 시 flush(closeModal/render).
    function pjvtmDescription(t, refresh) {
        const sec = el('div', { class: 'pjv-tm-desc' });
        const bodyWrap = el('div', { class: 'proj-body-sec' });
        sec.append(bodyWrap);
        // 첨부 업로드용 프로젝트 id — /file 라우트는 루트 프로젝트 폴더를 쓰므로 pasteCtx.pid(=d.project.id) 사용.
        const pid = (pasteCtx && pasteCtx.pid != null) ? pasteCtx.pid : t.id;
        bodyEditor = mountBodyEditor({
            initial: t.description || '',
            placeholder: '본문을 입력하세요.  ‘/’ 로 블록 삽입 · 이미지 붙여넣기/드롭',
            uploadFile: (file) => uploadBodyFile(pid, '_attachments/task-' + t.id, file),
            save: async (md) => {
                t.description = md;
                dirty = true;
                await api('/api/ui/v6/tasks/' + t.id, { method: 'POST', body: JSON.stringify({ description: md || null }) });
            },
        });
        bodyWrap.append(bodyEditor.el);
        return sec;
    }
    // 하위 태스크 — 프로젝트 탭 태스크 리스트(pjvTaskRow)를 그대로 재사용해 '이전 페이지와 정확히 똑같게'(#139-1,4).
    //  → 호버 시 [하위추가(상위만)·태그·이름변경] 버튼, ⋯메뉴(이름변경·삭제), 담당자/마감일/우선순위 컬럼·아이콘 위치가 리스트와 동일.
    //  제목 클릭 = 그 하위 모달로 '교체'(드릴인) — 리스트 기본 동작(스택 오픈)을 캡처 단계에서 가로채 현재 모달을 닫고 연다.
    function pjvtmSubtasks(d, t, members, refresh, pageReload) {
        if (t.level === 'subtask')
            return el('div'); // 하위태스크는 더 하위 없음(백엔드 제약)
        const subs = (t.subtasks || []);
        const openCount = subs.filter((s) => s.status !== 'done').length;
        const sec = el('div', { class: 'pjv-tm-block pjv-tm-subtasks pjv-tasks-card' });
        sec.append(el('div', { class: 'pjv-tm-block-head' }, el('span', { class: 'pjv-tm-block-title', text: '하위 태스크' }), el('span', { class: 'pjv-tm-block-count', text: openCount + ' open' })));
        // 컬럼 헤더 — 행 그리드와 동일 컬럼(이름/담당자/마감일/우선순위)으로 정렬(프로젝트 탭 thead 와 동형).
        const head = el('div', { class: 'pjv-tgroup-head pjv-tgroup-head-cols' }, el('div', { class: 'pjv-trow-title-cell' }, el('span', { class: 'pjv-row-check-spacer', 'aria-hidden': 'true' }), el('span', { class: 'pjv-colhead', text: '이름' })), el('div', { class: 'pjv-tcell pjv-colhead', text: '담당자' }), el('div', { class: 'pjv-tcell pjv-colhead', text: '마감일' }), el('div', { class: 'pjv-tcell pjv-colhead', text: '우선순위' }), el('div', { class: 'pjv-tcell pjv-tcell-add' }));
        head.style.gridTemplateColumns = pjvGridTemplate([]);
        sec.append(head);
        // 행 — pjvTaskRow 재사용(reload=모달 refresh). 커스텀 필드 컬럼은 모달에선 생략([]).
        const list = el('div', { class: 'pjv-tgroup-body' });
        for (const s of subs)
            list.append(pjvTaskRow(d.project.id, s, members, refresh, 0, []));
        // 제목(셀) 클릭 → 드릴인(현재 닫고 그 하위 모달 열기). 캐럿·상태점·체크·호버액션은 각자 동작하도록 통과.
        list.addEventListener('click', (e) => {
            const cell = e.target.closest && e.target.closest('.pjv-trow-title-cell');
            if (!cell || !list.contains(cell))
                return;
            if (e.target.closest('.pjv-trow-caret') || e.target.closest('.pjv-status-dot') || e.target.closest('.pjv-status-btn'))
                return;
            if (e.target.closest('.pjv-row-check') || e.target.closest('.pjv-row-actions'))
                return;
            const wrap = cell.closest('.pjv-trow-wrap');
            const sid = wrap && wrap.getAttribute('data-task-id');
            if (!sid)
                return;
            e.stopImmediatePropagation();
            e.preventDefault();
            dirty = true;
            closeModal('swap');
            pjvOpenTaskModal(Number(sid), pageReload); // 드릴인 — 주소는 그 하위 태스크로 replace(#810)
        }, true);
        sec.append(list);
        // 인라인 추가
        const addInput = el('input', { type: 'text', class: 'pjv-tm-sub-add', placeholder: '＋ 하위 태스크 추가 후 Enter', maxlength: '200' });
        let subBusy = false;
        const subCommit = async () => {
            const name = addInput.value.trim();
            if (!name || subBusy)
                return;
            subBusy = true;
            addInput.disabled = true;
            try {
                await api('/api/ui/v6/projects/' + d.project.id + '/tasks', { method: 'POST', body: JSON.stringify({ name, parent_task_id: t.id }) });
                refresh();
            }
            catch (err) {
                toast('실패 — ' + err.message, true);
                addInput.disabled = false;
                subBusy = false;
            }
        };
        addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') {
            e.preventDefault();
            subCommit();
        } });
        addInput.addEventListener('blur', () => { subCommit(); });
        sec.append(addInput);
        return sec;
    }
    // 의존성/연결 — 목록 + 추가(같은 프로젝트 내 검색).
    function pjvtmLinks(d, t, refresh) {
        const links = d.links || [];
        const sec = el('div', { class: 'pjv-tm-block' });
        sec.append(el('div', { class: 'pjv-tm-block-head' }, el('span', { class: 'pjv-tm-block-title', text: '의존성 / 연결' })));
        if (links.length) {
            const byType = {};
            for (const l of links)
                (byType[l.type] = byType[l.type] || []).push(l);
            for (const type of ['blocking', 'waiting_on', 'linked']) {
                if (!byType[type])
                    continue;
                const lt = PJV_LINK_TYPE[type];
                for (const l of byType[type]) {
                    const lmeta = pjvStatusMeta(l.status);
                    sec.append(el('div', { class: 'pjv-tm-link-row' }, el('span', { class: 'pjv-tm-link-type ' + type, text: lt.label }), pjvStatusIconStd(lmeta.bucket, 'sm'), 
                    // 드릴인 — 다른 드릴인(상위·하위)과 같은 순서로 '닫고(swap) 연다'. 반대로 하면 새 모달이 세운 상태(주소 소유·
                    //  body 잠금 클래스)를 옛 모달의 close 가 도로 지운다(#810).
                    el('button', { class: 'pjv-tm-link-name', type: 'button', text: l.name, onclick: () => { dirty = true; closeModal('swap'); pjvOpenTaskModal(l.id, pageReload); } }), el('button', { class: 'pjv-tm-link-x', type: 'button', title: '연결 해제', text: '✕',
                        onclick: async () => {
                            try {
                                await api('/api/ui/v6/tasks/' + t.id + '/links', { method: 'POST', body: JSON.stringify({ to_task: l.id, type, remove: true }) });
                                refresh();
                            }
                            catch (e) {
                                toast('실패 — ' + e.message, true);
                            }
                        } })));
                }
            }
        }
        const addBtn = el('button', { class: 'pjv-tm-block-add', type: 'button', text: '↻ 항목 연결 또는 의존성 추가' });
        addBtn.onclick = (e) => { e.stopPropagation(); pjvtmLinkPop(addBtn, d, t, refresh); };
        sec.append(addBtn);
        return sec;
    }
}
export { pjvCloseTaskModalOnRoute, pjvOpenTaskModal, pjvRenderTaskRoute, pjvTaskModalRefreshIfRoute };

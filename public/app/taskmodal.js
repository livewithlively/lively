// taskmodal.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
import { TOKEN_KEY, api, el, errorNote, personFace, relTime, renderMarkdown, sv, toast } from './core.js';
import { PJV_PRIORITY, PJV_PRIORITY_ORDER, authDownload, authUploadProgress, debounce, fileIconSvg, fmtSize, mountBodyEditor, openFileViewer, pjvAssignees, pjvAssigneeWrite, pjvCheckMini, pjvFmtDate, pjvGridTemplate, pjvIsOverdue, pjvPatchTask, pjvPopover, pjvProjectModalOpen, pjvSaveTask, pjvStatusIconStd, pjvStatusMeta, pjvTaskModalStatusField, pjvTaskRow, renderProjectV2Detail, upIsAbort, upProgress, upSend, upToast, uploadBodyFile } from './projects.js';
// 커스텀 필드 셀 컨트롤(pjvFieldControl) 재사용용 네임스페이스(#541) — projects.ts 는 동시 편집 중이라 직접
//  수정하지 않고, export 목록에 오르는 즉시 자동으로 붙는다(없으면 읽기전용 폴백 — pjvtmFieldReadonly).
import * as PJ from './projects.js';
// projects.ts 의 pjvFieldControl — 호출 시점 지연 조회(순환 import 안전 + export 추가를 즉시 반영).
function pjvtmFieldControlFn() { return PJ.pjvFieldControl || null; }
// 외부 URL 가드 — http(s) 만 허용(데이터 유래 href 의 javascript: 등 주입 차단).
function pjvtmSafeUrl(u) {
    const s = String(u || '').trim();
    return /^https?:\/\//i.test(s) ? s : null;
}
const PJV_LINK_TYPE = {
    blocking: { label: '막고 있음', short: 'blocking' },
    waiting_on: { label: '기다리는 중', short: 'waiting on' },
    linked: { label: '연결됨', short: 'linked' },
};
function pjvFmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h)
        return h + '시간 ' + (m ? m + '분' : '').trim();
    if (m)
        return m + '분 ' + (s ? s + '초' : '').trim();
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
const PJV_TM_ICONS = {
    plus: { p: [['circle', { cx: 12, cy: 12, r: 9 }], ['line', { x1: 12, y1: 8.5, x2: 12, y2: 15.5 }], ['line', { x1: 8.5, y1: 12, x2: 15.5, y2: 12 }]] },
    paperclip: { p: [['path', { d: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48' }]] },
    at: { p: [['circle', { cx: 12, cy: 12, r: 3.8 }], ['path', { d: 'M15.8 12v1.6a2.4 2.4 0 0 0 4.8 0V12a8.6 8.6 0 1 0-3.4 6.8' }]] },
    smile: { p: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M8.5 14.5a4 4 0 0 0 7 0' }], ['line', { x1: 9, y1: 9.5, x2: 9.01, y2: 9.5 }], ['line', { x1: 15, y1: 9.5, x2: 15.01, y2: 9.5 }]] },
    check: { p: [['rect', { x: 4, y: 4, width: 16, height: 16, rx: 3.5 }], ['polyline', { points: '8.5 12.4 11 15 16 9' }]] },
    video: { p: [['rect', { x: 3, y: 6, width: 13, height: 12, rx: 2 }], ['path', { d: 'M16 10l5-3v10l-5-3z' }]] },
    mic: { p: [['rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }], ['path', { d: 'M6 11.5a6 6 0 0 0 12 0' }], ['line', { x1: 12, y1: 17.5, x2: 12, y2: 21 }]] },
    more: { p: [['circle', { cx: 5.5, cy: 12, r: 1.5 }], ['circle', { cx: 12, cy: 12, r: 1.5 }], ['circle', { cx: 18.5, cy: 12, r: 1.5 }]], fill: true },
    like: { p: [['path', { d: 'M7 10.6V19H4.8A1.3 1.3 0 0 1 3.5 17.7v-5.8A1.3 1.3 0 0 1 4.8 10.6z' }], ['path', { d: 'M7 10.6l3.6-6.4a1.8 1.8 0 0 1 3.4.9V9h4.6a1.8 1.8 0 0 1 1.78 2.1l-1 6A1.8 1.8 0 0 1 18.6 19H7' }]] },
    send: { p: [['path', { d: 'M4.5 12 20 4.5 15.5 20l-4-6z' }], ['line', { x1: 11.5, y1: 14, x2: 20, y2: 4.5 }]] },
};
function pjvtmIcon(name) {
    const def = PJV_TM_ICONS[name] || PJV_TM_ICONS.plus;
    const n = sv('svg', { class: 'pjv-tm-ic', viewBox: '0 0 24 24', fill: def.fill ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': def.fill ? 0 : 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    for (const [t, a] of def.p)
        n.append(sv(t, a));
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
    if (!members || !members.length) {
        menu.append(el('div', { class: 'pjv-menu-empty', text: '팀원이 없어요' }));
        return;
    }
    for (const m of members) {
        const nm = m.display_name || m.member_id;
        const item = el('button', { class: 'pjv-menu-item', type: 'button' }, personFace(m.member_id, 'pjv-ava', nm), el('span', { text: nm }));
        item.onclick = () => { close(); insert('@' + nm + ' '); };
        menu.append(item);
    }
}
// 공유 폴더 첨부 — 파일 클릭 시 작성기에 [📎 이름](#file:상대경로) 마크다운 삽입(렌더 후 authDownload 로 다운로드).
function pjvtmAttachPicker(anchor, o) {
    const pid = o.d.project && o.d.project.id;
    if (!pid) {
        toast('이 태스크의 프로젝트 폴더를 찾을 수 없어요', true);
        return;
    }
    const B = '/api/ui/v6/projects/' + pid;
    const crumb = el('div', { class: 'pjv-files-crumb' });
    const rowsBox = el('div', { class: 'pjv-files-browser' });
    const close = pjvPopover(anchor, el('div', { class: 'pjv-field-editor pjv-files-editor' }, el('div', { class: 'pjv-files-head2', text: '공유 폴더에서 첨부' }), crumb, rowsBox));
    let curPath = '';
    const load = async () => {
        rowsBox.replaceChildren(el('div', { class: 'pjv-files-empty', text: '불러오는 중…' }));
        let data;
        try {
            data = await api(B + '/files?path=' + encodeURIComponent(curPath));
        }
        catch (e) {
            rowsBox.replaceChildren(el('div', { class: 'pjv-files-empty', text: '공유 폴더를 불러오지 못했어요' }));
            return;
        }
        crumb.replaceChildren(el('button', { class: 'pjv-files-crumb-btn', type: 'button', text: '루트', onclick: () => { curPath = ''; load(); } }));
        let acc = '';
        for (const p of (curPath ? curPath.split('/') : [])) {
            acc = acc ? acc + '/' + p : p;
            const tg = acc;
            crumb.append(el('span', { class: 'pjv-files-crumb-sep', text: '/' }), el('button', { class: 'pjv-files-crumb-btn', type: 'button', text: p, onclick: () => { curPath = tg; load(); } }));
        }
        rowsBox.replaceChildren();
        const items = data.items || [];
        if (!items.length) {
            rowsBox.append(el('div', { class: 'pjv-files-empty', text: '빈 폴더예요' }));
            return;
        }
        for (const it of items) {
            const childPath = curPath ? curPath + '/' + it.name : it.name;
            if (it.type === 'dir')
                rowsBox.append(el('button', { class: 'pjv-files-row dir', type: 'button', onclick: () => { curPath = childPath; load(); } }, fileIconSvg(it.name, true), el('span', { class: 'pjv-files-name', text: it.name }), el('span', { class: 'pjv-files-chev', text: '›' })));
            else
                rowsBox.append(el('button', { class: 'pjv-files-row file', type: 'button', onclick: () => { o.insertAtCursor('[📎 ' + it.name + '](#file:' + encodeURIComponent(childPath) + ') '); close(); } }, fileIconSvg(it.name, false), el('span', { class: 'pjv-files-name', text: it.name }), el('span', { class: 'pjv-files-size', text: fmtSize(it.size) })));
        }
    };
    load();
}
// 렌더된 댓글의 #file: 링크 → 클릭 시 인증 다운로드(평문 링크는 401 이므로 가로채 authDownload).
function pjvtmWireFileLinks(node, cctx) {
    if (!node || !node.querySelectorAll)
        return;
    node.querySelectorAll('a[href^="#file:"]').forEach((a) => {
        const rel = decodeURIComponent(a.getAttribute('href').slice(6));
        a.classList.add('pjv-tm-filelink');
        a.addEventListener('click', (e) => {
            e.preventDefault();
            if (!cctx.projectId) {
                toast('프로젝트 폴더를 찾을 수 없어요', true);
                return;
            }
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
function pjvOpenTaskModal(taskId, pageReload) {
    // 주소는 지금 보고 있는 것을 가리킨다(#810). pushState 는 hashchange 를 안 쏘므로 라우터가 돌지 않는다 —
    //  돌면 라우터의 모달 정리가 방금 연 모달을 닫는 자충수가 된다(#808 과 같은 이유).
    const url = '#/projects2/t/' + taskId;
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
        // 주소 되돌리기(#810) — 우리가 넣은 항목을 pop 하면 뒤에 있던 주소로 돌아간다(프로젝트 모달 · 프로젝트 페이지 · 보드).
        let popped = false;
        if (mode === 'user') {
            if (_pjvTmUrl) {
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
        const routerWillRedraw = popped && !pjvProjectModalOpen();
        if (dirty && pageReload && mode !== 'route' && !routerWillRedraw)
            pageReload();
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
    function pjvtmFieldRow(glyph, label, control) {
        return el('div', { class: 'pjv-tm-field' }, el('span', { class: 'pjv-tm-field-ico', 'aria-hidden': 'true', text: glyph }), el('span', { class: 'pjv-tm-field-label', text: label }), el('div', { class: 'pjv-tm-field-val' }, control));
    }
    // 상태 — #731 프로젝트/행과 동일한 디자인으로 통일. 소속 리스트가 커스텀 상태면 그 상태들(색·이름)을 pill+메뉴로,
    //  아니면 네이티브 3단계. d.list(리스트 상태 체계)로 판단. onPick 은 status(네이티브 투영)+status_raw(커스텀 키)를 함께 저장.
    function pjvtmStatusField(t, refresh, listStatus) {
        const ctrl = pjvTaskModalStatusField(t, listStatus, (patch) => pjvPatchTask(t.id, patch, refresh));
        // 원문 상태 칩(#541 무손실) — 커스텀 리스트면 raw 가 곧 커스텀 상태라 병기 불필요. 네이티브 리스트인데 이관 raw 가
        //  3상태 라벨과 다르면(예: 'in review') 읽기전용 병기. 네이티브 행은 status_raw=NULL 이라 표시 없음.
        const isCustom = !!(listStatus && listStatus.statusMode === 'custom' && Array.isArray(listStatus.statuses) && listStatus.statuses.length);
        const meta = pjvStatusMeta(t.status);
        const raw = String(t.status_raw || '').trim();
        if (!isCustom && raw && raw.toLowerCase() !== meta.label.toLowerCase() && raw.toLowerCase() !== String(t.status || '').toLowerCase()) {
            return el('span', { class: 'pjv-tm-statuswrap' }, ctrl, el('span', { class: 'pjv-tm-statusraw', title: '원본 상태(읽기전용): ' + raw, text: raw }));
        }
        return ctrl;
    }
    // 커스텀 필드(#541) — 루트 프로젝트의 task_field 정의별 한 행(라벨+셀 컨트롤). 컨트롤은 리스트뷰의
    //  pjvFieldControl(낙관 저장 포함)을 재사용, 아직 export 전이면 값만 읽기전용 노출(pjvtmFieldReadonly).
    function pjvtmCustomFields(d, t, refresh) {
        const fields = d.fields || [];
        if (!fields.length)
            return el('div');
        if (!t.field_values)
            t.field_values = d.field_values || {}; // pjvFieldControl 이 t.field_values 를 읽고/갱신
        const fieldControl = pjvtmFieldControlFn();
        const grid = el('div', { class: 'pjv-tm-fields pjv-tm-cfields' });
        for (const f of fields) {
            grid.append(pjvtmFieldRow('▤', f.name, fieldControl ? fieldControl(t, f, refresh) : pjvtmFieldReadonly(f, (t.field_values || {})[f.id])));
        }
        const sec = el('div', { class: 'pjv-tm-block pjv-tm-cfblock' });
        sec.append(el('div', { class: 'pjv-tm-block-head' }, el('span', { class: 'pjv-tm-block-title', text: '커스텀 필드' })));
        sec.append(grid);
        return sec;
    }
    // 읽기전용 값 폴백 — dropdown/labels 는 옵션 id→이름 치환, 그 외는 문자열화(textContent 만 — XSS 불변식).
    function pjvtmFieldReadonly(f, v) {
        const has = !(v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0));
        let txt = '';
        if (has) {
            const opts = (f.config && f.config.options) || [];
            // 옵션 shape 은 {id,label,color}(projects.ts pjvOptChip 동형) — name 은 구형/커넥터 원본 폴백.
            const optName = (idv) => { const o = opts.find((x) => x.id === idv); return o ? (o.label || o.name || String(idv)) : String(idv); };
            if (f.field_type === 'dropdown')
                txt = optName(v);
            else if (f.field_type === 'labels' && Array.isArray(v))
                txt = v.map(optName).join(', ');
            else if (Array.isArray(v))
                txt = v.map((x) => (x && typeof x === 'object' ? (x.name || x.id || '') : String(x))).join(', ');
            else if (typeof v === 'object')
                txt = JSON.stringify(v);
            else
                txt = String(v);
        }
        return el('span', { class: 'pjv-tm-cfield-ro' + (has ? '' : ' empty'), text: has ? txt : 'Empty' });
    }
    function pjvtmAssigneeField(t, members, refresh) {
        const nameOf = (id) => { const m = members.find((x) => x.member_id === id); return m ? (m.display_name || m.member_id) : id; };
        const btn = el('button', { class: 'pjv-tm-valbtn', type: 'button' });
        function render() {
            const ids = pjvAssignees(t);
            btn.className = 'pjv-tm-valbtn' + (ids.length ? '' : ' empty');
            if (ids.length) {
                const faces = el('span', { class: 'pjv-asg-faces' });
                for (const id of ids.slice(0, 4))
                    faces.append(personFace(id, 'pjv-ava', nameOf(id)));
                btn.replaceChildren(faces, el('span', { class: 'pjv-tm-valtext', text: ids.length === 1 ? nameOf(ids[0]) : ids.length + '명' }));
            }
            else {
                btn.replaceChildren(el('span', { text: 'Empty' }));
            }
        }
        btn.onclick = (e) => {
            e.stopPropagation();
            const menu = el('div', { class: 'pjv-menu pjv-asg-menu' });
            pjvPopover(btn, menu);
            const setIds = (ids) => { t.assignee = pjvAssigneeWrite(ids); render(); pjvSaveTask(t.id, { assignee: t.assignee }); rebuild(); };
            const none = el('button', { class: 'pjv-menu-item', type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '담당 없음' }));
            none.onclick = (ev) => { ev.stopPropagation(); setIds([]); };
            const itemsBox = el('div', {});
            menu.append(none, itemsBox);
            function rebuild() {
                const ids = pjvAssignees(t);
                none.className = 'pjv-menu-item' + (!ids.length ? ' sel' : '');
                itemsBox.replaceChildren(...members.map((m) => {
                    const on = ids.includes(m.member_id);
                    const item = el('button', { class: 'pjv-menu-item' + (on ? ' sel' : ''), type: 'button' }, personFace(m.member_id, 'pjv-ava', m.display_name || m.member_id), el('span', { class: 'pjv-asg-mname', text: m.display_name || m.member_id }), el('span', { class: 'pjv-asg-check', text: on ? '✓' : '' }));
                    item.onclick = (ev) => { ev.stopPropagation(); const c = pjvAssignees(t); setIds(c.includes(m.member_id) ? c.filter((x) => x !== m.member_id) : [...c, m.member_id]); };
                    return item;
                }));
                if (!members.length)
                    itemsBox.append(el('div', { class: 'pjv-menu-empty', text: '프로젝트 팀원을 먼저 추가하세요' }));
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
            const b = el('button', { class: 'pjv-tm-datebtn' + (val ? '' : ' empty') + (overdue ? ' overdue' : ''), type: 'button' }, el('span', { text: val ? pjvFmtDate(val) : ph }));
            b.onclick = (e) => {
                e.stopPropagation();
                const input = el('input', { type: 'date', class: 'pjv-date-input', value: val || '' });
                const wrapPop = el('div', { class: 'pjv-menu pjv-date-pop' }, input, val ? el('button', { class: 'pjv-menu-item danger', type: 'button', text: '지우기',
                    onclick: () => { close(); pjvPatchTask(t.id, { [field]: null }, refresh); } }) : null);
                const close = pjvPopover(b, wrapPop);
                setTimeout(() => { input.focus(); if (input.showPicker) {
                    try {
                        input.showPicker();
                    }
                    catch (_) { }
                } }, 0);
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
                const item = el('button', { class: 'pjv-menu-item' + (sel ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-flag ' + pm.cls }, el('span', { class: 'pjv-flag-glyph', text: '⚑' })), el('span', { text: pm.label }));
                item.onclick = () => { close(); if (!sel)
                    pjvPatchTask(t.id, { priority: key }, refresh); };
                menu.append(item);
            }
            const none = el('button', { class: 'pjv-menu-item' + (!t.priority ? ' sel' : ''), type: 'button' }, el('span', { class: 'pjv-cell-ph sm', text: '∅' }), el('span', { text: '없음' }));
            none.onclick = () => { close(); if (t.priority)
                pjvPatchTask(t.id, { priority: null }, refresh); };
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
            title: running ? '타이머 정지' : '타이머 시작' }, el('span', { text: running ? '⏸' : '▶' }), el('span', { text: running ? '정지' : 'Start' }));
        playBtn.onclick = async () => {
            playBtn.disabled = true;
            try {
                await api('/api/ui/v6/tasks/' + t.id + '/time', { method: 'POST', body: JSON.stringify({ action: running ? 'stop' : 'start' }) });
                refresh();
            }
            catch (e) {
                toast('실패 — ' + e.message, true);
                playBtn.disabled = false;
            }
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
            if (secs <= 0) {
                toast('시간을 입력하세요', true);
                return;
            }
            addBtn.disabled = true;
            try {
                await api('/api/ui/v6/tasks/' + t.id + '/time', { method: 'POST', body: JSON.stringify({ action: 'add', seconds: secs }) });
                close();
                refresh();
            }
            catch (e) {
                toast('실패 — ' + e.message, true);
                addBtn.disabled = false;
            }
        };
        pop.append(el('div', { class: 'pjv-tm-tmanual' }, el('span', { class: 'pjv-tm-tlabel', text: '수동 입력' }), hh, el('span', { text: '시간' }), mm, el('span', { text: '분' }), addBtn));
        // 엔트리 목록
        if (time.entries && time.entries.length) {
            const list = el('div', { class: 'pjv-tm-tentries' });
            for (const en of time.entries) {
                if (en.ended_at == null)
                    continue; // 실행중은 위 라이브 표시
                const row = el('div', { class: 'pjv-tm-tentry' }, el('span', { text: pjvFmtDuration(en.duration_seconds || 0) }), el('span', { class: 'pjv-tm-tentry-src', text: en.source === 'manual' ? '수동' : '타이머' }), el('button', { class: 'pjv-tm-tentry-x', type: 'button', title: '삭제', text: '✕',
                    onclick: async () => {
                        try {
                            await api('/api/ui/v6/tasks/' + t.id + '/time', { method: 'POST', body: JSON.stringify({ action: 'delete', entry_id: en.id }) });
                            close();
                            refresh();
                        }
                        catch (e) {
                            toast('실패 — ' + e.message, true);
                        }
                    } }));
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
            for (const tag of (d.tags || []))
                wrap.append(pjvtmTagChip(tag, () => removeTag(tag.id)));
            const addBtn = el('button', { class: 'pjv-tm-tagadd' + ((d.tags || []).length ? '' : ' empty'), type: 'button', text: (d.tags || []).length ? '＋' : 'Empty' });
            addBtn.onclick = (e) => { e.stopPropagation(); pjvtmTagPop(addBtn, d, t, render); };
            wrap.append(addBtn);
        };
        const removeTag = async (tagId) => {
            d.tags = (d.tags || []).filter((x) => x.id !== tagId);
            render();
            try {
                await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tagId, remove: true }) });
            }
            catch (e) {
                toast('실패 — ' + e.message, true);
            }
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
        let all = [];
        const loadAll = async () => { try {
            all = await api('/api/ui/v6/tags').then((r) => (r && r.tags) || []);
        }
        catch (_) {
            all = [];
        } };
        const selIds = () => new Set((d.tags || []).map((x) => x.id));
        await loadAll();
        function showList(query) {
            const input = el('input', { type: 'text', class: 'pjv-tm-taginput', placeholder: '태그 검색…', maxlength: '40', value: query || '' });
            const chips = el('div', { class: 'pjv-tm-tagpop-chips' });
            const list = el('div', { class: 'pjv-tm-tagresults' });
            const manageBtn = el('button', { class: 'pjv-tm-tagmanage-btn', type: 'button' }, pjvtmGearIcon(), el('span', { text: '모든 태그 관리' }));
            manageBtn.onclick = () => showManageAll();
            pop.replaceChildren(el('div', { class: 'pjv-tm-tagpop-top' }, chips, input), el('div', { class: 'pjv-tm-tagpop-head' }, el('span', { text: 'Select an option' })), list, manageBtn);
            setTimeout(() => { input.focus(); }, 0);
            const renderChips = () => chips.replaceChildren(...(d.tags || []).map((tag) => pjvtmTagChip(tag, () => persistRemove(tag.id))));
            const persistAdd = async (x) => {
                if (!selIds().has(x.id)) {
                    d.tags = [...(d.tags || []), x];
                    renderField();
                    renderChips();
                    renderList();
                }
                try {
                    await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: x.id }) });
                }
                catch (e) {
                    toast('실패 — ' + e.message, true);
                }
            };
            const persistRemove = async (tagId) => {
                d.tags = (d.tags || []).filter((x) => x.id !== tagId);
                renderField();
                renderChips();
                renderList();
                try {
                    await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: tagId, remove: true }) });
                }
                catch (e) {
                    toast('실패 — ' + e.message, true);
                }
            };
            const renderList = () => {
                const qq = input.value.trim();
                const have = selIds();
                const cand = all.filter((x) => (!qq || x.name.toLowerCase().includes(qq.toLowerCase())));
                list.replaceChildren();
                for (const x of cand.slice(0, 40)) {
                    const on = have.has(x.id);
                    const row = el('button', { class: 'pjv-tm-tagrow' + (on ? ' sel' : ''), type: 'button' }, pjvCheckMini(on), el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (x.color || PJV_TAG_NONE) }), el('span', { class: 'pjv-tm-tagrow-name', text: x.name }));
                    row.onclick = () => (on ? persistRemove(x.id) : persistAdd(x));
                    const gear = el('button', { class: 'pjv-tm-tagrow-gear', type: 'button', title: '태그 편집' }, pjvtmGearIcon());
                    gear.onclick = (e) => { e.stopPropagation(); showColor(x, input.value); };
                    row.append(gear);
                    list.append(row);
                }
                // 새 태그 생성은 '모든 태그 관리' 안에서만 — 검색창에선 만들지 않는다(검색·토글 전용).
                if (!list.children.length)
                    list.append(el('div', { class: 'pjv-menu-empty', text: qq ? '검색 결과가 없습니다 — 새 태그는 아래 ‘모든 태그 관리’에서 만드세요.' : '태그가 없습니다 — ‘모든 태그 관리’에서 만드세요.' }));
            };
            input.addEventListener('input', renderList);
            input.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter')
                    return;
                const v = input.value.trim();
                if (!v)
                    return;
                const exact = all.find((x) => x.name.toLowerCase() === v.toLowerCase());
                if (exact && !selIds().has(exact.id)) {
                    persistAdd(exact);
                    input.value = '';
                    renderList();
                }
                // 일치하는 기존 태그가 없으면 아무 것도 하지 않음 — 새 태그 생성은 '모든 태그 관리'에서만.
            });
            renderChips();
            renderList();
        }
        function showColor(tag, backQuery, onBack) {
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
                tag.color = c;
                renderGrid();
                syncLocal();
                renderField();
                try {
                    await api('/api/ui/v6/tags/' + tag.id, { method: 'POST', body: JSON.stringify({ color: c }) });
                }
                catch (e) {
                    toast('실패 — ' + e.message, true);
                }
            };
            const rename = async () => {
                const v = nameIn.value.trim();
                if (!v || v === tag.name)
                    return;
                try {
                    const r = await api('/api/ui/v6/tags/' + tag.id, { method: 'POST', body: JSON.stringify({ name: v }) }).then((x) => x.tag);
                    tag.name = r.name;
                    syncLocal();
                    renderField();
                }
                catch (e) {
                    toast('이름 변경 실패 — ' + e.message, true);
                    nameIn.value = tag.name;
                }
            };
            const del = el('button', { class: 'pjv-tm-tagdelete', type: 'button' }, pjvtmTrashIcon(), el('span', { text: 'Delete' }));
            del.onclick = async () => {
                if (!confirm("'" + tag.name + "' 태그를 삭제할까요?\n모든 태스크에서 제거됩니다."))
                    return;
                try {
                    await api('/api/ui/v6/tags/' + tag.id + '/delete', { method: 'POST', body: JSON.stringify({}) });
                    d.tags = (d.tags || []).filter((x) => x.id !== tag.id);
                    await loadAll();
                    renderField();
                    goBack();
                }
                catch (e) {
                    toast('삭제 실패 — ' + e.message, true);
                }
            };
            nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') {
                e.preventDefault();
                rename();
            } });
            nameIn.addEventListener('blur', rename);
            pop.replaceChildren(el('div', { class: 'pjv-tm-tagcolor-top' }, back, nameIn), grid, el('div', { class: 'pjv-tm-tagcolor-sep' }), del);
            renderGrid();
            setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
        }
        // 모든 태그 관리(클릭업 Tag Manager 동형) — 워크스페이스 전체 태그를 한 곳에서 보고 이름·색상·삭제(모든 태스크 반영).
        function showManageAll() {
            const back = el('button', { class: 'pjv-tm-tagcolor-back', type: 'button', title: '뒤로' }, pjvtmBackIcon());
            back.onclick = () => showList('');
            const list = el('div', { class: 'pjv-tm-tagresults' });
            // 새 태그 생성은 '모든 태그 관리' 안에서만. 정의만 만들고 현재 항목엔 적용하지 않는다(생성 직후 링크 해제).
            const createIn = el('input', { type: 'text', class: 'pjv-tm-taginput', placeholder: '＋ 새 태그 이름 입력 후 Enter', maxlength: '40' });
            const doCreate = async () => {
                const v = createIn.value.trim();
                if (!v)
                    return;
                if (all.some((x) => x.name.toLowerCase() === v.toLowerCase())) {
                    toast('이미 있는 태그입니다', true);
                    return;
                }
                const color = PJV_TAG_COLORS[all.length % PJV_TAG_COLORS.length];
                createIn.disabled = true;
                try {
                    const tags = await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ name: v, color }) }).then((r) => (r && r.tags) || []);
                    const created = (tags || []).find((x) => x.name.toLowerCase() === v.toLowerCase());
                    if (created)
                        await api('/api/ui/v6/tasks/' + t.id + '/tags', { method: 'POST', body: JSON.stringify({ tag_id: created.id, remove: true }) }).catch(() => { });
                    await loadAll();
                    renderField();
                    showManageAll();
                }
                catch (e) {
                    toast('태그 생성 실패 — ' + e.message, true);
                    createIn.disabled = false;
                }
            };
            createIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') {
                e.preventDefault();
                doCreate();
            } });
            pop.replaceChildren(el('div', { class: 'pjv-tm-tagcolor-top' }, back, el('div', { class: 'pjv-tm-tagmanage-title', text: '모든 태그 관리' })), el('div', { class: 'pjv-tm-tagpop-top' }, createIn), el('div', { class: 'pjv-tm-tagpop-head' }, el('span', { text: all.length + '개 · 클릭해 이름·색상·삭제 (모든 태스크 반영)' })), list);
            setTimeout(() => createIn.focus(), 0);
            if (!all.length) {
                list.append(el('div', { class: 'pjv-menu-empty', text: '아직 태그가 없습니다 — 위 칸에서 만들어보세요.' }));
                return;
            }
            for (const x of all) {
                const row = el('button', { class: 'pjv-tm-tagrow', type: 'button' }, el('span', { class: 'pjv-tm-tagdot', style: 'background:' + (x.color || PJV_TAG_NONE) }), el('span', { class: 'pjv-tm-tagrow-name', text: x.name }), el('span', { class: 'pjv-tm-tagrow-gear' }, pjvtmGearIcon()));
                row.onclick = () => showColor(x, '', showManageAll);
                list.append(row);
            }
        }
        showList('');
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
    function pjvtmLinkPop(anchor, d, t, refresh) {
        const pop = el('div', { class: 'pjv-menu pjv-tm-linkpop' });
        const typeSel = el('select', { class: 'pjv-tm-linktype-sel' }, el('option', { value: 'blocking', text: '막고 있음 (blocking)' }), el('option', { value: 'waiting_on', text: '기다리는 중 (waiting on)' }), el('option', { value: 'linked', text: '연결됨 (linked)' }));
        const input = el('input', { type: 'text', class: 'pjv-tm-taginput', placeholder: '연결할 태스크 검색', maxlength: '100' });
        const results = el('div', { class: 'pjv-tm-tagresults' });
        pop.append(typeSel, input, results);
        const close = pjvPopover(anchor, pop);
        setTimeout(() => input.focus(), 0);
        const have = new Set((d.links || []).map((x) => x.id));
        const run = (typeof debounce === 'function' ? debounce : (f) => f)(async () => {
            const q = input.value.trim();
            let targets = [];
            try {
                targets = await api('/api/ui/v6/projects/' + d.project.id + '/link-targets?exclude=' + t.id + '&q=' + encodeURIComponent(q)).then((r) => (r && r.targets) || []);
            }
            catch (_) { }
            const cand = targets.filter((x) => !have.has(x.id));
            results.replaceChildren(...cand.slice(0, 10).map((x) => {
                const m = pjvStatusMeta(x.status);
                return el('button', { class: 'pjv-menu-item', type: 'button',
                    onclick: async () => {
                        try {
                            await api('/api/ui/v6/tasks/' + t.id + '/links', { method: 'POST', body: JSON.stringify({ to_task: x.id, type: typeSel.value }) });
                            close();
                            refresh();
                        }
                        catch (e) {
                            toast('실패 — ' + e.message, true);
                        }
                    } }, pjvStatusIconStd(m.bucket, 'sm'), el('span', { text: x.name }));
            }));
            if (!cand.length)
                results.replaceChildren(el('div', { class: 'pjv-menu-empty', text: '결과 없음' }));
        }, 250);
        input.addEventListener('input', run);
        run();
    }
    // 체크리스트 — 목록(진행률) + 항목(체크·이름·삭제) + 항목추가 + 새 체크리스트.
    function pjvtmChecklists(d, t, members, refresh) {
        const lists = d.checklists || [];
        const sec = el('div', { class: 'pjv-tm-block' });
        sec.append(el('div', { class: 'pjv-tm-block-head' }, el('span', { class: 'pjv-tm-block-title', text: '체크리스트' })));
        for (const cl of lists) {
            const done = cl.items.filter((i) => i.done).length;
            const clBox = el('div', { class: 'pjv-tm-cl' });
            // 제목 — 클릭하면 인라인 입력으로 바뀌어 수정(rename). Enter/blur 저장, Esc 취소.
            const nameEl = el('span', { class: 'pjv-tm-cl-name', text: cl.name, title: '클릭해 제목 수정', role: 'button', tabindex: '0' });
            const editName = () => {
                const inp = el('input', { type: 'text', class: 'pjv-tm-cl-nameedit', value: cl.name, maxlength: '120' });
                nameEl.replaceWith(inp);
                inp.focus();
                inp.select();
                let fin = false;
                const finish = async (save) => {
                    if (fin)
                        return;
                    fin = true;
                    const nv = inp.value.trim();
                    if (save && nv && nv !== cl.name) {
                        try {
                            await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'rename', checklist_id: cl.id, name: nv }) });
                            cl.name = nv;
                            nameEl.textContent = nv;
                        }
                        catch (e) {
                            toast('제목 수정 실패 — ' + e.message, true);
                        }
                    }
                    inp.replaceWith(nameEl);
                };
                inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') {
                    e.preventDefault();
                    finish(true);
                }
                else if (e.key === 'Escape') {
                    finish(false);
                } });
                inp.addEventListener('blur', () => finish(true));
            };
            nameEl.onclick = editName;
            nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter')
                editName(); });
            clBox.append(el('div', { class: 'pjv-tm-cl-head' }, nameEl, el('span', { class: 'pjv-tm-cl-prog', text: done + '/' + cl.items.length }), el('button', { class: 'pjv-tm-cl-x', type: 'button', title: '체크리스트 삭제', text: '✕',
                onclick: async () => { if (!confirm('이 체크리스트를 삭제하겠습니까?\n하위 항목도 모두 사라집니다.'))
                    return; try {
                    await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'delete', checklist_id: cl.id }) });
                    refresh();
                }
                catch (e) {
                    toast('실패 — ' + e.message, true);
                } } })));
            for (const it of cl.items) {
                const cb = el('button', { class: 'pjv-tm-cl-check' + (it.done ? ' on' : ''), type: 'button', text: it.done ? '✓' : '',
                    onclick: async () => { try {
                        await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'update_item', item_id: it.id, done: !it.done }) });
                        refresh();
                    }
                    catch (e) {
                        toast('실패 — ' + e.message, true);
                    } } });
                clBox.append(el('div', { class: 'pjv-tm-cl-item' }, cb, el('span', { class: 'pjv-tm-cl-itemname' + (it.done ? ' done' : ''), text: it.name }), el('button', { class: 'pjv-tm-cl-x', type: 'button', title: '항목 삭제', text: '✕',
                    onclick: async () => { try {
                        await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'delete_item', item_id: it.id }) });
                        refresh();
                    }
                    catch (e) {
                        toast('실패 — ' + e.message, true);
                    } } })));
            }
            const itemIn = el('input', { type: 'text', class: 'pjv-tm-cl-add', placeholder: '＋ 항목 추가 후 Enter', maxlength: '200' });
            // Enter 로 연속 추가 — 전체 새로고침 대신 항목을 낙관적으로 붙이고 입력 포커스를 유지(커서가 안 사라짐).
            itemIn.addEventListener('keydown', async (e) => {
                if (e.key !== 'Enter')
                    return;
                const name = itemIn.value.trim();
                if (!name)
                    return;
                itemIn.value = '';
                itemIn.focus();
                try {
                    const res = await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'add_item', checklist_id: cl.id, name }) });
                    const updated = ((res && res.checklists) || []).find((c) => c.id === cl.id);
                    const it = updated && updated.items[updated.items.length - 1];
                    if (!it) {
                        refresh();
                        return;
                    }
                    const cb = el('button', { class: 'pjv-tm-cl-check', type: 'button', text: '',
                        onclick: async () => { try {
                            await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'update_item', item_id: it.id, done: true }) });
                            refresh();
                        }
                        catch (e2) {
                            toast('실패 — ' + e2.message, true);
                        } } });
                    clBox.insertBefore(el('div', { class: 'pjv-tm-cl-item' }, cb, el('span', { class: 'pjv-tm-cl-itemname', text: it.name }), el('button', { class: 'pjv-tm-cl-x', type: 'button', title: '항목 삭제', text: '✕',
                        onclick: async () => { try {
                            await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'delete_item', item_id: it.id }) });
                            refresh();
                        }
                        catch (e2) {
                            toast('실패 — ' + e2.message, true);
                        } } })), itemIn);
                    const prog = clBox.querySelector('.pjv-tm-cl-prog');
                    if (prog)
                        prog.textContent = updated.items.filter((i) => i.done).length + '/' + updated.items.length;
                }
                catch (err) {
                    toast('실패 — ' + err.message, true);
                }
            });
            clBox.append(itemIn);
            sec.append(clBox);
        }
        const addBtn = el('button', { class: 'pjv-tm-block-add', type: 'button', text: '✓ 체크리스트 만들기' });
        addBtn.onclick = async () => {
            const name = prompt('체크리스트 이름', '체크리스트');
            if (name == null)
                return;
            try {
                await api('/api/ui/v6/tasks/' + t.id + '/checklists', { method: 'POST', body: JSON.stringify({ action: 'create', name: name || '체크리스트' }) });
                refresh();
            }
            catch (e) {
                toast('실패 — ' + e.message, true);
            }
        };
        sec.append(addBtn);
        return sec;
    }
    // 첨부 파일 — 프로젝트 폴더 `_attachments/task-<id>/` 재사용(기존 파일 API: 멤버게이트·50MB·미리보기·다운로드).
    //  의존성/연결·체크리스트와 같은 레벨의 블록. 업로드=upSend/upProgress(진행·취소 — 공유 폴더와 같은 프리미티브, #807),
    //  목록=/files, 미리보기=openFileViewer, 삭제=DELETE.
    function pjvtmAttachments(d, t, refresh) {
        const sec = el('div', { class: 'pjv-tm-block' });
        sec.append(el('div', { class: 'pjv-tm-block-head' }, el('span', { class: 'pjv-tm-block-title', text: '첨부 파일' })));
        // DB 첨부(#541) — ClickUp 이관본(task_attachment)을 파일시스템 목록 위에 별도 그룹으로.
        //  원본 URL 은 ClickUp 서명 URL 이라 만료될 수 있음 → 이미지 로드 실패 시 아이콘 폴백(레이아웃 유지).
        if ((d.attachments || []).length)
            sec.append(pjvtmDbAttachments(d.attachments));
        const pid = d.project && d.project.id;
        const dir = '_attachments/task-' + t.id;
        const base = '/api/ui/v6/projects/';
        const listBox = el('div', { class: 'pjv-tm-att-list' });
        sec.append(listBox);
        (async () => {
            if (pid == null)
                return;
            let files = [];
            try {
                const r = await api(base + pid + '/files?path=' + encodeURIComponent(dir));
                files = ((r && r.items) || []).filter((it) => it.type === 'file');
            }
            catch (_) { /* 디렉터리 없음(404) = 첨부 없음 */ }
            for (const f of files) {
                const rel = dir + '/' + f.name;
                listBox.append(el('div', { class: 'pjv-tm-att' }, el('span', { class: 'pjv-tm-att-ico', 'aria-hidden': 'true', text: '📎' }), el('button', { class: 'pjv-tm-att-name', type: 'button', text: f.name,
                    onclick: () => openFileViewer(pid, rel, f.name, refresh, base) }), el('span', { class: 'pjv-tm-att-size', text: fmtSize(f.size) }), el('button', { class: 'pjv-tm-att-act', type: 'button', title: '다운로드', text: '↓',
                    onclick: () => authDownload(base + pid + '/file?download=1&path=' + encodeURIComponent(rel), f.name) }), el('button', { class: 'pjv-tm-att-act danger', type: 'button', title: '삭제', text: '✕',
                    onclick: async () => {
                        if (!confirm('첨부 ‘' + f.name + '’을(를) 삭제할까요?'))
                            return;
                        try {
                            await api(base + pid + '/file?path=' + encodeURIComponent(rel), { method: 'DELETE' });
                            refresh();
                        }
                        catch (e) {
                            toast('삭제 실패 — ' + e.message, true);
                        }
                    } })));
            }
        })();
        const fileInput = el('input', { type: 'file', multiple: 'true', style: 'display:none' });
        const addBtn = el('button', { class: 'pjv-tm-block-add', type: 'button', text: '📎 파일 첨부' });
        const progBox = el('div', { class: 'up-prog-box' }); // 업로드 진행·취소 바(#807 — 공유 폴더와 같은 프리미티브)
        // 첨부 업로드 — 전송 루프·진행바·취소는 공유 폴더에서 검증된 프리미티브 그대로(#797).
        //  취소하면 남은 파일을 안 보낼 뿐 아니라 전송 중인 파일도 끊긴다. 서버가 임시파일→rename 이라 끊겨도 목적지는 무손상.
        async function uploadAttach(items) {
            if (pid == null || !items.length)
                return;
            const ac = new AbortController();
            const bar = upProgress(items.length, () => ac.abort());
            progBox.append(bar.row);
            addBtn.disabled = true;
            const r = await upSend({
                items, signal: ac.signal,
                fileUrl: (rel) => base + pid + '/file?path=' + encodeURIComponent(dir + '/' + rel),
                onProgress: (i, rel, pct) => bar.set(i, rel, pct),
            });
            bar.row.remove();
            addBtn.disabled = false;
            upToast(r);
            refresh(); // 취소했어도 '올라간 데까지'는 목록에 보여 준다
        }
        fileInput.addEventListener('change', () => {
            const picked = Array.from(fileInput.files || []);
            fileInput.value = ''; // 같은 파일을 다시 고를 수 있게 — 리셋을 안 하면 두 번째 선택이 change 를 안 낸다(기존 버그)
            uploadAttach(picked.map((f) => ({ file: f, rel: String(f.name) })));
        });
        // 공유 프로젝트 폴더에서 첨부 — 폴더 브라우저 팝오버에서 파일을 고르면 그 파일을 이 태스크 첨부폴더로 복사한다.
        const attachFromFolder = () => {
            if (pid == null) {
                toast('프로젝트 폴더를 찾을 수 없어요', true);
                return;
            }
            const crumb = el('div', { class: 'pjv-files-crumb' });
            const rowsBox = el('div', { class: 'pjv-files-browser' });
            const close = pjvPopover(addBtn, el('div', { class: 'pjv-field-editor pjv-files-editor' }, el('div', { class: 'pjv-files-head2', text: '공유 프로젝트 폴더에서 첨부' }), crumb, rowsBox));
            let curPath = '';
            const load = async () => {
                rowsBox.replaceChildren(el('div', { class: 'pjv-files-empty', text: '불러오는 중…' }));
                let data;
                try {
                    data = await api(base + pid + '/files?path=' + encodeURIComponent(curPath));
                }
                catch (e) {
                    rowsBox.replaceChildren(el('div', { class: 'pjv-files-empty', text: '폴더를 불러오지 못했어요' }));
                    return;
                }
                crumb.replaceChildren(el('button', { class: 'pjv-files-crumb-btn', type: 'button', text: '루트', onclick: () => { curPath = ''; load(); } }));
                let acc = '';
                for (const p of (curPath ? curPath.split('/') : [])) {
                    acc = acc ? acc + '/' + p : p;
                    const tg = acc;
                    crumb.append(el('span', { class: 'pjv-files-crumb-sep', text: '/' }), el('button', { class: 'pjv-files-crumb-btn', type: 'button', text: p, onclick: () => { curPath = tg; load(); } }));
                }
                rowsBox.replaceChildren();
                const items = data.items || [];
                if (!items.length) {
                    rowsBox.append(el('div', { class: 'pjv-files-empty', text: '빈 폴더예요' }));
                    return;
                }
                for (const it of items) {
                    const childPath = curPath ? curPath + '/' + it.name : it.name;
                    if (it.type === 'dir') {
                        rowsBox.append(el('button', { class: 'pjv-files-row dir', type: 'button', onclick: () => { curPath = childPath; load(); } }, fileIconSvg(it.name, true), el('span', { class: 'pjv-files-name', text: it.name }), el('span', { class: 'pjv-files-chev', text: '›' })));
                        continue;
                    }
                    rowsBox.append(el('button', { class: 'pjv-files-row file', type: 'button', onclick: async () => {
                            close();
                            // 원본을 브라우저로 내려받아 첨부 폴더로 다시 올린다(서버 내부 복사가 아니라 왕복) — 큰 파일이면 오래 걸리므로
                            //  다운로드·업로드 **양쪽 다** 같은 signal 로 끊는다(#807).
                            const ac = new AbortController();
                            const bar = upProgress(1, () => ac.abort(), { label: '원본을 읽는 중… — ' + it.name });
                            progBox.append(bar.row);
                            addBtn.disabled = true;
                            try {
                                const tok = localStorage.getItem(TOKEN_KEY);
                                const blob = await fetch(base + pid + '/file?download=1&path=' + encodeURIComponent(childPath), { headers: tok ? { Authorization: 'Bearer ' + tok } : {}, signal: ac.signal })
                                    .then((r) => { if (!r.ok)
                                    throw new Error('원본 읽기 실패 (' + r.status + ')'); return r.blob(); });
                                const res = await upSend({
                                    items: [{ file: new File([blob], it.name), rel: it.name }], signal: ac.signal,
                                    fileUrl: (rel) => base + pid + '/file?path=' + encodeURIComponent(dir + '/' + rel),
                                    onProgress: (i, rel, pct) => bar.set(i, rel, pct),
                                });
                                bar.row.remove();
                                addBtn.disabled = false;
                                upToast(res);
                                refresh();
                            }
                            catch (e2) {
                                bar.row.remove();
                                addBtn.disabled = false;
                                if (upIsAbort(e2)) {
                                    toast('첨부를 취소했습니다');
                                    return;
                                } // 원본을 읽는 중에 끊은 경우
                                toast('첨부 실패 — ' + e2.message, true);
                            }
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
        sec.append(progBox, fileInput, addBtn); // 진행·취소 바는 목록과 '📎 파일 첨부' 사이
        sec.append(el('div', { class: 'pjv-tm-att-hint' }, el('span', { class: 'pjv-tm-att-hint-ic', 'aria-hidden': 'true', text: '📋' }), el('span', {}, '이미지를 복사한 뒤 이 창에서 ', el('b', { text: 'Ctrl/⌘ + V' }), ' 로 바로 붙여넣을 수도 있어요.')));
        return sec;
    }
    // ClickUp 첨부(DB, #541) 그룹 — 이미지=썸네일 카드(클릭→원본 새 탭), 그 외=파일 행(아이콘+제목+크기, 새 탭 링크).
    //  전부 읽기전용(원본은 ClickUp 소유 — 삭제/다운로드 프록시 없음). URL 이 http(s) 아니면 링크 없이 제목만.
    function pjvtmDbAttachments(atts) {
        const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic', 'avif']);
        const isImg = (a) => /^image\//i.test(a.mimetype || '') || IMG_EXT.has(String(a.extension || '').toLowerCase());
        // 제목에 확장자가 없으면 붙여서(아이콘 판별·가독성) 표시명 구성.
        const nameOf = (a) => {
            const base = String(a.title || '').trim() || '첨부';
            const ext = String(a.extension || '').trim().toLowerCase();
            return ext && !base.toLowerCase().endsWith('.' + ext) ? base + '.' + ext : base;
        };
        const wrap = el('div', { class: 'pjv-tm-attdb' });
        wrap.append(el('div', { class: 'pjv-tm-attdb-head', text: 'ClickUp 첨부' }));
        const grid = el('div', { class: 'pjv-tm-attdb-grid' });
        const rows = el('div', { class: 'pjv-tm-att-list' });
        for (const a of atts) {
            const name = nameOf(a);
            const url = pjvtmSafeUrl(a.url);
            if (isImg(a)) {
                // 이미지 카드 — 썸네일(thumbnail 우선, 없으면 원본) + 캡션. 클릭=원본 새 탭.
                const linkAttrs = url ? { href: url, target: '_blank', rel: 'noopener' } : {};
                const card = el(url ? 'a' : 'span', { class: 'pjv-tm-attdb-card', title: name + (url ? ' — 원본 열기(새 탭)' : ''), ...linkAttrs });
                const thumb = pjvtmSafeUrl(a.thumbnail) || url;
                const fallback = () => el('span', { class: 'pjv-tm-attdb-fallback' }, fileIconSvg(name, false));
                if (thumb) {
                    const img = el('img', { class: 'pjv-tm-attdb-thumb', src: thumb, alt: name, loading: 'lazy' });
                    // 서명 URL 만료 등 로드 실패 → 아이콘 폴백(깨진 이미지로 레이아웃 안 깨지게).
                    img.addEventListener('error', () => { img.replaceWith(fallback()); });
                    card.append(img);
                }
                else
                    card.append(fallback());
                card.append(el('span', { class: 'pjv-tm-attdb-cap', text: name }));
                grid.append(card);
            }
            else {
                // 일반 파일 행 — 기존 첨부 행(.pjv-tm-att)과 같은 결. 링크는 새 탭(다운로드는 원본 시스템에서).
                rows.append(el('div', { class: 'pjv-tm-att' }, fileIconSvg(name, false), url ? el('a', { class: 'pjv-tm-att-name pjv-tm-att-link', href: url, target: '_blank', rel: 'noopener', title: '원본 열기(새 탭)', text: name })
                    : el('span', { class: 'pjv-tm-att-name', text: name }), a.size != null && Number(a.size) > 0 ? el('span', { class: 'pjv-tm-att-size', text: fmtSize(Number(a.size)) }) : null));
            }
        }
        if (grid.children.length)
            wrap.append(grid);
        if (rows.children.length)
            wrap.append(rows);
        return wrap;
    }
    // 클립보드 이미지 붙여넣기 다이얼로그 — 미리보기 + 이름·주석 입력 후 첨부폴더로 업로드. mount=모달 루트(닫힐 때 함께 제거).
    function pjvtmPasteImage(blob, ctx, mount) {
        const url = URL.createObjectURL(blob);
        const ext = ((blob.type || 'image/png').split('/')[1] || 'png').toLowerCase().replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'png';
        const nameIn = el('input', { type: 'text', class: 'pjv-tm-paste-name', placeholder: '이름·주석 (선택) — 예: 디자인 시안 v2', maxlength: '80' });
        const err = el('div', { class: 'pjv-tm-paste-err', hidden: true });
        const cancelBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '취소' });
        const okBtn = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '첨부' });
        const back2 = el('div', { class: 'pjv-tm-paste-back' }, el('div', { class: 'pjv-tm-paste-card' }, el('div', { class: 'pjv-tm-paste-title', text: '이미지 붙여넣기' }), el('img', { class: 'pjv-tm-paste-preview', src: url, alt: '붙여넣은 이미지 미리보기' }), el('label', { class: 'pjv-tm-paste-label' }, '이름 · 주석', nameIn), err, el('div', { class: 'pjv-tm-paste-actions' }, cancelBtn, okBtn)));
        const cleanup = () => { URL.revokeObjectURL(url); back2.remove(); };
        back2._cancel = cleanup;
        cancelBtn.onclick = cleanup;
        back2.addEventListener('mousedown', (e) => { if (e.target === back2)
            cleanup(); });
        const doUpload = async () => {
            const cap = (nameIn.value || '').trim();
            const safe = cap.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, '_').slice(0, 80);
            const fname = (safe || '붙여넣은-이미지') + '-' + pjvtmStamp() + '.' + ext;
            okBtn.disabled = true;
            okBtn.textContent = '첨부 중…';
            // 업로드 중에도 '취소'는 살려 둔다 — 누르면 전송 중인 요청을 끊는다(#807).
            //  예전엔 여기서 취소 버튼까지 비활성화해, 큰 이미지를 올리기 시작하면 멈출 방법이 없었다.
            const ac = new AbortController();
            cancelBtn.onclick = () => ac.abort();
            try {
                await authUploadProgress(ctx.base + ctx.pid + '/file?path=' + encodeURIComponent(ctx.dir + '/' + fname), new File([blob], fname, { type: blob.type }), (pct) => { okBtn.textContent = '첨부 중… ' + Math.round(pct) + '%'; }, // 바 대신 버튼에 진행률(다이얼로그가 좁다)
                ac.signal);
                cleanup();
                ctx.refresh();
                toast('이미지를 첨부했어요');
            }
            catch (e2) {
                cancelBtn.onclick = cleanup; // 취소 버튼을 원래 동작(닫기)으로 되돌린다
                if (upIsAbort(e2)) {
                    cleanup();
                    toast('첨부를 취소했습니다');
                    return;
                }
                err.textContent = '첨부 실패 — ' + e2.message;
                err.hidden = false;
                okBtn.disabled = false;
                okBtn.textContent = '첨부';
            }
        };
        okBtn.onclick = doUpload;
        nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') {
            e.preventDefault();
            doUpload();
        } });
        (mount || document.body).append(back2);
        setTimeout(() => nameIn.focus(), 0);
    }
    // 파일명용 타임스탬프 YYYYMMDD-HHMMSS (브라우저 — Date 사용 가능).
    function pjvtmStamp() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }
    // ── 우측(Activity) — 클릭업식: 댓글 카드(반응·Reply) + 시스템 이벤트(불릿·우측 시간) + 작성기(툴바). ──
    function pjvtmSide(d, t, refresh) {
        const side = el('div', { class: 'pjv-tm-side' });
        let _filterMode = 'all';
        const _searchIn = el('input', { type: 'text', class: 'pjv-tm-search-in', placeholder: '활동 검색…' });
        const _searchWrap = el('div', { class: 'pjv-tm-search', hidden: true }, _searchIn);
        const _applyActFilter = () => {
            const fe = side.querySelector('.pjv-tm-feed');
            if (!fe)
                return;
            const qq = (_searchIn.value || '').trim().toLowerCase();
            for (const ch of fe.children) {
                if (ch.classList.contains('pjv-tm-feed-empty'))
                    continue;
                const isEv = ch.classList.contains('pjv-tm-ev');
                let show = _filterMode === 'all' || (_filterMode === 'comments' && !isEv) || (_filterMode === 'events' && isEv);
                if (show && qq)
                    show = ch.textContent.toLowerCase().includes(qq);
                ch.hidden = !show;
            }
        };
        _searchIn.addEventListener('input', _applyActFilter);
        const _searchBtn = el('button', { class: 'pjv-tm-side-icon', type: 'button', title: '활동 검색' }, pjvtmIcon('search'));
        _searchBtn.onclick = () => { _searchWrap.hidden = !_searchWrap.hidden; _searchBtn.classList.toggle('on', !_searchWrap.hidden); if (!_searchWrap.hidden)
            _searchIn.focus();
        else {
            _searchIn.value = '';
            _applyActFilter();
        } };
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
        side.append(el('div', { class: 'pjv-tm-side-head' }, el('span', { text: 'Activity' }), el('div', { class: 'pjv-tm-side-tools' }, _searchBtn, _bellBtn, _filterBtn)), _searchWrap);
        const feedBox = el('div', { class: 'pjv-tm-feed' });
        const feed = d.feed || [];
        const ta = el('textarea', { class: 'pjv-tm-composer', rows: '1', placeholder: '댓글을 입력하세요…' });
        const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; };
        ta.addEventListener('input', grow);
        const insertAtCursor = (text) => {
            const s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
            const e = ta.selectionEnd == null ? ta.value.length : ta.selectionEnd;
            ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
            const pos = s + text.length;
            ta.focus();
            try {
                ta.setSelectionRange(pos, pos);
            }
            catch (_) { /* noop */ }
            grow();
        };
        const cctx = { taskId: t.id, projectId: d.project && d.project.id, members: d.members || [], replyTo: (name) => insertAtCursor('@' + name + ' ') };
        if (!feed.length)
            feedBox.append(el('div', { class: 'pjv-tm-feed-empty', text: '아직 활동이 없습니다. 첫 댓글을 남겨보세요.' }));
        // 산만함 줄이기 — 노이즈 필드(담당자·설명·이름·시작일)의 '연속' 변경은 최신 1건으로 합쳐 도배 방지.
        //  상태·마감일·우선순위·생성·댓글은 각각 그대로 둔다(의미 있는 마일스톤이라 합치지 않음).
        const NOISY_FIELDS = new Set(['description', 'assignee', 'name', 'title', 'start_date']);
        const feedShown = [];
        for (const f of feed) {
            const prev = feedShown[feedShown.length - 1];
            if (f.kind === 'event' && prev && prev.kind === 'event' && prev.field === f.field && NOISY_FIELDS.has(f.field))
                feedShown[feedShown.length - 1] = f;
            else
                feedShown.push(f);
        }
        for (const f of feedShown)
            feedBox.append(f.kind === 'comment' ? pjvtmComment(f, cctx) : pjvtmEvent(f));
        side.append(feedBox);
        setTimeout(() => { feedBox.scrollTop = feedBox.scrollHeight; }, 0);
        const sendBtn = el('button', { class: 'pjv-tm-send', type: 'button', title: '보내기 (Enter)' }, pjvtmIcon('send'));
        const send = async () => {
            const text = ta.value.trim();
            if (!text)
                return;
            sendBtn.disabled = true;
            ta.disabled = true;
            try {
                await api('/api/ui/v6/tasks/' + t.id + '/comments', { method: 'POST', body: JSON.stringify({ text }) });
                ta.value = '';
                refresh();
            }
            catch (e) {
                toast('실패 — ' + e.message, true);
                sendBtn.disabled = false;
                ta.disabled = false;
            }
        };
        sendBtn.onclick = send;
        ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
        } });
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
                if (reactions[i].mine) {
                    reactions[i].count -= 1;
                    reactions[i].mine = false;
                    if (reactions[i].count <= 0)
                        reactions.splice(i, 1);
                }
                else {
                    reactions[i].count += 1;
                    reactions[i].mine = true;
                }
            }
            else
                reactions.push({ emoji, count: 1, mine: true });
            drawFoot();
            api('/api/ui/v6/comments/' + f.id + '/reactions', { method: 'POST', body: JSON.stringify({ emoji }) })
                .then((res) => { if (res && res.reactions) {
                reactions = res.reactions;
                drawFoot();
            } })
                .catch((e) => toast('반응 실패 — ' + e.message, true));
        };
        const drawFoot = () => {
            footer.replaceChildren();
            const left = el('div', { class: 'pjv-tm-c-react' });
            for (const r of reactions)
                left.append(el('button', { class: 'pjv-tm-react-chip' + (r.mine ? ' mine' : ''), type: 'button', title: '반응 토글', onclick: () => toggle(r.emoji) }, el('span', { text: r.emoji }), el('span', { class: 'pjv-tm-react-n', text: String(r.count) })));
            left.append(el('button', { class: 'pjv-tm-c-act', type: 'button', title: '좋아요', onclick: () => toggle('👍') }, pjvtmIcon('like')));
            const emo = el('button', { class: 'pjv-tm-c-act', type: 'button', title: '이모지 반응' }, pjvtmIcon('smile'));
            emo.onclick = () => pjvtmEmojiPicker(emo, (e) => toggle(e));
            left.append(emo);
            footer.append(left, el('button', { class: 'pjv-tm-c-reply', type: 'button', text: 'Reply', onclick: () => cctx.replyTo(name) }));
        };
        drawFoot();
        const textDiv = el('div', { class: 'pjv-tm-c-text md-rendered' }, renderMarkdown(f.body || ''));
        pjvtmWireFileLinks(textDiv, cctx);
        return el('div', { class: 'pjv-tm-c' }, personFace(f.actor || name, 'pjv-ava', name), el('div', { class: 'pjv-tm-c-body' }, el('div', { class: 'pjv-tm-c-meta' }, el('span', { class: 'pjv-tm-c-who', text: name }), el('span', { class: 'pjv-tm-c-time', text: ' · ' + (typeof relTime === 'function' ? relTime(f.ts) : f.ts) })), textDiv, footer));
    }
    function pjvtmEvent(f) {
        const name = f.display_name || f.actor || '시스템';
        let txt;
        if (f.field === 'created')
            txt = '태스크를 생성';
        else if (f.field === 'description')
            txt = '설명을 수정';
        else {
            const tv = pjvtmEventVal(f.field, f.to);
            if (f.to == null)
                txt = f.label + ' 해제';
            else
                txt = f.label + ' → ' + tv;
        }
        return el('div', { class: 'pjv-tm-ev' }, el('div', { class: 'pjv-tm-ev-main' }, el('span', { class: 'pjv-tm-ev-dot', text: '•' }), el('span', { class: 'pjv-tm-ev-who', text: name }), el('span', { class: 'pjv-tm-ev-txt', text: ' ' + txt })), el('span', { class: 'pjv-tm-ev-time', text: (typeof relTime === 'function' ? relTime(f.ts) : f.ts) }));
    }
    function pjvtmEventVal(field, v) {
        if (v == null || v === '')
            return '';
        if (field === 'status')
            return (pjvStatusMeta(v).label) || v;
        if (field === 'priority')
            return (PJV_PRIORITY[v] && PJV_PRIORITY[v].label) || v;
        if (field === 'assignee')
            return v;
        return String(v);
    }
}
// 액티비티 헤더용 아이콘 추가(맵 정의 비파괴 — 키만 보강).
PJV_TM_ICONS.search = { p: [['circle', { cx: 11, cy: 11, r: 7 }], ['line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }]] };
PJV_TM_ICONS.bell = { p: [['path', { d: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9' }], ['path', { d: 'M13.73 21a2 2 0 0 1-3.46 0' }]] };
PJV_TM_ICONS.filter = { p: [['line', { x1: 4, y1: 7, x2: 20, y2: 7 }], ['line', { x1: 7, y1: 12, x2: 17, y2: 12 }], ['line', { x1: 10, y1: 17, x2: 14, y2: 17 }]] };
export { PJV_TAG_NONE, pjvCloseTaskModalOnRoute, pjvOpenTaskModal, pjvRenderTaskRoute, pjvTaskModalRefreshIfRoute, pjvtmComposerToolbar, };

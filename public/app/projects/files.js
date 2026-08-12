// projects/files.ts — #1313 R30: web/projects.ts 분해 ① 리프.
//  파일/업로드 일체 — 인증 다운로드·업로드(진행률·취소) · 포맷터 · 정렬 · 파일 아이콘/썸네일 ·
//  뷰어 · UpItem 파이프라인(수집→정규화→전송→토스트) · 폴더 그리드 오버레이 + 사람/팀 피커.
//  ⚠ 썸네일 지연로딩 IntersectionObserver(_thumbObserver)는 이 모듈이 **단독 소유**한다(모듈 전역 1개, 밖으로 새지 않는다).
import { api, busy, el, errorNote, personFace, state, toast } from '../core.js';
import { avatarColor, initials } from '../lib/avatar.js'; // R29b: 구 로컬 사본(바이트 동일)을 지우고 단일 정의로 — 아래에서 그대로 재수출
import { overlayBox, skeletonRows } from '../learn.js';
import { fileSortApply, fileSortBtn, fileSortLoad, fileSortSave } from './files-format.js';
import { fileExt } from './files-icons.js';
import { UP_CONFIRM, upControl, upDropZone, upPrecheckOverwrite, upProgress, upSend, upToast } from './files-upload.js';
import { projFileRowEl } from './files-cards.js';
// 팀원 선택 위젯 — 이름 검색으로 하나씩 추가(클릭), 선택된 사람은 칩으로(× 제거). 생성·수정 공용.
//  동기 반환(즉시 로딩표시) + 비동기 채움. getSelected() 가 현재 선택 id 배열.
// 팀 피커(#1291 v2) — 공개 대상을 사람 대신 **부서(팀)**로 고른다. memberPicker 와 같은 계약(box/getSelected/…)이라
//  compactPicker 가 그대로 감싼다. 66명 조직에서 본부 하나를 잠글 때 12명을 일일이 고르지 않아도 되고,
//  입퇴사로 팀원이 바뀌면 대상이 자동으로 따라간다(스냅샷이 아니다).
function pjvTeamPicker(preselected, onChange) {
    const selected = new Set((preselected || []).map(Number));
    const fire = () => { try {
        onChange && onChange();
    }
    catch (_) { /* */ } };
    let all = [];
    const listBox = el('div', { class: 'proj-mp-list' });
    const box = el('div', { class: 'proj-mp' }, listBox);
    const paint = () => {
        listBox.replaceChildren(...(all.length ? all.map((t) => {
            const on = selected.has(Number(t.id));
            const row = el('div', { class: 'proj-mp-item' + (on ? ' sel' : ''), role: 'button', tabindex: '0' }, el('span', { class: 'proj-mp-check', text: on ? '✓' : '' }), el('span', { class: 'proj-mp-name', text: t.name || t.key || String(t.id) }));
            const toggle = () => { on ? selected.delete(Number(t.id)) : selected.add(Number(t.id)); paint(); fire(); };
            row.onclick = toggle;
            row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle();
            } });
            return row;
        }) : [el('div', { class: 'proj-mp-empty', text: '팀이 없어요 — 관리 ▸ 팀에서 먼저 만들어 주세요' })]));
    };
    paint();
    api('/api/ui/teams').then((d) => { all = (d && d.teams) || []; paint(); }).catch(() => { });
    return {
        box,
        getSelected: () => [...selected],
        getSelectedLabels: () => all.filter((t) => selected.has(Number(t.id)))
            .map((t) => ({ key: String(t.id), label: t.name || t.key || String(t.id), color: avatarColor('team' + t.id), initials: (t.name || t.key || '팀').slice(0, 2) })),
    };
}
function memberPicker(preselected, opts) {
    opts = opts || {};
    const selected = new Set(preselected || []);
    const fire = () => { try {
        opts.onChange && opts.onChange();
    }
    catch (_) { /* */ } };
    let all = [];
    // 단일 목록 — 선택된 사람도 위쪽 별도 chips 없이 이 목록에서 체크로 표시하고 클릭으로 토글(해제)한다(#475: 중복 표시 제거).
    const searchIn = el('input', { type: 'text', class: 'proj-mp-search', placeholder: '이름으로 검색…' });
    const count = el('div', { class: 'proj-mp-count' });
    const results = el('div', { class: 'proj-mp-results' }, el('span', { class: 'admin-hint', text: '불러오는 중…' }));
    const box = el('div', { class: 'proj-mp' }, searchIn, count, results);
    // 단일 목록(#475 중복 chips 제거) — 선택된 사람은 우측 체크·행 강조로 표시, 클릭 토글. 상단에 참여 인원 요약(#500).
    //  선택 변경 시 fire()(onChange 콜백, #473).
    function paintResults() {
        const n = selected.size;
        count.textContent = n ? n + '명 참여 중' : '참여 멤버를 골라 추가하세요';
        if (!all.length) {
            results.replaceChildren(el('span', { class: 'admin-hint', text: '등록된 사람 구성원이 없습니다.' }));
            return;
        }
        const q = searchIn.value.trim().toLowerCase();
        const cand = all.filter((m) => !q || (m.display_name || m.id).toLowerCase().includes(q));
        // 선택된 사람을 위로(선택 상태 한눈에), 그 안/밖은 이름순 유지.
        cand.sort((a, b) => (selected.has(b.id) ? 1 : 0) - (selected.has(a.id) ? 1 : 0));
        if (!cand.length) {
            results.replaceChildren(el('div', { class: 'proj-mp-empty', text: q ? '일치하는 사람이 없어요.' : '구성원이 없습니다.' }));
            return;
        }
        results.replaceChildren(...cand.map((m) => {
            const on = selected.has(m.id);
            return el('div', { class: 'proj-mp-row' + (on ? ' on' : ''), role: 'button', 'aria-pressed': on ? 'true' : 'false',
                onclick: () => { if (on)
                    selected.delete(m.id);
                else
                    selected.add(m.id); paintResults(); searchIn.focus(); fire(); } }, personFace(m.id, 'proj-mp-ava', m.display_name || m.id), el('span', { class: 'proj-mp-name', text: m.display_name || m.id }), el('span', { class: 'proj-mp-check' + (on ? ' on' : ''), 'aria-hidden': 'true', text: on ? '✓' : '' }));
        }));
    }
    searchIn.addEventListener('input', paintResults);
    api('/api/ui/dash/members').then((d) => {
        all = (d && d.members) || [];
        // 생성 폼 기본값: 나(생성자)를 디폴트 선택 — 활성 구성원 목록에 실제 있을 때만(유령 id 방지). 다시 눌러 해제 가능.
        if (opts && opts.includeMe) {
            const meId = state.me && state.me.userId;
            if (meId && all.some((m) => m.id === meId))
                selected.add(meId);
        }
        paintResults();
        fire();
    })
        .catch(() => results.replaceChildren(el('span', { class: 'admin-hint', text: '팀원 목록을 불러오지 못했습니다.' })));
    return {
        box,
        getSelected: () => [...selected],
        getSelectedLabels: () => all.filter((m) => selected.has(m.id)).map((m) => ({ key: m.id, label: m.display_name || m.id, color: (m.avatar_color && /^#[0-9a-fA-F]{6}$/.test(m.avatar_color)) ? m.avatar_color : avatarColor(m.id), initials: (m.avatar_char && String(m.avatar_char).trim()) || initials(m.display_name || m.id) })),
    };
}
// 클립보드 붙여넣기 이미지 → 업로드용 File(고유 이름). File.name 은 read-only 라 새 File 로 감싼다.
//  같은 시각 다중 붙여넣기 충돌 방지로 날짜-시각(+ms 2자리, 다중이면 순번). 공유폴더는 유니코드 보존이라 한글 이름 OK.
function pastedImageFile(blob, seq) {
    const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/tiff': 'tiff' };
    const ext = extMap[blob.type] || (String(blob.type).split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const ts = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + p(d.getMilliseconds()).slice(0, 2);
    const name = '붙여넣기-' + ts + (seq ? '-' + (seq + 1) : '') + '.' + ext;
    try {
        return new File([blob], name, { type: blob.type });
    }
    catch (_) {
        try {
            blob.name = name;
        }
        catch (_2) { /* File.name read-only */ }
        return blob;
    }
}
// 붙여넣기 전 이름 지정 + 동작 안내 팝업 — 클립보드 이미지를 공유 폴더로 올리기 전에 띄운다.
//  단일: [이름][.확장자(고정 태그)]. 다중: 공통 베이스명 + 각 파일에 -1,-2…와 원래 확장자. 확인 시 onConfirm(files).
//  확장자를 입력칸 밖 고정 태그로 둬, 타이핑 중 확장자가 지워지는 것을 구조적으로 막는다.
function openPasteDialog(imgs, destLabel, onConfirm) {
    const multi = imgs.length > 1;
    const defName = pastedImageFile(imgs[0], 0).name; // 기존 자동이름 규칙 재사용
    const ext0 = fileExt(defName);
    const stem0 = ext0 ? defName.slice(0, defName.length - ext0.length - 1) : defName;
    const nameIn = el('input', { type: 'text', value: stem0, maxlength: '120', placeholder: '파일 이름' });
    const action = el('p', { class: 'paste-action' }, '클립보드의 ', el('b', { text: '이미지 ' + imgs.length + '개' }), ' 를 ', el('b', { text: destLabel }), ' 에 업로드합니다.');
    const nameRow = el('div', { class: 'paste-name-row' }, nameIn, multi ? null : el('span', { class: 'paste-ext', text: '.' + (ext0 || 'png') }));
    const hint = multi
        ? el('p', { class: 'admin-hint', text: '각 파일 이름 뒤에 -1, -2 … 와 원래 확장자가 붙습니다.' })
        : null;
    const saveBtn = el('button', { class: 'btn btn-primary', text: multi ? (imgs.length + '개 올리기') : '올리기' });
    const cancelBtn = el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => back.remove() });
    const back = overlayBox('붙여넣기', action, el('div', { class: 'field' }, el('label', { class: 'field-label', text: '이름' }), nameRow, hint), el('div', { class: 'ov-actions' }, saveBtn, cancelBtn));
    setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0); // 확장자는 입력칸 밖이라 전체선택해도 안전
    const go = () => {
        let stem = nameIn.value.trim().replace(/[/\\]/g, '-').replace(/^\.+/, '').replace(/\s+/g, ' ').trim();
        if (!stem)
            stem = stem0;
        const files = imgs.map((b, i) => {
            const ext = fileExt(pastedImageFile(b, 0).name) || 'png';
            const nm = (multi ? stem + '-' + (i + 1) : stem) + '.' + ext;
            try {
                return new File([b], nm, { type: b.type });
            }
            catch (_) {
                try {
                    b.name = nm;
                }
                catch (_2) { /* read-only */ }
                return b;
            }
        });
        back.remove();
        onConfirm(files);
    };
    saveBtn.onclick = go;
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter')
        go(); });
}
// 공유 폴더 '전체 보기' — 넓은 팝업에 일반 파일 목록(행 단위)으로 전부 표시. 폴더 탐색·파일 열기 가능.
//  shareBase = 이 프로젝트 폴더의 공유 루트 기준 경로(project.folder) — 행마다 [🔗 링크 복사]를 그리는 좌표(#1436).
//   없으면 그 버튼을 안 그린다(files-cards.projShareRel).
function openFolderGrid(id, startPath, base, shareBase) {
    const B = base || '/api/ui/projects/';
    const st = { path: startPath || '', q: '' };
    let lastFolderItems = []; // 현재 폴더(검색결과 아님) 목록 — 업로드 덮어쓰기 사전확인용(#877). 검색 중이어도 실제 업로드 대상 폴더 기준으로 판정.
    let lastData = null; // 마지막 응답 — 정렬 변경 시 재요청 없이 재렌더(#1118)
    let sort = fileSortLoad(); // 열 정렬 상태(#1118) — 기기별 저장, 홈 팀 공유 폴더 모달과 공유
    const setSort = (s) => { sort = s; fileSortSave(s); if (lastData)
        render(lastData); };
    const searchIn = el('input', { type: 'search', class: 'proj-file-search', placeholder: '파일 검색…' });
    searchIn.addEventListener('input', debounce(() => { st.q = searchIn.value.trim(); load(); }, 300));
    const up = upControl((items) => uploadHere(items, []));
    const mkdirBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '＋ 새 폴더', onclick: () => mkdirHere() });
    const crumb = el('div', { class: 'proj-file-crumb' });
    const listBox = el('div', { class: 'proj-file-llist' });
    const progBox = el('div', { class: 'up-prog-box' }); // 업로드 진행·취소 바(배치별 한 줄, #797)
    const back = overlayBox('공유 폴더 — 전체 보기', el('div', { class: 'proj-fg-head' }, searchIn, el('div', { class: 'proj-fg-actions' }, mkdirBtn, up.btn, up.fileIn, up.dirIn)), crumb, progBox, listBox);
    const box = back.querySelector('.ov-box');
    if (box)
        box.classList.add('ov-box-wide');
    // 드래그앤드롭 업로드(#781) — 이 모달엔 아예 없었다(그래서 끌어다 놔도 아무 일도 안 일어났다).
    //  받는 영역은 오버레이 전체(back) — 모달 밖 배경에 떨어뜨려도 브라우저가 그 파일을 열어 화면을 날리지 않게.
    upDropZone(back, box || back, (items, emptyDirs) => uploadHere(items, emptyDirs));
    const join = (a, b) => (a ? a + '/' + b : b);
    load();
    // 업로드 — 여기엔 진행 표시가 아예 없었다(수백 개를 올려도 화면이 조용했다). 이제 진행 바 + 취소(#797).
    async function uploadHere(items, emptyDirs) {
        const arr = items || [];
        const dirs = emptyDirs || [];
        if (!arr.length && !dirs.length) {
            toast('올릴 파일이 없습니다', true);
            return;
        }
        const cur = lastFolderItems; // 검색 중이어도 실제 업로드 대상 폴더 기준(#877 리뷰)
        const pc = upPrecheckOverwrite(arr, cur); // #877 — 겹치면 무엇이 덮이는지 보여주고 확인
        if (!pc.go)
            return;
        if (arr.length > UP_CONFIRM && !confirm(arr.length + '개 파일을 업로드합니다. 계속할까요?'))
            return;
        const dest = st.path; // 업로드 중 폴더를 옮겨도 '떨어뜨린 그 폴더'로 간다
        const ac = new AbortController();
        const bar = upProgress(arr.length, () => ac.abort());
        progBox.append(bar.row);
        const r = await upSend({
            items: arr, emptyDirs: dirs, signal: ac.signal, overwriteNames: pc.over,
            fileUrl: (rel) => B + id + '/file?path=' + encodeURIComponent((dest ? dest + '/' : '') + rel),
            dirUrl: (d) => B + id + '/folder?path=' + encodeURIComponent((dest ? dest + '/' : '') + d),
            onProgress: (i, rel, pct) => bar.set(i, rel, pct),
        });
        bar.row.remove();
        upToast(r);
        st.q = '';
        searchIn.value = '';
        load();
    }
    function mkdirHere() {
        const nameIn = el('input', { type: 'text', placeholder: '폴더 이름', maxlength: '80' });
        const saveBtn = el('button', { class: 'btn btn-primary', text: '만들기' });
        const b2 = overlayBox('새 폴더', el('p', { class: 'admin-hint', text: (st.path ? '“' + st.path + '” 안에' : '루트에') + ' 새 폴더를 만듭니다.' }), el('div', { class: 'field' }, el('label', { class: 'field-label', text: '폴더 이름' }), nameIn), el('div', { class: 'ov-actions' }, saveBtn, el('button', { class: 'btn btn-ghost', text: '취소', onclick: () => b2.remove() })));
        setTimeout(() => nameIn.focus(), 0);
        const go = async () => {
            const nm = nameIn.value.trim();
            if (!nm) {
                nameIn.focus();
                return;
            }
            saveBtn.disabled = true;
            try {
                await api(B + id + '/folder?path=' + encodeURIComponent((st.path ? st.path + '/' : '') + nm), { method: 'POST' });
                b2.remove();
                toast('폴더를 만들었습니다');
                load();
            }
            catch (e) {
                toast('실패 — ' + e.message, true);
                saveBtn.disabled = false;
            }
        };
        saveBtn.onclick = go;
        nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter')
            go(); });
    }
    async function load() {
        busy(listBox, skeletonRows(5));
        const qs = st.q ? ('?q=' + encodeURIComponent(st.q)) : ('?path=' + encodeURIComponent(st.path));
        let data;
        try {
            data = await api(B + id + '/files' + qs);
        }
        catch (e) {
            listBox.replaceChildren(errorNote(e, '폴더를 불러오지 못했습니다'));
            return;
        }
        if (data.search === undefined)
            lastFolderItems = data.items || []; // 검색 응답은 무시 — 폴더 목록일 때만 갱신
        lastData = data;
        render(data);
    }
    // 정렬 변경은 재요청 없이 마지막 데이터로 즉시 재렌더(#1118).
    function render(data) {
        const items = fileSortApply(data.items || [], sort);
        // 열 머리글 — 어떤 필드인지(이름/크기/수정 일시) 이름표 + 클릭 정렬. 스크롤 시 상단 고정.
        const head = el('div', { class: 'proj-file-lrow proj-file-lhead' }, el('span', { class: 'proj-file-lic' }), el('span', { class: 'proj-file-lnm' }, fileSortBtn('이름', 'name', sort, setSort)), el('span', { class: 'proj-file-lsz' }, fileSortBtn('크기', 'size', sort, setSort)), el('span', { class: 'proj-file-ldt' }, fileSortBtn('수정 일시', 'mtime', sort, setSort)), el('span', { class: 'proj-file-lacts' }));
        if (data.search !== undefined) {
            crumb.replaceChildren(el('span', { text: '“' + data.search + '” 검색 — ' + items.length + '건' }));
            const rows = items.map((it) => projFileRowEl(id, it, it.path, (t) => { st.q = ''; searchIn.value = ''; st.path = t; load(); }, load, B, shareBase));
            listBox.replaceChildren(head, ...(rows.length ? rows : [el('div', { class: 'empty', text: '일치하는 파일이 없어요.' })]));
            return;
        }
        crumb.replaceChildren(el('span', { class: 'proj-crumb-link', text: '⌂ 루트', onclick: () => { st.path = ''; load(); } }), ...(data.path ? [el('span', { text: ' / ' + data.path })] : [])); // replaceChildren 은 null 을 'null' 텍스트로 넣는다 — 루트에서 'null' 노출 버그 수정
        const rows = [];
        if (data.path)
            rows.push(el('div', { class: 'proj-file-lrow', onclick: () => { st.path = data.parent || ''; load(); } }, el('span', { class: 'proj-file-lic', text: '↩' }), el('span', { class: 'proj-file-lnm', text: '상위 폴더' }), el('span', { class: 'proj-file-lsz' }), el('span', { class: 'proj-file-ldt' }), el('span', { class: 'proj-file-lacts' })));
        for (const it of items)
            rows.push(projFileRowEl(id, it, join(st.path, it.name), (t) => { st.path = t; load(); }, load, B, shareBase));
        listBox.replaceChildren(head, ...(rows.length ? rows : [el('div', { class: 'empty', text: '빈 폴더입니다.' })]));
    }
}
function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }
// 이니셜 아바타 — 이름 첫 글자(한글 1자 / 영문 1~2자). 이름 기반 파스텔 배경.
//  R29b: 여기 있던 로컬 정의는 web/lib/avatar.ts 의 것과 **바이트 동일한 사본**이었다(hsl 채도·명도까지 같음)
//  → 사본을 지우고 lib 한 벌로 일원화한다. 아래 export 블록이 그대로 재수출하므로 projects.ts 의 import 문은 무변경.
export { avatarColor, debounce, initials, memberPicker, openFolderGrid, openPasteDialog, pjvTeamPicker, };
export { fileSortApply, fileSortBtn, fileSortLoad, fileSortSave, fmtDateTime, fmtFileDate, fmtFileDateFull, fmtSize } from './files-format.js';
export { fileIconSvg, iconFor } from './files-icons.js';
export { UP_CONFIRM, UP_MANY, authDownload, authUpload, authUploadProgress, upControl, upDropZone, upIsAbort, upPrecheckOverwrite, upProgress, upSend, upToast } from './files-upload.js';
export { openFileViewer, projFileCardEl, projUpCardEl } from './files-cards.js';

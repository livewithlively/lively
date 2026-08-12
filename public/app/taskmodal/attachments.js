// taskmodal/attachments.ts — #1313 R56: web/taskmodal.ts 섹션 분할 ⑥(첨부).
//  프로젝트 폴더 _attachments/task-<id> 목록·업로드(진행·취소) · 공유폴더에서 첨부 · ClickUp DB 첨부(읽기전용) ·
//  클립보드 이미지 붙여넣기 다이얼로그.
import { api, busy, el, toast, TOKEN_KEY } from '../core.js';
// 소유처 직결(#1313 R56) — 배럴 경유였다면 순환 가지가 늘어난다(composer.ts 주석과 같은 이유).
import { pjvPopover } from '../projects/popover.js';
import { authDownload, authUploadProgress, fileIconSvg, fmtSize, openFileViewer, upIsAbort, upProgress, upSend, upToast } from '../projects/files.js';
import { pjvtmSafeUrl, pjvtmStamp } from './util.js';
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
                // shareBase(=프로젝트 폴더 경로)를 넘겨야 뷰어에 [⛶ 전체화면]·[🔗 링크 복사]가 생긴다(#1436).
                //  첨부도 프로젝트 폴더 안의 실제 파일이라 같은 주소축(root=shared + path)으로 가리킬 수 있다.
                onclick: () => openFileViewer(pid, rel, f.name, refresh, base, d.project && d.project.folder) }), el('span', { class: 'pjv-tm-att-size', text: fmtSize(f.size) }), el('button', { class: 'pjv-tm-att-act', type: 'button', title: '다운로드', text: '↓',
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
            busy(rowsBox, el('div', { class: 'pjv-files-empty', text: '불러오는 중…' }));
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
export { pjvtmAttachments, pjvtmPasteImage };

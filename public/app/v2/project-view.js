// v2/project-view.ts — 새 셸의 **프로젝트 화면 = 방**(#1757 v4 — 디자인 전면 재작업).
//
//  ── 방의 구도 (상민님 목업 기준) ──
//  문패(door) — 제목·상태 알약, 그 아래 **현황 블록**(굵은 숫자: 세션·할 일·자료·지식 + ● 지금 N개 돌아가는 중 + 사람 얼굴).
//  방(room) — 구역마다 **성격이 다르다**:
//    · [본문]   왼쪽 큰 벽. 문서 시트(넓은 여백·큰 행간) — 읽는 곳.                        (2행 세로 통짜)
//    · [코멘트] 오른쪽 위 게시판. 얼굴 + 말 카드, 바닥에 쓰는 칸 — 사람들끼리 말하는 곳.
//    · [세션]   오른쪽 아래 작업대. 도는 것은 왼쪽 모서리에 색 띠 — 일이 도는 곳.
//    · [공유 폴더] 아래 **선반**. 파일이 가로로 꽂혀 있다(큰 아이콘 카드) — 물건 놓는 곳.
//  바닥 — 리브 대화 + 입력칸. 대화가 생기면 방|바닥 경계를 끌어 조정(기억).
//
//  ── 이 파일이 모르는 것 ──
//  대화의 읽기·쓰기(web/project-chat.ts) · 세션 생성(quick-session.ts) · 업로드 전송·파일 미리보기(projects/files.ts 헬퍼).
import { api, el, personFace, relTime, renderMarkdown, toast } from '../core.js';
import { UP_CONFIRM, fileIconSvg, fmtFileDateFull, fmtSize, openFileViewer, openFolderGrid, upControl, upDropZone, upPrecheckOverwrite, upProgress, upSend, upToast } from '../projects/files.js';
import { mountProjectChat } from '../project-chat.js';
import { appIcon } from './apps.js';
import { openProjectSession } from './quick-session.js';
import { sessText } from './side.js';
import { makeSplitter } from './split.js';
import { dotCls } from './views.js';
/** 리브에게 보내는 정형 지시 — 칩·바 버튼이 같은 말을 쓴다(둘이 다르면 리브가 다르게 움직인다). */
const SAY_TIDY_NEW = '이 프로젝트의 본문을 정돈된 형식으로 써 줘. 이름·태스크·연결된 지식에서 읽히는 만큼만 — 없는 사실은 지어내지 말고, 모르는 항목은 비워 둬.';
const SAY_TIDY = '본문을 정돈된 형식으로 다시 써 줘. 원문의 사실·결정·링크는 하나도 잃지 말고, 산만한 문장만 정리해.';
const SAY_NEXT = '지금 상태를 읽고 다음에 할 일 2~3개를 제안해 줘. 각각 한 줄로, 바로 시킬 수 있게.';
const SAY_SPLIT = '이 프로젝트를 태스크로 나눠 줘. 만들기 전에 목록을 먼저 보여 줘.';
const SAY_CHECK = '상태·마감·담당·우선순위를 점검하고, 비어 있거나 어긋난 게 있으면 정리해 줘.';
const STATE = (cat) => cat === 'done' ? { word: '끝남', cls: 'done' } : cat === 'unstarted' ? { word: '시작 전', cls: 'todo' } : { word: '진행 중', cls: 'run' };
const when = (ms) => (ms ? relTime(new Date(ms).toISOString()) : '');
const joinPath = (a, b) => (a ? a + '/' + b : b);
export function mountProjectView(host, opts) {
    const id = opts.id;
    let detail = opts.detail;
    let editing = false;
    let chat = null;
    let dead = false;
    let fileTotal = null; // 공유 폴더 재귀 파일 수(자료 n) — 마운트·업로드 때만 잰다
    // ── 골격 — 문패 → 방(구역) → 선반 → [경계 손잡이] → 바닥(대화) ──
    const door = el('header', { class: 'pv-door' });
    const room = el('div', { class: 'pv-room' });
    const shelf = el('section', { class: 'pv-shelf', 'aria-label': '공유 폴더' });
    const top = el('div', { class: 'pv-top' }, door, room, shelf);
    const chatHost = el('div', { class: 'pv-chat' });
    const wrap = el('div', { class: 'pv-wrap' }, top);
    wrap.append(makeSplitter({ axis: 'y', key: 'pv-chat-h', cssVar: '--pv-chat-h', target: wrap, def: 320, min: 170, max: 640, grow: -1, label: '대화 칸 높이' }), chatHost);
    host.replaceChildren(wrap);
    // ── 데이터 접근 ──
    const pj = () => (detail && detail.project) || opts.data().projects.find((x) => Number(x.id) === id) || { id, name: `프로젝트 #${id}` };
    const tasksOf = () => (Array.isArray(detail?.project?.tasks) ? detail.project.tasks : []);
    const sessOf = () => opts.data().sessions.filter((s) => Number(s.projectId) === id)
        .sort((a, b) => Number(b.live && b.alive) - Number(a.live && a.alive) || b.lastSeen - a.lastSeen);
    // ══ 문패 — 제목·상태 알약 / 현황 블록(굵은 숫자) ═══════════════════════════════════════════════
    function paintDoor() {
        const p = pj();
        const st = STATE(p.status_category);
        const tasks = tasksOf();
        const tdone = tasks.filter((t) => t.status_category === 'done' || t.status === 'done').length;
        const sess = sessOf();
        const busy = sess.filter((s) => s.live && s.alive && (s.stateKey === 'busy' || s.stateKey === 'waiting')).length;
        const kn = detail?.project?.knowledge || {};
        const knN = ((kn.required || []).length + (kn.produced || []).length) || 0;
        const members = Array.isArray(detail?.project?.members) ? detail.project.members : [];
        // 현황 블록 — 목업의 "세션 3 / 지식 4 / 할 일 8"을 굵은 숫자로. 라벨은 작게, 숫자가 말한다.
        const vital = (label, val, href, extra) => {
            const kids = [el('span', { class: 'n', text: val }), el('span', { class: 'k', text: label }), extra ?? null];
            return href ? el('a', { class: 'pv-vital', href, title: label }, ...kids) : el('span', { class: 'pv-vital' }, ...kids);
        };
        const facesWrap = members.length
            ? el('span', { class: 'pv-faces', title: members.map((m) => String(m.member_id ?? m)).join(' · ') }, ...members.slice(0, 5).map((m) => personFace(String(m.member_id ?? m), 'pv-face-s')), members.length > 5 ? el('span', { class: 'pv-face-more', text: '+' + (members.length - 5) }) : null)
            : null;
        door.replaceChildren(el('div', { class: 'pv-eyebrow' }, el('span', { class: 'pv-idchip mono', text: '#' + p.id }), p.list && p.list.name ? el('span', { class: 'pv-listname', text: p.list.name }) : null, el('span', { class: 'pv-eyebrow-sp' }), p.updated_at ? el('span', { class: 'pv-when', text: '수정 ' + relTime(p.updated_at) }) : null), el('div', { class: 'pv-title-line' }, el('h1', { class: 'pv-title', text: p.name }), el('span', { class: 'pv-stpill ' + st.cls }, el('span', { class: 'd', 'aria-hidden': 'true' }), el('span', { text: st.word }))), el('div', { class: 'pv-vitals' }, busy ? el('span', { class: 'pv-live' }, el('span', { class: 'v2-dot busy', 'aria-hidden': 'true' }), el('span', { text: `지금 ${busy}개 돌아가는 중` })) : null, vital('세션', String(sess.length)), vital('할 일', tasks.length ? `${tdone}/${tasks.length}` : '0', '#/app/projects2/p/' + id, tasks.length ? el('span', { class: 'pv-minibar', 'aria-hidden': 'true' }, el('span', { class: 'f', style: 'width:' + Math.round((tdone / tasks.length) * 100) + '%' })) : null), vital('자료', fileTotal == null ? '—' : String(fileTotal)), vital('지식', String(knN)), facesWrap));
    }
    // ══ 구역 뼈대 — 슬림 헤더(라벨은 또렷하게) + 안에서 구르는 몸통 (+선택: 바닥 줄) ═══════════════════
    function zone(cls, label, icon) {
        const count = el('span', { class: 'pv-z-n' });
        const acts = el('div', { class: 'pv-z-acts' });
        const body = el('div', { class: 'pv-z-b' });
        const foot = el('div', { class: 'pv-z-f', hidden: true });
        const root = el('section', { class: 'pv-zone ' + cls, 'aria-label': label }, el('div', { class: 'pv-z-h' }, icon ? el('span', { class: 'pv-z-ic', 'aria-hidden': 'true' }, icon) : null, el('h2', { class: 'pv-z-k', text: label }), count, acts), body, foot);
        return { root, count, acts, body, foot };
    }
    // ══ 본문 — 왼쪽 큰 벽(문서 시트) ═══════════════════════════════════════════════════════════════
    const bz = zone('pv-z-doc', '본문', appIcon('wiki'));
    const editBtn = el('button', { class: 'pv-btn', type: 'button', text: '편집', title: '본문을 직접 고칩니다', onclick: () => startEdit() });
    bz.acts.append(editBtn);
    function paintBody() {
        const desc = String(pj().description || '');
        editBtn.disabled = editing;
        editBtn.textContent = editing ? '편집 중' : '편집';
        if (editing) {
            const ta = el('textarea', { class: 'pv-edit-ta', 'aria-label': '본문 편집', placeholder: '이 프로젝트가 무엇을 왜 하는지 — 마크다운' });
            ta.value = desc;
            const save = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '저장' });
            const cancel = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '취소', onclick: () => { editing = false; paintBody(); } });
            const doSave = async () => {
                const v = ta.value.trim();
                if (v === desc.trim()) {
                    editing = false;
                    paintBody();
                    return;
                }
                save.disabled = true;
                save.textContent = '저장 중…';
                try {
                    await api('/api/ui/v6/projects/' + id, { method: 'POST', body: JSON.stringify({ description: v || null }) });
                    if (detail && detail.project)
                        detail.project.description = v || null;
                    editing = false;
                    toast('본문을 저장했어요.');
                    paintBody();
                    opts.onProjectChanged?.();
                    void reload();
                }
                catch (e) {
                    save.disabled = false;
                    save.textContent = '저장';
                    toast('본문을 저장하지 못했습니다 — ' + (e && e.message ? e.message : e), true);
                }
            };
            save.onclick = () => { void doSave(); };
            ta.addEventListener('keydown', (e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void doSave();
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    editing = false;
                    paintBody();
                }
            });
            bz.body.replaceChildren(el('div', { class: 'pv-edit' }, ta));
            bz.foot.hidden = false;
            bz.foot.replaceChildren(el('span', { class: 'pv-hint', text: '마크다운 · ⌘⏎ 저장 · Esc 취소' }), cancel, save);
            window.setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
            return;
        }
        bz.foot.hidden = true;
        bz.foot.replaceChildren();
        if (desc.trim()) {
            bz.body.replaceChildren(el('article', { class: 'pv-sheet' }, renderMarkdown(desc)));
        }
        else {
            bz.body.replaceChildren(el('div', { class: 'pv-blank' }, el('p', { class: 'h', text: '이 방의 본문이 아직 비어 있어요.' }), el('p', { class: 'sub' }, el('button', { class: 'pv-link', type: 'button', text: '리브에게 써 달라고 하기', onclick: () => chat?.say(SAY_TIDY_NEW) }), el('span', { text: ' — 태스크·지식에서 읽히는 만큼만 정돈해 씁니다. 또는 ' }), el('button', { class: 'pv-link', type: 'button', text: '직접 쓰기', onclick: () => startEdit() }))));
        }
    }
    function startEdit() { if (editing)
        return; editing = true; paintBody(); }
    // ══ 코멘트 — 오른쪽 위 게시판(얼굴 + 말 카드 + 쓰는 칸) ══════════════════════════════════════════
    const cz = zone('pv-z-cmt', '코멘트', appIcon('sess'));
    const cIn = el('textarea', { class: 'pv-cmt-in', rows: '1', placeholder: '이 방의 모두에게 남기기', 'aria-label': '코멘트 남기기' });
    const cSend = el('button', { class: 'pv-cmt-send', type: 'button', title: '남기기 (Enter)', 'aria-label': '코멘트 남기기', text: '⏎' });
    cz.foot.hidden = false;
    cz.foot.replaceChildren(el('div', { class: 'pv-cmt-compose' }, cIn, cSend));
    function paintComments(list) {
        cz.count.textContent = list.length ? String(list.length) : '';
        if (!list.length) {
            cz.body.replaceChildren(el('div', { class: 'pv-blank' }, el('p', { class: 'h', text: '아직 코멘트가 없어요.' }), el('p', { class: 'sub', text: '결정·부탁·메모를 남기면 이 방의 모두가 봅니다.' })));
            return;
        }
        cz.body.replaceChildren(...list.map((c) => el('div', { class: 'pv-cmt' }, personFace(String(c.actor || ''), 'pv-cface', c.display_name), el('div', { class: 'pv-cmt-main' }, el('div', { class: 'pv-cmt-h' }, el('b', { text: c.display_name || c.actor || '?' }), el('span', { class: 'ts', text: relTime(c.ts) })), el('div', { class: 'pv-cmt-b', text: c.body })))));
        cz.body.scrollTop = cz.body.scrollHeight;
    }
    function commentsFrom(feed) { return (feed || []).filter((f) => f && f.kind === 'comment'); }
    async function loadComments() {
        try {
            const d = await api('/api/ui/v6/projects/' + id + '/comments?limit=300');
            if (dead)
                return;
            paintComments(commentsFrom(d && d.feed));
        }
        catch {
            if (!dead)
                cz.body.replaceChildren(el('div', { class: 'pv-blank' }, el('p', { class: 'h', text: '코멘트를 불러오지 못했어요.' })));
        }
    }
    async function sendComment() {
        const text = cIn.value.trim();
        if (!text || cSend.disabled)
            return;
        cSend.disabled = true;
        cIn.disabled = true;
        try {
            // 프로젝트 행도 같은 task 표라 태스크 댓글 쓰기를 그대로 쓴다(코멘트 드로어와 같은 문 — task-detail-v6).
            const d = await api('/api/ui/v6/tasks/' + id + '/comments', { method: 'POST', body: JSON.stringify({ text }) });
            cIn.value = '';
            paintComments(commentsFrom(d && d.feed));
        }
        catch (e) {
            toast('코멘트를 남기지 못했습니다 — ' + (e && e.message ? e.message : e), true);
        }
        finally {
            cSend.disabled = false;
            cIn.disabled = false;
            cIn.focus();
        }
    }
    cSend.onclick = () => { void sendComment(); };
    cIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            void sendComment();
        } // 한글 조합 Enter 가드(레포 불변식)
    });
    // ══ 세션 — 오른쪽 아래 작업대(도는 것은 색 띠) ═══════════════════════════════════════════════════
    const sz = zone('pv-z-sess', '세션', appIcon('term'));
    {
        const btn = el('button', { class: 'pv-btn-main', type: 'button', text: '＋ 새 세션', title: '이 프로젝트에 붙은 AI 세션을 엽니다' });
        btn.onclick = () => { btn.disabled = true; void openProjectSession(id, String(pj().name || '')).then((ok) => { if (!ok)
            btn.disabled = false; }); };
        sz.acts.append(btn);
    }
    function paintSessions() {
        const sess = sessOf();
        const live = sess.filter((s) => s.live && s.alive);
        sz.count.textContent = sess.length ? String(sess.length) + (live.length ? ` · 살아 있음 ${live.length}` : '') : '';
        if (!sess.length) {
            sz.body.replaceChildren(el('div', { class: 'pv-blank' }, el('p', { class: 'h', text: '아직 이 방에서 돈 세션이 없어요.' }), el('p', { class: 'sub', text: '[＋ 새 세션]으로 시작하거나, 아래에서 리브에게 먼저 계획을 시켜 보세요.' })));
            return;
        }
        const pname = String(pj().name || '');
        sz.body.replaceChildren(...sess.slice(0, 60).map((s) => {
            const raw = (s.raw || {});
            const tx = sessText(s, pname); // 사이드바와 같은 규칙 — 프로젝트명 되풀이 제거·'지금 하는 일' 승격
            const owner = !s.owned && (raw.owner_name || raw.owner) ? String(raw.owner_name || raw.owner) : '';
            const acc = s.live && s.alive && (s.stateKey === 'busy' || s.stateKey === 'waiting') ? ' acc-' + s.stateKey : '';
            return el('a', { class: 'pv-row' + (s.live && s.alive ? '' : ' dim') + acc, href: '#/s/' + encodeURIComponent(s.id), title: s.label }, el('span', { class: 'v2-dot ' + dotCls(s.stateKey), 'aria-hidden': 'true' }), el('span', { class: 'pv-row-main' }, el('span', { class: 't', text: tx.main }), el('span', { class: 'm' }, el('span', { class: 'st-' + s.stateKey, text: s.stateLabel + (s.live ? '' : ' · 기록만') }), el('span', { text: [' · ' + when(s.lastSeen), owner ? ' · ' + owner : '', tx.sub ? ' · ' + tx.sub : ''].join('') }))), el('span', { class: 'pv-row-go', 'aria-hidden': 'true', text: '›' }));
        }));
    }
    room.replaceChildren(bz.root, cz.root, sz.root);
    // ══ 공유 폴더 — 아래 선반(파일이 가로로 꽂힌다) ═══════════════════════════════════════════════════
    const F = '/api/ui/v6/projects/'; // 파일 라우트는 v6 만 등록돼 있다(클래식 상세의 V6_BASE 와 동일)
    const fst = { path: '' };
    let folderItems = [];
    const shelfCount = el('span', { class: 'pv-z-n' });
    const crumbBox = el('span', { class: 'pv-crumbs' });
    const progBox = el('span', { class: 'pv-upprog' });
    const shelfBody = el('div', { class: 'pv-shelf-b' });
    {
        const up = upControl((items) => void uploadHere(items, []), { className: 'pv-btn', label: '올리기' });
        const allBtn = el('button', { class: 'pv-btn', type: 'button', text: '전체 보기', title: '넓은 화면에서 검색·정렬·일괄 작업',
            onclick: () => openFolderGrid(id, fst.path, F, pj().folder || undefined) });
        shelf.append(el('div', { class: 'pv-z-h' }, el('span', { class: 'pv-z-ic', 'aria-hidden': 'true' }, fileIconSvg('', true)), el('h2', { class: 'pv-z-k', text: '공유 폴더' }), shelfCount, crumbBox, progBox, el('div', { class: 'pv-z-acts' }, up.btn, allBtn, up.fileIn, up.dirIn)), shelfBody);
        upDropZone(shelf, shelf, (items, emptyDirs) => void uploadHere(items, emptyDirs)); // 선반 전체가 드롭존(#781)
    }
    function paintCrumb() {
        const segs = fst.path ? fst.path.split('/') : [];
        const kids = [el('button', { class: 'pv-crumb' + (segs.length ? '' : ' cur'), type: 'button', text: '⌂', title: '루트로',
                onclick: () => { fst.path = ''; void loadFolder(); } })];
        segs.forEach((seg, i) => {
            kids.push(el('span', { class: 'pv-crumb-sep', 'aria-hidden': 'true', text: '/' }));
            const cur = i === segs.length - 1;
            kids.push(el('button', { class: 'pv-crumb' + (cur ? ' cur' : ''), type: 'button', text: seg, disabled: cur,
                onclick: () => { fst.path = segs.slice(0, i + 1).join('/'); void loadFolder(); } }));
        });
        crumbBox.replaceChildren(...kids);
    }
    function paintFolder(items) {
        folderItems = items || [];
        shelfCount.textContent = folderItems.length ? String(folderItems.length) : '';
        paintCrumb();
        if (!folderItems.length) {
            shelfBody.replaceChildren(el('div', { class: 'pv-shelf-blank' }, el('span', { text: fst.path ? '빈 폴더예요 — ' : '아직 파일이 없어요 — ' }), el('span', { text: '파일이나 폴더를 이 선반에 끌어다 놓으면 올라갑니다.' })));
            return;
        }
        const sorted = [...folderItems].sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || String(a.name).localeCompare(String(b.name), 'ko'));
        shelfBody.replaceChildren(...sorted.slice(0, 120).map((it) => {
            const isDir = it.type === 'dir';
            const rel = joinPath(fst.path, it.name);
            return el('button', { class: 'pv-file' + (isDir ? ' dir' : ''), type: 'button', title: it.name + (it.mtime ? '\n' + fmtFileDateFull(it.mtime) : ''),
                onclick: () => { if (isDir) {
                    fst.path = rel;
                    void loadFolder();
                }
                else {
                    void openFileViewer(id, rel, it.name, () => void loadFolder(), F, pj().folder || undefined);
                } } }, el('span', { class: 'ic', 'aria-hidden': 'true' }, fileIconSvg(it.name, isDir)), el('span', { class: 'nm', text: it.name }), el('span', { class: 'mt', text: isDir ? '폴더' : fmtSize(it.size) }));
        }));
    }
    async function loadFolder() {
        try {
            const d = await api(F + id + '/files?path=' + encodeURIComponent(fst.path));
            if (dead)
                return;
            paintFolder((d && d.items) || []);
        }
        catch (e) {
            if (dead)
                return;
            shelfBody.replaceChildren(el('div', { class: 'pv-shelf-blank' }, el('span', { text: '폴더를 불러오지 못했어요 — ' + (e && e.message ? e.message : e) })));
        }
    }
    async function uploadHere(items, emptyDirs) {
        const arr = items || [];
        if (!arr.length && !(emptyDirs || []).length) {
            toast('올릴 파일이 없습니다', true);
            return;
        }
        const pc = upPrecheckOverwrite(arr, folderItems); // 겹치면 무엇이 덮이는지 보여주고 확인(#877)
        if (!pc.go)
            return;
        if (arr.length > UP_CONFIRM && !confirm(arr.length + '개 파일을 업로드합니다. 계속할까요?'))
            return;
        const dest = fst.path; // 업로드 중 다른 폴더로 들어가도 '떨어뜨린 그 폴더'로 간다
        const ac = new AbortController();
        const bar = upProgress(arr.length, () => ac.abort());
        progBox.append(bar.row);
        const r = await upSend({
            items: arr, emptyDirs: emptyDirs || [], signal: ac.signal, overwriteNames: pc.over,
            fileUrl: (rel) => F + id + '/file?path=' + encodeURIComponent((dest ? dest + '/' : '') + rel),
            dirUrl: (d) => F + id + '/folder?path=' + encodeURIComponent((dest ? dest + '/' : '') + d),
            onProgress: (i, rel, pct) => bar.set(i, rel, pct),
        });
        bar.row.remove();
        upToast(r);
        void loadFolder();
        void loadFileTotal();
    }
    async function loadFileTotal() {
        // 자료 n(문패) = 공유 폴더 재귀 파일 수 — 마운트·업로드 때만 잰다(재귀 walk 라 폴링엔 안 태운다).
        try {
            const d = await api(F + id + '/shared/manifest');
            if (!dead && d && typeof d.count === 'number') {
                fileTotal = d.count;
                paintDoor();
            }
        }
        catch { /* 문패만 '—' 로 남는다 */ }
    }
    /** 리브 턴이 끝났거나 사람이 저장했다 — 방을 서버에서 다시 읽는다(대화는 건드리지 않는다). 편집 중이면 본문은 미룬다. */
    async function reload() {
        try {
            const d = await api('/api/ui/v6/projects/' + id);
            if (dead)
                return;
            if (d && d.project) {
                detail = d;
                paintDoor();
                if (!editing)
                    paintBody();
                paintSessions();
            }
        }
        catch { /* 다음 턴에 다시 */ }
    }
    // ══ 바닥 — 리브 대화. 빈 대화엔 제안 칩(입력칸 위), 대화가 생기면 경계 손잡이 ═══════════════════════
    function opening() {
        const desc = String(pj().description || '').trim();
        const chips = [
            desc ? ['본문 정돈해 줘', SAY_TIDY] : ['본문 써 줘', SAY_TIDY_NEW],
            tasksOf().length ? ['다음 할 일 제안', SAY_NEXT] : ['태스크로 나눠 줘', SAY_SPLIT],
            ['상태·마감 점검', SAY_CHECK],
        ];
        return el('div', { class: 'pv-open' }, el('span', { class: 'pv-open-lede' }, el('b', { text: '리브' }), el('span', { text: ' — 본문·태스크·상태·지식 연결을 대화로 고칩니다. 이 방의 기록만 만지고, 셸·파일은 건드리지 않아요.' })), el('span', { class: 'pv-chips' }, ...chips.map(([label, say]) => el('button', { class: 'pv-chip', type: 'button', text: label, title: say, onclick: () => chat?.say(say) }))));
    }
    const barNote = el('span', { class: 'pv-bar-note', text: '리브 · 라이블리 도구만 · 이 프로젝트 폴더에서' });
    const barTidy = el('button', { class: 'pv-bar-btn', type: 'button', text: '본문 정리', title: '리브가 본문을 정돈된 형식으로 다시 씁니다', onclick: () => chat?.say(String(pj().description || '').trim() ? SAY_TIDY : SAY_TIDY_NEW) });
    const barNew = el('button', { class: 'pv-bar-btn', type: 'button', text: '새 대화', title: '이어가던 대화를 놓고 새로 시작합니다', onclick: () => chat?.restart() });
    chat = mountProjectChat(chatHost, {
        projectId: id,
        opening: opening(),
        bar: { left: barNote, right: el('span', { class: 'pv-bar-r' }, barTidy, barNew) },
        onTurnDone: () => { void reload(); opts.onProjectChanged?.(); },
        onHasTurns: (has) => wrap.classList.toggle('has-turns', has),
    });
    paintDoor();
    paintBody();
    paintSessions();
    paintCrumb();
    void loadFolder();
    void loadComments();
    void loadFileTotal();
    // 세션·문패의 상태점은 라이브를 따라간다 — main.ts 가 20초마다 갱신하는 목록을 25초마다 다시 그린다(요청 없음).
    const tick = window.setInterval(() => { if (!document.hidden) {
        paintSessions();
        paintDoor();
    } }, 25000);
    return {
        destroy() { dead = true; window.clearInterval(tick); if (chat) {
            chat.destroy();
            chat = null;
        } },
    };
}

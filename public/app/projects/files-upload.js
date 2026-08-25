// projects/files-upload.ts — #1405 W1: files.ts 분할 ③.
//  인증 전송(다운로드·업로드)과 업로드 파이프라인 전체 —
//   수집(input·드롭 재귀 순회) → 정규화·숨김파일 제외 → 덮어쓰기 사전확인 → 순차 전송(취소 가능) → 결과 토스트.
//  순수 잎 — UpItem/UpResult 계약도 여기 산다.
import { TOKEN_KEY, api, el, toast } from '../core.js';
import { pjvPopover } from './popover.js';
async function authDownload(url, filename) {
    const token = localStorage.getItem(TOKEN_KEY);
    let res;
    try {
        res = await fetch(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    }
    catch (e) {
        toast('다운로드 실패 — ' + e.message, true);
        return;
    }
    if (!res.ok) {
        toast('다운로드 실패 (' + res.status + ')', true);
        return;
    }
    const blob = await res.blob();
    const a = el('a', { href: URL.createObjectURL(blob), download: filename || 'download' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
// 업로드 취소(#797) — 취소는 어느 경로로 끊었든 name==='AbortError' 하나로 알아본다(XHR·fetch·루프 공통).
//  끊긴 PUT 은 서버가 임시파일만 지우고 목적지는 손대지 않는다(src/terminal/upload-file.ts) → 취소해도 깨진 파일이 남지 않는다.
const upAbortErr = () => { const e = new Error('업로드를 취소했습니다'); e.name = 'AbortError'; return e; };
const upIsAbort = (e) => !!e && (e.name === 'AbortError');
// 업로드 실패 문구(#1272) — 게이트웨이 응답이면 그 `{error}` 를 그대로 쓰고, 아니면 그 사실을 말한다.
//  게이트웨이는 업로드에 403·407·451 을 **쓰지 않고**, 자기가 낸 오류엔 항상 `{error}` 본문을 붙인다.
//  → 이 조합이면 브라우저와 게이트웨이 사이에서 막힌 것이다(실제 사례: 사내 PC 문서보안(DLP) 에이전트가
//  업로드 본문을 차단하고 페이지에만 403 을 돌려줬다 — 게이트웨이는 응답조차 하지 않았다).
//  받는 사람이 **누구에게 문의해야 하는지**를 바꾸는 정보라 반드시 말해 준다. 이 한 줄이 없어서
//  '업로드 실패 (403)' 만 보고 게이트웨이 권한 문제로 오해한 채 시간을 썼다.
const UP_NOT_OURS = [403, 407, 451];
const upFailMsg = (status, bodyErr) => bodyErr || ('업로드 실패 (' + status + ')'
    + (UP_NOT_OURS.indexOf(status) >= 0 ? ' — 게이트웨이가 보낸 응답이 아닙니다(내 PC 보안프로그램(DLP)이나 사내 프록시가 막은 것으로 보입니다)' : ''));
// 인증 fetch 업로드(PUT raw 스트림). 파일 본문 그대로.
//  ⚠ Content-Type 은 **octet-stream 으로 박는다** — 비우면 브라우저가 File.type 으로 채우는데, .json 파일이면
//  application/json 이 되어 게이트웨이 전역 express.json(1MB 상한)이 본문을 먼저 삼킨다(1MB 초과 413 · 이하는
//  스트림이 소비돼 0바이트 저장 — src/preview/proxy-body.test.ts 가 기록한 그 사고 축). 서버 수신(receiveUpload)은
//  Content-Type 을 안 보므로 어떤 파일이든 octet-stream 이 맞다.
async function authUpload(url, file, signal) {
    const token = localStorage.getItem(TOKEN_KEY);
    const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: file, signal });
    if (!res.ok) {
        let m = '';
        try {
            m = (await res.json()).error;
        }
        catch (_) { /* */ }
        throw new Error(upFailMsg(res.status, m));
    }
}
// 진행률 콜백 업로드 — fetch 는 업로드 progress 가 없어 XHR 사용. onProgress(pct 0~100).
//  signal(선택) — 취소되면 xhr.abort() 로 **지금 전송 중인 파일까지** 즉시 끊는다(다음 파일을 안 보내는 것만으론 큰 파일에서 한참 기다린다).
//  성공 시 서버 응답 JSON 을 돌려준다(파싱 안 되면 null) — 새 세션 컴포저 첨부가 응답의 절대경로(path)를 쓴다(#1870).
function authUploadProgress(url, file, onProgress, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            reject(upAbortErr());
            return;
        }
        const token = localStorage.getItem(TOKEN_KEY);
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', url);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream'); // authUpload 와 같은 이유(위 ⚠)
        if (token)
            xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        const onAbort = () => xhr.abort();
        if (signal)
            signal.addEventListener('abort', onAbort);
        xhr.upload.onprogress = (ev) => { if (ev.lengthComputable && onProgress)
            onProgress((ev.loaded / ev.total) * 100); };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                let j = null;
                try {
                    j = JSON.parse(xhr.responseText);
                }
                catch (_) { /* */ }
                resolve(j);
            }
            else {
                let m = '';
                try {
                    m = JSON.parse(xhr.responseText).error;
                }
                catch (_) { /* */ }
                reject(new Error(upFailMsg(xhr.status, m)));
            }
        };
        xhr.onerror = () => reject(new Error('네트워크 오류'));
        xhr.onabort = () => reject(upAbortErr());
        xhr.onloadend = () => { if (signal)
            signal.removeEventListener('abort', onAbort); }; // load·error·abort 어느 쪽이든 리스너 정리
        xhr.send(file);
    });
}
const UP_MANY = 12; // 이보다 많으면 파일별 카드 대신 묶음 진행 카드 1개(그리드 폭주 방지)
const UP_CONFIRM = 200; // 이보다 많으면 확인 — 큰 폴더를 실수로 떨어뜨렸을 때의 안전핀
// 덮어쓰기 사전 검사(#877) — 올릴 항목이 현재 폴더의 기존 파일/폴더와 이름이 겹치는지 본다.
//  currentItems = 지금 보고 있는 폴더 목록([{name,type}]) — 검색결과 화면이면 폴더 컨텍스트가 아니라 호출부가 [] 를 준다.
//  중첩(rel 에 '/')은 최상위 세그먼트(폴더)만 판단: 그 폴더가 이미 있으면 '병합'이라 안쪽 같은 이름 파일만 덮인다.
function upCollisions(items, currentItems) {
    const byName = new Map();
    for (const it of (currentItems || []))
        if (it && it.name)
            byName.set(it.name, it.type);
    const files = new Set(), dirs = new Set(), conflicts = new Set();
    for (const u of (items || [])) {
        const top = String(u.rel || '').split('/')[0];
        const t = byName.get(top);
        if (!t)
            continue;
        if (String(u.rel).includes('/')) {
            if (t === 'dir')
                dirs.add(top);
            else
                conflicts.add(top);
        } // 폴더 병합 vs 같은 이름 파일 아래로(서버가 거부)
        else if (t === 'file')
            files.add(top); // 직접 파일 덮어쓰기
        else
            conflicts.add(top); // 폴더와 같은 이름의 파일(서버가 거부)
    }
    return { files: [...files], dirs: [...dirs], conflicts: [...conflicts] };
}
// 덮어쓰기 확인 — 겹치는 게 있으면 무엇이 덮이는지 목록으로 보여주고 confirm(마이크 이슈 #877: 조용히 덮이던 것을 명시).
//  반환: 계속하면 { go:true, over:Set<덮어쓸 직접 파일명> }, 취소면 { go:false }. over 는 결과 요약('N개 덮어씀')용으로 upSend 에 넘긴다.
function upPrecheckOverwrite(items, currentItems) {
    const { files, dirs, conflicts } = upCollisions(items, currentItems);
    const over = new Set(files);
    if (!files.length && !dirs.length && !conflicts.length)
        return { go: true, over };
    const cap = (arr) => arr.slice(0, 10).map((n) => '  • ' + n).join('\n') + (arr.length > 10 ? ('\n  …외 ' + (arr.length - 10) + '개') : '');
    const parts = [];
    if (files.length)
        parts.push('이미 있는 파일 ' + files.length + '개를 덮어씁니다:\n' + cap(files));
    if (dirs.length)
        parts.push('이미 있는 폴더 ' + dirs.length + '개 — 그 안의 같은 이름 파일만 덮어써집니다:\n' + cap(dirs));
    if (conflicts.length)
        parts.push('이름이 겹쳐(파일↔폴더) 업로드가 거부될 수 있는 항목 ' + conflicts.length + '개:\n' + cap(conflicts));
    return { go: confirm(parts.join('\n\n') + '\n\n계속할까요?'), over };
}
// 상대경로 정규화 — 빈 세그먼트 제거, '.' 제거, '..'(경로 탈출)은 항목 자체를 버림. 서버도 봉쇄하지만 프론트에서 먼저 막는다.
function upSafeRel(rel) {
    const parts = String(rel || '').split('/').filter((s) => s !== '' && s !== '.');
    if (!parts.length || parts.some((s) => s === '..'))
        return null;
    return parts.join('/');
}
// 숨김(.으로 시작) 항목은 폴더 안에서만 걸러낸다 — 서버 목록·매니페스트가 dotfile 을 숨기므로 올려도 화면에 안 보이고
//  로컬로도 안 내려간다(= .DS_Store·Thumbs.db 같은 OS 잡동사니만 쌓인다). 사용자가 직접 고른 최상위 파일은 존중해 그대로 올린다.
function upHidden(rel) {
    const parts = rel.split('/');
    return parts.length > 1 && parts.some((s) => s.startsWith('.'));
}
function upNormalize(items) {
    const out = [];
    for (const it of items) {
        const rel = upSafeRel(it.rel);
        if (!rel || upHidden(rel))
            continue;
        out.push({ file: it.file, rel });
    }
    return out;
}
// <input webkitdirectory> 로 고른 폴더 — File.webkitRelativePath('폴더명/하위/파일')가 구조를 담고 있다(윈도·리눅스·맥 동일).
//  일반 파일 선택이면 webkitRelativePath 가 빈 문자열이라 rel = 파일명.
function upFromInput(input) {
    return upNormalize(Array.from(input.files || []).map((f) => ({ file: f, rel: String(f.webkitRelativePath || f.name) })));
}
// 브라우저가 폴더 선택을 지원하는가(webkitdirectory) — 데스크탑 크롬·엣지·파폭·사파리는 모두 지원. 미지원이면 메뉴에서 감춘다.
function upDirSupported() {
    try {
        return 'webkitdirectory' in HTMLInputElement.prototype;
    }
    catch (_) {
        return false;
    }
}
// 드롭한 폴더는 dataTransfer.files 로는 못 읽는다(내용 없는 항목으로만 잡혀 통째로 유실).
//  webkitGetAsEntry()(FileSystemEntry)로 트리를 재귀 순회해야 하위 파일까지 온다 — 크롬·엣지·파폭·사파리 공통.
//  ⚠ dataTransfer.items 는 드롭 핸들러가 끝나면 무효화된다 → await 하기 전에 동기로 entry 를 전부 꺼내둔다.
function upDropEntries(dt) {
    const out = [];
    for (const it of Array.from(dt.items || [])) {
        if (it.kind !== 'file')
            continue;
        const ent = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
        if (ent)
            out.push(ent);
    }
    return out;
}
// FileSystemDirectoryReader.readEntries 는 한 번에 최대 100건만 준다 — 빈 배열이 올 때까지 반복해야 폴더를 다 읽는다.
function upReadAll(reader) {
    return new Promise((resolve, reject) => {
        const acc = [];
        const step = () => reader.readEntries((batch) => {
            if (!batch || !batch.length) {
                resolve(acc);
                return;
            }
            acc.push(...batch);
            step();
        }, reject);
        step();
    });
}
const upEntryFile = (ent) => new Promise((res, rej) => ent.file(res, rej));
// 드롭 이벤트 → 업로드 목록. emptyDirs = 파일이 하나도 없는 폴더(빈 폴더도 만들어 줘야 구조가 보존된다).
//  entries API 가 없는 구형 브라우저는 예전처럼 파일만 받는다(폴더는 못 받음 — 기존 동작 유지).
async function upFromDrop(dt) {
    const roots = upDropEntries(dt); // ⚠ 반드시 await 전에(동기) — items 무효화 회피
    if (!roots.length) {
        const items = upNormalize(Array.from(dt.files || []).map((f) => ({ file: f, rel: String(f.name) })));
        return { items, emptyDirs: [] };
    }
    const items = [];
    const emptyDirs = [];
    const walk = async (ent, prefix) => {
        const name = String(ent.name || '');
        if (prefix && name.startsWith('.'))
            return; // 폴더 안의 숨김은 제외(최상위로 직접 끌어온 건 존중)
        const rel = prefix ? prefix + '/' + name : name;
        if (ent.isFile) {
            items.push({ file: await upEntryFile(ent), rel });
            return;
        }
        if (!ent.isDirectory)
            return;
        const kids = (await upReadAll(ent.createReader())).filter((k) => !String(k.name || '').startsWith('.'));
        if (!kids.length) {
            emptyDirs.push(rel);
            return;
        }
        for (const k of kids)
            await walk(k, rel);
    };
    for (const ent of roots)
        await walk(ent, '');
    return { items: upNormalize(items), emptyDirs: emptyDirs.map(upSafeRel).filter(Boolean) };
}
// '＋ 업로드' 버튼 — 파일 / 폴더 선택 메뉴(폴더는 <input webkitdirectory> 로만 고를 수 있어 입력이 따로다).
//  반환한 입력 두 개는 호출부가 헤더에 함께 append 한다(숨김 input).
//  opts.className/label — 버튼 톤을 부르는 화면에 맞춘다(프로젝트 카드 = btn btn-ghost, 대시보드 브라우저 = dash-fb-btn, #795).
function upControl(onPick, opts) {
    const fileIn = el('input', { type: 'file', multiple: '', style: 'display:none' });
    const dirIn = el('input', { type: 'file', multiple: '', webkitdirectory: '', style: 'display:none' });
    fileIn.addEventListener('change', () => { onPick(upFromInput(fileIn)); fileIn.value = ''; });
    dirIn.addEventListener('change', () => { onPick(upFromInput(dirIn)); dirIn.value = ''; });
    const btn = el('button', { class: (opts && opts.className) || 'btn btn-ghost btn-sm', type: 'button', text: (opts && opts.label) || '＋ 업로드' });
    btn.onclick = (e) => {
        e.stopPropagation();
        const menu = el('div', { class: 'pjv-menu' });
        const close = pjvPopover(btn, menu, { align: 'right' });
        const mk = (label, desc, fn) => {
            const item = el('button', { class: 'pjv-menu-item', type: 'button' }, el('span', { style: 'display:flex;flex-direction:column;gap:1px;min-width:0' }, el('span', { text: label }), el('span', { class: 'caption', text: desc })));
            item.onclick = (ev) => { ev.stopPropagation(); close(); fn(); };
            return item;
        };
        menu.append(mk('파일 올리기', '여러 개 선택 가능', () => fileIn.click()));
        if (upDirSupported())
            menu.append(mk('폴더 올리기', '하위 폴더까지 구조 그대로', () => dirIn.click()));
    };
    return { btn, fileIn, dirIn };
}
// 드래그앤드롭 배선 — zone 위로 파일·폴더를 끌어오면 hi 에 .drop-active, 놓으면 onDrop(items, emptyDirs).
//  드롭 핸들러는 동기로 upFromDrop 을 호출해야 한다(items 무효화) → 여기서 한 번만 제대로 해두고 두 화면이 같이 쓴다.
function upDropZone(zone, hi, onDrop) {
    let depth = 0;
    const hasFiles = (ev) => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
    const clear = () => { depth = 0; hi.classList.remove('drop-active'); };
    zone.addEventListener('dragenter', (ev) => { if (hasFiles(ev)) {
        ev.preventDefault();
        depth++;
        hi.classList.add('drop-active');
    } });
    zone.addEventListener('dragover', (ev) => { if (hasFiles(ev)) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
    } });
    zone.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth)
        hi.classList.remove('drop-active'); });
    zone.addEventListener('drop', (ev) => {
        if (!hasFiles(ev))
            return;
        ev.preventDefault();
        clear();
        upFromDrop(ev.dataTransfer) // 동기 시작(내부에서 entry 를 먼저 꺼낸다)
            .then(({ items, emptyDirs }) => onDrop(items, emptyDirs))
            .catch((e) => toast('끌어온 항목을 읽지 못했습니다 — ' + (e && e.message ? e.message : e), true));
    });
}
async function upSend(o) {
    const arr = o.items || [], dirs = o.emptyDirs || [];
    const overSet = o.overwriteNames || null;
    let ok = 0, fail = 0, made = 0, over = 0;
    for (let i = 0; i < arr.length; i++) {
        if (o.signal.aborted)
            return { ok, fail, made, over, canceled: true };
        const u = arr[i];
        if (o.onProgress)
            o.onProgress(i, u.rel, 0);
        try {
            await authUploadProgress(o.fileUrl(u.rel), u.file, (pct) => { if (o.onProgress)
                o.onProgress(i, u.rel, pct); }, o.signal);
            ok += 1;
            if (overSet && !String(u.rel).includes('/') && overSet.has(u.rel))
                over += 1; // 기존 파일을 실제로 덮어씀
            if (o.onProgress)
                o.onProgress(i, u.rel, 100);
        }
        catch (e) {
            if (upIsAbort(e))
                return { ok, fail, made, over, canceled: true }; // 전송 중이던 파일이 끊김 = 취소
            fail += 1;
            toast(u.rel + ' 실패 — ' + e.message, true);
        }
    }
    // 빈 폴더는 올릴 파일이 없으니 mkdir 로 만들어 준다(구조 보존).
    for (const d of dirs) {
        if (o.signal.aborted)
            return { ok, fail, made, over, canceled: true };
        if (!o.dirUrl)
            break;
        try {
            await api(o.dirUrl(d), { method: 'POST' });
            made += 1;
        }
        catch (_) { /* 비치명 — 파일은 이미 올라갔다 */ }
    }
    return { ok, fail, made, over, canceled: false };
}
// 업로드 결과 알림 — 취소했으면 **몇 개까지 올라갔는지** 반드시 말한다(조용히 멈추면 사용자가 폴더 상태를 알 수 없다).
//  ⚠ ok 는 '성공 응답까지 확인한' 개수 = 하한이다. 취소를 누른 그 순간 서버가 이미 다 받아 저장을 마쳤는데 응답만 못 받은
//   파일이 1개 더 있을 수 있다(끊는 쪽은 상대가 끝냈는지 알 길이 없다 — HTTP 취소의 본질적 모호성). 그래서 호출부는 취소
//   뒤에도 목록을 다시 읽어 사용자가 '진짜 상태'를 보게 한다. 어느 경우든 파일 자체는 온전하다(부분 파일 X — src/terminal/upload-file.ts).
function upToast(r) {
    const over = r.over ? ' · ' + r.over + '개 덮어씀' : ''; // #877 — 덮어쓴 개수를 결과에도 명시(사전확인과 짝)
    if (r.canceled) {
        toast(r.ok ? (r.ok + '개까지 올리고 취소했습니다' + over) : '업로드를 취소했습니다');
        return;
    }
    if (r.ok || r.made)
        toast((r.ok ? r.ok + '개 업로드 완료' : r.made + '개 폴더 생성') + over + (r.fail ? (' · ' + r.fail + '개 실패') : ''));
}
// 업로드 진행 + 취소 바 — 배치 하나당 한 줄. 배치가 동시에 여러 개 돌면 줄도 여러 개라 '어느 업로드를 끊는지' 헷갈리지 않는다.
//  세 화면이 같은 바를 쓴다(.up-prog) — 취소 어포던스를 화면마다 다르게 만들 이유가 없다.
//  opts.label — 전송 시작 전에 보일 문구(예: 공유 폴더에서 첨부는 '원본을 읽는 중…'). set() 이 불리면 '업로드 중 — …' 으로 바뀐다.
function upProgress(total, onCancel, opts) {
    const label = el('div', { class: 'up-prog-label', text: (opts && opts.label) || '업로드 준비 중…' });
    const fill = el('div', { class: 'up-prog-fill' });
    const btn = el('button', { class: 'btn btn-ghost btn-sm up-prog-cancel', type: 'button', text: '취소' });
    const row = el('div', { class: 'up-prog' }, el('div', { class: 'up-prog-main' }, label, el('div', { class: 'up-prog-bar' }, fill)), btn);
    btn.onclick = (ev) => { ev.stopPropagation(); btn.disabled = true; btn.textContent = '취소 중…'; onCancel(); };
    return {
        row,
        // i = 0-based 현재 파일, pct = 그 파일의 진행률 → 바는 배치 전체 기준으로 채운다.
        set(i, rel, pct) {
            const nm = String(rel || '').split('/').pop() || rel;
            label.textContent = '업로드 중 — ' + (total > 1 ? (Math.min(i + 1, total) + '/' + total + ' · ') : '') + nm;
            fill.style.width = (total > 0 ? ((i + pct / 100) / total) * 100 : pct) + '%';
        },
    };
}
export { UP_CONFIRM, UP_MANY, authDownload, authUpload, authUploadProgress, upControl, upDropZone, upIsAbort, upPrecheckOverwrite, upProgress, upSend, upToast };

// v2/files.ts — 세션 작업 폴더 **파일 탐색기**(우패널, #1744).
//
//  ── 어디에 사나 ──
//   종전 파일 탐색기는 터미널 단독 페이지(public/terminal.html) 왼쪽에 붙어 있었다. 그 페이지가 세션 화면과 같은
//   컴포넌트로 합쳐지면서(상단바 통합), 탐색기는 **우패널**(타임라인이 있는 자리)로 옮겨 온다 — 세션 화면의 [파일]
//   버튼이 우패널을 '타임라인 ↔ 파일'로 갈아 끼운다(v2/main.ts drawAsideFiles). 열은 그대로 셋이고 내용만 바뀐다.
//
//  ── 무엇을 하나 ──
//   목록(GET …/ls) · 미리보기(GET …/file — 공용 렌더러 lib/file-preview) · 다운로드 · 업로드(PUT …/file) ·
//   새 폴더(POST …/mkdir) · 공유 링크 복사(#/f?root=&path= — lib/sharelink).
//   미리보기는 **제자리 전환**이다(대시보드 폴더 위젯과 같은 문법): 목록 자리에 본문을 깔고 [← 뒤로]로 돌아온다.
//   우패널은 좁으므로 정독·공유는 [⛶ 전체화면](#/f 새 탭)이 맡는다.
//
//  ── 심링크(#1744) ──
//   세션 폴더의 `project` 처럼 **폴더를 가리키는 링크**는 종전에 목록에서 '파일'로 나와 눌러도 미리보기만 열렸다
//   (dirent.isDirectory() 가 링크에 false 라서). 서버가 이제 링크를 따라가 실효 종류와 목적지를 함께 준다
//   (src/terminal/terminal-files.ts readDirItems) → 여기서는 폴더 링크를 **그 경로로 들어가게** 하고, 어디로
//   이어졌는지(목적지)를 경로줄 아래 한 줄로 말해 준다. 파일 링크는 그냥 그 파일을 연다.
import { TOKEN_KEY, api, apiUrl, el, toast } from '../core.js';
import { buildFilePreview } from '../lib/file-preview.js';
import { copyFileLink, fileLinkUrl, shareLinkIcon } from '../lib/sharelink.js';
import { fmtSize } from '../projects/files-format.js';
const authFetch = (path, init) => {
    const t = localStorage.getItem(TOKEN_KEY);
    const headers = Object.assign({}, (init && init.headers) || {}, t ? { Authorization: 'Bearer ' + t } : {});
    return fetch(apiUrl(path), Object.assign({}, init, { headers, credentials: 'same-origin' }));
};
const fileIcon = (name, type) => type === 'dir' ? '📁' : /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i.test(name) ? '🖼' : /\.(md|markdown)$/i.test(name) ? '📝' : '📄';
/** 세션 파일 탐색기를 host 에 그린다(우패널 한 칸을 통째로 쓴다). */
export function createSessionFiles(host, opts) {
    const sid = opts.sessionId;
    const nodeQ = (join) => (opts.node ? join + 'node=' + encodeURIComponent(String(opts.node)) : '');
    const sUrl = (suffix) => '/api/ui/terminal/sessions/' + encodeURIComponent(sid) + suffix + nodeQ(suffix.indexOf('?') >= 0 ? '&' : '?');
    let curDir = '';
    let shareRoot = null; // 'shared' | 'personal' | null(좌표 없음 = 원격 노드 등 → 링크 버튼 안 그림)
    let sharePath = '';
    // 지금 보는 폴더가 어떤 심링크를 타고 들어온 것인지 — {세션 기준 경로: 링크 목적지}. 경로줄 아래 한 줄로 말해 준다.
    let linkFrom = null;
    let destroyed = false;
    let seq = 0; // 늦게 온 응답이 새 폴더를 덮지 않게
    const pathEl = el('div', { class: 'fx-path' });
    const linkEl = el('div', { class: 'fx-linknote', hidden: true });
    const listEl = el('div', { class: 'fx-list' });
    const scroll = el('div', { class: 'fx-scroll' }, listEl);
    const upInput = el('input', { type: 'file', multiple: '', hidden: '' });
    const iconBtn = (label, title, onclick) => el('button', { class: 'fx-hbtn', type: 'button', title, 'aria-label': title, text: label, onclick });
    const head = el('div', { class: 'v2-aside-h fx-head' }, el('b', { text: '파일' }), el('span', { class: 'fx-scope', text: '세션 작업 폴더' }), el('span', { class: 'fx-hacts' }, iconBtn('＋', '새 폴더', () => { void newFolder(); }), iconBtn('⬆', '업로드', () => { upInput.value = ''; upInput.click(); }), iconBtn('⟳', '새로고침', () => { void loadDir(curDir); }), opts.onClose ? iconBtn('×', '타임라인으로 돌아가기', () => opts.onClose()) : null));
    const root = el('section', { class: 'v2-files' }, head, pathEl, linkEl, scroll, upInput);
    host.append(root);
    // ── 경로줄 — 조각마다 눌러서 그 폴더로. ──
    function paintPath() {
        const parts = curDir ? curDir.split('/').filter(Boolean) : [];
        const kids = [el('button', { class: 'fx-crumb', type: 'button', text: '/', title: '세션 작업 폴더', onclick: () => { void loadDir(''); } })];
        let acc = '';
        for (const p of parts) {
            acc = acc ? acc + '/' + p : p;
            const to = acc;
            kids.push(el('span', { class: 'fx-crumb-sep', text: '›', 'aria-hidden': 'true' }));
            kids.push(el('button', { class: 'fx-crumb', type: 'button', text: p, title: '/' + to, onclick: () => { void loadDir(to); } }));
        }
        pathEl.replaceChildren(...kids);
        // 심링크를 타고 들어와 있으면 '진짜 어디인지'를 말해 준다 — 안 그러면 세션 폴더 안에 그 내용이 있는 줄 안다.
        const on = !!linkFrom && (curDir === linkFrom.path || curDir.startsWith(linkFrom.path + '/'));
        linkEl.hidden = !on;
        if (on && linkFrom)
            linkEl.replaceChildren(el('span', { class: 'fx-link-ic', text: '↪', 'aria-hidden': 'true' }), el('span', { class: 'mono', text: linkFrom.target }));
    }
    // ── 목록 ──
    async function loadDir(p) {
        if (destroyed)
            return;
        const mine = ++seq;
        curDir = p || '';
        if (linkFrom && !(curDir === linkFrom.path || curDir.startsWith(linkFrom.path + '/')))
            linkFrom = null;
        paintPath();
        scroll.replaceChildren(listEl);
        listEl.replaceChildren(el('p', { class: 'v2-empty', text: '불러오는 중…' }));
        let data;
        try {
            data = await api(sUrl('/ls?path=' + encodeURIComponent(curDir)));
        }
        catch (e) {
            if (mine === seq)
                listEl.replaceChildren(el('p', { class: 'v2-empty', text: '폴더를 읽지 못했어요 — ' + (e?.message || e) }));
            return;
        }
        if (destroyed || mine !== seq)
            return;
        shareRoot = data.shareRoot || null;
        sharePath = data.sharePath || '';
        const items = Array.isArray(data.items) ? data.items : [];
        const rows = [];
        if (data.parent !== null && curDir)
            rows.push(el('div', { class: 'fx-row fx-up' }, el('button', { class: 'fx-open', type: 'button', title: '상위 폴더', onclick: () => { void loadDir(String(data.parent || '')); } }, el('span', { class: 'fx-ic', text: '↩', 'aria-hidden': 'true' }), el('span', { class: 'fx-nm', text: '..' }))));
        for (const it of items) {
            const childPath = (curDir ? curDir + '/' : '') + it.name;
            const isDir = it.type === 'dir';
            const shareRel = shareRoot ? (sharePath ? sharePath + '/' + it.name : it.name) : null;
            // 링크는 목적지까지 툴팁으로 말한다 — 폴더 링크를 누르면 **그 경로로 들어간다**(#1744: 종전엔 '파일'로 나와 못 들어갔다).
            const tip = it.link ? `${it.name} → ${it.linkTarget || '(목적지를 읽지 못했어요)'}` : it.name;
            rows.push(el('div', { class: 'fx-row' + (it.link ? ' is-link' : '') }, el('button', { class: 'fx-open', type: 'button', title: tip,
                onclick: () => {
                    if (isDir) {
                        linkFrom = it.link ? { path: childPath, target: it.linkTarget || '' } : linkFrom;
                        void loadDir(childPath);
                    }
                    else
                        void showPreview(childPath, it.name, it.size, shareRel);
                } }, el('span', { class: 'fx-ic', text: fileIcon(it.name, it.type), 'aria-hidden': 'true' }), el('span', { class: 'fx-nm', text: it.name }), it.link ? el('span', { class: 'fx-link', text: '↪', 'aria-hidden': 'true' }) : null, el('span', { class: 'fx-sz', text: isDir ? '' : fmtSize(it.size) })), el('span', { class: 'fx-acts' }, shareRel ? act(shareLinkIcon(), '링크 복사', () => { void copyFileLink(shareRoot, shareRel, isDir ? 'dir' : 'file'); }) : null, !isDir ? act('⬇', '다운로드', () => { void download(childPath, it.name); }) : null)));
        }
        listEl.replaceChildren(...(rows.length ? rows : [el('p', { class: 'v2-empty', text: '이 폴더는 비어 있어요. 파일을 끌어다 놓거나 [⬆] 로 올릴 수 있어요.' })]));
    }
    function act(label, title, onClick) {
        return el('button', { class: 'fx-act', type: 'button', title, 'aria-label': title, onclick: onClick }, label);
    }
    // ── 미리보기 — 목록 자리에 제자리 전환. 판정·렌더·툴바는 공용 렌더러가 소유한다(#1436). ──
    async function showPreview(rel, name, size, shareRel) {
        const mine = ++seq;
        const viewUrl = sUrl('/file?path=' + encodeURIComponent(rel));
        const dlUrl = sUrl('/file?path=' + encodeURIComponent(rel) + '&download=1');
        const mkBtn = (label, onClick) => el('button', { class: 'fx-hbtn', type: 'button', text: label, onclick: onClick });
        const bar = el('div', { class: 'fx-pbar' }, el('button', { class: 'fx-hbtn', type: 'button', text: '← 뒤로', onclick: () => { void loadDir(curDir); } }), el('span', { class: 'fx-pname', title: name, text: name }));
        const stage = el('div', { class: 'fx-pstage' }, el('p', { class: 'v2-empty', text: '불러오는 중…' }));
        scroll.replaceChildren(bar, stage);
        let out;
        try {
            out = await buildFilePreview({
                name, size,
                fetchView: () => authFetch(viewUrl),
                fetchDownload: () => authFetch(dlUrl),
                cls: { img: 'fx-p-img', pdf: 'fx-p-pdf', md: 'fx-p-md', code: 'fx-p-code', html: 'fx-p-pdf', table: 'fx-p-table', audio: 'fx-p-audio', video: 'fx-p-video', msg: 'fx-p-msg' },
                pdfHash: '#navpanes=0&toolbar=1&view=FitH', // 우패널은 좁다 — 썸네일 사이드바를 끈다
                mkBtn,
                save: async (text) => {
                    const res = await authFetch(viewUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: new Blob([text]) });
                    if (!res.ok)
                        throw new Error('저장 실패 (' + res.status + ')');
                },
                onSaved: () => toast('저장했습니다.'),
                onError: (m) => toast(m, true),
            });
        }
        catch (e) {
            if (mine === seq)
                stage.replaceChildren(el('p', { class: 'v2-empty', text: '미리보기 실패 — ' + (e?.message || e) }));
            return;
        }
        if (destroyed || mine !== seq)
            return;
        bar.append(...out.tools, shareRel ? el('a', { class: 'fx-hbtn', href: fileLinkUrl(shareRoot, shareRel), target: '_blank', rel: 'noopener', title: '전체화면(새 탭)으로 열기', text: '⛶' }) : null, el('button', { class: 'fx-hbtn', type: 'button', title: '다운로드', text: '⬇', onclick: () => { void download(rel, name); } }));
        stage.replaceChildren(out.body);
    }
    async function download(rel, name) {
        try {
            const res = await authFetch(sUrl('/file?path=' + encodeURIComponent(rel) + '&download=1'));
            if (!res.ok)
                throw new Error('' + res.status);
            const url = URL.createObjectURL(await res.blob());
            const a = el('a', { href: url, download: name });
            document.body.append(a);
            a.click();
            a.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1500);
        }
        catch (e) {
            toast('다운로드 실패 — ' + (e?.message || e), true);
        }
    }
    // ── 업로드 — [⬆] 와 끌어다 놓기 둘 다 지금 폴더로. ──
    async function uploadMany(files) {
        for (const f of files) {
            const rel = (curDir ? curDir + '/' : '') + f.name;
            try {
                const res = await authFetch(sUrl('/file?path=' + encodeURIComponent(rel)), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
                if (!res.ok) {
                    const d = await res.json().catch(() => null);
                    throw new Error((d && d.error) || String(res.status));
                }
                toast('업로드: ' + f.name);
            }
            catch (e) {
                toast('업로드 실패: ' + f.name + ' — ' + (e?.message || e), true);
            }
        }
        void loadDir(curDir);
    }
    upInput.addEventListener('change', () => { const fs = [...(upInput.files || [])]; if (fs.length)
        void uploadMany(fs); });
    root.addEventListener('dragover', (e) => {
        if (!(e.dataTransfer && [...e.dataTransfer.types].includes('Files')))
            return;
        e.preventDefault();
        root.classList.add('fx-drag');
    });
    root.addEventListener('dragleave', (e) => { if (e.target === root)
        root.classList.remove('fx-drag'); });
    root.addEventListener('drop', (e) => {
        const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
        if (!files.length)
            return;
        e.preventDefault();
        root.classList.remove('fx-drag');
        void uploadMany(files);
    });
    async function newFolder() {
        const name = window.prompt('새 폴더 이름');
        if (!name || !name.trim())
            return;
        const rel = (curDir ? curDir + '/' : '') + name.trim();
        try {
            await api(sUrl('/mkdir?path=' + encodeURIComponent(rel)), { method: 'POST', body: '{}' });
            toast('폴더를 만들었어요: ' + name.trim());
            void loadDir(curDir);
        }
        catch (e) {
            toast('폴더를 만들지 못했어요 — ' + (e?.message || e), true);
        }
    }
    void loadDir('');
    return { root, destroy() { destroyed = true; root.remove(); } };
}

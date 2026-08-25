// v2/compose-attach.ts — 새 세션 컴포저(홈 v2/views.ts · 프로젝트 칸 v2/panes-parts.ts)의 **파일 첨부 한 곳**(#1870).
//  종전엔 프로젝트 칸(#1819)에만 붙여넣기·드롭이 있었고 홈 입력창엔 첨부 경로가 아예 없었다 — 같은
//  '새 세션 여는 말풍선'인데 한쪽만 파일을 받는 건 화면 문법이 갈라진 것이라, 붙여넣기·드래그앤드롭에
//  [＋] 버튼(파일 피커)까지 이 모듈로 합친다. 두 컴포저가 이걸 같이 쓰므로 한쪽만 고쳐질 일이 없다.
//
//  올릴 곳 — 컴포저가 선 자리에 따라 갈린다(둘 다 세션이 열리기 **전**에 존재하는 안정된 workspace다):
//   · 프로젝트가 있으면 — 그 프로젝트 공유 폴더(PUT /api/ui/v6/projects/:id/file — 자료 칸에 바로 보인다)
//   · 없으면(홈 런처·프로젝트 없는 칸) — 내 개인 폴더 uploads/ (PUT /api/ui/terminal/browse/file?root=personal)
//  어느 쪽이든 서버가 준 **절대경로**를 첫 지시 꼬리에 적는다 — 사용자가 어느 cwd를 골라도 첨부 좌표가 흔들리지 않는다.
//
//  업로드는 authUploadProgress(XHR) — 상한이 1GB 로 열려(#1870) 진행률 없는 업로드는 멈춘 것과 구분이 안 된다.
//  진행률은 그 파일의 칩에 % 로 얹고, 올리는 중엔 ✕ 가 취소를 겸한다. 올리는 중 전송(Enter)은 호출자가
//  busy() 로 막는다 — 안 막으면 아직 안 올라간 파일이 지시에서 조용히 빠진다(큰 파일에서 실제로 나는 사고).
import { apiUrl, el, toast } from '../core.js';
import { authUploadProgress, upDropZone, upIsAbort } from '../projects/files-upload.js';
import { attachName, pnIcon } from './panes-kit.js';
// 서버 상한과 같은 값(terminal-files.ts·project-routes.ts MAX_UPLOAD = 1GB) — 서버까지 갔다 413 으로 돌아오기 전에 거른다.
const MAX_ATTACH = 1024 * 1024 * 1024;
/** projectId() > 0 이면 그 프로젝트 공유 폴더로, 아니면 내 개인 폴더로 올린다. onChanged 는 성공 뒤(자료 칸 갱신용). */
export function composerAttach(opts) {
    const items = [];
    const chips = el('div', { class: 'pn-att', hidden: true });
    function paint() {
        chips.hidden = !items.length;
        chips.replaceChildren(...items.map((a) => el('span', { class: 'pn-att-c', title: a.abs || a.name }, pnIcon('doc', 'pn-i sm'), el('span', { class: 'n', text: a.pct == null ? a.name : `${a.name} · ${Math.floor(a.pct)}%` }), el('button', { class: 'pn-att-x', type: 'button', title: a.pct == null ? '첨부 빼기' : '올리기 취소', 'aria-label': a.pct == null ? '첨부 빼기' : '올리기 취소', text: '✕',
            onclick: () => { a.ctl?.abort(); const i = items.indexOf(a); if (i >= 0)
                items.splice(i, 1); paint(); } }))));
    }
    const urlFor = (nm) => {
        const pid = opts.projectId();
        return pid > 0
            ? apiUrl('/api/ui/v6/projects/' + pid + '/file?path=' + encodeURIComponent(nm))
            : apiUrl('/api/ui/terminal/browse/file?root=personal&path=' + encodeURIComponent('uploads/' + nm));
    };
    async function attachFiles(files) {
        if (!files.length)
            return;
        let ok = 0;
        for (const f of files) {
            if (f.size > MAX_ATTACH) {
                toast(`${f.name || '파일'} — 파일이 너무 커요(상한 1GB). 나눠서 올려주세요.`, true);
                continue;
            }
            const nm = attachName(f, items.map((a) => a.name));
            const ctl = new AbortController();
            const a = { name: nm, abs: '', pct: 0, ctl };
            items.push(a);
            paint();
            try {
                // 순차 업로드(upSend 와 같은 이유) — 병렬로 쏘면 큰 파일 여럿이 회선을 나눠 서로 오래 걸린다.
                const j = await authUploadProgress(urlFor(nm), f, (pct) => { if (items.indexOf(a) >= 0) {
                    a.pct = pct;
                    paint();
                } }, ctl.signal);
                if (items.indexOf(a) < 0)
                    continue; // 올리는 중에 ✕(취소)로 이미 뺐다
                a.pct = null;
                a.ctl = null;
                a.abs = (j && j.path) || nm;
                ok++;
                paint();
                opts.onChanged?.(); // 프로젝트 자료 칸이 같은 화면에 있으면 바로 보이게
            }
            catch (e) {
                const i = items.indexOf(a);
                if (i >= 0) {
                    items.splice(i, 1);
                    paint();
                }
                if (!upIsAbort(e))
                    toast(nm + ' 올리기 실패 — ' + (e && e.message ? e.message : e), true);
            }
        }
        if (ok && !opts.dead?.())
            toast(opts.projectId() > 0 ? '자료에 올렸어요 — 이 세션에 시킬 때 함께 넘어갑니다.' : '올렸어요 — 이 세션에 시킬 때 함께 넘어갑니다.');
    }
    const fileIn = el('input', { type: 'file', multiple: '', hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
    fileIn.addEventListener('change', () => { void attachFiles(Array.from(fileIn.files || [])); fileIn.value = ''; });
    const btn = el('button', { class: 'v2-launch-att', type: 'button', title: '파일 첨부', 'aria-label': '파일 첨부', onclick: () => fileIn.click() }, el('span', { 'aria-hidden': 'true', text: '＋' }));
    return {
        chips, btn, fileIn,
        wirePaste(ta) {
            ta.addEventListener('paste', (e) => {
                const dt = e.clipboardData;
                if (!dt)
                    return;
                const files = Array.from(dt.items || []).filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
                if (!files.length)
                    return; // 글 붙여넣기는 평소대로 입력칸에 들어간다
                e.preventDefault();
                void attachFiles(files);
            });
        },
        wireDrop(zone, hi) {
            // 폴더를 떨어뜨리면 안의 파일들이 펼쳐져 온다(upDropZone 이 트리를 걷는다) — 칩은 파일 단위.
            upDropZone(zone, hi || zone, (list) => void attachFiles(list.map((u) => u.file)));
        },
        busy: () => items.some((a) => a.pct != null),
        tail() {
            const done = items.filter((a) => a.pct == null && a.abs);
            if (!done.length)
                return '';
            const where = opts.projectId() > 0 ? '이 프로젝트 공유 폴더' : '내 개인 폴더';
            return '\n\n첨부한 자료(' + where + '):\n' + done.map((a) => '- ' + a.abs).join('\n');
        },
        clear() { for (const a of items)
            a.ctl?.abort(); items.length = 0; paint(); },
    };
}

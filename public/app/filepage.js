// filepage.ts — 공유 링크의 착지 화면(#1436): `#/f?root=<shared|personal>&path=<rel>`.
//
// ## 무엇인가
//  공유 워크스페이스·개인 폴더의 파일·폴더 **하나만** 보여주는 전체 페이지다. 상단 탭·사이드바 같은 앱 내비게이션이
//  없다(main.ts 가 data-route="f" 를 세우고 32-file-share.css 가 셸을 감춘다) — 링크를 받은 사람이 "무엇을 봐야
//  하는지" 찾지 않아도 되게. 대신 그 파일에 필요한 것만 상단 바에 둔다: 이름·경로 · 링크 복사 · 다운로드 ·
//  (md/html) 렌더↔원문 토글 · Lively 앱으로 나가는 문.
//
// ## 표시 규칙 (요구 원문 그대로)
//  md·html = 렌더 · pdf = 브라우저 내장 PDF 뷰어 · 이미지/표(csv·tsv)/음성/영상/텍스트·코드 = 제자리 미리보기 ·
//  그 외 = 다운로드 버튼. 타입 판정표(확장자·MIME·상한)는 대시보드 폴더 브라우저와 **같은 한 벌**을 쓴다
//  (dash/widget-folders-preview.ts) — 같은 파일이 화면에 따라 다르게 열리면 그게 곧 버그로 신고된다.
//
// ## html 은 왜 iframe(sandbox)인가
//  아래 renderHtml 주석 참조. 요약: 같은 오리진에서 남이 올린 html 을 그냥 심으면 저장형 XSS(세션 쿠키·토큰 탈취)다.
//
// ## 권한
//  이 화면은 특권이 없다 — 파일을 읽는 API 가 기존 게이트(공유폴더 ACL + 프로젝트 가시성)를 그대로 집행한다.
//  안 보이는 경로는 목록에서 빠지므로 여기선 '찾을 수 없음'으로 보인다(존재 은닉 정책과 같은 결).
import { TOKEN_KEY, api, apiUrl, el, errorNote, toast } from './core.js';
import { copyFileLink, fileLinkHash, joinRel, shareLinkIcon, shareRootLabel } from './lib/sharelink.js';
import { buildFilePreview } from './lib/file-preview.js'; // 미리보기 판정·렌더의 단일 소유(세 화면 공용)
import { dashFileThumb, dashFolderThumb } from './dash/icons.js';
import { fmtFileDateFull, fmtSize } from './projects/files-format.js';
// 인증 fetch — **apiUrl 경유**가 중요하다: 프리뷰 서브패스(/preview/<id>/ui/)에서 뜬 화면이 fetch('/api/…')를
//  그대로 쓰면 오리진 루트(=라이브 게이트웨이)로 새어 '새 프론트 + 구 백엔드'를 본다(lib/net.ts 헤더 주석).
//  ⚠ dash/widget-folders-preview.ts 의 dashAuthFetch 는 그 버그가 남아 있어(그 파일 주석에 명시) 여기서 쓰지 않는다.
function fileFetch(url) {
    const t = localStorage.getItem(TOKEN_KEY);
    return fetch(apiUrl(url), { headers: t ? { Authorization: 'Bearer ' + t } : {} });
}
const browseQs = (root, rel) => 'root=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(rel || '');
/** 라우터 진입점 — #/f?root=&path= 를 그린다. */
async function renderFilePage(view, params) {
    const root = String(params.get('root') || 'shared');
    const rel = String(params.get('path') || '').replace(/^\/+|\/+$/g, '');
    const name = rel ? rel.split('/').pop() : shareRootLabel(root);
    const stage = el('div', { class: 'fpg-stage' }, el('div', { class: 'fpg-msg', text: '불러오는 중…' }));
    const acts = el('div', { class: 'fpg-acts' });
    const head = el('header', { class: 'fpg-head' }, el('div', { class: 'fpg-idbox' }, el('div', { class: 'fpg-name', title: name, text: name }), crumb(root, rel)), acts);
    view.replaceChildren(el('div', { class: 'fpg' }, head, stage));
    // 루트 자신은 언제나 폴더 — 부모가 없어 아래 '부모 목록에서 나를 찾기'가 성립하지 않는다.
    if (!rel) {
        await showDir(root, '', stage, acts);
        return;
    }
    // 타입(파일/폴더)·크기는 **부모 목록**에서 얻는다. 파일에 stat 라우트가 따로 없고, 목록 응답은 공개범위
    //  게이트를 이미 통과한 것만 담으므로 "권한 없음"과 "없음"이 같은 답(안 보임)으로 수렴한다 — 존재 은닉 유지.
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    let entry = null;
    try {
        const d = await api('/api/ui/terminal/browse?' + browseQs(root, parent));
        entry = ((d && d.items) || []).find((i) => i.name === name) || null;
    }
    catch (e) {
        stage.replaceChildren(errorNote(e, '이 링크를 열지 못했습니다'));
        acts.replaceChildren(...tailActions(root, rel, 'file'));
        return;
    }
    if (!entry) {
        stage.replaceChildren(el('div', { class: 'fpg-msg fpg-msg-empty' }, el('b', { text: '이 링크의 대상을 찾을 수 없어요' }), el('span', { text: '파일이 옮겨졌거나 이름이 바뀌었을 수 있어요. 볼 권한이 없을 때도 같게 보입니다 — 공유한 사람에게 확인해 주세요.' }), el('div', { class: 'fpg-msg-path', text: shareRootLabel(root) + ' / ' + rel })));
        acts.replaceChildren(...tailActions(root, rel, 'file'));
        return;
    }
    if (entry.type === 'dir') {
        await showDir(root, rel, stage, acts);
        return;
    }
    await showFile(root, rel, name, entry, stage, acts);
}
// 경로 브레드크럼 — 각 조각이 그 폴더의 공유 링크다(같은 페이지 안에서 위로 걸어 올라갈 수 있게).
function crumb(root, rel) {
    const box = el('nav', { class: 'fpg-crumb', 'aria-label': '경로' }, el('a', { class: 'fpg-crumb-seg', href: fileLinkHash(root, ''), text: shareRootLabel(root) }));
    let acc = '';
    for (const seg of (rel ? rel.split('/') : [])) {
        acc = acc ? acc + '/' + seg : seg;
        box.append(el('span', { class: 'fpg-crumb-sep', text: '/' }), el('a', { class: 'fpg-crumb-seg', href: fileLinkHash(root, acc), text: seg }));
    }
    return box;
}
// 어느 화면에서나 붙는 꼬리 액션 — 링크 복사 + (파일이면) 다운로드 + 앱으로 나가는 문.
//  '앱에서 보기'를 두는 이유: 이 페이지는 의도적으로 막다른 길(내비 없음)이라, 받은 사람이 Lively 를 처음
//  본 경우 여기서 조직 화면으로 들어갈 문이 하나는 있어야 한다.
function tailActions(root, rel, kind, dlUrl) {
    const out = [];
    out.push(el('button', { class: 'fpg-btn fpg-btn-primary', type: 'button', title: '이 ' + (kind === 'dir' ? '폴더' : '파일') + '의 링크 복사',
        onclick: () => copyFileLink(root, rel, kind) }, shareLinkIcon(15), el('span', { text: '링크 복사' })));
    if (kind === 'file' && dlUrl) {
        out.push(el('button', { class: 'fpg-btn', type: 'button', text: '⬇ 다운로드', onclick: () => download(dlUrl, rel.split('/').pop() || 'file') }));
    }
    out.push(el('a', { class: 'fpg-btn fpg-btn-ghost', href: '#/dashboard', title: 'Lively 홈으로', text: 'Lively ↗' }));
    return out;
}
// 인증 다운로드 — <a download> 는 헤더를 실을 수 없어 blob 을 거친다(projects/files-upload.authDownload 와 같은 수).
async function download(url, name) {
    try {
        const res = await fileFetch(url);
        if (!res.ok)
            throw new Error('' + res.status);
        const href = URL.createObjectURL(await res.blob());
        const a = el('a', { href, download: name });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 1500);
    }
    catch (e) {
        toast('다운로드 실패 — ' + (e.message || e), true);
    }
}
// ── 폴더 ────────────────────────────────────────────────────────────────────
//  폴더 링크는 '이 폴더를 열어 보라'는 뜻이므로 목록을 준다(파일마다 링크를 다시 뿌리지 않아도 되게 행마다 🔗).
//  여기선 업로드·삭제 같은 편집을 일부러 넣지 않는다 — 공유받은 사람의 화면이고, 편집 표면은 앱 안에 이미 있다.
async function showDir(root, rel, stage, acts) {
    acts.replaceChildren(...tailActions(root, rel, 'dir'));
    let data;
    try {
        data = await api('/api/ui/terminal/browse?' + browseQs(root, rel));
    }
    catch (e) {
        stage.replaceChildren(errorNote(e, '폴더를 불러오지 못했습니다'));
        return;
    }
    const items = (data && data.items) || [];
    if (!items.length) {
        stage.replaceChildren(el('div', { class: 'fpg-msg', text: '빈 폴더입니다.' }));
        return;
    }
    const list = el('div', { class: 'fpg-list' }, el('div', { class: 'fpg-row fpg-row-head' }, el('span', { class: 'fpg-row-ic' }), el('span', { class: 'fpg-row-nm', text: '이름' }), el('span', { class: 'fpg-row-sz', text: '크기' }), el('span', { class: 'fpg-row-dt', text: '수정 일시' }), el('span', { class: 'fpg-row-act' })));
    for (const it of items) {
        const childRel = joinRel(rel, it.name);
        const isDir = it.type === 'dir';
        list.append(el('a', { class: 'fpg-row' + (isDir ? ' is-dir' : ''), href: fileLinkHash(root, childRel), title: it.name }, el('span', { class: 'fpg-row-ic' }, isDir ? dashFolderThumb() : dashFileThumb(it.name)), el('span', { class: 'fpg-row-nm', text: it.name }), el('span', { class: 'fpg-row-sz', text: isDir ? '' : fmtSize(it.size) }), el('span', { class: 'fpg-row-dt', text: fmtFileDateFull(it.mtime) }), el('span', { class: 'fpg-row-act' }, el('button', { class: 'fpg-rowbtn', type: 'button', title: '링크 복사', 'aria-label': '링크 복사',
            onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); copyFileLink(root, childRel, isDir ? 'dir' : 'file'); } }, shareLinkIcon(13)))));
    }
    stage.replaceChildren(list);
}
// ── 파일 ────────────────────────────────────────────────────────────────────
async function showFile(root, rel, name, entry, stage, acts) {
    const viewUrl = '/api/ui/terminal/browse/file?' + browseQs(root, rel);
    const dlUrl = '/api/ui/terminal/browse/file?download=1&' + browseQs(root, rel);
    const size = Number(entry && entry.size) || 0;
    const mkBtn = (label, onClick) => el('button', { class: 'fpg-btn', type: 'button', text: label, onclick: onClick });
    const tail = tailActions(root, rel, 'file', dlUrl);
    acts.replaceChildren(...tail);
    let out;
    try {
        // 타입 판정·렌더·툴바 동작은 공용 렌더러가 소유한다(홈 모달·프로젝트 모달과 **같은 코드**).
        //  이 화면은 전체페이지라 PDF 썸네일 사이드바를 켜 둔다(모달과 달리 폭이 넉넉해 목차가 쓸모 있다).
        //  편집(save)은 주지 않는다 — 링크를 받은 사람의 읽기 화면이고, 편집 표면은 앱 안(모달)에 이미 있다.
        out = await buildFilePreview({
            name, size,
            fetchView: () => fileFetch(viewUrl),
            fetchDownload: () => fileFetch(dlUrl),
            cls: { img: 'fpg-img', pdf: 'fpg-pdf', html: 'fpg-html', md: 'fpg-md', code: 'fpg-code', table: 'fpg-table', audio: 'fpg-audio', video: 'fpg-video', msg: 'fpg-msg' },
            pdfHash: '#toolbar=1&view=FitH',
            mkBtn,
        });
    }
    catch (e) {
        stage.replaceChildren(el('div', { class: 'fpg-msg', text: '미리보기 실패 — ' + ((e && e.message) || e) }));
        return;
    }
    acts.replaceChildren(...out.tools, ...tail);
    stage.replaceChildren(out.body);
    // 미리보기가 없는 형식이면 이 화면의 결론은 '내려받기'다 — 상단 바에만 두지 말고 본문 가운데에 크게 한 번 더.
    //  (공용 렌더러는 안내 문구만 만든다. '이 화면에서 무엇을 하라'는 화면 소관이라 여기서 붙인다.)
    if (out.tools.length === 0 && out.body.classList && out.body.classList.contains('fp-msg')) {
        out.body.classList.add('fpg-msg-empty');
        out.body.append(el('div', { class: 'fpg-msg-path', text: name + (size ? ' · ' + fmtSize(size) : '') }), el('button', { class: 'fpg-btn fpg-btn-primary fpg-btn-lg', type: 'button', text: '⬇ 다운로드', onclick: () => download(dlUrl, name) }));
    }
}
export { renderFilePage };

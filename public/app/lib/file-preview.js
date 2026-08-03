// lib/file-preview.ts — 파일 미리보기 **단일 렌더러**(#1436 후속).
//
// ## 왜 하나로 모았나
//  같은 파일이 화면마다 다르게 열리고 있었다(실측):
//   · `.csv` — 프로젝트 폴더 모달은 textarea 원문 / 홈 팀공유폴더 모달은 표
//   · `.mp4`·`.mp3` — 프로젝트 모달은 "미리보기 지원하지 않는 형식" / 홈은 재생
//   · `.md` — 프로젝트 모달은 편집·저장 가능 / 홈은 읽기 전용
//  두 모달이 프로젝트 상세와 대시보드에서 **각각 따로 자란** 결과다. 기능이 갈릴 이유가 없고, 갈려 있으면
//  사용자는 "왜 여기선 표로 나오고 저기선 안 나오지"를 버그로 신고한다. 그래서 **판정·렌더·툴바 동작**을
//  여기 한 곳으로 모으고, 각 화면은 '어디에 놓을지'와 '버튼을 어떤 모양으로 그릴지'만 정한다.
//  → 세 소비자: 홈 폴더 브라우저(dash/widget-folders) · 프로젝트 파일 뷰어(projects/files-cards) ·
//    공유 링크 전체페이지(filepage). 각각의 장점이 이제 셋 다에 있다.
//
// ## 화면별로 남는 차이 (의도된 것)
//  ① 놓이는 자리 — 프로젝트는 오버레이 모달(섹션이 인라인이라 제자리 전환할 컨테이너가 없다),
//     홈은 브라우저 모달 안 제자리 전환, 공유 링크는 전체페이지. 이건 문맥이 실제로 달라서다.
//  ② 크기 — 컨테이너가 다르니 max-height 등이 다르다. `cls` 로 화면별 클래스를 덧붙여 기존 규칙을 보존한다
//     (공유 클래스 `fp-*` 가 기본, 화면 클래스가 크기를 덮는다). ⚠ 기존 셀렉터는 지우지 않는다 —
//     scripts/check-css-drops.mjs 가 HEAD 셀렉터 유실을 실패로 잡는다(2026-06-30 사고 재발 방지).
//
// leaf 규약: lib/ 안(dom·markdown)만 딛는다. 페이지 모듈을 import 하지 않는다.
import { el } from './dom.js';
import { renderMarkdown } from './markdown.js';
// ── 타입 판정표 — 이 표가 곧 "무엇을 어떻게 보여주는가"의 단일 소스다. ──
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif' };
const AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', opus: 'audio/opus' };
const VIDEO_MIME = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg', mkv: 'video/x-matroska' };
const PREVIEW_IMG = Object.keys(IMG_MIME);
const PREVIEW_TABLE = new Set(['csv', 'tsv']);
const MEDIA_MAX = 80 * 1024 * 1024; // 미디어는 서버 인라인 상한을 우회해 받으므로 메모리 보호 상한을 클라가 둔다
const HTML_EXTS = new Set(['html', 'htm']);
const MD_EXTS = new Set(['md', 'markdown']);
const PREVIEW_TEXT = ['txt', 'md', 'markdown', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'zsh', 'html', 'htm', 'css', 'scss', 'sass', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml', 'sql', 'java', 'go', 'rs', 'c', 'cc', 'cpp', 'h', 'hpp', 'rb', 'php', 'lua', 'r', 'kt', 'swift', 'log', 'env', 'gitignore', 'dockerfile', 'makefile'];
const PREVIEW_CODE = new Set(['json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'zsh', 'html', 'htm', 'css', 'scss', 'sass', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml', 'sql', 'java', 'go', 'rs', 'c', 'cc', 'cpp', 'h', 'hpp', 'rb', 'php', 'lua', 'r', 'kt', 'swift', 'dockerfile', 'makefile']);
// 확장자가 없는 흔한 텍스트 파일 — '미지원'으로 떨어지지 않게.
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', 'changelog', 'agents.md', '.gitignore', '.env']);
function fileExtOf(name) {
    const s = String(name || '');
    const i = s.lastIndexOf('.');
    return i >= 0 ? s.slice(i + 1).toLowerCase() : '';
}
// CSV/TSV → 행렬. 따옴표 필드(구분자·개행·"" 이스케이프) 처리. 대용량 보호로 앞부분만.
function parseDelimited(text, delim) {
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQ) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                }
                else
                    inQ = false;
            }
            else
                field += c;
        }
        else if (c === '"')
            inQ = true;
        else if (c === delim) {
            row.push(field);
            field = '';
        }
        else if (c === '\n') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            if (rows.length > 3000)
                break;
        }
        else if (c !== '\r')
            field += c;
    }
    if (field !== '' || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}
function tablePreview(text, delim, cls) {
    const wrap = el('div', { class: 'fp-tablewrap' + (cls ? ' ' + cls : '') });
    const rows = parseDelimited(text, delim);
    if (!rows.length) {
        wrap.append(el('div', { class: 'fp-msg' }, '빈 파일이에요.'));
        return wrap;
    }
    const MAXR = 500, MAXC = 60;
    const head = rows[0].slice(0, MAXC);
    const table = el('table', { class: 'fp-table' });
    const htr = el('tr', {}, el('th', { class: 'fp-cn' }, '#'));
    for (const cell of head)
        htr.append(el('th', {}, cell));
    table.append(el('thead', {}, htr));
    const tbody = el('tbody');
    const body = rows.slice(1, 1 + MAXR);
    body.forEach((r, i) => {
        const tr = el('tr', {}, el('td', { class: 'fp-cn' }, String(i + 1)));
        for (let c = 0; c < head.length; c++)
            tr.append(el('td', { title: r[c] != null ? r[c] : '' }, r[c] != null ? r[c] : ''));
        tbody.append(tr);
    });
    table.append(tbody);
    wrap.append(table);
    const extra = (rows.length - 1) - body.length;
    if (extra > 0)
        wrap.append(el('div', { class: 'fp-tablemore' }, '… 그리고 ' + extra.toLocaleString() + '개 행 더 — 전체는 다운로드해 확인하세요.'));
    return wrap;
}
/**
 * html 렌더 — **sandbox iframe + srcdoc**.
 *  남이 올린 임의 html 을 같은 오리진에 심으면 그 안 <script> 가 세션 쿠키·localStorage 토큰을 가져간다(저장형 XSS).
 *   · `allow-same-origin` **미부여**가 핵심 — 문서가 불투명 오리진을 갖고 부모 DOM·쿠키·저장소에 손이 닿지 않는다.
 *   · `allow-scripts` 는 준다 — 스크립트로 그리는 보고서가 백지로 뜨면 '렌더해서 보여준다'가 성립하지 않는다.
 *     ⚠ 이 둘을 **함께** 주면 샌드박스가 스스로 풀린다. 절대 같이 주지 말 것.
 *   · `allow-top-navigation` 미부여 → 이 페이지를 피싱 사이트로 갈아치울 수 없다.
 *  한계: srcdoc 엔 base URL 이 없어 상대경로 이미지·외부 CSS 는 안 붙는다(자기완결 단일 html 이 대상).
 */
function htmlFrame(text, name, cls) {
    const frame = el('iframe', {
        class: 'fp-html' + (cls ? ' ' + cls : ''), title: name,
        sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals',
        referrerpolicy: 'no-referrer',
    });
    frame.srcdoc = text;
    return frame;
}
function codeBlock(text, ext, cls) {
    const pre = el('pre', { class: 'fp-code' + (PREVIEW_CODE.has(ext) ? ' is-code' : '') + (cls ? ' ' + cls : '') });
    pre.textContent = text;
    return pre;
}
/**
 * 파일 하나의 미리보기를 만든다 — 타입 판정·데이터 수신·본문 렌더·툴바 동작까지.
 *  실패(413·기타)는 예외가 아니라 **안내 노드**로 돌려준다 — 화면마다 다르게 처리할 일이 아니다.
 */
async function buildFilePreview(host) {
    const name = host.name;
    const ext = fileExtOf(name);
    const cls = host.cls || {};
    const msg = (t) => ({ body: el('div', { class: 'fp-msg' + (cls.msg ? ' ' + cls.msg : '') }, t), tools: [], wide: false });
    // 인라인 응답 수신 — 413(서버 미리보기 상한)과 그 외 실패를 구분해 안내한다.
    const readable = async (fetcher, what) => {
        let res;
        try {
            res = await fetcher();
        }
        catch (e) {
            return { fail: msg('파일을 불러오지 못했어요 — ' + ((e && e.message) || e)) };
        }
        if (res.ok)
            return res;
        return { fail: msg(res.status === 413
                ? what + '이(가) 커서 미리보기할 수 없어요 — 다운로드해 확인하세요.'
                : '미리보기를 불러오지 못했어요 (' + res.status + ')') };
    };
    const failed = (r) => !!r && !!r.fail;
    if (PREVIEW_IMG.includes(ext)) {
        const r = await readable(host.fetchView, '이미지');
        if (failed(r))
            return r.fail;
        const img = el('img', { class: 'fp-img' + (cls.img ? ' ' + cls.img : ''), alt: name });
        img.src = URL.createObjectURL(new Blob([await r.blob()], { type: IMG_MIME[ext] || 'application/octet-stream' }));
        return { body: img, tools: [], wide: false };
    }
    if (ext === 'pdf') {
        // blob 에 MIME 을 명시해야 iframe 이 **브라우저 내장 PDF 뷰어**를 띄운다 —
        //  안 주면 %PDF 원시바이트가 텍스트로 노출된다(두 화면이 각각 이 함정을 밟았던 자리).
        const r = await readable(host.fetchView, 'PDF');
        if (failed(r))
            return r.fail;
        const frame = el('iframe', { class: 'fp-pdf' + (cls.pdf ? ' ' + cls.pdf : ''), title: name });
        frame.src = URL.createObjectURL(new Blob([await r.blob()], { type: 'application/pdf' }))
            + (host.pdfHash || '#toolbar=1&view=FitH');
        return { body: frame, tools: [], wide: true };
    }
    if (PREVIEW_TABLE.has(ext)) {
        const r = await readable(host.fetchView, '파일');
        if (failed(r))
            return r.fail;
        return { body: tablePreview(await r.text(), ext === 'tsv' ? '\t' : ',', cls.table), tools: [], wide: true };
    }
    if (AUDIO_MIME[ext] || VIDEO_MIME[ext]) {
        // 미디어는 인라인 상한을 넘기 쉬워 원본으로 받고, 메모리 보호는 클라 상한으로.
        if (host.size && host.size > MEDIA_MAX)
            return msg('파일이 커서 미리보기 대신 다운로드해 확인하세요.');
        const r = await readable(host.fetchDownload, '파일');
        if (failed(r))
            return r.fail;
        const isVid = !!VIDEO_MIME[ext];
        const src = URL.createObjectURL(new Blob([await r.blob()], { type: isVid ? VIDEO_MIME[ext] : AUDIO_MIME[ext] }));
        const extra = isVid ? cls.video : cls.audio;
        return {
            body: el(isVid ? 'video' : 'audio', { class: (isVid ? 'fp-video' : 'fp-audio') + (extra ? ' ' + extra : ''), src, controls: 'true', preload: 'metadata', playsinline: 'true' }),
            tools: [], wide: isVid,
        };
    }
    const isMd = MD_EXTS.has(ext);
    const isHtml = HTML_EXTS.has(ext);
    const isText = PREVIEW_TEXT.includes(ext) || !ext || TEXT_NAMES.has(String(name).toLowerCase());
    if (!isMd && !isHtml && !isText) {
        return msg((ext ? '.' + ext + ' 은' : '이 파일은') + ' 미리보기를 지원하지 않아요 — 다운로드해 확인하세요.');
    }
    const r = await readable(host.fetchView, '파일');
    if (failed(r))
        return r.fail;
    let text = await r.text();
    if (ext === 'json') {
        try {
            text = JSON.stringify(JSON.parse(text), null, 2);
        }
        catch { /* 원문 유지 */ }
    }
    // ── md·html: 렌더가 기본, '원문'으로 토글. 텍스트·코드: 코드 표시가 기본, '편집'으로 토글. ──
    //  ⭐ save 가 있으면 **원문/편집 화면이 곧 textarea** 다 — 종전에 프로젝트 모달은 '편집' 토글,
    //   홈 모달은 '원문' 토글로 서로 다른 버튼을 뒀다. 둘은 같은 것이라 하나로 합쳤다(편집 가능하면 편집칸).
    const wrap = el('div', { class: 'fp-wrap' });
    const ta = host.save ? el('textarea', { class: 'fp-edit' + (cls.code ? ' ' + cls.code : '') }) : null;
    if (ta)
        ta.value = text;
    const rendered = () => (isMd
        ? el('article', { class: 'md-rendered fp-md' + (cls.md ? ' ' + cls.md : '') }, renderMarkdown(text))
        : isHtml
            ? htmlFrame(text, name, cls.html)
            : codeBlock(text, ext, cls.code));
    const rawNode = () => (ta || codeBlock(text, ext, cls.code));
    let raw = !isMd && !isHtml && !host.save ? false : false; // 기본은 항상 렌더/코드 표시
    const saveBtn = host.save ? host.mkBtn('저장', () => { }) : null;
    const paint = () => {
        wrap.replaceChildren(raw ? rawNode() : rendered());
        if (saveBtn)
            saveBtn.hidden = !raw; // 저장은 원문/편집 화면에서만
    };
    const tools = [];
    // 버튼 라벨: 렌더 형태가 있는 것(md·html)은 '원문', 없는 것(텍스트·코드)은 '편집' — 사용자가 보는 행동이 다르다.
    const onLabel = (isMd || isHtml) ? '</> 원문' : '✎ 편집';
    const offLabel = (isMd || isHtml) ? '👁 렌더 보기' : '✕ 편집 끝';
    if (isMd || isHtml || host.save) {
        const toggle = host.mkBtn(onLabel, () => {
            raw = !raw;
            toggle.textContent = raw ? offLabel : onLabel;
            paint();
        });
        tools.push(toggle);
    }
    if (saveBtn && host.save) {
        saveBtn.onclick = async () => {
            saveBtn.disabled = true;
            try {
                await host.save(ta.value);
                text = ta.value;
                host.onSaved && host.onSaved();
            }
            catch (e) {
                host.onError && host.onError((e && e.message) || String(e));
            }
            saveBtn.disabled = false;
        };
        tools.push(saveBtn);
    }
    paint();
    return { body: wrap, tools, wide: isMd || isHtml };
}
export { AUDIO_MIME, IMG_MIME, MEDIA_MAX, PREVIEW_CODE, PREVIEW_IMG, PREVIEW_TABLE, PREVIEW_TEXT, VIDEO_MIME, buildFilePreview, codeBlock, fileExtOf, htmlFrame, parseDelimited, tablePreview, };

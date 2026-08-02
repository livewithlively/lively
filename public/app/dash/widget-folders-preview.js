// dash/widget-folders-preview.ts — #1405 W2: widget-folders.ts 분할.
//  파일 미리보기 판정(확장자·MIME·크기 상한)과 표 미리보기 파서 + 가로 휠 보조.
//  순수 잎 — 폴더 위젯이 이쪽을 본다. 반대 방향은 없다(배럴도 안 문다).
import { TOKEN_KEY, el } from '../core.js';
// 가로 목록 위에서 세로 휠 → 가로 스크롤(#req). 마우스 휠은 deltaY 만 나오는데 가로 목록은 세로로 넘칠 게 없어
//  '호버해도 아무 일도 안 일어나던' 문제. 가로로 더 굴러갈 여지가 있을 때만 가로채고(preventDefault), 끝에 닿았거나
//  트랙패드 가로 제스처(|deltaX| 우세)면 그대로 흘려보내 페이지 세로 스크롤을 막지 않는다.
function wheelToHorizontal(elm) {
    elm.addEventListener('wheel', (e) => {
        if (!e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY))
            return;
        const max = elm.scrollWidth - elm.clientWidth;
        if (max <= 1)
            return; // 넘칠 게 없다 → 페이지 스크롤 그대로
        const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? elm.clientWidth : 1); // line/page 모드 휠 보정
        const next = Math.max(0, Math.min(max, elm.scrollLeft + e.deltaY * unit));
        if (Math.abs(next - elm.scrollLeft) < 0.5)
            return; // 이미 양 끝 → 세로 스크롤을 가로채지 않는다
        e.preventDefault();
        elm.scrollLeft = next;
    }, { passive: false });
}
// ── 파일 미리보기 헬퍼(#672 후속) — 인증 fetch + 타입별 확장자 집합. browse/file 은 Content-Type 미설정이라 blob 은 클라에서 재지정. ──
//  ⚠ 잠재 버그(#1313 R43 관측 — 이번 분해에서는 **고치지 않는다**): 여기만 api()/apiUrl() 을 안 거치고 fetch(url) 을
//   직접 부른다. 그래서 프리뷰 서브패스(/preview/<id>/, #1036·#1091)에서 뜬 화면의 미리보기 요청은 접두사를 못 받고
//   오리진 루트 = 라이브 게이트웨이로 샌다(같은 파일의 다른 호출은 전부 api() 경유라 프리뷰로 간다).
//   고치려면 apiUrl(url) 로 감싸면 되지만 그건 동작 변경이라 별도 과제로 남긴다.
function dashAuthFetch(url) { const t = localStorage.getItem(TOKEN_KEY); return fetch(url, { headers: t ? { Authorization: 'Bearer ' + t } : {} }); }
function dashFileExt(name) { const i = String(name || '').lastIndexOf('.'); return i >= 0 ? String(name).slice(i + 1).toLowerCase() : ''; }
const DASH_IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif' };
const DASH_PREVIEW_IMG = Object.keys(DASH_IMG_MIME);
// #req 음성·영상 미리보기(<audio>/<video>) — download=1 로 2MB 상한 우회, DASH_MEDIA_MAX 로 메모리 보호.
const DASH_AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', opus: 'audio/opus' };
const DASH_VIDEO_MIME = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg', mkv: 'video/x-matroska' };
const DASH_PREVIEW_TABLE = new Set(['csv', 'tsv']); // #req 표로 렌더
const DASH_MEDIA_MAX = 80 * 1024 * 1024;
const DASH_PREVIEW_TEXT = ['txt', 'md', 'markdown', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'zsh', 'html', 'htm', 'css', 'scss', 'sass', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml', 'sql', 'java', 'go', 'rs', 'c', 'cc', 'cpp', 'h', 'hpp', 'rb', 'php', 'lua', 'r', 'kt', 'swift', 'log', 'env', 'gitignore', 'dockerfile', 'makefile'];
const DASH_PREVIEW_CODE = new Set(['json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'zsh', 'html', 'htm', 'css', 'scss', 'sass', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml', 'sql', 'java', 'go', 'rs', 'c', 'cc', 'cpp', 'h', 'hpp', 'rb', 'php', 'lua', 'r', 'kt', 'swift', 'dockerfile', 'makefile']);
// CSV/TSV → 표. 따옴표로 감싼 필드(구분자·개행·"" 이스케이프) 처리. 앞부분만 렌더(행·열 상한)해 대용량 보호.
function dashParseDelimited(text, delim) {
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
function dashTablePreview(text, delim) {
    const wrap = el('div', { class: 'dash-fp-tablewrap' });
    const rows = dashParseDelimited(text, delim);
    if (!rows.length) {
        wrap.append(el('div', { class: 'dash-fp-msg' }, '빈 파일이에요.'));
        return wrap;
    }
    const MAXR = 500, MAXC = 60;
    const head = rows[0].slice(0, MAXC);
    const table = el('table', { class: 'dash-fp-table' });
    const htr = el('tr', {}, el('th', { class: 'dash-fp-cn' }, '#'));
    for (const cell of head)
        htr.append(el('th', {}, cell));
    table.append(el('thead', {}, htr));
    const tbody = el('tbody');
    const body = rows.slice(1, 1 + MAXR);
    body.forEach((r, i) => {
        const tr = el('tr', {}, el('td', { class: 'dash-fp-cn' }, String(i + 1)));
        for (let c = 0; c < head.length; c++)
            tr.append(el('td', { title: r[c] != null ? r[c] : '' }, r[c] != null ? r[c] : ''));
        tbody.append(tr);
    });
    table.append(tbody);
    wrap.append(table);
    const extra = (rows.length - 1) - body.length;
    if (extra > 0)
        wrap.append(el('div', { class: 'dash-fp-tablemore' }, '… 그리고 ' + extra.toLocaleString() + '개 행 더 — 전체는 다운로드해 확인하세요.'));
    return wrap;
}
export { DASH_AUDIO_MIME, DASH_IMG_MIME, DASH_MEDIA_MAX, DASH_PREVIEW_CODE, DASH_PREVIEW_IMG, DASH_PREVIEW_TABLE, DASH_PREVIEW_TEXT, DASH_VIDEO_MIME, dashAuthFetch, dashFileExt, dashParseDelimited, dashTablePreview, wheelToHorizontal };

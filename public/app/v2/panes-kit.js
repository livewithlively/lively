// v2/panes-kit.ts — 곁칸 부품들이 함께 쓰는 **잎 도구**(#1819 분할). 의존은 core 한 방향뿐이라 순환이 없다.
//  여기 사는 것: 아이콘 · 인증 헤더 · 파일 종류 판정(미리보기 방식) · 이름 겹침 회피 · 그 자리 우클릭 메뉴.
//  부품 자신(세션·자료·지식…)은 panes-parts.ts / panes-files.ts 에 산다.
import { TOKEN_KEY, el, sv } from '../core.js';
// ── 아이콘(스트로크 SVG) ──────────────────────────────────────────────────────
const ICON_PATHS = {
    chat: '<path d="M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    task: '<path d="M4 6h12M4 12h12M4 18h8"/><path d="M19 5l2 2-4 4"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    note: '<path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5"/>',
    img: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>',
    send: '<path d="M4 12l16-8-6 16-2-7z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    rows: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2L5.6 5.6"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    cols: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M15 5v14"/>',
    drop: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 19h14"/>',
    box: '<path d="M3 7h18v4H3z"/><path d="M5 11v8h14v-8"/><path d="M10 15h4"/>',
    undo: '<path d="M4 9h11a5 5 0 0 1 0 10h-6"/><path d="M8 5L4 9l4 4"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/>',
    pencil: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M14 6l4 4"/>',
    eye: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/>',
    save: '<path d="M5 4h11l3 3v13H5z"/><path d="M9 4v5h6V4"/><path d="M8 20v-6h8v6"/>',
    ext: '<path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};
export function pnIcon(name, cls = 'pn-i') {
    const s = sv('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' });
    s.innerHTML = ICON_PATHS[name] || ICON_PATHS.doc;
    return s;
}
export const authHeaders = () => {
    const t = (() => { try {
        return localStorage.getItem(TOKEN_KEY) || '';
    }
    catch (_) {
        return '';
    } })();
    return t ? { authorization: 'Bearer ' + t } : {};
};
export const MACHINE_FILES = new Set(['CLAUDE.md', 'AGENTS.md', '.DS_Store', 'package-lock.json', 'yarn.lock']);
export const NOISE_RE = /\/(__pycache__|node_modules|dist|build|\.next|coverage|venv)\//;
export const TRASH_DIR = '휴지통';
const isImg = (n) => /\.(png|jpe?g|gif|webp|svg)$/i.test(n);
// 아이콘이 아니라 **내용이 보이게**(원준 2026-08-20) — kind 가 미리보기 방식을 정한다.
//  img=그대로 · pdf/page=축소해 실제로 렌더 · text=앞부분을 글자로 · video=첫 프레임 · file=아이콘(렌더할 방법이 없는 것들).
const TEXTY = /\.(md|markdown|txt|log|csv|tsv|json|jsonl|ya?ml|toml|ini|conf|env|sql|sh|bash|zsh|ps1|py|rb|go|rs|java|kt|swift|c|h|cpp|cc|hpp|cs|php|pl|lua|r|ts|tsx|js|jsx|mjs|cjs|css|scss|less|xml|svg|gitignore|dockerfile|makefile)$/i;
export function kindOf(p) {
    if (isImg(p))
        return { kind: 'img', type: '그림' };
    if (/\.pdf$/i.test(p))
        return { kind: 'pdf', type: 'PDF' };
    if (/\.html?$/i.test(p))
        return { kind: 'page', type: '시안' };
    if (/\.(mp4|webm|mov|m4v)$/i.test(p))
        return { kind: 'video', type: '영상' };
    if (/\.(md|markdown|txt)$/i.test(p))
        return { kind: 'text', type: '문서' };
    if (/\.(csv|tsv)$/i.test(p))
        return { kind: 'text', type: '표' };
    if (/\.xlsx?$/i.test(p))
        return { kind: 'file', type: '표' };
    if (/\.(pptx?|key)$/i.test(p))
        return { kind: 'file', type: '장표' };
    if (/\.docx?$|\.hwpx?$/i.test(p))
        return { kind: 'file', type: '문서' };
    if (/\.(zip|tar|gz|7z|rar)$/i.test(p))
        return { kind: 'file', type: '묶음' };
    if (TEXTY.test(p))
        return { kind: 'text', type: '코드' };
    return { kind: 'file', type: '파일' };
}
// 미리보기는 **작은 종이 한 장**(300×246)을 만들어 카드 크기에 맞춰 줄인다 — 글자·표가 뭉개지지 않고 비율이 산다.
export const PV_W = 300; // 종이 폭(높이는 CSS 가 카드 비율로 잡는다)
export const PV_MAX = { pdf: 12e6, page: 4e6, text: 512e3, img: 24e6, video: 80e6 };
// ── 보기 설정(맥 파인더 문법) — 브라우저에 기억한다. 칸마다 따로 두지 않는다(한 사람의 한 습관이다). ──
export const FV_VIEW = 'lively_pn_files_view'; // 'icon' | 'list'
export const FV_SIZE = 'lively_pn_files_iconsz'; // 아이콘 한 변(px) — 파인더의 크기 슬라이더
export const FV_SORT = 'lively_pn_files_sort'; // '<key>:<asc|desc>'
export const FV_NOTE = 'lively_pn_files_note'; // '0' = 맨 위 안내를 접어 둠
export const ICON_STEPS = [64, 84, 110, 148, 196];
export const SORT_LABEL = { name: '이름', kind: '종류', size: '크기', date: '날짜' };
export const lsGet = (k, d) => { try {
    return localStorage.getItem(k) ?? d;
}
catch {
    return d;
} };
export const lsSet = (k, v) => { try {
    localStorage.setItem(k, v);
}
catch { /* 사파리 사생활 모드 등 — 기억만 못 할 뿐 */ } };
/** 붙여넣기·새 폴더가 쓰는 이름 — 같은 폴더에 이미 있으면 '이름 2' 로 번호를 올린다(파인더와 같은 규칙). */
export function freeName(taken, name) {
    if (!taken.has(name))
        return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 2; i < 500; i++) {
        const c = `${stem} ${i}${ext}`;
        if (!taken.has(c))
            return c;
    }
    return `${stem} ${Date.now()}${ext}`;
}
export const stamp = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
/** 그 자리에 뜨는 작은 메뉴(우클릭). 밖을 누르거나 Esc 면 닫힌다. */
export function ctxMenu(x, y, rows) {
    document.querySelector('.pn-ctx')?.remove();
    const menu = el('div', { class: 'pn-ctx', role: 'menu' });
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc, true); };
    const away = (e) => { if (!menu.contains(e.target))
        close(); };
    const esc = (e) => { if (e.key === 'Escape') {
        e.stopPropagation();
        close();
    } };
    for (const r of rows) {
        if (r.sep) {
            menu.append(el('div', { class: 'pn-ctx-sep' }));
            continue;
        }
        const b = el('button', { class: 'pn-ctx-i' + (r.danger ? ' danger' : ''), type: 'button', text: r.label });
        if (r.off)
            b.disabled = true;
        else
            b.onclick = () => { close(); r.run?.(); };
        menu.append(b);
    }
    document.body.append(menu);
    // 화면 밖으로 나가지 않게 — 오른쪽·아래 끝에서 뒤집는다(좁은 곁칸에서 우클릭하면 늘 걸린다).
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
}
/** 붙여넣은 파일에 사람이 알아볼 이름을 준다 — 브라우저가 주는 'image.png' 는 누구의 것인지 말해 주지 않는다.
 *  ⚠ 확장자는 **이름을 갈아끼울 때만** MIME 에서 만든다. 원래 이름의 확장자 유무로 판단하면 'image.png' 처럼
 *   확장자는 있는데 이름을 버리는 경우에 확장자까지 같이 사라진다(실측: '붙여넣은 그림 20260820-194421' 로
 *   저장돼 그림으로 인식되지 않아 미리보기가 안 떴다). */
export function attachName(f, taken) {
    const raw = String(f.name || '').split(/[/\\]/).pop() || '';
    const keep = !!raw && raw !== 'image.png' && raw !== 'blob';
    if (keep)
        return freeName(new Set(taken), raw);
    const sub = (f.type || '').split('/')[1] || 'png';
    const ext = (sub.split('+')[0].replace(/[^a-z0-9]/gi, '') || 'png').toLowerCase(); // image/svg+xml → svg
    return freeName(new Set(taken), `붙여넣은 그림 ${stamp()}.${ext}`);
}
// ── 칸 머리의 안내 한 줄 (#1819) ─────────────────────────────────────────────
//  칸이 "무엇을 담는 곳인지"가 아니라 **그래서 나에게 무슨 이득인지**를 말한다. 자료·지식처럼 계약이
//  눈에 안 보이는 칸은 이걸 모르면 덜 쓰게 된다(자료를 '이 세션 첨부'로 오해해 딱 한 개만 올리는 식).
//  접으면 그 선택을 기억한다 — 한 번 읽은 사람에게 같은 문장을 계속 보일 이유는 없다.
export function pnNote(key, text) {
    const note = el('div', { class: 'pn-fnote' }, pnIcon('spark', 'pn-i sm'), el('p', { text }), el('button', {
        class: 'pn-fnote-x', type: 'button', title: '안내 접기', 'aria-label': '안내 접기', text: '✕',
        onclick: () => { lsSet(key, '0'); note.hidden = true; },
    }));
    note.hidden = lsGet(key, '1') === '0';
    return note;
}
// ── 지식 제목을 사람이 한눈에 읽는 한 줄로 (#1819) ───────────────────────────
//  위키 제목은 「짧은 이름 — 긴 설명」 규약을 따른다(실측: 표본 18건 중 15건이 ' — ' 를 가졌고 앞머리는
//  11~44자). 곁칸은 폭이 300px 남짓이라 전문을 그대로 걸면 슬러그처럼 읽히는 글자 덩어리가 된다.
//  그래서 **앞머리만** 남기고 이슈번호 같은 기계용 표식을 턴다. 전문은 title 속성과 상세 창이 갖는다.
//  ⚠ 저장된 제목을 바꾸지 않는다 — 화면에서만 줄인다(위키·검색·외부 미러의 정본은 그대로여야 한다).
export function knTitle(raw, name) {
    let t = String(raw || '').trim();
    if (!t)
        t = String(name || '').replace(/[-_]+/g, ' '); // 제목이 없으면 슬러그를 말처럼 편다
    t = t.split(/\s+[—–]\s+/)[0]; // 「이름 — 설명」의 이름만
    t = t.replace(/\(?#\d+[^)]*\)?/g, ' '); // (#1819) · #1819 같은 표식은 사람에게 뜻이 없다
    t = t.replace(/^(as-built|as built)\s*[::]\s*/i, ''); // 문서 종류 접두어는 아래 배지가 말한다
    t = t.replace(/\s{2,}/g, ' ').replace(/[\s·,:;]+$/, '').trim();
    return t || String(name || '');
}

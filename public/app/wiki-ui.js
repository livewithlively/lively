// wiki-ui.ts — #764 WIKI 공유 프리미티브(행·틱·섹션·데크·날짜 그룹). 표면(홈/카테고리/문서)이 공유하는 최하층.
//  순환 import 금지: core/wiki-data 만 import 한다(wiki-doc/wiki-category/wiki-home/wiki.ts ← wiki-ui).
//
//  목록 문법(디자인 헌법):
//  · 칩 더미 금지 — 메타는 "그 목록에서 값이 변하는 필드만", 우측 mono 한 줄.
//  · 민트 틱 = 사람 저작 표식(시그니처). AI 는 무표식(다수라 반복=제로 정보), 외부 미러는 회색 링.
//    10px 고정폭 영역이라 표식 유무와 무관하게 제목이 정렬된다.
import { el, relTime } from './core.js';
import { KN_TYPE_LABEL, isCategoryHomeDoc } from './wiki-data.js';
// ── 민트 틱 ──
function wkTick(e) {
    const human = e && e.confidence === 'human';
    const mirror = e && e.provenance === 'observed';
    return el('span', {
        class: 'wk-tick' + (human ? ' human' : mirror ? ' mirror' : ''),
        'aria-hidden': human || mirror ? 'false' : 'true',
        ...(human ? { title: '사람이 직접 작성' } : mirror ? { title: '외부 시스템 미러' } : {}),
    });
}
// ── 최근 열람(이어서) — 기기 로컬. 문서 페이지 진입 시 기록(wiki-doc), 홈 '이어서'가 소비(wiki-home). ──
const WK_VISITS_KEY = 'wk_visits_v1';
function wkRecordVisit(e) {
    try {
        if (!e || !e.name || isCategoryHomeDoc(e.name))
            return;
        const cur = JSON.parse(localStorage.getItem(WK_VISITS_KEY) || '[]');
        const rest = (Array.isArray(cur) ? cur : []).filter((v) => v && v.name !== e.name);
        rest.unshift({ name: e.name, title: e.title || e.name, icon: (e.props_ui && e.props_ui.icon) || null, ts: Date.now() });
        localStorage.setItem(WK_VISITS_KEY, JSON.stringify(rest.slice(0, 12)));
    }
    catch (_) { /* 프라이빗 모드 등 — 기록 생략 */ }
}
function wkReadVisits() {
    try {
        const v = JSON.parse(localStorage.getItem(WK_VISITS_KEY) || '[]');
        return Array.isArray(v) ? v : [];
    }
    catch (_) {
        return [];
    }
}
// '이어서' 필 줄 — 홈·내 소유 대시보드 공용(#1685). 방문 기록이 없으면 null(빈 줄을 차지하지 않는다).
function wkResumeRow(cap = 3) {
    const visits = wkReadVisits().slice(0, cap);
    if (!visits.length)
        return null;
    const row = el('div', { class: 'wk-resume' }, el('span', { class: 'wk-resume-label', text: '이어서' }));
    for (const v of visits) {
        row.append(el('a', { class: 'wk-resume-it', href: '#/k/' + encodeURIComponent(v.name), title: v.title }, v.icon ? el('span', { class: 'wk-resume-ic', 'aria-hidden': 'true', text: v.icon }) : null, el('span', { text: v.title })));
    }
    return row;
}
// ── 읽음 추적(기기 로컬) — 대문 '읽기 코스' 진행률의 근거. 문서를 열면(피크·페이지) 읽음 처리. ──
const WK_READ_KEY = 'wk_read_v1';
function wkReadNames() {
    try {
        const v = JSON.parse(localStorage.getItem(WK_READ_KEY) || '[]');
        return new Set(Array.isArray(v) ? v : []);
    }
    catch (_) {
        return new Set();
    }
}
function wkMarkRead(name) {
    try {
        if (!name || isCategoryHomeDoc(name))
            return;
        const s = wkReadNames();
        if (s.has(name))
            return;
        s.add(name);
        localStorage.setItem(WK_READ_KEY, JSON.stringify(Array.from(s).slice(-800)));
    }
    catch (_) { /* 프라이빗 모드 등 — 추적 생략 */ }
}
function wkIsRead(name) { return wkReadNames().has(name); }
// ── 해시 — 시드 문자열의 결정적 정수(오로라 레시피 선택 등). ──
function wkHash(s) {
    let h = 0;
    for (let i = 0; i < String(s).length; i++)
        h = ((h * 31) + String(s).charCodeAt(i)) | 0;
    return Math.abs(h);
}
// ── 오로라 커버 — 공간(space) 색 계열의 결정적 제너레이티브 커버(#764v2 시그니처). ──
//  사진 업로드 없이 모든 카테고리/카드가 고유한 시각 정체성을 갖는다: 시드(key) 해시 → 공간별 3레시피 중
//  하나 + 오버사이즈 워터마크(아이콘/첫 글자, 잉크 6~8% — 타이포그래피 장식, 이미지 아님).
//  사업=앰버, 제품=블루·민트, 시스템=바이올렛 — 사이드바 space 아바타와 같은 의미색(구조=정보).
function wkAurora(seed, space, opts = {}) {
    const sp = (space === 'business' || space === 'system') ? space : 'product';
    const n = (wkHash(seed) % 3) + 1;
    const cover = el('div', { class: 'wk-aurora wk-aur-' + sp + '-' + n + (opts.cls ? ' ' + opts.cls : ''), 'aria-hidden': 'true' });
    if (opts.watermark)
        cover.append(el('span', { class: 'wk-aurora-wm', text: String(opts.watermark) }));
    return cover;
}
// ── 문서 카드 — 데크(본문 첫 문단 발췌)로 클릭 전에 내용이 읽히는 카드. 홈 핀/최근·카테고리 시작점 공용. ──
//  opts: { open(e, el), deckCap, metas?: 추가 메타 노드, cls }
function wkDocCard(e, opts = {}) {
    const deck = wkDeck(e.body_md || '', opts.deckCap || 120);
    const card = el('div', { class: 'wk-doccard' + (opts.cls ? ' ' + opts.cls : ''), role: 'link', tabindex: '0', 'data-author': e.confidence || '' }, el('div', { class: 'wk-doccard-top' }, wkTick(e), e.icon ? el('span', { class: 'wk-doccard-ic', 'aria-hidden': 'true', text: e.icon }) : null, el('span', { class: 'wk-doccard-title', text: e.title || e.name })), deck ? el('p', { class: 'wk-doccard-deck', text: deck }) : null, el('div', { class: 'wk-doccard-meta' }, ...([
        e.is_wiki ? el('span', { class: 'wk-row-m', text: '인덱스' }) : null,
        e.type ? el('span', { class: 'wk-row-m', text: KN_TYPE_LABEL[e.type] || e.type }) : null,
        ...(opts.metas || []),
        e.updated_at ? el('span', { class: 'wk-row-m', text: relTime(e.updated_at) }) : null,
    ].filter(Boolean))));
    const go = () => { if (opts.open)
        opts.open(e, card);
    else
        location.hash = '#/k/' + encodeURIComponent(e.name); };
    card.addEventListener('click', go);
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter')
        go(); });
    return card;
}
// ── 목록 행 — [틱][아이콘?][제목(1줄)] ────────── [mono 메타]. ──
//  opts: { open(e, rowEl)  클릭(미전달 = #/k 이동)
//          metas: (string|Node|null)[]  우측 메타(호출자가 '변하는 값만' 규칙으로 구성. 미전달 = 유형·시간)
//          deck?: string  제목 아래 발췌 한 줄(카테고리 문서 목록 — 목록을 피드처럼 읽히게)
//          select?: { names:Set, onToggle }  선택 모드(행 클릭=토글) }
function wkRow(e, opts = {}) {
    const ic = e.icon || (e.is_folder ? '📁' : '');
    const metas = (opts.metas || [
        e.is_wiki ? '인덱스' : null,
        e.type ? (KN_TYPE_LABEL[e.type] || e.type) : null,
        e.updated_at ? relTime(e.updated_at) : null,
    ]).filter((x) => x != null && x !== '');
    const metaEl = el('span', { class: 'wk-row-meta' }, ...metas.map((m) => (m && m.nodeType) ? m : el('span', { class: 'wk-row-m', text: String(m) })));
    // 발췌 줄 — opts.deck(본문 발췌) 또는 검색(grep) 매치 스니펫(L<n>: 등 기계 표기는 정리).
    const snip = opts.deck || (e.snippet
        ? String(e.snippet).replace(/\(\+\d+ matches\)[^\n]*/g, '').replace(/L\d+:\s*/g, '')
            .replace(/[\n⋯]+/g, ' · ').replace(/\s+/g, ' ').trim().slice(0, 180)
        : '');
    const row = el('div', {
        class: 'wk-row' + (e.is_folder ? ' folder' : '') + (e.lifecycle === 'archived' ? ' archived' : '') + (snip ? ' has-snip' : ''),
        role: 'link', tabindex: '0',
        'data-author': e.confidence || '', 'data-prov': e.provenance || '',
    }, wkTick(e), ic ? el('span', { class: 'wk-row-ic', 'aria-hidden': 'true', text: ic }) : null, el('span', { class: 'wk-row-main' }, el('span', { class: 'wk-row-title', text: e.title || e.name }), snip ? el('span', { class: 'wk-row-snip', text: snip }) : null), metaEl);
    if (opts.select) {
        const on0 = opts.select.names.has(e.name);
        row.classList.add('pick');
        row.classList.toggle('sel', on0);
        row.setAttribute('role', 'button');
        row.setAttribute('aria-pressed', String(on0));
        const toggle = () => {
            const on = !opts.select.names.has(e.name);
            if (on)
                opts.select.names.add(e.name);
            else
                opts.select.names.delete(e.name);
            row.classList.toggle('sel', on);
            row.setAttribute('aria-pressed', String(on));
            opts.select.onToggle();
        };
        row.addEventListener('click', toggle);
        row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            toggle();
        } });
        return row;
    }
    const go = () => { if (opts.open)
        opts.open(e, row);
    else
        location.hash = '#/k/' + encodeURIComponent(e.name); };
    row.addEventListener('click', go);
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter')
        go(); });
    return row;
}
// ── 섹션 — 아이브로우 헤더(+카운트·액션) + 본문. 빈 섹션은 나열하지 않는다(호출자 책임). ──
function wkSection(title, opts = {}) {
    const head = el('div', { class: 'wk-sec-head' }, el('span', { class: 'wk-sec-title', text: title }), opts.count != null ? el('span', { class: 'wk-sec-count', text: String(opts.count) }) : null, opts.hint ? el('span', { class: 'wk-sec-hint', text: opts.hint }) : null, el('span', { class: 'wk-sec-sp' }), ...(opts.actions || []).filter(Boolean));
    const body = el('div', { class: 'wk-sec-body' });
    const box = el('section', { class: 'wk-sec' + (opts.cls ? ' ' + opts.cls : '') }, head, body);
    return { el: box, body, head };
}
// ── 데크 — body_md 첫 문단의 평문 발췌(추가 API 0 — 목록 응답의 body_md 재활용). ──
//  방언 컨테이너(:::)·헤딩·코드펜스·표·이미지 줄은 건너뛰고 첫 산문 문단을 찾는다.
function wkDeck(md, cap = 150) {
    const lines = String(md || '').split('\n');
    let buf = [];
    let inFence = false, inContainer = 0;
    for (const raw of lines) {
        const line = raw.trim();
        if (/^```|^~~~/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence)
            continue;
        if (/^:::\s*$/.test(line)) {
            if (inContainer > 0)
                inContainer--;
            continue;
        }
        if (/^:::/.test(line)) {
            inContainer++;
            continue;
        }
        if (inContainer > 0)
            continue;
        if (!line) {
            if (buf.length)
                break;
            continue;
        }
        if (/^#{1,6}\s/.test(line) || /^[-*+]\s|^\d+[.)]\s|^>\s?|^\||^!\[|^---+$|^\$\$/.test(line)) {
            if (buf.length)
                break;
            continue;
        }
        buf.push(line);
        if (buf.join(' ').length > cap + 60)
            break;
    }
    const txt = buf.join(' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_~`=+]{1,3}([^*_~`=+]+)[*_~`=+]{1,3}/g, '$1')
        .replace(/\\([\\`*_[\]])/g, '$1')
        .replace(/\u200B/g, '')
        .replace(/\s+/g, ' ').trim();
    return txt.length > cap ? txt.slice(0, cap - 1).trimEnd() + '…' : txt;
}
// ── 날짜 그룹 라벨 — 오늘 / 어제 / M월 D일 (요일). 최근 변경 목록의 그룹 헤더. ──
const WK_DOW = ['일', '월', '화', '수', '목', '금', '토'];
function wkDayLabel(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime()))
        return '';
    const now = new Date();
    const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day0(now) - day0(d)) / 86400000);
    if (diff <= 0)
        return '오늘';
    if (diff === 1)
        return '어제';
    const y = d.getFullYear() !== now.getFullYear() ? (d.getFullYear() + '년 ') : '';
    return y + (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + WK_DOW[d.getDay()] + ')';
}
// ── 빈 상태 — 무드가 아니라 다음 행동 안내. ──
function wkEmpty(text, action) {
    return el('div', { class: 'wk-empty' }, el('span', { text }), action || null);
}
export { wkAurora, wkDayLabel, wkDeck, wkDocCard, wkEmpty, wkHash, wkIsRead, wkMarkRead, wkReadVisits, wkRecordVisit, wkResumeRow, wkRow, wkSection, wkTick };

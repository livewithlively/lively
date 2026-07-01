// core.ts — split from app.js (ESM, behavior-preserving). DO NOT add logic; moved verbatim.
// Lively Context 웹 UI — 프레임워크 없는 해시 라우팅 SPA-lite.
// 보안 규칙: 모든 데이터 텍스트는 textContent/createElement 만 사용(innerHTML 에 데이터 주입 금지 —
// discord/notion 본문 XSS 방어). 토큰은 localStorage 에만, 절대 로그/URL 에 싣지 않는다.
//
// IA(2026-06-24): 지식을 두 직교축 injection(always 항상주입 / recalled 검색소환) × provenance(authored 저작 / observed 외부미러)
//  으로 분류해 비개발자가 조회·편집·핀. 주요 화면:
//   · 지식(#/knowledge/<space>) — 사업·제품·시스템 + 📌 인덱스(핀 전용 뷰) + 통계·검토. 좌 카테고리 사이드바 + 검색/필터 목록.
//   · 지식 상세(#/k/<name>)      — 전문(markdown) + 메타 + 연결 카테고리 + 편집·핀·삭제. (생성=목록 '+ 추가')
//   · 프로젝트(#/projects2) · 도메인 맵(#/domainmap) · 관리(#/system) · 가이드(#/learn) · 휴지통(#/trash) · 터미널(#/terminal).
'use strict';
const TOKEN_KEY = 'lively_ui_token';
const SVG_NS = 'http://www.w3.org/2000/svg';
// 출처(provenance) 라벨 — ai=AI 에이전트 생성, human=사람 저작/승인, rule=시스템 결정론 파생, observed=외부 시스템 미러(커넥터 원천).
//  V4-C: 'confidence' 컬럼/enum 은 물리적으로 불변 — UI 라벨만 '출처(provenance)'로 의미를 명확히 한다(출처는 채널이
//  기계로 박는 사실이지 신뢰도·가치가 아니다). observed 는 외부 *살아있는 미러* — 진실·편집은 외부에 있다.
const CONFIDENCE_LABEL = { ai: 'AI', human: '사람', rule: '규칙', observed: '외부 미러' };
// 수정이력(작성자/리비전) 라벨 — actor_kind=누가(사람/AI/커넥터/시스템), channel=어떤 경로(에이전트/웹/커넥터싱크/이관).
const ACTOR_KIND_LABEL = { human: '사람', ai: 'AI', connector: '커넥터', system: '시스템', unknown: '미상' };
const CHANNEL_LABEL = { mcp: '에이전트(MCP)', web: '웹', connector: '커넥터싱크', cli: 'CLI', migration: '이관', unknown: '경로 미상' };
// 리비전 op(작업) 라벨 — 본문 수정(insert/update)과 상태변경(set_lifecycle)/삭제(delete) 구분.
const REV_OP_LABEL = { insert: '생성', update: '수정', set_lifecycle: '상태 변경', delete: '삭제' };
// 정렬 옵션(탐색·검토 공용) — 백엔드 orderBy 화이트리스트(updated_at|name|sort)와 1:1.
const SORT_OPTS = [['updated_at', '최신순'], ['name', '이름순'], ['sort', '수동 정렬순']];
// lifecycle(상태) 라벨 — active=유효, rejected=반려, superseded=대체됨.
const LIFECYCLE_LABEL = { active: '유효', rejected: '반려', superseded: '대체됨' };
// 작업(activity) 유형 라벨 — 백엔드 activity.type(성격, 프로젝트 #182)과 1:1. 작업 현황 대시보드 유형분포 표시용.
//  type = "이 작업이 무엇인가". 커밋은 유형이 아니라 commit_sha 존재로 표현(어떤 유형이든 커밋 동반 가능).
const ACTIVITY_TYPE_LABEL = { feature: '기능', fix: '수정', decision: '결정', docs: '문서', research: '리서치', review: '검토', chore: '운영', other: '기타' };
const ACTIVITY_TYPE_ORDER = ['feature', 'fix', 'decision', 'docs', 'research', 'review', 'chore', 'other'];
// 작업↔지식 연결 관계 라벨(activity_knowledge.relation) — produced=산출, references=참조, decided=결정 근거.
const REF_REL_LABEL = { produced: '산출', references: '참조', decided: '결정' };
// should/is 점검 결과 라벨(activity.should_review/is_review) — 도메인 의도(should)·코드구조(is) 점검 3-state.
const REVIEW_LABEL = { na: '해당 없음', checked_no_change: '점검함(변화 없음)', changed: '변경됨' };
const state = {
    me: null,
    knowledge: { space: 'business', category: '', injection: '', provenance: '', q: '' }, // 지식 탭(#/knowledge) 필터 상태(2분할 뷰)
    reviewOrderBy: 'updated_at', // 검토 피드 정렬(기본 최신순)
    admin: { data: null, sel: null, memberSel: null, memberEditing: false, memberAddPreselect: null, memorySel: null, repoSel: null, navCollapsed: false }, // 관리(전달) 페이지 상태
    start: { mode: 'web', os: 'mac', token: null }, // '시작하기 > 설치' 온보딩 상태(쓰는곳 web|local + 선택 OS + 자가발급 토큰 1회 캐시)
    domains: {}, // P-V3-4a: repo별 도메인 통제어휘 캐시 { [repo]: {list, repos, loaded, error} }
    allDomains: null, // V5 탈-repo: 전 repo + business 통합 통제어휘 캐시(저장/필터 드롭다운) {list, loaded, error}
};
// V5 탈-repo: 도메인 귀속은 repo-비의존(business=조직평면). 저장/필터 드롭다운은 통합 목록(loadAllDomains)을
//  쓰고, 어휘CRUD 화면만 repo별 product 도메인(loadDomains)을 유지한다(코드앵커·debt 가 repo 스코프).
const VOCAB_CRUD_DEFAULT_REPO = 'productivity'; // 어휘관리 화면 repo 셀렉터 폴백 기본(product 도메인 CRUD 전용)
let revealUsed = false; // 입장 리빌은 첫 부팅 렌더 1회만(§6)
let uid = 0; // datalist 등 고유 id 카운터
// ── DOM 헬퍼 ──
// 불리언 HTML 속성 — 존재만으로 참이라 setAttribute(k, false) 로는 끌 수 없다(값 'false' 여도 켜진 상태).
//  el 에서 이들만 특수처리: 불리언 false → 미설정(끔), 그 외(true·'' 등) → 빈 속성으로 존재(켬).
const EL_BOOL_ATTRS = new Set(['disabled', 'hidden', 'checked', 'selected', 'readonly', 'required', 'multiple', 'open', 'autofocus']);
function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null)
                continue;
            if (k === 'class')
                n.className = v;
            else if (k === 'text')
                n.textContent = v;
            else if (k.startsWith('on'))
                n.addEventListener(k.slice(2), v);
            else if (EL_BOOL_ATTRS.has(k)) {
                if (v !== false)
                    n.setAttribute(k, '');
            } // false 만 끔('' / true 는 켬)
            else
                n.setAttribute(k, v);
        }
    }
    for (const c of children.flat(Infinity)) {
        if (c == null)
            continue;
        n.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
}
function sv(name, attrs, ...children) {
    const n = document.createElementNS(SVG_NS, name);
    if (attrs)
        for (const [k, v] of Object.entries(attrs)) {
            if (v != null)
                n.setAttribute(k, v);
        }
    for (const c of children.flat(Infinity)) {
        if (c != null)
            n.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
}
const $view = () => document.getElementById('view');
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function applyReveal(nodes) {
    if (revealUsed || reducedMotion()) {
        revealUsed = true;
        return;
    }
    nodes.forEach((n, i) => { n.classList.add('reveal'); n.style.animationDelay = (i * 70) + 'ms'; });
    revealUsed = true;
}
// ── 안전 마크다운 렌더러 ──
// 비개발자 친화: body_md(raw 마크다운)을 실제 서식으로 보여준다. 의존성 0 — 작은 서브셋을
// 직접 파싱한다. 보안 불변식(P4b): **모든 텍스트는 textContent/createTextNode 만** 거치고
// DOM 은 createElement(el 헬퍼)로만 구성한다 — innerHTML 류 절대 미사용이라 HTML 주입 불가능.
// 파싱 못 하는 줄/토큰은 평문 텍스트로 안전 폴백(raw HTML 노출·렌더 깨짐 없음).
// 링크 href 안전 스킴만 허용(javascript:/data:/vbscript: 등은 거부 → 링크 대신 평문 표시).
// 상대경로·앵커(#)·프로토콜상대(//)·http/https/mailto 만 통과.
function safeHref(raw) {
    const url = String(raw).trim();
    if (!url)
        return null;
    // 앵커/상대경로/프로토콜상대는 안전.
    if (url.startsWith('#') || url.startsWith('/') || url.startsWith('./') || url.startsWith('../'))
        return url;
    if (url.startsWith('//'))
        return url;
    // 스킴이 있으면 화이트리스트만. 스킴 추출 전 제어문자(개행/탭) 제거 — `java\nscript:` 우회 차단.
    const stripped = url.replace(/[\x00-\x1f\x7f]/g, '');
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped);
    if (m) {
        const scheme = m[1].toLowerCase();
        if (scheme === 'http' || scheme === 'https' || scheme === 'mailto')
            return url;
        return null; // 알 수 없거나 위험한 스킴 → 거부
    }
    // 스킴 없는 일반 토큰(예: example.com) — 상대 취급(절대 스크립트 실행 불가).
    return url;
}
// 인라인 파싱 → 텍스트 노드/엘리먼트 배열. 코드(`)·굵게(**)·기울임(*)·링크([..](..)) 지원.
// 모든 미매칭 문자는 텍스트 노드로 누적되어 createTextNode 로만 들어간다.
function renderInline(text) {
    const out = [];
    let buf = '';
    const flush = () => { if (buf) {
        out.push(document.createTextNode(buf));
        buf = '';
    } };
    const s = text;
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        // 인라인 코드 `...`
        if (ch === '`') {
            const end = s.indexOf('`', i + 1);
            if (end > i) {
                flush();
                out.push(el('code', { class: 'md-code', text: s.slice(i + 1, end) }));
                i = end + 1;
                continue;
            }
        }
        // 굵게 **...**
        if (ch === '*' && s[i + 1] === '*') {
            const end = s.indexOf('**', i + 2);
            if (end > i + 1) {
                flush();
                out.push(el('strong', {}, ...renderInline(s.slice(i + 2, end))));
                i = end + 2;
                continue;
            }
        }
        // 기울임 *...*(공백으로 시작/끝나지 않는 단일 별표)
        if (ch === '*' && s[i + 1] !== '*' && s[i + 1] !== ' ' && s[i + 1] !== undefined) {
            const end = s.indexOf('*', i + 1);
            if (end > i && s[end - 1] !== ' ') {
                flush();
                out.push(el('em', {}, ...renderInline(s.slice(i + 1, end))));
                i = end + 1;
                continue;
            }
        }
        // 링크 [텍스트](url)
        if (ch === '[') {
            const close = s.indexOf(']', i + 1);
            if (close > i && s[close + 1] === '(') {
                const paren = s.indexOf(')', close + 2);
                if (paren > close) {
                    const label = s.slice(i + 1, close);
                    const href = safeHref(s.slice(close + 2, paren));
                    flush();
                    if (href) {
                        out.push(el('a', { class: 'md-link', href, rel: 'noopener noreferrer nofollow' }, ...renderInline(label)));
                    }
                    else {
                        // 위험 스킴 → 링크 무력화. 라벨만 평문으로(href 비노출).
                        out.push(...renderInline(label));
                    }
                    i = paren + 1;
                    continue;
                }
            }
        }
        buf += ch;
        i++;
    }
    flush();
    return out;
}
// 블록 파서 — 줄 단위로 블록을 구성한다. 모든 텍스트는 renderInline 경유(textContent).
function renderMarkdown(md) {
    const root = el('div', { class: 'md' });
    const lines = String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    // 표 후보: | 로 시작/구분되는 2줄 이상 + 두번째 줄이 구분행(---|---).
    const isTableSep = (l) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.indexOf('-') >= 0;
    const splitRow = (l) => {
        let t = l.trim();
        if (t.startsWith('|'))
            t = t.slice(1);
        if (t.endsWith('|'))
            t = t.slice(0, -1);
        return t.split('|').map((c) => c.trim());
    };
    while (i < lines.length) {
        let line = lines[i];
        // 빈 줄 — 스킵.
        if (line.trim() === '') {
            i++;
            continue;
        }
        // 코드블록 ``` ... ```
        const fence = /^(```|~~~)(.*)$/.exec(line);
        if (fence) {
            const marker = fence[1];
            const code = [];
            i++;
            while (i < lines.length && lines[i].trimEnd() !== marker && !lines[i].startsWith(marker)) {
                code.push(lines[i]);
                i++;
            }
            if (i < lines.length)
                i++; // 닫는 펜스 소비
            root.append(el('pre', { class: 'md-pre' }, el('code', { text: code.join('\n') })));
            continue;
        }
        // 구분선 --- *** ___
        if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            root.append(el('hr', { class: 'md-hr' }));
            i++;
            continue;
        }
        // 제목 #~######
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) {
            const lvl = h[1].length;
            root.append(el('h' + lvl, { class: 'md-h md-h' + lvl }, ...renderInline(h[2].trim())));
            i++;
            continue;
        }
        // 인용 > ...
        if (/^\s*>\s?/.test(line)) {
            const quote = [];
            while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
                quote.push(lines[i].replace(/^\s*>\s?/, ''));
                i++;
            }
            // 인용 안의 내용도 마크다운으로(중첩 렌더).
            const inner = renderMarkdown(quote.join('\n'));
            const bq = el('blockquote', { class: 'md-quote' });
            while (inner.firstChild)
                bq.append(inner.firstChild);
            root.append(bq);
            continue;
        }
        // 표: 헤더줄(| 포함) + 다음 줄이 구분행.
        if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
            const header = splitRow(line);
            i += 2; // 헤더 + 구분행 소비
            const rows = [];
            while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') >= 0) {
                rows.push(splitRow(lines[i]));
                i++;
            }
            const table = el('table', { class: 'md-table' });
            const thead = el('thead');
            const htr = el('tr');
            for (const c of header)
                htr.append(el('th', {}, ...renderInline(c)));
            thead.append(htr);
            table.append(thead);
            const tbody = el('tbody');
            for (const r of rows) {
                const tr = el('tr');
                for (let c = 0; c < header.length; c++)
                    tr.append(el('td', {}, ...renderInline(r[c] || '')));
                tbody.append(tr);
            }
            table.append(tbody);
            root.append(table);
            continue;
        }
        // 리스트 — 순서/비순서 연속 블록. 들여쓰기 중첩은 한 단계만 단순 지원.
        const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
        const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
        if (bullet || ordered) {
            const isOrdered = !!ordered;
            const listTag = isOrdered ? 'ol' : 'ul';
            const list = el(listTag, { class: 'md-list' });
            const itemRe = isOrdered ? /^(\s*)(\d+)[.)]\s+(.*)$/ : /^(\s*)([-*+])\s+(.*)$/;
            while (i < lines.length) {
                const m = itemRe.exec(lines[i]);
                if (!m) {
                    // 같은 리스트의 이어지는(들여쓴, 마커 없는) 줄은 직전 항목에 합친다.
                    if (lines[i].trim() !== '' && /^\s+/.test(lines[i]) && list.lastChild) {
                        list.lastChild.append(document.createTextNode(' '));
                        for (const n of renderInline(lines[i].trim()))
                            list.lastChild.append(n);
                        i++;
                        continue;
                    }
                    break;
                }
                list.append(el('li', {}, ...renderInline(m[3])));
                i++;
            }
            root.append(list);
            continue;
        }
        // 단락 — 빈 줄/블록 경계 전까지 모은다. 줄바꿈은 <br> 로 보존.
        const para = [];
        while (i < lines.length) {
            const l = lines[i];
            if (l.trim() === '')
                break;
            // 다음 블록 시작이면 단락 종료.
            if (/^(#{1,6})\s+/.test(l) || /^(```|~~~)/.test(l) || /^\s*>\s?/.test(l) ||
                /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l) || /^(\s*)([-*+])\s+/.test(l) ||
                /^(\s*)(\d+)[.)]\s+/.test(l) || (l.indexOf('|') >= 0 && lines[i + 1] != null && isTableSep(lines[i + 1])))
                break;
            para.push(l);
            i++;
        }
        const p = el('p', { class: 'md-p' });
        para.forEach((l, idx) => {
            if (idx > 0)
                p.append(el('br'));
            for (const n of renderInline(l))
                p.append(n);
        });
        root.append(p);
    }
    return root;
}
// ── fetch 헬퍼 — 401 은 토큰 게이트, 그 외 비정상은 {error} 메시지로 throw ──
async function api(path, opts = {}) {
    const token = localStorage.getItem(TOKEN_KEY);
    const headers = Object.assign({}, opts.headers);
    if (token)
        headers['Authorization'] = 'Bearer ' + token;
    if (opts.body)
        headers['Content-Type'] = 'application/json';
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY);
        state.me = null;
        showGate('세션이 만료되었습니다. 다시 로그인하세요.');
        const e = new Error('인증이 필요합니다');
        e.status = 401;
        throw e;
    }
    let data = null;
    try {
        data = await res.json();
    }
    catch (_) { /* 빈 바디 허용 */ }
    if (!res.ok) {
        const e = new Error((data && data.error) || ('요청 실패 (' + res.status + ')'));
        e.status = res.status;
        throw e;
    }
    return data;
}
// ── 시간/숫자 ──
// 마지막 갱신이 며칠 전일 수 있음 — 분/시간/일 폴백('분' 가정 금지).
function relTime(iso) {
    if (!iso)
        return '갱신 기록 없음';
    const t = new Date(iso).getTime();
    if (Number.isNaN(t))
        return '갱신 기록 없음';
    const m = Math.floor((Date.now() - t) / 60000);
    if (m < 1)
        return '방금 전';
    if (m < 60)
        return m + '분 전';
    const h = Math.floor(m / 60);
    if (h < 24)
        return h + '시간 전';
    const d = Math.floor(h / 24);
    if (d < 30)
        return d + '일 전';
    return new Date(iso).toLocaleDateString('ko-KR');
}
function absTime(iso) {
    if (!iso)
        return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ko-KR');
}
const fmtNum = (n) => Number(n || 0).toLocaleString('ko-KR');
// ── 토스트 ──
function toast(msg, isError) {
    const box = document.getElementById('toasts');
    const t = el('div', { class: 'toast' + (isError ? ' coral' : ''), text: msg });
    box.append(t);
    setTimeout(() => t.remove(), 3600);
}
// ── 토큰 게이트 ──
function showGate(message) {
    document.getElementById('app').hidden = true;
    const gate = document.getElementById('gate');
    gate.hidden = false;
    const err = document.getElementById('gate-error');
    if (message) {
        err.textContent = message;
        err.hidden = false;
    }
    document.getElementById('gate-input').focus();
}
function hideGate() {
    document.getElementById('gate').hidden = true;
    document.getElementById('app').hidden = false;
}
// ── 로그아웃 — 세션 회수 + 로컬 토큰 제거 → 게이트. (헤더 버튼·강제 비번변경 모달 공용) ──
async function logout(message) {
    try {
        await fetch('/api/ui/logout', { method: 'POST' });
    }
    catch (_) { /* noop */ }
    localStorage.removeItem(TOKEN_KEY);
    state.me = null;
    const lb = document.getElementById('logout-btn');
    if (lb)
        lb.hidden = true;
    showGate(message || '로그아웃되었습니다.');
}
// ── 에러 표시 헬퍼 ──
function errorNote(e, prefix) {
    if (e && e.status === 403) {
        return el('div', { class: 'note', text: '이 토큰에 필요한 권한(memory)이 없습니다.' });
    }
    return el('div', { class: 'note', text: (prefix || '불러오지 못했습니다') + ' — ' + (e && e.message ? e.message : '알 수 없는 오류') });
}
// ── 공용: 상태 점 + 라벨(§0.5 — 채운 필 금지, 6px 점 + 무채 텍스트) ──
function lifecycleDot(lifecycle) {
    const cls = lifecycle === 'active' ? 'st ok' : (lifecycle === 'rejected' ? 'st dim' : 'st');
    return el('span', { class: cls, text: LIFECYCLE_LABEL[lifecycle] || lifecycle });
}
function confidenceDot(confidence) {
    // 출처(provenance) 점: ai=점만(중립), human=민트(사람 저작/승인), rule=연회색, observed=연회색(외부 미러 — 큐레이션 아님).
    const cls = confidence === 'human' ? 'st ok'
        : (confidence === 'rule' || confidence === 'observed') ? 'st dim' : 'st';
    return el('span', { class: cls, text: CONFIDENCE_LABEL[confidence] || confidence });
}
// '시작하기' 상위 탭의 가로 중분류(설치·사용설명서) — 같은 sub-cats 패턴. 가이드는 top 탭에서 빼 여기로(한 번 읽는 온보딩).
const START_SUBS = [
    { key: 'install', label: '설치', href: '#/install' },
    { key: 'learn', label: '사용설명서', href: '#/learn' },
];
function stat(num, label, unit) {
    return el('div', { class: 'stat' }, el('div', { class: 'num' }, num, unit ? el('small', {}, ' ' + unit) : null), el('div', { class: 'lbl', text: label }));
}
// 검토 대기 — 0 이면 무채(건강), >0 이면 클릭 가능(검토로 이동).
function selectFilter(opts, sel) {
    const s = el('select');
    for (const [v, t] of opts)
        s.append(el('option', { value: v, text: t }));
    s.value = sel || '';
    return s;
}
// ── P-V3-4a 도메인 통제어휘 select ──
// 도메인은 자유 키워드가 아니라 repo 하위 통제 어휘. 드롭다운은 domain_list(=/api/ui/domainmap/:repo/domains)로
// 채운다. 도메인맵이 죽거나 repo 미존재면 graceful: 캐시에 error 를 남기고 호출부가 자유입력 폴백을 쓴다.
// v6 은퇴(2026-06-24): loadAllDomains/loadDomains(구 도메인 통제어휘 드롭다운 — 주제분류 패널 폐기) 제거. 카테고리 관리는 관리→위지설정.
// repo 셀렉터 — repo_list union 의 repos[] 로 채운다(domainmap ∪ 매핑테이블). 단일 repo 면 라벨만.
async function loadRepos() {
    if (state.domains.__repos__)
        return state.domains.__repos__;
    let repos = [VOCAB_CRUD_DEFAULT_REPO];
    try {
        const r = await api('/api/ui/repos');
        if (r && Array.isArray(r.repos) && r.repos.length)
            repos = r.repos;
    }
    catch (_) { /* graceful: 기본 repo 만 */ }
    state.domains.__repos__ = repos;
    return repos;
}
// v6 은퇴(2026-06-24): buildDomainSelect(구 도메인 통제어휘 <select>) 제거 — 주제분류 패널 폐기.
function interleave(arr, sep) {
    const out = [];
    arr.forEach((n, i) => { if (i)
        out.push(sep); out.push(n); });
    return out;
}
// ── 공용 페이지 헤더(#367) — 모든 탭 상단 제목을 하나의 형식으로 통일 ──
// 구조: .page-head > .page-head-row( h1.page-title  [+ .page-head-actions] ) [+ p.sub].
//  · title  = 탭 이름과 같은 짧은 제목(28px h1) — 페이지마다 손으로 다르게 짜던 것을 여기 한 곳으로.
//  · sub    = 한 줄 설명(plain, 없으면 생략). 전문용어 대신 쉬운 말로.
//  · actions= 제목 오른쪽에 붙는 버튼/요소들(+ 추가·🗑 휴지통 등, 없으면 제목만).
//  · accent = 제목의 뒤쪽 일부를 브랜드 블루로(앱 전반의 관례: 프로'젝트'·지'식'처럼 끝부분 강조). 생략 시 강조 없음.
function pageHead(title, sub, actions, accent) {
    const h1 = el('h1', { class: 'page-title' });
    if (accent && title.endsWith(accent)) {
        const lead = title.slice(0, title.length - accent.length);
        if (lead)
            h1.append(document.createTextNode(lead));
        h1.append(el('span', { class: 'accent', text: accent }));
    }
    else {
        h1.textContent = title;
    }
    const acts = (actions || []).filter(Boolean);
    const row = el('div', { class: 'page-head-row' }, h1);
    if (acts.length)
        row.append(el('div', { class: 'page-head-actions' }, ...acts));
    return el('div', { class: 'page-head' }, row, sub ? el('p', { class: 'sub', text: sub }) : null);
}
// ── 아바타(프로필 원형) — 셀프 업로드 이미지가 있으면 그걸, 없으면 이름 이니셜+결정적 색상. ──
//  projects.ts 의 동명 헬퍼와 알고리즘 동일(드리프트 방지 위해 동일 구현 — 같은 seed→같은 색/이니셜).
//  projects.ts 가 admin.js 를 import 하므로 여기(core, 무순환)에 둬 main/admin 이 순환 없이 공유.
function initials(name) {
    const s = String(name || '').trim();
    if (!s)
        return '?';
    if (/[가-힣]/.test(s[0]))
        return s.slice(0, 1);
    const parts = s.split(/\s+/);
    if (parts.length >= 2 && parts[1][0])
        return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
}
function avatarColor(seed) {
    const s = String(seed || '');
    let h = 0;
    for (let i = 0; i < s.length; i++)
        h = (h * 31 + s.charCodeAt(i)) % 360;
    return 'hsl(' + h + ', 50%, 60%)';
}
// 원형 아바타 element. avatar(data URL)면 <img>, 없으면 색상+이니셜. cls 로 크기 변형(topbar-ava 등).
function profileAvatar(avatar, name, seed, cls) {
    const wrap = el('span', { class: 'pava' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' });
    if (avatar) {
        wrap.append(el('img', { src: avatar, alt: '' }));
    }
    else {
        wrap.style.background = avatarColor(seed || name);
        wrap.textContent = initials(name);
    }
    return wrap;
}
export { avatarColor, initials, profileAvatar, $view, ACTIVITY_TYPE_LABEL, ACTIVITY_TYPE_ORDER, interleave, LIFECYCLE_LABEL, REF_REL_LABEL, REVIEW_LABEL, TOKEN_KEY, VOCAB_CRUD_DEFAULT_REPO, absTime, api, applyReveal, confidenceDot, el, errorNote, fmtNum, hideGate, lifecycleDot, loadRepos, logout, pageHead, reducedMotion, relTime, renderMarkdown, safeHref, selectFilter, showGate, stat, state, sv, toast, };

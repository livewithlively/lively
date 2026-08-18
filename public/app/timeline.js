// timeline.ts — 우패널 공용 **타임라인**(#1719). 화면마다 대상만 바뀌고 생김새·어휘는 한 벌이다.
//   프로젝트 → 그 프로젝트에서 일어난 일 · AI 세션 → 그 세션이 한 일 · 홈/리브 → 워크스페이스에서 일어난 일.
//
//  ── 무엇을 적나 (상민님 2026-08-18) ──
//   "일반 사람 입장에서 **중요한 변화·새로 만든 파일·중요한 결정**만. 쓸데없는 얘기는 하나도 없게.
//    모두 한 줄 안에 요약하고, 자세한 건 눌러서."
//   규칙 셋:
//    ① 사건이 아닌 것은 **아예 안 적는다** — 임시파일·스크린샷·조회 명령은 일한 자취가 아니다(거르기는 session-trail.ts).
//    ② 한 항목은 **한 줄**이다 — 넘치면 자른다. 원문은 툴팁에. 다만 줄끼리는 숨 쉴 만큼 떨어뜨린다.
//    ②' 필터는 두지 않는다 — 고를 필요가 없도록 애초에 남은 것만 싣는다(상민님 2026-08-18).
//    ③ 일은 **장(章)으로 접힌다** — 세션은 지시 하나가 한 장, 프로젝트는 작업 기록 하나가 한 장.
//       접힌 장에는 제목과 결과 배지(파일 4 · 커밋 1)만 보이고, 누르면 그 안이 펼쳐진다.
//
//  ── 위계 ──
//   손으로 매기지 않는다. tierOf(kind, verb) 규칙 하나가 정한다(상태 어휘 session-status.ts 와 같은 규약).
//    1 중요한 것(기본 보기) — 파일 씀·고침 · 지식 남김 · 커밋 · 작업 기록 · 태스크 끝냄 · 상태 바뀜
//    2 한 일 — 읽음 · 찾아봄 · 검사(빌드·테스트)
//    3 뒷일 — 지시·잔 편집·배관(머지·푸시·서버 반영)
import { el, personFace } from './core.js';
// ── 위계표 ──────────────────────────────────────────────────────────────────
const KEEP_VERBS = new Set(['씀', '고침', '남김', '덧붙임', '만듦', '끝냄', '커밋', '기록', '바꿈']);
const KIND_TIER = {
    file: 2, cmd: 2, knowledge: 2, activity: 1, project: 2, task: 2, source: 2, say: 3, meta: 3,
};
export function tierOf(it) {
    if (it.tier)
        return it.tier;
    if (KEEP_VERBS.has(it.verb))
        return 1;
    return KIND_TIER[it.kind] ?? 2;
}
export const TL_KINDS = [
    { key: 'file', label: '파일' }, { key: 'knowledge', label: '지식' }, { key: 'activity', label: '작업 기록' },
    { key: 'cmd', label: '명령' }, { key: 'task', label: '태스크' }, { key: 'project', label: '프로젝트' },
    { key: 'source', label: '자료' }, { key: 'say', label: '지시' }, { key: 'meta', label: '잔 변경' },
];
// 2행에 조용히 놓을 '무엇을 한 일인가' — 라벨이 아니라 문장의 한 조각이다.
const KIND_WORD = {
    task: '끝낸 일', knowledge: '남긴 지식', activity: '작업', cmd: '코드', file: '파일',
    project: '프로젝트', say: '남긴 말', source: '자료', meta: '설정',
};
const hhmm = (iso) => {
    if (!iso)
        return '';
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
};
const dayOf = (iso) => (iso || '').slice(0, 10);
function dayLabel(key) {
    const today = new Date();
    const t = today.toISOString().slice(0, 10);
    const y = new Date(today.getTime() - 864e5).toISOString().slice(0, 10);
    if (key === t)
        return '오늘';
    if (key === y)
        return '어제';
    const d = new Date(key + 'T00:00:00');
    return Number.isFinite(d.getTime()) ? (d.getMonth() + 1) + '월 ' + d.getDate() + '일' : key;
}
const tsNum = (iso) => { const n = Date.parse(iso || ''); return Number.isFinite(n) ? n : 0; };
// ── 사람 말로 ───────────────────────────────────────────────────────────────
//  개발 도구의 원문(커밋 문법 feat(ui):, 꼬리표 (#1719)·PR #146)을 그대로 붙여넣지 않는다.
const CONV_PREFIX = /^(feat|fix|chore|docs|refactor|test|perf|style|build|ci|design)(\([^)]*\))?:\s*/i;
const TAIL_REF = /\s*[·,]?\s*\(?(?:lively\s*)?(?:dev\s*반영\s*[·,]?\s*)?PR\s*#\d+\)?\s*$/i;
const TAIL_NUM = /\s*\(?#\d+\)?\s*$/;
function stripRefs(t) {
    let s = t;
    for (let i = 0; i < 3; i++)
        s = s.replace(TAIL_REF, '').replace(TAIL_NUM, '').trim();
    return s;
}
/** 커밋 메시지·PR 제목·지시 → 한 줄. */
export function humanTitle(raw, max = 44) {
    let t = String(raw ?? '').split('\n')[0].replace(/\s+/g, ' ').trim().replace(CONV_PREFIX, '');
    t = stripRefs(t);
    const dash = t.search(/\s[—–]\s/); // 부연은 뒤에 온다 — 앞 마디만
    if (dash > 10)
        t = t.slice(0, dash);
    return t.length > max ? t.slice(0, max - 1).replace(/[\s·,]+$/, '') + '…' : t;
}
/** 작업 기록 요약 → 한 줄. '중분류 - 내용' 규약이면 내용이 본체다. */
export function humanSummary(raw, max = 46) {
    let t = String(raw ?? '').replace(/\s+/g, ' ').trim();
    const m = t.match(/^(.{2,14}?)\s+-\s+(.+)$/); // '중분류 - 내용' 규약이면 내용이 본체
    if (m)
        t = m[2];
    const c = t.match(/^([^:：]{2,24})[:：]\s+(.{6,})$/); // "as-built(#1437): 무엇을 했나" 처럼 앞이 꼬리표
    if (c)
        t = c[2];
    t = stripRefs(t);
    // 참조성 괄호는 길이와 무관하게 뗀다 — (#1719), (2026-08-18 · PR #164) 같은 건 읽는 사람 몫이 아니다.
    t = t.replace(/\s*\((?=[^)]*(?:#\d|\d{4}-\d{2}))[^)]*\)?\s*/g, ' ').replace(/\s+/g, ' ').trim();
    // 나머지는 **넘칠 때만** 자른다 — 짧은 제목의 부연·나열·괄호는 정보다.
    if (t.length > max) {
        const i = t.search(/\s[—–]\s/);
        if (i > 8)
            t = t.slice(0, i);
    }
    {
        const i = t.search(/\s·\s/);
        if (i > 8)
            t = t.slice(0, i);
    } // 나열(·)은 길이와 무관하게 첫 마디만 — 여러 건을 한 줄에 욱여넣은 표시다
    if (t.length > max) {
        const i = t.search(/\s*\(/);
        if (i >= 6)
            t = t.slice(0, i);
    }
    t = stripRefs(t).replace(/[\s·,:=+-]+$/, '').trim();
    return t.length > max ? t.slice(0, max - 1).replace(/[\s·,]+$/, '') + '…' : t;
}
export function createTimeline(host, ctx) {
    let items = []; // 시간순(오래된 → 최신). 화면은 최신이 위.
    const byId = new Map();
    const open = new Set(); // 펼친 장
    let dirty = false;
    const countEl = el('span', { class: 'v2-k' });
    const list = el('div', { class: 'tl-list' });
    const emptyEl = el('p', { class: 'v2-empty', text: ctx.empty || '아직 기록이 없어요.' });
    const noteEl = el('p', { class: 'v2-fine', hidden: true });
    const root = el('section', { class: 'tl-wrap' }, el('div', { class: 'v2-aside-h' }, el('b', { text: '타임라인' }), el('span', { class: 'tl-scope', text: ctx.scope }), countEl), list, emptyEl, noteEl);
    host.append(root);
    const isHead = (it) => !!ctx.chapters && it.kind === 'say' && it.verb === '지시';
    // ── 한 항목 = 한 카드 ────────────────────────────────────────────────────
    //  상민님 2026-08-18: "디자인이 클로드 딸깍 같고 촌스럽다."
    //  → 제목이 주인공이 되게 바꾼다. 종전엔 [동사] 라벨이 맨 앞에서 제목을 밀고 색까지 써서 눈이 라벨로 갔다.
    //    이제 1행은 **제목과 시각**뿐이고, 무엇을 한 일인지(종류)·누가·결과는 2행에 조용히 붙는다.
    //    테두리를 걷고 옅은 그림자만 둬서 카드가 종이처럼 뜨게 하고, 색은 레일 점 하나에만 쓴다.
    const faceOf = (a) => (ctx.showActors && a && (a.id || a.name) ? personFace(String(a.id || ''), 'tl-face', String(a.name || a.id || '')) : null);
    /** 2행에 들어갈 조용한 말 — "무엇을 한 일인가 · 남은 것". 개수 나열은 소음이라 최소로. */
    function metaBits(it, kids) {
        const kn = kids.filter((k) => k.kind === 'knowledge').length + (it.children || []).filter((c) => c.verb === '지식').length;
        const files = kids.filter((k) => k.kind === 'file').length + (it.children || []).filter((c) => c.verb === '파일').length;
        const bits = [];
        if (it.kind === 'cmd' && it.detail)
            bits.push(it.detail + '번');
        else
            bits.push(KIND_WORD[it.kind] || '');
        if (files)
            bits.push('파일 ' + files);
        if (kn)
            bits.push('지식 ' + kn);
        return bits.filter(Boolean).join(' · ');
    }
    function card(it, kids, sameWho) {
        const canOpen = kids.length > 0 || (it.children || []).length > 0;
        const isOpen = open.has(it.id);
        const body = canOpen
            ? el('div', { class: 'tl-body', hidden: !isOpen }, ...kids.slice().reverse().map(sub), ...(it.children || []).map(childLine))
            : null;
        const face = sameWho ? null : faceOf(it.actor);
        const box = el(it.href && !canOpen ? 'a' : 'div', {
            class: 'tl-card tlk-' + it.kind + (canOpen ? ' can' : '') + (isOpen ? ' open' : '') + (it.href && !canOpen ? ' go' : '') + (it.error ? ' err' : ''),
            href: it.href && !canOpen ? it.href : null,
            title: [it.label, it.detail].filter(Boolean).join('\n'),
        }, el('div', { class: 'tl-head' }, el('span', { class: 'tl-ttl', text: it.label || '(이름 없음)' }), it.count > 1 ? el('span', { class: 'tl-x', text: '×' + it.count }) : null, el('span', { class: 'tl-tm', text: hhmm(it.ts) })), el('div', { class: 'tl-meta' }, el('span', { class: 'tl-what', text: metaBits(it, kids) }), face, face && it.actor && it.actor.name ? el('span', { class: 'tl-who', text: String(it.actor.name) }) : null, canOpen ? el('span', { class: 'tl-car', 'aria-hidden': 'true', text: '›' }) : null), body);
        if (canOpen) {
            box.setAttribute('role', 'button');
            box.setAttribute('tabindex', '0');
            box.setAttribute('aria-expanded', String(isOpen));
            const toggle = () => { if (isOpen)
                open.delete(it.id);
            else
                open.add(it.id); paint(); };
            box.addEventListener('click', (e) => { if (e.target.closest('a'))
                return; toggle(); });
            box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle();
            } });
        }
        return box;
    }
    /** 펼친 카드 안의 한 줄 — 맥락은 카드가 잡았으니 여기서는 촘촘해도 된다. */
    function sub(it) {
        return el(it.href ? 'a' : 'div', { class: 'tl-sub' + (it.href ? ' go' : ''), href: it.href || null, title: it.label }, el('span', { class: 'tl-sub-v tlk-' + it.kind, text: it.verb }), el('span', { class: 'tl-sub-t', text: it.label }), it.count > 1 ? el('span', { class: 'tl-x', text: '×' + it.count }) : null, el('span', { class: 'tl-tm', text: hhmm(it.ts) }));
    }
    function childLine(c) {
        return el(c.href ? 'a' : 'div', { class: 'tl-sub' + (c.href ? ' go' : ''), href: c.href || null, title: c.label }, el('span', { class: 'tl-sub-v', text: c.verb }), el('span', { class: 'tl-sub-t', text: c.label }));
    }
    // ── 그리기 ──
    function paint() {
        const rows = [];
        let cur = null;
        for (const it of items) {
            if (isHead(it)) {
                cur = { head: it, kids: [] };
                rows.push(cur);
                continue;
            }
            if (cur)
                cur.kids.push(it);
            else
                rows.push({ solo: it });
        }
        // 장은 안에 남은 것이 있을 때만 세운다 — 아무것도 안 남은 지시는 타임라인의 사건이 아니다.
        const shownRows = rows.filter((r) => ('solo' in r ? true : r.kids.length > 0));
        const shownCount = rows.reduce((n, r) => n + ('solo' in r ? 1 : r.kids.length), 0);
        countEl.textContent = String(shownCount);
        emptyEl.hidden = shownCount > 0;
        const kids = [];
        let day = ' ';
        let lastWho = '\u0000'; // 같은 사람이 이어지면 이름을 되풀이하지 않는다
        let rail = el('div', { class: 'tl-rail' });
        for (let i = shownRows.length - 1; i >= 0; i--) { // 최신이 위
            const r = shownRows[i];
            const ts = 'solo' in r ? r.solo.ts : r.head.ts;
            const d = dayOf(ts);
            if (d !== day) {
                day = d;
                if (d)
                    kids.push(el('div', { class: 'tl-day' }, el('span', { text: dayLabel(d) })));
                rail = el('div', { class: 'tl-rail' });
                kids.push(rail);
                lastWho = '\u0000'; // 날이 바뀌면 다시 밝힌다
            }
            const it0 = 'solo' in r ? r.solo : r.head;
            const who = String((it0.actor && it0.actor.id) || '');
            rail.append('solo' in r ? card(r.solo, [], who === lastWho) : card(r.head, r.kids, who === lastWho));
            lastWho = who;
        }
        list.replaceChildren(...kids);
    }
    function schedule() {
        if (dirty)
            return;
        dirty = true;
        requestAnimationFrame(() => { dirty = false; paint(); });
    }
    // 같은 것은 **떨어져 있어도** 한 줄로 합친다 — 한 지식을 세 번 덧붙였다고 세 줄이 되면 그건 사건이 아니라 반복이다.
    //  합칠 때 맨 뒤로 옮겨, 지금 하는 일(마지막 장) 아래에 놓이게 한다.
    const byKey = new Map();
    function merge(it, at) {
        const prev = byKey.get(it.key);
        if (!prev || prev.error || it.error)
            return false;
        prev.count++;
        if (at === 'end') {
            if (it.ts)
                prev.ts = it.ts;
            const i = items.indexOf(prev);
            if (i >= 0 && i !== items.length - 1) {
                items.splice(i, 1);
                items.push(prev);
            }
        }
        byId.set(it.id, prev);
        return true;
    }
    const h = {
        root,
        add(raw, at = 'end') {
            const it = { count: 1, ...raw, kind: raw.kind || 'cmd' };
            if (!merge(it, at)) {
                if (at === 'end')
                    items.push(it);
                else
                    items.unshift(it);
                byId.set(it.id, it);
                byKey.set(it.key, it);
                if (isHead(it) && at === 'end') {
                    open.clear();
                    open.add(it.id);
                } // 지금 하는 일만 펼친 채로
            }
            schedule();
        },
        result(id, _output, isError) {
            const it = byId.get(id);
            if (!it || !isError)
                return;
            it.error = true;
            schedule();
        },
        addAll(next) {
            for (const raw of next) {
                const it = { count: 1, ...raw };
                const old = byId.get(it.id);
                if (old) {
                    Object.assign(old, it, { count: old.count });
                    continue;
                }
                items.push(it);
                byId.set(it.id, it);
                byKey.set(it.key, it);
            }
            items.sort((a, b) => tsNum(a.ts) - tsNum(b.ts));
            schedule();
        },
        setNote(note) { noteEl.textContent = note || ''; noteEl.hidden = !note; },
        clear() { items = []; byId.clear(); byKey.clear(); open.clear(); schedule(); },
    };
    paint();
    return h;
}

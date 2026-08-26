// v2/last-ask.ts — 세션 행 둘째 줄: **내가 마지막으로 시킨 말**(#2016 6차, 원준 2026-08-26: "밑에 2행에 있는 거는
//  내가 한 마지막 질문의 짧은 요약본으로 바꿔 줘"). 종전엔 폴더 + 프로젝트명(누르면 프로젝트로)이었다.
//
//  목록 API 에는 그 글이 없다 — 중앙 기록의 session 표는 **첫 지시**(= 제목)만 쥔다(src/v6/session-log-store.ts
//  firstUserPromptTitle). 서버에 칸을 더하면 게이트웨이를 다시 띄워야 데브에 서므로(#1979 제약), 지금은 대화
//  꼬리를 행마다 한 번씩 받아(panes-parts fetchTurns — 탭 이름 폴백 lookupSessNames 가 같은 길) 이 기기에 캐시한다.
//   · 같은 lastSeen 이면 다시 묻지 않는다(활동이 있어야 새 말이 있다) · 동시 4건 · 도착하면 onReady 로 목록만 갈아 끼운다.
//   · 새 활동이 생기면 옛 글을 먼저 보여 주고 뒤에서 바꾼다 — 빈 줄이 깜빡이지 않게.
//  ⚠ 서버 칸(session.last_prompt)으로 올리는 것이 정답이다 — 그때 이 파일은 그 값을 읽는 한 줄로 줄어든다.
import { fetchLastAsk } from './panes-parts.js';
const TAIL = 48000; // 꼬리 바이트 — 클로드 코드의 last-prompt 레코드는 턴마다 있어 보통 여기 든다(행 20개면 1MB 안쪽)
const TAIL_FAR = 240000; // 못 찾으면 한 번 더 멀리 — 도구 결과가 긴 에이전트 세션은 사람 말이 수백 KB 뒤에 있다(dev 실측)
const STORE = 'lively_v2_last_ask'; // 이 기기의 기억 — 새로고침마다 20~50건을 다시 받지 않게(같은 lastSeen 이면 그대로)
const KEEP = 200;
const LIMIT = 4;
const MAX = 56;
const RETRY_MS = 10 * 60 * 1000; // 못 찾은 세션은 10분 뒤에나 다시 묻는다(권한 없는 남의 세션·기록 없는 옛 세션이 매 폴링마다 3~6 요청을 만들지 않게)
const cache = new Map();
try {
    const v = JSON.parse(localStorage.getItem(STORE) || '{}');
    for (const [k, e] of Object.entries(v))
        if (e && typeof e.seen === 'number')
            cache.set(k, { seen: e.seen, text: typeof e.text === 'string' ? e.text : null, at: Number(e.at || 0) });
}
catch (_) { /* 기억이 없으면 새로 받는다 */ }
function persist() {
    try {
        const ents = [...cache.entries()].sort((a, b) => b[1].seen - a[1].seen).slice(0, KEEP);
        localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(ents)));
    }
    catch (_) { /* 이번 화면은 된다 */ }
}
const queue = [];
const queued = new Set();
let running = 0;
let ready = null;
let tick = null;
function notify() {
    if (tick)
        return;
    tick = window.setTimeout(() => { tick = null; ready?.(); }, 180);
}
/** 새 글이 도착했을 때 부를 것 — 사이드바가 **목록만** 다시 그린다(검색칸은 살아 있는 IME 조합). */
export function watchLastAsk(cb) { ready = cb; }
/** 이 세션에 내가 마지막으로 시킨 말(짧게). 아직 모르면 null 을 주고 뒤에서 찾아 onReady 로 알린다. */
export function lastAsk(s) {
    const hit = cache.get(s.id);
    const seen = Number(s.lastSeen || 0);
    if (hit && (hit.seen === seen || (hit.text === null && Date.now() - hit.at < RETRY_MS)))
        return hit.text;
    if (!queued.has(s.id)) {
        queued.add(s.id);
        queue.push(s);
        pump();
    }
    return hit ? hit.text : null;
}
function pump() {
    while (running < LIMIT && queue.length) {
        const s = queue.shift();
        running += 1;
        void one(s).finally(() => { running -= 1; queued.delete(s.id); pump(); });
    }
}
async function one(s) {
    let r = await fetchLastAsk(s, TAIL);
    if (!r.text && r.ok)
        r = await fetchLastAsk(s, TAIL_FAR); // 읽히긴 했는데 내 말이 안 보였다 — 더 멀리. 아예 못 읽었으면(권한·좌표) 그만.
    const text = r.text ? shorten(r.text) : null;
    const prev = cache.get(s.id);
    cache.set(s.id, { seen: Number(s.lastSeen || 0), text, at: Date.now() });
    persist();
    if (!prev || prev.text !== text)
        notify();
}
/** 한 줄로 — 앞머리의 마크다운 기호·인용 부호를 걷고 MAX 자에서 자른다. */
function shorten(t) {
    const x = t.replace(/\s+/g, ' ').replace(/^[\s>*#\-•·"'“]+/, '').trim();
    return x.length > MAX ? x.slice(0, MAX - 1).trimEnd() + '…' : x;
}

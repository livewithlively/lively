// v2/last-ask.ts — 세션 행 둘째 줄: **내가 마지막으로 시킨 말**(#2016 6차, 원준 2026-08-26: "밑에 2행에 있는 거는
//  내가 한 마지막 질문의 짧은 요약본으로 바꿔 줘"). 종전엔 폴더 + 프로젝트명(누르면 프로젝트로)이었다.
//
//  목록 API 에는 그 글이 없다 — 중앙 기록의 session 표는 **첫 지시**(= 제목)만 쥔다(src/v6/session-log-store.ts
//  firstUserPromptTitle). 서버에 칸을 더하면 게이트웨이를 다시 띄워야 데브에 서므로(#1979 제약), 지금은 대화
//  꼬리를 행마다 한 번씩 받아(sess-tail fetchTurns — 세션 카드가 같은 길) 이 기기에 캐시한다.
//   · 같은 lastSeen 이면 다시 묻지 않는다(활동이 있어야 새 말이 있다) · 동시 4건 · 도착하면 onReady 로 목록만 갈아 끼운다.
//   · 새 활동이 생기면 옛 글을 먼저 보여 주고 뒤에서 바꾼다 — 빈 줄이 깜빡이지 않게.
//  ★ 서버 칸이 생겼다(#2197 — org_session_state.last_prompt, work-flag 훅이 UserPromptSubmit 순간 보고). 목록 행에
//   lastPrompt 가 실리면 그것이 정본이고 아래 꼬리 조회는 **그 값이 없는 세션**(옛 훅·코덱스·기록 세션)의 폴백이다.
import { deviceStore } from './shell-prefs.js';   // #2460 — 마지막 말 캐시는 이 기기의 것(정본은 서버 세션)
import { fetchLastAsk } from './sess-tail.js';
import type { Sess } from './views.js';

const TAIL = 48000;    // 꼬리 바이트 — 클로드 코드의 last-prompt 레코드는 턴마다 있어 보통 여기 든다(행 20개면 1MB 안쪽)
const TAIL_FAR = 240000;   // 못 찾으면 한 번 더 멀리 — 도구 결과가 긴 에이전트 세션은 사람 말이 수백 KB 뒤에 있다(dev 실측)
const STORE = deviceStore('lively_v2_last_ask');   // #1875 워크스페이스별 · 이 기기의 기억 — 새로고침마다 20~50건을 다시 받지 않게(같은 lastSeen 이면 그대로)
const KEEP = 200;
const LIMIT = 4;
const MAX = 56;

const RETRY_MS = 10 * 60 * 1000;   // **못 읽는**(hold) 세션은 10분 뒤에나 다시 묻는다(권한 없는 남의 세션·기록 없는 옛 세션이 매 폴링마다 3~6 요청을 만들지 않게)
// hold = 로그를 **아예 못 읽었다**(권한·좌표) — RETRY_MS 동안 다시 묻지 않는다. '읽었는데 이번 창엔 없다'는 hold 가 아니다(아래 one).
const cache = new Map<string, { seen: number; text: string | null; at: number; hold?: boolean }>();
try { const v = JSON.parse(localStorage.getItem(STORE) || '{}'); for (const [k, e] of Object.entries<any>(v)) if (e && typeof e.seen === 'number') cache.set(k, { seen: e.seen, text: typeof e.text === 'string' ? e.text : null, at: Number(e.at || 0), hold: !!e.hold }); } catch (_) { /* 기억이 없으면 새로 받는다 */ }
function persist(): void {
  try {
    const ents = [...cache.entries()].sort((a, b) => b[1].seen - a[1].seen).slice(0, KEEP);
    localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(ents)));
  } catch (_) { /* 이번 화면은 된다 */ }
}
const queue: Sess[] = [];
const queued = new Set<string>();
let running = 0;
let ready: (() => void) | null = null;
let tick: number | null = null;

function notify(): void {
  if (tick) return;
  tick = window.setTimeout(() => { tick = null; ready?.(); }, 180);
}
/** 새 글이 도착했을 때 부를 것 — 사이드바가 **목록만** 다시 그린다(검색칸은 살아 있는 IME 조합). */
export function watchLastAsk(cb: () => void): void { ready = cb; }

/** 이 세션에 내가 마지막으로 시킨 말(짧게). 아직 모르면 null 을 주고 뒤에서 찾아 onReady 로 알린다. */
export function lastAsk(s: Sess): string | null {
  // #2197 — 서버 칸이 먼저다: 훅이 프롬프트를 친 **그 순간** 보고한 값(목록 API lastPrompt). 있으면 꼬리 조회를 아예 안 한다
  //  (행마다 48~240KB 를 받던 비용이 0, 노드 세션도 턴이 끝나기 전에 바뀐다). 없는 세션(옛 훅·코덱스·기록 세션)만 아래 폴백.
  const served = s.raw && typeof s.raw.lastPrompt === 'string' ? shorten(s.raw.lastPrompt) : '';
  if (served) return served;
  const hit = cache.get(s.id);
  const seen = Number(s.lastSeen || 0);
  if (hit && (hit.seen === seen || (hit.hold && Date.now() - hit.at < RETRY_MS))) return hit.text;
  if (!queued.has(s.id)) { queued.add(s.id); queue.push(s); pump(); }
  return hit ? hit.text : null;
}

function pump(): void {
  while (running < LIMIT && queue.length) {
    const s = queue.shift() as Sess;
    running += 1;
    void one(s).finally(() => { running -= 1; queued.delete(s.id); pump(); });
  }
}
async function one(s: Sess): Promise<void> {
  let r = await fetchLastAsk(s, TAIL);
  if (!r.text && r.ok) r = await fetchLastAsk(s, TAIL_FAR);   // 읽히긴 했는데 내 말이 안 보였다 — 더 멀리. 아예 못 읽었으면(권한·좌표) 그만.
  const prev = cache.get(s.id);
  //  ★ 빈손이면 **옛 글을 지킨다**(원준 2026-08-27 "실시간 반영이 안 된다" 조사) — 도구 출력이 긴 턴의 한중간엔
  //   내 말이 꼬리 240KB 밖에 있어 '읽었는데 없음'이 정상으로 나온다. 종전엔 그 null 로 캐시를 덮고 10분 홀드까지
  //   걸어, 잘 서 있던 줄이 턴 중간에 사라진 채 새 말도 10분간 안 물어봤다. 홀드는 '못 읽는' 세션만(hold).
  const text = r.text ? shorten(r.text) : prev ? prev.text : null;
  cache.set(s.id, { seen: Number(s.lastSeen || 0), text, at: Date.now(), hold: !r.ok });
  persist();
  if (!prev || prev.text !== text) notify();
}
/** 한 줄로 — 앞머리의 마크다운 기호·인용 부호를 걷고 MAX 자에서 자른다. */
function shorten(t: string): string {
  const x = t.replace(/\s+/g, ' ').replace(/^[\s>*#\-•·"'“]+/, '').trim();
  return x.length > MAX ? x.slice(0, MAX - 1).trimEnd() + '…' : x;
}

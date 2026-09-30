// v2/trash-counts.ts — 사이드바 「휴지통 N」의 나머지 절반(#3778): 자료·지식·옛 길로 지운 프로젝트의 개수.
//  사이드바는 세션·프로젝트 목록만 들고 있어 그 둘만 셌다 — 지식 43건이 든 휴지통이 «0» 으로 보였다(원준 2026-09-20 후속).
//  · 개수만 받는 가벼운 길(GET /api/ui/deleted/counts)을 느린 주기로 부른다. 옛 서버(그 길이 없는)에선 조용히 아는 절반만 센다.
//  · 휴지통 화면이 열려 있으면 그 화면이 제 목록으로 센 값을 넣는다(setTrashCounts) — 배지와 탭 숫자가 같은 순간 같은 값이다.
//  잣대(합·세는 법)는 lib/trash-tabs.ts(순수). 여기는 받아 오기·기억·알림만.
import { api } from '../core.js';
import type { TrashExtraCounts } from '../lib/trash-tabs.js';

const TTL_MS = 120_000;        // 배지 하나에 매 렌더마다 서버를 부르지 않는다
const RETRY_MS = 300_000;      // 실패(옛 서버·일시 오류)는 더 드물게 다시 본다
let val: TrashExtraCounts | null = null;
let at = 0;
let failedAt = 0;
let loading = false;
const subs = new Set<() => void>();
const tell = (): void => { for (const fn of subs) { try { fn(); } catch (_) { /* 구독자 하나가 죽어도 나머지는 그린다 */ } } };

/** 값이 바뀌면 부른다(사이드바 다시 그리기). 같은 함수를 두 번 걸어도 한 번만 불린다. */
export function watchTrashCounts(fn: () => void): void { subs.add(fn); }

/** 지금 아는 값(없으면 null). 낡았으면 뒤에서 새로 받는다 — 부르는 쪽은 기다리지 않는다. */
export function trashExtraCounts(): TrashExtraCounts | null {
  const now = Date.now();
  const stale = !val ? now - failedAt > RETRY_MS : now - at > TTL_MS;
  if (stale && !loading) {
    loading = true;
    void api('/api/ui/deleted/counts')
      .then((d: any) => {
        const num = (v: unknown): number => Math.max(0, Math.floor(Number(v)) || 0);
        const next = { knowledge: num(d?.knowledge), project: num(d?.project), source: num(d?.source), files: num(d?.files) };
        const changed = !val || val.knowledge !== next.knowledge || val.project !== next.project || val.source !== next.source || val.files !== next.files;
        val = next; at = Date.now(); failedAt = 0;
        if (changed) tell();
      })
      .catch(() => { failedAt = Date.now(); })
      .finally(() => { loading = false; });
  }
  return val;
}

/** 휴지통 화면이 제 목록으로 센 값 — 서버 개수보다 이게 먼저다(같은 화면의 두 숫자가 어긋나지 않게). */
export function setTrashCounts(c: TrashExtraCounts): void {
  const changed = !val || val.knowledge !== c.knowledge || val.project !== c.project || val.source !== c.source || val.files !== c.files;
  val = { ...c }; at = Date.now(); failedAt = 0;
  if (changed) tell();
}

/** 무언가 지웠거나 되살렸다 — 다음 렌더에서 새로 받는다(지금 값은 그때까지 그대로 보인다). */
export function invalidateTrashCounts(): void { at = 0; failedAt = 0; }

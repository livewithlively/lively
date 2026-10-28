// v2/review-resume.ts — 앱빌더 ③ 의 실제 화면(시험 세션 · 앱 화면)을 보던 중 **새로고침해도 그 화면과 코멘트 막대로 돌아온다**
//  (#4632 원준 2026-10-16 «앱 전체 화면에서 보고 있는데 새로고침하니까 밑에 떠 있는 창 사라짐»).
//
//  막대(app-review.ts)는 앱빌더 창이 세운다 — 앱 화면(#/i/…)으로 새로고침하면 앱빌더가 없어 막대도 없다. 그래서 어느 화면을 보던 중인지
//   이 브라우저에 적어 두고(앱빌더가 열 때 적고 · 앱빌더로 돌아오거나 다른 데로 가면 지운다), 새로 뜰 때 그 주소면 앱빌더로 돌려보내
//   앱빌더가 같은 화면을 다시 연다. 오래된 표시(12시간)는 믿지 않는다. 의존 없는 작은 모듈 — 셸(main.ts)과 앱빌더가 같이 쓴다.
import { builderSeeRoute } from '../lib/builder-flow.js';

const KEY = 'lively_v2_review_open';
const MAX_AGE = 12 * 3600 * 1000;
export interface ReviewOpenMark { sid: string; appId: string; view: 'widget' | 'app'; route: string; at: number }

export function markReviewOpen(m: Omit<ReviewOpenMark, 'at'> | null): void {
  try { if (m) localStorage.setItem(KEY, JSON.stringify({ ...m, at: Date.now() })); else localStorage.removeItem(KEY); } catch (_) { /* 이번 화면은 된다 */ }
}
export function readReviewOpen(): ReviewOpenMark | null {
  try {
    const m = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!m || typeof m.sid !== 'string' || typeof m.appId !== 'string' || (m.view !== 'widget' && m.view !== 'app') || typeof m.route !== 'string') return null;
    if (!(Number(m.at) > 0) || Date.now() - Number(m.at) > MAX_AGE) return null;
    return m as ReviewOpenMark;
  } catch (_) { return null; }
}
/** 새로 뜬 이 주소가 보던 앱 화면이면 — 돌아갈 앱빌더 주소(거기서 같은 화면을 다시 연다). 아니면 null.
 *  «실제 화면을 보는 중» 주소로 보낸다(lib/builder-flow builderSeeRoute) — 다시 여는 몇 초 동안에도 앱빌더 사이드바가 서지 않게(#4632 원준 2026-10-19). */
export function reviewResumeTarget(hash: string): string | null {
  const m = readReviewOpen();
  if (!m || m.view !== 'app' || !hash || hash !== m.route) return null;
  return builderSeeRoute(m.sid, 'app');
}

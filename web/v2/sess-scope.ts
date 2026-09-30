// v2/sess-scope.ts — [AI 세션] 사이드바에서 고른 것(묶기 기준 · 카드 · 줄)의 한 자리(#4233 2안, 원준 2026-09-25 «2안이 좋아»).
//  사이드바(side.ts renderSessions)가 쓰고, 가운데 목록(bins.ts renderSessAll)이 읽는다. 둘이 따로 들면 사이드바 카드와
//  본문 묶음이 다른 기준을 말하게 된다 — 그래서 값은 여기 한 벌뿐이다. 판정(바꾸기 · 풀기 · 본문 기준)은 lib/sess-all.ts 의 순수 함수.
//  기억하지 않는다(페이지 수명) — 종전 sessProj 와 같은 규칙(#4158: 새로 열면 늘 전체).
import { SESS_SCOPE0, type SessGroupBy, type SessScope } from '../lib/sess-all.js';
import { SESS_STATES } from '../session-status.js';
import type { V2Data } from './views.js';

let cur: SessScope = { ...SESS_SCOPE0 };

export function sessScope(): SessScope { return cur; }
export function setSessScope(next: SessScope): void { cur = next; }

/** 묶음 key 를 사람이 읽는 이름으로 — 사이드바 카드 머리와 본문 빵부스러기 · 묶음 머리가 같은 말을 쓴다. */
export function sessGroupName(by: SessGroupBy, key: string, data: V2Data, ownerLabel: (k: string) => string): string {
  if (by === 'day') return key;
  if (by === 'list') return key === '0' ? '리스트 없음' : ((data.lists || []).find((l) => String(l.id) === key)?.name || `리스트 #${key}`);
  if (by === 'project') return key === '0' ? '프로젝트 없음' : (data.projects.find((p) => String(p.id) === key)?.name || `#${key}`);
  if (by === 'owner') return ownerLabel(key);
  if (by === 'state') return SESS_STATES[key] ? SESS_STATES[key].label : key === 'log' ? '기록' : '지난 세션';
  return '전체';
}

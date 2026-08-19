// 방금 만든 세션 한 장(#1541) — 생성 응답(SessionInfo)을 라우트가 받아 첫 그림에 쓴다.
//
// 왜: 노드(멤버 PC) 세션은 생성 직후 게이트웨이 목록(nodeSessionsFor)에 **한 박자 늦게** 나타난다(에이전트가
//  state 를 밀어야 잡힘) — 그 사이 #/s/<id> 라우트가 목록만 보면 "세션을 찾을 수 없어요"가 뜬다(실측: 윈도우
//  노드, 새로고침하면 해결). 생성한 쪽이 이미 세션 전문을 들고 있으니 버리지 말고 넘긴다.
// 규약: 한 번 꺼내면 지운다(일회용 — 이후 진실은 목록 폴링이 소유). main.ts(라우트)가 소비, quick-session 등 생성처가 기록.
'use strict';

const made = new Map<string, unknown>();

export function rememberCreated(s: unknown): void {
  const id = s && typeof s === 'object' && (s as { id?: unknown }).id ? String((s as { id: unknown }).id) : '';
  if (id) made.set(id, s);
}

export function takeCreated(id: string): unknown | null {
  const v = made.get(id);
  if (v !== undefined) made.delete(id);
  return v ?? null;
}

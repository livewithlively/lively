// 작업 도크의 **순수 로직** (#2439 ③) — DOM·네트워크 의존 없음.
//
//  ── 왜 갈라 두나 ────────────────────────────────────────────────────────────────
//  화면 코드(session-tasks.ts)는 `core.js` 를 타고 브라우저 전역(localStorage 등)에 닿아 node 에서
//  로드조차 안 된다. 그러면 «무엇을 접고 무엇을 남기나» 같은 **판단**을 값으로 지킬 수 없다.
//  이 레포가 sess-face 를 같은 이유로 갈라 둔 것과 같은 규율이다.
//
//  ── 여기 있는 판단이 왜 중요한가 ────────────────────────────────────────────────
//  서버는 끝난 작업을 **안 지운다**(스냅샷 머지 — 지우면 방금 끝난 것의 제목·종류를 잃고 뒤이은
//  델타가 유령 행을 만든다, 2026-08-31 실측). 그래서 «언제 접나» 가 화면 몫이 됐다.
//  이 규칙이 틀리면 목록이 무한히 자라거나, 결과를 볼 틈 없이 사라진다.

/** 서버 어휘(harness-io/session-event.ts)의 화면 쪽 그림자 — **필드를 늘릴 때 서버와 함께 늘린다.** */
export interface TaskInfo {
  id: string;
  kind: 'shell' | 'agent' | 'other';
  title: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  toolUseId?: string;
  agentType?: string;
  depth?: number;
  outputRef?: string;
  summary?: string;
  startedAt?: number;
  endedAt?: number;
}

/** 끝난 작업을 화면에 남겨 두는 시간 — 결과를 볼 틈은 주되 목록이 무한히 자라지 않게. */
export const DONE_LINGER_MS = 60_000;

/**
 * 지금 보여줄 작업들.
 *  ⚠ 판정은 **끝난 시각**으로 한다 — 시작 시각으로 하면 한 시간째 도는 작업이 «오래됐다» 고 접힌다.
 */
export function visibleTasks(tasks: readonly TaskInfo[], now: number): TaskInfo[] {
  return tasks.filter((t) => t.status === 'running' || !t.endedAt || now - t.endedAt < DONE_LINGER_MS);
}

/** 도크 머리줄 — **도는 것**을 센다(끝난 것을 세면 사람이 진행 중으로 오해한다). */
export function dockHead(shown: readonly TaskInfo[]): string {
  const running = shown.filter((t) => t.status === 'running').length;
  return running ? `작업 ${running}개 도는 중` : '방금 끝난 작업';
}

/** 경과 시간 — 도는 중이면 지금까지, 끝났으면 **걸린 시간**. 시작을 모르면 아무 말도 안 한다. */
export function elapsed(t: TaskInfo, now: number): string {
  const from = t.startedAt;
  if (!from) return '';
  const to = t.endedAt || now;
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}분 ${s % 60}초` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

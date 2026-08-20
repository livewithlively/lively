// AI 세션 상태 어휘 — **두 화면(AI 세션 탭 · 대시보드)이 공유하는 단일 정의** (#1059 감사 P1).
//
// 왜 한 벌로 뽑았나: 감사(ai-session-status-vocabulary-audit-1059) 결과 같은 세션이 두 화면에서 다르게 보였다 —
//  '작업 중'/'작업중' 띄어쓰기, idle 색 위계(탭=민트 밝음 vs 대시=회색), 정렬 우선순위, 필터 항목 수, 그리고
//  #1098 이 만든 '작업 완료'가 **대시보드에만** 있었다(가장 행동을 요하는 상태가 세션 전용 화면엔 안 뜸).
//  정의가 두 곳에 있으면 반드시 갈라진다 — 그래서 라벨·색·순위·필터를 여기 한 곳에 둔다.
//
// ⚠ DOM 을 쓰지 않는다(순수 모듈) — 그래야 테스트가 컴파일 결과를 그냥 import 해서 판정 표를 고정할 수 있다.
// 표시 문구 · CSS 클래스 · 정렬 우선순위(작을수록 먼저) · 필터 설명.
//  '지금 볼 것 먼저' 정렬은 rank 순 — 확인 필요 → 작업 완료 → 작업 중 → 대기 중 → … → 끝난 것들.
export const SESS_STATES = {
    waiting: { label: '확인 필요', cls: 'waiting', rank: 0, hint: '내 승인·선택을 기다리는 세션 — 가장 먼저 볼 것' },
    done: { label: '작업 완료', cls: 'done', rank: 1, hint: '시킨 작업이 끝났는데 아직 안 본 세션(들어가 보면 해제)' },
    busy: { label: '작업 중', cls: 'busy', rank: 2, hint: '지금 돌고 있는 세션' },
    idle: { label: '대기 중', cls: 'idle', rank: 3, hint: '탭에 열려 있고 안 바쁜 세션' },
    offline: { label: '오프라인', cls: 'offline', rank: 4, hint: '어느 탭에도 안 열려 있음(또는 노드 미연결) — 프로세스는 대개 살아 있다' },
    // '셸' — 지금 셸 프롬프트가 떠 있는 세션. 백엔드는 두 사실을 구분해 주지만(shell=처음부터 AI 없음,
    //  exited=claude 가 끝나 셸만 남음) **사용자 눈에는 둘 다 '셸이 떠 있는 세션'이라 한 칸으로 합친다**
    //  (상민님 결정 2026-07-28). claude 세션이었는지는 카드의 하네스 배지가 이미 말해준다.
    shell: { label: '셸', cls: 'shell', rank: 5, hint: '지금 셸이 떠 있는 세션 — 살아 있다(AI 없이 쓰는 세션, 또는 AI 가 끝난 세션)' },
    restorable: { label: '중단됨', cls: 'restorable', rank: 6, hint: '재부팅·자동회수로 끊긴 세션 — 열면 대화를 이어받아 그대로 계속된다' },
    // #1251 — 재부팅·자동회수('중단됨')와 **다른 사실**이다: 메모리가 모자라 OS 보호장치가 강제로 끝냈다.
    //  이걸 구분해 주지 않으면 사용자는 자기 세션이 왜 사라졌는지 모른 채 원인을 엉뚱한 데서 찾는다.
    oom_killed: { label: '메모리 부족', cls: 'oom-killed', rank: 7, hint: '메모리가 모자라 OS 보호장치가 강제 종료한 세션 — 대화는 보존돼 있어 열면 이어진다' },
    exited_user: { label: '종료됨', cls: 'exited-user', rank: 8, hint: '내가 직접 종료(exit)한 세션 — 그때 대화를 이어서 다시 열 수 있다' },
};
// 필터 항목 = 카드 라벨과 **같은 순서·같은 이름**. 종전엔 카드가 '종료됨'인데 필터엔 그 칸이 없어
//  '복원 가능'으로 잡히는 어긋남이 있었다(감사 P1-②). 이제 key 가 곧 필터 버킷이다.
export const SESS_STATE_KEYS = ['waiting', 'done', 'busy', 'idle', 'offline', 'shell', 'restorable', 'oom_killed', 'exited_user'];
// '시킨 작업이 끝났는데 아직 안 봤나'(#1098) — lastAttached(열람)는 탭을 붙일 때 갱신되므로 들어가 보면 자동 해제된다.
//  24시간 가드: 하루 지난 건 알림이 아니라 이력이다.
export function isUnreadDone(s, nowMs = Date.now()) {
    const last = Number(s?.lastActive) || 0;
    if (!last || s?.restorable)
        return false;
    if (last <= (Number(s?.lastAttached) || 0))
        return false;
    return (nowMs / 1000 - last) <= 24 * 3600;
}
// 한 세션의 상태 key. **먼저 걸리는 것이 이긴다** — 위쪽이 더 구체적인 사실이다.
export function sessStateKey(s, nowMs = Date.now()) {
    if (!s)
        return 'shell';
    // 복원 가능(#1059 E): tmux 에 없고 desired-state 만 남은 세션. 내가 끝낸 것과 중단된 것을 **다른 key** 로 가른다
    //  (종전엔 라벨만 갈라 놓고 필터·정렬은 하나로 묶여 있었다).
    //  ⚠ 우선순위: 사용자 종료 > OOM > 그 밖(중단됨). 사용자가 /exit 한 것은 **확정 사실**이고 OOM 표시는
    //   관측 기반 추정이라, 둘이 겹치면 확정이 이긴다(백엔드도 같은 규칙 — exited_at 이 있으면 oomKilled 를 안 준다).
    if (s.restorable)
        return s.exitedByUser ? 'exited_user' : s.oomKilled ? 'oom_killed' : 'restorable';
    const k = s.agentState || 'shell';
    // 셸 세션과 'AI 가 끝나 셸만 남은' 세션을 한 칸('셸')으로 — 둘 다 살아 있고, 사용자가 할 일도 같다(들어가서 쓴다).
    //  종전엔 후자를 '종료됨'이라 불러 **살아 있는 세션이 죽은 것처럼** 보였다(감사 P1-①: 고객사 A '종료됨' 3건이 전부 셸).
    if (k === 'shell' || k === 'exited')
        return 'shell';
    if ((k === 'idle' || k === 'offline') && isUnreadDone(s, nowMs))
        return 'done';
    return SESS_STATES[k] ? k : 'shell';
}
export function sessLabel(s, nowMs) {
    return (SESS_STATES[sessStateKey(s, nowMs)] || SESS_STATES.shell).label;
}
export function sessRank(s, nowMs) {
    return (SESS_STATES[sessStateKey(s, nowMs)] || SESS_STATES.shell).rank;
}
// 'AI 가 더 안 도는' 세션인가 — 일괄 종료 대상·'끝남' 뷰 판정.
//  ⚠ offline 은 제외한다(아무도 안 보는 중일 뿐 프로세스는 살아 있다). shell 도 제외 — 살아 있는 정상 세션이다.
//   종전에 대시보드는 offline 을 여기 포함했고 AI 세션 탭은 제외해, 같은 버튼이 화면마다 다른 집합을 잡았다(감사 P1-③).
export function sessIsDead(s, nowMs) {
    const k = sessStateKey(s, nowMs);
    // 셸이 떠 있는 세션은 '끝남'이 아니다 — 들어가서 계속 쓸 수 있다. 진짜 끝난 것은 tmux 에서 사라진 것들뿐.
    //  ⚠ oom_killed 도 여기 든다 — #1251 이 '중단됨'에서 갈라 낸 **같은 사실의 하위 갈래**(restorable=true, tmux 에 없음)인데
    //   이 목록에서 빠져 있어 메모리로 죽은 세션이 화면마다 '살아 있는 것'으로 세어졌다(v2 사이드바는 그걸 라이브 행으로
    //   그려 터미널까지 붙였다 — 없는 tmux 라 4410). 세 key 는 전부 '박스가 없다' 는 한 사실이다.
    return k === 'restorable' || k === 'exited_user' || k === 'oom_killed';
}
/** 되살릴 수 있는(=박스가 없어 지금은 안 도는) 세션인가 — 화면들이 '지난 세션' 묶음을 만들 때 쓰는 같은 술어. */
export const SESS_DEAD_KEYS = ['restorable', 'oom_killed', 'exited_user'];
/**
 * 이 세션을 **열자마자 되살릴** 대상인가 (#1820).
 *
 * 세션을 여는 것은 "이걸 쓰겠다"는 의사표시다 — 박스가 없어졌을 뿐 되살릴 좌표(desired-state)가 남아 있고
 *  내가 그 주인이면, 화면에 도착한 그 자리에서 되살린다. 종전엔 [이어서 대화하기]를 한 번 더 눌러야 했다.
 *
 * ⚠ '기록만 남은 세션'(restorable=false, 중앙 기록만)은 **자동으로 하지 않는다.** 되살릴 박스 좌표가 없어
 *  이어받기는 곧 '새 세션 만들기'인데, 지난 대화를 읽으러 들어온 사람에게 세션을 하나 띄우는 건 과하다.
 *  그건 버튼으로 남긴다(사용자가 뜻을 밝힌 뒤에).
 */
export function shouldRestoreOnOpen(s) {
    return !!s && !!s.restorable && !!s.owned;
}

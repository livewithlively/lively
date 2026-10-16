// AI 세션 상태 어휘 — **두 화면(AI 세션 탭 · 대시보드)이 공유하는 단일 정의** (#1059 감사 P1).
//
// 왜 한 벌로 뽑았나: 감사(ai-session-status-vocabulary-audit-1059) 결과 같은 세션이 두 화면에서 다르게 보였다 —
//  '작업 중'/'작업중' 띄어쓰기, idle 색 위계(탭=민트 밝음 vs 대시=회색), 정렬 우선순위, 필터 항목 수, 그리고
//  #1098 이 만든 '작업 완료'가 **대시보드에만** 있었다(가장 행동을 요하는 상태가 세션 전용 화면엔 안 뜸).
//  정의가 두 곳에 있으면 반드시 갈라진다 — 그래서 라벨·색·순위·필터를 여기 한 곳에 둔다.
//
// ⚠ DOM 을 쓰지 않는다(순수 모듈) — 그래야 테스트가 컴파일 결과를 그냥 import 해서 판정 표를 고정할 수 있다.

export interface SessLike {
  agentState?: string; restorable?: boolean; exitedByUser?: boolean; oomKilled?: boolean; harness?: string;
  lastActive?: number; lastAttached?: number; lastViewed?: number; attached?: boolean;
  // #1221 — **접속과 무관한** 실행 신호(하네스 훅 보고 ∪ 관측). agentState 는 탭이 없으면 offline 으로 덮이지만
  //  이 둘은 안 덮인다. 아래 sessStateKey 가 이 사실을 접속 기반 판정보다 먼저 본다(#1819 신고).
  working?: boolean; awaiting?: boolean;
  /** #4502 — 턴은 끝났지만 백그라운드 작업이 남아 AI 가 스스로 이어 갈 세션(서버 SessionInfo.background). 점은 «작업 중» 이다. */
  background?: boolean;
  /**
   * **이 행이 관측된 값인가**(서버 `SessionInfo.observed`, #2544). false = 게이트웨이가 tmux 를 «못 본» 틱에
   *  DB desired 행으로 지어 낸 행이다 — 관측 필드(attached·agentState·열람 시각)는 **채워져 있어도 사실이 아니다**.
   *  관측된 행에는 이 필드가 없다(undefined = 종전 그대로).
   */
  observed?: boolean;
  /** #4783 — 이 판이 **왜 끝났나**(서버 SessionInfo.endNote — src/sessions/session-end.ts). 복원 가능 행에만 실린다. */
  endNote?: { why?: string; at?: number; code?: number; seen?: boolean } | null;
  /** #4695 T5 — 하네스 종료 규칙이 끄며 남긴 쪽지(사유만 읽는다 — 본문은 대화창 몫). 복원 가능 행에만 실린다. */
  stopNote?: { why?: string; at?: number } | null;
}

// 표시 문구 · CSS 클래스 · 정렬 우선순위(작을수록 먼저) · 필터 설명.
//  '지금 볼 것 먼저' 정렬은 rank 순 — 확인 필요 → 작업 완료 → 작업 중 → 대기 중 → … → 끝난 것들.
export const SESS_STATES: Record<string, { label: string; cls: string; rank: number; hint: string }> = {
  waiting:     { label: '확인 필요', cls: 'waiting',    rank: 0, hint: '내 승인·선택을 기다리는 세션 — 가장 먼저 볼 것' },
  done:        { label: '작업 완료', cls: 'done',       rank: 1, hint: '시킨 작업이 끝났는데 아직 안 본 세션(들어가 보면 해제)' },
  busy:        { label: '작업 중',   cls: 'busy',       rank: 2, hint: '지금 돌고 있는 세션' },
  idle:        { label: '대기 중',   cls: 'idle',       rank: 3, hint: '탭에 열려 있고 안 바쁜 세션' },
  offline:     { label: '오프라인',  cls: 'offline',    rank: 4, hint: '어느 탭에도 안 열려 있음(또는 노드 미연결) — 프로세스는 대개 살아 있다' },
  // '셸' — 지금 셸 프롬프트가 떠 있는 세션. 백엔드는 두 사실을 구분해 주지만(shell=처음부터 AI 없음,
  //  exited=claude 가 끝나 셸만 남음) **사용자 눈에는 둘 다 '셸이 떠 있는 세션'이라 한 칸으로 합친다**
  //  (상민님 결정 2026-07-28). claude 세션이었는지는 카드의 하네스 배지가 이미 말해준다.
  shell:       { label: '셸',        cls: 'shell',      rank: 5, hint: '지금 셸이 떠 있는 세션 — 살아 있다(AI 없이 쓰는 세션, 또는 AI 가 끝난 세션)' },
  restorable:  { label: '중단됨',    cls: 'restorable', rank: 6, hint: '재부팅·자동회수로 끊긴 세션 — 열면 대화를 이어받아 그대로 계속된다' },
  // #1251 — 재부팅·자동회수('중단됨')와 **다른 사실**이다: 메모리가 모자라 OS 보호장치가 강제로 끝냈다.
  //  이걸 구분해 주지 않으면 사용자는 자기 세션이 왜 사라졌는지 모른 채 원인을 엉뚱한 데서 찾는다.
  oom_killed:  { label: '메모리 부족', cls: 'oom-killed',  rank: 7, hint: '메모리가 모자라 OS 보호장치가 강제 종료한 세션 — 대화는 보존돼 있어 열면 이어진다' },
  exited_user: { label: '종료됨',    cls: 'exited-user',rank: 8, hint: '내가 직접 종료(exit)한 세션 — 그때 대화를 이어서 다시 열 수 있다' },
  //  #4783 — **목록 줄의 표시 전용**이다(sessStateKey 는 이 값을 내지 않는다 — 생사·필터 어휘는 위 아홉 칸 그대로).
  //   하네스가 비정상적으로 끝났거나(크래시·기동 실패) 세션이 돌던 곳이 고장 나 사라진 세션 — 사람이 들여다봐야 한다.
  error:       { label: '오류',      cls: 'error',      rank: 0, hint: '비정상적으로 끝난 세션 — 열어서 무슨 일이 있었는지 보고, 말을 걸면 이어서 열린다' },
};

// 필터 항목 = 카드 라벨과 **같은 순서·같은 이름**. 종전엔 카드가 '종료됨'인데 필터엔 그 칸이 없어
//  '복원 가능'으로 잡히는 어긋남이 있었다(감사 P1-②). 이제 key 가 곧 필터 버킷이다.
export const SESS_STATE_KEYS = ['waiting', 'done', 'busy', 'idle', 'offline', 'shell', 'restorable', 'oom_killed', 'exited_user'] as const;
/**
 * #4783 — **목록 줄에만** 서는 상태(필터 어휘가 아니다). sessStateKey 는 이 값을 내지 않는다 — 꺼진 세션의 겉모습(stoppedDotKey)만 낸다.
 *  필터에 넣으면 아무것도 안 걸리는 죽은 칸이 되므로 SESS_STATE_KEYS 와 따로 둔다. SESS_STATES 는 두 집합의 합이다(라벨·색·순위의 한 자리).
 */
export const ROW_ONLY_STATES = ['error'] as const;

// '시킨 작업이 끝났는데 아직 안 봤나'(#1098) — 마지막 작업이 **마지막 열람보다 뒤**면 아직 안 본 결과다.
//  24시간 가드: 하루 지난 건 알림이 아니라 이력이다.
//
// ⚠ 열람 신호가 **둘**인 이유 (#1954 3차). 원래는 lastAttached(tmux `session_last_attached`) 하나였고, 그때는 그게
//  맞았다 — 세션을 여는 것이 곧 터미널 창을 새로 여는 것이었으니 열 때마다 새 attach 가 찍혔다. 그런데 새 셸이
//  탭 DOM 을 유지하게 되면서(#1719 web/v2/tabs.ts) 세션 하나당 attach 가 **탭 수명당 한 번**이 됐다:
//  이미 열어 둔 세션을 사이드바에서 다시 눌러도 attach 가 없어 열람 시각이 처음 연 순간에 얼어붙고,
//  그 뒤로는 작업이 끝날 때마다 초록점이 켜진 채 **누르든 말든 안 꺼졌다**(실측 2026-08-26: 붙어 있는 세션 5개의
//  last_attached 가 last_busy 보다 300~440초 뒤처진 채 고정). 그래서 화면이 직접 찍는 lastViewed(`@box_last_seen`)를
//  더하고 **둘 중 더 나중 것**을 열람으로 본다. lastAttached 를 버리지 않는 이유: 단독 터미널 창·구 노드처럼
//  화면이 도장을 못 찍는 경로가 아직 있고, 거기서는 그게 유일하게 맞는 신호다.
export function lastViewedAt(s: SessLike): number {
  return Math.max(Number(s?.lastAttached) || 0, Number(s?.lastViewed) || 0);
}
/**
 * ⚠ **관측 못 한 행은 절대 '작업 완료'가 아니다**(#2544 후속, 상민님 신고 2026-09-10).
 *
 * 중계가 끊긴 틱의 폴백 행(`observed:false`)은 열람 시각(`lastAttached`·`lastViewed`)을 **아예 안 싣는다**
 *  — 그건 tmux 만 아는 값이라 DB 에 없기 때문이다. 그런데 이 판정은 «마지막 작업 > 마지막 열람» 이고
 *  없는 열람은 0 이라, 그 한 틱에 **최근 24시간 안에 작업한 세션이 전부 초록 '작업 완료'로** 승격됐다
 *  (같은 행이 `restorable` 도 안 실어 살아 있는 것으로 그려져 날짜 컷까지 우회했다 — 내가 `/exit` 로
 *  죽인 세션까지 «작업 완료» 로 목록에 되살아났다). «모른다» 를 «끝났다» 로 말한 자리다.
 */
export function isUnreadDone(s: SessLike, nowMs: number = Date.now()): boolean {
  if (s?.observed === false) return false;
  const last = Number(s?.lastActive) || 0;
  if (!last || s?.restorable) return false;
  if (last <= lastViewedAt(s)) return false;
  return (nowMs / 1000 - last) <= 24 * 3600;
}

// 한 세션의 상태 key. **먼저 걸리는 것이 이긴다** — 위쪽이 더 구체적인 사실이다.
export function sessStateKey(s: SessLike, nowMs: number = Date.now()): string {
  if (!s) return 'shell';
  // 복원 가능(#1059 E): tmux 에 없고 desired-state 만 남은 세션. 내가 끝낸 것과 중단된 것을 **다른 key** 로 가른다
  //  (종전엔 라벨만 갈라 놓고 필터·정렬은 하나로 묶여 있었다).
  //  ⚠ 우선순위: 사용자 종료 > OOM > 그 밖(중단됨). 사용자가 /exit 한 것은 **확정 사실**이고 OOM 표시는
  //   관측 기반 추정이라, 둘이 겹치면 확정이 이긴다(백엔드도 같은 규칙 — exited_at 이 있으면 oomKilled 를 안 준다).
  if (s.restorable) return s.exitedByUser ? 'exited_user' : s.oomKilled ? 'oom_killed' : 'restorable';
  const k = s.agentState || 'shell';
  // 셸 세션과 'AI 가 끝나 셸만 남은' 세션을 한 칸('셸')으로 — 둘 다 살아 있고, 사용자가 할 일도 같다(들어가서 쓴다).
  //  종전엔 후자를 '종료됨'이라 불러 **살아 있는 세션이 죽은 것처럼** 보였다(감사 P1-①: 고객사 A '종료됨' 3건이 전부 셸).
  if (k === 'shell' || k === 'exited') return 'shell';
  // ★ 지금 돌고 있다/기다린다는 **사실**이 접속 기반 판정을 이긴다 (#1819 원준 신고 2026-08-21).
  //  왜 필요한가: agentState 는 '그 세션 화면을 지금 누가 보고 있나'(attached)로 offline 이 덮어쓴다. 그래서
  //  25분째 도는 세션도 탭을 안 보고 있으면 offline 이 되고, 그 offline 이 바로 아래 '작업 완료' 승격에 걸려
  //  **돌고 있는 세션이 초록 '작업 완료'로** 떴다(실측: @box_state=busy 가 8초 전 갱신된 세션이 그러했다).
  //  '완료'는 사람이 결과를 보러 들어가게 만드는 문구다 — 아직 안 끝난 일에 그 말을 붙이면 그건 오보다.
  //  서버는 이 두 신호를 접속과 무관하게 이미 내려준다(#1221 working/awaiting) — 화면이 안 보고 있었을 뿐이다.
  //  ⚠ 위 세 갈래(셸·AI 종료·복원 가능) 뒤에 둔다: 셸 세션의 working 은 AI 작업이 아니고(shellWorking),
  //   박스가 없어진 세션은 옛 신호로 되살아나면 안 된다.
  if (s.awaiting) return 'waiting';
  //  #4502 — 턴을 끝내고 백그라운드 작업(«… · 1 shell still running»)을 기다리는 세션도 사람 눈엔 안 끝난 일이다(원준 신고
  //   2026-09-30: «아직 분명히 안 끝났는데 파란 점이 안 깜빡여»). 서버는 이걸 working 과 따로 싣는다 — working 은 «턴이 돈다» 로
  //   읽는 자리(대화창·리브 2턴·회수)가 있어서다. 점은 둘 다 «작업 중» 이다.
  if (s.working || s.background) return 'busy';
  if ((k === 'idle' || k === 'offline') && isUnreadDone(s, nowMs)) return 'done';
  return SESS_STATES[k] ? k : 'shell';
}

export function sessLabel(s: SessLike, nowMs?: number): string {
  return (SESS_STATES[sessStateKey(s, nowMs)] || SESS_STATES.shell).label;
}
export function sessRank(s: SessLike, nowMs?: number): number {
  return (SESS_STATES[sessStateKey(s, nowMs)] || SESS_STATES.shell).rank;
}

// 'AI 가 더 안 도는' 세션인가 — 일괄 종료 대상·'끝남' 뷰 판정.
//  ⚠ offline 은 제외한다(아무도 안 보는 중일 뿐 프로세스는 살아 있다). shell 도 제외 — 살아 있는 정상 세션이다.
//   종전에 대시보드는 offline 을 여기 포함했고 AI 세션 탭은 제외해, 같은 버튼이 화면마다 다른 집합을 잡았다(감사 P1-③).
export function sessIsDead(s: SessLike, nowMs?: number): boolean {
  const k = sessStateKey(s, nowMs);
  // 셸이 떠 있는 세션은 '끝남'이 아니다 — 들어가서 계속 쓸 수 있다. 진짜 끝난 것은 tmux 에서 사라진 것들뿐.
  //  ⚠ oom_killed 도 여기 든다 — #1251 이 '중단됨'에서 갈라 낸 **같은 사실의 하위 갈래**(restorable=true, tmux 에 없음)인데
  //   이 목록에서 빠져 있어 메모리로 죽은 세션이 화면마다 '살아 있는 것'으로 세어졌다(v2 사이드바는 그걸 라이브 행으로
  //   그려 터미널까지 붙였다 — 없는 tmux 라 4410). 세 key 는 전부 '박스가 없다' 는 한 사실이다.
  return k === 'restorable' || k === 'exited_user' || k === 'oom_killed';
}

/** 되살릴 수 있는(=박스가 없어 지금은 안 도는) 세션인가 — 화면들이 '지난 세션' 묶음을 만들 때 쓰는 같은 술어. */
export const SESS_DEAD_KEYS = ['restorable', 'oom_killed', 'exited_user'] as const;

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
//  ⚠ trashed — **휴지통에 있는 세션은 열어도 되살리지 않는다**(#1851, 원준 2026-08-24). 휴지통 행의 제목은 '내용이 뭔지
//  보려고' 누르는 자리인데, 그 클릭이 새 박스로 복원되고(같은 대화 uuid resume) 목록 병합이 휴지통 표식을 그 라이브
//  박스에 접어 "휴지통에 있는데 돌고 있는" 행을 만들었다 — [완전 삭제]가 '아직 돌고 있는 세션'으로 막히는데 휴지통엔
//  ×(멈춤)가 없어 막다른 길이었다. 휴지통 것은 기록 화면으로만 열고, 되살리려면 [되돌리기]를 거친다.
export function shouldRestoreOnOpen(s: { restorable?: boolean; owned?: boolean; trashed?: boolean } | null | undefined): boolean {
  return !!s && !!s.restorable && !!s.owned && !s.trashed;
}


// ── 목록 줄의 점 — 「지금 나를 기다리는 것」 셋만 그린다 (#3778 2판, 원준 2026-09-10) ──────────
//
//  ★ 종전엔 점 하나가 **두 질문**에 동시에 답하려 했다:
//   ⓐ 지금 나에게 뭘 요구하나(확인 필요·작업 중·작업 완료) — 색 채움이 말한다
//   ⓑ 이 세션의 몸이 아직 있나 — 속 빈 고리가 «없어졌다» 를 말한다
//  그런데 **오프라인이 그 빈 고리를 가져다 써서** 살아 있는 세션과 없어진 세션이 같은 표식을 달았다
//  (실측 2026-09-10, 매니지드 서빙 CSS: 둘 다 6px · 채움 없음 · inset 1.5px #5D7197 — 픽셀까지 같다).
//
//  ★ 게다가 그 점은 **거의 모든 줄에 있었다** — 한 계정 284건 중 271건이 오프라인이었다(#2110, 8/26).
//   모든 줄에 있는 표식은 정보가 아니라 배경이고, 그 배경이 하필 「없어졌다」와 같은 모양이라
//   정작 알려야 할 것을 덮었다.
//
//  ⇒ **점은 ⓐ 만 말한다.** ⓑ 는 행의 톤과 오른쪽 시각이 말한다 — 이미 그 일을 하고 있다
//   (트리 `.v2-ss-row.past`, 홈·[AI 세션] `.v2-app-inst--past`). 홈 목록은 처음부터 이 규칙이었고
//   (#1954 PRIORITY_ST), 트리와 [AI 세션]만 옛 어휘를 쓰고 있었다.
//
//  ⚠ **이 규칙은 «글자 없이 점만 서는 목록 줄» 에만 적용된다.** 범례(필터 팝오버)·요약(개수 옆의 점)·
//   상태 글자 옆의 점은 그대로 아홉 가지를 다 쓴다 — 거기선 글자나 숫자가 함께 있어 점이 혼자 뜻을 지지 않는다.
//   「아무도 안 보고 있다(오프라인)」를 골라 보는 길은 그래서 필터에 그대로 남는다.
export const DOT_STATES = ['waiting', 'busy', 'done', 'error'] as const;

/** 이 상태가 목록 줄에서 점으로 떠야 하나 — 곧 «지금 나를 기다리나». #4783 — 꺼진 세션의 «오류» 도 여기 든다. */
export function isDotState(stateKey: string): boolean {
  return stateKey === 'waiting' || stateKey === 'busy' || stateKey === 'done' || stateKey === 'error';
}

/**
 * 목록 줄의 점 색 클래스.
 *  넷이 아니면 `'quiet'` — **자리는 지키되 아무것도 안 그린다.** 요소를 빼 버리면 그 자리만큼
 *  글자가 왼쪽으로 밀려 목록의 기둥이 줄마다 어긋난다(트리 `.v2-ss-row > .v2-dot` 의 margin).
 *  ⚠ #4783 — «오류» 는 «확인 필요»(앰버 채움)와 **모양이 달라야** 한다(같은 색이면 «답할 것» 과 «고장» 이 안 갈린다) — `err`(속이 빈 붉은 고리 + 느낌표).
 */
export function rowDotCls(stateKey: string): string {
  return stateKey === 'waiting' ? 'wait' : stateKey === 'error' ? 'err' : isDotState(stateKey) ? stateKey : 'quiet';
}

// ── #4783 꺼진 세션을 **누가 끝냈나** 로 그린다 ─────────────────────────────────────────────
//
//  상민님(2026-10-16): «회수된 거면 오프라인이 아니라 직전 상태를 보여 주는 게 맞지 않나. 사용자가 직접 종료한 세션이면 오프라인으로
//   해도 되겠지만» · «그 밖은 다 예외적인 오류 케이스 아님? 빨간 점 같은 걸로 오류 표시».
//  #4690 규칙에선 박스가 꺼졌다는 것이 사람에게 보일 사실이 아니다 — 시스템은 일이 끝난 세션을 3분 뒤 끄고, 말을 걸면 같은 주소로 다시 띄운다.
//  그래서 꺼진 세션의 겉모습은 **누가 끝냈나** 가 정한다(사유는 서버가 끝낸 자리에서 적는다 — src/sessions/session-end.ts):
//   · user    — 사람이 끝냈다(/exit · 멈춤 · 휴지통). → 지금처럼 «지난 세션»(흐림·접힘).
//   · system  — 시스템이 껐다(하네스 종료 규칙 · 옛 회수 시계). → 끄기 직전 모습 그대로(답을 기다리던 것은 «확인 필요», 안 본 결과는 «작업 완료»).
//   · error   — 고장으로 끝났다(크래시 · 기동 실패 · 노드·컨테이너 고장 · 메모리 부족). → «오류» 점.
//   · unknown — 사유를 모른다(이 기록 전에 끝난 옛 판 · 멤버 PC 가 꺼짐). → 점 없는 보통 줄(흐리지도 접지도 않는다 — 사람이 끝냈다고 단정하지 않는다).
//  ⚠ 이건 **표시**다. 생사(sessIsDead)·필터 어휘(sessStateKey)는 안 바뀐다 — 그 값으로 터미널을 붙일지 정하는 자리가 있다(views.ts alive).
export type SessEndKind = 'user' | 'system' | 'error' | 'unknown';

/** 꺼진 세션을 누가 끝냈나(순수). 먼저 걸리는 것이 이긴다 — 판마다 새로 적히는 끝난 사유가 먼저, 판을 넘어 남을 수 있는 T5 쪽지가 나중. */
export function sessEndKind(s: SessLike): SessEndKind {
  if (!s) return 'unknown';
  if (s.exitedByUser) return 'user';
  const why = s.endNote && typeof s.endNote.why === 'string' ? s.endNote.why : '';
  if (why === 'stop' || why === 'harness_exit') return 'user';
  if (why === 'harness_crash' || why === 'launch_fail' || why === 'lost') return 'error';
  if (s.oomKilled) return 'error';
  if (why === 'reclaim') return 'system';
  const sw = s.stopNote && typeof s.stopNote.why === 'string' ? s.stopNote.why : '';
  if (sw === 'done' || sw === 'asking') return 'system';
  return 'unknown';
}

/**
 * 꺼진 세션이 목록 줄에 **어떤 점**으로 서나(순수). '' = 점 없음.
 *  · error  → 'error'
 *  · system → 답을 기다리다 꺼졌으면 'waiting' · 안 본 결과가 남은 채 꺼졌으면(서버가 끌 때 잰 seen=false) 24시간 동안 'done'
 *  · user·unknown → '' (지난 세션 — 점은 «지금 벌어지는 일» 의 자리다, #1954 §4)
 */
export function stoppedDotKey(s: SessLike, nowMs: number = Date.now()): '' | 'waiting' | 'done' | 'error' {
  const k = sessEndKind(s);
  //  끝난 지 오래된 것은 «지금 볼 것» 이 아니라 이력이다 — 안 본 결과는 하루(isUnreadDone 과 같은 자), 답할 질문·고장은 이레.
  const at = Number((s.endNote && s.endNote.at) || (s.stopNote && s.stopNote.at) || 0);
  const age = at ? nowMs / 1000 - at : 0;
  if (k === 'error') return !at || age <= 7 * 24 * 3600 ? 'error' : '';
  if (k !== 'system') return '';
  if (s.stopNote && s.stopNote.why === 'asking') return !at || age <= 7 * 24 * 3600 ? 'waiting' : '';
  if (s.endNote && s.endNote.seen === false && at && age <= 24 * 3600) return 'done';
  return '';
}

/** 꺼진 세션을 «지난 세션» 으로 접나(순수) — **사람이 끝냈을 때만**(상민님 2026-10-16). 시스템이 끈 것·고장·사유를 모르는 것은 보통 줄처럼 선다. */
export function stoppedIsPast(s: SessLike): boolean {
  return sessEndKind(s) === 'user';
}

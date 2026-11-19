// 멈춘 세션에 친 첫 말이 무시되던 고장 (#5620, 신고 2026-11-19: «재시동 걸 때 치는 말을 무시해서 두 번 쳐야 해»).
//
//  실측(매니지드 · 멤버 PC 세션): 세션이 멈추면 터미널 액자는 서버에게 곧바로 «없다» 를 듣고 대화창이
//   «직접 끝낸 세션이에요. 아래에 말을 걸면 이어서 열려요» 를 띄운다. 그런데 세션 **목록**은 그 컴퓨터의 다음
//   보고 전까지 약 15초 동안 그 세션을 «살아 있다» 로 낸다(멈춘 시각 +3.0초 → 목록이 «중단» 으로 바뀐 것은 +18.7초).
//   대화창은 그 낡은 행을 받자 액자의 «없다» 를 지우고(#3847 — 행이 살아 있다고 오면 걸쇠를 푼다) 그 세션을
//   살아 있는 것으로 믿었다. 안내를 보고 친 말은 되살리기가 아니라 보통 보내기로 갔고, 서버는 그 말을 멈춘 세션의
//   큐에 넣었다 — 아무도 그 세션을 되살리지 않아 말이 묻혔고, 목록이 따라잡은 뒤에 친 두 번째 말이 비로소 세션을 띄웠다.
//
//  ★ 규칙: 액자가 들은 «없다» 는 그 뒤에 온 목록 행만 뒤집을 수 있다. 목록 행이 언제 만들어졌는지는 모르므로 둘로 가른다.
//   · 목록이 그 사이 한 번이라도 «멈춤» 을 실어 왔으면(따라잡았다) 그 다음의 «살아 있음» 은 진짜 되살아남이다 → 푼다.
//   · 목록이 끝내 따라잡지 않으면 LIST_LAG_MS 가 지난 뒤의 «살아 있음» 은 믿는다 → 푼다(#3847 2026-09-08 교훈 —
//     액자의 말이 한 틱 blip 이었으면 화면을 얼리지 않는다).
//   그 밖의 «살아 있음» 은 액자의 말보다 **먼저 만들어진** 낡은 행일 수 있다 → 걸쇠를 그대로 둔다.

/** 목록이 멈춘 세션을 따라잡는 데 걸리는 시간의 상한. 실측 지연 약 16초 + 목록 폴링 간격(8~16초)에 여유를 둔다.
 *  길게 잡아도 손해가 작다: 그동안 친 말은 되살리기로 가고, 서버가 «이미 살아 있다» 고 답하면 그 자리에서 그대로 넣는다. */
export const LIST_LAG_MS = 45_000;

/** 액자가 들은 «이 세션 없다» 걸쇠 — gone 이 참일 때만 at·listSaw 가 뜻이 있다. */
export interface StopLatch {
  gone: boolean;
  /** 액자가 «없다» 를 들은 시각(ms) */
  at: number;
  /** 그 뒤에 목록이 «멈춤» 행을 실어 온 적이 있나 */
  listSaw: boolean;
}

/** 목록 행 하나를 받은 뒤의 걸쇠. rowAlive = 그 행이 «살아 있다»(live·alive·restorable 아님)고 말하나. */
export function latchAfterRow(l: StopLatch, rowAlive: boolean, now: number): StopLatch {
  if (!l.gone) return l;
  if (!rowAlive) return l.listSaw ? l : { ...l, listSaw: true };
  if (l.listSaw || now - l.at >= LIST_LAG_MS) return { gone: false, at: 0, listSaw: false };
  return l;
}

/** 서버가 «멈춘 세션이라 넣지 않았다 — 되살리면 들어간다» 고 답했나(POST …/prompt 의 409, deliver-prompt.ts promptStopError).
 *  상태코드만 보지 않는다 — 같은 409 라도 되살릴 수 없는 답(남의 세션·좌표 없음·컴퓨터 무응답)은 되살리기로 가면 안 된다. */
export function stoppedCanRevive(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  if (Number((e as { status?: unknown }).status) !== 409) return false;
  const body = (e as { body?: unknown }).body;
  if (!body || typeof body !== 'object') return false;
  const b = body as { stopped?: unknown; canRevive?: unknown };
  return b.stopped === true && b.canRevive === true;
}

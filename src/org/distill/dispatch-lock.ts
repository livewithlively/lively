// 증류 배치 내기를 워크스페이스별로 한 줄로 세운다 (#5235).
//
//  ── 왜 필요한가 (실측 2026-11-02, 고객사 첫 세팅) ──
//   레인을 켜자 전체 잡(distill-lanes)이 생겼고, 곧이어 레인별 전용 잡을 만들었다. 첫 틱에 두 잡이 같은 레인의 같은 자료를
//   집어 위탁이 두 번 나가 중복 지식 7쌍이 생겼다. 다음 틱부터는 전용 잡이 있는 레인을 전체 잡이 빼서(servedDistillers) 안 겹쳤다.
//   틈은 여기다 — 판정 기록은 **접수한 뒤에** 남고, 배치를 고르는 일은 잡 목록을 읽고 레인마다 인박스를 훑느라 오래 걸린다.
//   그 사이에 도는 다른 잡은 같은 인박스를 그대로 읽는다. 표식이 잡마다 달라(cron:<잡>#<레인>) 중첩 가드도 못 막았다.
//   무지정 잡 둘이 켜진 워크스페이스는 같은 틱마다 같은 일이 난다(#4052 실측 모양).
//   ⇒ «고르기 → 접수 → 판정 기록» 을 한 덩이로 줄 세운다. 다음 잡은 앞 잡의 판정 기록을 본 뒤에 고른다.
//
//  ── 왜 DB advisory 락이 아닌가 ──
//   세션 락은 풀 클라이언트 하나를 쥔 채 본 작업이 두 번째 클라이언트를 쓴다. 앱 설치(#4638)처럼 드문 일이면 괜찮지만 증류는
//   5분 격자로 워크스페이스마다 돈다 — 한 프로세스가 여러 워크스페이스를 맡는 판에서 동시에 겹치면 풀을 잠금만으로 다 잡는 그 사고 모양이 된다.
//   크론 엔진이 이미 단일 프로세스 전제이고 잡 중첩도 인메모리로 막는다(engine.ts 머리말 · running). 같은 전제를 쓴다.
//   두 프로세스가 겹치는 롤 구간은 이 줄이 안 듣는다. DB 를 보는 가드(enqueueHeadlessTask 의 guardMarkers)가 겹침을 줄이지만
//   확인과 접수 사이가 원자적이지 않아 다 닫지는 못한다.
//
//  ── 규율 ──
//   · 기다림에 상한이 있다. 못 얻으면 오류가 아니라 «이번엔 안 돌았다» 이고 실행으로 기록하지 않는다(다음 틱이 다시 본다 — distill.ts · engine.ts).
//   · 쥔 쪽이 끝나지 않아도 임대가 끝나면 다음이 돈다. 매달린 잡 하나가 그 워크스페이스의 증류를 통째로 세우면 안 된다.
import { currentTenant } from "../tenant-context.js";
import { logger } from "../../log.js";

export const distillDispatchLimits = {
  /** 차례를 기다리는 상한 — 못 얻으면 이번 실행은 건너뛴다. */
  waitMs: 60_000,
  /** 한 번 쥐고 있을 수 있는 상한 — 레인이 많은 큰 워크스페이스의 고르기·접수가 끝나고도 남는 값. */
  leaseMs: 5 * 60_000,
};

const tails = new Map<string, Promise<void>>();

/**
 * fn 을 이 워크스페이스의 줄에 세워 돌린다. 상한 안에 차례가 안 오면 fn 을 돌리지 않고 null.
 *  fn 이 던지면 그대로 던지고 줄은 풀린다.
 */
export async function withDistillDispatch<T>(fn: () => Promise<T>, opts: { waitMs?: number; leaseMs?: number } = {}): Promise<T | null> {
  const key = currentTenant()?.id ?? "";
  const before = tails.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const mine = new Promise<void>((res) => { release = res; });
  //  포기한 대기자도 줄에서 앞 차례를 이어 준다 — 뒤 대기자가 앞 실행을 앞지르지 못하게.
  const tail = before.then(() => mine);
  tails.set(key, tail);
  const forget = (): void => { if (tails.get(key) === tail) tails.delete(key); };

  let waiting: NodeJS.Timeout | undefined;
  const myTurn = await Promise.race([
    before.then(() => true),
    new Promise<boolean>((res) => { waiting = setTimeout(() => res(false), opts.waitMs ?? distillDispatchLimits.waitMs); }),
  ]);
  clearTimeout(waiting);
  if (!myTurn) { release(); void tail.then(forget); return null; }

  const lease = setTimeout(() => {
    logger.warn({ workspace: key || null }, "증류 배치 내기가 임대 시간을 넘겼다 — 다음 잡에 차례를 넘긴다");
    release();
  }, opts.leaseMs ?? distillDispatchLimits.leaseMs);
  lease.unref?.();
  try { return await fn(); }
  finally { clearTimeout(lease); release(); forget(); }
}

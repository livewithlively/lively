// 화면 안 AI 로그인 전에 그 사람의 서버 계정(격리 박스의 box_<사람>)을 갖춘다 (#4970) — 게이트웨이 전용(라우트만 부른다).
//
//  왜: 격리 박스에서 계정이 아직 없으면 로그인이 공용 자리로 가고(resolveMemberOsUser «미프로비저닝 → 공유 폴백»), 첫 세션이 계정을 만든
//   뒤엔 그 사람 홈에 자격이 없어 «로그인 안 됨» 이 된다. 계정 만들기는 1~2분(키트 · 구성원 몫 claude·codex 설치)이고, 계정(useradd)
//   자체는 그 초반에 생긴다 — 그래서 «계정이 있나» 만 보고 넘어가면 아직 깔리는 중인 codex 를 «없음» 으로 만나 로그인이 실패했다(격리 리뷰).
//  · prepare(처음 설정 AI 장면을 열 때) — 상태만 답하고, 아직 없으면 만들기를 **시작만** 한다(기다리지 않는다).
//  · start(로그인 시작) — 만드는 중이면 **끝까지** 기다리고, 없으면 만들고(방금 실패했어도 — 사람이 직접 누른 것이다), 그래도 없으면(격리
//    박스에서) 503 — 공용 자리로 몰래 가지 않는다. 기다림은 SEAT_WAIT_MS 까지 — 넘으면 409 «준비하는 중» (만들기는 뒤에서 계속 돈다).
//    상한이 없으면 요청이 만들기 상한(provisionMemberOs 180초)까지 묶이고 화면엔 신호가 없다 — 앞단 프록시가 먼저 끊기도 한다(격리 리뷰).
//  격리 박스가 아니면(state none) 둘 다 아무것도 안 한다 — 종전 동작 그대로.
import { HttpError } from "../http-error.js";
import type { MemberOsState } from "./profiles.js";

export interface SeatPrepDeps {
  state: () => Promise<MemberOsState>;
  /** 지금 만드는 중인 일(없으면 undefined). */
  inflight: () => Promise<unknown> | undefined;
  /** 만들기를 시작한다(이미 만드는 중이면 그 일에 붙는다). */
  ensure: () => Promise<unknown>;
  /** 실패 표식을 지운다(사람이 «다시 해 보기» 를 눌렀을 때만). */
  clearFailure?: () => void;
}

/** prepare — 상태를 돌려준다. 아직 없으면 만들기를 시작하고(기다리지 않는다) «preparing».
 *  retry — 사람이 «다시 해 보기» 를 눌렀다: 방금 실패했어도 다시 만든다(그 밖엔 실패 뒤 잠깐은 다시 띄우지 않는다 — 몇 초마다 묻는 화면이 1~2분짜리 일을 거듭 띄우지 않게). */
export async function prepareMemberSeat(d: SeatPrepDeps, o: { retry?: boolean } = {}): Promise<MemberOsState> {
  let st = await d.state();
  if (st === "failed" && o.retry && d.clearFailure) { d.clearFailure(); st = await d.state(); }
  if (st !== "absent") return st;
  void d.ensure().catch(() => { /* 실패는 다음 state 가 failed 로 말한다 */ });
  return "preparing";
}

export const SEAT_WAIT_MS = 25_000;
const PREPARING_MSG = "이 서버에서 쓰실 개인 계정을 아직 준비하고 있어요(처음 한 번, 1~2분) — 잠시 뒤 다시 눌러 주세요.";

/** start — 계정이 다 만들어질 때까지 기다린다(waitMs 까지 — 넘으면 409). 격리 박스에서 끝내 없으면 503(다시 시도할 수 있다). */
export async function awaitMemberSeat(d: SeatPrepDeps, o: { waitMs?: number } = {}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), o.waitMs ?? SEAT_WAIT_MS); });
  const within = async (p: Promise<unknown>): Promise<void> => {
    if ((await Promise.race([p.then(() => "done", () => "done"), late])) === "late") throw new HttpError(409, PREPARING_MSG);
  };
  try {
    const running = d.inflight();
    if (running) await within(running);
    else {
      let st = await d.state();
      if (st === "failed" && d.clearFailure) { d.clearFailure(); st = await d.state(); }   // 사람이 직접 눌렀다 — 다시 만든다
      if (st === "absent") await within(d.ensure());
    }
    //  기다리는 사이 다른 요청이 새로 시작했을 수 있다 — 한 번 더 붙는다.
    const again = d.inflight();
    if (again) await within(again);
  } finally { clearTimeout(timer); }
  const st = await d.state();
  if (st === "preparing") throw new HttpError(409, PREPARING_MSG);
  if (st === "absent" || st === "failed") {
    throw new HttpError(503, "이 서버에서 쓸 개인 계정을 만들지 못했어요 — 잠시 뒤 다시 시도해 주세요. 계속 안 되면 관리자에게 알려 주세요.");
  }
}

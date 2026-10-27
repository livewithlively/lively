// 처음 설정 완료 표식(welcome)의 진행 표식 옮기기(#4213 T13) — 순수. 쓰는 자리는 delivery/welcome.ts(반영).
//  (리브의 «처음 수집 끝» 표식 withCollectDone 은 store/members.ts 안에 있다 — 그 모듈은 노드 에이전트 번들에 딸려 있어 새 import 를 못 단다.)
//
//  welcome 은 처음 설정을 반영할 때마다 **통째로 덮이는** 칸이다. 그 안에 리브 세션의 진행 표식(처음 수집 끝 · 증류 지시 · 포기)이
//   함께 산다 — 같은 세션을 다시 쓰는 반영이 그것을 안 옮기면 표식이 사라지고, 2턴이 같은 세션에 또 나간다.
import type { LivWelcome } from "../store/members.js";

/**
 * 같은 리브 세션을 다시 쓰는 반영(앞서 연 세션이 있다)이 옮겨 실을 칸 — 진행 표식과 **갈래(flow)**.
 *  갈래도 옮긴다: 세션을 다시 쓰면 새 1턴이 안 들어가므로(kickoffLivAfterWelcome — reuse) 그 세션의 대화는 앞서의 갈래 그대로다.
 *  T13 전에 처음 설정을 끝낸 사람(flow 없음)이 다시 반영해도 «처음 연결» 로 바뀌지 않는다 — 바뀌면 아무도 찍지 않을 처음 수집 끝을
 *  기다리느라 2턴이 90분 늦는다(격리 리뷰 2026-10-17).
 *  새 세션을 여는 반영(앞선 세션 없음)이면 빈 값 — 새 갈래·빈 표식으로 시작한다.
 */
export function carryWelcomeProgress(prior: LivWelcome | null | undefined): Partial<LivWelcome> {
  if (!prior || !prior.session_id) return {};
  return {
    flow: prior.flow ?? undefined,
    collect_done_at: prior.collect_done_at ?? null,
    upload_started_at: prior.upload_started_at ?? null,
    upload_done_at: prior.upload_done_at ?? null,
    distill_at: prior.distill_at ?? null,
    distill_gave_up_at: prior.distill_gave_up_at ?? null,
    distill_note: prior.distill_note ?? null,
    distill_reopened_at: prior.distill_reopened_at ?? null,
  };
}


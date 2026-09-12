// 복원이 하네스를 **어떻게 이어 여나** — `--resume <id>` · 후보 피커 · 새 대화 셋 중 하나 (#3870). **순수**.
//
//  ── 왜 셋인가 (종전엔 둘이었다) ─────────────────────────────────────────────────────
//  종전 규칙은 «이어받을 대화 id 를 확인했으면 그 id 로, 아니면 인자 없는 `--resume`(피커)» 둘뿐이었다.
//  그 피커 폴백은 «사람이 눈으로 고른다» 는 전제 위에 서 있는데, **그 폴더의 대화가 그 기계에 한 건도 없으면
//  피커는 고를 것이 없는 빈 화면**이고, 거기서는 아무도 빠져나오지 못한다:
//   · 하네스는 살아 있어 목록엔 «확인 대기» 로 선다(phase.detectAwaiting 이 `Enter to select` 를 본다).
//   · 사람이 치는 글자는 전부 피커의 **검색창**으로 들어간다 — 무엇을 해도 안 먹는 것처럼 보인다.
//   · 대화 파일이 없으니 대화창도 404 라, 어느 화면으로도 사실을 알 수 없다.
//  실측(2026-09-11 → 09-12): box-wonjoon-jang-940a8f0d «온보딩 과정 설계» 가 맥북에서 리눅스 세션호스트로
//  복원되며 대화 파일이 안 따라왔고, 빈 피커에 **하루** 갇혔다(검색창에 사람이 친 «온보딩» 이 박혀 있었다).
//  같은 모양으로 죽은 세션이 하나 더 있었다(box-wonjoon-jang-7a108f1a).
//
//  ⚠ 옛 설계의 안전망은 «없는 id 로 열면 claude 가 즉시 죽고 #1516 런처가 그 에러를 화면에 남긴다» 였다.
//   그 전제가 깨졌다 — 지금 Claude Code 는 죽지 않고 **피커를 연다**. 시끄럽던 실패가 조용한 함정이 됐다.
//   그래서 «없다» 를 확인한 자리에서는 피커를 아예 열지 않는다.
//
//  ⚠ 바뀌는 것은 **«없다» 확답일 때뿐**이다. «모른다» 는 모든 갈래에서 종전 동작 그대로다 — 못 본 것을
//   «없다» 로 접으면 멀쩡한 대화를 두고 새 대화를 열어 맥락을 잃는다(그게 더 나쁜 실패다).

/** 이어받을 대화가 **그 기계에 있나**. `unknown` = 못 봤다(≠ 없다) — 호출부가 «없다» 로 접지 않는다. */
export type ResumeCheck = "present" | "absent" | "unknown";

/** 복원이 도는 자리. `box` = 게이트웨이가 직접 띄운다 · `node` = 그 좌표의 노드에 릴레이한다. */
export type ResumeBranch = "box" | "node";

/** createSession 에 실을 이어받기 인자 — 셋 중 하나(빈 객체 = 새 대화). */
export interface ResumePlan { resume?: string; resumePick?: true }

export interface ResumePlanInput {
  /** 훅 보고·내구 맵·저장 경로에서 얻은 대화 id. 없으면 이어받을 좌표 자체가 없다. */
  mappedId: string | null;
  /** 그 세션의 하네스 — 대화 파일 규약이 실측된 것은 claude 뿐이다(존재 확인도 claude 에서만 뜻이 있다). */
  harness: string;
  check: ResumeCheck;
  branch: ResumeBranch;
}

/**
 * 이어받기 인자를 정한다.
 *
 *  ① 대화 id 가 없다 → 피커. 이어받을 좌표를 모르니 사람이 눈으로 고르는 것이 남은 최선이다(#2122 자가치유 경로).
 *  ② «있다» 확답 → 그 id 로 정밀 복원(종전과 같다).
 *  ③ «없다» 확답 → **새 대화.** 그 대화가 이 기계에 없으면 피커에 걸릴 것도 없다(위 머리말).
 *  ④ «모른다» → 종전 동작 그대로.
 *     · claude 가 아닌 하네스: 저장 규약이 미실측이라 검사 자체를 안 한다 → 종전대로 그 id 로 시도한다.
 *     · claude + 노드 갈래: 종전에도 확인 없이 그 id 로 시도했다(그 파일이 노드에 있어 못 물었다) → 그대로.
 *     · claude + 박스 갈래: 종전에 확인 실패를 «없다» 로 접어 피커로 갔다 → 그대로 피커.
 */
export function resumePlan(i: ResumePlanInput): ResumePlan {
  if (!i.mappedId) return { resumePick: true };                        // ①
  if (i.check === "present") return { resume: i.mappedId };            // ②
  if (i.check === "absent") return {};                                 // ③ — 피커를 열지 않는다
  if (i.harness !== "claude") return { resume: i.mappedId };           // ④ 검사할 수 없는 하네스
  return i.branch === "node" ? { resume: i.mappedId } : { resumePick: true };   // ④
}

/** 화면에 사실대로 말해 줄 한 낱말 — 「이어받았나」. 토스트 문구가 이 값으로 갈린다. */
export type ResumedKind = "precise" | "picker" | "fresh";
export function resumedKind(plan: ResumePlan): ResumedKind {
  return plan.resume ? "precise" : plan.resumePick ? "picker" : "fresh";
}

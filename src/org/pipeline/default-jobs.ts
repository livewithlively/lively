// 새 워크스페이스의 맥락 자동 실행(증류·분류) 기본값 — **켠 채로** 시작한다 (#4052).
//
//  왜(상민님 2026-09-17): «지금 워크스페이스 만들면 증류·분류 자동 실행이 왜 꺼져 있지? 디폴트로 켜는 게 맞다.»
//   · 매니지드 — CP 프로비저너가 두 잡을 **꺼진 채** 심고, AI 로그인을 처음 감지하면 켰다(lvly-cloud provisioner·onboarding).
//   · 셀프호스트 workspace_create — 두 잡을 **아예 안 심었다**. 화면은 «자동 실행이 없습니다» 였다.
//  어느 쪽이든 사람 눈에는 «꺼짐» 만 보였고, 켜려면 단계마다 단추를 찾아 눌러야 했다.
//
//  규율:
//   · **없을 때만** 만든다(insertCronJobIfAbsent). 사람이 꺼 둔 잡·주기를 바꾼 잡을 되살리거나 덮지 않는다.
//   · id·action·주기는 화면(맥락 관리 ▸ 증류기 탭의 두 [자동 실행 켜기] — 자료 레인 web/distillers.ts · 카테고리 붙이기
//     레인 web/distill-fill.ts)과
//     **같다**. id 가 갈리면 같은 일을 하는 잡이 둘 생겨 한 단계가 두 번 돈다(CP 도 같은 id 를 쓴다).
//   · 실행 계정은 잡에 박지 않는다 — 워크스페이스 실행 멤버(context_job_policy.runner_member, #4012 D1)를 따른다.
//     만든 사람을 그 자리에 앉히는 것은 호출부 몫이다(fillContextJobRunnerIfUnset — 정해진 적 없을 때만).
//   · **새 워크스페이스에서만** 부른다. 기존 워크스페이스의 켜짐/꺼짐은 바꾸지 않는다(모르는 새 AI 비용을 만들지 않는다).
//  비용: 할 일이 없으면(자료·미분류 지식 0건) 두 잡은 AI 를 부르지 않고 끝난다(scheduler/actions/distill·classify).
import { insertCronJobIfAbsent } from "../cron-store.js";

export interface DefaultContextJob {
  id: string;
  label: string;
  action: "distill_sources_headless" | "classify_knowledge_headless";
  interval_sec: number;
  note: string;
}

export const DEFAULT_CONTEXT_JOBS: readonly DefaultContextJob[] = [
  {
    id: "distill-sources-headless",
    label: "자료 증류 (수집된 원본→지식, 헤드리스)",
    action: "distill_sources_headless",
    interval_sec: 1800,
    note: "켜진 증류기별로 미증류 자료 배치를 헤드리스 AI 세션에 접수. 증류기가 없으면 전 자료 공통 기본 증류. 새 워크스페이스는 켠 채로 시작(#4052).",
  },
  {
    id: "classify-knowledge-headless",
    label: "카테고리 붙이기 (미분류 지식→카테고리, 헤드리스)",
    action: "classify_knowledge_headless",
    interval_sec: 3600,
    note: "켜진 카테고리 붙이기 증류기별로 미분류 지식 배치를 헤드리스 AI 세션에 접수. 켜진 것이 없으면 전 지식 공통 기본 기준. 새 워크스페이스는 켠 채로 시작(#4052).",
  },
];

/** 없는 것만 켠 채로 만든다. 만든 잡 id 목록을 돌려준다(이미 있던 것은 빠진다). */
export async function seedDefaultContextJobs(
  actor: string | null,
  insert: typeof insertCronJobIfAbsent = insertCronJobIfAbsent,   // 시험 주입 seam(DB 없이 계약을 잰다)
): Promise<string[]> {
  const created: string[] = [];
  for (const j of DEFAULT_CONTEXT_JOBS) {
    const row = await insert({
      id: j.id, label: j.label, action: j.action, params: "{}",
      interval_sec: j.interval_sec, cron_expr: null, enabled: true,
      note: j.note, run_once: null, actor,
    });
    if (row) created.push(j.id);
  }
  return created;
}

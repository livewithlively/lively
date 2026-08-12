// 크론 액션 — 상류 회귀 자동탐지(카나리) 1회전 (#1657).
//
//  ⚠ **실행 멤버 자격으로 상류에 실제 요청이 나간다.** 프로브는 우리 어댑터 경로를 그대로 타므로(그게 설계의
//   핵심이다 — 통제층을 건너뛰면 정작 우리가 깨졌을 때 초록불이 된다), 호출자 신원이 곧 카나리 계정이다.
//   그래서 잡 생성자(created_by)가 없으면 **돌리지 않는다** — 익명으로 돌면 '자격 없음'만 잔뜩 쌓여
//   상류가 멀쩡한데도 failing 으로 뒤집힌다(가짜 경보가 진짜 경보를 묻는다).
import type { CronActionRun } from "../registry.js";

export const runCanaryJob: CronActionRun = async (_params, job) => {
  const callerId = job.created_by ?? null;
  if (!callerId) {
    return { status: "skipped", summary: { note: "잡 생성자가 없어 실행하지 않음 — 카나리는 그 멤버의 자격으로 상류를 호출한다" } };
  }
  const { runCanary } = await import("../../org/canary/run.js"); // 무거운 의존은 실행 시점에만
  const r = await runCanary({ callerId });
  return {
    status: r.failed === 0 ? "ok" : "warn", // 실패가 있어도 잡 자체는 성공이다 — 관측이 그 잡의 산출물이다
    summary: {
      ran: r.ran, failed: r.failed,
      probes: r.probes.map((p) => ({ key: p.key, ok: p.ok, state: p.state, alerted: p.alerted, reason: p.reason })),
    },
  };
};

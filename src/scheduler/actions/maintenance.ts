// 크론 액션: 유지보수·수렴 스윕(wikilink_sweep·eval_domain_debt·ensure_managed_sessions·preview_reconcile) — R16 원문 이동.
//  공통 성격: 파라미터 없는 전역 스윕 — 각자의 도메인 모듈에 위임하는 thin 액션(무거운 의존은 동적 import 유지).
import { itemsPool, q } from "../../db/client.js";
import type { Actor } from "../../domainmap/core/types.js";
import type { CronJob } from "../registry.js";

export async function runWikilinkSweep(): Promise<{ status: string; summary: unknown }> {
  const { sweepWikiLinks } = await import("../../v6/knowledge-store.js");
  const r = await sweepWikiLinks();
  // dangling(붕 뜬 링크)은 건수만 요약에 — 전체 목록은 잡 요약을 비대하게 만든다(웹 '작업' 탭이 그대로 렌더한다).
  return { status: "ok", summary: { scanned: r.scanned, docs: r.docs, edges: r.edges, dangling_docs: r.dangling.length } };
}

export async function runEvalDomainDebt(_params: Record<string, unknown>, job: CronJob): Promise<{ status: string; summary: unknown }> {
  const actor: Actor = { type: "agent", id: "cron:" + job.id };
  const { evaluateDomainStructureDebt } = await import("../../domainmap/core/domain-debt.js");
  const repos = await q(itemsPool, `SELECT name FROM repo WHERE COALESCE(state,'active')='active'`);
  const out: unknown[] = [];
  for (const r of repos) {
    try { out.push(await evaluateDomainStructureDebt(r.name, actor)); }
    catch (e) { out.push({ repo: r.name, error: String(e) }); }
  }
  return { status: "ok", summary: { repos: out.length } };
}

export async function runEnsureManagedSessions(): Promise<{ status: string; summary: unknown }> {
  // keep-alive — enabled 상시 세션의 tmux 세션 보장(죽었으면 재생성). 등록 0이면 no-op.
  const { ensureAllManagedSessions } = await import("../../sessions/managed-sessions.js");
  return { status: "ok", summary: { sessions: await ensureAllManagedSessions() } };
}

export async function runPreviewReconcile(): Promise<{ status: string; summary: unknown }> {
  // #1036 프리뷰 환경 reconcile — TTL 유휴 회수 + auto 트리거 stage 재-merge(정지된 건 안 켬). 등록 0이면 no-op.
  const { reconcilePreviewEnvs } = await import("../../preview/preview-envs.js");
  return { status: "ok", summary: { envs: await reconcilePreviewEnvs() } };
}

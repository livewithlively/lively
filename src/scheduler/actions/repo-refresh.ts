// 크론 액션: repo 신선화(refresh_*) — R16 에서 scheduler runJob if-체인 본문을 원문 이동.
import { itemsPool, q } from "../../db/client.js";
import { refreshRepoFromGit } from "../../domainmap/git-pull.js";
import type { Actor } from "../../domainmap/core/types.js";
import type { CronJob } from "../registry.js";

export async function runRefreshAll(_params: Record<string, unknown>, job: CronJob): Promise<{ status: string; summary: unknown }> {
  const actor: Actor = { type: "agent", id: "cron:" + job.id };
  const repos = await q(itemsPool,
    `SELECT name FROM repo WHERE COALESCE(state,'active')='active' AND git_url IS NOT NULL AND git_url <> ''`);
  const results = [];
  for (const r of repos) results.push(await refreshRepoFromGit(r.name, actor));
  return { status: "ok", summary: { repos: results.length, results } };
}

export async function runRefreshRepo(params: Record<string, unknown>, job: CronJob): Promise<{ status: string; summary: unknown }> {
  const actor: Actor = { type: "agent", id: "cron:" + job.id };
  const name = params.repo;
  if (!name) return { status: "error", summary: { error: "params.repo 필요" } };
  return { status: "ok", summary: await refreshRepoFromGit(String(name), actor) };
}

export async function runRefreshBases(): Promise<{ status: string; summary: unknown }> {
  // 작업용 공유 base(workspace/repos/<name>) 확보·최신화 — 워크트리 셀프서비스(lively_local_repo_worktree)의 최신 원본(#900).
  //  refresh_all(도메인맵 스캐너 클론 stateDir/repos)과 대상이 다르다(이건 provision base). 없으면 clone·있으면 FF, 전 repo 순회.
  const { ensureProvisionBase } = await import("../../project/project-provision.js");
  const repos = await q(itemsPool,
    `SELECT name FROM repo WHERE COALESCE(state,'active')='active' AND git_url IS NOT NULL AND git_url <> ''`);
  const results = [];
  for (const r of repos) results.push(await ensureProvisionBase(r.name, null));
  return { status: "ok", summary: { repos: results.length, results } };
}

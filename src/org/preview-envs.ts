// 프리뷰 환경 — org_preview_env(desired state) + ensure(서빙 준비 보장). #1036.
//  managed-sessions.ts 의 desired-state + ensure 패턴을 그대로 따른다. 워크트리 생성은 기존 provision/셀프서비스
//  (lively_local_repo_worktree · provisionProjectRepos)가 담당하고, 프리뷰는 '이미 있는 워크트리를 /preview/<id>/
//  서브패스로 노출'하는 얇은 레이어다(§2 포트=작업 워크트리 직결의 최소 실현, shared-proxy).
import path from "node:path";
import { statSync } from "node:fs";
import { itemsPool } from "../items/store.js";

export interface PreviewEnv {
  id: string; label: string | null; kind: string; owner_member: string | null;
  project_id: number | null; repo: string; branch: string | null; worktree_path: string | null;
  backing_mode: string; backing_ref: string | null; status: string; last_error: string | null;
  last_active_at: string | null; ttl_idle_sec: number; enabled: boolean; note: string | null; sort: number;
}

// 공유 워크스페이스 루트 — box-workspace-root-path: 배포 온보딩이 PROJECT_SHARED_BASE 를 env 로 세팅, 코드 폴백은 안전망.
const SHARED_BASE = process.env.PROJECT_SHARED_BASE || path.join(process.env.HOME || "", ".openclaw", "workspace");

// project_id + repo → canonical 워크트리 슬롯 = provisionProjectRepos 와 같은 자리(workspace/project/<id>/<repo>).
export function canonicalWorktree(projectId: number | null | undefined, repo: string): string | null {
  if (!projectId || !repo) return null;
  return path.join(SHARED_BASE, "project", String(projectId), repo);
}

export async function listPreviewEnvs(): Promise<PreviewEnv[]> {
  return (await itemsPool.query("SELECT * FROM org_preview_env ORDER BY sort, id")).rows;
}

export async function getPreviewEnv(id: string): Promise<PreviewEnv | undefined> {
  return (await itemsPool.query("SELECT * FROM org_preview_env WHERE id=$1", [id])).rows[0];
}

export async function upsertPreviewEnv(p: Partial<PreviewEnv> & { id: string }, actor?: string): Promise<PreviewEnv> {
  const ex = await getPreviewEnv(p.id);
  if (!ex) {
    if (!p.repo) throw new Error("repo 는 필수입니다");
    const wt = p.worktree_path ?? canonicalWorktree(p.project_id, p.repo);
    const branch = p.branch ?? (p.project_id ? "project/" + p.project_id : null);
    const r = await itemsPool.query(
      `INSERT INTO org_preview_env(id,label,kind,owner_member,project_id,repo,branch,worktree_path,backing_mode,backing_ref,ttl_idle_sec,enabled,note,created_by,updated_by)
       VALUES($1,$2,COALESCE($3,'work'),$4,$5,$6,$7,$8,COALESCE($9,'shared-proxy'),$10,COALESCE($11,0),COALESCE($12,true),$13,$14,$14) RETURNING *`,
      [p.id, p.label ?? null, p.kind ?? null, p.owner_member ?? null, p.project_id ?? null, p.repo,
       branch, wt, p.backing_mode ?? null, p.backing_ref ?? null,
       typeof p.ttl_idle_sec === "number" ? p.ttl_idle_sec : null,
       typeof p.enabled === "boolean" ? p.enabled : null, p.note ?? null, actor ?? null]);
    return r.rows[0];
  }
  const r = await itemsPool.query(
    `UPDATE org_preview_env SET
       label=COALESCE($2,label), kind=COALESCE($3,kind), owner_member=COALESCE($4,owner_member),
       project_id=COALESCE($5,project_id), repo=COALESCE($6,repo), branch=COALESCE($7,branch),
       worktree_path=COALESCE($8,worktree_path), backing_mode=COALESCE($9,backing_mode), backing_ref=COALESCE($10,backing_ref),
       ttl_idle_sec=COALESCE($11,ttl_idle_sec), enabled=COALESCE($12,enabled), note=COALESCE($13,note),
       version=version+1, updated_at=now(), updated_by=$14
     WHERE id=$1 RETURNING *`,
    [p.id, p.label ?? null, p.kind ?? null, p.owner_member ?? null, p.project_id ?? null, p.repo ?? null,
     p.branch ?? null, p.worktree_path ?? null, p.backing_mode ?? null, p.backing_ref ?? null,
     typeof p.ttl_idle_sec === "number" ? p.ttl_idle_sec : null,
     typeof p.enabled === "boolean" ? p.enabled : null, p.note ?? null, actor ?? null]);
  return r.rows[0];
}

export async function deletePreviewEnv(id: string): Promise<{ deleted: boolean; id: string }> {
  const r = await itemsPool.query("DELETE FROM org_preview_env WHERE id=$1", [id]);
  return { deleted: (r.rowCount ?? 0) > 0, id };
}

async function setStatus(id: string, status: string, error: string | null): Promise<{ id: string; status: string; action: string; error?: string }> {
  await itemsPool.query("UPDATE org_preview_env SET status=$2, last_error=$3, updated_at=now() WHERE id=$1", [id, status, error]);
  return { id, status, action: status, error: error ?? undefined };
}

// 프리뷰 서빙 준비 보장 — shared-proxy(work): 워크트리 public/ 존재 확인 후 status=running.
//  워크트리 자체 생성은 기존 provision/셀프서비스 담당(여기선 확인만). 없으면 status=error + 안내.
//  throwaway·existing-ref(3단계)는 여기에 백엔드 기동/연결 분기를 추가한다.
export async function ensurePreviewEnv(p: PreviewEnv): Promise<{ id: string; status: string; url?: string; action: string; error?: string }> {
  if (!p.enabled) return { id: p.id, status: "stopped", action: "disabled" };
  if (p.backing_mode !== "shared-proxy") {
    return setStatus(p.id, "error", "backing_mode=" + p.backing_mode + " 는 아직 미지원(1단계는 shared-proxy 만). 3단계 예정.");
  }
  const wt = p.worktree_path || canonicalWorktree(p.project_id, p.repo);
  if (!wt) return setStatus(p.id, "error", "worktree_path 미지정 (project_id+repo 또는 worktree_path 필요)");
  const publicDir = path.join(wt, "public");
  let ok = false;
  try { ok = statSync(publicDir).isDirectory(); } catch { ok = false; }
  if (!ok) return setStatus(p.id, "error", "워크트리 public/ 없음: " + publicDir + " (워크트리를 먼저 만들고 build:web 하세요)");
  await itemsPool.query(
    "UPDATE org_preview_env SET status='running', last_error=NULL, worktree_path=$2, last_active_at=now(), updated_at=now() WHERE id=$1",
    [p.id, wt]);
  return { id: p.id, status: "running", url: "/preview/" + p.id + "/", action: "ready" };
}

export async function stopPreviewEnv(id: string): Promise<{ id: string; status: string; action: string }> {
  await itemsPool.query("UPDATE org_preview_env SET status='stopped', updated_at=now() WHERE id=$1", [id]);
  return { id, status: "stopped", action: "stopped" };
}

// reconcile — 크론 preview_reconcile 가 주기 호출. (a) TTL 초과 유휴 프리뷰 회수, (b) enabled 프리뷰 ensure. 등록 0이면 no-op.
//  shared-proxy 는 프로세스가 없어 running 유지 비용이 사실상 0(요청 시에만 서빙)이라 TTL 은 3단계 throwaway 에서 주로 의미.
export async function reconcilePreviewEnvs(): Promise<Array<{ id: string; status?: string; action?: string; error?: string }>> {
  const rows = await listPreviewEnvs();
  const out: Array<{ id: string; status?: string; action?: string; error?: string }> = [];
  for (const p of rows) {
    if (p.ttl_idle_sec > 0 && p.status === "running" && p.last_active_at) {
      const idleMs = Date.now() - new Date(p.last_active_at).getTime();
      if (idleMs > p.ttl_idle_sec * 1000) {
        await stopPreviewEnv(p.id);
        out.push({ id: p.id, action: "reaped-idle" });
        continue;
      }
    }
    if (!p.enabled) continue;
    try { out.push(await ensurePreviewEnv(p)); }
    catch (e) { out.push({ id: p.id, error: (e as Error)?.message ?? String(e) }); }
  }
  return out;
}

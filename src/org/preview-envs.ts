// 프리뷰 환경 — org_preview_env(desired state) + ensure(서빙 준비 보장). #1036.
//  1단계 work(shared-proxy): 워크트리 public/ 을 /preview/<id>/ 로 직접 서빙(별도 프로세스·포트 불요).
//  2단계 stage: 여러 작업 브랜치를 base 위에 merge 한 통합 워크트리(preview-stage.ts). 둘 다 서빙은 preview-routes.ts.
//  managed-sessions.ts 의 desired-state + ensure 패턴을 따른다. work 워크트리 생성은 기존 provision/셀프서비스가 담당.
import path from "node:path";
import { statSync } from "node:fs";
import { itemsPool } from "../items/store.js";
import { ensureStageWorktree } from "./preview-stage.js";

export interface PreviewEnv {
  id: string; label: string | null; kind: string; owner_member: string | null;
  project_id: number | null; repo: string; branch: string | null; worktree_path: string | null;
  backing_mode: string; backing_ref: string | null; status: string; last_error: string | null;
  last_active_at: string | null; ttl_idle_sec: number; enabled: boolean; note: string | null; sort: number;
  member_branches: string[]; base_ref: string | null; merge_trigger: string; merge_status: Record<string, string>;
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
  const mb = p.member_branches !== undefined ? JSON.stringify(p.member_branches) : null;
  if (!ex) {
    if (!p.repo) throw new Error("repo 는 필수입니다");
    const wt = p.worktree_path ?? canonicalWorktree(p.project_id, p.repo);
    const branch = p.branch ?? (p.project_id ? "project/" + p.project_id : null);
    const r = await itemsPool.query(
      `INSERT INTO org_preview_env(id,label,kind,owner_member,project_id,repo,branch,worktree_path,backing_mode,backing_ref,ttl_idle_sec,enabled,note,member_branches,base_ref,merge_trigger,created_by,updated_by)
       VALUES($1,$2,COALESCE($3,'work'),$4,$5,$6,$7,$8,COALESCE($9,'shared-proxy'),$10,COALESCE($11,0),COALESCE($12,true),$13,COALESCE($14,'[]')::jsonb,$15,COALESCE($16,'manual'),$17,$17) RETURNING *`,
      [p.id, p.label ?? null, p.kind ?? null, p.owner_member ?? null, p.project_id ?? null, p.repo,
       branch, wt, p.backing_mode ?? null, p.backing_ref ?? null,
       typeof p.ttl_idle_sec === "number" ? p.ttl_idle_sec : null,
       typeof p.enabled === "boolean" ? p.enabled : null, p.note ?? null,
       mb, p.base_ref ?? null, p.merge_trigger ?? null, actor ?? null]);
    return r.rows[0];
  }
  const r = await itemsPool.query(
    `UPDATE org_preview_env SET
       label=COALESCE($2,label), kind=COALESCE($3,kind), owner_member=COALESCE($4,owner_member),
       project_id=COALESCE($5,project_id), repo=COALESCE($6,repo), branch=COALESCE($7,branch),
       worktree_path=COALESCE($8,worktree_path), backing_mode=COALESCE($9,backing_mode), backing_ref=COALESCE($10,backing_ref),
       ttl_idle_sec=COALESCE($11,ttl_idle_sec), enabled=COALESCE($12,enabled), note=COALESCE($13,note),
       member_branches=COALESCE($14::jsonb,member_branches), base_ref=COALESCE($15,base_ref), merge_trigger=COALESCE($16,merge_trigger),
       version=version+1, updated_at=now(), updated_by=$17
     WHERE id=$1 RETURNING *`,
    [p.id, p.label ?? null, p.kind ?? null, p.owner_member ?? null, p.project_id ?? null, p.repo ?? null,
     p.branch ?? null, p.worktree_path ?? null, p.backing_mode ?? null, p.backing_ref ?? null,
     typeof p.ttl_idle_sec === "number" ? p.ttl_idle_sec : null,
     typeof p.enabled === "boolean" ? p.enabled : null, p.note ?? null,
     mb, p.base_ref ?? null, p.merge_trigger ?? null, actor ?? null]);
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

// 프리뷰 서빙 준비 보장.
//  work(shared-proxy): 워크트리 public/ 존재 확인 후 running. 워크트리 생성은 기존 provision/셀프서비스 담당(여기선 확인만).
//  stage: 여러 작업 브랜치를 base 위에 merge 한 통합 워크트리 구성(preview-stage.ts) → merge_status 표면화.
//  throwaway·existing-ref(3단계)는 여기에 백엔드 기동/연결 분기를 추가한다.
export async function ensurePreviewEnv(p: PreviewEnv): Promise<{ id: string; status: string; url?: string; action: string; error?: string }> {
  if (!p.enabled) return { id: p.id, status: "stopped", action: "disabled" };

  if (p.kind === "stage") {
    const branches = Array.isArray(p.member_branches) ? p.member_branches : [];
    if (!branches.length) return setStatus(p.id, "error", "stage 는 통합할 브랜치(member_branches)가 최소 1개 필요합니다");
    try {
      const r = await ensureStageWorktree(p.id, p.repo, p.base_ref || "origin/main", branches);
      const conflict = r.conflicts.length > 0;
      await itemsPool.query(
        "UPDATE org_preview_env SET status='running', last_error=$3, worktree_path=$2, merge_status=$4::jsonb, last_active_at=now(), updated_at=now() WHERE id=$1",
        [p.id, r.worktree_path, conflict ? ("merge 충돌: " + r.conflicts.join(", ")) : null, JSON.stringify(r.merge_status)]);
      return { id: p.id, status: "running", url: "/preview/" + p.id + "/", action: conflict ? "ready-with-conflicts" : "ready", error: conflict ? ("충돌(제외됨): " + r.conflicts.join(", ")) : undefined };
    } catch (e) {
      return setStatus(p.id, "error", (e as Error)?.message ?? String(e));
    }
  }

  // work — shared-proxy 만 (throwaway·existing-ref 는 3단계)
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

// reconcile — 크론 preview_reconcile 가 주기 호출. (a) TTL 초과 유휴 회수, (b) auto 트리거 stage 재-merge(작업 브랜치 갱신 반영).
//  온디맨드 원칙: 정지된(stopped) 프리뷰를 자동으로 켜지 않는다 — 사용자가 ensure 로 켠 것만 유지·갱신. 등록 0이면 no-op.
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
    if (!p.enabled || p.status !== "running") continue; // 온디맨드: 정지된 건 자동으로 안 켬
    if (p.kind === "stage" && p.merge_trigger === "auto") {
      try { out.push(await ensurePreviewEnv(p)); } // auto stage 만 재-merge(최신 브랜치 반영)
      catch (e) { out.push({ id: p.id, error: (e as Error)?.message ?? String(e) }); }
    }
    // work running / manual stage 는 유지(재-merge·재확인 불요)
  }
  return out;
}

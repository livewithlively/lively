// 프리뷰 환경 — org_preview_env(desired state) + ensure. #1036.
//  work: backing_mode = shared-proxy(워크트리 public 정적 · /api=게이트웨이 자신) | throwaway(stack_profile.start_cmd 프로세스 spawn+프록시)
//        | existing-ref(기존에 떠있는 인스턴스로 프록시)
//  stage: 여러 작업 브랜치를 base 위에 merge 한 통합 워크트리(정적 서빙, preview-stage.ts).
//  stack_profile = '어떻게 띄우나'(throwaway 전용: start_cmd·포트env·env·헬스체크). 서빙·프록시는 preview-routes.ts.
//  managed-sessions 의 desired-state + ensure 패턴.
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
  port: number | null; pid: number | null; stack_profile: string | null;
}

export interface StackProfile {
  id: string; label: string | null; repo: string | null; static_only: boolean;
  start_cmd: string | null; port_env: string; env_json: Record<string, string>; healthcheck_path: string | null;
  note: string | null; sort: number;
}

const SHARED_BASE = process.env.PROJECT_SHARED_BASE || path.join(process.env.HOME || "", ".openclaw", "workspace");

// project_id + repo → canonical 워크트리 슬롯 = provisionProjectRepos 와 같은 자리(workspace/project/<id>/<repo>).
export function canonicalWorktree(projectId: number | null | undefined, repo: string): string | null {
  if (!projectId || !repo) return null;
  return path.join(SHARED_BASE, "project", String(projectId), repo);
}

// ── stack_profile CRUD (어떻게 띄우나 — 프리셋 + 커스텀, 비개발자 드롭다운) ──
export async function listStackProfiles(): Promise<StackProfile[]> {
  return (await itemsPool.query("SELECT * FROM org_stack_profile ORDER BY sort, id")).rows;
}
export async function getStackProfile(id: string): Promise<StackProfile | undefined> {
  return (await itemsPool.query("SELECT * FROM org_stack_profile WHERE id=$1", [id])).rows[0];
}
export async function upsertStackProfile(s: Partial<StackProfile> & { id: string }, actor?: string): Promise<StackProfile> {
  const ex = await getStackProfile(s.id);
  const envJson = s.env_json ? JSON.stringify(s.env_json) : null;
  if (!ex) {
    const r = await itemsPool.query(
      `INSERT INTO org_stack_profile(id,label,repo,static_only,start_cmd,port_env,env_json,healthcheck_path,note,created_by,updated_by)
       VALUES($1,$2,$3,COALESCE($4,false),$5,COALESCE($6,'PORT'),COALESCE($7,'{}')::jsonb,$8,$9,$10,$10) RETURNING *`,
      [s.id, s.label ?? null, s.repo ?? null, typeof s.static_only === "boolean" ? s.static_only : null,
       s.start_cmd ?? null, s.port_env ?? null, envJson, s.healthcheck_path ?? null, s.note ?? null, actor ?? null]);
    return r.rows[0];
  }
  const r = await itemsPool.query(
    `UPDATE org_stack_profile SET label=COALESCE($2,label), repo=COALESCE($3,repo), static_only=COALESCE($4,static_only),
       start_cmd=COALESCE($5,start_cmd), port_env=COALESCE($6,port_env), env_json=COALESCE($7::jsonb,env_json),
       healthcheck_path=COALESCE($8,healthcheck_path), note=COALESCE($9,note), version=version+1, updated_at=now(), updated_by=$10
     WHERE id=$1 RETURNING *`,
    [s.id, s.label ?? null, s.repo ?? null, typeof s.static_only === "boolean" ? s.static_only : null,
     s.start_cmd ?? null, s.port_env ?? null, envJson, s.healthcheck_path ?? null, s.note ?? null, actor ?? null]);
  return r.rows[0];
}
export async function deleteStackProfile(id: string): Promise<{ deleted: boolean; id: string }> {
  const r = await itemsPool.query("DELETE FROM org_stack_profile WHERE id=$1", [id]);
  return { deleted: (r.rowCount ?? 0) > 0, id };
}

// ── preview_env CRUD ──
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
      `INSERT INTO org_preview_env(id,label,kind,owner_member,project_id,repo,branch,worktree_path,backing_mode,backing_ref,ttl_idle_sec,enabled,note,member_branches,base_ref,merge_trigger,stack_profile,created_by,updated_by)
       VALUES($1,$2,COALESCE($3,'work'),$4,$5,$6,$7,$8,COALESCE($9,'shared-proxy'),$10,COALESCE($11,0),COALESCE($12,true),$13,COALESCE($14,'[]')::jsonb,$15,COALESCE($16,'manual'),$17,$18,$18) RETURNING *`,
      [p.id, p.label ?? null, p.kind ?? null, p.owner_member ?? null, p.project_id ?? null, p.repo,
       branch, wt, p.backing_mode ?? null, p.backing_ref ?? null,
       typeof p.ttl_idle_sec === "number" ? p.ttl_idle_sec : null,
       typeof p.enabled === "boolean" ? p.enabled : null, p.note ?? null,
       mb, p.base_ref ?? null, p.merge_trigger ?? null, p.stack_profile ?? null, actor ?? null]);
    return r.rows[0];
  }
  const r = await itemsPool.query(
    `UPDATE org_preview_env SET
       label=COALESCE($2,label), kind=COALESCE($3,kind), owner_member=COALESCE($4,owner_member),
       project_id=COALESCE($5,project_id), repo=COALESCE($6,repo), branch=COALESCE($7,branch),
       worktree_path=COALESCE($8,worktree_path), backing_mode=COALESCE($9,backing_mode), backing_ref=COALESCE($10,backing_ref),
       ttl_idle_sec=COALESCE($11,ttl_idle_sec), enabled=COALESCE($12,enabled), note=COALESCE($13,note),
       member_branches=COALESCE($14::jsonb,member_branches), base_ref=COALESCE($15,base_ref), merge_trigger=COALESCE($16,merge_trigger),
       stack_profile=COALESCE($17,stack_profile),
       version=version+1, updated_at=now(), updated_by=$18
     WHERE id=$1 RETURNING *`,
    [p.id, p.label ?? null, p.kind ?? null, p.owner_member ?? null, p.project_id ?? null, p.repo ?? null,
     p.branch ?? null, p.worktree_path ?? null, p.backing_mode ?? null, p.backing_ref ?? null,
     typeof p.ttl_idle_sec === "number" ? p.ttl_idle_sec : null,
     typeof p.enabled === "boolean" ? p.enabled : null, p.note ?? null,
     mb, p.base_ref ?? null, p.merge_trigger ?? null, p.stack_profile ?? null, actor ?? null]);
  return r.rows[0];
}

export async function deletePreviewEnv(id: string): Promise<{ deleted: boolean; id: string }> {
  try { const { stopProc } = await import("./preview-proc.js"); stopProc(id); } catch { /* 프로세스 없으면 무시 */ }
  const r = await itemsPool.query("DELETE FROM org_preview_env WHERE id=$1", [id]);
  return { deleted: (r.rowCount ?? 0) > 0, id };
}

async function setStatus(id: string, status: string, error: string | null): Promise<{ id: string; status: string; action: string; error?: string }> {
  await itemsPool.query("UPDATE org_preview_env SET status=$2, last_error=$3, updated_at=now() WHERE id=$1", [id, status, error]);
  return { id, status, action: status, error: error ?? undefined };
}

// 프리뷰 서빙 준비 보장 — kind/backing 별 분기.
export async function ensurePreviewEnv(p: PreviewEnv): Promise<{ id: string; status: string; url?: string; action: string; error?: string; port?: number }> {
  if (!p.enabled) return { id: p.id, status: "stopped", action: "disabled" };
  const url = "/preview/" + p.id + "/";

  // stage — 여러 브랜치 merge 통합 워크트리(정적 서빙)
  if (p.kind === "stage") {
    const branches = Array.isArray(p.member_branches) ? p.member_branches : [];
    if (!branches.length) return setStatus(p.id, "error", "stage 는 통합할 브랜치(member_branches)가 최소 1개 필요합니다");
    try {
      const r = await ensureStageWorktree(p.id, p.repo, p.base_ref || "origin/main", branches);
      const conflict = r.conflicts.length > 0;
      await itemsPool.query(
        "UPDATE org_preview_env SET status='running', last_error=$3, worktree_path=$2, merge_status=$4::jsonb, last_active_at=now(), updated_at=now() WHERE id=$1",
        [p.id, r.worktree_path, conflict ? ("merge 충돌: " + r.conflicts.join(", ")) : null, JSON.stringify(r.merge_status)]);
      return { id: p.id, status: "running", url, action: conflict ? "ready-with-conflicts" : "ready", error: conflict ? ("충돌(제외됨): " + r.conflicts.join(", ")) : undefined };
    } catch (e) {
      return setStatus(p.id, "error", (e as Error)?.message ?? String(e));
    }
  }

  // work — backing_mode 별
  if (p.backing_mode === "existing-ref") {
    // 기존에 떠있는 인스턴스로 프록시 — 프로세스 spawn 없음. backing_ref(대상 base URL) 검증만.
    const ref = (p.backing_ref || "").trim();
    if (!/^https?:\/\/.+/.test(ref)) return setStatus(p.id, "error", "existing-ref 는 backing_ref(http(s)://호스트:포트) 가 필요합니다");
    await itemsPool.query("UPDATE org_preview_env SET status='running', last_error=NULL, last_active_at=now(), updated_at=now() WHERE id=$1", [p.id]);
    return { id: p.id, status: "running", url, action: "ready" };
  }

  if (p.backing_mode === "throwaway") {
    const prof = p.stack_profile ? await getStackProfile(p.stack_profile) : undefined;
    if (!prof) return setStatus(p.id, "error", "throwaway 는 stack_profile(어떻게 띄우나)을 지정해야 합니다");
    if (prof.static_only || !prof.start_cmd) return setStatus(p.id, "error", "stack_profile '" + prof.id + "' 에 start_cmd 가 없습니다(정적 프로필은 shared-proxy 로 쓰세요)");
    const wt = p.worktree_path || canonicalWorktree(p.project_id, p.repo);
    if (!wt) return setStatus(p.id, "error", "worktree_path 미지정 (project_id+repo 또는 worktree_path 필요)");
    try { if (!statSync(wt).isDirectory()) throw new Error("no dir"); } catch { return setStatus(p.id, "error", "워크트리 없음: " + wt); }
    try {
      const { startProc } = await import("./preview-proc.js");
      const env = (prof.env_json && typeof prof.env_json === "object") ? prof.env_json as Record<string, string> : {};
      const r = await startProc(p.id, wt, prof.start_cmd, prof.port_env || "PORT", env, prof.healthcheck_path);
      await itemsPool.query(
        "UPDATE org_preview_env SET status='running', last_error=$3, port=$2, pid=$4, last_active_at=now(), updated_at=now() WHERE id=$1",
        [p.id, r.port, r.healthy ? null : "헬스체크 미확인(프로세스는 기동됨 — 로그 확인)", r.pid]);
      return { id: p.id, status: "running", url, action: r.action, port: r.port, error: r.healthy ? undefined : "헬스체크 미확인" };
    } catch (e) {
      return setStatus(p.id, "error", "프로세스 기동 실패: " + ((e as Error)?.message ?? String(e)));
    }
  }

  // shared-proxy (기본) — 워크트리 public/ 정적 서빙(/api 는 게이트웨이 자신)
  const wt = p.worktree_path || canonicalWorktree(p.project_id, p.repo);
  if (!wt) return setStatus(p.id, "error", "worktree_path 미지정 (project_id+repo 또는 worktree_path 필요)");
  const publicDir = path.join(wt, "public");
  let ok = false;
  try { ok = statSync(publicDir).isDirectory(); } catch { ok = false; }
  if (!ok) return setStatus(p.id, "error", "워크트리 public/ 없음: " + publicDir + " (워크트리를 먼저 만들고 build:web 하세요)");
  await itemsPool.query(
    "UPDATE org_preview_env SET status='running', last_error=NULL, worktree_path=$2, last_active_at=now(), updated_at=now() WHERE id=$1",
    [p.id, wt]);
  return { id: p.id, status: "running", url, action: "ready" };
}

export async function stopPreviewEnv(p: PreviewEnv): Promise<{ id: string; status: string; action: string }> {
  if (p.backing_mode === "throwaway") {
    try { const { stopProc } = await import("./preview-proc.js"); stopProc(p.id); } catch { /* */ }
  }
  await itemsPool.query("UPDATE org_preview_env SET status='stopped', pid=NULL, updated_at=now() WHERE id=$1", [p.id]);
  return { id: p.id, status: "stopped", action: "stopped" };
}

// reconcile — 크론 preview_reconcile. (a) TTL 유휴 회수, (b) auto stage 재-merge, (c) throwaway 죽은 프로세스 재기동.
//  온디맨드: 정지된(stopped) 프리뷰는 자동으로 안 켠다 — 사용자가 ensure 로 켠 것만 유지·갱신. 등록 0이면 no-op.
export async function reconcilePreviewEnvs(): Promise<Array<{ id: string; status?: string; action?: string; error?: string }>> {
  const rows = await listPreviewEnvs();
  const out: Array<{ id: string; status?: string; action?: string; error?: string }> = [];
  for (const p of rows) {
    if (p.ttl_idle_sec > 0 && p.status === "running" && p.last_active_at) {
      const idleMs = Date.now() - new Date(p.last_active_at).getTime();
      if (idleMs > p.ttl_idle_sec * 1000) {
        await stopPreviewEnv(p);
        out.push({ id: p.id, action: "reaped-idle" });
        continue;
      }
    }
    if (!p.enabled || p.status !== "running") continue; // 온디맨드: 정지된 건 자동으로 안 켬
    if (p.kind === "stage" && p.merge_trigger === "auto") {
      try { out.push(await ensurePreviewEnv(p)); } catch (e) { out.push({ id: p.id, error: (e as Error)?.message ?? String(e) }); }
    } else if (p.kind !== "stage" && p.backing_mode === "throwaway") {
      const { isAlive } = await import("./preview-proc.js");
      if (!isAlive(p.id)) { // 프로세스 죽었으면 재기동(keep-alive)
        try { out.push(await ensurePreviewEnv(p)); } catch (e) { out.push({ id: p.id, error: (e as Error)?.message ?? String(e) }); }
      }
    }
    // work shared-proxy / existing-ref / manual stage 는 유지(재확인 불요)
  }
  return out;
}

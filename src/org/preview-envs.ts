// 미리보기(프리뷰) 환경 — org_preview_env(desired state) + ensure. #1036.
//  사람이 고르는 건 **무엇을 미리볼지(프로젝트·레포)** 뿐이고, 나머지(작업 폴더 생성·빌드·서빙)는 전부 자동이다.
//  work: backing_mode = shared-proxy(작업 폴더의 화면 파일을 그대로 서빙 · API 는 이 서버) | throwaway(전용 서버를
//        띄워 연결) | existing-ref(이미 떠 있는 주소로 연결). stage: 여러 작업을 합쳐 한 화면으로(preview-stage.ts).
//  ⚠ 작업 폴더 준비·빌드는 수십 초~수 분이라 ensure 는 **즉시 'preparing' 을 돌려주고 백그라운드로 진행**한다
//   (#600 에서 동기 provision 이 504 를 낸 전례). 화면은 상태를 폴링해 '준비 중 → 실행 중'으로 바뀐다.
import path from "node:path";
import { statSync } from "node:fs";
import { itemsPool } from "../items/store.js";
import { ensureStageWorktree } from "./preview-stage.js";
import { ensureProjectWorktree, runBuild, buildFailureHint } from "./preview-prepare.js";
import { logger } from "../log.js";

export interface PreviewEnv {
  id: string; label: string | null; kind: string; owner_member: string | null;
  project_id: number | null; repo: string; branch: string | null; worktree_path: string | null;
  backing_mode: string; backing_ref: string | null; status: string; last_error: string | null;
  last_active_at: string | null; ttl_idle_sec: number; enabled: boolean; note: string | null; sort: number;
  member_branches: string[]; base_ref: string | null; merge_trigger: string; merge_status: Record<string, string>;
  port: number | null; pid: number | null; stack_profile: string | null;
  project_name?: string | null; // 목록 표시용(조회 시 join) — 화면에 '#1036' 대신 프로젝트 이름이 보이게
}

export interface StackProfile {
  id: string; label: string | null; repo: string | null; static_only: boolean;
  start_cmd: string | null; build_cmd: string | null; port_env: string; env_json: Record<string, string>;
  healthcheck_path: string | null; note: string | null; sort: number;
}

const SHARED_BASE = process.env.PROJECT_SHARED_BASE || path.join(process.env.HOME || "", ".openclaw", "workspace");

// project_id + repo → 작업 폴더의 표준 자리(provisionProjectRepos 와 같은 곳: workspace/project/<id>/<repo>).
export function canonicalWorktree(projectId: number | null | undefined, repo: string): string | null {
  if (!projectId || !repo) return null;
  return path.join(SHARED_BASE, "project", String(projectId), repo);
}

// ── 스택 프로필(어떻게 띄우나 — 관리자가 미리 정의, 사용자는 고르기만) ──
export async function listStackProfiles(): Promise<StackProfile[]> {
  return (await itemsPool.query("SELECT * FROM org_stack_profile ORDER BY sort, id")).rows;
}
export async function getStackProfile(id: string): Promise<StackProfile | undefined> {
  return (await itemsPool.query("SELECT * FROM org_stack_profile WHERE id=$1", [id])).rows[0];
}
export async function upsertStackProfile(s: Partial<StackProfile> & { id: string }, actor?: string): Promise<StackProfile> {
  const ex = await getStackProfile(s.id);
  const envJson = s.env_json ? JSON.stringify(s.env_json) : null;
  const args = [s.id, s.label ?? null, s.repo ?? null, typeof s.static_only === "boolean" ? s.static_only : null,
    s.start_cmd ?? null, s.build_cmd ?? null, s.port_env ?? null, envJson, s.healthcheck_path ?? null, s.note ?? null, actor ?? null];
  if (!ex) {
    return (await itemsPool.query(
      `INSERT INTO org_stack_profile(id,label,repo,static_only,start_cmd,build_cmd,port_env,env_json,healthcheck_path,note,created_by,updated_by)
       VALUES($1,$2,$3,COALESCE($4,false),$5,$6,COALESCE($7,'PORT'),COALESCE($8,'{}')::jsonb,$9,$10,$11,$11) RETURNING *`, args)).rows[0];
  }
  return (await itemsPool.query(
    `UPDATE org_stack_profile SET label=COALESCE($2,label), repo=COALESCE($3,repo), static_only=COALESCE($4,static_only),
       start_cmd=COALESCE($5,start_cmd), build_cmd=COALESCE($6,build_cmd), port_env=COALESCE($7,port_env),
       env_json=COALESCE($8::jsonb,env_json), healthcheck_path=COALESCE($9,healthcheck_path), note=COALESCE($10,note),
       version=version+1, updated_at=now(), updated_by=$11
     WHERE id=$1 RETURNING *`, args)).rows[0];
}
export async function deleteStackProfile(id: string): Promise<{ deleted: boolean; id: string }> {
  const r = await itemsPool.query("DELETE FROM org_stack_profile WHERE id=$1", [id]);
  return { deleted: (r.rowCount ?? 0) > 0, id };
}

// 이 미리보기에 쓸 프로필 — 명시값이 우선, 없으면 **레포로 자동 매칭**(사용자가 고르지 않아도 빌드가 돌게).
//  throwaway 는 실행 명령이 있는 프로필이, 그 외에는 정적 프로필이 자연스러운 기본값이다.
async function resolveProfile(p: PreviewEnv): Promise<StackProfile | undefined> {
  if (p.stack_profile) return getStackProfile(p.stack_profile);
  if (!p.repo) return undefined;
  const wantRunnable = p.kind !== "stage" && p.backing_mode === "throwaway";
  const r = await itemsPool.query(
    `SELECT * FROM org_stack_profile WHERE repo=$1 AND static_only = $2 ORDER BY sort, id LIMIT 1`,
    [p.repo, !wantRunnable]);
  return r.rows[0];
}

// ── preview_env CRUD ──
export async function listPreviewEnvs(): Promise<PreviewEnv[]> {
  // 프로젝트 이름을 함께 — 목록에 '#1036' 같은 숫자만 남으면 사람이 무엇의 미리보기인지 알 수 없다.
  return (await itemsPool.query(
    `SELECT e.*, p.name AS project_name
       FROM org_preview_env e LEFT JOIN project p ON p.id = e.project_id
      ORDER BY e.sort, e.id`)).rows;
}
export async function getPreviewEnv(id: string): Promise<PreviewEnv | undefined> {
  return (await itemsPool.query("SELECT * FROM org_preview_env WHERE id=$1", [id])).rows[0];
}

const slug = (s: unknown): string =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

// 아이디를 사용자에게 묻지 않기 위한 해소 — ① 같은 프로젝트·레포·종류의 미리보기가 이미 있으면 **그걸 재사용**
//  (같은 걸 두 번 만들지 않는다), ② 없으면 읽을 만한 아이디를 만든다.
export async function resolvePreviewId(input: Partial<PreviewEnv>): Promise<string> {
  if (input.id) return input.id;
  const kind = input.kind || "work";
  if (input.project_id && input.repo) {
    const found = await itemsPool.query(
      "SELECT id FROM org_preview_env WHERE project_id=$1 AND repo=$2 AND kind=$3 ORDER BY id LIMIT 1",
      [input.project_id, input.repo, kind]);
    if (found.rows[0]) return found.rows[0].id;
  }
  const base = [kind === "stage" ? "stage" : null, input.project_id ? "p" + input.project_id : null, slug(input.repo)]
    .filter(Boolean).join("-") || "preview";
  let id = base;
  for (let n = 2; n <= 50 && await getPreviewEnv(id); n++) id = `${base}-${n}`;
  return id;
}

export async function upsertPreviewEnv(p: Partial<PreviewEnv> & { id: string }, actor?: string): Promise<PreviewEnv> {
  const ex = await getPreviewEnv(p.id);
  const mb = p.member_branches !== undefined ? JSON.stringify(p.member_branches) : null;
  const common = [p.label ?? null, p.kind ?? null, p.owner_member ?? null, p.project_id ?? null,
    p.branch ?? null, p.worktree_path ?? null, p.backing_mode ?? null, p.backing_ref ?? null,
    typeof p.ttl_idle_sec === "number" ? p.ttl_idle_sec : null,
    typeof p.enabled === "boolean" ? p.enabled : null, p.note ?? null,
    mb, p.base_ref ?? null, p.merge_trigger ?? null, p.stack_profile ?? null, actor ?? null];
  if (!ex) {
    if (!p.repo) throw new Error("어떤 레포를 미리볼지 골라 주세요");
    const wt = p.worktree_path ?? canonicalWorktree(p.project_id, p.repo);
    const branch = p.branch ?? (p.project_id ? "project/" + p.project_id : null);
    return (await itemsPool.query(
      `INSERT INTO org_preview_env(id,label,kind,owner_member,project_id,repo,branch,worktree_path,backing_mode,backing_ref,ttl_idle_sec,enabled,note,member_branches,base_ref,merge_trigger,stack_profile,created_by,updated_by)
       VALUES($1,$2,COALESCE($3,'work'),$4,$5,$17,COALESCE($6,$18),COALESCE($7,$19),COALESCE($8,'shared-proxy'),$9,COALESCE($10,0),COALESCE($11,true),$12,COALESCE($13,'[]')::jsonb,$14,COALESCE($15,'manual'),$16,$20,$20) RETURNING *`,
      [p.id, ...common.slice(0, 15), p.repo, branch, wt, actor ?? null])).rows[0];
  }
  return (await itemsPool.query(
    `UPDATE org_preview_env SET
       label=COALESCE($2,label), kind=COALESCE($3,kind), owner_member=COALESCE($4,owner_member),
       project_id=COALESCE($5,project_id), branch=COALESCE($6,branch), worktree_path=COALESCE($7,worktree_path),
       backing_mode=COALESCE($8,backing_mode), backing_ref=COALESCE($9,backing_ref),
       ttl_idle_sec=COALESCE($10,ttl_idle_sec), enabled=COALESCE($11,enabled), note=COALESCE($12,note),
       member_branches=COALESCE($13::jsonb,member_branches), base_ref=COALESCE($14,base_ref),
       merge_trigger=COALESCE($15,merge_trigger), stack_profile=COALESCE($16,stack_profile),
       repo=COALESCE($17,repo), version=version+1, updated_at=now(), updated_by=$18
     WHERE id=$1 RETURNING *`,
    [p.id, ...common.slice(0, 15), p.repo ?? null, actor ?? null])).rows[0];
}

export async function deletePreviewEnv(id: string): Promise<{ deleted: boolean; id: string }> {
  try { const { stopProc } = await import("./preview-proc.js"); stopProc(id); } catch { /* 띄운 서버가 없으면 그만 */ }
  const r = await itemsPool.query("DELETE FROM org_preview_env WHERE id=$1", [id]);
  return { deleted: (r.rowCount ?? 0) > 0, id };
}

async function setStatus(id: string, status: string, error: string | null): Promise<{ id: string; status: string; action: string; error?: string }> {
  await itemsPool.query("UPDATE org_preview_env SET status=$2, last_error=$3, updated_at=now() WHERE id=$1", [id, status, error]);
  return { id, status, action: status, error: error ?? undefined };
}

const previewUrl = (id: string): string => "/preview/" + id + "/";
const hasDir = (dir: string): boolean => { try { return statSync(dir).isDirectory(); } catch { return false; } };

// 미리보기 띄우기 — 준비할 게 없으면 바로 '실행 중', 있으면 '준비 중'을 돌려주고 뒤에서 진행한다.
export async function ensurePreviewEnv(p: PreviewEnv): Promise<{ id: string; status: string; url?: string; action: string; error?: string; port?: number }> {
  if (!p.enabled) return { id: p.id, status: "stopped", action: "disabled" };
  const url = previewUrl(p.id);

  // 이미 떠 있는 주소로 연결 — 준비할 게 없다.
  if (p.kind !== "stage" && p.backing_mode === "existing-ref") {
    const ref = (p.backing_ref || "").trim();
    if (!/^https?:\/\/.+/.test(ref)) return setStatus(p.id, "error", "연결할 주소를 입력해 주세요 (예: http://localhost:8081)");
    await itemsPool.query("UPDATE org_preview_env SET status='running', last_error=NULL, last_active_at=now(), updated_at=now() WHERE id=$1", [p.id]);
    return { id: p.id, status: "running", url, action: "ready" };
  }

  // 입력이 모자라면 준비를 시작하기 전에 알려준다(사람이 고칠 수 있게).
  if (p.kind === "stage" && !(Array.isArray(p.member_branches) && p.member_branches.length)) {
    return setStatus(p.id, "error", "합쳐서 볼 작업(브랜치)을 한 개 이상 지정해 주세요");
  }
  if (p.kind !== "stage" && !p.worktree_path && !p.project_id) {
    return setStatus(p.id, "error", "어떤 프로젝트의 작업을 미리볼지 골라 주세요");
  }
  const profile = await resolveProfile(p);
  if (p.kind !== "stage" && p.backing_mode === "throwaway" && (!profile || profile.static_only || !profile.start_cmd)) {
    return setStatus(p.id, "error", "이 방식은 ‘어떻게 띄울지’(스택 프로필)를 골라야 합니다");
  }

  // 준비가 필요한가 — 작업 폴더가 없거나, 빌드가 걸려 있거나, 전용 서버/합치기가 필요한 경우.
  const wt = p.worktree_path || canonicalWorktree(p.project_id, p.repo);
  const needsPrepare = p.kind === "stage"
    || p.backing_mode === "throwaway"
    || !!profile?.build_cmd
    || !wt || !hasDir(path.join(wt, "public"));
  if (!needsPrepare) {
    await itemsPool.query(
      "UPDATE org_preview_env SET status='running', last_error=NULL, worktree_path=$2, last_active_at=now(), updated_at=now() WHERE id=$1", [p.id, wt]);
    return { id: p.id, status: "running", url, action: "ready" };
  }

  await itemsPool.query("UPDATE org_preview_env SET status='preparing', last_error=NULL, updated_at=now() WHERE id=$1", [p.id]);
  void preparePreviewEnv(p.id).catch((e) => logger.warn({ err: e, id: p.id }, "미리보기 준비 실패(백그라운드)"));
  return { id: p.id, status: "preparing", url, action: "preparing" };
}

// 백그라운드 준비 — 작업 폴더 확보 → (필요하면) 빌드 → 서빙 준비. 각 단계 실패는 사람이 읽을 안내로 남긴다.
export async function preparePreviewEnv(id: string): Promise<void> {
  const p = await getPreviewEnv(id);
  if (!p || !p.enabled) return;
  try {
    // 1) 볼 파일이 있는 폴더 확보
    let workdir: string;
    if (p.kind === "stage") {
      const r = await ensureStageWorktree(p.id, p.repo, p.base_ref || "origin/main", p.member_branches || []);
      workdir = r.worktree_path;
      await itemsPool.query("UPDATE org_preview_env SET merge_status=$2::jsonb WHERE id=$1", [p.id, JSON.stringify(r.merge_status)]);
      if (r.conflicts.length) {
        await itemsPool.query("UPDATE org_preview_env SET last_error=$2 WHERE id=$1",
          [p.id, `일부 작업은 서로 충돌해 이번 화면에서 빠졌습니다: ${r.conflicts.join(", ")}`]);
      }
    } else if (p.worktree_path && hasDir(p.worktree_path)) {
      workdir = p.worktree_path;
    } else {
      workdir = await ensureProjectWorktree(p.project_id as number, p.repo, p.owner_member);
    }
    await itemsPool.query("UPDATE org_preview_env SET worktree_path=$2 WHERE id=$1", [p.id, workdir]);

    // 2) 빌드(프로필에 걸려 있으면) — 화면이 항상 최신이도록.
    const profile = await resolveProfile(p);
    if (profile?.build_cmd) {
      const b = await runBuild(workdir, profile.build_cmd);
      if (!b.ok) { await setStatus(p.id, "error", buildFailureHint(b.out)); return; }
    }

    // 3) 서빙 준비 — 전용 서버를 띄우거나(throwaway), 화면 파일을 확인한다(정적).
    if (p.kind !== "stage" && p.backing_mode === "throwaway" && profile?.start_cmd) {
      const { startProc } = await import("./preview-proc.js");
      const env = (profile.env_json && typeof profile.env_json === "object") ? profile.env_json as Record<string, string> : {};
      const r = await startProc(p.id, workdir, profile.start_cmd, profile.port_env || "PORT", env, profile.healthcheck_path);
      await itemsPool.query(
        "UPDATE org_preview_env SET status='running', last_error=$3, port=$2, pid=$4, last_active_at=now(), updated_at=now() WHERE id=$1",
        [p.id, r.port, r.healthy ? null : "서버는 떴지만 응답 확인에 실패했습니다 — 잠시 뒤 새로고침해 보세요", r.pid]);
      return;
    }
    if (!hasDir(path.join(workdir, "public"))) {
      await setStatus(p.id, "error", "미리볼 화면 파일을 찾지 못했습니다 — 이 프로젝트가 빌드가 필요한 종류라면 스택 프로필에 빌드 명령을 넣어 주세요");
      return;
    }
    await itemsPool.query(
      "UPDATE org_preview_env SET status='running', last_active_at=now(), updated_at=now() WHERE id=$1", [p.id]);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    await setStatus(p.id, "error", msg.length > 300 ? msg.slice(0, 300) + "…" : msg);
  }
}

export async function stopPreviewEnv(p: PreviewEnv): Promise<{ id: string; status: string; action: string }> {
  if (p.backing_mode === "throwaway") {
    try { const { stopProc } = await import("./preview-proc.js"); stopProc(p.id); } catch { /* 이미 없음 */ }
  }
  await itemsPool.query("UPDATE org_preview_env SET status='stopped', pid=NULL, updated_at=now() WHERE id=$1", [p.id]);
  return { id: p.id, status: "stopped", action: "stopped" };
}

// 주기 점검(크론 preview_reconcile) — ① 오래 안 쓴 것 정리, ② 자동 합치기 갱신, ③ 죽은 전용 서버 되살리기,
//  ④ 재시작 등으로 '준비 중'에 멈춘 것 복구. 정지된 건 자동으로 켜지 않는다(사람이 띄운 것만 유지).
export async function reconcilePreviewEnvs(): Promise<Array<{ id: string; status?: string; action?: string; error?: string }>> {
  const rows = await listPreviewEnvs();
  const out: Array<{ id: string; status?: string; action?: string; error?: string }> = [];
  for (const p of rows) {
    if (p.status === "preparing") { // 준비 중인 채 15분 넘게 멈춰 있으면(프로세스 재시작 등) 되살린다
      const since = p.last_active_at ? Date.now() - new Date(p.last_active_at).getTime() : Infinity;
      if (since > 15 * 60_000) { void preparePreviewEnv(p.id); out.push({ id: p.id, action: "re-preparing" }); }
      continue;
    }
    if (p.ttl_idle_sec > 0 && p.status === "running" && p.last_active_at) {
      if (Date.now() - new Date(p.last_active_at).getTime() > p.ttl_idle_sec * 1000) {
        await stopPreviewEnv(p);
        out.push({ id: p.id, action: "reaped-idle" });
        continue;
      }
    }
    if (!p.enabled || p.status !== "running") continue;
    if (p.kind === "stage" && p.merge_trigger === "auto") {
      try { out.push(await ensurePreviewEnv(p)); } catch (e) { out.push({ id: p.id, error: (e as Error)?.message ?? String(e) }); }
    } else if (p.kind !== "stage" && p.backing_mode === "throwaway") {
      const { isAlive } = await import("./preview-proc.js");
      if (!isAlive(p.id)) {
        try { out.push(await ensurePreviewEnv(p)); } catch (e) { out.push({ id: p.id, error: (e as Error)?.message ?? String(e) }); }
      }
    }
  }
  return out;
}

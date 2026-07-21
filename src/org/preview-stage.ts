// 프리뷰 stage(통합) — 여러 작업 브랜치를 base 위에 merge 한 stage/<id> 워크트리 구성 (#1036 2단계).
//  작업→stage 단방향(파생물, stage 직접편집 금지). ensureStageWorktree: base 최신화 → 깨끗한 base 로 reset →
//  member_branches 순차 merge → 충돌은 abort 후 merge_status 에 표면화(그 브랜치만 제외, 나머지는 통합 유지).
//  서빙은 1단계 preview-routes 재사용(worktree_path=stage 워크트리). 브랜치명(stage/<id>)은 project/<id> 와 다른
//  네임스페이스라 #932 싱글턴 충돌 없음. git() 은 project-provision.ts 의 private 헬퍼와 동일 패턴(셸 무인젝션·umask·타임아웃).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureProvisionBase } from "../project-provision.js";
// 공유 워크스페이스 루트는 **project-fs 의 것 하나만** 쓴다 — 여기서 따로 계산하면(구 코드가 그랬다)
//  TERMINAL_ROOT_SHARED 를 다르게 잡은 설치에서 base 클론은 A 에, stage 워크트리는 B 에 생겨 서로 못 찾는다.
import { PROJECT_SHARED_BASE as SHARED_BASE } from "../project-fs.js";

const GIT_TIMEOUT_MS = 180_000;
const BR_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/; // git 브랜치명(선두 특수문자 금지)

function git(args: string[], cwd?: string, timeoutMs = GIT_TIMEOUT_MS): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    const p = spawn("sh", ["-c", 'umask 0002; exec "$@"', "sh", "git", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env });
    let out = "", err = "", done = false;
    const fin = (r: { ok: boolean; out: string; err: string }) => { if (!done) { done = true; resolve(r); } };
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* */ } fin({ ok: false, out: out.trim(), err: `git 타임아웃(${timeoutMs}ms)` }); }, timeoutMs);
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => { clearTimeout(t); fin({ ok: false, out: out.trim(), err: err.trim() || e.message }); });
    p.on("close", (c) => { clearTimeout(t); fin({ ok: c === 0, out: out.trim(), err: err.trim() }); });
  });
}

export interface StageResult { worktree_path: string; merge_status: Record<string, string>; conflicts: string[]; head: string | null; }

// stage/<id> 워크트리에 base_ref 위로 branches 를 순차 merge. 반환: 워크트리 경로 + 브랜치별 상태 + 충돌 목록.
//  매 호출 base 로 reset 후 재-merge(결정성) — auto 트리거(작업 브랜치 갱신 반영)와 manual 모두 같은 경로.
export async function ensureStageWorktree(id: string, repo: string, baseRef: string, branches: string[]): Promise<StageResult> {
  const base = await ensureProvisionBase(repo); // workspace/repos/<repo> — 없으면 clone, 있으면 FF
  if (base.status === "error") throw new Error("base repo 확보 실패(" + repo + "): " + (base.detail || "unknown"));
  const repoPath = path.join(SHARED_BASE, "repos", repo);
  const wt = path.join(SHARED_BASE, "stage", id); // stage 워크트리(별도 네임스페이스)
  const stageBranch = "stage/" + id;
  const ref = (baseRef && baseRef.trim()) ? baseRef.trim() : "origin/main";
  if (!BR_RE.test(ref.replace(/^origin\//, ""))) throw new Error("base_ref 형식 오류: " + ref);

  await git(["worktree", "prune"], repoPath); // 스테일 등록 정리(#932)
  if (!fs.existsSync(wt)) {
    await fs.promises.mkdir(path.dirname(wt), { recursive: true });
    let a = await git(["worktree", "add", wt, "-b", stageBranch, ref], repoPath);
    if (!a.ok) a = await git(["worktree", "add", wt, stageBranch], repoPath); // 브랜치 이미 있으면 attach
    if (!a.ok) throw new Error("stage 워크트리 생성 실패: " + a.err);
  }
  await git(["fetch", "origin"], wt); // member 브랜치·base 최신
  const rs = await git(["reset", "--hard", ref], wt); // 깨끗한 base 로 리셋(재-merge 결정성)
  if (!rs.ok) throw new Error("stage base 리셋 실패(" + ref + "): " + rs.err);
  await git(["clean", "-fd"], wt); // merge 잔여물 제거

  const merge_status: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const raw of branches) {
    const br = String(raw ?? "").trim();
    if (!br || !BR_RE.test(br)) { merge_status[String(raw)] = "invalid"; continue; }
    let target = "origin/" + br;
    if (!(await git(["rev-parse", "--verify", "--quiet", target], wt)).ok) {
      target = (await git(["rev-parse", "--verify", "--quiet", br], wt)).ok ? br : "";
    }
    if (!target) { merge_status[br] = "missing"; continue; }
    const m = await git(["merge", "--no-edit", target], wt);
    if (m.ok) { merge_status[br] = "merged"; }
    else { await git(["merge", "--abort"], wt); merge_status[br] = "conflict"; conflicts.push(br); }
  }
  const head = (await git(["rev-parse", "--short", "HEAD"], wt)).out.trim() || null;
  return { worktree_path: wt, merge_status, conflicts, head };
}

export interface RepoBranch { name: string; updated_at: string | null; author: string | null; subject: string | null; }

// 레포의 원격 브랜치 목록(최근 갱신순) — '합쳐서 볼 작업'을 **타이핑이 아니라 고르게** 하기 위한 것.
//  base 클론에서 fetch 한 뒤 refs/remotes/origin 을 읽는다(작업 워크트리 불필요). origin/ 접두사와 HEAD 는 떼고 돌려준다.
export async function listRepoBranches(repo: string, limit = 300): Promise<RepoBranch[]> {
  const base = await ensureProvisionBase(repo); // 없으면 clone, 있으면 fetch+FF
  if (base.status === "error") throw new Error("레포를 확보하지 못했습니다(" + repo + "): " + (base.detail || "unknown"));
  const repoPath = path.join(SHARED_BASE, "repos", repo);
  const SEP = "\x1f";
  const r = await git([
    "for-each-ref", "--sort=-committerdate", "--count=" + Math.max(1, Math.min(1000, limit)),
    "--format=%(refname:short)" + SEP + "%(committerdate:iso8601)" + SEP + "%(authorname)" + SEP + "%(contents:subject)",
    "refs/remotes/origin",
  ], repoPath, 60_000);
  if (!r.ok) throw new Error("브랜치 목록을 읽지 못했습니다: " + r.err);
  const out: RepoBranch[] = [];
  for (const line of r.out.split("\n")) {
    if (!line.trim()) continue;
    const [refRaw, date, author, subject] = line.split(SEP);
    const ref = String(refRaw || "").trim();
    if (ref === "origin" || ref.endsWith("/HEAD")) continue; // refs/remotes/origin/HEAD 는 short 형이 'origin' — 브랜치가 아니다
    const name = ref.replace(/^origin\//, "");
    if (!name) continue;
    out.push({ name, updated_at: date || null, author: author || null, subject: (subject || "").slice(0, 200) || null });
  }
  return out;
}

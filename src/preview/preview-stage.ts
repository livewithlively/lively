// 프리뷰 stage(통합) — 여러 작업 브랜치를 base 위에 merge 한 stage/<id> 워크트리 구성 (#1036 2단계).
//  작업→stage 단방향(파생물, stage 직접편집 금지). ensureStageWorktree: base 최신화 → 깨끗한 base 로 reset →
//  member_branches 순차 merge → 충돌은 abort 후 merge_status 에 표면화(그 브랜치만 제외, 나머지는 통합 유지).
//  서빙은 1단계 preview/routes 재사용(worktree_path=stage 워크트리). 브랜치명(stage/<id>)은 project/<id> 와 다른
//  네임스페이스라 #932 싱글턴 충돌 없음. git() 은 project-provision.ts 의 private 헬퍼와 동일 패턴(셸 무인젝션·umask·타임아웃).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureProvisionBase, clearStaleRegistrations } from "../project/project-provision.js";
// 공유 워크스페이스 루트는 **project-fs 의 것 하나만** 쓴다 — 여기서 따로 계산하면(구 코드가 그랬다)
//  TERMINAL_ROOT_SHARED 를 다르게 잡은 설치에서 base 클론은 A 에, stage 워크트리는 B 에 생겨 서로 못 찾는다.
import { PROJECT_SHARED_BASE as SHARED_BASE } from "../project/project-fs.js";

const GIT_TIMEOUT_MS = 180_000;
const BR_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/; // git 브랜치명(선두 특수문자 금지)
// stage 합성 머지 커밋의 작성자 — stage 는 파생물이라 사람 이름을 붙일 자리가 아니다(누가 만들었냐는 member_branches 가 말한다).
const MERGE_IDENTITY = ["-c", "user.name=Lively Preview", "-c", "user.email=preview@lively.invalid"];

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

export interface StageResult { worktree_path: string; merge_status: Record<string, string>; conflicts: string[]; failures: Record<string, string>; head: string | null; }

/**
 * 머지가 실패했을 때 **왜** 실패했나 — 사람이 할 일이 정반대라 뭉뚱그리면 안 된다(#3778, 2026-09-09).
 *
 * 종전엔 `git merge` 의 비-0 종료를 전부 «conflict» 로 적었다. 그래서 신원 부재·인덱스 잠금·fetch 실패까지
 *  화면엔 «서로 충돌» 로 나왔고, 사람은 있지도 않은 코드 충돌을 찾으러 갔다(실측 2026-09-09: 세션 둘이
 *  같은 함정에 걸렸고 한 세션은 «원인 미상» 으로 남겼다 — 로컬 merge-tree 는 무충돌인데 프리뷰만 충돌).
 *
 * 판정 근거는 **인덱스에 남은 unmerged 항목**이다(`git ls-files -u`). 진짜 충돌이면 거기 스테이지가 남고,
 *  그 밖의 실패(커밋을 못 만듦·잠금·네트워크)는 인덱스가 깨끗하다. stderr 문자열 매칭은 로케일을 타서 안 쓴다.
 */
export function mergeVerdict(unmergedOut: string, stderr: string): { status: "conflict" | "failed"; detail: string } {
  if (unmergedOut.trim()) return { status: "conflict", detail: "" };
  const line = String(stderr || "").split("\n").map((l) => l.trim()).filter(Boolean).pop() || "알 수 없는 오류";
  return { status: "failed", detail: line.slice(0, 300) };
}

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

  if (!fs.existsSync(wt)) {
    await fs.promises.mkdir(path.dirname(wt), { recursive: true });
    // 스테일 등록 정리(#932) — **이 경로·이 브랜치의 등록만**(#3678: blanket `worktree prune` 은 이 프로세스가 못 보는 남의 워크트리까지 지운다)
    await clearStaleRegistrations(repoPath, { paths: [wt], branch: stageBranch });
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
  const failures: Record<string, string> = {};
  for (const raw of branches) {
    const br = String(raw ?? "").trim();
    if (!br || !BR_RE.test(br)) { merge_status[String(raw)] = "invalid"; continue; }
    let target = "origin/" + br;
    if (!(await git(["rev-parse", "--verify", "--quiet", target], wt)).ok) {
      target = (await git(["rev-parse", "--verify", "--quiet", br], wt)).ok ? br : "";
    }
    if (!target) { merge_status[br] = "missing"; continue; }
    // ⚠ 신원을 **명시한다**. 브랜치가 base 보다 뒤처져 있으면 이 머지는 fast-forward 가 아니라 진짜 머지라
    //  **커밋을 만들어야 하는데**, 게이트웨이 컨테이너엔 git 전역 설정이 없어 거기서 죽었다. 그 죽음이 화면엔
    //  «충돌» 로 나왔다(#3778 실측 — 리베이스해 FF 로 만들자 곧바로 merged). 이 세 인자가 그 실패를 없앤다.
    const m = await git([...MERGE_IDENTITY, "merge", "--no-edit", target], wt);
    if (m.ok) { merge_status[br] = "merged"; continue; }
    // 인덱스의 unmerged 항목이 «진짜 충돌인가» 의 정본 — abort 하면 지워지므로 **abort 전에** 읽는다.
    const unmerged = await git(["ls-files", "-u"], wt);
    const v = mergeVerdict(unmerged.out, m.err || m.out);
    await git(["merge", "--abort"], wt);
    merge_status[br] = v.status;
    if (v.status === "conflict") conflicts.push(br);
    else failures[br] = v.detail;
  }
  const head = (await git(["rev-parse", "--short", "HEAD"], wt)).out.trim() || null;
  return { worktree_path: wt, merge_status, conflicts, failures, head };
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

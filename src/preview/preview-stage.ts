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

export interface StageResult { worktree_path: string; merge_status: Record<string, string>; conflicts: string[]; head: string | null; inputs: StageInputs; }

// stage/<id> 워크트리에 base_ref 위로 branches 를 순차 merge. 반환: 워크트리 경로 + 브랜치별 상태 + 충돌 목록.
//  매 호출 base 로 reset 후 재-merge(결정성) — auto 트리거(작업 브랜치 갱신 반영)와 manual 모두 같은 경로.
export async function ensureStageWorktree(id: string, repo: string, baseRef: string, branches: string[]): Promise<StageResult> {
  const base = await ensureProvisionBase(repo); // workspace/repos/<repo> — 없으면 clone, 있으면 FF
  if (base.status === "error") throw new Error("base repo 확보 실패(" + repo + "): " + (base.detail || "unknown"));
  const repoPath = path.join(SHARED_BASE, "repos", repo);
  const wt = path.join(SHARED_BASE, "stage", id); // stage 워크트리(별도 네임스페이스)
  const stageBranch = "stage/" + id;
  const ref = stageBaseRef(baseRef);
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
  // 무엇을 합치는지 — 합치기 **직전**의 끝 커밋들. 준비가 성공하면 호출부가 이걸 기록해 두고, 자동 갱신은
  //  이 기록과 지금 끝 커밋을 대 보고 같으면 다시 빌드하지 않는다(#4119 · stageRebuildVerdict).
  const inputs = await readStageInputs(wt, ref, branches);

  const merge_status: Record<string, string> = {};
  const conflicts: string[] = [];
  for (const raw of branches) {
    const br = String(raw ?? "").trim();
    if (!br || !BR_RE.test(br)) { merge_status[String(raw)] = "invalid"; continue; }
    const target = await memberTarget(br, wt);
    if (!target) { merge_status[br] = "missing"; continue; }
    const m = await git(["merge", "--no-edit", target], wt);
    if (m.ok) { merge_status[br] = "merged"; }
    else { await git(["merge", "--abort"], wt); merge_status[br] = "conflict"; conflicts.push(br); }
  }
  const head = (await git(["rev-parse", "--short", "HEAD"], wt)).out.trim() || null;
  return { worktree_path: wt, merge_status, conflicts, head, inputs };
}

// ── 자동 갱신의 «다시 빌드할까» (#4119, 2026-09-21) ──────────────────────────────────────────────
//
// 종전 주기 점검(preview_reconcile, 5분)은 자동 합치기 stage 를 **바뀐 게 없어도 매번** 다시 합치고 전량
//  빌드했다(preview-envs.ensurePreviewEnv 의 needsPrepare 가 stage 면 무조건 참). 빌드는 게이트웨이의 자식이라
//  게이트웨이 유닛 메모리 한도(매니지드 2GiB)에 같이 잡히고, stage 일곱이 한꺼번에 돌자 10초 만에 한도가 차
//  게이트웨이가 1~4분씩 통째로 멈췄다 — 5분마다(실측: 새 세션 «여는 중…» 1분+ · 노드 링크 끊김 · /healthz
//  30초 무응답). 합칠 입력이 그대로면 결과도 그대로다. 그래서 **마지막으로 성공한 준비의 입력**을 적어 두고
//  지금 입력과 같으면 건너뛴다.
//
// 입력 = base_ref 이름 · 그 커밋 · 합칠 작업마다 끝 커밋(없으면 null) · 빌드 명령. 충돌로 빠진 작업도 끝 커밋이
//  그대로면 같은 입력이다 — 이걸 «HEAD 에 들어 있나(조상 판정)» 로 재면 충돌 작업이 영영 «안 들어 있음» 이라
//  매 점검마다 다시 빌드한다(바로 이번 고장의 모양).
// 작업은 **순서가 있는 목록**으로 적는다 — 머지 순서가 바뀌면 어느 쪽이 충돌로 빠지는지가 바뀐다. 객체 키로 적으면
//  JS 가 숫자 모양 이름("9"·"10")을 앞으로 올려 순서가 조용히 바뀐다.

export interface StageInputs { ref: string; base: string | null; members: Array<[string, string | null]> }
/** 마지막으로 **성공한** 준비의 입력 — 합친 것 + 그때의 빌드 명령. */
export interface StageRecord extends StageInputs { build_cmd: string | null }

// 기록은 **그 워크트리 전용 git 디렉터리**에 둔다(<공용 .git>/worktrees/<이름>/). 워크트리 안에 두면 준비가
//  매번 하는 `git clean -fd` 가 지우고, DB 에 두면 표 스키마가 는다. 워크트리를 지우면 기록도 같이 사라져
//  «기록 없음 → 다시 빌드» 로 맞게 떨어진다.
const STAGE_RECORD_FILE = "lively-stage-inputs.json";

export const stageBaseRef = (baseRef: string | null | undefined): string =>
  (baseRef && baseRef.trim()) ? baseRef.trim() : "origin/main";

// 합칠 작업의 대상 ref — 원격 브랜치가 먼저, 없으면 같은 이름의 로컬 브랜치, 둘 다 없으면 ""(빠짐).
//  합치기(ensureStageWorktree)와 입력 판정(readStageInputs)이 **같은 함수**를 써야 «무엇을 합쳤나» 와
//  «지금 무엇을 합칠 것인가» 가 같은 자로 재진다.
async function memberTarget(br: string, cwd: string): Promise<string> {
  const remote = "origin/" + br;
  if ((await git(["rev-parse", "--verify", "--quiet", remote], cwd)).ok) return remote;
  return (await git(["rev-parse", "--verify", "--quiet", br], cwd)).ok ? br : "";
}

async function revParse(ref: string, cwd: string): Promise<string | null> {
  const r = await git(["rev-parse", "--verify", "--quiet", ref + "^{commit}"], cwd);
  return r.ok && r.out ? r.out : null;
}

// base 의 끝 커밋 — base_ref 가 로컬 이름(`main`)이면 **원격 짝(origin/main)** 으로 잰다. 로컬 브랜치는 준비가 돌 때
//  base 클론 갱신(ensureProvisionBase)으로만 앞으로 감기므로, 로컬 값으로 재면 준비가 안 도는 한 영영 «그대로» 다 —
//  종전엔 5분마다 준비가 돌아서 드러나지 않던 자리. 원격 짝이 없는 로컬 전용 이름만 로컬 값으로 잰다.
async function baseTip(ref: string, cwd: string): Promise<string | null> {
  if (ref.startsWith("origin/")) return revParse(ref, cwd);
  return (await revParse("origin/" + ref, cwd)) ?? revParse(ref, cwd);
}

async function readStageInputs(cwd: string, ref: string, branches: string[]): Promise<StageInputs> {
  const members: Array<[string, string | null]> = [];
  for (const raw of branches) {
    const br = String(raw ?? "").trim();
    if (!br || !BR_RE.test(br)) continue; // 합치기도 건너뛰는 이름 — 입력이 아니다
    const target = await memberTarget(br, cwd);
    members.push([br, target ? await revParse(target, cwd) : null]);
  }
  return { ref, base: await baseTip(ref, cwd), members };
}

/**
 * 지금 합친다면 무엇을 합칠까 — 원격을 한 번 받아 온 뒤의 끝 커밋들.
 *  `fetched` 는 한 판(점검 1회) 안에서 같은 저장소를 두 번 받지 않게 하는 표다 — stage 들은 base 클론 하나를
 *  같이 쓰므로(링크된 워크트리) 한 번이면 모두의 원격 참조가 새것이 된다. 받기에 실패해도 멈추지 않는다:
 *  옛 참조로 재면 «그대로» 가 나와 다시 빌드하지 않는다 — 네트워크가 죽은 판에 같은 것을 또 빌드할 이유가 없다.
 */
export async function currentStageInputs(wt: string, baseRef: string | null | undefined, branches: string[],
  fetched?: Set<string>): Promise<StageInputs & { fetchError?: string }> {
  const common = await git(["rev-parse", "--git-common-dir"], wt, 30_000);
  const key = common.ok && common.out ? path.resolve(wt, common.out) : wt;
  let fetchError: string | undefined;
  if (!fetched?.has(key)) {
    const f = await git(["fetch", "origin"], wt);
    fetched?.add(key);
    if (!f.ok) fetchError = f.err || "fetch 실패";
  }
  return { ...await readStageInputs(wt, stageBaseRef(baseRef), branches), ...(fetchError ? { fetchError } : {}) };
}

async function stageRecordPath(wt: string): Promise<string | null> {
  const r = await git(["rev-parse", "--git-dir"], wt, 30_000);
  return r.ok && r.out ? path.join(path.resolve(wt, r.out), STAGE_RECORD_FILE) : null;
}

export async function readStageRecord(wt: string): Promise<StageRecord | null> {
  const f = await stageRecordPath(wt);
  if (!f) return null;
  try {
    const j = JSON.parse(await fs.promises.readFile(f, "utf8"));
    const okMember = (m: unknown): m is [string, string | null] =>
      Array.isArray(m) && m.length === 2 && typeof m[0] === "string" && (m[1] === null || typeof m[1] === "string");
    if (!j || typeof j.ref !== "string" || !Array.isArray(j.members) || !j.members.every(okMember)) return null;
    return { ref: j.ref, base: typeof j.base === "string" ? j.base : null, members: j.members,
      build_cmd: typeof j.build_cmd === "string" ? j.build_cmd : null };
  } catch { return null; } // 없음·깨짐 = 기록 없음(다시 빌드 한 번으로 복구된다)
}

export async function writeStageRecord(wt: string, rec: StageRecord): Promise<void> {
  const f = await stageRecordPath(wt);
  if (!f) throw new Error("stage 워크트리의 git 디렉터리를 찾지 못했습니다: " + wt);
  const tmp = `${f}.${process.pid}.tmp`; // 반쯤 쓴 파일을 읽지 않게 — 쓰고 나서 바꿔 끼운다
  await fs.promises.writeFile(tmp, JSON.stringify(rec));
  await fs.promises.rename(tmp, f);
}

/**
 * 순수 판정 — 기록(마지막 성공)과 지금 입력이 같으면 다시 빌드하지 않는다. reason 은 점검 요약에 그대로 실린다.
 *  기록이 없으면(첫 점검·이 판 이전에 만든 워크트리·기록 쓰기 실패) 한 번 빌드해 기록을 만든다.
 */
export function stageRebuildVerdict(record: StageRecord | null, current: StageInputs, buildCmd: string | null):
  { rebuild: boolean; reason: string } {
  if (!record) return { rebuild: true, reason: "no-record" };
  if (record.ref !== current.ref) return { rebuild: true, reason: "base-ref-changed" };
  if (record.base !== current.base) return { rebuild: true, reason: "base-moved" };
  const names = (ms: StageInputs["members"]): string => JSON.stringify(ms.map(([br]) => br));
  if (names(record.members) !== names(current.members)) return { rebuild: true, reason: "members-changed" }; // 추가·제거·순서
  for (let i = 0; i < current.members.length; i++) {
    const [br, tip] = current.members[i];
    if ((record.members[i][1] ?? null) !== (tip ?? null)) return { rebuild: true, reason: "member-moved:" + br };
  }
  if ((record.build_cmd ?? null) !== (buildCmd ?? null)) return { rebuild: true, reason: "build-cmd-changed" };
  return { rebuild: false, reason: "up-to-date" };
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

// 위탁 태스크 러너(P2 #869) — 중앙(게이트웨이=내장 노드)과 원격 노드 에이전트가 **공유**하는 실행 헬퍼.
// 태스크 = 워커 세션(tmux) 1개: 프롬프트 파일 → `claude -p "$(cat prompt)" > result.json; echo $? > exit; exec $SHELL`.
//  - 프롬프트는 파일로만 전달(셸 문자열에 사용자 텍스트 미포함 = 인젝션 차단, 경로는 숫자 taskId 로만 구성).
//  - 세션은 완료 후에도 셸로 남아(웹터미널로 사후 검시 가능) — 성공 수집 후 스케줄러가 종료, 실패는 보존.
//  - 완료 감지 = exit 파일 등장(폴링) — 화면 파싱보다 견고(F5).
//  - v1 제약: 워크스페이스는 공유 루트(rootKey=shared)만 — 격리(700) 개인 홈엔 게이트웨이/에이전트가 파일을 못 쓴다.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { LivelyUser } from "../context.js";
import {
  TMUX_BIN, PANE_LOCALE, HARNESSES, resolveRootPath, resolveProfileConfigDir, sessionPrefix, ensureMemberOsUser,
} from "../terminal-sessions.js";
import { wrapAsMember } from "../terminal-isolation.js";
import type { NodeResources } from "./protocol.js";

const execFileAsync = promisify(execFile);

// tmux CLI 호출 — terminal-sessions 의 TMUX_ENV 와 동일한 UTF-8 강제(로케일 사고 방지, 런북 불변식).
const TMUX_ENV: NodeJS.ProcessEnv = (() => {
  const env = { ...process.env };
  if (!/utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "")) {
    env.LANG = "en_US.UTF-8";
    env.LC_CTYPE = "en_US.UTF-8";
  }
  return env;
})();
async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(TMUX_BIN, args, { timeout: 8000, env: TMUX_ENV });
  return stdout;
}

// 가용 메모리(MB) — os.freemem() 은 캐시/inactive 를 빼고 세서 macOS(수십 MB로 나옴)·Linux(MemFree)에서
//  심하게 과소보고한다 → 배치 필터가 멀쩡한 노드를 다 떨군다(e2e 실측). 플랫폼별 '회수 가능 포함' 지표를 쓴다:
//  Linux=/proc/meminfo MemAvailable · macOS=vm_stat(free+inactive+purgeable+speculative). 실패 시 freemem 폴백.
async function memAvailableMb(): Promise<number> {
  try {
    if (process.platform === "linux") {
      const mi = await fsp.readFile("/proc/meminfo", "utf8");
      const m = /MemAvailable:\s+(\d+)\s*kB/.exec(mi);
      if (m) return Math.round(Number(m[1]) / 1024);
    } else if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("vm_stat", [], { timeout: 3000 });
      const page = Number(/page size of (\d+) bytes/.exec(stdout)?.[1] ?? 16384);
      const grab = (k: string): number => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(stdout)?.[1] ?? 0);
      const pages = grab("Pages free") + grab("Pages inactive") + grab("Pages purgeable") + grab("Pages speculative");
      if (pages > 0) return Math.round((pages * page) / 1048576);
    }
  } catch { /* 폴백 */ }
  return Math.round(os.freemem() / 1048576);
}

// ── 리소스 스냅샷(§10) — 상태 push 동봉용. disk 는 주어진 루트(공유 워크스페이스) 기준. ──
export async function sampleResources(diskRoot: string): Promise<NodeResources> {
  let disk = { total: 0, free: 0 };
  try {
    const s = await fsp.statfs(diskRoot);
    disk = { total: (s.blocks * s.bsize) / 1048576, free: (s.bavail * s.bsize) / 1048576 };
  } catch { /* 루트 미존재 등 — 0 으로(스케줄러가 disk 요구 태스크를 안 보냄) */ }
  return {
    cpus: os.cpus().length || 1,
    load1: Math.round((os.loadavg()[0] || 0) * 100) / 100,
    mem_total_mb: Math.round(os.totalmem() / 1048576),
    mem_free_mb: await memAvailableMb(),
    disk_total_mb: Math.round(disk.total),
    disk_free_mb: Math.round(disk.free),
  };
}

export async function detectDocker(): Promise<boolean> {
  try { await execFileAsync("docker", ["--version"], { timeout: 3000 }); return true; }
  catch { return false; }
}

// ── 태스크 스폰 ──
export interface RunTaskInput {
  user: LivelyUser;            // 의뢰자(과금·귀속 신원 — D1: 의뢰자 시트)
  taskId: number;
  rootKey: string;             // v1: 'shared' 만 허용(검증은 호출부)
  subpath: string;             // 공유 루트 하위 작업 폴더(비우면 delegated/<id>)
  prompt: string;
  harness: string;             // v1: 'claude' 만
  flags?: Record<string, string>;  // 화이트리스트(--model/--effort)만 적용
  env?: Record<string, string>;    // 자격 리스(CLAUDE_CODE_OAUTH_TOKEN 등) — 값은 세션 env 로만
}
export interface RunTaskResult { sessionId: string; taskDir: string; workspace: string }

const FLAG_WHITELIST = new Map((HARNESSES.find((h) => h.key === "claude")?.flags ?? []).map((f) => [f.name, f]));

function taskScript(bin: string, flags: string[], taskDir: string): string {
  // 사용자 텍스트는 프롬프트 파일 안에만 있다 — 이 문자열의 가변부는 숫자/화이트리스트 경로뿐.
  //  stream-json = 진행 이벤트를 stream.jsonl 에 줄단위 append → logs tail(파일 오프셋)로 실시간 미러(§11).
  //  최종 결과(type=result)도 그 마지막 줄에 온다. exec $SHELL 로 세션 잔존(실패 시 사후 검시).
  const f = flags.join(" ");
  return `cd "$LIVELY_TASK_WS" && ${bin} -p "$(cat "${taskDir}/prompt.txt")" ${f} --output-format stream-json --verbose --dangerously-skip-permissions > "${taskDir}/stream.jsonl" 2> "${taskDir}/stderr.log"; echo $? > "${taskDir}/exit"; exec "\${SHELL:-sh}"`;
}

export async function spawnTaskSession(input: RunTaskInput): Promise<RunTaskResult> {
  if (input.rootKey !== "shared") throw new Error("위탁 워크스페이스는 공유 루트(shared)만 지원합니다(v1)");
  const harness = HARNESSES.find((h) => h.key === input.harness);
  if (!harness || harness.key !== "claude") throw new Error("위탁 하네스는 claude 만 지원합니다(v1)");
  const user = input.user;
  const id = `${sessionPrefix(user)}${crypto.randomBytes(4).toString("hex")}`; // box-<slug>-hex — 세션 목록/가시성 규칙에 그대로 편입
  // 격리 게이트 — createSession 과 동일 seam(#524): Linux+인프라면 box_ 유저로 drop, 아니면 null(비격리 폴백).
  const osUser = await ensureMemberOsUser(user).catch(() => null);
  const sub = (input.subpath || "").trim() || `delegated/task-${input.taskId}`;
  const { abs: workspace } = await resolveRootPath(user, "shared", sub, osUser ?? null);
  const taskDir = path.join(workspace, ".lively-task", String(input.taskId));
  await fsp.mkdir(taskDir, { recursive: true, mode: 0o770 });
  // 재시도(같은 taskId 재큐) 대비 — 이전 시도의 종결 파일이 남아 있으면 즉시 '가짜 완료'로 오감지된다.
  for (const f of ["exit", "stream.jsonl", "stderr.log"]) await fsp.rm(path.join(taskDir, f), { force: true }).catch(() => { /* noop */ });
  await fsp.writeFile(path.join(taskDir, "prompt.txt"), input.prompt, { mode: 0o660 });

  // 플래그 화이트리스트(--model/--effort, 카탈로그 choices 만) — createSession 과 동일 원칙.
  const flags: string[] = [];
  for (const [name, raw] of Object.entries(input.flags ?? {})) {
    const def = FLAG_WHITELIST.get(name);
    const v = String(raw ?? "");
    if (!def || !v || (def.choices && !def.choices.includes(v))) continue;
    flags.push(name, v);
  }

  const args = ["new-session", "-d", "-s", id];
  args.push("-e", `LANG=${PANE_LOCALE}`, "-e", `LC_CTYPE=${PANE_LOCALE}`, "-e", `LC_ALL=${PANE_LOCALE}`);
  args.push("-e", `LIVELY_TASK_WS=${workspace}`, "-e", `LIVELY_TASK_ID=${input.taskId}`);
  // 자격 리스(§8-3) — setup-token env. 리스가 없으면 노드 로컬 프로필/자격 폴백(중앙=box_ 홈, 멤버 PC=본인 ~/.claude).
  for (const [k, v] of Object.entries(input.env ?? {})) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k)) continue;
    args.push("-e", `${k}=${v}`);
  }
  const script = taskScript(harness.bin, flags, taskDir);
  if (osUser) {
    args.push(...wrapAsMember(osUser, ["sh", "-lc", script], workspace));
  } else {
    const profileDir = await resolveProfileConfigDir(user);
    if (profileDir && !(input.env && input.env.CLAUDE_CODE_OAUTH_TOKEN)) args.push("-e", `CLAUDE_CONFIG_DIR=${profileDir}`);
    args.push("-c", workspace, "sh", "-lc", script);
  }
  await tmux(args);
  const ownerId = user.userId || user.email || "";
  await tmux(["set-option", "-t", id, "@box_owner", ownerId]);
  await tmux(["set-option", "-t", id, "@box_label", `위탁 #${input.taskId}`]);
  await tmux(["set-option", "-t", id, "@box_harness", harness.key]);
  await tmux(["set-option", "-t", id, "@box_dir", workspace]);
  await tmux(["set-option", "-t", id, "@box_auto", "1"]);
  await tmux(["set-option", "-t", id, "@box_task", String(input.taskId)]);
  await tmux(["set-option", "-t", id, "@box_invites", "[]"]);
  return { sessionId: id, taskDir, workspace };
}

// ── 완료 감지·수집 — exit 파일 등장 = 종결. 결과는 상한(8KB)으로 잘라 보고(전문은 taskDir 에 남는다). ──
export interface TaskWatch { taskId: number; sessionId: string; taskDir: string }
export interface TaskOutcome { taskId: number; ok: boolean; exit: number | null; summary?: string; error?: string }

const SUMMARY_CAP = 8 * 1024;

// stream.jsonl 의 마지막 type=result 이벤트에서 최종 텍스트를 뽑는다(claude stream-json 규약).
//  못 찾으면 마지막 비어있지 않은 줄(진행 중 크래시 등) — 요약 목적이라 근사로 충분.
function extractResult(streamJsonl: string): string {
  const lines = streamJsonl.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]) as { type?: string; result?: unknown; is_error?: boolean };
      if (ev.type === "result") return typeof ev.result === "string" ? ev.result : JSON.stringify(ev);
    } catch { /* 부분 줄 — 계속 위로 */ }
  }
  return lines.length ? lines[lines.length - 1] : "";
}

export async function checkTask(w: TaskWatch): Promise<TaskOutcome | null> {
  let exitRaw: string;
  try { exitRaw = (await fsp.readFile(path.join(w.taskDir, "exit"), "utf8")).trim(); }
  catch { return null; } // 아직 실행 중
  const exit = Number.parseInt(exitRaw, 10);
  const code = Number.isFinite(exit) ? exit : null;
  let stream = "";
  try { stream = await fsp.readFile(path.join(w.taskDir, "stream.jsonl"), "utf8"); } catch { /* 결과 없음 */ }
  const summary = extractResult(stream).slice(0, SUMMARY_CAP);
  if (code === 0) return { taskId: w.taskId, ok: true, exit: code, summary };
  let err = "";
  try { err = (await fsp.readFile(path.join(w.taskDir, "stderr.log"), "utf8")).slice(-2048); } catch { /* noop */ }
  return { taskId: w.taskId, ok: false, exit: code, summary, error: err || `exit=${exitRaw}` };
}

// 진행 로그 tail(§11) — stream.jsonl 을 from 바이트부터 읽어 청크 반환. done=exit 파일 존재.
//  중앙(로컬)·원격(노드 RPC 릴레이) 공용. 파일 미존재(claude 시작 전)면 빈 청크.
export interface TailResult { chunk: string; next: number; done: boolean; exit: number | null }
export async function tailTask(taskDir: string, from: number): Promise<TailResult> {
  const p = path.join(taskDir, "stream.jsonl");
  let chunk = "", next = from;
  try {
    const fh = await fsp.open(p, "r");
    try {
      const st = await fh.stat();
      if (st.size > from) {
        const buf = Buffer.allocUnsafe(Math.min(st.size - from, 256 * 1024)); // 청크 상한 256KB
        const { bytesRead } = await fh.read(buf, 0, buf.length, from);
        chunk = buf.subarray(0, bytesRead).toString("utf8");
        next = from + bytesRead;
      } else { next = st.size < from ? st.size : from; } // 재시도로 파일이 짧아졌으면 리셋
    } finally { await fh.close(); }
  } catch { /* 아직 파일 없음 */ }
  let exit: number | null = null, done = false;
  try { const e = (await fsp.readFile(path.join(taskDir, "exit"), "utf8")).trim(); done = true; exit = Number.isFinite(Number(e)) ? Number(e) : null; } catch { /* 실행 중 */ }
  return { chunk, next, done, exit };
}

// 세션 강제 종료(수집 후 정리·타임아웃·취소). 없는 세션은 무시.
export async function killTaskSession(sessionId: string): Promise<void> {
  try { await tmux(["kill-session", "-t", sessionId]); } catch { /* 이미 없음 */ }
}

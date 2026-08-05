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
  TMUX_BIN, PANE_LOCALE, HARNESSES, resolveRootPath, resolveProfileConfigDir, profileConfigDir, sessionPrefix, ensureMemberOsUser,
} from "../terminal/terminal-sessions.js";
import { wrapAsMember, isolationInfraReady } from "../terminal/terminal-isolation.js";
import { provisionTaskRepo, type RepoProvisionAuth } from "../project/project-provision.js";
// 공유폴더 그룹쓰기 계약(2770/660) — 위탁 작업 폴더도 격리 워커(box_<멤버>)가 써야 하므로 같은 계약을 적용한다.
import { grantSharedGroupWrite, SHARED_FILE_MODE } from "../project/project-fs.js";
import type { NodeResources } from "./protocol.js";
import { deriveWriteCap } from "../terminal/terminal-sessions.js";
import { memAvailableMb } from "../ops/host-mem.js"; // #1059 공용 메모리 지표(백필 게이트와 단일 소스)

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

// 가용 메모리(MB) 산출은 host-mem.ts 로 추출됨(#1059 — 임베딩 백필 pre-flight 게이트와 공용, 로직 단일화). memAvailableMb import.

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
  repo?: string | null;        // 지정 시 게이트웨이가 공유 base clone→worktree 자동 provision, cwd=worktree(#458 재사용)
  gitRef?: string | null;      // worktree 분기 기준 브랜치(origin/<ref>) — 없으면 base HEAD
  flags?: Record<string, string>;  // 화이트리스트(--model/--effort)만 적용
  env?: Record<string, string>;    // 자격 리스(CLAUDE_CODE_OAUTH_TOKEN 등) — 값은 세션 env 로만
  // 레포 provision 주입(#905 C4) — **노드엔 DB 가 없다**. 게이트웨이가 레지스트리 git_url + (의뢰자 본인) git 자격을
  //  조회해 실어 보낸다. 없으면 노드는 종전대로 DB 를 읽으려다 실패하고 "레지스트리에 없다"는 오진을 낸다.
  //  중앙(게이트웨이 내장 노드) 실행 시엔 미설정 — 거기선 DB 를 직접 읽는 게 정상이다.
  repoAuth?: RepoProvisionAuth;
}
export interface RunTaskResult { sessionId: string; taskDir: string; workspace: string }

const FLAG_WHITELIST = new Map((HARNESSES.find((h) => h.key === "claude")?.flags ?? []).map((f) => [f.name, f]));

export function taskScript(bin: string, flags: string[], taskDir: string): string {
  // 사용자 텍스트는 프롬프트 파일 안에만 있다 — 이 문자열의 가변부는 숫자/화이트리스트 경로뿐.
  //  stream-json = 진행 이벤트를 stream.jsonl 에 줄단위 append → logs tail(파일 오프셋)로 실시간 미러(§11).
  //  최종 결과(type=result)도 그 마지막 줄에 온다. exec $SHELL 로 세션 잔존(실패 시 사후 검시).
  //
  // ⚠ 프롬프트는 **stdin 리다이렉션**으로 넣는다(`< prompt.txt`). 종전엔 `-p "$(cat prompt.txt)"` 로 argv 에
  //  펼쳤는데, 리눅스는 인자 하나가 MAX_ARG_STRLEN(32×4096 = 131,072B)을 넘으면 exec 이 E2BIG 으로 죽는다
  //  (실측 2026-07-31: 130,998B exit=0 / 135,000B exit=126 "Argument list too long"). 그 실패는 특히 고약하다 —
  //  claude 가 **실행조차 안 되므로** stream.jsonl 이 0줄이고, 위탁은 exit≠0 으로 실패하며, 배치 롤백 때문에
  //  같은 프롬프트가 영원히 재시도된다(진행 0). 프롬프트에 자료 본문을 싣기 시작하면서(#1289) 현실적 위험이 됐다.
  //  파이프(`cat … | bin`)가 아니라 리다이렉션인 이유: 파이프라인의 $? 는 마지막 명령의 것이라 cat 실패가
  //  통째로 가려진다. `< file` 은 파일이 없으면 셸이 그 자리에서 실패시키고 그 코드가 그대로 exit 에 남는다.
  const f = flags.join(" ");
  return `cd "$LIVELY_TASK_WS" && ${bin} -p ${f} --output-format stream-json --verbose --dangerously-skip-permissions < "${taskDir}/prompt.txt" > "${taskDir}/stream.jsonl" 2> "${taskDir}/stderr.log"; echo $? > "${taskDir}/exit"; exec "\${SHELL:-sh}"`;
}

// 위탁 작업 폴더(.lively-task/<id>) 준비 — 워커가 결과를 쓸 수 있는 상태로 만든다. 테스트 seam(tasks.test).
//
// ⚠ 이 함수의 존재 이유는 **권한**이다. `mkdir` 의 mode 는 umask 에 깎인다(중앙 박스 umask 022 → 0o770 이 0750).
//  워커는 box_<멤버> uid 로 돌고 이 폴더는 게이트웨이(lively) 소유라, 그룹 쓰기가 빠지면 taskScript 의 리다이렉트가
//  전부 EACCES 로 죽는다:
//   · `> stream.jsonl` 실패 → **claude 가 아예 실행되지 않는다**
//   · `2> stderr.log` 도 같은 폴더 → **그 실패조차 어디에도 안 남는다**
//   · `echo $? > exit` 실패 → 종결 신호가 없어 작업이 **타임아웃(1h)까지 '실행 중'으로 매달린다**(무증상 무한대기)
//  실측(고객사 A 실박스, 2026-07-30): 그 박스의 위탁 태스크 2건 모두 stream.jsonl·exit 부재로 이 상태였다 —
//  헤드리스 위탁이 **한 번도 성공한 적이 없었다**. 크론 요약의 status=ok 는 '접수 성공'이라 실패가 조용히 묻혔다.
//  공유폴더(createProjectFolder)·프로젝트 경로는 이미 같은 이유로 2770 을 별도 chmod 로 보장하는데
//  (project-fs.ts — "chmod 는 umask 에 안 깎이게 별도") 위탁 경로만 그 계약에서 빠져 있었다.
export async function prepareTaskDir(baseWs: string, sharedBase: string, taskId: number | string, prompt: string): Promise<string> {
  const taskDir = path.join(baseWs, ".lively-task", String(taskId));
  await fsp.mkdir(taskDir, { recursive: true, mode: 0o770 });
  // chmod 는 umask 와 무관 — mkdir 이 깎인 만큼을 여기서 되돌린다. 체인 전체(sharedBase 미포함)를 훑으므로
  //  이전 배포가 남긴 750 폴더도 다음 실행에서 자가 복구된다(멱등·best-effort).
  await grantSharedGroupWrite(taskDir, sharedBase, "dir");
  // 재시도(같은 taskId 재큐) 대비 — 이전 시도의 종결 파일이 남아 있으면 즉시 '가짜 완료'로 오감지된다.
  for (const f of ["exit", "stream.jsonl", "stderr.log"]) await fsp.rm(path.join(taskDir, f), { force: true }).catch(() => { /* noop */ });
  await fsp.writeFile(path.join(taskDir, "prompt.txt"), prompt, { mode: 0o660 });
  await fsp.chmod(path.join(taskDir, "prompt.txt"), SHARED_FILE_MODE).catch(() => { /* best-effort */ });
  return taskDir;
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
  const { base: sharedBase, abs: baseWs } = await resolveRootPath(user, "shared", sub, osUser ?? null);
  // 레포 지정(#458 재사용) — 공유 base clone→worktree 자동 provision, 워커 cwd=worktree. .lively-task 는 worktree 밖(baseWs)에
  //  둬 레포를 오염시키지 않는다(untracked). 미지정이면 빈 워크스페이스(cwd=baseWs, 프롬프트가 알아서 준비).
  let workspace = baseWs;
  if (input.repo) {
    workspace = await provisionTaskRepo(
      baseWs, input.taskId, String(input.repo), input.gitRef ?? null, (user.userId || user.email || null),
      input.repoAuth,   // 노드 실행이면 게이트웨이가 실어 보낸 주입(없으면 중앙 실행 → DB 직접 읽기)
    );
  }
  const taskDir = await prepareTaskDir(baseWs, sharedBase, input.taskId, input.prompt);

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
  // #1291 v2 — 위탁 세션도 세션 신원과 기록 범위를 갖는다. 지금까지 LIVELY_SESSION_ID 조차 안 실어
  //  이 경로의 AI 는 **항상 전체 공개로** 기록했다(잠긴 프로젝트를 위탁해도 마찬가지였다).
  //  세션 id 를 실어야 게이트웨이가 캡을 조회할 수 있고, 캡은 tmux 옵션(아래)이 권위다.
  args.push("-e", `LIVELY_SESSION_ID=${id}`);
  // 자격 리스(§8-3) — setup-token env. 리스가 없으면 노드 로컬 프로필/자격 폴백(중앙=box_ 홈, 멤버 PC=본인 ~/.claude).
  for (const [k, v] of Object.entries(input.env ?? {})) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k)) continue;
    args.push("-e", `${k}=${v}`);
  }
  const script = taskScript(harness.bin, flags, taskDir);
  if (osUser) {
    args.push(...wrapAsMember(osUser, ["sh", "-lc", script], workspace));
  } else {
    // #1014: 격리 인프라가 준비된 중앙(멀티유저) 박스에서는 비격리 폴백이 공유 $HOME/.claude.json(=설치 때 구워진
    //  남의 lively 토큰)을 읽지 못하게 — 항상 이 멤버 전용 dir 로 격리(공유 폴백 폐기).
    //  ⚠ CLAUDE_CONFIG_DIR(=claude 가 lively MCP 를 읽는 위치)은 CLAUDE_CODE_OAUTH_TOKEN(Anthropic 인증)과 **직교**다.
    //   그래서 중앙 박스 분기는 리스(setup-token)가 있어도 **무조건** 자기 dir 을 박는다 — 그러지 않으면 리스를 든
    //   요청자가 'central' 로 위탁할 때 공유 config(남의 신원)로 폴백하는 구멍이 남는다(리뷰 지적).
    //  워커 노드(멤버 PC=단일유저, 인프라 미준비)만 종전 로컬 폴백 + 리스 시 CLAUDE_CONFIG_DIR 생략($HOME/.claude=본인).
    if (isolationInfraReady() && process.env.LIVELY_MULTIPROFILE !== "0") {
      const profileDir = profileConfigDir(user);
      await fsp.mkdir(profileDir, { recursive: true, mode: 0o700 });
      args.push("-e", `CLAUDE_CONFIG_DIR=${profileDir}`);
    } else {
      const profileDir = await resolveProfileConfigDir(user);
      if (profileDir && !(input.env && input.env.CLAUDE_CODE_OAUTH_TOKEN)) args.push("-e", `CLAUDE_CONFIG_DIR=${profileDir}`);
    }
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
  // 기록 범위(#1291 v2) — 작업 폴더에서 파생해 박는다. 잠긴 프로젝트를 위탁했으면 그 범위로 좁혀지고,
  //  공개 폴더면 종전대로 open 이다(비파괴). 실패해도 위탁 자체는 진행한다 — 그때는 게이트웨이가 조회 시 다시 파생한다.
  try {
    const cap = await deriveWriteCap(workspace);
    if (cap !== "open") await tmux(["set-option", "-t", id, "@box_write_vis", cap]);
  } catch { /* 비치명 — 조회 시점 파생으로 폴백 */ }
  // 위탁 세션은 초대 없음(의뢰자 전용). ⚠ 여기만 평문 "[]" 인 이유: 빈 배열엔 따옴표가 없어 psmux 에서도
  //  무손실이고(#1541), decodeOptJson 이 `[` 로 시작하는 값을 레거시 평문 경로로 정확히 읽는다. 이 한 값 때문에
  //  노드 번들에 tmux-exec 의존을 새로 들이지 않는다.
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

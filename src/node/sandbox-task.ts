// 맥락 잡 **샌드박스 판** — 코어 쪽 (#4012 T3 L1).
//
// ── 무엇 ────────────────────────────────────────────────────────────────────
// 매니지드 CP 박스에는 root 소켓 op(`/run/lvly/task/op.sock` · lvly-cloud `lvly-task-op`)가 있다. 게이트웨이는
//  비-root·NoNewPrivileges 라 판을 직접 못 띄우므로(지금 판이 sudo 에서 즉사하는 자리), 입력·자격을 op 에 넘기고
//  op 가 systemd 일시 유닛(일회용 uid · 허용목록 루트 · 사설망 차단)으로 띄운다. 판은 게이트웨이의 자식이 아니다 —
//  롤·재시작에 안 끊긴다(실측: op 를 멈춰도 판 active). 설계: 지식 context-job-sandbox-design-4012.
//
// ── 이 파일이 지는 것 ────────────────────────────────────────────────────────
//  ① op 클라이언트(한 연결 = 한 op) ② 판 안 스크립트·MCP 설정 조립(순수) ③ 종결 판정(순수)
//  ④ 띄우기·감시·정지·치우기 배선. 스케줄러(task-scheduler)와 위탁 도구(delegate)만 부른다 — 노드 번들 밖이다.
//
// ── 좌표 ────────────────────────────────────────────────────────────────────
//  node_id = `central`(종전 어휘) · session_id = `box-<멤버>-<8hex>`(MCP 세션 헤더 규약 EXECUTION_SESSION_ID_RE) ·
//  task_dir = `<op 뿌리>/<slug>/<task>-a<n>/out`. **task_dir 이 op 뿌리 아래면 샌드박스 판이다.**
//  ⚠ 그 폴더는 게이트웨이가 **직접** 읽는다(root:lvly-gw 0640). 멤버 경계 중계(taskFsFor(osUser))로 읽으면 안 된다 —
//   파일 헬퍼 감옥에는 이 자리가 없어서 «아직 실행 중» 으로 영원히 보인다.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  HEADLESS, SUMMARY_CAP, extractResult, harnessFlagArgs, localTaskFs,
  type RunTaskInput, type RunTaskResult, type TaskOutcome,
} from "./tasks.js";
import { sessionPrefix } from "../terminal/terminal-sessions.js";

// ── 자리 ────────────────────────────────────────────────────────────────────
/** op 소켓 — lvly-cloud `lvly-task-op.socket` 의 ListenStream 과 같은 값(root:lvly-gw 0660). */
export const sandboxOpSock = (): string => process.env.LIVELY_TASK_OP_SOCK || "/run/lvly/task/op.sock";
/** op 작업 폴더 뿌리 — lvly-cloud `TASK_DATA_ROOT` 와 같은 값. */
export const sandboxDataRoot = (): string => (process.env.LIVELY_TASK_DATA_ROOT || "/var/lib/lvly/tasks").replace(/\/+$/, "");
/** 이 판을 띄우는 op 프로필. 허용목록(파일·자격·env)은 op 쪽 표가 쥔다. */
export const SANDBOX_PROFILE = "context";
/** 맥락 잡 표지(org_task.exec_profile) — 증류·분류·관리가 싣는다. */
export const CONTEXT_EXEC_PROFILE = "context";
/** 샌드박스가 돌릴 수 있는 하네스 — op 프로필 표의 `harnesses` 와 같아야 한다. */
export const SANDBOX_HARNESSES: readonly string[] = Object.freeze(["claude", "codex"]);
/** 판 안 규약 종료코드 — 게이트웨이가 사유 문장으로 옮긴다. */
export const SANDBOX_EXIT_GATEWAY = 69;
export const SANDBOX_EXIT_NOCRED = 70;

/**
 * 이 박스에서 샌드박스 판을 띄울 수 있나 — **소켓이 있으면** 그렇다(기능 탐지).
 *  lvly-cloud 배포가 소켓을 깔기 전에는 false 라 종전 경로를 그대로 탄다(두 레포 배포 순서 무관).
 *  `LIVELY_TASK_SANDBOX=off` 는 되돌림 스위치다.
 */
export function sandboxAvailable(): boolean {
  if ((process.env.LIVELY_TASK_SANDBOX || "").trim().toLowerCase() === "off") return false;
  try { return fs.statSync(sandboxOpSock()).isSocket(); } catch { return false; }
}

export function isContextJob(t: { exec_profile?: string | null }): boolean {
  return t.exec_profile === CONTEXT_EXEC_PROFILE;
}

/**
 * 이 태스크를 어디에 둘 수 있나(순수) — 스케줄러 후보의 틀.
 *  · op 가 없는 박스(셀프호스트) → 종전 그대로: 중앙(tmux) + 원격.
 *  · op 가 있는 박스(매니지드)의 맥락 잡 → **중앙 샌드박스만**. 멤버 PC·워커로 나가지 않는다(상민님 2026-09-16 결정 —
 *    배치 크기·주기를 우리가 정하는 잡이라 워커가 필요 없고, 멤버 노드로 새면 윈도우 셸 노드에 먼저 꽂히던 사고가 난다).
 *  · op 가 있는 박스의 그 밖 위탁 → 중앙은 후보가 **아니다**. 그 판(tmux + 멤버 격리)은 매니지드 CP 에서 설 수 없으므로
 *    후보로 내면 매번 스폰 오류로 죽는다 — 정직하게 빼고 원격만 본다.
 */
export function schedulingRoute(sandbox: boolean, contextJob: boolean): { central: "sandbox" | "tmux" | null; remotes: boolean } {
  if (!sandbox) return { central: "tmux", remotes: true };
  if (contextJob) return { central: "sandbox", remotes: false };
  return { central: null, remotes: true };
}

// ── 좌표 ────────────────────────────────────────────────────────────────────
export interface SandboxCoords { slug: string; taskId: number; attempt: number; unit: string; base: string }
const DIR_TAIL = /^([a-z0-9][a-z0-9-]{0,62})\/([1-9][0-9]{0,15})-a([1-9][0-9]{0,3})\/out$/;

/** task_dir → 판 좌표(순수). op 뿌리 밖·모양 밖이면 null(= 샌드박스 판이 아니다). */
export function sandboxCoordsOfDir(dir: string | null | undefined, root: string = sandboxDataRoot()): SandboxCoords | null {
  const d = String(dir ?? "");
  if (!d.startsWith(`${root}/`)) return null;
  const m = DIR_TAIL.exec(d.slice(root.length + 1));
  if (!m) return null;
  const taskId = Number(m[2]);
  if (!Number.isSafeInteger(taskId)) return null;
  return {
    slug: m[1]!, taskId, attempt: Number(m[3]),
    unit: `lvly-task-${m[1]}-${m[2]}-a${m[3]}`,
    base: d.slice(0, -"/out".length),
  };
}
export const isSandboxTaskDir = (dir: string | null | undefined): boolean => sandboxCoordsOfDir(dir) !== null;

// ── op 클라이언트 ────────────────────────────────────────────────────────────
export interface TaskOpPart { name: string; data: Buffer }
export interface TaskOpReply { ok: boolean; code?: string; error?: string; [k: string]: unknown }

/**
 * op 한 번 — 머리말 한 줄 + (launch 면) 파일·자격 본문을 보내고 쓰기를 닫은 뒤, 응답 한 줄을 받는다.
 *  ⚠ 던지지 않는다 — 못 닿음·시간초과·깨진 응답도 코드 달린 응답으로 접는다(호출부가 코드로 가른다).
 *  ⚠ 자격 본문은 어디에도 기록하지 않는다(오류 문장에도 안 싣는다).
 */
export async function callTaskOp(
  header: Record<string, unknown>,
  parts: { files?: TaskOpPart[]; creds?: TaskOpPart[] } = {},
  opts: { sock?: string; timeoutMs?: number } = {},
): Promise<TaskOpReply> {
  const files = parts.files ?? [];
  const creds = parts.creds ?? [];
  const head: Record<string, unknown> = { v: 1, ...header };
  if (head.op === "launch") {
    head.files = files.map((f) => ({ name: f.name, size: f.data.length }));
    head.creds = creds.map((f) => ({ name: f.name, size: f.data.length }));
  }
  const ms = opts.timeoutMs ?? 15_000;
  return await new Promise<TaskOpReply>((resolve) => {
    const sock = net.createConnection(opts.sock ?? sandboxOpSock());
    let buf = "";
    let settled = false;
    const done = (r: TaskOpReply): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const parse = (line: string): void => {
      try {
        const v = JSON.parse(line) as unknown;
        if (v && typeof v === "object" && typeof (v as TaskOpReply).ok === "boolean") done(v as TaskOpReply);
        else done({ ok: false, code: "op_bad_reply", error: `응답 모양이 다르다: ${line.slice(0, 200)}` });
      } catch { done({ ok: false, code: "op_bad_reply", error: `응답이 JSON 이 아니다: ${line.slice(0, 200)}` }); }
    };
    const timer = setTimeout(() => done({ ok: false, code: "op_timeout", error: `op 가 ${ms}ms 안에 답하지 않았다` }), ms);
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) parse(buf.slice(0, nl));
    });
    sock.on("end", () => {
      if (buf.trim()) parse(buf.trim());
      else done({ ok: false, code: "op_bad_reply", error: "op 가 응답 없이 끊었다" });
    });
    sock.on("error", (e: NodeJS.ErrnoException) => done({ ok: false, code: "op_unreachable", error: e.code || e.message }));
    sock.on("connect", () => {
      sock.write(JSON.stringify(head) + "\n");
      for (const p of [...files, ...creds]) sock.write(p.data);
      sock.end();
    });
  });
}

// ── 판 안 조립(순수) ─────────────────────────────────────────────────────────
const SAFE_GW = /^https?:\/\/[A-Za-z0-9._-]+(:\d{1,5})?$/;
/** 게이트웨이가 MCP 호출을 누가 했는지 가르는 헤더 값(kit 프록시와 같은 어휘). */
const HARNESS_STAMP: Readonly<Record<string, string>> = Object.freeze({ claude: "claude-code", codex: "codex" });

export interface SandboxScriptInput {
  harness: string;
  /** harnessFlagArgs 를 통과한 인자(화이트리스트) — 여기서 다시 거르지 않는다. */
  flags: string[];
  systemPrompt: boolean;
  bypassPermissions: boolean;
  gatewayUrl: string;
}

/**
 * 판 안에서 도는 `run.sh`(순수). op 가 `/task/in/run.sh` 로 두고 일회용 uid 로 돌린다.
 *  stdout 이 곧 `out/stream.jsonl` 이다 — 하네스의 진행 스트림이 그대로 결과 파일이 된다.
 *  ① 게이트웨이 도달을 **먼저** 확인한다(#3994 ③) — 공인 주소 전제가 깨진 날 MCP 없이 조용히 빈손으로 끝나지 않게.
 *  ② 자격은 파일에서 읽어 이 프로세스에만 싣는다(env·명령줄에 비밀을 두지 않는 op 규율의 연장).
 *  ③ 하네스 실행은 HEADLESS 표 그대로 — 대화형 세션과 위탁 경로가 같은 명령을 쓴다.
 */
export function sandboxRunScript(i: SandboxScriptInput): string {
  const spec = HEADLESS[i.harness];
  if (!spec || !SANDBOX_HARNESSES.includes(i.harness)) throw new Error(`샌드박스가 돌릴 수 없는 하네스: ${i.harness}`);
  if (!SAFE_GW.test(i.gatewayUrl)) throw new Error(`게이트웨이 주소가 형식 밖이다: ${i.gatewayUrl}`);
  const bypass = i.bypassPermissions === false ? "" : ` ${spec.bypassFlag}`;
  const bin = '"$LVLY_HARNESS_BIN"';
  const lines = [
    "#!/bin/sh",
    "# lively 맥락 잡 판 (#4012) — lvly-task-op 이 판 안에서 일회용 uid 로 돌린다. 코어(sandbox-task.ts)가 만든다.",
    "set -u",
    'mkdir -p "$HOME"',
    `cd /task/work || exit ${SANDBOX_EXIT_NOCRED}`,
    'if ! curl -fsS -m 10 -o /dev/null "$LIVELY_GATEWAY_URL/healthz"; then',
    '  echo "lvly-task: 게이트웨이($LIVELY_GATEWAY_URL)에 닿지 않는다 — MCP 없이 돌지 않는다" >&2',
    `  exit ${SANDBOX_EXIT_GATEWAY}`,
    "fi",
    `LIVELY_MCP_TOKEN=$(cat "$CREDENTIALS_DIRECTORY/lively" 2>/dev/null) || { echo "lvly-task: 판에 lively 자격이 없다" >&2; exit ${SANDBOX_EXIT_NOCRED}; }`,
    "export LIVELY_MCP_TOKEN",
  ];
  if (i.harness === "claude") {
    const f = [
      ...i.flags,
      "--mcp-config", "/task/in/mcp.json", "--strict-mcp-config",
      ...(i.systemPrompt ? ["--append-system-prompt-file", "/task/in/system.md"] : []),
    ].join(" ");
    lines.push(
      `CLAUDE_CODE_OAUTH_TOKEN=$(cat "$CREDENTIALS_DIRECTORY/anthropic" 2>/dev/null) || { echo "lvly-task: 판에 claude 자격이 없다" >&2; exit ${SANDBOX_EXIT_NOCRED}; }`,
      "export CLAUDE_CODE_OAUTH_TOKEN",
      'export CLAUDE_CONFIG_DIR="$HOME/.claude"',
      //  `3>&-` — 반환 채널(fd 3)은 **이 스크립트만** 쓴다. 하네스와 그 도구(에이전트의 셸)가 물려받으면
      //   판 안 에이전트가 게이트웨이가 믿는 자리에 아무거나 쓸 수 있다.
      `${spec.run(bin, f, "/task/in/prompt.txt", bypass)} 3>&-`,
      "exit $?",
    );
  } else {
    //  codex 는 MCP 를 명령줄 설정(-c)으로 받는다 — url·bearer env·세션 헤더(env 에서)·하네스 헤더(정적). 실측 0.154.0 해석 확인.
    const f = [
      ...i.flags,
      "--skip-git-repo-check",
      `-c 'mcp_servers.lively.url="${i.gatewayUrl}/mcp"'`,
      `-c 'mcp_servers.lively.bearer_token_env_var="LIVELY_MCP_TOKEN"'`,
      `-c 'mcp_servers.lively.env_http_headers={"x-lively-session"="LIVELY_SESSION_ID"}'`,
      `-c 'mcp_servers.lively.http_headers={"x-lively-harness"="${HARNESS_STAMP.codex}"}'`,
    ].join(" ");
    lines.push(
      'export CODEX_HOME="$HOME/.codex"',
      'mkdir -p "$CODEX_HOME"',
      `install -m 600 "$CREDENTIALS_DIRECTORY/codex-auth" "$CODEX_HOME/auth.json" 2>/dev/null || { echo "lvly-task: 판에 codex 자격이 없다" >&2; exit ${SANDBOX_EXIT_NOCRED}; }`,
      `${spec.run(bin, f, "/task/in/prompt.txt", bypass)} 3>&-`,
      "rc=$?",
      //  codex 는 토큰을 갱신하면 auth.json 을 다시 쓴다 — 버리면 저장된 자격이 낡는다. 달라졌을 때만 반환 채널(fd 3)로.
      'if ! cmp -s "$CREDENTIALS_DIRECTORY/codex-auth" "$CODEX_HOME/auth.json"; then cat "$CODEX_HOME/auth.json" >&3 2>/dev/null; fi',
      'exit "$rc"',
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * claude 의 MCP 설정(순수) — http 로 게이트웨이에 **직결**한다(판 안엔 kit·stdio 프록시가 없다).
 *  헤더의 `${VAR}` 는 claude 가 실행 시점에 판 env 로 채운다 — 토큰 값이 파일에 남지 않는다.
 */
export function sandboxMcpConfig(gatewayUrl: string, harness: string = "claude"): string {
  if (!SAFE_GW.test(gatewayUrl)) throw new Error(`게이트웨이 주소가 형식 밖이다: ${gatewayUrl}`);
  return JSON.stringify({
    mcpServers: {
      lively: {
        type: "http",
        url: `${gatewayUrl}/mcp`,
        headers: {
          Authorization: "Bearer ${LIVELY_MCP_TOKEN}",
          "x-lively-session": "${LIVELY_SESSION_ID}",
          "x-lively-harness": HARNESS_STAMP[harness] ?? harness,
        },
      },
    },
  });
}

// ── 종결 판정(순수) ──────────────────────────────────────────────────────────
export interface SandboxUnitState { load: string; active: string; result: string; exec_code: string; exec_status: string }
export type SandboxVerdict =
  | { state: "running" }
  | { state: "done"; ok: boolean; exit: number | null; reason: string | null };

interface EndLine { nonce: string; exit_code: string; exit_status: string; result: string }

/** 스트림 꼬리에서 **nonce 가 맞는** 마지막 종료 줄. nonce 를 모르면(메타 못 읽음) 어떤 줄도 믿지 않는다. */
export function lastEndLine(tail: string, nonce: string | null): EndLine | null {
  if (!nonce) return null;
  const lines = String(tail ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (!l.includes("lvly_task_end")) continue;
    try {
      const v = JSON.parse(l) as Record<string, unknown>;
      if (v.type === "lvly_task_end" && v.nonce === nonce) {
        return { nonce, exit_code: String(v.exit_code ?? ""), exit_status: String(v.exit_status ?? ""), result: String(v.result ?? "") };
      }
    } catch { /* 부분 줄 — 무시 */ }
  }
  return null;
}

/** systemd 가 exec 준비에서 실패할 때 남기는 상태값 — 사람 말로(systemd.exec(5) «PROCESS EXIT CODES»). */
const EXEC_STATUS_TEXT: Readonly<Record<string, string>> = Object.freeze({
  "200": "작업 폴더로 못 들어갔다(200/CHDIR)",
  "203": "실행 파일을 못 띄웠다(203/EXEC)",
  "217": "일회용 계정을 못 세웠다(217/USER)",
  "226": "샌드박스를 세우지 못했다(226/NAMESPACE)",
  "243": "자격을 판에 넣지 못했다(243/CREDENTIALS)",
});

function endReason(e: EndLine, exit: number | null): string {
  if (e.result === "timeout") return "시간 상한을 넘겨 멈췄다(timeout)";
  if (e.result === "oom-kill") return "메모리 상한을 넘었다(oom-kill)";
  if (exit === SANDBOX_EXIT_GATEWAY) return `판에서 게이트웨이에 닿지 못했다(exit ${SANDBOX_EXIT_GATEWAY})`;
  if (exit === SANDBOX_EXIT_NOCRED) return `판에 자격이 없었다(exit ${SANDBOX_EXIT_NOCRED})`;
  if (e.exit_code === "killed" || e.exit_code === "dumped") return `신호로 끝났다(${e.exit_status}, ${e.result})`;
  if (exit !== null) return `exit ${exit} (${e.result || "?"})`;
  return `판이 실패로 끝났다(${e.result || "?"} ${e.exit_code}/${e.exit_status})`;
}

/**
 * 판이 끝났나·어떻게 끝났나(순수).
 *  · nonce 가 맞는 종료 줄 → 그것이 권위(성공 = result success · exit 0).
 *  · 종료 줄이 없고 유닛이 실패로 남았다 → D-Bus 사유(샌드박스 기동 실패는 종료 줄이 **안 남는다** — 실측).
 *  · 종료 줄이 없고 유닛도 없다 → «기록 없이 사라짐» 실패(재부팅·수동 정리). ⚠ 호출부는 상태를 **먼저** 보고
 *    스트림을 **나중에** 읽어야 이 판정이 «방금 끝나 치워진 판» 을 오판하지 않는다.
 *  · 상태를 못 봤다(null) → 모름은 진행 중이다(끝났다고 단정하면 멀쩡한 판을 실패로 확정한다).
 */
export function judgeSandboxTask(i: { tail: string; nonce: string | null; unit: SandboxUnitState | null }): SandboxVerdict {
  const end = lastEndLine(i.tail, i.nonce);
  if (end) {
    const exit = end.exit_code === "exited" && /^\d+$/.test(end.exit_status) ? Number(end.exit_status) : null;
    const ok = end.result === "success" && exit === 0;
    return { state: "done", ok, exit, reason: ok ? null : endReason(end, exit) };
  }
  if (!i.unit) return { state: "running" };
  if (i.unit.load === "not-found") {
    return { state: "done", ok: false, exit: null, reason: "판이 종료 기록 없이 사라졌다(박스 재부팅·수동 정리 추정)" };
  }
  if (i.unit.active === "failed") {
    const exit = i.unit.exec_code === "1" && /^\d+$/.test(i.unit.exec_status) ? Number(i.unit.exec_status) : null;
    const known = EXEC_STATUS_TEXT[i.unit.exec_status];
    const reason = known ?? `판이 실패로 끝났다(${i.unit.result || "?"} ${i.unit.exec_code}/${i.unit.exec_status})`;
    return { state: "done", ok: false, exit, reason };
  }
  return { state: "running" };
}

// ── 배선 ────────────────────────────────────────────────────────────────────

/** 박스가 가득 찼다 — 스케줄러는 «자리 부족»(배압)으로 다룬다. */
export class SandboxBusyError extends Error {
  constructor(message: string) { super(message); this.name = "SandboxBusyError"; }
}

async function bindSessionToCurrentTenant(sessionId: string): Promise<void> {
  const { currentTenant } = await import("../org/tenant-context.js");
  const t = currentTenant();
  if (!t) return;
  const { PRIMARY_TENANT_ID, setSessionWorkspace } = await import("../org/tenancy/registry.js");
  if (t.id !== PRIMARY_TENANT_ID) await setSessionWorkspace(sessionId, t.id);
}

/**
 * 샌드박스 판을 띄운다. 반환 좌표는 `markRunning` 에 그대로 간다.
 *
 *  ★ 세션 → 워크스페이스 바인딩을 **판보다 먼저** 한다. markRunning 이 하는 바인딩은 판이 뜬 뒤라, 판의 첫 MCP 호출이
 *   그보다 빠르면 primary 로 떨어진다(#1631 이 적어 둔 «남의 워크스페이스 id 를 보고 저장 거부» 모양).
 *  ★ 자격 원본은 op 가 판 안으로 옮기고 지운다. 여기서는 본문을 소켓으로만 흘린다.
 *  ⚠ 실패하면 방금 발급한 MCP 토큰을 **회수한다** — 뜨지도 않은 판의 자격이 살아 남지 않게.
 */
/** 띄우기의 바깥 의존성 — 시험이 DB 없이 순서·회수를 잰다(leaseEnvFor 와 같은 주입 관례). */
export interface SandboxSpawnDeps {
  mint(member: string, sessionId: string): Promise<string | null>;
  revoke(sessionId: string): Promise<unknown>;
  bind(sessionId: string): Promise<void>;
  call: typeof callTaskOp;
}

async function defaultSpawnDeps(): Promise<SandboxSpawnDeps> {
  const { mintSessionMcpToken, revokeSessionHookToken } = await import("../terminal/profiles.js");
  return { mint: mintSessionMcpToken, revoke: revokeSessionHookToken, bind: bindSessionToCurrentTenant, call: callTaskOp };
}

export async function spawnSandboxTask(
  input: RunTaskInput & { attempt: number; timeoutSec?: number },
  inject: Partial<SandboxSpawnDeps> = {},
): Promise<RunTaskResult> {
  const harness = input.harness;
  if (!SANDBOX_HARNESSES.includes(harness)) throw new Error(`샌드박스가 돌릴 수 없는 하네스입니다: ${harness}`);
  const gw = String(input.gatewayUrl ?? "");
  if (!SAFE_GW.test(gw)) throw new Error("게이트웨이 주소를 모른다 — 판이 MCP 로 붙을 곳이 없다(org 프로필 gateway_url·PUBLIC_URL)");
  const slug = String(input.tenantSlug ?? "");
  if (!slug) throw new Error("워크스페이스 slug 를 모른다 — 샌드박스 판은 워크스페이스 컨텍스트 안에서만 띄운다");
  const taskId = Number(input.taskId);
  if (!Number.isSafeInteger(taskId) || taskId < 1) throw new Error(`샌드박스 판은 숫자 태스크 id 가 필요하다: ${input.taskId}`);
  const runner = input.user.userId || input.user.email || "";

  const creds: TaskOpPart[] = [];
  if (harness === "claude") {
    const tok = input.env?.CLAUDE_CODE_OAUTH_TOKEN;
    if (!tok) throw new Error(`실행 멤버(${runner})의 claude 자격(claude_setup_token)이 없다`);
    creds.push({ name: "anthropic", data: Buffer.from(tok, "utf8") });
  } else {
    const auth = input.env?.CODEX_AUTH_JSON;
    if (!auth) throw new Error(`실행 멤버(${runner})의 codex 자격(codex_auth_json)이 없다`);
    creds.push({ name: "codex-auth", data: Buffer.from(auth, "utf8") });
  }

  //  기본 의존성은 **빠진 것이 있을 때만** 불러온다 — 시험이 전부 주입하면 DB 모듈을 끌어오지 않는다.
  const complete = inject.mint && inject.revoke && inject.bind && inject.call;
  const d = { ...(complete ? {} : await defaultSpawnDeps()), ...inject } as SandboxSpawnDeps;
  const sessionId = `${sessionPrefix(input.user)}${crypto.randomBytes(4).toString("hex")}`;
  const mcpToken = await d.mint(runner, sessionId);
  if (!mcpToken) throw new Error(`실행 멤버(${runner})의 lively 토큰을 발급하지 못했다 — 멤버 디렉터리에 없거나 권한이 비었다`);
  creds.push({ name: "lively", data: Buffer.from(mcpToken, "utf8") });

  try {
    await d.bind(sessionId);
    const systemPrompt = harness === "claude" && !!input.systemPrompt;
    const files: TaskOpPart[] = [
      { name: "prompt.txt", data: Buffer.from(input.prompt ?? "", "utf8") },
      { name: "run.sh", data: Buffer.from(sandboxRunScript({
        harness, flags: harnessFlagArgs(harness, input.flags), systemPrompt,
        bypassPermissions: input.bypassPermissions !== false, gatewayUrl: gw,
      }), "utf8") },
    ];
    if (harness === "claude") files.push({ name: "mcp.json", data: Buffer.from(sandboxMcpConfig(gw, harness), "utf8") });
    if (systemPrompt) files.push({ name: "system.md", data: Buffer.from(String(input.systemPrompt), "utf8") });

    const header = {
      op: "launch", slug, task_id: taskId, attempt: input.attempt, profile: SANDBOX_PROFILE, harness,
      env: { LIVELY_GATEWAY_URL: gw, LIVELY_SESSION_ID: sessionId, LIVELY_TASK_ID: String(taskId), LVLY_TENANT_SLUG: slug, LIVELY_HARNESS: harness },
      nonce: crypto.randomBytes(16).toString("hex"),
      limits: { runtime_sec: Math.max(60, Math.floor(input.timeoutSec ?? 3600)) + 60 },
    };
    let r = await d.call(header, { files, creds }, { timeoutMs: 45_000 });
    if (!r.ok && r.code === "exists" && r.state !== "active" && r.state !== "activating" && r.state !== "deactivating") {
      //  같은 (태스크, 회차) 의 끝난 판이 남아 있다 — 띄우고 나서 기록(markRunning)을 못 한 옛 시도다.
      //   치우고 한 번만 다시 띄운다. 살아 있는 판은 건드리지 않는다(아래에서 배압으로 돌려보낸다).
      const reaped = await d.call({ op: "reap", unit: String(r.unit ?? "") });
      if (reaped.ok) r = await d.call(header, { files, creds }, { timeoutMs: 45_000 });
    }
    if (r.ok) return { sessionId, taskDir: `${String(r.task_dir)}/out`, workspace: "/task/work" };
    if (r.code === "busy" || r.code === "exists") throw new SandboxBusyError(`샌드박스 자리 없음 — ${r.error ?? r.code}`);
    throw new Error(`샌드박스 판을 못 띄웠다(${r.code}): ${r.error ?? ""}`);
  } catch (e) {
    await Promise.resolve(d.revoke(sessionId)).catch(() => { /* 다음 회수에서 */ });
    throw e;
  }
}

/** 판 상태 조회 간격 — 종료 줄이 권위라 상태는 «종료 줄 없이 끝난 판» 을 잡는 데만 쓴다. */
const STATUS_EVERY_MS = 20_000;
const lastStatusAt = new Map<string, number>();

async function readOut(dir: string): Promise<{ tail: string; nonce: string | null }> {
  const got = await localTaskFs.readMany([
    { key: "tail", path: path.join(dir, "stream.jsonl"), max: 16 * 1024, tail: true },
    { key: "meta", path: path.join(dir, "meta.json"), max: 16 * 1024 },
  ]).catch(() => ({} as Record<string, { buf: Buffer } | null>));
  let nonce: string | null = null;
  try {
    const m = JSON.parse(got.meta ? got.meta.buf.toString("utf8") : "null") as { nonce?: unknown } | null;
    nonce = typeof m?.nonce === "string" && m.nonce ? m.nonce : null;
  } catch { /* 메타 없음 — 종료 줄을 믿지 않는다 */ }
  return { tail: got.tail ? got.tail.buf.toString("utf8") : "", nonce };
}

/**
 * 끝났나 — 끝났으면 결과, 아니면 null(= 계속 감시). `checkTask` 와 같은 반환 계약이다.
 *  순서: 스트림 꼬리(싸다) → 종료 줄이면 끝. 없으면(간격을 두고) 상태 → 스트림을 **다시** 읽고 판정.
 */
export async function checkSandboxTask(
  w: { taskId: number; taskDir: string; harness?: string | null },
  now: number = Date.now(),
): Promise<TaskOutcome | null> {
  const c = sandboxCoordsOfDir(w.taskDir);
  if (!c) return null;
  let out = await readOut(w.taskDir);
  let unit: SandboxUnitState | null = null;
  if (!lastEndLine(out.tail, out.nonce)) {
    if (now - (lastStatusAt.get(c.unit) ?? 0) < STATUS_EVERY_MS) return null;
    lastStatusAt.set(c.unit, now);
    const st = await callTaskOp({ op: "status", unit: c.unit });
    if (st.ok) unit = { load: String(st.load ?? ""), active: String(st.active ?? ""), result: String(st.result ?? ""), exec_code: String(st.exec_code ?? ""), exec_status: String(st.exec_status ?? "") };
    out = await readOut(w.taskDir);
  }
  const v = judgeSandboxTask({ tail: out.tail, nonce: out.nonce, unit });
  if (v.state === "running") return null;
  lastStatusAt.delete(c.unit);
  const rest = await localTaskFs.readMany([
    { key: "stream", path: path.join(w.taskDir, "stream.jsonl"), max: 64 * 1024 * 1024 },
    { key: "stderr", path: path.join(w.taskDir, "stderr.log"), max: 16 * 1024, tail: true },
  ]).catch(() => ({} as Record<string, { buf: Buffer } | null>));
  const summary = extractResult(rest.stream ? rest.stream.buf.toString("utf8") : "", w.harness ?? undefined).slice(0, SUMMARY_CAP);
  if (v.ok) return { taskId: w.taskId, ok: true, exit: v.exit, summary };
  const stderr = rest.stderr ? rest.stderr.buf.toString("utf8").trim().slice(-2048) : "";
  return { taskId: w.taskId, ok: false, exit: v.exit, summary, error: [v.reason, stderr].filter(Boolean).join(" — ") };
}

/** 판을 멈춘다(비대기). `gone` 은 «멈추라고 전했다». 못 닿았으면 false — 회수기가 다시 본다. */
export async function stopSandboxTask(taskDir: string): Promise<{ gone: boolean; reached: boolean; why?: string }> {
  const c = sandboxCoordsOfDir(taskDir);
  if (!c) return { gone: true, reached: true };
  const r = await callTaskOp({ op: "stop", unit: c.unit });
  if (r.ok) return { gone: true, reached: true };
  return { gone: false, reached: r.code !== "op_unreachable" && r.code !== "op_timeout", why: `${r.code}: ${r.error ?? ""}` };
}

/**
 * 끝난 판을 치운다 — 실패로 남은 유닛을 비우고(reset-failed) 폴더를 지운다(keepDir 이면 남긴다).
 *  살아 있는 판은 op 가 거절한다(`active`) — 그때는 «아직 안 끝났다» 로 돌려준다.
 */
export async function reapSandboxTask(taskDir: string, keepDir: boolean): Promise<{ done: boolean; reached: boolean; why?: string }> {
  const c = sandboxCoordsOfDir(taskDir);
  if (!c) return { done: true, reached: true };
  lastStatusAt.delete(c.unit);
  const r = await callTaskOp({ op: "reap", unit: c.unit, keep_dir: keepDir });
  if (r.ok) return { done: true, reached: true };
  return { done: false, reached: r.code !== "op_unreachable" && r.code !== "op_timeout", why: `${r.code}: ${r.error ?? ""}` };
}

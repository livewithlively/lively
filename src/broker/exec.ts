// per-member 브로커 — session-exec 코어(#746 T4). D-어댑터(git·terraform·kubectl 등 로컬 파일/state 본질)를
//  브로커 프로세스(멤버 대화 uid 와 분리된 전용 uid) 안에서 실행한다. 자격은 이 프로세스에만(멤버 변조 불가).
//  보안 불변식: (1) 도구 화이트리스트만, (2) shell 미경유(execFile, 인자 배열 — 셸 인젝션 원천차단),
//   (3) cwd 는 workroot 하위로 봉쇄(경로 이탈 차단), (4) 타임아웃·출력상한, (5) 자격/env 는 절대 응답·로그로 안 나감.
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export interface ExecRequest { op: "exec"; tool: string; args?: string[]; cwd?: string; timeoutMs?: number }
export interface ExecResult { ok: boolean; stdout: string; stderr: string; code: number | null; error?: string }

export interface ExecPolicy {
  allowedTools: string[];   // 실행 허용 도구명(basename). 이 밖은 거부.
  workroot: string;         // cwd 는 이 절대경로 하위만 허용(경로 이탈 차단).
  maxBytes?: number;        // stdout/stderr 각 상한(기본 1MiB).
  timeoutMs?: number;       // 기본 60s, 요청이 더 크게 못 올림(상한).
  env?: NodeJS.ProcessEnv;  // 자식에 넘길 env(브로커가 쥔 자격 포함). 미지정 시 process.env.
}

// workroot 하위로 cwd 봉쇄 — 심볼릭/`..` 이탈 차단(realpath 후 접두 검사). 미존재 cwd 는 workroot 로.
export function resolveCwd(reqCwd: string | undefined, workroot: string): string {
  const root = fs.realpathSync(workroot);
  if (!reqCwd) return root;
  const abs = path.resolve(root, reqCwd);
  // realpath 실패(미존재/댕글링 심볼릭)면 거부 — 옛 폴백(unresolved 경로 통과)은 심볼릭 레이스 우회 허용(리뷰). 존재+해석돼야 통과.
  let real: string;
  try { real = fs.realpathSync(abs); }
  catch { throw new Error(`cwd 해석 실패(존재하지 않거나 접근 불가): ${reqCwd}`); }
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new Error(`cwd 가 workroot 밖입니다: ${reqCwd}`);
  }
  return real;
}

// 도구명 검증 — basename 만(경로 포함 금지) + 화이트리스트. `/`·`..` 포함 도구명 거부(임의 바이너리 실행 차단).
export function assertAllowedTool(tool: string, allowed: string[]): void {
  if (typeof tool !== "string" || !tool) throw new Error("tool 이 필요합니다");
  if (tool.includes("/") || tool.includes("\\") || tool.includes("..")) throw new Error(`tool 은 경로를 포함할 수 없습니다: ${tool}`);
  if (!allowed.includes(tool)) throw new Error(`허용되지 않은 도구: ${tool} (허용: ${allowed.join(", ") || "없음"})`);
}

// 한 번 실행 — 화이트리스트·no-shell·cwd 봉쇄·타임아웃·출력상한. 자격은 opts.env 로 자식에만 주입(응답엔 안 실림).
export function runExec(req: ExecRequest, policy: ExecPolicy): Promise<ExecResult> {
  const maxBytes = policy.maxBytes ?? 1024 * 1024;
  const hardTimeout = policy.timeoutMs ?? 60000;
  const timeoutMs = Math.min(typeof req.timeoutMs === "number" && req.timeoutMs > 0 ? req.timeoutMs : hardTimeout, hardTimeout);
  return new Promise<ExecResult>((resolve) => {
    let cwd: string;
    try {
      assertAllowedTool(req.tool, policy.allowedTools);
      cwd = resolveCwd(req.cwd, policy.workroot);
    } catch (e) { return resolve({ ok: false, stdout: "", stderr: "", code: null, error: (e as Error).message }); }
    const args = Array.isArray(req.args) ? req.args.map(String) : [];
    execFile(req.tool, args, { cwd, timeout: timeoutMs, maxBuffer: maxBytes, shell: false, env: policy.env ?? process.env },
      (err, stdout, stderr) => {
        const e = err as (Error & { code?: number | string; killed?: boolean }) | null;
        const code = e && typeof e.code === "number" ? e.code : (e ? null : 0);
        resolve({
          ok: !e,
          stdout: String(stdout ?? "").slice(0, maxBytes),
          stderr: String(stderr ?? "").slice(0, maxBytes),
          code,
          error: e ? (e.killed ? `타임아웃(${timeoutMs}ms) 또는 강제종료` : e.message) : undefined,
        });
      });
  });
}

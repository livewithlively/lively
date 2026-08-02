// 프리뷰 throwaway 백엔드 프로세스 매니저 — stack_profile.start_cmd 를 워크트리에서 spawn, 포트 할당·추적·종료 (#1036 3단계).
//  run-tracker.ts 패턴(in-memory Map + PID 검증 kill). shared-proxy/existing-ref 는 프로세스가 없어 이 모듈을 안 쓴다.
//  ⚠ start_cmd 는 신뢰 입력이다 — 관리자(admin)가 org_stack_profile 에 등록한 값만 실행된다(사용자 임의 입력 아님).
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import http from "node:http";

interface Proc { child: ChildProcess; port: number; pid: number; }
const procs = new Map<string, Proc>();

// 빈 TCP 포트 확보 — listen(0) 로 OS 가 고른 번호를 받고 즉시 닫아 그 번호를 쓴다(바로 spawn 하므로 레이스 최소).
export function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = (addr && typeof addr === "object") ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("포트 할당 실패"))));
    });
  });
}

export function isAlive(id: string): boolean {
  const p = procs.get(id);
  if (!p) return false;
  try { process.kill(p.pid, 0); return true; } catch { procs.delete(id); return false; }
}

export function portOf(id: string): number | null { return isAlive(id) ? (procs.get(id)?.port ?? null) : null; }

// throwaway 프로세스 기동 — cwd(워크트리)에서 cmd 를 실행, portEnv=할당포트 + extraEnv 주입. 이미 살아있으면 재사용(no-op).
export async function startProc(
  id: string, cwd: string, cmd: string, portEnv: string, extraEnv: Record<string, string>, healthPath: string | null,
): Promise<{ port: number; pid: number; action: string; healthy: boolean }> {
  const cur = procs.get(id);
  if (cur && isAlive(id)) return { port: cur.port, pid: cur.pid, action: "alive", healthy: true };
  const port = await pickPort();
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...extraEnv, [portEnv || "PORT"]: String(port) };
  const child = spawn("sh", ["-c", cmd], { cwd, env, stdio: ["ignore", "ignore", "ignore"] });
  if (!child.pid) throw new Error("프로세스 spawn 실패: " + cmd);
  procs.set(id, { child, port, pid: child.pid });
  child.on("exit", () => { if (procs.get(id)?.child === child) procs.delete(id); });
  let healthy = true;
  if (healthPath) healthy = await waitHealth(port, healthPath, 25_000).then(() => true).catch(() => false);
  return { port, pid: child.pid, action: "started", healthy };
}

// PID 검증 후 종료(run-tracker 패턴) — 자기 Map 의 PID 로만 kill(무관 PID 안 죽임).
export function stopProc(id: string): { stopped: boolean } {
  const p = procs.get(id);
  if (!p) return { stopped: false };
  try { process.kill(p.pid, "SIGTERM"); } catch { /* 이미 죽음 */ }
  procs.delete(id);
  return { stopped: true };
}

function waitHealth(port: number, path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = (): void => {
      const req = http.get({ host: "127.0.0.1", port, path: path || "/", timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve(); else retry();
      });
      req.on("error", retry);
      req.on("timeout", () => { req.destroy(); retry(); });
    };
    const retry = (): void => { if (Date.now() > deadline) reject(new Error("healthcheck 타임아웃")); else setTimeout(tryOnce, 500); };
    tryOnce();
  });
}

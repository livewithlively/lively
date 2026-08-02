// 호스트 메모리 지표 — 가용/전체 MB. `os.freemem()` 은 페이지캐시·inactive 를 빼고 세어 Linux(MemFree)·macOS 에서
//  가용을 심하게 과소보고한다(#869 위탁 배치 e2e: 멀쩡한 노드가 다 떨궈짐) → 플랫폼별 '회수 가능 포함' 지표를 쓴다:
//  Linux = /proc/meminfo MemAvailable · macOS = vm_stat(free+inactive+purgeable+speculative). 실패 시 freemem 폴백.
//  용처(공용): 위탁 배치(node/tasks sampleResources) · 임베딩 백필 pre-flight 게이트(#1059) · 박스 메모리 status.
import fsp from "node:fs/promises";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// 가용 메모리(MB) — '지금 새 작업에 실제로 내줄 수 있는' 양(회수 가능한 캐시 포함). 절대 throw 안 함(폴백 freemem).
export async function memAvailableMb(): Promise<number> {
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

// 전체 물리 메모리(MB).
export function memTotalMb(): number {
  return Math.round(os.totalmem() / 1048576);
}

export interface SwapUsage {
  /** 스왑 총량(MB). 0 = 스왑 자체가 없는 박스(‘못 잼’과 구분된다 — 그건 null). */
  totalMb: number;
  /** 남은 스왑(MB). */
  freeMb: number;
}

/**
 * /proc/meminfo → 스왑(총/여유). 두 줄 다 없으면 null(못 잼).
 *
 * 왜 물리 메모리와 **따로** 보여야 하나: MemAvailable 이 넉넉해도 스왑이 바닥이면 그 박스는 이미 벼랑이다.
 * 실측(2026-07-28 고객사 A): 가용 4.2GB 로 여유로워 보이는데 스왑은 7,737/8,191MB(여유 454MB)였다 —
 * 만성 누수로 밀려난 페이지가 스왑을 채운 상태라 급성 스파이크(#1059 Ollama 로드) 한 번이면 OOM 이다.
 */
export function parseProcMeminfoSwap(text: string): SwapUsage | null {
  const t = /SwapTotal:\s+(\d+)\s*kB/.exec(text), f = /SwapFree:\s+(\d+)\s*kB/.exec(text);
  if (!t || !f) return null;
  return { totalMb: Math.round(Number(t[1]) / 1024), freeMb: Math.round(Number(f[1]) / 1024) };
}

/** macOS `sysctl -n vm.swapusage` → "total = 2048.00M  used = 1234.50M  free = 813.50M (encrypted)". 단위 K/M/G. */
export function parseVmSwapusage(text: string): SwapUsage | null {
  const mb = (key: string): number | null => {
    const m = new RegExp(`${key}\\s*=\\s*([\\d.]+)\\s*([KMG])`, "i").exec(text);
    if (!m) return null;
    const v = Number(m[1]), u = m[2].toUpperCase();
    return Math.round(u === "G" ? v * 1024 : u === "K" ? v / 1024 : v);
  };
  const totalMb = mb("total"), freeMb = mb("free");
  return totalMb === null || freeMb === null ? null : { totalMb, freeMb };
}

/** 지금 이 호스트의 스왑 사용량. 못 재는 플랫폼·실패면 null(절대 throw 안 함 — 감시·status 를 죽이면 안 된다). */
export async function swapUsageMb(): Promise<SwapUsage | null> {
  try {
    if (process.platform === "linux") return parseProcMeminfoSwap(await fsp.readFile("/proc/meminfo", "utf8"));
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("sysctl", ["-n", "vm.swapusage"], { timeout: 3000 });
      return parseVmSwapusage(stdout);
    }
  } catch { /* 아래 null */ }
  return null;
}

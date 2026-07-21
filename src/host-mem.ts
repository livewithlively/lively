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

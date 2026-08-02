// 호스트 PTY 슬롯 사용량 — 웹터미널 attach 는 브라우저 탭 하나당 PTY 1개를 쓰고, PTY 는 **OS 전역 한도**가 있는
//  희소 자원이다(맥미니 기본 kern.tty.ptmx_max=511). 고갈되면 웹터미널이 안 열리는 데서 끝나지 않고
//  **ssh 인터랙티브 접속까지 막힌다**(`PTY allocation request failed on channel 0`) — 관리자가 박스에 들어가
//  고치는 경로가 함께 끊기므로 디스크·메모리보다 오히려 늦게, 더 나쁜 상태로 발견된다.
//  (2026-07-27 dev 맥미니: node-pty 네이티브 누수로 511 소진 → ssh 불가. #687 후속.)
//  용처: box-watch 의 PTY 경보.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * **이 게이트웨이 프로세스가 지금 열고 있는 PTY master fd 수.**
 *
 * 왜 시스템 사용량(ptyUsage)과 따로 재나: 시스템 값에는 tmux pane·ssh·멤버가 직접 연 pty 가 전부 섞여
 * 있고 그 baseline 은 **박스마다 다르다**(dev 맥미니 53 · 고객사 A 실박스 106). 그래서 "시스템 − 우리 몫"
 * 같은 차이 지표는 상수 임계로 판정할 수 없다(2026-07-27 고객사 A에서 상시 오탐으로 드러났다).
 * 반면 이 값을 장부(`liveTerms.size`)와 비교하면 **박스 규모와 무관하게** 우리 누수만 남는다 — 0 이 아니면
 * 그 자체로 누수라 임계 튜닝이 필요 없다.
 *
 * lsof 를 부르지 않는다(수백 fd 스캔은 느리고 실패 모드가 많다). 실측으로 lsof 와 값이 일치함을 확인했다.
 * 잴 수 없으면 null.
 */
export function selfPtmxFdCount(): number | null {
  try {
    if (process.platform === "linux") {
      // /proc/self/fd/<n> → 심볼릭 타깃이 정확히 /dev/ptmx 인 것이 master.
      let n = 0;
      for (const name of fs.readdirSync("/proc/self/fd")) {
        try { if (fs.readlinkSync(`/proc/self/fd/${name}`) === "/dev/ptmx") n++; } catch { /* 그새 닫힘 */ }
      }
      return n;
    }
    if (process.platform === "darwin") {
      // /dev/fd 목록 + fstat. ptmx 는 character device major 15(실측: 스폰 3개 → major15 3개, lsof 와 일치).
      let n = 0;
      for (const name of fs.readdirSync("/dev/fd")) {
        const fd = Number(name);
        if (!Number.isInteger(fd)) continue;
        try {
          const st = fs.fstatSync(fd);
          if (st.isCharacterDevice() && ((st.rdev >> 24) & 0xff) === 15) n++;
        } catch { /* 그새 닫힘 — 스캔 중 변동은 정상 */ }
      }
      return n;
    }
  } catch { /* 아래 null */ }
  return null;
}

export interface PtyUsage {
  /** 지금 할당된 PTY 수. */
  used: number;
  /** OS 가 허용하는 최대 PTY 수. */
  max: number;
  /** used/max 백분율(반올림). 한도 초과 상태가 실제로 관측되므로 100 을 넘을 수 있다(그대로 노출 — 심각도 신호다). */
  usedPct: number;
}

const pct = (used: number, max: number): number => (max > 0 ? Math.round((used / max) * 100) : 0);

/**
 * 지금 이 호스트의 PTY 사용량. **잴 수 없으면 null** — 못 잰다고 경보하지 않는다(디스크 diskState 와 같은 규약).
 * 절대 throw 하지 않는다(감시 루프를 죽이면 안 된다).
 */
export async function ptyUsage(): Promise<PtyUsage | null> {
  try {
    if (process.platform === "linux") {
      // 정본은 sysctl(/proc/sys/kernel/pty). 커널 빌드·컨테이너에 따라 없을 수 있어 /dev/pts 실측으로 폴백한다.
      const [nrRaw, maxRaw] = await Promise.all([
        fsp.readFile("/proc/sys/kernel/pty/nr", "utf8").catch(() => ""),
        fsp.readFile("/proc/sys/kernel/pty/max", "utf8").catch(() => ""),
      ]);
      const max = Number.parseInt(maxRaw.trim(), 10);
      if (!Number.isFinite(max) || max <= 0) return null; // 한도를 모르면 사용률이 무의미 → 감시 skip
      let used = Number.parseInt(nrRaw.trim(), 10);
      if (!Number.isFinite(used)) {
        // /dev/pts 의 숫자 엔트리 = 열린 slave. ptmx 같은 비숫자 노드는 제외한다.
        const ents = await fsp.readdir("/dev/pts").catch(() => [] as string[]);
        used = ents.filter((n) => /^\d+$/.test(n)).length;
      }
      return { used, max, usedPct: pct(used, max) };
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("sysctl", ["-n", "kern.tty.ptmx_max"], { timeout: 3000 });
      const max = Number.parseInt(stdout.trim(), 10);
      if (!Number.isFinite(max) || max <= 0) return null;
      // macOS 는 pty 를 열 때 /dev/ttysNNN 노드를 만들고 닫히면 지운다 → 노드 수 = 할당된 pty 수
      //  (2026-07-27 실측: 누수 상태 527개 → 게이트웨이 재시작 후 66개로 즉시 감소).
      const used = (await fsp.readdir("/dev")).filter((n) => n.startsWith("ttys")).length;
      return { used, max, usedPct: pct(used, max) };
    }
  } catch { /* 폴백 — 아래 null */ }
  return null; // windows 등 — PTY 개념이 달라 감시하지 않는다
}

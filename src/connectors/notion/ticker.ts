// 노션 백필 생존 티커 — 어떤 페이즈든 주기마다, 단 **실제로 움직였을 때만** 한 줄을 남긴다(#586 · #4059).
//  무조건 찍으면 진짜 행(fetch 정지)에도 살아있는 척이 되어 정체 감지가 무력화된다 — 진행 없으면 침묵을
//  유지해 run-tracker(15분 무출력=킬)가 행을 잡게 한다. 움직임의 정의는 state.ts progressTick(요청·첨부·받은 바이트).
import { reqCount } from "./client.js";
import { progressTick } from "./state.js";
import type { Traversal } from "./state.js";

export function startProgressTicker(t: Traversal, everyMs: number, write: (line: string) => void = (l) => console.error(l)): NodeJS.Timeout {
  let last: string | null = null;
  return setInterval(() => {
    const { sig, line } = progressTick(last, {
      requests: reqCount, pages: t.pages.size, dbs: t.dbs.size,
      assets: t.stats.assets, assetJobs: t.assetJobs.size, assetFailures: t.stats.assetFailures, bytes: t.stats.assetBytes,
    });
    last = sig;
    if (line) write(line); // null = 무진전 — 침묵(정체 감지 존중)
  }, everyMs);
}

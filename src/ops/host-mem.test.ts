// 순수 단위 체크(node:assert) — 스왑 파서(리눅스 /proc/meminfo · macOS vm.swapusage).
//  왜 스왑을 따로 보나: 물리 가용이 넉넉해 보여도 스왑이 바닥이면 스파이크 한 번에 OOM 이다
//  (2026-07-28 고객사 A 실측: 가용 4.2GB 인데 스왑 여유 454MB). 그래서 '없음(0)'과 '못 잼(null)'을 구분한다.
// 실행: npm run build && node dist/ops/host-mem.test.js
import assert from "node:assert/strict";
import { parseProcMeminfoSwap, parseVmSwapusage } from "./host-mem.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const MEMINFO = [
  "MemTotal:       16166584 kB",
  "MemAvailable:    4358912 kB",
  "SwapTotal:       8388604 kB",
  "SwapFree:         465216 kB",
].join("\n");

t("리눅스 /proc/meminfo — 총/여유 스왑을 MB 로", () => {
  assert.deepEqual(parseProcMeminfoSwap(MEMINFO), { totalMb: 8192, freeMb: 454 }); // 고객사 A 실측값
});

t("리눅스 — 스왑 없는 박스는 {0,0}(‘못 잼’과 구분)", () => {
  const noSwap = "MemTotal:  16166584 kB\nSwapTotal:  0 kB\nSwapFree:  0 kB\n";
  assert.deepEqual(parseProcMeminfoSwap(noSwap), { totalMb: 0, freeMb: 0 });
});

t("리눅스 — 필요한 줄이 없으면 null(0 으로 단정하지 않는다)", () => {
  assert.equal(parseProcMeminfoSwap("MemTotal:  16166584 kB\nSwapTotal:  8388604 kB\n"), null);
  assert.equal(parseProcMeminfoSwap(""), null);
});

t("macOS vm.swapusage — M 단위 + (encrypted) 꼬리표", () => {
  const out = "total = 2048.00M  used = 1234.50M  free = 813.50M  (encrypted)";
  assert.deepEqual(parseVmSwapusage(out), { totalMb: 2048, freeMb: 814 });
});

t("macOS — G 단위 · sysctl 키 접두사가 붙어도 동작", () => {
  assert.deepEqual(parseVmSwapusage("vm.swapusage: total = 2.00G  used = 0.50G  free = 1.50G"), { totalMb: 2048, freeMb: 1536 });
});

t("macOS — 형식이 아니면 null", () => {
  assert.equal(parseVmSwapusage("swap: unknown"), null);
  assert.equal(parseVmSwapusage(""), null);
});

console.log(`\n${pass} passed — host-mem.test.ts ok (스왑 파서: 리눅스·macOS · 없음(0) vs 못 잼(null) 구분)`);

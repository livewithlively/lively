#!/usr/bin/env node
// update 하네스 재감지 사양테스트(#1689 UX 갭) — syncKit 이 **다운받은 번들의 레지스트리**로 하네스 목록을
//  보강하는 augmentHarnessesFromBundle 을 직접 실행해 검증한다.
//  왜: 배선 대상 목록을 "실행 중인(구) CLI" 가 계산하면, 새 하네스 지원이 처음 실린 번들을 받으면서도 그
//  하네스 배선만 조용히 빠져 멤버가 update 를 두 번 돌려야 했다(#1689 윈도우 실기기 실측).
//  엣지 표: ①새 하네스(bin 있음) 추가 ②이미 있는 하네스 중복 금지 ③bin 없는 하네스 미추가
//          ④레지스트리 없는 구 번들 무변화(신규 도입물 부재 행) ⑤깨진 레지스트리 무변화
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { augmentHarnessesFromBundle } from "./lively.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const SB = mkdtempSync(join(tmpdir(), "lively-redetect-test-"));
const mkBundle = (registrySource) => {
  const root = mkdtempSync(join(SB, "bundle-"));
  if (registrySource !== null) {
    mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(root, ".claude", "hooks", "harness-registry.mjs"), registrySource);
  }
  return root;
};
// bin 을 "node" 로 두면 이 테스트 환경에서 항상 PATH 에 있고(우리가 node 로 실행 중), "no-such-bin-…" 은 확실히 없다.
const REG = (ids, bins) => `export const HARNESS_IDS = ${JSON.stringify(ids)};
export const HARNESS = { ${ids.map((id, i) => `${JSON.stringify(id)}: { id: ${JSON.stringify(id)}, bin: ${JSON.stringify(bins[i])} }`).join(", ")} };
`;

try {
  // ① 번들이 새로 아는 하네스(bin=node, PATH 존재) → 목록에 추가 + added 로 보고.
  {
    const root = mkBundle(REG(["claude", "newharness"], ["claude", "node"]));
    const list = ["claude"];
    const added = await augmentHarnessesFromBundle(root, list);
    eq("R1 새 하네스(bin 존재) 추가", [list.includes("newharness"), added], [true, ["newharness"]]);
  }
  // ② 이미 목록에 있으면 중복 추가하지 않는다(설치 인자 "a,a" 방지).
  {
    const root = mkBundle(REG(["newharness"], ["node"]));
    const list = ["newharness"];
    const added = await augmentHarnessesFromBundle(root, list);
    eq("R2 기존 항목 중복 금지", [list, added], [["newharness"], []]);
  }
  // ③ bin 이 PATH 에 없으면 추가하지 않는다(안 깔린 하네스를 배선하지 않는다).
  {
    const root = mkBundle(REG(["ghost"], ["no-such-bin-1689-xyzq"]));
    const list = ["claude"];
    const added = await augmentHarnessesFromBundle(root, list);
    eq("R3 bin 부재 → 미추가", [list, added], [["claude"], []]);
  }
  // ④ 레지스트리가 없는 구 번들 → 무변화(신규 도입물 부재 행 — 구 게이트웨이 번들에 이 파일이 없다).
  {
    const root = mkBundle(null);
    const list = ["claude", "codex"];
    const added = await augmentHarnessesFromBundle(root, list);
    eq("R4 구 번들(레지스트리 없음) 무변화", [list, added], [["claude", "codex"], []]);
  }
  // ⑤ 깨진 레지스트리(문법 오류) → 무변화(update 자체를 막지 않는다 — fail-soft).
  {
    const root = mkBundle("export const HARNESS_IDS = [ broken !!!");
    const list = ["claude"];
    const added = await augmentHarnessesFromBundle(root, list);
    eq("R5 깨진 레지스트리 무변화(fail-soft)", [list, added], [["claude"], []]);
  }
  // ⑥ 실 번들 배치와의 정합 — 이 레포의 진짜 레지스트리로도 동작한다(HARNESS_IDS·bin 축 존재 전제 검증).
  {
    const root = mkdtempSync(join(SB, "real-"));
    mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
    const real = join(HERE, "..", "hooks", "harness-registry.mjs");
    const { readFileSync } = await import("node:fs");
    writeFileSync(join(root, ".claude", "hooks", "harness-registry.mjs"), readFileSync(real, "utf8"));
    const list = [];
    await augmentHarnessesFromBundle(root, list);
    // 이 테스트는 node 로 돌므로 최소한 'PATH 에 있는 하네스만' 들어와야 한다 — 모르는 id·빈 값이 섞이면 안 된다.
    const known = new Set(["claude", "codex", "opencode", "antigravity", "grok"]);   // #1701 — grok(5번째 하네스)
    eq("R6 실 레지스트리 — 알려진 id 만", list.every((x) => known.has(x)), true);
  }
} finally { rmSync(SB, { recursive: true, force: true }); }

console.log(`\n${fail ? "✗" : "✓"} lively-update-redetect: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

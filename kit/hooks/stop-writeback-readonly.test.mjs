#!/usr/bin/env node
// stop-writeback-gate 읽기전용(#1007) 억제 테스트 — 오프라인·fs-only(샌드박스 HOME/TMPDIR, 실제 ~/.lively·/tmp 무접촉).
//  고정 불변식: **읽기전용 세션에선 writeback 넛지를 내지 않는다**(안 쓰는 게 의도라 "왜 기록 안 했냐"가 부적절).
//  대조군(readonly 아님)은 같은 조건에서 넛지가 **떠야** 한다 — 그래야 억제가 의미를 가진다(vacuous 방지).
//  실행: node kit/hooks/stop-writeback-readonly.test.mjs  (npm test 체인에 포함)
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const HOOK = join(fileURLToPath(import.meta.url), "..", "stop-writeback-gate.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "ro-gate-test-"));
const HOME = join(SANDBOX, "home");
const TMP = join(SANDBOX, "tmp");
const FLAG_DIR = join(TMP, "lively-hooks"); // 게이트가 flags 를 읽는 곳(tmpdir()/lively-hooks — TMPDIR 로 리다이렉트)
mkdirSync(join(HOME, ".lively"), { recursive: true });
mkdirSync(FLAG_DIR, { recursive: true });

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

let sid = 0;
// 넛지 조건을 갖춘 세션(isLivelyWork=.lively + .worked, writeback/blocked 없음)을 만들고 게이트를 실제 프로세스로 실행,
//  게이트가 stdout 에 낸 것을 돌려준다. LIVELY_MODE 값(#1007+)은 인자로 주입.
function runGate(modeEnv) {
  const id = `s${++sid}`;
  writeFileSync(join(FLAG_DIR, `${id}.lively`), "");  // 자가게이팅 신호(이 세션은 lively work)
  writeFileSync(join(FLAG_DIR, `${id}.worked`), "");  // 의미있는 작업함 → 넛지 후보
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: id, stop_hook_active: false, cwd: TMP }),
    env: { ...process.env, HOME, TMPDIR: TMP, LIVELY_OFF: "", LIVELY_HOOKS_OFF: "", LIVELY_MODE: modeEnv },
    encoding: "utf8",
  });
  return out;
}
const nagged = (out) => out.includes('"decision"') && out.includes('"block"');

try {
  // 대조군 — readonly 아님: 같은 조건이면 넛지가 떠야 한다(설정이 실제로 넛지 유발함을 입증).
  t("대조군(LIVELY_MODE 미설정=normal) — 넛지가 뜬다", () => {
    assert.equal(nagged(runGate("")), true, "normal 이면 block 넛지가 나와야");
  });
  // 읽기전용 — 억제: LIVELY_MODE=readonly(대소문자·앞뒤공백 무관) 면 block 넛지가 없어야 하고, 게이트는 조용히 exit 0(execFileSync 가 안 던짐).
  for (const v of ["readonly", "READONLY", " readonly ", "\treadonly\n"]) {
    t(`읽기전용(LIVELY_MODE=${JSON.stringify(v)}) — 넛지 억제`, () => {
      assert.equal(nagged(runGate(v)), false, `LIVELY_MODE=${JSON.stringify(v)} 면 넛지 없어야`);
    });
  }
  // readonly 정확 매칭만 억제 — 다른 모드값/구 truthy 문자열은 넛지 유지(exact 'readonly'. incognito 는 LIVELY_OFF 로 별도 처리).
  for (const v of ["normal", "1", "true", "0"]) {
    t(`LIVELY_MODE=${JSON.stringify(v)} 은 억제 아님(넛지 유지)`, () => {
      assert.equal(nagged(runGate(v)), true, `'${v}' 은 readonly 아님 → 넛지 유지`);
    });
  }
  console.log(`\nstop-writeback readonly tests: ${pass} passed`);
} finally {
  rmSync(SANDBOX, { recursive: true, force: true });
}

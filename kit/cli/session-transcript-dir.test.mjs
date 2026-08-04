#!/usr/bin/env node
// 트랜스크립트 폴더 해석 계약 (#1510) — 실행: node kit/cli/session-transcript-dir.test.mjs
//
// 왜 — `lively resume` 은 중앙 트랜스크립트를 하네스가 읽는 자리에 물질화하고, `lively share` 는 그 자리에서
//  이 cwd 의 세션을 찾는다. 그 '자리'는 cwd 를 인코딩한 폴더인데, 종전 규칙(`/`·`.` → `-`)이 윈도우 경로의
//  `\` 와 `:` 를 그대로 두어 `join(base, "C:\\Users\\…")` 를 만들었다 → **resume 이 mkdir ENOENT 로 죽고**
//  share 는 세션을 못 찾았다(2026-08-04 windows-latest CI 실측).
//
//  ⚠ 인코딩 규칙은 **하네스 쪽 구현**이라 우리가 정하는 값이 아니다. 그래서 규칙만 고치는 데서 멈추지 않고,
//   "이미 있는 폴더의 트랜스크립트에 적힌 cwd 가 실제로 일치하면 그 폴더를 쓴다"는 내용 기반 폴백을 함께 둔다.
//   이 파일은 그 두 축(규칙 · 폴백)의 엣지를 전수로 고정한다.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "tdir-test-"));
process.env.LIVELY_HOME = SANDBOX;                 // 모듈 상수 HOME 을 샌드박스로 (import **전에** 세운다)
const { encodeCwd, projectsDirFor } = await import("./cmd-session.mjs");

const WIN = process.platform === "win32";
const BASE = join(SANDBOX, ".claude", "projects");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (got === want ? ok(n) : bad(n, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));

// 트랜스크립트 한 줄 = 하네스가 남기는 형식(cwd 가 앞쪽 라인에 있다).
const mkTranscript = (dir, sid, cwd) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), JSON.stringify({ type: "user", cwd, message: { content: "x" } }) + "\n");
};
const reset = () => { rmSync(BASE, { recursive: true, force: true }); };

// ── 규칙(encodeCwd) ─────────────────────────────────────────────────────────────
//  분기를 **인자로 주입**해 양쪽 규칙을 어느 플랫폼에서든 단언한다. 안 그러면 윈도우 규칙은 윈도우 러너에서만
//  검증되는데, 이 결함이 난 이유가 바로 그 사각지대다(mac 에서 절대 재현 안 됨).
// E1 POSIX 경로: `/`·`.` → `-` (종전 동작 무회귀)
eq("E1 POSIX `/a/b.c` → `-a-b-c`", encodeCwd("/a/b.c", false), "-a-b-c");

// E2 윈도우 경로: 구분자 `\` 와 드라이브 `:` 도 파일명에 못 쓰므로 함께 치환된다.
eq("E2 윈도우 `C:\\Users\\me\\proj` → `C--Users-me-proj`", encodeCwd("C:\\Users\\me\\proj", true), "C--Users-me-proj");

// E3 POSIX 는 `:` 가 합법 파일명 문자다 — 규칙을 넓히면 **기존 폴더를 못 찾는다**(무회귀 가드).
eq("E3 POSIX `:` 는 그대로 둔다(무회귀)", encodeCwd("/a/b:c", false), "-a-b:c");

// E1~E3 배선 — 기본 인자가 실행 플랫폼을 따르는가(주입 인자만 맞고 실제 호출이 틀리면 전부 공허하다).
eq("E1~E3 배선 — 기본 인자 = 이 플랫폼 규칙", encodeCwd("/a/b:c"), encodeCwd("/a/b:c", WIN));

// ── 폴백(projectsDirFor) — 규칙에만 기대지 않는다 ───────────────────────────────
// E4 projects 폴더 자체가 없다 → 예외 없이 규칙 이름(= 새로 만들 자리)
reset();
eq("E4 projects 폴더 부재 → 규칙 이름(예외 없음)", projectsDirFor("/w/x"), join(BASE, encodeCwd("/w/x")));

// E5 규칙 이름 폴더가 이미 있다 → 스캔할 것도 없이 그 폴더
reset();
mkdirSync(join(BASE, encodeCwd("/w/x")), { recursive: true });
mkTranscript(join(BASE, "다른-폴더"), "s-other", "/전혀/다른/곳");
eq("E5 규칙 이름 폴더 존재 → 그 폴더", projectsDirFor("/w/x"), join(BASE, encodeCwd("/w/x")));

// E6 규칙 이름은 없지만 **다른 이름** 폴더의 트랜스크립트 cwd 가 일치 → 그 폴더(하네스가 규칙을 바꿔도 산다)
reset();
mkTranscript(join(BASE, "하네스가-정한-다른-이름"), "s-mine", "/w/x");
eq("E6 다른 이름 폴더라도 트랜스크립트 cwd 가 일치하면 그 폴더",
  projectsDirFor("/w/x"), join(BASE, "하네스가-정한-다른-이름"));

// E7 어떤 폴더의 cwd 도 일치하지 않는다 → 규칙 이름(새 자리)
reset();
mkTranscript(join(BASE, "남의-폴더"), "s-other", "/전혀/다른/곳");
eq("E7 일치하는 cwd 없음 → 규칙 이름", projectsDirFor("/w/x"), join(BASE, encodeCwd("/w/x")));

// E8 파손·빈 폴더가 섞여 있어도 죽지 않고 계속 스캔한다(진단 도구는 멈추면 안 된다)
reset();
mkdirSync(join(BASE, "빈-폴더"), { recursive: true });
mkdirSync(join(BASE, "파손"), { recursive: true });
writeFileSync(join(BASE, "파손", "s-broken.jsonl"), "{ 이건 JSON 이 아니다\n");
mkTranscript(join(BASE, "정상"), "s-mine", "/w/x");
eq("E8 빈 폴더·파손 JSON 을 건너뛰고 일치 폴더를 찾는다", projectsDirFor("/w/x"), join(BASE, "정상"));

// 배선 — 실제 홈이 아니라 샌드박스를 봤는가(관측 장치 생존). 샌드박스 밖을 가리키면 위 단언들이 전부 공허하다.
projectsDirFor("/w/x").startsWith(SANDBOX)
  ? ok("배선 — 해석 결과가 샌드박스 안이다(실제 ~/.claude 무접촉)")
  : bad("배선", `샌드박스 밖을 가리킨다: ${projectsDirFor("/w/x")}`);

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// #3591 회귀 가드 — box-spawn 의 «MCP 등록 자가치유를 세션보다 앞으로» 불변식.
//
//  사양: 매니지드/격리 세션의 하네스는 box-spawn 이 exec 한다. 클로드 코드는 MCP 설정을 **시작 시
//   스냅샷**하므로, ~/.claude.json 의 mcpServers 가 비어 있으면 그 세션은 끝까지 lively 툴 0개다.
//   되살리는 자리가 SessionStart 훅뿐이던 동안엔 그게 **구조적으로 한 세션 늦었다**(훅은 스냅샷 뒤에 돈다).
//   그래서 이 래퍼가 exec **직전에** `self-update.mjs --mcp-only` 로 additive reconcile 을 돌린다.
//   실측 2026-09-07(매니지드 lively-46e3): 컨테이너 기동과 같은 초에 뜬 세션이 96초 뒤에야 등록을 받았다.
//
//  여기서 지키는 네 가지 — 하나라도 무너지면 조용히 종전 상태(또는 그보다 나쁜 상태)로 돌아간다:
//   ① 순서   — reconcile 이 exec 보다 **앞**. 뒤로 가면 아무 효과가 없다(그게 원래 버그였다).
//   ② 표면   — 세션(--cwd·무인자)에만. 파일 브리지·브로커(`box-spawn node …`)에 얹으면 node 진입
//              ~100ms 가 그 잦은 호출마다 붙는다(gVisor 매니지드 실측).
//   ③ 구키트 — 키트(멤버 홈·게이트웨이 배포)와 이 래퍼(/opt·이미지 배포)는 주기가 다르다. `--mcp-only`
//              를 모르는 구 키트에 그 인자를 주면 main() 으로 떨어져 **다운로드·설치를 세션 시작 경로에서
//              동기로** 돌린다(분 단위 블로킹). 그래서 그 인자를 아는 키트일 때만 부른다.
//   ④ fail-soft — 실패가 세션을 막지 않는다(set -e 아래라 `|| true` 가 없으면 곧 세션 실패다).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "linux", "box-spawn"), "utf8");
const lines = src.split(/\r?\n/);
// 주석(#)이 아닌 실제 명령 라인에서만 찾는다 — 설명 주석의 명령어 언급에 오탐되지 않게.
const codeIdx = (re, what) => {
  const i = lines.findIndex((l) => !l.trimStart().startsWith("#") && re.test(l));
  assert.ok(i >= 0, `${what} — 패턴 미발견(명령 라인): ${re}`);
  return i;
};
const codeLines = lines.filter((l) => !l.trimStart().startsWith("#"));

// ① 순서 — reconcile 호출이 하네스 exec 보다 앞이어야 한다. 이게 이 변경의 **전부**다.
const reconcile = codeIdx(/node\s+"\$_su"\s+--mcp-only/, "reconcile 호출");
const execHarness = codeIdx(/^\s*exec\s+"\$@"/, "하네스 exec");
assert.ok(reconcile < execHarness,
  `reconcile(line ${reconcile + 1})은 exec "$@"(line ${execHarness + 1})보다 앞서야 한다 — 뒤면 하네스가 이미 설정을 스냅샷한 뒤라 무효(#3591 원래 버그)`);

// ② 표면 — 세션 판정(_session) 안에서만 돈다. _session 은 --cwd 와 무인자에서만 1 이 된다.
assert.ok(codeIdx(/if\s+\[\s*"\$_session"\s*=\s*1\s*\]/, "세션 게이트") < reconcile,
  'reconcile 이 "$_session" 게이트 안에 있어야 한다 — 밖이면 파일 브리지·브로커 호출마다 node 를 띄운다');
assert.ok(/_session=1/.test(lines[codeIdx(/"\$\{1:-\}"\s*=\s*"--cwd"/, "--cwd 파싱")]),
  "--cwd 를 받은 호출은 세션으로 표시돼야 한다(세션 spawn 의 규약)");
assert.ok(codeLines.some((l) => /\[\s*"\$#"\s*-eq\s*0\s*\]/.test(l) && /_session=1/.test(l)),
  "무인자 호출(로그인 셸 세션)도 세션으로 표시돼야 한다 — 사람이 그 셸에서 하네스를 띄운다");

// ③ 구 키트 방어 — 대상 스크립트가 `--mcp-only` 를 실제로 아는지 확인한 뒤에만 부른다.
const guard = codeIdx(/grep\s+-q\s+--\s+'--mcp-only'/, "구 키트 가드");
assert.ok(guard <= reconcile,
  `--mcp-only 지원 확인(line ${guard + 1})이 호출(line ${reconcile + 1})보다 앞서야 한다 — 모르는 구 키트는 그 인자를 무시하고 main() 으로 떨어져 세션 시작을 분 단위로 막는다`);

// ④ fail-soft — set -e 아래이므로 실패를 삼키지 않으면 그 자리에서 세션이 죽는다.
assert.ok(/^set -euo pipefail$/m.test(src), "이 가드의 전제(set -e)가 사라졌다 — 아래 || true 요구를 재검토하라");
for (const l of codeLines.filter((l) => /node\s+"\$_su"\s+--mcp-only/.test(l))) {
  assert.ok(/\|\|\s*true\s*$/.test(l.trim()), `reconcile 호출은 실패를 삼켜야 한다(|| true) — set -e 아래서 세션이 죽는다: ${l.trim()}`);
}

// ⑤ 네트워크 금지 — 이 자리에서 부르는 모드는 `--mcp-only` 하나뿐이어야 한다. 인자 없는(=main()) 호출이
//    끼어들면 세션 시작 경로에서 다운로드·설치가 동기로 돈다.
for (const l of codeLines.filter((l) => /self-update\.mjs|"\$_su"/.test(l))) {
  assert.ok(!/node\s+"\$_su"(?!\s+--mcp-only)/.test(l),
    `세션 시작 경로에서 self-update 를 --mcp-only 없이 부르면 안 된다(다운로드·설치가 동기로 돈다): ${l.trim()}`);
}

// ⑥ 비용 — node 는 «되살릴 때만» 뜬다. 등록 유무를 보는 셸 판정이 node 호출보다 **앞**에 있어야 한다.
//    없으면 6일에 한 번 쓸 일을 위해 매 세션 +83ms 를 낸다(매니지드 gVisor 실측 51ms → 134ms).
//    판정식은 self-update/claudeMcpMissing 과 같은 기준(최상위 mcpServers 의 `lively` 키)이어야 한다.
const preGate = codeIdx(/grep\s+-q\s+'"lively"/, "등록 유무 사전 판정(셸)");
assert.ok(preGate < reconcile,
  `등록 유무 판정(line ${preGate + 1})이 node 호출(line ${reconcile + 1})보다 앞서야 한다 — 없으면 정상 세션마다 node 를 띄운다`);
assert.ok(preGate < guard,
  "사전 판정이 버전 가드보다 앞서야 한다 — 정상 세션은 grep 두 번이 아니라 한 번으로 끝나야 한다");
// 그리고 그 판정이 **버전 가드를 대체하면 안 된다** — 둘은 서로 다른 사고를 막는다(등록 유무 / 구 키트 블로킹).
assert.ok(codeLines.some((l) => /grep\s+-q\s+--\s+'--mcp-only'/.test(l)),
  "사전 판정을 넣으면서 구 키트 버전 가드를 빼면 안 된다 — 구 키트에서 세션 시작이 분 단위로 막힌다");

console.log("box-spawn-mcp-preflight.test OK — MCP reconcile 이 exec 보다 앞 · 세션 표면 한정 · 구키트 가드 · fail-soft (#3591)");

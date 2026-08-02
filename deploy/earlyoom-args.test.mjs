// earlyoom 인자 회귀락 (#1220) — `deploy/lib/common.sh` 의 EARLYOOM_ARGS 는 **정책 결정 그 자체**라 회귀가 조용하다.
//  이 인자가 틀리면 박스에서만, 그것도 압박이 실제로 올 때만 드러난다(고객사 A는 그 사이 멤버 세션 4개를 잃었다).
//  그래서 값이 아니라 **결정의 근거**를 락한다. 사양·엣지 표: 스크래치패드 spec.md.
//
//  왜 이 세 가지인가(2026-07-28 실측 근거):
//   ㉠ --prefer claude: oom_score 에 +300 을 얹어 **크기와 무관하게 모든 claude 를 1순위**로 만들었다. 커널
//     oom_score 는 하한 666 에 (RAM+swap) 분모라 세션 간 변별이 5점 남짓인데, 거기 +300 이면 3.3GB llama-server
//     (≈758)보다도 작은 177MB claude(≈678+300)가 먼저 죽는다. 죽여도 RAM 은 177MB 만 돌아와 압박이 안 풀린다.
//   ㉡ -s 6: earlyoom 은 `RAM 여유 ≤ -m` **AND** `swap 여유 ≤ -s` 여야 발동한다. swap 8G 를 깐 뒤로는 swap 이
//     거의 다 찰 때까지 방어가 아예 잠들어 있었다. `-s 100,100` 이 earlyoom 이 문서화한 'swap 무시' 관용구다.
//   ㉢ avoid 생명줄: sshd 를 잃으면 박스에 못 들어가고, tmux 를 잃으면 세션 컨테이너가 통째로 날아간다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sh = fs.readFileSync(path.join(here, "lib", "common.sh"), "utf8");

// 배선 단언 — 이 테스트가 **엉뚱한 파일을 읽고 조용히 통과**하지 않게 먼저 못 박는다(vacuous 방지).
assert.ok(/ensure_host_memory_safety\(\)/.test(sh), "common.sh 에서 메모리 안전장치 함수를 찾지 못했다(테스트가 대상을 잃음)");

const m = /local args="([^"]+)"/.exec(sh);
assert.ok(m, "EARLYOOM_ARGS 로 넘길 args 정의를 찾지 못했다");
const args = m[1];

// E1 — prefer 금지. 특정 프로세스를 크기와 무관하게 1순위로 만드는 순간 #1220 이 재현된다.
assert.ok(!/--prefer/.test(args), `--prefer 는 쓰지 않는다(크기순 선택을 무너뜨린다): ${args}`);

// E2 — swap 조건 무력화. `-s <n>` 의 n 이 100 미만이면 그만큼 방어가 늦게 깨어난다.
const s = /-s\s+(\S+)/.exec(args);
assert.ok(s, "-s 인자가 없다");
const [sTerm, sKill] = s[1].split(",");
assert.equal(Number(sTerm), 100, "-s term 은 100(=swap 무시)이어야 한다 — AND 조건이라 이게 낮으면 발동이 늦다");
assert.equal(Number(sKill), 100, "-s kill 도 100 이어야 한다 — 생략하면 term/2=50 이 남아 SIGKILL 에스컬레이션이 막힌다");

// E3 — RAM 임계는 있어야 한다(그게 유일한 발동 축이 됐으므로).
const mm = /-m\s+(\S+)/.exec(args);
assert.ok(mm, "-m 인자가 없다 — swap 조건을 껐으므로 RAM 임계가 유일한 발동 축이다");
assert.ok(Number(mm[1].split(",")[0]) > 0, "-m term 은 0 보다 커야 한다");

// E4 — 생명줄 보호. 이걸 잃으면 압박을 푸는 대신 박스를 잃는다.
for (const name of ["sshd", "systemd", "tmux", "dockerd", "node"]) {
  assert.ok(new RegExp(`\\b${name}`).test(args), `--avoid 에 ${name} 가 있어야 한다: ${args}`);
}
assert.ok(/--avoid/.test(args), "--avoid 자체가 있어야 한다");

// E7 — `oom_score_adj` 왜곡 차단. adj 는 oom_score 에 그대로 더해지므로(mm/oom_kill.c) systemd 계열의
//  adj=100~200 짜리는 **수 MB 만 쓰고도 700~800점**이 되어 3.3GB llama-server 를 제치고 1순위가 된다.
//  그걸 죽이면 몇 MB 만 풀려 #1220 이 고치려던 연쇄 학살이 그대로 재현된다.
//  pilot-box 실측: `(sd-pam)` adj=100 · RSS 3.3MB · score 733 → prefer 를 뺀 순간 실제로 1순위로 뽑혔다.
//  ⚠ 문자열 포함이 아니라 **정규식으로 실제 매칭되는지** 검사한다 — 괄호 이스케이프를 잘못 쓰면 문자열엔 있어도 안 잡힌다.
{
  const avoidPat = /--avoid\s+(\S+)/.exec(args)[1];
  const re = new RegExp(avoidPat);
  assert.ok(re.test("(sd-pam)"), `--avoid 가 (sd-pam) 을 잡아야 한다(adj=100 짜리 3MB 프로세스가 1순위가 된다): ${avoidPat}`);
  // 대조군 — 정작 죽어야 할 것들은 보호되면 안 된다(과잉 차단이 방어를 조용히 죽인다).
  for (const victim of ["claude", "llama-server", "python3"]) {
    assert.ok(!re.test(victim), `--avoid 가 ${victim} 까지 보호하면 안 된다: ${avoidPat}`);
  }
  // 생명줄은 계속 잡혀야 한다.
  for (const life of ["sshd", "systemd", "dbus-daemon", "node"]) {
    assert.ok(re.test(life), `--avoid 가 ${life} 를 놓치면 안 된다: ${avoidPat}`);
  }
}

// E5 — 정규식을 따옴표로 감싸지 않는다. /etc/default/earlyoom 은 systemd EnvironmentFile 로 읽혀
//  $EARLYOOM_ARGS 가 word-split 되는데, 작은따옴표는 벗겨지지 않고 **리터럴로 전달돼 정규식이 깨진다**(#1059 때 잡은 버그).
assert.ok(!/'/.test(args), `args 안에 작은따옴표가 있으면 안 된다(EnvironmentFile 이 리터럴로 넘긴다): ${args}`);

// E6 — 패턴에 공백이 없어야 한다(위와 같은 이유로 따옴표를 못 쓰므로, 공백은 곧 인자 분해다).
const avoid = /--avoid\s+(\S+)/.exec(args);
assert.ok(avoid, "--avoid 패턴을 못 찾았다(공백이 섞여 쪼개졌을 수 있다)");
assert.ok(avoid[1].includes("sshd"), "--avoid 바로 뒤 토큰이 패턴이어야 한다(공백으로 쪼개지면 안 된다)");

console.log("earlyoom-args: all passed");

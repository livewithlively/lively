// 격리 sudo 의 env 보존 계약(#1289 회귀 가드) — 자격 리스가 하네스까지 도달하는가.
//
// 왜 이 테스트가 있나: 위탁 태스크의 셋업토큰은 tmux `-e` 로 세션 env 에 실리지만, 격리 박스에서는
// 곧바로 `sudo -u box_<멤버>` 로 강하한다. sudo 는 기본 env_reset 이라 sudoers 에 **명시 보존**하지 않은
// 변수는 그 자리에서 사라진다 — 오류 없이. 하네스는 디스크의 로그인 자격으로 조용히 폴백하므로
// "등록도 했고 게이트웨이가 리스도 실었는데 엉뚱한 계정의 크레딧이 소모되는" 무증상 결함이 된다.
// 고객사 A에서 실제로 그랬고, 리스 조회 결함(task-scheduler-lease.test)과 증상이 **동일**해 구분이 안 됐다.
//
// 두 목록이 같아야 하는 이유: 세션은 캡 여부에 따라 box-spawn 직행 또는 box-cgspawn 경유로 갈린다.
// 한쪽에만 변수를 추가하면 캡 세션과 비캡 세션의 자격이 달라진다. sudoers 주석이 "수기 동기화 규율"이라
// 적어둔 자리이며 — 강제 장치가 없어서 이 테스트가 그 규율이 된다.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const LEASE = "CLAUDE_CODE_OAUTH_TOKEN";
const sudoers = readFileSync(new URL("./linux/sudoers-lively", import.meta.url), "utf8");
const spawnSrc = readFileSync(new URL("./linux/box-spawn", import.meta.url), "utf8");
//  ★ env 계약은 2026-09-01 에 **정본 한 벌**(linux/session-env.sh)로 옮겼다(#2258 이동 2) — 세 표면이
//   같은 파일을 소비한다. 그래서 «box-spawn 실행 경로에 계약이 있는가» 를 두 파일을 이어 본다.
//   ⚠ 배선 단언이 먼저다: box-spawn 이 그 라이브러리를 정말 source 하지 않으면 이어 보는 것 자체가 공허하다.
const envLib = readFileSync(new URL("./linux/session-env.sh", import.meta.url), "utf8");
assert.match(spawnSrc, /\.\s+"\$_envlib"/,
  "box-spawn 이 session-env.sh 를 source 하지 않는다 — 계약이 실행 경로 밖에 있다");
assert.match(spawnSrc, /lvly_session_env\s/,
  "box-spawn 이 lvly_session_env 를 부르지 않는다 — source 만 하고 적용을 안 한다");
const spawn = `${spawnSrc}\n${envLib}`;

// 보존 목록 추출 — Cmnd 별 env_keep 한 줄씩.
const keeps = new Map();
for (const line of sudoers.split("\n")) {
  const m = /^Defaults!(\S+)\s+env_keep\s*\+=\s*"([^"]*)"/.exec(line);
  if (m) keeps.set(m[1].split("/").pop(), new Set(m[2].trim().split(/\s+/).filter(Boolean)));
}
// 배선 확인 — 파싱이 헛돌면 아래 단언이 전부 공허해진다.
assert.ok(keeps.has("box-spawn") && keeps.has("box-cgspawn"),
  `sudoers 에서 env_keep 줄을 못 찾았다(파싱 실패 — 테스트가 아무것도 안 보고 있다). 찾은 것: ${[...keeps.keys()]}`);

// E1 — 리스 변수가 box-spawn 경로에 보존된다.
assert.ok(keeps.get("box-spawn").has(LEASE),
  `${LEASE} 이 box-spawn env_keep 에 없다 — sudo 가 지워 하네스가 디스크 자격으로 폴백한다(무증상)`);

// E2 — 두 경로의 목록이 완전히 같다(순서 무관, 집합 일치).
const a = [...keeps.get("box-spawn")].sort(), b = [...keeps.get("box-cgspawn")].sort();
assert.deepEqual(b, a,
  `box-spawn 과 box-cgspawn 의 보존 목록이 다르다 — 캡 세션과 비캡 세션의 env 가 갈린다. 차이: ${
    [...new Set([...a, ...b])].filter((v) => a.includes(v) !== b.includes(v)).join(", ")}`);

// E3 — box-spawn 이 받은 토큰을 하네스로 재-export 한다(TZ·LIVELY_SESSION_ID 와 같은 계약).
assert.match(spawn, new RegExp(`if \\[ -n "\\$\\{${LEASE}:-\\}" \\]; then export ${LEASE}; fi`),
  `box-spawn 이 ${LEASE} 을 재-export 하지 않는다 — 보존 계약이 스크립트에 안 박혔다`);

// E4 — 미설정이면 손대지 않는다(무회귀). 위 재-export 는 -n 가드 안에 있어야 한다.
assert.ok(!new RegExp(`^\\s*export ${LEASE}=`, "m").test(spawn),
  `${LEASE} 을 무조건 세팅하면 리스 없는 세션의 디스크 자격 폴백이 깨진다`);

// E4b — 값이 스크립트에 노출되지 않는다(echo/로그 금지).
for (const bad of [new RegExp(`echo[^\\n]*\\$\\{?${LEASE}`), new RegExp(`printf[^\\n]*\\$\\{?${LEASE}`)]) {
  assert.ok(!bad.test(spawn), `${LEASE} 값이 출력 경로에 실렸다 — 시크릿 노출`);
}

// E5 — 기존 보존 항목이 하나도 빠지지 않았다(이번 변경의 부작용 방지).
for (const v of ["TZ", "LIVELY_SESSION_ID", "LIVELY_MODE", "LIVELY_READONLY", "LIVELY_INCOGNITO", "LIVELY_OFF",
  "LIVELY_BROKER_SOCKET", "LIVELY_BROKER_MEMBER", "LIVELY_BROKER_WORKROOT", "LIVELY_BROKER_ALLOWED_TOOLS",
  "LIVELY_BROKER_INTERNAL_HOSTS", "LIVELY_BROKER_ENTRY", "LIVELY_BROKER_AUTH"]) {
  assert.ok(keeps.get("box-spawn").has(v), `기존 보존 항목 ${v} 이 사라졌다`);
}

console.log("sudoers-env-lease.test: ok");

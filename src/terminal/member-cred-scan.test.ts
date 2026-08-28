// 멤버 자격 확인이 **중계를 몇 번 타는가** (#2055 후속, 2026-08-28).
//
//  왜 횟수를 세나: 이 판정은 로컬 격리에서는 drop-priv 한 번이라 싸지만, 중계 배포(매니지드)에서는 한 번이
//  게이트웨이 → 허브 → 노드 → docker exec 이다. 종전 판은 하네스마다 순차로 물어서 **온보딩의
//  «ChatGPT 가 연결돼 있는지 확인하고 있어요…» 와 [로그인했어요] 가 10초 넘게** 걸렸다(2026-08-28 프로덕션 실측).
//  사람은 그 사이 로그인이 안 된 줄 안다. 표(HARNESS_CRED)가 늘어날수록 더 느려지는 모양이라 계약으로 못박는다.
//
//  ⚠ «빠른가» 를 재지 않는다(시간은 환경마다 다르다). **왕복 횟수**를 잰다 — 그게 이 결함의 원인이었다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "credscan-"));
const relayLog = path.join(tmp, "relay.log");

// 가짜 중계 — 부를 때마다 한 줄 남긴다. 그게 곧 «왕복 1회» 다.
const relay = path.join(tmp, "relay.sh");
fs.writeFileSync(relay, [
  "#!/bin/sh",
  `echo "CALL" >> ${JSON.stringify(relayLog)}`,
  // argv: <slug> <osUser> -- sh -c <script>   → 스크립트를 그대로 돌린다(홈은 아래에서 만든다).
  'shift 2; shift; exec "$@"',
].join("\n"), { mode: 0o755 });

process.env.LIVELY_MEMBER_EXEC = relay;
process.env.LIVELY_MEMBER_HOME_BASE = path.join(tmp, "homes");

// 스크립트는 /home/box_u1 을 보는데 테스트 환경엔 없다 — `[ -f ]` 가 false 를 낼 뿐이라 안전하다.
//  이 검사가 보는 것은 «있나 없나» 가 아니라 **몇 번 물었나** 다.

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => {
  await fn(); pass++; console.log(`ok  ${name}`);
};
const calls = (): number => {
  try { return fs.readFileSync(relayLog, "utf8").split("\n").filter(Boolean).length; } catch { return 0; }
};

const { memberOsStatus } = await import("./profiles.js");

await t("배선 · 가짜 중계가 실제로 불린다(vacuous 방지)", async () => {
  fs.rmSync(relayLog, { force: true });
  await memberOsStatus("u1");
  assert.ok(calls() > 0, "중계가 한 번도 안 불렸다 — 이 검사가 아무것도 안 지킨다");
});

await t("★ 자격 확인은 하네스 수와 무관하게 왕복이 늘지 않는다 — 매니지드에서 그게 10초가 된다", async () => {
  fs.rmSync(relayLog, { force: true });
  await memberOsStatus("u1");
  const n = calls();
  // 표에 하네스가 셋(claude·codex·grok)이다. 하나씩 물으면 최소 3회 + 홈 확인 1회 = 4회가 된다.
  //  한 번으로 접었으면 자격 확인 1회 + 홈 확인 1회 = 2회를 넘지 않는다.
  assert.ok(n <= 2, `중계 왕복이 ${n}회다 — 하네스마다 따로 묻고 있다(한 번으로 접어라)`);
});

console.log(`member-cred-scan: ${pass} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
delete process.env.LIVELY_MEMBER_EXEC;

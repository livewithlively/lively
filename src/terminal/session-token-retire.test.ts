// #5611 — 세션을 **내리는** 자리는 훅 토큰을 즉시 죽이지 않는다(retireSessionTokens — 훅은 유예 뒤 · MCP 는 즉시).
//
// 왜(실측 2026-11-20 매니지드): 세션 기록 캡처의 SessionEnd 판(session-log-capture-end)이 서버에 잘 실려 있었는데도
//  보관 직후 30초 동안 중앙 기록이 0바이트 그대로였다. 게이트웨이가 노드에 kill 을 보낸 **바로 다음 줄**에서 그 세션의
//  훅 토큰을 회수해, 내려가는 세션의 러너가 훅 목록을 받는 순간 이미 401 이었다(SessionEnd 목록 캐시가 갱신조차 안 됨).
//
// 이 시험이 묶는 것(DB 없이 — 유예 SQL 자체는 src/org/store/token-revoke.pg-test.mjs X1~X7):
//  ① 세션을 내리는 세 자리(사람의 보관·삭제 · 박스 killSession · 원격 PC 자동 끄기)가 retireSessionTokens 를 부른다.
//  ② 유예는 캡처의 «뒤에서 올리는 판» 이 스스로 접는 시간(BG_HARD_MS)보다 짧지 않다 — 짧으면 큰 대화가 올리다 401 로 끊긴다.
//  ③ 생성 실패 정리·과업 세션 회수는 즉시 회수(revokeSessionHookToken)를 그대로 쓴다 — 올릴 대화가 없는 자리다.
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_HOOK_END_GRACE_SEC } from "./profiles.js";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p: string[]): string => fs.readFileSync(path.join(REPO_ROOT, ...p), "utf8");

test("① 세션을 내리는 세 자리는 retireSessionTokens — 즉시 회수(revokeSessionHookToken)를 부르지 않는다", () => {
  const sites: Array<[string, string[], RegExp]> = [
    ["사람의 보관·삭제(노드 세션 갈래)", ["src", "terminal", "routes.ts"], /await retireSessionTokens\(id\)/],
    ["박스 killSession", ["src", "terminal", "sessions.ts"], /await retireSessionTokens\(id\)/],
    ["원격 PC 자동 끄기", ["src", "sessions", "node-stop-rule.ts"], /revokeTokens: async \(id\) => \(await import\("\.\.\/terminal\/profiles\.js"\)\)\.retireSessionTokens\(id\)/],
  ];
  for (const [what, p, re] of sites) {
    const src = read(...p);
    assert.match(src, re, `${what}(${p.join("/")}) 가 retireSessionTokens 를 불러야 한다`);
    const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    assert.doesNotMatch(code, /revokeSessionHookToken\(/, `${what}(${p.join("/")}) 에 즉시 회수가 남아 있다 — 내려가는 세션의 SessionEnd 훅이 401 을 받는다`);
  }
});

test("② 유예 ≥ 캡처의 뒤 판이 스스로 접는 시간(BG_HARD_MS)", () => {
  const hook = read("kit", "hooks", "examples", "session-log-capture.org-hook.mjs");
  const m = hook.match(/const BG_HARD_MS = (\d+) \* 60_000;/);
  assert.ok(m, "session-log-capture 의 BG_HARD_MS 정의 모양이 바뀌었다 — 이 시험의 읽기를 함께 고쳐라");
  const hardSec = Number(m![1]) * 60;
  assert.ok(SESSION_HOOK_END_GRACE_SEC >= hardSec, `유예 ${SESSION_HOOK_END_GRACE_SEC}s < 뒤 판 상한 ${hardSec}s — 큰 대화가 올리다 끊긴다`);
  assert.ok(SESSION_HOOK_END_GRACE_SEC <= 60 * 60, `유예 ${SESSION_HOOK_END_GRACE_SEC}s 가 1시간을 넘는다 — 내려간 세션의 자격이 너무 오래 산다`);
});

test("③ 올릴 대화가 없는 자리(생성 실패 정리·과업 세션)는 즉시 회수 그대로", () => {
  for (const p of [["src", "node", "provision-remote.ts"], ["src", "terminal", "node-session-preissue.ts"], ["src", "terminal", "node-session-token-backfill.ts"]]) {
    assert.match(read(...p), /revokeSessionHookToken/, `${p.join("/")} 는 즉시 회수를 쓴다`);
  }
});

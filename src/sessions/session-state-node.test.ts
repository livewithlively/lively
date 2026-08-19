// #1791 — 노드 에이전트 프로세스(LIVELY_NODE_TOKEN 있음)에서는 desired-state 저장소가 **DB 를 건드리지 않는다.**
//  왜 시험하나: 노드엔 DB 가 없다. 종전엔 노드의 createSession 이 같은 upsert 를 시도해 세션마다 "미러 실패"를 찍고,
//  collectSessions 의 desired 조회가 3초마다 실패 로그를 남겨 노드 로그가 그 줄로 채워졌다(하루 9천 줄 — 실 사고 원인이 묻힘).
//  판별자는 프로세스 환경변수라 **자식 프로세스**로 재현한다(모듈 로드 시점에 굳는다). DB 주소는 닫힌 포트 —
//  가드가 없으면 연결 거부로 실패하고(E2 대조군이 그걸 증명), 가드가 있으면 아무 데도 안 가고 끝난다(E1).
import { strict as assert } from "node:assert";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateUrl = new URL("./session-state.js", import.meta.url).href;
const desiredUrl = new URL("./session-desired.js", import.meta.url).href;

// 자식 스크립트 — 쓰기 4종 + 읽기 2종을 차례로 부르고, 읽기 결과 요약을 stdout 마지막 줄에 JSON 으로 남긴다.
const SCRIPT = `
import { upsertSessionState, touchSessionBusy, updateSessionStateMeta, deleteSessionState } from ${JSON.stringify(stateUrl)};
import { loadDesiredMap, loadDesiredOne } from ${JSON.stringify(desiredUrl)};
await upsertSessionState({ id: "box-t-00000001", owner: "t", label: "l", harness: "claude", dir: null, root_key: null, subpath: null,
  flags: {}, auto_approve: false, invites: [], project_id: null, project_src: null, read_only: false, incognito: false, created: 1, last_busy: null, node_id: "n1" });
await touchSessionBusy("box-t-00000001", 2);
await updateSessionStateMeta("box-t-00000001", { label: "l2" });
await deleteSessionState("box-t-00000001");
const m = await loadDesiredMap(["box-t-00000001"]);
const o = await loadDesiredOne("box-t-00000001");
console.log("RESULT " + JSON.stringify({ map: m.size, one: o === undefined }));
`;

function run(env: Record<string, string | undefined>): { status: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", SCRIPT], {
    cwd: here, encoding: "utf8", timeout: 20_000,
    // 닫힌 포트 — 가드가 없으면 여기로 연결을 시도하다 거부당한다(빠르게 실패). 실 DB 를 절대 건드리지 않는다.
    env: { ...process.env, ITEMS_DATABASE_URL: "postgres://u:p@127.0.0.1:1/none", ...env },
  });
  return { status: r.status, out: r.stdout || "", err: r.stderr || "" };
}

test("E1 노드 프로세스(LIVELY_NODE_TOKEN) — 쓰기 4종·읽기 2종이 DB 없이 조용히 끝난다(오류·경고 0)", () => {
  const r = run({ LIVELY_NODE_TOKEN: "lvk_test" });
  assert.equal(r.status, 0, `노드에서 desired-state 접근이 실패했다:\n${r.err.slice(0, 800)}`);
  const line = r.out.split("\n").find((l) => l.startsWith("RESULT "));
  assert.ok(line, `결과 줄이 없다:\n${r.out.slice(0, 400)}`);
  assert.deepEqual(JSON.parse(line!.slice(7)), { map: 0, one: true }, "노드에서는 빈 결과(tmux 폴백)");
  assert.ok(!/session-desired\]|desired-state/.test(r.err), `노드에서 실패 경고가 찍혔다(3초 노이즈의 원인):\n${r.err.slice(0, 400)}`);
});

test("E2 대조군 — 토큰이 없는 프로세스(게이트웨이)는 같은 호출이 DB 를 실제로 친다(닫힌 포트라 실패) = 가드가 무차별 no-op 이 아니다", () => {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.LIVELY_NODE_TOKEN;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", SCRIPT], {
    cwd: here, encoding: "utf8", timeout: 20_000, env: { ...env, ITEMS_DATABASE_URL: "postgres://u:p@127.0.0.1:1/none" },
  });
  assert.notEqual(r.status, 0, "게이트웨이 프로세스에서 upsert 가 DB 없이 성공하면 가드가 노드 판별 없이 전부 삼킨 것이다");
});

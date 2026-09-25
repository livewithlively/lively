// 노드 세션은 그 세션 주인의 신원으로 서버에 묻는다(#4233) — 사양·엣지 표(행 번호)를 그대로 시나리오로 옮겼다.
//  사고: 공유 맥미니 노드에서 원준 세션이 공용 ~/.lively/token(yoon)으로 물어 project-context found:false →
//   AGENTS.md 주입 없음 · 곁칸 [자료] 동기화 무동작 · session_rename 403. 세션 주인 토큰 발급이 노드(DB 없음)에서
//   조용히 실패했고, 게이트웨이의 노드 릴레이는 그 토큰을 굽지도 싣지도 않았다.
//  단언은 문구가 아니라 **부작용**(무엇이 노드로 실려 갔나 · 무엇이 발급·회수됐나 · pane 에 무슨 env 가 걸리나)으로 한다.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  presetSessionId, sessionCredsEnvArgs, prepareNodeSessionCreds, relayCreateNodeSession,
  type NodeSessionCredsDeps,
} from "./session-creds.js";
import { sessionInputFromBody } from "./session-launch.js";
import type { CreateInput, SessionInfo } from "./catalog.js";

const HOOK = "lvk_" + "h".repeat(32);
const MCP = "lvk_" + "m".repeat(32);
const OWNER = "wonjoon-jang";
const PREFIX = "box-wonjoon-jang-";
const ID = "box-wonjoon-jang-2d5aad30";
const INPUT = { kind: "human", label: "", rootKey: "shared", subpath: "project/4233", harness: "claude", flags: {}, autoApprove: false, projectId: 4233 } as unknown as CreateInput;

/** 가짜 deps — 발급·회수·릴레이를 **기록**한다(부작용 관측 장치). */
function rig(over: Partial<NodeSessionCredsDeps> & { nodeReturnsId?: (sent: CreateInput) => string } = {}) {
  const log = { mint: [] as string[], revoke: [] as string[], relay: [] as Record<string, unknown>[] };
  const deps: NodeSessionCredsDeps = {
    newId: () => ID,
    mintHook: async (o, id) => { log.mint.push(`hook:${o}:${id}`); return HOOK; },
    mintMcp: async (o, id) => { log.mint.push(`mcp:${o}:${id}`); return MCP; },
    revoke: async (id) => { log.revoke.push(id); },
    relay: async (_n, _op, args) => {
      log.relay.push(args);
      const sent = args.input as CreateInput;
      // 새 노드처럼 군다: 봉투 id 가 있으면 그 id 로 만든다(presetSessionId 와 같은 규칙).
      const id = over.nodeReturnsId ? over.nodeReturnsId(sent) : (presetSessionId(PREFIX, sent.sessionCreds) ?? "box-wonjoon-jang-ffffffff");
      return { id } as unknown as SessionInfo;
    },
    warn: () => { /* 조용히 */ },
    ...over,
  };
  return { deps, log };
}
const sentInput = (log: { relay: Record<string, unknown>[] }): CreateInput => log.relay[0]!.input as CreateInput;

// ── 게이트웨이: 봉투를 굽고 싣고 결과를 맞춘다 ──────────────────────────────

test("#1 남의 PC 에서 주인 세션 — 봉투(id+두 토큰)가 노드로 가고, 그 id 로 서며, 회수는 없다", async () => {
  const { deps, log } = rig();
  const s = await relayCreateNodeSession("laibeulliui-macmini", "create", OWNER, INPUT, { hostProfile: false, invites: [] }, deps);
  assert.equal(log.relay.length, 1, "배선: 릴레이가 실제로 불렸다");
  assert.deepEqual(log.relay[0]!.user, { userId: OWNER }, "노드는 이 주인으로 만든다");
  assert.deepEqual(sentInput(log).sessionCreds, { id: ID, hookToken: HOOK, mcpToken: MCP });
  assert.deepEqual(log.mint.sort(), [`hook:${OWNER}:${ID}`, `mcp:${OWNER}:${ID}`], "세션 id 이름표로 주인 토큰 둘을 구웠다");
  assert.equal(s.id, ID);
  assert.deepEqual(log.revoke, []);
  // 노드 쪽 효과까지 이어서 본다: 이 세션 pane 에 두 env 가 걸린다.
  assert.deepEqual(sessionCredsEnvArgs(sentInput(log).sessionCreds, s.id), ["-e", `LIVELY_TOKEN=${HOOK}`, "-e", `LIVELY_MCP_TOKEN=${MCP}`]);
});

test("#2 주인 자기 PC(hostProfile) — 발급 0 · 봉투 없음 · 회수 0 (종전 그대로)", async () => {
  const { deps, log } = rig();
  await relayCreateNodeSession("n", "create", OWNER, INPUT, { hostProfile: true, invites: [] }, deps);
  assert.equal(log.relay.length, 1, "배선");
  assert.equal(sentInput(log).sessionCreds, undefined);
  assert.equal(sentInput(log).hostProfile, true);
  assert.deepEqual(log.mint, []);
  assert.deepEqual(log.revoke, []);
});

test("#3 훅 발급만 실패 — MCP 만 실리고, pane 에도 MCP 만 걸린다", async () => {
  const { deps, log } = rig({ mintHook: async () => { throw new Error("db down"); } });
  const s = await relayCreateNodeSession("n", "create", OWNER, INPUT, { hostProfile: false, invites: [] }, deps);
  assert.deepEqual(sentInput(log).sessionCreds, { id: ID, hookToken: null, mcpToken: MCP });
  assert.deepEqual(sessionCredsEnvArgs(sentInput(log).sessionCreds, s.id), ["-e", `LIVELY_MCP_TOKEN=${MCP}`]);
});

test("#4 둘 다 발급 안 됨 — 봉투 없음(노드가 id 를 정하는 종전 경로)", async () => {
  const { deps, log } = rig({ mintHook: async () => null, mintMcp: async () => { throw new Error("scope 0"); } });
  await relayCreateNodeSession("n", "create", OWNER, INPUT, { hostProfile: false, invites: [] }, deps);
  assert.equal(sentInput(log).sessionCreds, undefined);
  assert.deepEqual(log.revoke, []);
});

test("#5 주인 id 가 빈 값 — 굽지 않는다", async () => {
  const { deps, log } = rig();
  assert.equal(await prepareNodeSessionCreds("", false, deps), null);
  assert.deepEqual(log.mint, []);
});

test("#6 옛 노드가 봉투를 무시하고 제 id 로 만들면 — 세션은 살고, 방금 구운 토큰은 즉시 회수", async () => {
  const { deps, log } = rig({ nodeReturnsId: () => "box-wonjoon-jang-ffffffff" });
  const s = await relayCreateNodeSession("n", "create", OWNER, INPUT, { hostProfile: false, invites: [] }, deps);
  assert.equal(s.id, "box-wonjoon-jang-ffffffff");
  assert.deepEqual(log.revoke, [ID], "어느 pane 에도 안 실린 자격을 살려 두지 않는다");
});

test("#7 노드 릴레이 실패 — 토큰 회수 + 오류 그대로 전파", async () => {
  const { deps, log } = rig({ relay: async () => { throw new Error("노드가 오프라인입니다"); } });
  await assert.rejects(relayCreateNodeSession("n", "create", OWNER, INPUT, { hostProfile: false, invites: [] }, deps), /오프라인/);
  assert.deepEqual(log.revoke, [ID]);
});

// ── 노드: 봉투를 따르는 조건 ─────────────────────────────────────────────

test("#8 봉투 id 가 이 주인 접두 + 형식 일치 — 그 id 를 쓴다", () => {
  assert.equal(presetSessionId(PREFIX, { id: ID }), ID);
});

test("#9 남의 접두 · 형식 불량 · 봉투 없음 · 접두 빈값 — 쓰지 않는다", () => {
  assert.equal(presetSessionId(PREFIX, { id: "box-yoon-2d5aad30" }), null, "남의 세션 id 로 만들지 않는다");
  assert.equal(presetSessionId(PREFIX, { id: "box-wonjoon-jang-2D5AAD30" }), null, "대문자 hex");
  assert.equal(presetSessionId(PREFIX, { id: "box-wonjoon-jang-2d5aad3" }), null, "7자리");
  assert.equal(presetSessionId(PREFIX, { id: `${ID}\n` }), null);
  assert.equal(presetSessionId(PREFIX, undefined), null);
  assert.equal(presetSessionId(PREFIX, { id: "" }), null);
  assert.equal(presetSessionId("", { id: ID }), null);
});

test("#10 다른 세션의 봉투 — pane 에 아무것도 안 싣는다", () => {
  assert.deepEqual(sessionCredsEnvArgs({ id: ID, hookToken: HOOK, mcpToken: MCP }, "box-wonjoon-jang-00000000"), []);
  assert.deepEqual(sessionCredsEnvArgs(null, ID), []);
});

test("#11 토큰 값에 개행·공백·비허용 문자 — 그 값은 안 싣는다", () => {
  assert.deepEqual(sessionCredsEnvArgs({ id: ID, hookToken: "lvk_aaaaaaaaaaaaaaaa\nLIVELY_OFF=1", mcpToken: MCP }, ID), ["-e", `LIVELY_MCP_TOKEN=${MCP}`]);
  assert.deepEqual(sessionCredsEnvArgs({ id: ID, hookToken: "lvk_aaaa aaaaaaaaaaaa", mcpToken: "lvk_aaaaaaaaaaaaaa$(x)" }, ID), []);
});

test("#12 경계값 — 토큰 길이 16·512 허용, 15·513 거부", () => {
  const at = (n: number) => sessionCredsEnvArgs({ id: ID, hookToken: "a".repeat(n) }, ID).length;
  assert.equal(at(16), 2);
  assert.equal(at(512), 2);
  assert.equal(at(15), 0);
  assert.equal(at(513), 0);
});

test("#13 HTTP body 로는 봉투를 꽂을 수 없다", () => {
  const input = sessionInputFromBody({}, {
    harness: "claude", label: "x",
    sessionCreds: { id: ID, hookToken: HOOK, mcpToken: MCP },
  });
  assert.equal(input.harness, "claude", "배선: body 를 실제로 읽었다");
  assert.equal(input.sessionCreds, undefined);
});

// ── 배선 — 봉투를 빠뜨리는 입구가 다시 생기면 그 입구로 연 세션만 조용히 남의 신원이 된다 ──
//  빌드 후 dist/terminal/ 에서 돈다 → 레포 루트는 ../../
const readRepo = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

test("#14 배선 — 모든 노드 세션 입구가 봉투 한 길 · 전환·복원도 소속 확정 · kill 이 회수", () => {
  const launch = readRepo("src/terminal/session-launch.ts");
  const routes = readRepo("src/terminal/routes.ts");
  assert.ok(launch.length > 1000 && routes.length > 1000, "배선: 파일을 정말 읽었다");
  assert.equal((routes.match(/relayNodeOp<SessionInfo>/g) ?? []).length, 0,
    "routes.ts 가 노드 세션 create 를 직접 릴레이한다 — createNodeSession 을 써라(봉투가 빠진다)");
  assert.equal((launch.match(/relayNodeOp<SessionInfo>/g) ?? []).length, 1, "session-launch.ts 의 직접 릴레이는 deps.relay 하나뿐");
  assert.match(launch, /await createNodeSession\(nodeId, op, me, plan\.createInput/, "새 세션(launchSession 노드 갈래)");
  assert.match(routes, /await createNodeSession\(nodeId, "create", me, input/, "하네스 전환");
  assert.match(routes, /await createNodeSession\(nodeId, op, owner, remoteInput/, "복원");
  assert.equal((routes.match(/await bindNodeSessionProjectOrKill\(/g) ?? []).length, 2, "전환·복원 모두 새 id 로 소속 확정");
  assert.equal((routes.match(/await revokeNodeSessionCreds\(id\)/g) ?? []).length, 2, "노드 kill 의 보관·삭제 두 갈래 모두 회수");
});

test("#15 배선 — 노드 createSession 은 봉투가 있으면 게이트웨이 id 를 쓰고 로컬 발급을 건너뛴다", () => {
  const sessions = readRepo("src/terminal/sessions.ts");
  assert.match(sessions, /const id = presetSessionId\(sessionPrefix\(user\), input\.sessionCreds\) \?\?/);
  assert.match(sessions, /prepared \? null : await mintSessionHookToken/);
  assert.match(sessions, /prepared \? null : await mintSessionMcpToken/);
  assert.match(sessions, /if \(prepared\) args\.push\(\.\.\.sessionCredsEnvArgs\(prepared, id\)\)/);
});

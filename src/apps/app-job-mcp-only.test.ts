// 앱 AI 작업의 «라이블리 MCP 만»(매니페스트 ai.mcp_only) — 값을 «부른 사람(주소)의 판» 에서 읽는다(앱 판 지시와 같은 규칙).
//  판 고르기는 진짜 규칙(visibility.appViewFor · app-view.asPublished)으로 하고 판 행만 가짜로 바꿔 끼운다 — 가짜가 규칙을 흉내 내면 규칙이 틀려도 통과한다.
//  행 번호는 사양 S3~S8. 이게 틀리면: 공개 판을 보는 사람의 작업이 초안의 선언으로(또는 그 반대로) 내장 도구를 연 채 돌거나, 볼 수 없는 앱의 값을 모른 채 진행한다.
import assert from "node:assert/strict";
import { mcpOnlyOf, resolveJobMcpOnly, type McpOnlyDeps } from "./app-job-mcp-only.js";
import { appViewFor, type Viewer } from "./visibility.js";
import { asPublished } from "./app-view.js";
import type { OrgApp } from "../org/store/apps.js";
import { HttpError } from "../http-error.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  try { await fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++;
  console.log(`ok  ${name}`);
};

/** ai 칸을 받아 매니페스트를 만든다 — mcp_only 를 빼거나(종전) 모양을 틀리게 둘 수 있게. */
const manifestWith = (ai: Record<string, unknown>) => ({ id: "policy", title: "정책", ai: { jobs: [{ name: "answer" }, { name: "lookup" }], ...ai } });
const DECLARED = { mcp_only: ["answer"] };

/**
 * 공개 앱 «policy» — 공개 판 2 · alice 가 고친 초안 = 설치된 상태 3. 기본은 두 판 모두 answer 를 «MCP 만» 으로 선언.
 *  noDraft 면 걸린 초안이 없다(설치된 상태가 모두의 판 — 따로 볼 공개 판이 없다).
 */
function world(o: { draftAi?: Record<string, unknown>; pubAi?: Record<string, unknown>; visibility?: "all" | "me"; noDraft?: boolean } = {}) {
  let views = 0;
  const heads: Record<number, { manifest: unknown; content_hash: string }> = {
    2: { manifest: manifestWith(o.pubAi ?? DECLARED), content_hash: "h2" },
    3: { manifest: manifestWith(o.draftAi ?? DECLARED), content_hash: "h3" },
  };
  const app = {
    id: "policy", title: "정책", version: "0.3.0", manifest: heads[3]!.manifest, content_hash: "h3", current_version_no: 3,
    visibility: o.visibility ?? "all", owner_member: "owner", draft_by: o.noDraft ? null : "alice", published_version_no: o.noDraft ? null : 2,
    source: { kind: "inline" }, installed_at: new Date(0),
  } as unknown as OrgApp;
  const d: McpOnlyDeps = {
    viewAppFor: async (a, who) => {
      views++;
      const view = appViewFor(a, who);
      if (view !== "published") return { view, app: a };
      const h = heads[a.published_version_no as number]!;
      return { view, app: asPublished(a, { version_no: a.published_version_no as number, version: "0.2.0", manifest: h.manifest, content_hash: h.content_hash }) };
    },
  };
  return { app, d, views: () => views };
}
const who = (userId: string, address?: "pub" | "draft"): Viewer => ({ userId, scopes: [], ...(address ? { address } : {}) });
const httpErr = (status: number) => (e: unknown) => e instanceof HttpError && e.status === status;

await t("S8 매니페스트의 ai.mcp_only 목록에 그 작업 이름이 있으면 true — 여럿 중 하나여도", () => {
  assert.equal(mcpOnlyOf(manifestWith({ mcp_only: ["answer"] }), "answer"), true);
  assert.equal(mcpOnlyOf(manifestWith({ mcp_only: ["lookup", "answer"] }), "answer"), true);
  assert.equal(mcpOnlyOf(manifestWith({ mcp_only: ["lookup", "answer"] }), "lookup"), true);
});

await t("S8 다른 이름만 · 목록이 배열이 아님 · 매니페스트가 null 이면 false — 저장된 매니페스트를 읽는 자리라 던지지 않는다", () => {
  assert.equal(mcpOnlyOf(manifestWith({ mcp_only: ["lookup"] }), "answer"), false);
  assert.equal(mcpOnlyOf(manifestWith({ mcp_only: ["answer-x", "answe"] }), "answer"), false, "같은 이름만 — 앞머리 · 일부는 다른 이름");
  //  글 · 배열 흉내도 «배열이 아님» — 글자 포함으로 읽으면 "answers" 가 answer 를 연다.
  for (const bad of ["answer", "answers", { answer: true }, { 0: "answer", length: 1 }, 1, true, null]) {
    assert.equal(mcpOnlyOf(manifestWith({ mcp_only: bad }), "answer"), false, `배열 아님: ${JSON.stringify(bad)}`);
  }
  for (const m of [null, undefined, {}, [], "policy", 3, { ai: null }, { ai: "x" }, { ai: [] }]) {
    assert.equal(mcpOnlyOf(m, "answer"), false, String(JSON.stringify(m)));
  }
});

await t("S3 ai.mcp_only 가 없거나 빈 목록이면 false(종전 그대로) — 판을 골라 읽어도 같다", async () => {
  assert.equal(mcpOnlyOf(manifestWith({}), "answer"), false);
  assert.equal(mcpOnlyOf(manifestWith({ mcp_only: [] }), "answer"), false);
  assert.equal(mcpOnlyOf({ id: "policy", title: "정책" }, "answer"), false, "ai 칸 자체가 없는 앱");
  const { app, d } = world({ draftAi: {}, pubAi: { mcp_only: [] } });
  assert.equal(await resolveJobMcpOnly(app, who("alice"), "answer", d), false);
  assert.equal(await resolveJobMcpOnly(app, who("bob"), "answer", d), false);
});

await t("S5 작업 이름이 없으면(빈 값 · null · undefined) false — 목록에 빈 이름이 있어도", async () => {
  for (const job of ["", null, undefined]) {
    assert.equal(mcpOnlyOf(manifestWith({ mcp_only: ["answer", ""] }), job), false, String(job));
    const { app, d } = world();
    assert.equal(await resolveJobMcpOnly(app, who("alice"), job, d), false, `초안을 고친 사람: ${String(job)}`);
    assert.equal(await resolveJobMcpOnly(app, who("bob"), job, d), false, `공개 판을 보는 사람: ${String(job)}`);
  }
});

await t("S4 초안만 선언 — 초안을 고친 사람(설치된 상태)은 true · 다른 사람(공개 판)은 false · 앱 주소면 그 주소의 판(고친 사람도 공개 주소면 false)", async () => {
  const { app, d } = world({ pubAi: {} });
  assert.equal(await resolveJobMcpOnly(app, who("alice"), "answer", d), true);
  assert.equal(await resolveJobMcpOnly(app, who("bob"), "answer", d), false);
  assert.equal(await resolveJobMcpOnly(app, who("alice", "pub"), "answer", d), false, "공개 주소는 공개 판 — 초안을 고친 사람도");
  assert.equal(await resolveJobMcpOnly(app, who("alice", "draft"), "answer", d), true, "초안 주소는 설치된 상태");
  assert.equal(await resolveJobMcpOnly(app, who("bob", "pub"), "answer", d), false);
});

await t("S4 공개 판만 선언 — 다른 사람(공개 판)은 true · 초안을 고친 사람은 false · 공개 주소면 고친 사람도 true", async () => {
  const { app, d } = world({ draftAi: {} });
  assert.equal(await resolveJobMcpOnly(app, who("bob"), "answer", d), true, "설치된 매니페스트가 선언하지 않아도 걸린 초안이 있으면 공개 판을 본다");
  assert.equal(await resolveJobMcpOnly(app, who("bob", "pub"), "answer", d), true);
  assert.equal(await resolveJobMcpOnly(app, who("alice"), "answer", d), false);
  assert.equal(await resolveJobMcpOnly(app, who("alice", "draft"), "answer", d), false);
  assert.equal(await resolveJobMcpOnly(app, who("alice", "pub"), "answer", d), true);
});

await t("S4 작업마다 그 판의 목록으로 — 초안은 lookup · 공개 판은 answer 를 선언", async () => {
  const { app, d } = world({ draftAi: { mcp_only: ["lookup"] }, pubAi: { mcp_only: ["answer"] } });
  assert.equal(await resolveJobMcpOnly(app, who("alice"), "lookup", d), true);
  assert.equal(await resolveJobMcpOnly(app, who("alice"), "answer", d), false);
  assert.equal(await resolveJobMcpOnly(app, who("bob"), "lookup", d), false);
  assert.equal(await resolveJobMcpOnly(app, who("bob"), "answer", d), true);
});

await t("S6 앱을 볼 수 없으면 404 — 값을 모른 채 진행하지 않는다(나만 보는 앱의 남 · 남의 초안 주소)", async () => {
  const me = world({ visibility: "me", noDraft: true });
  await assert.rejects(resolveJobMcpOnly(me.app, who("bob"), "answer", me.d), httpErr(404));
  assert.equal(await resolveJobMcpOnly(me.app, who("owner"), "answer", me.d), true, "책임자는 설치된 상태를 본다");
  const all = world();
  await assert.rejects(resolveJobMcpOnly(all.app, who("bob", "draft"), "answer", all.d), httpErr(404), "남의 초안 주소는 볼 수 없는 판");
});

await t("S7 설치된 매니페스트가 그 작업을 선언하지 않았고 걸린 초안도 없으면 — 판을 고르지 않고 false", async () => {
  for (const ai of [{}, { mcp_only: [] }, { mcp_only: ["lookup"] }, { mcp_only: "answer" }]) {
    const { app, d, views } = world({ draftAi: ai, noDraft: true });
    assert.equal(await resolveJobMcpOnly(app, who("bob"), "answer", d), false, JSON.stringify(ai));
    assert.equal(views(), 0, `판을 고르지 않는다: ${JSON.stringify(ai)}`);
  }
  //  선언했으면 판을 본다 — 위의 0 이 «무엇이든 false» 가 아님을 보인다.
  const { app, d } = world({ noDraft: true });
  assert.equal(await resolveJobMcpOnly(app, who("bob"), "answer", d), true);
});

console.log(`# ${pass} pass`);

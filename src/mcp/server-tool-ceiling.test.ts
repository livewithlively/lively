// MCP 도구 목록의 도구 상한(도구 허용 목록 사양 T28) — 서버를 만들 때(buildServer) 도구 상한을 주면 그 밖의 이름은 등록하지 않는다(tools/list 에 안 보임).
//  상한이 없으면 종전과 같은 목록. 진짜 서버를 메모리 안 전송으로 진짜 클라이언트에 붙여 tools/list 를 그대로 읽는다(등록 표를 엿보지 않는다).
//  판정 꼴: 상한 C 를 준 목록 = 같은 서버(같은 앱)를 상한 없이 만든 목록 ∩ C — 상한 밖은 사라지고 상한 안은 종전 그대로.
//  이게 틀리면: 작업 AI 가 상한 밖 도구(store_sql · db_query …)를 목록에서 보고 부르려 들거나, 상한 안 도구가 목록에서 사라져 작업이 못 돈다.
//  (토큰의 상한이 이 인자로 오는 배선 — /mcp 전송 — 은 이 시험 밖이다.)
import assert from "node:assert/strict";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.js";
import type { LivelyUser } from "../context.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  try { await fn(); } catch (e) { console.log(`not ok  ${name}`); throw e; }
  pass++;
  console.log(`ok  ${name}`);
};

/**
 * 서버를 만들어 tools/list 로 보이는 도구 이름들을 읽는다. ceiling 이 undefined 면 상한 인자를 아예 주지 않는다(종전 호출).
 *  도구가 하나도 등록되지 않은 서버는 tools 능력을 알리지 않는다(tools/list 자체가 없다) — 그때는 보이는 도구 0 이다.
 */
async function listed(appId: string | null, ceiling?: readonly string[] | null): Promise<{ names: string[]; advertised: boolean }> {
  const server = ceiling === undefined
    ? buildServer(undefined, undefined, undefined, undefined, undefined, appId)
    : buildServer(undefined, undefined, undefined, undefined, undefined, appId, ceiling);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "tool-ceiling-test", version: "0.0.0" });
  await client.connect(clientSide);
  try {
    if (!client.getServerCapabilities()?.tools) return { names: [], advertised: false };
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      names.push(...page.tools.map((x) => x.name));
      cursor = page.nextCursor;
    } while (cursor);
    return { names, advertised: true };
  } finally {
    await client.close();
  }
}
const sorted = (a: readonly string[]): string[] => [...a].sort();
const within = (base: readonly string[], ceiling: readonly string[]): string[] => sorted(base.filter((n) => ceiling.includes(n)));

//  상한에 넣을 이름들 — 앱 동의에 흔히 드는 것(store_sql · db_query)과 배관(whoami) · 읽기(knowledge_search) · 없는 이름.
const CEILING = ["knowledge_search", "whoami", "store_sql", "db_query", "no_such_tool_xyz"];

await t("T28 상한이 없으면(인자 생략 · null) 종전과 같은 목록 — 상한에 쓸 도구들이 실제로 보인다(관측 장치)", async () => {
  const omitted = await listed(null);
  const nul = await listed(null, null);
  assert.ok(omitted.advertised && omitted.names.length > 10, `도구 목록이 비었다(관측 장치): ${omitted.names.length}`);
  assert.deepEqual(sorted(nul.names), sorted(omitted.names));
  for (const n of ["knowledge_search", "whoami", "store_sql", "db_query"]) assert.ok(omitted.names.includes(n), `상한 없는 목록에 ${n} 이 있어야 한다(관측 장치)`);
});

await t("T28 상한을 주면 그 밖의 이름은 목록에 없다 · 상한 안의 이름은 종전대로 보인다(상한 없는 목록 ∩ 상한)", async () => {
  const base = (await listed(null)).names;
  const got = await listed(null, CEILING);
  assert.deepEqual(sorted(got.names), within(base, CEILING));
  assert.deepEqual(sorted(got.names), ["db_query", "knowledge_search", "store_sql", "whoami"], "상한 안 · 실제 있는 도구만");
});

await t("T28 상한의 이름은 정확한 이름이다 — 상한에 적힌 글롭은 어떤 도구도 열지 않는다", async () => {
  const got = await listed(null, ["knowledge_*", "whoami"]);
  assert.deepEqual(sorted(got.names), ["whoami"]);
});

await t("T28 앱 토큰의 서버(appId)에도 같다 — 같은 앱으로 상한 없이 만든 목록 ∩ 상한", async () => {
  const base = (await listed("crm")).names;
  assert.ok(base.length > 10, "앱 서버 목록이 비었다(관측 장치)");
  const got = await listed("crm", CEILING);
  assert.deepEqual(sorted(got.names), within(base, CEILING));
  assert.ok(!got.names.includes("project_create_v6") && !got.names.includes("knowledge_save"), "상한 밖 쓰기 도구는 없다");
});

await t("T28·T3 빈 상한([])이면 도구를 하나도 등록하지 않는다 — 목록에 아무것도 없다", async () => {
  for (const appId of [null, "crm"]) {
    const got = await listed(appId, []);
    assert.deepEqual(got.names, [], `appId ${appId}: ${JSON.stringify(got.names.slice(0, 5))}`);
  }
});

//  아래 둘은 격리 리뷰가 짚은 길 — 목록 감추기는 서버를 만들 때의 상한을 따르므로, 다른 토큰이 만든 서버를 이어 쓰면 목록은 다 보일 수 있다.
//   그때의 경계는 핸들러가 이 요청의 신원(상한)으로 보는 판정이다. 그리고 buildServer 가 돌아간 뒤에 오는 등록(동적 · 프록시 도구)도 감추기를 지난다.

/** 서버에 클라이언트를 붙이되, 모든 요청에 이 신원을 싣는다(/mcp 전송이 req.auth 로 싣는 것과 같은 자리 — authInfo.extra). */
async function connectAs(server: ReturnType<typeof buildServer>, who: LivelyUser): Promise<Client> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const send = clientSide.send.bind(clientSide);
  (clientSide as unknown as { send: typeof send }).send = (msg, opts) =>
    send(msg, { ...(opts ?? {}), authInfo: { token: "x", clientId: who.userId, scopes: who.scopes, extra: who } } as never);
  await server.connect(serverSide);
  const client = new Client({ name: "tool-ceiling-test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}
const callText = async (client: Client, name: string, args: Record<string, unknown>): Promise<string> =>
  JSON.stringify(await client.callTool({ name, arguments: args }).catch((e: Error) => ({ threw: e.message })));

await t("T24 다른 토큰(상한 없음)이 만든 서버를 상한 토큰이 이어 써도 — 목록엔 보여도 부르면 핸들러가 상한으로 거절한다", async () => {
  const server = buildServer(undefined, undefined, undefined, undefined, undefined, "crm", null);
  const who: LivelyUser = { userId: "m1", email: "", scopes: ["items", "memory", "db"], projects: ["*"], appId: "crm", toolCeiling: ["knowledge_search"] };
  const client = await connectAs(server, who);
  try {
    const names = (await client.listTools()).tools.map((x) => x.name);
    assert.ok(names.includes("db_query") && names.includes("store_sql"), "관측 장치 — 상한 없이 만든 서버는 다 등록한다");
    for (const [name, args] of [["db_query", { sql: "select 1" }], ["store_sql", { sql: "select 1" }], ["knowledge_get", { name: "x" }]] as const) {
      assert.match(await callText(client, name, args), /앱이 이 작업에 허용한 도구 밖/, name);
    }
  } finally {
    await client.close();
  }
});

await t("T28 buildServer 가 돌아간 뒤에 오는 등록(동적 · 프록시 도구)도 상한 밖이면 목록에 없고 부를 수도 없다", async () => {
  const server = buildServer(undefined, undefined, undefined, undefined, undefined, "crm", ["knowledge_search", "ext__ok__tool"]);
  server.registerTool("ext__ok__tool", { description: "상한 안", inputSchema: { a: z.string().optional() } }, async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
  server.registerTool("ext__bad__tool", { description: "상한 밖", inputSchema: { a: z.string().optional() } }, async () => ({ content: [{ type: "text" as const, text: "BAD" }] }));
  const client = await connectAs(server, { userId: "m1", email: "", scopes: [], projects: ["*"], appId: "crm", toolCeiling: ["knowledge_search", "ext__ok__tool"] });
  try {
    assert.deepEqual(sorted((await client.listTools()).tools.map((x) => x.name)), ["ext__ok__tool", "knowledge_search"]);
    const bad = await callText(client, "ext__bad__tool", {});
    assert.ok(!bad.includes("BAD"), `상한 밖 도구가 불렸다: ${bad}`);
  } finally {
    await client.close();
  }
});

console.log(`# ${pass} pass`);

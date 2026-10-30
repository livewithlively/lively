// MCP 도구 목록의 도구 상한(도구 허용 목록 사양 T28) — 서버를 만들 때(buildServer) 도구 상한을 주면 그 밖의 이름은 등록하지 않는다(tools/list 에 안 보임).
//  상한이 없으면 종전과 같은 목록. 진짜 서버를 메모리 안 전송으로 진짜 클라이언트에 붙여 tools/list 를 그대로 읽는다(등록 표를 엿보지 않는다).
//  판정 꼴: 상한 C 를 준 목록 = 같은 서버(같은 앱)를 상한 없이 만든 목록 ∩ C — 상한 밖은 사라지고 상한 안은 종전 그대로.
//  이게 틀리면: 작업 AI 가 상한 밖 도구(store_sql · db_query …)를 목록에서 보고 부르려 들거나, 상한 안 도구가 목록에서 사라져 작업이 못 돈다.
//  (토큰의 상한이 이 인자로 오는 배선 — /mcp 전송 — 은 이 시험 밖이다.)
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../server.js";

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

console.log(`# ${pass} pass`);

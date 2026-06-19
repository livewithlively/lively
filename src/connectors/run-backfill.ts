// 커넥터 백필 → Item store 적재 (멱등).
// 사용: node --env-file-if-exists=.env dist/connectors/run-backfill.js <slack|discord|notion> [--since ISO8601]
//   필요 env: ITEMS_DATABASE_URL + 해당 커넥터 토큰(SLACK_BOT_TOKEN/DISCORD_BOT_TOKEN/NOTION_TOKEN)
import { initItemSchema, ingestItems, resolveParents, type RawItem } from "../items/store.js";
import { initOrgSchema } from "../org/schema.js";
import { connectors } from "./index.js";
import { logger } from "../log.js";

const name = process.argv[2];
const i = process.argv.indexOf("--since");
const since = i > -1 ? process.argv[i + 1] : undefined;

const conn = name ? connectors[name] : undefined;
if (!conn) {
  logger.error(`사용: run-backfill <${Object.keys(connectors).join("|")}> [--since ISO8601]`);
  process.exit(1);
}

await initItemSchema();   // person/connector_state 등 보조 스키마
await initOrgSchema();    // item 폐기 컷오버: ku(knowledge_unit*) 단일 표면 — 미러가 여기 적재

let batch: RawItem[] = [];
let total = 0;
const flush = async () => {
  if (!batch.length) return;
  total += await ingestItems(batch);
  batch = [];
  logger.info(`ingested ${total}`);
};

for await (const item of conn.backfill(since ? { since } : undefined)) {
  batch.push(item);
  if (batch.length >= 200) await flush();
}
await flush();
const linked = await resolveParents();
logger.info(`완료: ${name} → ${total} items, parent 링크 ${linked}건`);
process.exit(0);

// 결정적 매퍼 CLI (Plane B 결정적 플러밍, DESIGN §10.5) — run-backfill.ts 패턴.
// 사용: node --env-file-if-exists=.env dist/items/run-map.js [--repo X] [--since ISO] [--system discord,notion] [--limit N]
//   필요 env: ITEMS_DATABASE_URL, DOMAINMAP_URL, DOMAINMAP_DEFAULT_REPO
// D2~D5 / P1~P4 전부 mapped_by='rule', state='proposed' 로 멱등 upsert. LLM 0.
import { initItemSchema } from "./store.js";
import { runDeterministicMapping } from "./mapping-run.js";
import { logger } from "../log.js";

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const repo = argVal("--repo");
const since = argVal("--since");
const systemsRaw = argVal("--system");
const systems = systemsRaw ? systemsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
const limitRaw = argVal("--limit");
const limit = limitRaw ? Number(limitRaw) : undefined;

await initItemSchema(); // state 컬럼 마이그레이션 포함(멱등) — run-path 는 await 로 안전.

const report = await runDeterministicMapping({ repo, since, systems, limit });
logger.info({ msg: "MapReport", report });
// 사람이 읽기 좋은 요약도 stdout 으로.
console.log(JSON.stringify(report, null, 2));
process.exit(0);

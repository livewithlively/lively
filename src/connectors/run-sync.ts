// ClickUp 원샷 싱크 (phase B) — 태스크 증분/전체 + 커서.
// 사용: node --env-file-if-exists=.env dist/connectors/run-sync.js clickup [--full]
//   필요 env: ITEMS_DATABASE_URL, DOMAINMAP_DATABASE_URL, CLICKUP_API_TOKEN (+선택 CLICKUP_EXCLUDE_LIST_IDS)
// 멱등: 아이템은 (prov_system,prov_instance,external_id) upsert — 두 번 돌려도 중복 없음.
// 커서는 **모든 단계 성공 후에만** 전진 — 중도 실패 run 은 같은 윈도를 다음 run 이 재폴링한다(유실 없음).
import {
  initItemSchema, ingestItems, resolveParents,
  getConnectorState, setConnectorState,
  type RawItem,
} from "../items/store.js";
import { initOrgSchema } from "../org/schema.js";
import {
  getTeam, enumerateLists, fetchListTasks, fetchTeamTasks,
  toRawItem, type ClickUpTask,
} from "./clickup.js";
import { logger } from "../log.js";

const CURSOR_EPSILON_MS = 1000; // date_updated_gt 는 strict greater-than — 동일 ms 경계 유실 방지 재폴링.

const name = process.argv[2];
const fullFlag = process.argv.includes("--full");

if (name !== "clickup") {
  logger.error("사용: run-sync clickup [--full]");
  process.exit(1);
}

await initItemSchema();   // person/connector_state 등 보조 스키마
await initOrgSchema();    // item 폐기 컷오버: ku(knowledge_unit*) 단일 표면 — 미러/매핑이 여기 적재

// ── 1) 컨테이너 나열 (태스크 작업 전에) ──
const team = await getTeam();
const teamId = team.id;
const lists = await enumerateLists(teamId);
logger.info({ teamId, lists: lists.map((l) => `${l.id}:${l.name}`) }, "clickup 리스트 나열");

const failedListIds = new Set<string>();

// ── 3) 태스크 수집 — full(per-list) | incremental(team date_updated_gt) + archived 패스 ──
const cursor = await getConnectorState("clickup", teamId);
const prevMaxMs = Number((cursor as { tasks_max_updated_ms?: unknown } | null)?.tasks_max_updated_ms ?? 0) || 0;
const incremental = !fullFlag && prevMaxMs > 0;
const dateUpdatedGt = incremental ? prevMaxMs - CURSOR_EPSILON_MS : undefined;

const allowedListIds = lists.map((l) => l.id);
const tasks: ClickUpTask[] = [];
if (incremental) {
  // 팀 단위 증분 — list_ids[] 가 허용 리스트만 한정(샘플 리스트 태스크 차단).
  tasks.push(...await fetchTeamTasks(teamId, { dateUpdatedGt, listIds: allowedListIds }));
  // 보관 태스크는 일반 쿼리에서 제외 — 리스트별 archived 패스로 수렴.
  for (const l of lists) {
    try {
      tasks.push(...await fetchListTasks(l.id, { archived: true, dateUpdatedGt }));
    } catch (err) {
      failedListIds.add(l.id);
      console.error(`[clickup] 리스트 ${l.id} archived 패스 실패, skip:`, err);
    }
  }
} else {
  for (const l of lists) {
    try {
      tasks.push(...await fetchListTasks(l.id, {}));
      tasks.push(...await fetchListTasks(l.id, { archived: true }));
    } catch (err) {
      failedListIds.add(l.id);
      console.error(`[clickup] 리스트 ${l.id} 태스크 백필 실패, skip:`, err);
    }
  }
}

// ── 4) 변환 + 적재 (배치 200, 멱등 upsert) ──
const seen = new Set<string>(); // external_id (중복 태스크 dedup)
let maxSeenMs = 0;
let batch: RawItem[] = [];
let ingested = 0;
const flush = async () => {
  if (!batch.length) return;
  ingested += await ingestItems(batch);
  batch = [];
};

for (const task of tasks) {
  if (seen.has(task.id)) continue; // 증분 team 패스 + archived 패스 중복 방어
  try {
    const raw = toRawItem(task, { teamId });
    seen.add(task.id);
    const updMs = Number(task.date_updated ?? 0);
    if (Number.isFinite(updMs) && updMs > maxSeenMs) maxSeenMs = updMs;
    batch.push(raw);
    if (batch.length >= 200) await flush();
  } catch (err) {
    console.error(`[clickup] 태스크 변환 실패 ${task?.id}, skip:`, err);
  }
}
await flush();
const linked = await resolveParents();

// ── 6) 커서 전진 — **전 단계 성공(failed=false) 후에만**. max(이전, 이번 run 관측 최대). ──
// 부분 실패 run 은 커서를 동결한다: 실패 리스트의 archived 패스/백필 누락분을 다음 run 이
// 같은 윈도로 재폴링해 수렴(ingest 가 멱등 upsert 라 재폴링은 무비용 — 유실 없음 불변식).
// 증분 run 이 0건이면 커서를 움직이지 않는다(ClickUp 시계 vs 우리 시계 추측 금지).
const failed = failedListIds.size > 0;
const advanceCursor = !failed && (maxSeenMs > prevMaxMs || (!incremental && maxSeenMs > 0));
if (advanceCursor) {
  await setConnectorState("clickup", teamId, { tasks_max_updated_ms: Math.max(prevMaxMs, maxSeenMs) });
}

logger.info({
  mode: incremental ? "incremental" : "full",
  lists: lists.length,
  tasks: seen.size, ingested, parentLinked: linked,
  cursorMs: advanceCursor ? Math.max(prevMaxMs, maxSeenMs) : prevMaxMs,
  cursorAdvanced: advanceCursor,
}, "clickup 싱크 완료");
process.exit(failed ? 1 : 0);

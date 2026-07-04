// 커넥터 증분 싱크 — 모든 커넥터(커서 기반). 스케줄러 action='connector_sync' 가 서브프로세스로 호출.
//  사용: node --env-file-if-exists=.env dist/connectors/run-sync.js <system> [--full]
//    <system> = clickup | slack | discord | notion | …(레지스트리). --full = 커서 무시 전체 재수집(부트스트랩).
//  필요 env: ITEMS_DATABASE_URL (+커넥터 토큰 — 관리탭 org_connector 또는 .env, connectors/config.ts 해소).
//
//  두 경로:
//   · clickup — 특수(List 나열 + folderless/archived 패스 + team date_updated_gt). instance=teamId 단위 커서.
//   · 그 외   — generic 증분: connector_state(system,'_') 커서 → backfill({since}) → max 관측시각으로 커서 전진.
//
//  멱등: 아이템은 (system,instance,external_id) upsert — 두 번 돌려도 중복 없음(라우팅에 따라 project/knowledge/source).
//  커서는 **모든 단계 성공 후에만** 전진 — 중도 실패 run 은 같은 윈도를 다음 run 이 재폴링한다(유실 없음 불변식, CTO wiki-sync 동일).
import {
  initItemSchema, ingestItems, itemsPool,
  getConnectorState, setConnectorState,
  type RawItem,
} from "../items/store.js";
import { initOrgSchema } from "../org/schema.js";
import { connectors } from "./index.js";
import {
  getTeam, enumerateLists, fetchListTasks, fetchTeamTasks,
  toRawItem, type ClickUpTask,
} from "./clickup.js";
import { getNotionRunStats } from "./notion.js";
import {
  materializeNotionLinks, applyNotionChildrenOrder, sweepNotionArchived,
} from "../v6/connector-mirror.js";
import { logger } from "../log.js";

const CURSOR_EPSILON_MS = 1000; // strict greater-than 커서의 동일 ms 경계 유실 방지 재폴링(멱등이라 무비용).

const name = process.argv[2];
const fullFlag = process.argv.includes("--full");

if (!name || (name !== "clickup" && !connectors[name])) {
  const known = ["clickup", ...Object.keys(connectors).filter((k) => k !== "clickup")];
  logger.error(`사용: run-sync <${known.join("|")}> [--full]`);
  process.exit(1);
}

await initItemSchema();   // person/connector_state 등 보조 스키마
await initOrgSchema();     // v6 미러/매핑은 v6 knowledge/project/source 에 적재(ingestItems→connector-mirror)

const failed = name === "clickup" ? await runClickupSync() : await runGenericSync(name);
process.exit(failed ? 1 : 0);

// ── generic 증분 — clickup 외 모든 커넥터(slack/discord/notion/…). 커넥터 SPI backfill({since}) 를 커서로 몰아 증분화. ──
//  instance='_' : 단일테넌트(조직당 1 게이트웨이·DB)라 system 단위 시간커서. (per-instance 분리는 멀티인스턴스 필요 시.)
//  커서 max_updated_iso = 이번 run 이 관측한 아이템 updated_at(없으면 occurred_at)의 최대. 성공 후에만 전진.
async function runGenericSync(system: string): Promise<boolean> {
  const conn = connectors[system];
  const instance = "_";
  const cursor = await getConnectorState(system, instance);
  const prevIso = (cursor as { max_updated_iso?: unknown } | null)?.max_updated_iso;
  const prevMs = typeof prevIso === "string" && prevIso ? Date.parse(prevIso) : 0;
  const incremental = !fullFlag && Number.isFinite(prevMs) && prevMs > 0;
  // since 는 epsilon 만큼 당겨 경계 아이템을 재수집(멱등 upsert 라 중복 무해, 유실만 방지).
  const sinceMs = incremental ? prevMs - CURSOR_EPSILON_MS : undefined;
  const sinceOpt = sinceMs !== undefined ? { since: new Date(sinceMs).toISOString() } : undefined;

  let maxMs = Number.isFinite(prevMs) ? prevMs : 0;
  let batch: RawItem[] = [];
  let ingested = 0;
  const flush = async () => { if (batch.length) { ingested += await ingestItems(batch); batch = []; } };
  const runStartIso = new Date().toISOString(); // #551 full 스윕 기준(이 시각 이전 last_synced_at = 이번 run 미관측)

  try {
    for await (const item of conn.backfill(sinceOpt)) {
      batch.push(item);
      const t = item.updated_at ?? item.occurred_at;
      const ms = t ? Date.parse(t) : NaN;
      if (Number.isFinite(ms) && ms > maxMs) maxMs = ms;
      if (batch.length >= 200) await flush();
    }
    await flush();
  } catch (err) {
    logger.error({ err: (err as Error)?.message ?? String(err), system }, "generic 싱크 실패 — 커서 동결(다음 run 재수집)");
    return true;
  }

  // ── #551 notion 후처리 — 링크 물질화(연결구조) + 자식 순서 수렴(페이지 트리) + full 스윕(삭제 전파). ──
  //  커넥터 내부 부분 실패(페이지/자산)는 예외로 안 오고 stats 로 온다 → 커서 동결로 다음 run 재수집(조용한 손실 금지).
  if (system === "notion") {
    const stats = getNotionRunStats();
    try {
      const links = await materializeNotionLinks(itemsPool);
      const reordered = await applyNotionChildrenOrder(itemsPool);
      let archived = 0;
      if (!incremental && stats && stats.failures === 0) {
        archived = await sweepNotionArchived(itemsPool, runStartIso); // full + 무실패에서만(오탐 아카이브 방지)
      }
      logger.info({ system, links, reordered, archived, stats }, "notion 후처리 완료(링크·순서·스윕)");
    } catch (err) {
      logger.error({ err: (err as Error)?.message ?? String(err) }, "notion 후처리 실패 — 커서 동결(다음 run 재수집)");
      return true;
    }
    if (stats && stats.failures > 0) {
      logger.error({ failures: stats.failures, failedIds: stats.failedIds.slice(0, 20) },
        "notion 부분 실패 — 커서 동결(방출분은 멱등 적재됨, 다음 run 이 실패분 재수집)");
      return true;
    }
  }

  // 커서 전진 — 성공 후 max 관측시각이 이전보다 클 때만(시계 추측 금지: 0건/무진전이면 유지).
  const advance = maxMs > prevMs;
  if (advance) await setConnectorState(system, instance, { max_updated_iso: new Date(maxMs).toISOString() });
  logger.info({
    system, mode: incremental ? "incremental" : "full",
    ingested, cursorIso: advance ? new Date(maxMs).toISOString() : (typeof prevIso === "string" ? prevIso : null),
    cursorAdvanced: advance,
  }, "generic 싱크 완료");
  return false;
}

// ── clickup 특수 싱크 (기존 phase B 로직 보존) — List 나열 + folderless/archived 패스 + team date_updated_gt. ──
async function runClickupSync(): Promise<boolean> {
  // 1) 컨테이너 나열 (태스크 작업 전에)
  const team = await getTeam();
  const teamId = team.id;
  const lists = await enumerateLists(teamId);
  logger.info({ teamId, lists: lists.map((l) => `${l.id}:${l.name}`) }, "clickup 리스트 나열");

  const failedListIds = new Set<string>();

  // 2) 태스크 수집 — full(per-list) | incremental(team date_updated_gt) + archived 패스
  const cursor = await getConnectorState("clickup", teamId);
  const prevMaxMs = Number((cursor as { tasks_max_updated_ms?: unknown } | null)?.tasks_max_updated_ms ?? 0) || 0;
  const incremental = !fullFlag && prevMaxMs > 0;
  const dateUpdatedGt = incremental ? prevMaxMs - CURSOR_EPSILON_MS : undefined;

  const allowedListIds = lists.map((l) => l.id);
  const tasks: ClickUpTask[] = [];
  if (incremental) {
    tasks.push(...await fetchTeamTasks(teamId, { dateUpdatedGt, listIds: allowedListIds }));
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

  // 3) 변환 + 적재 (배치 200, 멱등 upsert)
  const seen = new Set<string>();
  let maxSeenMs = 0;
  let batch: RawItem[] = [];
  let ingested = 0;
  const flush = async () => {
    if (!batch.length) return;
    ingested += await ingestItems(batch);
    batch = [];
  };

  for (const task of tasks) {
    if (seen.has(task.id)) continue;
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

  // 4) 커서 전진 — 전 단계 성공 후에만. max(이전, 이번 관측 최대).
  const failed = failedListIds.size > 0;
  const advanceCursor = !failed && (maxSeenMs > prevMaxMs || (!incremental && maxSeenMs > 0));
  if (advanceCursor) {
    await setConnectorState("clickup", teamId, { tasks_max_updated_ms: Math.max(prevMaxMs, maxSeenMs) });
  }

  logger.info({
    mode: incremental ? "incremental" : "full",
    lists: lists.length,
    tasks: seen.size, ingested,
    cursorMs: advanceCursor ? Math.max(prevMaxMs, maxSeenMs) : prevMaxMs,
    cursorAdvanced: advanceCursor,
  }, "clickup 싱크 완료");
  return failed;
}

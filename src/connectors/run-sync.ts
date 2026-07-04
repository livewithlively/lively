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
import { init as initDomainmapSchema } from "../domainmap/core/schema.js";
import { initV6Schema } from "../v6/schema.js";
import { healPmMirror, materializeNotionLinks, applyNotionChildrenOrder, sweepNotionArchived, loadNotionLedger } from "../v6/connector-mirror.js";
import { connectors } from "./index.js";
import { getTeam, losslessStream, getIncludedListIds } from "./clickup.js";
import { getNotionRunStats } from "./notion.js";
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
await initDomainmapSchema(); // activity 등 — initV6Schema 의 ALTER/FK 선행 의존(서버 부팅 직렬 체인과 동일 순서)
await initV6Schema();      // 미러 수용 테이블(project/knowledge/source + PM 계층 #541) — 단독 CLI(신규 DB)도 성립(멱등)

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
  let sinceOpt = sinceMs !== undefined ? { since: new Date(sinceMs).toISOString() } as { since: string; ledger?: unknown } : undefined;
  // #586 notion 델타 증분 — 미러 원장(last_edited·부모·제목)을 커넥터에 넘겨 '진짜 변경분'만 수집하게 한다.
  //  로드 실패는 비치명(원장 없이도 전체 트래버스로 안전 동작 — 손실 방향 아님).
  if (system === "notion" && sinceOpt) {
    try {
      const ledger = await loadNotionLedger(itemsPool);
      if (ledger.byId.size) sinceOpt = { ...sinceOpt, ledger };
      logger.info({ entries: ledger.byId.size, dataSources: ledger.dsToDb.size }, "notion 원장 로드(델타 증분 기준)");
    } catch (err) {
      logger.warn({ err: (err as Error)?.message ?? String(err) }, "notion 원장 로드 실패 — 전체 트래버스로 진행(안전 폴백)");
    }
  }

  let maxMs = Number.isFinite(prevMs) ? prevMs : 0;
  let batch: RawItem[] = [];
  let ingested = 0;
  let mirrorFailures = 0; // 항목 단위 미러 실패 — 커서 동결(clickup 경로와 동일 불변식 #541)
  const flush = async () => { if (batch.length) { ingested += await ingestItems(batch, { onError: () => { mirrorFailures++; } }); batch = []; } };
  // #551 full 스윕 기준(이 시각 이전 last_synced_at = 이번 run 미관측). last_synced_at 은 DB now() 로 찍히므로
  //  기준 시각도 DB 시계로(노드↔DB 시계 스큐로 인한 오탐 아카이브 방지).
  const runStartIso = String((await itemsPool.query(`SELECT now() AS t`)).rows[0]?.t?.toISOString?.() ?? new Date().toISOString());

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
  //  두 겹의 실패 감지(조용한 손실 금지):
  //   ① 커넥터 내부 부분 실패(페이지/자산) — 예외로 안 오고 stats 로 온다.
  //   ② 미러 부분 실패 — ingestItems 가 best-effort 로 삼키므로(store.ts), DB 실측으로 대사:
  //      이번 run 에 적재된 행 수(last_synced_at ≥ runStart) < 방출 수 면 미러가 일부 실패한 것.
  //  어느 쪽이든 커서 동결(다음 run 재수집) + full 스윕 생략(살아있는 페이지 오탐 아카이브 방지).
  if (system === "notion") {
    const stats = getNotionRunStats();
    let mirrorShortfall = 0;
    try {
      if (stats) {
        const m = await itemsPool.query(
          `SELECT count(*)::int AS n FROM knowledge WHERE external_system='notion' AND last_synced_at >= $1::timestamptz`,
          [runStartIso]);
        mirrorShortfall = Math.max(0, stats.emitted - Number((m.rows[0] as { n: number } | undefined)?.n ?? 0));
      }
      const links = await materializeNotionLinks(itemsPool);
      const reordered = await applyNotionChildrenOrder(itemsPool);
      let archived = 0;
      if (!incremental && stats && stats.failures === 0 && mirrorShortfall === 0) {
        archived = await sweepNotionArchived(itemsPool, runStartIso); // full + 완전 무실패에서만(오탐 아카이브 방지)
      }
      logger.info({ system, links, reordered, archived, mirrorShortfall, stats }, "notion 후처리 완료(링크·순서·스윕)");
    } catch (err) {
      logger.error({ err: (err as Error)?.message ?? String(err) }, "notion 후처리 실패 — 커서 동결(다음 run 재수집)");
      return true;
    }
    if ((stats && stats.failures > 0) || mirrorShortfall > 0) {
      logger.error({ failures: stats?.failures ?? -1, mirrorShortfall, failedIds: (stats?.failedIds ?? []).slice(0, 20) },
        "notion 부분 실패 — 커서 동결(적재분은 멱등 보존, 다음 run 이 실패분 재수집)");
      return true;
    }
  }

  // 커서 전진 — 성공 후 max 관측시각이 이전보다 클 때만(시계 추측 금지: 0건/무진전이면 유지).
  //  항목 단위 미러 실패도 동결(#541) — 실패 항목 시각을 지나 전진하면 재폴링 창 밖 유실.
  const advance = mirrorFailures === 0 && maxMs > prevMs;
  if (advance) await setConnectorState(system, instance, { max_updated_iso: new Date(maxMs).toISOString() });
  logger.info({
    system, mode: incremental ? "incremental" : "full",
    ingested, mirrorFailures, cursorIso: advance ? new Date(maxMs).toISOString() : (typeof prevIso === "string" ? prevIso : null),
    cursorAdvanced: advance,
  }, "generic 싱크 완료");
  return mirrorFailures > 0;
}

// ── clickup 특수 싱크(#541 무손실 재작성) — losslessStream 단일 경로: 계층(Space→Folder→List→View) →
//  태스크(hydration·부모우선·미지 서브태스크 수렴) → 댓글 → 타임엔트리. 커서 시맨틱은 기존 보존
//  (connector_state('clickup', teamId).tasks_max_updated_ms — 태스크 관측 최대 date_updated). 인제스트 후
//  healPmMirror 가 스트림 순서 밖(부모 미변경 증분 등) 미해소 parent_id/list_id 를 일괄 수렴한다.
async function runClickupSync(): Promise<boolean> {
  const team = await getTeam();
  const teamId = team.id;

  const cursor = await getConnectorState("clickup", teamId);
  const prevState = (cursor && typeof cursor === "object" ? cursor : {}) as Record<string, unknown>;
  const prevMaxMs = Number(prevState.tasks_max_updated_ms ?? 0) || 0;
  let incremental = !fullFlag && prevMaxMs > 0;

  // #541 최초 무손실 마이그레이션 자동화 — 구코드 시절 커서만 있고 미이관 행(raw 백스톱 없음)이 남아 있으면
  //  이번 run 을 full 로 1회 승격(스케줄러 증분은 옛 태스크를 재수화하지 않아 업그레이드가 영영 안 됨).
  //  lossless_full_done 플래그로 재승격 방지 — ClickUp 에서 삭제된 고아 행(영원히 raw NULL)이 매 run full 을 유발하지 않게.
  const losslessFullDone = prevState.lossless_full_done === true;
  {
    // 진단 상시 로그(#541) — 박스에서 "왜 full 승격이 (안) 됐나"를 로그만으로 판정 가능하게.
    const un = await itemsPool.query(
      `SELECT count(*)::int AS n FROM project WHERE external_system='clickup' AND raw IS NULL`);
    const unmigrated = Number((un.rows[0] as { n: number } | undefined)?.n ?? 0);
    logger.info({ incremental, losslessFullDone, unmigrated, prevMaxMs }, "clickup 싱크 시작(승격 판정)");
    // 승격 기준 = lossless_full_done 플래그(#541 어니스트 관찰 반영) — unmigrated(raw NULL)만 보면 "과거 full 이
    //  raw 는 채웠지만 실패(당시 403 집계)로 플래그를 못 박은" 박스가 영영 재승격되지 않아, 그 뒤 추가된
    //  컬럼 값·표면(project_member) 백필이 증분 창 밖에 갇힌다. 플래그가 없으면 full 1회 — 이번 run 이
    //  무결 완주하면 플래그가 박혀(아래) 1회로 끝난다(403 권한경계는 이제 실패 미집계라 완주 가능).
    if (incremental && !losslessFullDone) {
      incremental = false;
      logger.info({ unmigrated }, "lossless_full_done 미기록 — 이번 run 을 full 로 승격(최초/재개 무손실 마이그레이션)");
    }
  }
  const sinceMs = incremental ? prevMaxMs - CURSOR_EPSILON_MS : undefined;

  let maxSeenMs = 0;
  let counts: Record<string, number> = {};
  let batch: RawItem[] = [];
  let ingested = 0;
  let failed = false;
  let mirrorFailures = 0; // 항목 단위 미러 실패 — 커서 동결 근거(성공 후에만 전진 불변식의 항목 단위 강화 #541)
  const flush = async () => {
    if (!batch.length) return;
    ingested += await ingestItems(batch, { onError: () => { mirrorFailures++; } });
    batch = [];
  };

  const stats = { fetchFailures: 0 }; // 수집(fetch) 실패 — 커서 동결 근거(스트림이 부분 수집을 계속해도 성공 위장 금지)
  try {
    for await (const item of losslessStream({ sinceMs, stats })) {
      batch.push(item);
      counts[item.type] = (counts[item.type] ?? 0) + 1;
      if (item.type === "task") {
        const updMs = Date.parse(item.updated_at ?? "");
        if (Number.isFinite(updMs) && updMs > maxSeenMs) maxSeenMs = updMs;
      }
      if (batch.length >= 200) await flush();
    }
    await flush();
  } catch (err) {
    logger.error({ err: (err as Error)?.message ?? String(err) }, "clickup 싱크 실패 — 커서 동결(다음 run 재수집)");
    failed = true;
  }

  // 힐 패스 — 부모/리스트 좌표 백스톱(raw/fields) 기반 일괄 수렴(멱등).
  if (!failed) {
    const client = await itemsPool.connect();
    try {
      const included = await getIncludedListIds();
      const healed = await healPmMirror(client, "clickup", { pruneEmptyContainers: !!included });
      if (healed.parents || healed.lists || healed.statusKeys || healed.prunedContainers) logger.info(healed, "clickup 미러 힐(부모/리스트/상태키/빈컨테이너 수렴)");
    } catch (err) {
      logger.warn({ err: (err as Error)?.message ?? String(err) }, "clickup 미러 힐 실패(무시 — 다음 run 재시도)");
    } finally {
      client.release();
    }
  }

  // 커서 전진 — 전 단계 성공 후에만: ①스트림 예외 ②수집(fetch) 실패(stats — 팀폴/리스트/hydration/댓글/계층)
  //  ③항목 단위 미러 실패, 셋 다 0 일 때만. 실패 시각을 지나 전진하면 그 윈도가 재폴링 창 밖으로 빠져
  //  '다음 싱크 수렴' 불변식이 성립하지 않는다(구 failedListIds 동결의 일반화).
  const cleanRun = !failed && stats.fetchFailures === 0 && mirrorFailures === 0;
  const advanceCursor = cleanRun && (maxSeenMs > prevMaxMs || (!incremental && maxSeenMs > 0));
  if (advanceCursor || (cleanRun && !incremental && !losslessFullDone)) {
    // 기존 상태 보존 병합 — full 무결 완주 시 lossless_full_done 마킹(자동 승격 1회성 보장).
    await setConnectorState("clickup", teamId, {
      ...prevState,
      tasks_max_updated_ms: Math.max(prevMaxMs, maxSeenMs),
      ...(cleanRun && !incremental ? { lossless_full_done: true } : {}),
    });
  }

  logger.info({
    mode: incremental ? "incremental" : "full",
    counts, ingested, fetchFailures: stats.fetchFailures, mirrorFailures,
    cursorMs: advanceCursor ? Math.max(prevMaxMs, maxSeenMs) : prevMaxMs,
    cursorAdvanced: advanceCursor,
  }, "clickup 싱크 완료");
  return failed || stats.fetchFailures > 0 || mirrorFailures > 0;
}

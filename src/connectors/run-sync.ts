// 커넥터 증분 싱크 — 모든 커넥터(커서 기반). 스케줄러 action='connector_sync' 가 서브프로세스로 호출.
//  사용: node --env-file-if-exists=.env dist/connectors/run-sync.js <system> [--full]
//    <system> = clickup | slack | discord | notion | …(레지스트리). --full = 커서 무시 전체 재수집(부트스트랩).
//  필요 env: ITEMS_DATABASE_URL (+커넥터 토큰 — 관리탭 org_connector 또는 .env, connectors/config.ts 해소).
//
//  이 파일은 **오케스트레이터**다 — 커넥터가 뭔지 모른다(#1313 R44). 커넥터별 특례(원장 로드·링크 물질화·
//  아카이브 스윕 등)는 전부 SPI 라이프사이클 훅(types.ts: prepareSync/runStats/postSync)으로 소유 모듈에 있다.
//  새 커넥터 추가 = 모듈 1개 + connectors/index.ts 등록. 여기 손댈 일 없음.
//
//  두 경로:
//   · clickup — 특수(List 나열 + folderless/archived 패스 + team date_updated_gt). instance=teamId 단위 커서.
//   · 그 외   — generic 증분: connector_state(system,'_') 커서 → backfill({since}) → max 관측시각으로 커서 전진.
//
//  멱등: 아이템은 (system,instance,external_id) upsert — 두 번 돌려도 중복 없음(라우팅에 따라 project/knowledge/source).
//  커서는 **모든 단계 성공 후에만** 전진 — 중도 실패 run 은 같은 윈도를 다음 run 이 재폴링한다(유실 없음 불변식, CTO wiki-sync 동일).
//   그 판정은 sync-cursor.planCursorWrite(순수·단위테스트) 한 곳에 있고, 커넥터는 postSync 반환값으로만 개입한다.
import {
  ingestItems,
  getConnectorState, setConnectorState,
  type RawItem,
} from "../items/store.js";
import { itemsPool } from "../db/client.js";
import { flushProjectEmbeds } from "../v6/connector-mirror.js"; // #624 미러 프로젝트 재임베딩(배치 후 flush)
import { initAllSchemas } from "../boot/schemas.js";
import { connectors } from "./index.js";
import { runClickupSync } from "./clickup/sync.js";
import { CURSOR_EPSILON_MS, planCursorWrite } from "./sync-cursor.js";
import { logger } from "../log.js";

const name = process.argv[2];
const fullFlag = process.argv.includes("--full");

if (!name || (name !== "clickup" && !connectors[name])) {
  const known = ["clickup", ...Object.keys(connectors).filter((k) => k !== "clickup")];
  logger.error(`사용: run-sync <${known.join("|")}> [--full]`);
  process.exit(1);
}

// 스키마 직렬 체인(item→org→domainmap→v6) — 서버 부팅과 단일 규약(boot/schemas.ts). 단독 CLI(신규 DB)도 성립(멱등).
//  (item: person/connector_state 등 보조 스키마 · org: v6 미러/매핑 적재 전제 · domainmap: activity 등 initV6Schema 의
//   ALTER/FK 선행 의존 · v6: 미러 수용 테이블 project/knowledge/source + PM 계층 #541). quiet — CLI 는 종전대로 무로그.
await initAllSchemas({ quiet: true });

// ⚠ 남은 커넥터 이름 분기 1건(#1313 R44 1단계 잔류) — clickup 만 커서 shape(instance=teamId·tasks_max_updated_ms·
//  lossless_full_done)과 전진 조건(fetch 실패 집계·full 승격)이 generic 시간커서와 달라 훅으로 흡수하지 않았다.
//  구현은 커넥터 모듈(clickup/sync.ts)에 있으므로 '커넥터 추가=모듈 1개'는 성립 — 여기 남은 건 이 진입 한 줄뿐이다.
const failed = name === "clickup" ? await runClickupSync({ fullFlag }) : await runGenericSync(name);
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
  let sinceOpt: { since?: string; ledger?: unknown; retryIds?: string[] } | undefined
    = sinceMs !== undefined ? { since: new Date(sinceMs).toISOString() } : undefined;
  // 커서에 남은 재시도 목록 — 훅 반환값과 대사해 '변경됐을 때만' 다시 기록한다(파싱은 소유 커넥터도 각자:
  //  SPI 는 커서 원문을 통째로 넘기고, 그걸 어떤 backfill 옵션으로 만들지는 커넥터가 정한다).
  const prevRetry: string[] = Array.isArray((cursor as Record<string, unknown> | null)?.retry_ids)
    ? ((cursor as Record<string, unknown>).retry_ids as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  // 사전 준비 훅 — 커넥터가 커서를 보고 backfill 옵션을 보탠다(notion: 미러 원장·재시도 시드). 훅 없으면 무변.
  const prepared = conn.prepareSync ? await conn.prepareSync(cursor) : undefined;
  if (prepared) sinceOpt = { ...(sinceOpt ?? {}), ...prepared };

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
    await flushProjectEmbeds(itemsPool).catch(() => {}); // #624 이름/설명 바뀐 미러 프로젝트만 재임베딩(배치 후·best-effort)
  } catch (err) {
    logger.error({ err: (err as Error)?.message ?? String(err), system }, "generic 싱크 실패 — 커서 동결(다음 run 재수집)");
    return true;
  }

  // 후처리 훅 — 커넥터 고유 마무리(notion 링크 물질화·스윕, domain-wiki 삭제 전파). 반환값이 커서 전진을 지배한다.
  const post = conn.postSync
    ? await conn.postSync({ pool: itemsPool, runStartIso, incremental, ingested, mirrorFailures })
    : null;

  // 커서 전진 판정(sync-cursor.ts) — 훅 동결 · 미러 실패 · 무진전 · 재시도 목록 변경을 한 곳에서 해소.
  const plan = planCursorWrite({ prevIso, prevMs, maxMs, mirrorFailures, prevRetry, post });
  if (plan.freeze) return true; // 훅이 요구한 동결 — 커서 미기록 + run 실패(적재분은 멱등 보존)
  if (plan.write) await setConnectorState(system, instance, plan.write);
  logger.info({
    system, mode: incremental ? "incremental" : "full",
    ingested, mirrorFailures, cursorIso: plan.advance ? new Date(maxMs).toISOString() : (typeof prevIso === "string" ? prevIso : null),
    cursorAdvanced: plan.advance, retryPending: post?.retryIds?.length ?? 0,
  }, "generic 싱크 완료");
  return mirrorFailures > 0;
}

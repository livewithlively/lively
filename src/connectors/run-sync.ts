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
import { loadEnterprise } from "../enterprise/load.js";
import { connectors } from "./index.js";
import { runClickupSync } from "./clickup/sync.js";
import { CURSOR_EPSILON_MS, planCursorWrite } from "./sync-cursor.js";
import { bindCollector, collectorInstanceKey } from "./config.js";
import { logger } from "../log.js";

const name = process.argv[2];
const fullFlag = process.argv.includes("--full");
// --collector <id> (#1419 T1) — 이 실행이 대리하는 수집기 인스턴스. 없으면 레거시 단일 인스턴스 모드.
const collectorArgIdx = process.argv.indexOf("--collector");
const collectorId = collectorArgIdx >= 0 ? Number(process.argv[collectorArgIdx + 1]) : 0;

// 이름 검증은 **수집기 바인딩 뒤로** 미룬다(#1419 T2) — 커스텀 프리셋(http/rss/webhook)은 코드 레지스트리에
//  없는 이름이라 여기서 거르면 범용 수집기가 영영 못 뜬다. 프리셋 카탈로그를 봐야 판정할 수 있고,
//  그 카탈로그는 DB 라 스키마 체인 이후에나 읽힌다. 인자 자체가 비었을 때만 즉시 거른다.
if (!name) {
  const known = ["clickup", ...Object.keys(connectors).filter((k) => k !== "clickup")];
  logger.error(`사용: run-sync <${known.join("|")}|커스텀프리셋> [--collector <id>] [--full]`);
  process.exit(1);
}

// 스키마 직렬 체인(item→org→domainmap→v6) — 서버 부팅과 단일 규약(boot/schemas.ts). 단독 CLI(신규 DB)도 성립(멱등).
//  (item: person/connector_state 등 보조 스키마 · org: v6 미러/매핑 적재 전제 · domainmap: activity 등 initV6Schema 의
//   ALTER/FK 선행 의존 · v6: 미러 수용 테이블 project/knowledge/source + PM 계층 #541). quiet — CLI 는 종전대로 무로그.
// Enterprise(src/ee) 적재 — **게이트웨이와 같은 규약**(index.ts 가 부팅에서 하는 일). 없으면 조용히 코어로 진행.
//
//  ⚠ 이게 빠져 있었다(2026-08-25 실측). 그 결과 이 CLI 는 조직이 설정한 **인입 허용선 정책을 통째로
//   무시**했다 — EE 훅이 없으니 규칙이 빈 배열(= 디폴트 auto)로 읽혀, 관리자가 "이건 받지 마라"고 켜 둔
//   게이트가 커넥터 인입에만 적용되지 않았다. #783 의 고아 가드가 그 조용한 우회를 시끄러운 실패로
//   바꿔 놓아 드러났다(수집이 페이지를 다 받고 미러 적재에서 거부). 가드를 끄는 게 아니라 **적재를
//   맞추는 것**이 답이다 — 부모가 집행하는 정책을 자식도 똑같이 집행해야 한다.
await loadEnterprise();

await initAllSchemas({ quiet: true });

// ── 수집기 바인딩(#1419 T1) — **첫 설정 해소보다 먼저.** 이 뒤로 모든 resolveConnectorConfig 는 이 인스턴스의
//  config/secrets 를 본다(커넥터 모듈은 그 사실을 모른 채 종전 코드 그대로 돈다). 바인딩 실패는 치명이다 —
//  엉뚱한(레거시) 설정으로 남의 워크스페이스를 긁어 커서를 오염시키느니 실행을 접는 편이 안전하다.
if (collectorId) {
  const cr = await itemsPool.query<{
    preset_key: string; instance_key: string; enabled: boolean;
    output_mode: string; output_config: Record<string, unknown> | null;
  }>(`SELECT preset_key, instance_key, enabled, output_mode, output_config FROM org_collector WHERE id=$1`, [collectorId]);
  const row = cr.rows[0];
  if (!row) { logger.error({ collectorId }, "수집기를 찾을 수 없습니다 — 삭제됐거나 잘못된 id"); process.exit(1); }
  if (row.preset_key !== name) {
    logger.error({ collectorId, expected: row.preset_key, got: name }, "수집기 프리셋과 실행 대상이 다릅니다");
    process.exit(1);
  }
  bindCollector({
    id: collectorId, presetKey: row.preset_key, instanceKey: row.instance_key,
    outputMode: (row.output_mode ?? "preset") as never,
    outputConfig: row.output_config ?? {},
  });
  logger.info({ collectorId, preset: row.preset_key, instance: row.instance_key, output: row.output_mode },
    "수집기 인스턴스 바인딩");
}

// ── 이 실행이 쓸 커넥터 해소(#1419 T2) ──
//  내장·복제 프리셋이면 기존 커넥터 모듈, http/rss/webhook 프리셋이면 설정으로 조립한 커넥터가 나온다.
//  둘 다 같은 SPI 라 아래 오케스트레이션(커서·배치·후처리)은 어느 쪽인지 모른다.
//  수집기 없이(레거시 경로) 부른 경우엔 종전대로 코드 레지스트리만 본다.
let activeConnector = connectors[name];
if (collectorId) {
  const { connectorForPresetKey } = await import("./generic/index.js");
  const { resolveConnectorConfig } = await import("./config.js");
  try {
    // 범용 드라이버는 URL·토큰 등 **수집기 설정**을 알아야 조립된다 — 바인딩이 이미 걸려 있어 이 해소가
    //  그 인스턴스의 값을 준다. 내장 프리셋 경로에선 이 값이 쓰이지 않는다(커넥터가 스스로 해소).
    const settings = await resolveConnectorConfig(name);
    const r = await connectorForPresetKey(name, settings, collectorId);
    activeConnector = r.connector;
  } catch (e) {
    logger.error({ err: (e as Error)?.message, preset: name, collectorId }, "수집기 커넥터 해소 실패");
    process.exit(1);
  }
}
if (name !== "clickup" && !activeConnector) {
  logger.error({ name }, "알 수 없는 커넥터·프리셋 — 등록된 프리셋인지 확인하세요");
  process.exit(1);
}

// ⚠ 남은 커넥터 이름 분기 1건(#1313 R44 1단계 잔류) — clickup 만 커서 shape(instance=teamId·tasks_max_updated_ms·
//  lossless_full_done)과 전진 조건(fetch 실패 집계·full 승격)이 generic 시간커서와 달라 훅으로 흡수하지 않았다.
//  구현은 커넥터 모듈(clickup/sync.ts)에 있으므로 '커넥터 추가=모듈 1개'는 성립 — 여기 남은 건 이 진입 한 줄뿐이다.
const failed = name === "clickup" ? await runClickupSync({ fullFlag }) : await runGenericSync(name, activeConnector);
process.exit(failed ? 1 : 0);

// ── generic 증분 — clickup 외 모든 커넥터(slack/discord/notion/…). 커넥터 SPI backfill({since}) 를 커서로 몰아 증분화. ──
//  instance = 수집기 인스턴스의 커서 네임스페이스(#1419 T1). 바인딩이 없으면 종전 그대로 '_'(레거시 단일).
//   수집기가 여럿이면 여기서 갈린다 — 같은 슬랙이라도 인스턴스마다 자기 커서를 갖는다. 갈라 두지 않으면
//   워크스페이스 A 의 진행이 B 의 커서를 앞당겨 **B 가 그 구간을 영영 안 읽는다**(조용한 유실).
//   마이그레이션된 기본 수집기는 instance_key='_' 를 물려받아 종전 커서를 그대로 이어 쓴다(재수집 없음).
//  커서 max_updated_iso = 이번 run 이 관측한 아이템 updated_at(없으면 occurred_at)의 최대. 성공 후에만 전진.
async function runGenericSync(system: string, conn: import("./types.js").Connector): Promise<boolean> {
  const instance = collectorInstanceKey();
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

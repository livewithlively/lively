// ClickUp 전용 싱크 경로 — #1313 R44 로 run-sync.ts 에서 verbatim 이관(로직·SQL·로그 문구 무변).
//  ⚠ **1단계 잔류**: 이 커넥터만 커서 shape(instance=teamId · tasks_max_updated_ms · lossless_full_done)과
//   전진 조건(fetch 실패 집계 · full 승격 1회성)이 generic 시간커서(max_updated_iso)와 달라, SPI 훅
//   (prepareSync/postSync)으로는 아직 흡수하지 않았다. 대신 구현을 커넥터 모듈로 내려 '커넥터 추가 = 모듈 1개'는
//   성립시켰다 — run-sync 에 남은 clickup 흔적은 **진입 분기 1건**뿐이다(그 사유는 run-sync 주석 참조).
//
//  #541 무손실 재작성 — losslessStream 단일 경로: 계층(Space→Folder→List→View) → 태스크(hydration·부모우선·
//  미지 서브태스크 수렴) → 댓글 → 타임엔트리. 커서 시맨틱은 기존 보존(connector_state('clickup', teamId).
//  tasks_max_updated_ms — 태스크 관측 최대 date_updated). 인제스트 후 healPmMirror 가 스트림 순서 밖(부모 미변경
//  증분 등) 미해소 parent_id/list_id 를 일괄 수렴한다.
import { ingestItems, getConnectorState, setConnectorState, type RawItem } from "../../items/store.js";
import { itemsPool } from "../../db/client.js";
import { flushProjectEmbeds, healPmMirror } from "../../v6/connector-mirror.js";
import { logger } from "../../log.js";
import { CURSOR_EPSILON_MS } from "../sync-cursor.js";
import { boundCollector } from "../config.js";
import { getTeam, getIncludedListIds, clickupReqCount } from "./api.js";
import { losslessStream } from "./stream.js";

export async function runClickupSync(opts: { fullFlag: boolean }): Promise<boolean> {
  const fullFlag = opts.fullFlag;
  const team = await getTeam();
  const teamId = team.id;

  // 커서 네임스페이스(#1419 T1) — 종전은 teamId 단독이었다. 토큰이 다르면 팀도 달라 대개 자연히 갈리지만,
  //  **같은 팀을 리스트 필터만 달리해 두 수집기로 긁는** 구성에선 둘이 한 커서를 밟는다. 그래서 수집기가
  //  바인딩돼 있으면 그 인스턴스 키를 붙여 갈라 둔다. 바인딩이 없으면 종전 키 그대로(레거시 커서 승계).
  //  ⚠ 기본 수집기는 instance_key='_' 라 여기서도 종전과 같은 `teamId` 로 떨어진다(마이그레이션 후 재수집 없음).
  const inst = boundCollector()?.instanceKey ?? "_";
  const cursorKey = inst === "_" ? teamId : `${teamId}:${inst}`;

  const cursor = await getConnectorState("clickup", cursorKey);
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
    // 승격 기준 = lossless_full_done 플래그(#541 고객사 A 관찰 반영) — unmigrated(raw NULL)만 보면 "과거 full 이
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

  // 생존 티커(notion/index.ts 패턴) — 120초마다, 요청 카운터가 실제 늘었을 때만 로그. full 전건 hydration 이
  //  rate limit sleep 으로 느려도 진행 신호를 남겨 run-tracker(15분 무출력=킬)의 오살을 막는다. 무진전(진짜
  //  행)이면 침묵을 유지해 tracker 가 잡게 한다.
  let lastTickReq = -1;
  const ticker = setInterval(() => {
    const rc = clickupReqCount();
    if (rc === lastTickReq) return;
    lastTickReq = rc;
    logger.info({ requests: rc, ingested, counts }, "clickup 싱크 진행중");
  }, 120_000);

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
    await flushProjectEmbeds(itemsPool).catch(() => {}); // #624 이름/설명 바뀐 미러 프로젝트만 재임베딩(배치 후·best-effort)
  } catch (err) {
    logger.error({ err: (err as Error)?.message ?? String(err) }, "clickup 싱크 실패 — 커서 동결(다음 run 재수집)");
    failed = true;
  } finally {
    clearInterval(ticker);
  }

  // 힐 패스 — 부모/리스트 좌표 백스톱(raw/fields) 기반 일괄 수렴(멱등).
  if (!failed) {
    const client = await itemsPool.connect();
    try {
      const included = await getIncludedListIds();
      const healed = await healPmMirror(client, "clickup", { pruneEmptyContainers: !!included });
      if (healed.parents || healed.lists || healed.statusKeys || healed.prunedContainers || healed.reresolvedAssignee || healed.reresolvedSurfaces) logger.info(healed, "clickup 미러 힐(부모/리스트/상태키/빈컨테이너/멤버재해소 수렴)");
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
    await setConnectorState("clickup", cursorKey, {
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

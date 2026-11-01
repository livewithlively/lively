// 임베딩 백필(벡터검색 #172) CLI — active 지식 중 임베딩이 비었거나(또는 모델이 바뀐) 행을 배치로 임베딩해 채운다.
//   로직은 공유 코어(dist/v6/embedding-backfill.js)에 있다 — CLI·REST(웹UI)·설치가 같은 코어를 쓴다(중복 금지).
//   재진입 안전: 기본은 embedding_vector IS NULL 잔여만 → 중단/재실행해도 채운 행은 다시 안 건드린다.
//
//   실행: npm run build && node --env-file-if-exists=.env scripts/backfill-embeddings.mjs [--all] [--model-changed] [--max-seconds=N]
//     · (기본)         embedding_vector IS NULL 인 active 지식만 — 신규/미임베딩 보강(처음 켤 때)
//     · --model-changed  embedding_model 이 현재 설정 모델과 다른 행도 재임베딩(모델 스왑 후)
//     · --all          active 지식 전부 재임베딩(차원/모델 전면 교체 후)
//     · --max-seconds=N  N초가 지나면 지금 배치까지 끝내고 멈춘다(exit 0) — 기본 모드에서만. 남은 것은 게이트웨이의 자동 백필이 이어받는다.
//
//   ⚠ 라이브 DB 쓰기 — 검증 게이트에서 자동 실행하지 않는다. 임베딩 off(provider 미설정)면 사유 출력 후 무변경 종료(exit 2).
//   ⚠ 일시중지(#1060): 관리탭 '자동 백필 일시중지'(embedding_backfill_paused)는 게이트웨이의 자동 스윕·수동 백필 버튼을
//     막지만, 이 CLI 는 게이트웨이 밖 '의도적 오버라이드'(설치·enable 시 초기 백필용)라 그 플래그를 강제하지 않는다.
//     대신 일시중지 상태면 경고만 출력하고 진행한다 — 성능 부하를 모르고 재유발하지 않도록(멈추려면 Ctrl-C, 관리탭에서 관리).
import { itemsPool } from "../dist/items/store.js";
import { runEmbeddingBackfill, countEmbeddingBacklog } from "../dist/v6/embedding-backfill.js";

//  모르는 옵션은 멈춘다 — `--max-seconds 300` 이나 오타를 조용히 넘기면 상한 없이 하루를 돈다.
const unknownArgs = process.argv.slice(2).filter((a) => a !== "--all" && a !== "--model-changed" && !a.startsWith("--max-seconds="));
if (unknownArgs.length) {
  console.error(`모르는 옵션입니다: ${unknownArgs.join(" ")} (사용법: [--all] [--model-changed] [--max-seconds=N])`);
  process.exit(2);
}

const mode = process.argv.includes("--all")
  ? "all"
  : process.argv.includes("--model-changed")
    ? "model-changed"
    : "pending";

// 시간 상한 — 잘못 준 값을 «상한 없음» 으로 읽지 않는다(몇 분 뒤 끝나리라 믿은 명령이 하루를 돈다).
//  자동 스윕이 이어받는 것은 pending 뿐이라 다른 모드에는 주지 않는다(거기서 멈추면 남은 것을 아무도 안 채운다).
const maxSecondsArg = process.argv.find((a) => a.startsWith("--max-seconds="));
const maxSeconds = maxSecondsArg === undefined ? null : Number(maxSecondsArg.slice("--max-seconds=".length).trim() || NaN);
if (maxSeconds !== null && !(maxSeconds >= 1)) {
  console.error(`--max-seconds 는 1 이상의 초여야 합니다: ${maxSecondsArg}`);
  process.exit(2);
}
if (maxSeconds !== null && mode !== "pending") {
  console.error(`--max-seconds 는 기본 모드에서만 씁니다(자동 백필이 이어받는 것은 기본 모드뿐입니다): mode=${mode}`);
  process.exit(2);
}

async function main() {
  console.log(`백필 시작: mode=${mode}`);
  const deadline = maxSeconds === null ? null : Date.now() + maxSeconds * 1000;
  // #1060 — 관리탭에서 자동 백필을 일시중지해 둔 상태면 경고(이 CLI 는 의도적 오버라이드라 그대로 진행한다).
  let autoPaused = false;
  try {
    const r = await itemsPool.query(`SELECT embedding_backfill_paused FROM org_runtime_config WHERE id=1`);
    autoPaused = r.rows[0]?.embedding_backfill_paused === true;
    if (autoPaused) {
      console.warn("⚠ 관리탭에서 자동 임베딩 백필이 '일시중지'된 상태입니다 — 이 CLI 는 그 설정과 무관하게 백필을 실행합니다(의도적 오버라이드). 성능 부하를 원치 않으면 지금 Ctrl-C 하세요(관리탭에서 재개/유지 관리).");
    }
  } catch { /* 컬럼/테이블 부재(구 DB) 등 — 무시하고 진행 */ }
  const res = await runEmbeddingBackfill({
    mode,
    onProgress: (p) => { process.stdout.write(`\r진행 ${p.done}/${p.total}    `); },
    shouldStop: () => deadline !== null && Date.now() >= deadline,
  });
  process.stdout.write("\n");

  if (!res.ok) {
    const msg = {
      off: "임베딩 OFF(provider 미설정) — 백필 미실행. org_runtime_config.embedding_config 또는 EMBEDDINGS_* 설정 후 재실행.",
      schema: "pgvector 스키마 준비 실패(확장 부재 등) — 백필 미실행. 게이트웨이 로그의 [embeddings] 경고 참고.",
      unavailable: `임베딩 엔드포인트 불가용(model=${res.model}, dim=${res.dimensions}) — base_url/model/auth_env 확인.`,
    }[res.reason] ?? `백필 중단(${res.embedded}건까지 반영, 재실행 안전): ${res.reason}`;
    console.error(msg);
    await itemsPool.end();
    // 시작조차 못 함(off/schema/unavailable) = exit 2, 배치 중 실패 = exit 1(재실행 안전).
    process.exit(String(res.reason).startsWith("error") ? 1 : 2);
  }

  //  시간 상한으로 멈췄어도 실패가 아니다. 다만 끝났다고 말하지 않는다 — 남은 건수는 게이트웨이도 함께 채우는 값이라 DB 에서 다시 센다.
  const left = deadline === null ? 0 : (await countEmbeddingBacklog()).pending;
  if (left > 0) {
    console.log(`백필 시간 상한 도달: ${res.embedded}건 임베딩 · ${left}건 남음.`);
    console.log(autoPaused
      ? "자동 백필이 일시중지 상태라 남은 것은 채워지지 않습니다 — 관리탭에서 재개하세요."
      : "남은 것은 게이트웨이의 자동 백필이 이어서 채웁니다(10분 주기, 진행은 관리탭 '임베딩(벡터검색)').");
  } else {
    console.log(`백필 완료: ${res.embedded}건 임베딩.`);
  }
  await itemsPool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(`백필 오류: ${err?.message ?? err}`);
  try { await itemsPool.end(); } catch { /* ignore */ }
  process.exit(1);
});

// 임베딩 백필(벡터검색 #172) CLI — active 지식 중 임베딩이 비었거나(또는 모델이 바뀐) 행을 배치로 임베딩해 채운다.
//   로직은 공유 코어(dist/v6/embedding-backfill.js)에 있다 — CLI·REST(웹UI)·설치가 같은 코어를 쓴다(중복 금지).
//   재진입 안전: 기본은 embedding_vector IS NULL 잔여만 → 중단/재실행해도 채운 행은 다시 안 건드린다.
//
//   실행: npm run build && node --env-file-if-exists=.env scripts/backfill-embeddings.mjs [--all] [--model-changed]
//     · (기본)         embedding_vector IS NULL 인 active 지식만 — 신규/미임베딩 보강(처음 켤 때)
//     · --model-changed  embedding_model 이 현재 설정 모델과 다른 행도 재임베딩(모델 스왑 후)
//     · --all          active 지식 전부 재임베딩(차원/모델 전면 교체 후)
//
//   ⚠ 라이브 DB 쓰기 — 검증 게이트에서 자동 실행하지 않는다. 임베딩 off(provider 미설정)면 사유 출력 후 무변경 종료(exit 2).
import { itemsPool } from "../dist/items/store.js";
import { runEmbeddingBackfill } from "../dist/v6/embedding-backfill.js";

const mode = process.argv.includes("--all")
  ? "all"
  : process.argv.includes("--model-changed")
    ? "model-changed"
    : "pending";

async function main() {
  console.log(`백필 시작: mode=${mode}`);
  const res = await runEmbeddingBackfill({
    mode,
    onProgress: (p) => { process.stdout.write(`\r진행 ${p.done}/${p.total}    `); },
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

  console.log(`백필 완료: ${res.embedded}건 임베딩.`);
  await itemsPool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(`백필 오류: ${err?.message ?? err}`);
  try { await itemsPool.end(); } catch { /* ignore */ }
  process.exit(1);
});

// 임베딩 백필(스켈레톤·계약) — 기존 active 지식단위 중 embedding 이 아직 없는 행을 배치로 임베딩해 채운다.
//   재진입 안전: WHERE embedding IS NULL AND lifecycle='active' 만 골라 갱신하므로, 중단/재실행해도 이미 채운
//   행은 다시 안 건드린다. 신규 dep 0(dist import + node 내장만). 실행: EMBEDDINGS_ENABLED=1 +
//   EMBEDDINGS_PROVIDER_URL/EMBEDDINGS_DIM 설정 후 `node --env-file-if-exists=.env scripts/backfill-embeddings.mjs`.
//
//   ⚠️ 스켈레톤 — 라이브 DB 에 쓰기를 수행하므로 검증 게이트에서 실행하지 않는다. pgvector 가용 + provider 준비
//   된 환경에서만 의도적으로 돌린다(부재 시 initEmbeddings 가 graceful 폴백 → embeddingsUsable()=false 라
//   여기서 사유 출력 후 무변경 종료).
import { itemsPool } from "../dist/items/store.js";
import {
  embeddingsEnabled,
  embeddingsUsable,
  getProvider,
  initEmbeddings,
  toVectorLiteral,
} from "../dist/embeddings/index.js";

const BATCH = 64;

async function main() {
  if (!embeddingsEnabled()) {
    console.error("EMBEDDINGS_ENABLED!=1 — 임베딩 OFF. 백필 미실행.");
    process.exit(2);
  }
  // 컬럼/확장 보장(graceful — pgvector 부재면 columnReady=false 로 남음).
  await initEmbeddings();
  if (!embeddingsUsable()) {
    console.error("임베딩 비활성(pgvector 부재 또는 provider 미설정) — 백필 미실행.");
    process.exit(2);
  }
  const provider = getProvider();

  let total = 0;
  // 재진입 안전 루프 — 매 배치는 IS NULL 잔여만 집는다. 한 배치 처리 후 그 행들은 NOT NULL 이 되어 다음 배치에서 빠진다.
  for (;;) {
    const { rows } = await itemsPool.query(
      `SELECT name, body_md FROM knowledge_unit
         WHERE embedding IS NULL AND lifecycle='active'
         ORDER BY updated_at DESC NULLS LAST
         LIMIT ${BATCH}`,
    );
    if (rows.length === 0) break;

    const texts = rows.map((r) => String(r.body_md ?? ""));
    let vecs;
    try {
      vecs = await provider.embed(texts);
    } catch (err) {
      console.error(`배치 임베딩 실패(중단, 재실행 안전): ${err?.message ?? err}`);
      process.exit(1);
    }

    for (let i = 0; i < rows.length; i++) {
      const vec = vecs[i];
      if (!vec) continue;
      await itemsPool.query(
        `UPDATE knowledge_unit SET embedding=$2::vector WHERE name=$1`,
        [rows[i].name, toVectorLiteral(vec)],
      );
      total++;
    }
    console.log(`배치 완료: +${rows.length} (누적 ${total})`);
  }

  console.log(`백필 완료: ${total}건 임베딩.`);
  await itemsPool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(`백필 오류: ${err?.message ?? err}`);
  process.exit(1);
});

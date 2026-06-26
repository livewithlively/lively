// 임베딩 백필(벡터검색 #172) — active 지식 중 임베딩이 비었거나(또는 모델이 바뀐) 행을 배치로 임베딩해 채운다.
//   재진입 안전: 기본은 embedding_vector IS NULL 잔여만 집어 갱신 → 중단/재실행해도 채운 행은 다시 안 건드린다.
//   신규 dep 0(dist import + node 내장만). config(org_runtime_config.embedding_config ∪ env EMBEDDINGS_*)가 provider 결정.
//
//   실행: npm run build && node --env-file-if-exists=.env scripts/backfill-embeddings.mjs [--all] [--model-changed]
//     · (기본)        embedding_vector IS NULL 인 active 지식만 — 신규/미임베딩 보강
//     · --model-changed  embedding_model 이 현재 설정 모델과 다른 행도 재임베딩(모델 스왑 후)
//     · --all         active 지식 전부 재임베딩(차원/모델 전면 교체 후)
//
//   ⚠ 라이브 DB 쓰기 — 검증 게이트에서 자동 실행하지 않는다. 임베딩 off(provider 미설정)면 사유 출력 후 무변경 종료(exit 2).
import { itemsPool } from "../dist/items/store.js";
import {
  resolveEmbeddingConfig,
  resolveEmbeddingProvider,
  ensureEmbeddingSchema,
  embeddingInputText,
  toVectorLiteral,
} from "../dist/v6/embedding-provider.js";

const BATCH = 32;
const ALL = process.argv.includes("--all");
const MODEL_CHANGED = process.argv.includes("--model-changed");

async function main() {
  // config 해소 — DB(org_runtime_config.embedding_config) 우선, 비면 env(EMBEDDINGS_*) 시드.
  let dbRaw = null;
  try {
    const r = await itemsPool.query(`SELECT embedding_config FROM org_runtime_config WHERE id=1`);
    dbRaw = r.rows[0]?.embedding_config ?? null;
  } catch { /* 테이블 없으면 env 만으로 */ }
  const cfg = resolveEmbeddingConfig(dbRaw);
  const provider = resolveEmbeddingProvider(cfg);
  if (!provider) {
    console.error("임베딩 OFF(provider 미설정) — 백필 미실행. org_runtime_config.embedding_config 또는 EMBEDDINGS_* 설정 후 재실행.");
    process.exit(2);
  }

  // 스키마 보장(pgvector 확장 + 컬럼/인덱스). 부재면 graceful false → 사유 출력 후 종료.
  const ok = await ensureEmbeddingSchema(itemsPool, cfg.dimensions);
  if (!ok) {
    console.error("pgvector 스키마 준비 실패(확장 부재 등) — 백필 미실행. 위 경고 참고.");
    process.exit(2);
  }

  // provider 헬스 — 엔드포인트 reachable + 차원 일치 확인(잘못된 base_url/model 조기 차단).
  if (!(await provider.isAvailable())) {
    console.error(`임베딩 엔드포인트 불가용(model=${provider.model}, dim=${provider.dimensions}) — base_url/model/auth_env 확인.`);
    process.exit(2);
  }
  console.log(`백필 시작: model=${provider.model} dim=${provider.dimensions} mode=${ALL ? "all" : MODEL_CHANGED ? "null+model-changed" : "null-only"}`);

  // 대상 필터 — 기본 IS NULL, --model-changed 면 모델 불일치도, --all 이면 전부.
  const params = [];
  let target;
  if (ALL) {
    target = `lifecycle='active'`;
  } else if (MODEL_CHANGED) {
    params.push(provider.model);
    target = `lifecycle='active' AND (embedding_vector IS NULL OR embedding_model IS DISTINCT FROM $1)`;
  } else {
    target = `lifecycle='active' AND embedding_vector IS NULL`;
  }

  let total = 0;
  for (;;) {
    // 재진입 안전: --all 은 이미 처리한 행을 다시 잡으므로 OFFSET 으로 진행(같은 배치 무한루프 방지).
    const offset = ALL ? total : 0;
    const { rows } = await itemsPool.query(
      `SELECT name, title, summary, body_md FROM knowledge
         WHERE ${target}
         ORDER BY updated_at DESC NULLS LAST
         LIMIT ${BATCH} OFFSET ${offset}`,
      params,
    );
    if (rows.length === 0) break;

    const texts = rows.map((r) => embeddingInputText(r));
    let vecs;
    try {
      vecs = await provider.embed(texts);
    } catch (err) {
      console.error(`배치 임베딩 실패(중단, 재실행 안전): ${err?.message ?? err}`);
      process.exit(1);
    }

    for (let i = 0; i < rows.length; i++) {
      const vec = vecs[i];
      if (!vec || !vec.length) continue;
      await itemsPool.query(
        `UPDATE knowledge SET embedding_vector=$2::vector, embedding_model=$3, embedding_updated_at=now() WHERE name=$1`,
        [rows[i].name, toVectorLiteral(vec), provider.model],
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

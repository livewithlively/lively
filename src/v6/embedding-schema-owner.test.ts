import { strict as assert } from "node:assert";
import test from "node:test";
import { ensureEmbeddingSchema } from "./embedding-provider.js";

// ★ 2026-08-20 dev 실측: 게이트웨이 DB 롤이 knowledge/project 테이블의 **소유자가 아니면** 백필이 통째로 막혔다.
//  `ALTER TABLE … ADD COLUMN IF NOT EXISTS` 는 컬럼이 이미 있어도 no-op 이 되기 전에 **소유자 검사를 먼저** 한다
//  → `must be owner of table knowledge` → ensureEmbeddingSchema=false → runEmbeddingBackfill 이 reason:"schema" 로
//  11ms 만에 죽는다. 증상이 고약하다: 벡터검색은 멀쩡히 돌고(컬럼·인덱스는 이미 있다) 관리 화면도 초록인데
//  **새로 쓴 지식만 영영 임베딩되지 않는다**(dev 에 64건 적체). 그 문서들은 벡터 채널에 없으므로 하이브리드
//  검색이 grep 단독보다 나빠진다 — RRF 가 엉뚱한 벡터 순위를 정답 위에 얹기 때문.
//  사양·엣지 표: 스크래치패드 spec.md (10행). 아래 테스트는 그 표의 행마다 하나씩이다.

/** 최소 pg.Pool 흉내 — 카탈로그 조회에 규칙표로 답하고, 무엇이 실제로 불렸는지 argv 를 남긴다(문구 단언 금지). */
function fakePool(opts: { cols?: number; vecDim?: number; hnsw?: boolean; alterThrows?: string; catalogThrows?: boolean }): {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      void params;
      calls.push(sql.trim().split(/\s+/).slice(0, 2).join(" ").toUpperCase());
      if (/FROM pg_attribute/i.test(sql)) {
        if (opts.catalogThrows) throw new Error("permission denied for catalog");
        const rows = ["embedding_vector", "embedding_model", "embedding_updated_at"]
          .slice(0, opts.cols ?? 0)
          .map((attname) => ({ attname, dim: attname === "embedding_vector" ? (opts.vecDim ?? 0) : 0 }));
        return { rows, rowCount: rows.length };
      }
      if (/FROM pg_indexes/i.test(sql)) return { rows: opts.hnsw ? [{ ok: 1 }] : [], rowCount: opts.hnsw ? 1 : 0 };
      if (/^ALTER TABLE/i.test(sql.trim()) && opts.alterThrows) throw new Error(opts.alterThrows);
      return { rows: [], rowCount: 0 };
    },
  };
}
const wrote = (p: { calls: string[] }): boolean => p.calls.some((c) => c.startsWith("ALTER") || c.startsWith("CREATE"));

// [1] 알 수 없는 테이블 — DB 를 아예 만지지 않는다(SQL 인젝션 방어이기도 하다)
test("모르는 테이블은 손대지 않는다 — DB 접촉 0", async () => {
  const p = fakePool({ cols: 3, vecDim: 1024, hnsw: true });
  assert.equal(await ensureEmbeddingSchema(p as never, 1024, "secrets"), false);
  assert.equal(p.calls.length, 0);
});

// [2] 차원 범위 밖 — 경계값(1, 16000 은 유효 / 0, 16001 은 무효)
test("차원이 범위 밖이면 DB 접촉 0 (경계 0·16001)", async () => {
  for (const dim of [0, 16001]) {
    const p = fakePool({ cols: 3, vecDim: dim, hnsw: true });
    assert.equal(await ensureEmbeddingSchema(p as never, dim, "knowledge"), false, `dim=${dim}`);
    assert.equal(p.calls.length, 0, `dim=${dim} 인데 DB 를 만졌다`);
  }
});

// [3] ★ 이번 수정의 핵심 — 갖춰져 있으면 소유권 없이도 통과, 쓰기를 아예 안 한다
test("★ 소유자가 아니어도 이미 갖춰져 있으면 true — 쓰기(ALTER/CREATE)를 한 번도 안 친다", async () => {
  const p = fakePool({ cols: 3, vecDim: 1024, hnsw: true, alterThrows: "must be owner of table knowledge" });
  assert.equal(await ensureEmbeddingSchema(p as never, 1024, "knowledge"), true);
  assert.equal(wrote(p), false, "갖춰져 있는데 쓰기를 쳤다");
  // 배선 확인 — 관측 장치가 죽어 있으면 위 단언이 공허해진다
  assert.ok(p.calls.some((c) => c === "SELECT A.ATTNAME" || c.startsWith("SELECT")), "카탈로그 조회 자체를 안 했다");
});

// [4] 컬럼이 모자람
test("컬럼이 일부만 있으면 생성 경로로 간다", async () => {
  const p = fakePool({ cols: 1, vecDim: 1024, hnsw: true });
  assert.equal(await ensureEmbeddingSchema(p as never, 1024, "knowledge"), true);
  assert.equal(p.calls.some((c) => c.startsWith("ALTER")), true, "없는데 안 만들었다");
});

// [5] 인덱스가 없음
test("컬럼은 있고 인덱스가 없으면 인덱스를 만든다", async () => {
  const p = fakePool({ cols: 3, vecDim: 1024, hnsw: false });
  assert.equal(await ensureEmbeddingSchema(p as never, 1024, "knowledge"), true);
  assert.equal(p.calls.some((c) => c === "CREATE INDEX"), true);
});

// [6] 차원 불일치(모델 스왑) — 경계
test("★ 차원이 다르면 갖춰진 게 아니다 — 768 컬럼에 1024 를 '이미 됨' 으로 오인하지 않는다", async () => {
  const p = fakePool({ cols: 3, vecDim: 768, hnsw: true });
  await ensureEmbeddingSchema(p as never, 1024, "knowledge");
  assert.equal(p.calls.some((c) => c.startsWith("ALTER")), true, "768→1024 인데 통과시켰다");
});

// [7] 아무것도 없고 권한도 없음 — fail-open
test("갖춰지지 않았고 권한도 없으면 false(렉시컬 폴백) — 던지지 않는다", async () => {
  const p = fakePool({ cols: 0, alterThrows: "must be owner of table knowledge" });
  assert.equal(await ensureEmbeddingSchema(p as never, 1024, "knowledge"), false);
});

// [8] 아무것도 없고 권한 있음 — 종전 정상 경로
test("갖춰지지 않았고 권한이 있으면 만들고 true", async () => {
  const p = fakePool({ cols: 0 });
  assert.equal(await ensureEmbeddingSchema(p as never, 1024, "knowledge"), true);
  assert.equal(p.calls.some((c) => c.startsWith("ALTER")), true);
});

// [9] ★ 새 헬퍼가 만든 새 엣지 — HNSW 한계(2000) 초과 구간은 인덱스를 애초에 안 만든다
test("★ 차원이 HNSW 한계를 넘으면 인덱스가 없어도 '갖춰짐' 이다 — 그 구간은 인덱스를 만들지 않는 게 사양이다", async () => {
  const p = fakePool({ cols: 3, vecDim: 3072, hnsw: false, alterThrows: "must be owner of table knowledge" });
  assert.equal(await ensureEmbeddingSchema(p as never, 3072, "knowledge"), true);
  assert.equal(wrote(p), false, "인덱스를 안 만드는 구간인데 쓰기를 쳤다");
});

// [10] 카탈로그를 못 읽음 — 종전 동작으로 폴백
test("카탈로그 조회가 실패하면 '없다' 로 보고 종전 생성 경로로 간다", async () => {
  const p = fakePool({ cols: 3, vecDim: 1024, hnsw: true, catalogThrows: true });
  assert.equal(await ensureEmbeddingSchema(p as never, 1024, "knowledge"), true);
  assert.equal(p.calls.some((c) => c.startsWith("ALTER")), true, "못 읽었는데 통과시켰다");
});

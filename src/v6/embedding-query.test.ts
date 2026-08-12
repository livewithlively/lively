// 질의 임베딩 데드라인(#1644) — DB 불요(fetch 스텁·가짜 provider, node:assert 자급).
//  실행: npm run build && node dist/v6/embedding-query.test.js
//  잠그는 것: query_timeout_ms 정규화/경계 · embedQuery 가 **배치 인내심이 아니라 질의 데드라인**을 쓴다는 것
//   · 데드라인 초과는 요청 1회로 끝난다(축소 재시도 없음) · 배치 embed 무영향 · 폴백 사유 판정 4종.
//  왜 잠그나(고객사 실측): knowledge_search 621콜에서 p50 은 763ms 인데 p90 9.3초·최대 92.7초였다. 원인은
//   임베딩 백엔드(Ollama CPU, 동시 슬롯 1)의 큐 대기인데, 검색이 백필과 같은 request_timeout_ms(그 박스 600초)를
//   써서 그 대기를 끝까지 기다렸다. 두 인내심이 다시 한 값으로 합쳐지면 이 회귀가 그대로 돌아온다.
import assert from "node:assert/strict";
import {
  normalizeEmbeddingConfig, resolveEmbeddingProvider, isEmbedTimeoutError, embeddingConfigFromEnv,
  DEFAULT_EMBEDDING_QUERY_TIMEOUT_MS, EMBEDDING_QUERY_TIMEOUT_MIN_MS, EMBEDDING_QUERY_TIMEOUT_MAX_MS,
  type EmbeddingProvider,
} from "./embedding-provider.js";
import { embedSearchQuery } from "./search-util.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  await fn(); pass++; console.log(`ok  ${name}`);
};

// 스텁 fetch — delayMs 뒤 응답. AbortSignal 을 존중해 실제 undici 처럼 signal.reason 으로 reject.
//  호출 argv(= 요청 횟수·본문)를 남긴다: "몇 번 때렸나"가 이 사양의 핵심 단언 중 하나다.
type Sent = { input: unknown };
function stubFetch(delayMs: number, sent: Sent[]): typeof globalThis.fetch {
  return ((_url: string, init?: { signal?: AbortSignal; body?: string }) => new Promise((resolve, reject) => {
    sent.push({ input: JSON.parse(String(init?.body ?? "{}")).input });
    const timer = setTimeout(() => resolve({
      ok: true, status: 200, statusText: "OK",
      json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
      text: async () => "",
    } as unknown as Response), delayMs);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(init.signal?.reason ?? new Error("aborted"));
    });
  })) as unknown as typeof globalThis.fetch;
}

// 가짜 provider — embedSearchQuery(폴백 사유 판정)만 재는 데 쓴다. HTTP·DB 불요.
function fakeProvider(behavior: () => Promise<number[]>): EmbeddingProvider {
  return {
    kind: "http", model: "fake", dimensions: 3,
    embed: async () => [], isAvailable: async () => true,
    embedQuery: behavior,
  };
}

async function main(): Promise<void> {
  // ── E1·E4 정규화 기본값 — 기존 조직의 저장된 설정엔 이 필드가 아예 없다(마이그레이션 없음). ──
  await t("E1 필드 부재(기존 조직 설정) → 기본값", () => {
    const c = normalizeEmbeddingConfig({ provider: "http", base_url: "http://x", model: "bge-m3" });
    assert.equal(c.query_timeout_ms, DEFAULT_EMBEDDING_QUERY_TIMEOUT_MS);
  });
  await t("E4 잡값·null·빈값 → 기본값(하한이 아니라)", () => {
    for (const v of ["abc", null, "", undefined]) {
      assert.equal(normalizeEmbeddingConfig({ provider: "http", query_timeout_ms: v }).query_timeout_ms,
        DEFAULT_EMBEDDING_QUERY_TIMEOUT_MS, `query_timeout_ms=${JSON.stringify(v)}`);
    }
  });
  // #1644 에서 같은 자리에 있던 실제 버그 — null/빈값이 0 으로 coerce 돼 **하한**으로 클램프되고 있었다.
  //  .env 로 임베딩만 켠 박스(embeddingConfigFromEnv 는 미설정을 null 로 넘긴다)가 batch_size=1 · 배치 타임아웃 1초로 돌았다.
  await t("E4b 배치 설정도 null/빈값이면 기본값(최솟값이 아니라)", () => {
    const c = normalizeEmbeddingConfig({ provider: "http", batch_size: null, request_timeout_ms: "", backfill_min_available_mb: null });
    assert.equal(c.batch_size, 8);
    assert.equal(c.request_timeout_ms, 300_000);
    assert.equal(c.backfill_min_available_mb, 0);
  });
  await t("E2 하한 미만 → 클램프", () => {
    assert.equal(normalizeEmbeddingConfig({ provider: "http", query_timeout_ms: 1 }).query_timeout_ms, EMBEDDING_QUERY_TIMEOUT_MIN_MS);
  });
  await t("E3 상한 초과 → 클램프", () => {
    assert.equal(normalizeEmbeddingConfig({ provider: "http", query_timeout_ms: 999_999_999 }).query_timeout_ms, EMBEDDING_QUERY_TIMEOUT_MAX_MS);
  });
  await t("E5 경계값(하한·상한 정확히) → 그대로", () => {
    assert.equal(normalizeEmbeddingConfig({ provider: "http", query_timeout_ms: EMBEDDING_QUERY_TIMEOUT_MIN_MS }).query_timeout_ms, EMBEDDING_QUERY_TIMEOUT_MIN_MS);
    assert.equal(normalizeEmbeddingConfig({ provider: "http", query_timeout_ms: EMBEDDING_QUERY_TIMEOUT_MAX_MS }).query_timeout_ms, EMBEDDING_QUERY_TIMEOUT_MAX_MS);
  });
  await t("E6 배치 인내심과 서로 독립", () => {
    const c = normalizeEmbeddingConfig({ provider: "http", request_timeout_ms: 600_000, query_timeout_ms: 1_500 });
    assert.equal(c.request_timeout_ms, 600_000);
    assert.equal(c.query_timeout_ms, 1_500);
  });

  const realFetch = globalThis.fetch;
  const cfg = (o: Record<string, unknown>): EmbeddingProvider => {
    const p = resolveEmbeddingProvider(normalizeEmbeddingConfig({ provider: "http", base_url: "http://stub", model: "m", ...o }));
    assert.ok(p, "provider 가 만들어져야 한다(테스트 배선 확인)");
    return p;
  };
  try {
    await t("E7 데드라인 안 응답 → 벡터, 요청 1회", async () => {
      const sent: Sent[] = []; globalThis.fetch = stubFetch(20, sent);
      assert.deepEqual(await cfg({ query_timeout_ms: 500 }).embedQuery("안녕"), [0.1, 0.2, 0.3]);
      assert.equal(sent.length, 1, "스텁이 실제로 불려야 한다(배선)");
      assert.deepEqual(sent[0].input, ["안녕"]);
    });

    // ★ 핵심 회귀 — 배치 인내심(600초)이 아니라 질의 데드라인에 끊긴다.
    await t("E8 데드라인 초과 → 즉시 TimeoutError · 배치 인내심까지 안 기다림 · 요청 1회", async () => {
      const sent: Sent[] = []; globalThis.fetch = stubFetch(5_000, sent);
      const p = cfg({ query_timeout_ms: 120, request_timeout_ms: 600_000 });
      const t0 = Date.now();
      await assert.rejects(() => p.embedQuery("안녕"), (e: unknown) => isEmbedTimeoutError(e));
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 2_000, `질의 데드라인에 끊겨야 한다(실측 ${elapsed}ms)`);
      assert.equal(sent.length, 1, "단건은 쪼갤 게 없다 — 축소 재시도로 백엔드를 다시 때리면 안 된다");
    });

    await t("E9 배치 embed 는 질의 데드라인의 영향을 받지 않는다", async () => {
      const sent: Sent[] = []; globalThis.fetch = stubFetch(300, sent);
      const out = await cfg({ query_timeout_ms: 100, request_timeout_ms: 5_000, batch_size: 1 }).embed(["가"]);
      assert.deepEqual(out, [[0.1, 0.2, 0.3]]);
      assert.equal(sent.length, 1);
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  // ── 폴백 사유 판정 — 벡터를 못 쓰는 세 경우는 의미가 다르고, 응답에 그대로 실린다. ──
  await t("E10 provider off → qvec 없음 + embeddings_off", async () => {
    assert.deepEqual(await embedSearchQuery(null, "질문"), { qvec: null, degraded: "embeddings_off" });
  });
  await t("E11 데드라인 초과 → embedding_timeout", async () => {
    const r = await embedSearchQuery(fakeProvider(async () => { throw new DOMException("timed out", "TimeoutError"); }), "질문");
    assert.deepEqual(r, { qvec: null, degraded: "embedding_timeout" });
  });
  await t("E12 그 외 오류 → embedding_error", async () => {
    const r = await embedSearchQuery(fakeProvider(async () => { throw new Error("embedding endpoint 500 Internal"); }), "질문");
    assert.deepEqual(r, { qvec: null, degraded: "embedding_error" });
  });
  await t("E13 빈 벡터 응답 → embedding_error(성공으로 치지 않는다)", async () => {
    const r = await embedSearchQuery(fakeProvider(async () => []), "질문");
    assert.deepEqual(r, { qvec: null, degraded: "embedding_error" });
  });
  await t("E14 정상 → 벡터, 폴백 사유 없음", async () => {
    const r = await embedSearchQuery(fakeProvider(async () => [1, 2, 3]), "질문");
    assert.deepEqual(r, { qvec: [1, 2, 3] });   // deepEqual = degraded 같은 여분 속성이 없어야 통과
  });

  // ── E15 env 시드 — 관리탭(DB) 설정이 없는 새 박스는 .env 로만 정해진다. ──
  await t("E15 EMBEDDINGS_QUERY_TIMEOUT_MS 가 시드된다", () => {
    const saved = { p: process.env.EMBEDDINGS_PROVIDER, q: process.env.EMBEDDINGS_QUERY_TIMEOUT_MS };
    try {
      process.env.EMBEDDINGS_PROVIDER = "http";
      process.env.EMBEDDINGS_QUERY_TIMEOUT_MS = "800";
      assert.equal(embeddingConfigFromEnv().query_timeout_ms, 800);
      delete process.env.EMBEDDINGS_QUERY_TIMEOUT_MS;
      assert.equal(embeddingConfigFromEnv().query_timeout_ms, DEFAULT_EMBEDDING_QUERY_TIMEOUT_MS);
    } finally {
      if (saved.p === undefined) delete process.env.EMBEDDINGS_PROVIDER; else process.env.EMBEDDINGS_PROVIDER = saved.p;
      if (saved.q === undefined) delete process.env.EMBEDDINGS_QUERY_TIMEOUT_MS; else process.env.EMBEDDINGS_QUERY_TIMEOUT_MS = saved.q;
    }
  });

  console.log(`\n${pass} passed`);
}

await main();

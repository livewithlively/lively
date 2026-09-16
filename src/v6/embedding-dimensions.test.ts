import { strict as assert } from "node:assert";
import test from "node:test";
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  EMBEDDING_OFF,
  embeddingConfigFromEnv,
  normalizeEmbeddingConfig,
  resolveEmbeddingProvider,
  type EmbeddingConfig,
} from "./embedding-provider.js";

// #4015 — 업스트림 요청에 `dimensions` 를 싣는다.
//  왜: 이게 없으면 «업스트림 갈아타기»가 cp.env 한 줄이 아니게 된다. 외부 API 로 옮기는 순간 차원이
//  달라지고(OpenAI text-embedding-3-* 기본 1536), vector(1024) 컬럼과 어긋나 컬럼 drop+recreate 와
//  전량 재임베딩이 강제된다. 실어 보내면 서버가 그 차원으로 잘라 준다(2026-09-16 실측: Ollama bge-m3 에
//  dimensions=64 → 실제 64차원).
//  단 모든 서버가 그 필드를 아는 건 아니라서, 거부(400/422)하면 한 번 빼고 재시도한 뒤 그 뒤로 안 싣는다.

const cfgOn = (over: Partial<EmbeddingConfig> = {}): EmbeddingConfig =>
  normalizeEmbeddingConfig({ provider: "http", base_url: "http://up.test", model: "bge-m3", ...over });

interface Call { body: Record<string, unknown> }

/** fetch 를 갈아끼우고 호출 기록을 돌려준다. status 는 호출 순서대로 소비된다(없으면 200). */
function stubFetch(statuses: number[] = []): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ body });
    const status = statuses[i++] ?? 200;
    if (status !== 200) {
      return { ok: false, status, statusText: "Bad Request", text: async () => "unknown field: dimensions" };
    }
    const n = Number(body.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS);
    const input = body.input as string[];
    return {
      ok: true,
      json: async () => ({ data: input.map((_t, idx) => ({ index: idx, embedding: new Array(n).fill(0.1) })) }),
    };
  }) as unknown as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("★ 기본값은 «싣는다» — 갈아타기가 한 줄로 유지되는 근거", () => {
  assert.equal(cfgOn().send_dimensions, true);
  assert.equal(EMBEDDING_OFF.send_dimensions, true);
});

test("끄면 꺼진다 — 불린·문자열 둘 다(DB JSONB·env 잡값 방어)", () => {
  assert.equal(cfgOn({ send_dimensions: false }).send_dimensions, false);
  assert.equal(normalizeEmbeddingConfig({ provider: "http", send_dimensions: "false" }).send_dimensions, false);
  assert.equal(normalizeEmbeddingConfig({ provider: "http", send_dimensions: "0" }).send_dimensions, false);
  // 미지정은 기본값(true) — 기존 DB 행에 이 키가 없어도 켜진다.
  assert.equal(normalizeEmbeddingConfig({ provider: "http" }).send_dimensions, true);
});

test("env 부트스트랩도 같은 규약을 쓴다", () => {
  const prev = { p: process.env.EMBEDDINGS_PROVIDER, d: process.env.EMBEDDINGS_SEND_DIMENSIONS };
  try {
    process.env.EMBEDDINGS_PROVIDER = "http";
    process.env.EMBEDDINGS_SEND_DIMENSIONS = "false";
    assert.equal(embeddingConfigFromEnv().send_dimensions, false);
    delete process.env.EMBEDDINGS_SEND_DIMENSIONS;
    assert.equal(embeddingConfigFromEnv().send_dimensions, true);
  } finally {
    if (prev.p === undefined) delete process.env.EMBEDDINGS_PROVIDER; else process.env.EMBEDDINGS_PROVIDER = prev.p;
    if (prev.d === undefined) delete process.env.EMBEDDINGS_SEND_DIMENSIONS; else process.env.EMBEDDINGS_SEND_DIMENSIONS = prev.d;
  }
});

test("★ 요청 바디에 설정된 차원이 실린다", async () => {
  const f = stubFetch();
  try {
    const p = resolveEmbeddingProvider(cfgOn({ dimensions: 1024 }))!;
    await p.embed(["안녕"]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.body.dimensions, 1024);
  } finally { f.restore(); }
});

test("끄면 바디에 없다 — 종전 동작 그대로", async () => {
  const f = stubFetch();
  try {
    const p = resolveEmbeddingProvider(cfgOn({ send_dimensions: false }))!;
    await p.embed(["안녕"]);
    assert.equal("dimensions" in f.calls[0]!.body, false);
  } finally { f.restore(); }
});

test("★★ 거부(400)하는 업스트림에서도 무회귀 — 빼고 재시도해서 결국 성공한다", async () => {
  const f = stubFetch([400]); // 1회차만 400, 그 뒤 200
  try {
    const p = resolveEmbeddingProvider(cfgOn())!;
    const out = await p.embed(["안녕"]);
    assert.equal(out.length, 1);
    assert.ok(out[0]!.length > 0, "벡터를 받아야 한다(협상 실패면 throw 로 여기 못 온다)");
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0]!.body.dimensions, DEFAULT_EMBEDDING_DIMENSIONS);
    assert.equal("dimensions" in f.calls[1]!.body, false);
  } finally { f.restore(); }
});

test("★ 422 도 협상 대상이고, 협상 뒤에는 다시 싣지 않는다", async () => {
  const f = stubFetch([422]);
  try {
    const p = resolveEmbeddingProvider(cfgOn())!;
    await p.embed(["첫 요청"]);
    await p.embed(["두 번째 요청"]);
    assert.equal(f.calls.length, 3, "1차(422)+재시도+두 번째 = 3회. 4회면 매번 다시 협상하는 것");
    assert.equal("dimensions" in f.calls[2]!.body, false);
  } finally { f.restore(); }
});

test("500 은 협상 대상이 아니다 — 그냥 던진다(무의미한 재시도 방지)", async () => {
  const f = stubFetch([500, 500]);
  try {
    const p = resolveEmbeddingProvider(cfgOn())!;
    await assert.rejects(() => p.embed(["안녕"]), /embedding endpoint 500/);
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});

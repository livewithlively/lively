// 임베딩 설정 정규화 · 긴 입력 판정 (#5232) — 엣지 표 A·B·C.
//  A. 값이 없는 것은 0 이 아니라 «미지정» 이다. `.env` 로 켠 셀프호스트 박스가 배치 1건 · 시간 제한 1초로 돌아 긴 문서마다 시간 초과가 났고
//     백필이 0건에서 멈췄다. 숫자 설정을 준 적 없는 박스가 맞는 기본값으로 도는지를 정규화와 실제 요청 양쪽에서 본다.
//  B. 긴 입력 거절의 실제 응답 본문을 픽스처로 쓴다 — llama.cpp 서버는 500, Ollama 는 자기 재시도까지 실패했을 때만 413·400 을 낸다.
//     길이 초과 400 을 «dimensions 거부» 로 읽으면 뒤의 벡터 차원이 달라져 저장이 깨진다.
//  C. 질의는 embedQuery 를 지난다(#4530) — `.env` 박스의 1초가 사라지면 이 길을 벗어난 호출은 백필 뒤에서 몇 분을 기다린다.
import { strict as assert } from "node:assert";
import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EMBEDDING_BACKFILL_MIN_MB,
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  embeddingConfigFromEnv,
  normalizeEmbeddingConfig,
  resolveEmbeddingProvider,
} from "./embedding-provider.js";

const ENV_KEYS = ["EMBEDDINGS_PROVIDER", "EMBEDDINGS_BASE_URL", "EMBEDDINGS_MODEL", "EMBEDDINGS_DIMENSIONS", "EMBEDDINGS_BATCH_SIZE", "EMBEDDINGS_TIMEOUT_MS", "EMBEDDINGS_BACKFILL_MIN_MB", "EMBEDDINGS_AUTH_ENV", "EMBEDDINGS_SEND_DIMENSIONS"];
/** deploy/enable-embeddings.sh 가 `.env` 에 쓰는 값 그대로 — 숫자 설정은 없다. */
const ENABLE_SCRIPT_ENV = { EMBEDDINGS_PROVIDER: "http", EMBEDDINGS_BASE_URL: "http://up.test", EMBEDDINGS_MODEL: "bge-m3", EMBEDDINGS_DIMENSIONS: "1024" };

async function withEnv<T>(env: Record<string, string>, fn: () => T | Promise<T>): Promise<T> {
  const prev = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try { return await fn(); }
  finally { for (const [k, v] of prev) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

const numbers = (raw: Record<string, unknown>) => {
  const c = normalizeEmbeddingConfig({ provider: "http", ...raw });
  return { batch: c.batch_size, timeout: c.request_timeout_ms, minMb: c.backfill_min_available_mb };
};
const DEFAULTS = { batch: DEFAULT_EMBEDDING_BATCH_SIZE, timeout: DEFAULT_EMBEDDING_TIMEOUT_MS, minMb: DEFAULT_EMBEDDING_BACKFILL_MIN_MB };

test("기본값은 8 · 300000 · 0 이다 — 이 파일의 기대값이 움직이지 않게", () => {
  assert.deepEqual(DEFAULTS, { batch: 8, timeout: 300000, minMb: 0 });
});

const ABSENT: Array<[string, unknown]> = [["A1 null", null], ["A3 빈 글자", ""], ["A4 공백만", "   "]];
for (const [label, v] of ABSENT) {
  test(`${label} — 세 칸 모두 기본값`, () => {
    assert.deepEqual(numbers({ batch_size: v, request_timeout_ms: v, backfill_min_available_mb: v }), DEFAULTS);
  });
}

test("A2 키가 없으면 기본값", () => { assert.deepEqual(numbers({}), DEFAULTS); });

const JUNK: Array<[string, unknown]> = [["글자", "abc"], ["NaN", NaN], ["Infinity", Infinity], ["true", true], ["false", false], ["빈 배열", []], ["객체", {}]];
for (const [label, v] of JUNK) {
  test(`A9 잡값 ${label} → 기본값`, () => {
    assert.deepEqual(numbers({ batch_size: v, request_timeout_ms: v, backfill_min_available_mb: v }), DEFAULTS);
  });
}

test("A5 숫자 글자는 수로 읽는다", () => {
  assert.deepEqual(numbers({ batch_size: "16", request_timeout_ms: "120000", backfill_min_available_mb: "4096" }), { batch: 16, timeout: 120000, minMb: 4096 });
});
test("A6 수는 그대로", () => {
  assert.deepEqual(numbers({ batch_size: 16, request_timeout_ms: 120000 }), { batch: 16, timeout: 120000, minMb: 0 });
});
test("A7 경계값은 그대로", () => {
  assert.equal(numbers({ batch_size: 1 }).batch, 1);
  assert.equal(numbers({ batch_size: 512 }).batch, 512);
  assert.equal(numbers({ request_timeout_ms: 1000 }).timeout, 1000);
  assert.equal(numbers({ request_timeout_ms: 3600000 }).timeout, 3600000);
});
test("A8 범위 밖은 경계로 접힌다 — 수 0 은 미지정이 아니다", () => {
  assert.equal(numbers({ batch_size: 0 }).batch, 1);
  assert.equal(numbers({ batch_size: "0" }).batch, 1);
  assert.equal(numbers({ batch_size: -5 }).batch, 1);
  assert.equal(numbers({ batch_size: 513 }).batch, 512);
  assert.equal(numbers({ request_timeout_ms: 999 }).timeout, 1000);
  assert.equal(numbers({ request_timeout_ms: 3600001 }).timeout, 3600000);
});
test("A10 소수는 내린다", () => { assert.equal(numbers({ batch_size: "8.9" }).batch, 8); });

test("A11 `.env` 에 숫자 설정이 없으면 기본값", () => withEnv(ENABLE_SCRIPT_ENV, () => {
  const c = embeddingConfigFromEnv();
  assert.equal(c.provider, "http");
  assert.equal(c.batch_size, 8);
  assert.equal(c.request_timeout_ms, 300000);
}));
test("A12 `.env` 의 빈 값도 미지정이다", () => withEnv({ ...ENABLE_SCRIPT_ENV, EMBEDDINGS_TIMEOUT_MS: "", EMBEDDINGS_BATCH_SIZE: "" }, () => {
  const c = embeddingConfigFromEnv();
  assert.equal(c.batch_size, 8);
  assert.equal(c.request_timeout_ms, 300000);
}));
test("A13 `.env` 에 적은 값은 그대로", () => withEnv({ ...ENABLE_SCRIPT_ENV, EMBEDDINGS_TIMEOUT_MS: "5000", EMBEDDINGS_BATCH_SIZE: "2" }, () => {
  const c = embeddingConfigFromEnv();
  assert.equal(c.batch_size, 2);
  assert.equal(c.request_timeout_ms, 5000);
}));

test("★ A14 `.env` 값만으로 만든 provider 가 1초를 넘겨 답하는 서버에서 벡터를 받는다", async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests++;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }));
      }, 1200);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await withEnv({ ...ENABLE_SCRIPT_ENV, EMBEDDINGS_BASE_URL: `http://127.0.0.1:${port}` }, async () => {
      const p = resolveEmbeddingProvider(embeddingConfigFromEnv())!;
      const out = await p.embed(["긴 문서"]);
      assert.deepEqual(out, [[0.1, 0.2]]);
      assert.equal(requests, 1, "배선 — 서버가 실제로 요청을 받았다");
    });
  } finally { server.closeAllConnections(); server.close(); }
});

// ── 가짜 임베딩 서버 — 벡터 첫 칸에 글 길이를 담아 «어느 글이 어느 자리로 왔나» 를 벡터로 본다. ──
interface Rejection { status: number; body?: string }
function stubFetch(reject: (input: string[]) => Rejection | null): { calls: Array<Record<string, unknown>>; restore: () => void } {
  const calls: Array<Record<string, unknown>> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    calls.push(payload);
    const input = payload.input as string[];
    const r = reject(input);
    if (r) {
      return {
        ok: false, status: r.status, statusText: "Error",
        text: async () => { if (r.body === undefined) throw new Error("본문을 못 읽었다"); return r.body; },
      };
    }
    const n = Number(payload.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS);
    return { ok: true, json: async () => ({ data: input.map((t, index) => ({ index, embedding: new Array(n).fill(t.length) })) }) };
  }) as unknown as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const LIMIT = 1500;
const LONG = "가".repeat(4000);
const tooLong = (r: Rejection) => (input: string[]) => (input.some((t) => t.length > LIMIT) ? r : null);
const provider = () => resolveEmbeddingProvider(normalizeEmbeddingConfig({ provider: "http", base_url: "http://up.test", model: "bge-m3" }))!;

//  llama.cpp 서버(Ollama 러너)에 직접 보내 받은 응답 그대로(2026-11-02).
const LLAMA_TOO_LARGE: Rejection = { status: 500, body: `{"error":{"code":500,"message":"input (4834 tokens) is too large to process. increase the physical batch size (current batch size: 2048)","type":"server_error"}}` };
//  Ollama 가 자기 축약 재시도까지 실패했을 때 내는 말(server/routes.go · llm/llama_server.go, v0.40.13).
const OLLAMA_413: Rejection = { status: 413, body: `{"error":{"message":"the input length exceeds the context length","type":"api_error","param":null,"code":null}}` };
const OLLAMA_400: Rejection = { status: 400, body: `{"error":{"message":"input exceeds maximum context length and cannot be truncated further","type":"invalid_request_error","param":null,"code":null}}` };
const OPENAI_400: Rejection = { status: 400, body: `{"error":{"message":"This model's maximum context length is 8192 tokens, however you requested 9000 tokens.","type":"invalid_request_error","param":null,"code":null}}` };

test("★ B1 llama.cpp 의 500 «too large to process» — 앞부분을 줄여 벡터를 얻는다", async () => {
  const f = stubFetch(tooLong(LLAMA_TOO_LARGE));
  try {
    const [v] = await provider().embed([LONG]);
    assert.ok(v![0]! > 0 && v![0]! <= LIMIT, `받아들여진 길이: ${v![0]}`);
    assert.ok(f.calls.length >= 2, "배선 — 거절을 실제로 받았다");
  } finally { f.restore(); }
});

test("★ B2 배치 안 한 건이 길어도 나머지는 그대로 · 자리 유지", async () => {
  const f = stubFetch(tooLong(LLAMA_TOO_LARGE));
  try {
    const texts = Array.from({ length: 8 }, (_, i) => (i === 5 ? LONG : "나".repeat(10 + i)));
    const out = await provider().embed(texts);
    assert.equal(out.length, 8);
    for (const i of [0, 1, 2, 3, 4, 6, 7]) assert.equal(out[i]![0], 10 + i, `${i}번 자리`);
    assert.ok(out[5]![0]! > 0 && out[5]![0]! <= LIMIT, `긴 글 자리: ${out[5]![0]}`);
  } finally { f.restore(); }
});

test("B3 Ollama 413 — 앞부분을 줄여 벡터를 얻는다", async () => {
  const f = stubFetch(tooLong(OLLAMA_413));
  try {
    const [v] = await provider().embed([LONG]);
    assert.ok(v![0]! > 0 && v![0]! <= LIMIT);
    assert.ok(f.calls.every((c) => c.dimensions === DEFAULT_EMBEDDING_DIMENSIONS), "dimensions 는 끝까지 실린다");
  } finally { f.restore(); }
});

test("★ B4 Ollama 400 길이 초과 — 축약하되 dimensions 협상을 하지 않는다", async () => {
  const f = stubFetch(tooLong(OLLAMA_400));
  try {
    const [v] = await provider().embed([LONG]);
    assert.ok(v![0]! > 0 && v![0]! <= LIMIT);
    assert.ok(f.calls.every((c) => c.dimensions === DEFAULT_EMBEDDING_DIMENSIONS), "길이 초과는 dimensions 탓이 아니다");
  } finally { f.restore(); }
});

test("★ B5 OpenAI 400 길이 초과 — 뒤 요청도 dimensions 를 싣는다(차원이 달라지면 저장이 깨진다)", async () => {
  const f = stubFetch(tooLong(OPENAI_400));
  try {
    const p = provider();
    await p.embed([LONG]);
    await p.embed(["뒤 요청"]);
    assert.equal(f.calls.at(-1)!.dimensions, DEFAULT_EMBEDDING_DIMENSIONS);
  } finally { f.restore(); }
});

test("B6 dimensions 를 모르는 400 — 종전대로 빼고 다시 보낸다", async () => {
  const f = stubFetch((input) => (f.calls.at(-1)?.dimensions !== undefined ? { status: 400, body: `{"error":"unknown field: dimensions, input=${input.length}"}` } : null));
  try {
    const out = await provider().embed(["안녕"]);
    assert.equal(out.length, 1);
    assert.equal(f.calls.length, 2);
    assert.equal("dimensions" in f.calls[1]!, false);
  } finally { f.restore(); }
});

test("B7 400 본문을 못 읽어도 종전대로 협상한다 — 새 판정의 입력이 빈 경우", async () => {
  const f = stubFetch(() => (f.calls.at(-1)?.dimensions !== undefined ? { status: 400 } : null));
  try {
    const out = await provider().embed(["안녕"]);
    assert.equal(out.length, 1);
    assert.equal(f.calls.length, 2);
  } finally { f.restore(); }
});

test("B8 길이와 무관한 500 — 그대로 던지고 쪼개지 않는다", async () => {
  const f = stubFetch(() => ({ status: 500, body: `{"error":{"message":"backend failed"}}` }));
  try {
    await assert.rejects(() => provider().embed(["가", "나"]), /embedding endpoint 500/);
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});

test("B9 끝까지 거절하면 무한히 줄이지 않고 던진다", async () => {
  const f = stubFetch(() => LLAMA_TOO_LARGE);
  try {
    await assert.rejects(() => provider().embed([LONG]));
    assert.ok(f.calls.length >= 2 && f.calls.length <= 8, `요청 수: ${f.calls.length}`);
  } finally { f.restore(); }
});

test("★ A15 `.env` 값만으로 텍스트 9건 → 요청 2번(8 + 1)", () => withEnv(ENABLE_SCRIPT_ENV, async () => {
  const f = stubFetch(() => null);
  try {
    const out = await resolveEmbeddingProvider(embeddingConfigFromEnv())!.embed(Array.from({ length: 9 }, (_, i) => `글 ${i}`));
    assert.equal(out.length, 9);
    assert.deepEqual(f.calls.map((c) => (c.input as string[]).length), [8, 1]);
  } finally { f.restore(); }
}));

test("★ C1 `.embed(` 를 직접 부르는 자리는 provider 자신 · 백필 · embedQuery · 세션 프롬프트 검색(자기 시간 예산)뿐이다", () => {
  const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && /\.embed\(/.test(readFileSync(p, "utf8"))) found.push(path.relative(srcRoot, p).split(path.sep).join("/"));
    }
  };
  walk(srcRoot);
  assert.deepEqual(found.sort(), ["terminal/terminal-transcript.ts", "v6/embedding-backfill.ts", "v6/embedding-provider.ts", "v6/search-util.ts"]);
});

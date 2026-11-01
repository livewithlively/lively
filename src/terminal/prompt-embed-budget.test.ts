// 프롬프트 검색의 임베딩 시간 예산 (#5232) — 사람이 기다리는 검색이 임베딩 서버 뒤에 매달리지 않는다.
//  `.env` 로 켠 박스의 시간 제한이 1초에서 300초로 바뀌면, 백필로 밀린 서버 앞에서 이 검색이 몇 분씩 기다리게 된다.
//  표:
//   P1 질의 임베딩이 안 끝난다 — 예산 안에 null (렉시컬로 답한다)
//   P2 질의 임베딩이 실패한다 — null
//   P3 프롬프트 배치가 안 끝난다 — 예산 안에 질의 벡터 · 뒤 배치는 안 보낸다
//   P4 늦게 온 프롬프트 벡터도 기억한다 — 다음 검색이 쓴다
//   P5 평소 — 중복을 빼고 128건씩 전부 보낸다
//   P6 채울 프롬프트가 없다(새 입력이 빈 경우) — 질의 벡터만
//   P7 프롬프트 배치 하나가 실패해도 다음 배치를 보낸다
import assert from "node:assert/strict";
import test from "node:test";
import { __promptEmbedded, embedPromptsWithin, PROMPT_EMBED_BUDGET_MS } from "./terminal-transcript.js";
import type { EmbeddingProvider } from "../v6/embedding-provider.js";

const VEC = [0.1, 0.2];
const never = <T>(): Promise<T> => new Promise<T>(() => {});

function fake(embed: (texts: string[], nth: number) => Promise<number[][]>): { provider: EmbeddingProvider; calls: string[][] } {
  const calls: string[][] = [];
  const provider: EmbeddingProvider = {
    kind: "http", model: "m", dimensions: 2, isAvailable: async () => true,
    embed: (texts) => { calls.push(texts); return embed(texts, calls.length); },
  };
  return { provider, calls };
}
const vectors = (texts: string[]) => Promise.resolve(texts.map(() => VEC));

test("기본 예산은 20초다 — 백필 시간 상한(300초)이 아니다", () => { assert.equal(PROMPT_EMBED_BUDGET_MS, 20_000); });

test("★ P1 질의 임베딩이 안 끝나면 예산 안에 null", async () => {
  const { provider, calls } = fake(() => never());
  const t0 = Date.now();
  assert.equal(await embedPromptsWithin(provider, "질의", () => ["가"], 30), null);
  assert.ok(Date.now() - t0 < 2000, `걸린 시간 ${Date.now() - t0}ms`);
  assert.equal(calls.length, 1, "프롬프트 배치는 보내지 않는다");
});

test("P2 질의 임베딩이 실패하면 null", async () => {
  const { provider, calls } = fake(() => Promise.reject(new Error("embedding endpoint 500")));
  assert.equal(await embedPromptsWithin(provider, "질의", () => ["가"], 1000), null);
  assert.equal(calls.length, 1);
});

test("★ P3 프롬프트 배치가 안 끝나면 예산 안에 질의 벡터를 돌려주고 뒤 배치는 안 보낸다", async () => {
  const texts = Array.from({ length: 200 }, (_, i) => `P3 글 ${i}`);
  const { provider, calls } = fake((t, nth) => (nth === 1 ? vectors(t) : never()));
  const t0 = Date.now();
  assert.deepEqual(await embedPromptsWithin(provider, "질의", () => texts, 30), VEC);
  assert.ok(Date.now() - t0 < 2000, `걸린 시간 ${Date.now() - t0}ms`);
  assert.equal(calls.length, 2, "질의 1 + 첫 배치 1 — 둘째 배치는 없다");
});

test("★ P4 예산이 지난 뒤 온 프롬프트 벡터도 기억한다", async () => {
  let release: (v: number[][]) => void = () => {};
  const { provider } = fake((t, nth) => (nth === 1 ? vectors(t) : new Promise<number[][]>((r) => { release = r; })));
  assert.deepEqual(await embedPromptsWithin(provider, "질의", () => ["P4 늦은 글"], 20), VEC);
  assert.equal(__promptEmbedded("P4 늦은 글"), false);
  release([VEC]);
  await new Promise((r) => setImmediate(r));
  assert.equal(__promptEmbedded("P4 늦은 글"), true);
});

test("P5 평소엔 중복을 빼고 128건씩 전부 보낸다", async () => {
  const texts = Array.from({ length: 300 }, (_, i) => `P5 글 ${i}`);
  const { provider, calls } = fake((t) => vectors(t));
  assert.deepEqual(await embedPromptsWithin(provider, "질의", () => [...texts, texts[0]!], 5000), VEC);
  assert.deepEqual(calls.map((c) => c.length), [1, 128, 128, 44]);
  assert.ok(texts.every(__promptEmbedded));
});

test("P6 채울 프롬프트가 없으면 질의 벡터만", async () => {
  const { provider, calls } = fake((t) => vectors(t));
  assert.deepEqual(await embedPromptsWithin(provider, "질의", () => [], 5000), VEC);
  assert.equal(calls.length, 1);
});

test("P7 배치 하나가 실패해도 다음 배치를 보낸다", async () => {
  const texts = Array.from({ length: 200 }, (_, i) => `P7 글 ${i}`);
  const { provider, calls } = fake((t, nth) => (nth === 2 ? Promise.reject(new Error("boom")) : vectors(t)));
  assert.deepEqual(await embedPromptsWithin(provider, "질의", () => texts, 5000), VEC);
  assert.deepEqual(calls.map((c) => c.length), [1, 128, 72]);
  assert.equal(__promptEmbedded(texts[0]!), false, "실패한 배치는 기억하지 않는다");
  assert.equal(__promptEmbedded(texts[199]!), true);
});

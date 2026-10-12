// 진행 로그 JSONL 조각 이어붙이기 — 회귀 가드 (web/jsonl-lines.ts).
//
// 왜 이 테스트가 있나: stream.jsonl 은 조각(chunk)으로 이어 받는데 조각 끝이 줄 중간일 수 있다.
// 줄 경계 처리가 틀리면 **에러 없이** 로그 줄이 잘려 JSON.parse 가 실패하거나(소비자가 조용히 건너뜀)
// 줄이 유실·중복된다. 한글·이모지(서로게이트 쌍)가 섞여 있어도 조각 경계 위치와 무관하게
// 결과가 원문과 같아야 하므로, 조각 경계를 가능한 모든 위치로 훑는 전수 검사로 못 박는다.
//
// 러너는 web/ 을 수집하지 않으므로 컴파일 산출물을 import 한다(`npm run build:web` 선행).
// 이 모듈은 DOM·전역 의존이 없어 그대로 부를 수 있다.
import { strict as assert } from "node:assert";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOD = path.join(ROOT, "public/app/jsonl-lines.js");
const { splitJsonlChunk, flushJsonlCarry } = await import(pathToFileURL(MOD).href);

let n = 0;
const ok = (name) => {
  n += 1;
  console.log(`ok ${name}`);
};

/** 조각 배열을 carry 를 이어 가며 넣고 (모든 lines, 마지막 carry) 를 돌려준다. */
const feed = (chunks) => {
  let carry = "";
  const lines = [];
  for (const c of chunks) {
    const r = splitJsonlChunk(carry, c);
    lines.push(...r.lines);
    carry = r.carry;
  }
  return { lines, carry };
};

const nonBlank = (text) => text.split("\n").filter((l) => l.trim() !== "");

// ── 1 마지막 '\n' 뒤 나머지는 carry, lines 에 넣지 않는다 ──
{
  const r = splitJsonlChunk("", '{"a":1}\n{"b":2}\n{"c"');
  assert.deepEqual(r.lines, ['{"a":1}', '{"b":2}']);
  assert.equal(r.carry, '{"c"');
  ok("마지막 개행 뒤 미완결 부분은 carry 로 남고 lines 에서 빠진다");
}

// ── 1 기존 carry 는 chunk 앞에 붙는다 ──
{
  const r = splitJsonlChunk('{"a":', '1}\n{"b"');
  assert.deepEqual(r.lines, ['{"a":1}']);
  assert.equal(r.carry, '{"b"');
  ok("이전 carry 를 chunk 앞에 붙여 줄을 완성한다");
}

// ── 2 개행으로 끝나면 carry 는 빈 문자열 ──
{
  const r = splitJsonlChunk("", "x\ny\n");
  assert.deepEqual(r.lines, ["x", "y"]);
  assert.equal(r.carry, "");
  ok("개행으로 끝나는 조각은 carry 가 빈 문자열이다");
}

// ── 3 빈 줄·공백뿐인 줄 제외 ──
{
  const r = splitJsonlChunk("", "a\n\n   \n\t \nb\n");
  assert.deepEqual(r.lines, ["a", "b"]);
  assert.equal(r.carry, "");
  ok("빈 줄과 공백뿐인 줄은 lines 에서 빠진다");
}

// ── 3 앞뒤 공백 원문 유지 ──
{
  const r = splitJsonlChunk("", "  a b  \n\tc\n");
  assert.deepEqual(r.lines, ["  a b  ", "\tc"]);
  ok("내용이 있는 줄은 앞뒤 공백까지 원문 그대로 유지한다");
}

// ── 4 개행이 없으면 전부 carry ──
{
  const r = splitJsonlChunk("앞", "뒤 😀");
  assert.deepEqual(r.lines, []);
  assert.equal(r.carry, "앞뒤 😀");
  ok("개행이 없으면 lines 는 비고 carry 는 carry+chunk 전체다");
}

// ── 빈 입력 ──
{
  const r = splitJsonlChunk("", "");
  assert.deepEqual(r, { lines: [], carry: "" });
  ok("carry·chunk 모두 비면 빈 결과다");
}

// ── 4 빈 chunk 는 carry 를 보존 ──
{
  const r = splitJsonlChunk("abc", "");
  assert.deepEqual(r, { lines: [], carry: "abc" });
  ok("빈 chunk 는 기존 carry 를 그대로 보존한다");
}

// ── 6 flush ──
{
  assert.deepEqual(flushJsonlCarry(""), []);
  ok("flush: 빈 carry 는 빈 배열");
  assert.deepEqual(flushJsonlCarry(" \t "), []);
  ok("flush: 공백뿐인 carry 는 빈 배열");
  assert.deepEqual(flushJsonlCarry('  {"z":1} '), ['  {"z":1} ']);
  ok("flush: 내용이 있는 carry 는 원문 그대로 한 줄로 낸다");
}

// ── 5 전수 성질: 모든 (i, j) 두 지점 분할 + 빈 조각 삽입 ──
const SRC = '{"msg":"안녕 세계"}\n\n{"e":"😀 emoji 🚀"}\n   \n{"k":"ascii only"}\n  {"공백":" 유지 "}  \n한\n';
const EXPECT = nonBlank(SRC);
{
  let cases = 0;
  for (let i = 0; i <= SRC.length; i++) {
    for (let j = i; j <= SRC.length; j++) {
      const chunks = [SRC.slice(0, i), SRC.slice(i, j), SRC.slice(j)];
      const { lines, carry } = feed(chunks);
      assert.deepEqual(lines, EXPECT, `분할 (${i},${j})`);
      assert.equal(carry, "", `분할 (${i},${j}) 마지막 carry`);
      cases += 1;
    }
  }
  assert.ok(cases > 1000);
  ok(`원문을 두 지점 전수(${cases}가지, 빈 조각·서로게이트 중간 포함)로 잘라도 줄 목록이 원문과 같다`);
}

// ── 5 시드 고정 무작위 다지점 분할 ──
{
  let seed = 20261012;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let t = 0; t < 500; t++) {
    const k = Math.floor(rnd() * 12);
    const cuts = Array.from({ length: k }, () => Math.floor(rnd() * (SRC.length + 1))).sort((a, b) => a - b);
    const chunks = [];
    let prev = 0;
    for (const c of cuts) {
      chunks.push(SRC.slice(prev, c));
      prev = c;
    }
    chunks.push(SRC.slice(prev));
    const { lines, carry } = feed(chunks);
    assert.deepEqual(lines, EXPECT, `시드 시행 ${t}`);
    assert.equal(carry, "");
  }
  ok("시드 고정 무작위 다지점 분할 500회도 원문의 비어 있지 않은 줄과 같다");
}

// ── 5 한 글자씩 ──
{
  const { lines, carry } = feed([...SRC]);
  assert.deepEqual(lines, EXPECT);
  assert.equal(carry, "");
  ok("한 글자(코드포인트)씩 넣어도 줄 목록이 원문과 같다");
}

// ── 7 마지막 줄에 개행이 없는 원문 ──
{
  const src = SRC + '{"last":"개행 없음 😀"}';
  const expect = nonBlank(src);
  let cases = 0;
  for (let i = 0; i <= src.length; i++) {
    for (let j = i; j <= src.length; j++) {
      const { lines, carry } = feed([src.slice(0, i), src.slice(i, j), src.slice(j)]);
      assert.deepEqual([...lines, ...flushJsonlCarry(carry)], expect, `분할 (${i},${j})`);
      cases += 1;
    }
  }
  ok(`마지막 줄 개행 없음: 전수(${cases}가지) 분할 뒤 flush 를 더하면 원문의 비어 있지 않은 줄 전부와 같다`);
}

console.log(`\n${n} passed`);

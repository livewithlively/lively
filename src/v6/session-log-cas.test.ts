// offset-CAS 판정(#905 C1) 단위검증 — casVerdict 는 순수 함수라 DB 없이 경계까지 못박는다.
//  실행: npm run build && node dist/v6/session-log-cas.test.js
//  ⚠ DB 를 타는 append 자체(원자적 CAS·동시성)는 throwaway pg 통합검증(session-log-store.itest.mjs, docker)이 본다.
//    여기선 "어떤 offset·길이가 어떤 판정인가"의 경계 의미만 — 계약 기준(구현 분기 순서와 무관).
import assert from "node:assert/strict";
import { casVerdict, encodeChunk, decodeChunk } from "./session-log-store.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

// 계약:
//  append    = 정확히 이어짐 (atOffset == current)
//  gap       = 사이가 빔      (atOffset > current)      — 조금이라도 앞서면 gap
//  duplicate = 이미 다 가짐   (atOffset + len <= current) — 경계 포함(끝이 current 에 딱 닿아도 중복)
//  overlap   = 꼬리가 겹침    (atOffset < current < atOffset + len)

// ── append: 정확히 이어질 때만 ──
{
  assert.equal(casVerdict(0, 0, 5), "append", "빈 로그에 0부터 = append");
  assert.equal(casVerdict(10, 10, 5), "append", "워터마크에 정확히 이어짐 = append");
  assert.equal(casVerdict(10, 10, 0), "append", "길이 0 이라도 offset 이 워터마크면 append(하트비트)");
  ok("append — atOffset == current 일 때만");
}

// ── gap: 조금이라도 앞서면 ──
{
  assert.equal(casVerdict(10, 11, 5), "gap", "1 이라도 앞서면 gap");
  assert.equal(casVerdict(0, 1, 5), "gap");
  assert.equal(casVerdict(10, 11, 0), "gap", "길이 0 이라도 앞서면 gap");
  ok("gap — atOffset > current");
}

// ── duplicate: 끝이 current 이하(경계 포함) ──
{
  assert.equal(casVerdict(10, 0, 10), "duplicate", "0..10 을 이미 다 가짐");
  assert.equal(casVerdict(10, 5, 5), "duplicate", "끝(5+5=10)이 워터마크에 딱 닿음 = 중복(경계)");
  assert.equal(casVerdict(10, 9, 1), "duplicate", "마지막 1바이트 재전송 = 중복");
  assert.equal(casVerdict(10, 3, 0), "duplicate", "길이 0 이고 뒤쪽 offset = 중복(할 일 없음)");
  ok("duplicate — atOffset + len <= current (경계 포함)");
}

// ── overlap: 시작은 이전인데 끝이 워터마크를 넘음 ──
{
  assert.equal(casVerdict(10, 5, 6), "overlap", "5..11 — 꼬리(11)가 워터마크(10) 넘음");
  assert.equal(casVerdict(10, 9, 2), "overlap", "9..11 — 1바이트 겹치고 1바이트 새것");
  assert.equal(casVerdict(11, 0, 12), "overlap", "0..12 — 앞은 다 겹치고 끝만 새것");
  ok("overlap — atOffset < current < atOffset + len");
}

// ── 경계 인접값들이 서로 안 새는지(off-by-one 방지) ──
{
  // current=10 고정, atOffset 을 8→12 로 밀며 len=3 일 때 판정 전이
  assert.equal(casVerdict(10, 7, 3), "duplicate", "7..10 끝이 딱 닿음 = 중복");
  assert.equal(casVerdict(10, 8, 3), "overlap",   "8..11 넘음 = overlap");
  assert.equal(casVerdict(10, 9, 3), "overlap",   "9..12 = overlap");
  assert.equal(casVerdict(10, 10, 3), "append",   "10..13 정확히 이어짐 = append");
  assert.equal(casVerdict(10, 11, 3), "gap",      "11.. 앞섬 = gap");
  ok("경계 전이 duplicate→overlap→append→gap 이 off-by-one 없이 갈린다");
}

// ── 무손실 압축 코덱(#905 슬②) — encode/decode 왕복은 항상 원본, 큰 것만 압축 ──
{
  const big = Buffer.from("가나다라마바사 ".repeat(300), "utf8");   // >512B, 압축성
  const enc = encodeChunk(big);
  assert.equal(enc.codec, "zstd", "큰 압축성 페이로드 → zstd");
  assert.ok(enc.data.length < big.length, "실제로 줄어든다");
  assert.ok(decodeChunk(enc.data, enc.codec).equals(big), "🔑 decode(encode)=원본(무손실 왕복)");

  const small = Buffer.from("hi", "utf8");                          // <512B
  const encS = encodeChunk(small);
  assert.equal(encS.codec, null, "작은 청크는 압축 안 함(codec null)");
  assert.ok(encS.data.equals(small), "작은 청크는 원본 그대로");
  assert.ok(decodeChunk(encS.data, encS.codec).equals(small), "작은 청크 왕복=원본");

  const encRaw = encodeChunk(big, "raw");
  assert.equal(encRaw.codec, null, "store=raw 는 크더라도 압축 안 함");
  assert.ok(encRaw.data.equals(big), "raw 모드는 원본 그대로");

  // 바이너리/유니코드 왕복 무손실
  const bin = Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 256));
  const encB = encodeChunk(bin);
  assert.ok(decodeChunk(encB.data, encB.codec).equals(bin), "바이너리도 왕복 무손실");
  assert.ok(decodeChunk(Buffer.from("x"), null).equals(Buffer.from("x")), "codec null → 그대로 반환");
  ok("압축 코덱 — 왕복 무손실 · 큰 것만 zstd · 작은/raw 는 원본 · 바이너리 안전");
}

console.log(`\n${pass} passed`);

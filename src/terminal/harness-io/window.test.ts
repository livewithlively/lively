// 줄 경계 창(window.ts) — 사양 §B 표 전수 (#1746). reader 는 메모리 버퍼(파일·DB 무관 순수 검증).
import assert from "node:assert/strict";
import { readAlignedWindow, type ByteReader } from "./window.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const mem = (s: string | Buffer): { reader: ByteReader; size: number; buf: Buffer; reads: Array<[number, number]> } => {
  const buf = Buffer.isBuffer(s) ? s : Buffer.from(s, "utf8");
  const reads: Array<[number, number]> = [];
  return { buf, size: buf.length, reads, reader: { async read(a, b) { reads.push([a, b]); return buf.subarray(Math.max(0, a), Math.min(buf.length, b)); } } };
};
const L1 = '{"n":1}\n', L2 = '{"n":2}\n', L3 = '{"n":3}\n';   // 각 8바이트

await t("[B1] 전문(0..size), 개행으로 끝남 → 그대로", async () => {
  const m = mem(L1 + L2 + L3);
  const w = await readAlignedWindow(m.reader, m.size, 0, m.size, false);
  assert.deepEqual([w.from, w.to, w.data.toString()], [0, 24, L1 + L2 + L3]);
});
await t("[B2] 전문인데 마지막 줄 반쪽(쓰는 중) → 마지막 개행까지 줄여 준다", async () => {
  const m = mem(L1 + L2 + '{"n":3');
  const w = await readAlignedWindow(m.reader, m.size, 0, m.size, false);
  assert.deepEqual([w.from, w.to, w.data.toString()], [0, 16, L1 + L2]);
});
await t("[B3] start 가 줄 중간 → 다음 개행 뒤로 밀린다 · [B4] start 가 줄 시작(앞이 개행)이면 안 밀린다", async () => {
  const m = mem(L1 + L2 + L3);
  const a = await readAlignedWindow(m.reader, m.size, 3, m.size, false);
  assert.deepEqual([a.from, a.to, a.data.toString()], [8, 24, L2 + L3]);
  const b = await readAlignedWindow(m.reader, m.size, 8, m.size, false);
  assert.deepEqual([b.from, b.to, b.data.toString()], [8, 24, L2 + L3]);
});
await t("[B5] end 가 줄 중간 + extendEnd=false → 마지막 개행까지 줄여 준다", async () => {
  const m = mem(L1 + L2 + L3);
  const w = await readAlignedWindow(m.reader, m.size, 0, 12, false);
  assert.deepEqual([w.from, w.to, w.data.toString()], [0, 8, L1]);
});
await t("[B6] end 가 줄 중간 + extendEnd=true, 뒤에 개행 있음 → 다음 개행까지 늘려 준다(to > end)", async () => {
  const m = mem(L1 + L2 + L3);
  const w = await readAlignedWindow(m.reader, m.size, 0, 12, true);
  assert.deepEqual([w.from, w.to, w.data.toString()], [0, 16, L1 + L2]);
});
await t("[B7] end 가 줄 중간 + extendEnd=true 인데 파일 끝까지 개행 없음 → 마지막 개행까지 줄여 준다", async () => {
  const m = mem(L1 + L2 + '{"n":3');
  const w = await readAlignedWindow(m.reader, m.size, 0, 20, true);
  assert.deepEqual([w.from, w.to, w.data.toString()], [0, 16, L1 + L2]);
});
await t("[B8] 창 안에 온전한 줄이 없음(한 줄 중간만) → 빈 창(from==to), 데이터 없음", async () => {
  const m = mem(L1 + L2 + L3);
  const w = await readAlignedWindow(m.reader, m.size, 9, 14, false);
  assert.equal(w.data.length, 0); assert.equal(w.from, w.to);
});
await t("[B9] start 정렬이 end 를 넘김(요청 창이 한 줄 내부, extendEnd=true) → 빈 창, 아래 창의 줄을 안 가져온다", async () => {
  const m = mem(L1 + L2 + L3);
  const w = await readAlignedWindow(m.reader, m.size, 9, 15, true);   // L2 내부 — L3 를 가져오면 안 된다(아래 창이 이미 그린 줄)
  assert.equal(w.data.length, 0); assert.ok(w.to <= 15);
});
await t("[B10] end<=start · size 0 → 빈 창", async () => {
  const m = mem(L1 + L2);
  const a = await readAlignedWindow(m.reader, m.size, 16, 16, false); assert.equal(a.data.length, 0);
  const b = await readAlignedWindow(m.reader, m.size, 10, 5, false); assert.equal(b.data.length, 0);
  const z = mem(""); const c = await readAlignedWindow(z.reader, 0, 0, 0, false); assert.equal(c.data.length, 0);
});
await t("[B11] 이음새 — 꼬리 창 [X,size) 와 위 창 [X-W,X)(extendEnd) 를 붙이면 줄 중복·누락 0", async () => {
  const lines = Array.from({ length: 40 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(i * 3) }) + "\n");
  const m = mem(lines.join(""));
  const tail = 200;
  const w1 = await readAlignedWindow(m.reader, m.size, m.size - tail, m.size, false);        // 첫 로드(tail) — 시작이 줄 중간
  assert.ok(w1.from > m.size - tail, "시작이 다음 줄로 밀렸다");
  const w0 = await readAlignedWindow(m.reader, m.size, Math.max(0, w1.from - 300), w1.from, true);   // 위로 — 끝은 이미 줄 경계
  assert.equal(w0.to, w1.from, "위 창의 끝 == 꼬리 창의 시작");
  const joined = Buffer.concat([w0.data, w1.data]).toString();
  assert.equal(joined, m.buf.subarray(w0.from, m.size).toString(), "붙이면 원문 그대로");
  const seen = joined.split("\n").filter(Boolean).map((l) => JSON.parse(l).i);
  assert.deepEqual(seen, seen.slice().sort((a, b) => a - b), "순서 유지");
  assert.equal(new Set(seen).size, seen.length, "중복 없음");
  assert.equal(seen[seen.length - 1], 39, "마지막 줄까지");
});
await t("[B12] 아주 긴 줄(64KB 초과)이 창 시작 앞에 걸려도 개행을 찾아 정렬한다(짧게 끊지 않는다)", async () => {
  const big = JSON.stringify({ big: "y".repeat(200_000) }) + "\n";
  const m = mem(big + L1 + L2);
  const w = await readAlignedWindow(m.reader, m.size, 10, 20, true);   // big 줄 내부에서 시작, end 도 그 안 — 온전한 줄이 없다
  assert.equal(w.data.length, 0);
  const w2 = await readAlignedWindow(m.reader, m.size, 10, m.size, false);   // 끝이 파일 끝 — big 을 건너뛰고 L1·L2
  assert.deepEqual([w2.from, w2.to, w2.data.toString()], [big.length, m.size, L1 + L2]);
});

console.log(`harness-io/window: ${pass} passed`);

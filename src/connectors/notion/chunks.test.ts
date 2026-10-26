// 노션 묶음 방출(#5012) — 받은 만큼 바로 내보내야 끊겨도 남는다. 사양 표 B1~B5.
//  실행: npm run build && node dist/connectors/notion/chunks.test.js
//  관찰 축: 처리·방출의 **순서 기록**. «첫 묶음의 항목이 둘째 묶음 처리보다 먼저 나왔나» 가 이 변경의 존재 이유다.
import assert from "node:assert/strict";
import { processInChunks } from "./chunks.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

function harness(n: number, size: number) {
  const events: string[] = [];
  const nodes = Array.from({ length: n }, (_, i) => i);
  const gen = processInChunks(nodes, size,
    async (chunk) => { events.push(`work:${chunk.length}`); },
    async function* (chunk) { for (const x of chunk) { events.push(`emit:${x}`); yield x; } });
  return { events, gen };
}

await t("B1 250개 · 묶음 100 — 처리 100·100·50, 첫 묶음 방출이 둘째 묶음 처리보다 먼저", async () => {
  const { events, gen } = harness(250, 100);
  const out: number[] = [];
  for await (const x of gen) out.push(x);
  assert.equal(out.length, 250);
  assert.deepEqual(events.filter((e) => e.startsWith("work")), ["work:100", "work:100", "work:50"]);
  assert.ok(events.indexOf("emit:99") < events.indexOf("work:100", 1), "첫 묶음이 둘째 묶음 처리 전에 나와야 한다 — 끝에 몰아 내면 끊길 때 0건이 남는다");
  assert.ok(events.indexOf("emit:199") < events.indexOf("work:50"));
});
await t("B2 정확히 배수(200·100) — 묶음 2개, 빈 묶음 없음", async () => {
  const { events, gen } = harness(200, 100);
  for await (const _ of gen) { /* 소진 */ }
  assert.deepEqual(events.filter((e) => e.startsWith("work")), ["work:100", "work:100"]);
});
await t("B3 0개 — 처리도 방출도 없다", async () => {
  const { events, gen } = harness(0, 100);
  for await (const _ of gen) { /* 소진 */ }
  assert.deepEqual(events, []);
});
await t("B4 묶음 크기 0·음수 — 1로 본다(무한 루프 없음)", async () => {
  for (const size of [0, -5]) {
    const { events, gen } = harness(3, size);
    for await (const _ of gen) { /* 소진 */ }
    assert.deepEqual(events.filter((e) => e.startsWith("work")), ["work:1", "work:1", "work:1"]);
  }
});
await t("B5 소비자가 첫 항목 뒤 멈추면 다음 묶음을 처리하지 않는다", async () => {
  const { events, gen } = harness(250, 100);
  for await (const _ of gen) break;
  assert.deepEqual(events.filter((e) => e.startsWith("work")), ["work:100"]);
});
console.log(`\n${pass} passed (notion chunks)`);

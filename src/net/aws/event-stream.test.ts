// AWS 이벤트 흐름 풀기(#4485) 시험 — 사양 표 B(spec-4485.md). 메시지 바이트는 이 시험이 직접 짠다(CRC 는 zlib.crc32 로 — 풀기 코드의 crc 와 따로).
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { decodeEventStream, EVENT_MAX_BYTES, EventStreamError } from "./event-stream.js";

const crc = (b: Buffer): number => ((zlib as unknown as { crc32: (b: Buffer) => number }).crc32(b) >>> 0);

/** 머리 [이름, 형, 값바이트] 들 + 본문 → 메시지(시험이 직접 짠다). */
function msg(headers: Array<[string, number, Buffer]>, payload: Buffer): Buffer {
  const hs = headers.map(([name, type, val]) => {
    const n = Buffer.from(name);
    const fixed = type === 6 || type === 7 ? Buffer.concat([Buffer.from([val.length >> 8, val.length & 0xff]), val]) : val;
    return Buffer.concat([Buffer.from([n.length]), n, Buffer.from([type]), fixed]);
  });
  const hb = Buffer.concat(hs);
  const total = 12 + hb.length + payload.length + 4;
  const pre = Buffer.alloc(8);
  pre.writeUInt32BE(total, 0); pre.writeUInt32BE(hb.length, 4);
  const head = Buffer.concat([pre, Buffer.alloc(4)]);
  head.writeUInt32BE(crc(pre), 8);
  const body = Buffer.concat([head, hb, payload]);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(body), 0);
  return Buffer.concat([body, tail]);
}
const str = (name: string, v: string): [string, number, Buffer] => [name, 7, Buffer.from(v)];
const chunk = (data: string): Buffer => msg([str(":event-type", "PayloadChunk"), str(":message-type", "event")], Buffer.from(data));

async function all(parts: Buffer[]): Promise<Array<{ headers: Record<string, string>; payload: string }>> {
  async function* src(): AsyncGenerator<Uint8Array> { for (const p of parts) yield p; }
  const out: Array<{ headers: Record<string, string>; payload: string }> = [];
  for await (const m of decodeEventStream(src())) out.push({ headers: m.headers, payload: m.payload.toString() });
  return out;
}
const rejects = async (parts: Buffer[], re: RegExp): Promise<void> => {
  await assert.rejects(all(parts), (e: unknown) => e instanceof EventStreamError && re.test((e as Error).message));
};

test("B1 메시지 하나 · 여러 개가 한 조각에 — 차례로 · 머리 · 본문", async () => {
  const a = chunk("hello"), b = chunk("world");
  const c = msg([str(":event-type", "InvokeComplete")], Buffer.from("{}"));
  const got = await all([Buffer.concat([a, b, c])]);
  assert.deepEqual(got.map((m) => [m.headers[":event-type"], m.payload]), [["PayloadChunk", "hello"], ["PayloadChunk", "world"], ["InvokeComplete", "{}"]]);
  assert.equal(got[0]!.headers[":message-type"], "event");
});

test("B2 1바이트씩 쪼개 와도 같은 결과", async () => {
  const whole = Buffer.concat([chunk("한글 조각"), chunk("x".repeat(3000))]);
  const bytes = [...whole].map((b) => Buffer.from([b]));
  const got = await all(bytes);
  assert.deepEqual(got.map((m) => m.payload), ["한글 조각", "x".repeat(3000)]);
});

test("B3 CRC — 앞머리 CRC 가 틀리면 · 메시지 CRC 가 틀리면 던진다", async () => {
  const m = chunk("abc");
  const badPre = Buffer.from(m); badPre[9] = badPre[9]! ^ 0xff;
  await rejects([badPre], /앞머리 CRC/);
  const badMsg = Buffer.from(m); badMsg[badMsg.length - 6] = badMsg[badMsg.length - 6]! ^ 0x01;   // 본문 한 바이트
  await rejects([badMsg], /메시지 CRC/);
});

test("B4 흐름이 메시지 중간에서 끝나면 던진다(잘림을 정상 끝으로 보지 않는다)", async () => {
  const m = chunk("abcdef");
  await rejects([m.subarray(0, m.length - 3)], /중간에서 끝났/);
  await rejects([Buffer.concat([chunk("ok"), m.subarray(0, 5)])], /중간에서 끝났/);
});

test("B5 길이 칸이 상한을 넘거나 · 머리 길이가 전체보다 크면 던진다(본문을 기다리지 않는다)", async () => {
  const pre = Buffer.alloc(12);
  pre.writeUInt32BE(EVENT_MAX_BYTES + 1, 0); pre.writeUInt32BE(0, 4); pre.writeUInt32BE(crc(pre.subarray(0, 8)), 8);
  await rejects([pre], /길이가 맞지 않습니다/);
  const pre2 = Buffer.alloc(12);
  pre2.writeUInt32BE(100, 0); pre2.writeUInt32BE(90, 4); pre2.writeUInt32BE(crc(pre2.subarray(0, 8)), 8);
  await rejects([pre2], /길이가 맞지 않습니다/);
});

test("B6 · B7 빈 흐름은 메시지 0 · 본문 0바이트 메시지는 빈 본문", async () => {
  assert.deepEqual(await all([]), []);
  const got = await all([msg([str(":event-type", "PayloadChunk")], Buffer.alloc(0))]);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.payload, "");
});

test("B8 글자 밖의 머리 값 형(참 · 정수 · 시각 · 바이트열)은 건너뛰고 다음 머리를 읽는다", async () => {
  const int32 = Buffer.alloc(4); int32.writeInt32BE(7, 0);
  const ts = Buffer.alloc(8);
  const m = msg([[":flag", 0, Buffer.alloc(0)], [":n", 4, int32], [":ts", 8, ts], [":bin", 6, Buffer.from([1, 2, 3])], str(":event-type", "PayloadChunk")], Buffer.from("x"));
  const got = await all([m]);
  assert.equal(got[0]!.headers[":event-type"], "PayloadChunk");
  assert.equal(got[0]!.headers[":flag"], "true");
  assert.equal(got[0]!.payload, "x");
});

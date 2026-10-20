// AWS 이벤트 흐름(application/vnd.amazon.eventstream) 풀기(#4485 앱 v2-6) — Lambda 흘려 받기(InvokeWithResponseStream)의 응답 틀.
//  메시지 하나 = [전체 길이 4][머리 길이 4][앞머리 CRC32 4][머리들][본문][메시지 CRC32 4](모두 빅엔디언).
//  머리 = [이름 길이 1][이름][값 형 1][값…] — Lambda 가 쓰는 것은 글자(형 7: [길이 2][바이트])뿐이지만 다른 형도 길이만큼 건너뛴다.
//  출처: https://docs.aws.amazon.com/AmazonS3/latest/API/RESTSelectObjectAppendix.html (같은 틀) · Lambda API InvokeWithResponseStream.
//  2026-10-16 실측(시험 함수): :event-type = PayloadChunk(본문 바이트) | InvokeComplete(JSON {ErrorCode?, ErrorDetails?, LogResult?}) ·
//   :message-type = event. 앱이 죽어도 InvokeComplete 에 ErrorCode 가 오지 않았다 — 끝의 기록(LogResult REPORT 줄)이 «Status: error» 를 말한다.
import { crc32 } from "../../util/crc32.js";

export interface EventStreamMessage { headers: Record<string, string>; payload: Buffer }

/** 메시지 하나 상한 — Lambda 의 본문 조각은 작다(실측 수백 바이트~수십 KB). 틀이 깨진 흐름이 메모리를 먹지 않게. */
export const EVENT_MAX_BYTES = 16 * 1024 * 1024;

export class EventStreamError extends Error {
  constructor(message: string) { super(message); this.name = "EventStreamError"; }
}

/** 머리 바이트 → 이름별 값(글자 형만 글자로 · 그 밖은 «(형 n)»). 틀이 깨지면 던진다. */
export function parseHeaders(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let o = 0;
  while (o < buf.length) {
    const nl = buf[o]!;
    if (o + 1 + nl + 1 > buf.length) throw new EventStreamError("머리 이름이 잘렸습니다");
    const name = buf.subarray(o + 1, o + 1 + nl).toString("utf8");
    o += 1 + nl;
    const type = buf[o]!;
    o += 1;
    const fixed: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };   // 참 · 거짓 · 바이트 · 짧은 · 정수 · 긴 · 시각 · UUID
    if (type === 6 || type === 7) {
      if (o + 2 > buf.length) throw new EventStreamError("머리 값 길이가 잘렸습니다");
      const vl = buf.readUInt16BE(o);
      if (o + 2 + vl > buf.length) throw new EventStreamError("머리 값이 잘렸습니다");
      out[name] = type === 7 ? buf.subarray(o + 2, o + 2 + vl).toString("utf8") : `(형 ${type})`;
      o += 2 + vl;
    } else if (type in fixed) {
      if (o + fixed[type]! > buf.length) throw new EventStreamError("머리 값이 잘렸습니다");
      out[name] = type === 0 ? "true" : type === 1 ? "false" : `(형 ${type})`;
      o += fixed[type]!;
    } else {
      throw new EventStreamError(`모르는 머리 값 형 ${type}`);
    }
  }
  return out;
}

/**
 * 바이트 흐름 → 메시지들. CRC 둘(앞머리 · 메시지 전체)을 본다 — 틀리면 던진다(잘못 자른 본문을 사람에게 내보내지 않게).
 *  흐름이 메시지 중간에서 끝나면 던진다(«잘렸다» 를 정상 끝으로 오인하지 않게).
 */
export async function* decodeEventStream(src: AsyncIterable<Uint8Array>): AsyncGenerator<EventStreamMessage> {
  let buf: Buffer = Buffer.alloc(0);
  for await (const chunk of src) {
    buf = buf.length ? Buffer.concat([buf, Buffer.from(chunk)]) : Buffer.from(chunk);
    for (;;) {
      if (buf.length < 12) break;
      const total = buf.readUInt32BE(0), hlen = buf.readUInt32BE(4);
      if (total < 16 || total > EVENT_MAX_BYTES || hlen > total - 16) throw new EventStreamError(`메시지 길이가 맞지 않습니다(전체 ${total} · 머리 ${hlen})`);
      if (crc32(buf.subarray(0, 8)) !== buf.readUInt32BE(8)) throw new EventStreamError("앞머리 CRC 가 맞지 않습니다");
      if (buf.length < total) break;
      if (crc32(buf.subarray(0, total - 4)) !== buf.readUInt32BE(total - 4)) throw new EventStreamError("메시지 CRC 가 맞지 않습니다");
      const headers = parseHeaders(buf.subarray(12, 12 + hlen));
      const payload = Buffer.from(buf.subarray(12 + hlen, total - 4));
      buf = buf.subarray(total);
      yield { headers, payload };
    }
  }
  if (buf.length) throw new EventStreamError(`흐름이 메시지 중간에서 끝났습니다(남은 ${buf.length}바이트)`);
}

/** 시험 · 가짜 Lambda 용 — 글자 머리들 + 본문 → 메시지 바이트. */
export function encodeEventStreamMessage(headers: Record<string, string>, payload: Buffer): Buffer {
  const hs: Buffer[] = [];
  for (const [k, v] of Object.entries(headers)) {
    const name = Buffer.from(k, "utf8"), val = Buffer.from(v, "utf8");
    const h = Buffer.alloc(1 + name.length + 1 + 2 + val.length);
    h[0] = name.length; name.copy(h, 1); h[1 + name.length] = 7; h.writeUInt16BE(val.length, 2 + name.length); val.copy(h, 4 + name.length);
    hs.push(h);
  }
  const hb = Buffer.concat(hs);
  const total = 12 + hb.length + payload.length + 4;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(total, 0); out.writeUInt32BE(hb.length, 4); out.writeUInt32BE(crc32(out.subarray(0, 8)), 8);
  hb.copy(out, 12); payload.copy(out, 12 + hb.length);
  out.writeUInt32BE(crc32(out.subarray(0, total - 4)), total - 4);
  return out;
}

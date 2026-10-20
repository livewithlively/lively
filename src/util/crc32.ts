// CRC-32(IEEE 802.3) — zip 항목 · AWS 이벤트 흐름 메시지가 쓴다(#4485). node 22.2+ 는 zlib.crc32 를 쓰고, 없으면 표로 계산한다.
import zlib from "node:zlib";

const TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();

export function crc32(buf: Buffer): number {
  const z = zlib as unknown as { crc32?: (b: Buffer) => number };
  if (typeof z.crc32 === "function") return z.crc32(buf) >>> 0;
  let c = -1 >>> 0;
  for (let i = 0; i < buf.length; i++) c = (TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ -1) >>> 0;
}

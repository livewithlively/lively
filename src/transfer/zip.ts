// 워크스페이스 간 옮기기(#5458) — 묶음 파일의 압축(zip) 쓰기·읽기.
//
// 왜 직접 쓰나: 코어는 의존성을 늘리지 않는다(package.json 런타임 의존 17개). zip 은 형식이 작고(로컬 헤더 · 중앙 목록 ·
//  끝 레코드 셋) Node 내장 zlib 이 deflate 와 crc32(22.2+)를 주므로 외부 라이브러리 없이 된다.
//
// 쓰기: deflate(방식 8) + 이름은 UTF-8 플래그(일반 목적 비트 11) — 한글 파일 이름이 macOS·Windows 기본 압축 풀기에서 깨지지 않게.
//  ZIP64 는 쓰지 않는다 — 항목 65,535개·4GB 미만만 만든다(올리기 상한이 100MB 라 닿지 않는다). 넘으면 만들지 않고 오류.
//
// 읽기: 받는 쪽에선 **남이 만든 파일**이다. 그래서
//  ① 경로를 믿지 않는다 — 절대경로 · `..` · 역슬래시 · 드라이브 문자 · NUL 이 든 이름은 거절(zip-slip).
//     디스크에 풀지 않고 메모리 Map 으로만 돌려주지만, 이름이 그대로 지식 이름이 되는 경로가 있어 같은 잣대를 건다.
//  ② 압축 폭탄을 막는다 — 항목 수 · 항목별 · 누적 풀린 크기 상한. inflate 의 maxOutputLength 로 실제로 끊는다
//     (선언된 크기는 거짓말일 수 있다 — connectors/ooxml.ts 와 같은 판단).
//  ③ 암호화 항목(일반 목적 비트 0)과 모르는 압축 방식은 거절 — 조용히 빈 내용을 돌려주지 않는다.
//  ④ CRC 를 대조한다 — 잘린·망가진 파일을 «들어갔다» 로 처리하지 않게.
import { deflateRawSync, inflateRawSync, crc32 } from "node:zlib";

export interface ZipEntryInput { path: string; data: Buffer }

export interface ZipLimits {
  /** 항목 수 상한 */
  maxEntries: number;
  /** 항목 하나가 풀린 크기 상한(바이트) */
  maxEntryBytes: number;
  /** 모든 항목이 풀린 크기 합 상한(바이트) */
  maxTotalBytes: number;
}

/** 묶음 읽기 기본 상한 — 지식 본문 전체가 20MB(우리 워크스페이스 실측), 한 건 최대 141KB 인 것에 넉넉한 여유. */
export const BUNDLE_ZIP_LIMITS: ZipLimits = {
  maxEntries: 60_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};

export class ZipFormatError extends Error {}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const FLAG_ENCRYPTED = 0x0001;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MAX_ZIP32 = 0xffffffff;

/** 경로 검사 — 묶음 안 경로는 `폴더/이름.확장자` 꼴의 상대경로만. 통과하면 그대로 돌려준다. */
export function assertSafeEntryPath(p: string): string {
  if (!p || p.length > 512) throw new ZipFormatError(`압축 파일 안 경로가 비었거나 너무 깁니다: ${p.slice(0, 80)}`);
  if (p.includes("\0") || p.includes("\\")) throw new ZipFormatError(`압축 파일 안 경로에 쓸 수 없는 글자가 있습니다: ${p.slice(0, 80)}`);
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw new ZipFormatError(`압축 파일 안 경로가 절대경로입니다: ${p.slice(0, 80)}`);
  if (p.split("/").some((seg) => seg === ".." || seg === ".")) throw new ZipFormatError(`압축 파일 안 경로에 상위 폴더 이동이 있습니다: ${p.slice(0, 80)}`);
  return p;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** 항목들을 zip 한 덩어리로 만든다. 같은 경로가 두 번 오면 오류(뒤 것이 앞 것을 조용히 가리지 않게). */
export function writeZip(entries: readonly ZipEntryInput[], at: Date = new Date()): Buffer {
  if (entries.length > 0xfffe) throw new ZipFormatError(`항목이 너무 많습니다(${entries.length}개) — 나눠서 내보내 주세요`);
  const seen = new Set<string>();
  const { time, date } = dosDateTime(at);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const path = assertSafeEntryPath(e.path);
    if (seen.has(path)) throw new ZipFormatError(`같은 경로가 두 번 들어갔습니다: ${path}`);
    seen.add(path);
    const name = Buffer.from(path, "utf8");
    const crc = crc32(e.data) >>> 0;
    const deflated = deflateRawSync(e.data);
    // 압축이 오히려 커지면(이미 압축된 이진) 그대로 담는다.
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    if (body.length >= MAX_ZIP32 || e.data.length >= MAX_ZIP32 || offset >= MAX_ZIP32) {
      throw new ZipFormatError("묶음이 4GB 를 넘습니다 — 나눠서 내보내 주세요");
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);              // 풀 때 필요한 판
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);              // 덧붙임 칸 길이
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // 만든 곳 = UNIX(3) · 판 2.0 — 권한 비트를 아래 외부 속성에 싣는다
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);            // 덧붙임 칸
    central.writeUInt16LE(0, 32);            // 설명
    central.writeUInt16LE(0, 34);            // 시작 디스크
    central.writeUInt16LE(0, 36);            // 내부 속성
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // 외부 속성 — 일반 파일 rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  if (offset + cd.length >= MAX_ZIP32) throw new ZipFormatError("묶음이 4GB 를 넘습니다 — 나눠서 내보내 주세요");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

/** zip 인가(첫 4바이트가 로컬 헤더 서명) — 비밀번호를 건 묶음과 가르는 데 쓴다. */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === SIG_LOCAL;
}

/** zip 을 메모리에서 푼다. 경로 → 내용. 상한을 넘거나 형식이 어긋나면 ZipFormatError. */
export function readZip(buf: Buffer, limits: ZipLimits = BUNDLE_ZIP_LIMITS): Map<string, Buffer> {
  let end = -1;
  // 끝 레코드를 뒤에서 찾는다(설명 칸이 최대 64KB 붙을 수 있다).
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === SIG_END) { end = i; break; }
  }
  if (end < 0) throw new ZipFormatError("압축 파일 형식이 아닙니다(끝 레코드가 없습니다) — 파일이 잘렸거나 다른 형식입니다");
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdOffset === MAX_ZIP32 || cdSize === MAX_ZIP32) throw new ZipFormatError("ZIP64 형식은 받지 않습니다");
  if (count > limits.maxEntries) throw new ZipFormatError(`항목이 너무 많습니다(${count}개, 상한 ${limits.maxEntries}개)`);
  if (cdOffset + cdSize > end) throw new ZipFormatError("압축 파일의 목록 위치가 어긋납니다 — 파일이 망가졌습니다");

  const out = new Map<string, Buffer>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipFormatError("압축 파일의 목록이 망가졌습니다");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen);
    // UTF-8 플래그가 없어도 우리 묶음은 ASCII·UTF-8 이름뿐이다 — 그대로 UTF-8 로 읽는다.
    const name = rawName.toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; // 폴더 항목 — 내용이 없다
    assertSafeEntryPath(name);
    if (out.has(name)) throw new ZipFormatError(`같은 경로가 두 번 들어 있습니다: ${name}`);
    if (flags & FLAG_ENCRYPTED) throw new ZipFormatError(`암호를 건 압축 항목은 받지 않습니다: ${name}`);
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) throw new ZipFormatError(`모르는 압축 방식(${method})입니다: ${name}`);
    if (usize > limits.maxEntryBytes) throw new ZipFormatError(`항목이 너무 큽니다: ${name}`);

    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOCAL) throw new ZipFormatError(`항목 머리가 망가졌습니다: ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (dataStart + csize > buf.length) throw new ZipFormatError(`항목 내용이 잘렸습니다: ${name}`);
    const raw = buf.subarray(dataStart, dataStart + csize);

    const budget = Math.min(limits.maxEntryBytes, limits.maxTotalBytes - total);
    let data: Buffer;
    if (method === METHOD_STORE) {
      if (raw.length > budget) throw new ZipFormatError(`풀린 크기가 상한을 넘습니다: ${name}`);
      data = Buffer.from(raw);
    } else {
      try {
        // 선언 크기(usize)는 믿지 않는다 — 실제로 풀리는 양을 budget 으로 끊는다.
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, budget) });
      } catch (e) {
        const msg = (e as Error).message || "";
        if (/maxOutputLength|buffer|Cannot create a Buffer/i.test(msg)) throw new ZipFormatError(`풀린 크기가 상한을 넘습니다: ${name}`);
        throw new ZipFormatError(`항목을 풀지 못했습니다(${name}): ${msg}`);
      }
    }
    if (data.length !== usize) throw new ZipFormatError(`항목 크기가 목록과 다릅니다: ${name}`);
    if ((crc32(data) >>> 0) !== crc) throw new ZipFormatError(`항목 내용이 망가졌습니다(CRC 불일치): ${name}`);
    total += data.length;
    if (total > limits.maxTotalBytes) throw new ZipFormatError("풀린 전체 크기가 상한을 넘습니다");
    out.set(name, data);
  }
  return out;
}

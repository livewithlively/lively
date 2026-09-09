// lib/zip.ts — **의존성 0 짜리 최소 ZIP 리더**. 브라우저 내장 `DecompressionStream('deflate-raw')` 만 쓴다.
//
// 왜 직접 쓰나: docx·xlsx·pptx·hwpx·odt·epub 은 전부 «XML 이 든 zip» 이다. 그 한 겹만 벗기면 우리 손으로
//  그릴 수 있는데, 그걸 위해 mammoth(1.2MB)·SheetJS(900KB)를 벤더에 얹으면 **미리보기 하나 보자고**
//  받는 바이트가 문서 자체보다 커진다. 중앙 디렉터리를 읽고 필요한 항목만 푸는 데엔 이 정도면 충분하다.
//
// leaf 규약: 아무것도 import 하지 않는다(문자열·바이트만 다룬다 — DOM 도 안 딛는다).
//  그래서 node 에서도 그대로 돌아간다(DecompressionStream 은 node 18+ 전역) — 실물 파일로 검증할 수 있다.

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CDIR = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** 한 항목을 풀었을 때의 상한 — 압축폭탄(1KB → 4GB)이 탭을 통째로 얼리는 것을 막는다. */
const MAX_INFLATE = 64 * 1024 * 1024;
/** 중앙 디렉터리에서 읽어 들일 항목 수 상한 — 수십만 개짜리 아카이브의 목록을 그리다 멈추지 않게. */
const MAX_ENTRIES = 20000;

export interface ZipEntry {
  /** 아카이브 안 경로(`word/document.xml`). */
  name: string;
  /** 푼 크기(바이트). */
  size: number;
  /** 압축된 크기(바이트). */
  csize: number;
  /** 0=저장 8=deflate. 그 외는 우리가 못 푼다. */
  method: number;
  /** 로컬 헤더 오프셋. */
  offset: number;
  /** 폴더 항목인가(이름이 / 로 끝난다). */
  dir: boolean;
  /** 수정 시각(있으면) — DOS 시각을 푼 것. */
  mtime: number | null;
}

export interface ZipFile {
  entries: ZipEntry[];
  has: (name: string) => boolean;
  /** 이름으로 한 항목을 푼다. 없거나 못 푸는 방식이면 null. */
  bytes: (name: string) => Promise<Uint8Array | null>;
  /** 이름으로 한 항목을 UTF-8 글자로 푼다. */
  text: (name: string) => Promise<string | null>;
  /** 정규식에 맞는 항목 이름들(디렉터리 제외). */
  match: (re: RegExp) => string[];
}

function u16(v: DataView, p: number): number { return v.getUint16(p, true); }
function u32(v: DataView, p: number): number { return v.getUint32(p, true); }
function u64(v: DataView, p: number): number {
  // ZIP64 필드는 8바이트지만 우리가 다루는 크기는 2^53 을 넘지 않는다 — 상위 4바이트를 곱해 합친다.
  return u32(v, p) + u32(v, p + 4) * 4294967296;
}

/** DOS 날짜·시각 → epoch ms. 0 이면 null(시각을 안 적은 아카이브). */
function dosTime(date: number, time: number): number | null {
  if (!date) return null;
  const y = 1980 + ((date >> 9) & 0x7f), mo = ((date >> 5) & 0x0f) - 1, d = date & 0x1f;
  const h = (time >> 11) & 0x1f, mi = (time >> 5) & 0x3f, s = (time & 0x1f) * 2;
  const t = new Date(y, mo, d, h, mi, s).getTime();
  return Number.isFinite(t) ? t : null;
}

const utf8 = new TextDecoder('utf-8');
/** 항목 이름 — UTF-8 플래그(비트 11)가 서면 UTF-8, 아니면 원래 CP437 이지만 요즘 아카이브는 대개 UTF-8 이다.
 *  둘 다 아니면 글자가 깨지는데, 그건 **이름만** 깨지는 문제라 목록을 못 그릴 이유는 되지 않는다. */
function entryName(raw: Uint8Array): string { return utf8.decode(raw); }

/** ZIP64 앵커까지 따라가 중앙 디렉터리의 (시작, 개수)를 찾는다. 못 찾으면 null. */
function findCentral(v: DataView, len: number): { off: number; n: number } | null {
  //  EOCD 는 파일 끝에 있고 주석(최대 64KB)이 뒤에 붙을 수 있어 뒤에서부터 훑는다.
  const from = Math.max(0, len - 66000);
  let eocd = -1;
  for (let p = len - 22; p >= from; p--) if (u32(v, p) === SIG_EOCD) { eocd = p; break; }
  if (eocd < 0) return null;
  let n = u16(v, eocd + 10);
  let off = u32(v, eocd + 16);
  //  0xFFFF/0xFFFFFFFF 는 «ZIP64 를 보라» 는 표식이다 — 로케이터를 거쳐 진짜 값을 읽는다.
  if (n === 0xffff || off === 0xffffffff) {
    const locP = eocd - 20;
    if (locP >= 0 && u32(v, locP) === SIG_EOCD64_LOC) {
      const z = u64(v, locP + 8);
      if (z >= 0 && z + 56 <= len && u32(v, z) === SIG_EOCD64) { n = u64(v, z + 32); off = u64(v, z + 48); }
    }
  }
  if (!(off >= 0) || off >= len) return null;
  return { off, n: Math.min(n, MAX_ENTRIES) };
}

/** ZIP64 확장 필드에서 진짜 크기·오프셋을 꺼낸다(중앙 디렉터리 값이 0xFFFFFFFF 인 것만 대체된다). */
function zip64Extra(v: DataView, p: number, extraLen: number, want: { size: boolean; csize: boolean; off: boolean }):
{ size?: number; csize?: number; off?: number } {
  const out: { size?: number; csize?: number; off?: number } = {};
  let q = p;
  const end = p + extraLen;
  while (q + 4 <= end) {
    const id = u16(v, q), sz = u16(v, q + 2);
    if (id === 0x0001) {
      let r = q + 4;
      if (want.size && r + 8 <= end) { out.size = u64(v, r); r += 8; }
      if (want.csize && r + 8 <= end) { out.csize = u64(v, r); r += 8; }
      if (want.off && r + 8 <= end) { out.off = u64(v, r); r += 8; }
      break;
    }
    q += 4 + sz;
  }
  return out;
}

/** deflate 를 푼다 — 브라우저·node 공통 내장. 없거나 깨진 데이터면 null(호출자가 아이콘으로 둔다). */
async function inflateRaw(data: Uint8Array, expect: number): Promise<Uint8Array | null> {
  const DS: any = (globalThis as any).DecompressionStream;
  if (typeof DS !== 'function') return null;
  try {
    //  ⚠ Uint8Array 를 그대로 넘기지 말고 **그 뷰만큼**의 사본을 넘긴다 — 뷰가 큰 버퍼의 한 조각이면
    //   구현에 따라 버퍼 전체를 읽어 엉뚱한 바이트를 붙인다.
    const src = data.slice();
    const stream = new Blob([src as BlobPart]).stream().pipeThrough(new DS('deflate-raw'));
    const chunks: Uint8Array[] = [];
    let total = 0;
    const rd = (stream as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      total += value.length;
      if (total > MAX_INFLATE) { void rd.cancel(); return null; }   // 압축폭탄 — 조용히 포기
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    //  크기가 안 맞아도 돌려준다 — 잘린 문서라도 앞부분은 보여 주는 편이 백지보다 낫다.
    return expect && out.length > expect ? out.subarray(0, expect) : out;
  } catch (_) { return null; }
}

/**
 * ZIP 하나를 연다 — 중앙 디렉터리만 읽고 **항목은 요구할 때 푼다**(문서 하나 보자고 media/ 를 다 풀지 않는다).
 * 서명이 없거나 중앙 디렉터리가 깨졌으면 null — 호출자는 "이 형식은 못 연다"로 떨어지면 된다.
 */
export function openZip(buf: ArrayBuffer): ZipFile | null {
  const len = buf.byteLength;
  if (len < 22) return null;
  const v = new DataView(buf);
  const c = findCentral(v, len);
  if (!c) return null;
  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  let p = c.off;
  for (let i = 0; i < c.n && p + 46 <= len; i++) {
    if (u32(v, p) !== SIG_CDIR) break;
    const flags = u16(v, p + 8);
    const method = u16(v, p + 10);
    const time = u16(v, p + 12), date = u16(v, p + 14);
    let csize = u32(v, p + 20);
    let size = u32(v, p + 24);
    const nameLen = u16(v, p + 28), extraLen = u16(v, p + 30), cmtLen = u16(v, p + 32);
    let offset = u32(v, p + 42);
    const nameAt = p + 46;
    if (nameAt + nameLen > len) break;
    const need = { size: size === 0xffffffff, csize: csize === 0xffffffff, off: offset === 0xffffffff };
    if (need.size || need.csize || need.off) {
      const z = zip64Extra(v, nameAt + nameLen, extraLen, need);
      if (z.size !== undefined) size = z.size;
      if (z.csize !== undefined) csize = z.csize;
      if (z.off !== undefined) offset = z.off;
    }
    const name = entryName(new Uint8Array(buf, nameAt, nameLen));
    //  UTF-8 플래그가 없어도 이름은 위에서 UTF-8 로 읽는다 — 판정에 쓰지 않으므로 flags 는 여기까지만 본다.
    void flags;
    const e: ZipEntry = { name, size, csize, method, offset, dir: name.endsWith('/'), mtime: dosTime(date, time) };
    entries.push(e);
    if (!byName.has(name)) byName.set(name, e);
    p = nameAt + nameLen + extraLen + cmtLen;
  }
  if (!entries.length) return null;

  async function bytes(name: string): Promise<Uint8Array | null> {
    const e = byName.get(name);
    if (!e || e.dir) return null;
    //  로컬 헤더의 이름·확장 길이는 중앙 디렉터리와 **다를 수 있다** — 반드시 로컬 헤더에서 다시 읽는다.
    const h = e.offset;
    if (h + 30 > len || u32(v, h) !== SIG_LOCAL) return null;
    const nl = u16(v, h + 26), xl = u16(v, h + 28);
    const at = h + 30 + nl + xl;
    if (at + e.csize > len) return null;
    const raw = new Uint8Array(buf, at, e.csize);
    if (e.method === 0) return raw;
    if (e.method === 8) return await inflateRaw(raw, e.size);
    return null;   // bzip2·lzma 등 — 우리가 못 푼다
  }

  return {
    entries,
    has: (n) => byName.has(n),
    bytes,
    text: async (n) => { const b = await bytes(n); return b ? utf8.decode(b) : null; },
    match: (re) => entries.filter((e) => !e.dir && re.test(e.name)).map((e) => e.name),
  };
}

/** 파일 머리 4바이트가 ZIP 인가 — 확장자를 못 믿을 때(«.hwp 인데 실은 hwpx») 쓰는 판정. */
export function looksZip(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  const v = new DataView(buf);
  const sig = u32(v, 0);
  return sig === SIG_LOCAL || sig === SIG_CDIR || sig === SIG_EOCD;
}

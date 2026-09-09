// connectors/hwp.ts — 한글 .hwp 5.0 **본문 텍스트 추출**(zero-dep). ooxml.ts 와 짝이다.
//
// 왜 필요한가: .hwp 는 오래 `UNREADABLE_EXT` 였다 — 올리면 자료엔 들어가지만 본문이 «읽을 수 없음» 스텁이라
//  검색에도 증류에도 안 걸렸다. 한국 고객에게 이건 «자료를 올렸는데 AI 가 못 읽는다» 로 나타난다.
//  화면 미리보기(#3778)는 파일이 품고 있는 미리보기(PrvText·PrvImage)로 이미 해결했지만, 그건 앞 1000자짜리
//  «맛보기» 라 지식이 되기엔 모자란다. 여기서는 **본문 전체**를 뽑는다.
//
// 구조 두 겹:
//  ① OLE2 복합문서(CFB) — .hwp 는 zip 이 아니라 MS 의 옛 컨테이너다. 스트림 이름으로 바이트를 꺼낸다.
//  ② HWP 레코드 — `BodyText/Section*` 은 (대개) raw-deflate 된 레코드 스트림이고, 글자는
//     `HWPTAG_PARA_TEXT` 레코드에 UTF-16LE 로 들어 있다. 제어문자가 «자리를 몇 칸 먹는지»가 규격의 핵심이다.
//
// 안 하는 것(의도): 표·글상자의 구조 복원, 서식, 각주 위치. 목적은 «무슨 내용인가»를 검색·증류에 태우는 것이다.
//  구버전 .hwp 3.0 이하(비 CFB)와 배포용 암호문서는 못 읽는다 — 그때는 종전대로 스텁으로 떨어진다.
import { inflateRawSync } from "node:zlib";

/** 스트림 하나를 이을 때의 섹터 수 상한 — 손상 파일이 만드는 무한 사슬을 끊는다. */
const MAX_CHAIN = 200_000;
/** 압축 해제 상한(ooxml.ts 와 같은 이유 — 작은 압축본이 GB 로 팽창해 OOM 나는 것을 막는다). */
const MAX_INFLATE_SECTION = 64_000_000;
/** 훑을 구역 수 상한 — 한 문서가 수백 구역이면 앞쪽만으로 충분하다. */
const MAX_SECTIONS = 200;

const CFB_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

export function looksHwp(buf: Buffer): boolean {
  return buf.length >= 512 && CFB_SIG.every((v, i) => buf[i] === v);
}

interface Cfb { read: (name: string) => Buffer | null; names: string[] }

/**
 * OLE2 복합문서에서 스트림을 이름으로 꺼낸다(읽기 전용, 최소 구현).
 *  디렉터리는 레드블랙 트리지만 **선형으로 훑는다** — 우리는 이름으로만 찾으므로 트리를 걸 이유가 없다.
 */
function openCfb(buf: Buffer): Cfb | null {
  if (!looksHwp(buf)) return null;
  const secShift = buf.readUInt16LE(0x1e);
  const miniShift = buf.readUInt16LE(0x20);
  if (secShift < 7 || secShift > 20 || miniShift < 4 || miniShift > 12) return null;
  const secSize = 1 << secShift;
  const miniSize = 1 << miniShift;
  const nFat = buf.readUInt32LE(0x2c);
  const dirStart = buf.readUInt32LE(0x30);
  const miniCutoff = buf.readUInt32LE(0x38);
  const miniFatStart = buf.readUInt32LE(0x3c);
  let difatStart = buf.readUInt32LE(0x44);
  const nDifat = buf.readUInt32LE(0x48);
  const secOff = (n: number): number => (n + 1) * secSize;
  const inRange = (n: number): boolean => n >= 0 && secOff(n) + secSize <= buf.length;

  // FAT — 섹터 사슬표. DIFAT(머리 109개 + 이어지는 DIFAT 섹터)이 FAT 섹터의 자리를 알려준다.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < nFat; i++) {
    const s = buf.readUInt32LE(0x4c + i * 4);
    if (s === FREESECT || s === ENDOFCHAIN) break;
    fatSectors.push(s);
  }
  for (let guard = 0; difatStart !== ENDOFCHAIN && difatStart !== FREESECT && guard < nDifat + 8; guard++) {
    if (!inRange(difatStart)) break;
    const base = secOff(difatStart);
    for (let i = 0; i < secSize / 4 - 1 && fatSectors.length < nFat; i++) {
      const s = buf.readUInt32LE(base + i * 4);
      if (s === FREESECT || s === ENDOFCHAIN) break;
      fatSectors.push(s);
    }
    difatStart = buf.readUInt32LE(base + secSize - 4);
  }
  const fat: number[] = [];
  for (const s of fatSectors) {
    if (!inRange(s)) break;
    const base = secOff(s);
    for (let i = 0; i < secSize / 4; i++) fat.push(buf.readUInt32LE(base + i * 4));
  }
  const nextSec = (n: number): number => (n >= 0 && n < fat.length ? fat[n] : ENDOFCHAIN);

  const miniFat: number[] = [];
  {
    let s = miniFatStart, guard = 0;
    while (s !== ENDOFCHAIN && s !== FREESECT && inRange(s) && guard++ < MAX_CHAIN) {
      const base = secOff(s);
      for (let i = 0; i < secSize / 4; i++) miniFat.push(buf.readUInt32LE(base + i * 4));
      s = nextSec(s);
    }
  }
  const nextMini = (n: number): number => (n >= 0 && n < miniFat.length ? miniFat[n] : ENDOFCHAIN);

  /** 섹터 사슬을 따라가 바이트를 잇는다. `size < 0` 이면 사슬이 끝날 때까지(디렉터리처럼 크기가 안 적힌 것). */
  function chain(start: number, size: number, mini: boolean, miniStream: Buffer | null): Buffer {
    const unit = mini ? miniSize : secSize;
    const secs: number[] = [];
    let s = start, guard = 0;
    while (s !== ENDOFCHAIN && s !== FREESECT && guard++ < MAX_CHAIN) {
      if (!mini && !inRange(s)) break;
      if (mini && (!miniStream || s * miniSize >= miniStream.length)) break;
      secs.push(s);
      if (size >= 0 && secs.length * unit >= size) break;
      s = mini ? nextMini(s) : nextSec(s);
    }
    const want = size >= 0 ? size : secs.length * unit;
    const out = Buffer.alloc(Math.max(0, want));
    let at = 0;
    for (const n of secs) {
      if (at >= want) break;
      const take = Math.min(unit, want - at);
      const from = mini ? n * miniSize : secOff(n);
      const src = mini ? (miniStream as Buffer) : buf;
      src.copy(out, at, from, Math.min(from + take, src.length));
      at += take;
    }
    return out;
  }

  const dir = chain(dirStart, -1, false, null);
  const entries: Array<{ name: string; type: number; start: number; size: number }> = [];
  for (let p = 0; p + 128 <= dir.length; p += 128) {
    const nameLen = dir.readUInt16LE(p + 0x40);
    const type = dir.readUInt8(p + 0x42);
    if (type !== 1 && type !== 2 && type !== 5) continue;
    let name = "";
    for (let i = 0; i + 1 < Math.max(0, nameLen - 2) && i < 62; i += 2) name += String.fromCharCode(dir.readUInt16LE(p + i));
    entries.push({
      name, type,
      start: dir.readUInt32LE(p + 0x74),
      size: dir.readUInt32LE(p + 0x78) + dir.readUInt32LE(p + 0x7c) * 4294967296,
    });
  }
  const root = entries.find((e) => e.type === 5);
  if (!root) return null;
  //  루트 항목이 가리키는 것이 «작은 섹터들이 사는 큰 스트림» 이다 — 4096바이트 미만 스트림은 전부 그 안에 눕는다.
  const miniStream = root.size > 0 ? chain(root.start, root.size, false, null) : null;
  const byName = new Map<string, { start: number; size: number }>();
  for (const e of entries) if (e.type === 2 && e.name) byName.set(e.name.toLowerCase(), { start: e.start, size: e.size });

  return {
    names: entries.filter((e) => e.type === 2).map((e) => e.name),
    read: (name) => {
      const e = byName.get(name.toLowerCase());
      if (!e || !(e.size > 0)) return null;
      return chain(e.start, e.size, e.size < miniCutoff, miniStream);
    },
  };
}

// ── HWP 레코드 ────────────────────────────────────────────────────────────────
const HWPTAG_PARA_TEXT = 0x10 + 51;   // 문단의 글자들이 사는 레코드

/**
 * 문단 글자(UTF-16LE) → 사람이 읽는 글자.
 *  ⚠ 규격의 핵심은 «제어문자가 몇 칸을 먹느냐» 다. 이걸 틀리면 뒤 글자가 통째로 밀려 **문서 전체가 깨진다**:
 *   · 확장/인라인 제어(1~9, 11~12, 14~23) — **8칸**(16바이트)을 통째로 차지한다. 표·그림·각주 자리다.
 *   · 문자 제어(10, 13, 24~31) — 1칸. 10=줄바꿈, 13=문단끝.
 *  그래서 `i += 8` 로 건너뛰지 않고 한 칸씩 읽으면 그 8칸의 쓰레기 값이 글자로 섞여 나온다.
 */
export function decodeHwpParaText(buf: Buffer): string {
  const out: string[] = [];
  const n = Math.floor(buf.length / 2);
  for (let i = 0; i < n; i++) {
    const c = buf.readUInt16LE(i * 2);
    if (c >= 32) { out.push(String.fromCharCode(c)); continue; }
    if (c === 10 || c === 13) { out.push("\n"); continue; }
    if (c === 9) { out.push("\t"); i += 7; continue; }          // 탭도 8칸짜리 인라인 제어다
    if ((c >= 1 && c <= 8) || (c >= 11 && c <= 12) || (c >= 14 && c <= 23)) { i += 7; continue; }
    // 24~31·0 — 1칸짜리 문자 제어. 글자가 아니므로 버린다.
  }
  return out.join("");
}

/** 레코드 스트림을 훑어 PARA_TEXT 만 줍는다. 헤더는 uint32 하나(tag 10bit · level 10bit · size 12bit). */
export function collectParaText(stream: Buffer): string[] {
  const paras: string[] = [];
  let p = 0;
  while (p + 4 <= stream.length) {
    const h = stream.readUInt32LE(p);
    const tag = h & 0x3ff;
    let size = (h >> 20) & 0xfff;
    p += 4;
    //  size 가 0xFFF 면 «12비트에 안 들어간다» 는 표식이고 진짜 길이가 다음 uint32 에 있다.
    if (size === 0xfff) {
      if (p + 4 > stream.length) break;
      size = stream.readUInt32LE(p);
      p += 4;
    }
    if (size < 0 || p + size > stream.length) break;            // 손상 — 여기까지가 우리가 아는 전부
    if (tag === HWPTAG_PARA_TEXT) paras.push(decodeHwpParaText(stream.subarray(p, p + size)));
    p += size;
  }
  return paras;
}

/** FileHeader 의 «본문이 압축돼 있나»(속성 uint32 의 0번 비트). 헤더가 없으면 압축으로 가정하고 둘 다 시도한다. */
function isCompressed(cfb: Cfb): boolean | null {
  const fh = cfb.read("FileHeader");
  if (!fh || fh.length < 40) return null;
  return (fh.readUInt32LE(36) & 1) === 1;
}

/** 압축 여부를 모를 때는 **둘 다 해 본다** — 헤더를 못 읽었다고 본문까지 포기할 이유는 없다. */
function sectionBytes(raw: Buffer, compressed: boolean | null): Buffer | null {
  const tryInflate = (): Buffer | null => {
    try { return inflateRawSync(raw, { maxOutputLength: MAX_INFLATE_SECTION }); } catch { return null; }
  };
  if (compressed === true) return tryInflate();
  if (compressed === false) return raw;
  return tryInflate() ?? raw;
}

/**
 * .hwp 본문 텍스트(순수). 못 읽으면 빈 문자열 — caller 가 스텁으로 떨어뜨린다.
 *  본문이 안 나오면 **한컴이 넣어 둔 `PrvText`(앞부분 미리보기)로 폴백**한다. 반쪽이라도 «무슨 문서인지»는 산다.
 */
export function extractHwp(buf: Buffer): string {
  const cfb = openCfb(buf);
  if (!cfb) return "";
  const compressed = isCompressed(cfb);
  const sections = cfb.names
    .filter((n) => /^BodyText\/Section\d+$/i.test(n) || /^Section\d+$/i.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)?.[1] ?? 0) - Number(/(\d+)/.exec(b)?.[1] ?? 0))
    .slice(0, MAX_SECTIONS);
  const out: string[] = [];
  for (const name of sections) {
    const raw = cfb.read(name);
    if (!raw) continue;
    const data = sectionBytes(raw, compressed);
    if (!data) continue;
    const paras = collectParaText(data).map((s) => s.replace(/\u0000/g, "").trimEnd()).filter(Boolean);
    if (paras.length) out.push(paras.join("\n"));
  }
  const body = out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  if (body) return body;

  //  폴백 — 본문 레코드를 못 읽었을 때. 한컴이 저장 시 만들어 넣는 미리보기 글자(UTF-16LE, 약 1000자).
  const prv = cfb.read("PrvText");
  if (!prv || prv.length < 2) return "";
  const start = prv[0] === 0xff && prv[1] === 0xfe ? 2 : 0;
  let s = "";
  for (let i = start; i + 1 < prv.length; i += 2) s += String.fromCharCode(prv.readUInt16LE(i));
  return s.replace(/\r/g, "\n").replace(/\u0000/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

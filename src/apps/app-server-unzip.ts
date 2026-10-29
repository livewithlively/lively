// 앱 서버 zip 풀기(#4487 앱 v2-8 자가호스팅) — 빌더가 만든 서버 zip · 검사 층 레이어 zip 을 박스의 판 폴더에 푼다.
//
//  ★ 이 함수가 보안 경계다. 서버 zip 은 빌드 컨테이너 안에서 남의 설치 스크립트(npm ci)와 같이 만든 것이고, 그것을 게이트웨이(박스 프로세스)가 푼다.
//   그래서 zip 이 무엇을 적었든:
//   · 경로는 판 폴더 안의 상대 경로만 — 절대 경로 · .. · . · 빈 마디 · 역슬래시 · NUL 은 거절.
//   · 심링크는 판 폴더 안, 또는 /tmp 아래(컨테이너 안에서만 뜻이 있는 자리 — 빌더 규칙과 같다)만 가리킨다.
//   · 심링크 자리 밑의 항목은 거절하고 링크는 맨 끝에 만든다 — 링크를 타고 판 폴더 밖에 쓰지 않는다.
//   · 실제로 풀린 바이트를 센다(선언한 크기를 믿지 않는다) — 항목마다 선언보다 많으면 · 합이 상한을 넘으면 멈춘다(압축 폭탄).
//   · 권한은 755(실행 비트가 있던 파일 · 폴더) · 644 만 — setuid 같은 비트는 옮기지 않는다.
//   · 암호 · 모르는 압축 방식 · 같은 이름 두 번은 거절.
//  다 풀면 한 번에 제자리로 옮긴다(임시 폴더 → rename). 실패하면 임시 폴더를 지운다.
//  형식: PKZIP — 끝 기록(EOCD)에서 중앙 목록을 찾아 그 크기만큼 읽는다(항목 수 칸은 보지 않는다 — 65,535 개 넘는 zip 은 Zip64 끝 기록에 수가 있다 ·
//   빌더 app-server-builder writeZip). 크기 · 위치가 4GB 를 넘는 Zip64 항목은 다루지 않는다(빌더가 만들지 않는다 — 넘으면 거절).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface UnzipLimits {
  /** 풀린 바이트 합 상한. */
  maxBytes: number;
  /** 항목 수 상한. */
  maxEntries: number;
}

export class UnzipRejected extends Error {
  constructor(message: string) { super(`zip 을 풀지 않았습니다 — ${message}`); this.name = "UnzipRejected"; }
}

interface Entry { name: string; kind: "dir" | "file" | "link"; method: number; csize: number; usize: number; offset: number; exec: boolean }

const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFLNK = 0o120000;

/** zip 안 이름 → 판 폴더 안 상대 경로(마디 배열). 틀렸으면 null. */
export function safeEntryPath(name: string): string[] | null {
  if (!name || name.length > 1024 || name.includes("\0") || name.includes("\\") || name.startsWith("/")) return null;
  const segs = name.split("/");
  if (segs[segs.length - 1] === "") segs.pop();   // 폴더의 끝 /
  if (!segs.length || segs.length > 64) return null;
  if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
  return segs;
}

/** 링크가 가리키는 곳이 판 폴더 안(링크 자리에서 본 상대 경로) 또는 /tmp 아래인가. */
export function safeLinkTarget(linkSegs: string[], target: string): boolean {
  if (!target || target.length > 1024 || target.includes("\0")) return false;
  if (target.startsWith("/")) {
    const n = path.posix.normalize(target);
    return n === "/tmp" || n.startsWith("/tmp/");
  }
  const joined = path.posix.normalize(path.posix.join(...linkSegs.slice(0, -1), target));
  return joined !== ".." && !joined.startsWith("../") && !path.posix.isAbsolute(joined);
}

async function readAt(fh: fsp.FileHandle, pos: number, len: number): Promise<Buffer> {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(b, got, len - got, pos + got);
    if (!bytesRead) throw new UnzipRejected("zip 이 중간에 끝납니다");
    got += bytesRead;
  }
  return b;
}

/** 중앙 목록을 읽는다(풀기 전 검사 — 경로 · 종류 · 크기 · 방식). */
async function readCentral(fh: fsp.FileHandle, size: number, limits: UnzipLimits): Promise<Entry[]> {
  const tailLen = Math.min(size, 65_535 + 22);
  const tail = await readAt(fh, size - tailLen, tailLen);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { at = i; break; }
  if (at < 0) throw new UnzipRejected("zip 끝 기록을 찾지 못했습니다");
  const cdSize = tail.readUInt32LE(at + 12), cdAt = tail.readUInt32LE(at + 16);
  if (cdSize === 0xffffffff || cdAt === 0xffffffff || cdAt + cdSize > size) throw new UnzipRejected("중앙 목록 자리가 틀렸습니다");
  if (cdSize > 64 * 1024 * 1024) throw new UnzipRejected("중앙 목록이 너무 큽니다");
  const cd = await readAt(fh, cdAt, cdSize);
  const out: Entry[] = [];
  const names = new Set<string>();
  let declared = 0;
  for (let p = 0; p < cd.length;) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new UnzipRejected("중앙 목록 항목 모양이 틀렸습니다");
    const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
    const csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    const ext = cd.readUInt32LE(p + 38) >>> 0, offset = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen > cd.length) throw new UnzipRejected("중앙 목록 이름이 잘렸습니다");
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw new UnzipRejected(`암호가 걸린 항목입니다: ${name.slice(0, 120)}`);
    if (method !== 0 && method !== 8) throw new UnzipRejected(`모르는 압축 방식(${method})입니다: ${name.slice(0, 120)}`);
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw new UnzipRejected(`4GB 를 넘는 항목입니다: ${name.slice(0, 120)}`);
    const segs = safeEntryPath(name);
    if (!segs) throw new UnzipRejected(`판 폴더 밖을 가리키는 경로입니다: ${name.slice(0, 120)}`);
    const key = segs.join("/");
    if (names.has(key)) throw new UnzipRejected(`같은 이름이 두 번 있습니다: ${key.slice(0, 120)}`);
    names.add(key);
    const mode = ext >>> 16, ftype = mode & S_IFMT;
    const kind: Entry["kind"] = name.endsWith("/") || ftype === S_IFDIR ? "dir" : ftype === S_IFLNK ? "link" : "file";
    if (kind === "link") {
      //  링크 대상은 짧다(경로 하나) — 풀린 크기(usize)뿐 아니라 실린 크기(csize)도 막는다. 안 막으면 큰 csize 링크 하나로 풀기 전에 그만큼 메모리를 먼저 잡는다.
      if (usize > 1024) throw new UnzipRejected(`링크 대상이 너무 깁니다: ${key.slice(0, 120)}`);
      if (csize > 4096) throw new UnzipRejected(`링크 항목이 너무 큽니다: ${key.slice(0, 120)}`);
      if (method === 0 && csize !== usize) throw new UnzipRejected(`링크 항목 크기가 어긋납니다: ${key.slice(0, 120)}`);
    }
    declared += usize;
    out.push({ name: key, kind, method, csize, usize, offset, exec: (mode & 0o111) !== 0 });
    if (out.length > limits.maxEntries) throw new UnzipRejected(`항목이 너무 많습니다(상한 ${limits.maxEntries})`);
    if (declared > limits.maxBytes) throw new UnzipRejected(`풀린 크기가 상한(${Math.round(limits.maxBytes / 1048576)}MB)을 넘습니다`);
  }
  //  링크 자리 밑의 항목 — 링크를 먼저 만들든 나중에 만들든 그 밑에 쓰면 링크를 탄다. 거절한다.
  const links = new Set(out.filter((e) => e.kind === "link").map((e) => e.name));
  if (links.size) {
    for (const e of out) {
      const segs = e.name.split("/");
      for (let k = 1; k < segs.length; k++) if (links.has(segs.slice(0, k).join("/"))) throw new UnzipRejected(`링크 밑의 항목입니다: ${e.name.slice(0, 120)}`);
    }
  }
  return out;
}

/** 항목의 데이터가 시작하는 자리(로컬 머리 뒤). */
async function dataStart(fh: fsp.FileHandle, e: Entry, size: number): Promise<number> {
  const h = await readAt(fh, e.offset, 30);
  if (h.readUInt32LE(0) !== 0x04034b50) throw new UnzipRejected(`항목 머리 모양이 틀렸습니다: ${e.name.slice(0, 120)}`);
  const start = e.offset + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  if (start + e.csize > size) throw new UnzipRejected(`항목이 zip 밖까지 이어집니다: ${e.name.slice(0, 120)}`);
  return start;
}

/**
 * zip 을 dest 에 푼다 — dest 는 아직 없어야 한다(임시 폴더에 풀고 끝에 옮긴다). 돌려주는 것은 항목 수 · 풀린 바이트 합.
 *  어긋나면 UnzipRejected(무엇이 틀렸는지) — 그 밖(디스크 · 권한)은 그대로 던진다.
 */
export async function unzipTo(zipFile: string, dest: string, limits: UnzipLimits): Promise<{ entries: number; bytes: number }> {
  if (fs.existsSync(dest)) throw new Error(`풀 자리가 이미 있습니다: ${dest}`);
  const tmp = `${dest}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  const fh = await fsp.open(zipFile, "r");
  let total = 0;
  try {
    const size = (await fh.stat()).size;
    const entries = await readCentral(fh, size, limits);
    await fsp.mkdir(tmp, { recursive: false, mode: 0o755 });
    const abs = (name: string): string => path.join(tmp, ...name.split("/"));
    //  ① 폴더 ② 파일 ③ 링크 — 링크는 맨 끝(그 밑의 항목은 위에서 거절했다).
    for (const e of entries.filter((x) => x.kind === "dir")) await fsp.mkdir(abs(e.name), { recursive: true, mode: 0o755 });
    for (const e of entries.filter((x) => x.kind === "file")) {
      const to = abs(e.name);
      await fsp.mkdir(path.dirname(to), { recursive: true, mode: 0o755 });
      const start = await dataStart(fh, e, size);
      let wrote = 0;
      const count = new Transform({
        transform(chunk: Buffer, _enc, done) {
          wrote += chunk.length;
          total += chunk.length;
          if (wrote > e.usize) return done(new UnzipRejected(`항목이 선언한 크기보다 큽니다: ${e.name.slice(0, 120)}`));
          if (total > limits.maxBytes) return done(new UnzipRejected(`풀린 크기가 상한(${Math.round(limits.maxBytes / 1048576)}MB)을 넘습니다`));
          done(null, chunk);
        },
      });
      const out = fs.createWriteStream(to, { flags: "wx", mode: e.exec ? 0o755 : 0o644 });
      if (e.csize === 0) { await new Promise<void>((ok, bad) => { out.on("error", bad); out.end(ok); }); }
      else {
        const src = fs.createReadStream(zipFile, { start, end: start + e.csize - 1 });
        if (e.method === 8) await pipeline(src, zlib.createInflateRaw(), count, out);
        else await pipeline(src, count, out);
      }
      if (wrote !== e.usize) throw new UnzipRejected(`항목 크기가 선언과 다릅니다(${wrote} ≠ ${e.usize}): ${e.name.slice(0, 120)}`);
      //  만들 때 준 권한은 umask 를 탄다 — 정해진 값으로 다시 맞춘다.
      await fsp.chmod(to, e.exec ? 0o755 : 0o644);
    }
    //  링크를 만드는 동안엔 앞서 만든 링크가 있다 — 대소문자 · 유니코드 꼴을 가리지 않는 디스크(맥 APFS)에선 «L1» 링크와 «l1/x» 가 같은 자리라
    //   위의 글자 비교를 지나 링크를 타고 밖에 만들 수 있다. 그래서 폴더를 만들기 전에 가장 가까운 있는 윗자리의 실제 경로가 판 폴더 안인지 본다.
    const tmpReal = await fsp.realpath(tmp);
    for (const e of entries.filter((x) => x.kind === "link")) {
      const start = await dataStart(fh, e, size);
      const raw = await readAt(fh, start, e.csize);
      //  압축 링크(csize 는 작아도 풀면 클 수 있다) — 4096 을 넘으면 inflateRawSync 가 RangeError 를 던진다. 거절 꼴(UnzipRejected)로 바꿔 부르는 쪽이 400 으로 받게 한다.
      let target: string;
      try { target = (e.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: 4096 }) : raw).toString("utf8"); }
      catch { throw new UnzipRejected(`링크 대상이 너무 깁니다: ${e.name.slice(0, 120)}`); }
      if (!safeLinkTarget(e.name.split("/"), target)) throw new UnzipRejected(`판 폴더 밖을 가리키는 링크입니다: ${e.name.slice(0, 120)} → ${target.slice(0, 120)}`);
      const to = abs(e.name);
      let up = path.dirname(to);
      while (!fs.existsSync(up)) up = path.dirname(up);
      const upReal = await fsp.realpath(up);
      if (upReal !== tmpReal && !upReal.startsWith(tmpReal + path.sep)) throw new UnzipRejected(`링크 밑의 항목입니다: ${e.name.slice(0, 120)}`);
      await fsp.mkdir(path.dirname(to), { recursive: true, mode: 0o755 });
      await fsp.symlink(target, to);
      total += target.length;
    }
    await fsp.rename(tmp, dest);
    return { entries: entries.length, bytes: total };
  } catch (e) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* 지우기 실패 — 다음 정리가 걷는다 */ });
    throw e;
  } finally {
    await fh.close().catch(() => { /* 닫기 실패는 원래 결과를 덮지 않는다 */ });
  }
}

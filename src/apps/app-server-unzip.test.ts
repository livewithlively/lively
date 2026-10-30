// 앱 서버 zip 풀개(#4487 앱 v2-8 자가호스팅) 단위 시험 — 서버 zip 이 무엇을 적었든 판 폴더 밖에 아무것도 만들지 않는다.
// 실행: npm run build && node dist/apps/app-server-unzip.test.js
//  행 이름 U1~U14 는 사양 엣지 표(#4487 PR 2 B절)의 행 번호다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { UnzipRejected, safeEntryPath, safeLinkTarget, unzipTo } from "./app-server-unzip.js";
import { GUARD_BOOTSTRAP_SH, GUARD_JS, guardLayerZip } from "./app-server-guard.js";

let pass = 0;
const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>): void => { tests.push([name, fn]); };

type ZEntry =
  | { kind: "file"; name: string; data: Buffer | string; mode?: number; method?: 0 | 8; declared?: number; flags?: number; methodId?: number }
  | { kind: "dir"; name: string }
  | { kind: "link"; name: string; target: string };

/** 시험용 zip — 이름 · 권한 · 압축 방식 · 선언 크기 · 깃발을 마음대로 적는다(빌더는 이런 zip 을 만들지 않는다). */
function makeZip(entries: ZEntry[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = e.kind === "file" ? Buffer.from(e.data) : e.kind === "link" ? Buffer.from(e.target, "utf8") : Buffer.alloc(0);
    const method = e.kind === "file" ? (e.methodId ?? e.method ?? 0) : 0;
    const body = e.kind === "file" && e.method === 8 ? zlib.deflateRawSync(raw) : raw;
    const usize = e.kind === "file" && e.declared !== undefined ? e.declared : raw.length;
    const flags = (e.kind === "file" ? e.flags ?? 0 : 0) | 0x0800;
    const mode = e.kind === "dir" ? 0o040755 : e.kind === "link" ? 0o120777 : 0o100000 | (e.mode ?? 0o644);
    const crc = zlib.crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((mode << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "unz-")));
let n = 0;
const LIM = { maxBytes: 1024 * 1024, maxEntries: 100 };
/** zip 을 쓰고 새 풀 자리를 돌려준다(풀 자리의 윗폴더엔 다른 것이 없다 — 남은 임시 폴더를 셀 수 있게). */
const place = (zip: Buffer): { zip: string; dest: string; parent: string } => {
  const parent = path.join(work, `c${++n}`);
  fs.mkdirSync(parent);
  const file = path.join(work, `z${n}.zip`);
  fs.writeFileSync(file, zip);
  return { zip: file, dest: path.join(parent, "code"), parent };
};
/** 거절되고 · 풀 자리도 임시 폴더도 남지 않는다. */
async function rejected(zip: Buffer, why: RegExp, limits = LIM): Promise<void> {
  const p = place(zip);
  await assert.rejects(unzipTo(p.zip, p.dest, limits), (e: unknown) => e instanceof UnzipRejected && why.test(e.message));
  assert.deepEqual(fs.readdirSync(p.parent), [], "풀 자리 · 임시 폴더가 남았다");
}
const modeOf = (f: string): number => fs.statSync(f).mode & 0o7777;

t("U1 정상 zip — 파일 · 실행 비트 · 폴더 · /tmp 링크 · 폴더 안 상대 링크 · 빈 파일 · 저장/압축", async () => {
  const big = "x".repeat(5000);
  const p = place(makeZip([
    { kind: "dir", name: "lib/" },
    { kind: "file", name: "index.js", data: "console.log(1)\n" },
    { kind: "file", name: "bin/run", data: "#!/bin/sh\necho hi\n", mode: 0o755 },
    { kind: "file", name: "lib/big.txt", data: big, method: 8 },
    { kind: "file", name: "empty.txt", data: "" },
    { kind: "link", name: "cache", target: "/tmp/app-cache" },
    { kind: "link", name: "lib/alias.js", target: "../index.js" },
  ]));
  const r = await unzipTo(p.zip, p.dest, LIM);
  assert.equal(r.entries, 7);
  assert.equal(fs.readFileSync(path.join(p.dest, "index.js"), "utf8"), "console.log(1)\n");
  assert.equal(fs.readFileSync(path.join(p.dest, "lib/big.txt"), "utf8"), big);
  assert.equal(fs.readFileSync(path.join(p.dest, "empty.txt"), "utf8"), "");
  assert.equal(modeOf(path.join(p.dest, "bin/run")), 0o755);
  assert.equal(modeOf(path.join(p.dest, "index.js")), 0o644);
  assert.ok(fs.statSync(path.join(p.dest, "lib")).isDirectory());
  assert.equal(fs.readlinkSync(path.join(p.dest, "cache")), "/tmp/app-cache");
  assert.equal(fs.readlinkSync(path.join(p.dest, "lib/alias.js")), "../index.js");
  assert.equal(fs.readFileSync(path.join(p.dest, "lib/alias.js"), "utf8"), "console.log(1)\n");
  assert.deepEqual(fs.readdirSync(p.parent), ["code"], "임시 폴더가 남았다");
});

t("U2 ../ · 절대 경로 · 역슬래시 · 빈 마디 · . — 거절 · 아무것도 안 남음", async () => {
  for (const name of ["../evil.js", "a/../../evil.js", "/etc/evil", "a\\..\\evil", "a//b", "./a", "a/./b"]) {
    await rejected(makeZip([{ kind: "file", name: "ok.js", data: "1" }, { kind: "file", name, data: "x" }]), /판 폴더 밖을 가리키는 경로/);
  }
  assert.equal(safeEntryPath("a\0b"), null);
  assert.equal(safeEntryPath("x".repeat(1025)), null);
  assert.equal(safeEntryPath(Array(65).fill("a").join("/")), null);
  assert.deepEqual(safeEntryPath("a/b/"), ["a", "b"]);
});

t("U3 링크가 판 폴더 밖 — ../../x · /etc/passwd · /tmp 와 비슷한 /tmpx", async () => {
  for (const [name, target] of [["l", "../x"], ["a/l", "../../x"], ["l", "/etc/passwd"], ["l", "/tmpx/y"], ["l", "/tmp/../etc"]]) {
    await rejected(makeZip([{ kind: "file", name: "ok.js", data: "1" }, { kind: "link", name: name!, target: target! }]), /판 폴더 밖을 가리키는 링크/);
  }
  assert.equal(safeLinkTarget(["a", "l"], "../b"), true);
  assert.equal(safeLinkTarget(["l"], "/tmp"), true);
});

t("U4 링크 자리 밑의 항목(파일 · 링크) — 거절", async () => {
  await rejected(makeZip([{ kind: "link", name: "a", target: "b" }, { kind: "file", name: "a/c.js", data: "x" }]), /링크 밑의 항목/);
  await rejected(makeZip([{ kind: "link", name: "a", target: "/tmp" }, { kind: "link", name: "a/b", target: "x" }]), /링크 밑의 항목/);
});

t("U5 실제 데이터가 선언 크기보다 큼(폭탄) · 작음", async () => {
  await rejected(makeZip([{ kind: "file", name: "bomb", data: Buffer.alloc(200_000), method: 8, declared: 100 }]), /선언한 크기보다 큽니다/);
  await rejected(makeZip([{ kind: "file", name: "short", data: "abc", declared: 50 }]), /선언과 다릅니다/);
});

t("U6 선언 합이 상한을 넘음 · 실제 합이 상한을 넘음", async () => {
  await rejected(makeZip([{ kind: "file", name: "a", data: "x", declared: 700_000 }, { kind: "file", name: "b", data: "y", declared: 700_000 }]), /상한/);
  //  선언은 작게 · 실제 데이터는 상한보다 크게 — 항목 선언 검사가 먼저 걸린다(어느 쪽이든 멈춘다)
  await rejected(makeZip([{ kind: "file", name: "a", data: Buffer.alloc(2 * 1024 * 1024), method: 8, declared: 10 }]), /선언한 크기보다 큽니다|상한/);
});

t("U7 항목 수 상한", async () => {
  const many = Array.from({ length: 101 }, (_, i) => ({ kind: "file" as const, name: `f${i}`, data: "1" }));
  await rejected(makeZip(many), /항목이 너무 많습니다/);
});

t("U8 같은 이름 두 번 · 폴더와 파일이 같은 이름", async () => {
  await rejected(makeZip([{ kind: "file", name: "a.js", data: "1" }, { kind: "file", name: "a.js", data: "2" }]), /같은 이름이 두 번/);
  await rejected(makeZip([{ kind: "dir", name: "a/" }, { kind: "file", name: "a", data: "2" }]), /같은 이름이 두 번/);
});

t("U9 setuid · setgid · sticky 비트는 옮기지 않는다", async () => {
  const p = place(makeZip([
    { kind: "file", name: "suid", data: "x", mode: 0o4755 },
    { kind: "file", name: "sgid", data: "x", mode: 0o2644 },
    { kind: "file", name: "sticky", data: "x", mode: 0o1777 },
    { kind: "file", name: "world", data: "x", mode: 0o666 },
  ]));
  await unzipTo(p.zip, p.dest, LIM);
  assert.equal(modeOf(path.join(p.dest, "suid")), 0o755);
  assert.equal(modeOf(path.join(p.dest, "sgid")), 0o644);
  assert.equal(modeOf(path.join(p.dest, "sticky")), 0o755);
  assert.equal(modeOf(path.join(p.dest, "world")), 0o644);
});

t("U10 이미 있는 풀 자리 — 거절 · 덮지 않음", async () => {
  const p = place(makeZip([{ kind: "file", name: "a", data: "new" }]));
  fs.mkdirSync(p.dest);
  fs.writeFileSync(path.join(p.dest, "a"), "old");
  await assert.rejects(unzipTo(p.zip, p.dest, LIM), /풀 자리가 이미 있습니다/);
  assert.equal(fs.readFileSync(path.join(p.dest, "a"), "utf8"), "old");
  assert.deepEqual(fs.readdirSync(p.parent), ["code"]);
});

t("U11 검사 층 레이어 zip — bootstrap 755 · guard.cjs 644 · 내용 그대로", async () => {
  const p = place(guardLayerZip().zip);
  await unzipTo(p.zip, p.dest, { maxBytes: 16 * 1024 * 1024, maxEntries: 64 });
  assert.equal(modeOf(path.join(p.dest, "lively/bootstrap")), 0o755);
  assert.equal(modeOf(path.join(p.dest, "lively/guard.cjs")), 0o644);
  assert.equal(fs.readFileSync(path.join(p.dest, "lively/bootstrap"), "utf8"), GUARD_BOOTSTRAP_SH);
  assert.equal(fs.readFileSync(path.join(p.dest, "lively/guard.cjs"), "utf8"), GUARD_JS);
});

t("U12 암호 · 모르는 압축 방식 · 4GB 표시 · 끝 기록 없음", async () => {
  await rejected(makeZip([{ kind: "file", name: "a", data: "x", flags: 0x1 }]), /암호/);
  await rejected(makeZip([{ kind: "file", name: "a", data: "x", methodId: 14 }]), /모르는 압축 방식\(14\)/);
  await rejected(makeZip([{ kind: "file", name: "a", data: "x", declared: 0xffffffff }]), /4GB/);
  await rejected(Buffer.from("PK not a zip at all"), /끝 기록/);
});

t("U13 대소문자만 다른 링크 밑 항목(L1 → 밖 · l1/evil) — 판 폴더 밖에 아무것도 안 생김", async () => {
  //  링크가 가리킬 수 있는 밖 자리는 /tmp 아래뿐이라 시험 자리도 /tmp 아래에 둔다.
  const outside = fs.mkdtempSync("/tmp/unz-out-");
  try {
    const probe = path.join(work, "CaseProbe");
    fs.writeFileSync(probe, "");
    const caseInsensitive = fs.existsSync(path.join(work, "caseprobe"));
    const zip = makeZip([{ kind: "link", name: "L1", target: outside }, { kind: "link", name: "l1/evil", target: "x" }]);
    if (caseInsensitive) {
      await rejected(zip, /링크 밑의 항목/);
    } else {
      //  대소문자를 가리는 디스크(리눅스)에선 L1 과 l1 이 다른 자리 — 풀려도 l1 은 판 폴더 안의 진짜 폴더다.
      const p = place(zip);
      await unzipTo(p.zip, p.dest, LIM);
      assert.ok(fs.lstatSync(path.join(p.dest, "l1")).isDirectory());
    }
    assert.deepEqual(fs.readdirSync(outside), [], "판 폴더 밖(링크 대상)에 무엇이 생겼다");
    console.log(`    (이 디스크는 대소문자를 ${caseInsensitive ? "가리지 않는다" : "가린다"})`);
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

t("U14 링크 항목의 압축 크기 — 링크 대상보다 훨씬 큰 데이터는 읽기 전에 거절(메모리를 먼저 잡지 않는다)", async () => {
  //  usize 는 작게(링크 대상 5바이트) · 실제 실린 데이터(csize)는 크게
  const mkLink = (data: Buffer, method: 0 | 8): Buffer => {
    const name = Buffer.from("l");
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(5, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(5, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE((0o120777 << 16) >>> 0, 38); ch.writeUInt32LE(0, 42);
    const cd = Buffer.concat([ch, name]);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(30 + name.length + body.length, 16);
    return Buffer.concat([lh, name, body, cd, end]);
  };
  await rejected(mkLink(Buffer.alloc(8192, 0x41), 0), /링크/);
  await rejected(mkLink(crypto.randomBytes(8192), 8), /링크/);
  //  N5 — ① 저장식인데 실린·풀린 크기가 어긋남(둘 다 4096 이하) ② 압축은 작은데(csize≤4096) 풀면 큰 링크 → 풀다가 거절(거절 꼴 · RangeError 아님)
  await rejected(mkLink(Buffer.alloc(100, 0x41), 0), /어긋|링크/);
  await rejected(mkLink(Buffer.alloc(100_000, 0), 8), /너무 깁니다|링크/);
});

for (const [name, fn] of tests) { await fn(); pass++; console.log(`ok  ${name}`); }
fs.rmSync(work, { recursive: true, force: true });
console.log(`\napp-server-unzip: ${pass} 통과`);

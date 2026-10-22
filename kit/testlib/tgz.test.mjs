#!/usr/bin/env node
// tgzOf 사양테스트(#4927) — 시험 픽스처 번들을 시스템 tar 없이 만든다(새 Windows tar.exe 의 «만들기» 회귀 우회, tgz.mjs 머리말).
//  왜 시스템 tar 로 **풀어** 보나: 제품(CLI 설치·자가 업데이트)이 그 명령(`tar -xzf`)으로 푼다 — 그 길에서 이름·바이트가
//   그대로 나와야 픽스처가 게이트웨이 번들과 같은 것이다. 윈도우 러너 새 이미지에서도 풀기는 정상(진단 PR #1478).
//  실행: node scripts/run-tests.mjs kit/testlib/tgz.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { tgzOf, paxRecord } from "./tgz.mjs";

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const WIN = process.platform === "win32";

const BOX = mkdtempSync(join(tmpdir(), "tgz-test-"));
const SRC = join(BOX, "src");
const LONG = "a".repeat(60) + "/" + "b".repeat(60) + ".txt";   // 이름 120바이트 — ustar name(100) 을 넘는다
const FILES = {
  "README.md": "# 평범한 이름\n",
  "setup/온보딩.md": "한글 이름 파일 — 게이트웨이 번들에도 있다\n",
  "setup/사용가이드.md": "둘째 한글 이름\n",
  [LONG]: "긴 경로\n",
  "bin/run.sh": "#!/bin/sh\necho hi\n",
};
for (const [rel, body] of Object.entries(FILES)) { mkdirSync(join(SRC, ...rel.split("/").slice(0, -1)), { recursive: true }); writeFileSync(join(SRC, ...rel.split("/")), body); }
if (!WIN) chmodSync(join(SRC, "bin", "run.sh"), 0o755);
const listOf = (root) => {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? walk(p) : out.push(relative(root, p).split(sep).join("/").normalize("NFC")); } };
  walk(root);
  return out.sort();
};
//  ⚠ 이름은 NFC 로 맞춰 비교한다 — macOS 의 bsdtar 는 풀 때 한글 이름을 분해형(NFD)으로 만든다(같은 글자, 다른 바이트).

try {
  const tgz = join(BOX, "x.tgz");
  writeFileSync(tgz, tgzOf(SRC));

  // [T1] 시스템 tar 로 푼 결과 = 원본(이름·바이트). 한글·긴 경로 포함.
  {
    const dest = join(BOX, "dest"); mkdirSync(dest);
    const r = spawnSync("tar", ["-xzf", tgz, "-C", dest], { encoding: "utf8" });
    eq("T1a 시스템 tar 로 풀림(exit 0)", r.status, 0);
    eq("T1b 이름 그대로(한글·긴 경로 포함)", listOf(dest), Object.keys(FILES).sort());
    //  읽기 실패(이름이 깨져 파일이 없음)도 «다름» 으로 센다 — 여기서 던지면 뒤 행(T2·T3)이 아예 안 돈다.
    const same = (rel) => { try { return readFileSync(join(dest, ...rel.split("/")), "utf8") === FILES[rel]; } catch { return false; } };
    eq("T1c 바이트 그대로", Object.keys(FILES).every(same), true);
    // [T4] 실행 비트(POSIX) — 설치 스크립트가 풀린 뒤 실행 가능해야 한다.
    if (!WIN) eq("T4 실행 비트 보존", (() => { try { return (statSync(join(dest, "bin", "run.sh")).mode & 0o111) !== 0; } catch { return false; } })(), true);
  }

  // [T2] 비-ASCII·긴 경로에만 pax `path=`(게이트웨이 --format=pax 와 같은 계약) — 평범한 이름엔 없다.
  {
    const raw = gunzipSync(readFileSync(tgz)).toString("utf8");
    const paths = [...raw.matchAll(/\d+ path=([^\n]+)\n/g)].map((m) => m[1]).sort();
    eq("T2 pax path= 는 비-ASCII·긴 경로에만", paths, ["./" + LONG, "./setup/사용가이드.md", "./setup/온보딩.md"].sort());
  }

  // [T3] pax 레코드 길이 = 레코드 자신의 바이트 수(자릿수가 바뀌는 경계 포함).
  {
    const bad3 = [];
    for (const v of ["", "x", "x".repeat(2), "x".repeat(88), "x".repeat(89), "x".repeat(90), "x".repeat(985), "x".repeat(986), "한글"]) {
      const rec = paxRecord("path", v);
      const n = Number(rec.split(" ")[0]);
      if (n !== Buffer.byteLength(rec)) bad3.push(`${v.length}:${n}/${Buffer.byteLength(rec)}`);
    }
    eq("T3 pax 레코드 길이 자기일치", bad3, []);
  }
} finally {
  rmSync(BOX, { recursive: true, force: true });
}

console.log(`\n${fail ? "✗" : "✓"} tgz: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

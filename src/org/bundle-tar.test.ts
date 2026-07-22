// 설치 번들 tar 계약 테스트 (#1087) — 회귀 대상: 리눅스 게이트웨이가 GNU tar 기본값으로 묶은 번들을
//  윈도우 멤버가 못 풀었다. 파일명이 UTF-8 원시 바이트로만 들어가 윈도우 tar.exe(libarchive)가
//  활성 ANSI 코드페이지(cp949)로 해석했기 때문:
//
//    ✗ tar 실행 실패 (exit 1): ./setup/사용�\200이드.md: Invalid empty pathname
//
//  ⚠ 이 테스트는 **문자열 비교가 아니라 실제 tar 를 돌려 아카이브 바이트를 뜯는다.**
//   "코드에 --format=pax 가 있나"만 보면, tar 구현이 그 플래그를 무시하거나 헤더를 안 굽는 경우를 못 잡는다.
//   실제로 GNU tar 는 기본 pax 감지 포맷이면서도 짧은 이름엔 `path=` 확장헤더를 **안 굽는다** —
//   포맷 이름이 아니라 **헤더의 존재**가 계약이다.
//
//  ⚠⚠ **이 테스트의 행동 단언은 macOS 에서 공허하다 — 그리고 그게 정확히 이 사고의 본질이다.**
//   macOS 의 `tar` 는 bsdtar 라 pax 계열이 기본이고 xattr 확장헤더까지 굽는다 → `--format=pax` 를 빼도
//   `path=` 가 남아 **통과한다**(실측). 리눅스(GNU tar)에서만 빨간불이 된다(실측: `잡힌 path 헤더: []`).
//   즉 **회귀를 실제로 잡아주는 건 리눅스 CI 이고, macOS 에선 맨 아래 인자 단언이 최후의 방어선**이다.
//   고객 게이트웨이가 전부 리눅스이므로 방어가 필요한 곳에서는 작동한다 — 다만 "맥에서 통과했으니 안전"이라고
//   읽지 말 것. 같은 착시(맥 dev 박스에선 멀쩡)가 이 버그를 배포까지 보냈다.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installBundleTarArgs } from "./bundle-tar.js";

// tar 아카이브를 512바이트 블록으로 훑어 pax 확장헤더(typeflag 'x')의 본문을 모은다.
//  의존성 0 — tar 라이브러리를 새로 들이지 않는다(게이트웨이 의존성은 싸게 유지).
function paxHeaderBlobs(tar: Buffer): string[] {
  const out: string[] = [];
  for (let off = 0; off + 512 <= tar.length;) {
    const name = tar.subarray(off, off + 100).toString("binary").replace(/\0.*$/, "");
    if (!name) { off += 512; continue; }                       // 말미 0블록
    const sizeOct = tar.subarray(off + 124, off + 136).toString("binary").replace(/[\0 ]/g, "");
    const size = parseInt(sizeOct, 8) || 0;
    const typeflag = String.fromCharCode(tar[off + 156]);
    const dataStart = off + 512;
    if (typeflag === "x") out.push(tar.subarray(dataStart, dataStart + size).toString("utf8"));
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

const box = mkdtempSync(join(tmpdir(), "lively-bundletar-"));
try {
  // 번들에 실제로 들어 있는 한글 파일명(kit/setup/사용가이드.md)을 그대로 쓴다.
  const KOREAN = "사용가이드.md";
  mkdirSync(join(box, "stage", "setup"), { recursive: true });
  writeFileSync(join(box, "stage", "setup", KOREAN), "hi\n");
  writeFileSync(join(box, "stage", "setup", "ascii.md"), "hi\n");

  const r = spawnSync("tar", installBundleTarArgs(join(box, "stage")), { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `tar 실패: ${r.stderr}`);
  assert.ok(r.stdout && r.stdout.length > 0, "tar 가 아무것도 안 내놨다 — 테스트가 공허해진다");

  const blobs = paxHeaderBlobs(gunzipSync(r.stdout));

  // ── 핵심: 한글 경로가 pax 확장헤더에 **UTF-8 로 명시**돼 있어야 한다 ──
  //  이게 없으면 읽는 쪽(윈도우 tar)이 자기 코드페이지로 추측하고, 한국어 윈도우에선 추출이 죽는다.
  const pathHeaders = blobs.flatMap((b) => b.split("\n").filter((l) => / path=/.test(l)));
  assert.ok(
    pathHeaders.some((l) => l.includes(KOREAN)),
    `비-ASCII 경로에 pax 'path=' 확장헤더가 없다 — 윈도우 멤버가 번들을 못 푼다.\n` +
    `  잡힌 path 헤더: ${JSON.stringify(pathHeaders)}`,
  );

  // 배선 단언 — 헤더를 실제로 뜯고 있는가(파서가 죽어 있으면 위 단언이 늘 통과하거나 늘 실패한다)
  assert.ok(blobs.length > 0, "pax 확장헤더를 하나도 못 읽었다 — 블록 파서가 고장났을 수 있다");

  // 계약이 인자에 실제로 박혀 있는가(구현이 조용히 기본 포맷으로 돌아가는 것 방지)
  assert.ok(installBundleTarArgs("/x").includes("--format=pax"), "pax 포맷 강제가 빠졌다");
  // stage 경로와 대상이 인자에 그대로 실려야 한다(경로가 빠지면 빈 번들이 나간다)
  assert.deepEqual(installBundleTarArgs("/x"), ["--format=pax", "-czf", "-", "-C", "/x", "."]);

  console.log("ok — bundle-tar (#1087 비-ASCII 경로 pax 보존)");
} finally {
  rmSync(box, { recursive: true, force: true });
}

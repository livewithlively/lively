// 업로드 마무리의 **결과 도장**(#3787) — 격리 멤버 개인 폴더는 게이트웨이가 직접 stat 못 한다.
//  배포본 E2E(2026-09-14)가 잡은 결함이다: 개인 폴더 업로드 응답에만 mtime/size 가 조용히 비어 있었다.
//  화면엔 표시가 없고, 다음 push 때 원장 기준선이 어긋나야 드러난다 — 그래서 코드로 못 박는다.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");

test("격리 멤버(osUser)면 그 uid 로 stat 한다 — fsp.stat 은 700 홈을 못 읽는다", () => {
  const SRC = read("./upload-finish.ts");
  assert.match(SRC, /const st = osUser\s*\n?\s*\? await memberStat\(osUser, abs\)/,
    "osUser 갈래가 없다 — 개인 폴더 업로드의 도장이 조용히 빈다");
  assert.match(SRC, /: await fsp\.stat\(abs\)/, "비격리 갈래가 사라졌다");
});

test("mtime 이 없으면 도장을 아예 싣지 않는다 — 0 은 epoch 이라 더 나쁘다", () => {
  const SRC = read("./upload-finish.ts");
  assert.match(SRC, /r && r\.file && r\.mtime \?/, "mtime 0 을 그대로 실으면 훅이 로컬 시각을 epoch 으로 맞춘다");
});

test("멤버 stat 이 mtime 을 **floor(ms)** 로 준다 — 매니페스트·원장과 같은 자", () => {
  const FS = read("../terminal/terminal-member-fs.ts");
  assert.match(FS, /mtime:Math\.floor\(s\.mtimeMs\)/,
    "자가 다르면(round vs floor) 같은 파일의 도장이 두 값으로 갈려 «바뀌었다» 오판이 난다(#762)");
});

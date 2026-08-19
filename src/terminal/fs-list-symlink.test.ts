// 디렉터리 목록의 **심링크 해소**(#1744) — 파일 탐색기가 보는 줄의 '실효 종류'.
//
// 사양: 링크를 따라간 뒤의 종류가 그 줄의 종류다 — 사람이 눌렀을 때 무슨 일이 나야 하는지가 곧 종류이기 때문이다.
//  폴더 링크는 들어갈 수 있어야 하고(dir), 파일 링크는 열려야 하며(file · 대상 크기), 끊어진 링크도 목록에서
//  사라지지 않는다(지우거나 고칠 방법이 없어진다). 링크인 줄은 링크임과 목적지를 함께 말한다.
//
// 왜 테스트하나: `fs.Dirent.isDirectory()` 는 심링크에 대해 **언제나 false** 다. 그 값을 그대로 type 으로 쓰면
//  세션 폴더의 `project`(라이블리가 만드는 프로젝트 폴더 링크)가 '파일'로 나와, 눌러도 미리보기만 열리고 들어갈
//  방법이 없다. 코드만 보면 맞아 보이는 자리라(=조용히 되돌아오기 쉽다) 계약을 여기서 못박는다.
//
// 두 구현을 **함께** 재는 이유: 같은 목록을 게이트웨이(readDirItems — plain fs)와 격리 멤버 경로(LS_JS — 멤버 uid 로
//  도는 node 한 줄 리터럴)가 각각 만든다. 한쪽만 고치면 격리 조직에서만 옛 동작이 남아 재현이 어려운 신고가 된다.
//
// 실행: npm run build && node dist/terminal/fs-list-symlink.test.js
import { strict as assert } from "node:assert";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readDirItems } from "./terminal-files.js";
import { LS_JS } from "./terminal-member-fs.js";

interface Row { name: string; type: string; size: number; mtime?: number; link?: boolean; linkTarget?: string }

/** 표본 트리 — 엣지 표의 7종을 한 폴더에 모아 둔다(목록은 한 번에 판정되므로 한 폴더가 곧 한 케이스 묶음이다). */
function fixture(): { base: string; targetDir: string; targetFile: string; brokenTarget: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lively-lssym-"));
  const base = path.join(root, "base");
  fs.mkdirSync(base);
  const targetDir = path.join(root, "target-dir");           // 링크 대상(폴더) — base 밖
  fs.mkdirSync(targetDir);
  const targetFile = path.join(root, "target-file.md");      // 링크 대상(파일) — 3바이트
  fs.writeFileSync(targetFile, "# t");
  fs.writeFileSync(path.join(base, "plain.txt"), "0123456789");   // ① 일반 파일 10바이트
  fs.mkdirSync(path.join(base, "plain-dir"));                     // ② 일반 폴더
  fs.symlinkSync(targetDir, path.join(base, "link-dir"));         // ③ 폴더 링크(절대)
  fs.symlinkSync(targetFile, path.join(base, "link-file"));       // ④ 파일 링크
  const brokenTarget = path.join(root, "nope");                   // ⑤ 없는 곳을 가리키는 링크
  fs.symlinkSync(brokenTarget, path.join(base, "link-broken"));
  fs.symlinkSync("plain-dir", path.join(base, "rel-dir"));        // ⑥ 폴더 링크(상대 — ./project 가 이 꼴이다)
  fs.writeFileSync(path.join(base, ".hidden"), "x");              // ⑦ 숨김
  return { base, targetDir, targetFile, brokenTarget };
}
const at = (items: Row[], name: string): Row | undefined => items.find((i) => i.name === name);

// ── 게이트웨이 경로(readDirItems) — 엣지 표 ①~⑦ ──────────────────────────────────
test("① 일반 파일 — file · 실제 크기 · 링크 표식 없음", async () => {
  const rows = await readDirItems(fixture().base) as Row[];
  assert.deepEqual({ ...at(rows, "plain.txt"), mtime: 0 }, { name: "plain.txt", type: "file", size: 10, mtime: 0 });
});

test("② 일반 폴더 — dir · 크기 0 · 링크 표식 없음", async () => {
  const rows = await readDirItems(fixture().base) as Row[];
  assert.deepEqual({ ...at(rows, "plain-dir"), mtime: 0 }, { name: "plain-dir", type: "dir", size: 0, mtime: 0 });
});

test("③★★ 폴더를 가리키는 심링크 — dir(들어갈 수 있어야 한다) · 크기 0 · 목적지 동봉", async () => {
  const f = fixture();
  const row = at(await readDirItems(f.base) as Row[], "link-dir")!;
  assert.equal(row.type, "dir");                 // ← 이 한 줄이 '눌러서 들어갈 수 있나'를 정한다
  assert.equal(row.size, 0);                     //   폴더 크기는 싣지 않는다(종전엔 stat 크기가 파일 크기처럼 보였다)
  assert.equal(row.link, true);
  assert.equal(row.linkTarget, f.targetDir);
});

test("④ 파일을 가리키는 심링크 — file · **대상** 파일의 크기", async () => {
  const f = fixture();
  const row = at(await readDirItems(f.base) as Row[], "link-file")!;
  assert.equal(row.type, "file");
  assert.equal(row.size, 3);
  assert.equal(row.link, true);
  assert.equal(row.linkTarget, f.targetFile);
});

test("⑤ 끊어진 심링크 — 목록에서 사라지지 않는다(file · 크기 0) · 어디를 가리키려 했는지는 남는다", async () => {
  const f = fixture();
  const row = at(await readDirItems(f.base) as Row[], "link-broken");
  assert.ok(row, "끊어진 링크가 목록에서 빠지면 지우거나 고칠 방법이 없어진다");
  assert.equal(row!.type, "file");
  assert.equal(row!.size, 0);
  assert.equal(row!.link, true);
  // readlink 는 대상이 없어도 읽힌다 — 목적지를 보여줘야 왜 깨졌는지 사람이 안다.
  assert.equal(row!.linkTarget, f.brokenTarget);
});

test("⑥ 상대경로 심링크 — 종류는 해소 결과(dir), 목적지는 **원문 그대로**", async () => {
  const row = at(await readDirItems(fixture().base) as Row[], "rel-dir")!;
  assert.equal(row.type, "dir");
  assert.equal(row.linkTarget, "plain-dir");
});

test("⑦ 숨김은 종전대로 제외 · 목록은 위 7종 중 보이는 6줄뿐", async () => {
  const rows = await readDirItems(fixture().base) as Row[];
  assert.equal(at(rows, ".hidden"), undefined);
  assert.deepEqual(rows.map((r) => r.name).sort(),
    ["link-broken", "link-dir", "link-file", "plain-dir", "plain.txt", "rel-dir"]);
});

// ── ⑧ 격리 멤버 경로(LS_JS) — 같은 표본에 **같은 판정** ────────────────────────────
//  LS_JS 는 멤버 uid 로 도는 node 한 줄 리터럴이라 여기서는 같은 node 로 직접 돌려 판정만 잰다
//  (uid 강하는 이 테스트의 관심사가 아니다 — member-exec-seam.test.ts 가 그 축을 잰다).
//  ⚠ LS_JS 는 **숨김을 거르지 않는다** — 그 필터는 이 값을 받는 라우트가 한다. 그래서 여기선 원문 그대로를 재고,
//   아래 등가 비교에서만 라우트와 같은 필터를 씌운다.
const lsJs = (base: string): Row[] =>
  JSON.parse(execFileSync(process.execPath, ["-e", LS_JS, base], { encoding: "utf8" })) as Row[];
const byName = (a: Row, b: Row): number => a.name.localeCompare(b.name);

test("⑧a★★ 격리 멤버 경로도 같은 판정을 낸다 — 심링크 축의 값 전수", () => {
  const f = fixture();
  const rows = lsJs(f.base).map((r) => ({ ...r, mtime: 0 })).sort(byName);
  const row = (name: string, extra: Partial<Row>): Row => ({ name, type: "file", size: 0, mtime: 0, link: false, linkTarget: "", ...extra });
  assert.deepEqual(rows, [
    row(".hidden", { size: 1 }),                                                   // 숨김은 라우트가 거른다(위 주석)
    row("link-broken", { link: true, linkTarget: f.brokenTarget }),
    row("link-dir", { type: "dir", link: true, linkTarget: f.targetDir }),
    row("link-file", { size: 3, link: true, linkTarget: f.targetFile }),
    row("plain-dir", { type: "dir" }),
    row("plain.txt", { size: 10 }),
    row("rel-dir", { type: "dir", link: true, linkTarget: "plain-dir" }),
  ].sort(byName));
});

test("⑧b 두 경로가 라우트가 보는 모양에서 완전히 겹친다(한쪽만 고쳐지는 드리프트 차단)", async () => {
  const f = fixture();
  const norm = (r: Row): Row => ({ name: r.name, type: r.type, size: r.size, link: !!r.link, linkTarget: r.linkTarget || "" });
  const member = lsJs(f.base).filter((r) => !r.name.startsWith(".")).map(norm).sort(byName);
  const gateway = (await readDirItems(f.base) as Row[]).map(norm).sort(byName);
  assert.deepEqual(member, gateway);
});

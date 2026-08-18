// 대화 파일 위치(locate.ts) — 사양 §C 표 전수 (#1746). 보고 경로 검증은 순수, locate 는 임시 디렉터리로 실파일.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reportedPathOk, ownerHomes, locateTranscript } from "./locate.js";
import { harnessIo, type HarnessSessionAdapter } from "./adapter.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const claude = harnessIo("claude")!, grok = harnessIo("grok")!;
const roots = ["/home/box_yoon/.claude/projects", "/Users/gw/.claude/projects"];

await t("[C1] 뿌리 안 + 이름 규약 → true", () => {
  assert.equal(reportedPathOk(claude, "/home/box_yoon/.claude/projects/-w/abc.jsonl", roots), true);
  assert.equal(reportedPathOk(grok, "/Users/gw/.grok/sessions/%2Fw/019f/updates.jsonl", ["/Users/gw/.grok/sessions"]), true);
});
await t("[C2] 상대경로 · `..` · NUL → false", () => {
  assert.equal(reportedPathOk(claude, "home/box_yoon/.claude/projects/-w/abc.jsonl", roots), false);
  assert.equal(reportedPathOk(claude, "/home/box_yoon/.claude/projects/../../../etc/x.jsonl", roots), false);
  assert.equal(reportedPathOk(claude, "/home/box_yoon/.claude/projects/-w/abc.jsonl\0", roots), false);
});
await t("[C3] 뿌리 밖(/etc/passwd) · 뿌리 자체 · 뿌리의 형제(prefix 만 같음) → false", () => {
  assert.equal(reportedPathOk(claude, "/etc/passwd.jsonl", roots), false);
  assert.equal(reportedPathOk(claude, "/home/box_yoon/.claude/projects", roots), false);
  assert.equal(reportedPathOk(claude, "/home/box_yoon2/.claude/projects/-w/abc.jsonl", roots), false);   // '/home/box_yoon' 접두어만 같다
  assert.equal(reportedPathOk(claude, "/home/box_yoon/.claude/projects-x/-w/abc.jsonl", roots), false);
});
await t("[C4] 뿌리 안이지만 이름 규약이 안 맞으면 false(claude 에 updates.jsonl 은 되지만 grok 에 x.jsonl 은 안 됨 · 확장자 아님)", () => {
  assert.equal(reportedPathOk(grok, "/Users/gw/.grok/sessions/%2Fw/019f/x.jsonl", ["/Users/gw/.grok/sessions"]), false);
  assert.equal(reportedPathOk(claude, "/Users/gw/.claude/projects/-w/abc.txt", roots), false);
  assert.equal(reportedPathOk(claude, "/Users/gw/.claude/projects/-w/.jsonl", roots), false);
});
await t("[C5] ownerHomes — linux 는 공유 홈 + /home/box_<owner> · mac 은 공유 홈만 · owner 없으면 공유 홈만", () => {
  const prev = process.env.LIVELY_MEMBER_HOME_BASE; delete process.env.LIVELY_MEMBER_HOME_BASE;
  try {
    assert.deepEqual(ownerHomes("yoon", "linux").slice(1), [path.join("/home", "box_yoon")]);
    assert.equal(ownerHomes("yoon", "darwin").length, 1);
    assert.equal(ownerHomes("", "linux").length, 1);
    assert.equal(ownerHomes("yoon", "linux")[0], os.homedir());
  } finally { if (prev !== undefined) process.env.LIVELY_MEMBER_HOME_BASE = prev; }
});
await t("[C6] locateTranscript — 보고 경로가 뿌리 안이고 존재 → reported · 뿌리 밖(존재해도) → 규약 폴백 · 둘 다 없음 → null", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hio-"));
  const home = path.join(tmp, "home"); const outside = path.join(tmp, "outside");
  fs.mkdirSync(path.join(home, ".t", "conv-1"), { recursive: true }); fs.mkdirSync(outside, { recursive: true });
  const reported = path.join(home, ".t", "conv-1", "reported.jsonl"); fs.writeFileSync(reported, "a\n");
  const conv = path.join(home, ".t", "conv-1", "conv.jsonl"); fs.writeFileSync(conv, "bb\n");
  const evil = path.join(outside, "evil.jsonl"); fs.writeFileSync(evil, "ccc\n");
  // 테스트용 어댑터 — 뿌리 = <home>/.t, 규약 = <root>/<convId>/conv.jsonl. ownerHomes 는 실 홈을 보므로 roots 가 tmp 를 보게 어댑터로 고정.
  const io: HarnessSessionAdapter = { key: "t", label: "t", roots: () => [path.join(home, ".t")], filePattern: /\.jsonl$/,
    pathFor: (root, { convId }) => path.join(root, convId, "conv.jsonl"), parse: null, answer: null };
  const a = await locateTranscript(io, { cwd: "/w", convId: "conv-1", owner: "yoon", reportedPath: reported });
  assert.deepEqual(a, { file: reported, size: 2, via: "reported" });
  const b = await locateTranscript(io, { cwd: "/w", convId: "conv-1", owner: "yoon", reportedPath: evil });
  assert.deepEqual(b, { file: conv, size: 3, via: "convention" });         // 뿌리 밖 보고는 **무시**되고 규약으로
  const c = await locateTranscript(io, { cwd: "/w", convId: "conv-9", owner: "yoon", reportedPath: evil });
  assert.equal(c, null);
  const d = await locateTranscript(io, { cwd: "/w", convId: "conv-1", owner: "yoon", reportedPath: path.join(home, ".t", "conv-1", "missing.jsonl") });
  assert.deepEqual(d, { file: conv, size: 3, via: "convention" });         // 보고 경로가 없으면 규약으로
  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(`harness-io/locate: ${pass} passed`);

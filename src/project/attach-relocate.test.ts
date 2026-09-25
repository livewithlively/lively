// 첫 지시 첨부의 좌표 표기 파싱·치환(#3787) — 순수부. 실제 이동은 DB·fs 라 여기서 안 잰다.
//  #4302 되돌리기는 끝에서 — 로컬 갈래는 mkdtemp 실제 fs 로, 멤버·DB 갈래는 가짜 deps 로 잰다.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  refsInPrompt, rewriteRefs,
  returnAttachmentsToPersonal, trackRelocationSync, type RelocatedAttachment, type RelocationSync, type ReturnDeps,
} from "./attach-relocate.js";

test("좌표 표기를 등장 순서대로, 중복 없이 뽑는다", () => {
  const p = "봐줘\n\n첨부한 자료:\n- a.png  [lively:personal:m1/uploads/a.png]\n- b.md  [lively:project:7/b.md]\n- a 다시  [lively:personal:m1/uploads/a.png]";
  assert.deepEqual(refsInPrompt(p), ["personal:m1/uploads/a.png", "project:7/b.md"]);
});

test("좌표가 없으면 빈 배열 — 구 클라이언트(맨 경로)는 건드리지 않는다", () => {
  assert.deepEqual(refsInPrompt("첨부한 자료(프로젝트 #7 공유 폴더):\n- b.md"), []);
});

test("옮긴 것만 바꾸고 **표시 이름은 그대로** 둔다", () => {
  const p = "- a.png  [lively:personal:m1/uploads/a.png]\n- b.md  [lively:project:7/b.md]";
  const out = rewriteRefs(p, new Map([["personal:m1/uploads/a.png", "project:9/a.png"]]));
  assert.equal(out, "- a.png  [lively:project:9/a.png]\n- b.md  [lively:project:7/b.md]");
});

test("옮긴 게 없으면 원문 그대로(불필요한 재작성 없음)", () => {
  const p = "- a.png  [lively:personal:m1/uploads/a.png]";
  assert.equal(rewriteRefs(p, new Map()), p);
});

// ── #4302 세션이 안 뜨면 첨부를 제자리로 ───────────────────────────────────────
//  실제 fs(mkdtemp)로 로컬 갈래(rename·copy)를 재고, 멤버 갈래는 부른 인자만 본다. 자료 행(DB)은 가짜로 센다.

const settled = (): RelocationSync => ({ cancelled: false, superseding: null, done: Promise.resolve() });

async function tmpPair(): Promise<{ dir: string; src: string; dest: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relocate-back-"));
  await fs.mkdir(path.join(dir, "uploads")); await fs.mkdir(path.join(dir, "project"));
  return { dir, src: path.join(dir, "uploads", "a.png"), dest: path.join(dir, "project", "a.png") };
}

function localDeps(log: string[], over: Partial<ReturnDeps> = {}): ReturnDeps {
  return {
    exists: async (abs) => !!(await fs.stat(abs).catch(() => null)),
    rename: (a, b) => fs.rename(a, b),
    copyFile: (a, b) => fs.copyFile(a, b),
    unlink: (a) => fs.unlink(a),
    memberMv: async (u, a, b) => { log.push(`mv:${u}:${path.basename(path.dirname(a))}->${path.basename(path.dirname(b))}`); },
    memberWriteBack: async (u) => { log.push(`write:${u}`); },
    reactivate: async (ref) => { log.push(`reactivate:${ref}`); },
    retire: async (ref) => { log.push(`retire:${ref}`); },
    ...over,
  };
}

const mv = (o: Partial<RelocatedAttachment> & Pick<RelocatedAttachment, "srcAbs" | "destAbs" | "how">): RelocatedAttachment => ({
  from: "personal:m1/uploads/a.png", to: "project:9/a.png", osUser: null, sync: settled(), ...o,
});
const tick = () => new Promise((r) => setImmediate(r));

test("#4302 rename 으로 옮긴 첨부는 원래 자리로 돌아오고, 개인 좌표는 되살고 프로젝트 좌표는 내린다", async () => {
  const { src, dest } = await tmpPair();
  await fs.writeFile(dest, "IMG");
  const log: string[] = [];
  const r = await returnAttachmentsToPersonal([mv({ srcAbs: src, destAbs: dest, how: "rename" })], localDeps(log));
  await tick();
  assert.deepEqual(r, { returned: 1, failed: 0, left: [] });
  assert.equal(await fs.readFile(src, "utf8"), "IMG");
  assert.equal(await fs.stat(dest).catch(() => null), null);
  assert.deepEqual(log, ["reactivate:personal:m1/uploads/a.png", "retire:project:9/a.png"]);
});

test("#4302 원래 자리에 그 사이 다른 파일이 생겼으면 덮지 않는다 — «못 돌려놓음» 으로 센다", async () => {
  const { src, dest } = await tmpPair();
  await fs.writeFile(dest, "OLD"); await fs.writeFile(src, "NEW");
  const log: string[] = [];
  const r = await returnAttachmentsToPersonal([mv({ srcAbs: src, destAbs: dest, how: "rename" })], localDeps(log));
  assert.deepEqual(r, { returned: 0, failed: 1, left: ["personal:m1/uploads/a.png"] });
  assert.equal(await fs.readFile(src, "utf8"), "NEW");
  assert.equal(await fs.readFile(dest, "utf8"), "OLD");
  assert.deepEqual(log, []);
});

test("#4302 copy 로 옮긴 첨부(원본이 남아 있다)는 사본만 걷는다", async () => {
  const { src, dest } = await tmpPair();
  await fs.writeFile(src, "IMG"); await fs.writeFile(dest, "IMG");
  const r = await returnAttachmentsToPersonal([mv({ srcAbs: src, destAbs: dest, how: "copy" })], localDeps([]));
  assert.equal(r.returned, 1);
  assert.equal(await fs.readFile(src, "utf8"), "IMG");
  assert.equal(await fs.stat(dest).catch(() => null), null);
});

test("#4302 copy 였는데 원본이 그새 사라졌으면 사본을 원래 자리로 옮긴다", async () => {
  const { src, dest } = await tmpPair();
  await fs.writeFile(dest, "IMG");
  const r = await returnAttachmentsToPersonal([mv({ srcAbs: src, destAbs: dest, how: "copy" })], localDeps([]));
  assert.equal(r.returned, 1);
  assert.equal(await fs.readFile(src, "utf8"), "IMG");
});

test("#4302 멤버 저장소(member-mv)는 같은 경계에서 거꾸로 mv 한다", async () => {
  const log: string[] = [];
  const r = await returnAttachmentsToPersonal(
    [mv({ srcAbs: "/m/uploads/a.png", destAbs: "/m/project/a.png", how: "member-mv", osUser: "lvm-wj" })],
    localDeps(log, { exists: async () => false }));
  assert.equal(r.returned, 1);
  assert.equal(log[0], "mv:lvm-wj:project->uploads");
});

test("#4302 되돌리기 실패는 던지지 않고 «못 돌려놓음» 으로 센다", async () => {
  const log: string[] = [];
  const r = await returnAttachmentsToPersonal(
    [mv({ srcAbs: "/m/uploads/a.png", destAbs: "/m/project/a.png", how: "member-mv", osUser: "lvm-wj" })],
    localDeps(log, { exists: async () => false, memberMv: async () => { throw new Error("EACCES"); } }));
  assert.deepEqual(r, { returned: 0, failed: 1, left: ["personal:m1/uploads/a.png"] });
  assert.deepEqual(log, []);
});

test("#4302 등록이 아직 안 끝났으면 개인 좌표를 **내리지 않게** 막는다", async () => {
  let release!: () => void;
  const ingest = new Promise<void>((r) => { release = r; });
  let superseded = 0;
  const sync = trackRelocationSync(() => ingest, async () => { superseded++; }, () => { /* */ });
  const { src, dest } = await tmpPair();
  await fs.writeFile(dest, "IMG");
  await returnAttachmentsToPersonal([mv({ srcAbs: src, destAbs: dest, how: "rename", sync })], localDeps([]));
  release(); await sync.done;
  assert.equal(superseded, 0);
});

test("#4302 개인 좌표를 이미 내리는 중이면 그 끝을 기다린 **뒤에** 되살린다", async () => {
  const order: string[] = [];
  let finish!: () => void;
  const sync = trackRelocationSync(async () => { /* 등록 끝 */ },
    () => new Promise<void>((r) => { finish = () => { order.push("superseded"); r(); }; }), () => { /* */ });
  await tick();                                   // 등록이 끝나 내리기가 시작됐다
  assert.ok(sync.superseding);
  const { src, dest } = await tmpPair();
  await fs.writeFile(dest, "IMG");
  const p = returnAttachmentsToPersonal([mv({ srcAbs: src, destAbs: dest, how: "rename", sync })],
    localDeps([], { reactivate: async () => { order.push("reactivated"); } }));
  await tick(); finish(); await p;
  assert.deepEqual(order, ["superseded", "reactivated"]);
});

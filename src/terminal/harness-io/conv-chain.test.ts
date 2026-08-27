// 대화 사슬(conv-chain.ts) — 「세션 = 대화 여럿」(#2233) 을 실제 파일 모양 위에서 실측한다.
//
//  재현하는 사고: 한 박스가 살면서 대화를 갈아탄다(/clear·resume·포크·압축 롤오버). 매핑은 last-write-wins 라
//  화면은 마지막 파일 하나만 읽었고, 그 앞의 질문이 통째로 사라졌다(실측 box-jang-ebdb3a82: 파일 5개·질문 43개 → 1개).
//  시나리오는 사양의 엣지 표(17행)를 그대로 옮긴 것이다 — 빠진 행이 곧 못 잡는 버그다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeIo } from "./claude.js";
import { localTranscriptFs, type TranscriptFs } from "./transcript-fs.js";
import { resolveConvChain, readThinChain, convUuidsInDir } from "./conv-chain.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "convchain-"));
const u = (n: number): string => `0000000${n}-0000-4000-8000-00000000000${n}`;
const MB = 1024 * 1024;

/** 사람 질문 n 개짜리 대화 파일. head 를 주면 그 줄이 첫 줄(압축 경계 등). mtime 이 사슬의 차례를 정한다. */
function conv(dir: string, uuid: string, says: string[], opts?: { head?: unknown; mtime?: number }): string {
  const lines: string[] = [];
  if (opts?.head) lines.push(JSON.stringify(opts.head));
  says.forEach((s, i) => {
    lines.push(JSON.stringify({ type: "user", uuid: `${uuid}-m${i}`, timestamp: `2026-08-2${1 + i}T00:00:00.000Z`, message: { role: "user", content: s } }));
    lines.push(JSON.stringify({ type: "assistant", uuid: `${uuid}-a${i}`, timestamp: `2026-08-2${1 + i}T00:00:01.000Z`, message: { role: "assistant", content: [{ type: "text", text: "네" }] } }));
  });
  const file = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(file, lines.length ? lines.join("\n") + "\n" : "");
  if (opts?.mtime) fs.utimesSync(file, opts.mtime, opts.mtime);
  return file;
}
const sizeOf = (f: string): number => fs.statSync(f).size;
/** 얇은 판 ndjson → 사람이 던진 질문만(오는 차례 그대로). */
const saysOf = (nd: string): string[] => nd.split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((o) => o.type === "user").map((o) => String(o.message.content[0].text));

// ── 판 하나: 오래된 → 최신 (A, B, C=압축으로 시작, cur) ───────────────────────
const dir = path.join(tmp, "main"); fs.mkdirSync(dir);
conv(dir, u(1), ["첫 질문", "둘째 질문"], { mtime: 1000 });
conv(dir, u(2), ["셋째 질문"], { mtime: 2000 });
const fC = conv(dir, u(3), ["넷째 질문"], { mtime: 3000, head: { type: "system", subtype: "compact_boundary", logicalParentUuid: `${u(2)}-m0`, timestamp: "2026-08-25T00:00:00.000Z" } });
const fCur = conv(dir, u(4), ["지금 질문"], { mtime: 4000 });
const base = { curFile: fCur, curUuid: u(4), curSize: sizeOf(fCur), budget: 8 * MB };
const ids = async (o: Partial<Parameters<typeof resolveConvChain>[2]> & { exclusive: boolean }, tfs: TranscriptFs = localTranscriptFs): Promise<string[]> =>
  (await resolveConvChain(claudeIo, tfs, { ...base, ...o })).map((c) => c.uuid);

await t("[1] 단독 폴더 — 폴더의 대화가 전부, 오래된 → 최신, 지금 대화가 마지막", async () => {
  assert.deepEqual(await ids({ exclusive: true }), [u(1), u(2), u(3), u(4)]);
});

await t("[2] 공유 폴더 — 폴더를 안 믿는다. 증거가 없으면 지금 대화뿐", async () => {
  assert.deepEqual(await ids({ exclusive: false }), [u(4)]);
});

await t("[3] 공유 폴더 — 압축 경계는 파일 안의 증거라 부모가 딸려 온다", async () => {
  const chain = await resolveConvChain(claudeIo, localTranscriptFs, {
    curFile: fC, curUuid: u(3), curSize: sizeOf(fC), budget: 8 * MB, exclusive: false,
  });
  assert.deepEqual(chain.map((c) => c.uuid), [u(2), u(3)]);
});

await t("[4] 공유 폴더 — 기록된 사슬(known)은 확정이라 그대로 실린다", async () => {
  assert.deepEqual(await ids({ exclusive: false, known: [u(1)] }), [u(1), u(4)]);
});

await t("[5] 다른 박스가 가진 대화(taken)는 단독 폴더에서도 안 섞인다", async () => {
  assert.deepEqual(await ids({ exclusive: true, taken: new Set([u(2), u(3)]) }), [u(1), u(4)]);
  assert.deepEqual(await ids({ exclusive: false, known: [u(1)], taken: new Set([u(1)]) }), [u(4)], "known 이어도 남의 것이면 뺀다");
});

await t("[6] 예산은 **지금 대화까지 포함한 총량** — 딱 맞으면 담기고, 1바이트 모자라면 거기서 끊긴다", async () => {
  assert.deepEqual(await ids({ exclusive: true, budget: base.curSize + sizeOf(fC) }), [u(3), u(4)]);
  //  fB 는 fC 보다 작아서 남은 예산에는 들어가지만, fC 를 건너뛰고 담으면 사슬 가운데가 빈다 — 그래서 안 담는다.
  assert.deepEqual(await ids({ exclusive: true, budget: base.curSize + sizeOf(fC) - 1 }), [u(4)], "안 들어가면 그 앞은 통째로 잘린다");
  assert.deepEqual(await ids({ exclusive: true, budget: base.curSize }), [u(4)], "지금 대화가 예산을 다 쓰면 옛 대화는 없다");
});

await t("[7] 예산 0 — 지금 대화는 예산과 무관하게 남는다(화면이 비지 않는다)", async () => {
  assert.deepEqual(await ids({ exclusive: true, budget: 0 }), [u(4)]);
});

await t("[8] known 에 폴더에 없는 대화가 섞여도 조용히 건너뛴다", async () => {
  assert.deepEqual(await ids({ exclusive: false, known: [u(1), "99999999-0000-4000-8000-000000000099"] }), [u(1), u(4)]);
});

await t("[9] 폴더를 못 읽어도 화면이 비지 않는다 — 지금 대화는 늘 선다", async () => {
  const blind: TranscriptFs = { ...localTranscriptFs, listDir: async () => { throw new Error("nope"); } };
  assert.deepEqual(await ids({ exclusive: true, known: [u(1)] }, blind), [u(4)]);
});

await t("[10] 0바이트 옛 대화는 사슬에 안 담는다(읽을 것이 없다)", async () => {
  const d = path.join(tmp, "zero"); fs.mkdirSync(d);
  const empty = conv(d, u(1), [], { mtime: 1000 });
  assert.equal(sizeOf(empty), 0);
  const live = conv(d, u(2), ["옛 질문"], { mtime: 2000 });
  const cur = conv(d, u(3), ["지금"], { mtime: 3000 });
  const chain = await resolveConvChain(claudeIo, localTranscriptFs, { curFile: cur, curUuid: u(3), curSize: sizeOf(cur), budget: 8 * MB, exclusive: true });
  assert.deepEqual(chain.map((c) => c.uuid), [u(2), u(3)]);
  assert.ok(live);
});

await t("[11] 파일 수 상한 경계값 — maxFiles=2 면 옛 것 1 + 지금", async () => {
  assert.deepEqual(await ids({ exclusive: true, maxFiles: 2 }), [u(3), u(4)]);
  assert.deepEqual(await ids({ exclusive: true, maxFiles: 1 }), [u(4)]);
});

await t("[12] 폴더의 잡파일은 대화가 아니다(어댑터 규약이 가른다)", async () => {
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  fs.writeFileSync(path.join(dir, "README.md"), "x");
  assert.deepEqual((await convUuidsInDir(claudeIo, localTranscriptFs, fCur)).slice().sort(), [u(1), u(2), u(3), u(4)]);
  assert.deepEqual(await ids({ exclusive: true }), [u(1), u(2), u(3), u(4)]);
});

await t("[13] 압축 사슬 2단 — 조상을 끝까지 따라간다(공유 폴더에서도)", async () => {
  const d = path.join(tmp, "compact2"); fs.mkdirSync(d);
  const root = conv(d, u(1), ["뿌리 질문"], { mtime: 1000 });
  conv(d, u(2), ["가운데 질문"], { mtime: 2000, head: { type: "system", subtype: "compact_boundary", logicalParentUuid: `${u(1)}-m0` } });
  const cur = conv(d, u(3), ["지금"], { mtime: 3000, head: { type: "system", subtype: "compact_boundary", logicalParentUuid: `${u(2)}-m0` } });
  const chain = await resolveConvChain(claudeIo, localTranscriptFs, { curFile: cur, curUuid: u(3), curSize: sizeOf(cur), budget: 8 * MB, exclusive: false });
  assert.deepEqual(chain.map((c) => c.uuid), [u(1), u(2), u(3)]);
  assert.ok(root);
});

await t("[14] 압축 부모가 서로를 가리켜도(순환) 끝난다", async () => {
  const d = path.join(tmp, "cycle"); fs.mkdirSync(d);
  conv(d, u(1), ["하나"], { mtime: 1000, head: { type: "system", subtype: "compact_boundary", logicalParentUuid: `${u(2)}-m0` } });
  const cur = conv(d, u(2), ["둘"], { mtime: 2000, head: { type: "system", subtype: "compact_boundary", logicalParentUuid: `${u(1)}-m0` } });
  const chain = await resolveConvChain(claudeIo, localTranscriptFs, { curFile: cur, curUuid: u(2), curSize: sizeOf(cur), budget: 8 * MB, exclusive: false });
  assert.deepEqual(chain.map((c) => c.uuid), [u(1), u(2)]);
});

await t("[15] 사슬을 읽으면 **모든 대화의 질문**이 오래된 순으로 한 판에 담긴다", async () => {
  const chain = await resolveConvChain(claudeIo, localTranscriptFs, { ...base, exclusive: true });
  const { ndjson, from } = await readThinChain(claudeIo, localTranscriptFs, chain, 8 * MB, "t15");
  assert.deepEqual(saysOf(ndjson), ["첫 질문", "둘째 질문", "셋째 질문", "넷째 질문", "지금 질문"]);
  assert.equal(from, 0, "안 잘렸으면 0");
});

await t("[16] 파일 상한에 걸리면 꼬리부터 — from 이 그 사실을 알린다", async () => {
  const chain = await resolveConvChain(claudeIo, localTranscriptFs, { ...base, exclusive: true });
  //  상한을 지금 대화 크기에 맞추면 지금 대화는 온전하고, 그보다 큰 가장 오래된 대화만 꼬리부터 읽힌다.
  const { ndjson, from } = await readThinChain(claudeIo, localTranscriptFs, chain, base.curSize, "t16");
  assert.ok(from > 0, `가장 오래된 파일의 앞머리가 잘렸다(from=${from})`);
  assert.ok(saysOf(ndjson).includes("지금 질문"), "잘려도 지금 대화는 온전하다");
});

await t("[17] 끝난 대화는 두 번 읽어도 같은 답(캐시가 답을 바꾸지 않는다)", async () => {
  const chain = await resolveConvChain(claudeIo, localTranscriptFs, { ...base, exclusive: true });
  const a = await readThinChain(claudeIo, localTranscriptFs, chain, 8 * MB, "t17");
  const b = await readThinChain(claudeIo, localTranscriptFs, chain, 8 * MB, "t17");
  assert.deepEqual(saysOf(b.ndjson), saysOf(a.ndjson));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`harness-io/conv-chain: ${pass} passed`);

// #4810 — 한도 자동 이어감 대기의 재료를 대화 기록 **끝**에서 읽는 계약(readQuotaWait). 파일 찾기만 가짜로 갈아 끼우고, 읽기는 진짜
//  파일·진짜 claude 파서·진짜 창 정렬(readAlignedWindow)로 한다. 사양·엣지 표 R1~R5: 작업 스크래치 spec-4810.md.
//  틀리면 티가 크다:
//   🔴 창을 파일 앞에서 읽으면 — 몇 MB 짜리 대화(실측 25~67MB)에서 걸림 줄을 영영 못 본다.
//   🔴 읽기 실패를 «대기 없음» 으로 뭉개면 — 중계가 잠깐 막힌 판에 대기 중인 세션을 끈다(모르면 안 끈다).
import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readQuotaWait, QUOTA_TAIL_BYTES } from "./session-quota-wait.js";
import { claudeIo } from "../terminal/harness-io/claude.js";
import { localTranscriptFs, type TranscriptFs } from "../terminal/harness-io/transcript-fs.js";
import type { TranscriptTarget } from "../terminal/transcript-locate.js";

const T0 = Date.parse("2026-10-16T06:59:09.533Z");
const AT = { sinceMs: T0 - 3_600_000, nowMs: T0 + 180_000 };
const ARMED = JSON.stringify({ type: "system", subtype: "informational", content: "Usage limit reached · continuing automatically at 4:10pm · esc to cancel",
  isMeta: false, timestamp: new Date(T0).toISOString(), level: "notice" });
/** 대기를 접지 않는 줄(비용 기록) — 크기를 맞추려고 채운다. */
const filler = (n: number): string => JSON.stringify({ type: "cost-state", sessionId: "s", pad: "x".repeat(Math.max(0, n - 40)) });

const dir = mkdtempSync(path.join(tmpdir(), "quota-wait-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
function file(name: string, lines: string[]): string {
  const p = path.join(dir, name);
  writeFileSync(p, lines.map((l) => l + "\n").join(""));
  return p;
}
/** 파일 찾기 가짜 — 실제 찾기(transcript-locate)가 돌려주는 모양 그대로. */
const found = (p: string, o: { io?: typeof claudeIo; tfs?: TranscriptFs } = {}) => async (): Promise<TranscriptTarget> => ({
  ok: true, uuid: "c-1", mapped: "c-1", io: (o.io ?? claudeIo) as never, cwd: dir, tfs: o.tfs ?? localTranscriptFs,
  found: { file: p, size: statSync(p).size, via: "reported" },
});

test("R1 2MB 대화 — 걸림 줄이 끝에서 1MB 안이면 읽는다(창 시작이 줄 중간이어도 정렬해서)", async () => {
  const lines = [...Array.from({ length: 2100 }, () => filler(1000)), ARMED, ...Array.from({ length: 40 }, () => filler(1000))];
  const p = file("r1.jsonl", lines);
  assert.ok(statSync(p).size > 2 * QUOTA_TAIL_BYTES, "파일이 창의 두 배보다 크다(전제)");
  const w = await readQuotaWait("box-a-1", AT, found(p));
  assert.equal(w?.armedAtMs, T0);
});
test("R2 걸림 줄 뒤로 1MB 넘게 쌓였으면 못 본다 — 대기 없음(종전처럼 끈다)", async () => {
  const p = file("r2.jsonl", [ARMED, ...Array.from({ length: 1100 }, () => filler(1000))]);
  assert.ok(statSync(p).size > QUOTA_TAIL_BYTES, "걸림 줄이 창 밖이다(전제)");
  assert.equal(await readQuotaWait("box-a-1", AT, found(p)), null);
});
test("R3 대화 id 를 모름 · 파일을 못 찾음 · 못 읽는 하네스 → 대기 없음", async () => {
  for (const t of [{ ok: false, why: "no-uuid" }, { ok: false, why: "not-found" }, { ok: false, why: "unreadable", label: "x" }] as TranscriptTarget[]) {
    assert.equal(await readQuotaWait("box-a-1", AT, async () => t), null, JSON.stringify(t));
  }
});
test("R4 claude 가 아니면 파일을 읽지도 않는다 — 대기 없음", async () => {
  const p = file("r4.jsonl", [ARMED]);
  let reads = 0;
  const counting: TranscriptFs = { ...localTranscriptFs, read: (f, s, fn) => { reads++; return localTranscriptFs.read(f, s, fn); } };
  assert.equal(await readQuotaWait("box-a-1", AT, found(p, { io: { ...claudeIo, key: "codex" }, tfs: counting })), null);
  assert.equal(reads, 0);
  assert.equal((await readQuotaWait("box-a-1", AT, found(p, { tfs: counting })))?.armedAtMs, T0, "같은 파일을 claude 로는 읽는다(배선)");
  assert.equal(reads, 1);
});
test("R5 읽다가 실패하면(중계) 던진다 — «대기 없음» 으로 뭉개지 않는다", async () => {
  const p = file("r5.jsonl", [ARMED]);
  const broken: TranscriptFs = { ...localTranscriptFs, read: async () => { throw new Error("relay: 503"); } };
  await assert.rejects(readQuotaWait("box-a-1", AT, found(p, { tfs: broken })), /relay/);
});

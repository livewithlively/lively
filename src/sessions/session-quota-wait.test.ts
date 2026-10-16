// #4810 — 한도 자동 이어감 대기의 재료를 대화 기록 **끝**에서 읽는 계약(readQuotaWait). 파일 찾기만 가짜로 갈아 끼우고, 읽기는 진짜
//  파일·진짜 claude 파서·진짜 창 정렬(readAlignedWindow)로 한다. 사양·엣지 표 R1~R11: 작업 스크래치 spec-4810.md · R11~R19(#4821 ①): spec-4821.md.
//  틀리면 티가 크다:
//   🔴 창을 파일 앞에서 읽으면 — 몇 MB 짜리 대화(실측 25~67MB)에서 걸림 줄을 영영 못 본다.
//   🔴 읽기 실패를 «대기 없음» 으로 뭉개면 — 중계가 잠깐 막힌 판에 대기 중인 세션을 끈다(모르면 안 끈다).
//   🔴 같은 크기의 파일을 다시 읽으면 — 하루 대기에 1MB × 295회가 중계를 탄다 · 다시 안 읽되 시각 조건까지 안 다시 걸면 상한이 안 선다.
import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readQuotaWait, resetQuotaScanCache, QUOTA_TAIL_BYTES, QUOTA_SCAN_CACHE_MAX, QUOTA_OPENER_SCAN_BYTES } from "./session-quota-wait.js";
import { QUOTA_WAIT_MAX_MS } from "../terminal/harness-io/quota-wait.js";
import { claudeIo } from "../terminal/harness-io/claude.js";
import { localTranscriptFs, type TranscriptFs } from "../terminal/harness-io/transcript-fs.js";
import type { TranscriptTarget } from "../terminal/transcript-locate.js";

const T0 = Date.parse("2026-10-16T06:59:09.533Z");
const AT = { launchedAtMs: T0 - 3_600_000, nowMs: T0 + 180_000 };
const ARMED = JSON.stringify({ type: "system", subtype: "informational", content: "Usage limit reached · continuing automatically at 4:10pm · esc to cancel",
  isMeta: false, timestamp: new Date(T0).toISOString(), level: "notice" });
const HUMAN = JSON.stringify({ type: "user", message: { role: "user", content: "다시 해 줘" }, timestamp: new Date(T0 + 60_000).toISOString(), origin: { kind: "human" } });
/** 대기를 접지 않는 줄(비용 기록) — 크기를 맞추려고 채운다. */
const filler = (n: number): string => JSON.stringify({ type: "cost-state", sessionId: "s", pad: "x".repeat(Math.max(0, n - 40)) });

const dir = mkdtempSync(path.join(tmpdir(), "quota-wait-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
test.beforeEach(() => resetQuotaScanCache());
function file(name: string, lines: string[]): string {
  const p = path.join(dir, name);
  writeFileSync(p, lines.map((l) => l + "\n").join(""));
  return p;
}
/** 파일 찾기 가짜 — 실제 찾기(transcript-locate)가 돌려주는 모양 그대로(크기는 부를 때마다 다시 잰다). */
const found = (p: string, o: { io?: typeof claudeIo; tfs?: TranscriptFs } = {}) => async (): Promise<TranscriptTarget> => ({
  ok: true, uuid: "c-1", mapped: "c-1", io: (o.io ?? claudeIo) as never, cwd: dir, tfs: o.tfs ?? localTranscriptFs,
  found: { file: p, size: statSync(p).size, via: "reported" },
});
/** 읽기를 세는 파일 접근(진짜 로컬 읽기를 그대로 탄다). */
function counting(): { tfs: TranscriptFs; reads: () => number } {
  let n = 0;
  return { tfs: { ...localTranscriptFs, read: (f, s, fn) => { n++; return localTranscriptFs.read(f, s, fn); } }, reads: () => n };
}

// ── #4821 ① 도우미 — 이어 간 턴의 줄 모양은 실측(a7fd46ae·5c30e17b): 첫 줄(자동 이어감 메시지)에만 출처가 있고, 도구 결과·정리 안내엔 promptId 만 있다.
const PID = "a2f54353-020b-43b9-a5af-8fa53646c25e";
const AT_LONG = { launchedAtMs: T0 - 3_600_000, nowMs: T0 + 4_400_000 };
const FIRED_L = JSON.stringify({ type: "system", subtype: "informational", content: "Usage limit reset · continuing automatically", timestamp: new Date(T0 + 600_000).toISOString() });
const CONT_L = (pid = PID): string => JSON.stringify({ type: "user", isMeta: true, origin: { kind: "auto-continuation" }, turnOrigin: "auto_continuation", promptId: pid,
  timestamp: new Date(T0 + 600_200).toISOString(), message: { role: "user", content: "Your claude.ai usage limit has reset. …" } });
const HUMAN_OPENER = JSON.stringify({ type: "user", origin: { kind: "human" }, turnOrigin: "human", promptId: PID, timestamp: new Date(T0 + 600_200).toISOString(),
  message: { role: "user", content: "긴 작업 시작" } });
/** 그 턴의 도구 결과 줄(약 1KB) — 대기를 바꾸지 않는다. */
const fills = (n: number, pid = PID): string[] => Array.from({ length: n }, (_, i) => JSON.stringify({ type: "user", promptId: pid,
  timestamp: new Date(T0 + 700_000 + i).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "x".repeat(840) }] } }));
const WRAP_L = (pid = PID): string => JSON.stringify({ type: "user", isMeta: true, usageLimitNote: "wrap_up", promptId: pid, isSidechain: false,
  timestamp: new Date(T0 + 4_200_000).toISOString(), message: { role: "user", content: "[Usage limit reached; …]" } });
const END_L = JSON.stringify({ type: "system", subtype: "turn_duration", timestamp: new Date(T0 + 4_210_000).toISOString() });
const TASK_NOTE = JSON.stringify({ type: "user", origin: { kind: "task-notification" }, turnOrigin: "task_notification", promptId: "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
  timestamp: new Date(T0 + 4_300_000).toISOString(), message: { role: "user", content: "<task-notification>…</task-notification>" } });
/** 거슬러 찾기를 엿보는 파일 접근 — 인자를 남기고 진짜 로컬 구현(또는 주어진 답)을 탄다. 창 읽기도 센다. */
function spying(answer?: (file: string, promptId: string, before: number, maxBytes: number) => Promise<string | null>) {
  const calls: Array<{ file: string; promptId: string; before: number; maxBytes: number }> = [];
  let n = 0;
  const tfs: TranscriptFs = {
    ...localTranscriptFs,
    read: (f, s, fn) => { n++; return localTranscriptFs.read(f, s, fn); },
    turnOrigin: (file, promptId, before, maxBytes) => { calls.push({ file, promptId, before, maxBytes }); return (answer ?? localTranscriptFs.turnOrigin)(file, promptId, before, maxBytes); },
  };
  return { tfs, calls, reads: () => n };
}

test("R1 2MB 대화 — 걸림 줄이 끝에서 1MB 안이면 읽는다(창이 줄 중간에서 시작해도)", async () => {
  const lines = [...Array.from({ length: 2100 }, () => filler(1000)), ARMED, ...Array.from({ length: 40 }, () => filler(1000))];
  const p = file("r1.jsonl", lines);
  assert.ok(statSync(p).size > 2 * QUOTA_TAIL_BYTES, "파일이 창의 두 배보다 크다(전제)");
  const w = await readQuotaWait("box-a-1", AT, found(p));
  assert.equal(w?.atMs, T0);
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
  const c = counting();
  assert.equal(await readQuotaWait("box-a-1", AT, found(p, { io: { ...claudeIo, key: "codex" }, tfs: c.tfs })), null);
  assert.equal(c.reads(), 0);
  assert.equal((await readQuotaWait("box-a-1", AT, found(p, { tfs: c.tfs })))?.atMs, T0, "같은 파일을 claude 로는 읽는다(배선)");
  assert.equal(c.reads(), 1);
});
test("R5 읽다가 실패하면(중계) 던진다 — «대기 없음» 으로 뭉개지 않는다", async () => {
  const p = file("r5.jsonl", [ARMED]);
  const broken: TranscriptFs = { ...localTranscriptFs, read: async () => { throw new Error("relay: 503"); } };
  await assert.rejects(readQuotaWait("box-a-1", AT, found(p, { tfs: broken })), /relay/);
});
test("R6 크기가 그대로면 다시 읽지 않는다 — 그래도 시각 조건(상한)은 매번 다시 건다", async () => {
  const p = file("r6.jsonl", [ARMED]);
  const c = counting();
  assert.equal((await readQuotaWait("box-a-1", AT, found(p, { tfs: c.tfs })))?.atMs, T0);
  assert.equal((await readQuotaWait("box-a-1", { ...AT, nowMs: T0 + 3_600_000 }, found(p, { tfs: c.tfs })))?.atMs, T0);
  assert.equal(c.reads(), 1, "두 번째는 읽지 않았다");
  assert.equal(await readQuotaWait("box-a-1", { ...AT, nowMs: T0 + QUOTA_WAIT_MAX_MS + 1 }, found(p, { tfs: c.tfs })), null, "상한이 지나면 읽지 않고도 대기 아님");
  assert.equal(c.reads(), 1);
});
test("R7 크기가 바뀌면 다시 읽는다 — 그사이 사람이 말을 보냈으면 대기 아님", async () => {
  const p = file("r7.jsonl", [ARMED]);
  const c = counting();
  assert.equal((await readQuotaWait("box-a-1", AT, found(p, { tfs: c.tfs })))?.atMs, T0);
  appendFileSync(p, HUMAN + "\n");
  assert.equal(await readQuotaWait("box-a-1", AT, found(p, { tfs: c.tfs })), null);
  assert.equal(c.reads(), 2);
});
test("R8 같은 세션이라도 파일이 바뀌면(맥락 압축 — 새 대화 파일) 크기가 같아도 다시 읽는다", async () => {
  const a = file("r8a.jsonl", [ARMED]);
  const b = file("r8b.jsonl", [ARMED.replace("4:10pm", "9:99pm")]);   // 같은 길이 · 다른 파일
  assert.equal(statSync(a).size, statSync(b).size, "크기가 같다(전제)");
  const c = counting();
  await readQuotaWait("box-a-1", AT, found(a, { tfs: c.tfs }));
  const w = await readQuotaWait("box-a-1", AT, found(b, { tfs: c.tfs }));
  assert.equal(c.reads(), 2);
  assert.match(w?.text ?? "", /9:99pm/);
});
test("R9 기억은 상한(500)까지 — 넘치면 가장 오래 안 쓴 것부터 버린다(쓴 것은 뒤로 간다)", async () => {
  const p = file("r9.jsonl", [ARMED]);
  const c = counting();
  const ask = (i: number) => readQuotaWait(`box-r9-${i}`, AT, found(p, { tfs: c.tfs }));
  for (let i = 0; i < QUOTA_SCAN_CACHE_MAX; i++) await ask(i);
  assert.equal(c.reads(), QUOTA_SCAN_CACHE_MAX);
  await ask(0);                       // 0 을 다시 써서 뒤로 보낸다(읽지 않는다)
  assert.equal(c.reads(), QUOTA_SCAN_CACHE_MAX);
  await ask(QUOTA_SCAN_CACHE_MAX);    // 501번째 — 가장 오래 안 쓴 1 이 밀려난다
  await ask(0);
  assert.equal(c.reads(), QUOTA_SCAN_CACHE_MAX + 1, "0 은 남아 있다");
  await ask(1);
  assert.equal(c.reads(), QUOTA_SCAN_CACHE_MAX + 2, "1 은 밀려나 다시 읽었다");
});
test("R10 크기가 있는 파일에서 한 바이트도 못 받으면(중계가 실패를 삼킴) 못 읽은 것이다 — 던지고 기억하지 않는다", async () => {
  const p = file("r10.jsonl", [ARMED]);
  const empty: TranscriptFs = { ...localTranscriptFs, read: (_f, _s, fn) => fn({ read: async () => Buffer.alloc(0) }) };
  await assert.rejects(readQuotaWait("box-a-1", AT, found(p, { tfs: empty })), /못 읽음/);
  assert.equal((await readQuotaWait("box-a-1", AT, found(p)))?.atMs, T0, "다음엔 제대로 읽는다(빈 결과를 기억하지 않았다)");
});
test("R11 이어 간 턴이 창(1MB)보다 길어도 — 그 턴의 첫 줄을 거슬러 찾아 정리 안내로 다시 걸린 것을 본다(#4821 ①, #4810 의 특성화 시험을 뒤집음)", async () => {
  const short = file("r11s.jsonl", [ARMED, FIRED_L, CONT_L(), ...fills(300), WRAP_L(), END_L]);
  const cs = spying();
  assert.equal((await readQuotaWait("box-r11s", AT_LONG, found(short, { tfs: cs.tfs })))?.kind, "armed", "짧은 이어 간 턴(0.3MB)은 창 안에서 본다");
  assert.equal(cs.calls.length, 0, "창 안에 첫 줄이 있으면 거슬러 찾지 않는다");
  const long = file("r11l.jsonl", [ARMED, FIRED_L, CONT_L(), ...fills(1200), WRAP_L(), END_L]);
  assert.ok(statSync(long).size > QUOTA_TAIL_BYTES + 100_000, "이어 간 턴이 창보다 길다(전제)");
  const c = spying();
  const w = await readQuotaWait("box-r11l", AT_LONG, found(long, { tfs: c.tfs }));
  assert.equal(w?.kind, "armed", "긴 이어 간 턴(1.2MB)도 다시 걸림을 본다");
  assert.equal(w?.atMs, T0 + 4_200_000, "시각 = 정리 안내 줄");
  assert.equal(c.calls.length, 1, "첫 줄을 한 번 거슬러 찾았다(배선)");
});
test("R12 거슬러 찾은 첫 줄의 출처가 사람이면 — 대기 없음(사람 턴의 첫 걸림은 턴 뒤 걸림 줄로 읽는다)", async () => {
  const p = file("r12.jsonl", [HUMAN_OPENER, ...fills(1200), WRAP_L(), END_L]);
  const c = spying();
  assert.equal(await readQuotaWait("box-r12", AT_LONG, found(p, { tfs: c.tfs })), null);
  assert.equal(c.calls.length, 1);
});
test("R13 창 판정이 이미 대기면 거슬러 찾지 않는다", async () => {
  const lines = [...Array.from({ length: 2100 }, () => filler(1000)), ARMED, ...Array.from({ length: 40 }, () => filler(1000))];
  const c = spying();
  assert.equal((await readQuotaWait("box-r13", AT, found(file("r13.jsonl", lines), { tfs: c.tfs })))?.atMs, T0);
  assert.equal(c.calls.length, 0);
});
test("R14 이어 간 턴으로 가정해도 대기가 아니면(정리 안내 없음) · 창 맨 앞 턴을 모르면 거슬러 찾지 않는다", async () => {
  const c = spying();
  assert.equal(await readQuotaWait("box-r14a", AT_LONG, found(file("r14a.jsonl", [ARMED, FIRED_L, CONT_L(), ...fills(1200), END_L]), { tfs: c.tfs })), null);
  //  창 안 첫 promptId 줄이 턴의 첫 줄(사람 말)이다 — 창 앞에서 열린 턴이 없다. 그 사람 턴이 정리 안내로 끝나도 걸림 줄이 없으면 대기 아님.
  const Q = "0d9c8b7a-6f5e-4d3c-9b2a-1f0e9d8c7b6a";
  const humanQ = JSON.stringify({ ...JSON.parse(HUMAN_OPENER), promptId: Q });
  assert.equal(await readQuotaWait("box-r14b", AT_LONG, found(file("r14b.jsonl", [ARMED, ...Array.from({ length: 1200 }, () => filler(1000)), humanQ, ...fills(5, Q), WRAP_L(Q), END_L]), { tfs: c.tfs })), null);
  assert.equal(c.calls.length, 0);
});
test("R15 거슬러 찾는 인자 — 그 파일 · 그 턴의 promptId · 창 시작(줄 경계) · 상한 128MB", async () => {
  const p = file("r15.jsonl", [ARMED, FIRED_L, CONT_L(), ...fills(1200), WRAP_L(), END_L]);
  const c = spying();
  await readQuotaWait("box-r15", AT_LONG, found(p, { tfs: c.tfs }));
  const [a] = c.calls;
  const size = statSync(p).size;
  assert.equal(a.file, p);
  assert.equal(a.promptId, PID);
  assert.equal(QUOTA_OPENER_SCAN_BYTES, 128 * 1024 * 1024);
  assert.equal(a.maxBytes, QUOTA_OPENER_SCAN_BYTES);
  assert.ok(a.before >= size - QUOTA_TAIL_BYTES && a.before < size - QUOTA_TAIL_BYTES + 1_100, `창 시작 근처(${a.before})`);
  assert.equal(readFileSync(p).subarray(a.before - 1, a.before).toString(), "\n", "창 시작은 줄 경계다");
});
test("R16 같은 세션·파일·턴은 다시 찾지 않는다 — 대기 중 작업 알림으로 파일이 자라 창을 다시 읽어도", async () => {
  const p = file("r16.jsonl", [ARMED, FIRED_L, CONT_L(), ...fills(1200), WRAP_L(), END_L]);
  const c = spying();
  assert.equal((await readQuotaWait("box-r16", AT_LONG, found(p, { tfs: c.tfs })))?.kind, "armed");
  appendFileSync(p, [TASK_NOTE, END_L].map((l) => l + "\n").join(""));
  assert.equal((await readQuotaWait("box-r16", AT_LONG, found(p, { tfs: c.tfs })))?.kind, "armed", "작업 알림 턴은 대기를 접지 않는다");
  assert.equal(c.reads(), 2, "창은 다시 읽었다(크기가 바뀜)");
  assert.equal(c.calls.length, 1, "첫 줄은 다시 찾지 않았다");
});
test("R17 거슬러 찾다 실패하면(중계) 던진다 — 기억하지 않아 다음 판엔 다시 찾는다", async () => {
  const p = file("r17.jsonl", [ARMED, FIRED_L, CONT_L(), ...fills(1200), WRAP_L(), END_L]);
  const broken: TranscriptFs = { ...localTranscriptFs, turnOrigin: async () => { throw new Error("relay: 503"); } };
  await assert.rejects(readQuotaWait("box-r17", AT_LONG, found(p, { tfs: broken })), /relay/);
  const c = spying();
  assert.equal((await readQuotaWait("box-r17", AT_LONG, found(p, { tfs: c.tfs })))?.kind, "armed");
  assert.equal(c.calls.length, 1);
});
test("R18 못 찾음(상한 밖 등)도 기억한다 — 대기 없음 · 파일이 자라도 다시 찾지 않는다", async () => {
  const p = file("r18.jsonl", [ARMED, FIRED_L, CONT_L(), ...fills(1200), WRAP_L(), END_L]);
  const c = spying(async () => null);
  assert.equal(await readQuotaWait("box-r18", AT_LONG, found(p, { tfs: c.tfs })), null);
  appendFileSync(p, TASK_NOTE + "\n");
  assert.equal(await readQuotaWait("box-r18", AT_LONG, found(p, { tfs: c.tfs })), null);
  assert.equal(c.calls.length, 1);
});
test("R19 promptId 가 없는 옛 형식의 긴 이어 간 턴은 — 거슬러 찾지 않고 대기 없음(종전)", async () => {
  const strip = (l: string): string => { const o = JSON.parse(l); delete o.promptId; return JSON.stringify(o); };
  const p = file("r19.jsonl", [ARMED, FIRED_L, strip(CONT_L()), ...Array.from({ length: 1200 }, () => filler(1000)), strip(WRAP_L()), END_L]);
  const c = spying();
  assert.equal(await readQuotaWait("box-r19", AT_LONG, found(p, { tfs: c.tfs })), null);
  assert.equal(c.calls.length, 0);
});

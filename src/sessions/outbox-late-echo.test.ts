// 늦은 에코(#4819) — «보냈지만 세션 기록에서 확인되지 않았어요» 를 기록과 다시 대조하는 서버 몫. 실 DB·실 파일은 안 띄운다.
//  사양·엣지 표: 아래 이름의 기호(C·M·F·R·W)가 그 표의 행이다 — 행마다 최소 한 시나리오.
//   C 대상 고르기 · M 무엇이 «그 말이 들어갔다» 의 증거인가 · F 어디까지 읽나 · R 언제 다시 재고 무엇을 바꾸나 · W 배선·번들 경계
//  F 는 진짜 줄 맞춤(readAlignedWindow — alignedSource)과 진짜 claude 해석기(harness-io/adapter)를 메모리 버퍼 위에서 돌린다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { harnessIo } from "../terminal/harness-io/adapter.js";
import type { OutboxRow } from "./session-outbox.js";
import {
  alignedSource, findPromptInTranscript, lateEchoCandidate, lateEchoDue, listOutboxReconciled, promptTextOfLine, reconcileLateEchoes,
  resetLateEchoMemoForTest, samePrompt, scanLinesForPrompt, LATE_ECHO_HEAD, LATE_ECHO_MIN_GAP_MS, LATE_ECHO_RETRY_MS, LATE_ECHO_SKEW_MS,
  type EchoSource, type ReconcileDeps,
} from "./outbox-late-echo.js";

let pass = 0;
const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>): void => { tests.push([name, fn]); };

// ── 재료 — 실측 행 131295(세션 c3d46537)의 모양 ─────────────────────────────────────────
const QUEUED = "2026-10-16T07:58:32.321Z";
const NOT_BEFORE = Date.parse(QUEUED) - LATE_ECHO_SKEW_MS;
const SAID = "자료 공개범위 설정 끈 곳에는 전체에게 보이게해. 단, 이거는 공개범위 설정여부와 무관하게 먼저 검토하면 되는 일이잖아.";
const L = (o: object): string => JSON.stringify(o) + "\n";
const user = (text: string, ts: string, extra: object = {}): string => L({ type: "user", timestamp: ts, message: { role: "user", content: text }, ...extra });
const userBlocks = (text: string, ts: string): string => L({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } });
const ai = (text: string, ts: string): string => L({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } });
const toolResult = (text: string, ts: string): string =>
  L({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: text }] } });
const queued = (text: string, ts: string): string =>
  L({ type: "attachment", timestamp: ts, attachment: { type: "queued_command", prompt: text, commandMode: "prompt", origin: { kind: "human" } } });
const blob = (text: string): string => L({ type: "api-request-blob", sessionId: "e8a2", hash: "2505", message: { role: "user", content: text } });
const hook = (name: string, ts: string): string =>
  L({ type: "attachment", timestamp: ts, attachment: { type: "hook_success", hookName: name, content: "<persisted-output>" + "맥락".repeat(80) } });
const OLD = user("예전에 물어본 말", "2026-10-16T07:40:00Z") + ai("예전 답", "2026-10-16T07:40:05Z");
//  ★ 실측 순서 그대로 — 사람 말 줄(07:59:07)은 훅이 끝나고 요청이 나간 **뒤**(07:59:31 줄 다음)에 파일에 적혔다.
const C3D = OLD
  + hook("SessionStart:resume", "2026-10-16T07:59:05.445Z")
  + blob(SAID) + L({ type: "api-request-blob", message: { role: "system", content: [{ type: "text", text: "SessionStart:resume hook success" }] } })
  + L({ type: "api-request", timestamp: "2026-10-16T07:59:31.924Z", sessionId: "e8a2" })
  + user(SAID, "2026-10-16T07:59:07.361Z")
  + L({ type: "attachment", timestamp: "2026-10-16T07:59:07.357Z", attachment: { type: "edited_text_file", filename: "/work/x.ts", snippet: "" } })
  + hook("UserPromptSubmit", "2026-10-16T07:59:29.828Z")
  + ai("반영했습니다.", "2026-10-16T08:02:29.881Z");

const claudeParse = harnessIo("claude")!.parse!;
/** 메모리 버퍼 위의 진짜 기록 — 읽은 구간을 log 에 남긴다(무엇을 읽었나가 곧 비용이다). */
function memSource(file: string, text: string, log: Array<[number, number]> = [], maxWindows = 500): EchoSource {
  const buf = Buffer.from(text, "utf8");
  let windows = 0;
  const src = alignedSource(file, buf.length,
    async (fn) => fn({ async read(s, e) { log.push([s, e]); return buf.subarray(s, Math.min(e, buf.length)); } }),
    (txt) => claudeParse(txt, {}).lines);
  return { ...src, async window(s, e) { if (++windows > maxWindows) throw new Error("창을 너무 많이 열었다(무한 반복?)"); return src.window(s, e); } };
}
const readBytes = (log: Array<[number, number]>): number => log.reduce((n, [s, e]) => n + (e - s), 0);
const row = (o: Partial<OutboxRow> = {}): OutboxRow => ({
  id: 131295, session_id: "box-c3d", seq: 3, text: SAID, status: "sent", kind: "prompt", attempts: 0, trust_ok: false,
  last_error: "echo-unconfirmed", created_at: QUEUED, updated_at: "2026-10-16T07:59:29.849Z", delivered_at: null, stalled_since: null, ...o,
});

// ── C — 다시 대조할 대상 ───────────────────────────────────────────────────────────
t("C1 sent·echo-unconfirmed(사람 말) → 대상", () => assert.equal(lateEchoCandidate(row()), true));
t("C2 failed·send: host-unknown(호스트가 쳤는지 모름 — 같은 15초 창) → 대상", () =>
  assert.equal(lateEchoCandidate(row({ status: "failed", last_error: "send: host-unknown" })), true));
t("C3 sent·echo-unreadable · sent·control-no-echo → 대상 아님", () => {
  assert.equal(lateEchoCandidate(row({ last_error: "echo-unreadable" })), false);
  assert.equal(lateEchoCandidate(row({ last_error: "control-no-echo" })), false);
});
t("C4 치지도 않은 실패·대기·전달됨 → 대상 아님", () => {
  for (const [status, last_error] of [["failed", "not-ready"], ["failed", "session-gone"], ["failed", "send: text"], ["queued", null], ["sending", null], ["delivered", null]] as const) {
    assert.equal(lateEchoCandidate(row({ status, last_error })), false, `${status}/${last_error}`);
  }
});
t("C5 설정 명령(control)은 sent·echo-unconfirmed 여도 대상 아님", () => assert.equal(lateEchoCandidate(row({ kind: "control" })), false));

// ── M — 무엇이 증거인가 ─────────────────────────────────────────────────────────────
const one = (line: string): unknown => JSON.parse(line);
const after = "2026-10-16T07:59:07.361Z";
t("M1 사람 말 줄(문자열 본문) · 같은 글 · 큐 뒤 → 증거(그 줄의 시각)", () => {
  const r = scanLinesForPrompt([one(user(SAID, after))], SAID, NOT_BEFORE);
  assert.deepEqual([r.found, r.at], [true, after]);
});
t("M2 사람 말 줄(text 블록 배열) → 증거", () => assert.equal(scanLinesForPrompt([one(userBlocks(SAID, after))], SAID, NOT_BEFORE).found, true));
t("M3 도는 중 끼워 넣은 말(attachment queued_command) → 증거", () => assert.equal(scanLinesForPrompt([one(queued(SAID, after))], SAID, NOT_BEFORE).found, true));
t("M4 같은 글이 큐보다 앞(같은 지시를 두 번 보냄) → 증거 아님", () =>
  assert.equal(scanLinesForPrompt([one(user(SAID, "2026-10-16T07:41:00Z"))], SAID, NOT_BEFORE).found, false));
t("M5 경계 — 정확히 큐−5초는 증거 · 그 1ms 앞은 아님", () => {
  assert.equal(scanLinesForPrompt([one(user(SAID, new Date(NOT_BEFORE).toISOString()))], SAID, NOT_BEFORE).found, true);
  assert.equal(scanLinesForPrompt([one(user(SAID, new Date(NOT_BEFORE - 1).toISOString()))], SAID, NOT_BEFORE).found, false);
});
t("M6 AI 답 · 도구 결과 · 주입(isMeta) · 서브에이전트 가지 · 시각 없는 요청 사본에 같은 글 → 증거 아님", () => {
  const lines = [ai(SAID, after), toolResult(SAID, after), user(SAID, after, { isMeta: true }), user(SAID, after, { isSidechain: true }), blob(SAID)].map(one);
  assert.equal(scanLinesForPrompt(lines, SAID, NOT_BEFORE).found, false);
  for (const l of lines) assert.equal(promptTextOfLine(l), null, JSON.stringify(l).slice(0, 60));
});
t("M7 공백 차이(개행↔공백 · 겹공백 · 앞뒤 공백)는 같은 말", () => {
  assert.equal(samePrompt("첫 줄\n둘째  줄 ", " 첫 줄 둘째 줄"), true);
  assert.equal(scanLinesForPrompt([one(user("첫 줄 둘째 줄", after))], "첫 줄\n\n둘째 줄", NOT_BEFORE).found, true);
});
t("M8 짧은 말이 더 긴 줄의 머리일 뿐이면 다른 말(«진행해» ≠ «진행해줘»)", () => {
  assert.equal(samePrompt("진행해", "진행해줘"), false);
  assert.equal(samePrompt("진행해줘", "진행해"), false);
});
t("M9 긴 말(>160) — 꼬리가 뒤섞여도 머리 160자가 같으면 같은 말 · 머리가 다르면 다른 말", () => {
  const head = "가".repeat(LATE_ECHO_HEAD);
  assert.equal(samePrompt(head + " 꼬리 원문", head + " 리꼬 뒤섞임"), true);
  assert.equal(samePrompt("나" + head + " 꼬리", "다" + head + " 꼬리"), false);
});
t("M10 경계 — 정확히 160자는 전체 일치가 필요 · 161자부터 머리 160자", () => {
  const s160 = "라".repeat(LATE_ECHO_HEAD);
  assert.equal(samePrompt(s160, s160 + " 덧붙임"), false, "160자 — 줄이 더 길면 다른 말");
  assert.equal(samePrompt(s160 + "마", s160 + "바 덧붙임"), true, "161자 — 머리 160자가 같으면 같은 말");
});
t("M11 빈 말 · 글 없는 줄은 증거 아님(새 헬퍼의 빈 입력)", () => {
  assert.equal(samePrompt("", ""), false);
  assert.equal(samePrompt("   ", " "), false);
  assert.equal(scanLinesForPrompt([one(user("", after))], "", NOT_BEFORE).found, false);
  assert.equal(promptTextOfLine(null), null);
  assert.equal(promptTextOfLine(42), null);
});
t("M12 시각이 없거나 깨진 줄은 증거 아님 — 가장 이른 시각에도 안 센다", () => {
  const noTs = one(L({ type: "user", message: { role: "user", content: SAID } }));
  const badTs = one(L({ type: "user", timestamp: "어제", message: { role: "user", content: SAID } }));
  const r = scanLinesForPrompt([noTs, badTs], SAID, NOT_BEFORE);
  assert.deepEqual([r.found, r.earliestMs], [false, null]);
});

// ── F — 어디까지 읽나 ─────────────────────────────────────────────────────────────
t("F1 실측 모양(c3d46537): 요청 사본·훅 줄·뒤늦게 적힌 사람 말 → 찾음 · 시각은 사람 말 줄의 것", async () => {
  const r = await findPromptInTranscript(memSource("c3d.jsonl", C3D), SAID, NOT_BEFORE, null);
  assert.deepEqual([r.found, r.at], [true, "2026-10-16T07:59:07.361Z"]);
});
const fillAfter = (n: number): string => Array.from({ length: n }, (_, i) => ai(`작업 ${i} — ` + "결과".repeat(40), `2026-10-16T08:0${i % 10}:00Z`)).join("");
t("F2 그 말이 창 하나보다 멀리(앞쪽) → 거슬러 여러 창을 읽어 찾는다", async () => {
  const log: Array<[number, number]> = [];
  const r = await findPromptInTranscript(memSource("f2.jsonl", OLD + user(SAID, after) + fillAfter(15), log), SAID, NOT_BEFORE, null, { windowBytes: 512 });
  assert.equal(r.found, true);
  assert.ok(new Set(log.map(([s]) => s)).size > 2, `창 여러 개를 읽었어야 한다: ${log.length}`);
});
t("F3 옛 같은 말만 있다 → 못 찾음 · 큐 시각을 지나면 더 안 읽는다(파일 전체를 안 읽음)", async () => {
  const older = Array.from({ length: 60 }, (_, i) => ai(`옛 작업 ${i} ` + "기록".repeat(40), `2026-10-16T07:${String(i % 40).padStart(2, "0")}:00Z`)).join("");
  const text = older + user(SAID, "2026-10-16T07:41:00Z") + ai("그때 답", "2026-10-16T07:41:05Z") + fillAfter(6);
  const log: Array<[number, number]> = [];
  const r = await findPromptInTranscript(memSource("f3.jsonl", text, log), SAID, NOT_BEFORE, null, { windowBytes: 1024 });
  assert.equal(r.found, false);
  const size = Buffer.byteLength(text);
  assert.ok(Math.min(...log.map(([s]) => s)) > size * 0.6, `큐 앞까지만 읽었어야 한다: 가장 앞 ${Math.min(...log.map(([s]) => s))} / ${size}`);
});
t("F4 그 말이 상한보다 멀리 → 못 찾음(«미확인» 유지) · 읽은 양은 상한 근처에서 멈춘다", async () => {
  const log: Array<[number, number]> = [];
  const text = OLD + user(SAID, after) + fillAfter(40);
  const r = await findPromptInTranscript(memSource("f4.jsonl", text, log), SAID, NOT_BEFORE, null, { windowBytes: 512, scanBytes: 2048 });
  assert.equal(r.found, false);
  assert.ok(readBytes(log) < 2048 + 2 * 512, `상한을 넘겨 읽었다: ${readBytes(log)}`);
});
t("F5 처음엔 아직 안 적힘 → 다음 대조는 자란 부분만 읽고 찾는다", async () => {
  const v1 = OLD + hook("SessionStart:resume", "2026-10-16T07:59:05.445Z");
  const r1 = await findPromptInTranscript(memSource("f5.jsonl", v1), SAID, NOT_BEFORE, null);
  assert.deepEqual([r1.found, r1.scannedTo], [false, Buffer.byteLength(v1)]);
  const log: Array<[number, number]> = [];
  const r2 = await findPromptInTranscript(memSource("f5.jsonl", v1 + user(SAID, after) + ai("답", "2026-10-16T08:00:00Z"), log), SAID, NOT_BEFORE,
    { file: "f5.jsonl", scannedTo: r1.scannedTo, at: 0 });
  assert.equal(r2.found, true);
  assert.ok(Math.min(...log.map(([s]) => s)) >= r1.scannedTo - 1, `지난번 앞을 다시 읽었다: ${JSON.stringify(log)}`);
});
t("F6 파일 끝이 쓰는 중인 반 줄 → 그 줄은 안 센다 · 다 적힌 뒤 찾는다", async () => {
  const head = OLD + hook("SessionStart:resume", "2026-10-16T07:59:05.445Z");
  const full = user(SAID, after);
  const r1 = await findPromptInTranscript(memSource("f6.jsonl", head + full.slice(0, 40)), SAID, NOT_BEFORE, null);
  assert.deepEqual([r1.found, r1.scannedTo], [false, Buffer.byteLength(head)]);
  const r2 = await findPromptInTranscript(memSource("f6.jsonl", head + full), SAID, NOT_BEFORE, { file: "f6.jsonl", scannedTo: r1.scannedTo, at: 0 });
  assert.equal(r2.found, true);
});
t("F7 그 말과 끝 사이에 창보다 긴 한 줄 → 그래도 찾는다(무한 반복 없음)", async () => {
  const text = OLD + user(SAID, after) + toolResult("큰출력".repeat(2000), "2026-10-16T08:00:00Z") + ai("끝", "2026-10-16T08:01:00Z");
  const r = await findPromptInTranscript(memSource("f7.jsonl", text, [], 200), SAID, NOT_BEFORE, null, { windowBytes: 1024, scanBytes: 1024 * 1024 });
  assert.equal(r.found, true);
});
t("F8 파일이 바뀌었다(압축 뒤 새 파일) → 기억을 버리고 새 파일을 끝에서부터 다시", async () => {
  const text = user(SAID, after) + ai("답", "2026-10-16T08:00:00Z");
  const r = await findPromptInTranscript(memSource("new.jsonl", text), SAID, NOT_BEFORE, { file: "old.jsonl", scannedTo: Buffer.byteLength(text), at: 0 });
  assert.equal(r.found, true);
});
t("F9 빈 파일 → 못 찾음 · 오류 없음", async () => {
  const r = await findPromptInTranscript(memSource("empty.jsonl", ""), SAID, NOT_BEFORE, null);
  assert.deepEqual([r.found, r.scannedTo], [false, 0]);
});

// ── R — 언제 다시 재고 무엇을 바꾸나 ─────────────────────────────────────────────────
interface Fake { deps: ReconcileDeps; sourceCalls: number; settled: Array<[string, number, string | null]>; clock: { now: number } }
function fake(o: { text?: string | null; settleOk?: boolean; throwSource?: boolean; rows?: OutboxRow[]; slow?: Promise<void>; settleThrows?: boolean } = {}): Fake {
  const f: Fake = { sourceCalls: 0, settled: [], clock: { now: Date.parse("2026-10-16T09:00:00Z") }, deps: null as unknown as ReconcileDeps };
  f.deps = {
    list: async () => o.rows ?? [row()],
    source: async () => {
      f.sourceCalls++;
      if (o.slow) await o.slow;
      if (o.throwSource) throw new Error("중계 503");
      return o.text === null ? null : memSource("c3d.jsonl", o.text ?? C3D);
    },
    settle: async (sid, id, at) => { if (o.settleThrows) throw new Error("DB"); f.settled.push([sid, id, at]); return o.settleOk ?? true; },
    now: () => f.clock.now,
  };
  return f;
}
t("R1 기록에 있다 → 바로잡는다(세션 · 행 · 그 줄의 시각) · 바로잡은 행을 돌려준다", async () => {
  resetLateEchoMemoForTest();
  const f = fake();
  const got = await reconcileLateEchoes("box-c3d", [row()], f.deps);
  assert.deepEqual([...got], [131295]);
  assert.deepEqual(f.settled, [["box-c3d", 131295, "2026-10-16T07:59:07.361Z"]]);
});
t("R2 바로잡기가 거절됐다(사람이 그새 다시 보내기·지우기) → 돌려주지 않는다", async () => {
  resetLateEchoMemoForTest();
  const f = fake({ settleOk: false });
  const got = await reconcileLateEchoes("box-c3d", [row()], f.deps);
  assert.deepEqual([[...got], f.settled.length], [[], 1]);
});
t("R3 기록을 못 찾는다 → 안 바꾼다 · 30초 안엔 다시 안 연다 · 30초 뒤 다시", async () => {
  resetLateEchoMemoForTest();
  const f = fake({ text: null });
  assert.equal((await reconcileLateEchoes("s", [row()], f.deps)).size, 0);
  f.clock.now += LATE_ECHO_RETRY_MS - 1; await reconcileLateEchoes("s", [row()], f.deps);
  assert.equal(f.sourceCalls, 1);
  f.clock.now += 1; await reconcileLateEchoes("s", [row()], f.deps);
  assert.deepEqual([f.sourceCalls, f.settled.length], [2, 0]);
});
t("R4 못 찾음 → 5초 안엔 다시 안 연다 · 안 자라면 간격 두 배 · 자라면 다시 5초", async () => {
  resetLateEchoMemoForTest();
  let text = OLD + hook("SessionStart:resume", "2026-10-16T07:59:05.445Z");
  const f = fake();
  f.deps.source = async () => { f.sourceCalls++; return memSource("r4.jsonl", text); };
  await reconcileLateEchoes("s", [row()], f.deps);                                   // 1회
  f.clock.now += LATE_ECHO_MIN_GAP_MS - 1; await reconcileLateEchoes("s", [row()], f.deps);
  assert.equal(f.sourceCalls, 1, "5초 안");
  f.clock.now += 1; await reconcileLateEchoes("s", [row()], f.deps);                // 2회 — 안 자람 → 다음 간격 10초
  assert.equal(f.sourceCalls, 2);
  f.clock.now += 2 * LATE_ECHO_MIN_GAP_MS - 1; await reconcileLateEchoes("s", [row()], f.deps);
  assert.equal(f.sourceCalls, 2, "두 배 간격 안");
  f.clock.now += 1; text += ai("다른 일", "2026-10-16T08:00:00Z");
  await reconcileLateEchoes("s", [row()], f.deps);                                   // 3회 — 자람 → 다음 간격 5초
  assert.equal(f.sourceCalls, 3);
  f.clock.now += LATE_ECHO_MIN_GAP_MS; text += user(SAID, after);
  const got = await reconcileLateEchoes("s", [row()], f.deps);                       // 4회 — 찾음
  assert.deepEqual([f.sourceCalls, [...got]], [4, [131295]]);
  assert.equal(lateEchoDue({ at: 0, gap: 60_000 }, 59_999), false);
});
t("R5 대상 아닌 행뿐이면 기록을 아예 안 연다", async () => {
  resetLateEchoMemoForTest();
  const f = fake();
  const got = await reconcileLateEchoes("s", [row({ status: "queued", last_error: null }), row({ id: 2, status: "failed", last_error: "not-ready" })], f.deps);
  assert.deepEqual([got.size, f.sourceCalls], [0, 0]);
});
t("R6 기록 읽기가 던진다 → 아무것도 안 바꾸고 던지지 않는다 · 30초 뒤 다시", async () => {
  resetLateEchoMemoForTest();
  const f = fake({ throwSource: true });
  assert.equal((await reconcileLateEchoes("s", [row()], f.deps)).size, 0);
  f.clock.now += LATE_ECHO_RETRY_MS - 1; await reconcileLateEchoes("s", [row()], f.deps);
  assert.equal(f.sourceCalls, 1);
  f.clock.now += 1; await reconcileLateEchoes("s", [row()], f.deps);
  assert.equal(f.sourceCalls, 2);
});
t("R7 같은 행을 동시에 두 번 → 기록은 한 번만 연다", async () => {
  resetLateEchoMemoForTest();
  let release!: () => void;
  const f = fake({ slow: new Promise<void>((z) => { release = z; }) });
  const a = reconcileLateEchoes("s", [row()], f.deps);
  const b = await reconcileLateEchoes("s", [row()], f.deps);
  release();
  const ga = await a;
  assert.deepEqual([f.sourceCalls, b.size, ga.size], [1, 0, 1]);
});
t("R8 목록 — 대상 없으면 그대로(기록 안 엶) · 찾은 행만 빠진다 · 대조가 던져도 목록은 나간다", async () => {
  resetLateEchoMemoForTest();
  const plain = [row({ status: "queued", last_error: null })];
  const f0 = fake({ rows: plain });
  assert.deepEqual([await listOutboxReconciled("s", f0.deps), f0.sourceCalls], [plain, 0]);
  resetLateEchoMemoForTest();
  const mixed = [row(), row({ id: 7, seq: 4, text: "다른 말", status: "queued", last_error: null })];
  const f1 = fake({ rows: mixed });
  assert.deepEqual((await listOutboxReconciled("s", f1.deps)).map((r) => r.id), [7]);
  resetLateEchoMemoForTest();
  const f2 = fake({ rows: mixed, settleThrows: true });
  assert.deepEqual((await listOutboxReconciled("s", f2.deps)).map((r) => r.id), [131295, 7]);
});

// ── W — 배선 · 번들 경계 ──────────────────────────────────────────────────────────
const src = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
t("W1 대화창의 큐 조회 경로(GET …/outbox)가 재대조 목록을 준다", () => {
  const s = src("src/terminal/chat-routes.ts");
  const at = s.indexOf('app.get("/api/ui/terminal/sessions/:id/outbox"');
  assert.ok(at >= 0, "라우트를 못 찾았다");
  const body = s.slice(at, s.indexOf("app.post(", at));
  assert.match(body, /listOutboxReconciled\(id\)/);
  assert.doesNotMatch(body, /\blistOutbox\(id\)/);
});
t("W2 아웃박스 모듈(노드 번들의 알려진 부채)은 재대조·기록 찾기 모듈을 들이지 않는다", () => {
  //  세 모양 다 — `… from "x"` · `import("x")` · 이름 없이 들이는 `import "x"`(변이 실측: 마지막 모양을 놓쳐 공허했다).
  const specs = [...src("src/sessions/session-outbox.ts").matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)"([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(specs.length > 5, "import 를 못 읽었다");
  for (const sp of specs) assert.doesNotMatch(sp, /outbox-late-echo|transcript-locate/, sp);
});

for (const [name, fn] of tests) { await fn(); pass++; console.log(`ok  ${name}`); }
console.log(`outbox-late-echo: ${pass} passed`);

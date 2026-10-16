// 친 직후 에코 판정(#4851) — 아웃박스가 말을 친 뒤 «그 말이 들어갔나» 를 대화 기록에서 찾는 규칙. 실 파일·tmux·DB 는 안 띄운다.
//  사양·엣지 표: 지식 outbox-echo-typed-window-4851 §사양 — 아래 이름의 기호가 그 표의 행이다(행마다 최소 한 시나리오).
//   K 친 직후 판정(echoInTranscript) — 종전 확인(기록 꼬리 256KB 에 머리 160자가 «글자로 있기만 하면» 전달됨)이 낸 거짓 «전달됨» 의 재현 포함
//   C 빗금 명령 줄 해석(typedCommandOf · promptOfLine)
//   S 빗금 명령 꼴(looksLikeSlashCommand) · 입력칸을 떠났나(slashCommandLeftInput)
//   B 번들 경계(이 모듈은 노드 번들에 실린다)
//  K 는 진짜 줄 맞춤(alignedSource → readAlignedWindow)과 진짜 claude 해석기(harness-io/adapter)를 메모리 버퍼 위에서 돌린다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { harnessIo } from "../terminal/harness-io/adapter.js";
import type { ByteReader } from "../terminal/harness-io/window.js";
import type { InputHold } from "../terminal/submit-check.js";
import * as outbox from "./session-outbox.js";
import * as scan from "./outbox-echo-scan.js";

//  네임스페이스로 받는다 — 이름을 정적으로 묶으면 옛 판(이 이름들이 없음)에서 파일 전체가 링크 오류로 죽어 어느 행이 빨간지 안 보인다(fail-first).
const { echoInTranscript, echoWatch, slashCommandLeftInput, typedEchoWindow } = outbox as unknown as {
  echoInTranscript: (tfs: unknown, file: string, size: number, said: string, watch: { typedAt: number; memo: { file: string; scannedTo: number } | null }, parse: (t: string) => unknown[]) => Promise<boolean>;
  echoWatch: (typedAt: number) => { typedAt: number; memo: { file: string; scannedTo: number; aligned?: boolean } | null };
  slashCommandLeftInput: (text: string, last: InputHold | null) => boolean | null;
  typedEchoWindow: (w: { typedAt: number }) => { notBefore: number };
};
const { looksLikeSlashCommand, promptOfLine, samePrompt, typedCommandOf, ECHO_HEAD_CHARS, ECHO_SKEW_MS } = scan;

let pass = 0;
const tests: Array<[string, () => void | Promise<void>]> = [];
const t = (name: string, fn: () => void | Promise<void>): void => { tests.push([name, fn]); };

// ── 재료 ────────────────────────────────────────────────────────────────────────────
const T0 = Date.parse("2026-10-17T01:00:00.000Z");          // 아웃박스가 치기 시작한 때(게이트웨이 시계)
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const L = (o: object): string => JSON.stringify(o) + "\n";
const user = (text: string, ts: string, extra: object = {}): string => L({ type: "user", timestamp: ts, message: { role: "user", content: text }, ...extra });
const ai = (text: string, ts: string): string => L({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } });
const toolResult = (text: string, ts: string): string =>
  L({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: text }] } });
const queued = (text: string, ts: string): string =>
  L({ type: "attachment", timestamp: ts, attachment: { type: "queued_command", prompt: text, commandMode: "prompt", origin: { kind: "human" } } });
//  Claude Code 가 매 턴 지난 말을 되풀이해 적는 줄 · 요청 사본 — 둘 다 시각이 없다(실측).
const lastPrompt = (text: string): string => L({ type: "last-prompt", lastPrompt: text, sessionId: "e8a2" });
const blob = (text: string): string => L({ type: "api-request-blob", sessionId: "e8a2", message: { role: "user", content: text } });
//  실측 꼴(이 맥 기록 — Claude Code 2.1.2xx~2.1.30x): 로컬 명령 · 프롬프트형(스킬·플러그인) 명령.
const localCmd = (name: string, args: string, ts: string): string =>
  user(`<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`, ts);
const promptCmd = (name: string, args: string, ts: string): string =>
  user(`<command-message>${name} is running…</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`, ts);
const stdout = (text: string, ts: string): string => user(`<local-command-stdout>${text}</local-command-stdout>`, ts);

//  «진행해» 를 늘 쓰는 세션 — 보내기 전에 이미 같은 글이 여러 꼴로 기록 꼬리에 있다.
const BEFORE = user("다음 단계 설계 좀 봐줘", at(-20 * 60_000)) + ai("설계안입니다. 괜찮으면 «진행해» 라고 말해 주세요.", at(-19 * 60_000))
  + user("진행해", at(-10 * 60_000)) + toolResult("$ grep -n 진행해 notes.md\n12: 진행해", at(-9 * 60_000))
  + ai("진행했습니다.", at(-8 * 60_000)) + lastPrompt("진행해") + blob("진행해");

const claudeParse = (text: string): unknown[] => harnessIo("claude")!.parse!(text, {}).lines;
/** 메모리 위의 대화 파일 — 읽은 구간을 log 에 남긴다(무엇을 읽었나가 곧 비용이다). */
function memFs(files: Record<string, string>) {
  const log: Array<[string, number, number]> = [];
  return {
    log,
    size: (f: string): number => Buffer.byteLength(files[f] ?? "", "utf8"),
    set: (f: string, text: string): void => { files[f] = text; },
    read: async <T>(file: string, _size: number, fn: (r: ByteReader) => Promise<T>): Promise<T> => {
      const buf = Buffer.from(files[file] ?? "", "utf8");
      return fn({ async read(s, e) { log.push([file, s, e]); return buf.subarray(s, Math.min(e, buf.length)); } });
    },
  };
}
type Watch = ReturnType<typeof echoWatch>;
const check = (fs: ReturnType<typeof memFs>, file: string, said: string, watch: Watch): Promise<boolean> =>
  echoInTranscript(fs, file, fs.size(file), said, watch, claudeParse);
/** 종전 판정 그대로(기록 꼬리 256KB 에 머리 160자의 JSON 바늘이 있나) — 재현 행이 «종전엔 거짓 전달됨이었다» 를 같은 재료로 보인다. */
const oldRule = (text: string, said: string): boolean =>
  text.slice(-256 * 1024).includes(JSON.stringify(said.slice(0, 160)).slice(1, -1));

// ── K — 친 직후 판정 ─────────────────────────────────────────────────────────────────
t("★ K1 보내기 전에 있던 같은 말(사람 말 줄 · last-prompt · AI 답 · 도구 결과 · 요청 사본)만 있다 → «전달됨» 아님 (종전 판정은 전달됨)", async () => {
  assert.equal(oldRule(BEFORE, "진행해"), true, "재료 전제 — 종전 판정은 이 기록에서 곧바로 «전달됨» 이었다");
  const fs = memFs({ "c.jsonl": BEFORE });
  assert.equal(await check(fs, "c.jsonl", "진행해", echoWatch(T0)), false);
  assert.ok(fs.log.length > 0, "배선 — 기록을 읽지 않았다");
});
t("K2 친 뒤 사람 말 줄이 나중에 적히면 «전달됨» — 다음 확인은 자란 부분만 읽는다", async () => {
  const fs = memFs({ "c.jsonl": BEFORE });
  const w = echoWatch(T0);
  assert.equal(await check(fs, "c.jsonl", "진행해", w), false);
  const before = fs.size("c.jsonl");
  assert.equal(w.memo?.scannedTo, before, `기억이 파일 끝에 있어야 한다: ${JSON.stringify(w.memo)}`);
  fs.set("c.jsonl", BEFORE + user("진행해", at(2_000)) + ai("네, 진행합니다.", at(5_000)));
  fs.log.length = 0;
  assert.equal(await check(fs, "c.jsonl", "진행해", w), true);
  assert.ok(fs.log.length > 0 && Math.min(...fs.log.map(([, s]) => s)) >= before - 1, `앞을 다시 읽었다: ${JSON.stringify(fs.log)}`);
});
t("K3 훅 뒤에 적힌 사람 말 줄(줄 시각 = 제출한 때 · 파일 순서는 더 늦은 시각의 요청 줄 뒤 — c3d46537 실측 꼴) → «전달됨»", async () => {
  const fs = memFs({ "c.jsonl": BEFORE });
  const w = echoWatch(T0);
  await check(fs, "c.jsonl", "진행해", w);
  fs.set("c.jsonl", BEFORE + blob("진행해") + L({ type: "api-request", timestamp: at(25_000) }) + user("진행해", at(1_000))
    + L({ type: "attachment", timestamp: at(23_000), attachment: { type: "hook_success", hookName: "UserPromptSubmit" } }));
  assert.equal(await check(fs, "c.jsonl", "진행해", w), true);
});
t("K4 경계 — 사람 말 줄이 정확히 친 때−5초면 증거 · 그 1ms 앞은 아님", async () => {
  assert.equal(typedEchoWindow({ typedAt: T0 }).notBefore, T0 - ECHO_SKEW_MS);
  assert.equal(ECHO_SKEW_MS, 5_000);
  assert.equal(await check(memFs({ "c.jsonl": BEFORE + user("진행해", at(-5_000)) }), "c.jsonl", "진행해", echoWatch(T0)), true);
  assert.equal(await check(memFs({ "c.jsonl": BEFORE + user("진행해", at(-5_001)) }), "c.jsonl", "진행해", echoWatch(T0)), false);
});
t("K5 도는 중 끼워 넣은 말(queued_command)이 친 뒤에 적히면 «전달됨»", async () => {
  assert.equal(await check(memFs({ "c.jsonl": BEFORE + queued("진행해", at(40_000)) }), "c.jsonl", "진행해", echoWatch(T0)), true);
});
t("★ K6 짧은 말(«1»)은 기록 어디에나 글자로 있다 — 친 뒤 사람 말 줄이 없으면 «전달됨» 아님 (종전 판정은 전달됨)", async () => {
  const text = BEFORE + ai("1. 첫째 안 2. 둘째 안 — 번호로 골라 주세요.", at(-60_000)) + toolResult("exit 1", at(1_000)) + ai("1번으로 갑니다", at(3_000));
  assert.equal(oldRule(text, "1"), true, "재료 전제");
  assert.equal(await check(memFs({ "c.jsonl": text }), "c.jsonl", "1", echoWatch(T0)), false);
  assert.equal(await check(memFs({ "c.jsonl": text + user("1", at(4_000)) }), "c.jsonl", "1", echoWatch(T0)), true);
});
t("K7 친 뒤라도 사람 말이 아닌 줄(AI 답 · 도구 결과 · 주입 isMeta · 서브에이전트 가지 · last-prompt · 요청 사본)은 증거 아님", async () => {
  const after = ai("진행해", at(1_000)) + toolResult("진행해", at(1_000)) + user("진행해", at(1_000), { isMeta: true })
    + user("진행해", at(1_000), { isSidechain: true }) + lastPrompt("진행해") + blob("진행해");
  assert.equal(await check(memFs({ "c.jsonl": BEFORE + after }), "c.jsonl", "진행해", echoWatch(T0)), false);
});
t("★ K8 더 긴 다른 말의 머리일 뿐이면 다른 말(«진행해» 에 «진행해줘» 가 적힘) → 아님 (종전 판정은 전달됨)", async () => {
  const text = user("이전 대화", at(-60_000)) + user("진행해줘", at(2_000));
  assert.equal(oldRule(text, "진행해"), true, "재료 전제");
  assert.equal(await check(memFs({ "c.jsonl": text }), "c.jsonl", "진행해", echoWatch(T0)), false);
});
t("K9 파일 끝이 쓰는 중인 반 줄 → 안 센다 · 다 적힌 뒤 다음 확인이 그 줄부터 읽어 찾는다", async () => {
  const full = user("진행해", at(2_000));
  const fs = memFs({ "c.jsonl": BEFORE + full.slice(0, 30) });
  const w = echoWatch(T0);
  assert.equal(await check(fs, "c.jsonl", "진행해", w), false);
  assert.equal(w.memo?.scannedTo, Buffer.byteLength(BEFORE), "반 줄 앞에서 멈춰야 한다");
  fs.set("c.jsonl", BEFORE + full);
  assert.equal(await check(fs, "c.jsonl", "진행해", w), true);
});
t("K10 파일이 바뀌었다(맥락 압축·새 대화) → 새 파일을 끝에서부터 다시 본다", async () => {
  const fs = memFs({ "old.jsonl": BEFORE, "new.jsonl": L({ type: "system", subtype: "compact", timestamp: at(500) }) + user("진행해", at(1_500)) });
  const w = echoWatch(T0);
  assert.equal(await check(fs, "old.jsonl", "진행해", w), false);
  assert.equal(await check(fs, "new.jsonl", "진행해", w), true);
  assert.equal(w.memo?.file, "new.jsonl");
});
t("K11 긴 말(>160자) — 꼬리가 뒤섞여 적혀도 머리 160자가 같으면 «전달됨» · 머리가 다르면 아님", async () => {
  const head = "자료 공개범위를 단위마다 정하게 하고 ".repeat(10);
  assert.ok(head.length > ECHO_HEAD_CHARS && ECHO_HEAD_CHARS === 160);
  const said = head + "꼬리 원문";
  assert.equal(await check(memFs({ "c.jsonl": BEFORE + user(head + "리꼬 뒤섞임", at(2_000)) }), "c.jsonl", said, echoWatch(T0)), true);
  assert.equal(await check(memFs({ "c.jsonl": BEFORE + user("다른 " + head, at(2_000)) }), "c.jsonl", said, echoWatch(T0)), false);
});
t("K12 친 뒤에 큰 기록이 쌓여도(꼬리 창 256KB 를 넘김) 그 앞의 사람 말 줄을 찾는다 · 친 때보다 한참 앞까지는 안 읽는다", async () => {
  const filler = Array.from({ length: 400 }, (_, i) => ai(`작업 ${i} ` + "결과".repeat(400), at(10_000 + i))).join("");
  assert.ok(Buffer.byteLength(filler) > 256 * 1024, "재료 전제 — 꼬리 창보다 크다");
  const old = Array.from({ length: 400 }, (_, i) => ai(`옛 작업 ${i} ` + "기록".repeat(400), at(-3_600_000 + i))).join("");
  const fs = memFs({ "c.jsonl": old + user("진행해", at(1_000)) + filler });
  assert.equal(await check(fs, "c.jsonl", "진행해", echoWatch(T0)), true);
  const earliest = Math.min(...fs.log.map(([, s]) => s));
  assert.ok(earliest > Buffer.byteLength(old) / 2, `친 때보다 한참 앞까지 읽었다: ${earliest} / ${Buffer.byteLength(old)}`);
});
t("K13 빈 파일 · 빈 말 → 아님 · 오류 없음", async () => {
  assert.equal(await check(memFs({ "e.jsonl": "" }), "e.jsonl", "진행해", echoWatch(T0)), false);
  assert.equal(await check(memFs({ "c.jsonl": BEFORE + user("", at(1_000)) }), "c.jsonl", "", echoWatch(T0)), false);
});
//  2.1.301 실측 꼴 — 도는 중에 받은 말: Enter 즉시 «대기열에 넣었다» 줄(원문) → 도구가 끝나야 끼워 넣은 말 줄.
const enqueue = (text: string, ts: string): string => L({ type: "queue-operation", operation: "enqueue", timestamp: ts, sessionId: "e8a2", content: text });
const dequeue = (ts: string): string => L({ type: "queue-operation", operation: "dequeue", timestamp: ts, sessionId: "e8a2" });
t("★ K15 바쁠 때 — 친 뒤 «대기열에 넣었다» 줄이면 «전달됨»(끼워 넣은 말 줄을 기다리지 않는다) · 친 전 · 두 말이 이어 붙은 원문 · 꺼냄 줄은 아님", async () => {
  assert.equal(await check(memFs({ "c.jsonl": BEFORE + enqueue("끝나면 알려줘", at(300)) }), "c.jsonl", "끝나면 알려줘", echoWatch(T0)), true);
  assert.equal(await check(memFs({ "c.jsonl": BEFORE + enqueue("끝나면 알려줘", at(-60_000)) + dequeue(at(-50_000)) }), "c.jsonl", "끝나면 알려줘", echoWatch(T0)), false, "친 전");
  const glued = BEFORE + enqueue("/context끝나면 알려줘", at(300)) + dequeue(at(2_000));
  for (const said of ["/context", "끝나면 알려줘"]) assert.equal(await check(memFs({ "c.jsonl": glued }), "c.jsonl", said, echoWatch(T0)), false, `이어 붙은 원문 · ${said}`);
});
//  다른 하네스 — 어댑터가 공통 ChatLine(user 줄의 글 = 사람 말)으로 올린다. 줄 모양은 각 어댑터 시험(codex · grok · antigravity .test)의 실측 fixture 와 같다.
const codexUser = (text: string, ts: string): string =>
  L({ timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const codexAi = (text: string, ts: string): string =>
  L({ timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const grokUser = (text: string, ms: number): string =>
  L({ timestamp: Math.floor((T0 + ms) / 1000), method: "session/update", params: { sessionId: "g1", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } }, _meta: { eventId: "g1-1", agentTimestampMs: T0 + ms } } });
const agUser = (text: string, ts: string): string =>
  L({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: ts, content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: …\n</ADDITIONAL_METADATA>` });
t("★ K16 다른 하네스(codex · grok · antigravity)의 사람 말 줄 — 친 뒤면 «전달됨» · 친 전의 같은 말뿐이면 아님 (거짓 «미확인» 회귀 없음)", async () => {
  const cases: Array<[string, (text: string, offsetMs: number) => string]> = [
    ["codex", (x, ms) => codexUser(x, at(ms))],
    ["grok", (x, ms) => grokUser(x, ms)],
    ["antigravity", (x, ms) => agUser(x, at(ms))],
  ];
  for (const [key, mk] of cases) {
    const parse = (text: string): unknown[] => harnessIo(key)!.parse!(text, {}).lines;
    const before = mk("진행해", -10 * 60_000) + (key === "codex" ? codexAi("진행해 라고 하셨죠", at(-9 * 60_000)) : "");
    const fs1 = memFs({ "c.jsonl": before });
    assert.equal(await echoInTranscript(fs1, "c.jsonl", fs1.size("c.jsonl"), "진행해", echoWatch(T0), parse), false, `${key} — 친 전의 같은 말뿐`);
    const fs2 = memFs({ "c.jsonl": before + mk("진행해", 2_000) });
    assert.equal(await echoInTranscript(fs2, "c.jsonl", fs2.size("c.jsonl"), "진행해", echoWatch(T0), parse), true, `${key} — 친 뒤 사람 말 줄`);
  }
});
t("K14 읽기가 실패하면 던진다(부른 쪽이 «못 읽음» 으로 — 재전송 금지 신호)", async () => {
  const broken = { read: async () => { throw new Error("중계 503"); } };
  await assert.rejects(echoInTranscript(broken, "c.jsonl", 100, "진행해", echoWatch(T0), claudeParse), /중계 503/);
});

// ── C — 빗금 명령 줄 ────────────────────────────────────────────────────────────────
t("C1 로컬 명령 줄(태그 묶음) → 친 꼴 «/이름 인자» · 인자 없으면 «/이름» · 인자 태그가 없어도", () => {
  assert.equal(typedCommandOf("<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>sonnet</command-args>"), "/model sonnet");
  assert.equal(typedCommandOf("<command-name>/exit</command-name>\n            <command-message>exit</command-message>\n            <command-args></command-args>"), "/exit");
  assert.equal(typedCommandOf("<command-name>/effort</command-name><command-message>effort</command-message>"), "/effort");
});
t("C2 프롬프트형 명령 줄(command-message 가 먼저) · 플러그인 이름 · 여러 낱말·줄바꿈 인자", () => {
  assert.equal(typedCommandOf("<command-message>loop is running…</command-message>\n<command-name>/loop</command-name>\n<command-args>1 응. 현빈이 응대 잘 마쳐</command-args>"),
    "/loop 1 응. 현빈이 응대 잘 마쳐");
  assert.equal(typedCommandOf("<command-message>discord:configure</command-message>\n<command-name>/discord:configure</command-name>\n<command-args></command-args>"), "/discord:configure");
  assert.ok(samePrompt("/hello 사과\n바나나", typedCommandOf("<command-name>/hello</command-name>\n<command-args>  사과\n바나나 </command-args>") ?? ""));
});
t("C3 태그로 시작하지 않는 사람 말(글 속에 태그를 인용) · 이름 태그가 없는 줄 · 명령 출력 줄 → 명령 아님", () => {
  assert.equal(typedCommandOf("이 줄 봐: <command-name>/exit</command-name>"), null);
  assert.equal(typedCommandOf("<command-message>뭔가</command-message>"), null);
  assert.equal(typedCommandOf("<local-command-stdout>Goodbye!</local-command-stdout>"), null);
});
t("C4 promptOfLine — 명령 줄은 친 꼴로 · 명령 출력(local-command-stdout) 줄은 친 말과 같을 수 없다", () => {
  const one = (s: string): unknown => JSON.parse(s);
  assert.deepEqual(promptOfLine(one(localCmd("model", "sonnet", at(0)))), { text: "/model sonnet", queued: false });
  const out = promptOfLine(one(stdout("Set model to Sonnet", at(0))));
  assert.ok(out && !samePrompt("/model sonnet", out.text));
});
t("★ C5 친 직후 판정 — 대화창에서 친 `/model sonnet` · `/exit` · 프롬프트형 `/hello 사과` 가 명령 줄로 적히면 «전달됨» (종전엔 인자 있는 명령을 못 찾았다)", async () => {
  //  [친 글, 기록 줄, 종전 판정이 찾았나] — 인자 없는 /exit 는 종전에도 태그 속 «/exit» 글자에 걸렸다(그 대신 보내기 전에 있던 «/exit» 글자에도 걸렸다 — K1 계열).
  const cases: Array<[string, string, boolean]> = [
    ["/model sonnet", localCmd("model", "sonnet", at(800)) + stdout("Set model to Sonnet", at(800)), false],
    ["/exit", localCmd("exit", "", at(800)) + stdout("Goodbye!", at(800)), true],
    ["/hello 사과", promptCmd("hello", "사과", at(900)), false],
  ];
  for (const [said, lines, oldFound] of cases) {
    const text = BEFORE + lines;
    assert.equal(oldRule(text, said), oldFound, `재료 전제 — 종전 판정(${said})`);
    assert.equal(await check(memFs({ "c.jsonl": text }), "c.jsonl", said, echoWatch(T0)), true, said);
  }
  assert.equal(await check(memFs({ "c.jsonl": BEFORE + localCmd("model", "sonnet", at(-60_000)) }), "c.jsonl", "/model sonnet", echoWatch(T0)), false, "친 때 앞의 같은 명령은 아님");
  assert.equal(await check(memFs({ "c.jsonl": BEFORE + localCmd("model", "opus", at(800)) }), "c.jsonl", "/model sonnet", echoWatch(T0)), false, "인자가 다르면 아님");
});

//  2.1.301 실측 꼴 — 화면만 띄우는 로컬 명령은 system 줄(subtype local_command)로 적힌다(명령 줄 + 출력 줄 · caveat 없음).
const sysCmd = (content: string, ts: string, extra: object = {}): string =>
  L({ type: "system", subtype: "local_command", content, level: "info", timestamp: ts, isMeta: false, isSidechain: false, ...extra });
t("★ C6 system local_command 명령 줄 → 친 꼴 · 그 출력 줄 · «Unknown command» 알림 줄 · 가지(sidechain) 줄은 아님 — 친 뒤면 «전달됨»", async () => {
  const one = (s: string): unknown => JSON.parse(s);
  const cmdLine = sysCmd("<command-name>/context</command-name>\n            <command-message>context</command-message>\n            <command-args></command-args>", at(700));
  assert.deepEqual(promptOfLine(one(cmdLine)), { text: "/context", queued: false });
  assert.equal(promptOfLine(one(sysCmd("<local-command-stdout>Settings dialog dismissed</local-command-stdout>", at(700), { commandRun: { command: "usage", args: "" } }))), null);
  assert.equal(promptOfLine(one(L({ type: "system", subtype: "informational", content: "Unknown command: /foo. Did you mean /loop?", level: "warning", timestamp: at(700) }))), null);
  assert.equal(promptOfLine(one(sysCmd("<command-name>/context</command-name>", at(700), { isSidechain: true }))), null);
  assert.equal(await check(memFs({ "c.jsonl": BEFORE + cmdLine }), "c.jsonl", "/context", echoWatch(T0)), true);
});

t("★ C7 조작된 거대한 명령 줄(여는 인자 태그만 되풀이) — 해석이 선형이라 곧 끝난다 · 상한(64KB)을 넘는 글은 명령 줄로 보지 않는다", () => {
  const { CMD_LINE_MAX } = scan as unknown as { CMD_LINE_MAX?: number };
  assert.equal(CMD_LINE_MAX, 64 * 1024, "명령 줄 상한이 사양(64KB)과 다르다");
  const head = "<command-name>/x</command-name>";
  const crafted = head + "<command-args>".repeat(Math.floor((60 * 1024 - head.length) / 14));   // 상한 안 · 닫는 태그 없음
  assert.ok(crafted.length < 64 * 1024 && crafted.length > 50 * 1024, "재료 전제");
  let t0 = performance.now();
  assert.equal(typedCommandOf(crafted), "/x", "닫는 태그가 없으면 인자 없음");
  const ms = performance.now() - t0;
  assert.ok(ms < 20, `상한 안의 조작 줄 해석이 ${ms.toFixed(1)}ms — 선형이 아니다(지연 정규식이면 수십 ms)`);
  const huge = head + "<command-args>".repeat(300_000);                                              // 약 4MB
  t0 = performance.now();
  assert.equal(typedCommandOf(huge), null, "상한을 넘는 글은 명령 줄이 아니다");
  assert.ok(performance.now() - t0 < 20, "상한을 넘는 글을 훑었다");
  assert.equal(typedCommandOf(`<command-name>/hello</command-name><command-args>${"사".repeat(70_000)}</command-args>`), null, "상한을 넘는 정상 꼴도 명령 줄로 보지 않는다");
});

// ── S — 빗금 명령 꼴 · 입력칸을 떠났나 ────────────────────────────────────────────────
t("S1 looksLikeSlashCommand — `/이름`(글자로 시작 · 플러그인 a:b) 뒤가 공백이나 끝 · 경로·빈 글·`/` 만·숫자 시작은 아님", () => {
  for (const s of ["/exit", "/model sonnet", " /compact ", "/discord:configure x", "/compact\n요약은 짧게", "/foo-bar"]) assert.equal(looksLikeSlashCommand(s), true, s);
  for (const s of ["/tmp/x.txt 이 파일 봐줘", "/ 뭐야", "//x", "/1abc", "진행해", "", "a /exit", "/"]) assert.equal(looksLikeSlashCommand(s), false, JSON.stringify(s));
});
t("S2 slashCommandLeftInput — 빗금 명령이 아니면 늘 거짓 · 우리 글이 남았으면 거짓 · 떠났으면 참 · 화면을 모르면 모름(null)", () => {
  const holds: Array<InputHold | null> = ["ours", "empty", "other", "dialog", "unknown", null];
  for (const h of holds) assert.equal(slashCommandLeftInput("진행해", h), false, `보통 말 · ${h}`);
  assert.equal(slashCommandLeftInput("/exit", "ours"), false);
  for (const h of ["empty", "other", "dialog", "unknown"] as const) assert.equal(slashCommandLeftInput("/exit", h), true, h);
  assert.equal(slashCommandLeftInput("/exit", null), null);
  assert.equal(slashCommandLeftInput("/tmp/x.txt 봐줘", "empty"), false, "경로로 이어지는 글은 보통 말");
});

// ── B — 번들 경계 ───────────────────────────────────────────────────────────────────
//  dist 에서 도는 시험이라 소스는 **cwd 기준**으로 읽는다(이 레포 관용구 — session-outbox.test.ts 와 같다).
const src = (rel: string): string => readFileSync(rel, "utf8");
t("B1 판정 한 벌(outbox-echo-scan)은 줄 맞춤(harness-io/window)만 들인다 — 노드 번들에 실리므로 DB·로그·기록 찾기·아웃박스를 안 들인다", () => {
  const specs = [...src("src/sessions/outbox-echo-scan.ts").matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(specs, ["../terminal/harness-io/window.js"]);
});
t("B2 노드 번들 승인 목록에 판정 한 벌이 올라 있다(빌드 가드가 «새 유입» 으로 막지 않게)", () => {
  assert.ok((JSON.parse(src("scripts/node-agent-allowed-modules.json")) as string[]).includes("dist/sessions/outbox-echo-scan.js"));
});
t("B3 친 직후 판정 · 늦은 에코가 한 벌을 쓴다 — 아웃박스는 바늘(글자 포함 여부)로 판정하지 않는다", () => {
  const ob = src("src/sessions/session-outbox.ts");
  assert.match(ob, /from "\.\/outbox-echo-scan\.js"/);
  //  주석은 빼고 본다 — 머리말이 종전 판정의 이름을 «왜 바꿨나» 로 적는다.
  const code = ob.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.doesNotMatch(code, /tailContains|echoNeedle|\.includes\(needle\)/, "종전 바늘 판정이 남았다");
  assert.match(src("src/sessions/outbox-late-echo.ts"), /from "\.\/outbox-echo-scan\.js"/);
});

//  행마다 끝까지 돈다 — 한 행이 빨개도 나머지가 무엇을 말하는지 보여야 fail-first(변이·옛 판) 때 어느 행이 잡았는지 읽힌다.
let fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log(`ok  ${name}`); }
  catch (e) { fail++; console.log(`not ok  ${name}\n    ${String((e as Error)?.message ?? e).split("\n")[0]}`); }
}
console.log(`outbox-echo-scan: ${pass} passed · ${fail} failed`);
if (fail) process.exit(1);

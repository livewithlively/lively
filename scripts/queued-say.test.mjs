// 일하는 중에 친 사람 말 판정 (#4850) — 값으로 고정한다(web/lib/queued-say.ts).
//
//  무엇이 문제였나(상민님 2026-10-16): 하네스가 일하는 동안 대화창에서 보낸 말은 Claude Code 기록에 사람 말 줄이 아니라 끼워 넣기 줄
//   (attachment · queued_command)로만 남는다. 대화창은 그 줄 가운데 작업 끝 알림만 그려, 다시 열면 그 말이 대화에서 사라졌다.
//  판정 규칙은 Claude Code 2.1.301 실행 파일이 그 줄을 «사람 말 틀» 로 그리는 조건을 옮긴 것이다 — 출처(origin)가 없거나 human ·
//   auto-continuation 이고, 메타가 아니고, commandMode 가 없거나 prompt. 그 밖(작업 알림 · 하위 에이전트 보고 · 채널 · 코디네이터)은 아니다.
//  사양·엣지 표: 지식 queued-say-chat-render-4850 §사양 의 Q 행 — 아래 이름의 번호가 그 행이다.
//  화면 장면(R 행)은 queued-say-runtime.test, 얇은 판(T 행)은 src/terminal/harness-io/chat-line-thin.test.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.SRC_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const ok = (cond, name, detail = "") => { assert.ok(cond, `${name}${detail ? " — " + detail : ""}`); pass++; console.log(`ok  ${name}`); };

const tmp = mkdtempSync(path.join(tmpdir(), "queued-say-"));
try {
  execFileSync(path.join(distRoot, "node_modules/.bin/tsc"),
    [path.join(root, "web/lib/queued-say.ts"), "--outDir", tmp, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
    { stdio: "inherit" });
  const { queuedSay, sayIdOf, sayOrderTs } = await import(path.join(tmp, "queued-say.js"));
  //  Q19 계약용 — 서버 얇은 판(src/terminal/harness-io/chat-line.ts thinLine)도 같은 tmp 로(그 파일은 import 가 없다).
  const tmpSrv = path.join(tmp, "srv");
  execFileSync(path.join(distRoot, "node_modules/.bin/tsc"),
    [path.join(root, "src/terminal/harness-io/chat-line.ts"), "--outDir", tmpSrv, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
    { stdio: "inherit" });
  const { thinLine } = await import(path.join(tmpSrv, "chat-line.js"));

  //  실측 모양(2.1.301 — 이 맥미니 기록): 줄 timestamp = attachment.timestamp = 친 때. source_uuid 는 그 말의 정체성.
  const QC = (att, extra = {}) => ({ type: "attachment", uuid: "line-u1", timestamp: "2026-10-16T14:30:00.740Z", isSidechain: false,
    attachment: { type: "queued_command", source_uuid: "src-u1", delivery_id: "d1", timestamp: "2026-10-16T14:30:00.740Z", ...att }, ...extra });
  const HUMAN = { prompt: "probe-queued: say PROBE too", commandMode: "prompt", origin: { kind: "human" }, humanTurn: true };
  const said = (line) => { const q = queuedSay(line); return q ? q.text : null; };

  // ── Q1 — 사람이 친 말(실측 그대로) ────────────────────────────────────────────
  {
    const q = queuedSay(QC(HUMAN));
    ok(q && q.text === "probe-queued: say PROBE too" && q.id === "src-u1", "Q1 origin human · commandMode prompt · 문자열 → 사람 말 · 정체성은 source_uuid", JSON.stringify(q));
  }
  // ── Q2 — 그림을 붙인 말: 블록 배열에서 글만 ─────────────────────────────────
  ok(said(QC({ ...HUMAN, prompt: [{ type: "text", text: "이 화면 봐 줘" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "둘째 줄" }] })) === "이 화면 봐 줘\n둘째 줄",
    "Q2 prompt 가 블록 배열(글+그림)이면 글 블록만 줄바꿈으로 잇는다(그림은 버린다)");
  // ── Q3·Q4 — 출처 표식이 없는 옛 판의 줄은 사람 말(본체: 출처 없음 = 표식 없는 사람 말) ──────────────
  ok(said(QC({ prompt: "옛 판에서 친 말", commandMode: "prompt" })) === "옛 판에서 친 말", "Q3 origin 없음 · commandMode prompt → 사람 말");
  ok(said(QC({ prompt: "모드도 없는 옛 줄" })) === "모드도 없는 옛 줄", "Q4 origin 없음 · commandMode 없음 → 사람 말");
  // ── Q5·Q6 — 하네스의 이어 가기(auto-continuation) ──────────────────────────────
  ok(said(QC({ prompt: "Implement the following plan: …", commandMode: "prompt", origin: { kind: "auto-continuation" } })) === "Implement the following plan: …",
    "Q5 auto-continuation · 메타 아님 → 사람 말 틀(터미널도 `❯` 로 그린다)");
  ok(queuedSay(QC({ prompt: "Your claude.ai usage limit has reset. Continue …", commandMode: "prompt", origin: { kind: "auto-continuation" }, isMeta: true })) === null,
    "Q6 auto-continuation · isMeta(한도 풀림 자동 이어감) → 아니다");
  // ── Q7·Q8 — 작업 끝 알림 ──────────────────────────────────────────────────────
  const NOTE = "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent \"x\" finished</summary>\n</task-notification>";
  ok(queuedSay(QC({ prompt: NOTE, commandMode: "task-notification" })) === null, "Q7 commandMode task-notification · origin 없음(옛 판) → 아니다");
  ok(queuedSay(QC({ prompt: NOTE, commandMode: "task-notification", origin: { kind: "task-notification", producer: "session-task" } })) === null,
    "Q8 origin task-notification → 아니다(작업 끝 알림은 lineNotice 가 한 줄로 그린다)");
  ok(queuedSay(QC({ prompt: "글이 사람 같아도", commandMode: "prompt", origin: { kind: "task-notification" } })) === null,
    "Q8b origin task-notification 이면 commandMode 가 prompt 여도 아니다");
  // ── Q9·Q10 — 사람이 아닌 출처 ─────────────────────────────────────────────────
  ok(queuedSay(QC({ prompt: '<agent-message from="a2">보고서</agent-message>', commandMode: "prompt", origin: { kind: "peer", from: "a2" }, isMeta: true })) === null,
    "Q9 하위 에이전트 보고(peer · isMeta) → 아니다");
  ok(queuedSay(QC({ prompt: "peer 인데 메타 표식이 없다", commandMode: "prompt", origin: { kind: "peer", from: "a3" } })) === null,
    "Q9b peer · 메타 아님 → 그래도 아니다(출처가 사람이 아니다)");
  ok(queuedSay(QC({ prompt: '<channel source="plugin:discord:discord">안녕</channel>', commandMode: "prompt", origin: { kind: "channel", server: "plugin:discord:discord" }, isMeta: true })) === null,
    "Q10 채널 중계(channel · isMeta) → 아니다");
  ok(queuedSay(QC({ prompt: "코디네이터가 보낸 말", commandMode: "prompt", origin: { kind: "coordinator" } })) === null, "Q10b coordinator → 아니다");
  ok(queuedSay(QC({ prompt: "모르는 출처", commandMode: "prompt", origin: { kind: "unclassified" } })) === null, "Q10c unclassified → 아니다");
  // ── Q11 — 서브에이전트 가지 ────────────────────────────────────────────────────
  ok(queuedSay(QC(HUMAN, { isSidechain: true })) === null, "Q11 isSidechain 줄 → 아니다(본 대화가 아니다)");
  // ── Q12 — 빈 글(새 헬퍼의 빈 입력) ─────────────────────────────────────────────
  for (const [p, name] of [["", "빈 글"], ["   \n\t ", "공백만"], [[{ type: "image", source: {} }], "글 블록 없는 배열"], [[], "빈 배열"], [undefined, "prompt 없음"], [42, "숫자"]]) {
    ok(queuedSay(QC({ ...HUMAN, prompt: p })) === null, `Q12 ${name} → 아니다`);
  }
  // ── Q13 — 끼워 넣기 줄이 아닌 것(부재 입력) ────────────────────────────────────
  ok(queuedSay({ type: "user", uuid: "u", message: { role: "user", content: "사람 말 줄" } }) === null, "Q13a 사람 말 줄은 이 판정의 대상이 아니다(사람 말 줄 길이 따로 그린다)");
  ok(queuedSay({ type: "attachment", attachment: { type: "hook_success", hookName: "UserPromptSubmit" } }) === null, "Q13b 다른 attachment(hook_success) → 아니다");
  ok(queuedSay({ type: "attachment", attachment: { type: "plan_prompt", prompt: "사람 말 같은 글", commandMode: "prompt", origin: { kind: "human" } } }) === null,
    "Q13b2 다른 종류가 prompt 칸을 갖고 와도 아니다(끼워 넣기 줄만 — 지금 기록엔 그런 종류가 없다)");
  ok(queuedSay({ type: "attachment" }) === null, "Q13c attachment 필드 없음 → 아니다");
  ok(queuedSay({ type: "attachment", attachment: "queued_command" }) === null, "Q13d attachment 가 객체가 아님 → 아니다");
  for (const v of [null, undefined, "문자열", 7]) ok(queuedSay(v) === null, `Q13e ${JSON.stringify(v)} → 아니다`);
  // ── Q14 — 정체성 ───────────────────────────────────────────────────────────────
  {
    const noSrc = QC(HUMAN); delete noSrc.attachment.source_uuid;
    ok(queuedSay(noSrc)?.id === "line-u1", "Q14a source_uuid 가 없으면 그 줄의 uuid");
    delete noSrc.uuid;
    ok(queuedSay(noSrc)?.id === "", "Q14b 둘 다 없으면 빈 글(열쇠 없음 — 한 번 판정을 안 건다)");
  }
  // ── Q15 — 셸 명령 모드 등 prompt 가 아닌 모드 ─────────────────────────────────
  ok(queuedSay(QC({ prompt: "ls -al", commandMode: "bash", origin: { kind: "human" } })) === null, "Q15 commandMode bash(사람이 친 것이어도) → 아니다");
  // ── Q16 — sayIdOf: 사람 말 줄과 끼워 넣기 줄이 같은 열쇠 공간 ───────────────────
  ok(sayIdOf({ type: "user", uuid: "u-9", message: { content: "x" } }) === "u-9", "Q16a 사람 말 줄 → 그 줄의 uuid");
  ok(sayIdOf(QC(HUMAN)) === "src-u1", "Q16b 사람 끼워 넣기 → source_uuid(되감기·carried-prompts 와 같은 열쇠)");
  ok(sayIdOf(QC({ prompt: NOTE, commandMode: "task-notification" })) === "", "Q16c 작업 알림 끼워 넣기 → 빈 글(사람 말이 아니다)");
  ok(sayIdOf({ type: "assistant", uuid: "a-1" }) === "" && sayIdOf(null) === "", "Q16d 답 줄 · null → 빈 글");
  // ── Q17 — 출처가 객체가 아니다 ─────────────────────────────────────────────────
  ok(queuedSay(QC({ prompt: "이상한 출처", commandMode: "prompt", origin: "human" })) === null, "Q17 origin 이 문자열(모르는 꼴) → 아니다(사람 말로 단정하지 않는다)");
  ok(said(QC({ prompt: "출처가 null", commandMode: "prompt", origin: null })) === "출처가 null", "Q17b origin null 은 «없음» 과 같다 → 사람 말");
  // ── Q18 — 정렬 시각(sayOrderTs): 줄 시각은 «친 때» 라 앞선 줄보다 이를 수 있다 ─────────────
  const T = (iso) => Date.parse(iso);
  ok(sayOrderTs("2026-10-16T14:30:00.740Z", T("2026-10-16T14:30:04.261Z")) === "2026-10-16T14:30:04.261Z",
    "Q18a 앞선 줄이 더 늦으면(실측 모양 — 친 뒤 도구 결과가 먼저 적힘) 앞선 줄의 시각");
  ok(sayOrderTs("2026-10-16T14:30:05.000Z", T("2026-10-16T14:30:04.261Z")) === "2026-10-16T14:30:05.000Z", "Q18b 제 시각이 더 늦으면 제 시각 그대로(같은 글자)");
  ok(sayOrderTs("2026-10-16T14:30:04.261Z", T("2026-10-16T14:30:04.261Z")) === "2026-10-16T14:30:04.261Z", "Q18c 같으면 제 시각(경계)");
  ok(sayOrderTs("2026-10-16T14:30:00.740Z", -Infinity) === "2026-10-16T14:30:00.740Z" && sayOrderTs("2026-10-16T14:30:00.740Z", NaN) === "2026-10-16T14:30:00.740Z",
    "Q18d 앞선 시각을 모르면(-Infinity · NaN — 창의 첫 줄) 제 시각");
  ok(sayOrderTs("깨진 시각", T("2026-10-16T14:30:04.261Z")) === "2026-10-16T14:30:04.261Z" && sayOrderTs(undefined, T("2026-10-16T14:30:04.261Z")) === "2026-10-16T14:30:04.261Z",
    "Q18e 제 시각을 못 읽으면 앞선 시각");
  ok(sayOrderTs(undefined, -Infinity) === undefined && sayOrderTs("깨진 시각", NaN) === "깨진 시각", "Q18f 둘 다 못 읽으면 원래 값(지어내지 않는다)");
  // ── Q19 — 계약: 서버 얇은 판(thinLine)을 거쳐도 화면 판정이 같다(타임라인 되감기가 그 판을 읽는다) ─────────
  const CONTRACT = [
    ["사람 · 문자열", QC(HUMAN)],
    ["사람 · 블록 배열", QC({ ...HUMAN, prompt: [{ type: "text", text: "이 화면" }, { type: "image", source: { data: "AAAA" } }, { type: "text", text: "봐 줘" }] })],
    ["출처 없는 옛 줄", QC({ prompt: "옛 판에서 친 말", commandMode: "prompt" })],
    ["모드 없는 옛 줄", QC({ prompt: "모드도 없는 옛 줄" })],
    ["auto-continuation", QC({ prompt: "Implement the following plan: …", commandMode: "prompt", origin: { kind: "auto-continuation" } })],
    ["auto-continuation · 메타", QC({ prompt: "Your usage limit has reset", commandMode: "prompt", origin: { kind: "auto-continuation" }, isMeta: true })],
    ["작업 알림", QC({ prompt: NOTE, commandMode: "task-notification", origin: { kind: "task-notification" } })],
    ["하위 에이전트 보고", QC({ prompt: "<agent-message>보고</agent-message>", commandMode: "prompt", origin: { kind: "peer" }, isMeta: true })],
    ["코디네이터", QC({ prompt: "코디네이터 지시", commandMode: "prompt", origin: { kind: "coordinator" } })],
    ["셸 모드", QC({ prompt: "ls", commandMode: "bash", origin: { kind: "human" } })],
    ["빈 글", QC({ ...HUMAN, prompt: "  " })],
  ];
  for (const [name, raw] of CONTRACT) {
    const before = queuedSay(raw);
    const thin = thinLine(raw);
    const after = thin ? queuedSay(thin) : null;
    ok(JSON.stringify(after) === JSON.stringify(before), `Q19 계약 · ${name} — 얇은 판을 거쳐도 같은 판정·같은 글·같은 정체성`, JSON.stringify({ before, after }));
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} passed — 일하는 중에 친 사람 말 판정(#4850)`);

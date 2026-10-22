// 얇은 판(타임라인 재료)이 일하는 중에 친 사람 말을 남기나 (#4850).
//  하네스가 일하는 동안 친 말은 claude 기록에 사람 말 줄이 아니라 끼워 넣기 줄(attachment · queued_command)로만 남는다. 얇은 판이
//  그 줄을 버리면 타임라인(세션 전체 되감기)에서 그 지시가 사라진다 — 대화창에서 사라지던 것과 같은 결함의 다른 자리.
//  어느 것이 사람 말인지는 화면이 가른다(web/lib/queued-say.ts) — 여기선 사람 말일 수 있는 끼워 넣기만 남기고 글을 사람 말처럼 자른다.
//  사양·엣지 표: 지식 queued-say-chat-render-4850 §사양 의 T 행.
import assert from "node:assert/strict";
import { thinLine, toThinNdjson, type ChatLine } from "./chat-line.js";

let pass = 0, fail = 0;
//  행마다 따로 판정하고 끝에 모아 보고한다 — 한 행이 빨개도 나머지 행이 무엇을 재는지 보인다(fail-first 때 행별로 본다).
const t = (name: string, fn: () => void): void => {
  try { fn(); pass++; console.log(`ok  ${name}`); }
  catch (e) { fail++; console.error(`FAIL  ${name} :: ${String((e as Error)?.message ?? e).split("\n")[0]}`); }
};
const L = (o: object): ChatLine => o as unknown as ChatLine;
const QC = (att: object, extra: object = {}): ChatLine => L({
  type: "attachment", uuid: "line-u1", timestamp: "2026-10-16T14:30:00.740Z", parentUuid: "p", cwd: "/x", sessionId: "s", version: "2.1.301",
  attachment: { type: "queued_command", source_uuid: "src-u1", delivery_id: "d1", timestamp: "2026-10-16T14:30:00.740Z", humanTurn: true, ...att },
  rendered: [{ content: "<system-reminder>\nThe user sent a new message while you were working:\n…" }], renderedRole: "system", ...extra,
});
const HUMAN = { prompt: "일하는 중에 친 말", commandMode: "prompt", origin: { kind: "human" } };

t("T1 사람 끼워 넣기 → 남긴다(글 · 출처 종류 · 정체성 · 줄 uuid · 시각) — 덩치(rendered · cwd …)는 버린다", () => {
  const o = thinLine(QC(HUMAN)) as any;
  assert.deepEqual(o, {
    type: "attachment", timestamp: "2026-10-16T14:30:00.740Z", uuid: "line-u1",
    attachment: { type: "queued_command", prompt: "일하는 중에 친 말", commandMode: "prompt", origin: { kind: "human" }, source_uuid: "src-u1" },
  });
});
t("T2 4000자 정확히 → 그대로 · 4001자 → 앞뒤를 남겨 자른다(사람 말 줄과 같은 자르기 — 붙여넣은 뒤 꼬리의 지시가 산다)", () => {
  const exact = "가".repeat(4000);
  assert.equal((thinLine(QC({ ...HUMAN, prompt: exact })) as any).attachment.prompt, exact);
  const long = "머리" + "나".repeat(3995) + "꼬리지시";   // 4001자 — 상한 바로 위
  assert.equal(long.length, 4001);
  const cut = (thinLine(QC({ ...HUMAN, prompt: long })) as any).attachment.prompt as string;
  assert.ok(cut.length < long.length, "잘렸다");
  assert.ok(cut.startsWith("머리") && cut.endsWith("꼬리지시"), "앞뒤가 남는다");
  assert.match(cut, /…\(가운데 \d+자 줄임\)…/);
  //  같은 길이의 사람 말 줄과 같은 결과(규칙 한 벌)
  const asUser = (thinLine(L({ type: "user", timestamp: "x", message: { role: "user", content: long } })) as any).message.content[0].text;
  assert.equal(cut, asUser);
});
t("T3 작업 끝 알림(commandMode task-notification) → 버린다", () => {
  assert.equal(thinLine(QC({ prompt: "<task-notification>\n<task-id>a</task-id>\n</task-notification>", commandMode: "task-notification", origin: { kind: "task-notification" } })), null);
  assert.equal(thinLine(QC({ prompt: "<task-notification>…</task-notification>", commandMode: "task-notification" })), null);
});
t("T4 메타 끼워 넣기(하위 에이전트 보고 · 채널 중계) → 버린다", () => {
  assert.equal(thinLine(QC({ prompt: "<agent-message from=\"a\">보고</agent-message>", commandMode: "prompt", origin: { kind: "peer" }, isMeta: true })), null);
  assert.equal(thinLine(QC({ prompt: "<channel source=\"x\">hi</channel>", commandMode: "prompt", origin: { kind: "channel" }, isMeta: true })), null);
});
t("T5 다른 attachment(hook_success · total_tokens_reminder) · attachment 필드 없음 → 버린다", () => {
  assert.equal(thinLine(L({ type: "attachment", timestamp: "x", attachment: { type: "hook_success", hookName: "UserPromptSubmit", content: "긴 훅 출력" } })), null);
  assert.equal(thinLine(L({ type: "attachment", timestamp: "x", attachment: { type: "total_tokens_reminder", text: "<total_tokens>…" } })), null);
  assert.equal(thinLine(L({ type: "attachment", timestamp: "x" })), null);
  //  끼워 넣기 줄만 남긴다 — 다른 종류가 prompt 칸을 갖고 와도(지금 기록엔 없다 · 하네스 판이 바뀌면 생길 수 있다) 사람 말로 내보내지 않는다.
  assert.equal(thinLine(L({ type: "attachment", timestamp: "x", attachment: { type: "plan_prompt", prompt: "사람 말 같은 글", commandMode: "prompt", origin: { kind: "human" } } })), null);
});
t("T6 빈 글 · 공백만 · 글 블록 없는 배열 → 버린다", () => {
  for (const p of ["", "  \n ", [{ type: "image", source: {} }], [], undefined]) assert.equal(thinLine(QC({ ...HUMAN, prompt: p })), null, JSON.stringify(p));
});
t("T7 그림을 붙인 말(블록 배열) → 글 블록만 줄바꿈으로", () => {
  const o = thinLine(QC({ ...HUMAN, prompt: [{ type: "text", text: "이 화면" }, { type: "image", source: { data: "AAAA" } }, { type: "text", text: "봐 줘" }] })) as any;
  assert.equal(o.attachment.prompt, "이 화면\n봐 줘");
});
t("T7b 출처·정체성이 없는 옛 줄 → 글만 남기고 없는 칸은 만들지 않는다(화면이 «출처 없음 = 사람 말» 로 읽는다)", () => {
  const raw = QC({ prompt: "옛 판의 말" }) as any;
  delete raw.attachment.source_uuid; delete raw.uuid;
  assert.deepEqual(thinLine(raw), { type: "attachment", timestamp: "2026-10-16T14:30:00.740Z", attachment: { type: "queued_command", prompt: "옛 판의 말" } });
});
t("T8 섞인 기록 → 사람 말 줄 · 끼워 넣은 말 · 답이 순서대로 남고 작업 알림·훅은 빠진다", () => {
  const lines = [
    L({ type: "user", uuid: "ua", timestamp: "1", message: { role: "user", content: "첫 지시 A" } }),
    L({ type: "assistant", uuid: "aa", timestamp: "2", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 30" } }] } }),
    L({ type: "user", uuid: "ur", timestamp: "3", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Running in the background" }] } }),
    L({ type: "attachment", uuid: "hk", timestamp: "3", attachment: { type: "hook_success", hookName: "PostToolUse" } }),
    QC(HUMAN),
    QC({ prompt: "<task-notification>\n<task-id>b</task-id>\n</task-notification>", commandMode: "task-notification" }, { uuid: "tn" }),
    L({ type: "assistant", uuid: "ab", timestamp: "5", message: { role: "assistant", content: [{ type: "text", text: "B 에 대한 답" }] } }),
  ];
  const got = toThinNdjson(lines).trim().split("\n").map((s) => JSON.parse(s));
  assert.deepEqual(got.map((o) => [o.type, o.uuid]), [["user", "ua"], ["assistant", "aa"], ["user", "ur"], ["attachment", "line-u1"], ["assistant", "ab"]]);
});

console.log(`\n${pass} passed, ${fail} failed — 얇은 판의 끼워 넣은 사람 말(#4850)`);
if (fail) process.exit(1);

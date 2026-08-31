// 대화 어댑터 표 계약 (#2439) — **5 하네스가 모든 축을 답한다. null 도 답이다.**
//
//  이 레포의 규율 그대로다(catalog.ts · harness-registry.mjs · harness-io/adapter.ts):
//  축을 늘리면 모든 하네스가 그 축을 채워야 «빠진 자리» 가 조용히 생기지 않는다.
//  여섯 번째 하네스가 오면 여기서 먼저 빨간불이 난다.
import assert from "node:assert/strict";
import { CHAT_ADAPTERS, canOpenChatRuntime, chatAdapter } from "./chat-adapters.js";
import { HARNESS_IO } from "./adapter.js";
import { harnessSupportsChat } from "../session-runtime-mode.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("[1] 우리가 지원한다고 말한 하네스가 **전부** 이 표에 있다(shell 제외 — AI 가 아니다)", () => {
  const io = HARNESS_IO.map((a) => a.key).filter((k) => k !== "shell");
  for (const k of io) assert.ok(chatAdapter(k), `${k} 가 대화 어댑터 표에 있다`);
  assert.equal(CHAT_ADAPTERS.length, io.length, "표에 유령 항목이 없다");
});

t("[2] 모든 하네스가 모든 축을 **명시**한다 — 미실측은 null 로 답한다", () => {
  for (const a of CHAT_ADAPTERS) {
    assert.ok(a.key && a.label, `${a.key} 신원`);
    assert.ok(a.transport === null || ["stdio-jsonl", "jsonrpc-stdio", "http-sse"].includes(a.transport), `${a.key} transport`);
    //  ★ 왜 이 상태인가를 반드시 적는다 — 다음 사람이 «안 했다» 와 «못 한다» 를 구분해야 한다.
    assert.ok(a.note && a.note.length > 20, `${a.key} note 가 이유를 말한다`);
    //  전송이 없으면 나머지도 없어야 한다(반쪽 선언 금지).
    if (a.transport === null) {
      assert.equal(a.argv, null, `${a.key}: 전송이 없는데 argv 가 있다`);
      assert.equal(a.translate, null, `${a.key}: 전송이 없는데 translate 가 있다`);
    }
  }
});

t("[3] ★ 번역기 없는 하네스는 chat 모드가 **안 열린다** — 빈 화면을 만들지 않는다", () => {
  for (const a of CHAT_ADAPTERS) {
    const open = canOpenChatRuntime(a.key);
    if (open) assert.ok(a.translate && a.argv && a.encode, `${a.key}: 연다면 셋 다 있어야 한다`);
    else assert.ok(!a.translate || !a.argv || !a.encode || a.transport !== "stdio-jsonl", `${a.key}: 못 여는 이유가 있다`);
  }
});

t("[4] ★ 모드 판정이 이 표에서 **파생**된다 — 두 곳에 적으면 반드시 갈린다", () => {
  for (const a of CHAT_ADAPTERS) {
    assert.equal(harnessSupportsChat(a.key), canOpenChatRuntime(a.key), `${a.key} 모드↔표 일치`);
  }
  assert.equal(harnessSupportsChat("모르는하네스"), false, "모르는 key 는 claude 로 추측하지 않는다");
});

t("[5] 지금 실제로 열리는 것 — claude 하나(나머지는 왜 아닌지 note 가 말한다)", () => {
  const open = CHAT_ADAPTERS.filter((a) => canOpenChatRuntime(a.key)).map((a) => a.key);
  assert.deepEqual(open, ["claude"]);
  //  ⚠ 이 단언은 **진도를 재는 자리**다. codex·grok·opencode 가 열리면 여기서 빨간불이 나고,
  //   그때 이 목록을 늘리면서 «무엇이 실측됐나» 를 함께 갱신하게 된다.
  assert.equal(chatAdapter("codex")!.transport, "jsonrpc-stdio", "codex 는 번역만 준비됨(기동은 기존 런타임)");
  assert.equal(chatAdapter("grok")!.transport, "jsonrpc-stdio", "grok 은 ACP 표면 확인됨(payload 실측 남음)");
  assert.equal(chatAdapter("opencode")!.transport, "http-sse", "opencode 는 serve 경로");
  assert.equal(chatAdapter("antigravity")!.transport, null, "antigravity 는 전송 자체가 미확정 + 승인 벤더 미지원");
});

t("[6] codex 번역기는 실제로 무언가를 옮긴다(표에 달아 놓고 빈 함수를 두지 않는다)", () => {
  const tr = chatAdapter("codex")!.translate!;
  const started = tr({ method: "item/started", params: { item: { type: "commandExecution", id: "c1", command: ["npm", "test"], status: "inProgress" } } });
  assert.equal(started?.t, "task.started");
  assert.equal((started as any).task.kind, "shell");
  assert.equal((started as any).task.title, "npm test");
  const ask = tr({ method: "item/commandExecution/requestApproval", params: { approvalId: "a1", command: ["rm", "-rf", "x"], reason: "위험" } });
  assert.equal(ask?.t, "permission.asked");
  assert.equal((ask as any).ask.id, "a1");
  //  모르는 것은 버리지 않는다(★2).
  assert.equal(tr({ method: "some/future/thing" })?.t, "raw");
  //  대화 축은 null(그건 ChatLine 이 그린다).
  assert.equal(tr({ method: "item/agentMessage/delta", params: { delta: "hi" } }), null);
});

console.log(`\n${pass}건 통과`);

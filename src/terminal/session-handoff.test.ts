import { strict as assert } from "node:assert";
import test from "node:test";
import type { SessionState } from "../sessions/session-state.js";
import { HANDOFF_CONTEXT_MAX, HANDOFF_PROMPT_MAX, sessionHandoffInput, sessionHandoffPrompt } from "./session-handoff.js";

test("하네스 전환 프롬프트는 선택 설정과 이전 대화를 함께 넘긴다", () => {
  const out = sessionHandoffPrompt("codex", "antigravity", { "--model": "gemini-3.7-flash-high", "--effort": "high" }, "사용자: 계속해\nAI: 진행 중");
  assert.match(out, /codex → antigravity/);
  assert.match(out, /--model=gemini-3\.7-flash-high/);
  assert.match(out, /<previous_session_context>[\s\S]*사용자: 계속해/);
});

test("긴 이전 대화는 최신 꼬리를 보존하고 첫 지시 상한을 넘지 않는다", () => {
  const old = "a".repeat(5000), recent = "z".repeat(HANDOFF_CONTEXT_MAX);
  const out = sessionHandoffPrompt("codex", "codex", {}, old + recent);
  assert.ok(out.length <= HANDOFF_PROMPT_MAX);
  assert.ok(out.includes("z".repeat(1000)), "최신 대화 꼬리가 빠졌다");
  assert.ok(!out.includes("a".repeat(1000)), "오래된 앞부분이 남았다");
});

test("화면이 대화를 못 읽어도 전환 세션이 해야 할 다음 행동을 명시한다", () => {
  const out = sessionHandoffPrompt("opencode", "claude", {}, "");
  assert.match(out, /작업 폴더와 프로젝트 맥락부터 확인/);
});

test("새 하네스는 원 세션의 작업 자리·프로젝트·권한을 그대로 이어받는다", () => {
  const st: SessionState = {
    id: "box-yoon-old", owner: "yoon", label: "이어 할 일", harness: "claude",
    dir: "/work/project/1870", root_key: "shared", subpath: "project/1870", flags: {},
    auto_approve: true, invites: ["jang"], project_id: 1870, project_src: "org", app_id: "writer",
    read_only: true, incognito: false, write_vis: "audience", restrict_read: true,
    created: 1, last_busy: null, last_seen: null, claude_session_id: null, transcript_path: null,
    exited_at: null, exit_reason: null, node_id: null,
  };
  const input = sessionHandoffInput(st, "codex", { "--model": "gpt-5.6-sol" }, "사용자: 계속해");
  assert.deepEqual({
    label: input.label, rootKey: input.rootKey, subpath: input.subpath, projectId: input.projectId,
    projectSrc: input.projectSrc, autoApprove: input.autoApprove, invites: input.invites,
    readOnly: input.readOnly, incognito: input.incognito, writeVis: input.writeVis,
    restrictRead: input.restrictRead, appId: input.appId,
  }, {
    label: "이어 할 일", rootKey: "shared", subpath: "project/1870", projectId: 1870,
    projectSrc: "org", autoApprove: true, invites: ["jang"], readOnly: true,
    incognito: false, writeVis: "audience", restrictRead: true, appId: "writer",
  });
  assert.match(input.initialPrompt || "", /claude → codex/);
});

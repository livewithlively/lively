import assert from "node:assert/strict";
import { isExternalExecutionSessionId, sessionFromHeaders } from "./agent-identity.js";

assert.equal(sessionFromHeaders({ "x-lively-session": "box-yoon-1234abcd" }), "box-yoon-1234abcd");
assert.equal(sessionFromHeaders({ "x-lively-session": "codex-0198f51f-48c8-7000-a111-0123456789ab" }), "codex-0198f51f-48c8-7000-a111-0123456789ab");
assert.equal(sessionFromHeaders({ "x-lively-session": "claude-session_123" }), "claude-session_123");
assert.equal(sessionFromHeaders({ "x-lively-session": "${CODEX_THREAD_ID}" }), null, "미확장 환경변수는 실행 id가 아니다");
assert.equal(sessionFromHeaders({ "x-lively-session": "codex-a b" }), null, "공백이 든 id는 거부");
assert.equal(sessionFromHeaders({ "x-lively-session": "plain-unscoped-id" }), null, "외부 id는 harness namespace가 필수");
assert.equal(isExternalExecutionSessionId("codex-0198f51f-48c8-7000-a111-0123456789ab"), true);
assert.equal(isExternalExecutionSessionId("box-yoon-1234abcd"), false, "관리형 box는 외부 self-claim 경로가 아니다");
// #4927 — cursor-adapter 가 Cursor 대화 id(UUID)를 `cursor-<id>` 로 싣는다. 안 받으면 Cursor 세션의 프로젝트 소속·기록 귀속이 통째로 빠진다.
assert.equal(sessionFromHeaders({ "x-lively-session": "cursor-0b6f2a1e-9c3d-4e5f-8a7b-1c2d3e4f5a6b" }), "cursor-0b6f2a1e-9c3d-4e5f-8a7b-1c2d3e4f5a6b");
assert.equal(isExternalExecutionSessionId("cursor-0b6f2a1e-9c3d-4e5f-8a7b-1c2d3e4f5a6b"), true);
assert.equal(sessionFromHeaders({ "x-lively-session": "cursorx-abc" }), null, "접두어는 정확히 cursor- 여야 한다");

console.log("✓ 관리형 box + 외부 하네스 실행 세션 id 검증");

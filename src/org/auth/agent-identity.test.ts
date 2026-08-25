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

console.log("✓ 관리형 box + 외부 하네스 실행 세션 id 검증");

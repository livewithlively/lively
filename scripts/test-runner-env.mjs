// 기본 테스트 자식의 capability 경계. 별도 모듈로 둬 부모 env가 무엇이든 deny로 수렴함을 단위 검증한다.
//
// 실행 자리의 세션 신원도 자식에게 물려주지 않는다(#5029). 라이블리 세션·노드 에이전트·하네스가 심는 값
//  (LIVELY_* · LVLY_* · TMUX* · CLAUDECODE · CLAUDE_CODE_* · CLAUDE_CONFIG_DIR · GROK_HOME · CODEX_HOME)은 CI 에 없다.
//  물려주면 같은 코드가 돌린 자리마다 다른 갈래를 탄다 — 실측(2026-10-26): 맥미니 노드가 띄운 세션의 LIVELY_NODE_TOKEN 이
//  onNode() 를 참으로 만들어 disk-guard 시험이 그 자리에서만 빨갰다(CI·SSH 로 돌린 같은 판은 초록). 값이 진짜면 더 나쁘다 —
//  시험이 실 게이트웨이·실 tmux 서버에 진짜 토큰으로 닿는다(os-sandbox.mjs offlineLivelyEnv 머리말의 사고).
//  개별 시험이 offlineLivelyEnv()/sandboxEnv() 로 막는 게 원칙이고, 여기는 관례를 모르는 새 시험도 러너 경로에선 CI 와 같은
//  env 로 돌게 하는 마지막 겹이다. ⚠ 빈 값이 아니라 **지운다** — 빈 값이 있으면 --env-file(.env)이 그 칸을 못 채운다.
const SESSION_ENV_PREFIX = /^(LIVELY_|LVLY_|CLAUDE_CODE_)/;
const SESSION_ENV_NAMES = new Set(["TMUX", "TMUX_PANE", "TMUX_BIN", "TMUX_TMPDIR", "CLAUDECODE", "CLAUDE_CONFIG_DIR", "GROK_HOME", "CODEX_HOME"]);
export const isSessionEnvKey = (key) => SESSION_ENV_PREFIX.test(key) || SESSION_ENV_NAMES.has(key);

export const testChildEnv = (parent = process.env) => ({
  ...Object.fromEntries(Object.entries(parent).filter(([key]) => !isSessionEnvKey(key))),
  LIVELY_HOST_EFFECTS: "deny",
  LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox",
  LIVELY_NO_BROWSER: "1",
});

// 혼자 도는 시험(#5029) — 벽시계 마감을 단언하는 시험(훅이 1.2초 안에 답을 못 받으면 끊는다 · 1.5초 예산의 70% 지점에서 멈춘다 …)은
//  다른 시험과 CPU 를 나눠 쓰면 시험 프로세스 안의 가짜 게이트웨이가 제때 못 답해 흔들린다. 2코어 중앙 박스(gVisor)는 기본 -j 2 에서
//  그런 넷이 빨갰고 혼자 돌리면 초록이었다(4코어 CI 는 여유가 있어 안 드러났다). 그런 파일은 머리(앞 4KB)에 `// @lively-test exclusive`
//  를 달고, 러너는 병렬 묶음을 다 돌린 뒤 하나씩 혼자 돌린다. ⚠ 상한을 늘려 흔들림을 덮는 것과 다르다 — 그 시험이 재는 것이 제품의
//  마감 동작 자체라, 상한을 바꾸면 사양이 바뀐다.
const SOLO_MARK = /^\s*\/\/\s*@lively-test\s+exclusive\b/m;
export const isSoloTest = (source) => SOLO_MARK.test(String(source ?? "").slice(0, 4096));
// 혼자 도는 것을 맨 뒤로 — 각 묶음 안의 순서는 그대로 둔다.
export const soloLast = (files, solo) => [...files.filter((f) => !solo.has(f)), ...files.filter((f) => solo.has(f))];
// 다음 파일을 지금 띄워도 되나 — 혼자 도는 파일은 아무것도 안 돌 때만, 그 밖의 파일은 동시 실행수 안에서.
export const mayStart = (nextIsSolo, running, jobs) => (nextIsSolo ? running === 0 : running < jobs);

// 기본 테스트 자식의 capability 경계. 별도 모듈로 둬 부모 env가 무엇이든 deny로 수렴함을 단위 검증한다.
//
// 실행 자리의 세션 신원도 자식에게 물려주지 않는다(#5029). 라이블리 세션·노드 에이전트·하네스가 심는 값은 CI 에 없다.
//  물려주면 같은 코드가 돌린 자리마다 다른 갈래를 탄다 — 실측(2026-10-26): 맥미니 노드가 띄운 세션의 LIVELY_NODE_TOKEN 이
//  onNode() 를 참으로 만들어 disk-guard 시험이 그 자리에서만 빨갰다(CI·SSH 로 돌린 같은 판은 초록). 값이 진짜면 더 나쁘다 —
//  시험이 실 게이트웨이·실 tmux 서버에 진짜 토큰으로 닿는다(os-sandbox.mjs offlineLivelyEnv 머리말의 사고).
//  개별 시험이 offlineLivelyEnv()/sandboxEnv() 로 막는 게 원칙이고, 여기는 관례를 모르는 새 시험도 러너 경로에선 CI 와 같은
//  env 로 돌게 하는 마지막 겹이다. ⚠ 빈 값이 아니라 **지운다** — 빈 값이 있으면 --env-file(.env)이 그 칸을 못 채운다.
//  무엇을 지우나 — 제품 코드가 «지금 어느 세션·어느 하네스 안인가» 로 읽는 값:
//   · 라이블리: LIVELY_* · LVLY_*(신원·게이트웨이·노드 토큰·세션 id …)
//   · tmux: TMUX · TMUX_PANE(지금 붙은 서버·창) · TMUX_TMPDIR(기본 소켓 자리 — 그대로 두면 소켓 없이 부른 tmux 가 그 세션 서버에 닿는다)
//   · 하네스 세션: CLAUDECODE · CLAUDE_CODE_* · CLAUDE_SESSION_ID · CODEX_THREAD_ID · CODEX_SESSION_ID · GROK_HOOK_EVENT ·
//     CURSOR_PROJECT_DIR · CURSOR_VERSION(run-custom 의 세션 폴백 · cursor 어댑터의 cwd 폴백이 읽는다)
//   · 하네스 설정 자리: CLAUDE_CONFIG_DIR · CODEX_HOME · GROK_HOME · CURSOR_CONFIG_DIR(물려주면 HOME 을 샌드박스로 돌려도 설치기가
//     실 프로필에 쓴다 — #1786 의 경로. 실 홈 가드는 기본 자리와 env 자리를 둘 다 본다)
//  ⚠ 지우지 않는 것: TMUX_BIN(tmux 실행 파일 자리 — 신원이 아니라 도구 위치다) · CODEX_E2E_BIN · GROK_E2E_BIN(사람이 실기기 e2e 에
//   쓸 바이너리를 고르는 손잡이) — 그런 «도구를 어디서 찾나» 값은 CI 와 같게 만들 대상이 아니다.
const SESSION_ENV_PREFIX = /^(LIVELY_|LVLY_|CLAUDE_CODE_)/;
const SESSION_ENV_NAMES = new Set([
  "TMUX", "TMUX_PANE", "TMUX_TMPDIR",
  "CLAUDECODE", "CLAUDE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "GROK_HOOK_EVENT", "CURSOR_PROJECT_DIR", "CURSOR_VERSION",
  "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "CURSOR_CONFIG_DIR",
]);
export const isSessionEnvKey = (key) => SESSION_ENV_PREFIX.test(key) || SESSION_ENV_NAMES.has(key);

export const testChildEnv = (parent = process.env) => ({
  ...Object.fromEntries(Object.entries(parent).filter(([key]) => !isSessionEnvKey(key))),
  LIVELY_HOST_EFFECTS: "deny",
  LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox",
  LIVELY_NO_BROWSER: "1",
});

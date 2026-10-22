// claude.ai 커넥터 끄기 (#4213 T6 #4427) — 구성원 AI 계정(Claude) 커넥터를 막은 워크스페이스에서 claude 에 실을 env 한 벌.
//  두 자리가 같은 값을 쓴다: 판(pane)의 claude(catalog.harnessSettingsArgv) · 대화 런타임의 claude(harness-io/claude-chat-runtime).
//  import 가 0 인 잎이다 — 대화 런타임이 이 값 하나 때문에 catalog 전체를 끌어오지 않게.
//
//  실측(2026-10-16 매니지드 lively-46e3, Claude Code 2.1.301): `--settings '{"env":{"ENABLE_CLAUDEAI_MCP_SERVERS":"false"}}'` 로 띄우면
//   init 의 mcp_servers 에서 claude.ai 커넥터만 빠지고 lively·lively-local·figma 는 그대로다. 같은 값을 env 로 준 `claude mcp list` 도 같았다.
//  ⚠ pane env(`-e`)로 싣지 않는다 — 셀프호스트 격리(sudo → box-spawn)는 env_reset 으로 sudoers 가 안 적은 이름을 지운다
//   (session-env-contract 머리말). `--settings` 는 argv 라 그 경계를 그대로 넘는다. 하네스 명령 앞에 `env` 를 붙이지도 않는다 —
//   런처가 «실행 파일 바로 뒤 이어 열기 인자 수» 를 세므로(resumeArgc, #4695) 자리가 밀린다.
export const CLAUDE_AI_CONNECTORS_OFF_ENV: Readonly<Record<string, string>> = Object.freeze({ ENABLE_CLAUDEAI_MCP_SERVERS: "false" });

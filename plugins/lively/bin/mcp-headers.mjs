#!/usr/bin/env node
// 동적 MCP 헤더(#1473) — 접속 토큰을 파일에서 읽어 Authorization 을 만든다.
//
// 왜 userConfig 가 아니라 파일인가 (2026-08-04 실기기 실측):
//   `sensitive: true` 인 userConfig 값은 **훅 프로세스 env 로 전달되지 않는다.** 공식 문서는 "All values are
//   exported to hook processes as CLAUDE_PLUGIN_OPTION_<KEY>" 라고 하지만, 실측하면 비민감 값만 온다.
//   그래서 토큰을 userConfig 로 받으면 MCP 는 붙어도 **훅이 게이트웨이에 인증하지 못한다** —
//   session-preload(맥락 주입)·sync-harness-assets(조직 스킬 배포)·run-custom(거버넌스 훅)·work-flag(상태 보고)가
//   전부 무력화된다. 그래서 토큰의 단일 출처를 `~/.lively/token` 파일로 두고 MCP 도 훅도 같은 파일을 읽는다.
//   (이 파일은 `bin/login.mjs` 가 디바이스 코드 로그인으로 만든다. 키트 설치 경로에선 키트가 만든다.)
//
// 계약(공식): stdout 에 문자열 key-value JSON 오브젝트. 셸에서 10초 타임아웃으로 실행되며 cwd 는 플러그인 루트.
//   세션 시작·재연결마다 새로 실행되고, 툴 호출이 401/403 이면 Claude Code 가 이 헬퍼를 **자동 재실행**해
//   새 헤더로 재연결한다 — 그래서 토큰을 갱신하면 재설치 없이 다음 호출부터 반영된다.
// 실패해도 빈 객체를 낸다 — 연결 자체를 막지 않고 게이트웨이가 401 로 안내하게 둔다(진단이 더 명확하다).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const token = ((process.env.LIVELY_TOKEN || "").trim())
  || (() => { try { return readFileSync(join(homedir(), ".lively", "token"), "utf8").trim(); } catch { return ""; } })();

process.stdout.write(JSON.stringify(token ? { Authorization: `Bearer ${token}` } : {}));

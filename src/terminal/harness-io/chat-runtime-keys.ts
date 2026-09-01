// 대화 런타임을 **열 수 있는 하네스** — 키만 담은 가벼운 자리 (#2439).
//
//  ── 왜 표에서 갈라 두나 ─────────────────────────────────────────────────────────
//  [[chat-adapters.ts]] 가 정본이지만 그 표는 **함수를 담는다**(translate·encode·respond).
//  그래서 «이 하네스가 대화 런타임을 여나» 를 묻기만 해도 번역기 넷이 통째로 딸려 온다 —
//  노드 에이전트 번들 경계 가드가 그것을 잡았다(실측 2026-09-01: 새 모듈 6개).
//  노드 에이전트는 pane 명령 하나를 정하려는 것뿐인데 번역기를 실을 이유가 없다.
//
//  ⚠ 그래서 **사실(키)**과 **행동(함수)**을 가른다. 두 벌이 되지 않게 계약 테스트가
//   `canOpenChatRuntime(k) === harnessOpensChatRuntime(k)` 를 전 키에서 강제한다 —
//   표에 하네스를 더하고 여기를 안 고치면 그 자리에서 빨간불이 난다.
export const CHAT_RUNTIME_KEYS = ["claude", "codex", "grok", "opencode", "antigravity"] as const;

/** 이 하네스가 대화 런타임을 열 수 있나 — 모르는 키는 false(있는 척하지 않는다). */
export function harnessOpensChatRuntime(key: string | null | undefined): boolean {
  return !!key && (CHAT_RUNTIME_KEYS as readonly string[]).includes(key);
}

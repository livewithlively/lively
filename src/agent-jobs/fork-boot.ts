// 세션 분기 실행(#4489 앱 v2-10)의 판 재료 — 순수. 작업 컨테이너(#4490)가 «사람 세션의 대화를 이어받는 보이지 않는 한 번» 을 돌릴 때
//  하네스 인자 · 환경 · 판 임시 폴더에 쓸 파일을 만든다(service.onBoot 가 부트 응답에 싣는다).
//
// ── 무엇을 맞추나(설계 §4 · §12 ④ 실측) ─────────────────────────────────────
//  캐시는 대화 앞부분(시스템 프롬프트 · 도구 정의 · 대화)이 본 세션과 바이트까지 같을 때만 맞는다. 그래서 하네스 인자는 본 세션이 뜬
//  설정(모델 · 클로드 커넥터 막음)을 그대로 따르고, 도구를 줄이는 인자(--tools · --disallowedTools · --strict-mcp-config ·
//  --json-schema)는 쓰지 않는다. 도구 경계는 PreToolUse 훅(fork-guard)이 실행만 막는다. 생각 강도(effort)는 바꿔도 캐시가 이어졌다
//  (실측 2026-10-20: max → low 에서 캐시 읽기 39.4만 / 새로 0.5만) — 그래도 본 세션 설정을 따른다(답의 결이 본 세션과 같게).
//
// ── 권한 — 둘째 문 ─────────────────────────────────────────────────────────────
//  분기는 본 세션의 자동 승인을 따르지 않고 늘 `--permission-mode dontAsk` 로 돈다(판정기 훅이 허락하지 않은 도구는 묻지 않고 거절). 판정기가
//  죽거나 시간을 넘기면 훅은 «판정 없음» 이 되는데, 자동 승인이면 그때 셸이 그대로 돈다(격리 리뷰). 실측(2026-10-20 · claude 2.1.304):
//   · 훅이 죽어도(exit 1) dontAsk 면 Bash 거절 — 사용자 설정의 기본 모드(auto)로 두면 그대로 돌았다. 단 dontAsk 는 «물어야 할 것» 만
//     거절한다 — 본 세션에서 «항상 허용» 으로 쌓인 허용 규칙(.claude/settings*.json)이 있으면 훅이 답하지 못한 때 그 규칙대로 돈다(재검토).
//   · 권한 모드는 캐시를 깨지 않는다 — 이 세션을 dontAsk 로 분기(읽기 60.9만 · 새로 3.9만) → 이어 자동 승인으로 분기하니 앞 분기가 쓴 캐시를
//     남김없이 읽었다(64.8만 · 새로 0).
//   · 작업 폴더의 `.claude/settings.local.json` 이 `disableAllHooks: true` 면 판정기 훅이 아예 불리지 않았다 — 판의 설정에
//     `disableAllHooks: false` 를 적으면 그것이 이겼다(그래서 늘 적는다).
//
// ── 무엇을 끄나 ──────────────────────────────────────────────────────────────
//  · 키트 훅 전부 — `LIVELY_HOOKS_OFF=1`(키트 훅이 모두 이 값을 보고 곧바로 빠진다 — run-custom · work-flag · session-preload ·
//    sync-harness-assets · stop-writeback-gate). 켜 두면 대화 매핑 보고(work-flag)가 분기 대화 id 로 본 세션을 덮고, 종료 게이트가
//    무인 실행을 한 턴 더 끌고, 맥락 주입이 분기 입력을 불린다.
//  · 라이블리 쓰기 — `LIVELY_MODE=readonly`(MCP 프록시가 x-lively-mode 로 싣는다 → 게이트웨이가 쓰기 도구를 목록에서 빼고 막는다 · #1007).
//    비공개(incognito) 세션은 분기하지 않는다(ai-runs/fork.forkRefusal — 라이블리와 끊긴 대화를 앱으로 내보내지 않는다).
//  · 대화 저장 — `--no-session-persistence`(분기 대화 파일이 생기지 않는다 · 원래 대화 파일에도 한 줄도 안 쓴다 — 실측).
//
// ── 무엇을 남기나 ────────────────────────────────────────────────────────────
//  · `LIVELY_SESSION_ID` = 본 세션 id — 라이블리 도구 호출이 본 세션에서 온 것으로 실린다(그 앱의 표 읽기는 «이 세션에 붙은 앱» 판정을
//    탄다 — apps/session-apps.requireAttachedApp). 대화 매핑을 덮던 훅은 위에서 껐다.
import { FORK_GUARD_SOURCE, type ForkGuardConfig } from "./fork-guard.js";
import { APP_ID_RE } from "./plan.js";
import { CLAUDE_AI_CONNECTORS_OFF_ENV } from "../terminal/claude-ai-connectors-off.js";   // #4427 — import 0 인 잎(본 세션 판과 한 벌)

/** 분기 작업의 좌표(org_agent_job.fork) — ai-runs 가 접수 때 사람 세션의 실행 설정에서 만든다. */
export interface ForkSpec {
  /** 대화를 이어받는 사람 세션(box-…). */
  session: string;
  /** 그 세션의 하네스 대화 id(claude UUID). */
  conversation: string;
  /** 지금은 claude 만(Codex 는 #4920 — OpenAI 약관 · 로그인 파일 동시 갱신 위험). */
  harness: "claude";
  /** 본 세션이 뜬 모델 인자(세션 실행 설정의 --model · 없으면 null = 멤버 기본). */
  model: string | null;
  /** 본 세션의 생각 강도 인자(--effort). */
  effort: string | null;
  /** #4427 — 구성원 AI 계정(Claude) 커넥터를 막은 워크스페이스인가(막았으면 본 세션도 같은 env 로 떴다 — 도구 목록이 같아야 캐시가 맞는다). */
  block_connectors: boolean;
  /** 작업 폴더 기준 그 앱의 폴더(.lively/apps/<앱>) — 판정기가 이 숨김 자리만은 읽게 한다. */
  app_folder: string | null;
}

export const FORK_MODEL_RE = /^[a-z0-9][a-z0-9.\-[\]]{1,63}$/i;
export const FORK_EFFORT_RE = /^(low|medium|high|xhigh|max)$/;
/** 분기 대상 세션 id 모양 — 사람 세션은 `box-…`. 형식만 본다(있나 · 누구 것인가는 ai-runs 가 사실로 본다). 이 한 자리를 ai-runs 도 쓴다. */
export const FORK_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONV_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_FOLDER_PREFIX = ".lively/apps/";

/** (순수) 저장된 분기 좌표를 읽는다 — 모양이 틀리면 null(그 작업은 돌리지 않는다 · argv 로 들어가는 값이라 엄격하게). */
export function parseForkSpec(raw: unknown): ForkSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const s = typeof o.session === "string" ? o.session : "";
  const c = typeof o.conversation === "string" ? o.conversation : "";
  if (!FORK_SESSION_RE.test(s) || !CONV_RE.test(c) || o.harness !== "claude") return null;
  const model = typeof o.model === "string" && o.model ? o.model : null;
  const effort = typeof o.effort === "string" && o.effort ? o.effort : null;
  if (model && !FORK_MODEL_RE.test(model)) return null;
  if (effort && !FORK_EFFORT_RE.test(effort)) return null;
  const app = typeof o.app_folder === "string" && o.app_folder.startsWith(APP_FOLDER_PREFIX) ? o.app_folder.slice(APP_FOLDER_PREFIX.length) : "";
  return {
    session: s, conversation: c.toLowerCase(), harness: "claude", model, effort,
    block_connectors: o.block_connectors === true, app_folder: APP_ID_RE.test(app) ? APP_FOLDER_PREFIX + app : null,
  };
}

/** 판정기를 부르는 훅 한 줄 — 판이 자리표를 노드 실행 파일 · 판정기 · 설정 파일 경로로 바꾼다. */
export const FORK_GUARD_COMMAND = `"{{LVLY_NODE}}" "{{LVLY_FILE:guard.cjs}}" "{{LVLY_FILE:guard.json}}"`;

export interface ForkBoot {
  argv: string[];
  env: Record<string, string>;
  files: Array<{ name: string; content: string }>;
  input: "stream";
  turns: number;
}

/**
 * (순수) 분기 판의 재료.
 *  · argv: `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --resume <대화> --fork-session
 *    --no-session-persistence --permission-mode dontAsk [--model] [--effort] --settings <판이 쓴 파일>`.
 *  · settings: 훅 끄기 막음(disableAllHooks false) + 판정기를 PreToolUse 훅으로(모든 도구) + (막았으면) 클로드 커넥터 막음 env.
 *  · turns: «형식에 맞게 다시» 한 번 — 같은 프로세스에 한 턴 더(실측: 캐시가 이어진다).
 */
export function forkBoot(o: { spec: ForkSpec; cwd: string; appId: string; livelyAllow: string[] }): ForkBoot {
  const s = o.spec;
  if (s.model && !FORK_MODEL_RE.test(s.model)) throw new Error(`모델 인자 형식 밖: ${JSON.stringify(s.model)}`);
  if (s.effort && !FORK_EFFORT_RE.test(s.effort)) throw new Error(`생각 강도 형식 밖: ${JSON.stringify(s.effort)}`);
  if (!CONV_RE.test(s.conversation)) throw new Error("대화 id 형식 밖");
  const guard: ForkGuardConfig = { root: o.cwd, appId: o.appId, appFolder: s.app_folder, livelyServer: "lively", livelyAllow: o.livelyAllow };
  const settings: Record<string, unknown> = {
    disableAllHooks: false,
    ...(s.block_connectors ? { env: { ...CLAUDE_AI_CONNECTORS_OFF_ENV } } : {}),
    hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: FORK_GUARD_COMMAND, timeout: 10 }] }] },
  };
  return {
    argv: [
      "claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
      "--resume", s.conversation, "--fork-session", "--no-session-persistence", "--permission-mode", "dontAsk",
      ...(s.model ? ["--model", s.model] : []),
      ...(s.effort ? ["--effort", s.effort] : []),
      "--settings", "{{LVLY_FILE:settings.json}}",
    ],
    env: { LIVELY_SESSION_ID: s.session, LIVELY_HOOKS_OFF: "1", LIVELY_MODE: "readonly" },
    files: [
      { name: "guard.cjs", content: FORK_GUARD_SOURCE },
      { name: "guard.json", content: JSON.stringify(guard) },
      { name: "settings.json", content: JSON.stringify(settings) },
    ],
    input: "stream",
    turns: 1,
  };
}

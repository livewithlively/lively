// terminal/profile-kit-seed.ts — 멤버 전용 CLAUDE_CONFIG_DIR(프로필 격리 #346·#1014)의 **키트 배선 보장**. (#4135)
//
//  ── 무엇이 고장나 있었나(2026-09-25 실측 — 노드 laibeulliui-macmini · 멤버 wonjoon-jang) ──
//  createSession(sessions.ts)과 위탁 러너(node/tasks.ts)는 프로필 dir 을 `mkdir` 만 하고 CLAUDE_CONFIG_DIR 로 박는다.
//  그 dir 에 키트를 심는 길은 게이트웨이 호스트의 관리자 버튼(provisionProfile → deploy/provision-profile.sh →
//  install-kit.sh) 하나뿐이고, **노드(멤버 PC·공유 맥미니)에는 그 길이 없다.** 결과는 빈 프로필이다 —
//  settings.json 에 훅 0 · .claude.json 에 MCP 0. Claude Code 는 CLAUDE_CONFIG_DIR 이 있으면 홈의 ~/.claude/settings.json
//  을 보지 않으므로, 그 멤버의 **모든** 세션에서 다음이 통째로 안 돌았다: work-flag(세션 단계 보고 → 사이드바 점),
//  run-custom(조직 훅: project-push 업싱크 → 자료 칸, AGENTS 주입, 세션 이름짓기), stop-writeback-gate, self-update.
//  (실측: 9/22 이후 그 멤버의 Claude 세션 7건 모두 $TMPDIR/lively-hooks 에 플래그 0건 · 세션이 만든 파일이 자료 칸에
//   안 올라옴 · 홈 사이드바 점이 안 깜빡임. 프로필 settings.json 에 훅을 심자 **켜 둔 세션에서도** 다음 턴부터 훅이 돌았다.)
//
//  ── 어떻게 ──
//  배선의 엔진은 키트 CLI 다(`~/.lively/lib/lively.mjs install` — 번들 동봉 user-install.mjs 를 CLAUDE_CONFIG_DIR 을
//  겨냥해 돌린다. deploy/provision-profile.sh 가 게이트웨이에서 하는 것과 같은 일). 여기선 그 CLI 를 **그 프로필 dir 을
//  겨냥해** 한 번 부른다. 판정은 마커 파일이 아니라 **결과물**이다 — settings.json 에 라이블리 훅 배선(.lively/hooks/ 를
//  가리키는 명령)이 있나. 마커는 사람이 지운 배선을 못 본다. 이미 배선돼 있으면 파일 읽기 한 번으로 끝난다.
//  · best-effort — 실패해도 세션 생성을 막지 않는다(member-kit-seed 와 같은 규율). 다음 생성이 다시 시도한다.
//  · 같은 프로필의 동시 생성은 in-flight 를 공유한다(설치기를 두 번 겹쳐 돌리지 않는다).
//  · 이 호스트에 키트 CLI 가 없으면(키트 미설치 박스) 조용히 건너뛰고 로그만 남긴다 — 종전 동작 그대로.
//  · 설치기(user-install.mjs)는 **비파괴 머지**다(백업 뒤 센티넬 dedup) — 사람이 프로필에 둔 permissions·theme 는 살아남는다.
//  ── member-kit-seed 와의 경계 ──
//  member-kit-seed 는 **격리 멤버 홈**(osUser 경로 · 중계 배포)에 `~/.lively` 통째와 `~/.claude/settings.json` 을 심는다.
//  여기는 **비격리 경로**의 프로필 dir(CLAUDE_CONFIG_DIR) 하나만 다룬다 — 홈(`~/.lively` 키트·토큰)은 이미 이 호스트에 있고,
//  claude 가 그 홈 대신 읽을 settings.json·.claude.json 만 비어 있는 경우다. 두 길은 같은 세션에서 겹치지 않는다(sessions.ts 의 osUser 분기).
//  ⚠ 의존 방향: 이 모듈은 sessions.ts 를 통해 **노드 에이전트 번들**에 실린다 — node 내장 모듈과 log 만 문다.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { logger } from "../log.js";

/** 라이블리 훅 배선의 신호 — 명령이 키트 훅 폴더를 가리킨다(user-install 이 심는 그대로: `"node" "$HOME/.lively/hooks/…"`). */
export const HOOK_WIRING_RE = /\.lively[\\/]hooks[\\/]/;
/** 설치기 상한 — member-kit-seed(90s)와 같은 자리. 번들 다운로드 + 설치 실측 5~20초. 넘으면 포기(다음 세션이 재시도). */
export const SEED_TIMEOUT_MS = 90_000;
/** 실패를 기억하는 시간 — 늘 실패하는 노드(오프라인 등)에서 **매 세션 생성**이 상한까지 기다리지 않게. self-update 의 백오프와 같은 뜻. */
export const RETRY_AFTER_MS = 10 * 60_000;

/** settings.json 본문에 라이블리 훅 배선이 있나 — 순수. 못 읽었거나(null) 깨진 JSON 이면 «없다». */
export function profileHooksWired(settingsJson: string | null | undefined): boolean {
  if (!settingsJson) return false;
  let s: unknown;
  try { s = JSON.parse(settingsJson); } catch { return false; }
  const hooks = s && typeof s === "object" ? (s as { hooks?: unknown }).hooks : null;
  if (!hooks || typeof hooks !== "object") return false;
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const list = g && typeof g === "object" && Array.isArray((g as { hooks?: unknown }).hooks) ? (g as { hooks: unknown[] }).hooks : [];
      for (const h of list) {
        const cmd = h && typeof h === "object" ? (h as { command?: unknown }).command : null;
        if (typeof cmd === "string" && HOOK_WIRING_RE.test(cmd)) return true;
      }
    }
  }
  return false;
}

/** 바깥 의존(테스트 주입용) — 판정·순서는 이 모듈이, 실행은 이들이. */
export interface ProfileSeedDeps {
  /** 키트 CLI 경로. 기본 `~/.lively/lib/lively.mjs`(user-install 이 심는 자리). */
  cli: string;
  /** 설치기를 돌린다. `timeoutMs` 안에 끝나야 한다 — 넘기면 거부. */
  run: (cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<void>;
  /** 설치기 상한(기본 SEED_TIMEOUT_MS). */
  timeoutMs?: number;
  /** 실패를 기억하는 시간(기본 RETRY_AFTER_MS). 0 이면 매번 다시 시도. */
  retryAfterMs?: number;
}
export function defaultProfileSeedDeps(): ProfileSeedDeps {
  return {
    cli: path.join(os.homedir(), ".lively", "lib", "lively.mjs"),
    //  stdio 를 물리지 않는다(ignore) — execFile 은 자식의 **stdio 가 닫힐 때** 끝나므로, 설치기가 stdout 을 물려받은 손자
    //  (자가 갱신·백그라운드 등록 등)를 남기면 상한이 지나도 영영 settle 하지 않는다(리뷰 지적). 여기선 **exit** 만 본다.
    //  상한은 우리 타이머다 — 넘으면 SIGKILL 하고 거부한다.
    run: (cmd, args, env, timeoutMs) => new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { env, stdio: "ignore", windowsHide: true });
      let done = false;
      const settle = (fn: () => void): void => { if (done) return; done = true; clearTimeout(timer); fn(); };
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* 이미 죽었다 */ }
        settle(() => reject(new Error(`설치기가 ${timeoutMs}ms 안에 끝나지 않았다(SIGKILL)`)));
      }, timeoutMs);
      child.on("error", (e) => settle(() => reject(e)));
      child.on("exit", (code, signal) => settle(() => (code === 0 ? resolve() : reject(new Error(`설치기 exit ${code ?? signal}`)))));
    }),
  };
}

const inflight = new Map<string, Promise<boolean>>();
const lastFailed = new Map<string, number>();   // profileDir → 마지막 실패 시각(백오프)

/**
 * 이 프로필 dir 에 키트 배선이 있음을 보장한다(멱등·best-effort). 돌려주는 값은 «지금 배선돼 있나».
 *  호출자는 CLAUDE_CONFIG_DIR 을 주입하기로 **이미 정한 뒤**에, 세션(판)을 띄우기 전에 부른다 — 첫 턴부터 훅이 돌아야 한다.
 *  절대 던지지 않고, 상한(deps.timeoutMs) 을 넘겨 기다리지도 않는다 — run 이 어떻게 매달리든 세션 생성은 그 안에 풀린다.
 */
export async function ensureProfileKitWired(profileDir: string, deps: ProfileSeedDeps = defaultProfileSeedDeps()): Promise<boolean> {
  const settings = path.join(profileDir, "settings.json");
  const read = (): Promise<string | null> => fsp.readFile(settings, "utf8").catch(() => null);
  if (profileHooksWired(await read())) return true;           // 빠른 경로 — 이미 심겨 있다(대부분의 세션)
  const retryAfter = deps.retryAfterMs ?? RETRY_AFTER_MS;
  const failedAt = lastFailed.get(profileDir);
  if (failedAt !== undefined && Date.now() - failedAt < retryAfter) return false;   // 방금 실패했다 — 매 세션마다 상한까지 기다리지 않는다
  let p = inflight.get(profileDir);
  if (!p) {
    p = (async (): Promise<boolean> => {
      try { await fsp.access(deps.cli); }
      catch { logger.warn({ profileDir, cli: deps.cli }, "프로필 키트 배선 건너뜀 — 이 호스트에 키트 CLI 가 없다(키트 미설치)"); return false; }
      logger.info({ profileDir }, "프로필 키트 배선 시작 — 빈 CLAUDE_CONFIG_DIR 에 훅·MCP 를 심는다");
      // CLI 는 CLAUDE_CONFIG_DIR 을 그대로 겨냥한다(kit/cli/lively.mjs claudeConfigDir). 브라우저는 절대 띄우지 않는다.
      const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: profileDir, LIVELY_NO_BROWSER: "1" };
      const timeoutMs = deps.timeoutMs ?? SEED_TIMEOUT_MS;
      //  run 자체의 상한 위에 한 겹 더 — run 이 상한을 안 지키는 구현이어도 세션 생성이 매달리지 않는다(약간의 여유를 준다).
      let guard: ReturnType<typeof setTimeout> | undefined;
      const wall = new Promise<never>((_, reject) => { guard = setTimeout(() => reject(new Error(`설치기가 ${timeoutMs}ms 상한을 넘겼다`)), timeoutMs + 2_000); });
      try { await Promise.race([deps.run(process.execPath, [deps.cli, "install", "--harness", "claude"], env, timeoutMs), wall]); }
      catch (e) {
        lastFailed.set(profileDir, Date.now());
        logger.warn({ profileDir, err: (e as Error)?.message || String(e), retryAfterMs: retryAfter }, "프로필 키트 배선 실패 — 세션은 그대로 뜨고, 잠시 뒤 세션 생성이 다시 시도한다");
        return false;
      } finally { clearTimeout(guard); }
      const ok = profileHooksWired(await read());
      if (ok) { lastFailed.delete(profileDir); logger.info({ profileDir }, "프로필 키트 배선 완료(settings.json 훅 + lively MCP)"); }
      else { lastFailed.set(profileDir, Date.now()); logger.warn({ profileDir }, "프로필 키트 배선을 돌렸는데 settings.json 에 훅이 없다 — 설치기 출력을 확인하라"); }
      return ok;
    })();
    inflight.set(profileDir, p);
    p.finally(() => inflight.delete(profileDir)).catch(() => { /* 위에서 다 잡는다 — unhandled 방지 */ });
  }
  return p;
}

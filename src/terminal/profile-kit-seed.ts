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
//  ⚠ 의존 방향: 이 모듈은 sessions.ts 를 통해 **노드 에이전트 번들**에 실린다 — node 내장 모듈과 log 만 문다.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { logger } from "../log.js";

/** 라이블리 훅 배선의 신호 — 명령이 키트 훅 폴더를 가리킨다(user-install 이 심는 그대로: `"node" "$HOME/.lively/hooks/…"`). */
export const HOOK_WIRING_RE = /\.lively[\\/]hooks[\\/]/;
/** 설치기 상한 — member-kit-seed(90s)와 같은 자리. 번들 다운로드 + 설치 실측 5~20초. 넘으면 포기(다음 세션이 재시도). */
export const SEED_TIMEOUT_MS = 90_000;

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
  run: (cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<void>;
}
export function defaultProfileSeedDeps(): ProfileSeedDeps {
  return {
    cli: path.join(os.homedir(), ".lively", "lib", "lively.mjs"),
    run: (cmd, args, env, timeoutMs) => new Promise<void>((resolve, reject) => {
      execFile(cmd, args, { env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err) => (err ? reject(err) : resolve()));
    }),
  };
}

const inflight = new Map<string, Promise<boolean>>();

/**
 * 이 프로필 dir 에 키트 배선이 있음을 보장한다(멱등·best-effort). 돌려주는 값은 «지금 배선돼 있나».
 *  호출자는 CLAUDE_CONFIG_DIR 을 주입하기로 **이미 정한 뒤**에, 세션(판)을 띄우기 전에 부른다 — 첫 턴부터 훅이 돌아야 한다.
 */
export async function ensureProfileKitWired(profileDir: string, deps: ProfileSeedDeps = defaultProfileSeedDeps()): Promise<boolean> {
  const settings = path.join(profileDir, "settings.json");
  const read = (): Promise<string | null> => fsp.readFile(settings, "utf8").catch(() => null);
  if (profileHooksWired(await read())) return true;           // 빠른 경로 — 이미 심겨 있다(대부분의 세션)
  let p = inflight.get(profileDir);
  if (!p) {
    p = (async (): Promise<boolean> => {
      try { await fsp.access(deps.cli); }
      catch { logger.warn({ profileDir, cli: deps.cli }, "프로필 키트 배선 건너뜀 — 이 호스트에 키트 CLI 가 없다(키트 미설치)"); return false; }
      logger.info({ profileDir }, "프로필 키트 배선 시작 — 빈 CLAUDE_CONFIG_DIR 에 훅·MCP 를 심는다");
      // CLI 는 CLAUDE_CONFIG_DIR 을 그대로 겨냥한다(kit/cli/lively.mjs claudeConfigDir). 브라우저는 절대 띄우지 않는다.
      const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: profileDir, LIVELY_NO_BROWSER: "1" };
      try { await deps.run(process.execPath, [deps.cli, "install", "--harness", "claude"], env, SEED_TIMEOUT_MS); }
      catch (e) {
        logger.warn({ profileDir, err: (e as Error)?.message || String(e) }, "프로필 키트 배선 실패 — 세션은 그대로 뜨고, 다음 세션 생성이 다시 시도한다");
        return false;
      }
      const ok = profileHooksWired(await read());
      if (ok) logger.info({ profileDir }, "프로필 키트 배선 완료(settings.json 훅 + lively MCP)");
      else logger.warn({ profileDir }, "프로필 키트 배선을 돌렸는데 settings.json 에 훅이 없다 — 설치기 출력을 확인하라");
      return ok;
    })();
    inflight.set(profileDir, p);
    p.finally(() => inflight.delete(profileDir)).catch(() => { /* 위에서 다 잡는다 — unhandled 방지 */ });
  }
  return p;
}

// 세션 컨테이너 안 tmux (#2545 · #2258 이동 2 의 3단계) — 코어 쪽 조각: 순수 판정 + 세션 컨테이너 확보 훅 호출.
//
// ── 무엇이 바뀌나 ───────────────────────────────────────────────────────────
// 매니지드에서 세션의 tmux 서버는 테넌트 공용 tmux 컨테이너에 살았고, 판(pane)의 명령이 세션 spawn 훅(LIVELY_SESSION_SPAWN)으로
//  세션 컨테이너를 요청한 뒤 거기에 exec(dtach)했다 — 판이 먼저 뜨고 컨테이너가 나중이라(닭과 달걀) exec 한 홉·PTY 두 겹·dtach 이
//  끼었다. 새 경로: 게이트웨이가 **DB desired 행 → ensure 훅으로 세션 컨테이너 → 그 안에서 `tmux new-session`** 순으로 만든다.
//  tmux 명령·attach 는 종전 seam(LIVELY_TMUX_EXEC)을 그대로 타고, 어느 컨테이너로 갈지는 브로커의 해석기가 정한다(코어 무변경).
//  판 명령은 box-spawn 이다 — 컨테이너 안 tmux 가 이미 멤버 uid 로 돌므로 sudo 도 spawn 훅도 필요 없고, box-spawn 은
//  env 계약(deploy/linux/session-env.sh)·cwd·exec 만 한다(셀프호스트 격리와 같은 파일, 같은 계약).
//
// ── 켜는 법 — ensure 훅 하나로 갈린다(#2546 4단계에서 글롭 게이트 폐지) ──────────
//  · LIVELY_SESSION_ENSURE = "<프로그램> … {slug}" — 세션 컨테이너를 미리 확보하는 훅(매니지드: session-ensure-relay.cjs).
//    표준입력으로 요청 JSON, 표준출력으로 JSON {container, created}. 비-0 은 실패다. **이게 설정된 배포(=매니지드)면
//    격리 새 세션은 항상 세션 컨테이너 안 tmux 다.** 셀프호스트는 이 훅이 없어 종전(wrapAsMember=box-spawn) 그대로.
//  · (폐지) LIVELY_TMUX_IN_SESSION — 3단계의 점진 롤아웃 게이트였다. 4단계에서 옛 경로를 없애 게이트할 대상이 없어졌다(이제 무시).
//  기존 세션은 어느 쪽이든 안 바뀐다(태어날 때 정해진다). ⚠ 호출 시점에 env 를 읽는다(tmuxExecArgv 와 같은 이유).
//
// ⚠ 이 모듈은 노드 에이전트 번들에도 실린다(sessions.ts 가 import) — DB·자격 모듈을 끌어오지 않는다.
import { spawn } from "node:child_process";
import { BOX_SPAWN } from "./terminal-isolation.js";

/** (순수) 세션 컨테이너 확보 훅이 설정됐나. */
export function sessionEnsureConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.LIVELY_SESSION_ENSURE || "").trim();
}

/**
 * (순수) 이 테넌트의 **새 세션**이 «자기 세션 컨테이너 안 tmux» 로 뜨나.
 *  #2546 (4단계) — 옛 경로를 없앴으므로 **매니지드(= ensure 훅 설정)면 항상 참**이다. 슬러그가 없으면(단일 테넌트
 *  셀프호스트) 거짓 — 훅에 테넌트 컨텍스트를 줄 수 없다. 셀프호스트(훅 없음)도 거짓 → wrapAsMember(box-spawn) 그대로.
 *  종전의 LIVELY_TMUX_IN_SESSION 글롭 게이트는 폐지했다(게이트할 옛 경로가 없다).
 */
export function tmuxInSessionContainer(slug: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  return !!slug && sessionEnsureConfigured(env);
}

/**
 * (순수) 훅 argv. `{slug}` 는 테넌트로 치환한다 — 컨텍스트가 없으면 **던진다**(기본값으로 접으면 남의 테넌트에 컨테이너를 만든다).
 *  설정이 없으면 빈 배열(호출자가 «이 배포는 옛 경로» 로 읽는다).
 */
export function sessionEnsureArgv(slug: string | null, env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.LIVELY_SESSION_ENSURE || "").trim();
  if (!raw) return [];
  if (!raw.includes("{slug}")) return raw.split(/\s+/);
  if (!slug) throw new Error("세션 컨테이너 확보 훅에 테넌트 컨텍스트가 필요합니다 — 컨텍스트 밖에서 호출됐습니다");
  return raw.replace("{slug}", slug).split(/\s+/);
}

/**
 * (순수) 새 경로의 판(pane) 명령 — `box-spawn --cwd <dir> <launch…>`.
 *  sudo(권한 강하)도 세션 spawn 훅도 없다: 컨테이너 안 tmux 서버가 이미 멤버 uid 로 돈다(브로커가 그 uid 로 exec 한다).
 *  box-spawn 은 `id -un` 으로 신원을 되읽고(컨테이너 기동 스크립트가 그 계정을 만든다) session-env.sh 로 env 계약을 깐 뒤
 *  cwd 로 가서 exec 한다 — launch 가 비면 로그인 셸(셸 세션). 셀프호스트 격리(wrapAsMember)와 **같은 파일·같은 계약**이다.
 */
export function sessionPaneArgv(cwd: string, launch: readonly string[]): string[] {
  return [BOX_SPAWN, "--cwd", cwd, ...launch];
}

/** 훅에 넘기는 요청 — 브로커 /lvly/session/ensure 의 본문 그대로. uid·gid 는 싣지 않는다(코어는 모른다 — 브로커가 테넌트 uid 로 채운다). */
export interface SessionEnsureRequest {
  sessionId: string;
  osUser: string;
  /** 컨테이너 경로(코어가 아는 그 경로 — /home/box_x/… · /work/shared/…). 브로커가 호스트 경로로 번역한다. */
  cwd: string;
  /** 메모리 캡(MB). 0 = 브로커 기본값. */
  memMb: number;
  /** 스케줄링 예약치(MB). 0 = 브로커 기본값. */
  memRequestMb: number;
  tmux: "inside";
}

/**
 * 훅을 실행해 세션 컨테이너를 확보한다. 실패(비-0·비JSON·container 없음·타임아웃·실행 불가)는 **던진다** — 조용한 폴백 금지.
 *  타임아웃 기본 130초: 매니지드의 세션 spawn 훅(container-spawn.sh)이 브로커에 주던 `--max-time 120` 과 같은 급이다
 *  (이미지 전개·용량 심사·CNI·runsc 기동이 다 여기 든다).
 */
export async function ensureSessionContainerViaRelay(
  argv: readonly string[],
  req: SessionEnsureRequest,
  opts?: { timeoutMs?: number },
): Promise<{ container: string; created: boolean } & Record<string, unknown>> {
  if (!argv.length) throw new Error("세션 컨테이너 확보 훅(LIVELY_SESSION_ENSURE)이 없습니다");
  const timeoutMs = opts?.timeoutMs ?? 130_000;
  return new Promise((resolve, reject) => {
    const [bin, ...rest] = argv;
    const child = spawn(bin!, rest, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let out = ""; let err = ""; let done = false;
    const finish = (fn: () => void): void => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => finish(() => {
      try { child.kill("SIGKILL"); } catch { /* 이미 끝났다 */ }
      reject(new Error(`세션 컨테이너 확보 훅 시간초과(${timeoutMs}ms)`));
    }), timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => finish(() => reject(new Error(`세션 컨테이너 확보 훅 실행 실패: ${e.message}`))));
    child.on("close", (code) => finish(() => {
      if (code !== 0) { reject(new Error(`세션 컨테이너 확보 실패(훅 종료코드 ${code}): ${(err || out).trim().slice(0, 400)}`)); return; }
      let j: Record<string, unknown>;
      try { j = JSON.parse(out) as Record<string, unknown>; } catch { reject(new Error(`세션 컨테이너 확보 훅의 응답이 JSON 이 아닙니다: ${out.trim().slice(0, 200)}`)); return; }
      if (!j || typeof j !== "object" || typeof j.container !== "string" || !j.container) {
        reject(new Error(`세션 컨테이너 확보 훅의 응답에 container 가 없습니다: ${out.trim().slice(0, 200)}`)); return;
      }
      resolve({ ...j, container: j.container, created: j.created === true });
    }));
    child.stdin.on("error", () => undefined);   // 훅이 먼저 죽으면 EPIPE — close 가 사유를 말한다
    child.stdin.end(JSON.stringify(req));
  });
}

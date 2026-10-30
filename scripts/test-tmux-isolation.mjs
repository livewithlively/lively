// 시험의 tmux 자리를 임시 폴더로 떼어 놓는다 — 불러오기만 하면 된다(`import "<경로>/scripts/test-tmux-isolation.mjs"`, 터미널 모듈을 불러오기 전에).
//
//  왜: 진짜 Express 에 여러 길을 부르는 시험(앱 맥락 범위 훑기 등)은 세션을 띄우는 길을 밟을 수 있다. 터미널 모듈의 tmux 소켓(기본 소켓 ·
//   노드 에이전트가 켠 뒤면 `-L lively-mux-<판>`)은 `${TMUX_TMPDIR:-/tmp}/tmux-<uid>/` 에 생긴다 — 그대로 두면 시험이 이 PC 의 실제 tmux 서버에
//   시험 사용자의 세션을 남긴다(2026-10-28 맥미니 실측: 노드 tmux 서버의 사람 세션 곁에 시험 세션 9개).
//  ⚠ `$TMUX` 가 `TMUX_TMPDIR` 을 이긴다(지식 tmux-experiment-isolation-tmux-env-beats-tmpdir-3545) — 둘 다 바꾼다. 터미널 모듈은 env 를 불러올 때
//   한 번 읽으므로(terminal/tmux-exec.ts TMUX_ENV) 이 모듈을 먼저 불러와야 한다.
//  끝난 뒤 `leftTmuxSessions()` 로 임시 자리에 남은 세션을 **이름으로 하나씩** 지우고 그 목록을 돌려받는다(시험은 0 이어야 한다고 단언한다).
//   kill-server 는 쓰지 않는다. `realTmuxSessionsWithPrefix()` 는 격리가 새지 않았는지 실제 자리를 읽기만 해서 본다(역검증).
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const REAL_DIR = `${(process.env.TMUX_TMPDIR || "/tmp").replace(/\/+$/, "")}/tmux-${process.getuid?.() ?? ""}`;
//  짧은 자리에 둔다 — 유닉스 소켓 경로는 길이 한도(macOS 104바이트)가 있어 macOS 의 os.tmpdir()(/var/folders/…/T/) 밑이면 tmux 가 소켓을 못 만든다.
export const TEST_TMUX_TMPDIR = mkdtempSync(path.join(existsSync("/tmp") ? "/tmp" : os.tmpdir(), "lvtx-"));
delete process.env.TMUX;
delete process.env.TMUX_PANE;
process.env.TMUX_TMPDIR = TEST_TMUX_TMPDIR;
mkdirSync(TEST_TMUX_TMPDIR, { recursive: true });

//  제품과 같은 tmux(terminal/catalog.ts TMUX_BIN) — PATH 의 tmux 만 보면 TMUX_BIN 만 맞는 PC 에서 남은 세션을 못 보고 헛통과한다.
const TMUX_BIN = process.env.TMUX_BIN || (existsSync("/opt/homebrew/bin/tmux") ? "/opt/homebrew/bin/tmux" : "tmux");
const tmux = (args) => execFileSync(TMUX_BIN, args, { env: { ...process.env, TMUX: "" }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
const entries = (dir, want) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((n) => path.join(dir, n)).filter((p) => { try { return want(statSync(p)); } catch { return false; } });
};
const dirs = (dir) => entries(dir, (st) => st.isDirectory());
const sockets = (dir) => entries(dir, (st) => st.isSocket());
const sessionsOn = (sock) => {
  try { return tmux(["-S", sock, "list-sessions", "-F", "#{session_name}"]).split("\n").filter(Boolean); } catch { return []; }
};

/** 임시 자리에 남은 세션을 이름으로 하나씩 지우고 `소켓:세션` 목록을 돌려준다(tmux 가 없으면 빈 목록). */
export function leftTmuxSessions() {
  const left = [];
  for (const d of dirs(TEST_TMUX_TMPDIR)) {
    for (const sock of sockets(d)) {
      for (const name of sessionsOn(sock)) {
        left.push(`${path.basename(sock)}:${name}`);
        try { tmux(["-S", sock, "kill-session", "-t", `=${name}`]); } catch { /* 이미 끝났다 */ }
      }
    }
  }
  return left;
}

/** 실제 tmux 자리(이 PC 의 노드 · 사람 세션)에 그 앞머리의 세션이 있나 — 읽기만 한다(격리가 새면 시험이 그 사실을 알린다). */
export function realTmuxSessionsWithPrefix(prefix) {
  const hits = [];
  for (const sock of sockets(REAL_DIR)) for (const name of sessionsOn(sock)) if (name.startsWith(prefix)) hits.push(`${path.basename(sock)}:${name}`);
  return hits;
}

process.on("exit", () => { try { rmSync(TEST_TMUX_TMPDIR, { recursive: true, force: true }); } catch { /* 지우지 못해도 시험 결과와 무관 */ } });

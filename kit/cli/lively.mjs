#!/usr/bin/env node
// lively CLI — 멤버가 쓰는 단일 명령 표면 (#864)
// ────────────────────────────────────────────────────────────────────────────
// 왜 있나 — 종전엔 웹이 건네는 **복붙 한 줄**이 곧 설치기였다(토큰이 명령줄에 박히고, mac/win 이 서로
//  다른 코드였고, 1,400자 PowerShell 을 아무도 디버깅 못 했다). 그 표면 전부를 이 파일 하나로 모은다.
//
// 이 CLI 만이 할 수 있는 일(자동 업데이트가 구조적으로 못 하는 축):
//   **MCP 클라이언트 재등록(`claude mcp remove` → `add`)**. 이건 원자적이지 않아서 백그라운드 업데이터
//   (kit/hooks/self-update.mjs)가 일부러 뺐다 — 중간에 죽으면 멤버의 lively MCP 등록이 사라진다.
//   포그라운드 CLI 는 사람이 보고 있고 실패를 즉시 알릴 수 있으니 안전하게 할 수 있다.
//   → 관리자가 org MCP 서버를 추가했을 때 Claude 멤버가 손대야 하던 유일한 일이 `lively update` 로 닫힌다.
//
// 설계 원칙
//   · 의존성 0 (Node ≥20 내장 fetch). 하네스가 이미 Node 를 요구하므로(훅이 전부 .mjs) 새 런타임을 안 만든다.
//   · 설치의 **엔진은 여전히 setup/user-install.mjs** — CLI 는 오케스트레이터다(비파괴 머지 로직을 복제하지 않는다).
//     [[delivery-install-invariants]] ① 비파괴 설치는 그 파일이 지키고, 여기선 그 계약을 깨지 않는 것이 임무.
//   · 토큰은 argv 에 싣지 않는다 — `lively login` 은 /dev/tty 가림 입력(셸 히스토리에 안 남음).
//   · 전 경로 한국어 + 실패는 실패라고 말한다(조용한 반쪽 설치 금지).
//
// 환경변수: LIVELY_HOME(HOME 리다이렉트 — 샌드박스/테스트) · LIVELY_TOKEN · LIVELY_GATEWAY_URL
//           CLAUDE_CONFIG_DIR(멀티프로필 #346)

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, chmodSync,
  readdirSync, statSync, realpathSync, openSync, writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { ReadStream, WriteStream } from "node:tty";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";

// ── 0. 상수 · 경로 ──────────────────────────────────────────────────────────
const CLI_VERSION = "1.0.0";
const WIN = process.platform === "win32";
// 셸 env(LIVELY_TOKEN·PATH)를 새로 읽게 하는 방법은 OS 마다 다르다 — 윈도우에 `source ~/.zshrc` 를 안내하면
//  사용자는 실행조차 못 한다(#1087 실측: 윈도우 설치 화면에 그대로 나갔다).
const RELOAD_SHELL_HINT = WIN ? "새 PowerShell 창을 여세요" : "새 터미널을 열거나  source ~/.zshrc";
// 사용자용 CLI 다 — Node 내부 경고(예: DEP0190 shell 옵션)를 설치 화면에 흘리지 않는다.
//  우리 코드는 shell:true 경로에서 winArg 로 직접 이스케이프하므로 그 경고는 우리에게 버그 신호가 아니다.
//  개발자는 LIVELY_DEBUG=1 로 되살릴 수 있다(경고를 영영 못 보게 만들지 않는다).
if (!process.env.LIVELY_DEBUG) process.noDeprecation = true;
const HOME = process.env.LIVELY_HOME || homedir();
const LIVELY = join(HOME, ".lively");
// claude 설정 디렉터리 — CLAUDE_CONFIG_DIR(프로필 격리 #346) > <HOME>/.claude. ★ LIVELY_HOME(샌드박스 격리)이 켜져 있으면
//  CLAUDE_CONFIG_DIR 는 **그 샌드박스 안에 있을 때만** 존중한다 — 밖(개발자 셸·웹터미널 세션이 상속한 실 프로필)이면 무시.
//  실측(2026-08-19): 테스트가 LIVELY_HOME 만 주고 설치기를 돌려, 상속된 CLAUDE_CONFIG_DIR=<실 프로필> 의 settings.json 에
//  곧 지워질 임시 샌드박스 훅 경로가 써졌다 → 모든 세션 훅이 Cannot find module 로 실패. harness-registry.claudeConfigDir 와
//  **같은 계산**이어야 한다(정본은 거기 — 이 파일은 발행물 배치가 달라 정적 import 를 못 해 인라인). 어긋나면 한쪽은 샌드박스에,
//  한쪽은 실 프로필에 쓴다. 윈도우는 대소문자·구분자 무시(문자열 prefix 판정 — 호출부는 절대경로).
function claudeConfigDir(home, env = process.env) {
  const ccd = String(env.CLAUDE_CONFIG_DIR || "").trim();
  if (!ccd) return join(home, ".claude");
  if (!env.LIVELY_HOME) return ccd;
  const norm = (p) => { const s = String(p || "").replace(/[\\/]+/g, "/").replace(/\/+$/, ""); return process.platform === "win32" ? s.toLowerCase() : s; };
  const c = norm(ccd), r = norm(env.LIVELY_HOME);
  return (c === r || c.startsWith(r + "/")) ? ccd : join(home, ".claude");
}
const CLAUDE_DIR = claudeConfigDir(HOME);
const CODEX_CFG = join(HOME, ".codex", "config.toml");
// opencode 는 XDG 규약 — `~/.opencode` 가 아니다. `XDG_CONFIG_HOME || homedir()/.config` + 앱이름이고
//  이 계산은 플랫폼 무관이다(#1519 실측). 설치기·제거기와 같은 계산이어야 진단이 실제 배선을 본다.
const OPENCODE_DIR = join(process.env.LIVELY_HOME ? join(HOME, ".config") : (process.env.XDG_CONFIG_HOME || join(HOME, ".config")), "opencode"); // LIVELY_HOME 격리 우선(설치기와 동일)
const OPENCODE_PLUGIN = join(OPENCODE_DIR, "plugin", "lively.js");
// antigravity(#1689) — `~/.gemini` 고정($HOME 만 봄, env 오버라이드 없음). 배선 신호는 우리 플러그인 디렉터리다
//  (plugin-dir 배선 — 그 안의 hooks.json·mcp_config.json 은 전부 우리 파일이라 '우리 것이 있나' 신호가 강하다).
const AGY_PLUGIN_DIR = join(HOME, ".gemini", "config", "plugins", "lively");
// grok(#1701) — Grok Build(xAI). 홈은 `$GROK_HOME > ~/.grok` 인데, LIVELY_HOME(샌드박스 격리)이 켜져 있으면
//  GROK_HOME 을 **무시**한다 — 개발자 실환경의 GROK_HOME 이 테스트 격리를 뚫으면 실 grok 홈을 오염시킨다
//  (opencode 의 XDG 처리와 같은 원칙 · 레지스트리/설치기와 같은 계산이어야 진단이 실제 배선을 본다).
const GROK_DIR = process.env.LIVELY_HOME ? join(HOME, ".grok") : (process.env.GROK_HOME || join(HOME, ".grok"));
// 배선 신호는 **통째로 우리 소유**인 훅 배선 파일이다(user-install.mjs installGrok 이 심는다).
const GROK_HOOKS_JSON = join(GROK_DIR, "hooks", "lively-grok.json");
// 자동 업데이터(self-update.mjs)와 **같은 필수 훅 목록**을 쓴다 — 손상 번들 판정 기준이 갈리면 안 된다.
//  self-update.mjs 자신은 목록에 없다(구 게이트웨이로 롤백 시 '손상'으로 오판해 영구 고착되는 걸 막기 위함 — #858).
const REQUIRED_HOOKS = ["session-preload.mjs", "work-flag.mjs", "stop-writeback-gate.mjs", "run-custom.mjs", "sync-harness-assets.mjs"];

// ── 1. 출력 ────────────────────────────────────────────────────────────────
const ESC = "\u001b";
const TTY = process.stderr.isTTY;
const c = (code, s) => (TTY ? `${ESC}[${code}m${s}${ESC}[0m` : s);
const bold = (s) => c(1, s), dim = (s) => c(2, s), red = (s) => c(31, s), green = (s) => c(32, s), yellow = (s) => c(33, s);
// 표시 폭(터미널 컬럼 수) — 한글·CJK 는 **2칸**을 차지한다. 코드포인트 개수로 패딩하면 표가 어긋난다(실측).
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;
const cols = (s) => [...String(s)].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);
// 사람 대상 출력은 stderr — stdout 은 --json 기계 판독용으로 비워 둔다(파이프 안전).
const say = (s = "") => process.stderr.write(s + "\n");
// ── 앱↔CLI 이벤트 채널(#1541 T1) ────────────────────────────────────────────
// `--json-events` 일 때만 켜진다. 켜지면 사람용 메시지가 stderr 로 **그대로 나가면서** stdout 에 NDJSON
//  notice 이벤트로도 나간다 — 둘 중 하나만 있으면 GUI 나 터미널 중 한쪽이 벙어리가 된다.
//  EV 는 main() 이 플래그를 보고 채운다(그 전에 죽는 경로 — Node 버전 게이트 등 — 은 종전 그대로 stderr 만).
let EV = null;                       // { emit, start, step, notice, result, end } | null
let PROMPTER = null;                 // { ask, tell } | null
const evNotice = (level, s) => { if (EV) EV.notice(level, stripAnsi(s)); };
// (구현은 아래 §1.6 — 같은 파일 안에 있다. 부트스트랩 단계에서도 반드시 동작해야 하므로 형제 모듈로 빼지 않는다.)
// `--json` 결과 출력 — 이벤트 모드에선 raw JSON 을 stdout 에 섞지 않고 `result` 이벤트로 싣는다.
//  안 그러면 여러 줄 pretty JSON 이 NDJSON 스트림 한복판에 끼어 앱의 줄 단위 파서를 깬다(D5).
const jsonOut = (obj) => { if (EV) EV.result(obj); else process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); };
const ok = (s) => { say("  " + green("✓") + " " + s); evNotice("ok", s); };
const info = (s) => { say("  " + dim("·") + " " + s); evNotice("info", s); };
const warn = (s) => { say("  " + yellow("⚠") + " " + s); evNotice("warn", s); };
const fail = (s) => { say("  " + red("✗") + " " + s); evNotice("error", s); };
// die 는 이벤트 모드에서도 **끝을 알리고** 죽는다 — 앱이 '끝났는지'를 종료코드만으로 추측하지 않게(D3).
const die = (s, code = 1) => {
  say("\n" + red("✗ " + s));
  if (EV) { EV.notice("error", stripAnsi(s)); endEvents(false, code); }
  process.exit(code);
};


// ── 1.6 앱↔CLI 이벤트 계약 (#1541 T1) — `--json-events` 의 NDJSON + 프롬프트 채널 ──────────
// **왜 이 파일 안에 있나**: 부트스트랩은 게이트웨이의 `/cli/lively.mjs` **한 파일만** 내려받아 `lively setup` 을
//  실행한다(맨 위 주석의 그 불변식). 그런데 데스크톱 앱이 이 계약을 가장 필요로 하는 순간이 정확히 그 단계다 —
//  형제 모듈로 빼서 dynamic import 하면 **설치 이전 명령이 통째로 깨진다**(실측: ERR_MODULE_NOT_FOUND
//  json-events.mjs → 앱의 설치 마법사가 첫 단계에서 멈춤). 그래서 여기 둔다.
// 테스트는 이 파일에서 직접 import 한다(kit/cli/json-events.test.mjs) — 아래 함수들이 export 인 이유.
//
// stdout = NDJSON 이벤트 · stderr = 사람용 · stdin = 답 한 줄. 자세한 계약은 위키 app-cli-json-events-contract-1541.
// ⚠ **비밀은 이벤트에 싣지 않는다.** 토큰이 stdout 으로 나가면 앱 로그·크래시 리포트로 샌다.

export const EVENT_V = 1;

/**
 * 이벤트 문구에서 ANSI 색·스타일 시퀀스를 제거한다.
 *
 * GUI 는 색 코드를 렌더할 수 없고, 로그에 남으면 읽기만 나빠진다. **ESC 바이트까지 함께** 지우는 게 요점이다 —
 * `\x1b` 를 빼고 `[0m` 만 지우면 보이지 않는 ESC 가 문구에 남아 앱 쪽 표시가 깨진다(그리고 눈으로는 안 보인다).
 * CSI 계열(`ESC [ … 종결문자`)을 통째로 지운다 — 색(m) 말고도 커서 이동 등이 섞여 들어올 수 있다.
 */
export const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

/**
 * 이벤트 1건 → NDJSON **한 줄**(끝에 개행 1개). 순수 함수.
 *
 * 봉투(v·t·ts)는 payload 가 **덮어쓸 수 없다** — 페이로드가 봉투를 위조하면 앱의 버전 협상·정렬이 무너진다.
 * 직렬화가 실패해도(순환참조 등) **throw 하지 않는다**: 진행 보고가 명령을 죽이면 안 된다. 대신 그 사실을
 * 담은 이벤트를 낸다(조용한 유실보다 낫다 — 앱이 '뭔가 못 실었다'를 알 수 있어야 한다).
 */
export function encodeEvent(t, payload, ts) {
  const env = { v: EVENT_V, t: String(t), ts: Number(ts) };
  try {
    return JSON.stringify({ ...(payload && typeof payload === "object" ? payload : {}), ...env }) + "\n";
  } catch (e) {
    return JSON.stringify({ ...env, t: "notice", level: "warn", message: `이벤트 직렬화 실패(${t}): ${e?.message || e}` }) + "\n";
  }
}

/**
 * stdin 한 줄 → 답 `{id, value}` 또는 `null`(무시). 순수 함수.
 *
 * ⚠ `value` 가 없으면 **null 이다**(빈 답을 '기본값 승인'으로 만들지 않는다). 앱이 실수로 빈 객체를 보내는 것과
 *  사람이 실제로 '아니오'를 고른 것은 완전히 다른 사건이고, 전자를 후자로 오독하면 신원확인이 조용히 통과한다.
 */
export function parseAnswer(line) {
  let m;
  try { m = JSON.parse(String(line)); } catch { return null; }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  if (m.t !== "answer") return null;
  if (typeof m.id !== "string" || !m.id) return null;
  if (!("value" in m)) return null;
  return { id: m.id, value: m.value };
}

/** 이벤트 발행기 — `write(line)` 와 시계만 주입받는다(테스트가 프로세스 없이 전량 관측). */
export function createEmitter({ write, now = () => Date.now() } = {}) {
  const emit = (t, payload) => { write(encodeEvent(t, payload, now())); };
  return {
    emit,
    start: (cmd, cli) => emit("start", { cmd, cli }),
    /** status: start|done|fail. i/n 은 진행률(1-based / 총계) — 없으면 생략된다. */
    step: (id, label, status, extra) => emit("step", { id, label, status, ...(extra || {}) }),
    notice: (level, message) => emit("notice", { level, message }),
    result: (data) => emit("result", { data }),
    end: (ok, code) => emit("end", { ok: !!ok, code: Number(code) || 0 }),
  };
}

/**
 * 프롬프트 채널 — `prompt` 이벤트를 내고 stdin 의 답을 기다린다.
 *
 * `onLine(cb)` 로 줄 공급원을, `onEnd(cb)` 로 입력 종료를 주입받는다(테스트가 stdin 없이 구동).
 *
 * ⚠ **EOF 는 기본값 승인이 아니라 실패다**(C4). 답 없이 입력이 닫혔다는 건 앱이 죽었거나 계약을 안 지킨 것이고,
 *  그때 `def` 로 진행하면 "이 계정으로 로그인됩니다" 같은 **신원확인이 사람 없이 통과**한다(#R2-F1 이 막으려던 바로 그것).
 *  fail-closed 가 맞다.
 */
export function createPrompter({ emit, onLine, onEnd }) {
  const waiting = new Map();      // id → resolve/reject
  let ended = false;
  onLine((line) => {
    const a = parseAnswer(line);
    if (!a) return;                                   // 잡음·다른 메시지는 조용히 무시(C2·C3)
    const w = waiting.get(a.id);
    if (!w) return;                                   // 내가 안 기다리는 id — 무시
    waiting.delete(a.id);
    w.resolve(a.value);
  });
  if (typeof onEnd === "function") {
    onEnd(() => {
      ended = true;
      for (const [, w] of waiting) w.reject(new Error("앱과의 연결이 끊겼습니다(답을 받지 못했습니다)."));
      waiting.clear();
    });
  }
  /** kind·payload 로 물어보고 답을 기다린다. id 는 호출자가 준다(짝을 앱이 맞출 수 있게). */
  return {
    ask(id, kind, payload) {
      if (ended) return Promise.reject(new Error("앱과의 연결이 끊겼습니다(답을 받지 못했습니다)."));
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        emit("prompt", { id, kind, ...(payload || {}) });
      });
    },
    /** 답을 기다리지 않는 통지용 프롬프트(예: device-code — 사람은 브라우저에서 승인한다). */
    tell(id, kind, payload) { emit("prompt", { id, kind, ...(payload || {}) }); },
    get pending() { return waiting.size; },
  };
}

/** 스트림 → 줄 단위 공급원. 청크 경계에서 답이 잘리지 않게 버퍼링한다(C6). */
export function lineReader(stream) {
  let buf = "";
  const lineCbs = [], endCbs = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      for (const cb of lineCbs) cb(line);
    }
  });
  stream.on("end", () => { if (buf.trim()) for (const cb of lineCbs) cb(buf); buf = ""; for (const cb of endCbs) cb(); });
  stream.on("error", () => { for (const cb of endCbs) cb(); });
  return { onLine: (cb) => lineCbs.push(cb), onEnd: (cb) => endCbs.push(cb) };
}

// ── 1.5 Node 버전 게이트 (#1068) ────────────────────────────────────────────
// 이 CLI 는 의존성 0 으로 **전역 fetch(Node 18+)** 등 최신 런타임 API 를 쓴다(맨 위 설계 원칙).
//  구버전에서 돌면 증상이 `fetch is not defined` 로 `[1/3] 키트 내려받는 중…` 한복판에 터진다 —
//  Node 얘기가 한 글자도 안 나와서 사람이 원인을 못 찾는다(실측: 시스템 node v16.20.2).
//  그래서 **첫 줄에서, 무엇을 하면 되는지와 함께** 죽는다.
//  정상 경로면 부트스트랩이 전용 런타임(~/.lively/runtime)을 깔아 여기 걸릴 일이 없다 — 걸렸다는 건
//  그 런타임이 없어 심(~/.lively/bin/lively)이 시스템 node 로 폴백했다는 뜻이고, 그래서 재설치가 곧 해결이다.
const NODE_MIN_MAJOR = 20;   // package.json engines(">=20") · bootstrap.sh/ps1 의 NODE_MIN_MAJOR 와 같은 계약.
if (Number(process.versions.node.split(".")[0]) < NODE_MIN_MAJOR) {
  let gw = "<게이트웨이>";
  try { gw = readFileSync(join(LIVELY, "gateway-url"), "utf8").trim() || gw; } catch { /* 아직 없으면 자리표시자 */ }
  say("");
  fail(`Node ${process.versions.node} 에서 실행됐습니다 — 라이블리 CLI 는 Node ${NODE_MIN_MAJOR} 이상이 필요합니다.`);
  info("라이블리 전용 런타임이 없어 시스템 node 로 폴백한 상태입니다.");
  info("아래를 다시 실행하면 전용 런타임을 깔고 이어갑니다(시스템 node 는 그대로 둡니다).");
  say("");
  say(WIN ? `      irm ${gw}/cli.ps1 | iex` : `      curl -fsSL ${gw}/cli | sh`);
  say("");
  process.exit(1);
}

// ── 2. 자식 프로세스 ────────────────────────────────────────────────────────
// Windows 의 claude/codex 는 .cmd/.ps1 셰임이라 shell 없이 spawn 하면 ENOENT(work.mjs:259 와 같은 이유).
//  ⚠ 그런데 Node 는 shell:true 일 때 인자를 **자동 quote 하지 않는다** — 공백이 든 인자
//  (`Authorization: Bearer lvk_…`)가 cmd.exe 에서 두 토막 난다. 그래서 여기서 직접 quote 한다.
//  규칙(CommandLineToArgvW): 백슬래시는 `"` 앞에서만 특별하다 → 내부 " 앞 백슬래시 배증 + 이스케이프,
//  그리고 **인용할 때만** 말미 백슬래시 배증(인용 안 하는 `C:\path\` 는 원형이 맞다 — 과잉 인용이 오히려 깨뜨린다).
//  한계: cmd.exe 의 `%VAR%` 확장은 큰따옴표로도 못 막는다. 우리가 넘기는 값(게이트웨이 URL·lvk_ 토큰·
//  관리자가 넣은 서버명/URL)엔 `%VAR%` 패턴이 없으므로 실질 위험은 없다 — 생기면 여기부터 의심할 것.
//  POSIX CI 에선 이 함수가 한 번도 실행되지 않으므로(WIN=false) lively.test.mjs 가 순수함수로 직접 검증한다.
const winArg = (s) => {
  const v = String(s);
  if (v && !/[\s"^&|<>()%!]/.test(v)) return v;
  return '"' + v.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1") + '"';
};
// timeout(ms) 를 주면 spawnSync 가 그 시간 뒤 killSignal(SIGKILL)로 자식을 죽인다 — 외부 CLI(claude 등)가
//  네트워크에 매달려 `lively status` 를 무한정 hang 시키지 않게 하는 하드 백스톱(#1043). 미지정이면 종전대로 무제한.
// Windows 셸 경유 스폰용 인자 조립 — **명령 자체도 인용한다.**
//  ⚠ Node 는 shell:true 일 때 `[cmd, ...args]` 를 공백으로 이어 `cmd.exe /d /s /c "…"` 에 넘길 뿐,
//   **어느 쪽도 quote 하지 않는다.** 종전 코드는 args 에만 winArg 를 걸어서, 명령 경로에 공백이 있으면
//   그 자리에서 두 토막 났다(실측 #1087):
//     ✗ 'C:\Program'은(는) 내부 또는 외부 명령… ← C:\Program Files\nodejs\node.exe
//   이 버그는 **오래 잠복해 있었다** — 종전엔 부트스트랩이 늘 번들 런타임(~/.lively/runtime/… · 공백 없음)을
//   깔아 그걸 썼기 때문이다. Node 버전 판정을 고쳐 **시스템 node 를 제대로 채택**하자마자 드러났다.
//  캡슐화한 이유: 호출부마다 "cmd 도 winArg 해야 한다"를 기억해야 하면 다음 사람이 또 빠뜨린다.
const winSpawnArgs = (cmd, args) => [winArg(cmd), args.map(winArg)];

// dropEnv: 상속 env 에서 **키를 지운다**(빈 문자열로 덮지 않는다). 빈 문자열은 '설정됨' 으로 읽히는 도구가 많아
//  (실측 #1541: electron-builder 가 빈 CSC_LINK 를 인증서 경로로 보고 죽었다) 지우는 것과 결과가 다르다.
//  여기 쓰임: claude 를 **기본 위치**($HOME/.claude.json)로 돌리려면 CLAUDE_CONFIG_DIR 가 없어야 한다.
function run(cmd, args, { allowFail = false, quiet = false, env, dropEnv, timeout } = {}) {
  const merged = { ...process.env, ...(env || {}) };
  for (const k of dropEnv || []) delete merged[k];
  const [c, a] = WIN ? winSpawnArgs(cmd, args) : [cmd, args];
  const r = spawnSync(c, a, {
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    env: merged,
    encoding: "utf8",
    shell: WIN,
    ...(timeout ? { timeout, killSignal: "SIGKILL" } : {}),
  });
  if (r.error && !allowFail) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} 실행 실패 (exit ${r.status})${r.stderr ? ": " + String(r.stderr).trim().split("\n")[0] : ""}`);
  }
  return { code: r.status ?? -1, out: String(r.stdout || ""), err: String(r.stderr || "") };
}
const has = (bin) => spawnSync(WIN ? "where" : "command", WIN ? [bin] : ["-v", bin], { stdio: "ignore", shell: !WIN }).status === 0;
// claude CLI 호출 — **자식 HOME 을 모듈 HOME(=LIVELY_HOME or os.homedir())으로 명시 주입한다.**
//  ⚠ 이걸 빠뜨리면 샌드박스(LIVELY_HOME)로 돌린 login·install 이 **실사용자 ~/.claude.json** 을 고친다.
//   등록하는 command 값은 LIVELY_HOME 기반인데 기록되는 파일만 실 HOME 이라 둘이 어긋나고, 남는 건
//   **곧 삭제될 임시 경로를 가리키는 lively MCP 항목**이다 → 그 뒤 모든 세션에서 ENOENT 로 lively 툴이
//   통째로 안 뜬다(#1593 실측: `/var/folders/…/lively-ev-test-*/login-home/.lively/bin/lively`).
//   증상이 "MCP 가 안 붙는다"뿐이라 게이트웨이 장애로 오진하기까지 한다.
//  역연산인 uninstall 쪽(adapters/claude/uninstall.mjs · setup/user-uninstall.mjs)은 이미 같은 주입을 한다 —
//   여기까지 해야 add/remove 가 대칭이 되고, 샌드박스가 라이브에 손대는 경로가 닫힌다.
//  ⚠ USERPROFILE 도 같이 세운다 — 윈도우의 os.homedir() 는 HOME 이 아니라 USERPROFILE 을 본다
//   (testlib/os-sandbox.mjs 가 못박은 교훈: HOME 만 대입하면 윈도우에서 조용히 샌다).
//  캡슐화한 이유는 winSpawnArgs 와 같다 — 호출부마다 "HOME 도 넘겨야 한다"를 기억해야 하면 다음 사람이 또 빠뜨린다.
const runClaude = (args, opts = {}) => run("claude", args, { ...opts, env: { HOME, USERPROFILE: HOME, ...(opts.env || {}) } });
// 특정 config dir 을 겨냥해 claude 를 부른다. `configDir === null` = **기본 위치**($HOME/.claude.json) —
//  그때는 상속된 CLAUDE_CONFIG_DIR 를 **지운다**(안 지우면 세션 안에서 돌릴 때 기본 위치엔 영원히 안 박힌다).
const runClaudeIn = (configDir, args, opts = {}) => runClaude(args, {
  ...opts,
  env: configDir ? { CLAUDE_CONFIG_DIR: configDir, ...(opts.env || {}) } : (opts.env || {}),
  dropEnv: configDir ? (opts.dropEnv || []) : ["CLAUDE_CONFIG_DIR", ...(opts.dropEnv || [])],
});
// 윈도우 tar.exe 는 System32 동봉이다 — 훅·자식 프로세스의 빈약한 PATH 에서도 찾도록 절대경로를 먼저 본다(#1510).
const tarBin = () => {
  if (!WIN) return "tar";
  const abs = join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "tar.exe");
  return existsSync(abs) ? abs : "tar";
};

// ── 3. 대화형 입력 — `curl … | sh` 로 stdin 이 파이프여도 사람 입력을 받는다 ──────────────────
//  POSIX 의 /dev/tty 는 프로세스의 **제어 단말**이라 stdin 파이프와 독립이다. 이게 없으면
//  `curl … | sh` 가 부트스트랩한 뒤 토큰을 물어볼 방법이 없다(설치가 2단계로 갈라진다).
function ttyIO() {
  if (!WIN) {
    try {
      // 읽기·쓰기 fd 를 따로 연다 — 한 fd 를 두 스트림이 공유하면 teardown 때 이중 close(재사용된 남의 fd 를 닫는 사고) 위험.
      const rfd = openSync("/dev/tty", "r+");
      const wfd = openSync("/dev/tty", "r+");
      const rs = new ReadStream(rfd), ws = new WriteStream(wfd);
      // ⚠ resume() 로 연 tty 스트림을 fd 만 closeSync 하면 poll 핸들이 남아, 셸이 제어를 되찾을 때
      //  엔터를 한 번 더 눌러야 프롬프트가 뜬다. 반드시 stream.destroy() 로 정리한다(각 스트림이 자기 fd 를 닫음).
      return { in: rs, out: ws, close: () => { try { rs.destroy(); } catch { /* */ } try { ws.destroy(); } catch { /* */ } } };
    } catch { /* 단말 없음(CI·데몬) → 아래 폴백 */ }
  }
  return { in: process.stdin, out: process.stderr, close: () => { /* 소유 아님 — 닫지 않는다 */ } };
}
// ⚠ 이벤트 모드에선 **TTY 가 없어도 대화형이다** — 앱이 곧 단말이다(prompt 이벤트 ↔ stdin 답).
//  이 한 줄이 없으면 GUI 로그인이 "비대화형 환경입니다"로 죽어 T3 이 성립하지 않는다.
const interactive = () => { if (PROMPTER) return true; const t = ttyIO(); const y = !!t.in.isTTY; t.close(); return y; };

// 가림 입력(에코 없음) — 토큰이 화면·스크롤백·화면녹화·셸 히스토리 어디에도 안 남는다. 비대화형이면 null.
const CTRL_C = "\u0003", CTRL_D = "\u0004", BACKSPACE = "\u007f";
function askHidden(label) {
  // 이벤트 모드: 가림 입력도 앱이 받는다(비밀은 **이벤트로 나가지 않고 stdin 으로 들어온다** — 방향이 반대라 안전).
  if (PROMPTER) return PROMPTER.ask("secret", "secret", { label: stripAnsi(label) });
  const t = ttyIO();
  if (!t.in.isTTY) { t.close(); return Promise.resolve(null); }
  return new Promise((resolve) => {
    t.out.write(label);
    let buf = "";
    const finish = (val) => {
      try { t.in.setRawMode(false); } catch { /* */ }
      t.in.pause(); t.in.off("data", onData); t.out.write("\n"); t.close(); resolve(val);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return finish(buf);
        if (ch === CTRL_C) { finish(null); process.exit(130); return; }
        if (ch === CTRL_D) return finish(buf || null);
        if (ch === BACKSPACE || ch === "\b") { buf = buf.slice(0, -1); continue; }
        if (ch < " ") continue;   // 그 외 제어문자(방향키 등) 무시
        buf += ch;
      }
    };
    t.in.setEncoding("utf8");
    try { t.in.setRawMode(true); } catch { /* */ }
    t.in.resume();
    t.in.on("data", onData);
  });
}

// 예/아니오 — 비대화형이면 기본값을 그대로 쓴다(프롬프트가 자동화를 막지 않게).
let promptSeq = 0;
function askYesNo(label, def = true) {
  // 이벤트 모드: GUI 가 물어본다. **답이 안 오고 stdin 이 닫히면 실패한다** — 기본값으로 조용히 승인하면
  //  "이 계정으로 로그인됩니다" 확인이 사람 없이 통과한다(#R2-F1 이 막으려던 바로 그것). fail-closed.
  if (PROMPTER) return PROMPTER.ask(`confirm-${++promptSeq}`, "confirm", { label: stripAnsi(label), default: !!def });
  const t = ttyIO();
  if (!t.in.isTTY) { t.close(); return Promise.resolve(def); }
  return new Promise((resolve) => {
    t.out.write(label + (def ? " [Y/n] " : " [y/N] "));
    t.in.setEncoding("utf8");
    t.in.resume();
    t.in.once("data", (d) => {
      t.in.pause(); t.close();
      const s = String(d).trim().toLowerCase();
      resolve(s === "" ? def : /^y/.test(s));
    });
  });
}

// ── 4. 자격(토큰 · 게이트웨이) ──────────────────────────────────────────────
const readLively = (name) => { try { return readFileSync(join(LIVELY, name), "utf8").trim(); } catch { return ""; } };
// mode 는 **생성과 동시에** 준다 — write 후 chmod 하면 그 사이 umask 기본 권한으로 토큰이 잠깐 노출된다(TOCTOU).
//  기존 파일을 덮어쓸 땐 writeFileSync 의 mode 가 무시되므로 chmod 로 한 번 더 못박는다.
function writeLively(name, val, mode = 0o600) {
  mkdirSync(LIVELY, { recursive: true, mode: 0o700 });
  const p = join(LIVELY, name);
  writeFileSync(p, val, { mode });
  try { chmodSync(p, mode); } catch { /* Windows 는 무의미 */ }
}
// gateway-url 은 항상 **/mcp 없이** 저장한다(user-install.mjs 와 같은 계약).
const normGw = (u) => String(u || "").trim().replace(/\/+$/, "").replace(/\/mcp$/, "").replace(/\/+$/, "");
const gateway = () => normGw(process.env.LIVELY_GATEWAY_URL || readLively("gateway-url"));
// ⚠ **파일이 정본이고 LIVELY_TOKEN env 는 그 캐시다**(#916 — 순서를 뒤집지 말 것).
//  설치기가 codex 때문에(config.toml 은 토큰 리터럴을 거부하고 bearer_token_env_var 만 받는다) 셸 rc 에
//  `export LIVELY_TOKEN="$(cat ~/.lively/token)"` 를 심는다 → env 는 '셸 시작 시각의 파일 스냅샷'이지
//  의도적 override 가 아니다. env 를 우선하면 `lively login` 직후 **같은 셸**에서 옛 토큰이 살아남아
//  install 이 옛 신원을 .claude.json 에 굽는다(전 단계가 ✓ 로 보이면서 — 실측 재현됨).
//  새 셸에선 env==파일이라 이 순서는 무관하고, 파일이 없을 때만(CI·프로비저닝 컨테이너) env 로 폴백한다.
const token = () => (readLively("token") || process.env.LIVELY_TOKEN || "").trim();
// 이 프로세스가 **뜰 때** 셸이 준 토큰. 신원 판단엔 절대 쓰지 않는다(그건 token() 담당) — 오직
//  "당신 셸의 env 는 이제 스테일이고 우리는 그걸 못 고친다"를 login·logout·doctor 가 알릴 때만 쓴다.
const ENV_TOKEN_AT_START = (process.env.LIVELY_TOKEN || "").trim();

async function api(path, { timeoutMs = 15000, method = "GET", body } = {}) {
  const gw = gateway(), tok = token();
  if (!gw) throw new Error("게이트웨이 주소를 모릅니다 — `lively login --gateway <url>` 로 지정하세요.");
  if (!tok) throw new Error("로그인이 필요합니다 — `lively login` 을 먼저 실행하세요.");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { authorization: `Bearer ${tok}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    // ⚠ undici 는 진짜 원인을 `e.cause` 에 숨긴다 — 그대로 두면 사용자에게 보이는 건 'fetch failed' 뿐이고
    //  DNS·프록시·TLS·방화벽을 구별할 수 없다. #1505 윈도우 실측이 정확히 그 벽이었다: `Claude MCP 연결 ✓`(붙는다)
    //  인데 `게이트웨이 도달 ✗ fetch failed`(CLI 만 못 붙는다) — 원인 코드가 없어 진단이 거기서 멈췄다.
    let res;
    try {
      res = await fetch(gw + path, { method, signal: ctl.signal, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (e) {
      if (e?.name === "AbortError" || e?.name === "TimeoutError") throw new Error(`게이트웨이 응답 없음 — ${timeoutMs}ms 초과 (${path})`);
      const code = e?.cause?.code || e?.code || "";
      const hint = code === "ENOTFOUND" ? " — 주소·DNS 확인"
        : /^(ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH)$/.test(code) ? " — 네트워크·VPN·사내 프록시 확인(⚠ Node 는 HTTPS_PROXY 를 자동으로 쓰지 않는다 — 브라우저·다른 앱이 되는데 CLI 만 안 되면 대개 이것)"
          : /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(code) ? " — TLS 인증서 확인(사내 프록시가 가로채는 환경?)" : "";
      throw new Error(`${e.message}${code ? ` (${code})` : ""}${hint}`);
    }
    if (res.status === 401 || res.status === 403) throw new Error("접속 열쇠가 유효하지 않습니다(만료·해제됨?) — `lively login` 으로 다시 등록하세요.");
    if (!res.ok) { let m = ""; try { m = (await res.json())?.error || ""; } catch { /* */ } throw new Error(`게이트웨이 오류 ${res.status}${m ? " — " + m : ""} (${path})`); }
    return await res.json();
  } finally { clearTimeout(timer); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 서브커맨드 모듈(cmd-*.mjs) 주입 컨텍스트 (#1313 R52) ────────────────────
//  큰 서브커맨드(node·delegate·session)는 파일을 나눠 '한 명령 = 한 파일' 로 만든다. 호출 규약은
//  repo-worktree-core.mjs·project-init-core.mjs 와 같은 레일 — **dynamic import + ctx 주입**.
//  ⚠ **static import 를 쓰지 않는 이유**: 부트스트랩(`curl … | sh`)은 무인증 `/cli/lively.mjs` **한 파일만**
//   내려받아 `lively setup` 을 실행한다(kit/cli/bootstrap.sh). 형제 모듈은 그 뒤 `lively install` 이 번들에서
//   ~/.lively/lib 로 앉힌다 → 설치 이전에 닿는 명령(setup·login·install·status·doctor)은 이 파일에 남아야 하고,
//   설치 이후 표면만 뗄 수 있다. 최상위 static import 는 그 첫 실행을 ERR_MODULE_NOT_FOUND 로 죽인다.
const cliCtx = () => ({
  say, ok, info, warn, fail, die, bold, dim, red, green, yellow,
  run, has, api, sleep, gateway, token, readLively, writeLively,
});

// ── 위탁(delegate, #869 §11) — 세션이 무거운 1회성 작업을 워커/중앙에 위탁하는 클라이언트 프로세스. ──
//  본체·사연은 cmd-delegate.mjs (여긴 위임만) — lively-mcp-local·repo 와 같은 레일.
async function cmdDelegate(rest) {
  const { delegateCommands } = await import(new URL("./cmd-delegate.mjs", import.meta.url));
  return delegateCommands(cliCtx()).cmdDelegate(rest);
}

// ── 노드(#869) — 이 PC 를 라이블리 노드로 연결(로컬 터미널 원격 관리 + 위탁 워커). ──
//  `lively node` / `--daemon`(상시화) / `node stop`(데몬 해제). 본체·사연은 cmd-node.mjs (여긴 위임만).
async function cmdNode(rest) {
  const { nodeCommands } = await import(new URL("./cmd-node.mjs", import.meta.url));
  return nodeCommands(cliCtx()).cmdNode(rest);
}

// ── 5. 하네스 감지 ──────────────────────────────────────────────────────────
//  PATH 우선, 없으면 **디스크 배선**으로 판정한다. 왜 둘 다 보나 — 갓 부트스트랩한 셸이나 detached 자식은
//  PATH 가 빈약해 `command -v claude` 를 못 믿는다(#858 에서 실측한 함정). 배선이 있으면 설치된 것으로 본다.
function detectHarnesses() {
  const out = new Set();
  if (has("claude")) out.add("claude");
  if (has("codex")) out.add("codex");
  try {
    const s = readFileSync(join(CLAUDE_DIR, "settings.json"), "utf8");
    if (s.includes(".lively/hooks/") || s.includes(".lively\\hooks\\")) out.add("claude");
  } catch { /* */ }
  try { if (readFileSync(CODEX_CFG, "utf8").includes("lively-managed")) out.add("codex"); } catch { /* */ }
  // opencode: 배선의 신호는 **어댑터 파일**이다(설정 파일은 opencode 가 빈 것도 만들어서 신호가 약하다).
  if (has("opencode")) out.add("opencode");
  try { if (existsSync(OPENCODE_PLUGIN)) out.add("opencode"); } catch { /* */ }
  // antigravity: 바이너리는 agy 다(#1689 — 하네스 id 로 command -v 하면 영영 미감지). 배선 신호는 플러그인 디렉터리.
  if (has("agy")) out.add("antigravity");
  try { if (existsSync(AGY_PLUGIN_DIR)) out.add("antigravity"); } catch { /* */ }
  // grok: 바이너리 이름이 그대로 grok 이다(#1701). 배선 신호는 우리 소유 훅 파일(lively-grok.json).
  if (has("grok")) out.add("grok");
  try { if (existsSync(GROK_HOOKS_JSON)) out.add("grok"); } catch { /* */ }
  return [...out];
}

// 다운받은 **번들의 레지스트리**로 하네스 목록을 재계산해 보탠다(#1689 실측 UX 갭).
//  왜: update 의 배선 대상 목록은 "지금 실행 중인 CLI" 의 detectHarnesses() 가 계산하는데, 그 CLI 가 새 하네스를
//  모르는 구버전이면(새 하네스 지원이 이번 번들에서 처음 들어온 경우가 정확히 그렇다) 새 키트를 깔면서도 그
//  하네스 배선만 조용히 빠진다 → 멤버가 update 를 **두 번** 돌려야 했다. 번들 레지스트리는 항상 최신이므로
//  그 기준으로 "PATH 에 바이너리가 있는데 목록에 없는 하네스"를 추가한다. 실패는 전부 무해(구 번들엔
//  레지스트리가 없다 — 종전 목록 그대로).
export async function augmentHarnessesFromBundle(root, harnesses) {
  try {
    const reg = await import(pathToFileURL(join(root, ".claude", "hooks", "harness-registry.mjs")).href); // ⚠ pathToFileURL — 윈도우 드라이브문자
    const added = [];
    for (const id of reg.HARNESS_IDS || []) {
      const bin = reg.HARNESS?.[id]?.bin;
      if (typeof bin === "string" && bin && !harnesses.includes(id) && has(bin)) { harnesses.push(id); added.push(id); }
    }
    return added;
  } catch { return []; } // 레지스트리 없음(구 번들)·import 실패 — 종전 목록 유지
}

// ── 6. 번들 — 다운로드 · 검증 ───────────────────────────────────────────────
async function downloadBundle() {
  const gw = gateway(), tok = token();
  const dir = mkdtempSync(join(tmpdir(), "lively-cli-"));
  const tgz = join(dir, "kit.tgz");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  let buf;
  try {
    const res = await fetch(gw + "/install", { signal: ctl.signal, headers: { authorization: `Bearer ${tok}` } });
    if (res.status === 401 || res.status === 403) throw new Error("토큰이 유효하지 않습니다 — `lively login` 으로 다시 등록하세요.");
    if (!res.ok) throw new Error(`키트 다운로드 실패 (HTTP ${res.status})`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    if (e?.name === "AbortError") throw new Error("키트 다운로드 타임아웃 — 네트워크를 확인하세요.");
    throw e;
  } finally { clearTimeout(timer); }
  // 프록시가 로그인 페이지·에러 HTML 을 200 으로 돌려주는 사고를 여기서 잡는다(tar 가 쓰레기를 풀지 않게).
  if (buf.length < 1024) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`키트가 비정상적으로 작습니다(${buf.length}B) — 게이트웨이 주소를 확인하세요.`);
  }
  writeFileSync(tgz, buf);
  const root = join(dir, "kit");
  mkdirSync(root, { recursive: true });
  // tar 는 PATH 이름으로만 부르지 않는다 — 윈도우의 tar.exe 는 System32 에 있고 그게 PATH 에 없는 컨텍스트가
  //  실제로 관측됐다(#1510, self-update 와 같은 처리). 절대경로가 있으면 그걸, 없으면 종전대로.
  run(tarBin(), ["-xzf", tgz, "-C", root], { quiet: true });
  return { dir, root };
}

// 손상 번들로 ~/.lively/hooks 를 덮으면 그 멤버의 **모든 세션에서 훅이 죽는다** → 여기가 마지막 방어선.
//  self-update.mjs 의 verifyBundle 과 같은 판정(필수 러너 존재 + 비어있지 않음 + node --check 구문검사).
function verifyBundle(root) {
  const installer = join(root, "setup", "user-install.mjs");
  if (!existsSync(installer)) throw new Error("번들 손상 — setup/user-install.mjs 없음");
  const hooksDir = join(root, ".claude", "hooks");
  for (const h of REQUIRED_HOOKS) {
    const p = join(hooksDir, h);
    if (!existsSync(p)) throw new Error(`번들 손상 — 훅 누락: ${h}`);
    if (statSync(p).size < 64) throw new Error(`번들 손상 — 훅이 비었음: ${h}`);
  }
  const files = [installer];
  try { for (const f of readdirSync(hooksDir)) if (f.endsWith(".mjs")) files.push(join(hooksDir, f)); } catch { /* */ }
  const cli = join(root, "cli", "lively.mjs");
  if (existsSync(cli)) files.push(cli);   // CLI 가 자기 후임을 검증한다(자기 발등 찍기 방지)
  for (const f of files) {
    if (spawnSync(process.execPath, ["--check", f], { stdio: "ignore" }).status !== 0) {
      throw new Error(`번들 손상 — 구문 오류: ${f.slice(root.length)}`);
    }
  }
  try { return readFileSync(join(root, ".lively", "kit-version"), "utf8").trim(); } catch { return ""; }
}

// ── 7. MCP 등록 — 이 CLI 의 존재 이유 ───────────────────────────────────────
//  kit/setup/register-clients.sh 와 **동일한 claude 호출**을 Node 로 재현한다(bash·PowerShell 분기 제거 →
//  mac/linux/windows 가 같은 코드). 옛 셸 설치기(setup-mac.sh 등)는 #1068 에서 제거했다 —
//  남은 셸 경로는 박스용 deploy/install-kit.sh 뿐이고 그건 user-install.mjs 를 직접 부른다.
//  Codex 는 MCP 를 config.toml 에 쓰므로(user-install.mjs 가 담당) 여기서 할 일이 없다.
function readMcpServers() {
  try {
    const d = JSON.parse(readFileSync(join(LIVELY, "mcp-servers.json"), "utf8"));
    return Array.isArray(d.servers) ? d.servers : [];
  } catch { return []; }
}

// 비파괴 라운드트립 — 유저가 라이블리 이전부터 쓰던 org-겹침 MCP(linear/notion 등)를 **덮어쓰기 전에** 스냅샷한다.
//  uninstall(deregisterExtraMcp)이 이걸 읽어 원복 → 유저 원본이 살아난다. 안 하면 설치가 덮어쓰고 제거가 지워 영구 소실(#744 갭).
// claude 가 `--scope user` MCP 를 쓰는 파일 — **CLAUDE_CONFIG_DIR 가 있으면 그 밑**, 없으면 $HOME/.claude.json.
//  self-update.mjs 의 claudeUserConfigPath 와 **같은 판정**이어야 한다(둘이 갈리면 백업/복원이 어긋난다).
//  ⚠ 예전엔 $HOME 고정이었다("claude 는 $HOME/.claude.json 에 쓴다"는 주석까지 달고). 사실이 아니다 —
//   프로필 격리(#346)에선 claude 가 CLAUDE_CONFIG_DIR 쪽을 쓴다(deploy/provision-profile.sh:37 이 명시).
//   그래서 backupUserMcp 가 **유저 원본을 못 보고 null 로 굳어**, uninstall 이 "설치 전 없었음"으로 판단해
//   유저의 linear/notion 을 자격증명째 지웠다 — 백업이 막으려던 #744 갭 그 자체.
//  ⚠ #1079 와 같은 이유로 **존재하는 것 전부**를 돌려주는 판(claudeUserConfigPaths)이 따로 있다 — 훅과 클로드 코드가
//   서로 다른 파일을 볼 수 있어(프로필 격리 #346) 하나만 보면 "등록했는데 미등록으로 보이는" 상태가 된다.
//   단수판(claudeUserConfigPath)은 종전과 같이 **첫 후보**를 돌려준다 — 백업 스냅샷은 대상이 하나여야 한다(#744).
function claudeUserConfigPaths() {
  const cands = [];
  if (process.env.CLAUDE_CONFIG_DIR) cands.push(join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"));
  cands.push(join(HOME, ".claude.json"));
  const out = [];
  for (const c of cands) { try { if (existsSync(c) && !out.includes(c)) out.push(c); } catch { /* */ } }
  return out;
}
function claudeUserConfigPath() { return claudeUserConfigPaths()[0] ?? null; }

/**
 * MCP 를 등록해야 하는 claude config dir **전부** — 순수(테스트가 이 표를 지킨다).
 * `configDir === null` = claude 기본 위치($HOME/.claude.json).
 *
 * ★ 왜 여러 곳인가(2026-08-14 실기기 실측). 웹터미널 세션은 `CLAUDE_CONFIG_DIR=<프로필>` 을 **항상** 주입하고
 *  (src/terminal/sessions.ts — 멀티프로필 #346·#1014), 그 프로필 dir 은 세션이 만들 때 `mkdir` 로 비어 있는 채
 *  생긴다. 거기에 lively MCP 를 굽는 일은 지금까지 게이트웨이의 `provisionProfile`(= bash
 *  `deploy/provision-profile.sh`, 관리자 라우트 전용) 이 했다 — **Windows 노드에선 원리적으로 못 돈다.**
 *  한편 키트의 install/update 는 사람 셸에서 도니 기본 위치에만 등록한다.
 *  → 노드 웹세션엔 lively MCP 가 **영원히 안 나타났다**(사람이 세션 안에서 손으로 `lively update` 를 쳐야 했다).
 *  그 오케스트레이션을 키트로 내린다. provision-profile.sh 가 하는 일도 결국
 *  `CLAUDE_CONFIG_DIR=<프로필> install-kit.sh` 하나뿐이다 — 새 메커니즘이 아니라 같은 일을 스스로 하는 것이다.
 *
 * ⚠ 호출자가 `CLAUDE_CONFIG_DIR` 로 **대상을 지목했으면 그것만** 한다. 지목을 무시하고 퍼뜨리면
 *  게이트웨이가 멤버 한 명의 프로필을 프로비저닝할 때 남의 프로필까지 건드린다(#1014 격리 위반).
 */
export function claudeMcpTargets(o) {
  const explicit = String((o.env || {}).CLAUDE_CONFIG_DIR || "").trim();
  if (explicit) return [{ configDir: explicit, label: "지정된 프로필" }];
  const out = [{ configDir: null, label: "기본" }];
  let slugs = [];
  try { slugs = o.listDirs(o.profilesRoot) || []; } catch { slugs = []; }
  for (const slug of [...slugs].sort()) {
    const dir = o.join(o.profilesRoot, slug, "claude");
    if (o.exists(dir)) out.push({ configDir: dir, label: `프로필 ${slug}` });
  }
  return out;
}

/** 이 PC 의 프로필 dir 목록을 실제로 훑어 대상을 낸다(위 순수함수에 파일시스템을 물린다). */
function mcpTargets() {
  return claudeMcpTargets({
    env: process.env,
    profilesRoot: join(LIVELY, "profiles"),
    join,
    exists: existsSync,
    listDirs: (root) => readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name),
  });
}

/** 한 대상(config dir)의 `.claude.json` 에서 항목 하나를 읽는다. null = 없음. configDir null = 기본 위치. */
function claudeMcpEntryIn(configDir, name) {
  const p = configDir ? join(configDir, ".claude.json") : join(HOME, ".claude.json");
  try { return JSON.parse(readFileSync(p, "utf8"))?.mcpServers?.[name] ?? null; } catch { return null; }
}

/**
 * 대상별 등록 커버리지 — 순수. `lively status` 가 "어딘가 있음" 을 초록불로 쓰지 않게 하는 근거.
 *
 * ★ 종전엔 후보 파일 중 **하나라도** 있으면 true 였다(claudeUserMcpRegistered). 그래서 기본 위치엔 있고
 *  프로필엔 없는 상태 — 즉 **웹터미널 세션에선 안 보이는 상태** — 가 ✓ 로 표시됐다(실기기에서 그렇게 오진했다).
 *  "등록됨 ≠ 지금 붙음" 과 같은 계열이다(#1431).
 */
export function mcpCoverage(name, targets, readEntry) {
  const have = [], missing = [];
  for (const t of targets) (readEntry(t.configDir, name) ? have : missing).push(t.label);
  return { any: have.length > 0, all: missing.length === 0, have, missing };
}

/** 폐기된 **우리** 등록 이름 — 남으면 세션마다 '연결 실패' 로 뜬다(#1079 에서 http 직결 → stdio 프록시로 이름이 바뀌었다). */
const LEGACY_MCP_NAMES = ["lively-store"];
/**
 * 이 항목이 **우리가 남긴 잔재**인가 — 순수. 같은 이름을 사람이 직접 만들었을 수 있으니 이름만으로 지우지 않는다.
 * 판정: 우리 게이트웨이 호스트의 `/mcp` 를 가리킬 때만. (스킴·포트는 안 본다 — 옛 등록이 틀렸을 수 있다.
 *  실측: `http://dev.lvly.io:8080/mcp` — 공개 호스트에 http+8080 이라 애초에 닿지도 않는다.)
 */
export function isLegacyLivelyMcp(name, entry, gatewayUrl) {
  if (!LEGACY_MCP_NAMES.includes(name) || !entry || !gatewayUrl) return false;
  try {
    const u = new URL(String(entry.url || ""));
    return /^\/mcp\/?$/.test(u.pathname) && u.hostname === new URL(gatewayUrl).hostname;
  } catch { return false; }
}
// #1431 — **등록 여부만** 필요할 때(값이 아니라 유무). 존재하는 유저 설정 파일 전부를 본다.
function claudeUserMcpRegistered(name) {
  for (const p of claudeUserConfigPaths()) {
    try { if (JSON.parse(readFileSync(p, "utf8"))?.mcpServers?.[name]) return true; }
    catch { /* 파손·못읽음 → 다음 후보 */ }
  }
  return false;
}
function claudeUserMcp(name) {
  const p = claudeUserConfigPath();
  if (!p) return null;   // 파일 자체가 없다 = 설치 전 유저 항목도 없었다
  try { return JSON.parse(readFileSync(p, "utf8"))?.mcpServers?.[name] ?? null; }
  catch { return null; }
}
//  **최초 1회만** 스냅샷 — 이미 백업에 키가 있으면 스킵. 재설치/업데이트가 (이미 라이블리가 덮어쓴) 자기 항목을
//  '유저 것'으로 오인해 백업을 오염시키지 않도록. 값: 유저 항목(객체) 또는 null(설치 전 없었음 → 제거 시 그대로 유지).
function backupUserMcp(name) {
  const p = join(LIVELY, "mcp-user-backup.json");
  let bak = {};
  try { bak = JSON.parse(readFileSync(p, "utf8")) || {}; } catch { bak = {}; }
  if (Object.prototype.hasOwnProperty.call(bak, name)) return;
  bak[name] = claudeUserMcp(name);
  try { writeFileSync(p, JSON.stringify(bak, null, 2) + "\n", { mode: 0o600 }); } catch { /* best-effort — 백업 실패해도 등록은 진행 */ }
}

// lively 본체 등록 — **로컬 stdio 프록시**(`lively mcp`)로 등록한다(#1079).
//  remove 후 add(재실행 안전). remove 실패는 정상(미등록 상태). 호출 전에 has("claude") 를 확인할 것.
//  ⚠ 위치는 claude 가 정한다(--scope user → CLAUDE_CONFIG_DIR 존중, deploy/provision-profile.sh:37) —
//   .claude.json 을 우리가 직접 읽어 판단하지 않는다(프로필 격리 #346 에서 엉뚱한 파일을 보게 된다).
//
//  ⚠ **왜 http 직결이 아닌가(#1079).** 직결이면 세션이 뜨는 순간 게이트웨이에 못 닿을 때(사내 게이트웨이 +
//   VPN 미접속) 하네스가 그 서버를 failed 로 마킹하고 **그 세션 내내 복구하지 않는다** — 도중에 VPN 을 붙여도
//   사람이 `/mcp reconnect lively` 를 직접 쳐야 했다. stdio 프록시는 로컬 프로세스라 항상 connected 이고,
//   상류가 살아나면 tools/list_changed 로 목록을 되살린다(lib/lively-mcp-gateway.mjs).
//
//  종전 http 등록이 헤더로 싣던 것은 이제 **프록시가 상류 호출에 붙인다**(같은 의미·같은 이름):
//   Authorization ← ~/.lively/token (설정 파일에서 평문 토큰이 사라진다) · x-lively-session ← LIVELY_SESSION_ID(#852)
//   · x-lively-mode ← LIVELY_MODE(#1007+) · x-lively-harness ← 명시 stamp(프록시를 거치면 UA 가 우리 것이 되므로 필수).
//   env 는 하네스가 spawn 할 때 그대로 상속되므로 종전과 같은 값이 실린다.
//
//  코드 자동 업뎃(#858)에 무임승차: command(심 절대경로)만 등록하고 서버 코드는 lib/lively-mcp-gateway.mjs 로
//   매 세션 최신 → 코드가 바뀌어도 재등록 불필요.
// 한 config dir 에 전부 등록한다. 대상 열거는 claudeMcpTargets, 여기선 '그 한 곳에 무엇을 넣나' 만.
function registerClaudeMcpIn(target, gw) {
  const cd = target.configDir;
  const at = cd ? ` [${target.label}]` : "";
  const shim = join(LIVELY, "bin", WIN ? "lively.cmd" : "lively");
  let registered = 0, failed = 0;

  // lively 본체 — **로컬 stdio 프록시**(`lively mcp`)로 등록한다(#1079).
  runClaudeIn(cd, ["mcp", "remove", "lively"], { allowFail: true, quiet: true });
  try {
    runClaudeIn(cd, ["mcp", "add", "--transport", "stdio", "--scope", "user", "lively", shim, "mcp"], { quiet: true });
    ok(`MCP 등록: lively${at} (stdio 프록시 → ${gw}/mcp)`);
    registered++;
  } catch (e) { fail(`MCP 등록 실패(lively${at}): ${e.message}`); failed++; }

  // lively-local — 로컬 조작 stdio MCP(#899). 같은 CLI 가 서버(`lively mcp-local`).
  //  코드 자동 업뎃(#858)에 무임승차: command(심 절대경로)만 등록하고 서버 코드는 lib/lively-mcp-local.mjs 로
  //  매 세션 최신 → 코드가 바뀌어도 재등록 불필요(툴 목록 자체를 바꿀 때만 여기 add 가 다시 태운다).
  runClaudeIn(cd, ["mcp", "remove", "lively-local"], { allowFail: true, quiet: true });
  try {
    runClaudeIn(cd, ["mcp", "add", "--transport", "stdio", "--scope", "user", "lively-local", shim, "mcp-local"], { quiet: true });
    ok(`MCP 등록: lively-local${at} (stdio · 로컬조작)`);
    registered++;
  } catch (e) { fail(`MCP 등록 실패(lively-local${at}): ${e.message}`); failed++; }

  // 폐기된 우리 등록 정리 — 남겨두면 세션마다 '연결 실패' 로 뜬다. **우리 것으로 확인될 때만** 지운다
  //  (같은 이름을 사람이 직접 만들었을 수 있다 — isLegacyLivelyMcp 가 게이트웨이 호스트·/mcp 경로로 판정).
  for (const name of LEGACY_MCP_NAMES) {
    const entry = claudeMcpEntryIn(cd, name);
    if (!isLegacyLivelyMcp(name, entry, gw)) continue;
    runClaudeIn(cd, ["mcp", "remove", name], { allowFail: true, quiet: true });
    info(`폐기된 등록 제거: ${name}${at} (지금은 lively stdio 프록시가 대신한다)`);
  }

  // 조직 추가 MCP 서버 — auth_env 는 환경변수 '이름' 간접참조(토큰 리터럴을 파일에 두지 않는다).
  for (const s of readMcpServers()) {
    if (!s || s.enabled === false || !s.name || s.name === "lively") continue;
    backupUserMcp(s.name); // 덮어쓰기 전 유저 원본 스냅샷(최초 1회) — uninstall 원복용(비파괴 라운드트립)
    runClaudeIn(cd, ["mcp", "remove", s.name], { allowFail: true, quiet: true });
    try {
      if (s.transport === "stdio" && s.command) {
        // claude stdio 는 command+args 를 분리 인자로 받는다(공백 토큰 분리 — register-clients.sh 와 동일 한계).
        const parts = String(s.command).trim().split(/\s+/).filter(Boolean);
        runClaudeIn(cd, ["mcp", "add", "--transport", "stdio", "--scope", "user", s.name, ...parts], { quiet: true });
      } else if (s.url) {
        const secret = s.auth_env ? (process.env[s.auth_env] || "") : "";
        const a = ["mcp", "add", "--transport", "http", "--scope", "user", s.name, s.url];
        if (secret) a.push("--header", `Authorization: Bearer ${secret}`);
        runClaudeIn(cd, a, { quiet: true });
        if (s.auth_env && !secret) warn(`${s.name}: 환경변수 ${s.auth_env} 가 비어 무인증 등록됨`);
      } else continue;
      ok(`MCP 등록: ${s.name}${at}`);
      registered++;
    } catch (e) { fail(`MCP 등록 실패(${s.name}${at}): ${e.message}`); failed++; }
  }
  return { registered, failed };
}

function registerClaudeMcp() {
  const gw = gateway();
  if (!has("claude")) { info("claude 미설치 — MCP 등록 건너뜀"); return { registered: 0, failed: 0 }; }
  let registered = 0, failed = 0;
  const targets = mcpTargets();
  // 프로필이 있으면 그것까지 전부 — 웹터미널 세션은 프로필 dir 을 읽으므로 기본 위치만 등록하면 세션엔 안 보인다.
  if (targets.length > 1) info(`MCP 등록 대상 ${targets.length}곳: ${targets.map((t) => t.label).join(" · ")}`);
  for (const t of targets) {
    const r = registerClaudeMcpIn(t, gw);
    registered += r.registered; failed += r.failed;
  }
  return { registered, failed };
}

// ── 8. 설치/업데이트의 단일 코드 경로 ───────────────────────────────────────
//  install 과 update 는 같은 일을 한다(멱등). 다른 건 문구와, install 이 claude 부재 시 설치를 제안한다는 것뿐.
async function syncKit({ label, offerHarness }) {
  if (!gateway()) die("게이트웨이 주소를 모릅니다 — `lively login --gateway <url>` 로 지정하세요.");
  if (!token()) die("로그인이 필요합니다 — 먼저 `lively login` 을 실행하세요.");

  let harnesses = detectHarnesses();
  if (!harnesses.length && offerHarness) {
    warn("Claude Code · Codex 가 둘 다 안 보입니다.");
    if (WIN) {
      // Windows 엔 sh 가 없다 — 공식 설치 안내만 하고 진행한다(있지도 않은 셸을 부르고 조용히 실패하지 않는다).
      info("Claude Code 를 먼저 설치하세요: https://code.claude.com/docs/setup  → 설치 후 `lively install` 재실행");
    } else if (await askYesNo("  Claude Code 를 지금 설치할까요?", true)) {
      run("sh", ["-c", "curl -fsSL https://claude.ai/install.sh | bash"], { allowFail: true });
      // claude 설치기는 ~/.local/bin 에 넣고 PATH 영속화는 사용자 몫으로 남긴다 — 이 프로세스에서만 보이게 해 둔다.
      process.env.PATH = `${join(HOME, ".local", "bin")}:${process.env.PATH || ""}`;
      harnesses = detectHarnesses();
    }
  }
  if (!harnesses.length) {
    warn("하네스 없이 진행합니다 — 맥락·훅은 설치되지만 켤 AI 가 없습니다.");
    info("Claude Code 설치 후 `lively install` 을 다시 실행하면 배선이 완료됩니다.");
    harnesses = ["claude"];   // 자산은 깔아 둔다 — 나중에 claude 를 깔면 바로 작동.
  }

  say(`\n${bold(label)}  ${dim("하네스: " + harnesses.join(", "))}`);
  // 진행 신호(#1541 T1) — GUI 가 진행률을 그린다. 사람용 `[1/3]` 문구는 그대로 두고 **덧붙이기만** 한다.
  const step = (id, lbl, status, i, extra) => { if (EV) EV.step(id, lbl, status, { i, n: 3, harnesses, ...(extra || {}) }); };
  say(dim("  [1/3] 키트 내려받는 중…"));
  step("kit-download", "키트 내려받는 중", "start", 1);
  const { dir, root } = await downloadBundle();
  try {
    const version = verifyBundle(root);
    ok(`키트 검증 완료${version ? "  " + dim("(" + version + ")") : ""}`);
    // 번들 레지스트리 기준으로 하네스 목록 재계산 — 구 CLI 로 돌려도 새 하네스 배선이 빠지지 않게(#1689).
    const late = await augmentHarnessesFromBundle(root, harnesses);
    if (late.length) say(dim(`  (이 번들이 새로 지원하는 하네스 감지: ${late.join(", ")} — 함께 배선합니다)`));
    step("kit-download", "키트 내려받는 중", "done", 1);

    say(dim("  [2/3] 설치 중…"));
    step("kit-install", "설치 중", "start", 2);
    // 설치의 엔진은 번들 동봉 user-install.mjs — 비파괴 머지·백업·auto-approve reconcile 이 전부 거기 있다.
    //  ⚠ LIVELY_TOKEN 을 **명시 주입**한다: user-install.mjs 의 org-seed fetch 는 아직 env 우선이라(그쪽:539),
    //   안 주면 이 셸의 스테일 env 로 시드를 받아 **번들은 새 신원·시드는 옛 신원**으로 갈린다(#916 계열).
    //   token() 이 정본(파일)을 이미 풀었으니 그 값을 그대로 물려준다 — process.env 전역을 덮지 않는 이유는 afterLogin 주석 참조.
    run(process.execPath, [join(root, "setup", "user-install.mjs"), "--clone-root", root, "--harness", harnesses.join(",")],
      { env: { LIVELY_TOKEN: token() } });

    step("kit-install", "설치 중", "done", 2);
    say(dim("  [3/3] MCP 등록 중…"));
    step("mcp-register", "MCP 등록 중", "start", 3);
    const r = registerClaudeMcp();
    if (r.failed) warn(`MCP 등록 ${r.failed}건 실패 — 위 오류를 확인하고 다시 시도하세요.`);
    step("mcp-register", "MCP 등록 중", r.failed ? "fail" : "done", 3, r.failed ? { failed: r.failed } : undefined);

    say("");
    say(green(bold("=== 끝! ===")));
    say(`  이제 아무 폴더에서든 ${bold("claude")}${harnesses.includes("codex") ? " · " + bold("codex") : ""} 를 켜면 회사 맥락이 따라옵니다.`);
    say(dim("  (훅은 세션 시작에 스냅샷됩니다 — 이미 켜 둔 세션이 있으면 껐다 켜세요.)"));
    say(dim("  상태 확인: ") + bold("lively status") + dim("    문제 진단: ") + bold("lively doctor"));
    return version;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 9. 로그인 ──────────────────────────────────────────────────────────────
// PKCE S256 — 서버(device-auth.ts)와 동일 계산. verifier→challenge.
const s256 = (verifier) => crypto.createHash("sha256").update(verifier).digest("base64url");

// 브라우저 자동 오픈 — best-effort·detached·비블로킹·전 에러 무시(폴 루프를 절대 안 막음, 설계 V2).
//  darwin `open` · win `cmd /c start "" <url>`(빈 title 필수) · linux `xdg-open`(단 $DISPLAY 있을 때만 — headless no-op).
//
// 자동 오픈을 끄는 스위치 — 사람이 안 보는 자리(테스트·CI·원격 셸)에서 남의 화면에 탭을 띄우지 않기 위한 것.
//  ⚠ 편의 옵션이 아니라 격리다: 이게 없던 동안 `npm test` 한 번이 실행한 사람의 브라우저에 픽스처 URL 탭을
//   최대 5개 띄웠다(#1717 — device 흐름을 실 프로세스로 태우는 테스트들. 테스트의 PATH 샌드박스는
//   /usr/bin·System32 를 일부러 남기므로 PATH 로는 못 막고, 여기서 끊는 수밖에 없다).
//  안 열려도 로그인은 막히지 않는다 — URL·코드는 호출부가 화면에 **먼저** 찍고, 승인은 어느 브라우저에서 해도 된다.
//  빈 문자열은 '안 켬'으로 본다(테스트가 LIVELY_TOKEN:"" 로 끄는 관례와 같다).
const NO_BROWSER = !!(process.env.LIVELY_NO_BROWSER || process.env.CI);
function openBrowser(url) {
  if (NO_BROWSER) return;
  try {
    let cmd, args;
    if (process.platform === "darwin") { cmd = "open"; args = [url]; }
    else if (WIN) { cmd = "cmd"; args = ["/c", "start", "", url]; }
    else {
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return; // 헤드리스 — URL 만 표시(위에서 이미 출력)
      cmd = "xdg-open"; args = [url];
    }
    const c = spawn(cmd, args, { detached: true, stdio: "ignore" });
    c.on("error", () => { /* 브라우저 없음 등 — 무시 */ });
    c.unref();
  } catch { /* best-effort */ }
}

// 토큰 신원 확인(옵션으로 저장) — --token·디바이스 흐름·폴백이 공유. me 반환. store=false 면 확인만(디바이스 흐름이
//  저장 전 [Y/n] 을 물어야 하므로 — 저장 후 취소는 어색).
async function validateAndStore(gw, tok, { announce = true, store = true } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  let me;
  try {
    const res = await fetch(gw + "/api/ui/me/profile", { signal: ctl.signal, headers: { authorization: `Bearer ${tok}` } });
    if (res.status === 401 || res.status === 403) die("토큰이 거부됐습니다 — 관리자에게 받은 토큰이 맞는지 확인하세요.");
    if (!res.ok) die(`게이트웨이가 정상 응답하지 않습니다 (HTTP ${res.status}) — 주소를 확인하세요: ${gw}`);
    me = await res.json();
  } catch (e) {
    if (e?.name === "AbortError") die(`게이트웨이 응답 없음(타임아웃) — 주소·네트워크·VPN 을 확인하세요: ${gw}`);
    throw e;
  } finally { clearTimeout(timer); }
  if (store) {
    writeLively("token", tok);
    writeLively("gateway-url", gw);
    if (announce) {
      say("");
      ok(`${bold(me?.display_name || me?.id || "구성원")} 님으로 인증됐습니다.`);
      info(`토큰 저장: ~/.lively/token (0600) · 게이트웨이: ${gw}`);
    }
  }
  return me;
}

// 토큰 가림입력 경로(구 방식) — 롤백 폴백 + 비대화형이 아닐 때의 명시적 요청. 셸 히스토리에 안 남는다.
async function loginWithPastedToken(gw) {
  if (!interactive()) die("비대화형 환경입니다 — `lively login --token <토큰>` 또는 LIVELY_TOKEN 환경변수를 쓰세요.");
  say(`\n${bold("라이블리 로그인")}  ${dim(gw)}`);
  say(dim("  토큰은 관리자에게 받거나, 웹 [사용 가이드 › 내 AI 세션 생성] 에서 발급합니다."));
  const tok = String(await askHidden("  접속 토큰을 붙여넣으세요 (화면에 안 보입니다): ") || "").trim();
  if (!tok) die("토큰이 비어 있습니다.");
  const me = await validateAndStore(gw, tok);
  afterLogin(gw, tok);
  return me;
}

// 디바이스 코드 흐름(기본 대화형). 서버가 디바이스 엔드포인트를 모르면(구 서버·롤백) 'unsupported' 반환 → 폴백.
async function deviceLogin(gw) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const label = `${process.env.LIVELY_HARNESS || "lively"}@${hostLabel()}`;
  // ① start — 404/501/비-JSON/500 이면 폴백(구 서버).
  let start;
  try {
    const res = await fetch(gw + "/cli/device/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code_challenge: s256(verifier), label }),
    });
    if (res.status === 404 || res.status === 501 || res.status === 500) return "unsupported";
    const text = await res.text();
    try { start = JSON.parse(text); } catch { return "unsupported"; } // 비-JSON(로그인 HTML 등) → 폴백
    if (!res.ok || !start.device_code) return "unsupported";
  } catch (e) {
    // 네트워크 실패는 폴백이 아니라 진짜 오류(주소·연결) — 명확히 알린다.
    die(`게이트웨이에 연결하지 못했습니다 (${e.message}) — 주소·네트워크를 확인하세요: ${gw}`);
  }

  // ② URL·코드 먼저 출력(브라우저 오픈은 순수 부가).
  say(`\n${bold("라이블리 로그인")}  ${dim(gw)}`);
  say("  아래 주소를 브라우저에서 열어 승인하세요:");
  say("    " + bold(start.verification_uri));
  say("    코드: " + bold(start.user_code));
  // 누가 여는지에 따라 안내가 달라진다 — 앱이 몰면 앱이, 터미널이면 CLI 가 연다. 억제 중이면 아무도 안 여니
  //  "자동으로 열립니다" 는 거짓말이 된다(#1717).
  say(dim(PROMPTER || !NO_BROWSER
    ? "  (브라우저가 자동으로 열립니다. 안 열리면 위 주소를 직접 여세요.)"
    : "  (자동 열기가 꺼져 있습니다 — 위 주소를 직접 여세요.)"));
  // 앱은 코드·주소를 **이벤트로** 받는다(#1541 T1) — 사람용 문구를 파싱하게 두면 문구를 못 고친다.
  //  답을 기다리지 않는 통지형이다: 승인은 브라우저에서 일어나고, CLI 는 아래 폴 루프로 그걸 안다.
  //  ⚠ device_code(비밀)는 싣지 않는다 — 앱이 알 이유가 없고, 새면 그 로그인을 가로챌 수 있다.
  if (PROMPTER) {
    PROMPTER.tell("device-code", "device-code", {
      user_code: start.user_code, verification_uri: start.verification_uri,
      verification_uri_complete: start.verification_uri_complete || null,
      expires_in: Number(start.expires_in) || null, gateway: gw,
    });
  }
  // 브라우저는 **한 쪽만** 연다(#1717). 앱이 몰고 있으면(PROMPTER) 위 이벤트를 받은 앱이 shell.openExternal
  //  로 연다(desktop/main/main.mjs 의 askUser) — 여기서도 열면 같은 URL 탭이 **두 개** 뜬다.
  //  앱이 몰 때 UX 통제권은 앱 몫이다: 창을 띄우고 어느 브라우저로 보낼지 정하는 건 그쪽이 안다.
  if (!PROMPTER) openBrowser(start.verification_uri_complete || start.verification_uri);
  say(dim("  · 브라우저에서 승인을 기다리는 중… (이 창은 열어 두세요)"));
  if (EV) EV.step("device-approve", "브라우저에서 승인 대기", "start");

  // ③ 폴 루프 — 전송오류 내성(백오프 계속), 종료는 명시적 denied/expired/invalid 만.
  let interval = Math.max(2, Number(start.interval) || 5);
  const deadline = Date.now() + (Number(start.expires_in) || 900) * 1000;
  for (;;) {
    await sleep(interval * 1000);
    if (Date.now() > deadline) die("코드가 만료됐습니다 — `lively login` 을 다시 실행하세요.");
    let status, body;
    try {
      const res = await fetch(gw + "/cli/device/poll", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: start.device_code, code_verifier: verifier }),
      });
      status = res.status;
      const text = await res.text();
      try { body = JSON.parse(text); } catch { body = null; } // 비-JSON(Caddy 502 등) → 일시 오류
    } catch { status = 0; body = null; } // ECONNREFUSED·타임아웃 등 → 일시 오류
    if (status === 200 && body?.token) {
      if (EV) EV.step("device-approve", "브라우저에서 승인 대기", "done");   // ⚠ 토큰은 절대 이벤트에 안 싣는다(D6)
      return { token: body.token, scopes: body.scopes || [] };
    }
    if (status === 202) continue;                                  // authorization_pending
    if (status === 429) { interval = (Number(body?.interval) || interval) + 5; continue; } // slow_down
    if (status === 403) die("승인이 거부됐습니다.");
    if (status === 410 || status === 401) die("코드가 만료됐습니다 — `lively login` 을 다시 실행하세요.");
    // 그 외(0·5xx·비-JSON) = 일시 오류 → 백오프 후 계속(게이트웨이 재시작 중일 수 있음, DB 행은 살아있음).
  }
}

// 호스트 라벨(승인 화면 표시용, 자기주장 값) — 서버가 [\w .@-] 로 제한한다.
function hostLabel() {
  try { return String(spawnSync("hostname", [], { encoding: "utf8" }).stdout || "").trim().split(".")[0] || "내PC"; }
  catch { return "내PC"; }
}

// 로그인 탈출구(디바이스 흐름 건너뜀) 판정 — **순수함수라 TTY 없이 직접 검증한다**(winArg 와 같은 이유:
//  아래 분기는 제어단말이 있어야 밟히는데 e2e 하네스엔 없다). 분기표:
//    --token 있음                 → 그 토큰. 문서화된 CI 경로(web/learn.ts) 이자 테스트가 쓰는 경로.
//    파일 없음 + env 있음         → env. 이 박스는 로그인한 적 없다 = env 가 유일한 자격(CI·프로비저닝 컨테이너).
//    비대화형 + env 있음          → env. 열 브라우저가 없다(탈출구의 본래 의도이자 기존 안내문구의 약속).
//    파일 있음 + 대화형           → "" (탈출구 없음 → 브라우저 흐름).
//  ⚠ **파일이 있는 대화형 셸에서 env 를 탈출구로 쓰면 안 된다**(#916): 설치기가 codex 용으로 rc 에
//   `export LIVELY_TOKEN="$(cat ~/.lively/token)"` 를 심으므로 키트를 깐 사람의 셸엔 **항상** 있다
//   → 옛 코드는 100% 이 탈출구로 빠져 브라우저를 안 열고 옛 토큰을 재검증·재저장만 하면서
//   "✓ 인증됐습니다"를 찍었다(= 재로그인으로 권한을 바꾸는 게 구조적으로 불가능했다).
//   판별자로 **파일 존재**를 함께 보는 이유: 그 rc 수화는 파일이 있어야만 일어나므로 '파일 있음+사람'이
//   정확히 #916 의 조건이고, TTY 만으로 가르면 pty 를 붙인 프로비저닝 컨테이너(docker run -t)를 깬다.
const loginEscapeToken = ({ flagToken = "", envToken = "", fileToken = "", isInteractive }) => {
  if (flagToken) return String(flagToken).trim();
  if (!fileToken || !isInteractive) return String(envToken || "").trim();
  return "";
};

// 로그인 성공 뒤 마무리 — 신원의 **사본**을 새 토큰에 맞춘다(login 이 install 을 대신하진 않는다).
//  ⚠ 여기서 `process.env.LIVELY_TOKEN` 을 덮지 **않는다**: 그러면 뒤이어 도는 registerClaudeMcp 의
//   org 서버 루프가 `process.env[s.auth_env]` 로 그 값을 집어, 관리자가 지정한 임의 URL 의 Authorization
//   헤더로 **멤버 개인 게이트웨이 토큰**을 구울 수 있다(auth_env 는 org MCP 서버 경로에서 화이트리스트
//   강제가 없다 — allowed_auth_envs 는 org_tool 전용, dynamic-tools.ts:115). 필요 없기도 하다: token() 이
//   파일 우선이고 로그인이 방금 파일을 썼으므로 같은 프로세스의 후속 호출은 이미 새 토큰을 본다.
function afterLogin(gw, tok) {
  // .claude.json 의 lively 항목은 **토큰의 사본**이고 방금 로그인이 그걸 무효화했다 → 여기서 다시 굽는다.
  //  없으면: 사용자가 로그인만 하고 멈췄을 때(bootstrap.sh·웹 안내가 그렇게 시킨다) MCP 는 옛 신원으로 남는다.
  registerClaudeMcp(); // claude 미설치 판정·안내 포함. (#247 — 구명 registerLivelyMcp 잔재 호출이 여기서 크래시했다)
  // codex 는 토큰을 config.toml 에 안 굽고 LIVELY_TOKEN 을 읽으므로(bearer_token_env_var) 재등록할 게 없다.
  //  대신 **이 셸의 env 는 우리가 못 고친다**(자식이 부모 셸을 못 바꾼다) → 조용히 두지 말고 사실대로 알린다.
  if (ENV_TOKEN_AT_START && ENV_TOKEN_AT_START !== tok) {
    warn(`이 셸의 LIVELY_TOKEN 은 아직 이전 토큰입니다 — ${RELOAD_SHELL_HINT} 뒤에 codex 를 쓰세요.`);
  }
}

async function cmdLogin(opts) {
  if (opts.gateway) writeLively("gateway-url", normGw(opts.gateway));
  const gw = gateway();
  if (!gw) die("게이트웨이 주소가 없습니다 — `lively login --gateway https://<주소>` 로 지정하세요.");
  const isInteractive = interactive();

  // ① 탈출구(CI·프로비저닝) — 판정은 loginEscapeToken 의 분기표 참조.
  const escape = loginEscapeToken({
    flagToken: opts.token, envToken: process.env.LIVELY_TOKEN, fileToken: readLively("token"), isInteractive,
  });
  if (escape) { const me = await validateAndStore(gw, escape); afterLogin(gw, escape); return me; }

  // ② 비대화형(TTY 없음)인데 토큰도 없음 → 명확 안내.
  if (!isInteractive) die("비대화형 환경입니다 — `lively login --token <토큰>` 또는 LIVELY_TOKEN 환경변수를 쓰세요.");

  // ③ 대화형인데 env 토큰이 파일과 다르다 = 사람이 일부러 넣었을 수 있다 → 무시한다는 걸 알린다(조용히 버리지 않는다).
  //   같으면(= rc 수화, 키트 사용자의 정상 상태) 할 말이 없으니 침묵한다.
  if (ENV_TOKEN_AT_START && ENV_TOKEN_AT_START !== readLively("token")) {
    info('환경변수 LIVELY_TOKEN 은 쓰지 않고 브라우저 로그인으로 진행합니다 — 그 토큰을 쓰려면 `lively login --token "$LIVELY_TOKEN"`.');
  }

  // ④ 기본: 브라우저 디바이스 흐름. 서버가 모르면(구 서버·롤백) 토큰 가림입력으로 폴백.
  const dev = await deviceLogin(gw);
  if (dev === "unsupported") {
    info("이 게이트웨이는 브라우저 로그인을 아직 지원하지 않습니다 — 토큰 입력으로 진행합니다.");
    return loginWithPastedToken(gw);
  }
  // ⑤ 저장 전 신원 확인(역방향 피싱 방어, R2-F1) — 불변 email 로. 확인 통과 후에만 저장.
  const me = await validateAndStore(gw, dev.token, { store: false });
  const who = me?.email || me?.id || "구성원";
  say("");
  const yes = await askYesNo(`  ${bold(who)} 로 로그인됩니다. 계속할까요?`, true);
  if (!yes) die("이 로그인은 당신이 시작한 게 아닐 수 있습니다 — 저장을 취소했습니다.", 1);
  writeLively("token", dev.token);
  writeLively("gateway-url", gw);
  ok(`${bold(who)} 님으로 로그인됐습니다. (토큰 저장: ~/.lively/token)`);
  afterLogin(gw, dev.token);
  return me;
}

function cmdLogout() {
  const p = join(LIVELY, "token");
  if (!existsSync(p)) { info("이미 로그아웃 상태입니다(저장된 토큰 없음)."); return; }
  rmSync(p, { force: true });
  ok("토큰을 지웠습니다 (~/.lively/token).");
  // 파일만 지울 수 있다 — 이 셸의 env 는 자식이 못 고친다. 남아 있으면 token() 이 env 로 폴백해
  //  `lively status` 가 계속 '인증됨' 을 보인다 → 조용히 두지 말고 사실대로 말한다(#916 계열).
  if (ENV_TOKEN_AT_START) warn("이 셸의 LIVELY_TOKEN 은 아직 남아 있습니다 — 새 터미널을 열거나 `unset LIVELY_TOKEN` 하세요.");
  info("설치 파일은 그대로입니다 — 완전 제거는 `lively uninstall`.");
  info("claude 에 등록된 MCP 항목은 남아 있습니다 — 지우려면 `claude mcp remove lively`.");
}

const cmdInstall = () => syncKit({ label: "라이블리 설치", offerHarness: true });

async function cmdUpdate(opts) {
  if (opts.check) {
    const st = await gatherStatus();
    if (!st.gateway.reachable) die(`게이트웨이에 닿지 못했습니다 — ${st.gateway.error || "원인 불명"}`);
    if (!st.kit.remote) { info("게이트웨이가 키트 버전을 알려주지 않습니다(구버전 게이트웨이)."); return; }
    if (st.kit.current) ok(`이미 최신입니다 (${st.kit.local}).`);
    else {
      warn(`업데이트가 있습니다: ${st.kit.local || "(미설치)"} → ${st.kit.remote}`);
      say(dim("  적용: ") + bold("lively update"));
    }
    return;
  }
  await syncKit({ label: "라이블리 업데이트", offerHarness: false });
}

const uninstallArgs = (o) => [
  ...(o.dryRun ? ["--dry-run"] : []), ...(o.purge ? ["--purge"] : []), ...(o.yes ? ["--yes"] : []),
  ...(o.harness ? ["--harness", o.harness] : []),
];

async function cmdUninstall(opts) {
  // 제거기도 **설치와 같은 세대**를 쓴다 — 센티넬 리터럴이 짝이 맞아야 완전복구가 성립한다(#744).
  //  로그아웃/오프라인이면 설치 때 함께 심어 둔 로컬 사본(~/.lively/lib)으로 폴백한다(제거는 언제나 가능해야 한다).
  if (token() && gateway()) {
    let bundle = null;
    try { bundle = await downloadBundle(); }
    catch (e) { warn(`번들을 못 받아 로컬 제거기로 진행합니다 (${e.message})`); }
    if (bundle) {
      try {
        const un = join(bundle.root, "setup", "user-uninstall.mjs");
        if (existsSync(un)) { run(process.execPath, [un, ...uninstallArgs(opts)]); return; }
        warn("번들에 제거기가 없습니다(구버전 게이트웨이) — 로컬 제거기로 진행합니다.");
      } finally { rmSync(bundle.dir, { recursive: true, force: true }); }
    }
  }
  const local = join(LIVELY, "lib", "user-uninstall.mjs");
  if (!existsSync(local)) die("제거기를 찾지 못했습니다 — `lively login` 후 다시 시도하세요.");
  run(process.execPath, [local, ...uninstallArgs(opts)]);
}

// 상태 수집 — status 와 doctor 가 공유. 네트워크 실패는 예외가 아니라 **값**으로 담는다(진단이 목적이라 죽으면 안 된다).
async function gatherStatus() {
  const gw = gateway(), tok = token();
  const st = {
    cli: CLI_VERSION,
    gateway: { url: gw || null, reachable: false, error: null },
    account: { authenticated: false, id: null, name: null },
    kit: { local: readLively("kit-version") || null, remote: null, current: false, autoUpdate: null },
    harness: {
      // mcp = 등록됐나(정적) · mcpConnected = 지금 실제로 붙나(동적, 모르면 null — 아는 척하지 않는다)
      // assets = 조직 자산이 이 머신에 실제로 깔렸나 { local, server } (#1475 — 아래 주석 참조)
      claude: { installed: has("claude"), wired: false, mcp: false, mcpConnected: null, mcpMissing: null, assets: null },
      // configOk = codex 가 config.toml 을 **실제로 읽을 수 있나**. 이 축이 없어서 2026-08-04 윈도우 사고 때
      //  status 가 "✓ 배선"이라고 거짓 보고했다 — 파일에 우리 센티넬은 있는데 codex 는 파싱 실패로 아예 안 떴다.
      //  (한 줄의 문법 오류가 파일 전체를 무효화하는 게 TOML 이라, '우리 블록이 있다'는 '동작한다'가 아니다.)
      codex: { installed: has("codex"), wired: false, mcp: null, mcpConnected: null, configOk: null, transport: null, assets: null },
      // opencode 도 codex 와 같은 깊이로 본다 — 설정에 **알 수 없는 top-level 키가 있으면 아예 안 뜨므로**
      //  ('배선됨'과 '동작함'이 다른 구조가 codex 와 같다) configOk 축을 함께 둔다.
      //  mcp 초기값이 null 인 것도 codex 와 같은 이유다: 설정을 **못 읽었을 때**(주석 든 .jsonc 등)를
      //  '미등록'으로 단정하면 "lively update" 헛다리 조치를 부른다. 모르면 물음표로 적는다.
      opencode: { installed: has("opencode"), wired: false, mcp: null, mcpConnected: null, configOk: null, transport: null, assets: null },
      // antigravity(#1689) — 설치 판정은 **agy** 바이너리다. configOk = 우리 플러그인 JSON(hooks/mcp_config)이
      //  파싱되는가(깨진 파일은 fail-open 이라 세션은 살지만 그 기능만 조용히 빠진다 — 그걸 여기서 드러낸다).
      antigravity: { installed: has("agy"), wired: false, mcp: null, mcpConnected: null, configOk: null, transport: null, assets: null },
      // grok(#1701) — configOk = 우리 훅 배선 파일(lively-grok.json)이 JSON 으로 파싱되는가. grok 은 깨진 훅
      //  파일을 **조용히 건너뛰므로**(fail-open) 깨짐 = 우리 훅이 통째로 소리 없이 빠진 상태 — 그걸 여기서 드러낸다.
      grok: { installed: has("grok"), wired: false, mcp: null, mcpConnected: null, configOk: null, transport: null, assets: null },
    },
    hooks: { installed: 0, expected: REQUIRED_HOOKS.length },
    // 노드 축(#1541 T4) — 데스크톱 앱이 폴링한다. 부트스트랩 직후엔 cmd-node.mjs 가 아직 없을 수 있으므로
    //  (그 시점의 lively.mjs 는 단독 파일이다) 못 읽으면 null 로 둔다 — '없음' 과 '모름' 을 섞지 않는다.
    node: null,
  };
  try {
    const { nodeCommands: _n, nodeStatus, nodeConnectedFrom, nodeSleepInfoFrom } = await import(new URL("./cmd-node.mjs", import.meta.url));
    if (typeof nodeStatus === "function") st.node = nodeStatus();
    // '붙어 있는가' 축(#1541) — 프로세스가 돌아도 게이트웨이엔 오프라인일 수 있다(절전 뒤 좀비, 실측 3시간·나흘).
    //  게이트웨이에 못 물으면 null(모름) — false 로 눕히면 정상 노드를 '끊김' 이라 거짓말한다.
    if (st.node?.registered && st.node.id && token() && gateway() && typeof nodeConnectedFrom === "function") {
      try {
        const payload = await api("/api/ui/nodes", { timeoutMs: 5000 });
        st.node.connected = nodeConnectedFrom(payload, st.node.id);
        // #1849 — "붙어 있나" 옆의 **왜 안 붙어 있나**. 서버가 만든 문구를 그대로 나른다(문구 출처 단일화).
        if (typeof nodeSleepInfoFrom === "function") st.node.sleep = nodeSleepInfoFrom(payload, st.node.id);
      } catch { st.node.connected = null; }
    }
  } catch { /* 모듈 없음(부트스트랩 직후) 또는 조회 실패 — node 는 null 로 남는다 */ }
  try {
    const s = readFileSync(join(CLAUDE_DIR, "settings.json"), "utf8");
    st.harness.claude.wired = s.includes(".lively/hooks/") || s.includes(".lively\\hooks\\");
  } catch { /* */ }
  try { st.harness.codex.wired = readFileSync(CODEX_CFG, "utf8").includes("lively-managed"); } catch { /* */ }
  try { st.hooks.installed = readdirSync(join(LIVELY, "hooks")).filter((f) => REQUIRED_HOOKS.includes(f)).length; } catch { /* */ }
  if (st.harness.claude.installed) {
    // ⚠ `claude mcp list` 는 등록된 MCP 서버를 **전부** 헬스체크(=연결)한다. lively(http) 서버가 게이트웨이에 못 붙으면
    //  (게이트웨이 미도달) 그 연결이 무한정 매달려 `lively status` 전체가 hang 된다 — #1043 실측: MCP_TIMEOUT 없으면
    //  10초+ 후에도 안 끝나 SIGKILL. MCP_TIMEOUT 으로 서버별 헬스체크를 bound 하면 다운 서버는 ~3s 뒤 ✘ 로 완료되고,
    //  spawnSync timeout 은 그마저 안 먹힐 때의 하드 백스톱이다.
    // #1431 — 그래서 `list`(전체) 대신 **`get lively`(우리 것 하나)** 를 쓴다. 실측(2026-08-03, 등록 서버 14개):
    //   · `mcp list` 4.78s = `lively status` 4.8s 의 **91%**. 그 비용은 **남의 서버 12개**(claude.ai 커넥터 8·npx·bun·
    //     linear·notion)를 깨우는 값이다 — 게이트웨이 자체는 0.09s 다. 우리 상태를 보려고 남의 커넥터를 다 깨울 이유가 없다.
    //   · `mcp get lively` 1.55s — 우리 서버만 헬스체크한다.
    //   · 게다가 종전 판정은 **이름 매칭**이라 헬스체크 결과를 버렸다: 죽은 서버도 출력에 이름은 남아
    //     (`lively: … - ✘ Failed to connect`) true 였다 → **끊김을 감지할 수 없었다**. `get` 은 `Status:` 줄로 답한다.
    const g = runClaude(["mcp", "get", "lively"], { allowFail: true, quiet: true, timeout: 8000, env: { MCP_TIMEOUT: "3000" } });
    const out = `${g.out}${g.err}`;
    if (/^\s*Scope:/m.test(out)) {
      st.harness.claude.mcp = true;                                        // 등록됨(스코프 무관 — user/project/local 다 잡힌다)
      st.harness.claude.mcpConnected = /^\s*Status:/m.test(out) ? /^\s*Status:\s*✔/m.test(out) : null;
    } else {
      // `mcp get` 을 모르는 구버전 claude 이거나, 정말 미등록. **구별할 필요가 없다** — 유저 설정 파일을 직접 읽으면
      //  등록 여부는 구버전에서도 정답이고, 미등록이면 어차피 false 다. 연결은 확인 못 했으니 null(모른다)로 둔다.
      st.harness.claude.mcp = claudeUserMcpRegistered("lively");
      st.harness.claude.mcpConnected = null;
    }
    // ★ `mcp get` 은 **이 프로세스의** CLAUDE_CONFIG_DIR 한 곳만 본다. 그래서 그것만으로는
    //  "웹터미널 세션(=프로필 dir)에서도 보이나" 를 답할 수 없다 — 기본 위치엔 있고 프로필엔 없는 상태가
    //  ✓ 로 표시되던 실기기 오진이 정확히 그 틈이었다. 대상 전부를 파일로 훑어 **빠진 곳을 이름으로** 남긴다.
    try {
      const cov = mcpCoverage("lively", mcpTargets(), claudeMcpEntryIn);
      st.harness.claude.mcpMissing = cov.missing;      // 빈 배열 = 전 대상 커버(세션에서도 보인다)
    } catch { st.harness.claude.mcpMissing = null; }    // 못 쟀으면 null — 아는 척하지 않는다
  }
  // codex 도 같은 깊이로 본다(#1475) — 종전엔 '설치·배선' 두 칸뿐이라, config 가 깨져 codex 가 아예 안 뜨는
  //  상태에서도 status 는 초록불이었다. `codex mcp get lively` 한 번으로 세 가지를 동시에 얻는다:
  //   ① config 로드 가능 여부(파싱 실패면 stderr 에 `Error loading config.toml` — 이게 그 사고의 유일한 신호였다)
  //   ② 우리 서버 등록 여부  ③ transport(stdio 프록시인가 http 직결인가 — 세션·모드 헤더가 실리는지가 갈린다)
  //  ⚠ 연결 여부는 **모른다(null)** 로 둔다 — codex 의 `enabled` 는 설정값이지 헬스체크가 아니다. 아는 척하지 않는다.
  if (st.harness.codex.installed) {
    const g = run("codex", ["mcp", "get", "lively"], { allowFail: true, quiet: true, timeout: 8000 });
    const out = `${g.out}${g.err}`;
    if (/error loading config|failed to load configuration/i.test(out)) {
      st.harness.codex.configOk = false;                    // 파일이 통째로 무효 — 우리 배선도 남의 MCP 도 다 죽는다
    } else if (/^\s*enabled:/m.test(out)) {
      st.harness.codex.configOk = true;
      st.harness.codex.mcp = true;
      st.harness.codex.transport = (/^\s*transport:\s*(\S+)/m.exec(out) || [])[1] || null;
    } else if (/no mcp server named/i.test(out)) {
      st.harness.codex.configOk = true;                     // 파일은 읽혔다 — 우리 서버만 없다
      st.harness.codex.mcp = false;
    }
    // 그 외(구버전 codex 등 출력 미상) → configOk·mcp 를 그대로 null/false 로 둔다(판정 불가를 단정하지 않는다).
  }
  // opencode — 배선 신호는 어댑터 파일, MCP 등록은 설정 파일에서 직접 읽는다(파일 읽기라 비용 0).
  //  연결 여부만 `opencode mcp list` 로 확인한다. ⚠ 그 명령은 등록된 **모든** MCP 를 실제로 연결하므로
  //   claude 의 `mcp list` 와 같은 비용 문제가 있다(#1431) — opencode 엔 `mcp get` 이 없어 대안이 없으니
  //   타임아웃으로 bound 하고, 못 읽으면 null(모름)로 둔다. 모르는 걸 pass/fail 로 단정하지 않는다.
  try { st.harness.opencode.wired = existsSync(OPENCODE_PLUGIN); } catch { /* */ }
  {
    const cfgPath = [join(OPENCODE_DIR, "opencode.json"), join(OPENCODE_DIR, "opencode.jsonc")].find((p) => existsSync(p));
    // 설정 파일이 **아예 없다** = 우리가 배선한 적 없다 → 미등록(확정). 파일은 있는데 못 읽는 건 다른 얘기라 아래서 null 유지.
    if (!cfgPath) st.harness.opencode.mcp = false;
    if (cfgPath) {
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        st.harness.opencode.mcp = !!(cfg && cfg.mcp && cfg.mcp.lively);
        st.harness.opencode.transport = st.harness.opencode.mcp ? (cfg.mcp.lively.type || null) : null;
        st.harness.opencode.configOk = true;              // 우리가 읽을 수 있는 형태 — opencode 도 읽는다
      } catch { /* 주석 든 .jsonc 등 — 우리가 못 읽었을 뿐 opencode 는 읽을 수 있다 → null 유지(모름) */ }
    }
  }
  // ⚠ 연결 확인은 **하지 않는다.** opencode 엔 `mcp get`(우리 서버 하나만 보기)이 없고 `mcp list` 뿐인데,
  //  그건 ① 등록된 **모든** MCP 를 실제로 연결하고(#1431 에서 claude 쪽으로 이미 겪은 비용) ② opencode 를
  //  띄우는 순간 **설정 디렉터리를 만든다**(plugin/·package.json·node_modules). 즉 진단이 상태를 바꾼다.
  //  실측: 이 호출 때문에 `lively status` 를 돌리는 테스트들이 XDG 경로를 오염시켰다.
  //  → 등록 여부는 위에서 **설정 파일을 읽어** 확정하고, 연결은 `null`(모름)로 둔다. 모르는 걸 아는 척하지
  //   않는 게 이 화면의 규칙이고(codex 의 enabled 를 null 로 둔 것과 같은 이유), 부작용 없는 진단이 우선이다.
  // antigravity — 배선·MCP 전부 **우리 플러그인 파일**에서 읽는다(파일 읽기라 비용 0 · 부작용 0).
  //  연결 확인은 하지 않는다: agy 를 띄우는 프로브는 설정 트리를 만들고(진단이 상태를 바꿈, #1689 실측)
  //  모델 세션 없이는 MCP 를 안 붙인다 → null(모름)로 둔다.
  {
    const ag = st.harness.antigravity;
    // 훅 배선은 글로벌 hooks.json 의 "lively" 키다(#1689 — 플러그인 훅은 CLI 가 안 읽는다).
    const hooksJson = join(HOME, ".gemini", "config", "hooks.json");
    const mcpJson = join(AGY_PLUGIN_DIR, "mcp_config.json");
    try { ag.wired = !!(JSON.parse(readFileSync(hooksJson, "utf8")) || {}).lively; } catch { /* 없음/파싱실패 → 미배선 */ }
    if (!existsSync(AGY_PLUGIN_DIR)) { ag.mcp = false; }   // 플러그인 자체가 없다 = 배선한 적 없다(확정)
    else {
      let ok = true;
      try { if (existsSync(hooksJson)) JSON.parse(readFileSync(hooksJson, "utf8")); } catch { ok = false; }
      try {
        if (existsSync(mcpJson)) {
          const mc = JSON.parse(readFileSync(mcpJson, "utf8"));
          ag.mcp = !!(mc && mc.mcpServers && mc.mcpServers.lively);
          ag.transport = ag.mcp ? "stdio" : null;
        } else ag.mcp = false;
      } catch { ok = false; ag.mcp = null; }               // 파일은 있는데 못 읽음 — 모름으로 둔다
      ag.configOk = ok;
    }
  }
  // grok(#1701) — 배선·config 유효·MCP 등록 전부 **파일**에서 읽는다(비용 0 · 부작용 0).
  //  ⚠ 연결(mcpConnected)은 확인하지 않는다 — `grok mcp doctor --json` 이 있지만 실행 비용이 미지수이고,
  //   grok 은 **어떤 호출이든** 설정 트리(docs/·active_sessions)를 만든다(진단이 상태를 바꿈 — opencode 에서
  //   이미 겪은 함정). 런북 규칙대로 모르는 건 null 물음표로 둔다 — pass/fail 로 단정하지 않는다.
  {
    const gk = st.harness.grok;
    // 배선 신호 = 우리 소유 훅 파일의 존재. configOk = 그 파일이 JSON 으로 파싱되는가 — grok 은 깨진 훅 파일을
    //  조용히 건너뛰므로(fail-open) 파싱 실패 = 우리 훅이 통째로 소리 없이 빠진 상태다.
    //  ⚠ config.toml 전체의 TOML 유효성은 여기 안 싣는다 — 값싼 파서가 없고(codex 는 `codex mcp get` 으로
    //   파서에게 직접 물었지만 grok 프로브는 위 부작용 때문에 금지) 모르는 축은 만들지 않는다.
    try { gk.wired = existsSync(GROK_HOOKS_JSON); } catch { /* */ }
    if (gk.wired) {
      try { JSON.parse(readFileSync(GROK_HOOKS_JSON, "utf8")); gk.configOk = true; }
      catch { gk.configOk = false; }                       // 파일은 있는데 JSON 이 깨짐 — 훅만 조용히 죽은 상태
    }
    // MCP 등록 = 사용자 config.toml 에 우리 센티넬 블록 + [mcp_servers.lively] 가 있다(설치기가 심는 유일한 형태).
    const grokToml = join(GROK_DIR, "config.toml");
    try {
      if (!existsSync(grokToml)) gk.mcp = false;           // 파일 자체가 없다 = 배선한 적 없다(확정)
      else {
        const t = readFileSync(grokToml, "utf8");
        gk.mcp = t.includes("lively-managed") && t.includes("[mcp_servers.lively]");
        gk.transport = gk.mcp ? "stdio" : null;            // command 형(stdio 프록시)만 설치한다 — 등록됐으면 stdio
      }
    } catch { /* 파일은 있는데 못 읽음 — null 유지(모름) */ }
  }
  if (!gw) { st.gateway.error = "게이트웨이 미설정"; return st; }
  if (!tok) { st.gateway.error = "로그인 필요"; return st; }
  try {
    const rc = await api("/api/ui/org/runtime-config", { timeoutMs: 8000 });
    st.gateway.reachable = true;
    st.account.authenticated = true;
    st.kit.remote = typeof rc?.kit_version === "string" ? rc.kit_version : null;
    st.kit.current = !!(st.kit.remote && st.kit.local && st.kit.remote === st.kit.local);
    st.kit.autoUpdate = rc?.hooks?.self_update !== false;
    try {
      const me = await api("/api/ui/me/profile", { timeoutMs: 8000 });
      st.account.id = me?.id ?? null;
      st.account.name = me?.display_name ?? null;
    } catch { /* 프로필은 부가 정보 — 실패해도 상태는 유효 */ }
    // 조직 자산이 이 머신에 **실제로 깔렸나**(#1475). 서버가 주는 수 ↔ 로컬 매니페스트(우리가 심은 것)의 수를 맞댄다.
    //  왜 필요한가: 2026-08-04 윈도우 실기기에서 서버는 26개를 주고 그 머신은 0개였는데, **그 사실을 보여주는 표면이
    //   어디에도 없었다** — 훅은 "5/5 ✓", 하네스는 "✓ 배선"이라 전부 초록불이었고 사용자가 스킬을 못 찾고서야 드러났다.
    //   (자산 sync 는 실패해도 조용하다 — 세션을 막지 않는 게 설계라서. 그래서 '조용한 실패'가 기본값이다.)
    //  로컬 0 / 서버 N 이면 그 머신에서 materialize 가 한 번도 성공한 적 없다는 뜻이고, 그게 곧 신고 전에 잡을 신호다.
    const manifest = (() => { try { return JSON.parse(readFileSync(join(LIVELY, "managed-harness-assets.json"), "utf8")) || {}; } catch { return {}; } })();
    for (const h of ["claude", "codex", "opencode", "antigravity", "grok"]) {   // #1701 — grok 도 같은 자산 축
      if (!st.harness[h].installed) continue;               // 안 깔린 하네스는 물어볼 것도 없다
      try {
        const r = await api(`/api/ui/org/runner/assets?harness=${h}`, { timeoutMs: 8000 });
        const server = Array.isArray(r?.assets) ? r.assets.length : null;
        if (server === null) continue;
        const local = Object.keys((manifest[h] && typeof manifest[h] === "object") ? manifest[h] : {}).length;
        st.harness[h].assets = { local, server };
      } catch { /* 자산 조회 실패는 부가 정보 — 상태 전체를 죽이지 않는다 */ }
    }
  } catch (e) { st.gateway.error = e.message; }
  return st;
}

// ── 프로젝트 섹션(#905 C5a) — cwd 가 프로젝트일 때만 붙는다(아니면 null → 렌더 자체가 없음). ──
//  왜 `lively status` 안인가: `status` 는 인자 없는 `lively` 의 **기본 명령**이라 사람이 실제로 치는 유일한 표면이다.
//   별도 하위명령을 만들면 아무도 안 친다 — `work.mjs --status`(같은 내용)가 호출자 0인 게 그 증거다.
//  ⚠ 이 섹션의 진짜 값어치 = **sync 모드를 사람 눈에 보이게 하는 것**(#905 P1-②). 마커의 sync 는 "이 폴더에
//   서버 공유파일을 써도 되는가"를 정하는데, 지금까지 그걸 볼 수 있는 표면이 **어디에도 없었다**. 안 보이는 게이트는
//   틀렸을 때 아무도 모른다.
async function gatherProjectStatus(cwd, reachable = true) {
  const { findProjectMarkerUp, markerSyncMode } = await import(new URL("./repo-worktree-core.mjs", import.meta.url));
  const found = findProjectMarkerUp(cwd);
  if (!found) return null;
  const p = {
    id: found.meta.project_id,
    name: null,
    dir: found.dir,
    sync: markerSyncMode(found.meta),           // null = 구 마커(훅이 폴더 소유권으로 판정)
    last_pull: Number(found.meta.last_pull) || 0,
    shared: null,                                // {server_newest, server_count, pending, truncated} — 조회 실패 시 null
    error: null,
  };
  // ⚠ 게이트웨이가 이미 '미도달'로 판정났으면 서버 왕복(프로젝트명·매니페스트)은 똑같이 타임아웃만 쌓는다(#1043 —
  //  미도달 시 8초짜리 futile 호출 2회가 status 를 20초+로 늘렸다). 도달을 아는 마당에 다시 찔러보지 않고 로컬 마커만 렌더.
  if (!reachable) { p.error = "게이트웨이 미도달"; }
  else {
  try { p.name = (await api(`/api/ui/v6/projects/${p.id}`, { timeoutMs: 8000 }))?.project?.name ?? null; }
  catch (e) { p.error = e.message; }
  // 공유폴더 상태 — sync 가 none 이면 애초에 안 받으므로 조회하지 않는다(불필요한 왕복 + 오해 소지).
  if (p.sync !== "none") {
    try {
      const m = await api(`/api/ui/v6/projects/${p.id}/shared/manifest`, { timeoutMs: 8000 });
      const files = Array.isArray(m.files) ? m.files : [];
      let pending = 0;
      for (const f of files) {
        const dest = join(p.dir, f.path);
        if (relative(p.dir, dest).startsWith("..")) continue;   // 경로 탈출 방어(work.mjs 동형)
        try { const s = statSync(dest); if (s.size === f.size && Math.floor(s.mtimeMs) >= f.mtime) continue; } catch { /* 로컬 없음 → pending */ }
        pending++;
      }
      p.shared = { server_newest: m.newest || 0, server_count: typeof m.count === "number" ? m.count : files.length, pending, truncated: !!m.truncated };
    } catch (e) { p.error = p.error || e.message; }
  }
  } // end else(reachable) — 위 두 서버 왕복은 게이트웨이 도달 시에만
  // up-sync 결과(#905 C3) — 자동 up 은 확인할 사람이 없어(수동 업로드의 #877 confirm 과 다름) **기록이 유일한 표면**이다.
  //  충돌이 조용히 쌓이면 "왜 내 변경이 안 올라갔지"를 아무도 모른다. host-local(dotfile — 동기화 안 됨).
  try { p.up = JSON.parse(readFileSync(join(p.dir, ".lively", "sync-up.json"), "utf8")); } catch { p.up = null; }
  return p;
}

function renderProjectStatus(p) {
  const iso = (ms) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : dim("없음"));
  say(`  프로젝트      ${bold("#" + p.id)}${p.name ? " " + p.name : dim(" (이름 조회 실패)")}`);
  say(`    폴더        ${p.dir}`);
  if (p.sync === "none") {
    // 사용자 자기 폴더의 기본값 — '안 받는 게 정상'임을 분명히 한다(고장으로 오해하지 않게).
    say(`    공유폴더    ${dim("동기화 안 함")} ${dim("(sync=none — 이 폴더엔 서버 파일을 내려받지 않습니다)")}`);
    say(`                ${dim("받으려면 " + p.dir + "/.lively/project.json 의 sync 를 \"pull\" 로.")}`);
  } else if (!p.shared) {
    say(`    공유폴더    ${yellow("상태 조회 실패")} ${dim(p.error || "")}`);
  } else {
    // ⚠ sync 가 없는 구 마커는 **모드를 단정하지 않는다.** 그때 pull 훅은 폴더 위치로 fail-safe 판정하는데
    //  (라이블리가 만든 폴더면 pull, 그 밖은 none), 그 판정을 여기서 흉내내면 예측이 어긋나는 순간 이 화면이
    //  거짓말을 한다 — 게이트를 보여주려고 만든 표면이 게이트를 오도하는 건 최악이다. 모르면 모른다고 쓴다.
    const known = p.sync !== null;
    say(`    공유폴더    ${known ? p.sync : yellow("미명시(구 마커)")} · 서버 ${p.shared.server_count}개 파일 · 마지막 pull ${iso(p.last_pull)}`
      + (p.shared.truncated ? "  " + yellow("⚠ 서버 목록 상한 도달(일부 누락 가능)") : ""));
    if (!known) {
      say(`                ${dim("이 폴더가 받을지는 pull 훅이 폴더 위치로 판정합니다(라이블리가 만든 폴더면 받고, 그 밖은 안 받음).")}`);
      say(`                ${dim("확실히 하려면 .lively/project.json 에 sync 를 \"pull\" 또는 \"none\" 으로 명시하세요.")}`);
    }
    const willPull = known && (p.sync === "pull" || p.sync === "both");
    say(`    로컬 미반영  ${p.shared.pending
      ? yellow(`${p.shared.pending} 파일`) + (willPull ? dim("  → 세션을 새로 시작하면 자동으로 받습니다") : "")
      : green("없음(최신)")}`);
  }
  // ↑up(sync=both) 결과 — 특히 **충돌은 반드시 보인다**(자동 up 은 물어볼 사람이 없어 여기가 유일한 표면).
  if (p.up) {
    const c = (p.up.conflicts || []).length;
    // 삭제는 되돌리기 어려우니(중앙 공유문서가 사라진다) 0건이 아니면 **항상 보인다** — 올린 개수 뒤에 묻히면 안 된다.
    say(`    올린 변경    ${p.up.pushed || 0}개${p.up.deleted ? yellow(` · 서버에서 삭제 ${p.up.deleted}개`) : ""}`
      + `${p.up.remaining ? dim(` · ${p.up.remaining}개 다음 턴으로`) : ""}`
      + `${p.up.failed ? yellow(` · 실패 ${p.up.failed}(다음 턴 재시도)`) : ""}`
      + (c ? "  " + red(`⚠ 충돌 ${c}개 — 안 올림`) : ""));
    for (const x of (p.up.conflicts || []).slice(0, 5)) {
      say(`      ${red("✗")} ${x.path} ${dim("— " + x.why)}`);
    }
    // 충돌은 **사람만 풀 수 있다**(양쪽 다 바뀌어서 안 올린 것이다). 그래서 여기서 '되는 절차'를 준다.
    //  ⚠ 실행할 수 없는 지시를 쓰면 안 된다 — 강제 pull 명령 같은 건 없다. 실제로 동작하는 건 이 순서다:
    //   내 파일 이름을 바꾸면 ① 원래 경로가 비므로 다음 pull 이 서버본을 내려주고 ② 바뀐 이름은 새 문서라 올라간다
    //   → 두 본을 나란히 놓고 합친 뒤, 사본을 지우면 그 삭제가 서버에도 전파된다.
    if (c) {
      say(`                ${dim("충돌은 양쪽 다 바뀐 것 — 자동으로 못 합칩니다. 로컬본을 덮으면 남의 작업이 사라집니다.")}`);
      say(`                ${dim("푸는 법: `mv <파일> <파일>.mine` → 다음 턴에 서버본이 내려옵니다 → 합친 뒤 .mine 삭제.")}`);
    }
  }
}

async function cmdStatus(opts) {
  const st = await gatherStatus();
  st.project = await gatherProjectStatus(process.cwd(), st.gateway.reachable).catch(() => null); // 프로젝트 섹션은 부가 — 실패해도 status 는 유효(미도달이면 서버 왕복 스킵, #1043)
  if (opts.json) { jsonOut(st); return; }
  const mark = (b) => (b ? green("✓") : dim("–"));
  say(`\n${bold("라이블리")} ${dim("CLI " + st.cli)}\n`);
  say(`  게이트웨이    ${st.gateway.url || dim("(미설정)")}  ${st.gateway.reachable ? green("도달 OK") : red(st.gateway.error || "도달 실패")}`);
  say(`  계정          ${st.account.authenticated ? (st.account.name || st.account.id || "인증됨") : dim("미인증")}`);
  if (st.kit.remote || st.kit.local) {
    say(`  키트 버전     ${st.kit.current ? green(`${st.kit.local} (최신)`)
      : st.kit.remote ? yellow(`${st.kit.local || "(미설치)"} → ${st.kit.remote} 업데이트 있음`)
        : String(st.kit.local)}`);
  }
  say(`  훅            ${st.hooks.installed}/${st.hooks.expected} ${mark(st.hooks.installed === st.hooks.expected)}`);
  // 연결(#1431)은 **등록됐을 때만** 뜻이 있다. 확인 못 했으면(구버전 claude 등) 물음표로 — 모르는 걸 아는 척하지 않는다.
  const connOf = (h) => !h.mcp ? "" : h.mcpConnected === null ? `   ${dim("? 연결")}` : `   ${h.mcpConnected ? green("✓") : yellow("✘")} 연결`;
  // 자산은 **개수가 곧 진단**이다 — 0/26 이면 그 머신에서 materialize 가 한 번도 성공한 적 없다는 뜻(#1475).
  const assetsOf = (h) => !h.assets ? "" : `   자산 ${h.assets.local === h.assets.server ? green(`${h.assets.local}/${h.assets.server}`) : yellow(`${h.assets.local}/${h.assets.server}`)}`;
  say(`  claude        ${mark(st.harness.claude.installed)} 설치   ${mark(st.harness.claude.wired)} 배선   ${mark(st.harness.claude.mcp)} MCP 등록${connOf(st.harness.claude)}${assetsOf(st.harness.claude)}`);
  // ★ '어딘가 등록됨' 을 통과로 쓰지 않는다 — 웹터미널 세션은 프로필 dir 을 읽으므로, 거기 없으면 세션엔 안 보인다.
  //  그 상태가 초록불로 보이던 게 실기기 오진의 원인이었다. 빠진 곳을 이름으로 말하고, 고치는 한 줄까지 준다.
  if (Array.isArray(st.harness.claude.mcpMissing) && st.harness.claude.mcpMissing.length) {
    say(`                ${yellow("✘")} MCP 미등록: ${st.harness.claude.mcpMissing.join(" · ")} ${dim("— 이 위치로 뜨는 세션엔 lively 툴이 안 보입니다")}`);
    say(`                ${dim("고치기: lively update")}`);
  }
  // codex 는 '배선' 자리에 **config 유효성**을 함께 싣는다 — 우리 블록이 있어도 파일이 파싱 안 되면 codex 는 아예 안 뜬다.
  const cx = st.harness.codex;
  const cxWired = cx.configOk === false ? `${red("✘")} 배선 ${red("(config.toml 을 codex 가 못 읽음)")}` : `${mark(cx.wired)} 배선`;
  // mcp === null 은 '판정 못 함'이다(코덱스 세션 *안*에서 돌리면 `codex mcp get` 이 실패한다) — `–` 로 뭉개면
  //  미등록과 구별이 안 돼 "lively update" 헛다리 조치를 부른다. 물음표로 모른다고 적는다('? 연결'과 같은 원칙).
  const cxMcp = cx.installed && cx.configOk !== false
    ? (cx.mcp === null ? `   ${dim("? MCP 등록")}` : `   ${mark(cx.mcp)} MCP 등록${cx.mcp && cx.transport ? dim(`(${cx.transport})`) : ""}`) : "";
  say(`  codex         ${mark(cx.installed)} 설치   ${cxWired}${cxMcp}${connOf(cx)}${assetsOf(cx)}`);
  // opencode — codex 와 같은 형태. 배선 신호는 플러그인 어댑터 파일이다.
  //  ⚠ 자산 수에 `~/.claude/skills` 자동 로드분은 안 잡힌다(#1519 결정: 스킬 격리 안 함) — 그 사실을 아래 안내에 담는다.
  const oc = st.harness.opencode;
  if (oc.installed || oc.wired) {
    const ocWired = oc.configOk === false ? `${red("✘")} 배선 ${red("(opencode.json 을 opencode 가 못 읽음)")}` : `${mark(oc.wired)} 배선`;
    // codex 와 같은 원칙 — null(판정 못 함)을 `–` 로 뭉개면 미등록과 구별이 안 된다.
    const ocMcp = oc.configOk !== false
      ? (oc.mcp === null ? `   ${dim("? MCP 등록")}` : `   ${mark(oc.mcp)} MCP 등록${oc.mcp && oc.transport ? dim(`(${oc.transport})`) : ""}`)
      : "";
    say(`  opencode      ${mark(oc.installed)} 설치   ${ocWired}${ocMcp}${connOf(oc)}${assetsOf(oc)}`);
  }
  // antigravity — 같은 형태(#1689). 배선 신호는 플러그인 hooks.json, configOk 는 우리 플러그인 JSON 파싱.
  const ag = st.harness.antigravity;
  if (ag.installed || ag.wired) {
    const agWired = ag.configOk === false ? `${red("✘")} 배선 ${red("(플러그인 JSON 이 깨짐 — 그 기능만 조용히 빠집니다)")}` : `${mark(ag.wired)} 배선`;
    const agMcp = ag.configOk !== false
      ? (ag.mcp === null ? `   ${dim("? MCP 등록")}` : `   ${mark(ag.mcp)} MCP 등록${ag.mcp && ag.transport ? dim(`(${ag.transport})`) : ""}`)
      : "";
    say(`  antigravity   ${mark(ag.installed)} 설치   ${agWired}${agMcp}${connOf(ag)}${assetsOf(ag)}`);
  }
  // grok — 같은 형태(#1701). 배선 신호는 우리 소유 훅 파일(lively-grok.json), configOk 는 그 JSON 파싱.
  const gk = st.harness.grok;
  if (gk.installed || gk.wired) {
    const gkWired = gk.configOk === false ? `${red("✘")} 배선 ${red("(lively-grok.json 이 깨짐 — 우리 훅만 조용히 빠집니다)")}` : `${mark(gk.wired)} 배선`;
    const gkMcp = gk.configOk !== false
      ? (gk.mcp === null ? `   ${dim("? MCP 등록")}` : `   ${mark(gk.mcp)} MCP 등록${gk.mcp && gk.transport ? dim(`(${gk.transport})`) : ""}`)
      : "";
    say(`  grok          ${mark(gk.installed)} 설치   ${gkWired}${gkMcp}${connOf(gk)}${assetsOf(gk)}`);
  }
  if (st.kit.autoUpdate !== null) say(`  자동 업데이트 ${st.kit.autoUpdate ? green("켜짐") : yellow("꺼짐")}`);
  // 노드(#1541 T4) — **등록됐을 때만** 뜻이 있다. 실행 여부를 못 재면 `?` 로 적는다(모르는 걸 '정지' 로 쓰면 거짓말).
  if (st.node?.registered) {
    const run = st.node.running === null ? dim("? 실행") : st.node.running ? green("✓ 실행 중") : yellow("정지됨");
    say(`  노드          ${st.node.id || dim("(id 미상)")}   ${run}   ${st.node.daemon ? green("✓ 자동 시작") : dim("– 자동 시작")}`);
    // #1849 — 잠자기로 끊기는 중이면 여기서 말한다. 프로세스가 '실행 중' 이어도 자는 PC 는 세션을 못 연다.
    if (st.node.sleep?.note) say(`                ${yellow("⚠ " + st.node.sleep.note)}`);
  }
  if (st.project) { say(""); renderProjectStatus(st.project); }
  say("");
  if (!st.account.authenticated) say(dim("  → ") + bold("lively login") + dim(" 으로 시작하세요."));
  else if (st.kit.remote && !st.kit.current) say(dim("  → ") + bold("lively update") + dim(" 로 최신화할 수 있습니다."));
  else if (st.harness.codex.configOk === false) say(dim("  → codex 가 config.toml 을 못 읽습니다(그 파일의 MCP·훅이 전부 무효): ") + bold("lively update"));
  else if (st.harness.opencode.configOk === false) say(dim("  → opencode 가 opencode.json 을 못 읽습니다(그 파일의 MCP·플러그인이 전부 무효): ") + bold("lively update"));
  else if (st.harness.antigravity.configOk === false) say(dim("  → antigravity 플러그인 JSON 이 깨졌습니다(그 파일의 훅/MCP 만 조용히 빠짐): ") + bold("lively update"));
  else if (st.harness.grok.configOk === false) say(dim("  → grok 훅 파일(lively-grok.json)이 깨졌습니다(우리 훅만 조용히 빠짐): ") + bold("lively update"));
  else if (st.harness.claude.installed && !st.harness.claude.mcp) say(dim("  → MCP 등록이 안 돼 있습니다: ") + bold("lively update"));
  else {
    // 자산은 설치기가 아니라 **세션 시작 훅**이 내린다 — 업데이트만 하고 세션을 안 켜면 0 인 채로 남는다.
    const short = ["claude", "codex", "opencode", "antigravity", "grok"].filter((h) => st.harness[h].assets && st.harness[h].assets.local < st.harness[h].assets.server); // #1701 — grok 포함
    if (short.length) say(dim("  → 조직 자산이 덜 깔렸습니다(") + short.join("·") + dim("). 새 세션을 한 번 켜면 내려옵니다 — 그래도 그대로면 ") + bold("lively doctor"));
    // ⚠ 진단이 거짓말하지 않게 — opencode 는 `~/.claude/skills` 를 **자동으로도** 읽는다(#1519 결정: 스킬 격리 안 함).
    //  위 수치는 우리가 심은 매니페스트만 센 것이라, opencode 세션에서 실제로 보이는 스킬은 이보다 많을 수 있다.
    //  이 한 줄이 없으면 "opencode 자산 0/26" 을 보고 고장으로 오해한다(실제로는 claude 쪽에서 전부 보인다).
    if (st.harness.opencode.assets && st.harness.opencode.installed) {
      say(dim("     (opencode 는 ~/.claude/skills 도 함께 읽습니다 — 위 수치는 opencode 전용 자리에 심은 것만 셉니다)"));
    }
  }
}

async function cmdDoctor(opts) {
  const st = await gatherStatus();
  const checks = [];
  const chk = (name, pass, detail, fix) => checks.push({ name, pass, detail, fix: fix || null });

  // 버전만이 아니라 **어느 런타임에서 도는지**를 말한다 — #1068 이 정확히 그 축에서 터졌고(시스템 구버전 node),
  //  전용 런타임이 실제로 쓰이고 있는지는 여기 말고는 확인할 데가 없다.
  chk("Node", true, `${process.version}  ${process.execPath.startsWith(join(LIVELY, "runtime")) ? "(라이블리 전용 런타임)" : "(시스템 node)"}`);
  chk("게이트웨이 설정", !!st.gateway.url, st.gateway.url || "~/.lively/gateway-url 없음", "lively login --gateway <url>");
  chk("게이트웨이 도달", st.gateway.reachable, st.gateway.reachable ? "OK" : (st.gateway.error || "실패"), "주소 · 네트워크 · VPN 확인");
  // 토큰의 **출처**를 사실대로 말한다 — 옛 코드는 출처와 무관하게 "~/.lively/token 있음"을 찍어서,
  //  파일이 없는데(로그아웃 직후 등) env 폴백으로 인증되는 상태를 "파일 있음"으로 거짓 보고했다.
  const tokFile = readLively("token");
  chk("토큰", !!token(), tokFile ? "~/.lively/token" : (token() ? "LIVELY_TOKEN 환경변수 (파일 없음)" : "없음"), "lively login");
  chk("토큰 유효", st.account.authenticated, st.account.authenticated ? (st.account.name || st.account.id || "인증됨") : "미인증", "lively login");
  // #916 — 이 셸의 env 가 파일과 다르면 **codex 와 이미 떠 있는 세션은 옛 신원으로** 게이트웨이에 붙는다.
  //  CLI 는 파일을 정본으로 쓰므로 위 두 줄은 멀쩡해 보이는데, 그 상태가 정확히 #916 이었다.
  //  진단이 이걸 안 보여줘서 그때는 /api/ui/me 를 손으로 찔러보고서야 잡혔다 → 도구화한다. ⚠ 값은 안 찍는다(사실만).
  if (ENV_TOKEN_AT_START && tokFile) {
    const same = ENV_TOKEN_AT_START === tokFile;
    chk("신원 일치(이 셸 env ↔ 파일)", same,
      same ? "일치" : "이 셸의 LIVELY_TOKEN 이 ~/.lively/token 과 다릅니다 — codex 는 옛 신원으로 붙습니다",
      RELOAD_SHELL_HINT);
  }
  chk("Claude Code", st.harness.claude.installed, st.harness.claude.installed ? "PATH 에 있음" : "미설치 또는 PATH 밖", "curl -fsSL https://claude.ai/install.sh | bash");
  chk("훅 파일", st.hooks.installed === st.hooks.expected, `${st.hooks.installed}/${st.hooks.expected} (~/.lively/hooks)`, "lively install");
  chk("Claude 훅 배선", st.harness.claude.wired, st.harness.claude.wired ? "settings.json OK" : "미배선", "lively install");
  if (st.harness.claude.installed) chk("Claude MCP 등록", st.harness.claude.mcp, st.harness.claude.mcp ? "lively 등록됨" : "미등록", "lively update");
  // #1431 — 등록과 별개로 **지금 붙는가**. VPN 끊김·게이트웨이 다운·프록시 파손은 등록이 멀쩡해도 여기서 ✘ 로 뜬다.
  //  null(확인 못 함)이면 체크 자체를 만들지 않는다 — 모르는 것을 pass/fail 로 단정하면 진단이 거짓말을 한다.
  if (st.harness.claude.mcp && st.harness.claude.mcpConnected !== null) {
    chk("Claude MCP 연결", st.harness.claude.mcpConnected,
      st.harness.claude.mcpConnected ? "lively 연결됨" : "등록은 됐지만 연결 실패 — 게이트웨이 도달·VPN·프록시 확인",
      "lively doctor 후 게이트웨이 도달 여부(위 줄) 확인");
  }
  if (st.harness.codex.installed) {
    chk("Codex 배선", st.harness.codex.wired, st.harness.codex.wired ? "config.toml 에 관리 블록 있음" : "미배선", "lively install");
    // ⚠ '배선됨'과 '동작함'은 다르다 — TOML 은 한 줄의 문법 오류가 파일 전체를 무효화한다. 2026-08-04 윈도우 사고에서
    //  우리 블록은 멀쩡히 있는데 codex 는 아예 안 떴고, 그때 진단은 전부 초록불이었다. 그래서 파서에게 직접 묻는다.
    if (st.harness.codex.configOk !== null) {
      chk("Codex config 유효", st.harness.codex.configOk,
        st.harness.codex.configOk ? "codex 가 읽음" : "codex 가 config.toml 을 못 읽습니다 — 그 파일의 MCP·훅이 전부 무효입니다",
        "lively update  (설치기가 깨진 줄을 복구합니다)");
    }
    // ⚠ mcp === null 은 **판정 못 함**이지 미등록이 아니다 — 코덱스 세션 *안에서* doctor 를 돌리면
    //  `codex mcp get` 이 실패해(자기 자신이 그 셸 PATH 에 없다) 종전엔 "미등록"으로 떨어졌다. 같은 머신
    //  PowerShell 직접 실행은 정상 등록으로 나온다 — 모르는 것을 문제로 보고하면 헛다리 조치가 나온다.
    if (st.harness.codex.configOk !== false && st.harness.codex.mcp !== null) {
      chk("Codex MCP 등록", st.harness.codex.mcp,
        st.harness.codex.mcp ? `lively 등록됨${st.harness.codex.transport ? ` (${st.harness.codex.transport})` : ""}` : "미등록", "lively update");
    }
  }
  // opencode — codex 와 같은 3축(배선·config 유효·MCP 등록). 배선 신호는 플러그인 어댑터 파일이다.
  if (st.harness.opencode.installed || st.harness.opencode.wired) {
    chk("OpenCode 배선", st.harness.opencode.wired,
      st.harness.opencode.wired ? "plugin/lively.js 있음" : "어댑터 미설치 — 훅이 하나도 안 돕니다", "lively install");
    if (st.harness.opencode.configOk !== null) {
      chk("OpenCode config 유효", st.harness.opencode.configOk,
        st.harness.opencode.configOk ? "opencode 가 읽음" : "opencode 가 opencode.json 을 못 읽습니다 — 그 파일의 MCP·플러그인이 전부 무효입니다",
        "lively update");
    }
    if (st.harness.opencode.configOk !== false && st.harness.opencode.mcp !== null) {
      chk("OpenCode MCP 등록", st.harness.opencode.mcp,
        st.harness.opencode.mcp ? `lively 등록됨${st.harness.opencode.transport ? ` (${st.harness.opencode.transport})` : ""}` : "미등록", "lively update");
      if (st.harness.opencode.mcp && st.harness.opencode.mcpConnected !== null) {
        chk("OpenCode MCP 연결", st.harness.opencode.mcpConnected,
          st.harness.opencode.mcpConnected ? "lively 연결됨" : "등록은 됐지만 연결 실패 — 게이트웨이 도달·VPN·프록시 확인", "lively doctor");
      }
    }
  }
  // antigravity(#1689) — 배선(플러그인 hooks.json)·config 유효(우리 플러그인 JSON 파싱)·MCP 등록(mcp_config.json).
  if (st.harness.antigravity.installed || st.harness.antigravity.wired) {
    chk("Antigravity 배선", st.harness.antigravity.wired,
      st.harness.antigravity.wired ? "hooks.json 에 lively 훅 있음" : "훅 미배선 — 훅이 하나도 안 돕니다", "lively install");
    if (st.harness.antigravity.configOk !== null) {
      chk("Antigravity config 유효", st.harness.antigravity.configOk,
        st.harness.antigravity.configOk ? "플러그인 JSON 읽힘" : "플러그인 JSON 이 깨졌습니다 — 깨진 파일의 훅/MCP 만 조용히 빠집니다(fail-open)",
        "lively update");
    }
    if (st.harness.antigravity.configOk !== false && st.harness.antigravity.mcp !== null) {
      chk("Antigravity MCP 등록", st.harness.antigravity.mcp,
        st.harness.antigravity.mcp ? `lively 등록됨${st.harness.antigravity.transport ? ` (${st.harness.antigravity.transport})` : ""}` : "미등록", "lively update");
    }
  }
  // grok(#1701) — 배선(우리 훅 파일 lively-grok.json)·config 유효(그 JSON 파싱)·MCP 등록(config.toml 센티넬).
  //  연결(mcpConnected)은 항상 null 이라 체크를 만들지 않는다 — `grok mcp doctor --json` 이 있지만 실행 비용이
  //  미지수이고 grok 은 어떤 호출이든 설정 트리를 만든다(진단이 상태를 바꿈). 모르는 걸 pass/fail 로 단정하지 않는다.
  if (st.harness.grok.installed || st.harness.grok.wired) {
    chk("Grok Build 배선", st.harness.grok.wired,
      st.harness.grok.wired ? "hooks/lively-grok.json 있음" : "훅 미배선 — 훅이 하나도 안 돕니다", "lively install");
    if (st.harness.grok.configOk !== null) {
      chk("Grok Build config 유효", st.harness.grok.configOk,
        st.harness.grok.configOk ? "훅 JSON 읽힘" : "lively-grok.json 이 깨졌습니다 — grok 이 조용히 건너뛰어 우리 훅만 빠집니다(fail-open)",
        "lively update");
    }
    if (st.harness.grok.configOk !== false && st.harness.grok.mcp !== null) {
      chk("Grok Build MCP 등록", st.harness.grok.mcp,
        st.harness.grok.mcp ? `lively 등록됨${st.harness.grok.transport ? ` (${st.harness.grok.transport})` : ""}` : "미등록", "lively update");
    }
  }
  // 조직 자산이 이 머신에 실제로 깔렸나(#1475) — 서버가 주는 수 ↔ 우리가 심은 수. 어긋나면 신고 전에 여기서 드러난다.
  //  ⚠ 자산은 설치기가 아니라 **세션 시작 훅**이 내린다 → 업데이트 직후엔 정상적으로 어긋날 수 있다(해결 문구에 그 사실을 담는다).
  for (const h of ["claude", "codex", "opencode", "antigravity", "grok"]) {   // #1689 — opencode 도 종전 누락분 보강 · #1701 — grok
    const a = st.harness[h].assets;
    if (!a) continue;
    chk(`조직 자산(${h})`, a.local >= a.server, `${a.local}/${a.server} 설치됨`,
      "새 세션을 한 번 켜세요(세션 시작 훅이 내려받습니다). 그래도 0 이면 배선·권한 문제입니다");
  }
  if (st.kit.remote) chk("키트 최신", st.kit.current, st.kit.current ? String(st.kit.local) : `${st.kit.local || "(미설치)"} → ${st.kit.remote}`, "lively update");
  // 새 터미널에서 `lively` 가 잡히는지 — rc 배선이 안 됐으면 다음 창에서 못 찾는다.
  chk("lively PATH", has("lively"), has("lively") ? "OK" : "현 셸의 PATH 밖", RELOAD_SHELL_HINT);

  if (opts.json) { jsonOut({ status: st, checks }); return; }
  say(`\n${bold("라이블리 진단")}\n`);
  const w = Math.max(...checks.map((x) => cols(x.name)));
  for (const x of checks) {
    const pad = " ".repeat(Math.max(0, w - cols(x.name)));
    say(`  ${x.pass ? green("✓") : red("✗")} ${x.name}${pad}   ${x.pass ? dim(x.detail) : x.detail}`);
    if (!x.pass && x.fix) say(`    ${dim("→ 해결: ")}${bold(x.fix)}`);
  }
  const bad = checks.filter((x) => !x.pass);
  say("");
  if (!bad.length) say(green("  모두 정상입니다."));
  else { say(yellow(`  ${bad.length}건 문제 — 위 '해결' 을 순서대로 실행하세요.`)); process.exitCode = 1; }
}

// ── selfcheck (#1505) — **AI 가 자기 세션과 대조할 사실**만 뽑아 준다. 판정은 AI 가 한다. ──
//  왜 CLI 인가: 이 로직을 사용가이드의 복붙 프롬프트에 코드로 실어 뒀더니 **LLM 이 50줄을 손으로 옮겨 적다
//   대괄호를 빠뜨려** 매 실행 결과가 달라졌다(실측). 더 나쁜 건 그 전사 오류를 '확인불가'로 보고해 라이블리
//   문제처럼 보이게 만든 것이다. 코드는 여기 두고 프롬프트는 `lively selfcheck` 한 줄만 부른다.
//  ⚠ 여기 담는 것은 **로컬 파일을 읽어야 아는 사실**뿐이다. 신원(whoami)·검색 동작·세션에 실제 노출된 스킬·
//   주입된 맥락은 MCP 와 AI 자기관측으로 얻으므로 **셸 없는 환경(웹·앱에서 MCP 만 연결)에서도** 점검이 성립한다.
//   그 경계를 지켜야 점검이 하네스를 안 가린다.
async function cmdSelfcheck(opts) {
  const out = {};
  let man = {}; try { man = JSON.parse(readFileSync(join(LIVELY, "managed-harness-assets.json"), "utf8")); } catch { /* 없으면 빈 것 */ }
  const hs = Object.keys(man);
  out.kit = readLively("kit-version") || null;
  out.assets = Object.fromEntries(hs.map((x) => [x, Object.entries(man[x] || {}).map(([id, v]) => ({ id, kind: v.kind, hash: v.hash, missing: !!(v.file && !existsSync(v.file)) }))]));
  const EV = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "Notification", "PreCompact", "PostCompact", "SessionEnd"];
  let fired = null; const cache = {};
  for (const e of EV) { try { const c = JSON.parse(readFileSync(join(LIVELY, `custom-hooks-${e}.json`), "utf8"));
    const n = (c.hooks || []).length; if (n) cache[e] = n;
    const s = Math.round((Date.now() - c.at) / 1000); if (!fired || s < fired.sec) fired = { sec: s, event: e }; } catch { /* 없으면 skip */ } }
  let runner = null; try { runner = readdirSync(join(LIVELY, "hooks")).filter((f) => f.endsWith(".mjs")).length; } catch { /* */ }
  out.hooks = { runner, cache, lastFired: fired };
  // 맥락은 **이번 세션이 실제로 받은 것**이다(session-preload 가 fetch 성공분을 여기 굳힌다) — 서버 preview 가 아니다.
  const ctx = readLively("context.md");
  const secs = []; let cur = null;
  for (const line of ctx.split("\n")) { if (line.startsWith("## ")) { cur = { title: line.slice(3), items: 0 }; secs.push(cur); } else if (cur && line.startsWith("- ")) cur.items++; }
  out.context = { sections: secs, chars: ctx.length };
  // ── 서버 대조 — 네트워크가 필요하다. 막히면 이 블록만 접고 위 로컬 사실은 그대로 유효하다(하네스 샌드박스). ──
  const norm = (s) => crypto.createHash("sha256").update(String(s).replace(/\s+/g, "")).digest("hex").slice(0, 12);
  out.server = null;
  if (gateway() && token()) {
    const h = hs[0] || "claude";
    try {
      const srv = (await api(`/api/ui/org/runner/assets?harness=${encodeURIComponent(h)}`, { timeoutMs: 8000 })).assets || [];
      const lm = new Map((out.assets[h] || []).map((a) => [a.id, a.hash]));
      out.server = { harness: h, assets: srv.length,
        sameHash: srv.length === (out.assets[h] || []).length && srv.every((a) => lm.get(a.id) === a.content_hash),
        notLocal: srv.filter((a) => !lm.has(a.id)).map((a) => `${a.kind}:${a.id}`),
        mismatch: srv.filter((a) => lm.has(a.id) && lm.get(a.id) !== a.content_hash).map((a) => `${a.kind}:${a.id}`),
        stale: (out.assets[h] || []).filter((a) => !srv.some((s) => s.id === a.id)).map((a) => a.id) };
      const c = (await api("/api/ui/org/preview", { timeoutMs: 8000 }))?.context || "";
      out.server.contextFresh = norm(c) === norm(ctx);
    } catch (e) { out.server = { error: e.message }; }
  }
  if (opts.json) { jsonOut(out); return; }
  say(`\n${bold("라이블리 배선 점검")} ${dim("— 아래는 사실이다. 지금 이 세션에 실제로 무엇이 보이는지와 대조해 판정하라.")}\n`);
  say(`  키트          ${out.kit || dim("(없음)")}`);
  if (!hs.length) say(`  자산          ${yellow("매니페스트 없음 — 이 머신에 조직 자산이 한 번도 안 깔렸다")}`);
  for (const x of hs) {
    const l = out.assets[x], miss = l.filter((a) => a.missing);
    say(`  자산 ${x.padEnd(8)} ${l.length ? green(`${l.length}개`) : yellow("0개 — 이 하네스에 하나도 안 깔렸다")}${miss.length ? "  " + yellow(`파일없음 ${miss.length}개`) : ""}`);
    if (l.length) say(`    ${dim(l.map((a) => `${a.kind}:${a.id}`).join(" "))}`);
    for (const a of miss) say(`    ${red("✗")} ${a.id}`);
  }
  if (hs.length > 1) say(`  ${dim("↑ whoami 의 session.harness 와 같은 줄을 보라 — 다른 줄은 이 PC 의 다른 하네스 것이다.")}`);
  say(`  훅            러너 ${out.hooks.runner ?? "?"}개 · 캐시 ${Object.entries(out.hooks.cache).map(([e, n]) => `${e}=${n}`).join(" ") || dim("없음")} · 마지막 발화 ${fired ? `${fired.sec}초 전(${fired.event})` : dim("기록없음")}`);
  say(`  맥락          ${secs.length ? secs.map((s) => `${s.title}(${s.items})`).join(" · ") : yellow("context.md 없음 — 주입이 한 번도 성공한 적 없다")}`);
  if (!out.server) say(`  서버 대조     ${dim("생략(게이트웨이·토큰 없음) — 위 로컬 사실로 판정하라")}`);
  else if (out.server.error) say(`  서버 대조     ${yellow("생략")} ${dim(out.server.error)}\n                ${dim("네트워크가 막힌 것이지 배선 고장이 아니다(하네스 샌드박스일 수 있다) — 위 로컬 사실로 판정하라")}`);
  else {
    say(`  서버 대조     ${out.server.harness} · 자산 ${out.server.assets}개 ${out.server.sameHash ? green("· 로컬과 해시까지 동일") : yellow("· 로컬과 다름")}`);
    for (const x of out.server.notLocal) say(`    ${red("✗")} 로컬에 없음 ${x}`);
    for (const x of out.server.mismatch) say(`    ${yellow("·")} 내용 다름 ${x} ${dim("(다음 세션에 갱신된다)")}`);
    for (const x of out.server.stale) say(`    ${yellow("·")} 서버에 없음(잔재) ${x}`);
    say(`                맥락 ${out.server.contextFresh ? green("= 이 세션이 받은 것(최신)") : yellow("≠ 세션 시작 뒤 서버가 바뀜 — 다음 세션에 반영")}`);
  }
  say("");
}

// ── 실행 모드(#1007+) — 이 세션이 라이블리와 얼마나 상호작용하나. CLI 가 모드 이름을 env 플래그로 번역한다. ──
//  normal   : 주입 ○ / 쓰기 ○ (기본)
//  readonly : 주입 ○ / 쓰기 ✗ (게이트웨이가 x-lively-mode=readonly 로 쓰기 툴 소거 · REST 403)
//  incognito: 주입 ✗ / 읽기 ✗ / 쓰기 ✗ (게이트웨이가 x-lively-mode=incognito 로 lively 툴 0개+전체 차단 = 사실상 연결없음) + 훅 off
const MODES = ["normal", "readonly", "incognito"];
const MODE_FILE = "mode";
// 디폴트 모드(~/.lively/mode) — 유효하지 않거나 없으면 normal.
function defaultMode() { const m = readLively(MODE_FILE); return MODES.includes(m) ? m : "normal"; }
// rest 에서 모드 플래그(--mode M / --readonly / --incognito / --normal)를 뽑고 나머지를 돌려준다. 플래그 없으면 디폴트, 여러 개면 마지막이 이긴다.
function extractMode(rest) {
  let mode = null; const out = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--mode") { const v = rest[++i]; if (!MODES.includes(v)) die(`--mode 는 ${MODES.join("|")} 중 하나여야 합니다.`, 2); mode = v; }
    else if (a === "--readonly" || a === "--read-only") mode = "readonly";
    else if (a === "--incognito") mode = "incognito";
    else if (a === "--normal") mode = "normal";
    else out.push(a);
  }
  return { mode: mode ?? defaultMode(), rest: out };
}
// 모드 → 세션 env(하네스가 상속 → MCP 헤더 x-lively-mode 가 이 env 를 확장 → 게이트웨이 강제). 단일 헤더라 미래 모드 추가 시 재등록 불요(#1007+). incognito 는 LIVELY_OFF 로 훅(주입·넛지)도 끈다.
//  ⚠ **전이기 dual-env**: 새 LIVELY_MODE(주 신호) 와 함께 구 LIVELY_READONLY/LIVELY_INCOGNITO 도 세팅한다 — 이 사용자의 claude.json MCP 설정에
//   x-lively-mode 헤더가 아직 전파 안 된 경우(구 x-lively-readonly/incognito 헤더만 있음, self-update 1세션 지연)에도 격리가 fail-open 되지 않게.
//   x-lively-mode 헤더가 있으면 게이트웨이 modeFromHeaders 가 그걸 우선한다(구 env 는 무해). 전파 완료 후 구 env 는 후속 정리에서 제거(#1021).
function modeEnv(mode) {
  if (mode === "readonly") return { LIVELY_MODE: "readonly", LIVELY_READONLY: "1" };
  if (mode === "incognito") return { LIVELY_MODE: "incognito", LIVELY_INCOGNITO: "1", LIVELY_OFF: "1" };
  return {};
}

// `lively run [--mode M | --readonly | --incognito] [<프로젝트#> [work.mjs 인자…] | [--harness claude|codex|opencode|antigravity|grok] [하네스 인자…]]`
//  · 프로젝트# 있으면 work.mjs(공유폴더 pull · 레포 clone/worktree · 하네스 실행) — 종전 표면.
//  · 없으면 하네스를 **바로** 실행한다(프로젝트 없이 — 사용자 요청). 기본 claude, --harness 로 변경.
//  두 경로 모두 모드 env 를 세팅 → 그 세션만 읽기전용/인코그니토가 헤더로 게이트웨이에 전달된다(per-session).
function cmdRun(rest0) {
  const { mode, rest } = extractMode(rest0);
  const env = { ...process.env, ...modeEnv(mode) };
  const badge = mode === "normal" ? "" : dim(` [${mode}]`);
  const onExit = (child) => child.on("exit", (code, sig) => process.exit(sig ? 1 : (code ?? 0)));
  // 프로젝트# → work.mjs (종전 동작 보존, 모드 env 만 추가)
  if (rest.length && /^\d+$/.test(rest[0])) {
    const work = join(LIVELY, "work.mjs");
    if (!existsSync(work)) die("work.mjs 가 없습니다 — `lively install` 로 키트를 설치하세요.");
    say(dim(`프로젝트 #${rest[0]} 열기`) + badge);
    onExit(spawn(process.execPath, [work, ...rest], { stdio: "inherit", env }));
    return;
  }
  // 프로젝트# 없음 → 하네스 직접 실행. --harness <name> 로 선택(기본 claude), 나머지는 하네스에 그대로 넘긴다.
  let harness = "claude"; const args = [];
  for (let i = 0; i < rest.length; i++) { if (rest[i] === "--harness") harness = rest[++i] || harness; else args.push(rest[i]); }
  if (!has(harness)) die(`${harness} 이(가) 설치돼 있지 않습니다.`, 2);
  say(dim(`${harness} 실행`) + badge);
  // WIN: .cmd 셰임이라 shell 필요(work.mjs:259 동형) — 셸 경유이므로 명령·인자를 **둘 다** 인용한다(#1087).
  const [hc, ha] = WIN ? winSpawnArgs(harness, args) : [harness, args];
  onExit(spawn(hc, ha, { stdio: "inherit", env, ...(WIN ? { shell: true } : {}) }));
}

// `lively mode [normal|readonly|incognito]` — 디폴트 실행 모드 조회/설정(~/.lively/mode). lively run 이 --mode 없을 때 이걸 읽는다.
function cmdMode(rest) {
  const m = rest[0];
  if (!m) {
    const cur = defaultMode();
    say(`디폴트 실행 모드: ${bold(cur)}`);
    say(dim(`  변경: lively mode <${MODES.join("|")}>   ·   일회성: lively run --readonly  /  --incognito  /  --normal`));
    return;
  }
  if (!MODES.includes(m)) die(`모드는 ${MODES.join("|")} 중 하나여야 합니다.`, 2);
  mkdirSync(LIVELY, { recursive: true });
  writeFileSync(join(LIVELY, MODE_FILE), m + "\n", { mode: 0o600 });
  const hint = m === "incognito" ? "  (주입·읽기·쓰기 모두 off — 클린룸)" : m === "readonly" ? "  (읽기 O · 쓰기 X)" : "  (주입·읽기·쓰기 모두 on)";
  say(green(`디폴트 실행 모드 → ${bold(m)}`) + dim(hint));
}

// `lively mcp-local` — 로컬 조작 stdio MCP 서버를 이 프로세스에서 실행(하네스가 매 세션 spawn, 사람이 직접 칠 일 없음).
//  서버 본체·툴 레지스트리는 lib/lively-mcp-local.mjs 에 있다 — 새 로컬 툴은 거기 TOOLS 배열에 추가한다(여긴 위임만).
async function cmdMcpLocal() {
  const { serveMcpLocal } = await import(new URL("./lively-mcp-local.mjs", import.meta.url));
  await serveMcpLocal();
}

// `lively mcp` — 게이트웨이 MCP 의 로컬 stdio 프록시(#1079). 하네스가 매 세션 spawn 한다.
//  http 직결이 아니라 이걸 거치는 이유: 세션 시작 때 게이트웨이에 못 닿아도(VPN 미접속 등)
//  하네스에겐 항상 connected 로 보이고, 상류가 살아나면 그 세션에서 그대로 복구되기 때문이다.
//  본체는 lib/lively-mcp-gateway.mjs (여긴 위임만) — lively-mcp-local 과 같은 레일.
async function cmdMcpGateway() {
  const { serveMcpGateway } = await import(new URL("./lively-mcp-gateway.mjs", import.meta.url));
  await serveMcpGateway();
}

// `lively init` — 이 폴더를 라이블리 프로젝트로(사람 표면). MCP 툴 lively_local_project_init 과 **같은 코어**를 쓴다
//  (project-init-core.mjs — 드리프트 0). D8: 사람이 촉발해야 자연스러운 것은 사람 표면으로.
//  기본은 **제안만**(무변경) — 사람이 보고 --create / --bind <id> 로 확정한다. '알아서 만들기'를 기본으로 두지 않는 이유:
//  마커는 동기화되지 않아 다른 멤버가 이미 만든 프로젝트를 못 보는 게 정상이라, 자동 create 는 중복을 양산한다.
async function cmdInit(rest) {
  const { projectInit } = await import(new URL("./project-init-core.mjs", import.meta.url));
  const ctx = {
    cwd: process.cwd(),
    sh: (cmd2, args, opts = {}) => { const r = run(cmd2, args, { quiet: true, allowFail: true, env: opts.env }); return { stdout: r.out, stderr: r.err, code: r.code }; },
    api: (p2, opts) => api(p2, opts),
  };
  const a = { mode: "auto" };
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--create") a.mode = "create";
    else if (t === "--bind") { a.mode = "bind"; a.project_id = Number(rest[++i]); }
    else if (t === "--name") a.name = rest[++i];
    else if (t === "--path") a.path = rest[++i];
    else if (t === "--list") a.list_id = Number(rest[++i]);
    else if (t === "--json") a.json = true;
  }
  let r;
  try { r = await projectInit(ctx, a); }
  catch (e) { die(e.message, 1); }
  if (a.json) { jsonOut(r); return; }

  if (r.status === "already_project") { say(`\n${yellow("이미 프로젝트입니다")} — #${r.project_id}\n  ${dim(r.note)}\n`); return; }
  if (r.status === "suggestion") {
    say(`\n${bold("프로젝트 연결 제안")} ${dim(r.dir)}\n`);
    say(`  git origin    ${r.git_url || dim("(없음 — git 레포가 아니거나 origin 미설정)")}`);
    if (r.active_total) say(`  기존 후보     진행 중 ${r.active_total}개${r.truncated ? dim(` (아래는 최근 ${r.candidates.length}개만)`) : ""}`);
    for (const c of (r.candidates || []).filter((c) => c.status !== "done").slice(0, 5)) say(`    ${dim("#" + c.project_id)} ${c.name} ${dim("(" + c.status + ")")}`);
    say("");
    if (r.suggestion.action === "bind") {
      say(`  ${green("→ 붙이기를 권합니다")}: ${bold("lively init --bind " + r.suggestion.project_id)}`);
      say(`     ${dim(r.suggestion.why)}`);
    } else {
      say(`  ${yellow("→ 판단이 필요합니다")}`);
      say(`     ${dim(r.suggestion.why)}`);
      say(`     새로: ${bold("lively init --create --name \"<이름>\"")}   ·   기존에: ${bold("lively init --bind <id>")}`);
    }
    say("");
    return;
  }
  // created | bound
  say(`\n${green("✓")} ${r.status === "created" ? "새 프로젝트 생성" : "기존 프로젝트에 연결"} — ${bold("#" + r.project_id)} ${r.name}`);
  say(`  폴더        ${r.dir}`);
  say(`  공유폴더    ${r.sync} ${dim("(사용자 폴더라 서버 파일을 내려받지 않습니다 — 당신 파일을 덮어쓰지 않기 위함)")}`);
  if (r.binding_error) say(`  ${yellow("⚠ 중앙 폴더 인벤토리 등록 실패")} ${dim(r.binding_error)} ${dim("— 로컬 연결은 정상입니다")}`);
  say(`\n  ${dim("다음 세션부터 이 폴더에서 프로젝트 맥락이 뜹니다. 상태: ")}${bold("lively status")}\n`);
}

// `lively repo` — 워크트리 셀프서비스 CLI(사람·스크립트용). MCP 툴 lively_local_repo_* 과 **같은 코어**를 쓴다
//  (repo-worktree-core.mjs — 드리프트 0). ctx 계약: sh → {stdout,stderr,code}(run 의 out/err 매핑) · api → JSON · cwd.
async function cmdRepo(rest) {
  const { repoList, repoWorktree, repoWorktreeRemove, repoPin, repoPinRemove } = await import(new URL("./repo-worktree-core.mjs", import.meta.url));
  const ctx = {
    cwd: process.cwd(),
    sh: (cmd, args, opts = {}) => { const r = run(cmd, args, { quiet: true, allowFail: true, env: opts.env }); return { stdout: r.out, stderr: r.err, code: r.code }; },
    api: (p) => api(p),
  };
  const sub = String(rest[0] || "").toLowerCase();
  const o = {}; const pos = [];
  for (let i = 1; i < rest.length; i++) {
    const t = rest[i];
    if (t === "--branch") o.branch = rest[++i];
    else if (t === "--ref") o.ref = rest[++i];
    else if (t === "--path") o.path = rest[++i];
    else if (t === "--force") o.force = true;
    else pos.push(t);
  }
  try {
    if (!sub || sub === "list" || sub === "ls") {
      const res = await repoList(ctx);
      say(bold(`레포 ${res.count}개`) + dim(`  · base dir: ${res.repos_dir}`));
      for (const r of res.repos) {
        const dot = r.cloned ? green("●") : dim("○");
        const meta = r.cloned ? (r.status || `${r.branch || "?"}@${r.head || "?"}`) : "미클론";
        say(`  ${dot} ${r.name}  ${dim(meta)}`);
      }
      if (!res.repos.length) info("등록된 레포가 없습니다 — 관리탭 ▸ 레포에서 git 주소를 연결하세요.");
      return;
    }
    if (sub === "worktree" || sub === "wt") {
      const op = String(pos[0] || "").toLowerCase();
      if (op === "remove" || op === "rm") {
        const res = repoWorktreeRemove(ctx, { repo: pos[1], path: o.path, force: o.force });
        ok(`워크트리 제거: ${res.removed}`); return;
      }
      const repo = pos[0];
      if (!repo) die("레포 이름이 필요합니다.  예: lively repo worktree <repo> [--branch b] [--ref main] [--path .]");
      const res = await repoWorktree(ctx, { repo, branch: o.branch, ref: o.ref, path: o.path });
      ok(`워크트리: ${bold(res.worktree)}  ${dim(`(브랜치 ${res.branch})`)}`);
      say("  " + dim(res.note));
      return;
    }
    if (sub === "pin") {
      const op = String(pos[0] || "").toLowerCase();
      if (op === "remove" || op === "rm") {
        const res = repoPinRemove(ctx, { repo: pos[1], ref: o.ref, path: o.path });
        ok(res.removed ? `핀 제거: ${res.removed}` : (res.note || "제거할 핀 없음")); return;
      }
      const repo = pos[0];
      if (!repo) die("레포 이름이 필요합니다.  예: lively repo pin <repo> [--ref main] [--path .]");
      const res = await repoPin(ctx, { repo, ref: o.ref, path: o.path });
      ok(`핀: ${bold(res.pin)}  ${dim(`${res.repo}@${res.sha}${res.committed ? " · " + res.committed : ""}${res.reused ? " (재사용)" : ""}`)}`);
      say("  " + dim(res.note));
      return;
    }
    die(`알 수 없는 하위명령: ${sub}\n  lively repo list  ·  lively repo pin <repo> [--ref]  ·  lively repo worktree <repo> [--branch --ref --path]  ·  … remove <repo> [--force]`);
  } catch (e) { die(e.message || String(e)); }
}

// 부트스트랩(curl … | sh)이 곧장 부르는 대화형 첫 설치 — 로그인 + 설치를 한 흐름으로.
// 토큰이 지금 이 게이트웨이에서 **실제로 먹히는지** 확인한다(죽지 않는다).
//  true=먹힌다 · false=거부됐다(재로그인 필요) · null=판정 불가(네트워크·게이트웨이 이상).
//  ⚠ null 을 false 로 뭉개면 잠깐의 네트워크 끊김이 멀쩡한 사용자를 재로그인시킨다 → 셋으로 구분한다.
async function tokenAccepted(gw, tok) {
  if (!gw || !tok) return false;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(gw + "/api/ui/me/profile", { signal: ctl.signal, headers: { authorization: `Bearer ${tok}` } });
    if (res.status === 401 || res.status === 403) return false;
    return res.ok ? true : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

async function cmdSetup(opts = {}) {
  say(`\n${bold("라이블리 설치를 시작합니다.")}`);
  // `--gateway` 를 여기서도 받는다(#1541 T3) — 데스크톱 앱은 주소를 방금 사람에게 받아 들고 있고,
  //  `login` 과 `install` 을 따로 부르는 대신 **setup 하나**로 몰 수 있어야 한다(순서·조건의 정본은 CLI 다).
  //  아래 tokenAccepted 가 **새 주소로** 판정되도록 로그인보다 먼저 쓴다 — 게이트웨이를 바꾸는 경우
  //  옛 주소의 토큰이 '먹힌다'고 나와 로그인을 통째로 건너뛰는 사고(#1087 계열)를 막는다.
  if (opts.gateway) writeLively("gateway-url", normGw(opts.gateway));
  // ⚠ 토큰이 **있는지**가 아니라 **먹히는지**를 본다(#1087). token() 은 파일 다음에 LIVELY_TOKEN 환경변수도
  //  보므로, 만료·회수된 토큰이나 셸에 남아 있던 옛 env 값이 로그인을 건너뛰게 만들었다. 그러면 설치는
  //  한참 뒤 [1/3] 키트 내려받기에서 401 로 죽고, 그 지점의 메시지만으론 사용자가 뭘 해야 할지 알 수 없다
  //  (실측: "이미 로그인돼 있습니다" → "✗ 토큰이 유효하지 않습니다" 로 설치 실패).
  //  같은 계열의 stale-토큰 shadow 사고가 프로비저닝 셸에서도 있었다 — 그 불변식과 짝이다.
  const accepted = await tokenAccepted(gateway(), token());
  if (accepted === true) info("이미 로그인돼 있습니다 — 설치만 진행합니다.");
  else if (accepted === null) info("로그인 상태를 확인하지 못했습니다(네트워크?) — 그대로 설치를 시도합니다.");
  else await cmdLogin({});
  await cmdInstall();
  // 설치 완료 → 온보딩 안내(정적 문구만 · #1024). 자동 실행·Y/n 프롬프트 없음 — 대화형/비대화형 모두 안전.
  say(dim("\n  ") + bold("lively onboarding") + dim(" 을 실행하여 라이블리 초기 설정을 진행하세요."));
}

// ── 10. 인자 파싱 · 디스패치 ───────────────────────────────────────────────
const HELP = `${bold("lively")} — 라이블리 키트 명령

${bold("사용법")}
  lively <명령> [옵션]

${bold("시작하기")}
  setup                  로그인 + 설치를 한 번에 (처음 설치할 때) ${dim("--gateway <url>")}
  login                  접속 토큰 등록 (가림 입력 — 화면·히스토리에 안 남음)
  logout                 토큰만 지움 (설치는 유지)
  onboarding             내 환경 정리 · 라이블리 첫 세팅을 지금 시작 ${dim("(claude 를 열어 온보딩 스킬 실행 — 언제든 재실행)")}

${bold("설치 · 유지보수")}
  install                키트 설치 / 재설치 (멱등)
  update                 지금 최신으로 맞춤 ${dim("(MCP 재등록 포함 — 자동 업데이트가 못 하는 축)")}
      --check            확인만 하고 설치하지 않음
  uninstall              제거 ${dim("--dry-run  --purge  --yes  --harness claude|codex|opencode|antigravity|grok|all")}

${bold("확인")}
  status                 설치 · 버전 · 하네스 · MCP 상태  ${dim("--json")}
                         ${dim("프로젝트 폴더에서 실행하면 프로젝트 · 공유폴더 동기화 상태도 함께 보여줍니다")}
  doctor                 문제 진단 + 해결책               ${dim("--json")}
  selfcheck              배선 점검 사실 덤프(AI 가 세션과 대조) ${dim("--json")}
  selfcheck              배선 점검(AI가 세션과 대조할 사실) ${dim("--json")}

${bold("작업")}
  init                   지금 폴더를 프로젝트로 — 기본은 ${bold("제안만")}(무엇을 할지 알려주고 아무것도 안 바꿈)
      --create           새 프로젝트로 만들어 연결  ${dim('--name "<이름>"  --list <리스트id>')}
      --bind <id>        기존 프로젝트에 연결      ${dim("--path <폴더>  --json")}
  run [<프로젝트번호>]    프로젝트 열기 / ${bold("인자 없으면 하네스 바로 실행")}  ${dim("예: lively run 864  ·  lively run --readonly")}
      --readonly         이 세션만 읽기전용(라이블리 읽기 O · 쓰기 X) ${dim("· --incognito(주입·읽기·쓰기 all off) · --normal · --mode <m>")}
      --harness <name>   무인자 실행 때 하네스 선택 ${dim("(기본 claude)")}
      ${dim("레포를 못 가져와도(자격·네트워크 등) 세션은 그대로 시작하고, 무엇이 왜 실패했는지 사람·AI 에게 함께 알립니다.")}
      --require-repo     ${dim("반대로 레포 준비 실패 시 실행을 중단(자동화·프로비저닝 스크립트용)")}
  mode [<normal|readonly|incognito>]  디폴트 실행 모드 조회/설정 ${dim("(lively run 이 --mode 없을 때 읽음)")}
  resume <세션id>         다른 환경/멤버에서 만든 내 세션을 이 PC 로 이어받기 ${dim("--node <id>  --print(내려받기만)")}
  backfill                이 PC 의 기존 claude 대화 기록을 중앙에 소급 업로드(웹뷰에 과거 세션도) ${dim("--dry-run")}
  share [<세션id>]         이 세션(진행 중 포함)을 팀원과 공유 — 최신 내용 올리고 열람 링크 출력 ${dim("--node <id>  --json")}
  delegate "<작업>"       무거운 작업을 워커/중앙에 위탁 — 진행을 미러하며 결과 출력 후 종료 ${dim('예: lively delegate "테스트 실행" --ram 2048')}
      --repo <이름> [--ref main]  대상 레포 자동 준비(공유 base→worktree, cwd 로)  ${dim("--ram/--cpu/--disk N  --docker  --node <id>  --timeout <초>")}
      --detach               번호만 반환하고 즉시 종료  ${dim("(나중에 lively delegate logs <번호>)")}
  delegate status|logs|cancel <번호> · delegate list
  node                   이 PC 를 노드로 연결 — 웹에서 로컬 터미널 관리/위탁 ${dim("(foreground, Ctrl-C 로 종료)")}
      --daemon               상시화(부팅·로그인마다 자동) ${dim("macOS launchd · Linux systemd --user")}   ·   node stop  데몬 해제
  repo list              이 머신에서 뜰 수 있는 레포 + 로컬 상태
  repo pin <레포>        코드 근거 분석용 읽기전용 핀(SHA 고정) ${dim("--ref main  --path .  ·  pin remove <레포>")}
  repo worktree <레포>   워크트리 생성(코드 작업면) — 프로젝트면 그 폴더의 <레포> 자리 ${dim("--branch b  --ref main  --path .  ·  worktree remove <레포> [--force]")}

${bold("옵션")}
  --gateway <url>        게이트웨이 주소 지정 (login 과 함께)
  --token <토큰>         비대화형 로그인 (스크립트 · 프로비저닝용)
  --json-events          진행 상황을 stdout 에 NDJSON 으로 ${dim("(데스크톱 앱·자동화용 — 사람용 출력은 stderr 그대로)")}
                         ${dim("확인이 필요하면 prompt 이벤트를 내고 stdin 의 {\"t\":\"answer\",\"id\":…,\"value\":…} 한 줄을 기다립니다.")}
  -v, --version          버전
  -h, --help             이 도움말

${dim("업데이트는 보통 자동입니다 — 세션을 켜면 키트가 알아서 최신이 됩니다.")}
${dim("`lively update` 는 지금 당장 맞추거나, 관리자가 MCP 서버를 추가했을 때 씁니다.")}`;

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--gateway") o.gateway = argv[++i];
    else if (t === "--token") o.token = argv[++i];
    else if (t === "--harness") o.harness = argv[++i];
    else if (t === "--check") o.check = true;
    else if (t === "--json") o.json = true;
    else if (t === "--json-events") o.jsonEvents = true;   // 앱↔CLI 계약(#1541 T1) — stdout NDJSON
    else if (t === "--dry-run") o.dryRun = true;
    else if (t === "--purge") o.purge = true;
    else if (t === "--yes" || t === "-y") o.yes = true;
    else if (t === "-v" || t === "--version") o.version = true;
    else if (t === "-h" || t === "--help") o.help = true;
    else o._.push(t);
  }
  return o;
}

// ── 세션(#905 C1) — resume(다른 환경의 내 세션 이어받기) · backfill(기존 claude 기록 소급 업로드)
//  · share(진행 중 세션 공유 링크). 본체·사연은 cmd-session.mjs (여긴 위임만).
async function cmdResume(args) {
  const { sessionCommands } = await import(new URL("./cmd-session.mjs", import.meta.url));
  return sessionCommands(cliCtx()).cmdResume(args);
}
async function cmdBackfill(args) {
  const { sessionCommands } = await import(new URL("./cmd-session.mjs", import.meta.url));
  return sessionCommands(cliCtx()).cmdBackfill(args);
}
async function cmdShare(args) {
  const { sessionCommands } = await import(new URL("./cmd-session.mjs", import.meta.url));
  return sessionCommands(cliCtx()).cmdShare(args);
}

// lively onboarding [초기프롬프트…] — 온보딩 스킬을 이 PC 에서 바로 실행한다.
//  claude 를 초기 프롬프트("온보딩 도와줘")로 띄우면 하네스가 그 문구로 lively-onboarding 스킬을 소환한다.
//  설치 직후 제안과 사람의 수동 재실행이 같은 진입을 쓴다. cmdResume 과 동형(has 가드 + spawnSync inherit).
//  ⚠ 자동승인 플래그는 주지 않는다 — 멤버가 깔아둔 auto-approve 를 쓰고 나머지는 정상 권한 프롬프트(온보딩은 신뢰가 전부).
//  --print 는 실제로 안 띄우고 실행할 명령만 출력(테스트·확인용, resume 과 동일 관례).
function cmdOnboarding(rest) {
  const printOnly = rest.includes("--print") || rest.includes("--dry-run");
  const prompt = rest.filter((a) => a !== "--print" && a !== "--dry-run").join(" ").trim() || "온보딩 도와줘";
  if (printOnly) { say(`claude ${JSON.stringify(prompt)}`); return; }
  if (!has("claude")) { say(red("claude 실행파일을 못 찾았습니다 — 먼저 `lively install` 로 하네스를 설치하세요.")); process.exit(1); }
  say(dim(`  · 온보딩 세션을 엽니다 — "${prompt}"`));
  const st = spawnSync("claude", [prompt], { stdio: "inherit", cwd: process.cwd() }).status;
  process.exit(st ?? 0);
}

// 이벤트 채널 기동(#1541 T1) — `--json-events` 일 때만. 여기서만 켜므로 플래그가 없으면 stdout 은 종전대로 빈다.
//  ⚠ **stdin 을 여는 것도 여기서만** 한다: 평소에 stdin 을 resume 하면 파이프 입력을 기다리는 명령들의
//   동작이 바뀐다(`curl … | sh` 부트스트랩이 정확히 그 형태다).
//  ⚠ 쓰기는 **writeSync(fd 1)** 로 한다. process.stdout 은 파이프일 때 비동기라(POSIX) 마지막 `end` 이벤트가
//   프로세스 종료와 경합해 통째로 유실될 수 있다 — 앱은 그 한 줄로 성공·실패를 판정하므로 유실이 곧 오판이다.
function startEvents(cmd) {
  const write = (line) => {
    try { writeSync(1, line); }
    catch { try { process.stdout.write(line); } catch { /* stdout 닫힘 — 보고를 못 해도 명령은 계속한다 */ } }
  };
  EV = createEmitter({ write });
  const src = lineReader(process.stdin);
  PROMPTER = createPrompter({ emit: EV.emit, onLine: src.onLine, onEnd: src.onEnd });
  EV.start(cmd, CLI_VERSION);
}
/**
 * end 를 정확히 한 번 낸다(정상 종료·die·exit 훅이 모두 이 문을 지난다).
 *
 * ⚠ 그리고 **stdin 핸들을 놓아준다.** 이벤트 모드는 답을 받으려고 stdin 을 열어 두는데(그게 프롬프트의 전제다),
 *  그 핸들이 이벤트 루프를 붙잡고 있어서 놓지 않으면 **명령이 끝나도 프로세스가 영영 안 죽는다** — 앱 입장에선
 *  `lively install` 이 성공 보고를 하고도 종료되지 않는다(통합 테스트가 실제로 이걸 잡았다: exit=null).
 *  process.exit() 로 끊지 않는 이유는 stderr 다 — 파이프일 때 비동기라 사람용 출력이 잘린다.
 *  핸들만 놓으면 루프가 자연히 비면서 남은 출력이 flush 된다.
 */
function endEvents(okFlag, code) {
  if (!EV) return;
  EV.end(okFlag, code);
  EV = null; PROMPTER = null;
  try { process.stdin.pause(); process.stdin.unref?.(); } catch { /* 이미 닫힘 */ }
}

async function main() {
  const argv = process.argv.slice(2);
  const o = parse(argv);
  const cmd = o._[0] || (o.version ? "version" : o.help ? "help" : "status");
  if (!o.jsonEvents) return dispatch(cmd, o, argv);
  startEvents(cmd);
  // end 는 **모든 경로**에서 정확히 한 번 나가야 한다(앱이 그 한 줄로 성공·실패를 판정한다):
  //  ⓐ 정상 반환 ⓑ 예외 ⓒ die() ⓓ 명령이 스스로 process.exit() 하는 경우(onboarding 등) — ⓓ 만 훅으로 잡힌다.
  process.on("exit", (code) => endEvents(!code, code));
  try {
    await dispatch(cmd, o, argv);
    endEvents(true, 0);
  } catch (e) {
    if (EV) EV.notice("error", String(e?.message || e));
    endEvents(false, 1);
    throw e;
  }
}

async function dispatch(cmd, o, argv) {
  switch (cmd) {
    case "setup": return cmdSetup(o);
    case "login": { await cmdLogin(o); return; }
    case "logout": return cmdLogout();
    // onboarding — 온보딩 스킬을 이 PC 에서 바로 실행(설치 직후 제안·수동 재실행 공용). 나머지 인자=초기 프롬프트.
    case "onboarding": return cmdOnboarding(argv.slice(argv.indexOf("onboarding") + 1));
    case "install": { await cmdInstall(); return; }
    case "update": case "upgrade": return cmdUpdate(o);
    case "uninstall": case "remove": return cmdUninstall(o);
    case "init": return cmdInit(argv.slice(argv.indexOf("init") + 1));
    case "status": return cmdStatus(o);
    case "doctor": return cmdDoctor(o);
    case "selfcheck": return cmdSelfcheck(o);
    // run 은 나머지 인자를 **그대로** 넘긴다(모드 플래그만 cmdRun 이 소비, 나머지는 work.mjs/하네스로 원형 보존).
    case "run": return cmdRun(argv.slice(argv.indexOf("run") + 1));
    // mode — 디폴트 실행 모드(normal|readonly|incognito) 조회/설정(#1007+). lively run 이 이걸 읽는다.
    case "mode": return cmdMode(argv.slice(argv.indexOf("mode") + 1));
    // delegate 도 나머지 인자 원형 보존(--ram 등 delegate 전용 옵션이 CLI 공통 파서에 안 먹히게).
    case "delegate": return cmdDelegate(argv.slice(argv.indexOf("delegate") + 1));
    // node — 이 PC 를 라이블리 노드로 연결(데몬 없이 foreground). 나머지 인자 원형 보존.
    case "node": return cmdNode(argv.slice(argv.indexOf("node") + 1));
    // mcp-local — 로컬 조작 stdio MCP 서버(하네스가 spawn). stdin 이 닫힐 때까지 블로킹.
    case "mcp-local": return cmdMcpLocal();
    // mcp — 게이트웨이 MCP 의 로컬 stdio 프록시(하네스가 spawn, #1079). 마찬가지로 블로킹.
    case "mcp": return cmdMcpGateway();
    // repo — 워크트리 셀프서비스(list/worktree). MCP 툴과 같은 코어. 나머지 인자 원형 보존.
    case "repo": return cmdRepo(argv.slice(argv.indexOf("repo") + 1));
    // resume — 다른 환경에서 내 세션 이어받기(#905 C1). 중앙 트랜스크립트를 이 PC 로 내려 claude --resume.
    case "resume": return cmdResume(argv.slice(argv.indexOf("resume") + 1));
    // backfill — 이 머신의 기존 claude 트랜스크립트를 중앙에 소급 업로드(#905 C1). 웹뷰에 과거 세션도 보이게.
    case "backfill": return cmdBackfill(argv.slice(argv.indexOf("backfill") + 1));
    case "share": return cmdShare(argv.slice(argv.indexOf("share") + 1));
    case "version": say(`lively ${CLI_VERSION}${readLively("kit-version") ? dim("  · 키트 " + readLively("kit-version")) : ""}`); return;
    case "help": say(HELP); return;
    default:
      say(red(`알 수 없는 명령: ${cmd}\n`));
      say(HELP);
      process.exit(2);
  }
}

// 직접 실행일 때만 동작 — 테스트가 export 를 import 해도 명령이 돌지 않게(user-install.mjs 와 같은 가드).
//  ⚠ 비교는 realpath 로 — /tmp 는 macOS 에서 /private/tmp 심링크라 URL 문자열 비교가 어긋난다(v0.1.131 회귀 실측).
const DIRECT_RUN = (() => {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || ""); }
  catch { return false; }   // 판정 불가 = import 로 본다(설치기와 달리 CLI 는 '조용히 아무것도 안 함'이 안전한 기본).
})();
if (DIRECT_RUN) main().catch((e) => die(e?.message || String(e)));

export { parse, detectHarnesses, verifyBundle, normGw, gatherStatus, registerClaudeMcp, backupUserMcp, winArg, winSpawnArgs, loginEscapeToken, REQUIRED_HOOKS, CLI_VERSION };
export { MODES, extractMode, modeEnv, defaultMode }; // #1007+ 실행 모드(normal|readonly|incognito) — 테스트용

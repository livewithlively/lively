// 헤드리스 자격 발급 러너의 **실행 계약** (#4051) — 가짜 CLI + 실제 tmux 로 부작용을 본다.
//
//  왜 문자열 검사로 끝내지 않나: 이 러너의 결함은 전부 «띄웠다» 는 신호가 정상인 채로 조용히 난다(ai-login-run 의
//   교훈 — 인자 밀림 · 자기참조 pgrep). 그래서 실제로 띄우고 **파일·권한·환경**을 관찰한다. 셀프호스트 경로
//   (osUser=null · 세션 경계 중계 없음)는 로컬 sh 로 돌므로, 임시 HOME 에서 공개 함수를 그대로 부른다.
//  행 번호(R1…)는 스크래치패드 spec.md 의 엣지 표다.
//  ⚠ 윈도우는 통째로 건너뛴다(psmux 는 tmux 흉내를 내며 -S 를 무시한다 — terminal-sessions E12 의 교훈).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  headlessSlot, headlessPaths, headlessStartSh, headlessReadSh, splitHeadlessRead, headlessPaneCmd, headlessRunnerJs,
  startHeadlessLogin, readHeadlessLogin, pasteHeadlessLogin, markHeadlessStored, cancelHeadlessLogin,
  HEADLESS_RUN_LIMIT_MS, HEADLESS_ALIVE_SEC, HEADLESS_DEAD_SEC, HEADLESS_PANE_WATCHDOG_SEC, HEADLESS_RUN_MARK, headlessSeatKey,
  HEADLESS_TMUX_CALL_TIMEOUT_MS, headlessCleanSh,
} from "./headless-login-run.js";
import { EXIT_MARK } from "./ai-login-flow.js";
import { CAPTURED_LINE, TOKEN_CAPTURED_MARK, headlessLoginArgv } from "./headless-login-flow.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, pred: () => boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return; await sleep(100); }
  assert.fail(`기다렸지만 오지 않았다: ${what}`);
}
const SRC = fs.readFileSync(new URL("./headless-login-run.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const ROUTES = fs.readFileSync(new URL("./routes.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const FAKE_TOKEN = "sk-ant-oat01-" + "Zz9_-".repeat(18) + "tailAA";
const RID = "0123abcd4567ef89";

// ── 순수 계약 ─────────────────────────────────────────────────────────────────

await t("★ R16 pid 로 찾거나 죽이지 않는다 — 컨테이너가 다르면 엉뚱한 프로세스를 겨눈다", () => {
  const shells = [headlessStartSh({ home: "/h", slotName: "s", harness: "claude", runId: RID }),
    headlessStartSh({ home: "/h", slotName: "s", harness: "codex", runId: RID }), headlessReadSh(headlessPaths("/h", "s"))].join("\n");
  assert.ok(shells.length > 500, "배선 — 스크립트를 실제로 만들었다");
  for (const bad of [/\bpgrep\b/, /\bpkill\b/, /kill -0/, /\bkill\s+"?\$\(/]) {
    assert.ok(!bad.test(shells), `스크립트에 ${bad} 가 없다`);
    assert.ok(!bad.test(SRC.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n")), `모듈 소스에 ${bad} 가 없다`);
  }
  assert.match(shells, /stat -c %Y[^\n]*stat -f %m/, "생존은 심박(파일 시각)으로 잰다 — GNU·BSD 둘 다");
  assert.equal(HEADLESS_ALIVE_SEC, 5);
});

await t("★ R11·R10 없는 도구는 127 로 말한다 — tmux 는 claude 에만 요구한다", () => {
  const c = headlessStartSh({ home: "/h", slotName: "s", harness: "claude", runId: RID });
  const x = headlessStartSh({ home: "/h", slotName: "s", harness: "codex", runId: RID });
  assert.match(c, /command -v 'claude'[^\n]*exit 127/);
  assert.match(c, /\[ -n "\$LVLY_TMUX" \] \|\| \{ echo "tmux 없음" >&2; exit 127; \}/);
  assert.match(x, /command -v 'codex'[^\n]*exit 127/);
  assert.ok(!/LVLY_TMUX|tmux 없음/.test(x), "codex 경로는 tmux 를 찾지도 요구하지도 않는다");
  assert.match(x, /' pipe - 'codex'/, "codex 러너는 파이프 모드로 띄운다");
  assert.match(c, /' tmux "\$LVLY_TMUX" '/, "claude 러너는 찾은 tmux 로 띄운다");
});

await t("★ R15 상한 — 20분이 지나면 안 거둔 자격을 지우고 끝낸다", () => {
  assert.equal(HEADLESS_RUN_LIMIT_MS, 20 * 60_000, "codex 장치 코드(15분)보다 길다");
  const js = headlessRunnerJs();
  assert.match(js, /Date\.now\(\)-t0>LIMIT\)\{try\{fs\.unlinkSync\(tokf\)\}catch\(_\)\{\}end\(\)\}/, "지우고 나서 끝낸다");
  //  러너 본문이 문법적으로 온전한가(따옴표·역슬래시 한 글자로 통째로 죽는다 — 그러면 «started» 인데 아무 일도 없다).
  assert.doesNotThrow(() => new vm.Script(js, { filename: "headless-runner.js" }), "러너 본문이 컴파일된다(실행은 안 한다)");
});

await t("★ R6(계약) 창 안 명령 — 임시 HOME · 자동업데이트 끔 · 부모 자격 env 제거 · 종료코드는 명령 바로 뒤", () => {
  const p = headlessPaneCmd(["claude", "setup-token"]);
  assert.match(p, /HOME="\$LVLY_HL_HOME"/);
  assert.match(p, /DISABLE_AUTOUPDATER=1/);
  for (const v of ["CLAUDECODE", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "TMUX"]) assert.match(p, new RegExp(`-u ${v}\\b`));
  assert.match(p, /'claude' 'setup-token'; rc=\$\?; echo; echo "LVLY_LOGIN_EXIT \$rc"/, "echo 뒤의 $? 는 echo 의 것이다");
  assert.ok(HEADLESS_PANE_WATCHDOG_SEC * 1000 > HEADLESS_RUN_LIMIT_MS, "창의 자기 소멸은 러너 상한보다 늦다(러너가 먼저 치운다)");
  assert.match(p, new RegExp(`^\\(sleep ${HEADLESS_PANE_WATCHDOG_SEC}; kill -TERM 0\\) >/dev/null 2>&1 & env `), "맨 앞에 시계가 있다");
  const sh = spawnSync("sh", ["-n", "-c", p], { encoding: "utf8" });
  assert.equal(sh.status, 0, `창 명령이 sh 문법으로 온전하다: ${sh.stderr}`);
});

/** 조회 스크립트가 내는 모양 그대로 — 기록 · 저장 표식 · 자격 · pid 줄(`나이 주인`, 파일이 없으면 빈 줄) · 끝 표식. */
const readOut = (o: { log?: string; stored?: string; tok?: string; pid?: string; end?: boolean }): string =>
  `${o.log ?? ""}\n<<LVLY-HL-STORED>>\n${o.stored ?? ""}\n<<LVLY-HL-TOK>>\n${o.tok ?? ""}\n<<LVLY-HL-PID>>\n${o.pid ?? ""}`
  + (o.end === false ? "" : "\n<<LVLY-HL-END>>\n");
const HDR = `${HEADLESS_RUN_MARK} ${RID}\n`;

await t("★ R17 조회 결과 쪼개기 — 네 칸 · 머리 줄 떼기 · 구분자 없음 · 빈 자격", () => {
  const ok = splitHeadlessRead(readOut({ log: `${HDR}line1\nline2\n`, stored: "2026-09-17T00:00:00Z\n", tok: "secret-value\n", pid: `3 ${RID}` }));
  assert.deepEqual(ok, { log: "line1\nline2\n", stored: true, captured: "secret-value", ended: false });
  const none = splitHeadlessRead("그냥 글");
  assert.deepEqual(none, { log: "", stored: false, captured: null, ended: false }, "구분자가 없으면 아무것도 믿지 않는다");
  const empty = splitHeadlessRead(readOut({ log: "x", pid: `0 ${RID}` }));
  assert.equal(empty.stored, false);
  assert.equal(empty.captured, null);
  //  기록 속에 구분자 글자가 섞여도 진짜 칸은 맨 뒤의 것이다.
  const tricky = splitHeadlessRead(readOut({ log: `${HDR}say\n<<LVLY-HL-STORED>>\nhi\n<<LVLY-HL-PID>>\nzz\n<<LVLY-HL-END>>\n`, pid: `1 ${RID}` }));
  assert.equal(tricky.stored, false);
  assert.equal(tricky.ended, false);
  assert.match(tricky.log, /^say\n/);
});

await t("★ L4·L5 기록 주인 — 남의 시도가 남긴 화면은 버리고, 머리 없는 기록(이전 판)은 믿는다", () => {
  const other = splitHeadlessRead(readOut({ log: `${HEADLESS_RUN_MARK} ffffeeee00001111\nOLD https://claude.com/cai/oauth/authorize?state=OLD\n`, pid: `1 ${RID}` }));
  assert.equal(other.log, "", "L4 — 옛 주소를 내보내지 않는다(사람이 죽은 시도로 승인한다)");
  assert.equal(other.ended, false, "자리는 새 시도가 살아서 쥐고 있다 — 시작 중");
  const legacy = splitHeadlessRead(readOut({ log: "screen https://x\n", pid: `1 ${RID}` }));
  assert.equal(legacy.log, "screen https://x\n", "L5 — 배포 순간 진행 중이던 연결을 안 깬다");
  const blankOwner = splitHeadlessRead(readOut({ log: `${HEADLESS_RUN_MARK} ffffeeee00001111\nkeep\n`, pid: "2" }));
  assert.equal(blankOwner.log, "keep\n", "주인을 못 읽었으면(쓰는 찰나) 기록을 버리지 않는다");
  assert.equal(blankOwner.ended, false);
});

await t("★ L6·L7·L8·L9·L15·L16 러너 수명 — 흔적이 있는데 주인 없음·심박 멈춤이면 끝, 빈 자리는 모름", () => {
  const gone = splitHeadlessRead(readOut({ log: `${HDR}screen\n${EXIT_MARK} 127\n`, pid: "" }));
  assert.equal(gone.ended, true, "L6 — 기록이 있는데 pid 파일이 없다(취소·상한)");
  assert.match(gone.log, /LVLY_LOGIN_EXIT 127/, "끝난 러너의 종료 줄은 남긴다(구체적 오류가 이긴다)");
  assert.equal(splitHeadlessRead(readOut({ pid: "" })).ended, false,
    "L15 — 빈 자리(시작 실패)는 «끝났다» 가 아니다: 방금 보인 구체적 시작 오류를 덮으면 안 된다");
  assert.equal(splitHeadlessRead(readOut({ stored: "2026-09-17T00:00:00Z", pid: "" })).ended, true, "L16 — 저장 표식도 흔적이다");
  const at = (age: string) => splitHeadlessRead(readOut({ log: `${HDR}s\n`, pid: `${age} ${RID}` })).ended;
  assert.equal(at(String(HEADLESS_DEAD_SEC + 1)), true, "L7 — 심박이 멈췄다(정리 없이 사라진 러너)");
  assert.equal(splitHeadlessRead(readOut({ pid: `${HEADLESS_DEAD_SEC + 1} ${RID}` })).ended, true,
    "L7 — 기록을 쓰기도 전에 멈춘 러너(기동 실패)도 끝난 것이다 — 주인은 있었다");
  assert.equal(at(String(HEADLESS_DEAD_SEC)), false, "L8 — 경계값은 산 것이다(초과일 때만 끝)");
  assert.equal(at("?"), false, "L9 — 나이를 못 쟀다");
  assert.equal(at("-2"), false, "시계 반올림으로 음수여도 산 것이다");
  assert.equal(at("12abc"), false, "이상한 출력은 모르는 것이다");
  for (const odd of ["1e3", "0x40", "99.5"]) {
    assert.equal(at(odd), false, `숫자처럼 읽히는 이상한 출력(${odd})도 모르는 것이다 — 산 러너를 «끝났다» 고 하지 않는다`);
  }
  assert.ok(HEADLESS_DEAD_SEC * 1000 >= 3 * HEADLESS_TMUX_CALL_TIMEOUT_MS,
    "L27 — 끝남 여유는 tmux 호출 상한의 세 배 이상(붙여넣기 박동은 호출 셋)");
  assert.ok(HEADLESS_DEAD_SEC > HEADLESS_ALIVE_SEC);
});

await t("★ L10·L17 조회가 온전하지 않으면 끝났다고 하지 않는다 — 일시 불통·잘린 출력을 실패로 안 보인다", () => {
  const partial = splitHeadlessRead(`${HDR}screen\n\n<<LVLY-HL-STORED>>\n\n<<LVLY-HL-TOK>>\n`);
  assert.deepEqual(partial, { log: "", stored: false, captured: null, ended: false });
  assert.equal(splitHeadlessRead("").ended, false, "중계가 빈 값을 줬다");
  const cut = splitHeadlessRead(readOut({ log: `${HDR}screen https://x\n`, pid: "", end: false }));
  assert.deepEqual(cut, { log: "", stored: false, captured: null, ended: false },
    "L17 — pid 칸 직후에 잘렸다(끝 표식 없음): «pid 파일 없음» 으로 읽지 않는다");
});

await t("★ L14 실행 id — 비었거나 모양이 틀리면 시작 스크립트를 만들지 않는다", () => {
  const mk = (runId: string) => () => headlessStartSh({ home: "/h", slotName: "s", harness: "claude", runId });
  for (const bad of ["", "abcdef1", "ABCDEF12", "abcd'; rm -rf ~; '", "0".repeat(65)]) {
    assert.throws(mk(bad), /실행 id/, `거절: ${JSON.stringify(bad)}`);
  }
  assert.doesNotThrow(mk("abcdef12"), "경계 — 8글자는 받는다");
  assert.doesNotThrow(mk("0".repeat(64)), "경계 — 64글자는 받는다");
});

await t("★ L1(계약) 시작 스크립트는 흔적을 치우고 → 0600 으로 → 러너보다 먼저 pid 에 이번 실행 id 를 쓴다", () => {
  const c = headlessStartSh({ home: "/h", slotName: "s", harness: "claude", runId: RID });
  const clean = c.indexOf(headlessCleanSh(headlessPaths("/h", "s")));
  const umask = c.indexOf("umask 077");
  const w = c.indexOf(`printf '%s' '${RID}' > '/h/.cache/lvly-hl/s.pid'`);
  const n = c.indexOf("nohup node");
  assert.ok(clean >= 0 && umask >= 0 && w >= 0 && n >= 0, "네 줄이 다 있다");
  assert.ok(clean < umask && umask < w && w < n, "치우기 → umask → pid 쓰기 → 러너 순서(치우기가 뒤면 방금 쓴 주인을 지운다)");
  assert.match(c.slice(n), new RegExp(`'/h/\\.cache/lvly-hl/s\\.tok' '${RID}' tmux `), "러너 인자: tok 다음이 실행 id");
  assert.doesNotThrow(() => new vm.Script(headlessRunnerJs(), { filename: "headless-runner.js" }), "러너 본문이 컴파일된다");
});

await t("★ L22 정리 한 줄 — pid 가 자격 파일보다 앞이고, 실행별 임시 기록까지 지운다", () => {
  const p = headlessPaths("/h", "s");
  const c = headlessCleanSh(p);
  const at = (f: string) => c.indexOf(`'${f}'`);
  for (const f of [p.pid, p.log, p.inp, p.tok, p.stored]) assert.ok(at(f) > 0, `${path.basename(f)} 를 지운다`);
  assert.ok(at(p.pid) < at(p.tok), "pid 먼저 — 자격을 쓴 러너가 재확인에서 자리를 잃었음을 보고 스스로 지운다");
  assert.match(c, /'\/h\/\.cache\/lvly-hl\/s\.log'\.\*\.w /, "실행별 임시 기록(<log>.<id>.w)은 글롭으로");
  assert.ok(at(`${p.log}.w`) > 0, "이전 판의 임시 기록도");
  assert.equal(spawnSync("sh", ["-n", "-c", c], { encoding: "utf8" }).status, 0, "sh 문법으로 온전하다");
  assert.ok(SRC.includes("await runAtLoginSeatSh(osUser, `${headlessCleanSh(p)}; echo ok`)"), "배선 — 취소도 같은 한 줄을 쓴다");
});

await t("★ L21 저장 완료 표시 — 표식을 먼저 쓰고 pid·자격을 지운다", () => {
  const body = SRC.slice(SRC.indexOf("export async function markHeadlessStored"), SRC.indexOf("export async function cancelHeadlessLogin"));
  const mark = body.indexOf("date -u +%Y-%m-%dT%H:%M:%SZ >");
  const rm = body.indexOf("`rm -f ${q(p.pid)} ${q(p.tok)}`");
  assert.ok(mark > 0 && rm > 0 && mark < rm, "사이 조회가 «잡았는데 자격도 주인도 없음» 을 보지 않게");
});

await t("★ 배선 — 상태 경로는 조립 함수 하나로 응답을 만들고, 비밀 값 대신 «있나» 만 넘긴다", () => {
  assert.match(ROUTES, /headlessStateOf\(h, \{ log: got\.log, ended: got\.ended, hasCaptured: !!got\.captured \}, \{ stored, storeError \}\)/);
  assert.ok(!/parseHeadlessLogin\(|headlessLoginStep\(/.test(ROUTES), "경로가 판정을 따로 조립하지 않는다(행동은 flow 시험이 잰다)");
});

await t("★ R18 자리 이름 — 대화형 로그인과 겹치지 않고, 사람마다 다르다", () => {
  assert.match(headlessSlot("box_a", "claude"), /^lvly-hl-claude-[0-9a-f]{8}$/);
  assert.notEqual(headlessSlot("box_a", "claude"), headlessSlot("box_b", "claude"));
  assert.equal(headlessSlot("box_a", "claude"), headlessSlot("box_a", "claude"));
  assert.notEqual(headlessSlot("box_a", "claude"), headlessSlot("box_a", "codex"));
  assert.equal(headlessSeatKey("claude"), "hl-claude", "대화형 로그인 자리(\"claude\")와 다른 자리 키");
});

// ── 실행 계약 ─────────────────────────────────────────────────────────────────

if (process.platform === "win32") {
  console.log("skip R 실행 행 — 윈도우(psmux)");
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hlr-"));
  const bin = path.join(root, "bin");
  const tmp = path.join(root, "t");
  const home = path.join(root, "home");
  for (const d of [bin, tmp, home]) fs.mkdirSync(d, { recursive: true });
  const envOut = path.join(root, "env.out");
  const codeOut = path.join(root, "code.out");
  const go = path.join(root, "go");
  fs.writeFileSync(path.join(bin, "claude"), [
    "#!/bin/sh",
    "[ -t 1 ] || { echo 'not a tty'; exit 3; }",
    `printf '%s\\n' "HOME=$HOME" "UPD=$DISABLE_AUTOUPDATER" "OAUTH=\${CLAUDE_CODE_OAUTH_TOKEN:-none}" "ARGS=$*" > '${envOut}'`,
    "echo \" Browser didn't open? Use the url below to sign in (c to copy)\"",
    "echo 'https://claude.com/cai/oauth/authorize?code=true&scope=user%3Ainference&state=S1'",
    "printf ' Paste code here if prompted > '",
    "read code",
    `printf '%s' "$code" > '${codeOut}'`,
    `if [ "$FAKE_MODE" = notoken ]; then echo ' nope'; exit 0; fi`,
    "echo ' Your OAuth token (valid for 1 year):'",
    `echo ' ${FAKE_TOKEN}'`,
    "exit 0",
  ].join("\n"), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "codex"), [
    "#!/bin/sh",
    `printf '%s\\n' "CODEX_HOME=$CODEX_HOME" "ARGS=$*" > '${envOut}'`,
    "echo '   https://auth.openai.com/codex/device'",
    "echo '   WXYZ-12345'",
    `while [ ! -f '${go}' ]; do sleep 0.1; done`,
    `if [ "$FAKE_MODE" = fail ]; then echo 'Error: denied'; exit 1; fi`,
    `printf '{"tokens":{"access_token":"a","refresh_token":"r","account_id":"acc"}}' > "$CODEX_HOME/auth.json"`,
    "exit 0",
  ].join("\n"), { mode: 0o755 });

  //  tmux 대역(L3·L27) — 진짜 tmux 로 넘기되, $HL_SLOW 파일이 있으면 붙여넣기(send-keys)·화면 캡처를 늦춘다.
  //   느린 호출 안에 있는 동안 `$HL_SLOW.in` 에 그 동사가 적혀 있다 — 시험은 그 순간을 기다렸다가 움직인다.
  const which = (c: string) => (spawnSync("sh", ["-c", `command -v ${c}`], { encoding: "utf8" }).stdout || "").trim();
  const realTmux = which("tmux");
  const slowFlag = path.join(root, "slow-capture");
  const SLOW_MS = 800;
  if (realTmux) {
    fs.writeFileSync(path.join(bin, "tmux"), [
      "#!/bin/sh",
      `case "$4" in send-keys|capture-pane) if [ -n "$HL_SLOW" ] && [ -f "$HL_SLOW" ]; then echo "$4" > "$HL_SLOW.in"; sleep ${SLOW_MS / 1000}; rm -f "$HL_SLOW.in"; fi;; esac`,
      `exec '${realTmux}' "$@"`,
    ].join("\n"), { mode: 0o755 });
  }

  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, FAKE_MODE: process.env.FAKE_MODE, OAUTH: process.env.CLAUDE_CODE_OAUTH_TOKEN, HL_SLOW: process.env.HL_SLOW };
  process.env.HOME = home;                                              // loginHomeOf(null) = 이 HOME
  process.env.PATH = `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`;
  process.env.TMPDIR = tmp;                                             // 러너의 임시 HOME 이 여기 생긴다(정리 확인용)
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "parent-secret-should-not-leak";
  const P = (h: "claude" | "codex") => headlessPaths(home, headlessSlot(null, h));
  const tmpLeft = () => fs.readdirSync(tmp).filter((n) => n.startsWith("lvly-hl-"));
  //  러너 프로세스가 살아 있나 — 명령줄의 이름표(슬롯)로 본다. **시험에서만** 쓰는 관측이다(제품 코드는 pid·이름으로
  //   찾지 않는다 — R16). 파이프 러너는 자식이 끝나면 임시 폴더부터 지우므로 폴더만으로는 «러너 종료» 를 못 잰다.
  const runnerAlive = (h: "claude" | "codex") => {
    const slot = headlessSlot(null, h);
    return (spawnSync("ps", ["-e", "-o", "args="], { encoding: "utf8" }).stdout || "")
      .split("\n").some((l) => l.includes(" -e ") && l.includes(slot) && !l.startsWith("sh "));
  };
  const exists = (f: string) => fs.existsSync(f);
  const reset = () => {
    for (const f of [envOut, codeOut, go, slowFlag, `${slowFlag}.in`]) fs.rmSync(f, { force: true });
    delete process.env.FAKE_MODE; delete process.env.HL_SLOW;
  };
  /** 자리 폴더에 남은 기록 임시 파일(<log>.<id>.w · 이전 판 <log>.w). */
  const wFiles = (pp: ReturnType<typeof headlessPaths>) =>
    (fs.existsSync(pp.dir) ? fs.readdirSync(pp.dir) : []).filter((n) => n.endsWith(".w"));
  const mkfifo = (f: string) => {
    const r = spawnSync("mkfifo", [f], { encoding: "utf8" });
    assert.equal(r.status, 0, `mkfifo: ${r.stderr}`);
  };
  /**
   * FIFO 를 막힘 없이 열고, 쓰는 쪽이 쓰고 닫을 때까지 비운다(L23·L24 — 러너의 쓰기를 붙잡아 두는 장치).
   *  쓰는 쪽이 붙기 전의 EOF 는 «아직» 으로 본다. 끝내 안 오면 상한에서 받은 만큼 돌려준다.
   */
  async function drainFifo(f: string, ms = 5000): Promise<string> {
    const fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const buf = Buffer.alloc(65536);
    let out = "";
    const until = Date.now() + ms;
    try {
      while (Date.now() < until) {
        let n = 0;
        try { n = fs.readSync(fd, buf, 0, buf.length, null); } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EAGAIN" || (e as NodeJS.ErrnoException).code === "EWOULDBLOCK") { await sleep(20); continue; }
          throw e;
        }
        if (n > 0) { out += buf.toString("utf8", 0, n); continue; }
        if (out) return out;
        await sleep(20);
      }
      return out;
    } finally { fs.closeSync(fd); }
  }
  const exitOf = (c: ReturnType<typeof spawn>) => new Promise<number | null>((r) => c.on("exit", (code) => r(code)));
  const within = <T>(pr: Promise<T>, ms: number) => Promise.race([pr, sleep(ms).then(() => "timeout" as const)]);

  const tmuxV = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  const haveTmux = tmuxV.status === 0 && !/psmux/i.test(`${tmuxV.stdout}${tmuxV.stderr}`);
  try {
    if (!haveTmux) console.log("skip R1~R9·R12 실행 행 — tmux 없음(claude 는 tmux 가 필수다)");
    else {
      const p = P("claude");
      await t("★ R19 러너가 정리 못 하고 죽어도 창이 스스로 내려간다 — tmux 서버가 고아로 남지 않는다", async () => {
        const sock = path.join(tmp, "wd.sock");
        const tm = (...a: string[]) => spawnSync("tmux", ["-S", sock, ...a], { encoding: "utf8", env: { ...process.env, SHELL: "/bin/sh", LVLY_HL_HOME: tmp } });
        //  러너 없이 창만 띄운다(= 러너가 죽은 상황). 코드를 영영 기다리는 CLI 대역 — 시계가 없으면 서버는 안 끝난다.
        try {
          const r = tm("-f", "/dev/null", "new-session", "-d", "-s", "wd", "-x", "80", "-y", "10", headlessPaneCmd(["sh", "-c", "sleep 300"], 2));
          assert.equal(r.status, 0, `창을 띄웠다: ${r.stderr}`);
          assert.equal(tm("has-session", "-t", "wd").status, 0, "배선 — 처음엔 살아 있다");
          await waitFor("시계가 창을 내리고 서버가 끝난다", () => tm("has-session", "-t", "wd").status !== 0, 8000);
        } finally {
          tm("kill-server");   // 시계가 실패했을 때 이 시험이 고아를 남기지 않게
          fs.rmSync(sock, { force: true });
        }
      });

      await t("★ R1·R4·R5·R6 시작 → 코드 넣기 → 토큰은 0600 파일로, 로그엔 표식만", async () => {
        reset();
        await startHeadlessLogin(null, "claude", null);
        await waitFor("주소가 로그에 뜬다", () => exists(p.log) && fs.readFileSync(p.log, "utf8").includes("claude.com/cai/oauth"));
        const first = await readHeadlessLogin(null, "claude");
        assert.match(first.log, /Paste code here if prompted/, "그려진 화면에서 프롬프트가 읽힌다(R1)");
        assert.equal(first.captured, null);
        assert.equal(first.ended, false, "산 러너는 끝나지 않았다");
        assert.ok(!first.log.includes(HEADLESS_RUN_MARK), "조회는 기록 머리 줄을 뗀다");
        const owner = fs.readFileSync(p.pid, "utf8");
        assert.match(owner, /^[0-9a-f]{18}$/, "pid 파일 = 이번 실행 id");
        assert.ok(fs.readFileSync(p.log, "utf8").startsWith(`${HEADLESS_RUN_MARK} ${owner}\n`), "기록 첫 줄 = 같은 id");
        assert.equal(runnerAlive("claude"), true, "배선 — 관측 장치가 살아 있는 러너를 실제로 본다(안 보면 «끝났다» 단언이 전부 헛것이다)");
        await pasteHeadlessLogin(null, "claude", "abcd1234#state-xyz");
        await waitFor("토큰 파일", () => exists(p.tok));
        assert.equal(fs.readFileSync(codeOut, "utf8"), "abcd1234#state-xyz", "CLI 가 정확히 그 코드를 받았다(R4)");
        assert.equal(fs.statSync(p.tok).mode & 0o777, 0o600, "자격 파일은 0600(R5)");
        assert.equal(fs.statSync(p.dir).mode & 0o777, 0o700, "그 폴더는 0700(R5)");
        await waitFor("로그에 표식", () => fs.readFileSync(p.log, "utf8").includes(TOKEN_CAPTURED_MARK));
        const r = await readHeadlessLogin(null, "claude");
        assert.equal(r.captured, FAKE_TOKEN, "잡은 값이 토큰 그대로다");
        assert.ok(!r.log.includes("sk-ant-"), "로그에는 토큰이 없다(R5)");
        const env = fs.readFileSync(envOut, "utf8");
        assert.match(env, /^UPD=1$/m, "자동 업데이트를 끈다(R6)");
        assert.match(env, /^OAUTH=none$/m, "부모의 자격 env 를 물려받지 않는다(R6)");
        const cliHome = (env.match(/^HOME=(.*)$/m) || [])[1] || "";
        assert.ok(cliHome.startsWith(tmp) && cliHome !== home, `CLI HOME 은 멤버 홈이 아닌 임시 폴더다(R6): ${cliHome}`);
        assert.match(env, /^ARGS=setup-token$/m);
      });

      await t("★ R2 살아 있는데 또 시작하면 그대로 둔다(러너 하나)", async () => {
        const before = fs.readFileSync(p.pid, "utf8");
        await startHeadlessLogin(null, "claude", null);
        await sleep(1200);
        assert.equal(fs.readFileSync(p.pid, "utf8"), before, "새 러너가 pid 를 덮지 않았다");
        assert.ok(exists(p.tok), "지난 시도의 자격 파일을 지우지 않았다");
      });

      await t("★ R7 저장 완료 → 러너가 끝나고, 로그·저장 표식만 남는다", async () => {
        await markHeadlessStored(null, "claude");
        assert.ok(!exists(p.tok), "자격 파일을 지웠다");
        await waitFor("러너가 끝나고 임시 HOME 이 사라진다", () => !runnerAlive("claude") && tmpLeft().length === 0);
        const r = await readHeadlessLogin(null, "claude");
        assert.equal(r.stored, true);
        assert.equal(r.captured, null);
        assert.equal(r.ended, true, "러너는 끝났다(저장 표식이 이긴다 — flow L11)");
        assert.ok(exists(p.log), "로그는 남는다(화면이 끝난 모습을 그린다)");
        assert.ok(!exists(p.pid), "pid 파일이 되살아나지 않았다");
      });

      await t("★ R8 취소 → 러너가 끝나고 흔적이 없다", async () => {
        await cancelHeadlessLogin(null, "claude");
        for (const f of [p.log, p.stored, p.tok, p.pid, p.inp]) assert.ok(!exists(f), `${path.basename(f)} 가 없다`);
        reset();
        await startHeadlessLogin(null, "claude", null);
        await waitFor("새 러너가 돈다", () => runnerAlive("claude") && tmpLeft().length === 1 && exists(p.pid));
        await cancelHeadlessLogin(null, "claude");
        await waitFor("취소 뒤 러너 정리", () => !runnerAlive("claude") && tmpLeft().length === 0);
        assert.ok(!exists(p.pid) && !exists(p.log));
        const gone = await readHeadlessLogin(null, "claude");
        assert.deepEqual({ ended: gone.ended, log: gone.log, stored: gone.stored }, { ended: false, log: "", stored: false },
          "취소는 흔적째 치운다 — 빈 자리는 «끝남» 이 아니라 모름이다(L15, 아무도 조회하지 않는다)");
        //  정상 정리(kill-server)는 창의 시계까지 함께 내린다 — 남으면 발급마다 25분짜리 sleep 이 쌓인다.
        await waitFor("창 시계도 사라진다", () => !(spawnSync("ps", ["-e", "-o", "args="], { encoding: "utf8" }).stdout || "")
          .split("\n").some((l) => l.trim() === `sleep ${HEADLESS_PANE_WATCHDOG_SEC}`), 4000);
      });

      await t("★ R9 새 시도가 자리를 차지하면 옛 러너가 물러난다 — 남의 pid 파일은 건드리지 않는다", async () => {
        reset();
        await startHeadlessLogin(null, "claude", null);
        await waitFor("러너가 돈다", () => runnerAlive("claude") && tmpLeft().length === 1 && exists(p.pid));
        await waitFor("옛 러너의 화면", () => exists(p.log) && fs.readFileSync(p.log, "utf8").includes("claude.com/cai/oauth"));
        fs.writeFileSync(p.pid, "someone-else");
        await waitFor("옛 러너 정리", () => !runnerAlive("claude") && tmpLeft().length === 0);
        assert.equal(fs.readFileSync(p.pid, "utf8"), "someone-else");
        const r = await readHeadlessLogin(null, "claude");
        assert.equal(r.log, "", "L4 — 새 주인에게 옛 러너의 주소를 보이지 않는다");
        assert.equal(r.ended, false, "자리는 새 주인이 쥐고 있다(시작 중)");
        fs.rmSync(p.pid, { force: true });
      });

      await t("★ R3 심박이 멈춘 pid 파일은 죽은 것으로 본다", async () => {
        await cancelHeadlessLogin(null, "claude");
        fs.writeFileSync(p.pid, "stale");
        //  죽은 시도가 남긴 흔적 — 안 거둔 자격·저장 표식·옛 화면. 새 시도는 이것들을 **먼저** 치워야 한다
        //   (안 치우면 옛 자격이 새 시도의 것으로 저장되거나, 화면이 옛 «끝났다» 를 보여 준다).
        fs.writeFileSync(p.tok, "old-secret", { mode: 0o600 });
        fs.writeFileSync(p.stored, "old");
        fs.writeFileSync(p.log, "OLD SCREEN https://claude.com/cai/oauth/authorize?state=OLD");
        const old = new Date(Date.now() - (HEADLESS_DEAD_SEC + 5) * 1000);
        fs.utimesSync(p.pid, old, old);
        //  L7(실행) — 정리 없이 사라진 러너: 조회가 «끝났다» 고 말한다(화면이 영영 «코드를 넣으세요» 로 남지 않는다).
        const dead = await readHeadlessLogin(null, "claude");
        assert.equal(dead.ended, true, "심박이 멈춘 자리는 끝난 것이다");
        const out = spawnSync("sh", ["-c", headlessStartSh({ home, slotName: headlessSlot(null, "claude"), harness: "claude", runId: RID })], { encoding: "utf8" });
        assert.equal(out.stdout.trim(), "started", `멈춘 자리를 새로 띄운다: ${out.stdout}${out.stderr}`);
        assert.equal(fs.readFileSync(p.pid, "utf8"), RID, "새 시도가 주인이다");
        await waitFor("새 러너가 돈다", () => runnerAlive("claude") && tmpLeft().length === 1);
        assert.ok(!exists(p.tok), "지난 시도의 자격 파일을 치웠다");
        assert.ok(!exists(p.stored), "지난 시도의 저장 표식을 치웠다");
        assert.ok(!exists(p.log) || !fs.readFileSync(p.log, "utf8").includes("state=OLD"), "옛 화면을 치웠다");
        await cancelHeadlessLogin(null, "claude");
        await waitFor("정리", () => tmpLeft().length === 0);
      });

      await t("★ R12 토큰 없이 끝나면 러너가 스스로 끝나고 종료 줄을 남긴다", async () => {
        reset();
        process.env.FAKE_MODE = "notoken";
        await startHeadlessLogin(null, "claude", null);
        await waitFor("프롬프트", () => exists(p.log) && fs.readFileSync(p.log, "utf8").includes("Paste code here"));
        await pasteHeadlessLogin(null, "claude", "code-9");
        await waitFor("러너 스스로 종료", () => !runnerAlive("claude") && tmpLeft().length === 0 && !exists(p.pid));
        const r = await readHeadlessLogin(null, "claude");
        assert.ok(r.log.includes(`${EXIT_MARK} 0`), "종료 줄이 남는다");
        assert.equal(r.ended, true, "끝난 러너의 기록은 버리지 않는다(종료 사유가 화면에 가야 한다)");
        assert.equal(r.captured, null);
        assert.ok(!exists(p.tok));
        await cancelHeadlessLogin(null, "claude");
      });

      await t("★ L1(실행) 시작 직후 — 러너가 뜨기 전에 이미 이번 실행이 자리의 주인이고, 기록 첫 줄이 같은 id", async () => {
        reset();
        await cancelHeadlessLogin(null, "claude");
        const out = spawnSync("sh", ["-c", headlessStartSh({ home, slotName: headlessSlot(null, "claude"), harness: "claude", runId: RID })], { encoding: "utf8" });
        assert.equal(out.stdout.trim(), "started", `${out.stdout}${out.stderr}`);
        assert.equal(fs.readFileSync(p.pid, "utf8"), RID, "스크립트가 돌아온 그 순간 주인이 있다");
        assert.equal(fs.statSync(p.pid).mode & 0o777, 0o600, "pid 파일은 0600(umask 077 뒤에 쓴다)");
        const early = await readHeadlessLogin(null, "claude");
        assert.equal(early.ended, false, "뜨는 중인 러너를 «끝났다» 고 하지 않는다");
        await waitFor("기록 머리", () => exists(p.log) && fs.readFileSync(p.log, "utf8").startsWith(`${HEADLESS_RUN_MARK} ${RID}\n`));
        await waitFor("주소", () => fs.readFileSync(p.log, "utf8").includes("claude.com/cai/oauth"));
        assert.equal(fs.readFileSync(p.pid, "utf8"), RID, "러너가 주인을 바꾸지 않는다");
        await cancelHeadlessLogin(null, "claude");
        await waitFor("정리", () => !runnerAlive("claude") && tmpLeft().length === 0);
      });

      await t("★ L2 러너가 뜨기 전에 자리를 잃었으면(취소 · 새 시도) CLI 를 띄우지도 기록을 쓰지도 않는다", async () => {
        reset();
        await cancelHeadlessLogin(null, "claude");
        const ran = path.join(root, "pane-ran");
        //  임시 폴더 자리에 **파일**을 둔다 — 주인이 아닌 러너가 임시 HOME 을 만들려 들면 그 자리에서 죽는다(ENOTDIR,
        //   root 로 돌아도 같다). 즉 종료코드 0 은 «아무것도 만들기 전에 물러났다» 는 뜻이다.
        const notDir = path.join(root, "tmp-is-a-file");
        fs.writeFileSync(notDir, "x");
        const run = () => spawnSync(process.execPath, ["-e", headlessRunnerJs(), "hl-test", p.log, p.inp, p.pid, p.tok, RID,
          "tmux", realTmux, headlessPaneCmd(["sh", "-c", `touch '${ran}'; sleep 30`], 40)],
        { encoding: "utf8", timeout: 8000, env: { ...process.env, TMPDIR: notDir } });
        const gone = run();
        assert.equal(gone.status, 0, `pid 파일이 없으면 곧바로 끝난다: ${gone.stderr}`);
        fs.writeFileSync(p.pid, "another-run-id");
        const taken = run();
        assert.equal(taken.status, 0, `남이 쥔 자리면 곧바로 끝난다: ${taken.stderr}`);
        assert.equal(fs.readFileSync(p.pid, "utf8"), "another-run-id", "남의 pid 파일을 건드리지 않았다");
        assert.ok(!exists(ran), "CLI(창)를 띄우지 않았다");
        assert.ok(!exists(p.log) && wFiles(p).length === 0, "기록도 임시 기록도 쓰지 않았다");
        assert.equal(tmpLeft().length, 0, "임시 HOME 도 안 만들었다");
        fs.writeFileSync(p.pid, RID);
        const own = run();
        assert.notEqual(own.status, 0, "배선 — 자리의 주인이면 임시 HOME 을 만들러 가서, 이 자리에서는 실제로 죽는다");
        fs.rmSync(p.pid, { force: true });
      });

      await t("★ L3 캡처 도중 취소 — 러너가 지운 기록을 되살리지 않는다(실측: 매니지드 3회 중 2회 옛 주소가 돌아왔다)", async () => {
        reset();
        process.env.HL_SLOW = slowFlag;
        await startHeadlessLogin(null, "claude", null);
        await waitFor("주소", () => exists(p.log) && fs.readFileSync(p.log, "utf8").includes("claude.com/cai/oauth"));
        fs.writeFileSync(slowFlag, "1");
        await waitFor("러너가 느린 캡처 안에 있다", () => exists(`${slowFlag}.in`), 4000);
        await cancelHeadlessLogin(null, "claude");
        assert.ok(!exists(p.log), "배선 — 취소가 기록을 지웠다");
        await waitFor("캡처가 끝났다", () => !exists(`${slowFlag}.in`), 4000);
        await waitFor("러너 정리", () => !runnerAlive("claude") && tmpLeft().length === 0, 6000);
        assert.ok(!exists(p.log), "기록이 되살아나지 않았다");
        assert.deepEqual(wFiles(p), [], "쓰다 만 기록도 없다");
        assert.ok(!exists(p.pid) && !exists(p.tok), "주인·자격 파일도 없다");
        const r = await readHeadlessLogin(null, "claude");
        assert.deepEqual({ ended: r.ended, log: r.log }, { ended: false, log: "" },
          "빈 자리 — 흔적이 없으면 «끝났다» 고 하지 않는다(L15, 화면은 조회를 멈췄다)");
        reset();
      });

      await t("★ L27 느린 tmux 호출 — 붙여넣기 박동(send-keys ×2 → capture)에서도 호출마다 직전에 심박을 찍는다", async () => {
        reset();
        process.env.HL_SLOW = slowFlag;
        await startHeadlessLogin(null, "claude", null);
        await waitFor("프롬프트", () => exists(p.log) && fs.readFileSync(p.log, "utf8").includes("Paste code here"));
        fs.writeFileSync(slowFlag, "1");
        await pasteHeadlessLogin(null, "claude", "slow-code-1");
        const seen: string[] = [];
        let age = -1;
        const until = Date.now() + 10_000;
        while (Date.now() < until && age < 0) {
          let v = "";
          try { v = fs.readFileSync(`${slowFlag}.in`, "utf8").trim(); } catch { /* 호출과 호출 사이 */ }
          if (v && seen[seen.length - 1] !== v) {
            seen.push(v);
            if (v === "capture-pane" && seen.includes("send-keys")) age = Date.now() - fs.statSync(p.pid).mtimeMs;
          }
          await sleep(40);
        }
        assert.ok(seen.includes("send-keys"), `배선 — 붙여넣기 호출이 느리게 돌았다: ${seen.join(",")}`);
        assert.ok(age >= 0, `붙여넣기 뒤의 캡처를 잡았다: ${seen.join(",")}`);
        assert.ok(age < SLOW_MS, `캡처 직전에 심박을 찍었다(느린 send-keys 둘만큼 묵은 심박이 아니다): ${Math.round(age)}ms`);
        fs.rmSync(slowFlag, { force: true });
        await cancelHeadlessLogin(null, "claude");
        await waitFor("정리", () => !runnerAlive("claude") && tmpLeft().length === 0);
        reset();
      });

      await t("★ L23 자격을 쓰는 도중 자리를 잃으면 — 쓴 뒤 재확인이 자격 파일을 지운다(FIFO 로 쓰기를 붙잡아 재현)", async () => {
        reset();
        await startHeadlessLogin(null, "claude", null);
        await waitFor("프롬프트", () => exists(p.log) && fs.readFileSync(p.log, "utf8").includes("Paste code here"));
        mkfifo(p.tok);
        await pasteHeadlessLogin(null, "claude", "fifo-code-1");
        await waitFor("CLI 가 코드를 받았다", () => exists(codeOut));
        await waitFor("러너가 자격 쓰기에 붙잡혔다(심박이 끊겼다)", () => Date.now() - fs.statSync(p.pid).mtimeMs > 1200, 6000);
        fs.rmSync(p.pid);                                     // 자리를 잃는다(취소 · 새 시도)
        const got = await drainFifo(p.tok);
        assert.equal(got, FAKE_TOKEN, "배선 — 러너가 실제로 이 자리에 자격을 쓰고 있었다");
        await waitFor("러너 정리", () => !runnerAlive("claude") && tmpLeft().length === 0);
        assert.ok(!exists(p.tok), "자리를 잃은 러너가 방금 쓴 자격 파일을 지웠다(비밀이 남지 않는다)");
        await cancelHeadlessLogin(null, "claude");
      });

      await t("★ L24 기록 임시 파일을 쓰는 도중 자리를 잃으면 — 기록도 임시 파일도 안 남고 CLI 를 안 띄운다(FIFO)", async () => {
        reset();
        await cancelHeadlessLogin(null, "claude");
        fs.mkdirSync(p.dir, { recursive: true });
        const w = `${p.log}.${RID}.w`;
        const ran = path.join(root, "pane-ran-l24");
        fs.writeFileSync(p.pid, RID);
        mkfifo(w);
        const child = spawn(process.execPath, ["-e", headlessRunnerJs(), "hl-test", p.log, p.inp, p.pid, p.tok, RID,
          "tmux", realTmux, headlessPaneCmd(["sh", "-c", `touch '${ran}'; sleep 30`], 40)], { stdio: "ignore" });
        const exited = exitOf(child);
        await waitFor("러너가 임시 HOME 을 만들고 기록 쓰기에 들어갔다", () => tmpLeft().length === 1);
        await sleep(400);
        assert.ok(!exists(p.log), "배선 — 아직 바꿔 끼우지 못했다(FIFO 에 붙잡혀 있다)");
        fs.rmSync(p.pid);
        const got = await drainFifo(w);
        assert.ok(got.startsWith(`${HEADLESS_RUN_MARK} ${RID}\n`), `배선 — 러너가 이 임시 파일에 쓰고 있었다: ${JSON.stringify(got.slice(0, 40))}`);
        assert.equal(await within(exited, 6000), 0, "러너가 스스로 끝났다");
        assert.ok(!exists(w), "임시 파일을 지웠다");
        assert.ok(!exists(p.log), "기록을 바꿔 끼우지 않았다");
        assert.ok(!exists(ran), "CLI(창)를 띄우지 않았다");
        assert.equal(tmpLeft().length, 0);
      });
    }

    await t("★ L9·L18(실행) stat 이 없거나 이상한 값을 내도 조회 스크립트가 끝까지 돌고, 나이는 «모름» 이다", () => {
      const pc = P("claude");
      fs.mkdirSync(pc.dir, { recursive: true });
      fs.writeFileSync(pc.pid, RID);
      const shells = [...new Set(["/bin/sh", which("dash"), which("bash")].filter(Boolean))];
      const fake = (out: string) => `#!/bin/sh\nprintf '${out}'\n`;
      //  [이름, stat(없음 null · 진짜 "real" · 가짜 출력), date(진짜 "real" · 가짜 출력)]
      const variants: Array<[string, string | null, string]> = [
        ["stat 없음", null, "real"],
        ["stat 이 시:분", fake("12:34\\n"), "real"],
        ["stat 앞자리 0", fake("0899\\n"), "real"],
        ["stat 여러 줄", fake("1\\n2\\n"), "real"],
        ["date 앞자리 0", "real", fake("0123\\n")],
      ];
      try {
        for (const [name, st, dt] of variants) {
          const nb = fs.mkdtempSync(path.join(root, "nb-"));
          fs.symlinkSync(which("cat"), path.join(nb, "cat"));
          for (const [tool, v] of [["stat", st], ["date", dt]] as const) {
            if (v === "real") fs.symlinkSync(which(tool), path.join(nb, tool));
            else if (v) fs.writeFileSync(path.join(nb, tool), v, { mode: 0o755 });
          }
          for (const sh of shells) {
            const o = spawnSync(sh, ["-c", headlessReadSh(pc)], { encoding: "utf8", env: { PATH: nb } });
            assert.equal(o.status, 0, `${name} · ${sh}: 조회가 끝까지 돈다 — ${o.stderr}`);
            assert.match(o.stdout, new RegExp(`<<LVLY-HL-PID>>\\n\\? ${RID}\\n<<LVLY-HL-END>>\\n$`), `${name} · ${sh}: 나이 자리에 ?`);
            assert.equal(splitHeadlessRead(o.stdout).ended, false, `${name} · ${sh}`);
          }
        }
        assert.ok(shells.length >= 1);
        const full = spawnSync("/bin/sh", ["-c", headlessReadSh(pc)], { encoding: "utf8" });
        assert.match(full.stdout, new RegExp(`<<LVLY-HL-PID>>\\n\\d+ ${RID}\\n<<LVLY-HL-END>>\\n$`), "배선 — 진짜 stat 이면 숫자 나이");
      } finally {
        fs.rmSync(pc.pid, { force: true });
      }
    });

    const x = P("codex");
    await t("★ R13 codex — 따로 된 CODEX_HOME 의 auth.json 이 자격 파일이 되고, 잡음 줄이 종료 줄보다 먼저다", async () => {
      reset();
      await startHeadlessLogin(null, "codex", null);
      await waitFor("주소·코드", () => exists(x.log) && fs.readFileSync(x.log, "utf8").includes("WXYZ-12345"));
      assert.ok(fs.readFileSync(x.log, "utf8").startsWith(`${HEADLESS_RUN_MARK} ${fs.readFileSync(x.pid, "utf8")}\n`),
        "codex 기록도 첫 줄이 이번 실행 id 다(파이프 모드)");
      const cxRead = await readHeadlessLogin(null, "codex");
      assert.match(cxRead.log, /^\s*https:\/\/auth\.openai\.com/m, "조회가 codex 화면을 준다");
      assert.ok(!cxRead.log.includes(HEADLESS_RUN_MARK), "조회는 머리 줄을 떼고 준다");
      const env = fs.readFileSync(envOut, "utf8");
      const cxHome = (env.match(/^CODEX_HOME=(.*)$/m) || [])[1] || "";
      assert.ok(cxHome.startsWith(tmp), `멤버의 ~/.codex 가 아니라 임시 폴더다: ${cxHome}`);
      assert.match(env, /^ARGS=-c cli_auth_credentials_store=file login --device-auth$/m);
      fs.writeFileSync(go, "1");
      await waitFor("자격 파일", () => exists(x.tok));
      assert.equal(fs.statSync(x.tok).mode & 0o777, 0o600);
      assert.match(fs.readFileSync(x.tok, "utf8"), /"account_id":"acc"/);
      await waitFor("종료 줄", () => fs.readFileSync(x.log, "utf8").includes(EXIT_MARK));
      const log = fs.readFileSync(x.log, "utf8");
      assert.ok(log.indexOf(CAPTURED_LINE) >= 0 && log.indexOf(CAPTURED_LINE) < log.indexOf(EXIT_MARK), "잡음 → 종료 순서");
      assert.ok(!fs.existsSync(cxHome), "CODEX_HOME 임시 폴더를 지웠다");
      await sleep(700);
      assert.ok(runnerAlive("codex") && exists(x.pid), "안 거둔 자격이 있으니 러너는 기다린다");
      await markHeadlessStored(null, "codex");
      await waitFor("러너 종료", () => !runnerAlive("codex"));
      await cancelHeadlessLogin(null, "codex");
    });

    await t("★ R14 codex 가 실패로 끝나면 자격 파일이 없고 러너가 끝난다", async () => {
      reset();
      process.env.FAKE_MODE = "fail";
      await startHeadlessLogin(null, "codex", null);
      await waitFor("주소·코드", () => exists(x.log) && fs.readFileSync(x.log, "utf8").includes("WXYZ-12345"));
      fs.writeFileSync(go, "1");
      await waitFor("러너 종료", () => !runnerAlive("codex") && !exists(x.pid) && tmpLeft().length === 0);
      const r = await readHeadlessLogin(null, "codex");
      assert.ok(r.log.includes(`${EXIT_MARK} 1`));
      assert.ok(!r.log.includes(CAPTURED_LINE));
      assert.equal(r.captured, null);
      await cancelHeadlessLogin(null, "codex");
    });

    await t("★ L25 codex — 옛 기록이 남아 있어도 새 실행의 머리 줄이 첫 줄이다(덧붙이기로 가려지지 않는다)", async () => {
      reset();
      await cancelHeadlessLogin(null, "codex");
      fs.mkdirSync(x.dir, { recursive: true });
      fs.writeFileSync(x.log, `${HEADLESS_RUN_MARK} ffffeeee00001111\nOLD https://auth.openai.com/codex/device\n   OLDX-99999\n`);
      fs.writeFileSync(x.pid, RID);
      const child = spawn(process.execPath, ["-e", headlessRunnerJs(), "hl-test", x.log, x.inp, x.pid, x.tok, RID,
        "pipe", "-", ...headlessLoginArgv("codex")], { stdio: "ignore" });
      const exited = exitOf(child);
      await waitFor("새 실행의 코드", () => exists(x.log) && fs.readFileSync(x.log, "utf8").includes("WXYZ-12345"));
      const raw = fs.readFileSync(x.log, "utf8");
      assert.ok(raw.startsWith(`${HEADLESS_RUN_MARK} ${RID}\n`), `첫 줄이 이번 실행 id: ${JSON.stringify(raw.slice(0, 40))}`);
      assert.ok(!raw.includes("OLD"), "옛 기록 위에 덧붙이지 않았다(바꿔 끼웠다)");
      assert.match((await readHeadlessLogin(null, "codex")).log, /WXYZ-12345/, "조회가 새 실행의 화면을 보여 준다");
      assert.deepEqual(wFiles(x), [], "임시 기록이 남지 않았다");
      await cancelHeadlessLogin(null, "codex");
      assert.equal(await within(exited, 6000), 0, "취소하면 러너가 끝난다");
    });

    await t("★ R10 CLI 가 없으면 시작하지 못했다고 말한다", async () => {
      const savedPath = process.env.PATH;
      process.env.PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
      try {
        await assert.rejects(() => startHeadlessLogin(null, "codex", null), /codex 없음|띄우지 못했습니다/);
      } finally { process.env.PATH = savedPath; }
    });
  } finally {
    for (const h of ["claude", "codex"] as const) await cancelHeadlessLogin(null, h).catch(() => undefined);
    await sleep(800);
    process.env.HOME = saved.HOME; process.env.PATH = saved.PATH;
    if (saved.TMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved.TMPDIR;
    if (saved.FAKE_MODE === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = saved.FAKE_MODE;
    if (saved.OAUTH === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.OAUTH;
    if (saved.HL_SLOW === undefined) delete process.env.HL_SLOW; else process.env.HL_SLOW = saved.HL_SLOW;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed`);

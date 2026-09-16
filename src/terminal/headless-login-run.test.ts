// 헤드리스 자격 발급 러너의 **실행 계약** (#4051) — 가짜 CLI + 실제 tmux 로 부작용을 본다.
//
//  왜 문자열 검사로 끝내지 않나: 이 러너의 결함은 전부 «띄웠다» 는 신호가 정상인 채로 조용히 난다(ai-login-run 의
//   교훈 — 인자 밀림 · 자기참조 pgrep). 그래서 실제로 띄우고 **파일·권한·환경**을 관찰한다. 셀프호스트 경로
//   (osUser=null · 세션 경계 중계 없음)는 로컬 sh 로 돌므로, 임시 HOME 에서 공개 함수를 그대로 부른다.
//  행 번호(R1…)는 스크래치패드 spec.md 의 엣지 표다.
//  ⚠ 윈도우는 통째로 건너뛴다(psmux 는 tmux 흉내를 내며 -S 를 무시한다 — terminal-sessions E12 의 교훈).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  headlessSlot, headlessPaths, headlessStartSh, headlessReadSh, splitHeadlessRead, headlessPaneCmd, headlessRunnerJs,
  startHeadlessLogin, readHeadlessLogin, pasteHeadlessLogin, markHeadlessStored, cancelHeadlessLogin,
  HEADLESS_RUN_LIMIT_MS, HEADLESS_ALIVE_SEC, HEADLESS_PANE_WATCHDOG_SEC, headlessSeatKey,
} from "./headless-login-run.js";
import { EXIT_MARK } from "./ai-login-flow.js";
import { CAPTURED_LINE, TOKEN_CAPTURED_MARK } from "./headless-login-flow.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, pred: () => boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return; await sleep(100); }
  assert.fail(`기다렸지만 오지 않았다: ${what}`);
}
const SRC = fs.readFileSync(new URL("./headless-login-run.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const FAKE_TOKEN = "sk-ant-oat01-" + "Zz9_-".repeat(18) + "tailAA";

// ── 순수 계약 ─────────────────────────────────────────────────────────────────

await t("★ R16 pid 로 찾거나 죽이지 않는다 — 컨테이너가 다르면 엉뚱한 프로세스를 겨눈다", () => {
  const shells = [headlessStartSh({ home: "/h", slotName: "s", harness: "claude" }),
    headlessStartSh({ home: "/h", slotName: "s", harness: "codex" }), headlessReadSh(headlessPaths("/h", "s"))].join("\n");
  assert.ok(shells.length > 500, "배선 — 스크립트를 실제로 만들었다");
  for (const bad of [/\bpgrep\b/, /\bpkill\b/, /kill -0/, /\bkill\s+"?\$\(/]) {
    assert.ok(!bad.test(shells), `스크립트에 ${bad} 가 없다`);
    assert.ok(!bad.test(SRC.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n")), `모듈 소스에 ${bad} 가 없다`);
  }
  assert.match(shells, /stat -c %Y[^\n]*stat -f %m/, "생존은 심박(파일 시각)으로 잰다 — GNU·BSD 둘 다");
  assert.equal(HEADLESS_ALIVE_SEC, 5);
});

await t("★ R11·R10 없는 도구는 127 로 말한다 — tmux 는 claude 에만 요구한다", () => {
  const c = headlessStartSh({ home: "/h", slotName: "s", harness: "claude" });
  const x = headlessStartSh({ home: "/h", slotName: "s", harness: "codex" });
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

await t("★ R17 조회 결과 쪼개기 — 세 칸 · 구분자 없음 · 빈 자격", () => {
  const ok = splitHeadlessRead(`line1\nline2\n\n<<LVLY-HL-STORED>>\n2026-09-17T00:00:00Z\n\n<<LVLY-HL-TOK>>\nsecret-value\n`);
  assert.equal(ok.log, "line1\nline2\n");
  assert.equal(ok.stored, true);
  assert.equal(ok.captured, "secret-value");
  const none = splitHeadlessRead("그냥 글");
  assert.deepEqual(none, { log: "", stored: false, captured: null }, "구분자가 없으면 아무것도 믿지 않는다");
  const empty = splitHeadlessRead(`x\n<<LVLY-HL-STORED>>\n\n<<LVLY-HL-TOK>>\n`);
  assert.equal(empty.stored, false);
  assert.equal(empty.captured, null);
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

  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, FAKE_MODE: process.env.FAKE_MODE, OAUTH: process.env.CLAUDE_CODE_OAUTH_TOKEN };
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
  const reset = () => { for (const f of [envOut, codeOut, go]) fs.rmSync(f, { force: true }); delete process.env.FAKE_MODE; };

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
        assert.equal(fs.readFileSync(p.pid, "utf8").length > 0, true, "pid 파일이 있다");
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
        //  정상 정리(kill-server)는 창의 시계까지 함께 내린다 — 남으면 발급마다 25분짜리 sleep 이 쌓인다.
        await waitFor("창 시계도 사라진다", () => !(spawnSync("ps", ["-e", "-o", "args="], { encoding: "utf8" }).stdout || "")
          .split("\n").some((l) => l.trim() === `sleep ${HEADLESS_PANE_WATCHDOG_SEC}`), 4000);
      });

      await t("★ R9 새 시도가 자리를 차지하면 옛 러너가 물러난다 — 남의 pid 파일은 건드리지 않는다", async () => {
        reset();
        await startHeadlessLogin(null, "claude", null);
        await waitFor("러너가 돈다", () => runnerAlive("claude") && tmpLeft().length === 1 && exists(p.pid));
        fs.writeFileSync(p.pid, "someone-else");
        await waitFor("옛 러너 정리", () => !runnerAlive("claude") && tmpLeft().length === 0);
        assert.equal(fs.readFileSync(p.pid, "utf8"), "someone-else");
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
        const old = new Date(Date.now() - (HEADLESS_ALIVE_SEC + 10) * 1000);
        fs.utimesSync(p.pid, old, old);
        const out = spawnSync("sh", ["-c", headlessStartSh({ home, slotName: headlessSlot(null, "claude"), harness: "claude" })], { encoding: "utf8" });
        assert.equal(out.stdout.trim(), "started", `멈춘 자리를 새로 띄운다: ${out.stdout}${out.stderr}`);
        await waitFor("새 러너가 자기 pid 를 쓴다", () => exists(p.pid) && fs.readFileSync(p.pid, "utf8") !== "stale");
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
        assert.equal(r.captured, null);
        assert.ok(!exists(p.tok));
        await cancelHeadlessLogin(null, "claude");
      });
    }

    const x = P("codex");
    await t("★ R13 codex — 따로 된 CODEX_HOME 의 auth.json 이 자격 파일이 되고, 잡음 줄이 종료 줄보다 먼저다", async () => {
      reset();
      await startHeadlessLogin(null, "codex", null);
      await waitFor("주소·코드", () => exists(x.log) && fs.readFileSync(x.log, "utf8").includes("WXYZ-12345"));
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
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed`);

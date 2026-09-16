// `lively node` 인자 가드(#4006) — **순수함수라 어느 플랫폼에서든 돈다.**
//
// ⚠ 이 파일이 존재하는 이유: 짝인 `lively-node.test.mjs` 는 launchd/systemd 스텁을 쓰는 POSIX e2e 라
//  윈도우에서는 통째로 skip 된다. 그런데 여기서 굳히는 것은 **«실행하느냐 마느냐»를 가르는 판정**이다 —
//  실행 커버리지가 플랫폼에 좌우되면 안 된다(node-token-reuse.test.mjs 와 같은 관례).
//
// 사양(2026-09-16 사고에서 나온 정책):
//  ① 도움말은 도움말이다 — `--help`·`-h`·`help` 는 사용법만 내고 끝난다(등록·env 쓰기·번들·기동 0건).
//  ② 모르는 인자는 조용히 무시하지 않는다 — 오류 + 사용법, 비-0 종료.
//  ③ `--id` 는 값을 요구한다(종전엔 값이 없으면 조용히 호스트명으로 떨어졌다).
//  ④ 전경 실행은 이 컴퓨터에 에이전트가 이미 돌고 있으면 거부한다. `--daemon` 은 스스로 교체하므로 예외.
//  ⑤ 프로세스 판정이 «모름» 이면 막지 않는다.
//
// 계기: `lively node --help` 한 줄이 같은 id 에이전트를 하나 더 띄워, 게이트웨이가 둘을 1초 간격으로
//  번갈아 쫓아냈다(3분간 교체 162회 — 지식 `lively-node-help-flag-starts-duplicate-agent`).
// 실행: node kit/cli/node-argv-guard.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNodeArgv, nodeUsage, foregroundDuplicateBlock } from "./cmd-node.mjs";

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 표 A: 인자 해석 ─────────────────────────────────────────────────────────

t("A1 인자 없음 → 전경 실행(데몬 아님·이름 기본값)", () => {
  assert.deepEqual(parseNodeArgv([]), { action: "run", daemon: false, id: null, rest: [], error: null });
});

t("A2 --daemon → 상시화", () => {
  const v = parseNodeArgv(["--daemon"]);
  assert.equal(v.action, "run"); assert.equal(v.daemon, true); assert.equal(v.error, null);
});

t("A3 --id <이름> → 그 이름으로", () => {
  const v = parseNodeArgv(["--id", "box-a"]);
  assert.equal(v.id, "box-a"); assert.equal(v.daemon, false); assert.equal(v.error, null);
});

t("A4 --daemon --id <이름> → 둘 다", () => {
  const v = parseNodeArgv(["--daemon", "--id", "box-a"]);
  assert.equal(v.daemon, true); assert.equal(v.id, "box-a"); assert.equal(v.error, null);
});

t("A5 --help · -h · help → 도움말", () => {
  for (const args of [["--help"], ["-h"], ["help"]]) {
    assert.equal(parseNodeArgv(args).action, "help", JSON.stringify(args));
    assert.equal(parseNodeArgv(args).error, null, JSON.stringify(args));
  }
});

t("A6 ★ --daemon --help → 도움말이 이긴다(섞여 와도 기동 금지 — 사고의 모양)", () => {
  const v = parseNodeArgv(["--daemon", "--help"]);
  assert.equal(v.action, "help");
  assert.equal(v.daemon, false, "도움말인데 daemon 이 켜져 있으면 호출부가 기동할 수 있다");
});

t("A7 stop → 중지", () => {
  assert.equal(parseNodeArgv(["stop"]).action, "stop");
});

t("A8 keepawake → 뒤 인자를 그대로 넘긴다(이 가드가 소비하지 않는다)", () => {
  assert.deepEqual(parseNodeArgv(["keepawake", "on"]).rest, ["on"]);
  assert.deepEqual(parseNodeArgv(["keepawake", "off"]).rest, ["off"]);
  assert.equal(parseNodeArgv(["keepawake", "off"]).action, "keepawake");
});

t("A9 --id 값 없음 → 오류(사유가 --id 를 지목한다)", () => {
  const v = parseNodeArgv(["--id"]);
  assert.ok(v.error, "값 없는 --id 가 통과했다 — 종전엔 조용히 호스트명으로 떨어졌다");
  assert.match(v.error, /--id/);
});

t("A10 ★ --id 뒤가 플래그 모양 → 오류(새 '값 검사'가 만드는 엣지)", () => {
  const v = parseNodeArgv(["--id", "--daemon"]);
  assert.ok(v.error, "`--daemon` 을 노드 이름으로 삼았다");
  assert.equal(v.id, null);
});

t("A11 모르는 옵션 → 오류(그 옵션을 그대로 말한다)", () => {
  const v = parseNodeArgv(["--frobnicate"]);
  assert.ok(v.error); assert.match(v.error, /--frobnicate/);
});

t("A12 모르는 하위명령 → 오류(그 낱말을 그대로 말한다)", () => {
  const v = parseNodeArgv(["staaahp"]);
  assert.ok(v.error); assert.match(v.error, /staaahp/);
});

t("A13 --id 빈 값 → 오류(경계값)", () => {
  assert.ok(parseNodeArgv(["--id", ""]).error);
});

t("A14 사용법은 네 입구를 다 말한다(사람이 이걸 보고 다음 명령을 친다)", () => {
  const u = nodeUsage();
  for (const s of ["--daemon", "--id", "stop", "keepawake", "lively node stop"]) {
    assert.ok(u.includes(s), `사용법에 ${s} 가 없다`);
  }
});

// ── 표 B: 전경 중복 거부 ────────────────────────────────────────────────────

t("B1 ★ 전경 + 이미 돈다 → 막는다(빠져나갈 명령을 사유에 담는다)", () => {
  const v = foregroundDuplicateBlock({ daemon: false, running: true });
  assert.equal(v.block, true);
  assert.ok(v.why.includes("lively node stop"), `무엇을 하면 되는지가 없다: ${v.why}`);
});

t("B2 전경 + 안 돈다 → 진행", () => {
  assert.equal(foregroundDuplicateBlock({ daemon: false, running: false }).block, false);
});

t("B3 ★ 전경 + 모름(null) → 진행 — «모른다»는 «있다»가 아니다", () => {
  assert.equal(foregroundDuplicateBlock({ daemon: false, running: null }).block, false);
});

t("B4 --daemon 은 돌고 있어도 진행(상시화가 스스로 교체한다)", () => {
  assert.equal(foregroundDuplicateBlock({ daemon: true, running: true }).block, false);
});

t("B5 인자 없이 호출해도 안전(새 헬퍼의 '비었을 때' 엣지)", () => {
  assert.equal(foregroundDuplicateBlock().block, false);
  assert.equal(foregroundDuplicateBlock({}).block, false);
});

// ── 표 C: 배선 — **판정이 맞는 것과 그 판정이 불리는 것은 별개의 결함 축이다.** ──
//  순수함수만 초록이고 호출부가 안 부르면 라이브는 그대로 에이전트를 하나 더 띄운다.
const SRC = readFileSync(new URL("./cmd-node.mjs", import.meta.url), "utf8");

t("C1 배선: cmdNode 가 parseNodeArgv 를 부르고, 도움말은 사용법 출력, 오류는 die", () => {
  assert.match(SRC, /const parsed = parseNodeArgv\(rest\)/, "해석을 호출부가 안 쓴다");
  assert.match(SRC, /parsed\.action === "help"[\s\S]{0,120}nodeUsage\(\)/, "도움말이 사용법을 안 낸다");
  assert.match(SRC, /parsed\.error[\s\S]{0,120}die\(/, "오류인데 진행한다");
});

t("C2 ★ 배선 순서: 중복 거부가 tmux 확보·env 쓰기·번들 내려받기보다 **먼저** 온다(부작용 0)", () => {
  const iBlock = SRC.indexOf("foregroundDuplicateBlock({ daemon,");
  const iTmux = SRC.indexOf("await ensureTmux()");
  const iEnv = SRC.indexOf('writeLively("node-agent.env"');
  const iBundle = SRC.indexOf('"/api/ui/node-agent"');
  assert.ok(iBlock > 0 && iTmux > 0 && iEnv > 0 && iBundle > 0, "기준점을 못 찾았다(리팩터링되면 이 테스트를 고쳐라)");
  assert.ok(iBlock < iTmux, "거부 판정이 tmux 확보 뒤에 있다");
  assert.ok(iBlock < iEnv, "거부 판정이 env 쓰기 뒤에 있다 — 막아도 접속정보는 이미 덮인다");
  assert.ok(iBlock < iBundle, "거부 판정이 번들 내려받기 뒤에 있다");
});

t("C3 배선: 거부는 실패로 끝난다(die 의 비-0 코드)", () => {
  assert.match(SRC, /if \(dup\.block\) die\(dup\.why, [1-9]\d*\)/, "거부하고도 0 으로 끝나면 스크립트가 성공으로 읽는다");
});

// ── 표 D: 실제 CLI — **부작용 0 을 눈으로 본다**(게이트웨이 픽스처 없이 돈다) ───────────────
//  왜 여기에 두나: 짝인 `lively-node.test.mjs` 는 launchd/systemd 스텁 e2e 라 환경을 많이 타는데,
//   이 가드는 **네트워크·tmux 보다 앞**에서 걸리므로 그런 장치가 하나도 필요 없다. 그래서 이 표는
//   어느 기계에서든 돌고, 사고의 실제 피해(등록·접속정보 파일·에이전트 기동)가 0 인지 직접 잰다.
//  ⚠ CLI 의 say() 는 stderr 로 나간다(stdout 은 --json 용) — 출력 검사는 stdout+stderr 를 합쳐서 한다.
{
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { sandboxEnv, closedPath } = await import("../testlib/os-sandbox.mjs");
  const pExecFile = promisify(execFile);
  const CLI = join(fileURLToPath(import.meta.url), "..", "lively.mjs");

  const box = mkdtempSync(join(tmpdir(), "lively-argv-guard-"));
  try {
    // 로그인은 돼 있는 상태로 둔다 — «로그인이 필요합니다» 로 일찍 끝나면 이 표가 vacuous 해진다.
    mkdirSync(join(box, ".lively"), { recursive: true });
    writeFileSync(join(box, ".lively", "gateway-url"), "http://127.0.0.1:9");   // 닫힌 포트 — 여기까지 가면 그 자체가 결함이다
    writeFileSync(join(box, ".lively", "token"), "lvk_guard_test_dummy");
    // 닫힌 PATH — CLI 를 띄우는 테스트는 실제 claude·codex 를 가린다(#1431 관례, cli-spawn-harness-sandbox.test.mjs 가 강제).
    //  이 표의 두 경로는 하네스를 만질 일이 없지만, 관례는 '이 명령은 안 만진다' 를 사람이 매번 판단하지 않게 하려는 것이다.
    const bin = join(box, "stub-bin");
    mkdirSync(bin, { recursive: true });
    const run = async (args) => {
      try {
        const r = await pExecFile(process.execPath, [CLI, ...args], {
          env: { ...process.env, ...sandboxEnv({ home: box }), LIVELY_HOME: box, PATH: closedPath(bin) },
          timeout: 60000,
        });
        return { code: 0, out: (r.stdout || "") + (r.stderr || "") };
      } catch (e) {
        return { code: e.code ?? 1, out: (e.stdout || "") + (e.stderr || "") };
      }
    };
    const touched = () => existsSync(join(box, ".lively", "node-agent.env")) || existsSync(join(box, ".lively", "node-agent"));

    const h = await run(["node", "--help"]);
    t("D1 `lively node --help` → 성공(0) + 사용법", () => {
      assert.equal(h.code, 0, `code=${h.code}\n${h.out.slice(-400)}`);
      assert.match(h.out, /사용법: lively node/);
    });
    t("D2 ★ `--help` 는 접속정보·번들을 **만들지 않는다**(사고의 실제 피해가 0)", () => {
      assert.equal(touched(), false, `남긴 것: ${readdirSync(join(box, ".lively")).join(", ")}`);
    });

    const u = await run(["node", "--frobnicate"]);
    t("D3 모르는 인자 → 비-0 + 그 인자 지목 + 사용법", () => {
      assert.notEqual(u.code, 0, "모르는 인자인데 성공으로 끝났다");
      assert.match(u.out, /--frobnicate/);
      assert.match(u.out, /사용법: lively node/);
    });
    t("D4 ★ 모르는 인자도 부작용 0", () => {
      assert.equal(touched(), false, `남긴 것: ${readdirSync(join(box, ".lively")).join(", ")}`);
    });
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed`);

// 위탁 자격 리스가 **명령줄·오류·저장값 어디에도 평문으로 남지 않는가** (#4422) — 사양 엣지 표 L1~L8.
//
//  사고(2026-09-22 위탁 #4074): 윈도우 노드에서 `psmux new-session` 이 실패하자 Node 의 execFile 오류 문장
//   "Command failed: <argv 전체>" 가 그대로 `org_task.result.last_assign.reason` 에 저장됐다. 리스 env 가
//   tmux 명령줄(`-e CLAUDE_CODE_OAUTH_TOKEN=<평문>`)에 펼쳐져 있었으므로 그 문장에 토큰이 통째로 실렸고,
//   `delegate_status`/`delegate_list` 로 읽혔다.
//
//  | #  | 자리                                 | 입력                                  | 기대                                             |
//  |----|--------------------------------------|---------------------------------------|--------------------------------------------------|
//  | L1 | spawnTaskSession — new-session 실패   | 리스 env(모양 앎·모름 둘)             | 던진 오류의 문장·속성 어디에도 값이 없다         |
//  | L2 | spawnTaskSession — 성공               | 리스 env 에 토큰                      | tmux 가 받은 명령줄에 토큰이 없다(근본)          |
//  | L3 | spawnTaskSession — 성공               | 리스 env 에 토큰                      | 작업 폴더의 0600 파일 하나로만 간다              |
//  | L4 | spawnTaskSession — 실패               | 리스 env 에 토큰                      | 실패 뒤 자격 파일이 남지 않는다                  |
//  | L5 | noteAssignFailure(저장 직전)          | 구 노드가 돌려준 원문(토큰 포함)      | 저장값에 토큰이 없다                             |
//  | L6 | markFinished(저장 직전)               | 옛 행에서 옮겨 온 last_assign·error   | 저장값에 토큰이 없다                             |
//  | L7 | spawnTaskSession — 리스 없음/빈 리스  | env 없음 · {}                         | 자격 파일 0개, 스폰은 성공                       |
//  | L8 | spawnTaskSession — 규칙 밖 이름       | `bad-key` · 소문자                    | 파일로도 명령줄로도 안 간다(종전처럼 버린다)     |
//  | L9 | 종단 — 스텁 tmux 가 스크립트를 실제로 돌림 | 리스 env 에 토큰                   | 하네스 env 에 도달 · 하네스가 도는 동안 파일 없음 |
//  | L10| markFinished — AI 가 쓴 요약             | 산문(«Bearer authentication»·MAX_TOKENS=4096) | 산문은 그대로, 토큰 모양만 가림          |
//  | L11| delegate_status·list(읽기)               | 가림 전에 저장된 옛 행(#4074 모양)    | 응답에 토큰이 없다(DB 는 안 건드린다)            |
//
//  L1·L2·L5·L6 은 수정 전 코드에서 빨간불이었다(fail-first). L3·L4·L9 는 근본 수정(파일 전달)의 양면이다.
//  ⓘ L1 의 스텁은 실패할 때 작업 폴더의 자격 파일을 stderr 로 흘린다 — 명령줄에서 값이 빠진 뒤에도 **오류를 가리는 겹**(spawnTaskSession
//   래퍼)이 살아 있는지를 재기 위해서다(리뷰 지적: 그러지 않으면 래퍼를 지워도 초록이다). 모양 모르는 값(ODD)은 리터럴 가림만 잡는다.
//  ⓘ L9 의 스텁은 new-session 을 받으면 그 스크립트를 **그 자리에서** 돌린다 — 쓰는 쪽 경로·순서와 읽는 쪽이 이어져 있는지를 본다.
//  ⚠ TMUX_BIN 은 모듈 로드 시점에 읽힌다 → env 를 먼저 심고 **동적 import** 한다(task-spawn-gateway-env.test 와 같은 틀).
//  ⚠ POSIX 전용 — 스텁 tmux 가 sh 스크립트다.
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

//  리스 토큰 모양 그대로(setup-token) — 패턴 가림과 리터럴 가림 둘 다가 걸리는 표본.
const TOKEN = "sk-ant-oat01-" + "Q".repeat(40) + "_leak-probe-" + "7".repeat(30);
//  패턴 밖 모양 — 리스 표에 다른 하네스가 더해지면 값 모양을 모른다. 리터럴 가림만 이걸 잡는다.
const ODD = "plain lease value 4422 without known shape";

/** 오류 객체를 **밖으로 나갈 수 있는 모든 모양**으로 펼친다 — message·stack·cmd·stderr·JSON 직렬화. */
function everyText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const own: Record<string, unknown> = {};
  for (const k of Object.getOwnPropertyNames(e)) own[k] = (e as unknown as Record<string, unknown>)[k];
  return [e.message, e.stack ?? "", JSON.stringify(own), String(e)].join("\n");
}

if (process.platform === "win32") {
  console.log("↷ task-secret-leak — win32 건너뜀(스텁 tmux 가 sh 스크립트)");
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t4422-"));
  const log = path.join(root, "tmux.log");
  const failFlag = path.join(root, "fail");
  const runFlag = path.join(root, "run");
  const stub = path.join(root, "tmux");
  const shared = path.join(root, "shared");
  //  new-session 을 실패시키거나(psmux 가 실제로 그렇게 죽었다 — 실패 문장에 stderr 가 붙는다) 스크립트를 그 자리에서 돌리는 스텁.
  fs.writeFileSync(stub, [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> "${log}"`,
    `if [ "$1" = "new-session" ]; then`,
    `  if [ -f "${failFlag}" ]; then`,
    `    for f in "${shared}"/delegated/*/.lively-task/*/.lease-*; do [ -f "$f" ] && { cat "$f"; echo; } >&2; done`,
    `    echo "psmux: create session failed" >&2; exit 1`,
    "  fi",
    `  if [ -f "${runFlag}" ]; then`,
    "    shift",
    "    while [ $# -gt 0 ]; do case \"$1\" in -d) shift ;; -s|-c) shift 2 ;; -e) export \"$2\"; shift 2 ;; *) break ;; esac; done",
    //  남은 것 = `sh -lc <스크립트>`. 로그인 셸(-l)은 프로필이 PATH 를 바꿔 **진짜** 하네스를 부를 수 있다 — -c 로만 돌린다.
    "    SHELL=/bin/true sh -c \"$3\" < /dev/null > /dev/null 2>&1",
    "  fi",
    "fi",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  //  가짜 하네스(`claude`) — 받은 env 와 «도는 동안 자격 파일이 아직 있나» 를 남긴다. cwd 는 스크립트가 cd 한 작업 폴더다.
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), [
    "#!/bin/sh",
    "cat > /dev/null",
    `printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" > "${root}/got-env"`,
    `if ls .lively-task/"$LIVELY_TASK_ID"/.lease-* > /dev/null 2>&1; then echo present > "${root}/during"; fi`,
    `echo '{"type":"result","result":"ok"}'`,
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(path.join(root, "home"), { recursive: true });

  process.env.TMUX_BIN = stub;
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;   // 가짜 하네스가 먼저 — 진짜 claude 가 불리면 안 된다
  process.env.TERMINAL_ROOT_SHARED = shared;
  process.env.HOME = path.join(root, "home");
  process.env.LIVELY_MULTIPROFILE = "0";
  delete process.env.ITEMS_DATABASE_URL;
  delete process.env.LIVELY_GATEWAY_URL;

  const { spawnTaskSession } = await import("./tasks.js");
  const { noteAssignFailure, markFinished } = await import("./task-store.js");
  const { itemsPool } = await import("../db/client.js");

  const base = { user: { userId: "t4422-probe" }, rootKey: "shared", subpath: "", prompt: "ping", harness: "claude" };
  let n = 944221;
  const taskDirOf = (id: number): string => path.join(shared, "delegated", `task-${id}`, ".lively-task", String(id));
  const spawn = (id: number, env?: Record<string, string>) =>
    spawnTaskSession({ ...base, taskId: id, ...(env ? { env } : {}) } as unknown as Parameters<typeof spawnTaskSession>[0]);
  //  작업 폴더의 파일 중 prompt.txt 가 아닌 것 — 자격 파일 후보(종결 파일은 스텁 tmux 라 생기지 않는다).
  const extraFiles = (dir: string): string[] =>
    (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f !== "prompt.txt").map((f) => path.join(dir, f));
  const filesHolding = (dir: string, needle: string): string[] =>
    extraFiles(dir).filter((p) => fs.statSync(p).isFile() && fs.readFileSync(p, "utf8").includes(needle));
  const lastNewSession = (): string => {
    const lines = fs.readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("new-session "));
    assert.ok(lines.length > 0, "관측 장치 — 스텁 tmux 가 new-session 을 한 번도 못 받았다");
    return lines[lines.length - 1];
  };

  //  한 행이 깨져도 나머지 행을 끝까지 본다 — 어느 행이 빨간불인지가 곧 무엇이 새는지다.
  let pass = 0;
  const failed: string[] = [];
  const t = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try { await fn(); pass++; console.log(`ok  ${name}`); }
    catch (e) { failed.push(name); console.log(`FAIL ${name}\n     ${String((e as Error)?.message ?? e).split("\n")[0]}`); }
  };

  try {
    // ── L1 · L4 — 실패 경로 ──────────────────────────────────────────────────────────────────
    fs.writeFileSync(failFlag, "");
    await t("L1 new-session 이 실패해도 던진 오류의 문장·속성에 리스 값이 없다", async () => {
      let caught: unknown = null;
      try { await spawn(n++, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, LIVELY_PROBE_LEASE: ODD }); }
      catch (e) { caught = e; }
      assert.ok(caught instanceof Error, "관측 장치 — 스텁이 new-session 을 실패시켜야 한다(안 던지면 이 단언은 공허하다)");
      assert.match((caught as Error).message, /psmux: create session failed/, "원인 문장은 남아야 한다(가림 ≠ 지움)");
      const all = everyText(caught);
      assert.ok(!all.includes(TOKEN), "setup-token 이 오류에 평문으로 실렸다 — last_assign·위탁 응답·로그로 샌다");
      assert.ok(!all.includes(ODD), "모양을 모르는 리스 값이 오류에 실렸다 — 리터럴 가림이 빠졌다");
    });
    await t("L4 스폰이 실패하면 자격 파일을 남기지 않는다", async () => {
      const id = n++;
      await spawn(id, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }).catch(() => { /* L1 이 본다 */ });
      assert.ok(fs.existsSync(path.join(taskDirOf(id), "prompt.txt")), "관측 장치 — 작업 폴더가 준비된 뒤 실패해야 한다");
      assert.deepEqual(filesHolding(taskDirOf(id), TOKEN), [], "실패한 스폰의 자격 파일이 공유 작업 폴더에 남았다");
    });
    fs.rmSync(failFlag);

    // ── L2 · L3 — 성공 경로(근본: argv 가 아니라 파일) ───────────────────────────────────────
    await t("L2 tmux 가 받은 명령줄 어디에도 리스 값이 없다(프로세스 목록·오류 문장의 근원)", async () => {
      await spawn(n++, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
      assert.ok(!lastNewSession().includes(TOKEN), "리스 값이 tmux 명령줄에 펼쳐졌다 — 실패 문장·ps 로 샌다");
      assert.ok(!fs.readFileSync(log, "utf8").includes(TOKEN), "set-option 등 다른 tmux 호출에도 없어야 한다");
    });
    await t("L3 리스 값은 작업 폴더의 0600 파일 하나로만 간다", async () => {
      const r = await spawn(n++, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
      const held = filesHolding(r.taskDir, TOKEN);
      assert.equal(held.length, 1, `리스 값을 든 파일이 정확히 하나여야 한다: ${held.join(", ") || "(없음)"}`);
      assert.equal(fs.readFileSync(held[0], "utf8"), TOKEN, "값은 가공 없이 그대로(스크립트가 그대로 읽는다)");
      assert.equal(fs.statSync(held[0]).mode & 0o777, 0o600, "자격 파일은 그 워커 uid 만 읽는다(0600)");
      assert.ok(lastNewSession().includes(held[0]), "스크립트가 읽는 경로와 쓴 경로가 다르다 — 모든 위탁이 «cat: 없음» 으로 죽는다");
      assert.ok(!fs.readFileSync(path.join(r.taskDir, "prompt.txt"), "utf8").includes(TOKEN), "프롬프트 파일에 섞이지 않는다");
    });

    // ── L7 · L8 — 새로 생긴 자리의 부재·규칙 밖 ───────────────────────────────────────────────
    await t("L7 리스가 없거나 비어 있으면 자격 파일을 만들지 않는다(스폰은 된다)", async () => {
      for (const env of [undefined, {}]) {
        const r = await spawn(n++, env);
        assert.deepEqual(extraFiles(r.taskDir), [], `리스가 없는데 작업 폴더에 파일이 생겼다(${JSON.stringify(env)})`);
      }
    });
    await t("L8 이름이 규칙 밖인 키는 파일로도 명령줄로도 안 간다", async () => {
      const v = "value-of-a-badly-named-key-4422";
      const r = await spawn(n++, { "bad-key": v, lowercase_key: v } as Record<string, string>);
      assert.ok(!lastNewSession().includes(v), "규칙 밖 이름이 명령줄에 실렸다");
      assert.deepEqual(filesHolding(r.taskDir, v), [], "규칙 밖 이름이 자격 파일로 갔다");
    });

    await t("L9 종단 — 스크립트가 그 파일을 읽어 하네스 env 로 올리고, 하네스가 돌 때는 파일이 이미 없다", async () => {
      fs.writeFileSync(runFlag, "");
      try {
        const r = await spawn(n++, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
        assert.equal(fs.readFileSync(path.join(r.taskDir, "exit"), "utf8").trim(), "0",
          `관측 장치 — 스크립트가 끝까지 돌아야 한다(stderr: ${fs.existsSync(path.join(r.taskDir, "stderr.log")) ? fs.readFileSync(path.join(r.taskDir, "stderr.log"), "utf8").slice(0, 200) : "-"})`);
        assert.equal(fs.existsSync(path.join(root, "got-env")) ? fs.readFileSync(path.join(root, "got-env"), "utf8") : null, TOKEN,
          "리스 값이 하네스 env 에 도달하지 않았다 — 쓰는 순서·경로가 스크립트와 어긋났다");
        assert.ok(!fs.existsSync(path.join(root, "during")), "하네스가 도는 동안 자격 파일이 작업 폴더에 남아 있었다");
        assert.deepEqual(filesHolding(r.taskDir, TOKEN), [], "끝난 뒤에도 자격 파일이 남았다");
      } finally { fs.rmSync(runFlag, { force: true }); }
    });

    // ── L5 · L6 · L10 — 저장 직전(구 노드 번들이 가리지 않은 원문을 돌려줘도) ─────────────────────────
    const writes: unknown[][] = [];
    (itemsPool as unknown as { query: unknown }).query = async (_sql: string, params: unknown[]) => {
      writes.push(params);
      return { rows: [], rowCount: 1 };
    };
    //  구 노드가 돌려주는 원문 모양 그대로 — Node execFile 의 "Command failed: <argv>" + stderr.
    const RAW = `Command failed: psmux new-session -d -s box-x -e LANG=C.UTF-8 -e CLAUDE_CODE_OAUTH_TOKEN=${TOKEN} -c C:\\w sh -lc x\npsmux: create session failed`;
    await t("L5 noteAssignFailure 는 저장 직전에 토큰을 가린다", async () => {
      writes.length = 0;
      await noteAssignFailure(1, "spawn_error", RAW);
      assert.equal(writes.length, 1, "관측 장치 — 저장이 한 번 일어나야 한다");
      const stored = JSON.stringify(writes[0]);
      assert.ok(!stored.includes(TOKEN), "last_assign.reason 에 토큰이 평문으로 저장됐다");
      assert.ok(stored.includes("psmux: create session failed"), "원인 문장은 남는다");
    });
    await t("L6 markFinished 는 옮겨 온 last_assign·실패 문장에서도 토큰을 가린다", async () => {
      writes.length = 0;
      await markFinished(2, false, { reason: "no_capacity_timeout", last_assign: { code: "spawn_error", reason: RAW } }, `대기 시간 초과(10분) — ${RAW}`);
      assert.ok(writes.length >= 1, "관측 장치 — 저장이 일어나야 한다");
      const stored = JSON.stringify(writes[0]);
      assert.ok(!stored.includes(TOKEN), "result.last_assign·error 에 토큰이 평문으로 저장됐다");
      assert.ok(stored.includes("no_capacity_timeout") && stored.includes("psmux: create session failed"), "나머지 결과·원인 문장은 그대로 저장된다");
    });

    await t("L10 markFinished 는 AI 가 쓴 요약의 산문을 망가뜨리지 않고 토큰 모양만 가린다", async () => {
      writes.length = 0;
      const prose = "Added Bearer authentication middleware; set MAX_TOKENS=4096 and GH_TOKEN=abc in CI";
      await markFinished(3, true, { summary: `${prose}\nleaked: ${TOKEN}` }, null);
      const stored = JSON.parse(String(writes[0][2])) as { summary: string };
      assert.ok(stored.summary.startsWith(prose), `산문이 바뀌었다: ${stored.summary.slice(0, 120)}`);
      assert.ok(!stored.summary.includes(TOKEN), "요약에 섞인 토큰은 가려야 한다");
    });

    await t("L11 delegate_status·list 는 가림 전에 저장된 옛 행도 응답에서 가린다", async () => {
      //  2026-09-22 #4074 행의 모양 그대로 — last_assign.reason 에 원문, error 는 비었다.
      const old = {
        id: 4074, requester: "t4422-probe", status: "canceled", result: { last_assign: { code: "spawn_error", reason: RAW, at: "2026-09-22T07:05:26Z" } },
        error: null, prompt: "p", harness: "claude", node_id: null, session_id: null, task_dir: null,
      };
      (itemsPool as unknown as { query: unknown }).query = async () => ({ rows: [old], rowCount: 1 });
      const { delegateCapabilities } = await import("../capabilities/delegate.js");
      const cap = (name: string) => delegateCapabilities.find((c) => c.name === name)!;
      const user = { userId: "t4422-probe", scopes: ["admin"] };
      const one = await (cap("delegate_status").handler as (i: unknown, u: unknown) => Promise<unknown>)({ id: 4074 }, user);
      const many = await (cap("delegate_list").handler as (i: unknown, u: unknown) => Promise<unknown>)({ all: true }, user);
      for (const [label, body] of [["delegate_status", one], ["delegate_list", many]] as const) {
        const text = JSON.stringify(body);
        assert.ok(text.includes("4074"), `관측 장치 — ${label} 가 그 행을 돌려줘야 한다`);
        assert.ok(!text.includes(TOKEN), `${label} 응답에 옛 행의 토큰이 평문으로 나갔다`);
        assert.ok(text.includes("psmux: create session failed"), `${label} — 원인 문장은 남는다`);
      }
      assert.ok(JSON.stringify(old).includes(TOKEN), "원본 행 객체는 바꾸지 않는다(가린 사본만 나간다)");
    });

    if (failed.length) {
      process.exitCode = 1;
      console.log(`✗ task-secret-leak — ${pass}/11 통과, 실패: ${failed.map((f) => f.split(" ")[0]).join(", ")}`);
    } else {
      console.log(`✓ task-secret-leak — ${pass}/11 (리스 값이 명령줄·오류·저장값에 평문으로 남지 않는다)`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// #4135 — **프로필 키트 배선 보장(`profile-kit-seed.ts`)** 의 사양 시험 — 사양 A 만 보고 쓴 블라인드 시험.
//
// ── 무엇이 고장나 있었나 ─────────────────────────────────────────────────────
// 세션이 멤버 전용 CLAUDE_CONFIG_DIR(프로필 dir)로 뜰 때 그 dir 이 **비어 있으면**(라이블리 훅 배선 없음) 그 세션에서는
//  라이블리 훅이 하나도 돌지 않는다. 노드(멤버 PC)에는 프로필 dir 을 채워 주는 절차가 없었다.
//
// ── 여기서 지키는 것 ─────────────────────────────────────────────────────────
//  1. `profileHooksWired(text)` — settings.json 본문에 «명령이 키트 훅 폴더(`.lively/hooks/`)를 가리키는 훅» 이
//     어떤 이벤트에든 하나라도 있으면 true. 윈도우 역슬래시도 배선. null·빈 문자열·깨진 JSON·hooks 없음·`hooks: {}`·
//     사람이 단 다른 훅만 → false. 이벤트 값이 배열이 아니거나 항목 꼴이 이상해도 **던지지 않고** false.
//  2. `ensureProfileKitWired(dir, deps)` — 돌려주는 값은 «지금 그 dir 에 배선이 있나».
//     이미 배선 → 설치기 없이 true · 없으면(파일 없음/훅 없음) 설치기를 **정확히 한 번**(argv·env·timeout 고정) ·
//     돌고 난 뒤 다시 읽어 판정(거짓 완료 없음) · 설치기가 던지면 삼키고 false, 기억하지 않는다(다음 호출이 재시도) ·
//     `deps.cli` 파일이 없으면 호출 없이 false · 같은 dir 동시 호출은 설치기 한 번에 전원 같은 결과 · 절대 던지지 않는다.
//  ⚠ 진짜 키트 CLI 는 부르지 않는다 — `run` 을 기록하는 가짜 deps 로 갈아 끼우고, 임시 dir 안에서만 논다.
//   가짜 설치기는 «env.CLAUDE_CONFIG_DIR» 에 settings.json 을 쓴다 — 넘긴 env 가 실제로 쓰이는지도 그 길로 확인된다.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOOK_WIRING_RE, SEED_TIMEOUT_MS, profileHooksWired, ensureProfileKitWired, defaultProfileSeedDeps,
} from "./profile-kit-seed.js";
import type { ProfileSeedDeps } from "./profile-kit-seed.js";

// ── 재료 ────────────────────────────────────────────────────────────────────
const LIVELY_CMD = '"node" "$HOME/.lively/hooks/work-flag.mjs"';
const LIVELY_CMD_WIN = "node C:\\Users\\me\\.lively\\hooks\\work-flag.mjs";
const HUMAN_CMD = "node ~/my-hooks/format.mjs";
const KIT_BUT_NOT_HOOKS_CMD = "node $HOME/.lively/lib/lively.mjs status";   // 키트 안이지만 훅 폴더가 아니다

const hookEntry = (command: string, matcher = "") => ({ matcher, hooks: [{ type: "command", command }] });
const settingsWith = (hooks: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ theme: "dark", ...extra, hooks });
const wiredSettings = (): string => settingsWith({ PostToolUse: [hookEntry(LIVELY_CMD)] });

interface RunCall { cmd: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number }
interface FakeMode {
  /** 설치기가 dir 에 무엇을 남기나 — 배선된 settings.json / 훅 없는 settings.json / 아무것도 */
  writes?: "wired" | "hookless" | "none";
  /** 프로미스가 거부된다 */
  throws?: boolean;
  /** run 자체가 동기적으로 던진다(프로미스 밖) */
  throwsSync?: boolean;
  /** 설치기가 도는 데 걸리는 시간 — 동시 호출 시험용 */
  delayMs?: number;
}

const roots: string[] = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** 가짜 키트 — 임시 뿌리 아래 가짜 cli 파일·프로필 dir 을 만들고, `run` 호출을 전부 기록한다. */
function fakeKit(mode: FakeMode, opts: { cliMissing?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lively-profile-kit-seed-"));
  roots.push(root);
  const cli = path.join(root, "lib", "lively.mjs");
  if (!opts.cliMissing) {
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, "// 가짜 키트 CLI — 실행되지 않는다\n");
  }
  const profileDir = path.join(root, "profile");
  fs.mkdirSync(profileDir, { recursive: true });       // 호출 자리(sessions.ts·node/tasks.ts)가 mkdir 직후 부른다
  const calls: RunCall[] = [];
  const deps: ProfileSeedDeps = {
    cli,
    run: (cmd, args, env, timeoutMs) => {
      calls.push({ cmd, args, env, timeoutMs });
      if (mode.throwsSync) throw new Error("설치기 동기 예외");
      return (async () => {
        if (mode.delayMs) await new Promise((r) => setTimeout(r, mode.delayMs));
        if (mode.throws) throw new Error("설치기 실패");
        // 넘어온 env 의 CLAUDE_CONFIG_DIR 에 쓴다 — 엉뚱한 env 면 profileDir 에 배선이 안 생겨 판정에 드러난다
        const dir = env.CLAUDE_CONFIG_DIR ?? path.join(root, "nowhere");
        if (mode.writes === "wired" || mode.writes === "hookless") {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "settings.json"), mode.writes === "wired" ? wiredSettings() : settingsWith({}));
        }
      })();
    },
  };
  return { root, cli, profileDir, settingsPath: path.join(profileDir, "settings.json"), calls, deps, mode };
}

// ═══ 0. 상수·기본 deps ═══════════════════════════════════════════════════════
test("A0-1 HOOK_WIRING_RE — 키트 훅 폴더 경로(슬래시·역슬래시)에만 반응한다 · SEED_TIMEOUT_MS 는 양의 유한수", () => {
  const re = new RegExp(HOOK_WIRING_RE.source, HOOK_WIRING_RE.flags.replace(/[gy]/g, ""));   // g 상태 제거
  assert.ok(re.test(LIVELY_CMD), "슬래시 경로");
  assert.ok(re.test(LIVELY_CMD_WIN), "윈도우 역슬래시 경로");
  assert.ok(!re.test("echo hi"), "평범한 명령");
  assert.ok(!re.test(HUMAN_CMD), "사람이 단 훅");
  assert.ok(!re.test(KIT_BUT_NOT_HOOKS_CMD), "키트 안이지만 훅 폴더가 아닌 경로");
  assert.ok(Number.isFinite(SEED_TIMEOUT_MS) && SEED_TIMEOUT_MS > 0, String(SEED_TIMEOUT_MS));
});

test("A0-2 defaultProfileSeedDeps — cli 기본은 ~/.lively/lib/lively.mjs · run 은 함수", () => {
  const d = defaultProfileSeedDeps();
  assert.equal(d.cli, path.join(os.homedir(), ".lively", "lib", "lively.mjs"));
  assert.equal(typeof d.run, "function");
});

// ═══ 1. profileHooksWired — 순수 판정 ═══════════════════════════════════════
test("A1-1 라이블리 훅 배선이 하나라도 있으면 true — 이벤트 종류·섞인 다른 훅 무관", () => {
  assert.equal(profileHooksWired(wiredSettings()), true, "PostToolUse 하나");
  assert.equal(profileHooksWired(settingsWith({ SessionStart: [hookEntry(LIVELY_CMD)] })), true, "다른 이벤트");
  assert.equal(profileHooksWired(settingsWith({
    PreToolUse: [hookEntry("echo hi", "Bash")],
    Stop: [hookEntry(HUMAN_CMD), hookEntry(LIVELY_CMD)],
  })), true, "사람이 단 훅 사이에 하나");
  assert.equal(profileHooksWired(settingsWith({
    PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "echo a" }, { type: "command", command: LIVELY_CMD }] }],
  })), true, "한 항목 안의 여러 훅 중 하나");
  assert.equal(profileHooksWired(settingsWith({ PostToolUse: [hookEntry(LIVELY_CMD)] }, { permissions: { allow: ["Bash"] } })), true,
    "다른 키가 함께 있어도");
});

test("A1-2 윈도우 역슬래시 경로(\\.lively\\hooks\\)도 배선이다", () => {
  assert.equal(profileHooksWired(settingsWith({ PostToolUse: [hookEntry(LIVELY_CMD_WIN)] })), true);
});

test("A1-3 null·undefined·빈 문자열·깨진 JSON·hooks 키 없음·hooks:{}·사람이 단 다른 훅만 → false", () => {
  assert.equal(profileHooksWired(null), false, "null");
  assert.equal(profileHooksWired(undefined), false, "undefined");
  assert.equal(profileHooksWired(""), false, "빈 문자열");
  assert.equal(profileHooksWired("   \n"), false, "공백만");
  assert.equal(profileHooksWired("{not json"), false, "깨진 JSON");
  assert.equal(profileHooksWired(wiredSettings().slice(0, -3)), false, "잘린 JSON(안에 배선 문자열이 있어도)");
  assert.equal(profileHooksWired(JSON.stringify({ theme: "dark" })), false, "hooks 키 없음");
  assert.equal(profileHooksWired(settingsWith({})), false, "hooks: {}");
  assert.equal(profileHooksWired(settingsWith({
    PreToolUse: [hookEntry("echo hi", "Bash")],
    PostToolUse: [hookEntry(HUMAN_CMD)],
  })), false, "사람이 단 다른 훅만");
  assert.equal(profileHooksWired(settingsWith({ PostToolUse: [hookEntry(KIT_BUT_NOT_HOOKS_CMD)] })), false,
    "키트 안이지만 훅 폴더가 아닌 명령");
  assert.equal(profileHooksWired(settingsWith({ PostToolUse: [{ matcher: "", hooks: [] }] })), false, "훅 목록이 빈 항목");
  assert.equal(profileHooksWired(settingsWith({ PostToolUse: [] })), false, "이벤트 배열이 빔");
});

test("A1-4 배선은 «hooks.<event>[].hooks[].command» 의 문자열이다 — 명령 아닌 자리에 경로가 있어도 배선이 아니다", () => {
  assert.equal(profileHooksWired(settingsWith({}, { note: "$HOME/.lively/hooks/work-flag.mjs" })), false, "다른 최상위 키");
  assert.equal(profileHooksWired(settingsWith({ PostToolUse: [{ matcher: "$HOME/.lively/hooks/x.mjs", hooks: [{ type: "command", command: "echo" }] }] })), false,
    "matcher 자리");
  assert.equal(profileHooksWired(settingsWith({ PostToolUse: [{ matcher: "", hooks: [{ type: "command", description: LIVELY_CMD }] }] })), false,
    "command 가 아닌 필드");
});

test("A1-5 이벤트 값이 배열이 아니거나 항목 꼴이 이상해도 던지지 않고 false", () => {
  const weird: (string | null | undefined)[] = [
    settingsWith({ PostToolUse: "nope" }),
    settingsWith({ PostToolUse: 42 }),
    settingsWith({ PostToolUse: null }),
    settingsWith({ PostToolUse: true }),
    settingsWith({ PostToolUse: { hooks: [{ type: "command", command: LIVELY_CMD }] } }),   // 배열이 아닌 객체
    settingsWith({ PostToolUse: [null, 3, "x", [], true] }),
    settingsWith({ PostToolUse: [{ hooks: "x" }, { hooks: null }, { hooks: 7 }, { hooks: {} }] }),
    settingsWith({ PostToolUse: [{ hooks: [null, 1, "s", [], { command: 5 }, { command: null }, { command: {} }, {}] }] }),
    settingsWith(null), settingsWith([]), settingsWith("str"), settingsWith(7), settingsWith(true),
    "[]", "\"str\"", "42", "null", "true", "{}",
  ];
  for (const s of weird) {
    let out: boolean | undefined;
    assert.doesNotThrow(() => { out = profileHooksWired(s); }, `던졌다: ${String(s)}`);
    assert.equal(out, false, `false 여야 한다: ${String(s)}`);
  }
});

// ═══ 2. ensureProfileKitWired — 보장 흐름 ═══════════════════════════════════
test("A2-1 이미 배선돼 있으면 설치기를 부르지 않고 true", async () => {
  const k = fakeKit({ writes: "wired" });
  fs.writeFileSync(k.settingsPath, wiredSettings());
  assert.equal(await ensureProfileKitWired(k.profileDir, k.deps), true);
  assert.equal(k.calls.length, 0, "배선이 있는데 설치기가 불렸다");
  // 두 번 불러도 같다
  assert.equal(await ensureProfileKitWired(k.profileDir, k.deps), true);
  assert.equal(k.calls.length, 0);
});

test("A2-2 settings.json 은 있는데 훅이 없으면 — 설치기를 정확히 한 번, 정해진 argv·env·timeout 으로 부르고 true", async () => {
  const unwired: [string, string][] = [
    ["hooks: {}", settingsWith({})],
    ["hooks 키 없음", JSON.stringify({ theme: "dark" })],
    ["사람이 단 훅만", settingsWith({ PreToolUse: [hookEntry(HUMAN_CMD, "Bash")] })],
  ];
  for (const [label, body] of unwired) {
    const k = fakeKit({ writes: "wired" });
    fs.writeFileSync(k.settingsPath, body);
    process.env.LIVELY_TEST_SENTINEL_4135 = "sentinel";
    let out: boolean;
    try { out = await ensureProfileKitWired(k.profileDir, k.deps); }
    finally { delete process.env.LIVELY_TEST_SENTINEL_4135; }
    assert.equal(out, true, label);
    assert.equal(k.calls.length, 1, `${label}: 설치기 호출 횟수`);
    const c = k.calls[0]!;
    assert.equal(c.cmd, process.execPath, `${label}: cmd`);
    assert.deepEqual(c.args, [k.cli, "install", "--harness", "claude"], `${label}: argv`);
    assert.equal(c.env.CLAUDE_CONFIG_DIR, k.profileDir, `${label}: CLAUDE_CONFIG_DIR`);
    assert.equal(c.env.LIVELY_NO_BROWSER, "1", `${label}: LIVELY_NO_BROWSER`);
    assert.equal(c.env.LIVELY_TEST_SENTINEL_4135, "sentinel", `${label}: 현재 프로세스 env 위에 얹지 않았다`);
    assert.equal(c.env.PATH, process.env.PATH, `${label}: PATH 가 현재 프로세스와 다르다`);
    assert.equal(c.timeoutMs, SEED_TIMEOUT_MS, `${label}: timeout`);
    assert.equal(profileHooksWired(fs.readFileSync(k.settingsPath, "utf8")), true, `${label}: 설치기가 쓴 배선이 그 dir 에 있다`);
  }
});

test("A2-3 settings.json 이 아예 없어도 같다 — 설치기 한 번, true", async () => {
  const k = fakeKit({ writes: "wired" });
  assert.ok(!fs.existsSync(k.settingsPath));
  assert.equal(await ensureProfileKitWired(k.profileDir, k.deps), true);
  assert.equal(k.calls.length, 1);
  const c = k.calls[0]!;
  assert.equal(c.cmd, process.execPath);
  assert.deepEqual(c.args, [k.cli, "install", "--harness", "claude"]);
  assert.equal(c.env.CLAUDE_CONFIG_DIR, k.profileDir);
  assert.equal(c.env.LIVELY_NO_BROWSER, "1");
  assert.equal(c.timeoutMs, SEED_TIMEOUT_MS);
  assert.ok(fs.existsSync(k.settingsPath), "설치기가 그 dir 에 settings.json 을 남겼다");
});

test("A2-4 설치기가 던지면 삼키고 false — 실패를 기억하지 않아 다음 호출이 다시 시도한다", async () => {
  const k = fakeKit({ throws: true, writes: "wired" });
  let out: boolean | undefined;
  await assert.doesNotReject(async () => { out = await ensureProfileKitWired(k.profileDir, k.deps); });
  assert.equal(out, false, "던진 설치기를 성공으로 말했다");
  assert.equal(k.calls.length, 1);
  // 다음 호출 — 이번엔 설치기가 성공한다
  k.mode.throws = false;
  assert.equal(await ensureProfileKitWired(k.profileDir, k.deps), true, "재시도가 성공했는데 false");
  assert.equal(k.calls.length, 2, "두 번째 호출이 재시도하지 않았다(실패를 기억했다)");
  // 그 뒤엔 배선이 있으니 설치기 없이 true
  assert.equal(await ensureProfileKitWired(k.profileDir, k.deps), true);
  assert.equal(k.calls.length, 2);
});

test("A2-4b 설치기가 동기적으로 던져도(프로미스 밖) 삼키고 false — 절대 던지지 않는다", async () => {
  const k = fakeKit({ throwsSync: true });
  let out: boolean | undefined;
  await assert.doesNotReject(async () => { out = await ensureProfileKitWired(k.profileDir, k.deps); });
  assert.equal(out, false);
  assert.equal(k.calls.length, 1);
});

test("A2-5 설치기가 돌았는데 배선이 안 생기면 false(거짓 완료 없음) — 훅 없는 파일을 써도, 아무것도 안 써도", async () => {
  for (const writes of ["hookless", "none"] as const) {
    const k = fakeKit({ writes });
    let out: boolean | undefined;
    await assert.doesNotReject(async () => { out = await ensureProfileKitWired(k.profileDir, k.deps); }, writes);
    assert.equal(out, false, `${writes}: 배선이 없는데 true`);
    assert.equal(k.calls.length, 1, writes);
    // 배선이 여전히 없으니 다음 호출도 설치기를 다시 부른다(기억하지 않는다)
    assert.equal(await ensureProfileKitWired(k.profileDir, k.deps), false, writes);
    assert.equal(k.calls.length, 2, `${writes}: 다음 호출이 재시도하지 않았다`);
  }
});

test("A2-6 deps.cli 파일이 없으면(키트 미설치 호스트) 설치기 호출 없이 false — 이미 배선된 dir 는 그래도 true", async () => {
  const k = fakeKit({ writes: "wired" }, { cliMissing: true });
  assert.ok(!fs.existsSync(k.cli));
  let out: boolean | undefined;
  await assert.doesNotReject(async () => { out = await ensureProfileKitWired(k.profileDir, k.deps); });
  assert.equal(out, false);
  assert.equal(k.calls.length, 0, "cli 가 없는데 설치기를 불렀다");
  // 훅 없는 settings.json 이 있어도 마찬가지
  fs.writeFileSync(k.settingsPath, settingsWith({}));
  assert.equal(await ensureProfileKitWired(k.profileDir, k.deps), false);
  assert.equal(k.calls.length, 0);
  // 돌려주는 값은 «지금 배선이 있나» — 이미 배선돼 있으면 cli 가 없어도 true
  fs.writeFileSync(k.settingsPath, wiredSettings());
  assert.equal(await ensureProfileKitWired(k.profileDir, k.deps), true);
  assert.equal(k.calls.length, 0);
});

test("A2-7 같은 dir 로 동시에 세 번 — 설치기는 한 번, 전원 true · 끝난 뒤 다시 부르면 설치기 없이 true", async () => {
  const k = fakeKit({ writes: "wired", delayMs: 30 });
  const outs = await Promise.all([
    ensureProfileKitWired(k.profileDir, k.deps),
    ensureProfileKitWired(k.profileDir, k.deps),
    ensureProfileKitWired(k.profileDir, k.deps),
  ]);
  assert.deepEqual(outs, [true, true, true]);
  assert.equal(k.calls.length, 1, "동시 호출에 설치기가 여러 번 돌았다");
  assert.equal(await ensureProfileKitWired(k.profileDir, k.deps), true);
  assert.equal(k.calls.length, 1, "끝난 뒤 호출에 설치기가 또 돌았다");
});

test("A2-7b 동시 호출인데 설치기가 실패하면 — 한 번만 돌고 전원 같은 결과(false), 그 뒤 호출은 재시도", async () => {
  const k = fakeKit({ throws: true, writes: "wired", delayMs: 30 });
  const outs = await Promise.all([
    ensureProfileKitWired(k.profileDir, k.deps),
    ensureProfileKitWired(k.profileDir, k.deps),
    ensureProfileKitWired(k.profileDir, k.deps),
  ]);
  assert.deepEqual(outs, [false, false, false]);
  assert.equal(k.calls.length, 1);
  k.mode.throws = false;
  assert.equal(await ensureProfileKitWired(k.profileDir, k.deps), true);
  assert.equal(k.calls.length, 2);
});

test("A2-8 다른 dir 는 서로 묶이지 않는다 — 동시에 불려도 dir 마다 설치기 한 번씩, 각자 true", async () => {
  const a = fakeKit({ writes: "wired", delayMs: 20 });
  const b = fakeKit({ writes: "wired", delayMs: 20 });
  const outs = await Promise.all([
    ensureProfileKitWired(a.profileDir, a.deps),
    ensureProfileKitWired(b.profileDir, b.deps),
  ]);
  assert.deepEqual(outs, [true, true]);
  assert.equal(a.calls.length, 1, "a");
  assert.equal(b.calls.length, 1, "b");
  assert.equal(a.calls[0]!.env.CLAUDE_CONFIG_DIR, a.profileDir);
  assert.equal(b.calls[0]!.env.CLAUDE_CONFIG_DIR, b.profileDir);
});

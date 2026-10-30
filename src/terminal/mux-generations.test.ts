// 노드 tmux 세대 라우팅·gone 판정·빈 서버 정리 (#4931) — 사양 A·B·C·D 절.
//
// 두 층으로 잰다:
//  · routeTmux·goneByGeneration — 서버 상태를 손에 쥔 가짜 실행기(메모리)로. «어느 세대에 무엇이 나갔나» 를 호출 기록으로 본다.
//  · 프로덕션 배선(muxTmux·killEmptyMuxServers·muxUnansweredSessionIds) — 가짜 tmux **실행파일**(셸 스크립트)로. 실제 execFile·
//    `-L` 플래그·env 가 그대로 나간다. 진짜 tmux 서버는 한 번도 안 건드린다(실 tmux 는 mux-generations-real.test.ts).
import { strict as assert } from "node:assert";
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {
  routeTmux, goneByGeneration, configureMuxGenerations, resetMuxGenerationsForTest, muxTmux, killEmptyMuxServers,
  muxUnansweredSessionIds, liveGenerations, muxSocketsIn, muxClientEnv, MUX_STALE_LIST_MS,
  type MuxGeneration, type MuxRun, type MuxRouteDeps,
} from "./mux-generations.js";
import { muxSocketFor } from "./mux-pin.js";

//  ⚠ 세대 이름은 리터럴로 쓰지 않고 짓는 함수로 — `key: "<이름>"` 꼴은 비밀 스캔(gitleaks generic-api-key)이 키로 오인한다.
const S37C = muxSocketFor("3.7c");
const S37B = muxSocketFor("3.7b");
const CUR: MuxGeneration = { key: S37C, socket: S37C, bin: "/pin/tmux", noStart: true };
const LEG: MuxGeneration = { key: "default", socket: null, bin: "/brew/tmux", noStart: true };
const OLD: MuxGeneration = { key: S37B, socket: S37B, bin: "/pin-old/tmux", noStart: true };

type Srv = { up: boolean; hang?: boolean; sessions: Set<string> };
const execErr = (stderr: string): Error => Object.assign(new Error(`tmux: ${stderr}`), { code: 1, stdout: "", stderr: `${stderr}\n` });
const timeoutErr = (): Error => Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM", code: null, stdout: "", stderr: "" });

/** 세대별 가짜 tmux 서버 — 실행 기록(calls)에 «세대 key + argv» 를 남긴다. */
function world(spec: Record<string, Srv>, gens: MuxGeneration[] = [CUR, LEG], now = () => 1_000_000) {
  const calls: string[] = [];
  const run: MuxRun = async (g, args) => {
    calls.push(`${g.key}|${args.join(" ")}`);
    //  new-session 은 서버가 없으면 띄운다(tmux 그대로) — 그 밖의 명령은 서버가 없으면 «no server running».
    if (args[0] === "new-session" && !spec[g.key]?.up) spec[g.key] = { up: true, sessions: new Set() };
    const s = spec[g.key];
    if (!s || !s.up) throw execErr(`no server running on /private/tmp/tmux-501/${g.socket ?? "default"}`);
    if (s.hang) throw timeoutErr();
    const verb = args[0];
    const t = args.indexOf("-t") >= 0 ? args[args.indexOf("-t") + 1]!.replace(/^=/, "").split(/[:.]/)[0]! : null;
    if (verb === "has-session") { if (s.sessions.has(t!)) return ""; throw execErr(`can't find session: ${t}`); }
    if (verb === "new-session") { s.sessions.add(args[args.indexOf("-s") + 1]!); return ""; }
    if (verb === "list-sessions") return [...s.sessions].map((n) => `${n}\t1700000000`).join("\n") + (s.sessions.size ? "\n" : "");
    if (verb === "kill-session") { if (!s.sessions.delete(t!)) throw execErr(`can't find session: ${t}`); return ""; }
    if (t && !s.sessions.has(t)) throw execErr(`can't find session: ${t}`);
    return `ran@${g.key}`;
  };
  const deps: MuxRouteDeps = { gens, run, state: { where: new Map(), answers: new Map(), lastList: new Map() }, now };
  return { calls, deps, spec };
}
const up = (...names: string[]): Srv => ({ up: true, sessions: new Set(names) });
const down = (): Srv => ({ up: false, sessions: new Set() });
const LIST = ["list-sessions", "-F", "#{session_name}\t#{session_created}"];

test("A1 새 세션은 현재 세대에 선다 — 레거시엔 아무것도 안 나간다", async () => {
  const w = world({ [CUR.key]: down(), [LEG.key]: up("box-a-00000001") });
  await routeTmux(["new-session", "-d", "-s", "box-n-00000002", "-c", "/w"], w.deps);
  assert.deepEqual(w.calls, ["lively-mux-3.7c|new-session -d -s box-n-00000002 -c /w"]);
  assert.ok(w.spec[CUR.key]!.sessions.has("box-n-00000002"), "현재 세대 서버에 섰다");
  assert.equal(w.spec[LEG.key]!.sessions.has("box-n-00000002"), false);
});

test("A2 다른 세대에 살아 있다고 아는 id 로 새로 세우면 거절 — 아무것도 안 나간다", async () => {
  const w = world({ [CUR.key]: up(), [LEG.key]: up("box-a-00000001") });
  await routeTmux(LIST, w.deps);                    // 레거시가 답한 목록으로 배운다
  w.calls.length = 0;
  await assert.rejects(routeTmux(["new-session", "-d", "-s", "box-a-00000001"], w.deps), (e: { stderr?: string }) => /duplicate session: box-a-00000001/.test(String(e.stderr)));
  assert.deepEqual(w.calls, [], "확인 왕복도 실행도 없다");
});

test("A3 아는 세션의 지목 명령은 그 세대에만 간다(레거시 = 플래그 없는 세대)", async () => {
  const w = world({ [CUR.key]: up("box-n-00000002"), [LEG.key]: up("box-a-00000001") });
  await routeTmux(LIST, w.deps);
  w.calls.length = 0;
  assert.equal(await routeTmux(["display-message", "-p", "-t", "box-a-00000001", "#{pane_current_command}"], w.deps), "ran@default");
  assert.equal(await routeTmux(["set-option", "-t", "box-n-00000002", "@box_label", "x"], w.deps), "ran@lively-mux-3.7c");
  assert.deepEqual(w.calls, [
    "default|display-message -p -t box-a-00000001 #{pane_current_command}",
    "lively-mux-3.7c|set-option -t box-n-00000002 @box_label x",
  ]);
});

test("A4 모르는 세션은 현재 세대부터 찾아 그 세대로 보내고, 다음엔 다시 찾지 않는다", async () => {
  const w = world({ [CUR.key]: up(), [LEG.key]: up("box-a-00000001") });
  assert.equal(await routeTmux(["capture-pane", "-p", "-t", "box-a-00000001"], w.deps), "ran@default");
  assert.deepEqual(w.calls, [
    "lively-mux-3.7c|has-session -t box-a-00000001",
    "default|has-session -t box-a-00000001",
    "default|capture-pane -p -t box-a-00000001",
  ]);
  w.calls.length = 0;
  await routeTmux(["capture-pane", "-p", "-t", "box-a-00000001"], w.deps);
  assert.deepEqual(w.calls, ["default|capture-pane -p -t box-a-00000001"], "기억했다 — 찾기 없음");
});

test("A5 아무 세대에도 없으면(«없다»·서버 없음) «그런 세션 없다» 로 답하고 본 명령은 안 나간다", async () => {
  const w = world({ [CUR.key]: down(), [LEG.key]: up("box-a-00000001") });
  await assert.rejects(routeTmux(["send-keys", "-t", "box-z-0000dead", "x"], w.deps), (e: { stderr?: string }) => /can't find session: box-z-0000dead/.test(String(e.stderr)));
  assert.equal(w.calls.filter((c) => c.includes("send-keys")).length, 0);
});

test("A6 한 세대가 판정 불가(타임아웃)면 «없다» 가 아니라 그 판정 불가로 답한다", async () => {
  const w = world({ [CUR.key]: { up: true, hang: true, sessions: new Set() }, [LEG.key]: up() });
  await assert.rejects(routeTmux(["has-session", "-t", "box-z-0000dead"], w.deps), (e: { killed?: boolean; stderr?: string }) => e.killed === true && !/can't find/.test(String(e.stderr)));
});

test("A7·A8·A9 목록은 세대를 합친다 — 서버 없는 세대는 0행, 전부 없으면 «서버 없음»", async () => {
  const both = world({ [CUR.key]: up("box-n-00000002"), [LEG.key]: up("box-a-00000001", "SM") });
  const out = await routeTmux(LIST, both.deps);
  assert.deepEqual(out.trim().split("\n").map((l) => l.split("\t")[0]).sort(), ["SM", "box-a-00000001", "box-n-00000002"]);
  assert.deepEqual(both.calls.sort(), [`default|${LIST.join(" ")}`, `lively-mux-3.7c|${LIST.join(" ")}`]);

  const oneDown = world({ [CUR.key]: down(), [LEG.key]: up("box-a-00000001") });
  assert.equal((await routeTmux(LIST, oneDown.deps)).trim().split("\t")[0], "box-a-00000001");

  const allDown = world({ [CUR.key]: down(), [LEG.key]: down() });
  await assert.rejects(routeTmux(LIST, allDown.deps), (e: { stderr?: string }) => /no server running/.test(String(e.stderr)), "세션 0 확답의 모양 그대로");
});

test("A10·A11 판정 불가 세대는 60초 이내 직전 목록으로 메운다 — 없거나 더 오래됐으면 목록 전체가 실패", async () => {
  let t = 1_000_000;
  const w = world({ [CUR.key]: up("box-n-00000002"), [LEG.key]: up("box-a-00000001") }, [CUR, LEG], () => t);
  await routeTmux(LIST, w.deps);                       // 직전 목록(둘 다 답함)
  w.spec[LEG.key]!.hang = true;
  t += 30_000;
  const out = await routeTmux(LIST, w.deps);
  assert.match(out, /box-a-00000001/, "30초 전 목록으로 메웠다 — 레거시 세션이 «죽었다» 로 안 보인다");
  t += MUX_STALE_LIST_MS;                                // 직전 목록이 60초를 넘었다(30+60)
  await assert.rejects(routeTmux(LIST, w.deps), (e: { killed?: boolean }) => e.killed === true);
  const fresh = world({ [CUR.key]: up(), [LEG.key]: { up: true, hang: true, sessions: new Set() } });
  await assert.rejects(routeTmux(LIST, fresh.deps), (e: { killed?: boolean }) => e.killed === true, "메울 직전 목록이 없다");
});

test("A12 지목 없는 그 밖의 명령(전역 옵션)은 현재 세대에만 간다", async () => {
  const w = world({ [CUR.key]: up(), [LEG.key]: up("box-a-00000001") });
  await routeTmux(["set-option", "-g", "default-terminal", "xterm-256color"], w.deps);
  assert.deepEqual(w.calls, ["lively-mux-3.7c|set-option -g default-terminal xterm-256color"]);
});

test("A13 기억한 세대가 «그런 세션 없다» 고 답하면 그대로 올리고 잊는다 — 다음엔 다시 찾는다", async () => {
  const w = world({ [CUR.key]: up(), [LEG.key]: up("box-a-00000001") });
  await routeTmux(LIST, w.deps);
  w.spec[LEG.key]!.sessions.delete("box-a-00000001");
  await assert.rejects(routeTmux(["send-keys", "-t", "box-a-00000001", "x"], w.deps), (e: { stderr?: string }) => /can't find session/.test(String(e.stderr)));
  w.calls.length = 0;
  await assert.rejects(routeTmux(["send-keys", "-t", "box-a-00000001", "x"], w.deps));
  assert.deepEqual(w.calls, ["lively-mux-3.7c|has-session -t box-a-00000001", "default|has-session -t box-a-00000001"], "잊었으니 다시 찾았다");
});

test("A14 `-t 세션:창.판` · `-t =세션` 도 세션 부분으로 라우팅한다", async () => {
  const w = world({ [CUR.key]: up(), [LEG.key]: up("box-a-00000001") });
  assert.equal(await routeTmux(["send-keys", "-t", "box-a-00000001:0.1", "x"], w.deps), "ran@default");
  assert.equal(await routeTmux(["send-keys", "-t", "=box-a-00000001", "x"], w.deps), "ran@default");
});

test("A15 경계 — 세대가 하나뿐이면(off·전용 없음) 그 하나로만", async () => {
  const w = world({ [LEG.key]: up("box-a-00000001") }, [LEG]);
  await routeTmux(["new-session", "-d", "-s", "box-n-00000002"], w.deps);
  await routeTmux(LIST, w.deps);
  assert.ok(w.calls.every((c) => c.startsWith("default|")));
});

// ── B. gone 판정 — 그 세션의 세대 하나로 ─────────────────────────────────────────────
async function learned(w: ReturnType<typeof world>): Promise<void> { await routeTmux(LIST, w.deps); }

test("B1·B2 아는 세대가 «있다» → 살아 있음 · «그런 세션 없다» → 끝남", async () => {
  const w = world({ [CUR.key]: up(), [LEG.key]: up("box-a-00000001") });
  await learned(w);
  assert.equal(await goneByGeneration("box-a-00000001", w.deps), false);
  w.spec[LEG.key]!.sessions.delete("box-a-00000001");
  assert.equal(await goneByGeneration("box-a-00000001", w.deps), true);
});

test("★ B3 아는 세대의 서버가 없으면 끝남 — 다른 세대 서버가 살아 있어도(«서버가 있다» 로 읽지 않는다)", async () => {
  const w = world({ [CUR.key]: up("box-n-00000002"), [LEG.key]: up("box-a-00000001") });
  await learned(w);
  w.spec[LEG.key] = down();                              // 3.6a 크래시 — 레거시 서버째 사라졌다
  w.calls.length = 0;
  assert.equal(await goneByGeneration("box-a-00000001", w.deps), true, "#4917 — 서버가 죽은 세션은 복원돼야 한다");
  assert.ok(w.calls.every((c) => c.startsWith("default|")), `그 세대에만 물었다: ${w.calls.join(" · ")}`);
});

test("B4 아는 세대가 «서버 없음» 이었다가 다시 물으니 서버가 답하면 살아 있음(일시 거절)", async () => {
  const w = world({ [CUR.key]: up(), [LEG.key]: up("box-a-00000001") });
  await learned(w);
  let first = true;
  const run = w.deps.run;
  w.deps.run = async (g, a) => {
    if (g.key === LEG.key && a[0] === "has-session" && first) { first = false; throw execErr("no server running on /private/tmp/tmux-501/default"); }
    return run(g, a);
  };
  assert.equal(await goneByGeneration("box-a-00000001", w.deps), false);
});

test("B5 아는 세대가 판정 불가면 살아 있음(종전 접기)", async () => {
  const w = world({ [CUR.key]: up(), [LEG.key]: up("box-a-00000001") });
  await learned(w);
  w.spec[LEG.key]!.hang = true;
  assert.equal(await goneByGeneration("box-a-00000001", w.deps), false);
});

test("B6·B7·B8 모르는 세션 — 모두 «없다/서버 없음» 이면 끝남 · 하나라도 판정 불가면 살아 있음 · 찾으면 살아 있음", async () => {
  const none = world({ [CUR.key]: down(), [LEG.key]: up() });
  assert.equal(await goneByGeneration("box-z-0000dead", none.deps), true);
  const allDown = world({ [CUR.key]: down(), [LEG.key]: down() });
  assert.equal(await goneByGeneration("box-z-0000dead", allDown.deps), true, "그 PC 에 tmux 서버가 아예 없다(#4917)");
  const hung = world({ [CUR.key]: { up: true, hang: true, sessions: new Set() }, [LEG.key]: up() });
  assert.equal(await goneByGeneration("box-z-0000dead", hung.deps), false);
  const there = world({ [CUR.key]: up(), [LEG.key]: up("box-a-00000001") });
  assert.equal(await goneByGeneration("box-a-00000001", there.deps), false);
});

test("B9 «서버 없음» 확답은 좁다 — 권한 같은 접속 오류는 끝남이 아니다(자동 복원으로 이어지는 판정이라)", async () => {
  const denied = (): Error => execErr("error connecting to /private/tmp/tmux-501/lively-mux-3.7c (Permission denied)");
  const w = world({ [CUR.key]: up("box-n-00000002"), [LEG.key]: up() });
  await learned(w);
  w.deps.run = async (g) => { throw g.key === CUR.key ? denied() : execErr("can't find session: box-n-00000002"); };
  assert.equal(await goneByGeneration("box-n-00000002", w.deps), false, "아는 세대가 권한 오류 — 살아 있음");
  const fresh = world({ [CUR.key]: up(), [LEG.key]: up() });
  fresh.deps.run = async (g) => { throw g.key === CUR.key ? denied() : execErr("can't find session: box-z-0000dead"); };
  assert.equal(await goneByGeneration("box-z-0000dead", fresh.deps), false, "모르는 세션 — 한 세대가 권한 오류면 거기 있을 수 있다");
  const enoent = world({ [CUR.key]: up(), [LEG.key]: up() });
  enoent.deps.run = async (g) => { throw g.key === CUR.key ? execErr("error connecting to /private/tmp/tmux-501/lively-mux-3.7c (No such file or directory)") : execErr("can't find session: box-z-0000dead"); };
  assert.equal(await goneByGeneration("box-z-0000dead", enoent.deps), true, "소켓 파일 없음은 확답(종전 노드 판정과 같은 자)");
});

// ── 프로덕션 배선 — 가짜 tmux 실행파일 ───────────────────────────────────────────────
const FAKE = fs.mkdtempSync(path.join(os.tmpdir(), "mux-gen-"));
after(() => fs.rmSync(FAKE, { recursive: true, force: true }));
const FAKE_BIN = path.join(FAKE, "fake-tmux");
fs.writeFileSync(FAKE_BIN, `#!/bin/sh
d="$FAKE_TMUX_DIR"; sock=default
if [ "$1" = "-L" ]; then sock="$2"; shift 2; fi
[ "$1" = "-N" ] && shift
echo "$sock|$*|tok=\${LIVELY_NODE_TOKEN:-}|tmux=\${TMUX:-}" >> "$d/calls.log"
f="$d/$sock.sessions"
[ -f "$f" ] || { echo "no server running on /tmp/tmux-x/$sock" >&2; exit 1; }
case "$1" in
  list-sessions) cat "$f";;
  kill-server) rm -f "$f";;
  has-session) grep -qx "$3" "$f" || { echo "can't find session: $3" >&2; exit 1; };;
esac
`, { mode: 0o755 });
const skipPosix = process.platform === "win32" ? "윈도우 — 셸 스크립트 실행파일" : false;
const fakeEnv = (dir: string): NodeJS.ProcessEnv => ({ ...process.env, FAKE_TMUX_DIR: dir, LIVELY_NODE_TOKEN: "lvk_secret_never_in_pane", TMUX: "/tmp/tmux-501/default,1,0" });
function scenario(name: string, servers: Record<string, string[]>): { dir: string; calls: () => string[] } {
  const dir = path.join(FAKE, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [sock, sessions] of Object.entries(servers)) fs.writeFileSync(path.join(dir, `${sock}.sessions`), sessions.map((s) => `${s}\n`).join(""));
  return { dir, calls: () => { try { return fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean); } catch { return []; } } };
}
function setupFake(current: MuxGeneration, socketDir: string): void {
  configureMuxGenerations({ current, legacy: { ...LEG, bin: FAKE_BIN }, socketDir, binFor: () => null });
}
after(() => resetMuxGenerationsForTest());

test("배선 — 실제 execFile 이 `-L <세대>` 로 나가고 노드 토큰·$TMUX 는 tmux 에 안 넘어간다", { skip: skipPosix }, async () => {
  const sc = scenario("wiring", { "lively-mux-3.7c": [], default: ["box-a-00000001"] });
  resetMuxGenerationsForTest(); setupFake({ ...CUR, bin: FAKE_BIN }, path.join(FAKE, "no-socket-dir"));
  await muxTmux(["new-session", "-d", "-s", "box-n-00000002"], { timeoutMs: 5_000, env: fakeEnv(sc.dir) });
  await muxTmux(["display-message", "-p", "-t", "box-a-00000001", "x"], { timeoutMs: 5_000, env: fakeEnv(sc.dir) });
  const calls = sc.calls();
  assert.ok(calls.length >= 2, "가짜 tmux 가 실제로 불렸다(배선 확인)");
  assert.ok(calls.some((c) => c.startsWith("lively-mux-3.7c|new-session -d -s box-n-00000002|")), calls.join("\n"));
  assert.ok(calls.some((c) => c.startsWith("default|display-message -p -t box-a-00000001 x|")), calls.join("\n"));
  for (const c of calls) {
    assert.match(c, /\|tok=\|/, "노드 토큰이 tmux 클라이언트 env 에 실렸다 — 그 서버의 모든 판에 물려준다");
    assert.match(c, /\|tmux=$/, "$TMUX 가 실렸다 — 레거시(플래그 없음)가 기본 소켓이 아니라 그 판의 서버로 간다");
  }
  assert.equal(muxClientEnv(fakeEnv(sc.dir)).FAKE_TMUX_DIR, sc.dir, "나머지 env 는 그대로");
});

test("D1·D2·D4 빈 서버 정리 — 비어 있는 전용 세대만 끈다 · 레거시(현재가 아님)는 비어도 안 끈다 · 목록 실패한 세대도 안 끈다", { skip: skipPosix }, async () => {
  const sc = scenario("kill-empty", { "lively-mux-3.7c": [], default: [] });
  resetMuxGenerationsForTest(); setupFake({ ...CUR, bin: FAKE_BIN }, path.join(FAKE, "no-socket-dir"));
  const killed = await killEmptyMuxServers({ timeoutMs: 5_000, env: fakeEnv(sc.dir) });
  assert.deepEqual(killed, ["lively-mux-3.7c"]);
  const kills = sc.calls().filter((c) => c.includes("|kill-server|"));
  assert.deepEqual(kills.map((c) => c.split("|")[0]), ["lively-mux-3.7c"], "레거시(사람·다른 게이트웨이의 서버일 수 있다)는 kill-server 0건");

  const sc2 = scenario("kill-empty-down", { default: ["box-a-00000001"] });   // 현재 세대 서버 없음
  resetMuxGenerationsForTest(); setupFake({ ...CUR, bin: FAKE_BIN }, path.join(FAKE, "no-socket-dir"));
  assert.deepEqual(await killEmptyMuxServers({ timeoutMs: 5_000, env: fakeEnv(sc2.dir) }), []);
  assert.equal(sc2.calls().filter((c) => c.includes("|kill-server|")).length, 0);
});

test("D3 레거시가 현재 세대면(off) 종전대로 비어 있으면 끈다(#869 자가치유 유지)", { skip: skipPosix }, async () => {
  const sc = scenario("kill-empty-off", { default: [] });
  resetMuxGenerationsForTest();
  configureMuxGenerations({ current: { ...LEG, bin: FAKE_BIN }, legacy: { ...LEG, bin: FAKE_BIN }, socketDir: path.join(FAKE, "no-socket-dir"), binFor: () => null });
  assert.deepEqual(await killEmptyMuxServers({ timeoutMs: 5_000, env: fakeEnv(sc.dir) }), ["default"]);
});

test("C1 지난 목록에 답하지 못한 세대의 세션은 신원 파일 걷기에서 지킨다", { skip: skipPosix }, async () => {
  const sc = scenario("unanswered", { "lively-mux-3.7c": ["box-n-00000002"], default: ["box-a-00000001"] });
  resetMuxGenerationsForTest(); setupFake({ ...CUR, bin: FAKE_BIN }, path.join(FAKE, "no-socket-dir"));
  const env = fakeEnv(sc.dir);
  await muxTmux(LIST, { timeoutMs: 5_000, env });          // 둘 다 답했다 — 둘 다 배운다
  assert.deepEqual([...muxUnansweredSessionIds()], []);
  fs.rmSync(path.join(sc.dir, "default.sessions"));         // 레거시가 잠깐 연결을 거부한다(서버 없음 문구)
  const out = await muxTmux(LIST, { timeoutMs: 5_000, env });
  assert.equal(out.trim().split("\t")[0], "box-n-00000002", "목록은 비지 않는다 — 종전 «빈 목록이면 안 걷는다» 가드로는 못 막는 모양");
  assert.deepEqual([...muxUnansweredSessionIds()], ["box-a-00000001"]);
});

test("지난 전용 세대는 소켓 디렉터리의 `lively-mux-*` **소켓** 에서 찾는다 — 일반 파일·남의 소켓은 아니다", { skip: skipPosix }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-sock-"));
  const servers: net.Server[] = [];
  const listen = (name: string) => new Promise<void>((res) => { const s = net.createServer(); servers.push(s); s.listen(path.join(dir, name), () => res()); });
  try {
    await listen("lively-mux-3.7b");
    await listen("lvly-acme");
    await listen("default");
    fs.writeFileSync(path.join(dir, "lively-mux-notasocket"), "");
    assert.deepEqual(muxSocketsIn(dir), ["lively-mux-3.7b"]);
    assert.deepEqual(muxSocketsIn(path.join(dir, "nope")), [], "디렉터리가 없으면 빈 목록");
    resetMuxGenerationsForTest();
    configureMuxGenerations({ current: CUR, legacy: LEG, socketDir: dir, binFor: (v) => (v === "3.7b" ? OLD.bin : null) });
    assert.deepEqual(liveGenerations().map((g) => [g.key, g.socket, g.bin]), [
      ["lively-mux-3.7c", "lively-mux-3.7c", "/pin/tmux"], ["default", null, "/brew/tmux"], ["lively-mux-3.7b", "lively-mux-3.7b", "/pin-old/tmux"],
    ], "현재 세대가 맨 앞 · 지난 세대는 그 판의 바이너리로");
  } finally {
    for (const s of servers) s.close();
    fs.rmSync(dir, { recursive: true, force: true });
    resetMuxGenerationsForTest();
  }
});

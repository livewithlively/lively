// 노드 tmux 세대 — **진짜 tmux** 로 잰다 (#4931, 사양 I 절).
//
//  레거시(기본 소켓)에 있던 세션은 그대로 보이고 다뤄지고, 새 세션은 `lively-mux-<판>` 소켓에 서며, 목록은 둘을 합치고, 지목 명령은
//  각자 서버로 간다 — 그걸 **tmux 자신에게** 물어 확인한다(`#{socket_path}`). 가짜 실행기로는 «그 tmux 가 정말 그 소켓에 붙나» 를 못 잰다.
//
// ⚠ 격리(지식 tmux-experiment-isolation-tmux-env-beats-tmpdir-3545 — 이 맥미니에서 47개 세션이 날아간 사고의 규칙):
//  ① `$TMUX` 를 지운다(TMUX_TMPDIR 만으로는 격리가 안 된다 — `$TMUX` 가 이긴다) ② 소켓 폴더는 빈 임시 폴더 ③ 쓰기 전에 «내 것만
//  보이나» 를 역검증한다 ④ kill-server 를 쓰지 않는다(지울 세션만 이름으로 지운다 — 서버는 빈 채로 스스로 끝난다).
//  HOME 도 임시로 둔다 — 사람의 ~/.tmux.conf(exit-empty off 등)가 시험 서버에 안 읽히게.
import { strict as assert } from "node:assert";
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SOCKDIR = fs.mkdtempSync(path.join(os.tmpdir(), "mux-real-"));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mux-real-home-"));
const TMUX = process.platform === "win32" ? "" : spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
delete process.env.TMUX;
delete process.env.TMUX_PANE;
delete process.env.LIVELY_TMUX_EXEC;
process.env.TMUX_TMPDIR = SOCKDIR;
process.env.HOME = HOME;
process.env.LIVELY_NODE_TOKEN = "test-node-token";
if (TMUX) process.env.TMUX_BIN = TMUX;
const { tmux, sessionGoneOnNode } = await import("./tmux-exec.js");
const { configureMuxGenerations, resetMuxGenerationsForTest, muxAttachPrefix } = await import("./mux-generations.js");
const { killEmptyTmuxServer } = await import("./sessions.js");
const { muxSocketDir, binVersion } = await import("../node/mux-install.js");
const { tmuxKnowsNoStartFlag, muxSocketFor } = await import("./mux-pin.js");

const VER = TMUX ? binVersion(TMUX) : null;
const skip = !TMUX ? "tmux 없음" : !VER ? "tmux 판을 못 읽음" : false;
const SOCK = muxSocketFor(VER ?? "x");
const env = { ...process.env };
const raw = (...a: string[]) => spawnSync(TMUX || "tmux", a, { encoding: "utf8", env });
const LEGACY_ID = "box-legacy-0000aaaa";
const NEW_ID = "box-node-0000bbbb";
const PERSONAL = `sm-mux-test-${process.pid}`;   // 사람의 개인 세션 자리 — 시험 전용 이름(사람의 실제 세션 이름과 겹치지 않게)
let isolated = false;                              // 아래 역검증을 통과했을 때만 참 — 정리는 그때만 tmux 에 말한다

after(() => {
  //  ⚠ 격리를 확인하지 못했으면 tmux 에 아무것도 보내지 않는다 — 격리가 깨진 날 정리가 사람의 서버에 대고 돌면 안 된다(리뷰 지적).
  //  지울 세션만 **정확한 이름**(`=이름`)으로(kill-server 금지 · 앞부분 일치로 남의 세션을 잡지 않게). 서버는 세션이 0 이 되면 스스로 끝난다.
  if (isolated) for (const [flags, id] of [[[], LEGACY_ID], [[], PERSONAL], [["-L", SOCK], NEW_ID]] as const) raw(...flags, "kill-session", "-t", `=${id}`);
  resetMuxGenerationsForTest();
  fs.rmSync(SOCKDIR, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

test("I 레거시 세션은 그대로 · 새 세션은 lively-mux-<판> · 목록은 합치고 · 지목은 각자 서버로 · 빈 서버 정리는 레거시를 안 끈다", { skip }, async () => {
  //  ③ 역검증 — 시험 소켓 폴더의 두 소켓 모두 서버가 없어야 한다. 남의 세션이 보이면 즉시 멈춘다.
  for (const flags of [[], ["-L", SOCK]]) {
    const r = raw(...flags, "list-sessions");
    assert.notEqual(r.status, 0, `격리 실패 — 시험 소켓에 서버가 있다: ${r.stdout}`);
    assert.match(r.stderr, /no server running|error connecting/, r.stderr);
  }
  isolated = true;
  //  종전 노드가 만들어 둔 세션 둘(노드 세션 + 사람의 개인 세션) — 기본 소켓.
  assert.equal(raw("new-session", "-d", "-s", LEGACY_ID, "sleep 600").status, 0);
  assert.equal(raw("new-session", "-d", "-s", PERSONAL, "sleep 600").status, 0);
  const defaultSock = raw("display-message", "-p", "-t", LEGACY_ID, "#{socket_path}").stdout.trim();
  assert.ok(defaultSock.startsWith(fs.realpathSync(SOCKDIR)), `시험 소켓 폴더 안이다: ${defaultSock}`);

  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const cur = { key: SOCK, socket: SOCK, bin: TMUX, noStart: tmuxKnowsNoStartFlag(VER) };
  configureMuxGenerations({ current: cur, legacy: { key: "default", socket: null, bin: TMUX, noStart: cur.noStart }, socketDir: muxSocketDir(process.env, uid), binFor: () => null });

  //  새 세션 — 제품 경로(tmux-exec)로 세운다.
  await tmux(["new-session", "-d", "-s", NEW_ID, "sleep 600"]);
  assert.equal(raw("-L", SOCK, "has-session", "-t", NEW_ID).status, 0, "새 세션은 lively-mux-<판> 서버에 섰다");
  assert.notEqual(raw("has-session", "-t", NEW_ID).status, 0, "기본 소켓엔 안 섰다");

  //  목록은 둘을 합친다.
  const names = (await tmux(["list-sessions", "-F", "#{session_name}"])).trim().split("\n").sort();
  assert.deepEqual(names, [PERSONAL, LEGACY_ID, NEW_ID].sort());

  //  지목 명령은 각자 서버로 — tmux 자신이 어느 소켓인지 답한다.
  assert.equal((await tmux(["display-message", "-p", "-t", LEGACY_ID, "#{socket_path}"])).trim(), defaultSock);
  assert.match((await tmux(["display-message", "-p", "-t", NEW_ID, "#{socket_path}"])).trim(), new RegExp(`/${SOCK.replace(/\./g, "\\.")}$`));
  await tmux(["set-option", "-t", LEGACY_ID, "@box_label", "옛 세션"]);
  assert.equal(raw("show-options", "-t", LEGACY_ID, "-v", "@box_label").stdout.trim(), "옛 세션", "레거시 세션의 옵션이 레거시 서버에 박혔다");

  //  attach 접두 — 레거시는 플래그 없이, 새 세션은 -L. 둘 다 -N(서버를 새로 띄우지 않는다 — #4605)이면 판이 3.2 이상일 때.
  const n = cur.noStart ? ["-N"] : [];
  assert.deepEqual((await muxAttachPrefix(LEGACY_ID, { timeoutMs: 5_000, env: process.env }))?.argv, [TMUX, ...n]);
  assert.deepEqual((await muxAttachPrefix(NEW_ID, { timeoutMs: 5_000, env: process.env }))?.argv, [TMUX, "-L", SOCK, ...n]);

  //  gone — 살아 있음 → 지운 뒤 끝남(그 세션의 세대로 판정).
  assert.equal(await sessionGoneOnNode(LEGACY_ID), false);
  await tmux(["kill-session", "-t", LEGACY_ID]);
  assert.equal(await sessionGoneOnNode(LEGACY_ID), true);
  assert.equal(await sessionGoneOnNode(NEW_ID), false);

  //  빈 서버 정리 — 레거시(사람의 개인 세션이 남은 기본 소켓)는 그대로. 새 세대는 세션이 있어 그대로.
  await killEmptyTmuxServer();
  assert.equal(raw("has-session", "-t", `=${PERSONAL}`).status, 0, "사람의 개인 세션이 산다");
  assert.equal(raw("-L", SOCK, "has-session", "-t", NEW_ID).status, 0);
});

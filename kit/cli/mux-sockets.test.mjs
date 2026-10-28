// 노드 tmux 세대 — 키트(CLI) 쪽 두 자리 (#4931).
//  ① `lively node` 가 env 파일을 다시 써도 LIVELY_MUX_PIN 이 남는다 · 형식 밖 값은 안 쓴다(그 파일은 데몬 기동 때 셸이 읽는다).
//  ② CLI 가 찾는 세대 소켓 = 노드 에이전트가 찾는 세대 소켓 — 소켓 폴더 규칙이 키트·src 두 벌이라 **같은 답**인지 잰다.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nodeMuxPinLine } from "./cmd-node.mjs";
import { livelyMuxSockets } from "./lively.mjs";

test("① LIVELY_MUX_PIN — 이번 실행 env 가 이기고, 없으면 파일 값 · 정확히 auto·bin·off 만 싣는다", () => {
  assert.equal(nodeMuxPinLine("auto", null), "LIVELY_MUX_PIN=auto\n");
  assert.equal(nodeMuxPinLine(undefined, "off"), "LIVELY_MUX_PIN=off\n", "사람이 넣은 줄이 다시 쓰기에 살아남는다");
  assert.equal(nodeMuxPinLine("bin", "off"), "LIVELY_MUX_PIN=bin\n", "이번 실행이 이긴다");
  assert.equal(nodeMuxPinLine(" auto ", null), "LIVELY_MUX_PIN=auto\n");
  assert.equal(nodeMuxPinLine(undefined, null), "", "없으면 줄을 안 쓴다(에이전트 기본값)");
  assert.equal(nodeMuxPinLine("$(touch /tmp/pwned)", null), "", "셸이 읽는 파일 — 형식 밖은 버린다");
  assert.equal(nodeMuxPinLine("auto\nrm -rf ~", "off"), "LIVELY_MUX_PIN=off\n", "줄바꿈 낀 값은 버리고 파일 값으로");
  assert.equal(nodeMuxPinLine("AUTO", null), "");
});

const skip = process.platform === "win32" ? "윈도우 — 유닉스 소켓 없음" : false;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mux-sock-kit-"));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test("② CLI 가 찾는 세대 소켓 — `lively-mux-*` 소켓만 · 노드 에이전트(src)와 같은 폴더·같은 답", { skip }, async () => {
  const uid = 4931;
  const real = fs.realpathSync(DIR);
  const sockDir = path.join(real, `tmux-${uid}`);
  fs.mkdirSync(sockDir, { recursive: true });
  const servers = [];
  const listen = (name) => new Promise((res) => { const s = net.createServer(); servers.push(s); s.listen(path.join(sockDir, name), res); });
  try {
    await listen("lively-mux-3.7c");
    await listen("lively-mux-3.6a");
    await listen("default");
    fs.writeFileSync(path.join(sockDir, "lively-mux-plainfile"), "");
    const env = { TMUX_TMPDIR: DIR };
    assert.deepEqual(livelyMuxSockets(env, uid), ["lively-mux-3.6a", "lively-mux-3.7c"]);
    assert.deepEqual(livelyMuxSockets({ TMUX_TMPDIR: path.join(DIR, "nope") }, uid), [], "TMUX_TMPDIR 가 없는 폴더면 /tmp 로 간다(거긴 이 uid 폴더가 없다)");
    //  src 쪽 정본과 같은 답 — 빌드가 있을 때만(키트 시험은 dist 없이도 돈다).
    const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");
    if (existsSync(path.join(dist, "node", "mux-install.js"))) {
      const { muxSocketDir } = await import(pathToFileURL(path.join(dist, "node", "mux-install.js")).href);
      const { muxSocketsIn } = await import(pathToFileURL(path.join(dist, "terminal", "mux-generations.js")).href);
      assert.equal(muxSocketDir(env, uid), sockDir, "폴더 규칙이 같다");
      assert.deepEqual(muxSocketsIn(muxSocketDir(env, uid)), livelyMuxSockets(env, uid), "찾는 소켓이 같다");
    }
  } finally { for (const s of servers) s.close(); }
});

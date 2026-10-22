// 노드 tmux 고정판 표·판 토큰·세대 소켓 이름 (#4931) — 사양 F 절. 순수 함수만 잰다.
import { strict as assert } from "node:assert";
import test from "node:test";
import path from "node:path";
import {
  TMUX_PIN, tmuxPinAssetFor, tmuxPinDir, tmuxPinBin, tmuxPinUrl, parseTmuxVersion, tmuxKnowsNoStartFlag,
  muxSocketFor, muxSocketVersion, MUX_SOCKET_PREFIX,
} from "./mux-pin.js";

test("F1 고정판은 3.7c — 3.6a 크래시(tmux #4980, control_write NULL control_state)의 고침이 든 첫 사전빌드 판", () => {
  assert.equal(TMUX_PIN.version, "3.7c");
  for (const a of Object.values(TMUX_PIN.assets)) {
    assert.match(a.sha256, /^[0-9a-f]{64}$/, `${a.file}: 해시는 소문자 16진수 64자`);
    assert.ok(a.file.startsWith(`tmux-${TMUX_PIN.version}-`) && a.file.endsWith(".tar.gz"), `${a.file}: 업스트림 애셋 이름 규칙`);
  }
  assert.equal(tmuxPinUrl("3.7c", "tmux-3.7c-macos-arm64.tar.gz"),
    "https://github.com/tmux/tmux-builds/releases/download/v3.7c/tmux-3.7c-macos-arm64.tar.gz");
});

test("F2 받을 수 있는 기기 표 — 맥은 Darwin 24(macOS 15) 이상만, 경계 24.0.0 은 받는다", () => {
  const got = (pf: string, arch: string, rel: string) => {
    const r = tmuxPinAssetFor(pf, arch, rel);
    return "asset" in r ? r.asset.file : null;
  };
  assert.equal(got("darwin", "arm64", "25.2.0"), "tmux-3.7c-macos-arm64.tar.gz");
  assert.equal(got("darwin", "x64", "25.2.0"), "tmux-3.7c-macos-x86_64.tar.gz");
  assert.equal(got("darwin", "arm64", "24.0.0"), "tmux-3.7c-macos-arm64.tar.gz", "경계 — 정확히 macOS 15");
  assert.equal(got("darwin", "arm64", "23.6.0"), null, "macOS 14 — minos 15.0 바이너리는 못 돈다");
  assert.equal(got("darwin", "arm64", ""), null, "모르는 커널 판은 받지 않는다");
  assert.equal(got("darwin", "arm64", "abc"), null);
  assert.equal(got("linux", "x64", "6.8.0"), "tmux-3.7c-linux-x86_64.tar.gz");
  assert.equal(got("linux", "arm64", "6.8.0"), "tmux-3.7c-linux-arm64.tar.gz");
  assert.equal(got("linux", "ia32", "6.8.0"), null, "사전빌드 없는 CPU");
  assert.equal(got("win32", "x64", "10.0.26100"), null, "윈도우는 psmux(다음 단계)");
  assert.equal(got("freebsd", "x64", "14.0"), null);
});

test("F3 판별 폴더는 `~/.lively/bin/tmux-<판>/tmux` — 키트 폴백의 파일 자리(`~/.lively/bin/tmux`)와 겹치지 않는다", () => {
  assert.equal(tmuxPinDir("/h"), path.join("/h", ".lively", "bin", "tmux-3.7c"));
  assert.equal(tmuxPinBin("/h"), path.join("/h", ".lively", "bin", "tmux-3.7c", "tmux"));
  assert.equal(tmuxPinBin("/h", "3.8a"), path.join("/h", ".lively", "bin", "tmux-3.8a", "tmux"));
  assert.notEqual(tmuxPinDir("/h"), path.join("/h", ".lively", "bin", "tmux"));
});

test("F4 `tmux -V` 판 토큰 — tmux 가 아니면 null, 이상한 글자는 다듬는다", () => {
  assert.equal(parseTmuxVersion("tmux 3.7c\n"), "3.7c");
  assert.equal(parseTmuxVersion("tmux 3.6a"), "3.6a");
  assert.equal(parseTmuxVersion("tmux next-3.8\n"), "next-3.8");
  assert.equal(parseTmuxVersion("psmux 3.4.0"), null, "psmux 는 이 모듈의 대상이 아니다");
  assert.equal(parseTmuxVersion(""), null);
  assert.equal(parseTmuxVersion("sh: tmux: not found"), null);
  assert.equal(parseTmuxVersion("tmux 3.7c/x"), "3.7c_x", "소켓 이름에 못 쓰는 글자는 _ 로");
});

test("F5 `-N` 을 아는 판 — 경계 3.2 는 안다, 3.1c 는 모른다, 모르는 판은 모른다", () => {
  assert.equal(tmuxKnowsNoStartFlag("3.2"), true, "경계 — 3.2 에서 들어왔다");
  assert.equal(tmuxKnowsNoStartFlag("3.2a"), true);
  assert.equal(tmuxKnowsNoStartFlag("3.1c"), false, "Debian 11 의 판 — 붙이면 attach 가 통째로 실패한다");
  assert.equal(tmuxKnowsNoStartFlag("2.9"), false);
  assert.equal(tmuxKnowsNoStartFlag("3.7c"), true);
  assert.equal(tmuxKnowsNoStartFlag("next-3.8"), true);
  assert.equal(tmuxKnowsNoStartFlag("4.0"), true);
  assert.equal(tmuxKnowsNoStartFlag("master"), false);
  assert.equal(tmuxKnowsNoStartFlag(null), false);
});

test("F6 세대 소켓 이름 ↔ 판 — 접두가 다르거나 판이 비면 우리 것이 아니다(사람이 지은 `lively-dev` 같은 이름과 안 겹친다)", () => {
  assert.equal(MUX_SOCKET_PREFIX, "lively-mux-");
  assert.equal(muxSocketFor("3.7c"), "lively-mux-3.7c");
  assert.equal(muxSocketVersion("lively-mux-3.7c"), "3.7c");
  assert.equal(muxSocketVersion(muxSocketFor("next-3.8")), "next-3.8");
  assert.equal(muxSocketVersion("default"), null);
  assert.equal(muxSocketVersion("lively-mux-"), null);
  assert.equal(muxSocketVersion("lively-dev"), null, "사람이 `tmux -L lively-dev` 로 띄운 서버는 우리 세대가 아니다(목록·빈 서버 정리·하강 가드에 안 든다)");
  assert.equal(muxSocketVersion("lively-3.7c"), null);
  assert.equal(muxSocketVersion("lvly-acme"), null, "registry 테넌트 소켓(lvly-<slug>)은 남의 것");
  assert.equal(muxSocketVersion("lively-mux-3.7c/x"), null);
});

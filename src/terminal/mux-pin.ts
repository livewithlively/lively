// 노드가 쓰는 tmux 의 **고정판**과 그 판별 자리·세대 이름 (#4931). 순수 잎 — 런타임 import 는 node:path 하나뿐이다.
//
// ── 왜 판을 우리가 정하나 ─────────────────────────────────────────────────────────
//  종전엔 노드가 그 PC 에 깔린 tmux 를 판 무관 그대로 썼다(kit `ensureTmux` — 찾으면 버전을 안 본다).
//  2026-10-19 맥미니 노드의 brew tmux **3.6a** 서버가 segfault 로 죽어 그 PC 세션이 전부 사라졌다
//  (스택 `control_write ← control_notify_client_detached`, 주소 0x20 — 지식 node-tmux-server-absent-restore-already-4917).
//  같은 결함이 업스트림 tmux #4980 이다: 식별이 덜 끝난 제어(-CC) 클라이언트의 `control_state` 가 NULL 인데 알림을 쓴다.
//  고침(`CONTROL_SHOULD_NOTIFY_CLIENT` 에 `control_state != NULL`)은 3.7 부터 들어 있다(3.6a 엔 없다 — 소스 대조).
//  우리 웹 터미널은 제어 클라이언트를 여럿 붙였다 뗐다 하므로 이 결함을 정확히 밟는다. 그래서 판을 고른다.
//
// ── 무엇으로 고정하나 ─────────────────────────────────────────────────────────────
//  tmux 조직이 직접 굽는 사전빌드(github.com/tmux/tmux-builds)의 **3.7c**. 3.8 은 업스트림에 나왔지만 사전빌드가 아직 없다.
//  ★ 해시는 **여기 박는다** — 내려받는 자리(GitHub·게이트웨이 중계·손으로 놓은 파일)가 어디든 같은 바이트여야 한다.
//   종전 키트 폴백(`installTmuxFromRelease`)은 API 가 주는 digest 를 믿었다. 그건 «API 가 말한 것과 같은가» 이지 «우리가
//   고른 것인가» 가 아니다. 값은 2026-10-20 에 네 애셋을 내려받아 API digest 와 일치함을 확인했다.
//  ⚠ 판은 **결함·보안 문제가 있을 때만** 올린다. 올리면 새 세대(아래)가 생기고 떠 있는 세션은 옛 판에 그대로 남는다 —
//   비용은 판마다 서버 하나가 그 세션들이 끝날 때까지 더 도는 것이다.
//  ⚠ 맥 사전빌드는 최소 macOS 15.0 으로 구워졌다(LC_BUILD_VERSION minos 15.0 = Darwin 24). 그 아래 맥은 내려받지 않고
//   있는 tmux(brew 등)로 간다 — 그래도 전용 소켓 분리는 똑같이 받는다.
import path from "node:path";

export interface MuxPinAsset {
  /** 릴리스 애셋 파일 이름 — 업스트림 이름 규칙 그대로(tar.gz 안에 `tmux` 실행파일 하나). */
  file: string;
  /** tar.gz 의 sha256(소문자 16진수 64자). */
  sha256: string;
}

/** 고정판 한 벌 — 판·애셋 표·맥 최소 커널. 시험은 같은 모양의 다른 판을 넘겨 설치 경로를 네트워크 없이 잰다. */
export interface MuxPin {
  version: string;
  assets: Readonly<Record<string, MuxPinAsset>>;
  darwinMinMajor: number;
}

export const TMUX_PIN: MuxPin = {
  version: "3.7c",
  assets: {
    "darwin-arm64": { file: "tmux-3.7c-macos-arm64.tar.gz", sha256: "0a763dd0380aa980d239509654da1bc7455843706a3c050f6709c8cd2e13d12d" },
    "darwin-x64": { file: "tmux-3.7c-macos-x86_64.tar.gz", sha256: "1c21f9ade964e4a539be05ffe3a4e95854ab76a0a9c4c05d0ffbe7fc6c4d783f" },
    "linux-arm64": { file: "tmux-3.7c-linux-arm64.tar.gz", sha256: "29dcb978da2a4b0cf6790f9e004865dac239a3ba03bbf776dddacce23d03831b" },
    "linux-x64": { file: "tmux-3.7c-linux-x86_64.tar.gz", sha256: "cc56bd1cc873eb6089c615f0496b072385bda8a6d944069f38564a5d49c128aa" },
  },
  /** 맥 사전빌드가 도는 최소 커널 판(Darwin 24 = macOS 15). */
  darwinMinMajor: 24,
};

/** 업스트림 릴리스 직링크. */
export function tmuxPinUrl(version: string, file: string): string {
  return `https://github.com/tmux/tmux-builds/releases/download/v${version}/${file}`;
}

/**
 * (순수) 이 기기에서 고정판을 받을 애셋 — 못 받는 기기면 왜인지.
 * @param osRelease `os.release()`(맥은 Darwin 커널 판 — "25.2.0")
 */
export function tmuxPinAssetFor(platform: string, arch: string, osRelease: string, pin: MuxPin = TMUX_PIN):
  { asset: MuxPinAsset } | { skip: string } {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  if (!os) return { skip: `사전빌드가 없는 OS(${platform})` };
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!cpu) return { skip: `사전빌드가 없는 CPU(${arch})` };
  if (os === "darwin") {
    const major = Number.parseInt(String(osRelease).split(".")[0] || "", 10);
    //  모르는 판(빈 값·형식 밖)은 받지 않는다 — 못 도는 바이너리를 받아 «있는 척» 검사로 버리는 것보다 안 받는 게 싸다.
    if (!Number.isFinite(major) || major < pin.darwinMinMajor) return { skip: `macOS 15 미만(Darwin ${osRelease || "?"}) — 사전빌드가 macOS 15 이상용` };
  }
  const asset = pin.assets[`${os}-${cpu}`];
  return asset ? { asset } : { skip: `사전빌드 표에 없는 조합(${os}-${cpu})` };
}

/** 고정판의 판별 폴더 — `~/.lively/bin/tmux-<판>/`. ⚠ `~/.lively/bin/tmux` 는 키트 폴백이 놓는 **파일** 자리라 이름을 달리한다. */
export function tmuxPinDir(home: string, version: string = TMUX_PIN.version): string {
  return path.join(home, ".lively", "bin", `tmux-${version}`);
}
export function tmuxPinBin(home: string, version: string = TMUX_PIN.version): string {
  return path.join(tmuxPinDir(home, version), "tmux");
}

/**
 * (순수) `tmux -V` 출력에서 판 토큰 — "tmux 3.7c" → "3.7c" · "tmux next-3.8" → "next-3.8". 형식 밖이면 null.
 *  ⚠ psmux 는 `psmux 3.4.0` 으로 답하지만 이 모듈은 POSIX tmux 만 다룬다(윈도우는 #4931 다음 단계).
 */
export function parseTmuxVersion(out: string): string | null {
  const m = /^tmux\s+(\S+)/m.exec(String(out ?? "").trim());
  if (!m) return null;
  const tok = m[1]!.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 32);
  return tok || null;
}

/**
 * (순수) 이 판이 `-N`(서버를 새로 띄우지 않는다)을 아나 — tmux 3.2 에서 들어왔다(CHANGES 3.1c→3.2).
 *  모르는 판(master 등)은 «모른다» = false — 모르는 플래그를 붙이면 attach 가 통째로 실패한다.
 */
export function tmuxKnowsNoStartFlag(version: string | null): boolean {
  const m = /(\d+)\.(\d+)/.exec(String(version ?? ""));
  if (!m) return false;
  const major = Number(m[1]), minor = Number(m[2]);
  return major > 3 || (major === 3 && minor >= 2);
}

/**
 * 전용 소켓 이름(`tmux -L`)의 머리 — 이 이름으로 시작하는 소켓만 우리 것으로 본다.
 *  ⚠ `lively-` 만으로는 모자라다 — 사람이 `tmux -L lively-dev` 처럼 지은 서버가 우리 세대로 읽히면 목록에 섞이고, 비었을 때 빈 서버
 *   정리가 그 서버를 끈다. 사람이 우연히 고르기 어려운 머리를 쓴다(리뷰 지적, 2026-10-22).
 */
export const MUX_SOCKET_PREFIX = "lively-mux-";

/** (순수) 판 → 세대 소켓 이름. `lively-mux-3.7c`. 판 토큰은 parseTmuxVersion 이 이미 다듬었다. */
export function muxSocketFor(version: string): string {
  return `${MUX_SOCKET_PREFIX}${version}`;
}

/** (순수) 소켓 이름이 우리 세대인가, 그렇다면 그 판. */
export function muxSocketVersion(name: string): string | null {
  if (!name.startsWith(MUX_SOCKET_PREFIX)) return null;
  const v = name.slice(MUX_SOCKET_PREFIX.length);
  return /^[A-Za-z0-9._-]{1,32}$/.test(v) ? v : null;
}

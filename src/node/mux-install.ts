// 노드 부팅의 tmux 세대 준비 (#4931) — 고정판 확보(내려받기 · 박아 둔 해시 · 실행 검증) + 세대 구성.
//
// ── 왜 에이전트가 하나 ─────────────────────────────────────────────────────────────
//  기존 노드는 키트(`lively node`)를 다시 돌리지 않는다. 런처가 받아 둔 agent.mjs 를 직접 띄우고, 갱신은 에이전트의
//  자가 갱신(#1713)으로만 온다. 그러니 고정판을 키트에서만 깔면 기존 노드는 영영 옛 판에 머문다 — 깔고 고르는 것을
//  에이전트가 해야 «배포 = 노드 이행» 이 된다.
//
// ── 설치 규율(키트 사전빌드 폴백 #1805 의 셋을 그대로 + 하나) ──────────────────────────────
//  ① 무결성 — 해시는 terminal/mux-pin 에 **박은 값**과 대조한다(API 가 주는 digest 가 아니다). 불일치는 중단.
//  ② 있는 척 금지 — «파일이 생겼다» 가 아니라 «돈다» 로 판정한다(`-V` 가 그 판을 말해야 한다). 안 돌면 지우고 실패로 답한다.
//  ③ 이웃 보호 — `~/.lively/bin` 에 직접 풀지 않는다(거기 `lively` 런처가 산다). 판별 폴더 옆 임시 자리에 풀고 실행파일만 옮긴다.
//  ④ 원자성 — 판별 폴더엔 임시 이름으로 놓고 검증한 뒤 rename 한다. 반쯤 쓰인 파일이 다음 부팅에 «있는 고정판» 으로 읽히지 않게.
//
// ⚠ 내려받기는 **연결을 막지 않는다** — 부팅은 이미 깔린 것만 보고 세대를 정해 곧바로 게이트웨이에 붙고, 없으면 뒤에서 받아
//  현재 세대를 바꾼다(node/agent). GitHub 가 막힌 망에서 재시작마다 노드가 상한만큼 꺼져 있지 않게.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { TMUX_PIN, tmuxPinAssetFor, tmuxPinBin, tmuxPinDir, tmuxPinUrl, parseTmuxVersion, tmuxKnowsNoStartFlag, muxSocketFor, type MuxPin } from "../terminal/mux-pin.js";
import { muxSocketsIn, type MuxGeneration, type MuxSetup } from "../terminal/mux-generations.js";
import { nodeMuxGenerationsApply, type ExecTopology } from "../exec-topology.js";

/** 시험 seam — 기본값은 이 프로세스의 플랫폼·fetch 다. */
export interface MuxInstallDeps {
  home: string;
  platform: string;
  arch: string;
  /** `os.release()` — 맥은 Darwin 커널 판. */
  osRelease: string;
  fetch: (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  /** 내려받기 상한(ms). */
  downloadTimeoutMs: number;
  /** 고정판 표 — 기본은 TMUX_PIN. 시험만 다른 판을 넘긴다. */
  pin?: MuxPin;
  /** 내려받을 주소 — 기본은 업스트림 직링크(tmuxPinUrl). 시험만 바꾼다. */
  urlFor?: (version: string, file: string) => string;
}

/** 이 실행파일의 판 — `-V` 를 돌려 판 토큰(mux-pin.parseTmuxVersion). 못 돌거나 tmux 가 아니면 null. */
export function binVersion(bin: string): string | null {
  if (!bin) return null;
  try {
    const r = spawnSync(bin, ["-V"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0 ? parseTmuxVersion(String(r.stdout ?? "")) : null;
  } catch { return null; }
}

/** 이미 깔린 고정판 — 판별 폴더의 tmux 가 돌고 그 판을 말하면 그 경로, 아니면 null(내려받기 없음). */
export function installedPinnedTmux(home: string, pin: MuxPin = TMUX_PIN): string | null {
  const bin = tmuxPinBin(home, pin.version);
  return binVersion(bin) === pin.version ? bin : null;
}

export type EnsurePinnedResult =
  | { ok: true; bin: string; fresh: boolean }
  /** permanent = 이 기기에선 고정판이 안 선다(맥 15 미만·지원 밖 CPU) — 다시 시도할 이유가 없다. */
  | { ok: false; why: string; permanent: boolean };

/** 고정판 tmux 를 `~/.lively/bin/tmux-<판>/tmux` 에 확보한다(이미 있으면 그대로). */
export async function ensurePinnedTmux(d: MuxInstallDeps): Promise<EnsurePinnedResult> {
  const pin = d.pin ?? TMUX_PIN;
  const spec = tmuxPinAssetFor(d.platform, d.arch, d.osRelease, pin);
  if ("skip" in spec) return { ok: false, why: spec.skip, permanent: true };
  const have = installedPinnedTmux(d.home, pin);
  if (have) return { ok: true, bin: have, fresh: false };
  const bin = tmuxPinBin(d.home, pin.version);

  let buf: Buffer;
  try {
    const res = await d.fetch((d.urlFor ?? tmuxPinUrl)(pin.version, spec.asset.file),
      { headers: { "user-agent": "lively-node-agent" }, signal: AbortSignal.timeout(d.downloadTimeoutMs) });
    if (!res.ok) return { ok: false, why: `고정판 내려받기 실패 — HTTP ${res.status}`, permanent: false };
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, why: `고정판 내려받기 실패 — ${(e as Error)?.message ?? String(e)}`, permanent: false };
  }
  const got = crypto.createHash("sha256").update(buf).digest("hex");
  if (got !== spec.asset.sha256) return { ok: false, why: `고정판 해시 불일치(받은 것 ${got.slice(0, 12)}… · 고정 ${spec.asset.sha256.slice(0, 12)}…) — 설치하지 않는다`, permanent: false };

  const dir = tmuxPinDir(d.home, pin.version);
  const stage = `${dir}.unpack-${process.pid}`;
  try {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    const tgz = path.join(stage, spec.asset.file);
    fs.writeFileSync(tgz, buf);
    const tar = spawnSync("tar", ["-xzf", tgz, "-C", stage], { stdio: "ignore", timeout: 30_000 });
    if (tar.status !== 0) return { ok: false, why: "고정판 압축 해제 실패", permanent: false };
    const found = path.join(stage, "tmux");   // 업스트림 묶음은 맨 위에 `tmux` 하나다(2026-10-20 네 애셋 확인)
    if (!fs.existsSync(found) || !fs.lstatSync(found).isFile()) return { ok: false, why: "고정판 묶음에 tmux 실행파일이 없다", permanent: false };
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `tmux.${process.pid}.tmp`);
    fs.copyFileSync(found, tmp);
    fs.chmodSync(tmp, 0o755);
    //  격리 속성(Gatekeeper) — fetch 로 받은 파일엔 보통 안 붙지만 붙어 있으면 실행이 막힌다. 없으면 그냥 실패한다(best-effort).
    if (d.platform === "darwin") spawnSync("xattr", ["-d", "com.apple.quarantine", tmp], { stdio: "ignore" });
    const v = binVersion(tmp);
    if (v !== pin.version) {
      fs.rmSync(tmp, { force: true });
      //  해시까지 맞은 바이트가 이 기기에서 안 돈다 — 다시 받아도 같다(아키텍처·OS 판·서명). 30분마다 받고 풀고 지우는 일을 되풀이하지
      //   않게 «다시 시도할 이유 없음» 으로 답한다(다음 에이전트 시작 때 한 번 더 본다).
      return { ok: false, why: `내려받은 고정판이 이 기기에서 돌지 않는다(-V: ${v ?? "실패"})`, permanent: true };
    }
    fs.renameSync(tmp, bin);
    return { ok: true, bin, fresh: true };
  } catch (e) {
    return { ok: false, why: `고정판 설치 실패 — ${(e as Error)?.message ?? String(e)}`, permanent: false };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/** 고정판 세대 — `-L lively-mux-<고정판>`. */
export function pinnedGeneration(bin: string): MuxGeneration {
  const socket = muxSocketFor(TMUX_PIN.version);
  return { key: socket, socket, bin, noStart: tmuxKnowsNoStartFlag(TMUX_PIN.version) };
}

/**
 * tmux 소켓 디렉터리 — **tmux 와 같은 규칙**: `$TMUX_TMPDIR` 가 비어 있지 않고 실제로 있으면(realpath 성공) 그것, 아니면 /tmp
 *  (tmux 는 realpath 가 실패한 후보를 건너뛴다 — tmux.c expand_paths). 그 아래 `tmux-<uid>`.
 *  ⚠ 여기가 어긋나면 지난 전용 세대를 못 찾고, 그 세대 세션은 목록에서 빠져 «끝났다» 로 읽힌다 — 규칙을 바꾸지 마라.
 */
export function muxSocketDir(env: NodeJS.ProcessEnv, uid: number): string {
  const real = (p: string): string | null => { try { return fs.realpathSync(p); } catch { return null; } };
  const base = (env.TMUX_TMPDIR ? real(env.TMUX_TMPDIR) : null) ?? real("/tmp") ?? "/tmp";
  return path.join(base, `tmux-${uid}`);
}

export interface PlanNodeMuxInput {
  topology: ExecTopology;
  platform: string;
  /** env 파일의 TMUX_BIN(종전 노드가 쓰던 바이너리) — 레거시 세대에 말할 것. */
  legacyBin: string;
  /** 이미 확보된 고정판(installedPinnedTmux·ensurePinnedTmux) — 없으면 null. */
  pinnedBin: string | null;
  /** 이 기기에선 고정판이 안 선다는 확답(맥 15 미만 등) — auto 여도 TMUX_BIN 전용 소켓으로 간다. */
  pinnedImpossible: boolean;
  home: string;
  socketDir: string;
}

export interface PlanNodeMuxResult {
  /** null = 세대 라우터를 켜지 않는다(종전 경로 그대로). */
  setup: MuxSetup | null;
  /** 사람이 읽는 한 줄 — 무엇을 골랐고 왜인지. */
  note: string;
  /** auto 인데 고정판이 아직 없다 — 뒤에서 받아 이 계획을 다시 세운다. */
  wantPinned: boolean;
}

/**
 * 이 노드의 세대 구성(순수 — 바이너리 `-V` 와 소켓 디렉터리만 본다). 표는 이렇다:
 *  | LIVELY_MUX_PIN | 고정판        | 현재 세대                                       |
 *  | auto(기본)     | 있음          | `lively-mux-3.7c` + 고정판                            |
 *  | auto(기본)     | 아직 없음     | 레거시(종전 그대로) — 뒤에서 받아 다시 세운다         |
 *  | auto(기본)     | 못 서는 기기  | TMUX_BIN 을 그 판 이름 전용 소켓(`lively-mux-<판>`)에서 |
 *  | bin            | (안 본다)     | TMUX_BIN 을 그 판 이름 전용 소켓에서                |
 *  | off(끄는 스위치) | (안 본다)   | 레거시(기본 소켓·TMUX_BIN)                        |
 * ★ 현재 세대가 레거시이고 전용 세대 소켓도 하나 없으면 **라우터를 아예 켜지 않는다**(setup null) — 그 노드에선 종전 코드가
 *  한 바이트도 안 바뀐다. 전용 세대가 하나라도 있으면(off 로 되돌린 노드) 켠다 — 거기 사는 세션을 계속 보고 다뤄야 한다.
 * ⚠ «아직 없음» 을 TMUX_BIN 전용 소켓으로 보내지 않는 이유: 그 판(맥미니면 크래시 난 3.6a)으로 **서버를 하나 더** 세우게 되고,
 *  그 서버는 세션이 다 끝날 때까지 남는다. 고정판은 곧 받아지므로 종전 자리에서 기다리는 편이 서버를 덜 만든다.
 */
export function planNodeMux(p: PlanNodeMuxInput): PlanNodeMuxResult {
  const t = p.topology;
  if (!nodeMuxGenerationsApply(t, p.platform)) return { setup: null, note: "노드 tmux 세대를 쓰지 않는 자리(게이트웨이·세션 호스트·윈도우)", wantPinned: false };

  const legacyVer = binVersion(p.legacyBin);
  //  레거시 세대에 말할 바이너리 — env 의 TMUX_BIN 이 안 돌면(경로가 사라졌다) 고정판으로 말한다(프로토콜이 같다).
  const legacyBin = legacyVer ? p.legacyBin : p.pinnedBin;
  const wantPinned = t.muxPin === "auto" && !p.pinnedBin && !p.pinnedImpossible;
  if (!legacyBin) return { setup: null, note: `쓸 수 있는 tmux 가 없다(TMUX_BIN=${p.legacyBin} 실행 실패)`, wantPinned };
  const legacy: MuxGeneration = { key: "default", socket: null, bin: legacyBin, noStart: tmuxKnowsNoStartFlag(legacyVer ?? TMUX_PIN.version) };

  let current: MuxGeneration = legacy;
  let note: string;
  if (t.muxPin === "auto" && p.pinnedBin) {
    current = pinnedGeneration(p.pinnedBin);
    note = `현재 세대 ${current.key}(고정판 ${p.pinnedBin})`;
  } else if ((t.muxPin === "bin" || (t.muxPin === "auto" && p.pinnedImpossible)) && legacyVer) {
    const socket = muxSocketFor(legacyVer);
    current = { key: socket, socket, bin: p.legacyBin, noStart: tmuxKnowsNoStartFlag(legacyVer) };
    note = `현재 세대 ${socket}(TMUX_BIN ${p.legacyBin} — ${t.muxPin === "bin" ? "LIVELY_MUX_PIN=bin" : "이 기기엔 고정판이 안 선다"})`;
  } else if (t.muxPin === "off") {
    note = "LIVELY_MUX_PIN=off — 새 세션은 종전처럼 기본 소켓";
  } else {
    note = wantPinned ? "고정판을 받는 동안 새 세션은 기본 소켓에 둔다" : "TMUX_BIN 판을 몰라 전용 소켓 이름을 못 짓는다 — 새 세션은 기본 소켓";
  }
  const dedicated = muxSocketsIn(p.socketDir);
  if (!current.socket && dedicated.length === 0) return { setup: null, note: `${note} · 전용 세대 없음 — 종전 경로`, wantPinned };
  const home = p.home;
  return {
    setup: {
      current,
      legacy,
      socketDir: p.socketDir,
      //  지난 전용 세대에 말할 바이너리 — 그 판의 판별 폴더에 있으면 그것, 레거시와 같은 판이면 TMUX_BIN, 아니면 현재 바이너리(null).
      binFor: (v) => {
        const own = tmuxPinBin(home, v);
        try { fs.accessSync(own, fs.constants.X_OK); return own; } catch { /* 그 판을 깐 적이 없거나 지웠다 */ }
        return v === legacyVer ? p.legacyBin : null;
      },
    },
    note,
    wantPinned,
  };
}

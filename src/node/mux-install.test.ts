// 노드 부팅의 tmux 세대 구성·고정판 설치 (#4931) — 사양 E·G 절.
//  설치는 네트워크 없이 잰다: 가짜 tmux(셸 스크립트)를 tar.gz 로 묶어 그 해시를 «고정판 표» 로 넘기고, fetch 는 그 바이트를 돌려준다.
//  실제로 판별 폴더에 무엇이 생겼나(파일·권한)·fetch 가 몇 번 불렸나·이웃 파일이 그대로인가를 본다.
import { strict as assert } from "node:assert";
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { ensurePinnedTmux, installedPinnedTmux, planNodeMux, muxSocketDir, binVersion, type MuxInstallDeps } from "./mux-install.js";
import { computeExecTopology } from "../exec-topology.js";
import { muxSocketFor, type MuxPin } from "../terminal/mux-pin.js";

const skip = process.platform === "win32" ? "윈도우 — 셸 스크립트 실행파일" : false;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mux-install-"));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** `-V` 에 그 판으로 답하는 가짜 tmux. variant 가 다르면 같은 판이라도 바이트가 다르다(해시 불일치 시험용). */
function fakeTmux(dir: string, version: string, name = "tmux", variant = ""): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n# ${variant}\n[ "$1" = "-V" ] && { echo "tmux ${version}"; exit 0; }\nexit 0\n`, { mode: 0o755 });
  return p;
}
const sha = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex");
const cpuKey = `${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;

/** 가짜 tmux 를 맨 위에 둔 tar.gz 와 그 해시로 만든 «고정판 표». */
function testPin(version: string, opts: { brokenBinary?: boolean; variant?: string } = {}): { pin: MuxPin; tgz: Buffer } {
  const src = fs.mkdtempSync(path.join(ROOT, "src-"));
  if (opts.brokenBinary) fs.writeFileSync(path.join(src, "tmux"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  else fakeTmux(src, version, "tmux", opts.variant ?? "");
  const tgzPath = path.join(ROOT, `pkg-${version}-${Math.random().toString(16).slice(2)}.tar.gz`);
  const r = spawnSync("tar", ["-czf", tgzPath, "-C", src, "tmux"]);
  assert.equal(r.status, 0, "시험 묶음 만들기");
  const tgz = fs.readFileSync(tgzPath);
  return { pin: { version, darwinMinMajor: 0, assets: { [cpuKey]: { file: `tmux-${version}-test.tar.gz`, sha256: sha(tgz) } } }, tgz };
}
function deps(home: string, pin: MuxPin, body: Buffer | Error | number, log: string[]): MuxInstallDeps {
  return {
    home, platform: process.platform, arch: process.arch, osRelease: os.release(), downloadTimeoutMs: 5_000, pin,
    urlFor: (v, f) => `https://example.invalid/${v}/${f}`,
    fetch: async (url) => {
      log.push(url);
      if (body instanceof Error) throw body;
      if (typeof body === "number") return { ok: false, status: body, arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer };
    },
  };
}
function homeWithNeighbor(): { home: string; neighbor: string; hash: string } {
  const home = fs.mkdtempSync(path.join(ROOT, "home-"));
  const bin = path.join(home, ".lively", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const neighbor = path.join(bin, "lively");
  fs.writeFileSync(neighbor, "#!/bin/sh\necho launcher\n", { mode: 0o755 });
  return { home, neighbor, hash: sha(fs.readFileSync(neighbor)) };
}
const leftovers = (home: string): string[] => fs.readdirSync(path.join(home, ".lively", "bin")).filter((n) => n.includes("unpack") || n.endsWith(".tmp"));

test("G1 처음 — 내려받아 해시를 맞추고 판별 폴더에 깐다 · 이웃(lively 런처)은 그대로 · 임시 자리는 안 남는다", { skip }, async () => {
  const { pin, tgz } = testPin("9.9z");
  const { home, neighbor, hash } = homeWithNeighbor();
  const log: string[] = [];
  const r = await ensurePinnedTmux(deps(home, pin, tgz, log));
  assert.deepEqual(r, { ok: true, bin: path.join(home, ".lively", "bin", "tmux-9.9z", "tmux"), fresh: true });
  assert.equal(log.length, 1, "내려받기 한 번");
  assert.equal(binVersion((r as { bin: string }).bin), "9.9z", "깐 것이 돈다");
  assert.equal(fs.statSync((r as { bin: string }).bin).mode & 0o111, 0o111, "실행 권한");
  assert.equal(sha(fs.readFileSync(neighbor)), hash, "이웃 파일은 한 바이트도 안 바뀐다");
  assert.deepEqual(leftovers(home), []);
  assert.deepEqual(fs.readdirSync(path.join(home, ".lively", "bin", "tmux-9.9z")), ["tmux"], "판별 폴더엔 실행파일 하나");
});

test("G2 이미 깔렸고 돈다 — 내려받지 않는다", { skip }, async () => {
  const { pin, tgz } = testPin("9.9y");
  const { home } = homeWithNeighbor();
  fakeTmux(path.join(home, ".lively", "bin", "tmux-9.9y"), "9.9y");
  const log: string[] = [];
  assert.deepEqual(await ensurePinnedTmux(deps(home, pin, tgz, log)), { ok: true, bin: path.join(home, ".lively", "bin", "tmux-9.9y", "tmux"), fresh: false });
  assert.equal(log.length, 0);
  assert.equal(installedPinnedTmux(home, pin), path.join(home, ".lively", "bin", "tmux-9.9y", "tmux"));
});

test("G3 해시가 다르면 설치하지 않는다 — 판별 폴더에 아무것도 안 생긴다", { skip }, async () => {
  const { pin } = testPin("9.9x");
  //  ★ 받은 것은 **멀쩡히 설치될 묶음**이다(같은 판을 말하는 다른 바이트) — 해시 대조가 없으면 그대로 깔린다. 깨진 바이트를 주면
  //   압축 해제가 대신 막아 해시 대조가 없어도 이 시험이 통과한다(변형 시험에서 실제로 그랬다).
  const other = testPin("9.9x", { variant: "다른 바이트" }).tgz;
  const { home } = homeWithNeighbor();
  const r = await ensurePinnedTmux(deps(home, pin, other, []));
  assert.equal(r.ok, false);
  assert.equal((r as { permanent: boolean }).permanent, false);
  assert.equal(fs.existsSync(path.join(home, ".lively", "bin", "tmux-9.9x")), false);
  assert.deepEqual(leftovers(home), []);
});

test("G4 풀어 놓은 tmux 가 그 판을 말하지 않으면(안 돎) 설치하지 않는다", { skip }, async () => {
  const { pin, tgz } = testPin("9.9w", { brokenBinary: true });
  const { home } = homeWithNeighbor();
  const r = await ensurePinnedTmux(deps(home, pin, tgz, []));
  assert.equal(r.ok, false);
  assert.equal((r as { permanent: boolean }).permanent, true, "해시가 맞은 바이트가 안 돈다 — 다시 받아도 같으니 30분마다 되풀이하지 않는다");
  assert.equal(fs.existsSync(path.join(home, ".lively", "bin", "tmux-9.9w", "tmux")), false, "있는 척 금지 — 안 도는 바이너리를 남기지 않는다");
  assert.deepEqual(fs.readdirSync(path.join(home, ".lively", "bin", "tmux-9.9w")), [], "임시 파일도 지웠다");
});

test("G5 내려받기 실패(네트워크·HTTP) — 실패, 다시 시도할 수 있음", { skip }, async () => {
  const { pin } = testPin("9.9v");
  const { home } = homeWithNeighbor();
  const net = await ensurePinnedTmux(deps(home, pin, new Error("getaddrinfo ENOTFOUND github.com"), []));
  assert.equal(net.ok, false); assert.equal((net as { permanent: boolean }).permanent, false);
  const http = await ensurePinnedTmux(deps(home, pin, 404, []));
  assert.equal(http.ok, false); assert.equal((http as { permanent: boolean }).permanent, false);
  assert.equal(fs.existsSync(path.join(home, ".lively", "bin", "tmux-9.9v")), false);
});

test("G6 받을 수 없는 기기 — 실패·다시 시도할 이유 없음·네트워크 0건", { skip }, async () => {
  const { pin, tgz } = testPin("9.9u");
  const { home } = homeWithNeighbor();
  const log: string[] = [];
  const r = await ensurePinnedTmux({ ...deps(home, pin, tgz, log), platform: "win32" });
  assert.equal(r.ok, false); assert.equal((r as { permanent: boolean }).permanent, true);
  const old = await ensurePinnedTmux({ ...deps(home, { ...pin, darwinMinMajor: 24 }, tgz, log), platform: "darwin", osRelease: "23.6.0" });
  assert.equal(old.ok, false); assert.equal((old as { permanent: boolean }).permanent, true, "macOS 14");
  assert.equal(log.length, 0);
});

test("G7 깔렸지만 판이 다르면(손상·다른 판) 다시 받아 바꾼다", { skip }, async () => {
  const { pin, tgz } = testPin("9.9t");
  const { home } = homeWithNeighbor();
  fakeTmux(path.join(home, ".lively", "bin", "tmux-9.9t"), "1.0");
  const log: string[] = [];
  const r = await ensurePinnedTmux(deps(home, pin, tgz, log));
  assert.equal(r.ok && r.fresh, true);
  assert.equal(log.length, 1);
  assert.equal(binVersion(path.join(home, ".lively", "bin", "tmux-9.9t", "tmux")), "9.9t");
});

// ── E. 부팅 계획 ────────────────────────────────────────────────────────────────
const BINS = path.join(ROOT, "bins");
const BREW = fakeTmux(path.join(BINS, "brew"), "3.6a");
const PINNED = fakeTmux(path.join(BINS, "pinned"), "3.7c");
const NO_SOCKETS = path.join(ROOT, "no-sockets");
const nodeTopo = (pin?: string) => computeExecTopology({ LIVELY_NODE_TOKEN: "lvk_x", ...(pin === undefined ? {} : { LIVELY_MUX_PIN: pin }) });
//  ⚠ 세대 이름은 리터럴로 쓰지 않고 짓는 함수로 — `key: "<이름>"` 꼴은 비밀 스캔(gitleaks generic-api-key)이 키로 오인한다.
const SOCK_PIN = muxSocketFor("3.7c");
const SOCK_BREW = muxSocketFor("3.6a");
const plan = (o: Partial<Parameters<typeof planNodeMux>[0]>) => planNodeMux({
  topology: nodeTopo("auto"), platform: "darwin", legacyBin: BREW, pinnedBin: PINNED, pinnedImpossible: false,
  home: path.join(ROOT, "plan-home"), socketDir: NO_SOCKETS, ...o,
});

test("E1·E2·E3 노드가 아니거나 · 윈도우거나 · tmux 가 중계 배치면 세대를 안 쓴다", { skip }, () => {
  assert.equal(plan({ topology: computeExecTopology({ LIVELY_MUX_PIN: "auto" }) }).setup, null, "게이트웨이");
  assert.equal(plan({ platform: "win32" }).setup, null, "윈도우(psmux)");
  assert.equal(plan({ topology: computeExecTopology({ LIVELY_NODE_TOKEN: "x", LIVELY_TMUX_EXEC: "relay {slug}", LIVELY_MUX_PIN: "auto" }) }).setup, null, "세션 호스트");
});

test("E4 auto + 고정판 있음 → 현재 세대 lively-mux-3.7c(고정판) · 레거시 기본 소켓(TMUX_BIN)", { skip }, () => {
  const p = plan({});
  assert.deepEqual(p.setup?.current, { key: SOCK_PIN, socket: SOCK_PIN, bin: PINNED, noStart: true });
  assert.deepEqual(p.setup?.legacy, { key: "default", socket: null, bin: BREW, noStart: true });
  assert.equal(p.wantPinned, false);
});

test("E5·E6 auto + 고정판 아직 없음 → 받기를 원한다 · 전용 소켓이 없으면 세대를 안 쓴다(종전 코드) · 있으면 레거시를 현재로 켠다", { skip }, async () => {
  const none = plan({ pinnedBin: null });
  assert.equal(none.setup, null);
  assert.equal(none.wantPinned, true);
  const dir = fs.mkdtempSync(path.join(ROOT, "socks-"));
  const net = await import("node:net");
  const srv = net.createServer();
  await new Promise<void>((res) => srv.listen(path.join(dir, "lively-mux-3.7b"), () => res()));
  try {
    const some = plan({ pinnedBin: null, socketDir: dir });
    assert.equal(some.setup?.current.key, "default", "고정판을 받는 동안 새 세션은 종전 자리");
    assert.equal(some.wantPinned, true);
  } finally { srv.close(); }
});

test("E7 auto + 이 기기엔 고정판이 안 섬(맥 15 미만) → TMUX_BIN 을 그 판 이름 전용 소켓에서 · 받기를 원하지 않는다", { skip }, () => {
  const p = plan({ pinnedBin: null, pinnedImpossible: true });
  assert.deepEqual(p.setup?.current, { key: SOCK_BREW, socket: SOCK_BREW, bin: BREW, noStart: true });
  assert.equal(p.wantPinned, false);
});

test("E8 bin → TMUX_BIN 을 그 판 이름 전용 소켓에서(고정판은 안 본다)", { skip }, () => {
  const p = plan({ topology: nodeTopo("bin") });
  assert.equal(p.setup?.current.key, SOCK_BREW);
  assert.equal(p.setup?.current.bin, BREW);
  assert.equal(p.wantPinned, false);
});

test("E9 값 없음 = auto(2단계 기본값) → 고정판 세대 · off → 전용 소켓이 없으면 세대를 안 쓴다(그 노드에선 종전 코드가 그대로)", { skip }, () => {
  assert.equal(plan({ topology: nodeTopo() }).setup?.current.key, SOCK_PIN, "값 없음 = auto — 새 세션은 고정판 전용 소켓");
  const waiting = plan({ topology: nodeTopo(), pinnedBin: null });
  assert.equal(waiting.setup, null, "값 없음 + 고정판 아직 없음 — 받는 동안은 종전 자리");
  assert.equal(waiting.wantPinned, true, "값 없음 + 고정판 아직 없음 — 뒤에서 받는다");
  assert.equal(plan({ topology: nodeTopo("off") }).setup, null);
  assert.equal(plan({ topology: nodeTopo("off"), pinnedBin: null }).wantPinned, false, "off 는 받지도 않는다");
});

test("E10 TMUX_BIN 이 안 돌고 고정판이 있으면 레거시도 고정판으로 말한다", { skip }, () => {
  const p = plan({ legacyBin: path.join(ROOT, "nope", "tmux") });
  assert.equal(p.setup?.legacy.bin, PINNED);
  assert.equal(p.setup?.current.bin, PINNED);
});

test("E11 경계 — TMUX_BIN 도 안 돌고 고정판도 없으면 세대를 안 쓴다(새로 들인 값 pinnedBin = null)", { skip }, () => {
  const p = plan({ legacyBin: path.join(ROOT, "nope", "tmux"), pinnedBin: null });
  assert.equal(p.setup, null);
});

test("지난 세대 바이너리 — 그 판의 판별 폴더가 있으면 그것 · 레거시와 같은 판이면 TMUX_BIN · 아니면 null(현재로 말한다)", { skip }, () => {
  const home = fs.mkdtempSync(path.join(ROOT, "binfor-"));
  const old = fakeTmux(path.join(home, ".lively", "bin", "tmux-3.7b"), "3.7b");
  const p = plan({ home });
  assert.equal(p.setup?.binFor("3.7b"), old);
  assert.equal(p.setup?.binFor("3.6a"), BREW);
  assert.equal(p.setup?.binFor("3.5a"), null);
});

test("소켓 디렉터리 — tmux 와 같은 규칙: TMUX_TMPDIR 가 실제로 있으면 그것, 없거나 비면 /tmp(실경로)", { skip }, () => {
  const uid = 501;
  const real = fs.realpathSync(ROOT);
  assert.equal(muxSocketDir({ TMUX_TMPDIR: ROOT }, uid), path.join(real, `tmux-${uid}`));
  assert.equal(muxSocketDir({ TMUX_TMPDIR: path.join(ROOT, "does-not-exist") }, uid), path.join(fs.realpathSync("/tmp"), `tmux-${uid}`), "tmux 는 실경로를 못 구한 후보를 건너뛴다");
  assert.equal(muxSocketDir({ TMUX_TMPDIR: "" }, uid), path.join(fs.realpathSync("/tmp"), `tmux-${uid}`));
  assert.equal(muxSocketDir({}, uid), path.join(fs.realpathSync("/tmp"), `tmux-${uid}`));
});

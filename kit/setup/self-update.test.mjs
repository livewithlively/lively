#!/usr/bin/env node
// 키트 자가 업데이터(#858) e2e — **진짜 번들 + 픽스처 게이트웨이**로 다운로드→검증→설치→스탬프를 통째로 돈다.
//  실제 ~/.lively·~/.claude 는 건드리지 않는다(LIVELY_HOME/CLAUDE_CONFIG_DIR 샌드박스, 설치기와 동일 계약).
//  네트워크는 127.0.0.1 픽스처 서버뿐 — 외부 무접촉.
//  실행: node kit/setup/self-update.test.mjs   (npm test 체인에 포함)
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";  // ⚠ 절대경로 동적 import 는 반드시 file:// URL 로 — 윈도우는 "d:" 를 프로토콜로 읽는다(#1510)
import { sandboxEnv, WIN } from "../testlib/os-sandbox.mjs";   // HOME 만으론 윈도우 격리가 안 된다(#1510)

// ⚠ 업데이터는 **반드시 비동기(execFile)** 로 띄운다. 픽스처 게이트웨이가 이 프로세스에서 돌기 때문에
//  execFileSync 로 막으면 이벤트 루프가 멈춰 자식의 fetch 가 전부 타임아웃한다 — 그러면 모든 케이스가
//  '조용한 무동작'이 되어 "무동작을 기대하는" 테스트들이 공허하게 통과한다(실제로 한 번 당했다).
const pExecFile = promisify(execFile);

const HERE = join(fileURLToPath(import.meta.url), "..");           // kit/setup
const UPDATER = join(HERE, "..", "hooks", "self-update.mjs");
const { buildKitBundle } = await import(pathToFileURL(join(HERE, "..", "generator", "build-context.mjs")));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };

const BOX = mkdtempSync(join(tmpdir(), "selfupd-"));
const cleanup = () => { try { rmSync(BOX, { recursive: true, force: true }); } catch { /* */ } };

// ── 번들 만들기 — 게이트웨이(buildInstallBundle)가 하는 일을 그대로: kit 조립 + .lively 런타임자산 + 버전 스탬프.
//  appledouble=true: macOS 게이트웨이 번들 재현(#858 회귀) — bsdtar 가 xattr 을 `._<name>` 파일로 굽는 걸,
//   러너마다 `._name.mjs`(구문 불가한 바이너리 쓰레기)를 심어 리눅스에서도 결정적으로 재현한다.
function makeBundle(version, { corrupt = false, appledouble = false, noProxy = false } = {}) {
  const stage = mkdtempSync(join(BOX, "stage-"));
  buildKitBundle(stage, { orgName: "테스트조직", orgLabel: "test", harness: "claude" });
  const lv = join(stage, ".lively");
  mkdirSync(lv, { recursive: true });
  writeFileSync(join(lv, "hooks-config.json"), JSON.stringify({ hooks: {} }, null, 2));
  writeFileSync(join(lv, "mcp-servers.json"), JSON.stringify({ servers: [] }, null, 2));
  writeFileSync(join(lv, "auto-approve.json"), JSON.stringify({ allow: ["mcp__lively__knowledge_get"] }, null, 2));
  writeFileSync(join(lv, "work-roots"), "# hdr\n");
  writeFileSync(join(lv, "kit-version"), version + "\n");
  // 손상 번들 — 훅 하나에 구문 오류를 심는다(검증 게이트가 이걸 잡아야 한다).
  if (corrupt) writeFileSync(join(stage, ".claude", "hooks", "session-preload.mjs"), "export const x = (((;\n");
  // 구버전 번들 흉내(#1079) — stdio 프록시 본체가 없는 번들. 이걸로 설치하면 lib/ 에도 안 생기므로
  //  reconcile 이 stdio 마이그레이션을 **하면 안 된다**(하면 lively 가 통째로 안 뜬다).
  if (noProxy) rmSync(join(stage, "cli", "lively-mcp-gateway.mjs"), { force: true });
  // AppleDouble 쓰레기 — 각 러너 옆에 `._name.mjs`(구문 불가). 정상 러너는 그대로 두고 검증이 이 쓰레기에
  //  걸리면 안 된다(설치기가 명시 이름만 복사하므로 배포조차 안 됨).
  if (appledouble) {
    const hd = join(stage, ".claude", "hooks");
    for (const f of ["run-custom.mjs", "session-preload.mjs", "self-update.mjs"]) {
      writeFileSync(join(hd, "._" + f), Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00])); // AppleDouble 매직 흉내(비-JS)
    }
  }
  const tgz = join(BOX, `bundle-${version}.tgz`);
  execFileSync("tar", ["-czf", tgz, "-C", stage, "."], { stdio: "ignore" });
  return readFileSync(tgz);
}

// ── 픽스처 게이트웨이 — /install(번들) + runtime-config(kit_version) + org/preview(설치기 시드). ──
let serving = { version: "v-aaa", body: null, installHits: 0 };
const server = createServer((req, res) => {
  if (!/^Bearer /.test(req.headers.authorization || "")) { res.writeHead(401).end(); return; } // 토큰 없으면 거절(실서버와 동일)
  const path = (req.url || "").split("?")[0];
  if (path === "/install") {
    serving.installHits++;
    res.writeHead(200, { "content-type": "application/gzip" }).end(serving.body);
  } else if (path === "/api/ui/org/runtime-config") {
    res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ hooks: {}, auto_approve: [], kit_version: serving.version }));
  } else if (path === "/api/ui/org/preview") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ context: "# 테스트 컨텍스트\n" }));
  } else res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const GW = `http://127.0.0.1:${server.address().port}`;

// ── 샌드박스 홈 — '이미 lively 가 설치된 멤버'를 재현(claude 배선 있음, 키트는 구버전). ──
function freshHome(stamp) {
  const home = mkdtempSync(join(BOX, "home-"));
  mkdirSync(join(home, ".lively", "hooks"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".lively", "token"), "test-token");
  writeFileSync(join(home, ".lively", "gateway-url"), GW);
  if (stamp) writeFileSync(join(home, ".lively", "kit-version"), stamp + "\n");
  // 하네스 판정 근거 = 디스크의 배선(.lively/hooks/ 를 가리키는 command). PATH 탐지가 아니다.
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: `"node" "$HOME/.lively/hooks/session-preload.mjs"` }] }] },
  }, null, 2) + "\n");
  return home;
}
// 샌드박스 격리 — 셋 다 필요하다(하나라도 빠지면 테스트가 **실기기의 ~/.lively·실게이트웨이**를 건드린다):
//  · HOME        — session-preload 는 homedir() 기준이다(LIVELY_HOME 을 안 본다). 훅 테스트의 확립된 계약.
//  · LIVELY_HOME — self-update·user-install 의 샌드박스 계약.
//  · LIVELY_TOKEN / LIVELY_GATEWAY_URL — env 가 파일보다 우선하므로, 셸에 있으면 실게이트웨이로 새어나간다.
const env = (home, extra = {}) => ({
  ...process.env, ...sandboxEnv({ home }), LIVELY_HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"),
  LIVELY_OFF: "", LIVELY_HOOKS_OFF: "", LIVELY_NO_AUTO_UPDATE: "",
  LIVELY_TOKEN: "", LIVELY_GATEWAY_URL: "", ...extra,
});
const runUpdater = (home, extra = {}, args = []) =>
  pExecFile(process.execPath, [UPDATER, ...args], { env: env(home, extra), timeout: 180_000 });
const lv = (home, f) => join(home, ".lively", f);
const readIf = (p) => { try { return readFileSync(p, "utf8").trim(); } catch { return null; } };

try {
  serving.body = makeBundle("v-aaa");

  // ① 해피패스 — 스탬프 없음(구 멤버) → 다운로드·검증·설치·스탬프·안내.
  {
    const home = freshHome(null);
    await runUpdater(home);
    const hooks = ["session-preload.mjs", "work-flag.mjs", "stop-writeback-gate.mjs", "run-custom.mjs", "sync-harness-assets.mjs", "self-update.mjs"];
    const installed = hooks.filter((f) => existsSync(join(home, ".lively", "hooks", f)));
    const stamped = readIf(lv(home, "kit-version"));
    const notice = readIf(lv(home, "update-notice"));
    const st = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    const wired = JSON.stringify(st.hooks || {}).includes("sync-harness-assets"); // 새 배선이 실제로 들어갔나
    const allow = (st.permissions || {}).allow || [];
    if (installed.length === 6 && stamped === "v-aaa" && notice && wired && allow.includes("mcp__lively__knowledge_get")) {
      ok("① 자동 업데이트 e2e — 러너 6종 설치 + 배선 갱신 + auto-approve + 버전 스탬프 + 안내");
    } else {
      bad("① 해피패스", `hooks=${installed.length}/6 stamp=${stamped} notice=${!!notice} wired=${wired} allow=${allow.length}`);
    }
    // 락은 반드시 풀려 있어야 한다(안 그러면 다음 세션이 영영 못 돈다).
    !existsSync(lv(home, "update.lock")) ? ok("①b 락 해제됨") : bad("①b 락", "update.lock 잔존");
  }

  // ② 최신 상태 — 스탬프 == 서버 버전이면 다운로드조차 안 한다(매 세션 도는 경로라 이게 핵심 비용).
  {
    const before = serving.installHits;
    const home = freshHome("v-aaa");
    await runUpdater(home);
    (serving.installHits === before && !existsSync(lv(home, "update-notice")))
      ? ok("② 최신이면 무동작(다운로드 0회)") : bad("② 최신 무동작", `installHits +${serving.installHits - before}`);
  }

  // ③ 어드민 토글 OFF — hooks-config.json hooks.self_update=false 면 안 돈다.
  {
    const before = serving.installHits;
    const home = freshHome(null);
    writeFileSync(lv(home, "hooks-config.json"), JSON.stringify({ hooks: { self_update: false } }));
    await runUpdater(home);
    (serving.installHits === before && !readIf(lv(home, "kit-version")))
      ? ok("③ 어드민 토글 OFF → 무동작") : bad("③ 토글 OFF", `installHits +${serving.installHits - before}`);
  }

  // ④ 개인 opt-out(LIVELY_NO_AUTO_UPDATE=1) · incognito(LIVELY_OFF=1).
  for (const [k, name] of [["LIVELY_NO_AUTO_UPDATE", "④ LIVELY_NO_AUTO_UPDATE=1"], ["LIVELY_OFF", "④b LIVELY_OFF=1"]]) {
    const before = serving.installHits;
    const home = freshHome(null);
    await runUpdater(home, { [k]: "1" });
    (serving.installHits === before) ? ok(`${name} → 무동작`) : bad(name, `installHits +${serving.installHits - before}`);
  }

  // ⑤ 락 — 다른 세션이 업데이트 중이면(신선한 락 존재) 두 번 돌지 않는다.
  {
    const before = serving.installHits;
    const home = freshHome(null);
    writeFileSync(lv(home, "update.lock"), "99999");
    await runUpdater(home);
    (serving.installHits === before) ? ok("⑤ 락 보유 중 → 중복 실행 안 함") : bad("⑤ 락", `installHits +${serving.installHits - before}`);
  }

  // ⑥ **손상 번들은 설치하지 않는다** — 구문 깨진 훅을 심으면 그 멤버의 모든 세션에서 훅이 죽는다.
  //    기존 러너는 그대로 남아야 하고(fail-open), 실패는 상태에 기록돼 백오프가 걸려야 한다.
  {
    const home = freshHome(null);
    const keep = "// 기존 러너(건드리면 안 됨)\n";
    writeFileSync(join(home, ".lively", "hooks", "session-preload.mjs"), keep);
    serving.body = makeBundle("v-bad", { corrupt: true });
    serving.version = "v-bad";
    await runUpdater(home);
    const survived = readIf(join(home, ".lively", "hooks", "session-preload.mjs")) === keep.trim();
    const stamped = readIf(lv(home, "kit-version"));
    const state = JSON.parse(readFileSync(lv(home, "update-state.json"), "utf8"));
    (survived && !stamped && state.failed_version === "v-bad")
      ? ok("⑥ 손상 번들 거부 — 기존 러너 보존 + 실패 기록(백오프)")
      : bad("⑥ 손상 번들", `survived=${survived} stamp=${stamped} state=${JSON.stringify(state)}`);

    // ⑥b 백오프 — 같은 버전으로 방금 실패했으면 다시 안 받는다.
    const before = serving.installHits;
    await runUpdater(home);
    (serving.installHits === before) ? ok("⑥b 실패 백오프 — 같은 버전 재시도 안 함") : bad("⑥b 백오프", `installHits +${serving.installHits - before}`);

    // ⑥c 새 버전이 나오면 백오프를 뚫고 다시 시도해 복구한다(고장난 릴리스에 영원히 갇히지 않는다).
    serving.body = makeBundle("v-ccc");
    serving.version = "v-ccc";
    await runUpdater(home);
    (readIf(lv(home, "kit-version")) === "v-ccc") ? ok("⑥c 새 버전으로 복구") : bad("⑥c 복구", `stamp=${readIf(lv(home, "kit-version"))}`);
  }

  // ⑦ 멱등 — 같은 번들로 두 번 돌려도 배선이 불어나지 않는다(설치기 dedup 이 자동 업데이트 경로에서도 유효).
  {
    const home = freshHome(null);
    await runUpdater(home);
    const count = (h) => { const s = JSON.parse(readFileSync(join(h, ".claude", "settings.json"), "utf8")); return Object.values(s.hooks || {}).reduce((n, a) => n + a.reduce((m, e) => m + (e.hooks || []).length, 0), 0); };
    const n1 = count(home);
    rmSync(lv(home, "kit-version"), { force: true }); // 강제 재실행(같은 버전 재설치)
    await runUpdater(home);
    const n2 = count(home);
    (n1 === n2 && n1 > 0) ? ok(`⑦ 재설치 멱등 — 배선 ${n1}개 불변`) : bad("⑦ 멱등", `n1=${n1} n2=${n2}`);
  }

  // ⑧ 하네스 미배선 홈(lively 미설치) — 아무것도 하지 않는다(엉뚱한 머신에 설치하지 않는다).
  {
    const before = serving.installHits;
    const home = mkdtempSync(join(BOX, "bare-"));
    mkdirSync(join(home, ".lively"), { recursive: true });
    writeFileSync(lv(home, "token"), "test-token");
    writeFileSync(lv(home, "gateway-url"), GW);
    await runUpdater(home);
    (serving.installHits === before) ? ok("⑧ 배선 없는 홈 → 무동작") : bad("⑧ 미배선", `installHits +${serving.installHits - before}`);
  }

  // ══ 프로덕션 경로 통합 — session-preload(훅) → detached 업데이터 → 설치 ══
  //  여기까지 붙어야 "멤버가 세션을 켜기만 하면 갱신된다"가 증명된다. 위 케이스들은 업데이터 단독 실행이었다.
  const PRELOAD = join(HERE, "..", "hooks", "session-preload.mjs");
  const runPreload = (home) => pExecFile(process.execPath, [PRELOAD], { env: env(home), timeout: 30_000 });
  const waitFor = async (fn, ms = 60_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 200)); }
    return false;
  };

  // ⑨ 버전 불일치 → 훅이 백그라운드 업데이터를 띄우고 **즉시 반환**한다(세션은 안 기다린다), 설치는 뒤따라 완료.
  {
    serving.body = makeBundle("v-ddd");
    serving.version = "v-ddd";
    const home = freshHome("v-old");
    // '새 키트를 이미 받은 멤버' — 업데이터 파일이 있어야 훅이 띄울 수 있다(없으면 수동 업데이트가 경로).
    execFileSync("cp", [UPDATER, join(home, ".lively", "hooks", "self-update.mjs")]);
    const t0 = Date.now();
    const { stdout } = await runPreload(home);
    const hookMs = Date.now() - t0;
    const injected = String(stdout || "").includes("테스트 컨텍스트"); // 훅 본연의 일(맥락 주입)은 그대로 했나
    const done = await waitFor(() => readIf(lv(home, "kit-version")) === "v-ddd");
    // ⚠ notice 도 **기다려야** 한다 — kit-version 스탬프(self-update.mjs:257)와 update-notice 기록(:262) 사이엔
    //  saveState + reconcileClaudeMcp(게이트웨이 **네트워크 호출**, #862)가 있다. kit-version 만 폴링하고 notice 를
    //  즉시 읽으면 그 틈에 걸려 notice=false 로 헛실패한다(부하가 걸릴수록 잘 재현 — 실측 플레이키의 원인).
    const notice = await waitFor(() => !!readIf(lv(home, "update-notice")));
    if (done && injected && notice) ok(`⑨ 세션 시작 → 백그라운드 자동 업데이트 완료 (훅 반환 ${hookMs}ms · 맥락 주입 정상 · 다음 세션 안내 대기)`);
    else bad("⑨ 훅 트리거", `done=${done} injected=${injected} notice=${!!notice} hookMs=${hookMs}`);

    // ⑨b 안내는 **다음 세션에 딱 한 번** — 두 번째 세션엔 안 뜬다.
    const s2 = String((await runPreload(home)).stdout || "");
    const s3 = String((await runPreload(home)).stdout || "");
    (s2.includes("자동으로 업데이트됐습니다") && !s3.includes("자동으로 업데이트됐습니다"))
      ? ok("⑨b 업데이트 안내 — 다음 세션에 1회만") : bad("⑨b 안내 1회", `s2=${s2.includes("업데이트됐습니다")} s3=${s3.includes("업데이트됐습니다")}`);
  }

  // ⑩ 최신이면 훅은 업데이터를 아예 안 띄운다(매 세션 도는 경로 — 여기서 프로세스를 낳으면 안 된다).
  {
    const before = serving.installHits;
    const home = freshHome("v-ddd");
    execFileSync("cp", [UPDATER, join(home, ".lively", "hooks", "self-update.mjs")]);
    await runPreload(home);
    await new Promise((r) => setTimeout(r, 1500)); // 혹시 떴다면 도달할 시간을 준다
    (serving.installHits === before && !existsSync(lv(home, "update.log")))
      ? ok("⑩ 최신이면 훅이 업데이터를 띄우지 않음") : bad("⑩ 최신 무동작", `installHits +${serving.installHits - before} log=${existsSync(lv(home, "update.log"))}`);
  }

  // ⑪ Codex 패리티(하네스 패리티 불변식) — codex 배선 멤버도 자동 업데이트가 돌고 config.toml 관리블록이 갱신된다.
  {
    serving.body = makeBundle("v-eee"); serving.version = "v-eee";
    const home = mkdtempSync(join(BOX, "cdx-"));
    mkdirSync(join(home, ".lively", "hooks"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(lv(home, "token"), "test-token");
    writeFileSync(lv(home, "gateway-url"), GW);
    // 이미 lively 가 배선된 codex 멤버 + 사용자 본인 설정(보존돼야 함).
    writeFileSync(join(home, ".codex", "config.toml"),
      'model = "gpt-5"\n\n# >>> lively-managed (auto-generated by workflow-std/adapters/codex — do not edit) >>>\n[mcp_servers.lively]\nurl = "http://old"\n# <<< lively-managed <<<\n');
    await runUpdater(home);
    const cfg = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    const stamped = readIf(lv(home, "kit-version"));
    const runners = existsSync(join(home, ".lively", "hooks", "self-update.mjs"));
    const userKept = cfg.includes('model = "gpt-5"');            // 사용자 키 보존(비파괴 불변식)
    const wired = cfg.includes("sync-harness-assets") && cfg.includes("[mcp_servers.lively]");
    (stamped === "v-eee" && runners && userKept && wired)
      ? ok("⑪ Codex 패리티 — 자동 업데이트 + config.toml 관리블록 갱신 + 사용자 키 보존")
      : bad("⑪ Codex", `stamp=${stamped} runners=${runners} userKept=${userKept} wired=${wired}`);
  }

  // ⑬ **토큰 비유출** — 업데이터는 토큰으로 인증하지만, 그 값이 로그·stdout·상태파일 어디에도 남으면 안 된다.
  //   (~/.lively/update.log 는 설치기 stdout 전문을 싣는다 — 여기가 가장 새기 쉬운 곳이다.)
  {
    serving.body = makeBundle("v-fff"); serving.version = "v-fff";
    const SECRET = "lvk_SUPERSECRET_TOKEN_DO_NOT_LEAK";
    const home = freshHome(null);
    writeFileSync(lv(home, "token"), SECRET);
    const { stdout, stderr } = await runUpdater(home);
    const files = ["update.log", "update-state.json", "update-notice", "kit-version"]
      .map((f) => readIf(lv(home, f)) || "").join("\n");
    const leaked = [String(stdout || ""), String(stderr || ""), files].filter((s) => s.includes(SECRET));
    // 설치가 실제로 일어난 상태에서의 비유출이어야 의미가 있다(무동작이면 공허하게 통과).
    const ran = readIf(lv(home, "kit-version")) === "v-fff";
    (ran && leaked.length === 0) ? ok("⑬ 토큰 비유출 — 로그·stdout·상태파일 어디에도 토큰 없음")
      : bad("⑬ 토큰 비유출", ran ? `유출 ${leaked.length}곳` : "설치가 안 돌아 검증 무의미");
    // 로그 퍼미션 0600(형제 상태파일과 동일 — world-readable 금지)
    const { statSync: stat } = await import("node:fs");
    // 윈도우엔 POSIX 퍼미션 비트가 없다(NTFS ACL) — node 가 보고하는 mode 는 0666/0444 뿐이라 이 계약이 성립하지 않는다.
    if (WIN) console.log("skip ⑬b 로그 퍼미션 — 윈도우는 POSIX mode 비트가 없다(ACL)");
    else {
      const mode = existsSync(lv(home, "update.log")) ? (stat(lv(home, "update.log")).mode & 0o777) : null;
      (mode === 0o600) ? ok("⑬b update.log 0600") : bad("⑬b 로그 퍼미션", `mode=${mode && mode.toString(8)}`);
    }
  }

  // ⑭ **AppleDouble 쓰레기 내성**(#858 회귀 — 2026-07-14 고객사 A 실사고). macOS 게이트웨이 번들엔 `._name.mjs`
  //   가 섞이는데, 이게 `node --check` 를 못 통과한다고 **정상 업데이트 전체를 막으면 안 된다**(설치기는 명시
  //   이름만 복사하므로 그 쓰레기는 배포조차 안 됨). 설치는 성공하고, `._` 파일은 멤버 홈에 안 남아야 한다.
  {
    serving.body = makeBundle("v-ad", { appledouble: true });
    serving.version = "v-ad";
    const home = freshHome(null);
    await runUpdater(home);
    const stamped = readIf(lv(home, "kit-version"));
    const installedGarbage = existsSync(join(home, ".lively", "hooks", "._run-custom.mjs"));
    const realRunner = existsSync(join(home, ".lively", "hooks", "run-custom.mjs"));
    const st = JSON.parse(readFileSync(join(home, ".lively", "update-state.json"), "utf8"));
    if (stamped === "v-ad" && !installedGarbage && realRunner && !st.failed_version) {
      ok("⑭ AppleDouble(._) 쓰레기 섞인 번들 — 설치 성공 + 쓰레기 미배포 (과잉차단 회귀 방지)");
    } else {
      bad("⑭ AppleDouble 내성", `stamp=${stamped} garbage=${installedGarbage} realRunner=${realRunner} failed=${st.failed_version}`);
    }
  }

  // ⑫ **번들 결정성** — 같은 입력이면 target 경로가 달라도 바이트가 같아야 한다.
  //   깨지면(생성물에 임시경로를 구우면) kit_version 이 매 호출 달라져 **전 멤버가 매 세션 재설치**를 돈다.
  //   지금은 안전하지만(teamReadme 의 publishLabel 은 본문 미사용), 회귀하면 여기서 잡는다.
  {
    const { createHash } = await import("node:crypto");
    const { readdirSync } = await import("node:fs");
    const treeHash = (dir, base = dir) => {
      const rows = [];
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.isFile()) rows.push(p.slice(base.length + 1) + "\0" + createHash("sha256").update(readFileSync(p)).digest("hex"));
        }
      };
      walk(dir);
      return createHash("sha256").update(rows.sort().join("\n")).digest("hex").slice(0, 12);
    };
    const a = mkdtempSync(join(BOX, "det-a-")), b = mkdtempSync(join(BOX, "det-bbbbbb-")); // 길이도 다른 경로
    buildKitBundle(a, { orgName: "동일조직", orgLabel: "same", harness: "claude" });
    buildKitBundle(b, { orgName: "동일조직", orgLabel: "same", harness: "claude" });
    const [ha, hb] = [treeHash(a), treeHash(b)];
    (ha === hb) ? ok(`⑫ 번들 결정성 — 다른 경로·같은 입력 → 같은 지문(${ha})`)
      : bad("⑫ 번들 결정성", `${ha} ≠ ${hb} — 생성물에 target 경로가 구워졌다(kit_version 이 매번 달라져 전원 무한 재설치)`);
  }

  // ⑮ #862 — Claude MCP **additive reconcile**. 새 서버(lively-local)가 없는 기존 멤버에게 자동 등록되되, 기존 항목·유저 상태는 불변.
  {
    serving.body = makeBundle("v-mcp"); serving.version = "v-mcp";
    const home = freshHome(null);
    const cj = join(home, ".claude.json");
    // '이미 lively(http)만 등록된' 멤버 — lively-local 없음. 유저 서버(other) + 무관 claude 상태(projects)도 둔다(보존돼야 함).
    writeFileSync(cj, JSON.stringify({
      mcpServers: {
        lively: { type: "http", url: `${GW}/mcp`, headers: { Authorization: "Bearer test-token" } },
        other: { type: "stdio", command: "/usr/bin/foo", args: [], env: {} },
      },
      projects: { "/some/path": { allowedTools: [] } },
    }, null, 2) + "\n");
    await runUpdater(home);
    const conf = JSON.parse(readFileSync(cj, "utf8"));
    const ll = conf.mcpServers && conf.mcpServers["lively-local"];
    const llOk = !!(ll && ll.type === "stdio" && Array.isArray(ll.args) && ll.args[0] === "mcp-local"
      && /[/\\]bin[/\\]lively(\.cmd)?$/.test(String(ll.command)));   // 윈도우 심은 `bin\\lively.cmd`(#1510)
    const userKept = !!(conf.mcpServers && conf.mcpServers.other && conf.projects && conf.projects["/some/path"]);
    // #1079 — additive 무손실의 **유일한 예외**: 우리가 심은 lively 항목을 http 직결 → stdio 프록시로 교정한다.
    //  (http 직결은 VPN 미접속 세션에서 그 세션 내내 죽는다.) 유저 항목·claude 상태는 여전히 불변이어야 한다.
    const lvEntry = (conf.mcpServers && conf.mcpServers.lively) || {};
    const migrated = lvEntry.type === "stdio" && Array.isArray(lvEntry.args) && lvEntry.args[0] === "mcp"
      // 윈도우 심은 `bin\\lively.cmd` 다 — 구분자·확장자를 가정하지 않는다(#1510).
      && /[/\\]bin[/\\]lively(\.cmd)?$/.test(String(lvEntry.command));
    // 부수 이득 — 설정 파일에서 평문 토큰이 사라진다(신원은 런타임에 ~/.lively/token 에서 읽는다).
    const tokenGone = !JSON.stringify(lvEntry).includes("test-token");
    (llOk && userKept && migrated && tokenGone)
      ? ok("⑮ MCP reconcile — lively-local 추가 + lively 를 stdio 프록시로 마이그레이션(평문 토큰 제거) + 유저 항목 불변")
      : bad("⑮ MCP reconcile", `llOk=${llOk} userKept=${userKept} migrated=${migrated} tokenGone=${tokenGone} lively=${JSON.stringify(lvEntry)}`);

    // ⑮b 멱등 — 이미 등록됐으면 재실행해도 파일을 안 건드린다(additive no-op).
    rmSync(lv(home, "kit-version"), { force: true }); // 같은 버전 강제 재설치
    const before = readFileSync(cj, "utf8");
    await runUpdater(home);
    (readFileSync(cj, "utf8") === before) ? ok("⑮b reconcile 멱등 — 이미 있으면 파일 미변경") : bad("⑮b 멱등", "파일이 변경됨");

    // ⑮d #1079 — **롤백 스위치**: ~/.lively/mcp-transport=http 면 마이그레이션하지 않는다.
    //  그때는 종전 계약이 그대로 살아 있어야 한다(헤더 additive — #1007+ 모드 헤더 전파, 토큰 불변).
    {
      const h2 = freshHome(null);
      writeFileSync(lv(h2, "mcp-transport"), "http\n");
      writeFileSync(join(h2, ".claude.json"), JSON.stringify({
        mcpServers: { lively: { type: "http", url: `${GW}/mcp`, headers: { Authorization: "Bearer test-token" } } },
      }, null, 2) + "\n");
      await runUpdater(h2);
      const e2 = (JSON.parse(readFileSync(join(h2, ".claude.json"), "utf8")).mcpServers || {}).lively || {};
      const stayed = e2.type === "http" && e2.url === `${GW}/mcp`;
      const hdrOk = e2.headers && e2.headers.Authorization === "Bearer test-token"
        && e2.headers["x-lively-session"] === "${LIVELY_SESSION_ID:-}"
        && e2.headers["x-lively-mode"] === "${LIVELY_MODE:-}";
      (stayed && hdrOk)
        ? ok("⑮d 롤백 스위치(mcp-transport=http) — 마이그레이션 안 함 + 헤더 additive 종전대로")
        : bad("⑮d 롤백 스위치", `stayed=${stayed} hdrOk=${hdrOk} entry=${JSON.stringify(e2)}`);
    }

    // ⑮f #1079 — **최신(local===target)이어도 MCP 등록 정합은 맞춘다.**
    //  새 배선이 담긴 버전을 설치하는 실행은 언제나 '구버전 코드'가 수행한다 → 배선 반영은 다음 실행 몫인데,
    //  그 다음 실행이 "최신이니 할 일 없음"으로 빠져나가면 **버전이 그대로인 한 영영 반영되지 않는다.**
    //  (실측 회귀 2026-07-22: 프록시 본체는 lib/ 에 깔렸는데 .claude.json 은 http 그대로였다.)
    {
      const h4 = freshHome("v-mcp");                       // 스탬프 = 서빙 버전 → '최신' 경로
      mkdirSync(join(h4, ".lively", "lib"), { recursive: true });
      writeFileSync(join(h4, ".lively", "lib", "lively-mcp-gateway.mjs"), "// proxy stub\n");
      writeFileSync(join(h4, ".claude.json"), JSON.stringify({
        mcpServers: { lively: { type: "http", url: `${GW}/mcp`, headers: { Authorization: "Bearer test-token" } } },
      }, null, 2) + "\n");
      await runUpdater(h4);
      const e4 = (JSON.parse(readFileSync(join(h4, ".claude.json"), "utf8")).mcpServers || {}).lively || {};
      // 설치는 일어나지 않아야 한다(최신이므로) — 훅 파일이 안 깔린 것으로 확인.
      const noReinstall = !existsSync(join(h4, ".lively", "hooks", "session-preload.mjs"));
      (e4.type === "stdio" && Array.isArray(e4.args) && e4.args[0] === "mcp" && noReinstall)
        ? ok("⑮f 최신이어도 등록 정합 교정 — 재설치 없이 http→stdio 마이그레이션")
        : bad("⑮f 최신 경로 reconcile", `entry=${JSON.stringify(e4)} noReinstall=${noReinstall}`);

      // 그리고 **멱등** — 이미 stdio 면 최신 경로에서 파일을 건드리지 않는다(정상 세션 비용 0).
      const before4 = readFileSync(join(h4, ".claude.json"), "utf8");
      await runUpdater(h4);
      (readFileSync(join(h4, ".claude.json"), "utf8") === before4)
        ? ok("⑮f-b 최신 경로 멱등 — 이미 stdio 면 파일 미변경")
        : bad("⑮f-b 최신 경로 멱등", "파일이 또 변경됨");
    }

    // ⑮g #1079 — **훅과 클로드 코드가 서로 다른 설정 파일을 볼 수 있다**(프로필 격리 #346).
    //  종전엔 '존재하는 첫 번째'만 고쳐서, 훅이 프로필 파일을 고치는 동안 클코가 읽는 홈 파일은 http 로 남았다
    //  ("로그는 마이그레이션했다는데 화면은 그대로" 실측 사고). 존재하는 파일은 **전부** 같은 값으로 맞춘다.
    {
      const h5 = freshHome("v-mcp");                    // 최신 경로(재설치 없이 reconcile 만)
      const prof = join(h5, "profile-claude");
      mkdirSync(prof, { recursive: true });
      // 프로필 격리에선 settings.json 도 그 안에 있다 — 하네스 판정(installedHarnesses)이 여기를 본다.
      writeFileSync(join(prof, "settings.json"), JSON.stringify({
        hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: `"node" "$HOME/.lively/hooks/session-preload.mjs"` }] }] },
      }, null, 2) + "\n");
      mkdirSync(join(h5, ".lively", "lib"), { recursive: true });
      writeFileSync(join(h5, ".lively", "lib", "lively-mcp-gateway.mjs"), "// proxy stub\n");
      const httpConf = JSON.stringify({
        mcpServers: { lively: { type: "http", url: `${GW}/mcp`, headers: { Authorization: "Bearer test-token" } } },
      }, null, 2) + "\n";
      writeFileSync(join(h5, ".claude.json"), httpConf);     // 클코가 읽는 홈 설정
      writeFileSync(join(prof, ".claude.json"), httpConf);   // 훅이 먼저 보게 될 프로필 설정
      await runUpdater(h5, { CLAUDE_CONFIG_DIR: prof });
      const readType = (p) => {
        try { return (JSON.parse(readFileSync(p, "utf8")).mcpServers || {}).lively?.type; } catch { return "(읽기실패)"; }
      };
      const tHome = readType(join(h5, ".claude.json"));
      const tProf = readType(join(prof, ".claude.json"));
      (tHome === "stdio" && tProf === "stdio")
        ? ok("⑮g 존재하는 설정 파일을 전부 교정 — 프로필·홈 어느 쪽을 클코가 읽든 stdio")
        : bad("⑮g 복수 설정 경로", `home=${tHome} profile=${tProf} — 한쪽만 고치면 클코가 보는 쪽이 안 바뀐다`);
    }

    // ⑮e #1079 — **프록시 본체가 없는 구버전 번들**이면 마이그레이션하지 않는다.
    //  (stdio 로 바꿔 놓고 실행할 파일이 없으면 lively 가 통째로 안 뜬다 — #905 와 같은 부류의 사고.)
    {
      serving.body = makeBundle("v-noproxy", { noProxy: true }); serving.version = "v-noproxy";
      const h3 = freshHome(null);
      writeFileSync(join(h3, ".claude.json"), JSON.stringify({
        mcpServers: { lively: { type: "http", url: `${GW}/mcp`, headers: { Authorization: "Bearer test-token" } } },
      }, null, 2) + "\n");
      await runUpdater(h3);
      const e3 = (JSON.parse(readFileSync(join(h3, ".claude.json"), "utf8")).mcpServers || {}).lively || {};
      const proxyAbsent = !existsSync(join(h3, ".lively", "lib", "lively-mcp-gateway.mjs"));
      (proxyAbsent && e3.type === "http")
        ? ok("⑮e 프록시 미동봉(구번들) — 마이그레이션 안 함, http 유지")
        : bad("⑮e 구번들 가드", `proxyAbsent=${proxyAbsent} entry=${JSON.stringify(e3)}`);
      serving.body = makeBundle("v-mcp"); serving.version = "v-mcp";   // 원복
    }

    // ⑮c ~/.claude.json 이 없는 멤버는 생성하지 않는다(무접촉 — 기존 테스트들이 reconcile 로 오염되지 않는 근거).
    const bare = freshHome(null);
    await runUpdater(bare);
    (!existsSync(join(bare, ".claude.json"))) ? ok("⑮c .claude.json 없으면 미생성(무접촉)") : bad("⑮c 무접촉", ".claude.json 이 생성됨");
  }
} finally {
  server.close();
  cleanup();
}

console.log(`self-update tests: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);

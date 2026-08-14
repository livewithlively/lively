#!/usr/bin/env node
// 플러그인 자격 미러 유닛테스트 — 사양 #1473 기반 블랙박스(엣지 표 9행 전수).
//   사양 요지: 플러그인 설치로 판정되면 자격을 ~/.lively 파일로도 굳힌다. 키트가 깐 파일은 절대 덮지 않는다
//   (소유기록으로 판정, 기록이 없거나 못 읽으면 '내 것 아님'으로 보수 판정). 인코그니토면 디스크에 안 남긴다.
//
//   실행: node kit/hooks/session-preload-plugin-creds.test.mjs   (exit 0=통과, 1=실패). 네트워크 불요.
//
//   ⚠ 단언은 **관찰 가능한 상태**만 본다 — 파일 존재·내용·권한 지문·소유기록 내용. 로그 문구는 보지 않는다.
//   ⚠ 홈을 임시 디렉터리로 돌린다 — os.homedir() 는 POSIX 에서 $HOME, 윈도우에서 %USERPROFILE% 을 본다(sandboxEnv).
//   ⚠ 케이스마다 **서브프로세스**로 돈다: 인코그니토 판정은 모듈 로드 시점 상수라 같은 프로세스에선 못 바꾼다.
//   ⚠ 배선 단언: 러너가 미러 호출 **후** 표식을 남긴다. 부정 케이스(§1·§6)는 그 표식을 함께 단언해
//      "프로세스가 죽어서 아무 파일도 없는 것"이 통과로 둔갑하지 않게 한다.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir, platform, homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandboxEnv } from "../testlib/os-sandbox.mjs";   // HOME 만으론 윈도우 격리가 안 된다(#1510)

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, "session-preload.mjs");
const WIN = platform() === "win32";

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why = "") => { cond ? ok(n) : bad(n, why); };

// 러너를 **파일로** 둔다 — `node -e` 는 argv[1] 이 없어 session-preload 의 isMain() 이 fail-open(true) 으로 떨어져
//  main() 이 도는 부작용이 난다. 파일 경로면 argv[1] ≠ 모듈경로라 isMain() 이 false 로 정확히 판정된다.
const RUNNER_DIR = mkdtempSync(join(tmpdir(), "lv-runner-"));
const RUNNER = join(RUNNER_DIR, "run.mjs");
writeFileSync(RUNNER, [
  `import { mirrorPluginCreds } from ${JSON.stringify(pathToFileURL(MODULE).href)};`,  // 절대경로 그대로면 윈도우에서 죽는다(#1510)
  `import { writeFileSync } from "node:fs";`,
  `import { homedir } from "node:os";`,
  `import { join } from "node:path";`,
  `mirrorPluginCreds();`,
  `writeFileSync(join(homedir(), "ran.marker"), "1");   // 배선 표식 — 미러 호출 뒤 무조건`,
  "",
].join("\n"));

const homes = [];
function newHome() { const h = mkdtempSync(join(tmpdir(), "lv-home-")); homes.push(h); return h; }
function run(home, env) {
  execFileSync(process.execPath, [RUNNER], {
    env: {
      ...process.env, ...sandboxEnv({ home }),
      LIVELY_OFF: "", LIVELY_HOOKS_OFF: "", LIVELY_TOKEN: "", LIVELY_GATEWAY_URL: "",
      CLAUDE_PLUGIN_OPTION_TOKEN: "", CLAUDE_PLUGIN_OPTION_GATEWAY_URL: "",
      ...env,
    },
    stdio: "ignore",
  });
}
const lv = (home, f) => join(home, ".lively", f);
const readOr = (p) => { try { return readFileSync(p, "utf8").trim(); } catch { return null; } };
const owned = (home) => { try { return JSON.parse(readFileSync(lv(home, "plugin-managed.json"), "utf8")).files; } catch { return null; } };
const perm = (p) => (statSync(p).mode & 0o777).toString(8);
const ran = (home) => existsSync(join(home, "ran.marker"));
const PLUGIN = { CLAUDE_PLUGIN_OPTION_TOKEN: "lvk_plugin", CLAUDE_PLUGIN_OPTION_GATEWAY_URL: "https://plugin.example.com" };
const t = (name, fn) => { try { fn(name); } catch (e) { bad(name, `threw: ${(e && e.message) || e}`); } };

// §1 — 키트 경로(자격 없음): 아무것도 만들지 않는다. + 배선 표식으로 "돌긴 했다"를 단언.
t("§1 자격 없으면 아무 파일도 만들지 않는다", (n) => {
  const h = newHome(); run(h, {});
  check(`${n} — 배선(프로세스 실행됨)`, ran(h), "러너가 돌지 않았다 — 이 케이스의 통과는 무의미");
  check(n, !existsSync(lv(h, "token")) && !existsSync(lv(h, "gateway-url")) && owned(h) === null,
    "자격이 없는데 파일이 생겼다");
});

// §2 — 신규 생성 + 권한 지문 + 소유기록
t("§2 자격 있고 파일 없으면 만든다", (n) => {
  const h = newHome(); run(h, PLUGIN);
  check(`${n} — 값`, readOr(lv(h, "token")) === "lvk_plugin" && readOr(lv(h, "gateway-url")) === "https://plugin.example.com",
    `token=${readOr(lv(h, "token"))} gw=${readOr(lv(h, "gateway-url"))}`);
  const m = owned(h);
  check(`${n} — 소유기록`, Array.isArray(m) && m.includes("token") && m.includes("gateway-url"), `files=${JSON.stringify(m)}`);
  if (!WIN) {
    check(`${n} — 토큰은 소유자 전용`, perm(lv(h, "token")) === "600", `mode=${perm(lv(h, "token"))}`);
    check(`${n} — 주소는 일반 권한`, perm(lv(h, "gateway-url")) === "644", `mode=${perm(lv(h, "gateway-url"))}`);
  }
});

// §3 — 키트 소유(소유기록에 없는 기존 파일)는 덮지 않는다
t("§3 소유기록에 없는 기존 파일은 덮지 않는다", (n) => {
  const h = newHome();
  mkdirSync(join(h, ".lively"), { recursive: true });
  writeFileSync(lv(h, "token"), "lvk_kit\n");
  writeFileSync(lv(h, "gateway-url"), "https://kit.example.com\n");
  run(h, PLUGIN);
  check(n, readOr(lv(h, "token")) === "lvk_kit" && readOr(lv(h, "gateway-url")) === "https://kit.example.com",
    `키트 파일이 덮였다 — token=${readOr(lv(h, "token"))} gw=${readOr(lv(h, "gateway-url"))}`);
});

// §4 — 플러그인 소유 + 값 변경 → 갱신
t("§4 소유기록에 있고 값이 다르면 갱신한다", (n) => {
  const h = newHome();
  run(h, { CLAUDE_PLUGIN_OPTION_TOKEN: "lvk_old", CLAUDE_PLUGIN_OPTION_GATEWAY_URL: "https://gw.example.com" });
  run(h, { CLAUDE_PLUGIN_OPTION_TOKEN: "lvk_new", CLAUDE_PLUGIN_OPTION_GATEWAY_URL: "https://gw.example.com" });
  check(n, readOr(lv(h, "token")) === "lvk_new", `갱신 안 됨 — token=${readOr(lv(h, "token"))}`);
});

// §5 — 플러그인 소유 + 같은 값 → 값 그대로
t("§5 소유기록에 있고 값이 같으면 값이 유지된다", (n) => {
  const h = newHome();
  run(h, PLUGIN); run(h, PLUGIN);
  const m = owned(h);
  check(n, readOr(lv(h, "token")) === "lvk_plugin" && Array.isArray(m) && m.includes("token"),
    `token=${readOr(lv(h, "token"))} files=${JSON.stringify(m)}`);
});

// §6 — 인코그니토: 디스크에 자격을 남기지 않는다. + 배선 표식 단언.
t("§6 인코그니토면 자격을 디스크에 남기지 않는다", (n) => {
  const h = newHome(); run(h, { ...PLUGIN, LIVELY_OFF: "1" });
  check(`${n} — 배선(프로세스 실행됨)`, ran(h), "러너가 돌지 않았다 — 이 케이스의 통과는 무의미");
  check(n, !existsSync(lv(h, "token")) && !existsSync(lv(h, "gateway-url")),
    "인코그니토인데 자격이 디스크에 남았다");
});

// §7 — 일부만 주어지면 그것만
t("§7 자격이 일부만 주어지면 그것만 만든다", (n) => {
  const h = newHome(); run(h, { CLAUDE_PLUGIN_OPTION_GATEWAY_URL: "https://only-gw.example.com" });
  check(n, !existsSync(lv(h, "token")) && readOr(lv(h, "gateway-url")) === "https://only-gw.example.com",
    `token존재=${existsSync(lv(h, "token"))} gw=${readOr(lv(h, "gateway-url"))}`);
});

// §8 — 소유기록이 깨져 있으면 보수적으로: 기존 파일을 덮지 않는다
t("§8 소유기록이 깨져 있으면 기존 파일을 덮지 않는다", (n) => {
  const h = newHome();
  mkdirSync(join(h, ".lively"), { recursive: true });
  writeFileSync(lv(h, "token"), "lvk_kit\n");
  writeFileSync(lv(h, "plugin-managed.json"), "{ 이건 JSON 이 아니다");
  run(h, PLUGIN);
  check(n, readOr(lv(h, "token")) === "lvk_kit",
    `소유기록이 깨졌는데 덮었다 — token=${readOr(lv(h, "token"))}`);
});

// §9 — ~/.lively 자체가 없어도 만든다
t("§9 .lively 디렉터리가 없으면 만들고 쓴다", (n) => {
  const h = newHome();
  check(`${n} — 사전상태`, !existsSync(join(h, ".lively")), "사전상태가 이미 존재한다(테스트 무효)");
  run(h, PLUGIN);
  check(n, readOr(lv(h, "token")) === "lvk_plugin", `token=${readOr(lv(h, "token"))}`);
});

// 배선 — 실제 홈을 건드리지 않았는가(임시 홈에서만 돌았다는 증거)
check("배선 — 실제 홈에 표식이 안 생겼다", !existsSync(join(homedir(), "ran.marker")),
  "실제 홈에 표식이 생겼다 — HOME 리다이렉트가 안 먹었다");

for (const h of homes) { try { rmSync(h, { recursive: true, force: true }); } catch { /* 정리 실패 무시 */ } }
try { rmSync(RUNNER_DIR, { recursive: true, force: true }); } catch { /* 정리 실패 무시 */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// 새 PC 부트스트랩 (#1541 T3) — **CLI 가 아예 없을 때** 앱이 그걸 손에 쥐는 단계.
//
// 앱은 설치를 재구현하지 않는다. 게이트웨이가 서빙하는 **바로 그 부트스트랩 스크립트**를 실행한다
//  (`/cli` = sh · `/cli.ps1` = PowerShell). 웹 관리화면이 사람에게 복붙시키는 그 한 줄과 같은 것이라,
//  경로가 하나뿐이고 우리가 그걸 이미 검증하고 있다([[delivery-install-invariants]]).
//
// ★ **비대화형으로 돌리는 게 핵심이다.** bootstrap.sh 는 `/dev/tty` 가 있고 stdout 이 TTY 면 마지막에
//  `exec lively setup` 으로 인계한다 — 그러면 그 setup 은 우리 이벤트 계약(`--json-events`) 밖에서 돌아
//  GUI 가 아무것도 못 보여주고, 가림 입력이 있는 TTY 를 찾다 매달린다. 파이프 stdio 로 띄우면
//  스크립트가 스스로 "CLI 준비 완료"까지만 하고 끝난다 → 그 다음은 앱이 `lively setup --json-events` 로 몬다.
//
// ★ **윈도우는 스크립트를 받아 파일로 실행한다**(#4940). 한 줄(`irm … | iex`)을 PowerShell **명령줄**로 넘기면
//  디펜더가 그 명령줄을 `Trojan:Win32/Commando.A!ml`(심각)로 잡아 프로세스를 막는다. 2026-10-23 실측(윈도우 서버 2022):
//  같은 PC 에서 처음 한 번만 통과하고 몇 분 뒤부터 8번 전부 차단됐다(클라우드 ML 판정이라 PC·시점마다 다르다).
//  같은 스크립트를 파일로 받아 `-File` 로 돌리면 탐지 0건이었다. 사람이 **열린 PowerShell 창에** 그 한 줄을 치는 건
//  명령줄 검사를 거치지 않아 통과한다 — 그래서 웹·CLI 의 안내 문구(cli-locate.bootstrapOneLiner)는 그대로 둔다.
//  ⚠ 대가: `-File` 은 실행 정책·AppLocker 를 탄다. `-ExecutionPolicy Bypass` 는 프로세스 범위라 그룹 정책(MachinePolicy·
//   UserPolicy)이 정한 실행 정책을 못 넘고, AppLocker 스크립트 규칙은 보통 %TEMP% 의 .ps1 을 허용하지 않는다(종전 `-Command`
//   문자열은 둘 다 안 탔다). 그런 회사 PC 에서는 여기서 실패하고, 앱은 손으로 하는 한 줄(bootstrapManualHint)을 같이 보여준다 —
//   열린 창에 치는 `irm | iex` 는 실행 정책을 안 타고, 시스템 프록시·윈도우 인증서 저장소도 그대로 쓴다.
//
// ⚠ 이건 **원격 코드 실행**이다(설계상 그렇다 — 설치란 원래 그런 일이다). 그래서 앱은 실행 전에
//  어떤 주소에서 무엇을 받는지 사람에게 보여준다. 주소는 사람이 방금 입력한 자기 회사 게이트웨이다.
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapOneLiner } from "./cli-locate.mjs";

function gatewayOf(gatewayUrl) {
  const gw = String(gatewayUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s"'`;|&$()<>\\]+$/i.test(gw)) throw new Error("게이트웨이 주소 형식이 올바르지 않습니다.");
  return gw;
}

/** 윈도우에서 받아 둘 스크립트 주소 — 웹 안내 한 줄과 **같은 URL** 이다. 그 밖의 OS 는 셸이 직접 받으므로 null. */
export function bootstrapScriptUrl(gatewayUrl, platform = process.platform) {
  const gw = gatewayOf(gatewayUrl);
  return platform === "win32" ? `${gw}/cli.ps1` : null;
}

/**
 * 부트스트랩 실행 명령(순수). 셸을 거치되 **인자는 우리가 만든 문자열뿐**이고, 그 안의 유일한 변수는
 * 이미 http(s) 형식 검사를 통과한 게이트웨이 주소다(ipc-contract.argvFor 와 같은 자).
 * 윈도우엔 셸 문자열이 없다 — 받아 둔 스크립트 파일(scriptFile)을 `-File` 로 넘긴다.
 */
export function bootstrapCommand(gatewayUrl, platform = process.platform, scriptFile = "") {
  const gw = gatewayOf(gatewayUrl);
  if (platform === "win32") {
    if (!scriptFile) throw new Error("받아 둔 부트스트랩 스크립트가 없습니다.");
    // -NoProfile: 사용자 프로필 스크립트가 출력·PATH 를 오염시키지 않게. -ExecutionPolicy Bypass: 이 프로세스만.
    //  ⚠ `-Command "irm … | iex"` 로 되돌리지 마라 — 머리 주석(디펜더 차단).
    return { cmd: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptFile] };
  }
  return { cmd: "/bin/sh", args: ["-c", `curl -fsSL ${gw}/cli | sh`] };
}

/**
 * 받아 둔 스크립트를 PowerShell 5.1 이 **제대로 읽고 제대로 말하게** 쓴다.
 *  ① UTF-8 BOM — 5.1 은 BOM 없는 .ps1 을 시스템 ANSI 코드페이지로 읽는다. 한국어판(949)이면 한글 문자열이 깨진다
 *    (실측: 안내 문구가 «而댄벂?곕?» 로 나왔다). `irm | iex` 는 HTTP charset(utf-8)으로 읽어서 안 드러났던 차이다.
 *    서버는 BOM 을 떼서 준다(src/bootstrap-asset.ts — 문자열로 iex 에 들어가면 BOM 이 파서까지 가서).
 *  ② 출력 UTF-8 — 앱은 자식 출력을 UTF-8 로 읽는데, 숨은 콘솔의 기본 코드페이지(949 등)로 나오면 로그의 한글이 깨진다.
 *  ⚠ ②가 스크립트의 첫 문장이 되므로 bootstrap.ps1 은 최상위 `param()`·`[CmdletBinding()]`·`using` 을 가질 수 없다
 *   (셋 다 맨 앞이어야 한다). 지금은 없다 — 넣어야 하면 이 프렐류드를 먼저 옮겨라.
 */
export function psScriptFile(text) {
  return "\uFEFF" + "try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }\r\n"
    + String(text).replace(/^\uFEFF/, "");
}

async function fetchScript(url, fetchFn) {
  try {
    const res = await fetchFn(url, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { text: await res.text() };
  } catch (e) {
    return { error: e?.cause?.message || e?.message || String(e) };
  }
}

/**
 * 실행 — 출력은 줄 단위로 흘려보내고(설치는 오래 걸린다. 사람이 멈춘 줄 알면 안 된다), 끝나면 성공 여부.
 * 윈도우는 먼저 스크립트를 임시 폴더에 받아 두고, 다 돈 뒤 지운다.
 *
 * ⚠ **stdio 는 반드시 파이프**다(위 주석의 '비대화형' 이유). TTY 를 물려주면 흐름이 통째로 갈라진다.
 * ⚠ 스크립트를 **받지 못했으면 error 를 비운다** — 사람에게 줄 다음 행동은 경로(주소·클라우드)마다 달라서
 *  호출자가 정한다(main.bootstrapFailNote). `curl | sh` 가 404 에도 0 으로 끝날 때와 같은 자리로 간다.
 *  받지 못한 이유는 로그(onLine)와 output 에 남긴다.
 * ⚠ **던지지 않는다**(모든 실패는 `{ ok:false }` 로 돌려준다) — 호출자(main.ensureCli)는 busy 를 세운 채 await 만 한다.
 * ⚠ `-File` 에서는 스크립트의 Die(PipelineStoppedException)가 종료코드 0 으로 끝난다(`-Command` 는 1) — 그래서 성공은
 *  호출자가 'CLI 가 실제로 생겼나' 로 판정한다(main.ensureCli). 실패 이유는 로그에 있다.
 */
export async function runBootstrap(o) {
  const spawn = o.spawn || nodeSpawn;
  const platform = o.platform || process.platform;
  let scriptUrl;
  try { scriptUrl = bootstrapScriptUrl(o.gatewayUrl, platform); } catch (e) { return { ok: false, error: e.message, output: "" }; }
  let dir = null;
  try {
    let scriptFile = "";
    if (scriptUrl) {
      const got = await fetchScript(scriptUrl, o.fetch || fetch);
      if (got.error) {
        const line = `설치 스크립트를 받지 못했습니다: ${scriptUrl} (${got.error})`;
        if (o.onLine) o.onLine(line);
        return { ok: false, code: null, signal: null, output: line, error: null };
      }
      try {
        dir = mkdtempSync(join(o.tmpDir || tmpdir(), "lively-bootstrap-"));
        scriptFile = join(dir, "cli.ps1");
        writeFileSync(scriptFile, psScriptFile(got.text), "utf8");
      } catch (e) {
        // 백신(EDR)이 %TEMP% 의 .ps1 쓰기를 막거나 디스크가 찼다 — 주소 문제가 아니라서 error 를 채운다(주소 안내는 틀린 답이다).
        return { ok: false, code: null, signal: null, output: "", error: `설치 스크립트를 임시 폴더에 쓰지 못했습니다: ${e?.message || e}` };
      }
    }
    return await spawnBootstrap(spawn, bootstrapCommand(o.gatewayUrl, platform, scriptFile), o);
  } finally {
    // 자식이 끝난 뒤에만 지운다. 디펜더가 방금 돈 .ps1 을 검사하느라 잠깐 쥐고 있으면 첫 삭제가 EBUSY·EPERM 이라 다시 시도한다.
    //  그래도 못 지우면 남는다 — 토큰 없는 공개 스크립트라 위생 문제일 뿐이다(윈도우는 %TEMP% 를 저절로 비우지 않는다).
    if (dir) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* */ } }
  }
}

function spawnBootstrap(spawn, cmdSpec, o) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmdSpec.cmd, cmdSpec.args, {
        // ⚠ LIVELY_HOME 은 그대로 물려준다(샌드박스 테스트가 실 홈을 안 건드리게) — 없으면 스크립트가 진짜 HOME 을 쓴다.
        env: o.env || process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
    } catch (e) {
      resolve({ ok: false, error: `부트스트랩을 실행하지 못했습니다: ${e?.message || e}`, output: "" });
      return;
    }
    let output = "", buf = "", spawnError = null;
    const feed = (chunk) => {
      output += chunk; buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (o.onLine) o.onLine(l); }
    };
    child.stdout.setEncoding("utf8"); child.stdout.on("data", feed);
    child.stderr.setEncoding("utf8"); child.stderr.on("data", feed);
    child.on("error", (e) => { spawnError = e?.message || String(e); });
    const timer = o.timeoutMs ? setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } }, o.timeoutMs) : null;
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (buf.trim() && o.onLine) o.onLine(buf);
      // ★ 종료코드만으로 판정하지 않는다 — `curl | sh` 는 **curl 이 404 를 받아도 sh 가 빈 입력을 성공으로 끝낸다**
      //  (파이프라인의 종료코드는 마지막 명령의 것이다). 그래서 호출자가 '실제로 CLI 가 생겼나' 를 함께 본다.
      const ok = code === 0 && !signal && !spawnError;
      resolve({
        ok, code, signal: signal || null, output,
        error: spawnError || (signal ? `부트스트랩이 강제 종료됐습니다(${signal}).` : ok ? null : "부트스트랩이 실패했습니다."),
      });
    });
  });
}

/**
 * 사람에게 보여줄 '지금 실행할 한 줄' — 앱이 무엇을 하는지 숨기지 않는다.
 *  윈도우는 실제로 하는 일(받아서 파일로 실행)과 같은 PowerShell 한 줄을 보여준다.
 */
export function bootstrapPreview(gatewayUrl, platform = process.platform) {
  const one = bootstrapOneLiner(gatewayUrl, platform);
  if (!one || platform !== "win32") return one;
  const gw = String(gatewayUrl || "").replace(/\/+$/, "");
  return `irm ${gw}/cli.ps1 -OutFile cli.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File cli.ps1`;
}

/**
 * 앱이 대신 못 깔았을 때 사람이 손으로 하는 한 줄(윈도우만). 열린 PowerShell 창에 치는 `irm … | iex` 는 명령줄 검사·실행 정책을
 *  안 타고 시스템 프록시·윈도우 인증서 저장소를 쓴다 — 회사 정책(GPO·AppLocker)이나 사내 프록시에 막힌 PC 의 출구다(머리 주석).
 *  맥·리눅스는 null — 앱이 쓰는 경로가 이미 그 셸 한 줄이다.
 */
export function bootstrapManualHint(gatewayUrl, platform = process.platform) {
  if (platform !== "win32") return null;
  const one = bootstrapOneLiner(gatewayUrl, platform);
  return one ? `PowerShell 창을 열고 이 한 줄을 붙여 넣으면 직접 설치할 수 있습니다: ${one}` : null;
}

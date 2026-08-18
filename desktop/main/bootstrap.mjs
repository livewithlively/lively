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
// ⚠ 이건 **원격 코드 실행**이다(설계상 그렇다 — 설치란 원래 그런 일이다). 그래서 앱은 실행 전에
//  어떤 주소에서 무엇을 받는지 사람에게 보여준다. 주소는 사람이 방금 입력한 자기 회사 게이트웨이다.
import { spawn as nodeSpawn } from "node:child_process";
import { bootstrapOneLiner } from "./cli-locate.mjs";

/**
 * 부트스트랩 실행 명령(순수). 셸을 거치되 **인자는 우리가 만든 문자열뿐**이고, 그 안의 유일한 변수는
 * 이미 http(s) 형식 검사를 통과한 게이트웨이 주소다(ipc-contract.argvFor 와 같은 자).
 */
export function bootstrapCommand(gatewayUrl, platform = process.platform) {
  const gw = String(gatewayUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s"'`;|&$()<>\\]+$/i.test(gw)) throw new Error("게이트웨이 주소 형식이 올바르지 않습니다.");
  if (platform === "win32") {
    // -NoProfile: 사용자 프로필 스크립트가 출력·PATH 를 오염시키지 않게. -ExecutionPolicy Bypass: 이 프로세스만.
    return { cmd: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${gw}/cli.ps1 | iex`] };
  }
  return { cmd: "/bin/sh", args: ["-c", `curl -fsSL ${gw}/cli | sh`] };
}

/**
 * 실행 — 출력은 줄 단위로 흘려보내고(설치는 오래 걸린다. 사람이 멈춘 줄 알면 안 된다), 끝나면 성공 여부.
 *
 * ⚠ **stdio 는 반드시 파이프**다(위 주석의 '비대화형' 이유). TTY 를 물려주면 흐름이 통째로 갈라진다.
 */
export function runBootstrap(o) {
  const spawn = o.spawn || nodeSpawn;
  let cmdSpec;
  try { cmdSpec = bootstrapCommand(o.gatewayUrl, o.platform); } catch (e) { return Promise.resolve({ ok: false, error: e.message, output: "" }); }
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

/** 사람에게 보여줄 '지금 실행할 한 줄' — 앱이 무엇을 하는지 숨기지 않는다. */
export const bootstrapPreview = bootstrapOneLiner;

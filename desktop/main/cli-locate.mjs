// 라이블리 CLI 실행파일 찾기 (#1541 T2) — 앱은 CLI 를 **감싸는** 물건이라 이걸 못 찾으면 아무것도 못 한다.
//
// ⚠ **순수함수로 뺀다**(kit/cli/cmd-node.mjs 의 muxCandidates 와 같은 이유): 플랫폼별 후보 목록은 그 플랫폼이
//  아니면 한 번도 실행되지 않는다. platform·env 를 인자로 받으면 mac 에서도 Windows 목록을 테스트로 못박을 수 있다.
//  경로 조립은 `win32.join` 을 써서 POSIX 에서 만들어도 진짜 Windows 구분자가 나오게 한다(`/` 가 섞이면 검증이 무의미).
//
// ⚠ **PATH 를 먼저 믿지 않는다.** GUI 앱은 로그인 셸을 거치지 않아 PATH 가 빈약하다 — macOS Finder 로 띄운
//  앱의 PATH 엔 `/usr/local/bin` 조차 없을 수 있고, 사용자가 `~/.lively/bin` 을 rc 에 추가했어도 GUI 앱은 그걸 못 본다.
//  그래서 **설치 규약이 정한 자리**(~/.lively/bin)를 1순위로 본다. 그게 곧 우리가 깐 자리이기도 하다.
import { win32 as pwin, posix as pposix } from "node:path";

/** 셸 심의 파일명 — 윈도우는 `.cmd` 배치다(user-install.mjs 의 CLI_SHIM_CMD 와 같은 계약). */
export const cliShimName = (platform = process.platform) => (platform === "win32" ? "lively.cmd" : "lively");

/**
 * 실행파일 후보 — **앞이 우선**. 존재 확인은 호출자가 한다(순수 유지).
 *
 * `LIVELY_CLI` 가 있으면 그것만 본다: 개발·테스트가 특정 빌드를 정확히 지목할 수 있어야 하고,
 * 그 의도를 아래 폴백들이 덮어써서는 안 된다.
 */
export function cliCandidates(platform = process.platform, env = process.env) {
  const explicit = String(env.LIVELY_CLI || "").trim();
  if (explicit) return [explicit];
  const win = platform === "win32";
  const p = win ? pwin : pposix;
  const home = env.LIVELY_HOME || (win ? env.USERPROFILE : env.HOME) || "";
  const shim = cliShimName(platform);
  const out = [];
  if (home) out.push(p.join(home, ".lively", "bin", shim));   // 설치 규약이 정한 자리(1순위)
  if (win) {
    const local = env.LOCALAPPDATA || (home ? pwin.join(home, "AppData", "Local") : "");
    if (local) out.push(pwin.join(local, "Programs", "lively", shim));
  } else {
    if (home) out.push(p.join(home, ".local", "bin", shim));
    out.push("/usr/local/bin/" + shim, "/opt/homebrew/bin/" + shim);
  }
  return out;
}

/**
 * 후보 중 **실제로 있는** 첫 경로. 없으면 null.
 * `exists` 를 주입받는다 — 파일시스템 없이 목록·순서를 검증하기 위해서다.
 */
export function locateCli(exists, platform = process.platform, env = process.env) {
  for (const c of cliCandidates(platform, env)) { if (exists(c)) return c; }
  return null;
}

/**
 * 부트스트랩 한 줄 — 게이트웨이가 실제로 서빙하는 경로다(src/web.ts: `/cli`=sh · `/cli.ps1`=PowerShell).
 * ⚠ 웹 관리화면이 사람에게 주는 문구(public/app/admin-install.js)와 **같은 URL** 이어야 한다.
 *  앱이 다른 주소를 안내하면 사람은 404 를 받고, 우리는 그걸 영영 모른다.
 */
export function bootstrapOneLiner(gatewayUrl, platform = process.platform) {
  const gw = String(gatewayUrl || "").replace(/\/+$/, "");
  if (!gw) return null;
  return platform === "win32" ? `irm ${gw}/cli.ps1 | iex` : `curl -fsSL ${gw}/cli | sh`;
}

/**
 * CLI 가 없을 때 사람에게 줄 안내 — 앱이 "실패했습니다"로 끝나지 않게 **다음 행동**을 준다.
 * 게이트웨이 주소를 알면 부트스트랩 한 줄을, 모르면 주소부터 물어야 한다고 말한다.
 */
export function cliMissingHelp(gatewayUrl, platform = process.platform) {
  const one = bootstrapOneLiner(gatewayUrl, platform);
  if (!one) return "라이블리 CLI 를 찾지 못했습니다. 먼저 게이트웨이 주소를 입력하면 앱이 설치를 진행합니다.";
  return platform === "win32"
    ? `라이블리 CLI 가 아직 없습니다. PowerShell 에서 아래 한 줄을 실행한 뒤 앱을 다시 여세요:\n  ${one}`
    : `라이블리 CLI 가 아직 없습니다. 터미널에서 아래 한 줄을 실행한 뒤 앱을 다시 여세요:\n  ${one}`;
}

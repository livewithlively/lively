// 이 컴퓨터에 어떤 AI 도구가 있나 (#5650) — «이 컴퓨터 설정» 화면의 «찾음 / 설치 안 됨» 근거.
//
// 왜 앱이 직접 재나: 그 화면은 **CLI 를 깔기 전에** 뜬다(로그인 버튼은 로그인만 한다). 그래서 CLI 의 detectHarnesses
//  (kit/cli/lively.mjs)를 부를 수 없고, 같은 판정을 여기 한 벌 둔다. 판정 재료는 그쪽과 같다 — 실행 파일 이름
//  (claude · codex · opencode · agy · grok · cursor-agent)과 Cursor 의 홈 폴더(IDE 만 쓰는 사람은 PATH 에 CLI 가 없다).
//  설치 뒤의 배선은 CLI 가 다시 재므로, 여기가 조금 틀려도 «찾음» 표시만 틀리고 설치 결과는 틀리지 않는다.
//
// ⚠ 순수 모듈이다(파일 존재 판정·env·홈을 주입받는다) — desktop-core.test.mjs 가 표로 시험한다.
import { join, delimiter as pathDelimiter } from "node:path";

/** 화면에 보이는 순서 그대로(사람이 정했다: Claude Code, Codex, Antigravity, Cursor, Grok Build, OpenCode). */
export const HARNESS_ORDER = ["claude", "codex", "antigravity", "cursor", "grok", "opencode"];

export const HARNESS_LABEL = {
  claude: "Claude Code", codex: "Codex", antigravity: "Antigravity", cursor: "Cursor", grok: "Grok Build", opencode: "OpenCode",
};

/** 실행 파일 이름 — kit/hooks/harness-registry.mjs 의 bin 과 같아야 한다(desktop-core.test.mjs 가 못박는다). */
export const HARNESS_BIN = {
  claude: "claude", codex: "codex", antigravity: "agy", cursor: "cursor-agent", grok: "grok", opencode: "opencode",
};

/** 공급사 설치기가 실행 파일을 두는 자리 — GUI 앱의 PATH 에 없을 수 있어 따로 본다(registry 의 binDir). */
export function extraBinDirs(home, env = {}, platform = process.platform) {
  const dirs = [join(home, ".local", "bin"), join(home, ".opencode", "bin"), join(home, ".grok", "bin")];
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
    dirs.push(join(local, "Programs", "OpenAI", "Codex", "bin"), join(local, "agy", "bin"), join(local, "cursor-agent"));
    if (env.APPDATA) dirs.push(join(env.APPDATA, "npm"));
  }
  return dirs;
}

/**
 * @param {{ exists:(p:string)=>boolean, env?:object, home:string, platform?:string }} o
 * @returns {string[]} 찾은 하네스 id (HARNESS_ORDER 순)
 */
export function detectHarnesses({ exists, env = process.env, home, platform = process.platform }) {
  const exts = platform === "win32" ? ["", ".exe", ".cmd", ".ps1"] : [""];
  const dirs = [...String(env.PATH || env.Path || "").split(pathDelimiter).filter(Boolean), ...extraBinDirs(home, env, platform)];
  const hasBin = (bin) => dirs.some((d) => exts.some((x) => { try { return exists(join(d, bin + x)); } catch { return false; } }));
  const found = new Set();
  for (const id of HARNESS_ORDER) if (hasBin(HARNESS_BIN[id])) found.add(id);
  // Cursor 는 IDE 만 쓰는 사람이 많다 — 홈 폴더가 있으면 쓰는 도구로 본다(CLI cursorPresent 와 같은 판정).
  if (exists(join(home, ".cursor")) || exists(join(home, ".cursor-server"))) found.add("cursor");
  return HARNESS_ORDER.filter((id) => found.has(id));
}

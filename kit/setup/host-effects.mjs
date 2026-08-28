// 영속 머신 상태에 닿는 설치/제거 부수효과의 단일 경계.
//
// 기본은 deny다. HOME/LIVELY_HOME 같은 경로 리다이렉트는 레지스트리·브라우저·작업 스케줄러를
// 격리하지 못하므로 테스트 여부를 추론하는 신호로 쓰지 않는다. 사람용 오케스트레이터와 disposable
// host-effect CI만 명시적으로 capability를 넘긴다.
import {
  execFileSync as nodeExecFileSync,
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
} from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, resolve, sep } from "node:path";

export const HOST_EFFECTS_ALLOW_FLAG = "--allow-host-effects";
export const HOST_EFFECTS_DENY_ENV = "LIVELY_HOST_EFFECTS";

const SCHEDULER_COMMANDS = new Set(["schtasks", "launchctl", "systemctl", "loginctl"]);

export class HostEffectDeniedError extends Error {
  constructor(kind, operation) {
    super(`HostEffects denied ${kind}: ${operation}`);
    this.name = "HostEffectDeniedError";
    this.code = "LIVELY_HOST_EFFECT_DENIED";
    this.kind = kind;
    this.operation = operation;
  }
}

export function hostEffectsAllowed({ args = process.argv.slice(2), env = process.env } = {}) {
  return args.includes(HOST_EFFECTS_ALLOW_FLAG) || env.LIVELY_HOST_EFFECTS === "allow";
}

const unquote = (value) => String(value || "").replace(/^"|"$/g, "");
const commandName = (command) => unquote(command).replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
const processKind = (command) => SCHEDULER_COMMANDS.has(commandName(command)) ? "scheduler" : "external-cli";
const pathKey = (value) => process.platform === "win32" ? String(value).toLowerCase() : String(value);
/**
 * ★ 심링크를 풀어 본 형태도 함께 본다 — 안 그러면 **macOS 에서 모든 임시경로가 '샌드박스 밖'으로 판정된다.**
 *
 * 실측(2026-08-27): `os.tmpdir()` 는 `/var/folders/…` 를 주는데 그 안에 만든 폴더의 realpath 는
 *  `/private/var/folders/…` 다(`/var` → `/private/var` 심링크). 테스트는 바인딩 정본을 맞추려
 *  realpath 를 쓰고(예: kit/cli/project-init.test.mjs mkRepo), 게이트는 raw `tmpdir()` 를 뿌리로 쓴다.
 *  `resolve()` 는 심링크를 풀지 않으므로 `startsWith` 가 그 자리에서 실패 →
 *  `HostEffects denied external-cli: git`. **리눅스 CI(`/tmp`, 심링크 없음)에서는 안 난다** — 그래서
 *  CI 는 초록불인데 개발자 맥에서만 5건이 빨간불이었고, 그 상태가 "원래 저래" 로 굳고 있었다.
 *
 * 넓히는 게 아니라 **같은 자리를 같은 자리로 알아보게** 하는 것이다: 두 표기가 가리키는 디렉터리가
 *  실제로 하나다. 종전에 통과하던 raw↔raw 비교는 그대로 두므로(변형 목록에 raw 가 남는다) 무회귀다.
 */
const realish = (p) => { try { return realpathSync(p); } catch { return p; } };   // 아직 없는 경로(clone 목적지 등)는 그대로
const pathForms = (p) => { const r = resolve(p); const real = realish(r); return real === r ? [r] : [r, real]; };
const inside = (file, root) => {
  if (!file || !root) return false;
  const fs_ = pathForms(file).map(pathKey), rs = pathForms(root).map(pathKey);
  return fs_.some((f) => rs.some((r) => f === r || f.startsWith(r.endsWith(sep) ? r : r + sep)));
};
const resolvedCommand = (command, env) => {
  const raw = unquote(command);
  if (isAbsolute(raw)) return raw;
  const exts = process.platform === "win32" ? String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of String(env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const ext of ["", ...exts]) {
      const candidate = resolve(dir, raw + ext);
      if (existsSync(candidate)) return candidate;
    }
    try {
      const wanted = new Set([raw, ...exts.map((ext) => raw + ext)].map((v) => v.toLowerCase()));
      const found = readdirSync(dir).find((name) => wanted.has(name.toLowerCase()));
      if (found) return resolve(dir, found);
    } catch { /* PATH 항목 부재/접근불가 */ }
  }
  return "";
};
const sandboxProcessAllowed = ({ command, args = [], options = {} }, env) => {
  const name = commandName(command);
  if (["where", "command", "hostname", "whoami"].includes(name)) return true;
  const resolved = resolvedCommand(command, env);
  // Linux CI에는 TMPDIR가 없을 수 있지만 테스트의 mkdtemp(tmpdir())는 여전히 /tmp 아래다.
  const roots = [env.LIVELY_HOME, env.TEMP, env.TMP, env.TMPDIR, tmpdir()].filter(Boolean);
  // ⚠ `pathKey(...) === pathKey(...)` 로 **문자열 비교하지 마라.** PATH 의 `node` 는 보통 심링크이고
  //  (`/opt/homebrew/bin/node` → `/opt/homebrew/Cellar/node@22/…/bin/node`) `process.execPath` 는 실경로라
  //  같은 실행파일인데 문자열이 다르다 → 훅 실행이 통째로 막힌다(실측 2026-08-27: kit/hooks/run-custom
  //  52건 중 33건이 'crash' 로 빨간불. 리눅스 CI 는 PATH 의 node 가 실경로라 안 났다).
  //  inside() 는 realpath 형태까지 함께 보므로 같은 파일을 같은 파일로 알아본다(경로가 같으면 f===r).
  if (name === "node" && (inside(resolved, process.execPath)
    || roots.some((root) => inside(resolved, root)))) return true;
  if (roots.some((root) => inside(resolved, root))) return true;
  const cleanArgs = args.map(unquote);
  if (name === "git" && !cleanArgs.some((a) => a === "--global" || a === "--system")) {
    const at = cleanArgs.indexOf("-C");
    const cloneDest = cleanArgs[0] === "clone" ? cleanArgs.at(-1) : "";
    return roots.some((root) => inside(options.cwd, root)
      || (at >= 0 && inside(cleanArgs[at + 1], root))
      || inside(cloneDest, root));
  }
  if (name === "tar") {
    const at = cleanArgs.indexOf("-C");
    return at >= 0 && roots.some((root) => inside(cleanArgs[at + 1], root));
  }
  return roots
    .filter(Boolean)
    .some((root) => inside(resolved, root));
};
const sandboxNetworkAllowed = (input) => {
  try {
    const u = new URL(typeof input === "string" ? input : input?.url);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    const port = Number(u.port);
    // Linux의 listen(0)은 통상 32768부터 배정된다. IANA의 49152만 가정하면 CI의 실제
    // loopback fixture를 차단한다. 기본 서비스 포트는 이 범위 밖이라 계속 닫힌다.
    return loopback && Number.isInteger(port) && port >= 32768 && port <= 65535;
  } catch { return false; }
};

/**
 * 사용자 머신 밖/위에서 일어나는 효과의 주입 포트.
 *
 * 기본은 deny다. 제품의 최상위 진입점만 entrypointHostEffects()를 호출해 native 포트를 얻고,
 * 단위 테스트는 createHostEffects({ mode: "fake", ... })에 기록용 fake를 넣는다.
 */
export function createHostEffects({
  mode = "deny",
  env = process.env,
  execFile = nodeExecFileSync,
  spawn = nodeSpawn,
  spawnSync = nodeSpawnSync,
  fetcher = (...args) => globalThis.fetch(...args),
} = {}) {
  const enabled = mode === "native" || mode === "fake";
  const guard = (kind, operation, detail) => {
    if (enabled) return;
    if (mode === "sandbox" && kind === "external-cli" && sandboxProcessAllowed(detail, env)) return;
    if (mode === "sandbox" && kind === "scheduler" && sandboxProcessAllowed(detail, env)) return;
    if (mode === "sandbox" && kind === "network" && sandboxNetworkAllowed(detail)) return;
    throw new HostEffectDeniedError(kind, operation);
  };
  return Object.freeze({
    mode,
    execFileSync(command, args = [], options = {}) {
      guard(processKind(command), commandName(command), { command, args, options });
      return execFile(command, args, options);
    },
    spawn(command, args = [], options = {}) {
      guard(processKind(command), commandName(command), { command, args, options });
      return spawn(command, args, options);
    },
    spawnSync(command, args = [], options = {}) {
      guard(processKind(command), commandName(command), { command, args, options });
      return spawnSync(command, args, options);
    },
    schedulerSync(command, args = [], options = {}) {
      guard("scheduler", commandName(command), { command, args, options });
      return spawnSync(command, args, options);
    },
    fetch(input, init) {
      const target = typeof input === "string" ? input : (input?.url || String(input));
      guard("network", target, input);
      return fetcher(input, init);
    },
  });
}

// 사람이 실행한 제품 진입점의 명시적 capability. 테스트 러너는 env=deny로 이 승격 자체를 봉쇄한다.
export function entrypointHostEffects({ env = process.env, ...ports } = {}) {
  const denied = env.LIVELY_HOST_EFFECTS === "deny";
  const mode = denied && env.LIVELY_HOST_EFFECTS_TEST_MODE === "sandbox" ? "sandbox" : (denied ? "deny" : "native");
  return createHostEffects({ mode, env, ...ports });
}

const runPowerShell = (script) => nodeSpawnSync(
  "powershell",
  ["-NoProfile", "-NonInteractive", "-Command", script],
  { encoding: "utf8", windowsHide: true },
);

const escapedPs = (value) => String(value).replace(/'/g, "''");

export const normalizeWindowsPathEntry = (value) => String(value || "")
  .trim()
  .replace(/[\\/]+$/, "")
  .replace(/\//g, "\\")
  .toLowerCase();

/**
 * Windows User PATH 를 **자라지 않게** 정리한다 — 순수(#2172).
 *
 * 왜 필요한가(2026-08-28 실측, 윤상민 PC `amorite`): User PATH 가 **84개 / 6224자**까지 부풀어 있었고 그중
 *  **70개가 삭제된 테스트 임시홈**(`…\AppData\Local\Temp\{codex,grok,opencode}-wiring-test-*` 등)이었다. 그런데
 *  윈도우는 사용자 PATH 가 너무 길면 **뒤를 자르는 게 아니라 통째로 안 합친다** — 그 PC 의 프로세스 PATH 는
 *  616자(시스템만)였고, `.lively\bin`·`.local\bin`·`Roaming\npm`·`agy\bin` 이 **어느 프로세스에도 안 보였다**.
 *  결과: `lively`·`claude` 미검출, 노드 하네스 탐지 5종 전멸(`agent_harnesses=["shell"]`), 화면엔 "AI 가 없어요".
 *  정리 후 14개/727자 → 프로세스 PATH 1344자 → 전부 복구.
 *
 * 오염원(테스트)은 HostEffects deny 로 이미 막았지만, **쓰기 자체가 무조건 앞에 붙이는 구조**라 정상 사용만으로도
 *  계속 자란다. 그래서 쓰기 전에 여기서 줄인다.
 *
 * 무엇을 버리나 — **죽은 임시경로만**. "TEMP 아래인데 지금 존재하지 않는" 항목이다. 존재하지 않는다는 이유만으로
 *  버리지 않는다(이동식·네트워크 드라이브는 지금 없어도 사용자의 정상 경로다). 중복은 host-effects 의
 *  normalizeWindowsPathEntry 와 **같은 규칙**으로 접는다(대소문자·후행 슬래시 무시).
 *
 * @param current   현재 User PATH 문자열
 * @param binDir    보장할 항목(없으면 맨 앞에 한 번). 비우면 추가하지 않는다.
 * @param opts.isDeadTempEntry (항목)=>boolean — '죽은 임시경로인가'. 실제 판정은 isDeadWindowsTempEntry 가 갖는다
 *   (여기 주입 seam 으로 두는 이유: 파일시스템 없이 접기·순서 규칙만 따로 검증하기 위해서다).
 * @returns {{value:string, changed:boolean, dropped:string[]}}
 */
export function isDeadWindowsTempEntry(entry, { tempDirs = [], exists = () => true } = {}) {
  const norm = normalizeWindowsPathEntry(entry);
  if (!norm) return false;
  // TEMP **아래**여야 한다 — 경로 경계(`\\`)까지 봐서 `…\tempest\bin` 같은 이름이 걸리지 않게 한다.
  const under = tempDirs
    .map((d) => normalizeWindowsPathEntry(d))
    .filter(Boolean)
    .some((d) => norm === d || norm.startsWith(d + "\\"));
  if (!under) return false;                                  // TEMP 밖은 없어도 안 버린다(이동식·네트워크 드라이브)
  return !exists(entry);                                     // TEMP 안이어도 **살아 있으면** 안 버린다
}

export function sanitizeWindowsUserPath(current, binDir, { isDeadTempEntry = () => false } = {}) {
  const before = String(current || "");
  const dropped = [];
  const kept = [];
  const seen = new Set();
  for (const raw of before.split(";")) {
    const entry = String(raw || "").trim();
    if (!entry) continue;                                   // `;;` 정리
    if (isDeadTempEntry(entry)) { dropped.push(entry); continue; }
    const key = normalizeWindowsPathEntry(entry);
    if (seen.has(key)) { dropped.push(entry); continue; }    // 중복
    seen.add(key);
    kept.push(entry);
  }
  const target = binDir ? normalizeWindowsPathEntry(binDir) : "";
  if (target && !seen.has(target)) kept.unshift(String(binDir));
  const value = kept.join(";");
  return { value, changed: value !== before, dropped };
}

/** 사람에게 알려야 할 만큼 PATH 가 긴가(#2172). 넘으면 조용히 넘기지 않는다 — 넘어가면 다음 사람이 반나절을 쓴다. */
export const WINDOWS_USER_PATH_WARN_CHARS = 1800;

/**
 * 윈도우의 **PATH 다시 읽기**(#2172) — 맥의 `로그인 셸에 물어보기`에 대응하는 자리. 순수.
 *
 * 왜 필요한가: 종전 주석은 *"Windows 는 GUI 도 레지스트리(머신+사용자) PATH 를 받으므로 손대지 않는다"* 였다.
 *  그 전제는 **기동 시점에만** 참이다 — 윈도우 프로세스는 그때의 환경 블록을 스냅샷으로 받고, 그 뒤 PATH 가
 *  바뀌어도(하네스를 나중에 깔거나, 오염된 PATH 를 정리하거나) `WM_SETTINGCHANGE` 를 처리하지 않는 Node·Electron 은
 *  **영원히 모른다**. 실측(2026-08-28): PATH 를 고쳤는데도 상시구동 중이던 노드 에이전트는 계속 옛 PATH 로
 *  하네스를 못 찾아 `["shell"]` 만 보고했다 — 재시작해도 런처가 옛 환경을 물려주면 그대로다.
 *
 * 순서는 윈도우의 합성 순서와 같게 **machine → user → current** 다. current 를 뒤에 두는 이유는 그것이
 *  '낡았을 수 있는 쪽'이기 때문이고, 그래도 **버리지는 않는다**(세션이 의도적으로 앞에 넣은 값이 있을 수 있다).
 *
 * @returns 합집합 문자열. 레지스트리를 못 읽었으면(둘 다 null) current 그대로 — 종전보다 나빠지지 않는다.
 */
export function mergeWindowsRegistryPath(machinePath, userPath, currentPath) {
  if (machinePath == null && userPath == null) return String(currentPath || "");
  const out = [];
  const seen = new Set();
  for (const chunk of [machinePath, userPath, currentPath]) {
    for (const raw of String(chunk || "").split(";")) {
      const entry = String(raw || "").trim();
      if (!entry) continue;
      const key = normalizeWindowsPathEntry(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  return out.join(";");
}

// fake store/unit test가 실제 레지스트리 없이 설치↔제거 의미론을 검증하는 순수 포트.
export function mutateWindowsUserPath(current, binDir, operation) {
  const before = String(current || "");
  const target = normalizeWindowsPathEntry(binDir);
  const entries = before.split(";");
  const matches = (entry) => normalizeWindowsPathEntry(entry) === target;
  if (operation === "add") {
    if (entries.some((entry) => entry && matches(entry))) return { value: before, changed: false };
    return { value: before ? `${binDir};${before}` : String(binDir), changed: true };
  }
  const next = entries.filter((entry) => !entry || !matches(entry)).join(";");
  return { value: next, changed: next !== before };
}

function windowsUserPathEffect({ binDir, operation, allowed, platform = process.platform, exec = runPowerShell }) {
  if (platform !== "win32") return { status: "not-windows", changed: false };
  if (!allowed) return { status: "denied", changed: false };

  const prefix = `$b='${escapedPs(binDir)}'; $trim=[char[]]'\\/'; $bn=$b.Trim().TrimEnd($trim).Replace('/','\\'); `
    + `$p=[Environment]::GetEnvironmentVariable('PATH','User'); if(-not $p){$p=''}; `;
  const script = operation === "add"
    ? prefix
      + `$found=@($p -split ';' | Where-Object { $_ -and $_.Trim().TrimEnd($trim).Replace('/','\\') -ieq $bn }).Count -gt 0; `
      + `if(-not $found){ if($p){$c=$b+';'+$p}else{$c=$b}; `
      + `[Environment]::SetEnvironmentVariable('PATH',$c,'User'); Write-Output 'changed' } else { Write-Output 'unchanged' }`
    : prefix
      + `$c=(@($p -split ';' | Where-Object { -not $_ -or $_.Trim().TrimEnd($trim).Replace('/','\\') -ine $bn }) -join ';'); `
      + `if($c -ne $p){ [Environment]::SetEnvironmentVariable('PATH',$c,'User'); Write-Output 'changed' } else { Write-Output 'unchanged' }`;

  const result = exec(script);
  if (result?.status !== 0) return { status: "failed", changed: false };
  const changed = String(result.stdout || "").includes("changed")
    && !String(result.stdout || "").includes("unchanged");
  return { status: changed ? "changed" : "unchanged", changed };
}

export function addWindowsUserPath(binDir, options = {}) {
  return windowsUserPathEffect({ binDir, operation: "add", allowed: hostEffectsAllowed(), ...options });
}

export function removeWindowsUserPath(binDir, options = {}) {
  return windowsUserPathEffect({ binDir, operation: "remove", allowed: hostEffectsAllowed(), ...options });
}

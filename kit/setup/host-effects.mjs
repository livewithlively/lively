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
import { existsSync, readdirSync } from "node:fs";
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
const inside = (file, root) => {
  if (!file || !root) return false;
  const f = pathKey(resolve(file)), r = pathKey(resolve(root));
  return f === r || f.startsWith(r.endsWith(sep) ? r : r + sep);
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
  if (name === "node" && (pathKey(resolved) === pathKey(process.execPath)
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

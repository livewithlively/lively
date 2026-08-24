// 영속 머신 상태에 닿는 설치/제거 부수효과의 단일 경계.
//
// 기본은 deny다. HOME/LIVELY_HOME 같은 경로 리다이렉트는 레지스트리·브라우저·작업 스케줄러를
// 격리하지 못하므로 테스트 여부를 추론하는 신호로 쓰지 않는다. 사람용 오케스트레이터와 disposable
// host-effect CI만 명시적으로 capability를 넘긴다.
import { spawnSync } from "node:child_process";

export const HOST_EFFECTS_ALLOW_FLAG = "--allow-host-effects";

export function hostEffectsAllowed({ args = process.argv.slice(2), env = process.env } = {}) {
  return args.includes(HOST_EFFECTS_ALLOW_FLAG) || env.LIVELY_HOST_EFFECTS === "allow";
}

const runPowerShell = (script) => spawnSync(
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

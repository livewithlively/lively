// 노드 상시 연결의 전제 — **그 PC 가 자지 않아야 한다** (#1849).
//
// 왜 필요한가 (2026-08-23 실측, `haruui-macbookair`):
//  게이트웨이 로그 24시간치에서 **연결 유지 56~64초 · 재연결 간격 3583~3591초(≈1시간)** 가 반복됐다.
//  재연결 백오프 상한은 30초(agent.ts BACKOFF_MAX_MS)라, 프로세스가 깨어 있었다면 30초 안에 다시 붙어야 한다.
//  1시간 공백은 "머신이 네트워크에서 사라진 상태" 로만 설명된다 — macOS 유지보수 깨어남(dark wake) 창에서만
//  잠깐 붙었다가 다시 잠든 것이다. 웹에서는 그저 "이 노드가 연결돼 있지 않습니다" 로만 보였다.
//  ★ 좀비(#1541)와 다르다: 좀비는 재연결 로그 자체가 안 남는다. #1541 은 절전을 기정사실로 두고 **빨리 재연결**
//   하는 축(감지·복구)이었고, 이 파일은 그 앞 단계 — **애초에 자지 않게** 하는 축이다.
//
// 왜 CLI(plist/작업 스케줄러)가 아니라 **에이전트 안**인가:
//  에이전트 번들은 게이트웨이가 서빙하고 노드가 hello 때 지문을 비교해 스스로 갱신한다(#1713).
//  즉 여기 넣으면 **게이트웨이 배포만으로 이미 등록된 노드 전체에 전파**된다. 상시화 정의(plist·XML)를 고치면
//  사용자가 `lively node --daemon` 을 다시 실행해야만 적용된다 — 이미 자고 있는 노드에는 영영 닿지 않는다.
//
// 설계 계약 (플랫폼 공통 — 이 넷은 맥·윈도우가 같아야 한다):
//  ① **권한 상승 없음** — sudo/UAC 를 요구하지 않는다. 요구하면 무인 설치가 막히고, 남의 PC 전역 전원 설정을
//     말없이 바꾸는 건 우리가 할 일이 아니다(그건 명시적 동의를 받는 `lively node keepawake --force` 의 몫).
//  ② **프로세스 수명 한정** — 에이전트가 사는 동안만 억제하고 죽으면 자동 해제된다(시스템 설정 영구 변경 없음).
//     에이전트가 죽어 있는 동안의 잠자기는 막을 이유도 없다 — 어차피 노드가 안 붙는다.
//  ③ **AC 전원일 때만** — 배터리로 도는 노트북을 깨워 두면 배터리를 태운다. macOS `caffeinate -s` 는 이 시맨틱이
//     명령 자체에 있고(man: "valid only when system is running on AC power"), Windows 는 우리가 전원 상태를
//     주기적으로 보고 같은 규칙을 흉내낸다(그쪽 API 엔 전원 조건이 없다).
//  ④ **디스플레이는 재운다** — 화면이 꺼지는 건 막지 않는다(막을 이유가 없고, 사용자가 싫어한다).
//
// 못 막는 구멍 — 조용히 실패하지 않고 **상태로 보고**한다(hello.keepAwake → 게이트웨이 → CLI·웹·앱 안내):
//  · macOS 뚜껑 닫기(clamshell): power assertion 으로 막히지 않는다 → `sudo pmset -a disablesleep 1` 필요.
//  · 배터리 사용 중: 위 ③ 에 의해 **의도적으로** 안 막는다.
//  · Windows modern standby(S0): ES_SYSTEM_REQUIRED 가 무시될 수 있다 → 전원 옵션 변경 필요.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** 억제 수단 — 무엇으로 막고 있나(표시·진단용 키. UI 문구는 표시하는 쪽이 만든다). */
export type KeepAwakeMethod = "caffeinate" | "win-execution-state";

/** 자동으로는 못 막는 구멍(키) — 사용자에게 무엇을 더 해야 하는지 말하기 위한 목록. */
export type KeepAwakeGap = "clamshell" | "battery" | "modern-standby";

export interface KeepAwakeStatus {
  /** 억제를 실제로 걸었나. false 면 method=null 이고 reason 에 이유가 있다. */
  active: boolean;
  method: KeepAwakeMethod | null;
  /** 이 플랫폼에서 자동으로 막지 못하는 구멍 — 안내(②)의 입력. */
  gaps: KeepAwakeGap[];
  /** active=false 인 이유(미지원 OS·수단 부재). 사람이 읽는 짧은 키. */
  reason?: "unsupported-platform" | "tool-missing" | "spawn-failed";
}

export interface KeepAwakeSpec {
  cmd: string;
  args: string[];
  method: KeepAwakeMethod;
  gaps: KeepAwakeGap[];
}

// SetThreadExecutionState 플래그(winbase.h). PowerShell 에서 0x80000000 은 Int32 로 읽히면 음수가 되어
//  uint 파라미터 바인딩이 깨진다 → **미리 합쳐 10진수 uint32 리터럴로** 넘긴다(아래 winKeepAwakeScript).
export const ES_CONTINUOUS = 0x80000000;        // 2147483648 — "이 상태를 계속 유지"
export const ES_SYSTEM_REQUIRED = 0x00000001;   // 1          — "시스템은 깨어 있어야 함"(디스플레이는 별개)
/** 억제 ON  = ES_CONTINUOUS | ES_SYSTEM_REQUIRED */
export const WIN_STATE_ON = (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0;   // 2147483649
/** 억제 OFF = ES_CONTINUOUS 단독(누적 플래그 해제) */
export const WIN_STATE_OFF = ES_CONTINUOUS >>> 0;                          // 2147483648

/** 전원 상태 재확인 주기(Windows). macOS 는 caffeinate 가 커널 쪽에서 알아서 판단한다. */
export const WIN_POLL_MS = 60_000;

/**
 * Windows 억제 스크립트(순수 — 테스트 seam).
 *
 * ⚠ 이 표면은 mac/linux CI 에서 **한 번도 실행되지 않는다**(#1510 §5 규율) → 생김새라도 테스트로 못박는다.
 *  계약:
 *   ① `SetThreadExecutionState` 는 **스레드** 단위라 그 스레드가 살아 있어야 유지된다 → 루프가 같은 파이프라인에서 돈다.
 *   ② 부모(에이전트) pid 를 폴링해 사라지면 **억제를 풀고 종료**한다 — 부모가 SIGKILL 로 죽어도 고아가 남지 않는다.
 *      (`Wait-Process` 를 쓰지 않는 이유: 다른 세션의 프로세스에는 권한 오류를 내는 경우가 있어 조용히 죽는다.)
 *   ③ 배터리로 내려가면 억제를 **푼다**(계약 ③) — Win32_Battery.BatteryStatus=1 이 '방전 중'(AC 미연결)이다.
 *      배터리 클래스가 없으면 데스크톱 = 항상 AC 로 본다.
 *   ④ 본문은 **ASCII 로만** 쓴다 — -EncodedCommand 로 넘기지만, 진단할 때 사람이 콘솔에 붙여 넣어도 안 깨지게.
 */
export function winKeepAwakeScript(ppid: number, pollMs: number = WIN_POLL_MS): string {
  const sig = '[DllImport("kernel32.dll", SetLastError=true)] public static extern uint SetThreadExecutionState(uint f);';
  const sleepSec = Math.max(1, Math.round(pollMs / 1000));
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$api=Add-Type -MemberDefinition '${sig}' -Name KeepAwake -Namespace Lively -PassThru`,
    `$ON=[uint32]${WIN_STATE_ON}`,
    `$OFF=[uint32]${WIN_STATE_OFF}`,
    "try{",
    "while($true){",
    `if(-not (Get-Process -Id ${ppid} -ErrorAction SilentlyContinue)){break}`,
    "$b=@(Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue)",
    "$onBattery=($b.Count -gt 0) -and (@($b | Where-Object {$_.BatteryStatus -eq 1}).Count -gt 0)",
    "if($onBattery){[void]$api::SetThreadExecutionState($OFF)}else{[void]$api::SetThreadExecutionState($ON)}",
    `Start-Sleep -Seconds ${sleepSec}`,
    "}",
    "}finally{[void]$api::SetThreadExecutionState($OFF)}",
  ].join("; ");
}

/** PowerShell 실행파일 — 훅·데몬의 빈약한 PATH 를 대비해 절대경로 우선(#1510 §6 — tar.exe 와 같은 사고 방지). */
export function winPowerShellBin(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot || env.windir || "C:\\Windows";
  const abs = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(abs) ? abs : "powershell.exe";
}

/**
 * 이 플랫폼에서 무엇으로 잠자기를 막을지 결정한다(순수 — 부작용 없음. 테스트 seam).
 *
 * @param platform  process.platform
 * @param ppid      감시 대상(=에이전트) pid. 이 프로세스가 끝나면 억제도 풀린다.
 * @param deps.exists  파일 존재 확인(테스트에서 주입) — 실제로는 fs.existsSync
 */
export function keepAwakeSpec(
  platform: NodeJS.Platform,
  ppid: number,
  deps: { exists?: (p: string) => boolean; env?: NodeJS.ProcessEnv } = {},
): KeepAwakeSpec | null {
  const exists = deps.exists ?? existsSync;
  if (platform === "darwin") {
    // `-s` = 시스템 잠자기 방지(AC 전원에서만 유효 — 계약 ③ 이 명령 자체에 들어 있다).
    // `-w` = 그 pid 가 끝날 때까지만. 디스플레이 잠자기(`-d`)는 **일부러 안 건다**(계약 ④).
    const bin = "/usr/bin/caffeinate";
    if (!exists(bin)) return null;   // macOS 기본 동봉이라 사실상 없지만, 없으면 exec 실패로 에이전트를 죽일 수 없다
    return { cmd: bin, args: ["-s", "-w", String(ppid)], method: "caffeinate", gaps: ["clamshell", "battery"] };
  }
  if (platform === "win32") {
    // -EncodedCommand(UTF-16LE base64) — 인용 지옥을 통째로 피한다. 스크립트에 큰따옴표·괄호가 있어
    //  평문으로 넘기면 cmd/Node 의 인자 이스케이프와 겹쳐 아주 깨지기 쉽다(#1541 에서 .cmd 로 겪은 부류).
    const b64 = Buffer.from(winKeepAwakeScript(ppid), "utf16le").toString("base64");
    return {
      cmd: winPowerShellBin(deps.env),
      args: ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", b64],
      method: "win-execution-state",
      gaps: ["modern-standby", "battery"],
    };
  }
  // linux — 서버는 애초에 잠들지 않고, 데스크톱 리눅스 노드는 아직 실사용이 없다. 억제를 흉내내느니
  //  **안 한다고 정직하게 보고**한다(gaps 로 안내가 나가고, 필요해지면 systemd-inhibit 로 채우면 된다).
  return null;
}

export interface KeepAwakeHandle {
  status: KeepAwakeStatus;
  /** 억제 해제(에이전트 종료 경로). 자식이 이미 죽었으면 무해. */
  stop(): void;
}

/**
 * 잠자기 억제를 건다. 실패는 **비치명** — 노드는 억제 없이도 돌아야 한다(억제는 부가 기능이지 전제가 아니다).
 *
 * @param onLog  로깅 훅(테스트에서 주입). 에이전트는 logger.info/warn 을 넘긴다.
 */
export function startKeepAwake(
  opts: {
    platform?: NodeJS.Platform;
    ppid?: number;
    spawnFn?: typeof spawn;
    exists?: (p: string) => boolean;
    env?: NodeJS.ProcessEnv;
    onLog?: (level: "info" | "warn", msg: string, extra?: Record<string, unknown>) => void;
  } = {},
): KeepAwakeHandle {
  const platform = opts.platform ?? process.platform;
  const ppid = opts.ppid ?? process.pid;
  const spawnFn = opts.spawnFn ?? spawn;
  const log = opts.onLog ?? (() => { /* noop */ });

  const spec = keepAwakeSpec(platform, ppid, { exists: opts.exists, env: opts.env });
  if (!spec) {
    const reason: KeepAwakeStatus["reason"] = platform === "darwin" ? "tool-missing" : "unsupported-platform";
    log("info", "잠자기 억제 미적용", { platform, reason });
    return { status: { active: false, method: null, gaps: [], reason }, stop: () => { /* noop */ } };
  }

  let child: ChildProcess | null = null;
  try {
    // stdio 무시 · unref — 이 자식이 에이전트의 이벤트 루프를 잡으면 안 된다(에이전트 종료를 막는다).
    //  detached 는 쓰지 않는다: 부모가 정상 종료하면 같이 사라지는 편이 낫고, 강제 종료(SIGKILL) 케이스는
    //  자식 자신의 pid 감시(caffeinate -w · PowerShell 폴링)가 처리한다.
    child = spawnFn(spec.cmd, spec.args, { stdio: "ignore", windowsHide: true });
    child.unref();
    child.on("error", (err: Error) => log("warn", "잠자기 억제 프로세스 오류(비치명)", { err: err?.message }));
  } catch (err) {
    log("warn", "잠자기 억제 기동 실패(비치명)", { err: (err as Error)?.message, cmd: spec.cmd });
    return { status: { active: false, method: null, gaps: spec.gaps, reason: "spawn-failed" }, stop: () => { /* noop */ } };
  }

  log("info", "잠자기 억제 시작 — 이 PC 는 전원 연결 상태에서 자지 않는다", { method: spec.method, gaps: spec.gaps });
  return {
    status: { active: true, method: spec.method, gaps: spec.gaps },
    stop: () => { try { child?.kill(); } catch { /* 이미 죽었으면 무해 */ } },
  };
}

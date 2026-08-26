// 순수 단위 체크(node:assert) — 노드 잠자기 억제(#1849). 계약·근거는 keep-awake.ts 머리말.
// 실행: npm run build && node dist/node/keep-awake.test.js
//
// ★ 왜 이 표면을 이렇게까지 못박나: Windows 분기는 mac/linux CI 에서 **한 번도 실행되지 않는다**(#1510 §5).
//  실행 커버리지가 0인 표면은 계약을 테스트로 고정하지 않으면 조용히 썩는다. 그래서 스크립트는 문자열을
//  베끼는 대신 **의미를 뽑아** 단언한다(플래그는 숫자로 파싱해 상수와 대조 — 문구를 다듬어도 안 깨진다).
// 사양·엣지 표: 스크래치패드 spec-keep-awake.md (행 번호 = 아래 케이스의 E<n>)
import assert from "node:assert/strict";
import {
  keepAwakeSpec, startKeepAwake, winKeepAwakeScript, winPowerShellBin,
  WIN_STATE_ON, WIN_STATE_OFF, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
} from "./keep-awake.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const yes = (): boolean => true;
const no = (): boolean => false;

/** 스텁 spawn — 무엇이 실제로 실행됐는지(argv)를 남긴다. 문구가 아니라 이 로그로 단언한다. */
function spawnSpy(): {
  calls: Array<{ cmd: string; args: string[] }>;
  readonly unrefs: number; readonly kills: number;
  fn: typeof import("node:child_process").spawn;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let unrefs = 0, kills = 0;
  const fn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return { unref: () => { unrefs++; }, on: () => { /* noop */ }, kill: () => { kills++; } };
  }) as unknown as typeof import("node:child_process").spawn;
  return { calls, fn, get unrefs() { return unrefs; }, get kills() { return kills; } };
}
/** 억제 스크립트에서 SetThreadExecutionState 에 넘기는 값을 **숫자로** 뽑는다(문자열 미러링 회피). */
function parseStates(script: string): { on: number | null; off: number | null } {
  const grab = (name: string): number | null => {
    const m = new RegExp(`\\$${name}=\\[uint32\\](\\d+)`).exec(script);
    return m ? Number(m[1]) : null;
  };
  return { on: grab("ON"), off: grab("OFF") };
}
/** 폴링 간격(초)을 뽑는다. */
function parseSleepSec(script: string): number | null {
  const m = /Start-Sleep -Seconds (\d+)/.exec(script);
  return m ? Number(m[1]) : null;
}

// ── macOS (E1~E4, E22) ─────────────────────────────────────────────────────────
t("E1 macOS — 시스템 잠자기 방지를 AC 한정으로, 에이전트 pid 수명에 묶어 건다", () => {
  const spec = keepAwakeSpec("darwin", 4242, { exists: yes });
  assert.ok(spec, "억제 수단이 결정돼야 한다");
  assert.equal(spec.cmd, "/usr/bin/caffeinate");
  assert.deepEqual(spec.args, ["-s", "-w", "4242"]);   // -s = AC 한정 시스템 잠자기 방지, -w = pid 수명
  assert.equal(spec.method, "caffeinate");
});
t("E2 macOS · 도구 없음 — 아무것도 실행하지 않는다(없는 파일 실행은 억제가 아니라 잡음이다)", () => {
  assert.equal(keepAwakeSpec("darwin", 1, { exists: no }), null);
});
t("E3 ★ 계약 4 — 디스플레이 잠자기는 막지 않는다", () => {
  const spec = keepAwakeSpec("darwin", 1, { exists: yes });
  assert.ok(!spec?.args.includes("-d"), "-d 는 화면까지 켜 둔다 — 사용자가 싫어한다");
});
t("E4 ★ 계약 3 — 배터리에서도 유효한 억제(-i)는 걸지 않는다", () => {
  const spec = keepAwakeSpec("darwin", 1, { exists: yes });
  assert.ok(!spec?.args.includes("-i"), "-i(idle)는 전원 조건이 없어 배터리를 태운다");
});
t("E22 macOS 가 못 막는 구멍을 신고한다 — 뚜껑 닫기·배터리", () => {
  assert.deepEqual([...(keepAwakeSpec("darwin", 1, { exists: yes })?.gaps ?? [])].sort(), ["battery", "clamshell"]);
});

// ── Windows (E5~E14, E23~E25) ──────────────────────────────────────────────────
t("E5 Windows — 권한 상승 없이 실행상태 API 로 억제(계약 1)", () => {
  const spec = keepAwakeSpec("win32", 77, { exists: yes, env: { SystemRoot: "C:\\Windows" } });
  assert.ok(spec);
  assert.equal(spec.method, "win-execution-state");
  assert.match(spec.cmd, /powershell\.exe$/i);
  assert.ok(!spec.args.some((a) => /runas|-Verb/i.test(a)), "권한 상승을 요구하면 무인 설치가 막힌다");
});
t("E6 ★ 억제 스크립트가 실행기에 손실 없이 전달된다 — 디코드하면 원본과 완전히 같다", () => {
  const spec = keepAwakeSpec("win32", 77, { exists: yes });
  const i = spec?.args.indexOf("-EncodedCommand") ?? -1;
  assert.ok(i >= 0, "인용 지옥을 피하려면 인코딩 전달이어야 한다");
  const decoded = Buffer.from(String(spec?.args[i + 1]), "base64").toString("utf16le");
  assert.equal(decoded, winKeepAwakeScript(77), "PowerShell 은 UTF-16LE base64 를 기대한다");
});
t("E7 ★ 억제/해제 플래그가 부호 없는 32비트로 전달된다 — 음수로 읽히면 API 바인딩이 깨진다", () => {
  const { on, off } = parseStates(winKeepAwakeScript(1));
  assert.equal(on, WIN_STATE_ON);
  assert.equal(off, WIN_STATE_OFF);
  assert.equal(WIN_STATE_ON, (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0);
  assert.equal(WIN_STATE_OFF, ES_CONTINUOUS >>> 0);
  assert.ok(on !== null && on > 0 && off !== null && off > 0, "양수여야 한다(0x… 리터럴은 Int32 로 읽혀 음수가 된다)");
});
t("E8 ★ 계약 2 — 부모(에이전트)가 사라지면 억제 프로세스도 끝난다", () => {
  const s = winKeepAwakeScript(31337);
  assert.ok(s.includes("Get-Process -Id 31337"), "부모 pid 를 실제로 감시해야 한다");
  assert.ok(s.includes("break"), "사라지면 루프를 빠져나가야 한다");
  assert.ok(!s.includes("Wait-Process"), "Wait-Process 는 다른 세션 프로세스에 권한 오류를 내고 조용히 죽는다");
});
t("E9 ★ 계약 2 — 루프가 어떻게 끝나든 억제를 해제하고 끝난다", () => {
  const s = winKeepAwakeScript(1);
  const fin = s.indexOf("}finally{");
  assert.ok(fin > 0, "finally 가 있어야 예외·break 어느 쪽으로 끝나도 해제된다");
  assert.ok(s.indexOf("$OFF", fin) > fin, "finally 안에서 해제값을 걸어야 한다");
});
t("E10 ★ 계약 3 — 배터리로 전환되면 억제를 푼다", () => {
  const s = winKeepAwakeScript(1);
  assert.ok(s.includes("Win32_Battery"), "전원 상태를 실제로 물어야 한다");
  assert.ok(/BatteryStatus -eq 1/.test(s), "BatteryStatus=1 이 '방전 중'(AC 미연결)이다");
  assert.ok(/if\(\$onBattery\)\{\[void\]\$api::SetThreadExecutionState\(\$OFF\)\}/.test(s),
    "배터리면 해제값을 걸어야 한다");
});
t("E11 Windows · 배터리 없음(데스크톱) — AC 로 간주해 억제를 유지한다", () => {
  const s = winKeepAwakeScript(1);
  assert.ok(s.includes("($b.Count -gt 0)"), "배터리 클래스 부재를 먼저 보지 않으면 데스크톱이 억제에서 빠진다");
  assert.ok(/else\{\[void\]\$api::SetThreadExecutionState\(\$ON\)\}/.test(s));
});
t("E12 스크립트는 ASCII 전용 — 사람이 콘솔에 붙여 진단해도 안 깨진다(#1541 cp949 교훈)", () => {
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x00-\x7F]/.test(winKeepAwakeScript(1)), "비ASCII 문자가 섞이면 안 된다");
});
t("E13/E14 실행기 경로 — 절대경로가 있으면 그것을, 없으면 이름으로 폴백(던지지 않는다)", () => {
  // 이 CI 는 mac 이라 Windows 절대경로가 존재하지 않는다 → 폴백 경로가 실제로 도는 것을 본다.
  assert.equal(winPowerShellBin({ SystemRoot: "C:\\Windows" }), "powershell.exe");
  // 존재하는 루트를 주면 그 아래 절대경로를 조립해 본다(여기서도 파일은 없으므로 폴백) — 던지지 않는 것이 계약.
  assert.equal(typeof winPowerShellBin({ SystemRoot: "/" }), "string");
});
t("E23 Windows 가 못 막는 구멍을 신고한다 — modern standby·배터리", () => {
  assert.deepEqual([...(keepAwakeSpec("win32", 1, { exists: yes })?.gaps ?? [])].sort(), ["battery", "modern-standby"]);
});
t("E24 ★ 새 변수 부재 — 시스템 루트 환경변수가 아예 없어도 던지지 않고 경로를 만든다", () => {
  assert.equal(typeof winPowerShellBin({}), "string");
  const spec = keepAwakeSpec("win32", 1, { exists: yes, env: {} });
  assert.ok(spec && spec.cmd.length > 0, "환경이 비어도 실행 후보는 나와야 한다");
});
t("E25 ★ 경계값 — 폴링 주기가 1초 미만이면 최소 1초로 올린다(0초면 CPU 를 태운다)", () => {
  assert.equal(parseSleepSec(winKeepAwakeScript(1, 0)), 1);
  assert.equal(parseSleepSec(winKeepAwakeScript(1, 400)), 1);       // 0.4초 → 반올림 0 → 최소 1
  assert.equal(parseSleepSec(winKeepAwakeScript(1, 60_000)), 60);
});

// ── 그 외 OS · 기동/정지 (E15~E21) ─────────────────────────────────────────────
t("E15 그 외 OS — 억제하지 않고 '안 한다'고 보고한다(흉내내지 않는다)", () => {
  assert.equal(keepAwakeSpec("linux", 1, { exists: yes }), null);
});
t("E16 기동 — 결정된 명령 그대로 실행하고, 에이전트 종료를 막지 않는다", () => {
  const spy = spawnSpy();
  const h = startKeepAwake({ platform: "darwin", ppid: 9, spawnFn: spy.fn, exists: yes });
  assert.equal(h.status.active, true);
  assert.equal(h.status.method, "caffeinate");
  assert.deepEqual(spy.calls, [{ cmd: "/usr/bin/caffeinate", args: ["-s", "-w", "9"] }]);   // 배선 확인
  assert.equal(spy.unrefs, 1, "unref 를 빠뜨리면 이 자식이 에이전트 종료를 붙잡는다");
});
t("E17 ★ 기동 실패 — 예외를 밖으로 던지지 않는다. 노드는 계속 돈다", () => {
  const boom = (() => { throw new Error("ENOENT"); }) as unknown as typeof import("node:child_process").spawn;
  const h = startKeepAwake({ platform: "darwin", ppid: 1, spawnFn: boom, exists: yes });
  assert.equal(h.status.active, false);
  assert.equal(h.status.reason, "spawn-failed");
  assert.deepEqual(h.status.gaps, ["clamshell", "battery"], "실패해도 안내 입력은 그대로 나가야 한다");
});
t("E18 미지원 OS 기동 — 사유가 '미지원'으로 구분되고, 아무것도 실행하지 않는다", () => {
  const spy = spawnSpy();
  const h = startKeepAwake({ platform: "linux", ppid: 1, spawnFn: spy.fn, exists: yes });
  assert.equal(h.status.active, false);
  assert.equal(h.status.reason, "unsupported-platform");
  assert.equal(spy.calls.length, 0, "결정이 null 인데 무언가 실행하면 안 된다");
});
t("E19 macOS · 도구 부재 기동 — 사유가 '도구 없음'으로 구분된다(미지원과 다르다)", () => {
  const spy = spawnSpy();
  const h = startKeepAwake({ platform: "darwin", ppid: 1, spawnFn: spy.fn, exists: no });
  assert.equal(h.status.active, false);
  assert.equal(h.status.reason, "tool-missing");
  assert.equal(spy.calls.length, 0);
});
t("E20 정지 — 억제 프로세스를 끝낸다", () => {
  const spy = spawnSpy();
  startKeepAwake({ platform: "darwin", ppid: 1, spawnFn: spy.fn, exists: yes }).stop();
  assert.equal(spy.kills, 1);
});
t("E21 기동 실패 뒤 정지 — 던지지 않는다", () => {
  const boom = (() => { throw new Error("ENOENT"); }) as unknown as typeof import("node:child_process").spawn;
  startKeepAwake({ platform: "darwin", ppid: 1, spawnFn: boom, exists: yes }).stop();
});

console.log(`\n${pass} checks passed`);

// #2172 — 윈도우 PATH 를 근본적으로. 사양·엣지 표는 스크래치패드 spec3.md(A 9행 · B 5행), 아래 번호가 그 행이다.
//
//  ── 왜 이 파일이 생겼나 (실측 2026-08-28, 윤상민 PC `amorite`) ──
//   User PATH 84개 / 6224자 중 **70개가 삭제된 테스트 임시홈**이었다. 그런데 윈도우는 사용자 PATH 가 너무 길면
//   **뒤를 자르는 게 아니라 통째로 안 합친다** — 그 PC 의 프로세스 PATH 는 616자(시스템만)였고
//   `.lively\bin`·`.local\bin`·`Roaming\npm`·`agy\bin` 이 어느 프로세스에도 안 보였다. 그래서
//   `lively`·`claude` 미검출 → 노드 하네스 탐지 5종 전멸(`agent_harnesses=["shell"]`) → 화면엔 "AI 가 없어요".
//   정리 후 14개/727자 → 프로세스 PATH 1344자 → 전부 복구.
//
//  🔴 두 방향의 값이 다르다:
//   · 너무 많이 버리면 → 사용자의 정상 경로가 사라진다. **되돌릴 수 없고 원인도 안 보인다.**
//   · 너무 적게 버리면 → 오늘의 사고가 반복된다(조용히 자라다 어느 날 PATH 가 통째로 무효).
//   그래서 버리는 기준을 **"TEMP 아래인데 지금 없다"** 로 좁게 잡고, 그 좁음을 아래 표가 지킨다.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { sanitizeWindowsUserPath, mergeWindowsRegistryPath, isDeadWindowsTempEntry } from "./host-effects.mjs";

const TEMP = "C:\\Users\\amorite\\AppData\\Local\\Temp";
const REAL = "C:\\Users\\amorite\\.local\\bin";
const BIN = "C:\\Users\\amorite\\.lively\\bin";
/** 실제 사고의 지문 그대로 — TEMP 아래이고 지금 존재하지 않는 것만 죽은 것으로 본다. */
const dead = (alive = []) => (entry) =>
  entry.toLowerCase().includes("\\appdata\\local\\temp\\") && !alive.includes(entry);
const ids = (v) => v.split(";").filter(Boolean);

// ── A. sanitizeWindowsUserPath ──────────────────────────────────────────────

// A1) 이 사고의 자리 — 죽은 임시경로만 빠지고 정상 경로는 남는다.
test("A1 죽은 임시경로는 버리고 정상 경로는 남긴다", () => {
  const r = sanitizeWindowsUserPath(`${TEMP}\\codex-wiring-test-x\\home\\.lively\\bin;${REAL}`, "", { isDeadTempEntry: dead() });
  assert.deepEqual(ids(r.value), [REAL]);
  assert.equal(r.changed, true);
  assert.equal(r.dropped.length, 1);
});

// A2) 지금 쓰고 있는 임시 도구를 뺏지 않는다 — '존재하지 않는다'가 조건의 절반이다.
test("A2 살아 있는 임시경로는 남긴다", () => {
  const live = `${TEMP}\\my-tool\\bin`;
  const r = sanitizeWindowsUserPath(`${live};${REAL}`, "", { isDeadTempEntry: dead([live]) });
  assert.deepEqual(ids(r.value), [live, REAL]);
  assert.equal(r.changed, false);
});

// A3) 이동식·네트워크 드라이브 — 지금 없어도 사용자의 정상 경로다. 여기서 버리면 되돌릴 수 없다.
test("A3 TEMP 밖이면 존재하지 않아도 남긴다", () => {
  const r = sanitizeWindowsUserPath(`E:\\usb\\bin;${REAL}`, "", { isDeadTempEntry: dead() });
  assert.deepEqual(ids(r.value), ["E:\\usb\\bin", REAL]);
});

// A4·A5) 중복 접기 — host-effects 의 normalize 와 같은 규칙(대소문자·후행 슬래시 무시).
test("A4 같은 경로가 두 번이면 하나만 남는다", () => {
  assert.deepEqual(ids(sanitizeWindowsUserPath(`${REAL};${REAL}`, "").value), [REAL]);
});
test("A5 대소문자·후행 역슬래시만 다른 중복도 접는다", () => {
  const r = sanitizeWindowsUserPath(`${REAL};${REAL.toUpperCase()}\\`, "");
  assert.deepEqual(ids(r.value), [REAL]);
});

// A6) 무한 증식 차단 — 이미 있으면 앞에 또 붙이지 않는다(종전 동작 유지).
test("A6 binDir 이 이미 있으면 다시 앞에 붙이지 않는다", () => {
  const r = sanitizeWindowsUserPath(`${REAL};${BIN}`, BIN);
  assert.deepEqual(ids(r.value), [REAL, BIN]);
});

// A7) 설치의 목적 — 없으면 맨 앞에 한 번.
test("A7 binDir 이 없으면 맨 앞에 한 번 넣는다", () => {
  assert.deepEqual(ids(sanitizeWindowsUserPath(REAL, BIN).value), [BIN, REAL]);
});

// A8) `;;` 정리 — 빈 조각이 남으면 그 자체가 다음 파서의 함정이다.
test("A8 빈 항목은 사라진다", () => {
  assert.deepEqual(ids(sanitizeWindowsUserPath(`${REAL};;;`, "").value), [REAL]);
});

// A9) 경계 — 전부 죽은 임시경로면 binDir 하나만 남는다(빈 PATH 를 쓰지 않는다).
test("A9 전부 죽은 임시경로여도 binDir 은 남는다", () => {
  const junk = [1, 2, 3].map((i) => `${TEMP}\\t${i}\\home\\.lively\\bin`).join(";");
  assert.deepEqual(ids(sanitizeWindowsUserPath(junk, BIN, { isDeadTempEntry: dead() }).value), [BIN]);
});

// ── A'. isDeadWindowsTempEntry — **무엇을 버릴지 정하는 진짜 정책**. 위 A 표는 접기·순서만 봤다. ──
//  이 판정이 헐거우면 사용자의 정상 경로가 사라지고, 그건 되돌릴 수도 원인을 볼 수도 없다.
const T = ["C:\\Users\\amorite\\AppData\\Local\\Temp"];

// A10) 이 사고의 지문 — TEMP 아래 + 지금 없음. **둘 다** 참일 때만 버린다.
test("A10 TEMP 아래인데 존재하지 않으면 죽은 것", () => {
  assert.equal(isDeadWindowsTempEntry(`${TEMP}\\codex-wiring-test-x\\home\\.lively\\bin`,
    { tempDirs: T, exists: () => false }), true);
});

// A11) 지금 쓰는 임시 도구 — TEMP 안이어도 살아 있으면 안 버린다.
test("A11 TEMP 아래여도 존재하면 안 버린다", () => {
  assert.equal(isDeadWindowsTempEntry(`${TEMP}\\live\\bin`, { tempDirs: T, exists: () => true }), false);
});

// A12) 이동식·네트워크 드라이브 — TEMP 밖은 없어도 안 버린다. 과잉 삭제를 막는 유일한 벽이다.
test("A12 TEMP 밖은 존재하지 않아도 안 버린다", () => {
  assert.equal(isDeadWindowsTempEntry("E:\\usb\\bin", { tempDirs: T, exists: () => false }), false);
});

// A13) 경계 — 이름이 TEMP 로 **시작만** 하는 다른 폴더(`Tempest`)를 TEMP 아래로 오인하면 남의 폴더를 지운다.
test("A13 이름이 Temp 로 시작만 하는 폴더는 TEMP 아래가 아니다", () => {
  assert.equal(isDeadWindowsTempEntry("C:\\Users\\amorite\\AppData\\Local\\Tempest\\bin",
    { tempDirs: T, exists: () => false }), false);
});

// A14) tempDirs 를 안 주면 아무것도 안 버린다 — 모르면 손대지 않는다.
test("A14 TEMP 위치를 모르면 아무것도 버리지 않는다", () => {
  assert.equal(isDeadWindowsTempEntry(`${TEMP}\\x\\bin`, { tempDirs: [], exists: () => false }), false);
});

// ── B. mergeWindowsRegistryPath ─────────────────────────────────────────────

// B1) 보강의 목적 — 프로세스가 뜬 뒤에 PATH 에 들어온 항목을 되찾는다.
test("B1 레지스트리에만 있는 항목이 결과에 들어온다", () => {
  assert.ok(ids(mergeWindowsRegistryPath("C:\\Windows", REAL, "C:\\Windows")).includes(REAL));
});

// B2) 있던 걸 뺏지 않는다 — 세션이 의도적으로 앞에 넣은 값이 있을 수 있다.
test("B2 현재 PATH 에만 있는 항목도 남는다", () => {
  assert.ok(ids(mergeWindowsRegistryPath("C:\\Windows", "", "C:\\only-here")).includes("C:\\only-here"));
});

// B3) 중복 제거 — 합집합이지 이어붙이기가 아니다(이어붙이면 그게 오늘의 사고를 다시 만든다).
test("B3 양쪽에 있으면 한 번만 남는다", () => {
  assert.equal(ids(mergeWindowsRegistryPath(REAL, REAL, REAL)).filter((p) => p === REAL).length, 1);
});

// B4) 못 읽었으면 종전 그대로 — 보강이 실패해서 더 나빠지는 일은 없어야 한다.
test("B4 레지스트리를 못 읽으면(둘 다 null) 현재 PATH 를 **손대지 않는다**", () => {
  //  중복·빈 조각이 있어도 그대로 돌려줘야 한다 — 보강이 실패한 자리에서 값을 바꾸면
  //  '종전보다 나빠지지 않는다'가 깨진다(정규화가 사용자의 의도적 중복·순서를 지운다).
  const messy = "C:\\Windows;;C:\\x;C:\\WINDOWS\\";
  assert.equal(mergeWindowsRegistryPath(null, null, messy), messy);
});

// B5) 순서 — 윈도우의 합성 순서(machine → user)와 같아야 사용자가 정한 우선순위가 보존된다.
test("B5 순서는 machine → user → current", () => {
  assert.deepEqual(ids(mergeWindowsRegistryPath("C:\\m", "C:\\u", "C:\\c")), ["C:\\m", "C:\\u", "C:\\c"]);
});

// ── W. 배선 — 순수 판정이 맞아도 **그 자리에 안 서 있으면** 오늘의 사고가 그대로 반복된다. ──
//  값이 아니라 소스 구조를 보는 이유: 고장이 "규칙이 틀렸다"가 아니라 "아무도 안 불렀다" 였다.
//  (bootstrap 은 PowerShell 이라 import 할 수 없고, cmd-node/login-path 는 win32 분기라 여기서 실행되지 않는다.)
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*(?:\/\/|#).*$/gm, "");

// W1) bootstrap 이 **무조건 앞에 붙이던** 자리가 사라졌다 — 그게 PATH 가 자란 이유였다.
test("W1 bootstrap 이 PATH 를 무조건 prepend 하지 않는다", () => {
  const ps = code(src("../cli/bootstrap.ps1"));
  assert.ok(!/\$binDir \+ ";" \+ \$uPath/.test(ps), "옛 무조건 prepend 가 남아 있다");
  assert.ok(/Test-Path -LiteralPath/.test(ps), "죽은 경로 판정이 없다");
  assert.ok(/1800/.test(ps), "길이 경고가 없다");
});

// W2) 윈도우도 PATH 를 다시 읽는다 — 두 자리 모두. 하나만 고치면 나머지 경로로 같은 증상이 난다.
test("W2 win32 에서 PATH 보강이 돈다(노드 pane · 데스크톱 앱)", () => {
  const node = code(src("../cli/cmd-node.mjs"));
  assert.ok(!/win32"\) return process\.env\.PATH \|\| "";/.test(node), "bakedNodePath 가 아직 손을 놓고 있다");
  assert.ok(/mergeWindowsRegistryPath\(machine, user/.test(node), "레지스트리 합집합을 안 쓴다");
  const desk = code(src("../../desktop/main/login-path.mjs"));
  assert.ok(!/win32"\) return null;/.test(desk), "데스크톱이 아직 win32 를 건너뛴다");
  assert.ok(/enrichPathFromWindowsRegistry/.test(desk), "윈도우 보강 경로가 없다");
});

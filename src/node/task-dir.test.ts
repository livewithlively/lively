// 위탁 작업 폴더 준비(prepareTaskDir) 단위 체크 — 실제 fs 로 검증(tmux·멤버유저 불요).
// 실행: npm run build && node dist/node/task-dir.test.js
//
// 왜 이 테스트가 있나 — 2026-07-30 고객사 A 실박스 실측:
//  위탁 태스크 2건 모두 stream.jsonl·stderr.log·exit 가 **하나도 생성되지 않은 채** 타임아웃까지 '실행 중'으로
//  매달려 있었다. 그 박스에서 헤드리스 위탁이 한 번도 성공한 적이 없었는데도 아무도 몰랐다 —
//  크론 요약의 status=ok 는 '접수 성공'이지 완료가 아니고, 실패를 적을 stderr.log 마저 같은 폴더라 못 남았다.
//  원인은 작업 폴더가 그룹 쓰기 불가(2750)였던 것. mkdir 의 mode 가 umask(022)에 깎였고,
//  워커는 다른 OS 유저라 그룹으로만 접근한다.
//
// 잠그는 정책:
//  · 결과를 쓰는 주체는 게이트웨이가 아니라 **워커(다른 uid)** 다 → 그룹 쓰기는 작동 조건이지 선택이 아니다.
//  · 그 보장은 **umask 값에 의존하면 안 된다**(박스마다 다르고 mode 를 깎는다).
//  · 공유 루트 자체는 넓히지 않는다(경계).
//  · 재시도 시 이전 종결 흔적이 남으면 시작하자마자 '가짜 완료'로 오인된다.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareTaskDir } from "./tasks.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

const mode = (p: string): number => fs.statSync(p).mode & 0o7777;
const groupCanWrite = (p: string): boolean => (mode(p) & 0o020) !== 0;
const groupCanRead = (p: string): boolean => (mode(p) & 0o040) !== 0;
const setgid = (p: string): boolean => (mode(p) & 0o2000) !== 0;

// 공유 루트 + 워크스페이스를 실제로 만든다(게이트웨이가 하는 것과 같은 모양).
async function fixture(umask: number): Promise<{ root: string; ws: string; restore: () => void }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "co-taskdir-"));
  const ws = path.join(root, "delegated", "task-9");
  const prev = process.umask(umask);
  return { root, ws, restore: () => { process.umask(prev); } };
}

// ── P1 · P2 · P3 — 권한 계약 ────────────────────────────────────────────────
await t("P1 그룹 쓰기를 깎는 umask(022) 에서도 작업 폴더를 그룹이 쓸 수 있다 (+ 그룹 상속)", async () => {
  const f = await fixture(0o022);
  try {
    const dir = await prepareTaskDir(f.ws, f.root, 9, "프롬프트");
    assert.ok(groupCanWrite(dir),
      `작업 폴더를 그룹이 못 쓰면 워커가 결과를 한 글자도 못 남긴다(실제 장애). mode=${mode(dir).toString(8)}`);
    assert.ok(setgid(dir), "그룹 상속(setgid)이 없으면 하위 산출물이 워커 개인그룹으로 떨어진다");
  } finally { f.restore(); await fsp.rm(f.root, { recursive: true, force: true }); }
});

await t("P2 작업 폴더의 상위 체인도 전부 그룹이 쓸 수 있다", async () => {
  const f = await fixture(0o022);
  try {
    const dir = await prepareTaskDir(f.ws, f.root, 9, "p");
    // dir(.lively-task/9) → .lively-task → task-9 → delegated 까지, 공유 루트 직전까지 전부.
    let cur = path.dirname(dir);
    const checked: string[] = [];
    while (cur !== f.root) {
      checked.push(cur);
      assert.ok(groupCanWrite(cur), `상위 폴더도 그룹 쓰기여야 한다: ${cur} mode=${mode(cur).toString(8)}`);
      cur = path.dirname(cur);
    }
    assert.ok(checked.length >= 3, `상위 체인을 실제로 훑었나(검사 ${checked.length}단)`);
  } finally { f.restore(); await fsp.rm(f.root, { recursive: true, force: true }); }
});

await t("P3 공유 루트 자신은 건드리지 않는다(경계 — 루트를 넓히면 안 된다)", async () => {
  const f = await fixture(0o022);
  try {
    await fsp.chmod(f.root, 0o755);            // 루트는 그룹 쓰기 없음으로 고정
    const before = mode(f.root);
    await prepareTaskDir(f.ws, f.root, 9, "p");
    assert.equal(mode(f.root), before, "공유 루트의 권한이 바뀌면 안 된다");
  } finally { f.restore(); await fsp.rm(f.root, { recursive: true, force: true }); }
});

await t("P4 프롬프트 파일을 워커(그룹)가 읽을 수 있다", async () => {
  const f = await fixture(0o022);
  try {
    const dir = await prepareTaskDir(f.ws, f.root, 9, "이 프롬프트를 워커가 cat 한다");
    const p = path.join(dir, "prompt.txt");
    assert.ok(groupCanRead(p), `워커가 프롬프트를 못 읽으면 실행 자체가 안 된다. mode=${mode(p).toString(8)}`);
    assert.equal(await fsp.readFile(p, "utf8"), "이 프롬프트를 워커가 cat 한다");
  } finally { f.restore(); await fsp.rm(f.root, { recursive: true, force: true }); }
});

// ── P5 · P6 — 재시도·멱등 ──────────────────────────────────────────────────
await t("P5 재시도 시 이전 종결·로그 흔적이 모두 제거된다(안 지우면 즉시 '가짜 완료'로 오인)", async () => {
  const f = await fixture(0o022);
  try {
    const dir = await prepareTaskDir(f.ws, f.root, 9, "1회차");
    for (const name of ["exit", "stream.jsonl", "stderr.log"]) {
      await fsp.writeFile(path.join(dir, name), "이전 시도 잔재");
    }
    await prepareTaskDir(f.ws, f.root, 9, "2회차");
    for (const name of ["exit", "stream.jsonl", "stderr.log"]) {
      assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} 이 남으면 스케줄러가 시작 즉시 완료로 오인한다`);
    }
  } finally { f.restore(); await fsp.rm(f.root, { recursive: true, force: true }); }
});

await t("P6 재실행은 멱등 — 권한은 유지되고 프롬프트만 갱신된다", async () => {
  const f = await fixture(0o022);
  try {
    const a = await prepareTaskDir(f.ws, f.root, 9, "처음");
    const m = mode(a);
    const b = await prepareTaskDir(f.ws, f.root, 9, "나중");
    assert.equal(b, a);
    assert.equal(mode(b), m, "재실행이 권한을 바꾸면 안 된다");
    assert.equal(await fsp.readFile(path.join(b, "prompt.txt"), "utf8"), "나중");
  } finally { f.restore(); await fsp.rm(f.root, { recursive: true, force: true }); }
});

// ── P7 — umask 비의존 ──────────────────────────────────────────────────────
await t("P7 더 빡센 umask(077) 에서도 그룹이 쓸 수 있다(umask 값에 의존하지 않는다)", async () => {
  const f = await fixture(0o077);
  try {
    const dir = await prepareTaskDir(f.ws, f.root, 9, "p");
    assert.ok(groupCanWrite(dir), `umask 가 무엇이든 보장돼야 한다. mode=${mode(dir).toString(8)}`);
    assert.ok(groupCanRead(path.join(dir, "prompt.txt")), "프롬프트도 마찬가지");
  } finally { f.restore(); await fsp.rm(f.root, { recursive: true, force: true }); }
});

console.log(`\n✓ 위탁 작업 폴더 단위 체크 ${pass}건 통과`);

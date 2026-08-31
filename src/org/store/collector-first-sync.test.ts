// 수집기를 켜면 **첫 수집이 그 자리에서** 시작된다 (#1631, 원준님 2026-08-31)
//
//  신고: 노션·슬랙·피그마·클릭업을 연결했는데 «만들어졌음 / 아직 안 돎» 으로 남았고, 언제 도는지는
//   주기(10분)를 보고 짐작해야 했다. *"아예 최초 1회는 강제로 바로 수집 시켜야 하는 거 아니야?"*
//
//  종전 동작: upsertCollector 가 org_cron 잡만 등록하고 끝났다. 실제 수집은 스케줄러가 알아챌 때까지
//   기다린다 — 주기가 하루(gdrive·notion full)면 그 기다림이 하루다.
//   그리고 그 기다림은 «스케줄러가 살아 있다» 는 가정에 얹혀 있다. 2026-08-31 게이트웨이가 메모리 압력으로
//   26번 재시작한 날, 그 가정은 참이 아니었다.
//
//  ⚠ 이 검사는 «켤 때 민다» 와 «이미 돈 것은 안 민다» **둘 다** 지킨다. 뒤엣것이 빠지면 설정을
//   한 글자 고칠 때마다 전체 백필이 돈다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("./collectors.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const JOB = SRC.slice(SRC.indexOf("async function syncCollectorJob"), SRC.indexOf("export async function removeCollector"));

test("① 켜는 자리에서 첫 수집을 민다", () => {
  assert.match(JOB, /if \(!up\.rows\[0\]\?\.last_run_at\) void kickFirstSync\(id, spec\.presetKey, actor\);/,
    "잡만 등록하고 끝난다 — 사람이 스케줄러를 기다려야 한다");
  assert.match(SRC, /async function kickFirstSync\(/, "미는 자리가 없다");
  assert.match(SRC, /startConnectorRun\(presetKey, \{ trigger: "manual"/, "실행을 시작하지 않는다");
});

test("② 한 번도 안 돈 것만 민다 — 저장할 때마다 백필이 돌면 안 된다", () => {
  assert.match(JOB, /RETURNING last_run_at/,
    "이미 돈 적이 있는지 물어보지 않는다 — 물어보지 않으면 매번 밀게 된다");
  //  조건 없이 미는 모양이면 실패. (`void kickFirstSync` 앞에 last_run_at 검사가 반드시 붙어 있어야 한다.)
  const kicks = [...JOB.matchAll(/(.{0,60})void kickFirstSync\(/g)].map((m) => m[1]);
  assert.equal(kicks.length, 1, `미는 자리가 ${kicks.length}군데다 — 하나여야 한다`);
  assert.match(kicks[0], /!up\.rows\[0\]\?\.last_run_at/, `조건 없이 민다: «${kicks[0].trim()}»`);
});

test("③ 끄는 길에서는 밀지 않는다(무회귀)", () => {
  const off = JOB.slice(JOB.indexOf("} else {"));
  assert.doesNotMatch(off, /kickFirstSync/, "끄면서 수집을 시작한다");
});

test("④ 켜기를 막지 않는다 — 실패는 비치명이고 기다리지 않는다", () => {
  //  ⚠ await 하면 켜기 응답이 백필을 기다린다(슬랙·클릭업은 과거 이력 전체를 훑는다).
  assert.match(JOB, /void kickFirstSync/, "await 로 부른다 — 켜기 응답이 백필에 붙잡힌다");
  const fn = SRC.slice(SRC.indexOf("async function kickFirstSync("), SRC.indexOf("자동 싱크 잡 동기"));
  assert.match(fn, /catch \(e\)/, "실패가 켜기를 깬다 — 못 밀어도 스케줄러가 결국 돌린다");
  //  층이 거꾸로 물리지 않게 동적 import 여야 한다(store → connectors 를 정적으로 얹지 않는다).
  assert.match(fn, /await import\("\.\.\/\.\.\/connectors\/run-tracker\.js"\)/,
    "정적 import 다 — store 층이 connectors 층을 모듈 적재 시점에 끌어온다");
});

// 멈춘 세션의 «없다» 걸쇠와 «멈춘 세션» 409 판정 (#5620 — web/lib/stop-latch.ts 머리말).
//  신고(2026-11-19): «재시동 걸 때 치는 말을 무시해서 두 번 쳐야 해». 세션이 멈춘 뒤 약 15초 동안 목록은 그 세션을 «살아 있다» 로
//  내는데, 대화창은 그 낡은 행으로 액자의 «없다» 를 지워 안내를 보고 친 말을 되살리기 대신 멈춘 세션의 큐에 묻었다.
//  행 이름의 번호는 사양 엣지 표(L·R)다. 화면 전체의 배선은 chat-stop-first-word-runtime.test.mjs 가 본다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.SRC_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const ok = (cond, name, detail = "") => { assert.ok(cond, `${name}${detail ? " — " + detail : ""}`); pass++; console.log(`ok  ${name}`); };
const show = (v) => JSON.stringify(v);

const tmp = mkdtempSync(path.join(tmpdir(), "stop-latch-"));
try {
  execFileSync(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "node_modules/.bin/tsc"),
    [path.join(root, "web/lib/stop-latch.ts"), "--outDir", tmp, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
    { stdio: "inherit" });
  const { latchAfterRow, stoppedCanRevive, LIST_LAG_MS } = await import(path.join(tmp, "stop-latch.js"));

  ok(typeof latchAfterRow === "function" && typeof stoppedCanRevive === "function" && LIST_LAG_MS > 0, "W 두 판정이 실제로 export 돼 이 시험이 무언가를 보고 있다");
  ok(LIST_LAG_MS >= 30_000, "W 지연창이 실측 지연(약 16초)+목록 폴링(8~16초)보다 길다", String(LIST_LAG_MS));

  const T = 1_000_000;
  const held = { gone: true, at: T, listSaw: false };

  const l1 = { gone: false, at: 0, listSaw: false };
  ok(latchAfterRow(l1, true, T) === l1 && latchAfterRow(l1, false, T) === l1, "L1 걸쇠가 없으면 어떤 행이 와도 그대로");

  const l2 = latchAfterRow(held, true, T + 5_000);
  ok(l2.gone === true, "★ L2 «없다» 를 들은 뒤 5초에 온 «살아 있음» 행은 낡은 행일 수 있다 → 걸쇠 유지", show(l2));

  const l3 = latchAfterRow(held, false, T + 5_000);
  ok(l3.gone === true && l3.listSaw === true, "L3 목록이 «멈춤» 을 실어 오면 따라잡았다고 적고 걸쇠는 유지", show(l3));

  const l4 = latchAfterRow(l3, true, T + 6_000);
  ok(l4.gone === false, "L4 따라잡은 뒤의 «살아 있음» 은 진짜 되살아남 → 푼다(다른 탭이 같은 id 로 되살린 경우)", show(l4));

  ok(latchAfterRow(held, true, T + LIST_LAG_MS - 1).gone === true, "L5 경계 — 지연창 1ms 전의 «살아 있음» → 유지");
  ok(latchAfterRow(held, true, T + LIST_LAG_MS).gone === false, "L5 경계 — 지연창이 다 찬 순간의 «살아 있음» → 푼다(얼리지 않는다)");

  ok(latchAfterRow({ gone: true, at: 0, listSaw: false }, true, T).gone === false,
    "L6 새 값이 빈 경우 — «없다» 를 들은 시각을 모르면(0) 종전 동작(곧바로 푼다)으로 떨어진다");

  const e = (status, body) => Object.assign(new Error("x"), { status, body });
  ok(stoppedCanRevive(e(409, { stopped: true, canRevive: true })) === true, "R1 409 + stopped + canRevive → 되살린다");
  ok(stoppedCanRevive(e(409, { stopped: true, canRevive: "true" })) === false, "R2 참값 흉내(문자열)는 승격하지 않는다");
  ok(stoppedCanRevive(e(409, { stopped: true, canRevive: false })) === false && stoppedCanRevive(e(409, { stopped: false })) === false,
    "R3 되살릴 수 없는 멈춤 · 컴퓨터 무응답(stopped:false) → 되살리지 않는다");
  ok(stoppedCanRevive(e(500, { stopped: true, canRevive: true })) === false, "R4 409 가 아니면 아니다");
  ok(stoppedCanRevive(null) === false && stoppedCanRevive(undefined) === false && stoppedCanRevive("409") === false, "R5 오류 모양이 아니면 아니다");
  ok(stoppedCanRevive(e(409, undefined)) === false, "R6 본문이 없는 409(복원 force 409 등과 같은 상태코드) → 아니다");
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`\n${pass} pass`);

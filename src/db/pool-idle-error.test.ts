// 본체 풀의 유휴 연결 오류가 프로세스를 죽이지 않는다 (#4501).
//
// 실측: `app-sql-e2e.pg-test` 가 항목을 전부 통과한 뒤 정리 단계에서
//  `error: terminating connection due to administrator command` / `Emitted 'error' event on BoundPool instance at:
//  Client.idleListener` 로 죽었다(CI 2회 — main push·#1185 머지 대기열). pg-pool 은 유휴 클라이언트가 오류를 내면
//  그 클라이언트를 버리고 **풀에 'error' 를 emit** 한다. 풀에 리스너가 없으면 Node 가 그 이벤트를 throw 로 바꾼다 —
//  게이트웨이에서는 DB 재시작·관리자 종료 한 번이 곧 프로세스 재기동이었다.
//
// 사양·엣지표(스크래치패드 spec.md ③): 풀 error 이벤트 → 생존 · 수정 전(리스너 없음) → 크래시(red) ·
//  주소 없음(NO_DB) → 리스너 등록이 소켓을 열지 않는다(no-db-socket.test 가 따로 락) · 실 PG 종료는 pg-test 계층.
//
// 실행: npm run build && node dist/db/pool-idle-error.test.js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = JSON.stringify(pathToFileURL(path.join(HERE, "client.js")).href);

// 자식에서 pg-pool 이 유휴 클라이언트 오류 때 하는 일(`pool.emit('error', err, client)`)을 그대로 일으킨다.
//  자식 프로세스인 이유: 리스너가 없으면 이 emit 이 throw 가 되는데, 그걸 부모에서 받으면 «죽는다» 를 못 본다.
const body = `import { itemsPool } from ${CLIENT};
  const err = Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
  itemsPool.emit("error", err, {});
  await new Promise((r) => setTimeout(r, 20));   // 동기 throw 뿐 아니라 뒤이은 틱에서 죽는 것도 본다
  console.log("ALIVE");`;
const r = spawnSync(process.execPath, ["--input-type=module", "-e", body], {
  encoding: "utf8",
  timeout: 10_000,
  // 주소는 준다(정상 운영 모양) — 이 시험은 소켓을 열지 않는다(query/connect 를 부르지 않는다).
  env: { ...process.env, ITEMS_DATABASE_URL: "postgres://u:p@127.0.0.1:9/db" },
});
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;

// P1 — 살아남는다(종료코드 0 · 다음 줄까지 간다).
assert.equal(r.signal, null, `자식이 신호로 죽었다\n${out.slice(0, 600)}`);
assert.equal(r.status, 0, `유휴 연결 오류 하나에 프로세스가 죽었다 — 풀에 'error' 리스너가 없다\n${out.slice(0, 600)}`);
assert.match(r.stdout, /ALIVE/, `emit 뒤로 진행하지 못했다\n${out.slice(0, 600)}`);

// P2 — 조용히 삼키지 않는다: 어떤 오류였는지 로그에 남는다(오류 코드가 운영자 진단의 단서다).
assert.match(out, /57P01/, `오류가 로그에 남지 않았다 — 원인 추적 단서가 사라진다\n${out.slice(0, 600)}`);

console.log("ok  P1 유휴 연결 오류에도 프로세스가 산다");
console.log("ok  P2 그 오류를 코드와 함께 로그에 남긴다");

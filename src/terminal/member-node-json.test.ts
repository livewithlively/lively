// memberNodeJson 의 기다림 상한(#4672 — 같은 이름 후보가 사람이 기다리는 조회라서 붙였다) — 가짜 중계(LIVELY_MEMBER_EXEC)로
//  진짜 자식 프로세스를 띄워 잰다. 사양: 상한 안에 끝나면 답을 그대로 준다 · 상한을 넘으면 그 시각쯤 실패하고 자식은 끝난다 ·
//  상한을 안 주면 종전과 같다(기다린다). 판정은 걸린 시간 · 자식 프로세스가 살아 있나(pid) · 중계가 실제로 불렸나로 한다.
//   실행: npm run build && node --test dist/terminal/member-node-json.test.js
import { strict as assert } from "node:assert";
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "member-node-json-"));
const pids = path.join(tmp, "pids");
const relay = path.join(tmp, "relay.sh");
//  중계 꼴: `<중계> <osUser> -- <argv...>`(terminal-member-fs memberSpawnArgv). exec 로 바꿔 끼우므로 적은 pid 가 곧 node 의 pid 다.
fs.writeFileSync(relay, ["#!/bin/sh", `echo "$$" >> ${JSON.stringify(pids)}`, 'shift 2; exec "$@"'].join("\n"), { mode: 0o755 });
const prevExec = process.env.LIVELY_MEMBER_EXEC;
process.env.LIVELY_MEMBER_EXEC = relay;
after(() => {
  if (prevExec === undefined) delete process.env.LIVELY_MEMBER_EXEC; else process.env.LIVELY_MEMBER_EXEC = prevExec;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const { memberNodeJson } = await import("./terminal-member-fs.js");
const lastPid = (): number => Number(fs.readFileSync(pids, "utf8").trim().split("\n").pop());
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const ECHO_JS = "let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({got:JSON.parse(d)})))";

test("T1 상한을 안 주면 종전과 같다 — 중계를 거쳐 stdin JSON → stdout JSON", async () => {
  fs.rmSync(pids, { force: true });
  const out = await memberNodeJson<{ got: unknown }>("u1", ECHO_JS, { x: 1 });
  assert.deepEqual(out, { got: { x: 1 } });
  assert.ok(fs.existsSync(pids), "배선: 가짜 중계가 한 번도 안 불렸다");
});

test("T2 상한 안에 끝나면 답을 그대로 준다", async () => {
  const out = await memberNodeJson<{ got: unknown }>("u1", ECHO_JS, { y: [1, 2] }, { timeoutMs: 10_000 });
  assert.deepEqual(out, { got: { y: [1, 2] } });
});

test("T3 상한을 넘으면 그 시각쯤 실패하고 자식은 끝난다", async () => {
  const t0 = Date.now();
  await assert.rejects(memberNodeJson("u1", "setInterval(()=>{},1000)", null, { timeoutMs: 300 }), /300ms/);
  const took = Date.now() - t0;
  assert.ok(took >= 250 && took < 3000, `상한(300ms)과 동떨어진 때에 끝났다: ${took}ms`);
  const pid = lastPid();
  for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(pid), false, `자식(${pid})이 아직 살아 있다`);
});

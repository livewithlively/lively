// 부모(게이트웨이)를 잃은 수집 자식(#5012) — 사양 표 A1~A9.
//  실행: npm run build && node dist/connectors/orphan-guard.test.js
//  관찰 축: 가짜 출력 스트림이 실제로 받은 것 · run 행에 나간 SQL·값 · (A9) 진짜 프로세스가 남긴 파일.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installOrphanGuard, ORPHAN_NOTE } from "./orphan-guard.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

type Mode = "ok" | "epipe-throw" | "other-throw";
/** 쓰기 동작을 바꿔 끼울 수 있는 가짜 출력 — 받은 것을 기록하고, 'error' 처리기를 쥔다. */
function fakeStream() {
  const got: string[] = [];
  const handlers: Array<(e: NodeJS.ErrnoException) => void> = [];
  let mode: Mode = "ok";
  const s = {
    on(ev: string, fn: (e: NodeJS.ErrnoException) => void) { if (ev === "error") handlers.push(fn); return s; },
    write(chunk: unknown) {
      if (mode === "epipe-throw") throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      if (mode === "other-throw") throw Object.assign(new Error("boom"), { code: "EIO" });
      got.push(String(chunk)); return true;
    },
  };
  return { s, got, set: (m: Mode) => { mode = m; }, emitError: (code: string) => handlers.forEach((h) => h(Object.assign(new Error(code), { code }))) };
}
function rig(opts: { ppid?: () => number; failWrites?: number } = {}) {
  const out = fakeStream(), err = fakeStream();
  const sql: Array<{ q: string; p: unknown[] }> = [];
  let fail = opts.failWrites ?? 0;
  const g = installOrphanGuard({
    runId: 42, logCap: 10_000, flushMs: 60_000,
    streams: [out.s as unknown as NodeJS.WriteStream, err.s as unknown as NodeJS.WriteStream],
    ppid: opts.ppid ?? (() => 100),
    write: async (q, p) => { if (fail > 0) { fail--; throw new Error("db down"); } sql.push({ q, p }); },
  });
  return { g, out, err, sql };
}
const logOf = (sql: Array<{ q: string; p: unknown[] }>): string => sql.filter((x) => /SET log/.test(x.q)).map((x) => String(x.p[1])).join("");

await t("A1 부모가 살아 있으면 출력은 그대로 나가고 run 행은 건드리지 않는다(finish 포함)", async () => {
  const r = rig();
  r.err.s.write("[notion] 진행 — 페이지 20/100\n");
  r.g.note(JSON.stringify({ msg: "generic 싱크 완료", ingested: 3 }));
  await r.g.finish(0);
  assert.deepEqual(r.err.got, ["[notion] 진행 — 페이지 20/100\n"]);
  assert.equal(r.g.gone(), false);
  assert.deepEqual(r.sql, [], "부모가 있는데 행을 썼다 — 끝 기록은 부모 몫이다");
  r.g.stop();
});
await t("A2 쓰기가 EPIPE 를 던지면 삼키고, 그 줄부터 run 행 로그로 간다", async () => {
  const r = rig();
  r.err.set("epipe-throw");
  assert.doesNotThrow(() => r.err.s.write("[notion] 진행 — 페이지 40/100\n"));
  assert.equal(r.g.gone(), true);
  r.out.s.write("다음 줄\n");
  await r.g.flush();
  const log = logOf(r.sql);
  assert.ok(log.startsWith(ORPHAN_NOTE), log);
  assert.ok(log.includes("페이지 40/100") && log.includes("다음 줄"), log);
  assert.ok(r.sql.every((x) => /status='running'/.test(x.q)), "running 행에만 써야 한다");
  r.g.stop();
});
await t("A3 'error' 이벤트로 온 EPIPE 도 부모 상실로 본다", async () => {
  const r = rig();
  r.out.emitError("EPIPE");
  assert.equal(r.g.gone(), true);
  r.g.stop();
});
await t("A4·A5 쓰기 없이 부모 pid 만 바뀌어도 finish 가 행을 닫는다 — 0 은 ok, 1 은 error", async () => {
  for (const [code, want] of [[0, "ok"], [1, "error"]] as const) {
    let pp = 100;
    const r = rig({ ppid: () => pp });
    pp = 1; // 부모가 죽어 init 으로 입양됐다
    await r.g.finish(code);
    const fin = r.sql.find((x) => /SET status=\$2/.test(x.q));
    assert.ok(fin, "끝 기록이 없다 — 행이 running 으로 남아 다음 실행 때 유령으로 닫힌다");
    assert.equal(fin.p[0], 42); assert.equal(fin.p[1], want); assert.equal(fin.p[2], code);
    assert.match(fin.q, /status='running'/);
    r.g.stop();
  }
});
await t("A6 note — 부모가 있으면 무시, 잃었으면 남고 요약 stats 로 뽑힌다", async () => {
  const r = rig();
  r.g.note(JSON.stringify({ msg: "generic 싱크 완료", ingested: 1 }));
  r.err.emitError("EPIPE");
  r.g.note(JSON.stringify({ level: 30, system: "notion", ingested: 3861, msg: "generic 싱크 완료" }));
  await r.g.finish(0);
  const fin = r.sql.find((x) => /SET status=\$2/.test(x.q))!;
  const stats = JSON.parse(String(fin.p[3])) as Record<string, unknown>;
  assert.equal(stats.ingested, 3861);
  assert.equal(stats.system, "notion");
  r.g.stop();
});
await t("A7 EPIPE 가 아닌 쓰기 오류는 삼키지 않는다", async () => {
  const r = rig();
  r.err.set("other-throw");
  assert.throws(() => r.err.s.write("x\n"), /boom/);
  assert.equal(r.g.gone(), false);
  r.g.stop();
});
await t("A8 run 행 쓰기가 실패하면 버퍼를 지키고 다음 flush 에 다시 쓴다", async () => {
  const r = rig({ failWrites: 1 });
  r.err.emitError("EPIPE");
  r.err.s.write("중요한 줄\n");
  await r.g.flush();
  assert.equal(logOf(r.sql), "");
  await r.g.flush();
  assert.ok(logOf(r.sql).includes("중요한 줄"), "실패한 묶음이 사라졌다");
  r.g.stop();
});

await t("A9 실제 프로세스 — 부모가 먼저 끝나도 자식은 끝까지 돌고 행을 ok 로 닫는다", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-guard-"));
  const out = path.join(dir, "sql.log");
  const guardUrl = new URL("./orphan-guard.js", import.meta.url).href;
  fs.writeFileSync(path.join(dir, "child.mjs"), `
    import fs from "node:fs";
    const { installOrphanGuard } = await import(${JSON.stringify(guardUrl)});
    const g = installOrphanGuard({ runId: 7, logCap: 10000, flushMs: 100,
      write: async (q, p) => fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify({ q, p }) + "\\n") });
    let i = 0;
    const tick = setInterval(async () => {
      i++; console.error("[c] 진행 " + i);
      if (i >= 12) { clearInterval(tick); g.note(JSON.stringify({ msg: "generic 싱크 완료", ingested: i })); await g.finish(0); g.stop(); process.exit(0); }
    }, 100);
  `);
  fs.writeFileSync(path.join(dir, "parent.mjs"), `
    import { spawn } from "node:child_process";
    const c = spawn(process.execPath, [${JSON.stringify(path.join(dir, "child.mjs"))}], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    c.stdout.on("data", () => {}); c.stderr.on("data", () => {}); c.unref();
    setTimeout(() => process.exit(0), 300); // 게이트웨이 재시작 — 부모가 먼저 사라진다
  `);
  await new Promise<void>((res) => spawn(process.execPath, [path.join(dir, "parent.mjs")], { stdio: "ignore" }).on("exit", () => res()));
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && !(fs.existsSync(out) && fs.readFileSync(out, "utf8").includes("SET status"))) await new Promise((r) => setTimeout(r, 100));
  const lines = fs.existsSync(out) ? fs.readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { q: string; p: unknown[] }) : [];
  const fin = lines.find((l) => /SET status=\$2/.test(l.q));
  assert.ok(fin, "자식이 끝 기록을 못 남겼다 — 부모를 잃고 죽었다(EPIPE)");
  assert.equal(fin.p[1], "ok");
  assert.equal((JSON.parse(String(fin.p[3])) as { ingested: number }).ingested, 12);
  assert.ok(lines.some((l) => /SET log/.test(l.q) && String(l.p[1]).includes("[c] 진행 12")), "부모를 잃은 뒤의 로그가 행에 안 남았다");
  fs.rmSync(dir, { recursive: true, force: true });
});
console.log(`\n${pass} passed (orphan guard)`);

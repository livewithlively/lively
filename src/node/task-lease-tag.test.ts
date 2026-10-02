// 위탁 자격 파일의 표지(tag)와 오래된 잔재 정리 — 사양 행위 1~9.
// 가짜 하네스 bin 으로 스크립트를 실제로 `sh -c` 실행해 관측한다(POSIX 전용).
import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  taskLeaseFile, LEASE_TAG, LEASE_STALE_MS, taskScript, localTaskFs, TASK_SWEEP_LEASES_JS, prepareTaskDir,
} from "./tasks.js";

if (process.platform === "win32") {
  console.log("task-lease-tag.test: skip (win32)");
  process.exit(0);
}

const NAME = "CLAUDE_CODE_OAUTH_TOKEN";
const roots: string[] = [];
const mk = (): string => { const r = mkdtempSync(path.join(tmpdir(), "lease-tag-")); roots.push(r); return r; };
const past = (f: string, ms: number): void => { const t = new Date(Date.now() - ms); utimesSync(f, t, t); };

// 하네스가 받은 env 값을 out 파일로 남기고(set 일 때만), 지정 시간 머문다. 머무는 동안 상대 시작 표지를 본다.
function fakeBin(root: string, id: string, stayMs: number): { bin: string; out: string; peer: string } {
  const bin = path.join(root, `harness-${id}`);
  const out = path.join(root, `env-${id}.txt`);
  const started = path.join(root, `started-${id}`);
  const peer = path.join(root, `overlap-${id}.txt`);
  const other = path.join(root, `started-${id === "a" ? "b" : "a"}`);
  const sleep = stayMs > 0 ? `sleep ${stayMs / 1000}\n` : "";
  writeFileSync(bin, `#!/bin/sh\ncat > /dev/null\n: > "${started}"\n`
    + `if [ -n "\${${NAME}+x}" ]; then printf '%s' "$${NAME}" > "${out}"; fi\n`
    + sleep
    + `if [ -e "${other}" ]; then echo yes > "${peer}"; fi\nexit 0\n`);
  chmodSync(bin, 0o755);
  return { bin, out, peer };
}

function taskDirOf(root: string): { dir: string; ws: string } {
  const dir = path.join(root, "task"); mkdirSync(dir, { recursive: true });
  const ws = path.join(root, "ws"); mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(dir, "prompt.txt"), "p");
  return { dir, ws };
}

const env = (ws: string): NodeJS.ProcessEnv => ({ ...process.env, LIVELY_TASK_WS: ws, SHELL: "/bin/true", [NAME]: "" });
const runSync = (script: string, ws: string): void => {
  spawnSync("/bin/sh", ["-c", script], { stdio: "ignore", env: env(ws) });
};
const readOut = (f: string): string | null => (existsSync(f) ? readFileSync(f, "utf8") : null);

// 행위 1 — 태그 없는 경로는 종전 그대로 `<dir>/.lease-NAME`.
{
  assert.equal(taskLeaseFile("/d", NAME), path.join("/d", `.lease-${NAME}`), "태그 없는 자격 파일 경로가 종전과 달라졌다");
}

// 행위 2 — 태그가 다르면 경로가 다르고, 모두 dir 바로 아래에 있다.
{
  const a = taskLeaseFile("/d", NAME, "0123456789abcdef");
  const b = taskLeaseFile("/d", NAME, "fedcba9876543210");
  const none = taskLeaseFile("/d", NAME);
  assert.notEqual(a, b, "표지가 다른데 경로가 같다");
  assert.notEqual(a, none, "표지 있는 경로가 표지 없는 경로와 같다");
  assert.notEqual(b, none);
  assert.equal(path.dirname(a), "/d", "표지 경로가 dir 바로 아래가 아니다");
  assert.equal(path.dirname(b), "/d");
}

// 행위 3 — 표지 스크립트는 표지 경로의 값을 env 로 넘기고, 끝나면 그 파일은 남지 않는다.
{
  const root = mk(); const { dir, ws } = taskDirOf(root);
  const tag = "0123456789abcdef";
  const h = fakeBin(root, "a", 0);
  const f = taskLeaseFile(dir, NAME, tag);
  writeFileSync(f, "값-A", { mode: 0o600 });
  runSync(taskScript("claude", h.bin, [], dir, { leaseEnv: [NAME], leaseTag: tag }), ws);
  assert.equal(readOut(h.out), "값-A", "표지 경로의 값이 하네스 env 에 도달하지 않았다");
  assert.equal(existsSync(f), false, "하네스 종료 뒤 자격 파일이 남았다");
}

// 행위 4 — 같은 taskDir 에서 표지가 다른 두 스크립트를 동시에 돌리면 둘 다 성공하고 각자 자기 값을 받는다.
{
  const root = mk(); const { dir, ws } = taskDirOf(root);
  const tagA = "aaaaaaaaaaaaaaaa", tagB = "bbbbbbbbbbbbbbbb";
  const ha = fakeBin(root, "a", 300), hb = fakeBin(root, "b", 300);
  const fa = taskLeaseFile(dir, NAME, tagA), fb = taskLeaseFile(dir, NAME, tagB);
  writeFileSync(fa, "값-A", { mode: 0o600 });
  writeFileSync(fb, "값-B", { mode: 0o600 });
  const sa = taskScript("claude", ha.bin, [], dir, { leaseEnv: [NAME], leaseTag: tagA });
  const sb = taskScript("claude", hb.bin, [], dir, { leaseEnv: [NAME], leaseTag: tagB });
  const run = (s: string): Promise<number | null> => new Promise((resolve) => {
    const c = spawn("/bin/sh", ["-c", s], { stdio: "ignore", env: env(ws) });
    c.on("close", (code) => resolve(code));
  });
  const [ca, cb] = await Promise.all([run(sa), run(sb)]);
  assert.equal(readOut(ha.peer), "yes\n", "두 판의 실행 구간이 겹치지 않아 동시성 검증이 공허하다");
  assert.equal(readOut(hb.peer), "yes\n", "두 판의 실행 구간이 겹치지 않아 동시성 검증이 공허하다");
  assert.equal(ca, 0, "A 판이 실패했다");
  assert.equal(cb, 0, "B 판이 실패했다");
  assert.equal(readOut(ha.out), "값-A", "A 하네스가 자기 값을 못 받았다");
  assert.equal(readOut(hb.out), "값-B", "B 하네스가 자기 값을 못 받았다");
  assert.equal(readFileSync(path.join(dir, "exit"), "utf8").trim(), "0", "exit 파일에 하네스 성공 코드가 남아야 한다");
  assert.equal(existsSync(fa) || existsSync(fb), false, "실행 뒤 자격 파일이 남았다");
}

// 행위 5 — 규칙 밖 표지는 던지고, 규칙 안(16자 소문자 16진수)은 던지지 않는다.
{
  const mkScript = (leaseTag: string): string => taskScript("claude", "/b", [], "/t", { leaseEnv: [NAME], leaseTag });
  for (const bad of ["ABCDEF0123456789", "abc;rm -rf /", "$(touch x)abcdef0", "ab", "../../etcpasswd0", "abcdef 0123456789"]) {
    assert.throws(() => mkScript(bad), Error, `규칙 밖 표지가 받아들여졌다: ${JSON.stringify(bad)}`);
  }
  assert.doesNotThrow(() => mkScript("0123456789abcdef"), "규칙 안 표지가 거부됐다");
  assert.ok(LEASE_TAG.test("0123456789abcdef"), "LEASE_TAG 가 16자 소문자 16진수를 허용해야 한다");
  assert.ok(!LEASE_TAG.test("ABCDEF0123456789"), "LEASE_TAG 가 대문자를 허용했다");
}

// 행위 6 — 표지를 안 주면 스크립트는 태그 없는 경로를 읽는다.
{
  const root = mk(); const { dir, ws } = taskDirOf(root);
  const h = fakeBin(root, "a", 0);
  writeFileSync(taskLeaseFile(dir, NAME), "값-무표지", { mode: 0o600 });
  runSync(taskScript("claude", h.bin, [], dir, { leaseEnv: [NAME] }), ws);
  assert.equal(readOut(h.out), "값-무표지", "표지 없는 스크립트가 태그 없는 자격 파일을 읽지 못했다");
  assert.equal(existsSync(taskLeaseFile(dir, NAME)), false, "읽은 태그 없는 자격 파일이 남았다");
}

// 행위 7 — sweepStaleLeases 는 dir 바로 아래의 오래된 `.lease-` 파일만 지운다.
const DAY = 24 * 3600 * 1000;
function sweepFixture(): { dir: string; old1: string; old2: string; fresh: string; prompt: string; nested: string; leaseDir: string; leaseDirInner: string } {
  const root = mk();
  const dir = path.join(root, "t"); mkdirSync(dir);
  const old1 = path.join(dir, ".lease-X"); writeFileSync(old1, "1");
  const old2 = path.join(dir, `.lease-Y-${"a".repeat(16)}`); writeFileSync(old2, "2");
  const fresh = path.join(dir, ".lease-FRESH"); writeFileSync(fresh, "3");
  const prompt = path.join(dir, "prompt.txt"); writeFileSync(prompt, "p");
  const sub = path.join(dir, "sub"); mkdirSync(sub);
  const nested = path.join(sub, ".lease-NESTED"); writeFileSync(nested, "n");
  const leaseDir = path.join(dir, ".lease-DIR"); mkdirSync(leaseDir);
  const leaseDirInner = path.join(leaseDir, "inner"); writeFileSync(leaseDirInner, "i");
  for (const f of [old1, old2, prompt, nested, leaseDirInner]) past(f, 10 * DAY);
  past(leaseDir, 10 * DAY);
  return { dir, old1, old2, fresh, prompt, nested, leaseDir, leaseDirInner };
}
{
  const x = sweepFixture();
  const n = await localTaskFs.sweepStaleLeases(x.dir, DAY);
  assert.equal(n, 2, "지운 수가 오래된 `.lease-` 파일 수와 다르다");
  assert.equal(existsSync(x.old1) || existsSync(x.old2), false, "오래된 자격 파일이 안 지워졌다");
  assert.equal(existsSync(x.fresh), true, "막 쓴 자격 파일이 지워졌다");
  assert.equal(existsSync(x.prompt), true, "`.lease-` 로 시작하지 않는 파일이 지워졌다");
  assert.equal(existsSync(x.nested), true, "하위 디렉터리 안의 파일이 지워졌다");
  assert.equal(existsSync(x.leaseDir) && existsSync(x.leaseDirInner), true, "`.lease-` 로 시작하는 디렉터리가 지워졌다");
  assert.equal(await localTaskFs.sweepStaleLeases(path.join(x.dir, "없는-디렉터리"), DAY), 0, "없는 dir 은 0 이어야 한다");
}

// 행위 8 — TASK_SWEEP_LEASES_JS 도 같은 파일 집합을 지우고 같은 수를 낸다.
{
  const x = sweepFixture();
  const r = spawnSync(process.execPath, ["-e", TASK_SWEEP_LEASES_JS], {
    input: JSON.stringify({ dir: x.dir, olderThanMs: DAY }), encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout), 2, "스크립트가 낸 지운 수가 다르다");
  assert.equal(existsSync(x.old1) || existsSync(x.old2), false, "오래된 자격 파일이 안 지워졌다");
  assert.equal(
    [x.fresh, x.prompt, x.nested, x.leaseDir, x.leaseDirInner].every((f) => existsSync(f)), true,
    "지우면 안 되는 대상이 지워졌다",
  );
  const none = spawnSync(process.execPath, ["-e", TASK_SWEEP_LEASES_JS], {
    input: JSON.stringify({ dir: path.join(x.dir, "없는-디렉터리"), olderThanMs: DAY }), encoding: "utf8",
  });
  assert.equal(JSON.parse(none.stdout), 0, "없는 dir 은 0 이어야 한다");
}

// 행위 9 — prepareTaskDir 는 같은 작업 폴더의 오래된 `.lease-*` 만 치운다.
{
  const root = mk();
  const baseWs = path.join(root, "base"); const shared = path.join(root, "shared");
  mkdirSync(baseWs); mkdirSync(shared);
  const taskId = 4422;
  const dir = path.join(baseWs, ".lively-task", String(taskId));
  mkdirSync(dir, { recursive: true });
  const old = path.join(dir, `.lease-${NAME}`); writeFileSync(old, "x");
  const fresh = path.join(dir, `.lease-${NAME}-${"c".repeat(16)}`); writeFileSync(fresh, "y");
  past(old, LEASE_STALE_MS + 60_000);
  await prepareTaskDir(baseWs, shared, taskId, "프롬프트");
  assert.equal(existsSync(old), false, "오래된 자격 파일이 prepareTaskDir 뒤에도 남았다");
  assert.equal(existsSync(fresh), true, "막 쓴 자격 파일이 prepareTaskDir 에 지워졌다");
}

for (const r of roots) rmSync(r, { recursive: true, force: true });
console.log("task-lease-tag.test: ok");

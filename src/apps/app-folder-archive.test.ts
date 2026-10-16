// 앱 폴더 보관(#4778) — 사양 표 A · B · C · D · K · L · M(사양: 태스크 #4778 + 상민님 결정 2026-10-16 · 표 전문은 지식 file-address-scheme-design-4670 §24).
//  A 보관 이름 · B 파일 op(진짜 임시 폴더 · 이 프로세스의 node 로 고정 스크립트를 돌린다) · C 셀프호스트 격리 다시 지우기(가짜 자리) ·
//  D 목록 합치기(순수) · M 새로 도입한 것이 비었을 때 · 매니지드 갈래(가짜 중계로 osUser · 자리를 본다) · K/L 배선(소스 대조).
//  DB 를 타는 흐름(지우기 입구 · 새로 만들기 · 정비 · 관리자 도구)은 app-folder-archive.pg-test.mjs.
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lively-app-folder-archive-"));
const APPS = path.join(ROOT, "apps");
process.env.LIVELY_MEMBER_ISOLATION = "off";   // 비격리 셀프호스트 — 게이트웨이(이 프로세스)가 apps 자리를 직접 본다
delete process.env.LIVELY_MEMBER_EXEC;
delete process.env.LIVELY_TENANT_ROOT_TEMPLATE;
delete process.env.LIVELY_TENANCY_MODE;
process.env.TERMINAL_ROOT_APPS = APPS;

const M = await import("./app-folder-archive.js");
const O = await import("./app-folder-ops.js");
const { APP_ID_RE } = await import("./manifest.js");
const { unfreezeExecTopology } = await import("../exec-topology.js");
type Area = import("./app-folder-ops.js").AppsArea;
type RemoveResult = import("./app-folder-ops.js").RemoveResult;

const NOW = new Date(Date.UTC(2026, 9, 16, 3, 15, 2));   // 2026-10-16T03:15:02Z
const area = (): Area => { const a = O.appsAreaFor(null); assert.ok(a, "비격리 셀프호스트에서 apps 자리가 있다"); return a!; };
const reset = (): void => { fs.rmSync(APPS, { recursive: true, force: true }); fs.mkdirSync(APPS, { recursive: true }); };
const put = (rel: string, body: string | Buffer): void => { const f = path.join(APPS, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
const exists = (p: string): boolean => { try { fs.lstatSync(p); return true; } catch { return false; } };
const run = <T>(q: Record<string, unknown>): Promise<T> => area().run<T>({ base: APPS, ...q });

// ── A. 보관 이름 ────────────────────────────────────────────────────────────────────────────

test("A1 이름 = .archived-app.<앱>.<UTC 초>.<16진6> · 해석하면 같은 앱 · 같은 초", () => {
  const n = O.archiveNameFor("file-url-check", NOW, "0a1b2c");
  assert.equal(n, ".archived-app.file-url-check.20261016T031502Z.0a1b2c");
  const p = O.parseArchiveName(n);
  assert.equal(p?.app_id, "file-url-check");
  assert.equal(p?.archived_at.toISOString(), "2026-10-16T03:15:02.000Z");
  const r = O.archiveNameFor("crm", NOW);   // 기본 nonce 는 무작위 16진 6자
  assert.match(r, /^\.archived-app\.crm\.20261016T031502Z\.[0-9a-f]{6}$/);
  assert.notEqual(O.archiveNameFor("crm", NOW), O.archiveNameFor("crm", NOW), "같은 초에 두 번 옮겨도 이름이 겹치지 않는다");
});

test("A2 앱 id 꼴이 아니면 이름을 만들지 않는다", () => {
  for (const bad of ["CRM", "../x", "-crm", ".lively", "a", "a".repeat(33), "crm/x", "crm.x", ""]) {
    assert.throws(() => O.archiveNameFor(bad, NOW, "000000"), `'${bad}'`);
  }
  assert.throws(() => O.archiveNameFor("crm", NOW, "ZZZZZZ"), "nonce 도 16진 6자만");
});

test("A3 경계 — 앱 id 정확히 2자 · 32자는 된다", () => {
  for (const ok of ["ab", "a".repeat(32), "0-", "a-b-c"]) {
    const n = O.archiveNameFor(ok, NOW, "abcdef");
    assert.equal(O.parseArchiveName(n)?.app_id, ok);
  }
});

test("A4 꼴이 아닌 이름은 해석하지 않는다(null)", () => {
  for (const bad of [
    "crm", ".archived-app.crm", ".archived-app.crm.20261016T031502Z", ".archived-app.crm.20261016T031502Z.ABCDEF",
    ".archived-app.crm.20261016T0315Z.abcdef", ".archived-app.crm.20261016T031502Z.abcdef/..", "x.archived-app.crm.20261016T031502Z.abcdef",
    ".archived-app.CRM.20261016T031502Z.abcdef", ".archived-app.a.20261016T031502Z.abcdef", ".archived-app..20261016T031502Z.abcdef",
    ".archived-app.crm.20261016T031502Z.abcdef0", "",
    ".archived-app.crm.20261316T031502Z.abcdef",   // 13월 — 숫자 꼴은 맞지만 날짜가 아니다(Date 가 다음 해로 넘기지 않게)
    ".archived-app.crm.20261032T031502Z.abcdef", ".archived-app.crm.20261016T246002Z.abcdef",
  ]) assert.equal(O.parseArchiveName(bad), null, `'${bad}'`);
});

test("A5 스크립트 안의 이름 규칙 글자가 TS 쪽 규칙과 같다", () => {
  assert.equal(O.APP_ID_PART, "[a-z0-9][a-z0-9-]{1,31}", "앱 id 규칙에서 끝 표시만 뗐다");
  assert.ok(O.APP_FOLDER_OPS_JS.includes(`const APP=${APP_ID_RE.toString()};`), "스크립트의 APP 이 manifest APP_ID_RE 와 같은 글자");
  assert.ok(O.APP_FOLDER_OPS_JS.includes(`const ARC=/^\\.archived-app\\.${O.APP_ID_PART}\\.\\d{8}T\\d{6}Z\\.[0-9a-f]{6}$/;`), "스크립트의 ARC 가 이름 규칙과 같은 글자");
});

// ── B. 파일 op ─────────────────────────────────────────────────────────────────────────────

test("B1 앱 폴더 → 보관 이름 — 원래 자리 없음 · 같은 내용 · 파일 수 · 바이트", async () => {
  reset();
  put("crm/out/a.bin", Buffer.alloc(300, 1));
  put("crm/b.txt", "hello");
  put("crm/deep/x/y/z.txt", "z");
  const name = O.archiveNameFor("crm", NOW, "000001");
  const r = await run<{ moved: boolean; kind: string; files: number; bytes: number; truncated: boolean }>({ op: "archive", app: "crm", name });
  assert.deepEqual(r, { moved: true, kind: "dir", files: 3, bytes: 306, truncated: false });
  assert.equal(exists(path.join(APPS, "crm")), false, "원래 자리가 비었다");
  assert.equal(fs.readFileSync(path.join(APPS, name, "b.txt"), "utf8"), "hello");
  assert.equal(fs.readFileSync(path.join(APPS, name, "out/a.bin")).length, 300);
});

test("B2 앱 폴더 없음 → moved=false · 아무것도 안 생김", async () => {
  reset();
  const r = await run<{ moved: boolean }>({ op: "archive", app: "crm", name: O.archiveNameFor("crm", NOW, "000002") });
  assert.deepEqual(r, { moved: false });
  assert.deepEqual(fs.readdirSync(APPS), []);
});

test("B3 apps 자리 자체가 없음 → moved=false(던지지 않는다)", async () => {
  fs.rmSync(APPS, { recursive: true, force: true });
  const r = await run<{ moved: boolean }>({ op: "archive", app: "crm", name: O.archiveNameFor("crm", NOW, "000003") });
  assert.deepEqual(r, { moved: false });
  assert.equal(exists(APPS), false, "apps 자리를 만들지도 않는다");
});

test("B4 앱 폴더가 밖을 가리키는 링크 → 링크 자체가 옮겨지고 대상은 그대로", async () => {
  reset();
  const outside = path.join(ROOT, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "s".repeat(50));
  fs.symlinkSync(outside, path.join(APPS, "crm"));
  const name = O.archiveNameFor("crm", NOW, "000004");
  const r = await run<{ moved: boolean; kind: string; files: number; bytes: number }>({ op: "archive", app: "crm", name });
  assert.equal(r.moved, true);
  assert.equal(r.kind, "link");
  assert.equal(r.files, 1, "링크 하나로 센다(따라가 대상의 파일을 세지 않는다)");
  assert.equal(r.bytes, 0);
  assert.ok(fs.lstatSync(path.join(APPS, name)).isSymbolicLink(), "보관 자리에 링크 그대로");
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8").length, 50, "링크 대상은 그대로");
});

test("B5 보관 이름 자리가 이미 있으면 던지고 원래 앱 폴더는 그대로", async () => {
  reset();
  put("crm/a.txt", "a");
  const name = O.archiveNameFor("crm", NOW, "000005");
  fs.mkdirSync(path.join(APPS, name));
  await assert.rejects(run({ op: "archive", app: "crm", name }), /이미 있습니다/);
  assert.equal(fs.readFileSync(path.join(APPS, "crm/a.txt"), "utf8"), "a");
});

test("B6 앱 · 이름에 ../ 나 보관 꼴이 아닌 이름 → 던지고 아무것도 안 바뀜", async () => {
  reset();
  put("crm/a.txt", "a");
  fs.mkdirSync(path.join(ROOT, "victim"), { recursive: true });
  const name = O.archiveNameFor("crm", NOW, "000006");
  await assert.rejects(run({ op: "archive", app: "../victim", name }), /이름 꼴/);
  await assert.rejects(run({ op: "archive", app: "crm", name: "../escaped" }), /이름 꼴/);
  await assert.rejects(run({ op: "archive", app: "crm", name: "not-an-archive" }), /이름 꼴/);
  await assert.rejects(run({ op: "archive", app: "crm", name: name + "/.." }), /이름 꼴/);
  assert.deepEqual(fs.readdirSync(APPS), ["crm"]);
  assert.ok(exists(path.join(ROOT, "victim")));
  assert.equal(exists(path.join(ROOT, "escaped")), false);
});

test("B7 세기 상한에 닿으면 truncated · 센 값은 상한 이하", async () => {
  reset();
  for (let i = 0; i < 30; i++) put(`crm/f${i}.txt`, "x");
  const name = O.archiveNameFor("crm", NOW, "000007");
  const r = await run<{ moved: boolean; files: number; truncated: boolean }>({ op: "archive", app: "crm", name, cap_n: 10, cap_ms: 60_000 });
  assert.equal(r.moved, true, "세기를 멈춰도 옮기기는 끝났다");
  assert.equal(r.truncated, true);
  assert.ok(r.files <= 10, `센 파일 ${r.files} ≤ 상한 10`);
  assert.equal(fs.readdirSync(path.join(APPS, name)).length, 30, "파일은 다 옮겨졌다");
});

test("B8 scan — 보관(기록 있음/없음) · 고아 · 살아 있는 앱 · 앱 꼴 아닌 이름 · 다른 점 이름", async () => {
  reset();
  const known = O.archiveNameFor("old", NOW, "00000a"), unknown = O.archiveNameFor("gone", NOW, "00000b");
  put(`${known}/k.txt`, "kk");
  put(`${unknown}/u.txt`, "uuu");
  put("live-app/l.txt", "l");
  put("orphan-app/o1.txt", "o1");
  put("orphan-app/sub/o2.txt", "o22");
  put("README", "not an app");
  put("Foo/x.txt", "upper — 앱 꼴 아님");
  put(".lively/x.txt", "다른 점 이름");
  const r = await run<{ exists: boolean; archives: Array<Record<string, unknown>>; orphans: Array<Record<string, unknown>> }>(
    { op: "scan", live: ["live-app"], known: [known] });
  assert.equal(r.exists, true);
  assert.deepEqual(r.archives, [
    { name: known, kind: "dir" },   // 기록 있는 것은 크기를 다시 세지 않는다
    { name: unknown, kind: "dir", files: 1, bytes: 3, truncated: false },
  ].sort((a, b) => String(a.name).localeCompare(String(b.name))));
  assert.deepEqual(r.orphans, [{ name: "orphan-app", kind: "dir", files: 2, bytes: 5, truncated: false }]);
});

test("B9 scan — apps 자리 없음 → exists=false · 빈 목록", async () => {
  fs.rmSync(APPS, { recursive: true, force: true });
  assert.deepEqual(await run({ op: "scan", live: [], known: [] }), { exists: false, archives: [], orphans: [] });
});

test("B10 remove — 있는 것은 removed · 없는 이름은 absent · 안의 링크는 대상까지 가지 않는다", async () => {
  reset();
  const outside = path.join(ROOT, "outside2");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
  const a = O.archiveNameFor("crm", NOW, "000010"), b = O.archiveNameFor("crm", NOW, "000011");
  put(`${a}/x/y.txt`, "y");
  fs.symlinkSync(outside, path.join(APPS, a, "link-out"));
  const r = await run<RemoveResult>({ op: "remove", names: [a, b] });
  assert.deepEqual(r, { removed: [a], absent: [b], left: [] });
  assert.equal(exists(path.join(APPS, a)), false);
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "keep", "링크 대상은 살아 있다");
});

test("B11 remove — 보관 꼴이 아닌 이름은 던지고 아무것도 안 지운다", async () => {
  reset();
  put("crm/a.txt", "a");
  const ok = O.archiveNameFor("crm", NOW, "000012");
  put(`${ok}/a.txt`, "a");
  for (const bad of ["crm", "../apps", ".lively", `${ok}/..`]) {
    await assert.rejects(run({ op: "remove", names: [ok, bad] }), /이름 꼴/, bad);
  }
  assert.ok(exists(path.join(APPS, "crm/a.txt")), "앱 폴더는 그대로");
  assert.ok(exists(path.join(APPS, ok, "a.txt")), "꼴이 틀린 이름이 하나라도 섞이면 맞는 이름도 지우지 않는다");
});

test("B12 remove — 못 지우는 하위가 있으면 left(까닭 · 주인 uid)", { skip: process.getuid?.() === 0 ? "root 는 권한을 무시한다" : false }, async () => {
  reset();
  const a = O.archiveNameFor("crm", NOW, "000013");
  put(`${a}/locked/inner.txt`, "i");
  put(`${a}/free.txt`, "f");
  fs.chmodSync(path.join(APPS, a, "locked"), 0o555);   // 그 폴더 안의 항목을 지울 수 없다(셀프호스트 격리의 «남의 폴더» 와 같은 꼴)
  try {
    const r = await run<RemoveResult>({ op: "remove", names: [a] });
    assert.deepEqual(r.removed, []);
    assert.equal(r.left.length, 1);
    assert.equal(r.left[0]!.name, a);
    assert.ok(r.left[0]!.error.length > 0, "까닭이 있다");
    assert.ok((r.left[0]!.owners ?? []).includes(process.getuid!()), "남은 폴더의 주인 uid 를 싣는다");
    assert.ok(exists(path.join(APPS, a, "locked/inner.txt")));
  } finally { fs.chmodSync(path.join(APPS, a, "locked"), 0o755); }
});

test("B13 restore — 대상 없음 · 빈 폴더 · 파일 든 폴더 · 파일 · 보관 없음", async () => {
  reset();
  const mk = (n: string): string => { const name = O.archiveNameFor("crm", NOW, n); put(`${name}/r.txt`, "restored"); return name; };
  //  대상 없음 → 되돌림
  let name = mk("000020");
  assert.deepEqual(await run({ op: "restore", name, app: "crm" }), { ok: true });
  assert.equal(fs.readFileSync(path.join(APPS, "crm/r.txt"), "utf8"), "restored");
  assert.equal(exists(path.join(APPS, name)), false);
  //  빈 폴더 → 되돌림
  fs.rmSync(path.join(APPS, "crm"), { recursive: true });
  fs.mkdirSync(path.join(APPS, "crm"));
  name = mk("000021");
  assert.deepEqual(await run({ op: "restore", name, app: "crm" }), { ok: true });
  assert.equal(fs.readFileSync(path.join(APPS, "crm/r.txt"), "utf8"), "restored");
  //  파일 든 폴더 → occupied · 아무것도 안 바뀜
  name = mk("000022");
  assert.deepEqual(await run({ op: "restore", name, app: "crm" }), { ok: false, why: "occupied" });
  assert.ok(exists(path.join(APPS, name, "r.txt")), "보관 그대로");
  //  파일 → occupied
  fs.rmSync(path.join(APPS, "crm"), { recursive: true });
  fs.writeFileSync(path.join(APPS, "crm"), "a file");
  assert.deepEqual(await run({ op: "restore", name, app: "crm" }), { ok: false, why: "occupied" });
  //  보관 없음 → missing
  fs.rmSync(path.join(APPS, "crm"));
  assert.deepEqual(await run({ op: "restore", name: O.archiveNameFor("crm", NOW, "000099"), app: "crm" }), { ok: false, why: "missing" });
});

test("B14 apps 자리가 상대경로 · 정규화 안 됨 → 던진다", async () => {
  reset();
  const a = area();
  for (const base of ["apps", APPS + "/../apps", APPS + "/"]) {
    await assert.rejects(a.run({ op: "scan", base, live: [], known: [] }), /절대경로/, base);
  }
});

// ── C. 셀프호스트 격리 다시 지우기(가짜 자리) ───────────────────────────────────────────────────

/** 가짜 자리 — 게이트웨이 / 주인 계정 차례마다 정해 둔 답을 돌려주고 부른 순서를 적는다. */
function fakeArea(script: Array<{ who: string; out: RemoveResult }>, withRunAs = true) {
  const calls: Array<{ who: string; names: string[] }> = [];
  const next = (who: string) => async <T>(q: Record<string, unknown>): Promise<T> => {
    calls.push({ who, names: q.names as string[] });
    const i = script.findIndex((s) => s.who === who);
    assert.ok(i >= 0, `예상하지 않은 차례: ${who}`);
    return script.splice(i, 1)[0]!.out as unknown as T;
  };
  const a: Area = { base: "/srv/apps", run: next("gw"), runAs: withRunAs ? (u) => next(u) : null };
  return { a, calls };
}
const left = (name: string, owners: number[]) => ({ name, error: "EACCES", owners });

test("C1 주인 계정 경로가 없으면(매니지드 · 비격리) 한 번만 — 남은 것 보고", async () => {
  const { a, calls } = fakeArea([{ who: "gw", out: { removed: ["x1"], absent: [], left: [left("x2", [1001])] } }], false);
  const r = await O.removeArchives(a, ["x1", "x2"], async () => { throw new Error("불리면 안 된다"); });
  assert.deepEqual(r, { removed: ["x1"], absent: [], left: [{ name: "x2", error: "EACCES" }] });
  assert.equal(calls.length, 1);
});

test("C2 남은 것 → 주인 계정으로 지우고 게이트웨이로 다시 → 지워짐", async () => {
  const { a, calls } = fakeArea([
    { who: "gw", out: { removed: [], absent: [], left: [left("x", [1001, 1002])] } },
    { who: "box_alice", out: { removed: [], absent: [], left: [left("x", [1002])] } },
    { who: "box_bob", out: { removed: [], absent: [], left: [left("x", [1001])] } },
    { who: "gw", out: { removed: ["x"], absent: [], left: [] } },
  ]);
  const seen: number[][] = [];
  const r = await O.removeArchives(a, ["x"], async (uids) => { seen.push(uids); return ["box_alice", "box_bob"]; });
  assert.deepEqual(r, { removed: ["x"], absent: [], left: [] });
  assert.deepEqual(seen, [[1001, 1002]], "남은 폴더의 주인 uid 로 계정을 찾는다");
  assert.deepEqual(calls.map((c) => c.who), ["gw", "box_alice", "box_bob", "gw"]);
  assert.deepEqual(calls[1]!.names, ["x"], "주인 계정에는 남은 이름만");
});

test("C3 주인 uid 를 계정으로 못 바꾸면 더 안 돌고 남은 것 보고", async () => {
  const { a, calls } = fakeArea([{ who: "gw", out: { removed: [], absent: [], left: [left("x", [0])] } }]);
  const r = await O.removeArchives(a, ["x"], async () => []);
  assert.deepEqual(r.left, [{ name: "x", error: "EACCES" }]);
  assert.equal(calls.length, 1);
});

test("C4 주인 계정이 통째로 지웠으면(다시 볼 땐 없음) 지운 것으로 센다", async () => {
  const { a } = fakeArea([
    { who: "gw", out: { removed: [], absent: [], left: [left("x", [1001]), left("y", [1001])] } },
    { who: "box_alice", out: { removed: ["x"], absent: [], left: [left("y", [1001])] } },
    { who: "gw", out: { removed: [], absent: ["y"], left: [] } },
  ]);
  const r = await O.removeArchives(a, ["x", "y"], async () => ["box_alice"]);
  assert.deepEqual(r, { removed: ["x", "y"], absent: [], left: [] });
});

test("C5 계속 남으면 세 바퀴에서 멈춘다", async () => {
  const stuck = { removed: [], absent: [], left: [left("x", [1001])] };
  const script = [{ who: "gw", out: stuck }];
  for (let i = 0; i < 5; i++) script.push({ who: "box_alice", out: stuck }, { who: "gw", out: stuck });
  const { a, calls } = fakeArea(script);
  const r = await O.removeArchives(a, ["x"], async () => ["box_alice"]);
  assert.deepEqual(r.left, [{ name: "x", error: "EACCES" }]);
  assert.equal(calls.filter((c) => c.who === "box_alice").length, 3, "주인 계정 차례는 세 번");
  assert.equal(calls.length, 7, "처음 1 + (주인 1 + 게이트웨이 1) × 3");
});

// ── D. 목록 합치기(순수) ───────────────────────────────────────────────────────────────────

const rowFor = (app: string, at: Date, over: Record<string, unknown> = {}) => ({
  name: O.archiveNameFor(app, at, "abcdef"), app_id: app, archived_at: at, archived_by: "admin", entry: "remove" as const,
  kind: "dir" as const, files: 2, bytes: 10, truncated: false, last_error: null, last_try_at: null, ...over,
});

test("D1~D7 기록 · 파일 훑기 → 목록", () => {
  const t1 = new Date(Date.UTC(2026, 9, 10)), t2 = new Date(Date.UTC(2026, 9, 12)), t3 = new Date(Date.UTC(2026, 9, 14));
  const present = rowFor("crm", t1), missing = rowFor("memo", t2);
  const fsOnly = O.archiveNameFor("gone", t3, "123456");
  const scan = {
    exists: true,
    archives: [{ name: present.name, kind: "dir" as const }, { name: fsOnly, kind: "dir" as const, files: 4, bytes: 40, truncated: true }],
    orphans: [{ name: "lost", kind: "dir" as const, files: 1, bytes: 7, truncated: false }],
  };
  const out = M.mergeListing([present, missing], scan, new Set(["crm"]), 7);
  //  D7 최근 것 먼저
  assert.deepEqual(out.items.map((i) => i.app_id), ["gone", "memo", "crm"]);
  const byApp = Object.fromEntries(out.items.map((i) => [i.app_id, i]));
  //  D1 파일 있음 → missing 없음 · 기한
  assert.equal(byApp.crm!.missing, undefined);
  assert.equal(byApp.crm!.expires_at, new Date(t1.getTime() + 7 * 864e5).toISOString());
  //  D2 기록만 → missing
  assert.equal(byApp.memo!.missing, true);
  //  D4 파일만 → 채울 기록(unknown · 이름의 시각 · 훑기 크기)
  assert.equal(out.fill.length, 1);
  assert.deepEqual({ ...out.fill[0]!, archived_at: out.fill[0]!.archived_at.toISOString() },
    { name: fsOnly, app_id: "gone", archived_at: t3.toISOString(), archived_by: null, entry: "unknown", kind: "dir", files: 4, bytes: 40, truncated: true,
      last_error: null, last_try_at: null });
  //  D5 같은 id 의 앱
  assert.equal(byApp.crm!.app_exists, true);
  assert.equal(byApp.memo!.app_exists, false);
  //  D6 고아
  assert.deepEqual(out.orphans, [{ app_id: "lost", kind: "dir", files: 1, bytes: 7, truncated: false }]);
  //  D3 훑기 실패 → missing 을 말하지 않는다 · 채울 것 · 고아 없음
  const blind = M.mergeListing([present, missing], null, new Set(), 7);
  assert.ok(blind.items.every((i) => i.missing === undefined));
  assert.deepEqual(blind.fill, []);
  assert.deepEqual(blind.orphans, []);
});

test("D8 기한이 지났나(expired) — 지금 시각 기준 · 경계(딱 기한)는 지난 것", () => {
  const now = new Date(Date.UTC(2026, 9, 16, 0, 0, 0));
  const fresh = rowFor("fresh", new Date(now.getTime() - 6 * 864e5));
  const edge = rowFor("edge", new Date(now.getTime() - 7 * 864e5));
  const old = rowFor("old", new Date(now.getTime() - 8 * 864e5), { last_error: "지우지 못했습니다 — EACCES", last_try_at: new Date(now.getTime() - 3600e3) });
  const items = Object.fromEntries(M.mergeListing([fresh, edge, old], null, new Set(), 7, now).items.map((i) => [i.app_id, i]));
  assert.equal(items.fresh!.expired, false);
  assert.equal(items.edge!.expired, true, "기한과 같은 시각이면 지났다(정비는 엄격히 더 오래된 것만 지우지만 되돌리기는 막는다)");
  assert.equal(items.old!.expired, true);
  assert.equal(items.old!.last_error, "지우지 못했습니다 — EACCES");
  assert.equal(items.old!.last_try_at, new Date(now.getTime() - 3600e3).toISOString());
});

test("D 경계 — 보관 일수 0 이면 기한 = 옮긴 시각", () => {
  const t = new Date(Date.UTC(2026, 9, 10, 1, 2, 3));
  assert.equal(M.expiresAt(t, 0), t.toISOString());
  assert.equal(M.expiresAt(t.toISOString(), 1), new Date(t.getTime() + 864e5).toISOString());
});

// ── M. 새로 도입한 것이 비었을 때 ──────────────────────────────────────────────────────────────

test("M1 apps 자리 없음(area=null) → 옮기지 않고 skipped · 던지지 않음", async () => {
  const r = await M.archiveAppFolder("crm", { by: null, entry: "remove", area: null });
  assert.equal(r.archived, null);
  assert.ok(r.skipped && /자리가 없습니다/.test(r.skipped));
});

test("M3 앱 id 꼴이 아니면 skipped — 파일 op 를 부르지 않는다", async () => {
  let called = 0;
  const a: Area = { base: "/x", run: async () => { called++; return { moved: true } as never; }, runAs: null };
  for (const bad of ["../x", "X", ".archived-app.a.b", ""]) {
    const r = await M.archiveAppFolder(bad, { by: "admin", entry: "remove", area: a });
    assert.equal(r.archived, null, bad);
    assert.ok(r.skipped, bad);
  }
  assert.equal(called, 0);
});

test("자리 고르기 — 비격리 셀프호스트는 TERMINAL_ROOT_APPS · 주인 계정 경로 없음", () => {
  const a = area();
  assert.equal(a.base, APPS);
  assert.equal(a.runAs, null);
});

test("매니지드 갈래 — 중계로 돈다 · 감옥 안 자리(isolatedBase) · osUser = 시킨 사람(없으면 system)", async () => {
  const relayLog = path.join(ROOT, "relay.log");
  const relay = path.join(ROOT, "relay.mjs");
  //  가짜 중계 — 계약(`<중계> <osUser> -- <cmd…>`)대로 받아 osUser 를 적고 cmd 를 그대로 돌린다(stdin · stdout · 종료코드를 잇는다).
  fs.writeFileSync(relay, [
    "import { spawn } from 'node:child_process'; import fs from 'node:fs';",
    "const [osUser, sep, ...cmd] = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(relayLog)}, osUser + ' ' + sep + ' ' + cmd[0] + '\\n');`,
    "const c = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' }); c.on('close', (code) => process.exit(code ?? 1));",
  ].join("\n"));
  const jail = path.join(ROOT, "jail-apps");
  fs.mkdirSync(path.join(jail, "crm"), { recursive: true });
  fs.writeFileSync(path.join(jail, "crm/a.txt"), "jail");
  process.env.LIVELY_MEMBER_EXEC = `${process.execPath} ${relay}`;
  process.env.LIVELY_APPS_DIR = jail;
  unfreezeExecTopology();
  try {
    const a = O.appsAreaFor(null)!;
    assert.equal(a.base, jail, "매니지드는 감옥 안 자리(isolatedBase)를 본다");
    assert.equal(a.runAs, null, "매니지드는 테넌트 uid 하나 — 주인 계정으로 다시 지우지 않는다");
    const byMember = O.appsAreaFor("Sangmin Yoon")!;
    const name = O.archiveNameFor("crm", NOW, "0000aa");
    assert.deepEqual(await byMember.run({ op: "archive", base: byMember.base, app: "crm", name }), { moved: true, kind: "dir", files: 1, bytes: 4, truncated: false });
    assert.equal(fs.readFileSync(path.join(jail, name, "a.txt"), "utf8"), "jail");
    await a.run({ op: "scan", base: jail, live: [], known: [] });
    const log = fs.readFileSync(relayLog, "utf8").trim().split("\n");
    assert.deepEqual(log.map((l) => l.split(" ")[0]), ["box_sangmin-yoon", "box_system"], "osUser = 시킨 사람의 계정 꼴 · 없으면 box_system");
    assert.ok(log.every((l) => l.split(" ")[1] === "--"), "중계 계약의 구분자");
  } finally {
    delete process.env.LIVELY_MEMBER_EXEC;
    delete process.env.LIVELY_APPS_DIR;
    unfreezeExecTopology();
  }
});

// ── K/L. 배선(소스 대조) ───────────────────────────────────────────────────────────────────

const src = (f: string): string => fs.readFileSync(f, "utf8");
/** 주석을 뺀 소스(배선 단언이 주석 속 글자에 속지 않게). */
/**
 * 주석을 걷은 소스 — 파서가 찾은 주석 자리만 지운다. 문자열 · 정규식 · 템플릿 안의 «/*» · «//» 는 주석이 아니다.
 *  정규식으로 걷으면 "…/_lively/* …" 같은 문자열에서 다음 «*\/» 까지 수만 자를 지워, 배선 시험이 그 사이 코드를 못 본다
 *  (2026-10-16 실측 — capabilities/apps.ts 의 app_build_start 예약 자리가 통째로 사라졌다).
 */
const codeCache = new Map<string, string>();
const code = (f: string): string => {
  const hit = codeCache.get(f);
  if (hit !== undefined) return hit;
  const text = src(f);
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, /\.(m?js)$/.test(f) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const cuts = new Map<number, number>();
  //  주석은 늘 어떤 토큰 둘레에 있다 — 잎 토큰마다 앞 주석(줄이 바뀐 뒤) · 뒤 주석(같은 줄)을 모은다. JSDoc 노드 안은 내려가지 않는다
  //   (그 주석은 뒤 토큰의 앞 주석으로 잡힌다).
  const visit = (n: ts.Node): void => {
    if (n.kind === ts.SyntaxKind.JSDoc) return;
    const kids = n.getChildren(sf);
    if (!kids.length) {
      for (const r of [...(ts.getLeadingCommentRanges(text, n.pos) ?? []), ...(ts.getTrailingCommentRanges(text, n.end) ?? [])]) cuts.set(r.pos, r.end);
      return;
    }
    for (const k of kids) visit(k);
  };
  visit(sf);
  let out = "", at = 0;
  for (const [pos, end] of [...cuts].sort((x, y) => x[0] - y[0])) { if (pos < at) continue; out += text.slice(at, pos); at = end; }
  out += text.slice(at);
  codeCache.set(f, out);
  return out;
};
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [path.join(dir, e.name)] : []);

test("K1 매니지드 정비 틱에 보관 지우기 단계가 있다", () => {
  const w = code("src/web.ts");
  const i = w.indexOf('step("app-folder-archive"');
  assert.ok(i > 0, "tick 에 app-folder-archive 단계");
  assert.ok(w.slice(i, i + 300).includes("pruneAppFolderArchives()"), "그 단계가 pruneAppFolderArchives 를 부른다");
});

test("K2 자가호스팅 정비 타이머 — 테넌트마다 같은 함수", () => {
  const h = code("src/boot/housekeeping.ts");
  assert.match(h, /perTenant\("app-folder-archive",\s*\(\) => import\("\.\.\/apps\/app-folder-archive\.js"\)\.then\(\(m\) => m\.pruneAppFolderArchives\(\)\)\)/);
  assert.match(h, /setInterval\(\(\) => \{ void appFolderArchive\(\); \}/);
});

test("L0 배선 시험의 주석 걷기 — 진짜 주석만 지우고 문자열 · 정규식 · 템플릿 안의 «/*» · «//» 와 그 뒤 코드는 남긴다", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afa-code-"));
  try {
    const f = path.join(dir, "sample.ts");
    fs.writeFileSync(f, [
      `/** 문서 주석 */`,
      `const a = "앱 주소 /_lively/* 로 연다"; // 줄 주석`,
      `const re = /\\/\\*/g; const t = \`템플릿 // 안 /* 도 \${a} */\`;`,
      `/* 막 주석 */ keepMe(1);`,
      `const u = "https://x.y/z"; afterUrl();`,
    ].join("\n"));
    const c = code(f);
    for (const keep of [`"앱 주소 /_lively/* 로 연다"`, "keepMe(1);", "/\\/\\*/g", "템플릿 // 안 /* 도", `"https://x.y/z"`, "afterUrl();"]) assert.ok(c.includes(keep), `남아야 한다: ${keep}\n${c}`);
    for (const gone of ["문서 주석", "줄 주석", "막 주석"]) assert.ok(!c.includes(gone), `지워야 한다: ${gone}\n${c}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("L1 앱 행을 지우는 store 함수 셋은 remove-run 에서만 부른다", () => {
  const offenders: string[] = [];
  for (const f of walk("src")) {
    if (f === path.join("src", "org", "store", "apps.ts") || f === path.join("src", "apps", "remove-run.ts")) continue;
    if (!["deleteApp(", "dropEmptyDraftApp(", "dropStaleEmptyDrafts("].some((n) => src(f).includes(n))) continue;   // 바늘이 없으면 주석을 걷어도 없다
    const c = code(f);
    for (const fn of ["deleteApp(", "dropEmptyDraftApp(", "dropStaleEmptyDrafts("]) {
      if (new RegExp(`\\b${fn.replace("(", "\\(")}`).test(c)) offenders.push(`${f}: ${fn}`);
    }
  }
  assert.deepEqual(offenders, [], "앱 행을 지우는 입구가 remove-run 밖에 생겼다 — 앱 폴더 보관이 빠진다");
  //  날 SQL 로 앱 행을 지우는 곳도 store 의 그 셋뿐이다(org_app_* 다른 표는 상관없다).
  const rawDeletes = walk("src").flatMap((f) => (src(f).includes("DELETE FROM org_app") ? code(f).match(/DELETE FROM org_app\b(?!_)/g) ?? [] : []).map(() => f));
  assert.deepEqual(rawDeletes, Array(3).fill(path.join("src", "org", "store", "apps.ts")), `org_app 행을 지우는 SQL: ${rawDeletes.join(" · ")}`);
  const r = code("src/apps/remove-run.ts");
  for (const fn of ["store.deleteApp(", "store.dropEmptyDraftApp(", "store.dropStaleEmptyDrafts("]) assert.ok(r.includes(fn), `remove-run 이 ${fn} 를 부른다(배선)`);
  //  셋 다 앱 폴더 보관을 지난다 — 제거 · 빈 예약 하나 · 오래된 빈 예약.
  assert.match(r, /const appFolder = await archiveFolderOf\(id, ctx\.actor \?\? null, entry\);[\s\S]*await store\.deleteApp\(id, ctx\);/);
  assert.match(r, /const dropped = await store\.dropEmptyDraftApp\(appId\);\s*if \(dropped\) await archiveFolderOf\(appId, by, "draft-drop"\);/);
  assert.match(r, /const ids = await store\.dropStaleEmptyDrafts\(owner, days\);\s*for \(const id of ids\) await archiveFolderOf\(id, owner, "draft-drop"\);/);
});

test("L2 reserveDraftApp 을 부르는 곳마다 그 앞에 남은 앱 폴더 보관", () => {
  const sites: string[] = [];
  for (const f of walk("src")) {
    if (f === path.join("src", "org", "store", "apps.ts")) continue;
    if (!src(f).includes("reserveDraftApp(")) continue;
    const c = code(f);
    let i = -1;
    while ((i = c.indexOf("reserveDraftApp(", i + 1)) >= 0) {
      sites.push(`${f}@${i}`);
      const before = c.slice(Math.max(0, i - 700), i);
      assert.ok(before.includes("await archiveLeftoverAppFolder(id, who.userId);"), `${f}: reserveDraftApp 앞에 archiveLeftoverAppFolder 가 없다`);
    }
  }
  assert.equal(sites.length, 2, `reserveDraftApp 부르는 곳(app_save · app_build_start): ${sites.join(" · ")}`);
  //  G3 app_build_start — 설치 락 안에서 «앱 없음» → 남은 폴더 보관 → 예약
  assert.match(code("src/capabilities/apps.ts"),
    /withAppInstallLock\(id, async \(\) => \{\s*if \(await store\.getApp\(id\)\) return false;\s*await archiveLeftoverAppFolder\(id, who\.userId\);\s*return store\.reserveDraftApp\(/);
});

test("L3 installLoadedApp 은 새 앱(기존 없음 · 기본 앱 아님)일 때만 남은 앱 폴더 보관 — 아무것도 만들기 전에", () => {
  const c = code("src/apps/install-run.ts");
  const guard = c.indexOf("if (!existing && !builtin) await archiveLeftoverAppFolder(id,");
  assert.ok(guard > 0, "새 앱일 때만 부르는 줄");
  assert.ok(guard < c.indexOf("ensureAppTables("), "표를 만들기 전에");
  assert.ok(guard < c.indexOf("runInstall("), "설치를 시작하기 전에");
  assert.equal(c.split("archiveLeftoverAppFolder(").length - 1, 1, "다른 조건으로 부르는 곳이 없다");
});

test("제거 입구 셋이 제 이름을 넘긴다(remove · discard · retire)", () => {
  const caps = code("src/capabilities/apps.ts");
  assert.match(caps, /removeInstalledApp\(app, wctx\(user, ctx\), "discard"\)/);
  assert.match(caps, /removeInstalledApp\(app, wctx\(user, ctx\), "remove"\)/);
  assert.equal(caps.split("removeInstalledApp(app,").length - 1, 2);
  assert.match(code("src/apps/seed.ts"), /deps\.removeInstalledApp\(existing, ctx, "retire"\)/);
});

// ── 리뷰 반영 — 시간 · 주인 계정 · 격리 갈래 · 고아 하나 실패 · 통합 시험의 앱 자리 ────────────────────────────────

test("T1 op 상한 — 끝나지 않는 기다림은 상한에서 던진다 · 끝나면 그 값", async () => {
  //  늦게 끝나는 일(500ms — 붙잡는 타이머라 이벤트 루프가 먼저 끝나지 않는다) 에 상한 30ms. 상한 타이머는 프로세스를 붙잡지 않는다(unref).
  await assert.rejects(O.withTimeout(new Promise((r) => setTimeout(r, 500)), 30), /초 안에 끝나지 않았습니다/);
  assert.equal(await O.withTimeout(Promise.resolve(7), 1000), 7);
});

test("T2 로컬 op 가 상한을 넘으면 던진다(락을 쥔 쪽이 오래 붙잡히지 않게) · 상한 안이면 그대로", async () => {
  reset();
  await assert.rejects(area().run({ op: "scan", live: [], known: [] }, 1), /초 안에 끝나지 않았습니다/);
  assert.deepEqual(await area().run({ op: "scan", live: [], known: [] }), { exists: true, archives: [], orphans: [] }, "상한 안이면 그대로");
});

test("T3 지우기 시간 예산 — 다 못 지우면 «다음에 이어서» 로 남기고 지운 만큼은 지운다 · 다음 부름이 마저 지운다", async () => {
  reset();
  const a = O.archiveNameFor("big-app", NOW, "0000b1");
  for (let i = 0; i < 3000; i++) put(`${a}/d${i % 30}/f${i}.txt`, "x");
  const r1 = await run<RemoveResult>({ op: "remove", names: [a], rm_ms: 1 });
  assert.deepEqual(r1.removed, []);
  assert.equal(r1.left.length, 1);
  assert.match(r1.left[0]!.error, /시간이 모자라/);
  assert.deepEqual(r1.left[0]!.owners, [], "시간이 모자란 것은 주인 계정 차례가 아니다(권한 문제가 아니다)");
  assert.ok(exists(path.join(APPS, a)), "보관은 아직 있다");
  const r2 = await run<RemoveResult>({ op: "remove", names: [a] });
  assert.deepEqual(r2, { removed: [a], absent: [], left: [] }, "다음 부름이 이어서 다 지운다");
});

test("T4 두 곳이 함께 지워도(정비 · 비우기가 겹침) 둘 다 «지움 · 없음» 으로 끝난다 — 지우는 중 사라진 항목은 지운 것", async () => {
  for (let round = 0; round < 3; round++) {
    reset();
    const a = O.archiveNameFor("race-app", NOW, `0000c${round}`);
    for (let i = 0; i < 2000; i++) put(`${a}/d${i % 40}/f${i}.txt`, "x");
    const [r1, r2] = await Promise.all([run<RemoveResult>({ op: "remove", names: [a] }), run<RemoveResult>({ op: "remove", names: [a] })]);
    assert.deepEqual([...r1.left, ...r2.left], [], `겹친 지우기에서 남은 것(round ${round}): ${JSON.stringify([r1.left, r2.left])}`);
    assert.ok(r1.removed.includes(a) || r2.removed.includes(a), "적어도 한쪽은 지웠다고 말한다");
    assert.equal(exists(path.join(APPS, a)), false);
  }
});

test("K5 못 지운 까닭 — 시간 예산은 정비면 «다음 정비가 이어서», 비우기면 «다시 비우면 이어서» · 그 밖은 «지우지 못했습니다 — 까닭»", () => {
  assert.match(M.keptWhy({ error: "시간이 모자라 다 지우지 못했습니다", budget: true }, "prune"), /다음 정비가 이어서 지웁니다$/);
  assert.match(M.keptWhy({ error: "시간이 모자라 다 지우지 못했습니다", budget: true }, "clear"), /다시 비우면 이어서 지웁니다$/);
  assert.equal(M.keptWhy({ error: "EACCES: permission denied" }, "clear"), "지우지 못했습니다 — EACCES: permission denied");
  assert.ok(!/지우지 못했습니다 — 시간이/.test(M.keptWhy({ error: "시간이 모자라 다 지우지 못했습니다", budget: true }, "clear")), "문구가 겹치지 않는다");
});

test("C7 시간 예산 표식(budget)은 남은 것에 그대로 실려 나간다(부르는 쪽이 문구를 고른다)", async () => {
  const { a } = fakeArea([{ who: "gw", out: { removed: [], absent: [], left: [{ name: "x", error: "시간이 모자라 다 지우지 못했습니다", budget: true, owners: [] }] } }]);
  const r = await O.removeArchives(a, ["x"], async () => []);
  assert.deepEqual(r.left, [{ name: "x", error: "시간이 모자라 다 지우지 못했습니다", budget: true }]);
});

test("U1 주인 uid → 구성원 OS 계정 — 접두 box_ 만 · uid 가 맞는 줄만 · root(0)·음수·소수는 묻지 않음 · 겹치면 한 번", async () => {
  const asked: number[] = [];
  const passwd: Record<number, string> = {
    1001: "box_alice:x:1001:1001::/home/box_alice:/bin/bash\n",
    1002: "lively:x:1002:1002::/home/lively:/bin/bash",
    1003: "",
    1004: "box_eve:x:9999:9999::/home/box_eve:/bin/bash",   // 다른 uid 의 줄 — 쓰지 않는다
    1005: "box_bob:x:1005:1005::/home/box_bob:/bin/bash",
  };
  const users = await O.memberOsUsersOf([1001, 1001, 0, -3, 1.5, 1002, 1003, 1004, 1005], async (uid) => { asked.push(uid); return passwd[uid] ?? ""; });
  assert.deepEqual(users, ["box_alice", "box_bob"]);
  assert.deepEqual(asked, [1001, 1002, 1003, 1004, 1005]);
});

test("U2 자리 고르기 — 격리 박스는 LIVELY_APPS_DIR · 주인 계정 경로 있음 / 비격리는 TERMINAL_ROOT_APPS · 없음", () => {
  const iso = path.join(ROOT, "iso-apps");
  process.env.LIVELY_APPS_DIR = iso;
  try {
    assert.equal(O.appsAreaMode(), "plain", "이 시험 프로세스(중계 없음 · box-spawn 없음)는 비격리");
    const i = O.appsAreaFor(null, "isolated")!;
    assert.equal(i.base, iso);
    assert.ok(i.runAs, "격리면 주인 계정으로 다시 지울 길이 있다");
    const p = O.appsAreaFor(null, "plain")!;
    assert.equal(p.base, APPS);
    assert.equal(p.runAs, null);
  } finally { delete process.env.LIVELY_APPS_DIR; }
});

test("C6 지울 이름이 없으면 아무것도 부르지 않는다(정비가 보관 없는 워크스페이스에서 헬퍼를 깨우지 않는 둘째 겹)", async () => {
  let calls = 0;
  const a: Area = { base: "/x", run: async () => { calls++; return { removed: [], absent: [], left: [] } as never; }, runAs: null };
  assert.deepEqual(await O.removeArchives(a, []), { removed: [], absent: [], left: [] });
  assert.equal(calls, 0);
});

test("O1 고아 옮기기 — 하나가 실패해도(락 대기 초과) 까닭을 적고 나머지를 이어 간다 · 같은 id 의 앱이 있으면 건너뜀", async () => {
  const locked: string[] = [];
  const out = await M.archiveOrphanAppFolders(["aa-one", "bb-two", "cc-live", "dd-three", "BAD"], "admin", {
    lock: async (id, fn) => { locked.push(id); if (id === "bb-two") throw new Error("앱 설치 락 대기 시간 초과(bb-two)"); return fn(); },
    getApp: async (id) => (id === "cc-live" ? { id } : null),
    archive: async (id, o) => ({ archived: { name: `.archived-app.${id}.20261016T000000Z.000000`, app_id: id, archived_at: "", archived_by: o.by, entry: o.entry, kind: "dir", files: 1, bytes: 1, truncated: false, last_error: null, last_try_at: null } }),
  });
  assert.deepEqual(out.archived.map((a) => a.app_id), ["aa-one", "dd-three"], "실패 뒤의 것도 옮겼다");
  assert.ok(out.archived.every((a) => a.entry === "orphan" && a.archived_by === "admin"));
  const why = Object.fromEntries(out.skipped.map((s) => [s.app_id, s.why]));
  assert.match(why["bb-two"]!, /옮기지 못했습니다 — 앱 설치 락 대기 시간 초과/);
  assert.match(why["cc-live"]!, /같은 id 의 앱이 있습니다/);
  assert.match(why.BAD!, /앱 id 꼴이 아닙니다/);
  assert.deepEqual(locked, ["aa-one", "bb-two", "cc-live", "dd-three"], "꼴이 틀린 id 는 락도 잡지 않는다");
});

test("L4 앱을 만들고 지우는 통합 시험은 앱 폴더 자리를 임시 폴더로 고정한다(실제 ~/apps 를 옮기지 않게)", () => {
  const MAKES_OR_REMOVES = /org_app_install|"app_save"|org_app_remove|app_draft_remove|app_build_start|installLoadedApp|removeInstalledApp|seedBuiltinApps|archiveAppFolder|archiveOrphanAppFolders/;
  const all = (dir: string, re: RegExp): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" || e.name === "dist" ? [] : all(path.join(dir, e.name), re)) : re.test(e.name) ? [path.join(dir, e.name)] : []);
  const files = [...all("src", /\.pg-test\.mjs$/), ...all("scripts", /\.itest\.mjs$/)].filter((f) => MAKES_OR_REMOVES.test(src(f)));
  assert.ok(files.length >= 15, `(배선) 대상 시험을 실제로 찾았다: ${files.length}`);
  const bare = files.filter((f) => { const c = src(f); return !c.includes("test-apps-root.mjs") && !/process\.env\.TERMINAL_ROOT_APPS\s*=/.test(c); });
  assert.deepEqual(bare, [], "앱 자리를 고정하지 않은 통합 시험");
  //  모듈 자신 — 미리 정해 둔 값(.env · 셸)이 있어도 새 임시 폴더로 덮고, 두 값이 같은 그 폴더를 가리킨다(실제로 불러 본다)
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e",
    `process.env.TERMINAL_ROOT_APPS = "/preset/apps"; process.env.LIVELY_APPS_DIR = "/preset/iso"; await import(${JSON.stringify(path.resolve("scripts/test-apps-root.mjs"))}); `
    + "console.log(JSON.stringify([process.env.TERMINAL_ROOT_APPS, process.env.LIVELY_APPS_DIR]))"], { encoding: "utf8" });
  const [apps, iso] = JSON.parse(probe.stdout.trim() || "[]") as string[];
  assert.ok(apps && apps !== "/preset/apps" && apps.startsWith(os.tmpdir()), `미리 정한 값을 덮지 않았다: ${probe.stdout}${probe.stderr}`);
  assert.equal(iso, apps);
});

test.after(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });

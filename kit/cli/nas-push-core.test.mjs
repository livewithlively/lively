#!/usr/bin/env node
// nas-push-core 유닛 — NAS 로 올리기(childP·pOfPath·planLocal·nasPush)를 사양 기준으로 검증한다.
//  실행: node kit/cli/nas-push-core.test.mjs
//  네트워크 무접촉 — 게이트웨이 api·fetch 는 가짜 원격(폴더·파일 상태를 들고 있는 메모리 NAS), 로컬 파일은 임시 폴더 안에서만 쓰고 끝나면 지운다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { childP, pOfPath, planLocal, nasPush } from "./nas-push-core.mjs";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const tmpDirs = [];
// 올릴 수 있는 자리는 홈 아래뿐이라(resolveSrc) 시험용 홈을 두고 그 아래에 만든다. OUTSIDE 는 그 홈 밖이다.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "naspush-home-"));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "naspush-out-"));
tmpDirs.push(HOME, OUTSIDE);
const mkTmp = (prefix = "naspush-") => fs.mkdtempSync(path.join(HOME, prefix));
const real = (p) => fs.realpathSync(p);
const IS_WIN = process.platform === "win32";

/** base 아래에 파일·폴더를 만든다. 키가 / 로 끝나면 빈 폴더, 아니면 값(문자열·Buffer)을 내용으로 한 파일. */
function mkTree(base, spec) {
  for (const [rel, content] of Object.entries(spec)) {
    const full = path.join(base, ...rel.split("/").filter(Boolean));
    if (rel.endsWith("/")) fs.mkdirSync(full, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
}

// 가짜 원격의 p 계산은 구현의 childP 와 독립으로 둔다 — childP 가 틀리면 가짜 원격도 같이 틀려 버그가 숨지 않게.
const bytesOfP = (p) => Buffer.from(p, "base64url");
const pChild = (parentP, name) => {
  const parent = bytesOfP(parentP);
  const head = parent.equals(Buffer.from("/")) ? Buffer.alloc(0) : parent;
  return Buffer.concat([head, Buffer.from(`/${name.normalize("NFC")}`, "utf8")]).toString("base64url");
};
const pOf = (s) => Buffer.from(s, "utf8").toString("base64url");
const pJoin = (parentP, ...names) => names.reduce((p, n) => pChild(p, n), parentP);

const GATEWAY = "https://gw.test";
const TOKEN = "tok-push-1";
const UP = pOf("/Up");
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

async function readBody(b) {
  if (b == null) return Buffer.alloc(0);
  if (typeof b === "string") return Buffer.from(b);
  if (b instanceof Uint8Array) return Buffer.from(b);
  if (b instanceof ArrayBuffer) return Buffer.from(b);
  const chunks = [];
  for await (const c of b) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/**
 * 메모리 NAS. dirs·files 는 p 로 키를 잡는다.
 * - 업로드: 부모 폴더가 없거나 forbidAlways/forbidOnce 에 있으면 403, 같은 이름이 있고 overwrite 아니면 409 {size}, 아니면 저장 후 200 {path}.
 * - manage mkdir: 부모가 없으면 404, 이미 있으면 409 로 던진다(ctx.api 는 비정상 응답에 throw). list: 폴더가 있으면 성공.
 */
function mkRemote({ dirs = ["/", "/Up"] } = {}) {
  const remote = {
    dirs: new Set(dirs.map(pOf)),
    files: new Map(), // p → Buffer
    puts: [],
    apiCalls: [],
    forbidOnce: new Set(),
    forbidAlways: new Set(),
    manageFails: false,
    listFails: false,
    behave: null, // (call) => Response | undefined — 기본 동작 대신 돌려줄 응답
    onPut: null,
  };
  remote.fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const call = {
      url, init,
      dir: u.searchParams.get("dir"), name: u.searchParams.get("name"), overwrite: u.searchParams.get("overwrite"),
      headers: new Headers(init.headers),
      body: await readBody(init.body),
    };
    remote.puts.push(call);
    remote.onPut?.(call);
    const forced = remote.behave?.(call);
    if (forced) return forced;
    if (!remote.dirs.has(call.dir) || remote.forbidAlways.has(call.dir)) return json(403, { error: "forbidden" });
    if (remote.forbidOnce.delete(call.dir)) return json(403, { error: "forbidden" });
    const fp = pChild(call.dir, call.name);
    if (remote.files.has(fp) && call.overwrite !== "1") return json(409, { error: "exists", size: remote.files.get(fp).length });
    remote.files.set(fp, call.body);
    return json(200, { path: fp });
  };
  remote.ctx = (cwd = process.cwd()) => ({
    gateway: GATEWAY,
    token: TOKEN,
    cwd,
    api: async (apiPath, opts = {}) => {
      const body = typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
      remote.apiCalls.push({ path: apiPath, method: opts.method ?? "GET", body });
      if (apiPath === "/api/ui/me/nas/manage") {
        if (remote.manageFails) throw new Error("게이트웨이 500 (/api/ui/me/nas/manage)");
        if (body?.op !== "mkdir") throw new Error(`게이트웨이 400 (op ${body?.op})`);
        if (!remote.dirs.has(body.p)) throw new Error("게이트웨이 404 (/api/ui/me/nas/manage)");
        const child = pChild(body.p, body.name);
        if (remote.dirs.has(child)) throw new Error("게이트웨이 409 (/api/ui/me/nas/manage)");
        remote.dirs.add(child);
        return { ok: true, p: child };
      }
      if (apiPath.startsWith("/api/ui/me/nas/list?")) {
        const p = new URLSearchParams(apiPath.slice(apiPath.indexOf("?") + 1)).get("p");
        if (remote.listFails || !remote.dirs.has(p)) throw new Error("게이트웨이 404 (/api/ui/me/nas/list)");
        // 실제 nas_list 처럼 바로 아래 파일의 사람이 읽는 경로·크기를 준다
        const shown = (x) => Buffer.from(x, "base64url").toString("utf8");
        const parentOf = (x) => { const d = shown(x); const i = d.lastIndexOf("/"); return i <= 0 ? "/" : d.slice(0, i); };
        const items = [...remote.files].filter(([fp]) => parentOf(fp) === shown(p)).map(([fp, buf]) => ({ type: "file", path: shown(fp), size: buf.length, p: fp }));
        return { path: shown(p), items };
      }
      throw new Error(`게이트웨이 404 (${apiPath})`);
    },
  });
  remote.mkdirCalls = () => remote.apiCalls.filter((c) => c.path === "/api/ui/me/nas/manage");
  return remote;
}

const BASE_OPTS = { budgetMs: 1e9, now: () => 0, home: HOME, env: {} };
const push = (remote, args, opts = {}, cwd) =>
  nasPush(remote.ctx(cwd), args, { fetchImpl: remote.fetchImpl, ...BASE_OPTS, ...opts });

// ───────────────────────── childP·pOfPath ─────────────────────────

test("childP: 부모 p 바이트 뒤에 /이름(UTF-8 NFC) 을 이은 p, 부모가 / 면 / 를 겹치지 않는다", () => {
  const eucDir = Buffer.from([0x2f, 0xb9, 0xae, 0xbc, 0xad]); // "/문서" in EUC-KR
  const rows = [
    [pOfPath("/"), "a", "L2E"],
    [pOfPath("/"), "a", pOfPath("/a")],
    [pOfPath("/x"), "한글 문서.txt", pOfPath("/x/한글 문서.txt")],
    [pOfPath("/x"), "한글".normalize("NFD"), pOfPath("/x/한글")],
    [eucDir.toString("base64url"), "a b", Buffer.concat([eucDir, Buffer.from("/a b")]).toString("base64url")],
  ];
  for (const [parent, name, want] of rows) assert.equal(childP(parent, name), want, `${parent} + ${JSON.stringify(name)}`);
});

test("pOfPath: UTF-8 바이트의 패딩 없는 base64url, / 로 시작하지 않으면 붙인다", () => {
  const rows = [["/a", "L2E"], ["a", "L2E"], ["/x/한글", pOf("/x/한글")], ["x/한글", pOf("/x/한글")]];
  for (const [p, want] of rows) assert.equal(pOfPath(p), want, p);
});

// ───────────────────────── planLocal ─────────────────────────

test("planLocal: src 가 파일이면 dirs 없이 파일 하나(rel=[이름])", () => {
  const dir = mkTmp();
  const file = path.join(dir, "f.bin");
  fs.writeFileSync(file, Buffer.from([1, 2, 3, 4, 5]));
  const r = planLocal(file);
  assert.deepEqual({ ...r, files: r.files.map(({ local, ...rest }) => rest) },
    { dirs: [], files: [{ rel: ["f.bin"], size: 5 }], links: 0, hidden: 0, truncated: null });
  assert.equal(real(r.files[0].local), real(file));
});

test("planLocal: 폴더는 너비 우선으로 펼쳐 dirs·files 를 src 폴더 이름부터의 마디로", () => {
  const base = mkTmp();
  mkTree(base, { "A/a.txt": "1", "A/b/c.txt": "22", "A/b/d/e.txt": "333", "A/empty/": null });
  const r = planLocal(path.join(base, "A"));
  const key = (rel) => rel.join("/");
  assert.deepEqual(r.dirs.map(key).sort(), ["A", "A/b", "A/b/d", "A/empty"]);
  assert.deepEqual(r.files.map((f) => [key(f.rel), f.size]).sort(), [["A/a.txt", 1], ["A/b/c.txt", 2], ["A/b/d/e.txt", 3]]);
  for (const list of [r.dirs, r.files.map((f) => f.rel)]) {
    const depths = list.map((rel) => rel.length);
    assert.deepEqual(depths, [...depths].sort((x, y) => x - y), `너비 우선 순서: ${JSON.stringify(list)}`);
  }
  for (const f of r.files) assert.equal(fs.readFileSync(f.local, "utf8").length, f.size, key(f.rel));
  assert.equal(r.links, 0);
  assert.equal(r.truncated, null);
});

test("planLocal: 심볼릭 링크(폴더·파일)는 따라가지 않고 links 로, 숨김 항목(. 으로 시작)은 들어가지 않고 hidden 으로 센다", () => {
  const base = mkTmp();
  mkTree(base, { "A/real.txt": "r", "A/sub/x.txt": "x", "ext/y.txt": "y", "A/.env": "SECRET=1", "A/.git/config": "c", "A/sub/.npmrc": "t" });
  fs.symlinkSync(path.join(base, "ext"), path.join(base, "A", "linkdir"), "junction");
  // 파일 링크는 Windows 에서 관리자 권한이 필요해 POSIX 에서만 만든다
  if (!IS_WIN) fs.symlinkSync(path.join(base, "A", "real.txt"), path.join(base, "A", "filelink"));
  const r = planLocal(path.join(base, "A"));
  assert.equal(r.links, IS_WIN ? 1 : 2);
  assert.equal(r.hidden, 3);
  assert.deepEqual(r.files.map((f) => f.rel.join("/")).sort(), ["A/real.txt", "A/sub/x.txt"]);
  assert.deepEqual(r.dirs.map((d) => d.join("/")).sort(), ["A", "A/sub"]);
});

test("planLocal: src 자체가 링크면 Error", async () => {
  const base = mkTmp();
  mkTree(base, { "A/a.txt": "a" });
  fs.symlinkSync(path.join(base, "A"), path.join(base, "ln"), "junction");
  assert.throws(() => planLocal(path.join(base, "ln")));
});

test("planLocal: 파일 수가 maxFiles 에 닿으면 멈추고 truncated 에 사유", () => {
  const base = mkTmp();
  mkTree(base, Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`A/f${i}.txt`, "x"])));
  const r = planLocal(path.join(base, "A"), { maxFiles: 3 });
  assert.equal(r.files.length, 3);
  assert.equal(typeof r.truncated, "string");
  assert.ok(r.truncated.length > 0);
});

// ───────────────────────── nasPush ─────────────────────────

test("nasPush: src 가 없거나 dest_p·dest_path 가 둘 다 없으면 Error", async () => {
  const dir = mkTmp();
  const file = path.join(dir, "f.txt");
  fs.writeFileSync(file, "x");
  for (const args of [{}, { dest_path: "/Up" }, { dest_p: UP }, { src: file }]) {
    const remote = mkRemote();
    await assert.rejects(push(remote, args), Error, JSON.stringify(args));
    assert.equal(remote.puts.length, 0, JSON.stringify(args));
  }
});

test("nasPush: src 는 홈 아래만 — 홈 밖·홈 자체·숨김 마디·운영체제 비밀 자리·그쪽을 가리키는 링크는 아무것도 보내지 않고 Error", async () => {
  mkTree(OUTSIDE, { "o.txt": "o" });
  const base = mkTmp();
  mkTree(HOME, { ".ssh/id_ed25519": "k", ".aws/credentials": "c", "Library/Keychains/login.keychain-db": "kc", "AppData/Roaming/x.txt": "x" });
  mkTree(base, { "proj/.secret/token.txt": "t" });
  fs.symlinkSync(path.join(HOME, ".aws"), path.join(base, "docs"), "junction");
  fs.symlinkSync(OUTSIDE, path.join(base, "out"), "junction");
  const rows = [
    ["홈 밖", path.join(OUTSIDE, "o.txt")],
    ["홈 자체", HOME],
    ["숨김 폴더(~/.ssh)", path.join(HOME, ".ssh")],
    ["숨김 폴더 안 파일", path.join(HOME, ".aws", "credentials")],
    ["숨김 마디를 거친 파일", path.join(base, "proj", ".secret", "token.txt")],
    ["맥 Library", path.join(HOME, "Library", "Keychains")],
    ["윈도우 AppData", path.join(HOME, "AppData", "Roaming", "x.txt")],
    ["링크를 거쳐 숨김 폴더로", path.join(base, "docs", "credentials")],
    ["링크를 거쳐 홈 밖으로", path.join(base, "out", "o.txt")],
  ];
  for (const [label, src] of rows) {
    const remote = mkRemote();
    await assert.rejects(push(remote, { src, dest_path: "/Up" }), Error, label);
    assert.equal(remote.puts.length + remote.apiCalls.length, 0, `${label}: 게이트웨이를 부르지 않는다`);
  }
});

test("nasPush: 읽기전용·인코그니토 세션(LIVELY_MODE)이면 아무것도 보내지 않고 Error, 그 밖엔 올리기에 모드 머리글을 싣는다", async () => {
  const dir = mkTmp();
  const file = path.join(dir, "m.txt");
  fs.writeFileSync(file, "m");
  for (const mode of ["readonly", "incognito", " ReadOnly "]) {
    const remote = mkRemote();
    await assert.rejects(push(remote, { src: file, dest_path: "/Up" }, { env: { LIVELY_MODE: mode } }), Error, mode);
    assert.equal(remote.puts.length + remote.apiCalls.length, 0, `${mode}: 게이트웨이를 부르지 않는다`);
  }
  const remote = mkRemote();
  await push(remote, { src: file, dest_path: "/Up" }, { env: { LIVELY_MODE: "normal" } });
  assert.equal(remote.puts[0].headers.get("x-lively-mode"), "normal");
});

test("nasPush: 파일 하나를 dest(p 또는 경로) 아래로 PUT upload — 주소·헤더·본문 바이트와 결과 필드", async () => {
  const dir = mkTmp();
  const name = "한글 문서.txt";
  const file = path.join(dir, name);
  const bytes = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256));
  fs.writeFileSync(file, bytes);
  for (const dest of [{ dest_p: UP }, { dest_path: "/Up" }]) {
    const label = JSON.stringify(dest);
    const remote = mkRemote();
    const r = await push(remote, { src: file, ...dest });
    assert.equal(remote.puts.length, 1, label);
    const c = remote.puts[0];
    const u = new URL(c.url);
    assert.equal(u.origin + u.pathname, `${GATEWAY}/api/ui/me/nas/upload`, label);
    assert.ok(c.url.includes(`dir=${encodeURIComponent(UP)}`) && c.url.includes(`name=${encodeURIComponent(name)}`), c.url);
    assert.equal(c.dir, UP, label);
    assert.equal(c.name, name, label);
    assert.equal(c.overwrite, null, label);
    assert.equal(c.init.method, "PUT", label);
    assert.equal(c.headers.get("authorization"), `Bearer ${TOKEN}`, label);
    assert.equal(c.headers.get("content-length"), String(bytes.length), label);
    assert.equal(c.init.duplex, "half", label);
    assert.ok(c.body.equals(bytes), `${label}: 본문 바이트`);
    assert.ok(path.isAbsolute(r.src), r.src);
    assert.equal(real(r.src), real(file), label);
    const { done, planned, uploaded, skipped, conflicts, remaining, bytes: sent, skipped_links, truncated, failed } = r;
    assert.deepEqual({ done, planned, uploaded, skipped, conflicts, remaining, bytes: sent, skipped_links, truncated, failed },
      { done: true, planned: 1, uploaded: 1, skipped: 0, conflicts: [], remaining: 0, bytes: bytes.length, skipped_links: 0, truncated: null, failed: [] }, label);
    assert.ok(remote.files.get(pChild(UP, name))?.equals(bytes), `${label}: 원격에 저장`);
  }
});

test("nasPush: 상대 src 는 ctx.cwd 기준, 결과 src 는 절대경로", async () => {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, "rel.txt"), "abc");
  const remote = mkRemote();
  const r = await push(remote, { src: "rel.txt", dest_path: "/Up" }, {}, dir);
  assert.ok(path.isAbsolute(r.src), r.src);
  assert.equal(real(r.src), real(path.join(dir, "rel.txt")));
  assert.equal(r.uploaded, 1);
});

test("nasPush: NAS 에 같은 이름·같은 크기 파일이 있으면 overwrite 가 참일 때만 &overwrite=1 로 덮어 올리고, 아니면 건너뛴다", async () => {
  const dir = mkTmp();
  const file = path.join(dir, "c.txt");
  fs.writeFileSync(file, "NEWXY");
  for (const [overwrite, uploaded] of [[undefined, 0], [false, 0], [true, 1]]) {
    const remote = mkRemote();
    remote.files.set(pChild(UP, "c.txt"), Buffer.from("oldab"));
    const r = await push(remote, { src: file, dest_path: "/Up", overwrite });
    const label = `overwrite=${overwrite}`;
    assert.equal(r.uploaded, uploaded, label);
    assert.equal(r.skipped, 1 - uploaded, label);
    assert.equal(remote.puts.length, uploaded, label);
    if (uploaded) assert.ok(remote.puts[0].url.endsWith("&overwrite=1"), remote.puts[0].url);
    assert.equal(remote.files.get(pChild(UP, "c.txt")).toString(), uploaded ? "NEWXY" : "oldab", label);
  }
});

test("nasPush: NAS 에 같은 이름이 있으면 크기가 같으면 skipped, 다르면 conflicts 로 남기고 올리지 않는다 — 폴더 목록에서 보면 본문을 안 보내고, 목록에서 못 보면 409 로 가른다", async () => {
  const dir = mkTmp();
  const file = path.join(dir, "c.txt");
  fs.writeFileSync(file, "12345");
  const rows = [
    ["같은 크기", Buffer.from("abcde"), { skipped: 1, conflicts: 0 }],
    ["다른 크기", Buffer.from("abc"), { skipped: 0, conflicts: 1 }],
  ];
  for (const seen of [true, false]) for (const [label0, nasBytes, want] of rows) {
    const label = `${label0}·목록에서 ${seen ? "봄" : "못 봄"}`;
    const remote = mkRemote();
    remote.listFails = !seen; // 못 본 경우: 목록 직후 다른 사람이 만든 파일 등
    remote.files.set(pChild(UP, "c.txt"), nasBytes);
    const r = await push(remote, { src: file, dest_path: "/Up" });
    assert.equal(r.uploaded, 0, label);
    assert.equal(r.skipped, want.skipped, label);
    assert.equal(r.conflicts.length, want.conflicts, label);
    assert.equal(remote.puts.length, seen ? 0 : 1, `${label}: 본문은 많아야 한 번(409)`);
    assert.ok(remote.files.get(pChild(UP, "c.txt")).equals(nasBytes), `${label}: 원격 그대로`);
    if (want.conflicts) {
      const c = r.conflicts[0];
      assert.equal(typeof c.path, "string");
      assert.equal(c.local_size, 5);
      assert.equal(c.nas_size, 3);
    }
  }
});

test("nasPush: 폴더 src 는 rel 의 폴더 마디를 이은 부모 p 로 올리고, 403 이면 부모 경로 단계마다 mkdir 한 뒤 다시 올린다", async () => {
  const base = mkTmp();
  mkTree(base, { "A/a.txt": "aa", "A/b/c.txt": "ccc" });
  const remote = mkRemote();
  const r = await push(remote, { src: path.join(base, "A"), dest_path: "/Up" });
  assert.equal(r.uploaded, 2);
  assert.deepEqual(r.failed, []);
  assert.equal(r.done, true);
  assert.equal(r.bytes, 5);
  assert.equal(remote.files.get(pJoin(UP, "A", "a.txt"))?.toString(), "aa");
  assert.equal(remote.files.get(pJoin(UP, "A", "b", "c.txt"))?.toString(), "ccc");
  const mk = remote.mkdirCalls();
  for (const c of mk) {
    assert.equal(c.method, "POST");
    assert.deepEqual(Object.keys(c.body).sort(), ["name", "op", "p"]);
    assert.equal(c.body.op, "mkdir");
  }
  const pairs = mk.map((c) => `${c.body.p}|${c.body.name}`);
  assert.ok(pairs.includes(`${UP}|A`), pairs.join(", "));
  assert.ok(pairs.includes(`${pJoin(UP, "A")}|b`), pairs.join(", "));
  for (const call of remote.puts.filter((c) => c.name === "c.txt")) assert.equal(call.dir, pJoin(UP, "A", "b"));
});

test("nasPush: 목록이 열리는(이미 있는) 폴더에서 403 이면 권한 문제로 보고 폴더를 만들거나 다시 올리지 않는다", async () => {
  // 올리기 전 폴더 목록을 읽어 있는 폴더를 안다 — 거기서 403 은 «폴더 없음»이 아니라 쓰기 권한 없음이다
  const base = mkTmp();
  mkTree(base, { "A/a.txt": "aa" });
  const remote = mkRemote({ dirs: ["/", "/Up", "/Up/A"] });
  remote.forbidOnce.add(pJoin(UP, "A"));
  const r = await push(remote, { src: path.join(base, "A"), dest_path: "/Up" });
  assert.equal(r.uploaded, 0);
  assert.ok(r.failed.some((x) => String(x.path).endsWith("a.txt")), JSON.stringify(r.failed));
  assert.equal(remote.puts.length, 1);
  assert.equal(remote.mkdirCalls().length, 0);
});

test("nasPush: 폴더를 끝내 못 만들면(mkdir·list 모두 실패) 그 파일은 failed", async () => {
  const base = mkTmp();
  mkTree(base, { "A/a.txt": "aa" });
  const remote = mkRemote();
  remote.manageFails = true;
  remote.listFails = true;
  const r = await push(remote, { src: path.join(base, "A"), dest_path: "/Up" });
  assert.equal(r.uploaded, 0);
  // 폴더 실패를 따로 남기는 것은 사양이 막지 않는다 — 파일 항목이 failed 에 있는지만 본다
  const f = r.failed.find((x) => typeof x.path === "string" && x.path.endsWith("a.txt"));
  assert.ok(f, JSON.stringify(r.failed));
  assert.ok(f.error, "error 가 있어야 함");
});

test("nasPush: 있는 폴더가 계속 403 이면 파일마다 한 번만 시도하고 failed", async () => {
  const base = mkTmp();
  mkTree(base, { "A/a1.txt": "1", "A/a2.txt": "2" });
  const remote = mkRemote({ dirs: ["/", "/Up", "/Up/A"] });
  remote.forbidAlways.add(pJoin(UP, "A"));
  const r = await push(remote, { src: path.join(base, "A"), dest_path: "/Up" });
  assert.equal(r.uploaded, 0);
  for (const n of ["a1.txt", "a2.txt"]) assert.ok(r.failed.some((x) => String(x.path).endsWith(n)), `${n}: ${JSON.stringify(r.failed)}`);
  assert.equal(remote.puts.length, 2, "파일마다 한 번씩만 올려 보고 다시 올리지 않는다");
  assert.equal(remote.mkdirCalls().filter((c) => c.body.name === "A").length, 0, "있는 폴더는 만들러 가지 않는다");
});

test("nasPush: 그 밖의 비정상 응답·fetch 예외는 failed 에 {path, error}", async () => {
  const dir = mkTmp();
  const file = path.join(dir, "e.txt");
  fs.writeFileSync(file, "e");
  const rows = [
    ["500", () => json(500, { error: "boom" })],
    ["401", () => json(401, { error: "unauthorized" })],
    ["예외", () => { throw new Error("network down"); }],
  ];
  for (const [label, behave] of rows) {
    const remote = mkRemote();
    remote.behave = behave;
    const r = await push(remote, { src: file, dest_path: "/Up" });
    assert.equal(r.uploaded, 0, label);
    assert.equal(r.failed.length, 1, label);
    assert.equal(typeof r.failed[0].path, "string", label);
    assert.ok(r.failed[0].error, `${label}: error`);
  }
});

test("nasPush: budgetMs 를 넘긴 뒤엔 새 파일을 시작하지 않고 remaining 에 남기며, 다시 부르면 이어서 끝낸다", async () => {
  const base = mkTmp();
  mkTree(base, Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`A/f${i}.txt`, `x${i}`])));
  const remote = mkRemote({ dirs: ["/", "/Up", "/Up/A"] });
  let clock = 0;
  remote.onPut = () => { clock += 10; };
  const opts = { budgetMs: 25, now: () => clock };
  const first = await push(remote, { src: path.join(base, "A"), dest_path: "/Up" }, opts);
  assert.equal(first.done, false);
  assert.equal(first.planned, 5);
  assert.ok(first.uploaded >= 1 && first.remaining >= 1, JSON.stringify({ uploaded: first.uploaded, remaining: first.remaining }));
  assert.equal(first.uploaded + first.remaining, 5);
  assert.ok(first.uploaded < 5);
  const second = await push(remote, { src: path.join(base, "A"), dest_path: "/Up" });
  assert.equal(second.done, true);
  assert.equal(second.remaining, 0);
  assert.equal(second.skipped, first.uploaded);
  assert.equal(second.uploaded, first.remaining);
  assert.equal(remote.files.size, 5);
});

test("nasPush: 파일 없는 폴더는 다 올린 호출에서만 mkdir 로 만든다", async () => {
  const base = mkTmp();
  mkTree(base, { "A/x/y/z.txt": "z", "A/x/w.txt": "w", "A/e1/e2/": null });
  const remote = mkRemote();
  const src = path.join(base, "A");
  const e1 = pJoin(UP, "A", "e1");
  const e2 = pJoin(UP, "A", "e1", "e2");
  let t = 0;
  const first = await push(remote, { src, dest_path: "/Up" }, { budgetMs: 50, now: () => (t += 100) });
  assert.equal(first.done, false);
  assert.ok(!remote.dirs.has(e1) && !remote.dirs.has(e2), "끝나지 않은 호출에서는 빈 폴더를 만들지 않는다");
  const second = await push(remote, { src, dest_path: "/Up" });
  assert.equal(second.done, true);
  assert.ok(remote.dirs.has(e1), "e1");
  assert.ok(remote.dirs.has(e2), "e2");
});

test("nasPush: conflicts·failed 는 최대 50, files 는 최대 100 건(개수 필드는 그대로)", async () => {
  const base = mkTmp();
  const N = 120;
  mkTree(base, Object.fromEntries(Array.from({ length: N }, (_, i) => [`A/f${i}.txt`, "12345"])));
  const src = path.join(base, "A");
  const rows = [
    ["failed", (remote) => { remote.behave = () => json(500, { error: "boom" }); }, (r) => r.failed.length, 50, (r) => r.uploaded, 0],
    ["conflicts", (remote) => { for (let i = 0; i < N; i++) remote.files.set(pJoin(UP, "A", `f${i}.txt`), Buffer.from("123")); },
      (r) => r.conflicts.length, 50, (r) => r.uploaded, 0],
    ["files", () => {}, (r) => r.files.length, 100, (r) => r.uploaded, N],
  ];
  for (const [label, setup, listLen, cap, count, wantCount] of rows) {
    const remote = mkRemote({ dirs: ["/", "/Up", "/Up/A"] });
    setup(remote);
    const r = await push(remote, { src, dest_path: "/Up" });
    assert.equal(r.planned, N, label);
    assert.equal(listLen(r), cap, label);
    assert.equal(count(r), wantCount, `${label}: uploaded`);
  }
});

test("nasPush: 같은 호출을 다시 하면 이미 올린 파일은 본문을 다시 보내지 않고 skipped 로 끝난다", async () => {
  const base = mkTmp();
  mkTree(base, { "A/a.txt": "aa", "A/b/c.txt": "ccc" });
  const remote = mkRemote();
  const args = { src: path.join(base, "A"), dest_path: "/Up" };
  await push(remote, args);
  const putsAfterFirst = remote.puts.length;
  const r = await push(remote, args);
  assert.equal(remote.puts.length, putsAfterFirst, "두 번째 호출은 PUT 0건(폴더 목록의 크기로 건너뜀)");
  assert.deepEqual({ done: r.done, uploaded: r.uploaded, skipped: r.skipped, conflicts: r.conflicts, failed: r.failed },
    { done: true, uploaded: 0, skipped: 2, conflicts: [], failed: [] });
});

// ───────────────────────── runner ─────────────────────────

let pass = 0, fail = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    console.error(`  FAIL ${name}\n       ${e?.stack?.split("\n").slice(0, 3).join("\n       ") ?? e}`);
  }
}
for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
console.error(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

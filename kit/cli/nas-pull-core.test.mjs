#!/usr/bin/env node
// nas-pull-core 유닛 — NAS 사본 받기(safeSegment·pOfPath·resolveDest·planFiles·pullFiles·nasPull)를 사양 기준으로 검증한다.
//  실행: node kit/cli/nas-pull-core.test.mjs
//  네트워크 무접촉 — 게이트웨이 api·fetch 는 가짜, 파일시스템은 임시 home 안에서만 쓰고 끝나면 지운다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeSegment, pOfPath, resolveDest, planFiles, pullFiles, nasPull, modeHeader } from "./nas-pull-core.mjs";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const tmpDirs = [];
// 실제 경로로 돌려준다 — 맥 기본 TMPDIR(/var/folders → /private/var/folders)는 링크라, 실제 경로를 돌려주는 코드와 비교가 갈린다.
const mkTmp = (prefix = "naspull-") => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(d);
  return d;
};
const real = (p) => fs.realpathSync(p);
const exists = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, "utf8");

async function throws(fn) {
  try { await fn(); } catch { return true; }
  return false;
}

// 실패 스트림 응답 — 첫 바이트 뒤 에러.
const brokenResponse = () => new Response(new ReadableStream({
  start(c) { c.enqueue(new Uint8Array([1])); c.error(new Error("x")); },
}));

// ───────────────────────── safeSegment ─────────────────────────

test("safeSegment: 금지문자·제어문자를 _ 로, 끝의 점·공백 제거, 정상 이름 보존", () => {
  const rows = [
    ['a<b>c:d"e/f\\g|h?i*j', "a_b_c_d_e_f_g_h_i_j"],
    ["x\u0000y\u0001z\u001fw", "x_y_z_w"],
    ["name. ", "name"],
    ["file...", "file"],
    ["trail   ", "trail"],
    ["a.b c.txt", "a.b c.txt"],
  ];
  for (const [input, want] of rows) assert.equal(safeSegment(input), want, JSON.stringify(input));
});

test("safeSegment: 빈 문자열·. ·.. ·점/공백뿐인 이름은 null", () => {
  for (const input of ["", ".", "..", "...", "   ", ". ."]) {
    assert.equal(safeSegment(input), null, JSON.stringify(input));
  }
});

test("safeSegment: NFD 한글을 NFC 로 정규화", () => {
  const nfd = "한글문서.pdf".normalize("NFD");
  assert.notEqual(nfd, "한글문서.pdf");
  assert.equal(safeSegment(nfd), "한글문서.pdf".normalize("NFC"));
});

// ───────────────────────── pOfPath ─────────────────────────

test("pOfPath: 서버 p 와 같은 꼴(UTF-8 바이트의 패딩 없는 base64url), / 로 시작하지 않으면 붙인다", () => {
  // 게이트웨이 encodeRawPath(src/net/ftp/ftp-list.ts)와의 외부 계약이라 리터럴로 고정한다 — 서버 쪽 값이 바뀌면 여기가 깨져야 한다
  const vectors = [["/a", "L2E"], ["a", "L2E"], ["/ABC", "L0FCQw"], ["/공유/x", "L-qzteycoC94"], ["/ab?>~", "L2FiPz5-"]];
  for (const [path, want] of vectors) assert.equal(pOfPath(path), want, path);
});

// ───────────────────────── resolveDest ─────────────────────────

test("modeHeader: LIVELY_MODE 를 게이트웨이 모드 머리글(x-lively-mode)로 — 없으면 머리글도 없다", () => {
  assert.deepEqual(modeHeader({ LIVELY_MODE: " Incognito " }), { "x-lively-mode": "incognito" });
  assert.deepEqual(modeHeader({ LIVELY_MODE: "readonly" }), { "x-lively-mode": "readonly" });
  assert.deepEqual(modeHeader({}), {});
});

test("resolveDest: dest 없으면 <home 실제경로>/NAS사본, 폴더는 만들지 않음", async () => {
  const home = mkTmp();
  const got = await resolveDest(undefined, home);
  assert.equal(got, path.join(real(home), "NAS사본"));
  assert.equal(exists(path.join(home, "NAS사본")), false);
});

test("resolveDest: 상대 경로는 <home>/NAS사본 기준, 절대 경로(home 안)는 그대로", async () => {
  const home = mkTmp();
  const rows = [
    ["x/y", path.join(real(home), "NAS사본", "x", "y")],
    ["../형제", path.join(real(home), "형제")],
    [path.join(home, "abs", "dir"), path.join(real(home), "abs", "dir")],
  ];
  for (const [dest, want] of rows) assert.equal(await resolveDest(dest, home), want, dest);
  assert.equal(exists(path.join(home, "NAS사본")), false);
  assert.equal(exists(path.join(home, "abs")), false);
});

test("resolveDest: home 밖·home 자체·.. 탈출은 Error", async () => {
  const home = mkTmp();
  const outside = mkTmp("naspull-out-");
  const rows = [
    home,                       // home 자체(절대)
    "..",                       // NAS사본/.. = home 자체
    "../..",                    // home 의 부모
    "../../../../../../etc",    // .. 로 탈출
    outside,                    // 다른 절대 경로
    path.join(outside, "x"),
    "/",
  ];
  for (const dest of rows) assert.ok(await throws(() => resolveDest(dest, home)), `거부되어야 함: ${dest}`);
});

test("resolveDest: home 밖을 가리키는 심볼릭 링크를 거치면 Error", async () => {
  const home = mkTmp();
  const outside = mkTmp("naspull-out-");
  fs.symlinkSync(outside, path.join(home, "link"), "junction"); // junction: 윈도우 CI 에서 권한 없이 만들어진다(POSIX 는 type 무시)
  assert.ok(await throws(() => resolveDest(path.join(home, "link", "sub"), home)));
  assert.ok(await throws(() => resolveDest(path.join(home, "link"), home)));
});

// ───────────────────────── planFiles ─────────────────────────

// tree: p → {items}. 없는 p 는 reject.
const mkListDir = (tree, calls = []) => async (p) => {
  calls.push(p);
  if (!(p in tree)) throw new Error(`no such dir ${p}`);
  return { items: tree[p] };
};

test("planFiles: file 대상은 rel=[파일 이름] 한 건, 폴더는 열지 않음", async () => {
  const calls = [];
  const r = await planFiles([{ p: "pf", path: "/A/x.pdf", type: "file", size: 5 }], mkListDir({}, calls));
  assert.deepEqual(r.files, [{ p: "pf", path: "/A/x.pdf", size: 5, rel: ["x.pdf"] }]);
  assert.deepEqual(r.failed, []);
  assert.equal(r.truncated, null);
  assert.equal(r.dirs, 0);
  assert.deepEqual(calls, []);
});

test("planFiles: dir 대상은 너비 우선으로 파일만, rel 은 대상 폴더 이름부터, 모르는 type 무시", async () => {
  const tree = {
    pB: [
      { p: "pc", path: "/A/B/c", type: "dir", size: 0 },
      { p: "pe", path: "/A/B/e.txt", type: "file", size: 3 },
      { p: "pl", path: "/A/B/link", type: "symlink", size: 1 },
    ],
    pc: [{ p: "pd", path: "/A/B/c/d.pdf", type: "file", size: 7 }],
  };
  const r = await planFiles([{ p: "pB", path: "/A/B", type: "dir" }], mkListDir(tree));
  assert.deepEqual(r.files, [
    { p: "pe", path: "/A/B/e.txt", size: 3, rel: ["B", "e.txt"] },
    { p: "pd", path: "/A/B/c/d.pdf", size: 7, rel: ["B", "c", "d.pdf"] },
  ]);
  assert.deepEqual(r.failed, []);
  assert.equal(r.truncated, null);
  assert.equal(r.dirs, 2);
});

test("planFiles: 하위 폴더 listDir 실패는 failed{path,error} 로 남기고 나머지 계속", async () => {
  const tree = {
    pA: [
      { p: "pX", path: "/A/X", type: "dir", size: 0 },
      { p: "pY", path: "/A/Y", type: "dir", size: 0 },
    ],
    pY: [{ p: "py", path: "/A/Y/y.txt", type: "file", size: 1 }],
  };
  const r = await planFiles([{ p: "pA", path: "/A", type: "dir" }], mkListDir(tree));
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].path, "/A/X");
  assert.ok(r.failed[0].error, "error 가 비어 있지 않음");
  assert.deepEqual(r.files, [{ p: "py", path: "/A/Y/y.txt", size: 1, rel: ["A", "Y", "y.txt"] }]);
});

test("planFiles: 파일이 maxFiles 에 닿으면 멈추고 truncated 에 사유 문자열", async () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ p: `f${i}`, path: `/D/f${i}`, type: "file", size: 1 }));
  const r = await planFiles([{ p: "pD", path: "/D", type: "dir" }], mkListDir({ pD: items }), { maxFiles: 3 });
  assert.equal(r.files.length, 3);
  assert.equal(typeof r.truncated, "string");
  assert.ok(r.truncated.length > 0);
});

test("planFiles: 폴더를 maxDirs 개 넘게 열지 않고 truncated 에 사유", async () => {
  // 사슬: d0 → d1 → d2 → d3 → d4, 각 폴더에 파일 하나.
  const tree = {};
  for (let i = 0; i < 5; i++) {
    tree[`d${i}`] = [{ p: `f${i}`, path: `/d0/.../f${i}`, type: "file", size: 1 }];
    if (i < 4) tree[`d${i}`].push({ p: `d${i + 1}`, path: `/d${i + 1}`, type: "dir", size: 0 });
  }
  const calls = [];
  const r = await planFiles([{ p: "d0", path: "/d0", type: "dir" }], mkListDir(tree, calls), { maxDirs: 2 });
  assert.ok(calls.length <= 2, `listDir 호출 ${calls.length}회`);
  assert.ok(r.dirs <= 2, `dirs=${r.dirs}`);
  assert.equal(typeof r.truncated, "string");
});

test("planFiles: 폴더 나열도 시간 한도(deadline)를 지켜 넘으면 멈추고 truncated 에 사유", async () => {
  // 회귀: 나열 단계가 예산 밖이라 큰 폴더에서 호출이 수십 분 붙잡혔다
  const tree = {};
  for (let i = 0; i < 50; i++) {
    tree[`d${i}`] = [{ p: `f${i}`, path: `/d0/f${i}`, type: "file", size: 1 }];
    if (i < 49) tree[`d${i}`].push({ p: `d${i + 1}`, path: `/d0/d${i + 1}`, type: "dir", size: 0 });
  }
  let t = 0;
  const calls = [];
  const slow = async (p) => { t += 10; return mkListDir(tree, calls)(p); };
  const r = await planFiles([{ p: "d0", path: "/d0", type: "dir" }], slow, { now: () => t, deadline: 35 });
  assert.ok(calls.length <= 5, `listDir 호출 ${calls.length}회`);
  assert.equal(typeof r.truncated, "string");
});

// ───────────────────────── pullFiles ─────────────────────────

const mkDownload = (map, calls = []) => async (p) => {
  calls.push(p);
  const v = map[p];
  return typeof v === "function" ? v() : new Response(v);
};

test("pullFiles: safeSegment 한 rel 경로에 쓰고 중간 폴더 생성, downloaded·bytes 집계", async () => {
  const root = mkTmp();
  const files = [
    { p: "p1", path: "/A/a.txt", size: 3, rel: ["A", "a.txt"] },
    { p: "p2", path: "/A/s:b/c?.txt", size: 2, rel: ["A", "s:b", "c?.txt"] },
  ];
  const r = await pullFiles(files, root, mkDownload({ p1: "abc", p2: "xy" }), { now: () => 0 });
  const a = path.join(root, "A", "a.txt");
  const b = path.join(root, "A", "s_b", "c_.txt");
  assert.equal(read(a), "abc");
  assert.equal(read(b), "xy");
  assert.deepEqual([...r.downloaded].sort(), [a, b].sort());
  assert.equal(r.bytes, 5);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.failed, []);
  assert.equal(r.remaining, 0);
});

test("pullFiles: rel 마디 중 safeSegment null 이 있으면 받지 않고 failed", async () => {
  // root 를 새 임시 폴더 안에 둬서 ".." 탈출 흔적을 남의 파일과 섞이지 않게 본다.
  const outer = mkTmp();
  const root = path.join(outer, "root");
  fs.mkdirSync(root);
  const calls = [];
  const files = [
    { p: "bad", path: "/x", size: 1, rel: ["..", "x"] },
    { p: "ok", path: "/y", size: 1, rel: ["y"] },
  ];
  const r = await pullFiles(files, root, mkDownload({ bad: "z", ok: "y" }, calls), { now: () => 0 });
  assert.deepEqual(calls, ["ok"]);
  assert.equal(r.failed.length, 1);
  assert.equal(r.downloaded.length, 1);
  assert.equal(exists(path.join(root, "..", "x")), false);
});

test("pullFiles: 같은 크기 기존 파일은 download 없이 skipped, size null 이나 크기 다르면 다시 받아 덮어씀", async () => {
  const root = mkTmp();
  fs.writeFileSync(path.join(root, "same.txt"), "abc");
  fs.writeFileSync(path.join(root, "nullsize.txt"), "abc");
  fs.writeFileSync(path.join(root, "diff.txt"), "zzzzz");
  const calls = [];
  const files = [
    { p: "s", path: "/same.txt", size: 3, rel: ["same.txt"] },
    { p: "n", path: "/nullsize.txt", size: null, rel: ["nullsize.txt"] },
    { p: "d", path: "/diff.txt", size: 3, rel: ["diff.txt"] },
  ];
  const r = await pullFiles(files, root, mkDownload({ s: "XXX", n: "new", d: "abc" }, calls), { now: () => 0 });
  assert.deepEqual([...calls].sort(), ["d", "n"]);
  assert.equal(r.skipped, 1);
  assert.equal(read(path.join(root, "same.txt")), "abc");
  assert.equal(read(path.join(root, "nullsize.txt")), "new");
  assert.equal(read(path.join(root, "diff.txt")), "abc");
  assert.equal(r.downloaded.length, 2);
});

test("pullFiles: 응답이 ok 가 아니면 failed, 파일을 만들지 않고 다음 파일 계속", async () => {
  const root = mkTmp();
  const files = [
    { p: "e", path: "/err.txt", size: 3, rel: ["err.txt"] },
    { p: "o", path: "/ok.txt", size: 2, rel: ["ok.txt"] },
  ];
  const dl = mkDownload({ e: () => new Response("nope", { status: 500 }), o: "ok" });
  const r = await pullFiles(files, root, dl, { now: () => 0 });
  assert.equal(r.failed.length, 1);
  assert.equal(exists(path.join(root, "err.txt")), false);
  assert.equal(read(path.join(root, "ok.txt")), "ok");
  assert.equal(r.downloaded.length, 1);
});

test("pullFiles: 쓰는 중 스트림 실패면 반쪽 파일을 남기지 않고 기존 파일은 보존", async () => {
  const root = mkTmp();
  fs.writeFileSync(path.join(root, "keep.txt"), "original");
  const files = [
    { p: "n", path: "/new.bin", size: 10, rel: ["new.bin"] },
    { p: "k", path: "/keep.txt", size: 3, rel: ["keep.txt"] },
    { p: "o", path: "/after.txt", size: 1, rel: ["after.txt"] },
  ];
  const r = await pullFiles(files, root, mkDownload({ n: brokenResponse, k: brokenResponse, o: "a" }), { now: () => 0 });
  assert.equal(exists(path.join(root, "new.bin")), false);
  assert.equal(read(path.join(root, "keep.txt")), "original");
  assert.equal(read(path.join(root, "after.txt")), "a");
  assert.equal(r.failed.length, 2);
  assert.equal(r.downloaded.length, 1);
  // 실패한 두 파일의 흔적(임시 이름 포함)이 폴더에 하나도 남지 않는다 — 남는 것은 원래 있던 것과 성공한 것뿐
  assert.deepEqual(fs.readdirSync(root).sort(), ["after.txt", "keep.txt"]);
});

test("pullFiles: 받는 폴더 안의 하위 폴더가 홈 밖을 가리키는 링크면 그 밖에 쓰지 않고 failed", async () => {
  // 회귀: 루트만 검사해 dest/B -> 바깥 링크를 따라 바깥에 파일을 만들었다
  const root = mkTmp();
  const outside = mkTmp("naspull-out-");
  fs.symlinkSync(outside, path.join(root, "B"), "junction");
  const r = await pullFiles([{ p: "x", path: "/B/x.txt", size: 1, rel: ["B", "x.txt"] }], fs.realpathSync(root), mkDownload({ x: "a" }), { now: () => 0 });
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(r.downloaded.length, 0);
  assert.equal(r.failed.length, 1);
});

test("pullFiles: 받는 자리 옆 임시 파일 이름에 밖을 가리키는 링크가 있어도 밖의 파일을 건드리지 않는다", async () => {
  // 회귀: 임시 파일(.part)을 링크를 따라 열어 홈 밖 파일을 덮어썼다. 임시 이름 규칙에 기대지 않게 흔한 후보를 다 깐다.
  const root = fs.realpathSync(mkTmp());
  const outside = mkTmp("naspull-out-");
  const victim = path.join(outside, "victim");
  fs.writeFileSync(victim, "ORIGINAL");
  for (const n of ["x.txt.part", `x.txt.${process.pid}.part`, `.x.txt.nas-pull-${process.pid}.part`]) fs.symlinkSync(victim, path.join(root, n));
  const r = await pullFiles([{ p: "x", path: "/x.txt", size: 5, rel: ["x.txt"] }], root, mkDownload({ x: "PWNED" }), { now: () => 0 });
  assert.equal(read(victim), "ORIGINAL");
  assert.equal(fs.lstatSync(path.join(root, "x.txt")).isSymbolicLink(), false);
  assert.equal(r.failed.length + r.downloaded.length, 1);
});

test("pullFiles: 중간 폴더가 밖을 가리키는 링크면 밖에 폴더도 만들지 않는다", async () => {
  const root = fs.realpathSync(mkTmp());
  const outside = mkTmp("naspull-out-");
  fs.symlinkSync(outside, path.join(root, "B"), "junction");
  const r = await pullFiles([{ p: "x", path: "/B/sub/deep/x.txt", size: 1, rel: ["B", "sub", "deep", "x.txt"] }], root, mkDownload({ x: "a" }), { now: () => 0 });
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(r.failed.length, 1);
});

test("pullFiles: 죽은 호출이 남긴 오래된 임시 조각은 치우고, 최근 것은 둔다", async () => {
  const root = fs.realpathSync(mkTmp());
  const old = path.join(root, ".x.txt.nas-pull-11111.part"), fresh = path.join(root, ".x.txt.nas-pull-22222.part");
  // NAS 에서 온 정상 파일이 우연히 «이름.숫자.part» 꼴이어도 지우지 않는다
  const lookalike = path.join(root, "x.txt.1.part");
  fs.writeFileSync(old, "o"); fs.writeFileSync(fresh, "f"); fs.writeFileSync(lookalike, "keep");
  const longAgo = new Date(Date.now() - 3 * 60 * 60_000);
  fs.utimesSync(old, longAgo, longAgo); fs.utimesSync(lookalike, longAgo, longAgo);
  await pullFiles([{ p: "x", path: "/x.txt", size: 1, rel: ["x.txt"] }], root, mkDownload({ x: "a" }), { now: Date.now });
  assert.equal(exists(old), false);
  assert.equal(exists(fresh), true);
  assert.equal(read(path.join(root, "x.txt")), "a");
  assert.equal(read(lookalike), "keep");
});

test("pullFiles: 시작부터 budgetMs 를 넘긴 뒤엔 새 파일을 시작하지 않고 remaining 에 남은 수", async () => {
  const root = mkTmp();
  let t = 1000;
  const files = Array.from({ length: 4 }, (_, i) => ({ p: `p${i}`, path: `/f${i}`, size: 1, rel: [`f${i}`] }));
  const calls = [];
  const dl = async (p) => { calls.push(p); t += 60; return new Response("x"); };
  const r = await pullFiles(files, root, dl, { budgetMs: 100, now: () => t });
  // 0ms·60ms 에 시작한 두 파일만 받고, 120ms 시점엔 시작하지 않는다.
  assert.deepEqual(calls, ["p0", "p1"]);
  assert.equal(r.downloaded.length, 2);
  assert.equal(r.remaining, 2);
});

// ───────────────────────── nasPull ─────────────────────────

const GATEWAY = "https://gw.example.test";
const TOKEN = "tok-123";
const LIST_PREFIX = "/api/ui/me/nas/list?p=";

// listings: p → {path, items} 또는 없으면 reject.
function mkCtx(listings) {
  const apiCalls = [];
  return {
    apiCalls,
    ctx: {
      gateway: GATEWAY,
      token: TOKEN,
      async api(p, _opts) {
        apiCalls.push(p);
        if (!p.startsWith(LIST_PREFIX)) throw new Error(`unexpected api ${p}`);
        const key = decodeURIComponent(p.slice(LIST_PREFIX.length));
        if (!(key in listings)) throw new Error(`게이트웨이 404 (${p})`); // ctx.api 의 실제 404 문구
        return listings[key];
      },
    },
  };
}

function mkFetch(bodies) {
  const calls = [];
  const FILE_PREFIX = `${GATEWAY}/api/ui/me/nas/file?p=`;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (!url.startsWith(FILE_PREFIX)) return new Response("bad url", { status: 400 });
    const key = decodeURIComponent(url.slice(FILE_PREFIX.length));
    const v = bodies[key];
    if (v === undefined) return new Response("missing", { status: 404 });
    return typeof v === "function" ? v() : new Response(v);
  };
  return { fetchImpl, calls };
}

const authOf = (opts) => {
  const h = opts?.headers;
  if (!h) return undefined;
  return typeof h.get === "function" ? h.get("authorization") : (h.authorization ?? h.Authorization);
};

function fixtureTree() {
  const root = "/공유/B";
  const rootP = pOfPath(root);
  return {
    root,
    rootP,
    listings: {
      [rootP]: {
        path: root,
        items: [
          { p: "pf+1/=", path: "/공유/B/x.txt", type: "file", size: 3 },
          { p: "pd", path: "/공유/B/c", type: "dir", size: 0 },
        ],
      },
      pd: { path: "/공유/B/c", items: [{ p: "pf2", path: "/공유/B/c/y.txt", type: "file", size: 2 }] },
    },
    bodies: { "pf+1/=": "abc", pf2: "xy" },
  };
}

test("nasPull: path 로 받은 폴더를 list·file 엔드포인트로 받아 dest 에 쓰고 결과 필드를 채움", async () => {
  const home = mkTmp();
  const fx = fixtureTree();
  const { ctx, apiCalls } = mkCtx(fx.listings);
  const { fetchImpl, calls } = mkFetch(fx.bodies);
  const r = await nasPull(ctx, { path: fx.root, dest: "out" }, { home, fetchImpl, budgetMs: 1e9, now: () => 0 });

  const dest = path.join(real(home), "NAS사본", "out");
  assert.equal(r.dest, dest);
  assert.equal(read(path.join(dest, "B", "x.txt")), "abc");
  assert.equal(read(path.join(dest, "B", "c", "y.txt")), "xy");

  assert.ok(apiCalls.includes(LIST_PREFIX + encodeURIComponent(fx.rootP)), JSON.stringify(apiCalls));
  assert.ok(apiCalls.includes(LIST_PREFIX + encodeURIComponent("pd")));
  const urls = calls.map((c) => c.url).sort();
  assert.deepEqual(urls, [
    `${GATEWAY}/api/ui/me/nas/file?p=${encodeURIComponent("pf+1/=")}`,
    `${GATEWAY}/api/ui/me/nas/file?p=${encodeURIComponent("pf2")}`,
  ].sort());
  for (const c of calls) assert.equal(authOf(c.opts), `Bearer ${TOKEN}`);

  assert.equal(r.done, true);
  assert.equal(r.planned, 2);
  assert.equal(r.downloaded, 2);
  assert.equal(r.skipped, 0);
  assert.equal(r.remaining, 0);
  assert.equal(r.bytes, 5);
  assert.ok(!r.truncated);
  assert.deepEqual(r.failed, []);
  assert.deepEqual([...r.files].sort(), [path.join(dest, "B", "x.txt"), path.join(dest, "B", "c", "y.txt")].sort());
  assert.ok("note" in r);
});

test("nasPull: 같은 호출 두 번째는 download 없이 모두 skipped(이어받기)", async () => {
  const home = mkTmp();
  const fx = fixtureTree();
  const first = mkFetch(fx.bodies);
  await nasPull(mkCtx(fx.listings).ctx, { path: fx.root, dest: "out" }, { home, fetchImpl: first.fetchImpl, budgetMs: 1e9, now: () => 0 });
  const second = mkFetch(fx.bodies);
  const r = await nasPull(mkCtx(fx.listings).ctx, { path: fx.root, dest: "out" }, { home, fetchImpl: second.fetchImpl, budgetMs: 1e9, now: () => 0 });
  assert.equal(second.calls.length, 0);
  assert.equal(r.downloaded, 0);
  assert.equal(r.skipped, 2);
  assert.equal(r.done, true);
});

test("nasPull: targets 도 path 도 없으면 Error", async () => {
  const home = mkTmp();
  const { fetchImpl } = mkFetch({});
  for (const args of [{}, { targets: [] }, { dest: "out" }]) {
    assert.ok(await throws(() => nasPull(mkCtx({}).ctx, args, { home, fetchImpl, budgetMs: 1e9, now: () => 0 })), JSON.stringify(args));
  }
});

test("nasPull: type 없는 대상은 list 실패 시 file 로 받음", async () => {
  const home = mkTmp();
  const { fetchImpl, calls } = mkFetch({ pfx: "pdfbytes" });
  const r = await nasPull(mkCtx({}).ctx, { targets: [{ p: "pfx", path: "/A/doc.pdf" }], dest: "out" },
    { home, fetchImpl, budgetMs: 1e9, now: () => 0 });
  assert.equal(calls.length, 1);
  assert.equal(read(path.join(real(home), "NAS사본", "out", "doc.pdf")), "pdfbytes");
  assert.equal(r.downloaded, 1);
});

test("nasPull: type 판별 중 404 가 아닌 실패(로그인 만료 등)는 파일로 오인하지 않고 그대로 던진다", async () => {
  const home = mkTmp();
  const { fetchImpl, calls } = mkFetch({ px: "x" });
  const ctx = { api: async () => { throw new Error("게이트웨이 401 (/api/ui/me/nas/list) — lively login"); }, gateway: GATEWAY, token: TOKEN };
  await assert.rejects(nasPull(ctx, { targets: [{ p: "px", path: "/A/x.txt" }] }, { home, fetchImpl, budgetMs: 1e9, now: () => 0 }), /401/);
  assert.equal(calls.length, 0);
});

test("nasPull: 폴더 나열이 시간 한도에 걸리면 done=false 로 멈추고, 다시 부르면 이어서 나열해 다 받는다", async () => {
  const home = mkTmp();
  const listings = {};
  for (let i = 0; i < 6; i++) {
    listings[`d${i}`] = { path: i ? `/R/d${i}` : "/R", items: [{ p: `f${i}`, path: `${i ? `/R/d${i}` : "/R"}/f${i}.txt`, type: "file", size: 1 }] };
    if (i < 5) listings[`d${i}`].items.push({ p: `d${i + 1}`, path: `/R/d${i + 1}`, type: "dir", size: 0 });
  }
  const bytes = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, "z"]));
  let t = 0;
  const base = mkCtx(listings).ctx;
  const ctx = { ...base, api: async (...a) => { t += 10; return base.api(...a); } };
  const { fetchImpl } = mkFetch(bytes);
  const first = await nasPull(ctx, { targets: [{ p: "d0", path: "/R", type: "dir" }], dest: "out" }, { home, fetchImpl, budgetMs: 25, now: () => t });
  assert.equal(first.done, false);
  assert.equal(first.downloaded, 0);
  let r = first;
  for (let k = 0; k < 10 && !r.done; k++) r = await nasPull(ctx, { targets: [{ p: "d0", path: "/R", type: "dir" }], dest: "out" }, { home, fetchImpl, budgetMs: 25, now: () => t });
  assert.equal(r.done, true);
  const out = path.join(real(home), "NAS사본", "out", "R");
  assert.equal(read(path.join(out, "f0.txt")), "z");
  for (let i = 1; i < 6; i++) assert.equal(read(path.join(out, `d${i}`, `f${i}.txt`)), "z");
  // 다 받으면 이어받기 기록을 남기지 않는다
  assert.deepEqual(fs.readdirSync(path.join(real(home), "NAS사본", "out")).filter((n) => n.startsWith(".")), []);
});

test("nasPull: type 없는 대상이 list 성공이면 응답 path 를 이름으로 한 dir", async () => {
  const home = mkTmp();
  const listings = { pq: { path: "/공유/폴더", items: [{ p: "pi", path: "/공유/폴더/i.txt", type: "file", size: 1 }] } };
  const { fetchImpl } = mkFetch({ pi: "i" });
  const r = await nasPull(mkCtx(listings).ctx, { targets: [{ p: "pq" }], dest: "out" }, { home, fetchImpl, budgetMs: 1e9, now: () => 0 });
  assert.equal(read(path.join(real(home), "NAS사본", "out", "폴더", "i.txt")), "i");
  assert.equal(r.downloaded, 1);
});

test("nasPull: path 를 끝내 모르는 대상은 받지 않고 failed 에 남김", async () => {
  const home = mkTmp();
  const { fetchImpl, calls } = mkFetch({ pq: "zzz" });
  const r = await nasPull(mkCtx({}).ctx, { targets: [{ p: "pq" }], dest: "out" }, { home, fetchImpl, budgetMs: 1e9, now: () => 0 });
  assert.equal(calls.length, 0);
  assert.equal(r.downloaded, 0);
  assert.ok(r.failed.length >= 1);
});

test("nasPull: failed 는 최대 50, files 는 최대 100 건으로 자른다(개수는 그대로)", async () => {
  const home = mkTmp();
  const items = [];
  const bodies = {};
  for (let i = 0; i < 120; i++) { items.push({ p: `ok${i}`, path: `/D/ok${i}.txt`, type: "file", size: 1 }); bodies[`ok${i}`] = "x"; }
  for (let i = 0; i < 60; i++) items.push({ p: `bad${i}`, path: `/D/bad${i}.txt`, type: "file", size: 1 });
  const listings = { [pOfPath("/D")]: { path: "/D", items } };
  const { fetchImpl } = mkFetch(bodies);
  const r = await nasPull(mkCtx(listings).ctx, { path: "/D", dest: "out" }, { home, fetchImpl, budgetMs: 1e9, now: () => 0 });
  assert.equal(r.downloaded, 120);
  assert.equal(r.files.length, 100);
  assert.equal(r.failed.length, 50);
});

test("nasPull: 예산 초과로 remaining 이 남으면 done=false", async () => {
  const home = mkTmp();
  const fx = fixtureTree();
  let t = 0;
  const base = mkFetch(fx.bodies);
  const fetchImpl = async (u, o) => { t += 1000; return base.fetchImpl(u, o); };
  const r = await nasPull(mkCtx(fx.listings).ctx, { path: fx.root, dest: "out" }, { home, fetchImpl, budgetMs: 500, now: () => t });
  assert.ok(r.remaining > 0, `remaining=${r.remaining}`);
  assert.equal(r.done, false);
});

test("nasPull: truncated 가 있으면 remaining 0 이어도 done=false", async () => {
  const home = mkTmp();
  // 기본 maxFiles(3000) 를 넘기는 목록 — 다운로드는 전부 404 로 실패시켜 디스크 쓰기 없이 remaining 0 을 만든다.
  const items = Array.from({ length: 3001 }, (_, i) => ({ p: `f${i}`, path: `/Big/f${i}`, type: "file", size: 1 }));
  const listings = { [pOfPath("/Big")]: { path: "/Big", items } };
  const { fetchImpl } = mkFetch({});
  const r = await nasPull(mkCtx(listings).ctx, { path: "/Big", dest: "out" }, { home, fetchImpl, budgetMs: 1e9, now: () => 0 });
  assert.equal(r.remaining, 0);
  assert.ok(r.truncated, "truncated 사유가 있어야 함");
  assert.equal(r.done, false);
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

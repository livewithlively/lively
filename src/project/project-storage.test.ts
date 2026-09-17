// 프로젝트 폴더 저장소 (#4064) — 사양 표 S1(자리 고르기)·S2(멤버 한 줄 = 로컬)·S3(이관)·S6(멤버 op)·S7(배선)을 행마다 잠근다.
//
// 왜: 매니지드(저장소 분리 배포)에서 같은 `project/<id>` 가 두 디렉터리로 풀렸다 — 세션·공유 브라우즈는 멤버 저장소,
//  곁칸 [자료]·AGENTS.md·자료 원본·노드 업로드 정본·첫 지시 첨부는 게이트웨이 로컬. 세션이 만든 파일은 곁칸에 안 떴고
//  곁칸에 올린 파일은 세션이 못 읽었다(2026-09-17 실측). 이 시험은 ① 고르는 규칙 ② 멤버 쪽 한 줄이 로컬 구현과 같은
//  답을 내는지 ③ 가짜 중계를 끼워 모든 op 가 **정말 멤버 경계를 거치는지** ④ 옛 파일 이관이 덮어쓰지 않고·되살리지
//  않고·실패를 삼키지 않는지 ⑤ 소비처가 그 저장소를 실제로 지나는지를 잠근다.
// 실행: npm run build && node --test dist/project/project-storage.test.js
import { strict as assert } from "node:assert";
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough, Readable } from "node:stream";
import type { LivelyUser } from "../context.js";

// ── 두 루트 — 모듈이 로드 때 읽으므로 import 전에 정한다 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "co-projstore-"));
const LOCAL_ROOT = path.join(TMP, "gw");        // 게이트웨이 로컬 공유 루트(TERMINAL_ROOT_SHARED)
const MEMBER_ROOT = path.join(TMP, "member");   // 격리 멤버 공유 루트(LIVELY_SHARED_DIR — 매니지드의 /work/shared)
process.env.TERMINAL_ROOT_SHARED = LOCAL_ROOT;
process.env.LIVELY_SHARED_DIR = MEMBER_ROOT;
for (const k of ["LIVELY_MEMBER_EXEC", "LIVELY_MEMBER_ISOLATION", "LIVELY_TENANT_ROOT_TEMPLATE", "LIVELY_TENANCY_MODE"]) delete process.env[k];

const S = await import("./project-storage.js");
const { manifestFiles } = await import("./project-manifest.js");
const { fileOpsAtMemberBoundary } = await import("../terminal/terminal-isolation.js");
const { RULES_MARK, GENERATED_BANNER, agentsMdHeader } = await import("../v6/agents-md-rules.js");

after(() => { delete process.env.LIVELY_MEMBER_EXEC; fs.rmSync(TMP, { recursive: true, force: true }); });

// ── 가짜 중계: `<중계> <osUser> -- argv…` 를 받아 argv 를 이 기계에서 그대로 돌리고, 누구로 불렸는지 적는다 ──
const RELAY_LOG = path.join(TMP, "relay.log");
const RELAY = path.join(TMP, "relay.cjs");
fs.writeFileSync(RELAY, [
  "const { spawnSync } = require('child_process'); const fs = require('fs');",
  "const i = process.argv.indexOf('--'); const argv = process.argv.slice(i + 1);",
  `fs.appendFileSync(${JSON.stringify(RELAY_LOG)}, process.argv[2] + ' ' + argv[0] + '\\n');`,
  "const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' }); process.exit(r.status == null ? 1 : r.status);",
].join("\n"));
const relayOn = (): void => { process.env.LIVELY_MEMBER_EXEC = `${process.execPath} ${RELAY}`; };
const relayOff = (): void => { delete process.env.LIVELY_MEMBER_EXEC; };
const relayCalls = (): string[] => (fs.existsSync(RELAY_LOG) ? fs.readFileSync(RELAY_LOG, "utf8").split("\n").filter(Boolean) : []);

const runJs = (js: string, input: unknown): unknown => {
  const r = spawnSync(process.execPath, ["-e", js], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const put = (p: string, data: string | Buffer = ""): void => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
const read = (p: string): string | null => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const exists = (p: string): boolean => fs.existsSync(p);
const user = (id: string): LivelyUser => ({ userId: id, email: id ? `${id}@example.com` : "", scopes: [], projects: [] } as unknown as LivelyUser);
const byName = <T extends { name: string }>(xs: T[] | null): T[] | null => (xs ? [...xs].sort((a, b) => a.name.localeCompare(b.name)) : xs);
const walkNames = (dir: string): string[] => {
  const out: string[] = [];
  const go = (d: string): void => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { out.push(e.name); if (e.isDirectory()) go(path.join(d, e.name)); } };
  if (exists(dir)) go(dir);
  return out;
};
const P = (id: number): { id: number; name: string } => ({ id, name: `프로젝트 ${id}` });
//  생성기 모양 그대로 — 머리(이 프로젝트) + 생성 문장 + digest + 규칙 표식
const agentsMd = (rules: string, digest: string, id: number, name = P(id).name): string =>
  `${agentsMdHeader({ id, name })}\n\n${GENERATED_BANNER}.\n${digest}\n\n${RULES_MARK}\n## 규칙\n${rules}\n`;
const actor = { memberId: "tester" };
//  소유 확인 — 실제로는 이 워크스페이스의 자료 표 조회다. 이 시험에선 이름이 «foreign» 으로 시작하는 파일만 남의 것으로 본다.
const ownCalls: Array<{ projectId: number; rels: string[] }> = [];
S.setMigrationOwnership(async (q) => {
  ownCalls.push(q);
  return new Set(q.rels.filter((r) => !path.posix.basename(r).startsWith("foreign")));
});
const OS_USER = "box_tester";

// ═══ S1 자리 고르기 ═══════════════════════════════════════════════════════════

test("S1g 고르는 규칙은 하나 — 격리 사용자 && 저장소 분리일 때만 멤버 경계", () => {
  for (const [u, d, want] of [["box_a", true, true], ["box_a", false, false], [null, true, false], [undefined, false, false], ["", true, false]] as const) {
    assert.equal(fileOpsAtMemberBoundary(u, d), want, `osUser=${String(u)} detached=${d}`);
  }
  relayOff();
  assert.equal(fileOpsAtMemberBoundary("box_a"), false, "기본값은 지금 배포를 따른다(저장소 붙음)");
  relayOn();
  try { assert.equal(fileOpsAtMemberBoundary("box_a"), true, "기본값은 지금 배포를 따른다(저장소 분리)"); }
  finally { relayOff(); }
});

test("S1a 저장소가 붙은 배포 — 게이트웨이 로컬 폴더, 신원 없어도 된다, 중계를 안 탄다", async () => {
  relayOff();
  const before = relayCalls().length;
  for (const a of [null, actor, { user: user("tester") }]) {
    const st = await S.projectStorage("project/77", a);
    assert.equal(st.base, path.join(LOCAL_ROOT, "project", "77"));
    assert.equal(st.localBase, st.base);
    assert.equal(st.osUser, null);
  }
  const st = await S.projectStorage("project/77", null);
  await st.writeText(path.join(st.base, "n.md"), "로컬");
  assert.equal(read(path.join(LOCAL_ROOT, "project", "77", "n.md")), "로컬");
  assert.equal(relayCalls().length, before, "저장소가 붙어 있으면 중계를 타면 안 된다");
});

test("S1b·S1d 저장소 분리 — 요청 사용자든 멤버 id 든 멤버 저장소, 그 멤버 경계", async () => {
  relayOn();
  try {
    for (const a of [{ user: user("tester") }, actor]) {
      const st = await S.projectStorage("project/78", a);
      assert.equal(st.base, path.join(MEMBER_ROOT, "project", "78"), "세션 cwd 와 같은 자리여야 곁칸이 세션 파일을 본다");
      assert.equal(st.localBase, path.join(LOCAL_ROOT, "project", "78"));
      assert.equal(st.osUser, OS_USER);
    }
  } finally { relayOff(); }
});

test("S1c ★ 저장소 분리인데 신원이 없으면 거절 — 게이트웨이 로컬로 폴백하지 않는다", async () => {
  relayOn();
  try {
    for (const a of [null, { memberId: "" }, { memberId: "  " }, { user: user("") }]) {
      await assert.rejects(S.projectStorage("project/79", a as never), `신원 ${JSON.stringify(a)} 로 자리를 정하면 안 된다`);
    }
    assert.equal(exists(path.join(LOCAL_ROOT, "project", "79")), false, "거절하면서 게이트웨이 쪽에 아무것도 만들지 않는다");
  } finally { relayOff(); }
});

test("S1e 격리 킬스위치(off)면 종전 게이트웨이 로컬로", async () => {
  relayOn();
  process.env.LIVELY_MEMBER_ISOLATION = "off";
  try {
    const st = await S.projectStorage("project/78", actor);
    assert.equal(st.osUser, null);
    assert.equal(st.base, path.join(LOCAL_ROOT, "project", "78"));
  } finally { delete process.env.LIVELY_MEMBER_ISOLATION; relayOff(); }
});

test("S1f 프로젝트 영역 밖 folder 는 두 모드 모두 거절", async () => {
  for (const on of [false, true]) {
    if (on) relayOn(); else relayOff();
    try {
      for (const f of ["../etc", "project/../../x", "repos/lively", "/etc"]) {
        await assert.rejects(S.projectStorage(f, actor), `${on ? "분리" : "붙음"}: ${f}`);
      }
      await S.projectStorage("legacy-project/5", actor);   // 보관 영역은 된다
    } finally { relayOff(); }
  }
});

// ═══ S2 멤버 쪽 한 줄 = 로컬 구현 ════════════════════════════════════════════

const TREE = path.join(TMP, "tree");
put(path.join(TREE, "a.txt"), "a");
put(path.join(TREE, ".hidden"), "h");
put(path.join(TREE, "Docs", "Report.MD"), "report");
put(path.join(TREE, "Docs", ".secret"), "s");
put(path.join(TREE, "onlyhidden", ".keep"), "");
fs.mkdirSync(path.join(TREE, "empty"), { recursive: true });
put(path.join(TREE, "repo", ".git"), "gitdir: /elsewhere");   // 워크트리 포인터 파일도 레포다
put(path.join(TREE, "repo", "src", "report.ts"), "x");
put(path.join(TREE, "deep", "1", "2", "3", "4", "5", "6", "7", "8", "9", "report-deep.txt"), "d");

test("S2a 목록 — 숨김 제외 · 종류 · repo · empty(진짜 빈 폴더·숨김만 든 폴더) · 내용 있는 폴더는 empty 아님", async () => {
  const local = await S.localList(TREE);
  const member = runJs(S.PROJECT_LIST_JS, { dir: TREE }) as typeof local;
  assert.deepEqual(byName(member), byName(local), "멤버 한 줄과 로컬 구현이 같은 답을 내야 한다");
  const m = new Map((local ?? []).map((e) => [e.name, e]));
  assert.deepEqual([...m.keys()].sort(), ["Docs", "a.txt", "deep", "empty", "onlyhidden", "repo"]);
  assert.equal(m.get("a.txt")?.type, "file");
  assert.equal(m.get("a.txt")?.size, 1);
  assert.equal(m.get("repo")?.repo, true);
  assert.equal(m.get("repo")?.empty, undefined, "레포는 비었는지 따지지 않는다");
  assert.equal(m.get("empty")?.empty, true);
  assert.equal(m.get("onlyhidden")?.empty, true, "숨김만 든 폴더는 빈 폴더로 그린다");
  assert.equal(m.get("Docs")?.empty, undefined);
  assert.equal(m.get("Docs")?.type, "dir");
});

test("S2b 없는 디렉터리는 null — 던지지 않는다(루트면 빈 폴더 판정으로 간다)", async () => {
  const missing = path.join(TREE, "nope");
  assert.equal(await S.localList(missing), null);
  assert.equal(runJs(S.PROJECT_LIST_JS, { dir: missing }), null);
});

test("S2c 검색 — 대소문자 무시 · 숨김 제외 · 깊이 상한 · 결과 상한", async () => {
  for (const [q, limit] of [["REPORT", 100], ["report", 1], ["secret", 100], ["nothing", 100]] as const) {
    const local = await S.localSearch(TREE, q, limit);
    const member = runJs(S.PROJECT_SEARCH_JS, { base: TREE, q, limit });
    assert.deepEqual(member, local, `q=${q} limit=${limit}`);
  }
  const hits = (await S.localSearch(TREE, "REPORT", 100)).map((h) => h.path).sort();
  assert.deepEqual(hits, ["Docs/Report.MD", "repo/src/report.ts"], "숨김·깊이 8 초과는 안 나온다");
  assert.equal((await S.localSearch(TREE, "report", 1)).length, 1);
  assert.deepEqual(await S.localSearch(TREE, "secret", 100), [], "숨김 파일은 이름이 맞아도 안 나온다");
});

test("S2d 매니페스트 — 파일만 · 숨김 제외 · 레포 서브트리 제외", async () => {
  const local = await manifestFiles(TREE);
  assert.deepEqual(runJs(S.PROJECT_MANIFEST_JS, { base: TREE, limit: 5000 }), local);
  assert.deepEqual(local.files.map((f) => f.path).sort(),
    ["Docs/Report.MD", "a.txt", "deep/1/2/3/4/5/6/7/8/9/report-deep.txt"]);
  assert.equal(local.truncated, false);
});

test("S2e 매니페스트 상한 경계 — 정확히 상한 개면 잘리지 않았고, 하나 더 있으면 잘렸다", async () => {
  const dir = path.join(TMP, "cap");
  for (const n of ["1", "2", "3"]) put(path.join(dir, `${n}.txt`), n);
  const exact = await manifestFiles(dir, 3);
  assert.equal(exact.truncated, false);
  assert.deepEqual(runJs(S.PROJECT_MANIFEST_JS, { base: dir, limit: 3 }), exact);
  put(path.join(dir, "4.txt"), "4");
  const over = await manifestFiles(dir, 3);
  assert.equal(over.truncated, true);
  assert.equal(over.files.length, 3);
  assert.deepEqual(runJs(S.PROJECT_MANIFEST_JS, { base: dir, limit: 3 }), over);
});

test("S2f 문서 읽기 — 없음·폴더·상한 초과는 null", async () => {
  relayOff();
  const st = await S.projectStorage("project/81", null);
  const big = path.join(st.base, "big.txt");
  put(big, Buffer.alloc(8 * 1024 * 1024 + 1, 97));
  assert.equal(await st.readText(big), null, "상한(8MB)을 넘는 문서는 통째로 올리지 않는다");
  assert.equal(await st.readText(path.join(st.base, "nope.md")), null);
  assert.equal(await st.readText(st.base), null);
  const f = path.join(TREE, "a.txt");
  assert.equal(runJs(S.PROJECT_READ_TEXT_JS, { path: f, max: 0 }), null, "멤버 한 줄도 상한을 지킨다");
  assert.equal(runJs(S.PROJECT_READ_TEXT_JS, { path: f, max: 1 }), "a", "정확히 상한 크기면 읽는다");
  assert.equal(runJs(S.PROJECT_READ_TEXT_JS, { path: TREE, max: 99 }), null);
  assert.equal(runJs(S.PROJECT_READ_TEXT_JS, { path: path.join(TREE, "nope"), max: 99 }), null);
});

// ═══ S6 멤버 모드 op — 가짜 중계로 끝까지 ════════════════════════════════════

test("★★ S6 저장소 분리면 모든 op 가 그 멤버 경계를 거친다 — 게이트웨이 fs 로 새지 않는다", async () => {
  relayOn();
  try {
    const st = await S.projectStorage("project/80", actor);
    const b = st.base;
    const before = relayCalls().length;

    await st.mkdirp(path.join(b, "a", "b"));                                            // O5
    assert.ok(fs.statSync(path.join(b, "a", "b")).isDirectory());

    await st.writeText(path.join(b, "x", "y.md"), "처음");                              // O2 — 부모까지
    await st.writeText(path.join(b, "x", "y.md"), "덮어씀");
    assert.equal(read(path.join(b, "x", "y.md")), "덮어씀");
    assert.deepEqual(fs.readdirSync(path.join(b, "x")), ["y.md"], "임시파일이 남으면 안 된다");
    assert.equal(await st.readText(path.join(b, "x", "y.md")), "덮어씀");
    assert.equal(await st.readText(path.join(b, "x", "none.md")), null);

    await st.writeBuffer(path.join(b, "n", "o", "p.bin"), Buffer.from([0, 1, 2, 255]));  // O3
    assert.deepEqual([...fs.readFileSync(path.join(b, "n", "o", "p.bin"))], [0, 1, 2, 255]);

    await st.receive(Readable.from([Buffer.from("업로드")]), path.join(b, "up", "q.txt"), 1024);   // O1
    assert.equal(read(path.join(b, "up", "q.txt")), "업로드");
    await assert.rejects(st.receive(Readable.from([Buffer.alloc(64)]), path.join(b, "up", "q.txt"), 10), "상한을 넘으면 실패한다");
    assert.equal(read(path.join(b, "up", "q.txt")), "업로드", "실패한 업로드가 목적지를 건드리면 안 된다");

    const q = path.join(b, "up", "q.txt");                                               // O6
    assert.deepEqual(await st.stat(q), { file: true, dir: false, size: Buffer.byteLength("업로드"), mtime: Math.floor(fs.statSync(q).mtimeMs) });
    assert.equal(await st.stat(path.join(b, "none")), null);
    assert.equal((await st.stat(path.join(b, "up")))?.dir, true);

    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on("data", (c: Buffer) => chunks.push(c));
    await st.readTo(q, sink);
    assert.equal(Buffer.concat(chunks).toString(), "업로드");

    const listed = await st.list(b);
    assert.deepEqual((listed ?? []).map((e) => e.name).sort(), ["a", "n", "up", "x"]);
    assert.equal(await st.list(path.join(b, "none")), null);
    assert.deepEqual((await st.manifest()).files.map((f) => f.path).sort(), ["n/o/p.bin", "up/q.txt", "x/y.md"]);
    assert.deepEqual((await st.search("p.bin")).map((h) => h.path), ["n/o/p.bin"]);

    await st.move(path.join(b, "x", "y.md"), path.join(b, "a", "y.md"));                // O5
    assert.equal(read(path.join(b, "a", "y.md")), "덮어씀");
    await st.remove(path.join(b, "n"));
    assert.equal(exists(path.join(b, "n")), false);

    fs.mkdirSync(path.join(TMP, "outside"), { recursive: true });                         // O4
    fs.symlinkSync(path.join(TMP, "outside"), path.join(b, "out"));
    assert.equal(await st.confined(path.join(b, "out", "z.txt")), false, "밖을 가리키는 링크 아래는 봉쇄 밖이다");
    assert.equal(await st.confined(path.join(b, "a", "y.md")), true);
    assert.equal(await st.confined(path.join(b, "새 폴더", "새 파일.txt")), true, "아직 없는 꼬리는 안쪽이다");

    const calls = relayCalls().slice(before);                                             // O7
    assert.ok(calls.length >= 16, `멤버 경계 호출이 너무 적다(${calls.length}) — 로컬 fs 로 샌 op 가 있다`);
    assert.ok(calls.every((l) => l.startsWith(`${OS_USER} `)), "모든 op 가 그 멤버 이름으로 가야 한다");
  } finally { relayOff(); }
});

// ═══ S3 이관 ═══════════════════════════════════════════════════════════════════

const MTIME_S = Date.UTC(2020, 0, 2, 3, 4, 5) / 1000;

test("★★ S3 이관 — 없으면 복사 · 같으면 그대로 · 다르면 나란히 · 숨김·레포·생성물은 건드리지 않는다", async () => {
  const L = path.join(LOCAL_ROOT, "project", "90");
  const M = path.join(MEMBER_ROOT, "project", "90");
  put(path.join(L, "a.txt"), "alpha"); fs.utimesSync(path.join(L, "a.txt"), MTIME_S, MTIME_S);   // M1
  put(path.join(L, "same.txt"), "same"); put(path.join(M, "same.txt"), "same");                  // M2
  put(path.join(L, "diff.txt"), "local-version"); put(path.join(M, "diff.txt"), "member-version"); // M3
  put(path.join(L, "dup.txt"), "local-dup"); put(path.join(M, "dup.txt"), "member-dup");         // M4
  put(path.join(M, "dup (이관 사본).txt"), "other");
  put(path.join(L, "sub", "deep", "x.txt"), "x");                                                // M5
  fs.mkdirSync(path.join(L, "emptydir"), { recursive: true });                                   // M6
  put(path.join(L, ".lively", "project.json"), "{}"); put(path.join(L, ".hidden"), "h");         // M7
  put(path.join(L, "repo", ".git"), "gitdir: x"); put(path.join(L, "repo", "code.ts"), "code");  // M8
  put(path.join(L, "CLAUDE.md"), "@AGENTS.md\n"); put(path.join(M, "CLAUDE.md"), "# 사람 메모\n");  // M9
  put(path.join(L, "AGENTS.md"), agentsMd("규칙 R", "옛 digest", 90));                              // M10
  put(path.join(M, "AGENTS.md"), agentsMd("규칙 R", "새 digest", 90));
  put(path.join(L, "foreign.txt"), "남의 것"); put(path.join(L, "docs", "foreign-x.txt"), "남의 것 2");   // M17
  put(path.join(L, "docs", "mine.txt"), "내 것");
  relayOn();
  try {
    S.resetMigrationMemo();
    const st = await S.projectStorage("project/90", actor, P(90));
    assert.equal(st.base, M);

    assert.equal(read(path.join(M, "a.txt")), "alpha", "M1 없는 파일은 복사한다");
    assert.equal(Math.floor(fs.statSync(path.join(M, "a.txt")).mtimeMs / 1000), MTIME_S, "M1 mtime 을 보존한다(동기화 원장 오판 방지)");
    assert.equal(read(path.join(M, "same.txt")), "same");
    assert.equal(exists(path.join(M, "same (이관 사본).txt")), false, "M2 같은 내용이면 사본을 만들지 않는다");
    assert.equal(read(path.join(M, "diff.txt")), "member-version", "M3 멤버 쪽 것을 덮지 않는다");
    assert.equal(read(path.join(M, "diff (이관 사본).txt")), "local-version", "M3 옛 것은 나란히 둔다");
    assert.equal(read(path.join(M, "dup.txt")), "member-dup");
    assert.equal(read(path.join(M, "dup (이관 사본).txt")), "other", "M4 이미 있는 사본도 덮지 않는다");
    assert.equal(read(path.join(M, "dup (이관 사본 2).txt")), "local-dup", "M4 다음 번호로 비켜 간다");
    assert.equal(read(path.join(M, "sub", "deep", "x.txt")), "x", "M5 하위 폴더째 옮긴다");
    assert.equal(exists(path.join(M, "emptydir")), false, "M6 빈 폴더는 누구 것인지 증명할 수 없어 옮기지 않는다");
    assert.equal(exists(path.join(M, ".hidden")), false, "M7 숨김은 옮기지 않는다");
    assert.equal(exists(path.join(M, ".lively")), false, "M7 호스트 마커는 옮기지 않는다(중앙 세션의 자기 pull 방지)");
    assert.equal(exists(path.join(M, "repo")), false, "M8 레포는 옮기지 않는다");
    assert.equal(read(path.join(M, "CLAUDE.md")), "# 사람 메모\n", "M9 사람이 쓴 CLAUDE.md 는 그대로");
    assert.equal(exists(path.join(M, "CLAUDE (이관 사본).md")), false, "M9 우리 import 한 줄은 사본으로 남길 정보가 없다");
    assert.equal(read(path.join(M, "AGENTS.md")), agentsMd("규칙 R", "새 digest", 90), "M10 규칙이 같으면 멤버 쪽 그대로");
    assert.equal(exists(path.join(M, "AGENTS (이관 사본).md")), false, "M10 digest 만 다른 사본은 소음이다");
    assert.deepEqual(walkNames(M).filter((n) => n.startsWith(".migrate-")), [], "임시파일이 남으면 안 된다");

    assert.equal(exists(path.join(M, "foreign.txt")), false, "M17 이 워크스페이스 자료가 아닌 파일은 옮기지 않는다");
    assert.equal(exists(path.join(M, "docs", "foreign-x.txt")), false, "M17 하위 폴더에서도 마찬가지");
    assert.equal(read(path.join(M, "docs", "mine.txt")), "내 것", "M17 같은 폴더의 내 파일은 옮긴다");
    assert.equal(read(path.join(L, "foreign.txt")), "남의 것", "M17 남의 것은 제자리에 둔다");
    assert.equal(read(path.join(L, "docs", "foreign-x.txt")), "남의 것 2");
    assert.equal(exists(path.join(L, ".lively", "migrated", "foreign.txt")), false, "M17 남의 것은 보관(이동)도 하지 않는다");
    assert.ok(exists(path.join(L, "docs")), "남의 파일이 남은 로컬 폴더는 걷지 않는다");
    assert.ok(exists(path.join(L, "emptydir")), "M6 옮기지 않은 빈 폴더는 그대로 둔다");
    assert.ok(ownCalls.some((c) => c.projectId === 90 && c.rels.includes("foreign.txt") && c.rels.includes("a.txt")), "소유 확인에 그 프로젝트 id 로 물어야 한다");
    assert.ok(ownCalls.every((c) => !c.rels.includes("AGENTS.md") && !c.rels.includes("CLAUDE.md")), "생성물은 자료 표가 아니라 내용으로 판정한다");

    for (const rel of ["a.txt", "same.txt", "diff.txt", "dup.txt", "sub/deep/x.txt", "docs/mine.txt", "CLAUDE.md", "AGENTS.md"]) {
      assert.equal(exists(path.join(L, rel)), false, `처리한 원본은 제자리에서 빠진다: ${rel}`);
      assert.ok(exists(path.join(L, ".lively", "migrated", rel)), `처리한 원본은 보관한다(지우지 않는다): ${rel}`);
    }
    assert.equal(read(path.join(L, ".lively", "migrated", "diff.txt")), "local-version");
    assert.equal(exists(path.join(L, "sub")), false, "M5 비워진 로컬 폴더는 걷힌다");
    assert.equal(read(path.join(L, ".hidden")), "h", "M7 숨김 원본은 그대로");
    assert.equal(read(path.join(L, ".lively", "project.json")), "{}", "M7 마커는 그대로");
    assert.equal(read(path.join(L, "repo", "code.ts")), "code", "M8 레포 원본은 그대로");

    //  M12 — 사람이 옮겨진 파일을 지운 뒤 다시 열어도 되살아나지 않는다.
    fs.rmSync(path.join(M, "a.txt"));
    S.resetMigrationMemo();
    await S.projectStorage("project/90", actor, P(90));
    assert.equal(exists(path.join(M, "a.txt")), false, "M12 지운 파일이 이관으로 되살아나면 안 된다");
    const again = await S.migrateLocalToMember(st);
    assert.deepEqual(again, { copied: 0, same: 0, renamed: 0, failed: 0, foreign: 2, more: false }, "M12 두 번째 이관은 내 할 일이 없다(남의 것 둘은 그대로 센다)");
  } finally { relayOff(); }
});

test("S3 M10b·M11 — 사람 규칙이 다른 AGENTS.md 는 나란히 · 멤버 쪽에 없으면 그대로 복사", async () => {
  const L1 = path.join(LOCAL_ROOT, "project", "91");
  const M1 = path.join(MEMBER_ROOT, "project", "91");
  put(path.join(L1, "AGENTS.md"), agentsMd("옛 규칙", "d1", 91));
  put(path.join(M1, "AGENTS.md"), agentsMd("다른 규칙", "d2", 91));
  const L2 = path.join(LOCAL_ROOT, "project", "92");
  put(path.join(L2, "AGENTS.md"), agentsMd("옛 규칙", "d1", 92));
  relayOn();
  try {
    S.resetMigrationMemo();
    await S.projectStorage("project/91", actor, P(91));
    assert.equal(read(path.join(M1, "AGENTS.md")), agentsMd("다른 규칙", "d2", 91), "M10b 멤버 쪽 규칙을 덮지 않는다");
    assert.equal(read(path.join(M1, "AGENTS (이관 사본).md")), agentsMd("옛 규칙", "d1", 91), "M10b 옛 규칙은 사본으로 보인다");
    await S.projectStorage("project/92", actor, P(92));
    assert.equal(read(path.join(MEMBER_ROOT, "project", "92", "AGENTS.md")), agentsMd("옛 규칙", "d1", 92), "M11 규칙이 든 AGENTS.md 가 건너간다");
  } finally { relayOff(); }
});

test("S3 M13 못 읽는 파일은 제자리에 남고 실패로 센다 — 고치면 다음 이관이 가져간다", { skip: process.getuid?.() === 0 ? "root 는 권한 비트를 무시한다" : false }, async () => {
  relayOn();
  try {
    const st = await S.projectStorage("project/93", actor, P(93));   // 로컬이 아직 비어 있을 때 연다(이관 할 일 0)
    const L = st.localBase;
    put(path.join(L, "ok.txt"), "ok");
    put(path.join(L, "locked.txt"), "secret");
    fs.chmodSync(path.join(L, "locked.txt"), 0o000);
    const r1 = await S.migrateLocalToMember(st);
    assert.equal(r1.copied, 1);
    assert.equal(r1.failed, 1, "실패를 삼키면 안 된다");
    assert.equal(exists(path.join(st.base, "locked.txt")), false);
    assert.ok(exists(path.join(L, "locked.txt")), "실패한 원본은 제자리에 남아야 다음에 다시 간다");
    assert.deepEqual(walkNames(st.base).filter((n) => n.startsWith(".migrate-")), [], "실패해도 임시파일을 남기지 않는다");
    fs.chmodSync(path.join(L, "locked.txt"), 0o644);
    const r2 = await S.migrateLocalToMember(st);
    assert.deepEqual(r2, { copied: 1, same: 0, renamed: 0, failed: 0, foreign: 0, more: false });
    assert.equal(read(path.join(st.base, "locked.txt")), "secret");
  } finally { relayOff(); }
});

test("S3 M14 게이트웨이 쪽 폴더가 없으면 할 일도 중계 호출도 없다", async () => {
  relayOn();
  try {
    const before = relayCalls().length;
    const st = await S.projectStorage("project/94", actor, P(94));
    assert.deepEqual(await S.migrateLocalToMember(st), { copied: 0, same: 0, renamed: 0, failed: 0, foreign: 0, more: false });
    assert.equal(relayCalls().length, before, "열기만 했는데 멤버 경계를 두드리면 안 된다");
  } finally { relayOff(); }
});

test("S3 M15 동시에 두 번 열어도 한 번만 옮긴다", async () => {
  put(path.join(LOCAL_ROOT, "project", "95", "c.txt"), "c");
  relayOn();
  try {
    S.resetMigrationMemo();
    await Promise.all([S.projectStorage("project/95", actor, P(95)), S.projectStorage("project/95", { user: user("tester") }, P(95))]);
    const M = path.join(MEMBER_ROOT, "project", "95");
    assert.equal(read(path.join(M, "c.txt")), "c");
    assert.deepEqual(fs.readdirSync(M).sort(), ["c.txt"], "경합으로 사본이 생기면 안 된다");
  } finally { relayOff(); }
});

test("S3 M16 한 번에 옮기는 수를 넘으면 나눠서 이어 간다", async () => {
  relayOn();
  try {
    const st = await S.projectStorage("project/96", actor, P(96));
    for (const n of ["1", "2", "3", "4", "5"]) put(path.join(st.localBase, `${n}.txt`), n);
    const r1 = await S.migrateLocalToMember(st, 2);
    assert.equal(r1.copied, 2);
    assert.equal(r1.more, true, "남은 것이 있다고 말해야 다음 열기가 이어 간다");
    const r2 = await S.migrateLocalToMember(st, 2);
    const r3 = await S.migrateLocalToMember(st, 2);
    assert.equal(r2.copied + r3.copied, 3);
    assert.equal(r3.more, false);
    assert.deepEqual(fs.readdirSync(st.base).sort(), ["1.txt", "2.txt", "3.txt", "4.txt", "5.txt"]);
  } finally { relayOff(); }
});

test("S3 M18 ★ 첫 줄이 이 프로젝트 머리가 아닌 AGENTS.md 는 남의 것일 수 있다 — 옮기지 않는다", async () => {
  const L = path.join(LOCAL_ROOT, "project", "97");
  put(path.join(L, "AGENTS.md"), agentsMd("남의 규칙", "d", 97, "다른 워크스페이스 프로젝트"));
  put(path.join(L, "CLAUDE.md"), "# 누군가의 메모\n");
  put(path.join(L, "ok.txt"), "ok");
  relayOn();
  try {
    S.resetMigrationMemo();
    const st = await S.projectStorage("project/97", actor, P(97));
    assert.equal(exists(path.join(st.base, "AGENTS.md")), false, "남의 규칙이 이 프로젝트의 AGENTS.md 가 되면 안 된다");
    assert.equal(exists(path.join(st.base, "CLAUDE.md")), false, "import 한 줄이 아닌 CLAUDE.md 는 누구 것인지 모른다");
    assert.equal(read(path.join(st.base, "ok.txt")), "ok");
    assert.ok(exists(path.join(L, "AGENTS.md")) && exists(path.join(L, "CLAUDE.md")), "남의 것일 수 있는 원본은 제자리에 둔다");
  } finally { relayOff(); }
});

test("S3 M19 프로젝트를 모르고 연 저장소는 이관하지 않는다", async () => {
  const L = path.join(LOCAL_ROOT, "project", "98");
  put(path.join(L, "a.txt"), "a");
  relayOn();
  try {
    S.resetMigrationMemo();
    const st = await S.projectStorage("project/98", actor);
    assert.equal(st.project, null);
    assert.equal(exists(path.join(st.base, "a.txt")), false);
    assert.equal(read(path.join(L, "a.txt")), "a");
    assert.deepEqual(await S.migrateLocalToMember(st), { copied: 0, same: 0, renamed: 0, failed: 0, foreign: 0, more: false });
  } finally { relayOff(); }
});

test("S3 M20 소유 확인이 실패하면 아무것도 옮기지 않는다 — 여는 것 자체는 된다", async () => {
  const L = path.join(LOCAL_ROOT, "project", "99");
  put(path.join(L, "a.txt"), "a");
  relayOn();
  S.setMigrationOwnership(async () => { throw new Error("db down"); });
  try {
    S.resetMigrationMemo();
    const st = await S.projectStorage("project/99", actor, P(99));
    assert.equal(st.base, path.join(MEMBER_ROOT, "project", "99"), "이관이 실패해도 저장소는 열린다");
    assert.equal(exists(path.join(st.base, "a.txt")), false, "소유를 모르면 옮기지 않는다(fail-closed)");
    assert.equal(read(path.join(L, "a.txt")), "a");
  } finally {
    relayOff();
    S.setMigrationOwnership(async (q) => new Set(q.rels.filter((r) => !path.posix.basename(r).startsWith("foreign"))));
  }
});

// ═══ S7 배선 ═══════════════════════════════════════════════════════════════════

const src = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const repoFile = (rel: string): string => fs.readFileSync(path.resolve(new URL("../../", import.meta.url).pathname.replace("/dist/", "/"), rel), "utf8");

/** 라우트 머리부터 다음 `app.` 등록 전까지 */
function routeBody(file: string, head: string): string {
  const at = file.indexOf(head);
  assert.ok(at >= 0, `라우트가 없다: ${head}`);
  const next = file.indexOf("app.", at + head.length);
  return file.slice(at, next < 0 ? undefined : next);
}

test("W1·W2 파일 라우트는 전부 요청자 권한의 저장소(projStore)를 지난다 · 라우트 파일은 node:fs 를 안 쓴다", () => {
  const routes = src("./project-routes.ts");
  for (const head of [
    "app.get(`${prefix}/:id/files`", "app.get(`${prefix}/:id/file`", "app.put(`${prefix}/:id/file`",
    "app.post(`${prefix}/:id/folder`", "app.post(`${prefix}/:id/rename`", "app.post(`${prefix}/:id/move`",
    "app.delete(`${prefix}/:id/file`", "app.get(`${prefix}/:id/shared/manifest`",
    "app.get(`${prefix}/:id/rules`", "app.post(`${prefix}/:id/rules`", "app.get(`${prefix}/:id/agents`",
  ]) {
    const body = routeBody(routes, head);
    assert.match(body, /await projStore\(/, `${head} 가 저장소를 안 지난다 — 곁칸이 게이트웨이 로컬을 다시 읽게 된다`);
    assert.doesNotMatch(body, /projBase\(|projectAbsPath\(|\bfsp?\./, `${head} 가 게이트웨이 fs 를 직접 만진다`);
  }
  assert.doesNotMatch(routes, /from "node:fs(\/promises)?"/, "라우트 파일이 fs 를 가져오면 저장소를 우회하는 길이 생긴다");
  assert.match(routeBody(routes, "app.put(`${prefix}/:id/file`"), /osUser: store\.osUser/, "업로드 마무리가 바이트가 놓인 경계를 모른다");
});

test("W3 생성기·주입·자료 원본이 게이트웨이 로컬 경로로 파일을 만지지 않는다", () => {
  //  stage 판 — 노드 업로드 정본(#3787)·첫 지시 첨부 옮기기가 stage 에 아직 없다(그 자리는 main 판 시험이 잠근다).
  for (const rel of ["../v6/agents-md.ts", "../terminal/session-project-routes.ts", "../ingest/local-file.ts", "../terminal/terminal-files.ts"]) {
    assert.doesNotMatch(src(rel), /projectAbsPath/, `${rel} 이 게이트웨이 로컬 경로를 직접 푼다`);
  }
  const agents = src("../v6/agents-md.ts");
  assert.match(agents, /await st\.writeText\(file, content\)/, "AGENTS.md 를 저장소로 쓰지 않는다");
  assert.match(agents, /nextClaudeMd\(await st\.readText\(claude\), found\.from\)/, "CLAUDE.md 를 사람 글 보존 판정 없이 쓴다");
  assert.match(src("../terminal/session-project-routes.ts"), /projectStorage\(project\.folder, \{ user: u \}, /, "주입이 요청자 권한 저장소를 안 연다");
  assert.match(src("../ingest/local-file.ts"), /projectStorage\(row\.folder, /, "자료 원본이 저장소를 안 연다");
});

test("W4 곁칸 숨김 목록에 AGENTS.md·CLAUDE.md 가 없다(잡음 파일은 계속 숨긴다)", () => {
  const kit = repoFile("web/v2/panes-kit.ts");
  const m = kit.match(/export const MACHINE_FILES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, "MACHINE_FILES 정의를 못 찾았다(모양이 바뀌었으면 이 시험을 먼저 고칠 것)");
  const names = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(!names.includes("AGENTS.md") && !names.includes("CLAUDE.md"), `일반 파일과 같아야 한다: ${names.join(", ")}`);
  assert.ok(names.includes(".DS_Store"), "잡음 파일 숨김까지 걷으면 안 된다");
});

test("W5 호스트 마커는 게이트웨이 쪽에만 — 멤버 저장소(중앙 세션 cwd)에 심지 않는다", () => {
  const agents = src("../v6/agents-md.ts");
  assert.match(agents, /await writeProjectMarker\(st\.localBase, p\)/);
  assert.doesNotMatch(agents, /writeProjectMarker\(st\.base/);
});


test("W7 ★ 목록 라우트도 목록을 읽기 **전에** 멤버 모드 링크 봉쇄를 건다(리뷰 blocking)", () => {
  const body = routeBody(src("./project-routes.ts"), "app.get(`${prefix}/:id/files`");
  const jail = body.indexOf("await jailIfMember(store, abs)");
  const list = body.indexOf("await store.list(abs)");
  assert.ok(jail > 0, "목록 라우트에 봉쇄가 없다 — 세션이 심은 링크로 폴더 밖 목록이 곁칸에 나간다");
  assert.ok(list > jail, "봉쇄가 목록을 읽은 뒤에 오면 소용없다");
  for (const head of ["app.get(`${prefix}/:id/file`", "app.post(`${prefix}/:id/rename`", "app.post(`${prefix}/:id/move`", "app.delete(`${prefix}/:id/file`"]) {
    assert.match(routeBody(src("./project-routes.ts"), head), /await jailIfMember\(store, /, `${head} 에 봉쇄가 없다`);
  }
  for (const head of ["app.put(`${prefix}/:id/file`", "app.post(`${prefix}/:id/folder`"]) {
    assert.match(routeBody(src("./project-routes.ts"), head), /await resolveInProject\(store, /, `${head} 가 쓰기 관문을 안 지난다`);
  }
});

test("W9 기본 소유 확인은 이 워크스페이스 자료 표에서 그 프로젝트 좌표를 찾는다 · 모든 입구가 프로젝트를 넘긴다", () => {
  const store = src("./project-storage.ts");
  assert.match(store, /localExternalId\(\{ kind: "project", id: projectId \}, r\)/, "자료 좌표를 다른 모양으로 만들면 아무것도 소유로 안 잡힌다");
  assert.match(store, /FROM source WHERE external_system=\$1 AND external_instance=\$2 AND external_id = ANY\(\$3::text\[\]\)/);
  assert.match(store, /if \(p\) await settleMigration\(store\);/, "프로젝트를 모르면 이관하지 않아야 한다");
  assert.match(src("./project-routes.ts"), /projectStorage\(project\.folder, \{ user: userOf\(req\) \}, \{ id: project\.id, name: project\.name \}\)/);
  assert.match(src("../v6/agents-md.ts"), /\{ id: p\.id, name: p\.name \?\? null \}/);
  assert.match(src("../terminal/session-project-routes.ts"), /projectStorage\(project\.folder, \{ user: u \}, \{ id: project\.id, name: project\.name \}\)/);
  assert.match(src("../ingest/local-file.ts"), /\{ id: row\.id, name: row\.name \}/);
  //  stage 판 — 노드 업로드 정본(terminal-files)은 stage 에 아직 없다.
});

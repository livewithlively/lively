// 같은 이름 후보(#4672)의 규칙 — 사양 표 A(범위) · B(줄 세우기) · C(이름 찾기 — 로컬 판과 멤버 한 줄이 같은 사양). 진짜 임시 폴더를 쓴다.
//  사양(태스크 #4672 · 지식 file-address-scheme-design-4670 §4): 기록 없이 사라진 경로는 같은 이름 후보를 보인다(넘기지 않는다).
//   범위는 그 경로가 든 덩어리 하나(앱 폴더 · 프로젝트 폴더 · 맨 위 폴더) · 이름은 꼭 같아야(NFC/NFD 꼴 차이는 같은 이름) ·
//   숨김 · node_modules · git 저장소 · 링크로는 안 들어간다 · 걷는 양에 상한.
//   실행: npm run build && node --test dist/files/same-name.test.js
import { strict as assert } from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sameNameScope, rankSameName, findSameNameLocal, SAME_NAME_JS, SAME_NAME_LIMITS, SAME_NAME_SHOW, type SameNameFound, type SameNameHit, type SameNameLimits } from "./same-name.js";

/** 멤버 uid 로 돌 그 한 줄을 이 프로세스의 node 로 돌린다(stdin JSON → stdout JSON — memberNodeJson 과 같은 계약). */
function runMemberJs(base: string, name: string, lim: SameNameLimits = SAME_NAME_LIMITS): SameNameFound {
  const r = spawnSync(process.execPath, ["-e", SAME_NAME_JS], { input: JSON.stringify({ base, name, ...lim }), encoding: "utf8" });
  assert.equal(r.status, 0, `한 줄이 죽었다: ${r.stderr}`);
  return JSON.parse(r.stdout || "null") as SameNameFound;
}
const paths = (f: SameNameFound): string[] => f.hits.map((h) => h.path).sort();
/** 두 판을 같은 폴더에 돌려 같은 답인지 보고, 로컬 판의 답을 돌려준다. */
async function both(base: string, name: string, lim: SameNameLimits = SAME_NAME_LIMITS): Promise<SameNameFound> {
  const local = await findSameNameLocal(base, name, lim);
  const member = runMemberJs(base, name, lim);
  assert.deepEqual(paths(member), paths(local), "멤버 한 줄과 로컬 판이 다른 후보를 낸다");
  assert.equal(member.truncated, local.truncated, "멤버 한 줄과 로컬 판의 truncated 가 다르다");
  for (const h of local.hits) {
    const m = member.hits.find((x) => x.path === h.path)!;
    assert.deepEqual({ type: m.type, size: m.size, mtime: m.mtime }, { type: h.type, size: h.size, mtime: h.mtime }, `같은 후보의 모양이 다르다: ${h.path}`);
  }
  return local;
}

function tree(files: Record<string, string | null>): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "same-name-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(base, rel);
    if (body === null) fs.mkdirSync(abs, { recursive: true });
    else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body); }
  }
  return base;
}

// ── A. 범위 ──────────────────────────────────────────────────────────────────
test("A1 앱 폴더 — 그 앱 폴더 하나(다른 앱 폴더로 넘어가지 않는다)", () => {
  assert.equal(sameNameScope("apps", "crm/out/a.png"), "crm");
  assert.equal(sameNameScope("apps", "crm"), "crm");
});
test("A2 프로젝트 폴더 안 — 그 프로젝트 폴더(project · legacy-project)", () => {
  assert.equal(sameNameScope("shared", "project/12/docs/a.md"), "project/12");
  assert.equal(sameNameScope("shared", "project/12/a.md"), "project/12");
  assert.equal(sameNameScope("shared", "legacy-project/7/a.md"), "legacy-project/7");
});
test("A3 그 밖 — 맨 위 폴더 · 맨 위 파일이면 자리 전체 · 비슷한 이름(projects)은 프로젝트 규칙이 아니다", () => {
  assert.equal(sameNameScope("shared", "팀자료/x/y.md"), "팀자료");
  assert.equal(sameNameScope("shared", "a.md"), "");
  assert.equal(sameNameScope("shared", "projects/12/a.md"), "projects");
  assert.equal(sameNameScope("shared", "project/12"), "project", "프로젝트 폴더 자신(두 마디)은 맨 위 폴더 규칙");
  assert.equal(sameNameScope("personal", "uploads/a.png"), "uploads");
  assert.equal(sameNameScope("personal", "a.png"), "");
});

// ── B. 줄 세우기 ──────────────────────────────────────────────────────────────
const hit = (p: string, mtime = 0): SameNameHit => ({ path: p, type: "file", size: 1, mtime });
test("B1 받은 경로와 앞 폴더가 많이 겹치는 것이 먼저 — 더 최근 것보다도", () => {
  const out = rankSameName([hit("p/x/a.md", 900), hit("p/docs/old/a.md", 100), hit("p/docs/a2/a.md", 50)], "p/docs/old/a.md");
  assert.deepEqual(out.map((h) => h.path), ["p/docs/old/a.md", "p/docs/a2/a.md", "p/x/a.md"]);
});
test("B2 겹침이 같으면 최근에 고친 것 · 그것도 같으면 경로 글자순", () => {
  const out = rankSameName([hit("p/b/a.md", 1), hit("p/c/a.md", 5), hit("p/a/a.md", 1)], "p/z/a.md");
  assert.deepEqual(out.map((h) => h.path), ["p/c/a.md", "p/a/a.md", "p/b/a.md"]);
});
test("B3 상한 — 기본 8개 · 주면 그 수 · 빈 목록은 빈 목록", () => {
  const many = Array.from({ length: 12 }, (_, i) => hit(`d${String(i).padStart(2, "0")}/a.md`, i));
  assert.equal(SAME_NAME_SHOW, 8);
  assert.equal(rankSameName(many, "x/a.md").length, 8);
  assert.deepEqual(rankSameName(many, "x/a.md", 1).map((h) => h.path), ["d11/a.md"]);
  assert.deepEqual(rankSameName([], "x/a.md"), []);
});

// ── C. 이름 찾기(두 판 같은 사양) ─────────────────────────────────────────────
test("C1 꼭 같은 이름만 — 하위 폴더 여럿 · 포함만 된 이름 · 대소문자 다른 이름은 빠진다 · 폴더도 후보", async () => {
  const base = tree({
    "a/a.md": "x", "b/c/a.md": "yy", "d/a.md": "zzz",
    "e/a.md.bak": "1", "e/xa.md": "1", "e/A.md": "1",
    "f/a.md": null,
  });
  const f = await both(base, "a.md");
  assert.deepEqual(paths(f), ["a/a.md", "b/c/a.md", "d/a.md", "f/a.md"]);
  const dir = f.hits.find((h) => h.path === "f/a.md")!;
  assert.deepEqual({ type: dir.type, size: dir.size }, { type: "dir", size: 0 });
  const file = f.hits.find((h) => h.path === "d/a.md")!;
  assert.deepEqual({ type: file.type, size: file.size }, { type: "file", size: 3 });
  assert.ok(file.mtime > 0, "고친 때가 없다");
  assert.equal(f.truncated, false);
});
test("C2 NFC/NFD 꼴 차이는 같은 이름 — 경로는 디스크 이름 그대로", async () => {
  const nfd = "회의록.md".normalize("NFD");
  const base = tree({ [`x/${nfd}`]: "1" });
  const f = await both(base, "회의록.md".normalize("NFC"));
  assert.equal(f.hits.length, 1, "꼴만 다른 같은 이름을 놓쳤다");
  assert.equal(f.hits[0]!.path.normalize("NFC"), "x/회의록.md");
});
test("C3 숨김(점) · node_modules · git 저장소 안으로는 안 들어간다 · 점 이름 자신도 후보가 아니다", async () => {
  const base = tree({
    ".lively/a.md": "1", "p/.trash/a.md": "1", "node_modules/m/a.md": "1", "repo/.git/HEAD": "1", "repo/a.md": "1",
    "ok/a.md": "1", "q/.a.md": "1",
  });
  const f = await both(base, "a.md");
  assert.deepEqual(paths(f), ["ok/a.md"]);
  assert.deepEqual(paths(await both(base, ".a.md")), [], "점으로 시작하는 이름을 후보로 냈다");
});
test("C4 링크는 따라가지 않는다 — 폴더 링크 안 · 파일 링크 자신 모두 빠진다", async () => {
  const outside = tree({ "a.md": "바깥" });
  const base = tree({ "real/a.md": "1" });
  fs.symlinkSync(outside, path.join(base, "linkdir"));
  fs.symlinkSync(path.join(base, "real/a.md"), path.join(base, "a.md"));
  const f = await both(base, "a.md");
  assert.deepEqual(paths(f), ["real/a.md"]);
});
test("C5 깊이 상한 경계 — maxDepth 깊이의 폴더 안은 보고, 한 칸 더 아래는 안 본다", async () => {
  const base = tree({ "1/a.md": "1", "1/2/a.md": "1", "1/2/3/a.md": "1" });
  const lim = { ...SAME_NAME_LIMITS, maxDepth: 2 };
  assert.deepEqual(paths(await both(base, "a.md", lim)), ["1/2/a.md", "1/a.md"]);
  assert.deepEqual(paths(await both(base, "a.md", { ...SAME_NAME_LIMITS, maxDepth: 3 })), ["1/2/3/a.md", "1/2/a.md", "1/a.md"]);
});
test("C6 후보 수 상한 — 닿으면 그 수에서 멈추고 truncated", async () => {
  const base = tree({ "a/a.md": "1", "b/a.md": "1", "c/a.md": "1" });
  const f = await both(base, "a.md", { ...SAME_NAME_LIMITS, maxHits: 2 });
  assert.equal(f.hits.length, 2);
  assert.equal(f.truncated, true);
  const g = await both(base, "a.md", { ...SAME_NAME_LIMITS, maxHits: 3 });
  assert.equal(g.hits.length, 3);
  assert.equal(g.truncated, true, "상한에 정확히 닿았을 때도 멈춘다(더 있는지 모른다)");
});
test("C7 훑는 칸 상한 — 넘으면 거기서 멈추고 truncated(넓이 우선이라 얕은 것부터 본다)", async () => {
  const base = tree({ "a.md": "1", "z/deep/a.md": "1" });
  const f = await both(base, "a.md", { ...SAME_NAME_LIMITS, maxSeen: 2 });   // 맨 위 두 칸(a.md · z)만 본다
  assert.deepEqual(paths(f), ["a.md"]);
  assert.equal(f.truncated, true);
  const g = await both(base, "a.md", { ...SAME_NAME_LIMITS, maxSeen: 4 });   // 맨 위 둘 + z 안 deep + deep 안 a.md
  assert.deepEqual(paths(g), ["a.md", "z/deep/a.md"]);
  assert.equal(g.truncated, false);
});
test("C7b 훑는 칸 상한의 경계 — 정확히 상한만큼 본 뒤의 칸은 안 본다(한 칸 더 보지 않는다)", async () => {
  const base = tree({ "a/a.md": "1" });                                   // 맨 위 칸 하나(a) + 그 안 칸 하나(a.md)
  const f = await both(base, "a.md", { ...SAME_NAME_LIMITS, maxSeen: 1 });
  assert.deepEqual({ hits: paths(f), truncated: f.truncated }, { hits: [], truncated: true });
  const g = await both(base, "a.md", { ...SAME_NAME_LIMITS, maxSeen: 2 });
  assert.deepEqual({ hits: paths(g), truncated: g.truncated }, { hits: ["a/a.md"], truncated: false });
});

test("C8 범위 폴더가 없으면 빈 답(던지지 않는다)", async () => {
  const f = await both(path.join(os.tmpdir(), "same-name-none-" + process.pid), "a.md");
  assert.deepEqual(f, { hits: [], truncated: false });
});

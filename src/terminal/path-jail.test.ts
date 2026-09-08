// 파일 API **경로 봉쇄**(#3668 T1) — 심링크를 해소한 뒤 접두를 보는가.
//
// 사양: 파일 API 가 사람에게서 받은 경로는 베이스(세션 작업폴더·허용 루트) 안에서만 op 를 수행한다. "안" 의 판정은
//  **심링크를 해소한 뒤의 실제 위치**로 한다 — 글자만 접은 위치가 아니다. 심링크를 금지하지는 않는다(폴더 링크로
//  들어가는 기능이 쓰인다): 해소한 결과가 베이스 안이면 정상 경로고, 밖이면 거부다. 아직 없는 경로는 정상이며
//  (업로드·mkdir 이 만든다), 존재하는 가장 깊은 조상까지 해소한 뒤 남은 이름은 글자 그대로 이어 붙여 판정한다.
//  "이름이 없다" 와 "링크는 있는데 대상이 없다"(댕글링)는 다른 상태다 — 후자는 거부한다(검사 뒤 대상이 생기면
//  그대로 바깥을 가리킨다. `broker/exec.ts:22` 가 같은 문제를 같은 규율로 이미 풀었다).
//
// 왜 테스트하나: `path.resolve` 는 `..` 를 글자로 접을 뿐 심링크를 해석하지 않는다. 그래서 종전 검사는
//  `ln -s <바깥> x` 하나로 통과했다(read=cat, ls=statSync 라 둘 다 링크를 따라간다). 지금 그게 안 터지는 이유는
//  경로검사가 아니라 **감옥**(파일 op 컨테이너 마운트)이고, #3668 T2·T3 가 그 감옥을 걷는다 — 그때 이 계약이
//  서 있지 않으면 그 순간 취약점이 된다. 코드만 보면 맞아 보이는 자리라 계약을 여기서 못박는다.
//
// 두 구현을 **함께** 재는 이유: 같은 판정을 게이트웨이 로컬(probeLocal — plain fs)과 격리 멤버 경계
//  (PROBE_JS — 멤버 uid 로 도는 node 한 줄 리터럴)가 각각 해소한다. 한쪽만 고치면 격리 조직에서만 옛 동작이
//  남아 재현이 어려운 신고가 된다(#1744 가 그 실측이다).
//
// 실행: npm run build && node dist/terminal/path-jail.test.js
import { strict as assert } from "node:assert";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { confined, isConfined, probeLocal, PROBE_JS, type PathProbe } from "./path-jail.js";

/** 표본 트리 — 엣지 표의 상황을 한 번에 담는다. 베이스 밖 대상(outside*)이 있어야 '넘어간다'가 재진다. */
function fixture(): { root: string; base: string; baseLink: string; missingBase: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lively-jail-"));
  const base = path.join(root, "base");
  fs.mkdirSync(base);
  fs.mkdirSync(path.join(root, "outside"));
  fs.writeFileSync(path.join(root, "outside", "secret.txt"), "secret");
  fs.writeFileSync(path.join(root, "outside-file.md"), "# secret");
  fs.writeFileSync(path.join(base, "plain.txt"), "ok");
  fs.mkdirSync(path.join(base, "plain-dir"));
  fs.writeFileSync(path.join(base, "plain-dir", "inner.txt"), "ok");
  fs.symlinkSync("plain-dir", path.join(base, "rel-dir"));                        // 베이스 **안**을 가리키는 상대 링크
  fs.symlinkSync(path.join(root, "outside"), path.join(base, "link-dir"));        // 베이스 **밖** 폴더 링크
  fs.symlinkSync(path.join(root, "outside-file.md"), path.join(base, "link-file")); // 베이스 **밖** 파일 링크
  fs.symlinkSync(path.join(root, "nope"), path.join(base, "link-broken"));        // 댕글링(대상 없음)
  const baseLink = path.join(root, "base-link");
  fs.symlinkSync(base, baseLink);                                                 // 베이스 자체가 심링크인 배포
  return { root, base, baseLink, missingBase: path.join(root, "missing-base") };
}

/** 멤버 경계 한 줄(PROBE_JS)을 실제로 돌려 얻는 해소 결과 — 격리 배포에서 도는 그 코드 그대로. */
function probeOneLiner(base: string, target: string): PathProbe {
  const out = execFileSync(process.execPath, ["-e", PROBE_JS, base, target], { encoding: "utf8" });
  return JSON.parse(out) as PathProbe;
}

/** 한 행을 **두 구현으로** 함께 잰다 — 답이 갈리면 그 자체가 실패다. */
async function bothVerdicts(base: string, rel: string): Promise<{ local: boolean; oneliner: boolean }> {
  const abs = path.resolve(base, rel);
  const local = confined(await probeLocal(base, abs));
  const oneliner = confined(probeOneLiner(base, abs));
  assert.equal(local, oneliner, `두 구현의 판정이 갈렸다(local=${local} oneliner=${oneliner}) — rel=${rel}`);
  return { local, oneliner };
}

const allow = async (base: string, rel: string, why: string): Promise<void> => {
  const v = await bothVerdicts(base, rel);
  assert.equal(v.local, true, why);
};
const deny = async (base: string, rel: string, why: string): Promise<void> => {
  const v = await bothVerdicts(base, rel);
  assert.equal(v.local, false, why);
};

// ── 엣지 표 ①~⑬ — 행마다 하나 ─────────────────────────────────────────────────
test("① 평범한 하위 파일(존재) — 통과", async () => {
  await allow(fixture().base, "plain.txt", "베이스 안 일반 파일은 그대로 열려야 한다");
});

test("② 하위 폴더 경유(존재) — 통과", async () => {
  await allow(fixture().base, "plain-dir/inner.txt", "베이스 안 하위 폴더 경유는 그대로 열려야 한다");
});

test("③★ 베이스 **안**을 가리키는 링크 경유 — 통과(심링크를 금지하지 않는다)", async () => {
  await allow(fixture().base, "rel-dir/inner.txt", "해소 결과가 베이스 안이면 링크여도 정상 경로다");
});

test("④★★ 베이스 **밖** 폴더 링크 경유 — 거부", async () => {
  await deny(fixture().base, "link-dir/secret.txt", "링크를 따라가면 베이스 밖이다 — 글자 판정만으로는 통과하던 자리");
});

test("⑤★★ 베이스 **밖** 파일 링크 자체 — 거부", async () => {
  await deny(fixture().base, "link-file", "cat 이 링크를 따라간다 — 대상이 베이스 밖이면 거부");
});

test("⑥ 아직 없는 경로(업로드·mkdir 대상) — 통과", async () => {
  await allow(fixture().base, "newdir/new.txt", "만들 경로는 존재하지 않는 것이 정상이다");
});

test("⑦★★ 아직 없는 경로인데 **중간이 바깥 링크** — 거부", async () => {
  await deny(fixture().base, "link-dir/new.txt", "존재하지 않는 이름이 붙어도 조상이 밖이면 밖이다");
});

test("⑧★ 댕글링 링크 — 거부(‘이름이 없다’와 다른 상태다)", async () => {
  await deny(fixture().base, "link-broken", "검사를 통과시키면 뒤에 대상이 생겨 그대로 바깥을 가리킨다");
});

test("⑨ 대상이 곧 베이스 — 통과 · 해소 왕복 0건", async () => {
  const f = fixture();
  let calls = 0;
  const counting = async (b: string, t: string): Promise<PathProbe> => { calls++; return probeLocal(b, t); };
  assert.equal(await isConfined(f.base, f.base, counting), true);
  assert.equal(calls, 0, "루트 목록에 왕복을 더하면 안 된다 — 검사할 것이 없는 자리다");
  // 배선 확인 — 이 counting 스텁이 실제로 불릴 수 있는 물건인지(호출 0건이 '죽은 스텁' 때문이 아님을 못박는다)
  assert.equal(await isConfined(f.base, path.join(f.base, "plain.txt"), counting), true);
  assert.equal(calls, 1, "대상이 베이스가 아니면 해소는 반드시 일어난다");
});

test("⑩ 베이스 자체가 심링크인 배포 — 안쪽 경로는 통과", async () => {
  const f = fixture();
  await allow(f.baseLink, "plain.txt", "베이스도 해소해서 비교해야 한다 — 아니면 전부 거부된다");
  await deny(f.baseLink, "link-dir/secret.txt", "베이스가 링크여도 바깥 링크는 여전히 거부다");
});

test("⑪ `..` 탈출 — 거부(글자 판정을 지나쳐 왔더라도 2차 관문이 잡는다)", async () => {
  await deny(fixture().base, "../outside/secret.txt", "해소 결과가 베이스 밖이면 어떤 경로로 왔든 거부");
});

test("⑫ 베이스가 아직 없음(루트 첫 사용) — 통과", async () => {
  await allow(fixture().missingBase, "plain.txt", "베이스가 없으면 그 밑에 존재하는 것도 없다 — 막을 것이 없다");
});

test("⑬ 해소 불가(ENOENT 아닌 오류) — 거부(fail-closed)", () => {
  assert.equal(confined({ base: "/b", real: null, rest: [], error: "EACCES" }), false);
});

// ── 새로 도입한 값이 비었거나 부재인 경우 ────────────────────────────────────
test("⑭ probe 가 base:null 을 보고 — 통과(⑫와 같은 답)", () => {
  assert.equal(confined({ base: null, real: null, rest: [] }), true);
});

test("⑮ probe 가 real:null 을 보고(조상조차 해소 못 함) — 거부(fail-closed)", () => {
  assert.equal(confined({ base: "/b", real: null, rest: [] }), false);
  assert.equal(confined(null), false);
  assert.equal(confined(undefined), false);
});

test("⑯ 해소 결과를 그대로 믿지 않는다 — rest 에 이름 아닌 값이 섞이면 거부", () => {
  assert.equal(confined({ base: "/b", real: "/b", rest: ["ok"] }), true);
  assert.equal(confined({ base: "/b", real: "/b", rest: ["..", "..", "etc"] }), false);
  assert.equal(confined({ base: "/b", real: "/b", rest: ["a/../../etc"] }), false);
});

// ── 배선(wiring) — 관측 장치가 살아 있나 ─────────────────────────────────────
test("배선: 한 줄(PROBE_JS)이 실제로 돌아 사실을 싣고 온다(빈 값·죽은 스텁이 아니다)", async () => {
  const f = fixture();
  const inside = probeOneLiner(f.base, path.join(f.base, "plain.txt"));
  assert.equal(inside.base, fs.realpathSync(f.base));
  assert.equal(inside.real, fs.realpathSync(path.join(f.base, "plain.txt")));
  const outside = probeOneLiner(f.base, path.join(f.base, "link-dir", "secret.txt"));
  assert.equal(outside.real, fs.realpathSync(path.join(f.root, "outside", "secret.txt")));
  assert.equal(outside.real!.startsWith(inside.base! + path.sep), false, "링크를 따라간 실제 위치가 베이스 밖임을 실제로 봤다");
  // 로컬 구현도 같은 사실을 싣는가(두 구현이 같은 사양이라는 것의 근거)
  assert.deepEqual(await probeLocal(f.base, path.join(f.base, "link-dir", "secret.txt")), outside);
});

test("배선: 표본이 실제로 그 모양인가(링크가 링크이고, 바깥 대상이 존재한다)", () => {
  const f = fixture();
  assert.equal(fs.lstatSync(path.join(f.base, "link-dir")).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(f.base, "link-broken")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(f.root, "outside", "secret.txt")), true);
  assert.equal(fs.existsSync(path.join(f.base, "link-broken")), false, "댕글링은 stat 으로는 없는 것으로 보인다");
});

// NAS 색인 사양 검증 — 너비 우선 crawl·한도·실패 폴더, 이름 검색(AND·under·type·정렬·limit), 키별 색인 캐시.
// 실행: npm run build && node dist/net/nas/nas-index.test.js
import assert from "node:assert/strict";
import { crawl, searchEntries, NasIndexCache, type NasEntry, type CrawlResult } from "./nas-index.js";

let pass = 0;
const failed: string[] = [];
const t = (name: string, fn: () => Promise<void> | void): Promise<void> =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log(`ok  ${name}`); },
    (e) => { failed.push(name); console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split("\n").join("\n     ")}`); },
  );

const latin1 = (b: number[]): string => Buffer.from(b).toString("latin1");
const EUCKR_MUNSEO = latin1([0xb9, 0xae, 0xbc, 0xad]); // "문서" in EUC-KR
const NO_LIMITS = { maxDirs: 1_000, maxEntries: 1_000, deadlineMs: 60_000 };

const dirLine = (name: string) => `drwxr-xr-x    2 1000     1000         4096 Jan 05  2024 ${name}`;
const fileLine = (name: string, size = 10, stamp = "Jan 05  2024") => `-rw-r--r--    1 1000     1000 ${String(size).padStart(12)} ${stamp} ${name}`;
const linkLine = (name: string, target: string) => `lrwxrwxrwx    1 1000     1000            5 Jan 05  2024 ${name} -> ${target}`;
const otherLine = (name: string) => `prw-r--r--    1 1000     1000            0 Jan 05  2024 ${name}`;

/** rawDir → LIST 본문. 없는 폴더는 실패(throw). 호출 순서를 기록한다. */
function fakeFs(tree: Record<string, string[]>, onCall?: () => void) {
  const calls: string[] = [];
  const list = async (rawDir: string): Promise<string> => {
    calls.push(rawDir);
    onCall?.();
    const lines = tree[rawDir];
    if (!lines) throw new Error(`550 ${rawDir}`);
    return ["total 1", ...lines].join("\r\n") + "\r\n";
  };
  return { list, calls };
}

const TREE: Record<string, string[]> = {
  "/": [dirLine("A"), dirLine("B"), fileLine("root.txt", 77, "Feb 03  2023"), linkLine("ln", "A"), otherLine("fifo")],
  "/A": [dirLine("A1"), fileLine("a.txt")],
  "/B": [fileLine("b.txt")],
  "/A/A1": [fileLine("deep.txt")],
};

await t("crawl: 너비 우선으로 폴더를 연다", async () => {
  const fs = fakeFs(TREE);
  await crawl(fs.list, "/", NO_LIMITS);
  assert.deepEqual(fs.calls, ["/", "/A", "/B", "/A/A1"]);
});

await t("crawl: 파일·폴더는 항목, 링크·other 는 빼고 따라가지 않음, 넘치지 않으면 truncated=null", async () => {
  const fs = fakeFs(TREE);
  const r = await crawl(fs.list, "/", NO_LIMITS);
  assert.deepEqual(r.entries.map((e) => `${e.type}:${e.raw}`).sort(),
    ["dir:/A", "dir:/A/A1", "dir:/B", "file:/A/A1/deep.txt", "file:/A/a.txt", "file:/B/b.txt", "file:/root.txt"]);
  assert.ok(!fs.calls.includes("/ln") && !fs.calls.includes("/fifo"));
  assert.equal(r.dirs, 4);
  assert.equal(r.truncated, null);
  assert.equal(r.failedDirs, 0);
  const root = r.entries.find((e) => e.raw === "/root.txt")!;
  assert.equal(root.path, "/root.txt");
  assert.equal(root.size, 77);
  assert.equal(root.mtime, "2023-02-03");
});

await t("crawl: root 가 / 가 아니면 raw 는 '상위/이름'", async () => {
  const fs = fakeFs(TREE);
  const r = await crawl(fs.list, "/A", NO_LIMITS);
  assert.deepEqual(r.entries.map((e) => e.raw).sort(), ["/A/A1", "/A/A1/deep.txt", "/A/a.txt"]);
});

await t("crawl: raw 는 원본 바이트 경로, path 는 displayPath(raw)", async () => {
  const fs = fakeFs({ "/": [dirLine(EUCKR_MUNSEO)], [`/${EUCKR_MUNSEO}`]: [fileLine("x.txt")] });
  const r = await crawl(fs.list, "/", NO_LIMITS);
  assert.deepEqual(fs.calls, ["/", `/${EUCKR_MUNSEO}`]);
  const f = r.entries.find((e) => e.type === "file")!;
  assert.equal(f.raw, `/${EUCKR_MUNSEO}/x.txt`);
  assert.equal(f.path, "/문서/x.txt");
});

await t("crawl: list 실패 폴더는 failedDirs 를 늘리고 나머지는 계속", async () => {
  const tree = { ...TREE };
  delete tree["/A"];
  const fs = fakeFs(tree);
  const r = await crawl(fs.list, "/", NO_LIMITS);
  assert.equal(r.failedDirs, 1);
  assert.ok(r.entries.some((e) => e.raw === "/B/b.txt"));
  assert.ok(!r.entries.some((e) => e.raw.startsWith("/A/")));
});

await t("crawl: maxDirs·maxEntries·deadlineMs 에 닿으면 멈추고 truncated 에 까닭", async () => {
  // 넓은 트리: 루트 아래 폴더 10개, 각 폴더에 파일 3개
  const wide: Record<string, string[]> = { "/": Array.from({ length: 10 }, (_, i) => dirLine(`d${i}`)) };
  for (let i = 0; i < 10; i++) wide[`/d${i}`] = [fileLine("f1"), fileLine("f2"), fileLine("f3")];
  const totalDirs = 11;

  {
    const fs = fakeFs(wide);
    const r = await crawl(fs.list, "/", { ...NO_LIMITS, maxDirs: 3 });
    assert.ok(fs.calls.length <= 3, `opened ${fs.calls.length}`);
    assert.equal(typeof r.truncated, "string");
  }
  {
    const fs = fakeFs(wide);
    const r = await crawl(fs.list, "/", { ...NO_LIMITS, maxEntries: 15 });
    assert.equal(r.entries.length, 15);
    assert.equal(typeof r.truncated, "string");
  }
  {
    let clock = 1_000;
    const fs = fakeFs(wide, () => { clock += 10; });
    const r = await crawl(fs.list, "/", { ...NO_LIMITS, deadlineMs: 25 }, () => clock);
    assert.ok(fs.calls.length < totalDirs, `opened ${fs.calls.length}`);
    assert.equal(typeof r.truncated, "string");
  }
});

const E = (raw: string, type: "file" | "dir" = "file", mtime = "2024-01-01"): NasEntry =>
  ({ raw, path: raw, type, size: 1, mtime }) as NasEntry;

await t("searchEntries: 낱말 모두 포함(AND)·대소문자 무시", () => {
  const es = [E("/a/Report_2024.pdf"), E("/a/report.pdf"), E("/2024/x.txt"), E("/REPORT/2024/y.txt")];
  const r = searchEntries(es, "report 2024");
  assert.deepEqual(r.items.map((e) => e.raw).sort(), ["/REPORT/2024/y.txt", "/a/Report_2024.pdf"]);
  assert.equal(r.total, 2);
});

await t("searchEntries: NFC 기준 비교(NFD 질의도 맞춘다)", () => {
  const es = [E("/문서/보고서.hwp"), E("/기타/메모.txt")];
  const r = searchEntries(es, "보고서".normalize("NFD"));
  assert.deepEqual(r.items.map((e) => e.raw), ["/문서/보고서.hwp"]);
});

await t("searchEntries: 빈 query 면 낱말 조건 없음", () => {
  const es = [E("/a"), E("/b"), E("/c")];
  assert.equal(searchEntries(es, "").total, 3);
});

await t("searchEntries: under 는 그 경로 자신 또는 그 아래만, 끝 / 무시", () => {
  const es = [E("/SME", "dir"), E("/SME/a.txt"), E("/SME금융", "dir"), E("/SME금융/b.txt"), E("/X/SME/c.txt")];
  for (const under of ["/SME", "/SME/"]) {
    const r = searchEntries(es, "", { under });
    assert.deepEqual(r.items.map((e) => e.raw).sort(), ["/SME", "/SME/a.txt"], under);
  }
});

await t("searchEntries: type 이 있으면 그 종류만", () => {
  const es = [E("/d", "dir"), E("/d/f.txt"), E("/e", "dir")];
  assert.deepEqual(searchEntries(es, "", { type: "dir" }).items.map((e) => e.raw).sort(), ["/d", "/e"]);
});

await t("searchEntries: 이름에 든 낱말 수 많은 순, 같으면 mtime 최근 순", () => {
  const es = [
    E("/보고서/2024/a.txt", "file", "2025-12-01 10:00"), // 이름 낱말 0
    E("/2024/보고서.pdf", "file", "2024-01-01 00:00"), // 이름 낱말 1 (오래됨)
    E("/x/2024/y/보고서_2024.pdf", "file", "2020-01-01 00:00"), // 이름 낱말 2
    E("/2024/z/보고서.hwp", "file", "2024-06-01 00:00"), // 이름 낱말 1 (최근)
  ];
  const r = searchEntries(es, "보고서 2024");
  assert.deepEqual(r.items.map((e) => e.raw),
    ["/x/2024/y/보고서_2024.pdf", "/2024/z/보고서.hwp", "/2024/보고서.pdf", "/보고서/2024/a.txt"]);
});

await t("searchEntries: limit 기본 50, 1~200 으로 자르고 total 은 자르기 전 개수", () => {
  const es = Array.from({ length: 250 }, (_, i) => E(`/f${i}.txt`));
  const cases: [number | undefined, number][] = [[undefined, 50], [3, 3], [0, 1], [-5, 1], [500, 200]];
  for (const [limit, want] of cases) {
    const r = searchEntries(es, "", limit === undefined ? {} : { limit });
    assert.equal(r.items.length, want, `limit=${limit}`);
    assert.equal(r.total, 250);
  }
});

// ---- NasIndexCache ----
const HOUR = 60 * 60_000;
const result = (tag: string): CrawlResult => ({ entries: [E(`/${tag}`)], dirs: 1, truncated: null, failedDirs: 0 }) as CrawlResult;
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

await t("NasIndexCache.build: 진행 중 같은 키는 run 을 다시 부르지 않고 같은 약속", async () => {
  const c = new NasIndexCache(() => 0);
  const d = deferred<CrawlResult>();
  let runs = 0;
  const run = () => { runs++; return d.promise; };
  const p1 = c.build("k", run);
  const p2 = c.build("k", run);
  assert.equal(p1, p2);
  assert.equal(runs, 1);
  d.resolve(result("r"));
  await p1;
});

await t("NasIndexCache.build: 성공하면 result·builtAt 설정, error=null, building=null", async () => {
  let clock = 5_000;
  const c = new NasIndexCache(() => clock);
  const r = result("r");
  await c.build("k", async () => { clock = 7_000; return r; });
  const s = c.get("k");
  assert.equal(s.result, r);
  assert.equal(typeof s.builtAt, "number");
  assert.equal(s.error, null);
  assert.equal(s.building, null);
});

await t("NasIndexCache.build: 실패하면 error 에 메시지, 기존 result 유지, building=null", async () => {
  const c = new NasIndexCache(() => 0);
  const r = result("old");
  await c.build("k", async () => r);
  await c.build("k", async () => { throw new Error("boom-msg"); }).catch(() => {});
  const s = c.get("k");
  assert.equal(s.result, r);
  assert.match(String(s.error), /boom-msg/);
  assert.equal(s.building, null);
});

await t("NasIndexCache.isFresh: result 있고 builtAt 후 12시간 미만일 때만", async () => {
  let clock = 1_000_000;
  const c = new NasIndexCache(() => clock);
  assert.equal(c.isFresh("k"), false);
  await c.build("k", async () => result("r"));
  const builtAt = c.get("k").builtAt as number;
  const cases: [number, boolean][] = [[0, true], [12 * HOUR - 1, true], [12 * HOUR, false], [13 * HOUR, false]];
  for (const [dt, want] of cases) {
    clock = builtAt + dt;
    assert.equal(c.isFresh("k"), want, `dt=${dt}`);
  }
});

await t("NasIndexCache: 10개 넘으면 진행 중 아닌 것 중 가장 오래 전에 만든 키를 버린다", async () => {
  let clock = 0;
  const c = new NasIndexCache(() => clock);
  for (let i = 0; i < 10; i++) { clock = i * 1_000; await c.build(`k${i}`, async () => result(`k${i}`)); }
  clock = 20_000;
  await c.build("k10", async () => result("k10"));
  for (let i = 1; i <= 10; i++) assert.equal(c.isFresh(`k${i}`), true, `k${i}`);
  assert.equal(c.isFresh("k0"), false);
});

await t("NasIndexCache: 아직 안 만든(실패만 한) 키가 먼저 버려진다", async () => {
  let clock = 0;
  const c = new NasIndexCache(() => clock);
  await c.build("never", async () => { throw new Error("fail-never"); }).catch(() => {});
  for (let i = 1; i < 10; i++) { clock = i * 1_000; await c.build(`k${i}`, async () => result(`k${i}`)); }
  clock = 20_000;
  await c.build("k10", async () => result("k10"));
  for (let i = 1; i <= 10; i++) assert.equal(c.isFresh(`k${i}`), true, `k${i}`);
  // 버려졌으면 실패 기록(error)도 함께 사라진다
  assert.doesNotMatch(String(c.get("never").error ?? ""), /fail-never/);
});

await t("NasIndexCache: 진행 중인 키는 버리지 않는다", async () => {
  let clock = 0;
  const c = new NasIndexCache(() => clock);
  const d = deferred<CrawlResult>();
  const pending = c.build("busy", () => d.promise); // 진행 중, 아직 안 만든 키
  for (let i = 1; i < 10; i++) { clock = i * 1_000; await c.build(`k${i}`, async () => result(`k${i}`)); }
  clock = 20_000;
  await c.build("k10", async () => result("k10"));
  assert.equal(c.isFresh("k1"), false); // busy 대신 가장 오래된 k1 이 버려짐
  for (let i = 2; i <= 10; i++) assert.equal(c.isFresh(`k${i}`), true, `k${i}`);
  d.resolve(result("busy"));
  await pending;
  assert.equal(c.isFresh("busy"), true);
});

console.log(`\n${pass} passed, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;

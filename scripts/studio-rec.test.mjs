#!/usr/bin/env node
// 앱빌더 기록 · 사본 · 세션 이름 · 개발 정보 알림의 순수 규칙(#4632 감사 1-3 · 1-4 · 1-8 · 1-9 · 4-11).
//
// 엣지 표(스크래치패드 forkA-spec.md):
//  R1 trimRecs 한도 안 — 그대로
//  R2 한도를 넘음 · 다 만든 기록이 있다 — 다 만든 것부터(오래된 것부터) 빠지고 안 끝난 것은 모두 남는다
//  R3 한도를 넘음 · 다 만든 것만으로 모자람 — 남은 것 중 오래된 것부터
//  R4 경계 — 정확히 한도면 그대로 · 한도 40
//  M1 mergeRec 다른 탭이 칸 x 를 바꿨고 이 탭은 칸 y 를 바꿨다 — x 는 받고 y 는 그대로
//  M2 같은 칸을 둘 다 바꿨다 — 이 탭(나중 저장)이 이긴다
//  M3 다른 탭이 칸을 지웠다 — 이 탭도 지운다 · 이 탭이 그 칸을 바꿨으면 남는다
//  M4 받은 값은 깊은 복사 — 저장된 것을 고쳐도 이 탭 기록이 따라 바뀌지 않는다
//  C1 nextCopyId — «-2» 부터 비어 있는 첫 번호 · 32자를 넘지 않는다
//  L1 isEditSessionLabel — «"이름" 앱 고치기» · 옛 「앱 고치기 · 」 는 예 · «"이름" 앱 제작» · 「새 앱 제작」 · 보통 이름은 아니오
//  T1 retryAfterText — 초 · 분 · 0 이하도 1초
//  M5 (리뷰 N5) skip 의 칸(pins · general)은 다른 탭이 바꿨어도 이 탭 것 그대로 — 같은 배열(화면이 쥔 것)을 바꿔 끼우지 않는다
//  G1 (리뷰 N10) regenToast — 쓰기 시작(writing · stale)일 때만 «시작했어요» · 간격 · 몫 · 키 없음 · 그대로 실패 · 이미 다 씀은 그렇다고
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ 을 물린다(origin/main 에는 이 함수들이 없어 빨갛다).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const WEB = path.join(SRC_ROOT, "web");
const ESBUILD = path.join(ROOT, "node_modules/.bin/esbuild");
if (!existsSync(ESBUILD)) { console.error("FAIL  esbuild 가 없다"); process.exit(1); }
let M;
try {
  const js = execFileSync(ESBUILD, ["--bundle", "--format=esm", "--platform=neutral", "--loader=ts", "--sourcefile=rec-entry.ts", "--log-level=error"], { cwd: WEB, encoding: "utf8",
    input: "export { trimRecs, mergeRec, REC_MAX } from './lib/studio-rec.ts'; export { nextCopyId } from './lib/studio-flow.ts'; export { isEditSessionLabel } from './lib/builder-flow.ts'; export { retryAfterText, regenToast } from './lib/app-spec-view.ts';" });
  M = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
} catch (e) { console.error("FAIL  묶지 못했다(함수가 없다) — " + String(e.message || e).split("\n")[0]); process.exit(1); }

let pass = 0, fail = 0;
const same = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); if (a === b) { pass++; console.log("ok  " + n); } else { fail++; console.error(`FAIL  ${n} — 기대 ${b} · 실제 ${a}`); } };

const r = (id, done = false) => ({ sid: id, done });
const ids = (xs) => xs.map((x) => x.sid);
same(ids(M.trimRecs([r("a"), r("b")], 3)), ["a", "b"], "R1 한도 안이면 그대로");
same(ids(M.trimRecs([r("a"), r("d1", true), r("b"), r("d2", true), r("c")], 3)), ["a", "b", "c"], "R2 다 만든 것부터 빠지고 안 끝난 것은 모두 남는다");
same(ids(M.trimRecs([r("a"), r("d1", true), r("b"), r("c"), r("e")], 3)), ["b", "c", "e"], "R3 다 만든 것만으로 모자라면 남은 것 중 오래된 것부터");
same([ids(M.trimRecs([r("a"), r("b"), r("c")], 3)), M.REC_MAX, M.trimRecs(Array.from({ length: 41 }, (_, i) => r("s" + i)), M.REC_MAX).length], [["a", "b", "c"], 40, 40], "R4 정확히 한도면 그대로 · 한도 40");

{
  const base = { sid: "s", stage: "plan", card: { name: "회의록" }, general: "" };
  const stored = { sid: "s", stage: "plan", card: { name: "회의록 v2" }, general: "" };   // 다른 탭이 카드를 고쳤다
  const cur = { sid: "s", stage: "plan", card: { name: "회의록" }, general: "글자 크게" };   // 이 탭은 의견만 적었다
  const took = M.mergeRec(cur, base, stored);
  same([cur.card, cur.general, took], [{ name: "회의록 v2" }, "글자 크게", ["card"]], "M1 다른 탭이 바꾼 칸은 받고 이 탭이 바꾼 칸은 그대로");
}
{
  const base = { sid: "s", title: "A" }, stored = { sid: "s", title: "B" }, cur = { sid: "s", title: "C" };
  M.mergeRec(cur, base, stored);
  same(cur.title, "C", "M2 같은 칸을 둘 다 바꾸면 이 탭이 이긴다");
}
{
  const base = { sid: "s", whatEdit: { name: "x" }, check: { ver: 1 } }, stored = { sid: "s" };
  const cur = { sid: "s", whatEdit: { name: "x" }, check: { ver: 2 } };
  M.mergeRec(cur, base, stored);
  same(["whatEdit" in cur, cur.check], [false, { ver: 2 }], "M3 다른 탭이 지운 칸은 지우고 이 탭이 바꾼 칸은 남는다");
}
{
  const base = { sid: "s", pins: [] }, stored = { sid: "s", pins: [{ n: 1 }] }, cur = { sid: "s", pins: [] };
  M.mergeRec(cur, base, stored); stored.pins[0].n = 9;
  same(cur.pins, [{ n: 1 }], "M4 받은 값은 깊은 복사");
}
{
  const a = M.nextCopyId("memo-wonjoon-jang", new Set(["memo-wonjoon-jang"]));
  const b = M.nextCopyId("memo-wonjoon-jang", new Set(["memo-wonjoon-jang", "memo-wonjoon-jang-2"]));
  const long = "a".repeat(32);
  const c = M.nextCopyId(long, new Set([long]));
  same([a, b, c.id.length <= 32, c.id.endsWith("-2"), c.n], [{ id: "memo-wonjoon-jang-2", n: 2 }, { id: "memo-wonjoon-jang-3", n: 3 }, true, true, 2], "C1 비어 있는 첫 번호 · 32자 안");
}
{
  const pins = [{ n: 1 }];
  const base = { sid: "s", pins: [], general: "", title: "A" }, stored = { sid: "s", pins: [{ n: 9 }], general: "남의 글", title: "B" }, cur = { sid: "s", pins, general: "", title: "A" };
  M.mergeRec(cur, base, stored, ["pins", "general"]);
  same([cur.pins === pins, cur.pins, cur.general, cur.title], [true, [{ n: 1 }], "", "B"], "M5 skip 의 칸은 이 탭 것 그대로(같은 배열) · 다른 칸은 받는다");
}
same([["writing"], ["stale"], ["limit"], ["unavailable"], ["failed"], ["ok"], ["failed", 42000]].map(([st, ms]) => { const t = M.regenToast({ spec_state: st, retry_after_ms: ms || null }); return [/시작했어요/.test(t.text) && !/못했어요/.test(t.text), t.warn]; }),
  [[true, false], [true, false], [false, true], [false, true], [false, true], [false, false], [false, true]], "G1 쓰기 시작했을 때만 «시작했어요»");
same(['"메모" 앱 고치기', "앱 고치기 · 메모", '"메모" 앱 제작', "새 앱 제작", "회의록 정리해 줘", ""].map(M.isEditSessionLabel), [true, true, false, false, false, false], "L1 고치기 세션 이름만 예");
same([M.retryAfterText(42000), M.retryAfterText(61000), M.retryAfterText(0)], ["방금 다시 써 봤어요. 42초 뒤에 다시 눌러 주세요.", "방금 다시 써 봤어요. 2분 뒤에 다시 눌러 주세요.", "방금 다시 써 봤어요. 1초 뒤에 다시 눌러 주세요."], "T1 다시 누를 때까지 남은 시간");

console.log(`\n#4632 앱빌더 기록 규칙: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);

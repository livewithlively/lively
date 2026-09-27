// #4135 — 수집기 행 · 증류기 카드의 «최근 실행» 계산(web/lib/machine-runs.ts). 사양 엣지 표 E1~E11.
//
//  회의(9/22 ①②): 행에서 바로 «새로 n · 수정 n» 을 본다. 그 숫자가 틀리면(실패한 실행의 숫자를 더하거나, 0시 정각을
//   어제로 세거나, 수집기 5번과 증류기 5번을 한 기계로 묶으면) 화면은 멀쩡해 보이는데 말이 거짓이 된다.
//  값으로만 잰다 — 시각은 이 시험이 도는 곳의 시계로 만든다(보는 사람의 시계 기준이라는 사양 그대로).
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`ok  ${name}`); } else { fail++; console.error(`FAIL  ${name}`); } };
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), `${name}${JSON.stringify(got) === JSON.stringify(want) ? "" : ` — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);

let lib = null;
try { lib = await import(pathToFileURL(join(root, "public/app/lib/machine-runs.js")).href); } catch (e) { console.error(String(e)); }
ok(!!lib, "W0 잎 모듈(lib/machine-runs)이 빌드돼 있다");
if (lib) {
  const { groupRuns, runsOf, summarize, isChanged, whenLabel, failCause } = lib;
  const at = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms).getTime();
  const NOW = at(2026, 9, 27, 16, 0);
  const run = (o) => ({ kind: "c", machineId: "5", ok: true, err: null, n: 0, mo: 0, read: null, ...o });
  const SUM0 = { runs: 0, failed: 0, n: 0, mo: 0, read: 0, changed: 0 };

  // E1 줄 0개
  eq([...groupRuns([]).keys()], [], "E1 줄이 없으면 기계도 없다");
  eq(summarize([], NOW), { today: SUM0, yesterday: SUM0, last: null }, "E1 합계는 전부 0 · 마지막 실행 없음");
  eq([...groupRuns(null).keys()], [], "E1 줄 목록 자체가 없어도 같다");

  // E2 번호가 같아도 수집기와 증류기는 다른 기계
  const g2 = groupRuns([run({ kind: "c", machineId: "5", t: NOW }), run({ kind: "d", machineId: "5", t: NOW })]);
  eq(g2.size, 2, "E2 수집기 5번과 증류기 5번은 기계 둘");
  eq([runsOf(g2, "c", 5).length, runsOf(g2, "d", "5").length], [1, 1], "E2 각자 한 줄씩(번호를 숫자로 물어도 같다)");

  // E3 뒤섞인 시각
  const mixed = [run({ t: at(2026, 9, 27, 9) }), run({ t: at(2026, 9, 27, 15, 30) }), run({ t: at(2026, 9, 27, 12) })];
  eq(runsOf(groupRuns(mixed), "c", "5").map((r) => new Date(r.t).getHours()), [15, 12, 9], "E3 최근 것이 위");
  eq(new Date(summarize(mixed, NOW).last.t).getHours(), 15, "E3 마지막 실행은 가장 최근 것");

  // E4 경계 — 오늘 0시 정각 / 1ms 전
  const s4 = summarize([run({ t: at(2026, 9, 27, 0, 0, 0, 0) }), run({ t: at(2026, 9, 27, 0, 0, 0, 0) - 1 })], NOW);
  eq([s4.today.runs, s4.yesterday.runs], [1, 1], "E4 0시 정각은 오늘 · 1ms 전은 어제");

  // E5 실패한 실행의 숫자는 더하지 않는다
  const s5 = summarize([run({ t: at(2026, 9, 27, 10), ok: false, err: "x", n: 3, mo: 2 }), run({ t: at(2026, 9, 27, 11), n: 1 })], NOW).today;
  eq([s5.runs, s5.failed, s5.n, s5.mo], [2, 1, 1, 0], "E5 실행 2 · 실패 1 · 새 1 · 바뀜 0");

  // E6 변화 없는 성공
  const s6 = summarize([run({ t: at(2026, 9, 27, 10) })], NOW).today;
  eq([s6.runs, s6.changed], [1, 0], "E6 실행 수에는 들고 변화 있는 실행에는 안 든다");
  eq([isChanged(run({ t: 1 })), isChanged(run({ t: 1, mo: 1 })), isChanged(run({ t: 1, ok: false }))], [false, true, true], "E6 변화 판정: 없음 · 바뀜 1 · 실패");

  // E7 읽은 것 값이 없는 수집 줄
  const s7 = summarize([run({ t: at(2026, 9, 27, 10), n: 2, read: null }), run({ kind: "c", t: at(2026, 9, 27, 11), read: undefined })], NOW).today;
  ok(s7.read === 0 && Number.isFinite(s7.n), "E7 읽은 것 합은 0(숫자가 아닌 것이 섞이지 않는다)");

  // E8 마지막 실행 시각 표기
  eq([whenLabel(at(2026, 9, 27, 15, 30), NOW), whenLabel(at(2026, 9, 26, 15, 30), NOW), whenLabel(at(2026, 9, 17, 11, 42), NOW)],
    ["15:30", "어제 15:30", "9/17 11:42"], "E8 오늘 · 어제 · 열흘 전");
  eq(whenLabel(at(2026, 9, 27, 9, 5), NOW), "09:05", "E8 한 자리 시 · 분은 0 을 채운다");

  // E9 실패 사유 — 경계 40 / 41
  const c40 = "가".repeat(40), c41 = "가".repeat(41);
  eq([failCause(null), failCause(""), failCause("   ")], ["원인 기록 없음", "원인 기록 없음", "원인 기록 없음"], "E9 사유 없음");
  eq(failCause(c40), c40, "E9 40자는 그대로");
  eq(failCause(c41), c40 + "…", "E9 41자는 40자 + «…»");
  eq(failCause("Figma 토큰이 없습니다 — 관리탭에서 저장하세요"), "Figma 토큰이 없습니다", "E9 « — » 앞 토막만");

  // E10 새 헬퍼 — 기록이 없는 기계 · 묶음 자체가 없음
  eq([runsOf(g2, "c", "999"), runsOf(null, "c", "5"), runsOf(undefined, "d", "5")], [[], [], []], "E10 없는 기계 · 없는 묶음은 빈 목록");

  // E11 그제 실행만
  const s11 = summarize([run({ t: at(2026, 9, 25, 23, 59), n: 4 })], NOW);
  eq([s11.today.runs, s11.yesterday.runs, !!s11.last], [0, 0, true], "E11 오늘 0 · 어제 0 · 마지막 실행은 그 줄");
}

// ───────── W. 배선 — 화면이 실제로 이 계산을 지나는가(소스) ─────────
import { readFileSync } from "node:fs";
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };
const code = (src) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const COL = code(read("web/context-collectors.ts")), DIS = code(read("web/distillers.ts")), MR = code(read("web/context-machine-runs.ts"));
ok(COL.length > 5000 && DIS.length > 5000 && MR.length > 1500, "W1 소스를 실제로 읽었다");
ok(/machineRuns\(runsBy, 'c', c\.id\)/.test(COL), "W2 수집기 행이 자기 기계의 줄을 받는다");
ok(/machineRuns\(runs, 'd', 'src:' \+ d\.id\)/.test(DIS) && /machineRuns\(runs, 'd', 'cat:' \+ c\.id\)/.test(DIS), "W3 증류기 카드는 자료 · 카테고리 기계를 가른다");
ok(/\.\.\.\(c\.enabled \? \[sync\] : \[\]\)/.test(COL), "W4 [지금 수집] 은 켜진 수집기에만 선다");
ok(!/수집 기록/.test(COL.replace(/title: '[^']*'/g, "")) || !/openRuns\(/.test(COL), "W5 [설정] 안의 [수집 기록] 이 없다");
ok(/groupRuns<AutoRun>/.test(MR) && /summarize\(runs, Date\.now\(\)\)/.test(MR), "W6 화면 조각이 잎 모듈의 계산을 쓴다");

console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);

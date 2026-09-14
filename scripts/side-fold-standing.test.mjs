// #3778 7판 — 카드 접힘의 잣대와 **홈 목록이 날짜 축이라는 사실**.
//
//  두 가지를 못박는다.
//
//  ① 접힘에서 세션을 빼는 사유는 «이미 목록에 줄로 섰다» **하나**다(6판).
//     그래서 × 로 치운 «도는» 세션도 접힘이 받는다 — × 툴팁이 「세션은 그대로 돌고」 라고 말하니
//     그게 × 의 정상 경로다. 5판까지는 「도는 세션이니까 뺀다」는 별도 규칙이 있어 그 세션이 사라졌다.
//
//  ② ★ **홈 목록의 축은 날짜다. 프로젝트가 아니다**(7판, 원준 2026-09-12 지시로 되돌렸다).
//     카드는 «그 프로젝트에 줄이 섰을 때만» 선다. 5판이 «내 세션이 있는 모든 프로젝트» 로 넓혔다가
//     그 계정에서 카드 20장이 옛 날짜 머리글 아래 붙고 「1월 22일」 머리글이 **두 번** 나왔다
//     (원준: "홈 화면의 날짜 기준 이것도 프로젝트 기준으로 다 갖다가 바꾼 거야? 내가 언제 그러랬어?").
//     이 파일의 B 절이 그 되돌림을 지킨다 — 지우기는 조용히 되살아나기 쉬워서다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "fold-standing-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/sess-fold.ts"), path.join(root, "web/v2/hold-rules.ts"),
   "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const { projectPastRows } = await import(path.join(out, "lib/sess-fold.js"));
const { dayGroup } = await import(path.join(out, "v2/hold-rules.js"));

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "기대와 다르다") => (cond ? ok(n) : bad(n, why));

const DAY = 86_400_000, NOW = Date.UTC(2026, 8, 12, 3, 0, 0);
const run  = (id, pid, ago) => ({ id, projectId: pid, live: true,  alive: true,  lastSeen: NOW - ago });
const done = (id, pid, ago) => ({ id, projectId: pid, live: false, alive: false, lastSeen: NOW - ago });
const NONE = new Set();
const ids = (r) => r.rows.map((x) => x.id).join(",");

// ───────────────────────── A. 접힘 제외 사유는 하나다 (6판)

check(ids(projectPastRows([done("끝남", 1, DAY), run("줄로섬", 1, 0)], 1, new Set(["줄로섬"]), 12)) === "끝남",
  "A1 줄로 선 도는 세션은 접힘에 안 들어온다 — 빼는 사유는 «이미 섰다» 다");

check(ids(projectPastRows([run("치운도는세션", 1, 0)], 1, NONE, 12)) === "치운도는세션",
  "A2 ★★ 줄로 **안** 선 도는 세션은 접힘이 받는다 — × 로 치운 도는 세션이 갈 곳이 여기다");

{ // ★ 같은 몸짓의 결과가 «옆에 다른 줄이 있느냐» 에 갈리면 안 된다(5판이 그랬다)
  const other = run("선줄", 7, 0), gone = run("치움", 7, 0);
  const alone = projectPastRows([gone], 7, NONE, 12);
  const withN = projectPastRows([other, gone], 7, new Set(["선줄"]), 12);
  check(alone.total === 1 && withN.total === 1 && withN.rows[0].id === "치움",
    "A3 ★★ 치운 도는 세션은 **옆에 다른 줄이 있든 없든** 접힘이 받는다",
    `혼자 ${alone.total} · 옆에 줄 있을 때 ${withN.total}`);
}

check(projectPastRows([{ ...run("버린것", 1, 0), trashedAt: "2026-09-01T00:00:00Z" }], 1, NONE, 12).total === 0,
  "A4 휴지통은 **도는 중이어도** 뺀다 — 되돌리기 전에 열리면 안 된다(#1851)");

check(ids(projectPastRows([{ ...done("박스새id", 1, DAY), logId: "대화uuid" }], 1, new Set(["대화uuid"]), 12)) === "",
  "A5 ★ 대화 uuid 로 서 있어도 같은 세션으로 본다 — 한 세션이 여러 이름으로 불린다");

check(ids(projectPastRows([{ ...done("소속없음", 0, DAY) }, done("남의것", 1, DAY)], 0, NONE, 12)) === "소속없음",
  "A6 ★ 프로젝트 id 0 은 「프로젝트 없음」 묶음이다 — 빈 값이 아니다");

for (const [v, n] of [[null, "null"], [undefined, "undefined"], [[], "빈 배열"]]) {
  check(projectPastRows(v, 1, NONE, 12).total === 0, `A7 세션 목록이 ${n} 이어도 빈 결과를 돌려준다`);
}

// ───────────────────────── B. ★ 홈 목록의 축은 **날짜**다 (7판 되돌림을 지킨다)

{
  const SIDE = readFileSync(path.join(root, "web/v2/side.ts"), "utf8");
  const kids = SIDE.slice(SIDE.indexOf("function projListKids("), SIDE.indexOf("function projGrpCard("));

  //  ★ 카드는 «줄이 선 프로젝트» 에서만 온다. 목록에 없는 프로젝트를 카드로 끼워 넣지 않는다.
  check(/const groups = projGroups\(rest, !!q\);/.test(kids),
    "B1 ★★ 홈 카드는 **줄이 선 프로젝트만** 세운다 — 카드 집합을 다른 데서 보태지 않는다",
    "projListKids 가 projGroups 밖에서 카드를 보태고 있다");

  check(!/restCards|restProjectCards/.test(SIDE),
    "B2 ★★ 「내 세션이 있는 모든 프로젝트에 카드」 규칙이 side.ts 에 없다 — 그게 날짜 축을 프로젝트 축으로 바꿨다",
    "restCards 계열이 되살아났다");

  const FOLD = readFileSync(path.join(root, "web/lib/sess-fold.ts"), "utf8");
  check(!/restProjectCards/.test(FOLD),
    "B3 ★ 그 규칙의 잣대(restProjectCards)도 잎 모듈에 없다 — 남겨 두면 조용히 다시 배선된다",
    "restProjectCards 가 남아 있다");

  //  ★ 날짜 머리글은 **한 줄기**여야 한다. 카드 목록이 둘로 나뉘어 이어 붙으면 같은 날짜가 두 번 나온다
  //   (5판 실측: 서 있는 카드가 「오늘 → 1월 22일」 을 낸 뒤 붙은 카드 20장이 「1월 22일」 을 다시 냈다).
  const heads = (kids.match(/class: 'v2-app-group'/g) || []).length;
  check(heads === 2,
    "B4 ★ 날짜 머리글을 내는 자리는 둘뿐이다(「고정」 층 하나 · 날짜 층 하나) — 목록이 한 줄기라는 뜻",
    `${heads}곳 — 세 곳이면 카드 목록이 쪼개졌다는 신호다`);
}

// ───────────────────────── C. 배선 — «이미 섰나» 를 목록 전체로 묻는가 (6판)

{
  const SIDE = readFileSync(path.join(root, "web/v2/side.ts"), "utf8");
  const kids = SIDE.slice(SIDE.indexOf("function projListKids("), SIDE.indexOf("function projGrpCard("));

  check(/for \(const r of shown\) if \(r\.id\.startsWith\('sess:'\)\) standingSess\.add/.test(kids),
    "C1 ★★ «이미 섰나» 집합은 **목록 전체**(shown)에서 모은다 — rest 면 압정 행이 빠져 접힘에 두 번 선다",
    "projListKids 가 shown 을 훑지 않는다");

  const passes = (kids.match(/projGrpCard\(g, o, !!q, standingSess\)/g) || []).length;
  check(passes === 2,
    "C2 ★ 카드를 그리는 **두 자리**(「고정」 층 · 날짜 층) 모두에 그 집합을 넘긴다",
    `넘기는 자리 ${passes}곳 — 한 곳이라도 빠지면 그 층만 조용히 옛 동작으로 돌아간다`);

  const FOLD = readFileSync(path.join(root, "web/lib/sess-fold.ts"), "utf8");
  const fn = FOLD.slice(FOLD.indexOf("export function projectPastRows"));
  check(!/keepLive/.test(fn) && !/s\.live && s\.alive/.test(fn),
    "C3 ★ 「도는 세션이니까 뺀다」 규칙과 그 예외(keepLive)가 **둘 다** 없다 — 사유는 «이미 섰다» 하나다",
    "projectPastRows 에 live 제외 규칙이나 keepLive 가 남아 있다");
}

// ───────────────────────── D. 날짜 묶음 이름 (main.ts → hold-rules.ts 로 옮긴 그 함수)

const dg = (at) => dayGroup(at, NOW);
check(dg(0) === "언젠가", "D1 시각이 없으면 「언젠가」");
check(dg(NOW) === "오늘", "D2 오늘");
check(dg(NOW - DAY) === "어제", "D3 어제");

{ // ★ 경계 — 하루는 시각차가 아니라 **달력**으로 센다. 그 지역 시간으로 지어야 걸린다(UTC 로 지으면 KST 에서 같은 날)
  const nowEarly = new Date(2026, 8, 12, 0, 1, 0).getTime();
  const lateYtd  = new Date(2026, 8, 11, 23, 59, 0).getTime();
  check(dayGroup(lateYtd, nowEarly) === "어제",
    "D4 ★ 어제 23:59 와 오늘 00:01 은 2분 차이지만 「어제」다", `실제 ${dayGroup(lateYtd, nowEarly)}`);
}

check(/^9월 10일$/.test(dg(Date.UTC(2026, 8, 10, 12))), "D5 이틀 전·같은 해는 「M월 D일」");
check(/^2025년 /.test(dg(Date.UTC(2025, 8, 10, 12))), "D6 해가 다르면 연도까지 쓴다");
check(dg(NOW + DAY) === "오늘", "D7 ★ 시계가 밀려 미래 시각이 와도 「오늘」이다 — 「내일」 묶음은 없다");

console.log(`\nside-fold-standing: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);

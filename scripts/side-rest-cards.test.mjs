// #3778 5판 — **홈 사이드바에 어디에도 없는 세션이 없는가.**
//
//  신고(원준 2026-09-12): "사이드바에서 아예 어떻게도 볼 수 없는 숨겨져 있는 세션이 존재하는 것 자체가
//  말이 안 되는 것 같아. 그럼 그거 쓰려면 프로젝트까지 들어가서 지금 안 열린 세션 찾아서 다시 열어야 하잖아."
//
//  실측: 내 세션 190개 중 **33개**가 홈 목록 어디에도 없었다 — 카드가 안 서는 프로젝트 24개 안에.
//  4판(projectPastRows)은 접힘 «안쪽»을 전량으로 넓혔지만 그건 카드가 이미 설 때의 이야기다.
//  이 파일이 못박는 것은 **카드가 서는 조건** 자체다: 내 세션이 있으면 그 프로젝트는 카드를 갖는다.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "rest-cards-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/sess-fold.ts"), path.join(root, "web/v2/hold-rules.ts"),
   "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const { restProjectCards, projectPastRows } = await import(path.join(out, "lib/sess-fold.js"));
const { dayGroup } = await import(path.join(out, "v2/hold-rules.js"));

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "기대와 다르다") => (cond ? ok(n) : bad(n, why));
/** 카드를 「id:개수」 로 납작하게 — 순서까지 한 줄로 비교한다. */
const flat = (cs) => cs.map((c) => `${c.id}:${c.n}`).join(",");
const lay = (got, want, n) =>
  check(flat(got) === want, n, `기대 [${want}] · 실제 [${flat(got)}]`);

const DAY = 86_400_000, NOW = Date.UTC(2026, 8, 12, 3, 0, 0);
/** 내 세션 하나. */
const mine = (pid, ago, extra = {}) => ({ projectId: pid, owned: true, lastSeen: NOW - ago, ...extra });
const NONE = new Set();

// ───────────────────────── A. ★ 안 보이는 세션이 0 이 된다 (신고의 본체)

lay(restProjectCards([mine(7, DAY), mine(7, 2 * DAY), mine(7, 30 * DAY)], NONE), "7:3",
  "A1 ★ 줄이 하나도 안 선 프로젝트도 카드를 갖는다 — 한 달 전 세션까지 그 카드가 진다");

{
  const c = restProjectCards([mine(7, 3 * DAY), mine(7, DAY)], NONE)[0];
  check(c.at === NOW - DAY, "A2 ★ 카드의 시각은 그 프로젝트에서 **가장 최근**에 쓴 세션의 것 — 날짜 묶음이 그걸로 정해진다",
    `기대 ${NOW - DAY} · 실제 ${c.at}`);
}

{ // 같은 입력을 «지금» 을 옮겨 가며 — 카드가 사라지면 신고가 되돌아온다
  const rows = [mine(7, 2 * DAY), mine(8, 40 * DAY)];
  const t1 = restProjectCards(rows, NONE);
  const t2 = restProjectCards(rows.map((r) => ({ ...r, lastSeen: r.lastSeen - 365 * DAY })), NONE);
  check(t1.length === 2 && t2.length === 2,
    "A3 ★ 1년을 더 흘려보내도 카드 수가 그대로다 — 이 판정에 «지금» 이 없다", `앞 ${t1.length} · 뒤 ${t2.length}`);
}

// ───────────────────────── B. 이미 선 카드는 두 번 세우지 않는다

lay(restProjectCards([mine(7, DAY), mine(9, DAY)], new Set([7])), "9:1",
  "B1 이미 줄이 서 있는 프로젝트는 카드를 새로 안 만든다(한 프로젝트에 카드 하나)");

lay(restProjectCards([mine(7, DAY)], new Set([7])), "",
  "B2 그 프로젝트가 전부 이미 서 있으면 새 카드는 0장");

// ───────────────────────── C. 무엇이 빠지나

lay(restProjectCards([mine(7, DAY, { trashedAt: "2026-09-01T00:00:00Z" })], NONE), "",
  "C1 휴지통 세션으로는 카드를 안 세운다 — 되돌리기 전에 열리면 안 된다(#1851)");

lay(restProjectCards([mine(7, DAY, { trashedAt: "2026-09-01T00:00:00Z" }), mine(7, 2 * DAY), mine(7, 3 * DAY)], NONE),
  "7:2", "C2 ★ 휴지통 것만 빼고 나머지로 카드를 센다");

lay(restProjectCards([mine(7, DAY, { trashed: true })], NONE), "7:1",
  "C3 ★★ 휴지통 판정은 **`trashedAt`** 으로 한다 — `trashed` 는 Sess 에 없는 칸이라 실제 자료에서 한 번도 안 걸린다 " +
  "(4판이 그 이름을 써서 휴지통 세션이 카드 접힘에 그대로 섰다)");

//  ★ 프로젝트에 안 붙은 세션도 카드를 갖는다 — 안 그러면 그것도 «어디에도 없는 세션» 이다(실측 47개).
//   셋 다 같은 한 장(id 0 =「프로젝트 없음」 묶음)으로 모인다.
for (const [pid, n] of [[0, "0"], [null, "null"], [undefined, "undefined"]]) {
  lay(restProjectCards([mine(pid, DAY)], NONE), "0:1",
    `C4 ★ 프로젝트 id 가 ${n} 이어도 「프로젝트 없음」 카드로 선다`);
}

lay(restProjectCards([mine(0, DAY), mine(null, 2 * DAY), mine(7, 3 * DAY)], NONE), "0:2,7:1",
  "C4′ ★ 프로젝트 없는 세션들은 **한 장**으로 모이고, 프로젝트 있는 것과 따로 선다");

lay(restProjectCards([mine(0, DAY)], new Set([0])), "",
  "C4″ ★ 「프로젝트 없음」 묶음이 이미 서 있으면 카드를 새로 안 만든다 — id 0 도 hasCard 를 탄다");

lay(restProjectCards([{ projectId: 7, owned: false, lastSeen: NOW - DAY }], NONE), "",
  "C5 ★ 남의 세션만 있는 프로젝트는 카드를 **안** 세운다 — 안 그러면 동료만 일하는 프로젝트가 내 홈에 쌓인다");

lay(restProjectCards([{ projectId: 7, owned: false, lastSeen: NOW }, mine(7, DAY)], NONE), "7:1",
  "C6 ★ 내 세션 1 + 남의 세션 1 이면 카드는 서되 **내 것만** 센다");

// ───────────────────────── D. 도는 세션 — 「안 보이는 세션 0」이 이 함수의 약속이다

lay(restProjectCards([{ projectId: 7, owned: true, live: true, alive: true, lastSeen: NOW }], NONE), "7:1",
  "D1 ★ 도는 세션만 있어도 카드를 세운다 — 약속은 «내 세션이 있으면 카드가 있다» 이지 «끝난 세션이 있으면» 이 아니다");

{ // 그 카드의 접힘이 **비지 않는가** — 치운 도는 세션이 딱 그 경우다(치움이 live 보다 먼저 판정된다)
  const live = { id: "s1", projectId: 7, live: true, alive: true, lastSeen: NOW };
  const off = projectPastRows([live], 7, NONE, 12);
  const on  = projectPastRows([live], 7, NONE, 12, { keepLive: true });
  check(off.total === 0 && on.total === 1,
    "D2 ★★ 앞면이 없는 카드는 도는 세션도 접힘이 받는다(keepLive) — 안 그러면 그 카드가 펴도 **텅 빈다**",
    `keepLive 없이 ${off.total} · 켜면 ${on.total}`);
}

// ───────────────────────── E. 순서

lay(restProjectCards([mine(7, 9 * DAY), mine(8, DAY), mine(9, 4 * DAY)], NONE), "8:1,9:1,7:1",
  "E1 최근에 쓴 프로젝트부터 선다");

// ───────────────────────── F. 빈 값·망가진 입력에도 안 죽는다

for (const [v, n] of [[null, "null"], [undefined, "undefined"], [[], "빈 배열"]]) {
  check(restProjectCards(v, NONE).length === 0, `F1 세션 목록이 ${n} 이어도 빈 결과를 돌려준다`);
}

lay(restProjectCards([null, undefined, mine(7, DAY)], NONE), "7:1",
  "F2 목록 안에 빈 항목이 섞여도 나머지를 그대로 담는다");

lay(restProjectCards([{ projectId: 7, owned: true }], NONE), "7:1",
  "F3 ★ lastSeen 이 아예 없어도 카드는 선다 — 시각을 모르는 것이 «없는 것» 이 되면 안 된다");

// ───────────────────────── G. 날짜 묶음 이름 (main.ts → hold-rules.ts 로 옮겼다)

const dg = (at) => dayGroup(at, NOW);
check(dg(0) === "언젠가", "G1 시각이 없으면 「언젠가」");
check(dg(NOW) === "오늘", "G2 오늘");
check(dg(NOW - DAY) === "어제", "G3 어제");

{ // ★ 경계 — 하루는 시각차가 아니라 **달력**으로 센다.
  //  ⚠ 여기만 **그 지역 시간**으로 짓는다(new Date(y,m,d,…)) — dayGroup 이 재는 «하루» 는 UTC 가 아니라
  //   보는 사람의 달력이기 때문이다. Date.UTC 로 지으면 KST(+9) 에서는 둘 다 같은 날이 되어 경계가 안 걸린다.
  const nowEarly = new Date(2026, 8, 12, 0, 1, 0).getTime();
  const lateYtd  = new Date(2026, 8, 11, 23, 59, 0).getTime();
  check(dayGroup(lateYtd, nowEarly) === "어제",
    "G4 ★ 어제 23:59 와 오늘 00:01 은 2분 차이지만 「어제」다 — 달력으로 센다",
    `실제 ${dayGroup(lateYtd, nowEarly)}`);
}

check(/^9월 10일$/.test(dg(Date.UTC(2026, 8, 10, 12))), "G5 이틀 전·같은 해는 「M월 D일」", `실제 ${dg(Date.UTC(2026, 8, 10, 12))}`);
check(/^2025년 /.test(dg(Date.UTC(2025, 8, 10, 12))), "G6 해가 다르면 연도까지 쓴다", `실제 ${dg(Date.UTC(2025, 8, 10, 12))}`);
check(dg(NOW + DAY) === "오늘",
  "G7 ★ 시계가 밀려 미래 시각이 와도 「오늘」이다 — 「내일」이라는 묶음은 목록에 없다", `실제 ${dg(NOW + DAY)}`);

check(dg(NOW - 30 * DAY) !== "" && dg(NOW - 400 * DAY) !== "",
  "G8 ★ 이 어휘엔 **바닥이 없다** — 한 달 전도 1년 전도 이름이 나온다(홈이 어제에서 끊겼던 건 이쪽 한계가 아니었다)");

console.log(`\nside-rest-cards: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);

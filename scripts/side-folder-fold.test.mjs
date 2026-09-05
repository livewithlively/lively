// #762 — 사이드바 프로젝트 폴더에 무엇이 그대로 서고 무엇이 「지난 세션 n」 뒤로 접히나.
//
//  신고(2026-09-05): "SNUCOM Build 프로젝트에서 «투어영상 제작» 세션이 폴더를 펼쳐도 안 보였다.
//  그래서 프로젝트 안에 들어가서 굳이굳이 찾아서 열었다." — 그 세션은 전날 08:23 을 마지막으로
//  약 17시간 멈춰 있었고, 화면은 «멈춘 세션»을 전부 한 줄 뒤로 접고 있었다.
//  어제 하던 일은 아직 오늘의 일감이다 → 하루(24시간)를 넘긴 것만 접는다.
//
//  이 파일은 **사양만 보고** 썼다(스크래치패드 spec.md). 구현(web/lib/sess-fold.ts)은 읽지 않았다.
//  시각은 전부 고정값이다 — Date.now() 에 기대지 않고 판정 함수에 now 를 넘긴다.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "sess-fold-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/sess-fold.ts"), "--outDir", out,
   "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const { WARM_MS, isWarmSess, splitFolderRows } = await import(path.join(out, "sess-fold.js"));

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "기대와 다르다") => (cond ? ok(n) : bad(n, why));

/** 줄 이름표만 뽑는다 — 개수가 아니라 **어느 줄이 어디에 들어갔는지**로 본다. */
const ids = (rows) => rows.map((r) => r.id).join(",");
/** 두 자리(now=폴더에 그대로 · cold=접힘)에 들어간 줄을 이름표로 못박는다. */
const split = (res, wantNow, wantCold, n) => {
  const gn = ids(res.now), gc = ids(res.cold);
  const wn = wantNow.join(","), wc = wantCold.join(",");
  check(gn === wn && gc === wc, n,
    `폴더에 그대로: 기대 [${wn}] · 실제 [${gn}] / 접힘: 기대 [${wc}] · 실제 [${gc}]`);
};

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** 이 파일의 '지금' — 2026-09-05 01:00Z 로 못박는다(어느 시간대에서 돌려도 같은 답). */
const NOW = Date.UTC(2026, 8, 5, 1, 0, 0);
/** 신고의 그 세션: 전날 08:23 이 마지막 작업 = NOW 로부터 16시간 37분 전(하루 안). */
const YESTERDAY_0823 = Date.UTC(2026, 8, 4, 8, 23, 0);

/** 도는 줄 = live && alive. lastSeen 을 안 주면 그 칸 자체가 없다(모르는 경우). */
const run  = (id, lastSeen) => ({ id, live: true,  alive: true,  ...(lastSeen === undefined ? {} : { lastSeen }) });
/** 멈춘 줄. */
const stop = (id, lastSeen) => ({ id, live: false, alive: false, ...(lastSeen === undefined ? {} : { lastSeen }) });

// ───────────────────────── A. 판정 하나짜리 물음 — "이 줄이 지금 일감인가?"

check(WARM_MS === 86_400_000, "A1 '하루' 는 24시간(86,400,000ms)이다",
  `WARM_MS = ${WARM_MS}`);

check(isWarmSess(run("x", NOW - 30 * DAY), NOW) === true,
  "A2 도는 세션은 마지막 작업이 30일 전이어도 지금 일감이다(도는 중이면 배경이 아니다)");

check(isWarmSess(run("x"), NOW) === true,
  "A3 도는 세션은 마지막 작업 시각을 몰라도 지금 일감이다");

check(isWarmSess(run("x", 0), NOW) === true,
  "A4 도는 세션은 마지막 작업 시각이 0이어도 지금 일감이다");

check(isWarmSess(stop("x", YESTERDAY_0823), NOW) === true,
  "A5 멈췄어도 어제 08:23(17시간 전)이면 아직 오늘의 일감이다 — 신고가 바로 이 경우다");

check(isWarmSess(stop("x", NOW - 2 * DAY), NOW) === false,
  "A6 하루보다 오래 조용한 멈춘 세션(이틀)은 지금 일감이 아니다");

check(isWarmSess(stop("x"), NOW) === false,
  "A7 마지막 작업 시각이 없는 멈춘 세션은 지금 일감이 아니다 — 모르는 것을 오늘 일감이라 우기지 않는다");

check(isWarmSess(stop("x", 0), NOW) === false,
  "A8 마지막 작업 시각이 0인 멈춘 세션도 지금 일감이 아니다");

check(isWarmSess(stop("x", NOW - (WARM_MS - 1)), NOW) === true,
  "A9 경계 바로 앞 — 하루가 1ms 모자란 멈춘 세션은 지금 일감이다");

check(isWarmSess(stop("x", NOW - (WARM_MS + 1)), NOW) === false,
  "A10 경계 바로 뒤 — 하루를 1ms 넘긴 멈춘 세션은 지금 일감이 아니다");

check(isWarmSess(stop("x", NOW - (DAY - MIN)), NOW) === true,
  "A11 23시간 59분 조용한 멈춘 세션은 지금 일감이다");

check(isWarmSess(stop("x", NOW - (DAY + MIN)), NOW) === false,
  "A12 24시간 1분 조용한 멈춘 세션은 지금 일감이 아니다");

check(isWarmSess({ id: "x", live: true, alive: false, lastSeen: NOW - 2 * DAY }, NOW) === false,
  "A13 live 만 참이고 alive 가 거짓이면 도는 중이 아니다 — 이틀 조용하면 접힌다");

check(isWarmSess({ id: "x", live: false, alive: true, lastSeen: NOW - 2 * DAY }, NOW) === false,
  "A14 alive 만 참이고 live 가 거짓이면 도는 중이 아니다 — 이틀 조용하면 접힌다");

check(isWarmSess({ id: "x", live: true, alive: false, lastSeen: NOW - HOUR }, NOW) === true &&
      isWarmSess({ id: "x", live: false, alive: true, lastSeen: NOW - HOUR }, NOW) === true,
  "A15 반쪽만 참인 줄도 한 시간 전에 일했으면 지금 일감이다(멈춘 줄의 규칙을 그대로 받는다)");

{ // 같은 줄인데 답이 뒤집힌다 = 판정이 넘긴 now 를 실제로 쓴다(Date.now() 가 아니다)
  const row = stop("x", YESTERDAY_0823);
  const before = isWarmSess(row, YESTERDAY_0823 + HOUR);
  const after  = isWarmSess(row, YESTERDAY_0823 + 25 * HOUR);
  check(before === true && after === false,
    "A16 판정은 넘겨받은 now 를 쓴다 — 같은 줄이 한 시간 뒤엔 일감이고 25시간 뒤엔 아니다",
    `한 시간 뒤=${before} · 25시간 뒤=${after}`);
}

// ───────────────────────── B. 폴더 아래 줄 가르기 — splitFolderRows(live, past, now)

split(splitFolderRows([run("도는-30일조용", NOW - 30 * DAY)], [], NOW),
  ["도는-30일조용"], [],
  "B1 도는 세션은 30일 조용했어도 폴더에 그대로 선다");

split(splitFolderRows([], [stop("투어영상", YESTERDAY_0823)], NOW),
  ["투어영상"], [],
  "B2 어제 08:23 에 멈춘 «투어영상 제작» 은 폴더를 펼치면 그대로 보인다(신고가 다시 나면 안 된다)");

split(splitFolderRows([], [stop("이틀전", NOW - 2 * DAY)], NOW),
  [], ["이틀전"],
  "B3 하루보다 오래 조용한 멈춘 세션만 「지난 세션」 뒤로 접힌다");

split(splitFolderRows([], [stop("시각없음"), stop("시각0", 0)], NOW),
  [], ["시각없음", "시각0"],
  "B4 마지막 작업 시각을 모르는(없는·0인) 멈춘 세션은 접힌다");

split(splitFolderRows([], [stop("하루-1ms", NOW - (WARM_MS - 1)), stop("하루+1ms", NOW - (WARM_MS + 1))], NOW),
  ["하루-1ms"], ["하루+1ms"],
  "B5 경계는 딱 하루다 — 1ms 모자란 줄은 서고 1ms 넘긴 줄은 접힌다(한 판에서 갈린다)");

{ // 한 줄이 두 자리에 동시에 들지 않는다 — 이름표가 아니라 **객체 동일성**으로 본다
  const L = [run("r1", NOW - 9 * DAY), run("r2")];
  const P = [stop("p-warm", NOW - 3 * HOUR), stop("p-cold", NOW - 8 * DAY),
             stop("p-none"), stop("p-edge", NOW - (WARM_MS - 1))];
  const r = splitFolderRows(L, P, NOW);
  const all = [...L, ...P], got = [...r.now, ...r.cold];
  const missing = all.filter((x) => !got.includes(x)).map((x) => x.id);
  const dupes = got.filter((x, i) => got.indexOf(x) !== i).map((x) => x.id);
  const extra = got.filter((x) => !all.includes(x)).length;
  check(got.length === all.length && !missing.length && !dupes.length && !extra,
    "B6 한 줄이 두 자리에 동시에 들지 않는다 — 합치면 원래 여섯 줄 그대로다",
    `줄 수 ${got.length}/${all.length} · 빠진 줄 [${missing}] · 두 번 든 줄 [${dupes}] · 없던 줄 ${extra}개`);
}

{ // 순서: 도는 것 먼저, 그다음 멈춘 것. 도는 줄이 더 오래 조용해도 앞이다.
  const L = [run("도는A", NOW - 20 * DAY), run("도는B", NOW - 10 * DAY)];
  const P = [stop("옛날1", NOW - 5 * DAY), stop("멈춤C", NOW - MIN),
             stop("옛날2", NOW - 9 * DAY), stop("멈춤D", NOW - 3 * HOUR)];
  const r = splitFolderRows(L, P, NOW);
  split(r, ["도는A", "도는B", "멈춤C", "멈춤D"], ["옛날1", "옛날2"],
    "B7 폴더에 선 줄의 순서는 도는 것 먼저·그다음 멈춘 것이고, 각 묶음은 들어온 순서 그대로다");
  check(ids(r.cold) === "옛날1,옛날2",
    "B8 접힌 줄도 들어온 순서 그대로다 — 이 규칙은 정렬하지 않는다(정렬은 부르는 쪽의 몫)",
    `실제 [${ids(r.cold)}]`);
}

{ // 빈 입력
  const r = splitFolderRows([], [], NOW);
  check(Array.isArray(r.now) && Array.isArray(r.cold) && r.now.length === 0 && r.cold.length === 0,
    "B9 도는 것도 멈춘 것도 없으면 양쪽 다 빈 목록이다",
    `now=${JSON.stringify(r.now)} · cold=${JSON.stringify(r.cold)}`);
}

{ // 신고 그대로의 폴더 한 판
  const r = splitFolderRows(
    [run("빌드도는중", NOW - 12 * DAY)],
    [stop("투어영상", YESTERDAY_0823), stop("지난주회의", NOW - 8 * DAY), stop("이름만남은세션")],
    NOW);
  split(r, ["빌드도는중", "투어영상"], ["지난주회의", "이름만남은세션"],
    "B10 SNUCOM Build 폴더 한 판 — 도는 세션과 어제 세션은 서고, 8일 전 세션과 시각 모르는 세션만 접힌다");
}

console.log(`side-folder-fold: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);

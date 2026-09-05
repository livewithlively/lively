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

// C 묶음은 **지역 시간**(자정·새벽 5시)을 판정한다 — 어느 기계에서 돌려도 같은 답이 나오게
// 시간대를 서울(UTC+9 · 서머타임 없음)로 못박는다. A·B 는 Date.UTC 절대값이라 영향이 없다.
process.env.TZ = "Asia/Seoul";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "sess-fold-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/sess-fold.ts"), "--outDir", out,
   "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const { WARM_MS, isWarmSess, splitFolderRows, DAY_START_HOUR, workDayStart } = await import(path.join(out, "sess-fold.js"));

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

// ───────────────────────── C. 홈 목록이 '오늘 일감'을 자르는 시각 — workDayStart(now)
//
//  실측(2026-09-05 01:20): '오늘'을 **달력 자정**으로 잘라 새벽에 일하는 사람의 홈 목록이 통째로 비었다
//  (멈춘 세션 0줄 — 찾던 세션은 전날 08:23 에 멈춘, 최신에서 2번째였다).
//  그래서 하루는 새벽 5시에 시작한다고 친다: 00:00~04:59 는 아직 '어젯밤'이다.
//
//  ⚠ 전제 — 이 묶음은 **지역 시간**을 판정하므로 시간대를 서울(UTC+9 · 서머타임 없음)로 못박고 시작한다
//    (파일 맨 위 `process.env.TZ`, C1 이 실제로 걸렸는지 검사한다). 아래 시각은 전부 그 지역 시간이며,
//    기대값은 ms 숫자가 아니라 **사람이 읽는 시각 문자열**로 못박는다(숫자만 보면 틀린 기대값을 못 알아본다).

/** 지역 시간으로 고정 시각 하나(월은 1부터). */
const at = (y, m, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, m - 1, d, h, mi, s, ms).getTime();
/** ms epoch → 사람이 읽는 지역 시각 문자열. */
const fmt = (ms) => {
  const d = new Date(ms), p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};
/** "지금이 이 시각이면 오늘 일감은 이 시각부터다" 를 문자열로 못박는다. */
const startsAt = (nowMs, wantStr, n) => {
  const got = workDayStart(nowMs);
  check(Number.isFinite(got) && fmt(got) === wantStr, n,
    `지금 ${fmt(nowMs)} → 기대 ${wantStr} · 실제 ${Number.isFinite(got) ? fmt(got) : String(got)}`);
};

check(new Date(2026, 8, 5).getTimezoneOffset() === -540,
  "C1 이 묶음의 전제 — 시간대가 서울(UTC+9)로 걸려 있다",
  `오프셋 ${new Date(2026, 8, 5).getTimezoneOffset()}분 (기대 -540) — TZ=${process.env.TZ}`);

check(DAY_START_HOUR === 5,
  "C2 하루는 그 지역 시간 새벽 5시에 시작한다고 친다(DAY_START_HOUR = 5)",
  `DAY_START_HOUR = ${DAY_START_HOUR}`);

startsAt(at(2026, 9, 5, 14, 30), "2026-09-05 00:00:00.000",
  "C3 지금이 낮 14:30 이면 오늘 자정부터다 — 종전과 같다(낮에 목록이 길어지지 않는다)");

startsAt(at(2026, 9, 5, 1, 20), "2026-09-04 05:00:00.000",
  "C4 지금이 새벽 01:20(실측한 그 시각)이면 어제 05:00 부터다 — 어젯밤에 하던 일이 그대로 남는다");

{ // 실측 재현 — 종전(달력 자정)이면 이 세션이 잘려 나가 목록이 0줄이었다
  const now = at(2026, 9, 5, 1, 20), cut = workDayStart(now);
  const sess = at(2026, 9, 4, 8, 23);      // 찾던 세션: 전날 08:23 에 멈췄다
  const oldCut = at(2026, 9, 5);           // 종전 기준 = 달력 자정
  check(sess >= cut && sess < oldCut,
    "C5 실측 재현 — 전날 08:23 에 멈춘 세션이 새벽 01:20 홈 목록에 선다(달력 자정으로 잘랐다면 빠졌다)",
    `자르는 시각 ${fmt(cut)} · 그 세션 ${fmt(sess)} · 종전 자정 기준 ${fmt(oldCut)}`);
}

startsAt(at(2026, 9, 5, 5, 0, 0, 0), "2026-09-05 00:00:00.000",
  "C6 경계 — 05:00 정각은 '05:00 이후' 쪽이다(오늘 자정)");

startsAt(at(2026, 9, 5, 4, 59, 59, 999), "2026-09-04 05:00:00.000",
  "C7 경계 — 04:59:59.999 는 아직 새벽 쪽이다(어제 05:00)");

startsAt(at(2026, 9, 5, 4, 59, 59, 0), "2026-09-04 05:00:00.000",
  "C8 경계 — 사양이 적은 04:59:59 도 새벽 쪽이다(어제 05:00)");

startsAt(at(2026, 9, 5, 5, 0, 0, 1), "2026-09-05 00:00:00.000",
  "C9 경계 — 05:00 을 1ms 넘기면 오늘 자정이다");

startsAt(at(2026, 9, 5, 0, 0, 0, 0), "2026-09-04 05:00:00.000",
  "C10 자정 정각은 아직 '어젯밤' 이다 — 어제 05:00 부터다");

startsAt(at(2026, 9, 5, 23, 59, 59, 999), "2026-09-05 00:00:00.000",
  "C11 밤 23:59:59.999 는 여전히 오늘 자정부터다");

{ // 규칙 4 — 하루를 훑어 불변식을 본다(늦지 않다 · 새벽은 더 이르다 · 05시 이후는 정확히 자정)
  const midnight = at(2026, 9, 5);
  const late = [];
  let earlyStrict = 0, dayEqual = 0;
  for (let i = 0; i < 96; i++) {
    const h = Math.floor(i / 4), mi = (i % 4) * 15;
    const now = at(2026, 9, 5, h, mi), got = workDayStart(now);
    if (got > midnight) late.push(`${fmt(now)}→${fmt(got)}`);
    if (h < 5) { if (got < midnight) earlyStrict++; }
    else if (got === midnight) dayEqual++;
  }
  check(!late.length && earlyStrict === 20 && dayEqual === 76,
    "C12 어느 시각에도 오늘 자정보다 늦지 않다 — 15분 간격 96지점(새벽 20지점은 더 이르고, 05시 이후 76지점은 정확히 자정)",
    `자정보다 늦은 지점 [${late.slice(0, 3).join(" · ")}] · 새벽 엄격히 이른 지점 ${earlyStrict}/20 · 05시 이후 자정과 같은 지점 ${dayEqual}/76`);
}

{ // 규칙 4 의 그 예 — 아침이 되어도 새벽에 쓴 것이 빠지지 않는다
  const sess = at(2026, 9, 5, 2, 0);
  const night = workDayStart(at(2026, 9, 5, 2, 30)), morning = workDayStart(at(2026, 9, 5, 6, 0));
  check(sess >= night && sess >= morning,
    "C13 새벽 2시에 쓴 세션이 아침 6시에 목록에서 사라지지 않는다",
    `그 세션 ${fmt(sess)} · 02:30 의 자름 ${fmt(night)} · 06:00 의 자름 ${fmt(morning)}`);
}

/** 같은 규칙을 **UTC 로** 계산한 오답 — 규칙 6 이 막으려는 바로 그 계산이다. */
const utcNaive = (now) => {
  const d = new Date(now);
  return d.getUTCHours() >= 5
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1, 5);
};

{ // 서울 06:00 = 전날 21:00 UTC — UTC 로 자르면 '어제 아침'이 나온다
  const now = at(2026, 9, 5, 6, 0), got = workDayStart(now), wrong = utcNaive(now);
  check(fmt(got) === "2026-09-05 00:00:00.000" && got !== wrong,
    "C14 지역 시간으로 판정한다 — 서울 06:00(= 전날 21:00 UTC)의 답은 오늘 자정이지 UTC 로 자른 값이 아니다",
    `실제 ${fmt(got)} · UTC 로 자른 오답 ${fmt(wrong)}`);
}

{ // 서울 02:00 = 전날 17:00 UTC — UTC 시로는 17시라 '05:00 이후'로 오판한다
  const now = at(2026, 9, 5, 2, 0), got = workDayStart(now), wrong = utcNaive(now);
  check(fmt(got) === "2026-09-04 05:00:00.000" && got !== wrong,
    "C15 새벽도 지역 시간으로 판정한다 — 서울 02:00 을 UTC 시(17시)로 보면 '낮'으로 오판한다",
    `실제 ${fmt(got)} · UTC 로 자른 오답 ${fmt(wrong)}`);
}

startsAt(at(2026, 9, 1, 3, 0), "2026-08-31 05:00:00.000",
  "C16 새벽에 달이 바뀌어도 어제 05:00 을 제대로 짚는다(09-01 03:00 → 08-31 05:00)");


console.log(`side-folder-fold: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
if (fail) process.exit(1);

// #3870 — 레일은 **한 칸만** 켠다: 앱 화면에선 기억한 구역이 켜지지 않는다. 최근 앱의 '실행 중' 점은 없다.
//
//  원준 2026-09-27 신고: "홈 눌렀다가 밑에 분류체계 저거 눌르면 홈도 배경 하얗게 선택된 느낌인데 분류체계도 …
//   동시에 두 개 된것처럼 보이는 이상한 오류가 있음. 그리고 지금 수집 증류 아래에 까만 점은 도대체 왜있는거야??"
//  ① 구역 칸은 `section === key` 만 보고 켜졌다 — 구역은 앱 화면으로 가도 기억이 남으므로 앱 칸과 함께 켜졌다.
//  ② 점은 맥 독의 '실행 중' 을 흉내 낸 것인데, 새 셸은 탭 줄을 안 그린다(main.ts TABS_OFF). 사람에게 보이지도
//     닫히지도 않는 숨은 탭이 남아 있다는 표시라 뜻이 없다 — 걷는다.
//  시나리오 번호(E1~E11)는 사양의 엣지 표 행이다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "rail-lit-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/rail-lit.ts"), "--rootDir", path.join(root, "web"),
   "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const { railLitKey, installedRailEligible } = await import(path.join(out, "lib/rail-lit.js"));

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "기대와 다르다") => (cond ? ok(n) : bad(n, why));
//  정적 배선 검사는 **주석을 걷고** 본다 — 설명 주석의 낱말이 거짓 빨강·거짓 초록을 만든다.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// ───────────────────────── A. 잣대 — 어느 칸이 켜지나
const LINKS = ["liv"];
const APPS = ["dashboard", "sources", "taxonomy", "context", "sessions", "learn"];   // 레일에 설 수 있는 앱(구역과 같은 문·숨긴 앱 제외)
const lit = (ak, sec = "home", apps = APPS) => railLitKey(ak, sec, LINKS, apps);

check(lit("taxonomy") === "taxonomy", "E1 ★★ 홈 구역에서 분류체계(native 앱)를 열면 분류체계만 켜진다", lit("taxonomy"));
check(lit("app:context") === "context", "E2 ★★ 액자 앱(수집 · 증류, 'app:context')도 앱만 켜진다", lit("app:context"));
check(lit("sources", "wiki") === "sources", "E3 위키 구역에서 연 자료도 자료만", lit("sources", "wiki"));
check(lit("liv", "proj") === "liv", "E4 리브는 그대로 리브만", lit("liv", "proj"));
check(lit("home") === "home", "E5 홈 화면이면 홈", lit("home"));
check(lit("s:abc") === "home", "E6 세션을 보고 있으면 기억한 구역(홈)", lit("s:abc"));
check(lit("p:12", "proj") === "proj", "E7 프로젝트 화면은 프로젝트 구역", lit("p:12", "proj"));
check(lit("app:projects2", "proj") === "proj", "E8 구역과 같은 문(프로젝트 보드)은 앱이 아니라 구역이 켜진다", lit("app:projects2", "proj"));
check(lit("app:system") === "home", "E9 숨긴 앱(설정)은 레일에 칸이 없으니 구역이 남는다", lit("app:system"));
check(lit("app:") === "home" && lit("") === "home", "E10 빈 키는 구역으로", `${lit("app:")} / ${lit("")}`);
check(lit("taxonomy", "home", []) === "home", "E11 앱 목록이 비면 구역으로", lit("taxonomy", "home", []));
//  #4632(원준 2026-10-17 «사이드바 내용까지가 하나의 앱이야») — 사이드바 주인(lib/side-owner)을 주면, 구역 목록이 아닌 화면에서 구역 칸을 켜지 않는다.
const litO = (ak, owner, sec = "home") => railLitKey(ak, sec, LINKS, APPS, owner);
check(litO("app:system", "none") === "" && litO("inbox", "none") === "" && litO("app:", "none") === "", "E12 ★ 레일에 칸이 없는 앱(설정 · 확인할 것 · 앱 인스턴스)에선 아무 칸도 안 켠다 — 「홈」 이 켜져 «홈에 있다» 로 읽히던 것", [litO("app:system", "none"), litO("inbox", "none")]);
check(litO("taxonomy", "taxonomy") === "taxonomy" && litO("liv", "none") === "liv" && litO("app:learn", "none") === "learn", "E13 레일에 칸이 있는 앱 · 갈 곳은 그대로 그 칸", [litO("taxonomy", "taxonomy"), litO("app:learn", "none")]);
check(litO("s:abc", "section") === "home" && litO("app:projects2", "section", "proj") === "proj" && litO("app:system", undefined) === "home", "E14 구역 목록 화면은 구역 · 주인을 안 주면 종전 그대로", [litO("s:abc", "section"), litO("app:system", undefined)]);

// ───────────────────────── B. 배선 — 레일·구역 드롭다운이 이 잣대 하나를 쓴다
const rail = code(readFileSync(path.join(root, "web/v2/rail.ts"), "utf8"));
const mainTs = code(readFileSync(path.join(root, "web/v2/main.ts"), "utf8"));
const appsTs = code(readFileSync(path.join(root, "web/v2/apps.ts"), "utf8"));
const css = code(readFileSync(path.join(root, "public/styles/47-v2-rail.css"), "utf8"));

const fnBody = (name) => { const i = rail.indexOf(`function ${name}(`); return i < 0 ? "" : rail.slice(i, rail.indexOf("\n}\n", i)); };
check(/from '\.\.\/lib\/rail-lit\.js'/.test(rail) && /railLitKey\(/.test(rail)
    && /\blitKey\(\)/.test(fnBody("drawRail")) && /\blitKey\(\)/.test(fnBody("openSectionMenu")),
  "W1 ★ rail.ts 의 레일과 구역 드롭다운 둘 다 lib/rail-lit 의 railLitKey 로 켜짐을 정한다");
check(!/section === s\.key/.test(rail),
  "W2 ★★ 구역 칸이 기억한 구역만 보고 켜지는 식(section === s.key)이 남아 있지 않다");
check(!/v2-rail-run/.test(rail) && !/v2-rail-run/.test(css),
  "W3 ★ 최근 앱의 '실행 중' 점이 그려지지도, 스타일도 남아 있지 않다");
check(!/openApps/.test(rail) && !/openAppKeys/.test(mainTs),
  "W4 점을 위해서만 있던 훅(openApps·openAppKeys)도 걷혔다");

// ───────────────────────── P. 설치 앱의 최근 칸 — 만드는 중인 앱은 서지 않는다 (#4878)
//  원준 2026-10-19: «회의록 앱 아직 만들기 끝나지 않았는데 최근에 연 앱이나 사이드바에 바로 뜨는게 이해가 안가네» · «앱 아이콘까지도 떠».
//  앱 찾기는 #4632 부터 만드는 중인 앱(lib/builder-flow isAppInProgress)을 앱으로 세우지 않는데, #4769 의 최근 줄 · 레일 최근 칸은 그 자를 안 봤다.
const inst = (id, over = {}) => ({ id, hasUi: true, systemRoute: null, ...over });
check(installedRailEligible([inst("meeting-notes", { inProgress: true })]).length === 0,
  "P1 ★ 만드는 중인 앱(inProgress)은 최근 칸에 설 수 없다 — 회의록 꼴", JSON.stringify(installedRailEligible([inst("meeting-notes", { inProgress: true })])));
check(installedRailEligible([inst("talk"), inst("meeting-notes", { inProgress: true }), inst("deck-edit", { inProgress: false })]).join() === "i:talk,i:deck-edit",
  "P2 다 만든 앱은 그대로 선다 — inProgress 를 안 주거나 false 면 종전 그대로", installedRailEligible([inst("talk"), inst("meeting-notes", { inProgress: true }), inst("deck-edit", { inProgress: false })]).join());
check(installedRailEligible([inst("x", { hasUi: false }), inst("sources", { systemRoute: "#/sources" })]).length === 0,
  "P3 화면 없는 앱 · 정본 주소를 가진 빌트인은 종전처럼 빠진다");
check(/inProgress:\s*isAppInProgress\(/.test(appsTs) && !/export function noteInstalledApp\(/.test(appsTs),
  "P4 ★ apps.ts 는 설치 앱의 최근 칸 자격을 앱 찾기와 같은 자(isAppInProgress)로 재고, 자를 거치지 않는 noteInstalledApp 은 없다");
check(!/noteInstalledApp\(/.test(mainTs) && /noteInstalledAppOpened\(/.test(mainTs) && !/noteAppUse\(installedRecentKey\(/.test(mainTs),
  "P5 ★ main.ts 의 앱 인스턴스 화면(#/i/)은 자를 거친 한 길(noteInstalledAppOpened)로만 최근 기록을 적는다");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

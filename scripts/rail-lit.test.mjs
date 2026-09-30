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
const { railLitKey } = await import(path.join(out, "lib/rail-lit.js"));

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

// ───────────────────────── B. 배선 — 레일·구역 드롭다운이 이 잣대 하나를 쓴다
const rail = code(readFileSync(path.join(root, "web/v2/rail.ts"), "utf8"));
const mainTs = code(readFileSync(path.join(root, "web/v2/main.ts"), "utf8"));
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

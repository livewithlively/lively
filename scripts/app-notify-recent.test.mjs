// #4769 2차 — 앱 알림 체계(사람이 앱마다 끈 알림 · 다른 구성원에게 보내기) · 설치한 앱의 최근 줄 · #/open 문 · lively.state.
//  사양 · 엣지 표는 스크래치 spec-notify-recent.md(R1~R3 순수 · W1~W6 배선). 순수 판정은 lib/rail-lit 를 tsc 로 옮겨 돌리고,
//  배선은 주석을 걷은 소스에서 본다(스크립트 rail-recent-stable.test.mjs 와 같은 방식).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "notify-recent-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/rail-lit.ts"), "--rootDir", path.join(root, "web"),
   "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const L = await import(path.join(out, "lib/rail-lit.js"));

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "기대와 다르다") => (cond ? ok(n) : bad(n, JSON.stringify(why).slice(0, 300)));
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const read = (f) => code(readFileSync(path.join(root, f), "utf8"));
const fnBody = (src, name) => { const i = src.indexOf(`function ${name}(`); return i < 0 ? "" : src.slice(i, src.indexOf("\n}\n", i)); };

// ── R. 설치한 앱의 최근 칸 — 순수 판정 ──
{
  const r = L.installedRailEligible([
    { id: "talk", hasUi: true }, { id: "sources", hasUi: true, systemRoute: "#/sources" }, { id: "bot", hasUi: false }, { id: "", hasUi: true },
  ]);
  check(eq(r, ["i:talk"]), "R1 ★ 화면이 있고 정본 주소가 없는 설치 앱만 — 자료(정본 주소) · 세션 앱(화면 없음) · 빈 id 는 빠진다", r);
}
check(L.installedRecentKey("talk") === "i:talk" && L.isInstalledRecentKey("i:talk") === true && L.isInstalledRecentKey("i:") === false && L.isInstalledRecentKey("talk") === false && L.isInstalledRecentKey("") === false,
  "R2 키는 i:<앱 id> — 접두사만 있거나 앱 표 키면 설치 앱 키가 아니다");
{
  const r = L.railRecentKeys(["i:talk", "learn"], ["dashboard", "learn", "i:talk"], 2);
  check(eq(r, ["learn", "i:talk"]), "R3 설치 앱 키도 railRecentKeys 를 그대로 지난다 — 설 자리는 표 순서(앱 표 뒤)", r);
}

// ── W. 배선 ──
const apps = read("web/v2/apps.ts");
const note = fnBody(apps, "noteAppUse");
check(/isInstalledRecentKey\(key\)/.test(note) && /appByKey\(key\)/.test(note),
  "W3a ★ noteAppUse 가 설치 앱 키(i:)는 표에 없어도 적고, 표 키는 종전처럼 표로 가른다");
check(/installedAppDefs\(\)/.test(fnBody(apps, "recentApps")), "W3b 홈의 최근 줄(recentApps)이 설치 앱 목록을 합친다");
check(/route: 'open\/' \+ encodeURIComponent\(a\.id\)/.test(apps) && /registerAppIcon\(a\.id, a\.icon\) \|\| builtinAppIcon\(a\.id, a\.hasUi\)/.test(apps),
  "W3c 설치 앱의 문은 #/open/<앱 id> · 그림은 선언한 아이콘 → 기본 그림");
//  #4878 — 잣대는 installedRecentOk 한 자리(installedRailEligible + 만드는 중 isAppInProgress). 목록(loadInstalled)도 방금 연 앱(noteInstalledAppOpened)도 그 한 자리를 거친다.
check(/installedRecentEligible\(/.test(fnBody(apps, "installedRecentOk")) && /buildingNow\(a\)/.test(fnBody(apps, "installedRecentOk"))
    && /filter\(installedRecentOk\)/.test(fnBody(apps, "installedAppDefs")) && /installedRecentOk\(a\)/.test(fnBody(apps, "noteInstalledAppOpened")),
  "W3d 목록을 받을 때도 · 방금 연 앱을 올릴 때도 같은 잣대(installedRecentOk — installedRailEligible + 만드는 중 제외)로 거른다");

const rail = read("web/v2/rail.ts");
check(/\.\.\.installedAppDefs\(\)\]/.test(fnBody(rail, "recentForRail")), "W4a ★ 레일 최근 칸(recentForRail)이 설치 앱 목록을 합친다");
check(/if \(!inst\) wireDrag\(it, a\.key, kind\)/.test(rail), "W4b 설치 앱 칸은 끌기(독 고정)를 걸지 않는다 — 순서 저장이 앱 표 키만 믿는다");
check(/isInstalledRecentKey\(a\.key\)\) \{ ctxMenu\(x, y, \[\{ label: '열기'/.test(fnBody(rail, "dockMenu")), "W4c 설치 앱의 우클릭은 「열기」 만");
check(/primeInstalledApps\(\)\.then\(\(\) => drawRail\(\)\)/.test(fnBody(rail, "mountRail")), "W4d 레일을 달 때 설치 앱 목록을 받아 다시 그린다");

const main = read("web/v2/main.ts");
check(/page === 'open' && segs\[1\]/.test(main) && /openInstalledApp\(a, null, \{ state: /.test(main), "W5a ★ #/open/<앱 id> 갈래 — 설치 앱을 열며 물음표 뒤 값을 state 로 싣는다");
check(/noteInstalledAppOpened\(instance\.app_id\)/.test(main) && /noteAppUse\(installedRecentKey\(appId\)\)/.test(fnBody(apps, "noteInstalledAppOpened")),
  "W5b ★ #/i/<인스턴스> 를 그릴 때 설치 앱을 최근 기록 · 목록에 올린다(#4878 — 자를 거친 한 길 noteInstalledAppOpened)");
check(/if \(p === 'open'\) return \{ title: '앱 여는 중', noAside: true \}/.test(main), "W5c 탭 제목 표에 open");
check(/\(app-open\|app-grant\|full\|open\)/.test(read("web/v2/tabs.ts")), "W5d ★ #/open 은 지나가는 주소(저장본에서 빠진다)");
check(/state: \(instance\.state && typeof instance\.state === 'object'\)/.test(main), "W5e #/i 가 앱 프레임에 인스턴스 state 를 넘긴다");

const ui = read("web/v2/app-ui.ts");
check(/instance: opts\?\.instanceId \?\? null, state: opts\?\.state \?\? null,/.test(ui), "W6a ★ 인사(ui/initialize) 응답에 state");
const rt = read("web/v2/app-ui-runtime.ts");
check(/api\.state = \(r && r\.state && typeof r\.state === 'object'\) \? r\.state : null;/.test(rt) && /state: null,/.test(rt), "W6b SDK 가 lively.state 를 둔다(객체가 아니면 null)");
const inst = read("web/v2/app-instance.ts");
check(/extra\?\.state && JSON\.stringify\(instance\.state \?\? \{\}\) !== JSON\.stringify\(extra\.state\)/.test(inst) && /if \(extra\?\.go\) extra\.go\(hash\); else location\.hash = hash;/.test(inst),
  "W6c 멱등 재열기에 옛 state 가 남으면 이번 값으로 덮는다 · 라우터 안에선 go 로 넘긴다");

// ── 알림 — 서버 배선 ──
const an = read("src/capabilities/app-notifications.ts");
check(!/토큰의 주인에게만/.test(an) && /const target = String\(input\.member_id \|\| ""\)\.trim\(\) \|\| me;/.test(an) && /actor: target !== me \? me : null,/.test(an),
  "W1 ★ app_notify 가 다른 구성원에게도 보낸다 — 보낸 사람이 다르면 actor 로 남긴다");
check(/if \("muted" in r\) return \{ ok: true, muted: true \};/.test(an), "W1b 끈 사람에게 보내면 muted 로 답한다(실패가 아니다)");
const nt = read("src/apps/notify.ts");
check(/if \(!isBuiltin\) \{\s*const prefs = await getNotifyPrefs\(input\.memberId\)\.catch\(\(\) => null\);\s*if \(prefs && isAppMutedByMember\(prefs\.apps, input\.appId\)\) return \{ ok: true, muted: true \};/.test(nt),
  "W2 ★ notifyMember 가 grant 판정 뒤 받는 사람의 앱 끔을 본다 — 빌트인은 안 본다 · 설정을 못 읽으면 안 끈 것");
check(nt.indexOf("isAppMutedByMember(") > nt.indexOf("if (denial) return { ok: false, denial };"), "W2b 끔 판정은 권한 판정(fail-closed) **뒤**다 — 끈 사람이라도 권한 없는 앱은 먼저 거부된다");
const ps = read("src/v6/notify-pref-store.ts");
check(/out\.apps = normalizeAppMutes\(src\?\.apps\);/.test(ps) && /apps: \{ \.\.\.cur\.apps, \.\.\.\(patch\.apps \|\| \{\}\) \}/.test(ps), "W2c 설정 저장 — apps 는 정리해서 적고 부분 갱신한다");
const nc = read("src/capabilities/notify.ts");
check(/apps: z\.record\(z\.boolean\(\)\)\.optional\(\)/.test(nc), "W2d notify_prefs_set 이 apps 를 받는다");
const me = read("web/v2/me-modal.ts");
check(/apps\.filter\(\(a\) => a\.notifications\)/.test(me) && /JSON\.stringify\(\{ apps: \{ \[a\.id\]: on \} \}\)/.test(me) && /mutes\[a\.id\] !== false/.test(me),
  "W2e ★ [나 ▸ 알림] 에 알림을 보내는 앱마다 스위치 — 꺼진 앱만 적혀 있으니 없으면 켜짐");
const who = read("src/capabilities/whoami.ts");
check(/\.\.\.\(isApp \? \{ avatar: member\?\.avatar \?\? null, avatar_char: member\?\.avatar_char \?\? null, avatar_color: member\?\.avatar_color \?\? null \} : \{\}\)/.test(who),
  "W7 whoami — 앱 principal 에만 얼굴(아바타 · 글자 · 색)을 준다");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

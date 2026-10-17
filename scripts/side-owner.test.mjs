// 사이드바는 지금 화면의 앱 것이다(web/lib/side-owner.ts, #4632 원준 2026-10-17) — 어느 화면에서 누가 사이드바를 갖나 · 구역 목록이면 어느 구역인가.
//  «사이드바 내용까지가 하나의 앱이야. 한 앱을 실행했는데 다른 앱의 사이드바가 계속 떠있거나, 홈의 사이드바가 떠있는 경우는 없어야한다 …
//   없을 때에는 사이드바 영역만큼도 다 그 앱이 쓰는게 디폴트야.»
//  이게 틀리면: 앱빌더 · 설정 · 리브에서 홈 목록이 그대로 남거나(설정은 사이드바가 둘), 세션 화면에서 사이드바가 사라진다.
//  컴파일된 모듈(public/app/lib/side-owner.js)을 돌린다 — 빌드가 없으면 건너뛴다(CI 의 run-tests --build 가 돈다). 엣지 표: 스크래치패드 spec-side-owner.md A · B.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
//  SIDE_OWNER_JS — 다른 빌드(뮤테이션 · fail-first)를 물릴 때. 없으면 이 트리의 빌드.
const mod = process.env.SIDE_OWNER_JS || join(root, "public/app/lib/side-owner.js");
if (!existsSync(mod)) { console.log("side-owner: 빌드 없음(public/app/lib/side-owner.js) — 건너뜀"); process.exit(0); }
const O = await import(mod);

let pass = 0, fail = 0;
const check = (ok, name, got) => { if (ok) { pass++; console.log("ok  " + name); } else { fail++; console.error("FAIL  " + name + (got === undefined ? "" : " — " + JSON.stringify(got))); } };
const all = (pairs, want) => pairs.map(([ak, page]) => [ak, page, O.sideOwnerOf(ak, page)]).filter((x) => x[2] !== want);

// ── A. 사이드바 주인 ──
let bad = all([["home"], ["s:box-1"], ["p:3"]], "section");
check(bad.length === 0, "A1 홈 · 세션 · 프로젝트는 구역 목록(구역은 세션을 여는 자리)", bad);
bad = all([["archive"], ["trash"]], "section");
check(bad.length === 0, "A2 지난 세션 · 휴지통(구역 발치 도크)은 구역 목록", bad);
bad = all([["app:terminal"], ["app:projects2"], ["app:knowledge"]], "section");
check(bad.length === 0, "A3 구역과 같은 문(세션 목록 · 프로젝트 · 위키 화면)은 구역 목록", bad);
check(O.sideOwnerOf("sources") === "sources" && O.sideOwnerOf("taxonomy") === "taxonomy" && O.sideOwnerOf("app:sessions") === "sessions" && O.sideOwnerOf("builder") === "builder",
  "A4 자료 · 분류체계 · 세션 이력 · 앱빌더는 제 사이드바", ["sources", "taxonomy", "app:sessions", "builder"].map((k) => O.sideOwnerOf(k)));
bad = all([["liv"], ["inbox"], ["connect"], ["learn"], ["app:context"], ["app:system"], ["app:dashboard"], ["app:learn"], ["app:zzz"]], "none");
check(bad.length === 0, "A5 리브 · 확인할 것 · 외부 앱 연결 · 사용 가이드 · 맥락 관리 · 설정 · 대시보드 · 모르는 앱은 사이드바 없음(그 자리까지 앱)", bad);
bad = all([["app:", "i"], ["app:", "full"]], "none");
check(bad.length === 0, "A6 앱 인스턴스(#/i) · 크게 보기(#/full)는 사이드바 없음", bad);
bad = all([["app:", "welcome"], ["app:", ""], ["app:", "foo"], ["app:"]], "section");
check(bad.length === 0, "A7 처음 설정 · 첫 칸 없음 · 모르는 주소(셸이 홈을 그린다)는 구역 목록", bad);
bad = all([["s:"], ["p:"]], "section");
check(bad.length === 0, "A8 경계 — 빈 id 의 세션 · 프로젝트 키도 구역 목록", bad);
check(O.sideOwnerOf("") === "section" && O.sideOwnerOf("", "i") === "none", "A9 활성 키가 비었으면 첫 칸으로 — 없으면 구역, 앱 인스턴스면 없음", [O.sideOwnerOf(""), O.sideOwnerOf("", "i")]);

// ── B. 서는 구역 ──
const sh = (ak, mem) => O.sectionShown(ak, mem);
check(sh("app:knowledge", "home") === "wiki" && sh("app:projects2", "wiki") === "proj" && sh("app:terminal", "proj") === "sess",
  "B1 구역과 같은 문은 그 구역 — 다른 구역을 기억하고 있어도", [sh("app:knowledge", "home"), sh("app:projects2", "wiki"), sh("app:terminal", "proj")]);
check(sh("s:x", "wiki") === "home" && sh("home", "wiki") === "home" && sh("p:3", "wiki") === "home",
  "B2 세션이 사는 화면에 위키를 기억하고 있으면 홈", [sh("s:x", "wiki"), sh("home", "wiki"), sh("p:3", "wiki")]);
check(sh("s:x", "proj") === "proj" && sh("s:x", "sess") === "sess" && sh("home", "home") === "home",
  "B3 그 밖엔 기억한 구역 그대로(홈 목록에서 세션을 열어도 목록이 남는다 · #2016)", [sh("s:x", "proj"), sh("s:x", "sess"), sh("home", "home")]);
check(sh("archive", "wiki") === "wiki" && sh("trash", "proj") === "proj", "B4 지난 세션 · 휴지통은 어느 구역 발치에도 있으니 기억 그대로", [sh("archive", "wiki"), sh("trash", "proj")]);
check(sh("builder", "wiki") === "wiki" && sh("", "sess") === "sess", "B5 앱 화면 · 빈 키는 기억 그대로(구역 목록은 폰 서랍에만 쓰인다)", [sh("builder", "wiki"), sh("", "sess")]);

// ── C. 실제 주소 → 활성 키 → 주인 (activeKeyOfRoute · sideOwnerOfRoute — 셸이 이 함수를 쓴다) ──
//  격리 리뷰: 손으로 친 활성 키만 재면 셸의 키 판정 · 클래식 표와 이 표가 어긋나도 안 보인다. 그래서 셸의 최상위 화면 대장(SHELL_SURFACES)과
//   클래식 표(CLASSIC_PAGES)의 모든 첫 칸을 실제 주소로 넣는다 — 새 화면을 만들면 여기서 주인을 고르기 전엔 빨갛다(말없이 «없음» 으로 떨어지지 않게).
{
  const surf = join(root, process.env.SHELL_SURFACES_JS || "public/app/v2/shell-surfaces.js");
  const classic = join(root, "public/app/lib/classic-pages.js");
  if (existsSync(surf) && existsSync(classic) && typeof O.sideOwnerOfRoute === "function") {
    const { SHELL_SURFACES } = await import(surf);
    const { CLASSIC_PAGES } = await import(classic);
    //  화면 대장의 첫 칸마다 — 그 화면의 사이드바 주인(이유는 lib/side-owner 머리말).
    const EXPECT = {
      "": "section", dashboard: "section", welcome: "section", "app-open": "section", "app-grant": "section", p: "section", s: "section",
      archive: "section", trash: "section",
      i: "none", full: "none", app: "none", learn: "none", inbox: "none", liv: "none", connect: "none",
      taxonomy: "taxonomy", sources: "sources", f: "sources", builder: "builder",
    };
    const unknown = Object.keys(SHELL_SURFACES).filter((k) => !(k in EXPECT));
    check(unknown.length === 0, "C1 화면 대장의 모든 첫 칸에 사이드바 주인이 정해져 있다(새 화면은 여기서 고른다)", unknown);
    const wrong = Object.keys(SHELL_SURFACES).filter((k) => k in EXPECT).map((k) => ["#/" + k + (k ? "/x1" : ""), EXPECT[k]]).map(([h, w]) => [h, w, O.sideOwnerOfRoute(h)]).filter((x) => x[1] !== x[2]);
    check(wrong.length === 0, "C2 화면 대장 — 실제 주소의 주인이 표와 같다", wrong);
    const CEXP = { dashboard: "section", terminal: "section", projects2: "section", projects: "section", knowledge: "section", k: "section", "k-edit": "section", trash: "section",
      context: "none", system: "none", start: "none", onboarding: "none", install: "none", sessions: "sessions", activate: "none" };
    const cun = Object.keys(CLASSIC_PAGES).filter((k) => !(k in CEXP));
    check(cun.length === 0, "C3 클래식 표의 모든 첫 칸에 사이드바 주인이 정해져 있다", cun);
    const cw = Object.keys(CLASSIC_PAGES).filter((k) => k in CEXP).map((k) => ["#/" + k + "/x1", CEXP[k], O.sideOwnerOfRoute("#/" + k + "/x1")]).filter((x) => x[1] !== x[2]);
    check(cw.length === 0, "C4 클래식 옛 주소 — 실제 주소의 주인(구역과 같은 문은 구역 · 세션 이력은 제 것 · 그 밖은 없음)", cw);
    const A = (h) => O.activeKeyOfRoute(h);
    check(A("#/app/knowledge") === "app:knowledge" && A("#/k/doc-1") === "app:knowledge" && A("#/projects/l/3") === "app:projects2" && A("#/app/terminal?x=1") === "app:terminal"
      && A("#/s/box%201") === "s:box 1" && A("#/") === "home" && A("") === "home" && A("#/f?root=a&path=b") === "sources" && A("#/i/inst-1") === "app:",
      "C5 활성 키 — 구역과 같은 문 · 옛 첫 칸 · 쿼리 · 세션 id 풀기 · 홈 · 자료 보기 · 앱 인스턴스", [A("#/k/doc-1"), A("#/s/box%201"), A("#/i/inst-1")]);
    let threw = null; try { A("#/s/%"); A("#/s/%E0%A4%A"); } catch (e) { threw = String(e); }
    check(threw === null && A("#/s/%") === "s:%", "C6 틀린 %-꼴의 세션 주소에도 던지지 않는다(그리기마다 묻는 값)", threw);
    check(O.sideOwnerOfRoute("#/app/sessions") === "sessions" && O.sideOwnerOfRoute("#/app/context") === "none" && O.sideOwnerOfRoute("#/app/system") === "none"
      && O.sideOwnerOfRoute("#/builder/s/box-1") === "builder" && O.sideOwnerOfRoute("#/builder?sel=memo") === "builder", "C7 #/app/<키> · 앱빌더 안의 주소");
  } else console.log("C  건너뜀 — 빌드 없음(shell-surfaces.js · classic-pages.js)");
}

console.log(`\n#4632 사이드바 주인: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`);
process.exit(fail ? 1 : 0);

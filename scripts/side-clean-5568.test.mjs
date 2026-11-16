// 사이드바 정리 (#5568, 상민님 2026-11-16) — 실제 크롬에서 잰 배치 + 등록부 배선.
//
//  «홈화면 사이드바에 스크롤바 안보이게 하고. 해당 스크롤바가 차지하고 있던 가로 영역 없애.
//   그리고 사이드바 하단 지난세션, 휴지통, 외부 앱 연결은 모두 앱 안에 넣고 사이드바에선 지워.
//   그리고 사이드바가 안보이는 곳에서는 디폴트로 검색창이 상단 한줄 전체 먹는 방식으로 노출되는데, 이거 그냥 그 상단 한줄 아예 안보이게해.»
//
// 사양(엣지 표, 행마다 단언 하나 이상) — 폭은 넓은 화면(1280) 기준, 브라우저 = has-topbar + topbar-web:
//  T1 사이드바 없는 앱(app-ctx) · 레일 보임      → 본문 · 우패널이 창 맨 위(y=0)부터 · 맨 윗줄은 레일 칸 폭뿐 · [‹][›][검색] 줄 없음 · ☰ 안 보임 · 레일 [검색] 칸이 선다
//  T2 app-ctx + 우패널 없음(no-aside)            → 본문 y=0 (같은 답)
//  T3 app-ctx + 사이드바를 접어 둔 기기(side-closed) → T1 과 같다(☰ 도 안 보인다 — 두 규칙이 겹쳐도 앱 화면의 답이 이긴다)
//  T4 app-ctx + 레일 숨김(rail-hidden)           → 전폭 줄이 남는다(본문 y=42 · 검색 줄 보임 · ☰ 보임) — 다른 데로 가는 길이 그 줄뿐이다
//  T5 경계: 사이드바가 펴진 화면(홈)              → 줄은 레일 + 사이드바 위 · 검색 줄 보임 · ☰ 보임 · 레일 [검색] 칸 없음 · 본문 y=0
//  T6 경계: 사이드바를 접은 화면(side-closed)     → 종전 그대로(본문 y=0 · ☰ 보임 — 닫힌 사이드바를 되찾는 길)
//  T7 데스크톱 앱(topbar-web 아님) + app-ctx      → 줄이 창 전폭 그대로(OS 타이틀바) · 본문 y=42
//  T8 좁은 폭(900) + app-ctx                     → 서랍 셸(flex) 그대로 — 줄이 화면을 가로지른다(이 변경이 건드리지 않는다)
//  T9 레일 칸 자리 — app-ctx 와 홈에서 레일의 y 가 같다(화면을 오갈 때 레일 칸이 오르내리지 않는다)
//  S1 사이드바 목록(.v2-side .v2-app-list) — 넘쳐도 막대가 폭을 안 먹는다(offsetWidth = clientWidth) · scrollbar-width: none · 굴릴 수는 있다
//  S2 경계: 사이드바 밖의 같은 목록(.v2-app-list)은 건드리지 않는다
//  A1 앱 표에 셋(connect · archive · trash)이 native 로 서 있다 — 이름 · 주소 · 그림
//  A2 빌트인 패키지 셋이 있고 서버 매니페스트 파서를 통과한다(renderer 가 서버 목록 · 스키마 목록에 다 있다)
//  A3 그림 이름 셋이 앱 아이콘 목록에 있고 색 토큰이 라이트 · 다크 두 블록에 있다
//  D1 사이드바 코드에 발치 도크가 없다(dock('archive' …) 호출 0) · 라우터가 셋을 «연 앱» 으로 적는다
//  D2 ☰ · ⌘B 는 사이드바 없는 앱에서 «닫힘» 기억을 뒤집지 않는다
//
// fail-first: `SRC_ROOT=<다른 트리>` 로 그 트리의 web/ · public/styles · apps 를 물린다(이 변경 전 origin/main 에서 T1~T3 · S1 · A1~A3 · D1 · D2 — 14건이 빨갛다).
//  T4~T9 · S2 는 경계(이 변경이 건드리지 않는 자리)라 그 트리에서도 초록이다. ⚠ 헤드리스 크롬은 덮는 막대라 S1 의 폭 차(offsetWidth − clientWidth)는
//   종전에도 0 이다 — 빨간불은 scrollbar-width 값(thin → none)이 낸다. 폭 단언은 막대가 자리를 먹는 환경에서 돌 때를 위한 것이다.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dumpDom, findChrome } from "./headless-chrome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_ROOT = process.env.SRC_ROOT ? path.resolve(process.env.SRC_ROOT) : ROOT;
const STYLES = path.join(SRC_ROOT, "public/styles");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const check = (cond, n, why = "") => (cond ? ok(n) : bad(n, why));
const read = (p) => readFileSync(path.join(SRC_ROOT, p), "utf8");
const has = (p) => existsSync(path.join(SRC_ROOT, p));
const done = () => { console.log(`\n#5568 사이드바 정리: ${pass} passed${fail ? `, ${fail} FAILED` : ""}`); process.exit(fail ? 1 : 0); };

// ── A · D — 등록부와 배선(소스) ──────────────────────────────────────────────────────
const APPS_SRC = read("web/v2/apps.ts");
const THREE = [["connect", "외부 앱 연결", "link"], ["archive", "지난 세션", "archive"], ["trash", "휴지통", "trash"]];
{
  const table = APPS_SRC.slice(APPS_SRC.indexOf("export const APPS"), APPS_SRC.indexOf("\n];", APPS_SRC.indexOf("export const APPS")));
  const row = (k) => (table.split("\n").find((l) => new RegExp(`^\\s*\\{\\s*key:\\s*'${k}'`).test(l)) || "");
  const wrong = THREE.filter(([k, title, icon]) => { const l = row(k); return !(l.includes(`title: '${title}'`) && l.includes(`route: '${k}'`) && l.includes(`icon: '${icon}'`) && /kind:\s*'native'/.test(l) && !/hidden:\s*true/.test(l)); });
  check(wrong.length === 0, "A1 앱 표에 외부 앱 연결 · 지난 세션 · 휴지통이 native 앱으로 서 있다(이름 · 주소 · 그림)", wrong.map((x) => x[0]).join(","));
}
{
  const missing = THREE.map(([k]) => k).filter((k) => !has(`apps/builtin/${k}/lively-app.json`));
  check(missing.length === 0, "A2a 빌트인 패키지 셋이 있다(apps/builtin/<id>/lively-app.json)", missing.join(","));
  //  서버 파서(dist/apps/manifest.js)로 실제로 읽어 본다 — renderer 가 서버 목록에 없으면 부팅 시딩이 «로드 실패(건너뜀)» 로 조용히 넘긴다.
  const dist = path.join(ROOT, "dist/apps/manifest.js");
  if (!missing.length && existsSync(dist) && SRC_ROOT === ROOT) {
    const { parseAppManifest, APP_SYSTEM_RENDERERS } = await import(pathToFileURL(dist).href);
    const errs = [];
    for (const [k, title] of THREE) {
      try {
        const m = parseAppManifest(JSON.parse(read(`apps/builtin/${k}/lively-app.json`)));
        if (m.id !== k || m.title !== title || m.system?.route !== "#/" + k || !APP_SYSTEM_RENDERERS.includes(m.system?.renderer) || m.instances?.multiplicity !== "single") errs.push(k + ": 값이 다르다");
      } catch (e) { errs.push(k + ": " + String(e && e.message ? e.message : e).slice(0, 160)); }
    }
    check(errs.length === 0, "A2b 서버 매니페스트 파서가 셋을 그대로 읽는다(id · 이름 · 주소 · renderer · single)", errs.join(" | "));
  } else if (!missing.length) console.log("skip  A2b dist/apps/manifest.js 가 없거나 SRC_ROOT 를 물려 파서 검증을 건너뜁니다");
  const schema = has("public/lively-app.schema.json") ? read("public/lively-app.schema.json") : "";
  const noSchema = THREE.map(([k]) => k).filter((k) => !new RegExp(`"builder",[\\s\\S]{0,200}"${k}"`).test(schema));
  check(noSchema.length === 0, "A2c 공개 스키마(lively-app.schema.json)의 renderer 목록에도 셋이 있다", noSchema.join(","));
}
{
  const glass = read("web/v2/glass-icon.ts");
  const names = (/APP_ICON_NAMES = \[([^\]]*)\]/.exec(glass) || ["", ""])[1];
  const base = read("public/styles/01-base.css"), dark = read("public/styles/90-dark.css");
  const lost = THREE.map(([, , i]) => i).filter((i) => !names.includes(`'${i}'`) || !new RegExp(`--gi-c-${i}:\\s*#[0-9A-Fa-f]{6}`).test(base) || (dark.match(new RegExp(`--gi-c-${i}:\\s*#[0-9A-Fa-f]{6}`, "g")) || []).length !== 2);
  check(lost.length === 0, "A3 그림 셋(link · archive · trash)이 앱 아이콘 목록에 있고 색 토큰이 라이트 1 · 다크 2 블록에 있다", lost.join(","));
}
{
  const side = read("web/v2/side.ts"), main = read("web/v2/main.ts");
  check(!/dock\('(archive|trash|connect)'/.test(side) && !/class: 'v2-app-dock/.test(side), "D1a 사이드바 코드가 발치 도크를 그리지 않는다", "dock(…) 호출이 남아 있다");
  check(/noteAppUse\(page\);[\s\S]{0,400}renderPast\(/.test(main) && /noteAppUse\('connect'\)/.test(main)
    && /ensureSingletonAppInstance\(page, page === 'archive' \? '지난 세션' : '휴지통'\)/.test(main) && /ensureSingletonAppInstance\('connect', '외부 앱 연결'\)/.test(main),
  "D1b 라우터가 셋을 «연 앱» 으로 적고 인스턴스를 확보한다(최근 연 앱 줄에 선다)");
  const fn = (/function toggleSideBar\(\): void \{[\s\S]*?\n\}/.exec(main) || [""])[0];
  check(/classList\.contains\('app-ctx'\)/.test(fn) && /return;/.test(fn) && fn.indexOf("return;") < fn.indexOf("setSideClosed("),
    "D2 ☰ · ⌘B — 사이드바 없는 앱에선 «닫힘» 기억을 뒤집기 전에 돌아간다", fn.slice(0, 200) || "함수를 못 찾았다");
}

// ── T · S — 실제 크롬에서 잰 배치 ─────────────────────────────────────────────────────
const chrome = findChrome();
if (!chrome) { console.log("skip  크롬을 못 찾아 런타임 검증(T · S)을 건너뜁니다(CHROME_BIN 으로 지정)"); done(); }
const cssText = ["01-base.css", "40-v2.css", "43-v2-topbar-search.css", "47-v2-rail.css", "50-mobile.css", "51-tablet.css"]
  .map((f) => (existsSync(path.join(STYLES, f)) ? readFileSync(path.join(STYLES, f), "utf8") : "")).join("\n").replace(/<\/style/gi, "<\\/style");
//  셸의 뼈대만 — main.ts 가 세우는 순서 그대로(맨 윗줄 · 레일 · 사이드바 · 손잡이 · 본문 · 손잡이 · 우패널). 전환은 끈다(tablet-shell-css 와 같은 이유).
const ROWS = Array.from({ length: 60 }, (_, i) => `<div style="height:30px">줄 ${i}</div>`).join("");
const INNER = `<!doctype html><html data-theme="light" lang="ko"><meta charset="utf-8"><style>${cssText}\nhtml,body{margin:0;height:100%} #v2-root{height:700px} *{transition:none !important;animation:none !important}</style>
<div id="v2-root" class="rail-mode"><div class="v2-topbar v2-topbar--web" id="tb"><button class="v2-mbar-btn v2-mbar-menu" id="menu"><svg class="v2-mbar-ic" viewBox="0 0 24 24"><path d="M4 6h16"/></svg></button><div class="v2-side-nav" id="nav"><span class="v2-nav-sp"></span><div class="v2-nav-core"><button class="v2-navb">‹</button><button class="v2-navb">›</button><button class="v2-omnib" id="omnib"><span class="v2-omnib-t">검색</span></button></div><span class="v2-nav-sp"></span></div><div class="v2-tb-grip"></div></div><nav class="v2-rail closed" id="rail"><div class="v2-rail-top"><div class="v2-rail-ws" id="ws" style="height:44px"></div><button class="v2-rail-it v2-rail-search" id="rsearch"><span class="v2-rail-t">검색</span></button></div><div class="v2-rail-mid"><button class="v2-rail-it" id="it"><span class="v2-rail-t">홈</span></button></div><div class="v2-rail-foot"></div></nav><nav class="v2-side" id="side"><div class="v2-app-list" id="list" style="height:200px;flex:none">${ROWS}</div></nav><div class="v2-split-x" id="s1"></div><main class="v2-main" id="main"><div class="v2-app-list" id="outside" style="height:200px;flex:none">${ROWS}</div></main><div class="v2-split-x" id="s2"></div><aside class="v2-aside" id="aside"></aside></div>`;
async function PAGE(inner) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = {};
  const probe = async (key, w, cls) => {
    const f = document.createElement("iframe");
    f.style.cssText = `width:${w}px;height:700px;border:0;display:block`;
    f.srcdoc = inner;
    document.body.append(f);
    await new Promise((r) => f.addEventListener("load", r, { once: true }));
    const D = f.contentDocument, W = f.contentWindow, root = D.getElementById("v2-root");
    cls.split(" ").filter(Boolean).forEach((c) => root.classList.add(c));
    await sleep(40);
    const el = (id) => D.getElementById(id);
    const r = (id) => { const b = el(id).getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
    const cs = (id) => W.getComputedStyle(el(id));
    const shown = (id) => cs(id).display !== "none" && cs(id).visibility !== "hidden" && r(id).w > 0;
    const list = el("list"), out = el("outside");
    list.scrollTop = 120;
    R[key] = {
      tb: r("tb"), tbShown: cs("tb").display !== "none", rail: r("rail"), main: r("main"), aside: r("aside"), side: r("side"),
      nav: shown("nav"), menu: shown("menu"), rsearch: shown("rsearch"), rootDisp: W.getComputedStyle(root).display,
      listGutter: list.offsetWidth - list.clientWidth, listSW: cs("list").scrollbarWidth || "", listScrolled: list.scrollTop, listOverflowY: cs("list").overflowY,
      outSW: cs("outside").scrollbarWidth || "", outOverflows: out.scrollHeight > out.clientHeight,
    };
    f.remove();
  };
  const WEB = "has-topbar topbar-web ";
  await probe("t1", 1280, WEB + "app-ctx");
  await probe("t2", 1280, WEB + "app-ctx no-aside");
  await probe("t3", 1280, WEB + "app-ctx side-closed");
  await probe("t4", 1280, WEB + "app-ctx rail-hidden");
  await probe("t5", 1280, WEB.trim());
  await probe("t6", 1280, WEB + "side-closed");
  await probe("t7", 1280, "has-topbar app-ctx");
  await probe("t8", 900, WEB + "app-ctx no-aside");
  document.getElementById("out").textContent = "RESULT" + JSON.stringify(R) + "ENDRESULT";
}
const PAGE_HTML = `<!doctype html><meta charset="utf-8"><body><pre id="out">PENDING</pre><script>(${PAGE.toString()})(${JSON.stringify(INNER).replace(/</g, "\\u003c")});</script>`;
const dom = await dumpDom(chrome, { html: PAGE_HTML, prefix: "side-clean-", virtualTimeBudget: 30000, args: ["--window-size=1500,900"] });
const m = /RESULT(\{.*\})ENDRESULT/s.exec(dom.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
if (!m) { console.error("FAIL  결과 표지를 못 받았다 — 페이지가 끝까지 못 돌았다\n" + dom.slice(-600)); process.exit(1); }
const R = JSON.parse(m[1]);
const j = (o) => JSON.stringify(o);
const brief = (x) => j({ tb: x.tb, rail: x.rail, main: x.main, aside: x.aside, nav: x.nav, menu: x.menu, rsearch: x.rsearch });

//  배선 — 뼈대가 실제로 셸처럼 섰나(이게 아니면 아래가 아무것도 안 잰다): 홈에서 레일 · 사이드바가 폭을 갖고 맨 윗줄이 42 다.
check(R.t5.rail.w > 40 && R.t5.side.w > 100 && R.t5.tb.h === 42 && R.t5.rootDisp === "grid", "T0 배선 — 뼈대가 셸 그리드로 섰다(레일 · 사이드바 · 맨 윗줄 42)", brief(R.t5));

check(R.t1.main.y === 0 && R.t1.aside.y === 0 && R.t1.aside.w > 0, "T1a 사이드바 없는 앱 — 본문 · 우패널이 창 맨 위(y=0)부터 선다", brief(R.t1));
check(R.t1.tb.w === R.t1.rail.w && R.t1.tb.x === 0 && R.t1.tb.w < 120, "T1b 사이드바 없는 앱 — 맨 윗줄은 레일 칸 폭뿐이다(창을 가로지르지 않는다)", brief(R.t1));
check(R.t1.nav === false && R.t1.menu === false, "T1c 사이드바 없는 앱 — [‹][›][검색] 줄도 ☰ 도 안 보인다", brief(R.t1));
check(R.t1.rsearch === true, "T1d 사이드바 없는 앱 — 검색은 레일 맨 위 [검색] 칸이 맡는다", brief(R.t1));
check(R.t1.side.w === 0 && R.t1.main.x === R.t1.rail.w, "T1e 사이드바 없는 앱 — 사이드바 열 0 · 본문이 레일 바로 옆에서 시작", brief(R.t1));
check(R.t2.main.y === 0 && R.t2.tb.w === R.t2.rail.w && R.t2.nav === false, "T2 우패널 없는 앱 화면도 같다(본문 y=0 · 줄은 레일 칸뿐)", brief(R.t2));
check(R.t3.main.y === 0 && R.t3.tb.w === R.t3.rail.w && R.t3.nav === false && R.t3.menu === false && R.t3.rsearch === true,
  "T3 사이드바를 접어 둔 기기의 앱 화면 — 같은 답(☰ 도 안 보인다)", brief(R.t3));
check(R.t4.tb.w === 1280 && R.t4.main.y === 42 && R.t4.nav === true && R.t4.menu === true && R.t4.rsearch === false,
  "T4 레일까지 숨긴 앱 화면 — 전폭 줄이 남는다(다른 데로 가는 길이 그 줄뿐)", brief(R.t4));
check(R.t5.main.y === 0 && R.t5.tb.w === R.t5.rail.w + R.t5.side.w && R.t5.nav === true && R.t5.menu === true && R.t5.rsearch === false,
  "T5 경계 — 사이드바가 펴진 화면은 그대로(줄은 레일 + 사이드바 위 · 검색 줄 · ☰ · 레일 [검색] 없음)", brief(R.t5));
check(R.t6.main.y === 0 && R.t6.tb.w === R.t6.rail.w && R.t6.nav === false && R.t6.menu === true && R.t6.rsearch === true,
  "T6 경계 — 사이드바를 접은 화면은 그대로(☰ 는 남는다 — 닫힌 사이드바를 되찾는 길)", brief(R.t6));
check(R.t7.tb.w === 1280 && R.t7.main.y === 42 && R.t7.nav === true && R.t7.rsearch === false,
  "T7 데스크톱 앱(창 맨 윗줄 = OS 타이틀바) — 앱 화면에서도 줄이 창 전폭 그대로", brief(R.t7));
//  이 폭(641~900)은 태블릿 셸이다 — 레일이 왼쪽 여백(64)에 서고 줄은 그 옆에서 화면 끝까지 간다(51-tablet.css).
check(R.t8.rootDisp === "flex" && R.t8.tbShown === true && R.t8.tb.x + R.t8.tb.w === 900 && R.t8.tb.w > 700 && R.t8.main.y === 42 && R.t8.nav === true,
  "T8 좁은 폭(900) — 서랍 셸 그대로(줄이 본문 위를 가로지르고 검색 줄이 그 안에 있다)", j({ d: R.t8.rootDisp, tb: R.t8.tb, main: R.t8.main, nav: R.t8.nav }));
check(R.t1.rail.y === R.t5.rail.y && R.t1.rail.y === R.t6.rail.y, "T9 레일 칸 자리 — 앱 화면 · 홈 · 접힌 화면에서 레일의 y 가 같다(오르내리지 않는다)", j([R.t1.rail.y, R.t5.rail.y, R.t6.rail.y]));

check(R.t5.listOverflowY === "auto" && R.t5.listScrolled === 120, "S0 배선 — 사이드바 목록이 넘치고 실제로 굴러간다(이게 아니면 S1 은 아무것도 안 잰다)", j({ o: R.t5.listOverflowY, top: R.t5.listScrolled }));
check(R.t5.listGutter === 0 && R.t5.listSW === "none", "S1 사이드바 목록 — 막대가 없고 폭도 안 먹는다(offsetWidth = clientWidth · scrollbar-width: none)", j({ gutter: R.t5.listGutter, sw: R.t5.listSW }));
check(R.t5.outOverflows === true && R.t5.outSW !== "none", "S2 경계 — 사이드바 밖의 같은 목록은 건드리지 않는다", j({ sw: R.t5.outSW }));

done();

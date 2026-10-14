// 알림의 워크스페이스 — 웹 쪽 두 자리 (#4054). 사양 표 W1~W6.
//
//  ① 주소가 워크스페이스를 고른다(web/lib/net.ts) — 데스크톱 앱이 셀프호스트 다중 워크스페이스의 알림을 누르면
//     `/ui/?lvly_ws=<slug>#/s/<id>` 를 싣는다. 그 값은 **모듈이 실릴 때** 선택에 반영되고 주소에서 빠져야 한다.
//     부팅에서 반영하면 워크스페이스별 키(wsKey)를 모듈 적재 때 계산하는 자리가 옛 키로 돈다.
//  ② 브라우저 배너 윗줄 = 워크스페이스 이름(web/v2/banner-text.ts) — 데스크톱 앱 배너와 같은 규칙.
//
// 러너는 web/ 을 수집하지 않으므로 컴파일 산출물(public/app)을 싣는다. net.js 는 모듈 본문에서 location·history·
//  localStorage 를 읽으므로 스텁을 깔고, 시나리오마다 쿼리를 바꿔 **다시 적재**한다(?case= 로 모듈 캐시를 가른다).
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NET = pathToFileURL(join(root, "public/app/lib/net.js")).href;
let pass = 0;
const eq = (got, want, name) => { assert.deepEqual(got, want, `${name}\n  기대 ${JSON.stringify(want)}\n  실제 ${JSON.stringify(got)}`); pass++; console.log(`ok  ${name}`); };

let store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const replaced = [];
globalThis.history = { state: { keep: 1 }, replaceState: (st, _t, url) => { replaced.push({ st, url }); } };
let top = null;   // null = 최상위 문서
globalThis.window = new Proxy({}, { get: (_o, k) => (k === "top" ? (top ?? globalThis.window) : undefined) });

let n = 0;
/** 이 주소로 페이지가 떴다고 치고 net.js 를 새로 적재한다. */
async function load(search, { hash = "#/s/box-a-1", pathname = "/ui/", selected = undefined, framed = false } = {}) {
  store = selected === undefined ? {} : { "lively.workspace": selected };
  replaced.length = 0;
  top = framed ? {} : null;
  globalThis.location = { pathname, search, hash };
  return import(`${NET}?case=${++n}`);
}

// ── 배선 — 스텁이 죽어 있으면 아래가 전부 vacuous 다 ─────────────────────────
{
  const m = await load("?lvly_ws=haru");
  eq(typeof m.workspaceFromSearch, "function", "배선: net.js 가 순수 판정을 내보낸다");
  eq(m.currentWorkspace(), "haru", "배선: 적재 뒤 선택이 스텁 저장소를 거쳐 읽힌다");
}

// ── W1 선택 + 주소 정리 + 해시 보존 ─────────────────────────────────────────
{
  const m = await load("?lvly_ws=HARU", { selected: "primary-old" });
  eq(store["lively.workspace"], "haru", "W1 주소의 워크스페이스가 선택이 된다(소문자로)");
  eq(replaced.map((r) => r.url), ["/ui/#/s/box-a-1"], "W1 주소에서 파라미터를 지우고 해시는 남긴다");
  eq(replaced[0].st, { keep: 1 }, "W1 history.state 를 버리지 않는다");
  eq(m.wsKey("lively_v2_tabs"), "lively_v2_tabs@haru", "W1 ★ 모듈 적재 직후의 워크스페이스 키가 이미 새 선택을 본다");
}

// ── W2 primary = 선택 해제 ──────────────────────────────────────────────────
{
  await load("?lvly_ws=primary", { selected: "haru" });
  eq("lively.workspace" in store, false, "W2 primary 는 선택을 지운다(미선택 = primary 규약)");
  eq(replaced.map((r) => r.url), ["/ui/#/s/box-a-1"], "W2 주소 정리");
}

// ── W3 형식 불량 — 선택은 그대로, 파라미터만 제거 ──────────────────────────────
for (const bad of ["..%2Fetc", "has space", "-lead", "x".repeat(64), ""]) {
  await load(`?lvly_ws=${bad}`, { selected: "haru" });
  eq(store["lively.workspace"], "haru", `W3 형식 아닌 값(${JSON.stringify(bad.slice(0, 12))})으로 선택을 바꾸지 않는다`);
  eq(replaced.length, 1, `W3 그래도 파라미터는 지운다(${JSON.stringify(bad.slice(0, 12))})`);
}

// ── W4 파라미터 없음 — 아무 일도 없다 ──────────────────────────────────────────
{
  await load("?embed=1", { selected: "haru" });
  eq(store["lively.workspace"], "haru", "W4 파라미터가 없으면 선택을 안 건드린다");
  eq(replaced.length, 0, "W4 주소도 안 건드린다");
  await load("", {});
  eq(replaced.length, 0, "W4 쿼리가 비어도 조용하다");
}

// ── W5 다른 파라미터 보존 ─────────────────────────────────────────────────────
{
  await load("?solo=1&lvly_ws=team-x&shell=classic", { pathname: "/preview/p1/ui/" });
  eq(store["lively.workspace"], "team-x", "W5 섞여 와도 고른다");
  eq(replaced.map((r) => r.url), ["/preview/p1/ui/?solo=1&shell=classic#/s/box-a-1"], "W5 나머지 파라미터·경로 접두는 그대로");
}

// ── 액자 안에서는 바깥 선택을 바꾸지 않는다 ────────────────────────────────────
{
  await load("?embed=1&lvly_ws=other", { selected: "haru", framed: true });
  eq(store["lively.workspace"], "haru", "액자(곁칸·embed)는 같은 저장소의 바깥 선택을 바꾸지 않는다");
  eq(replaced.length, 0, "액자의 주소는 건드리지 않는다");
}

// ── 순수 판정 표 ──────────────────────────────────────────────────────────────
{
  const m = await load("");
  eq(m.workspaceFromSearch(""), null, "판정: 빈 쿼리 → null");
  eq(m.workspaceFromSearch("?a=1"), null, "판정: 파라미터 없음 → null");
  eq(m.workspaceFromSearch("?lvly_ws=haru"), { slug: "haru", search: "" }, "판정: 값만 있음");
  eq(m.workspaceFromSearch("?lvly_ws=PRIMARY&a=1"), { slug: "", search: "?a=1" }, "판정: primary(대소문자 무시) = 해제");
  eq(m.workspaceFromSearch("?lvly_ws=a/b"), { slug: null, search: "" }, "판정: 형식 아님 = null(그대로 둔다)");
  eq(m.workspaceFromSearch("?lvly_ws=" + "a".repeat(63)), { slug: "a".repeat(63), search: "" }, "판정 경계: 63자는 받는다");
  eq(m.workspaceFromSearch("?lvly_ws=" + "a".repeat(64)), { slug: null, search: "" }, "판정 경계: 64자는 받지 않는다");
}

// ── 배선: net.ts 는 모듈 **맨 끝**에서 한 번 부른다(앞에서 부르면 const 가 TDZ 라 조용히 안 된다) ──
{
  const src = readFileSync(join(root, "web/lib/net.ts"), "utf8");
  const callAt = src.lastIndexOf("adoptWorkspaceFromUrl();");
  eq(callAt > src.indexOf("const WORKSPACE_KEY") && callAt > src.indexOf("const WORKSPACE_SLUG_RE") && callAt < src.lastIndexOf("export {"), true,
    "배선: 선택 반영 호출이 쓰는 상수 선언들보다 뒤, export 바로 앞이다");
}

// ── W6 브라우저 배너 윗줄 ─────────────────────────────────────────────────────
{
  const { browserBannerText, BANNER_WS_NAME_MAX } = await import(pathToFileURL(join(root, "public/app/v2/banner-text.js")).href);
  eq(browserBannerText("장원준님이 댓글을 남겼어요", "확인 부탁드려요.", "Lively"),
    { title: "Lively", body: "장원준님이 댓글을 남겼어요 — 확인 부탁드려요." }, "W6 이름이 있으면 윗줄 = 워크스페이스, 본문 = 제목 — 본문");
  eq(browserBannerText("AI 가 답을 기다려요", null, "NCEO"), { title: "NCEO", body: "AI 가 답을 기다려요" }, "W6 본문이 없으면 제목만 내린다");
  eq(browserBannerText("AI 가 답을 기다려요", "x", ""), { title: "AI 가 답을 기다려요", body: "x" }, "W6 이름이 없으면 종전 모양");
  eq(browserBannerText("AI 가 답을 기다려요", "", "   "), { title: "AI 가 답을 기다려요" }, "W6 이름이 공백뿐이면 종전 모양(빈 본문은 싣지 않는다)");
  eq(browserBannerText("", "b", null), { title: "라이블리", body: "b" }, "W6 제목이 비면 라이블리");
  eq(browserBannerText("t", "b", "가".repeat(BANNER_WS_NAME_MAX + 3)).title, "가".repeat(60), "W6 이름은 60자에서 자른다");
  const noti = readFileSync(join(root, "web/v2/notifications.ts"), "utf8");
  eq(/const text = browserBannerText\(n\.title, n\.body, wsName\);\s*const banner = new Notification\(text\.title, \{ body: text\.body/.test(noti), true,
    "W6 배선: 배너가 워크스페이스 문구로 뜬다");
  const main = readFileSync(join(root, "web/v2/main.ts"), "utf8");
  eq(/startNotificationBanners\(undefined, \(\) => workspaceInfo\(\)\.name\)/.test(main), true, "W6 배선: 셸이 이 탭의 워크스페이스 이름을 넘긴다");
}

console.log(`\n${pass} passed`);

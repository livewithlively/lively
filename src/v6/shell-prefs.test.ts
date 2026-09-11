// 새 셸 개인화(#2460) — 서버가 **무엇을 저장 스키마로 인정하나**, 그리고 그 표가 화면과 어긋나지 않나.
//
// 이 층이 지키는 것은 두 가지다.
//  ① **허용목록** — 값은 브라우저가 보낸다. 구버전 셸·손으로 만든 요청이 계정 행에 임의 키를 쌓지
//     못하게, 무엇이 저장 스키마인지는 서버가 정한다.
//  ② **뜻이 있는 빈 값** — 「고정 0개」는 안 담지만(§A5), 치움 기준값의 `''` 는 **담는다**(§A8).
//     그건 「점 없는 상태로 치웠다」라는 뜻이라(#2110), 버리면 그 행이 다른 기기에서 영영 안 치워진다.
//     이 둘은 서로 반대 방향이라, 한쪽 규칙으로 뭉뚱그리면 반드시 하나가 깨진다.
//
// 그리고 **seam** — 이 표는 web/v2/shell-prefs.ts 의 선언과 짝이다. 한쪽에만 있으면 조용히 실패한다:
//  서버에만 있으면 아무도 안 쓰는 죽은 칸이고, 클라이언트에만 있으면 사람이 정한 것이 **저장되는
//  줄 알았는데 매번 버려진다**(에러도 안 난다).
import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fromStoredShellPrefs, isShellRowKey, normalizeShellPrefs, normalizeShellPrefsReport, SHELL_PREF_STORES } from "./shell-pref-store.js";

function repoRoot(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(d, "package.json"))) return d;
    d = path.dirname(d);
  }
  throw new Error("레포 뿌리를 찾지 못했다");
}
const ROOT = repoRoot();

// 표에서 각 모양의 대표 키 하나씩 — 키 이름이 바뀌어도 이 테스트가 따라오게 표에서 고른다.
const pick = (kind: string): string => {
  const k = Object.entries(SHELL_PREF_STORES).find(([, v]) => v === kind)?.[0];
  assert.ok(k, `허용목록에 ${kind} 모양의 저장소가 하나도 없다 — 표가 비었거나 모양 이름이 바뀌었다`);
  return k!;
};
const LIST = pick("list");
const MAP = pick("map");
const STR = pick("str");

// ── A. 정규화 — 사양 엣지 표 ────────────────────────────────────────────────
//  ⚠ 값은 **행 키 모양**(`route:…`)으로 둔다 — 표에서 고른 대표 저장소(첫 list·유일한 map)가 행 키 저장소라,
//   아무 문자열(`"a"`)이면 모양 검사(#3887 V)에 걸려 이 절이 재려는 목록·짝의 규칙과 섞인다.
const K = (s: string): string => "route:" + s;
test("A1·A2·A17 허용목록 밖은 저장하지 않는다(무엇이 스키마인지는 서버가 정한다)", () => {
  assert.deepEqual(normalizeShellPrefs({ evil_store: ["x"] }), {},
    "A1 허용목록 밖 키가 저장됐다 — 브라우저가 보낸 아무 키나 계정 행에 쌓인다");
  assert.deepEqual(normalizeShellPrefs({ [LIST]: [K("a")], evil_store: ["x"] }), { [LIST]: [K("a")] },
    "A2 허용목록 키만 남아야 한다");
  for (const bad of [null, undefined, [], "str", 7]) {
    assert.deepEqual(normalizeShellPrefs(bad), {}, `A17 객체가 아닌 입력(${JSON.stringify(bad)})은 빈 결과여야 한다`);
  }
});

test("A3·A4·A5 목록은 사람이 고른 순서다 — 순서 보존 · 중복 한 번 · 쓰레기 제거", () => {
  assert.deepEqual(normalizeShellPrefs({ [LIST]: [K("a"), 3, "", null, K("b"), "  "] }), { [LIST]: [K("a"), K("b")] },
    "A3 문자열이 아니거나 빈 원소가 남았다");
  assert.deepEqual(normalizeShellPrefs({ [LIST]: [K("a"), K("b"), K("a")] }), { [LIST]: [K("a"), K("b")] },
    "★A4 중복이 첫 자리로 접히지 않았다 — 같은 행이 목록에 두 줄로 선다");
  assert.deepEqual(normalizeShellPrefs({ [LIST]: [K("z"), K("m"), K("a")] }), { [LIST]: [K("z"), K("m"), K("a")] },
    "★A5 순서가 바뀌었다 — 레일은 사람이 **끌어서 정한 자리**라 정렬하면 그 결정이 사라진다");
});

test("A6·A10·A14 빈 값은 담지 않는다(쓰지도 않은 키가 계정마다 쌓이지 않게)", () => {
  assert.deepEqual(normalizeShellPrefs({ [LIST]: [] }), {}, "A6 빈 목록이 담겼다");
  assert.deepEqual(normalizeShellPrefs({ [MAP]: {} }), {}, "A10 빈 짝이 담겼다");
  assert.deepEqual(normalizeShellPrefs({ [STR]: "" }), {}, "A14 빈 문자열이 담겼다");
});

test("A7·A11·A13 모양이 선언과 다르면 그 키를 버린다", () => {
  assert.deepEqual(normalizeShellPrefs({ [LIST]: { [K("a")]: "b" } }), {}, "A7 목록 자리에 객체가 왔는데 통과했다");
  assert.deepEqual(normalizeShellPrefs({ [MAP]: [K("a")] }), {}, "A11 짝 자리에 배열이 왔는데 통과했다");
  assert.deepEqual(normalizeShellPrefs({ [STR]: ["a"] }), {}, "A13 문자열 자리에 배열이 왔는데 통과했다");
});

test("★A8 짝의 «빈 문자열 값»은 남긴다 — 그건 뜻이 있는 값이다(#2110 치움 기준)", () => {
  // 치움은 «치울 때의 상태»를 함께 적어 두고 그 상태가 바뀌면 다시 올린다. 점이 없는 상태(대기·오프라인)로
  //  치운 행의 기준값은 `''` 다 — 실측에서 내 세션 284건 중 271건(95%)이 그 부류였다.
  //  이걸 «빈 값이니 버린다»로 뭉뚱그리면 그 행들은 다른 기기에서 **영영 안 치워진다**.
  assert.deepEqual(normalizeShellPrefs({ [MAP]: { "sess:box-1": "" } }), { [MAP]: { "sess:box-1": "" } },
    "치움 기준값 ''(점 없는 상태로 치웠다)가 버려졌다 — 그 행은 다른 기기에서 영영 안 치워진다");
});

test("A9 짝의 값이 문자열이 아니면 **그 항목만** 버린다", () => {
  assert.deepEqual(normalizeShellPrefs({ [MAP]: { [K("a")]: "waiting", [K("b")]: 3, [K("c")]: null, [K("d")]: "done" } }),
    { [MAP]: { [K("a")]: "waiting", [K("d")]: "done" } },
    "성한 항목까지 함께 버려졌거나 깨진 항목이 살아남았다");
});

test("A12 문자열 저장소는 그대로 담긴다", () => {
  assert.deepEqual(normalizeShellPrefs({ [STR]: "proj" }), { [STR]: "proj" });
});

test("A15·A16 상한 — 원소 수를 자르고, 긴 값은 자른다(화면 상태지 자료가 아니다)", () => {
  const many = Array.from({ length: 600 }, (_, i) => K(`k${i}`));
  const got = normalizeShellPrefs({ [LIST]: many })[LIST] as string[];
  assert.equal(got.length, 500, "A15 원소 수 상한(500)이 안 걸렸다 — 한 행이 무한정 커진다");

  const long = "x".repeat(1000);
  const mapVal = normalizeShellPrefs({ [MAP]: { "route:home": long } })[MAP] as Record<string, string>;
  assert.ok(mapVal["route:home"].length < long.length, "A16 짝의 긴 **값**이 안 잘렸다(값은 상태 이름이라 잘라도 된다)");
});

// ── B. 상한에 닿았을 때 무엇을 남기나 (#3887) ─────────────────────────────────
//  종전은 «들어온 순서대로 앞 500개» 였다. 화면은 새 결정을 **뒤에** 붙이므로 가득 찬 저장소에선 방금 누른 × 가
//   서버에서 버려졌고, 다음 부팅의 동기가 캐시를 서버판으로 덮어 그 결정이 사라졌다(실측: 치움 맵이 정확히 500).
//  행 번호는 스크래치패드 spec.md 엣지 표(E#).
const PIN = "lively_v2_app_pin";            // 행 키 목록(뒤가 새것)
const OPENED = "lively_v2_side_grpopened";  // 행 키 아닌 목록(뒤가 새것)
const DISMISS = "lively_v2_side_dismissed"; // 행 키 맵(뒤가 새것)
const RECENT = "lively_v2_recent_apps";     // 앞이 새것(화면이 맨 앞에 끼운다)
const RAIL = "lively_v2_rail_main";         // 앞이 윗자리(사람이 끌어 정한 자리)
const route = (i: number): string => `route:raw:projects2/p/${i}`;

test("★E1 뒤가 새것인 목록이 501개면 **첫 원소를 버리고 마지막(방금 붙인 것)을 남긴다** · overflow=1", () => {
  const input = Array.from({ length: 501 }, (_, i) => `p:${i}`);
  const { prefs, dropped } = normalizeShellPrefsReport({ [OPENED]: input });
  const got = prefs[OPENED] as string[];
  assert.equal(got.length, 500, "E1 500 으로 안 잘렸다");
  assert.ok(got.includes("p:500"), "★E1 방금 붙인 새 결정(p:500)이 버려졌다 — 가득 찬 계정에서 새로 누른 것이 새로고침하면 풀린다");
  assert.ok(!got.includes("p:0"), "E1 가장 오래된 것(p:0)이 남았다 — 오래된 쪽을 버려야 한다");
  assert.equal(got[0], "p:1", "E1 남긴 것의 순서가 들어온 순서가 아니다");
  assert.deepEqual(dropped, { [OPENED]: { overflow: 1 } }, "E1 버린 개수를 알리지 않았다 — 조용히 버리면 안 된다");
});

test("E2 정확히 500개면 아무것도 안 버리고 알림도 없다(경계)", () => {
  const input = Array.from({ length: 500 }, (_, i) => `p:${i}`);
  const { prefs, dropped } = normalizeShellPrefsReport({ [OPENED]: input });
  assert.deepEqual(prefs[OPENED], input, "E2 500개가 그대로 남지 않았다");
  assert.deepEqual(dropped, {}, "E2 버린 것이 없는데 알림이 났다");
});

test("★E3 치움 맵이 501항목이면 첫 항목을 버리고 마지막 항목을 남긴다 · overflow=1", () => {
  const input: Record<string, string> = {};
  for (let i = 0; i < 501; i++) input[route(i)] = "";
  const { prefs, dropped } = normalizeShellPrefsReport({ [DISMISS]: input });
  const got = prefs[DISMISS] as Record<string, string>;
  assert.equal(Object.keys(got).length, 500, "E3 500 으로 안 잘렸다");
  assert.ok(route(500) in got, "★E3 방금 치운 행이 버려졌다 — 새로 누른 × 가 새로고침하면 풀린다(#3846 D-4)");
  assert.ok(!(route(0) in got), "E3 가장 오래된 치움이 남았다");
  assert.equal(Object.keys(got)[0], route(1), "E3 남긴 항목의 순서가 들어온 순서가 아니다");
  assert.deepEqual(dropped, { [DISMISS]: { overflow: 1 } }, "E3 버린 개수를 알리지 않았다");
});

test("E4 치움 맵 500항목이면 전부 남고 알림이 없다(경계)", () => {
  const input: Record<string, string> = {};
  for (let i = 0; i < 500; i++) input[route(i)] = "";
  const { prefs, dropped } = normalizeShellPrefsReport({ [DISMISS]: input });
  assert.equal(Object.keys(prefs[DISMISS] as object).length, 500);
  assert.deepEqual(dropped, {}, "E4 버린 것이 없는데 알림이 났다");
});

test("E5·E6 앞이 새것·윗자리인 저장소는 넘치면 **뒤를** 버린다", () => {
  const input = Array.from({ length: 501 }, (_, i) => `app${i}`);
  const recent = normalizeShellPrefsReport({ [RECENT]: input });
  assert.equal((recent.prefs[RECENT] as string[])[0], "app0", "E5 최근 앱의 맨 앞(방금 연 앱)이 버려졌다");
  assert.ok(!(recent.prefs[RECENT] as string[]).includes("app500"), "E5 최근 앱에서 가장 오래된 끝이 남았다");
  assert.deepEqual(recent.dropped, { [RECENT]: { overflow: 1 } });
  const rail = normalizeShellPrefsReport({ [RAIL]: input });
  assert.equal((rail.prefs[RAIL] as string[])[0], "app0", "E6 레일 윗자리가 버려졌다");
});

test("E7 중복은 넘침이 아니다 — 접은 뒤 500 이면 아무것도 안 버린다", () => {
  const input = [...Array.from({ length: 500 }, (_, i) => `p:${i}`), "p:7"];
  const { prefs, dropped } = normalizeShellPrefsReport({ [OPENED]: input });
  assert.equal((prefs[OPENED] as string[]).length, 500);
  assert.ok((prefs[OPENED] as string[]).includes("p:0"), "E7 중복 하나 때문에 멀쩡한 첫 원소가 버려졌다");
  assert.deepEqual(dropped, {}, "E7 중복을 넘침으로 셌다");
});

// ── V. 행 키 형식 (#3887) ────────────────────────────────────────────────────
//  행 키는 임의의 주소에서 만들어진다(main.ts sideRowKey). 실측(2026-09-10, 상민님 계정): 치움 맵에
//   `sess:box-…](https:`(마크다운 링크 찌꺼기) · `route:raw:activate?code=…`(일회용 승인 코드) 가 있었다.
test("★E8·E9 깨진 행 키와 자격이 든 화면 키는 저장하지 않고 invalid 로 센다", () => {
  const junk = ["sess:box-sangmin-yoon-df087301](https:", "route:raw:activate?code=ABCD-1234"];
  for (const k of junk) assert.equal(isShellRowKey(k), false, `E8·E9 «${k}» 를 행 키로 받았다`);
  const { prefs, dropped } = normalizeShellPrefsReport({
    [PIN]: [...junk, "sess:box-a"],
    [DISMISS]: { [junk[0]]: "", [junk[1]]: "", "route:home": "" },
  });
  assert.deepEqual(prefs[PIN], ["sess:box-a"], "E8 목록에 쓰레기 키가 남았다");
  assert.deepEqual(prefs[DISMISS], { "route:home": "" }, "E9 맵에 쓰레기 키가 남았다");
  assert.deepEqual(dropped, { [PIN]: { invalid: 2 }, [DISMISS]: { invalid: 2 } }, "E8·E9 버린 개수를 알리지 않았다");
  for (const bad of ["route:raw:connect?state=x&code=y", "route:raw:login?TOKEN=z", "route:raw:x?access_token=q"]) {
    assert.equal(isShellRowKey(bad), false, `E9 자격 쿼리 «${bad}» 를 받았다`);
  }
});

test("★E10 멀쩡한 행 키는 전부 남는다 — 조회도 이 정규화를 거치므로 오탐 하나가 사람의 결정을 영구히 지운다", () => {
  //  실측 모양(상민님 계정 2026-09-11) + 화면이 만드는 쿼리 주소(side.ts·ctx-shell.ts·sharelink.ts·views.ts).
  const good = [
    "sess:box-sangmin-yoon-48be0942", "sess:3f2b8c1e-9a7d-4e21-b0c3-5d6e7f809a1b",
    "inst:7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "route:home", "route:sources", "route:p:2600", "route:app:terminal",
    "route:raw:projects2/p/2187", "route:raw:projects2/t/3696", "route:raw:projects2/l/57", "route:raw:system/members",
    "route:raw:inbox", "route:raw:login", "route:raw:welcome?resume=1",
    "route:raw:knowledge?category=12", "route:raw:knowledge?indexed=1",
    "route:raw:f?root=%2Fwork&path=docs%2Freport%20(final).pdf",
    "route:raw:knowledge/런북-dev-8080-게이트웨이", "route:raw:knowledge/%EB%9F%B0%EB%B6%81",
  ];
  for (const k of good) assert.equal(isShellRowKey(k), true, `★E10 멀쩡한 행 키 «${k}» 를 버렸다`);
  const map = Object.fromEntries(good.map((k) => [k, ""]));
  const { prefs, dropped } = normalizeShellPrefsReport({ [PIN]: good, [DISMISS]: map });
  assert.deepEqual(prefs[PIN], good, "E10 목록에서 멀쩡한 키가 빠졌다");
  assert.deepEqual(prefs[DISMISS], map, "E10 맵에서 멀쩡한 키가 빠졌다");
  assert.deepEqual(dropped, {}, "E10 멀쩡한 키를 버렸다고 알렸다");
});

test("E11 접두사가 없거나 몸이 빈 행 키는 버린다", () => {
  for (const k of ["foo", "sess:", "inst:", "route:", "app:terminal", "p:12"]) {
    assert.equal(isShellRowKey(k), false, `E11 «${k}» 를 행 키로 받았다`);
  }
  //  화면 키에 들어올 수 없는 글자 — 공백·제어문자·encodeURIComponent 가 늘 이스케이프하는 글자.
  const ctl = String.fromCharCode(0);
  for (const k of ["route:raw:a b", `route:raw:a${ctl}b`, "route:raw:<script>", "route:raw:x]", "sess:box a", "inst:a/b"]) {
    assert.equal(isShellRowKey(k), false, `E11 «${JSON.stringify(k)}» 를 행 키로 받았다`);
  }
});

test("E12 행 키가 아닌 저장소엔 행 키 자를 대지 않는다(쓰레기 입구가 없고, 잘못 대면 멀쩡한 결정이 지워진다)", () => {
  const odd = ["p:3537", "12", "home", "x](y"];
  const { prefs, dropped } = normalizeShellPrefsReport({ [OPENED]: odd, lively_v2_proj_fold_closed: ["12"], [RAIL]: ["home"] });
  assert.deepEqual(prefs[OPENED], odd, "E12 행 키 아닌 저장소에서 원소가 빠졌다");
  assert.deepEqual(prefs.lively_v2_proj_fold_closed, ["12"], "E12 폴더 id 가 빠졌다");
  assert.deepEqual(prefs[RAIL], ["home"], "E12 앱 키가 빠졌다");
  assert.deepEqual(dropped, {});
});

test("★E13·E14 200자를 넘는 원소는 **잘린 사본이 아니라 없음** · 정확히 200자는 남는다(경계)", () => {
  //  ⚠ 두 값의 앞 200자가 **달라야** 한다 — 같으면 잘린 201자가 200자와 한 원소로 접혀 «잘렸다» 가 안 보인다(1차에 그렇게 vacuous 였다).
  const k200 = "p:" + "9".repeat(198);
  const k201 = "p:" + "8".repeat(199);
  const { prefs, dropped } = normalizeShellPrefsReport({ [OPENED]: [k200, k201] });
  assert.deepEqual(prefs[OPENED], [k200], "E13·E14 — 201자는 없어야 하고(잘린 키는 아무것도 가리키지 않는다) 200자는 남아야 한다");
  assert.deepEqual(dropped, { [OPENED]: { invalid: 1 } }, "E13 긴 원소를 버린 개수를 알리지 않았다");
  const longKey = "route:raw:" + "a".repeat(191);
  assert.deepEqual(normalizeShellPrefs({ [DISMISS]: { [longKey]: "" } }), {}, "E13 맵의 201자 키가 잘려서 남았다");
});

test("★E15 조회 경로(저장된 문서 → 정규화)에서도 쓰레기 키는 내려가지 않는다 — 이미 쌓인 계정의 정리", () => {
  const stored = { [DISMISS]: { "route:raw:activate?code=ZZZZ-0000": "", "route:home": "" }, [PIN]: ["sess:box-1](https:", "sess:box-1"] };
  assert.deepEqual(normalizeShellPrefs(fromStoredShellPrefs(stored)), { [DISMISS]: { "route:home": "" }, [PIN]: ["sess:box-1"] },
    "E15 저장돼 있던 쓰레기 키가 조회로 다시 내려간다");
});

test("★O1 맵의 항목 순서는 저장 칸(~order)으로 되살린다 — jsonb 는 객체 키를 길이·바이트순으로 다시 늘어놓는다", () => {
  //  jsonb 가 돌려주는 모양을 흉내 낸다: 짧은 키가 앞. 실제 순서(치운 순서)는 긴 키가 먼저였다.
  const stored = { [DISMISS]: { "route:sources": "", "route:raw:projects2/p/1": "" }, [`~order:${DISMISS}`]: ["route:raw:projects2/p/1", "route:sources"] };
  assert.deepEqual(Object.keys(fromStoredShellPrefs(stored)[DISMISS] as object), ["route:raw:projects2/p/1", "route:sources"],
    "★O1 저장된 순서로 되살리지 않았다 — 넘칠 때 «오래된 것» 이 아니라 «짧은 키» 가 먼저 나간다");
  //  순서 칸에 없는 키(순서 칸을 모르는 서버가 쓴 것)는 앞(더 오래된 쪽), 순서 칸의 유령 키는 무시.
  const mixed = { [DISMISS]: { "route:a": "", "route:b": "", "route:c": "" }, [`~order:${DISMISS}`]: ["route:c", "route:gone", "route:a"] };
  assert.deepEqual(Object.keys(fromStoredShellPrefs(mixed)[DISMISS] as object), ["route:b", "route:c", "route:a"],
    "O1 순서 칸에 없는 키를 앞에 두지 않았거나 유령 키를 만들었다");
  assert.equal(`~order:${DISMISS}` in normalizeShellPrefs(fromStoredShellPrefs(stored)), false, "O1 저장 전용 칸이 응답에 새어 나갔다");
});

test("A18 왕복이 안정적이다(정규화 결과를 다시 정규화해도 같다)", () => {
  const once = normalizeShellPrefs({
    [LIST]: [K("a"), K("b"), K("a"), 3], [MAP]: { [K("x")]: "", [K("y")]: 1 }, [STR]: "proj", nope: ["q"],
  });
  assert.deepEqual(normalizeShellPrefs(once), once,
    "멱등이 아니다 — 조회 때 한 번 더 도는 정규화가 저장된 값을 바꾼다");
});

// ── C. seam — 서버 표 ↔ 화면 선언 ───────────────────────────────────────────
//  화면은 저장소를 두 가지로 선언한다: shellPrefStore(base, kind) = 서버가 정본 ·
//  deviceStore(base) = 이 기기가 정본. 앞의 것만 서버 표에 있어야 한다.
function scanWebDeclarations(): { synced: Map<string, string>; device: Set<string> } {
  const dir = path.join(ROOT, "web");
  const synced = new Map<string, string>();
  const device = new Set<string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, name.name);
      if (name.isDirectory()) { if (name.name !== "node_modules") walk(p); continue; }
      if (!name.name.endsWith(".ts")) continue;
      const src = readFileSync(p, "utf8");
      for (const m of src.matchAll(/\bshellPrefStore\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)) synced.set(m[1], m[2]);
      for (const m of src.matchAll(/\bdeviceStore\(\s*'([^']+)'\s*\)/g)) device.add(m[1]);
    }
  };
  walk(dir);
  return { synced, device };
}

test("★C1·C2 화면이 «서버가 정본»이라 선언한 저장소와 서버 허용목록이 정확히 같다", () => {
  const { synced } = scanWebDeclarations();
  assert.ok(synced.size > 0, "화면에서 shellPrefStore 선언을 하나도 못 찾았다 — 스캐너가 죽었으면 이 테스트는 아무것도 안 본다");
  assert.deepEqual([...synced.keys()].sort(), Object.keys(SHELL_PREF_STORES).sort(),
    "★한쪽에만 있는 저장소가 있다 — 서버에만 있으면 죽은 칸이고, 화면에만 있으면 사람이 정한 것이 **저장되는 줄 알았는데 매번 버려진다**(에러도 안 난다)");
  const kindBad: string[] = [];
  for (const [k, kind] of synced) if (SHELL_PREF_STORES[k] !== kind) kindBad.push(`${k}: 화면 '${kind}' ≠ 서버 '${SHELL_PREF_STORES[k]}'`);
  assert.deepEqual(kindBad, [], "C2 모양이 어긋난다 — 서버가 그 값을 통째로 버린다");
});

test("C3 «이 기기가 정본»인 저장소는 서버 표에 없다", () => {
  const { device } = scanWebDeclarations();
  assert.ok(device.size > 0, "deviceStore 선언을 하나도 못 찾았다(스캐너 배선 확인)");
  const leaked = [...device].filter((k) => k in SHELL_PREF_STORES);
  assert.deepEqual(leaked, [], "기기의 것(열린 창·캐시)이 서버 표에 있다 — 다른 기기의 창이 이 화면에 되살아난다");
});

// 이 브라우저에 남은 기억은 **누구 것인가** (#2460).
//
// #1875 는 브라우저 기억을 워크스페이스로 갈랐다(net.ts wsKey). 축이 하나 더 있었다 — **사람**.
//  로그아웃은 토큰만 지우므로(core.ts logout), 같은 브라우저에서 계정이 바뀌면 앞사람의 열린 창이
//  그대로 사이드바에 서고(sideInstances ③ 은 force=true 라 서버를 안 본다), 캐시된 **세션 제목**까지
//  보인다. 워크스페이스 누수보다 나쁘다 — 그건 내 다른 워크스페이스지만 이건 남의 것이다.
//
// 이 파일이 지키는 것 셋:
//  ① **폴라리티** — «남길 것만 적는다». 지울 목록으로 짜면 저장소가 하나 늘 때마다 그게 곧 누수다.
//     그래서 «아직 존재하지 않는 이름도 지운다»를 값으로 못박는다(B8).
//  ② **첫 로그인은 안 지운다**(B1) — 지금까지 쓰던 사람의 기억이고, 그게 #1875 가 지킨 무회귀다.
//  ③ **토큰과 도장은 살아남는다**(B4·B5) — 토큰을 지우면 방금 로그인한 사람이 그 자리에서 튕기고,
//     도장을 지우면 매 부팅이 «주인이 바뀌었다»가 되어 영원히 지우는 화면이 된다.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// net.ts 는 모듈 본문에서 location.pathname 을 읽는다(API_PREFIX) — leaf 라 브라우저 의존은 그것뿐이다.
globalThis.location = { pathname: "/ui/", search: "", hash: "" };

let store = {};
let throwOnAccess = false;
const raw = {
  getItem: (k) => { if (throwOnAccess) throw new Error("private mode"); return k in store ? store[k] : null; },
  setItem: (k, v) => { if (throwOnAccess) throw new Error("private mode"); store[k] = String(v); },
  removeItem: (k) => { if (throwOnAccess) throw new Error("private mode"); delete store[k]; },
};
// 브라우저에서 Object.keys(localStorage) 는 저장된 칸 이름을 준다 — 스텁도 그렇게 보이게 한다.
globalThis.localStorage = new Proxy(raw, {
  ownKeys: () => Object.keys(store),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: undefined }),
});

const { claimLocalOwner, keepAcrossOwner, OWNER_KEY } =
  await import(join(root, "public/app/lib/local-owner.js"));

let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };
const eq = (got, want, name) => {
  assert.deepEqual(got, want, `${name}: ${JSON.stringify(want)} 여야 하는데 ${JSON.stringify(got)}`);
  pass++; console.log(`ok  ${name}`);
};

// ── 배선 확인 — 스텁이 죽어 있으면 아래가 전부 vacuous 다 ────────────────────
store = { probe: "1" };
eq(Object.keys(globalThis.localStorage), ["probe"], "배선: Object.keys(localStorage) 가 저장된 칸을 준다");
eq(globalThis.localStorage.getItem("probe"), "1", "배선: getItem 이 스텁에 닿는다");

// ── B5·B9 남길 것 / B7·B8 지울 것 — 순수 판정 ───────────────────────────────
const KEEP = ["lively_ui_token", OWNER_KEY, "lv:theme", "lv:theme-harness", "lv:theme-open-tabs",
  "lively_chat_fontsize", "lively_ui_mode", "lively_ui_mode_swept", "dash-aside-w", "pjv:sideW", "pjv:tmSideW",
  "lively_v2_split_side-nav", "lively_v2_split_panes_side"];
for (const k of KEEP) ok(keepAcrossOwner(k), `K '${k}' 는 이 창의 겉모습이라 사람이 바뀌어도 남는다`);

const DROP = ["lively_v2_tabs", "lively_v2_sess_names", "lively_v2_app_pin", "lively_v2_side_dismissed",
  "lively_v2_recent_apps", "lively_v2_last_ask", "lively_v2_rail_main", "lively_v2_home_route",
  "lively.workspace", "dash_ov_pinned_v1", "pjv:sideOpen", "lively_term_projtree_v1"];
for (const k of DROP) ok(!keepAcrossOwner(k), `D '${k}' 는 앞사람의 내용일 수 있어 지운다`);

ok(!keepAcrossOwner("lively_v2_tabs@ws-a7c2f76f"),
  "B7 워크스페이스 접미사가 붙은 키도 지운다 — 그게 실제로 저장되는 이름이다");
ok(!keepAcrossOwner("lively_v2_some_store_added_next_year"),
  "★B8 **모르는 키는 지운다** — 지울 목록으로 짰다면 나중에 늘어난 저장소가 곧 누수가 된다");

// ── B1~B6 주인 주장 — 엣지 표(입력 [도장, 로그인한 사람] × 기대) ─────────────
const seed = () => {
  store = {
    lively_ui_token: "tok-new",
    "lv:theme": "dark",
    "lively_v2_split_side-nav": "260",
    lively_v2_tabs: '[{"route":"#/s/box-yoon-1"}]',
    "lively_v2_tabs@ws-a7c2f76f": '[{"route":"#/s/box-yoon-2"}]',
    lively_v2_sess_names: '{"box-yoon-1":"머지 및 데브 반영"}',
    lively_v2_app_pin: '["sess:box-yoon-1"]',
  };
};

// B1 첫 로그인 — 도장이 없다. 지금까지 쓰던 사람의 기억이므로 **지우지 않는다**(무회귀).
seed();
eq(claimLocalOwner("yoon"), false, "B1 첫 로그인은 지우지 않는다(도장만 찍는다)");
eq(store.lively_v2_tabs, '[{"route":"#/s/box-yoon-1"}]', "B1 열린 창이 그대로 있다");
eq(store[OWNER_KEY], "yoon", "B1 도장이 찍혔다");

// B2 같은 사람 — 아무 일도 없다.
eq(claimLocalOwner("yoon"), false, "B2 같은 사람이면 아무것도 안 한다");
eq(store.lively_v2_sess_names, '{"box-yoon-1":"머지 및 데브 반영"}', "B2 기억이 그대로다");

// B3~B5 사람이 바뀌었다 — 내용은 지우고 겉모습·토큰·도장은 남긴다.
eq(claimLocalOwner("jang"), true, "★B3 사람이 바뀌면 true(호출부가 그 신호로 새로고침한다)");
eq(store.lively_v2_tabs, undefined, "★B3 앞사람의 열린 창이 지워졌다 — 이게 신고의 실제 증상이다");
eq(store["lively_v2_tabs@ws-a7c2f76f"], undefined, "★B7 워크스페이스 접미사가 붙은 것도 함께 지워졌다");
eq(store.lively_v2_sess_names, undefined, "★B3 앞사람의 **세션 제목 캐시**가 지워졌다");
eq(store.lively_v2_app_pin, undefined, "B3 앞사람의 고정이 지워졌다");
eq(store.lively_ui_token, "tok-new", "★B4 토큰은 남는다 — 지우면 방금 로그인한 사람이 그 자리에서 튕긴다");
eq(store["lv:theme"], "dark", "B3 테마는 이 창의 겉모습이라 남는다");
eq(store["lively_v2_split_side-nav"], "260", "B9 폭도 남는다");
eq(store[OWNER_KEY], "jang", "★B5 도장이 새 사람으로 갱신됐다(안 남기면 매 부팅이 '바뀌었다'가 된다)");

// 바로 다음 부팅은 조용해야 한다 — 지운 뒤 도장을 안 찍었으면 여기서 true 가 또 나온다(무한 새로고침).
eq(claimLocalOwner("jang"), false, "★B5b 지운 직후 다시 부팅해도 조용하다(새로고침 루프가 안 난다)");

// B6 빈 id — 아무것도 하지 않는다.
eq(claimLocalOwner(""), false, "B6 빈 사용자 id 는 무시한다");
eq(store[OWNER_KEY], "jang", "B6 도장이 그대로다");

// B10 프라이빗 모드 — 저장소 접근이 던져도 예외를 내지 않는다(화면이 죽으면 안 된다).
throwOnAccess = true;
eq(claimLocalOwner("someone"), false, "B10 저장소를 못 읽는 문맥에서도 조용히 false(예외 없음)");
throwOnAccess = false;

console.log(`\n${pass} passed`);

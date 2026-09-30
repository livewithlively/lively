// #3870 — 초대받은 사람에게도 [세션 옮기기]·[세션 복제]가 선다 (원준 2026-09-30: «세션에 초대받은 다른 사람은 왜 세션 복제·
//  세션 옮기기 버튼이 안 보임?» → «둘 다 되게 해봐»).
//
// 화면의 단추 판정 셋(문패 [세션 옮기기] · 우클릭 「프로젝트 바꾸기·떼기」 · [⋯ ▸ 이 세션 ▸ 프로젝트])은 한 술어
//  canMoveSess 를, [세션 복제](문패·우클릭)는 canForkSess 를 쓴다. 이 파일은 **컴파일된 모듈을 실제로 불러** 두 술어를 잰다.
//   🔴 초대를 안 보면 — 초대받은 사람에게 단추가 안 선다(신고 그 자체).
//   🔴 owned 로 재면 — 관리자(초대 안 받음)에게도 서서, 누르면 반드시 403 인 단추가 된다(ctx-shell 머리말의 스테이지 실측).
//   🔴 초대만 보면 — 끝난 세션·앱 세션·복제 수단 없는 AI 에도 복제 단추가 선다.
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const eq = (got, want, name) => { assert.deepEqual(got, want, `${name}: ${JSON.stringify(want)} 여야 하는데 ${JSON.stringify(got)}`); pass++; console.log(`ok  ${name}`); };

// ── 가짜 브라우저(모듈 최상위가 닿는 만큼만) ──
const noop = () => {};
globalThis.window = globalThis;
globalThis.addEventListener = noop; globalThis.removeEventListener = noop;
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
globalThis.sessionStorage = globalThis.localStorage;
const node = () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, setAttribute: noop, appendChild: noop, addEventListener: noop });
globalThis.document = { addEventListener: noop, createElement: node, documentElement: node(), body: node(), querySelector: () => null, querySelectorAll: () => [] };
globalThis.location = { hash: "", pathname: "/ui/", search: "", origin: "http://x" };
globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });

const imp = (p) => import(pathToFileURL(join(root, p)).href);
const { state } = await imp("public/app/lib/state.js");
const views = await imp("public/app/v2/views.js");
const ctx = await imp("public/app/v2/ctx-shell.js");
state.me = { userId: "yoon" };

// 세션 한 줄 — 목록이 주는 모양(owned 는 서버 판정 · raw 는 원본 행).
const sess = (o = {}) => ({
  id: "box-jang-1", live: true, alive: true, owned: false, trashedAt: null, stateKey: "idle",
  raw: { owner: "jang", invites: ["yoon"], harness: "claude", ...(o.raw || {}) }, ...o, ...(o.raw ? { raw: { owner: "jang", invites: ["yoon"], harness: "claude", ...o.raw } } : {}),
});

// ── 옮기기(canMoveSess) ──
eq(views.canMoveSess(sess()), true, "①★초대받은 사람에게 [세션 옮기기]가 선다");
eq(views.canMoveSess(sess({ raw: { invites: [] } })), false, "①초대받지 않은 남에겐 안 선다");
eq(views.canMoveSess(sess({ owned: true, raw: { owner: "yoon", invites: [] } })), true, "①주인은 종전대로");
eq(views.isInvitedSess(sess({ owned: true, raw: { owner: "yoon", invites: ["yoon"] } })), false, "①주인은 «초대받은 사람» 이 아니다 — 복제 창의 안내가 주인에게 안 뜬다");

// ── 복제(canForkSess) ──
eq(ctx.canForkSess(sess()), true, "②★초대받은 사람에게 [세션 복제]가 선다");
eq(ctx.canForkSess(sess({ owned: true, raw: { invites: [] } })), false,
  "②★관리자(owned 참)라도 초대받지 않았으면 안 선다 — 누르면 반드시 거절되는 단추");
eq(ctx.canForkSess(sess({ live: true, alive: false })), false, "②초대받았어도 끝난 세션엔 안 선다(«이어서 열기» 가 먼저)");
eq(ctx.canForkSess(sess({ raw: { appId: "writer" } })), false, "②초대받았어도 앱 세션엔 안 선다");
eq(ctx.canForkSess(sess({ raw: { harness: "grok" } })), false, "②초대받았어도 복제 수단이 없는 AI 엔 안 선다");

console.log(`\n${pass} passed`);
process.exit(0);

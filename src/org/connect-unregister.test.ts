// 앱 등록 바꾸기·지우기 — 지울 칸 · 구성원 연결 세기 · 끊기는 것 문장 · 화면에 보일지(org/connect-unregister.ts, #4991).
//  실행: npm run build && node dist/org/connect-unregister.test.js
//  사양 표(A·B·C·E) — 행마다 시험 하나. 문장은 사람에게 하는 말이라 «무슨 사실을 말하나»(수 · 이름 · 끊기나/그대로인가)만 본다.
import assert from "node:assert/strict";
import {
  APP_LINKS, REGISTRATION_SLOTS, RELAY_ENV, expiringRow, memberLinks, registrationEditable, registrationImpact, type RegistrationLinks,
} from "./connect-unregister.js";
import { GOOGLE_CLIENT_KINDS } from "./credentials/google-token-source.js";
import { GITHUB_APP_KIND, GITHUB_APP_KEY_SCOPE, GITHUB_INSTALL_KIND } from "./credentials/github-app.js";
import { NOTION_PUBLIC_KIND } from "./credentials/notion-oauth.js";
import { SLACK_BOT_KIND } from "./credentials/slack-oauth.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const APPS = ["slack", "notion", "google", "linear", "outlook", "github"];
const L = (o: Partial<RegistrationLinks> = {}): RegistrationLinks => ({ members: { total: 0, expiring: 0 }, places: [], collecting: false, envFallback: false, ...o });
const has = (lines: string[], re: RegExp): boolean => lines.some((l) => re.test(l));
const row = (owner: string, meta: Record<string, unknown> = {}, has_secret = true) => ({ owner, has_secret, meta });

// ── A. 지우는 칸 ──
t("A2 구글 — 준비 판정이 읽는 client 칸(통합 + 옛 kind 셋) 전부를 지운다", () => {
  const kinds = REGISTRATION_SLOTS.google!.map((s) => s.kind).sort();
  assert.deepEqual(kinds, [...GOOGLE_CLIENT_KINDS].sort());
  assert.ok(REGISTRATION_SLOTS.google!.every((s) => s.scope_key === "oauth:client"));
});
t("A2 깃허브 — client 칸과 앱 키 칸 둘 다", () => {
  assert.deepEqual(REGISTRATION_SLOTS.github, [{ kind: GITHUB_APP_KIND, scope_key: "oauth:client" }, { kind: GITHUB_APP_KIND, scope_key: GITHUB_APP_KEY_SCOPE }]);
});
t("A3 연결 칸(구성원 · 노션 워크스페이스 · 슬랙 봇 · 깃허브 설치)은 지우는 칸이 아니다 — 등록 칸(oauth:client · app:key)만", () => {
  for (const app of APPS) {
    for (const s of REGISTRATION_SLOTS[app]!) assert.ok(s.scope_key === "oauth:client" || s.scope_key === GITHUB_APP_KEY_SCOPE, `${app}: ${s.kind}/${s.scope_key}`);
    const placeKind = APP_LINKS[app]!.place?.kind;
    if (placeKind && placeKind !== NOTION_PUBLIC_KIND) assert.ok(!REGISTRATION_SLOTS[app]!.some((s) => s.kind === placeKind), `${app}: 조직 자리 칸(${placeKind})을 지운다`);
  }
  assert.ok([SLACK_BOT_KIND, GITHUB_INSTALL_KIND].every((k) => !Object.values(REGISTRATION_SLOTS).flat().some((s) => s.kind === k)));
  assert.deepEqual(Object.keys(REGISTRATION_SLOTS).sort(), [...APPS].sort(), "앱 여섯");
  assert.deepEqual(Object.keys(APP_LINKS).sort(), [...APPS].sort());
  assert.deepEqual(Object.keys(RELAY_ENV).sort(), [...APPS].sort());
});

// ── B. 구성원 연결 세기 ──
t("B1 한 사람의 칸 둘 → 1명", () => {
  assert.deepEqual(memberLinks([row("member:a"), row("member:a")]), { total: 1, expiring: 0 });
});
t("B2 조직 칸(owner=gateway)은 세지 않는다", () => {
  assert.deepEqual(memberLinks([row("gateway"), row("member:a")]), { total: 1, expiring: 0 });
});
t("B3 비밀 없는 칸은 세지 않는다", () => {
  assert.deepEqual(memberLinks([row("member:a", {}, false)]), { total: 0, expiring: 0 });
});
t("B4 한 사람의 칸 중 하나만 기한 있음 → 그 사람은 기한 있음", () => {
  assert.deepEqual(memberLinks([row("member:a"), row("member:a", { expires_at: 1790000000 }), row("member:b")]), { total: 2, expiring: 1 });
});
t("B5 expires_at 숫자 · 숫자 문자열 → 기한 있음", () => {
  assert.equal(expiringRow({ meta: { expires_at: 1790000000 } }), true);
  assert.equal(expiringRow({ meta: { expires_at: "1790000000" } }), true);
});
t("B5' expires_at 빈 문자열 · 없음 · 숫자 아닌 글 · meta 없음 → 기한 없음", () => {
  assert.equal(expiringRow({ meta: { expires_at: "" } }), false);
  assert.equal(expiringRow({ meta: {} }), false);
  assert.equal(expiringRow({ meta: { expires_at: "soon" } }), false);
  assert.equal(expiringRow({ meta: null }), false);
});
t("B6 빈 목록 → 0명 · 0명", () => {
  assert.deepEqual(memberLinks([]), { total: 0, expiring: 0 });
});
t("B7 owner 가 접두사만 닮음(membership:x) → 세지 않는다", () => {
  assert.deepEqual(memberLinks([row("membership:x"), row("Member:y")]), { total: 0, expiring: 0 });
});

// ── C. 끊기는 것 문장 ──
t("C1 서버 설정 앱 없음 → 지우기 첫 문장: 라이블리 앱으로는 새로 연결·다시 연결 못 함(다른 길까지 막힌다고 말하지 않는다)", () => {
  const r = registrationImpact("linear", "리니어", L());
  assert.match(r.remove[0]!, /^라이블리 앱으로는 아무도 새로 연결하거나 다시 연결할 수 없어요/);
});
t("C14 지운 값은 되살릴 수 없다 — 지우기에만, 서버 설정 앱이 있어도", () => {
  for (const envFallback of [false, true]) {
    const r = registrationImpact("google", "구글", L({ envFallback }));
    assert.ok(has(r.remove, /되살릴 수 없어요/), `envFallback=${envFallback}: ${r.remove.join(" / ")}`);
    assert.ok(!has(r.replace, /되살릴 수 없어요/), "바꾸기에는 없다");
  }
});
t("C2 서버 설정 앱 있음 → 첫 문장이 서버 설정 값으로 연결 · «아무도 … 없다» 는 없다", () => {
  const r = registrationImpact("google", "구글", L({ envFallback: true, members: { total: 2, expiring: 2 } }));
  assert.match(r.remove[0]!, /서버 설정\(환경 변수\)/);
  assert.ok(!has(r.remove, /새로 연결하거나 다시 연결할 수 없어요/), r.remove.join(" / "));
});
t("C3 기한 있는 구성원 e명 → 지우기 «e명 … 끊겨요» · 바꾸기 «e명 … 다시 연결»", () => {
  const r = registrationImpact("google", "구글", L({ members: { total: 3, expiring: 3 } }));
  assert.ok(has(r.remove, /구성원 3명.*기한이 지나면 끊겨요/), r.remove.join(" / "));
  assert.ok(has(r.replace, /구성원 3명.*새 앱으로 다시 연결/), r.replace.join(" / "));
  assert.ok(!has(r.remove, /그대로 쓰여요/), "기한 있는 연결만 있으면 «그대로» 줄이 없다");
});
t("C4 기한 없는 구성원 k명 → 지우기 «k명 … 그대로» · 바꾸기 «k명 … 옛 앱으로 계속 … 지우고 다시 연결»", () => {
  const r = registrationImpact("slack", "슬랙", L({ members: { total: 2, expiring: 0 } }));
  assert.ok(has(r.remove, /구성원 2명.*그대로 쓰여요/), r.remove.join(" / "));
  assert.ok(has(r.replace, /구성원 2명.*옛 앱으로 계속.*지우고 다시 연결/), r.replace.join(" / "));
  assert.ok(!has(r.remove, /끊겨요 — 라이블리가/), "기한 없는 연결을 끊긴다고 말하지 않는다");
});
t("C3+C4 섞임 → 기한 있는 1명 · 그대로 2명을 따로 말한다", () => {
  const r = registrationImpact("linear", "리니어", L({ members: { total: 3, expiring: 1 } }));
  assert.ok(has(r.remove, /구성원 1명.*끊겨요/) && has(r.remove, /구성원 2명.*그대로/), r.remove.join(" / "));
});
t("C5 노션 워크스페이스 → 이름 · 연결은 그대로 · [연결 끊기] / 바꾸기 옛 통합 · [페이지 더 고르기]", () => {
  const r = registrationImpact("notion", "노션", L({ places: [{ id: "a1b2c3d4-0000", name: "위시스트" }, { id: "e5f6a7b8-0000", name: "디자인" }] }));
  assert.ok(has(r.remove, /노션 워크스페이스 2곳\(위시스트, 디자인\).*그대로예요.*\[연결 끊기\]/), r.remove.join(" / "));
  assert.ok(has(r.replace, /2곳\(위시스트, 디자인\).*옛 통합.*\[페이지 더 고르기\]/), r.replace.join(" / "));
});
t("C6 이름 4곳 이상 → 셋까지 + 외 N곳 · 이름 없으면 id 앞 8자", () => {
  const places = [{ id: "11111111-x", name: "가" }, { id: "22222222-x", name: null }, { id: "33333333-x", name: " " }, { id: "44444444-x", name: "라" }, { id: "55555555-x", name: "마" }];
  const r = registrationImpact("notion", "노션", L({ places }));
  assert.ok(has(r.remove, /5곳\(가, 22222222, 33333333 외 2곳\)/), r.remove.join(" / "));
});
t("C7 슬랙 봇 n곳 → 지우기 그대로 · 바꾸기 옛 앱으로 계속", () => {
  const r = registrationImpact("slack", "슬랙", L({ places: [{ id: "T1", name: "acme" }] }));
  assert.ok(has(r.remove, /슬랙 봇\(워크스페이스 1곳\).*그대로예요/), r.remove.join(" / "));
  assert.ok(has(r.replace, /슬랙 봇\(워크스페이스 1곳\).*옛 앱으로 계속/), r.replace.join(" / "));
});
t("C8 깃허브 설치 n곳 → 지우기 바로 끊겨요 · 바꾸기 다시 설치", () => {
  const r = registrationImpact("github", "깃허브", L({ places: [{ id: "123", name: null }, { id: "456", name: null }] }));
  assert.ok(has(r.remove, /설치 2곳.*바로 끊겨요/), r.remove.join(" / "));
  assert.ok(has(r.replace, /설치 2곳.*다시 설치/), r.replace.join(" / "));
});
t("C9 모으는 중 + 기한 있는 연결 → 두 쪽 다 «자료 가져오기 … 멈춰요»", () => {
  const r = registrationImpact("outlook", "아웃룩", L({ collecting: true, members: { total: 1, expiring: 1 } }));
  assert.ok(has(r.remove, /자료 가져오기.*멈춰요/) && has(r.replace, /자료 가져오기.*멈춰요/), r.remove.join(" / "));
});
t("C9' 모으는 중이어도 기한 있는 연결이 없으면(노션 워크스페이스) «멈춰요» 를 말하지 않는다", () => {
  const r = registrationImpact("notion", "노션", L({ collecting: true, places: [{ id: "w1", name: "위시스트" }] }));
  assert.ok(!has(r.remove, /자료 가져오기.*멈춰요/) && !has(r.replace, /자료 가져오기.*멈춰요/), r.remove.join(" / "));
});
t("C10 연결 없음 → 지우기 «아직 없어요» · 바꾸기는 «새 앱으로 연결돼요» 한 줄", () => {
  const r = registrationImpact("linear", "리니어", L());
  assert.ok(has(r.remove, /아직 없어요/));
  assert.deepEqual(r.replace, ["그 뒤로 연결하는 사람은 새 앱으로 연결돼요."]);
});
t("C11 0명·0곳 줄을 만들지 않는다 · 연결이 있으면 «아직 없어요» 도 없다", () => {
  const r = registrationImpact("slack", "슬랙", L({ members: { total: 1, expiring: 0 } }));
  assert.ok(![...r.remove, ...r.replace].some((l) => /\b0명|\b0곳|\(\)/.test(l)), [...r.remove, ...r.replace].join(" / "));
  assert.ok(!has(r.remove, /아직 없어요/));
});
t("C12 모든 조합 — 문장에 undefined · null · NaN 이 없고 바꾸기 첫 줄은 늘 같다", () => {
  let n = 0;
  for (const app of APPS) for (const total of [0, 1, 3]) for (const expiring of [0, 1, 3]) for (const np of [0, 1, 4])
    for (const collecting of [false, true]) for (const envFallback of [false, true]) {
      const places = Array.from({ length: np }, (_, i) => ({ id: `id-${i}-xxxxxxxx`, name: i % 2 ? null : `곳${i}` }));
      const r = registrationImpact(app, "앱", L({ members: { total, expiring }, places, collecting, envFallback }));
      for (const l of [...r.remove, ...r.replace]) assert.doesNotMatch(l, /undefined|null|NaN/, `${app} ${total}/${expiring}/${np}: ${l}`);
      assert.equal(r.replace[0], "그 뒤로 연결하는 사람은 새 앱으로 연결돼요.");
      assert.ok(r.remove.length >= 1);
      n++;
    }
  assert.ok(n > 600, `조합 ${n}`);
});
t("C13 어긋난 값(total < expiring) → 음수 명수가 없다", () => {
  const r = registrationImpact("google", "구글", L({ members: { total: 1, expiring: 2 } }));
  assert.ok(![...r.remove, ...r.replace].some((l) => /-\d+명/.test(l)), [...r.remove, ...r.replace].join(" / "));
});

// ── E. 화면에 보일지 ──
const E = (o: Partial<Parameters<typeof registrationEditable>[0]> = {}, env: NodeJS.ProcessEnv = {}) =>
  registrationEditable({ app: "notion", heldBy: "workspace", canRegister: true, appReady: true, ...o }, env);
t("E1 셀프호스트 · 등록 권한 · 앱 준비 · 릴레이 아님 → 보인다(앱 여섯 모두)", () => {
  for (const app of APPS) assert.equal(E({ app }), true, app);
});
t("E2 매니지드(라이블리가 앱을 쥔다) → 안 보인다", () => { assert.equal(E({ heldBy: "lively" }), false); });
t("E3 등록 권한 없음 → 안 보인다", () => { assert.equal(E({ canRegister: false }), false); });
t("E4 앱 미준비 → 안 보인다(등록 칸이 대신 선다)", () => { assert.equal(E({ appReady: false }), false); });
t("E5 그 앱의 릴레이 env 가 있으면 안 보인다 · 다른 앱의 릴레이는 상관없다", () => {
  assert.equal(E({}, { NOTION_OAUTH_RELAY_URL: "https://app.lvly.io/oauth/notion/start" }), false);
  assert.equal(E({}, { NOTION_OAUTH_RELAY_URL: "  " }), true, "공백뿐인 값은 릴레이가 아니다");
  assert.equal(E({}, { SLACK_OAUTH_RELAY_URL: "https://x" }), true);
});
t("E6 앱 등록이 없는 앱(gitlab) → 안 보인다", () => { assert.equal(E({ app: "gitlab" }), false); });

console.log(`\n${pass} passed`);

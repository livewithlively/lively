// [외부 앱 연결] 목록 한 줄 · 상세 길 칸의 말(web/lib/connect-routes-view.ts) — 값으로 지킨다(#4970 PR-B).
//
//  사양 — 서버가 고른 길(org_connect_status routes · recommended · blocked_before)을 사람 말과 단추 하나로 옮긴다.
//   V1  상태를 못 읽음(error · routes=null)        → «불러오지 못했어요» · 자세히 · 묶음 err
//   V2  길이 없음(recommended=-1)                 → 할 일 없음
//   V3~V5 모으는 중(라이블리 앱 · 개인 토큰) · Claude 커넥터 연결됨 → 관리 · 묶음 on
//   V6~V7 범위만 남음 · 다시 로그인                 → 정할 것이 남음(half)
//   V8  앱 등록(관리자)                            → [앱 등록] · 걸리는 시간
//   V9~V11 연결 전 — 라이블리 앱 [연결] · 개인 토큰 [토큰 넣기] · Claude [Claude 로 연결] / 로그인 없음 [Claude 로그인]
//   V12 관리자에게 — 앱 미등록 / 수집 켜기           → 서로 다른 말
//   V13 준비 중 · 꺼짐                              → 할 일 없음
//   V14~V15 앞의 막힌 길 한 줄 · 여럿이면 잇는다
//   V16 요약 개수 · V17 앱 등록 값(빠진 칸 · 공백 · 선택 칸) · V18 키 파일 판별 · V19 공개 주소가 이 컴퓨터 자신인가 · V20 상세 길 순서 · V21 상세 상태 말
//   K1  계약 — 서버 판정(dist/org/connect-routes.js)이 낼 수 있는 모든 길·상태에 말과 단추가 있다
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const eq = (got, want, what) => { assert.deepEqual(got, want, what); pass++; };
const ok = (cond, what) => { assert.ok(cond, what); pass++; };

const V = await import(join(root, "public/app/lib/connect-routes-view.js"));
ok(typeof V.rowView === "function" && typeof V.regValues === "function" && typeof V.routeBlurb === "function", "W0 배선 — 판정을 불러왔다");

const app = (o) => ({ app: "slack", label: "슬랙", app_ready: true, routes: [], recommended: -1, blocked_before: [], ...o });
const pick = (v) => [v.button, v.bucket];

// V1
eq(pick(V.rowView(app({ error: "조회 실패", routes: null, recommended: null, blocked_before: null }))), [null, "err"], "V1 못 읽음");
eq(V.rowView(app({ routes: null })).word, "상태를 불러오지 못했어요", "V1 routes=null 도 못 읽음");
// V2
eq(pick(V.rowView(app({ routes: [], recommended: -1 }))), [null, "soon"], "V2 길 없음");
// V3~V5
eq(V.rowView(app({ routes: [{ kind: "app", state: "collecting" }], recommended: 0 })).word, "라이블리 앱으로 모으는 중", "V3");
eq(V.rowView(app({ routes: [{ kind: "app", state: "connect" }, { kind: "token", state: "collecting" }], recommended: 1 })).word, "개인 토큰으로 모으는 중", "V4");
const v5 = V.rowView(app({ routes: [{ kind: "app", state: "connect" }, { kind: "ai", state: "connected", ai_app: "slack" }], recommended: 1 }));
eq([v5.word, ...pick(v5)], ["Claude 커넥터로 연결됨", null, "on"], "V5");
// V6~V7
eq(pick(V.rowView(app({ routes: [{ kind: "app", state: "set_scope" }], recommended: 0 }))), ["범위 정하기", "half"], "V6");
eq(pick(V.rowView(app({ routes: [{ kind: "ai", state: "reconnect" }], recommended: 0 }))), ["다시 연결", "half"], "V7");
// V8
const v8 = V.rowView(app({ app_ready: false, routes: [{ kind: "app", state: "register" }], recommended: 0, registration: { minutes: 5 } }));
eq([v8.word, ...pick(v8)], ["라이블리 앱 등록부터 해요(약 5분)", "앱 등록", "off"], "V8");
// V9~V11
eq(pick(V.rowView(app({ routes: [{ kind: "app", state: "connect" }], recommended: 0 }))), ["연결", "off"], "V9");
eq(pick(V.rowView(app({ routes: [{ kind: "token", state: "connect" }], recommended: 0 }))), ["토큰 넣기", "off"], "V10");
eq(V.rowView(app({ routes: [{ kind: "ai", state: "connect", ai_app: "slack" }], recommended: 0 })).button, "Claude 로 연결", "V11 Claude 로 연결");
eq(V.rowView(app({ routes: [{ kind: "ai", state: "connect", ai_app: "slack", needs: "claude_login" }], recommended: 0 })).button, "Claude 로그인", "V11 로그인부터");
// V12
const unreg = V.rowView(app({ app_ready: false, routes: [{ kind: "app", state: "ask_admin" }], recommended: 0 }));
const noCollect = V.rowView(app({ app_ready: true, routes: [{ kind: "app", state: "ask_admin" }], recommended: 0 }));
ok(unreg.word !== noCollect.word && /등록/.test(unreg.word) && /수집/.test(noCollect.word), "V12 앱 미등록 ≠ 수집 켜기");
eq(pick(unreg), [null, "soon"], "V12 남이 할 일 — 내 단추 없음(상세가 부탁할 말을 준다)");
// V13
eq(pick(V.rowView(app({ routes: [{ kind: "app", state: "preparing" }], recommended: 0 }))), [null, "soon"], "V13 준비 중");
eq(pick(V.rowView(app({ routes: [{ kind: "ai", state: "off", off_reason: "blocked" }], recommended: 0 }))), [null, "soon"], "V13 꺼짐");
ok(V.rowView(app({ routes: [{ kind: "ai", state: "off", off_reason: "unknown" }], recommended: 0 })).word !== V.rowView(app({ routes: [{ kind: "ai", state: "off", off_reason: "blocked" }], recommended: 0 })).word, "V13 못 읽음 ≠ 관리자가 끔(관리자가 껐다고 말하지 않는다)");
ok(!/관리자/.test(V.routeStateText({ kind: "ai", state: "off", off_reason: "unknown" }, { label: "슬랙", app_ready: true })), "V13 못 읽음 상세 말에 «관리자» 가 없다");
// V14~V15
const v14 = V.rowView(app({ app_ready: false, routes: [{ kind: "app", state: "preparing" }, { kind: "ai", state: "connect", ai_app: "slack" }], recommended: 1, blocked_before: [0] }));
eq(v14.blockedNote, "라이블리 앱은 라이블리가 준비하고 있어요", "V14 앞의 막힌 길");
eq(V.rowView(app({ routes: [{ kind: "ai", state: "connect" }], recommended: 0, blocked_before: [] })).blockedNote, null, "V14 막힌 길 없음");
const v15 = V.rowView(app({ app_ready: false, routes: [{ kind: "app", state: "ask_admin" }, { kind: "ai", state: "off", off_reason: "blocked" }, { kind: "token", state: "connect" }], recommended: 2, blocked_before: [0, 1] }));
eq(v15.blockedNote, "라이블리 앱은 관리자가 먼저 등록해야 해요 · Claude 커넥터는 이 워크스페이스에서 쓰지 않아요", "V15 여럿");
eq(V.rowView(app({ routes: [{ kind: "token", state: "connect" }], recommended: 0, blocked_before: [5] })).blockedNote, null, "V15 없는 자리는 무시");
// V16
eq(V.rowSummary([
  app({ routes: [{ kind: "app", state: "collecting" }], recommended: 0 }),
  app({ routes: [{ kind: "app", state: "set_scope" }], recommended: 0 }),
  app({ routes: [{ kind: "token", state: "connect" }], recommended: 0 }),
  app({ routes: [{ kind: "app", state: "preparing" }], recommended: 0 }),
  app({ routes: null, error: "x" }),
]), { on: 1, half: 1, off: 1, soon: 1, err: 1 }, "V16 요약");
// V17
const fields = [{ key: "client_id", label: "Client ID", secret: false }, { key: "client_secret", label: "Client Secret", secret: true }, { key: "note", label: "메모", secret: false, optional: true }];
eq(V.regValues(fields, { client_id: " a ", client_secret: "b" }), { ok: true, values: { client_id: "a", client_secret: "b" } }, "V17 공백 떼기 · 선택 칸 비움");
eq(V.regValues(fields, { client_id: "a", client_secret: "   " }), { ok: false, missing: "Client Secret" }, "V17 공백뿐 = 빠짐");
eq(V.regValues(fields, { client_secret: "b" }), { ok: false, missing: "Client ID" }, "V17 없음");
// V18 — 키 파일
const pem = (k) => `-----BEGIN ${k}-----\nMIIabc\n-----END ${k}-----\n`;
ok(V.looksLikePrivateKey(pem("RSA PRIVATE KEY")), "V18 깃허브 키(.pem)");
ok(V.looksLikePrivateKey(pem("PRIVATE KEY")), "V18 PKCS8");
ok(!V.looksLikePrivateKey(pem("CERTIFICATE")), "V18 인증서는 아니다");
ok(!V.looksLikePrivateKey(pem("PUBLIC KEY")), "V18 공개 키는 아니다");
ok(!V.looksLikePrivateKey("-----BEGIN RSA PRIVATE KEY-----\nMII"), "V18 잘린 키");
// V19 — 공개 주소가 이 컴퓨터 자신인가(그대로 저장하면 다른 사람이 못 돌아온다) · 사내망 주소는 막지 않는다
for (const u of ["http://localhost:8080", "http://127.0.0.1:3000", "http://[::1]:80", "http://0.0.0.0", "http://app.localhost"]) ok(V.looksLoopbackAddress(u), `V19 ${u} — 이 컴퓨터`);
for (const u of ["https://lively.acme.com", "http://10.0.0.5", "http://192.168.1.10:8080", "https://lively.corp.local", "not a url"]) ok(!V.looksLoopbackAddress(u), `V19 ${u} — 막지 않는다`);
// V20
eq(V.routeOrder({ routes: [{ kind: "app", state: "preparing" }, { kind: "ai", state: "connect" }], recommended: 1 }),
  { first: { kind: "ai", state: "connect" }, rest: [{ kind: "app", state: "preparing" }] }, "V20 권하는 길 먼저 · 나머지 순서 그대로");
eq(V.routeOrder({ routes: [{ kind: "app", state: "preparing" }], recommended: -1 }).first, null, "V20 권하는 길 없음");
// V21
ok(/등록.*약 5분/.test(V.routeStateText({ kind: "app", state: "register" }, { label: "슬랙", app_ready: false, registration: { who: "슬랙 관리자", minutes: 5 } })), "V21 앱 등록 — 등록하면 연결 · 몇 분");
ok(!/\(가\)|\(를\)/.test(V.routeStateText({ kind: "app", state: "register" }, { label: "깃허브", app_ready: false, registration: { who: "깃허브 조직 Owner", minutes: 10 } })), "V21 영어로 끝나는 이름에도 «이(가)» 자국이 없다");
ok(/Claude 로그인/.test(V.routeStateText({ kind: "ai", state: "connect", needs: "claude_login" }, { label: "슬랙", app_ready: true })), "V21 로그인부터");
ok(/Claude 에서 Slack 커넥터를 연결하면/.test(V.routeStateText({ kind: "ai", state: "connect", ai_app: "slack" }, { label: "슬랙", app_ready: true })), "V21 Claude 에서 연결(커넥터 이름)");
ok(/Gmail 커넥터/.test(V.routeStateText({ kind: "ai", state: "connect", ai_app: "gmail" }, { label: "구글", app_ready: true })) && !/구글을/.test(V.routeStateText({ kind: "ai", state: "connect", ai_app: "gmail" }, { label: "구글", app_ready: true })), "★V21 구글의 Claude 길은 «Gmail» 커넥터라고 말한다(드라이브를 연결한 사람이 헛걸음하지 않게)");
ok(/Gmail 커넥터로 모아요/.test(V.routeBlurb({ kind: "ai", state: "connect", ai_app: "gmail" }, "구글")), "V21 길 설명도 커넥터 이름 · «구글으로» 같은 조사 없음");

// V22 (#5040) 자동 수집 멈춤 — 수집기는 켜져 있는데 주기 잡이 연속 실패로 꺼졌다. «모으는 중» 이라 말하면 거짓이다(위시스트 이틀).
{
  const stalled = V.rowView(app({ routes: [{ kind: "app", state: "collecting", stalled: true }], recommended: 0 }));
  eq([stalled.bucket, !!stalled.button], ["half", true], "V22 멈춤 — 할 일이 남은 묶음 · 단추가 있다");
  ok(/멈췄어요/.test(stalled.word) && !/모으는 중/.test(stalled.word), "V22 목록 말이 «모으는 중» 이 아니라 멈춤");
  ok(/멈췄어요/.test(V.routeStateText({ kind: "app", state: "collecting", stalled: true }, { label: "슬랙", app_ready: true })), "V22 상세 말도 멈춤");
  const live = V.rowView(app({ routes: [{ kind: "app", state: "collecting" }], recommended: 0 }));
  eq([live.bucket, live.button, live.word], ["on", null, "라이블리 앱으로 모으는 중"], "V22 멈춤 표시가 없으면 종전 그대로");
  eq(V.routeStateText({ kind: "app", state: "collecting" }, { label: "슬랙", app_ready: true }), "모으고 있어요.", "V22 상세 말 종전 그대로");
}

// K1 — 서버 판정이 낼 수 있는 모든 길·상태에 말과 단추가 있다(웹이 모르는 상태가 생기면 여기서 터진다).
const R = await import(join(root, "dist/org/connect-routes.js"));
const B = [true, false];
const seen = new Set();
for (const ready of B) for (const heldBy of ["lively", "workspace"]) for (const canRegister of B) for (const canCollect of B) for (const meConnected of B) for (const collecting of B)
  for (const policy of ["allowed", "blocked", "unknown"]) for (const mine of [null, "connected", "needs-auth", "failed", "pending", "removed"]) for (const login of [null, false, true])
    for (const tk of [null, { canCollect, meConnected, collecting }]) {
      const d = R.decideRoutes({ app: { ready, heldBy, canRegister, canCollect, meConnected, collecting }, ai: { aiApp: "slack", policy, mine, login }, ...(tk ? { token: tk } : {}) });
      for (let i = 0; i < d.routes.length; i++) {
        const v = V.rowView({ app: "slack", label: "슬랙", app_ready: ready, routes: d.routes, recommended: i, blocked_before: d.blocked_before, registration: { minutes: 5, who: "관리자" } });
        const r = d.routes[i];
        seen.add(`${r.kind}:${r.state}${r.needs ? ":" + r.needs : ""}`);
        assert.ok(v.word && v.word.length > 0 && !/undefined/.test(v.word), `K1 ${r.kind}:${r.state} 말`);
        assert.ok(V.routeStateText(r, { label: "슬랙", app_ready: ready, registration: { minutes: 5, who: "관리자" } }), `K1 ${r.kind}:${r.state} 상세 말`);
      }
    }
ok(seen.size >= 15, `K1 서버가 낸 길·상태 ${seen.size}가지 전부에 말이 있다`);

console.log(`connect-routes-view.test: ${pass} ok`);

// #1881 G3 구글 수집기 토큰 출처 — 순수 해소 회귀 잠금. DB·네트워크 불요.
//   실행: npm run build && node dist/org/credentials/google-token-source.test.js
//
//   ★ 이 표가 겨누는 고장은 하나로 수렴한다: **자격이 없는데 '성공'으로 보이는 것.**
//   이 코드베이스의 단골 사고다(수집 run 은 ok, 커서는 동결, 자료는 0건). 그래서 모든 실패 경로가
//   조용히 null 로 떨어지지 않고 **warning 문구를 만드는지**를 단언한다.
import assert from "node:assert/strict";
import {
  resolveGoogleTokenSource, googleKindsFor, isGoogleCollectorSystem,
  resolveGoogleOAuthClient, GOOGLE_CLIENT_KINDS,
  type GoogleVaultReader,
} from "./google-token-source.js";

let pass = 0;
const ta = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

/** 금고 스텁 — **어느 kind 를 어떤 순서로 뒤졌는지**가 관측 장치다(우선순위가 뒤집히면 여기서 잡힌다). */
function vaultSpy(opts: {
  slots?: Record<string, string | null>;          // kind → refresh_token(null = 슬롯은 있는데 갱신토큰 없음)
  clients?: Record<string, { client_id: string; client_secret: string }>;
}): GoogleVaultReader & { kindsSeen: string[][]; clientCalls: string[] } {
  const kindsSeen: string[][] = [];
  const clientCalls: string[] = [];
  return {
    kindsSeen, clientCalls,
    async memberOAuth(_id, kinds) {
      kindsSeen.push([...kinds]);
      for (const k of kinds) {
        if (opts.slots && Object.prototype.hasOwnProperty.call(opts.slots, k)) {
          return { kind: k, refresh_token: opts.slots[k] };
        }
      }
      return null;
    },
    async oauthClient(kind) {
      clientCalls.push(kind);
      return opts.clients?.[kind] ?? null;
    },
  };
}
const CLIENT = { client_id: "cid.apps.googleusercontent.com", client_secret: "sec" };

// ── 무회귀: 출처 미지정 ────────────────────────────────────────────────────────
await ta("비우면 null — 종전 붙여넣기 경로를 한 글자도 안 건드린다", async () => {
  const v = vaultSpy({ slots: { google_oauth: "RT" } });
  assert.equal(await resolveGoogleTokenSource(undefined, "gmail", v), null);
  assert.equal(await resolveGoogleTokenSource("", "gmail", v), null);
  assert.equal(await resolveGoogleTokenSource("   ", "gmail", v), null);
  assert.equal(v.kindsSeen.length, 0, "출처가 없는데 금고를 뒤졌다");
});

// ── 정상 경로 ────────────────────────────────────────────────────────────────
await ta("member:<id> → 통합 슬롯의 갱신토큰 + 그 kind 의 조직 클라이언트 3칸을 채운다", async () => {
  const v = vaultSpy({ slots: { google_oauth: "RT-1" }, clients: { google_oauth: CLIENT } });
  const r = await resolveGoogleTokenSource("member:admin", "gmail", v);
  assert.equal(r?.refresh_token, "RT-1");
  assert.equal(r?.client_id, CLIENT.client_id);
  assert.equal(r?.client_secret, CLIENT.client_secret);
  assert.equal(r?.warning, undefined);
});

await ta("★ 통합 슬롯이 없으면 그 서비스의 구 슬롯으로 폴백 — 예전에 붙인 사람도 그대로 돈다", async () => {
  const v = vaultSpy({ slots: { google_gmail_oauth: "RT-OLD" }, clients: { google_gmail_oauth: CLIENT } });
  const r = await resolveGoogleTokenSource("member:admin", "gmail", v);
  assert.equal(r?.refresh_token, "RT-OLD");
  // 종전엔 "클라이언트도 **그 슬롯의 kind** 로만 읽는다" 를 잠갔는데(clientCalls === [그 kind]),
  //  그 규칙이 실제로 수집을 죽였다(C5 참조) — 토큰과 클라이언트는 서로 다른 kind 에 있을 수 있다.
  //  잠글 것은 호출 목록이 아니라 **결과**다: 구 클라이언트를 실제로 찾아냈는가.
  assert.equal(r?.client_id, CLIENT.client_id);
  assert.equal(r?.warning, undefined);
  assert.ok(v.clientCalls.includes("google_gmail_oauth"), "구 kind 까지 훑지 않았다");
});

t("우선순위: 통합이 먼저, 그다음 그 서비스의 구 kind (다른 서비스 kind 는 안 본다)", () => {
  assert.deepEqual(googleKindsFor("gmail"), ["google_oauth", "google_gmail_oauth"]);
  assert.deepEqual(googleKindsFor("gdrive"), ["google_oauth", "google_drive_oauth"]);
  // gmail 수집기가 드라이브 자격을 끌어오면 scope 부족으로 상류 403 — 원인 진단이 어려워진다
  assert.ok(!googleKindsFor("gmail").includes("google_drive_oauth"));
});

t("구글 수집기 판정 — 다른 커넥터는 이 경로를 안 탄다", () => {
  assert.equal(isGoogleCollectorSystem("gmail"), true);
  assert.equal(isGoogleCollectorSystem("gdrive"), true);
  assert.equal(isGoogleCollectorSystem("slack"), false);
  assert.equal(isGoogleCollectorSystem("notion"), false);
});

// ── 실패 경로 — 전부 "말하고 실패"해야 한다(조용한 성공 금지) ─────────────────────
await ta("연결 자체가 없으면 warning — 자격 3칸은 비운다(커넥터가 분명히 실패하게)", async () => {
  const v = vaultSpy({ clients: { google_oauth: CLIENT } });
  const r = await resolveGoogleTokenSource("member:ghost", "gdrive", v);
  assert.match(r?.warning ?? "", /ghost/);
  assert.equal(r?.refresh_token, undefined);
  assert.equal(r?.client_id, undefined, "자격이 없는데 클라이언트만 채우면 반쪽 설정이 된다");
});

await ta("★ 슬롯은 있는데 갱신토큰이 없으면 warning — 1시간 뒤 죽을 연결을 '성공'으로 넘기지 않는다", async () => {
  // #1652: access_type=offline 픽스 이전에 붙은 계정이 정확히 이 상태다(토큰은 있는데 갱신 불가)
  const v = vaultSpy({ slots: { google_oauth: null }, clients: { google_oauth: CLIENT } });
  const r = await resolveGoogleTokenSource("member:old", "gmail", v);
  assert.match(r?.warning ?? "", /갱신 토큰/);
  assert.equal(r?.refresh_token, undefined);
  assert.equal(v.clientCalls.length, 0, "쓸 수 없는 자격인데 클라이언트까지 읽었다");
});

await ta("조직 OAuth 클라이언트가 없으면 warning — 관리자가 할 일을 지목한다", async () => {
  const v = vaultSpy({ slots: { google_oauth: "RT" } });
  const r = await resolveGoogleTokenSource("member:admin", "gmail", v);
  assert.match(r?.warning ?? "", /Client ID/);
  assert.equal(r?.refresh_token, undefined, "클라이언트가 없는데 갱신토큰만 넘기면 교환이 못 돈다");
});

await ta("형식이 틀린 출처는 warning — 조용히 종전 경로로 떨어지지 않는다", async () => {
  const v = vaultSpy({ slots: { google_oauth: "RT" }, clients: { google_oauth: CLIENT } });
  assert.match((await resolveGoogleTokenSource("org", "gmail", v))?.warning ?? "", /member:/);
  assert.match((await resolveGoogleTokenSource("bot", "gmail", v))?.warning ?? "", /member:/);
  assert.match((await resolveGoogleTokenSource("member:", "gmail", v))?.warning ?? "", /구성원 id/);
  assert.equal(v.kindsSeen.length, 0, "형식이 틀렸는데 금고를 뒤졌다");
});

// ── 조직 OAuth 클라이언트의 구 kind 승계 (2026-08-26 dev 실측이 만든 행들) ──────
//  실측: dev 금고에 client 가 `google_drive_oauth/oauth:client` 로만 있었다. 그 상태에서
//  통합 kind 만 보면 googleReady()=false 가 되는데, 화면은 "연결됨"이라 client 입력 폼도 안 뜬다
//  → 연결은 돼 있는데 범위를 넓힐 길이 없는 **막다른 상태**가 된다.
const clientVault = (have: Record<string, boolean>): Pick<GoogleVaultReader, "oauthClient"> => ({
  async oauthClient(kind) {
    return have[kind] ? { client_id: `${kind}-id`, client_secret: `${kind}-sec` } : null;
  },
});

await ta("C1 ★ client 가 구 kind 에만 있어도 찾는다 — 없으면 연결된 사람이 범위를 못 넓힌다", async () => {
  const r = await resolveGoogleOAuthClient(clientVault({ google_drive_oauth: true }));
  assert.equal(r?.kind, "google_drive_oauth");
  assert.equal(r?.client_id, "google_drive_oauth-id");
});

await ta("C2 통합 kind 가 먼저다 — 새로 넣은 client 가 낡은 것을 이긴다", async () => {
  const r = await resolveGoogleOAuthClient(clientVault({ google_oauth: true, google_drive_oauth: true }));
  assert.equal(r?.kind, "google_oauth");
  assert.equal(GOOGLE_CLIENT_KINDS[0], "google_oauth");
});

await ta("C3 아무 데도 없으면 null — 여기서 '있는 척' 하면 authorize 가 빈 client_id 로 나간다", async () => {
  assert.equal(await resolveGoogleOAuthClient(clientVault({})), null);
});

await ta("C4 구 kind 3종을 전부 훑는다(gmail·calendar 로만 붙인 조직도 있다)", async () => {
  assert.deepEqual([...GOOGLE_CLIENT_KINDS],
    ["google_oauth", "google_drive_oauth", "google_gmail_oauth", "google_calendar_oauth"]);
  assert.equal((await resolveGoogleOAuthClient(clientVault({ google_calendar_oauth: true })))?.kind, "google_calendar_oauth");
});

await ta("★ C5 토큰은 통합 슬롯, client 는 구 kind — 실제로 수집이 죽었던 조합(2026-08-27 run 16275)", async () => {
  // 새 방식으로 [Google 연결]을 하면 통합 슬롯이 생기고 googleKindsFor 가 그걸 먼저 잡는다.
  //  그런데 client 조회를 **잡힌 그 kind 로만** 하면, client 가 구 kind 에 있는 조직에서 수집이 통째로 멈춘다
  //  ("Google OAuth 클라이언트(kind google_oauth)가 등록되지 않았습니다"). 실제로 그렇게 죽었다.
  const vault: GoogleVaultReader = {
    async memberOAuth(_id, kinds) {
      for (const k of kinds) if (k === "google_oauth") return { kind: k, refresh_token: "RT" };
      return null;
    },
    async oauthClient(kind) {
      return kind === "google_drive_oauth" ? { client_id: "old-id", client_secret: "old-sec" } : null;
    },
  };
  const r = await resolveGoogleTokenSource("member:yoon", "gdrive", vault);
  assert.equal(r?.warning, undefined, `수집이 멈춘다: ${r?.warning}`);
  assert.equal(r?.client_id, "old-id");
  assert.equal(r?.refresh_token, "RT");
});

console.log(`\n${pass} passed`);

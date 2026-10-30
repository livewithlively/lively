// codex 헤드리스 자격 해석·되받기 판정·확인 문장 (#4012 T2) — 사양 spec-codex-parity 의 X·V·C 행.
//
//  왜 표로 재나: 이 판정이 틀리면 조용하다 — 남의 계정 토큰이 저장본을 갈아 끼우거나(자료가 남의 계정으로 샌다),
//   멀쩡한 갱신본을 버려 다음 판부터 전부 401 이 되거나, 깨진 파일이 «등록 성공» 으로 남는다.
import { strict as assert } from "node:assert";
import { CODEX_AUTH_KIND, CREDENTIAL_SECRET_MAX, codexReturnVerdict, describeCodexAuth, jwtPayload, parseCodexAuth } from "./codex-auth.js";
import { verifierExists, verifyCredential } from "./credential-verify.js";

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: Record<string, unknown>): string => `${b64({ alg: "RS256" })}.${b64(payload)}.c2ln`;
const claim = (acct: string, extra: Record<string, unknown> = {}) => ({ "https://api.openai.com/auth": { chatgpt_account_id: acct }, ...extra });
const auth = (o: { acct?: string; idAcct?: string | null; acAcct?: string | null; tokenAcct?: string | null; lastRefresh?: string | null; email?: string; exp?: number; access?: string | null; rt?: string } = {}): string => {
  const acct = o.acct ?? "acct-A";
  const id = o.idAcct === null ? undefined : jwt(claim(o.idAcct ?? acct, { email: o.email ?? "me@x.io" }));
  const access = o.access === null ? undefined : (o.access ?? jwt(o.acAcct === null ? { exp: o.exp ?? 1_900_000_000 } : claim(o.acAcct ?? acct, { exp: o.exp ?? 1_900_000_000 })));
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: { id_token: id, access_token: access, refresh_token: o.rt ?? "rt-" + (o.lastRefresh ?? "x"), ...(o.tokenAcct === null ? {} : { account_id: o.tokenAcct ?? acct }) },
    last_refresh: o.lastRefresh === null ? undefined : (o.lastRefresh ?? "2026-09-01T00:00:00Z"),
  });
};

// ── X: 해석 ─────────────────────────────────────────────────────────────────
{
  const i = parseCodexAuth(auth({ email: "sm@lvly.io", exp: 1_900_000_000 }));
  assert.deepEqual(i, { mode: "chatgpt", accountId: "acct-A", email: "sm@lvly.io", lastRefresh: Date.parse("2026-09-01T00:00:00Z"), accessExp: 1_900_000_000_000 }, "X1");
  //  클레임 우선순위: id_token → access_token → tokens.account_id
  assert.equal(parseCodexAuth(auth({ idAcct: "from-id", acAcct: "from-access", tokenAcct: "from-field" }))?.accountId, "from-id", "X1 id_token 클레임 우선");
  assert.equal(parseCodexAuth(auth({ idAcct: null, acAcct: "from-access", tokenAcct: "from-field" }))?.accountId, "from-access", "X1 access_token 클레임");
  assert.equal(parseCodexAuth(auth({ idAcct: null, acAcct: null, tokenAcct: "from-field" }))?.accountId, "from-field", "X2 폴백");
  assert.equal(parseCodexAuth(auth({ idAcct: null, acAcct: null, tokenAcct: null })), null, "X2 계정을 못 가르면 null");
  assert.deepEqual(parseCodexAuth(JSON.stringify({ OPENAI_API_KEY: "sk-abc" })), { mode: "apikey", accountId: null, email: null, lastRefresh: null, accessExp: null }, "X3");
  for (const bad of ["", "{", "[]", "null", "42", '"str"', JSON.stringify({ tokens: {} }), JSON.stringify({ tokens: { access_token: "" } }),
    JSON.stringify({ OPENAI_API_KEY: "  " }), JSON.stringify({ foo: 1 })]) {
    assert.equal(parseCodexAuth(bad), null, `X4 ${bad}`);
  }
  //  깨진 JWT — 폴백 계정이 있으면 해석, 없으면 null.
  assert.equal(parseCodexAuth(auth({ access: "not.a.jwt!", idAcct: null, tokenAcct: "fb" }))?.accountId, "fb", "X4 깨진 JWT + 폴백");
  assert.equal(parseCodexAuth(auth({ access: "onlyonepart", idAcct: null, tokenAcct: null })), null, "X4 깨진 JWT · 폴백 없음");
  assert.equal(jwtPayload("a.b"), null, "X4 두 조각");
  assert.equal(jwtPayload("a.!!.c"), null, "X4 base64url 아님");
  assert.equal(jwtPayload(`a.${Buffer.from("[1]").toString("base64url")}.c`), null, "X4 객체 아님");
  assert.equal(parseCodexAuth(auth({ lastRefresh: "어제" }))?.lastRefresh, null, "X5 형식 밖 시각");
  assert.equal(parseCodexAuth(auth({ lastRefresh: null }))?.lastRefresh, null, "X5 시각 없음");
  assert.equal(CODEX_AUTH_KIND, "codex_auth_json");
  assert.ok(/^[a-z0-9_]{1,40}$/.test(CODEX_AUTH_KIND), "종류 이름이 금고 형식을 지킨다");
  assert.equal(CREDENTIAL_SECRET_MAX, 16384);
}

// ── V: 되받기 판정 ──────────────────────────────────────────────────────────
{
  const stored = auth({ lastRefresh: "2026-09-01T00:00:00Z" });
  const newer = auth({ lastRefresh: "2026-09-10T00:00:00Z" });
  assert.deepEqual(codexReturnVerdict(stored, newer), { accept: true }, "V1");
  assert.deepEqual(codexReturnVerdict(stored, "  \n" + newer + "\n"), { accept: true }, "V1 앞뒤 공백");
  const other = auth({ acct: "acct-EVIL", lastRefresh: "2026-09-10T00:00:00Z" });
  assert.equal(codexReturnVerdict(stored, other).accept, false, "V2 다른 계정");
  assert.match(JSON.stringify(codexReturnVerdict(stored, other)), /다른 계정/);
  //  ★ 클레임은 남의 것, 필드만 우리 것으로 꾸민 파일 — 클레임이 이긴다.
  const disguised = auth({ idAcct: "acct-EVIL", acAcct: "acct-EVIL", tokenAcct: "acct-A", lastRefresh: "2026-09-10T00:00:00Z" });
  assert.equal(codexReturnVerdict(stored, disguised).accept, false, "V2 필드 위장");
  //  ⚠ 내용은 **달라야** 한다 — 같은 파일이면 «바뀐 것 없음» 이 대신 잡아 이 행이 헛돈다(변이 T2 가 드러냄).
  assert.deepEqual(codexReturnVerdict(stored, auth({ lastRefresh: "2026-09-01T00:00:00Z", rt: "rt-rotated" })),
    { accept: false, why: "저장본보다 새것이 아니다" }, "V3 같은 시각 · 내용 다름");
  assert.deepEqual(codexReturnVerdict(stored, stored), { accept: false, why: "저장본보다 새것이 아니다" }, "V3 완전히 같은 파일");
  assert.equal(codexReturnVerdict(stored, auth({ lastRefresh: "2026-08-01T00:00:00Z" })).accept, false, "V3 옛것");
  assert.equal(codexReturnVerdict(stored, auth({ lastRefresh: null })).accept, false, "V3 시각 없음");
  assert.deepEqual(codexReturnVerdict(stored, "   "), { accept: false, why: "반환이 없다" }, "V4 빈 값");
  assert.equal(codexReturnVerdict(stored, "{broken").accept, false, "V4 깨짐");
  assert.equal(codexReturnVerdict(JSON.stringify({ OPENAI_API_KEY: "sk" }), newer).accept, false, "V5 키 모드 저장본");
  assert.equal(codexReturnVerdict(null, newer).accept, false, "V6 저장본 없음");
  assert.equal(codexReturnVerdict("{not json", newer).accept, false, "V6 저장본 해석 불가");
  assert.deepEqual(codexReturnVerdict(stored, auth({ lastRefresh: "2026-09-01T00:00:00.001Z" })), { accept: true }, "V7 1ms 더 새것");
  //  저장본에 시각이 없으면(옛 파일) 새 시각이 있는 같은 계정 파일은 받는다.
  assert.deepEqual(codexReturnVerdict(auth({ lastRefresh: null }), newer), { accept: true }, "V7 저장본 시각 없음");
}

// ── C: 확인 문장(네트워크 없음) ────────────────────────────────────────────
{
  const now = Date.parse("2026-09-16T00:00:00Z");
  const ok = describeCodexAuth(parseCodexAuth(auth({ email: "sm@lvly.io", exp: Math.floor(Date.parse("2026-09-26T00:00:00Z") / 1000) })), now);
  assert.equal(ok.ok, true, "C1");
  assert.equal(ok.who, "sm@lvly.io");
  assert.match(ok.message, /sm@lvly\.io.*2026-09-26/, "C1 계정·만료");
  const expired = describeCodexAuth(parseCodexAuth(auth({ exp: 1_000_000_000 })), now);
  assert.match(expired.message, /이미 만료/, "C1 만료된 액세스 토큰도 ok(판이 갱신)");
  assert.equal(expired.ok, true);
  const key = describeCodexAuth(parseCodexAuth(JSON.stringify({ OPENAI_API_KEY: "sk" })), now);
  assert.deepEqual([key.ok, /API 키/.test(key.message)], [true, true], "C2");
  const bad = describeCodexAuth(null, now);
  assert.deepEqual([bad.ok, /auth\.json/.test(bad.message)], [false, true], "C3");

  assert.equal(verifierExists("codex_auth_json"), true, "C 확인기 등록");
  assert.equal(verifierExists("CODEX_AUTH_JSON"), true, "C 대소문자");
  //  배선: 네트워크 확인기 표를 타지 않는다 — fetch 를 막아 두고 부른다.
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; throw new Error("네트워크 금지"); }) as typeof fetch;
  try {
    const r = await verifyCredential("codex_auth_json", auth({ email: "sm@lvly.io" }));
    assert.equal(r.ok, true, "C1 verifyCredential");
    const r2 = await verifyCredential("codex_auth_json", "garbage");
    assert.equal(r2.ok, false, "C3 verifyCredential");
    const r3 = await verifyCredential("codex_auth_json", "");
    assert.equal(r3.ok, false, "C 빈 값");
    assert.equal(fetched, 0, "C ★ 네트워크를 타지 않는다");
    //  다른 종류는 종전대로 네트워크 확인기(fetch)를 탄다 — 막아 둔 fetch 가 불렸는지로 본다.
    await verifyCredential("figma_token", "figd_x");
    assert.equal(fetched, 1, "C 다른 종류는 종전 경로");
  } finally { globalThis.fetch = realFetch; }
}

console.log("✓ codex-auth — 해석·되받기 판정·확인 문장 (X·V·C)");

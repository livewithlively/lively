// 앱이 직접 하는 브라우저 로그인 (#5650) — **로그인 버튼은 로그인만 한다.**
//
// 왜 앱이 직접 하나: 종전엔 로그인을 CLI(`lively setup`)가 했고, 그래서 로그인 버튼을 누르는 순간 CLI 부트스트랩
//  (Node·CLI·PATH)부터 깔렸다. 사람은 무엇이 설치되는지 고를 기회가 없었다. 이제 앱이 디바이스 코드 로그인을
//  직접 하고, 받은 토큰은 **메모리에만** 들고 있다가 사람이 «이 컴퓨터 설정» 에서 [설정하고 시작] 을 누르면
//  그때 CLI 를 깔고 `lively login` 에 env 로 넘긴다(main.mjs applySetup).
//
// 서버 계약은 CLI(kit/cli/lively.mjs deviceLogin·cloudLogin)와 **같은 한 벌**이다 — 클라우드(CP)와 게이트웨이가
//  같은 모양(POST /cli/device/start · /cli/device/poll, 202 대기 · 429 천천히 · 403 거부 · 410/401 만료)을 쓴다.
//  차이는 클라우드 응답에만 gateway_url·workspace 가 실려 온다는 것 하나다.
//
// ⚠ 순수 모듈이다(fetch·sleep·crypto 를 주입받는다) — 폴 루프의 분기를 네트워크 없이 표로 시험한다(desktop-core.test.mjs).
// ⚠ device_code·토큰·verifier 는 렌더러로 보내지 않는다. 렌더러가 받는 건 사람에게 보여 줄 코드와 주소뿐이다.

/** PKCE S256 — 서버(device-auth.ts)·CLI 와 같은 계산. */
export function s256(verifier, createHash) {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** 승인 화면에 보일 기기 이름 — 서버가 [\w .@-] 로 거른다. 우리도 미리 걸러 둔다(거부되면 로그인이 안 된다). */
export function deviceLabel(host) {
  const h = String(host || "").split(".")[0].replace(/[^\w .@-]/g, "").slice(0, 40).trim();
  return `lively-desktop@${h || "PC"}`;
}

/**
 * ① 시작 — 코드와 주소를 받는다.
 * @returns {Promise<{ok:true, start:object, verifier:string} | {ok:false, unsupported?:boolean, error:string}>}
 */
export async function deviceStart({ base, label, fetchImpl, randomBytes, createHash }) {
  const verifier = randomBytes(32).toString("base64url");
  let res, text;
  try {
    res = await fetchImpl(base + "/cli/device/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code_challenge: s256(verifier, createHash), label }),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, error: `서버에 연결하지 못했습니다. 주소와 네트워크를 확인하세요. (${e?.message || e})` };
  }
  let start = null;
  try { start = JSON.parse(text); } catch { /* 비-JSON(로그인 HTML·프록시 오류 등) */ }
  // 브라우저 로그인을 모르는 서버(구 게이트웨이·롤백)는 폴백으로 넘긴다 — CLI 와 같은 판정(404·501·500·비-JSON).
  if (res.status === 404 || res.status === 501 || res.status === 500 || !start || !res.ok || !start.device_code) {
    return { ok: false, unsupported: true, error: `이 주소는 브라우저 로그인을 지원하지 않습니다. (HTTP ${res.status})` };
  }
  return { ok: true, start, verifier };
}

/**
 * ② 승인 대기 — 승인·거부·만료·취소 중 하나로 끝난다. 전송 오류는 일시 오류로 보고 계속한다(게이트웨이 재시작 중일 수 있다).
 * @returns {Promise<{ok:true, token:string, gateway:string|null, workspace:string|null} | {ok:false, error:string, cancelled?:boolean}>}
 */
export async function devicePoll({ base, start, verifier, fetchImpl, sleep, now = Date.now, signal }) {
  let interval = Math.max(2, Number(start.interval) || 5);
  const deadline = now() + (Number(start.expires_in) || 900) * 1000;
  for (;;) {
    await sleep(interval * 1000);
    if (signal?.aborted) return { ok: false, cancelled: true, error: "로그인을 취소했습니다." };
    if (now() > deadline) return { ok: false, error: "코드가 만료됐습니다. 다시 로그인하세요." };
    let status = 0, body = null;
    try {
      const res = await fetchImpl(base + "/cli/device/poll", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: start.device_code, code_verifier: verifier }),
      });
      status = res.status;
      try { body = JSON.parse(await res.text()); } catch { body = null; }
    } catch { status = 0; body = null; }
    if (signal?.aborted) return { ok: false, cancelled: true, error: "로그인을 취소했습니다." };
    if (status === 200 && body?.token) {
      return { ok: true, token: String(body.token), gateway: body.gateway_url ? String(body.gateway_url) : null, workspace: body.workspace ? String(body.workspace) : null };
    }
    if (status === 202) continue;
    if (status === 429) { interval = (Number(body?.interval) || interval) + 5; continue; }
    if (status === 403) return { ok: false, error: "브라우저에서 연결을 거부했습니다." };
    if (status === 410 || status === 401) return { ok: false, error: "코드가 만료됐습니다. 다시 로그인하세요." };
  }
}

/** 게이트웨이 주소 정규화 — 끝 슬래시·`/ui` 꼬리를 뗀다(CLI normGw 와 같은 결과). */
export function normGateway(u) {
  return String(u || "").trim().replace(/\/+$/, "").replace(/\/ui$/, "");
}

/** ③ 누구로 로그인됐나 — 계정 칸에 보일 이메일·이름. 못 읽어도 로그인은 유효하다(칸에 주소만 보인다). */
export async function fetchProfile({ gateway, token, fetchImpl, timeoutMs = 15000 }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(gateway + "/api/ui/me/profile", { signal: ctl.signal, headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403) return { ok: false, rejected: true, error: "서버가 이 로그인을 거부했습니다. 다시 로그인하세요." };
    if (!res.ok) return { ok: false, error: `서버가 정상 응답하지 않습니다. (HTTP ${res.status})` };
    const me = await res.json();
    return { ok: true, email: me?.email ? String(me.email) : null, name: me?.display_name ? String(me.display_name) : null };
  } catch (e) {
    return { ok: false, error: e?.name === "AbortError" ? "서버 응답이 없습니다. 네트워크를 확인하세요." : `서버에 연결하지 못했습니다. (${e?.message || e})` };
  } finally { clearTimeout(t); }
}

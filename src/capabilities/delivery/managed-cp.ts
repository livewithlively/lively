// delivery ▸ managed-cp — 매니지드에서 **컨트롤플레인(app.lvly.io)에 대신 물어보는 통로** (#2188)
//
// ── 규약: 화면은 코어에, 실행은 CP 에 ────────────────────────────────────────
// #1876(회원 탈퇴)이 세운 규약을 그대로 잇는다. 그때 배운 것은 이랬다 — 로그인해서 쓰고 있는 사람에게
//  "그건 밖에 나가서 하세요" 라고 말하는 화면은 **기능이 없는 것과 같다**.
//
// 2026-08-27 장원준 신고 셋이 같은 자리였다:
//   ① 가입 때 정한 이름이 워크스페이스에 안 붙는다("내 워크스페이스" 로 굳음)
//   ② 「새 워크스페이스」가 app.lvly.io 링크 + 새 탭 — *"????? 이건 왜..? 앱에서처럼 해줘"*
//   ③ app.lvly.io 에서 만든 워크스페이스가 게이트웨이 스위처에 **안 나타난다**
//
// ⚠ 답은 "테넌트 안에서 registry 를 켜는 것"이 아니다 — 그러면 워크스페이스 축의 권위가 둘이 되고
//  CP 의 캡(계정당 워크스페이스 수·인원)이 우회된다(org/tenancy/activate.ts opt-out 머리말).
//  여기서는 **묻고 전달만** 한다. 캡·소유권·프로비저닝 판정은 전부 CP 가 그대로 한다.
//
// ── 신뢰 재료(새로 만들지 않았다) ────────────────────────────────────────────
//  · 내가 누구인지        = 이 요청의 사람 세션(principal)
//  · 내 CP 계정 id        = `org_member.identities` 의 `lvly_account`(프로비저닝이 심는다)
//  · CP 를 부를 자격      = CP↔코어가 이미 공유하는 `LIVELY_TENANT_HEADER_SECRET`
//  · 내가 어느 테넌트인지 = `currentTenant().slug`
//
// ⚠ **계정 id 는 화면이 보내는 값이 아니라 서버가 자기 신원에서 뽑는다.** 받으면 남의 계정으로
//  워크스페이스를 만들거나 남의 명부를 읽는 통로가 된다(#1876 와 같은 이유).

import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { getMember } from "../../org/store.js";
import { getRuntimeConfig } from "../../org/store/runtime-config.js";
import { currentTenant } from "../../org/tenant-context.js";
import { actorOf } from "./shared.js";
import { logger } from "../../log.js";

export interface CpTarget { base: string; secret: string; slug: string; accountId: string; }

/**
 * 이 배포가 매니지드인가 — 노브 하나(`workspace_hub_url`)로 가른다. 그 노브의 정의 자체가
 *  "null = 셀프호스트"이고, 화면의 항목 노출도 같은 값을 본다(축을 둘로 늘리지 않는다 — #1876 선례).
 */
export async function hubOrigin(): Promise<string | null> {
  const cfg = await getRuntimeConfig();
  const hub = (cfg.workspace_hub_url || "").trim();
  if (!hub) return null;
  try { return new URL(hub).origin; } catch {
    // 노브가 켜져 있는데 주소가 깨졌다 — 셀프호스트로 떨어뜨리면 **없는 기능을 있다고 그린다**. 여기서 끊는다.
    throw new HttpError(400, "계정 서버 주소가 올바르지 않습니다 — 관리자에게 알려 주세요.");
  }
}

/**
 * 매니지드에서 이 요청을 CP 로 넘길 수 있나. 하나라도 없으면 **반쯤 구성된 박스**라 조용히 넘기지 않는다.
 * 던지지 않고 null 을 주는 판(`optional`)은 목록처럼 "없으면 그냥 빈 화면" 이어도 되는 자리가 쓴다.
 */
export async function resolveCpTarget(user: LivelyUser, opts: { optional?: boolean } = {}): Promise<CpTarget | null> {
  const base = await hubOrigin();
  if (!base) return opts.optional ? null : fail("이 워크스페이스는 라이블리가 운영하는 계정 체계를 쓰지 않습니다.");
  const secret = (process.env.LIVELY_TENANT_HEADER_SECRET || "").trim();
  const tenant = currentTenant();
  if (!secret || !tenant) return opts.optional ? null : fail("이 게이트웨이는 계정 서버와 연결돼 있지 않습니다 — 관리자에게 알려 주세요.");
  const me = await getMember(actorOf(user));
  if (!me) throw new HttpError(403, "사용자 신원이 없습니다");
  const accountId = (me.identities ?? []).find((i) => i.system === "lvly_account")?.external_id ?? "";
  if (!accountId) {
    return opts.optional ? null : fail("이 구성원은 라이블리 계정과 연결돼 있지 않습니다 — 관리자에게 요청하세요.");
  }
  return { base, secret, slug: tenant.slug, accountId };
}

function fail(msg: string): never { throw new HttpError(400, msg); }

/**
 * CP 호출. 계정 id 는 **여기서** 실린다(호출부가 넣지 않는다 — 넣을 수 있으면 언젠가 남의 것이 실린다).
 * ⚠ CP 가 안 잡히면 502 로 끊는다. "빈 목록"으로 떨어뜨리면 사람은 **워크스페이스가 사라졌다**고 읽는다.
 */
export async function callCp<T>(t: CpTarget, path: string, body: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${t.base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lively-tenant-auth": t.secret,
        "x-lively-tenant": t.slug,
      },
      body: JSON.stringify({ ...body, account_id: t.accountId }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new HttpError(502, "계정 서버에 연결하지 못했습니다 — 잠시 뒤 다시 시도해 주세요.");
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* JSON 이 아니면 상태코드로만 판단 */ }
  if (!res.ok) {
    const msg = (json && typeof json === "object" && "error" in json) ? String((json as { error: unknown }).error) : "";
    // 400 은 CP 가 사람에게 할 말이 있는 경우(캡 초과·중복 초대 등) — 문구를 그대로 전한다.
    throw new HttpError(res.status === 400 || res.status === 403 ? res.status : 502, msg || `계정 서버 오류(${res.status})`);
  }
  return json as T;
}

/** 실패해도 지금 하던 일을 막지 않는 부수효과용(예: 온보딩이 이름을 알려 주는 것). */
export async function callCpBestEffort(t: CpTarget | null, path: string, body: Record<string, unknown> = {}): Promise<void> {
  if (!t) return;
  try { await callCp(t, path, body); }
  catch (err) { logger.warn({ err, path }, "CP 부수호출 실패(무시)"); }
}

// ── CP 응답 모양(코어가 그대로 화면에 넘기는 것) ─────────────────────────────
export interface CpWorkspace {
  id: string; name: string; slug: string;
  kind: "personal" | "team";
  role: string; member_count: number; pending_invites: number;
  tenant_state: string | null;
  /** 이 워크스페이스로 들어가는 주소. **매니지드에서 전환은 헤더가 아니라 이동이다** — 워크스페이스마다
   *  테넌트가 다르고 주소도 다르다(1:1). CP 가 SSO 를 태워 그 게이트웨이로 보낸다. */
  enter_url: string;
  is_current: boolean;
}

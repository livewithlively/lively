// delivery ▸ me-account-delete — 회원 탈퇴를 **이 앱 안에서** 끝내는 표면 (#1876)
//
// 왜 여기 있나: 계정은 코어(이 게이트웨이)가 아니라 매니지드 컨트롤플레인(app.lvly.io)이 갖고 있다.
//  그래서 처음엔 설정 창이 그 도메인으로 새 탭을 띄웠는데 — **로그인해서 쓰고 있는 사람이 탈퇴하려면
//  밖에 나가서 다시 로그인해야 하는** 화면이 됐다(실측 신고). 그건 기능이 없는 것과 같고, 탈퇴는
//  법으로 보장돼야 하는 경로다(개인정보보호법 §39조의7).
//
//  → 화면과 확인은 **여기**서 받고, 실행만 CP 에 위임한다. 사람은 이 앱을 떠나지 않는다.
//
// 신뢰 재료는 새로 만들지 않았다:
//  · 내가 누구인지 = 이 요청의 사람 세션(principal)
//  · 그 사람의 CP 계정 id = `org_member.identities` 의 `lvly_account`(프로비저닝이 심는다)
//  · CP 를 부를 자격 = CP↔코어가 이미 공유하는 `LIVELY_TENANT_HEADER_SECRET`(종전엔 CP→코어 한 방향)
//  · CP 주소 = `workspace_hub_url` 노브의 오리진(매니지드에만 있다)
//
// ⚠ 셀프호스트에는 이 표면이 **없는 것과 같다** — 위 넷 중 하나라도 없으면 400 으로 끊고 화면도 항목을
//  그리지 않는다. 그 배포엔 '회원'이라는 단위가 없고 구성원 제거는 관리자의 일이다.

import { z } from "zod";
import type { Capability } from "../types.js";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { getMember } from "../../org/store.js";
import { getRuntimeConfig } from "../../org/store/runtime-config.js";
import { currentTenant } from "../../org/tenant-context.js";
import { actorOf, restRead, str } from "./shared.js";

interface CpTarget { base: string; secret: string; slug: string; accountId: string; }

/** 이 요청을 CP 로 넘길 수 있나 — 넷 중 하나라도 없으면 이 배포엔 탈퇴 표면이 없는 것이다. */
async function resolveTarget(user: LivelyUser): Promise<CpTarget> {
  const secret = (process.env.LIVELY_TENANT_HEADER_SECRET || "").trim();
  const tenant = currentTenant();
  if (!secret || !tenant) {
    throw new HttpError(400, "이 워크스페이스는 라이블리가 운영하는 계정 체계를 쓰지 않습니다 — 탈퇴는 관리자에게 요청하세요.");
  }
  const cfg = await getRuntimeConfig();
  const hub = (cfg.workspace_hub_url || "").trim();
  if (!hub) throw new HttpError(400, "계정 서버 주소가 설정돼 있지 않습니다 — 관리자에게 알려 주세요.");
  let base: string;
  try { base = new URL(hub).origin; } catch { throw new HttpError(400, "계정 서버 주소가 올바르지 않습니다."); }

  const me = await getMember(actorOf(user));
  if (!me) throw new HttpError(403, "사용자 신원이 없습니다");
  //  ⚠ 계정 id 는 **화면이 보내는 값이 아니라 서버가 자기 신원에서 뽑는다** — 받으면 남의 계정을 지우는 통로가 된다.
  const accountId = (me.identities ?? []).find((i) => i.system === "lvly_account")?.external_id ?? "";
  if (!accountId) {
    throw new HttpError(400, "이 구성원은 라이블리 계정과 연결돼 있지 않습니다 — 탈퇴는 관리자에게 요청하세요.");
  }
  return { base, secret, slug: tenant.slug, accountId };
}

async function callCp<T>(t: CpTarget, path: string, body: Record<string, unknown>): Promise<T> {
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
    // 계정 서버가 안 잡히면 **여기서 멈춘다** — 반쯤 지운 상태를 만들지 않는다.
    throw new HttpError(502, "계정 서버에 연결하지 못했습니다 — 잠시 뒤 다시 시도해 주세요.");
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 본문이 JSON 이 아니면 아래 상태코드로만 판단 */ }
  if (!res.ok) {
    const msg = (json && typeof json === "object" && "error" in json) ? String((json as { error: unknown }).error) : "";
    throw new HttpError(res.status === 400 ? 400 : 502, msg || `계정 서버 오류(${res.status})`);
  }
  return json as T;
}

interface PlanResp {
  email: string;
  blocking_teams: string[];
  solo_workspaces: string[];
  memberships: string[];
}

export const meAccountDeleteCapabilities: Capability[] = [
  restRead("me_account_delete_plan", "내 탈퇴 미리보기",
    "탈퇴하면 무엇이 지워지고 무엇이 남는지 — 실행과 같은 판정을 계정 서버에서 받아온다(화면이 말한 것과 실제가 갈리지 않게).",
    [{ method: "GET", paths: ["/api/ui/me/account-delete-plan"], parse: () => ({}) }],
    async (_input: Record<string, unknown>, user: LivelyUser) => {
      const t = await resolveTarget(user);
      const p = await callCp<PlanResp>(t, "/api/tenant/account-delete-plan", {});
      return {
        email: p.email,
        blocking_teams: p.blocking_teams ?? [],
        solo_workspaces: p.solo_workspaces ?? [],
        memberships: p.memberships ?? [],
      };
    }),

  restRead("me_account_delete", "회원 탈퇴",
    "이 계정을 탈퇴시킨다. 되돌릴 수 없다 — 확인 문구(로그인 이메일)를 그대로 받아야 실행된다.",
    [{ method: "POST", paths: ["/api/ui/me/account-delete"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const confirm = str(input.confirm, "confirm");
      const t = await resolveTarget(user);
      const r = await callCp<{ ok: boolean; deleted_workspaces: string[]; left_workspaces: string[] }>(
        t, "/api/tenant/account-delete", { confirm_email: confirm },
      );
      return { ok: true, deleted_workspaces: r.deleted_workspaces ?? [], left_workspaces: r.left_workspaces ?? [] };
    },
    false,
    { confirm: z.string().describe("로그인 이메일 — 그대로 입력해야 실행된다") }),
];

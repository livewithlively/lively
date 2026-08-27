// delivery ▸ me-account-delete — 회원 탈퇴를 **이 앱 안에서** 끝내는 표면 (#1876)
//
// 왜 여기 있나: 처음엔 설정 창이 app.lvly.io 로 새 탭을 띄웠는데 — **로그인해서 쓰고 있는 사람이 탈퇴하려면
//  밖에 나가서 다시 로그인해야 하는** 화면이 됐다(실측 신고). 그건 기능이 없는 것과 같고, 탈퇴는
//  법으로 보장돼야 하는 경로다(개인정보보호법 §39조의7).
//  → 화면과 확인은 **여기**서 받는다. 사람은 이 앱을 떠나지 않는다.
//
// 배포 종류에 따라 '탈퇴'가 가리키는 것이 다르다. 갈림은 `workspace_hub_url` 노브 하나다(그 노브의
//  정의 자체가 "null = 셀프호스트"이고, 화면의 항목 노출도 같은 값을 본다 — 축을 둘로 늘리지 않는다).
//
//  ① 매니지드(hub_url 있음) — 계정은 코어가 아니라 컨트롤플레인(app.lvly.io)이 갖고 있다.
//     화면은 여기, 실행만 CP 에 위임한다. 신뢰 재료는 새로 만들지 않았다:
//      · 내가 누구인지 = 이 요청의 사람 세션(principal)
//      · 그 사람의 CP 계정 id = `org_member.identities` 의 `lvly_account`(프로비저닝이 심는다)
//      · CP 를 부를 자격 = CP↔코어가 이미 공유하는 `LIVELY_TENANT_HEADER_SECRET`(종전엔 CP→코어 한 방향)
//
//  ② 셀프호스트(hub_url 없음) — '계정'이라는 상위 단위가 없다. 여기서 탈퇴 = **이 워크스페이스에서
//     내 구성원 자격을 내리는 것**이다. 종전엔 이 배포에 항목 자체를 안 그렸는데, 그건 틀렸다:
//     탈퇴를 막을 근거가 아니라 **탈퇴가 가리킬 대상이 다를 뿐**이고, 끄는 스위치는 이미 다 있었다.
//
//     `state='inactive'` 하나가 다음을 전부 닫는다(새로 만든 것이 아니라 이미 있던 것들이다):
//       auth/sessions.ts:45        지금 살아 있는 웹 세션 즉시 무효
//       auth/local-accounts.ts:85  비밀번호 로그인 차단(SELECT … state='active')
//       ee/auth/oidc-login.ts:142,150  구글 재로그인 차단 — sub 로도, 이메일로도
//       org/auth/device-auth.ts:135    CLI 기기 승인 토큰 발급 차단
//       org/store/oauth.ts:190,294,356 외부 연동 토큰 차단
//       org/store/members.ts:527   fireMemberDeactivated → 앱 동의·앱 세션 회수
//
//     ⚠ 그래서 이메일을 **지우지 않는다.** oidc-login 의 ② 갈래는 `memberIdByEmail`(state 필터 없음)로
//      비활성 행까지 찾아 `inactive` 로 거절한다. 이메일을 지우면 그 조회가 빗나가고, allowed_domains 가
//      켜진 조직에서는 ③ 자동가입이 **같은 사람을 새 구성원으로 다시 들여보낸다** — 탈퇴가 무효가 된다.
//      즉 여기서 이메일은 '남은 개인정보'가 아니라 **재입장을 막는 자물쇠**다. 실제 파기는 별도 축(#1875).

import { z } from "zod";
import type { Capability } from "../types.js";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { getMember, listMembers, upsertMember } from "../../org/store.js";
import { getRuntimeConfig } from "../../org/store/runtime-config.js";
import { getOrgProfile } from "../../org/store/profile.js";
import { clearMemberPassword } from "../../auth/local-accounts.js";
import { currentTenant } from "../../org/tenant-context.js";
import { actorOf, restRead, str } from "./shared.js";

interface CpTarget { base: string; secret: string; slug: string; accountId: string; }

/** 이 배포가 매니지드인가 — 노브 하나로 가른다(화면의 항목 노출과 같은 값을 본다). */
async function hubOrigin(): Promise<string | null> {
  const cfg = await getRuntimeConfig();
  const hub = (cfg.workspace_hub_url || "").trim();
  if (!hub) return null;
  try { return new URL(hub).origin; } catch {
    // 노브가 켜져 있는데 주소가 깨졌다 — 셀프호스트로 떨어뜨리면 **엉뚱한 대상을 지운다**. 여기서 끊는다.
    throw new HttpError(400, "계정 서버 주소가 올바르지 않습니다 — 관리자에게 알려 주세요.");
  }
}

/** 매니지드에서 이 요청을 CP 로 넘길 수 있나 — 하나라도 없으면 반쯤 구성된 박스다. 끊는다. */
async function resolveTarget(user: LivelyUser, base: string): Promise<CpTarget> {
  const secret = (process.env.LIVELY_TENANT_HEADER_SECRET || "").trim();
  const tenant = currentTenant();
  if (!secret || !tenant) {
    throw new HttpError(400, "이 워크스페이스는 라이블리가 운영하는 계정 체계를 쓰지 않습니다 — 탈퇴는 관리자에게 요청하세요.");
  }
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

// ── 셀프호스트 갈래 ──────────────────────────────────────────────────────────

/** 확인 문구로 쓸 값. 이메일이 없으면 탈퇴를 열지 않는다 — 타이핑 확인의 근거가 사라지고,
 *  재입장을 막는 자물쇠(위 ⚠)도 없는 구성원이라 관리자 경로가 맞다(org_member_reset_password 선례). */
async function selfhostMe(user: LivelyUser) {
  const me = await getMember(actorOf(user));
  if (!me) throw new HttpError(403, "사용자 신원이 없습니다");
  const email = (me.email || "").trim();
  if (!email) {
    throw new HttpError(400, "이 구성원에는 이메일이 없어 본인 확인을 할 수 없습니다 — 탈퇴는 관리자에게 요청하세요.");
  }
  return { me, email };
}

/** 내가 나가면 이 워크스페이스에 활성 관리자가 0이 되는가.
 *  ⚠ 막지 않으면 **아무도 구성원을 들이거나 설정을 바꿀 수 없는 박스**가 남는다 — 되돌릴 방법이 화면에 없다.
 *   매니지드의 '팀 주인이라 막힘'과 같은 자리의 같은 이유다(주인 없는 것을 남기지 않는다). */
export function wouldOrphanAdmins(meId: string, meScopes: string[], all: Array<{ id: string; state: string; scopes: string[] }>): boolean {
  if (!meScopes.includes("admin")) return false;   // 내가 관리자가 아니면 애초에 줄어들 것이 없다
  return !all.some((m) => m.id !== meId && m.state === "active" && m.scopes.includes("admin"));
}

// ── 표면 ────────────────────────────────────────────────────────────────────

export const meAccountDeleteCapabilities: Capability[] = [
  restRead("me_account_delete_plan", "내 탈퇴 미리보기",
    "탈퇴하면 무엇이 지워지고 무엇이 남는지 — 실행과 같은 판정을 받아온다(화면이 말한 것과 실제가 갈리지 않게).",
    [{ method: "GET", paths: ["/api/ui/me/account-delete-plan"], parse: () => ({}) }],
    async (_input: Record<string, unknown>, user: LivelyUser) => {
      const base = await hubOrigin();
      if (!base) {
        const { me, email } = await selfhostMe(user);
        const all = await listMembers();
        const profile = await getOrgProfile();
        return {
          mode: "selfhost",
          email,
          workspace: profile.display_name || profile.name || "이 워크스페이스",
          last_admin: wouldOrphanAdmins(me.id, me.scopes, all),
          blocking_teams: [], solo_workspaces: [], memberships: [],
        };
      }
      const t = await resolveTarget(user, base);
      const p = await callCp<PlanResp>(t, "/api/tenant/account-delete-plan", {});
      return {
        mode: "managed",
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
      const base = await hubOrigin();

      if (!base) {
        const { me, email } = await selfhostMe(user);
        // ⚠ 화면만 믿지 않는다 — 타이핑 확인을 서버에서 다시 맞춘다(대소문자는 봐주지 않는다).
        if (confirm.trim().toLowerCase() !== email.toLowerCase()) {
          throw new HttpError(400, "확인 문구가 이메일과 다릅니다");
        }
        // ⚠ 차단 검사는 **아무것도 건드리기 전에**. 반쯤 실행된 탈퇴를 남기지 않는다.
        const all = await listMembers();
        if (wouldOrphanAdmins(me.id, me.scopes, all)) {
          throw new HttpError(400, "이 워크스페이스의 마지막 관리자라 지금은 탈퇴할 수 없습니다 — 다른 분에게 관리자 권한을 넘긴 뒤에 다시 시도해 주세요.");
        }
        // 이 한 줄이 세션·비번·구글·기기·외부연동·앱동의를 전부 닫는다(파일 머리말 참조).
        //  upsertMember 가 감사(org_member update)를 남기고 fireMemberDeactivated 를 부른다.
        await upsertMember({ id: me.id, kind: "human", state: "inactive" }, me.id, "web");
        // 비번 해시는 남길 이유가 없다 — state 를 되돌려도 옛 비밀번호가 되살아나지 않게.
        await clearMemberPassword(me.id);
        return { ok: true, mode: "selfhost", deleted_workspaces: [], left_workspaces: [] };
      }

      const t = await resolveTarget(user, base);
      const r = await callCp<{ ok: boolean; deleted_workspaces: string[]; left_workspaces: string[] }>(
        t, "/api/tenant/account-delete", { confirm_email: confirm },
      );
      return { ok: true, mode: "managed", deleted_workspaces: r.deleted_workspaces ?? [], left_workspaces: r.left_workspaces ?? [] };
    },
    false,
    { confirm: z.string().describe("로그인 이메일 — 그대로 입력해야 실행된다") }),
];

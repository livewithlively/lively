// delivery ▸ liv — 리브 홈이 읽는 현황 하나(#1631).
//
//  리브는 **자기 판정을 갖지 않는다.** 온보딩·파이프라인·노드 현황을 서버가 이미 계산한 것으로 읽어
//  카드로 옮길 뿐이다. 그래서 여기가 하는 일은 셋뿐이다 — ①흩어진 조회를 한 번에 모으고 ②순수 판정
//  (livFindings·livHomeMode)에 넘기고 ③화면과 스킬이 **같은 답**을 보게 한다.
//
//  ⚠ **조회 실패는 그 축을 빼는 것으로 끝낸다**(전체를 500 으로 만들지 않는다). 리브 홈은 워크스페이스가
//   덜 갖춰졌을 때 뜨는 화면이라, 아직 없는 테이블·꺼진 기능 때문에 화면 자체가 안 열리면 본말전도다.
//   대신 모르는 축은 **카드를 만들지 않는다** — 모르는 걸 '안 됐다'로 적으면 화면이 거짓말한다.
import { z } from "zod";
import type { Capability } from "../types.js";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { restRead } from "./shared.js";
import { livFindings, livTopFindings, livMature, type LivSnapshot } from "../../org/delivery/liv-findings.js";
import { livHomeMode } from "../../org/delivery/liv-home.js";

/** 화면이 한 번에 보여주는 카드 수. 전부 나열하면 아무것도 안 된다. */
const TOP = 3;

export const livCapabilities: Capability[] = [
  restRead("me_liv_home", "리브 홈 현황",
    "리브 홈이 읽는 현황 하나 — 홈에 무엇을 띄울지(모드)와 '지금 손볼 것' 카드 목록을 함께 반환한다. " +
    "판정은 온보딩·파이프라인의 기존 계산을 소비하며 여기서 새로 만들지 않는다. 카드마다 '리브에게 맡기기' 가 " +
    "세션에 보낼 프롬프트가 실려 있어, 사람이 터미널을 직접 안 봐도 일이 진행된다.",
    [{ method: "GET", paths: ["/api/ui/me/liv"], parse: (req) => ({ choice: (req.query?.choice ?? "") as string }) }],
    async (input: { choice?: string }, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const isAdmin = (user.scopes ?? []).includes("admin");

      // ── 조회 — 각자 독립적으로 실패한다(한 축이 죽어도 나머지 카드는 나온다). ──
      const org = isAdmin
        ? await import("../../org/delivery/onboarding.js")
          .then((m) => m.computeOnboardingStatus()).catch(() => null)
        : null;

      // 내 노드 — 등록/온라인. 이 사람 것만 센다(남의 PC 는 리브의 관심사가 아니다).
      const nodes = await (async () => {
        try {
          const [{ listNodes }, { nodeOnline }] = await Promise.all([
            import("../../node/store.js"), import("../../node/registry.js"),
          ]);
          const mine = (await listNodes()).filter((n) => n.owner_member === userId);
          return { registered: mine.length, online: mine.filter((n) => nodeOnline(n.id)).length };
        } catch { return null; }
      })();

      // 이관을 이미 보고했나 — done·skipped 둘 다 "다시 묻지 않는다"(잔소리 금지).
      const member = await import("../../org/delivery/onboarding.js")
        .then((m) => m.computeMemberOnboarding(userId)).catch(() => null);
      const migrateReported = (member?.items ?? []).some(
        (i: { key: string; state?: string }) => i.key === "migrate" && (i.state === "done" || i.state === "skipped"));

      // AI 로그인 — **3상**이다. 하나라도 로그인돼 있으면 true, 전부 '확실히 아님'이면 false, 그 외 null(모름).
      //  null 을 false 로 뭉개면 프로브가 못 돈 사람에게 영영 로그인 안내만 뜬다.
      const claudeLoggedIn = await import("../../terminal/terminal-sessions.js")
        .then(async (m) => {
          const accounts = await m.aiAccountStatus(user);
          if (accounts.some((a) => a.loggedIn === true)) return true;
          return accounts.length && accounts.every((a) => a.loggedIn === false) ? false : null;
        }).catch(() => null);

      // 리브가 이 사람에 대해 아는 것 — 무엇을 거절했는지가 여기 있고, 그게 카드 판정에 그대로 들어간다.
      const profile = await import("../../org/store.js")
        .then((m) => m.getLivProfile(userId)).catch(() => ({} as { declined?: Array<{ key: string }>; work?: unknown }));
      const declined = (profile.declined ?? []).map((d) => d.key);

      const snapshot: LivSnapshot = { isAdmin, org: org ? org.items : null, nodes, migrateReported, declined };
      const findings = livFindings(snapshot);
      const choice = input.choice === "liv" || input.choice === "dashboard" ? input.choice : null;
      const decision = livHomeMode({ claudeLoggedIn, choice, mature: livMature(findings) });

      return {
        mode: decision.mode, reason: decision.reason,
        findings: livTopFindings(findings, TOP),
        total: findings.length,
        // 화면이 상태를 그릴 근거 — 카드가 없어도 "무엇을 보고 그렇게 판단했나"를 보여줄 수 있어야 한다.
        context: { isAdmin, claudeLoggedIn, nodes, org: org ? { done: org.done, total: org.total, complete: org.complete } : null },
        // 리브가 세션에서 다시 묻지 않도록 프로필을 함께 준다(업무 방식·결정 이력). 거절 목록은 이미
        //  findings 에 반영됐지만, 리브가 "왜 그건 안 꺼내나"를 알아야 사람에게 설명할 수 있다.
        profile,
      };
    }, false, {
      // 사람이 홈을 명시적으로 고른 적이 있으면 그 값을 실어 보낸다 — **판정은 여전히 서버가 한다**(화면이
      //  자기 판정을 가지면 리브와 다른 답을 한다). 안 보내면 상태만 보고 정한다.
      choice: z.enum(["liv", "dashboard"]).optional()
        .describe("사람이 명시적으로 고른 홈 화면. 보내면 상태 판정을 이긴다(대시보드를 골랐으면 대시보드)."),
    }),

  // ── 리브가 알게 된 것을 남긴다(#1631) — **리브의 기억이 사는 자리** ──────────────────
  //  세션은 죽고 컨텍스트는 날아간다. 다음 세션의 리브가 같은 걸 다시 묻지 않으려면 그 사이의 앎이
  //  서버에 남아야 한다(기획 불변식: 리브 세션은 교체 가능하다).
  //  ⚠ **서버가 이미 아는 것은 쓰지 않는다.** 온보딩 진행·파이프라인·하네스는 각자 자리에서 라이브
  //   계산된다 — 여기 복제하면 두 개의 진실이 생기고 반드시 어긋난다(#850 의 결론).
  restRead("me_liv_profile_set", "리브 프로필 기록",
    "리브가 이 사람에 대해 알게 된 것을 남긴다 — 업무 방식(ASIS/TOBE) · 무엇을 왜 그렇게 설정했는지 · " +
    "무엇을 거절했는지. **주 사용자는 리브(AI)** 다. declined 에 카드 key 를 남기면 그 카드는 다시 뜨지 않는다 " +
    "(사람이 필요 없다고 한 것을 매번 권하면 잔소리가 된다). 서버가 스스로 아는 것(온보딩·파이프라인·하네스)은 " +
    "여기 쓰지 않는다 — 그건 각자 자리에서 계산된다.",
    [{ method: "POST", paths: ["/api/ui/me/liv-profile"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { appendLivProfile } = await import("../../org/store.js");
      const { assertNoHardSecrets } = await import("../../org/ingest/redact.js");
      const now = new Date().toISOString();
      const str = (v: unknown, max: number): string | undefined => {
        if (v == null) return undefined;
        const t = String(v).trim().slice(0, max);
        if (!t) return undefined;
        assertNoHardSecrets(t, "liv_profile"); // 프로필도 멤버 레코드다 — 평문 시크릿 차단
        return t;
      };
      const workIn = (input.work ?? null) as Record<string, unknown> | null;
      const decIn = (input.decision ?? null) as Record<string, unknown> | null;
      const dclIn = (input.declined ?? null) as Record<string, unknown> | null;
      if (!workIn && !decIn && !dclIn) throw new HttpError(400, "work · decision · declined 중 하나는 있어야 합니다");
      const declinedKey = dclIn ? str(dclIn.key, 80) : undefined;
      if (dclIn && !declinedKey) throw new HttpError(400, "declined 에는 key 가 필요합니다");
      const decWhat = decIn ? str(decIn.what, 500) : undefined;
      if (decIn && !decWhat) throw new HttpError(400, "decision 에는 what 이 필요합니다");
      return {
        profile: await appendLivProfile(userId, {
          work: workIn ? { asis: str(workIn.asis, 2000), tobe: str(workIn.tobe, 2000), by: workIn.by === "self" ? "self" : "ai", at: now } : undefined,
          decision: decIn ? { at: now, what: decWhat as string, why: str(decIn.why, 1000), by: str(decIn.by, 60) ?? "liv" } : undefined,
          declined: dclIn ? { at: now, key: declinedKey as string, why: str(dclIn.why, 500) } : undefined,
        }),
      };
    }, false, {
      work: z.object({ asis: z.string().optional(), tobe: z.string().optional(), by: z.enum(["ai", "self"]).optional() }).optional()
        .describe("이 사람이 무슨 일을 어떻게 하는가(asis)와 어떻게 하고 싶은가(tobe). 주면 통째로 갈아끼운다."),
      decision: z.object({ what: z.string(), why: z.string().optional(), by: z.string().optional() }).optional()
        .describe("무엇을 왜 그렇게 설정했는지. 뒤에 쌓인다."),
      declined: z.object({ key: z.string(), why: z.string().optional() }).optional()
        .describe("사람이 '안 하겠다'고 한 카드 key(예: org.embeddings). 그 카드는 이후 뜨지 않는다."),
    }),
];

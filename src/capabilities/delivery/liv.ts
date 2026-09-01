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
import type { LivProfile } from "../../org/store/members.js";
import { livFindings, livTopFindings, livMature, type LivSnapshot } from "../../org/delivery/liv-findings.js";
import { askTargetVerdict, askStillOpen } from "../../org/delivery/liv-secret.js";
import { livHomeMode } from "../../org/delivery/liv-home.js";

/** 화면이 한 번에 보여주는 카드 수. 전부 나열하면 아무것도 안 된다. */
const TOP = 3;

export const livCapabilities: Capability[] = [
  // ⚠ `mode`/`reason` 은 **더는 홈을 갈아치우는 데 쓰이지 않는다.** 리브가 홈을 덮던 설계를 걷어내고
  //  독립 페이지(#/liv)로 분리했다(대표 결정 — 기대한 화면이 아닌 게 뜨는 건 그 자체로 고장으로 읽힌다).
  //  두 필드는 "이 워크스페이스가 리브의 손이 필요한 상태인가"의 판정으로 남겨 둔다 — 능동 점검(v2)이
  //  먼저 말을 걸지 정할 때 쓸 자리다. **화면은 findings 만 그린다.**
  restRead("me_liv_home", "리브 홈 현황",
    "리브 화면이 읽는 현황 하나 — '지금 손볼 것' 카드 목록과 대기 중인 요청(자격·객관식·업로드)을 반환한다. " +
    "`mode` 는 홈 전환용이 아니라 '리브의 손이 필요한가' 판정이다(능동 점검용). " +
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
      const profile: LivProfile = await import("../../org/store.js")
        .then((m) => m.getLivProfile(userId)).catch(() => ({}));
      const declined = (profile.declined ?? []).map((d) => d.key);

      // 대기 중인 자격 요청 — 화면이 이걸 보고 **안전 입력칸**을 띄운다(§me_liv_ask_secret).
      //  대상 수집기가 사라졌거나 이미 채워졌으면 죽은 요청이라 내보내지 않는다.
      const secretAsk = await (async () => {
        const ask = profile.secret_ask;
        if (!ask) return null;
        // 객관식·업로드는 대상 검증이 필요 없다 — 시크릿만 "이미 채워졌나"를 확인한다.
        if (ask.kind && ask.kind !== "secret") return ask;
        try {
          const { listCollectors } = await import("../../org/store/collectors.js");
          return askStillOpen(ask as { collector_id: number; field: string }, await listCollectors()) ? ask : null;
        } catch { return null; }
      })();

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
        secretAsk,
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
      const onboarded = input.onboarded === true;   // #2039 — 처음 설정을 **끝냈다**는 표식
      const welcomeSeen = input.welcome_seen === true; // #2171 — 처음 설정으로 **보냈다**는 표식(끝냈다와 별개)
      // #2232 — [나중에 할게요] 미룸. **세 값**이다: true=미룸 · false=미룸 해제(화면을 다시 열었다) · 미지정=건드리지 않음.
      const welcomeDeferred = typeof input.welcome_deferred === "boolean" ? input.welcome_deferred : undefined;
      if (!workIn && !decIn && !dclIn && !onboarded && !welcomeSeen && welcomeDeferred === undefined) throw new HttpError(400, "work · decision · declined · onboarded · welcome_seen · welcome_deferred 중 하나는 있어야 합니다");
      const declinedKey = dclIn ? str(dclIn.key, 80) : undefined;
      if (dclIn && !declinedKey) throw new HttpError(400, "declined 에는 key 가 필요합니다");
      const decWhat = decIn ? str(decIn.what, 500) : undefined;
      if (decIn && !decWhat) throw new HttpError(400, "decision 에는 what 이 필요합니다");
      return {
        profile: await appendLivProfile(userId, {
          work: workIn ? { asis: str(workIn.asis, 2000), tobe: str(workIn.tobe, 2000), by: workIn.by === "self" ? "self" : "ai", at: now } : undefined,
          decision: decIn ? { at: now, what: decWhat as string, why: str(decIn.why, 1000), by: str(decIn.by, 60) ?? "liv" } : undefined,
          declined: dclIn ? { at: now, key: declinedKey as string, why: str(dclIn.why, 500) } : undefined,
          onboarded,
          welcomeSeen,
          welcomeDeferred,
        }),
      };
      // ⚠ mcp:true 여야 한다 — 리브에겐 **이게 유일한 기록 수단**이다. 종전엔 mcp:false 라 부팅 훅이
      //  `curl` 로 남기라고 시켰는데, v1 채팅에서 셸을 막으면서(#1665 안전선) 그 길이 끊겼다.
      //  도구가 없으면 리브는 "알게 된 것"을 어디에도 못 남기고, 다음 대화의 리브가 그걸 모른다 —
      //  그건 "리브가 기억한다"(#1663)가 통째로 무너지는 것이라 조용히 넘어갈 수 없다.
    }, true, {
      work: z.object({ asis: z.string().optional(), tobe: z.string().optional(), by: z.enum(["ai", "self"]).optional() }).optional()
        .describe("이 사람이 무슨 일을 어떻게 하는가(asis)와 어떻게 하고 싶은가(tobe). 주면 통째로 갈아끼운다."),
      decision: z.object({ what: z.string(), why: z.string().optional(), by: z.string().optional() }).optional()
        .describe("무엇을 왜 그렇게 설정했는지. 뒤에 쌓인다."),
      declined: z.object({ key: z.string(), why: z.string().optional() }).optional()
        .describe("사람이 '안 하겠다'고 한 카드 key(예: org.embeddings). 그 카드는 이후 뜨지 않는다."),
      onboarded: z.boolean().optional()
        .describe("처음 설정(#/welcome)을 끝냈다는 표식(#2039). 찍히면 그 사람에겐 어느 브라우저에서도 처음 설정이 다시 뜨지 않는다."),
      welcome_seen: z.boolean().optional()
        .describe("처음 설정(#/welcome)으로 **자동으로 보냈다**는 표식(#2171) — 끝냈다는 뜻이 아니다. " +
          "답 없이 보기만 한 사람에겐 자동 진입을 다시 하지 않는다. 하다 만 자리가 있으면 그 장면으로 돌아간다(#2232)."),
      welcome_deferred: z.boolean().optional()
        .describe("사람이 [나중에 할게요] 로 처음 설정을 **미뤘다**는 표식(#2232). true 면 하다 만 자리가 있어도 자동으로 끌고 가지 않고 " +
          "홈의 «이어서 하기»로만 안내한다. false 면 미룸을 푼다(사람이 처음 설정을 다시 연 순간)."),
    }),

  // ── 리브가 나에 대해 아는 것을 **화면이 읽는다**(#1843) ──────────────────────────────
  //
  //  왜 따로 필요한가: 이 값들은 리브 홈(me_liv_home)이 이미 실어 나르지만, 그건 온보딩 판정·노드 목록·
  //   AI 로그인 프로브까지 한꺼번에 도는 무거운 조회다. [내 프로필 · 환경설정] 창은 "리브가 나에 대해
  //   알게 된 것"만 있으면 되므로 그 한 조각만 얇게 연다(POST /api/ui/me/liv-profile 과 같은 경로의 GET).
  //
  //  ⚠ 이 값들은 **세션에 주입되지 않는다** — 주입되는 개인 층은 org_member.body_md 뿐이다(publish.ts).
  //   그래서 창은 이걸 '이미 반영된 것'처럼 보여주면 안 되고, [내 규칙에 반영]으로 body_md 에 담게 한다.
  //  대기 중인 요청(secret_ask)·대화 세션(chat)은 리브 화면 소관이라 여기서 내보내지 않는다.
  restRead("me_liv_profile_get", "리브가 나에 대해 아는 것",
    "리브가 온보딩 대화에서 알게 된 내 업무 방식(asis/tobe)과 내가 고른 답들을 돌려준다 — **본인 것만**. " +
    "[내 프로필 · 환경설정] 창의 [AI 개인 규칙]이 이 값으로 '온보딩에서 알려주신 것' 칸을 채운다.",
    [{ method: "GET", paths: ["/api/ui/me/liv-profile"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { getLivProfile } = await import("../../org/store.js");
      // fail-open — 리브를 한 번도 안 쓴 사람(행 없음)은 빈 프로필이 정답이다. 창이 안 열리면 안 된다.
      const p: LivProfile = await getLivProfile(userId).catch(() => ({}));
      return { work: p.work ?? null, answers: p.answers ?? [], decisions: p.decisions ?? [] };
    }),

  // ── 자격 받기(#1631) — **사람을 다른 탭으로 보내지 않기 위한 자리** ────────────────────
  //
  //  왜 이게 필요한가(실측 2회): 리브는 두 번 다 시크릿을 **채팅에 붙여넣으라고** 했고, 사람이 겁먹고
  //   되물은 뒤에야 화면으로 돌렸다. 그리고 화면으로 돌릴 때는 **없는 메뉴 경로를 지어냈다**
  //   ("왼쪽 메뉴의 관리 → 외부 자료 수집"; 실제로 좌측 메뉴가 없다). 둘 다 안내를 다듬어 고칠 문제가
  //   아니다 — **리브 화면에서 끝나지 않는 구조**가 원인이다.
  //
  //  그래서 계약을 바꾼다: 리브는 "무엇이 필요한지"만 말하고(ask), **값은 화면이 받아 금고로 직행**한다.
  //   - 값은 대화·트랜스크립트·모델 컨텍스트 어디에도 안 남는다.
  //   - 사람은 리브 화면을 벗어나지 않는다(탭 이동·경로 안내 자체가 사라진다).
  //   - 넣을 자리는 **서버가 저장해 둔 요청**에서만 온다 — 브라우저가 대상을 바꿔 보낼 수 없다.
  restRead("me_liv_ask_secret", "자격 입력칸 띄우기",
    "리브가 사람에게 받아야 하는 자격 하나를 **요청**한다 — 리브 화면에 안전 입력칸이 뜬다. " +
    "⚠ 시크릿을 대화로 받지 마라. 사람에게 다른 탭·메뉴로 가라고 하지도 마라. 이 도구를 쓰면 그 자리에서 끝난다. " +
    "값은 화면이 받아 곧바로 금고로 넣고, 너는 값을 보지 못한다(설정됐는지 여부만 확인된다).",
    [{ method: "POST", paths: ["/api/ui/me/liv-secret-ask"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { setLivSecretAsk } = await import("../../org/store.js");

      // 취소 — 더는 필요 없어졌으면 칸을 내린다(사람 화면에 죽은 입력칸을 남기지 않는다).
      if (input.cancel === true) return { ask: null, profile: await setLivSecretAsk(userId, null) };

      const collectorId = Number(input.collector_id);
      const field = String(input.field ?? "").trim();
      if (!Number.isInteger(collectorId) || collectorId <= 0) throw new HttpError(400, "collector_id 가 필요합니다");
      if (!field) throw new HttpError(400, "field 가 필요합니다");

      // **대상 검증** — 판정은 순수 모듈이 한다(liv-secret.ts). 여기서는 그 결과를 HTTP 로 옮길 뿐이다.
      const { listCollectors } = await import("../../org/store/collectors.js");
      const c = (await listCollectors()).find((x) => x.id === collectorId);
      const verdict = askTargetVerdict(c, field);
      if (!verdict.ok) {
        if (verdict.reason === "no-collector") throw new HttpError(404, "그 수집기를 찾을 수 없습니다");
        if (verdict.reason === "not-a-secret-field") throw new HttpError(400, `${field} 은(는) 이 수집기의 자격 칸이 아닙니다`);
        throw new HttpError(409, "이 게이트웨이는 자격을 안전하게 보관할 수 없습니다(마스터키 미설정) — 운영자에게 알려주세요");
      }
      const f = c!.fields.find((x) => x.key === field)!;

      const str = (v: unknown, max: number): string | undefined => {
        const t = String(v ?? "").trim().slice(0, max);
        return t || undefined;
      };
      const ask = {
        at: new Date().toISOString(),
        collector_id: collectorId, field,
        label: str(input.label, 80) ?? f.label ?? field,
        why: str(input.why, 300),
        hint: str(input.hint, 120) ?? f.hint ?? undefined,
      };
      await setLivSecretAsk(userId, ask);
      return { ask };
      // ⚠ **MCP 로 노출한다**(mcp=true). 리브가 쓰라고 만든 도구인데 도구 목록에 없으면 못 쓴다 —
      //  실측: 리브가 ToolSearch 를 세 번 돌리고 REST 경로를 세 번 추측하느라 96초를 태웠고,
      //  그 사이 사람에게는 "칸이 떴을 거예요"라고 먼저 말해 버렸다(아직 안 떴는데).
    }, true, {
      collector_id: z.number().int().positive().optional().describe("자격을 넣을 수집기 id"),
      field: z.string().optional().describe("그 수집기의 시크릿 필드 key(예: token)"),
      label: z.string().optional().describe("칸 이름 — 사람이 읽는다. 없으면 프리셋 라벨."),
      why: z.string().optional().describe("왜 필요한지 한 줄. 이유를 모르면 사람은 겁이 나서 멈춘다."),
      hint: z.string().optional().describe("값이 어떻게 생겼는지(예: ntn_ 로 시작하는 긴 문자열)."),
      cancel: z.boolean().optional().describe("true 면 대기 중인 요청을 내린다."),
    }),

  restRead("me_liv_put_secret", "자격 저장(화면 전용)",
    "리브 화면의 안전 입력칸이 받은 값을 금고에 넣는다. **넣을 자리는 서버에 저장된 요청에서만 온다** — " +
    "요청이 없으면 거부한다. 값은 응답에도, 로그에도, 대화에도 남지 않는다. (사람이 쓰는 자리다. 리브가 부를 일이 없다.)",
    [{ method: "POST", paths: ["/api/ui/me/liv-secret"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { getLivProfile, setLivSecretAsk } = await import("../../org/store.js");
      const ask = (await getLivProfile(userId)).secret_ask;
      // 대기 중인 게 **자격 요청일 때만** 받는다 — 객관식·업로드가 떠 있는데 값이 날아오면 그건 잘못된 호출이다.
      if (!ask || (ask.kind && ask.kind !== "secret")) throw new HttpError(409, "지금 받기로 한 자격이 없습니다");

      const value = String(input.value ?? "");
      if (!value.trim()) throw new HttpError(400, "값이 비어 있습니다");
      if (value.length > 8192) throw new HttpError(400, "값이 너무 깁니다");

      const { upsertCollector } = await import("../../org/store/collectors.js");
      // ⚠ 대상은 **저장된 요청**에서만 — 브라우저가 보낸 것을 쓰지 않는다(다른 수집기로 새는 것을 막는다).
      //  id 로 보낸다: key 로 보내면 중복키로 500 이 난다(#1631 실측).
      await upsertCollector({ id: ask.collector_id, secrets: { [ask.field]: value } }, userId, "liv");
      await setLivSecretAsk(userId, null);
      return { ok: true, field: ask.field };  // 값은 절대 되돌려주지 않는다
    }, false, {
      value: z.string().describe("사람이 입력한 자격 값. 서버가 즉시 암호화해 저장하고 버린다."),
    }),

  // ── 객관식으로 묻기(#1631) — **사람은 고르기만, 답은 저절로 구조화** ──────────────────
  //
  //  실측에서 사람이 가장 오래 멈춘 자리가 자유서술이었다("지금까지 어디에 쌓고 계셨나요?").
  //   없는 말을 지어내야 해서 어렵고, 답이 제각각이라 우리도 개선점을 못 뽑는다. 고르게 하면 둘 다 풀린다.
  //  ⚠ `key` 는 통계의 축이다 — 문구를 다듬어도 key 는 바꾸지 마라(집계가 갈라진다).
  restRead("me_liv_ask_choice", "객관식으로 묻기",
    "리브 화면에 **고르는 질문**을 띄운다. 사람이 고르면 그 답이 구조화돼 쌓이고(통계), 너에게도 전달된다. " +
    "⚠ 사람에게 자유서술을 시키지 마라 — 없는 말을 지어내는 건 어렵다. 선택지를 주는 게 기본이다. " +
    "목록에 없을 수 있으면 allow_other 로 탈출구를 열어라(거기 적히는 것이 다음에 만들 커넥터 후보다).",
    [{ method: "POST", paths: ["/api/ui/me/liv-choice-ask"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { setLivSecretAsk } = await import("../../org/store.js");
      if (input.cancel === true) return { ask: null, profile: await setLivSecretAsk(userId, null) };

      const key = String(input.key ?? "").trim().slice(0, 60);
      const question = String(input.question ?? "").trim().slice(0, 300);
      if (!/^[a-z0-9_.-]+$/.test(key)) throw new HttpError(400, "key 는 소문자·숫자·_.- 만 씁니다(통계 축이라 안정적이어야 합니다)");
      if (!question) throw new HttpError(400, "question 이 필요합니다");
      const raw = Array.isArray(input.options) ? input.options : [];
      const options = raw.slice(0, 12).map((o) => {
        const r = (o ?? {}) as Record<string, unknown>;
        const id = String(r.id ?? "").trim().slice(0, 40);
        const label = String(r.label ?? "").trim().slice(0, 80);
        if (!/^[a-z0-9_.-]+$/.test(id) || !label) throw new HttpError(400, "각 선택지에는 id(소문자 슬러그)와 label 이 필요합니다");
        const hint = String(r.hint ?? "").trim().slice(0, 120);
        return hint ? { id, label, hint } : { id, label };
      });
      if (options.length < 2) throw new HttpError(400, "선택지는 2개 이상이어야 합니다");
      if (new Set(options.map((o) => o.id)).size !== options.length) throw new HttpError(400, "선택지 id 가 중복입니다");

      const ask = {
        at: new Date().toISOString(), kind: "choice" as const, key, question,
        why: String(input.why ?? "").trim().slice(0, 300) || undefined,
        options, multi: input.multi === true, allow_other: input.allow_other === true,
      };
      await setLivSecretAsk(userId, ask);
      return { ask };
    }, true, {
      key: z.string().optional().describe("통계 축이 되는 안정된 key(예: context_sources). 문구가 바뀌어도 유지한다."),
      question: z.string().optional().describe("사람에게 보일 질문 한 줄."),
      why: z.string().optional().describe("왜 묻는지 한 줄."),
      options: z.array(z.object({ id: z.string(), label: z.string(), hint: z.string().optional() })).optional()
        .describe("선택지 2~12개. id 는 소문자 슬러그(집계 값), label 은 사람 말."),
      multi: z.boolean().optional().describe("복수 선택 허용(쓰는 도구를 다 고르기 등)."),
      allow_other: z.boolean().optional().describe("'그 외' 자유입력 허용 — 목록에 없는 것을 놓치지 않는다."),
      cancel: z.boolean().optional().describe("true 면 대기 중인 질문을 내린다."),
    }),

  restRead("me_liv_answer", "고른 답 저장(화면 전용)",
    "리브 화면에서 사람이 고른 답을 남긴다. 같은 key 는 최신 하나로 갈아끼운다. (사람이 쓰는 자리다.)",
    [{ method: "POST", paths: ["/api/ui/me/liv-answer"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { getLivProfile, appendLivAnswer } = await import("../../org/store.js");
      const ask = (await getLivProfile(userId)).secret_ask;
      if (!ask || ask.kind !== "choice") throw new HttpError(409, "지금 답할 질문이 없습니다");

      // ⚠ 무엇을 골랐는지는 **저장된 질문의 선택지 안에서만** 인정한다 — 브라우저가 임의 값을 넣어
      //  집계를 오염시키지 못하게. 목록 밖은 other(자유입력)로만 들어온다.
      const valid = new Set(ask.options.map((o) => o.id));
      const picked = (Array.isArray(input.choices) ? input.choices : []).map(String).filter((c) => valid.has(c));
      const other = ask.allow_other ? String(input.other ?? "").trim().slice(0, 200) : "";
      if (!picked.length && !other) throw new HttpError(400, "하나 이상 고르거나 직접 적어 주세요");
      if (!ask.multi && picked.length > 1) throw new HttpError(400, "이 질문은 하나만 고를 수 있습니다");

      const profile = await appendLivAnswer(userId, {
        at: new Date().toISOString(), key: ask.key, question: ask.question,
        choices: picked, ...(other ? { other } : {}), by: "self",
      });
      // 리브가 무엇이 골라졌는지 알아야 이어갈 수 있으므로 라벨까지 되돌려준다.
      const labels = ask.options.filter((o) => picked.includes(o.id)).map((o) => o.label);
      return { ok: true, key: ask.key, choices: picked, labels, other: other || undefined, answers: profile.answers };
    }, false, {
      choices: z.array(z.string()).optional().describe("고른 선택지 id 들."),
      other: z.string().optional().describe("'그 외'로 직접 적은 것."),
    }),

  // ── 채팅으로 답한 것을 리브가 옮겨 적는다(#1631) ────────────────────────────────
  //
  //  왜 필요한가(실측): 리브가 객관식을 띄워도 **사람은 그냥 채팅으로 답한다.** 페르소나 A 는
  //   "카톡 단톡방·네이버 밴드"라고 말했는데 버튼을 안 눌러 통계에 한 줄도 안 남았다 —
  //   **가장 알고 싶은 것(커넥터 없는 소스)이 정확히 그렇게 유실된다.**
  //  그래서 리브가 옮겨 적을 수 있어야 한다. 다만 그냥 열면 리브가 답을 지어낼 수 있으므로
  //   `by:"liv"` 로 표시해 집계에서 **사람이 직접 고른 것과 나눠 센다**(by_self / by_liv).
  restRead("me_liv_record_answer", "채팅으로 받은 답을 옮겨 적기",
    "사람이 **버튼 대신 채팅으로** 답했을 때, 리브가 그 답을 구조화해 남긴다. " +
    "⚠ 사람이 실제로 말한 것만 적어라 — 짐작해서 채우지 마라. 집계에 `by:liv` 로 표시돼 사람이 직접 고른 것과 구분된다. " +
    "목록에 없던 도구(카카오톡·에버노트 등)는 `other` 에 그 이름 그대로 적어라 — 그게 다음에 만들 커넥터 후보다.",
    [{ method: "POST", paths: ["/api/ui/me/liv-record-answer"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const key = String(input.key ?? "").trim().slice(0, 60);
      if (!/^[a-z0-9_.-]+$/.test(key)) throw new HttpError(400, "key 는 소문자·숫자·_.- 만 씁니다");
      const choices = (Array.isArray(input.choices) ? input.choices : [])
        .map((c) => String(c).trim().slice(0, 40)).filter((c) => /^[a-z0-9_.-]+$/.test(c)).slice(0, 12);
      const other = String(input.other ?? "").trim().slice(0, 200);
      if (!choices.length && !other) throw new HttpError(400, "choices 나 other 중 하나는 있어야 합니다");
      const { appendLivAnswer } = await import("../../org/store.js");
      const profile = await appendLivAnswer(userId, {
        at: new Date().toISOString(), key, choices, ...(other ? { other } : {}),
        question: String(input.question ?? "").trim().slice(0, 300) || undefined, by: "liv",
      });
      return { ok: true, key, choices, other: other || undefined, answers: profile.answers };
    }, true, {
      key: z.string().optional().describe("통계 축(예: context_sources). 객관식으로 물었던 것과 같은 key 를 쓴다."),
      choices: z.array(z.string()).optional().describe("알려진 선택지 id 들(notion·slack·files·head 등)."),
      other: z.string().optional().describe("목록에 없던 것 — 그 이름 그대로(예: 카카오톡, 네이버 밴드). 커넥터 후보가 된다."),
      question: z.string().optional().describe("무엇을 물었는지(집계 표시용)."),
    }),

  restRead("org_liv_answers", "사람들이 고른 답 집계",
    "워크스페이스 구성원들이 리브의 질문에 무엇을 골랐는지 집계한다 — 개선점을 찾는 자리. " +
    "특히 `others`(목록에 없어 직접 적어낸 것)가 **다음에 만들 커넥터 후보**다. 사람 이름은 담기지 않는다.",
    [{ method: "GET", paths: ["/api/ui/org/liv-answers"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      if (!(user.scopes ?? []).includes("admin")) throw new HttpError(403, "관리자만 볼 수 있습니다");
      const { livAnswerStats } = await import("../../org/store.js");
      return { stats: await livAnswerStats() };
    }, true, {}),

  // ── 파일 올리기(#1631) — **로컬 폴더를 뒤지는 대신 사람이 끌어다 놓는다** ──────────────
  //  종전 설계는 노드를 켜고 그 PC 를 훑는 것이었는데, 컴맹에게 설치·노드 등록을 시키는 값이 너무 크다.
  //  파일 몇 개면 끝나는 일이면 **끌어다 놓는 게 훨씬 간편하다**(대표 판단).
  restRead("me_liv_ask_upload", "파일 올리기 요청",
    "리브 화면에 **파일 올리는 자리**를 띄운다. 사람이 올린 파일은 자료(source)로 저장돼 증류 대상이 된다. " +
    "⚠ 로컬 폴더를 뒤지려 하지 마라 — 파일 몇 개면 이게 훨씬 간편하다. 글자 파일만 된다(문서·메모·마크다운·CSV).",
    [{ method: "POST", paths: ["/api/ui/me/liv-upload-ask"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { setLivSecretAsk } = await import("../../org/store.js");
      if (input.cancel === true) return { ask: null, profile: await setLivSecretAsk(userId, null) };
      const ask = {
        at: new Date().toISOString(), kind: "upload" as const,
        label: String(input.label ?? "").trim().slice(0, 80) || "파일 올리기",
        why: String(input.why ?? "").trim().slice(0, 300) || undefined,
        accept_hint: String(input.accept_hint ?? "").trim().slice(0, 120) || undefined,
      };
      await setLivSecretAsk(userId, ask);
      return { ask };
    }, true, {
      label: z.string().optional().describe("올리는 자리의 이름(예: 회의록 파일)."),
      why: z.string().optional().describe("왜 필요한지 한 줄."),
      accept_hint: z.string().optional().describe("어떤 파일을 올리면 되는지 한 줄."),
      cancel: z.boolean().optional(),
    }),
];

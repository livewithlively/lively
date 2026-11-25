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
import { livFindings, livTopFindings, livMature, LIV_PROPOSALS_ON, type LivSnapshot } from "../../org/delivery/liv-findings.js";
import { livHomeMode } from "../../org/delivery/liv-home.js";

/** 화면이 한 번에 보여주는 카드 수. 전부 나열하면 아무것도 안 된다. */
const TOP = 3;

export const livCapabilities: Capability[] = [
  // ⚠ `mode`/`reason` 은 **더는 홈을 갈아치우는 데 쓰이지 않는다.** 리브가 홈을 덮던 설계를 걷어내고
  //  독립 페이지(#/liv)로 분리했다(대표 결정 — 기대한 화면이 아닌 게 뜨는 건 그 자체로 고장으로 읽힌다).
  //  두 필드는 "이 워크스페이스가 리브의 손이 필요한 상태인가"의 판정으로 남겨 둔다 — 능동 점검(v2)이
  //  먼저 말을 걸지 정할 때 쓸 자리다. **화면은 findings 만 그린다.**
  restRead("me_liv_home", "리브 홈 현황",
    "리브 화면이 읽는 현황 하나 — '지금 손볼 것' 카드 목록을 반환한다(AI 가 사람에게 건 요청은 세션 요청으로 옮겼다 — session_ask_list). " +
    "`mode` 는 홈 전환용이 아니라 '리브의 손이 필요한가' 판정이다(능동 점검용). " +
    "판정은 온보딩·파이프라인의 기존 계산을 소비하며 여기서 새로 만들지 않는다. 카드마다 '리브에게 맡기기' 가 " +
    "세션에 보낼 프롬프트가 실려 있어, 사람이 터미널을 직접 안 봐도 일이 진행된다. " +
    "⚠ 제안 카드는 지금 꺼져 있다(LIV_PROPOSALS_ON=false, 2026-09-14) — findings 는 빈 목록, total 은 0 이다.",
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

      const snapshot: LivSnapshot = { isAdmin, org: org ? org.items : null, nodes, migrateReported, declined };
      const findings = livFindings(snapshot);
      const choice = input.choice === "liv" || input.choice === "dashboard" ? input.choice : null;
      const decision = livHomeMode({ claudeLoggedIn, choice, mature: livMature(findings) });

      return {
        mode: decision.mode, reason: decision.reason,
        // 제안 카드는 꺼 둔다(LIV_PROPOSALS_ON — 원준 2026-09-14). 판정(mode)은 그대로 계산하고, 사람에게 내보내는
        //  카드와 개수만 비운다 — 화면(#/liv)은 빈 목록이면 조용한 첫 화면을 그린다.
        findings: LIV_PROPOSALS_ON ? livTopFindings(findings, TOP) : [],
        total: LIV_PROPOSALS_ON ? findings.length : 0,
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
      const onboarded = input.onboarded === true;   // #2039 — 처음 설정을 **끝냈다**는 표식
      const welcomeSeen = input.welcome_seen === true; // #2171 — 처음 설정으로 **보냈다**는 표식(끝냈다와 별개)
      // #2232 — [나중에 할게요] 미룸. **세 값**이다: true=미룸 · false=미룸 해제(화면을 다시 열었다) · 미지정=건드리지 않음.
      const welcomeDeferred = typeof input.welcome_deferred === "boolean" ? input.welcome_deferred : undefined;
      const collectDone = input.collect_done === true;   // #4213 T13 — 리브가 «처음 연결·처음 수집 끝» 을 찍는다(2턴 신호)
      const uploadDone = input.upload_done === true;     // #5060 — 화면의 백그라운드 올리기가 다 비었다(2턴이 기다리던 신호)
      const desktopSeen = input.desktop_seen === true;   // #5060 — 처음 설정을 데스크톱 앱 안에서 열었다(브라우저 탭이 접히는 신호)
      const shareGuideSeen = input.share_guide_seen === true;   // #5598 — «누가 무엇을 보나요» 첫 안내를 확인했다(화면이 찍는다)
      const welcomeFilmDue = input.welcome_film_due === true;    // #5598 — 처음 설정의 안내 카드를 넘겼다 → 셸에서 온보딩 영상을 띄울 차례
      const welcomeFilmSeen = input.welcome_film_seen === true;  // #5598 — 그 영상 창을 띄웠다
      if (!workIn && !decIn && !dclIn && !onboarded && !welcomeSeen && welcomeDeferred === undefined && !collectDone && !uploadDone && !desktopSeen && !shareGuideSeen && !welcomeFilmDue && !welcomeFilmSeen) throw new HttpError(400, "work · decision · declined · onboarded · welcome_seen · welcome_deferred · collect_done · upload_done · desktop_seen · share_guide_seen · welcome_film_due · welcome_film_seen 중 하나는 있어야 합니다");
      const declinedKey = dclIn ? str(dclIn.key, 80) : undefined;
      if (dclIn && !declinedKey) throw new HttpError(400, "declined 에는 key 가 필요합니다");
      const decWhat = decIn ? str(decIn.what, 500) : undefined;
      if (decIn && !decWhat) throw new HttpError(400, "decision 에는 what 이 필요합니다");
      const profile = await appendLivProfile(userId, {
        work: workIn ? { asis: str(workIn.asis, 2000), tobe: str(workIn.tobe, 2000), by: workIn.by === "self" ? "self" : "ai", at: now } : undefined,
        decision: decIn ? { at: now, what: decWhat as string, why: str(decIn.why, 1000), by: str(decIn.by, 60) ?? "liv" } : undefined,
        declined: dclIn ? { at: now, key: declinedKey as string, why: str(dclIn.why, 500) } : undefined,
        onboarded,
        welcomeSeen,
        welcomeDeferred,
        collectDone,
        uploadDone,
        desktopSeen,
        shareGuideSeen,
        welcomeFilmDue,
        welcomeFilmSeen,
      });
      //  (#5167) «다 올렸다» 를 받았다 — 파일 갈래면 리브를 정비 주기까지 기다리게 하지 않고 지금 연다(kickLivSecondTurn 머리말).
      if (uploadDone && profile.welcome?.flow === "files") {
        void import("../../org/liv/second-turn-sweep.js").then(({ kickLivSecondTurn }) => kickLivSecondTurn()).catch(() => { /* 다음 정비가 한다 */ });
      }
      return { profile };
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
      collect_done: z.boolean().optional()
        .describe("(리브) 처음 연결·처음 수집을 끝냈다는 표식(#4213 T13 — liv-connect 마지막 걸음). 찍히면 카테고리·정리 규칙을 세우는 " +
          "증류 지시(2턴)가 이 대화에 이어서 온다. 첫 보고·다음 연결 제안·초대 제안까지 마친 뒤에 찍는다. 처음 찍힌 시각을 지킨다."),
      upload_done: z.boolean().optional()
        .describe("(화면) 처음 설정에서 시작한 파일 올리기가 끝났다는 표식(#5060). 리브(AI)가 찍는 값이 아니다 — 화면의 백그라운드 올리기가 " +
          "다 비면 찍는다. 처음 설정에서 올리기를 시작한 칸에만 남고, 처음 찍힌 시각을 지킨다."),
      share_guide_seen: z.boolean().optional()
        .describe("(화면) «누가 무엇을 보나요» 첫 안내(#5598)를 확인했다는 표식. 리브(AI)가 찍는 값이 아니다 — 사람이 안내 카드의 " +
          "[확인했어요] 를 누르면 화면이 찍는다. 찍히면 어느 브라우저 · 앱에서도 그 안내가 다시 자동으로 뜨지 않는다. 처음 찍힌 시각을 지킨다."),
      welcome_film_due: z.boolean().optional()
        .describe("(화면) 처음 설정 인사 장면의 안내 카드를 끝까지 넘겼다는 표식(#5598). 리브(AI)가 찍는 값이 아니다. 찍힌 사람이 평소 화면으로 " +
          "돌아오면 온보딩 영상(기초)이 창으로 한 번 뜬다. 처음 찍힌 시각을 지킨다."),
      welcome_film_seen: z.boolean().optional()
        .describe("(화면) 그 온보딩 영상 창을 띄웠다는 표식(#5598). 리브(AI)가 찍는 값이 아니다. 찍히면 다시 자동으로 뜨지 않는다. 처음 찍힌 시각을 지킨다."),
      desktop_seen: z.boolean().optional()
        .describe("(화면) 처음 설정을 데스크톱 앱 안에서 열었다는 표식(#5060). 리브(AI)가 찍는 값이 아니다. 마지막 시각을 남기고, " +
          "브라우저에서 [앱 받기]를 누른 사람의 탭이 그 값을 보고 «앱에서 이어 하고 있어요» 로 접힌다."),
    }),

  // ── 리브가 나에 대해 아는 것을 **화면이 읽는다**(#1843) ──────────────────────────────
  //
  //  왜 따로 필요한가: 이 값들은 리브 홈(me_liv_home)이 이미 실어 나르지만, 그건 온보딩 판정·노드 목록·
  //   AI 로그인 프로브까지 한꺼번에 도는 무거운 조회다. [내 프로필 · 환경설정] 창은 "리브가 나에 대해
  //   알게 된 것"만 있으면 되므로 그 한 조각만 얇게 연다(POST /api/ui/me/liv-profile 과 같은 경로의 GET).
  //
  //  ⚠ 이 값들은 **세션에 주입되지 않는다** — 주입되는 개인 층은 org_member.body_md 뿐이다(publish.ts).
  //   그래서 창은 이걸 '이미 반영된 것'처럼 보여주면 안 되고, [내 규칙에 반영]으로 body_md 에 담게 한다.
  //  대화 세션(chat)은 리브 화면 소관이라 여기서 내보내지 않는다.
  restRead("me_liv_profile_get", "리브가 나에 대해 아는 것",
    "리브가 온보딩 대화에서 알게 된 내 업무 방식(asis/tobe)과 내가 고른 답들을 돌려준다 — **본인 것만**. " +
    "[내 프로필 · 환경설정] 창의 [AI 개인화]가 이 값으로 '온보딩에서 알려주신 것' 칸을 채운다.",
    [{ method: "GET", paths: ["/api/ui/me/liv-profile"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      const userId = user?.userId;
      if (!userId) throw new HttpError(401, "인증이 필요합니다");
      const { getLivProfile } = await import("../../org/store.js");
      // fail-open — 리브를 한 번도 안 쓴 사람(행 없음)은 빈 프로필이 정답이다. 창이 안 열리면 안 된다.
      const p: LivProfile = await getLivProfile(userId).catch(() => ({}));
      return { work: p.work ?? null, answers: p.answers ?? [], decisions: p.decisions ?? [], share_guide_seen_at: p.share_guide_seen_at ?? null, welcome_film_due_at: p.welcome_film_due_at ?? null, welcome_film_seen_at: p.welcome_film_seen_at ?? null };
    }),

  //  자격 입력칸 · 객관식 · 파일 올리기(옛 me_liv_ask_secret · me_liv_ask_choice · me_liv_ask_upload · 화면 전용 me_liv_put_secret · me_liv_answer)는
  //   리브 전용에서 **세션 요청**으로 옮겼다(#5713 — capabilities/session-ask.ts · asks/kinds/*). 어느 세션이든 걸고, 화면은 그 세션 곁칸의
  //   «요청» 칸에 뜬다. 옛 도구 이름 셋은 거기서 호환 별칭으로 계속 열려 있다.

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
];

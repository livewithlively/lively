// delivery ▸ hooks — 커스텀 훅 CRUD(runtime 권한) + 런너 fetch·실패 보고·주입 미리보기.
import type { Capability, CapabilityCtx } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { MEANING } from "../../org/delivery/meaning.js";
import { assertHookId } from "../../org/asset-id.js";
import { assertNoHardSecrets } from "../../org/ingest/redact.js";
import {
  getRuntimeConfig, listOrgHooks, listEnabledHooks, upsertOrgHook, removeOrgHook, recordHookFailures, type HookHarness
} from "../../org/store.js";
import { previewHooks } from "../../org/delivery/hooks-preview.js";
import { HOOK_HARNESSES, HOOK_HARNESSES_MSG, parseTargetMembers, restRead, restRuntime, str, wctx } from "./shared.js";

// 커스텀 훅(org_hook)이 붙을 수 있는 이벤트 — DB 제약(org_hook_event_chk)·run-custom 배선(runnerHooksBlock)과 일치 유지.
//  Claude 31개 이벤트 중 저빈도·유용한 라이프사이클만 노출(MessageDisplay 등 상시발화는 perf 위해 제외).
//  Codex(0.142.0 실측)는 이 중 **SessionEnd·Notification 을 뺀 8개**를 지원하고 러너도 그 8개에 배선된다
//  (kit/setup/user-install.mjs CODEX_RUNNER_EVENTS). 반대로 Codex 고유 이벤트 PermissionRequest·SubagentStart 는
//  아직 이 목록에 없어 조직 훅으로 등록할 수 없다 — 필요해지면 여기와 DB 제약(org_hook_event_chk)을 함께 넓힌다.
const HOOK_EVENTS = new Set(["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "Notification", "PreCompact", "PostCompact"]);

// 커스텀 훅 source_code 해소 — target_members 와 같은 '미지정=보존' 규약(#970).
//  ⚠ 종전엔 `str(input.source_code ?? "")` 로 **undefined 를 "" 로 강제**했다. store 의 보존 로직
//   (`h.source_code ?? before?.source_code`)은 nullish 에만 걸리는데 ""(비-nullish)가 이겨서, source_code 를
//   생략한 부분수정(예: target_members 만 변경)이 **훅 본문을 통째로 지웠다**(실제 데이터 소실 버그).
//  undefined(생략) → undefined 를 그대로 store 에 넘겨 보존에 위임. 문자열이면 검증 + 시크릿 스캔.
//  ""(명시적 빈 문자열)은 '지운다'는 명시적 의도이므로 그대로 통과(생략과 구분). null 등 비문자열은 str() 이 거부.
export function resolveHookSource(raw: unknown): string | undefined {
  if (raw === undefined) return undefined; // 미지정 = 변경 없음(store 가 기존 본문 유지)
  const s = str(raw, "source_code", 16384); // 타입·길이 검증(null·숫자 등 비문자열 거부)
  assertNoHardSecrets(s, "source_code"); // B20: 값이 있을 때만 평문 시크릿 hard-block
  return s;
}

// 커스텀 훅 matcher 해소(#970) — source 와 달리 **세 갈래**다: null 이 '전체 매칭'이라는 의미 있는 값이라서.
//  · 미지정(undefined) = 보존(store 가 기존 matcher 유지)
//  · 명시적 null 또는 "" = 전체 매칭(모든 툴). 스키마 "빈 값=전체"의 그 의미.
//  · 문자열 = 그 정규식 패턴.
//  종전엔 셋을 다 null 로 뭉개 store 가 '명시적 전체매칭'을 '미지정'과 못 갈라 무시했다(부분수정이 지움을 삼킴).
export function resolveHookMatcher(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined; // 미지정 = 보존
  if (raw === null || raw === "") return null; // 명시적 = 전체 매칭
  return str(raw, "matcher", 500);
}

export const hooksCapabilities: Capability[] = [
  // ════════ 커스텀 훅 CRUD (runtime 권한) ════════
  restRuntime("org_hooks", "커스텀 훅 목록",
    "조직 커스텀 훅 전체(소스 포함) — runtime 권한 전용. 멤버 런너 fetch 는 org_runner_hooks(별도).",
    [{ method: "GET", paths: ["/api/ui/org/hooks"], parse: () => ({}) }],
    async () => ({ hooks: await listOrgHooks(), meaning: MEANING["custom-hook"] })),
  restRuntime("org_hook_upsert", "커스텀 훅 추가·수정",
    "구성원 머신에서 실행되는 커스텀 훅을 저장한다(runtime). 본문은 멤버 디스크에 굳히지 않고 런너가 매 세션 fetch.",
    [{ method: "POST", paths: ["/api/ui/org/hook"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const id = assertHookId(input.id);
      // event 도 부분수정 보존(#970): 생략하면 기존 event 유지(store 위임). 신규 훅은 event 필수 — store 가 방어.
      //  단 제공되면 반드시 유효값이어야 한다(오타로 잘못된 event 를 저장하지 않게).
      const event = input.event === undefined ? undefined : str(input.event, "event", 40);
      if (event !== undefined && !HOOK_EVENTS.has(event)) throw new HttpError(400, `event 는 ${[...HOOK_EVENTS].join("|")} 만 허용됩니다`);
      // #970: harness·timeout_sec 도 source_code 와 같은 데이터소실 부류였다 — 생략 시 store 의 preserve
      //  (`?? before`)가 못 걸리게 항상 구체값('all'·10)을 넘겨, 부분수정이 이 필드를 기본값으로 되돌렸다.
      //  '미지정=보존'으로 통일(enabled·sort·target_members 와 동형). 신규 훅은 store 가 기본값으로 채운다.
      const harness = input.harness === undefined ? undefined : str(input.harness, "harness", 12);
      if (harness !== undefined && !HOOK_HARNESSES.has(harness)) throw new HttpError(400, HOOK_HARNESSES_MSG);
      const sourceCode = resolveHookSource(input.source_code); // #970: 생략=보존(undefined→store 위임), "" 만 지움
      const matcher = resolveHookMatcher(input.matcher); // #970: 생략=보존 / null·""=전체매칭 / 문자열=패턴
      const timeout = input.timeout_sec === undefined ? undefined : Number(input.timeout_sec);
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 1 || timeout > 120)) throw new HttpError(400, "timeout_sec 은 1~120 사이 정수여야 합니다");
      const targetMembers = parseTargetMembers(input.target_members); // #699: null/빈=전원, 배열=지정, undefined=보존
      const hook = await upsertOrgHook({
        id,
        label: input.label == null ? undefined : str(input.label, "label", 200).trim(),
        harness: harness as HookHarness | undefined, event, matcher, source_code: sourceCode,
        timeout_sec: timeout === undefined ? undefined : Math.floor(timeout),
        note: input.note == null ? undefined : str(input.note, "note", 500),
        // summary — 구성원 화면([내 스킬·훅])에 보이는 '쉬운 한 줄'(#1085). note(운영 메모)와 별개.
        summary: input.summary === undefined ? undefined : str(input.summary, "summary", 300),
        target_members: targetMembers,
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        sort: input.sort === undefined ? undefined : Number(input.sort) || 0,
      }, wctx(user, ctx));
      return { hook };
    }, {
      id: z.string().describe("훅 id(슬러그) — 있으면 수정, 없으면 생성"),
      event: z.enum(["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "Notification", "PreCompact", "PostCompact"])
        .optional()
        .describe("발화 라이프사이클 이벤트. Codex 는 SessionEnd·Notification 을 제외한 8개 지원(0.142 실측). 미전송=기존 유지(#970, 신규 훅은 필수)"),
      source_code: z.string().optional().describe("훅 본문(멤버 디스크에 굳히지 않고 런너가 매 세션 fetch). 평문 시크릿은 hard-block. 미전송=기존 유지, 빈 문자열=지움(#970)"),
      harness: z.enum(["claude", "codex", "openclaw", "opencode", "antigravity", "grok", "all"]).optional().describe("대상 하네스(기본 all). 미전송=기존 유지(#970)"),
      matcher: z.string().nullable().optional().describe("PreToolUse/PostToolUse 등에서 대상 툴 매칭 패턴. null/빈값=전체매칭, 미전송=기존 유지(#970)"),
      timeout_sec: z.number().int().min(1).max(120).optional().describe("실행 타임아웃 초(1~120, 기본 10)"),
      target_members: z.array(z.string()).nullable().optional().describe("이 훅을 받을 멤버 id 배열. null/빈=전원, 미전송=기존 유지(#699)"),
      label: z.string().optional().describe("훅 라벨(표시명)"),
      note: z.string().optional().describe("메모"),
      summary: z.string().optional().describe("구성원 화면에 보이는 쉬운 한 줄 설명(무슨 일을 하는 훅인지)"),
      enabled: z.boolean().optional().describe("활성 여부"),
      sort: z.number().optional().describe("정렬 순서"),
    }),
  restRuntime("org_hook_remove", "커스텀 훅 제거",
    "커스텀 훅을 제거한다 — 다음 세션부터 런너가 더는 fetch/실행하지 않는다(미접속 머신은 직전 상태 유지).",
    [{ method: "POST", paths: ["/api/ui/org/hook/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      await removeOrgHook(assertHookId(input.id), wctx(user, ctx));
      return { ok: true };
    }, {
      id: z.string().describe("제거할 훅 id — 다음 세션부터 런너가 fetch/실행하지 않는다(미접속 머신은 직전 상태 유지)"),
    }),

  // ── 훅 주입 가시화(J절) — 설치된 세션 훅이 각자 실제로 무엇을 주입하는지 최종 메시지 미리보기. ──
  //  읽기 전용(scope null = 인증만 — 공유 컨텍스트 가시화, org_preview/learn 과 동일 평면). 게이트웨이가 소스인
  //  부분은 previewMemberContext 단일 함수, 훅-로컬 템플릿은 설치 파일에서 추출(드리프트 0). redact choke-point 통과.
  restRead("org_hooks_preview", "훅 주입 미리보기",
    "설치된 세션 훅(session-preload·work-flag·stop-writeback-gate)이 각자 세션 컨텍스트에 실제로 주입하는 최종 메시지를 충실도(exact/approximate)와 함께 반환한다.",
    [{ method: "GET", paths: ["/api/ui/org/hooks/preview"], parse: () => ({}) }],
    // #1291 — 요청자 신원으로 렌더(미리보기 = 그 사람의 실제 주입). 신원이 없으면 공개 맥락만.
    async (_input: unknown, user: LivelyUser) => previewHooks((user as { userId?: string } | undefined)?.userId || undefined)),

  // ── 런너 fetch — 멤버 런너(run-custom.mjs)가 매 세션 호출. 인증된 멤버면 OK(scope null). ──
  // 멤버 머신이 그 훅을 '실행'하므로 source 를 받는 게 정상(관리 목록 org_hooks 와 달리 redact 안 함).
  restRead("org_runner_hooks", "런너 훅 fetch",
    "멤버 런너가 현재 활성 커스텀 훅(소스+content_hash)을 받아 실행한다. harness/event 로 필터. #699: user.userId 로 per-member 유효성(개인 오버라이드·target_members) 적용.",
    [{ method: "GET", paths: ["/api/ui/org/runner/hooks"],
      parse: (req) => ({ harness: req.query.harness, event: req.query.event }) }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const harness = typeof input.harness === "string" && input.harness ? input.harness : undefined;
      const event = typeof input.event === "string" && input.event ? input.event : undefined;
      let hooks = await listEnabledHooks(harness, user?.userId || null);
      if (event) hooks = hooks.filter((h) => h.event === event);
      // relay_decisions(#892) — 러너가 PreToolUse 에서 하네스로 전파할 결정값. 이미 매 이벤트 오는 응답에
      //  얹으므로 왕복이 늘지 않는다. 구버전 러너는 이 필드를 무시하고, 신 러너는 필드가 없으면 자체 기본값을 쓴다.
      const relay = (await getRuntimeConfig()).hook_relay_decisions;
      return { hooks: hooks.map((h) => ({
        id: h.id, event: h.event, matcher: h.matcher, source_code: h.source_code,
        content_hash: h.content_hash, timeout_sec: h.timeout_sec,
      })), relay_decisions: relay };
    },
    false, { harness: z.string().optional(), event: z.string().optional() }),   // #1403 — types.ts input 규약

  // ── 런너 실패 보고(#892) — 멤버 러너가 훅 크래시/타임아웃을 알린다. scope null(인증된 멤버면 OK). ──
  // 종전엔 훅이 죽어도 러너가 크래시를 삼켜 아무도 몰랐다(spec-blind guard/tracker 가 등록 이래 내내 죽어 있었음).
  //  실패했을 때만 호출되므로 정상 조직에선 트래픽이 없다. 보고자는 본인 신원으로만 기록된다(member_id 위조 불가).
  restRead("org_runner_hook_report", "런너 훅 실패 보고",
    "멤버 러너가 커스텀 훅 실행 실패(크래시·타임아웃·해시불일치)를 보고한다 — 관리탭이 훅 건강을 본다.",
    [{ method: "POST", paths: ["/api/ui/org/runner/hook-report"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const memberId = user?.userId || null;
      if (!memberId) return { ok: false }; // 익명 러너는 기록하지 않는다(신원 없는 텔레메트리는 무의미)
      const raw = Array.isArray(input.failures) ? input.failures : [];
      // 보고자에게 실제로 배포된 훅만 받는다 — 아무 hook_id 나 쓰게 두면 자기와 무관한 훅의 건강판에
      //  임의 텍스트를 남길 수 있다(표시 전용이라 피해는 작지만, GET 쪽과 스코프를 맞춰 두는 게 공짜다).
      const harness = typeof input.harness === "string" && input.harness ? input.harness : undefined;
      const mine = new Set((await listEnabledHooks(harness, memberId)).map((h) => h.id));
      const failures = raw.slice(0, 20).flatMap((f) => { // 상한 — 한 번의 보고가 DB 를 밀지 못하게
        const o = f as Record<string, unknown>;
        if (typeof o?.hook_id !== "string" || !mine.has(o.hook_id)) return [];
        return [{
          hook_id: o.hook_id,
          reason: typeof o.reason === "string" ? o.reason.slice(0, 32) : "unknown",
          exit_code: typeof o.exit_code === "number" ? o.exit_code : null,
          stderr: typeof o.stderr === "string" ? o.stderr : "",
        }];
      });
      if (failures.length) await recordHookFailures(memberId, failures);
      return { ok: true, recorded: failures.length };
    }),
];

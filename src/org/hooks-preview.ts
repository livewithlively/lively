// 훅 주입 가시화(V4-P5 J절) — 설치된 세션 훅들이 각자 실제로 무엇을 세션 컨텍스트에 주입하는지를
//  최종 주입 메시지로 렌더한다(비개발자가 "AI 가 무엇을 받는지"를 웹에서 확인). 읽기 전용.
//
// 충실도(fidelity) 정직성:
//  - 'exact'      : 게이트웨이가 단일 출처인 부분 또는 훅 파일에서 그대로 읽은 텍스트(드리프트 없음).
//  - 'approximate': 훅이 멤버 머신에서 세션마다 동적으로 덧붙이는 부분(라이브 현황 등)은 서버가 재현 불가 —
//                   재현 가능한 부분만 보여주고 차이를 note 로 명시한다.
//
// 드리프트 방지: 게이트웨이가 소스인 부분(세션 시작 org-context)은 previewMemberContext 단일 함수를 호출
//  (텍스트 복붙 금지 — /api/ui/org/preview 와 byte-identical). 훅-로컬 템플릿(Stop 너지문)은 설치된 훅
//  소스 파일에서 직접 추출(복붙 금지 — 설치 파일이 단일 출처). 모든 메시지는 redactString choke-point 통과.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactString } from "./redact.js";
import { previewMemberContext } from "./publish.js";
import { getOrgProfile, getRuntimeConfig } from "./store.js";

export interface HookPreview {
  id: string;
  title: string;
  event: string;
  message: string;          // 이 훅이 세션 컨텍스트에 주입하는 최종 메시지(redact 통과). 미주입이면 "".
  fidelity: "exact" | "approximate";
  source: string;           // 메시지의 출처(드리프트 추적용): 게이트웨이 함수 또는 설치된 훅 파일 경로.
}

// 설치된 훅 디렉토리 — env 오버라이드 또는 ~/.lively/hooks 기본(설치기가 굳히는 위치).
function hooksDir(): string {
  return process.env.LIVELY_HOOKS_DIR || join(homedir(), ".lively", "hooks");
}

// 훅 파일에서 `const REASON = "..." + "..." ;` 형태의 단일 const 문자열 리터럴을 추출(설치 파일 단일 출처).
//  복붙 대신 실제 설치된 텍스트를 읽어 드리프트를 막는다. 못 찾으면 null(호출부가 근사 폴백).
function extractConstString(src: string, name: string): string | null {
  // const NAME = <expr> ; — expr 은 인접 문자열 리터럴 concat("..."+"...") 만 지원(훅의 실제 형태).
  const re = new RegExp(`const\\s+${name}\\s*=\\s*([\\s\\S]*?);`, "m");
  const m = re.exec(src);
  if (!m) return null;
  const expr = m[1];
  // 문자열 리터럴(따옴표 안)만 모아 이어붙인다 — + 연산자/공백은 무시.
  const parts: string[] = [];
  const litRe = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  let lm: RegExpExecArray | null;
  while ((lm = litRe.exec(expr)) !== null) {
    const raw = lm[1] ?? lm[2] ?? "";
    parts.push(raw.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\n/g, "\n").replace(/\\\\/g, "\\"));
  }
  if (!parts.length) return null;
  return parts.join("");
}

async function readHookSrc(file: string): Promise<string | null> {
  try { return await readFile(join(hooksDir(), file), "utf8"); }
  catch { return null; }
}

// 3개 설치 훅의 최종 주입 메시지 미리보기. session-preload·work-flag·stop-writeback-gate.
export async function previewHooks(): Promise<{ hooks: HookPreview[] }> {
  const p = await getOrgProfile();
  const orgName = p.display_name?.trim() || p.name?.trim() || "조직";

  // ── 1) session-preload (SessionStart) — 세션 첫머리 org-context 주입. ──
  //  게이트웨이 단일 출처: previewMemberContext(= /api/ui/org/preview = buildKnowledgeIndex). 드리프트 0.
  //  멤버 머신에서는 여기에 [라이브 현황 블록 + 쓰기가이드 요약]이 세션마다 동적으로 덧붙는다(서버 재현 불가)
  //  → fidelity=approximate, note 로 차이 명시. org-context 본문 자체는 게이트웨이와 byte-identical(exact).
  let preloadMsg: string;
  let preloadFidelity: HookPreview["fidelity"];
  try {
    const ctx = await previewMemberContext(orgName);
    preloadMsg =
      ctx.trimEnd() +
      "\n\n— 위 org-context 는 게이트웨이가 매 세션 동일하게 주입하는 부분입니다(이 미리보기와 byte-identical).\n" +
      "  멤버 머신에서는 여기에 [라이브 현황(미매핑/검토대기/최근 아이템)]과 [쓰기가이드 요약] 블록이\n" +
      "  세션마다 동적으로 덧붙습니다(머신·시점 의존 — 이 미리보기에는 미포함).";
    preloadFidelity = "approximate";
  } catch {
    preloadMsg = "(org-context 미리보기를 불러오지 못했습니다)";
    preloadFidelity = "approximate";
  }
  const preload: HookPreview = {
    id: "session-preload",
    title: "세션 시작 org-context 주입",
    event: "SessionStart",
    message: redactString(preloadMsg),
    fidelity: preloadFidelity,
    source: "gateway:previewMemberContext (=/api/ui/org/preview)",
  };

  // ── 2) work-flag (PostToolUse) — 세션 플래그만 기록, 컨텍스트 주입 없음. ──
  //  도구 사용 후 디스크 플래그(.worked/.writeback/.lively)만 남기고 stdout 으로 컨텍스트를 내보내지 않는다.
  //  → 주입 메시지 없음(provably empty). fidelity=exact.
  const workFlag: HookPreview = {
    id: "work-flag",
    title: "작업 플래그 기록(주입 없음)",
    event: "PostToolUse",
    message: "",
    fidelity: "exact",
    source: "(주입 없음 — 세션 플래그만 디스크에 기록)",
  };

  // ── 3) stop-writeback-gate (Stop) — '작업했으나 기록 안 한' 세션 종료 시 1회 너지. ──
  //  실제 훅 로직 = readHooksConfig()?.writeback_notice || REASON. 즉 어드민이 runtime-config 에 너지문구를
  //  설정하면 그게 우선이고, 없으면 설치 훅 파일의 REASON 기본값. 미리보기도 이 effective 값을 그대로 보여줘야
  //  드리프트(미리보기≠실주입)가 없다 — DB 오버라이드 우선, 폴백은 파일 REASON 추출(복붙 금지·설치 단일 출처).
  const stopSrc = await readHookSrc("stop-writeback-gate.mjs");
  const fileReason = stopSrc ? extractConstString(stopSrc, "REASON") : null;
  const rc = await getRuntimeConfig().catch(() => null);
  const override = rc?.writeback_notice?.trim() ? rc.writeback_notice.trim() : null;
  const reason = override ?? fileReason;
  const stop: HookPreview = {
    id: "stop-writeback-gate",
    title: "종료 시 기록 너지(조건부 1회)",
    event: "Stop",
    // 조건(lively work 세션 · 파일작업 O · 기록 X · 세션당 1회) 충족 시에만 아래 reason 이 주입된다.
    message: redactString(reason ?? "(설치된 stop-writeback-gate 훅의 너지 문구를 읽지 못했습니다)"),
    fidelity: reason ? "exact" : "approximate",
    source: override
      ? "gateway:runtime-config (writeback_notice 오버라이드 — 어드민 설정값)"
      : (fileReason ? join(hooksDir(), "stop-writeback-gate.mjs") + " (REASON 기본값)" : "(훅 파일 미발견)"),
  };

  return { hooks: [preload, workFlag, stop] };
}

// v6 콘텐츠 쓰기의 평문 시크릿 차단 (#4501 결정 2-1, 윤상민 2026-09-30 «막기»).
//  섹션·멤버·훅·툴 쓰기가 이미 거는 hard-block(assertNoHardSecrets)을 지식·카테고리·프로젝트·태스크 입구에도 건다.
//  종전엔 옛 ctx_save·propose_domain 에만 있었고 v6 로 옮겨 오며 빠졌다 — 토큰이 섞인 본문이 그대로 저장돼
//  세션 주입·검색·감사 기록(org_content_audit before/after)으로 퍼졌다.
//
//  ⚠ 저장소(v6/*-store) 층이 아니라 **입구(capability 핸들러)** 에 둔다. 커넥터 미러도 같은 store 를 쓰는데 미러는 이미
//   가려서 싣는다(v6/mirror/* 의 redact) — store 에서 막으면 원문에 토큰 모양이 섞인 자료 하나가 수집을 멈춘다.
//   사람(웹 REST)과 AI(MCP)는 같은 핸들러를 지나므로 이 자리 하나로 둘 다 덮인다.
import { assertNoHardSecrets } from "../org/ingest/redact.js";

const HINT = "값은 지우고 자격 금고(org_credential_set · me_credential_set)에 두세요 — 본문에는 그 이름만 적습니다";

/**
 * 입력 안의 모든 문자열(중첩 객체·배열 포함)을 검사한다 — 걸리면 400(어느 칸인지 경로로 알린다).
 * skip: **이미 저장된 옛 텍스트**를 담는 칸의 경로(배열 첨자는 `*`). 그 칸까지 막으면 시크릿을 **지우는** 편집도 막힌다
 *  (예: knowledge_save edit 의 `edits.*.old`, project_update 의 `description_base`).
 */
export function assertNoContentSecrets(input: unknown, skip: ReadonlySet<string> = new Set()): void {
  const walk = (v: unknown, path: string): void => {
    if (path && skip.has(path.replace(/\.\d+(?=\.|$)/g, ".*"))) return;
    if (typeof v === "string") { if (v) assertNoHardSecrets(v, path || "입력", HINT); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}.${i}`)); return; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(input, "");
}

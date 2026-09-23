// 닫힘 근거 코멘트 — 라이블리가 ClickUp 태스크를 완료/취소로 닫을 때 **왜 닫았는지**를 코멘트로 남긴다.
//  상태 PUT 만 보내면 ClickUp 쪽 사람에게는 태스크가 말없이 닫힌 것으로 보인다(누가·왜를 알 길이 없다).
//  닫힘은 쓰는 순간(project-store)에만 before→after 로 판정할 수 있다 — 드레인 시점엔 이미 합쳐진 현재 행뿐이라
//  «방금 닫혔는가»를 모른다. 그래서 쓰는 쪽이 노트를 아웃박스에 싣고, 드레인이 PUT 성공 뒤 이 텍스트로 코멘트한다.
import type { WriteCtx } from "../../v6/content-audit.js";

export const CLOSED_CATEGORIES: ReadonlySet<string> = new Set(["done", "canceled"]);
const REASON_MAX = 1000;

export interface CloseNote {
  category: "done" | "canceled";
  reason: string | null;
  actor: string | null;
  source: string | null;
  at: string;
}

/** 열린 상태 → 닫힌 상태로 **넘어가는** 쓰기일 때만 노트를 만든다. 닫힌 것끼리의 이동(done↔canceled 포함)·재저장은 null. */
export function closeNoteOf(
  beforeCategory: string | null | undefined,
  afterCategory: string | null | undefined,
  ctx?: WriteCtx,
  at: Date = new Date(),
): CloseNote | null {
  if (!afterCategory || !CLOSED_CATEGORIES.has(afterCategory)) return null;
  if (beforeCategory && CLOSED_CATEGORIES.has(beforeCategory)) return null;
  const reason = (ctx?.reason ?? "").trim();
  return {
    category: afterCategory as CloseNote["category"],
    reason: reason ? reason.slice(0, REASON_MAX) : null,
    actor: ctx?.actor ?? null,
    source: ctx?.source ?? null,
    at: at.toISOString(),
  };
}

/** 드레인이 보낼 코멘트 본문. reason 이 없으면 최근 작업 기록을 대신 보여주고, 그것도 없으면 «기록되지 않음»을 숨기지 않고 적는다. */
export function closeCommentText(
  note: CloseNote,
  opts: { actorName?: string | null; recentActivity?: string | null; deepLink?: string | null } = {},
): string {
  const verb = note.category === "canceled" ? "취소" : "완료";
  const lines = [`[라이블리] 이 작업을 ${verb} 처리했습니다.`];
  if (note.reason) lines.push(`근거: ${note.reason}`);
  else if (opts.recentActivity) lines.push(`근거: 따로 적히지 않았습니다. 닫기 직전 작업 기록 — ${opts.recentActivity}`);
  else lines.push("근거: 기록되지 않았습니다. 경위는 아래 라이블리 링크에서 확인해 주세요.");
  const who = opts.actorName || note.actor;
  if (who) lines.push(`처리: ${who}${note.source === "mcp" ? " (AI 에이전트)" : ""}`);
  if (opts.deepLink) lines.push(`라이블리: ${opts.deepLink}`);
  return lines.join("\n");
}

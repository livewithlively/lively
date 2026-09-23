// 닫힘 근거 코멘트 문구 — 라이블리가 ClickUp 태스크를 완료/취소로 닫을 때 **왜 닫았는지**를 남긴다.
//  상태 PUT 만 보내면 ClickUp 쪽 사람에게는 태스크가 말없이 닫힌 것으로 보인다. 닫힘 판정·노트는 PM 무관이라 아웃박스가 갖는다.
export { CLOSED_CATEGORIES, closeNoteOf, type CloseNote } from "../../v6/external-outbox.js";
import type { CloseNote } from "../../v6/external-outbox.js";

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
  // 표시 이름을 못 찾으면 줄을 뺀다 — 내부 member id 를 외부 PM 에 내보내지 않는다.
  if (opts.actorName) lines.push(`처리: ${opts.actorName}${note.source === "mcp" ? " (AI 에이전트)" : ""}`);
  if (opts.deepLink) lines.push(`라이블리: ${opts.deepLink}`);
  return lines.join("\n");
}

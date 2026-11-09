// 워크스페이스 간 옮기기(#5458) — 배치 행을 화면·API 에 내보낼 모양. 파일 바이트는 애초에 SELECT 하지 않는다(store.ts).
//  되돌리기용 «그 전 판» 본문(result.knowledge[].before)은 크고 화면에 쓸 데가 없어 뺀다 — 되돌리기는 서버가 DB 의 원본을 읽는다.
import type { BatchRow } from "./store.js";

export function batchView(b: BatchRow, opts: { withPlan?: boolean } = {}): Record<string, unknown> {
  const result = b.result as { knowledge?: Array<Record<string, unknown>> } | null;
  const slimResult = result
    ? { ...result, knowledge: (result.knowledge ?? []).map(({ before: _b, prev_origin: _p, ...rest }) => rest) }
    : null;
  return {
    id: b.id,
    state: b.state,
    file_name: b.file_name,
    file_bytes: b.file_bytes,
    sealed: b.sealed,
    origin: { workspace_uid: b.origin_uid, name: b.origin_name },
    format_version: b.format_version,
    created_by: b.created_by,
    created_at: b.created_at,
    applied_by: b.applied_by,
    applied_at: b.applied_at,
    undone_by: b.undone_by,
    undone_at: b.undone_at,
    error: b.error,
    summary: (b.plan as { summary?: unknown } | null)?.summary ?? null,
    result: slimResult,
    ...(opts.withPlan ? { plan: b.plan, decisions: b.decisions } : {}),
  };
}

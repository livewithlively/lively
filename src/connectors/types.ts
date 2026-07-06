// 커넥터 SPI (DESIGN §8) — 각 소스는 backfill + (선택)subscribe 를 구현해 RawItem 스트림을 뱉는다.
// 코어 적재는 소스 무관: 커넥터가 "소스 → canonical RawItem" 변환을 책임진다.
import type { Readable } from "node:stream";
import type { RawItem } from "../items/store.js";

export type { RawItem };

export interface BackfillOpts {
  since?: string; // ISO8601 — 증분 백필 (생략 시 전체)
  /** 미러 원장 스냅샷(커넥터별 형태) — 증분 델타가 '이미 아는 것'과 대조해 변경분만 수집하게 한다(notion #586). */
  ledger?: unknown;
  /** 이전 run 의 귀속 실패(ext id) — 커서는 전진했고 이 항목들만 강제 재수집(부분 성공 시맨틱, notion #586). */
  retryIds?: string[];
}

export interface Connector {
  /** 소스 식별자: "slack" | "discord" | "notion" */
  name: string;
  /** 과거 데이터 일괄 — RawItem 을 async 스트림으로 yield (페이지네이션은 내부에서 처리) */
  backfill(opts?: BackfillOpts): AsyncIterable<RawItem>;
  /** (선택) 실시간 — 신규/변경분을 onItem 으로 흘림 */
  subscribe?(onItem: (i: RawItem) => Promise<void>): Promise<void>;
  /**
   * (선택) on-demand 아티팩트 페치(#541) — 바이너리(PDF/이미지 등) 원본을 distill 시점에 신선하게 가져온다.
   *  커넥터는 sync 시 바이너리를 저장하지 않고 [BINARY] 메타-스텁만 남기며, 공용 `source_artifact(source_id)` 도구가
   *  distill 판단 후 이 메서드로 원본 스트림을 받아 짧은 TTL 임시경로에 저장→세션 Read→GC 한다(저장 스파이크·노이즈 회피).
   *  · externalId = 소스 external_id 원문(커넥터가 자기 포맷 파싱: gdrive=file id 그대로, slack=`file:` strip).
   *  · 반환 size = Content-Length 힌트(도구가 크기 캡·스트리밍 abort 정책 적용). 삭제/이동/권한상실 = null(→ unavailable→skip).
   */
  fetchArtifact?(externalId: string): Promise<{ stream: Readable | Buffer; mime: string; filename?: string; size?: number } | null>;
}

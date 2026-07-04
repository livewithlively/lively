// 커넥터 SPI (DESIGN §8) — 각 소스는 backfill + (선택)subscribe 를 구현해 RawItem 스트림을 뱉는다.
// 코어 적재는 소스 무관: 커넥터가 "소스 → canonical RawItem" 변환을 책임진다.
import type { RawItem } from "../items/store.js";

export type { RawItem };

export interface BackfillOpts {
  since?: string; // ISO8601 — 증분 백필 (생략 시 전체)
  /** 미러 원장 스냅샷(커넥터별 형태) — 증분 델타가 '이미 아는 것'과 대조해 변경분만 수집하게 한다(notion #586). */
  ledger?: unknown;
}

export interface Connector {
  /** 소스 식별자: "slack" | "discord" | "notion" */
  name: string;
  /** 과거 데이터 일괄 — RawItem 을 async 스트림으로 yield (페이지네이션은 내부에서 처리) */
  backfill(opts?: BackfillOpts): AsyncIterable<RawItem>;
  /** (선택) 실시간 — 신규/변경분을 onItem 으로 흘림 */
  subscribe?(onItem: (i: RawItem) => Promise<void>): Promise<void>;
}

// 커넥터 SPI (DESIGN §8) — 각 소스는 backfill + (선택)subscribe 를 구현해 RawItem 스트림을 뱉는다.
// 코어 적재는 소스 무관: 커넥터가 "소스 → canonical RawItem" 변환을 책임진다.
import type { Readable } from "node:stream";
import type pg from "pg";
import type { RawItem } from "../items/store.js";

export type { RawItem };

export interface BackfillOpts {
  since?: string; // ISO8601 — 증분 백필 (생략 시 전체)
  /** 미러 원장 스냅샷(커넥터별 형태) — 증분 델타가 '이미 아는 것'과 대조해 변경분만 수집하게 한다(notion #586). */
  ledger?: unknown;
  /** 이전 run 의 귀속 실패(ext id) — 커서는 전진했고 이 항목들만 강제 재수집(부분 성공 시맨틱, notion #586). */
  retryIds?: string[];
}

/**
 * postSync 실행 맥락(#1313 R44) — 인입(ingestItems) 직후·커서 판정 직전의 사실들.
 *  오케스트레이터(run-sync)는 이 맥락만 주고, 무엇을 후처리할지는 커넥터가 안다.
 */
export interface PostSyncCtx {
  /** 아이템 저장소 풀(itemsPool) — 미러 수렴 SQL(링크 물질화·스윕)이 쓴다. */
  pool: pg.Pool;
  /** 이 run 의 시작 시각(DB 시계 ISO) — full 스윕의 '이번 run 미관측' 기준(#551). */
  runStartIso: string;
  /** 증분 run 여부(false = full) — full 에서만 삭제 전파 스윕이 성립. */
  incremental: boolean;
  /** 이번 run 이 실제로 인입한 아이템 수. */
  ingested: number;
  /** 항목 단위 미러 실패 수 — 0 이 아니면 오케스트레이터가 커서를 전진시키지 않는다(#541). */
  mirrorFailures: number;
}

/**
 * postSync 결과(#1313 R44) — **커서 전진 불변식을 운반하는 반환값**.
 *  run-sync 는 커넥터 이름을 모르므로, '무엇을 놓쳤는지 모르는 실패'는 여기로만 표현된다.
 */
export interface PostSyncResult {
  /** true = 커서 동결 + run 실패(exit 1). 커서를 기록하지 않아 다음 run 이 같은 윈도를 재폴링한다. */
  freezeCursor?: boolean;
  /**
   * 부분 성공 시맨틱(#586) — 커서는 전진시키되 이 ext id 들만 다음 run 이 강제 재수집.
   *  undefined = 해당 없음(커서의 기존 retry_ids 무변) · [] = 청산 · [ids] = 재시도 예약.
   */
  retryIds?: string[];
}

/**
 * 사람 매핑용 외부 사용자(#837) — 관리탭 [외부 자료 수집 ▸ 멤버 매핑] 패널이 쓴다.
 *  매핑은 "외부 시스템의 사람 ↔ 우리 구성원"인데, **외부 목록이 없으면** 관리자가 외부 id 를 손으로 쳐야 한다
 *  (ClickUp 숫자 id 를 어디서 찾는지도 모르고, 오타는 조용히 매칭 실패로 끝난다). 목록을 주면 드롭다운으로 고른다.
 */
export interface ConnectorUser {
  /** 외부 시스템의 사용자 id — person_identity.external_id 로 저장된다. */
  id: string;
  name?: string | null;
  email?: string | null;
  /** 아바타 대체 표기(있으면) */
  initials?: string | null;
  /** #rrggbb — 화면은 검증 후에만 style 에 쓴다(외부 데이터 CSS 주입 방지) */
  color?: string | null;
  avatar_url?: string | null;
  /** 워크스페이스/팀 식별자 — person_identity.instance 로 저장 */
  instance?: string | null;
  /** 비활성·삭제된 사용자(목록엔 두되 흐리게) */
  inactive?: boolean;
}

export interface Connector {
  /** 소스 식별자: "slack" | "discord" | "notion" */
  name: string;
  /**
   * (선택) 이 소스의 사용자 목록(#837) — 사람 매핑 패널용.
   *  · 안 다는 커넥터: gmail·gdrive(개인 OAuth 라 '멤버' 개념 자체가 없다), domain-wiki(로컬 git).
   *  · discord 는 guild members 에 privileged intent(GUILD_MEMBERS)가 필요하고 guild id 가 설정에 없어 보류 —
   *    인터페이스는 열려 있으니 나중에 달면 UI 는 그대로 동작한다.
   */
  listUsers?(): Promise<ConnectorUser[]>;
  /** 과거 데이터 일괄 — RawItem 을 async 스트림으로 yield (페이지네이션은 내부에서 처리) */
  backfill(opts?: BackfillOpts): AsyncIterable<RawItem>;
  /**
   * (선택) 싱크 사전 준비(#1313 R44) — 저장된 커서(connector_state.cursor 원문)를 받아 이번 backfill 에
   *  실을 **추가 옵션**을 만든다(notion: 미러 원장 로드 + 이전 run 재시도 목록). 반환값은 오케스트레이터가
   *  계산한 { since } 위에 병합된다.
   *  ⚠ 실패는 커넥터가 삼키고 **안전 폴백**(빈 옵션 = 전체 트래버스)을 반환하라 — 준비 실패로 run 을 죽이지 않는다.
   */
  prepareSync?(cursor: Record<string, unknown> | null): Promise<Partial<BackfillOpts>>;
  /**
   * (선택) 직전 backfill 의 실행 통계(#1313 R44) — 구 `getNotionRunStats()`(모듈 전역 mutable) 대체.
   *  **backfill 완주 후에만 유효**하다는 암묵 순서 계약을 SPI 로 명시한 것: 통계는 커넥터 인스턴스가 소유하고,
   *  그 해석(무엇이 커서를 얼릴 실패인가)은 소유 커넥터의 postSync 가 한다 — 오케스트레이터는 읽지 않는다.
   */
  runStats?(): unknown;
  /**
   * (선택) 인입 후처리(#1313 R44) — 링크 물질화·자식 순서 수렴·삭제 전파 스윕·미러 힐 등 커넥터 고유 마무리.
   *  ⚠ 커서 전진 불변식('모든 단계 성공 후에만 전진')은 이 반환값으로 보존된다(PostSyncResult 참조).
   */
  postSync?(ctx: PostSyncCtx): Promise<PostSyncResult>;
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

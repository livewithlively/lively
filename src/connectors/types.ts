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

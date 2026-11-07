// org 스키마 조각 — ui_translate_cache: 화면 영어 보기(#5141)의 번역 기억.
//  왜 DB 인가: 프로세스 메모리만 쓰면 배포·재시작마다 비고, 구성원마다 같은 글을 모델에 다시 물었다(실측: 문서 하나 켜는 데 수십 초).
//  한 번 번역한 글은 워크스페이스 전체가 바로 꺼내 쓴다. 테넌트 격리는 부팅 체인의 ensureTenantColumn 이 붙인다(tenant_id + 정책).
//  원문은 남기지 않는다 — 원문 해시로만 찾는다(지식 본문이 이 표에 복제되지 않게).
import type { Pool } from "pg";

export async function initUiTranslateCache(pool: Pool): Promise<void> {
  //  자연키 UNIQUE 를 두지 않는다 — 테넌트 컬럼이 붙으며 (tenant_id, …) 로 다시 만들어져 ON CONFLICT 방언이 배포마다 갈린다.
  //  같은 글이 동시에 두 번 들어와도 해가 없다(어느 행이든 같은 번역) — 넣을 때 NOT EXISTS 로 거른다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ui_translate_cache(
      id BIGSERIAL PRIMARY KEY,
      target TEXT NOT NULL,
      src_hash TEXT NOT NULL,
      translated TEXT NOT NULL,
      model TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    CREATE INDEX IF NOT EXISTS ui_translate_cache_lookup_idx ON ui_translate_cache(target, src_hash);`);
}

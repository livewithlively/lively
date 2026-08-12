// org 스키마 조각 — canary: 상류 회귀 자동탐지(#1657)의 실행 기록.
//  프로브 정의는 **코드**(org/canary/probes.ts)에 있고, 여기 남는 건 '언제 돌렸고 무엇을 봤나' 뿐이다.
//  정의를 데이터로 두지 않는 이유: 프로브는 '상류가 이렇게 답해야 한다'는 **우리 계약의 표현**이라 코드 리뷰를
//  거쳐야 하고, 고객 박스마다 달라지면 함대 단위 신호라는 전제가 깨진다.
import type { Pool } from "pg";

export async function initCanary(pool: Pool): Promise<void> {
  // 한 프로브 1회 실행 = 1행. 오래된 행은 보관정책 없이도 커지지 않게 조회 시 최근 N개만 본다(prune 은 후속).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS canary_result(
      id BIGSERIAL PRIMARY KEY,
      ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      probe_key TEXT NOT NULL,
      adapter TEXT NOT NULL,
      tier TEXT NOT NULL,
      ok BOOLEAN NOT NULL,
      reason TEXT,
      duration_ms INT,
      -- #1657: '이 박스에 설정이 없다'(자격 미연결·도구 미적용)와 '상류가 막혔다'를 가른다.
      --  구성 미비는 연속실패 집계에서 빠진다 — 안 쓰는 커넥터가 영구 failing 으로 남으면
      --  그 가짜 경보가 진짜 경보를 묻는다(dev 실측).
      configured BOOLEAN NOT NULL DEFAULT true);
    ALTER TABLE canary_result ADD COLUMN IF NOT EXISTS configured BOOLEAN NOT NULL DEFAULT true;
    CREATE INDEX IF NOT EXISTS canary_result_key_at_idx ON canary_result(probe_key, ran_at DESC);`);
}

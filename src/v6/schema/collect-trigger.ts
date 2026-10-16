// v6 스키마 조각 — collect-trigger(#4213 T12 #4744): **지속 수집 트리거**. 수집 단위 표(collect-unit.ts)에 주기 판정의 칸을 더한다.
//  설계 정본: 지식 connect-collect-tobe-claude-connector-4213 §6 · 태스크 #4744(상민님 2026-10-15 «트리거 최종 확정»).
//
//  collect_unit 에 더하는 칸:
//   · next_at       — 다음에 «새 글 있나» 를 볼 시각. 수집 실행의 저장 단계가 단위마다 적는다(다 읽고 따라잡았으면 주기 뒤 ·
//                     밀렸으면 곧바로 · 못 읽었으면 물러서며). 비면 «읽은 시각 + 주기»(T12 전 단위)이고, 처음 읽는 단위는 곧바로다.
//   · interval_auto — 주기(interval_sec)를 빈도가 정하나. 기본 그렇다(저장 단계가 최근 14일 글 빈도로 다시 맞춘다).
//                     리브·사람이 collect_unit_update 로 interval_sec 를 주면 false(그 값 고정), null 을 주면 다시 true.
//   · sched         — 판정 재료(서버만 쓴다): hist(다 읽은 판의 표본 — 끝 시각·구간 길이·그 구간의 글 수) · fails(연달아 진척 없는 판 수) ·
//                     why(마지막 판정 — interval·catchup·retry) · at(판정 시각). 사람이 고치는 칸이 아니다 — 리브는 meta.activity 를 본다.
//  ⚠ 번호 없는 ADD COLUMN IF NOT EXISTS — 병렬 브랜치 사이 순서 충돌이 없다. collect_unit 이 있어야 하므로 오케스트레이터에서 collect-unit 뒤에 둔다.
import type { Pool } from "pg";

export async function initV6CollectTrigger(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE collect_unit ADD COLUMN IF NOT EXISTS next_at TIMESTAMPTZ;
    ALTER TABLE collect_unit ADD COLUMN IF NOT EXISTS interval_auto BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE collect_unit ADD COLUMN IF NOT EXISTS sched JSONB NOT NULL DEFAULT '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS collect_unit_due_idx ON collect_unit(next_at) WHERE state = 'active';
  `);
}

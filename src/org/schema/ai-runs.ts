// 앱 AI 실행 기록(#4488 앱 v2-9) — org_app_ai_run · org_app_llm_call. 테넌트 스코프(RLS 는 tenant-column 이 끝에서 붙인다).
import type { Pool } from "pg";

export async function initAiRuns(pool: Pool): Promise<void> {
  // ── org_app_ai_run — 앱이 `/_lively/ai/runs` 로 보낸 AI 작업 한 건(설계 §4 «앱 실행 기록 — 가공 전 맥락»).
  //  실행 자리는 둘 — proxy(단발 + 워크스페이스 API 키: 게이트웨이가 LLM API 를 한 번 부른다 · 컨테이너 없음) ·
  //   job(그 밖 전부: 작업 컨테이너 org_agent_job 한 건이 돈다 — job_id 가 그 행). 상태는 job 이면 그 작업 행에서 읽어 맞춘다(ai-runs/service.syncRun).
  //  prompt 는 앱이 보낸 지시 원문 그대로(기록) · schema 는 앱이 원한 결과 모양 · result 는 {text, json?, model, usage, cost_usd?, duration_ms, retries}.
  //  proxy_token_hash — API 키 에이전트 작업에 준 «그 실행 한정» 프록시 토큰(auth_token)의 sha256 — 끝나면 폐기한다.
  //  session_note — 붙은 세션의 다음 턴에 알릴 요지(v2-10 분기 실행이 채운다 · 지금은 NULL).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_ai_run(
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','canceled')),
      app_id TEXT NOT NULL,
      requester TEXT NOT NULL,
      requester_kind TEXT NOT NULL DEFAULT 'member' CHECK (requester_kind IN ('member','app_server')),
      source TEXT,
      job_name TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('single','agent')),
      account_kind TEXT NOT NULL CHECK (account_kind IN ('api_key','subscription')),
      account_member TEXT,
      executor TEXT NOT NULL CHECK (executor IN ('proxy','job')),
      job_id BIGINT,
      model TEXT,
      label TEXT,
      prompt TEXT NOT NULL,
      system_prompt TEXT,
      schema JSONB,
      result JSONB,
      error TEXT,
      session_note TEXT,
      proxy_token_hash TEXT,
      retries INT NOT NULL DEFAULT 0,
      input_tokens INT,
      output_tokens INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
  //  #5081 공용 시트로 돈 실행 — 시트 계정(구독 주인)의 «내 실행» 이 아니다(ai-runs/service.isOwnRun). 접수 때 정해지고 안 바뀐다.
  //   ⚠ 롤 창 — 이 칸은 ai-runs/store 의 COLS 에 넣지 않는다(store.RUN_SHARED_SEAT_COL 머리말).
  await pool.query(`ALTER TABLE org_app_ai_run ADD COLUMN IF NOT EXISTS shared_seat BOOLEAN NOT NULL DEFAULT false`);
  //  그 앱의 기록(최근 것부터) · 내 기록 · 열린 실행(동시 상한 셈 · 정비) · 작업 행 → 실행 행 · 프록시 토큰 → 실행 행.
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_ai_run_app_idx ON org_app_ai_run(app_id, id DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_ai_run_requester_idx ON org_app_ai_run(requester, id DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_ai_run_open_idx ON org_app_ai_run(id) WHERE status IN ('queued','running')`);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_ai_run_job_idx ON org_app_ai_run(job_id) WHERE job_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_ai_run_token_idx ON org_app_ai_run(proxy_token_hash) WHERE proxy_token_hash IS NOT NULL`);

  // ── org_app_llm_call — LLM 프록시(/api/llm/anthropic/*)를 지난 호출 한 건의 계측(설계 §3-E «프록시 = API 키 갈래 전체의 출구 — 계측·한도 한곳»).
  //  단발 실행(run_id 있음) · 에이전트 작업이 프록시 토큰으로 부른 것(run_id 있음) · 고급 길(앱 서버 토큰 · run_id 없음) 전부 여기 한 줄.
  //  토큰 수는 응답 usage 에서 읽는다(스트리밍은 message_start · message_delta 를 훑는다). 앱당 하루 토큰 상한은 이 표를 합산한다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS org_app_llm_call(
      id BIGSERIAL PRIMARY KEY,
      app_id TEXT NOT NULL,
      run_id BIGINT,
      caller TEXT NOT NULL CHECK (caller IN ('run','run_token','app_server')),
      member TEXT,
      model TEXT,
      path TEXT NOT NULL,
      stream BOOLEAN NOT NULL DEFAULT false,
      status INT,
      input_tokens INT NOT NULL DEFAULT 0,
      output_tokens INT NOT NULL DEFAULT 0,
      cache_read_tokens INT NOT NULL DEFAULT 0,
      cache_write_tokens INT NOT NULL DEFAULT 0,
      duration_ms INT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS org_app_llm_call_app_day_idx ON org_app_llm_call(app_id, created_at DESC)`);
}

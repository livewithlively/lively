// org 스키마 조각 — workspace-registry(#1750 S1): **셀프호스트 다중 워크스페이스 등록부.**
//
// ── 왜 전역(비테넌트) 테이블인가 ────────────────────────────────────────────
// 이 두 표는 "이 게이트웨이(배포)에 어떤 워크스페이스들이 있는가"라는 **배포 전체의 사실**이다 —
//  워크스페이스(테넌트) 축 위에 놓으면 자기 자신을 찾을 수 없다(부트스트랩 순환). 매니지드에서
//  같은 역할을 하는 것이 CP 의 tenants/workspaces 테이블(코어 밖)이고, 셀프호스트에는 CP 가 없어
//  코어가 직접 갖는다. 그래서:
//   · db/tenant-column.ts TENANT_COLUMN_EXEMPT 에 등재 — tenant_id 를 붙이지 않는다.
//   · 셀프호스트 활성화(org/tenancy/activate.ts)의 정책 적용에서도 제외(전역 읽기 필요).
//   · ⚠ 매니지드 공용 DB 게이트(lvly-cloud tenantrls.RLS_EXEMPT_TABLES)에도 **같이 등재해야 한다** —
//     안 하면 introspection 게이트가 "tenant_id 없는 테이블"로 프로비저닝을 fail-closed 로 막는다.
//     (lvly-cloud 쪽 PR 이 코어 릴리스보다 먼저 나가야 하는 이유.)
//
// ── 모델 ────────────────────────────────────────────────────────────────────
// gw_workspace: 워크스페이스 1행 = 테넌트 1개(id 가 곧 tenant_id 값). primary(기존 박스 워크스페이스)는
//  활성화 때 id=SINGLE_TENANT_ID·slug='primary' 로 시드된다 — 기존 데이터(tenant_id 상수)와 정확히 일치.
// gw_workspace_member: 접근 명부. **primary 는 명부를 안 본다**(박스 로그인 = primary 접근, 종전 그대로) —
//  secondary 만 게이트(org/tenancy/gate.ts). owner 만 이름변경·보관·멤버관리.
// 이름(name)은 스위처 표시용 사본이다 — 각 워크스페이스 안의 org_profile 이 그 안에서의 정본이고,
//  create/update 가 둘을 함께 쓴다(전역 목록을 그리는 데 테넌트 컨텍스트 n개를 열지 않기 위한 사본).
import type { Pool } from "pg";
import { ensureCheck } from "./ddl-util.js";

export async function initWorkspaceRegistry(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gw_workspace(
      id UUID PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'personal',
      owner_member TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
    ${ensureCheck("gw_workspace", {
      gw_workspace_kind_chk: "kind IN ('personal','team')",
      gw_workspace_state_chk: "state IN ('active','archived')",
    })}
    CREATE TABLE IF NOT EXISTS gw_workspace_member(
      workspace_id UUID NOT NULL,
      member_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, member_id));
    ${ensureCheck("gw_workspace_member", { gw_workspace_member_role_chk: "role IN ('owner','member')" })}
    CREATE INDEX IF NOT EXISTS gw_workspace_member_member_idx ON gw_workspace_member(member_id);
    -- 세션 → 워크스페이스 정본(#1750 후속). ★ 워크스페이스 신호를 클라이언트 헤더에만 실으면
    --  EventSource(SSE)·iframe(단독 터미널 페이지)·WS 업그레이드·구 번들·훅처럼 헤더를 못/안 싣는
    --  표면이 전부 조용히 primary 로 떨어진다(dev 실측: '하루' 개인 ws 에서 연 세션이 primary 로 들어가
    --  primary 의 AI 멤버 '다온'으로 응답). 세션 생성 시 서버가 소속을 여기 새기고, 이후의 모든
    --  세션 축 요청(x-lively-session 헤더·/sessions/<id> 경로·WS 티켓)은 이 표로 컨텍스트를 되찾는다 —
    --  클라이언트 버전과 무관하게. 전역 표(등록부와 같은 이유 — 컨텍스트를 열기 전에 읽어야 한다).
    CREATE TABLE IF NOT EXISTS gw_session_map(
      session_id TEXT PRIMARY KEY,
      workspace_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
}

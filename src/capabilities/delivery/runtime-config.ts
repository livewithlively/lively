// delivery ▸ runtime-config — 런타임 설정(훅 on/off·work-roots·너지·정책·임베딩) 조회/수정.
import type { Capability, CapabilityCtx } from "../types.js";
import { z } from "zod";
import { HttpError } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { MEANING } from "../../org/delivery/meaning.js";
import { normalizeStoragePolicy, type StoragePolicyPatch } from "../../org/policies/storage-policy.js";
import type { CallLogPolicyPatch } from "../../org/policies/call-log-policy.js"; // #1082 호출 감사로그 보존기간
import {
  normalizeSessionMemoryPolicy, SESSION_MEM_MB_MIN, SESSION_MEM_MB_MAX, type SessionMemoryPolicyPatch
} from "../../sessions/session-memory-policy.js"; // #1059 D
import {
  RECLAIM_TTL_MIN_MIN, RECLAIM_TTL_MIN_MAX, RECLAIM_PRESSURE_PCT_MIN, RECLAIM_PRESSURE_PCT_MAX, type SessionReclaimPolicyPatch
} from "../../sessions/session-reclaim-policy.js"; // #1059 F · #1220 압박 회수
import { STALL_MS_MIN, STALL_MS_MAX, type DelegatePolicyPatch } from "../../org/policies/delegate-policy.js"; // #1101 위탁 무출력 stall 상한
import {
  type SessionSharePatch, SESSION_SHARE_SCOPES, SESSION_SHARE_STORES, SESSION_SHARE_VIEW_POLICIES, KNOWN_HARNESSES, RETENTION_MAX_DAYS
} from "../../sessions/session-share.js";
import { kitVersion } from "../../org/delivery/publish.js";
import { DEFAULT_WRITEBACK_NOTICE } from "../../org/delivery/hook-defaults.js";
import { getRuntimeConfig, updateRuntimeConfig, HOOK_RELAY_DECISIONS, type HookRelayDecision, listAutoApproveTools } from "../../org/store.js";
import {
  type EmbeddingConfigPatch, DEFAULT_EMBEDDING_BATCH_SIZE, DEFAULT_EMBEDDING_TIMEOUT_MS, DEFAULT_EMBEDDING_BACKFILL_MIN_MB,
  EMBEDDING_BATCH_MIN, EMBEDDING_BATCH_MAX, EMBEDDING_TIMEOUT_MIN_MS, EMBEDDING_TIMEOUT_MAX_MS, EMBEDDING_BACKFILL_MIN_MB_MIN,
  EMBEDDING_BACKFILL_MIN_MB_MAX
} from "../../v6/embedding-provider.js";
import { actorOf, restOnly, restRead, str } from "./shared.js";

export const runtimeConfigCapabilities: Capability[] = [
  // ── 발행(검증 + 산출 확인) ──
  // ── 런타임 설정(훅 on/off · work-roots · 너지) ──
  restRead("org_runtime_config", "런타임 설정 조회",
    "관리탭 [세션 주입]의 런타임 설정 — 훅 on/off·writeback 너지문구·기록 인정 툴·자동승인 툴·kit_version(세션 훅이 동적 fetch, scope null). " +
    "admin 에게는 config 에 **전량**이 얹힌다(#1169) — work_roots·안전 화이트리스트(allowed_auth_envs·url_allowlist·allowed_db_hosts·allowed_db_secret_refs)·" +
    "임베딩/저장소/호출로그/세션메모리/세션회수/세션공유 정책. 위 축약 필드는 훅용 fold 판이라 그것만으로는 관리 상태를 볼 수 없다. 수정은 org_runtime_update.",
    [{ method: "GET", paths: ["/api/ui/org/runtime-config"], parse: () => ({}) }],
    async (_input: unknown, user: LivelyUser) => {
      // 훅이 동적으로 필요한 것만(비밀 아님): hooks 토글 + 너지문구. work_roots(디렉토리 경로)는
      //  비-admin 에게 노출 안 함 — 설치 번들(.lively/work-roots, 멤버 본인 설치 경로)로만 전달.
      const c = await getRuntimeConfig();
      // write_tools(기록 인정 툴)·auto_approve(자동승인 툴 'mcp__lively__<tool>')도 훅이 동적으로 읽음(B) —
      //  툴 '이름'뿐이라 비밀 아님(work_roots 와 달리 노출 OK). 훅이 매 세션 settings.json permissions.allow 에 reconcile.
      const autoApprove = (await listAutoApproveTools()).map((t) => `mcp__lively__${t.name}`);
      // kit_version(#858) — 현재 서빙 중인 설치 번들의 지문. session-preload 가 로컬 ~/.lively/kit-version 과
      //  비교해 다르면 백그라운드 재설치를 띄운다(키트 코드·배선 자동 갱신 — 멤버 수동 업데이트 폐지).
      //  이미 매 세션 오는 응답에 얹으므로 왕복이 늘지 않는다. 계산 실패 시 null → 멤버는 아무것도 안 한다(fail-safe).
      const kv = await kitVersion();
      // 너지 '유효값' 서빙(#270): 어드민 오버라이드가 없으면 서버 단일소스 DEFAULT_WRITEBACK_NOTICE 를 fold 해 준다.
      //  → session-preload 가 이 값을 매 세션 ~/.lively/hooks-config.json 에 기록 → 게이트가 라이브로 사용
      //  (설치 .mjs 의 REASON 은 게이트웨이 영영 불가 시의 last-resort 스텁일 뿐). 재설치 없이 너지가 갱신된다.
      //  주의: 이 fold 는 '훅 서빙' 응답에만 적용 — 어드민 편집기는 data.runtimeConfig(원본 override, null=미설정)
      //  + writebackNoticeDefault 를 별도로 받으므로 override↔default 구분이 깨지지 않는다.
      // pull_tools(#906) — '외부 맥락 인입'으로 볼 MCP 툴 이름 prefix. write_tools 와 달리 fold 안 함:
      //  **비면 그대로 꺼짐**이 의도된 상태라 기본값을 씌우면 어드민의 '끄기'를 되살려버린다(DB 기본값이 곧 on).
      // hook_grace_ms(#1008) — run-custom 캐시 유효기간(ms). null=무제한(기본). session-preload 가 hooks-config.json 에 미러 → run-custom 이 읽음.
      // config(#1169) — org_overview 가 admin 에게만 주던 runtimeConfig **전량**을 같은 모양으로 얹는다.
      //  work_roots(디렉토리 경로)가 여기 들어 있으므로 admin 에게만 준다(위 주석의 비노출 규칙 유지).
      const isAdmin = !!(user?.scopes && user.scopes.includes("admin"));
      return {
        hooks: c.hooks, writeback_notice: c.writeback_notice || DEFAULT_WRITEBACK_NOTICE, write_tools: c.write_tools,
        pull_tools: c.pull_tools, auto_approve: autoApprove, kit_version: kv, hook_grace_ms: c.hook_grace_ms,
        config: isAdmin ? c : null, writebackNoticeDefault: DEFAULT_WRITEBACK_NOTICE, meaning: MEANING["runtime"],
      };
    }, true),
  restOnly("org_runtime_update", "런타임 설정 수정",
    "훅 활성/비활성·work-roots·writeback 너지 + 안전 화이트리스트(allowed_auth_envs·url_allowlist·allowed_db_hosts·allowed_db_secret_refs)를 저장한다.",
    [{ method: "POST", paths: ["/api/ui/org/runtime-config"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser, ctx?: CapabilityCtx) => {
      const patch: {
        hooks?: Record<string, boolean>; writeback_notice?: string | null; work_roots?: string[];
        allowed_auth_envs?: string[]; url_allowlist?: string[]; allowed_db_hosts?: string[];
        allowed_internal_hosts?: string[];
        allowed_db_secret_refs?: string[]; write_tools?: string[]; pull_tools?: string[];
        embedding_config?: EmbeddingConfigPatch;
        storage_policy?: StoragePolicyPatch;
        call_log_policy?: CallLogPolicyPatch;
        session_memory_policy?: SessionMemoryPolicyPatch;
        session_reclaim_policy?: SessionReclaimPolicyPatch;
        delegate_policy?: DelegatePolicyPatch;
        hook_relay_decisions?: HookRelayDecision[];
        session_share?: SessionSharePatch;
        hook_grace_ms?: number | null;
        inject_ontology_guide?: boolean;
      } = {};
      // 저장소 정책(#813) — 로그 상한·디스크 임계치. 잡값·뒤집힌 임계치(경고≥위험)는 normalize 가 잡는다.
      //  고객 박스는 .env 를 못 고치므로 **여기(관리탭)가 유일한 조절 창구**다.
      if (input.storage_policy !== undefined) {
        const raw = input.storage_policy;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "storage_policy 는 객체여야 합니다");
        const s = raw as Record<string, unknown>;
        const num = (v: unknown, field: string, min: number, max: number): number => {
          const n = Number(v);
          if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `storage_policy.${field} 는 ${min}~${max} 정수여야 합니다`);
          return Math.floor(n);
        };
        const patchIn: StoragePolicyPatch = {};
        if (s.log_max_mb !== undefined) patchIn.log_max_mb = num(s.log_max_mb, "log_max_mb", 0, 10_000);
        if (s.log_keep !== undefined) patchIn.log_keep = num(s.log_keep, "log_keep", 0, 50);
        if (s.disk_warn_pct !== undefined) patchIn.disk_warn_pct = num(s.disk_warn_pct, "disk_warn_pct", 1, 99);
        if (s.disk_critical_pct !== undefined) patchIn.disk_critical_pct = num(s.disk_critical_pct, "disk_critical_pct", 1, 100);
        if (s.mem_warn_pct !== undefined) patchIn.mem_warn_pct = num(s.mem_warn_pct, "mem_warn_pct", 0, 99);       // #1059 0=끔
        if (s.mem_critical_pct !== undefined) patchIn.mem_critical_pct = num(s.mem_critical_pct, "mem_critical_pct", 0, 100); // #1059 0=끔
        if (s.pty_warn_pct !== undefined) patchIn.pty_warn_pct = num(s.pty_warn_pct, "pty_warn_pct", 0, 99);                 // #687 후속 0=끔
        if (s.pty_critical_pct !== undefined) patchIn.pty_critical_pct = num(s.pty_critical_pct, "pty_critical_pct", 0, 100); // #687 후속 0=끔
        if (s.shared_cache_enabled !== undefined) patchIn.shared_cache_enabled = Boolean(s.shared_cache_enabled);
        if (s.shared_cache_relocate_home !== undefined) patchIn.shared_cache_relocate_home = Boolean(s.shared_cache_relocate_home);
        // 경고 ≥ 위험은 사용자가 의도한 설정일 리 없다 — 조용히 고치지 말고 왜 안 되는지 알려준다.
        const merged = normalizeStoragePolicy({ ...(await getRuntimeConfig()).storage_policy, ...patchIn });
        if (patchIn.disk_warn_pct !== undefined && patchIn.disk_warn_pct >= merged.disk_critical_pct) {
          throw new HttpError(400, `경고 임계치(${patchIn.disk_warn_pct}%)는 위험 임계치(${merged.disk_critical_pct}%)보다 낮아야 합니다`);
        }
        patch.storage_policy = patchIn;
      }
      // 호출 감사로그 보관 정책(#1082) — mcp_call_log 보존일수. 0=무기한(구동작). 고객 박스는 .env 를 못 고치므로
      //  여기(관리탭)가 유일한 조절 창구다(storage_policy 와 동일 교리).
      if (input.call_log_policy !== undefined) {
        const raw = input.call_log_policy;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "call_log_policy 는 객체여야 합니다");
        const s = raw as Record<string, unknown>;
        const patchIn: CallLogPolicyPatch = {};
        if (s.retention_days !== undefined) {
          const n = Number(s.retention_days);
          if (!Number.isFinite(n) || n < 0 || n > 3650) throw new HttpError(400, "call_log_policy.retention_days 는 0~3650 정수여야 합니다(0=무기한 보관)");
          patchIn.retention_days = Math.floor(n);
        }
        patch.call_log_policy = patchIn;
      }
      // per-session cgroup 메모리 정책(#1059 D) — 세션당 MemoryHigh/Max(MB). 0=무제한. 잡값·범위는 아래 + normalize 가 잡는다.
      //  고객 박스는 .env 를 못 고치므로 여기(관리탭)가 유일한 조절 창구(storage_policy 와 동일 교리).
      if (input.session_memory_policy !== undefined) {
        const raw = input.session_memory_policy;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "session_memory_policy 는 객체여야 합니다");
        const s = raw as Record<string, unknown>;
        const mb = (v: unknown, field: string): number => {
          const n = Number(v);
          if (!Number.isFinite(n) || n < SESSION_MEM_MB_MIN || n > SESSION_MEM_MB_MAX) throw new HttpError(400, `session_memory_policy.${field} 는 ${SESSION_MEM_MB_MIN}~${SESSION_MEM_MB_MAX} 정수(MB)여야 합니다 (0=무제한)`);
          return Math.floor(n);
        };
        const patchIn: SessionMemoryPolicyPatch = {};
        if (s.per_session_high_mb !== undefined) patchIn.per_session_high_mb = mb(s.per_session_high_mb, "per_session_high_mb");
        if (s.per_session_max_mb !== undefined) patchIn.per_session_max_mb = mb(s.per_session_max_mb, "per_session_max_mb");
        // high>max 는 무의미(하드 kill 전에 소프트 스로틀이 안 걸림) — 사용자 의도일 리 없으니 조용히 고치지 말고 알려준다.
        //  ⚠ 검사는 **단방향**(제출한 high 가 결과 max 를 넘을 때만 400): 반대로 max 만 기존 high 아래로 낮추면
        //   normalize 가 high 를 max 로 조용히 끌어내린다(안전 방향 — 하드캡을 낮추면 소프트캡도 같이 내려가는 게 자연스럽다).
        //   storage_policy 의 warn≥critical 단방향 검사와 동일한 관례(#813).
        const merged = normalizeSessionMemoryPolicy({ ...(await getRuntimeConfig()).session_memory_policy, ...patchIn });
        if (patchIn.per_session_high_mb !== undefined && patchIn.per_session_high_mb > 0 && merged.per_session_max_mb > 0 && patchIn.per_session_high_mb > merged.per_session_max_mb) {
          throw new HttpError(400, `MemoryHigh(${patchIn.per_session_high_mb}MB)는 MemoryMax(${merged.per_session_max_mb}MB) 이하여야 합니다`);
        }
        patch.session_memory_policy = patchIn;
      }
      // idle 세션 자동 회수 정책(#1059 F) — idle TTL(분). 0=끔(무회귀). 고객 박스는 .env 를 못 고치므로 여기가 유일한 조절 창구.
      if (input.session_reclaim_policy !== undefined) {
        const raw = input.session_reclaim_policy;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "session_reclaim_policy 는 객체여야 합니다");
        const s = raw as Record<string, unknown>;
        const patchIn: SessionReclaimPolicyPatch = {};
        if (s.idle_ttl_minutes !== undefined) {
          const n = Number(s.idle_ttl_minutes);
          if (!Number.isFinite(n) || n < RECLAIM_TTL_MIN_MIN || n > RECLAIM_TTL_MIN_MAX) throw new HttpError(400, `session_reclaim_policy.idle_ttl_minutes 는 ${RECLAIM_TTL_MIN_MIN}~${RECLAIM_TTL_MIN_MAX} 정수(분)여야 합니다 (0=회수 끔)`);
          patchIn.idle_ttl_minutes = Math.floor(n);
        }
        // #1220 압박 회수 — 사용률 임계(%)와 그때 쓰는 완화 idle 기준(분). 임계 0=끔(무회귀).
        if (s.pressure_used_pct !== undefined) {
          const n = Number(s.pressure_used_pct);
          if (!Number.isFinite(n) || n < RECLAIM_PRESSURE_PCT_MIN || n > RECLAIM_PRESSURE_PCT_MAX) throw new HttpError(400, `session_reclaim_policy.pressure_used_pct 는 ${RECLAIM_PRESSURE_PCT_MIN}~${RECLAIM_PRESSURE_PCT_MAX} 정수(%)여야 합니다 (0=압박 회수 끔)`);
          patchIn.pressure_used_pct = Math.floor(n);
        }
        if (s.pressure_idle_minutes !== undefined) {
          const n = Number(s.pressure_idle_minutes);
          if (!Number.isFinite(n) || n < RECLAIM_TTL_MIN_MIN || n > RECLAIM_TTL_MIN_MAX) throw new HttpError(400, `session_reclaim_policy.pressure_idle_minutes 는 ${RECLAIM_TTL_MIN_MIN}~${RECLAIM_TTL_MIN_MAX} 정수(분)여야 합니다`);
          patchIn.pressure_idle_minutes = Math.floor(n);
        }
        patch.session_reclaim_policy = patchIn;
      }
      // 위탁 태스크 정책(#1101) — 무출력 stall 상한(ms). 0=가드 끔. 고객 박스는 .env 를 못 고치므로 여기가 유일한 조절 창구.
      //  ⚠ 0 초과인데 1분 미만인 값은 store 의 normalize 가 1분으로 올린다(너무 짧으면 멀쩡한 작업을 죽인다 — STALL_MS_FLOOR).
      if (input.delegate_policy !== undefined) {
        const raw = input.delegate_policy;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "delegate_policy 는 객체여야 합니다");
        const s = raw as Record<string, unknown>;
        const patchIn: DelegatePolicyPatch = {};
        if (s.stall_ms !== undefined) {
          const n = Number(s.stall_ms);
          if (!Number.isFinite(n) || n < STALL_MS_MIN || n > STALL_MS_MAX) throw new HttpError(400, `delegate_policy.stall_ms 는 ${STALL_MS_MIN}~${STALL_MS_MAX} 정수(ms)여야 합니다 (0=가드 끔)`);
          patchIn.stall_ms = Math.floor(n);
        }
        patch.delegate_policy = patchIn;
      }
      if (input.hooks !== undefined) {
        const h = input.hooks;
        if (typeof h !== "object" || h === null || Array.isArray(h)) throw new HttpError(400, "hooks 는 객체여야 합니다");
        patch.hooks = {};
        for (const k of ["session_preload", "work_flag", "stop_writeback_gate", "self_update"]) {
          if (k in (h as Record<string, unknown>)) patch.hooks[k] = Boolean((h as Record<string, unknown>)[k]);
        }
      }
      // (#1245) 온톨로지 가이드(제품 소유 섹션) 주입 토글 — 본문은 코드 단일 출처(편집 불가), org 는 이것만 정한다.
      if (input.inject_ontology_guide !== undefined) patch.inject_ontology_guide = Boolean(input.inject_ontology_guide);
      if (input.writeback_notice !== undefined) {
        patch.writeback_notice = (input.writeback_notice === null || input.writeback_notice === "")
          ? null : str(input.writeback_notice, "writeback_notice", 2000);
      }
      if (input.work_roots !== undefined) {
        if (!Array.isArray(input.work_roots)) throw new HttpError(400, "work_roots 는 배열이어야 합니다");
        patch.work_roots = input.work_roots.map((r) => str(r, "work_roots[]", 500).trim()).filter(Boolean);
      }
      if (input.allowed_auth_envs !== undefined) {
        if (!Array.isArray(input.allowed_auth_envs)) throw new HttpError(400, "allowed_auth_envs 는 배열이어야 합니다");
        patch.allowed_auth_envs = input.allowed_auth_envs.map((e) => str(e, "allowed_auth_envs[]", 100).trim()).filter(Boolean);
        for (const e of patch.allowed_auth_envs) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e)) throw new HttpError(400, `allowed_auth_envs 항목 '${e}' 는 환경변수 이름 형식이어야 합니다`);
        }
      }
      if (input.url_allowlist !== undefined) {
        if (!Array.isArray(input.url_allowlist)) throw new HttpError(400, "url_allowlist 는 배열이어야 합니다");
        patch.url_allowlist = input.url_allowlist.map((u) => str(u, "url_allowlist[]", 200).trim().toLowerCase()).filter(Boolean);
      }
      if (input.allowed_db_hosts !== undefined) {
        if (!Array.isArray(input.allowed_db_hosts)) throw new HttpError(400, "allowed_db_hosts 는 배열이어야 합니다");
        patch.allowed_db_hosts = input.allowed_db_hosts.map((h) => str(h, "allowed_db_hosts[]", 200).trim().toLowerCase()).filter(Boolean);
      }
      // MCP 프록시가 접속 가능한 내부(사설/localhost) host 화이트리스트(#746 T1) — 기본 deny-all, 여기 명시한 host 만 SSRF 면제.
      if (input.allowed_internal_hosts !== undefined) {
        if (!Array.isArray(input.allowed_internal_hosts)) throw new HttpError(400, "allowed_internal_hosts 는 배열이어야 합니다");
        patch.allowed_internal_hosts = input.allowed_internal_hosts.map((h) => str(h, "allowed_internal_hosts[]", 200).trim().toLowerCase()).filter(Boolean);
      }
      // db 소스 auth_ref 가 참조할 수 있는 비번 env '이름' 화이트리스트(#715 배선 — store 엔 있었으나 REST 입력이 없어
      //  외부(비번 필요) 소스 등록이 불가능했다). allowed_auth_envs 와 동일한 env 이름 형식 검증. 값이 아니라 이름만.
      if (input.allowed_db_secret_refs !== undefined) {
        if (!Array.isArray(input.allowed_db_secret_refs)) throw new HttpError(400, "allowed_db_secret_refs 는 배열이어야 합니다");
        patch.allowed_db_secret_refs = input.allowed_db_secret_refs.map((e) => str(e, "allowed_db_secret_refs[]", 100).trim()).filter(Boolean);
        for (const e of patch.allowed_db_secret_refs) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e)) throw new HttpError(400, `allowed_db_secret_refs 항목 '${e}' 는 환경변수 이름 형식이어야 합니다(시크릿 값 금지)`);
        }
      }
      if (input.write_tools !== undefined) {
        if (!Array.isArray(input.write_tools)) throw new HttpError(400, "write_tools 는 배열이어야 합니다");
        // 비우면 훅 내장 기본목록 사용(오버라이드 해제). 각 항목은 lively MCP 툴 '이름' 형식(접두사 mcp__lively__ 없이).
        patch.write_tools = input.write_tools.map((t) => str(t, "write_tools[]", 100).trim()).filter(Boolean);
        for (const t of patch.write_tools) {
          if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(t)) throw new HttpError(400, `write_tools 항목 '${t}' 는 툴 이름 형식이어야 합니다(영문/숫자/_)`);
        }
        if (patch.write_tools.length > 100) throw new HttpError(400, "write_tools 가 너무 많습니다(100개 이하)");
      }
      // pull_tools(#906) — '외부 맥락 인입'으로 볼 MCP 툴 이름 **prefix**. **비우면 기능 끔**(write_tools 의 '비우면 기본값'과 반대 시맨틱).
      //  항목은 툴 이름 prefix 라 `_`·`-` 를 포함한다(예 'mcp__lively__ext__', 'mcp__lively-local__'). 서버명에 하이픈이 실제로 있다.
      //  3자 미만은 거부 — 너무 짧은 prefix 는 거의 모든 툴을 잡아 세션마다 오넛지를 만든다.
      if (input.pull_tools !== undefined) {
        if (!Array.isArray(input.pull_tools)) throw new HttpError(400, "pull_tools 는 배열이어야 합니다");
        patch.pull_tools = input.pull_tools.map((t) => str(t, "pull_tools[]", 100).trim()).filter(Boolean);
        for (const t of patch.pull_tools) {
          if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(t)) throw new HttpError(400, `pull_tools 항목 '${t}' 는 툴 이름 prefix 형식이어야 합니다(영문/숫자/_/-)`);
          if (t.length < 3) throw new HttpError(400, `pull_tools 항목 '${t}' 가 너무 짧습니다(3자 이상) — 짧은 prefix 는 무관한 툴까지 잡습니다`);
        }
        if (patch.pull_tools.length > 100) throw new HttpError(400, "pull_tools 가 너무 많습니다(100개 이하)");
      }
      // hook_relay_decisions(#892) — 러너가 PreToolUse 에서 하네스로 전파할 결정값. 빈 배열 = 아무것도 전파 안 함
      //  (게이트 전면 해제 — 의도된 상태라 허용한다). 'allow' 를 넣으면 관리자 훅이 멤버의 권한 프롬프트를
      //  건너뛸 수 있게 되므로 기본값에서 빠져 있다 — 명시 opt-in 만.
      if (input.hook_relay_decisions !== undefined) {
        if (!Array.isArray(input.hook_relay_decisions)) throw new HttpError(400, "hook_relay_decisions 는 배열이어야 합니다");
        const seen = new Set<string>();
        for (const d of input.hook_relay_decisions) {
          const s = str(d, "hook_relay_decisions[]", 10).trim().toLowerCase();
          if (!(HOOK_RELAY_DECISIONS as readonly string[]).includes(s)) {
            throw new HttpError(400, `hook_relay_decisions 항목 '${d}' 는 ${HOOK_RELAY_DECISIONS.join("|")} 만 허용됩니다`);
          }
          seen.add(s);
        }
        patch.hook_relay_decisions = [...seen] as HookRelayDecision[];
      }
      // hook_grace_ms(#1008) — 커스텀 훅 런너(run-custom)가 게이트웨이 미도달 시 최근 캐시를 쓸 유효기간(ms).
      //  null=무제한(기본, 마지막 접속 기준 영구 실행). 0 이상 정수면 그 ms 경과 후 fail-CLOSED(회수창).
      //  상한 365일 — 그 이상은 값을 크게 두는 게 아니라 null(무제한)을 쓰라는 뜻. 캐시에도 content_hash 무결성이 걸린다.
      if (input.hook_grace_ms !== undefined) {
        if (input.hook_grace_ms === null || input.hook_grace_ms === "") {
          patch.hook_grace_ms = null;
        } else {
          const n = Number(input.hook_grace_ms);
          if (!Number.isInteger(n) || n < 0 || n > 31_536_000_000) {
            throw new HttpError(400, "hook_grace_ms 는 null(무제한) 또는 0~31536000000(365일) 정수(ms)여야 합니다");
          }
          patch.hook_grace_ms = n;
        }
      }
      // 임베딩(벡터검색 #172) 런타임 토글 — provider off|http, 시크릿 금지(auth_env_ref=환경변수 이름만). store 가 다시 normalize.
      if (input.embedding_config !== undefined) {
        const raw = input.embedding_config;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "embedding_config 는 객체여야 합니다");
        const e = raw as Record<string, unknown>;
        const provider = String(e.provider ?? "off").toLowerCase();
        if (provider !== "off" && provider !== "http") throw new HttpError(400, "embedding_config.provider 는 off|http 만 허용됩니다");
        let authRef: string | null = null;
        if (e.auth_env_ref !== undefined && e.auth_env_ref !== null && e.auth_env_ref !== "") {
          authRef = str(e.auth_env_ref, "embedding_config.auth_env_ref", 100).trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(authRef)) throw new HttpError(400, "auth_env_ref 는 환경변수 이름 형식이어야 합니다(시크릿 값 금지)");
        }
        let dimensions = 1024;
        if (e.dimensions !== undefined && e.dimensions !== null && e.dimensions !== "") {
          dimensions = Number(e.dimensions);
          if (!Number.isFinite(dimensions) || dimensions < 1 || dimensions > 16000) throw new HttpError(400, "embedding_config.dimensions 는 1~16000 정수여야 합니다");
          dimensions = Math.floor(dimensions);
        }
        // 성능 튜닝(#602) — 느린/CPU 백엔드 대응. 비우면 기본값(배치 8·타임아웃 300초). store 가 다시 normalize(클램프).
        let batchSize = DEFAULT_EMBEDDING_BATCH_SIZE;
        if (e.batch_size !== undefined && e.batch_size !== null && e.batch_size !== "") {
          batchSize = Number(e.batch_size);
          if (!Number.isFinite(batchSize) || batchSize < EMBEDDING_BATCH_MIN || batchSize > EMBEDDING_BATCH_MAX) throw new HttpError(400, `embedding_config.batch_size 는 ${EMBEDDING_BATCH_MIN}~${EMBEDDING_BATCH_MAX} 정수여야 합니다`);
          batchSize = Math.floor(batchSize);
        }
        let timeoutMs = DEFAULT_EMBEDDING_TIMEOUT_MS;
        if (e.request_timeout_ms !== undefined && e.request_timeout_ms !== null && e.request_timeout_ms !== "") {
          timeoutMs = Number(e.request_timeout_ms);
          if (!Number.isFinite(timeoutMs) || timeoutMs < EMBEDDING_TIMEOUT_MIN_MS || timeoutMs > EMBEDDING_TIMEOUT_MAX_MS) throw new HttpError(400, `embedding_config.request_timeout_ms 는 ${EMBEDDING_TIMEOUT_MIN_MS}~${EMBEDDING_TIMEOUT_MAX_MS}(ms) 정수여야 합니다`);
          timeoutMs = Math.floor(timeoutMs);
        }
        // 백필 pre-flight 메모리 게이트(#1059) — 자동 백필이 임베딩 백엔드를 깨우기 전 최소 가용 메모리(MB). 0=비활성. 비우면 기본 0.
        let backfillMinMb = DEFAULT_EMBEDDING_BACKFILL_MIN_MB;
        if (e.backfill_min_available_mb !== undefined && e.backfill_min_available_mb !== null && e.backfill_min_available_mb !== "") {
          backfillMinMb = Number(e.backfill_min_available_mb);
          if (!Number.isFinite(backfillMinMb) || backfillMinMb < EMBEDDING_BACKFILL_MIN_MB_MIN || backfillMinMb > EMBEDDING_BACKFILL_MIN_MB_MAX) throw new HttpError(400, `embedding_config.backfill_min_available_mb 는 ${EMBEDDING_BACKFILL_MIN_MB_MIN}~${EMBEDDING_BACKFILL_MIN_MB_MAX} 정수여야 합니다`);
          backfillMinMb = Math.floor(backfillMinMb);
        }
        // #688 관리탭에서 끄기 저장 = '명시적 off' 마커 — .env(EMBEDDINGS_*) 시드로 부활하지 않는다(관리탭 > env).
        patch.embedding_config = provider === "off" ? { provider: "off", explicit: true } : {
          provider: "http",
          base_url: (e.base_url === undefined || e.base_url === null || e.base_url === "") ? null : str(e.base_url, "embedding_config.base_url", 500).trim(),
          model: (e.model === undefined || e.model === null || e.model === "") ? null : str(e.model, "embedding_config.model", 200).trim(),
          dimensions,
          auth_env_ref: authRef,
          batch_size: batchSize,
          request_timeout_ms: timeoutMs,
          backfill_min_available_mb: backfillMinMb,
        };
      }
      // 세션 공유(세션이력 캡처) 정책(#905 C1) — 관리탭 ▸ 세션 공유. 잡값·미지원 하네스·범위초과는 여기서 400,
      //  store 의 normalizeSessionShare 가 최종 방어. resume_policy 는 v1 고정이라 입력받지 않는다.
      if (input.session_share !== undefined) {
        const raw = input.session_share;
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "session_share 는 객체여야 합니다");
        const s = raw as Record<string, unknown>;
        const p: SessionSharePatch = {};
        // 🔴 enabled 는 **엄격 boolean**만 — 이건 조직 전체 대화 전문 캡처의 마스터 스위치다. Boolean(1)/Boolean("no")
        //  같은 느슨한 coercion 은 순수 resolve 계층(=== true)·그 테스트가 지키는 불변식과 어긋난다(입력 경계에서 막는다).
        if (s.enabled !== undefined) {
          if (typeof s.enabled !== "boolean") throw new HttpError(400, "session_share.enabled 는 boolean 이어야 합니다");
          p.enabled = s.enabled;
        }
        if (s.harnesses !== undefined) {
          if (!Array.isArray(s.harnesses)) throw new HttpError(400, "session_share.harnesses 는 배열이어야 합니다");
          const hs = s.harnesses.map((h) => str(h, "session_share.harnesses[]", 40).trim());
          for (const h of hs) if (!KNOWN_HARNESSES.includes(h)) throw new HttpError(400, `session_share.harnesses 항목 '${h}' 는 ${KNOWN_HARNESSES.join("|")} 만 허용됩니다`);
          p.harnesses = [...new Set(hs)];
        }
        if (s.scope !== undefined && !(SESSION_SHARE_SCOPES as readonly string[]).includes(String(s.scope))) throw new HttpError(400, `session_share.scope 는 ${SESSION_SHARE_SCOPES.join("|")} 만 허용됩니다`);
        if (s.scope !== undefined) p.scope = String(s.scope) as SessionSharePatch["scope"];
        if (s.store !== undefined && !(SESSION_SHARE_STORES as readonly string[]).includes(String(s.store))) throw new HttpError(400, `session_share.store 는 ${SESSION_SHARE_STORES.join("|")} 만 허용됩니다`);
        if (s.store !== undefined) p.store = String(s.store) as SessionSharePatch["store"];
        if (s.view_policy !== undefined && !(SESSION_SHARE_VIEW_POLICIES as readonly string[]).includes(String(s.view_policy))) throw new HttpError(400, `session_share.view_policy 는 ${SESSION_SHARE_VIEW_POLICIES.join("|")} 만 허용됩니다`);
        if (s.view_policy !== undefined) p.view_policy = String(s.view_policy) as SessionSharePatch["view_policy"];
        if (s.retention_days !== undefined) {
          // null/'' 은 Number() 가 0(=무제한)으로 삼켜버린다 — '값 없음'이 조용히 '무제한'이 되면 안 된다. 명시 거부.
          const n = (s.retention_days === null || s.retention_days === "") ? NaN : Number(s.retention_days);
          if (!Number.isFinite(n) || n < 0 || n > RETENTION_MAX_DAYS) throw new HttpError(400, `session_share.retention_days 는 0~${RETENTION_MAX_DAYS} 정수여야 합니다(0=무제한)`);
          p.retention_days = Math.floor(n);
        }
        patch.session_share = p;
      }
      return { runtimeConfig: await updateRuntimeConfig(patch, actorOf(user), ctx?.source ?? "web",
        { tokenHashPrefix: ctx?.tokenHashPrefix ?? null, ip: ctx?.ip ?? null }) };
    }, {
      hooks: z.object({ session_preload: z.boolean(), work_flag: z.boolean(), stop_writeback_gate: z.boolean(), self_update: z.boolean() }).partial().optional().describe("세션 훅 on/off (self_update=키트 자동 업데이트)"),
      inject_ontology_guide: z.boolean().optional().describe("#1245 온톨로지 가이드(제품 소유 섹션) 주입 on/off — 본문은 코드 단일 출처라 편집 불가, 주입 여부만 제어"),
      writeback_notice: z.string().nullable().optional().describe("세션종료 너지 문구(null=기본값)"),
      work_roots: z.array(z.string()).optional().describe("작업 루트 디렉토리"),
      allowed_auth_envs: z.array(z.string()).optional().describe("http_proxy 참조 가능 env 이름 화이트리스트"),
      url_allowlist: z.array(z.string()).optional().describe("http_proxy 허용 호스트"),
      allowed_db_hosts: z.array(z.string()).optional().describe("db 소스 허용 host"),
      allowed_internal_hosts: z.array(z.string()).optional().describe("MCP 프록시 허용 내부(사설/localhost) host — SSRF 면제(#746)"),
      allowed_db_secret_refs: z.array(z.string()).optional().describe("db 소스 auth_ref 가 참조 가능한 비번 env 이름 화이트리스트(값 아님)"),
      write_tools: z.array(z.string()).optional().describe("writeback 인정 툴 이름"),
      pull_tools: z.array(z.string()).optional().describe("외부 맥락 인입으로 볼 MCP 툴 이름 prefix(#906) — 비우면 끔"),
      session_share: z.object({
        enabled: z.boolean(), harnesses: z.array(z.string()), scope: z.enum(["main", "tree"]),
        store: z.enum(["slim", "raw"]), retention_days: z.number(), view_policy: z.enum(["attach", "owner"]),
      }).partial().optional().describe("세션이력 캡처 정책(#905 C1) — 기본 enabled=false. 관리탭 ▸ 세션 공유"),
      hook_relay_decisions: z.array(z.enum(["deny", "defer", "ask", "allow"])).optional()
        .describe("커스텀 훅(PreToolUse)의 결정 중 러너가 하네스로 전파할 값(#892). 기본 deny·ask·defer — 'allow' 는 멤버의 권한 프롬프트를 건너뛰므로 명시 opt-in. 비우면 전파 안 함(게이트 해제)"),
      hook_grace_ms: z.number().int().min(0).max(31_536_000_000).nullable().optional()
        .describe("커스텀 훅 런너(run-custom) 캐시 유효기간(ms) — 게이트웨이 미도달 시. null=무제한(기본, 마지막 접속 기준 영구 실행). 0~365일(ms) 지정 시 그 후 fail-CLOSED(#1008)"),
      // ⚠ 중첩 객체도 하위 키를 다 적어야 한다 — zod 는 미선언 하위 키를 strip 한다(#923).
      storage_policy: z.object({
        log_max_mb: z.number().int().min(0).max(10_000).optional().describe("로그 파일 상한(MB)"),
        log_keep: z.number().int().min(0).max(50).optional().describe("보관할 로그 파일 수"),
        disk_warn_pct: z.number().int().min(1).max(99).optional().describe("디스크 경고 임계치(%) — 위험 임계치보다 낮아야 한다"),
        disk_critical_pct: z.number().int().min(1).max(100).optional().describe("디스크 위험 임계치(%)"),
        mem_warn_pct: z.number().int().min(0).max(99).optional().describe("#1059 메모리 경고 임계(사용%, 0=끔) — box-watch 가 경보 웹훅 발송(디스크와 대칭)"),
        mem_critical_pct: z.number().int().min(0).max(100).optional().describe("#1059 메모리 위험 임계(사용%, 0=끔) — OOM 임박 경보. warn 보다 커야"),
        pty_warn_pct: z.number().int().min(0).max(99).optional().describe("#687후속 PTY 슬롯 경고 임계(사용%, 0=끔) — 기본 70. 고갈되면 ssh 접속까지 막혀 원격 복구 불가"),
        pty_critical_pct: z.number().int().min(0).max(100).optional().describe("#687후속 PTY 슬롯 위험 임계(사용%, 0=끔) — 기본 85. warn 보다 커야"),
        shared_cache_enabled: z.boolean().optional().describe("공유 캐시 사용"),
        shared_cache_relocate_home: z.boolean().optional().describe("홈 캐시를 공유 캐시로 재배치"),
      }).optional().describe("저장소 정책(#813) — 로그 상한·디스크 임계치. 고객 박스는 .env 를 못 고치므로 여기가 유일한 조절 창구"),
      call_log_policy: z.object({
        retention_days: z.number().int().min(0).max(3650).optional().describe("MCP 호출 감사로그 보존일수 — 이보다 오래된 기록은 삭제. 0=무기한 보관"),
      }).optional().describe("호출 감사로그 보관 정책(#1082) — mcp_call_log 는 도입 이래 무기한 쌓였다. 누가 언제 무슨 툴을 썼는지가 사람 단위로 남는 표라 보관기간을 둔다(기본 90일)"),
      session_memory_policy: z.object({
        per_session_high_mb: z.number().int().min(0).max(1_048_576).optional().describe("세션당 MemoryHigh(MB) — 초과 시 강한 회수·스로틀(kill 아님). 0=무제한"),
        per_session_max_mb: z.number().int().min(0).max(1_048_576).optional().describe("세션당 MemoryMax(MB) — 초과 시 그 세션 scope 안에서 OOM-kill. 0=무제한. MemoryHigh 이상이어야"),
      }).optional().describe("per-session cgroup 메모리 격리(#1059 D) — 세션당 MemoryHigh/Max(MB). 0=무제한(무회귀). 캡을 걸면 세션이 box-cgspawn scope 로 격리돼 폭주 세션만 OOM-kill·박스 생존"),
      session_reclaim_policy: z.object({
        idle_ttl_minutes: z.number().int().min(0).max(43_200).optional().describe("이 분(minute)을 넘게 idle 인 세션을 자동 회수. 0=끔(무회귀). managed·attached·busy·waiting 은 항상 제외"),
        pressure_used_pct: z.number().int().min(0).max(99).optional().describe("메모리 사용률이 이 %를 넘으면 평시 TTL 을 기다리지 않고 회수(#1220). 0=끔. RSS 큰 세션부터 걷고 임계 밑으로 내려가면 멈춘다 — earlyoom 이 예고 없이 SIGTERM 하기 전에 복원 가능한 방식으로 먼저 확보"),
        pressure_idle_minutes: z.number().int().min(0).max(43_200).optional().describe("압박 회수가 쓰는 완화 idle 기준(분) — 압박이어도 이보다 최근에 쓴 세션은 안 건드린다. 평시 TTL 보다 짧게(예: 평시 1440·압박 60)"),
      }).optional().describe("idle 세션 자동 회수(#1059 F) + 메모리 압박 회수(#1220) — 0=끔. 켜면 오래 idle 인 세션을 회수하되 desired-state 보존→열 때 lazy resume(admission control 대신 채택)"),
      delegate_policy: z.object({
        stall_ms: z.number().int().min(STALL_MS_MIN).max(STALL_MS_MAX).optional().describe("위탁 워커가 시작 후 한 바이트도 못 낸 채 이 ms 를 넘기면 조기 종결(#1101). 0=가드 끔. 0 초과인데 60000 미만이면 60000 으로 올린다 — 너무 짧으면 멀쩡한 작업을 죽인다"),
      }).optional().describe("위탁 태스크 정책(#1101) — 무출력 stall 상한. 자격 부재로 claude -p 가 hang 하면 종전엔 timeout(1h)까지 무출력으로 매달렸다. 레포 준비가 느린 박스는 늘리고, 배치 드레인은 줄여 빨리 실패를 본다"),
      embedding_config: z.object({
        provider: z.enum(["off", "http"]).optional().describe("off=끄기(#688 명시적 off 마커 — .env 시드로 부활 안 함) · http=외부 임베딩 API"),
        base_url: z.string().nullable().optional().describe("provider=http 일 때 임베딩 API 주소"),
        model: z.string().nullable().optional().describe("임베딩 모델 이름"),
        dimensions: z.number().int().min(1).max(16_000).optional().describe("임베딩 차원(기본 1024)"),
        auth_env_ref: z.string().nullable().optional().describe("인증에 쓸 환경변수 **이름**(시크릿 값 금지)"),
        batch_size: z.number().int().optional().describe("배치 크기(#602 — 느린/CPU 백엔드 대응). 비우면 기본값"),
        request_timeout_ms: z.number().int().optional().describe("요청 타임아웃 ms. 비우면 기본값"),
        backfill_min_available_mb: z.number().int().min(0).max(1_048_576).optional().describe("#1059 G2/G3 — 자동 백필 pre-flight 메모리 게이트: 가용 메모리가 이 MB 미만이면 이번 스윕을 건너뛴다(다음 주기 재시도, pending 유실 없음). 0=끔(무회귀). Ollama 모델 로드 스파이크가 세션 baseline 과 겹쳐 OOM 나는 걸 예방(예: 16GB 박스 4096~5000)"),
      }).optional().describe("임베딩 설정 — knowledge/project 백필과 검색이 공유"),
    }),
];

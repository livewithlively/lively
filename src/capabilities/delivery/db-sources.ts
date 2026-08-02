// delivery ▸ db-sources — DB 데이터소스 레지스트리 + 테이블/컬럼 정책 오버레이(admin 권한).
import type { Capability } from "../types.js";
import { z } from "zod";
import { HttpError, parsePosInt } from "../rest-util.js";
import type { LivelyUser } from "../../context.js";
import { MEANING } from "../../org/delivery/meaning.js";
import { assertNoHardSecrets } from "../../org/ingest/redact.js";
import {
  getRuntimeConfig, listDbSources, getDbSource, upsertDbSource, removeDbSource, upsertTablePolicy, removeTablePolicy, upsertColumnMask,
  removeColumnMask, type DbSourceInput, type DbSourceRow
} from "../../org/store.js";
import { hostOfUrl, isHostBlocked, isSecretRefAllowed, inspectConnString, inspectMysqlUrl } from "../../db/source-guard.js";
import { invalidatePool } from "../../db/pool.js";
import { listTableNames, listColumnsMeta } from "../../db/catalog.js";
import { refreshSources, listSourceConfigs } from "../../db/sources.js";
import { refreshPolicy, getSourcePolicy, getMaskStyleMap } from "../../db/policy.js";
import { isSystemDeniedTable } from "../../db/firewall.js";
import { actorOf, restOnly, slug, str } from "./shared.js";

// DB 소스 응답 마스킹 — url 원문은 노출하지 않는다(host·user·db명·잠재 시크릿). host 만 파생 노출,
//  auth_ref 는 이름(시크릿 값 아님)만. 편집 시 url 은 변경할 때만 재입력(빈칸=미변경).
export const maskDbSource = (s: DbSourceRow): Record<string, unknown> => ({
  name: s.name, driver: s.driver, host: s.url ? (hostOfUrl(s.url) ?? null) : null,
  auth_mode: s.auth_mode, auth_ref: s.auth_ref, rls: s.rls, max_rows: s.max_rows, timeout_ms: s.timeout_ms,
  note: s.note, enabled: s.enabled, table_default: s.table_default, sort: s.sort, version: s.version, updated_at: s.updated_at, updated_by: s.updated_by,
});

// env(.env)로만 정의된 DB 소스 — 관리탭이 DB 등록분과 나란히 보여주는 '코드/환경 출처' 목록. 접속문자열은 host 만.
export async function envSourcesPayload(dbNames: Set<string>): Promise<Array<{ name: string; host: string | null; rls: unknown }>> {
  await refreshSources();
  return listSourceConfigs().filter((s) => s.origin === "env" && !dbNames.has(s.name))
    .map((s) => ({ name: s.name, host: s.url ? (hostOfUrl(s.url) ?? null) : null, rls: s.rls }));
}

export const dbSourcesCapabilities: Capability[] = [
  // ════════ DB 데이터소스 레지스트리 (admin 권한) ════════
  // db_query/db_schema 가 읽는 외부 운영 DB. 시크릿 미저장: url=비번 없는 접속문자열, 인증은 auth_mode+auth_ref(참조).
  restOnly("org_db_sources", "DB 데이터소스 목록",
    "관리탭 [DB 데이터소스] — 등록된 DB 소스 목록. 접속 url(비번 가능)은 host 만, auth_ref 는 이름만 노출. allowedSecretRefs=참조 가능한 env 화이트리스트. " +
    "envSources = .env 로만 정의된 소스(#1169 — DB 등록분과 나란히 봐야 '어느 소스가 어디서 왔나'가 보인다. host 만).",
    [{ method: "GET", paths: ["/api/ui/org/db-sources"], parse: () => ({}) }],
    async (_input: Record<string, unknown>, user: LivelyUser) => {
      const all = await listDbSources();
      const cfg = await getRuntimeConfig();
      return {
        sources: all.map(maskDbSource), allowedSecretRefs: cfg.allowed_db_secret_refs,
        envSources: await envSourcesPayload(new Set(all.map((s) => s.name))), meaning: MEANING["db-source"],
      };
    }),
  restOnly("org_db_source_upsert", "DB 데이터소스 추가·수정",
    "db_query 가 읽을 외부 데이터소스를 저장한다(admin). url 은 비번 없는 접속문자열, 인증은 auth_mode + auth_ref(참조 — 시크릿 값 금지). 1차 password 만. 저장 즉시 반영(연결 풀 재생성).",
    [{ method: "POST", paths: ["/api/ui/org/db-source"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const cfg = await getRuntimeConfig(); // host·auth_ref 화이트리스트 검증 공용(운영자 통제 경계)
      const name = slug(input.name, "name");
      // driver — 미전송 시 기존 소스 값 유지(수정 시 mysql 소스가 postgres 로 뒤집히지 않게, #715).
      const existing = await getDbSource(name);
      let driver: "postgres" | "mysql";
      if (input.driver === undefined) {
        driver = existing?.driver === "mysql" ? "mysql" : "postgres";
      } else {
        const d = str(input.driver, "driver", 20);
        if (d !== "postgres" && d !== "mysql") throw new HttpError(400, "driver 는 postgres|mysql (#715)");
        driver = d;
      }
      const authMode = input.auth_mode === undefined ? "password" : str(input.auth_mode, "auth_mode", 12);
      if (!["password", "iam", "mtls", "vault"].includes(authMode)) throw new HttpError(400, "auth_mode 는 password|iam|mtls|vault");
      if (authMode !== "password") throw new HttpError(400, `auth_mode '${authMode}' 는 아직 지원되지 않습니다(1차 password 만 — iam/mtls/vault 후속)`);

      // url — 비번 인라인 hard-block + SSRF(외부 host 만 — 사설/메타데이터 IP 차단).
      let url: string | null | undefined;
      if (input.url !== undefined) {
        if (input.url === null || input.url === "") url = null;
        else {
          url = str(input.url, "url", 1000).trim();
          assertNoHardSecrets(url, "url");
          let host: string;
          if (driver === "mysql") {
            // mysql url(#715) — 엄격 화이트리스트 검사(스킴·비번 금지·database 필수·파라미터는 ssl 만).
            const mi = inspectMysqlUrl(url);
            if (!mi.ok || !mi.host) throw new HttpError(400, `mysql url 불량: ${mi.error ?? "host 없음"}`);
            host = mi.host;
          } else {
            // pg 파서 기준 검사(검증=접속 일치) — new URL 이 못 보는 ?host=/?password=/?hostaddr= 쿼리파라미터 우회 차단.
            const ins = inspectConnString(url);
            if (ins.hasPassword) throw new HttpError(400, "url 에 비밀번호를 넣지 마세요(?password= 포함) — auth_ref(환경변수 이름)로 참조하세요");
            if (ins.hasHostAddr) throw new HttpError(400, "url 에 hostaddr 파라미터는 허용되지 않습니다");
            if (!ins.host) throw new HttpError(400, "url 이 올바른 접속문자열이 아닙니다(host 없음)");
            host = ins.host;
          }
          if (await isHostBlocked(host, cfg.allowed_db_hosts)) throw new HttpError(400, `차단된 host(사설/메타데이터 IP): ${host} — 외부 DB host 만 허용됩니다(사설/localhost 는 런타임설정 allowed_db_hosts 에 먼저 등록하세요)`);
        }
      }
      // auth_ref — 환경변수 이름 형식 + 화이트리스트(인프라 시크릿 차단).
      let authRef: string | null | undefined;
      if (input.auth_ref !== undefined) {
        if (input.auth_ref === null || input.auth_ref === "") authRef = null;
        else {
          authRef = str(input.auth_ref, "auth_ref", 100).trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(authRef)) throw new HttpError(400, "auth_ref 는 환경변수 이름 형식이어야 합니다(시크릿 값 금지)");
          if (!isSecretRefAllowed(authRef, cfg.allowed_db_secret_refs)) {
            throw new HttpError(400, `auth_ref '${authRef}' 는 허용목록(allowed_db_secret_refs)에 없습니다 — 런타임 설정에 먼저 추가하세요`);
          }
        }
      }
      let rls: string | null | undefined;
      if (input.rls !== undefined) rls = (input.rls === null || input.rls === "") ? null : str(input.rls, "rls", 200).trim();
      // mysql 은 RLS(GUC set_config) 등가가 없다(#715) — 유효값(rls 미전송이면 기존값)이 남으면 명시적으로 거부.
      if (driver === "mysql") {
        const effectiveRls = rls !== undefined ? rls : (existing?.rls ?? null);
        if (effectiveRls) throw new HttpError(400, "mysql 소스는 rls(행수준 격리)를 지원하지 않습니다 — rls 를 비워두세요");
      }
      // 선택 양의정수(미지정=undefined 유지 · null/""=지움) — 정수 판정·문구는 rest-util 의 parsePosInt 로 수렴(#1313 R46).
      const posIntOpt = (v: unknown, label: string): number | null | undefined => {
        if (v === undefined) return undefined;
        if (v === null || v === "") return null;
        return parsePosInt(v, label);
      };
      let tableDefault: "allow" | "deny" | undefined;
      if (input.table_default !== undefined) {
        const td = str(input.table_default, "table_default", 8);
        if (td !== "allow" && td !== "deny") throw new HttpError(400, "table_default 는 allow|deny");
        tableDefault = td;
      }
      const payload: DbSourceInput = {
        name, driver, auth_mode: authMode as DbSourceInput["auth_mode"], url, auth_ref: authRef, rls,
        max_rows: posIntOpt(input.max_rows, "max_rows"),
        timeout_ms: posIntOpt(input.timeout_ms, "timeout_ms"),
        note: input.note == null ? undefined : str(input.note, "note", 500),
        enabled: input.enabled === undefined ? undefined : Boolean(input.enabled),
        table_default: tableDefault,
        sort: input.sort === undefined ? undefined : Number(input.sort) || 0,
      };
      const src = await upsertDbSource(payload, actorOf(user), "web");
      invalidatePool(name);
      await refreshSources(true); // 무재시작 반영
      return { source: maskDbSource(src) };
    }, {
      name: z.string().describe("소스 이름(슬러그) — db_query 가 이 이름으로 참조"),
      driver: z.enum(["postgres", "mysql"]).optional().describe("미전송 시 기존 소스 값 유지(수정 때 mysql 이 postgres 로 뒤집히지 않게, #715). 신규 기본 postgres"),
      url: z.string().nullable().optional().describe("**비번 없는** 접속문자열. 인라인 비번(?password=)·hostaddr 금지, 외부 host 만(사설/메타데이터 IP 차단)"),
      auth_mode: z.enum(["password", "iam", "mtls", "vault"]).optional().describe("기본 password — 현재 password 만 지원(iam/mtls/vault 는 후속)"),
      auth_ref: z.string().nullable().optional().describe("비밀번호가 담긴 환경변수 **이름**(값 금지). allowed_db_secret_refs 허용목록에 있어야 한다"),
      rls: z.string().nullable().optional().describe("행수준 격리 GUC 설정. mysql 은 등가가 없어 지원 안 함(#715)"),
      max_rows: z.number().int().positive().nullable().optional().describe("조회 최대 행수(양의 정수)"),
      timeout_ms: z.number().int().positive().nullable().optional().describe("조회 타임아웃 ms(양의 정수)"),
      table_default: z.enum(["allow", "deny"]).optional().describe("테이블 정책 기본자세 — 개별 정책이 없는 테이블에 적용"),
      note: z.string().optional().describe("메모"),
      enabled: z.boolean().optional().describe("활성 여부"),
      sort: z.number().optional().describe("정렬 순서"),
    }),
  restOnly("org_db_source_remove", "DB 데이터소스 제거",
    "DB 데이터소스를 제거한다(db_query 즉시 반영 — 연결 풀 재생성).",
    [{ method: "POST", paths: ["/api/ui/org/db-source/remove"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const name = slug(input.name, "name");
      await removeDbSource(name, actorOf(user), "web");
      invalidatePool(name);
      await refreshSources(true);
      return { ok: true };
    }, {
      name: z.string().describe("제거할 DB 소스 이름 — db_query 즉시 반영(풀 회수)"),
    }),

  // ── db_query 테이블 정책 · 컬럼 마스킹 (admin, #186) — 라이브 스키마 위 오버레이 편집 ──
  restOnly("org_db_source_schema", "DB 소스 스키마 오버레이(테이블 정책·컬럼 마스킹)",
    "라이브 스키마(information_schema) 위에 저장 정책을 얹어 돌려준다 — 테이블별 effective allow/deny·마스킹 컬럼 수, table 지정 시 컬럼별 마스킹 스타일. 웹 편집 UI 용.",
    [{ method: "GET", paths: ["/api/ui/org/db-source/schema"],
       parse: (req) => ({ source: req.query?.source ? String(req.query.source) : undefined, table: req.query?.table ? String(req.query.table) : undefined }) }],
    async (input: Record<string, unknown>, _user: LivelyUser) => {
      const src = slug(input.source, "source");
      await refreshSources();
      await refreshPolicy();
      if (!listSourceConfigs().some((s) => s.name === src)) throw new HttpError(404, `db source '${src}' 없음(먼저 등록·활성화)`);
      const policy = getSourcePolicy(src);
      const masks = getMaskStyleMap(src);
      // 카탈로그 조회는 엔진 공통 모듈(db/catalog.ts) — pg='public' / mysql=소스 스키마(DATABASE()) (#715).
      const names = await listTableNames(src);
      const tables = names.map((name) => {
        // 게이트웨이 내부 테이블(B18 절대 deny) — 웹 정책 무관하게 항상 차단. 편집 불가로 정직하게 표시.
        if (isSystemDeniedTable(name)) return { name, mode: "deny", explicit: true, system: true, maskedCount: 0 };
        const explicit = policy.tableMode.get(name.toLowerCase());
        const maskedCount = [...masks.keys()].filter((k) => k.startsWith(name.toLowerCase() + ".")).length;
        return { name, mode: explicit ?? policy.tableDefault, explicit: explicit !== undefined, system: false, maskedCount };
      });
      let columns: Array<Record<string, unknown>> | undefined;
      if (input.table !== undefined && input.table !== "") {
        const table = str(input.table, "table", 200);
        const cols = await listColumnsMeta(src, table);
        columns = cols.map((r) => ({
          column_name: r.column_name, data_type: r.data_type,
          masked: masks.get(`${table.toLowerCase()}.${r.column_name.toLowerCase()}`) ?? null,
        }));
      }
      return { source: src, table_default: policy.tableDefault, tables, columns, meaning: MEANING["db-source"] };
    }, {
      source: z.string().describe("DB 소스 이름(등록·활성화돼 있어야 한다)"),
      table: z.string().optional().describe("지정하면 그 테이블의 컬럼별 마스킹 스타일까지 반환"),
    }),
  restOnly("org_db_table_policy_set", "테이블 조회 정책 저장/삭제",
    "db_query 소스의 테이블별 조회 허용/차단(allow|deny)을 저장한다. remove=true 면 정책행 삭제(기본자세로 복귀). 즉시 반영.",
    [{ method: "POST", paths: ["/api/ui/org/db-source/table-policy"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const source = slug(input.source, "source");
      const table = str(input.table, "table", 200).trim();
      if (!table) throw new HttpError(400, "table 필수");
      if (isSystemDeniedTable(table)) throw new HttpError(400, "게이트웨이 내부 테이블은 항상 차단(시스템)이라 정책 대상이 아닙니다");
      if (input.remove) {
        await removeTablePolicy(source, table, actorOf(user));
      } else {
        const mode = str(input.mode, "mode", 8);
        if (mode !== "allow" && mode !== "deny") throw new HttpError(400, "mode 는 allow|deny");
        await upsertTablePolicy({ source, table_name: table, mode, note: input.note == null ? undefined : str(input.note, "note", 500) }, actorOf(user));
      }
      await refreshPolicy(true);
      return { ok: true };
    }, {
      source: z.string().describe("DB 소스 이름"),
      table: z.string().describe("테이블 이름. 게이트웨이 내부 테이블은 항상 차단(시스템)이라 정책 대상이 아니다"),
      mode: z.enum(["allow", "deny"]).optional().describe("조회 허용/차단. remove=true 가 아니면 필수"),
      remove: z.boolean().optional().describe("true=정책행 삭제(소스의 기본자세 table_default 로 복귀)"),
      note: z.string().optional().describe("메모"),
    }),
  restOnly("org_db_column_mask_set", "컬럼 마스킹 정책 저장/삭제",
    "db_query 소스의 컬럼 마스킹(full|partial|email|hash|null)을 저장한다. remove=true 면 마스킹 해제. 게이트웨이가 결정론적으로 집행(고객 DB 무수정). 즉시 반영.",
    [{ method: "POST", paths: ["/api/ui/org/db-source/column-mask"], parse: (req) => req.body ?? {} }],
    async (input: Record<string, unknown>, user: LivelyUser) => {
      const source = slug(input.source, "source");
      const table = str(input.table, "table", 200).trim();
      const column = str(input.column, "column", 200).trim();
      if (!table || !column) throw new HttpError(400, "table·column 필수");
      if (isSystemDeniedTable(table)) throw new HttpError(400, "게이트웨이 내부 테이블은 항상 차단(시스템)이라 마스킹 대상이 아닙니다");
      if (input.remove) {
        await removeColumnMask(source, table, column, actorOf(user));
      } else {
        const style = str(input.style, "style", 12);
        if (!["full", "partial", "email", "hash", "null"].includes(style)) throw new HttpError(400, "style 는 full|partial|email|hash|null");
        await upsertColumnMask({ source, table_name: table, column_name: column, style: style as "full" | "partial" | "email" | "hash" | "null", note: input.note == null ? undefined : str(input.note, "note", 500) }, actorOf(user));
      }
      await refreshPolicy(true);
      return { ok: true };
    }, {
      source: z.string().describe("DB 소스 이름"),
      table: z.string().describe("테이블 이름. 게이트웨이 내부 테이블은 항상 차단(시스템)이라 마스킹 대상이 아니다"),
      column: z.string().describe("컬럼 이름"),
      style: z.enum(["full", "partial", "email", "hash", "null"]).optional().describe("마스킹 방식. remove=true 가 아니면 필수. 게이트웨이가 결정론적으로 집행(고객 DB 무수정)"),
      remove: z.boolean().optional().describe("true=마스킹 해제"),
      note: z.string().optional().describe("메모"),
    }),
];

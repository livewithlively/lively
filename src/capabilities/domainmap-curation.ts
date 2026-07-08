// domainmap 큐레이션 그룹 capability — 게이트웨이가 domainmap 쓰기를 흡수하는 단일 표면(Stage②+⑤).
// propose_domain·domain_deprecate 만 MCP 노출(도메인 authoring — Phase C ⑤ 의도적 확장), 나머지 REST 전용.
// (현 MCP 표면 = 22툴: 기존 13 + pm 6 + domainmap authoring 2 + db_sources 1.)
// Stage⑥: 엔진 흡수 — dmGet/dmPost/dmPatch(HTTP) 대신 src/domainmap/core/* 직결.
// 에러 표면 byte-compat: dmWrite 가 코어의 e.status 4xx → HttpError(status,msg) 번역(구 dmWrite 와 동일),
// dmRead 가 읽기 에러를 구 dmGet 엔벨로프로 재현. reassign 의 UNIQUE 충돌은 코어가 raw pg 에러로
// 전파하고 여기(dm_mapping_move) 한 곳에서만 err.code==='23505' → 409 한국어로 번역한다.
// 화이트리스트 원칙: free-form 표면 금지 — 아래 13개 op(읽기 3 + 쓰기 10)만 통과하며
// 게이트웨이가 zod/parse 로 입력을 선검증하고, 모든 쓰기는 audit 로그 + actor(user.userId)로 위임한다.
// domainmap 측 검증·change_log 기록은 코어가 단일 경로로 수행(이중 감사 = 의도된 설계).
// actor-type 매핑: ctx.source==='mcp' → actor.type 'agent'(에이전트 쓰기는 도메인 단에서 가드),
// 웹/기타 → 'human'(구 x-actor-type 헤더 생략과 동일 — 기존 거동 무변경).
import { z } from "zod";
import { dmRead, dmWrite, webActor } from "./domainmap-compat.js";
import { history, restore } from "../domainmap/core/changelog.js";
// v6: 도메인 상세·부채 읽기도 repo-free category 리더로(레거시 queries.ts 무변형·골든리드 핀 보존).
import { productDomainmapView, productDomainDetail, listProductDebts, saveDomainLayout } from "../v6/domainmap-store.js";
// v6: 도메인 authoring(confirm/edit/merge/propose/deprecate/set_should)을 category(space='product')로 cutover — 구 domains.ts 폐기.
//  매핑 confirm/reject 는 mapping.status 만 다뤄 domain 무관(그대로 유지). reassign 만 category_id 로 이동.
import { getCategory } from "../v6/category-store.js";
import { confirmMapping, rejectMapping } from "../domainmap/core/mappings.js";
import { setDebtStatus } from "../domainmap/core/debts.js";
import { itemsPool } from "../items/store.js";
import { makeAudited } from "./audit-log.js";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";

const enc = encodeURIComponent;

// ── 공용 파서 ──
// repo 는 코어 SQL 파라미터로 들어가지만(주입 불가) 형식 화이트리스트는 기존대로 유지한다.
const REPO_RE = /^[A-Za-z0-9._-]+$/;
function parseRepo(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, "repo 필수 — 레포를 선택하세요");
  const s = v.trim();
  if (s.length > 100 || !REPO_RE.test(s)) throw new HttpError(400, "repo 형식이 잘못되었습니다");
  return s;
}
function parseId(v: unknown, name = "id"): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} 는 양의 정수여야 합니다`);
  return n;
}

// 쓰기 공통 audit — mapping.ts 의 curate audit 패턴과 동일 필드(by/source) + 식별 페이로드.
// '시도' 시점이 아니라 결과 시점에 기록한다: 성공 = outcome:'ok' + changeId(있으면),
// 실패 = outcome:'failed' + status — 거부된 시도가 실행된 것처럼 읽히는 포렌식 혼동 방지.
// (권위 감사는 domainmap change_log(actor)가 담당 — 이중 감사는 의도된 설계.)
const audited = makeAudited("domainmap_curate");

const zid = z.number().int().positive();

// ════════ 읽기 3종 ════════
// 경로 설계(충돌 회피): 기존 proxy = GET /api/ui/domainmap/:repo/:kind (2세그·DM_KINDS 동결).
// 신규 읽기는 1세그(debts/history — repo 는 쿼리파람)와 3세그(:repo/domain/:id)만 사용해
// 등록 순서와 무관하게 비충돌. unknown repo 는 dmRead 엔벨로프로 502 표면화(기존 proxy 와 동일 거동).

const dmDomainDetail: Capability = {
  name: "dm_domain_detail",
  title: "domainmap 영역 상세",
  description: "한 영역의 상세 — code_units/data_entities(매핑 status/origin/confidence 중첩, soft-removed 포함) + 관련 debts. 웹 큐레이션 전용(REST only).",
  scope: "context",
  input: { repo: z.string().regex(REPO_RE).max(100), id: zid },
  expose: {
    mcp: false,
    rest: [{
      method: "GET",
      paths: ["/api/ui/domainmap/:repo/domain/:id"],
      parse: (req) => ({ repo: parseRepo(req.params.repo), id: parseId(req.params.id, "domain id") }),
    }],
  },
  handler: async (input: { repo: string; id: number }) =>
    dmRead(`/api/repo/${enc(input.repo)}/domain/${input.id}`, () => productDomainDetail(input.id)),
};

const dmDebtList: Capability = {
  name: "dm_debt_list",
  title: "domainmap 이슈 목록",
  description: "레포 전체 debt(이슈) 목록 — 웹 큐레이션 전용(REST only). DM_KINDS 동결 준수를 위해 proxy 와 별도 경로.",
  scope: "context",
  input: { repo: z.string().regex(REPO_RE).max(100) },
  expose: {
    mcp: false,
    rest: [{
      method: "GET",
      paths: ["/api/ui/domainmap/debts"],
      parse: (req) => ({ repo: parseRepo(req.query.repo) }),
    }],
  },
  handler: async (input: { repo: string }) =>
    dmRead(`/api/repo/${enc(input.repo)}/debts`, () => listProductDebts()),
};

const dmHistory: Capability = {
  name: "dm_history",
  title: "domainmap 변경 이력",
  description: "change_log 스트림(최신순, limit 1..500 기본 80 — 구 UI 동일). offset 으로 최신 N건 너머 과거 이력 페이지네이션(#709) — 웹 큐레이션 전용(REST only).",
  scope: "context",
  input: {
    repo: z.string().regex(REPO_RE).max(100),
    limit: z.number().int().min(1).max(500).default(80),
    offset: z.number().int().min(0).default(0).describe("페이지 오프셋(기본 0) — 최신 N건 너머 과거 이력(#709)"),
  },
  expose: {
    mcp: false,
    rest: [{
      method: "GET",
      paths: ["/api/ui/domainmap/history"],
      parse: (req) => {
        const repo = parseRepo(req.query.repo);
        const raw = req.query.limit;
        let limit = 80;
        if (raw !== undefined && raw !== "") {
          const n = Number(raw);
          if (!Number.isInteger(n) || n < 1 || n > 500) throw new HttpError(400, "limit 은(는) 1~500 사이 정수여야 합니다");
          limit = n;
        }
        const rawOff = req.query.offset;
        let offset = 0;
        if (rawOff !== undefined && rawOff !== "") {
          const n = Number(rawOff);
          if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "offset 은(는) 0 이상 정수여야 합니다");
          offset = n;
        }
        return { repo, limit, offset };
      },
    }],
  },
  handler: async (input: { repo: string; limit: number; offset: number }) =>
    dmRead(`/api/repo/${enc(input.repo)}/history?limit=${input.limit}&offset=${input.offset}`, () => history(input.repo, input.limit, input.offset)),
};

// 도메인맵 탭(회사맥락 하위) 단일 read — 한 레포의 should(의도)/is(구조)/debt(괴리)와 그 변화의 두 축
//  이력(should 변경=의도 재조정, commit→is 변경=구조 변화)을 한 번에. 경로 1세그(domainmap/map)라
//  proxy(:repo/:kind 2세그)·debts/history 와 비충돌. handler 는 thin composition(코어 read 4종 병렬 조합).
const dmDomainmapView: Capability = {
  name: "dm_domainmap_view",
  title: "도메인 맵(should/is/debt + 변경이력)",
  description:
    "한 레포의 도메인 맵 전경 — 도메인별 should(의도)/is(매핑 코드 수)/debt 카운트, debt 상세, " +
    "should 변경 이력(의도를 누가/어떤 작업으로 어떻게 바꿨나), commit→is 변경 이력(어떤 commit 이 코드 구조를 바꿨나). 웹 도메인맵 탭 전용(REST only).",
  scope: "context",
  input: { repo: z.string().regex(REPO_RE).max(100), limit: z.number().int().min(1).max(500).default(100) },
  expose: {
    mcp: false,
    rest: [{
      method: "GET",
      paths: ["/api/ui/domainmap/map"],
      parse: (req) => {
        const repo = parseRepo(req.query.repo);
        const raw = req.query.limit;
        let limit = 100;
        if (raw !== undefined && raw !== "") {
          const n = Number(raw);
          if (!Number.isInteger(n) || n < 1 || n > 500) throw new HttpError(400, "limit 은(는) 1~500 사이 정수여야 합니다");
          limit = n;
        }
        return { repo, limit };
      },
    }],
  },
  // v6 컷오버: 소스를 레거시 domain/mapping/debt(레포 스코프)에서 category(space='product') 로 교체.
  //  응답 shape 동일(domains/debts/should_changes/is_commit_changes) — 카테고리 탭 제품 도메인맵 + 구 #/domainmap 둘 다 무변경 렌더.
  //  repo 파람은 accept-and-ignore(category 는 repo-free) — back-compat 위해 입력 repo 를 응답 repo 키로 echo.
  //  dmRead 엔벨로프는 유지(읽기 에러를 구 dmGet shape 로 재현). 골든리드 핀 queries.ts 는 무수정 — v6 reader 신규.
  handler: async (input: { repo: string; limit: number }) =>
    dmRead(`/api/repo/${enc(input.repo)}/map`, async () => {
      const view = await productDomainmapView(input.limit);
      return { ...view, repo: input.repo };
    }),
};





const dmMappingConfirm: Capability = {
  name: "dm_mapping_confirm",
  title: "domainmap 매핑 확인",
  description: "코드 유닛/데이터 엔티티 매핑 확정(rejected 행의 '다시 확인'도 같은 op). 반환 {id, change_id}.",
  scope: "context",
  input: { id: zid },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/mapping/:id/confirm"],
      parse: (req) => ({ id: parseId(req.params.id, "mapping id") }),
    }],
  },
  handler: async (input: { id: number }, user, ctx) =>
    audited("mapping_confirm", user, ctx, { id: input.id },
      () => dmWrite(() => confirmMapping(input.id, webActor(user.userId)))),
};

const dmMappingReject: Capability = {
  name: "dm_mapping_reject",
  title: "domainmap 매핑 제외",
  description: "매핑 제외(status='rejected'). 반환 {id, change_id}.",
  scope: "context",
  input: { id: zid },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/mapping/:id/reject"],
      parse: (req) => ({ id: parseId(req.params.id, "mapping id") }),
    }],
  },
  handler: async (input: { id: number }, user, ctx) =>
    audited("mapping_reject", user, ctx, { id: input.id },
      () => dmWrite(() => rejectMapping(input.id, webActor(user.userId)))),
};

const dmMappingMove: Capability = {
  name: "dm_mapping_move",
  title: "domainmap 매핑 영역 이동",
  description: "매핑을 다른 영역으로 이동 {domainId} — ⚠ 이동=확정 전이(domainmap reassign 의미). UNIQUE 충돌은 409 로 번역.",
  scope: "context",
  input: { id: zid, domainId: zid },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/mapping/:id/move"],
      parse: (req) => ({
        id: parseId(req.params.id, "mapping id"),
        domainId: parseId(((req.body ?? {}) as Record<string, unknown>).domainId, "domainId"),
      }),
    }],
  },
  handler: async (input: { id: number; domainId: number }, user, ctx) =>
    audited("mapping_move", user, ctx, { id: input.id, domainId: input.domainId }, async () => {
      // v6: 매핑을 다른 category 로 이동(mapping.category_id). domainId 는 category id 로 해석(웹 호환 — 입력 키 유지).
      const ex = (await itemsPool.query("SELECT * FROM mapping WHERE id=$1", [input.id])).rows[0];
      if (!ex) throw new HttpError(404, "no such mapping: " + input.id);
      const tcat = await getCategory(input.domainId);
      if (!tcat) throw new HttpError(400, "no such target category: " + input.domainId);
      const origin = ctx?.source === "mcp" ? "agent" : "human";
      try {
        await itemsPool.query("UPDATE mapping SET category_id=$1, status='confirmed', origin=$2, updated_at=now() WHERE id=$3",
          [input.domainId, origin, input.id]);
      } catch (err) {
        // mapping_target_category_uq(target_kind,target_id,category_id) 충돌 → 409 한국어 번역.
        if ((err as { code?: string })?.code === "23505") {
          throw new HttpError(409, "대상 영역에 같은 코드/데이터 매핑이 이미 있습니다 — 이동 대신 이 행을 제외하세요");
        }
        throw err;
      }
      return { id: input.id, change_id: null, after: { category_id: input.domainId, status: "confirmed", origin } };
    }),
};

const DEBT_STATUSES = ["open", "ack", "resolved", "dismissed"] as const;

const dmDebtStatus: Capability = {
  name: "dm_debt_status",
  title: "domainmap 이슈 상태 전환",
  description: "debt 상태 전환 {status ∈ open|ack|resolved|dismissed}. 반환 {id, change_id}.",
  scope: "context",
  input: { id: zid, status: z.enum(DEBT_STATUSES) },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/debt/:id/status"],
      parse: (req) => {
        const id = parseId(req.params.id, "debt id");
        const status = ((req.body ?? {}) as Record<string, unknown>).status;
        if (typeof status !== "string" || !(DEBT_STATUSES as readonly string[]).includes(status)) {
          throw new HttpError(400, "status 는 open|ack|resolved|dismissed 만 허용됩니다");
        }
        return { id, status };
      },
    }],
  },
  handler: async (input: { id: number; status: string }, user, ctx) =>
    audited("debt_status", user, ctx, { id: input.id, status: input.status },
      () => dmWrite(() => setDebtStatus(input.id, input.status, webActor(user.userId)))),
};

const dmRestore: Capability = {
  name: "dm_restore",
  title: "domainmap 변경 되돌리기",
  description: "change_log 항목의 before 스냅샷으로 되돌린다(undo 토스트의 단일 경로). domainmap 400(dependent rows)/404 는 상태·메시지 그대로 보존.",
  scope: "context",
  input: { changeId: zid },
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/restore/:changeId"],
      parse: (req) => ({ changeId: parseId(req.params.changeId, "change id") }),
    }],
  },
  handler: async (input: { changeId: number }, user, ctx) =>
    // restoreOf = 되돌린 대상 change id(입력) — 성공 라인의 changeId(restore 가 만든 새 change)와 키 분리.
    audited("restore", user, ctx, { restoreOf: input.changeId },
      () => dmWrite(() => restore(input.changeId, webActor(user.userId)))),
};

// v6 은퇴(2026-06-24): 도메인 authoring(dm_domain_confirm/edit/merge·propose_domain·domain_deprecate·
//  domain_set_should) 정의·등록 제거 — '주제 분류' 패널 폐기 + v6 category_*(category_create/update/edge_set)가
//  단일 표면. 유지: 도메인맵 뷰·부채·이력·복원·매핑 큐레이션(코드↔category) — 웹/큐레이션이 사용.

// 노드 위치 저장(조직 공유 레이아웃) — category.layout_x/y persist. 도메인맵 뷰 편집이라 context write.
const dmLayoutSave: Capability = {
  name: "dm_layout_save",
  title: "domainmap 노드 위치 저장",
  description: "도메인맵 노드 좌표를 조직 공유 레이아웃으로 저장. body {positions:[{id,x,y}]}. 반환 {saved}.",
  scope: "context",
  input: {},
  expose: {
    mcp: false,
    rest: [{
      method: "POST",
      paths: ["/api/ui/domainmap/layout"],
      parse: (req: any) => ({ positions: Array.isArray(req.body?.positions) ? req.body.positions : [] }),
    }],
  },
  handler: async (input: any, user: any, ctx: any) =>
    audited("layout_save", user, ctx, { n: (input.positions || []).length },
      () => dmWrite(() => saveDomainLayout(input.positions || []))),
};

export const domainmapCurationCapabilities: Capability[] = [
  dmDomainDetail, dmDebtList, dmHistory, dmDomainmapView,
  dmMappingConfirm, dmMappingReject, dmMappingMove,
  dmDebtStatus, dmRestore, dmLayoutSave,
];

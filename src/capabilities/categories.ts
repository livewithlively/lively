// v6 category capability — 사업/제품/시스템 카테고리 CRUD + 도메인 의존 엣지(should).
//  레거시 domain_* 와 병행(REST-only 로 시작 — 웹 카테고리/지식/프로젝트 탭이 소비). MCP 노출은 컷오버에서 일괄.
//  scope='context'(domainmap authoring 계열 — domain_* 와 동일). 감사는 store(category-store)가 처리.
import { z } from "zod";
import { HttpError, parseId } from "./rest-util.js";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import {
  listCategories, getCategory, createCategory, updateCategory, deleteCategory,
  listCategoryEdges, setCategoryEdge, removeCategoryEdge, setCategoryView,
  getCategoryRepos, setCategoryRepos, getCategoryIsSummary, listCategoryMismatches,
} from "../v6/category-store.js";

const SPACES = ["business", "product", "system"] as const;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function parseSpace(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!(SPACES as readonly string[]).includes(s)) {
    throw new HttpError(400, "space 는 business|product|system 중 하나여야 합니다");
  }
  return s;
}

const categoryListInput = { space: z.enum(SPACES).optional() };
type CategoryListInput = z.infer<z.ZodObject<typeof categoryListInput>>;
const categoryList: Capability = {
  name: "category_list",
  title: "카테고리 목록",
  description: "카테고리(사업/제품/시스템)를 space 별 또는 전체 조회. 제품 space 의 카테고리가 도메인.",
  scope: "context",
  input: categoryListInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/categories"],
      parse: (req) => ({ space: req.query?.space ? String(req.query.space) : undefined }) }],
  },
  // 공개범위(#1291) — 카테고리 행은 전원 공개(분류체계는 조직의 뼈대)지만, 행에 실린 **지식 카운트**는 뷰어 기준이다.
  handler: async (input: CategoryListInput, _user: LivelyUser, ctx?: CapabilityCtx) => ({ categories: await listCategories(input.space, ctx?.viewer ?? null) }),
};

const categoryGetInput = { id: z.number().int().positive() };
type CategoryGetInput = z.infer<z.ZodObject<typeof categoryGetInput>>;
const categoryGet: Capability = {
  name: "category_get",
  title: "카테고리 상세",
  description: "카테고리 1건 + 의존 엣지(should/is) 조회.",
  scope: "context",
  input: categoryGetInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/categories/:id"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: CategoryGetInput, _user: LivelyUser, ctx?: CapabilityCtx) => {
    const category = await getCategory(input.id);
    if (!category) throw new Error(`카테고리 #${input.id} 없음`);
    const edges = await listCategoryEdges({ categoryId: input.id });
    // #1153 — 명시 레포 매핑 + 정의와 어긋나는 지식 목록 + (제품) is 요약.
    //  mismatches=null 은 '재지 못했다'(임베딩 off · should 공란 · 백필 대기)이지 '어긋난 게 없다'가 아니다.
    const repos = await getCategoryRepos(input.id);
    const mismatches = await listCategoryMismatches(input.id, undefined, ctx?.viewer ?? null);   // 지식 제목이 나가는 자리(#1291)
    const is = category.space === "product" ? await getCategoryIsSummary(input.id) : null;
    return { category, edges, repos, mismatches, is };
  },
};

// ── 카테고리↔레포 명시 매핑(#1153) — 전체 교체(project_set_repos_v6 와 동형 시맨틱). ──
//  지금까지 도메인↔레포는 mapping→code_unit→repo 역산 파생값뿐이라 스캔 표류에 흔들리고 부트스트랩 전엔 비어 있었다.
const categorySetReposInput = { id: z.number().int().positive(), repos: z.array(z.string().max(200)).max(50) };
type CategorySetReposInput = z.infer<z.ZodObject<typeof categorySetReposInput>>;
const categorySetRepos: Capability = {
  name: "category_set_repos",
  title: "카테고리 레포 설정",
  description:
    "이 카테고리(분류)가 어느 코드 레포에 사는지 **명시적으로** 설정한다(전체 교체 — 기존 목록에 더해서 넘길 것). " +
    "레포 이름은 레포 레지스트리(관리탭 ▸ 레포) 기준. 코드 스캔이 만드는 파생 매핑과 별개로, 사람이 선언하는 정본이다.",
  scope: "context",
  input: categorySetReposInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/categories/:id/repos"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return {
          id: parseId(req.params?.id),
          repos: Array.isArray(b.repos) ? b.repos.map((r) => String(r)).slice(0, 50) : [],
        };
      } }],
  },
  handler: async (input: CategorySetReposInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { repos: await setCategoryRepos(input.id, input.repos, writeCtx) };
  },
};

const categoryCreateInput = {
  space: z.enum(SPACES),
  // REST 와 동일 의미: 소문자화 후 슬러그 검증(대문자 입력 허용 → 소문자로 정규화).
  key: z.string().transform((s) => s.trim().toLowerCase()).pipe(z.string().regex(KEY_RE, "key 는 소문자 슬러그(a-z0-9_-, 64자 이내)여야 합니다")),
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  should: z.string().max(8000).optional(),
  cross_cutting: z.boolean().optional(),
};
type CategoryCreateInput = z.infer<z.ZodObject<typeof categoryCreateInput>>;
const categoryCreate: Capability = {
  name: "category_create",
  title: "카테고리 생성",
  description: "space(사업/제품/시스템) 하위에 카테고리를 만든다. 제품이면 도메인(is/debt 추적 대상).",
  scope: "context",
  input: categoryCreateInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/categories"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const space = parseSpace(b.space);
        const key = String(b.key ?? "").trim().toLowerCase();
        if (!KEY_RE.test(key)) throw new HttpError(400, "key 는 소문자 슬러그(a-z0-9_-, 64자 이내)여야 합니다");
        const name = String(b.name ?? "").trim();
        if (!name) throw new HttpError(400, "name 이 필요합니다");
        return {
          space, key, name,
          description: b.description ? String(b.description) : undefined,
          should: b.should ? String(b.should) : undefined,
          cross_cutting: b.cross_cutting === true || undefined,
        };
      } }],
  },
  handler: async (input: CategoryCreateInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { category: await createCategory(input, writeCtx) };
  },
};

const categoryUpdateInput = {
  id: z.number().int().positive(),
  name: z.string().max(200).optional(),
  description: z.string().max(4000).optional(),
  should: z.string().max(8000).optional(),
  cross_cutting: z.boolean().optional(),
};
type CategoryUpdateInput = z.infer<z.ZodObject<typeof categoryUpdateInput>>;
const categoryUpdate: Capability = {
  name: "category_update",
  title: "카테고리 수정",
  description: "카테고리 이름·설명·should(정의·범위·규칙)를 수정.",
  scope: "context",
  input: categoryUpdateInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/categories/:id"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return {
          id: parseId(req.params?.id),
          name: b.name != null ? String(b.name) : undefined,
          description: b.description != null ? String(b.description) : undefined,
          should: b.should != null ? String(b.should) : undefined,
          cross_cutting: typeof b.cross_cutting === "boolean" ? b.cross_cutting : undefined,
        };
      } }],
  },
  handler: async (input: CategoryUpdateInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    const { id, ...patch } = input;
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { category: await updateCategory(id, patch, writeCtx) };
  },
};

// ── #592 카테고리 뷰 설정 — category_update 확장 금지(계약): 뷰 설정은 별도 cap(REST 전용). ──
//  view_mode=list|table|entry(본문 영역 렌더 방식), entry_name=엔트리 문서(knowledge.name, null=해제).
//  3상 부분 수정: 키 부재=미변경 / null(entry_name)=해제 / 값=설정. 존재 검증·감사는 store(setCategoryView).
const categoryViewSetInput = {
  id: z.number().int().positive(),
  view_mode: z.enum(["list", "table", "entry"]).optional(),
  entry_name: z.string().min(1).max(64).nullable().optional(),
};
type CategoryViewSetInput = z.infer<z.ZodObject<typeof categoryViewSetInput>>;
const categoryViewSet: Capability = {
  name: "category_view_set",
  title: "카테고리 뷰 설정",
  description: "카테고리 본문 영역의 뷰(view_mode=list|table|entry)와 엔트리 문서(entry_name, null=해제)를 설정한다. 웹 전용.",
  scope: "context",
  input: categoryViewSetInput,
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/categories/:id/view"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const out: Record<string, unknown> = { id: parseId(req.params?.id) };
        if ("view_mode" in b) {
          const vm = String(b.view_mode ?? "");
          if (!["list", "table", "entry"].includes(vm)) throw new HttpError(400, "view_mode 는 list|table|entry 중 하나여야 합니다");
          out.view_mode = vm;
        }
        if ("entry_name" in b) {
          const en = b.entry_name == null ? null : String(b.entry_name).trim();
          if (en === "") throw new HttpError(400, "entry_name 은 지식 이름 또는 null(해제)이어야 합니다");
          out.entry_name = en;
        }
        return out;
      } }],
  },
  handler: async (input: CategoryViewSetInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    const { id, ...patch } = input;
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { category: await setCategoryView(id, patch, writeCtx) };
  },
};

// ⚠ 사람(웹)만 — 에이전트(MCP)는 403(비가역, 매핑·엣지·정션 cascade). 가역 숨김은 비활성(deprecate). 복원은 content_restore(본체만).
const categoryDeleteInput = { id: z.number().int().positive() };
type CategoryDeleteInput = z.infer<z.ZodObject<typeof categoryDeleteInput>>;
const categoryDelete: Capability = {
  name: "category_delete",
  title: "카테고리 삭제",
  description:
    "카테고리를 삭제한다(매핑·엣지·정션 cascade). 감사 스냅샷으로 보존되어 content_restore 로 본체 복원 가능(연결은 복원 안 됨). " +
    "⚠ 사람(웹)만 — 에이전트(MCP)는 403(비가역). 가역적 숨김은 비활성(deprecate) 으로.",
  scope: "context",
  input: categoryDeleteInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/categories/:id/delete"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: CategoryDeleteInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    if (ctx?.source === "mcp") {
      throw new HttpError(403, "카테고리 삭제는 사람(웹)만 가능합니다 — 에이전트는 거부됩니다(비가역). 숨김은 비활성(deprecate) 으로 가능합니다");
    }
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return deleteCategory(input.id, writeCtx);
  },
};

// ── 도메인 의존 엣지(should). is 엣지는 스캔 전용(읽기만). 경로는 /category-edges 로 분리(/:id 충돌 회피). ──
const categoryEdgeListInput = { axis: z.enum(["should", "is"]).optional() };
type CategoryEdgeListInput = z.infer<z.ZodObject<typeof categoryEdgeListInput>>;
const categoryEdgeList: Capability = {
  name: "category_edge_list",
  title: "카테고리 의존 엣지",
  description: "should(의도)·is(코드 import) 의존 엣지 조회.",
  scope: "context",
  input: categoryEdgeListInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/category-edges"],
      parse: (req) => ({ axis: req.query?.axis ? String(req.query.axis) : undefined }) }],
  },
  handler: async (input: CategoryEdgeListInput) => ({ edges: await listCategoryEdges({ axis: input.axis }) }),
};

const categoryEdgeSetInput = {
  from_category_id: z.number().int().positive(),
  to_category_id: z.number().int().positive(),
  relation: z.string().max(64).optional(),
};
type CategoryEdgeSetInput = z.infer<z.ZodObject<typeof categoryEdgeSetInput>>;
const categoryEdgeSet: Capability = {
  name: "category_edge_set",
  title: "should 엣지 저작",
  description: "도메인間 의도된 의존(should 엣지)을 추가/갱신. is 엣지는 스캔 전용.",
  scope: "context",
  input: categoryEdgeSetInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/category-edges"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const from = Number(b.from_category_id);
        const to = Number(b.to_category_id);
        if (!Number.isInteger(from) || !Number.isInteger(to)) {
          throw new HttpError(400, "from_category_id·to_category_id 가 필요합니다");
        }
        return { from_category_id: from, to_category_id: to, relation: b.relation ? String(b.relation) : undefined };
      } }],
  },
  handler: async (input: CategoryEdgeSetInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    const writeCtx = { actor: ctx?.actor ?? user?.userId ?? null, source: ctx?.source ?? "web" };
    return { edge: await setCategoryEdge(input, writeCtx) };
  },
};

const categoryEdgeRemoveInput = { id: z.number().int().positive() };
type CategoryEdgeRemoveInput = z.infer<z.ZodObject<typeof categoryEdgeRemoveInput>>;
const categoryEdgeRemove: Capability = {
  name: "category_edge_remove",
  title: "should 엣지 삭제",
  description: "수동 should 엣지를 삭제(is 엣지는 스캔 소유라 불가).",
  scope: "context",
  input: categoryEdgeRemoveInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/category-edges/:id/delete"],
      parse: (req) => ({ id: parseId(req.params?.id) }) }],
  },
  handler: async (input: CategoryEdgeRemoveInput) => removeCategoryEdge(input.id),
};

export const categoryCapabilities: Capability[] = [
  categoryList, categoryGet, categoryCreate, categoryUpdate, categoryViewSet, categoryDelete,
  categorySetRepos,
  categoryEdgeList, categoryEdgeSet, categoryEdgeRemove,
];

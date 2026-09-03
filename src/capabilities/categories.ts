// v6 category capability — 분류축(카테고리) CRUD + 축 간 의존 엣지(should).
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

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// ⚠ 2026-09-02(#1631) space(business|product|system) 폐기 — 분류축 위에 **고정 서랍장**을 하나 더 두지 않는다.
//  그 셋은 소프트웨어 회사의 분류지 쓰는 사람의 분류가 아니었다. 옛 클라이언트가 space 를 보내오면 조용히 무시한다
//  (400 이 아니다 — 서버가 먼저 나가고 번들이 뒤따르는 배포 순서에서 그 사이 요청을 깨뜨리지 않는다).
const categoryListInput = {};
type CategoryListInput = z.infer<z.ZodObject<typeof categoryListInput>>;
const categoryList: Capability = {
  name: "category_list",
  title: "카테고리 목록",
  description: "분류축(카테고리) 전체 조회 — 이 워크스페이스의 지식이 어느 서랍들로 갈라져 있는지.",
  scope: "context",
  input: categoryListInput,
  expose: {
    mcp: true,
    rest: [{ method: "GET", paths: ["/api/ui/categories"], parse: () => ({}) }],
  },
  // 공개범위(#1291) — 카테고리 행은 전원 공개(분류체계는 조직의 뼈대)지만, 행에 실린 **지식 카운트**는 뷰어 기준이다.
  handler: async (_input: CategoryListInput, _user: LivelyUser, ctx?: CapabilityCtx) => ({ categories: await listCategories(ctx?.viewer ?? null) }),
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
    // #1153 — 명시 레포 매핑 + 정의와 어긋나는 지식 목록 + is(코드 앵커) 요약.
    //  mismatches=null 은 '재지 못했다'(임베딩 off · should 공란 · 백필 대기)이지 '어긋난 게 없다'가 아니다.
    const repos = await getCategoryRepos(input.id);
    const mismatches = await listCategoryMismatches(input.id, undefined, ctx?.viewer ?? null);   // 지식 제목이 나가는 자리(#1291)
    //  is 는 «코드가 붙어 있으면» 나오고 아니면 0 이다 — 축의 부류로 가르지 않는다(#1631 space 폐기).
    const is = await getCategoryIsSummary(input.id);
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
  // REST 와 동일 의미: 소문자화 후 슬러그 검증(대문자 입력 허용 → 소문자로 정규화).
  key: z.string().transform((s) => s.trim().toLowerCase()).pipe(z.string().regex(KEY_RE, "key 는 소문자 슬러그(a-z0-9_-, 64자 이내)여야 합니다")),
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  //  ★ 정의(should)는 **필수**다(#1631 실측). 정의 없이 만들어진 축은 이름만 남아, 분류·소환이
  //   그 이름의 어감으로만 판정하게 된다 — 실측에서 한 워크스페이스는 축 3개가 전부 정의 0자였고
  //   다른 워크스페이스는 81~114자였다. 같은 코드가 같은 일을 두 가지로 하면 그건 규정이 빈 자리다.
  //   40자 하한은 «한 문장은 쓰게» 하는 최소치일 뿐이고, 권장 분량은 아래 설명에 적는다.
  should: z.string().trim().min(40, "정의(should)를 40자 이상 적어 주세요 — 이 축이 무엇을 담고 무엇을 담지 않는지가 있어야 분류가 됩니다").max(8000),
  cross_cutting: z.boolean().optional(),
};
type CategoryCreateInput = z.infer<z.ZodObject<typeof categoryCreateInput>>;
const categoryCreate: Capability = {
  name: "category_create",
  title: "카테고리 생성",
  description: "카테고리(분류축)를 만든다. **should(정의)가 필수** — 이 축이 무엇을 담고 무엇을 담지 않는지, 인접 축과의 경계를 400~600자로 적는다(하한 40자). "
    + "정의가 없으면 분류·소환이 축 이름의 어감으로만 판정한다. "
    + "⚠ 정의는 **주제 경계**만 적는다 — 민감정보·개인정보 정책(«계좌번호는 싣지 않는다» 류)은 쓰지 마라. "
    + "분류기가 그 문장을 분류 기준으로 읽고, 실제 차단은 공개범위·마스킹 층이 하므로 여기 적어 둬도 한 줄도 막지 못한다.",
  scope: "context",
  input: categoryCreateInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/categories"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const key = String(b.key ?? "").trim().toLowerCase();
        if (!KEY_RE.test(key)) throw new HttpError(400, "key 는 소문자 슬러그(a-z0-9_-, 64자 이내)여야 합니다");
        const name = String(b.name ?? "").trim();
        if (!name) throw new HttpError(400, "name 이 필요합니다");
        const should = String(b.should ?? "").trim();
        if (should.length < 40) throw new HttpError(400, "정의(should)를 40자 이상 적어 주세요 — 이 축이 무엇을 담고 무엇을 담지 않는지가 있어야 분류가 됩니다");
        return {
          key, name,
          description: b.description ? String(b.description) : undefined,
          should,
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
  //  ★ 축을 «치우는» 유일한 수단(#1631). 삭제는 비가역이라 사람(웹)만 되는데, 비활성조차 없어서
  //   리브가 쓸 수 있는 게 **이름 칸뿐**이었다 — 실측(서리재): 분류축 이름이
  //   「(통합됨) 행정·신고·세무 → 관공서·인허가/정산·자금」 이 됐다. 이름은 안내문 자리가 아니다.
  //   지식이 남아 있으면 거절한다(미분류는 소환에 안 잡힌다).
  state: z.enum(["active", "deprecated"]).optional()
    .describe("비활성으로 치우거나 되살린다. 지우는 게 아니라 **분류 후보에서 빼는 것** — 이미 든 지식이 있으면 거절되니 먼저 옮겨라. 삭제는 사람(웹)만 가능."),
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

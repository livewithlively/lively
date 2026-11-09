// 워크스페이스 간 옮기기(#5458) — 가져오기 미리보기(계획)와 결정 해소. **순수 함수**(DB 없음 — 받는 쪽 상태를 주입받는다).
//
// 지식 한 건의 판정(설계 v0, 2026-11-09 확정):
//   ┌ 가져온 기록이 있다(같은 곳에서 전에 가져왔다)
//   │   ├ 여기서 그 문서를 지웠다              → reimport_deleted       기본 건너뛰기 (다시 만들기 가능)
//   │   ├ 원본·여기 둘 다 그대로                → reimport_unchanged     기본 건너뛰기
//   │   ├ 원본만 바뀜                          → reimport_update        기본 갱신
//   │   ├ 여기만 바뀜                          → reimport_local_changed 기본 건너뛰기(여기 수정 보존)
//   │   └ 둘 다 바뀜                           → reimport_conflict      기본 건너뛰기 · 덮어쓰기 · 둘 다 남기기
//   ├ 처음 보는데 같은 이름이 여기 있다           → name_taken             기본 새 이름으로 따로 · 덮어쓰기 · 건너뛰기
//   ├ 처음 보고 이름도 비어 있다                 → new                    기본 새로 만들기
//   └ 받는 쪽이 모르는 값(종류·상태)·빈 본문       → invalid                건너뛴다(적용 도중 실패하지 않게 — 보완 6)
//
// «바뀌었나» 는 지문 둘로 가른다(store.ts 머리말): origin_hash(가져올 때 묶음 쪽) · local_hash(가져온 직후 여기 행).
//
// 정해 둔 기본값(2026-11-09):
//  · 대상자를 제한한 지식 → 받는 쪽에서 **공개**로 들인다(상민님 결정 — 내보낼 때 안내만 한다).
//    연결된 자료도 같은 규칙이다(리뷰 지적 2026-11-09: 자료는 안내 없이 공개가 되고 있었다 — 내보내기·가져오기 미리보기 둘 다 알린다).
//  · 외부 미러(observed) → 일반 지식(authored)으로 들이고 원래 주소를 필드에 남긴다(보완 3).
//  · 위키 핀(is_wiki) → 핀 없이 들인다 — 핀은 받는 쪽의 모든 세션에 주입되는 큐레이션이라 조용히 늘리지 않는다.
//  · 이름이 바뀌어 들어가는 지식을 가리키는 [[링크]] 는 같은 묶음 안에서 새 이름으로 고쳐 쓴다(보완 4).
import type { Bundle, BundleKnowledge, BundleProblem } from "./bundle.js";
import { bundleContentHash, contentHash } from "./bundle.js";
import { slugify } from "../v6/knowledge-common.js";
import { RE_WIKI, mapProseSegments } from "../v6/wikilink.js";

export const TARGET_TYPES: readonly string[] = ["decision", "concept", "how-to", "reference", "research", "entity"];
export const TARGET_LIFECYCLES: readonly string[] = ["active", "pending", "superseded", "archived"];
export const TARGET_LINK_RELATIONS: readonly string[] = ["related", "refines", "contradicts", "depends_on"];
export const TARGET_SOURCE_RELATIONS: readonly string[] = ["derived_from", "cites"];
/** 분류가 없던 지식이 들어갈 자리 — 받는 쪽에 이 key 가 없으면 만든다(미리보기에서 다른 분류로 바꿀 수 있다). */
export const UNSORTED = {
  ref: "__none__",
  key: "imported",
  name: "가져온 지식(분류 전)",
  should: "다른 워크스페이스에서 가져왔지만 원래 분류가 없던 지식을 잠시 두는 곳이다. 알맞은 분류를 찾아 옮긴다.",
} as const;
const NAME_MAX = 64;

export type KnowledgeStatus =
  | "new" | "name_taken"
  | "reimport_update" | "reimport_unchanged" | "reimport_local_changed" | "reimport_conflict" | "reimport_deleted"
  | "invalid";
export type KnowledgeAction = "create" | "rename" | "overwrite" | "update" | "skip";

export interface TargetKnowledge {
  name: string;
  title: string | null;
  body_md: string;
  type: string | null;
  category: string | null;
  summary: string | null;
  is_folder: boolean;
  parent_name: string | null;
  fields: Record<string, unknown>;
  /** 외부 미러(observed)면 덮어쓰기를 막는다 — 다음 재싱크가 원본으로 되돌려 덮어쓴 내용이 사라진다. */
  provenance?: string;
}

export interface TargetCategory { key: string; name: string | null; state: string }

export interface TargetState {
  workspaceUid: string;
  /** 받는 쪽의 모든 지식 이름 — 이름 겹침 판정 · 새 이름 찾기 */
  names: ReadonlySet<string>;
  /** 계획에 필요한 지식의 내용(묶음과 같은 이름 · 가져온 기록이 가리키는 이름) */
  knowledge: ReadonlyMap<string, TargetKnowledge>;
  categories: readonly TargetCategory[];
  originsKnowledge: ReadonlyMap<string, { local_ref: string; origin_hash: string | null; local_hash: string | null }>;
  originsCategory: ReadonlyMap<string, { local_ref: string }>;
  originsSource: ReadonlyMap<string, { local_ref: string }>;
  /** 받는 쪽에 지금 있는 자료 id(가져온 기록이 가리키는 것만) */
  sourceIds: ReadonlySet<number>;
  /** 외부 좌표 키(sourceExternalKey) → 받는 쪽 자료 id */
  sourcesByExternal: ReadonlyMap<string, number>;
}

export interface PlanKnowledgeItem {
  ref: string;
  title: string | null;
  /** 묶음 쪽 분류 key(없으면 UNSORTED.ref) */
  category: string;
  is_folder: boolean;
  status: KnowledgeStatus;
  /** 새로 만들게 되면 쓸 이름 — 겹치지 않게 미리 비워 둔 이름 */
  new_name: string;
  /** 관련된 받는 쪽 지식(같은 이름이거나 전에 가져온 것) */
  existing: string | null;
  action: KnowledgeAction;
  actions: KnowledgeAction[];
  reason?: string;
  notes: string[];
}

export type CategoryDecision = { action: "map"; to: string } | { action: "create"; key?: string; name?: string };

export interface PlanCategoryItem {
  /** 묶음 쪽 key(분류가 없던 지식 묶음은 UNSORTED.ref) */
  ref: string;
  name: string | null;
  should: string | null;
  count: number;
  suggestion: { action: "map"; to: string; why: "before" | "same_key" | "same_name" } | { action: "create"; key: string; name: string | null };
}

export interface PlanSummary {
  total: number;
  create: number;
  rename: number;
  update: number;
  overwrite: number;
  skip: number;
  invalid: number;
  conflict: number;
  local_changed: number;
  unchanged: number;
  deleted_here: number;
}

export interface Plan {
  version: 1;
  origin: { workspace_uid: string; name: string | null; gateway_url: string | null };
  bundle_created_at: string;
  summary: PlanSummary;
  knowledge: PlanKnowledgeItem[];
  categories: PlanCategoryItem[];
  sources: { count: number; existing: number; fresh: number };
  problems: BundleProblem[];
  notes: string[];
}

export interface Decisions {
  knowledge?: Record<string, KnowledgeAction>;
  categories?: Record<string, CategoryDecision>;
  include_sources?: boolean;
}

/** 사람이 고칠 수 있는 입력 문제(같은 워크스페이스로 가져오기 · 없는 분류로 맞추기) — REST 400 으로 나간다. */
export class PlanError extends Error {}

export const sourceExternalKey = (system: string | null, instance: string | null, id: string | null): string | null =>
  system && id ? `${system}\u0001${instance ?? ""}\u0001${id}` : null;

export const targetContentHash = (t: TargetKnowledge): string => contentHash({
  title: t.title, body_md: t.body_md, type: t.type, category: t.category, summary: t.summary,
  is_folder: t.is_folder, parent: t.parent_name, fields: t.fields,
});

// ── 이름 ─────────────────────────────────────────────────────────────────────────────

/** 비어 있는 새 이름 — `이름-2`, `이름-3` … (64자 안에서). taken 에 없고 reserved 에도 없는 첫 이름. */
export function freeName(base: string, taken: ReadonlySet<string>, reserved: Set<string>): string {
  const b = slugify(base);
  if (!taken.has(b) && !reserved.has(b)) return b;
  for (let i = 2; i < 10_000; i++) {
    const suffix = `-${i}`;
    const cand = `${b.slice(0, NAME_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(cand) && !reserved.has(cand)) return cand;
  }
  throw new Error(`'${base}' 의 비어 있는 새 이름을 찾지 못했습니다`);
}

// ── 판정 ─────────────────────────────────────────────────────────────────────────────

function invalidReason(k: BundleKnowledge): string | null {
  // slugify 는 쓸 글자가 하나도 없으면 "untitled" 를 돌려준다 — 원래 이름이 "untitled" 가 아니면 이름이 빈 것이다.
  if (slugify(k.ref) === "untitled" && k.ref !== "untitled") return "이름이 비어 있습니다";
  if (k.type && !TARGET_TYPES.includes(k.type)) return `받는 쪽이 모르는 종류(type '${k.type}')입니다`;
  if (!TARGET_LIFECYCLES.includes(k.lifecycle)) return `받는 쪽이 모르는 상태(lifecycle '${k.lifecycle}')입니다`;
  if (k.is_folder && !k.title?.trim()) return "폴더 이름(title)이 비었습니다";
  if (!k.is_folder && !k.body_md.trim()) return "본문이 비었습니다";
  return null;
}

function itemNotes(k: BundleKnowledge): string[] {
  const n: string[] = [];
  if (k.provenance === "observed") n.push(`외부 미러${k.external_system ? `(${k.external_system})` : ""}였던 지식입니다 — 일반 지식으로 들이고 원래 주소를 필드에 남깁니다.`);
  if (k.visibility !== "open") n.push("대상자를 제한했던 지식입니다 — 공개로 들어갑니다.");
  if (k.is_wiki) n.push("위키 핀이었던 지식입니다 — 핀 없이 들어갑니다.");
  if (!k.type && !k.is_folder) n.push("종류(type)가 비어 있어 reference 로 들입니다.");
  return n;
}

const ACTIONS: Record<KnowledgeStatus, { dflt: KnowledgeAction; allowed: KnowledgeAction[] }> = {
  new: { dflt: "create", allowed: ["create", "skip"] },
  name_taken: { dflt: "rename", allowed: ["rename", "overwrite", "skip"] },
  reimport_update: { dflt: "update", allowed: ["update", "skip"] },
  reimport_unchanged: { dflt: "skip", allowed: ["skip", "update"] },
  reimport_local_changed: { dflt: "skip", allowed: ["skip", "update"] },
  reimport_conflict: { dflt: "skip", allowed: ["skip", "update", "rename"] },
  reimport_deleted: { dflt: "skip", allowed: ["skip", "create"] },
  invalid: { dflt: "skip", allowed: ["skip"] },
};

/** 묶음 + 받는 쪽 상태 → 미리보기. 같은 입력이면 같은 결과(이름 예약은 묶음 순서대로 결정적). */
export function planImport(bundle: Bundle, target: TargetState, problems: BundleProblem[] = []): Plan {
  if (bundle.manifest.origin.workspace_uid === target.workspaceUid) {
    throw new PlanError("이 파일은 이 워크스페이스에서 내보낸 것입니다 — 같은 워크스페이스로는 가져올 수 없습니다");
  }
  const reserved = new Set<string>();
  const items: PlanKnowledgeItem[] = [];
  // 결정적 순서 — 폴더(상위)를 먼저, 그다음 이름순. 이름 예약 순서가 실행마다 달라지지 않게.
  const ordered = [...bundle.knowledge].sort((a, b) => (Number(b.is_folder) - Number(a.is_folder)) || a.ref.localeCompare(b.ref));
  // 이름 예약 1차 — 처음 보고 이름도 비어 있는 지식이 **자기 이름을 먼저** 갖는다. 그래야 겹친 지식의 새 이름(`x-2`)이
  //  묶음 안에 원래 `x-2` 로 들어오는 다른 지식의 자리를 빼앗지 않는다(그러면 «새로 만들기» 인데 이름이 바뀐다).
  for (const k of ordered) {
    if (invalidReason(k) || target.originsKnowledge.has(k.ref)) continue;
    const slug = slugify(k.ref);
    if (!target.names.has(slug)) reserved.add(slug);
  }
  const ownName = new Set(reserved);
  const claimed = new Set<string>();
  for (const k of ordered) {
    const category = k.category ?? UNSORTED.ref;
    const base: Omit<PlanKnowledgeItem, "status" | "new_name" | "existing" | "action" | "actions"> = {
      ref: k.ref, title: k.title, category, is_folder: k.is_folder, notes: itemNotes(k),
    };
    const bad = invalidReason(k);
    if (bad) {
      items.push({ ...base, status: "invalid", new_name: slugify(k.ref), existing: null, action: "skip", actions: ["skip"], reason: bad });
      continue;
    }
    const lineage = target.originsKnowledge.get(k.ref);
    let status: KnowledgeStatus;
    let existing: string | null = null;
    if (lineage) {
      existing = lineage.local_ref;
      const local = target.knowledge.get(lineage.local_ref);
      if (!local) status = "reimport_deleted";
      else {
        const srcChanged = lineage.origin_hash !== bundleContentHash(k);
        const localChanged = lineage.local_hash !== targetContentHash(local);
        status = srcChanged ? (localChanged ? "reimport_conflict" : "reimport_update") : (localChanged ? "reimport_local_changed" : "reimport_unchanged");
      }
    } else {
      const slug = slugify(k.ref);
      if (target.names.has(slug)) { status = "name_taken"; existing = slug; }
      else status = "new";
    }
    // 새로 만들 수 있는 판정이면 이름을 미리 비워 둔다(다른 항목과도 겹치지 않게 예약).
    const { dflt } = ACTIONS[status];
    let allowed = ACTIONS[status].allowed;
    // 같은 이름의 문서가 외부 미러면 덮어쓰기를 내놓지 않는다(다음 재싱크가 원본으로 되돌린다).
    if (status === "name_taken" && existing && target.knowledge.get(existing)?.provenance === "observed") {
      allowed = allowed.filter((a) => a !== "overwrite");
    }
    let newName = slugify(k.ref);
    if (status === "new" && ownName.has(newName) && !claimed.has(newName)) {
      claimed.add(newName); // 1차에서 예약한 자기 이름
    } else if (allowed.includes("create") || allowed.includes("rename")) {
      // 겹친 이름 · 다시 만들기 · 묶음 안에서 슬러그가 같은 둘 중 뒤의 것 → 비어 있는 새 이름
      const wanted = status === "reimport_deleted" && lineage ? lineage.local_ref : k.ref;
      newName = freeName(wanted, target.names, reserved);
      reserved.add(newName);
      claimed.add(newName);
      if (status === "new") base.notes.push(`같은 묶음 안의 다른 지식과 이름이 겹쳐 '${newName}' 으로 들입니다.`);
    }
    items.push({ ...base, status, new_name: newName, existing, action: dflt, actions: allowed });
  }

  // 분류 — 담긴 지식이 쓰는 key 마다 한 줄(분류가 없던 지식은 UNSORTED 한 줄).
  const counts = new Map<string, number>();
  for (const it of items) if (it.status !== "invalid") counts.set(it.category, (counts.get(it.category) ?? 0) + 1);
  const byKey = new Map(bundle.categories.map((c) => [c.key, c]));
  const active = target.categories.filter((c) => c.state === "active");
  const activeKeys = new Set(active.map((c) => c.key));
  const allKeys = new Set(target.categories.map((c) => c.key));
  const reservedKeys = new Set<string>();
  const categories: PlanCategoryItem[] = [];
  for (const [ref, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const isUnsorted = ref === UNSORTED.ref;
    const c = byKey.get(ref);
    const name = isUnsorted ? UNSORTED.name : (c?.name ?? null);
    const should = isUnsorted ? UNSORTED.should : (c?.should ?? null);
    const before = target.originsCategory.get(ref);
    const wantKey = isUnsorted ? UNSORTED.key : ref;
    let suggestion: PlanCategoryItem["suggestion"];
    if (before && activeKeys.has(before.local_ref)) suggestion = { action: "map", to: before.local_ref, why: "before" };
    else if (activeKeys.has(wantKey)) suggestion = { action: "map", to: wantKey, why: "same_key" };
    else {
      const sameName = name ? active.find((t) => (t.name ?? "").trim().toLowerCase() === name.trim().toLowerCase()) : undefined;
      if (sameName) suggestion = { action: "map", to: sameName.key, why: "same_name" };
      else {
        let key = wantKey;
        for (let i = 2; allKeys.has(key) || reservedKeys.has(key); i++) key = `${wantKey}-${i}`;
        reservedKeys.add(key);
        suggestion = { action: "create", key, name };
      }
    }
    categories.push({ ref, name, should, count, suggestion });
  }

  // 자료 — 이미 있는 것(전에 가져왔거나 같은 외부 원본)은 연결만 한다.
  let existingSources = 0;
  for (const s of bundle.sources) {
    const lin = target.originsSource.get(s.ref);
    const ext = sourceExternalKey(s.external_system, s.external_instance, s.external_id);
    if ((lin && target.sourceIds.has(Number(lin.local_ref))) || (ext && target.sourcesByExternal.has(ext))) existingSources++;
  }

  const notes: string[] = [];
  const restricted = bundle.knowledge.filter((k) => k.visibility !== "open").length;
  if (restricted) notes.push(`대상자를 제한했던 지식 ${restricted}건은 공개로 들어갑니다.`);
  const restrictedSources = bundle.sources.filter((x) => x.visibility !== "open").length;
  if (restrictedSources) notes.push(`대상자를 제한했던 자료 ${restrictedSources}건도 함께 들이면 공개로 들어갑니다.`);
  const pinned = bundle.knowledge.filter((k) => k.is_wiki).length;
  if (pinned) notes.push(`위키 핀이었던 지식 ${pinned}건은 핀 없이 들어갑니다.`);
  const observed = bundle.knowledge.filter((k) => k.provenance === "observed").length;
  if (observed) notes.push(`외부 미러였던 지식 ${observed}건은 일반 지식으로 들어갑니다(원래 주소는 필드에 남습니다).`);

  return {
    version: 1,
    origin: { workspace_uid: bundle.manifest.origin.workspace_uid, name: bundle.manifest.origin.name, gateway_url: bundle.manifest.origin.gateway_url },
    bundle_created_at: bundle.manifest.created_at,
    summary: summarize(items),
    knowledge: items,
    categories,
    sources: { count: bundle.sources.length, existing: existingSources, fresh: bundle.sources.length - existingSources },
    problems,
    notes,
  };
}

export function summarize(items: readonly Pick<PlanKnowledgeItem, "status" | "action">[]): PlanSummary {
  const s: PlanSummary = { total: items.length, create: 0, rename: 0, update: 0, overwrite: 0, skip: 0, invalid: 0, conflict: 0, local_changed: 0, unchanged: 0, deleted_here: 0 };
  for (const it of items) {
    s[it.action]++;
    if (it.status === "invalid") s.invalid++;
    if (it.status === "reimport_conflict") s.conflict++;
    if (it.status === "reimport_local_changed") s.local_changed++;
    if (it.status === "reimport_unchanged") s.unchanged++;
    if (it.status === "reimport_deleted") s.deleted_here++;
  }
  return s;
}

// ── 결정 해소 ────────────────────────────────────────────────────────────────────────

export interface ResolvedItem extends PlanKnowledgeItem {
  /** 최종 행동(결정이 허용 범위 밖이면 기본값) */
  final: KnowledgeAction;
  /** 받는 쪽에 쓰일 이름(skip 이면 null) */
  target_name: string | null;
  /** 받는 쪽 분류 key */
  target_category: string;
}

export interface Resolved {
  items: ResolvedItem[];
  /** 묶음 쪽 이름 → 받는 쪽 이름(링크·상위 폴더·[[…]] 고쳐 쓰기용). 건너뛴 항목도 전에 가져온 것이면 그 이름. */
  nameMap: Map<string, string>;
  /** 묶음 쪽 분류 ref → 받는 쪽 key */
  categoryMap: Map<string, string>;
  /** 만들 분류 */
  createCategories: Array<{ ref: string; key: string; name: string | null; should: string | null; description: string | null }>;
  include_sources: boolean;
}

/** 미리보기 + 사람의 결정 → 실행할 일. 결정이 없거나 허용 범위 밖이면 기본값으로 간다(조용히 위험한 쪽으로 가지 않는다). */
export function resolveDecisions(plan: Plan, decisions: Decisions, target: Pick<TargetState, "categories" | "originsKnowledge">, bundleCategories: Bundle["categories"]): Resolved {
  const activeKeys = new Set(target.categories.filter((c) => c.state === "active").map((c) => c.key));
  const allKeys = new Set(target.categories.map((c) => c.key));
  const categoryMap = new Map<string, string>();
  const createCategories: Resolved["createCategories"] = [];
  const createdKeys = new Set<string>();
  const byKey = new Map(bundleCategories.map((c) => [c.key, c]));
  for (const c of plan.categories) {
    const d = decisions.categories?.[c.ref];
    let choice: CategoryDecision = c.suggestion.action === "map" ? { action: "map", to: c.suggestion.to } : { action: "create", key: c.suggestion.key, name: c.suggestion.name ?? undefined };
    if (d?.action === "map" && typeof d.to === "string" && activeKeys.has(d.to)) choice = d;
    else if (d?.action === "create") choice = { action: "create", key: d.key ?? (c.suggestion.action === "create" ? c.suggestion.key : c.ref), name: d.name ?? c.name ?? undefined };
    else if (d?.action === "map") throw new PlanError(`분류 '${c.ref}' 를 맞출 대상 '${(d as { to?: unknown }).to}' 가 받는 쪽에 없습니다`);
    if (choice.action === "map") { categoryMap.set(c.ref, choice.to); continue; }
    const wantedKey = slugify(choice.key ?? c.ref).slice(0, 64);
    // 이번에 이미 만들기로 한 key 면 함께 쓴다(묶음 분류 둘을 새 분류 하나로 합치는 결정).
    if (createdKeys.has(wantedKey)) { categoryMap.set(c.ref, wantedKey); continue; }
    // 사람이 «새 분류로 만들기» 를 고른 것이면 같은 key 가 살아 있어도 **새로** 만든다(비어 있는 key 로) — 그 분류에 넣고 싶었으면
    //  «여기의 … 에 넣기» 를 골랐을 것이다(리뷰 지적 2026-11-09: 종전엔 같은 key 가 있으면 조용히 기존 분류로 넣었다).
    //  제안으로 온 «만들기» 는 애초에 같은 key 가 없을 때만 나오므로 이 갈래는 사람의 결정에서만 걸린다.
    if (activeKeys.has(wantedKey) && d?.action !== "create") { categoryMap.set(c.ref, wantedKey); continue; }
    let key = wantedKey;
    for (let i = 2; allKeys.has(key) || createdKeys.has(key); i++) key = `${wantedKey}-${i}`;
    const src = byKey.get(c.ref);
    createCategories.push({ ref: c.ref, key, name: choice.name ?? c.name, should: c.should, description: src?.description ?? null });
    createdKeys.add(key);
    categoryMap.set(c.ref, key);
  }

  const items: ResolvedItem[] = [];
  const nameMap = new Map<string, string>();
  for (const it of plan.knowledge) {
    const wanted = decisions.knowledge?.[it.ref];
    const final: KnowledgeAction = wanted && it.actions.includes(wanted) ? wanted : it.action;
    let targetName: string | null = null;
    if (final === "create" || final === "rename") targetName = it.new_name;
    else if (final === "overwrite" || final === "update") targetName = it.existing;
    if (targetName) nameMap.set(it.ref, targetName);
    else {
      const lin = target.originsKnowledge.get(it.ref);
      if (lin && it.status !== "reimport_deleted") nameMap.set(it.ref, lin.local_ref);
    }
    items.push({ ...it, final, target_name: targetName, target_category: categoryMap.get(it.category) ?? UNSORTED.key });
  }
  return { items, nameMap, categoryMap, createCategories, include_sources: decisions.include_sources !== false };
}

// ── 본문 고쳐 쓰기 ───────────────────────────────────────────────────────────────────

/** 본문의 [[이름]] 중 이름이 바뀐 것만 새 이름으로. 코드 안의 [[…]] 는 예시라 건드리지 않는다(wikilink.ts 와 같은 규칙).
 *  대상 해소는 받는 쪽 규칙(정확히 같은 이름 → 슬러그)과 같은 순서로 묶음 이름에 대어 본다. */
export function rewriteWikiLinks(body: string, nameMap: ReadonlyMap<string, string>): string {
  if (!body.includes("[[") || !nameMap.size) return body;
  return mapProseSegments(body, (seg) => seg.replace(RE_WIKI, (whole, rawTarget: string, label: string | undefined) => {
    const hash = rawTarget.indexOf("#");
    const base = (hash >= 0 ? rawTarget.slice(0, hash) : rawTarget).trim();
    const anchor = hash >= 0 ? rawTarget.slice(hash) : "";
    const mapped = nameMap.get(base) ?? nameMap.get(slugify(base));
    if (!mapped || mapped === base) return whole;
    return `[[${mapped}${anchor}${label !== undefined ? `|${label}` : ""}]]`;
  }));
}

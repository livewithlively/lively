// 서술 형식 위반을 사람 없이 푸는 저장 경로 배선 — 기준 날짜 조회(감사 기록)와 본문 길이 자동 분리.
//
// 판정·계획은 순수 함수(v6/writing-resolve.ts·writing-split.ts)에 있고, 여기는 DB 조회와 하위 지식 저장 순서만 맡는다.
import { itemsPool } from "../../db/client.js";
import { orgTimezone } from "../../org/timezone.js";
import { slugify } from "../../v6/knowledge-common.js";
import { ANCHOR_LOOKUP_MAX, dateIn, timeAnchors, timeReferenceLines, type TimeAnchor } from "../../v6/writing-resolve.js";
import { planBodySplit, renderSplitParent, type SplitPlan } from "../../v6/writing-split.js";
import { DATE_RE, MR_REF_RE, PICTO_RE, SIGNAL_SYMBOL_RE } from "../../v6/writing-lint.js";

/**
 * 줄마다 본문에 처음 들어간 판의 저장 시각 — 판마다 본문 전문이 남는 감사 기록(insert·update)에서 한 번의 조회로 찾는다.
 *  줄은 글자·숫자만 남긴 꼴(lineKey)로 줄 머리부터 끝까지 맞아야 잡는다. 긴 줄의 일부만 같은 다른 줄로 이른 날이 나오지 않게
 *  하고, 굵게·기호·띄어쓰기만 고친 형식 정리 저장을 «그 줄이 처음 생긴 판» 으로 잡지 않게 한다 — 잡으면 형식만 고친 날이
 *  기준 날짜가 되고, 다음 형식 정리가 그 날짜를 사실 변경 없이 적게 된다. 감사 행마다 본문을 한 번만 푼다.
 */
export async function firstSeenInAudit(name: string, lines: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  const byKey = new Map<string, string[]>();
  for (const l of lines) {
    const k = lineKey(l);
    if (k) byKey.set(k, [...(byKey.get(k) ?? []), l]);
  }
  if (!byKey.size) return out;
  const r = await itemsPool.query<{ k: string; at: Date }>(
    `SELECT l.k, min(a.at) AS at
       FROM (SELECT at, E'\n' || regexp_replace(coalesce(after->>'body_md', ''), $4, '', 'g') || E'\n' AS body FROM org_content_audit
              WHERE entity='knowledge' AND entity_key=$1 AND op = ANY($2::text[])) a
       JOIN unnest($3::text[]) AS l(k) ON strpos(a.body, E'\n' || l.k || E'\n') > 0
      GROUP BY l.k`, [name, ["insert", "update"], [...byKey.keys()], LINE_KEY_DROP]);
  for (const row of r.rows) for (const l of byKey.get(row.k) ?? []) out.set(l, row.at);
  return out;
}

/** 줄 맞춤 키에서 지우는 글자 — 글자·숫자와 줄바꿈만 남긴다(SQL 과 JS 가 같은 식을 쓴다). */
const LINE_KEY_DROP = "[^0-9A-Za-z가-힣\n]";
const LINE_KEY_DROP_RE = new RegExp(LINE_KEY_DROP, "g");
export const lineKey = (line: string): string => line.replace(LINE_KEY_DROP_RE, "");

/** 한 저장 안에서 같은 지식의 줄별 조회 결과를 다시 쓴다(판정이 두 번 돌 때). */
export type AnchorCache = Map<string, Date | null>;

/** 지식 본문의 시점 표현 줄마다 기준 날짜. beforeBody 를 주면 저장(그 본문에 없던 줄은 오늘), 안 주면 읽기. */
export async function knowledgeAnchors(o: {
  name: string | null | undefined; body: string; beforeBody?: string | null;
  updatedAt?: Date | string | null; cache?: AnchorCache;
}): Promise<TimeAnchor[]> {
  const tz = await orgTimezone().catch(() => "UTC");
  const cache = o.cache ?? new Map<string, Date | null>();
  const before = o.beforeBody === undefined ? null : new Set(String(o.beforeBody ?? "").split("\n").map((l) => l.trim()));
  const legacy = timeReferenceLines(o.body).map((x) => x.line).filter((l) => (!before || before.has(l)) && !cache.has(l));
  if (o.name && legacy.length) {
    const found = await firstSeenInAudit(o.name, legacy.slice(0, ANCHOR_LOOKUP_MAX)).catch(() => new Map<string, Date>());
    for (const l of legacy.slice(0, ANCHOR_LOOKUP_MAX)) cache.set(l, found.get(l) ?? null);
  }
  return timeAnchors({
    body: o.body, beforeBody: o.beforeBody, now: new Date(), updatedAt: o.updatedAt, tz,
    firstSeen: o.name ? async (line) => cache.get(line) ?? null : undefined,
  });
}

// ── 본문 길이 자동 분리 ──

export interface SplitChildInput {
  name: string; title: string; body_md: string; category: string; type: string;
  parent_name: string; provenance: "authored"; change_note: string;
  /** 옮긴 원문 — 새 지식이지만 이 글에 원래 있던 형식 위반은 거부 사유가 아니다(writing-style checkWriting before). */
  legacyBody: string;
}

/**
 * 분리가 하위 지식을 저장할 때 그 입력 객체에 옮긴 원문을 붙여 두는 자리. 입력 필드로 싣지 않는 것은 바깥 호출자(MCP·REST)가
 *  «이 글의 위반은 원래 있던 것» 이라고 주장해 형식 거부를 비껴가지 못하게 하기 위해서다 — 표시는 서버 코드가 markSplitChild 로만
 *  붙이고, 같은 입력 객체로만 읽힌다(직렬화된 요청 본문으로는 만들 수 없다).
 */
const splitLegacy = new WeakMap<object, string>();
export const markSplitChild = (input: object, legacyBody: string): void => { splitLegacy.set(input, legacyBody); };
export const splitLegacyOf = (input: object): string | undefined => splitLegacy.get(input);

export interface AutoSplitResult {
  body: string;
  children: Array<{ name: string; title: string; chars: number }>;
}

const TITLE_MAX = 60;

/** 옮긴 조각의 제목 — 원래 제목 앞부분과 절 제목. 제목 거부 규칙(날짜·MR·기호·이모지)에 걸리는 조각은 뺀다.
 *  seq 는 한 절이 여러 조각으로 나뉘었을 때의 순번(1부터)이고, 절 하나가 한 조각이면 null 이다. */
export function splitChildTitle(parentTitle: string, heading: string | null, seq: number | null): string {
  const clean = (s: string): string => s
    .replace(new RegExp(DATE_RE.source, "g"), "").replace(new RegExp(MR_REF_RE.source, "g"), " ")
    .replace(SIGNAL_SYMBOL_RE, "").replace(new RegExp(PICTO_RE.source, "gu"), "")
    .replace(/[—–]/g, " ").replace(/[([（【]\s*[)\]）】]/g, "").replace(/\s{2,}/g, " ").trim();
  const head = clean(heading ?? "뒷부분") || "본문";
  const tail = ` 「${head}」 절${seq == null ? "" : ` ${seq}`}`;
  const room = TITLE_MAX - [...tail].length;
  const base = [...clean(parentTitle)].slice(0, Math.max(8, room)).join("").trim();
  return [...`${base}${tail}`].slice(0, TITLE_MAX).join("");
}

/** 하위 지식 이름 — <원래 이름>-archive-<날짜>[-n], 64자 안. 이미 있으면 번호를 올린다. 원장을 손으로 나눠 온 보관본 이름과
 *  같은 꼴이라, 보관본을 이름 꼴로 모아 세는 소비자가 자동 분리분도 함께 센다. */
async function freeChildName(parent: string, date: string, taken: Set<string>): Promise<string> {
  const suffix = `-archive-${date}`;
  const base = slugify(`${parent.slice(0, 64 - suffix.length - 3)}${suffix}`);
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (taken.has(name)) continue;
    const r = await itemsPool.query(`SELECT 1 FROM knowledge WHERE name=$1`, [name]);
    if (!r.rowCount) { taken.add(name); return name; }
  }
  throw new Error("분리 지식 이름을 정하지 못했습니다");
}

export interface AutoSplitDeps {
  /** 하위 지식을 저장한다 — knowledge_save 핸들러를 그대로 탄다(시크릿·게이트·형식 판정 전부). 실패하면 던진다. */
  saveChild: (input: SplitChildInput) => Promise<{ name: string; lifecycle?: string | null }>;
}

/**
 * 상한을 넘은 본문을 나눈다 — 옮길 조각을 하위 지식으로 먼저 저장하고, 저장을 확인한 뒤에야 남는 본문(링크 자리 채움)을 돌려준다.
 *  계획을 못 세우면 null(호출자는 종전 거부·안내로 돌아간다). 조각 저장이 중간에 실패하면 던진다 — 원래 지식은 아직 바뀌지
 *  않았고, 앞서 저장된 조각은 호출자가 지운다(authoring rollbackSplit).
 */
export async function autoSplitBody(o: {
  parentName: string; parentTitle: string; body: string; limit: number; category: string; type: string;
}, deps: AutoSplitDeps): Promise<AutoSplitResult | null> {
  const plan: SplitPlan | null = planBodySplit(o.body, o.limit);
  if (!plan) return null;
  const tz = await orgTimezone().catch(() => "UTC");
  const date = dateIn(new Date(), tz);
  const taken = new Set<string>();
  const names: string[] = [];
  const children: AutoSplitResult["children"] = [];
  for (const part of plan.parts) {
    const name = await freeChildName(o.parentName, date, taken);
    const sameHeading = plan.parts.filter((p) => p.heading === part.heading);
    const title = splitChildTitle(o.parentTitle, part.heading, sameHeading.length > 1 ? sameHeading.indexOf(part) + 1 : null);
    const where = part.heading ? `「${part.heading}」 절` : "본문 뒷부분";
    const lead = `이 지식은 [[${o.parentName}]] 의 ${where}을 원문 그대로 옮긴 것이다(${date}, 본문 길이 상한에 따른 자동 분리).`;
    const body_md = `${lead}\n\n${part.text}`;
    const saved = await deps.saveChild({
      name, title, body_md, category: o.category, type: o.type, parent_name: o.parentName, provenance: "authored",
      change_note: `${o.parentName} 의 ${where}을 본문 길이 상한 때문에 원문 그대로 옮겼다.`,
      legacyBody: part.text,
    });
    if (saved.lifecycle && saved.lifecycle !== "active") {
      throw new Error(`분리 지식 ${saved.name} 이 검토 대기(${saved.lifecycle})로 저장돼 원래 지식을 줄이지 않았습니다`);
    }
    names.push(saved.name);
    children.push({ name: saved.name, title, chars: [...body_md].length });
  }
  return { body: renderSplitParent(plan, names), children };
}

/** 분리 대상 지식의 분류·유형·공개범위·검색 여부와 자료 연결 여부. 없으면 null. */
export async function splitParentMeta(name: string): Promise<{ category: string | null; type: string | null; visibility: string | null; searchable: boolean; derived: boolean } | null> {
  const r = await itemsPool.query<{ type: string | null; visibility: string | null; searchable: boolean; category: string | null; derived: boolean }>(
    `SELECT k.type, k.visibility, k.searchable,
            EXISTS(SELECT 1 FROM knowledge_source ks WHERE ks.name=k.name AND ks.relation='derived_from') AS derived,
            (SELECT c.key FROM knowledge_category kc JOIN category c ON c.id=kc.category_id
              WHERE kc.name=k.name AND kc.state<>'rejected' ORDER BY (kc.state='confirmed') DESC, c.id LIMIT 1) AS category
       FROM knowledge k WHERE k.name=$1`, [name]);
  return r.rows[0] ?? null;
}

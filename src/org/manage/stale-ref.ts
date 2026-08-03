// 관리기 판정기 ▸ stale_ref — **문서가 가리키는 코드 경로가 사라졌다**(#1419 도그푸드 산출).
//
//  왜 이 판정기를 새로 만들었나 — 기존 4종을 우리 조직 지식(1,103건)에 실제로 돌려 보고 나온 결론이다.
//   · mismatch(의미 거리)는 정밀도가 낮다. #1195 가 같은 신호를 같은 데이터로 재서 **2/21** 을 얻었고,
//     이 판정기를 만들며 다시 표본 6건을 분류축 정의와 대조했더니 2건 맞고 4건이 오탐이었다.
//   · outdated 는 우리 조직에서 **구조적으로 눈이 없다**. `knowledge_source` 계보로 '원천 자료가 지식보다
//     앞서갔나'를 보는데, 우리 지식 1,103건 중 자료가 연결된 것이 10건뿐이다(거의 전부 authored).
//   → 즉 "관리 안 해서 낡은 지식이 많다"는 실제 상태를 **아무 판정기도 보지 못했다.**
//
//  이 판정기는 그 자리를 결정론으로 메운다. 실측(2026-08-03, 라이블리 지식 1,103건):
//   본문이 인용한 레포 경로 582개 중 **159개가 레포에 없다**(#1313 리팩토링으로 대거 이동·삭제).
//
//  ⚠ 그런데 그걸 그대로 발견으로 내면 정밀도가 0에 가깝다. 표본 4건이 전부 오탐이었고 이유가 구조적이다:
//   우리 지식은 대부분 **as-built·결정 기록**이라 "그때 건드린 파일 목록"을 적는다
//   (예: "변경: web/core.ts · public/styles.css. 커밋 a42ee08"). 그 경로가 지금 없는 것은 낡음이 아니라
//   **정확한 역사 기록**이다. 지운 이유를 그 문서가 설명하고 있는 경우도 있다(리팩토링 로드맵이 자기가
//   쪼갠 파일을 '대상'으로 적는다).
//
//  → **경로 사라짐이 '낡음'을 뜻하는 것은 현재형 주장을 하는 문서뿐이다.** 그래서 page-type 으로 가른다:
//     reference(사양·불변식) · how-to(런북) 만 본다. decision · research 는 과거 기록이라 제외한다.
//     실측: 그 컷으로 159개 경로 → **reference 58문서 · how-to 19문서**(dead 인용 139건)로 좁는다.
//     이것이 #1195 가 남긴 교훈("주제가 같은가가 아니라 이 문서의 역할이 그 축의 역할인가")의 적용이다.
//
//  결정론이라 LLM 이 0이고, 제안이 기계적이다 — 같은 파일명이 다른 경로에 있으면 **이동한 자리를 찍어 준다**
//  (실측 예: src/org/default-content.ts → src/org/delivery/default-content.ts).
import { readdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { itemsPool, q } from "../../db/client.js";
import type { ManagerRow } from "../store/managers.js";
import type { Finding } from "./detectors.js";

/** 문서가 '현재 사실'을 주장하는 page-type — 이것만 본다(과거 기록은 dead 경로가 정상이다). */
export const STALE_REF_TYPES = ["reference", "how-to"] as const;

/**
 * 본문에서 레포 경로를 뽑는 정규식. 앞에 공백·백틱·괄호·대괄호가 오는 경우만 잡아
 *  URL 이나 더 긴 식별자 중간을 잘라 오지 않게 한다.
 *  ⚠ 확장자를 요구한다 — 확장자가 없으면 디렉터리·모듈 이름과 구분이 안 되고, 그건 '사라짐' 판정이 불가능하다.
 */
const PATH_RE = /(?:^|[\s`([])((?:src|web|scripts|deploy|kit|public)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs|css|sh|json|md))/g;

/** 한 레포 클론의 파일 목록(상대경로 집합) + 파일명→경로 색인. 이동 위치를 제시하는 데 색인이 필요하다. */
export interface RepoIndex { files: Set<string>; byBase: Map<string, string[]> }

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".playwright-mcp", "coverage", ".next", "logs", "data"]);

/**
 * 레포 워킹트리를 걸어 파일 색인을 만든다. base 클론(workspace/repos/<repo>)을 읽는다 —
 *  refresh_bases 크론이 그 클론을 최신으로 유지하므로 별도 fetch 가 필요 없다.
 *  ⚠ dist·node_modules 를 건너뛴다: 빌드 산출물이 들어오면 '살아 있음'이 거짓으로 판정된다
 *   (예: 지운 src/x.ts 의 dist/x.js 가 남아 있으면 경로가 다른데도 basename 색인이 오염된다).
 */
export function indexRepo(root: string): RepoIndex {
  const files = new Set<string>();
  const byBase = new Map<string, string[]>();
  const walk = (dir: string, rel: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e)) continue;
      const abs = join(dir, e);
      const r = rel ? `${rel}/${e}` : e;
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, r);
      else {
        files.add(r);
        const b = basename(r);
        const list = byBase.get(b);
        if (list) list.push(r); else byBase.set(b, [r]);
      }
    }
  };
  walk(resolve(root), "");
  return { files, byBase };
}

/** 인용된 경로 하나의 판정 — 살아 있나 · 이동했나 · 사라졌나. 순수 함수(테스트가 여기를 본다). */
export type RefVerdict =
  | { state: "alive" }
  | { state: "moved"; to: string[] }
  | { state: "gone" };

export function verifyRef(path: string, idx: RepoIndex): RefVerdict {
  if (idx.files.has(path)) return { state: "alive" };
  // 같은 파일명이 다른 자리에 있으면 '이동'으로 본다 — 그게 #1313 류 리팩토링의 지배적 형태이고,
  //  사람에게 줄 수 있는 가장 구체적인 다음 행동이다(문서의 경로만 고치면 끝난다).
  //  ⚠ 자기 자신은 후보에서 빠진다(위 files.has 에서 이미 걸렀다).
  const cands = idx.byBase.get(basename(path));
  if (cands && cands.length) return { state: "moved", to: cands.slice(0, 3) };
  return { state: "gone" };
}

/** 본문에서 인용 경로를 중복 없이 뽑는다. */
export function extractPaths(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(PATH_RE)) out.add(m[1]);
  return [...out];
}

/**
 * 판정 — reference·how-to 지식이 인용한 경로 중 레포에 없는 것을 찾는다.
 *  repoIndex 는 호출자가 준다(레포 클론 위치를 아는 것은 실행 계층의 몫이고, 그래야 이 함수가 테스트 가능하다).
 */
export async function detectStaleRefs(
  m: ManagerRow, limit: number, idx: RepoIndex,
): Promise<Finding[]> {
  const params: unknown[] = [];
  // 스코프 — 관리기가 분류축·space 를 좁혔으면 따른다. page-type 은 이 판정기가 강제한다
  //  (사용자가 match_types 로 decision 을 넣어도 무의미하고, 넣으면 오탐만 늘기 때문).
  const conds = [
    "COALESCE(k.is_folder,false) = false",
    "k.body_md IS NOT NULL",
    `k.type = ANY($${params.push(STALE_REF_TYPES as unknown as string[])}::text[])`,
    "k.lifecycle = 'active'",
  ];
  if (m.match_spaces?.length) {
    conds.push(`EXISTS (SELECT 1 FROM knowledge_category kc JOIN category c ON c.id=kc.category_id
                         WHERE kc.name=k.name AND kc.state<>'rejected' AND c.space = ANY($${params.push(m.match_spaces)}::text[]))`);
  }
  if (m.match_categories?.length) {
    conds.push(`EXISTS (SELECT 1 FROM knowledge_category kc JOIN category c ON c.id=kc.category_id
                         WHERE kc.name=k.name AND kc.state<>'rejected' AND c.key = ANY($${params.push(m.match_categories)}::text[]))`);
  }
  if (m.exclude_names?.length) conds.push(`k.name <> ALL($${params.push(m.exclude_names)}::text[])`);

  const rows = await q(itemsPool, `
    SELECT k.name, k.title, k.type, k.body_md
      FROM knowledge k
     WHERE ${conds.join(" AND ")}
     ORDER BY k.updated_at ASC`, params);

  const out: Finding[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    const moved: Array<{ path: string; to: string[] }> = [];
    const gone: string[] = [];
    for (const p of extractPaths(String(r.body_md))) {
      const v = verifyRef(p, idx);
      if (v.state === "moved") moved.push({ path: p, to: v.to });
      else if (v.state === "gone") gone.push(p);
    }
    if (!moved.length && !gone.length) continue;

    const total = moved.length + gone.length;
    const label = String(r.title || r.name);
    const bits: string[] = [];
    if (moved.length) bits.push(moved.map((x) => `${x.path} → ${x.to.join(" 또는 ")}`).join(" · "));
    if (gone.length) bits.push(`${gone.join(" · ")} (레포에 같은 파일명이 없음 — 삭제됐거나 이름이 바뀌었다)`);

    out.push({
      target_kind: "knowledge",
      target_ref: String(r.name),
      // 경로 집합이 바뀌면 새 문제다 — 하나 고치고 하나 남았을 때 '같은 발견'으로 묶이면 진행이 안 보인다.
      dedup_key: [...moved.map((x) => x.path), ...gone].sort().join(","),
      // 이동은 경로만 고치면 되지만 삭제는 문서가 설명하는 대상 자체가 없어진 것이라 더 무겁다.
      severity: gone.length ? "warn" : "note",
      summary: `‘${label}’ 이 가리키는 코드 경로 ${total}개가 지금 레포에 없습니다`,
      evidence:
        `${MANAGER_TYPE_NOTE[String(r.type)] ?? "현재 사실을 주장하는 문서"}인데 인용 경로가 사라졌습니다. ${bits.join(" / ")}\n` +
        `※ 이 판정은 결정론입니다(파일이 있나 없나) — 다만 본문이 **과거 시점을 서술**하며 그 경로를 적은 것이라면 ` +
        `고칠 것이 없습니다. 그 경우 반려하시면 다시 올라오지 않습니다.`,
      // 조치안을 만들지 않는다 — 본문 수정은 비가역이라 자동 적용 화이트리스트에 없다(applyAction 이 거부).
      //  사람이 문서를 열어 경로를 고치는 것이 유일한 조치다.
    });
  }
  return out;
}

const MANAGER_TYPE_NOTE: Record<string, string> = {
  reference: "사양·불변식 문서",
  "how-to": "런북(따라 하는 절차)",
};

// 프로비저닝 디폴트 콘텐츠 시더 — 신규 게이트웨이가 '코드가 이름으로 전제하는 지식·훅·스킬' 없이 뜨지
//  않게, 기동시(org+v6 스키마 마이그레이션 뒤) idempotent 하게 시딩한다. (#713)
//
//  배경: org 콘텐츠(지식·커스텀훅·하네스자산)는 설치 번들에 안 굽고 게이트웨이 DB 에서 라이브 fetch 로
//   전달된다(2026-06-24 컷오버). 그래서 신규 고객 게이트웨이엔 이 콘텐츠가 0 이라, 코드가
//   knowledge_get('project-closeout-routine')(모든 프로젝트 AGENTS.md) 이나 도메인맵 is-부트스트랩의
//   런북 2개를 가리켜도 댕글링이 됐다. 커스텀훅·스킬도 라이블리 게이트웨이엔 전부 있으나 고객사엔 0 이었다.
//
//  시맨틱(org_tool 시드와 동일 규약 — schema.ts): **신규 설치 기본값만**. 이미 있는 행은 절대 안 건드린다
//   (운영자 토글·편집 보존). 그래서:
//    - 훅·스킬: 존재가드(`if (await get…) continue`) 후 앱 upsert 재사용 → content_hash·감사 정확. upsert 의
//      ON CONFLICT DO UPDATE 가 재기동마다 덮어쓰기·version bump 하지 않도록 **없을 때만** 부른다.
//    - 지식: raw INSERT … ON CONFLICT (name) DO NOTHING. upsertKnowledge 는 신규에 category+type 을
//      강제하는데, 고객사엔 이 런북들의 카테고리(라이블리 도메인)가 없다 → 카테고리 없는(general) 지식으로
//      시딩한다(이름·검색·WIKI 인덱스로 발견되므로 무방).
//  off 는 delete 가 아니라 disable(enabled=false) — 운영자가 지우면 다음 기동에 되살아난다(org_tool 과 동형).
//  멱등: 두 번째 실행부터는 전부 present → 0 삽입. 새 디폴트가 추가되면 그 행만 다음 update(재기동)에 유입된다.
//  비치명: 시딩 실패는 게이트웨이 기동을 막지 않는다(호출부가 .catch — baseline 시드와 동일 best-effort).
import { itemsPool } from "../items/store.js";
import { getOrgHook, upsertOrgHook, getOrgHarnessAsset, upsertOrgHarnessAsset,
  type WriteCtx, type HookHarness, type AssetKind } from "./store.js";
import { DEFAULT_HOOKS, DEFAULT_SKILLS, DEFAULT_KNOWLEDGE } from "./default-content.js";
import { logger } from "../log.js";

export interface SeedResult { hooks: number; skills: number; knowledge: number }

export async function seedDefaultContent(): Promise<SeedResult> {
  const ctx: WriteCtx = { actor: "system", source: "migration" };
  const res: SeedResult = { hooks: 0, skills: 0, knowledge: 0 };

  // ── 커스텀 훅(org_hook) — 없을 때만 삽입(운영자 편집·토글 보존) ──
  for (const h of DEFAULT_HOOKS) {
    try {
      if (await getOrgHook(h.id)) continue;
      await upsertOrgHook({
        id: h.id, label: h.label, harness: h.harness as HookHarness, event: h.event, matcher: h.matcher,
        source_code: h.source_code, timeout_sec: h.timeout_sec, note: h.note, enabled: h.enabled, sort: h.sort,
      }, ctx);
      res.hooks++;
    } catch (err) {
      logger.warn({ err, id: h.id }, "디폴트 훅 시딩 실패(건너뜀) — 나머지는 계속");
    }
  }

  // ── 하네스 자산/스킬(org_harness_asset) — 없을 때만 삽입 ──
  for (const s of DEFAULT_SKILLS) {
    try {
      if (await getOrgHarnessAsset(s.id)) continue;
      await upsertOrgHarnessAsset({
        id: s.id, kind: s.kind as AssetKind, label: s.label, harness: s.harness as HookHarness, description: s.description,
        body: s.body, frontmatter: s.frontmatter, paired_hook_id: s.paired_hook_id, enabled: s.enabled, sort: s.sort,
      }, ctx);
      res.skills++;
    } catch (err) {
      logger.warn({ err, id: s.id }, "디폴트 스킬 시딩 실패(건너뜀) — 나머지는 계속");
    }
  }

  // ── 지식(knowledge) — 신규는 삽입, **손 안 댄 시드는 갱신**(category-less general) ──
  //
  //  ⚠ 시맨틱 변경(#813): 종전엔 `ON CONFLICT (name) DO NOTHING` 이라 **기존 박스는 영원히 옛 본문**이었다.
  //   실제로 문제가 됐다 — 마무리 루틴에 워크스페이스 회수 스텝을 추가했는데, 이미 뜬 고객 게이트웨이는
  //   그 스텝을 **영영 못 받아** 아무도 회수를 안 하고 디스크가 계속 찼다(그 릭을 막으려고 만든 도구인데).
  //   코드가 이름으로 전제하는 런북(#713)은 **코드와 함께 진화**해야 한다 — 코드는 새 도구를 부르는데
  //   런북은 옛 절차를 가리키면 그 자체가 댕글링이다.
  //
  //  그렇다고 무조건 덮어쓰면 원래 취지(운영자 편집 보존)가 깨진다 → **손 안 댄 것만 갱신**한다:
  //   · `updated_by='system'` = 우리가 심은 뒤 아무도 안 건드림 → 갱신 안전.
  //   · 운영자·에이전트가 한 번이라도 편집하면 updated_by 가 그 사람 id 로 바뀐다 → **그 행은 영구 보존**.
  //   · 본문이 실제로 달라질 때만 UPDATE(불필요한 version bump·감사 노이즈 방지).
  //  훅·스킬은 종전 시맨틱("없을 때만") 유지 — content_hash·토글 상태가 얽혀 있어 별도 판단이 필요하다.
  for (const k of DEFAULT_KNOWLEDGE) {
    try {
      const r = await itemsPool.query(
        `INSERT INTO knowledge(name, title, body_md, injection, provenance, lifecycle, is_wiki, type, updated_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,'system')
         ON CONFLICT (name) DO UPDATE
           SET title = EXCLUDED.title,
               body_md = EXCLUDED.body_md,
               is_wiki = EXCLUDED.is_wiki,
               updated_at = now()
         WHERE knowledge.updated_by = 'system'
           AND (knowledge.body_md IS DISTINCT FROM EXCLUDED.body_md
                OR knowledge.title IS DISTINCT FROM EXCLUDED.title)`,
        [k.name, k.title, k.body_md, k.injection, k.provenance, k.lifecycle, k.is_wiki, k.type]);
      if (r.rowCount) res.knowledge++;
    } catch (err) {
      logger.warn({ err, name: k.name }, "디폴트 지식 시딩 실패(건너뜀) — 나머지는 계속");
    }
  }

  if (res.hooks || res.skills || res.knowledge) {
    logger.info(res, "디폴트 콘텐츠 시딩(신규 설치 기본값 — 없던 것만 삽입)");
  }
  return res;
}

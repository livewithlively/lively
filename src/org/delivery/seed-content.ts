// 프로비저닝 디폴트 콘텐츠 시더 — 신규 게이트웨이가 '코드가 이름으로 전제하는 지식·훅·스킬' 없이 뜨지
//  않게, 기동시(org+v6 스키마 마이그레이션 뒤) idempotent 하게 시딩한다. (#713)
//
//  배경: org 콘텐츠(지식·커스텀훅·하네스자산)는 설치 번들에 안 굽고 게이트웨이 DB 에서 라이브 fetch 로
//   전달된다(2026-06-24 컷오버). 그래서 신규 고객 게이트웨이엔 이 콘텐츠가 0 이라, 코드가 이름으로 전제하는
//   자산(모든 프로젝트 AGENTS.md 가 가리키는 project-closeout 스킬(#878), 도메인맵 is-부트스트랩 런북 2개)을
//   가리켜도 댕글링이 됐다. 커스텀훅·스킬도 라이블리 게이트웨이엔 전부 있으나 고객사엔 0 이었다.
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
import { itemsPool } from "../../db/client.js";
import { getOrgHook, upsertOrgHook, assetContentHash,
  type WriteCtx, type HookHarness } from "../store.js";
import { DEFAULT_HOOKS, DEFAULT_SKILLS, DEFAULT_KNOWLEDGE } from "./default-content.js";
import { logger } from "../../log.js";

export interface SeedResult { hooks: number; skills: number; knowledge: number; knowledgeRetired?: number }

// 은퇴한 시드 지식 — 더는 시드가 아닌(예: 스킬로 이동한) 이름. seedDefaultContent 가 손 안 댄 시드행
//  (updated_by='system')만 회수해 orphan/이중출처를 막는다(#878). 이동 시 여기 이름을 넣는다.
const RETIRED_SEED_KNOWLEDGE: string[] = ["project-closeout-routine"]; // → project-closeout 스킬로 이동(#878)

export async function seedDefaultContent(): Promise<SeedResult> {
  const ctx: WriteCtx = { actor: "system", source: "migration" };
  const res: SeedResult = { hooks: 0, skills: 0, knowledge: 0 };

  // ── 커스텀 훅(org_hook) — 신규 삽입 + **손 안 댄 시드는 갱신**(스킬·지식과 대칭, #905) ──
  //  종전엔 "없을 때만 삽입"이라 훅 로직을 고쳐도 **이미 뜬 박스는 영원히 옛 훅**이었다 — 지식이 #813 에,
  //   스킬이 #878 에 겪은 병과 동형이다. 훅에서 이건 단순 기능낙후가 아니라 **안전 문제**다: project-pull 훅에
  //   '쓰기 자격 게이트'를 넣어도(#905 P1-②) 기존 박스엔 안 닿으면, 그 박스는 계속 사용자 폴더를 무음으로 덮는다.
  //  종전 주석은 "run-custom 이 content_hash 로 enforcement 무결성을 게이팅해 별도 판단이 필요"라 미뤘는데,
  //   그 판단의 결론: **upsertOrgHook 이 source_code 로 content_hash 를 재계산**하므로(store.ts) 갱신해도
  //   무결성 게이트는 그대로 성립한다. 미룰 이유가 없었다.
  //  스킬과 같은 보존 규약:
  //   · updated_by='system' = 심은 뒤 아무도 안 건드림 → 갱신 안전. 운영자·에이전트가 한 번 편집하면 영구 보존.
  //   · source_code 가 실제로 다를 때만 UPDATE(불필요한 version bump·감사 노이즈 방지).
  //   · **enabled·target_members 는 보존** — 운영자 토글(마스터킬)·타깃 지정을 재시딩이 되살리지 않는다.
  //  ⚠ 한계(명시): 편집된 훅(updated_by≠'system')은 여기로 안 닿는다. 그런 박스의 안전 픽스는 관리탭 ▸ 커스텀
  //   훅 또는 등록 스크립트(scripts/register-project-pull-hooks.mjs)로 **따로** 반영해야 한다.
  for (const h of DEFAULT_HOOKS) {
    try {
      const before = await getOrgHook(h.id);
      if (!before) {
        await upsertOrgHook({
          id: h.id, label: h.label, harness: h.harness as HookHarness, event: h.event, matcher: h.matcher,
          source_code: h.source_code, timeout_sec: h.timeout_sec, note: h.note, summary: h.summary, enabled: h.enabled, sort: h.sort,
        }, ctx);
        res.hooks++;
        continue;
      }
      // ── #1752 일회성 기본값 승격: session-log-capture 를 기본 켬(대표 결정 2026-08-18). ──
      //  대상은 **손 안 댄 시드**(updated_by='system' — 운영자·에이전트가 한 번이라도 만졌으면 updated_by 가 그 사람)뿐이다.
      //  즉 '아무도 의사를 밝힌 적 없는' 행만 새 기본값을 따라간다 — 운영자가 명시로 끈 박스는 영원히 꺼진 채다.
      //  (아래 source_code 갱신 경로는 enabled 를 보존하는 규약이라 여기로는 기본값 변경이 영영 안 닿는다 — 별도 블록이 필요했다.)
      if (h.id === "session-log-capture" && h.enabled && before.updated_by === "system" && !before.enabled) {
        await upsertOrgHook({
          id: h.id, label: h.label, harness: h.harness as HookHarness, event: h.event, matcher: h.matcher,
          source_code: h.source_code, timeout_sec: h.timeout_sec, note: h.note, summary: h.summary,
          enabled: true, target_members: before.target_members, sort: h.sort,
        }, ctx);
        res.hooks++;
        continue;
      }
      // 기존 행 — 소스가 실제로 달라졌을 때만 갱신.
      //  ⚠ 종전엔 `updated_by='system'`(손 안 댄 시드)까지 요구했다. #1836 에서 시드 훅이 **편집 불가**가 되면서
      //   그 조건은 근거를 잃었다 — 잠금 뒤에는 `updated_by` 가 '조직의 의사'가 아니라 '누가 마지막으로 동기화
      //   버튼을 눌렀나'일 뿐이고, 실제로 그 조건 때문에 우리 dev 는 시드 훅 13개 전부가 갱신 대상에서 빠져
      //   5건이 한 달 낡아 있었다(#1836 실측). 실행 본문은 어차피 effectiveHook 이 코드로 덮으므로, 여기 갱신은
      //   DB 행을 화면·감사와 일치시키는 정리다. 조직의 결정(enabled·target_members)은 아래에서 그대로 보존한다.
      //  #1884 — harness·matcher 도 시드가 정본이다(하네스 개방·툴명 보강이 여기로 내려간다). 종전엔 source_code 만 비교해
      //   `harness: claude → all` 같은 타깃 변경이 **이미 뜬 박스엔 영영 안 닿았다**(코덱스 멤버에게 훅이 안 가는 채로).
      if (before.source_code === h.source_code && before.harness === h.harness && (before.matcher ?? null) === (h.matcher ?? null)) continue;
      await upsertOrgHook({
        id: h.id, label: h.label, harness: h.harness as HookHarness, event: h.event, matcher: h.matcher,
        source_code: h.source_code, timeout_sec: h.timeout_sec, note: h.note, summary: h.summary,
        enabled: before.enabled,                 // 운영자 토글 보존(재시딩이 켜거나 끄지 않는다)
        target_members: before.target_members,   // 타깃 지정 보존
        sort: h.sort,
      }, ctx);
      res.hooks++;
    } catch (err) {
      logger.warn({ err, id: h.id }, "디폴트 훅 시딩 실패(건너뜀) — 나머지는 계속");
    }
  }

  // ── 하네스 자산/스킬(org_harness_asset) — 신규 삽입 + **손 안 댄 시드는 갱신**(지식과 대칭, #878) ──
  //  종전엔 "없을 때만 삽입(존재가드)"이라, 릴리스로 스킬 본문(절차)을 고쳐도 **이미 뜬 고객 박스는 영원히
  //   옛 본문**을 봤다(지식이 #813 전에 겪은 병과 동형 — 코드가 이름으로 전제하는 스킬 project-closeout 은
  //   코드와 함께 진화해야 한다). 그래서 지식과 같은 "손 안 댄 것만 갱신"으로 통일한다:
  //   · updated_by='system' = 심은 뒤 아무도 안 건드림 → 갱신 안전. 운영자·에이전트가 한 번 편집하면 영구 보존.
  //   · content_hash(assetContentHash — 관리메타 label·sort·enabled 제외)가 달라질 때만 UPDATE(불필요 bump 방지).
  //   · **enabled·target_members 는 SET 에서 제외** — 운영자 토글(마스터킬)·타깃 지정을 재시딩이 되살리지
  //     않도록 보존한다(종전 "없을 때만"이 지키던 축 — 지식엔 없는 축이라 여기서만 명시 보존).
  //  훅(org_hook)도 #905 에서 같은 규약으로 합류했다(위) — 이제 지식·스킬·훅 셋이 동일 시맨틱이다.
  for (const s of DEFAULT_SKILLS) {
    try {
      const contentHash = assetContentHash({ kind: s.kind, harness: s.harness, description: s.description, body: s.body, frontmatter: s.frontmatter });
      const r = await itemsPool.query(
        `INSERT INTO org_harness_asset(id, kind, label, harness, description, body, frontmatter, paired_hook_id, enabled, sort, version, content_hash, created_by, updated_at, updated_by)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,1,$11,'system',now(),'system')
         ON CONFLICT (tenant_id, id) DO UPDATE
           SET kind = EXCLUDED.kind, label = EXCLUDED.label, harness = EXCLUDED.harness,
               description = EXCLUDED.description, body = EXCLUDED.body, frontmatter = EXCLUDED.frontmatter,
               paired_hook_id = EXCLUDED.paired_hook_id, sort = EXCLUDED.sort,
               content_hash = EXCLUDED.content_hash, version = org_harness_asset.version + 1, updated_at = now()
         WHERE org_harness_asset.updated_by = 'system'
           AND org_harness_asset.content_hash IS DISTINCT FROM EXCLUDED.content_hash`,
        [s.id, s.kind, s.label, s.harness, s.description, s.body, JSON.stringify(s.frontmatter), s.paired_hook_id, s.enabled, s.sort, contentHash]);
      if (r.rowCount) res.skills++;
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
  //  스킬(위)은 #878, 훅(맨 위)은 #905 에서 같은 "손 안 댄 것만 갱신"으로 합류했다(둘 다 enabled·target_members 보존).
  //   ⇒ 지식·스킬·훅 셋이 동일 시맨틱 — "신규는 삽입 · 손 안 댄 시드는 갱신 · 편집된 것은 영구 보존".
  for (const k of DEFAULT_KNOWLEDGE) {
    try {
      const r = await itemsPool.query(
        `INSERT INTO knowledge(name, title, body_md, injection, provenance, lifecycle, is_wiki, type, updated_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,'system')
         ON CONFLICT (tenant_id, name) DO UPDATE
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

  // ── 은퇴 시드 회수(#878) — 시드에서 빠진 지식(예: 스킬로 이동)의 '손 안 댄' 행을 회수한다. ──
  //  "없을 때만/갱신만" 시맨틱은 시드에서 빠진 이름을 prune 하지 않아, 이미 뜬 박스에 옛 행이 orphan 으로
  //   영구 잔존한다(is_wiki 면 WIKI 인덱스·AGENTS 포인터로 계속 노출 = 새 위치와 이중출처). 그래서 명시적
  //   은퇴 목록의 행을 **운영자가 편집하지 않은 것(updated_by='system')만** 회수한다 — 편집분은 그들 자산이라
  //   보존(수동 정리 몫). FK 가 전부 ON DELETE CASCADE(knowledge_category·project_knowledge·activity_knowledge·
  //   knowledge_link)라 정션도 함께 정리된다.
  for (const name of RETIRED_SEED_KNOWLEDGE) {
    try {
      const r = await itemsPool.query(`DELETE FROM knowledge WHERE name = $1 AND updated_by = 'system'`, [name]);
      if (r.rowCount) res.knowledgeRetired = (res.knowledgeRetired ?? 0) + r.rowCount;
    } catch (err) {
      logger.warn({ err, name }, "은퇴 시드 지식 회수 실패(건너뜀) — 나머지는 계속");
    }
  }

  if (res.hooks || res.skills || res.knowledge || res.knowledgeRetired) {
    logger.info(res, "디폴트 콘텐츠 시딩(신규=삽입 · 손 안 댄 시드=갱신 · 은퇴 시드=회수)");
  }
  return res;
}

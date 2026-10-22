//  #4824 — 이미 만들어진 프리셋 레인(내 컴퓨터 자료 · GitHub · 피그마 댓글)에 **저장된** 기준·형식 문구를 새 문구로 옮긴다.
//
//  왜: 프리셋은 레인을 **새로 만들 때만** 문구를 복사한다(기준·형식은 사람이 손봤을 수 있어 다시 덮지 않는다 — local-preset.ts 의
//   ensure). 그래서 #4824 로 «자료 연결은 knowledge_save 의 derived_from 한 번» 이 되었는데도 기존 레인은 «만든 지식마다
//   source_link_knowledge 를 건다» 를 그대로 가져, 코드 기본 절차(③ derived_from)와 서로 다른 말을 한다(격리 리뷰).
//  ⚠ **글자 그대로 같은 덩어리만** 바꾼다 — 사람이 한 글자라도 고친 줄은 맞지 않아 그대로 남는다(사람이 쓴 기준을 덮지 않는다).
//   기준·형식 두 칸 모두에서 찾는다(어느 칸에 있든 같은 문구다). 멱등 — 바꾼 뒤엔 옛 덩어리가 없어 다음 부팅에 아무것도 안 한다.
//  짝의 to 는 지금 프리셋 문구에 그대로 있어야 하고 from 은 없어야 한다(preset-text-migrate.test.ts 가 잰다).
import type pg from "pg";
import { itemsPool } from "../../db/client.js";
import { logger } from "../../log.js";

export interface PresetTextMigration { from: string; to: string; why: string }

export const PRESET_TEXT_MIGRATIONS: readonly PresetTextMigration[] = [
  { why: "자료 연결 — 두 번 호출(source_link_knowledge) → knowledge_save 의 derived_from 한 번",
    from: "- 자료 링크 없는 지식을 만들지 마라. 만든 지식마다 source_link_knowledge(derived_from) 를 건다.",
    to: "- 자료 링크 없는 지식을 만들지 마라. 지식은 knowledge_save 에 derived_from:[이 지식이 나온 자료 id 전부] 를 실어 저장한다(저장과 자료 연결이 한 번에 된다)." },
  { why: "출처 규칙 — 정본 연결의 이름",
    from: "⚠ 자료 id 를 본문에 나열하지 마라 — 자료↔지식 관계는 source_link_knowledge 링크가 정본이다.",
    to: "⚠ 자료 id 를 본문에 나열하지 마라 — 자료↔지식 관계는 derived_from 연결(knowledge_save 의 derived_from)이 정본이다." },
  { why: "내 컴퓨터 자료 — «개인 폴더(올린 사람만 봄)» 은 #4007 뒤로 사실이 아니다 → 잠긴 자료 규칙",
    from: "## 개인 폴더 자료 (머리글에 \"개인 폴더(올린 사람만 봄)\" 이 붙은 것)\n그 자료는 **올린 사람만 보는 자료**다. 조직 전체가 보는 기존 지식에 **합치지 마라** — 합치는 순간 그 문서가 올린 사람 전용으로 잠겨 다른 사람 화면에서 사라진다(공개범위는 자료↔지식 링크를 따라 좁아지기만 한다).\n- 이미 조직 지식이 그 내용을 담고 있으면 **skip** 하고, 요약에 \"이미 조직 지식에 있음(<지식 이름>)\" 을 남긴다.\n- 조직 지식에 없는 내용이면 **새 지식으로** 만든다(그 지식도 올린 사람만 보게 된다 — 그게 맞다).\n- 개인 자료 여러 건끼리 묶는 것은 괜찮다. 조직 지식과 섞지만 마라.",
    to: "## 잠긴 자료 (머리줄에 \"잠김(볼 수 있는 사람만 봄)\" 이 붙은 것)\n그 자료는 **볼 수 있는 사람이 정해진 자료**다. 더 넓게 보이는 기존 지식에 **합치지 마라** — 서버가 거절한다(409). 합치면 그 문서가 그 사람들 전용으로 좁아져 다른 사람 화면에서 사라지기 때문이다(공개범위는 자료↔지식 연결을 따라 좁아지기만 한다).\n- 이미 조직 지식이 그 내용을 담고 있으면 **skip** 하고, 요약에 \"이미 조직 지식에 있음(<지식 이름>)\" 을 남긴다.\n- 조직 지식에 없는 내용이면 **새 지식으로** 만든다(그 지식도 그 자료를 볼 수 있는 사람만 보게 된다 — 그게 맞다).\n- 잠긴 자료 여러 건끼리 묶는 것은 괜찮다(한 배치의 자료는 볼 수 있는 사람이 같다). 잠기지 않은 지식과 섞지만 마라." },
];

const FIELDS = ["criteria_md", "format_md"] as const;

/** 저장된 레인 문구를 옮긴다. 바꾼 (레인 · 칸) 수를 돌려준다. */
export async function migrateDistillerPresetText(db: Pick<pg.Pool, "query"> = itemsPool): Promise<{ changed: number; keys: string[] }> {
  let changed = 0;
  const keys = new Set<string>();
  for (const m of PRESET_TEXT_MIGRATIONS) {
    for (const f of FIELDS) {
      const r = await db.query(
        `UPDATE org_distiller SET ${f} = replace(${f}, $1, $2), version = version + 1, updated_at = now()
          WHERE strpos(${f}, $1) > 0 RETURNING key`, [m.from, m.to]);
      changed += r.rowCount ?? 0;
      for (const row of r.rows as Array<{ key: string }>) keys.add(String(row.key));
    }
  }
  return { changed, keys: [...keys] };
}

/** 부팅용 — 비치명(실패해도 부팅은 계속 · 다음 부팅에 다시 한다). 표가 없는 배포면 아무것도 안 한다. */
export async function migrateDistillerPresetTextSafe(): Promise<void> {
  try {
    const t = await itemsPool.query(`SELECT to_regclass('public.org_distiller') IS NOT NULL AS ok`);
    if (!t.rows[0]?.ok) return;
    const r = await migrateDistillerPresetText();
    if (r.changed) logger.info(`[distill] 프리셋 레인의 저장된 문구를 새 문구로 옮김(#4824) — ${r.changed}칸 · 레인 ${r.keys.join(", ")}`);
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, "[distill] 프리셋 레인 문구 이관 실패(비치명) — 다음 부팅에 다시 한다");
  }
}

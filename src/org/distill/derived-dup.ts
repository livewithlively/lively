// 한 자료에서 지식이 **여러 개** 파생될 때 알린다(#1631) — 중복 증류가 조용히 쌓이던 것.
//
//  ── 실측 (2026-08-31 dev) ──
//  같은 파일(source #7364 «리셀러 계약 표준안 검토.md»)에서 지식이 **3초 간격으로 2건** 나왔다:
//    reseller-standard-contract-terms  17:28:55  «리셀러 표준계약 검토 결론 — MOQ 는 유지하되 첫 해 50%…»
//    reseller-contract-standard-terms  17:28:58  «리셀러 표준계약 3대 쟁점 결론 — MOQ 유지하되 첫 해 50%…»
//  같은 내용이고 슬러그만 다르다. 배치·스케줄 문제가 **아니다**: `org_distiller_seen` 에 그 자료를 가져간
//  증류기는 `local-files` **하나뿐**이고, 한 배치가 지식을 둘 쓴 것이다.
//
//  ── 왜 서버가 봐야 하나 ──
//  중복 방지는 지금 **전적으로 모델 자율**이다 — 절차서가 «저장 전 knowledge_similar 로 확인하라» 고 말할 뿐,
//  건너뛰면 그대로 통과한다. 실제로 어떤 회차는 스스로 «[중복 — 정본은 …]» 표식까지 붙였고(자율이 동작),
//  이번 회차는 그냥 둘을 썼다(자율이 실패). 규율이 지켜질 때만 지켜지는 것은 규율이 아니다.
//
//  ── 경계 ──
//  ⚠ **막지 않는다.** 한 자료에서 여러 지식이 나오는 것은 정당할 수 있다(회의록 하나에 결정 3건). 막으면
//   그 정당한 경우가 통째로 죽는다. 그래서 링크는 그대로 걸고 **사실을 돌려준다** — 부르는 쪽(증류 세션)이
//   그 자리에서 합칠지 그대로 둘지 정한다. 사람이 보는 화면에도 근거가 남는다.
//  ⚠ 관계는 `derived_from`(증류) 만 센다. `cites`(참조)는 여럿인 것이 정상이다 — 그걸 세면 경고가 늘 켜져
//   아무도 안 보게 된다(늘 울리는 알람은 없는 알람이다).

/** 한 자료에 이미 걸려 있는 파생 지식(이번에 거는 것 제외). */
export interface DerivedPeer { name: string; relation: string }

export interface DupNotice {
  /** 이 자료에서 파생된 지식이 이번 것 말고도 있나 */
  duplicate: boolean;
  /** 이미 있던 파생 지식 이름들(이번 것 제외) */
  siblings: string[];
  /** 부르는 쪽에 그대로 실어 보낼 한 줄. duplicate 가 아니면 null. */
  note: string | null;
}

/**
 * 파생 중복 판정(**순수** — DB 무접촉).
 *
 * @param peers 이 자료에 이미 걸린 지식 링크 전부
 * @param name  이번에 거는 지식 이름
 */
export function checkDerivedDup(peers: readonly DerivedPeer[], name: string): DupNotice {
  const me = String(name ?? "").trim();
  const siblings = [...new Set(
    peers
      .filter((p) => p.relation === "derived_from")
      .map((p) => String(p.name ?? "").trim())
      .filter((n) => n && n !== me),
  )];
  if (!siblings.length) return { duplicate: false, siblings: [], note: null };
  const shown = siblings.slice(0, 3).join(", ");
  const more = siblings.length > 3 ? ` 외 ${siblings.length - 3}건` : "";
  return {
    duplicate: true,
    siblings,
    note: `이 자료에서 파생된 지식이 이미 있습니다: ${shown}${more}. `
      + `같은 내용이면 새로 만들지 말고 그 지식을 갱신하세요(knowledge_save mode='edit'). `
      + `한 자료에서 서로 다른 지식이 나오는 것이 맞다면 그대로 두어도 됩니다.`,
  };
}

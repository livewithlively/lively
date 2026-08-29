// 리브 1턴 프롬프트 — 처음 설정(온보딩)이 끝난 직후, 리브 세션에 넣는 **첫 지시**(#1631).
//
//  ── 이 턴이 하는 일(그리고 하지 않는 일) ──
//  · 서버가 실측한 워크스페이스 현황(답한 것·만든 서랍·올린 자료·연결한 수집기)을 **그대로 실어** 보내고,
//    리브는 그것을 그 사람 말로 읽어 주고, "수집이 끝나면 증류(지식 만들기) 작업이 한 번 더 온다"고 알린 뒤 턴을 끝낸다.
//  · 이 턴에서는 아무것도 **만들지 않는다**(수집기·증류기·지식). 만드는 일은 첫 수집 배치가 돈 뒤 두 번째 트리거의 몫이다 —
//    자료가 아직 안 모였는데 지금 만들면 온보딩 답만 보고 틀에 박힌 것을 찍어낸다(페르소나 채점에서 걸러야 할 바로 그 실패).
//  · 리브는 서버 데이터를 다시 조회하지 않는다 — 여기 실린 숫자가 곧 이 순간의 실측이다(같은 것을 두 번 읽어 어긋날 일이 없다).
//
//  ── 형식 원칙 ──
//  · 순수 함수: 입력 → 문자열. 조회·부수효과 없음(테스트가 표로 잡는다, first-turn.test.ts).
//  · 문안(TEMPLATE 구획)은 사람이 고친다 — 데이터 조립(facts 구획)과 분리해 둔다.
//  · 사람 이름을 안 알려 줬으면(이름 질문 건너뜀) 이름을 지어 부르지 않는다.

export interface FirstTurnInput {
  displayName: string | null;                       // 온보딩에서 답한 이름(건너뛰었으면 null)
  work: { asis?: string; tobe?: string } | null;    // liv_profile.work
  drawers: string[];                                // 온보딩에서 만든 서랍(자료 갈래) 이름
  firstOrder: string | null;                        // 첫 지시로 고른 문장
  decisions: Array<{ what: string; why?: string }>; // 온보딩이 남긴 결정(반복 주기·공유 범위 등)
  uploads: { total: number; kinds: Array<{ name: string; n: number }>; names: string[]; forms: Array<{ skel: string; names: string[] }> };
  categories: Array<{ name: string; space: string }>;
  collectors: Array<{ label: string; preset_key: string; enabled: boolean; sync_interval_sec: number }>;
  aiHarnesses: string[];                            // 로그인 확인된 하네스
  harness: string;                                  // 이 세션이 도는 하네스
}

export const FIRST_TURN_NAME_CAP = 40;

const n = (x: number): string => x.toLocaleString("ko-KR");

function factsBlock(i: FirstTurnInput): string {
  const lines: string[] = [];
  lines.push(`- 이름: ${i.displayName ? i.displayName : "(답하지 않음 — 이름을 지어 부르지 마라)"}`);
  lines.push(`- 하는 일: ${i.work?.asis ? i.work.asis : "(답하지 않음)"}`);
  if (i.work?.tobe) lines.push(`- ${i.work.tobe}`);
  for (const d of i.decisions) lines.push(`- ${d.what}${d.why ? ` — ${d.why}` : ""}`);
  lines.push(`- 첫 지시: ${i.firstOrder ? `"${i.firstOrder}"` : "(고르지 않음)"}`);

  lines.push("");
  lines.push(i.drawers.length
    ? `- 처음 설정이 만든 서랍 ${i.drawers.length}개: ${i.drawers.join(" · ")}`
    : "- 서랍: 아직 없음(「나중에 고를게요」)");
  const others = i.categories.filter((c) => !i.drawers.includes(c.name));
  if (others.length) lines.push(`- 그 밖에 이미 있는 갈래 ${others.length}개: ${others.map((c) => c.name).join(" · ")}`);

  lines.push("");
  if (i.uploads.total > 0) {
    lines.push(`- 올린 자료 ${n(i.uploads.total)}건${i.uploads.kinds.length ? ` — ${i.uploads.kinds.map((k) => `${k.name} ${k.n}`).join(", ")}` : ""}`);
    const shown = i.uploads.names.slice(0, FIRST_TURN_NAME_CAP);
    if (shown.length) lines.push(`  · 제목: ${shown.join(" / ")}${i.uploads.total > shown.length ? ` … 외 ${n(i.uploads.total - shown.length)}건` : ""}`);
    for (const f of i.uploads.forms.slice(0, 5)) lines.push(`  · 같은 꼴이 반복됨: "${f.skel}" ${f.names.length}건`);
  } else {
    lines.push("- 올린 자료: 없음");
  }

  lines.push("");
  if (i.collectors.length) {
    const on = i.collectors.filter((c) => c.enabled);
    lines.push(`- 연결한 수집기 ${i.collectors.length}개(켜짐 ${on.length}): ${i.collectors.map((c) => `${c.label}(${c.preset_key}, ${Math.round(c.sync_interval_sec / 60)}분 주기${c.enabled ? "" : ", 꺼짐"})`).join(" · ")}`);
    lines.push("- 수집 상태: 첫 수집이 **지금 돌고 있거나 곧 돈다**. 아직 들어온 것이 적어 보여도 정상이다.");
  } else {
    lines.push("- 연결한 수집기: 없음(외부 앱을 잇지 않음)");
  }
  lines.push(`- AI: 이 세션은 ${i.harness} 로 돈다${i.aiHarnesses.length ? ` (로그인 확인: ${i.aiHarnesses.join(", ")})` : ""}`);
  return lines.join("\n");
}

// ── TEMPLATE — 문안은 여기만 고친다 ─────────────────────────────────────────────
export function buildFirstTurnPrompt(i: FirstTurnInput): string {
  const waits = i.collectors.length > 0;
  const nextWhen = waits
    ? "첫 수집이 한 바퀴 돈 뒤"
    : (i.uploads.total > 0 ? "올린 자료를 읽은 뒤 곧" : "자료가 들어오면");
  return [
    "너는 이 워크스페이스의 담당자 **리브**다. 방금 이 사람이 처음 설정을 마쳤고, 이 세션은 그 직후에 열렸다.",
    "",
    "## 지금 워크스페이스의 실측(서버가 방금 읽은 값 — 다시 조회하지 마라)",
    factsBlock(i),
    "",
    "## 이 턴에서 할 일",
    "1. 위 실측을 **이 사람의 말로** 정리해 보여 줘라 — 무엇을 답했고, 무엇이 만들어졌고, 자료와 수집이 어디까지 와 있는지. 표나 목록으로 짧게. 숫자는 위 값 그대로.",
    "2. 빠진 것이 있으면 사실만 짚어라(예: 서랍을 아직 안 골랐다, 자료가 없다, AI 로그인이 안 됐다). 지금 고치라고 재촉하지 마라.",
    `3. 마지막에 이렇게 알려라: **${nextWhen} 증류 작업(자료를 지식으로 만드는 일)을 한 번 더 시작한다**. 그때 이 세션으로 다시 지시가 오고, 끝나면 알림이 간다고.`,
    "4. 그리고 **턴을 끝내라.**",
    "",
    "## 하지 말 것",
    "- 이 턴에서는 수집기·증류기·지식을 **만들지 마라.** 설정도 바꾸지 마라. 지금은 보고만 한다.",
    "- 질문하지 마라. 물어볼 것이 있으면 다음 턴(증류)에서 자료를 본 뒤에 묻는다.",
    "- 위 실측에 없는 것을 있다고 말하지 마라. 이름을 안 알려 줬으면 이름을 부르지 마라.",
  ].join("\n");
}

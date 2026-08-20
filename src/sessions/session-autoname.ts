// 이름 없는 세션에 **처음 받은 지시**로 이름을 붙인다 (#1808).
//
// 왜: 세션 이름을 정하는 자리가 아홉 군데인데 사람이 실제로 짓는 건 사실상 '새 AI 세션' 폼 하나였고, 그 폼이
//  프로젝트에서 열릴 때 이름칸을 **프로젝트명으로 프리필**해 두어(#1145) 대다수가 그대로 눌렀다 — dev 실측
//  2026-08-20: **프로젝트 세션 147건 중 104건(71%)이 이름이 프로젝트명 그대로**. 한 프로젝트 아래 세션 예닐곱이
//  전부 같은 이름이면 목록에서 서로 구분할 방법이 없다. 프리필을 없앴으니(web/terminal/session-form.ts) 이름을
//  안 주고 만든 세션은 label 이 box id 다 — 그 자리를 여기서 메운다. 세션이 무엇인지는 **첫 지시**가 말한다.
//
// 언제: 중앙 기록(session_log)이 그 대화의 첫 사용자 발화를 처음 알아낸 순간(session-log-routes 의 append 직후).
//  title 은 이미 firstUserPromptTitle 이 뽑아 둔 값이라 여기서 다시 파싱하지 않는다.
//
// ⚠ DB·tmux 를 직접 안 부른다 — 전부 deps 로 받는다(판정을 표로 고정하려고, session-autoname.test.ts).
import { sessionNameFromPrompt, isUnnamedSession } from "../terminal/session-name.js";

export interface AutoNameTarget { id: string; label: string | null; owner: string | null; node_id?: string | null }
export interface AutoNameDeps {
  /** 대화 uuid → 그 대화를 돌린 박스(desired-state). 없으면 undefined/null. */
  lookup: (convUuid: string) => Promise<AutoNameTarget | null | undefined>;
  /** 게이트웨이 로컬 tmux 박스 이름 바꾸기. 죽은 세션이면 throw 해도 된다(삼킨다). */
  renameLocal: (owner: string, id: string, label: string) => Promise<void>;
  /** 노드 박스 이름 바꾸기(relay). 노드가 꺼져 있으면 throw 해도 된다(삼킨다). */
  renameNode: (nodeId: string, owner: string, id: string, label: string) => Promise<void>;
  /** desired-state 의 이름 갱신 — 복원 목록·복원본이 이 이름으로 뜬다. */
  saveLabel: (id: string, label: string) => Promise<void>;
  warn?: (msg: string, err: unknown) => void;
}

/**
 * @returns 붙인 이름, 아니면 null(대상 없음 · 이미 이름 있음 · 이름 지을 거리 없음 · 실패).
 */
export async function autoNameUnnamedSession(convUuid: string, title: string, deps: AutoNameDeps): Promise<string | null> {
  const name = sessionNameFromPrompt(title);
  if (!name) return null;
  try {
    const st = await deps.lookup(convUuid);
    if (!st || !st.owner) return null;
    if (!isUnnamedSession(st.label || "", st.id)) return null;   // 사람이 지었거나 이미 붙었다 — 절대 안 덮는다(멱등도 여기서 나온다)
    // ① 살아 있는 박스의 tmux 이름. 죽었거나(복원 대기) 노드가 꺼져 있으면 실패하는데 그건 정상이라 삼키고 ②로 간다.
    try {
      if (st.node_id) await deps.renameNode(st.node_id, st.owner, st.id, name);
      else await deps.renameLocal(st.owner, st.id, name);
    } catch (e) { deps.warn?.(`세션 자동 이름 — tmux 반영 실패(${st.id}, 비치명)`, e); }
    // ② desired-state 는 **항상** 맞춘다 — 이게 없으면 죽은 세션은 영영 id 가 이름이다.
    await deps.saveLabel(st.id, name);
    return name;
  } catch (e) {
    deps.warn?.(`세션 자동 이름 실패(${convUuid})`, e);
    return null;
  }
}

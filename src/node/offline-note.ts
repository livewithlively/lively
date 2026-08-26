// "그 노드가 왜 안 붙어 있나" 한 문장 (#1849 ②) — 판정(sleep-pattern)·문구(link-advice)·이력(store)을 잇는 얇은 조합.
//
// 이 자리가 따로 있는 이유: 오프라인을 알리는 곳이 여럿인데(세션 복원 409, 세션 생성, 노드 목록), 각자
//  이력을 읽고 판정을 돌리면 코드가 갈린다. **한 함수로 묶어** 어디서 부르든 같은 문장이 나오게 한다.
//  실패는 전부 삼킨다 — 진단은 부가 정보지, 그것 때문에 원래 오류·응답이 막히면 안 된다.
import { getNode, loadRecentLinkEvents } from "./store.js";
import { diagnoseLink } from "./sleep-pattern.js";
import { linkDiagMessage } from "./link-advice.js";

/** 잠자기 등으로 추정되면 설명+조치 한 문장, 아니면 null(모르면 말하지 않는다). */
export async function nodeOfflineNote(nodeId: string, now: number = Date.now()): Promise<string | null> {
  try {
    const [node, events] = await Promise.all([getNode(nodeId), loadRecentLinkEvents(now)]);
    if (!node) return null;
    const diag = diagnoseLink(events.get(nodeId) ?? [], now);
    return linkDiagMessage(diag, { platform: node.platform, keepAwake: node.keep_awake });
  } catch { return null; }
}

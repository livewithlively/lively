// 게이트웨이 자신이 노드로도 등록됐나 — **순수 판정** (#2108).
//
// `lively node --daemon` 은 self-register 라, 게이트웨이가 도는 그 박스에서 실행하면 평범한 member 노드로
//  목록에 들어온다. 같은 박스면 **같은 tmux 서버**를 보므로 한 세션이 두 경로로 접근된다 — 박스 경로는
//  tmux 에 직접 물어 즉시 확답을 받고, 노드 경로는 3초 스냅샷을 거친다. 그 차이가 "중앙 컴퓨터로 고르면
//  열리는데 노드로 고르면 새 세션이 복원으로 샌다"를 만든다(#2108). 위탁 스케줄러에도 해롭다 — 같은 박스가
//  CENTRAL 과 원격 노드로 두 번 후보에 올라 용량이 이중계산된다.
//
// 판정 근거를 **호스트명이 아니라 tmux 겹침**으로 둔 이유: 호스트명은 대용물이라 같은 이름의 다른 PC 를
//  자기 자신으로 오인할 수 있는데, 그러면 멤버의 개인 PC 가 세션 생성 목록에서 조용히 사라진다. 겹침은
//  해로운 성질(같은 tmux) 그 자체라 오탐이 없고, 노드 에이전트 변경 없이 구 번들에도 그대로 듣는다.

/**
 * 이 노드가 게이트웨이와 **같은 tmux 서버**를 쓰나 = 같은 박스인가.
 *
 * ⚠ **양성일 때만 참**이다. 겹침이 없다고 '아니다'로 뒤집으면 안 된다 — 세션이 하나도 없는 순간엔 볼 것이
 *  없을 뿐이고(없음 ≠ 아니다), 그 오답은 곧 "자기 자신인데 아니라고 판정"이라 이 장치를 통째로 무력화한다.
 *
 * @param gatewaySessionIds 이 게이트웨이 tmux 가 **답해서** 준 세션 id(strict 조회 — '못 봤다'를 빈 목록으로 접지 말 것)
 * @param nodeSessionIds 그 노드가 스냅샷으로 보고한 세션 id
 */
/**
 * 지금 판정을 **시도할 값이 있나** — 아직 판정 안 된 노드 중 세션을 하나라도 든 것이 있나(#2172).
 *
 * 호출부(registry.probeSelfNodes)가 tmux 를 묻기 **전에** 이걸 본다. 두 가지를 동시에 막는다:
 *  ⓐ 볼 것이 없는데 tmux 를 묻는 낭비(판정 대상이 없으면 답을 받아도 쓸 데가 없다).
 *  ⓑ **그 헛시도가 백오프를 먹는 것** — 이게 #2172 에서 잰 30초짜리 노출 창의 원인이다. 부팅 순서상
 *    노드 WS(LISTEN_STEPS)가 DB 스냅샷 복구(DB_BOOT_STEPS)보다 먼저 열려, 노드의 첫 push 가 **아직 빈
 *    states** 로 판정을 시도한다. 종전 구현은 그것도 '시도'로 세어 30초 스로틀을 걸었고, 그 사이 게이트웨이
 *    자신이 세션 생성 목록에 남았다.
 *
 * 세션이 0 인 노드를 후보에서 빼는 근거는 sharesGatewayTmux 와 같다 — 볼 것이 없으면 판정이 아니라 보류다.
 */
export function hasSelfProbeCandidate(
  candidates: Iterable<{ key: string; sessionCount: number }>, judged: ReadonlySet<string>,
): boolean {
  for (const c of candidates) if (!judged.has(c.key) && c.sessionCount > 0) return true;
  return false;
}

export function sharesGatewayTmux(
  gatewaySessionIds: ReadonlySet<string>, nodeSessionIds: readonly string[],
): boolean {
  if (!gatewaySessionIds.size || !nodeSessionIds.length) return false;   // 볼 것이 없다 = 판정 불가(≠ 아니다)
  return nodeSessionIds.some((id) => gatewaySessionIds.has(id));
}

/**
 * 이 노드가 **선언된 세션 호스트**인가 — #2592 겹침 판정에서 면제할 **유일한** 근거 (#2600 T2).
 *
 * 세션 호스트는 게이트웨이와 같은 tmux 를 본다. 그건 사고가 아니라 설계다(그 테넌트의 세션을 맡으라고
 *  띄운 프로세스이고, 같은 브로커 소켓으로 그 tmux 에 닿는다). 사고로 생긴 셀프 노드와는 **관측만으로
 *  구별되지 않는다** — 겹침이 양쪽에서 똑같이 참이다. 그래서 **선언**으로 가른다.
 *
 * ⚠ «없으면 면제» 로 뒤집지 마라. 값이 없거나 모르는 노드(구 행·조회 실패)는 면제하지 **않는다** —
 *  그래야 방어가 조용히 꺼지지 않는다(fail-closed). 선언은 관리자만 할 수 있다(node/routes.ts).
 */
export function declaredSessionHost(n: { session_host?: boolean } | null | undefined): boolean {
  return n?.session_host === true;
}

/**
 * 이 노드를 셀프 노드로 **새로 표시할 것인가** — 판정 한 칸의 결정 (#2600 T2).
 *
 * ⚠ 이름이 «이 노드가 셀프 노드인가» 가 **아니다**. 이미 확정된 노드에는 `false` 를 돌려준다(다시 표시할
 *  이유가 없어서다). 술어로 오해해 «통과시켜도 되나» 를 여기에 물으면 **확정된 셀프 노드를 통과시킨다** —
 *  그 질문의 답은 `registry.isSelfNode` 다.
 *
 * 종전엔 세 조건이 `registry.probeSelfNodes` 의 루프 안에 흩어져 있어 «면제가 실제로 도나» 를 시험할 수
 *  없었다(실측: 면제를 통째로 지워도 관련 시험 29개가 전부 초록이었다). 결정을 밖으로 내면 그 자리가 생긴다.
 *  판정 재료(`sharesGatewayTmux`)는 그대로 쓰고, 순서와 면제만 여기서 고정한다.
 *
 * ⚠ `declaredSessionHost` 를 **불리언으로 받는다** — 호출부가 «어디서 읽었나» 를 고르게 하려는 것이다.
 *  그 값은 반드시 **상태 스냅샷**에서 와야 한다(연결이 아니라): 부팅 직후 판정은 연결이 하나도 없는 채로
 *  돌고, 그때 연결에서 읽으면 선언이 안 보여 선언된 세션 호스트가 **sticky 하게** 셀프 노드로 확정된다.
 */
export function shouldMarkSelfNode(o: {
  alreadyJudged: boolean;
  declaredSessionHost: boolean;
  gatewaySessionIds: ReadonlySet<string>;
  nodeSessionIds: readonly string[];
}): boolean {
  if (o.alreadyJudged) return false;              // 판정은 sticky — 두 번 하지 않는다
  if (o.declaredSessionHost) return false;        // 선언된 세션 호스트는 겹쳐도 자기 자신이 아니다
  return sharesGatewayTmux(o.gatewaySessionIds, o.nodeSessionIds);
}

// ── #2592 — 그 판정을 **집행**하는 자리들이 쓰는 순수 술어 ────────────────────────
//
// #2108 은 이 판정으로 «그 노드로 새로 만들기»만 막았다. 그런데 셀프 노드가 새는 구멍은 넷이었다
//  (2026-09-03 dev 실측): 접속(`?node=` 릴레이) · 목록 좌표 · DB 발견 기록 · 자기등록.
//  판정 술어는 **손대지 않는다**(오탐 0 이 그 술어의 값어치다) — 아래 얇은 함수들이 그 넷을 같은 술어에 문다.

/**
 * 화면·DB 가 준 노드 좌표를 **릴레이 지시로 쓸 값**으로 정규화한다 — 셀프 노드면 좌표를 버린다.
 *
 * `node` 는 배지가 아니라 **좌표**다(session-merge.ts 머리말): 화면은 그 값으로 `?node=`/`&node=` 를 붙여
 *  입장·메타조회·프롬프트·종료를 그 노드로 릴레이한다. 그런데 셀프 노드의 좌표가 뜻하는 것은 «저 컴퓨터로 가라»가
 *  아니라 **같은 tmux 로 한 바퀴 돌아오라**다. 그 한 바퀴가 3초 스냅샷 지연·부팅 직후 4462(node-offline) 거부·
 *  노드 데몬의 `tmux -CC attach` 릴레이를 만든다 — 중앙 경로가 tmux 에 직접 물어 즉답을 받는 자리에서.
 *  빈 문자열로 접으면 호출부는 종전의 중앙 경로를 그대로 탄다. **같은 tmux 라 결과가 같고**, 더 빠르다.
 *
 * @param raw 화면이 준 `?node=` 또는 DB `node_id`(빈 값·공백 허용)
 * @param isSelf 셀프 노드 판정(registry.isSelfNode — 확답 관측일 때만 true)
 */
export function relayNodeId(raw: string | null | undefined, isSelf: (id: string) => boolean): string {
  const id = String(raw ?? "").trim();
  if (!id) return "";
  return isSelf(id) ? "" : id;
}

/**
 * 이 세션의 좌표를 **되찾는다** — «누가 이 세션의 생사에 답할 자격이 있나»(#2636).
 *
 * `relayNodeId` 는 **화면이 준 값 하나**를 정규화한다. 그런데 좌표를 아는 것은 화면만이 아니다:
 *  desired-state(`org_session_state.node_id`)와 노드 레지스트리 스냅샷도 안다. 종전 세션 DELETE 라우트는
 *  `?node=` 만 봤고, 그래서 **좌표를 안 싣는 호출**(대시보드 '내 AI 세션' 위젯)이 오면 노드 세션의 생사를
 *  게이트웨이 **로컬 tmux** 로 판정했다. 그 tmux 는 그 세션을 본 적이 없으니 언제나 「없다」고 답한다
 *  (#2636 T0 실측: 실제 노드 세션 id 6개 전부 `can't find session`) — 라우트는 노드에 묻지도 않고
 *  desired-state 행만 지운 뒤 «종료했어요» 라고 답했다. 세션은 그 컴퓨터에 그대로 남는다(누수).
 *  그리고 행이 사라진 다음 호출은 `ownerMeta` 가 null 이 되어 **403 「본인 세션이 아닙니다」**가 된다.
 *
 * 좌표를 되찾으면 그 세션은 **이미 옳은 분기**(노드 릴레이 — `gone` op 3값 계약 · kill 릴레이 · 실패 시
 *  재확인)로 흘러간다. 중앙 경로에 판정을 새로 심지 않는 이유다 — 같은 규율이 두 벌로 갈리면 한쪽이
 *  반드시 뒤처지고, 그게 #2622 가 회수기만 고치고 이 라우트를 남긴 그 모양이다.
 *
 * 순서는 **확실한 것부터**: 화면이 준 좌표 → desired-state → 레지스트리 스냅샷.
 *  ⚠ 셋 다 `relayNodeId` 를 거친다 — 셀프 노드 좌표는 **어느 출처에서 와도** 접어야 한다(#2592: 마이그레이션
 *   전 행이나 다른 게이트웨이가 쓴 행에는 셀프 노드 id 가 그대로 실려 온다).
 *  ⚠ 빈 문자열은 «중앙 세션이다»가 아니라 **«좌표를 못 찾았다»**이다. 호출부가 그 구분을 진다.
 */
export function sessionRelayNodeId(
  sources: { query?: string | null; desired?: string | null; snapshot?: string | null },
  isSelf: (id: string) => boolean,
): string {
  return relayNodeId(sources.query, isSelf)
    || relayNodeId(sources.desired, isSelf)
    || relayNodeId(sources.snapshot, isSelf);
}

/**
 * 사람에게 할 말 — «이 노드는 게이트웨이 자신이다» 하나의 사실을 여러 표면(등록 409·close 사유·관리 배지·CLI)이
 *  각자 다른 문장으로 말하면, 같은 상황을 겪은 두 사람이 서로 다른 원인을 짚는다. 문구를 여기 한 곳에 둔다.
 */
export const SELF_NODE_REASON = "self-node";
export function selfNodeMessage(nodeId?: string): string {
  const who = nodeId ? `노드 '${nodeId}' 는` : "이 노드는";
  return `${who} 게이트웨이가 도는 바로 그 컴퓨터입니다(같은 tmux 를 씁니다).`
    + " 이 컴퓨터의 세션은 노드를 거치지 않고 '중앙 컴퓨터(기본)'로 열립니다 — 노드로 한 번 더 돌면 같은 세션이"
    + " 두 경로로 잡혀 접속이 노드 릴레이로 새고 목록에 거짓 좌표가 붙습니다."
    + " 그 컴퓨터에서 `lively node stop` 을 실행하면 노드 연결이 내려갑니다.";
}

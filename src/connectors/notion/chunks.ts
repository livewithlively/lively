// 노드를 묶음으로 처리하고, 한 묶음이 끝날 때마다 그 묶음을 방출한다(#5012).
//
//  ★ 왜: 노션 백필은 BFS 를 끝까지 돈 **뒤에야** 모든 페이지를 방출했다. 받은 페이지가 전부 메모리에만 있다가
//   마지막에 한꺼번에 미러로 가므로, 그 전에 수집이 끊기면(게이트웨이 재시작·정체 감지·OOM) **받은 것이 0건**
//   남고 다음 실행은 처음부터 다시 긁었다 — 위시스트 실측: 3,861페이지 중 1,080을 받은 첫 실행이 업데이트
//   재시작에 끊겨 저장 0건(2026-10-26).
//   묶음마다 방출하면 run-sync 가 200건마다 미러에 적재하므로, 끊겨도 그때까지 받은 페이지는 남는다. 다음 실행은
//   그 페이지들을 원장(미러)에서 보고 가속 full 의 «미변경 = 1요청 관측» 으로 지나간다.
export async function* processInChunks<N, I>(
  nodes: readonly N[],
  size: number,
  work: (chunk: N[]) => Promise<void>,
  emit: (chunk: N[]) => AsyncIterable<I>,
): AsyncGenerator<I> {
  const step = Math.max(1, Math.floor(size));
  for (let i = 0; i < nodes.length; i += step) {
    const chunk = nodes.slice(i, i + step);
    await work(chunk);
    yield* emit(chunk);
  }
}

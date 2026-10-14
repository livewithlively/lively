// stream.jsonl 을 조각(tail chunk)으로 이어 받을 때 줄 단위로 끊어 주는 순수 함수 — DOM·전역 의존 없음
//  (scripts/jsonl-lines.test.mjs 가 빌드 산출물을 그대로 import 한다. 전역을 잡으면 그 import 가 터진다).
//
// 왜: tail 은 바이트 상한(256KB)이나 쓰기 도중 시점으로 잘라 주므로 조각 끝이 줄 중간일 수 있다. 소비자가 조각을
//  split('\n') 해 파싱 실패 줄을 버리고 next 로 전진하면 그 줄의 뒷부분은 다시 오지 않아 **이벤트가 조용히 사라진다**.
//  개행 없이 끝난 마지막 조각은 carry 로 들고 있다가 다음 조각 앞에 붙인다(CLI cmd-delegate·session-chat 과 같은 방식).

/** carry(직전 조각의 미완 줄) + chunk 를 완결된 줄과 새 carry 로 나눈다. 빈 줄은 거른다. */
export function splitJsonlChunk(carry: string, chunk: string): { lines: string[]; carry: string } {
  const parts = (carry + chunk).split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.filter((l) => l.trim() !== ''), carry: rest };
}

/** 더 올 바이트가 없을 때(작업 종료) 남은 carry 를 마지막 줄로 내보낸다. */
export function flushJsonlCarry(carry: string): string[] {
  return carry.trim() ? [carry] : [];
}

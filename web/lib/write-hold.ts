// 방금 내가 쓴 것은 **그 쓰기가 끝난 뒤에 출발한 읽기**만 고쳐 쓴다(#3870).
//
//  원준 2026-10-04 신고: "기록만 남은 세션 … 이 상태인 세션을 홈의 사이드바에서 삭제할 때 한 번에 삭제가 안 되고
//   버버벅 거리면서 깜빡 거리면서 좀 기다려야 삭제될 때가 있음."
//  매니지드 실측(쓰기 차단 헤드리스, 줄의 있고 없음을 프레임마다 적음):
//   · 줄 넷을 0.6초 간격으로 × — 사라진 줄이 다시 섰다가 없어지기를 2번(화면 전이 8번, 깔끔하면 4번).
//   · 8초 폴링이 출발한 직후에 × — 없음 → 0.85초 뒤 있음 → 0.2초 뒤 없음.
//   · 우클릭 「휴지통으로 보내기」 — 서버 왕복 + 목록 다시 받기(0.6~1.2초) 동안 줄이 그대로 서 있다.
//  기록만 남은 세션만의 일이 아니다(중단된 세션 줄도 같다) — 끝난 세션을 연달아 치울 때 가장 잘 보일 뿐이다.
//
//  까닭은 둘이다.
//   ① 셸의 목록 읽기(v2/main.ts loadData — 8초 폴링 · 클릭 · 스트림)는 겹쳐 뜨고, 답은 **도착한 순서**로 화면에 적혔다.
//      × 를 누르는 순간 이미 떠 있던 읽기의 답에는 방금 치운 줄이 그대로 들어 있어, 낙관 반영을 덮어 줄을 되세운다.
//      먼저 출발한 읽기가 나중에 도착하면 더 새로운 답까지 덮는다(그 줄은 다음 폴링까지 최대 8초 서 있다).
//   ② 휴지통 보내기는 낙관 반영이 없었다 — 서버 답과 목록 한 판을 다 기다린 뒤에야 줄이 빠졌다.
//  이름 고치기(renamePins) · 보관(archivePins)은 같은 문제를 «30초 고정» 으로 막았다. 시간으로 막으면 그 안에 다른
//   기기에서 바뀐 사실을 못 보고, 느린 망에서는 30초도 모자란다. 여기서는 순서로 막는다.
//
//  규칙(시계는 벽시계가 아니라 이 자리의 번호 — 같은 밀리초에 일어난 일도 앞뒤가 갈린다):
//   · 읽기는 출발할 때 번호를 받는다(readStart). 한 축(인스턴스 · 라이브 · 기록)에는 **더 늦게 출발한 읽기의 답**이 이미
//     적혀 있으면 적지 않는다(take 가 false).
//   · 쓰기는 누르는 순간 붙든다(hold) — 서버 답과 무관하게 화면에 덧씌운다. 서버가 받았다고 답하면(ack) 그때의 번호를 적는다.
//   · 붙든 것은 **ack 뒤에 출발한 읽기**가 그 쓰기에 걸린 축을 다 적었을 때 놓는다 — 그 답에는 쓰기가 들어 있다.
//     ack 전에 출발한 읽기는 몇 판이 오든 놓지 못한다(옛 사실이다).
//   · 실패하면(fail) 곧바로 놓는다 — 부르는 쪽이 화면을 되돌리고 사람에게 말한다.

export interface WriteHold {
  /** 서버가 받았다 — 이 뒤에 출발한 읽기가 붙든 것을 놓는다. 두 번 불러도 처음 것만 센다. */
  ack(): void;
  /** 서버가 거절했거나 닿지 못했다 — 곧바로 놓는다. */
  fail(): void;
}

export interface WriteHolds<T> {
  /** 읽기 한 판이 출발한다 — 그 판의 번호. 답을 적을 때 take 에 그대로 넘긴다. */
  readStart(): number;
  /**
   * 번호 seq 로 출발한 읽기의 답을 axis 에 적어도 되나.
   *  더 늦게 출발한 읽기가 이미 적었으면 false(옛 답 — 버린다). true 면 적은 것으로 치고, 이 읽기보다 먼저 ack 된
   *  쓰기에서 이 축을 놓는다. 같은 판을 두 번 물어도 답은 같다(인스턴스 축은 한 판에 두 번 적힌다).
   */
  take(axis: string, seq: number): boolean;
  /** 쓰기를 붙든다 — axes 는 이 쓰기가 비치는 읽기 축(전부 새 답으로 적혀야 놓는다). */
  hold(value: T, axes: string[]): WriteHold;
  /** 지금 붙들고 있는 쓰기들(붙든 순서) — 읽기 답 위에 덧씌울 재료. */
  values(): T[];
}

export function createWriteHolds<T>(): WriteHolds<T> {
  let clock = 0;
  const wrote = new Map<string, number>();   // 축 → 마지막으로 적힌 읽기의 번호
  interface Held { value: T; ackSeq: number; wait: Set<string> }
  const held: Held[] = [];
  const drop = (h: Held): void => { const i = held.indexOf(h); if (i >= 0) held.splice(i, 1); };
  return {
    readStart: () => ++clock,
    take(axis, seq) {
      if (seq < (wrote.get(axis) || 0)) return false;
      wrote.set(axis, seq);
      for (const h of [...held]) {
        if (!h.ackSeq || h.ackSeq > seq) continue;   // 서버 답 전이거나, 이 읽기가 그 답보다 먼저 출발했다
        h.wait.delete(axis);
        if (!h.wait.size) drop(h);
      }
      return true;
    },
    hold(value, axes) {
      const h: Held = { value, ackSeq: 0, wait: new Set(axes) };
      held.push(h);
      return {
        ack() {
          if (h.ackSeq || !held.includes(h)) return;
          h.ackSeq = ++clock;
          if (!h.wait.size) drop(h);   // 걸린 축이 없는 쓰기 — 기다릴 읽기가 없다
        },
        fail() { drop(h); },
      };
    },
    values: () => held.map((h) => h.value),
  };
}

// 이름 입력칸이 열려 있는 동안 **그 칸을 품은 자리를 다시 그리지 않는다** — 건너뛴 그리기는 편집이 끝난 뒤 한 번 갚는다(#3870).
//
//  원준 2026-09-30 신고: "더블클릭해서 사이드바에서 프로젝트 이름 수정하려고 함 -> 몇 초 있다가 다시 이전으로 돌아와서
//   몇 초 안에 타이핑 쳐야 함. 터미널 세션 위에 있는 프로젝트 이름 수정도 마찬가지."
//  매니지드 실측(쓰기 차단 헤드리스, 칸을 뜯어낸 호출의 스택):
//   · 세션 위 문패 — 8초 라이브 틱(v2/panes.ts)이 paintDoor 로 문패를 통째로 다시 그렸다(연 지 1.8~2.3초에 칸이 사라짐).
//   · 사이드바 — «마지막으로 시킨 말» 이 도착하면(last-ask → repaintList → paintList) 목록을 통째로 갈아 끼웠다.
//     render() 에는 같은 가드가 있었는데(#2579) 목록만 다시 그리는 붓에는 없었다.
//   ⚠ 사라지기만 하는 게 아니다: 크롬은 **뜯겨 나간 칸에 blur 를 쏘고**, 두 편집기 모두 blur 를 «저장» 으로 받는다.
//    그래서 치던 글자가 Enter 없이 그 순간의 모양 그대로 저장 요청으로 나갔다(실측: 틱 직후 POST /api/ui/v6/projects/<id>).
//
//  규칙:
//   · 칸이 **화면에 붙어 있는 동안만** 고치는 중이다 — 불리언이 아니라 노드로 묻는다. 칸이 어떤 이유로든 뜯겨 나가면
//     판정이 스스로 풀린다(#2579: 불리언이 true 로 굳어 그 페이지가 끝날 때까지 rename 이 한 번도 안 열렸다).
//   · 건너뛴 그리기는 빚으로 적고, 편집이 끝나면 **한 번** 갚는다 — 안 갚으면 편집하는 동안 온 새 소식이 다음 폴링까지 안 선다.
//   · 갚는 때는 **누르던 손을 뗀 뒤**다. 다른 줄을 눌러 편집을 끝내면 blur 는 누름(pointerdown)에서 나는데, 떼기 전에
//     목록을 갈아 끼우면 누른 줄이 사라져 그 클릭이 아무 데도 안 간다.
//   · 전부 다시 그린 쪽은 paid() 로 빚을 지운다(저장 경로는 셸이 새 이름으로 다시 그린다 — 같은 걸 두 번 그리지 않게).
//  우리 모듈 import 0 — 사이드바(v2/side.ts)와 문패(v2/panes.ts)가 같은 것을 쓴다.

/** 칸 — 화면에 붙어 있나만 본다. */
export interface HoldNode { readonly isConnected: boolean }

/** 누름을 끝내는 소식 — 뗌 · 취소 · 우클릭 메뉴(메뉴가 뜨면 pointerup 이 안 올 수 있다 — 누른 채로 굳지 않게). */
export type PressEvent = 'pointerdown' | 'pointerup' | 'pointercancel' | 'contextmenu';

/** 누름 신호와 «다음 차례» — 브라우저 밖(시험)에서는 가짜를 넣는다. */
export interface HoldEnv {
  /** 문서 전체의 누름·뗌 소식을 받는다(capture). */
  listen(type: PressEvent, fn: () => void): void;
  /** 지금 도는 사건이 끝난 다음 차례에 부른다(뗌 뒤의 click 까지 지나간 뒤). */
  later(fn: () => void): void;
}

export interface EditHold {
  /** 편집 시작 — 이 칸이 화면에 붙어 있는 동안 그 자리는 다시 그리지 않는다. */
  begin(input: HoldNode): void;
  /** 고치는 중인가 — 칸이 화면에 붙어 있을 때만 참. */
  alive(): boolean;
  /** 다시 그리기 직전에 부른다. 고치는 중이면 true(그리지 마라)를 주고 빚을 적는다. */
  skip(): boolean;
  /** 그 자리를 **전부** 다시 그렸다 — 빚이 없다. */
  paid(): void;
  /** 편집 끝 — 그 칸을 놓는다. pay 가 있고 빚이 있으면, 누르던 손을 뗀 뒤 한 번 부른다(그때 새 편집이 열려 있으면 그 편집에 넘긴다).
   *  ⚠ 칸을 이름으로 받는다 — 저장을 기다리는 사이 새 편집이 열릴 수 있고, 늦게 끝난 옛 편집이 새 칸을 놓으면 안 된다. */
  end(node: HoldNode, pay?: () => void): void;
}

let pageEnv: HoldEnv | null = null;
function browserEnv(): HoldEnv {
  return pageEnv || (pageEnv = {
    listen: (type, fn) => document.addEventListener(type, fn, true),
    later: (fn) => { window.setTimeout(fn, 0); },
  });
}

//  누름 상태는 **환경(문서)마다 한 벌**이다 — 편집기는 탭마다 새로 서지만(문패) 문서의 누름은 하나라, 편집기마다
//   문서에 귀를 달면 탭을 열 때마다 쌓인다. 처음 편집이 열릴 때 한 번만 단다.
interface Presses { down: boolean; waiting: Set<() => void> }
const presses = new WeakMap<HoldEnv, Presses>();
function pressesOf(env: HoldEnv): Presses {
  let p = presses.get(env);
  if (p) return p;
  const st: Presses = { down: false, waiting: new Set() };
  presses.set(env, st);
  env.listen('pointerdown', () => { st.down = true; });
  const up = (): void => {
    if (!st.down) return;
    st.down = false;
    const fns = [...st.waiting];
    st.waiting.clear();
    for (const fn of fns) env.later(fn);
  };
  env.listen('pointerup', up);
  env.listen('pointercancel', up);
  env.listen('contextmenu', up);
  return st;
}

export function editHold(env?: HoldEnv): EditHold {
  let input: HoldNode | null = null;
  let owed = false;
  let pay: (() => void) | null = null;   // 갚기를 기다리는 붓

  const alive = (): boolean => {
    if (input && input.isConnected) return true;
    input = null;
    return false;
  };
  const settle = (): void => {
    const fn = pay;
    pay = null;
    if (!fn || !owed || alive()) return;   // 새 편집이 열렸으면 빚은 그 편집이 끝날 때 갚는다
    owed = false;
    fn();
  };
  const myPresses = (): Presses => pressesOf(env || browserEnv());

  return {
    begin(node) { myPresses(); input = node; },   // 누름을 지금부터 듣는다 — 편집을 끝내는 누름은 blur 보다 먼저 온다
    alive,
    skip() {
      if (!alive()) return false;
      owed = true;
      return true;
    },
    paid() { owed = false; },
    end(node, fn) {
      if (input === node) input = null;
      if (!fn || !owed) return;
      pay = fn;
      const p = myPresses();
      if (p.down) p.waiting.add(settle);
      else (env || browserEnv()).later(settle);
    },
  };
}

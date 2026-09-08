// tmux 호출 계수 — «이 프로세스가 어느 테넌트에 어떤 tmux 동사를 몇 번 부르나» (#2600 T2 d4).
//
// ── 왜 필요한가 ───────────────────────────────────────────────────────────────
// 이 프로젝트의 완료 조건 하나가 **«게이트웨이가 그 테넌트에 tmux 를 부른 횟수 0»** 인데, 오늘 그걸 **잴 수단이
//  없다.** 그림자 대조(`tmux-shadow.ts`)는 **불일치와 첫 건에만 동사를 싣고** 일치한 호출은 개별 로그가 없다 —
//  그래서 그 로그로 «무슨 동사가 남았나» 를 세면 **불일치만 세게 된다**(2026-09-08 실측: 그렇게 세고 «list-sessions
//  0건» 이라 결론했는데, 같은 창의 요약은 compared 100 이었다. 31% 줄었을 뿐인데 «닫혔다» 고 읽었다).
//  게다가 그림자는 표본(25%)·동시상한에 묶여 있어 **전량이 아니다**. 완료 조건을 재려면 표본이 아니라 **전수**가,
//  그리고 route 모드(off/shadow/on)와 **무관하게** 도는 계수가 필요하다.
//
// ── 무엇을 세나 ───────────────────────────────────────────────────────────────
// `(슬러그, 동사)` 두 칸만. **argv 는 안 싣는다** — 세션 라벨·send-keys 본문이 argv 에 있고, 그건 로그에 갈 것이
//  아니다(d2 §6-4 와 같은 규율). 동사는 `tmuxSessionOf` 가 뽑은 것이라 argv 파싱이 두 벌이 되지 않는다.
//
// ── 규율 ──────────────────────────────────────────────────────────────────────
//  · **순수**하고 프로세스 로컬이다. 런타임 import 0 — 시험이 시계·로거 없이 전수를 잰다.
//  · 보고는 **창(window) 단위**다. `everyN` 번째 호출마다 그 창의 표를 내고 **비운다** — 누적을 내면 «지금도
//    부르고 있나» 를 못 읽는다(옛 창의 숫자가 영원히 섞인다). 이 프로젝트가 재려는 것은 «남았나» 이지 «총계» 가 아니다.
//  · `everyN <= 0` 이면 **끈다**(보고 없음) — 계수 자체가 부담이 되는 배포의 탈출구.
//  · 표는 **많은 것부터**, 같으면 이름순 — 로그를 눈으로 견줄 때 순서가 흔들리면 «줄었나» 를 못 본다.
//  ⚠ 이 모듈은 노드 에이전트 번들에도 실린다(세션 호스트에서도 세야 한다 — 거기는 route=on 이라 그림자가 아예 없다).
//   그래서 의존을 늘리지 마라.

/** 창 하나의 한 줄. */
export interface TmuxCallRow { slug: string; verb: string; n: number }

/** 슬러그·동사가 없을 때 쓰는 이름 — 빈 문자열을 키로 쓰면 로그에서 «없음» 과 «빈 값» 이 구별되지 않는다. */
export const CENSUS_NONE = "(없음)";

export interface TmuxCallCensus {
  /**
   * 호출 하나를 센다. 그 호출이 창의 마지막이면 **그 창의 표**를 돌려주고 계수를 비운다(아니면 null).
   *  ⚠ 돌려준 배열은 호출자 것이다 — 내부 상태를 더 참조하지 않는다.
   */
  record(slug: string | null | undefined, verb: string | null | undefined): TmuxCallRow[] | null;
  /** 지금까지 쌓인 창의 표(비우지 않는다) — 시험·진단용. */
  peek(): TmuxCallRow[];
}

/** 계수기 하나. `everyN` 번째 호출마다 창을 닫고 표를 낸다. */
export function makeTmuxCallCensus(everyN: number): TmuxCallCensus {
  const counts = new Map<string, number>();
  let inWindow = 0;

  const rows = (): TmuxCallRow[] => {
    const out: TmuxCallRow[] = [];
    for (const [k, n] of counts) {
      const i = k.indexOf("\t");
      out.push({ slug: k.slice(0, i), verb: k.slice(i + 1), n });
    }
    //  많은 것부터, 같으면 슬러그·동사 이름순 — 창끼리 눈으로 견줄 수 있어야 한다.
    out.sort((a, b) => b.n - a.n || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0) || (a.verb < b.verb ? -1 : a.verb > b.verb ? 1 : 0));
    return out;
  };

  return {
    record(slug, verb) {
      const key = `${slug || CENSUS_NONE}\t${verb || CENSUS_NONE}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!(everyN > 0)) return null;              // 꺼져 있다 — 세기는 하되 보고는 안 한다
      if (++inWindow < everyN) return null;
      const out = rows();
      counts.clear();
      inWindow = 0;
      return out;
    },
    peek: rows,
  };
}

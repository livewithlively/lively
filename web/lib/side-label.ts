// lib/side-label.ts: 세션 화면 사이드바의 화면 이름 (#4233, 원준 2026-09-26 «곁칸이라는 용어는 사용자한테 노출하지 말고»).
//
//  오른쪽에 서 있으면 원준이 고른 이름 «우측 사이드바» 를 쓴다. 그런데 자리바꿈(v2/side-swap.ts)은 이 칸이 화면 절반을
//  넘으면 **왼쪽으로 옮긴다**. 그때 «우측» 이라고 적으면 화면과 글이 어긋난다. 그래서 칸 이름을 부르는 글은 전부
//  지금 선 쪽(left)을 받아 여기서 만든다. 셸(panes.ts) · 자리바꿈(side-swap.ts) 은 이 잎만 본다(순수 · DOM 없음).
//  ⚠ 단독 터미널 번들(web/standalone/terminal.ts)은 이 잎을 import 할 수 없어(의존 0 번들) 같은 두 이름을 따로 적는다.
//   둘이 어긋나지 않는지는 scripts/no-gyeotkan-copy.test.mjs 가 본다.

/** 칸 이름. left = 자리바꿈으로 왼쪽에 서 있다. */
export const sideName = (left: boolean): string => (left ? '왼쪽으로 옮긴 사이드바' : '우측 사이드바');

export interface SideLabels {
  /** 경계 손잡이의 aria-label */
  width: string;
  /** 접힌 칸을 다시 펴는 손잡이 */
  reopenTitle: string;
  reopenAria: string;
  /** 칸 머리의 접기 단추 */
  hideTitle: string;
  hideAria: string;
  /** 탭 우클릭 «…로 보내기» 의 받는 칸(조사까지) */
  sendTo: string;
}

export function sideLabels(left: boolean): SideLabels {
  const n = sideName(left);
  return {
    width: n + ' 너비',
    reopenTitle: n + '를 폅니다. 자료·지식이 여기 들어 있어요.',
    reopenAria: n + ' 펴기',
    hideTitle: n + '를 접습니다',
    hideAria: n + ' 접기',
    sendTo: n + '로',
  };
}

export interface SwapCopy {
  /** 문패의 ⇄ 단추 */
  btnTitle: string;
  btnAria: string;
  /** ⇄ 를 누르면 뜨는 창 */
  popHead: string;
  popSub: string;
  popFixedDesc: string;
  /** 켜고 끈 직후의 토스트(바뀐 뒤 상태로 부른다) */
  toast: string;
}

/** 자리바꿈 단추 · 창 · 토스트의 글. on = 자리바꿈 켜짐, left = 지금 칸이 왼쪽에 서 있다. */
export function swapCopy(on: boolean, left: boolean): SwapCopy {
  if (left) {
    //  왼쪽에 서 있는 동안: 칸을 «우측» 이라 부르지 않는다. 어디로 옮겼고 어떻게 돌아가는지를 말한다.
    return {
      btnTitle: on
        ? '사이드바가 화면 절반을 넘어 왼쪽으로 옮겼어요. 절반 아래로 줄이면 오른쪽으로 돌아갑니다. 눌러서 고정할 수 있어요.'
        : '사이드바를 오른쪽에 고정하려면 누르세요.',
      btnAria: on ? sideName(true) + ', 자리바꿈 켜짐' : sideName(true) + ', 자리바꿈 꺼짐',
      popHead: '사이드바가 절반을 넘어 왼쪽으로 옮겼어요',
      popSub: '절반 아래로 줄이면 사이드바가 다시 오른쪽으로 가고 세션이 왼쪽으로 옵니다.',
      popFixedDesc: '사이드바를 오른쪽으로 되돌리고 늘 그 자리에 둡니다.',
      toast: '사이드바가 화면 절반을 넘어 왼쪽으로 옮겼어요. 절반 아래로 줄이면 오른쪽으로 돌아갑니다.',
    };
  }
  return {
    btnTitle: on
      ? '우측 사이드바를 절반보다 크게 키우면 사이드바가 왼쪽으로, 세션이 오른쪽으로 자리를 바꿉니다. 눌러서 고정할 수 있어요.'
      : '우측 사이드바를 오른쪽에 고정해 두었습니다. 눌러서 자리바꿈을 다시 켤 수 있어요.',
    btnAria: on ? '우측 사이드바 자리바꿈 켜짐' : '우측 사이드바 자리 고정됨',
    popHead: '우측 사이드바가 절반을 넘으면',
    popSub: '메인으로 보는 칸이 가운데로 오도록 우측 사이드바와 세션이 자리를 바꿉니다.',
    popFixedDesc: '종전처럼 우측 사이드바가 늘 오른쪽에 있습니다.',
    toast: on
      ? '우측 사이드바가 화면 절반을 넘으면 세션과 자리를 바꿉니다.'
      : '우측 사이드바를 늘 오른쪽에 두도록 고정했어요.',
  };
}

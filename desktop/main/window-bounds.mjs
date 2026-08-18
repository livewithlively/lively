// 창 위치·크기 기억 (#1541) — 핵심은 "저장값을 그대로 믿지 않는다" 하나다.
//
// 왜 순수 모듈인가: 이 판단이 틀리면 증상이 **창이 안 뜬 것처럼 보이는 것**이다. 실제로는 떠 있는데
//  보이지 않는 좌표(뺀 모니터 자리, 바뀐 해상도 바깥)에 있어서, 사용자는 트레이만 누르며 "앱이 고장났다"고
//  본다. Electron 을 띄우는 검증은 CI 에서 못 하므로 판단은 여기 두고 표로 못박는다.

export const DEFAULT_SIZE = { width: 720, height: 560 };
export const MIN_SIZE = { width: 560, height: 420 };
/** 이만큼은 어느 디스플레이 안에 들어와 있어야 '사람이 잡을 수 있다'고 본다(제목 표시줄을 끌 수 있는 최소). */
export const MIN_VISIBLE = { width: 120, height: 40 };

const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);

/** 두 사각형이 겹치는 면적의 가로·세로 — 겹침 판정용. */
function overlap(a, b) {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  };
}

/**
 * 저장된 창 배치를 지금 화면 구성에 맞게 보정한다.
 *
 * @param {object|null} saved     이전에 저장한 {x,y,width,height}
 * @param {Array<{x,y,width,height}>} displays  각 디스플레이의 **작업영역**(작업표시줄 제외)
 * @returns {{width:number,height:number,x?:number,y?:number}}
 *          x·y 가 **없으면** 위치를 포기했다는 뜻 — 그 경우 OS/Electron 이 알아서 가운데 놓는다.
 *          (0,0 으로 지어내지 않는다. 0,0 은 '모른다'가 아니라 '좌상단'이라는 구체적 주장이다.)
 */
export function normalizeBounds(saved, displays) {
  const list = Array.isArray(displays) ? displays.filter((d) => d && num(d.width) && num(d.height)) : [];
  const s = saved && typeof saved === "object" ? saved : {};

  // 크기 — 저장값이 있으면 쓰되 최소치 밑으로는 못 내려간다. 없거나 망가졌으면 기본값.
  let width = num(s.width) ?? DEFAULT_SIZE.width;
  let height = num(s.height) ?? DEFAULT_SIZE.height;
  width = Math.max(MIN_SIZE.width, width);
  height = Math.max(MIN_SIZE.height, height);
  // 화면보다 큰 창은 사람이 줄일 수 없는 자리로 갈 수 있다 — 가장 큰 작업영역에 맞춘다.
  if (list.length) {
    const maxW = Math.max(...list.map((d) => d.width));
    const maxH = Math.max(...list.map((d) => d.height));
    width = Math.min(width, Math.max(MIN_SIZE.width, maxW));
    height = Math.min(height, Math.max(MIN_SIZE.height, maxH));
  }

  const x = num(s.x), y = num(s.y);
  if (x === null || y === null) return { width, height };      // 위치를 저장한 적이 없다 — 가운데로
  if (!list.length) return { width, height };                  // 디스플레이를 모른다 — 좌표를 믿지 않는다

  // ⚠ '어느 디스플레이 **안에** 있나'가 아니라 '**충분히 겹치나**'로 본다. 창을 화면 경계에 걸쳐 두는 건
  //  정상 사용이라, 완전 포함을 요구하면 멀쩡한 배치를 매번 가운데로 되돌려 버린다.
  const rect = { x, y, width, height };
  const grabbable = list.some((d) => {
    const o = overlap(rect, d);
    return o.width >= MIN_VISIBLE.width && o.height >= MIN_VISIBLE.height;
  });
  return grabbable ? { width, height, x, y } : { width, height };
}

/** 저장할 값만 추린다 — Electron 의 bounds 객체엔 우리가 안 쓰는 필드가 섞여 온다. */
export function pickBounds(b) {
  const o = b && typeof b === "object" ? b : {};
  const out = { x: num(o.x), y: num(o.y), width: num(o.width), height: num(o.height) };
  return Object.values(out).every((v) => v !== null) ? out : null;
}

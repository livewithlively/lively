// remote-web-kit.ts — 웹 판 원격 화면(#4993 (A))의 판정 넷: 키 → 원격 동작 · 화면 좌표 → 스크린샷 좌표 · 휠 → 스크롤 · 다음 화면 받기까지.
//  DOM 을 만지지 않는다 — node 시험(scripts/remote-web-kit.test.mjs)이 표 그대로 잰다. 화면은 remote-web.ts.
//  원격 동작의 이름·문법은 데스크톱 쪽(browser-host)이 받는 그대로다: 키는 «수식+키» 를 + 로 잇고(cmd·ctrl·shift·alt),
//  특수 키는 DOM 이름(Enter · ArrowLeft …)을 그대로 넘긴다(데스크톱이 소문자로 읽어 제 이름으로 바꾼다).

export type RemoteKey =
  | { kind: 'text'; text: string }
  | { kind: 'key'; keys: string }
  | { kind: 'copy' }
  | { kind: 'reload' }
  | { kind: 'skip' };

/** 키 사건에서 쓰는 칸만 — KeyboardEvent 를 넘기되 altGraph 는 부르는 쪽이 getModifierState('AltGraph') 로 채운다. */
export interface KeyLike { key?: string; keyCode?: number; isComposing?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; altGraph?: boolean }

//  Insert 는 넣지 않는다 — Shift+Insert · Ctrl+Insert 는 편집(붙여넣기 · 복사) 단축키라 원격 클립보드 길을 하나 더 연다(격리 리뷰).
const SPECIAL = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const MODIFIER_ONLY = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS', 'Hyper', 'Super']);

/**
 * 사람이 원격 화면에서 누른 키를 원격 동작으로 — null 이면 이 화면이 손대지 않는다(사람 브라우저의 기본 동작 그대로).
 *  · 글자(명령 키 없음)는 글로 모아 보낸다(데스크톱이 insertText — 한글·기호 그대로). ⚠ 그래서 입력칸 밖의 글자 단축키
 *    (메일의 j·k 같은)는 안 먹는다 — 1판의 한계.
 *  · 한글 조합 중에는 건너뛴다 — 조합이 끝날 때(compositionend) 그 글이 한 번에 간다. keyCode 229 도 조합 키다 — 사파리는 조합을
 *    Enter 로 확정하면 compositionend 뒤에 isComposing=false 인 Enter(229)를 또 낸다(저장소 규약 #505 와 같은 판정).
 *  · AltGr(윈도 · 리눅스의 오른쪽 Alt = Ctrl+Alt)로 친 글자(@ € { [ …)는 글이다 — 명령 조합으로 보내면 글자가 안 쳐진다.
 *  · 명령 키(mac ⌘ · 그 밖 Ctrl)+v 는 null — 사람 브라우저가 붙여넣기 사건을 내고, 화면이 그 글을 보낸다.
 *  · 명령 키+c·x 는 copy — 원격에서 고른 글을 사람 클립보드로(잘라내기도 원격 글은 지우지 않는다).
 *  · 명령 키+r · F5 는 reload — 원격 페이지를 다시 싣는다(라이블리 화면 전체가 다시 실리지 않게).
 */
export function remoteKeyAction(e: KeyLike, mac: boolean): RemoteKey | null {
  const key = String(e?.key ?? '');
  if (!key) return null;
  if (e.isComposing || e.keyCode === 229 || key === 'Process' || key === 'Dead') return { kind: 'skip' };
  if (MODIFIER_ONLY.has(key)) return null;
  if (key === 'Insert') return null;                          // 어떤 수식과도 — shift+Insert · ctrl+Insert 는 붙여넣기 · 복사(위 SPECIAL 머리말)
  const single = [...key].length === 1;
  //  깃발(getModifierState('AltGraph'))이 없는 브라우저는 ctrl+alt 로만 온다 — 그때 영문자 · 숫자는 단축키(구글 문서 ctrl+alt+m 같은)로 둔다.
  //   AltGr 가 만드는 것은 기호 · 악센트 글자(@ € { ą …)다.
  if (single && !e.metaKey && (e.altGraph || (!mac && e.ctrlKey && e.altKey && !/^[a-z0-9]$/i.test(key)))) return { kind: 'text', text: key };
  const cmd = mac ? !!e.metaKey : !!e.ctrlKey;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  if (key === 'F5' || (cmd && lower === 'r' && !e.shiftKey)) return { kind: 'reload' };
  if (cmd && lower === 'r') return null;                     // ⇧⌘R — 라이블리 화면 전체를 다시 싣는 탈출구는 사람 브라우저에 남긴다
  if (cmd && lower === 'v' && !e.altKey) return null;
  if (cmd && (lower === 'c' || lower === 'x') && !e.altKey && !e.shiftKey) return { kind: 'copy' };
  const mods: string[] = [];
  if (e.metaKey) mods.push('cmd');
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey || e.ctrlKey) {
    //  명령 조합 — 글자는 소문자로(데스크톱이 대문자 코드로 바꾼다). shift 는 수식으로 따로 실린다.
    return { kind: 'key', keys: [...mods, lower].join('+') };
  }
  if (SPECIAL.has(key) || /^F([1-9]|1[0-2])$/.test(key)) return { kind: 'key', keys: [...mods, key].join('+') };
  if (single) return { kind: 'text', text: key };
  return null;
}

/** 보낼 입력 하나 — 글(데스크톱 insertText) 또는 키 조합들(공백으로 이어 한 번에). */
export type InputItem = { kind: 'text'; text: string } | { kind: 'key'; keys: string[] };

/**
 * 보낼 입력 줄에 하나를 더한다 — 같은 종류가 이어지면 합친다(글은 이어 붙이고, 키는 한 번에 보낼 묶음으로).
 *  키를 꾹 누르면(반복) 키마다 원격 동작 + 스크린샷이 쌓여 놓은 뒤에도 몇십 초 더 지워졌다(격리 리뷰 실측: Backspace 1.3초 → 40건 · 22초).
 *  키 묶음은 툴 입력 상한(keys 100자) 안에서만 — 넘으면 새 묶음.
 */
export function pushInput(items: InputItem[], add: InputItem, maxKeyChars = 100): InputItem[] {
  const out = items.slice();
  const last = out[out.length - 1];
  if (last && last.kind === 'text' && add.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + add.text };
  else if (last && last.kind === 'key' && add.kind === 'key' && [...last.keys, ...add.keys].join(' ').length <= maxKeyChars) out[out.length - 1] = { kind: 'key', keys: [...last.keys, ...add.keys] };
  else out.push(add);
  return out;
}

/** 보이는 그림 위의 점(ox, oy — 그림 왼쪽 위 기준 CSS px)을 원격 스크린샷 좌표로. 그림 밖이면 가장자리로 자른다. */
export function toShotPoint(ox: number, oy: number, clientW: number, clientH: number, shotW: number, shotH: number): { x: number; y: number } | null {
  if (!(clientW > 0) || !(clientH > 0) || !(shotW > 0) || !(shotH > 0)) return null;
  const x = Math.round((Number(ox) || 0) * (shotW / clientW));
  const y = Math.round((Number(oy) || 0) * (shotH / clientH));
  return { x: Math.max(0, Math.min(shotW - 1, x)), y: Math.max(0, Math.min(shotH - 1, y)) };
}

/**
 * 모은 휠(보이는 CSS px)을 원격 스크롤로 — 페이지 px = 휠 × (그림 너비 / 보이는 너비) ÷ 찍기 배율(그림 px = 페이지 px × 배율).
 *  큰 쪽 축 하나만. 1px 도 안 되면 null. 상한 20,000(데스크톱 쪽과 같은 상한).
 */
export function wheelToScroll(sumX: number, sumY: number, clientW: number, shotW: number, shotScale: number): { direction: 'up' | 'down' | 'left' | 'right'; amount: number } | null {
  if (!(clientW > 0) || !(shotW > 0)) return null;
  const s = Number.isFinite(shotScale) && shotScale > 0 ? shotScale : 1;
  const k = (shotW / clientW) / s;
  const vertical = Math.abs(Number(sumY) || 0) >= Math.abs(Number(sumX) || 0);
  const d = (vertical ? Number(sumY) : Number(sumX)) || 0;
  const amount = Math.min(20_000, Math.round(Math.abs(d) * k));
  if (amount < 1) return null;
  return { direction: vertical ? (d > 0 ? 'down' : 'up') : (d > 0 ? 'right' : 'left'), amount };
}

/**
 * 다음 화면을 받기까지(ms) — 안 보이면 null(멈춤). 조작 직후엔 빠르게, 바뀌는 중엔 보통, 가만히 있으면 느리게.
 *  오류가 이어지면 1·2·4…초(상한 10초)로 물러난다. 창에 초점이 없으면(사람이 다른 창에서 일한다) 방금 조작한 게 아니면 5초 —
 *  가만히 있어도 받는 전체 그림이 1Mbps 폰 회선을 먹는다(격리 리뷰).
 */
export function nextDelay(o: { visible: boolean; sinceInputMs: number; changed: boolean; errors: number; focused?: boolean }): number | null {
  if (!o.visible) return null;
  if (o.errors > 0) return Math.min(10_000, 1000 * 2 ** (Math.min(10, o.errors) - 1));
  if (o.sinceInputMs < 1_500) return 150;
  if (o.focused === false) return 5_000;
  if (o.changed) return 500;
  if (o.sinceInputMs > 10_000) return 2_000;
  return 800;
}

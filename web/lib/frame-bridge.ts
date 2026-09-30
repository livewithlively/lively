// frame-bridge.ts — 격리 프레임(sandbox=allow-scripts, allow-same-origin 없음) 안의 문서 ↔ 셸 «검토 다리» (#4075)
//
//  왜: 시안(HTML)은 공용 렌더러 htmlFrame 으로 격리 프레임에 뜬다. 문서의 오리진이 불투명하므로 문서 안
//   스크립트는 localStorage 에 손을 못 대고(접근 자체가 예외) 클립보드 쓰기·내려받기도 막힌다. 줄마다 코멘트를
//   달아 저장하고 [코멘트 전체 복사]로 채팅에 붙이는 «검토판» 문서(원준 2026-09-19)는 그래서 곁칸 [뷰어]에서
//   죽어 있었다 — 새 탭에서만 됐다. 격리는 그대로 두고(문서에 쿠키·부모 DOM 을 주지 않는다), 문서가 부탁하는
//   세 가지(저장·복사·내려받기)만 셸이 **대신** 한다. v2/app-ui.ts 의 앱 UI 브리지와 같은 수법이다.
//
//  규약(문서 쪽 검토 레이어와 합의, 2026-09-20 — 문서는 window.parent.postMessage(msg, '*') 로 보낸다):
//   문서 → 셸  {lv:'rv', op:'hello'} · {op:'get', key} · {op:'set', key, value} · {op:'del', key}
//              · {op:'copy', text, html} · {op:'download', name, text, mime}
//   셸 → 문서  {lv:'rv', op:'ready'} · {op:'got', key, value|null} · {op:'copied', ok}
//
//  안전 규칙(전부 순수 함수 handleBridgeMessage 가 지킨다 — 창 없이 시험한다):
//   · 이 프레임(contentWindow)에서 온 메시지만 받는다(attachFrameBridge 가 거른다).
//   · 값은 문자열로만 다루고 절대 실행하지 않는다. 키 200자·값 1MB 를 넘으면 버린다.
//   · 저장 키에는 파일마다 이름 공간(rvb:<ns>:)을 붙인다 — 문서가 남의 저장값을 읽거나 덮지 못한다.
//   · 내려받기 이름은 경로 문자를 지우고, MIME 은 꼴이 맞을 때만 받는다.
//   · 응답 target 은 '*' — 불투명 오리진은 이름으로 못 가리키고, 그 프레임 창만 받는다.

export const RV_KEY_MAX = 200;
export const RV_VALUE_MAX = 1_000_000;    // 코멘트 수백 건도 수십 KB 다 — 1MB 면 넉넉하고 저장소도 안 넘친다
export const RV_NS_PREFIX = 'rvb:';

export interface BridgeDeps {
  get(key: string): string | null;
  set(key: string, value: string): void;
  del(key: string): void;
  copy(text: string, html: string): Promise<boolean>;
  download(name: string, text: string, mime: string): void;
}

export interface BridgeReply { lv: 'rv'; op: 'ready' | 'got' | 'copied'; key?: string; value?: string | null; ok?: boolean }

/** 저장 키 — 파일마다 이름 공간을 붙인다. */
export function nsKey(ns: string, key: string): string { return RV_NS_PREFIX + ns + ':' + key; }

/** 내려받기 파일 이름 — 경로·제어 문자를 지우고 120자로 자른다. 비면 기본 이름. */
export function safeDownloadName(name: string): string {
  const s = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120);
  return s || 'download.txt';
}

const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;

/**
 * 메시지 하나를 처리해 답(있으면)을 돌려준다. 순수 — DOM·창 없이 시험한다.
 *  규약 밖 메시지·모양이 다른 값은 조용히 버린다(null). 문서가 보내는 것은 신뢰하지 않는다.
 */
export async function handleBridgeMessage(data: unknown, ns: string, deps: BridgeDeps): Promise<BridgeReply | null> {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (m.lv !== 'rv' || typeof m.op !== 'string') return null;
  const key = typeof m.key === 'string' && m.key.length > 0 && m.key.length <= RV_KEY_MAX ? m.key : null;
  switch (m.op) {
    case 'hello':
      return { lv: 'rv', op: 'ready' };
    case 'get': {
      if (!key) return null;
      let value: string | null = null;
      try { value = deps.get(nsKey(ns, key)); } catch { value = null; }
      return { lv: 'rv', op: 'got', key, value: typeof value === 'string' ? value : null };
    }
    case 'set': {
      if (!key || typeof m.value !== 'string' || m.value.length > RV_VALUE_MAX) return null;
      try { deps.set(nsKey(ns, key), m.value); } catch { /* 용량·차단 — 문서 쪽이 다음 get 에서 없음을 본다 */ }
      return null;
    }
    case 'del': {
      if (!key) return null;
      try { deps.del(nsKey(ns, key)); } catch { /* 위와 같음 */ }
      return null;
    }
    case 'copy': {
      const text = typeof m.text === 'string' ? m.text : '';
      const html = typeof m.html === 'string' ? m.html : '';
      if (!text && !html) return { lv: 'rv', op: 'copied', ok: false };
      let ok = false;
      try { ok = await deps.copy(text, html); } catch { ok = false; }
      return { lv: 'rv', op: 'copied', ok: !!ok };
    }
    case 'download': {
      const text = typeof m.text === 'string' ? m.text : null;
      if (text === null || text.length > RV_VALUE_MAX * 4) return null;
      const name = safeDownloadName(typeof m.name === 'string' ? m.name : '');
      const mime = typeof m.mime === 'string' && MIME_RE.test(m.mime) ? m.mime : 'text/plain';
      try { deps.download(name, text, mime); } catch { /* 내려받기 막힘 — 문서 쪽 시트 대안이 있다 */ }
      return null;
    }
    default:
      return null;
  }
}

/** 셸의 클립보드 — 서식(text/html)과 글자를 함께 쓰고, 안 되면 글자만. 사용자 손짓(프레임 안 클릭)은 조상 창에도 전해져 여기서 쓸 수 있다. */
async function copyToClipboard(text: string, html: string): Promise<boolean> {
  const cb = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!cb) return false;
  try {
    if (html && typeof ClipboardItem !== 'undefined' && typeof cb.write === 'function') {
      await cb.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text || html.replace(/<[^>]+>/g, '')], { type: 'text/plain' }) })]);
      return true;
    }
  } catch { /* 서식 쓰기 거절 — 글자만 */ }
  try { await cb.writeText(text || html); return true; } catch { return false; }
}

/** 셸에서 파일로 내려받게 한다(문서가 만든 백업 JSON 등). */
function downloadText(name: string, text: string, mime: string): void {
  const u = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = u; a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(u), 10_000);
}

/** 브라우저 localStorage 를 쓰는 기본 의존 — 막혀 있으면(사파리 비공개 등) 없는 것처럼 군다. */
export function browserDeps(): BridgeDeps {
  return {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 차단·용량 */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* 차단 */ } },
    copy: copyToClipboard,
    download: downloadText,
  };
}

/**
 * 프레임에 다리를 건다. 돌려주는 함수가 뗀다 — 부른 쪽이 다른 파일을 펼 때 부른다.
 *  프레임이 문서에서 빠진 뒤 오는 메시지는 없지만(창이 사라진다), 안전하게 그때도 스스로 뗀다.
 */
export function attachFrameBridge(frame: HTMLIFrameElement, ns: string, deps: BridgeDeps = browserDeps()): () => void {
  const onMsg = (ev: MessageEvent): void => {
    if (!frame.isConnected) { window.removeEventListener('message', onMsg); return; }
    if (!ev.source || ev.source !== frame.contentWindow) return;
    void handleBridgeMessage(ev.data, ns, deps).then((reply) => { if (reply) frame.contentWindow?.postMessage(reply, '*'); });
  };
  window.addEventListener('message', onMsg);
  return () => window.removeEventListener('message', onMsg);
}

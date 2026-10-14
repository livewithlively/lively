// context-run-config.ts — 맥락 관리 자동화의 **«어느 AI 로 돌릴까»** 선택기(#4008).
//
//  왜 공용 부품인가: 증류기·분류기·관리기는 화면이 셋인데 묻는 것은 같다(제공자·모델·추론강도).
//  세 화면에 같은 폼을 따로 쓰면 하네스가 늘 때 한 곳만 고쳐지고, 실제로 그렇게 낡는다
//  (admin-automation.ts 의 상시세션 폼이 claude 목록을 하드코딩해 antigravity 를 못 고르던 자리와 같은 병).
//
//  ⚠ 선택지는 **서버 카탈로그**(/api/ui/terminal/config → HARNESSES)에서 온다. 웹에 모델 목록을 박지 않는다 —
//   모델 이름은 CLI 가 올려 버리는 값이라, 박아 두면 화면이 조용히 설치본보다 뒤처진다.
//   카탈로그를 못 받으면 제공자 칸만 «자동» 으로 서고 모델·강도는 자유 입력으로 떨어진다(폼이 죽지 않는다).
//
//  ⚠ «자동» 의 뜻을 화면이 **정확히** 말해야 한다. 종전 화면은 빈 값을 «계정 기본값» 이라고 적었는데,
//   그게 무엇인지는 우리가 정하는 값이 아니었다(claude 가 기본을 fable 로 올리자 무인 증류가 그대로
//   페이블로 돌아 토큰을 태웠다 — 원준님 2026-09-16). 지금은 라이블리가 자동화 기본을 정하므로,
//   화면도 «비우면 <그 하네스의 기본>» 이라고 이름을 대고 말한다.
import { api, el } from './core.js';

/** 하네스별 자동화 기본값 — 서버 catalog.ts AUTOMATION_DEFAULTS 와 **같은 값**을 사람 말로 적는다.
 *  ⚠ 여기는 표시 전용이다(전송되는 값이 아니다). 서버가 정본이고, 화면은 «비우면 무엇이 되는지»만 말한다. */
const AUTO_LABEL: Record<string, { model: string; effort: string }> = {
  claude: { model: 'opus', effort: 'low' },
  codex: { model: 'gpt-5.6-sol', effort: 'medium' },
  antigravity: { model: 'gemini-3.8-flash-high', effort: 'high' },
  grok: { model: 'grok-4.6', effort: 'medium' },
};

export interface RunConfigValue { harness: string | null; model: string | null; effort: string | null }

export interface RunConfig {
  /** 폼에 끼워 넣을 요소 셋 — 화면마다 감싸는 방식(F()·psBlock())이 달라 컨트롤만 돌려준다. */
  harnessSel: HTMLSelectElement;
  modelSel: HTMLSelectElement;
  effortSel: HTMLSelectElement;
  /** 지금 고른 값. 비어 있으면 null(=자동). */
  value: () => RunConfigValue;
  /** 세 칸 아래에 붙일 «지금 비우면 무엇이 되나» 안내(카탈로그·선택에 따라 갱신된다). */
  hint: HTMLElement;
}

/**
 * 제공자·모델·추론강도 선택기를 만든다.
 *
 *  동작의 요점은 **제공자를 바꾸면 모델·강도 선택지가 그 하네스 것으로 갈아탄다**는 것이다.
 *  이 연동이 없으면 codex 를 골라 두고 `opus` 를 저장하는 조합이 만들어지는데, 그건 실행 시점에
 *  조용히 버려져 다시 기본 모델로 도는 값이다(고치기 전의 사고와 같은 결말).
 *  제공자가 «자동» 이면 하네스가 실행 시점에 정해지므로 모델·강도는 고를 수 없다(«자동» 고정) —
 *  고를 수 없는 것을 고르게 두면 그 선택이 안 듣는 이유를 아무도 설명할 수 없다.
 */
export function runConfig(cur: Partial<RunConfigValue> | null, style: string): RunConfig {
  const harnessSel = el('select', { style }) as HTMLSelectElement;
  const modelSel = el('select', { style }) as HTMLSelectElement;
  const effortSel = el('select', { style }) as HTMLSelectElement;
  const hint = el('p', { class: 'admin-hint' }) as HTMLElement;

  // 카탈로그를 받기 전의 값(선택이 지워지지 않게 먼저 세워 둔다).
  const want = { harness: cur?.harness || '', model: cur?.model || '', effort: cur?.effort || '' };
  let cat: any[] = [];

  const optionsOf = (hKey: string, flag: string): string[] => {
    const h = cat.find((x) => x.key === hKey);
    const f = (h?.flags || []).find((x: any) => x.name === flag);
    return (f?.choices || []).filter((v: string) => v !== '');
  };

  const fillAxis = (sel: HTMLSelectElement, flag: string, keep: string, autoOf: (a: { model: string; effort: string }) => string): void => {
    const hKey = harnessSel.value;
    const auto = hKey && AUTO_LABEL[hKey] ? autoOf(AUTO_LABEL[hKey]) : '';
    const choices = hKey ? optionsOf(hKey, flag) : [];
    sel.replaceChildren(el('option', { value: '', text: auto ? `자동 — ${auto}` : '자동' }));
    for (const v of choices) sel.append(el('option', { value: v, text: v }));
    // 고른 제공자가 모르는 값이면 되살리지 않는다 — 그 조합은 실행 시점에 어차피 버려진다.
    sel.value = choices.includes(keep) ? keep : '';
    // 제공자가 «자동» 이면 이 축은 고를 수 없다(실행 시점에 하네스가 정해져야 선택지가 생긴다).
    sel.disabled = !hKey;
  };

  const renderAxes = (): void => {
    fillAxis(modelSel, '--model', want.model, (a) => a.model);
    fillAxis(effortSel, '--effort', want.effort, (a) => a.effort);
    const h = cat.find((x) => x.key === harnessSel.value);
    hint.textContent = harnessSel.value
      ? `비워 두면 ${h?.label || harnessSel.value} 의 자동화 기본값으로 돕니다` +
        (AUTO_LABEL[harnessSel.value] ? ` — ${AUTO_LABEL[harnessSel.value].model} · ${AUTO_LABEL[harnessSel.value].effort}.` : '.')
      : '제공자가 «자동» 이면 실행 계정이 로그인한 AI 중에서 고릅니다(클로드 우선). 모델·추론강도도 그 AI 의 자동화 기본값으로 정해집니다.';
  };

  // 제공자 칸 — 카탈로그가 오기 전에도 현재 값은 서 있어야 한다(비동기 사이에 사람이 저장할 수 있다).
  const fillHarness = (): void => {
    const keep = harnessSel.value || want.harness;
    harnessSel.replaceChildren(el('option', { value: '', text: '자동 — 로그인한 AI 중에서' }));
    for (const h of cat) harnessSel.append(el('option', { value: h.key, text: `${h.provider?.label || h.key} (${h.label || h.key})` }));
    // 카탈로그에 없는 값(예: 이 배포가 모르는 하네스)이라도 저장된 설정은 보여 준다 — 조용히 «자동» 으로
    //  바꿔 버리면 사람이 설정을 잃고도 모른다.
    if (keep && !cat.some((h) => h.key === keep)) harnessSel.append(el('option', { value: keep, text: `${keep} (이 배포가 모르는 AI)` }));
    harnessSel.value = keep;
    renderAxes();
  };
  fillHarness();
  harnessSel.addEventListener('change', () => { want.model = ''; want.effort = ''; renderAxes(); });

  void (async () => {
    try {
      const cfg = await api('/api/ui/terminal/config');
      //  shell(=AI 없음)은 무인 배치를 돌릴 수 없으니 뺀다. 위탁 규약을 아는 하네스만 남긴다
      //  (서버 HEADLESS 표와 같은 넷 — 여기 목록이 더 넓으면 고른 즉시 접수가 거부된다).
      const HEADLESS_OK = ['claude', 'codex', 'antigravity', 'grok'];
      cat = ((cfg && cfg.harnesses) || []).filter((h: any) => h && HEADLESS_OK.includes(h.key));
      if (cat.length) fillHarness();
    } catch { /* graceful — 제공자 «자동» 만으로도 폼은 성립한다 */ }
  })();

  return {
    harnessSel, modelSel, effortSel, hint,
    value: () => ({
      harness: harnessSel.value || null,
      model: modelSel.value || null,
      effort: effortSel.value || null,
    }),
  };
}

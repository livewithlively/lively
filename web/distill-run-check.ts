// 증류를 손으로 돌리기 직전의 확인(#5235) — 「지금 한 번 실행」 · 「지금 수집·증류」 가 함께 쓴다.
//
//  레인을 지정하지 않은 증류 잡은 맡은 증류기가 없는 자료도 기본 기준으로 함께 낸다(#1631 — 반만 켜도 나머지가 굶지 않게 한 의도된 동작).
//  문제는 그것을 **누른 뒤에야** 알 수 있었다는 것이다. 증류기 하나를 시범으로 돌렸는데 맡은 증류기가 없는 자료 50건이 붙어 나가
//  손으로 취소한 일이 있었다(고객사 첫 세팅). 그래서 누르기 전에 서버의 실행 계획을 그대로 읽어(cron_run_plan), 기본 기준으로 나갈 자료가 있을 때만 묻는다.
//  무엇을 물을지는 lib/distill-run-ask.ts(순수 규칙), 여기는 그 답대로 창을 그린다.
import { api, el, fmtNum } from './core.js';
import { confirmDialog } from './ui-primitives.js';
import { distillRunAsk, distillRunBody } from './lib/distill-run-ask.js';

/**
 * 실행 요청에 얹을 값을 돌려준다 — `{}` 면 그대로 실행, `{ lanes_only: true }` 면 증류기 몫만, null 이면 사람이 멈췄다.
 *  계획을 못 읽으면 던진다. 무엇이 나갈지 모른 채 실행하지 않는다(부르는 쪽이 실패로 알린다).
 *  ⚠ 계획은 실행 경로(/run)가 아니라 이름이 다른 경로(/run-plan)로 읽는다 — 옛 게이트웨이는 모르는 인자를 떨구고 실제로 실행한다(cron.ts 주석).
 */
export async function confirmDistillRun(jobId: string): Promise<{ lanes_only?: true } | null> {
  const STOP = '무엇이 나갈지 읽지 못해 실행하지 않았습니다';
  let r: any;
  try { r = await api(`/api/ui/cron/${encodeURIComponent(jobId)}/run-plan`); }
  catch (e) { throw new Error(`${STOP} — ${(e as Error).message}`); }
  const a = distillRunAsk(r?.plan);
  if (a.ask === 'unknown') throw new Error(STOP);
  if (a.ask === 'none') return distillRunBody(a, { confirmed: true });
  const restLine = a.rest ? [`남은 ${fmtNum(a.rest)}건은 다음 실행부터 이어서 나갑니다.`] : [];

  if (a.ask === 'default-only') {
    const confirmed = await confirmDialog({
      title: `기본 기준으로 자료 ${fmtNum(a.sources)}건을 지식으로 만듭니다`,
      message: '맡은 증류기가 없는 자료입니다. 증류기의 기준이 아니라 기본 기준으로 지식이 됩니다.',
      lines: restLine, confirmText: '실행',
    });
    return distillRunBody(a, { confirmed });
  }

  const withRest = el('input', { type: 'checkbox', id: 'distill-run-unassigned' }) as HTMLInputElement;
  const confirmed = await confirmDialog({
    title: `맡은 증류기가 없는 자료 ${fmtNum(a.sources)}건이 있습니다`,
    message: '함께 실행하면 이 자료는 증류기의 기준이 아니라 기본 기준으로 지식이 됩니다.',
    lines: [`증류기 ${fmtNum(a.laneCount)}개가 자료 ${fmtNum(a.laneSources)}건을 읽습니다.`, ...restLine],
    extra: el('label', { class: 'ov-confirm-opt', for: 'distill-run-unassigned' }, withRest,
      el('span', { class: 'n', text: '맡은 증류기가 없는 자료도 함께 실행합니다' }),
      //  (#5235) 이번 1회만 뺀다는 것을 말한다 — «뺐다» 고 믿었는데 켜 둔 자동 실행이 다음 주기에 그대로 내보내면 같은 사고다.
      el('span', { class: 'h', text: '끄면 이번 실행에서만 뺍니다. 자동 실행이 켜져 있으면 다음 주기에 나갑니다' })),
    confirmText: '실행',
  });
  return distillRunBody(a, { confirmed, withUnassigned: withRest.checked });
}

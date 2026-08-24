export const SESSION_HANDOFF_CONTEXT_MAX = 16_000;
export function sessionHandoffContext(records, max = SESSION_HANDOFF_CONTEXT_MAX) {
    const turns = [];
    for (const r of records) {
        const parts = [];
        if (r.t.text.trim())
            parts.push(`사용자: ${r.t.text.trim()}`);
        const said = [];
        const tools = [];
        for (const ev of r.evs) {
            if (ev?.type !== 'assistant' || !Array.isArray(ev?.message?.content))
                continue;
            for (const b of ev.message.content) {
                if (b?.type === 'text' && String(b.text || '').trim())
                    said.push(String(b.text).trim());
                else if (b?.type === 'tool_use' && b.name)
                    tools.push(String(b.name));
            }
        }
        if (said.length)
            parts.push(`AI: ${said.join('\n')}`);
        if (tools.length)
            parts.push(`사용한 도구: ${Array.from(new Set(tools)).join(', ')}`);
        if (parts.length)
            turns.push(parts.join('\n'));
    }
    let out = '';
    for (let i = turns.length - 1; i >= 0; i--) {
        const next = turns[i] + (out ? `\n\n${out}` : '');
        if (next.length > max)
            break;
        out = next;
    }
    return out;
}

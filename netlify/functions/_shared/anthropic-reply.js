// Reading a reply from the Messages API — one place, so every function reads
// it the same way and says WHY when there is no text.
//
// Build 688. The CFO planner had failed with "empty reply" since Build 485
// (4 Sept) moved it from claude-sonnet-5 to claude-opus-5. Opus 5 thinks by
// default (adaptive thinking runs when `thinking` is omitted), its thinking
// tokens count against max_tokens, and its thinking blocks come back with EMPTY
// text unless display is asked for. The planner's passes asked for 6,000–12,000
// tokens on up to 120k characters of data: the model spent the whole budget
// thinking, stopped with stop_reason "max_tokens", and the content held one
// thinking block and no text block. Filtering for text found nothing, and the
// only thing the founders ever saw was "empty reply". claude.js hit the same
// wall at 8,192 and raised its ceiling (see the 16384 note there).
//
// The fix has three parts, all here:
//   • budgets with room for the thinking (max_tokens is a ceiling, not spend);
//   • streaming for the long calls, because a non-streamed call that thinks for
//     more than five minutes trips Node fetch's 300s headers timeout — raising
//     the budget alone would swap "empty reply" for "fetch failed";
//   • an honest reason when there still is no text (out of room, declined).

export const MODEL = 'claude-opus-5';   // the model claude.js pins as DEFAULT_MODEL
export const API_URL = 'https://api.anthropic.com/v1/messages';

// The answer: every text block, in order. Thinking, tool and search blocks are
// not the answer and are never read as one.
export function replyText(msg, sep) {
  const blocks = (msg && Array.isArray(msg.content)) ? msg.content : [];
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text).join(sep == null ? '\n' : sep).trim();
}

// Why a reply carries no text, in words a founder can act on.
export function emptyReason(msg, maxTokens) {
  const sr = msg && msg.stop_reason;
  const blocks = (msg && Array.isArray(msg.content)) ? msg.content : [];
  const thought = blocks.some((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking'));
  if (sr === 'max_tokens') {
    return 'empty reply: the model used its whole ' + (maxTokens ? maxTokens + '-token ' : '')
      + 'budget ' + (thought ? 'thinking ' : '') + 'before it wrote an answer (stop_reason max_tokens)';
  }
  if (sr === 'refusal') {
    const cat = msg.stop_details && msg.stop_details.category;
    return 'empty reply: the model declined this request' + (cat ? ' (' + cat + ')' : '') + ' (stop_reason refusal)';
  }
  return 'empty reply (stop_reason ' + (sr || 'unknown') + ')';
}

// Text, or an Error that says why there is none.
export function requireText(msg, maxTokens, sep) {
  const t = replyText(msg, sep);
  if (!t) throw new Error(emptyReason(msg, maxTokens));
  return t;
}

// ── Streaming ─────────────────────────────────────────────────────────────
// Rebuilds the same message object a non-streamed call returns, from the
// server-sent events, so everything above reads both alike.
export function createAssembler() {
  let msg = null;
  const partialJson = {};
  return {
    push(ev) {
      if (!ev || typeof ev !== 'object') return;
      switch (ev.type) {
        case 'message_start':
          msg = Object.assign({}, ev.message || {}, { content: [] });
          break;
        case 'content_block_start':
          if (!msg) msg = { content: [] };
          msg.content[ev.index] = Object.assign({}, ev.content_block || {});
          break;
        case 'content_block_delta': {
          if (!msg) msg = { content: [] };
          const b = msg.content[ev.index] || (msg.content[ev.index] = { type: 'text', text: '' });
          const d = ev.delta || {};
          if (d.type === 'text_delta') b.text = (b.text || '') + (d.text || '');
          else if (d.type === 'thinking_delta') b.thinking = (b.thinking || '') + (d.thinking || '');
          else if (d.type === 'signature_delta') b.signature = d.signature;
          else if (d.type === 'input_json_delta') partialJson[ev.index] = (partialJson[ev.index] || '') + (d.partial_json || '');
          else if (d.type === 'citations_delta' && d.citation) (b.citations || (b.citations = [])).push(d.citation);
          break;
        }
        case 'content_block_stop':
          if (msg && partialJson[ev.index] != null) {
            try { msg.content[ev.index].input = JSON.parse(partialJson[ev.index] || '{}'); } catch (_) { /* left as sent */ }
          }
          break;
        case 'message_delta':
          if (!msg) msg = { content: [] };
          if (ev.delta) {
            if ('stop_reason' in ev.delta) msg.stop_reason = ev.delta.stop_reason;
            if ('stop_details' in ev.delta) msg.stop_details = ev.delta.stop_details;
          }
          if (ev.usage) msg.usage = Object.assign({}, msg.usage || {}, ev.usage);
          break;
        case 'error':
          throw new Error((ev.error && ev.error.message) || 'stream error');
        default: break;   // ping, message_stop
      }
    },
    message() { const m = msg || { content: [] }; m.content = (m.content || []).filter(Boolean); return m; },
  };
}

// Feed raw SSE text through the assembler. Returns the unparsed tail.
export function feedSSE(asm, buffer) {
  let rest = buffer.replace(/\r\n/g, '\n');
  let cut;
  while ((cut = rest.indexOf('\n\n')) >= 0) {
    const frame = rest.slice(0, cut);
    rest = rest.slice(cut + 2);
    const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) continue;
    let ev; try { ev = JSON.parse(data); } catch (_) { continue; }
    asm.push(ev);
  }
  return rest;
}

// POST a streamed Messages request and return the assembled message.
export async function streamMessage(key, body, opts) {
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(Object.assign({}, body, { stream: true })),
    signal: opts && opts.signal,
  });
  if (!r.ok) {
    let d = 'HTTP ' + r.status;
    try { const e = await r.json(); if (e && e.error && e.error.message) d = e.error.message; } catch (_) {}
    throw new Error(d);
  }
  const asm = createAssembler();
  const dec = new TextDecoder();
  let buf = '';
  const reader = r.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf = feedSSE(asm, buf + dec.decode(value, { stream: true }));
  }
  feedSSE(asm, buf + dec.decode() + '\n\n');
  return asm.message();
}

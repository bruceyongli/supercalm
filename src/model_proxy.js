import { randomUUID } from 'node:crypto';
import { route, json, readJson } from './server.js';
import { currentProviders, fleetKey, listProxyModels, routeForModel } from './model_catalog.js';

function rid(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function upstreamUrl(port, path) {
  return `http://127.0.0.1:${port}${path}`;
}

function responseHeaders(upstream, fallback = 'application/json; charset=utf-8') {
  const h = {
    'content-type': upstream.headers.get('content-type') || fallback,
    'cache-control': upstream.headers.get('cache-control') || 'no-cache',
  };
  const requestId = upstream.headers.get('x-request-id');
  if (requestId) h['x-request-id'] = requestId;
  return h;
}

async function pipeUpstream(upstream, res) {
  res.writeHead(upstream.status, responseHeaders(upstream));
  if (!upstream.body) return res.end();
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

async function fetchJson(url, body, headers = {}) {
  // the fleet checks PROXY_API_KEY on every endpoint — the real key, not a dummy
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${await fleetKey()}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function forwardJson(req, res, path) {
  const body = await readJson(req);
  const r = routeForModel(body.model);
  const forwarded = { ...body, model: r.model };
  const upstream = await fetchJson(upstreamUrl(r.port, path), forwarded);
  await pipeUpstream(upstream, res);
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function* readSse(stream) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = raw.split(/\r?\n/);
      let event = 'message';
      const data = [];
      for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (!data.length) continue;
      const text = data.join('\n');
      if (text === '[DONE]') {
        yield { done: true, event, data: null };
        continue;
      }
      try {
        yield { done: false, event, data: JSON.parse(text) };
      } catch {
        yield { done: false, event, data: text };
      }
    }
  }
}

function asText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b?.type === 'text' || b?.type === 'input_text' || b?.type === 'output_text') return b.text || '';
        if (b?.type === 'tool_result') return asText(b.content);
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return typeof content === 'object' ? JSON.stringify(content) : String(content);
}

function imageUrlFromAnthropic(block) {
  const src = block?.source || {};
  if (src.type === 'url') return src.url;
  if (src.type === 'base64' && src.data) return `data:${src.media_type || 'image/png'};base64,${src.data}`;
  return null;
}

function anthropicMessagesToChat(messages = [], { structuredTools = true } = {}) {
  const out = [];
  const toolIdMap = new Map();
  const toolCallId = (id) => {
    const raw = String(id || rid('call'));
    if (!toolIdMap.has(raw)) toolIdMap.set(raw, raw);
    return toolIdMap.get(raw);
  };
  const pushUser = (parts) => {
    if (!parts.length) return;
    const onlyText = parts.every((p) => p.type === 'text');
    out.push({ role: 'user', content: onlyText ? parts.map((p) => p.text).join('\n') : parts });
    parts.length = 0;
  };

  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = m.content;
    if (!Array.isArray(content)) {
      out.push({ role, content: asText(content) });
      continue;
    }

    if (role === 'assistant') {
      const text = [];
      const toolCalls = [];
      for (const block of content) {
        if (block?.type === 'text') text.push(block.text || '');
        if (block?.type === 'tool_use') {
          if (structuredTools) {
            toolCalls.push({
              id: toolCallId(block.id),
              type: 'function',
              function: {
                name: block.name || 'tool',
                arguments: JSON.stringify(block.input || {}),
              },
            });
          } else {
            text.push(`[Tool call ${block.id || ''}: ${block.name || 'tool'} ${JSON.stringify(block.input || {})}]`);
          }
        }
      }
      const msg = { role, content: text.filter(Boolean).join('\n') || (toolCalls.length ? null : '') };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }

    const parts = [];
    for (const block of content) {
      if (block?.type === 'text') parts.push({ type: 'text', text: block.text || '' });
      else if (block?.type === 'image') {
        const url = imageUrlFromAnthropic(block);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      } else if (block?.type === 'tool_result') {
        if (structuredTools) {
          pushUser(parts);
          out.push({
            role: 'tool',
            tool_call_id: toolCallId(block.tool_use_id || block.id),
            content: asText(block.content),
          });
        } else {
          parts.push({ type: 'text', text: `[Tool result ${block.tool_use_id || block.id || ''}]\n${asText(block.content)}` });
        }
      }
    }
    pushUser(parts);
  }
  return out;
}

function anthropicToolsToChat(tools = []) {
  return tools
    .filter((t) => t && t.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: sanitizeJsonSchema(t.input_schema || { type: 'object', properties: {} }),
      },
    }));
}

function sanitizeJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeJsonSchema);
  const allowed = new Set([
    'type',
    'description',
    'enum',
    'items',
    'properties',
    'required',
    'nullable',
    'format',
    'minimum',
    'maximum',
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
  ]);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
      out.properties = Object.fromEntries(Object.entries(v).map(([name, prop]) => [name, sanitizeJsonSchema(prop)]));
      continue;
    }
    if (!allowed.has(k)) continue;
    out[k] = sanitizeJsonSchema(v);
  }
  return out;
}

function anthropicToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === 'string') return choice;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool') return { type: 'function', function: { name: choice.name } };
  return undefined;
}

function anthropicToChat(body, model, { structuredHistory = true } = {}) {
  const messages = anthropicMessagesToChat(body.messages || [], { structuredTools: structuredHistory });
  const sys = asText(body.system);
  if (sys) messages.unshift({ role: 'system', content: sys });
  const toolNames = (body.tools || []).map((t) => t?.name).filter(Boolean);
  if (toolNames.length) {
    messages.unshift({
      role: 'system',
      content:
        'Supercalm bridge instruction: use the provided function-calling API for tools. ' +
        'Do not write visible text like "[Tool call ...]" and do not invent numbered aliases like tool_0. ' +
        `Valid tool names include: ${toolNames.slice(0, 80).join(', ')}.`,
    });
  }
  const chat = {
    model,
    messages,
    stream: !!body.stream,
  };
  if (body.max_tokens != null) chat.max_tokens = body.max_tokens;
  if (body.temperature != null) chat.temperature = body.temperature;
  if (body.top_p != null) chat.top_p = body.top_p;
  if (body.stop_sequences) chat.stop = body.stop_sequences;
  const tools = anthropicToolsToChat(body.tools || []);
  if (tools.length) chat.tools = tools;
  const toolChoice = anthropicToolChoice(body.tool_choice);
  if (toolChoice) chat.tool_choice = toolChoice;
  return chat;
}

function hasStructuredToolHistory(chatBody) {
  return (chatBody.messages || []).some((m) => m?.role === 'tool' || (Array.isArray(m?.tool_calls) && m.tool_calls.length));
}

function shouldRetryFlattenedToolHistory(upstream, chatBody) {
  return hasStructuredToolHistory(chatBody) && (upstream.status === 400 || upstream.status === 422);
}

function mapFinishReason(reason) {
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'content_filter') return 'stop_sequence';
  return 'end_turn';
}

function usageToAnthropic(usage = {}) {
  return {
    input_tokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    output_tokens: Number(usage.completion_tokens || usage.output_tokens || 0),
  };
}

function upstreamSseError(ev) {
  if (!ev || (ev.event !== 'error' && !ev.data?.error)) return null;
  const err = typeof ev.data === 'string' ? ev.data : ev.data?.error || ev.data;
  if (typeof err === 'string') return err;
  return err?.message || err?.body || JSON.stringify(err);
}

function toolNameSet(tools = []) {
  const names = tools.map((t) => t?.name).filter(Boolean);
  return names.length ? new Set(names) : null;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function bridgeRecoveryTool(invalidNames = [], tools = []) {
  if (!invalidNames.length || !toolNameSet(tools)?.has('Bash')) return null;
  const names = [...new Set(invalidNames)].join(', ');
  const valid = tools.map((t) => t?.name).filter(Boolean).slice(0, 30).join(', ');
  const note =
    `Supercalm bridge recovered from invalid tool aliases (${names}). ` +
    `The model must call real Claude Code tools with required inputs. Valid examples: ${valid}.`;
  return {
    id: rid('call'),
    name: 'Bash',
    input: {
      command: `printf '%s\\n' ${shellQuote(note)}`,
      description: 'Recover from invalid tool aliases',
    },
  };
}

function parseBalancedJson(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { raw: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

function parseToolInput(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return { arguments: raw || '' };
  }
}

function parsePseudoToolCalls(text, tools = []) {
  const src = String(text || '');
  const validNames = toolNameSet(tools);
  if (!src.includes('[Tool call ')) return { text: src, tools: [], invalidTools: [] };

  let out = '';
  const parsedTools = [];
  const invalidTools = [];
  let pos = 0;
  const prefix = '[Tool call ';

  while (pos < src.length) {
    const start = src.indexOf(prefix, pos);
    if (start < 0) {
      out += src.slice(pos);
      break;
    }

    const headerStart = start + prefix.length;
    const colon = src.indexOf(':', headerStart);
    if (colon < 0) {
      out += src.slice(pos);
      break;
    }

    let i = colon + 1;
    while (/\s/.test(src[i] || '')) i++;
    const nameMatch = src.slice(i).match(/^([A-Za-z_][A-Za-z0-9_.-]*)/);
    if (!nameMatch) {
      out += src.slice(pos, start + prefix.length);
      pos = start + prefix.length;
      continue;
    }

    const name = nameMatch[1];
    i += name.length;
    while (/\s/.test(src[i] || '')) i++;
    const jsonBlock = parseBalancedJson(src, i);
    if (!jsonBlock) {
      out += src.slice(pos, start + prefix.length);
      pos = start + prefix.length;
      continue;
    }

    let end = jsonBlock.end;
    while (/\s/.test(src[end] || '')) end++;
    if (src[end] !== ']') {
      out += src.slice(pos, start + prefix.length);
      pos = start + prefix.length;
      continue;
    }

    if (validNames && !validNames.has(name)) {
      if (/^tool_\d+$/i.test(name)) {
        invalidTools.push(name);
        out += src.slice(pos, start);
        pos = end + 1;
        continue;
      }
      out += src.slice(pos, end + 1);
      pos = end + 1;
      continue;
    }

    out += src.slice(pos, start);
    parsedTools.push({
      id: src.slice(headerStart, colon).trim() || rid('call'),
      name,
      input: parseToolInput(jsonBlock.raw),
    });
    pos = end + 1;
  }

  return {
    text: out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    tools: parsedTools,
    invalidTools,
  };
}

function chatToolCallsToAnthropic(toolCalls = []) {
  return toolCalls.map((tc) => ({
    type: 'tool_use',
    id: tc.id || rid('call'),
    name: tc.function?.name || 'tool',
    input: parseToolInput(tc.function?.arguments || '{}'),
  }));
}

function chatToAnthropicMessage(chat, model, tools = []) {
  const choice = chat.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  const parsed = parsePseudoToolCalls(typeof msg.content === 'string' ? msg.content : asText(msg.content), tools);
  if (parsed.text) content.push({ type: 'text', text: parsed.text });
  const recovery = bridgeRecoveryTool(parsed.invalidTools, tools);
  content.push(
    ...chatToolCallsToAnthropic(msg.tool_calls || []),
    ...parsed.tools.map((t) => ({ type: 'tool_use', ...t })),
    ...(recovery ? [{ type: 'tool_use', ...recovery }] : [])
  );
  const hasToolUse = content.some((b) => b.type === 'tool_use');
  return {
    id: rid('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: hasToolUse ? 'tool_use' : mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: usageToAnthropic(chat.usage),
  };
}

async function streamChatAsAnthropic(upstream, res, model, requestTools = []) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  const message = {
    id: rid('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  writeSse(res, 'message_start', { type: 'message_start', message });

  let nextIndex = 0;
  const tools = new Map();
  let text = '';
  let finishReason = 'end_turn';
  let usage = null;

  const emitText = (value) => {
    if (!value) return;
    const index = nextIndex++;
    writeSse(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    });
    writeSse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text: value },
    });
    writeSse(res, 'content_block_stop', { type: 'content_block_stop', index });
  };

  const emitTool = (tool) => {
    const index = nextIndex++;
    const input = tool.input ?? parseToolInput(tool.arguments || '{}');
    const t = {
      id: tool.id || rid('call'),
      name: tool.name || 'tool',
      input,
    };
    writeSse(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} },
    });
    writeSse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    });
    writeSse(res, 'content_block_stop', { type: 'content_block_stop', index });
  };

  for await (const ev of readSse(upstream.body)) {
    if (ev.done) break;
    const upstreamError = upstreamSseError(ev);
    if (upstreamError) {
      writeSse(res, 'error', {
        type: 'error',
        error: { type: 'api_error', message: upstreamError },
      });
      res.end();
      return;
    }
    const data = ev.data || {};
    if (data.usage) usage = data.usage;
    const choice = data.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content) text += delta.content;
    for (const tc of delta.tool_calls || []) {
      const key = tc.index || 0;
      const t = tools.get(key) || { id: tc.id || rid('call'), name: tc.function?.name || `tool_${key}`, arguments: '' };
      tools.set(key, t);
      finishReason = 'tool_use';
      if (tc.id) t.id = tc.id;
      if (tc.function?.name) t.name = tc.function.name;
      if (tc.function?.arguments) t.arguments += tc.function.arguments;
    }
    if (choice.finish_reason) {
      const mapped = mapFinishReason(choice.finish_reason);
      if (!(mapped === 'end_turn' && tools.size)) finishReason = mapped;
    }
  }
  const parsed = parsePseudoToolCalls(text, requestTools);
  const allTools = [
    ...tools.values(),
    ...parsed.tools,
  ];
  const recovery = bridgeRecoveryTool(parsed.invalidTools, requestTools);
  if (recovery) allTools.push(recovery);
  emitText(parsed.text);
  for (const t of allTools) emitTool(t);
  if (allTools.length) finishReason = 'tool_use';
  writeSse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: finishReason, stop_sequence: null },
    usage: usageToAnthropic(usage || {}),
  });
  writeSse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

async function handleAnthropicMessages(req, res) {
  const body = await readJson(req);
  const r = routeForModel(body.model);
  const model = r.model || body.model;
  if (r.proxy === 'claude') {
    const upstream = await fetchJson(upstreamUrl(r.port, '/v1/messages'), { ...body, model }, {
      'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
      'anthropic-beta': req.headers['anthropic-beta'] || '',
    });
    return pipeUpstream(upstream, res);
  }

  let chatBody = anthropicToChat(body, model, { structuredHistory: true });
  let upstream = await fetchJson(upstreamUrl(r.port, '/v1/chat/completions'), chatBody);
  if (!upstream.ok && shouldRetryFlattenedToolHistory(upstream, chatBody)) {
    console.warn(`[aios] ${r.proxy} rejected structured Claude tool history for ${body.model}; retrying flattened history`);
    chatBody = anthropicToChat(body, model, { structuredHistory: false });
    upstream = await fetchJson(upstreamUrl(r.port, '/v1/chat/completions'), chatBody);
  }
  if (!upstream.ok) return pipeUpstream(upstream, res);
  if (body.stream) return streamChatAsAnthropic(upstream, res, body.model, body.tools || []);
  const chat = await upstream.json();
  json(res, 200, chatToAnthropicMessage(chat, body.model, body.tools || []));
}

async function handleAnthropicCountTokens(req, res) {
  const body = await readJson(req);
  const r = routeForModel(body.model);
  if (r.proxy === 'claude') {
    const upstream = await fetchJson(upstreamUrl(r.port, '/v1/messages/count_tokens'), { ...body, model: r.model }, {
      'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
      'anthropic-beta': req.headers['anthropic-beta'] || '',
    });
    return pipeUpstream(upstream, res);
  }
  const rough = JSON.stringify({ system: body.system || '', messages: body.messages || [], tools: body.tools || [] });
  json(res, 200, { input_tokens: Math.max(1, Math.ceil(rough.length / 4)) });
}

function responseUsage(usage = {}) {
  const input = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const output = Number(usage.completion_tokens || usage.output_tokens || 0);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Number(usage.total_tokens || input + output),
    input_tokens_details: { cached_tokens: Number(usage.prompt_tokens_details?.cached_tokens || 0) },
    output_tokens_details: { reasoning_tokens: Number(usage.completion_tokens_details?.reasoning_tokens || 0) },
  };
}

function contentPartsToChat(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return asText(content);
  const parts = [];
  for (const p of content) {
    if (p?.type === 'input_text' || p?.type === 'output_text' || p?.type === 'text') {
      parts.push({ type: 'text', text: p.text || '' });
    } else if (p?.type === 'input_image') {
      const url = p.image_url || p.url;
      if (url) parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  if (parts.every((p) => p.type === 'text')) return parts.map((p) => p.text).join('\n');
  return parts;
}

function responsesInputToMessages(input, instructions, { structuredTools = true } = {}) {
  const messages = [];
  if (instructions) messages.push({ role: 'system', content: asText(instructions) });
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }
  for (const item of Array.isArray(input) ? input : []) {
    if (item?.type === 'function_call_output') {
      if (structuredTools) {
        messages.push({ role: 'tool', tool_call_id: item.call_id || item.id || rid('call'), content: asText(item.output) });
      } else {
        messages.push({ role: 'user', content: `[Tool result ${item.call_id || item.id || ''}]\n${asText(item.output)}` });
      }
      continue;
    }
    if (item?.type === 'function_call') {
      if (structuredTools) {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: item.call_id || item.id || rid('call'),
            type: 'function',
            function: { name: item.name || 'tool', arguments: item.arguments || '{}' },
          }],
        });
      } else {
        messages.push({ role: 'assistant', content: `[Tool call ${item.call_id || item.id || ''}: ${item.name || 'tool'} ${item.arguments || '{}'}]` });
      }
      continue;
    }
    const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'system' || item?.role === 'developer' ? 'system' : 'user';
    const content = contentPartsToChat(item?.content ?? item?.text ?? item);
    messages.push({ role, content });
  }
  return messages;
}

function responsesToolsToChat(tools = []) {
  return tools
    .filter((t) => t && t.type === 'function')
    .map((t) =>
      t.function
        ? { ...t, function: { ...t.function, parameters: sanitizeJsonSchema(t.function.parameters || { type: 'object', properties: {} }) } }
        : {
            type: 'function',
            function: {
              name: t.name,
              description: t.description || '',
              parameters: sanitizeJsonSchema(t.parameters || { type: 'object', properties: {} }),
            },
          }
    );
}

function responsesToolChoice(choice) {
  if (!choice || choice === 'auto' || choice === 'required' || choice === 'none') return choice;
  if (choice.type === 'function') return { type: 'function', function: { name: choice.name || choice.function?.name } };
  return undefined;
}

function responsesToChat(body, model, { structuredHistory = true } = {}) {
  const chat = {
    model,
    messages: responsesInputToMessages(body.input, body.instructions, { structuredTools: structuredHistory }),
    stream: !!body.stream,
  };
  if (!chat.messages.length) chat.messages.push({ role: 'user', content: '' });
  if (body.max_output_tokens != null) chat.max_tokens = body.max_output_tokens;
  if (body.temperature != null) chat.temperature = body.temperature;
  if (body.top_p != null) chat.top_p = body.top_p;
  const tools = responsesToolsToChat(body.tools || []);
  if (tools.length) chat.tools = tools;
  const toolChoice = responsesToolChoice(body.tool_choice);
  if (toolChoice) chat.tool_choice = toolChoice;
  if (body.parallel_tool_calls != null) chat.parallel_tool_calls = body.parallel_tool_calls;
  return chat;
}

function responseBase(body, status, output, usage = {}) {
  return {
    id: body._responseId || rid('resp'),
    object: 'response',
    created_at: body._createdAt || nowSec(),
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: body.instructions || null,
    max_output_tokens: body.max_output_tokens ?? null,
    model: body.model,
    output,
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    previous_response_id: body.previous_response_id || null,
    reasoning: body.reasoning || null,
    service_tier: body.service_tier || 'default',
    store: body.store ?? false,
    temperature: body.temperature ?? null,
    text: body.text || { format: { type: 'text' } },
    tool_choice: body.tool_choice || 'auto',
    tools: body.tools || [],
    top_p: body.top_p ?? null,
    truncation: body.truncation || 'disabled',
    usage: responseUsage(usage),
  };
}

function responseToolDefs(tools = []) {
  return tools
    .map((t) => ({ name: t?.name || t?.function?.name }))
    .filter((t) => t.name);
}

function responseRecoveryCall(invalidNames = [], tools = []) {
  if (!invalidNames.length) return null;
  const names = new Set(responseToolDefs(tools).map((t) => t.name));
  if (!names.has('shell')) return null;
  const bad = [...new Set(invalidNames)].join(', ');
  const valid = [...names].slice(0, 30).join(', ');
  const note =
    `Supercalm bridge recovered from invalid tool aliases (${bad}). ` +
    `The model must call real Codex tools with required inputs. Valid examples: ${valid}.`;
  return {
    id: rid('fc'),
    type: 'function_call',
    status: 'completed',
    call_id: rid('call'),
    name: 'shell',
    arguments: JSON.stringify({ command: ['sh', '-lc', `printf '%s\\n' ${shellQuote(note)}`] }),
  };
}

function chatToResponseOutput(chat, requestTools = []) {
  const choice = chat.choices?.[0] || {};
  const msg = choice.message || {};
  const output = [];
  const parsed = parsePseudoToolCalls(typeof msg.content === 'string' ? msg.content : asText(msg.content), responseToolDefs(requestTools));
  if (parsed.text) {
    output.push({
      id: rid('msg'),
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: parsed.text, annotations: [] }],
    });
  }
  for (const tc of msg.tool_calls || []) {
    output.push({
      id: rid('fc'),
      type: 'function_call',
      status: 'completed',
      call_id: tc.id || rid('call'),
      name: tc.function?.name || 'tool',
      arguments: tc.function?.arguments || '{}',
    });
  }
  for (const t of parsed.tools) {
    output.push({
      id: rid('fc'),
      type: 'function_call',
      status: 'completed',
      call_id: t.id || rid('call'),
      name: t.name,
      arguments: JSON.stringify(t.input || {}),
    });
  }
  const recovery = responseRecoveryCall(parsed.invalidTools, requestTools);
  if (recovery) output.push(recovery);
  return output;
}

async function streamChatAsResponse(upstream, res, body) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  const state = { ...body, _responseId: rid('resp'), _createdAt: nowSec() };
  const output = [];
  const text = { item: null, outputIndex: null, contentIndex: 0, text: '' };
  const tools = new Map();
  const requestTools = responseToolDefs(body.tools || []);
  const bufferTextForToolParsing = requestTools.length > 0;
  let usage = null;

  writeSse(res, 'response.created', { type: 'response.created', response: responseBase(state, 'in_progress', []) });
  writeSse(res, 'response.in_progress', { type: 'response.in_progress', response: responseBase(state, 'in_progress', []) });

  const openText = () => {
    if (text.item) return;
    text.outputIndex = output.length;
    text.item = { id: rid('msg'), type: 'message', status: 'in_progress', role: 'assistant', content: [] };
    output.push(text.item);
    writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: text.outputIndex, item: text.item });
    writeSse(res, 'response.content_part.added', {
      type: 'response.content_part.added',
      item_id: text.item.id,
      output_index: text.outputIndex,
      content_index: text.contentIndex,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  };
  const openTool = (i, tc = {}) => {
    if (tools.has(i)) return tools.get(i);
    const item = {
      id: rid('fc'),
      type: 'function_call',
      status: 'in_progress',
      call_id: tc.id || rid('call'),
      name: tc.function?.name || `tool_${i}`,
      arguments: '',
    };
    const t = { item, outputIndex: output.length };
    tools.set(i, t);
    output.push(item);
    writeSse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: t.outputIndex, item });
    return t;
  };

  for await (const ev of readSse(upstream.body)) {
    if (ev.done) break;
    const upstreamError = upstreamSseError(ev);
    if (upstreamError) {
      const failed = {
        ...responseBase(state, 'failed', output, usage || {}),
        error: { type: 'upstream_error', message: upstreamError },
      };
      writeSse(res, 'response.failed', { type: 'response.failed', response: failed });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const data = ev.data || {};
    if (data.usage) usage = data.usage;
    const choice = data.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content) {
      text.text += delta.content;
      if (!bufferTextForToolParsing) {
        openText();
        writeSse(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: text.item.id,
          output_index: text.outputIndex,
          content_index: text.contentIndex,
          delta: delta.content,
        });
      }
    }
    for (const tc of delta.tool_calls || []) {
      const t = openTool(tc.index || 0, tc);
      if (tc.id) t.item.call_id = tc.id;
      if (tc.function?.name) t.item.name = tc.function.name;
      if (tc.function?.arguments) {
        t.item.arguments += tc.function.arguments;
        writeSse(res, 'response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: t.item.id,
          output_index: t.outputIndex,
          delta: tc.function.arguments,
        });
      }
    }
  }

  if (bufferTextForToolParsing && text.text) {
    const parsed = parsePseudoToolCalls(text.text, requestTools);
    text.text = parsed.text;
    if (text.text) {
      openText();
      writeSse(res, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: text.item.id,
        output_index: text.outputIndex,
        content_index: text.contentIndex,
        delta: text.text,
      });
    }
    for (const t of parsed.tools) {
      const item = openTool(`parsed_${tools.size}`, { id: t.id || rid('call'), function: { name: t.name } });
      item.item.arguments = JSON.stringify(t.input || {});
      writeSse(res, 'response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: item.item.id,
        output_index: item.outputIndex,
        delta: item.item.arguments,
      });
    }
    const recovery = responseRecoveryCall(parsed.invalidTools, body.tools || []);
    if (recovery) {
      const item = openTool(`recovery_${tools.size}`, { id: recovery.call_id, function: { name: recovery.name } });
      item.item.arguments = recovery.arguments;
      writeSse(res, 'response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: item.item.id,
        output_index: item.outputIndex,
        delta: item.item.arguments,
      });
    }
  }

  if (text.item) {
    const part = { type: 'output_text', text: text.text, annotations: [] };
    text.item.status = 'completed';
    text.item.content = [part];
    writeSse(res, 'response.output_text.done', {
      type: 'response.output_text.done',
      item_id: text.item.id,
      output_index: text.outputIndex,
      content_index: text.contentIndex,
      text: text.text,
    });
    writeSse(res, 'response.content_part.done', {
      type: 'response.content_part.done',
      item_id: text.item.id,
      output_index: text.outputIndex,
      content_index: text.contentIndex,
      part,
    });
    writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: text.outputIndex, item: text.item });
  }
  for (const t of tools.values()) {
    t.item.status = 'completed';
    writeSse(res, 'response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      item_id: t.item.id,
      output_index: t.outputIndex,
      arguments: t.item.arguments,
    });
    writeSse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: t.outputIndex, item: t.item });
  }
  writeSse(res, 'response.completed', { type: 'response.completed', response: responseBase(state, 'completed', output, usage || {}) });
  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleResponses(req, res) {
  const body = await readJson(req);
  const r = routeForModel(body.model);
  const model = r.model || body.model;
  if (r.proxy === 'codex') {
    const upstream = await fetchJson(upstreamUrl(r.port, '/v1/responses'), { ...body, model });
    return pipeUpstream(upstream, res);
  }

  let chatBody = responsesToChat(body, model, { structuredHistory: true });
  let upstream = await fetchJson(upstreamUrl(r.port, '/v1/chat/completions'), chatBody);
  if (!upstream.ok && shouldRetryFlattenedToolHistory(upstream, chatBody)) {
    console.warn(`[aios] ${r.proxy} rejected structured Responses tool history for ${body.model}; retrying flattened history`);
    chatBody = responsesToChat(body, model, { structuredHistory: false });
    upstream = await fetchJson(upstreamUrl(r.port, '/v1/chat/completions'), chatBody);
  }
  if (!upstream.ok) return pipeUpstream(upstream, res);
  if (body.stream) return streamChatAsResponse(upstream, res, body);
  const chat = await upstream.json();
  const output = chatToResponseOutput(chat, body.tools || []);
  json(res, 200, responseBase(body, 'completed', output, chat.usage || {}));
}

route('GET', '/api/proxy/models', (req, res) => {
  json(res, 200, { ok: true, providers: currentProviders(), models: listProxyModels() });
});

route('GET', '/api/cli-proxy/v1/models', (req, res) => {
  json(res, 200, {
    object: 'list',
    data: listProxyModels().map((m) => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: m.provider,
      display_name: m.label,
    })),
  });
});

route('POST', '/api/cli-proxy/v1/chat/completions', (req, res) => forwardJson(req, res, '/v1/chat/completions'));
route('POST', '/api/cli-proxy/v1/messages', handleAnthropicMessages);
route('POST', '/api/cli-proxy/v1/messages/count_tokens', handleAnthropicCountTokens);
route('POST', '/api/cli-proxy/v1/responses', handleResponses);

import crypto from 'node:crypto';

/** Every function here runs on the proxy's hot path for a request that is
 *  already being served. None of them may throw: a body we cannot parse is a
 *  capture miss, never a failed completion. They return null instead. */

export interface CapturedRequest {
  model: string | null;
  messages: unknown[] | null;
  tools: unknown[] | null;
  streamed: boolean;
  userPreview: string | null;
}

export interface CapturedResponse {
  promptTokens: number | null;
  completionTokens: number | null;
  toolCallCount: number | null;
  finishReason: string | null;
  responseText: string | null;
}

const PREVIEW_CHARS = 180;

export function newRequestId(): string {
  return crypto.randomBytes(9).toString('base64url');
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function json(buf: Buffer): Record<string, unknown> | null {
  if (!buf.length) return null;
  try {
    const v = JSON.parse(buf.toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `content` is a string on a plain turn and an array of parts on the vision
 *  lane. Both shapes appear against this server. */
function flattenContent(content: unknown): string | null {
  if (typeof content === 'string') return content || null;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map(p => (p && typeof p === 'object' ? str((p as { text?: unknown }).text) : null))
    .filter((s): s is string => s !== null);
  return parts.length ? parts.join(' ') : null;
}

export function parseRequestBody(buf: Buffer): CapturedRequest | null {
  const b = json(buf);
  if (!b) return null;

  const messages = Array.isArray(b.messages) ? (b.messages as unknown[]) : null;
  const tools = Array.isArray(b.tools) && b.tools.length ? (b.tools as unknown[]) : null;

  /* LAST user turn, not first. An agentic conversation replays its whole
     history every call, so the first user message is identical across
     hundreds of rows and useless as a preview. */
  let userPreview: string | null = null;
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages![i] as { role?: unknown; content?: unknown } | null;
    if (m && typeof m === 'object' && m.role === 'user') {
      const text = flattenContent(m.content);
      if (text) userPreview = text.slice(0, PREVIEW_CHARS);
      break;
    }
  }

  return { model: str(b.model), messages, tools, streamed: b.stream === true, userPreview };
}

export function parseResponseBody(buf: Buffer): CapturedResponse | null {
  const b = json(buf);
  if (!b) return null;

  const choices = Array.isArray(b.choices) ? b.choices : [];
  const first = (choices[0] ?? null) as
    | { message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }
    | null;
  const usage = (b.usage ?? null) as { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
  const toolCalls = first?.message?.tool_calls;

  return {
    promptTokens: num(usage?.prompt_tokens),
    completionTokens: num(usage?.completion_tokens),
    toolCallCount: choices.length ? (Array.isArray(toolCalls) ? toolCalls.length : 0) : null,
    finishReason: str(first?.finish_reason),
    responseText: first ? flattenContent(first.message?.content) : null,
  };
}

/** The product token of a User-Agent — enough to tell gbrain from a curl
 *  probe without storing a fingerprint. */
export function clientLabel(userAgent: string | undefined): string | null {
  const ua = str(userAgent);
  if (!ua) return null;
  return ua.split(/[\s(]/)[0] || null;
}

/** Truncates to a BYTE budget without splitting a multi-byte character.
 *  A character budget would let a CJK transcript through at ~3x the cap. */
export function truncate(s: string | null, maxBytes: number): { value: string | null; truncated: boolean } {
  if (s === null) return { value: null, truncated: false };
  if (maxBytes <= 0) return { value: '', truncated: s.length > 0 };
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { value: s, truncated: false };

  const cut = Buffer.from(s, 'utf8').subarray(0, maxBytes);

  /* Walk back over continuation bytes (0b10xxxxxx) to the lead byte of the
     last sequence, then keep that sequence only if it COMPLETED inside the
     cut. Dropping the lead byte unconditionally is the tempting one-liner and
     it is wrong: when the cap lands exactly on a character boundary the
     sequence is whole, and discarding it throws away a character that fit.
     For 3-byte text and a cap that is a multiple of 3 that is every character,
     and a cap of 3 yields "". */
  let lead = cut.length - 1;
  while (lead >= 0 && (cut[lead] & 0xc0) === 0x80) lead--;
  if (lead < 0) return { value: '', truncated: true };

  const b = cut[lead];
  const seqLen = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
  const end = lead + seqLen <= cut.length ? cut.length : lead;
  return { value: cut.subarray(0, end).toString('utf8'), truncated: true };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newRequestId, parseRequestBody, parseResponseBody, clientLabel, truncate,
} from './capture';

const buf = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8');

test('newRequestId is unique and url-safe', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newRequestId()));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{8,}$/);
});

test('parses a plain chat-completions request', () => {
  const r = parseRequestBody(buf({
    model: 'qwen', messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi there' }],
  }));
  assert.equal(r?.model, 'qwen');
  assert.equal(r?.streamed, false);
  assert.equal(r?.userPreview, 'hi there');
  assert.equal(r?.messages?.length, 2);
  assert.equal(r?.tools, null);
});

/* The preview must be the LAST user turn, not the first — an agentic
   conversation replays its whole history on every call, so the first user
   message is the same string for hundreds of rows. */
test('userPreview takes the last user message, not the first', () => {
  const r = parseRequestBody(buf({
    messages: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'an answer' },
      { role: 'user', content: 'second question' },
    ],
  }));
  assert.equal(r?.userPreview, 'second question');
});

test('userPreview flattens array-shaped content parts', () => {
  const r = parseRequestBody(buf({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] }],
  }));
  assert.equal(r?.userPreview, 'part one part two');
});

test('detects streaming and tools', () => {
  const r = parseRequestBody(buf({
    stream: true, tools: [{ type: 'function', function: { name: 'search' } }],
    messages: [{ role: 'user', content: 'x' }],
  }));
  assert.equal(r?.streamed, true);
  assert.equal(r?.tools?.length, 1);
});

test('a body with no user message yields a null preview, not a throw', () => {
  const r = parseRequestBody(buf({ messages: [{ role: 'system', content: 'only system' }] }));
  assert.equal(r?.userPreview, null);
});

test('malformed or non-JSON request bodies yield null', () => {
  assert.equal(parseRequestBody(Buffer.from('not json at all')), null);
  assert.equal(parseRequestBody(Buffer.from('')), null);
  assert.equal(parseRequestBody(buf('a bare string')), null);
  assert.equal(parseRequestBody(buf(42)), null);
});

test('parses a completed response', () => {
  const r = parseResponseBody(buf({
    choices: [{ message: { role: 'assistant', content: 'Hi! How can I help?' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 15, completion_tokens: 9 },
  }));
  assert.equal(r?.promptTokens, 15);
  assert.equal(r?.completionTokens, 9);
  assert.equal(r?.finishReason, 'stop');
  assert.equal(r?.responseText, 'Hi! How can I help?');
  assert.equal(r?.toolCallCount, 0);
});

test('counts tool calls on the response', () => {
  const r = parseResponseBody(buf({
    choices: [{ message: { tool_calls: [{ id: 'a' }, { id: 'b' }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  }));
  assert.equal(r?.toolCallCount, 2);
  assert.equal(r?.finishReason, 'tool_calls');
});

test('an error-shaped response yields nulls rather than throwing', () => {
  const r = parseResponseBody(buf({ error: { message: 'context length exceeded' } }));
  assert.equal(r?.promptTokens, null);
  assert.equal(r?.completionTokens, null);
  assert.equal(r?.responseText, null);
  assert.equal(r?.finishReason, null);
});

test('malformed response bodies yield null', () => {
  assert.equal(parseResponseBody(Buffer.from('<html>502</html>')), null);
  assert.equal(parseResponseBody(Buffer.from('')), null);
});

test('clientLabel extracts a product token', () => {
  assert.equal(clientLabel('node'), 'node');
  assert.equal(clientLabel('OpenAI/JS 4.20.1'), 'OpenAI/JS');
  assert.equal(clientLabel(undefined), null);
  assert.equal(clientLabel(''), null);
});

/* The cap is a BYTE budget. Counting UTF-16 units would let a CJK transcript
   through at roughly three times the intended size. */
test('truncate counts bytes, not characters', () => {
  const ascii = 'a'.repeat(100);
  assert.deepEqual(truncate(ascii, 100), { value: ascii, truncated: false });
  assert.equal(truncate(ascii, 10).value, 'a'.repeat(10));
  assert.equal(truncate(ascii, 10).truncated, true);
});

test('truncate never splits a multi-byte character', () => {
  const t = truncate('経経経', 4);                      // 4 bytes cuts mid-character
  assert.equal(t.value, '経');                          // not a replacement char
  assert.equal(t.truncated, true);
});

/* Exact-boundary cases, asserted by VALUE. An upper-bound assertion
   (byteLength <= cap) cannot distinguish a correct result from one that
   silently discards a character which fit — which is exactly the bug an
   earlier version of this function had. */
test('truncate keeps a character that completes exactly at the cap', () => {
  assert.equal(truncate('経'.repeat(100), 3).value, '経');
  assert.equal(truncate('経'.repeat(100), 30).value, '経'.repeat(10));
  assert.equal(Buffer.byteLength(truncate('経'.repeat(100), 30).value!, 'utf8'), 30);
});

/* 4-byte sequences take a different walk-back path from 3-byte ones. */
test('truncate handles 4-byte sequences at and across the boundary', () => {
  assert.equal(truncate('a😀b', 5).value, 'a😀');       // 1 + 4 fits exactly
  assert.equal(truncate('a😀b', 4).value, 'a');         // the emoji genuinely does not fit
  assert.equal(truncate('😀😀', 4).value, '😀');
  assert.equal(truncate('😀😀', 3).value, '');          // nothing whole fits
});

test('truncate handles a zero or negative cap', () => {
  assert.deepEqual(truncate('anything', 0), { value: '', truncated: true });
  assert.deepEqual(truncate('', 0), { value: '', truncated: false });
});

test('truncate passes null through', () => {
  assert.deepEqual(truncate(null, 100), { value: null, truncated: false });
});

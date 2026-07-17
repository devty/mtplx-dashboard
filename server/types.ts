/** Shape of a single completed request's metrics, as reported by MTPLX's
 *  /metrics endpoint. Fields are optional/nullable throughout because
 *  renderers on the client already no-op gracefully on missing data, and
 *  MTPLX may add fields over time (see the index signature). */
export interface MetricsRecord {
  request_id?: string;
  session_id?: string;
  decode_tok_s?: number | null;
  display_decode_tok_s?: number | null;
  prefill_tok_s?: number | null;
  prompt_tps?: number | null;
  ttft_s?: number | null;
  request_elapsed_s?: number | null;
  decode_elapsed_s?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  drafted_by_depth?: number[];
  accepted_by_depth?: number[];
  mean_accept_probability_by_depth?: number[];
  bonus_tokens?: number | null;
  correction_tokens?: number | null;
  verify_calls?: number | null;
  mtp_depth?: number | null;
  cache_source?: string | null;
  session_cache_hit?: boolean | null;
  cached_tokens?: number | null;
  cache_restore_time_s?: number | null;
  ssd_cache_hit?: boolean | null;
  ssd_cached_tokens?: number | null;
  context_len?: number | null;
  new_prefill_tokens?: number | null;
  draft_time_s?: number | null;
  verify_forward_time_s?: number | null;
  verify_eval_time_s?: number | null;
  accept_time_s?: number | null;
  request_last_user_preview?: string | null;
  request_last_user_chars?: number | null;
  /** Full prompt + response transcript. Only present when MTPLX is patched and
   *  run with MTPLX_DASHBOARD_CAPTURE_BODIES=1 (see patches/). Undefined on a
   *  stock server, which the detail page renders as a preview-only fallback. */
  request_messages_full?: { role: string; content: string }[];
  response_text?: string | null;
  request_message_roles?: string[];
  request_tool_names?: string[];
  tool_call_count?: number | null;
  request_client_label?: string | null;
  request_model?: string | null;
  request_reasoning_mode?: string | null;
  request_enable_thinking?: boolean | null;
  request_message_count?: number | null;
  [key: string]: unknown;
}

export interface ToolParseCounters {
  tool_parse_success?: number;
  tool_parse_fallback?: number;
  unknown_tool_name?: number;
  malformed_tool_call?: number;
  unclosed_tool_call?: number;
  [key: string]: unknown;
}

export interface MtplxMetricsResponse {
  latest?: MetricsRecord;
  recent?: MetricsRecord[];
  tool_parse_counters?: ToolParseCounters;
}

export interface RingBuffers {
  decode: (number | null)[];
  prefill: (number | null)[];
  ttft: (number | null)[];
  accept: (number | null)[];
}

export interface LogEntry {
  /** Server wall-clock ms when this request_id was first observed. */
  firstSeen: number;
  data: MetricsRecord;
}

/** Single payload shape used for both the initial SSE 'snapshot' event and
 *  every subsequent 'tick' — the dashboard reads latest/rings/toolParseCounters/
 *  model, the live log reads `log`; each ignores what it doesn't need. */
export interface StatePayload {
  connected: boolean;
  lastOkAt: number | null;
  lastChangeAt: number | null;
  model: string | null;
  latest: MetricsRecord | null;
  toolParseCounters: ToolParseCounters | null;
  rings: RingBuffers;
  log: {
    order: string[];
    entries: Record<string, LogEntry>;
  };
  ringSize: number;
  logBufferSize: number;
}

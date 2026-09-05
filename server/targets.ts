export interface Target {
  id: string;
  label: string;
  upstreamUrl: string;
  /** Capture-proxy listener port. Parsed now, unused until Phase 2. */
  proxyPort: number | null;
}

const DEFAULT_TARGETS = 'qwen=http://127.0.0.1:8000:8010';

const PORT_MIN = 1;
const PORT_MAX = 65535;

function warn(msg: string): void {
  console.warn(`[targets] ${msg}`);
}

/** Parses one `id=<url>[:proxyPort][|label]` entry, or null if it is malformed.
 *
 *  Rejecting an out-of-range proxy port matters more than it looks: port 0 is
 *  falsy, and `proxyPort` is laid down here for a later phase to consume. Code
 *  that reasonably writes `if (target.proxyPort)` would read an explicit `:0`
 *  as "no proxy configured" and silently skip a target the operator meant to
 *  proxy — a config error disguised as a default. */
function parseOne(chunk: string): Target | null {
  const [spec, label] = chunk.split('|');
  const eq = spec.indexOf('=');
  if (eq < 1) return null;

  const id = spec.slice(0, eq).trim();
  let rest = spec.slice(eq + 1).trim();
  if (!id || !rest) return null;

  /* A trailing :NNNN after the URL's own host:port is the proxy port. Both
     groups anchor on digits, so a bare http://host:8000 keeps its own port and
     an IPv6 literal's colons cannot produce a wrong split. */
  let proxyPort: number | null = null;
  const m = /^(https?:\/\/[^/]+:\d+):(\d+)$/.exec(rest);
  if (m) {
    const port = Number.parseInt(m[2], 10);
    if (port < PORT_MIN || port > PORT_MAX) {
      warn(`proxy port ${m[2]} in "${chunk}" is outside ${PORT_MIN}-${PORT_MAX}`);
      return null;
    }
    rest = m[1];
    proxyPort = port;
  }

  return { id, label: (label || id).trim(), upstreamUrl: rest.replace(/\/+$/, ''), proxyPort };
}

/** RAPID_MLX_TARGETS is a comma-separated list of
 *  `id=<upstreamUrl>[:<proxyPort>][|<label>]`, e.g.
 *    qwen=http://127.0.0.1:8000:8010|Qwen3.6-35B-A3B,gemma=http://127.0.0.1:8087:8011
 *  Phase 1 uses one entry; the list shape is what Phase 3 extends. */
export function parseTargets(env: NodeJS.ProcessEnv): Target[] {
  const raw = (env.RAPID_MLX_TARGETS || '').trim();
  const usingDefault = raw === '';
  const out: Target[] = [];

  for (const chunk of (usingDefault ? DEFAULT_TARGETS : raw).split(',').map(s => s.trim()).filter(Boolean)) {
    const target = parseOne(chunk);
    if (target) out.push(target);
    /* Never drop a misconfigured entry silently. With more than one target a
       single typo would otherwise start the dashboard against a partial fleet
       and look entirely healthy doing it. */
    else warn(`ignoring malformed entry "${chunk}"`);
  }

  if (out.length) return out;
  /* Unreachable when usingDefault — DEFAULT_TARGETS is a constant that parses —
     but the guard makes the single-level recursion structural rather than a
     property a future edit could quietly break. */
  if (usingDefault) throw new Error('DEFAULT_TARGETS is malformed');
  warn(`no usable entries in RAPID_MLX_TARGETS; falling back to "${DEFAULT_TARGETS}"`);
  return parseTargets({});
}

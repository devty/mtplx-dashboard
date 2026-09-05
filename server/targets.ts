export interface Target {
  id: string;
  label: string;
  upstreamUrl: string;
  /** Capture-proxy listener port. Parsed now, unused until Phase 2. */
  proxyPort: number | null;
}

const DEFAULT_TARGETS = 'qwen=http://127.0.0.1:8000:8010';

/** RAPID_MLX_TARGETS is a comma-separated list of
 *  `id=<upstreamUrl>[:<proxyPort>][|<label>]`, e.g.
 *    qwen=http://127.0.0.1:8000:8010|Qwen3.6-35B-A3B,gemma=http://127.0.0.1:8087:8011
 *  Phase 1 uses one entry; the list shape is what Phase 3 extends. */
export function parseTargets(env: NodeJS.ProcessEnv): Target[] {
  const raw = (env.RAPID_MLX_TARGETS || '').trim() || DEFAULT_TARGETS;
  const out: Target[] = [];

  for (const chunk of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const [spec, label] = chunk.split('|');
    const eq = spec.indexOf('=');
    if (eq < 1) continue;

    const id = spec.slice(0, eq).trim();
    let rest = spec.slice(eq + 1).trim();
    if (!id || !rest) continue;

    /* A trailing :NNNN after the URL's own host:port is the proxy port. Match
       only a port that follows a port, so a bare http://host:8000 is not
       mistaken for a proxy port. */
    let proxyPort: number | null = null;
    const m = /^(https?:\/\/[^/]+:\d+):(\d+)$/.exec(rest);
    if (m) {
      rest = m[1];
      proxyPort = Number.parseInt(m[2], 10);
    }

    out.push({
      id,
      label: (label || id).trim(),
      upstreamUrl: rest.replace(/\/+$/, ''),
      proxyPort,
    });
  }

  return out.length ? out : parseTargets({ RAPID_MLX_TARGETS: DEFAULT_TARGETS });
}

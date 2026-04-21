/**
 * HTTP client for the local BGE-M3 embedding service
 * (`backend/services/embedding-server`).
 *
 * The wire protocol is a subset of Hugging Face Text Embeddings Inference (TEI):
 *   POST /embed   { "inputs": [...], "normalize": true } → number[][]
 *   GET  /health  → { status, model, dim, ... }
 *
 * Keeping this subset means we can later replace the Python service with a
 * real TEI container (once the ghcr.io network situation improves) without
 * touching callers.
 */

export interface EmbeddingClientOptions {
  baseUrl: string;            // e.g. http://127.0.0.1:18080
  model: string;              // identifier to stamp onto each row (e.g. "BAAI/bge-m3")
  timeoutMs?: number;         // default 600000 (10min — CPU 上 batch=8 长文本可能 2-4min)
  normalize?: boolean;        // default true
  fetchImpl?: typeof fetch;   // tests can inject
}

export interface EmbeddingHealth {
  status: 'ok' | string;
  model?: string;
  dim?: number;
  max_seq_len?: number;
}

export class EmbeddingClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private opts: EmbeddingClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get modelId(): string {
    return this.opts.model;
  }

  async health(): Promise<EmbeddingHealth> {
    const res = await this.request('/health', { method: 'GET' }, 5000);
    if (!res.ok) {
      throw new Error(`embedding health ${res.status}: ${await safeText(res)}`);
    }
    return (await res.json()) as EmbeddingHealth;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const body = JSON.stringify({
      inputs: texts,
      normalize: this.opts.normalize ?? true
    });
    const res = await this.request('/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    if (!res.ok) {
      throw new Error(`embedding ${res.status}: ${await safeText(res)}`);
    }
    const out = (await res.json()) as number[][];
    if (!Array.isArray(out) || out.length !== texts.length) {
      throw new Error(`embedding response shape mismatch: got ${Array.isArray(out) ? out.length : typeof out}, expected ${texts.length}`);
    }
    return out;
  }

  private async request(path: string, init: RequestInit, timeoutOverrideMs?: number): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutOverrideMs ?? this.opts.timeoutMs ?? 600_000);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(t);
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return '<no body>';
  }
}

export function embeddingClientFromEnv(): EmbeddingClient {
  const baseUrl = process.env.EMBEDDING_SERVER_URL || 'http://127.0.0.1:18080';
  const model = process.env.EMBEDDING_MODEL || 'BAAI/bge-m3';
  return new EmbeddingClient({ baseUrl, model });
}

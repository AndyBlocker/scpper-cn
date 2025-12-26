// PhaseAProcessor is now TypeScript, no shim needed

declare module '*CoreQueries.js' {
  export class CoreQueries {
    buildPhaseAVariables(options: { first: number; after: string | null }): Record<string, unknown>;
    buildQuery(type: string, vars: Record<string, unknown>): { query: string; variables: Record<string, unknown> };
  }
}

declare module '*Progress.js' {
  export class Progress {
    static createBar(options?: { title?: string; total?: number }): {
      increment(delta?: number): void;
      update(value: number): void;
      setTotal(newTotal: number): void;
      stop(): void;
    };
  }
}

declare module '*Logger.js' {
  export const Logger: {
    debug: (msg: string, extra?: any) => void;
    info: (msg: string, extra?: any) => void;
    warn: (msg: string, extra?: any) => void;
    error: (msg: string, extra?: any) => void;
  };
}

declare module '*RateLimitConfig.js' {
  export const SIMPLE_PAGE_THRESHOLD: number;
  export const BUCKET_SOFT_LIMIT: number;
  export const MAX_FIRST: number;
}

declare module '*GraphQLClient.js' {
  export class GraphQLClient {
    request<T = any>(query: string, variables?: any): Promise<T>;
  }
}

declare module '*AliasQueryBuilder.js' {
  export function buildAliasQuery(pages: any[], options: any): { query: string; variables: any };
}

declare module '*PointEstimator.js' {
  export const PointEstimator: { estimatePageCost: (node: any, opts?: any) => number; estimateQueryCost: (pages: any[]) => number };
}

declare module '*TaskQueue.js' {
  export class TaskQueue {
    constructor(concurrency: number);
    add<T>(fn: () => Promise<T>): Promise<void>;
    drain(): Promise<void>;
  }
}

declare module 'ora' {
  interface OraInstance {
    start(text?: string): OraInstance;
    succeed(text?: string): OraInstance;
    fail(text?: string): OraInstance;
    stop(): OraInstance;
  }
  export default function ora(text?: string): OraInstance;
}

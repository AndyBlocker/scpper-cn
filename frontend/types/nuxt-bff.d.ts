import type { $Fetch } from 'ofetch'

/** Convenience alias used across pages/components for typing $bff */
export type BffFetcher = $Fetch

declare module '#app' {
  interface NuxtApp {
    $bff: $Fetch
  }
}

declare module 'vue' {
  interface ComponentCustomProperties {
    $bff: $Fetch
  }
}

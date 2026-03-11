import type { $Fetch } from 'ofetch'

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

export {}

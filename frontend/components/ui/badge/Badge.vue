<script setup lang="ts">
import { Primitive } from 'radix-vue'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '~/utils/cn'

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold backdrop-blur-sm',
  {
    variants: {
      variant: {
        default: 'border-neutral-200 bg-neutral-100 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200',
        success: 'border-emerald-300/70 bg-emerald-50/85 text-emerald-700 dark:border-emerald-500/45 dark:bg-emerald-500/12 dark:text-emerald-200',
        warning: 'border-amber-300/70 bg-amber-50/85 text-amber-700 dark:border-amber-500/45 dark:bg-amber-500/12 dark:text-amber-200',
        danger: 'border-rose-300/70 bg-rose-50/85 text-rose-700 dark:border-rose-500/45 dark:bg-rose-500/12 dark:text-rose-200',
        info: 'border-cyan-300/70 bg-cyan-50/85 text-cyan-700 dark:border-cyan-500/45 dark:bg-cyan-500/12 dark:text-cyan-200',
        GOLD: 'border-amber-300/70 bg-amber-50/85 text-amber-700 dark:border-amber-500/45 dark:bg-amber-500/12 dark:text-amber-200',
        PURPLE: 'border-fuchsia-300/70 bg-fuchsia-50/85 text-fuchsia-700 dark:border-fuchsia-500/45 dark:bg-fuchsia-500/12 dark:text-fuchsia-200',
        BLUE: 'border-sky-300/70 bg-sky-50/85 text-sky-700 dark:border-sky-500/45 dark:bg-sky-500/12 dark:text-sky-200',
        GREEN: 'border-emerald-300/70 bg-emerald-50/85 text-emerald-700 dark:border-emerald-500/45 dark:bg-emerald-500/12 dark:text-emerald-200',
        WHITE: 'border-slate-300/70 bg-slate-50/85 text-slate-700 dark:border-slate-500/45 dark:bg-slate-500/12 dark:text-slate-200'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
)

type BadgeVariants = VariantProps<typeof badgeVariants>

const props = withDefaults(defineProps<{
  variant?: BadgeVariants['variant']
  as?: string
  asChild?: boolean
}>(), {
  variant: 'default',
  as: 'span',
  asChild: false
})
</script>

<template>
  <Primitive
    :as="props.as"
    :as-child="props.asChild"
    :class="cn(badgeVariants({ variant: props.variant }))"
    v-bind="$attrs"
  >
    <slot />
  </Primitive>
</template>

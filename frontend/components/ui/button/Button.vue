<script setup lang="ts">
import { computed, useAttrs } from 'vue'
import { Primitive } from 'radix-vue'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '~/utils/cn'

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-xl font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--g-accent-border)] disabled:cursor-not-allowed disabled:opacity-60',
  {
    variants: {
      variant: {
        default: 'bg-[rgb(var(--accent-strong))] text-white shadow hover:bg-[var(--g-accent)]',
        outline: 'border border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100 dark:hover:border-neutral-600',
        ghost: 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
        destructive: 'bg-rose-600 text-white shadow hover:bg-rose-700 dark:bg-rose-500 dark:hover:bg-rose-600'
      },
      size: {
        sm: 'px-2.5 py-1 text-xs',
        default: 'px-4 py-2 text-sm',
        lg: 'px-5 py-2.5 text-sm'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

type ButtonVariants = VariantProps<typeof buttonVariants>

const props = withDefaults(defineProps<{
  variant?: ButtonVariants['variant']
  size?: ButtonVariants['size']
  as?: string
  asChild?: boolean
  type?: 'button' | 'submit' | 'reset'
}>(), {
  variant: 'default',
  size: 'default',
  as: 'button',
  asChild: false,
  type: 'button'
})

const attrs = useAttrs()

const delegatedAttrs = computed(() => {
  const { class: _class, ...rest } = attrs as Record<string, unknown>
  return rest
})
</script>

<template>
  <Primitive
    :as="props.as"
    :as-child="props.asChild"
    :type="props.as === 'button' && !props.asChild ? props.type : undefined"
    :class="cn(buttonVariants({ variant: props.variant, size: props.size }), attrs.class)"
    v-bind="delegatedAttrs"
  >
    <slot />
  </Primitive>
</template>

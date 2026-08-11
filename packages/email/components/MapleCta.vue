<script setup lang="ts">
/** Full-width button link. `secondary` is the outlined variant. */
defineProps({
	href: { type: String, required: true },
	variant: { type: String, default: "primary" },
	padding: { type: String, default: "px-6 py-3" },
})
</script>

<template><a v-if="variant === 'primary'" :href="href" target="_blank" :class="`block rounded-lg bg-maple-orange ${padding} text-center font-mono text-sm font-semibold text-white no-underline`"><slot /></a><a v-else :href="href" target="_blank" :class="`block rounded-lg border border-solid border-maple-border bg-maple-card ${padding} text-center font-mono text-sm font-semibold text-maple-fg no-underline`"><slot /></a></template>

<script setup lang="ts">
/** Optional second line under the status headline. */
defineProps({ text: { type: String, default: "[[text]]" } })
</script>

<template>
	<p class="m-0 mt-1 font-mono text-[12px] leading-snug text-maple-fg-muted">{{ text }}</p>
</template>

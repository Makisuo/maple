<script setup lang="ts">
/** Optional "N services affected" line under an error message. */
defineProps({ text: { type: String, default: "[[text]]" } })
</script>

<template>
	<p class="m-0 mt-0.5 font-mono text-[10px] leading-tight text-maple-fg-dim">{{ text }}</p>
</template>

<script setup lang="ts">
/** Solid card used for the summary metrics and the ingestion counters. */
defineOptions({ inheritAttrs: false })
</script>

<template>
	<div class="rounded-lg bg-maple-card" v-bind="$attrs"><slot /></div>
</template>

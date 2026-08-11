<script setup lang="ts">
/** Bare arrow + magnitude line, tinted by direction (service rows, ingestion). */
defineOptions({ inheritAttrs: false })
defineProps({
	color: { type: String, default: "[[color]]" },
	arrow: { type: String, default: "[[arrow]]" },
	value: { type: String, default: "[[value]]" },
})
</script>

<template>
	<p class="m-0 font-mono text-[10px] leading-tight" :style="`color:${color}`" v-bind="$attrs">
		{{ arrow }} {{ value }}
	</p>
</template>

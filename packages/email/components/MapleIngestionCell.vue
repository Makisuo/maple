<script setup lang="ts">
/** One ingestion counter (logs / traces / metrics / total bytes). */
defineProps({
	label: { type: String, default: "[[label]]" },
	value: { type: String, default: "[[value]]" },
})
</script>

<template>
	<td class="w-1/4 p-1">
		<MapleTile class="px-3 py-2.5 text-center">
			<MapleSectionLabel class="mb-1">{{ label }}</MapleSectionLabel>
			<p class="m-0 font-mono text-sm font-semibold text-maple-fg">{{ value }}</p>
			[[#ingestionDelta]]
		</MapleTile>
	</td>
</template>

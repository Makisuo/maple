<script setup lang="ts">
/** One of the four headline metrics. */
defineProps({
	label: { type: String, default: "[[label]]" },
	value: { type: String, default: "[[value]]" },
})
</script>

<template>
	<td class="w-1/2 p-1">
		<MapleTile class="px-4 py-3.5">
			<MapleSectionLabel class="mb-1.5">{{ label }}</MapleSectionLabel>
			<p class="m-0 mb-2 font-mono text-[22px] font-semibold leading-none text-maple-fg">{{ value }}</p>
			[[#deltaPill]]
		</MapleTile>
	</td>
</template>

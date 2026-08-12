<script setup lang="ts">
/** Weekday initial under a sparkline column. */
defineProps({ label: { type: String, default: "[[label]]" } })
</script>

<template>
	<td style="text-align: center; padding-top: 6px">
		<p class="m-0 font-mono text-[9px] leading-[24px] text-maple-fg-dim">{{ label }}</p>
	</td>
</template>

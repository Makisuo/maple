<script setup lang="ts">
/** One environment or namespace in the breakdown table. */
defineProps({
	rowBorder: { type: String, default: "[[rowBorder]]" },
	label: { type: String, default: "[[label]]" },
	requests: { type: String, default: "[[requests]]" },
	errRate: { type: String, default: "[[errRate]]" },
	errRateColor: { type: String, default: "[[errRateColor]]" },
})
</script>

<template><tr>
<td class="px-3 py-2 align-middle" :style="`border-bottom:${rowBorder}`"><p class="m-0 font-mono text-[12px] leading-[20px] text-maple-fg">{{ label }}</p></td>
<td class="px-3 py-2 text-right align-middle" :style="`border-bottom:${rowBorder}`"><p class="m-0 font-mono text-[12px] leading-[20px] text-maple-fg-muted">{{ requests }}</p>[[#breakdownDelta]]</td>
<td class="px-3 py-2 text-right align-middle" :style="`border-bottom:${rowBorder}`"><p class="m-0 font-mono text-[12px] leading-[20px]" :style="`color:${errRateColor}`">{{ errRate }}</p></td>
</tr></template>

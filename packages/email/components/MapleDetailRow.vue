<script setup lang="ts">
/** Label/value row in the alert detail table. */
defineProps({
	label: { type: String, default: "[[label]]" },
	value: { type: String, default: "[[value]]" },
	valueColor: { type: String, default: "[[valueColor]]" },
})
</script>

<template><tr>
<td class="w-[110px] px-3 py-2.5 align-top" style="border-bottom:1px solid #302b26"><MapleSectionLabel>{{ label }}</MapleSectionLabel></td>
<td class="px-3 py-2.5 align-top" style="border-bottom:1px solid #302b26"><p class="m-0 font-mono text-[13px] leading-snug" :style="`color:${valueColor}`">{{ value }}</p></td>
</tr></template>

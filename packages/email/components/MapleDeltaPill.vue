<script setup lang="ts">
/** Week-over-week delta chip. Colours are decided at render time. */
defineProps({
	bg: { type: String, default: "[[bg]]" },
	color: { type: String, default: "[[color]]" },
	arrow: { type: String, default: "[[arrow]]" },
	value: { type: String, default: "[[value]]" },
})
</script>

<template><span :style="`display:inline-block;background-color:${bg};color:${color};border-radius:5px;padding:2px 6px;font-size:11px;font-weight:600;line-height:14px`">{{ arrow }} {{ value }}</span></template>

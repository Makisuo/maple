<script setup lang="ts">
/** Successful-request portion of a sparkline bar. Bottom corners square off
    when an error segment sits beneath it. */
defineProps({
	h: { type: String, default: "[[h]]" },
	radiusBottom: { type: String, default: "[[radiusBottom]]" },
})
</script>

<template><div :style="`height:${h}px;background-color:#e8872a;border-top-left-radius:3px;border-top-right-radius:3px;border-bottom-left-radius:${radiusBottom};border-bottom-right-radius:${radiusBottom}`"></div></template>

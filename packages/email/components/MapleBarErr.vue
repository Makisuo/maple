<script setup lang="ts">
/** Error portion of a sparkline bar, stacked under the success portion. */
defineProps({
	h: { type: String, default: "[[h]]" },
	radiusTop: { type: String, default: "[[radiusTop]]" },
})
</script>

<template><div :style="`height:${h}px;background-color:#e85d4a;border-top-left-radius:${radiusTop};border-top-right-radius:${radiusTop};border-bottom-left-radius:3px;border-bottom-right-radius:3px`"></div></template>

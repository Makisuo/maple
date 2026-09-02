<script setup lang="ts">
/** Environment / namespace tag beside a service name. Rendered only when the
    service actually reports one — OTel makes both optional. */
defineProps({
	label: { type: String, default: "[[label]]" },
})
</script>

<template><span style="display:inline-block;background-color:rgba(138,127,114,0.14);color:#8a7f72;border-radius:4px;padding:1px 5px;font-size:9px;font-weight:600;letter-spacing:0.04em;margin-left:6px;vertical-align:middle">{{ label }}</span></template>

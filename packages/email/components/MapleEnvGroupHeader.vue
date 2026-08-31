<script setup lang="ts">
/** Sub-header row inside the service-health table, one per environment. Sits in
    the same `<tbody>` as the service rows so the four columns stay aligned. */
defineProps({
	environment: { type: String, default: "[[environment]]" },
	requests: { type: String, default: "[[requests]]" },
})
</script>

<template><tr>
<td colspan="2" class="px-3 pb-1.5 pt-3 align-middle"><p class="m-0 font-mono text-[10px] font-semibold uppercase leading-[14px] tracking-widest text-maple-fg-muted">{{ environment }}</p></td>
<td colspan="2" class="px-3 pb-1.5 pt-3 text-right align-middle"><p class="m-0 font-mono text-[10px] leading-[14px] text-maple-fg-dim">{{ requests }} reqs</p>[[#groupDelta]]</td>
</tr></template>

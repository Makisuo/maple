<script setup lang="ts">
/** One service in the health table. `rowBorder` is `none` on the last row, so
    the separator never lands against the panel's rounded bottom edge. */
defineProps({
	rowBorder: { type: String, default: "[[rowBorder]]" },
	url: { type: String, default: "[[url]]" },
	dotColor: { type: String, default: "[[dotColor]]" },
	name: { type: String, default: "[[name]]" },
	requests: { type: String, default: "[[requests]]" },
	errRate: { type: String, default: "[[errRate]]" },
	errRateColor: { type: String, default: "[[errRateColor]]" },
	p95: { type: String, default: "[[p95]]" },
})
</script>

<template><tr>
<td class="px-3 py-2.5" :style="`border-bottom:${rowBorder}`"><a :href="url" target="_blank" class="font-mono text-[13px] font-medium text-maple-fg no-underline"><span :style="`color:${dotColor};font-size:9px;margin-right:6px`">&#9679;</span>{{ name }}</a></td>
<td class="px-3 py-2.5 text-right align-middle" :style="`border-bottom:${rowBorder}`"><p class="m-0 font-mono text-[13px] leading-[24px] text-maple-fg-muted">{{ requests }}</p>[[#serviceRequestsDelta]]</td>
<td class="px-3 py-2.5 text-right align-middle" :style="`border-bottom:${rowBorder}`"><p class="m-0 font-mono text-[13px] leading-[24px]" :style="`color:${errRateColor}`">{{ errRate }}</p></td>
<td class="px-3 py-2.5 text-right align-middle" :style="`border-bottom:${rowBorder}`"><p class="m-0 font-mono text-[13px] leading-[24px] text-maple-fg-muted">{{ p95 }}</p></td>
</tr></template>

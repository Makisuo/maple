<script setup lang="ts">
/** 7-day request trend: header row with the total, then the bar chart. */
defineProps({ totalRequests: { type: String, default: "[[totalRequests]]" } })
</script>

<template>
<MapleSection class="px-6 pt-5">
<table class="w-full"><tbody><tr>
<td class="align-middle"><MapleSectionLabel>Requests &middot; 7-day trend</MapleSectionLabel></td>
<td class="text-right align-middle"><p class="m-0 font-mono text-[13px] font-semibold leading-[24px] text-maple-fg">{{ totalRequests }} <span style="font-weight:400">[[#deltaPill]]</span></p></td>
</tr></tbody></table>
<div class="mt-2 rounded-lg border border-solid border-maple-border-subtle bg-maple-card px-3 pb-2 pt-3">
<table class="w-full" style="border-collapse:collapse"><tbody>
<tr>[[#sparkBars]]</tr>
<tr>[[#sparkLabels]]</tr>
</tbody></table>
</div>
</MapleSection>
</template>

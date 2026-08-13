<script setup lang="ts">
/** Top errors block: caption + "View all" link, then the ranked list. */
defineProps({ errorsUrl: { type: String, default: "[[errorsUrl]]" } })
</script>

<template>
<MapleSection class="px-6 pt-5">
<table class="w-full"><tbody><tr>
<td class="align-middle"><MapleSectionLabel>Top Errors</MapleSectionLabel></td>
<td class="text-right align-middle"><a :href="errorsUrl" target="_blank" class="font-mono text-[10px] uppercase tracking-widest text-maple-orange no-underline">View all &rarr;</a></td>
</tr></tbody></table>
<MaplePanel class="mt-2">[[#errorRows]]</MaplePanel>
</MapleSection>
</template>

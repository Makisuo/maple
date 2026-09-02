<script setup lang="ts">
/** One breakdown table — "By environment" or "By namespace". Header cells carry
    their border inline for the same reason MapleServices does. */
defineProps({
	heading: { type: String, default: "[[heading]]" },
})
</script>

<template>
<MapleSection class="px-6 pt-5">
<MapleSectionLabel class="mb-3">{{ heading }}</MapleSectionLabel>
<MaplePanel>
<table class="w-full border-collapse">
<thead><tr>
<th class="px-3 py-2 text-left font-mono text-[10px] font-medium uppercase tracking-widest text-maple-fg-dim" style="border-bottom:1px solid #302b26">Name</th>
<th class="px-3 py-2 text-right font-mono text-[10px] font-medium uppercase tracking-widest text-maple-fg-dim" style="border-bottom:1px solid #302b26">Reqs</th>
<th class="px-3 py-2 text-right font-mono text-[10px] font-medium uppercase tracking-widest text-maple-fg-dim" style="border-bottom:1px solid #302b26">Err%</th>
</tr></thead>
<tbody>[[#breakdownRows]]</tbody>
</table>
</MaplePanel>
</MapleSection>
</template>

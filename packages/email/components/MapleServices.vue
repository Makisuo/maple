<script setup lang="ts">
/** Service health table. Header cells carry the border inline: Tailwind's
    `border-b` sets a width but no style once preflight is off, and
    `border-solid` would paint all four edges. */
</script>

<template>
<MapleSection class="px-6 pt-5">
<MapleSectionLabel class="mb-3">Service Health</MapleSectionLabel>
<MaplePanel>
<table class="w-full border-collapse">
<thead><tr>
<th class="px-3 py-2 text-left font-mono text-[10px] font-medium uppercase tracking-widest text-maple-fg-dim" style="border-bottom:1px solid #302b26">Service</th>
<th class="px-3 py-2 text-right font-mono text-[10px] font-medium uppercase tracking-widest text-maple-fg-dim" style="border-bottom:1px solid #302b26">Reqs</th>
<th class="px-3 py-2 text-right font-mono text-[10px] font-medium uppercase tracking-widest text-maple-fg-dim" style="border-bottom:1px solid #302b26">Err%</th>
<th class="px-3 py-2 text-right font-mono text-[10px] font-medium uppercase tracking-widest text-maple-fg-dim" style="border-bottom:1px solid #302b26">P95</th>
</tr></thead>
<tbody>[[#serviceRows]]</tbody>
</table>
</MaplePanel>
</MapleSection>
</template>

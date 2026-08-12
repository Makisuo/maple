<script setup lang="ts">
/**
 * Alert notification — the page skeleton.
 *
 * `[[accentColor]]` threads the event/severity colour through the divider,
 * the banner's left rule and the event pill; the detail rows are spliced in
 * at `[[#detailRows]]`.
 */
</script>

<template>
<MapleShell>
<MapleHeader title="Maple Alerts" subtitle="Alert notification" />
<MapleDivider accent="[[accentColor]]" />
<MapleSection class="px-5 pt-5">
<div style="border-left:3px solid [[accentColor]];background-color:#262320;border-top-right-radius:8px;border-bottom-right-radius:8px;padding:14px 16px">
<span style="display:inline-block;background-color:[[accentColor]];color:#ffffff;border-radius:5px;padding:3px 8px;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase">[[eventLabel]]</span>
<p class="m-0 mt-2.5 font-mono text-[15px] font-semibold leading-snug text-maple-fg">[[eventEmoji]] [[ruleName]]</p>
<p class="m-0 mt-1 font-mono text-[12px] leading-snug text-maple-fg-muted">[[observedSummary]]</p>
</div>
</MapleSection>
<MapleSection class="px-6 pt-5">
<MaplePanel>
<table class="w-full border-collapse"><tbody>[[#detailRows]]</tbody></table>
</MaplePanel>
</MapleSection>
<MapleSection class="px-6 pb-2 pt-6">
<table class="w-full border-collapse"><tbody><tr>
<td class="w-1/2 pr-1"><MapleCta href="[[linkUrl]]" padding="px-4 py-3">Open in Maple &rarr;</MapleCta></td>
<td class="w-1/2 pl-1"><MapleCta href="[[chatUrl]]" variant="secondary" padding="px-4 py-3">Ask Maple AI</MapleCta></td>
</tr></tbody></table>
</MapleSection>
<MapleFooter>&#127809; Maple Alerts &middot; You are receiving this because this address is an alert destination for your organization.</MapleFooter>
</MapleShell>
</template>

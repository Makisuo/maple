<script setup lang="ts">
/**
 * Weekly digest — the page skeleton.
 *
 * `[[token]]` is a value the runtime interpolates (always HTML-escaped);
 * `[[#slot]]` is a hole the runtime fills with assembled fragments. Everything
 * repeated, optional or colour-variant lives in its own component under
 * components/ and is compiled separately — see scripts/build.ts.
 */
</script>

<template>
<MapleShell>
<MapleHeader title="[[orgName]]" subtitle="">
<template #subtitle>Weekly digest &middot; [[dateStart]] &ndash; [[dateEnd]][[#scopeLine]]</template>
</MapleHeader>
<MapleDivider />
[[#statusBanner]]
[[#sparklineSection]]
<MapleSection class="px-5 pt-4">
<table class="w-full border-collapse"><tbody>
<tr>[[#summaryRowOne]]</tr>
<tr>[[#summaryRowTwo]]</tr>
</tbody></table>
</MapleSection>
[[#breakdownSections]]
[[#servicesSection]]
[[#errorsSection]]
<MapleSection class="px-6 pt-5">
<MapleSectionLabel class="mb-3">[[ingestionHeading]]</MapleSectionLabel>
<table class="w-full border-collapse"><tbody><tr>[[#ingestionCells]]</tr></tbody></table>
</MapleSection>
<MapleSection class="px-6 pb-2 pt-6">
<MapleCta href="[[dashboardUrl]]">Open dashboard &rarr;</MapleCta>
</MapleSection>
<MapleFooter>Powered by <a href="[[baseUrl]]" target="_blank" class="text-maple-fg-muted no-underline">Maple</a> &middot; You subscribed to weekly digests. <a href="[[unsubscribeUrl]]" target="_blank" class="text-maple-fg-muted underline">Unsubscribe</a></MapleFooter>
</MapleShell>
</template>

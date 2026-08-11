<script setup lang="ts">
/** Logo mark plus title/subtitle, shared by both emails. */
defineProps({
	title: { type: String, required: true },
	subtitle: { type: String, default: "" },
})
</script>

<template>
<MapleSection class="px-6 pb-5 pt-6">
<table class="w-full"><tbody><tr>
<td class="w-[36px] pr-3 align-middle"><table cellpadding="0" cellspacing="0" role="presentation"><tbody><tr><td style="width:32px;height:32px;background-color:#e8872a;border-radius:8px;text-align:center;vertical-align:middle;font-family:system-ui, -apple-system, sans-serif;font-size:18px;font-weight:700;color:#ffffff;line-height:32px">M</td></tr></tbody></table></td>
<td class="align-middle">
<p class="m-0 font-mono text-base font-semibold text-maple-fg">{{ title }}</p>
<p class="m-0 mt-0.5 font-mono text-xs text-maple-fg-muted"><slot name="subtitle">{{ subtitle }}</slot></p>
</td>
</tr></tbody></table>
</MapleSection>
</template>

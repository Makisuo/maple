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
<td class="w-[36px] pr-3 align-middle"><MapleBrandMark /></td>
<td class="align-middle">
<p class="m-0 font-mono text-base font-semibold text-maple-fg">{{ title }}</p>
<p class="m-0 mt-0.5 font-mono text-xs text-maple-fg-muted"><slot name="subtitle">{{ subtitle }}</slot></p>
</td>
</tr></tbody></table>
</MapleSection>
</template>

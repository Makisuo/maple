<script setup lang="ts">
/** Names the slice a scoped digest covers, under the header subtitle. */
defineProps({ text: { type: String, default: "[[text]]" } })
</script>

<template><span style="display:inline-block;background-color:rgba(232,135,42,0.14);color:#e8872a;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:600;margin-left:6px;vertical-align:middle">{{ text }}</span></template>

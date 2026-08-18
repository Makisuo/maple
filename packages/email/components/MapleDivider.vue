<script setup lang="ts">
/** Hairline rule that fades from an accent colour into the border colour. */
defineProps({ accent: { type: String, default: "#e8872a" } })
</script>

<template><div class="mx-6 h-px bg-maple-border" :style="`background-image:linear-gradient(to right, ${accent}, #3a342e 40%)`"></div></template>

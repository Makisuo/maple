<script setup lang="ts">
/** react-email's `<Section>`: a full-width presentational table wrapper. */
defineOptions({ inheritAttrs: false })
</script>

<template><table align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" v-bind="$attrs"><tbody><tr><td><slot /></td></tr></tbody></table></template>

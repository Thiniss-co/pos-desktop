<script setup lang="ts">
import AppIcon from '../common/AppIcon.vue'

withDefaults(defineProps<{ id?: string }>(), { id: undefined })
</script>

<template>
  <p
    :id="id"
    class="app-inline-error flex items-start gap-1.5 text-sm font-semibold text-err"
    role="alert"
  >
    <AppIcon name="error" :size="18" class="app-inline-error__icon mt-px" />
    <span><slot /></span>
  </p>
</template>

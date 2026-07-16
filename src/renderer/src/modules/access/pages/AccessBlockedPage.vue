<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useAccessStore } from '../store'

const { reason } = storeToRefs(useAccessStore())
</script>

<template>
  <div class="startup-panel" role="alert">
    <p class="startup-panel__label">Access blocked</p>
    <h2>This workstation cannot continue yet.</h2>
    <p>{{ reason }}</p>
  </div>
</template>

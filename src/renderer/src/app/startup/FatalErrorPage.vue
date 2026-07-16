<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useStartupStore } from './startup.store'

const { error } = storeToRefs(useStartupStore())
</script>

<template>
  <div class="startup-panel" role="alert">
    <p class="startup-panel__label">Startup needs attention</p>
    <h2>The workstation could not prepare its local foundation.</h2>
    <p>{{ error?.message ?? 'Restart the app after resolving the reported problem.' }}</p>
  </div>
</template>

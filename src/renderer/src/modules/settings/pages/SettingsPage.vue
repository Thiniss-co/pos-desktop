<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useStartupStore } from '@renderer/app/startup/startup.store'

const { snapshot } = storeToRefs(useStartupStore())
</script>

<template>
  <section class="shell-page">
    <p class="shell-page__label">Workstation settings</p>
    <h2>Local foundation details</h2>
    <dl v-if="snapshot" class="readiness-list">
      <div>
        <dt>App version</dt>
        <dd>{{ snapshot.runtime.appVersion }}</dd>
      </div>
      <div>
        <dt>API configuration</dt>
        <dd>{{ snapshot.runtime.apiConfiguration }}</dd>
      </div>
      <div>
        <dt>Device state</dt>
        <dd>{{ snapshot.device.isRegistered ? 'registered' : 'not registered' }}</dd>
      </div>
    </dl>
  </section>
</template>

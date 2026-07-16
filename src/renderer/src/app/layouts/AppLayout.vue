<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<template>
  <div class="app-layout">
    <header class="app-layout__header">
      <div>
        <p class="app-layout__eyebrow">Thinis POS</p>
        <strong>Workstation shell</strong>
      </div>
      <span class="app-layout__status">Local-first foundation</span>
    </header>
    <nav class="app-layout__nav" aria-label="Application">
      <RouterLink to="/pos">POS</RouterLink>
      <RouterLink to="/sync">Sync</RouterLink>
      <RouterLink to="/settings">Settings</RouterLink>
    </nav>
    <main class="app-layout__content">
      <slot />
    </main>
  </div>
</template>

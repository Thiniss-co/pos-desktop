<script setup lang="ts"></script>

<template>
  <div class="action-bar flex flex-wrap items-center gap-3 border-t border-line bg-surf px-5 py-3">
    <div class="action-bar__info min-w-[220px] flex-1">
      <slot name="info" />
    </div>
    <div class="action-bar__actions flex flex-wrap gap-2.5">
      <slot />
    </div>
  </div>
</template>

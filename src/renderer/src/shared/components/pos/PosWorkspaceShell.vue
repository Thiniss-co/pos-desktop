<script setup lang="ts"></script>

<template>
  <div class="pos-workspace-shell">
    <header class="pos-workspace-shell__toolbar">
      <slot name="toolbar" />
    </header>
    <div class="pos-workspace-shell__body">
      <main class="pos-workspace-shell__catalog">
        <slot name="catalog" />
      </main>
      <aside class="pos-workspace-shell__cart">
        <slot name="cart" />
      </aside>
    </div>
  </div>
</template>

<style scoped>
.pos-workspace-shell {
  display: grid;
  grid-template-rows: auto 1fr;
  height: 100%;
  min-height: 0;
  gap: var(--space-4);
}

.pos-workspace-shell__toolbar {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.pos-workspace-shell__body {
  display: grid;
  grid-template-columns: 1fr 24rem;
  gap: var(--space-4);
  min-height: 0;
}

.pos-workspace-shell__catalog {
  overflow-y: auto;
}

.pos-workspace-shell__cart {
  min-height: 0;
  border-inline-start: 1px solid var(--color-outline-variant);
  padding-inline-start: var(--space-4);
}

@media (max-width: 1024px) {
  .pos-workspace-shell__body {
    grid-template-columns: 1fr;
  }

  .pos-workspace-shell__cart {
    border-inline-start: none;
    border-block-start: 1px solid var(--color-outline-variant);
    padding-inline-start: 0;
    padding-block-start: var(--space-4);
  }
}
</style>

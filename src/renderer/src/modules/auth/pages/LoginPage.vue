<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useAuthStore } from '../store'

const auth = useAuthStore()
const { error, session } = storeToRefs(auth)
const email = ref('')
const password = ref('')

onMounted(() => void auth.load())
</script>

<template>
  <div class="startup-panel">
    <p class="startup-panel__label">02 / desktop login</p>
    <h2>Sign in is the next controlled step.</h2>
    <p v-if="session?.isAuthenticated">A local session summary is already available.</p>
    <form class="foundation-form" @submit.prevent>
      <label>
        Email
        <input
          v-model="email"
          type="email"
          autocomplete="username"
          placeholder="cashier@example.com"
        />
      </label>
      <label>
        Password
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="••••••••"
        />
      </label>
      <button type="submit" disabled>Login becomes available after activation</button>
    </form>
    <p v-if="error" class="inline-error">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import { useAuthStore } from '../store'

const auth = useAuthStore()
const { error, fieldErrors, isSubmitting, session } = storeToRefs(auth)
const startup = useStartupStore()
const router = useRouter()
const email = ref('')
const password = ref('')

onMounted(() => void auth.load())

function clearPassword(): void {
  password.value = ''
}

onBeforeUnmount(clearPassword)

async function submit(): Promise<void> {
  const succeeded = await auth.login({ email: email.value.trim(), password: password.value })

  clearPassword()

  if (succeeded) {
    await startup.refresh()
    await router.push({ name: startup.state === 'ready' ? 'pos' : 'bootstrap' })
  }
}
</script>

<template>
  <div class="startup-panel">
    <p class="startup-panel__label">02 / desktop login</p>
    <h2>Sign in to this workstation.</h2>
    <p v-if="session?.isAuthenticated">A local session summary is already available.</p>
    <form class="foundation-form" @submit.prevent="submit">
      <label>
        Email
        <input
          v-model="email"
          type="email"
          autocomplete="username"
          placeholder="cashier@example.com"
          required
        />
      </label>
      <label>
        Password
        <input
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="••••••••"
          required
        />
      </label>
      <p v-if="fieldErrors" class="inline-error">
        <span v-for="(messages, field) in fieldErrors" :key="field"
          >{{ field }}: {{ messages.join(', ') }}</span
        >
      </p>
      <button type="submit" :disabled="isSubmitting">
        {{ isSubmitting ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
  </div>
</template>

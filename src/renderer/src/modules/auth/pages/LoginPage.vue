<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useStartupStore } from '@renderer/app/startup/startup.store'
import { useAuthStore } from '../store'

const auth = useAuthStore()
const { error, fieldErrors, isSubmitting, session } = storeToRefs(auth)
const startup = useStartupStore()
const router = useRouter()
const email = ref('')
const password = ref('')
const { t } = useI18n()

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
    <p class="startup-panel__label">{{ t('auth.label') }}</p>
    <h2>{{ t('auth.title') }}</h2>
    <p v-if="session?.isAuthenticated">{{ t('auth.sessionAvailable') }}</p>
    <form class="foundation-form" @submit.prevent="submit">
      <label>
        {{ t('auth.email') }}
        <input
          v-model="email"
          type="email"
          autocomplete="username"
          :placeholder="t('auth.emailPlaceholder')"
          required
        />
      </label>
      <label>
        {{ t('auth.password') }}
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
        {{ isSubmitting ? t('auth.signingIn') : t('auth.signIn') }}
      </button>
    </form>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
  </div>
</template>

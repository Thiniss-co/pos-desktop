<script setup lang="ts">
import { onMounted, reactive } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import type { CreateCompanyUserInput } from '@shared/contracts/company-users.contract'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppCheckbox from '@renderer/shared/components/forms/AppCheckbox.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import { useCompanyUsersStore } from '../store'

const router = useRouter()
const companyUsers = useCompanyUsersStore()
const { access, assignableRoles, error, fieldErrors, isMutating, remainingUsers } =
  storeToRefs(companyUsers)
const form = reactive<CreateCompanyUserInput>({
  name: '',
  email: '',
  password: '',
  roles: [],
  companyRoleIds: []
})
const { t } = useI18n()

onMounted(async () => {
  await companyUsers.loadAccess()

  if (access.value?.canManage) {
    await companyUsers.loadAssignableRoles()
  }
})

function toggleRole(list: string[], value: string, checked: boolean): void {
  const index = list.indexOf(value)
  if (checked && index === -1) {
    list.push(value)
  } else if (!checked && index !== -1) {
    list.splice(index, 1)
  }
}

async function submit(): Promise<void> {
  const created = await companyUsers.create({ ...form })

  if (created) {
    await router.push({ name: 'company-users' })
  }
}
</script>

<template>
  <section class="company-user-form-page">
    <PageHeader :eyebrow="t('companyUsers.label')" :title="t('companyUsers.createTitle')" />
    <p v-if="remainingUsers !== null" class="company-user-form-page__hint">
      {{ t('companyUsers.remainingBeforeChange', { count: remainingUsers }) }}
    </p>
    <AppInlineError v-if="!access?.canManage">{{
      t('companyUsers.noPermissionAdd')
    }}</AppInlineError>

    <form v-else class="company-user-form-page__form" @submit.prevent="submit">
      <AppInput
        v-model.trim="form.name"
        :label="t('companyUsers.name')"
        required
        maxlength="255"
        autocomplete="name"
      />
      <AppInput
        v-model.trim="form.email"
        type="email"
        :label="t('auth.email')"
        required
        maxlength="255"
        autocomplete="email"
      />
      <AppInput
        v-model="form.password"
        type="password"
        :label="t('companyUsers.temporaryPassword')"
        required
        minlength="8"
        maxlength="255"
        autocomplete="new-password"
      />

      <fieldset class="company-user-form-page__roles">
        <legend>{{ t('companyUsers.systemRoles') }}</legend>
        <AppCheckbox
          v-for="role in assignableRoles?.systemRoles"
          :key="role.key"
          :label="role.label"
          :disabled="!role.assignable"
          :model-value="form.roles.includes(role.key)"
          @update:model-value="(checked) => toggleRole(form.roles as string[], role.key, checked)"
        />
      </fieldset>

      <fieldset class="company-user-form-page__roles">
        <legend>{{ t('companyUsers.customRoles') }}</legend>
        <AppCheckbox
          v-for="role in assignableRoles?.companyRoles"
          :key="role.uuid"
          :label="role.name"
          :disabled="!role.isActive"
          :model-value="form.companyRoleIds.includes(role.uuid)"
          @update:model-value="(checked) => toggleRole(form.companyRoleIds, role.uuid, checked)"
        />
      </fieldset>

      <AppInlineError v-if="fieldErrors">
        <span v-for="(messages, field) in fieldErrors" :key="field">
          {{ field }}: {{ messages.join(' ') }}
        </span>
      </AppInlineError>
      <AppInlineError v-if="error">{{ error }}</AppInlineError>

      <AppButton type="submit" :loading="isMutating">{{ t('companyUsers.createUser') }}</AppButton>
    </form>
  </section>
</template>

<style scoped>
.company-user-form-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  max-width: 32rem;
}

.company-user-form-page__hint {
  color: var(--color-on-surface-variant);
  font-size: var(--text-body-sm-size);
}

.company-user-form-page__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.company-user-form-page__roles {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border: 1px solid var(--color-outline);
  border-radius: var(--radius-md);
}

.company-user-form-page__roles legend {
  padding-inline: var(--space-1);
  font-size: var(--text-body-sm-size);
  font-weight: 600;
  color: var(--color-on-surface-variant);
}
</style>

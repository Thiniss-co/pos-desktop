<script setup lang="ts">
import { onMounted, reactive } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type { UpdateCompanyUserInput } from '@shared/contracts/company-users.contract'
import AppButton from '@renderer/shared/components/common/AppButton.vue'
import AppInlineError from '@renderer/shared/components/feedback/AppInlineError.vue'
import AppLoadingSkeleton from '@renderer/shared/components/feedback/AppLoadingSkeleton.vue'
import AppCheckbox from '@renderer/shared/components/forms/AppCheckbox.vue'
import AppInput from '@renderer/shared/components/forms/AppInput.vue'
import PageHeader from '@renderer/shared/components/layout/PageHeader.vue'
import { useCompanyUsersStore } from '../store'

const route = useRoute()
const router = useRouter()
const companyUsers = useCompanyUsersStore()
const { access, assignableRoles, error, fieldErrors, isLoading, isMutating, selectedUser } =
  storeToRefs(companyUsers)
const form = reactive({
  name: '',
  email: '',
  password: '',
  roles: [] as string[],
  companyRoleIds: [] as string[]
})
const { t } = useI18n()

onMounted(async () => {
  const uuid = typeof route.params.uuid === 'string' ? route.params.uuid : ''
  await companyUsers.loadAccess()

  if (!access.value?.canManage) {
    return
  }

  await companyUsers.loadAssignableRoles()
  const user = await companyUsers.get(uuid)

  if (!user) {
    return
  }

  form.name = user.name
  form.email = user.email
  form.roles = user.roles.filter((role) =>
    (assignableRoles.value?.systemRoles ?? []).some((assignableRole) => assignableRole.key === role)
  )
  form.companyRoleIds = (assignableRoles.value?.companyRoles ?? [])
    .filter((role) => user.roles.includes(role.name))
    .map((role) => role.uuid)
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
  if (!selectedUser.value) {
    return
  }

  const input: UpdateCompanyUserInput = {
    uuid: selectedUser.value.uuid,
    name: form.name,
    email: form.email,
    roles: form.roles as UpdateCompanyUserInput['roles'],
    companyRoleIds: form.companyRoleIds
  }

  if (form.password) {
    input.password = form.password
  }

  const updated = await companyUsers.update(input)

  if (updated) {
    await router.push({ name: 'company-users' })
  }
}
</script>

<template>
  <section class="company-user-form-page">
    <PageHeader :eyebrow="t('companyUsers.label')" :title="t('companyUsers.editTitle')" />
    <AppLoadingSkeleton v-if="isLoading" :label="t('companyUsers.loadingUser')" />
    <AppInlineError v-else-if="!access?.canManage">
      {{ t('companyUsers.noPermissionEdit') }}
    </AppInlineError>

    <form v-else-if="selectedUser" class="company-user-form-page__form" @submit.prevent="submit">
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
        :label="t('companyUsers.newPassword')"
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
          @update:model-value="(checked) => toggleRole(form.roles, role.key, checked)"
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

      <AppButton type="submit" :loading="isMutating">{{ t('common.saveChanges') }}</AppButton>
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

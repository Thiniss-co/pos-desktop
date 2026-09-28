<script setup lang="ts">
import { useId } from 'vue'

withDefaults(
  defineProps<{
    modelValue: boolean
    label: string
    disabled?: boolean
    description?: string
    /** Bordered 44px tile (role pickers, "return items to stock"). */
    tile?: boolean
  }>(),
  { disabled: false, description: undefined, tile: false }
)

const emit = defineEmits<{ 'update:modelValue': [boolean] }>()

const inputId = useId()
const descriptionId = useId()
</script>

<template>
  <label
    :for="inputId"
    class="app-checkbox flex items-start gap-3 text-base"
    :class="[
      {
        'app-checkbox--disabled cursor-not-allowed opacity-60': disabled,
        'cursor-pointer': !disabled
      },
      tile ? 'min-h-11 rounded-lg border border-line bg-surf px-4 py-3' : ''
    ]"
  >
    <input
      :id="inputId"
      type="checkbox"
      class="app-checkbox__input mt-0.5 size-5 flex-none accent-pri"
      :checked="modelValue"
      :disabled="disabled"
      :aria-describedby="description ? descriptionId : undefined"
      @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <span class="app-checkbox__text flex min-w-0 flex-col">
      <span class="app-checkbox__label font-semibold">{{ label }}</span>
      <span
        v-if="description"
        :id="descriptionId"
        class="app-checkbox__description text-sm text-muted"
      >
        {{ description }}
      </span>
    </span>
  </label>
</template>

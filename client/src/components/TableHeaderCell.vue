<script setup lang="ts">
import FilterDropdown from "./FilterDropdown.vue";

defineProps<{
  column: string;
  uniqueValues: string[];
  selectedValues: string[];
  isFiltered: boolean;
  isSorted: boolean;
  sortDir: "asc" | "desc" | null;
  isOpen: boolean;
}>();

const emit = defineEmits<{
  toggle: [];
  apply: [values: string[]];
  clear: [];
  sort: [dir: "asc" | "desc"];
}>();
</script>

<template>
  <th class="relative sticky top-0 z-10 whitespace-nowrap border border-gray-200 bg-gray-100 px-2.5 py-2 text-left">
    <span>{{ column }}</span>
    <span v-if="isSorted">{{ sortDir === "asc" ? " ▲" : " ▼" }}</span>
    <button
      type="button"
      class="ml-1 rounded px-1.5 text-xs"
      :class="isFiltered ? 'text-blue-500 font-bold' : 'text-gray-500 hover:bg-gray-200'"
      @click.stop="emit('toggle')"
    >
      &#9662;
    </button>

    <FilterDropdown
      v-if="isOpen"
      :column="column"
      :unique-values="uniqueValues"
      :selected-values="selectedValues"
      @apply="(values: string[]) => emit('apply', values)"
      @clear="emit('clear')"
      @sort="(dir: 'asc' | 'desc') => emit('sort', dir)"
    />
  </th>
</template>

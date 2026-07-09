<script setup lang="ts">
import { ref, computed, toRef, onMounted, onUnmounted } from "vue";
import FilterDropdown from "./FilterDropdown.vue";
import { useTableFilters, cellVal } from "../composables/useTableFilters";
import type { Vehicle } from "../types";

const props = defineProps<{
  rows: Vehicle[];
}>();

const rowsRef = toRef(props, "rows");
const {
  filteredSortedRows,
  sortCol,
  sortDir,
  getUniqueValues,
  isFiltered,
  setFilter,
  clearFilter,
  clearAllFilters,
  setSort,
} = useTableFilters(rowsRef);

const columns = computed(() => (props.rows.length > 0 ? Object.keys(props.rows[0]) : []));
const openCol = ref<string | null>(null);
const tableWrapper = ref<HTMLElement | null>(null);

function toggleDropdown(col: string) {
  openCol.value = openCol.value === col ? null : col;
}

function handleApply(col: string, values: string[]) {
  setFilter(col, values);
  openCol.value = null;
}

function handleClear(col: string) {
  clearFilter(col);
  openCol.value = null;
}

function handleSort(col: string, dir: "asc" | "desc") {
  setSort(col, dir);
  openCol.value = null;
}

function onDocumentClick(e: MouseEvent) {
  if (tableWrapper.value && !tableWrapper.value.contains(e.target as Node)) {
    openCol.value = null;
  }
}

onMounted(() => document.addEventListener("click", onDocumentClick));
onUnmounted(() => document.removeEventListener("click", onDocumentClick));

defineExpose({ clearAllFilters });
</script>

<template>
  <div ref="tableWrapper" class="overflow-x-auto">
    <table v-if="rows.length > 0" class="w-full border-collapse bg-white text-xs">
      <thead>
        <tr>
          <th
            v-for="col in columns"
            :key="col"
            class="relative sticky top-0 z-10 whitespace-nowrap border border-gray-200 bg-gray-100 px-2.5 py-2 text-left"
          >
            <span>{{ col }}</span>
            <span v-if="sortCol === col">{{ sortDir === "asc" ? " ▲" : " ▼" }}</span>
            <button
              type="button"
              class="ml-1 rounded px-1.5 text-xs"
              :class="isFiltered(col) ? 'text-blue-500 font-bold' : 'text-gray-500 hover:bg-gray-200'"
              @click.stop="toggleDropdown(col)"
            >
              &#9662;
            </button>

            <FilterDropdown
              v-if="openCol === col"
              :column="col"
              :unique-values="getUniqueValues(col)"
              :selected-values="Array.from(getUniqueValues(col))"
              @apply="(values) => handleApply(col, values)"
              @clear="handleClear(col)"
              @sort="(dir) => handleSort(col, dir)"
            />
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in filteredSortedRows" :key="row.id ?? i" class="even:bg-gray-50">
          <td v-for="col in columns" :key="col" class="whitespace-nowrap border border-gray-200 px-2.5 py-2">
            {{ cellVal(row[col]) }}
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="text-sm text-gray-500">No rows yet. Upload a file first.</p>
  </div>
</template>

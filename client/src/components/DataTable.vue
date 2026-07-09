<script setup lang="ts">
import { ref, computed, toRef, onMounted, onUnmounted } from "vue";
import TableHeaderCell from "./TableHeaderCell.vue";
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
    <p v-if="rows.length > 0" class="mb-2 text-sm text-gray-500">
      Showing {{ filteredSortedRows.length }} of {{ rows.length }} row(s)
    </p>
    <table v-if="rows.length > 0" class="w-full border-collapse bg-white text-xs">
      <thead>
        <tr>
          <TableHeaderCell
            v-for="col in columns"
            :key="col"
            :column="col"
            :unique-values="getUniqueValues(col)"
            :selected-values="Array.from(getUniqueValues(col))"
            :is-filtered="isFiltered(col)"
            :is-sorted="sortCol === col"
            :sort-dir="sortDir"
            :is-open="openCol === col"
            @toggle="toggleDropdown(col)"
            @apply="(values: string[]) => handleApply(col, values)"
            @clear="handleClear(col)"
            @sort="(dir: 'asc' | 'desc') => handleSort(col, dir)"
          />
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

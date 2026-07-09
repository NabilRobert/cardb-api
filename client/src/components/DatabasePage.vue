<script setup lang="ts">
import { ref, onMounted } from "vue";
import DataTable from "./DataTable.vue";
import AlertBox from "./AlertBox.vue";
import { fetchVehicles } from "../composables/useApi";
import type { Vehicle } from "../types";

const rows = ref<Vehicle[]>([]);
const isLoading = ref(true);
const errorMessage = ref<string | null>(null);
const tableRef = ref<InstanceType<typeof DataTable> | null>(null);

async function load() {
  isLoading.value = true;
  errorMessage.value = null;
  try {
    rows.value = await fetchVehicles();
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
  } finally {
    isLoading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div>
    <h2 class="text-2xl font-semibold mb-4">Database</h2>

    <div class="mb-4 flex items-center gap-3">
      <button
        type="button"
        class="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm hover:bg-gray-50"
        @click="load"
      >
        Refresh
      </button>
      <button
        type="button"
        class="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm hover:bg-gray-50"
        @click="tableRef?.clearAllFilters()"
      >
        Clear all filters
      </button>
    </div>

    <p v-if="isLoading" class="text-sm text-gray-500">Loading...</p>
    <AlertBox v-else-if="errorMessage" variant="error">
      Failed to load: {{ errorMessage }}
    </AlertBox>
    <DataTable v-else ref="tableRef" :rows="rows" />
  </div>
</template>

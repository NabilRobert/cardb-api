<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  rows: Record<string, unknown>[];
}>();

const columns = computed(() => (props.rows.length > 0 ? Object.keys(props.rows[0]) : []));
</script>

<template>
  <table v-if="rows.length > 0" class="w-full border-collapse bg-white text-xs">
    <thead>
      <tr>
        <th v-for="col in columns" :key="col" class="border border-gray-200 bg-gray-100 px-2.5 py-2 text-left">
          {{ col }}
        </th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="(row, i) in rows" :key="i" class="even:bg-gray-50">
        <td v-for="col in columns" :key="col" class="border border-gray-200 px-2.5 py-2">
          {{ row[col] ?? "" }}
        </td>
      </tr>
    </tbody>
  </table>
</template>

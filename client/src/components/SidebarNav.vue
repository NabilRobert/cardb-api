<script setup lang="ts">
defineProps<{
  active: "upload" | "database";
}>();
</script>

<template>
  <div class="w-56 shrink-0 bg-gray-900 text-gray-200 py-6">
    <h1 class="text-white font-semibold text-base px-5 pb-5">DSS Motor Inventory</h1>
    <a
      href="/index.html"
      class="block px-5 py-3 text-sm hover:bg-gray-800 hover:text-white"
      :class="active === 'upload' ? 'bg-gray-800 text-white border-l-2 border-blue-500' : 'text-gray-400'"
    >
      Upload
    </a>
    <a
      href="/database.html"
      class="block px-5 py-3 text-sm hover:bg-gray-800 hover:text-white"
      :class="active === 'database' ? 'bg-gray-800 text-white border-l-2 border-blue-500' : 'text-gray-400'"
    >
      Database
    </a>
  </div>
</template>

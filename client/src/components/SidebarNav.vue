<script setup lang="ts">
import { useRoute } from "vue-router";

const route = useRoute();

function linkClass(path: string) {
  return route.path === path
    ? "bg-gray-800 text-white border-l-2 border-blue-500"
    : "text-gray-400";
}
</script>

<template>
  <div class="w-56 shrink-0 bg-gray-900 text-gray-200 py-6">
    <h1 class="text-white font-semibold text-base px-5 pb-5">DSS Motor Inventory</h1>
    <router-link to="/" class="block px-5 py-3 text-sm hover:bg-gray-800 hover:text-white" :class="linkClass('/')">
      Upload
    </router-link>
    <router-link to="/database" class="block px-5 py-3 text-sm hover:bg-gray-800 hover:text-white" :class="linkClass('/database')">
      Database
    </router-link>
    <router-link to="/ask" class="block px-5 py-3 text-sm hover:bg-gray-800 hover:text-white" :class="linkClass('/ask')">
      Ask AI
    </router-link>
    <router-link to="/api-docs" class="block px-5 py-3 text-sm hover:bg-gray-800 hover:text-white" :class="linkClass('/api-docs')">
      API
    </router-link>
  </div>
</template>

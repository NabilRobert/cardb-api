<script setup lang="ts">
import SidebarNav from "./components/SidebarNav.vue";
</script>

<template>
  <div class="flex min-h-screen bg-gray-100 text-gray-900">
    <SidebarNav />
    <div class="flex-1 p-10">
      <router-view />
    </div>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    variant: "success" | "error" | "warning";
  }>(),
  { variant: "success" }
);

const styles = {
  success: "bg-green-50 text-green-800 border-green-200",
  error: "bg-red-50 text-red-800 border-red-200",
  warning: "bg-amber-50 text-amber-800 border-amber-200",
};
</script>

<template>
  <div class="rounded-lg border p-4 text-sm whitespace-pre-wrap" :class="styles[variant]">
    <slot />
  </div>
</template>

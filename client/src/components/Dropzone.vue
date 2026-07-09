<script setup lang="ts">
import { ref } from "vue";

defineProps<{
  isUploading: boolean;
  uploadingName: string;
}>();

const emit = defineEmits<{
  "file-selected": [file: File];
}>();

const isDragOver = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

function openFileDialog() {
  fileInput.value?.click();
}

function onDrop(e: DragEvent) {
  isDragOver.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (file) emit("file-selected", file);
}

function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) emit("file-selected", file);
}
</script>

<template>
  <div
    class="border-2 border-dashed rounded-xl bg-white text-center py-20 px-5 cursor-pointer transition-colors"
    :class="isDragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300'"
    @click="openFileDialog"
    @dragover.prevent="isDragOver = true"
    @dragleave="isDragOver = false"
    @drop.prevent="onDrop"
  >
    <div class="text-2xl font-semibold text-gray-800">
      {{ isUploading ? `Uploading "${uploadingName}"...` : "Upload here" }}
    </div>
    <div class="text-sm text-gray-400 mt-2">Click or drag an .xlsx file into this box</div>
    <input ref="fileInput" type="file" accept=".xlsx" class="hidden" @change="onFileChange" />
  </div>
</template>

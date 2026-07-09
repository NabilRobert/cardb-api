<script setup lang="ts">
import { ref } from "vue";
import SidebarNav from "./SidebarNav.vue";
import { uploadExcelFile } from "../composables/useApi";
import type { UploadResult } from "../types";

const isDragOver = ref(false);
const isUploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const result = ref<UploadResult | null>(null);
const errorMessage = ref<string | null>(null);
const uploadingName = ref("");

function openFileDialog() {
  fileInput.value?.click();
}

function onDrop(e: DragEvent) {
  isDragOver.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
}

function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) handleFile(file);
}

async function handleFile(file: File) {
  result.value = null;
  errorMessage.value = null;
  isUploading.value = true;
  uploadingName.value = file.name;

  try {
    result.value = await uploadExcelFile(file);
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
  } finally {
    isUploading.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen bg-gray-100 text-gray-900">
    <SidebarNav active="upload" />

    <div class="flex-1 p-10">
      <h2 class="text-2xl font-semibold mb-1">Upload Inventory Excel</h2>
      <p class="text-sm text-gray-500 mb-6">
        Drop an .xlsx file below, or click to choose one. It'll be parsed and inserted straight into the database.
      </p>

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

      <div
        v-if="result"
        class="mt-6 p-5 rounded-lg text-sm whitespace-pre-wrap bg-green-50 text-green-800 border border-green-200"
      >
        Inserted {{ result.inserted }} vehicles (upload_id={{ result.uploadId }}).
        <template v-if="result.skipped.length > 0">
          <br /><br />
          Skipped {{ result.skipped.length }} broken row(s):
          <br />
          <span v-for="s in result.skipped" :key="`${s.sheet}-${s.row}`">
            &nbsp;&nbsp;- {{ s.sheet }} row {{ s.row }}: {{ s.reason }}<br />
          </span>
        </template>
      </div>

      <div
        v-if="errorMessage"
        class="mt-6 p-5 rounded-lg text-sm bg-red-50 text-red-800 border border-red-200"
      >
        Upload failed: {{ errorMessage }}
      </div>
    </div>
  </div>
</template>

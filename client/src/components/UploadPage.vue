<script setup lang="ts">
import { ref } from "vue";
import Dropzone from "./Dropzone.vue";
import AlertBox from "./AlertBox.vue";
import { uploadExcelFile } from "../composables/useApi";
import type { UploadResult } from "../types";

const isUploading = ref(false);
const result = ref<UploadResult | null>(null);
const errorMessage = ref<string | null>(null);
const uploadingName = ref("");

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
  <div>
    <h2 class="text-2xl font-semibold mb-1">Upload Inventory Excel</h2>
    <p class="text-sm text-gray-500 mb-6">
      Drop an .xlsx file below, or click to choose one. It'll be parsed and inserted straight into the database.
    </p>

    <Dropzone :is-uploading="isUploading" :uploading-name="uploadingName" @file-selected="handleFile" />

    <AlertBox v-if="result" variant="success" class="mt-6">
      Inserted {{ result.inserted }} vehicles (upload_id={{ result.uploadId }}).
      <template v-if="result.skipped.length > 0">
        <br /><br />
        Skipped {{ result.skipped.length }} broken row(s):
        <br />
        <span v-for="s in result.skipped" :key="`${s.sheet}-${s.row}`">
          &nbsp;&nbsp;- {{ s.sheet }} row {{ s.row }}: {{ s.reason }}<br />
        </span>
      </template>
    </AlertBox>

    <AlertBox v-if="errorMessage" variant="error" class="mt-6">
      Upload failed: {{ errorMessage }}
    </AlertBox>
  </div>
</template>

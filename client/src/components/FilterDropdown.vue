<script setup lang="ts">
import { ref, computed } from "vue";

const props = defineProps<{
  column: string;
  uniqueValues: string[];
  selectedValues: string[];
}>();

const emit = defineEmits<{
  apply: [values: string[]];
  clear: [];
  sort: [dir: "asc" | "desc"];
  close: [];
}>();

const searchTerm = ref("");
const checked = ref<Set<string>>(new Set(props.selectedValues));

function displayVal(v: string): string {
  return v === "" ? "(Blanks)" : v;
}

const visibleValues = computed(() => {
  const term = searchTerm.value.toLowerCase();
  if (!term) return props.uniqueValues;
  return props.uniqueValues.filter((v) => displayVal(v).toLowerCase().includes(term));
});

const allChecked = computed(() => checked.value.size === props.uniqueValues.length);

function toggleAll(e: Event) {
  const isChecked = (e.target as HTMLInputElement).checked;
  checked.value = isChecked ? new Set(props.uniqueValues) : new Set();
}

function toggleValue(val: string, e: Event) {
  const isChecked = (e.target as HTMLInputElement).checked;
  const next = new Set(checked.value);
  if (isChecked) next.add(val);
  else next.delete(val);
  checked.value = next;
}
</script>

<template>
  <div
    class="absolute z-50 mt-1 w-56 rounded-lg border border-gray-300 bg-white p-2.5 text-xs shadow-lg normal-case font-normal"
    @click.stop
  >
    <div class="flex flex-col gap-1">
      <button
        type="button"
        class="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-gray-100"
        @click="emit('sort', 'asc')"
      >
        Sort A &rarr; Z
      </button>
      <button
        type="button"
        class="w-full rounded px-2 py-1.5 text-left text-xs hover:bg-gray-100"
        @click="emit('sort', 'desc')"
      >
        Sort Z &rarr; A
      </button>
    </div>

    <hr class="my-2 border-gray-200" />

    <input
      v-model="searchTerm"
      type="text"
      placeholder="Search values..."
      class="mb-2 w-full rounded border border-gray-300 px-2 py-1.5 text-xs"
    />

    <label class="mb-1.5 flex items-center gap-1.5 border-b border-gray-200 pb-1.5 font-semibold">
      <input type="checkbox" :checked="allChecked" @change="toggleAll" />
      (All)
    </label>

    <div class="max-h-44 overflow-y-auto flex flex-col gap-1">
      <label
        v-for="val in visibleValues"
        :key="val"
        class="flex items-center gap-1.5 font-normal break-words"
      >
        <input type="checkbox" :checked="checked.has(val)" @change="toggleValue(val, $event)" />
        {{ displayVal(val) }}
      </label>
    </div>

    <div class="mt-2.5 flex gap-2">
      <button
        type="button"
        class="flex-1 rounded border border-gray-300 px-2 py-1.5 text-xs hover:bg-gray-100"
        @click="emit('apply', Array.from(checked))"
      >
        Apply
      </button>
      <button
        type="button"
        class="flex-1 rounded border border-gray-300 px-2 py-1.5 text-xs hover:bg-gray-100"
        @click="emit('clear')"
      >
        Clear filter
      </button>
    </div>
  </div>
</template>

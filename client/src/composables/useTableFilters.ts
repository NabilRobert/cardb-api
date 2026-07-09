/**
 * useTableFilters.ts
 *
 * Pure filtering/sorting logic for the data table, kept separate from any
 * rendering. No DOM access here -- just reactive state and derived data.
 * Components consume `filteredSortedRows` and call the exposed functions;
 * they never touch `filters`/`sortCol` internals directly.
 */

import { ref, computed, type Ref } from "vue";
import type { Vehicle } from "../types";

export type SortDir = "asc" | "desc" | null;

export function cellVal(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

export function useTableFilters(rows: Ref<Vehicle[]>) {
  const filters = ref<Record<string, Set<string>>>({});
  const sortCol = ref<string | null>(null);
  const sortDir = ref<SortDir>(null);

  function getUniqueValues(col: string): string[] {
    return Array.from(new Set(rows.value.map((r) => cellVal(r[col]))))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  }

  function isFiltered(col: string): boolean {
    return !!filters.value[col];
  }

  function setFilter(col: string, selectedValues: string[]) {
    const unique = getUniqueValues(col);
    if (selectedValues.length === unique.length) {
      clearFilter(col);
      return;
    }
    filters.value = { ...filters.value, [col]: new Set(selectedValues) };
  }

  function clearFilter(col: string) {
    const next = { ...filters.value };
    delete next[col];
    filters.value = next;
  }

  function clearAllFilters() {
    filters.value = {};
    sortCol.value = null;
    sortDir.value = null;
  }

  function setSort(col: string, dir: SortDir) {
    sortCol.value = col;
    sortDir.value = dir;
  }

  const filteredSortedRows = computed<Vehicle[]>(() => {
    let result = rows.value.filter((row) => {
      for (const col in filters.value) {
        if (!filters.value[col].has(cellVal(row[col]))) return false;
      }
      return true;
    });

    if (sortCol.value) {
      const col = sortCol.value;
      const dir = sortDir.value;
      result = result.slice().sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        let cmp: number;
        if (typeof av === "number" && typeof bv === "number") {
          cmp = av - bv;
        } else {
          cmp = cellVal(av).localeCompare(cellVal(bv), undefined, { numeric: true, sensitivity: "base" });
        }
        return dir === "desc" ? -cmp : cmp;
      });
    }

    return result;
  });

  return {
    filters,
    sortCol,
    sortDir,
    filteredSortedRows,
    getUniqueValues,
    isFiltered,
    setFilter,
    clearFilter,
    clearAllFilters,
    setSort,
  };
}

import { createRouter, createWebHistory } from "vue-router";
import UploadPage from "./components/UploadPage.vue";
import DatabasePage from "./components/DatabasePage.vue";
import AskPage from "./components/AskPage.vue";
import ApiDocsPage from "./components/ApiDocsPage.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: UploadPage },
    { path: "/database", component: DatabasePage },
    { path: "/ask", component: AskPage },
    { path: "/api-docs", component: ApiDocsPage },
  ],
});

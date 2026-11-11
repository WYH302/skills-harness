import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests',testMatch:'ui.spec.ts',workers:1,retries:0,reporter:'list',outputDir:'test-results'});

import {defineConfig} from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

// Deliberately include .mjs source in the official recommended local audit.
// The Community directory scanner has a different scope; this is not its result.
export default defineConfig([...obsidianmd.configs.recommended]);

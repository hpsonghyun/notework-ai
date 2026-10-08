import {hasAsciiControl} from './text-safety.mjs';
export const DEFAULT_ARCHIVE_FOLDER = 'Notework/Chats';
function invalidPath(message) {return Object.assign(new Error(message), {code: 'ARCHIVE_INVALID_PATH'});}

/** Pure browser-safe validation shared by archive storage and its settings UI. */
export function relativePath(value, {folder = false} = {}) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.trim() !== value || (hasAsciiControl(value)||/[\\:]/u.test(value))) throw invalidPath('Use a relative path inside the current vault.');
  const parts = value.split('/');
  if (parts.some(part => !part || part.startsWith('.') || part.trim() !== part || /[<>"?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw invalidPath('Use a visible folder inside the current vault, without absolute or traversing paths.');
  if (!folder && !value.toLowerCase().endsWith('.md')) throw invalidPath('Choose a Markdown conversation file.');
  return value;
}

/** Canonical vault-relative path; hidden directories and Windows path tricks are rejected. */
export function normalizeArchiveFolder(value = DEFAULT_ARCHIVE_FOLDER) {return relativePath(value, {folder: true});}

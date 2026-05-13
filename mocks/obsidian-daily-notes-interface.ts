import { vi } from "vitest";

export const getAllDailyNotes = vi.fn(() => ({}));
export const getDailyNote = vi.fn(() => null);
export const createDailyNote = vi.fn(() => Promise.resolve(null));

export const getAllWeeklyNotes = vi.fn(() => ({}));
export const getWeeklyNote = vi.fn(() => null);
export const createWeeklyNote = vi.fn(() => Promise.resolve(null));

export const getAllMonthlyNotes = vi.fn(() => ({}));
export const getMonthlyNote = vi.fn(() => null);
export const createMonthlyNote = vi.fn(() => Promise.resolve(null));

export const getAllQuarterlyNotes = vi.fn(() => ({}));
export const getQuarterlyNote = vi.fn(() => null);
export const createQuarterlyNote = vi.fn(() => Promise.resolve(null));

export const getAllYearlyNotes = vi.fn(() => ({}));
export const getYearlyNote = vi.fn(() => null);
export const createYearlyNote = vi.fn(() => Promise.resolve(null));

export const appHasDailyNotesPluginLoaded = vi.fn(() => false);
export const appHasWeeklyNotesPluginLoaded = vi.fn(() => false);
export const appHasMonthlyNotesPluginLoaded = vi.fn(() => false);
export const appHasQuarterlyNotesPluginLoaded = vi.fn(() => false);
export const appHasYearlyNotesPluginLoaded = vi.fn(() => false);

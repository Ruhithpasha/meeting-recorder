import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest globals are off, so Testing Library can't register its auto-cleanup: do it explicitly.
afterEach(cleanup);

// jsdom has no ResizeObserver; Radix (shadcn Switch) measures its thumb with one.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

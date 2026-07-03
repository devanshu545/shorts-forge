import { createClientOnlyFn } from "@tanstack/react-start";

export const loadShortsSafeTools = createClientOnlyFn(() => import("@/lib/shorts-safe.client"));
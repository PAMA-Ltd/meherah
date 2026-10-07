"use client";

import { useAuth } from "@clerk/nextjs";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

/**
 * Cosmetic plan gate for AI surfaces, including complimentary access.
 * Convex (`hasAiAccess`) is the authoritative enforcement.
 */
export function useAiAccess(): { isLoaded: boolean; hasAccess: boolean } {
  const { isLoaded, isSignedIn } = useAuth();
  const org = useQuery(api.organizations.current, isSignedIn ? {} : "skip");
  const loaded = isLoaded && (!isSignedIn || org !== undefined);
  return {
    isLoaded: loaded,
    hasAccess: loaded && (org?.plan === "pro" || org?.plan === "enterprise"),
  };
}

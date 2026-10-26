import { createFileRoute, redirect } from "@tanstack/react-router";

import { SpecsPage } from "../specs/SpecsPage";

export interface SpecsRouteSearch {
  environment?: string;
  project?: string;
  slug?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const Route = createFileRoute("/specs")({
  validateSearch: (search: Record<string, unknown>): SpecsRouteSearch => {
    const environment = optionalString(search.environment);
    const project = optionalString(search.project);
    const slug = optionalString(search.slug);
    return {
      ...(environment ? { environment } : {}),
      ...(project ? { project } : {}),
      ...(slug ? { slug } : {}),
    };
  },
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: SpecsPage,
});

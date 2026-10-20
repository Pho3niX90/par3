import type { StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { SpecDetailScreen } from "./SpecDetailScreen";
import { SpecEditorScreen } from "./SpecEditorScreen";
import { SpecsListScreen } from "./SpecsListScreen";

type ProjectSpecsParams = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
};

export function ProjectSpecsRouteScreen({ route }: StaticScreenProps<ProjectSpecsParams>) {
  return (
    <SpecsListScreen
      environmentId={route.params.environmentId}
      projectId={route.params.projectId}
    />
  );
}

export function SpecDetailRouteScreen({
  route,
}: StaticScreenProps<ProjectSpecsParams & { readonly slug: string }>) {
  return (
    <SpecDetailScreen
      environmentId={route.params.environmentId}
      projectId={route.params.projectId}
      slug={route.params.slug}
    />
  );
}

export function SpecEditorRouteScreen({
  route,
}: StaticScreenProps<
  ProjectSpecsParams & { readonly slug?: string; readonly mode: "create" | "edit" }
>) {
  return (
    <SpecEditorScreen
      environmentId={route.params.environmentId}
      projectId={route.params.projectId}
      slug={route.params.slug}
      mode={route.params.mode}
    />
  );
}

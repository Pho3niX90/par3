import { useNavigation } from "@react-navigation/native";

/** Opens the merge conflict sheet for a thread; both platforms' git entry points call this. */
export function useOpenMergeConflicts(input: {
  readonly environmentId: string;
  readonly threadId: string;
}) {
  const navigation = useNavigation();
  return () =>
    navigation.navigate("MergeConflicts", {
      environmentId: String(input.environmentId),
      threadId: String(input.threadId),
    });
}

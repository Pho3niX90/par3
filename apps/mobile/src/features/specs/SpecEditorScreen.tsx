import React, { useState, useEffect } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { useSpecDetail, useSpecMutations } from "../../state/specs";

export interface SpecEditorScreenProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly slug?: string;
  readonly mode: "create" | "edit";
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function SpecEditorScreen(props: SpecEditorScreenProps) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const styles = useMarkdownPreviewStyles();

  const isEditing = props.mode === "edit" && Boolean(props.slug);

  const { detail: existingSpec } = useSpecDetail(
    props.environmentId,
    props.projectId,
    props.slug ?? null,
  );
  const { runMutation } = useSpecMutations(props.environmentId, props.projectId);

  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [content, setContent] = useState("");
  const [supersedes, setSupersedes] = useState("");
  const [previewMode, setPreviewMode] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (existingSpec && isEditing) {
      setTitle(existingSpec.title);
      setSlug(existingSpec.slug);
      setContent(existingSpec.content);
      if (existingSpec.supersedes) {
        setSupersedes(existingSpec.supersedes);
      }
    }
  }, [existingSpec, isEditing]);

  const handleTitleChange = (newTitle: string) => {
    setTitle(newTitle);
    if (!isEditing && (!slug || slug === slugify(title))) {
      setSlug(slugify(newTitle));
    }
  };

  const handleSave = async () => {
    const trimmedTitle = title.trim();
    const trimmedSlug = slug.trim();
    if (!trimmedTitle) {
      Alert.alert("Title required", "Please provide a spec title.");
      return;
    }
    if (!trimmedSlug) {
      Alert.alert("Slug required", "Please provide a slug identifier for the spec.");
      return;
    }

    setIsSaving(true);
    try {
      if (isEditing && existingSpec) {
        await runMutation(existingSpec.slug, existingSpec.revision, {
          action: "update",
          title: trimmedTitle,
          content,
        });
        navigation.goBack();
      } else {
        await runMutation(trimmedSlug, 0, {
          action: "create",
          title: trimmedTitle,
          content,
          ...(supersedes.trim() ? { supersedes: supersedes.trim() } : {}),
        });
        navigation.goBack();
      }
    } catch (err: any) {
      Alert.alert("Failed to save spec", err?.message ?? "An error occurred while saving.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      className="flex-1 bg-sheet"
    >
      <View className="px-4 py-3 border-b border-border-subtle bg-surface flex-row items-center justify-between">
        <Pressable
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
          className="p-1 -ml-1 active:opacity-70"
        >
          <Text className="text-sm font-t3-medium text-foreground-muted">Cancel</Text>
        </Pressable>

        <Text className="text-base font-t3-bold text-foreground">
          {isEditing ? "Edit Spec" : "New Spec"}
        </Text>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save Spec"
          disabled={isSaving}
          onPress={handleSave}
          className="rounded-full bg-accent px-4 py-1.5 active:opacity-80"
        >
          <Text className="text-sm font-t3-semibold text-accent-foreground">
            {isSaving ? "Saving..." : "Save"}
          </Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 24) + 24,
          paddingHorizontal: 16,
          paddingTop: 16,
          gap: 16,
        }}
      >
        {/* Title */}
        <View className="gap-1.5">
          <Text className="text-xs font-t3-semibold text-foreground-muted">Title</Text>
          <AppTextInput
            accessibilityLabel="Spec title"
            placeholder="e.g. Spec mode implementation"
            className="rounded-xl border border-border-subtle bg-surface px-3 py-2.5 text-base text-foreground"
            value={title}
            onChangeText={handleTitleChange}
          />
        </View>

        {/* Slug */}
        <View className="gap-1.5">
          <Text className="text-xs font-t3-semibold text-foreground-muted">Slug (identifier)</Text>
          <AppTextInput
            accessibilityLabel="Spec slug"
            placeholder="e.g. spec-mode"
            editable={!isEditing}
            autoCapitalize="none"
            className={`rounded-xl border border-border-subtle bg-surface px-3 py-2.5 text-sm font-mono text-foreground ${
              isEditing ? "opacity-60" : ""
            }`}
            value={slug}
            onChangeText={setSlug}
          />
        </View>

        {/* Supersedes */}
        {!isEditing && (
          <View className="gap-1.5">
            <Text className="text-xs font-t3-semibold text-foreground-muted">
              Supersedes (optional slug)
            </Text>
            <AppTextInput
              accessibilityLabel="Supersedes spec slug"
              placeholder="e.g. legacy-spec"
              autoCapitalize="none"
              className="rounded-xl border border-border-subtle bg-surface px-3 py-2.5 text-sm font-mono text-foreground"
              value={supersedes}
              onChangeText={setSupersedes}
            />
          </View>
        )}

        {/* Content Section with Edit / Preview Switch */}
        <View className="gap-2">
          <View className="flex-row items-center justify-between">
            <Text className="text-xs font-t3-semibold text-foreground-muted">
              Requirements (Markdown)
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setPreviewMode(!previewMode)}
              className="flex-row items-center gap-1 px-2 py-1 rounded-md bg-subtle active:opacity-80"
            >
              <SymbolView
                name={previewMode ? "pencil" : "eye"}
                size={12}
                tintColorClassName="text-foreground"
              />
              <Text className="text-xs font-t3-medium text-foreground">
                {previewMode ? "Edit" : "Preview"}
              </Text>
            </Pressable>
          </View>

          {previewMode ? (
            <View className="rounded-xl border border-border-subtle bg-surface p-4 min-h-[240px]">
              <SelectableMarkdownText
                markdown={content || "_No content to preview._"}
                textStyle={styles.nativeTextStyle}
              />
            </View>
          ) : (
            <AppTextInput
              accessibilityLabel="Requirements markdown content"
              placeholder="# Requirements&#10;&#10;Describe user stories, constraints, acceptance criteria..."
              multiline
              textAlignVertical="top"
              className="rounded-xl border border-border-subtle bg-surface p-3 text-sm text-foreground min-h-[240px]"
              value={content}
              onChangeText={setContent}
            />
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

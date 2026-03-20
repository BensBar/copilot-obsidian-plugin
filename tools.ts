import { App, MarkdownView, TFile, Notice } from "obsidian";

// ─── Tool Definitions ──────────────────────────────────────────────────────
// These are passed to the Copilot SDK session so the agent can interact
// with the Obsidian vault programmatically.

export function buildVaultTools(app: App, getActiveMarkdownView?: () => MarkdownView | null) {
  const resolveActiveView = (): MarkdownView | null => {
    // 1. Use the plugin's tracked last-focused view (survives focus moving to chat panel)
    const tracked = getActiveMarkdownView?.();
    if (tracked?.file) return tracked;

    // 2. Try the workspace's current active view (works if something else is focused)
    const active = app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file) return active;

    // 3. Last resort: find any open markdown leaf via getLeavesOfType (reliable Obsidian API)
    const leaves = app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      if (leaf.view instanceof MarkdownView && leaf.view.file) {
        return leaf.view;
      }
    }
    return null;
  };

  return [
    // ── Read active note ──────────────────────────────────────────────────
    {
      name: "read_active_note",
      description:
        "Read the full content of the currently open/active note in Obsidian. Use this to understand what the user is currently working on.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [],
      },
      handler: () => {
        const view = resolveActiveView();
        if (!view) {
          return { error: "No active note is open", content: null };
        }
        const file = view.file;
        if (!file) return { error: "Could not resolve file", content: null };
        // Use editor.getValue() — synchronous, no async needed for an open note
        const content = view.editor?.getValue() ?? "";
        return {
          filename: file.name,
          path: file.path,
          content,
          wordCount: content.split(/\s+/).filter(Boolean).length,
        };
      },
    },

    // ── Read note by path ─────────────────────────────────────────────────
    {
      name: "read_note_by_path",
      description:
        "Read the content of a specific note by its vault path (e.g., 'Customers/Vanguard.md'). Use this when the user references a specific note.",
      parameters: {
        type: "object" as const,
        properties: {
          path: {
            type: "string",
            description: "The vault-relative path to the note, e.g. 'Folder/Note.md'",
          },
        },
        required: ["path"],
      },
      handler: async (args: { path: string }) => {
        const file = app.vault.getAbstractFileByPath(args.path);
        if (!file || !(file instanceof TFile)) {
          return { error: `Note not found at path: ${args.path}` };
        }
        const content = await app.vault.read(file as TFile);
        return { path: args.path, content };
      },
    },

    // ── Append to active note ─────────────────────────────────────────────
    {
      name: "append_to_active_note",
      description:
        "Append markdown content to the end of the currently active note. Use this when the user asks you to add something to their note.",
      parameters: {
        type: "object" as const,
        properties: {
          content: {
            type: "string",
            description: "The markdown content to append",
          },
          addDivider: {
            type: "boolean",
            description: "Whether to add a horizontal rule (---) before the content",
          },
        },
        required: ["content"],
      },
      handler: (args: { content: string; addDivider?: boolean }) => {
        const view = resolveActiveView();
        if (!view?.file) return { error: "No active note open" };

        // Use editor to read + write synchronously for an open note
        const existing = view.editor?.getValue() ?? "";
        const divider = args.addDivider ? "\n\n---\n\n" : "\n\n";
        view.editor?.setValue(existing + divider + args.content);
        new Notice("✅ Copilot appended to note");
        return { success: true, appended: args.content.length + " chars" };
      },
    },

    // ── Create new note ───────────────────────────────────────────────────
    {
      name: "create_note",
      description:
        "Create a new note in the vault with specified content. Use this when the user asks you to create or generate a new note.",
      parameters: {
        type: "object" as const,
        properties: {
          title: {
            type: "string",
            description: "The title/filename of the note (without .md extension)",
          },
          content: {
            type: "string",
            description: "The full markdown content of the note",
          },
          folder: {
            type: "string",
            description:
              "Optional vault folder path to create the note in, e.g. 'Customers'. Defaults to root.",
          },
          openAfterCreate: {
            type: "boolean",
            description: "Whether to open the note after creating it",
          },
        },
        required: ["title", "content"],
      },
      handler: async (args: {
        title: string;
        content: string;
        folder?: string;
        openAfterCreate?: boolean;
      }) => {
        const folder = args.folder ?? "";
        const path = folder
          ? `${folder}/${args.title}.md`
          : `${args.title}.md`;

        // Ensure folder exists
        if (folder && !app.vault.getAbstractFileByPath(folder)) {
          await app.vault.createFolder(folder);
        }

        const file = await app.vault.create(path, args.content);
        if (args.openAfterCreate !== false) {
          await app.workspace.getLeaf(false).openFile(file);
        }
        new Notice(`✅ Created: ${args.title}`);
        return { success: true, path };
      },
    },

    // ── Search vault ──────────────────────────────────────────────────────
    {
      name: "search_vault",
      description:
        "Search the vault for notes by filename or content keyword. Returns a list of matching note paths.",
      parameters: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Keyword or phrase to search for",
          },
          searchContent: {
            type: "boolean",
            description: "If true, searches note content. If false, only filenames.",
          },
          limit: {
            type: "number",
            description: "Max number of results to return (default 10)",
          },
        },
        required: ["query"],
      },
      handler: async (args: {
        query: string;
        searchContent?: boolean;
        limit?: number;
      }) => {
        const limit = args.limit ?? 10;
        const query = args.query.toLowerCase();
        const allFiles = app.vault.getMarkdownFiles();
        const results: { path: string; snippet?: string }[] = [];

        for (const file of allFiles) {
          if (results.length >= limit) break;

          // Filename match
          if (file.name.toLowerCase().includes(query)) {
            results.push({ path: file.path });
            continue;
          }

          // Content match
          if (args.searchContent) {
            const content = await app.vault.cachedRead(file);
            const idx = content.toLowerCase().indexOf(query);
            if (idx !== -1) {
              const snippet = content.slice(Math.max(0, idx - 60), idx + 120).trim();
              results.push({ path: file.path, snippet });
            }
          }
        }

        return {
          query: args.query,
          count: results.length,
          results,
        };
      },
    },

    // ── List vault structure ──────────────────────────────────────────────
    {
      name: "list_vault_structure",
      description:
        "List the folders and top-level notes in the vault, or within a specific folder. Useful to orient yourself in the user's knowledge base.",
      parameters: {
        type: "object" as const,
        properties: {
          folderPath: {
            type: "string",
            description: "Folder path to list. Omit for root.",
          },
        },
        required: [],
      },
      handler: async (args: { folderPath?: string }) => {
        const root = args.folderPath ?? "/";
        const folder =
          root === "/"
            ? app.vault.getRoot()
            : app.vault.getAbstractFileByPath(root);

        if (!folder) return { error: `Folder not found: ${root}` };

        // @ts-ignore - Obsidian TFolder has children
        const children = (folder as any).children ?? [];
        const items = children.map((child: any) => ({
          name: child.name,
          type: child instanceof TFile ? "file" : "folder",
          path: child.path,
        }));

        return { folder: root, items };
      },
    },

    // ── Get note metadata ─────────────────────────────────────────────────
    {
      name: "get_note_metadata",
      description:
        "Get the frontmatter/YAML metadata and tags for the active note or a note by path.",
      parameters: {
        type: "object" as const,
        properties: {
          path: {
            type: "string",
            description: "Optional path. Defaults to active note.",
          },
        },
        required: [],
      },
      handler: async (args: { path?: string }) => {
        let file: TFile | null = null;

        if (args.path) {
          const f = app.vault.getAbstractFileByPath(args.path);
          if (f instanceof TFile) file = f;
        } else {
          const view = resolveActiveView();
          file = view?.file ?? null;
        }

        if (!file) return { error: "No note found" };

        const cache = app.metadataCache.getFileCache(file);
        return {
          path: file.path,
          frontmatter: cache?.frontmatter ?? {},
          tags: cache?.tags?.map((t) => t.tag) ?? [],
          links: cache?.links?.map((l) => l.link) ?? [],
        };
      },
    },
  ];
}

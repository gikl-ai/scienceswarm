"use client";

import {
  forwardRef,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type TextareaHTMLAttributes,
} from "react";

export interface MentionFile {
  /** Display name (basename). */
  name: string;
  /** Full workspace path or gbrain handle used as the durable reference. */
  path: string;
  source?: "workspace" | "gbrain";
  brainSlug?: string;
}

export interface SlashCommandOption {
  command: string;
  description: string;
  argumentHint?: string | null;
  emoji?: string | null;
  kind?: "builtin" | "skill";
  skillSlug?: string | null;
}

const MAX_VISIBLE = 8;

/**
 * Given the current textarea value and caret position, returns the active
 * mention query (the characters after the most recent `@`) if one is in
 * progress, or null when no mention trigger is active.
 *
 * The trigger is only valid when the `@` is at the start of the input or
 * immediately follows whitespace, and no whitespace has been typed since.
 */
export function getActiveMention(
  value: string,
  caret: number,
): { query: string; start: number } | null {
  if (caret <= 0) return null;
  // Scan backwards from caret for an `@`, stopping at whitespace.
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === "@") {
      const prev = i === 0 ? " " : value[i - 1];
      if (prev === undefined || /\s/.test(prev)) {
        return { query: value.slice(i + 1, caret), start: i };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

export function getActiveSlashCommand(
  value: string,
  caret: number,
): { query: string; start: number } | null {
  const beforeCaret = value.slice(0, caret);
  const lineStart = beforeCaret.lastIndexOf("\n") + 1;
  const linePrefix = beforeCaret.slice(lineStart);
  const nonWhitespaceIndex = linePrefix.search(/\S/);
  if (nonWhitespaceIndex === -1) {
    return null;
  }

  const commandStart = lineStart + nonWhitespaceIndex;
  if (value[commandStart] !== "/") {
    return null;
  }

  const query = value.slice(commandStart + 1, caret);
  if (/\s/.test(query)) {
    return null;
  }

  return { query, start: commandStart };
}

interface ChatMentionInputProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "onChange"
> {
  value: string;
  onValueChange: (next: string) => void;
  mentionFiles: MentionFile[];
  slashCommands?: SlashCommandOption[];
  slashCommandsLoading?: boolean;
  onMentionSelect?: (file: MentionFile) => void;
  onSlashCommandSelect?: (command: SlashCommandOption) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

function getMentionDisplayToken(file: MentionFile): string {
  const label = (file.name || file.path).trim();
  return label.replace(/\s+/g, "_");
}

export const ChatMentionInput = forwardRef<
  HTMLTextAreaElement,
  ChatMentionInputProps
>(function ChatMentionInput(
  {
    value,
    onValueChange,
    mentionFiles,
    slashCommands = [],
    slashCommandsLoading = false,
    onMentionSelect,
    onSlashCommandSelect,
    onKeyDown,
    ...textareaProps
  },
  forwardedRef,
) {
  const internalRef = useRef<HTMLTextAreaElement | null>(null);
  const listboxId = useId();

  const setRefs = useCallback(
    (node: HTMLTextAreaElement | null) => {
      internalRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );

  const [caret, setCaret] = useState(0);
  const [rawActiveIndex, setActiveIndex] = useState(0);
  // Tracks the mention-start position the user last dismissed the dropdown
  // at (via Escape, blur, or inserting a selection). Cleared in both the
  // textarea onChange handler and the caret sync handler when the active
  // mention either disappears or moves to a different start position, so
  // the next `@` trigger — whether via typing or caret-only navigation to
  // a separate `@` token — re-opens the dropdown. Keeping the clear logic
  // in event handlers (not render/effect) avoids cascading setState.
  const [dismissedMentionAt, setDismissedMentionAt] = useState<number | null>(
    null,
  );
  const [dismissedSlashAt, setDismissedSlashAt] = useState<number | null>(null);

  const mention = useMemo(() => getActiveMention(value, caret), [value, caret]);
  const mentionStart = mention?.start ?? null;
  const slash = useMemo(
    () => getActiveSlashCommand(value, caret),
    [value, caret],
  );
  const slashStart = slash?.start ?? null;

  const filtered = useMemo(() => {
    if (!mention) return [] as MentionFile[];
    const q = mention.query.toLowerCase();
    const matches = mentionFiles.filter((f) => {
      const label = (f.name || f.path).toLowerCase();
      const reference = f.path.toLowerCase();
      return q.length === 0 ? true : label.includes(q) || reference.includes(q);
    });
    return matches.slice(0, 64); // hard cap; dropdown shows MAX_VISIBLE with scroll
  }, [mention, mentionFiles]);

  const filteredSlashCommands = useMemo(() => {
    if (!slash) return [] as SlashCommandOption[];
    const query = slash.query.toLowerCase();
    const matches = slashCommands.filter((command) => {
      const commandName = command.command.toLowerCase();
      const description = command.description.toLowerCase();
      const skillSlug = command.skillSlug?.toLowerCase() ?? "";
      return query.length === 0
        ? true
        : commandName.includes(query) ||
            description.includes(query) ||
            skillSlug.includes(query);
    });
    return matches.slice(0, 64);
  }, [slash, slashCommands]);

  // Derived: dropdown is open when we have a valid mention + matches, and
  // the user hasn't explicitly dismissed this particular mention trigger.
  const open =
    Boolean(mention) &&
    filtered.length > 0 &&
    dismissedMentionAt !== mentionStart;
  const slashOpen =
    Boolean(slash) &&
    (filteredSlashCommands.length > 0 || slashCommandsLoading) &&
    dismissedSlashAt !== slashStart;
  const activeOptionCount = open
    ? filtered.length
    : slashOpen
      ? Math.max(filteredSlashCommands.length, slashCommandsLoading ? 1 : 0)
      : 0;

  // Derived: clamp the active index to the visible range without storing
  // the clamped value in state. When the filtered list shrinks or the
  // dropdown closes, the effective index collapses to 0.
  const activeIndex =
    activeOptionCount === 0
      ? 0
      : rawActiveIndex >= activeOptionCount
        ? 0
        : rawActiveIndex;

  const insertSelection = useCallback(
    (file: MentionFile) => {
      if (!mention) return;
      const before = value.slice(0, mention.start);
      const after = value.slice(caret);
      const inserted = `@${getMentionDisplayToken(file)} `;
      const next = `${before}${inserted}${after}`;
      onValueChange(next);
      onMentionSelect?.(file);
      setDismissedMentionAt(mention.start);
      // Restore caret just after the inserted mention.
      const nextCaret = before.length + inserted.length;
      requestAnimationFrame(() => {
        const el = internalRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(nextCaret, nextCaret);
          setCaret(nextCaret);
        }
      });
    },
    [mention, value, caret, onValueChange, onMentionSelect],
  );

  const insertSlashSelection = useCallback(
    (command: SlashCommandOption) => {
      if (!slash) return;
      const before = value.slice(0, slash.start);
      const after = value.slice(caret);
      const inserted = `/${command.command} `;
      const next = `${before}${inserted}${after}`;
      onValueChange(next);
      onSlashCommandSelect?.(command);
      setDismissedSlashAt(slash.start);
      const nextCaret = before.length + inserted.length;
      requestAnimationFrame(() => {
        const el = internalRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(nextCaret, nextCaret);
          setCaret(nextCaret);
        }
      });
    },
    [slash, value, caret, onValueChange, onSlashCommandSelect],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (open && filtered.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveIndex(
            (i) => (i + 1) % Math.min(filtered.length, MAX_VISIBLE * 8),
          );
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          insertSelection(filtered[activeIndex]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          if (mention) setDismissedMentionAt(mention.start);
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          insertSelection(filtered[activeIndex]);
          return;
        }
      }
      if (slashOpen && filteredSlashCommands.length === 0) {
        if (
          (event.key === "Enter" && !event.shiftKey) ||
          event.key === "ArrowDown" ||
          event.key === "ArrowUp"
        ) {
          event.preventDefault();
          return;
        }
      }
      if (slashOpen && filteredSlashCommands.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveIndex((i) => (i + 1) % filteredSlashCommands.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex(
            (i) =>
              (i - 1 + filteredSlashCommands.length) %
              filteredSlashCommands.length,
          );
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          insertSlashSelection(filteredSlashCommands[activeIndex]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          if (slash) setDismissedSlashAt(slash.start);
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          insertSlashSelection(filteredSlashCommands[activeIndex]);
          return;
        }
      }
      if (slashOpen && event.key === "Escape") {
        event.preventDefault();
        if (slash) setDismissedSlashAt(slash.start);
        return;
      }
      onKeyDown?.(event);
    },
    [
      open,
      filtered,
      activeIndex,
      insertSelection,
      insertSlashSelection,
      onKeyDown,
      mention,
      slash,
      slashOpen,
      filteredSlashCommands,
    ],
  );

  const syncCaret = useCallback(() => {
    const el = internalRef.current;
    if (!el) return;
    const nextCaret = el.selectionStart ?? el.value.length;
    setCaret(nextCaret);
    // Caret-only navigation (arrow keys, clicks, selection changes) never
    // fires `onChange`, so we also clear `dismissedAt` here when the caret
    // lands on a DIFFERENT mention (or leaves mention context entirely).
    // Without this, a user who dismisses `@fig` and then arrows into a
    // separate `@oth` token could see the new mention suppressed if the
    // dismissal state still pointed at an older position that no longer
    // exists in the value.
    if (dismissedMentionAt !== null) {
      const nextMention = getActiveMention(el.value, nextCaret);
      if (!nextMention || nextMention.start !== dismissedMentionAt) {
        setDismissedMentionAt(null);
      }
    }
    if (dismissedSlashAt !== null) {
      const nextSlash = getActiveSlashCommand(el.value, nextCaret);
      if (!nextSlash || nextSlash.start !== dismissedSlashAt) {
        setDismissedSlashAt(null);
      }
    }
  }, [dismissedMentionAt, dismissedSlashAt]);

  const activeId =
    (open && filtered.length > 0) ||
    (slashOpen && filteredSlashCommands.length > 0)
      ? `${listboxId}-opt-${activeIndex}`
      : undefined;

  return (
    <div className="relative flex-1">
      {open && filtered.length > 0 && (
        <ul
          role="listbox"
          id={listboxId}
          aria-label="File mention suggestions"
          className="absolute bottom-full left-0 right-0 mb-2 max-h-72 overflow-y-auto rounded-xl border-2 border-border bg-white shadow-lg z-30"
        >
          {filtered.map((file, idx) => {
            const label = file.name || file.path;
            const isActive = idx === activeIndex;
            return (
              <li
                key={`${file.path}-${idx}`}
                id={`${listboxId}-opt-${idx}`}
                role="option"
                aria-selected={isActive}
                className={`flex cursor-pointer items-center gap-2 px-3 py-2 text-sm ${
                  isActive
                    ? "bg-accent/10 text-accent"
                    : "text-foreground hover:bg-surface"
                }`}
                onMouseDown={(e) => {
                  // Prevent textarea blur before we can insert.
                  e.preventDefault();
                  insertSelection(file);
                }}
                onMouseEnter={() => setActiveIndex(idx)}
              >
                <span className="truncate font-medium">{label}</span>
                {file.path !== label && (
                  <span className="ml-auto truncate text-xs text-muted">
                    {file.path}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {slashOpen && !open && (
        <ul
          role="listbox"
          id={listboxId}
          aria-label="Slash command suggestions"
          className="absolute bottom-full left-0 right-0 mb-2 max-h-72 overflow-y-auto rounded-xl border-2 border-border bg-white shadow-lg z-30"
        >
          {filteredSlashCommands.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted">
              Loading installed skills...
            </li>
          ) : (
            filteredSlashCommands.map((command, idx) => {
              const isActive = idx === activeIndex;
              return (
                <li
                  key={command.command}
                  id={`${listboxId}-opt-${idx}`}
                  role="option"
                  aria-selected={isActive}
                  className={`flex cursor-pointer items-start gap-2 px-3 py-2 text-sm ${
                    isActive
                      ? "bg-accent/10 text-accent"
                      : "text-foreground hover:bg-surface"
                  }`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertSlashSelection(command);
                  }}
                  onMouseEnter={() => setActiveIndex(idx)}
                >
                  <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-[11px] font-semibold text-muted">
                    {command.emoji ?? "/"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">
                        /{command.command}
                      </span>
                      {command.argumentHint && (
                        <span className="truncate text-[11px] text-muted">
                          {command.argumentHint}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted">
                      {command.description}
                    </p>
                  </div>
                </li>
              );
            })
          )}
        </ul>
      )}
      <textarea
        {...textareaProps}
        ref={setRefs}
        value={value}
        onChange={(e) => {
          const nextValue = e.target.value;
          onValueChange(nextValue);
          // Defer caret sync until after value propagates.
          const nextCaret = e.target.selectionStart ?? nextValue.length;
          setCaret(nextCaret);
          // If the dismissed mention is no longer active, clear the flag
          // so the next `@` trigger re-opens the dropdown. Running this in
          // the change handler (not an effect) keeps state writes out of
          // the render path.
          if (dismissedMentionAt !== null) {
            const nextMention = getActiveMention(nextValue, nextCaret);
            if (!nextMention || nextMention.start !== dismissedMentionAt) {
              setDismissedMentionAt(null);
            }
          }
          if (dismissedSlashAt !== null) {
            const nextSlash = getActiveSlashCommand(nextValue, nextCaret);
            if (!nextSlash || nextSlash.start !== dismissedSlashAt) {
              setDismissedSlashAt(null);
            }
          }
        }}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onSelect={syncCaret}
        onBlur={(e) => {
          if (mention) setDismissedMentionAt(mention.start);
          if (slash) setDismissedSlashAt(slash.start);
          textareaProps.onBlur?.(e);
        }}
        onKeyDown={handleKeyDown}
        role="combobox"
        aria-expanded={open || slashOpen}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
      />
    </div>
  );
});

"use client";

import { useCallback, useRef, useState } from "react";
import { Section } from "./_primitives";

interface IdentityValues {
  userHandle: string;
  userEmail: string;
}

type FieldKey = keyof IdentityValues;

type FieldSaveState = "idle" | "saving" | "saved" | "error";

const EMPTY_VALUES: IdentityValues = {
  userHandle: "",
  userEmail: "",
};

const FIELD_CONFIG: Array<{
  key: FieldKey;
  action: string;
  bodyKey: string;
  label: string;
  placeholder: string;
  helperText?: string;
  required?: boolean;
  type?: string;
}> = [
  {
    key: "userHandle",
    action: "save-user-handle",
    bodyKey: "userHandle",
    label: "Handle",
    placeholder: "e.g. ada",
    helperText: "Used to sign everything you write.",
    required: true,
  },
  {
    key: "userEmail",
    action: "save-user-email",
    bodyKey: "userEmail",
    label: "Email (optional)",
    placeholder: "you@example.com",
    type: "email",
  },
];

interface Props {
  initialValues: IdentityValues | null;
  inputClassName: string;
  onSaved?: () => void;
}

export function IdentitySection({
  initialValues,
  inputClassName,
  onSaved,
}: Props) {
  // Track which fields the user has edited locally. Unedited fields
  // derive their display value from the prop so there is no need to
  // call setState to synchronise from the parent.
  const [edits, setEdits] = useState<Partial<IdentityValues>>({});
  const [saveStates, setSaveStates] = useState<Record<FieldKey, FieldSaveState>>({
    userHandle: "idle",
    userEmail: "idle",
  });

  // Track the last-saved value per field so we only save when changed
  const lastSaved = useRef<Partial<IdentityValues>>({});

  // Resolved values: local edits take priority, then server values, then empty
  const resolved: IdentityValues = {
    userHandle: edits.userHandle ?? initialValues?.userHandle ?? EMPTY_VALUES.userHandle,
    userEmail: edits.userEmail ?? initialValues?.userEmail ?? EMPTY_VALUES.userEmail,
  };

  const saveField = useCallback(
    async (fieldKey: FieldKey) => {
      const config = FIELD_CONFIG.find((f) => f.key === fieldKey);
      if (!config) return;

      const currentValue =
        edits[fieldKey]
        ?? initialValues?.[fieldKey]
        ?? EMPTY_VALUES[fieldKey];
      const previousValue =
        lastSaved.current[fieldKey]
        ?? initialValues?.[fieldKey]
        ?? EMPTY_VALUES[fieldKey];

      // Skip save if value hasn't changed
      if (currentValue === previousValue) return;

      setSaveStates((prev) => ({ ...prev, [fieldKey]: "saving" }));
      try {
        const res = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: config.action,
            [config.bodyKey]: currentValue,
          }),
        });
        if (!res.ok) {
          setSaveStates((prev) => ({ ...prev, [fieldKey]: "error" }));
          return;
        }
        lastSaved.current[fieldKey] = currentValue;
        setSaveStates((prev) => ({ ...prev, [fieldKey]: "saved" }));
        onSaved?.();

        // Clear the "saved" indicator after 2s
        setTimeout(() => {
          setSaveStates((prev) =>
            prev[fieldKey] === "saved" ? { ...prev, [fieldKey]: "idle" } : prev,
          );
        }, 2000);
      } catch {
        setSaveStates((prev) => ({ ...prev, [fieldKey]: "error" }));
      }
    },
    [edits, initialValues, onSaved],
  );

  return (
    <Section title="Your identity">
      <div className="space-y-4">
        {FIELD_CONFIG.map((field) => {
          const state = saveStates[field.key];
          return (
            <div key={field.key} className="space-y-1.5">
              <label
                htmlFor={`identity-${field.key}`}
                className="block text-sm font-medium text-foreground"
              >
                {field.label}
                {field.required && (
                  <span className="text-red-400 ml-0.5">*</span>
                )}
              </label>
              <div className="flex items-center gap-2">
                <input
                  id={`identity-${field.key}`}
                  type={field.type || "text"}
                  value={resolved[field.key]}
                  placeholder={field.placeholder}
                  className={inputClassName}
                  onChange={(e) =>
                    setEdits((prev) => ({
                      ...prev,
                      [field.key]: e.target.value,
                    }))
                  }
                  onBlur={() => saveField(field.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.currentTarget.blur();
                    }
                  }}
                />
                {state === "saving" && (
                  <span className="text-xs text-muted whitespace-nowrap">
                    Saving...
                  </span>
                )}
                {state === "saved" && (
                  <span className="text-xs text-emerald-500 whitespace-nowrap">
                    Saved
                  </span>
                )}
                {state === "error" && (
                  <span className="text-xs text-red-400 whitespace-nowrap">
                    Error
                  </span>
                )}
              </div>
              {field.helperText && (
                <p className="text-xs text-muted">{field.helperText}</p>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

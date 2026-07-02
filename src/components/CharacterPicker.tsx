import { cn } from "@/lib/utils";

export type CharacterOption = { key: string; emoji: string; label: string };

export const CHARACTER_OPTIONS: CharacterOption[] = [
  { key: "ginger_cat", emoji: "🐱", label: "Ginger Cat" },
  { key: "golden_puppy", emoji: "🐶", label: "Golden Puppy" },
  { key: "panda_cub", emoji: "🐼", label: "Panda Cub" },
  { key: "bunny", emoji: "🐰", label: "Bunny" },
  { key: "fox_kit", emoji: "🦊", label: "Fox Kit" },
  { key: "baby_elephant", emoji: "🐘", label: "Baby Elephant" },
  { key: "duckling", emoji: "🐤", label: "Duckling" },
  { key: "custom", emoji: "✨", label: "Custom" },
];

export function CharacterPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {CHARACTER_OPTIONS.map((opt) => {
        const active = value === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            onClick={() => onChange(opt.key)}
            className={cn(
              "flex flex-col items-center gap-1 rounded-xl border p-2 text-center text-xs transition-all",
              active
                ? "border-primary bg-primary/10 shadow-[0_0_0_1px_var(--primary)]"
                : "border-border/60 bg-surface/40 hover:border-border hover:bg-surface/60",
            )}
          >
            <span className="text-2xl leading-none">{opt.emoji}</span>
            <span className="truncate">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

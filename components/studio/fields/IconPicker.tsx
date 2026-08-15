"use client";

/**
 * IconPicker — the searchable picker for a feature card's icon.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * IT OFFERS EXACTLY WHAT THE PUBLIC RENDERER CAN DRAW, AND NOTHING ELSE.
 *
 * `components/sections/FeatureGridSection.tsx` holds an EXPLICIT map of icon name to component, for
 * the reason set out at length in its header: `(Icons as any)[name]` cannot be tree-shaken, so a
 * dynamic lookup puts every one of lucide's 1,500-odd icons into the bundle of every page that carries
 * a feature grid. It exports `FEATURE_ICON_NAMES` and `featureIcon` so this picker can be driven by
 * that same map rather than by a second list.
 *
 * A SECOND LIST IS THE WHOLE HAZARD. A picker offering more icons than the renderer knows lets an
 * administrator choose one that silently becomes the fallback glyph — a choice that appears to have
 * been accepted and was not. So there is no icon table in this file: add an icon to the renderer's map
 * and it appears here, which is the only order in which the two can agree.
 *
 * The tile below is the renderer's tile, to the pixel: `h-11 w-11` with the glyph at `h-5 w-5`. A
 * preview at a different size is a preview of something else.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE SEARCH MATCHES WORDS AN ADMINISTRATOR WOULD TYPE, not only lucide's names. Somebody looking for
 * a photograph types "photo", not "Images"; somebody labelling a laboratory types "lab", not
 * "FlaskConical". `ICON_KEYWORDS` is that translation, and the camel-case name is split into words as
 * well, so "chart column" finds `ChartColumn`.
 *
 * `FieldBlock`, NOT `Field`. This control is a button that opens a panel of buttons, and a `<label>`
 * wrapped round a button forwards stray clicks into it and folds every name inside into the input's
 * accessible name (Field.tsx). The trigger reads its id and description off `useFieldContext()`, which
 * is why it is a separate component — a hook cannot read a provider its own parent renders.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { FieldBlock, useFieldContext } from "@/components/ui/Field";
import { Popover } from "@/components/ui/Popover";
import { FEATURE_ICON_NAMES, featureIcon } from "@/components/sections/FeatureGridSection";

/**
 * Words that find an icon, beyond its own name.
 *
 * Written for the vocabulary of this institution — craft, material, research, teaching, partnership,
 * archive — because that is what the person filling in a feature card is describing. An icon with no
 * entry here is still found by its name.
 */
const ICON_KEYWORDS: Record<string, string> = {
  Activity: "pulse monitoring progress signal",
  Award: "prize recognition honour certificate",
  BookOpen: "reading publication book study",
  Boxes: "materials collection inventory samples",
  Brain: "knowledge thinking learning cognition",
  Briefcase: "work business professional consultancy",
  Building2: "campus centre office institution premises",
  CalendarDays: "event events date schedule seminar",
  Camera: "photograph photography documentation",
  ChartColumn: "chart graph statistics bar data figures",
  ChartLine: "chart graph trend growth data",
  ChartPie: "chart graph proportion share data",
  CircleCheckBig: "done complete tick approved verified",
  CircleHelp: "question help enquiry faq support",
  Compass: "direction explore exploration guidance",
  Cpu: "technology computing hardware processor",
  Database: "data dataset records repository",
  Download: "file files dataset resources download",
  Feather: "writing authorship poetry light",
  FileText: "document report paper file",
  FlaskConical: "laboratory lab science experiment chemistry",
  Gem: "jewellery stone precious lapidary value",
  Globe: "international world global reach",
  GraduationCap: "students teaching education degree training",
  Hammer: "making tools workshop construction craft",
  Handshake: "partner partnership collaboration agreement",
  Heart: "care wellbeing community support",
  History: "timeline heritage past chronology archive",
  Images: "photograph photos picture gallery album",
  Landmark: "institution heritage monument government museum",
  Languages: "language translation script multilingual",
  Layers: "structure stack levels layers composition",
  LayoutGrid: "grid layout categories overview",
  Leaf: "sustainability environment natural green",
  Library: "books archive collection reading",
  Lightbulb: "idea innovation insight invention",
  Mail: "email contact enquiry message",
  Map: "location region geography place",
  MapPin: "location place address site",
  Megaphone: "announcement outreach publicity communication",
  Microscope: "research science laboratory analysis study",
  Network: "connections links cluster ecosystem",
  Newspaper: "news press media article coverage",
  Palette: "colour art painting dye pigment",
  PenTool: "design drawing illustration draughting",
  Presentation: "talk lecture seminar training workshop",
  Puzzle: "problem solution pieces fit",
  Recycle: "sustainability reuse circular waste",
  Rocket: "launch startup incubation acceleration",
  Ruler: "measurement dimension standard precision",
  Scale: "balance weight standard fairness policy",
  Scissors: "cutting tailoring pattern craft",
  Scroll: "manuscript archive document historical record",
  Search: "find discover enquiry lookup",
  Shapes: "general other assorted forms",
  Share2: "share network distribute connections",
  ShieldCheck: "quality assurance safety trust protection",
  Shirt: "textile cloth fabric garment weaving",
  Sparkles: "highlight new featured special",
  Sprout: "growth beginning seedling nurture",
  Star: "featured favourite excellence rating",
  Target: "objective goal aim focus outcome",
  Telescope: "vision outlook observation future",
  TrendingUp: "growth increase improvement impact",
  Trophy: "award achievement prize success",
  Users: "people team staff members community",
  Video: "film recording footage documentary",
  Waves: "water flow pattern texture",
  Workflow: "process method steps procedure",
  Wrench: "tools maintenance repair technical",
  Zap: "energy power fast electricity"
};

/** "ChartColumn" → "Chart column"; "Share2" → "Share 2". What the picker reads out and shows. */
function humaniseIconName(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return spaced.length > 0 ? `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}` : name;
}

/** Everything one icon can be found by, lower-cased once at module load rather than per keystroke. */
const SEARCHABLE: { name: string; haystack: string }[] = FEATURE_ICON_NAMES.map((name) => ({
  name,
  haystack: `${name} ${humaniseIconName(name)} ${ICON_KEYWORDS[name] ?? ""}`.toLowerCase()
}));

export interface IconPickerProps {
  /** The stored icon name, or `""` for none. */
  value: string;
  onChange: (next: string) => void;
  /** Defaults to "Icon". */
  label?: string;
  /** The schema's `.describe()` sentence. */
  help?: string;
  error?: string | null;
  className?: string;
}

export function IconPicker({
  value,
  onChange,
  label = "Icon",
  help,
  error,
  className
}: IconPickerProps) {
  return (
    <FieldBlock label={label} help={help} error={error} className={className}>
      <IconPickerControl value={value} onChange={onChange} />
    </FieldBlock>
  );
}

function IconPickerControl({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const field = useFieldContext();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  // Generated, not a constant: a feature grid holds up to twelve of these pickers, and a hardcoded id
  // would give twelve search boxes the same one — at which point every label points at the first.
  const searchId = `${useId()}icon-search`;

  // The panel is not a focus trap (see Popover.tsx), but the search box is where every reader wants to
  // be the instant it opens — otherwise the first keystroke goes to the page behind it.
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return SEARCHABLE;
    const words = needle.split(/\s+/);
    return SEARCHABLE.filter((entry) => words.every((word) => entry.haystack.includes(word)));
  }, [query]);

  const choose = (name: string) => {
    onChange(name);
    setOpen(false);
    // Focus goes back to the trigger, which is where the reader's place in the tab order is.
    triggerRef.current?.focus({ preventScroll: true });
  };

  const CurrentIcon = value.length > 0 ? featureIcon(value) : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          ref={triggerRef}
          id={field?.controlId}
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          aria-describedby={field?.describedBy}
          className="field-button-secondary min-w-0 justify-start gap-3 pl-2"
        >
          {/* The renderer's own tile, at the renderer's own size — see the header. */}
          <span
            aria-hidden="true"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-surface-100 text-purple-600"
          >
            {CurrentIcon ? <CurrentIcon className="h-5 w-5" /> : <span className="text-xs text-ink-300">none</span>}
          </span>
          <span className="min-w-0 truncate">
            {value.length > 0 ? humaniseIconName(value) : "Choose an icon"}
          </span>
          <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-500" />
        </button>

        {value.length > 0 ? (
          <button
            type="button"
            onClick={() => onChange("")}
            className="field-button-ghost min-h-8 px-2 py-1 text-xs"
          >
            <X aria-hidden="true" className="h-3.5 w-3.5" />
            Remove the icon
          </button>
        ) : null}
      </div>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        label="Choose an icon"
        width={320}
        // `!p-0`, with the bang. `Popover` sets `p-1.5` and `cn()` is a plain join — later classes do NOT
        // win, and Tailwind emits `p-1.5` after `p-0`, so an unforced override loses (contract §5). The
        // panel needs no padding of its own because the sticky search bar has to reach its edges.
        className="!p-0"
      >
        {/* The panel itself is the scroller, so the search box has to stick to its top or it scrolls
            away from the results it is filtering. z-10 is the sticky-chrome rung (contract §6). */}
        <div className="sticky top-0 z-10 border-b border-line-200 bg-card p-2">
          <label htmlFor={searchId} className="sr-only">
            Search icons
          </label>
          <span className="relative block">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-300"
            />
            <input
              id={searchId}
              ref={searchRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="photo, laboratory, partnership…"
              autoComplete="off"
              className="field-input pl-9 text-sm"
            />
          </span>
        </div>

        <div className="p-2">
          {matches.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-ink-500">
              No icon matches “{query.trim()}”. Try a plainer word, such as “people”, “document” or
              “place”.
            </p>
          ) : (
            <div className="grid grid-cols-5 gap-1">
              {matches.map(({ name }) => {
                const Icon = featureIcon(name);
                const selected = name === value;
                const readable = humaniseIconName(name);

                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => choose(name)}
                    // A toggle button, so the chosen one is announced as pressed rather than only
                    // looking different (contract §11 — colour never carries meaning alone).
                    aria-pressed={selected}
                    aria-label={readable}
                    title={readable}
                    className={cn(
                      "flex h-11 w-11 items-center justify-center rounded-md transition",
                      selected
                        ? "bg-purple-100 text-purple-700 ring-2 ring-purple-600/40"
                        : "bg-surface-100 text-ink-700 hover:bg-purple-50 hover:text-purple-700"
                    )}
                  >
                    <Icon aria-hidden="true" className="h-5 w-5" />
                  </button>
                );
              })}
            </div>
          )}

          <p className="mt-2 border-t border-line-200 px-1 pt-2 text-xs leading-relaxed text-ink-500">
            {matches.length === SEARCHABLE.length
              ? `These ${SEARCHABLE.length} icons are the full set the site can draw.`
              : `${matches.length} of ${SEARCHABLE.length} icons match.`}
          </p>
        </div>
      </Popover>
    </>
  );
}

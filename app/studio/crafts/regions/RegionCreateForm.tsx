"use client";

/**
 * RegionCreateForm — recording a place the gazetteer has never heard of.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE HOLE THIS CLOSES. Regions arrived from `prisma/corpus/seed-corpus.ts` and were then read-only. The
 * craft editor's region field says "Regions are set up separately. Leave it empty if the place is not
 * settled" — and there was nowhere that separate setting-up happened. An editor documenting a craft from a
 * place the corpus never listed had no move to make and no message telling them why.
 *
 * ⚠ A DIALOG, NOT AN INLINE ROW, and the reason is the screen it sits on. Every row below this form owns a
 * live coordinate pair that the reader may be part-way through typing (see RegionMapManager.tsx's header on
 * why the list holds them). An inline creation row would put a second, differently-shaped set of coordinate
 * boxes into that same list, and "which of these two pairs am I editing" is the kind of confusion no amount
 * of labelling fixes.
 *
 * ⚠ THE COORDINATES ARE NOT ASKED FOR HERE AT ALL. Naming a place and knowing where it is are two pieces of
 * work, often done by two different people — and this whole screen already exists to place a region that has
 * no pin. Asking for degrees at creation time would mean an editor without them to hand cannot record the
 * place, which is the exact hole being closed. So a new region arrives unplaced, appears in the list below,
 * and is placed there with the map like any other.
 *
 * THE LEVEL AND THE PARENT ARE ASKED FOR, because unlike the coordinates they cannot be corrected afterwards
 * (app/api/studio/crafts/regions/[id]/route.ts edits coordinates and nothing else, and its header says why).
 * The form states that plainly rather than letting somebody discover it. The parent list is filtered to
 * regions STRICTLY WIDER than the chosen level, which is the same ladder the route enforces — a client
 * filter so the wrong choice is not offered, and a server check because a filter is not a guarantee.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MapPinPlus } from "lucide-react";

import { asApiClientError, post } from "@/lib/client/fetcher";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/ToastProvider";
import { HelpText } from "@/components/studio/HelpText";

/**
 * The four levels, widest first — the same ladder and the same spelling as the route's `LEVELS`, which is
 * the order the parent filter and the homepage map's roll-up walk both depend on.
 */
const LEVELS = [
  {
    value: "NATION",
    label: "Nation",
    help: "The whole country. There is normally exactly one."
  },
  { value: "STATE", label: "State", help: "A state or union territory." },
  { value: "DISTRICT", label: "District", help: "A district within a state." },
  {
    value: "CLUSTER",
    label: "Cluster",
    help: "A village, town or group of workshops — the finest level the map draws."
  }
] as const;

const NAME_MAX = 120;

/** One candidate parent, as the screen already has it. */
export interface RegionParentOption {
  id: string;
  name: string;
  level: string;
}

export interface RegionCreateFormProps {
  /** Every existing region, so the parent list can be filtered by level. */
  parents: readonly RegionParentOption[];
}

function rankOf(level: string): number {
  return LEVELS.findIndex((entry) => entry.value === level);
}

export function RegionCreateForm({ parents }: RegionCreateFormProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [level, setLevel] = useState<string>("DISTRICT");
  const [parentId, setParentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setName("");
    setLevel("DISTRICT");
    setParentId("");
    setError(null);
  }, []);

  /**
   * Only regions STRICTLY WIDER than the chosen level. A state filed under a district is a tree the map's
   * roll-up walk climbs the wrong way, so the count would surface under the smaller place — the route
   * refuses it, and there is no reason to offer it here first.
   */
  const eligibleParents = useMemo(() => {
    const ownRank = rankOf(level);
    if (ownRank <= 0) return [];
    return parents
      .filter((parent) => {
        const parentRank = rankOf(parent.level);
        return parentRank !== -1 && parentRank < ownRank;
      })
      .map((parent) => ({
        value: parent.id,
        label: `${parent.name} (${parent.level.toLowerCase()})`
      }));
  }, [level, parents]);

  const chooseLevel = useCallback((next: string) => {
    setLevel(next);
    // The parent that was chosen may no longer be wider than the new level. Clearing it is the honest
    // move: keeping it would send a pair the server then refuses, with the refusal landing on a field
    // the reader did not touch.
    setParentId("");
  }, []);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await post<{ message?: string }>("/api/studio/crafts/regions", {
        name: name.trim(),
        level,
        parentId: parentId.length > 0 ? parentId : null,
        // Deliberately unplaced — see the header. The route defaults both to null, and they are sent
        // explicitly so a reader of the network tab sees the intent rather than an omission.
        latitude: null,
        longitude: null
      });
      toast({
        tone: "success",
        title: `“${name.trim()}” has been recorded`,
        // The server's own sentence, which explains that it has no pin yet and what that means for the map.
        description: answer.message
      });
      close();
      router.refresh();
    } catch (thrown) {
      // Inside the dialog, not as a toast: the reader is standing in front of the field that caused it.
      setError(asApiClientError(thrown).message);
    } finally {
      setBusy(false);
    }
  }, [close, level, name, parentId, router, toast]);

  const levelHelp = LEVELS.find((entry) => entry.value === level)?.help ?? "";
  const isNation = level === "NATION";

  return (
    <>
      <Button variant="secondary" size="sm" icon={MapPinPlus} onClick={() => setOpen(true)}>
        Add a region
      </Button>

      <Dialog
        open={open}
        onClose={close}
        title="Add a region"
        size="sm"
        footer={
          <>
            <button type="button" data-dialog-cancel onClick={close} className="field-button-secondary">
              Cancel
            </button>
            <Button isLoading={busy} loadingLabel="recording" onClick={() => void submit()}>
              Record this region
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label="Name"
            required
            maxLength={NAME_MAX}
            value={name}
            help="The place as it is normally written — “Kutch”, “Raghurajpur”, “Bhuj”. Its web address is made from this and does not change afterwards."
          >
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>

          <Field label="What kind of place" required help={levelHelp}>
            <Select
              value={level}
              options={LEVELS.map((entry) => ({ value: entry.value, label: entry.label }))}
              onChange={(event) => chooseLevel(event.target.value)}
            />
          </Field>

          {isNation ? (
            <HelpText>
              A nation sits at the top of the tree, so it has no parent. Everything else can name one.
            </HelpText>
          ) : eligibleParents.length === 0 ? (
            // A closed list with no options would block a submit with no way forward, so the field stands
            // down and says what to do instead (contract §10).
            <HelpText tone="warn">
              There is no wider region to file this under yet — a {level.toLowerCase()} needs a{" "}
              {LEVELS.slice(0, rankOf(level))
                .map((entry) => entry.label.toLowerCase())
                .join(" or a ")}
              . It can be recorded without one and it will sit at the top of the tree, which is worth
              avoiding if the wider place is one you can add first.
            </HelpText>
          ) : (
            <Field
              label="Inside which region"
              help="What this place sits within. It is how the homepage map rolls counts up: a cluster with no pin of its own counts under the nearest parent that has one."
            >
              <Select
                value={parentId}
                placeholder="Not filed under anything"
                options={eligibleParents}
                onChange={(event) => setParentId(event.target.value)}
              />
            </Field>
          )}

          <HelpText tone="warn">
            The name, the kind of place and the parent are fixed once recorded — only the coordinates can be
            changed afterwards. Nothing is asked about where it is here: record it, then place it on the map
            from the list below.
          </HelpText>
        </div>

        {error ? (
          // `role="alert"`: the reader has just pressed something and been stopped.
          <p role="alert" className="mt-3 text-sm leading-relaxed text-error-600">
            {error}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}

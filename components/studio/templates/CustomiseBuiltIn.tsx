"use client";

/**
 * CustomiseBuiltIn — the one control on a built-in template's screen.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT PRESSING IT DOES, SAID BEFORE IT IS PRESSED. It writes a `PageTemplate` row holding this
 * built-in's key, which makes that row stand in the built-in's place everywhere: on the chooser, in the
 * manager, and in the form field that creates a page. Nothing is lost — the arrangement is copied
 * verbatim, and removing the row later brings the original back exactly as it was.
 *
 * That last sentence is why there is no confirmation dialog. A confirmation is for a decision that is
 * hard to reverse; this one is reversed by a single Remove, and asking about it would train people to
 * click through the dialogs that do matter. The consequence is on the screen instead, where it can be
 * read before the press rather than after it.
 *
 * IT IS A CLIENT COMPONENT FOR ONE REASON: it navigates to the editor for the row it has just created,
 * and the key of that row is only known once the server answers. A Server Action could do the same work,
 * but it would have to redirect from inside the action to a path it computed — the same thing, with the
 * failure arriving as a page reload rather than as a sentence beside the button.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { WandSparkles } from "lucide-react";

import { asApiClientError, post } from "@/lib/client/fetcher";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/ToastProvider";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";

const ENDPOINT = "/api/studio/templates";

export interface CustomiseBuiltInProps {
  /** The built-in's id, which becomes the new row's key. */
  templateKey: string;
  templateName: string;
}

export function CustomiseBuiltIn({ templateKey, templateName }: CustomiseBuiltInProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [isWorking, setIsWorking] = useState(false);

  const customise = useCallback(async () => {
    setIsWorking(true);
    try {
      const answer = await post<{ key?: string }>(ENDPOINT, {
        from: templateKey,
        replaceBuiltIn: true
      });
      if (answer?.key) {
        router.push(`/studio/templates/${encodeURIComponent(answer.key)}`);
        router.refresh();
        return;
      }
      // The row was written but the answer did not name it. Refreshing lands the reader back on this
      // address, which now resolves to the row rather than to the built-in — so the editor appears
      // anyway, and nothing is silently lost.
      router.refresh();
    } catch (thrown) {
      setIsWorking(false);
      toast({
        tone: "error",
        title: "The template has not been customised",
        description: asApiClientError(thrown).message
      });
    }
  }, [router, templateKey, toast]);

  return (
    <FormSection
      title="Make a version of your own"
      description={`A copy of “${templateName}” that you can edit — its name, its description, and which blocks it puts on the page.`}
      footer={
        <Button
          icon={WandSparkles}
          isLoading={isWorking}
          loadingLabel="preparing"
          onClick={() => void customise()}
        >
          Customise this template
        </Button>
      }
    >
      <HelpText>
        The copy takes this template&rsquo;s place straight away, so nothing disappears from the list a
        colleague chooses from — they see your version where the original was. It starts as an exact copy,
        so until you change something the two are identical. Removing it later brings the original back
        exactly as it is now, and pages already made from either keep the blocks they were given.
      </HelpText>
    </FormSection>
  );
}

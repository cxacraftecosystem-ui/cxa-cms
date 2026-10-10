"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";

import { asApiClientError, post } from "@/lib/client/fetcher";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/ToastProvider";

/**
 * "New issue": makes a draft and opens it. A draft needs only a title, so it is given a dated one the
 * author changes on the next screen — the alternative, a form with one field before the editor, is a
 * step that asks a question nobody can answer yet.
 */
export function NewIssueButton() {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const title = `Newsletter — ${new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date())}`;
      const created = await post<{ item: { id: string } }>("/api/studio/newsletter/issues", { title });
      router.push(`/studio/newsletter/${created.item.id}`);
    } catch (thrown) {
      toast({ title: asApiClientError(thrown).message, tone: "error" });
      setBusy(false);
    }
  }

  return (
    <Button size="sm" icon={Plus} onClick={() => void create()} isLoading={busy} loadingLabel="creating">
      New issue
    </Button>
  );
}

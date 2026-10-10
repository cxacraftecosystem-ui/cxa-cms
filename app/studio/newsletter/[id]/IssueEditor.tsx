"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, CircleStop, Eye, Save, Send, SendHorizontal, Trash2, Undo2 } from "lucide-react";

import { asApiClientError, del, get, patch, post } from "@/lib/client/fetcher";
import type { RichTextDoc } from "@/lib/richtext";
import { fromZonedInput, toZonedInput } from "@/lib/zoned-time";
import { Badge } from "@/components/ui/Badge";
import { Button, LinkButton } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/ConfirmProvider";
import { DateField } from "@/components/ui/DateField";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/ToastProvider";
import { FormSection } from "@/components/studio/FormSection";
import { HelpText } from "@/components/studio/HelpText";
import { RichTextEditor, type EditorMediaKind } from "@/components/studio/editor/RichTextEditor";
import type { EditorMediaSelection } from "@/components/studio/editor/extensions";
import { MediaPicker } from "@/components/studio/media/MediaPicker";
import type { StudioMediaAsset } from "@/components/studio/media/MediaGrid";
import { useLeaveGuard } from "@/components/studio/useUnsavedChanges";

/**
 * The issue screen: write, preview, test, send, schedule, cancel — and watch the counts while it sends.
 *
 * ══ WHY SEND IS REFUSED WHILE THERE ARE UNSAVED CHANGES ══
 *
 * Every send — the test included — sends what is SAVED, because that is what the server has. A Send
 * button that worked while the editor held newer words would mail the previous version to everybody and
 * leave the author believing their last correction went out. So the send controls ask for a save first,
 * and say so, rather than saving silently on the author's behalf (a save they did not ask for could
 * collide with a colleague's).
 *
 * ══ WHAT EACH PERSON SEES ══
 *
 * `mayEdit` (the author, or an editor) decides the fields and the test button; `maySend` (publishing
 * access) decides Send, Schedule and Cancel. Both come from the server, which asks the same predicates
 * again on every request (lib/newsletter/issue-studio.ts) — a control that is hidden here is also refused
 * there.
 */

export type IssueStatusName = "DRAFT" | "SCHEDULED" | "SENDING" | "SENT" | "CANCELLED";

export interface IssueValue {
  id: string;
  title: string;
  subject: string;
  preheader: string;
  body: unknown;
  status: IssueStatusName;
  scheduledAt: string | null;
  sentAt: string | null;
  recipientCount: number;
  updatedAt: string;
}

export interface IssueCounts {
  queued: number;
  sent: number;
  failed: number;
  suppressed: number;
  cancelled: number;
  total: number;
}

export interface IssueEditorProps {
  initial: IssueValue;
  initialCounts: IssueCounts;
  statusLabels: Record<IssueStatusName, string>;
  audience: number;
  mayEdit: boolean;
  maySend: boolean;
  senderConfigured: boolean;
  storageReady: boolean;
  userEmail: string;
  timeZone: string;
  timeZoneLabel: string;
  titleMax: number;
  subjectMax: number;
  preheaderMax: number;
}

const STATUS_TONE: Record<IssueStatusName, "neutral" | "info" | "warn" | "success"> = {
  DRAFT: "neutral",
  SCHEDULED: "info",
  SENDING: "warn",
  SENT: "success",
  CANCELLED: "neutral"
};

const POLL_MS = 8000;
const NUDGE_MS = 50_000;

export function IssueEditor({
  initial,
  initialCounts,
  statusLabels,
  audience,
  mayEdit,
  maySend,
  senderConfigured,
  storageReady,
  userEmail,
  timeZone,
  timeZoneLabel,
  titleMax,
  subjectMax,
  preheaderMax
}: IssueEditorProps) {
  const router = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [issue, setIssue] = useState<IssueValue>(initial);
  const [draft, setDraft] = useState({
    title: initial.title,
    subject: initial.subject,
    preheader: initial.preheader,
    body: initial.body
  });
  const [dirty, setDirty] = useState(false);
  const [counts, setCounts] = useState<IssueCounts>(initialCounts);
  const [busy, setBusy] = useState<null | "save" | "test" | "send" | "schedule" | "unschedule" | "cancel" | "remove">(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [scheduleAt, setScheduleAt] = useState<string | null>(initial.scheduledAt);
  const [previewKey, setPreviewKey] = useState(0);

  const editable = mayEdit && (issue.status === "DRAFT" || issue.status === "SCHEDULED");

  useLeaveGuard(dirty);

  // ── The media picker, as a promise (the shape every editor in the studio uses) ──────────────────
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mediaKind, setMediaKind] = useState<EditorMediaKind>("IMAGE");
  const resolver = useRef<((chosen: EditorMediaSelection | null) => void) | null>(null);
  const requestMedia = useCallback(
    (kind: EditorMediaKind) =>
      new Promise<EditorMediaSelection | null>((resolve) => {
        resolver.current = resolve;
        setMediaKind(kind);
        setPickerOpen(true);
      }),
    []
  );
  const settle = useCallback((selection: EditorMediaSelection | null) => {
    const resolve = resolver.current;
    resolver.current = null;
    resolve?.(selection);
  }, []);

  const update = useCallback((next: Partial<typeof draft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setDirty(true);
  }, []);

  const applyItem = useCallback((item: Record<string, unknown>) => {
    setIssue((current) => ({
      ...current,
      title: String(item.title ?? current.title),
      subject: String(item.subject ?? current.subject),
      preheader: typeof item.preheader === "string" ? item.preheader : "",
      body: item.body ?? null,
      status: (item.status as IssueStatusName) ?? current.status,
      scheduledAt: typeof item.scheduledAt === "string" ? item.scheduledAt : null,
      sentAt: typeof item.sentAt === "string" ? item.sentAt : null,
      recipientCount: typeof item.recipientCount === "number" ? item.recipientCount : current.recipientCount,
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : current.updatedAt
    }));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await get<{ item: Record<string, unknown>; counts: IssueCounts }>(
        `/api/studio/newsletter/issues/${issue.id}`
      );
      applyItem(data.item);
      setCounts(data.counts);
    } catch {
      // A missed poll is not worth a message; the next one will try again.
    }
  }, [applyItem, issue.id]);

  // While sending, the counts move on their own. Poll gently, and stop the moment it is finished.
  useEffect(() => {
    if (issue.status !== "SENDING") return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [issue.status, refresh]);

  /**
   * And while somebody who may send is watching, nudge the drain now and then. The send route queues
   * nothing twice; for an issue already sending it just runs another batch. Spaced wider than one batch
   * lasts, so two batches do not run side by side and exceed the provider's rate between them.
   */
  useEffect(() => {
    if (issue.status !== "SENDING" || !maySend) return;
    const timer = setInterval(() => {
      void post(`/api/studio/newsletter/issues/${issue.id}/send`, { confirm: true }).catch(() => undefined);
    }, NUDGE_MS);
    return () => clearInterval(timer);
  }, [issue.status, issue.id, maySend]);

  const fail = useCallback(
    (thrown: unknown) => {
      const error = asApiClientError(thrown);
      if (error.fieldErrors) setFieldErrors(error.fieldErrors);
      toast({ title: error.message, tone: "error" });
    },
    [toast]
  );

  async function save(): Promise<boolean> {
    setBusy("save");
    setFieldErrors({});
    try {
      const data = await patch<{ item: Record<string, unknown> }>(`/api/studio/newsletter/issues/${issue.id}`, {
        title: draft.title,
        subject: draft.subject,
        preheader: draft.preheader,
        body: draft.body,
        expectedUpdatedAt: issue.updatedAt
      });
      applyItem(data.item);
      setDirty(false);
      setPreviewKey((key) => key + 1);
      toast({ title: "Saved.", tone: "success" });
      return true;
    } catch (thrown) {
      fail(thrown);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy("test");
    try {
      const data = await post<{ message: string }>(`/api/studio/newsletter/issues/${issue.id}/test`, {});
      toast({ title: data.message, tone: "success" });
    } catch (thrown) {
      fail(thrown);
    } finally {
      setBusy(null);
    }
  }

  async function sendNow() {
    const ok = await confirm({
      title: `Send “${issue.subject}” to ${audience === 1 ? "1 subscriber" : `${audience} subscribers`}?`,
      body:
        "Everybody who has confirmed their subscription gets a copy. Once a copy has gone it cannot be recalled; " +
        "you can stop the copies that are still waiting with Cancel sending.",
      confirmLabel: "Send now",
      tone: "danger"
    });
    if (!ok) return;
    setBusy("send");
    try {
      const data = await post<{ status: IssueStatusName; recipients: number; alreadyQueued: boolean }>(
        `/api/studio/newsletter/issues/${issue.id}/send`,
        { confirm: true }
      );
      toast({
        title: data.alreadyQueued
          ? "This issue was already sending, so nothing was sent twice."
          : `Sending to ${data.recipients === 1 ? "1 subscriber" : `${data.recipients} subscribers`}.`,
        tone: "success"
      });
      await refresh();
    } catch (thrown) {
      fail(thrown);
    } finally {
      setBusy(null);
    }
  }

  async function schedule() {
    if (!scheduleAt) {
      setFieldErrors({ scheduledAt: ["Choose when the issue should go out."] });
      return;
    }
    setBusy("schedule");
    setFieldErrors({});
    try {
      const data = await post<{ item: Record<string, unknown> }>(`/api/studio/newsletter/issues/${issue.id}/schedule`, {
        scheduledAt: scheduleAt
      });
      applyItem(data.item);
      toast({ title: "Scheduled.", tone: "success" });
    } catch (thrown) {
      fail(thrown);
    } finally {
      setBusy(null);
    }
  }

  async function unschedule() {
    setBusy("unschedule");
    try {
      const data = await del<{ item: Record<string, unknown> }>(`/api/studio/newsletter/issues/${issue.id}/schedule`);
      applyItem(data.item);
      toast({ title: "Taken off the schedule. It is a draft again.", tone: "success" });
    } catch (thrown) {
      fail(thrown);
    } finally {
      setBusy(null);
    }
  }

  async function cancelSending() {
    const ok = await confirm({
      title: "Stop sending this issue?",
      body: "Copies that have already gone cannot be recalled. Every copy still waiting will not be sent, and the issue cannot be sent again.",
      confirmLabel: "Stop sending",
      tone: "danger"
    });
    if (!ok) return;
    setBusy("cancel");
    try {
      const data = await post<{ item: Record<string, unknown>; counts: IssueCounts }>(
        `/api/studio/newsletter/issues/${issue.id}/cancel`,
        {}
      );
      applyItem(data.item);
      setCounts(data.counts);
      toast({ title: "Sending stopped.", tone: "success" });
    } catch (thrown) {
      fail(thrown);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: "Remove this draft?",
      body: "The draft is removed from the list. Nothing has been sent, so nobody is affected.",
      confirmLabel: "Remove draft",
      tone: "danger"
    });
    if (!ok) return;
    setBusy("remove");
    try {
      await del(`/api/studio/newsletter/issues/${issue.id}`);
      setDirty(false);
      router.push("/studio/newsletter");
    } catch (thrown) {
      fail(thrown);
      setBusy(null);
    }
  }

  const firstError = (key: string) => fieldErrors[key]?.[0] ?? null;
  const previewHref = `/studio/newsletter/${issue.id}/preview`;
  const minSchedule = useMemo(() => toZonedInput(new Date().toISOString(), timeZone).slice(0, 10), [timeZone]);
  const formatter = useMemo(
    () =>
      new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone
      }),
    [timeZone]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={STATUS_TONE[issue.status]}>{statusLabels[issue.status]}</Badge>
        {issue.status === "SCHEDULED" && issue.scheduledAt ? (
          <span className="text-sm text-ink-700">Goes out shortly after {formatter.format(new Date(issue.scheduledAt))} ({timeZoneLabel}).</span>
        ) : null}
        {issue.status === "SENT" && issue.sentAt ? (
          <span className="text-sm text-ink-700">Finished {formatter.format(new Date(issue.sentAt))}.</span>
        ) : null}
        <span className="ml-auto flex flex-wrap gap-2">
          <LinkButton href={previewHref} newTab variant="secondary" size="sm" icon={Eye}>
            Open the preview
          </LinkButton>
          {editable ? (
            <Button size="sm" icon={Save} onClick={() => void save()} isLoading={busy === "save"} loadingLabel="saving" disabled={!dirty || busy !== null}>
              {dirty ? "Save changes" : "Saved"}
            </Button>
          ) : null}
        </span>
      </div>

      {!editable && mayEdit && (issue.status === "SENDING" || issue.status === "SENT" || issue.status === "CANCELLED") ? (
        <HelpText>This issue has been sent or cancelled, so its words are fixed as they went out.</HelpText>
      ) : null}
      {!mayEdit ? <HelpText>Only the issue&rsquo;s author or an editor can change it.</HelpText> : null}

      <FormSection title="The message" description="The subject and the grey line after it are what a reader sees in their inbox before opening anything.">
        <Field label="Title" required help="The heading at the top of the email." error={firstError("title")} maxLength={titleMax} value={draft.title}>
          <Input value={draft.title} onChange={(event) => update({ title: event.target.value })} maxLength={titleMax} disabled={!editable} />
        </Field>
        <Field label="Subject line" required help="What the inbox shows. Keep it short and specific." error={firstError("subject")} maxLength={subjectMax} value={draft.subject}>
          <Input value={draft.subject} onChange={(event) => update({ subject: event.target.value })} maxLength={subjectMax} disabled={!editable} />
        </Field>
        <Field
          label="Preview line"
          help="Optional. The grey text most mail programs show after the subject."
          error={firstError("preheader")}
          maxLength={preheaderMax}
          value={draft.preheader}
        >
          <Input value={draft.preheader} onChange={(event) => update({ preheader: event.target.value })} maxLength={preheaderMax} disabled={!editable} />
        </Field>
      </FormSection>

      <FormSection title="The issue" description="Write it as you would an article. Pictures go out at the width of the email; a film becomes a link to watch it.">
        {firstError("body") ? <HelpText tone="error">{firstError("body")}</HelpText> : null}
        <RichTextEditor
          value={draft.body}
          onChange={(doc: RichTextDoc) => setDraft((current) => ({ ...current, body: doc }))}
          onDirty={() => setDirty(true)}
          label="Newsletter body"
          placeholder="What the Centre has recorded, published and restored since the last issue."
          minHeight={360}
          editable={editable}
          onRequestMedia={storageReady && editable ? requestMedia : undefined}
        />
      </FormSection>

      <FormSection
        title="Preview"
        description="Exactly what a subscriber receives, as it was last saved. The unsubscribe link at the foot is filled in for each reader."
      >
        <iframe
          key={previewKey}
          src={previewHref}
          title="Preview of the email"
          className="h-[48rem] w-full rounded-md border border-line-200 bg-white"
          sandbox=""
        />
      </FormSection>

      <FormSection title="Send" description={`A test goes to ${userEmail} only. Sending goes to everybody who has confirmed — ${audience === 1 ? "1 person" : `${audience} people`} right now.`}>
        {!senderConfigured ? (
          <HelpText tone="warn">
            The email sender is not configured, so nothing can go out yet. Sending or scheduling now queues the
            issue, and it goes out as soon as the sender is configured.
          </HelpText>
        ) : null}
        {dirty ? <HelpText tone="warn">Save your changes first — sending always uses the saved version.</HelpText> : null}

        <div className="flex flex-wrap gap-2">
          {mayEdit ? (
            <Button
              variant="secondary"
              size="sm"
              icon={SendHorizontal}
              onClick={() => void sendTest()}
              isLoading={busy === "test"}
              loadingLabel="sending a test"
              disabled={dirty || busy !== null || !senderConfigured}
            >
              Send a test to me
            </Button>
          ) : null}

          {maySend && (issue.status === "DRAFT" || issue.status === "SCHEDULED") ? (
            <Button
              size="sm"
              icon={Send}
              onClick={() => void sendNow()}
              isLoading={busy === "send"}
              loadingLabel="sending"
              disabled={dirty || busy !== null || audience === 0}
            >
              Send to {audience === 1 ? "1 subscriber" : `${audience} subscribers`}
            </Button>
          ) : null}

          {maySend && issue.status === "SENDING" ? (
            <Button variant="danger" size="sm" icon={CircleStop} onClick={() => void cancelSending()} isLoading={busy === "cancel"} loadingLabel="stopping" disabled={busy !== null}>
              Cancel sending
            </Button>
          ) : null}

          {mayEdit && issue.status === "DRAFT" ? (
            <Button variant="ghost" size="sm" icon={Trash2} onClick={() => void remove()} isLoading={busy === "remove"} loadingLabel="removing" disabled={busy !== null}>
              Remove draft
            </Button>
          ) : null}
        </div>
        {audience === 0 && maySend && (issue.status === "DRAFT" || issue.status === "SCHEDULED") ? (
          <HelpText>Nobody has confirmed a subscription yet, so there is nobody to send to.</HelpText>
        ) : null}
        {!maySend && (issue.status === "DRAFT" || issue.status === "SCHEDULED") ? (
          <HelpText>Sending to subscribers needs publishing access. An editor can send it for you.</HelpText>
        ) : null}

        {maySend && (issue.status === "DRAFT" || issue.status === "SCHEDULED") ? (
          <div className="mt-2 flex flex-wrap items-end gap-3 border-t border-line-200 pt-4">
            <DateField
              label="Or send it later"
              withTime
              min={minSchedule}
              value={toZonedInput(scheduleAt, timeZone)}
              onChange={(raw) => setScheduleAt(raw.trim().length === 0 ? null : fromZonedInput(raw, timeZone))}
              error={firstError("scheduledAt")}
              help={<span className="font-medium text-ink-700">In {timeZoneLabel}. It goes out at the first delivery run after this time.</span>}
            />
            <Button variant="secondary" size="sm" icon={CalendarClock} onClick={() => void schedule()} isLoading={busy === "schedule"} loadingLabel="scheduling" disabled={dirty || busy !== null}>
              {issue.status === "SCHEDULED" ? "Change the time" : "Schedule"}
            </Button>
            {issue.status === "SCHEDULED" ? (
              <Button variant="ghost" size="sm" icon={Undo2} onClick={() => void unschedule()} isLoading={busy === "unschedule"} loadingLabel="unscheduling" disabled={busy !== null}>
                Take off the schedule
              </Button>
            ) : null}
          </div>
        ) : null}
      </FormSection>

      {issue.status === "SENDING" || issue.status === "SENT" || issue.status === "CANCELLED" ? (
        <FormSection title="Deliveries" description="One copy per subscriber who was confirmed when the issue was sent. These figures update while it sends.">
          <dl className="grid gap-3 sm:grid-cols-5">
            {[
              { label: "Waiting", value: counts.queued, help: "Queued, or being handed to the email service right now." },
              { label: "Sent", value: counts.sent, help: "Accepted by the email service for delivery." },
              { label: "Not delivered", value: counts.failed, help: "Refused, or still failing after several tries." },
              { label: "Address stopped", value: counts.suppressed, help: "Unsubscribed, bounced or complained before their copy went." },
              { label: "Cancelled", value: counts.cancelled, help: "Still waiting when sending was stopped." }
            ].map((tile) => (
              <div key={tile.label} className="rounded-md border border-line-200 bg-surface-50 p-3">
                <dt className="text-xs text-ink-500">{tile.label}</dt>
                <dd className="font-display text-2xl font-semibold tabular-nums text-ink-900">{tile.value}</dd>
                <dd className="mt-1 text-[0.6875rem] leading-snug text-ink-500">{tile.help}</dd>
              </div>
            ))}
          </dl>
          <HelpText>
            {counts.total === 1 ? "1 copy" : `${counts.total} copies`} altogether. Test copies are not counted.
          </HelpText>
        </FormSection>
      ) : null}

      <MediaPicker
        open={pickerOpen}
        onClose={() => {
          setPickerOpen(false);
          settle(null);
        }}
        onSelect={(assets: StudioMediaAsset[]) => {
          const chosen = assets[0];
          if (!chosen) return;
          settle(chosen);
          setPickerOpen(false);
        }}
        kind={mediaKind}
        storageReady={storageReady}
        title={mediaKind === "VIDEO" ? "Insert a film" : "Insert a picture"}
      />
    </div>
  );
}

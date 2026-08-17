import type { SectionType } from "@prisma/client";

import { SECTION_REGISTRY, sectionMeta, type SectionMeta } from "@/lib/sections/registry";
import { defaultSectionData, parseSectionData } from "@/lib/sections/schema";

/**
 * PAGE TEMPLATES — so a new page starts as something, rather than as an empty column and a palette.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ A TEMPLATE IS DATA, NOT A COPY OF A PAGE, AND THAT IS THE WHOLE DESIGN.
 *
 * Nothing here holds a payload. A template holds an ORDERED LIST OF BLOCK TYPES, and every payload is
 * built at the moment of use by `defaultSectionData()` — the same seeded default a block dropped from the
 * palette gets — and then parsed by `parseSectionData()`. Two properties follow, and both are the reason
 * this file exists in this shape:
 *
 *   • **A template cannot go stale.** When a block's schema gains a field, loses one, or changes a
 *     default, every template follows on the next use. A template that stored payloads would keep handing
 *     out last release's shape until somebody noticed a block rendering wrongly on a page nobody had
 *     edited.
 *   • **Every payload is valid by construction.** It is produced by the schema and then validated against
 *     the same schema, so a template can never create the editor-only error card that an invalid
 *     `PageSection.data` renders as.
 *
 * `overrides` is the one place a template supplies values of its own, and it is deliberately narrow: a
 * heading a template can state confidently ("How to apply"), a filter that makes a block mean what the
 * template says it means ("faculty only"). It is MERGED OVER the seed and re-parsed, so a key that no
 * longer exists is stripped by `z.object()` rather than failing — a template can therefore lose a nicety
 * across a schema change but can never produce an invalid payload.
 *
 * WHAT IS DELIBERATELY *NOT* OVERRIDDEN: the words only the Centre can write. A hero's headline keeps its
 * "Add a headline" prompt, because a template that filled it with something plausible would be a template
 * whose text gets published. The content health report (lib/health.ts) finds exactly those prompts on a
 * published page and says so, which is the second half of the same idea.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * NO `server-only`. There is no database access and no environment reading in this file, so a client
 * screen can render a template's preview from the same source the server builds the page from.
 *
 * ⚠ NO TEMPLATE MAY CONTAIN TWO BLOCKS OF A TYPE WHOSE `allowMultiple` IS FALSE — one hero, one contact
 * form, one embedded form, one craft explorer. `pageTemplateProblems()` at the foot of this file checks
 * that against the registry when this module is first loaded, because a template that offers an
 * arrangement the builder itself refuses to extend is worse than no template.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ARRANGEMENTS BELOW ARE THE BUILT-INS. AN ADMINISTRATOR MAY ADD, EDIT AND RETIRE TEMPLATES OF THEIR
 * OWN, and those live in the `PageTemplate` table. `mergePageTemplates()` at the foot of this file is
 * where the two lists become one, and its rules are short:
 *
 *   • a row whose `key` equals a built-in's `id` **replaces** that built-in, in its place in the list;
 *   • a row with any other key is an additional template, after the built-ins;
 *   • `isHidden` retires either — a hidden row shadowing a built-in is the only way to withdraw one of
 *     the arrangements below, since a file cannot be deleted from a database.
 *
 * ⚠ THE DATABASE ROW FOLLOWS THE SAME RULE AS THIS FILE: TYPES AND LABELS, NEVER PAYLOADS. A stored
 * `blocks` value is read by `readStoredBlocks()` below, which keeps only `type`, `label`, `purpose` and
 * `overrides` and drops anything it does not recognise. Payloads are still built at the moment of use by
 * `defaultSectionData()`, so a template an administrator wrote last year cannot go stale either.
 *
 * ⚠ STILL NO `server-only`, AND STILL NO PRISMA IMPORT. The screens read the table and hand the rows in;
 * this module only merges them. Importing `@/lib/db` here would take the whole templates screen — and any
 * client component that renders a preview — out of the client graph.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface TemplateBlockSpec {
  type: SectionType;
  /**
   * Written onto `PageSection.label` — the editor-facing name, never rendered on the site. It is what
   * makes a builder row read "Hero — the programme in one line" instead of "HERO", which is most of the
   * value of starting from a template at all.
   */
  label: string;
  /** One sentence for the preview: why this block is in this arrangement, and what to put in it. */
  purpose: string;
  /** Values merged over the seeded default. See the header before adding one. */
  overrides?: Record<string, unknown>;
}

export interface PageTemplate {
  /** Stable and URL-safe: it travels in a form field and is matched against this list on the way back. */
  id: string;
  /** A noun phrase, as an administrator would name the thing they are about to make. */
  name: string;
  /** Two sentences: what this arrangement is for, and when to reach for it instead of a blank page. */
  description: string;
  /** Pre-filled into the title field, so the form is never a blank box with no hint of what goes in it. */
  suggestedTitle: string;
  /** A `lucide-react` export name, as a string — this module stays free of JSX and of the icon set. */
  icon: string;
  blocks: readonly TemplateBlockSpec[];
}

/** One block, ready to be written to `PageSection`. */
export interface TemplateSection {
  type: SectionType;
  label: string;
  /** A parsed, valid payload. Fresh on every call — see `templateSections`. */
  data: unknown;
  /** Dense and 0-based, which is what the builder and `@@unique([pageId, position])` both assume. */
  position: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// The templates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The arrangements, in the order an institution is most likely to need them.
 *
 * Each one is a composition somebody would otherwise have to work out from a palette of thirty-two
 * blocks: what goes at the top, what the reader needs before they act, and where the invitation belongs.
 *
 * The order is an editorial claim, not the order they were written: the pages a Centre needs first, then
 * the occasions it holds and invites people to, then the three that are about people, then the two that
 * are mostly words.
 *
 * ⚠ `icon` IS NOT ANY LUCIDE NAME. The templates screens draw it through `templateIcon()` in
 * components/studio/templates/templateIcons.ts, which is a CLOSED map — explicit rather than a dynamic
 * lookup, so that a screen rendering one card does not pull fifteen hundred icons into its bundle. A name
 * outside that map is not an error: it resolves to `LayoutTemplate`, silently, on every card. So an icon
 * added here needs an entry there as well, or the template arrives wearing the generic mark and nothing
 * anywhere says why.
 */
export const PAGE_TEMPLATES: readonly PageTemplate[] = [
  {
    id: "programme",
    name: "Programme or course",
    description:
      "A page that explains one programme and takes applications for it. Use it for a course, a residency, a fellowship or a training week.",
    suggestedTitle: "Programme name",
    icon: "GraduationCap",
    blocks: [
      {
        type: "HERO",
        label: "Hero — the programme in one line",
        purpose:
          "The name of the programme, one sentence on who it is for, and a button to the application form."
      },
      {
        type: "RICH_TEXT",
        label: "About the programme",
        purpose: "What it covers, how long it runs, where it is held and what it costs.",
        overrides: { heading: "About this programme" }
      },
      {
        type: "FEATURE_GRID",
        label: "What it covers",
        purpose: "Three or four cards: the modules, the skills learnt, the workshops and equipment.",
        overrides: { heading: "What you will learn", columns: 3 }
      },
      {
        type: "ACTION_STEPS",
        label: "How to apply",
        purpose:
          "Each step with its own closing date and button, in the order an applicant has to do them.",
        overrides: { heading: "How to apply" }
      },
      {
        type: "PEOPLE_SHOWCASE",
        label: "Who teaches it",
        purpose:
          "Faculty drawn from the People screen. Set it to choose by hand if only some of them teach on this programme.",
        overrides: { heading: "Who teaches it", kind: "FACULTY", limit: 6 }
      },
      {
        type: "FAQ",
        label: "Questions applicants ask",
        purpose:
          "The questions that arrive by email every year. Answering them here is the cheapest work on this page.",
        overrides: { heading: "Questions applicants ask" }
      },
      {
        type: "CTA",
        label: "Apply, or ask",
        purpose: "One invitation at the foot of the page, with somewhere to write for anything unanswered.",
        overrides: { tone: "brand" }
      }
    ]
  },

  {
    id: "call-for-applications",
    name: "Call for applications",
    description:
      "An open call with a deadline: the offer, what to do, the form itself and the paperwork. Use it for a grant round, a residency call, admissions or a tender. Where the Centre is inviting contributions to something it is making, rather than choosing who receives something, “Call for participation” is that page.",
    suggestedTitle: "Call for applications",
    /*
     * ⚠ Every `icon` in this file is a name lucide still exports at the version in package.json AND an
     * entry in the closed map in components/studio/templates/templateIcons.ts — see the note on
     * `PAGE_TEMPLATES` above for why the second half is the one that bites. lucide has renamed whole
     * families before (the registry's `HelpCircle` is now `CircleHelp`), and a name that has gone is
     * resolved by the screen rather than throwing: `templateIcon()` answers `LayoutTemplate`, which is
     * the generic template mark and not the plain square `blockIcon()` falls back to.
     */
    icon: "FileCheck",
    blocks: [
      {
        type: "HERO",
        label: "Hero — the offer and the closing date",
        purpose:
          "What is on offer and when it closes. Put the deadline in the headline: it is the fact every reader came for."
      },
      {
        type: "ACTION_STEPS",
        label: "What to do, in order",
        purpose:
          "Each step with its own closing date. A step whose date has passed says so on the page whatever else is set, so nothing here can contradict itself.",
        overrides: { heading: "How to apply", numbered: true }
      },
      {
        type: "FORM_EMBED",
        label: "The application form",
        purpose:
          "The Google, Microsoft or Typeform form. Readers open it with a button, so nothing loads from the form's own service until somebody wants it, and there is always a plain link as well.",
        overrides: { height: "lg" }
      },
      {
        type: "LINK_GRID",
        label: "Guidelines and forms",
        purpose:
          "The rules, the budget template, last year's call — whether they live in this site's file store or on somebody else's website.",
        overrides: { heading: "Guidelines and forms", columns: 3 }
      },
      {
        type: "FAQ",
        label: "Questions about the call",
        purpose:
          "Eligibility, what counts as evidence, whether late applications are accepted. Use the words applicants use.",
        overrides: { heading: "Questions about this call" }
      },
      {
        type: "CTA",
        label: "Who to ask",
        purpose:
          "A named way to reach somebody. An open call with no contact turns every uncertainty into a withdrawn application.",
        overrides: { tone: "quiet" }
      }
    ]
  },

  {
    id: "call-for-participation",
    name: "Call for participation",
    description:
      "An invitation to contribute to something the Centre is making: papers for a conference, works for a show, practitioners for a field survey. What is invited, what makes a strong proposal, the dates, and how to send it. Where the reader would instead be applying to receive something — a grant, a place, a residency — “Call for applications” is that page.",
    suggestedTitle: "Call for participation",
    icon: "Megaphone",
    blocks: [
      {
        type: "HERO",
        label: "Hero — what is invited, and by when",
        purpose:
          "What is being invited and the closing date. The date belongs in the headline: it decides whether a reader starts writing today or files the page and forgets it."
      },
      {
        type: "RICH_TEXT",
        label: "About this call",
        purpose:
          "What is being made, who is making it, and where a contribution ends up — a proceedings, a wall, a report. Somebody deciding whether to spend a fortnight on a proposal decides on this paragraph.",
        overrides: { heading: "About this call", width: "narrow" }
      },
      {
        type: "FEATURE_GRID",
        label: "What is invited",
        purpose:
          "The strands, themes or kinds of contribution, a card each. Naming them narrowly brings fewer submissions and more usable ones, which is the arithmetic that decides how long the reading takes.",
        overrides: { heading: "What is invited", columns: 3 }
      },
      {
        type: "RICH_TEXT",
        /*
         * ⚠ PROSE, NOT A SECOND FEATURE GRID, AND THE TWO BLOCKS ARE NOT INTERCHANGEABLE. What is
         * invited is a list of nouns and reads as cards. Criteria are qualified sentences — "fieldwork
         * carried out in the last five years, or older work with the practitioner's consent" — and a
         * card body is capped at 280 characters, so putting them there forces every condition to be cut
         * down to a fragment. A criterion a reader has to guess the rest of is a criterion an assessor
         * spends the reading period explaining by email.
         */
        label: "What we are looking for",
        purpose:
          "The criteria, in sentences: who may submit, what state the work has to be in, what will not be considered. Say the exclusions out loud — they save more time than the inclusions do.",
        overrides: { heading: "What we are looking for", width: "narrow" }
      },
      {
        type: "TIMELINE",
        label: "Key dates",
        purpose:
          "Closing date, notification, and the occasion itself. The date field is free text, so “Late March” is allowed where a day has not been fixed — which is more honest than inventing one and correcting it later.",
        overrides: { heading: "Key dates", orientation: "vertical" }
      },
      {
        type: "ACTION_STEPS",
        label: "How to submit",
        purpose:
          "What to send, in what format, and where to send it, in the order it has to be done. Each step carries its own closing date, and one that has passed is stated as passed whatever else is set.",
        overrides: { heading: "How to submit", numbered: true }
      },
      {
        type: "DOWNLOADS",
        label: "The brief and the templates",
        purpose:
          "The call document, the proposal template, last year's brief — from the file store, each with its size beside it so nobody starts a 40 MB download on a phone by accident.",
        overrides: { heading: "The brief and the templates" }
      },
      {
        type: "FAQ",
        label: "Questions about the call",
        purpose:
          "Whether co-authored work counts, whether a proposal may be withdrawn, what happens to material that is not selected. Use the words the people asking would use.",
        overrides: { heading: "Questions about this call" }
      },
      {
        type: "CONTACT_FORM",
        /*
         * ⚠ THE CONTACT FORM, NOT THE EMBEDDED ONE — and that is the sharpest difference between this
         * template and "Call for applications" beside it. An application is a form somebody fills in, so
         * that page frames the Google or Microsoft form itself. A CONTRIBUTION is usually a file that
         * travels to whichever address the steps above name, and there is nothing to frame; what this
         * page needs instead is a way to ask a question BEFORE spending a fortnight writing something
         * that turns out to be ineligible.
         *
         * ⚠ `formKey` DECIDES WHICH INBOX AND WHO IS NOTIFIED. It mirrors `ContactSubmission.formKey`
         * and is a closed list for that reason: "collaboration" is where a proposal enquiry belongs, and
         * leaving it on "general" files it behind every enquiry the site receives, in a box read on a
         * different schedule from the one this call runs on.
         */
        label: "Ask before you submit",
        purpose:
          "Questions the answers above did not settle, going to the collaboration inbox. Say in the body roughly how long a reply takes, and whether questions are answered after the closing date.",
        overrides: { heading: "Ask before you submit", formKey: "collaboration" }
      }
    ]
  },

  {
    id: "annual-report",
    name: "Annual report",
    description:
      "The year in figures, in words and in work, with the report itself to download. Use it once a year, and copy last year's page rather than starting again.",
    suggestedTitle: "Annual report 2026",
    icon: "ChartNoAxesCombined",
    blocks: [
      {
        type: "HERO",
        label: "Hero — the year",
        purpose: "The year and one sentence on what it was. Keep it short: the figures speak next.",
        overrides: { showScrollCue: true }
      },
      {
        type: "STATS",
        label: "The year in figures",
        purpose:
          "Five or six headline numbers. Say in the small print where they come from and as at what date — a figure with no source is one nobody can defend in a meeting.",
        overrides: { heading: "The year in figures", countUp: true }
      },
      {
        type: "RICH_TEXT",
        label: "The Director's overview",
        purpose: "The narrative: what was attempted, what worked, what did not.",
        overrides: { heading: "Overview" }
      },
      {
        type: "TIMELINE",
        label: "What happened, month by month",
        purpose:
          "Dated entries. The date is written as text, so “March”, “Q2” and “2024–26” are all allowed.",
        overrides: { heading: "The year in order", orientation: "vertical" }
      },
      {
        type: "PROJECT_SHOWCASE",
        label: "Projects",
        purpose: "Drawn from the Projects screen, so this page cannot disagree with them.",
        overrides: { heading: "Projects this year", limit: 6 }
      },
      {
        type: "PUBLICATION_LIST",
        label: "Publications",
        /*
         * ⚠ THE PURPOSE LINE AND THE OVERRIDE MUST AGREE, and for a while they did not: this said
         * "grouped by year" and then set `groupByYear: false`. The administrator reads the purpose
         * on the template's preview card, adds the page, and finds a flat list — with nothing
         * anywhere explaining which of the two was the mistake.
         *
         * The OVERRIDE is what changed, not the sentence. An annual report covers ONE year, so
         * grouping by year is a heading repeated over a single group — which is why `false` was
         * written in the first place. The sentence now says that, and says it in the words an
         * administrator would need in order to change it.
         */
        purpose:
          "In citation form, from the Publications screen. Not grouped by year — this page is one year — so set the block to group by year only if you are listing several.",
        overrides: { heading: "Published this year", groupByYear: false, limit: 20 }
      },
      {
        type: "DOWNLOADS",
        label: "The report itself",
        purpose:
          "The full report as a file, with its size beside it so nobody starts a 40 MB download on a phone by accident.",
        overrides: { heading: "Download the full report" }
      },
      {
        type: "PARTNER_LOGOS",
        label: "Funders and partners",
        purpose: "Drawn in one tone, so a wall of clashing brand colours does not end the page loudly.",
        overrides: { heading: "With the support of" }
      }
    ]
  },

  {
    id: "event",
    name: "Event or conference",
    description:
      "One occasion, with its dates, its programme, the people speaking at it and how to register. Use it for a conference, a symposium, a public lecture or a study day — anything a reader has to be in a particular place on a particular day for.",
    suggestedTitle: "Event name",
    icon: "CalendarDays",
    blocks: [
      {
        type: "HERO",
        label: "Hero — the event, its dates and where",
        purpose:
          "The name of the event, the dates and the city. A reader deciding whether to come needs all three before anything else, and a hero is the only place on the page they are guaranteed to look."
      },
      {
        type: "RICH_TEXT",
        label: "About the event",
        purpose:
          "What it is about, who it is for, and what it costs. Two or three paragraphs — the programme below answers everything else, and a reader who wants detail is already scrolling towards it.",
        overrides: { heading: "About this event", width: "narrow" }
      },
      {
        type: "TIMELINE",
        /*
         * ⚠ A TIMELINE RATHER THAN AN EVENTS BLOCK, AND THE DIFFERENCE IS WHICH RECORDS EACH DRAWS ON.
         * EVENT_SHOWCASE lists `Event` rows from the calendar; a conference is ONE of those rows, and its
         * sessions are not occasions anybody would want appearing in the site-wide calendar or in the
         * "what is on" block on the homepage. So the programme is content this page owns.
         *
         * The timeline is the right shape for it because its `year` field is deliberately free text —
         * the schema allows "1947", "c. 1780" and a period name for the same reason — so "09:30", "Day
         * two" and "Friday afternoon" all parse and all read correctly.
         */
        label: "The programme",
        purpose:
          "Session by session. The date field is free text, so “09:30”, “Day two” and “Friday afternoon” are all allowed — write it as it would read on a printed programme.",
        overrides: { heading: "Programme", orientation: "vertical" }
      },
      {
        type: "PEOPLE_SHOWCASE",
        /*
         * ⚠ THE SEEDED LINK IS CLEARED, and it is the one override here that is not cosmetic. A people
         * block arrives reading "Meet the team → /people": under a list of visiting speakers that sends
         * the reader to the Centre's own staff directory, which is neither where they were going nor a
         * list most of these people are on. Cleared rather than repointed — a speaker list has nowhere
         * else to go — and `ctaLabel` alone would not do it, because the renderer draws the link only
         * when it has BOTH the words and the address.
         *
         * `kind` is deliberately not set. There is no speaker among the person kinds (faculty,
         * scientist, researcher, student, staff, visitor, alumnus), so any filter here would be
         * a claim about the wrong column.
         */
        label: "Who is speaking",
        purpose:
          "Set the block to Chosen by hand and pick them. Left on Latest it shows whoever was added to People most recently, which is a list nobody meant to publish under this heading.",
        overrides: {
          heading: "Who is speaking",
          limit: 12,
          layout: "grid",
          showRole: true,
          ctaLabel: "",
          ctaHref: ""
        }
      },
      {
        type: "ACTION_STEPS",
        label: "How to register",
        purpose:
          "Registration, the fee and the deadline, in the order they have to be done. Each step carries its own closing date, and a date that has passed says so on the page whatever else is set.",
        overrides: { heading: "How to register", numbered: true }
      },
      {
        type: "MAP",
        label: "The venue",
        purpose:
          "A pin with the postal address beside it. Somebody who has printed this page, or lost their connection at the station, still needs the address to be words.",
        overrides: { heading: "The venue" }
      },
      {
        type: "FAQ",
        label: "Questions people ask before coming",
        purpose:
          "Travel, accommodation, whether the sessions are recorded, whether lunch is included. These arrive by email before every event, and answering them here is the cheapest work on this page.",
        overrides: { heading: "Before you come" }
      },
      {
        type: "PARTNER_LOGOS",
        label: "Hosts and supporters",
        purpose:
          "Who is holding the event and who paid for it, drawn in one tone so a wall of brand colours does not shout over the invitation below it.",
        overrides: { heading: "Organised with" }
      },
      {
        type: "CTA",
        label: "Register, or ask",
        purpose:
          "One invitation at the foot of the page, and somewhere to write for anything the questions above did not settle.",
        overrides: { tone: "brand" }
      }
    ]
  },

  {
    id: "workshop",
    name: "Workshop",
    description:
      "A few days of hands-on teaching: what it is, who it is for, what to bring and how to get a place. Use it for a masterclass, a training week, a summer school or a short course. “Programme or course” is the longer version of the same page, for something that runs for a term.",
    suggestedTitle: "Workshop title",
    icon: "Presentation",
    blocks: [
      {
        type: "HERO",
        label: "Hero — the workshop, its dates and how many places",
        purpose:
          "The name, the dates and the number of places. Twelve places is a different decision from two hundred seats, and a reader who learns the number after applying has been wasted."
      },
      {
        type: "RICH_TEXT",
        label: "What this workshop is",
        purpose:
          "What is taught and how the days are spent. Say what somebody leaves with — a finished piece, a technique, a certificate — because that is what every enquiry is really asking.",
        overrides: { heading: "What this workshop is", width: "narrow" }
      },
      {
        type: "FEATURE_GRID",
        label: "Who it is for",
        /*
         * Two columns rather than the default three: this grid holds two or three kinds of person, and a
         * three-column grid with two cards in it leaves a gap that reads as a card that failed to load.
         */
        purpose:
          "The people this is meant for: beginners, practising weavers, teachers, design students. Somebody who cannot find themselves here either writes to ask, or quietly does not apply.",
        overrides: { heading: "Who it is for", columns: 2 }
      },
      {
        type: "ACTION_STEPS",
        /*
         * ⚠ NUMBERING OFF, AND THE SCHEMA ITSELF NAMES THIS CASE: `numbered` says to turn it off "for a
         * checklist where the order does not matter — 'what to bring' rather than 'how to apply'". The
         * flag is not decoration; it also tells a screen reader whether the list is a sequence, so a
         * numbered kit list states an order that does not exist and invites somebody to worry about it.
         */
        label: "What to bring",
        purpose:
          "Materials, tools, clothing, anything to read beforehand. Unnumbered on purpose: a kit list is not a sequence, and numbers on one imply an order nobody has to follow.",
        overrides: { heading: "What to bring", numbered: false }
      },
      {
        type: "ACTION_STEPS",
        label: "How to apply",
        purpose:
          "Each step with its own closing date and button, in the order an applicant has to do them. Two step lists on one page is the ordinary case: this one is a sequence, the one above is not.",
        overrides: { heading: "How to apply", numbered: true }
      },
      {
        type: "PEOPLE_SHOWCASE",
        label: "Who leads it",
        // The seeded "Meet the team → /people" link is cleared for the reason set out on the event
        // template above: under the one or two people running a workshop it points at the staff
        // directory, which is a different list and a different question.
        purpose:
          "The one or two people running it, chosen by hand. Left on Latest this shows the newest profiles in People, who are unlikely to be them.",
        overrides: { heading: "Who leads it", limit: 4, showRole: true, ctaLabel: "", ctaHref: "" }
      },
      {
        type: "MAP",
        label: "Where it is held",
        purpose:
          "A pin and the postal address. A workshop is somewhere somebody has to physically arrive with their hands free, so the address matters more here than on almost any other page.",
        overrides: { heading: "Where it is held" }
      },
      {
        type: "CTA",
        label: "Apply, or ask",
        purpose:
          "Quiet, because the steps above have already asked once. A second loud panel a screen further down stops meaning anything.",
        overrides: { tone: "quiet" }
      }
    ]
  },

  {
    id: "exhibition",
    name: "Exhibition",
    description:
      "A show, with its dates, its photographs and how to get there. Use it for an exhibition, a display or an open studio.",
    suggestedTitle: "Exhibition title",
    icon: "Frame",
    blocks: [
      {
        type: "HERO",
        label: "Hero — the show and its dates",
        purpose: "The title, the dates it is open and where. Nothing else belongs above the fold."
      },
      {
        type: "RICH_TEXT",
        label: "About the exhibition",
        purpose: "What is shown, who made it and why it is being shown now.",
        overrides: { heading: "About the exhibition" }
      },
      {
        type: "MEDIA_SPLIT",
        label: "One work, up close",
        purpose:
          "A single photograph beside a paragraph about it. Upload the picture yourself — the caption is separate from the picture's own description.",
        overrides: { heading: "One work, up close", side: "left" }
      },
      {
        type: "GALLERY",
        label: "The photographs",
        purpose:
          "An album from the media library, opening full screen with its caption and credit beneath.",
        overrides: { heading: "In the gallery", source: "albums", layout: "masonry" }
      },
      {
        type: "EVENT_SHOWCASE",
        label: "Talks and tours",
        purpose:
          "Upcoming events from the calendar. The list empties itself as each one passes, so it is never out of date.",
        overrides: { heading: "Talks and tours", when: "upcoming", layout: "list" }
      },
      {
        type: "MAP",
        label: "How to find it",
        purpose:
          "A pin with the postal address beside it, so the address can be read whether or not the map loads.",
        overrides: { heading: "How to find us" }
      },
      {
        type: "CTA",
        label: "Plan a visit",
        purpose: "Opening hours, admission, and how to book a group.",
        overrides: { tone: "quiet" }
      }
    ]
  },

  {
    id: "season",
    name: "Festival or season",
    description:
      "Many occasions under one name, over weeks rather than a day: what the season is, what is on, what has already happened, and where it all takes place. Use it for a festival, a lecture series, a season of screenings or an open-studios fortnight. One occasion belongs on “Event or conference” instead.",
    suggestedTitle: "Season name",
    icon: "Layers",
    blocks: [
      {
        type: "HERO",
        label: "Hero — the season and the weeks it runs",
        purpose:
          "The name of the season and the dates it spans. No single occasion's title above the fold: this page outlives every event on it, and a headline naming next Tuesday's lecture is wrong by Wednesday."
      },
      {
        type: "RICH_TEXT",
        label: "About the season",
        purpose:
          "What holds these occasions together, who is behind them, and whether any of it has to be booked. Two paragraphs — the events themselves are the page.",
        overrides: { heading: "About this season", width: "narrow" }
      },
      {
        type: "EVENT_SHOWCASE",
        label: "What is on",
        purpose:
          "Upcoming events from the calendar, soonest first. Nothing is typed here: publish an event in the studio and it appears, and it leaves on its own the day after it happens.",
        overrides: { heading: "What is on", when: "upcoming", layout: "list", limit: 12 }
      },
      {
        type: "EVENT_SHOWCASE",
        /*
         * ⚠ THE SECOND EVENTS BLOCK IS THE SAME LIST ON THE OTHER SIDE OF TODAY, AND IT IS WHAT KEEPS A
         * SEASON PAGE FROM EMPTYING ITSELF. "Upcoming" is honest but merciless: in the last week of a
         * festival the block above holds one entry, and on the closing night it holds none — so a page
         * that was the whole season reads as though the season was cancelled. This block fills at exactly
         * the rate the other empties, and it is the more useful half by then, because the reader arriving
         * that late is deciding whether to come to the next one.
         *
         * ⚠ THE LINK IS CLEARED because the block above already carries it. Two links reading "See all
         * events" pointing at the same page is the same destination announced twice, and a screen reader
         * moving through the links hears no difference between them. `ctaHref` goes too: the renderer
         * draws the link only when it has both.
         */
        label: "What has already happened",
        purpose:
          "The same calendar, counting backwards. It fills as the block above empties, so the page still says something on the closing night — and photographs of it belong in the gallery below.",
        overrides: {
          heading: "What has already happened",
          when: "past",
          layout: "list",
          limit: 12,
          ctaLabel: "",
          ctaHref: ""
        }
      },
      {
        type: "GALLERY",
        label: "In pictures",
        purpose:
          "Albums from the media library — last year's season, or this one as it goes. Photographs of a full room are what brings somebody to the next occasion.",
        overrides: { heading: "In pictures", source: "albums", layout: "masonry", limit: 6 }
      },
      {
        type: "PARTNER_LOGOS",
        label: "Funders and hosts",
        purpose:
          "Who paid for the season and whose rooms it happens in, drawn in one tone so a wall of clashing brand colours does not end the page loudly.",
        overrides: { heading: "With the support of" }
      },
      {
        type: "MAP",
        label: "Where it happens",
        /*
         * ⚠ ONE PIN, AND A SEASON USUALLY HAS SEVERAL VENUES. The map block holds a single latitude and
         * longitude by design, so this is the main venue or the box office, and each event's own record
         * carries the room it is in. A page that pinned only the first venue and said nothing would send
         * a reader to the wrong building, which is worse than a map that names what it is.
         */
        purpose:
          "The main venue, with its postal address beside the pin. Where the season is spread across several places, say so in the heading and leave the rest to each event's own record.",
        overrides: { heading: "The main venue" }
      },
      {
        type: "CTA",
        label: "Plan a visit",
        purpose: "Opening times, tickets, and how to bring a group.",
        overrides: { tone: "quiet" }
      }
    ]
  },

  {
    id: "faculty",
    name: "Faculty directory",
    description:
      "Who teaches here, in one place: an introduction, the faculty themselves drawn from the People screen, and the questions prospective students ask before they apply. Use it for a department, a school, or the teaching staff of one programme.",
    suggestedTitle: "Our faculty",
    icon: "School",
    blocks: [
      {
        type: "HERO",
        label: "Hero — who teaches here",
        purpose:
          "The name of the department or school and one sentence on what its teachers work on. No names above the fold: the directory below is the list, and a headline naming two people dates the moment either of them leaves."
      },
      {
        type: "RICH_TEXT",
        label: "About the faculty",
        purpose:
          "What they teach, what they research, and how many of them there are. Two paragraphs is plenty — a reader who wants more is one click away from a profile.",
        overrides: { heading: "About the faculty", width: "narrow" }
      },
      {
        type: "PEOPLE_SHOWCASE",
        label: "The faculty",
        purpose:
          "Everybody filed as Faculty on the People screen, with their designations. Nothing is typed here: add somebody in People and they appear, and a departure is one change rather than two.",
        overrides: { heading: "The faculty", kind: "FACULTY", limit: 24, layout: "grid", showRole: true }
      },
      {
        type: "FAQ",
        label: "Questions prospective students ask",
        purpose:
          "Who supervises what, whether a teacher is taking students this year, and how to approach one. These arrive by email every admissions season, and answering them here is the cheapest work on this page.",
        overrides: { heading: "Questions students ask" }
      },
      {
        type: "CTA",
        label: "Ask about teaching",
        purpose:
          "One named way to reach the department for anything the questions above did not settle. Quiet, because the directory is what this page is for.",
        overrides: { tone: "quiet" }
      }
    ]
  },

  {
    id: "person-or-team",
    name: "Person or team page",
    description:
      "A profile with room for the work: a portrait, a biography, and the publications and projects that belong to it. Use it for a chair, a laboratory or a unit that needs more than the People directory gives it.",
    suggestedTitle: "Name of the person or team",
    icon: "UserRoundSearch",
    blocks: [
      {
        type: "MEDIA_SPLIT",
        label: "Portrait and introduction",
        purpose:
          "A photograph beside two or three sentences. A hero would be too loud for one person, and this puts the face and the summary side by side.",
        overrides: { side: "left" }
      },
      {
        type: "RICH_TEXT",
        label: "Biography",
        purpose: "The long form: training, positions held, awards, current interests.",
        overrides: { heading: "Biography", width: "narrow" }
      },
      {
        type: "PUBLICATION_LIST",
        label: "Selected publications",
        purpose:
          "Choose by hand for a person, so the list is theirs rather than the whole Centre's. Set to Chosen by hand in the block's settings.",
        overrides: { heading: "Selected publications", groupByYear: true, limit: 20 }
      },
      {
        type: "PROJECT_SHOWCASE",
        label: "Projects",
        purpose: "The work this profile is responsible for, drawn from the Projects screen.",
        overrides: { heading: "Projects", limit: 6, layout: "list" }
      },
      {
        type: "PEOPLE_SHOWCASE",
        label: "The wider team",
        purpose: "Colleagues, students and assistants, from the People screen.",
        overrides: { heading: "The team", limit: 12 }
      },
      {
        type: "CTA",
        label: "Get in touch",
        purpose: "How to write, and what sort of enquiry is welcome.",
        overrides: { tone: "quiet" }
      }
    ]
  },

  {
    id: "researcher",
    name: "Researcher's profile",
    description:
      "One researcher's page, with room for the work behind the name: a portrait, a biography, the areas they work in, what they have published, what they are running, and how to write to them. Reach for “Person or team page” instead where the research areas would be empty — it is the same shape without them.",
    suggestedTitle: "Name of the researcher",
    icon: "Microscope",
    blocks: [
      {
        type: "MEDIA_SPLIT",
        label: "Portrait and introduction",
        purpose:
          "A photograph beside two or three sentences: what they work on, said in words a reader outside the field can follow. A hero would be too loud for one person, and this puts the face and the summary side by side.",
        overrides: { side: "left" }
      },
      {
        type: "RICH_TEXT",
        label: "Biography",
        purpose:
          "The long form: training, positions held, awards, and what they are working on now. Narrow width holds it to a comfortable reading measure.",
        overrides: { heading: "Biography", width: "narrow" }
      },
      {
        type: "RESEARCH_SHOWCASE",
        label: "Research areas",
        purpose:
          "The themes they work under, drawn from the Research areas screen. Set it to Chosen by hand, or this shows the whole Centre's areas rather than theirs.",
        overrides: { heading: "Research areas", limit: 6, layout: "grid" }
      },
      {
        type: "PUBLICATION_LIST",
        label: "Publications",
        purpose:
          "In citation form, grouped by year, from the Publications screen. Choose by hand for one person — the default is the Centre's newest, which is not the same list.",
        overrides: { heading: "Publications", groupByYear: true, limit: 30 }
      },
      {
        type: "PROJECT_SHOWCASE",
        label: "Projects",
        purpose:
          "The funded work they lead or sit on, from the Projects screen. A list rather than a grid: a profile is read top to bottom, and cover images halfway down it interrupt that.",
        overrides: { heading: "Projects", limit: 6, layout: "list" }
      },
      {
        type: "CTA",
        label: "How to reach them",
        purpose:
          "Where to write, and what sort of enquiry is welcome — supervision, collaboration, press. A profile with no way to answer it is a page that generates email to somebody else.",
        overrides: { tone: "quiet" }
      }
    ]
  },

  {
    id: "article",
    name: "Simple article page",
    description:
      "Words, a quotation and somewhere to read next. Use it for a policy, a statement, a piece of guidance or anything that is mostly text — a news story belongs in the newsroom instead.",
    suggestedTitle: "Page title",
    icon: "TextQuote",
    blocks: [
      {
        type: "RICH_TEXT",
        label: "The opening",
        purpose:
          "The first part of the text. Narrow width holds it to a comfortable reading measure of about 68 characters.",
        overrides: { width: "narrow" }
      },
      {
        type: "QUOTE",
        label: "A quotation",
        purpose:
          "One quotation set large across the column, to break a long passage. Delete it if there is nothing worth quoting.",
        overrides: { alignment: "center" }
      },
      {
        type: "RICH_TEXT",
        label: "The rest",
        purpose: "The remainder of the text, after the break.",
        overrides: { width: "narrow" }
      },
      {
        type: "LINK_GRID",
        label: "Further reading",
        purpose: "Where to go next — on this site or another one.",
        overrides: { heading: "Further reading", columns: 2 }
      }
    ]
  },

  {
    id: "blog",
    name: "Blog or journal index",
    description:
      "The front door to writing that keeps arriving: what the journal is, the pieces themselves pulled from the newsroom, and where to read next. Use it for a departmental blog, a field diary or a series of essays — the writing is done in News, and this page only introduces it.",
    suggestedTitle: "Journal",
    icon: "NotebookPen",
    blocks: [
      {
        type: "HERO",
        label: "Hero — the journal and what it is about",
        purpose:
          "The name of the journal and one sentence on what appears in it. No dates and no piece titles: this page outlives every entry on it, and a headline naming last spring's essay is out of date by summer."
      },
      {
        type: "RICH_TEXT",
        label: "What this journal is",
        purpose:
          "Who writes it, roughly how often something appears, and what a reader will find. Two paragraphs is plenty.",
        overrides: { heading: "About this journal", width: "narrow" }
      },
      {
        type: "NEWS_SHOWCASE",
        label: "The writing itself",
        purpose:
          "The pieces, newest first, from the newsroom. Nothing is written on this page: publish a piece in News and it appears here on its own, which is what stops an index quietly falling a year behind.",
        overrides: { heading: "Latest writing", layout: "feature", limit: 12 }
      },
      {
        type: "LINK_GRID",
        label: "Where to read next",
        purpose:
          "The archive, the categories worth starting from, a colleague's journal elsewhere. A reader who has finished the newest piece is the one most likely to follow a link.",
        overrides: { heading: "Where to read next", columns: 2 }
      },
      {
        type: "CTA",
        label: "Write for it, or follow it",
        purpose:
          "How to contribute a piece, or how to hear when the next one appears. Quiet, so it closes the page rather than competing with the writing above it.",
        overrides: { tone: "quiet" }
      }
    ]
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// Using a template
// ─────────────────────────────────────────────────────────────────────────────

/** The BUILT-IN template with this id, or null. Never throws: the id arrives from a form field. */
export function pageTemplate(id: string): PageTemplate | null {
  return PAGE_TEMPLATES.find((template) => template.id === id.trim()) ?? null;
}

/**
 * The template with this id from a merged list, or null.
 *
 * Separate from `pageTemplate` above rather than replacing it, because the two answer different
 * questions: "is this one of the arrangements that ship with the software" and "is this one of the templates
 * this installation offers". The create-a-page action needs the second; the merge itself needs the first.
 */
export function findPageTemplate<T extends PageTemplate>(
  templates: readonly T[],
  id: string
): T | null {
  const wanted = id.trim();
  return templates.find((template) => template.id === wanted) ?? null;
}

/**
 * The blocks a template creates, with valid payloads and dense positions.
 *
 * FRESH OBJECTS EVERY CALL, like `defaultSectionData()` itself: handing out a shared constant would let
 * one edited block rewrite the template for every page created afterwards.
 *
 * A payload that fails to parse is a PROGRAMMING error in the `overrides` above, not an editor's, so it
 * falls back to the plain seeded default and logs. Refusing to create the page would strand somebody who
 * pressed a button, for a mistake they cannot see and could not fix.
 */
export function templateSections(template: PageTemplate): TemplateSection[] {
  return template.blocks.map((block, index) => ({
    type: block.type,
    label: block.label,
    data: payloadFor(block),
    position: index
  }));
}

function payloadFor(block: TemplateBlockSpec): unknown {
  const seed = defaultSectionData(block.type);
  if (!block.overrides) return seed;

  const base =
    seed !== null && typeof seed === "object" && !Array.isArray(seed)
      ? (seed as Record<string, unknown>)
      : {};

  const parsed = parseSectionData(block.type, { ...base, ...block.overrides });
  if (parsed.ok) return parsed.data;

  console.error(
    `[page-templates] the overrides for a ${block.type} block ("${block.label}") do not satisfy its schema, ` +
      `so the plain default was used instead: ${parsed.message}`
  );
  return seed;
}

/** One row of a template's preview: what the block is called here, and what it is called in the palette. */
export interface TemplateBlockPreview {
  /** Stable within a template, so it can be a React key. Two blocks may share a type. */
  key: string;
  /** The template's own name for the block. */
  label: string;
  /** The palette's name for the type — "Steps to follow", never ACTION_STEPS. */
  blockName: string;
  /** A `lucide-react` export name from the registry. */
  icon: string;
  purpose: string;
}

/**
 * A template's blocks as the preview renders them.
 *
 * The palette name and the icon come from `lib/sections/registry.ts` rather than being restated here: an
 * administrator choosing a template must see the same words they will see in the builder afterwards, and
 * two lists of block names would eventually disagree about one.
 */
export function templateBlockPreviews(template: PageTemplate): TemplateBlockPreview[] {
  return template.blocks.map((block, index) => {
    const meta = sectionMeta(block.type);
    return {
      key: `${block.type}-${index}`,
      label: block.label,
      blockName: meta.label,
      icon: meta.icon,
      purpose: block.purpose
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Consistency, checked once — and checked again on every save
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every way ONE arrangement can be wrong.
 *
 * Split out from `pageTemplateProblems()` below because it is asked three times about the same
 * arrangement, in three places that must all agree: at module load about the built-ins, in the editor
 * screen while somebody is still building the list, and in the route handler that refuses the save. One
 * function means the sentence an administrator reads on screen is the sentence the server refuses with —
 * a screen that explains one rule while the endpoint enforces another is worse than no explanation.
 *
 * Two blocks of a type the builder only allows once makes an arrangement the builder itself would refuse
 * to rebuild, which is exactly the sort of thing an administrator would report as a bug in the palette
 * rather than in the template.
 */
export function templateProblems(template: {
  name: string;
  blocks: readonly TemplateBlockSpec[];
}): string[] {
  const problems: string[] = [];
  const name = template.name.trim().length > 0 ? template.name.trim() : "This template";

  if (template.blocks.length === 0) {
    problems.push(`“${name}” has no blocks, so it would create an empty page.`);
  }

  const counts = new Map<SectionType, number>();
  for (const block of template.blocks) {
    counts.set(block.type, (counts.get(block.type) ?? 0) + 1);
  }

  for (const [type, used] of counts) {
    const meta = sectionMeta(type);
    if (used > 1 && !meta.allowMultiple) {
      problems.push(
        `“${name}” uses ${used} ${meta.label} blocks, and a page may hold only one. Remove ${used - 1} of them.`
      );
    }
  }

  return problems;
}

/**
 * Every way a LIST of templates can be wrong.
 *
 * Defaults to the built-ins so the load-time check below reads as it always did, and takes a list so the
 * merged set can be checked the same way. Two ids the same makes one template unreachable — which is why
 * `mergePageTemplates()` treats a matching key as a replacement rather than as a second entry.
 */
export function pageTemplateProblems(
  templates: readonly PageTemplate[] = PAGE_TEMPLATES
): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();

  for (const template of templates) {
    if (seenIds.has(template.id)) {
      problems.push(`Two templates share the id "${template.id}", so only the first can ever be chosen.`);
    }
    seenIds.add(template.id);
    problems.push(...templateProblems(template));
  }

  return problems;
}

/**
 * Checked when this module is first loaded, and REPORTED rather than thrown.
 *
 * A throw here would take the templates screen — and any page that imports this module — down over a
 * mistake in one arrangement, losing every working template to protect nobody from the broken one. The
 * log line names the template, which is the whole of what a developer needs.
 */
const TEMPLATE_PROBLEMS = pageTemplateProblems();
if (TEMPLATE_PROBLEMS.length > 0) {
  console.error(`[page-templates] ${TEMPLATE_PROBLEMS.join(" ")}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The built-ins and the database table, merged
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The caps on every field an administrator can type into a template.
 *
 * ONE DECLARATION, read by the editor screen's character counters and by the route handler's Zod schema.
 * A counter that says "38 of 240" while the save refuses at 200 is the bug this constant exists to make
 * impossible, and it is the bug the announcements screen carries a warning about because those two
 * numbers genuinely could not be shared.
 *
 * `suggestedTitle` matches `TITLE_MAX` on the templates screen, which in turn matches the pages route
 * handlers: the suggested title is typed straight into the field that limit governs, so a longer one
 * would arrive pre-filled with something the form refuses.
 */
export const TEMPLATE_LIMITS = {
  key: 64,
  name: 80,
  description: 400,
  suggestedTitle: 160,
  icon: 60,
  blockLabel: 80,
  blockPurpose: 240,
  /** A page of more than two dozen blocks is a page nobody scrolls to the foot of. */
  blocks: 24
} as const;

/**
 * A `PageTemplate` row, as either a Server Component or a route handler hands it over.
 *
 * `blocks` is `unknown` ON PURPOSE — it is a `Json` column, so what comes out is whatever went in, and
 * `readStoredBlocks()` is the one place that decides what is usable. Typing it as the parsed shape here
 * would be a promise this module cannot keep.
 *
 * `updatedAt` is an ISO STRING rather than a `Date`, because the same value travels over HTTP to the
 * manager screen and JSON has no date type. A server render calls `.toISOString()` on the way in.
 */
export interface StoredPageTemplate {
  /** The row's own id — what a PATCH or a DELETE addresses. Not the same thing as `key`. */
  id: string;
  key: string;
  name: string;
  description: string;
  suggestedTitle: string;
  icon: string;
  blocks: unknown;
  isHidden: boolean;
  sortOrder: number;
  updatedAt: string | null;
}

/** Where a template in the merged list came from. Shown on screen, because the three behave differently. */
export type TemplateOrigin =
  /** One of the built-ins in this file, with nothing shadowing it. Editable only by changing this file. */
  | "built-in"
  /** A row whose key equals a built-in's id. It stands in that built-in's place; deleting it brings the original back. */
  | "replacement"
  /** A row with a key of its own. */
  | "custom";

export interface ResolvedPageTemplate extends PageTemplate {
  origin: TemplateOrigin;
  /** Retired: it is not offered when creating a page, but it is still listed in the manager. */
  isHidden: boolean;
  sortOrder: number;
  /** The `PageTemplate` row behind this entry, or null for an unshadowed built-in. */
  rowId: string | null;
  updatedAt: string | null;
  /** What could not be read out of the stored row, in plain words. Empty for a built-in. */
  problems: readonly string[];
}

/** A soft-deleted row. Listed by the manager screen — see `mergePageTemplates` for why it has to be. */
export interface RemovedPageTemplate {
  id: string;
  key: string;
  name: string;
  blockCount: number;
  /** ISO 8601. */
  deletedAt: string;
}

/** What `GET /api/studio/templates` answers, and what the list screen seeds its manager with. */
export interface PageTemplateListResponse {
  items: ResolvedPageTemplate[];
  /** How many `PageTemplate` rows this answer took account of. */
  rowCount: number;
  /** True when there are more rows than `limit` and this answer does not carry them all (contract §1.6). */
  truncated: boolean;
  limit: number;
  removed: RemovedPageTemplate[];
  removedTotal: number;
  removedTruncated: boolean;
}

/**
 * A `PageTemplate` row from Prisma, in the shape the merge wants.
 *
 * ⚠ IT LIVES HERE RATHER THAN IN THE ROUTE HANDLER BECAUSE A `route.ts` MAY EXPORT NOTHING BUT ITS
 * HANDLERS — Next type-checks that, so a shared helper exported from one would fail the build. Four call
 * sites need this conversion (the list screen, the editor screen and the two route files), and four
 * copies of "remember to call `.toISOString()`" is three chances to send a `Date` down a JSON wire and
 * have it arrive as something the screen renders as "[object Object]".
 *
 * The parameter is STRUCTURAL rather than `Prisma.PageTemplateGetPayload<…>`, which keeps this module
 * free of any dependency on the generated client beyond the `SectionType` enum it already imports.
 */
export function storedTemplateFromRow(row: {
  id: string;
  key: string;
  name: string;
  description: string;
  suggestedTitle: string;
  icon: string;
  blocks: unknown;
  isHidden: boolean;
  sortOrder: number;
  updatedAt: Date;
}): StoredPageTemplate {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    suggestedTitle: row.suggestedTitle,
    icon: row.icon,
    blocks: row.blocks,
    isHidden: row.isHidden,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt.toISOString()
  };
}

function trimTo(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `blocks` column, read into the same shape the built-ins declare.
 *
 * NOTHING HERE THROWS, AND NOTHING IS SILENTLY DROPPED. Every entry that cannot be used produces a
 * sentence in `problems`, which the manager and the editor both print: a template that quietly lost a
 * block is indistinguishable from one that never had it (contract §1.6), and the likeliest cause is a
 * block type withdrawn by a newer version of this software — a fact the administrator needs, not a
 * silence.
 *
 * ⚠ ONLY FOUR KEYS SURVIVE. A row that somehow carried a `data` payload loses it here, which is the
 * whole rule of this file enforced at the point where untrusted JSON comes in.
 */
export function readStoredBlocks(
  value: unknown,
  templateName: string
): { blocks: TemplateBlockSpec[]; problems: string[] } {
  const problems: string[] = [];

  if (!Array.isArray(value)) {
    return {
      blocks: [],
      problems: [
        `The blocks stored for “${templateName}” could not be read, so it is being shown with none. Open it and build the list again.`
      ]
    };
  }

  const blocks: TemplateBlockSpec[] = [];

  for (const [index, entry] of value.entries()) {
    if (!isPlainObject(entry)) {
      problems.push(`Block ${index + 1} of “${templateName}” could not be read and has been left out.`);
      continue;
    }

    const rawType = typeof entry.type === "string" ? entry.type : "";
    // Indexed through a widened view of the registry: the column holds whatever an older or a newer
    // version of this application wrote, and `SectionType` is a promise about the enum, not about JSON.
    //
    // ⚠ ASKED WITH `hasOwnProperty`, NOT WITH A BARE INDEX. `SECTION_REGISTRY` is a plain object
    // literal, so it answers `"toString"`, `"constructor"` and `"valueOf"` out of `Object.prototype` —
    // truthy values carrying neither `type` nor `label`. A bare index therefore waved those through as
    // recognised block types and pushed a block whose `type` was `undefined`, which is worse than every
    // failure this function exists to report: the block was neither used nor mentioned in `problems`,
    // and two of them made `templateProblems()` read `allowMultiple` off `undefined` and throw — a 500
    // out of a PATCH whose body had already satisfied Zod.
    const meta = Object.prototype.hasOwnProperty.call(SECTION_REGISTRY, rawType)
      ? (SECTION_REGISTRY as Record<string, SectionMeta | undefined>)[rawType]
      : undefined;
    if (!meta) {
      problems.push(
        `Block ${index + 1} of “${templateName}” is a “${rawType || "(none)"}”, which this version of the site does not recognise, so it has been left out.`
      );
      continue;
    }

    if (blocks.length >= TEMPLATE_LIMITS.blocks) {
      problems.push(
        `“${templateName}” holds more than ${TEMPLATE_LIMITS.blocks} blocks. Only the first ${TEMPLATE_LIMITS.blocks} are used.`
      );
      break;
    }

    const label = trimTo(entry.label, TEMPLATE_LIMITS.blockLabel);
    blocks.push({
      type: meta.type,
      // Falls back to the palette's own name rather than to an empty string: a builder row reading
      // "HERO" with no name at all looks like a block that failed to load.
      label: label.length > 0 ? label : meta.label,
      purpose: trimTo(entry.purpose, TEMPLATE_LIMITS.blockPurpose),
      ...(isPlainObject(entry.overrides) ? { overrides: entry.overrides } : {})
    });
  }

  return { blocks, problems };
}

function resolveFromRow(row: StoredPageTemplate, origin: TemplateOrigin): ResolvedPageTemplate {
  const name = trimTo(row.name, TEMPLATE_LIMITS.name) || row.key;
  const read = readStoredBlocks(row.blocks, name);

  return {
    id: row.key,
    name,
    description: trimTo(row.description, TEMPLATE_LIMITS.description),
    suggestedTitle: trimTo(row.suggestedTitle, TEMPLATE_LIMITS.suggestedTitle),
    icon: trimTo(row.icon, TEMPLATE_LIMITS.icon),
    blocks: read.blocks,
    origin,
    isHidden: row.isHidden,
    sortOrder: row.sortOrder,
    rowId: row.id,
    updatedAt: row.updatedAt,
    problems: read.problems
  };
}

function resolveBuiltIn(template: PageTemplate, index: number): ResolvedPageTemplate {
  return {
    ...template,
    origin: "built-in",
    isHidden: false,
    sortOrder: index,
    rowId: null,
    updatedAt: null,
    problems: []
  };
}

/**
 * The built-ins and the `PageTemplate` table, as one list.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE THREE RULES, AND WHY EACH IS THAT WAY.
 *
 *   • **A row whose `key` equals a built-in's `id` replaces it, IN THE BUILT-IN'S PLACE.** Not appended
 *     at the end — an administrator who edits "Exhibition" has edited the template they already know,
 *     and moving it to the foot of the screen would read as a deletion plus a creation.
 *   • **A row with any other key is an additional template**, after the built-ins, ordered by
 *     `sortOrder` and then by name. `sortOrder` therefore only ever moves the custom ones about; the
 *     built-ins keep the editorial order this file declares, which is a claim about what an institution
 *     needs first and not a preference anybody should be able to overwrite by accident.
 *   • **`isHidden` is carried, not filtered.** The manager screen has to list a retired template in
 *     order to bring it back — `visiblePageTemplates()` is what the chooser uses.
 *
 * ⚠ PASS ONLY ROWS THAT ARE NOT SOFT-DELETED. A deleted row must not shadow its built-in, or deleting a
 * customisation would leave the original withdrawn rather than restored. The `key` column stays unique
 * across deleted rows, though, which is why creating a template can collide with one that is in the
 * removed list and why the manager screen lists those separately: `BIN_TYPES` in the recycle-bin route
 * has no entry for a template, so this screen is the only place a removed one can be reached from.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function mergePageTemplates(rows: readonly StoredPageTemplate[]): ResolvedPageTemplate[] {
  const byKey = new Map<string, StoredPageTemplate>();
  for (const row of rows) {
    // First wins. `PageTemplate.key` is unique in the database, so a second row with the same key means
    // the caller passed one twice — which must not silently change which arrangement is offered.
    if (!byKey.has(row.key)) byKey.set(row.key, row);
  }

  const merged: ResolvedPageTemplate[] = [];
  const builtInIds = new Set<string>();

  for (const [index, template] of PAGE_TEMPLATES.entries()) {
    builtInIds.add(template.id);
    const row = byKey.get(template.id);
    merged.push(row ? resolveFromRow(row, "replacement") : resolveBuiltIn(template, index));
  }

  const custom = rows
    .filter((row) => !builtInIds.has(row.key) && byKey.get(row.key) === row)
    .map((row) => resolveFromRow(row, "custom"))
    // A TOTAL order, so the list never reshuffles between two renders of the same data: `sortOrder`
    // is the editorial choice, the name breaks its ties, and the key breaks the name's.
    .sort(
      (a, b) =>
        a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    );

  return [...merged, ...custom];
}

/** The templates a page may actually be created from. A retired one is absent, not disabled. */
export function visiblePageTemplates(
  templates: readonly ResolvedPageTemplate[]
): ResolvedPageTemplate[] {
  return templates.filter((template) => !template.isHidden);
}

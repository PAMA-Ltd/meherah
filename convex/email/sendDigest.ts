"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { siteUrl } from "../lib/siteUrl";
import { renderDigestHtml } from "./template";

type MailjetResponse = {
  Messages?: Array<{
    Status?: string;
    Errors?: Array<{ ErrorMessage?: string }>;
    To?: Array<{ MessageID?: number; MessageUUID?: string }>;
  }>;
};

function isEmailConfigured(): boolean {
  return Boolean(
    process.env.MAILJET_API_KEY &&
      process.env.MAILJET_SECRET_KEY &&
      process.env.MAILJET_FROM_EMAIL
  );
}

async function sendMailjet(args: {
  to: string;
  subject: string;
  html: string;
}): Promise<string> {
  const apiKey = process.env.MAILJET_API_KEY;
  const secretKey = process.env.MAILJET_SECRET_KEY;
  const fromEmail = process.env.MAILJET_FROM_EMAIL;
  const fromName = process.env.MAILJET_FROM_NAME ?? "Meherah";
  if (!apiKey || !secretKey || !fromEmail) {
    throw new Error(
      "MAILJET_API_KEY, MAILJET_SECRET_KEY, and MAILJET_FROM_EMAIL are required"
    );
  }

  const response = await fetch("https://api.mailjet.com/v3.1/send", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + Buffer.from(apiKey + ":" + secretKey).toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      Messages: [
        {
          From: { Email: fromEmail, Name: fromName },
          To: [{ Email: args.to }],
          Subject: args.subject,
          HTMLPart: args.html,
        },
      ],
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as MailjetResponse;
  const message = payload.Messages?.[0];
  if (!response.ok || message?.Status === "error") {
    const detail =
      message?.Errors?.map((error) => error.ErrorMessage)
        .filter(Boolean)
        .join("; ") || response.statusText;
    throw new Error("Mailjet send failed: " + detail);
  }

  return (
    message?.To?.[0]?.MessageUUID ??
    message?.To?.[0]?.MessageID?.toString() ??
    "accepted"
  );
}

/** Hourly cron entry point: queue every digest whose local schedule is due. */
export const sweep = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    if (!isEmailConfigured()) return null;
    const due = await ctx.runQuery(internal.emailDigests.listDue, {
      now: Date.now(),
    });
    for (const digestId of due) {
      await ctx.scheduler.runAfter(0, internal.email.sendDigest.deliver, {
        digestId,
      });
    }
    return null;
  },
});

/** Mailjet plumbing check runnable from the Convex CLI. */
export const testTo = internalAction({
  args: { to: v.string() },
  returns: v.string(),
  handler: async (_ctx, args): Promise<string> => {
    if (!isEmailConfigured()) {
      return "MAILJET_API_KEY / MAILJET_SECRET_KEY / MAILJET_FROM_EMAIL are not set";
    }
    const id = await sendMailjet({
      to: args.to,
      subject: "Meherah test email - Mailjet is working",
      html:
        '<div style="font-family:sans-serif;padding:24px;">' +
        '<p style="font-size:16px;"><strong>&#10047; Meherah</strong></p>' +
        "<p>This is a test email from your Meherah deployment. If you are reading " +
        "this, the Mailjet configuration works end to end.</p></div>",
    });
    return "sent: " + id;
  },
});

/** Build, render, and send one digest. force skips the empty-digest guard. */
export const deliver = internalAction({
  args: { digestId: v.id("emailDigests"), force: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    if (!isEmailConfigured()) {
      console.warn(
        "Digest skipped: MAILJET_API_KEY/MAILJET_SECRET_KEY/MAILJET_FROM_EMAIL not set"
      );
      return null;
    }
    const data = await ctx.runQuery(internal.emailDigests.getDigestData, {
      digestId: args.digestId,
    });
    if (!data) return null;

    const empty = Object.values(data.sections).every(
      (rows) => rows === null || rows.length === 0
    );
    if (empty && !args.force) return null;

    const html = renderDigestHtml(data, siteUrl());
    const counts = [
      data.sections.focus?.length && data.sections.focus.length + " to focus",
      data.sections.assigned?.length &&
        data.sections.assigned.length + " assigned",
      data.sections.mentions?.length &&
        data.sections.mentions.length + " mentions",
    ].filter(Boolean);
    const subject =
      "Your " +
      data.orgName +
      " digest" +
      (counts.length ? " - " + counts.join(", ") : "");

    await sendMailjet({ to: data.email, subject, html });

    await ctx.runMutation(internal.emailDigests.markSent, {
      digestId: args.digestId,
    });
    return null;
  },
});

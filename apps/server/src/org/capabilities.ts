/**
 * What the company can and cannot do — told to every agent, and checked when a request is understood.
 *
 * 2026-11-07 (test 6, trc_1a51…): "Email our investors this month's update." The CEO made "the email
 * reaches the full investor list and the send is confirmed" a success criterion although no agent can
 * send email; every review then counted the work short, four rounds of legal review followed ($3.41,
 * 46 min), and the Board finally got a question opening "No email was sent".
 *
 * A step the company cannot do is a "Board step": it is said in the first reply, the success
 * criterion becomes "ready for the Board to …", reviews never count it as a shortfall, and the final
 * report lists it under "Left for you".
 *
 * What the company CAN do follows the tools that are switched on (the founder, 2026-11-07: "what if
 * in the future I want the company to be able to do all these"): a tool declares what it grants
 * (`grants` on ToolDefinition, or an MCP server's `grants`), and a capability is the company's when
 * an enabled tool grants it to at least one active agent. Switch the tool off and it is a Board step
 * again.
 */

export type Capability = "email" | "web" | "code" | "payments" | "accounts" | "git" | "data";

/** The outside steps, in the order agents are told them. */
const OUTSIDE_STEPS: readonly { capability: Capability; cannot: string; can: string }[] = [
  { capability: "email", cannot: "send email, or any message outside the company", can: "send email" },
  { capability: "web", cannot: "browse or fetch the web", can: "search and read the web" },
  { capability: "code", cannot: "run code", can: "run code" },
  { capability: "payments", cannot: "make payments or purchases", can: "make payments" },
  { capability: "accounts", cannot: "sign in to or use any outside account or service", can: "use connected outside services" },
];

const EXTRA_CAN: Partial<Record<Capability, string>> = { git: "read and change a code repository through pull requests", data: "look up market and financial data" };

export const CANNOT_DO = OUTSIDE_STEPS.map((s) => s.cannot);

const NONE: ReadonlySet<Capability> = new Set();

/**
 * What agents are told. `company`: what some colleague can do (an enabled tool grants it); `mine`:
 * what this agent's own tools can do. Without arguments: the company can do none of the outside steps.
 */
export function limitsLine(company: ReadonlySet<Capability> = NONE, mine: ReadonlySet<Capability> = NONE): string {
  const cannot = OUTSIDE_STEPS.filter((s) => !company.has(s.capability)).map((s) => s.cannot);
  const can = [...company].map((c) => ({ c, text: OUTSIDE_STEPS.find((s) => s.capability === c)?.can ?? EXTRA_CAN[c] })).filter((x): x is { c: Capability; text: string } => !!x.text);
  const yours = can.filter((x) => mine.has(x.c)).map((x) => x.text);
  const colleagues = can.filter((x) => !mine.has(x.c)).map((x) => x.text);
  const parts: string[] = [];
  if (yours.length) parts.push(`With your own tools you can: ${yours.join("; ")} (use them only for this work; anything that sends, publishes, spends or changes something outside waits for the Board's approval).`);
  if (colleagues.length) parts.push(`Colleagues with the right tools can: ${colleagues.join("; ")} — delegate or ask them.`);
  if (cannot.length) {
    parts.push(
      `What this company cannot do: ${cannot.join("; ")}. ` +
        "When a request needs one of these, do everything up to it (draft the email, prepare the file) and leave that step to the Board: say so plainly, and never claim it was done.",
    );
  }
  return parts.join(" ");
}

/** The line for a company with no outside tools (the default). */
export const LIMITS_LINE = limitsLine();

const PREPARED = /\b(draft(?:ed|s)?|ready|prepared?|for the board|board to|board's step|to send|for sending|to be sent)\b/i;
// Narrow on purpose (a backstop for the model's own boardSteps): verbs of doing it, not topics —
// "the marketing plan covers email and SEO" is a plan, "the email reaches the investor list" is a send.
const OUTSIDE: readonly { capability: Capability; re: RegExp }[] = [
  { capability: "email", re: /\be-?mail(?:ed)?\b[^.]*\b(?:is sent|was sent|sent to|reach(?:es|ed)?|deliver(?:ed|s)? to|recipients?|inbox(?:es)?)\b/i },
  { capability: "email", re: /\b(?:send|sent|mailed|distribut(?:e|ed|es) to)\b[^.]*\b(?:investors?|customers?|subscribers?|press|journalists?|mailing list|distribution list|investor list|recipients?)\b/i },
  { capability: "accounts", re: /\b(?:published|posted|tweeted|is live)\b[^.]*\b(?:website|blog|social media|linkedin|twitter|app store|online)\b/i },
  { capability: "code", re: /\b(?:deployed|goes live|went live)\b/i },
  {
    capability: "payments",
    re: /\b(?:pay|paid|settle[ds]?) (?:the |an? |our )?(?:[\w-]+ ){0,2}(?:bill|invoice|vendor|supplier|subscription)s?\b|\b(?:make|made|complete[sd]?) (?:a |the )?payment\b|\b(?:buy|bought|purchase[sd]?) (?:the |an? |our )?(?:[\w-]+ ){0,2}(?:tool|licen[cs]e|subscription|domain|ads?|software|service|seat)s?\b/i,
  },
  { capability: "code", re: /\b(?:backtest(?:ed)?|execute[ds]? (?:the )?(?:code|script|trades?)|ran (?:the )?(?:code|script))\b/i },
];

/**
 * Does this success criterion need a step the company cannot take (sending email, publishing,
 * deploying, paying, running code)? "Drafted and ready for the Board to send" does not, and neither
 * does a step the company has a tool for (`company`).
 */
export function needsBoardStep(criterion: string, company: ReadonlySet<Capability> = NONE): boolean {
  if (PREPARED.test(criterion)) return false;
  return OUTSIDE.some((o) => !company.has(o.capability) && o.re.test(criterion));
}

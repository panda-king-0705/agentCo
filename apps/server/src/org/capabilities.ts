/**
 * What the company cannot do — told to every agent, and checked when a request is understood.
 *
 * 2026-11-07 (test 6, trc_1a51…): "Email our investors this month's update." The CEO made "the email
 * reaches the full investor list and the send is confirmed" a success criterion although no agent can
 * send email; every review then counted the work short, four rounds of legal review followed ($3.41,
 * 46 min), and the Board finally got a question opening "No email was sent".
 *
 * Now a step the company cannot do is a "Board step": it is said in the first reply, the success
 * criterion becomes "ready for the Board to …", reviews never count it as a shortfall, and the final
 * report lists it under "Left for you".
 */

export const CANNOT_DO = [
  "send email, or any message outside the company",
  "browse or fetch the web",
  "run code",
  "make payments or purchases",
  "sign in to or use any outside account or service",
] as const;

export const LIMITS_LINE =
  `What this company cannot do: ${CANNOT_DO.join("; ")}. ` +
  "When a request needs one of these, do everything up to it (draft the email, prepare the file) and leave that step to the Board: say so plainly, and never claim it was done.";

const PREPARED = /\b(draft(?:ed|s)?|ready|prepared?|for the board|board to|board's step|to send|for sending|to be sent)\b/i;
// Narrow on purpose (a backstop for the model's own boardSteps): verbs of doing it, not topics —
// "the marketing plan covers email and SEO" is a plan, "the email reaches the investor list" is a send.
const OUTSIDE = [
  /\be-?mail(?:ed)?\b[^.]*\b(?:is sent|was sent|sent to|reach(?:es|ed)?|deliver(?:ed|s)? to|recipients?|inbox(?:es)?)\b/i,
  /\b(?:send|sent|mailed|distribut(?:e|ed|es) to)\b[^.]*\b(?:investors?|customers?|subscribers?|press|journalists?|mailing list|distribution list|investor list|recipients?)\b/i,
  /\b(?:published|posted|tweeted|is live)\b[^.]*\b(?:website|blog|social media|linkedin|twitter|app store|online)\b/i,
  /\b(?:deployed|goes live|went live)\b/i,
  /\b(?:pay|paid|settle[ds]?) (?:the |an? |our )?(?:[\w-]+ ){0,2}(?:bill|invoice|vendor|supplier|subscription)s?\b|\b(?:make|made|complete[sd]?) (?:a |the )?payment\b|\b(?:buy|bought|purchase[sd]?) (?:the |an? |our )?(?:[\w-]+ ){0,2}(?:tool|licen[cs]e|subscription|domain|ads?|software|service|seat)s?\b/i,
  /\b(?:backtest(?:ed)?|execute[ds]? (?:the )?(?:code|script|trades?)|ran (?:the )?(?:code|script))\b/i,
];

/**
 * Does this success criterion need a step the company cannot take (sending email, publishing,
 * deploying, paying, running code)? "Drafted and ready for the Board to send" does not.
 */
export function needsBoardStep(criterion: string): boolean {
  if (PREPARED.test(criterion)) return false;
  return OUTSIDE.some((re) => re.test(criterion));
}

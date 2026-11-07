// 2026-11-07 (test 6): the backstop that keeps a step the company cannot take (sending email,
// publishing, deploying, paying, running code) out of the success criteria — narrow on purpose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS_LINE, needsBoardStep } from "../../src/org/capabilities.ts";

test("needsBoardStep: doing it outside the company, not talking about it", () => {
  for (const c of [
    "The email reaches the full investor list and the send is confirmed.",
    "The update is sent to all investors.",
    "The post is published on the company blog.",
    "The website is deployed.",
    "Pay the AWS invoice.",
    "Buy the keyword tool within budget.",
    "The strategy was backtested on 2 years of data.",
  ]) assert.equal(needsBoardStep(c), true, c);
  for (const c of [
    "The draft reflects current company results and quarterly goal progress.",
    "Marketing approach covers channels such as email and SEO.",
    "The update is drafted, checked and ready for the Board to send.",
    "Jasmine Lee has sent Ava a written confirmation of both the hire and the brief.",
    "The plan states what users pay per tier.",
    "Engineering scope names how we deploy and monitor.",
    "The channel plan reaches our target customers.",
    "The post covers social media timing.",
  ]) assert.equal(needsBoardStep(c), false, c);
  assert.match(LIMITS_LINE, /^What this company cannot do: send email, or any message outside the company; browse or fetch the web; run code; make payments or purchases; sign in to or use any outside account or service\./);
});

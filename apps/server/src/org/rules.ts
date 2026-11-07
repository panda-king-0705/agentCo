/**
 * House rules said the same way in the handbook, the worker prompt and the leaders' prompts.
 *
 * 2026-11-08 (trc_4469…): asked to "add a section recording each condition and how it was met", Legal
 * appended its condition table and a 10,000-character version note to the investor update itself —
 * the file meant for investors grew from 9,563 to 19,845 characters of internal review.
 */
export const OUTSIDE_DOC_RULE =
  "A document for people outside the company (investors, customers, the public) holds only what they should read: review notes, condition lists, change logs, version notes and task numbers go in the review file or your result — never in that document, and never ask anyone to add them to it.";

/** Editing part of a document: in place, not by rewriting it. */
export const EDIT_IN_PLACE_RULE = "To change part of an existing document, edit it in place with workspace_edit_file (a passage or a whole section); rewrite a whole file only when you mean to replace all of it.";

/** Repository files are saved work (2026-11-08, trc_8e3b…: reviews asked for drive copies of committed code). */
export const REPO_SAVED = "Files named owner/repo@branch:path are committed to a repository: that is saved work, exactly as a file on the drive is — never ask for a copy on the drive. ";

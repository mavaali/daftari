---
name: daftari-memory
description: Use the user's Daftari vault as long-term memory. Use when the user refers to earlier decisions, preferences, or project context; asks you to remember, forget, or correct something; or when a conversation reaches a conclusion worth keeping for future chats.
---

The Daftari tools read and write the user's memory: markdown files in a Git
repo on their own machine. Treat it as the record of what the user knows and
has decided, and keep it honest.

## Before answering

If the question could depend on something decided or learned earlier, call
`vault_search` first, then `vault_read` the documents you rely on. Name the
document you used. Say so when it is a `draft`, has low confidence, or is
stale. If the vault has nothing, say that instead of guessing.

## Writing

Write when the user asks you to remember something, or offer to when a
conversation settles a decision, preference, or fact they will want later. Do
not save small talk or one-off answers.

1. Search first. If a document already covers the topic, update it with
   `vault_append` instead of creating a duplicate.
2. Create new documents with `vault_write`, `agent: "agent:chatgpt"`, and
   `status: draft`. Put them in a plain collection such as `decisions`,
   `preferences`, `people`, or `projects`.
3. Set `provenance` truthfully: `direct` when the user stated it,
   `synthesized` when you combined sources, `inferred` when you concluded it.
   Set `confidence` to what the evidence supports, and list sources.
4. Tell the user what you saved and where.

## When facts change

- When something new **replaces** an old document, use `vault_supersede`. Do
  not overwrite the old text; its history is the point.
- When two documents **disagree** and neither replaces the other, tell the
  user and keep both. Do not merge them into a compromise.
- Only use `vault_promote` to mark a document `canonical` after the user
  explicitly confirms it.

## Never store

Passwords, API keys, account or policy numbers, or other secrets. Private
details about other people unless the user explicitly asks you to.

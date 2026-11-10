# Ujwalam privacy policy

Last updated: 2026-11-10

Ujwalam is a personal, local-first streaming and clipping app that runs on the owner's own Windows computer. It has no
server, no account system and no analytics.

## What Ujwalam accesses on YouTube

When the owner signs in with Google, Ujwalam asks for:

- `youtube.upload`: to upload the owner's own clips to the owner's own channel, as private videos (optionally with a
  scheduled publish time).
- `youtube.readonly`: to read the publish times of videos already scheduled on the owner's channel, so a new clip gets
  a free time slot.

Ujwalam does not read comments, subscribers, analytics, messages or any other channel's data, and does not change or
delete existing videos.

## Where data is kept

- The Google sign-in token is stored only in Windows Credential Manager on the owner's computer.
- Channel schedule times and upload status are kept in local files on the same computer.
- Nothing is sent to the app's developer or to any third party. The only network requests for this feature go
  directly from the owner's computer to Google's YouTube Data API.

## Removing access

Sign out in Ujwalam (`node services/posting/cli.mjs youtube signout`), or remove the app's access at
https://myaccount.google.com/permissions. Deleting the Ujwalam data folder removes all local data.

## Contact

Open an issue on this project's GitHub repository.

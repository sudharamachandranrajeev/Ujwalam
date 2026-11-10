# Ujwalam privacy policy

Last updated: 2026-11-10

Ujwalam is a personal, local-first streaming and clipping app for Windows. It runs only on the computer of the
person who installs it (the "user"). It has no server, no user accounts, no advertising and no analytics. The
developer receives no data from it.

## Google and YouTube data Ujwalam uses

Ujwalam uses YouTube API Services. When the user signs in with their Google account, Ujwalam asks for two permissions
(OAuth scopes):

| Scope | What Ujwalam does with it |
|---|---|
| `https://www.googleapis.com/auth/youtube.upload` | Uploads video clips the user made with Ujwalam to the user's own YouTube channel, as private videos, with the title, description, tags and cover image the user approved, and optionally a scheduled publish time. |
| `https://www.googleapis.com/auth/youtube.readonly` | Reads the list of the user's own uploaded videos and their scheduled publish times, so a new clip gets a free time slot (for example 6 hours after the last scheduled video). Ujwalam also reads the status of videos it uploaded (processing state, privacy status). |

Data read from Google: the channel's upload list, each video's id, privacy status and scheduled publish time, and the
upload and processing status of videos Ujwalam uploaded.

Ujwalam does not read comments, messages, subscribers, analytics, payment data, contacts or other channels' data. It
does not edit or delete existing videos.

## How the data is stored

- The Google sign-in tokens (access and refresh token) are stored only in Windows Credential Manager on the user's
  computer.
- Video ids, scheduled times and upload status are stored in local files in the Ujwalam data folder on the same
  computer, to plan and track uploads.
- The clips themselves are files the user made; they stay on the user's computer until uploaded by the user's choice.

## Sharing

Ujwalam does not sell, share, transfer or disclose Google user data to anyone. Nothing is sent to the developer or to
any third party. The only network requests for this feature go directly from the user's computer to Google's YouTube
Data API. Google user data is not used for advertising or to train AI models.

Ujwalam's use and transfer of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including
the Limited Use requirements.

## YouTube and Google terms

By signing in to YouTube through Ujwalam, the user agrees to the
[YouTube Terms of Service](https://www.youtube.com/t/terms). Google's handling of data is described in the
[Google Privacy Policy](https://policies.google.com/privacy).

## Removing access and deleting data

- Sign out in Ujwalam (`node services/posting/cli.mjs youtube signout`); this deletes the stored tokens.
- Or revoke Ujwalam's access at any time at https://myaccount.google.com/permissions or through the
  [Google security settings page](https://security.google.com/settings/security/permissions).
- Deleting the Ujwalam data folder (`%LOCALAPPDATA%\Ujwalam\data`) deletes all locally stored data. Upload
  records stay in that folder until the user deletes them.

## Changes

Changes to this policy are published in this file with a new date.

## Contact

Open an issue on this project's GitHub repository.

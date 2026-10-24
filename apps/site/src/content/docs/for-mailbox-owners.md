---
title: Connected your Gmail through InboxLink?
description: For people who connected a mailbox to an app through InboxLink. What the app can see, what InboxLink keeps, and how to disconnect.
sidebar:
  label: For mailbox owners
---

An app you use asked you to connect your Gmail account, and sent you through a
page titled **InboxLink** before Google's sign-in. This page explains what that
means for your mail, in plain words.

## What InboxLink is

InboxLink is the connection between your Gmail account and the app. The app
asked InboxLink to connect your mailbox so that the app itself never holds
your Google password or the key that lets it read your mail. InboxLink keeps
that key locked away and reads mail **for that app only**.

## Why Google's screen shows a different name

Google's permission screen shows the name registered for InboxLink's Google
sign-in. Today that name is **Askel**, an app made by
[CIELTD](https://cieltd.org), the company that runs InboxLink. Whatever name
Google shows, the permission goes to InboxLink: it keeps the key and reads mail
only for the app that sent you, which never holds the key itself.

## What the app can see

- **Read-only access.** InboxLink asks Google for permission to read your
  mail. It cannot send, delete or change messages.
- The exact permissions asked from Google are: *View your email messages and
  settings* (`gmail.readonly`), plus your email address and a sign-in
  identifier (`openid`, `email`).
- The app can read message details such as sender, recipients, subject, date,
  labels and a short preview, and can open a full message, including its
  text and the names of attachments.
- Attachment files are not downloaded.
- Each app you connect gets its own connection. One app cannot see another
  app's connection.

## What InboxLink keeps

| What | Why | Until |
|---|---|---|
| Your email address | To know which mailbox the connection is for | You disconnect |
| The access key Google issued, encrypted | To keep reading mail for the app without asking you to sign in every time | You disconnect, or Google stops it |
| A copy of recent messages (details and, for some messages, the full text) | So the app can list your mail quickly | You disconnect |

Your Google password never reaches InboxLink or the app: you type it on
Google's own page.

InboxLink does not sell your data, show you ads, or use your mail to train AI
models. InboxLink's use and transfer of information received from Google APIs
adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements. See the full
[privacy policy](https://inboxlink-two.vercel.app/privacy).

## How to disconnect

Any of these stops access:

1. **In the app**: use its "disconnect" or "remove mailbox" option. This
   deletes the stored key and the copied messages for that connection.
2. **In your Google account**: open
   [Google Account → Third-party connections](https://myaccount.google.com/connections),
   find **Askel** (the name InboxLink's Google sign-in uses today) and remove
   its access. Access stops at once; the app will
   ask you to connect again if you keep using it.
3. **Ask for deletion**: email
   [efokou@cieltd.org](mailto:efokou@cieltd.org) with the app you used and
   the address you connected. Do not post personal details in a public
   GitHub issue.

## Is it safe?

- The key Google issued is encrypted (AES-256-GCM) and is never shown to the
  app or returned by any API.
- If Google stops the access, for example because you changed your password
  or removed InboxLink, the connection stops working instead of retrying.
- InboxLink's code is [open source](https://github.com/EtienneFokou-E18560/inboxlink):
  anyone can read how it handles mail.

Questions about what **the app** does with your mail belong to that app: check
its own privacy policy.

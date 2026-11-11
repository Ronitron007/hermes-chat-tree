# Side Chat

Side Chat is a Hermes Desktop plugin. It asks a side question in a fork of the open chat. The main chat gets no new message.

## What it does

- The pane forks the open chat and sends your question to the fork.

- You can give the fork a cheaper model and a provider.

- The answer shows in the pane. To read the whole side chat, click **Open**.

- A merge brings the side chat back into the main chat. You choose the merge mode:

  - **Full text** (the default) copies each question and answer of the side chat.

  - **Merge record** writes the header line and the side chat id only.

  - **Digest** writes the side question and the final answer.

- Each merge text starts with the header line `From side chat: <side question>`. The Chat Tree plugin uses this line to draw the merge.

- Before a merge, the pane checks that the text fits in the context window of the main chat.

## Install

You need Hermes 0.23 or later and Hermes Desktop.

This plugin is one of three plugins in this repository. To install all three, run the install script from the root of the repository:

```bash
bash scripts/install.sh
```

The script is [`scripts/install.sh`](../scripts/install.sh). The root [README](../README.md) gives all the steps.

## Limits

- The pane puts a merge in the main chat composer. It never sends it. Edit the text, then send it.

- Digest is the side question and its final answer. No model writes a summary.

- The main chat must be idle when you ask. Hermes refuses to fork a busy chat.

- The fork copies the whole chat. A fork from an earlier message is not available yet.

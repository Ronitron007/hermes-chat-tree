# Chat Tree

Chat Tree is a Hermes Desktop plugin. It draws the open chat, its forks, and its side chats as a git graph in a side pane.

## What it does

- Each node is one exchange: one user message and its replies.

- Each chat has its own lane. A fork leaves its parent lane at the exact exchange where the child chat starts.

- A merge from a side chat curves back into a `Merged: …` node on the parent lane. The tree finds a merge from the header line `From side chat: <side question>` at the start of a parent message.

- Blue marks the path from the first exchange to the open node. Grey marks all other nodes.

- A long run of exchanges folds into one `+N` row. Click the row to show the exchanges in it.

- Point to a node to see the chat title and its model. Click a node to open its chat.

## Install

You need Hermes 0.23 or later and Hermes Desktop.

This plugin is one of three plugins in this repository. To install all three, run the install script from the root of the repository:

```bash
bash scripts/install.sh
```

The script is [`scripts/install.sh`](../scripts/install.sh). The root [README](../README.md) gives all the steps.

## Limits

- Hermes has no API to scroll a chat to one message. A click on a node opens the chat of that node, at its usual scroll position.

- The tree reads the newest 500 chats and at most 30 chats of one lineage.

- The tree links a merge only to a side chat whose side question matches the header line. If no side chat matches, the merged node has no curve. The tree never guesses a link.

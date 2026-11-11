# How the tree shows branch names: options

Date: 2026-11-12, 02:40 IST. Status: Rohan chose option 2 now and option 3 as a mode (02:41).

Source: Instinct's Brief D (commit-graph UIs, 2026-11-11, email "Research brief D: FINAL consolidated report"). Each branch name is the Hermes title of the chat. The plugin never names a chat.

## What other tools do `names.prior_art`

| Tool | How it names a branch |
|---|---|
| VS Code graph, Git Graph, Tower, Zed | A ref pill on the tip row of the branch. HEAD has its own marker. |
| GitLens | Pills before the message, a compact mode, and "/" to find a branch. |
| Fork | A finished branch folds into one row. Left and Right arrows fold and open it. |
| Git Graph | A dropdown filters the branches that show. |
| JetBrains | A Branches pane beside the log. |

## Options for the tree `names.options`

| Option | Where the name shows | Narrow pane | Result |
|---|---|---|---|
| Ref pill at the tip | The last row of the lane | The pill takes label width | Dropped |
| Name row at the fork | One row where the lane starts | The name gets the full width | Chosen (Rohan, 02:41) |
| Branches mode | One row for each chat, as Fork folds a branch | Good | Chosen as a mode (Rohan, 02:41) |
| Prefix on the first row | The first exchange of the lane | Crowded | Dropped |
| Tooltip only | Hover only | No change | Dropped: the user cannot see names at a glance |

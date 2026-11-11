# Decision tree: the competition build

Updated: 2026-11-12 02:42 IST. Green is chosen. Grey is dropped. Yellow is open.

```mermaid
flowchart TD
  G[Ship the chat-branching entry by 03:30 IST]

  G --> B{Where to build}
  B -->|chosen, Rohan 23:55| B1[On outbox/competition-entry 46a3bef]
  B -->|dropped| B2[Fresh branch from main]

  G --> H{Hermes changes}
  H -->|chosen, Rohan 11-11| H1[Plugin framework only]
  H -->|dropped| H2[Upstream Hermes PRs]

  G --> T{Tree node}
  T -->|chosen, Rohan 22:31| T1[One exchange]
  T -->|dropped| T2[One chat]
  T -->|dropped| T3[Fork points only]

  T1 --> V{Pane views}
  V -->|chosen| V1[One git-graph view, two colours]
  V -->|dropped| V2[Outline, gutter, strip modes from PR 20]
  V1 --> O[Oldest exchange at the top]
  V1 --> C[Collapse runs of 3 or more to +N]

  G --> M{Merge}
  M -->|chosen, Rohan 22:35| M1[User picks the mode]
  M1 --> M2[Full text, default]
  M1 --> M3[Merge record]
  M1 --> M4{Digest source}
  M4 -->|dropped 00:58| M5[Question plus final answer, no model call]
  M4 -->|chosen, Rohan 00:58| M6[Model-written, ctx.llm.complete_structured]
  M1 --> MS[One merge section for the open chat: Merge as-is, Digest]
  MS --> MT{Merge target}
  MT -->|chosen, Rohan| MT1[Any ancestor, chips, target lane lights up]
  MT -->|dropped| MT2[Direct parent only]
  M1 --> M7{Merge header}
  M7 -->|chosen 00:13| M9[From side chat: side question]
  M7 -->|dropped 00:13| M10[From side chat: title, cut to 50 chars and renamed by Hermes]
  M9 --> M8[Tree links the Merged node to the side chat whose first message equals the question]

  G --> W{Windows}
  W -->|chosen, Rohan 00:24| W1[One window: the tree pane holds branch, ask, open, merge]
  W -->|dropped| W2[Separate side-chat pane]
  G --> P{Packaging}
  P -->|chosen| P1[chat-tree plus concept-links, one install script]
  P -->|dropped| P2[One combined plugin]
  G --> RV{Reviews}
  RV -->|chosen, Rohan 00:22| RV1[One review of the whole build at the end]
  RV -->|dropped| RV2[A review for each unit]
  G --> TC[Queued: tree colours from the Hermes theme]
  P1 --> R{Repo is private}
  R -->|deferred, Rohan 00:10| R1[Make this repo public, later]
  R -->|dropped| R2[New public repo for the entry]

  G --> Q{Verification}
  Q -->|chosen| Q1[Static render harness plus screenshots]
  Q -->|open, Rohan| Q2[Live Desktop click-through]

  W1 --> F{Branch point}
  F -->|chosen| F2[Any exchange of the open chat: session.branch with count]
  F2 --> NM{Branch names}
  NM -->|chosen, Rohan 00:58| NM1[Hermes names chats, the plugin never passes name]
  NM -->|dropped| NM2[Plugin names branches]
  F2 --> FD[Fork digest: the part above the fork, via ctx.llm]
  M6 --> DR{How the pane reaches ctx.llm}
  DR -->|chosen 01:15| DR1[Plugin RPC digest.write plus a session event, as Hermes documents]
  DR -->|dropped 01:15| DR2[Dashboard route with a shared module, not documented]
  W1 --> HR{How the tree reads other chats}
  HR -->|dropped 01:22| HR1[session.history: answers only for chats in memory]
  HR -->|chosen 01:22| HR2[Plugin RPC history.read on hermes_state SessionDB]
  W1 --> PL[Model pill only on the open node, Rohan 01:10]
  F2 --> BM{Branch model}
  BM -->|chosen, Rohan 01:05| BM1[User picks in ModelCatalogMenu: model, provider, reasoning]
  BM -->|dropped| BM2[Assume a cheap model]
  G --> CS{Plugin styling}
  CS -->|chosen| CS1[Inline styles for exact sizes and colours; Tailwind only for classes in the shipped CSS]
  G --> LN{Lane columns}
  LN -->|chosen| LN1[Lanes stay put, from PR 27]
  LN -->|deferred| LN2[Port VS Code lane code]

  W1 --> SC{Node click}
  SC -->|chosen, Rohan 01:38| SC1[Open the chat, then reveal the exchange: hermes:timeline-reveal with rowId on the workspace viewport]
  SC -->|dropped| SC2[Open the chat only]
  SC1 --> SC3[Fallback: chat opened, no error, when the viewport or row is not found]

  G --> UI{Merge and branch UI}
  UI -->|open, Rohan| UI1[Icon actions on the row plus a popover pick, VS Code style]
  UI -->|open, Rohan| UI2[Split button on the lane head]
  UI -->|today| UI3[Section below the graph]
  SC1 --> IS[Asked Hermes for host.revealMessage: hermes-agent issue 153905]

  W1 --> LF[A fork shows at once: stub node, reload on Hermes events, Rohan 01:52]
  W1 --> AC{Active colour}
  AC -->|dropped 02:00| AC1[--ui-accent: a neutral midground]
  AC -->|chosen 02:00| AC2[--dt-primary: the theme primary and the user's accent]
  W1 --> BA{Where Branch shows}
  BA -->|dropped 02:05| BA1[Only exchanges of the open chat]
  BA -->|chosen, Rohan 02:05| BA2[Every answered node; another chat opens first]
  BA2 --> BQ[Question optional: no question just forks and opens, Rohan 02:08]
  BA2 --> BI[GitForkIcon, the icon of Hermes's own branch action, Rohan 02:08]
  MT1 --> TD{Target picker}
  TD -->|dropped 02:06| TD1[Chips, a standing dashed lane]
  TD -->|chosen, Rohan 02:06| TD2[Dropdown; its path lights in the hover colour only while in use]
  HR2 --> HL[history.read: one lineage, no hidden or archived chats, a size cap]
  HR2 --> BX[Exact cut: branch_index from the rows Hermes branches from]

  W1 --> BN{Branch names}
  BN -->|chosen, Rohan 02:41| BN1[Name row at the fork: the Hermes title]
  BN -->|chosen, Rohan 02:41| BN2[Branches mode: one row for each chat]
  BN -->|dropped| BN3[Ref pill at the tip]
  W1 --> RA[Row icon actions and a two-step merge pick, Rohan 02:16]

  classDef chosen fill:#d1fae5,stroke:#059669,color:#064e3b
  classDef dropped fill:#f3f4f6,stroke:#9ca3af,color:#6b7280
  classDef open fill:#fef3c7,stroke:#d97706,color:#78350f
  class B1,H1,T1,V1,O,C,M1,M2,M6,M9,M8,P1,Q1,W1,RV1,F2,MS,MT1,NM1,FD,LN1,BM1,CS1,SC1,SC3,LF,AC2,BA2,BQ,BI,TD2,HL,BX,BN1,BN2,RA chosen
  class B2,H2,T2,T3,V2,M3,M5,M10,P2,R2,W2,RV2,MT2,NM2,BM2,SC2,AC1,BA1,TD1,BN3 dropped
  class Q2,UI1,UI2 open
  classDef deferred fill:#e0e7ff,stroke:#6366f1,color:#312e81
  class R1,TC,LN2 deferred
```

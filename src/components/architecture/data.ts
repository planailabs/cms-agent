/**
 * Architecture page — chapter 4: what is stored, and where the system is meant
 * to be extended.
 */
import type { ArchSection } from './types';

export const dataSections: ArchSection[] = [
  {
    id: 'data-model',
    title: 'Data model',
    intro: `A branch has many chats; a chat owns its transcript, its task list,
      its executions and its approvals. The state-carrying columns are plain
      strings rather than database enums — the schema has to stay
      provider-portable because the test suite runs the same migrations on
      SQLite.`,
    diagrams: [
      {
        caption: 'A chat and everything it owns',
        code: `
erDiagram
  direction TB
  CHAT ||--o{ MESSAGE : transcript
  CHAT ||--o{ CHAT_TASK : checklist
  CHAT ||--o{ CHAT_TABS : "per user"
  CHAT ||--o{ EXECUTION : commits
  CHAT ||--o{ APPROVAL : audited
  CHAT ||--o{ AUTOMATISM : runs
  CHAT ||--o{ PUBLICATION : produces
  CHAT ||--o{ UPLOAD : attachments
  MESSAGE ||--o{ UPLOAD : carries
  PUBLICATION ||--o{ ARTIFACT : seals

  CHAT {
    string workBranch "unique"
    string kind
    string workflowPhase "the phase machine"
    string turnPhase "the turn machine"
    json pendingQuestion "paused client tool"
    json planJson "approved plan"
    int entityVersion "concurrency"
    datetime archivedAt
  }
  EXECUTION {
    string sha "one per execution"
    string revertedBySha "undo"
  }
  APPROVAL {
    string action "plan or publish"
    string planHash "binds the plan"
    string baseSha "binds content"
    string idempotencyKey "unique"
  }
  AUTOMATISM {
    string type
    string status "the engine"
    int step "resume point"
    json data "carried across steps"
    string agentChatId "failure handler"
  }
  PUBLICATION {
    string sha "merge commit"
    string flow
    string status
    string log "deploy output"
  }
  ARTIFACT {
    string tarballPath "sealed build"
    json manifest "checksums"
  }
`,
      },
      {
        caption: 'People, branches, and governance',
        code: `
erDiagram
  direction TB
  USER ||--o{ SESSION : "signs in"
  USER ||--o{ ACCOUNT : links
  USER ||--o{ BRANCH : creates
  USER ||--o{ CHAT : creates
  USER ||--o{ APPROVAL : decides
  USER ||--o{ TOKEN_USAGE : spends
  USER ||--o{ WINDOW_SESSION : restores
  USER ||--o{ UPLOAD : uploads
  USER ||--o{ SYSTEM_PROMPT_EXTENSION : "personal instructions"
  USER ||--o{ APPROVED_MEMORY : approves
  BRANCH ||--o{ CHAT : hosts
  BRANCH ||--o{ PUBLICATION : receives
  CHAT ||--o{ MEMORY_CANDIDATE : proposes
  MEMORY_CANDIDATE ||--o| APPROVED_MEMORY : "approved as"
`,
      },
    ],
    notes: `<ul>
      <li><strong>The strings are the state machines.</strong>
        <code>workflowPhase</code>, <code>turnPhase</code>, the automatism
        status and the publication status are the persisted forms of the
        diagrams above. Migrations change them; nothing else may.</li>
      <li><strong>A chat carries its own mode.</strong> <code>planMode</code>
        is set by the <code>/plan</code> command and decides whether the agent
        proposes a plan for approval or records one and implements it; the
        message that switched it on keeps the command, so the transcript
        explains the change of behaviour that follows it.</li>
      <li><strong>Uploads are quarantined.</strong> Files are magic-byte checked
        and stored outside any web root. The import tool is the only path from
        there into a worktree, and it demands alt text for images.</li>
      <li><strong>Task notes never leave the server.</strong> A task carries
        display text plus an optional note that only the agent reads; the state
        snapshot ships the text and the status, and drops the note.</li>
      <li><strong>Approved memories are versioned with the content.</strong>
        Finalizing an execution syncs them into the worktree, so the conventions
        that governed a change are committed alongside it.</li>
      <li><strong>Window sessions are restore state, not layers.</strong> Each
        browser window persists which stage window is open and what it captured;
        transient layers — menus, dialogs, popovers — are deliberately not
        persisted.</li>
      <li><strong>One table has no relations at all.</strong> App settings are a
        global key to JSON map for admin toggles, so they belong to nobody and
        are left out of the diagrams above.</li>
    </ul>`,
    source: ['prisma/schema.prisma', 'src/lib/uploads.ts', 'src/lib/memory.ts'],
  },

  {
    id: 'registries',
    title: 'Extension points',
    intro: `Every place the system is meant to grow is a registry with one
      registration call. Adding a deploy target, a site type, a stage window or
      a tool is a single call plus the implementation — never a new branch in an
      existing switch.`,
    diagrams: [
      {
        code: `
flowchart LR
  subgraph server["Server"]
    tools["Tool registry<br/>registerTool"]
    flows["Deploy flows<br/>registerDeployFlow"]
    backends["Site backends<br/>registerSiteBackend"]
    adapters["Content adapters<br/>registerContentAdapter"]
    autos["Automatism types<br/>registerAutomatism"]
    mcp["MCP servers<br/>admin-global and repo-local config"]
    cmds["Chat commands<br/>COMMANDS"]
  end

  subgraph client["Browser"]
    windows["Stage windows<br/>registerWindow"]
    layers["UI layers<br/>registerLayer"]
  end

  flows -->|"a flow that declares phases gets its own<br/>automatism type, one step per phase"| autos
  flows -->|"flow-scoped tools"| tools
  backends -->|"builds the dev-server command"| preview["Preview manager"]
  adapters -->|"inventory, validation, prompt context"| tools
  windows -->|"icon, tooltip, order, optional flyout"| rail["Icon rail and stage renderer"]
  layers -->|"priority and outside-click root"| esc["One Escape and one outside-click listener"]
  mcp --> tools
  cmds -->|"parser, autocomplete, server-side validation"| composer["Composer and message endpoint"]
  cmds -->|"chat columns the effect sets"| tools
`,
      },
    ],
    notes: `<ul>
      <li><strong>Deploy flows.</strong> A flow either implements a single
        publish step or declares named phases. Declaring phases derives a
        dedicated automatism type, so each phase appears in the step bar and can
        pause and resume by itself. Flow-scoped tools are only offered in chats
        running that flow.</li>
      <li><strong>Site backends.</strong> The active one is an explicit override
        if set, otherwise the first whose detection matches the repository — the
        static backend is the catch-all and is registered last. Detection runs
        against the main repository, not per worktree, so a branch adding or
        removing a framework config cannot flip the backend mid-flight.</li>
      <li><strong>Content adapters.</strong> They teach the agent what content
        a repository holds, validate proposed files against the site's own
        rules, and contribute conventions to the system prompt.</li>
      <li><strong>Stage windows.</strong> One registration carries the rail icon,
        tooltip, order, renderer, open and close hooks, and what survives a
        reload. The rail and the main area both derive from the registry, so
        adding a window touches exactly one file.</li>
      <li><strong>Chat commands.</strong> A <code>/name</code> prefix on a sent
        message that switches something on for the chat — parameterless, because
        a command is a mode switch the user can type, not an argument syntax.
        One entry carries the name, the one-line description the composer's
        autocomplete shows, and the chat columns its effect sets, so a new
        command needs no other wiring. The parser is deliberately strict: only
        an exact known command at the very start counts, and it runs on the
        server against whatever text arrives — the chip in the composer is a
        preview of that decision, never the decision itself. The message keeps
        the command it was sent with, so the transcript still explains later why
        the chat behaved differently from that point on.</li>
      <li><strong>UI layers.</strong> Dialogs, menus and popovers register a
        priority and an outside-click root; one Escape listener closes the
        topmost open layer and one document listener closes outside-clicked
        popovers.</li>
    </ul>`,
    source: [
      'src/lib/publish/types.ts',
      'src/lib/commands/index.ts',
      'src/components/chat/ui/chat/commands.ts',
      'src/lib/site/backend.ts',
      'src/lib/content/adapter.ts',
      'src/components/workspace/window.ts',
      'src/components/chat/app/layers.ts',
    ],
  },
];
